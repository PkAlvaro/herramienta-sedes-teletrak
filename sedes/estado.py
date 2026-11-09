"""Huella de datos y estados guardados (.sedes.json).

- huella(): identifica datos + parametros. Sirve de llave de cache y para avisar
  si un estado se calculo con otros datos.
- guardar() / cargar(): estado completo en JSON portable. Es el mismo formato que
  descarga la interfaz web (ui_api.FORMATO), asi que un estado hecho por linea de
  comandos se abre en la interfaz y al reves.
"""
import hashlib
import io
import json

import pandas as pd

TABLAS = ["sedes", "demanda_anual", "demanda_mensual", "historico", "economia", "segmentos", "diagnostico_k"]


def _bytes_df(df):
    return df.sort_index(axis=1).to_csv(index=False, date_format="%Y-%m-%d").encode()


def huella(datos, claves_config=None):
    """sha256 corto de los datos y de los parametros indicados (todos si None)."""
    h = hashlib.sha256()
    for df in (datos.sedes.reset_index(drop=True), datos.ventas.sort_values(["sede_id", "mes", "hipodromo"]),
               datos.ipc, datos.distancias.reset_index()):
        h.update(_bytes_df(df))
    cfg = datos.config if claves_config is None else {k: datos.config[k] for k in claves_config}
    h.update(json.dumps(cfg, sort_keys=True, default=str).encode())
    return h.hexdigest()[:16]


def huella_datos(datos):
    return huella(datos, claves_config=[])


def guardar(resultado, datos, destino=None, nombre="", vista=None, informe=None, incluir_datos=False):
    """resultado: salida de pipeline.analizar. Devuelve el dict del estado."""
    from . import ui_api
    est = ui_api.envolver(ui_api.serializar(datos, informe, resultado), nombre=nombre, vista=vista)
    if incluir_datos:
        est["datos"] = {"sedes": ui_api._registros(datos.sedes.reset_index(drop=True)),
                        "ventas": ui_api._registros(datos.ventas), "ipc": ui_api._registros(datos.ipc)}
    if destino is not None:
        texto = json.dumps(est, ensure_ascii=False, allow_nan=False, default=str)
        if isinstance(destino, io.IOBase):
            destino.write(texto)
        else:
            with open(destino, "w", encoding="utf-8") as f:
                f.write(texto)
    return est


def cargar(fuente, datos_actuales=None):
    """Devuelve (estado, tablas como DataFrames, aviso). aviso != None si los datos no coinciden."""
    from . import ui_api
    if isinstance(fuente, dict):
        est = fuente
    else:
        with open(fuente, encoding="utf-8") as f:
            est = json.load(f)
    if est.get("formato") != ui_api.FORMATO:
        raise ValueError(f"Formato de estado no reconocido: {est.get('formato')}")
    tablas = {k: pd.DataFrame(est[k]) for k in TABLAS if k in est}
    aviso = None
    if datos_actuales is not None and huella_datos(datos_actuales) != est["huella_datos"]:
        aviso = "El estado se calculo con datos distintos a los cargados ahora."
    return est, tablas, aviso
