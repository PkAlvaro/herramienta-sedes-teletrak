"""Geocodificacion de direcciones con OpenStreetMap (Nominatim).

Envia SOLO la direccion (no nombres ni ventas) al servicio publico de
Nominatim. Respeta su politica de uso: 1 consulta por segundo e identificacion
de la aplicacion. Guarda cada resultado en un CSV a medida que avanza, asi que
si se corta se retoma donde quedo y nunca se repite una consulta.

Solo para CPython (no corre en el navegador).
"""
import csv
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

import pandas as pd

URL = "https://nominatim.openstreetmap.org/search"
AGENTE = "herramienta-sedes-evalpro/0.1"
CAMPOS = ["sede_id", "direccion", "consulta", "lat", "lon", "comuna", "region", "calidad", "nombre_osm"]


def _consultar(q, pausa):
    params = urllib.parse.urlencode({"q": q, "format": "jsonv2", "addressdetails": 1, "limit": 1, "countrycodes": "cl"})
    req = urllib.request.Request(f"{URL}?{params}", headers={"User-Agent": AGENTE, "Accept-Language": "es"})
    time.sleep(pausa)
    with urllib.request.urlopen(req, timeout=30) as r:
        res = json.load(r)
    return res[0] if res else None


def _calidad(r):
    tipo = r.get("addresstype") or r.get("type") or ""
    if tipo in ("house", "building", "amenity", "shop", "commercial", "retail"):
        return "EXACTA"
    if tipo in ("road", "street", "residential", "pedestrian"):
        return "CALLE"
    return "APROXIMADA"


def geocodificar(direcciones, salida, pausa=1.1, progreso=print):
    """direcciones: DataFrame con sede_id, direccion, zona. Agrega al CSV 'salida' lo que falte."""
    salida = Path(salida)
    hechos = set()
    if salida.exists():
        prev = pd.read_csv(salida, dtype=str)
        hechos = set(prev.loc[~prev["calidad"].fillna("").str.startswith("ERROR"), "sede_id"])  # los errores se reintentan
    nuevo = not salida.exists()
    pend = direcciones[~direcciones["sede_id"].isin(hechos)]
    with open(salida, "a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=CAMPOS)
        if nuevo:
            w.writeheader()
        for i, r in enumerate(pend.itertuples(), start=1):
            dir_ = str(r.direccion).strip()
            intentos = [f"{dir_}, Chile"]
            if str(getattr(r, "zona", "")).upper().startswith("SANTIAGO"):
                intentos.append(f"{dir_}, Santiago, Chile")
            if "," in dir_:                       # ultimo recurso: centro de la comuna (ultimo tramo de la direccion)
                intentos.append(f"{dir_.split(',')[-1].strip()}, Chile")
            fila = {"sede_id": r.sede_id, "direccion": dir_, "calidad": "NO_ENCONTRADA"}
            for k, q in enumerate(intentos):
                try:
                    res = _consultar(q, pausa)
                except Exception as e:
                    fila["calidad"] = f"ERROR {type(e).__name__}"
                    res = None
                if res:
                    a = res.get("address", {})
                    fila.update(consulta=q, lat=res["lat"], lon=res["lon"], calidad="CENTRO_COMUNA" if "," in dir_ and k == len(intentos) - 1 else _calidad(res),
                                comuna=a.get("city") or a.get("town") or a.get("village") or a.get("municipality") or a.get("suburb"),
                                region=a.get("state"), nombre_osm=res.get("display_name"))
                    break
            w.writerow(fila)
            f.flush()
            if progreso:
                progreso(f"{i}/{len(pend)} {r.sede_id} {fila['calidad']}")
    return pd.read_csv(salida, dtype={"sede_id": str})
