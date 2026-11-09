"""Tiempos de viaje entre sedes por modo: a pie, transporte publico sobre rieles (con caminata) y auto.

- Rieles: grafo dirigido (networkx) con el Metro de Santiago (datos_publicos/metro_santiago.csv) y los
  trenes de EFE (datos_publicos/trenes_efe.csv): Nos, Rancagua, San Fernando, Chillan (pasa por Curico
  y Talca), Biotren L1 y L2 y Corto Laja, todos de OpenStreetMap.
  Cada linea tiene su velocidad comercial y su espera en anden (la mitad de la frecuencia tipica).
  Combinacion entre lineas en la misma estacion o en estaciones a menos de 400 m (p. ej. Alameda y
  Estacion Central): caminata + espera de la linea a la que se sube.
- A pie y auto: en el navegador se piden a OSRM (red de calles de OpenStreetMap). Si no hay
  conexion se estiman aqui desde la distancia por calle.
El tiempo en metro o tren nunca supera al de caminar: si no conviene, se camina.
"""
from pathlib import Path

import numpy as np
import pandas as pd

VERSION = 6                    # sube cuando cambia la red de rieles: los estados guardados se recalculan
VEL_PIE_KMH = 4.8
# [SUPUESTO] velocidad comercial (km/h, con detenciones) y espera promedio en anden (min) por linea
# Trenes de larga distancia (San Fernando, Chillan, Laja) pasan pocas veces al dia: son apoyo, con espera alta
LINEAS = {"METRO": (32.0, 3.0), "Nos": (50.0, 5.0), "Rancagua": (85.0, 15.0),       # Alameda-Rancagua ~70 min
          "San Fernando": (85.0, 30.0), "Chillán": (110.0, 45.0),                 # Alameda-Chillan ~3 h 50
          "Biotren L1": (45.0, 8.0), "Biotren L2": (45.0, 8.0), "Laja": (55.0, 45.0),
          "Melipilla": (60.0, 8.0), "Batuco": (55.0, 8.0)}                         # futuras (lineas_futuras.csv)
CAMBIO_MIN = 1.5               # caminata dentro de la estacion al combinar (mas la espera de la nueva linea)
DIST_COMBINACION_KM = 0.4
ACCESO_MAX_MIN = 20.0          # caminata maxima hasta una estacion
VEL_AUTO_KMH = {"SANTIAGO URBANO": 22.0, "ALREDEDORES RM": 35.0, "REGIONES": 40.0}   # solo si no hay OSRM
ESTACIONAR_MIN = 3.0


def _km(lat1, lon1, lat2, lon2):
    lat1, lon1, lat2, lon2 = map(np.radians, (lat1, lon1, lat2, lon2))
    a = np.sin((lat2 - lat1) / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin((lon2 - lon1) / 2) ** 2
    return 6371.0 * 2 * np.arcsin(np.sqrt(a))


def _linea(l):
    return LINEAS.get(l, LINEAS["METRO"])


def estaciones(fecha=None):
    """Estaciones en operación; con fecha (AAAA-MM) suma las de lineas_futuras.csv abiertas a esa fecha."""
    base = Path(__file__).parent / "datos_publicos"
    partes = [pd.read_csv(base / f, dtype={"linea": str}) for f in ("metro_santiago.csv", "trenes_efe.csv") if (base / f).exists()]
    if fecha is not None:
        fut = futuras()
        partes.append(fut[fut["apertura"] <= fecha][["linea", "orden", "estacion", "lat", "lon"]])
    return pd.concat(partes, ignore_index=True)


def futuras():
    """Líneas en obras o proyectadas: estación, apertura estimada (AAAA-MM), estado y fuente."""
    f = Path(__file__).parent / "datos_publicos" / "lineas_futuras.csv"
    return pd.read_csv(f, dtype={"linea": str, "apertura": str}) if f.exists() else pd.DataFrame(columns=["linea", "orden", "estacion", "lat", "lon", "apertura"])


def grafo_metro(est=None):
    """Nodo = (linea, estacion). Aristas dirigidas: tramos consecutivos (ambos sentidos) y combinaciones."""
    import networkx as nx
    est = estaciones() if est is None else est
    G = nx.DiGraph()
    for linea, g in est.sort_values(["linea", "orden"]).groupby("linea"):
        g = g.reset_index(drop=True)
        vel = _linea(linea)[0]
        for _, r in g.iterrows():
            G.add_node((linea, r["estacion"]), lat=r["lat"], lon=r["lon"], linea=linea)
        for a, b in zip(g.index[:-1], g.index[1:]):
            km = _km(g.at[a, "lat"], g.at[a, "lon"], g.at[b, "lat"], g.at[b, "lon"]) * 1.15
            m = km / vel * 60 + 0.5
            u, v = (linea, g.at[a, "estacion"]), (linea, g.at[b, "estacion"])
            G.add_edge(u, v, min=m); G.add_edge(v, u, min=m)
    nodos = list(G.nodes)
    for i, u in enumerate(nodos):
        for v in nodos[i + 1:]:
            if u[0] == v[0]:
                continue
            # mismo nombre no basta (hay "San Miguel" en Santiago y junto a Hualqui): tiene que estar cerca
            d = _km(G.nodes[u]["lat"], G.nodes[u]["lon"], G.nodes[v]["lat"], G.nodes[v]["lon"])
            cerca = d <= DIST_COMBINACION_KM or (u[1] == v[1] and d <= 1.5)
            if cerca:
                G.add_edge(u, v, min=CAMBIO_MIN + _linea(v[0])[1])
                G.add_edge(v, u, min=CAMBIO_MIN + _linea(u[0])[1])
    return G


def minutos_pie(km_calle):
    return np.asarray(km_calle, float) / VEL_PIE_KMH * 60


def minutos_auto(km_calle, zonas):
    km = np.asarray(km_calle, float)
    v = np.array([VEL_AUTO_KMH.get(z, 35.0) for z in zonas])[:, None]
    return np.where(km > 0, km / v * 60 + ESTACIONAR_MIN, 0.0)


def llegada_estaciones(lat, lon, factor_ruta=1.3, est=None, acceso_real=None):
    """Minutos desde cada sede hasta bajarse en cada estacion (caminar + esperar + viajar).

    acceso_real: por punto, {"linea|estacion": minutos a pie por calles (OSRM)}; donde falta, línea recta x factor_ruta.
    Devuelve (llegada sede x estacion, acceso a pie sede x estacion, coordenadas de estaciones).
    """
    import networkx as nx
    lat, lon = np.asarray(lat, float), np.asarray(lon, float)
    G = grafo_metro(est)
    nodos = list(G.nodes)
    espera = np.array([_linea(n[0])[1] for n in nodos])
    slat = np.array([G.nodes[n]["lat"] for n in nodos]); slon = np.array([G.nodes[n]["lon"] for n in nodos])
    acceso = _km(lat[:, None], lon[:, None], slat[None, :], slon[None, :]) * factor_ruta / VEL_PIE_KMH * 60   # sede x estacion
    if acceso_real:
        pos = {f"{n[0]}|{n[1]}": k for k, n in enumerate(nodos)}
        for i, mapa in enumerate(acceso_real):
            for clave, m in (mapa or {}).items():
                if clave in pos and m is not None:
                    acceso[i, pos[clave]] = float(m)
    dist = dict(nx.all_pairs_dijkstra_path_length(G, weight="min"))
    D = np.array([[dist[a].get(b, np.inf) for b in nodos] for a in nodos])
    llegada = np.full((len(lat), len(nodos)), np.inf)
    for i in range(len(lat)):
        cerca = np.where(acceso[i] <= ACCESO_MAX_MIN)[0]
        if len(cerca):
            llegada[i] = (acceso[i, cerca][:, None] + espera[cerca][:, None] + D[cerca, :]).min(axis=0)
    return llegada, acceso, np.column_stack([slat, slon])


def minutos_metro(lat, lon, km_calle, factor_ruta=1.3, est=None, acceso_real=None):
    """Matriz sede x sede en minutos usando metro + caminata (o solo caminata si conviene mas)."""
    pie = minutos_pie(km_calle)
    llegada, acceso, _ = llegada_estaciones(lat, lon, factor_ruta, est, acceso_real)
    out = pie.copy()
    n = len(pie)
    cerca = [np.where(acceso[i] <= ACCESO_MAX_MIN)[0] for i in range(n)]
    for i in range(n):
        if not np.isfinite(llegada[i]).any():
            continue
        desde_i = llegada[i]
        for j in range(n):
            if i != j and len(cerca[j]):
                out[i, j] = min(out[i, j], float((desde_i[cerca[j]] + acceso[j, cerca[j]]).min()))
    np.fill_diagonal(out, 0.0)
    return out


_GRAFOS = {}


def _grafo_en(fecha=None):
    if fecha not in _GRAFOS:
        _GRAFOS[fecha] = grafo_metro(estaciones(fecha))
    return _GRAFOS[fecha]


def ruta_metro(o, d, pie_min, acc_o=None, acc_d=None, fecha=None, factor_ruta=1.3):
    """Camino más rápido entre dos puntos (lat, lon) en metro o tren y a pie, para dibujarlo.

    pie_min: minutos caminando directo (OSRM). acc_o / acc_d: {"linea|estacion": minutos a pie por calles}.
    Devuelve {"modo": "pie" | "metro", "min", "camino": [[lat, lon, linea, estacion], ...]} (estaciones del recorrido).
    """
    import networkx as nx
    G = _grafo_en(fecha)
    nodos = list(G.nodes)
    def acceso(p, acc):
        out = {}
        for n in nodos:
            m = (acc or {}).get(f"{n[0]}|{n[1]}")
            if m is None:
                m = float(_km(p[0], p[1], G.nodes[n]["lat"], G.nodes[n]["lon"])) * factor_ruta / VEL_PIE_KMH * 60
            if m <= ACCESO_MAX_MIN:
                out[n] = m
        return out
    ao, ad = acceso(o, acc_o), acceso(d, acc_d)
    mejor = (float(pie_min), None, None)
    for u, mu in ao.items():
        dist = nx.single_source_dijkstra_path_length(G, u, weight="min")
        for v, mv in ad.items():
            if v in dist:
                total = mu + _linea(u[0])[1] + dist[v] + mv
                if total < mejor[0]:
                    mejor = (total, u, v)
    if mejor[1] is None:
        return {"modo": "pie", "min": round(mejor[0], 1), "camino": []}
    camino = nx.dijkstra_path(G, mejor[1], mejor[2], weight="min")
    return {"modo": "metro", "min": round(mejor[0], 1),
            "camino": [[round(G.nodes[n]["lat"], 6), round(G.nodes[n]["lon"], 6), n[0], n[1]] for n in camino]}


def hipodromos():
    return pd.read_csv(Path(__file__).parent / "datos_publicos" / "hipodromos.csv")


def alcance_hipodromos(lat, lon, factor_ruta=1.3, acceso=None):
    """Para cada hipodromo: su zona, minutos a cada sede (a pie, auto estimado, metro o tren) y llegada a estaciones."""
    from .grafo import zona_de
    la, lo = np.asarray(lat, float), np.asarray(lon, float)
    r = lambda m: [round(float(v), 1) if np.isfinite(v) else None for v in m]
    out = []
    for _, h in hipodromos().iterrows():
        z = zona_de(None, None, h["lat"], h["lon"])
        plat, plon = np.r_[h["lat"], la], np.r_[h["lon"], lo]
        K = _km(plat[:, None], plon[:, None], plat[None, :], plon[None, :]) * factor_ruta
        pie = minutos_pie(K[0, 1:])
        ac = [acceso.get("HIP-" + h["codigo"]) for _ in [0]] + list(acceso.get("_sedes") or [None] * len(la)) if acceso else None
        metro = np.minimum(minutos_metro(plat, plon, K, factor_ruta, acceso_real=ac)[0, 1:], pie)
        L, _, _ = llegada_estaciones([h["lat"]], [h["lon"]], factor_ruta, acceso_real=ac[:1] if ac else None)
        out.append({"codigo": h["codigo"], "nombre": h["nombre"], "ciudad": h["ciudad"], "lat": float(h["lat"]), "lon": float(h["lon"]),
                    "zona": z, "pie": r(pie), "metro": r(metro), "auto": r(minutos_auto(K[0:1, 1:], [z])[0]),
                    "llegada_metro": [round(float(v), 1) if v <= 45 else None for v in L[0]]})
    return out


def matrices(ids, lat, lon, km_calle, zonas, factor_ruta=1.3, acceso=None):
    """Estimaciones locales por modo (minutos). Auto y pie se reemplazan por OSRM en el navegador.

    acceso: {id de sede o "HIP-xxx": {"linea|estacion": minutos a pie por calles}} desde OSRM; sin él, línea recta x factor_ruta.
    """
    if len(ids) == 0:
        return {"ids": [], "pie": [], "auto": [], "metro": [], "rapido": []}
    acceso = acceso or {}
    ac_de = lambda ix: [acceso.get(str(ids[i])) for i in ix] if acceso else None
    km_calle = np.where(np.isfinite(np.asarray(km_calle, float)), km_calle, 9999.0)
    # Sedes con rieles a mano: las de la RM y cualquier otra a distancia caminable de una estacion (p. ej. Rancagua)
    est = estaciones()
    la, lo = np.asarray(lat, float), np.asarray(lon, float)
    cerca_est = (_km(la[:, None], lo[:, None], est["lat"].to_numpy()[None, :], est["lon"].to_numpy()[None, :]) * factor_ruta
                 / VEL_PIE_KMH * 60).min(axis=1) <= ACCESO_MAX_MIN
    rm = np.array([z in ("SANTIAGO URBANO", "ALREDEDORES RM") for z in zonas]) | cerca_est
    metro = minutos_pie(km_calle)
    if rm.any():
        idx = np.where(rm)[0]
        sub = minutos_metro(np.asarray(lat)[idx], np.asarray(lon)[idx], np.asarray(km_calle)[np.ix_(idx, idx)], factor_ruta, acceso_real=ac_de(idx))
        metro[np.ix_(idx, idx)] = sub
    r = lambda m: np.round(m, 1).tolist()
    # Red futura: tiempos en metro o tren desde cada apertura (las sedes sin rieles a mano no cambian)
    fut = []
    for f in sorted(futuras()["apertura"].dropna().unique()):
        ef = estaciones(f)
        cerca_f = (_km(la[:, None], lo[:, None], ef["lat"].to_numpy()[None, :], ef["lon"].to_numpy()[None, :]) * factor_ruta
                   / VEL_PIE_KMH * 60).min(axis=1) <= ACCESO_MAX_MIN
        ix = np.where(np.array([z in ("SANTIAGO URBANO", "ALREDEDORES RM") for z in zonas]) | cerca_f)[0]
        mf = minutos_pie(km_calle)
        if len(ix):
            mf[np.ix_(ix, ix)] = minutos_metro(np.asarray(lat)[ix], np.asarray(lon)[ix], np.asarray(km_calle)[np.ix_(ix, ix)], factor_ruta, ef, ac_de(ix))
        fut.append({"fecha": f, "metro": r(np.minimum(mf, metro))})
    # Para dibujar el area alcanzable: llegada a cada estacion (sedes con rieles a mano, hasta 45 min)
    llegada = [None] * len(zonas)
    estac = []
    if rm.any():
        L, _, xy = llegada_estaciones(np.asarray(lat)[idx], np.asarray(lon)[idx], factor_ruta, acceso_real=ac_de(idx))
        estac = np.round(xy, 6).tolist()
        for k, i in enumerate(idx):
            llegada[i] = [round(float(v), 1) if v <= 45 else None for v in L[k]]
    return {"ids": list(ids), "pie": r(minutos_pie(km_calle)), "auto": r(minutos_auto(km_calle, zonas)), "metro": r(metro),
            "version": VERSION, "estaciones": estac, "llegada_metro": llegada, "futuras": fut,
            "hipodromos": alcance_hipodromos(lat, lon, factor_ruta, {**acceso, "_sedes": [acceso.get(str(i)) for i in ids]} if acceso else None),
            "fuente": {"pie": "estimado", "auto": "estimado", "metro": "Metro de Santiago y trenes EFE (OpenStreetMap)",
                       "acceso": "OpenStreetMap (OSRM)" if acceso else "estimado"}}
