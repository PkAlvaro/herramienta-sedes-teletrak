"""Analisis espacial de la red: clusters (DBSCAN), vecindad y redundancia Huff."""
import numpy as np
import pandas as pd

from . import huff


def _zona(g):
    return "RM" if g in ("G9", "RM") else "REGIONES"


def clusters_espaciales(datos, ids=None):
    """Asigna a cada sede su cluster espacial de sedes cercanas.

    min_samples=2: dos sedes a menos del radio ya forman red. Las que no tienen
    vecino dentro del radio quedan como AISLADA.
    """
    from sklearn.cluster import DBSCAN
    cfg = datos.config
    ids = [s for s in (ids or datos.ids_vigentes) if s in datos.distancias.index]
    if not ids:
        return pd.Series([], index=pd.Index([], name="sede_id"), dtype=object)
    zonas = datos.sedes.loc[ids, "grupo"].map(_zona)
    etiqueta = pd.Series("AISLADA", index=ids, dtype=object)
    for zona, miembros in zonas.groupby(zonas):
        m = miembros.index.tolist()
        if len(m) < 2:
            continue
        D = datos.distancias.loc[m, m].to_numpy(float)
        lab = DBSCAN(eps=cfg["radio_cobertura_km"][zona], min_samples=2, metric="precomputed").fit_predict(D)
        pref = "RM" if zona == "RM" else "REG"
        for s, l in zip(m, lab):
            if l >= 0:
                etiqueta[s] = f"{pref}_{l + 1}"
    return etiqueta


def metricas_red(datos, demanda_anual, ids=None):
    """Una fila por sede fisica vigente: cluster, vecindad y redundancia Huff.

    demanda_anual: Series sede -> venta anual real (por ejemplo venta_12m_real).
    """
    cfg = datos.config
    ids = [s for s in (ids or datos.ids_vigentes) if s in datos.distancias.index]
    r = cfg["radio_vecinos_km"]
    cols = ["cluster_espacial", "tam_cluster", "dist_vecino_km", "vecino_mas_cercano",
            f"vecinos_{r:g}km", "retencion_huff"]
    if not ids:
        return pd.DataFrame(columns=cols, index=pd.Index([], name="sede_id"))

    D = datos.distancias.loc[ids, ids]
    Dm = D.to_numpy(float).copy()
    np.fill_diagonal(Dm, np.inf)
    out = pd.DataFrame(index=pd.Index(ids, name="sede_id"))
    out["cluster_espacial"] = clusters_espaciales(datos, ids)
    out["tam_cluster"] = out.groupby("cluster_espacial")["cluster_espacial"].transform("size")
    out.loc[out["cluster_espacial"] == "AISLADA", "tam_cluster"] = 1
    out["dist_vecino_km"] = Dm.min(axis=1)
    out["vecino_mas_cercano"] = [ids[j] for j in Dm.argmin(axis=1)]
    out[f"vecinos_{r:g}km"] = (Dm <= r).sum(axis=1)
    dec = datos.sedes["cierre_decidido"] if "cierre_decidido" in datos.sedes.columns else pd.Series(False, index=datos.sedes.index)
    receptoras = [s for s in ids if not bool(dec.get(s, False))]
    red = huff.redundancia(demanda_anual.reindex(ids).fillna(0.0), D, cfg, universo=ids, receptoras=receptoras)
    return out.join(red)
