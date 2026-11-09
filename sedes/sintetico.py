"""Datos sinteticos con el formato de la plantilla, para desarrollo y pruebas.

No contienen informacion real de Teletrak. Las coordenadas son ciudades de
Chile (dato publico) con desplazamiento aleatorio.
"""
import numpy as np
import pandas as pd

from .config import HIPODROMOS

# Centros publicos aproximados (lat, lon)
SANTIAGO_ORIENTE = (-33.425, -70.600)
SANTIAGO = (-33.460, -70.660)
CIUDADES = {
    "Valparaiso": (-33.047, -71.612), "Vina del Mar": (-33.024, -71.552), "Concepcion": (-36.827, -73.050),
    "La Serena": (-29.904, -71.249), "Antofagasta": (-23.650, -70.400), "Temuco": (-38.736, -72.590),
    "Rancagua": (-34.170, -70.744), "Talca": (-35.426, -71.655), "Puerto Montt": (-41.469, -72.942),
    "Iquique": (-20.214, -70.152), "Chillan": (-36.606, -72.103), "Los Angeles": (-37.469, -72.354),
    "Valdivia": (-39.814, -73.246), "Osorno": (-40.574, -73.133), "Calama": (-22.456, -68.924),
    "Copiapo": (-27.366, -70.332),
}
NOTA = "DATOS SINTETICOS GENERADOS PARA PRUEBAS. NO CORRESPONDEN A SEDES REALES."


def generar(semilla=7, n_g9=9, n_rm=37, n_reg=16, n_dig=3, n_cerradas=4,
            desde="2020-01-01", hasta="2026-09-01"):
    rng = np.random.default_rng(semilla)
    sedes = []

    def agregar(grupo, lat, lon, region, comuna, estado="VIGENTE"):
        i = len(sedes) + 1
        sedes.append({"sede_id": f"SYN-{i:02d}", "nombre": f"Sede sintetica {i:02d}", "grupo": grupo,
                      "region": region, "comuna": comuna, "lat": lat, "lon": lon, "estado": estado})

    for _ in range(n_g9):
        agregar("G9", SANTIAGO_ORIENTE[0] + rng.normal(0, 0.025), SANTIAGO_ORIENTE[1] + rng.normal(0, 0.03),
                "Metropolitana", "Santiago")
    for _ in range(n_rm + n_cerradas):
        agregar("RM", SANTIAGO[0] + rng.normal(0, 0.07), SANTIAGO[1] + rng.normal(0, 0.08),
                "Metropolitana", "Santiago")
    ciudades = list(CIUDADES.items())
    for k in range(n_reg):
        nombre, (la, lo) = ciudades[k % len(ciudades)]
        agregar("REGIONES", la + rng.normal(0, 0.01), lo + rng.normal(0, 0.01), "", nombre)
    for _ in range(n_dig):
        agregar("DIGITAL", np.nan, np.nan, "", "")
    sedes = pd.DataFrame(sedes)
    rm_idx = sedes.index[sedes["grupo"] == "RM"][-n_cerradas:] if n_cerradas else []
    sedes.loc[rm_idx, "estado"] = "CERRADA"
    sedes.loc[rm_idx, "fecha_cierre"] = pd.Timestamp("2024-06-30")

    meses = pd.date_range(desde, hasta, freq="MS")
    ipc = pd.DataFrame({"mes": meses, "var_mensual_pct": np.round(rng.normal(0.35, 0.25, len(meses)), 2)})

    escala = {"G9": 9.0, "RM": 4.0, "REGIONES": 5.0, "DIGITAL": 30.0}   # MM CLP por jornada aprox.
    mes_num = np.asarray(meses.month)
    estacional = 0.08 * np.sin(2 * np.pi * (mes_num - 3) / 12) + np.where(mes_num == 1, 0.10, 0.0)
    filas = []
    for s in sedes.itertuples():
        nivel = np.log(escala[s.grupo] * 1e6 * rng.lognormal(0, 0.45))
        tend = rng.normal(-0.03, 0.06) if s.grupo != "DIGITAL" else 0.12
        mix = rng.dirichlet([6, 3, 1.5, 1])
        t = np.asarray((meses - meses[0]).days) / 365.25
        z = nivel + tend * t + estacional + rng.normal(0, 0.07, len(meses))
        jorn = np.clip(rng.normal(26, 1.2, len(meses)).round(), 20, 30)
        covid = (meses >= "2020-03-01") & (meses <= "2021-05-01")
        jorn[covid] = rng.integers(0, 8, covid.sum())
        if s.estado == "CERRADA":
            jorn[meses > "2024-06-01"] = 0
        venta_real = np.exp(z) * jorn
        nominal = venta_real / np.cumprod(1 + ipc["var_mensual_pct"].to_numpy() / 100)[-1] \
            * np.cumprod(1 + ipc["var_mensual_pct"].to_numpy() / 100)
        for m, v, j in zip(meses, nominal, jorn):
            if j == 0:
                continue
            for h, w in zip(HIPODROMOS, mix):
                filas.append({"sede_id": s.sede_id, "mes": m, "hipodromo": h,
                              "venta_nominal_clp": round(v * w), "jornadas": j})
        if s.grupo != "DIGITAL":
            anual = float(venta_real[-12:].sum())
            sedes.loc[s.Index, "arriendo_mensual_clp"] = round(anual * rng.uniform(0.006, 0.014))
            sedes.loc[s.Index, "otros_fijos_anual_clp"] = round(anual * rng.uniform(0.04, 0.08))
            sedes.loc[s.Index, "vencimiento_contrato"] = pd.Timestamp("2027-01-01") + pd.DateOffset(months=int(rng.integers(0, 60)))
            sedes.loc[s.Index, "aviso_termino_meses"] = int(rng.choice([3, 6]))
            sedes.loc[s.Index, "costo_cierre_clp"] = round(anual * rng.uniform(0.01, 0.03))
            sedes.loc[s.Index, "m2"] = round(rng.uniform(40, 250))
    ventas = pd.DataFrame(filas)
    return {"SEDES": sedes, "VENTAS_MENSUALES": ventas, "IPC": ipc}
