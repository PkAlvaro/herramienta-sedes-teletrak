"""Escritura de la plantilla Excel (en blanco o con datos) a partir del esquema."""
import io

import pandas as pd

from .config import DEFAULTS
from .esquema import HOJAS, LEEME


def _hoja_leeme(nota=None):
    filas = [[t, "", "", ""] for t in ([nota, ""] if nota else []) + LEEME]
    filas += [["", "", "", ""], ["HOJA", "COLUMNA", "OBLIGATORIA", "DESCRIPCION"]]
    for hoja, cols in HOJAS.items():
        for col, tipo, oblig, desc in cols:
            filas.append([hoja, col, "SI" if oblig else "no", f"{desc} ({tipo})"])
    filas += [["", "", "", ""], ["PARAMETRO", "VALOR POR DEFECTO", "", ""]]
    for k, v in DEFAULTS.items():
        filas.append([k, str(v), "", ""])
    return pd.DataFrame(filas)


def escribir(destino=None, hojas=None, nota=None):
    """Escribe la plantilla. hojas: dict nombre -> DataFrame con datos. Devuelve bytes si destino es None."""
    hojas = hojas or {}
    buf = destino or io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as xw:
        _hoja_leeme(nota).to_excel(xw, sheet_name="LEEME", index=False, header=False)
        for hoja, cols in HOJAS.items():
            nombres = [c[0] for c in cols]
            df = hojas.get(hoja, pd.DataFrame(columns=nombres))
            df.reindex(columns=nombres).to_excel(xw, sheet_name=hoja, index=False)
        for ws in xw.book.worksheets:
            for col in ws.columns:
                largo = max(len(str(c.value or "")) for c in col[:200])
                ws.column_dimensions[col[0].column_letter].width = min(max(10, largo + 2), 60)
            ws.freeze_panes = "A2" if ws.title != "LEEME" else None
    return None if destino else buf.getvalue()
