"""Economia por sede: margen, equilibrio, riesgo de perdida y valor de cerrar.

Misma logica que evaluar_economia_local en modelo_demanda.py, pero la retencion
al cerrar sale de Huff (sede por sede) en vez de un porcentaje unico.
Incluye evaluar_estocastico() para simular la distribucion de VAN y riesgo de cierre.
"""
import numpy as np
import pandas as pd

from .config import HIPODROMOS


def _rpert(a, m, b, size, rng):
    """Muestreo de distribucion PERT a traves de Beta escalada."""
    a, m, b = float(a), float(m), float(b)
    if b - a < 1e-7 or m <= a or m >= b:
        return np.full((size, 1), m)
    alpha = 1.0 + 4.0 * (m - a) / (b - a)
    beta = 1.0 + 4.0 * (b - m) / (b - a)
    return (a + (b - a) * rng.beta(alpha, beta, size=size)).reshape(size, 1)


def _meses_salida(contrato_str):
    """Determina (min, moda, max) meses de salida segun vencimiento de contrato."""
    term = str(contrato_str or "").lower().strip()
    if "2030" in term:
        return 6.0, 12.0, 18.0
    elif "2028" in term or "2029" in term:
        return 4.0, 8.0, 14.0
    elif "2027" in term:
        return 3.0, 6.0, 9.0
    elif "inmediato" in term or "vencido" in term:
        return 0.5, 1.0, 1.5
    elif "indefinido" in term or "sin fecha" in term or not term or term == "none":
        return 1.0, 2.0, 3.0
    else:
        return 1.5, 3.0, 6.0


def tasa_margen_mix(metricas, cfg):
    """Takeout ponderado por el mix de hipodromos de los ultimos 12 meses."""
    tasas = cfg["tasas_hipodromo"]
    glob = cfg["tasa_margen_global"]
    cols = [f"mix_{h}" for h in HIPODROMOS] + ["mix_OTRO"]
    mix = metricas.reindex(columns=cols)
    t = sum(mix[f"mix_{h}"].fillna(0) * tasas.get(h, glob) for h in HIPODROMOS) + mix["mix_OTRO"].fillna(0) * glob
    return t.where(mix.sum(axis=1) > 0, glob)


def evaluar(datos, demanda, redund=None):
    """Tabla por sede y ano. redund: salida de huff.redundancia (opcional)."""
    cfg = datos.config
    sedes = datos.sedes
    tasa = tasa_margen_mix(demanda.metricas, cfg)
    filas = []
    for sid, sim in demanda.sim_anual.items():
        arr = sedes.at[sid, "arriendo_mensual_clp"]
        if pd.isna(arr):
            continue
        fijos = arr * 12 + np.nan_to_num(sedes.at[sid, "otros_fijos_anual_clp"])
        t = float(tasa.get(sid, cfg["tasa_margen_global"]))
        eq = fijos / t
        ret_red = float(redund.at[sid, "retencion_huff"]) if redund is not None and sid in redund.index else 0.0
        # Lo que no retiene la red fisica, una parte migra al canal digital propio
        ret_total = ret_red + (1 - ret_red) * cfg["tasa_retencion_digital"]
        for k, ano in enumerate(demanda.anos):
            v = sim[k]
            p50 = float(np.percentile(v, 50))
            margen_bruto = p50 * t
            filas.append({
                "sede_id": sid, "ano": ano, "venta_p50_real": p50, "tasa_margen": t,
                "costos_fijos": fijos, "venta_equilibrio": eq,
                "holgura_equilibrio": p50 / eq - 1 if eq > 0 else np.nan,   # sin costos fijos no hay equilibrio
                "margen_contribucion_p50": margen_bruto - fijos,
                "prob_perdida": float(np.mean(v * t < fijos)),
                "retencion_total": ret_total,
                # > 0: cerrar mejora el EBITDA de la red
                "delta_ebitda_cierre": fijos - margen_bruto * (1 - ret_total),
                "costo_cierre": np.nan_to_num(sedes.at[sid, "costo_cierre_clp"]),
            })
    return pd.DataFrame(filas)


def evaluar_estocastico(datos, demanda, redund=None, ficha_censo=None, n_sim=2000, horizonte=5):
    """Evaluacion estocastica Monte Carlo por sede fisica vigente (motor de Ruben).

    La herramienta usa estos parametros por sede en su modelo de VAN (capa_datos.js: baseCierre y sorteosSede):
    md_moda (migracion digital segun la friccion del Censo), vol_local (volatilidad de la venta) y
    meses_salida_min/moda/max (costo de salir del contrato antes de su vencimiento). La retencion Top-3 y red
    completa con tope de capacidad la recalcula la herramienta con las sedes abiertas en cada fecha del plan.

    Precalcula parametros estructurales e indicadores de riesgo VAN:
    van_mantener_p50, delta_van_p10, delta_van_p50, delta_van_p90,
    prob_exito_cierre, cvar_5, retencion_breakeven, retencion_esperada, clasificacion_sim.
    """
    cfg = datos.config
    sedes = datos.sedes
    tasa = tasa_margen_mix(demanda.metricas, cfg)
    semilla = int(cfg.get("semilla", 42))
    rng = np.random.default_rng(semilla)
    T = horizonte

    # Escenarios macro acoplados
    delta_pi_costos = rng.triangular(0.00, 0.010, 0.025, size=(n_sim, 1))
    r_real = rng.triangular(0.060, 0.0713, 0.085, size=(n_sim, 1))
    anos_idx = np.arange(1, T + 1).reshape(1, T)
    factores_descuento = 1.0 / np.power(1.0 + r_real, anos_idx)
    crec_costos_reales = np.power(1.0 + delta_pi_costos, anos_idx)
    phi = rng.uniform(0.90, 0.98, size=(n_sim, 1))
    phi_potencias = np.power(phi, np.arange(0, T).reshape(1, T))
    factor_costo_online = rng.triangular(0.10, 0.15, 0.30, size=(n_sim, 1))

    # Identificar sedes fisicas vigentes
    filas = []
    fisicas = [s for s in datos.ids_vigentes if s in sedes.index and sedes.at[s, "grupo"] != "DIGITAL"]

    for sid in fisicas:
        arr_m = float(sedes.at[sid, "arriendo_mensual_clp"]) if pd.notna(sedes.at[sid, "arriendo_mensual_clp"]) else 0.0
        arriendo_anual = arr_m * 12.0
        otros_fijos = float(np.nan_to_num(sedes.at[sid, "otros_fijos_anual_clp"]))
        costos_fijos_total = arriendo_anual + otros_fijos
        costo_cierre_clp = float(np.nan_to_num(sedes.at[sid, "costo_cierre_clp"]))
        tau = float(tasa.get(sid, cfg["tasa_margen_global"]))

        # Venta base real
        if sid in demanda.metricas.index and pd.notna(demanda.metricas.at[sid, "venta_12m_real"]):
            v0 = float(demanda.metricas.at[sid, "venta_12m_real"])
        elif sid in demanda.sim_anual and len(demanda.sim_anual[sid]):
            v0 = float(np.mean(demanda.sim_anual[sid][0]))
        else:
            v0 = 100e6

        # Parametros Huff (Top-3 y Red Completa)
        mf_full = float(redund.at[sid, "retencion_huff"]) if redund is not None and sid in redund.index and pd.notna(redund.at[sid, "retencion_huff"]) else 0.35
        if redund is not None and sid in redund.index and "retencion_huff_top3" in redund.columns and pd.notna(redund.at[sid, "retencion_huff_top3"]):
            mf_top3 = float(redund.at[sid, "retencion_huff_top3"])
        else:
            mf_top3 = mf_full * 0.85
        mf_full = max(mf_top3, min(1.0, mf_full))
        mf_min = 0.60 * mf_top3

        # Friccion digital del Censo 2024
        friccion_dig = 50.0
        if ficha_censo is not None and sid in ficha_censo.index:
            r_cen = ficha_censo.loc[sid]
            pct_h = r_cen.get("pct_hombres_50_mas")
            esc = r_cen.get("escolaridad_50_mas")
            if pd.notna(pct_h) and pd.notna(esc):
                z_edad = np.clip((float(pct_h) - 0.10) / (0.24 - 0.10), 0.0, 1.0)
                z_esc = np.clip((14.5 - float(esc)) / (14.5 - 6.5), 0.0, 1.0)
                friccion_dig = float(np.round(50.0 * (z_edad + z_esc), 1))
        md_moda = float(np.clip(0.10 * (1.0 - 0.4 * (friccion_dig - 50.0) / 50.0), 0.04, 0.16))
        md_min = 0.03
        md_max = 0.18

        # Crecimiento de demanda empirico y volatilidad
        if sid in demanda.metricas.index and pd.notna(demanda.metricas.at[sid, "crecimiento_anual_pct"]):
            g_base = float(np.clip(demanda.metricas.at[sid, "crecimiento_anual_pct"] / 100.0, -0.15, 0.07))
        else:
            g_base = 0.0
        if sid in demanda.metricas.index and pd.notna(demanda.metricas.at[sid, "volatilidad"]):
            vol_local = float(np.clip(demanda.metricas.at[sid, "volatilidad"], 0.04, 0.25))
        else:
            vol_local = 0.10

        # Meses de salida contractual
        termino = sedes.at[sid, "vencimiento_contrato"] if "vencimiento_contrato" in sedes.columns else ""
        if pd.isna(termino) and "status" in sedes.columns:
            termino = sedes.at[sid, "status"]
        m_min, m_moda, m_max = _meses_salida(termino)

        # Muestreo estocastico por sede
        mf_sim = _rpert(mf_min, mf_top3, mf_full, n_sim, rng)
        md_sim = _rpert(md_min, md_moda, md_max, n_sim, rng)
        ret_tot_sim = mf_sim + (1.0 - mf_sim) * md_sim

        g_base_sim = np.clip(rng.normal(g_base, 0.025, size=(n_sim, 1)), -0.15, 0.07)
        g_anual = g_base_sim * phi_potencias
        eps = rng.normal(0.0, vol_local, size=(n_sim, T))
        tasas_crec = np.clip(1.0 + g_anual + eps, 0.20, 2.0)
        vta_trayectoria = v0 * np.cumprod(tasas_crec, axis=1)
        cf_trayectoria = costos_fijos_total * crec_costos_reales

        meses_salida = rng.triangular(m_min, m_moda, m_max, size=(n_sim, 1))
        costo_salida = np.maximum(costo_cierre_clp, meses_salida * arr_m)

        fc_mantener = tau * vta_trayectoria - cf_trayectoria
        fc_cerrar_fisico = tau * vta_trayectoria * mf_sim
        fc_cerrar_digital = tau * (1.0 - factor_costo_online) * vta_trayectoria * (1.0 - mf_sim) * md_sim
        fc_cerrar = fc_cerrar_fisico + fc_cerrar_digital

        van_mantener = np.sum(fc_mantener * factores_descuento, axis=1)
        van_cerrar = -costo_salida.flatten() + np.sum(fc_cerrar * factores_descuento, axis=1)
        delta_van = van_cerrar - van_mantener

        # Estadisticos
        van_mantener_p50 = float(np.percentile(van_mantener, 50))
        delta_van_media = float(np.mean(delta_van))
        delta_van_p50 = float(np.percentile(delta_van, 50))
        delta_van_p10 = float(np.percentile(delta_van, 10))
        delta_van_p90 = float(np.percentile(delta_van, 90))
        prob_exito = float(np.mean(delta_van > 0.0))
        cvar_5 = float(np.mean(delta_van[delta_van <= np.percentile(delta_van, 5)]))
        retencion_esperada = float(np.mean(ret_tot_sim))

        # Retencion de equilibrio breakeven
        anos_lin = np.arange(1, T + 1)
        vp_cf_central = np.sum(costos_fijos_total * np.power(1.01, anos_lin) * np.power(1.0713, -anos_lin))
        vp_vta_central = np.sum(v0 * np.power(1.0 + g_base, anos_lin) * np.power(1.0713, -anos_lin))
        costo_sal_central = max(costo_cierre_clp, m_moda * arr_m)
        ahorro_neto = vp_cf_central - costo_sal_central
        if vp_vta_central > 0 and ahorro_neto > 0:
            ret_be = max(0.0, min(1.0, 1.0 - (ahorro_neto / (tau * vp_vta_central))))
        elif ahorro_neto <= 0:
            ret_be = 1.0
        else:
            ret_be = 0.0

        # Clasificacion estrategica
        if delta_van_p10 > 0.0:
            clasificacion = "FASE 1: CERRAR"
        elif delta_van_p50 > 0.0:
            clasificacion = "FASE 2: ZONA GRIS"
        else:
            clasificacion = "MANTENER / HUB"

        nombre = sedes.at[sid, "nombre"] if "nombre" in sedes.columns else sid
        grupo = sedes.at[sid, "grupo"] if "grupo" in sedes.columns else "RM"
        comuna = sedes.at[sid, "comuna"] if "comuna" in sedes.columns else ""

        filas.append({
            "sede_id": sid,
            "nombre": str(nombre),
            "grupo": str(grupo),
            "comuna": str(comuna),
            "venta_base_real": v0,
            "tasa_margen": tau,
            "arriendo_anual": arriendo_anual,
            "otros_fijos_anual": otros_fijos,
            "costos_fijos_anual": costos_fijos_total,
            "costo_cierre_clp": costo_cierre_clp,
            "mf_min": mf_min,
            "mf_top3": mf_top3,
            "mf_full": mf_full,
            "friccion_digital": friccion_dig,
            "md_moda": md_moda,
            "md_min": md_min,
            "md_max": md_max,
            "g_base": g_base,
            "vol_local": vol_local,
            "meses_salida_min": m_min,
            "meses_salida_moda": m_moda,
            "meses_salida_max": m_max,
            "van_mantener_p50": van_mantener_p50,
            "delta_van_p10": delta_van_p10,
            "delta_van_p50": delta_van_p50,
            "delta_van_p90": delta_van_p90,
            "delta_van_media": delta_van_media,
            "prob_exito_cierre": prob_exito,
            "cvar_5": cvar_5,
            "retencion_breakeven": ret_be,
            "retencion_esperada": retencion_esperada,
            "clasificacion_sim": clasificacion,
        })

    return pd.DataFrame(filas)
