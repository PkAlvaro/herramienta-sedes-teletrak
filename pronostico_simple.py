"""Pronostico simple de ventas por sede a 5 anos (100% lineal en pesos, sin logaritmos).
1. Excluye completamente sedes DIGITALES (grupo DIGITAL o sucursal VIRTUAL).
2. Nivel base por sede V_i = suma de venta real de los ultimos 12 meses (T-11 a T).
3. Tendencia por sede g_i = combinacion ponderada de tendencia local post-2024 con filtro MAD + Theil-Sen
   y tendencia estructural de la red fisica post-2022 (MAD + Theil-Sen), acotada a [-12%, +5%].
4. Escenarios a 5 anos (y=1..5): base=V_i*(1+g_i)^y, pesimista=V_i*(1+g_i-0.02)^y, optimista=V_i*(1+g_i+0.02)^y.
5. Nominal con inflacion 3% anual.
"""
import sys
from pathlib import Path
import numpy as np
import pandas as pd
from scipy.stats import theilslopes

DELTA_ESCENARIO = 0.02       # +-2 pp para escenarios pesimista y optimista
INFLACION = 0.03              # 3% anual para proyeccion nominal
INICIO_RED = "2022-01"        # Ventana red fisica largo plazo (primer punto 12m en 2022-12)
INICIO_LOCAL = "2024-01"      # Ventana local por sede (primer punto 12m en 2024-12, ~22 puntos)

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sedes.demanda import factores_deflactor
from sedes.rentabilidad import _con_encabezado, _ventas_historico, _mensual_desde_diario, _mes_corte, Hoja, InformeCarga


def cargar_datos(ruta_excel):
    """Carga ventas e IPC excluyendo sedes digitales. Devuelve (DataFrame ventas, mes T, n_digitales)."""
    xl = pd.ExcelFile(ruta_excel)
    ipc_csv = Path(__file__).resolve().parent / "sedes" / "datos_publicos" / "ipc_ine.csv"
    digitales_ids = set()

    if "VENTAS_MENSUALES" in xl.sheet_names:
        if "SEDES" in xl.sheet_names:
            df_s = xl.parse("SEDES")
            if "grupo" in df_s.columns and "sede_id" in df_s.columns:
                digitales_ids = set(df_s.loc[df_s["grupo"].astype(str).str.upper() == "DIGITAL", "sede_id"].dropna())
        df_v = xl.parse("VENTAS_MENSUALES")
        df_v["mes"] = pd.to_datetime(df_v["mes"])
        if digitales_ids:
            df_v = df_v[~df_v["sede_id"].isin(digitales_ids)]
        vm = df_v.groupby(["sede_id", "mes"], as_index=False)["venta_nominal_clp"].sum()
        T = vm["mes"].max()
        ipc = xl.parse("IPC") if "IPC" in xl.sheet_names else pd.read_csv(ipc_csv, parse_dates=["mes"])
        ipc["mes"] = pd.to_datetime(ipc["mes"])

    elif "VTA HIST" in xl.sheet_names:
        raw = xl.parse("VTA HIST", header=None)
        df_enc = _con_encabezado(raw)
        cid = "ID_DIVISION" if "ID_DIVISION" in df_enc.columns else df_enc.columns[0]
        mask_dig = False
        for col in ("SUCURSAL", "UBICACION"):
            if col in df_enc.columns:
                mask_dig = mask_dig | df_enc[col].astype(str).str.upper().str.contains("VIRTUAL|DIGITAL")
        if isinstance(mask_dig, pd.Series) and mask_dig.any():
            digitales_ids = set(df_enc.loc[mask_dig, cid].dropna().str.strip().unique())
        diario, _ = _ventas_historico(Hoja("VTA HIST", "HISTORICO", df_enc), InformeCarga())
        T = _mes_corte(diario)
        vm = _mensual_desde_diario(diario)
        vm = vm[vm["mes"] <= T]
        if digitales_ids:
            vm = vm[~vm["sede_id"].isin(digitales_ids)]
        vm = vm.groupby(["sede_id", "mes"], as_index=False)["venta_nominal_clp"].sum()
        ipc = pd.read_csv(ipc_csv, parse_dates=["mes"])

    elif "MATRIZ_MENSUAL_SEDES" in xl.sheet_names:
        df_mat = xl.parse("MATRIZ_MENSUAL_SEDES", skiprows=3)
        col_m = df_mat.columns[0]
        sedes_c = [c for c in df_mat.columns if c not in (col_m, "G9 CONSOLIDADO", "TODA LA RED")
                   and not str(c).startswith("Unnamed")]
        vm = df_mat.melt(id_vars=[col_m], value_vars=sedes_c, var_name="sede_raw", value_name="venta_nominal_clp")
        vm["sede_id"] = vm["sede_raw"].str.split().str[0]
        vm["mes"] = pd.to_datetime(vm[col_m])
        vm = vm[vm["mes"].isin(vm.groupby("mes")["venta_nominal_clp"].sum().loc[lambda s: s > 0].index)]
        T = vm["mes"].max()
        if "IPC_OFICIAL_INE" in xl.sheet_names:
            df_i = xl.parse("IPC_OFICIAL_INE", skiprows=3)
            c_v = [c for c in df_i.columns if "Variaci" in str(c)][0]
            c_m = [c for c in df_i.columns if "Mes" in str(c) and c != "Mes"][0]
            ipc = pd.DataFrame({"mes": pd.to_datetime(df_i[c_m]), "var_mensual_pct": pd.to_numeric(df_i[c_v], errors="coerce")}).dropna()
        else:
            ipc = pd.read_csv(ipc_csv, parse_dates=["mes"])
    else:
        raise ValueError(f"Formato no reconocido en {ruta_excel}. Hojas: {xl.sheet_names}")

    fac = factores_deflactor(ipc, T)
    vm["venta_real"] = vm["venta_nominal_clp"] * vm["mes"].map(fac)
    return vm, T, len(digitales_ids)


def _filtrar_mad(serie_12m):
    """Filtra saltos mensuales anomalos recortando diferencias a mediana +- 2 MAD."""
    diff = serie_12m.diff().dropna()
    med_d = float(diff.median())
    mad_d = float(np.median(np.abs(diff - med_d)) * 1.4826)
    if mad_d > 0:
        diff_cl = np.clip(diff, med_d - 2.0 * mad_d, med_d + 2.0 * mad_d)
        return float(serie_12m.iloc[0]) + np.cumsum(np.insert(diff_cl.to_numpy(), 0, 0.0))
    return serie_12m.to_numpy()


def estimar_g_red(vm, T):
    """Tendencia lineal robusta en pesos de la red continua desde 2022-01 (12m en 2022-12)."""
    ini_red = max(pd.Timestamp(INICIO_RED), vm["mes"].min())
    meses_red = pd.date_range(ini_red, T, freq="MS")
    conteo_red = vm[vm["mes"].isin(meses_red)].groupby("sede_id")["mes"].nunique()
    sedes_comp_red = conteo_red[conteo_red == len(meses_red)].index
    net_m = vm[vm["sede_id"].isin(sedes_comp_red) & (vm["mes"] >= ini_red) & (vm["mes"] <= T)
               ].groupby("mes")["venta_real"].sum().sort_index()
    s12_red = net_m.rolling(12).sum().dropna()
    validos = s12_red[s12_red > 0]
    if len(validos) < 2:
        return 0.0, s12_red
    s12_limp = _filtrar_mad(validos)
    t = np.arange(len(s12_limp)) / 12.0
    pend = float(theilslopes(s12_limp, t)[0])
    media = float(np.mean(s12_limp))
    return (float(pend / media) if media > 0 else 0.0), s12_red


def estimar_tendencias_sedes(vm, T, todas_sedes, g_red):
    """Calcula g_local crudo y filtrado, estabilidad r2, peso w y g_final acotado [-12%, +5%]."""
    ini_loc = max(pd.Timestamp(INICIO_LOCAL), vm["mes"].min())
    meses_loc = pd.date_range(ini_loc, T, freq="MS")
    meses_hist = vm.groupby("sede_id")["mes"].nunique()

    dict_g_final = {}
    filas_info = []

    for sid in todas_sedes:
        s_sid = vm[(vm["sede_id"] == sid) & (vm["mes"] >= ini_loc) & (vm["mes"] <= T)
                   ].set_index("mes")["venta_real"].reindex(meses_loc, fill_value=0.0)
        s12 = s_sid.rolling(12).sum().dropna()
        validos = s12[s12 > 0]

        if len(validos) < 4:
            g_crudo, g_filt, r2, w, g_final = g_red, g_red, 0.0, 0.25, float(np.clip(g_red, -0.12, 0.05))
        else:
            t = np.arange(len(validos)) / 12.0
            pend_crudo = float(np.polyfit(t, validos, 1)[0])
            media_cruda = float(validos.mean())
            g_crudo = float(pend_crudo / media_cruda) if media_cruda > 0 else 0.0

            s12_limp = _filtrar_mad(validos)
            pend_ts = float(theilslopes(s12_limp, t)[0])
            media_limp = float(np.mean(s12_limp))
            g_filt = float(pend_ts / media_limp) if media_limp > 0 else 0.0

            corr = np.corrcoef(t, s12_limp)[0, 1]
            r2 = float(corr ** 2) if np.isfinite(corr) else 0.0
            w = float(np.clip(0.25 + 0.35 * r2, 0.25, 0.60))
            g_comb = w * g_filt + (1.0 - w) * g_red
            g_final = float(np.clip(g_comb, -0.12, 0.05))

        dict_g_final[sid] = g_final
        filas_info.append({
            "sede_id": sid,
            "g_local_crudo_pct": round(g_crudo * 100.0, 2),
            "g_local_filtrado_pct": round(g_filt * 100.0, 2),
            "g_red_pct": round(g_red * 100.0, 2),
            "peso_local_w": round(w, 2),
            "g_final_pct": round(g_final * 100.0, 2),
            "meses_historia": int(meses_hist.get(sid, 0))
        })
    return dict_g_final, pd.DataFrame(filas_info)


def pronosticar(ruta_entrada, ruta_salida=None):
    vm, T, n_digitales = cargar_datos(ruta_entrada)
    todas_sedes = sorted(vm["sede_id"].unique())

    # 1. Nivel V_i: suma ultimos 12 meses (T-11 a T)
    m12_inicio = T - pd.DateOffset(months=11)
    v_i = vm[(vm["mes"] >= m12_inicio) & (vm["mes"] <= T)].groupby("sede_id")["venta_real"].sum()
    v_i = v_i.reindex(todas_sedes, fill_value=0.0)

    # 2. Tendencias de red y local combinadas
    g_red, s12_red = estimar_g_red(vm, T)
    dict_g_final, df_info = estimar_tendencias_sedes(vm, T, todas_sedes, g_red)

    # 3. Hoja sedes
    df_sedes = df_info.copy()
    df_sedes.insert(1, "venta_12m_real", [round(float(v_i[s]), 2) for s in df_sedes["sede_id"]])
    mediana_propia = round(df_sedes["g_final_pct"].median(), 2)

    # 4. Proyeccion por sede con su propio g_i
    filas_anual = []
    for y in range(1, 6):
        ano = T.year + y
        factor_nom = (1.0 + INFLACION) ** y
        for sid in todas_sedes:
            val = float(v_i[sid])
            g_i = dict_g_final[sid]
            f_pes = (1.0 + g_i - DELTA_ESCENARIO) ** y
            f_base = (1.0 + g_i) ** y
            f_opt = (1.0 + g_i + DELTA_ESCENARIO) ** y
            p_r = val * f_pes
            b_r = val * f_base
            o_r = val * f_opt
            filas_anual.append({
                "sede_id": sid, "ano": ano,
                "pesimista_real": round(p_r, 2), "base_real": round(b_r, 2), "optimista_real": round(o_r, 2),
                "pesimista_nominal": round(p_r * factor_nom, 2), "base_nominal": round(b_r * factor_nom, 2),
                "optimista_nominal": round(o_r * factor_nom, 2)
            })
    df_anual = pd.DataFrame(filas_anual)

    # 5. Resumen consolidado de la red
    df_tot = df_anual.groupby("ano")[["pesimista_real", "base_real", "optimista_real",
                                      "pesimista_nominal", "base_nominal", "optimista_nominal"]].sum().reset_index()
    t_str = T.strftime("%Y-%m")
    p_ini = s12_red.index[0].strftime("%Y-%m") if len(s12_red) else "N/A"
    p_fin = s12_red.index[-1].strftime("%Y-%m") if len(s12_red) else "N/A"
    vent_puntos = f"{p_ini} a {p_fin}"
    df_tot.insert(0, "corte_T", t_str)
    df_tot.insert(1, "ventana_puntos", vent_puntos)
    df_tot.insert(2, "n_puntos_ols", len(s12_red))
    df_tot.insert(3, "g_red_pct", round(g_red * 100.0, 2))
    df_tot.insert(4, "mediana_propia_pct", mediana_propia)
    df_tot.insert(5, "n_sedes_fisicas", len(todas_sedes))
    df_tot.insert(6, "n_digitales_excluidas", n_digitales)

    # 6. Guardar en Excel
    if not ruta_salida:
        p_in = Path(ruta_entrada)
        ruta_salida = p_in.parent / f"pronostico_simple_{p_in.stem}.xlsx"
    with pd.ExcelWriter(ruta_salida, engine="openpyxl") as xw:
        df_tot.to_excel(xw, sheet_name="resumen", index=False)
        df_anual.to_excel(xw, sheet_name="anual", index=False)
        df_sedes.to_excel(xw, sheet_name="sedes", index=False)

    print(f"Pronostico guardado en: {ruta_salida}")
    print(f"Corte T: {t_str} | Ventana Red: {vent_puntos} ({len(s12_red)} puntos) | Sedes fisicas: {len(todas_sedes)}")
    print(f"Tendencia red g: {g_red * 100.0:.2f}% | Mediana final por sede: {mediana_propia:.2f}%")
    return g_red, df_tot, df_sedes


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Uso: python pronostico_simple.py <excel_entrada> [salida.xlsx]")
        sys.exit(1)
    salida_arg = sys.argv[2] if len(sys.argv) > 2 else None
    pronosticar(sys.argv[1], salida_arg)
