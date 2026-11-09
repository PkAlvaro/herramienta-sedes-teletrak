"""Puente entre la interfaz web (Pyodide) y el nucleo.

ejecutar() recibe el Excel ya leido por el navegador ({hoja: filas}) y
devuelve un JSON con todo lo que la interfaz necesita. Ese mismo JSON, con
metadatos, es el formato de estado .sedes.json (CLI e interfaz comparten
formato).
"""
import io
import json
from datetime import datetime

import numpy as np
import pandas as pd

from . import __version__, datos as D, estado, grafo, pipeline, rentabilidad

FORMATO = "sedes-estado/2"
_ULTIMO = {"clave": None, "libro": None}   # el navegador manda el mismo libro dos veces: se convierte una sola


def _libro(libro):
    if not isinstance(libro, str):
        return libro
    clave = (len(libro), hash(libro))
    if _ULTIMO["clave"] != clave:
        _ULTIMO.update(clave=clave, libro=json.loads(libro))
    return _ULTIMO["libro"]


def _registros(df, index=False):
    if df is None:
        return []
    if index:
        df = df.reset_index()
    return json.loads(df.to_json(orient="records", date_format="iso", double_precision=6))


def _limpio(o):
    """Tipos simples para JSON: NaN/inf -> None, numpy -> python, claves -> str."""
    if isinstance(o, dict):
        return {str(k): _limpio(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_limpio(v) for v in o]
    if isinstance(o, (np.floating, float)):
        return float(o) if np.isfinite(o) else None
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, (pd.Timestamp, np.datetime64)):
        return str(o)[:10]
    return o


def _ubicacion(datos):
    """Conteo de calidad de las coordenadas de sedes fisicas vigentes."""
    s = datos.sedes
    fis = s[(s["estado"] == "VIGENTE") & (s["grupo"] != "DIGITAL")]
    cal = fis["calidad_ubicacion"] if "calidad_ubicacion" in fis.columns else pd.Series("SIN DATO", index=fis.index)
    cal = cal.where(fis["lat"].notna(), "NO ENCONTRADA").fillna("SIN DATO")
    return [{"calidad": k, "sedes": int(v)} for k, v in cal.value_counts().items()]


def direcciones(libro):
    """Direcciones de las sedes (hoja mensual mas reciente) para geocodificar en el navegador."""
    return json.dumps(_registros(rentabilidad.direcciones(_libro(libro))), ensure_ascii=False)


def serializar(datos, informe, res):
    """Resultados + informe de carga + insumos del simulador Huff, todo en tipos JSON."""
    s = res["sedes"]
    fis = [x for x in s.index if x in datos.distancias.index and s.at[x, "grupo"] != "DIGITAL"]
    km = datos.distancias.loc[fis, fis].round(3)
    inf = {}
    if informe is not None:
        cuadre = informe.cuadre if informe.cuadre is not None else pd.DataFrame()
        inf = {
            "resumen": informe.resumen,
            "problemas": [{"nivel": p.nivel, "hoja": p.hoja, "mensaje": p.mensaje} for p in informe.problemas],
            "hojas": _registros(informe.hojas),
            "identidades": _registros(informe.identidades),
            "cuadre_resumen": _registros(cuadre.groupby("comparacion")["ok"].agg(n="size", cuadran="sum").reset_index()) if len(cuadre) else [],
            "cuadre_fallas": _registros(cuadre[~cuadre["ok"]]) if len(cuadre) else [],
            "pendientes": _registros(informe.pendientes),
            "columnas": _registros(informe.columnas),
            "automaticas": _registros(informe.automaticas),
            "ubicacion": _ubicacion(datos),
            "contratos": _registros(informe.contratos),
            "disponibles": _registros(informe.disponibles),
        }
    else:
        inf = {"resumen": {"sedes": len(datos.sedes)},
               "problemas": [{"nivel": p.nivel, "hoja": p.hoja, "mensaje": p.mensaje} for p in datos.problemas]}
    cfg = json.loads(json.dumps(datos.config, default=str))
    return {
        "config": cfg,
        "huella_datos": estado.huella_datos(datos),
        "informe": inf,
        "sedes": _registros(s, index=True),
        "demanda_anual": _registros(res["demanda_anual"]),
        "demanda_mensual": _registros(res["demanda_mensual"]),
        "historico": _registros(res["historico"]),
        "simulacion_van": _registros(res.get("simulacion_van")),
        "economia": _registros(res["economia"]),
        "segmentos": _registros(res["segmentos"]),
        "diagnostico_k": _registros(res["diagnostico_k"]),
        "variables_segmentacion": res["variables_segmentacion"]["variable"].tolist(),
        "sedes_cerradas": _registros(res["sedes_cerradas"], index=True) if "sedes_cerradas" in res else [],
        "red": {"ids": fis, "km": np.nan_to_num(km.to_numpy(), nan=9999.0).tolist()},
        "calibracion": _limpio({**res["extras"]["calibracion"], "eventos": _registros(res.get("calibracion_eventos"))}),
        "familias": _limpio(res["extras"]["familias"]),
        "categorias": res["extras"]["categorias"],
        "grafo": _limpio(res["extras"]["grafo"]),
        "tiempos": _limpio(res["extras"]["tiempos"]),
    }


def grafo_red(entrada):
    """Recalcula la red para otro escenario de cierres o umbrales (desde el mapa, sin repetir el analisis).

    entrada: JSON {ids, km, zonas, venta, cerradas, radios}; km es la matriz de costo ya armada por zona
    (minutos o km segun el modo de acceso de cada zona).
    """
    e = json.loads(entrada) if isinstance(entrada, str) else entrada
    return json.dumps(_limpio(grafo.analizar(e["ids"], e["km"], e["zonas"], e.get("venta"), e.get("cerradas"), e["radios"], e.get("fijos"))), ensure_ascii=False)


def linea_tiempo(entrada):
    """Red en cada fecha del calendario de cierres. entrada: lo mismo que grafo_red mas cortes [{fecha, cerradas}]."""
    e = json.loads(entrada) if isinstance(entrada, str) else entrada
    return json.dumps(_limpio(grafo.linea_tiempo(e["ids"], e["km"], e["zonas"], e.get("venta"), e["radios"], e["cortes"], e.get("fijos"))), ensure_ascii=False)


def rutas_metro(entrada):
    """Caminos en metro o tren y a pie para dibujar las conexiones. entrada: [{o, d, pie, acc_o, acc_d, fecha}]."""
    from . import transporte
    e = json.loads(entrada) if isinstance(entrada, str) else entrada
    return json.dumps(_limpio([transporte.ruta_metro(x["o"], x["d"], x["pie"], x.get("acc_o"), x.get("acc_d"), x.get("fecha")) for x in e]))


def tiempos_metro(entrada):
    """Tiempos por modo: estados antiguos o con la caminata real a estaciones. entrada: {ids, lat, lon, km, zonas, factor_ruta, acceso}."""
    from . import transporte
    e = json.loads(entrada) if isinstance(entrada, str) else entrada
    return json.dumps(_limpio(transporte.matrices(e["ids"], e["lat"], e["lon"], e["km"], e["zonas"], e.get("factor_ruta", 1.3), e.get("acceso"))))


def envolver(payload, nombre="", vista=None):
    return {"formato": FORMATO, "version_herramienta": __version__, "nombre": nombre,
            "creado": datetime.now().isoformat(timespec="seconds"), "vista": vista or {}, **payload}


def ejecutar(libro, coordenadas_csv=None, equivalencias_csv=None, params=None, progreso=None):
    """libro: dict {hoja: filas} o JSON de eso. Devuelve JSON (str) del estado completo."""
    libro = _libro(libro)
    params = json.loads(params) if isinstance(params, str) else (params or {})
    hojas, _ = rentabilidad.leer_libro(libro)
    if any(h.tipo == "HISTORICO" for h in hojas):
        coord = pd.read_csv(io.StringIO(coordenadas_csv), dtype={"sede_id": str}) if coordenadas_csv else None
        # equivalencias: JSON {nombre: sede_id} (confirmadas en la interfaz) o CSV nombre,sede_id
        if equivalencias_csv and equivalencias_csv.lstrip().startswith("{"):
            equiv = json.loads(equivalencias_csv)
        else:
            equiv = io.StringIO(equivalencias_csv) if equivalencias_csv else None
        d, inf = rentabilidad.leer_rentabilidad(libro, coordenadas=coord, equivalencias=equiv, sobrescrituras=params)
    else:
        d, inf = D.leer_plantilla(libro, sobrescrituras=params), None
    if progreso is None:
        prog = None
    else:
        prog = lambda i, n, s: progreso(i, n, str(s))
    res = pipeline.analizar(d, progreso=prog)
    return json.dumps(envolver(serializar(d, inf, res)), ensure_ascii=False, allow_nan=False, default=str)
