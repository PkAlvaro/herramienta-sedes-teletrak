"""Modelo gravitacional de Huff para redistribuir la demanda de sedes cerradas.

Formula igual al dashboard de R. Malis (Dashboard_Demanda_Huff_Teletrak.html):

    P(i->j) = A_j * d_ij^-lambda / ( sum_k A_k * d_ik^-lambda + U0 )
    fuga_i  = U0 / ( sum_k A_k * d_ik^-lambda + U0 )

A_j es el atractivo de la sede receptora (ver atractivo_desde_demanda) y U0
la alternativa externa (canal digital o abandono). Agrega cierres
secuenciales con cascada y una medida de redundancia por sede.
"""
import numpy as np
import pandas as pd


def _params(cfg, lam, u0):
    return (cfg["huff_lambda"] if lam is None else lam,
            cfg["huff_u0"] if u0 is None else u0,
            cfg["huff_dist_min_km"])


def atractivo_desde_demanda(demanda_clp, cfg):
    """Venta anual en pesos -> atractivo A_j.

    'relativo' (defecto): A_j = venta_j / venta promedio. U0 queda en las mismas
    unidades que una sede promedio y su efecto no depende de la escala de ventas.
    'mm_clp': A_j en MM CLP con piso 1, identico al dashboard original.
    """
    d = pd.Series(demanda_clp, dtype=float)
    if cfg["huff_atractivo"] == "mm_clp":
        return (d / 1e6).clip(lower=1.0)
    media = d[d > 0].mean()
    return (d / media).clip(lower=1e-3) if media > 0 else d * 0 + 1.0


def probabilidades(dist, atractivo, cerradas, abiertas, cfg, lam=None, u0=None):
    """Devuelve (P, fuga): P[i, j] para i cerrada y j abierta, fuga[i] la parte que sale de la red."""
    lam, u0, dmin = _params(cfg, lam, u0)
    cerradas, abiertas = list(cerradas), list(abiertas)
    d = np.maximum(dist.loc[cerradas, abiertas].to_numpy(float), dmin)
    s = atractivo.reindex(abiertas).fillna(1.0).to_numpy(float)[None, :] * d ** (-lam)
    denom = s.sum(axis=1, keepdims=True) + u0
    P = pd.DataFrame(s / denom, index=cerradas, columns=abiertas)
    fuga = pd.Series(u0 / denom[:, 0], index=cerradas)
    return P, fuga


def redistribuir(demanda, cerradas, dist, cfg, atractivo=None, lam=None, u0=None, universo=None):
    """Cierre simultaneo. demanda: Series sede -> venta. Devuelve dict con nueva demanda, flujos y fuga."""
    universo = list(universo if universo is not None else dist.index)
    cerradas = [c for c in cerradas if c in universo]
    abiertas = [s for s in universo if s not in set(cerradas)]
    atractivo = atractivo if atractivo is not None else atractivo_desde_demanda(demanda, cfg)
    dem = demanda.reindex(universo).fillna(0.0)
    nueva = dem.copy()
    nueva[cerradas] = 0.0
    if not cerradas:
        return {"nueva": nueva, "flujos": pd.DataFrame(), "fuga": 0.0, "fuga_por_sede": pd.Series(dtype=float)}
    P, fuga = probabilidades(dist, atractivo, cerradas, abiertas, cfg, lam, u0)
    flujos = P.mul(dem[cerradas], axis=0)
    nueva[abiertas] += flujos.sum(axis=0)
    return {"nueva": nueva, "flujos": flujos, "fuga": float((fuga * dem[cerradas]).sum()),
            "fuga_por_sede": fuga}


def cascada(demanda, etapas, dist, cfg, atractivo=None, actualizar_atractivo=False,
            lam=None, u0=None, universo=None):
    """Cierres secuenciales. etapas: lista de listas de sedes que cierran juntas en cada paso.

    La demanda capturada en una etapa se vuelve a repartir si la receptora cierra despues.
    Con actualizar_atractivo=True las receptoras ganan atractivo al crecer.
    """
    universo = list(universo if universo is not None else dist.index)
    dem = demanda.reindex(universo).fillna(0.0).astype(float)
    base_total = float(dem.sum())
    atr = (atractivo if atractivo is not None else atractivo_desde_demanda(dem, cfg)).copy()
    cerradas_acum, filas = [], []
    for n, etapa in enumerate(etapas, start=1):
        etapa = [s for s in etapa if s in universo and s not in cerradas_acum]
        abiertas = [s for s in universo if s not in set(cerradas_acum) | set(etapa)]
        r = redistribuir(dem, etapa, dist, cfg, atractivo=atr, lam=lam, u0=u0,
                         universo=[s for s in universo if s not in cerradas_acum])
        for s in etapa:
            principal = r["flujos"].loc[s].idxmax() if abiertas and len(r["flujos"]) else None
            filas.append({"etapa": n, "sede_id": s, "demanda_al_cerrar": dem[s],
                          "retenida": dem[s] * (1 - r["fuga_por_sede"].get(s, 1.0)),
                          "fuga": dem[s] * r["fuga_por_sede"].get(s, 1.0),
                          "receptora_principal": principal,
                          "parte_receptora_principal": r["flujos"].loc[s, principal] / dem[s] if principal and dem[s] > 0 else np.nan})
        dem = r["nueva"].reindex(universo).fillna(0.0)
        if actualizar_atractivo:
            atr = atractivo_desde_demanda(dem, cfg)
        cerradas_acum += etapa
    detalle = pd.DataFrame(filas)
    return {"detalle": detalle, "demanda_final": dem,
            "retencion_red": float(dem.sum() / base_total) if base_total else np.nan}


def redundancia(demanda, dist, cfg, atractivo=None, lam=None, u0=None, universo=None, receptoras=None):
    """Para cada sede: que pasa si cierra sola. Mide cuanto la cubre el resto de la red.

    receptoras: sedes que pueden recibir demanda (por defecto todo el universo). Se excluyen
    las que ya tienen cierre decidido: no sirven de respaldo.
    """
    universo = list(universo if universo is not None else dist.index)
    receptoras = list(receptoras if receptoras is not None else universo)
    atractivo = atractivo if atractivo is not None else atractivo_desde_demanda(demanda.reindex(universo).fillna(0), cfg)
    filas = []
    for s in universo:
        abiertas = [x for x in receptoras if x != s]
        P, fuga = probabilidades(dist, atractivo, [s], abiertas, cfg, lam, u0)
        p = P.iloc[0]
        top = p.sort_values(ascending=False)
        top3_sum = float(top.iloc[:3].sum()) if len(top) else 0.0
        top3_denom = top3_sum + float(fuga[s])
        ret_top3 = float(top3_sum / top3_denom) if top3_denom > 0 else 0.0
        filas.append({"sede_id": s,
                      "retencion_huff": 1 - fuga[s],
                      "retencion_huff_top3": min(ret_top3, 1 - fuga[s]),
                      "receptora_principal": top.index[0] if len(top) else None,
                      "parte_receptora_principal": top.iloc[0] if len(top) else np.nan,
                      # receptoras efectivas: 1 / sum(p_j^2) sobre la parte retenida (indice de concentracion)
                      "receptoras_efectivas": 1 / ((p / p.sum()) ** 2).sum() if p.sum() > 0 else 0.0})
    return pd.DataFrame(filas).set_index("sede_id")


def calibrar_u0(demanda, dist, cfg, retencion_objetivo, lam=None, universo=None, tol=1e-4):
    """U0 tal que la retencion promedio (ponderada por demanda) de cierres individuales sea la objetivo.

    Sirve para anclar U0 a un dato observado (por ejemplo la retencion medida en cierres pasados)
    en vez de dejarlo como una constante cuyo efecto depende de la escala de A.
    """
    universo = list(universo if universo is not None else dist.index)
    dem = demanda.reindex(universo).fillna(0.0)
    peso = dem / dem.sum()

    def ret(u0):
        return float((redundancia(dem, dist, cfg, lam=lam, u0=u0, universo=universo)["retencion_huff"] * peso).sum())

    lo, hi = 1e-9, 1.0
    while ret(hi) > retencion_objetivo and hi < 1e12:
        hi *= 10
    for _ in range(200):
        mid = np.sqrt(lo * hi)
        if ret(mid) > retencion_objetivo:
            lo = mid
        else:
            hi = mid
        if hi / lo < 1 + tol:
            break
    return float(np.sqrt(lo * hi))
