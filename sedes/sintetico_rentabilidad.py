"""Excel sintetico con el formato del Excel de rentabilidad del cliente.

Imita sus 6 hojas y sus defectos conocidos: columnas de fecha desordenadas desde
jun-2025, fecha repetida (20251110), bloque 2025 repetido en la hoja anual,
nombres con tildes y prefijos distintos entre hojas y un nombre sin pareja.
No contiene informacion real.
"""
import io

import numpy as np
import pandas as pd

from .sintetico import CIUDADES, SANTIAGO

HIPO_NOMBRE = {"CHS": "CLUB HÍPICO", "HCH": "HIPÓDROMO CHILE", "VSC": "SPORTING", "CHC": "CONCEPCIÓN"}
ZONAS_RM = ["SANTIAGO CENTRO", "SANTIAGO NORTE", "SANTIAGO SUR", "SANTIAGO ORIENTE", "SANTIAGO PONIENTE", "SANTIAGO EXTERIOR"]
ACCIONES = ["RENEGOCIADO", "EXTERNALIZAR", "EVALUAR", "EVALUAR CIERRE", "CIERRE 2026", "CIERRE 2028", None, None, None, None]
NOTA = "DATOS SINTETICOS CON EL FORMATO DEL EXCEL DE RENTABILIDAD. NO SON DATOS REALES."


def generar(semilla=11, n_rm=45, n_reg=16, n_virtual=2, n_cerradas=3):
    rng = np.random.default_rng(semilla)
    sedes = []
    for i in range(n_rm + n_reg + n_virtual):
        virtual = i >= n_rm + n_reg
        reg = n_rm <= i < n_rm + n_reg
        sid = f"{rng.integers(1, 9):03d}.{rng.integers(1, 20):03d}.{i + 1:03d}"
        if virtual:
            zona, asoc, lat, lon, ciudad = "TELETRAK VIRTUAL", "VIRTUAL", np.nan, np.nan, ""
        elif reg:
            ciudad, (la, lo) = list(CIUDADES.items())[(i - n_rm) % len(CIUDADES)]
            zona, asoc = "ZONA SUR", rng.choice(["RED TELETRAK", "RED MINITRAK"], p=[.8, .2])
            lat, lon = la + rng.normal(0, .01), lo + rng.normal(0, .01)
        else:
            ciudad = "Santiago"
            zona = rng.choice(ZONAS_RM)
            asoc = rng.choice(["RED TELETRAK", "BAM", "RED MINITRAK"], p=[.75, .1, .15])
            lat, lon = SANTIAGO[0] + rng.normal(0, .06), SANTIAGO[1] + rng.normal(0, .07)
        nombre = f"TLK {'Peñalolén' if i == 3 else 'Sintética'} {i + 1:02d}" if not virtual else f"TELETRAK VIRTUAL {i + 1:02d}"
        sedes.append({"id": sid, "nombre": nombre, "zona": zona, "asoc": asoc, "lat": lat, "lon": lon,
                      "ciudad": ciudad, "gestion": rng.choice(["HCH", "CHS"]), "virtual": virtual,
                      "nivel": rng.lognormal(np.log(4e6 if not virtual else 4e7), .5),
                      "tend": rng.normal(-.04, .06) if not virtual else .1,
                      "mix": rng.dirichlet([3, 6, 1.5, 1]) if not reg else rng.dirichlet([2, 3, 2, 3]),
                      "accion": "VIRTUAL" if virtual else rng.choice(ACCIONES)})
    sd = pd.DataFrame(sedes)
    rm_idx = sd.index[(~sd["virtual"]) & (sd["zona"] != "ZONA SUR")]
    cerr = rm_idx[[3, 11, 19, 27, 35][:n_cerradas]] if n_cerradas else rm_idx[:0]
    fechas_cierre = [pd.Timestamp(f) for f in ("2023-03-31", "2023-09-30", "2024-06-30", "2024-11-30", "2025-04-30")]
    sd.loc[cerr, "gestion"] = "CERRADO"
    sd.loc[cerr, "accion"] = "CERRADO"
    sd.loc[sd.index[5], "accion"] = "VENDIDO"

    # ---- VTA HIST: dias habiles con defectos ----
    dias = pd.date_range("2019-01-02", "2026-10-20", freq="D")
    dias = dias[~((dias.year == 2019) & (dias.day_of_week == 6))]
    covid = (dias >= "2020-03-27") & (dias <= "2020-08-14")
    dias = dias[~covid | (dias.day_of_week == 5)]
    t = np.asarray((dias - dias[0]).days) / 365.25
    est = 0.10 * np.sin(2 * np.pi * (np.asarray(dias.month) - 3) / 12) + np.where(np.asarray(dias.day_of_week) >= 5, .35, 0)
    infl = np.cumprod(np.full(len(dias), 1 + 0.045 / 365))
    filas_h = []
    bases = {}
    for s in sd.itertuples():
        base = s.nivel * np.exp(s.tend * t + est + rng.normal(0, .12, len(dias))) * infl
        apagado = (dias >= "2020-03-27") & (dias <= "2021-05-31") & (not s.virtual)
        base[apagado] = 0
        bases[s.Index] = base
    # Cada cierre traspasa ~45% de su venta a sus 3 vecinas mas cercanas (lo que la calibracion debe recuperar)
    for k, i in enumerate(cerr):
        fc = fechas_cierre[k % len(fechas_cierre)]
        sd.loc[i, "fecha_cierre_sim"] = fc
        post = dias > fc
        d = np.hypot((sd["lat"] - sd.at[i, "lat"]) * 111, (sd["lon"] - sd.at[i, "lon"]) * 92)
        vecinas = d.drop(list(cerr)).dropna().nsmallest(3).index
        for j in vecinas:
            bases[j][post] += 0.15 * bases[i][post]
        bases[i][post] = 0
    for s in sd.itertuples():
        for (cod, w) in zip(["CHS", "HCH", "VSC", "CHC"], s.mix):
            filas_h.append([s.id, s.nombre, s.zona, HIPO_NOMBRE[cod]] + list(np.round(bases[s.Index] * w)))
    cols_d = [int(d.strftime("%Y%m%d")) for d in dias]
    hist = pd.DataFrame(filas_h, columns=["Id_Division", "Sucursal", "UBICACIÓN", "HIPÓDROMO"] + cols_d)
    vals = hist[cols_d].replace(0, np.nan)
    # desorden desde 2025-06-07 y 20251110 partido en dos columnas
    corte = cols_d.index(20250607)
    tramo = cols_d[corte:]
    perm = list(tramo)
    for k in range(0, len(perm) - 3, 4):
        perm[k], perm[k + 2] = perm[k + 2], perm[k]
    orden = cols_d[:corte] + perm
    vals = vals[orden]
    mitad = (vals[20251110] / 2).round()
    vals[20251110] = vals[20251110] - mitad
    pos = list(vals.columns).index(20251112)
    vals.insert(pos + 1, "20251110_dup", mitad)
    hist_out = pd.concat([hist[["Id_Division", "Sucursal", "UBICACIÓN", "HIPÓDROMO"]], vals], axis=1)
    hist_out = hist_out.rename(columns={"20251110_dup": 20251110})
    hist_out["Total general"] = vals.sum(axis=1)

    # agregados desde el historico
    largo = hist.melt(id_vars=["Id_Division", "Sucursal", "UBICACIÓN", "HIPÓDROMO"], var_name="d", value_name="v")
    largo["fecha"] = pd.to_datetime(largo["d"].astype(str))
    largo["cod"] = largo["HIPÓDROMO"].map({v: k for k, v in HIPO_NOMBRE.items()})
    anual = largo.groupby(["Id_Division", "cod", largo["fecha"].dt.year])["v"].sum().unstack([1, 2])
    mens26 = largo[(largo["fecha"].dt.year == 2026) & (largo["fecha"].dt.month <= 8)] \
        .groupby(["Id_Division", "cod", largo["fecha"].dt.month])["v"].sum().unstack([1, 2])
    jorn = largo[largo["v"] > 0].groupby(["Id_Division", largo["fecha"].dt.year])["fecha"].nunique().unstack()

    # ---- Y 2025 ----
    y25 = []
    for s in sd.itertuples():
        f = {"Id_Division": s.id, "ASOCIACIÓN": s.asoc, "COMUNIDAD": s.zona, "DIVISIÓN": s.nombre,
             "GESTIÓN": s.gestion, "OPERADOR": f"Operador {rng.integers(1, 30)}",
             "ARRENDADOR": rng.choice(["INMOBILIARIA HÍPICA", "Particular", "Empresa externa"])}
        for y in (2022, 2023, 2024, 2025):
            for cod in ("CHS", "HCH", "VSC", "CHC"):
                f[f"{cod}|{y}"] = anual.loc[s.id].get((cod, y), 0)
        for y in (2022, 2023, 2024, 2025):
            f[f"VTA|{y}"] = sum(f[f"{c}|{y}"] for c in ("CHS", "HCH", "VSC", "CHC"))
        y25.append(f)
    y25 = pd.DataFrame(y25)
    rep = y25[[f"{c}|2025" for c in ("CHS", "HCH", "VSC", "CHC")] + ["VTA|2025"]].copy()
    vta = y25["VTA|2025"]
    arr = np.where(sd["virtual"], 0, (vta * rng.uniform(.008, .02, len(sd))).round())
    otros = {"GTO COMUN": .002, "VOLANTES 100%": .003, "ROLLOS": .001, "MANTENCIÓN 100%": .004}
    econ = pd.DataFrame({"INGRESOS": (vta * .27).round(), "FONDO PREMIOS": (vta * .105).round()})
    econ["COMISIÓN"] = econ["INGRESOS"] - econ["FONDO PREMIOS"]
    econ["ARRIENDO 100%"] = arr
    for k, r in otros.items():
        econ[k] = np.where(sd["virtual"], 0, (vta * r * rng.uniform(.5, 1.5, len(sd))).round())
    econ["GASTOS"] = econ[["ARRIENDO 100%"] + list(otros)].sum(axis=1)
    econ["MARGEN"] = econ["COMISIÓN"] - econ["GASTOS"]
    econ["MG %"] = econ["MARGEN"] / econ["INGRESOS"].replace(0, np.nan)
    econ["SHARE"] = vta / vta.sum()
    econ["% ARRIENDO"] = econ["ARRIENDO 100%"] / econ["INGRESOS"].replace(0, np.nan)
    termino = [pd.Timestamp("2026-06-30") + pd.DateOffset(months=int(m)) for m in rng.integers(0, 36, len(sd))]
    cola = pd.DataFrame({
        "ACCIÓN": sd["accion"], "TÉRMINO": termino,
        "AVISO": [f"{d} días" for d in rng.choice([60, 90, 180], len(sd))],
        "VTA RECUP (PPR)": np.nan,
        **{f"PPR {y}": (y25[f"VTA|{y}"] / sd["id"].map(jorn[y]).replace(0, np.nan)).round() for y in (2023, 2024, 2025)},
        "PPR 2026": (sum(mens26.get((c, m), 0) for c in ("CHS", "HCH", "VSC", "CHC") for m in range(1, 9))
                     .reindex(sd["id"]).values / sd["id"].map(jorn[2026]).replace(0, np.nan).values).round(),
        "TEND": "", "OBS": ""})
    cola["VTA RECUP (PPR)"] = ((cola[["PPR 2023", "PPR 2024"]].max(axis=1) - cola["PPR 2025"]).clip(lower=0)
                               * sd["id"].map(jorn[2025]).values).round()
    cola["TEND"] = np.where(cola["PPR 2026"] > cola["PPR 2025"], "↑", "↓")
    y25_out = pd.concat([y25, rep, econ, cola], axis=1)

    # ---- Y 2026 ----
    y26 = pd.DataFrame({"DIVISIÓN": sd["id"], "DIRECCIÓN": [f"Calle Ficticia {rng.integers(100, 9999)}, {s.ciudad}" for s in sd.itertuples()],
                        "ZON": sd["zona"], "AGENCIA": sd["nombre"], "GESTIÓN": sd["gestion"], "ACCIÓN": sd["accion"]})
    for cod in ("HCH", "CHS", "VSC", "CHC"):
        for m in range(1, 9):
            y26[f"{cod}|{m:02d}"] = mens26.get((cod, m), pd.Series(0, index=mens26.index)).reindex(sd["id"]).fillna(0).values
        y26[f"{cod}|X"] = y26[[f"{cod}|{m:02d}" for m in range(1, 9)]].mean(axis=1)
    for m in range(1, 9):
        y26[f"VTA|{m:02d}"] = sum(y26[f"{c}|{m:02d}"] for c in ("HCH", "CHS", "VSC", "CHC"))
    for m in range(1, 9):
        y26[f"ING | {m:02d}"] = (y26[f"VTA|{m:02d}"] * .27).round()
    y26["VTA|X"] = y26[[f"VTA|{m:02d}" for m in range(1, 9)]].mean(axis=1)
    v8 = y26[[f"VTA|{m:02d}" for m in range(1, 9)]].sum(axis=1)
    y26["ING|Sin FP"] = (v8 * .165).round()
    y26["ING|Con FP"] = (v8 * .27).round()
    y26["COMISIÓN"] = y26["ING|Sin FP"]
    y26["ARRIENDO"] = (arr * 8 / 12).round()
    for k, r in {"GGCC": .002, "MANT": .003, "ASEO EXT": .001, "SEG EXT": .001, "ENLACE": .0005, "SEÑAL TV": .001, "OTROS": .001}.items():
        y26[k] = np.where(sd["virtual"], 0, (v8 * r).round())
    y26["GASTOS"] = y26[["ARRIENDO", "GGCC", "MANT", "ASEO EXT", "SEG EXT", "ENLACE", "SEÑAL TV", "OTROS"]].sum(axis=1)
    y26["MG sin FP"] = y26["ING|Sin FP"] - y26["GASTOS"]
    y26["MG %"] = y26["MG sin FP"] / y26["ING|Sin FP"].replace(0, np.nan)
    y26["COSTO VTA"] = y26["GASTOS"] / v8.replace(0, np.nan)
    y26["SHARE HCH"] = y26[[f"HCH|{m:02d}" for m in range(1, 9)]].sum(axis=1) / v8.replace(0, np.nan)
    y26["SHARE HCH+CHS"] = (y26[[f"HCH|{m:02d}" for m in range(1, 9)]].sum(axis=1)
                            + y26[[f"CHS|{m:02d}" for m in range(1, 9)]].sum(axis=1)) / v8.replace(0, np.nan)
    fechas26 = pd.Series(termino)
    fechas26[rng.random(len(sd)) < .1] += pd.DateOffset(months=6)          # discrepancias con Y 2025
    y26_out = y26.copy()
    y26_out.insert(len(y26_out.columns), "ARRIENDO_FECHA", fechas26.values)
    y26_out.columns = list(y26.columns) + ["ARRIENDO"]

    # ---- EN PROCESO (por nombre, con variaciones) ----
    fis = sd[~sd["virtual"]].sample(12, random_state=semilla)
    ep_nombres = []
    for k, n in enumerate(fis["nombre"]):
        if k % 3 == 0:
            n = n.replace("TLK ", "")
        elif k % 3 == 1:
            n = n.upper().replace("É", "E").replace("Ñ", "N")
        ep_nombres.append(n)
    ep_nombres[-1] = "Local Inexistente 99"
    status = rng.choice(["CARTA OK HCH", "CARTA OK CHS", "AVISAR", "CERRADO", "RENEGOCIAMOS RENTA", None], len(fis))
    status[0] = "AVISAR"
    vig = [pd.Timestamp("2026-11-30") if k == 0 else pd.Timestamp("2027-01-31") + pd.DateOffset(months=int(rng.integers(0, 12)))
           for k in range(len(fis))]
    en_proceso = pd.DataFrame({"COMUNIDAD": fis["zona"].values, "DIVISIÓN": ep_nombres, "GESTIÓN": fis["gestion"].values,
                               "OPERADOR": "", "ARRENDADOR": "",
                               "ACCIÓN": rng.choice(["EVALUAR CIERRE", "CIERRE 2026", "RENEGOCIADO", "VENDIDO"], len(fis)),
                               "VIGENCIA": [v.strftime("%d-%m-%Y") for v in vig],
                               "AVISO": ["180 días" if k == 0 else f"{rng.choice([60, 90])} días" for k in range(len(fis))],
                               "STATUS": status})

    # ---- CTA ARRIENDO ----
    meses = [(y, m) for y in (2025, 2026, 2027) for m in range(1, 13)]
    cta = []
    for s, a in zip(sd.itertuples(), arr):
        if s.virtual:
            continue
        fila = [s.nombre if rng.random() > .2 else s.nombre.replace("Sintética", "Sintetica")]
        reneg = rng.random() < .2
        fin = int(rng.integers(20, 36)) if rng.random() < .25 else 36
        for k in range(36):
            v = a / 12 * (1.03 ** (k // 12))
            if reneg and k >= 18:
                v *= .8
            fila.append(round(v) if k < fin and s.gestion != "CERRADO" else 0)
        cta.append(fila)
    cta = pd.DataFrame(cta, columns=["LOCAL"] + [f"{y}_{m}" for y, m in meses])

    coordenadas = sd[~sd["virtual"]][["id", "lat", "lon", "ciudad"]].rename(columns={"id": "sede_id", "ciudad": "comuna"})
    return {"Y 2025": y25_out, "Y 2026": y26_out, "VTA HIST": hist_out, "EN PROCESO": en_proceso, "CTA ARRIENDO": cta}, coordenadas


def escribir(destino=None, semilla=11):
    hojas, coord = generar(semilla)
    buf = destino or io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as xw:
        for nombre, df in hojas.items():
            df.to_excel(xw, sheet_name=nombre, index=False)
    return (None if destino else buf.getvalue()), coord
