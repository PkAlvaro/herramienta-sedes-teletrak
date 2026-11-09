"""Lector del Excel de rentabilidad Teletrak (formato del cliente).

Reconoce las hojas por sus columnas, no por su nombre:

- ANUAL     (Y 2025 ...): Id_Division, CHS|AAAA ... VTA|AAAA, P&L anual, contrato, PPR
- MENSUAL   (Y 2026 ...): DIVISION (=Id), AGENCIA, HCH|01..08, ING|01..08, P&L, ARRIENDO (fecha)
- HISTORICO (VTA HIST)  : tabla dinamica diaria, columnas AAAAMMDD por sede x hipodromo
- EN_PROCESO            : cierres en curso por nombre de sede, STATUS, VIGENCIA, AVISO
- ARRIENDO  (CTA ARRIENDO): LOCAL + columnas AAAA_M con el arriendo mensual

Devuelve un objeto Datos (mismo que la plantilla) mas un InformeCarga con
cuadres entre hojas, identidades contables, equivalencias pendientes y alertas
de contratos. El informe solo contiene agregados y conteos cuando se comparte.
"""
import difflib
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

from .config import HIPODROMOS, construir_config
from .datos import Datos, Problema, abrir_libro, haversine_km, matriz_distancias

RE_ID = re.compile(r"^\d{3}\.\d{3}\.\d{3}$")
RE_DIA = re.compile(r"^(19|20)\d{6}$")
RE_ANO = re.compile(r"^(CHS|HCH|VSC|CHC|VTA)\|(\d{4})$")
RE_MES = re.compile(r"^(CHS|HCH|VSC|CHC|VTA|ING)\|(\d{2})$")
RE_ARR = re.compile(r"^(\d{4})_(\d{1,2})$")
SANTIAGO = (-33.4489, -70.6693)

HIPO_ALIAS = {
    "CHS": "CHS", "CLUB HIPICO": "CHS", "CLUB HIPICO DE SANTIAGO": "CHS",
    "HCH": "HCH", "HIPODROMO CHILE": "HCH",
    "VSC": "VSC", "SPORTING": "VSC", "VALPARAISO SPORTING": "VSC", "VALPARAISO SPORTING CLUB": "VSC",
    "CHC": "CHC", "CONCEPCION": "CHC", "CLUB HIPICO DE CONCEPCION": "CHC",
}
GENERICOS = {"TLK", "TELETRAK", "AGENCIA", "SUCURSAL", "LOCAL", "SEDE", "MINITRAK"}


# ---------------------------------------------------------------------------
# Normalizacion
# ---------------------------------------------------------------------------

def norm(s):
    """Mayusculas, sin tildes, sin espacios dobles ni alrededor de '|'."""
    if isinstance(s, float) and s.is_integer():
        s = int(s)
    if isinstance(s, (datetime, pd.Timestamp)):
        return s.strftime("%Y%m%d")
    s = unicodedata.normalize("NFKD", str(s))
    s = "".join(c for c in s if not unicodedata.combining(c)).upper().strip()
    s = re.sub(r"\s*\|\s*", "|", s)
    return re.sub(r"\s+", " ", s)


def norm_nombre(s, quitar_genericos=False):
    s = re.sub(r"[^A-Z0-9 ]", " ", norm(s))
    toks = s.split()
    if quitar_genericos:
        toks = [t for t in toks if t not in GENERICOS]
    return " ".join(toks)


def a_fecha(v, dayfirst=True):
    if v is None or (isinstance(v, float) and np.isnan(v)) or v is pd.NaT:
        return pd.NaT
    if isinstance(v, (datetime, pd.Timestamp)):
        return pd.Timestamp(v)
    if isinstance(v, (int, float)) and 20000 < v < 80000:      # serial de Excel
        return pd.Timestamp("1899-12-30") + pd.Timedelta(days=float(v))
    txt = str(v).strip()
    if re.match(r"^\d{4}-\d{2}-\d{2}", txt):                     # ISO (lo que entrega el navegador)
        return pd.to_datetime(txt[:10], format="%Y-%m-%d", errors="coerce")
    return pd.to_datetime(txt, dayfirst=dayfirst, errors="coerce")


def a_dias(v):
    """'180 dias' -> 180, '3 meses' -> 90, 60 -> 60. NaN si no se entiende."""
    if v is None or (isinstance(v, float) and np.isnan(v)):
        return np.nan
    if isinstance(v, (int, float)):
        return float(v)
    m = re.match(r"^\s*(\d+(?:[.,]\d+)?)\s*([A-Z]*)", norm(v))
    if not m:
        return np.nan
    n = float(m.group(1).replace(",", "."))
    return n * 30.0 if m.group(2).startswith("M") else n


def _num1(v):
    return _num(pd.Series([v])).iloc[0]


def _num(serie):
    if serie.dtype == object:
        serie = serie.map(lambda x: str(x).replace(".", "").replace(",", ".") if isinstance(x, str) else x)
    return pd.to_numeric(serie, errors="coerce")


# ---------------------------------------------------------------------------
# Lectura de hojas
# ---------------------------------------------------------------------------

@dataclass
class Hoja:
    nombre: str
    tipo: str
    df: pd.DataFrame
    ano: int = None


def _encabezado(raw):
    claves = {"ID_DIVISION", "LOCAL", "STATUS", "DIVISION", "AGENCIA"}
    for i in range(min(15, len(raw))):
        fila = {("ID_DIVISION" if re.fullmatch(r"ID[\s_\-.]*DIVISION", norm(x)) else norm(x)) for x in raw.iloc[i].tolist() if pd.notna(x)}
        if fila & claves:
            return i
    return None


def _con_encabezado(raw):
    i = _encabezado(raw)
    if i is None:
        return None
    cols, vistos = [], {}
    for x in raw.iloc[i].tolist():
        c = norm(x) if pd.notna(x) else ""
        if re.fullmatch(r"ID[\s_\-.]*DIVISION", c):      # "Id División", "ID DIVISION", "Id_Division"
            c = "ID_DIVISION"
        vistos[c] = vistos.get(c, 0) + 1
        cols.append(c if vistos[c] == 1 else f"{c}#{vistos[c]}")
    df = raw.iloc[i + 1:].copy()
    df.columns = cols
    return df.dropna(how="all").reset_index(drop=True)


def _clasificar(df):
    cols = list(df.columns)
    cs = set(cols)
    if "LOCAL" in cs and sum(bool(RE_ARR.match(c)) for c in cols) >= 3:
        return "ARRIENDO"
    if sum(bool(RE_DIA.match(c)) for c in cols) >= 20:
        return "HISTORICO"
    if {"STATUS", "VIGENCIA"} <= cs:
        return "EN_PROCESO"
    if any(RE_ANO.match(c) for c in cols) and _col_id(df):
        return "ANUAL"
    if any(RE_MES.match(c) for c in cols):
        return "MENSUAL"
    return None


def leer_libro(fuente):
    """Devuelve (lista de Hoja, problemas)."""
    libro = abrir_libro(fuente, header=None)
    hojas, problemas = [], []
    for nombre, raw in libro.items():
        df = _con_encabezado(raw)
        tipo = _clasificar(df) if df is not None else None
        if tipo is None:
            enc = [c for c in (df.columns if df is not None else []) if c][:25]
            problemas.append(Problema("AVISO", nombre, "hoja no reconocida, se ignora" + (f". Encabezados: {', '.join(enc)}" if enc else "")))
            continue
        m = re.search(r"(20\d{2})", nombre)
        hojas.append(Hoja(nombre, tipo, df, int(m.group(1)) if m else None))
    return hojas, problemas


def _col_id(df):
    """Columna con Id_Division: primero por nombre, si no, la primera cuyos valores tengan formato 000.000.000."""
    cands = [c for c in ("ID_DIVISION", "DIVISION") if c in df.columns] + [c for c in df.columns if c not in ("ID_DIVISION", "DIVISION")]
    for c in cands:
        v = df[c].dropna().astype(str).str.strip()
        if len(v) >= 3 and v.str.match(RE_ID).mean() > 0.5:
            return c
    return None


# ---------------------------------------------------------------------------
# Resolucion de nombres -> Id_Division
# ---------------------------------------------------------------------------

class Resolutor:
    """Nombre de sede -> Id_Division usando solo el propio Excel.

    1. equivalencias confirmadas por el usuario
    2. nombre normalizado identico (sin tildes, mayusculas ni signos)
    3. identico sin palabras genericas (TLK, TELETRAK, AGENCIA...)
    4. el mas parecido si la similitud >= AUTO y no hay empate: se asigna y queda anotado para revisar
    El resto queda pendiente con una sugerencia.
    """
    AUTO = 0.80

    def __init__(self, nombres_por_id, equivalencias=None):
        self.exacto, self.sin_gen = {}, {}
        for sid, nombres in nombres_por_id.items():
            for n in nombres:
                if pd.isna(n):
                    continue
                self.exacto.setdefault(norm_nombre(n), set()).add(sid)
                self.sin_gen.setdefault(norm_nombre(n, True), set()).add(sid)
        self.equiv = {norm_nombre(k): v for k, v in (equivalencias or {}).items()}
        self.pendientes, self.automaticas = [], []

    def __call__(self, nombre, hoja):
        n = norm_nombre(nombre)
        if n in self.equiv:
            return self.equiv[n]
        for tabla, clave in ((self.exacto, n), (self.sin_gen, norm_nombre(nombre, True))):
            ids = tabla.get(clave, set())
            if len(ids) == 1:
                return next(iter(ids))
        cands = difflib.get_close_matches(n, list(self.exacto), n=2, cutoff=0.5)
        sug = cands[0] if cands else None
        sim = difflib.SequenceMatcher(None, n, sug).ratio() if sug else 0.0
        segundo = difflib.SequenceMatcher(None, n, cands[1]).ratio() if len(cands) > 1 else 0.0
        if sug and sim >= self.AUTO and len(self.exacto[sug]) == 1 and sim - segundo > 0.05:
            sid = next(iter(self.exacto[sug]))
            self.automaticas.append({"hoja": hoja, "nombre": nombre, "asignado_a": sug, "sede_id": sid, "similitud": round(sim, 2)})
            return sid
        self.pendientes.append({
            "hoja": hoja, "nombre": nombre,
            "sugerencia": sug, "sugerencia_id": ",".join(sorted(self.exacto[sug])) if sug else None,
            "similitud": round(difflib.SequenceMatcher(None, n, sug).ratio(), 2) if sug else None})
        return None


# ---------------------------------------------------------------------------
# Informe de carga
# ---------------------------------------------------------------------------

@dataclass
class InformeCarga:
    problemas: list = field(default_factory=list)
    hojas: pd.DataFrame = None
    cuadre: pd.DataFrame = None
    identidades: pd.DataFrame = None
    pendientes: pd.DataFrame = None
    automaticas: pd.DataFrame = None
    columnas: pd.DataFrame = None
    contratos: pd.DataFrame = None
    disponibles: pd.DataFrame = None
    resumen: dict = field(default_factory=dict)

    def texto(self):
        out = ["INFORME DE CARGA", ""]
        for k, v in self.resumen.items():
            out.append(f"{k}: {v}")
        out.append("")
        if self.hojas is not None:
            out.append(self.hojas.to_string(index=False))
            out.append("")
        for p in self.problemas:
            out.append(str(p))
        if self.identidades is not None and len(self.identidades):
            out += ["", "IDENTIDADES CONTABLES (filas que cumplen)", self.identidades.to_string(index=False)]
        if self.cuadre is not None and len(self.cuadre):
            r = self.cuadre.groupby("comparacion")["ok"].agg(["size", "sum"]).rename(columns={"size": "n", "sum": "cuadran"})
            out += ["", "CUADRE ENTRE HOJAS", r.to_string()]
        if self.pendientes is not None and len(self.pendientes):
            out += ["", f"NOMBRES SIN RESOLVER: {len(self.pendientes)} (ver hoja 'pendientes' del informe)"]
        if self.contratos is not None and len(self.contratos):
            a = self.contratos["alerta"].value_counts()
            out += ["", "ALERTAS DE CONTRATO", a.to_string()]
        return "\n".join(out)

    def a_excel(self, destino):
        with pd.ExcelWriter(destino, engine="openpyxl") as xw:
            pd.DataFrame([{"nivel": p.nivel, "hoja": p.hoja, "mensaje": p.mensaje} for p in self.problemas]
                         ).to_excel(xw, sheet_name="problemas", index=False)
            for nombre in ("hojas", "identidades", "cuadre", "pendientes", "contratos"):
                df = getattr(self, nombre)
                if df is not None:
                    df.to_excel(xw, sheet_name=nombre, index=False)


# ---------------------------------------------------------------------------
# Extraccion por tipo de hoja
# ---------------------------------------------------------------------------

def _ventas_historico(h, informe):
    df = h.df
    cid = _col_id(df) or "ID_DIVISION"
    df = df[df[cid].notna() & ~df[cid].astype(str).str.upper().str.startswith("TOTAL")].copy()
    df[cid] = df[cid].astype(str).str.strip()
    dias = [c for c in df.columns if RE_DIA.match(c.split("#")[0])]
    base = [c.split("#")[0] for c in dias]
    dups = sorted({b for b in base if base.count(b) > 1})
    if dups:
        informe.problemas.append(Problema("AVISO", h.nombre, f"fechas repetidas {dups}, se suman"))
    if base != sorted(base):
        informe.problemas.append(Problema("AVISO", h.nombre, "columnas de fecha fuera de orden, se ordenan"))
    vals = df[dias].apply(_num)
    if "TOTAL GENERAL" in df.columns:
        tot = _num(df["TOTAL GENERAL"])
        dif = (vals.sum(axis=1) - tot).abs() > 1e-6 * tot.abs().clip(lower=1)
        if dif.any():
            informe.problemas.append(Problema("AVISO", h.nombre, f"{int(dif.sum())} filas no suman su Total general"))
    hip = df["HIPODROMO"].map(lambda x: HIPO_ALIAS.get(norm(x), "OTRO"))
    raros = sorted(set(df.loc[hip == "OTRO", "HIPODROMO"].dropna().astype(str)))
    if raros:
        informe.problemas.append(Problema("AVISO", h.nombre, f"hipodromos no reconocidos {raros}, quedan como OTRO"))
    largo = vals.assign(sede_id=df[cid].values, hipodromo=hip.values).melt(
        id_vars=["sede_id", "hipodromo"], var_name="col", value_name="venta")
    largo = largo[largo["venta"].fillna(0) != 0]
    largo["fecha"] = pd.to_datetime(largo["col"].str.split("#").str[0], format="%Y%m%d")
    diario = largo.groupby(["sede_id", "fecha", "hipodromo"], as_index=False)["venta"].sum()
    nombres = df.groupby(cid).agg(sucursal=("SUCURSAL", "first"), ubicacion=("UBICACION", "first")) \
        if {"SUCURSAL", "UBICACION"} <= set(df.columns) else pd.DataFrame()
    return diario, nombres


def _mensual_desde_diario(diario):
    d = diario.assign(mes=diario["fecha"].dt.to_period("M").dt.to_timestamp())
    por_dia = d.groupby(["sede_id", "fecha", "mes"])["venta"].sum()
    jorn = (por_dia > 0).groupby(level=["sede_id", "mes"]).sum().rename("jornadas")
    v = d.groupby(["sede_id", "mes", "hipodromo"], as_index=False)["venta"].sum()
    v = v.merge(jorn.reset_index(), on=["sede_id", "mes"])
    return v.rename(columns={"venta": "venta_nominal_clp"})


def _mes_corte(diario):
    ult = diario["fecha"].max()
    fin_mes = ult + pd.offsets.MonthEnd(0)
    mes = ult.to_period("M").to_timestamp()
    return mes if (fin_mes - ult).days <= 3 else mes - pd.DateOffset(months=1)


REGLAS_ANUAL = [
    "VTA|{y} = CHS|{y} + HCH|{y} + VSC|{y} + CHC|{y}",
    "COMISION = INGRESOS - FONDO PREMIOS",
    "GASTOS = ARRIENDO 100% + GTO COMUN + VOLANTES 100% + ROLLOS + MANTENCION 100%",
    "GASTOS = ARRIENDO 100% + GTO COMUN + VOLANTES 100% + ROLLOS + MANTENCION 100% + COMISION",
    "MARGEN = COMISION - GASTOS",
    "MARGEN = INGRESOS - FONDO PREMIOS - GASTOS",
    "MARGEN = INGRESOS - GASTOS",
]
REGLAS_MENSUAL = [
    "GASTOS = ARRIENDO + GGCC + MANT + ASEO EXT + SEG EXT + ENLACE + SENAL TV + OTROS",
    "MG SIN FP = ING|SIN FP - GASTOS",
    "COMISION = ING|SIN FP",
]


def _expr(df, texto):
    """Evalua 'A + B - C' sobre columnas. None si falta alguna columna."""
    total = None
    for signo, col in re.findall(r"([+-]?)\s*([^+-]+?)\s*(?=[+-]|$)", texto.strip()):
        col = col.strip()
        if col not in df.columns:
            return None
        v = _num(df[col]).fillna(0) * (-1 if signo == "-" else 1)
        total = v if total is None else total + v
    return total


def _identidades(h, informe, tol):
    df = h.df
    filas = []
    reglas = [r.format(y=h.ano) for r in (REGLAS_ANUAL if h.tipo == "ANUAL" else REGLAS_MENSUAL if h.tipo == "MENSUAL" else [])]
    if h.tipo == "ANUAL":
        reglas += [f"{c.split('#')[0]} = {c}" for c in df.columns if "#" in c and RE_ANO.match(c.split("#")[0])]
    if h.tipo == "MENSUAL":
        meses = [c for c in df.columns if re.match(r"^VTA\|\d{2}$", c)]
        if "VTA|X" in df.columns and meses:
            filas.append(_regla(h.nombre, "VTA|X = promedio VTA|01..", _num(df["VTA|X"]), df[meses].apply(_num).mean(axis=1), tol))
            filas.append(_regla(h.nombre, "VTA|X = suma VTA|01..", _num(df["VTA|X"]), df[meses].apply(_num).sum(axis=1), tol))
    for r in reglas:
        izq, der = (x.strip() for x in r.split("=", 1))
        a, b = _expr(df, izq), _expr(df, der)
        if a is not None and b is not None:
            filas.append(_regla(h.nombre, r, a, b, tol))
    if h.tipo == "ANUAL":
        vta = _expr(df, f"VTA|{h.ano}")
        for n in ("FONDO PREMIOS", "INGRESOS", "COMISION"):
            if vta is not None and n in df.columns:
                filas.append(_ratio(h.nombre, f"{n} / VTA|{h.ano}", _num(df[n]) / vta, 4))
        if vta is not None and f"PPR {h.ano}" in df.columns:
            filas.append(_ratio(h.nombre, f"VTA|{h.ano} / PPR {h.ano} = reuniones implicitas", vta / _num(df[f"PPR {h.ano}"]), 1))
    return filas


def _ratio(hoja, nombre, r, dec):
    r = r.replace([np.inf, -np.inf], np.nan).dropna()
    r = r[r != 0]
    res = f"mediana {r.median():.{dec}f} (p10 {r.quantile(.1):.{dec}f} - p90 {r.quantile(.9):.{dec}f})" if len(r) else ""
    return {"hoja": hoja, "regla": nombre, "filas": len(r), "cumplen": None, "resultado": res}


def _regla(hoja, nombre, a, b, tol):
    ok = ((a - b).abs() <= tol * np.maximum(a.abs(), b.abs()).clip(lower=1)) & a.notna() & b.notna()
    n = int((a.notna() & b.notna()).sum())
    return {"hoja": hoja, "regla": nombre, "filas": n, "cumplen": int(ok.sum()),
            "resultado": f"{ok.sum() / n:.0%}" if n else ""}


def _cuadre(hojas, diario, tol):
    if diario is None or diario.empty:
        return pd.DataFrame()
    filas = []
    d = diario.assign(ano=diario["fecha"].dt.year, mes=diario["fecha"].dt.month)
    for h in hojas:
        cid = _col_id(h.df)
        if not cid or not h.ano:
            continue
        ids = h.df[cid].astype(str).str.strip()
        if h.tipo == "ANUAL":
            for col in h.df.columns:
                m = RE_ANO.match(col)
                if not m:
                    continue
                hip, ano = m.group(1), int(m.group(2))
                sub = d[d["ano"] == ano]
                if sub.empty or sub["fecha"].max() < pd.Timestamp(f"{ano}-12-01"):
                    continue
                hist = (sub if hip == "VTA" else sub[sub["hipodromo"] == hip]).groupby("sede_id")["venta"].sum()
                filas.append(pd.DataFrame({"comparacion": f"{h.nombre} {col} vs VTA HIST", "sede_id": ids.values,
                                           "hoja_valor": _num(h.df[col]).values, "hist_valor": ids.map(hist).values}))
        elif h.tipo == "MENSUAL":
            for col in h.df.columns:
                m = RE_MES.match(col)
                if not m or m.group(1) == "ING":
                    continue
                hip, mes = m.group(1), int(m.group(2))
                sub = d[(d["ano"] == h.ano) & (d["mes"] == mes)]
                if sub.empty:
                    continue
                hist = (sub if hip == "VTA" else sub[sub["hipodromo"] == hip]).groupby("sede_id")["venta"].sum()
                filas.append(pd.DataFrame({"comparacion": f"{h.nombre} {hip}|mes vs VTA HIST", "sede_id": ids.values,
                                           "periodo": f"{h.ano}-{mes:02d}",
                                           "hoja_valor": _num(h.df[col]).values, "hist_valor": ids.map(hist).values}))
    if not filas:
        return pd.DataFrame()
    c = pd.concat(filas, ignore_index=True)
    c = c[c["hoja_valor"].fillna(0).ne(0) | c["hist_valor"].fillna(0).ne(0)]
    a, b = c["hoja_valor"].fillna(0), c["hist_valor"].fillna(0)
    c["dif_pct"] = (b - a) / np.maximum(a.abs(), b.abs()).clip(lower=1)
    c["ok"] = c["dif_pct"].abs() <= tol
    return c


# ---------------------------------------------------------------------------
# Diagnostico de columnas clave (sin montos: solo si existe y % de filas con dato)
# ---------------------------------------------------------------------------

CLAVE = {
    "ANUAL": [("Id_Division", None), ("Nombre (DIVISIÓN)", "DIVISION"), ("Ventas VTA|año", "RE_ANO"), ("MARGEN", "MARGEN"),
              ("INGRESOS", "INGRESOS"), ("FONDO PREMIOS", "FONDO PREMIOS"), ("COMISIÓN", "COMISION"), ("GASTOS", "GASTOS"),
              ("ARRIENDO 100%", "ARRIENDO 100%"), ("ACCIÓN", "ACCION"), ("GESTIÓN", "GESTION"), ("TÉRMINO", "TERMINO"), ("AVISO", "AVISO")],
    "MENSUAL": [("Id_Division", None), ("Nombre (AGENCIA)", "AGENCIA"), ("DIRECCIÓN", "DIRECCION"), ("Zona (ZON)", "ZON"),
                ("Ventas mensuales", "RE_MES"), ("GASTOS", "GASTOS"), ("ACCIÓN", "ACCION")],
    "HISTORICO": [("Id_Division", None), ("Sucursal", "SUCURSAL"), ("HIPÓDROMO", "HIPODROMO")],
    "EN_PROCESO": [("Nombre (DIVISIÓN)", "DIVISION"), ("STATUS", "STATUS"), ("VIGENCIA", "VIGENCIA"), ("AVISO", "AVISO"), ("ACCIÓN", "ACCION")],
    "ARRIENDO": [("LOCAL", "LOCAL"), ("Meses AAAA_M", "RE_ARR")],
}


def diagnostico_columnas(hojas):
    filas = []
    for h in hojas:
        for etiqueta, col in CLAVE.get(h.tipo, []):
            if col is None:
                c = _col_id(h.df); cols = [c] if c else []
            elif col.startswith("RE_"):
                rx = {"RE_ANO": RE_ANO, "RE_MES": RE_MES, "RE_ARR": RE_ARR}[col]
                cols = [c for c in h.df.columns if rx.match(c)]
            else:
                cols = [c for c in h.df.columns if c.split("#")[0] == col]
            lleno = float(h.df[cols].notna().any(axis=1).mean()) if cols else 0.0
            filas.append({"hoja": h.nombre, "tipo": h.tipo, "campo": etiqueta, "encontrada": bool(cols),
                          "columna": cols[0] if len(cols) == 1 else (f"{len(cols)} columnas" if cols else ""), "filas_con_dato": round(lleno, 3)})
    return pd.DataFrame(filas)


# ---------------------------------------------------------------------------
# API principal
# ---------------------------------------------------------------------------

def _ipc_publico():
    return pd.read_csv(Path(__file__).parent / "datos_publicos" / "ipc_ine.csv", parse_dates=["mes"])[["mes", "var_mensual_pct"]]


def leer_rentabilidad(fuente, coordenadas=None, equivalencias=None, ipc=None, sobrescrituras=None):
    """Lee el Excel del cliente. Devuelve (Datos, InformeCarga).

    coordenadas: DataFrame o ruta CSV con sede_id, lat, lon (de geocodificar.py)
    equivalencias: dict o ruta CSV (nombre, sede_id) para nombres de EN PROCESO y CTA ARRIENDO
    ipc: DataFrame (mes, var_mensual_pct). Por defecto la serie publica del INE incluida.
    """
    cfg = construir_config(sobrescrituras)
    tol = cfg["tolerancia_cuadre"]
    hoy = pd.Timestamp(cfg["fecha_referencia"]) if cfg["fecha_referencia"] else pd.Timestamp.today().normalize()
    hojas, problemas = leer_libro(fuente)
    inf = InformeCarga(problemas=problemas)
    inf.hojas = pd.DataFrame([{"hoja": h.nombre, "tipo": h.tipo, "ano": h.ano, "filas": len(h.df)} for h in hojas])
    por_tipo = lambda t: sorted([h for h in hojas if h.tipo == t], key=lambda h: h.ano or 0)

    if isinstance(equivalencias, (str, Path)) or hasattr(equivalencias, "read"):
        e = pd.read_csv(equivalencias, dtype=str).dropna(subset=["nombre", "sede_id"])
        equivalencias = dict(zip(e["nombre"], e["sede_id"].str.strip()))
    if isinstance(coordenadas, (str, Path)) or hasattr(coordenadas, "read"):
        coordenadas = pd.read_csv(coordenadas, dtype={"sede_id": str})

    # --- Ventas diarias -> mensuales ---
    diario, nombres_hist = None, pd.DataFrame()
    for h in por_tipo("HISTORICO"):
        d, n = _ventas_historico(h, inf)
        diario = d if diario is None else pd.concat([diario, d]).groupby(["sede_id", "fecha", "hipodromo"], as_index=False)["venta"].sum()
        nombres_hist = n if nombres_hist.empty else nombres_hist.combine_first(n)
    if diario is None:
        raise ValueError("No se encontro la hoja de ventas historicas diarias (VTA HIST)")
    corte = pd.Timestamp(cfg["fecha_corte"]) if cfg["fecha_corte"] else _mes_corte(diario)
    cfg["fecha_corte"] = str(corte.date())
    ventas = _mensual_desde_diario(diario)
    ventas = ventas[ventas["mes"] <= corte]

    # --- Atributos por sede (lo mas reciente manda) ---
    attrs = {}
    def poner(sid, **kv):
        a = attrs.setdefault(sid, {})
        for k, v in kv.items():
            if v is not None and not (isinstance(v, float) and np.isnan(v)) and v is not pd.NaT and str(v).strip() != "":
                a[k] = v
    for sid, r in nombres_hist.iterrows():
        poner(sid, nombre=r.get("sucursal"), zona_cliente=r.get("ubicacion"))
    for h in por_tipo("ANUAL") + por_tipo("MENSUAL"):          # anual y luego mensual, de antiguo a reciente
        cid = _col_id(h.df)
        if not cid:
            inf.problemas.append(Problema("ERROR", h.nombre, "no se encontro columna de Id_Division con formato 000.000.000"))
            continue
        malos = h.df[cid].dropna().astype(str).str.strip()
        malos = malos[~malos.str.match(RE_ID)]
        if len(malos):
            inf.problemas.append(Problema("AVISO", h.nombre, f"{len(malos)} Id_Division con formato raro, se ignoran"))
        for _, r in h.df.iterrows():
            sid = str(r[cid]).strip()
            if not RE_ID.match(sid):
                continue
            g = lambda k: r.get(k)
            if h.tipo == "ANUAL":
                poner(sid, nombre=g("DIVISION"), zona_cliente=g("COMUNIDAD"), asociacion=g("ASOCIACION"),
                      gestion=g("GESTION"), operador=g("OPERADOR"), arrendador=g("ARRENDADOR"), accion=g("ACCION"),
                      termino_anual=a_fecha(g("TERMINO")), aviso_anual_dias=a_dias(g("AVISO")),
                      # P&L real del ano de la hoja (MARGEN = COMISION - GASTOS segun las identidades del informe)
                      margen_hoja=_num1(g("MARGEN")), ingresos_hoja=_num1(g("INGRESOS")), comision_hoja=_num1(g("COMISION")),
                      gastos_hoja=_num1(g("GASTOS")), ano_margen=h.ano,
                      **{f"ppr_{k[4:]}": _num1(g(k)) for k in h.df.columns if k.startswith("PPR ")})
            else:
                fecha_arr = [a_fecha(r[c]) for c in h.df.columns if c.split("#")[0] == "ARRIENDO" and isinstance(r[c], (datetime, pd.Timestamp, str))]
                fecha_arr = [f for f in fecha_arr if pd.notna(f)]
                poner(sid, nombre=g("AGENCIA"), zona_cliente=g("ZON"), direccion=g("DIRECCION"), gestion=g("GESTION"),
                      accion=g("ACCION"), termino_mensual=fecha_arr[-1] if fecha_arr else None)

    # Costos: arriendo y otros fijos del ultimo ano completo
    anuales = por_tipo("ANUAL")
    if anuales:
        ha = anuales[-1]
        cid = _col_id(ha.df)
        arr = _num(ha.df.get("ARRIENDO 100%", pd.Series(dtype=float)))
        gas = _num(ha.df.get("GASTOS", pd.Series(dtype=float)))
        # COMISION (venta x 3,1%) es un costo variable que va dentro de GASTOS: no es un gasto fijo de la sede
        com = _num(ha.df.get("COMISION", ha.df.get("COMISIÓN", pd.Series(0.0, index=ha.df.index)))).fillna(0.0)
        for sid, a, g_, c_ in zip(ha.df[cid].astype(str).str.strip(), arr.reindex(ha.df.index), gas.reindex(ha.df.index), com.reindex(ha.df.index)):
            poner(sid, arriendo_anual_hoja=a, otros_fijos_anual_clp=max(0.0, g_ - a - c_) if pd.notna(g_) and pd.notna(a) else np.nan,
                  fuente_costos=ha.nombre)
    # Gastos fijos del ano en curso (hoja mensual mas reciente, Y 2026): manda sobre la anual porque es mas reciente y trae
    # mas partidas. GASTOS = ARRIENDO + GGCC + MANT + ASEO EXT + SEG EXT + ENLACE + SENAL TV + OTROS + COMISION (promedios
    # mensuales). El arriendo sale de CTA ARRIENDO. La COMISION es VTA|X x 3,2% (variable, ya en la tasa neta) salvo en
    # sedes con un monto fijo mensual: lo que excede el 3,2% de su venta es un gasto fijo.
    mensuales = por_tipo("MENSUAL")
    if mensuales:
        hm = mensuales[-1]
        cid = _col_id(hm.df)
        partidas = [c for c in ("GGCC", "MANT", "ASEO EXT", "SEG EXT", "ENLACE", "SENAL TV", "OTROS") if c in hm.df.columns]
        cols_venta = [c for c in hm.df.columns if c.split("|")[0] in HIPODROMOS and c.endswith("|X")]
        if cid and partidas and "GASTOS" in hm.df.columns:
            num = {c: _num(hm.df[c]).fillna(0.0) for c in partidas + cols_venta + ["COMISION", "GASTOS"] if c in hm.df.columns}
            venta = sum((num[c] for c in cols_venta), pd.Series(0.0, index=hm.df.index))
            tasa = cfg.get("tasa_comision_venta", 0.032)
            for i, sid in hm.df[cid].astype(str).str.strip().items():
                if not RE_ID.match(sid) or not (num["GASTOS"][i] > 0):
                    continue
                com_i = num.get("COMISION", pd.Series(0.0, index=hm.df.index))[i]
                fija = com_i - tasa * venta[i] if venta[i] > 0 and com_i > 1.05 * tasa * venta[i] else 0.0
                poner(sid, otros_fijos_anual_clp=12.0 * (sum(num[c][i] for c in partidas) + fija),
                      comision_fija_anual_clp=12.0 * fija, fuente_costos=hm.nombre)
            # Arriendo al 100% (lo que pagan ambos hipodromos): columna ARRIENDO numerica de la hoja mensual. CTA ARRIENDO
            # registra la parte de un hipodromo (la mitad) y solo se usa si la sede no esta en esta hoja.
            col_arr = next((c for c in hm.df.columns if c.split("#")[0] == "ARRIENDO" and _num(hm.df[c]).notna().mean() > 0.5), None)
            if col_arr:
                arr_m = _num(hm.df[col_arr])
                for i, sid in hm.df[cid].astype(str).str.strip().items():
                    if RE_ID.match(sid) and arr_m[i] > 0:
                        poner(sid, arriendo_hoja_mensual=float(arr_m[i]))

    nombres_por_id = {sid: [a.get("nombre")] for sid, a in attrs.items()}
    for sid, r in nombres_hist.iterrows():
        nombres_por_id.setdefault(sid, []).append(r.get("sucursal"))
    resolver = Resolutor(nombres_por_id, equivalencias)

    # --- CTA ARRIENDO ---
    arriendo_mes = None
    for h in por_tipo("ARRIENDO"):
        cols = [c for c in h.df.columns if RE_ARR.match(c)]
        df = h.df[["LOCAL"] + cols].dropna(subset=["LOCAL"])
        df = df[~df["LOCAL"].astype(str).map(norm).str.startswith("TOTAL")]
        df["sede_id"] = [resolver(n, h.nombre) for n in df["LOCAL"]]
        largo = df.dropna(subset=["sede_id"]).melt(id_vars=["LOCAL", "sede_id"], value_vars=cols, var_name="col", value_name="arriendo")
        largo["mes"] = pd.to_datetime(largo["col"].str.replace("_", "-") + "-01", format="%Y-%m-%d")
        largo["arriendo"] = _num(largo["arriendo"])
        arriendo_mes = largo.groupby(["sede_id", "mes"], as_index=False)["arriendo"].sum()
    if arriendo_mes is not None and len(arriendo_mes):
        for sid, g_ in arriendo_mes.groupby("sede_id"):
            g_ = g_.sort_values("mes")
            vig = g_[(g_["mes"] <= corte) & (g_["arriendo"] > 0)]
            pos = g_[g_["arriendo"] > 0]
            ultimo = pos["mes"].max() if len(pos) else pd.NaT
            poner(sid, arriendo_mensual_clp=vig["arriendo"].iloc[-1] if len(vig) else np.nan,
                  fuente_arriendo="CTA ARRIENDO",
                  fin_pagos_arriendo=(ultimo + pd.offsets.MonthEnd(0)) if pd.notna(ultimo) and ultimo < g_["mes"].max() else None)

    # --- EN PROCESO (manda en cierres) ---
    for h in por_tipo("EN_PROCESO"):
        for _, r in h.df.dropna(subset=["DIVISION"]).iterrows():
            sid = resolver(r["DIVISION"], h.nombre)
            if sid is None:
                continue
            # La ACCION de las hojas anual y mensual manda; EN PROCESO la guarda aparte (casi siempre dice "EVALUAR CIERRE")
            poner(sid, status=r.get("STATUS"), accion_en_proceso=r.get("ACCION"),
                  vigencia_en_proceso=a_fecha(r.get("VIGENCIA")), aviso_en_proceso_dias=a_dias(r.get("AVISO")),
                  operador=r.get("OPERADOR"), arrendador=r.get("ARRENDADOR"))

    # --- Tabla SEDES ---
    sedes = pd.DataFrame.from_dict(attrs, orient="index")
    sedes.index.name = "sede_id"
    sedes["sede_id"] = sedes.index
    for col in ("nombre", "zona_cliente", "asociacion", "gestion", "accion", "status", "direccion",
                "arriendo_mensual_clp", "arriendo_anual_hoja", "otros_fijos_anual_clp", "fuente_arriendo", "fuente_costos", "comision_fija_anual_clp"):
        if col not in sedes.columns:
            sedes[col] = np.nan
    if "accion_en_proceso" in sedes.columns:      # sede sin ACCION en las hojas anual y mensual: la de EN PROCESO
        sedes["accion"] = sedes["accion"].where(sedes["accion"].notna(), sedes["accion_en_proceso"])
    if "arriendo_hoja_mensual" in sedes.columns:   # la hoja mensual (100%) manda sobre CTA ARRIENDO (parte de un hipodromo)
        hay = pd.to_numeric(sedes["arriendo_hoja_mensual"], errors="coerce") > 0
        sedes.loc[hay, "arriendo_mensual_clp"] = pd.to_numeric(sedes.loc[hay, "arriendo_hoja_mensual"])
        sedes.loc[hay, "fuente_arriendo"] = "hoja mensual (100%)"
    falta_arr = sedes["arriendo_mensual_clp"].isna() & sedes["arriendo_anual_hoja"].notna()
    sedes.loc[falta_arr, "arriendo_mensual_clp"] = sedes.loc[falta_arr, "arriendo_anual_hoja"] / 12
    sedes.loc[falta_arr, "fuente_arriendo"] = "hoja anual / 12"

    txt = lambda c: sedes[c].astype("string").map(lambda x: norm(x) if pd.notna(x) else "")
    gestion, accion, status, asoc, zona = txt("gestion"), txt("accion"), txt("status"), txt("asociacion"), txt("zona_cliente")
    vendido = accion.eq("VENDIDO")
    cerrada = gestion.str.contains("CERRAD") | accion.eq("CERRADO") | status.eq("CERRADO") | (vendido & (not cfg["vendido_sigue_operando"]))
    sedes["estado"] = np.where(cerrada, "CERRADA", "VIGENTE")
    # Sedes excluidas del analisis por falta de informacion: no entran a la red, al plan ni al VAN
    sedes.loc[sedes.index.isin(cfg.get("sedes_excluidas", [])), "estado"] = "EXCLUIDA"
    # Códigos sin sede, no se analizan: "DISPONIBLE" (división sin sede asignada) o sin nombre y sin ventas nunca
    disponible = txt("nombre").str.startswith("DISPONIBLE")
    fantasma = txt("nombre").eq("") & ~sedes.index.isin(set(ventas.loc[ventas["venta_nominal_clp"] > 0, "sede_id"]))
    sedes["motivo_sin_sede"] = np.where(disponible, "Rotulado DISPONIBLE", np.where(fantasma, "Sin nombre y sin ventas", None))
    sedes.loc[disponible | fantasma, "estado"] = "DISPONIBLE"
    if (disponible | fantasma).any():
        inf.problemas.append(Problema("AVISO", "SEDES", f"{int((disponible | fantasma).sum())} códigos sin sede (DISPONIBLE o sin nombre ni ventas), no se analizan"))
    sedes.loc[vendido & cfg["vendido_sigue_operando"], "arriendo_mensual_clp"] = 0.0
    sedes.loc[vendido & cfg["vendido_sigue_operando"], "otros_fijos_anual_clp"] = 0.0

    # Coordenadas y grupo
    sedes["lat"], sedes["lon"], sedes["comuna"], sedes["region"] = np.nan, np.nan, np.nan, np.nan
    if coordenadas is not None and len(coordenadas):
        co = coordenadas.drop_duplicates("sede_id", keep="last").set_index("sede_id")
        for c in ("lat", "lon", "comuna", "region"):
            if c in co.columns:
                sedes[c] = sedes.index.map(co[c])
        if "calidad" in co.columns:
            sedes["calidad_ubicacion"] = sedes.index.map(co["calidad"])
        sedes["lat"] = pd.to_numeric(sedes["lat"], errors="coerce")
        sedes["lon"] = pd.to_numeric(sedes["lon"], errors="coerce")
    digital = asoc.str.contains("VIRTUAL") | zona.str.contains("VIRTUAL") | accion.eq("VIRTUAL")
    dist_stgo = haversine_km(sedes["lat"].astype(float), sedes["lon"].astype(float), *SANTIAGO)
    es_rm = np.where(sedes["lat"].notna(), dist_stgo <= cfg["radio_rm_km"], zona.str.startswith("SANTIAGO"))
    sedes["grupo"] = np.where(digital, "DIGITAL", np.where(es_rm, "RM", "REGIONES"))
    sedes.loc[sedes.index.isin(cfg["sedes_g9"]) & ~digital, "grupo"] = "G9"

    # Contrato: EN PROCESO > hoja mensual > hoja anual > fin de pagos en CTA ARRIENDO
    venc = pd.Series(pd.NaT, index=sedes.index, dtype="datetime64[ns]")
    for c in ("fin_pagos_arriendo", "termino_anual", "termino_mensual", "vigencia_en_proceso"):  # de menor a mayor prioridad
        if c in sedes.columns:
            venc = pd.to_datetime(sedes[c], errors="coerce").combine_first(venc)
    sedes["vencimiento_contrato"] = venc
    aviso = sedes.get("aviso_en_proceso_dias", pd.Series(np.nan, index=sedes.index)).combine_first(
        sedes.get("aviso_anual_dias", pd.Series(np.nan, index=sedes.index)))
    sedes["aviso_termino_meses"] = aviso / 30.44
    sedes["fecha_limite_aviso"] = venc - pd.to_timedelta(aviso, unit="D")

    # Cierres decididos por la gerencia: son un hecho, no una opcion del modelo.
    # ACCION "CIERRE 20XX" de la hoja mensual (o anual), salvo que EN PROCESO la saque de la lista; o carta de termino
    # enviada (STATUS "CARTA OK ...") en una sede que no esta renegociada (ahi la carta es de la renegociacion).
    acc_ep = txt("accion_en_proceso") if "accion_en_proceso" in sedes.columns else pd.Series("", index=sedes.index)
    sacada = acc_ep.str.startswith("SACAR DE LA LISTA")
    ano_cierre = accion.str.extract(r"^CIERRE\s*(20\d\d)")[0].astype(float).where(~sacada)
    carta = status.str.startswith("CARTA OK") & ~accion.str.startswith("RENEGOCIAD") & ~sacada
    decidido = (ano_cierre.notna() | carta) & (sedes["estado"] == "VIGENTE")
    fecha_dec = pd.Series(pd.NaT, index=sedes.index, dtype="datetime64[ns]")
    for sid in sedes.index[decidido]:
        v, a = venc.get(sid), ano_cierre.get(sid)
        if pd.notna(a):    # el ano lo fija la gerencia; el dia, el contrato si vence ese ano
            fecha_dec[sid] = v if pd.notna(v) and v.year == int(a) else pd.Timestamp(int(a), 12, 31)
        else:
            fecha_dec[sid] = v
    sedes["cierre_decidido"] = decidido
    sedes["fecha_cierre_decidida"] = fecha_dec
    sedes["costo_cierre_clp"] = np.nan
    for c in ("fecha_apertura", "fecha_cierre", "m2"):
        sedes[c] = np.nan

    # Alertas de contrato
    filas = []
    for sid, r in sedes[sedes["estado"] == "VIGENTE"].iterrows():
        lim = r["fecha_limite_aviso"]
        st = norm(r["status"]) if pd.notna(r["status"]) else ""
        alerta = None
        if pd.notna(lim) and lim < hoy and not st.startswith("CARTA OK"):
            alerta = "PLAZO DE AVISO VENCIDO"
        elif pd.notna(lim) and lim <= hoy + pd.Timedelta(days=cfg["dias_alerta_aviso"]) and not st.startswith("CARTA OK"):
            alerta = "AVISO PROXIMO"
        elif st.startswith("CARTA OK"):
            alerta = "CIERRE COMPROMETIDO"
        fuentes = {c: r.get(c) for c in ("vigencia_en_proceso", "termino_mensual", "termino_anual", "fin_pagos_arriendo") if c in sedes.columns and pd.notna(r.get(c))}
        distintas = len({pd.Timestamp(v).to_period("M") for v in fuentes.values()}) > 1
        if alerta or distintas:
            filas.append({"sede_id": sid, "nombre": r["nombre"], "accion": r["accion"], "status": r["status"],
                          "vencimiento": r["vencimiento_contrato"], "limite_aviso": lim,
                          "alerta": alerta or "FECHAS DISTINTAS ENTRE HOJAS",
                          "fechas_por_fuente": "; ".join(f"{k}={pd.Timestamp(v).date()}" for k, v in fuentes.items()) if distintas else ""})
    inf.contratos = pd.DataFrame(filas)

    # Códigos DISPONIBLE: todo lo que el libro dice de ellos, para revisar si alguno era (o es) una sede real
    filas = []
    for sid in sedes.index[sedes["estado"] == "DISPONIBLE"]:
        v = ventas[ventas["sede_id"] == sid]
        v = v.groupby("mes")["venta_nominal_clp"].sum() if len(v) else pd.Series(dtype=float)
        v = v[v > 0]
        hist = nombres_hist["sucursal"].get(sid) if "sucursal" in nombres_hist else None
        en = [h.nombre for h in hojas if (c := _col_id(h.df)) and sid in set(h.df[c].dropna().astype(str).str.strip())]
        filas.append({"sede_id": sid, "motivo": sedes.at[sid, "motivo_sin_sede"], "nombre_en_ventas": hist if hist and norm(hist) != "DISPONIBLE" else None,
                      "zona": sedes.at[sid, "zona_cliente"], "hojas": ", ".join(en),
                      "primer_mes_venta": v.index.min() if len(v) else None, "ultimo_mes_venta": v.index.max() if len(v) else None,
                      "venta_12m_nominal": float(v[v.index > corte - pd.DateOffset(months=12)].sum()) if len(v) else 0.0,
                      "arriendo_mensual": sedes.at[sid, "arriendo_mensual_clp"], "gestion": sedes.at[sid, "gestion"],
                      "accion": sedes.at[sid, "accion"], "vencimiento": sedes.at[sid, "vencimiento_contrato"]})
    inf.disponibles = pd.DataFrame(filas)
    if len(inf.disponibles):
        activos = inf.disponibles[pd.to_datetime(inf.disponibles["ultimo_mes_venta"]) >= corte - pd.DateOffset(months=2)]
        if len(activos):
            inf.problemas.append(Problema("AVISO", "DISPONIBLES", f"{len(activos)} códigos DISPONIBLE con ventas en los últimos 3 meses: podrían ser sedes operando"))

    # Ventas de sedes desconocidas
    sin_ficha = sorted(set(ventas["sede_id"]) - set(sedes.index))
    if sin_ficha:
        inf.problemas.append(Problema("AVISO", "VTA HIST", f"{len(sin_ficha)} Id_Division con ventas pero sin ficha en Y 202X, se ignoran"))
        ventas = ventas[ventas["sede_id"].isin(sedes.index)]
    fisicas = sedes[(sedes["grupo"] != "DIGITAL") & (sedes["estado"] == "VIGENTE")]
    sin_coord = fisicas.index[fisicas["lat"].isna()].tolist()
    if sin_coord:
        inf.problemas.append(Problema("AVISO", "COORDENADAS", f"{len(sin_coord)} sedes vigentes sin coordenadas, quedan fuera del analisis de red"))
    sin_arr = fisicas.index[fisicas["arriendo_mensual_clp"].isna()].tolist()
    if sin_arr:
        inf.problemas.append(Problema("AVISO", "COSTOS", f"{len(sin_arr)} sedes vigentes sin arriendo, el modulo de economia las omite"))

    # IPC
    ipc = ipc if ipc is not None else _ipc_publico()
    falta_ipc = sorted(set(ventas["mes"]) - set(ipc["mes"]))
    if falta_ipc:
        inf.problemas.append(Problema("ERROR", "IPC", f"faltan {len(falta_ipc)} meses de IPC hasta {falta_ipc[-1].date()}, actualizar sedes/datos_publicos/ipc_ine.csv"))

    inf.cuadre = _cuadre(hojas, diario, tol)
    inf.identidades = pd.DataFrame([f for h in hojas for f in _identidades(h, inf, tol)])
    inf.columnas = diagnostico_columnas(hojas)
    falta = inf.columnas[~inf.columnas["encontrada"]] if len(inf.columnas) else inf.columnas
    for _, f in falta.iterrows():
        inf.problemas.append(Problema("AVISO", f["hoja"], f"no se encontró la columna {f['campo']}"))
    if not any(h.tipo == "ANUAL" for h in hojas):
        inf.problemas.append(Problema("AVISO", "LIBRO", "no se reconoció ninguna hoja anual (Y 202X con Id_Division y VTA|año): sin margen, arriendo ni términos de contrato"))
    inf.pendientes = pd.DataFrame(resolver.pendientes)
    inf.automaticas = pd.DataFrame(resolver.automaticas)
    inf.resumen = {
        "sedes": len(sedes), "vigentes": int((sedes["estado"] == "VIGENTE").sum()),
        "vigentes fisicas con coordenadas": int(fisicas["lat"].notna().sum()),
        "ventas diarias": f"{diario['fecha'].min().date()} a {diario['fecha'].max().date()}",
        "mes de corte": str(corte.date()),
        "cuadres fuera de tolerancia": int((~inf.cuadre["ok"]).sum()) if len(inf.cuadre) else 0,
        "nombres sin resolver": len(inf.pendientes),
    }
    if len(inf.cuadre) and (~inf.cuadre["ok"]).any():
        inf.problemas.append(Problema("AVISO", "CUADRE", f"{int((~inf.cuadre['ok']).sum())} comparaciones fuera de tolerancia {tol:.1%}, ver hoja 'cuadre'"))
    if len(inf.pendientes):
        inf.problemas.append(Problema("AVISO", "NOMBRES", f"{len(inf.pendientes)} nombres de EN PROCESO o CTA ARRIENDO sin cruzar: elegir la sede en el informe de carga"))

    dist = matriz_distancias(sedes, None, cfg["factor_ruta"], inf.problemas)
    datos = Datos(sedes=sedes, ventas=ventas.reset_index(drop=True), ipc=ipc.sort_values("mes").reset_index(drop=True),
                  distancias=dist, config=cfg, problemas=inf.problemas)
    return datos, inf


def direcciones(fuente):
    """Direcciones por sede para geocodificar: de la hoja mensual mas reciente y, si no hay, el nombre."""
    hojas, _ = leer_libro(fuente)
    filas = []
    for h in sorted([h for h in hojas if h.tipo == "MENSUAL"], key=lambda h: h.ano or 0):
        cid = _col_id(h.df)
        if cid and "DIRECCION" in h.df.columns:
            for _, r in h.df.iterrows():
                filas.append({"sede_id": str(r[cid]).strip(), "nombre": r.get("AGENCIA"),
                              "zona": r.get("ZON"), "direccion": r.get("DIRECCION")})
    df = pd.DataFrame(filas, columns=["sede_id", "nombre", "zona", "direccion"])
    df = df[df["sede_id"].str.match(RE_ID) & df["direccion"].notna()].drop_duplicates("sede_id", keep="last")
    df["tipo"] = "direccion"
    # Sedes sin direccion (p. ej. cerradas que ya no estan en la hoja mensual): se ubican por su nombre
    nombres = {}
    for h in sorted(hojas, key=lambda h: h.ano or 0):
        cid = _col_id(h.df)
        col_n = {"ANUAL": "DIVISION", "HISTORICO": "SUCURSAL", "MENSUAL": "AGENCIA"}.get(h.tipo)
        if not cid or col_n not in h.df.columns:
            continue
        zona = {"ANUAL": "COMUNIDAD", "HISTORICO": "UBICACION", "MENSUAL": "ZON"}[h.tipo]
        for _, r in h.df.iterrows():
            sid = str(r[cid]).strip()
            if RE_ID.match(sid) and pd.notna(r[col_n]):
                nombres[sid] = (r[col_n], r.get(zona))
    extra = []
    for sid, (nom, zona) in nombres.items():
        q = norm_nombre(nom, quitar_genericos=True)
        if sid in set(df["sede_id"]) or not q or q in ("DISPONIBLE", "VIRTUAL") or "VIRTUAL" in q:
            continue
        extra.append({"sede_id": sid, "nombre": nom, "zona": zona, "direccion": q.title(), "tipo": "nombre"})
    return pd.concat([df, pd.DataFrame(extra)], ignore_index=True)
