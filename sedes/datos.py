"""Carga y validacion de la plantilla Excel.

leer_plantilla acepta una ruta o bytes, para funcionar igual en CPython y en
Pyodide (donde el archivo llega como bytes desde el navegador).
"""
import io
import json
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .config import GRUPOS, HIPODROMOS, construir_config
from .esquema import HOJAS, HOJAS_OBLIGATORIAS


class PlantillaInvalida(Exception):
    def __init__(self, problemas):
        self.problemas = problemas
        super().__init__("\n".join(str(p) for p in problemas if p.nivel == "ERROR"))


@dataclass
class Problema:
    nivel: str      # ERROR o AVISO
    hoja: str
    mensaje: str

    def __str__(self):
        return f"[{self.nivel}] {self.hoja}: {self.mensaje}"


@dataclass
class Datos:
    sedes: pd.DataFrame
    ventas: pd.DataFrame
    ipc: pd.DataFrame
    distancias: pd.DataFrame            # matriz km entre sedes fisicas
    config: dict
    problemas: list = field(default_factory=list)

    @property
    def ids_fisicas(self):
        return list(self.distancias.index)

    @property
    def ids_vigentes(self):
        return self.sedes.index[self.sedes["estado"] == "VIGENTE"].tolist()


# ---------------------------------------------------------------------------
# Lectura
# ---------------------------------------------------------------------------

def _convertir(serie, tipo):
    if tipo == "str":
        return serie.astype("string").str.strip()
    if tipo in ("float", "int"):
        return pd.to_numeric(serie, errors="coerce")
    if tipo == "date":
        return pd.to_datetime(serie, errors="coerce")
    if tipo == "month":
        return pd.to_datetime(serie, errors="coerce").dt.to_period("M").dt.to_timestamp()
    raise ValueError(tipo)


def _leer_hoja(libro, hoja, problemas):
    df = libro[hoja].copy()
    df.columns = [str(c).strip() for c in df.columns]
    df = df.dropna(how="all")
    for col, tipo, obligatoria, _ in HOJAS[hoja]:
        if col not in df.columns:
            if obligatoria:
                problemas.append(Problema("ERROR", hoja, f"falta la columna '{col}'"))
            df[col] = pd.NA
            continue
        original = df[col]
        df[col] = _convertir(original, tipo)
        malos = original.notna() & df[col].isna()
        if malos.any():
            filas = (df.index[malos][:5] + 2).tolist()
            problemas.append(Problema("ERROR", hoja, f"'{col}' tiene valores que no son {tipo} (filas Excel {filas})"))
    return df


def abrir_libro(fuente, header=0):
    """Ruta, bytes o dict {hoja: filas} -> {hoja: DataFrame}.

    El dict es lo que entrega el navegador (SheetJS lee el Excel en JavaScript y
    Python recibe las filas), asi Pyodide no necesita openpyxl.
    """
    if isinstance(fuente, dict):
        libro = {}
        for hoja, filas in fuente.items():
            df = pd.DataFrame(filas)
            if header == 0 and len(df):
                df.columns = [str(c) if c is not None else f"col{i}" for i, c in enumerate(df.iloc[0])]
                df = df.iloc[1:].reset_index(drop=True)
            libro[hoja] = df
        return libro
    if isinstance(fuente, (bytes, bytearray)):
        fuente = io.BytesIO(fuente)
    return pd.read_excel(fuente, sheet_name=None, header=header, engine="openpyxl")


def leer_plantilla(fuente, sobrescrituras=None, estricto=True):
    """Lee la plantilla y devuelve Datos. Con estricto=True lanza PlantillaInvalida si hay errores."""
    libro = abrir_libro(fuente, header=0)
    problemas = []

    faltan = [h for h in HOJAS_OBLIGATORIAS if h not in libro]
    if faltan:
        problemas.append(Problema("ERROR", "LIBRO", f"faltan las hojas {faltan}"))
        raise PlantillaInvalida(problemas)

    sedes = _leer_hoja(libro, "SEDES", problemas)
    ventas = _leer_hoja(libro, "VENTAS_MENSUALES", problemas)
    ipc = _leer_hoja(libro, "IPC", problemas)
    dist_larga = _leer_hoja(libro, "DISTANCIAS", problemas) if "DISTANCIAS" in libro else None
    params = _leer_parametros(libro, problemas) if "PARAMETROS" in libro else {}
    params.update(sobrescrituras or {})

    try:
        cfg = construir_config(params)
    except KeyError as e:
        problemas.append(Problema("ERROR", "PARAMETROS", str(e)))
        cfg = construir_config(sobrescrituras)

    sedes, ventas = _normalizar(sedes, ventas)
    _validar(sedes, ventas, ipc, problemas)
    if estricto and any(p.nivel == "ERROR" for p in problemas):
        raise PlantillaInvalida(problemas)

    distancias = matriz_distancias(sedes, dist_larga, cfg["factor_ruta"], problemas)
    ipc = ipc.dropna(subset=["mes"]).sort_values("mes").drop_duplicates("mes").reset_index(drop=True)
    return Datos(sedes=sedes, ventas=ventas, ipc=ipc, distancias=distancias, config=cfg, problemas=problemas)


def _leer_parametros(libro, problemas):
    df = _leer_hoja(libro, "PARAMETROS", problemas)
    out = {}
    for _, fila in df.dropna(subset=["parametro"]).iterrows():
        txt = str(fila["valor"]).strip()
        try:
            out[str(fila["parametro"])] = json.loads(txt)
        except json.JSONDecodeError:
            out[str(fila["parametro"])] = txt
    return out


def _normalizar(sedes, ventas):
    sedes = sedes.dropna(subset=["sede_id"]).copy()
    for col in ("grupo", "estado"):
        sedes[col] = sedes[col].str.upper()
    sedes = sedes.set_index("sede_id", drop=False)
    ventas = ventas.dropna(subset=["sede_id", "mes"]).copy()
    ventas["hipodromo"] = ventas["hipodromo"].str.upper()
    return sedes, ventas


# ---------------------------------------------------------------------------
# Validacion
# ---------------------------------------------------------------------------

def _validar(sedes, ventas, ipc, problemas):
    P = lambda nivel, hoja, msg: problemas.append(Problema(nivel, hoja, msg))

    dup = sedes.index[sedes.index.duplicated()].unique().tolist()
    if dup:
        P("ERROR", "SEDES", f"sede_id repetidos: {dup}")
    malos = sorted(set(sedes["grupo"].dropna()) - set(GRUPOS))
    if malos:
        P("ERROR", "SEDES", f"grupos no reconocidos {malos}, usar {GRUPOS}")
    malos = sorted(set(sedes["estado"].dropna()) - {"VIGENTE", "CERRADA"})
    if malos:
        P("ERROR", "SEDES", f"estados no reconocidos {malos}, usar VIGENTE o CERRADA")

    fisicas = sedes[sedes["grupo"] != "DIGITAL"]
    sin_coord = fisicas.index[fisicas["lat"].isna() | fisicas["lon"].isna()].tolist()
    if sin_coord:
        P("ERROR", "SEDES", f"sedes fisicas sin coordenadas: {sin_coord}")
    fuera = fisicas.index[~fisicas["lat"].between(-56, -17) | ~fisicas["lon"].between(-76, -66)]
    fuera = [s for s in fuera if s not in sin_coord]
    if fuera:
        P("AVISO", "SEDES", f"coordenadas fuera de Chile continental, revisar lat/lon invertidas: {fuera}")

    sin_costos = fisicas.index[(fisicas["estado"] == "VIGENTE") & fisicas["arriendo_mensual_clp"].isna()].tolist()
    if sin_costos:
        P("AVISO", "SEDES", f"{len(sin_costos)} sedes vigentes sin arriendo, el modulo de economia las omite")

    desconocidas = sorted(set(ventas["sede_id"]) - set(sedes.index))
    if desconocidas:
        P("ERROR", "VENTAS_MENSUALES", f"sede_id que no existen en SEDES: {desconocidas[:10]}")
    malos = sorted(set(ventas["hipodromo"].dropna()) - set(HIPODROMOS) - {"OTRO"})
    if malos:
        P("ERROR", "VENTAS_MENSUALES", f"hipodromos no reconocidos {malos}")
    if (ventas["venta_nominal_clp"] < 0).any():
        P("ERROR", "VENTAS_MENSUALES", "hay ventas negativas")
    dup = ventas.duplicated(["sede_id", "mes", "hipodromo"]).sum()
    if dup:
        P("ERROR", "VENTAS_MENSUALES", f"{dup} filas repetidas (sede, mes, hipodromo)")
    jorn = ventas.groupby(["sede_id", "mes"])["jornadas"].nunique()
    if (jorn > 1).any():
        P("AVISO", "VENTAS_MENSUALES", f"{int((jorn > 1).sum())} sede-mes con jornadas distintas entre hipodromos, se usa el maximo")

    vigentes = sedes.index[sedes["estado"] == "VIGENTE"]
    sin_ventas = sorted(set(vigentes) - set(ventas["sede_id"]))
    if sin_ventas:
        P("AVISO", "VENTAS_MENSUALES", f"sedes vigentes sin ventas: {sin_ventas}")

    if len(ventas) and len(ipc.dropna()):
        faltan = sorted(set(ventas["mes"].dropna()) - set(ipc["mes"].dropna()))
        if faltan:
            P("ERROR", "IPC", f"faltan {len(faltan)} meses de IPC, por ejemplo {[str(m.date()) for m in faltan[:3]]}")


# ---------------------------------------------------------------------------
# Distancias
# ---------------------------------------------------------------------------

def haversine_km(lat1, lon1, lat2, lon2):
    lat1, lon1, lat2, lon2 = map(np.radians, (lat1, lon1, lat2, lon2))
    a = np.sin((lat2 - lat1) / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin((lon2 - lon1) / 2) ** 2
    return 6371.0 * 2 * np.arcsin(np.sqrt(a))


def matriz_distancias(sedes, dist_larga=None, factor_ruta=1.3, problemas=None):
    """Matriz km entre sedes fisicas. Usa DISTANCIAS si viene, completa con linea recta x factor_ruta."""
    fis = sedes[(sedes["grupo"] != "DIGITAL") & sedes["lat"].notna() & sedes["lon"].notna()]
    lat, lon = fis["lat"].to_numpy(float), fis["lon"].to_numpy(float)
    km = haversine_km(lat[:, None], lon[:, None], lat[None, :], lon[None, :]) * factor_ruta
    m = pd.DataFrame(km, index=fis.index, columns=fis.index)
    if dist_larga is not None and len(dist_larga):
        d = dist_larga.dropna(subset=["origen", "destino", "km"])
        validas = d["origen"].isin(m.index) & d["destino"].isin(m.index)
        if problemas is not None and (~validas).any():
            problemas.append(Problema("AVISO", "DISTANCIAS", f"{int((~validas).sum())} filas con sedes desconocidas o digitales, se ignoran"))
        filas = list(d[validas][["origen", "destino", "km"]].itertuples(index=False))
        dadas = {(o, de) for o, de, _ in filas}
        for o, de, k in filas:
            m.loc[o, de] = k
            if (de, o) not in dadas:
                m.loc[de, o] = k
    arr = m.to_numpy(dtype=float, copy=True)
    np.fill_diagonal(arr, 0.0)
    return pd.DataFrame(arr, index=m.index, columns=m.columns)
