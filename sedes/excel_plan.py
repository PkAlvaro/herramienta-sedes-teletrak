"""Excel del plan de cierres con la identidad de la herramienta (franja azul y logos), formulas vivas y graficos.

Lo arma el navegador (Pyodide) con los datos que entrega la herramienta: las sedes que cierran (Datos), los supuestos,
los criterios del score de toda la red, los escenarios de Monte Carlo y el tornado de sensibilidad. Todo lo que se puede
recalcular va como formula (VAN, flujos, valor terminal, score y categoria de la matriz, flexibilidad, equilibrio);
la retencion Huff y Censo, los escenarios y el tornado van como valores de la herramienta. Montos en millones de pesos
reales.
"""
import base64
import io
import json
from datetime import date

from openpyxl import Workbook
from openpyxl.chart import BarChart, LineChart, Reference
from openpyxl.formatting.rule import FormulaRule
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter as col
from openpyxl.workbook.defined_name import DefinedName

AZUL, NARANJO, GRIS, TINTA, FONDO, LINEA, ROJO = "003058", "C2410C", "5B6B7D", "0F1B2D", "F4F6F9", "E2E7EE", "B42318"
MM, MM1, PC, PC0, FE = '#,##0;[Red]-#,##0', '#,##0.0;[Red]-#,##0.0', '0.0%', '0%', 'mmm-yyyy'
F_TIT = Font(name="Calibri", size=20, bold=True, color="FFFFFF")
F_SUB = Font(name="Calibri", size=11, color="C9D6E4")
F_CAB = Font(name="Calibri", size=10, bold=True, color="FFFFFF")
F_NEG = Font(name="Calibri", size=11, bold=True, color=TINTA)
RELL_AZUL, RELL_FONDO = PatternFill("solid", fgColor=AZUL), PatternFill("solid", fgColor=FONDO)
BORDE_INF = Border(bottom=Side(style="thin", color=LINEA))
CENTRO, DER = Alignment(horizontal="center", vertical="center", wrap_text=True), Alignment(horizontal="right", vertical="center")
MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"]
H = 6   # fila de encabezados en las hojas con franja (filas 1 a 4 franja, 5 en blanco)


def fecha(ym):
    return date(int(ym[:4]), int(ym[5:7]), 1) if ym else None


def nombre(wb, n, ref):
    wb.defined_names[n] = DefinedName(n, attr_text=ref)


# ---------------------------------------------------------------------------------------------------------------- formato
def chips(logos):
    """Logos sobre un recuadro blanco, como en la franja de la herramienta. None si no hay Pillow."""
    try:
        from PIL import Image as PImg
        from openpyxl.drawing.image import Image as XImg
    except Exception:
        return []
    out = []
    for b in logos or []:
        if not b:
            continue
        try:
            XImg(io.BytesIO(base64.b64decode(b)))   # openpyxl sin Pillow detectado: sin logos
        except Exception:
            return []
        im = PImg.open(io.BytesIO(base64.b64decode(b))).convert("RGBA")
        alto = 52
        im = im.resize((int(im.width * alto / im.height), alto))
        fondo = PImg.new("RGBA", (im.width + 28, alto + 16), (255, 255, 255, 255))
        fondo.alpha_composite(im, (14, 8))
        buf = io.BytesIO()
        fondo.convert("RGB").save(buf, format="PNG")
        buf.seek(0)
        out.append((XImg(buf), fondo.width, fondo.height))
    return out


def franja(ws, titulo, subtitulo, ncols, logos):
    """Franja azul de la herramienta: logos a la izquierda, titulo en blanco."""
    for r in range(1, 5):
        ws.row_dimensions[r].height = 21
        for c in range(1, max(ncols, 12) + 1):
            ws.cell(r, c).fill = RELL_AZUL
    ancho_px, x = 0, 10
    for img, w, h in chips(logos):
        img.anchor = None
        from openpyxl.drawing.spreadsheet_drawing import AnchorMarker, OneCellAnchor
        from openpyxl.drawing.xdr import XDRPositiveSize2D
        from openpyxl.utils.units import pixels_to_EMU
        # columna donde cae x (ancho de columna en px ~ caracteres x 7 + 5) y el desplazamiento dentro de ella
        c0, x0 = 0, x
        while x0 >= (ws.column_dimensions[col(c0 + 1)].width or 8.43) * 7 + 5:
            x0 -= (ws.column_dimensions[col(c0 + 1)].width or 8.43) * 7 + 5
            c0 += 1
        a = OneCellAnchor(_from=AnchorMarker(col=c0, colOff=pixels_to_EMU(int(x0)), row=0, rowOff=pixels_to_EMU(14)), ext=XDRPositiveSize2D(pixels_to_EMU(w), pixels_to_EMU(h)))
        img.anchor = a
        ws.add_image(img)
        x += w + 12
        ancho_px = x
    # el titulo va en la primera columna que empieza despues de los logos
    acum, c_tit = 0, 1
    for c in range(1, 60):
        if acum >= ancho_px + 16:
            c_tit = c
            break
        acum += (ws.column_dimensions[col(c)].width or 9) * 7.2
    ws.cell(2, c_tit, titulo).font = F_TIT
    ws.cell(3, c_tit, subtitulo).font = F_SUB
    ws.sheet_view.showGridLines = False


def encabezado(ws, fila, titulos, anchos=None):
    for c, t in enumerate(titulos, 1):
        x = ws.cell(fila, c, t)
        x.font, x.fill, x.alignment = F_CAB, RELL_AZUL, CENTRO
    ws.row_dimensions[fila].height = 32
    for c, w in enumerate(anchos or [], 1):
        ws.column_dimensions[col(c)].width = w


def poner(ws, r, c, v, fmt=None, font=None, align=None):
    x = ws.cell(r, c, v)
    if fmt:
        x.number_format = fmt
    if font:
        x.font = font
    if align:
        x.alignment = align
    return x


def filas_claras(ws, r0, r1, ncols):
    for r in range(r0, r1 + 1):
        for c in range(1, ncols + 1):
            ws.cell(r, c).border = BORDE_INF


# --------------------------------------------------------------------------------------------------------------- formulas
def van_k(id_ref, k, fecha_cierre, f):
    """VAN de cerrar la sede de id_ref en el mes del plan k (fecha_cierre), f = su fila en Datos. Igual a vanDesdeBase."""
    ix = lambda c: f"INDEX(Datos!${c}:${c},{f})"
    desde = f'Flujos!$A:$A,{id_ref},Flujos!$C:$C,">="&{k}'
    costo = (f'MAX({ix("AC")},IF({ix("AF")}="",SalidaSinContrato,IF({fecha_cierre}>={ix("AF")},SalidaVencido,{ix("AH")}))*{ix("AA")})'
             f'*(1+TasaMes)^-(MIN({k},{ix("AI")}-1)+1)')
    return (f"(SUMIFS(Flujos!$M:$M,{desde})+INDEX('Valor terminal'!$I:$I,{f})-SUMIFS(Flujos!$N:$N,{desde})"
            f"-INDEX('Valor terminal'!$J:$J,{f})-{costo})*(1-Impuesto)")


# ------------------------------------------------------------------------------------------------------------------ libro
def construir(d):
    wb = Workbook()
    filas, red, logos = d["filas"], d["red"], d["logos"]
    for x in filas:   # un Float64Array llega como objeto {"0": ...}
        if isinstance(x.get("mc"), dict):
            x["mc"] = [x["mc"][k] for k in sorted(x["mc"], key=int)]
    n, S = len(filas), d["supuestos"]
    plan = [x for x in filas if x["tipo"] == "Plan"]
    hojas = {}
    for t in ["Resumen", "Calendario", "Estrategia", "Simulación", "Sensibilidad", "Flexibilidad", "Equilibrio", "Optimizador",
              "Flujos anuales", "Supuestos", "Datos", "Flujos", "Valor terminal", "Escenarios"]:
        hojas[t] = wb.active if t == "Resumen" else wb.create_sheet(t)
        hojas[t].title = t
    for t, c in [("Resumen", NARANJO), ("Calendario", AZUL), ("Estrategia", AZUL), ("Simulación", AZUL), ("Sensibilidad", AZUL), ("Flexibilidad", AZUL),
                 ("Equilibrio", AZUL), ("Optimizador", AZUL), ("Flujos anuales", AZUL)]:
        hojas[t].sheet_properties.tabColor = c

    # ------------------------------------------------------------------ Supuestos
    ws = hojas["Supuestos"]
    sup = [
        ("Tasa de descuento nominal", "TasaNominal", S["tasa"], "0.00%"), ("Inflación", "Inflacion", S["inflacion"], PC),
        ("Tasa de descuento real", "TasaReal", "=(1+TasaNominal)/(1+Inflacion)-1", "0.00%"), ("Tasa mensual", "TasaMes", "=(1+TasaReal)^(1/12)-1", "0.000%"),
        ("Impuesto", "Impuesto", S["impuesto"], PC), ("Comisión variable", "ComisionVariable", S["comision"], PC),
        ("Ingreso legal HCH", "TasaHCH", S["tasas"]["HCH"], PC), ("Ingreso legal CHS", "TasaCHS", S["tasas"]["CHS"], PC),
        ("Ingreso legal VSC", "TasaVSC", S["tasas"]["VSC"], PC), ("Ingreso legal CHC", "TasaCHC", S["tasas"]["CHC"], PC),
        ("Costo del canal online", "CostoOnline", S["online"], PC), ("Persistencia de la tendencia hasta 2036", "PhiPlan", S["phiPlan"], "0.00"),
        ("Persistencia de la tendencia después de 2036", "PhiTerminal", S["phiTerminal"], "0.00"), ("Alza real arriendo", "AlzaArriendo", S["alzaArr"], PC),
        ("Alza real otros gastos", "AlzaOtros", S["alzaOtr"], PC), ("Inicio del plan", "InicioPlan", fecha(d["inicio"]), FE),
        ("Primer año proyectado", "AnoBase", d["anoBase"], "0"), ("Meses de arriendo para salir con contrato vencido", "SalidaVencido", S["salidaVencido"], "0.0"),
        ("Meses de arriendo para salir sin contrato", "SalidaSinContrato", S["salidaSin"], "0.0"),
        ("Escenarios con VAN positivo exigidos para cerrar", "ProbMin", d["probMin"], PC0),
        ("Peso del volumen en el score", "PesoVol", d["pesos"]["vol"], PC0), ("Peso del arriendo en el score", "PesoArr", d["pesos"]["efic"], PC0),
        ("Peso de la tendencia en el score", "PesoTend", d["pesos"]["tend"], PC0), ("Score alto desde", "CorteAlto", d["umbrales"]["alto"], "0"),
        ("Score bajo hasta", "CorteBajo", d["umbrales"]["bajo"], "0"),
    ]
    encabezado(ws, 1, ["Supuesto", "Valor"], [50, 14])
    for i, (t, nm, v, fm) in enumerate(sup, 2):
        poner(ws, i, 1, t)
        poner(ws, i, 2, v, fm, F_NEG).fill = PatternFill("solid", fgColor="FFF4ED")
        nombre(wb, nm, f"Supuestos!$B${i}")
    nr = len(red)
    q = lambda fr: int(fr * (nr - 1)) + 1
    for j, (t, nm, fr) in enumerate([("Margen, límite del tercio bajo", "MargenT1", 1 / 3), ("Margen, límite del tercio alto", "MargenT2", 2 / 3), ("Margen, mediana de la red", "MargenMed", 0.5)]):
        r = len(sup) + 3 + j
        poner(ws, r, 1, t)
        poner(ws, r, 2, f"=SMALL(Estrategia!$H${H + 1}:$H${H + nr},{q(fr)})", MM1)
        nombre(wb, nm, f"Supuestos!$B${r}")
    poner(ws, len(sup) + 7, 1, "Montos en millones de pesos reales. Las celdas en naranjo claro se pueden cambiar.", font=Font(italic=True, color=GRIS))
    ws.freeze_panes = "A2"

    # ------------------------------------------------------------------ Datos (sedes que cierran)
    ws = hojas["Datos"]
    cab = ["Id", "Sede", "Gestión", "Zona remota", "Venta año 1", *[f"Peso {m}" for m in MESES], "Tendencia anual", "Tendencia usada", "Mix HCH", "Mix CHS", "Mix VSC", "Mix CHC",
           "Margen", "Margen HCH", "Margen CHS", "Arriendo mensual", "Otros gastos mensual", "Costo de cierre", "Retención física", "Retención digital",
           "Vencimiento contrato", "Meses de aviso", "Meses de salida antes del vencimiento", "Meses del plan"]
    encabezado(ws, 1, cab, [12, 20, 8, 7, 11, *[7] * 12, 9, 9, 8, 8, 8, 8, 8, 9, 9, 10, 10, 10, 10, 10, 11, 8, 11, 8])
    for i, x in enumerate(filas, 2):
        R = i
        vals = [x["id"], x["nombre"], x["gestion"], x["remota"], x["venta0"], *x["pesos"], x["tend"], f"=MAX(-0.12,MIN(0.05,R{R}))",
                x["mix"]["HCH"], x["mix"]["CHS"], x["mix"]["VSC"], x["mix"]["CHC"],
                f"=T{R}*TasaHCH+U{R}*TasaCHS+V{R}*TasaVSC+W{R}*TasaCHC-ComisionVariable", f"=T{R}*(TasaHCH-ComisionVariable)", f"=U{R}*(TasaCHS-ComisionVariable)",
                x["arr"], x["otr"], x["costo"], x["fis"], x["md"], fecha(x["venc"]), x["aviso"], x["salida"], f"=COUNTIF(Flujos!$A:$A,A{R})"]
        fms = [None, None, None, "0", MM1, *[PC] * 12, PC, PC, PC, PC, PC, PC, "0.00%", "0.00%", "0.00%", MM1, MM1, MM1, PC, PC, FE, "0", "0.0", "0"]
        for c, (v, fm) in enumerate(zip(vals, fms), 1):
            poner(ws, R, c, v, fm)
    ws.freeze_panes = "C2"

    # ------------------------------------------------------------------ Flujos (sede x mes)
    ws = hojas["Flujos"]
    cab = ["Id", "Fila", "Mes del plan", "Mes", "Año", "Nivel de venta", "Venta", "Ingreso perdido", "Recupera física", "Recupera digital", "Gastos ahorrados",
           "Factor de descuento", "Ahorro descontado", "Pérdida neta descontada", "Pérdida neta", "Año calendario", "Tipo", "Cerrada"]
    encabezado(ws, 1, cab, [12, 5, 7, 9, 5, 8, 9, 9, 9, 9, 9, 9, 10, 10, 9, 8, 9, 7])
    r = 2
    for x in filas:
        for k in range(x["n"]):
            R = r
            ix = lambda c: f"INDEX(Datos!${c}:${c},$B{R})"
            vals = [x["id"], f"=MATCH(A{R},Datos!$A:$A,0)", k, f"=EDATE(InicioPlan,C{R})", f"=MAX(0,YEAR(D{R})-AnoBase)",
                    f"=IF(E{R}=0,1,IF(E{R}=E{R - 1},F{R - 1},F{R - 1}*MAX(0.2,MIN(2,1+{ix('S')}*PhiPlan^E{R}))))",
                    f"={ix('E')}*INDEX(Datos!$F:$Q,$B{R},MONTH(D{R}))*F{R}", f"=G{R}*{ix('X')}", f"=H{R}*{ix('AD')}",
                    f"=H{R}*(1-{ix('AD')})*{ix('AE')}*(1-CostoOnline)",
                    f"={ix('AA')}*(1+AlzaArriendo)^(E{R}+1)+{ix('AB')}*(1+AlzaOtros)^(E{R}+1)", f"=(1+TasaMes)^-(C{R}+1)",
                    f"=K{R}*L{R}", f"=O{R}*L{R}", f"=H{R}-I{R}-J{R}", f"=YEAR(D{R})",
                    f"=INDEX(Calendario!$D:$D,MATCH($A{R},Calendario!$B:$B,0))", f"=IF(C{R}>=INDEX(Calendario!$O:$O,MATCH($A{R},Calendario!$B:$B,0)),1,0)"]
            fms = [None, "0", "0", FE, "0", "0.000", MM1, MM1, MM1, MM1, MM1, "0.0000", MM1, MM1, MM1, "0", None, "0"]
            for c, (v, fm) in enumerate(zip(vals, fms), 1):
                poner(ws, R, c, v, fm)
            r += 1
    ws.freeze_panes = "B2"

    # ------------------------------------------------------------------ Valor terminal
    ws = hojas["Valor terminal"]
    cab = ["Id", "Fila", "Gastos últimos 12 meses", "Pérdida neta últimos 12 meses", "Alza de gastos", "Factor gastos", "Factor venta", "Descuento fin del plan",
           "Valor terminal ahorro", "Valor terminal pérdida", *range(1, 41)]
    encabezado(ws, 1, cab, [12, 5, 11, 11, 8, 8, 8, 9, 11, 11, *[6] * 40])
    c1, c40 = col(11), col(50)
    for i, x in enumerate(filas):
        R = i + 2
        ix = lambda c: f"INDEX(Datos!${c}:${c},$B{R})"
        ult = f'Flujos!$A:$A,$A{R},Flujos!$C:$C,">="&({ix("AI")}-12)'
        qq = f"((1+E{R})/(1+TasaReal))"
        vals = [x["id"], f"=MATCH(A{R},Datos!$A:$A,0)", f"=SUMIFS(Flujos!$K:$K,{ult})", f"=SUMIFS(Flujos!$O:$O,{ult})",
                f"=IF({ix('AA')}+{ix('AB')}>0,({ix('AA')}*AlzaArriendo+{ix('AB')}*AlzaOtros)/({ix('AA')}+{ix('AB')}),AlzaOtros)",
                f"={qq}*(1-{qq}^40)/(1-{qq})+{qq}^40*(1+E{R})/MAX(0.02,TasaReal-E{R})",
                f"=SUMPRODUCT({c1}{R}:{c40}{R},(1+TasaReal)^(-{c1}$1:{c40}$1))+{c40}{R}*(1+TasaReal)^-40/MAX(0.02,TasaReal)",
                f"=(1+TasaMes)^-{ix('AI')}", f"=C{R}*F{R}*H{R}", f"=D{R}*G{R}*H{R}"]
        for c, (v, fm) in enumerate(zip(vals, [None, "0", MM1, MM1, "0.00%", "0.00", "0.00", "0.0000", MM1, MM1]), 1):
            poner(ws, R, c, v, fm)
        for h in range(1, 41):
            paso = f"MAX(0.2,1+{ix('S')}*IF(AND({ix('D')}=1,{ix('S')}<0),1,PhiTerminal^{col(10 + h)}$1))"
            poner(ws, R, 10 + h, f"={paso}" if h == 1 else f"={col(9 + h)}{R}*{paso}", "0.000")
    ws.freeze_panes = "B2"

    # ------------------------------------------------------------------ Calendario
    ws = hojas["Calendario"]
    cab = ["Sede", "Id", "Gestión", "Tipo", "Fecha de cierre", "Aviso hasta", "Ahorro de gastos", "Ingreso perdido neto", "Costo de salida", "VAN del cierre",
           "VAN Hipódromo Chile", "VAN Club Hípico", "Escenarios con VAN positivo", "Fila", "Mes del plan", "Costo de salida sin descontar"]
    anchos = [22, 12, 9, 10, 12, 12, 12, 13, 11, 13, 13, 13, 12, 5, 7, 10]
    for c, w in enumerate(anchos, 1):
        ws.column_dimensions[col(c)].width = w
    franja(ws, "Calendario de cierres", "VAN de cerrar cada sede en su fecha, frente a mantenerla abierta", len(cab), logos)
    encabezado(ws, H, cab)
    r0 = H + 1
    for i, x in enumerate(filas):
        R = r0 + i
        ix = lambda c: f"INDEX(Datos!${c}:${c},$N{R})"
        vt = lambda c: f"INDEX('Valor terminal'!${c}:${c},$N{R})"
        desde = f'Flujos!$A:$A,$B{R},Flujos!$C:$C,">="&$O{R}'
        vals = [x["nombre"], x["id"], x["gestion"], x["tipo"], fecha(x["mes"]), f'=IF({ix("AG")}>0,EDATE(E{R},-{ix("AG")}),"")',
                f"=SUMIFS(Flujos!$M:$M,{desde})+{vt('I')}", f"=SUMIFS(Flujos!$N:$N,{desde})+{vt('J')}",
                f"=P{R}*(1+TasaMes)^-(MIN(O{R},{ix('AI')}-1)+1)", f"=(G{R}-H{R}-I{R})*(1-Impuesto)",
                f"=(G{R}*{ix('T')}-H{R}*{ix('Y')}/{ix('X')}-I{R}*{ix('T')})*(1-Impuesto)", f"=(G{R}*{ix('U')}-H{R}*{ix('Z')}/{ix('X')}-I{R}*{ix('U')})*(1-Impuesto)",
                x["prob"], f"=MATCH(B{R},Datos!$A:$A,0)", f"=MAX(0,(YEAR(E{R})-YEAR(InicioPlan))*12+MONTH(E{R})-MONTH(InicioPlan))",
                f'=MAX({ix("AC")},IF({ix("AF")}="",SalidaSinContrato,IF(E{R}>={ix("AF")},SalidaVencido,{ix("AH")}))*{ix("AA")})']
        fms = [None, None, None, None, FE, FE, MM, MM, MM, MM, MM, MM, PC0, "0", "0", MM1]
        for c, (v, fm) in enumerate(zip(vals, fms), 1):
            x_ = poner(ws, R, c, v, fm)
            if c == 10:
                x_.font = F_NEG
        ws.cell(R, 5).fill = PatternFill("solid", fgColor="FFF4ED")
    u = r0 + n - 1
    filas_claras(ws, r0, u, 13)
    ws.conditional_formatting.add(f"A{r0}:D{u}", FormulaRule(formula=[f'$D{r0}="Plan"'], font=Font(color=NARANJO, bold=True)))
    t0 = u + 2
    for j, (t, tipo) in enumerate([("VAN del plan", "Plan"), ("VAN cierres decididos", "Decidido"), ("VAN total", None)]):
        poner(ws, t0 + j, 1, t, font=F_NEG)
        for q_, c in enumerate(["J", "K", "L"]):
            f_ = f'=SUMIF(D{r0}:D{u},"{tipo}",{c}{r0}:{c}{u})' if tipo else f"=SUM({c}{r0}:{c}{u})"
            poner(ws, t0 + j, 10 + q_, f_, MM, Font(bold=True, color=NARANJO if tipo == "Plan" else TINTA))
    nombre(wb, "VanPlan", f"Calendario!$J${t0}")
    nombre(wb, "VanDecididos", f"Calendario!$J${t0 + 1}")
    poner(ws, t0 + 4, 1, "La herramienta decide qué sedes cierran. Cambiar fechas o supuestos recalcula el VAN, no la lista.", font=Font(italic=True, color=GRIS))
    for c in "NOP":
        ws.column_dimensions[c].hidden = True
    ws.freeze_panes = f"B{r0}"
    rng = lambda c: f"Calendario!${c}${r0}:${c}${u}"
    graf = BarChart(); graf.type = "bar"; graf.style = 10; graf.title = "VAN de cada cierre"; graf.height = 9; graf.width = 16
    graf.add_data(Reference(ws, min_col=10, min_row=r0, max_row=u), titles_from_data=False)
    graf.set_categories(Reference(ws, min_col=1, min_row=r0, max_row=u))
    graf.legend = None; graf.y_axis.numFmt = '#,##0'; graf.x_axis.scaling.orientation = "maxMin"
    graf.series[0].graphicalProperties.solidFill = AZUL
    ws.add_chart(graf, f"R{H}")

    # ------------------------------------------------------------------ Flujos anuales
    ws = hojas["Flujos anuales"]
    a0, aF = int(d["inicio"][:4]), int(d["fin"][:4])
    anos = list(range(a0, aF + 1))
    nA = len(anos)
    for c, w in enumerate([32, *[10] * nA, 13, 11], 1):
        ws.column_dimensions[col(c)].width = w
    franja(ws, "Flujos anuales", "De dónde sale el VAN, año por año", nA + 3, logos)
    encabezado(ws, H, ["Millones de pesos reales", *anos, f"Después de {aF}", "Total"])
    cA = lambda j: col(2 + j)
    cVT, cTot = col(2 + nA), col(3 + nA)
    sumF = lambda c, tp, cc: f'SUMIFS(Flujos!${c}:${c},Flujos!$Q:$Q,"{tp}",Flujos!$P:$P,{cc}${H},Flujos!$R:$R,1)'
    costo_ano = lambda tp, cc, c: f'SUMPRODUCT(({rng("D")}="{tp}")*(YEAR({rng("E")})={cc}${H})*{rng(c)})'
    rngV = lambda c: f"'Valor terminal'!${c}$2:${c}${n + 1}"
    fA = H + 1
    filas_vp = {}

    def bloque(titulo, tipos):
        nonlocal fA
        poner(ws, fA, 1, titulo, font=Font(bold=True, size=12, color=AZUL))
        fA += 1
        f0 = fA

        def fila(nm, por_ano, vt=None, negrita=False):
            nonlocal fA
            poner(ws, fA, 1, nm, font=F_NEG if negrita else None)
            for j in range(nA):
                poner(ws, fA, 2 + j, por_ano(cA(j)), MM1, F_NEG if negrita else None)
            if vt:
                poner(ws, fA, 2 + nA, vt, MM1, F_NEG if negrita else None)
            poner(ws, fA, 3 + nA, f"=SUM(B{fA}:{cVT if vt else cA(nA - 1)}{fA})", MM1, Font(bold=True, color=NARANJO if negrita else TINTA))
            fA += 1

        suma = lambda fn: "=" + "+".join(fn(tp) for tp in tipos)
        fila("Ingreso perdido", lambda cc: suma(lambda tp: sumF("H", tp, cc)))
        fila("Recuperado en otras sedes", lambda cc: suma(lambda tp: sumF("I", tp, cc)))
        fila("Recuperado en el canal digital", lambda cc: suma(lambda tp: sumF("J", tp, cc)))
        fila("Ahorro de gastos", lambda cc: suma(lambda tp: sumF("K", tp, cc)))
        fila("Costo de salida", lambda cc: suma(lambda tp: costo_ano(tp, cc, "P")))
        fila("Flujo antes de impuesto", lambda cc: f"={cc}{f0 + 3}-({cc}{f0}-{cc}{f0 + 1}-{cc}{f0 + 2})-{cc}{f0 + 4}", negrita=True)
        fila("Impuesto", lambda cc: f"=-{cc}{f0 + 5}*Impuesto")
        fila("Flujo después de impuesto", lambda cc: f"={cc}{f0 + 5}+{cc}{f0 + 6}")
        filas_vp[titulo] = fA
        fila("Valor presente", lambda cc: "=(" + "+".join(f"{sumF('M', tp, cc)}-{sumF('N', tp, cc)}-{costo_ano(tp, cc, 'I')}" for tp in tipos) + ")*(1-Impuesto)",
             "=(" + "+".join(f'SUMPRODUCT(({rng("D")}="{tp}")*({rngV("I")}-{rngV("J")}))' for tp in tipos) + ")*(1-Impuesto)", negrita=True)
        filas_claras(ws, f0, fA - 1, nA + 3)
        fA += 1

    bloque("Cierres del plan", ["Plan"])
    bloque("Cierres decididos por la gerencia", ["Decidido"])
    bloque("Todos los cierres", ["Plan", "Decidido"])
    fvp = filas_vp["Cierres del plan"]
    nombre(wb, "VtPlan", f"'Flujos anuales'!${cVT}${fvp}")
    graf = BarChart(); graf.type = "col"; graf.style = 10; graf.title = "Valor presente del plan por año"; graf.height = 8; graf.width = 22
    graf.add_data(Reference(ws, min_col=2, max_col=2 + nA, min_row=fvp), from_rows=True, titles_from_data=False)
    graf.set_categories(Reference(ws, min_col=2, max_col=2 + nA, min_row=H))
    graf.legend = None; graf.y_axis.numFmt = '#,##0'; graf.series[0].graphicalProperties.solidFill = AZUL
    ws.add_chart(graf, f"A{fA + 1}")
    ws.freeze_panes = f"B{H + 1}"

    # ------------------------------------------------------------------ Estrategia (score y matriz con formulas)
    ws = hojas["Estrategia"]
    cab = ["Sede", "Id", "Resultado del plan", "Venta mensual", "Arriendo mensual", "Arriendo sobre venta", "Tendencia 12 meses", "Margen anual",
           "Percentil volumen", "Percentil arriendo", "Percentil tendencia", "Score", "Nivel", "Margen frente a la red", "Categoría de la matriz",
           "Frente a la red", "VAN si sigue abierta", "VAN si cierra", "VAN del cierre", "Escenarios con VAN positivo", "Cerrar crea valor", "Cumple las dos"]
    for c, w in enumerate([20, 12, 26, 10, 10, 10, 10, 10, 9, 9, 9, 8, 8, 10, 28, 12, 12, 12, 12, 11, 10, 10], 1):
        ws.column_dimensions[col(c)].width = w
    franja(ws, "Estrategia y portafolio", "Una sede cierra si cerrarla crea valor y además rinde poco frente a la red", len(cab), logos)
    encabezado(ws, H, cab)
    r0, u = H + 1, H + nr
    rg = lambda c: f"${c}${r0}:${c}${u}"
    for i, x in enumerate(red):
        R = r0 + i
        vals = [x["nombre"], x["id"], x["grupo"], x["venta"], x["arriendo"], f"=IF(D{R}>0,E{R}/D{R},0.05)", (x["tendencia"] or 0) / 100, x["margen"],
                f'=COUNTIF({rg("D")},"<="&D{R})/{nr}*100', f'=(1-COUNTIF({rg("F")},"<="&F{R})/{nr})*100', f'=COUNTIF({rg("G")},"<="&G{R})/{nr}*100',
                f"=(PesoVol*I{R}+PesoArr*J{R}+PesoTend*K{R})/(PesoVol+PesoArr+PesoTend)",
                f'=IF(L{R}>=CorteAlto,"Alto",IF(L{R}>=CorteBajo,"Medio","Bajo"))', f'=IF(H{R}>=MargenT2,"Alta",IF(H{R}>=MargenT1,"Media","Baja"))',
                f'=IF(M{R}="Bajo",IF(OR(H{R}>=MargenMed,N{R}="Alta"),"Revisión prioritaria",IF(N{R}="Media","Reestructurar / validar salida","Salida / renegociación")),'
                f'IF(M{R}="Medio",IF(N{R}="Alta","Proteger / monitorear",IF(N{R}="Media","Optimizar","Optimizar / evaluar salida")),'
                f'IF(N{R}="Alta","Proteger / expandir",IF(N{R}="Media","Mantener / expansión condicionada","Mantener; revisar contrato"))))',
                f'=IF(OR(O{R}="Salida / renegociación",O{R}="Reestructurar / validar salida",O{R}="Optimizar / evaluar salida"),"Rinde poco","Rinde bien")',
                x["mantener"], x["cerrar"], f'=IF(AND(ISNUMBER(Q{R}),ISNUMBER(R{R})),R{R}-Q{R},"")', x["prob"],
                f'=IF(AND(ISNUMBER(S{R}),ISNUMBER(T{R})),IF(AND(S{R}>0,T{R}>=ProbMin),"Sí","No"),"No")', f'=IF(AND(U{R}="Sí",P{R}="Rinde poco"),"Sí","No")']
        fms = [None, None, None, MM1, MM1, PC, PC, MM, "0", "0", "0", "0", None, None, None, None, MM, MM, MM, PC0, None, None]
        for c, (v, fm) in enumerate(zip(vals, fms), 1):
            poner(ws, R, c, v, fm)
        ws.cell(R, 12).font = F_NEG
    filas_claras(ws, r0, u, len(cab))
    naranjo = Font(color=NARANJO, bold=True)
    ws.conditional_formatting.add(f"C{r0}:C{u}", FormulaRule(formula=[f'LEFT($C{r0},6)="Cierra"'], font=naranjo))
    ws.conditional_formatting.add(f"P{r0}:P{u}", FormulaRule(formula=[f'$P{r0}="Rinde poco"'], font=naranjo))
    ws.conditional_formatting.add(f"U{r0}:V{u}", FormulaRule(formula=[f'U{r0}="Sí"'], font=Font(color="1A7F37", bold=True)))
    ws.freeze_panes = f"B{r0}"
    ws.auto_filter.ref = f"A{H}:{col(len(cab))}{u}"

    # ------------------------------------------------------------------ Escenarios (valores de la herramienta)
    ws = hojas["Escenarios"]
    N = d["iteraciones"]
    encabezado(ws, 1, ["Escenario", *[x["nombre"] for x in filas], "Decididos", "Plan", "Todos"], [9, *[11] * n, 11, 11, 11])
    idx_dec = [j for j, x in enumerate(filas) if x["tipo"] == "Decidido"]
    idx_plan = [j for j, x in enumerate(filas) if x["tipo"] == "Plan"]
    cD, cP, cT = col(n + 2), col(n + 3), col(n + 4)
    rangos = lambda js, R: "+".join(f"{col(j + 2)}{R}" for j in js) or "0"
    for e in range(N):
        R = e + 2
        poner(ws, R, 1, e + 1)
        for j, x in enumerate(filas):
            poner(ws, R, j + 2, x["mc"][e] if e < len(x["mc"]) else None, MM1)
        poner(ws, R, n + 2, f"={rangos(idx_dec, R)}", MM1)
        poner(ws, R, n + 3, f"={rangos(idx_plan, R)}", MM1)
        poner(ws, R, n + 4, f"={cD}{R}+{cP}{R}", MM1)
    ws.freeze_panes = "B2"

    # ------------------------------------------------------------------ Simulacion
    ws = hojas["Simulación"]
    for c, w in enumerate([26, 13, 13, 13, 13, 13, 13, 4, 14, 14, 12], 1):
        ws.column_dimensions[col(c)].width = w
    franja(ws, "Simulación de Monte Carlo", f"{N:,} escenarios por cierre".replace(",", "."), 11, logos)
    encabezado(ws, H, ["Cierres", "VAN caso base", "VAN más probable", "P10", "P90", "Escenarios con VAN positivo", "Promedio del peor 5%"])
    esc = lambda c: f"Escenarios!${c}$2:${c}${N + 1}"
    grupos_mc = [("Cierres del plan", cP, "=VanPlan"), ("Cierres decididos", cD, "=VanDecididos"), ("Todos los cierres", cT, "=VanPlan+VanDecididos")]
    grupos_mc += [(x["nombre"], col(j + 2), f"=INDEX(Calendario!$J:$J,MATCH(\"{x['id']}\",Calendario!$B:$B,0))") for j, x in enumerate(filas)]
    for i, (t, c, base) in enumerate(grupos_mc):
        R = H + 1 + i
        e = esc(c)
        vals = [t, base, f"=MEDIAN({e})", f"=PERCENTILE({e},0.1)", f"=PERCENTILE({e},0.9)", f'=COUNTIF({e},">0")/COUNT({e})', f'=AVERAGEIF({e},"<="&PERCENTILE({e},0.05))']
        for cc, (v, fm) in enumerate(zip(vals, [None, MM, MM, MM, MM, "0.0%", MM]), 1):
            poner(ws, R, cc, v, fm, F_NEG if i < 3 else None)
    uS = H + len(grupos_mc)
    filas_claras(ws, H + 1, uS, 7)
    ws.conditional_formatting.add(f"F{H + 1}:F{uS}", FormulaRule(formula=[f"F{H + 1}<ProbMin"], font=Font(color=NARANJO, bold=True)))
    nombre(wb, "ProbPlan", f"'Simulación'!$F${H + 1}")
    nombre(wb, "P10Plan", f"'Simulación'!$D${H + 1}")
    nombre(wb, "P90Plan", f"'Simulación'!$E${H + 1}")
    # histograma del plan
    encabezado_h = ["Desde", "Hasta", "Escenarios"]
    for j, t in enumerate(encabezado_h):
        x_ = ws.cell(H, 9 + j, t)
        x_.font, x_.fill, x_.alignment = F_CAB, RELL_AZUL, CENTRO
    e = esc(cP)
    nb = 30
    for b in range(nb):
        R = H + 1 + b
        poner(ws, R, 9, f"=MIN({e})+{b}*(MAX({e})-MIN({e}))/{nb}", MM)
        poner(ws, R, 10, f"=MIN({e})+{b + 1}*(MAX({e})-MIN({e}))/{nb}", MM)
        poner(ws, R, 11, f'=COUNTIFS({e},">="&I{R},{e},"<"&J{R})' if b < nb - 1 else f'=COUNTIFS({e},">="&I{R},{e},"<="&J{R})', "0")
    graf = BarChart(); graf.type = "col"; graf.style = 10; graf.title = "VAN del plan en los escenarios"; graf.height = 9; graf.width = 22; graf.gapWidth = 10
    graf.add_data(Reference(ws, min_col=11, min_row=H + 1, max_row=H + nb), titles_from_data=False)
    graf.set_categories(Reference(ws, min_col=9, min_row=H + 1, max_row=H + nb))
    graf.legend = None; graf.x_axis.number_format = '#,##0'; graf.series[0].graphicalProperties.solidFill = AZUL
    ws.add_chart(graf, f"A{max(uS, H + nb) + 3}")
    ws.freeze_panes = f"B{H + 1}"

    # ------------------------------------------------------------------ Sensibilidad (tornado)
    ws = hojas["Sensibilidad"]
    for c, w in enumerate([34, 14, 14, 14, 14, 14, 14], 1):
        ws.column_dimensions[col(c)].width = w
    franja(ws, "Sensibilidad del VAN del plan", "Cada supuesto en el mínimo y el máximo de su rango, el resto en el caso base", 7, logos)
    poner(ws, H - 1, 1, "VAN del plan, caso base", font=F_NEG)
    poner(ws, H - 1, 2, d["base"], MM, Font(bold=True, color=NARANJO))
    encabezado(ws, H, ["Supuesto", "Valor bajo", "Valor alto", "VAN con el valor bajo", "VAN con el valor alto", "Cambio con el valor bajo", "Cambio con el valor alto"])
    tor = sorted(d["tornado"], key=lambda t: -abs(t["va"] - t["vb"]))
    for i, t in enumerate(tor):
        R = H + 1 + i
        for cc, (v, fm) in enumerate(zip([t["n"], t["bajo"], t["alto"], t["vb"], t["va"], f"=D{R}-$B${H - 1}", f"=E{R}-$B${H - 1}"],
                                         [None, None, None, MM, MM, MM, MM]), 1):
            poner(ws, R, cc, v, fm, align=DER if cc in (2, 3) else None)
    uT = H + len(tor)
    filas_claras(ws, H + 1, uT, 7)
    graf = BarChart(); graf.type = "bar"; graf.grouping = "clustered"; graf.overlap = 100; graf.gapWidth = 40; graf.style = 10
    graf.title = "Qué supuesto mueve más el VAN"; graf.height = 9; graf.width = 22
    graf.add_data(Reference(ws, min_col=6, max_col=7, min_row=H, max_row=uT), titles_from_data=True)
    graf.set_categories(Reference(ws, min_col=1, min_row=H + 1, max_row=uT))
    graf.x_axis.scaling.orientation = "maxMin"; graf.y_axis.numFmt = '#,##0'; graf.legend.position = "b"
    graf.series[0].graphicalProperties.solidFill = "E34948"; graf.series[1].graphicalProperties.solidFill = "2A78D6"
    ws.add_chart(graf, f"A{uT + 3}")
    poner(ws, uT + 2, 1, "Valores calculados por la herramienta con el plan fijo.", font=Font(italic=True, color=GRIS))
    nombre(wb, "PeorSens", f"Sensibilidad!$D${H + 1}")

    # ------------------------------------------------------------------ Flexibilidad (formulas)
    ws = hojas["Flexibilidad"]
    for c, w in enumerate([22, 12, 12, 13, 13, 13, 13, 5, 5], 1):
        ws.column_dimensions[col(c)].width = w
    franja(ws, "Flexibilidad del calendario", "VAN de cada cierre del plan si se posterga uno, dos o tres años", 7, logos)
    encabezado(ws, H, ["Sede", "Id", "Fecha del plan", "A tiempo", "Un año tarde", "Dos años tarde", "Tres años tarde"])
    for i, x in enumerate(plan):
        R = H + 1 + i
        poner(ws, R, 1, x["nombre"]); poner(ws, R, 2, x["id"])
        poner(ws, R, 8, f"=MATCH(B{R},Datos!$A:$A,0)", "0"); poner(ws, R, 9, f"=INDEX(Calendario!$O:$O,MATCH(B{R},Calendario!$B:$B,0))", "0")
        poner(ws, R, 3, f"=EDATE(InicioPlan,I{R})", FE)
        for dd in range(4):
            k = f"(I{R}+{12 * dd})"
            v = van_k(f"$B{R}", k, f"EDATE($C{R},{12 * dd})", f"$H{R}")
            poner(ws, R, 4 + dd, f'=IF({k}>INDEX(Datos!$AI:$AI,$H{R})-1,"",{v})', MM)
    uF = H + len(plan)
    tF = uF + 1
    poner(ws, tF, 1, "Total del plan", font=F_NEG)
    for dd in range(4):
        poner(ws, tF, 4 + dd, f"=SUM({col(4 + dd)}{H + 1}:{col(4 + dd)}{uF})", MM, Font(bold=True, color=NARANJO))
    poner(ws, tF + 1, 1, "Diferencia frente a tiempo")
    for dd in range(1, 4):
        poner(ws, tF + 1, 4 + dd, f"={col(4 + dd)}{tF}-$D${tF}", MM)
    filas_claras(ws, H + 1, tF, 7)
    ws.column_dimensions["H"].hidden = ws.column_dimensions["I"].hidden = True
    nombre(wb, "Atraso1", f"Flexibilidad!$E${tF + 1}")
    graf = LineChart(); graf.title = "VAN del plan según el atraso"; graf.style = 12; graf.height = 8; graf.width = 16
    graf.add_data(Reference(ws, min_col=4, max_col=7, min_row=tF), from_rows=True, titles_from_data=False)
    graf.set_categories(Reference(ws, min_col=4, max_col=7, min_row=H))
    graf.legend = None; graf.y_axis.numFmt = '#,##0'
    graf.series[0].graphicalProperties.line.solidFill = AZUL; graf.series[0].graphicalProperties.line.width = 38000
    ws.add_chart(graf, f"A{tF + 4}")

    # ------------------------------------------------------------------ Equilibrio (punto de equilibrio de cada cierre)
    ws = hojas["Equilibrio"]
    for c, w in enumerate([22, 12, 10, 13, 14, 16, 14, 18, 14], 1):
        ws.column_dimensions[col(c)].width = w
    franja(ws, "Punto de equilibrio", "Qué tendría que pasar para que cerrar deje de convenir", 9, logos)
    encabezado(ws, H, ["Sede", "Id", "Tipo", "VAN del cierre", "Clientes que van a otra sede", "Retención con la que cerrar deja de convenir",
                       "Venta año 1", "Venta sobre la que cerrar deja de convenir", "Holgura de venta"])
    for i, x in enumerate(filas):
        R = H + 1 + i
        cal = lambda c: f"INDEX(Calendario!${c}:${c},MATCH($B{R},Calendario!$B:$B,0))"
        dat = lambda c: f"INDEX(Datos!${c}:${c},MATCH($B{R},Datos!$A:$A,0))"
        vals = [x["nombre"], x["id"], x["tipo"], f"={cal('J')}", f"={dat('AD')}",
                f'=IF({cal("H")}<=0,"",MAX(0,MIN(1,1-({cal("G")}-{cal("I")})*(1-E{R})/{cal("H")})))', f"={dat('E')}",
                f'=IF({cal("H")}<=0,"",({cal("G")}-{cal("I")})/{cal("H")}*G{R})', f'=IF(ISNUMBER(H{R}),H{R}/G{R}-1,"")']
        for cc, (v, fm) in enumerate(zip(vals, [None, None, None, MM, PC, PC, MM1, MM1, PC]), 1):
            poner(ws, R, cc, v, fm)
    filas_claras(ws, H + 1, H + n, 9)
    poner(ws, H + n + 2, 1, "Holgura positiva: la venta tendría que subir eso para que convenga mantener la sede. Negativa: ya conviene mantenerla.",
          font=Font(italic=True, color=GRIS))

    # ------------------------------------------------------------------ Optimizador (Solver)
    ws = hojas["Optimizador"]
    for c, w in enumerate([22, 12, 12, 12, 14, 12, 5], 1):
        ws.column_dimensions[col(c)].width = w
    franja(ws, "Optimizador de fechas", "Solver busca el mes de cierre de mayor VAN para cada sede del plan", 7, logos)
    encabezado(ws, H, ["Sede", "Id", "Mes del plan", "Fecha de cierre", "VAN del cierre", "Mes máximo"])
    for i, x in enumerate(plan):
        R = H + 1 + i
        poner(ws, R, 1, x["nombre"]); poner(ws, R, 2, x["id"])
        c_ = poner(ws, R, 3, (int(x["mes"][:4]) - int(d["inicio"][:4])) * 12 + int(x["mes"][5:7]) - int(d["inicio"][5:7]), "0", Font(bold=True, color=NARANJO))
        c_.fill = PatternFill("solid", fgColor="FFF4ED")
        poner(ws, R, 7, f"=MATCH(B{R},Datos!$A:$A,0)", "0")
        poner(ws, R, 4, f"=EDATE(InicioPlan,C{R})", FE)
        poner(ws, R, 5, f"={van_k(f'$B{R}', f'C{R}', f'D{R}', f'$G{R}')}", MM)
        poner(ws, R, 6, f"=INDEX(Datos!$AI:$AI,$G{R})-1", "0")
    uO = H + len(plan)
    poner(ws, uO + 1, 1, "VAN del plan", font=F_NEG)
    poner(ws, uO + 1, 5, f"=SUM(E{H + 1}:E{uO})", MM, Font(bold=True, color=NARANJO))
    filas_claras(ws, H + 1, uO + 1, 6)
    ws.column_dimensions["G"].hidden = True
    for j, t in enumerate(["Para optimizar: Datos > Solver > Resolver. El modelo ya está cargado: maximizar el VAN del plan cambiando los meses en naranjo,",
                           "con cada mes entre 0 y su máximo. El mes 0 es el inicio del plan. Las fechas de la herramienta respetan además los vencimientos de contrato."]):
        poner(ws, uO + 3 + j, 1, t, font=Font(italic=True, color=GRIS))
    loc = wb.sheetnames.index("Optimizador")
    for nm, v in [("solver_adj", f"Optimizador!$C${H + 1}:$C${uO}"), ("solver_opt", f"Optimizador!$E${uO + 1}"), ("solver_typ", "1"), ("solver_val", "0"),
                  ("solver_num", "2"), ("solver_lhs1", f"Optimizador!$C${H + 1}:$C${uO}"), ("solver_rel1", "3"), ("solver_rhs1", "0"),
                  ("solver_lhs2", f"Optimizador!$C${H + 1}:$C${uO}"), ("solver_rel2", "1"), ("solver_rhs2", f"Optimizador!$F${H + 1}:$F${uO}"),
                  ("solver_eng", "3"), ("solver_neg", "1"), ("solver_ver", "3"), ("solver_pre", "0.000001"), ("solver_tim", "100"), ("solver_itr", "1000")]:
        ws.defined_names[nm] = DefinedName(nm, attr_text=v, localSheetId=loc, hidden=True)

    # ------------------------------------------------------------------ Resumen
    ws = hojas["Resumen"]
    for c, w in enumerate([3, 26, 18, 3, 26, 18, 3, 26, 18], 1):
        ws.column_dimensions[col(c)].width = w
    franja(ws, "Plan de sedes 2026 a 2036", "Resultados del plan de cierres", 12, logos)
    kpis = [
        ("VAN del plan", "=VanPlan", MM, NARANJO), ("Cierres del plan", f'=COUNTIF(Calendario!$D:$D,"Plan")', "0", NARANJO),
        ("Cierres decididos por la gerencia", f'=COUNTIF(Calendario!$D:$D,"Decidido")', "0", TINTA),
        ("Escenarios en que el plan crea valor", "=ProbPlan", "0.0%", AZUL), ("Ocho de cada diez escenarios desde", "=P10Plan", MM, AZUL),
        ("hasta", "=P90Plan", MM, AZUL), ("Valor que viene de después de 2036", "=VtPlan/VanPlan", PC0, AZUL),
        ("Costo de postergar el plan un año", "=Atraso1", MM, ROJO), ("VAN cierres decididos", "=VanDecididos", MM, TINTA),
    ]
    for i, (t, f_, fm, color) in enumerate(kpis):
        fila_k, col_k = H + (i // 3) * 3, 2 + (i % 3) * 3
        for rr in range(fila_k, fila_k + 2):
            for cc in range(col_k, col_k + 2):
                ws.cell(rr, cc).fill = RELL_FONDO
        poner(ws, fila_k, col_k, t, font=Font(size=11, color=GRIS))
        ws.merge_cells(start_row=fila_k + 1, start_column=col_k, end_row=fila_k + 1, end_column=col_k + 1)
        poner(ws, fila_k + 1, col_k, f_, fm, Font(size=26, bold=True, color=color), Alignment(horizontal="left", vertical="center"))
        ws.row_dimensions[fila_k + 1].height = 40
    rI = H + 10
    poner(ws, rI, 2, "Hojas del libro", font=Font(bold=True, size=12, color=AZUL))
    guia = [("Calendario", "fechas y VAN de cada cierre"), ("Estrategia", "score, matriz y las dos condiciones de toda la red"),
            ("Simulación", "escenarios de Monte Carlo"), ("Sensibilidad", "tornado de supuestos"), ("Flexibilidad", "costo de postergar"),
            ("Equilibrio", "venta y retención con que cerrar deja de convenir"), ("Optimizador", "fechas con Solver"), ("Flujos anuales", "de dónde sale el VAN"),
            ("Supuestos", "celdas para cambiar")]
    for j, (h, t) in enumerate(guia):
        x_ = poner(ws, rI + 1 + j, 2, h, font=Font(color="2A78D6", underline="single"))
        x_.hyperlink = f"#'{h}'!A1"
        poner(ws, rI + 1 + j, 3, t, font=Font(color=GRIS))
    graf = BarChart(); graf.type = "bar"; graf.style = 10; graf.title = "VAN de cada cierre"; graf.height = 9; graf.width = 15
    cal_ws = hojas["Calendario"]
    graf.add_data(Reference(cal_ws, min_col=10, min_row=H + 1, max_row=H + n), titles_from_data=False)
    graf.set_categories(Reference(cal_ws, min_col=1, min_row=H + 1, max_row=H + n))
    graf.legend = None; graf.x_axis.scaling.orientation = "maxMin"; graf.y_axis.numFmt = '#,##0'
    graf.series[0].graphicalProperties.solidFill = AZUL
    ws.add_chart(graf, f"E{rI}")

    wb.calculation.fullCalcOnLoad = True
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def construir_b64(entrada_json):
    return base64.b64encode(construir(json.loads(entrada_json))).decode()
