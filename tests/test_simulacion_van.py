import numpy as np
import pandas as pd
import pytest

from sedes import datos, demanda, economia, huff, pipeline, plantilla, sintetico, ui_api


@pytest.fixture(scope="module")
def d():
    hojas = sintetico.generar(semilla=7, n_rm=10, n_reg=4)
    xlsx = plantilla.escribir(hojas=hojas)
    return datos.leer_plantilla(xlsx, sobrescrituras={"n_simulaciones": 50})


def test_huff_top3_y_red_completa(d):
    ids = [s for s in d.ids_vigentes if s in d.distancias.index]
    dem = demanda.proyectar(d)
    vta = dem.metricas["venta_12m_real"].reindex(ids).fillna(100e6)
    D = d.distancias.loc[ids, ids]
    red = huff.redundancia(vta, D, d.config)
    assert "retencion_huff" in red.columns
    assert "retencion_huff_top3" in red.columns
    assert (red["retencion_huff_top3"] <= red["retencion_huff"] + 1e-6).all()
    assert (red["retencion_huff_top3"] >= 0).all()
    assert (red["retencion_huff"] <= 1.0).all()


def test_economia_evaluar_mantiene_compatibilidad(d):
    dem = demanda.proyectar(d)
    fisicas = [s for s in d.ids_vigentes if s in d.distancias.index]
    vta = dem.metricas["venta_12m_real"].reindex(fisicas).fillna(100e6)
    red = huff.redundancia(vta, d.distancias.loc[fisicas, fisicas], d.config)
    econ = economia.evaluar(d, dem, redund=red)
    cols_esperadas = {
        "sede_id", "ano", "venta_p50_real", "tasa_margen", "costos_fijos",
        "venta_equilibrio", "holgura_equilibrio", "margen_contribucion_p50",
        "prob_perdida", "retencion_total", "delta_ebitda_cierre", "costo_cierre"
    }
    assert cols_esperadas <= set(econ.columns)
    assert len(econ) > 0


def test_evaluar_estocastico_estructura_y_columnas(d):
    dem = demanda.proyectar(d)
    fisicas = [s for s in d.ids_vigentes if s in d.distancias.index]
    vta = dem.metricas["venta_12m_real"].reindex(fisicas).fillna(100e6)
    red = huff.redundancia(vta, d.distancias.loc[fisicas, fisicas], d.config)
    sim_df = economia.evaluar_estocastico(d, dem, redund=red, n_sim=500, horizonte=5)

    assert len(sim_df) == len([s for s in d.ids_vigentes if d.sedes.at[s, "grupo"] != "DIGITAL"])

    # Parametros estructurales
    param_cols = [
        "sede_id", "nombre", "grupo", "comuna", "venta_base_real", "tasa_margen",
        "arriendo_anual", "otros_fijos_anual", "costos_fijos_anual", "costo_cierre_clp",
        "mf_min", "mf_top3", "mf_full", "friccion_digital", "md_moda", "md_min", "md_max",
        "g_base", "vol_local", "meses_salida_min", "meses_salida_moda", "meses_salida_max"
    ]
    for c in param_cols:
        assert c in sim_df.columns, f"Falta columna {c}"

    # Salidas Monte Carlo
    mc_cols = [
        "van_mantener_p50", "delta_van_p10", "delta_van_p50", "delta_van_p90",
        "delta_van_media", "prob_exito_cierre", "cvar_5", "retencion_breakeven",
        "retencion_esperada", "clasificacion_sim"
    ]
    for c in mc_cols:
        assert c in sim_df.columns, f"Falta columna {c}"

    # Coherencia matematica
    assert (sim_df["delta_van_p10"] <= sim_df["delta_van_p50"] + 1e-4).all()
    assert (sim_df["delta_van_p50"] <= sim_df["delta_van_p90"] + 1e-4).all()
    assert (sim_df["prob_exito_cierre"].between(0.0, 1.0)).all()
    assert (sim_df["retencion_breakeven"].between(0.0, 1.0)).all()
    assert (sim_df["retencion_esperada"].between(0.0, 1.0)).all()
    assert set(sim_df["clasificacion_sim"]) <= {"FASE 1: CERRAR", "FASE 2: ZONA GRIS", "MANTENER / HUB"}


def test_pipeline_y_serializacion_simulacion_van(d):
    res = pipeline.analizar(d)
    assert "simulacion_van" in res
    assert isinstance(res["simulacion_van"], pd.DataFrame)
    assert len(res["simulacion_van"]) > 0

    s = ui_api.serializar(d, None, res)
    assert "simulacion_van" in s
    assert isinstance(s["simulacion_van"], list)
    assert len(s["simulacion_van"]) == len(res["simulacion_van"])
    assert "delta_van_p50" in s["simulacion_van"][0]
    assert "clasificacion_sim" in s["simulacion_van"][0]
