"""Parametros por defecto de la herramienta.

Cada parametro se puede sobreescribir desde la hoja PARAMETROS de la plantilla
o desde la interfaz. Las etiquetas [DATO] / [SUPUESTO] siguen la convencion de
modelo_simple/README.md.
"""
from copy import deepcopy

HIPODROMOS = ["HCH", "CHS", "VSC", "CHC"]
GRUPOS = ["G9", "RM", "REGIONES", "DIGITAL"]

DEFAULTS = {
    # --- Demanda (ETS sobre ln(venta real / jornada), igual que modelo_demanda.py) ---
    "inicio_entrenamiento": "2021-06-01",   # [DATO] reapertura post COVID
    "fecha_corte": None,                    # None = ultimo mes con datos
    "mes_base_real": None,                  # None = fecha_corte (pesos de ese mes)
    "horizonte_anos": 10,                   # anos completos proyectados despues del corte (plan 2027-2036)
    "tendencia": "none",                    # 'none' o 'damped'
    "tendencia_metodo": "12m",              # [SUPUESTO] '12m' (ultimos 12 meses vs los 12 anteriores) o 'historica'
    "phi": 0.94,                            # [SUPUESTO] amortiguacion si tendencia='damped'
    "n_simulaciones": 1000,                 # 1000 para explorar, 5000 para resultado final
    "semilla": 42,
    "min_jornadas_mes": 10,                 # meses con menos jornadas se excluyen (cierres)
    "min_meses_ets": 24,                    # con menos historia se usa estacional ingenuo
    "inflacion_futura": 0.03,               # [DATO] meta BCCh, float o {ano: tasa}

    # --- Huff ---
    "huff_lambda": 4.0,                     # [SUPUESTO] friccion de distancia
    "huff_u0": 0.1736,                      # [SUPUESTO] alternativa externa (fuga digital)
    "huff_atractivo": "relativo",           # 'relativo' (A/promedio) o 'mm_clp' (igual al dashboard Huff original)
    "huff_dist_min_km": 0.5,
    "factor_ruta": 1.3,                     # km por ruta / km en linea recta

    # --- Economia ---
    "tasa_margen_global": 0.165,            # [DATO] takeout neto Teletrak
    "tasa_comision_venta": 0.032,           # [DATO] comision pagada por cada peso vendido (hoja Y 2026, COMISION = VTA|X x 3,2%; en Y 2025 era 3,1%)
    "tasas_hipodromo": {"HCH": 0.165, "CHS": 0.165, "VSC": 0.175, "CHC": 0.175},   # [DATO] ingreso del hipodromo que organiza la carrera (hoja Y 2026, ING | Sin FP)
    "tasa_retencion_digital": 0.35,         # [DATO/SUPUESTO] parte de la fuga que migra a canal digital propio

    # --- Red y segmentacion ---
    "radio_cobertura_km": {"RM": 3.0, "REGIONES": 15.0},  # [SUPUESTO] eps de DBSCAN por zona
    "radio_vecinos_km": 5.0,
    "radio_zona_km": {"SANTIAGO URBANO": 3.0, "ALREDEDORES RM": 8.0, "REGIONES": 15.0},  # [SUPUESTO] si el acceso se mide en km
    # [SUPUESTO] como llega el cliente a una sede alternativa y en cuanto tiempo maximo (minutos; km si modo = "km")
    # modos: "km" (distancia por calle), "pie", "metro" (metro + caminata), "auto", "rapido" (el menor de todos)
    "acceso_zona": {"SANTIAGO URBANO": {"modo": "metro", "umbral": 20.0},
                    "ALREDEDORES RM": {"modo": "auto", "umbral": 15.0},
                    "REGIONES": {"modo": "auto", "umbral": 20.0}},
    "k_segmentos": None,                    # None = elegir k por silhouette entre 3 y 6
    "calibrar_u0": True,                    # U0 (y lambda) desde cierres historicos si hay al menos 2
    "umbral_margen_clp": None,              # categoria: margen anual >= umbral = cerrar despues (None = mediana de su zona)
    "umbral_retencion": None,               # categoria: retencion en red >= umbral = redundante (None = mediana de la red)

    # --- Lectura del Excel de rentabilidad del cliente ---
    "sedes_g9": [],                         # Id_Division de la cartera focal G9
    "sedes_excluidas": [],                  # Id_Division fuera del analisis por falta de informacion
    "vendido_sigue_operando": True,         # [SUPUESTO] VENDIDO = sigue captando demanda sin costo propio
    "tolerancia_cuadre": 0.005,             # diferencia relativa aceptada entre hojas
    "radio_rm_km": 60.0,                    # sedes a menos de esto del centro de Santiago son RM
    "fecha_referencia": None,               # None = hoy, para alertas de plazos de aviso
    "dias_alerta_aviso": 90,
}


def construir_config(sobrescrituras=None):
    """Devuelve una copia de DEFAULTS con las sobrescrituras aplicadas."""
    cfg = deepcopy(DEFAULTS)
    for k, v in (sobrescrituras or {}).items():
        if k not in cfg:
            raise KeyError(f"Parametro desconocido: {k}")
        if isinstance(cfg[k], dict) and isinstance(v, dict):
            cfg[k].update(v)
        else:
            cfg[k] = v
    return cfg


def inflacion_ano(cfg, ano):
    inf = cfg["inflacion_futura"]
    return inf.get(ano, 0.03) if isinstance(inf, dict) else float(inf)
