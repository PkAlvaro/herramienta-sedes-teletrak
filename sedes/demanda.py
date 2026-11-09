"""Proyeccion de demanda por sede.

Modelo de pronostico simple integrado (100% lineal en pesos, sin logaritmos):
1. Excluye completamente sedes DIGITALES (grupo == 'DIGITAL' en datos.sedes).
2. Nivel base por sede V_i = suma de venta real de los ultimos 12 meses (T-11 a T).
3. Tendencia por sede g_i: combinacion de tendencia local post-2024 (con filtro MAD + Theil-Sen)
   y tendencia de largo plazo de la red post-2022 (MAD + Theil-Sen), acotada a [-12%, +5%].
4. p50_real plano = V_i (la UI aplica la deriva g_i acumulada en base_ruben.html:961).
   p10_real = V_i * 0.98^y, p90_real = V_i * 1.02^y (bandas planas en torno a p50).
5. Reparto mensual por peso estacional historico (ultimos 36 meses, fallback 1/12).
6. sim_anual generado analiticamente (vectorizado) para calculo instantaneo en economia.py.
"""
import zlib
from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy.stats import theilslopes

from .config import HIPODROMOS, inflacion_ano

INICIO_RED = "2022-01"
INICIO_LOCAL = "2024-01"


@dataclass
class ResultadoDemanda:
    anual: pd.DataFrame          # sede_id, ano, p10/p50/p90 real y nominal, metodo
    mensual: pd.DataFrame        # sede_id, mes, p10/p50/p90 real
    historico: pd.DataFrame      # sede_id, mes, venta_real, jornadas
    metricas: pd.DataFrame       # una fila por sede, insumo de segmentacion
    sim_anual: dict              # sede_id -> array (anos, n_simulaciones) real
    anos: list
    mes_base: pd.Timestamp


# ---------------------------------------------------------------------------
# Preparacion
# ---------------------------------------------------------------------------

def factores_deflactor(ipc, mes_base):
    """Factor que lleva pesos de cada mes a pesos de mes_base."""
    df = ipc.sort_values("mes").copy()
    df["indice"] = (1.0 + df["var_mensual_pct"] / 100.0).cumprod()
    base = df.loc[df["mes"] == mes_base, "indice"]
    if base.empty:
        raise ValueError(f"No hay IPC para el mes base {mes_base.date()}")
    df["factor_real"] = base.iloc[0] / df["indice"]
    return df.set_index("mes")["factor_real"]


def serie_historica(datos):
    """Venta real mensual y jornadas por sede (excluye sedes digitales)."""
    cfg = datos.config
    v = datos.ventas
    corte = pd.Timestamp(cfg["fecha_corte"]) if cfg["fecha_corte"] else v["mes"].max()
    mes_base = pd.Timestamp(cfg["mes_base_real"]) if cfg["mes_base_real"] else corte
    fac = factores_deflactor(datos.ipc, mes_base)

    digitales = set(datos.sedes.loc[datos.sedes["grupo"] == "DIGITAL"].index) if "grupo" in datos.sedes else set()
    m = (v[v["mes"] <= corte]
         .groupby(["sede_id", "mes"])
         .agg(venta_nom=("venta_nominal_clp", "sum"), jornadas=("jornadas", "max"))
         .reset_index())
    m["venta_real"] = m["venta_nom"] * m["mes"].map(fac)
    if digitales:
        m = m[~m["sede_id"].isin(digitales)]
    return m, corte, mes_base


def _serie_z(h, cfg):
    s = h[(h["mes"] >= pd.Timestamp(cfg["inicio_entrenamiento"]))
          & (h["jornadas"] >= cfg["min_jornadas_mes"]) & (h["venta_real"] > 0)]
    if s.empty:
        return pd.Series(dtype=float, index=pd.DatetimeIndex([], freq="MS"))
    r = s["venta_real"] / s["jornadas"]
    r.index = s["mes"]
    return r.asfreq("MS").interpolate(limit_area="inside")


def _semilla(cfg, sede_id):
    return (cfg["semilla"] * 1_000_003 + zlib.crc32(str(sede_id).encode())) % (2**32)


def _filtrar_mad(serie_12m):
    diff = serie_12m.diff().dropna()
    med_d = float(diff.median())
    mad_d = float(np.median(np.abs(diff - med_d)) * 1.4826)
    if mad_d > 0:
        diff_cl = np.clip(diff, med_d - 2.0 * mad_d, med_d + 2.0 * mad_d)
        return float(serie_12m.iloc[0]) + np.cumsum(np.insert(diff_cl.to_numpy(), 0, 0.0))
    return serie_12m.to_numpy()


def calcular_g_red(hist, corte, sedes_digitales=None):
    """Calcula g lineal en pesos de la red fisica post-2022 con filtro MAD + Theil-Sen."""
    ini_vent = max(pd.Timestamp(INICIO_RED), hist["mes"].min())
    meses_vent = pd.date_range(ini_vent, corte, freq="MS")
    dig = sedes_digitales or set()
    conteo = hist[hist["mes"].isin(meses_vent) & (~hist["sede_id"].isin(dig))].groupby("sede_id")["mes"].nunique()
    sedes_comp = conteo[conteo == len(meses_vent)].index

    net_m = hist[hist["sede_id"].isin(sedes_comp) & (hist["mes"] >= ini_vent) & (hist["mes"] <= corte)
                 ].groupby("mes")["venta_real"].sum().sort_index()
    s12 = net_m.rolling(12).sum().dropna()
    validos = s12[s12 > 0]
    if len(validos) >= 2:
        s12_limp = _filtrar_mad(validos)
        t = np.arange(len(s12_limp)) / 12.0
        pend = float(theilslopes(s12_limp, t)[0])
        media = float(np.mean(s12_limp))
        return float(pend / media) if media > 0 else 0.0
    return 0.0


def calcular_tendencias_sedes(hist, corte, todas_sedes, g_red):
    """Calcula g_i por sede combinando local post-2024 filtrado con g_red."""
    ini_loc = max(pd.Timestamp(INICIO_LOCAL), hist["mes"].min())
    meses_loc = pd.date_range(ini_loc, corte, freq="MS")
    dict_g = {}

    for sid in todas_sedes:
        s_sid = hist[(hist["sede_id"] == sid) & (hist["mes"] >= ini_loc) & (hist["mes"] <= corte)
                     ].set_index("mes")["venta_real"].reindex(meses_loc, fill_value=0.0)
        s12 = s_sid.rolling(12).sum().dropna()
        validos = s12[s12 > 0]
        if len(validos) < 4:
            dict_g[sid] = float(np.clip(g_red, -0.12, 0.05))
        else:
            t = np.arange(len(validos)) / 12.0
            s12_limp = _filtrar_mad(validos)
            pend_ts = float(theilslopes(s12_limp, t)[0])
            media_limp = float(np.mean(s12_limp))
            g_filt = float(pend_ts / media_limp) if media_limp > 0 else 0.0
            corr = np.corrcoef(t, s12_limp)[0, 1]
            r2 = float(corr ** 2) if np.isfinite(corr) else 0.0
            w = float(np.clip(0.25 + 0.35 * r2, 0.25, 0.60))
            g_comb = w * g_filt + (1.0 - w) * g_red
            dict_g[sid] = float(np.clip(g_comb, -0.12, 0.05))
    return dict_g


# ---------------------------------------------------------------------------
# API principal
# ---------------------------------------------------------------------------

def proyectar(datos, sedes=None, progreso=None):
    """Proyecta sedes fisicas vigentes con el modelo combinado local + red."""
    cfg = datos.config
    hist, corte, mes_base = serie_historica(datos)
    digitales = set(datos.sedes.loc[datos.sedes["grupo"] == "DIGITAL"].index) if "grupo" in datos.sedes else set()

    g_red = calcular_g_red(hist, corte, digitales)
    anos = list(range(corte.year + 1, corte.year + 1 + cfg["horizonte_anos"]))
    n = int(cfg["n_simulaciones"])

    ids = sedes if sedes is not None else [s for s in datos.ids_vigentes
                                           if s in set(hist["sede_id"]) and s not in digitales]
    dict_g = calcular_tendencias_sedes(hist, corte, ids, g_red)

    filas_a, filas_m, sim_anual = [], [], {}
    z_score = 1.2815515655  # cuantil 90% normal estandar

    for i, sid in enumerate(ids):
        if progreso:
            progreso(i, len(ids), sid)
        hs = hist[hist["sede_id"] == sid]
        if _serie_z(hs, cfg).notna().sum() < 3:
            continue

        # Nivel V_i: suma ultimos 12 meses
        ult12 = hs[(hs["mes"] > corte - pd.DateOffset(months=12)) & (hs["mes"] <= corte)]
        V_i = float(ult12["venta_real"].sum())
        g_i = dict_g[sid]

        # Pesos estacionales mensuales (ultimos 36 meses, fallback 1/12)
        rec36 = hs[(hs["mes"] > corte - pd.DateOffset(months=36)) & (hs["mes"] <= corte)]
        por_mes = rec36.groupby(rec36["mes"].dt.month)["venta_real"].sum()
        pesos_raw = np.array([float(por_mes.get(m, 0.0)) for m in range(1, 13)])
        if pesos_raw.sum() > 0:
            w_mensual = pesos_raw / pesos_raw.sum()
        else:
            w_mensual = np.full(12, 1.0 / 12.0)

        seed = _semilla(cfg, sid)
        rng = np.random.default_rng(seed)
        sim_matrix = np.zeros((len(anos), n))

        for k, ano in enumerate(anos):
            y = k + 1
            # Las tres planas en torno a V_i: la UI (base_ruben.html:961) aplica la deriva g_i por igual
            p10_r = V_i * ((1.0 - 0.02) ** y)
            p50_r = V_i
            p90_r = V_i * ((1.0 + 0.02) ** y)

            # Inflacion anual acumulada
            factor_nom = np.prod([1.0 + inflacion_ano(cfg, yy) for yy in range(corte.year + 1, ano + 1)])
            p10_n = p10_r * factor_nom
            p50_n = p50_r * factor_nom
            p90_n = p90_r * factor_nom

            filas_a.append({
                "sede_id": sid, "ano": ano, "metodo": "SIMPLE_RED", "motivo": "",
                "p10_real": p10_r, "p50_real": p50_r, "p90_real": p90_r,
                "p10_nominal": p10_n, "p50_nominal": p50_n, "p90_nominal": p90_n,
            })

            # Distribucion analitica vectorizada para economia.py (P50 centrado en deriva local combinada)
            med_sim = V_i * ((1.0 + g_i) ** y)
            sigma = (p90_r - p10_r) / (2.0 * z_score) if p90_r > p10_r else 0.0
            sim_matrix[k, :] = np.maximum(0.0, med_sim + sigma * rng.normal(0.0, 1.0, size=n))

            # Desglose mensual
            for m in range(1, 13):
                mes_ts = pd.Timestamp(ano, m, 1)
                wm = w_mensual[m - 1]
                filas_m.append({
                    "sede_id": sid, "mes": mes_ts,
                    "p10_real": p10_r * wm, "p50_real": p50_r * wm, "p90_real": p90_r * wm
                })

        sim_anual[sid] = sim_matrix

    metricas_df = metricas_historicas(datos, hist=hist, corte=corte, dict_g=dict_g)
    return ResultadoDemanda(
        anual=pd.DataFrame(filas_a),
        mensual=pd.DataFrame(filas_m),
        historico=hist[["sede_id", "mes", "venta_real", "venta_nom", "jornadas"]],
        metricas=metricas_df,
        sim_anual=sim_anual, anos=anos, mes_base=mes_base)


def metricas_historicas(datos, hist=None, corte=None, g_red=None, dict_g=None):
    """Indicadores de desempeno por sede para la segmentacion (sin digitales)."""
    if hist is None:
        hist, corte, _ = serie_historica(datos)
    cfg = datos.config
    digitales = set(datos.sedes.loc[datos.sedes["grupo"] == "DIGITAL"].index) if "grupo" in datos.sedes else set()
    if digitales:
        hist = hist[~hist["sede_id"].isin(digitales)]

    if g_red is None:
        g_red = calcular_g_red(hist, corte, digitales)
    if dict_g is None:
        todas = hist["sede_id"].unique()
        dict_g = calcular_tendencias_sedes(hist, corte, todas, g_red)

    v = datos.ventas[datos.ventas["mes"] > corte - pd.DateOffset(months=12)]
    if digitales:
        v = v[~v["sede_id"].isin(digitales)]
    mix = (v.pivot_table(index="sede_id", columns="hipodromo", values="venta_nominal_clp", aggfunc="sum")
           .reindex(columns=HIPODROMOS + ["OTRO"]).fillna(0.0))
    mix = mix.div(mix.sum(axis=1).replace(0, np.nan), axis=0).add_prefix("mix_")

    filas = []
    for sid, hs in hist.groupby("sede_id"):
        r = _serie_z(hs, cfg).dropna()
        if not isinstance(r.index, pd.DatetimeIndex):
            r.index = pd.DatetimeIndex(r.index)
        ult12 = hs[(hs["mes"] > corte - pd.DateOffset(months=12)) & (hs["mes"] <= corte)]
        g_hist = dict_g.get(sid, g_red)
        # Tendencia oficial (criterio "Tend 12m" del analisis de portafolio del equipo): venta real de los ultimos 12 meses
        # frente a los 12 anteriores. Refleja la caida reciente del canal fisico; si no hay dos anos completos, la historica.
        prev12 = hs[(hs["mes"] > corte - pd.DateOffset(months=24)) & (hs["mes"] <= corte - pd.DateOffset(months=12))]
        u, p_ = ult12["venta_real"].sum(), prev12["venta_real"].sum()
        completos = (ult12["venta_real"] > 0).sum() >= 12 and (prev12["venta_real"] > 0).sum() >= 12
        g_i = (u / p_ - 1.0) if cfg.get("tendencia_metodo", "12m") == "12m" and completos and p_ > 0 else g_hist

        volatilidad = 0.1
        r36 = r[r.index > corte - pd.DateOffset(months=36)]
        if len(r36) >= 18:
            t_r = np.arange(len(r36)) / 12.0
            dummies = pd.get_dummies(r36.index.month).to_numpy(float)
            X = np.column_stack([t_r, dummies])
            coef, *_ = np.linalg.lstsq(X, r36.to_numpy(), rcond=None)
            residuos = r36.to_numpy() - X @ coef
            media_r = float(r36.mean())
            if media_r > 0:
                volatilidad = float(np.std(residuos) / media_r)

        fila = {
            "sede_id": sid, "venta_12m_real": ult12["venta_real"].sum(),
            "jornadas_12m": ult12["jornadas"].sum(), "meses_historia": len(r),
            "crecimiento_anual_pct": g_i * 100.0, "crecimiento_historico_pct": g_hist * 100.0, "volatilidad": volatilidad
        }
        filas.append(fila)

    out = pd.DataFrame(filas).set_index("sede_id")
    return out.join(mix, how="left")
