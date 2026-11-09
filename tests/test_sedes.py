import io

import numpy as np
import pandas as pd
import pytest

from sedes import datos, demanda, estado, huff, pipeline, plantilla, sintetico


@pytest.fixture(scope="module")
def xlsx():
    return plantilla.escribir(hojas=sintetico.generar(semilla=3, n_rm=12, n_reg=5), nota=sintetico.NOTA)


@pytest.fixture(scope="module")
def d(xlsx):
    return datos.leer_plantilla(xlsx, sobrescrituras={"n_simulaciones": 200})


@pytest.fixture(scope="module")
def res(d):
    return pipeline.analizar(d)


# --- datos -----------------------------------------------------------------

def test_plantilla_en_blanco_tiene_todas_las_hojas():
    libro = pd.read_excel(io.BytesIO(plantilla.escribir()), sheet_name=None)
    assert {"LEEME", "SEDES", "VENTAS_MENSUALES", "IPC", "DISTANCIAS", "PARAMETROS"} <= set(libro)


def test_lee_sintetico_sin_errores(d):
    assert not [p for p in d.problemas if p.nivel == "ERROR"]
    assert d.distancias.shape[0] == d.distancias.shape[1]
    assert np.allclose(np.diag(d.distancias), 0)


def test_valida_errores(xlsx):
    hojas = sintetico.generar(semilla=3, n_rm=12, n_reg=5)
    hojas["SEDES"].loc[0, "grupo"] = "XX"
    hojas["VENTAS_MENSUALES"].loc[0, "sede_id"] = "NO-EXISTE"
    with pytest.raises(datos.PlantillaInvalida) as e:
        datos.leer_plantilla(plantilla.escribir(hojas=hojas))
    txt = str(e.value)
    assert "grupos no reconocidos" in txt and "NO-EXISTE" in txt


def test_parametros_desde_hoja():
    hojas = sintetico.generar(semilla=3, n_rm=12, n_reg=5)
    hojas["PARAMETROS"] = pd.DataFrame({"parametro": ["huff_lambda", "radio_cobertura_km"],
                                        "valor": ["2.5", '{"RM": 4.0}']})
    d = datos.leer_plantilla(plantilla.escribir(hojas=hojas))
    assert d.config["huff_lambda"] == 2.5
    assert d.config["radio_cobertura_km"] == {"RM": 4.0, "REGIONES": 15.0}


def test_distancias_de_la_hoja_sobrescriben():
    hojas = sintetico.generar(semilla=3, n_rm=12, n_reg=5)
    hojas["DISTANCIAS"] = pd.DataFrame({"origen": ["SYN-01"], "destino": ["SYN-02"], "km": [99.0]})
    d = datos.leer_plantilla(plantilla.escribir(hojas=hojas))
    assert d.distancias.loc["SYN-01", "SYN-02"] == 99.0 == d.distancias.loc["SYN-02", "SYN-01"]


# --- demanda ---------------------------------------------------------------

def test_demanda_modelo_simple_y_percentiles_ordenados(res):
    a = res["demanda_anual"]
    assert (a["metodo"] == "SIMPLE_RED").all()
    assert (a["p10_real"] <= a["p50_real"]).all() and (a["p50_real"] <= a["p90_real"]).all()
    assert (a["p50_nominal"] > a["p50_real"]).all()


def test_demanda_reproducible_y_sin_depender_del_orden(d):
    ids = d.ids_vigentes[:3]
    a = demanda.proyectar(d, sedes=ids).anual.set_index(["sede_id", "ano"])
    b = demanda.proyectar(d, sedes=ids[::-1]).anual.set_index(["sede_id", "ano"])
    pd.testing.assert_frame_equal(a.sort_index(), b.sort_index())


# --- huff ------------------------------------------------------------------

def _red(d):
    ids = [s for s in d.ids_vigentes if s in d.distancias.index]
    dem = pd.Series(np.linspace(1e9, 3e9, len(ids)), index=ids)
    return ids, dem, d.distancias.loc[ids, ids]


def test_huff_conserva_demanda(d):
    ids, dem, D = _red(d)
    r = huff.redistribuir(dem, ids[:3], D, d.config)
    assert np.isclose(r["nueva"].sum() + r["fuga"], dem.sum())
    assert (r["nueva"][ids[:3]] == 0).all()


def test_cascada_un_paso_igual_a_simultaneo(d):
    ids, dem, D = _red(d)
    sim = huff.redistribuir(dem, ids[:4], D, d.config)
    cas = huff.cascada(dem, [ids[:4]], D, d.config)
    assert np.allclose(sim["nueva"], cas["demanda_final"])


def test_cascada_reparte_lo_capturado(d):
    ids, dem, D = _red(d)
    cas = huff.cascada(dem, [[ids[0]], [ids[1]]], D, d.config)
    det = cas["detalle"].set_index("sede_id")
    assert det.at[ids[1], "demanda_al_cerrar"] > dem[ids[1]]   # recibio parte de ids[0]
    assert np.isclose(cas["demanda_final"].sum(), dem.sum() - det["fuga"].sum())


def test_modo_mm_clp_igual_al_dashboard(d):
    cfg = {**d.config, "huff_atractivo": "mm_clp"}
    ids, dem, D = _red(d)
    A = huff.atractivo_desde_demanda(dem, cfg)
    P, fuga = huff.probabilidades(D, A, [ids[0]], ids[1:], cfg)
    s = (dem[ids[1:]] / 1e6).clip(lower=1) * np.maximum(D.loc[ids[0], ids[1:]], 0.5) ** -cfg["huff_lambda"]
    assert np.allclose(P.iloc[0], s / (s.sum() + cfg["huff_u0"]))


def test_calibrar_u0(d):
    ids, dem, D = _red(d)
    u0 = huff.calibrar_u0(dem, D, d.config, retencion_objetivo=0.6)
    r = huff.redundancia(dem, D, d.config, u0=u0)["retencion_huff"]
    assert abs((r * dem / dem.sum()).sum() - 0.6) < 1e-3


# --- red, segmentacion, estado ---------------------------------------------

def test_pipeline_completo(res, d):
    s = res["sedes"]
    fisicas = [x for x in d.ids_vigentes if x in d.distancias.index]
    assert s.loc[fisicas, "cluster_espacial"].notna().all()
    assert s.loc[fisicas, "segmento"].notna().all()
    assert s.loc[fisicas, "retencion_huff"].between(0, 1).all()
    assert res["segmentos"]["n_sedes"].sum() == len(fisicas)


def test_estado_ida_y_vuelta(res, d, tmp_path):
    f = tmp_path / "x.sedes.json"
    estado.guardar(res, d, f, nombre="prueba")
    est, r2, aviso = estado.cargar(f, datos_actuales=d)
    assert aviso is None and est["nombre"] == "prueba"
    assert len(r2["demanda_anual"]) == len(res["demanda_anual"])
    assert set(est["red"]["ids"]) <= set(r2["sedes"]["sede_id"])
    d2 = datos.leer_plantilla(plantilla.escribir(hojas=sintetico.generar(semilla=4, n_rm=12, n_reg=5)))
    assert estado.cargar(f, datos_actuales=d2)[2] is not None


def test_sede_sin_meses_validos_no_rompe():
    """Sede vigente cuyos meses tienen todos menos de min_jornadas_mes: queda sin proyeccion, sin error."""
    hojas = sintetico.generar(semilla=3, n_rm=12, n_reg=5)
    v = hojas["VENTAS_MENSUALES"]
    sid = hojas["SEDES"].query("estado == 'VIGENTE' and grupo == 'RM'")["sede_id"].iloc[0]
    v.loc[v["sede_id"] == sid, "jornadas"] = 3
    d = datos.leer_plantilla(plantilla.escribir(hojas=hojas), sobrescrituras={"n_simulaciones": 50})
    res = pipeline.analizar(d)
    assert sid not in set(res["demanda_anual"]["sede_id"])
    assert sid in res["sedes"].index
