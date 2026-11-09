"""Red de cobertura como grafo (networkx).

Nodo: sede fisica operando. Arista: dos sedes de la misma zona a las que se llega una desde otra
dentro del umbral de esa zona (minutos a pie, en metro o en auto, o km por calle), es decir, una es
alternativa de la otra para el cliente. Sobre ese grafo:
- sin respaldo: sede sin ninguna alternativa (grado 0)
- critica: si cierra, otra sede queda sin alternativa (es su unico respaldo) o su red local
  se parte en pedazos (punto de articulacion)
- redundante: el resto, su cierre no deja a nadie sin alternativa
- red local: componente conexa (sedes unidas por cadenas de alternativas)
Se calcula para la red de hoy y para un escenario de cierres, y se comparan.
"""
import numpy as np

ZONAS = ("SANTIAGO URBANO", "ALREDEDORES RM", "REGIONES")
NOMBRE_ZONA = {"SANTIAGO URBANO": "Santiago urbano", "ALREDEDORES RM": "Alrededores RM", "REGIONES": "Regiones"}
SANTIAGO = (-33.4489, -70.6693)


def zona_de(grupo, zona_cliente, lat, lon):
    """Santiago urbano, alrededores RM o regiones: la COMUNIDAD del cliente; si no es geografica, por ubicacion."""
    if grupo == "DIGITAL":
        return "DIGITAL"
    c = " ".join(str(zona_cliente or "").upper().split())
    if c.startswith("SANTIAGO EXTERIOR"):
        return "ALREDEDORES RM"
    if c.startswith("SANTIAGO"):
        return "SANTIAGO URBANO"
    if c.startswith("ZONA") or "REGION" in c:
        return "REGIONES"
    if lat is None or lon is None or not np.isfinite(lat) or not np.isfinite(lon):
        return "REGIONES"
    R = np.pi / 180
    x = (lon - SANTIAGO[1]) * R * np.cos((lat + SANTIAGO[0]) / 2 * R)
    y = (lat - SANTIAGO[0]) * R
    d = 6371 * np.hypot(x, y)
    if d <= 22:
        return "SANTIAGO URBANO"
    return "ALREDEDORES RM" if d <= 75 and -34.3 < lat < -32.9 else "REGIONES"


def construir(ids, km, zonas, radios):
    """Grafo de alternativas: arista si misma zona y costo de acceso (km o minutos) <= umbral de la zona."""
    import networkx as nx
    G = nx.Graph()
    for i in ids:
        G.add_node(i, zona=zonas[i])
    km = np.asarray(km, dtype=float)
    for a in range(len(ids)):
        for b in range(a + 1, len(ids)):
            i, j = ids[a], ids[b]
            if zonas[i] == zonas[j] and km[a, b] <= radios.get(zonas[i], 15.0):
                G.add_edge(i, j, km=float(km[a, b]))
    return G


def roles(G, fijos=()):
    """Rol de cada sede en el grafo, con el motivo cuando es critica."""
    import networkx as nx
    out = {}
    redes = {}
    for z in ZONAS:
        comps = sorted((c for c in nx.connected_components(G.subgraph([n for n, d in G.nodes(data=True) if d["zona"] == z])) if len(c) > 1),
                       key=lambda c: (-len(c), min(c)))
        for k, c in enumerate(comps, 1):
            for n in c:
                redes[n] = (f"{NOMBRE_ZONA[z]} {k}", len(c))
    articulacion = set(nx.articulation_points(G))
    for n in G.nodes:
        vec = list(G.neighbors(n))
        dependen = sorted(v for v in vec if G.degree(v) == 1 and v not in fijos)   # n es su unica alternativa (un hipodromo no la necesita)
        partes = 0
        if n in articulacion:
            resto = G.subgraph(nx.node_connected_component(G, n) - {n})
            partes = nx.number_connected_components(resto)
        if not vec:
            rol = "SIN RESPALDO"
        elif dependen or partes > 1:
            rol = "CRITICA"
        else:
            rol = "REDUNDANTE"
        motivo = []
        if dependen:
            motivo.append("única alternativa de " + str(len(dependen)) + (" sede" if len(dependen) == 1 else " sedes"))
        trozos = partes - len(dependen)        # las que dependen quedan sueltas; el resto puede partirse
        if trozos > 1:
            motivo.append(f"si cierra, su red local se divide en {trozos}")
        red, tam = redes.get(n, (None, 1))
        out[n] = {"rol": rol, "vecinas": len(vec), "alternativas": sorted(vec, key=lambda v: G.edges[n, v]["km"]),
                  "dependen": dependen, "partes_si_cierra": partes, "motivo": "; ".join(motivo) or None,
                  "red_local": red, "tam_red": tam}
    return out


def _resumen(G, R, venta, fijos=()):
    filas = []
    for z in ZONAS:
        nodos = [n for n, d in G.nodes(data=True) if d["zona"] == z and n not in fijos]   # se cuentan solo sedes
        if not nodos:
            continue
        v_tot = sum(venta.get(n, 0.0) for n in nodos) or 1.0
        sin = [n for n in nodos if R[n]["rol"] == "SIN RESPALDO"]
        filas.append({"zona": z, "sedes": len(nodos),
                      "redes_locales": len({R[n]["red_local"] for n in nodos if R[n]["red_local"]}),
                      "sin_respaldo": len(sin), "criticas": sum(R[n]["rol"] == "CRITICA" for n in nodos),
                      "redundantes": sum(R[n]["rol"] == "REDUNDANTE" for n in nodos),
                      "venta_sin_respaldo": sum(venta.get(n, 0.0) for n in sin) / v_tot})
    return filas


def analizar(ids, km, zonas, venta, cerradas, radios, fijos=None):
    """Red de hoy y red con el escenario de cierres. Todo en tipos simples para JSON.

    fijos: nodos que nunca cierran ni se cuentan como sedes (los hipodromos), pero si son alternativa.
    """
    ids = [str(i) for i in ids]
    zonas = {str(k): v for k, v in zonas.items()}
    venta = {str(k): float(v or 0.0) for k, v in (venta or {}).items()}
    fijos = {str(f) for f in (fijos or [])} & set(ids)
    cerradas = sorted({str(c) for c in (cerradas or [])} & set(ids) - fijos)
    G = construir(ids, km, zonas, radios)
    hoy = roles(G, fijos)
    Ge = G.copy()
    Ge.remove_nodes_from(cerradas)
    esc = roles(Ge, fijos)
    for n, r in esc.items():
        r["pierde_respaldo"] = hoy[n]["vecinas"] > 0 and r["vecinas"] == 0
        r["pasa_a_critica"] = hoy[n]["rol"] == "REDUNDANTE" and r["rol"] == "CRITICA"
    return {
        "radios": dict(radios), "cerradas": cerradas, "fijos": sorted(fijos),
        "aristas": [[a, b, round(d["km"], 2)] for a, b, d in G.edges(data=True)],
        "hoy": hoy, "escenario": esc,
        "resumen_hoy": _resumen(G, hoy, venta, fijos), "resumen_escenario": _resumen(Ge, esc, venta, fijos),
    }


def linea_tiempo(ids, km, zonas, venta, radios, cortes, fijos=None):
    """Red en cada fecha de un calendario de cierres.

    cortes: lista de {fecha, cerradas[, km]} (cerradas acumuladas a esa fecha; km opcional = costos con la red de esa fecha). Por corte devuelve el rol de cada
    nodo abierto y el resumen por zona; las aristas son las de la red completa (se cortan al cerrar).
    """
    ids = [str(i) for i in ids]
    zonas = {str(k): v for k, v in zonas.items()}
    venta = {str(k): float(v or 0.0) for k, v in (venta or {}).items()}
    fijos = {str(f) for f in (fijos or [])} & set(ids)
    G = construir(ids, km, zonas, radios)
    out = []
    for c in cortes:
        # Si el corte trae su propia matriz (red de transporte de esa fecha: líneas nuevas abiertas), se rearma el grafo
        Ge = construir(ids, c["km"], zonas, radios) if c.get("km") is not None else G.copy()
        Ge.remove_nodes_from({str(x) for x in c.get("cerradas") or []} - fijos)
        R = roles(Ge, fijos)
        out.append({"fecha": c["fecha"], "aristas": [[a, b] for a, b in Ge.edges()] if c.get("km") is not None else None,
                    "roles": {n: [r["rol"], r["vecinas"]] for n, r in R.items() if n not in fijos},
                    "resumen": _resumen(Ge, R, venta, fijos)})
    return {"aristas": [[a, b, round(d["km"], 2)] for a, b, d in G.edges(data=True)], "cortes": out}


def costo(km, tiempos, zonas, acceso):
    """Matriz de costo de acceso entre sedes: cada par usa el modo de su zona (minutos, o km si modo = km)."""
    km = np.asarray(km, float)
    M = {m: np.asarray(tiempos[m], float) for m in ("pie", "metro", "auto")}
    M["rapido"] = np.minimum(np.minimum(M["pie"], M["metro"]), M["auto"])
    M["metro"] = np.minimum(M["metro"], M["pie"])          # si el metro no conviene, se camina
    M["km"] = km
    out = np.full_like(km, 9999.0)
    zs = list(zonas)
    for z in set(zs):
        idx = np.array([k for k, x in enumerate(zs) if x == z])
        if z in acceso:
            out[np.ix_(idx, idx)] = M[acceso[z]["modo"]][np.ix_(idx, idx)]
    return out


def desde_datos(datos, ficha, tiempos):
    """Grafo de la red fisica vigente, escenario = cierres ya decididos por la gerencia."""
    if not tiempos or not len(tiempos.get("ids", [])):
        return {"nodos": [], "aristas": [], "componentes": [], "aisladas": [], "estadisticas": {}}
    cfg = datos.config
    fis = list(tiempos["ids"])
    km = datos.distancias.loc[fis, fis].to_numpy(dtype=float)
    km = np.where(np.isfinite(km), km, 9999.0)
    zonas = ficha["zona_red"].reindex(fis)
    acceso = cfg["acceso_zona"]
    dec = ficha["cierre_decidido"].fillna(False).astype(bool) if "cierre_decidido" in ficha else None
    cerradas = [s for s in fis if dec is not None and dec.get(s, False)]
    venta = ficha["venta_12m_real"].reindex(fis).fillna(0.0).to_dict() if "venta_12m_real" in ficha else {}
    C = costo(km, tiempos, zonas, acceso)
    # Hipodromos: nodos fijos (no cierran, no se cuentan como sedes, si son alternativa), con el modo de su zona
    H = tiempos.get("hipodromos") or []
    n, f = len(fis), cfg.get("factor_ruta", 1.3)
    ext = np.full((n + len(H), n + len(H)), 9999.0)
    ext[:n, :n] = C
    zs = zonas.tolist()
    lat, lon = ficha["lat"].reindex(fis).to_numpy(float), ficha["lon"].reindex(fis).to_numpy(float)
    for k, h in enumerate(H):
        modo = acceso.get(h["zona"], {}).get("modo", "auto")
        val = lambda m: np.array([9999.0 if v is None else v for v in h[m]])
        pie, metro, auto = val("pie"), np.minimum(val("metro"), val("pie")), val("auto")
        kmh = _km_linea(h["lat"], h["lon"], lat, lon) * f
        v = {"km": kmh, "pie": pie, "metro": metro, "auto": auto, "rapido": np.minimum(np.minimum(pie, metro), auto)}[modo]
        v = np.where(np.array(zs) == h["zona"], v, 9999.0)
        ext[n + k, :n] = v; ext[:n, n + k] = v; ext[n + k, n + k] = 0.0
    ids = fis + ["HIP-" + h["codigo"] for h in H]
    zd = {**zonas.to_dict(), **{"HIP-" + h["codigo"]: h["zona"] for h in H}}
    return analizar(ids, ext, zd, venta, cerradas, {z: a["umbral"] for z, a in acceso.items()}, fijos=ids[n:])


def _km_linea(lat1, lon1, lat2, lon2):
    R = np.pi / 180
    x = (np.asarray(lon2) - lon1) * R * np.cos((np.asarray(lat2) + lat1) / 2 * R)
    y = (np.asarray(lat2) - lat1) * R
    return 6371 * np.hypot(x, y)
