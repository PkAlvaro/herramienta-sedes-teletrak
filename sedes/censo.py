"""Entorno de cada sede según el Censo 2024 (INE): comuna por coordenadas y perfil de su población.

El cliente típico de sede es hombre de 50 años o más. Migrar al canal digital al cerrar es más difícil donde
ese grupo pesa más y donde los 50+ tienen menos años de estudio: en Chile el uso de internet de las personas
mayores cae fuertemente con la edad y la educación (Encuesta Calidad de Vida en la Vejez 2022 y CASEN 2022,
Observatorio del Envejecimiento UC-Confuturo, 2024). El acceso a internet en el hogar ya es casi universal
(88% de los hogares con personas mayores), por eso no entra en el índice: se guarda solo como referencia.
Datos en datos_publicos/ (ver preparar_censo.py): censo2024_comunas.csv y comunas_bcn.json (BCN).
"""
import json
from functools import lru_cache
from pathlib import Path

import numpy as np
import pandas as pd

BASE = Path(__file__).parent / "datos_publicos"
COLS = ["codigo_comuna", "comuna_censo", "pct_hombres_50_mas", "escolaridad_50_mas", "pct_internet_fija", "pct_internet_movil"]


@lru_cache(maxsize=1)
def _datos():
    tab = pd.read_csv(BASE / "censo2024_comunas.csv").set_index("codigo_comuna")
    poli = {int(k): [np.asarray(r, float) for r in v] for k, v in json.loads((BASE / "comunas_bcn.json").read_text(encoding="utf-8")).items()}
    caja = {k: (min(r[:, 0].min() for r in v), min(r[:, 1].min() for r in v), max(r[:, 0].max() for r in v), max(r[:, 1].max() for r in v))
            for k, v in poli.items() if v}
    return tab, poli, caja


def _dentro(x, y, anillo):
    """Punto en polígono (rayo horizontal)."""
    x0, y0 = anillo[:-1, 0], anillo[:-1, 1]
    x1, y1 = anillo[1:, 0], anillo[1:, 1]
    cruza = (y0 > y) != (y1 > y)
    with np.errstate(divide="ignore", invalid="ignore"):
        xc = x0 + (y - y0) * (x1 - x0) / (y1 - y0)
    return bool(np.count_nonzero(cruza & (x < xc)) % 2)


def comuna_de(lat, lon, tol_km=3.0):
    """Código de comuna de cada punto. Fuera de todo polígono (costa simplificada): la comuna más cercana a menos de tol_km."""
    _, poli, caja = _datos()
    out = []
    for la, lo in zip(np.asarray(lat, float), np.asarray(lon, float)):
        cod = None
        if np.isfinite(la) and np.isfinite(lo):
            for k, (a, b, c, d) in caja.items():
                if a <= lo <= c and b <= la <= d and any(_dentro(lo, la, r) for r in poli[k]):
                    cod = k
                    break
            if cod is None:
                mejor = (tol_km, None)
                for k, rs in poli.items():
                    for r in rs:
                        dk = np.hypot((r[:, 0] - lo) * 111.32 * np.cos(np.radians(la)), (r[:, 1] - la) * 110.57).min()
                        if dk < mejor[0]:
                            mejor = (dk, k)
                cod = mejor[1]
        out.append(cod)
    return out


def perfil(lat, lon, index=None):
    """Comuna (Censo 2024) y perfil de su población para cada sede."""
    tab, _, _ = _datos()
    cods = comuna_de(lat, lon)
    filas = []
    for c in cods:
        if c is None or c not in tab.index:
            filas.append({k: None for k in COLS})
        else:
            t = tab.loc[c]
            filas.append({"codigo_comuna": int(c), "comuna_censo": t["comuna"], "pct_hombres_50_mas": float(t["pct_hombres_50_mas"]), "escolaridad_50_mas": float(t["escolaridad_50_mas"]),
                          "pct_internet_fija": float(t["pct_internet_fija"]), "pct_internet_movil": float(t["pct_internet_movil"])})
    return pd.DataFrame(filas, columns=COLS, index=index)
