"""Segmentacion de sedes por perfil (k-means sobre variables estandarizadas)."""
import numpy as np
import pandas as pd

# variable -> (transformacion, nombre legible para describir los segmentos)
VARIABLES = {
    "venta_12m_real": ("log", "venta"),
    "crecimiento_anual_pct": (None, "crecimiento"),
    "volatilidad": (None, "volatilidad"),
    "retencion_huff": (None, "retencion en red"),
    "dist_vecino_km": ("log", "distancia al vecino"),
    "holgura_equilibrio": (None, "holgura sobre equilibrio"),
}


def tabla_variables(metricas_dem, metricas_red, econ=None, variables=None):
    """Junta las variables candidatas en una tabla por sede fisica vigente."""
    t = metricas_dem.reindex(metricas_red.index).join(metricas_red, how="left")
    if econ is not None and len(econ):
        primer_ano = econ["ano"].min()
        t = t.join(econ[econ["ano"] == primer_ano].set_index("sede_id")[["holgura_equilibrio"]], how="left")
    vars_ = [v for v in (variables or VARIABLES) if v in t.columns and t[v].notna().any()]
    return t, vars_


def _matriz(t, vars_):
    X = pd.DataFrame(index=t.index)
    for v in vars_:
        col = t[v].astype(float).replace([np.inf, -np.inf], np.nan)
        if VARIABLES.get(v, (None,))[0] == "log":
            col = np.log1p(col.clip(lower=0))
        X[v] = col.fillna(col.median() if col.notna().any() else 0.0)
    return (X - X.mean()) / X.std(ddof=0).replace(0, 1)


def segmentar(t, vars_, k=None, k_rango=(3, 6), semilla=42):
    """Devuelve (asignacion, perfiles, diagnostico). k=None elige por silhouette."""
    from sklearn.cluster import KMeans
    from sklearn.metrics import silhouette_score
    if not len(t) or not vars_:
        asign = pd.Series([], index=t.index, name="segmento", dtype=int)
        perfiles = pd.DataFrame(columns=["segmento", "n_sedes", "descripcion"])
        diag = pd.DataFrame(columns=["k", "silhouette", "inercia"])
        return asign, perfiles, diag

    Z = _matriz(t, vars_)
    n = len(Z)
    candidatos = [k] if k else [kk for kk in range(k_rango[0], k_rango[1] + 1) if 1 < kk < n]
    if not candidatos:
        candidatos = [min(max(1, n), 2)] if n >= 2 else [1]

    diag = []
    mejor = None
    for kk in candidatos:
        if kk == 1 or n <= 1:
            diag.append({"k": 1, "silhouette": np.nan, "inercia": 0.0})
            mejor = (0.0, None)
            break
        km = KMeans(n_clusters=kk, n_init=20, random_state=semilla).fit(Z)
        sil = silhouette_score(Z, km.labels_) if 1 < kk < n else np.nan
        diag.append({"k": kk, "silhouette": sil, "inercia": km.inertia_})
        if mejor is None or (np.nan_to_num(sil, nan=-1) > mejor[0]):
            mejor = (np.nan_to_num(sil, nan=-1), km)

    if mejor[1] is None:
        asign = pd.Series(1, index=Z.index, name="segmento")
        perfiles = pd.DataFrame([{"segmento": 1, "n_sedes": n, "descripcion": "Todas"}])
        return asign, perfiles, pd.DataFrame(diag)

    km = mejor[1]
    # Orden estable: segmento 1 = mayor venta media
    z_cent = pd.DataFrame(km.cluster_centers_, columns=vars_)
    orden = z_cent[vars_[0]].sort_values(ascending=False).index.tolist()
    remap = {old: new + 1 for new, old in enumerate(orden)}
    seg = pd.Series(km.labels_, index=Z.index).map(remap).rename("segmento")
    z_cent.index = z_cent.index.map(remap)
    z_cent = z_cent.sort_index()

    perfiles = []
    for s_id in sorted(set(seg)):
        msk = seg == s_id
        perfiles.append({
            "segmento": s_id,
            "n_sedes": int(msk.sum()),
            "descripcion": _describir(z_cent.loc[s_id]),
            **{f"{v}_mediana": float(t.loc[msk, v].median()) for v in vars_ if v in t.columns}
        })
    return seg, pd.DataFrame(perfiles), pd.DataFrame(diag)


def _describir(centro):
    palabras = []
    for col, v in centro.items():
        if abs(v) >= 0.8:
            palabras.append(f"{'alta' if v > 0 else 'baja'} {VARIABLES.get(col, (None, col))[1]}")
    return ", ".join(palabras) if palabras else "perfil promedio"
