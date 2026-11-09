"""Corrida completa: calibracion Huff -> demanda -> red (grafo) -> economia -> categorias -> familias -> segmentacion."""
import numpy as np
import pandas as pd

from . import calibracion, censo, economia, familias, grafo, red, segmentacion, transporte
from . import demanda as dem_mod

# Todas las sedes fisicas cierran en el horizonte: la categoria define el orden, no si se cierra.
# Quedar sin alternativa no protege a una sede: solo pide plan de migracion digital antes del cierre.
CATEGORIAS = {
    "CERRAR PRIMERO": "Margen bajo el corte y la red retiene su demanda: cerrar en la proxima ventana de aviso",
    "CERRAR PRIMERO CON PLAN DIGITAL": "Margen bajo el corte y sin alternativa: cerrar en la proxima ventana, migrando antes a sus clientes al canal digital",
    "CERRAR DESPUES": "Margen sobre el corte y la red retiene buena parte de su demanda: siguiente etapa",
    "CERRAR AL FINAL": "Margen sobre el corte y sin alternativa: ultima etapa, con migracion digital previa",
    "CIERRE EN CURSO": "Cierre ya resuelto por la gerencia",
    "POR REVISAR": "Falta margen o ubicacion para asignar etapa",
}


def categorizar(ficha, cfg):
    """Etapa de cierre por cuadrante (margen x retencion en red). Los cierres decididos son un hecho."""
    m = ficha.get("margen_base")
    r = ficha.get("retencion_huff")
    cat = pd.Series("POR REVISAR", index=ficha.index, dtype=object)
    if cfg["umbral_margen_clp"] is not None:
        alto = m >= cfg["umbral_margen_clp"]
    else:   # todas cierran: el corte ordena, mitad antes y mitad despues dentro de cada zona
        zona = ficha["zona_red"] if "zona_red" in ficha else pd.Series("TODAS", index=ficha.index)
        alto = m >= m.groupby(zona).transform("median")
    u_r = cfg["umbral_retencion"] if cfg["umbral_retencion"] is not None else float(r.median())
    redund = r >= u_r
    ok = m.notna() & r.notna()
    cat[ok & ~alto & redund] = "CERRAR PRIMERO"
    cat[ok & ~alto & ~redund] = "CERRAR PRIMERO CON PLAN DIGITAL"
    cat[ok & alto & redund] = "CERRAR DESPUES"
    cat[ok & alto & ~redund] = "CERRAR AL FINAL"
    cat[ficha.get("cierre_decidido", pd.Series(False, index=ficha.index)).fillna(False).astype(bool)] = "CIERRE EN CURSO"
    return cat


def analizar(datos, progreso=None):
    """Devuelve dict nombre -> DataFrame (y 'extras' con calibracion y familias)."""
    cfg = datos.config
    hist, corte, _ = dem_mod.serie_historica(datos)
    cal = {"estado": "DESACTIVADA", "motivo": "calibrar_u0 = False", "u0": cfg["huff_u0"], "lambda": cfg["huff_lambda"], "eventos": pd.DataFrame()}
    if cfg["calibrar_u0"]:
        cal = calibracion.calibrar(datos, hist, corte)
        if cal["estado"] == "CALIBRADO":
            cfg["huff_u0"], cfg["huff_lambda"] = cal["u0"], cal["lambda"]

    d = dem_mod.proyectar(datos, progreso=progreso)
    fisicas = [s for s in datos.ids_vigentes if s in datos.distancias.index]
    venta = d.metricas["venta_12m_real"]
    mred = red.metricas_red(datos, venta, ids=fisicas)
    econ = economia.evaluar(datos, d, redund=mred)
    tabla, vars_ = segmentacion.tabla_variables(d.metricas, mred, econ)
    asign, perfiles, diag = segmentacion.segmentar(tabla, vars_, k=cfg["k_segmentos"], semilla=cfg["semilla"])

    s = datos.sedes
    extras = [c for c in ("asociacion", "zona_cliente", "gestion", "accion", "status", "fecha_limite_aviso", "cierre_decidido",
                          "fecha_cierre_decidida", "margen_hoja", "ingresos_hoja", "comision_hoja", "gastos_hoja", "ano_margen", "arriendo_mensual_clp",
                          "otros_fijos_anual_clp", "fuente_costos", "comision_fija_anual_clp", "calidad_ubicacion") if c in s.columns]
    ficha = (s[(s["estado"] == "VIGENTE") & (s["grupo"] != "DIGITAL")][["nombre", "grupo", "comuna", "lat", "lon", "vencimiento_contrato"] + extras]
             .join(d.metricas, how="left").join(mred, how="left").join(asign, how="left"))
    ficha.index.name = "sede_id"
    # Margen base: el real de la hoja anual; si no hay, el de contribucion proyectado (primer ano)
    m_proy = econ[econ["ano"] == econ["ano"].min()].set_index("sede_id")["margen_contribucion_p50"] if len(econ) else pd.Series(dtype=float)
    ficha["margen_base"] = ficha["margen_hoja"] if "margen_hoja" in ficha else np.nan
    ficha["fuente_margen"] = np.where(ficha["margen_base"].notna(), "hoja anual", None)
    falta = ficha["margen_base"].isna() & ficha.index.isin(m_proy.index)
    ficha.loc[falta, "margen_base"] = m_proy.reindex(ficha.index[falta]).values
    ficha.loc[falta, "fuente_margen"] = "proyectado"
    ficha["zona_red"] = [grafo.zona_de(g, z, la, lo) for g, z, la, lo in
                         zip(ficha["grupo"], ficha.get("zona_cliente", pd.Series(None, index=ficha.index)), ficha["lat"], ficha["lon"])]
    ficha["categoria"] = categorizar(ficha, cfg)
    # Entorno (Censo 2024, INE): comuna por coordenadas, hombres de 50+ e internet en el hogar
    ficha = ficha.join(censo.perfil(ficha["lat"], ficha["lon"], index=ficha.index))

    # Evaluacion estocastica de VAN por sede (Monte Carlo)
    sim_van = economia.evaluar_estocastico(datos, d, redund=mred, ficha_censo=ficha, horizonte=cfg["horizonte_anos"])

    fis_ub = [x for x in ficha.index if x in datos.distancias.index and ficha.at[x, "grupo"] != "DIGITAL"]
    tiempos = transporte.matrices(fis_ub, ficha.loc[fis_ub, "lat"], ficha.loc[fis_ub, "lon"],
                                  datos.distancias.loc[fis_ub, fis_ub].to_numpy(dtype=float), ficha.loc[fis_ub, "zona_red"].tolist(),
                                  cfg.get("factor_ruta", 1.3))
    red_grafo = grafo.desde_datos(datos, ficha, tiempos)

    # Sedes que ya cerraron (con ventas en el historico y ubicacion): para la linea de tiempo del mapa
    hist_ids = set(d.historico["sede_id"]) if len(d.historico) else set()
    cerr = s[(s["estado"] == "CERRADA") & (s["grupo"] != "DIGITAL") & s["lat"].notna() & s.index.isin(hist_ids)]
    sedes_cerradas = cerr[[c for c in ("nombre", "grupo", "lat", "lon", "zona_cliente") if c in cerr.columns]].copy()
    sedes_cerradas.index.name = "sede_id"

    X = familias.variables(ficha, d.historico)
    fams = familias.familias(X)

    eventos = cal.pop("eventos")
    return {
        "sedes": ficha,
        "demanda_anual": d.anual,
        "demanda_mensual": d.mensual,
        "historico": d.historico,
        "sedes_cerradas": sedes_cerradas,
        "economia": econ,
        "simulacion_van": sim_van,
        "segmentos": perfiles,
        "diagnostico_k": diag,
        "variables_segmentacion": pd.DataFrame({"variable": vars_}),
        "calibracion_eventos": eventos,
        "extras": {"calibracion": cal, "familias": fams, "categorias": CATEGORIAS, "grafo": red_grafo, "tiempos": tiempos},
    }


def exportar_excel(resultado, destino):
    with pd.ExcelWriter(destino, engine="openpyxl") as xw:
        for nombre, df in resultado.items():
            if isinstance(df, pd.DataFrame):
                df.to_excel(xw, sheet_name=nombre[:31], index=nombre == "sedes")
