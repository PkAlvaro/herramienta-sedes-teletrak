"""Familias de sedes: grupos que comparten caracteristicas (clustering jerarquico de Ward).

Componentes (cada uno pesa lo mismo en la vista "completa", sin importar cuantas variables tenga):
- geografico: posicion en km
- comercial:  tamano, mix de hipodromos, tendencia, volatilidad, estacionalidad
- economico:  margen sobre ingresos, peso del arriendo

Para cada vista se entrega: asignacion para k = 2..8, silhouette por k, k sugerido,
estabilidad por sede (remuestreo) y el dendrograma para dibujarlo.
"""
import numpy as np
import pandas as pd

COMPONENTES = {
    "geografico": ["x_km", "y_km"],
    "comercial": ["log_venta", "mix_HCH", "mix_CHS", "mix_VSC", "mix_CHC", "crecimiento_anual_pct", "volatilidad", "estacionalidad"],
    "economico": ["margen_sobre_ingresos", "arriendo_sobre_venta"],
}
VISTAS = {"geografica": ["geografico"], "comercial": ["comercial"], "economica": ["economico"],
          "completa": ["geografico", "comercial", "economico"]}
ETIQUETAS = {"x_km": "posición este-oeste", "y_km": "posición norte-sur", "log_venta": "venta", "mix_HCH": "peso HCH",
             "mix_CHS": "peso CHS", "mix_VSC": "peso VSC", "mix_CHC": "peso CHC", "crecimiento_anual_pct": "crecimiento",
             "volatilidad": "volatilidad", "estacionalidad": "estacionalidad", "margen_sobre_ingresos": "margen",
             "arriendo_sobre_venta": "peso del arriendo"}


def variables(ficha, historico):
    """Tabla de variables por sede fisica vigente (indice sede_id)."""
    f = ficha[(ficha["grupo"] != "DIGITAL") & ficha["lat"].notna()].copy()
    lat0 = f["lat"].mean()
    X = pd.DataFrame(index=f.index)
    X["x_km"] = (f["lon"] - f["lon"].mean()) * 111.32 * np.cos(np.radians(lat0))
    X["y_km"] = (f["lat"] - lat0) * 110.57
    X["log_venta"] = np.log1p(f["venta_12m_real"].clip(lower=0))
    for h in ("HCH", "CHS", "VSC", "CHC"):
        X[f"mix_{h}"] = f.get(f"mix_{h}")
    X["crecimiento_anual_pct"] = f["crecimiento_anual_pct"]
    X["volatilidad"] = f["volatilidad"]
    # estacionalidad: amplitud del perfil mensual promedio (ultimos 36 meses)
    h = historico[historico["sede_id"].isin(f.index)].copy()
    h["mes"] = pd.to_datetime(h["mes"])
    h = h[h["mes"] > h["mes"].max() - pd.DateOffset(months=36)]
    perfil = h.groupby(["sede_id", h["mes"].dt.month])["venta_real"].mean().unstack()
    perfil = perfil.div(perfil.mean(axis=1), axis=0)
    X["estacionalidad"] = (perfil.max(axis=1) - perfil.min(axis=1)).reindex(X.index)
    ing = f.get("ingresos_hoja")
    X["margen_sobre_ingresos"] = (f["margen_hoja"] / ing.where(ing > 0)) if ing is not None and "margen_hoja" in f else np.nan
    venta = f["venta_12m_real"].where(f["venta_12m_real"] > 0)
    X["arriendo_sobre_venta"] = f["arriendo_mensual_clp"] * 12 / venta if "arriendo_mensual_clp" in f else np.nan
    return X


def _matriz(X, componentes):
    bloques = []
    usadas = []
    for comp in componentes:
        cols = [c for c in COMPONENTES[comp] if c in X.columns and X[c].notna().sum() >= max(3, len(X) // 2)]
        if not cols:
            continue
        B = X[cols].astype(float).replace([np.inf, -np.inf], np.nan)
        B = B.fillna(B.median())
        if comp == "geografico":       # misma escala en ambos ejes: se estandariza por la dispersion total
            B = (B - B.mean()) / (np.sqrt((B.var(ddof=0)).sum()) or 1)
            B = B * np.sqrt(len(cols))
        else:
            B = (B - B.mean()) / B.std(ddof=0).replace(0, 1)
        bloques.append(B / np.sqrt(len(cols)))   # cada componente aporta la misma varianza total
        usadas += cols
    return (pd.concat(bloques, axis=1) if bloques else pd.DataFrame(index=X.index)), usadas


def _estabilidad(Z, k, n=200, frac=0.8, semilla=42):
    """Para cada sede: % de remuestreos en que sigue con los mismos companeros de familia."""
    from scipy.cluster.hierarchy import fcluster, linkage
    rng = np.random.default_rng(semilla)
    m = len(Z)
    base = fcluster(linkage(Z, "ward"), k, "maxclust")
    junto = np.zeros((m, m)); visto = np.zeros((m, m))
    for _ in range(n):
        idx = np.sort(rng.choice(m, int(frac * m), replace=False))
        lab = fcluster(linkage(Z[idx], "ward"), k, "maxclust")
        igual = lab[:, None] == lab[None, :]
        junto[np.ix_(idx, idx)] += igual
        visto[np.ix_(idx, idx)] += 1
    co = np.divide(junto, visto, out=np.zeros_like(junto), where=visto > 0)
    est = []
    for i in range(m):
        pares = (base == base[i]) & (np.arange(m) != i)
        est.append(float(co[i, pares].mean()) if pares.any() else 1.0)
    return np.array(est)


def familias(X, ks=range(2, 9), semilla=42):
    """Resultado por vista: {vista: {...}}. Todo en tipos simples para JSON."""
    from scipy.cluster.hierarchy import dendrogram, fcluster, linkage
    from sklearn.metrics import silhouette_score
    out = {}
    for vista, comps in VISTAS.items():
        M, usadas = _matriz(X, comps)
        if M.shape[1] == 0 or len(M) < 6:
            continue
        Z = M.to_numpy()
        L = linkage(Z, "ward")
        asign, sil = {}, {}
        for k in ks:
            if k >= len(M):
                break
            lab = fcluster(L, k, "maxclust")
            asign[k] = lab
            sil[k] = float(silhouette_score(Z, lab)) if len(set(lab)) > 1 else np.nan
        k_sug = max(sil, key=lambda k: (np.nan_to_num(sil[k], nan=-1), -k))
        est = _estabilidad(Z, k_sug, semilla=semilla)
        dn = dendrogram(L, no_plot=True, labels=list(M.index))
        perfiles = {}
        for k, lab in asign.items():
            perf = []
            for fam in sorted(set(lab)):
                miembros = M.index[lab == fam]
                zc = M.loc[miembros].mean()
                rasgos = [f"{'alta' if zc[c] > 0 else 'baja'} {ETIQUETAS.get(c, c)}" if c not in ("x_km", "y_km")
                          else ("más al " + ("este" if zc[c] > 0 else "oeste") if c == "x_km" else "más al " + ("norte" if zc[c] > 0 else "sur"))
                          for c in zc.abs().sort_values(ascending=False).index[:3] if abs(zc[c]) > 0.35]
                perf.append({"familia": int(fam), "n": int(len(miembros)), "rasgos": ", ".join(rasgos) or "perfil promedio",
                             **{c: float(X.loc[miembros, c].median()) for c in usadas if c in X.columns}})
            perfiles[k] = perf
        out[vista] = {
            "variables": usadas, "ids": list(M.index), "k_sugerido": int(k_sug),
            "silhouette": {int(k): v for k, v in sil.items()},
            "asignacion": {int(k): [int(x) for x in v] for k, v in asign.items()},
            "perfiles": {int(k): v for k, v in perfiles.items()},
            "estabilidad": [round(float(e), 3) for e in est],
            "dendrograma": {"icoord": dn["icoord"], "dcoord": dn["dcoord"], "hojas": dn["ivl"]},
        }
    return out
