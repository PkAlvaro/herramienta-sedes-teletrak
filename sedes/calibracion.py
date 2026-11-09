"""Calibracion de U0 (y lambda) de Huff con los cierres historicos del propio cliente.

Para cada sede que cerro dentro de VTA HIST (estudio de evento):
- perdida: venta real mensual promedio de la sede en los 6 meses previos al cierre
- captura observada de las (hasta 6) sedes mas cercanas: venta post - venta esperada, donde la
  esperada = venta pre x crecimiento de la red lejana (control comun) x tendencia propia de la
  sede en los mismos meses del ano anterior (diferencia en diferencias)
- retencion observada = suma de capturas cercanas / perdida
- retencion predicha por Huff con la red de ese momento (atractivo = venta pre de cada sede)

U0 se elige para que la retencion predicha calce con la observada (error absoluto ponderado por perdida), solo con los
cierres de retencion observada creible (0% a 100%). Con 6 o mas de esos eventos tambien se busca lambda en una grilla.
"""
import numpy as np
import pandas as pd

from . import huff

COVID = (pd.Timestamp("2020-02-01"), pd.Timestamp("2021-06-01"))


def eventos_cierre(datos, hist, corte, ventana=6, radio_km=10.0, max_vecinas=6):
    """Tabla de cierres historicos utilizables con su retencion observada."""
    cfg = datos.config
    s = datos.sedes
    D = datos.distancias
    ok = hist[(hist["jornadas"] >= cfg["min_jornadas_mes"]) & (hist["venta_real"] > 0)]
    ult = ok.groupby("sede_id")["mes"].max()
    n_meses = ok.groupby("sede_id")["mes"].nunique()
    piv = ok.pivot_table(index="mes", columns="sede_id", values="venta_real", aggfunc="sum")
    filas = []
    for sid, m_ult in ult.items():
        m0 = m_ult + pd.DateOffset(months=1)                     # primer mes sin venta
        pre = pd.date_range(m0 - pd.DateOffset(months=ventana + 1), periods=ventana, freq="MS")   # se salta el mes del cierre
        post = pd.date_range(m0 + pd.DateOffset(months=1), periods=ventana, freq="MS")
        if post[-1] > corte or n_meses.get(sid, 0) < 12 or sid not in D.index or s.at[sid, "grupo"] == "DIGITAL":
            continue
        if pre[0] <= COVID[1] and post[-1] >= COVID[0]:
            continue
        activas = [c for c in piv.columns if c != sid and c in D.index
                   and piv[c].reindex(pre).notna().all() and piv[c].reindex(post).notna().all()]
        if len(activas) < 3:
            continue
        perdida = float(piv[sid].reindex(pre).mean())
        mpre = piv[activas].reindex(pre).mean()
        mpost = piv[activas].reindex(post).mean()
        # Mismos meses un ano antes: tendencia propia de cada sede (diferencia en diferencias)
        pre_ant, post_ant = pre - pd.DateOffset(years=1), post - pd.DateOffset(years=1)
        mpre_ant = piv[activas].reindex(pre_ant).mean()
        mpost_ant = piv[activas].reindex(post_ant).mean()
        d = D.loc[sid, activas]
        cerca = d[d <= radio_km].nsmallest(max_vecinas).index
        if len(cerca) == 0:
            continue
        control = d.index.difference(d.nsmallest(max(10, 2 * max_vecinas)).index)
        if len(control) < 3:
            control = d.index.difference(cerca)
        g = float(mpost[control].sum() / mpre[control].sum())
        # crecimiento propio pre->post del ano anterior, relativo al del control en esos mismos meses
        g_ant_ctrl = float(mpost_ant[control].sum() / mpre_ant[control].sum()) if mpre_ant[control].notna().all() else 1.0
        propio = (mpost_ant[cerca] / mpre_ant[cerca] / g_ant_ctrl).where(lambda x: x.notna() & np.isfinite(x), 1.0).clip(0.7, 1.3)
        esperado = g * mpre[cerca] * propio
        captura = (mpost[cerca] - esperado).sum()
        filas.append({"sede_id": sid, "nombre": s.at[sid, "nombre"] if "nombre" in s.columns else sid,
                      "ubicacion": s.at[sid, "calidad_ubicacion"] if "calidad_ubicacion" in s.columns else None,
                      "mes_cierre": m0, "venta_perdida_mes": perdida, "sedes_cercanas": len(cerca),
                      "crecimiento_control": g, "captura_mes": float(captura),
                      "retencion_observada": float(captura / perdida) if perdida > 0 else np.nan,
                      "_activas": activas, "_mpre": mpre})
    return filas


def _predicha(ev, D, cfg, lam, u0):
    act = ev["_activas"]
    dem = pd.concat([ev["_mpre"], pd.Series({ev["sede_id"]: ev["venta_perdida_mes"]})])
    univ = act + [ev["sede_id"]]
    A = huff.atractivo_desde_demanda(dem.reindex(univ), cfg)
    _, fuga = huff.probabilidades(D, A, [ev["sede_id"]], act, cfg, lam=lam, u0=u0)
    return 1 - float(fuga.iloc[0])


U0_RAZONABLE = (0.01, 10.0)


def calibrar(datos, hist, corte, lambdas=(2.0, 3.0, 4.0, 5.0, 6.0), min_eventos=3):
    """Devuelve dict con eventos (DataFrame), u0, lambda, estado y error."""
    from scipy.optimize import minimize_scalar
    cfg = datos.config
    evs = eventos_cierre(datos, hist, corte)
    base = {"u0": cfg["huff_u0"], "lambda": cfg["huff_lambda"], "n_eventos": len(evs)}
    tabla = pd.DataFrame([{k: v for k, v in e.items() if not k.startswith("_")} for e in evs])
    if len(evs) < min_eventos:
        return {**base, "estado": "SIN CALIBRAR", "motivo": f"{len(evs)} cierres historicos utilizables (se necesitan {min_eventos})", "eventos": tabla}
    # Robusto: solo cierres con retencion observada creible (0% a 100%); los demas reflejan otros movimientos de la red
    # en esos meses (aperturas, cierres simultaneos, ubicacion aproximada) y distorsionan el ajuste
    obs_todos = np.array([e["retencion_observada"] for e in evs], dtype=float)
    ok = np.isfinite(obs_todos) & (obs_todos >= 0.0) & (obs_todos <= 1.0)
    tabla["usado_en_calibracion"] = ok
    excluidos = int((~ok).sum())
    if ok.sum() < min_eventos:
        return {**base, "estado": "SIN CALIBRAR", "eventos": tabla,
                "motivo": f"{int(ok.sum())} de {len(evs)} cierres históricos con retención creíble (0% a 100%); se necesitan {min_eventos}"}
    if ok.sum() < 0.5 * len(evs):
        return {**base, "estado": "NO CONCLUYENTE", "eventos": tabla, "retencion_observada_media": float(np.median(obs_todos[ok])),
                "motivo": f"solo {int(ok.sum())} de {len(evs)} cierres históricos tienen una retención creíble (0% a 100%): los datos son demasiado "
                          f"ruidosos para calibrar. Se mantienen U0 {base['u0']:g} y lambda {base['lambda']:g}"}
    evs = [e for e, b in zip(evs, ok) if b]
    obs = obs_todos[ok]
    w = np.array([e["venta_perdida_mes"] for e in evs]); w = w / w.sum()
    cand = lambdas if len(evs) >= 6 else (cfg["huff_lambda"],)       # con pocos eventos lambda no se identifica

    def ajuste(lam):
        # error absoluto ponderado (mediana): menos sensible a un evento extremo que el cuadratico
        err = lambda lu: float(np.sum(w * np.abs(np.array([_predicha(e, datos.distancias, cfg, lam, np.exp(lu)) for e in evs]) - obs)))
        r = minimize_scalar(err, bounds=(np.log(1e-4), np.log(1e3)), method="bounded", options={"xatol": 1e-3})
        return float(np.exp(r.x)), r.fun

    mejor = min(((lam, *ajuste(lam)) for lam in cand), key=lambda t: t[2])
    lam, u0, sse = mejor
    tabla.loc[tabla["usado_en_calibracion"], "retencion_huff"] = [_predicha(e, datos.distancias, cfg, lam, u0) for e in evs]
    media_obs = float(np.sum(w * obs))
    # Solo se acepta si el resultado es plausible; si no, se muestran los eventos pero se mantiene la base
    razones = []
    if not (U0_RAZONABLE[0] <= u0 <= U0_RAZONABLE[1]):
        razones.append(f"U0 ajustado {u0:.3g} fuera de rango razonable {U0_RAZONABLE}")
    if media_obs <= 0.02:
        razones.append("retención observada casi nula: puede ser ubicación aproximada de las sedes cerradas o ruido")
    if razones:
        return {**base, "estado": "NO CONCLUYENTE", "motivo": "; ".join(razones) + f". Se mantienen U0 {base['u0']:g} y lambda {base['lambda']:g}",
                "u0_ajustado": u0, "lambda_ajustado": lam, "retencion_observada_media": media_obs, "eventos": tabla}
    return {"u0": u0, "lambda": lam, "n_eventos": len(evs), "estado": "CALIBRADO",
            "motivo": f"{len(evs)} cierres históricos con retención creíble ({excluidos} descartados); error absoluto medio {sse:.1%}" + ("" if len(cand) > 1 else f"; lambda fijo en {lam:g} (pocos eventos)"),
            "retencion_observada_media": media_obs, "eventos": tabla}
