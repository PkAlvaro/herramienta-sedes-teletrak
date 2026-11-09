"""Genera ui/app.html a partir del dashboard de R. Malis (modelo_simple/Dashboard_Demanda_Huff_Teletrak.html).

Conserva su diseno y su logica (demanda, simulador Huff, parametros g1/kappa/phi) y:
- quita el DASHBOARD_DATA incrustado: se arma en el navegador desde el Excel cargado (ui/capa_datos.js)
- corrige lo que venia fijo: anos 2027-2031, ids TLK-xx, banda P10-P90 de +-12%, atractivo Huff en MM CLP
- agrega pestanas: carga de datos, informe de carga, mapa de red, segmentos, sedes y contratos, estados

Cada reemplazo verifica que el texto original exista. Si el dashboard original cambia, el
script dice exactamente que dejo de calzar.

    .venv/bin/python ui/extender_dashboard.py ruta/Dashboard_Demanda_Huff_Teletrak.html
"""
import re
import sys
from pathlib import Path

AQUI = Path(__file__).parent


def reemplazar(html, viejo, nuevo, n=1, regex=False):
    cuenta = len(re.findall(viejo, html)) if regex else html.count(viejo)
    if cuenta != n:
        raise SystemExit(f"Se esperaban {n} coincidencias y hay {cuenta}:\n{viejo[:200]}")
    return re.sub(viejo, nuevo, html) if regex else html.replace(viejo, nuevo)


def extender(original):
    h = original
    # --- Datos incrustados fuera ---
    h = reemplazar(h, r"    const DASHBOARD_DATA = \{.*\};\n", "    let DASHBOARD_DATA = null;  // se arma desde el Excel cargado (capa_datos.js)\n", regex=True)

    # --- Cabecera y librerias ---
    h = reemplazar(h, "<title>EVALPRO · Mini-Dashboard Demanda & Gravitación Huff Teletrak (65 Sedes)</title>",
                   '<title>Plan de sedes Teletrak</title>\n  <link rel="icon" type="image/png" href="__ICONO__">')
    h = reemplazar(h, '<script src="https://cdn.tailwindcss.com"></script>',
                   '<script src="https://cdn.tailwindcss.com/3.4.16"></script>')
    h = reemplazar(h, '<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>',
                   '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>\n'
                   '  <script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>\n'
                   '  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css">\n'
                   '  <script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>\n'
                   '  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Semi+Condensed:wght@500;600;700&display=swap">')
    h = reemplazar(h, "  </style>\n</head>", (AQUI / "extra.css").read_text(encoding="utf-8") + "  </style>\n</head>")
    h = reemplazar(h, "TELETRAK · Dashboard Interactivo de Demanda</h1>", "Plan de sedes Teletrak</h1>")
    # Marca: franja verde Teletrak con los logos de Teletrak e Hipodromo Chile (los pone construir_ui.py desde ui/marca/)
    h = reemplazar(h, '<header class="bg-white border-b border-slate-200 px-6 py-3.5 sticky top-0 z-50 shadow-sm">\n',
                   '<header class="sticky top-0 z-50 shadow-sm">\n  <div class="franja px-6 py-3">\n')
    h = reemplazar(h, '''        <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-turf-800 to-gold-600 flex items-center justify-center font-extrabold text-white text-base shadow-sm tracking-wider">
          TLK
        </div>''', '<div class="logos"><img src="__LOGO_TELETRAK__" alt="Teletrak"><img src="__LOGO_HIPODROMO__" alt="Hipódromo Chile"></div>')
    h = reemplazar(h, '<span class="px-2 py-0.5 text-[11px] font-bold rounded bg-turf-50 text-turf-800 border border-turf-100">Modelo Gravitacional Huff</span>', "")
    # Cabecera sobria: solo logos y titulo (sin etiquetas ni subtitulo)
    h = reemplazar(h, r'\s*<span class="[^"]*">65 Sedes Vigentes</span>', "", regex=True)
    h = reemplazar(h, r'\s*<span class="[^"]*">Solo Demanda</span>', "", regex=True)
    h = reemplazar(h, r'\s*<p class="text-xs text-slate-500 mt-0.5">\s*Desestacionalización Limpia[^<]*</p>', "", regex=True)
    h = reemplazar(h, '<div class="flex flex-wrap items-center gap-2.5">\n        <!-- Moneda -->',
                   '<div class="flex flex-wrap items-center gap-2.5 hidden" id="togglesDemanda">\n        <!-- Moneda -->')
    h = reemplazar(h, ">Real (Sep-26)</button>", ">Real</button>")
    BLOQUE_SERIE_LIMPIA = """        <!-- Serie Limpia vs Cruda -->
        <div class="bg-slate-100 p-0.5 rounded-lg flex items-center text-xs font-semibold border border-slate-200">
          <button id="btnLimpia" onclick="setSeriesMode('CLEAN')" class="px-3 py-1 rounded-md transition-all active-pill">Serie Limpia</button>
          <button id="btnCruda" onclick="setSeriesMode('RAW')" class="px-3 py-1 rounded-md transition-all text-slate-600 hover:text-slate-900">Serie Cruda</button>
        </div>\n"""
    h = reemplazar(h, BLOQUE_SERIE_LIMPIA, "")
    LEYENDA_CRUDA_LIMPIA = """              <span class="flex items-center space-x-1 text-slate-500">
                <span class="w-2.5 h-2.5 rounded-full bg-slate-400 inline-block"></span>
                <span>Cruda</span>
              </span>
              <span class="flex items-center space-x-1 text-turf-700">
                <span class="w-2.5 h-2.5 rounded-full bg-turf-700 inline-block"></span>
                <span>Limpia</span>
              </span>"""
    LEYENDA_HISTORICO = """              <span class="flex items-center space-x-1 text-turf-700">
                <span class="w-2.5 h-2.5 rounded-full bg-turf-700 inline-block"></span>
                <span>Histórico</span>
              </span>"""
    h = reemplazar(h, LEYENDA_CRUDA_LIMPIA, LEYENDA_HISTORICO)
    h = reemplazar(h, "      \n    </div>\n  </header>", "      \n    </div>\n  </div>\n  <div class=\"filete\"></div>\n  <div class=\"barra-nav px-6\">\n"
                   + (AQUI / "nav.html").read_text(encoding="utf-8") + "  </div>\n  </header>")

    # --- Pestanas: el contenido original queda como 'Demanda y Huff' ---
    h = reemplazar(h, '<main class="max-w-[1560px] mx-auto w-full px-6 py-5 space-y-5 flex-1">',
                   '<main class="max-w-[1560px] mx-auto w-full px-6 py-5 flex-1">\n'
                   + (AQUI / "tab_carga.html").read_text(encoding="utf-8")
                   + '\n  <section class="tab space-y-5" id="tab-demanda" hidden>')
    h = reemplazar(h, "  </main>", (AQUI / "tab_demanda_extra.html").read_text(encoding="utf-8") + "  </section>\n"
                   + (AQUI / "tabs_extra.html").read_text(encoding="utf-8") + "\n  </main>")

    # --- Textos y botones que venian fijos ---
    h = reemplazar(h, '<option value="CONSOLIDADO_G9" selected>\u2b50 Cartera Focal G9 (9 Sedes RM)</option>',
                   '<option value="CONSOLIDADO_G9" id="optConsG9">Cartera Focal G9</option>')
    h = reemplazar(h, '<option value="CONSOLIDADO_RED">\U0001f310 Red Nacional Vigente (65 Sedes)</option>',
                   '<option value="CONSOLIDADO_RED" id="optConsRed">Red Nacional Vigente</option>')
    h = reemplazar(h, "Demanda Mensual (2021–2031)", "Demanda Mensual")
    h = reemplazar(h, "Selecciona sedes a cerrar en la red (65 sedes vigentes)", "Selecciona sedes físicas a cerrar en la red")

    # --- Ocultar selector de Hipodromo Organizador y añadir Alcance / Exportar CSV en la barra superior ---
    HIPO_ORIGINAL = """      <!-- Selector por Hipódromo Organizador -->
      <div class="flex flex-col">
        <label class="block text-xs font-bold text-slate-600 uppercase tracking-wider mb-1">Hipódromo Organizador:</label>
        <div class="flex flex-wrap items-center gap-1.5" id="hipoButtonsContainer">
          <button onclick="setHipodromo('ALL')" id="hipo_ALL" class="px-3 py-1.5 rounded-xl text-xs font-bold border border-slate-300 transition-all active-hipo-ALL shadow-xs">Todos los Hipódromos</button>
          <button onclick="setHipodromo('HCH')" id="hipo_HCH" class="px-3 py-1.5 rounded-xl text-xs font-bold border border-slate-300 transition-all text-slate-700 hover:bg-blue-50 shadow-xs">HCH · Hipódromo Chile</button>
          <button onclick="setHipodromo('CHS')" id="hipo_CHS" class="px-3 py-1.5 rounded-xl text-xs font-bold border border-slate-300 transition-all text-slate-700 hover:bg-purple-50 shadow-xs">CHS · Club Hípico Stgo</button>
          <button onclick="setHipodromo('VSC')" id="hipo_VSC" class="px-3 py-1.5 rounded-xl text-xs font-bold border border-slate-300 transition-all text-slate-700 hover:bg-sky-50 shadow-xs">VSC · Sporting Viña</button>
          <button onclick="setHipodromo('CHC')" id="hipo_CHC" class="px-3 py-1.5 rounded-xl text-xs font-bold border border-slate-300 transition-all text-slate-700 hover:bg-amber-50 shadow-xs">CHC · Concepción</button>
        </div>
      </div>"""
    HIPO_NUEVO = """      <!-- Selector de Alcance Financiero -->
      <div class="flex flex-col">
        <label class="block text-xs font-bold text-slate-600 uppercase tracking-wider mb-1">Alcance del VAN Consolidado:</label>
        <div class="flex items-center gap-2">
          <div class="flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200 text-xs font-semibold" id="res-alcance">
            <button type="button" class="px-3 py-1.5 rounded-md transition-all active-pill" id="btnAlcanceRed" onclick="setAlcanceResultado('CONSOLIDADO_RED')">Toda la Red</button>
            <button type="button" class="px-3 py-1.5 rounded-md transition-all text-slate-600 hover:text-slate-900" id="btnAlcanceG9" onclick="setAlcanceResultado('CONSOLIDADO_G9')">Cartera Focal G9</button>
          </div>
          <button type="button" class="btn-s" id="btn-csv-resultado" onclick="descargarCSVResultado()">Exportar Flujos CSV</button>
        </div>
      </div>
      <div class="hidden" id="hipoButtonsContainer">
        <button onclick="setHipodromo('ALL')" id="hipo_ALL"></button>
        <button onclick="setHipodromo('HCH')" id="hipo_HCH"></button>
        <button onclick="setHipodromo('CHS')" id="hipo_CHS"></button>
        <button onclick="setHipodromo('VSC')" id="hipo_VSC"></button>
        <button onclick="setHipodromo('CHC')" id="hipo_CHC"></button>
      </div>"""
    h = reemplazar(h, HIPO_ORIGINAL, HIPO_NUEVO)

    # --- Unificar la fila de 5 KPIs Ejecutivos (Demanda + VAN) eliminando duplicidad ---
    KPIS_DEMANDA_ORIGINAL = """    <!-- TARJETAS KPIS DE DEMANDA -->
    <div class="grid grid-cols-2 md:grid-cols-5 gap-3.5">
      
      <div class="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
        <span class="text-[11px] font-bold text-slate-500 uppercase tracking-wider block">Demanda Base 2026</span>
        <div class="text-xl font-extrabold text-pizarra-900 mt-1" id="kpiBase26">$0.0 M</div>
        <span class="text-[11px] text-slate-500 mt-0.5 block" id="kpiBaseSub">Últimos 12 meses obs.</span>
      </div>

      <div class="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
        <span class="text-[11px] font-bold text-turf-800 uppercase tracking-wider block">Proyección Base 2027–31</span>
        <div class="text-xl font-extrabold text-turf-800 mt-1" id="kpiProyBase">$0.0 M</div>
        <span class="text-[11px] text-slate-500 mt-0.5 block" id="kpiProyProm">Promedio: $0.0 M/año</span>
      </div>

      <div class="bg-white rounded-2xl border border-amber-200 bg-amber-50/40 p-4 shadow-sm">
        <span class="text-[11px] font-bold text-gold-700 uppercase tracking-wider block">+ Captura Cierres (Huff)</span>
        <div class="text-xl font-extrabold text-gold-700 mt-1" id="kpiCapturaHuff">+$0.0 M</div>
        <span class="text-[11px] font-bold text-gold-600 mt-0.5 block" id="kpiPctCaptura">+0.0% sobre base</span>
      </div>

      <div class="bg-white rounded-2xl border border-slate-300 p-4 shadow-sm bg-gradient-to-br from-white to-turf-50/30">
        <span class="text-[11px] font-bold text-pizarra-900 uppercase tracking-wider block">= Nueva Demanda Total</span>
        <div class="text-xl font-extrabold text-pizarra-900 mt-1" id="kpiTotalProy">$0.0 M</div>
        <span class="text-[11px] font-bold text-turf-700 mt-0.5 block" id="kpiDeltaTotal">Var. Neta: 0.0%</span>
      </div>

      <div class="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
        <span class="text-[11px] font-bold text-slate-500 uppercase tracking-wider block">Fuga Canal Digital (U₀)</span>
        <div class="text-xl font-extrabold text-slate-700 mt-1" id="kpiFugaDigital">0.0%</div>
        <span class="text-[11px] text-slate-500 mt-0.5 block" id="kpiFugaVol">$0.0 M fuera de red</span>
      </div>

    </div>"""
    KPIS_UNIFICADOS = """    <!-- TARJETAS KPIS EJECUTIVOS UNIFICADOS (DEMANDA Y VAN A 5 AÑOS) -->
    <div class="grid grid-cols-2 md:grid-cols-5 gap-3.5">
      <div class="bg-white rounded-xl border border-slate-200 p-3.5 shadow-2xs">
        <span class="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Demanda Proyectada (5A)</span>
        <div class="text-lg font-extrabold text-pizarra-900 mt-0.5" id="kpiResVenta">$0 M</div>
        <span class="text-[11px] text-slate-500 block" id="kpiResVentaSub">Base: $0 M</span>
      </div>
      <div class="bg-white rounded-xl border border-slate-200 p-3.5 shadow-2xs">
        <span class="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Ingresos por Comisión (5A)</span>
        <div class="text-lg font-extrabold text-turf-800 mt-0.5" id="kpiResComision">$0 M</div>
        <span class="text-[11px] text-slate-500 block" id="kpiResComisionSub">Base: $0 M</span>
      </div>
      <div class="bg-white rounded-xl border border-[#D1DCE8] bg-[#E8EEF5]/50 p-3.5 shadow-2xs">
        <span class="text-[10px] font-bold text-[#003058] uppercase tracking-wider block">Ahorro Costos Fijos (5A)</span>
        <div class="text-lg font-extrabold text-[#003058] mt-0.5" id="kpiResAhorroFijos">$0 M</div>
        <span class="text-[11px] font-semibold text-[#496276] block" id="kpiResAhorroFijosSub">Arriendos evitados</span>
      </div>
      <div class="bg-white rounded-xl border border-slate-300 bg-gradient-to-br from-white to-turf-50/40 p-3.5 shadow-2xs">
        <span class="text-[10px] font-bold text-pizarra-900 uppercase tracking-wider block">EBITDA 5A Con Cierres</span>
        <div class="text-lg font-extrabold text-turf-900 mt-0.5" id="kpiResEbitda">$0 M</div>
        <span class="text-[11px] font-bold text-turf-700 block" id="kpiResEbitdaDelta">Δ EBITDA: +$0 M</span>
      </div>
      <div class="bg-white rounded-xl border border-slate-200 p-3.5 shadow-2xs">
        <span class="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">VAN Incremental (10,5%)</span>
        <div class="text-lg font-extrabold text-pizarra-900 mt-0.5" id="kpiResVan">$0 M</div>
        <span class="text-[11px] text-slate-500 block" id="kpiResRetencion">Retención: 0%</span>
      </div>
    </div>"""
    h = reemplazar(h, KPIS_DEMANDA_ORIGINAL, KPIS_UNIFICADOS)

    # --- En la columna izquierda (8 cols), reemplazar el grafico anual redundante por el Grafico de EBITDA y la Tabla de Flujos y VAN ---
    ANUAL_REDUNDANTE_ORIGINAL = """        <!-- Gráfico Anual y Tabla de Trayectoria Anual -->
        <div class="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm space-y-4">
          <div class="flex items-center justify-between border-b border-slate-100 pb-3">
            <div>
              <h3 class="text-sm font-bold text-pizarra-900 tracking-tight">Trayectoria Anual Consolidada (2022–2031)</h3>
              <p class="text-xs text-slate-500">Desglose de demanda histórica realizada y quinquenio proyectado</p>
            </div>
            <div class="text-xs font-bold text-slate-600" id="badgeTotal5Y">Total 5Y: $0.0 M</div>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-12 gap-4 items-center">
            <div class="md:col-span-6 h-[200px]">
              <canvas id="annualBarChart"></canvas>
            </div>
            
            <div class="md:col-span-6 overflow-x-auto">
              <table class="w-full text-xs text-left">
                <thead>
                  <tr class="border-b border-slate-200 text-slate-500 font-bold">
                    <th class="py-1.5">Año</th>
                    <th class="py-1.5 text-right">Base</th>
                    <th class="py-1.5 text-right text-gold-700">+ Huff</th>
                    <th class="py-1.5 text-right font-extrabold text-pizarra-900">= Total</th>
                  </tr>
                </thead>
                <tbody id="annualTableBody" class="divide-y divide-slate-100 font-medium"></tbody>
              </table>
            </div>
          </div>
        </div>"""
    VAN_EN_COLUMNA_IZQ = """        <!-- TABLA ESTADO DE RESULTADOS Y VAN QUINQUENAL -->
        <div class="card overflow-x-auto">
          <div class="flex items-center justify-between mb-3">
            <h2 class="!mb-0 text-sm font-extrabold text-pizarra-900">Consolidado de flujos (MM CLP)</h2>
            <div class="text-xs text-slate-500" id="res-modo-moneda">Moneda: Real</div>
          </div>
          <div id="res-tabla-container" class="overflow-x-auto custom-scroll"></div>
        </div>

        <!-- Elementos internos ocultos para compatibilidad -->
        <div class="hidden">
          <div id="badgeTotal5Y"></div>
          <span id="res-badge-ebitda5y"></span>
          <table><thead><tr><th></th><th></th><th class="py-1.5 text-right text-gold-700">+ Huff</th><th></th></tr></thead><tbody id="annualTableBody"></tbody></table>
        </div>"""
    h = reemplazar(h, ANUAL_REDUNDANTE_ORIGINAL, VAN_EN_COLUMNA_IZQ)

    # --- Acciones rapidas y mes de cierre masivo en Simulador de Cierres ---
    ACCIONES_ORIGINAL = """          <!-- Botones de Acción Rápida -->
          <div class="space-y-2">
            <div class="flex flex-wrap items-center gap-1.5">
              <button onclick="toggleClosure('TLK-36')" class="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 transition-all">""" + "\u26a1" + """ Rosa O'Higgins</button>
              <button onclick="toggleGroupClosure(['TLK-14', 'TLK-31', 'TLK-36'])" class="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 transition-all">""" + "\u26a1" + """ 3 Menores G9</button>
              <button onclick="clearClosures()" class="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 transition-all ml-auto">""" + "\U0001f9f9" + """ Limpiar Todo</button>
            </div>
            
            <!-- Acciones de Cierre Masivo por Grupo -->
            <div class="flex flex-wrap items-center gap-1.5 pt-1 border-t border-slate-100">
              <span class="text-[10px] font-bold text-slate-400 uppercase tracking-wider mr-0.5">Cerrar Grupo:</span>
              <button onclick="toggleEntireGroup('G9')" id="btnGrp_G9" class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 transition-all">G9 (9)</button>
              <button onclick="toggleEntireGroup('RM')" id="btnGrp_RM" class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 transition-all">Resto RM (37)</button>
              <button onclick="toggleEntireGroup('REGIONES')" id="btnGrp_REGIONES" class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 transition-all">Regiones (16)</button>
            </div>
          </div>"""
    ACCIONES_NUEVO = """          <!-- Botones de Acción Rápida y Mes de Cierre -->
          <div class="space-y-2">
            <div class="flex flex-wrap items-center gap-1.5">
              <button type="button" onclick="cerrarDecididas()" class="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 transition-all" title="Cierra las sedes con decisión gerencial tomada">Decididas por gerencia</button>
              <button type="button" onclick="cerrarMenoresG9()" class="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 transition-all">3 menores G9</button>
              <button type="button" onclick="cerrarMargenNegativo()" class="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-rose-50 hover:bg-rose-100 text-rose-800 border border-rose-200 transition-all" title="Cierra sedes con margen operacional negativo">Margen &lt; 0</button>
              <button type="button" onclick="cerrarSegunMCDA()" class="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-[#FDF3D1] hover:bg-[#FBEAB4] text-[#C2410C] border border-[#D99A00] transition-all" title="Cierra las sedes candidatas según evaluación estratégica">Candidatas</button>
              <button type="button" onclick="clearClosures()" class="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-slate-50 hover:bg-slate-100 text-slate-600 border border-slate-200 transition-all ml-auto">Reabrir todas</button>
            </div>

            <!-- Selector de Mes de Cierre Masivo -->
            <div class="flex items-center justify-between gap-1.5 pt-1.5 pb-1 border-t border-slate-100 text-[11px]">
              <span class="text-slate-500 font-semibold text-[10.5px]">Mes de cierre masivo:</span>
              <div class="flex items-center gap-1">
                <select id="selMesCierreMasivo" class="bg-white border border-slate-200 text-slate-800 text-[11px] rounded px-1.5 py-0.5 font-bold">
                  <option value="1">Ene 2026 (Inmediato)</option>
                  <option value="2">Feb 2026</option>
                  <option value="3">Mar 2026</option>
                  <option value="4">Abr 2026</option>
                  <option value="5">May 2026</option>
                  <option value="6">Jun 2026 (Mitad de año)</option>
                  <option value="7">Jul 2026</option>
                  <option value="8">Ago 2026</option>
                  <option value="9">Sep 2026</option>
                  <option value="10">Oct 2026</option>
                  <option value="11">Nov 2026</option>
                  <option value="12">Dic 2026 (Fin de año)</option>
                  <option value="13">Año 2 (2027)</option>
                  <option value="25">Año 3 (2028)</option>
                </select>
                <button type="button" onclick="aplicarMesCierreMasivo(document.getElementById('selMesCierreMasivo').value)" class="px-2 py-0.5 rounded bg-[#FDF3D1] hover:bg-[#FBEAB4] text-[#C2410C] border border-[#D99A00] font-bold text-[10.5px] cursor-pointer">
                  Aplicar a cerradas
                </button>
              </div>
            </div>
            
            <!-- Acciones de Cierre Masivo por Grupo -->
            <div class="flex flex-wrap items-center gap-1.5 pt-1 border-t border-slate-100">
              <span class="text-[10px] font-bold text-slate-400 uppercase tracking-wider mr-0.5">Cerrar Grupo:</span>
              <button type="button" onclick="toggleEntireGroup('G9')" id="btnGrp_G9" class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 transition-all">G9 (9)</button>
              <button type="button" onclick="toggleEntireGroup('RM')" id="btnGrp_RM" class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 transition-all">Resto RM (37)</button>
              <button type="button" onclick="toggleEntireGroup('REGIONES')" id="btnGrp_REGIONES" class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 transition-all">Regiones (16)</button>
            </div>
          </div>"""
    h = reemplazar(h, ACCIONES_ORIGINAL, ACCIONES_NUEVO)

    # --- Colapsar Parametros Gravitacionales y Flujos en un <details> ---
    GRAV_ORIGINAL = """          <!-- Parámetros Gravitacionales -->
          <div class="pt-3 border-t border-slate-100 space-y-3">
            <div class="flex items-center justify-between text-xs font-semibold text-slate-600">
              <span>Fricción Distancia (λ):</span>
              <span class="font-extrabold text-pizarra-900" id="valLambda">4.0</span>
            </div>
            <input type="range" min="1.0" max="6.0" step="0.1" value="4.0" id="sliderLambda" oninput="onHuffParamChange()" class="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-gold-600">
            
            <div class="flex items-center justify-between text-xs font-semibold text-slate-600">
              <span>Fuga Digital Fuera de Red (U₀):</span>
              <span class="font-extrabold text-pizarra-900" id="valU0">0.1736</span>
            </div>
            <input type="range" min="0.0" max="0.80" step="0.01" value="0.1736" id="sliderU0" oninput="onHuffParamChange()" class="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-gold-600">
          </div>

          <!-- Flujos Gravitacionales hacia la Sede Actual / Cartera -->
          <div class="pt-3 border-t border-slate-100 space-y-2">
            <div class="flex items-center justify-between">
              <span class="text-[11px] font-bold text-slate-500 uppercase tracking-wider block" id="huffFlowTableTitle">Flujos de Captura hacia Sede:</span>
              <span class="text-[10px] text-slate-400 font-semibold" id="huffFlowTableSummary"></span>
            </div>
            <div class="max-h-[160px] overflow-y-auto custom-scroll text-xs">
              <table class="w-full text-left">
                <thead class="text-slate-400 font-bold border-b border-slate-100" id="huffFlowTableHead">
                  <tr>
                    <th class="py-1">Cerrada</th>
                    <th class="py-1 text-right">Dist (km)</th>
                    <th class="py-1 text-right">P(ij)</th>
                    <th class="py-1 text-right text-gold-700">Captura/año</th>
                  </tr>
                </thead>
                <tbody id="huffFlowTableBody" class="divide-y divide-slate-100">
                  <tr><td colspan="4" class="py-2.5 text-center text-slate-400">Sin locales cerrados activos.</td></tr>
                </tbody>
              </table>
            </div>
          </div>"""
    GRAV_NUEVO = """          <!-- Parámetros Gravitacionales y Flujos (Colapsado) -->
          <details class="pt-3 border-t border-slate-100 text-xs text-slate-600">
            <summary class="cursor-pointer font-semibold text-[#003058] hover:underline">Ver detalle de flujos de migración hacia sede</summary>
            <!-- Flujos Gravitacionales hacia la Sede Actual / Cartera -->
            <div class="pt-3 space-y-2">
              <div class="flex items-center justify-between">
                <span class="text-[11px] font-bold text-slate-500 uppercase tracking-wider block" id="huffFlowTableTitle">Flujos de Captura hacia Sede:</span>
                <span class="text-[10px] text-slate-400 font-semibold" id="huffFlowTableSummary"></span>
              </div>
              <div class="max-h-[160px] overflow-y-auto custom-scroll text-xs">
                <table class="w-full text-left">
                  <thead class="text-slate-400 font-bold border-b border-slate-100" id="huffFlowTableHead">
                    <tr>
                      <th class="py-1">Cerrada</th>
                      <th class="py-1 text-right">Dist (km)</th>
                      <th class="py-1 text-right">P(ij)</th>
                      <th class="py-1 text-right text-gold-700">Captura/año</th>
                    </tr>
                  </thead>
                  <tbody id="huffFlowTableBody" class="divide-y divide-slate-100">
                    <tr><td colspan="4" class="py-2.5 text-center text-slate-400">Sin locales cerrados activos.</td></tr>
                  </tbody>
                </table>
              </div>
            </div>
          </details>"""
    h = reemplazar(h, GRAV_ORIGINAL, GRAV_NUEVO)

    # --- Colapsar Parametros Dinamicos de Demanda en un <details> ---
    DINAMICOS_ORIGINAL = """        <!-- PANEL DE PARÁMETROS DINÁMICOS -->
        <div class="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm space-y-4">
          <div class="flex items-center justify-between border-b border-slate-100 pb-2.5">
            <h3 class="text-sm font-extrabold text-pizarra-900 uppercase tracking-wider flex items-center space-x-1.5">
              <span class="w-2 h-2 rounded-full bg-turf-700 inline-block"></span>
              <span>Parámetros de Demanda</span>
            </h3>
            <button onclick="restoreCleanG1()" class="text-[11px] font-bold text-turf-700 hover:underline">Restaurar g₁ Limpio</button>
          </div>

          <!-- Slider g1 -->
          <div class="space-y-1.5">
            <div class="flex items-center justify-between text-xs font-semibold text-slate-600">
              <span>Tendencia Orgánica Anual (g₁):</span>
              <span class="font-extrabold text-pizarra-900" id="valG1">0.0%</span>
            </div>
            <input type="range" min="-20.0" max="15.0" step="0.1" value="0.0" id="sliderG1" oninput="onDynamicParamChange()" class="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-turf-700">
          </div>

          <!-- Slider Shrinkage -->
          <div class="space-y-1.5">
            <div class="flex items-center justify-between text-xs font-semibold text-slate-600">
              <span>Contracción / Shrinkage (κ):</span>
              <span class="font-extrabold text-pizarra-900" id="valShrinkage">50%</span>
            </div>
            <input type="range" min="0" max="100" step="5" value="50" id="sliderShrinkage" oninput="onDynamicParamChange()" class="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-turf-700">
          </div>

          <!-- Slider Amortiguación phi -->
          <div class="space-y-1.5">
            <div class="flex items-center justify-between text-xs font-semibold text-slate-600">
              <span>Amortiguación Anual (φ):</span>
              <span class="font-extrabold text-pizarra-900" id="valPhi">0.94</span>
            </div>
            <input type="range" min="0.50" max="1.00" step="0.01" value="0.94" id="sliderPhi" oninput="onDynamicParamChange()" class="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-turf-700">
            <span class="text-[10px] text-slate-400 block">Factor mensual: φ^(h/12) acumulado en el quinquenio</span>
          </div>

          <!-- Slider Shock Manual -->
          <div class="space-y-1.5">
            <div class="flex items-center justify-between text-xs font-semibold text-slate-600">
              <span>Shock Manual de Nivel (Δ%):</span>
              <span class="font-extrabold text-pizarra-900" id="valShock">0%</span>
            </div>
            <input type="range" min="-30" max="30" step="1" value="0" id="sliderShock" oninput="onDynamicParamChange()" class="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-turf-700">
          </div>

          <!-- Slider Inflación -->
          <div class="space-y-1.5">
            <div class="flex items-center justify-between text-xs font-semibold text-slate-600">
              <span>Inflación Anual Proyectada (π):</span>
              <span class="font-extrabold text-pizarra-900" id="valInfl">3.0%</span>
            </div>
            <input type="range" min="0.0" max="10.0" step="0.5" value="3.0" id="sliderInfl" oninput="onDynamicParamChange()" class="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-turf-700">
          </div>

        </div>"""
    DINAMICOS_NUEVO = """        <!-- SUPUESTOS FINANCIEROS Y CANAL DIGITAL -->
        <div class="card space-y-3">
          <h2 class="!mb-0 text-xs font-bold uppercase tracking-wider text-slate-600">Parámetros Financieros y Canal Online</h2>
          
          <div class="space-y-1.5">
            <div class="flex items-center justify-between text-xs font-semibold text-slate-600">
              <span>Retención Canal Digital:</span>
              <span class="font-extrabold text-pizarra-900" id="valRetencionDigital">35%</span>
            </div>
            <input type="range" min="0" max="80" step="5" value="35" id="sliderRetencionDigital" oninput="onParamResultadoChange()" class="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-[#003058]">
            <span class="text-[10px] text-slate-400 block">% de los clientes sin sede cercana que pasan a Teletrak.cl</span>
          </div>

          <div class="space-y-1.5 pt-2 border-t border-slate-100">
            <div class="flex items-center justify-between text-xs font-semibold text-slate-600">
              <span>Tasa de Descuento Anual:</span>
              <span class="font-extrabold text-pizarra-900" id="valTasaDescuento">10.5%</span>
            </div>
            <input type="range" min="4" max="20" step="0.05" value="10.5" id="sliderTasaDescuento" oninput="onParamResultadoChange()" class="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-[#003058]">
            <span class="text-[10px] text-slate-400 block">WACC nominal (CAPM). En vista real se usa la tasa real equivalente.</span>
          </div>

          <div class="space-y-1.5 pt-2 border-t border-slate-100">
            <label class="block text-xs font-semibold text-slate-600 mb-0.5">Costo Online vs Presencial:</label>
            <select id="selCostoOnline" onchange="onParamResultadoChange()" class="w-full bg-slate-50 border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-pizarra-900 focus:ring-1 focus:ring-[#003058] focus:outline-none cursor-pointer">
              <option value="0.15" selected>15% del costo presencial (Ahorro del 85%)</option>
              <option value="0.10">10% del costo presencial (Ahorro del 90%)</option>
              <option value="0.25">25% del costo presencial (Ahorro del 75%)</option>
              <option value="0.05">5% del costo presencial (Ahorro del 95%)</option>
              <option value="0.00">0% (Costo marginal online nulo)</option>
            </select>
          </div>
        </div>

        <!-- PANEL DE PARÁMETROS DINÁMICOS DE DEMANDA -->
        <div class="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm space-y-4">
          <div class="flex items-center justify-between border-b border-slate-100 pb-2.5">
            <h3 class="text-sm font-extrabold text-pizarra-900 uppercase tracking-wider flex items-center space-x-1.5">
              <span class="w-2 h-2 rounded-full bg-turf-700 inline-block"></span>
              <span>Parámetros de Demanda</span>
            </h3>
            <div class="flex items-center gap-2">
              <button type="button" onclick="restoreCleanG1()" class="text-[11px] font-bold text-[#003058] hover:underline">Restaurar g₁ Limpio</button>
              <button type="button" onclick="abrirModalAjustesHW()" title="Ajustes avanzados de modelo (Holt-Winters)" class="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-800 transition-colors cursor-pointer">
                <svg class="w-4 h-4 fill-none stroke-current" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
              </button>
            </div>
          </div>

          <!-- Slider g1 -->
          <div class="space-y-1.5">
            <div class="flex items-center justify-between text-xs font-semibold text-slate-600">
              <span>Tendencia Orgánica Anual (g₁):</span>
              <span class="font-extrabold text-pizarra-900" id="valG1">0.0%</span>
            </div>
            <input type="range" min="-20.0" max="15.0" step="0.1" value="0.0" id="sliderG1" oninput="onDynamicParamChange()" class="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-[#003058]">
          </div>

          <!-- Slider Shrinkage -->
          <div class="space-y-1.5">
            <div class="flex items-center justify-between text-xs font-semibold text-slate-600">
              <span>Contracción / Shrinkage (κ):</span>
              <span class="font-extrabold text-pizarra-900" id="valShrinkage">50%</span>
            </div>
            <input type="range" min="0" max="100" step="5" value="50" id="sliderShrinkage" oninput="onDynamicParamChange()" class="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-[#003058]">
          </div>

          <!-- Slider Amortiguación phi -->
          <div class="space-y-1.5">
            <div class="flex items-center justify-between text-xs font-semibold text-slate-600">
              <span>Amortiguación Anual (φ):</span>
              <span class="font-extrabold text-pizarra-900" id="valPhi">0.94</span>
            </div>
            <input type="range" min="0.50" max="1.00" step="0.01" value="0.94" id="sliderPhi" oninput="onDynamicParamChange()" class="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-[#003058]">
            <span class="text-[10px] text-slate-400 block">Factor mensual: φ^(h/12) acumulado en el quinquenio</span>
          </div>

          <!-- Slider Inflación -->
          <div class="space-y-1.5">
            <div class="flex items-center justify-between text-xs font-semibold text-slate-600">
              <span>Inflación Anual Proyectada (π):</span>
              <span class="font-extrabold text-pizarra-900" id="valInfl">3.0%</span>
            </div>
            <input type="range" min="0.0" max="10.0" step="0.5" value="3.0" id="sliderInfl" oninput="onDynamicParamChange()" class="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-[#003058]">
          </div>

        </div>"""
    h = reemplazar(h, DINAMICOS_ORIGINAL, DINAMICOS_NUEVO)

    h = reemplazar(h, "(ej: TLK-36, Renca, Buin)", "(Id o nombre)")
    h = reemplazar(h, r"\s*<button onclick=\"setClosureGroupFilter\('DIGITAL'\)\"[^>]*>Digitales \(3\)</button>", "", regex=True)
    h = reemplazar(h, "Checkboxes de Sedes (65 Sedes Organizadas por Grupos)", "Checkboxes de sedes fisicas organizadas por grupo")
    h = reemplazar(h, r"(?s)\s*<!-- FOOTER -->\s*<footer.*?</footer>", "", regex=True)

    # --- Estado con soporte Holt-Winters y Blindaje de Toggles ---
    STATE_ORIGINAL = """      // Parámetros Dinámicos
      g1_override: null,
      shrinkage: 0.50,
      phi: 0.94,
      levelShockPct: 0.0,
      inflationRate: 0.030
    };"""
    STATE_NUEVO = """      // Parámetros Dinámicos
      g1_override: null,
      shrinkage: 0.50,
      phi: 0.94,
      levelShockPct: 0.0,
      inflationRate: 0.030,
      hwConfig: { modo: 'auto', alphaOverride: null, betaOverride: null, gammaOverride: null, trendActive: true }
    };"""
    h = reemplazar(h, STATE_ORIGINAL, STATE_NUEVO)

    SET_SERIES_ORIGINAL = """    function setSeriesMode(mode) {
      state.seriesMode = mode;
      document.getElementById('btnLimpia').className = mode === 'CLEAN' ? 'px-3 py-1 rounded-md transition-all active-pill' : 'px-3 py-1 rounded-md transition-all text-slate-600 hover:text-slate-900';
      document.getElementById('btnCruda').className = mode === 'RAW' ? 'px-3 py-1 rounded-md transition-all active-pill' : 'px-3 py-1 rounded-md transition-all text-slate-600 hover:text-slate-900';
      renderAll();
    }"""
    SET_SERIES_BLINDADO = """    function setSeriesMode(mode) {
      state.seriesMode = mode;
      const bL = document.getElementById('btnLimpia');
      if (bL) bL.className = mode === 'CLEAN' ? 'px-3 py-1 rounded-md transition-all active-pill' : 'px-3 py-1 rounded-md transition-all text-slate-600 hover:text-slate-900';
      const bC = document.getElementById('btnCruda');
      if (bC) bC.className = mode === 'RAW' ? 'px-3 py-1 rounded-md transition-all active-pill' : 'px-3 py-1 rounded-md transition-all text-slate-600 hover:text-slate-900';
      renderAll();
    }"""
    h = reemplazar(h, SET_SERIES_ORIGINAL, SET_SERIES_BLINDADO)

    HANDLERS_ORIGINAL = """    function onHuffParamChange() {
      state.lambda = parseFloat(document.getElementById('sliderLambda').value);
      state.u0 = parseFloat(document.getElementById('sliderU0').value);
      document.getElementById('valLambda').textContent = state.lambda.toFixed(1);
      document.getElementById('valU0').textContent = state.u0.toFixed(4);
      renderAll();
    }

    function onDynamicParamChange() {
      state.g1_override = parseFloat(document.getElementById('sliderG1').value);
      state.shrinkage = parseFloat(document.getElementById('sliderShrinkage').value) / 100.0;
      state.phi = parseFloat(document.getElementById('sliderPhi').value);
      state.levelShockPct = parseFloat(document.getElementById('sliderShock').value) / 100.0;
      state.inflationRate = parseFloat(document.getElementById('sliderInfl').value) / 100.0;

      document.getElementById('valG1').textContent = (state.g1_override > 0 ? '+' : '') + state.g1_override.toFixed(1) + '%';
      document.getElementById('valShrinkage').textContent = Math.round(state.shrinkage * 100) + '%';
      document.getElementById('valPhi').textContent = state.phi.toFixed(2);
      document.getElementById('valShock').textContent = (state.levelShockPct > 0 ? '+' : '') + Math.round(state.levelShockPct * 100) + '%';
      document.getElementById('valInfl').textContent = (state.inflationRate * 100).toFixed(1) + '%';
      
      renderAll();
    }

    function restoreCleanG1() {
      loadEntityDefaults(state.currentEntity);
      renderAll();
    }

    function resetAllDefaults() {
      clearClosures();
      state.lambda = 4.0;
      state.u0 = 0.1736;
      state.shrinkage = 0.50;
      state.phi = 0.94;
      state.levelShockPct = 0.0;
      state.inflationRate = 0.030;
      
      document.getElementById('sliderLambda').value = 4.0;
      document.getElementById('sliderU0').value = 0.1736;
      document.getElementById('sliderShrinkage').value = 50;
      document.getElementById('sliderPhi').value = 0.94;
      document.getElementById('sliderShock').value = 0;
      document.getElementById('sliderInfl').value = 3.0;

      document.getElementById('valLambda').textContent = '4.0';
      document.getElementById('valU0').textContent = '0.1736';
      document.getElementById('valShrinkage').textContent = '50%';
      document.getElementById('valPhi').textContent = '0.94';
      document.getElementById('valShock').textContent = '0%';
      document.getElementById('valInfl').textContent = '3.0%';

      loadEntityDefaults(state.currentEntity);
      renderAll();
    }"""
    HANDLERS_NUEVO = """    function onHuffParamChange() {
      state.lambda = document.getElementById('sliderLambda') ? parseFloat(document.getElementById('sliderLambda').value) : (state.lambda || 4.0);
      state.u0 = document.getElementById('sliderU0') ? parseFloat(document.getElementById('sliderU0').value) : (state.u0 || 0.1736);
      const elL = document.getElementById('valLambda');
      if (elL) elL.textContent = state.lambda.toFixed(1);
      const elU = document.getElementById('valU0');
      if (elU) elU.textContent = state.u0.toFixed(4);
      renderAll();
    }

    function onDynamicParamChange() {
      if (document.getElementById('sliderG1')) state.g1_override = parseFloat(document.getElementById('sliderG1').value);
      if (document.getElementById('sliderShrinkage')) state.shrinkage = parseFloat(document.getElementById('sliderShrinkage').value) / 100.0;
      if (document.getElementById('sliderPhi')) state.phi = parseFloat(document.getElementById('sliderPhi').value);
      state.levelShockPct = document.getElementById('sliderShock') ? parseFloat(document.getElementById('sliderShock').value) / 100.0 : 0.0;
      if (document.getElementById('sliderInfl')) state.inflationRate = parseFloat(document.getElementById('sliderInfl').value) / 100.0;

      if (document.getElementById('valG1') && state.g1_override !== null) {
        document.getElementById('valG1').textContent = (state.g1_override > 0 ? '+' : '') + state.g1_override.toFixed(1) + '%';
      }
      if (document.getElementById('valShrinkage')) document.getElementById('valShrinkage').textContent = Math.round(state.shrinkage * 100) + '%';
      if (document.getElementById('valPhi')) document.getElementById('valPhi').textContent = state.phi.toFixed(2);
      if (document.getElementById('valShock')) document.getElementById('valShock').textContent = (state.levelShockPct > 0 ? '+' : '') + Math.round(state.levelShockPct * 100) + '%';
      if (document.getElementById('valInfl')) document.getElementById('valInfl').textContent = (state.inflationRate * 100).toFixed(1) + '%';
      
      renderAll();
    }

    function restoreCleanG1() {
      loadEntityDefaults(state.currentEntity);
      renderAll();
    }

    function resetAllDefaults() {
      clearClosures();
      state.lambda = 4.0;
      state.u0 = 0.1736;
      state.shrinkage = 0.50;
      state.phi = 0.94;
      state.levelShockPct = 0.0;
      state.inflationRate = 0.030;
      state.hwConfig = { modo: 'auto', alphaOverride: null, betaOverride: null, gammaOverride: null, trendActive: true };
      
      const sL = document.getElementById('sliderLambda'); if (sL) sL.value = 4.0;
      const sU = document.getElementById('sliderU0'); if (sU) sU.value = 0.1736;
      const sS = document.getElementById('sliderShrinkage'); if (sS) sS.value = 50;
      const sP = document.getElementById('sliderPhi'); if (sP) sP.value = 0.94;
      const sSh = document.getElementById('sliderShock'); if (sSh) sSh.value = 0;
      const sI = document.getElementById('sliderInfl'); if (sI) sI.value = 3.0;

      const vL = document.getElementById('valLambda'); if (vL) vL.textContent = '4.0';
      const vU = document.getElementById('valU0'); if (vU) vU.textContent = '0.1736';
      const vS = document.getElementById('valShrinkage'); if (vS) vS.textContent = '50%';
      const vP = document.getElementById('valPhi'); if (vP) vP.textContent = '0.94';
      const vSh = document.getElementById('valShock'); if (vSh) vSh.textContent = '0%';
      const vI = document.getElementById('valInfl'); if (vI) vI.textContent = '3.0%';

      loadEntityDefaults(state.currentEntity);
      renderAll();
    }

    window.abrirModalAjustesHW = function() {
      const m = document.getElementById('modal-ajustes-hw');
      if (!m) return;
      m.hidden = false;
      m.classList.remove('hidden');
      const nomSpan = document.getElementById('hwModalSedeNombre');
      if (nomSpan && typeof DASHBOARD_DATA !== 'undefined' && DASHBOARD_DATA && DASHBOARD_DATA.locales) {
        const loc = DASHBOARD_DATA.locales[state.currentEntity];
        nomSpan.textContent = loc ? (loc.nombre || state.currentEntity) : state.currentEntity;
      }
      sincronizarModalHWDesdeEstado();
    };

    window.cerrarModalAjustesHW = function() {
      const m = document.getElementById('modal-ajustes-hw');
      if (!m) return;
      m.hidden = true;
      m.classList.add('hidden');
    };

    window.setModoHW = function(modo) {
      if (!state.hwConfig) state.hwConfig = { modo: 'auto', alphaOverride: null, betaOverride: null, gammaOverride: null, trendActive: true };
      state.hwConfig.modo = modo;
      actualizarEstiloModoHW();
    };

    function actualizarEstiloModoHW() {
      const modo = (state.hwConfig && state.hwConfig.modo) || 'auto';
      const bAuto = document.getElementById('btnHwModoAuto');
      const bMan = document.getElementById('btnHwModoManual');
      if (bAuto) bAuto.className = modo === 'auto' ? 'px-3 py-1 rounded-md transition-all active-pill' : 'px-3 py-1 rounded-md transition-all text-slate-600 hover:text-slate-900';
      if (bMan) bMan.className = modo === 'manual' ? 'px-3 py-1 rounded-md transition-all active-pill' : 'px-3 py-1 rounded-md transition-all text-slate-600 hover:text-slate-900';
    }

    window.onHwModalInput = function(param, val) {
      if (!state.hwConfig) state.hwConfig = { modo: 'auto', alphaOverride: null, betaOverride: null, gammaOverride: null, trendActive: true };
      if (param === 'alpha') {
        const num = parseFloat(val);
        const s = document.getElementById('sliderHwAlpha'); if (s) s.value = num;
        const n = document.getElementById('numHwAlpha'); if (n) n.value = num;
        const v = document.getElementById('valHwAlpha'); if (v) v.textContent = num.toFixed(2);
      } else if (param === 'beta') {
        const num = parseFloat(val);
        const s = document.getElementById('sliderHwBeta'); if (s) s.value = num;
        const n = document.getElementById('numHwBeta'); if (n) n.value = num;
        const v = document.getElementById('valHwBeta'); if (v) v.textContent = num.toFixed(2);
      } else if (param === 'gamma') {
        const num = parseFloat(val);
        const s = document.getElementById('sliderHwGamma'); if (s) s.value = num;
        const n = document.getElementById('numHwGamma'); if (n) n.value = num;
        const v = document.getElementById('valHwGamma'); if (v) v.textContent = num.toFixed(2);
      } else if (param === 'trendMode') {
        const sel = document.getElementById('selHwTrendMode');
        if (sel) sel.value = val;
        if (val === 'none') {
          const s = document.getElementById('sliderHwBeta'); if (s) s.value = 0;
          const n = document.getElementById('numHwBeta'); if (n) n.value = 0;
          const v = document.getElementById('valHwBeta'); if (v) v.textContent = '0.00';
        }
      } else if (param === 'lambda') {
        const num = parseFloat(val);
        const s = document.getElementById('sliderHwLambda'); if (s) s.value = num;
        const v = document.getElementById('valHwLambda'); if (v) v.textContent = num.toFixed(1);
      } else if (param === 'u0') {
        const num = parseFloat(val);
        const s = document.getElementById('sliderHwU0'); if (s) s.value = num;
        const v = document.getElementById('valHwU0'); if (v) v.textContent = num.toFixed(4);
      }
    };

    function sincronizarModalHWDesdeEstado() {
      actualizarEstiloModoHW();
      const loc = (typeof DASHBOARD_DATA !== 'undefined' && DASHBOARD_DATA && DASHBOARD_DATA.locales) ? DASHBOARD_DATA.locales[state.currentEntity] : null;
      const baseAlpha = (loc && typeof loc.hw_alpha === 'number') ? loc.hw_alpha : 0.35;
      const baseBeta = (loc && typeof loc.hw_beta === 'number') ? loc.hw_beta : 0.12;
      const baseGamma = (loc && typeof loc.hw_gamma === 'number') ? loc.hw_gamma : 0.25;

      const refA = document.getElementById('refHwAlpha'); if (refA) refA.textContent = `Base sede: ${baseAlpha.toFixed(2)}`;
      const refB = document.getElementById('refHwBeta'); if (refB) refB.textContent = `Base sede: ${baseBeta.toFixed(2)}`;
      const refG = document.getElementById('refHwGamma'); if (refG) refG.textContent = `Base sede: ${baseGamma.toFixed(2)}`;

      const curAlpha = (state.hwConfig && state.hwConfig.alphaOverride !== null) ? state.hwConfig.alphaOverride : baseAlpha;
      const curBeta = (state.hwConfig && state.hwConfig.betaOverride !== null) ? state.hwConfig.betaOverride : baseBeta;
      const curGamma = (state.hwConfig && state.hwConfig.gammaOverride !== null) ? state.hwConfig.gammaOverride : baseGamma;
      const trendActive = state.hwConfig ? state.hwConfig.trendActive : true;

      window.onHwModalInput('alpha', curAlpha);
      window.onHwModalInput('beta', curBeta);
      window.onHwModalInput('gamma', curGamma);
      window.onHwModalInput('trendMode', trendActive ? 'active' : 'none');
      window.onHwModalInput('lambda', state.lambda || 4.0);
      window.onHwModalInput('u0', state.u0 !== undefined ? state.u0 : 0.1736);
    }

    window.restaurarCalibracionOptimaHW = function() {
      state.hwConfig = { modo: 'auto', alphaOverride: null, betaOverride: null, gammaOverride: null, trendActive: true };
      state.lambda = 4.0;
      state.u0 = 0.1736;
      sincronizarModalHWDesdeEstado();
      renderAll();
    };

    window.aplicarAjustesHW = function() {
      if (!state.hwConfig) state.hwConfig = { modo: 'auto', alphaOverride: null, betaOverride: null, gammaOverride: null, trendActive: true };
      const modo = state.hwConfig.modo;
      if (modo === 'manual') {
        const sA = document.getElementById('sliderHwAlpha');
        const sB = document.getElementById('sliderHwBeta');
        const sG = document.getElementById('sliderHwGamma');
        const selT = document.getElementById('selHwTrendMode');
        state.hwConfig.alphaOverride = sA ? parseFloat(sA.value) : null;
        state.hwConfig.betaOverride = sB ? parseFloat(sB.value) : null;
        state.hwConfig.gammaOverride = sG ? parseFloat(sG.value) : null;
        state.hwConfig.trendActive = selT ? (selT.value === 'active') : true;
      } else {
        state.hwConfig.alphaOverride = null;
        state.hwConfig.betaOverride = null;
        state.hwConfig.gammaOverride = null;
        state.hwConfig.trendActive = true;
      }
      const sL = document.getElementById('sliderHwLambda');
      if (sL) state.lambda = parseFloat(sL.value);
      const sU = document.getElementById('sliderHwU0');
      if (sU) state.u0 = parseFloat(sU.value);

      window.cerrarModalAjustesHW();
      renderAll();
    };

    if (!window.ajustarProyeccionHW) {
      window.ajustarProyeccionHW = function(ctx) {
        if (!ctx || !ctx.hwConfig) return null;
        const cfg = ctx.hwConfig;
        if (cfg.modo === 'manual') {
          if (ctx.stage === 'renderAll') {
            let eff = ctx.eff_g1_monthly;
            if (cfg.trendActive === false || cfg.betaOverride === 0) {
              eff = 0.0;
            } else if (typeof cfg.betaOverride === 'number') {
              eff = eff * (cfg.betaOverride / 0.12);
            }
            return { eff_g1_monthly: eff };
          }
          if (ctx.stage === 'monthlyWeights') {
            if (typeof cfg.gammaOverride === 'number') {
              const w = ctx.weight;
              const w_adj = (1.0 / 12.0) + (w - 1.0 / 12.0) * (cfg.gammaOverride / 0.25);
              return { weight: Math.max(0.001, w_adj) };
            }
          }
        }
        return null;
      };
    }"""
    h = reemplazar(h, HANDLERS_ORIGINAL, HANDLERS_NUEVO)

    RENDERALL_DERIVA_ORIGINAL = """      // 2. Factores de deriva orgánica modificada y amortiguada
      const g1_active = state.g1_override !== null ? state.g1_override : loc.g1_organica_anual_pct;
      const eff_g1_monthly = (g1_active / 100.0) * state.shrinkage / 12.0;"""
    RENDERALL_DERIVA_NUEVO = """      // 2. Factores de deriva orgánica modificada y amortiguada
      let g1_active = state.g1_override !== null ? state.g1_override : loc.g1_organica_anual_pct;
      let eff_g1_monthly = (g1_active / 100.0) * state.shrinkage / 12.0;
      if (typeof window.ajustarProyeccionHW === 'function') {
        const hwAdj = window.ajustarProyeccionHW({
          stage: 'renderAll',
          entityId: state.currentEntity,
          hwConfig: state.hwConfig,
          g1_active: g1_active,
          eff_g1_monthly: eff_g1_monthly,
          loc: loc
        });
        if (hwAdj) {
          if (typeof hwAdj.eff_g1_monthly === 'number') eff_g1_monthly = hwAdj.eff_g1_monthly;
          if (typeof hwAdj.g1_active === 'number') g1_active = hwAdj.g1_active;
        }
      }"""
    h = reemplazar(h, RENDERALL_DERIVA_ORIGINAL, RENDERALL_DERIVA_NUEVO)

    HIST_MENSUAL_ORIGINAL = """              {
                label: isClean ? 'Demanda Histórica Limpia' : 'Demanda Histórica Cruda',
                data: histValues.concat(new Array(proyLabels.length).fill(null)),
                borderColor: isClean ? '#15803D' : '#64748B',"""
    HIST_MENSUAL_NUEVO = """              {
                label: 'Demanda Histórica',
                data: histValues.concat(new Array(proyLabels.length).fill(null)),
                borderColor: '#003058',"""
    h = reemplazar(h, HIST_MENSUAL_ORIGINAL, HIST_MENSUAL_NUEVO)

    ANNUAL_BAR_ORIGINAL = """    function renderAnnualBarChart(dispBaseAnual, dispHuffAnual, dispTotalAnual, hipoShare) {
      const ctx = document.getElementById('annualBarChart').getContext('2d');"""
    ANNUAL_BAR_BLINDADO = """    function renderAnnualBarChart(dispBaseAnual, dispHuffAnual, dispTotalAnual, hipoShare) {
      const el = document.getElementById('annualBarChart');
      if (!el) return;
      const ctx = el.getContext('2d');"""
    h = reemplazar(h, ANNUAL_BAR_ORIGINAL, ANNUAL_BAR_BLINDADO)

    # --- Logica: inicializacion bajo demanda, anos dinamicos, digitales fuera de Huff ---
    h = reemplazar(h, """    window.addEventListener('DOMContentLoaded', () => {
      initSelectors();
      initClosureCheckboxes();
      loadEntityDefaults(state.currentEntity);
      renderAll();
    });""", """    // Se llama cada vez que se abre un resultado (capa_datos.js arma DASHBOARD_DATA)
    function iniciarDashboard() {
      if (!DASHBOARD_DATA.g9_ids.length && state.currentEntity === 'CONSOLIDADO_G9') state.currentEntity = 'CONSOLIDADO_RED';
      initSelectors();
      initClosureCheckboxes();
      document.getElementById('entitySelect').value = state.currentEntity;
      etiquetasDeGrupo();
      setClosureGroupFilter(state.currentClosureTab || 'ALL');
      document.querySelectorAll('#closureCheckboxesContainer input').forEach(cb => cb.checked = state.closedStores.has(cb.value));
      updateClosureUI();
      if (state.g1_override === null) loadEntityDefaults(state.currentEntity);
      renderAll();
    }""")
    h = reemplazar(h, """        { key: 'REGIONES', title: 'Sedes en Regiones (16 Sedes)', ids: DASHBOARD_DATA.regiones_ids, badgeBg: 'bg-purple-100 text-purple-800' },
        { key: 'DIGITAL', title: 'Canales Digitales (3)', ids: DASHBOARD_DATA.digital_ids, badgeBg: 'bg-sky-100 text-sky-800' }
      ];""", """        { key: 'REGIONES', title: 'Sedes en Regiones', ids: DASHBOARD_DATA.regiones_ids, badgeBg: 'bg-purple-100 text-purple-800' }
      ].map(g => ({ ...g, ids: g.ids.filter(id => DASHBOARD_DATA.huff_ids.includes(id)) }));  // solo sedes fisicas con coordenadas""")
    h = reemplazar(h, "{ key: 'G9', title: 'Grupo G9 (9 Sedes RM)',", "{ key: 'G9', title: 'Grupo G9',")
    h = reemplazar(h, "{ key: 'RM', title: 'Resto Región Metropolitana (37 Sedes)',", "{ key: 'RM', title: 'Resto Región Metropolitana',")
    h = reemplazar(h, "const openRecipients = DASHBOARD_DATA.red_ids.filter(id => !state.closedStores.has(id));",
                   "const openRecipients = DASHBOARD_DATA.huff_ids.filter(id => !state.closedStores.has(id));  // solo sedes fisicas")
    h = reemplazar(h, "const att = Math.max(1.0, DASHBOARD_DATA.locales[openId].venta_base_2026_mm); // atractivo relativo",
                   "const att = atractivoHuff(openId);  // 'relativo' (venta/promedio) o 'mm_clp' (original), ver capa_datos.js")
    h = reemplazar(h, "const anos = [2027, 2028, 2029, 2030, 2031];", "const anos = DASHBOARD_DATA.anos_proy;")
    RENDERMAIN_WEIGHTS_ORIGINAL = """          const yIdx = y - 2027;
          const w_m = loc.month_weights[m - 1] || (1.0 / 12.0);"""
    RENDERMAIN_WEIGHTS_NUEVO = """          const yIdx = y - DASHBOARD_DATA.anos_proy[0];
          let w_m = loc.month_weights[m - 1] || (1.0 / 12.0);
          if (typeof window.ajustarProyeccionHW === 'function') {
            const mAdj = window.ajustarProyeccionHW({
              stage: 'monthlyWeights',
              entityId: state.currentEntity,
              hwConfig: state.hwConfig,
              month: m,
              weight: w_m,
              loc: loc
            });
            if (mAdj && typeof mAdj.weight === 'number') w_m = mAdj.weight;
          }"""
    h = reemplazar(h, RENDERMAIN_WEIGHTS_ORIGINAL, RENDERMAIN_WEIGHTS_NUEVO)
    h = reemplazar(h, "const proyAnos = [2027, 2028, 2029, 2030, 2031];", "const proyAnos = DASHBOARD_DATA.anos_proy;")
    h = reemplazar(h, "labels: ['2027', '2028', '2029', '2030', '2031'],", "labels: DASHBOARD_DATA.anos_proy.map(String),")
    h = reemplazar(h, "`Var. vs 2026: ", "`Var. vs últ. 12m: ")
    # Banda P10-P90 real del Monte Carlo (antes +-12% fijo)
    h = reemplazar(h, """          p10Values.push(baseValM * 0.88);
          p90Values.push(baseValM * 1.12);""", """          const pb = loc.proy_anual_base;
          p10Values.push(baseValM * (pb.real_p50[yIdx] > 0 ? pb.real_p10[yIdx] / pb.real_p50[yIdx] : 0.88));
          p90Values.push(baseValM * (pb.real_p50[yIdx] > 0 ? pb.real_p90[yIdx] / pb.real_p50[yIdx] : 1.12));""")
    h = reemplazar(h, "label: 'Banda P90',", "label: 'Banda P10-P90 (Monte Carlo)',")

    # Cierres por grupo: solo sedes fisicas con coordenadas (sin matriz el original asumia 5 km)
    h = reemplazar(h, "      else if (groupKey === 'DIGITAL') targetIds = DASHBOARD_DATA.digital_ids;\n",
                   "      else if (groupKey === 'DIGITAL') targetIds = DASHBOARD_DATA.digital_ids;\n"
                   "      targetIds = targetIds.filter(id => DASHBOARD_DATA.huff_ids.includes(id));\n")
    h = reemplazar(h, "        let ids = (k === 'G9') ? DASHBOARD_DATA.g9_ids : (k === 'RM' ? DASHBOARD_DATA.rm_ids : DASHBOARD_DATA.regiones_ids);\n",
                   "        let ids = (k === 'G9') ? DASHBOARD_DATA.g9_ids : (k === 'RM' ? DASHBOARD_DATA.rm_ids : DASHBOARD_DATA.regiones_ids);\n"
                   "        ids = ids.filter(id => DASHBOARD_DATA.huff_ids.includes(id));\n")

    # Los Id_Division (000.000.000) son mas largos que los TLK-xx del original
    h = reemplazar(h, '<span class="font-bold text-pizarra-900 w-14 shrink-0">${id}</span>',
                   '<span class="font-bold text-pizarra-900 w-[5.6rem] shrink-0 font-mono text-[11px]">${id}</span>')

    # Despues de dibujar: avisos de uso del simulador y pintar consolidado de VAN integrado
    h = reemplazar(h, "      renderAnnualBarChart(dispBaseAnual, dispHuffAnual, dispTotalAnual, hipoShare);\n    }",
                   "      renderAnnualBarChart(dispBaseAnual, dispHuffAnual, dispTotalAnual, hipoShare);\n"
                   "      if (window.despuesDeRender) window.despuesDeRender();\n"
                   "      if (typeof pintarResultado === 'function') pintarResultado();\n    }")

    # Cambios del simulador avisan al resto de la herramienta (mapa, estado, VAN)
    h = reemplazar(h, "    function renderAll() {",
                   "    function renderAll() {\n      if (!DASHBOARD_DATA) return;\n      if (window.alCambiarSimulador) window.alCambiarSimulador();")

    # --- Simplificacion de lenguaje tecnico (bajar tecnicismos como Huff / Gravitacional) ---
    h = reemplazar(h, "Simulador de Cierres (Huff)", "Simulador de Cierres y Migración Presencial")
    h = reemplazar(h, "label: 'Total Post-Cierre (Huff)',", "label: 'Total Post-Cierre con Migración',")
    h = reemplazar(h, "Total Post-Cierre (Huff)", "Total Post-Cierre con Migración")
    h = reemplazar(h, '<th class="py-1.5 text-right text-gold-700">+ Huff</th>', '<th class="py-1.5 text-right text-gold-700">+ Migración</th>')
    h = reemplazar(h, "label: '+ Captura Huff',", "label: '+ Migración Presencial',")
    h = reemplazar(h, "label: 'Nueva Demanda Total (Efecto Huff)',", "label: 'Nueva Demanda Total (con Migración Presencial)',")
    h = reemplazar(h, "y efecto gravitacional Huff", "y migración a otros locales presenciales")

    # Inyectar selector de mes en cada item de la lista de cierre del sidebar
    h = reemplazar(h,
                   '<span class="text-[10px] text-slate-400 font-mono font-medium">${salesStr}</span>\n          `;',
                   '<span class="text-[10px] text-slate-400 font-mono font-medium">${salesStr}</span>\n'
                   '            <select class="sel-mes-sidebar text-[10px] font-bold bg-white border border-amber-300 rounded px-1 py-0.2 text-amber-900 hidden ml-1" onclick="event.stopPropagation()" onchange="cambiarMesCierre(\x27${id}\x27, this.value)" title="Mes de cierre efectivo">\n'
                   '              ${opcionesMesSim().map((m) => `<option value="${m}">${nombreMesSim(m)}</option>`).join("")}\n'
                   '            </select>\n          `;')

    # Actualizar updateClosureUI para mostrar/ocultar el selector de mes en sidebar
    h = reemplazar(h,
                   "        if (cb && cb.checked) {\n          label.classList.add('is-closed');\n        } else {\n          label.classList.remove('is-closed');\n        }",
                   "        const selMes = label.querySelector('.sel-mes-sidebar');\n"
                   "        if (cb && cb.checked) {\n          label.classList.add('is-closed');\n          if (selMes) { selMes.classList.remove('hidden'); if (typeof getStoreClosureMonth === 'function') selMes.value = getStoreClosureMonth(cb.value); }\n        } else {\n          label.classList.remove('is-closed');\n          if (selMes) selMes.classList.add('hidden');\n        }")

    # Incorporar fraccion temporal en calculo de demanda anual del simulador base
    h = reemplazar(h,
                   "for (let y = 0; y < 5; y++) {\n            captureByYear[y] += closedAnnualBase[y] * portfolioProb;\n          }",
                   "for (let y = 0; y < 5; y++) {\n            const fracs = (typeof getClosureFractions === 'function') ? getClosureFractions(closedId, y) : { fracClosed: 1.0 };\n            captureByYear[y] += closedAnnualBase[y] * portfolioProb * fracs.fracClosed;\n          }")

    # --- Capa de datos, carga y pestanas nuevas ---
    h = reemplazar(h, "  </script>\n\n</body>",
                   "  </script>\n"
                   '  <script type="application/json" id="fuentes">__FUENTES__</script>\n'
                   '  <script type="text/plain" id="worker-src">__WORKER__</script>\n'
                   "  <script>\n" + (AQUI / "capa_datos.js").read_text(encoding="utf-8") + "\n  </script>\n</body>")

    # Sin emojis: la herramienta es de uso del cliente
    for viejo, nuevo in [("\U0001f504 Resetear Par\u00e1metros", "Restablecer par\u00e1metros"),
                         ("\U0001f50d Buscar sede", "Buscar sede"),
                         ("btn.textContent = `\u2713 ${k} Cerrado`;", "btn.textContent = `${k === 'RM' ? 'Resto RM' : (k === 'REGIONES' ? 'Regiones' : 'G9')} cerrado`;")]:
        h = reemplazar(h, viejo, nuevo)
    # Paleta de marca en todo el dashboard (Tailwind turf/gold/pizarra y colores fijos de los graficos):
    # azul de Hipodromo Chile como color principal; naranja de Teletrak para lo urgente; grises de Hipodromo Chile
    PALETA = {"#F0FDF4": "#E8EEF5", "#DCFCE7": "#D1DCE8", "#22C55E": "#3A6A96", "#15803D": "#003058", "#166534": "#002A4D",
              "#0F5132": "#002444", "#FFFBEB": "#FFF4ED", "#FEF3C7": "#FDE3D3", "#F59E0B": "#F7941D", "#D97706": "#F15A24",
              "#B45309": "#C2410C", "#78350F": "#7C2D12", "#1E293B": "#13294B", "#0F172A": "#0F1B2D", "#1E3A8A": "#003058",
              "#F8FAFC": "#F4F6F9"}
    h = re.sub("|".join(PALETA), lambda m: PALETA[m.group(0).upper()], h, flags=re.I)
    h = h.replace("rgba(34, 197, 94, 0.08)", "rgba(0, 48, 88, 0.08)").replace("rgba(21, 128, 61, 0.1)", "rgba(0, 48, 88, 0.1)")
    # Flujos de migracion: nombres de sede en vez de codigos y montos en pesos completos
    h = reemplazar(h, "topRecipient: topRecId ? `${topRecId} (${(topRecProb * 100).toFixed(0)}%)` : 'Ninguna'",
                   "topRecipient: topRecId ? `${nombreLindo(DASHBOARD_DATA.locales[topRecId]?.nombre || topRecId)} (${(topRecProb * 100).toFixed(0)}%)` : 'Ninguna'")
    h = reemplazar(h, """                ${f.closedId}
                <span class="block text-[10px] text-slate-400 font-normal truncate max-w-[110px]">${f.topRecipient ? 'Top: ' + f.topRecipient : ''}</span>""",
                   """                ${nombreLindo(f.closedNombre)}
                <span class="block text-[10px] text-slate-400 font-normal">${f.topRecipient ? 'Principal: ' + f.topRecipient : ''}</span>""")
    h = reemplazar(h, """<td class="py-1 font-bold text-pizarra-900" title="${f.closedNombre}">${f.closedId}</td>""",
                   """<td class="py-1 font-bold text-pizarra-900">${nombreLindo(f.closedNombre)}</td>""")
    h = reemplazar(h, "$${f.baseSales26.toFixed(0)}M</td>", "$${pesos(f.baseSales26)}</td>")
    h = reemplazar(h, "+$${f.annualClp.toFixed(1)}M</td>", "+$${pesos(f.annualClp)}</td>", n=2)
    h = reemplazar(h, "<th class=\"py-1 text-right\">Base '26</th>", "<th class=\"py-1 text-right\">Venta 12 meses</th>")
    h = h.replace("<th class=\"py-1 text-right text-gold-700\">Captura/año</th>", "<th class=\"py-1 text-right text-gold-700\">Venta recuperada al año</th>")
    # Horizonte: tantos anos como trae el analisis (antes eran 5 fijos)
    h = reemplazar(h, "for (let y = 0; y < 5; y++)", "for (let y = 0; y < DASHBOARD_DATA.anos_proy.length; y++)", n=4)
    h = reemplazar(h, "/ 5.0", "/ DASHBOARD_DATA.anos_proy.length", n=4)
    h = reemplazar(h, "let captureByYear = [0.0, 0.0, 0.0, 0.0, 0.0];", "let captureByYear = DASHBOARD_DATA.anos_proy.map(() => 0.0);")
    # Grafico de demanda: cada sede cerrada deja de vender desde su mes de cierre, no todas desde el inicio
    h = reemplazar(h, "        if (!isConsolidated && isEntityClosed) {",
                   "        if (!isConsolidated && isEntityClosed && getClosureFractions(state.currentEntity, y).fracOpen === 0) {")
    h = reemplazar(h, "          baseVal = openMemberIds.reduce((sum, id) => sum + DASHBOARD_DATA.locales[id].proy_anual_base.real_p50[y], 0);",
                   "          baseVal = memberIds.reduce((sum, id) => sum + DASHBOARD_DATA.locales[id].proy_anual_base.real_p50[y] * getClosureFractions(id, y).fracOpen, 0);")
    h = reemplazar(h, "          baseVal = loc.proy_anual_base.real_p50[y];",
                   "          baseVal = loc.proy_anual_base.real_p50[y] * getClosureFractions(state.currentEntity, y).fracOpen;")
    # Fila del simulador en dos lineas: nombre y venta arriba, mes de cierre abajo (solo si esta cerrada); el Id va al tooltip
    h = reemplazar(h, "label.className = 'closure-item flex items-center space-x-2 text-xs p-1.5 rounded-lg hover:bg-slate-50 cursor-pointer transition-all border border-transparent hover:border-slate-200';",
                   "label.className = 'closure-item flex items-start gap-2 text-xs px-2 py-1.5 rounded-lg hover:bg-slate-50 cursor-pointer transition-all border border-transparent hover:border-slate-200';")
    h = reemplazar(h, r'(?s)<input type="checkbox" value="\$\{id\}" onchange="onClosureToggle\(this\)"(.*?)</select>\n          `;',
                   lambda m: ('<input type="checkbox" value="${id}" onchange="onClosureToggle(this)" class="mt-0.5 rounded text-gold-600 focus:ring-gold-500 h-3.5 w-3.5 border-slate-300 shrink-0">\n'
                              '            <div class="flex-1 min-w-0" title="${loc.nombre} · ${id}">\n'
                              '              <div class="flex items-baseline justify-between gap-2">\n'
                              '                <span class="font-semibold text-slate-800 truncate">${nombreLindo(loc.nombre)}</span>\n'
                              '                <span class="text-[10px] text-slate-400 tabular-nums shrink-0">$${Math.round(loc.venta_base_2026_mm).toLocaleString("es-CL")} M/año</span>\n'
                              '              </div>\n'
                              '              <div class="fila-cierre hidden items-center gap-1.5 mt-1 text-[10px] text-amber-900">Cierra\n'
                              '                <select class="sel-mes-sidebar text-[10px] font-bold bg-white border border-amber-300 rounded px-1 py-0.5 text-amber-900" onclick="event.stopPropagation()" onchange="cambiarMesCierre(\'${id}\', this.value)">\n'
                              '                  ${opcionesMesSim().map((m) => `<option value="${m}">${nombreMesSim(m)}</option>`).join("")}\n'
                              '                </select><span class="txt-decidido hidden font-semibold"></span>\n'
                              '              </div>\n'
                              '            </div>\n          `;'), regex=True)
    h = reemplazar(h, 'class="space-y-1 max-h-[250px] overflow-y-auto pr-1 custom-scroll" id="closureCheckboxesContainer"',
                   'class="space-y-1 max-h-[420px] overflow-y-auto pr-1 custom-scroll" id="closureCheckboxesContainer"')
    resto = re.findall("[\U0001F300-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF\uFE0F]", h)
    assert not resto, f"quedan emojis: {sorted(set(resto))}"
    assert "TLK-" not in h.split("let DASHBOARD_DATA")[1].split("</script>")[0], "quedaron ids TLK fijos"
    return h


if __name__ == "__main__":
    origen = Path(sys.argv[1])
    out = AQUI / "app.html"
    out.write_text(extender(origen.read_text(encoding="utf-8")), encoding="utf-8")
    print(f"{out} generado desde {origen.name}")