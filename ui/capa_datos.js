"use strict";
// =====================================================================
// Capa de datos de la herramienta de sedes, sobre el dashboard de R. Malis.
// - Carga el Excel (SheetJS) y corre el nucleo Python en un Web Worker (Pyodide)
// - Arma DASHBOARD_DATA con el formato que espera el dashboard original
// - Pestanas nuevas: informe de carga, mapa, segmentos, sedes; estados y presentacion
// Usa el `state` del dashboard original (cierres, lambda, U0, entidad...).
// =====================================================================
const APP = { est: null, estados: [], tab: "carga", colorPor: "segmento", sedeSel: null, orden: { col: "venta_12m_real", asc: false },
  focal: new Set(), alcanceResultado: "CONSOLIDADO_RED", retencionDigital: 0.10, tasaDescuento: 0.105, factorCostoOnline: 0.15, takeoutDigital: 0.165, chartResultado: null, sedeCierreSel: null, modoCierreTemporal: "mensual", chartCierre: null, tasaDescuentoCierre: 0.105, retencionDigitalCierre: 0.10, pesosScore: { vol: 0.35, efic: 0.40, tend: 0.25 }, umbralesScore: { alto: 65, bajo: 45, matAlta: 223.79, matBaja: 114.78, rentaMin: 0.012, rentaMax: 0.08 }, filtroArquetipoActivo: null, filtroTextoPortafolio: "" };  // cartera focal (G9): se marca en la columna G9 de Sedes y contratos
const $ = (id) => document.getElementById(id);
const PALETA = ["#003058", "#496276", "#D99A00", "#1F2937", "#2C6BB6", "#C2410C", "#638299", "#A57075", "#9A7400", "#334155"];
const fmt = {
  mm: (v) => (v == null || isNaN(v) ? "-" : (v / 1e6).toLocaleString("es-CL", { maximumFractionDigits: 1 })),
  pct: (v, d = 0) => (v == null || isNaN(v) ? "-" : (v * 100).toLocaleString("es-CL", { maximumFractionDigits: d }) + "%"),
  num: (v, d = 1) => (v == null || isNaN(v) ? "-" : Number(v).toLocaleString("es-CL", { maximumFractionDigits: d })),
  fecha: (v) => (v ? String(v).slice(0, 10) : "-"),
  clp: (v) => (v == null || isNaN(v) ? "-" : "$" + Math.round(Number(v)).toLocaleString("es-CL")),
};
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const sum = (a) => a.reduce((x, y) => x + y, 0);

// =====================================================================
// Adaptador: resultado del nucleo Python -> DASHBOARD_DATA del dashboard original
// =====================================================================
function construirDashboardData(est) {
  const cfg = est.config || {};
  const ini = String(cfg.inicio_entrenamiento || "2021-06-01").slice(0, 7);
  const anos = [...new Set((est.demanda_anual || []).map((r) => r.ano))].sort((a, b) => a - b);
  const H = {};
  const mesesH = new Set();
  for (const r of est.historico || []) {
    const m = String(r.mes).slice(0, 7);
    if (m < ini) continue;
    (H[r.sede_id] = H[r.sede_id] || {})[m] = r;
    mesesH.add(m);
  }
  const meses_hist = [...mesesH].sort();
  const meses_proy = [...new Set((est.demanda_mensual || []).map((r) => String(r.mes).slice(0, 7)))]
    .filter((m) => anos.includes(+m.slice(0, 4))).sort();
  const anosHist = [...new Set(meses_hist.map((m) => +m.slice(0, 4)))].filter((y) => meses_hist.filter((m) => +m.slice(0, 4) === y).length === 12);
  const PA = {};
  for (const r of est.demanda_anual || []) (PA[r.sede_id] = PA[r.sede_id] || []).push(r);

  const locales = {};
  for (const s of est.sedes) {
    const pa = (PA[s.sede_id] || []).sort((a, b) => a.ano - b.ano);
    if (pa.length !== anos.length) continue; // sin proyeccion (sin historia suficiente)
    const h = H[s.sede_id] || {};
    const real = meses_hist.map((m) => (h[m]?.venta_real || 0) / 1e6);
    const nom = meses_hist.map((m) => (h[m]?.venta_nom ?? h[m]?.venta_real ?? 0) / 1e6);
    const ult = meses_hist.slice(-36);
    const pesos = Array.from({ length: 12 }, (_, i) => sum(ult.filter((m) => +m.slice(5, 7) === i + 1).map((m) => (h[m]?.venta_real || 0))));
    const totP = sum(pesos);
    const porAno = (serie) => anosHist.map((y) => sum(serie.filter((_, i) => +meses_hist[i].slice(0, 4) === y)));
    const g1 = s.crecimiento_anual_pct;
    // Proyeccion con la tendencia propia de la sede (acotada a -12% / +5% al año), igual que el VAN del plan
    const gS = Math.max(-0.12, Math.min(0.05, (g1 ?? 0) / 100));
    const p = (c) => pa.map((r, y) => ((r[c] || 0) / 1e6) * Math.pow(1 + gS, y));
    const grupo = s.grupo === "DIGITAL" ? "DIGITAL" : APP.focal.size ? (APP.focal.has(s.sede_id) ? "G9" : s.grupo === "G9" ? "RM" : s.grupo) : s.grupo;
    const hw_alpha = Number(Math.min(0.65, Math.max(0.18, 0.32 + (s.volatilidad || 0.1) * 0.4)).toFixed(2));
    const hw_beta = Number(Math.min(0.35, Math.max(0.05, 0.10 + Math.abs(g1 || 0) * 0.008)).toFixed(2));
    const hw_gamma = Number(Math.min(0.50, Math.max(0.15, 0.25)).toFixed(2));
    locales[s.sede_id] = {
      id: s.sede_id, nombre: s.nombre || s.sede_id, grupo, grupo_macro: grupo,
      venta_base_2026_mm: (s.venta_12m_real || 0) / 1e6,
      g1_organica_anual_pct: 0,   // la tendencia ya va en la proyeccion; el control g₁ queda como ajuste adicional
      hipodromo_shares: { HCH: s.mix_HCH || 0, CHS: s.mix_CHS || 0, VSC: s.mix_VSC || 0, CHC: s.mix_CHC || 0 },
      hw_base: { alpha: hw_alpha, beta: hw_beta, gamma: hw_gamma },
      month_weights: pesos.map((w) => (totP > 0 ? w / totP : 1 / 12)),
      hist_anual: { anos: anosHist, real_cruda: porAno(real), real_limpia: porAno(real), nominal: porAno(nom) },
      hist_mensual: { real_cruda: real, real_limpia: real, nominal: nom },
      proy_anual_base: { real_p50: p("p50_real"), nom_p50: p("p50_nominal"), real_p10: p("p10_real"), real_p90: p("p90_real"),
        total_5y_real: sum(p("p50_real")), total_5y_nom: sum(p("p50_nominal")) },
    };
  }
  const ids = Object.keys(locales);
  const porGrupo = (g) => ids.filter((i) => locales[i].grupo === g);
  const g9 = porGrupo("G9"), rm = porGrupo("RM"), reg = porGrupo("REGIONES"), dig = porGrupo("DIGITAL");
  const huff_ids = (est.red?.ids || []).filter((i) => locales[i]);

  // Consolidados: suma de series, crecimiento y pesos ponderados por venta (igual que generar_dashboard_demanda_huff.py)
  const consolidar = (cid, nombre, miembros) => {
    const L = miembros.map((i) => locales[i]);
    const w = L.map((l) => l.venta_base_2026_mm), tw = sum(w) || 1;
    const sumaV = (f) => (L.length ? L.map(f).reduce((a, b) => a.map((x, k) => x + b[k])) : []);
    const prom = (f) => sum(L.map((l, k) => f(l) * w[k])) / tw;
    locales[cid] = {
      id: cid, nombre, grupo: "CONSOLIDADO", grupo_macro: "CONSOLIDADO", venta_base_2026_mm: sum(w),
      g1_organica_anual_pct: L.length ? prom((l) => l.g1_organica_anual_pct) : 0,
      hipodromo_shares: Object.fromEntries(["HCH", "CHS", "VSC", "CHC"].map((x) => [x, L.length ? prom((l) => l.hipodromo_shares[x]) : 0])),
      hw_base: {
        alpha: Number((L.length ? prom((l) => l.hw_base.alpha) : 0.35).toFixed(2)),
        beta: Number((L.length ? prom((l) => l.hw_base.beta) : 0.12).toFixed(2)),
        gamma: Number((L.length ? prom((l) => l.hw_base.gamma) : 0.25).toFixed(2)),
      },
      month_weights: Array.from({ length: 12 }, (_, m) => (L.length ? prom((l) => l.month_weights[m]) : 1 / 12)),
      hist_anual: { anos: anosHist, real_cruda: sumaV((l) => l.hist_anual.real_cruda), real_limpia: sumaV((l) => l.hist_anual.real_limpia), nominal: sumaV((l) => l.hist_anual.nominal) },
      hist_mensual: { real_cruda: sumaV((l) => l.hist_mensual.real_cruda), real_limpia: sumaV((l) => l.hist_mensual.real_limpia), nominal: sumaV((l) => l.hist_mensual.nominal) },
      proy_anual_base: { real_p50: sumaV((l) => l.proy_anual_base.real_p50), nom_p50: sumaV((l) => l.proy_anual_base.nom_p50),
        // la suma de percentiles es una cota conservadora de la banda del total
        real_p10: sumaV((l) => l.proy_anual_base.real_p10), real_p90: sumaV((l) => l.proy_anual_base.real_p90),
        total_5y_real: sum(L.map((l) => l.proy_anual_base.total_5y_real)), total_5y_nom: sum(L.map((l) => l.proy_anual_base.total_5y_nom)) },
    };
  };
  consolidar("CONSOLIDADO_G9", "Cartera Focal G9", g9);
  consolidar("CONSOLIDADO_RED", "Red Nacional Vigente", ids);

  const km = {};
  (est.red?.ids || []).forEach((a, i) => { km[a] = {}; est.red.ids.forEach((b, j) => (km[a][b] = est.red.km[i][j])); });
  return { meses_hist, meses_proy, anos_proy: anos, matriz_distancias: km, locales, g9_ids: g9, rm_ids: rm, regiones_ids: reg,
    digital_ids: dig, red_ids: ids, huff_ids, tiene_limpia: false, atractivo: cfg.huff_atractivo || "relativo",
    mes_base: String(cfg.fecha_corte || "").slice(0, 7) };
}

// Atractivo A_j del modelo Huff (misma definicion que sedes/huff.py)
function atractivoHuff(id) {
  const D = DASHBOARD_DATA, v = D.locales[id].venta_base_2026_mm;
  if (D.atractivo === "mm_clp") return Math.max(1.0, v);
  if (D._mediaA == null) D._mediaA = sum(D.huff_ids.map((i) => D.locales[i].venta_base_2026_mm)) / (D.huff_ids.length || 1);
  return D._mediaA > 0 ? Math.max(1e-3, v / D._mediaA) : 1.0;
}

function etiquetasDeGrupo() {
  const D = DASHBOARD_DATA, n = (ids) => ids.filter((i) => D.huff_ids.includes(i)).length;
  $("optConsG9").textContent = `Cartera Focal G9 (${D.g9_ids.length} sedes)`;
  $("optConsG9").disabled = !D.g9_ids.length;
  $("optConsRed").textContent = `Red Nacional Vigente (${D.red_ids.length} sedes)`;
  $("optgroupG9").label = `── Grupo G9 (${D.g9_ids.length}) ──`;
  $("optgroupRM").label = `── Resto Región Metropolitana (${D.rm_ids.length}) ──`;
  $("optgroupReg").label = `── Regiones (${D.regiones_ids.length}) ──`;
  $("optgroupDig").label = `── Canales Digitales (${D.digital_ids.length}) ──`;
  $("tab_ALL").textContent = `Todas (${D.huff_ids.length})`;
  $("tab_G9").textContent = `G9 (${n(D.g9_ids)})`;
  $("tab_RM").textContent = `Resto RM (${n(D.rm_ids)})`;
  $("tab_REGIONES").textContent = `Regiones (${n(D.regiones_ids)})`;
  $("btnGrp_G9").hidden = !D.g9_ids.length;
}


// =====================================================================
// Gestion de Cierres y Mes de Cierre Efectivo
// =====================================================================
// Mes de cierre de la simulacion: 1 = enero del primer ano proyectado
function nombreMesSim(m) {
  const a0 = (DASHBOARD_DATA?.anos_proy || [2027])[0], x = Math.max(1, +m || 1) - 1;
  return nombreMes(`${a0 + Math.floor(x / 12)}-${String((x % 12) + 1).padStart(2, "0")}`);
}
// Opciones: cada mes del primer ano, luego enero y julio de cada ano del horizonte, mas el mes elegido si no esta
function opcionesMesSim(actual) {
  const n = (DASHBOARD_DATA?.anos_proy || []).length || 5, out = [];
  for (let m = 1; m <= 12 * n; m++) if (m <= 12 || (m - 1) % 6 === 0) out.push(m);
  if (actual && !out.includes(actual)) out.push(actual);
  return out.sort((a, b) => a - b);
}

function getStoreClosureMonth(id) {
  if (typeof state === 'undefined' || !state) return 1;
  if (!state.closureMonths) state.closureMonths = {};
  return state.closureMonths[id] || 1;
}

function cambiarMesCierre(id, mesVal) {
  if (typeof state === 'undefined' || !state) return;
  if (!state.closureMonths) state.closureMonths = {};
  const m = parseInt(mesVal, 10) || 1;
  state.closureMonths[id] = m;
  state.closedStores.add(id);
  const cb = document.querySelector(`#closureCheckboxesContainer input[value="${CSS.escape(id)}"]`);
  if (cb) cb.checked = true;
  if (typeof updateClosureUI === "function") updateClosureUI();
  if (typeof renderAll === "function") renderAll();
  if (typeof pintarResultado === "function") pintarResultado();
  if (typeof pintarListaLocalesResultado === "function") pintarListaLocalesResultado();
}

function aplicarMesCierreMasivo(mesVal) {
  if (typeof state === 'undefined' || !state) return;
  const m = parseInt(mesVal, 10) || 1;
  if (!state.closureMonths) state.closureMonths = {};
  state.closedStores.forEach(id => {
    state.closureMonths[id] = m;
  });
  if (typeof updateClosureUI === "function") updateClosureUI();
  if (typeof renderAll === "function") renderAll();
  if (typeof pintarResultado === "function") pintarResultado();
  if (typeof pintarListaLocalesResultado === "function") pintarListaLocalesResultado();
}

function cerrarSedeEnMesOptimo(sedeId, mesOptimo) {
  if (typeof state === 'undefined' || !state) return;
  cambiarMesCierre(sedeId, mesOptimo);
  irA("resultado");
  if (typeof pintarResultado === "function") pintarResultado();
}

window.getStoreClosureMonth = getStoreClosureMonth;
window.cambiarMesCierre = cambiarMesCierre;
window.aplicarMesCierreMasivo = aplicarMesCierreMasivo;
window.cerrarSedeEnMesOptimo = cerrarSedeEnMesOptimo;
window.getClosureFractions = getClosureFractions;

function getClosureFractions(id, y) {
  if (typeof state === 'undefined' || !state || !state.closedStores || !state.closedStores.has(id)) {
    return { fracOpen: 1.0, fracClosed: 0.0, isClosedThisYear: false, closesInThisYear: false };
  }
  const m = getStoreClosureMonth(id);
  const startMonth = y * 12 + 1;
  const endMonth = (y + 1) * 12;
  const closesInThisYear = (Math.floor((m - 1) / 12) === y);

  if (m <= startMonth) {
    return {
      fracOpen: 0.0,
      fracClosed: 1.0,
      isClosedThisYear: true,
      closesInThisYear: closesInThisYear
    };
  } else if (m > endMonth) {
    return {
      fracOpen: 1.0,
      fracClosed: 0.0,
      isClosedThisYear: false,
      closesInThisYear: false
    };
  } else {
    const monthsOpen = Math.max(0, m - startMonth);
    const monthsClosed = 12 - monthsOpen;
    return {
      fracOpen: monthsOpen / 12.0,
      fracClosed: monthsClosed / 12.0,
      isClosedThisYear: true,
      closesInThisYear: closesInThisYear
    };
  }
}
// Cierres decididos por la gerencia (ACCION "CIERRE 20XX" o carta de termino): son un hecho y no se reabren
function cierresDecididos() {
  return (APP.est?.sedes || []).filter((s) => s.cierre_decidido).map((s) => s.sede_id);
}
class CierresFijos extends Set {
  constructor(fijos, otros = []) { super(); this.fijos = new Set(fijos); [...fijos, ...otros].forEach((id) => this.add(id)); }
  delete(id) { return this.fijos.has(id) ? false : super.delete(id); }
  clear() { [...this].forEach((id) => this.delete(id)); }
}
// La lista del simulador muestra los decididos marcados y bloqueados
const _updateClosureUI = updateClosureUI;
updateClosureUI = function () {
  const fijos = state.closedStores.fijos || new Set();
  document.querySelectorAll("#closureCheckboxesContainer input").forEach((cb) => {
    cb.checked = state.closedStores.has(cb.value); cb.disabled = fijos.has(cb.value);
    if (fijos.has(cb.value)) cb.closest("label")?.setAttribute("title", "Cierre decidido por la gerencia: no se reabre");
  });
  _updateClosureUI();
  // Segunda linea de la fila: mes de cierre si esta cerrada; los decididos muestran la fecha, sin selector
  document.querySelectorAll("#closureCheckboxesContainer .closure-item").forEach((label) => {
    const cb = label.querySelector("input"), sel = label.querySelector(".sel-mes-sidebar"), fila = label.querySelector(".fila-cierre");
    if (fila) { fila.classList.toggle("hidden", !cb?.checked); fila.classList.toggle("flex", !!cb?.checked); }
    const fijo = !!cb && fijos.has(cb.value), txt = label.querySelector(".txt-decidido");
    if (sel) sel.classList.toggle("hidden", fijo);
    if (txt && cb) { txt.classList.toggle("hidden", !fijo); const k = fijo ? calendarioDe(cb.value) : null; txt.textContent = fijo ? `${k ? nombreMes(k.mes) : nombreMesSim(getStoreClosureMonth(cb.value))} · decidido` : ""; }
    if (!cb || !sel || !cb.checked) return;
    const m = getStoreClosureMonth(cb.value);
    if (![...sel.options].some((o) => +o.value === m)) {
      const o = new Option(nombreMesSim(m), m), sig = [...sel.options].find((x) => +x.value > m);
      sel.insertBefore(o, sig || null);
    }
    sel.value = String(m);
  });
  // El simulador vive en Detalle por sucursal: su efecto y la sede elegida se actualizan ahi mismo
  if ($("sim-efecto") && APP.est && DASHBOARD_DATA && !APP._enKpis) { APP._enKpis = true; try { kpisPlan(); } finally { APP._enKpis = false; } }
  if (APP.tab === "cierre" && typeof pintarCierreOptimo === "function") pintarCierreOptimo();
};

// Atajos del simulador
function marcarCerradas(ids) {
  ids.filter((id) => DASHBOARD_DATA.huff_ids.includes(id)).forEach((id) => {
    state.closedStores.add(id);
    const cb = document.querySelector(`#closureCheckboxesContainer input[value="${CSS.escape(id)}"]`);
    if (cb) cb.checked = true;
  });
  if (typeof updateClosureUI === "function") updateClosureUI(); if (typeof renderAll === "function") renderAll();
}
function cerrarDecididas() {
  marcarCerradas(APP.est.sedes.filter((s) => s.cierre_decidido).map((s) => s.sede_id));   // misma regla que el escenario base
}
function cerrarMenoresG9() {
  const L = DASHBOARD_DATA.locales;
  marcarCerradas([...DASHBOARD_DATA.g9_ids].sort((a, b) => L[a].venta_base_2026_mm - L[b].venta_base_2026_mm).slice(0, 3));
}
function cerrarSegunMCDA() {
  const data = (typeof calcularPortafolioMCDA === "function") ? calcularPortafolioMCDA() : null;
  if (!data || !data.locales) return;
  // Agrega los cierres propuestos del plan, cada uno en su fecha del calendario
  if (!state.closureMonths) state.closureMonths = {};
  for (const [id, k] of cerradasDelPlan("plan")) if (k.tipo === "propuesto") { state.closureMonths[id] = mesSimulacion(k.mes); state.closedStores.add(id); }
  if (typeof updateClosureUI === "function") updateClosureUI();
  renderAll(); pintarResultado();
}

// =====================================================================
// Almacen del navegador (IndexedDB): analisis, coordenadas y preferencias
// =====================================================================
const IDB = {
  db: null,
  // Nunca debe trabar el analisis: si el almacen no responde (otra pestana con una version
  // anterior lo tiene tomado, modo privado, etc.) se sigue sin cache.
  abrir() {
    if (this.prom) return this.prom;
    this.prom = new Promise((ok, mal) => {
      const r = indexedDB.open("sedes-teletrak", 2);
      r.onupgradeneeded = () => { for (const s of ["estados", "geo", "prefs"]) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
      r.onsuccess = () => { const db = r.result; db.onversionchange = () => { db.close(); IDB.prom = null; }; ok(db); };
      r.onerror = () => mal(r.error);
      r.onblocked = () => mal(new Error("otra pestaña de la herramienta tiene el almacén tomado"));
    });
    this.prom.catch(() => (this.prom = null));
    return this.prom;
  },
  async op(almacen, modo, fn) {
    if (this.caido) return null;
    const limite = new Promise((_, mal) => setTimeout(() => mal(new Error("el almacén del navegador no respondió")), 4000));
    try {
      return await Promise.race([limite, (async () => {
        const db = await this.abrir();
        return await new Promise((ok, mal) => { const t = db.transaction(almacen, modo); const r = fn(t.objectStore(almacen));
          t.oncomplete = () => ok(r && r.result); t.onerror = () => mal(t.error); });
      })()]);
    } catch (e) {
      this.caido = true;   // no reintentar en esta sesion: cada intento costaria 4 s
      console.warn("Sin caché del navegador en esta sesión:", e.message);
      return null;
    }
  },
  get: (k, a = "estados") => IDB.op(a, "readonly", (s) => s.get(k)),
  put: (k, v, a = "estados") => IDB.op(a, "readwrite", (s) => s.put(v, k)),
  del: (k, a = "estados") => IDB.op(a, "readwrite", (s) => s.delete(k)),
  claves: (a = "estados") => IDB.op(a, "readonly", (s) => s.getAllKeys()),
};
async function sha256(...partes) {
  const enc = new TextEncoder();
  const bufs = partes.map((p) => (p instanceof ArrayBuffer ? new Uint8Array(p) : enc.encode(p || "")));
  const tot = new Uint8Array(bufs.reduce((a, b) => a + b.length + 1, 0)); let o = 0;
  for (const b of bufs) { tot.set(b, o); o += b.length + 1; }
  const h = await crypto.subtle.digest("SHA-256", tot);
  return [...new Uint8Array(h)].slice(0, 12).map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function refrescarRecientes() {
  const claves = (await IDB.claves()) || [];
  const filas = [];
  for (const k of claves) { const e = await IDB.get(k); if (e) filas.push({ k, n: e.nombre || e.archivo || k, c: e.creado }); }
  filas.sort((a, b) => (b.c || "").localeCompare(a.c || ""));
  $("card-recientes").hidden = !filas.length;
  const cont = $("recientes");
  cont.innerHTML = filas.map((f, i) =>
    `<div class="flex items-center gap-3 py-2.5 ${i ? "border-t border-slate-100" : ""}">
       <div class="flex-1 min-w-0"><div class="text-sm font-semibold text-slate-800 truncate">${esc(f.n)}</div>
         <div class="text-[11px] text-slate-500">${esc((f.c || "").slice(0, 16).replace("T", " "))}</div></div>
       <button class="text-[11px] text-slate-500 hover:text-red-700 underline" data-borrar="${f.k}">Borrar</button>
       <button class="${i ? "btn-s" : "btn-p"}" data-abrir="${f.k}">Abrir</button></div>`).join("");
  cont.querySelectorAll("[data-abrir]").forEach((b) => (b.onclick = async () => abrirEstado(await IDB.get(b.dataset.abrir))));
  cont.querySelectorAll("[data-borrar]").forEach((b) => (b.onclick = async () => { await IDB.del(b.dataset.borrar); refrescarRecientes(); }));
}

// =====================================================================
// Python en Web Worker (pedidos con respuesta)
// =====================================================================
let worker = null, pyListo = null, pedido = null;
function avance(txt, frac) {
  APP.msg = txt;
  $("prog-txt").textContent = APP.t0 ? `${txt} · ${Math.round((Date.now() - APP.t0) / 1000)} s` : txt;
  if (frac != null) { $("prog").hidden = false; $("prog").firstElementChild.style.width = Math.round(100 * frac) + "%"; }
}
function iniciarPython() {
  if (worker) return pyListo;
  worker = new Worker(URL.createObjectURL(new Blob([$("worker-src").textContent], { type: "text/javascript" })));
  let listo;
  pyListo = new Promise((ok) => (listo = ok));
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.tipo === "estado") { if (APP.ocupado) avance(m.texto, null); }
    else if (m.tipo === "listo") listo();
    else if (m.tipo === "progreso") avance(`Proyectando demanda: sede ${m.i + 1} de ${m.n}`, 0.55 + 0.45 * ((m.i + 1) / m.n));
    else if (pedido) { const p = pedido; pedido = null; m.tipo === "error" ? p.mal(m) : p.ok(m); }
  };
  worker.onerror = (e) => {
    const err = { texto: "El proceso de cálculo se detuvo (" + (e.message || "posible falta de memoria del navegador") + "). Cierra otras pestañas y vuelve a intentar.", detalle: String(e.message || e) };
    worker = null; pyListo = null;
    if (pedido) { const p = pedido; pedido = null; p.mal(err); }
  };
  worker.postMessage({ tipo: "iniciar", fuentes: JSON.parse($("fuentes").textContent) });
  return pyListo;
}
let colaPy = Promise.resolve();   // un pedido a la vez: el worker responde en orden
function pedirPython(msg) {
  const p = colaPy.then(async () => {
    await iniciarPython();
    return new Promise((ok, mal) => { pedido = { ok, mal }; worker.postMessage(msg); });
  });
  colaPy = p.catch(() => {});
  return p;
}

// =====================================================================
// Ubicacion de sedes: direcciones -> coordenadas (OpenStreetMap), con cache en el navegador
// Solo se envia la direccion. Nominatim pide maximo 1 consulta por segundo.
// =====================================================================
const NOMINATIM = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=cl&q=";
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
async function buscarDireccion(q) {
  const r = await fetch(NOMINATIM + encodeURIComponent(q), { headers: { "Accept-Language": "es" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  return j[0] ? { lat: +j[0].lat, lon: +j[0].lon, tipo: j[0].addresstype || j[0].type || "" } : null;
}
async function ubicarSedes(dirs) {
  const filas = [];
  let consultas = 0, i = 0, falloRed = false;
  $("btn-saltar").classList.remove("hidden");
  for (const d of dirs) {
    i++;
    if (APP.saltarMapa) break;
    const dir = String(d.direccion || "").trim();
    const clave = norm(dir + "|" + (d.zona || ""));
    let g = await IDB.get(clave, "geo");
    if (!g && !falloRed && !APP.saltarMapa) {
      const porNombre = d.tipo === "nombre";   // sedes sin direccion (p. ej. cerradas): se busca el nombre del local
      const intentos = [[`${dir}, Chile`, porNombre ? "POR NOMBRE" : null]];
      if (/^SANTIAGO/i.test(d.zona || "")) intentos.push([`${dir}, Santiago, Chile`, porNombre ? "POR NOMBRE" : null]);
      if (!porNombre && dir.includes(",")) intentos.push([`${dir.split(",").pop().trim()}, Chile`, "CENTRO DE COMUNA"]);
      if (!porNombre && /^SANTIAGO/i.test(d.zona || "")) intentos.push(["Santiago, Chile", "CENTRO DE SANTIAGO"]);
      for (const [q, calidadFija] of intentos) {
        const quedan = Math.round((dirs.length - i) * 1.3);
        avance(`Ubicando sedes en el mapa: ${i} de ${dirs.length} (quedan ~${quedan > 90 ? Math.round(quedan / 60) + " min" : quedan + " s"})`, 0.1 + 0.45 * (i / dirs.length));
        try { await esperar(consultas++ ? 1100 : 0); const r = await buscarDireccion(q); if (r) {
          g = { lat: r.lat, lon: r.lon, calidad: calidadFija || (/house|building|amenity|shop|commercial|retail/.test(r.tipo) ? "EXACTA" : /road|street|residential|pedestrian/.test(r.tipo) ? "CALLE" : "APROXIMADA") };
          break; } }
        catch (e) { falloRed = true; console.warn("Geocodificacion no disponible", e); break; }
      }
      if (g) await IDB.put(clave, g, "geo");
    }
    if (g) filas.push(`${d.sede_id},${g.lat},${g.lon},${g.calidad}`);
  }
  $("btn-saltar").classList.add("hidden");
  return { csv: "sede_id,lat,lon,calidad\n" + filas.join("\n"), sinRed: falloRed || APP.saltarMapa };
}
const norm = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();

// =====================================================================
// Analisis: Excel -> direcciones -> coordenadas -> Python
// =====================================================================
const PARAMS_FIJOS = { n_simulaciones: 1000 };   // el resto usa los valores por defecto del nucleo
const VERSION_ANALISIS = "2026-11-tendencia-12m";        // subir cuando el análisis en Python agrega o cambia resultados
async function analizar() {
  $("error").textContent = ""; $("btn-analizar").disabled = true; APP.ocupado = true; APP.saltarMapa = false;
  APP.t0 = Date.now();
  const reloj = setInterval(() => APP.msg && avance(APP.msg, null), 1000);
  try {
    const fx = $("f-excel").files[0], buf = await fx.arrayBuffer();
    avance("Leyendo Excel", 0.03);
    await esperar(30);
    const libroTxt = JSON.stringify(leerExcel(buf));
    console.info(`Excel: ${(buf.byteLength / 1e6).toFixed(1)} MB, ${APP.celdas.toLocaleString("es-CL")} celdas con datos, ${(libroTxt.length / 1e6).toFixed(1)} MB para Python`);
    avance(`Excel leído (${(APP.celdas / 1e6).toFixed(2)} M celdas). Cargando Python en el navegador, solo la primera vez`, 0.06);
    const dirs = JSON.parse((await pedirPython({ tipo: "direcciones", libro: libroTxt })).json);
    const { csv, sinRed } = await ubicarSedes(dirs);
    const equiv = (await IDB.get("equivalencias", "prefs")) || {};
    const clave = await sha256(buf, csv, JSON.stringify(equiv), JSON.stringify(PARAMS_FIJOS), VERSION_ANALISIS);
    let est = await IDB.get(clave);
    if (!est) {
      avance("Cruzando hojas y proyectando demanda", 0.55);
      const r = await pedirPython({ tipo: "analizar", libro: libroTxt, coordenadas: csv, equivalencias: JSON.stringify(equiv), params: PARAMS_FIJOS });
      est = JSON.parse(r.json);
      est.archivo = fx.name; est.nombre = fx.name; est.hojas_omitidas = APP.hojasOmitidas;
      await asegurarTiempos(est, (txt) => avance(txt, 0.97)).catch((e) => console.warn(e));
      delete est._osrmIntentado; delete est._accesoIntentado;
      await IDB.put(clave, est); refrescarRecientes();
    }
    avance(APP.saltarMapa ? "Listo, sin mapa (las sedes no ubicadas se pueden completar analizando de nuevo)" : sinRed ? "Listo. Sin conexión a OpenStreetMap: algunas sedes quedaron sin ubicar" : "Listo", 1);
    APP.ultimoArchivo = fx;
    abrirEstado(est);
  } catch (m) {
    $("error").innerHTML = esc(m.texto || m.message || m) + (m.detalle ? `<details class="mt-1"><summary class="cursor-pointer text-slate-500">Detalle técnico</summary><pre class="whitespace-pre-wrap text-[11px] text-slate-500">${esc(m.detalle)}</pre></details>` : "");
  } finally {
    clearInterval(reloj); APP.t0 = null; $("btn-saltar").classList.add("hidden");
    $("btn-analizar").disabled = !$("f-excel").files.length; APP.ocupado = false; setTimeout(() => ($("prog").hidden = true), 800);
  }
}
function leerExcel(buf) {
  const wb = XLSX.read(buf, { type: "array", cellDates: true });
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  // Recorta celdas vacias: hojas con formato estirado a miles de columnas o filas vacias se vuelven enormes
  // Solo pasan a Python las hojas con un encabezado reconocible (mismas claves que sedes/rentabilidad.py):
  // hojas de apoyo, tablas crudas o graficos no se procesan.
  const CLAVES = new Set(["ID_DIVISION", "LOCAL", "STATUS", "DIVISION", "AGENCIA", "SEDE_ID", "MES", "PARAMETRO", "ORIGEN"]);
  const n0 = (v) => String(v).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim();
  const libro = {};
  let celdas = 0;
  APP.hojasOmitidas = [];
  for (const n of wb.SheetNames) {
    const ws = wb.Sheets[n];
    const cab = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false, sheetRows: 15 });
    const nombres = /^(SEDES|VENTAS_MENSUALES|IPC|DISTANCIAS|PARAMETROS)$/i.test(n);
    if (!nombres && !cab.some((f) => f.some((v) => v != null && CLAVES.has(n0(v))))) {
      APP.hojasOmitidas.push(n); console.info(`Hoja "${n}": no reconocida, no se procesa`); continue;
    }
    const filas = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false })
      .map((f) => { const g = f.map((v) => (v instanceof Date ? iso(v) : v === "" ? null : v)); while (g.length && g[g.length - 1] == null) g.pop(); return g; })
      .filter((f) => f.length);
    libro[n] = filas;
    const c = filas.reduce((a, f) => a + f.length, 0);
    celdas += c;
    console.info(`Hoja "${n}": ${filas.length} filas, hasta ${Math.max(0, ...filas.map((f) => f.length))} columnas, ${c.toLocaleString("es-CL")} celdas`);
  }
  APP.celdas = celdas;
  return libro;
}

// =====================================================================
// Estados: abrir, guardar, alternar, presentar
// =====================================================================
function vistaActual() {
  return { tab: APP.tab, colorPor: APP.colorPor, sedeSel: APP.sedeSel, focal: [...APP.focal], umbralMargen: APP.umbralMargen, radios: APP.radios, acceso: APP.acceso, verMetro: APP.verMetro, verFuturas: APP.verFuturas, hipOff: [...(APP.hipOff || [])], zona: APP.zona, vistaRed: APP.vistaRed, mesLinea: APP.mesLinea, zonaMapa: APP.zonaMapa, cerradas: [...state.closedStores], entidad: state.currentEntity,
    hipodromo: state.currentHipodromo, moneda: state.currencyMode, tiempo: state.timeMode, lambda: state.lambda, u0: state.u0,
    g1: state.g1_override, kappa: state.shrinkage, phi: state.phi, shock: state.levelShockPct, inflacion: state.inflationRate, mejora: APP.mejora, finanzas: APP.finanzas, migracion: APP.migracion };
}
function aplicarVista(v, cfg) {
  const fija = (id, val) => { const el = $(id); if (el && val != null) el.value = val; };
  // Los cierres decididos por la gerencia siempre estan cerrados; los demas son el escenario guardado
  const enHuff = (id) => DASHBOARD_DATA.huff_ids.includes(id);
  state.closedStores = new CierresFijos(cierresDecididos().filter(enHuff), (v.cerradas || []).filter(enHuff));
  APP.mejora = { ...MEJORA_DEF, ...(v.mejora || {}) };
  APP.finanzas = { ...FINANZAS_DEF, ...(v.finanzas || {}) };
  APP.migracion = v.migracion || "modelo";
  APP.umbralMargen = v.umbralMargen ?? null; APP.radios = v.radios || null; APP.acceso = v.acceso || null; APP.verMetro = v.verMetro ?? true; APP.verFuturas = v.verFuturas ?? true; APP.hipOff = new Set(v.hipOff || []); APP.zona = v.zona || null;
  let ent = v.entidad || "CONSOLIDADO_G9";
  if (!DASHBOARD_DATA.locales[ent] || (ent === "CONSOLIDADO_G9" && !DASHBOARD_DATA.g9_ids.length)) ent = "CONSOLIDADO_RED";
  state.currentEntity = ent;
  state.lambda = v.lambda ?? cfg.huff_lambda ?? 4.0;
  state.u0 = v.u0 ?? cfg.huff_u0 ?? 0.1736;
  state.shrinkage = v.kappa != null ? v.kappa : 0.50;
  state.phi = v.phi ?? 0.94;
  state.levelShockPct = v.shock != null ? v.shock : 0.0;
  state.inflationRate = v.inflacion != null ? v.inflacion : (typeof cfg.inflacion_futura === "number" ? cfg.inflacion_futura : 0.03);

  fija("sliderLambda", state.lambda); fija("sliderU0", state.u0);
  fija("sliderShrinkage", state.shrinkage * 100); fija("sliderPhi", state.phi);
  fija("sliderShock", state.levelShockPct * 100);
  fija("sliderInfl", state.inflationRate * 100);
  if (v.g1 != null) fija("sliderG1", v.g1);
  if ($("sliderLambda")) state.lambda = +$("sliderLambda").value;
  if ($("sliderU0")) state.u0 = +$("sliderU0").value;
  if ($("valLambda")) $("valLambda").textContent = state.lambda.toFixed(1);
  if ($("valU0")) $("valU0").textContent = state.u0.toFixed(4);
  APP.colorPor = ["rol", "categoria", "accion"].includes(v.colorPor) ? v.colorPor : "rol"; APP.vistaRed = "tiempo"; APP.mesLinea = v.mesLinea || null; APP.zonaMapa = v.zonaMapa || null; APP.sedeSel = v.sedeSel || null;   // la pestana Red muestra solo la linea de tiempo
}
// Huff con tiempos reales: la "distancia" de Huff pasa a ser el tiempo de viaje del modo de la zona (calles, metro o tren)
// por la velocidad típica de la zona. Así λ (calibrado en km) mantiene su escala y el reparto sigue la accesibilidad real.
function actualizarDistanciaHuff() {
  const est = APP.est, D = DASHBOARD_DATA;
  if (!est?.tiempos || !D || !est.red?.ids?.length) return;
  prepararCategorias();
  const red = est.red, C = matrizCosto(), zs = red.ids.map((id) => zonaDe(APP._porId[id] || {})), vel = {};
  for (const z of new Set(zs)) {
    if (accesoZona(z).modo === "km") continue;
    const r = [];
    red.ids.forEach((_, i) => red.ids.forEach((__, j) => { if (i !== j && zs[i] === z && zs[j] === z && C[i][j] > 1 && C[i][j] < 9999 && red.km[i][j] > 0) r.push(red.km[i][j] / C[i][j]); }));
    vel[z] = mediana(r);
  }
  red.ids.forEach((a, i) => red.ids.forEach((b, j) => {
    const v = vel[zs[i]];
    D.matriz_distancias[a][b] = i !== j && zs[i] === zs[j] && v && C[i][j] < 9999 ? Math.round(C[i][j] * v * 100) / 100 : red.km[i][j];
  }));
  D.huff_por_tiempo = Object.keys(vel).length > 0;
  // Con distancias nuevas, el escenario conservador recalcula su U0 para seguir reteniendo 30% en promedio
  if (APP.migracion === "conservadora") aplicarMigracion("conservadora", false);
}
function abrirEstado(est, agregar = true) {
  if (!est || !est.sedes) { if ($("error")) $("error").textContent = "El archivo no es un estado válido"; return; }
  if (agregar) APP.estados.push(est);
  APP.est = est; APP._mapaAjustado = null; APP._escenarioInicial = false; APP.grafo = null; APP.grafoClave = null; APP._grafoPedido = null; APP._costo = null;
  const v = est.vista || {}, cfg = est.config || {};
  if (v.focal) APP.focal = new Set(v.focal);
  DASHBOARD_DATA = construirDashboardData(est);
  aplicarVista(v, cfg);
  // Titulo con la ventana del plan: desde el corte de los datos hasta el ultimo ano proyectado
  const tit = `Plan de sedes Teletrak ${historia().corte.slice(0, 4)}-${finPlan().slice(0, 4)}`;
  document.querySelector(".franja h1").textContent = tit; document.title = tit;
  actualizarDistanciaHuff();
  // Sliders de demanda -> state (g1 vacio = el g1 historico de la entidad)
  if (v.g1 == null && $("sliderG1")) $("sliderG1").value = DASHBOARD_DATA.locales[state.currentEntity].g1_organica_anual_pct;
  onDynamicParamChange();
  state.g1_override = v.g1 ?? null;
  setCurrency(v.moneda || "REAL"); setTimeMode(v.tiempo || "MONTHLY");
  if (typeof setSeriesMode === "function") setSeriesMode("CLEAN");
  if ($("btnLimpia")) {
    $("btnLimpia").disabled = !DASHBOARD_DATA.tiene_limpia;
    $("btnLimpia").title = DASHBOARD_DATA.tiene_limpia ? "" : "Serie limpia (aislamiento de picos) pendiente de portar al núcleo";
  }
  setHipodromo(v.hipodromo || "ALL");
  iniciarDashboard();
  document.querySelectorAll("#nav .nav-tab").forEach((b) => (b.disabled = false));
  if ($("btn-guardar")) $("btn-guardar").disabled = false;
  if ($("btn-presentar")) $("btn-presentar").disabled = false;
  const sel = $("sel-estado");
  if (sel) {
    sel.hidden = APP.estados.length < 2;
    sel.innerHTML = APP.estados.map((e, i) => `<option value="${i}">${esc(e.nombre || "Estado " + (i + 1))}</option>`).join("");
    sel.value = APP.estados.indexOf(est);
  }
  const D = DASHBOARD_DATA;
  if ($("btnReal")) $("btnReal").textContent = `Real (${D.mes_base})`;
  if ($("kpiProyLabel")) $("kpiProyLabel").textContent = `Proyección Base ${D.anos_proy[0]}–${String(D.anos_proy.at(-1)).slice(2)}`;
  pintarInforme(); pintarSedes();
  if ($("tab-carga")) $("tab-carga").hidden = true;
  document.querySelector(".barra-nav")?.classList.remove("hidden");
  $("btn-volver-analisis")?.classList.remove("hidden");
  irA(v.tab && v.tab !== "carga" ? v.tab : "red");
  completarTiemposEnFondo();
}
// Guarda el análisis con la vista actual en este navegador: aparece en "Retomar análisis"
async function guardarEstado() {
  const nombre = prompt("Nombre", APP.est.nombre || "análisis");
  if (nombre === null) return;
  const est = { ...APP.est, nombre, vista: vistaActual(), creado: new Date().toISOString().slice(0, 19) };
  await IDB.put("guardado:" + est.creado, est); refrescarRecientes();
}
function presentar(on) {
  document.body.classList.toggle("presentacion", on);
  $("btn-presentar").textContent = on ? "Salir de presentación" : "Presentar";
}

// =====================================================================
// Navegacion
// =====================================================================
const TABS = ["red", "segmentos", "demanda", "cierre", "simulacion", "sensibilidad", "flexibilidad"];
function irA(tab) {
  if (tab === "resultado") tab = "demanda";
  if (tab === "sedes") tab = "cierre";
  if (tab === "informe") { window.abrirModalAjustes(); return; }
  if (tab === "carga") { window.mostrarPantallaCarga(); return; }

  APP.tab = tab;
  document.querySelectorAll("#nav .nav-tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  document.querySelectorAll("section.tab").forEach((s) => (s.hidden = s.id !== "tab-" + tab));
  if ($("togglesDemanda")) $("togglesDemanda").classList.toggle("hidden", tab !== "demanda" && tab !== "resultado" && tab !== "cierre");
  if (tab === "demanda" || tab === "cierre") {
    ordenarPestanaDemanda();
    if (!APP._escenarioInicial) { APP._escenarioInicial = true; aplicarEscenarioDemanda("plan", false); }
  }
  if (tab === "demanda") {
    renderAll();
    pintarResultado();
  }
  if (tab === "red") setTimeout(pintarRed, 30);
  if (tab === "segmentos") pintarSegmentos();
  if (tab === "cierre") {
    sincronizarSupuestos();
    pintarCierreOptimo();
    pintarSedes();
  }
  if (tab === "sensibilidad") pintarSensibilidadTab();
  if (tab === "flexibilidad") pintarFlexibilidad();
  if (tab === "simulacion") {
    pintarSimulacion();
  }
}
window.alCambiarSimulador = () => {
  if (APP.tab === "red") pintarRed();
  if (APP.tab === "demanda" || APP.tab === "resultado") pintarResultado();
  if (APP.tab === "cierre") {
    pintarCierreOptimo();
    pintarSedes();
  }
  if (APP.tab === "simulacion") {
    pintarSimulacion();
  }
};

window.abrirModalAjustes = function() {
  if ($("modal-ajustes")) {
    $("modal-ajustes").hidden = false;
    $("modal-ajustes").classList.remove("hidden");
    if (APP.est) pintarInforme();
  }
};
window.cerrarModalAjustes = function() {
  if ($("modal-ajustes")) {
    $("modal-ajustes").hidden = true;
    $("modal-ajustes").classList.add("hidden");
  }
};

// =====================================================================
// Modal Ajustes Avanzados Holt-Winters
// =====================================================================
window.abrirModalAjustesHW = function() {
  if (!state.hwConfig) {
    state.hwConfig = { modo: 'auto', alphaOverride: null, betaOverride: null, gammaOverride: null, trendActive: true };
  }
  const loc = DASHBOARD_DATA?.locales?.[state.currentEntity];
  const hw = loc?.hw_base || { alpha: 0.35, beta: 0.12, gamma: 0.25 };

  if ($("hwModalSedeNombre")) {
    $("hwModalSedeNombre").textContent = loc ? `${loc.nombre} (${loc.id})` : (state.currentEntity || "Sede");
  }

  if ($("refHwAlpha")) $("refHwAlpha").textContent = `Base sede: ${hw.alpha.toFixed(2)}`;
  if ($("refHwBeta")) $("refHwBeta").textContent = `Base sede: ${hw.beta.toFixed(2)}`;
  if ($("refHwGamma")) $("refHwGamma").textContent = `Base sede: ${hw.gamma.toFixed(2)}`;

  const isManual = state.hwConfig.modo === 'manual';
  const alphaVal = isManual && state.hwConfig.alphaOverride != null ? state.hwConfig.alphaOverride : hw.alpha;
  const trendActive = !isManual || state.hwConfig.trendActive !== false;
  const betaVal = !trendActive ? 0.0 : (isManual && state.hwConfig.betaOverride != null ? state.hwConfig.betaOverride : hw.beta);
  const gammaVal = isManual && state.hwConfig.gammaOverride != null ? state.hwConfig.gammaOverride : hw.gamma;

  if ($("sliderHwAlpha")) $("sliderHwAlpha").value = alphaVal;
  if ($("numHwAlpha")) $("numHwAlpha").value = Number(alphaVal).toFixed(2);
  if ($("valHwAlpha")) $("valHwAlpha").textContent = Number(alphaVal).toFixed(2);

  if ($("selHwTrendMode")) $("selHwTrendMode").value = trendActive ? "active" : "none";

  if ($("sliderHwBeta")) $("sliderHwBeta").value = betaVal;
  if ($("numHwBeta")) $("numHwBeta").value = Number(betaVal).toFixed(2);
  if ($("valHwBeta")) $("valHwBeta").textContent = Number(betaVal).toFixed(2);

  if ($("sliderHwGamma")) $("sliderHwGamma").value = gammaVal;
  if ($("numHwGamma")) $("numHwGamma").value = Number(gammaVal).toFixed(2);
  if ($("valHwGamma")) $("valHwGamma").textContent = Number(gammaVal).toFixed(2);

  const lam = state.lambda != null ? state.lambda : 4.0;
  if ($("sliderHwLambda")) $("sliderHwLambda").value = lam;
  if ($("valHwLambda")) $("valHwLambda").textContent = Number(lam).toFixed(1);

  const u0 = state.u0 != null ? state.u0 : 0.1736;
  const elU0 = $("sliderHwU0");
  if (elU0) {
    elU0.value = u0;
    if ($("valHwU0")) $("valHwU0").textContent = Number(u0).toFixed(4);
  }

  window.setModoHW(state.hwConfig.modo || 'auto');

  const modal = $("modal-ajustes-hw");
  if (modal) {
    modal.hidden = false;
    modal.classList.remove("hidden");
  }
};

window.cerrarModalAjustesHW = function() {
  const modal = $("modal-ajustes-hw");
  if (modal) {
    modal.hidden = true;
    modal.classList.add("hidden");
  }
};

window.setModoHW = function(modo) {
  if (!state.hwConfig) {
    state.hwConfig = { modo: 'auto', alphaOverride: null, betaOverride: null, gammaOverride: null, trendActive: true };
  }
  state.hwConfig.modo = modo;
  const isAuto = modo === 'auto';
  const btnAuto = $("btnHwModoAuto");
  const btnManual = $("btnHwModoManual");
  if (btnAuto) {
    btnAuto.className = isAuto
      ? "px-3 py-1 rounded-md transition-all active-pill"
      : "px-3 py-1 rounded-md transition-all text-slate-600 hover:text-slate-900";
  }
  if (btnManual) {
    btnManual.className = !isAuto
      ? "px-3 py-1 rounded-md transition-all active-pill"
      : "px-3 py-1 rounded-md transition-all text-slate-600 hover:text-slate-900";
  }

  const inputs = ["sliderHwAlpha", "numHwAlpha", "selHwTrendMode", "sliderHwBeta", "numHwBeta", "sliderHwGamma", "numHwGamma"];
  inputs.forEach(id => {
    const el = $(id);
    if (el) {
      el.disabled = isAuto;
      el.classList.toggle("opacity-50", isAuto);
      el.classList.toggle("cursor-not-allowed", isAuto);
    }
  });

  if (isAuto) {
    const loc = DASHBOARD_DATA?.locales?.[state.currentEntity];
    const hw = loc?.hw_base || { alpha: 0.35, beta: 0.12, gamma: 0.25 };
    if ($("sliderHwAlpha")) $("sliderHwAlpha").value = hw.alpha;
    if ($("numHwAlpha")) $("numHwAlpha").value = hw.alpha.toFixed(2);
    if ($("valHwAlpha")) $("valHwAlpha").textContent = hw.alpha.toFixed(2);

    if ($("selHwTrendMode")) $("selHwTrendMode").value = "active";
    if ($("sliderHwBeta")) $("sliderHwBeta").value = hw.beta;
    if ($("numHwBeta")) $("numHwBeta").value = hw.beta.toFixed(2);
    if ($("valHwBeta")) $("valHwBeta").textContent = hw.beta.toFixed(2);

    if ($("sliderHwGamma")) $("sliderHwGamma").value = hw.gamma;
    if ($("numHwGamma")) $("numHwGamma").value = hw.gamma.toFixed(2);
    if ($("valHwGamma")) $("valHwGamma").textContent = hw.gamma.toFixed(2);
  }
};

window.onHwModalInput = function(campo, valor) {
  if (campo === 'alpha') {
    const num = Math.min(1.0, Math.max(0.01, parseFloat(valor) || 0));
    if ($("sliderHwAlpha")) $("sliderHwAlpha").value = num;
    if ($("numHwAlpha")) $("numHwAlpha").value = num.toFixed(2);
    if ($("valHwAlpha")) $("valHwAlpha").textContent = num.toFixed(2);
    window.setModoHW('manual');
  } else if (campo === 'trendMode') {
    const isNone = (valor === 'none' || valor === 'ninguna');
    if ($("selHwTrendMode")) $("selHwTrendMode").value = isNone ? 'none' : 'active';
    if ($("sliderHwBeta")) {
      $("sliderHwBeta").disabled = isNone;
      if (isNone) $("sliderHwBeta").value = 0;
    }
    if ($("numHwBeta")) {
      $("numHwBeta").disabled = isNone;
      if (isNone) $("numHwBeta").value = "0.00";
    }
    if ($("valHwBeta")) {
      $("valHwBeta").textContent = isNone ? "0.00" : Number($("sliderHwBeta")?.value || 0.12).toFixed(2);
    }
    window.setModoHW('manual');
  } else if (campo === 'beta') {
    const num = Math.min(1.0, Math.max(0.0, parseFloat(valor) || 0));
    if ($("sliderHwBeta")) $("sliderHwBeta").value = num;
    if ($("numHwBeta")) $("numHwBeta").value = num.toFixed(2);
    if ($("valHwBeta")) $("valHwBeta").textContent = num.toFixed(2);
    if (num > 0 && $("selHwTrendMode") && $("selHwTrendMode").value === 'none') {
      $("selHwTrendMode").value = 'active';
    }
    window.setModoHW('manual');
  } else if (campo === 'gamma') {
    const num = Math.min(1.0, Math.max(0.0, parseFloat(valor) || 0));
    if ($("sliderHwGamma")) $("sliderHwGamma").value = num;
    if ($("numHwGamma")) $("numHwGamma").value = num.toFixed(2);
    if ($("valHwGamma")) $("valHwGamma").textContent = num.toFixed(2);
    window.setModoHW('manual');
  } else if (campo === 'lambda') {
    const num = Math.min(10.0, Math.max(0.5, parseFloat(valor) || 4.0));
    if ($("sliderHwLambda")) $("sliderHwLambda").value = num;
    if ($("valHwLambda")) $("valHwLambda").textContent = num.toFixed(1);
  } else if (campo === 'u0') {
    const raw = parseFloat(valor);
    const val = isNaN(raw) ? 0.1736 : raw;
    if ($("sliderHwU0")) $("sliderHwU0").value = val;
    if ($("valHwU0")) $("valHwU0").textContent = val.toFixed(4);
  }
};

window.restaurarCalibracionOptimaHW = function() {
  state.hwConfig = { modo: 'auto', alphaOverride: null, betaOverride: null, gammaOverride: null, trendActive: true };
  state.lambda = 4.0;
  state.u0 = 0.1736;
  state.g1_override = null;
  const loc = DASHBOARD_DATA?.locales?.[state.currentEntity];
  if (loc && $("sliderG1")) $("sliderG1").value = loc.g1_organica_anual_pct;
  if (typeof onDynamicParamChange === "function") onDynamicParamChange();
  window.abrirModalAjustesHW();
  if (typeof renderAll === "function") renderAll();
  if (typeof pintarResultado === "function") pintarResultado();
};

window.aplicarAjustesHW = function() {
  const isAuto = $("btnHwModoAuto")?.classList.contains("active-pill") || false;
  const modo = isAuto ? 'auto' : 'manual';

  const loc = DASHBOARD_DATA?.locales?.[state.currentEntity];
  const hw = loc?.hw_base || { alpha: 0.35, beta: 0.12, gamma: 0.25 };

  let alpha = parseFloat($("sliderHwAlpha")?.value ?? $("numHwAlpha")?.value ?? hw.alpha);
  let beta = parseFloat($("sliderHwBeta")?.value ?? $("numHwBeta")?.value ?? hw.beta);
  let gamma = parseFloat($("sliderHwGamma")?.value ?? $("numHwGamma")?.value ?? hw.gamma);
  const trendMode = $("selHwTrendMode")?.value || "active";
  const trendActive = (trendMode !== "none" && trendMode !== "ninguna");

  if (isNaN(alpha)) alpha = hw.alpha;
  if (isNaN(beta)) beta = hw.beta;
  if (isNaN(gamma)) gamma = hw.gamma;

  if ($("sliderHwLambda")) {
    state.lambda = parseFloat($("sliderHwLambda").value) || 4.0;
  }
  if ($("sliderHwU0")) {
    const rawU0 = parseFloat($("sliderHwU0").value);
    state.u0 = isNaN(rawU0) ? 0.1736 : rawU0;
  }

  if (modo === 'auto') {
    state.hwConfig = {
      modo: 'auto',
      alphaOverride: null,
      betaOverride: null,
      gammaOverride: null,
      trendActive: true
    };
    state.g1_override = null;
    if (loc && $("sliderG1")) $("sliderG1").value = loc.g1_organica_anual_pct;
    if (typeof onDynamicParamChange === "function") onDynamicParamChange();
  } else {
    state.hwConfig = {
      modo: 'manual',
      alphaOverride: Number(alpha.toFixed(2)),
      betaOverride: Number(beta.toFixed(2)),
      gammaOverride: Number(gamma.toFixed(2)),
      trendActive: trendActive
    };

    if (loc) {
      const ajuste = window.obtenerAjusteHW(loc);
      if (!trendActive || ajuste.trendFactor === 0) {
        state.g1_override = 0.0;
      } else {
        state.g1_override = Number((loc.g1_organica_anual_pct * ajuste.trendFactor).toFixed(2));
      }
      if ($("sliderG1")) $("sliderG1").value = state.g1_override;
      if (typeof onDynamicParamChange === "function") onDynamicParamChange();
    }
  }

  window.cerrarModalAjustesHW();
  if (typeof renderAll === "function") renderAll();
  if (typeof pintarResultado === "function") pintarResultado();
};

window.ajustarProyeccionHW = function(ctx) {
  if (!ctx || !ctx.hwConfig || ctx.hwConfig.modo !== 'manual') return null;
  const loc = ctx.loc;
  const aj = window.obtenerAjusteHW(loc);
  if (ctx.stage === 'renderAll') {
    return {
      eff_g1_monthly: ctx.eff_g1_monthly,
      g1_active: ctx.g1_active
    };
  }
  if (ctx.stage === 'monthlyWeights' && aj.monthWeights && ctx.month >= 1 && ctx.month <= 12) {
    return { weight: aj.monthWeights[ctx.month - 1] };
  }
  return null;
};

window.obtenerAjusteHW = function(loc) {
  if (!loc) {
    return { levelFactor: 1.0, trendFactor: 1.0, monthWeights: Array.from({ length: 12 }, () => 1 / 12) };
  }
  if (!state.hwConfig || state.hwConfig.modo === 'auto') {
    return {
      levelFactor: 1.0,
      trendFactor: 1.0,
      monthWeights: loc.month_weights ? [...loc.month_weights] : Array.from({ length: 12 }, () => 1 / 12)
    };
  }

  const base = loc.hw_base || { alpha: 0.35, beta: 0.12, gamma: 0.25 };
  const alpha = state.hwConfig.alphaOverride != null ? Number(state.hwConfig.alphaOverride) : base.alpha;
  const trendActive = state.hwConfig.trendActive !== false;
  const beta = !trendActive ? 0.0 : (state.hwConfig.betaOverride != null ? Number(state.hwConfig.betaOverride) : base.beta);
  const gamma = state.hwConfig.gammaOverride != null ? Number(state.hwConfig.gammaOverride) : base.gamma;

  // Factor de tendencia
  let trendFactor = 0.0;
  if (trendActive && beta > 0) {
    const baseBeta = Math.max(0.05, base.beta);
    trendFactor = Math.min(2.0, Math.max(0.0, 0.5 + 0.5 * (beta / baseBeta)));
  }

  // Factor de nivel: pondera entre el ultimo mes anualizado y el promedio de 12 meses segun (alpha - base.alpha)
  let levelFactor = 1.0;
  const ultMeses = loc.hist_mensual?.real_limpia || loc.hist_mensual?.real_cruda || [];
  if (ultMeses.length >= 1) {
    const ult12 = ultMeses.slice(-12);
    const prom12 = ult12.length ? sum(ult12) / ult12.length : 0;
    const ultM = ultMeses[ultMeses.length - 1];
    if (prom12 > 0) {
      const diffAlpha = alpha - base.alpha;
      const ratio = (ultM / prom12) - 1.0;
      levelFactor = Math.min(1.20, Math.max(0.80, 1.0 + diffAlpha * 0.5 * ratio));
    }
  }

  // Modulacion de pesos mensuales segun gamma manteniendo suma igual a 1.0
  const origMw = loc.month_weights || Array.from({ length: 12 }, () => 1 / 12);
  const baseGamma = Math.max(0.05, base.gamma);
  const gammaRatio = Math.max(0.0, gamma / baseGamma);
  const rawMod = origMw.map(w => Math.max(0.001, (1 / 12) + (w - (1 / 12)) * gammaRatio));
  const totMod = sum(rawMod) || 1.0;
  const monthWeights = rawMod.map(w => w / totMod);

  return { levelFactor, trendFactor, monthWeights };
};
window.mostrarPantallaCarga = function() {
  window.cerrarModalAjustes();
  document.querySelectorAll("section.tab").forEach(s => s.hidden = true);
  if ($("tab-carga")) $("tab-carga").hidden = false;
};
window.volverAlAnalisis = function() {
  if (APP.est) irA(APP.tab && APP.tab !== "carga" ? APP.tab : "red");
};
// Huff solo reparte la venta de sedes cerradas: si no hay ninguna, decirlo en vez de mostrar un 0 mudo
window.despuesDeRender = () => {
  const D = DASHBOARD_DATA;
  if (!D.huff_ids.length) {
    $("kpiPctCaptura").textContent = "Sin sedes ubicadas en el mapa: Huff no puede calcular";
    $("closureCheckboxesContainer").innerHTML = `<p class="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3">
      Ninguna sede física quedó ubicada (las direcciones no se encontraron o no hubo conexión a OpenStreetMap). Sin ubicación no hay distancias y Huff no puede repartir demanda. Revisa el informe de carga y vuelve a analizar.</p>`;
  } else if (!state.closedStores.size) {
    $("kpiPctCaptura").textContent = "Marca sedes a cerrar en el simulador";
    $("kpiFugaVol").textContent = "Sin cierres en el escenario";
  }
};

// =====================================================================
// Tablas
// =====================================================================
// Etapa de cierre como etiqueta de color (misma paleta del mapa y la categorización)
function chipCat(c) {
  if (!c) return "";
  const col = COLOR_CAT[c] || "#667085";
  return `<span class="chip" style="background:${col}14;color:${col};border-color:${col}40">${esc(c.charAt(0) + c.slice(1).toLowerCase())}</span>`;
}
function tabla(filas, cols, opts = {}) {
  if (filas && cols.some((c) => c.k === "nombre")) filas = filas.map((f) => (f.nombre ? f : { ...f, nombre: f.sede_id ? `(sin nombre) ${f.sede_id}` : f.nombre }));
  if (!filas || !filas.length) return `<p class="text-xs text-slate-400">Sin filas</p>`;
  const th = cols.map((c) => `<th data-col="${c.k}">${esc(c.t)}</th>`).join("");
  const tr = filas.map((f) => `<tr ${opts.clic ? `class="click" data-id="${esc(f[opts.clic])}"` : ""}>` +
    cols.map((c) => `<td class="${c.n ? "n" : c.w ? "w" : ""}">${c.f ? c.f(f[c.k], f) : esc(f[c.k] ?? "")}</td>`).join("") + "</tr>").join("");
  return `<div class="tbl" style="max-height:${opts.alto || 480}px"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
}
function descargarCSV(filas, cols, nombre) {
  const lin = [cols.map((c) => c.t).join(";")].concat(filas.map((f) => cols.map((c) => (f[c.k] == null ? "" : String(f[c.k]).replace(/;/g, ","))).join(";")));
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + lin.join("\n")], { type: "text/csv" })); a.download = nombre; a.click();
}

// =====================================================================
// Informe de carga
// =====================================================================
function opcionesSedes(sel) {
  return [...APP.est.sedes].sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)))
    .map((s) => `<option value="${esc(s.sede_id)}" ${s.sede_id === sel ? "selected" : ""}>${esc(s.nombre)} · ${esc(s.sede_id)}</option>`).join("");
}
// Avisos de la carga en dos grupos: lo que afecta el análisis (con dónde resolverlo) y lo que se corrigió solo
function avisosCarga(inf) {
  const n = (m) => +((m || "").match(/^\d+/) || [0])[0];
  const sinUbic = APP.est.sedes.filter((s) => s.grupo !== "DIGITAL" && (s.lat == null || s.lon == null)).map((s) => nombreLindo(s.nombre));
  const REVISAR = {
    COORDENADAS: (p) => [`${n(p.mensaje)} sedes sin ubicación`, "quedan fuera del mapa y de la red" + (sinUbic.length ? `: ${sinUbic.slice(0, 8).join(", ")}${sinUbic.length > 8 ? "…" : ""}` : ""), "inf-ubic"],
    NOMBRES: (p) => [`${n(p.mensaje)} nombres sin cruzar`, "elige a qué sede corresponden", "inf-nombres"],
    COSTOS: (p) => [`${n(p.mensaje)} sedes sin arriendo`, "sin margen proyectado", null],
    CUADRE: (p) => [`${n(p.mensaje)} diferencias de venta entre hojas`, "sobre la tolerancia", "inf-cuadre"],
    DISPONIBLES: (p) => [`${n(p.mensaje)} códigos DISPONIBLE con ventas recientes`, "podrían ser sedes operando", "inf-disponibles"],
  };
  const todos = (inf.problemas || []).concat((APP.est.hojas_omitidas || []).map((h) => ({ nivel: "AVISO", hoja: h, mensaje: "hoja no reconocida, no se procesó" })));
  const revisar = [], auto = [];
  for (const p of todos) {
    if (REVISAR[p.hoja]) revisar.push(REVISAR[p.hoja](p));
    else if (p.nivel === "ERROR") revisar.push([p.hoja, p.mensaje, null]);
    else auto.push(p);
  }
  if (!revisar.length && !auto.length) return "";
  const fila = ([tit, txt, ancla]) => `<li class="py-1.5 border-t border-slate-100 first:border-0"><b class="text-slate-800">${esc(tit)}</b>
    <span class="text-slate-600">· ${esc(txt)}</span>${ancla ? ` <a href="#" class="underline text-[#2E3192]" data-ir-a="${ancla}">ver</a>` : ""}</li>`;
  return (revisar.length ? `<h3>Para revisar</h3><ul class="text-[13px]">${revisar.map(fila).join("")}</ul>` : "")
    + (auto.length ? `<details class="mt-3 text-xs text-slate-500"><summary class="cursor-pointer">Ajustes automáticos (${auto.length})</summary>
      <ul class="mt-1 space-y-0.5">${auto.map((p) => `<li>${esc(p.hoja)}: ${esc(p.mensaje)}</li>`).join("")}</ul></details>` : "");
}
function pintarInforme() {
  const inf = APP.est.informe || {}, r = inf.resumen || {};
  // Resumen en cuatro cifras legibles (lo que falta va en "Para revisar")
  const mesTxt = (d) => (d ? nombreMes(String(d).slice(0, 7)) : "-");
  const [vDesde, vHasta] = String(r["ventas diarias"] || "").split(" a ");
  const kpis = [[r.vigentes, "sedes vigentes"], [r["vigentes fisicas con coordenadas"], "en el mapa"],
    [mesTxt(r["mes de corte"]), "mes de corte"], [vDesde ? `${mesTxt(vDesde)} a ${mesTxt(vHasta)}` : "-", "ventas"]]
    .map(([v, l], k) => `<div class="kpi-mini"><div class="v ${k > 2 ? "!text-xl" : ""}">${esc(v ?? "-")}</div><div class="l">${l}</div></div>`).join("");
  const probs = avisosCarga(inf);
  const alerta = (a) => `<span class="chip ${/VENCIDO/.test(a) ? "err" : /PROXIMO|DISTINTAS/.test(a) ? "warn" : "info"}">${esc(a)}</span>`;
  if (!$("tab-informe")) return;
  $("tab-informe").innerHTML = `
  <div class="space-y-5">
    <div class="card"><h2>Resumen de la carga</h2><div class="grid grid-cols-2 md:grid-cols-4 gap-3">${kpis}</div>
      ${probs}</div>
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-5">
      <div class="card"><h2>Hojas reconocidas</h2>${tabla(inf.hojas, [{ k: "hoja", t: "Hoja" }, { k: "tipo", t: "Tipo" }, { k: "ano", t: "Año" }, { k: "filas", t: "Filas", n: 1 }])}
        <h3 id="inf-cuadre">Cuadre de ventas entre hojas</h3>
        ${tabla(inf.cuadre_resumen, [{ k: "comparacion", t: "Comparación" }, { k: "n", t: "N", n: 1 },
          { k: "cuadran", t: "Cuadran", n: 1, f: (v, f) => `${v} <span class="chip ${v === f.n ? "ok" : "warn"}">${fmt.pct(v / f.n)}</span>` }], { alto: 300 })}
        ${(inf.cuadre_fallas || []).length ? "<h3>Diferencias fuera de tolerancia</h3>" + tabla(inf.cuadre_fallas, [{ k: "comparacion", t: "Comparación" }, { k: "sede_id", t: "Sede" }, { k: "periodo", t: "Periodo" }, { k: "dif_pct", t: "Dif.", n: 1, f: (v) => fmt.pct(v, 1) }], { alto: 260 }) : ""}
      </div>
      <div class="card"><h2>Columnas clave encontradas</h2>
        <p class="text-xs text-slate-500 mb-2">Qué columnas necesarias encontró la herramienta en cada hoja y en qué % de filas tienen dato. Si falta una, revisar el nombre del encabezado.</p>
        ${tabla(inf.columnas, [{ k: "hoja", t: "Hoja" }, { k: "campo", t: "Campo" },
          { k: "encontrada", t: "Estado", f: (v, f) => v ? `<span class="chip ${f.filas_con_dato >= 0.5 ? "ok" : "warn"}">${fmt.pct(f.filas_con_dato)} con dato</span>` : `<span class="chip err">no encontrada</span>` },
          { k: "columna", t: "Columna" }], { alto: 380 })}
      </div>
      <div class="card"><h2>Identidades contables</h2>
        <p class="text-xs text-slate-500 mb-2">Qué fórmulas se cumplen en el Excel, fila por fila.</p>
        ${tabla(inf.identidades, [{ k: "hoja", t: "Hoja" }, { k: "regla", t: "Regla", w: 1 }, { k: "filas", t: "Filas", n: 1 },
          { k: "resultado", t: "Resultado", f: (v, f) => (f.cumplen == null ? esc(v) : `<span class="chip ${v === "100%" ? "ok" : "warn"}">${esc(v)}</span>`) }], { alto: 440 })}
      </div>
      <div class="card" id="inf-nombres"><h2>Nombres de EN PROCESO y CTA ARRIENDO</h2>
        <p class="text-xs text-slate-500 mb-2">Esas hojas identifican la sede por nombre. Los nombres iguales o casi iguales se cruzan solos. Si alguno no calzó, elige la sede y reanaliza: la elección queda guardada en este navegador.</p>
        ${(inf.pendientes || []).length ? `<div class="tbl"><table><thead><tr><th>Hoja</th><th>Nombre en la hoja</th><th>Es la sede</th></tr></thead><tbody>` +
          inf.pendientes.map((p, i) => `<tr><td>${esc(p.hoja)}</td><td>${esc(p.nombre)}</td><td><select class="border border-slate-300 rounded px-1 py-0.5 text-xs" data-pend="${i}">
            <option value="">(no está en la red, ignorar)</option>${opcionesSedes(p.sugerencia_id)}</select></td></tr>`).join("") +
          `</tbody></table></div><button class="btn-p mt-3 solo-edicion" id="btn-pend">Guardar y reanalizar</button>`
          : `<p class="text-xs"><span class="chip ok">OK</span> Todos los nombres se cruzaron.</p>`}
        ${(inf.automaticas || []).length ? "<h3>Cruzados por parecido (revisar)</h3>" + tabla(inf.automaticas, [{ k: "nombre", t: "Nombre en la hoja" }, { k: "asignado_a", t: "Asignado a" }, { k: "similitud", t: "Parecido", n: 1, f: (v) => fmt.pct(v) }], { alto: 220 }) : ""}
        <h3 id="inf-ubic">Ubicación de las sedes (OpenStreetMap)</h3>
        ${tabla(inf.ubicacion, [{ k: "calidad", t: "Precisión" }, { k: "sedes", t: "Sedes", n: 1 }])}
        <p class="text-[11px] text-slate-400 mt-1">EXACTA y CALLE: dirección encontrada. POR NOMBRE: sede sin dirección en el Excel, ubicada por el nombre del local. CENTRO DE COMUNA o DE SANTIAGO: aproximada, revisar en el mapa.</p>
      </div>
      ${(inf.disponibles || []).length ? `<div class="card lg:col-span-2" id="inf-disponibles"><h2>Códigos sin sede (no se analizan)</h2>
        ${tabla(inf.disponibles, [{ k: "sede_id", t: "Id" }, { k: "motivo", t: "Motivo" }, { k: "nombre_en_ventas", t: "Nombre en VTA HIST" }, { k: "zona", t: "Zona" },
          { k: "primer_mes_venta", t: "Primera venta", f: (v) => (v ? nombreMes(mes7(v)) : "-") },
          { k: "ultimo_mes_venta", t: "Última venta", f: (v) => (v ? nombreMes(mes7(v)) : "Nunca") },
          { k: "venta_12m_nominal", t: "Venta 12m $M", n: 1, f: (v) => (v ? fmt.mm(v) : "-") },
          { k: "arriendo_mensual", t: "Arriendo mensual $M", n: 1, f: (v) => (v == null ? "-" : fmt.mm(v)) },
          { k: "gestion", t: "Gestión" }, { k: "accion", t: "Acción" }, { k: "vencimiento", t: "Vence", f: fmt.fecha }, { k: "hojas", t: "Aparece en" }], { alto: 380 })}</div>` : ""}
      <div class="card"><h2>Contratos y plazos</h2>
        ${tabla(inf.contratos, [{ k: "alerta", t: "Alerta", f: alerta }, { k: "nombre", t: "Sede" }, { k: "accion", t: "Acción" }, { k: "status", t: "Status" },
          { k: "vencimiento", t: "Vence", f: fmt.fecha }, { k: "limite_aviso", t: "Límite aviso", f: fmt.fecha }, { k: "fechas_por_fuente", t: "Fechas por hoja" }], { alto: 400 })}
      </div>
    </div>
  </div>`;
  if ($("tab-informe")) {
    $("tab-informe").querySelectorAll("[data-ir-a]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); $(a.dataset.irA)?.scrollIntoView({ behavior: "smooth", block: "start" }); }));
  }
  const bp = $("btn-pend");
  if (bp) bp.onclick = async () => {
    const eq = (await IDB.get("equivalencias", "prefs")) || {};
    document.querySelectorAll("[data-pend]").forEach((sel) => { const p = inf.pendientes[+sel.dataset.pend]; if (sel.value) eq[p.nombre] = sel.value; });
    await IDB.put("equivalencias", eq, "prefs");
    if (!$("f-excel") || !$("f-excel").files.length) {
      alert("Elección guardada. Vuelve a cargar el Excel en Carga de datos para aplicarla.");
      window.mostrarPantallaCarga();
      return;
    }
    window.mostrarPantallaCarga();
    analizar();
  };
}

// =====================================================================
// Red de sedes: grafo de alternativas (networkx en Python) sobre el mapa
// Muestra la red de hoy y la red con los cierres decididos (hechos), no el escenario del simulador
// =====================================================================
// Rol descriptivo: dice que cierres necesitan migracion digital y en que orden conviene hacerlos; no protege sedes
const ROLES = {
  "SIN RESPALDO": { color: "#9D174D", nombre: "Sin alternativa", txt: "Ninguna otra sede cerca: al cerrarla, sus clientes deben pasar al canal digital." },
  "CRITICA":      { color: "#2E3192", nombre: "Alternativa de otras", txt: "Es la única alternativa de otra sede o une su red local: conviene cerrarla después de las que dependen de ella." },
  "REDUNDANTE":   { color: "#7FCFA1", nombre: "Con alternativa", txt: "Sus clientes tienen otra sede cerca y su cierre no deja a otras sin alternativa." },
};
const NOMBRE_ZONA = { "SANTIAGO URBANO": "Santiago urbano", "ALREDEDORES RM": "Alrededores RM", "REGIONES": "Regiones" };
const cerradasRed = () => { const ids = new Set(APP.est.red.ids); return cierresDecididos().filter((id) => ids.has(id)); };
const claveGrafo = () => JSON.stringify([cerradasRed().sort(), Object.keys(ACCESO_DEF).map(accesoZona), APP.est.tiempos?.fuente || null, hipActivos().map((h) => h.id)]);

// Grafo en Python (networkx): se guarda en el estado con su clave; si el escenario o el acceso cambian, se recalcula (milisegundos, una vez cargado)
function actualizarGrafo() {
  const k = claveGrafo();
  if (APP.grafoClave === k || APP._grafoPedido === k) return;
  const g0 = APP.est.grafo;
  if (g0 && g0.clave === k) { APP.grafo = g0; APP.grafoClave = k; return; }
  APP._grafoPedido = k;
  $("red-nota").textContent = worker ? "Recalculando la red…" : "Preparando el cálculo de red (solo la primera vez, unos segundos)…";
  pedirPython({ tipo: "grafo", entrada: JSON.stringify(entradaRed()) }).then((r) => {
    if (APP._grafoPedido !== k) return;
    APP.grafo = JSON.parse(r.json); APP.grafo.clave = k; APP.est.grafo = APP.grafo; APP.grafoClave = k; APP._grafoPedido = null;
    $("red-nota").textContent = "";
    if (APP.tab === "red") pintarRed();
  }).catch((e) => { APP._grafoPedido = null; $("red-nota").textContent = "No se pudo recalcular la red: " + (e.texto || e.message || e); });
}
// Sedes + hipodromos (fijos): la matriz de costo se extiende con el acceso de cada hipodromo a las sedes de su zona
function entradaRed(metroM = null) {
  const red = APP.est.red, porId = APP._porId;
  const H = hipActivos(), C = matrizCosto(metroM);
  const km = C.map((fila, i) => [...fila, ...H.map((h) => costoHip(h, i))]);
  H.forEach((h, k) => km.push([...red.ids.map((_, j) => costoHip(h, j)), ...H.map((_, m) => (m === k ? 0 : 9999))]));
  return { ids: [...red.ids, ...H.map((h) => h.id)], km, radios: Object.fromEntries(Object.keys(ACCESO_DEF).map((z) => [z, umbralZona(z)])),
    cerradas: cerradasRed(), fijos: H.map((h) => h.id),
    zonas: Object.fromEntries([...red.ids.map((id) => [id, porId[id] ? zonaDe(porId[id]) : "REGIONES"]), ...H.map((h) => [h.id, h.zona])]),
    venta: Object.fromEntries(red.ids.map((id) => [id, porId[id]?.venta_12m_real || 0])) };
}
function rolDe(id) {
  const G = APP.grafo || APP.est.grafo; if (!G) return null;   // mientras se recalcula, la ultima red conocida
  return (APP.vistaRed === "escenario" ? G.escenario : G.hoy)[id] || null;
}

// Lineas de metro (datos publicos embebidos con el nucleo Python)
const COLOR_METRO = { "1": "#E1251B", "2": "#FFB300", "3": "#8D5524", "4": "#0033A0", "4A": "#2AA9E0", "5": "#00953A", "6": "#9B2C98", "7": "#94A3B8", "8": "#0E7490", "9": "#BE185D", "Melipilla": "#475569", "Batuco": "#475569",
  "Nos": "#B45309", "Rancagua": "#334155", "San Fernando": "#334155", "Chillán": "#57534E", "Biotren L1": "#0E7490", "Biotren L2": "#15803D", "Laja": "#57534E" };
const TRENES = new Set(["Nos", "Rancagua", "San Fernando", "Chillán", "Biotren L1", "Biotren L2", "Laja", "Melipilla", "Batuco"]);   // EFE: se dibujan punteados
const nombreLinea = (l) => (/^Biotren/.test(l) ? l.replace(" L", " Línea ") : l === "Laja" ? "Corto Laja" : TRENES.has(l) ? `Tren ${l}` : `Línea ${l}`);
// Estaciones por posicion (lat,lon con 5 decimales) -> nombre y lineas, para los tooltips del area alcanzable
let _estPos = null;
function estacionPorPos() {
  if (_estPos) return _estPos;
  _estPos = {};
  const todas = Object.entries(lineasMetro()).flatMap(([l, est]) => est.map((e) => ({ ...e, l })));
  for (const e of todas) {
    // lineas de la misma estacion (mismo nombre a menos de 1,5 km: las de combinacion tienen andenes separados)
    const lineas = [...new Set(todas.filter((o) => o.estacion === e.estacion && kmEntre([o.lat, o.lon], [e.lat, e.lon]) < 1.5).map((o) => o.l))];
    _estPos[`${e.lat.toFixed(5)},${e.lon.toFixed(5)}`] = { nombre: e.estacion, lineas };
  }
  return _estPos;
}
// Los cuatro hipodromos del pais: punto fijo de referencia en el mapa (datos publicos)
let _hipo = null;
function hipodromos() {
  if (_hipo) return _hipo;
  const csv = JSON.parse($("fuentes").textContent)["sedes/datos_publicos/hipodromos.csv"] || "";
  return (_hipo = csv.trim().split("\n").slice(1).map((f) => { const [codigo, nombre, ciudad, lat, lon] = f.split(","); return { codigo, nombre, ciudad, lat: +lat, lon: +lon }; }));
}
let _metro = null;
// Líneas en obras o proyectadas (lineas_futuras.csv): estaciones con su apertura estimada, estado y fuente
let _futuras = null;
function lineasFuturas() {
  if (_futuras) return _futuras;
  const F = JSON.parse($("fuentes").textContent);
  const filas = (F["sedes/datos_publicos/lineas_futuras.csv"] || "").trim().split("\n").slice(1).filter(Boolean);
  _futuras = {};
  for (const fila of filas) {
    const c = fila.match(/("[^"]*"|[^,]+)/g).map((x) => x.replace(/^"|"$/g, ""));
    const [linea, orden, estacion, lat, lon, apertura, estado, fuente] = c;
    (_futuras[linea] = _futuras[linea] || []).push({ orden: +orden, estacion, lat: +lat, lon: +lon, apertura, estado, fuente });
  }
  for (const l of Object.values(_futuras)) l.sort((a, b) => a.orden - b.orden);
  return _futuras;
}
// Tiempos en metro o tren con la red de una fecha (las líneas nuevas abiertas a esa fecha); sin dato: la red de hoy
function metroEn(fecha) {
  let m = null;
  for (const f of APP.est.tiempos?.futuras || []) if (f.fecha <= fecha) m = f.metro;
  return m;
}
function lineasMetro() {
  if (_metro) return _metro;
  const F = JSON.parse($("fuentes").textContent);
  const csv = ["metro_santiago.csv", "trenes_efe.csv"].map((f) => (F["sedes/datos_publicos/" + f] || "").trim().split("\n").slice(1)).flat().filter(Boolean);
  _metro = {};
  for (const fila of csv) {
    const [linea, orden, estacion, lat, lon] = fila.split(",");
    (_metro[linea] = _metro[linea] || []).push({ orden: +orden, estacion, lat: +lat, lon: +lon });
  }
  for (const l of Object.values(_metro)) l.sort((a, b) => a.orden - b.orden);
  return _metro;
}

// Tiempos de viaje: metro en Python; a pie y en auto por las calles de OpenStreetMap (OSRM).
// Solo se envian coordenadas de las sedes, nunca ventas ni margenes. Se guardan en cache del navegador.
const OSRM = { auto: "https://routing.openstreetmap.de/routed-car/table/v1/driving/", pie: "https://routing.openstreetmap.de/routed-foot/table/v1/driving/" };
const VERSION_TIEMPOS = 6;   // igual a transporte.VERSION: si difiere, se recalcula metro y trenes
const CONGESTION = 1.25, ESTACIONAR_MIN = 3;   // OSRM da tiempos sin trafico
function notaTiempos() {
  const f = APP.est?.tiempos?.fuente;
  if (!f) return "Sin tiempos de viaje: se usa la distancia por calle.";
  return /OSRM/.test(f.auto) ? "Tiempos: OpenStreetMap, Metro y EFE." : "Tiempos estimados por distancia, Metro y EFE.";
}
async function asegurarTiempos(est, aviso = (txt) => ($("red-nota").textContent = txt)) {
  const porId = Object.fromEntries(est.sedes.map((s) => [s.sede_id, s])), red = est.red;
  if (!red?.ids?.length) return false;
  if (!est.tiempos || est.tiempos.version !== VERSION_TIEMPOS) {
    aviso("Calculando tiempos en metro (solo la primera vez para este estado)…");
    const previo = est.tiempos;
    const r = await pedirPython({ tipo: "tiempos", entrada: JSON.stringify({ ids: red.ids, km: red.km, factor_ruta: est.config?.factor_ruta || 1.3,
      lat: red.ids.map((id) => porId[id].lat), lon: red.ids.map((id) => porId[id].lon), zonas: red.ids.map((id) => zonaDe(porId[id])) }) });
    est.tiempos = JSON.parse(r.json);
    if (previo && /OSRM/.test(previo.fuente.auto))
      Object.assign(est.tiempos, { pie_est: est.tiempos.pie, auto: previo.auto, pie: previo.pie, fuente: { ...previo.fuente, metro: est.tiempos.fuente.metro, acceso: est.tiempos.fuente.acceso } });
  }
  if (/OSRM/.test(est.tiempos.fuente.auto) && !/OSRM/.test(est.tiempos.fuente.acceso || "") && !est._accesoIntentado) {
    await accesoPorCalles(est, aviso).catch((e) => console.warn("Caminata a estaciones por calles no disponible", e));
    return true;
  }
  if (/OSRM/.test(est.tiempos.fuente.auto) || est._osrmIntentado) return true;
  est._osrmIntentado = true;
  const T = est.tiempos, zs = red.ids.map((id) => zonaDe(porId[id])), xy = red.ids.map((id) => `${(+porId[id].lon).toFixed(5)},${(+porId[id].lat).toFixed(5)}`);
  const clave = "rutas:" + (await sha256(JSON.stringify([xy, zs])));
  let R = await IDB.get(clave, "geo");
  if (!R) {
    R = { auto: T.auto.map((f) => f.slice()), pie: T.pie.map((f) => f.slice()) };
    const bloques = [];
    for (const z of new Set(zs)) {
      const idx = zs.map((x, i) => (x === z ? i : -1)).filter((i) => i >= 0);
      const grupos = []; for (let k = 0; k < idx.length; k += 50) grupos.push(idx.slice(k, k + 50));
      if (idx.length <= 100) bloques.push([idx, idx]); else for (const a of grupos) for (const b of grupos) bloques.push([a, b]);
    }
    let hechos = 0;
    try {
      for (const [src, dst] of bloques) for (const modo of ["auto", "pie"]) {
        aviso(`Tiempos de viaje por calles (OpenStreetMap): consulta ${++hechos} de ${bloques.length * 2}…`);
        const sub = [...new Set([...src, ...dst])], pos = (i) => sub.indexOf(i);
        const url = OSRM[modo] + sub.map((i) => xy[i]).join(";") + `?annotations=duration&sources=${src.map(pos).join(";")}&destinations=${dst.map(pos).join(";")}`;
        const r = await fetch(url); if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json(); if (j.code !== "Ok") throw new Error(j.code);
        src.forEach((i, a) => dst.forEach((k, b) => { const s = j.durations[a][b]; if (s != null && i !== k) R[modo][i][k] = modo === "auto" ? Math.round((s / 60 * CONGESTION + ESTACIONAR_MIN) * 10) / 10 : Math.round(s / 6) / 10; }));
      }
      await IDB.put(clave, R, "geo");
    } catch (e) { console.warn("Tiempos de OpenStreetMap no disponibles, se usan estimados", e); return true; }
  }
  T.pie_est = T.pie_est || T.pie; T.auto = R.auto; T.pie = R.pie; T.fuente = { ...T.fuente, auto: "OpenStreetMap (OSRM)", pie: "OpenStreetMap (OSRM)" };
  await accesoPorCalles(est, aviso).catch((e) => console.warn("Caminata a estaciones por calles no disponible", e));
  return true;
}
// Caminata real (OSRM a pie) de cada sede y cada hipódromo a sus estaciones cercanas, y de los hipódromos a las sedes
// (a pie y en auto). Con eso Python recalcula los tiempos en metro o tren. Solo se envían coordenadas.
const RADIO_ESTACION_KM = 1.6;   // en línea recta; más lejos se camina más de 20 min
async function accesoPorCalles(est, aviso) {
  const T = est.tiempos, red = est.red, porId = Object.fromEntries(est.sedes.map((s) => [s.sede_id, s]));
  if (T.fuente?.acceso && /OSRM/.test(T.fuente.acceso) && T.hip_calles) return;
  if (est._accesoIntentado) return;
  est._accesoIntentado = true;
  const est_ = [];
  for (const [l, es] of [...Object.entries(lineasMetro()), ...Object.entries(lineasFuturas())]) for (const e of es) est_.push({ clave: `${l}|${e.estacion}`, lat: e.lat, lon: e.lon });
  const pts = [...red.ids.map((id) => ({ id, lat: +porId[id].lat, lon: +porId[id].lon })), ...(T.hipodromos || []).map((h) => ({ id: "HIP-" + h.codigo, lat: h.lat, lon: h.lon }))];
  const xy = (p) => `${(+p.lon).toFixed(5)},${(+p.lat).toFixed(5)}`;
  const clave = "acceso:" + (await sha256(JSON.stringify([pts.map(xy), est_.map((e) => e.clave)])));
  let A = await IDB.get(clave, "geo");
  if (!A) {
    A = { acceso: {}, hip: {} };
    const cerca = pts.map((p) => est_.filter((e) => kmEntre([p.lat, p.lon], [e.lat, e.lon]) <= RADIO_ESTACION_KM));
    // Lotes de hasta 100 coordenadas (origenes + estaciones de esos origenes)
    const lotes = []; let lote = [], dest = new Set();
    pts.forEach((p, i) => {
      if (!cerca[i].length) return;
      const nuevo = new Set([...dest, ...cerca[i].map((e) => e.clave)]);
      if (lote.length && lote.length + 1 + nuevo.size > 100) { lotes.push([lote, [...dest]]); lote = []; dest = new Set(); }
      lote.push(i); cerca[i].forEach((e) => dest.add(e.clave));
    });
    if (lote.length) lotes.push([lote, [...dest]]);
    const porClave = Object.fromEntries(est_.map((e) => [e.clave, e]));
    const hips = (T.hipodromos || []).map((h) => ({ h, dest: red.ids.map((id, j) => j).filter((j) => zonaDe(porId[red.ids[j]]) === h.zona) }));
    const consultasHip = hips.reduce((a, x) => a + Math.ceil(x.dest.length / 90) * 2, 0);
    let hechas = 0, total = lotes.length + consultasHip;
    for (const [orig, dclaves] of lotes) {
      aviso(`Caminata a estaciones por calles (OpenStreetMap): consulta ${++hechas} de ${total}…`);
      const coords = [...orig.map((i) => xy(pts[i])), ...dclaves.map((k) => xy(porClave[k]))];
      const url = OSRM.pie + coords.join(";") + `?annotations=duration&sources=${orig.map((_, a) => a).join(";")}&destinations=${dclaves.map((_, b) => orig.length + b).join(";")}`;
      const r = await fetch(url); if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json(); if (j.code !== "Ok") throw new Error(j.code);
      orig.forEach((i, a) => { const m = (A.acceso[pts[i].id] = {}); dclaves.forEach((k, b) => { const s = j.durations[a][b]; if (s != null) m[k] = Math.round(s / 6) / 10; }); });
    }
    // Hipódromos a las sedes de su zona, a pie y en auto
    for (const { h, dest } of hips) {
      const H = (A.hip[h.codigo] = { pie: {}, auto: {} });
      for (let k = 0; k < dest.length; k += 90) {
        const sub = dest.slice(k, k + 90);
        for (const modo of ["pie", "auto"]) {
          aviso(`Tiempos de los hipódromos por calles (OpenStreetMap): consulta ${++hechas} de ${total}…`);
          const coords = [xy(h), ...sub.map((j) => xy(pts[j]))];
          const url = OSRM[modo] + coords.join(";") + `?annotations=duration&sources=0&destinations=${sub.map((_, b) => b + 1).join(";")}`;
          const r = await fetch(url); if (!r.ok) throw new Error("HTTP " + r.status);
          const jj = await r.json(); if (jj.code !== "Ok") throw new Error(jj.code);
          sub.forEach((j, b) => { const s = jj.durations[0][b]; if (s != null) H[modo][j] = modo === "auto" ? Math.round((s / 60 * CONGESTION + ESTACIONAR_MIN) * 10) / 10 : Math.round(s / 6) / 10; });
        }
      }
    }
    await IDB.put(clave, A, "geo");
  }
  // Python recalcula metro y tren con la caminata real; pie y auto (OSRM) se conservan
  aviso("Recalculando tiempos en metro y tren con la caminata por calles…");
  const r = await pedirPython({ tipo: "tiempos", entrada: JSON.stringify({ ids: red.ids, km: red.km, factor_ruta: est.config?.factor_ruta || 1.3, acceso: A.acceso,
    lat: red.ids.map((id) => porId[id].lat), lon: red.ids.map((id) => porId[id].lon), zonas: red.ids.map((id) => zonaDe(porId[id])) }) });
  const N = JSON.parse(r.json);
  for (const h of N.hipodromos || []) {
    const c = A.hip[h.codigo]; if (!c) continue;
    h.pie_est = h.pie.slice();
    h.pie = h.pie.map((v, j) => c.pie[j] ?? v);
    h.auto_calles = h.pie.map((_, j) => c.auto[j] ?? null);
    h.metro = h.metro.map((v, j) => (v != null && h.pie_est[j] != null && v >= h.pie_est[j] - 0.05 ? h.pie[j] : v));   // sin rieles: caminata real
  }
  Object.assign(T, { metro: N.metro, futuras: N.futuras, llegada_metro: N.llegada_metro, estaciones: N.estaciones, hipodromos: N.hipodromos, pie_est: N.pie,
    hip_calles: true, acceso: A.acceso, fuente: { ...T.fuente, metro: N.fuente.metro, acceso: N.fuente.acceso } });
}
// Al abrir un estado: completa tiempos en segundo plano y repinta
function completarTiemposEnFondo() {
  const est = APP.est;
  if (!est || (est.tiempos && est.tiempos.version === VERSION_TIEMPOS && ((/OSRM/.test(est.tiempos.fuente.auto) && /OSRM/.test(est.tiempos.fuente.acceso || "")) || est._osrmIntentado))) return;
  asegurarTiempos(est).then(() => { if (APP.est !== est) return; APP._costo = null; prepararCategorias(); actualizarDistanciaHuff(); if (typeof renderAll === "function") renderAll();
    if (APP.tab === "red") pintarRed(); else if (APP.tab === "segmentos") pintarSegmentos(); })
    .catch((e) => console.warn("No se pudieron calcular tiempos de viaje", e));
}

let mapa = null, capa = null;
function gananciasHuff(cerradas = state.closedStores) {
  // Captura anual (primer ano proyectado) de cada sede abierta por los cierres dados: misma formula del simulador
  const D = DASHBOARD_DATA, gan = {}; let fuga = 0, base = 0;
  const abiertas = D.huff_ids.filter((i) => !cerradas.has(i));
  for (const c of cerradas) {
    if (!D.matriz_distancias[c]) continue;
    const v = D.locales[c].proy_anual_base.real_p50[0];
    let den = state.u0; const s = {};
    for (const j of abiertas) { s[j] = atractivoHuff(j) * Math.pow(Math.max(0.5, D.matriz_distancias[c][j] ?? 5), -state.lambda); den += s[j]; }
    for (const j of abiertas) gan[j] = (gan[j] || 0) + (v * s[j]) / den;
    fuga += (v * state.u0) / den; base += v;
  }
  return { gan, fuga, base };
}
// Color de la sede segun el hipodromo que la administra (columna GESTION): intenso si le quedan 3 años o mas hasta su
// cierre (calendario) y se aclara al acercarse. Club Hipico verde, Hipodromo Chile azul, Concepcion amarillo, Sporting burdeo.
const COLOR_GESTION = {
  CHS: { nombre: "Club Hípico", pleno: [0, 112, 60], tenue: [204, 230, 214] },
  HCH: { nombre: "Hipódromo Chile", pleno: [0, 48, 88], tenue: [199, 213, 229] },
  CHC: { nombre: "Club Hípico de Concepción", pleno: [217, 154, 0], tenue: [251, 236, 180] },
  VSC: { nombre: "Valparaíso Sporting", pleno: [140, 30, 55], tenue: [236, 205, 212] },
  OTRO: { nombre: "Sin hipódromo asignado", pleno: [102, 112, 133], tenue: [214, 219, 226] },
};
const MESES_SANA = 36;
const gestionDe = (id) => COLOR_GESTION[String(APP._porId?.[id]?.gestion || "").toUpperCase()] || COLOR_GESTION.OTRO;
const rgb = (c) => `rgb(${c.join(",")})`;
const bordeSede = (id) => rgb(gestionDe(id).pleno);
function colorSalud(id, mesRef) {
  const G = gestionDe(id), k = calendarioDe(id);
  if (!k) return rgb(G.pleno);   // red minima: no cierra
  const f = Math.max(0, Math.min(1, difMeses(mesRef, k.mes) / MESES_SANA));
  return rgb(G.tenue.map((g, i) => Math.round(g + (G.pleno[i] - g) * f)));
}
// Leyenda: un tramo por hipodromo presente en la red (de intenso a tenue = de lejos a cerca de su cierre)
function leyendaGestion(gradiente = true) {
  const presentes = Object.keys(COLOR_GESTION).filter((g) => (APP.est?.sedes || []).some((s) => s.grupo !== "DIGITAL" && s.lat != null && gestionDe(s.sede_id) === COLOR_GESTION[g]));
  return presentes.map((g) => { const G = COLOR_GESTION[g];
    return `<span title="${gradiente ? "Intenso: le quedan 3 años o más hasta su cierre. Se aclara a medida que se acerca." : ""}"><i style="background:${gradiente ? `linear-gradient(90deg,${rgb(G.pleno)},${rgb(G.tenue)})` : rgb(G.pleno)};width:${gradiente ? 26 : 10}px;border-radius:5px"></i>${G.nombre}</span>`; }).join("");
}
function calendarioDe(id) {
  return calendarioCierres()[id];
}
const mesHoy = () => sumarMeses(historia().corte, 1);
const anilloRol = (r) => (r?.rol === "CRITICA" ? { color: "#2E3192", weight: 2.5 } : null);   // de esta sede dependen otras
function colorDe(s) {
  if (APP.colorPor === "rol") return colorSalud(s.sede_id, mesHoy());
  if (APP.colorPor === "categoria") return COLOR_CAT[categoriaDe(s)];
  const v = s[APP.colorPor];
  const cats = [...new Set(APP.est.sedes.map((x) => x[APP.colorPor]).filter((x) => x != null))].sort();
  return v == null ? "#94A3B8" : PALETA[cats.indexOf(v) % PALETA.length];
}
function ajustarMapa(pts) {
  const z = APP.zonaMapa, sel = z === "TODAS" ? pts : pts.filter((s) => zonaDe(s) === z);
  // En una zona se encuadran las sedes que forman red (las conexiones son de pocos km); las aisladas quedan alrededor
  // En una zona se recortan las sedes mas alejadas (5% por lado) para que las conexiones de pocos km se vean
  if (z !== "TODAS" && sel.length >= 8) {
    const q = (a, p) => { const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.max(0, Math.round(p * (b.length - 1))))]; };
    const la = sel.map((s) => s.lat), lo = sel.map((s) => s.lon);
    mapa.fitBounds([[q(la, 0.05), q(lo, 0.05)], [q(la, 0.95), q(lo, 0.95)]], { padding: [20, 20], maxZoom: 14 });
  } else if (sel.length) mapa.fitBounds(sel.map((s) => [s.lat, s.lon]), { padding: [30, 30], maxZoom: 14 });
}
// Area que se alcanza desde una sede dentro del umbral de su zona (lo que antes era el radio en km).
// A pie y en auto: circulo con la velocidad en linea recta. Metro: caminata + manchas alrededor de las estaciones
// a las que se llega a tiempo, con el tiempo que queda para caminar desde ahi.
const M_POR_MIN_PIE = 80 / 1.3;
const COLOR_ALCANCE = "#003058", COLOR_SEDE_ALCANCE = "#496276";   // 4,8 km/h por calle, en linea recta
function velocidadAuto(i) {
  // Velocidad efectiva en linea recta segun los tiempos en auto de esta sede a las de su zona (mediana)
  const T = APP.est.tiempos, red = APP.est.red, z = zonaDe(APP._porId[red.ids[i]]), f = APP.est.config?.factor_ruta || 1.3, v = [];
  red.ids.forEach((id, j) => { const m = T.auto[i][j]; if (j !== i && m > 4 && zonaDe(APP._porId[id] || {}) === z) v.push((red.km[i][j] / f) * 1000 / (m - ESTACIONAR_MIN)); });
  return mediana(v) || { "SANTIAGO URBANO": 300, "ALREDEDORES RM": 480, "REGIONES": 550 }[z];   // m/min
}
// Isócrona por calles: tiempos OSRM desde el origen a una grilla polar (24 direcciones x 8 distancias);
// en cada dirección, el borde es la distancia más lejana que se alcanza dentro del umbral.
const ISO_DIR = 24, ISO_ANILLOS = [0.12, 0.24, 0.36, 0.5, 0.62, 0.75, 0.88, 1.0];
const ISO_RMAX = { pie: 95, auto: 750 };   // m por minuto: cota superior del alcance en línea recta
APP._iso = APP._iso || {};
function claveIso(s, modo, U) { return `iso:${modo}:${(+s.lat).toFixed(4)},${(+s.lon).toFixed(4)}:${U}`; }
function puntoA(lat, lon, rumbo, m) {
  const R = 6371000, d = m / R, la = lat * Math.PI / 180, lo = lon * Math.PI / 180, b = rumbo * Math.PI / 180;
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
  const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return [la2 * 180 / Math.PI, lo2 * 180 / Math.PI];
}
async function pedirIsocrona(s, modo, U) {
  const k = claveIso(s, modo, U);
  if (APP._iso[k] !== undefined) return;
  APP._iso[k] = null;                                   // pedida
  const g = await IDB.get(k, "geo").catch(() => null);
  if (g) { APP._iso[k] = g; return pintarRed(); }
  const U2 = modo === "auto" ? Math.max(1, U - ESTACIONAR_MIN) : U, rmax = U2 * ISO_RMAX[modo] * (modo === "auto" ? 1 / CONGESTION : 1);
  const pts = [];
  for (let d = 0; d < ISO_DIR; d++) for (const f of ISO_ANILLOS) pts.push({ d, r: f * rmax, ll: puntoA(s.lat, s.lon, (360 * d) / ISO_DIR, f * rmax) });
  const t = new Array(pts.length).fill(null);
  try {
    for (let a = 0; a < pts.length; a += 99) {
      const sub = pts.slice(a, a + 99);
      const coords = [[s.lat, s.lon], ...sub.map((p) => p.ll)].map(([la, lo]) => `${lo.toFixed(5)},${la.toFixed(5)}`);
      const r = await fetch(OSRM[modo] + coords.join(";") + `?annotations=duration&sources=0&destinations=${sub.map((_, b) => b + 1).join(";")}`);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json(); if (j.code !== "Ok") throw new Error(j.code);
      sub.forEach((_, b) => { const sec = j.durations[0][b]; t[a + b] = sec == null ? null : modo === "auto" ? sec / 60 * CONGESTION : sec / 60; });
    }
  } catch (e) { console.warn("Isócrona no disponible, se usa el círculo", e); APP._iso[k] = false; return; }
  // Borde por dirección: interpolación entre el último anillo alcanzado y el siguiente
  const borde = [];
  for (let d = 0; d < ISO_DIR; d++) {
    const fila = pts.map((p, i) => ({ ...p, t: t[i] })).filter((p) => p.d === d);
    let r = 0, prev = { r: 0, t: 0 };
    for (const p of fila) {
      if (p.t == null) continue;
      if (p.t <= U2) { r = p.r; prev = p; } else { r = Math.max(r, prev.r + (p.r - prev.r) * Math.max(0, (U2 - prev.t) / Math.max(0.1, p.t - prev.t))); break; }
    }
    borde.push(puntoA(s.lat, s.lon, (360 * d) / ISO_DIR, Math.max(r, 40)));
  }
  const radioMedio = borde.reduce((a, ll) => a + kmEntre([s.lat, s.lon], ll) * 1000, 0) / borde.length;
  APP._iso[k] = { borde, radioMedio, vel: radioMedio / U2 };
  IDB.put(k, APP._iso[k], "geo").catch(() => {});
  pintarRed();
}
function areaAlcanzable(s) {
  // s: origen (sede o hipodromo, ver origenDe).
  // Gris = desde el origen (caminando o en auto); las estaciones a las que se llega a tiempo se marcan con un punto.
  const z = s.zona, a = accesoZona(z), U = +a.umbral, T = APP.est.tiempos;
  const out = [];
  const desdeSede = (m, iso) => {
    // Con isócrona por calles se dibuja el polígono real; mientras llega (o sin conexión), el círculo aproximado
    if (iso) {
      out.push(L.polygon(iso.borde, { pane: "alcanceSede", stroke: false, fillColor: COLOR_SEDE_ALCANCE, fillOpacity: 1, interactive: false }));
      out.push(L.polygon(iso.borde, { color: COLOR_SEDE_ALCANCE, weight: 1.5, dashArray: "5 4", fill: false, interactive: false }));
      APP._radioSede = iso.radioMedio; APP._isoReal = true; return;
    }
    out.push(L.circle([s.lat, s.lon], { pane: "alcanceSede", stroke: false, fillColor: COLOR_SEDE_ALCANCE, fillOpacity: 1, radius: Math.max(m, 40), interactive: false }));
    out.push(L.circle([s.lat, s.lon], { color: COLOR_SEDE_ALCANCE, weight: 1.5, dashArray: "5 4", fill: false, radius: Math.max(m, 40), interactive: false }));
    APP._radioSede = m; APP._isoReal = false;
  };
  const iso = (modo) => { const k = claveIso(s, modo, U); if (APP._iso[k] === undefined) pedirIsocrona(s, modo, U); return APP._iso[k] || null; };
  if (a.modo === "km" || !T || s.sinT) { desdeSede((a.modo === "km" ? U : radioZona(z)) * 1000 / (APP.est.config?.factor_ruta || 1.3)); return out; }
  const auto = () => desdeSede(Math.max(0, U - ESTACIONAR_MIN) * s.vel(), iso("auto"));
  const pie = () => desdeSede(U * M_POR_MIN_PIE, iso("pie"));
  const metro = () => {
    pie();
    const ll = s.llegada, E = T.estaciones || [];
    // Una entrada por estacion fisica (las de combinacion vienen una vez por linea): la llegada mas temprana
    const porEst = new Map();
    if (ll) ll.forEach((t, k) => {
      if (t == null || t >= U) return;
      const clave = E[k].map((x) => (+x).toFixed(5)).join(","), prev = porEst.get(clave);
      if (!prev || t < prev.t) porEst.set(clave, { t, ll: E[k] });
    });
    for (const [clave, { t, ll: pos }] of porEst) {
      const info = estacionPorPos()[clave];
      out.push(L.circleMarker(pos, { pane: "hipodromos", radius: 4, weight: 1.5, color: "#fff", fillColor: COLOR_ALCANCE, fillOpacity: 1 })
        .bindTooltip(`<b>Estación ${esc(info?.nombre || "")}</b>${info ? " · " + info.lineas.map(nombreLinea).join(" y ") : ""}<br>`
          + `Desde ${esc(s.nombre)} llegas en ${fmt.num(t, 0)} min (caminata, espera y viaje).`));
    }
  };
  if (a.modo === "auto") auto(); else if (a.modo === "pie") pie(); else if (a.modo === "metro") metro(); else { auto(); metro(); }
  return out;
}
// Hipodromos: nodos fijos de la red. Se comportan como una sede (alternativa, lineas, area alcanzable),
// pero nunca cierran ni se cuentan como sedes.
const HIP = "HIP-";
const esHip = (id) => String(id).startsWith(HIP);
function hipNodos() { return (APP.est.tiempos?.hipodromos || []).map((h) => ({ ...h, id: HIP + h.codigo })); }
function hipPorId(id) { return hipNodos().find((h) => h.id === id); }
// Se activan o desactivan en la red (uno por uno o todos); desactivado no es alternativa ni tiene lineas
const hipActivo = (id) => !(APP.hipOff || new Set()).has(id);
function hipActivos() { return hipNodos().filter((h) => hipActivo(h.id)); }
function alternarHipodromo(id, on = !hipActivo(id)) {
  const off = new Set(APP.hipOff || []);
  on ? off.delete(id) : off.add(id);
  APP.hipOff = off; prepararCategorias();
  if (APP.tab === "red") pintarRed(); else if (APP.tab === "segmentos") pintarSegmentos();
}
function nombreNodo(id) { return esHip(id) ? hipPorId(id)?.nombre || id : APP._porId[id]?.nombre || id; }
function velocidadAutoZona(z) {
  APP._velZona = APP._velZona?.est === APP.est ? APP._velZona : { est: APP.est };
  if (!(z in APP._velZona)) APP._velZona[z] = mediana(APP.est.red.ids.map((id, i) => (zonaDe(APP._porId[id] || {}) === z ? velocidadAuto(i) : null)));
  return APP._velZona[z] || { "SANTIAGO URBANO": 300, "ALREDEDORES RM": 480, "REGIONES": 550 }[z];
}
// Costo de acceso entre un hipodromo y la sede j de la red (mismo modo y unidad que las sedes de su zona; 9999 si es otra zona)
function costoHip(h, j) {
  const id = APP.est.red.ids[j], s = APP._porId[id], a = accesoZona(h.zona), f = APP.est.config?.factor_ruta || 1.3;
  if (!s || zonaDe(s) !== h.zona) return 9999;
  const km = kmEntre([h.lat, h.lon], [s.lat, s.lon]), auto = h.auto_calles?.[j] ?? (km * 1000) / velocidadAutoZona(h.zona) + ESTACIONAR_MIN;
  const pie = h.pie[j] ?? 9999, metro = Math.min(h.metro[j] ?? 9999, pie);
  return a.modo === "km" ? km * f : a.modo === "pie" ? pie : a.modo === "metro" ? metro : a.modo === "auto" ? auto : Math.min(pie, metro, auto);
}
function alcanceHipodromo(h) {
  const U = umbralZona(h.zona);
  return APP.est.red.ids.map((id, j) => ({ id, nombre: APP._porId[id]?.nombre, v: costoHip(h, j) })).filter((d) => d.v <= U).sort((x, y) => x.v - y.v);
}
// Origen de un area alcanzable: una sede o un hipodromo
function origenDe(id) {
  if (esHip(id)) { const h = hipPorId(id); return h && { id, lat: h.lat, lon: h.lon, nombre: h.nombre, zona: h.zona, llegada: h.llegada_metro, vel: () => velocidadAutoZona(h.zona) }; }
  const s = APP._porId[id];
  if (!s || s.lat == null || s.grupo === "DIGITAL") return null;
  const i = APP.est.red.ids.indexOf(id);
  return { id, lat: s.lat, lon: s.lon, nombre: s.nombre, zona: zonaDe(s), llegada: APP.est.tiempos?.llegada_metro?.[i], sinT: !APP.est.tiempos || i < 0,
    vel: () => (i >= 0 ? velocidadAuto(i) : velocidadAutoZona(zonaDe(s))) };
}
function pintarControlesAcceso() {
  const sinT = !APP.est.tiempos;
  $("acceso").innerHTML = Object.keys(ACCESO_DEF).map((z) => {
    const a = accesoZona(z);
    return `<div class="grid grid-cols-12 gap-2 items-center mt-1"><span class="col-span-4 text-[11px] text-slate-600">${NOMBRE_ZONA[z]}</span>
      <select class="col-span-5" data-acc-modo="${z}" ${sinT ? "disabled" : ""}>${Object.entries(MODOS).map(([k, v]) => `<option value="${k}" ${k === a.modo ? "selected" : ""}>${v}</option>`).join("")}</select>
      <input class="col-span-2" type="number" min="1" step="1" value="${a.umbral}" data-acc-umbral="${z}"><span class="col-span-1 text-[11px] text-slate-500">${unidad(z)}</span></div>`;
  }).join("") + `<p class="text-[11px] text-slate-500 mt-2">${esc(notaTiempos())}</p>`;
  const fijar = (z, cambio) => {
    const a = { ...accesoZona(z), ...cambio };
    if (cambio.modo && (cambio.modo === "km") !== (accesoZona(z).modo === "km")) a.umbral = cambio.modo === "km" ? radioZona(z) : ACCESO_DEF[z].umbral;
    if (cambio.modo === "km" || a.modo === "km") APP.radios = { ...(APP.radios || {}), [z]: a.umbral };
    APP.acceso = { ...(APP.acceso || {}), [z]: a }; APP._costo = null; actualizarDistanciaHuff(); pintarRed();
  };
  $("acceso").querySelectorAll("[data-acc-modo]").forEach((s) => (s.onchange = () => fijar(s.dataset.accModo, { modo: s.value })));
  $("acceso").querySelectorAll("[data-acc-umbral]").forEach((s) => (s.onchange = () => fijar(s.dataset.accUmbral, { umbral: +s.value || 1 })));
}
// =====================================================================
// Conexiones dibujadas por su camino real: ruta peatonal o en auto por calles (OSRM), o caminata + metro/tren + caminata
// =====================================================================
const OSRM_RUTA = { auto: "https://routing.openstreetmap.de/routed-car/route/v1/driving/", pie: "https://routing.openstreetmap.de/routed-foot/route/v1/driving/" };
APP._rutas = {};
let colaRutas = [], rutasCorriendo = false, repintarRutas = null;
const xyRuta = ([la, lo]) => `${(+lo).toFixed(5)},${(+la).toFixed(5)}`;
async function rutaCalles(modo, a, b) {
  const k = `ruta:${modo}:${xyRuta(a)};${xyRuta(b)}`;
  const g = await IDB.get(k, "geo").catch(() => null);
  if (g) return g;
  await esperar(250);
  const r = await fetch(OSRM_RUTA[modo] + xyRuta(a) + ";" + xyRuta(b) + "?overview=full&geometries=geojson");
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json(); if (j.code !== "Ok" || !j.routes?.[0]) throw new Error(j.code);
  const c = j.routes[0].geometry.coordinates.map(([lo, la]) => [+la.toFixed(5), +lo.toFixed(5)]);
  IDB.put(k, c, "geo").catch(() => {});
  return c;
}
// OSRM parte y termina en la calle más cercana: se une con el punto real (sede o estación) y se recortan
// las puntas que la ruta recorre de ida y vuelta junto al punto de partida o llegada
function conExtremos(c, a, b) {
  if (!c?.length) return [a, b];
  const d = (p, q) => kmEntre(p, q);
  let i0 = 0, i1 = c.length - 1;
  for (let i = 1; i < Math.min(c.length, 12); i++) if (d(c[i], a) < d(c[i0], a)) i0 = i;
  for (let i = c.length - 2; i > Math.max(i0, c.length - 13); i--) if (d(c[i], b) < d(c[i1], b)) i1 = i;
  return [a, ...c.slice(i0, i1 + 1), b];
}
// Índice en la red y punto de un nodo (sede o hipódromo)
function nodoRuta(id) {
  if (esHip(id)) { const h = hipPorId(id); return h && { id, ll: [h.lat, h.lon], acc: APP.est.tiempos?.acceso?.[id], h }; }
  const s = APP._porId[id], i = APP.est.red.ids.indexOf(id);
  return s && s.lat != null && { id, ll: [s.lat, s.lon], acc: APP.est.tiempos?.acceso?.[id], i };
}
function minutosPie(na, nb) {
  const T = APP.est.tiempos;
  if (na.i != null && nb.i != null) return T.pie?.[na.i]?.[nb.i] ?? 9999;
  const h = na.h || nb.h, j = na.h ? nb.i : na.i;
  return h?.pie?.[j] ?? 9999;
}
// Modo que realmente une el par según la regla de su zona
function modoArista(a, b, zona) {
  const m = accesoZona(zona).modo;
  if (m !== "rapido") return m;
  const na = nodoRuta(a), nb = nodoRuta(b), T = APP.est.tiempos;
  const auto = na.i != null && nb.i != null ? T.auto[na.i][nb.i] : (na.h || nb.h).auto_calles?.[na.h ? nb.i : na.i];
  const otros = Math.min(minutosPie(na, nb), na.i != null && nb.i != null ? T.metro[na.i][nb.i] : 9999);
  return auto != null && auto < otros ? "auto" : "metro";
}
function geometriaArista(a, b) {
  const zona = esHip(a) ? hipPorId(a)?.zona : zonaDe(APP._porId[a] || {});
  const modo = modoArista(a, b, zona), k = [a, b].sort().join("|") + "|" + modo;
  if (APP._rutas[k] === undefined) { APP._rutas[k] = null; colaRutas.push({ k, a, b, modo }); procesarRutas(); }
  return APP._rutas[k] || null;
}
async function procesarRutas() {
  if (rutasCorriendo) return;
  rutasCorriendo = true;
  try {
    while (colaRutas.length) {
      // Los pares en metro se resuelven juntos en Python (qué estaciones usar); después, las caminatas por calles
      const lote = colaRutas.splice(0, 12);
      const enMetro = lote.filter((x) => x.modo === "metro");
      let caminos = [];
      if (enMetro.length) {
        const ent = enMetro.map((x) => { const na = nodoRuta(x.a), nb = nodoRuta(x.b); return { o: na.ll, d: nb.ll, pie: minutosPie(na, nb), acc_o: na.acc, acc_d: nb.acc }; });
        caminos = JSON.parse((await pedirPython({ tipo: "rutas", entrada: JSON.stringify(ent) })).json);
      }
      for (const x of lote) {
        const na = nodoRuta(x.a), nb = nodoRuta(x.b);
        try {
          if (x.modo === "km") { APP._rutas[x.k] = false; continue; }
          if (x.modo === "auto" || x.modo === "pie") { APP._rutas[x.k] = [{ tipo: x.modo, c: conExtremos(await rutaCalles(x.modo, na.ll, nb.ll), na.ll, nb.ll) }]; continue; }
          const cm = caminos[enMetro.indexOf(x)];
          if (!cm || cm.modo === "pie") { APP._rutas[x.k] = [{ tipo: "pie", c: conExtremos(await rutaCalles("pie", na.ll, nb.ll), na.ll, nb.ll) }]; continue; }
          const est = cm.camino, primera = [est[0][0], est[0][1]], ultima = [est.at(-1)[0], est.at(-1)[1]];
          const tramos = [{ tipo: "pie", c: conExtremos(await rutaCalles("pie", na.ll, primera), na.ll, primera) }];
          for (let k = 1; k < est.length; k++) if (est[k][2] === est[k - 1][2]) tramos.push({ tipo: "rieles", linea: est[k][2], c: [[est[k - 1][0], est[k - 1][1]], [est[k][0], est[k][1]]] });
          tramos.push({ tipo: "pie", c: conExtremos(await rutaCalles("pie", ultima, nb.ll), ultima, nb.ll) });
          APP._rutas[x.k] = tramos;
        } catch (e) { console.warn("Ruta no disponible, se dibuja recta", e); APP._rutas[x.k] = false; }
      }
      clearTimeout(repintarRutas);
      repintarRutas = setTimeout(() => { if (APP.tab === "red") pintarRed(); }, 150);
    }
  } finally { rutasCorriendo = false; }
}
// Dibuja una conexión: por su camino real si ya está; si no, recta y punteada mientras se calcula
function dibujarArista(a, b, pa, pb, { cortada = false, resalta = false, opacidad = 0.55 } = {}) {
  const geo = APP.verRutas === false ? false : geometriaArista(a, b);
  if (cortada) { L.polyline(geo ? geo.flatMap((t) => t.c) : [pa, pb], { color: "#94A3B8", weight: 1, opacity: 0.6, dashArray: "3 5", interactive: false }).addTo(capa); return; }
  if (!geo) {
    L.polyline([pa, pb], { color: resalta ? "#0F1B2D" : "#334155", weight: resalta ? 3 : 2, opacity: resalta ? 0.8 : 0.4, dashArray: geo === null ? "4 5" : null, lineCap: "round", interactive: false }).addTo(capa);
    return;
  }
  for (const t of geo) {
    const esRiel = t.tipo === "rieles";
    L.polyline(t.c, { color: esRiel ? COLOR_METRO[t.linea] || "#334155" : resalta ? "#0F1B2D" : "#334155", weight: esRiel ? (resalta ? 6 : 5) : resalta ? 4 : 3,
      opacity: esRiel ? 0.85 : resalta ? 0.9 : opacidad, lineCap: "round", lineJoin: "round", dashArray: t.tipo === "pie" && !resalta ? null : null, interactive: false }).addTo(capa);
  }
}
function pintarRed() {
  if (!APP.est) return;
  prepararCategorias();
  actualizarGrafo();
  const G = APP.grafo, tiempo = APP.vistaRed === "tiempo", hoy = APP.vistaRed === "hoy";
  const cerradas = new Set((hoy || tiempo || !G) ? [] : G.cerradas);
  if ($("tiempo-bar")) $("tiempo-bar").hidden = !tiempo;
  APP.colorPor = "rol";
  pintarControlesAcceso();
  const pts = APP.est.sedes.filter((s) => s.lat != null && s.lon != null && s.grupo !== "DIGITAL");
  const zonas = Object.keys(ZONAS).filter((z) => pts.some((s) => zonaDe(s) === z));
  if (!APP.zonaMapa || (APP.zonaMapa !== "TODAS" && !zonas.includes(APP.zonaMapa))) APP.zonaMapa = zonas[0] || "TODAS";
  $("red-zonas").innerHTML = [...zonas, "TODAS"].map((z) => `<button class="nav-tab ${z === APP.zonaMapa ? "on" : ""}" data-zona="${z}">${z === "TODAS" ? "Todo Chile" : NOMBRE_ZONA[z]}</button>`).join("");
  $("red-zonas").querySelectorAll("[data-zona]").forEach((b) => (b.onclick = () => { APP.zonaMapa = b.dataset.zona; APP._mapaAjustado = null; pintarRed(); }));

  if (!mapa) {
    mapa = L.map("mapa", { zoomSnap: 0.25, zoomDelta: 0.5 }).setView([-33.45, -70.65], 10);
    const alcance = mapa.createPane("alcance");
    alcance.style.zIndex = 390; alcance.style.opacity = 0.22; alcance.style.pointerEvents = "none";
    const alcanceSede = mapa.createPane("alcanceSede");
    alcanceSede.style.zIndex = 391; alcanceSede.style.opacity = 0.18; alcanceSede.style.pointerEvents = "none";
    mapa.createPane("hipodromos").style.zIndex = 640;   // sobre las sedes
    const lejos = () => $("mapa").classList.toggle("zoom-lejos", mapa.getZoom() < 8);   // de lejos solo el codigo del hipodromo
    mapa.on("zoomend", lejos); lejos();
    // Fondo: OpenStreetMap bloquea paginas abiertas como archivo local (sin Referer) y CARTO ahora pide API key.
    // Esri sirve sin clave; si sus teselas fallan, se cambia solo al mapa de calles de Esri.
    const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/";
    const base = L.tileLayer(ESRI + "Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16, attribution: "Mapa base © Esri, HERE, Garmin, © OpenStreetMap" }).addTo(mapa);
    L.tileLayer(ESRI + "Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16 }).addTo(mapa);
    let fallas = 0;
    base.on("tileerror", () => {
      if (++fallas === 4) { base.setUrl(ESRI + "World_Street_Map/MapServer/tile/{z}/{y}/{x}"); console.warn("Fondo de mapa alternativo (Esri calles)"); }
    });
  }
  mapa.invalidateSize();
  if (capa) capa.remove();
  capa = L.layerGroup().addTo(mapa);
  const porId = APP._porId, ubic = (id) => { if (esHip(id)) { const h = hipPorId(id); return h ? [h.lat, h.lon] : null; } return porId[id] && porId[id].lat != null ? [porId[id].lat, porId[id].lon] : null; };

  const sel = porId[APP.sedeSel];
  if (APP.verMetro !== false)
  {
    const estaciones = {};   // una por nombre (las de combinacion aparecen en dos lineas)
    for (const [l, est] of Object.entries(lineasMetro())) {
      L.polyline(est.map((e) => [e.lat, e.lon]), { color: COLOR_METRO[l] || "#64748B", weight: 3, opacity: TRENES.has(l) ? 0.6 : 0.35, dashArray: TRENES.has(l) ? "7 5" : null, interactive: false }).addTo(capa);
      for (const e of est) (estaciones[e.estacion] = estaciones[e.estacion] || { ...e, lineas: [] }).lineas.push(l);
    }
    for (const e of Object.values(estaciones))
      L.circleMarker([e.lat, e.lon], { radius: 2.5, weight: 1.2, color: "#94A3B8", fillColor: "#fff", fillOpacity: 1 })
        .bindTooltip(`Estación ${esc(e.estacion)} · ${[...new Set(e.lineas)].map(nombreLinea).join(" y ")}`).addTo(capa);
  }
  if (APP.verFuturas !== false) {
    // Líneas en obras o proyectadas: punteadas y tenues; en la línea de tiempo, abiertas desde su mes de apertura
    const mesRef = APP.vistaRed === "tiempo" ? APP.mesLinea : null;
    for (const [l, est] of Object.entries(lineasFuturas())) {
      const col = COLOR_METRO[l] || "#64748B";
      for (let k = 1; k < est.length; k++) {
        const a = est[k - 1], b = est[k], abierta = mesRef && a.apertura <= mesRef && b.apertura <= mesRef;
        L.polyline([[a.lat, a.lon], [b.lat, b.lon]], abierta ? { color: col, weight: 3, opacity: 0.5, dashArray: TRENES.has(l) ? "7 5" : null, interactive: false }
          : { color: col, weight: 2.5, opacity: 0.45, dashArray: "2 6", lineCap: "round", interactive: false }).addTo(capa);
      }
      for (const e of est)
        L.circleMarker([e.lat, e.lon], { radius: 2.5, weight: 1.2, color: col, fillColor: "#fff", fillOpacity: 1, dashArray: "2 2" })
          .bindTooltip(`Estación ${esc(e.estacion)} · ${nombreLinea(l)} (futura)<br>Apertura estimada ${nombreMes(e.apertura)} · ${esc(e.estado)}<br><span style="color:#667085">${esc(e.fuente)}</span>`, { className: "tip-ancho" }).addTo(capa);
    }
  }
  if (tiempo) pintarMapaTiempo(pts, ubic);
  // Conexiones: sedes que son alternativa una de otra
  else for (const [a, b] of G?.aristas || []) {
    const pa = ubic(a), pb = ubic(b); if (!pa || !pb) continue;
    const cortada = cerradas.has(a) || cerradas.has(b), resalta = APP.sedeSel === a || APP.sedeSel === b;
    if (APP.zonaMapa !== "TODAS" && zonaDe(APP._porId[a] || hipPorId(a) || {}) !== APP.zonaMapa && !esHip(a)) { L.polyline([pa, pb], { color: "#334155", weight: 2, opacity: 0.4, interactive: false }).addTo(capa); continue; }
    dibujarArista(a, b, pa, pb, { cortada, resalta });
  }
  const { gan } = gananciasHuff(cerradas);
  const maxV = Math.max(...pts.map((s) => s.venta_12m_real || 0), 1);
  if (!tiempo) for (const s of pts) {
    const cerrada = cerradas.has(s.sede_id), r = rolDe(s.sede_id), pierde = r?.pierde_respaldo, esSel = s.sede_id === APP.sedeSel;
    const m = L.circleMarker([s.lat, s.lon], {
      radius: 3.5 + 5.5 * Math.sqrt((s.venta_12m_real || 0) / maxV),
      weight: esSel || pierde ? 3 : anilloRol(r)?.weight || 1,
      color: esSel ? "#0F1B2D" : pierde ? "#F15A24" : cerrada ? "#64748B" : anilloRol(r)?.color || "#fff",
      fillColor: cerrada ? "#fff" : colorDe(s), fillOpacity: cerrada ? 0.9 : 0.9, dashArray: cerrada ? "2 2" : null,
    });
    const g = gan[s.sede_id] || 0;
    m.bindTooltip(`<b>${esc(s.nombre)}</b><br>${cerrada ? `Cierra en ${s.fecha_cierre_decidida ? nombreMes(mes7(s.fecha_cierre_decidida)) : "fecha por definir"} (decidido)` : r ? `${ROLES[r.rol].nombre} · ${r.vecinas} alternativa${r.vecinas === 1 ? "" : "s"}` : ""}`
      + `${pierde ? "<br><b style='color:#C2410C'>Pierde su alternativa con los cierres decididos</b>" : ""}${g > 0.05 ? `<br>+$${pesos(g)} al año de sedes cerradas` : ""}`);
    m.on("click", (ev) => {
      APP.sedeSel = s.sede_id;
      pintarRed();
    });
    m.addTo(capa);
  }
  const HT = Object.fromEntries(hipNodos().map((h) => [h.codigo, h]));
  for (const h of hipodromos()) {
    const ht = HT[h.codigo], id = HIP + h.codigo, activo = hipActivo(id);
    let detalle = "";
    if (ht && !activo) detalle = "<br><b>Desactivado:</b> fuera de la red, no es alternativa. Shift+clic o su ficha para activarlo.";
    else if (ht) {
      const dentro = alcanceHipodromo(ht);
      detalle = `<br>No cierra: es alternativa para las sedes a ${textoAcceso(ht.zona)} o menos.<br>${dentro.length ? `<b>${dentro.length} sede${dentro.length === 1 ? "" : "s"}:</b> ` + dentro.slice(0, 8).map((d) => `${esc(d.nombre)} (${fmt.num(d.v, 0)} ${unidad(ht.zona)})`).join(", ") + (dentro.length > 8 ? "…" : "") : "Ninguna sede a ese tiempo."}`;
    }
    const mk = L.marker([h.lat, h.lon], { pane: "hipodromos", keyboard: false, icon: L.divIcon({ className: "", iconSize: null,
      html: `<div class="hipo hipo-${esc(h.codigo)} ${APP.sedeSel === id ? "sel" : ""} ${activo ? "" : "off"}"><b><i>${esc(h.codigo)}</i></b><span>${esc(h.nombre)}</span></div>` }) })
      .bindTooltip(`<b>${esc(h.nombre)}</b><br>${esc(h.ciudad)} · hipódromo${detalle}`, { direction: "top", offset: [0, -14], className: "tip-ancho" });
    if (ht) mk.on("click", (ev) => {
      APP.sedeSel = id;
      if (ev.originalEvent.shiftKey && !document.body.classList.contains("presentacion")) alternarHipodromo(id); else pintarRed();
    });
    mk.addTo(capa);
  }
  if (APP._mapaAjustado !== APP.est && $("mapa").offsetWidth > 0 && pts.length) { ajustarMapa(pts); APP._mapaAjustado = APP.est; }

  // Leyenda
  const anillo = `<span><i style="background:#fff;border:2px solid #F15A24"></i>Pierde su alternativa</span><span><i style="background:#fff;border:1px dashed #64748B"></i>Cerrada</span>`;
  const zonaSel = "";
  const nOn = hipActivos().length, nTot = hipNodos().length;
  const hipo = `<label class="cursor-pointer" title="Nodo fijo de la red: no cierra y es alternativa para las sedes a su alcance. Clic: ver su alcance. Shift+clic: activar o desactivar uno."><input type="checkbox" id="ver-hipo" ${nOn ? "checked" : ""} class="mr-1 align-[-1px]"><i class="hipo-ley"></i>Hipódromos en la red${nTot && nOn < nTot ? ` (${nOn} de ${nTot})` : ""}</label>`;
  const conMetro = APP.verMetro !== false;
  const metro = `<label class="cursor-pointer"><input type="checkbox" id="ver-metro" ${conMetro ? "checked" : ""} class="mr-1 align-[-1px]">Metro y trenes</label>`
    + `<label class="cursor-pointer" title="Líneas en obras o proyectadas, con su apertura estimada. En la línea de tiempo se suman a la red desde esa fecha."><input type="checkbox" id="ver-futuras" ${APP.verFuturas !== false ? "checked" : ""} class="mr-1 align-[-1px]">Líneas futuras</label>`
;
  const sep = `<span class="w-px h-4 bg-slate-200 self-center"></span>`;
  if (tiempo) $("leyenda").innerHTML = hipo + metro + sep + leyendaTiempo() + zonaSel;
  else if (APP.colorPor === "rol") $("leyenda").innerHTML = hipo + metro + sep + leyendaGestion(true)
    + `<span title="${esc(ROLES.CRITICA.txt)}"><i style="background:#fff;border:2.5px solid #2E3192"></i>Otras dependen de ella</span>` + (hoy ? "" : anillo) + zonaSel;
  else if (APP.colorPor === "categoria") $("leyenda").innerHTML = hipo + zonaSel + ORDEN_CAT.map((c) => `<span><i style="background:${COLOR_CAT[c]}"></i>${c}</span>`).join("") + metro;
  else {
    const cats = [...new Set(APP.est.sedes.map((x) => x[APP.colorPor]).filter((x) => x != null))].sort();
    $("leyenda").innerHTML = hipo + zonaSel + cats.map((c, i) => `<span><i style="background:${PALETA[i % PALETA.length]}"></i>${esc(c)}</span>`).join("") + metro;
  }
  if ($("ver-metro")) $("ver-metro").onchange = (e) => { APP.verMetro = e.target.checked; pintarRed(); };
  if ($("ver-futuras")) $("ver-futuras").onchange = (e) => { APP.verFuturas = e.target.checked; pintarRed(); };
  if ($("ver-hipo")) $("ver-hipo").onchange = (e) => { APP.hipOff = new Set(e.target.checked ? [] : hipNodos().map((h) => h.id)); prepararCategorias(); pintarRed(); };
  if (!APP._grafoPedido) $("red-nota").textContent = "";
  pintarResumenTiempo();
  pintarFicha();
}

// Resumen ejecutivo de la red: tres cifras (hoy y, si hay, con cierres)
function sumaZonas(filas) {
  const s = { sedes: 0, sin_respaldo: 0, criticas: 0 };
  for (const f of filas) for (const k in s) s[k] += f?.[k] || 0;
  return s;
}
function kpisRed(h, e, z) {
  const c = (k) => (e && e[k] !== h[k] ? `${h[k]}<span class="text-slate-300 font-normal mx-1">→</span>${e[k]}` : `${(e || h)[k]}`);
  const tarjeta = (k, txt, color, tip) => `<div class="kpi-mini" title="${esc(tip)}"><div class="v">${c(k)}</div><div class="l">${color ? `<i class="inline-block w-2 h-2 rounded-full mr-1" style="background:${color}"></i>` : ""}${txt}</div></div>`;
  return `<div class="grid grid-cols-3 gap-2">${tarjeta("sedes", "Sedes", null, "Sedes físicas abiertas")}
    ${tarjeta("sin_respaldo", ROLES["SIN RESPALDO"].nombre, ROLES["SIN RESPALDO"].color, ROLES["SIN RESPALDO"].txt)}
    ${tarjeta("criticas", ROLES["CRITICA"].nombre, ROLES["CRITICA"].color, ROLES["CRITICA"].txt)}</div>
    <p class="text-[11px] text-slate-500 mt-1.5">${e ? "Hoy → con los cierres decididos. " : ""}${z && z !== "TODAS" ? `Alternativa: otra sede a no más de ${textoAcceso(z)}.` : ""}</p>`;
}
// =====================================================================
// Linea de tiempo del mapa
// Pasado: sedes con venta real cada mes (VTA HIST), incluidas las que ya cerraron.
// Futuro: calendario de cierres. Los decididos por la gerencia van en su fecha (son un hecho). El resto es una
// propuesta: cada cierre se evalua como proyecto y la sede cierra en la ventana de contrato con mayor VAN del cierre.
// =====================================================================
// Tasa de descuento: WACC nominal 10,5%: CAPM 9,85% (5,05% + 0,90 x 5,33%) mas 0,65 pp de premio por tamaño, iliquidez, concentracion y riesgo regulatorio. Si los flujos van en pesos reales (vista Real) se usa la tasa real
// equivalente (1 + nominal) / (1 + inflacion) - 1, para no descontar la inflacion dos veces.
const inflacionModelo = () => (typeof state !== "undefined" && state?.inflationRate != null ? state.inflationRate : APP.est?.config?.inflacion_futura ?? 0.03);
function tasaEfectiva() {
  const rN = APP.tasaDescuento ?? 0.105;
  return state?.currencyMode === "NOMINAL" ? rN : (1 + rN) / (1 + inflacionModelo()) - 1;
}
// [SUPUESTO] flujo de caja despues de impuesto (Sapag): impuesto de primera categoria, capital de trabajo de cada sede que se
// libera al cerrarla (sin impuesto) y vida util de la inversion de la mejora para su depreciacion (escudo fiscal)
const FINANZAS_DEF = { impuesto: 0.27, capitalTrabajo: 0, vidaUtil: 10, crecArriendo: 0.01, crecOtros: 0.02, tolerancia: 0, probMin: 0.80, amortiguacion: 1.0, anosFirmes: 3, metaDigital: 0, costoPrograma: 0, margenSeguimiento: 25 };
// Fecha de cada cierre: la primera ventana cuyo VAN esta a menos de "tolerancia" del maximo. Por defecto 0% = la fecha de
// mayor VAN esperado, para que la Flexibilidad muestre postergar como perdida y no como ganancia del margen.
const finz = () => APP.finanzas || FINANZAS_DEF;
// Gastos de la sede en el tiempo, sobre la inflacion: el arriendo sube 1% real al año (la hoja Y 2026 lo reajusta 4% nominal)
// y los otros gastos 2% real (personal y servicios). factorGastos = multiplicador del gasto total en el año ya (0 = 2027).
function factorGastos(s, ya) {
  const arr = (s?.arriendo_mensual_clp || 0) * 12, otros = s?.otros_fijos_anual_clp || 0, f = finz();
  if (arr + otros <= 0) return 1;
  return (arr * Math.pow(1 + f.crecArriendo, ya + 1) + otros * Math.pow(1 + f.crecOtros, ya + 1)) / (arr + otros);
}
function crecGastosSede(s) {
  const arr = (s?.arriendo_mensual_clp || 0) * 12, otros = s?.otros_fijos_anual_clp || 0, f = finz();
  return arr + otros > 0 ? (arr * f.crecArriendo + otros * f.crecOtros) / (arr + otros) : f.crecOtros;
}
// Valor presente del escudo fiscal de depreciar linealmente una inversion I en la vida util, a la tasa anual rA
const escudoDepreciacion = (I, rA) => { const f = finz(); let x = 0; for (let a = 1; a <= f.vidaUtil; a++) x += (f.impuesto * I / f.vidaUtil) / Math.pow(1 + rA, a); return x; };
// [SUPUESTO] experiencia mejorada de las sedes que se mantienen, a acordar con el cliente
const MEJORA_DEF = { inversion: 150, venta: 0.10, atractivo: 0.25 };   // MM$ por sede, alza de venta propia, alza de atractivo Huff
const MESES_PLAN_DIGITAL = 6;     // [SUPUESTO] migración al canal digital antes de avisar el término (sin dato del censo)
// [SUPUESTO] con dato del censo: de 3 meses (dificultad 0) a 9 meses (dificultad 100)
const mesesPlanDigital = (s) => { const e = entornoDe(s); return e ? Math.round(3 + 6 * e.d / 100) : MESES_PLAN_DIGITAL; };
const MESES_NOM = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const mes7 = (v) => (v ? String(v).slice(0, 7) : null);
const sumarMeses = (m, n) => { const x = +m.slice(0, 4) * 12 + +m.slice(5, 7) - 1 + n; return `${Math.floor(x / 12)}-${String((x % 12) + 1).padStart(2, "0")}`; };
const difMeses = (a, b) => (+b.slice(0, 4) * 12 + +b.slice(5, 7)) - (+a.slice(0, 4) * 12 + +a.slice(5, 7));
const nombreMes = (m) => `${MESES_NOM[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;
const COLOR_PASADO = "#556273";   // curva de venta real de la red (neutra: los colores son de los hipodromos)
const MESES_VISIBLE_CERRADA = 12;   // en el mapa, una sede cerrada se ve (hueca) solo durante un año
const MENORES = new Set(["de", "del", "la", "las", "los", "el", "y", "en"]);
// "TLK MALL PLAZA NORTE" -> "Mall Plaza Norte"
const nombreLindo = (n) => String(n ?? "").replace(/^TLK\s+/i, "").toLowerCase()
  .replace(/[a-záéíóúñü]+/g, (w, i) => (i > 0 && MENORES.has(w) ? w : w[0].toUpperCase() + w.slice(1)));

function historia() {
  if (APP._hist?.est === APP.est) return APP._hist;
  const venta = {}, primero = {}, ultimo = {}; let corte = "", maxV = 1;
  for (const r of APP.est.historico || []) {
    if (!(r.venta_real > 0)) continue;
    const m = mes7(r.mes), id = r.sede_id;
    (venta[m] = venta[m] || {})[id] = (venta[m][id] || 0) + r.venta_real;
    if (!primero[id] || m < primero[id]) primero[id] = m;
    if (!ultimo[id] || m > ultimo[id]) ultimo[id] = m;
    if (m > corte) corte = m;
  }
  for (const m in venta) for (const v of Object.values(venta[m])) maxV = Math.max(maxV, v);
  return (APP._hist = { est: APP.est, venta, primero, ultimo, corte, maxV, inicio: Object.keys(venta).sort()[0] || corte });
}
// Sin otra sede ni hipodromo al alcance: antes de avisar el termino hay que migrar a sus clientes al canal digital
function sinAlternativa(s) {
  const a = alternativa(s);
  return !(a && a.valor <= umbralZona(zonaDe(s)));
}
// Meses en que se puede cerrar la sede desde "desde": vencimientos del contrato que alcanzan a avisarse (supone
// renovacion anual); sin contrato conocido, cualquier mes con tres meses de aviso
function ventanasCierre(s, desde, fin) {
  const venc = mes7(s.vencimiento_contrato);
  const aviso = venc && s.fecha_limite_aviso ? Math.max(0, difMeses(mes7(s.fecha_limite_aviso), venc)) : 0;
  const out = [];
  let m = venc || sumarMeses(desde, 3);
  if (venc) while (sumarMeses(m, -aviso) < desde) m = sumarMeses(m, 12);
  const paso = venc ? 12 : 1, primera = m;
  for (; m <= fin; m = sumarMeses(m, paso)) out.push(m);
  return { meses: out, primera, aviso };
}
// VAN del proyecto "cerrar la sede en el mes t" frente a mantenerla, para cada mes de cierre posible: ahorro de costos
// fijos (GASTOS de la hoja) menos el ingreso perdido neto de lo que se recupera en otras sedes y en el canal digital, menos
// el costo de salida. Montos en millones de pesos. Incorpora el motor de simulacion de Ruben (economia.evaluar_estocastico
// en Python y simulaciones/motor_simulacion_van.py): retencion Huff con tope de capacidad de las receptoras (Top-3 como
// caso central, red completa como maximo), migracion digital segun el Censo de la comuna, tendencia de la venta que se
// amortigua, volatilidad propia de cada sede, costo del canal online y meses de arriendo para salir del contrato.
// baseCierre arma lo fijo de cada sede; flujosCierre los flujos mes a mes con un juego de supuestos p (null = caso base).
// Tendencia de la venta: dentro del horizonte sigue la historica de cada sede (amortiguacion configurable, 1 = sin amortiguar;
// la caida del canal fisico es estructural, coherente con la estrategia digital del cliente). Despues del horizonte la caida
// se amortigua con el phi central de Ruben (0,875 por ano), para que el valor terminal no suponga una caida perpetua.
const PHI_TERMINAL = 0.94;
const amortiguacion = () => finz().amortiguacion ?? 1.0;
const MESES_SALIDA_VENCIDO = [0.5, 1, 1.5];   // [SUPUESTO Ruben] cerrar al vencer el contrato: desarme y entrega
const MESES_SALIDA_SIN_DATO = [1, 2, 3];      // [SUPUESTO Ruben] contrato indefinido o sin fecha
// Parametros por sede que calcula el motor en Python (pestana Simulacion VAN de Ruben)
function paramSede(id) {
  if (APP._paramSim?.est !== APP.est) APP._paramSim = { est: APP.est, m: new Map((APP.est.simulacion_van || []).map((r) => [r.sede_id, r])) };
  return APP._paramSim.m.get(id) || null;
}
// Migracion digital de la sede: moda del motor (10% ajustado por la friccion del Censo) escalada al supuesto vigente
function digitalSede(id) {
  const ps = paramSede(id), base = APP.retencionDigitalCierre ?? 0.10;
  return ps?.md_moda != null ? Math.min(0.5, ps.md_moda * base / 0.10) : base;
}
function mesesSalida(s, m) {
  const venc = mes7(s.vencimiento_contrato);
  if (!venc) return MESES_SALIDA_SIN_DATO;
  if (m >= venc) return MESES_SALIDA_VENCIDO;
  const ps = paramSede(s.sede_id);
  return ps?.meses_salida_moda != null ? [ps.meses_salida_min, ps.meses_salida_moda, ps.meses_salida_max] : [1.5, 3, 6];
}
const triInv = (u, [a, m, b]) => (b <= a ? m : u < (m - a) / (b - a) ? a + Math.sqrt(u * (b - a) * (m - a)) : b - Math.sqrt((1 - u) * (b - a) * (b - m)));
function baseCierre(s, receptoras, inicio, mejoradas, persp = "TOTAL") {
  const loc = DASHBOARD_DATA.locales[s.sede_id];
  const e = economiaCierre(s, loc, s.sede_id, receptoras, mejoradas, persp);
  const anos = DASHBOARD_DATA.anos_proy || [2027];
  const isNom = state.currencyMode === "NOMINAL", infl = APP.est.config?.inflacion_futura || 0.03;
  const w = loc.month_weights?.length === 12 ? loc.month_weights : Array(12).fill(1 / 12);
  const v0 = ((isNom ? loc.proy_anual_base.nom_p50 : loc.proy_anual_base.real_p50) || [])[0] || 0;
  const n = difMeses(inicio, finPlan()) + 1;
  const g = Math.max(-0.12, Math.min(0.05, (s.crecimiento_anual_pct ?? 0) / 100));
  const parte = parteGastos(s, persp), arrMM = ((s.arriendo_mensual_clp || 0) / 1e6) * parte, otrMM = ((s.otros_fijos_anual_clp || 0) / 12 / 1e6) * parte;
  // Venta del primer ano proyectado repartida por mes; los anos siguientes los mueve la tendencia (amortiguada) de cada sorteo
  const vMes = new Float64Array(n), ya = new Int16Array(n);
  for (let k = 0; k < n; k++) {
    const mes = sumarMeses(inicio, k), a = Math.max(0, +mes.slice(0, 4) - anos[0]);
    ya[k] = a; vMes[k] = v0 * (isNom ? Math.pow(1 + infl, a) : 1) * w[+mes.slice(5, 7) - 1];
  }
  const vol = Math.max(0.04, Math.min(0.25, paramSede(s.sede_id)?.vol_local ?? s.volatilidad ?? 0.10));
  // Programa de migracion digital (escenario): en sedes sin otra sede al alcance, la retencion digital sube a la meta,
  // ajustada por la dificultad digital de la comuna (Censo), y su costo se suma al costo de salida
  const prog = programaDigital(s), md = prog ? Math.max(digitalSede(s.sede_id), prog.meta) : digitalSede(s.sede_id);
  // Zonas remotas (alrededores de la RM y regiones): menor densidad y poblacion que envejece sin recambio, la caida no se frena
  const remota = zonaDe(s) !== "SANTIAGO URBANO";
  return { s, e, n, vMes, ya, nAnos: ya[n - 1] + 1, g, vol, isNom, infl, arrMM, otrMM, parte, inicio, md, remota, costoPrograma: prog ? prog.costo * parte : 0 };
}
// Flujos mes a mes (millones) con los supuestos p; d = factor de descuento de cada mes
function flujosCierre(B, p = null) {
  const { e, n, vMes, ya, nAnos, g, isNom, infl, arrMM, otrMM } = B, f = finz();
  const rA = p ? p.rA : tasaEfectiva(), r = Math.pow(1 + rA, 1 / 12) - 1;
  const cA = f.crecArriendo + (p ? p.dc : 0), cO = f.crecOtros + (p ? p.dc : 0);
  const phi = p ? p.phi : amortiguacion(), gS = g + (p ? p.dg : 0);
  // Nivel de venta de cada ano: tendencia amortiguada y, en la simulacion, el ruido propio de la sede
  const nivel = new Float64Array(nAnos);
  for (let a = 0; a < nAnos; a++) {
    const paso = Math.max(0.2, Math.min(2, 1 + (a > 0 ? gS * Math.pow(phi, a) : 0) + (p?.eps ? p.eps[a] * B.vol : 0)));
    nivel[a] = (a > 0 ? nivel[a - 1] : 1) * paso;
  }
  const fis = p?.R != null ? p.R : p ? Math.min(1, p.mf) : e.physProb;
  const dig = p?.R != null ? 0 : (1 - fis) * (p ? p.md : B.md), fo = p ? p.fo : APP.factorCostoOnline ?? 0.15;
  const tasa = e.tasaSedePropia;
  const com = new Float64Array(n), gas = new Float64Array(n), recF = new Float64Array(n), recD = new Float64Array(n), d = new Float64Array(n);
  let acc = 1;
  for (let k = 0; k < n; k++) {
    acc /= 1 + r; d[k] = acc;
    const a = ya[k], c = vMes[k] * nivel[a] * tasa * (p?.kv ?? 1);
    com[k] = c; recF[k] = c * fis; recD[k] = c * dig * (1 - fo);
    gas[k] = (arrMM * Math.pow(1 + cA, a + 1) + otrMM * Math.pow(1 + cO, a + 1)) * (isNom ? Math.pow(1 + infl, a + 1) : 1);
  }
  // Valor terminal: despues del plan, el ultimo ano sigue con los gastos creciendo con su alza y la venta con su tendencia,
  // que se amortigua (PHI_TERMINAL por ano). 40 anos explicitos y luego perpetuidad con la venta estable.
  const arrA = arrMM * 12, otrA = otrMM * 12, gG = arrA + otrA > 0 ? (arrA * cA + otrA * cO) / (arrA + otrA) : cO;
  const gF = isNom ? (1 + gG) * (1 + infl) - 1 : gG, gN = isNom ? infl : 0, dFin = Math.pow(1 + r, -n);
  let fV = 0, fG = 0, S = 1, D = 1, Gc = 1;
  for (let h = 1; h <= 40; h++) {
    S *= Math.max(0.2, 1 + gS * (B.remota && gS < 0 ? 1 : Math.pow(PHI_TERMINAL, h))); D /= 1 + rA; Gc *= 1 + gF;
    const nom = isNom ? Math.pow(1 + infl, h) : 1;
    fV += S * nom * D; fG += Gc * D;
  }
  fV += S * (isNom ? Math.pow(1 + infl, 40) : 1) * D * (1 + gN) / Math.max(0.02, rA - gN);
  fG += Gc * D * (1 + gF) / Math.max(0.02, rA - gF);
  const gC = gS * PHI_TERMINAL;
  const ult = { com: 0, gas: 0, recF: 0, recD: 0 };
  for (let k = Math.max(0, n - 12); k < n; k++) { ult.com += com[k]; ult.gas += gas[k]; ult.recF += recF[k]; ult.recD += recD[k]; }
  const vt = { com: ult.com * fV * dFin, gas: ult.gas * fG * dFin, recF: ult.recF * fV * dFin, recD: ult.recD * fV * dFin };
  // Costo de salida en el mes m: el mayor entre el costo de cierre de la hoja y los meses de arriendo segun el contrato
  const u = p?.uSal ?? null;
  const costo = (m) => { const ms = mesesSalida(B.s, m); return Math.max((e.costoCierreCLP || 0) / 1e6, (u == null ? ms[1] : triInv(u, ms)) * arrMM) + (B.costoPrograma || 0); };
  return { com, gas, recF, recD, d, vt, costo, rA, r, dFin, fis, dig, gC, ult };
}
function vanDesdeBase(B, meses, p = null) {
  const F = flujosCierre(B, p), { n } = B, t = finz().impuesto, ct = finz().capitalTrabajo * B.parte;
  const suf = new Float64Array(n + 1);
  suf[n] = F.vt.gas - (F.vt.com - F.vt.recF - F.vt.recD);
  for (let k = n - 1; k >= 0; k--) suf[k] = suf[k + 1] + (F.gas[k] - (F.com[k] - F.recF[k] - F.recD[k])) * F.d[k];
  // Despues de impuesto: el ahorro y la perdida tributan, el costo de salida es deducible; el capital de trabajo se recupera
  const opciones = meses.map((m) => { const k = Math.max(0, difMeses(B.inicio, m)), dk = F.d[Math.min(k, n - 1)]; return { mes: m, van: (suf[Math.min(k, n)] - F.costo(m) * dk) * (1 - t) + ct * dk }; });
  if (p) return { opciones, retencion: F.fis + F.dig };
  let up = 0; for (let k = 0; k < n; k++) up += F.com[k] * APP.mejora.venta * F.d[k];
  up += F.vt.com * APP.mejora.venta;
  const invMejora = APP.mejora.inversion * B.parte;
  const vanMejora = up * (1 - t) - invMejora / (1 + F.r) + escudoDepreciacion(invMejora, F.rA);
  return { opciones, vanMejora, retencion: F.fis + F.dig };
}
function vanCierrePorMes(s, receptoras, meses, inicio, mejoradas, persp = "TOTAL") {
  return vanDesdeBase(baseCierre(s, receptoras, inicio, mejoradas, persp), meses);
}
// Incertidumbre del VAN de cada cierre (Monte Carlo, distribuciones del motor de Ruben). Comunes a todas las sedes (macro):
// tasa de descuento (+-1,5 puntos), alza real de los gastos (-1 a +1,5 puntos), amortiguacion de la tendencia (phi 0,80 a
// 0,95) y costo del canal online (10% a 30%). Propias de cada sede: retencion fisica PERT(0,6 x Top-3, Top-3, red completa),
// retencion digital PERT(3%, moda del Censo, 18%), cambio de tendencia N(0; 2,5 puntos), ruido anual con su volatilidad y
// meses de salida del contrato. Semilla fija: el calendario y la pestana Simulacion VAN ven los mismos escenarios.
const PROB_MIN_DEF = 0.80;   // [SUPUESTO] un cierre propuesto debe crear valor en al menos el 80% de los escenarios
function sorteosMC() {
  const N = SIM.iteraciones, rC = tasaEfectiva(), foC = APP.factorCostoOnline ?? 0.15;
  const clave = JSON.stringify([N, rC, foC, SIM.shockG, SIM.spreadCostos, amortiguacion()]);
  if (APP._sorteos?.clave === clave) return APP._sorteos;
  const prng = simMulberry32(42), p = [];
  for (let i = 0; i < N; i++) p.push({
    rA: simSampleTriangular(prng, Math.max(0.02, rC - 0.015), rC, rC + 0.015),
    dc: SIM.spreadCostos + simSampleTriangular(prng, -0.01, 0, 0.015),
    phi: Math.max(0.5, amortiguacion() - 0.10 * prng()),   // incertidumbre: hasta 10 puntos mas de amortiguacion
    fo: simSampleTriangular(prng, Math.min(0.10, foC), foC, Math.max(0.30, foC)),
  });
  APP._sorteos = { clave, p, porSede: new Map() };
  return APP._sorteos;
}
// Sorteos propios de una sede (semilla segun su codigo, para que no dependan del orden de evaluacion)
function sorteosSede(B) {
  const S = sorteosMC(), id = B.s.sede_id, e = B.e;
  const clave = [id, e.physProb, e.physFull, B.md, SIM.escalaMf, SIM.shockG].join("|");
  const c = S.porSede.get(clave); if (c) return c;
  let h = 2166136261; for (const ch of id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const prng = simMulberry32(h >>> 0), norm = simCreateBoxMuller(prng);
  const m3 = Math.min(1, e.physProb * SIM.escalaMf), full = Math.max(m3, Math.min(1, e.physFull * SIM.escalaMf));
  const out = S.p.map((x) => ({ ...x,
    mf: simSamplePert(prng, norm, 0.6 * m3, m3, full),
    md: simSamplePert(prng, norm, Math.min(0.03, B.md), B.md, Math.max(0.18, B.md)),
    dg: Math.max(-0.07, Math.min(0.07, norm(SIM.shockG, 0.025))),
    eps: Array.from({ length: B.nAnos }, () => norm(0, 1)),
    uSal: prng(),
  }));
  S.porSede.set(clave, out);
  return out;
}
// VAN de cerrar en cada mes para todos los sorteos: media, probabilidad de VAN positivo y percentiles por mes
function mcCierre(B, meses) {
  const P = sorteosSede(B), N = P.length, v = meses.map(() => new Float64Array(N)), ret = new Float64Array(N);
  for (let i = 0; i < N; i++) { const r = vanDesdeBase(B, meses, P[i]); r.opciones.forEach((o, j) => (v[j][i] = o.van)); ret[i] = r.retencion; }
  const q = (x, f) => x[Math.min(N - 1, Math.floor(N * f))];
  return meses.map((m, j) => {
    const x = Float64Array.from(v[j]).sort(); let s = 0, pos = 0;
    for (const y of x) { s += y; if (y > 0) pos++; }
    const cola = x.slice(0, Math.max(1, Math.floor(N * 0.05)));
    return { mes: m, media: s / N, prob: pos / N, p10: q(x, 0.1), p50: q(x, 0.5), p90: q(x, 0.9), cvar5: cola.reduce((a, y) => a + y, 0) / cola.length, vector: v[j], retEsp: ret.reduce((a, y) => a + y, 0) / N };
  });
}
const probMin = () => finz().probMin ?? PROB_MIN_DEF;
// Desglose del VAN de cerrar la sede en el mes t: misma cuenta que vanDesdeBase (caso base), por componente y por año.
// Por año van los flujos sin descontar y su valor presente (vp); "despues" es el valor terminal al final del plan.
function desgloseCierre(s, receptoras, t, inicio, mejoradas, persp = "TOTAL") {
  const B = baseCierre(s, receptoras, inicio, mejoradas, persp), F = flujosCierre(B), { n } = B, tx = finz().impuesto;
  const kt = Math.max(0, difMeses(inicio, t)), porAno = {}, van = { gastos: 0, comision: 0, fisica: 0, digital: 0, imp: 0, ct: 0 };
  const nuevo = () => ({ gastos: 0, comision: 0, fisica: 0, digital: 0, imp: 0, ct: 0, desc: 0, vp: { gastos: 0, comision: 0, fisica: 0, digital: 0, imp: 0, ct: 0 } });
  for (let k = kt; k < n; k++) {
    const a = sumarMeses(inicio, k).slice(0, 4), o = (porAno[a] ||= nuevo()), d = F.d[k];
    const v = { gastos: F.gas[k], comision: -F.com[k], fisica: F.recF[k], digital: F.recD[k] };
    v.imp = -tx * (v.gastos + v.comision + v.fisica + v.digital);
    for (const c in v) { o[c] += v[c]; o.vp[c] += v[c] * d; o.desc += v[c] * d; van[c] += v[c] * d; }
  }
  const despues = { gastos: F.vt.gas / F.dFin, comision: -F.vt.com / F.dFin, fisica: F.vt.recF / F.dFin, digital: F.vt.recD / F.dFin };
  despues.imp = -tx * (despues.gastos + despues.comision + despues.fisica + despues.digital);
  despues.vp = { gastos: F.vt.gas, comision: -F.vt.com, fisica: F.vt.recF, digital: F.vt.recD, imp: despues.imp * F.dFin, ct: 0 };
  despues.desc = Object.values(despues.vp).reduce((x, y) => x + y, 0);
  for (const c of ["gastos", "comision", "fisica", "digital", "imp"]) van[c] += despues.vp[c];
  // Costo de salida deducible (neto de impuesto) y capital de trabajo que se libera al cerrar (sin impuesto)
  const dk = F.d[Math.min(kt, n - 1)], aCierre = t.slice(0, 4), costoBruto = F.costo(t);
  const costo = costoBruto * (1 - tx) * dk, ctMM = finz().capitalTrabajo * B.parte;
  van.ct = ctMM * dk;
  if (porAno[aCierre]) { porAno[aCierre].ct += ctMM; porAno[aCierre].desc += ctMM * dk; porAno[aCierre].vp.ct += ctMM * dk; }
  const total = Object.values(van).reduce((x, y) => x + y, 0) - costo;
  const e = B.e;
  return { porAno, despues, van, costo, costoBruto, mesesSalida: costoBruto / Math.max(1e-9, B.arrMM), total, tasa: e.tasaSedePropia,
    physProb: F.fis, digProb: F.dig, lossProb: 1 - F.fis - F.dig, physFull: e.physFull, g: B.g, rA: F.rA, gTerminal: F.gC };
}
// VAN de cada escenario de una sede, por componente y en valor presente: mantenerla, mantenerla con mejora o cerrarla en t.
// Cerrar en t = comision y gastos de la sede hasta t + lo que recuperan otras sedes y el canal digital desde t - costo de salida.
function escenariosSede(s, receptoras, inicio, mejoradas, meses, persp = "TOTAL") {
  const B = baseCierre(s, receptoras, inicio, mejoradas, persp), F = flujosCierre(B), { n } = B;
  const pv = (arr, a, b) => { let x = 0; for (let k = a; k < b; k++) x += arr[k] * F.d[k]; return x; };
  const comT = pv(F.com, 0, n) + F.vt.com, gasT = pv(F.gas, 0, n) + F.vt.gas;
  const tx = finz().impuesto, ct = finz().capitalTrabajo * B.parte;
  const mantener = { com: comT, gas: -gasT, rec: 0, otro: 0, ct: 0 };
  const I = APP.mejora.inversion * B.parte, inv = I / (1 + F.r);
  const mejora = { com: comT * (1 + APP.mejora.venta), gas: -gasT, rec: 0, otro: -inv, ct: 0, escudo: escudoDepreciacion(I, F.rA) };
  const cerrar = (meses || []).map((t) => {
    const kt = Math.max(0, Math.min(n, difMeses(inicio, t))), dk = F.d[Math.min(kt, n - 1)];
    return { mes: t, com: pv(F.com, 0, kt), gas: -pv(F.gas, 0, kt), rec: pv(F.recF, kt, n) + pv(F.recD, kt, n) + F.vt.recF + F.vt.recD, otro: -F.costo(t) * dk, ct: ct * dk };
  });
  // Impuesto sobre el resultado (ingresos - gastos - costo de salida); la inversion se descuenta via depreciacion (escudo)
  for (const x of [mantener, mejora, ...cerrar]) x.imp = -tx * (x.com + x.gas + x.rec + (x === mejora ? 0 : x.otro)) + (x.escudo || 0);
  const van = (x) => x.com + x.gas + x.rec + x.otro + x.ct + x.imp;
  for (const x of [mantener, mejora, ...cerrar]) x.van = van(x);
  return { mantener, mejora, cerrar, tasa: B.e.tasaSedePropia, physProb: F.fis, digProb: F.dig, lossProb: 1 - F.fis - F.dig, g: B.g, rA: F.rA };
}
// Fin del plan: 10 anos desde el primer ano proyectado; despues, valor terminal
const ANOS_PLAN = 10;
function finPlan() {
  const anos = DASHBOARD_DATA?.anos_proy || [2027];
  return `${anos[0] + ANOS_PLAN - 1}-12`;
}
// Saturacion de las receptoras (idea de Ruben, medida con el plan): cada cierre, en orden de fecha, llena parte de la
// capacidad de sus receptoras (+25% de su venta); los cierres posteriores solo usan lo que queda. libroCapacidad registra
// cuanto absorbe cada receptora de cada cierre; conUso adjunta a una lista de receptoras lo ya absorbido hasta la fecha t.
function libroCapacidad(cal) {
  const ev = [], usado = {};
  for (const [id, k] of Object.entries(cal).sort((a, b) => (a[1].mes < b[1].mes ? -1 : a[1].mes > b[1].mes ? 1 : 0))) {
    const s = APP._porId?.[id], loc = DASHBOARD_DATA.locales[id];
    if (!s || !loc) continue;
    const rec = DASHBOARD_DATA.huff_ids.filter((j) => j !== id && !(cal[j] && cal[j].mes <= k.mes));
    rec.usado = { ...usado };
    const e = economiaCierre(s, loc, id, rec), vI = s.venta_12m_real || 0;
    for (const [j, f] of Object.entries(e.absorcion || {})) { const v = f * vI; if (v > 0) { usado[j] = (usado[j] || 0) + v; ev.push({ mes: k.mes, id, j, v }); } }
  }
  return ev;
}
function conUso(rec, id, t, libro) {
  const u = {};
  for (const x of libro || []) if (x.id !== id && x.mes <= t) u[x.j] = (u[x.j] || 0) + x.v;
  rec.usado = u;
  return rec;
}
// Programa de migracion digital para sedes sin alternativa (escenario; meta 0 = sin programa). Meta ajustada por la dificultad
// digital de la comuna: x1,25 con dificultad 0, x1 con 50 y x0,75 con 100. Costo en millones por sede.
function programaDigital(s) {
  const f = finz(), meta = f.metaDigital ?? 0;
  if (!(meta > 0) || !sinAlternativa(s)) return null;
  const d = entornoDe(s)?.d ?? 50;
  return { meta: Math.min(0.95, meta * (1.25 - 0.5 * d / 100)), costo: f.costoPrograma ?? 0 };
}
// Retencion total con la que el VAN de cerrar en t es cero (lineal en la retencion); 0 si conviene cerrar sin retener a nadie
function retencionNecesaria(B, t) {
  const pb = pBase(B), v0 = vanDesdeBase(B, [t], { ...pb, R: 0 }).opciones[0].van, v1 = vanDesdeBase(B, [t], { ...pb, R: 1 }).opciones[0].van;
  return v0 >= 0 ? 0 : v1 <= 0 ? 1 : -v0 / (v1 - v0);
}
const sinGastos = (s) => !(((s.arriendo_mensual_clp || 0) * 12 + (s.otros_fijos_anual_clp || 0)) > 0);
// Ultimo mes de los cierres firmes: los primeros anosFirmes anos del plan (por defecto 2027 a 2029)
const limiteFirmes = () => `${(DASHBOARD_DATA?.anos_proy || [2027])[0] + (finz().anosFirmes ?? 3) - 1}-12`;
// Disparador de un cierre en el mes t: la venta anual (12 meses desde t) con la que el VAN de cerrar en t es cero. El VAN es
// lineal en el nivel de venta: VAN(lambda) = v0 + (v1 - v0) lambda, con lambda = escala de toda la venta futura.
function disparadorCierre(B, t) {
  const pb = pBase(B), v1 = vanDesdeBase(B, [t], { ...pb, kv: 1 }).opciones[0].van, v0 = vanDesdeBase(B, [t], { ...pb, kv: 0 }).opciones[0].van;
  if (!(v0 > v1)) return null;
  const F = flujosCierre(B, pb), kt = Math.max(0, difMeses(B.inicio, t));
  // Venta de los 12 meses desde t (si el plan termina antes, se anualiza con los meses que quedan; si t cae fuera, el ultimo ano)
  const k0 = Math.max(0, Math.min(kt, B.n - 12)), k1 = Math.min(B.n, k0 + 12);
  let ventaT = 0; for (let k = k0; k < k1; k++) ventaT += F.com[k] / B.e.tasaSedePropia;
  ventaT *= 12 / Math.max(1, k1 - k0);
  const venta = (v0 / (v0 - v1)) * ventaT * 1e6, hoy = B.s.venta_12m_real || 0;
  return { venta, hoy, caida: hoy > 0 ? 1 - venta / hoy : null, mes: t, ventaProy: ventaT * 1e6 };
}
const textoDisparador = (d) => !d ? "" : `cerrar cuando su venta anual baje de $${pesos(d.venta / 1e6)}${d.hoy ? ` (hoy $${pesos(d.hoy / 1e6)}, ${d.caida > 0 ? `falta caer ${fmt.num(d.caida * 100, 0)}%` : "ya está bajo ese nivel"})` : ""}`;
// Grupos del plan, iguales en todas las pestanas
function gruposPlan() {
  const cal = calendarioCierres(), M = APP._calMemo.mantiene, v = Object.entries(cal);
  return {
    decididos: v.filter(([, k]) => k.tipo === "decidido"),
    firmes: v.filter(([, k]) => k.tipo === "propuesto" && k.firme),
    condicionados: v.filter(([, k]) => k.tipo === "propuesto" && !k.firme),
    seguimiento: Object.entries(M).filter(([, x]) => x.seguimiento),
    red: Object.entries(M).filter(([, x]) => !x.seguimiento && !x.sinDatos && !x.externaliza && !x.renegociada),
    sinDatos: Object.entries(M).filter(([, x]) => x.sinDatos),
    externalizadas: Object.entries(M).filter(([, x]) => x.externaliza),
    renegociadas: Object.entries(M).filter(([, x]) => x.renegociada),
  };
}
// Fecha de cierre con riesgo: entre las ventanas cuyo VAN es positivo en al menos probMin de los escenarios, la primera cuyo
// VAN esperado esta a menos del margen del maximo. null si ninguna ventana cumple (la sede queda en la red minima).
function decidirConRiesgo(B, opciones) {
  const mc = mcCierre(B, opciones.map((o) => o.mes)), ok = mc.filter((x) => x.prob >= probMin());
  if (!ok.length) return null;
  const max = ok.reduce((a, b) => (b.media > a.media ? b : a));
  return ok.find((x) => x.media >= max.media * (1 - (finz().tolerancia ?? 0))) || max;
}
function calendarioCierres() {
  const H = historia(), inicio = sumarMeses(H.corte, 1);
  const fin = finPlan();
  const clave = JSON.stringify([claveGrafo(), APP.tasaDescuentoCierre, APP.retencionDigitalCierre, APP.factorCostoOnline, APP.takeoutDigital,
    state.u0, state.lambda, state.currencyMode, state.inflationRate, APP.mejora, APP.finanzas, SIM.iteraciones, SIM.escalaMf, SIM.shockG, SIM.spreadCostos,
    APP.pesosScore, APP.umbralesScore]);
  if (APP._calMemo?.est === APP.est && APP._calMemo.clave === clave) return APP._calMemo.cal;
  const cal = {}, fisicas = APP.est.sedes.filter((s) => s.grupo !== "DIGITAL" && s.lat != null && s.lon != null);
  // Decididos por la gerencia: su fecha, sin evaluar
  for (const s of fisicas) if (s.cierre_decidido) {
    const venc = mes7(s.vencimiento_contrato), mes = mes7(s.fecha_cierre_decidida) || venc || inicio;
    cal[s.sede_id] = { mes: mes < inicio ? inicio : mes, tipo: "decidido", cat: categoriaDe(s), avisar: null, van: null };
  }
  // El resto cierra solo si el VAN del cierre es positivo con probabilidad probMin (decidirConRiesgo); si no, se
  // mantiene (red minima). Las receptoras de la recaptura son las sedes abiertas en esa fecha, asi que se itera: la
  // primera pasada supone abiertas a todas las no decididas y sin mejoras
  const propuestas = fisicas.filter((s) => !s.cierre_decidido && !externaliza(s) && !renegociada(s));
  const externas = fisicas.filter((s) => !s.cierre_decidido && (externaliza(s) || renegociada(s)));
  const PF = portafolioBase();
  let mantiene = {};
  for (let pasada = 0; pasada < 3; pasada++) {
    const previo = Object.fromEntries(propuestas.map((s) => [s.sede_id, cal[s.sede_id]?.mes]));
    const mejoradas = new Set(Object.keys(mantiene).filter((id) => mantiene[id].mejora));
    const libro = libroCapacidad({ ...cal });   // absorcion de las receptoras segun las fechas de la pasada anterior
    const nuevo = {};
    for (const s of propuestas) {
      const id = s.sede_id, plan = sinAlternativa(s);
      const v = ventanasCierre(s, sumarMeses(inicio, plan ? mesesPlanDigital(s) : 0), fin);
      const cat = categoriaDe(s), avisar = (m) => (v.aviso > 0 ? sumarMeses(m, -v.aviso) : null);
      delete cal[id];
      if (!DASHBOARD_DATA.locales[id]) { nuevo[id] = { motivo: "sin proyección de demanda", van: null, vanMejora: null, mejora: false }; continue; }
      if (sinGastos(s)) { nuevo[id] = { motivo: "sin datos de gastos", van: null, vanMejora: null, mejora: false, sinDatos: true }; continue; }
      if (!v.meses.length) { nuevo[id] = { motivo: "su contrato no alcanza a terminar dentro del horizonte", van: null, vanMejora: null, mejora: false }; continue; }
      const t0 = previo[id] || fin;
      const receptoras = conUso((DASHBOARD_DATA.huff_ids || []).filter((j) => j !== id && !(cal[j] && cal[j].mes <= t0 && (cal[j].tipo === "decidido" || pasada > 0))), id, t0, libro);
      const B = baseCierre(s, receptoras, inicio, mejoradas), { opciones, vanMejora } = vanDesdeBase(B, v.meses);
      const mejor = opciones.reduce((a, b) => (b.van > a.van ? b : a));   // sin mejoras en el plan (efecto sin respaldo)
      // Cierra si en la simulacion el VAN es positivo en al menos probMin de los escenarios, en la primera fecha cuyo VAN
      // esperado esta a menos del margen del maximo (entre las fechas que cumplen esa probabilidad)
      const dec = mejor.van > 0 ? decidirConRiesgo(B, opciones) : null;
      // Segunda llave: el cierre solo entra al plan si el portafolio (score relativo y materialidad) lo pone en una
      // categoria de salida; si el portafolio la protege, la sede queda en seguimiento aunque su VAN sea positivo
      const protegida = dec && !CATEGORIAS_SALIDA.has(PF[id]?.categoria);
      if (dec && !protegida) cal[id] = { mes: dec.mes, tipo: "propuesto", cat, plan, avisar: avisar(dec.mes), van: opciones.find((o) => o.mes === dec.mes).van, mc: dec };
      else nuevo[id] = { motivo: protegida ? "protegida por el portafolio" : mejor.van > 0 ? "incierto" : "", van: mejor.van, vanMejora, mejora: false, protegida };
    }
    mantiene = nuevo;
  }
  // Externalizacion decidida por la gerencia: la sede sigue operando (con un tercero) y no entra al plan de cierres
  // y renegociacion ya hecha: la sede sigue y tampoco entra al plan
  for (const s of externas) mantiene[s.sede_id] = externaliza(s)
    ? { motivo: "externalización decidida", van: null, vanMejora: null, mejora: false, externaliza: true }
    : { motivo: "renegociación decidida", van: null, vanMejora: null, mejora: false, renegociada: true };
  // VAN final con las fechas definitivas de las demas sedes (las receptoras son las que siguen abiertas en esa fecha)
  const mejoradasFin = new Set(Object.keys(mantiene).filter((id) => mantiene[id].mejora));
  const libroFin = libroCapacidad(cal);
  const abiertasEn = (id, t) => conUso((DASHBOARD_DATA.huff_ids || []).filter((j) => j !== id && !(cal[j] && cal[j].mes <= t)), id, t, libroFin);
  for (const s of propuestas) {
    const id = s.sede_id, k = cal[id], x = mantiene[id];
    if (k?.tipo === "propuesto" && k.van != null) {
      const B = baseCierre(s, abiertasEn(id, k.mes), inicio, mejoradasFin);
      k.van = vanDesdeBase(B, [k.mes]).opciones[0].van; k.mc = mcCierre(B, [k.mes])[0];
    } else if (x && x.van != null) {
      const v = ventanasCierre(s, sumarMeses(inicio, sinAlternativa(s) ? mesesPlanDigital(s) : 0), fin);
      const B = baseCierre(s, abiertasEn(id, fin), inicio, mejoradasFin), r = vanDesdeBase(B, v.meses);
      const m = r.opciones.reduce((a, b) => (b.van > a.van ? b : a));
      x.van = m.van; x.mes = m.mes; x.vanMejora = r.vanMejora;
      if (m.van > 0) x.mc = mcCierre(B, [m.mes])[0];
    }
  }
  // Reparto del VAN de cada cierre (y de la mejora) entre los socios: lo que gana o pierde cada hipodromo
  for (const s of fisicas) {
    const id = s.sede_id, k = cal[id], x = mantiene[id], t = k?.mes || x?.mes;
    if (!t || !DASHBOARD_DATA.locales[id]) continue;
    const rec = abiertasEn(id, k ? k.mes : fin), dest = k || x;
    dest.reparto = Object.fromEntries(PERSPECTIVAS.map(([h]) => {
      const r = vanCierrePorMes(s, rec, [t], inicio, mejoradasFin, h);
      return [h, { cierre: r.opciones[0].van, mejora: r.vanMejora }];
    }));
  }
  // Firmes y condicionados: lo que cae en los primeros anos del plan se decide ahora; lo de despues (y las sedes de la red
  // minima cerca del umbral) queda en seguimiento con un disparador de venta que se revisa una vez al ano
  const limFirme = limiteFirmes();
  const disparador = (s, t) => disparadorCierre(baseCierre(s, abiertasEn(s.sede_id, t), inicio, mejoradasFin), t);
  for (const s of propuestas) {
    const id = s.sede_id, k = cal[id], x = mantiene[id];
    if (k?.tipo === "propuesto") { k.firme = k.mes <= limFirme; if (!k.firme) k.disparador = disparador(s, k.mes); }
    else if (x && x.van != null && x.mes && (x.protegida || (x.van > 0 && x.mc && x.mc.prob >= 0.5) || (x.van <= 0 && x.van > -(finz().margenSeguimiento ?? 25)))) { x.seguimiento = true; x.disparador = disparador(s, x.mes); }
    if (x && x.van != null && x.mes) { x.retNecesaria = retencionNecesaria(baseCierre(s, abiertasEn(id, x.mes), inicio, mejoradasFin), x.mes); x.sinAlternativa = sinAlternativa(s); }
  }
  APP._calMemo = { est: APP.est, clave, cal, mantiene, libro: libroCapacidad(cal) };
  return cal;
}
// Sedes que se mantienen (red minima): no conviene cerrarlas en el horizonte
function mantieneDe(id) {
  calendarioCierres();
  return APP._calMemo.mantiene[id] || null;
}
function lineaTiempo() {
  const H = historia(), cal = calendarioCierres();
  const fin = Object.values(cal).reduce((m, c) => (c.mes > m ? c.mes : m), finPlan());
  const meses = []; for (let m = H.inicio; m <= sumarMeses(fin, 1); m = sumarMeses(m, 1)) meses.push(m);
  return { H, cal, meses };
}
function actualizarLinea(LT) {
  const k = claveGrafo() + JSON.stringify(Object.entries(LT.cal).map(([id, c]) => [id, c.mes]).sort());
  if (APP.linea?.clave === k || APP._lineaPedida === k) return;
  APP._lineaPedida = k;
  $("tiempo-txt").textContent = "Calculando la red en cada fecha…";
  const aperturas = (APP.est.tiempos?.futuras || []).map((f) => f.fecha).filter((f) => f > LT.H.corte);
  const fechas = [...new Set([...Object.values(LT.cal).map((c) => c.mes), ...aperturas])].sort();
  const kmEn = (f) => { const m = metroEn(f); return m ? entradaRed(m).km : null; };
  const cortes = [{ fecha: LT.H.corte, cerradas: [] }, ...fechas.map((f) => ({ fecha: f, cerradas: Object.keys(LT.cal).filter((id) => LT.cal[id].mes <= f), km: kmEn(f) }))];
  pedirPython({ tipo: "linea", entrada: JSON.stringify({ ...entradaRed(), cortes }) }).then((r) => {
    if (APP._lineaPedida !== k) return;
    APP.linea = { ...JSON.parse(r.json), clave: k }; APP._lineaPedida = null;
    if (APP.tab === "red" && APP.vistaRed === "tiempo") pintarRed();
  }).catch((e) => { APP._lineaPedida = null; $("tiempo-txt").textContent = "No se pudo calcular la línea de tiempo: " + (e.texto || e.message || e); });
}
function corteEn(m) {
  const C = APP.linea?.cortes || []; let c = null;
  for (const x of C) if (x.fecha <= m) c = x;
  return c;
}
function pintarMapaTiempo(pts, ubic) {
  const LT = lineaTiempo(), { H, cal, meses } = LT;
  actualizarLinea(LT);
  if (APP.mesLinea == null || !meses.includes(APP.mesLinea)) APP.mesLinea = H.corte;
  const m = APP.mesLinea, pasado = m <= H.corte, idx = meses.indexOf(m);
  pintarBarraTiempo(LT, m);
  const cerradasHist = (APP.est.sedes_cerradas || []).filter((s) => s.lat != null && s.lon != null);
  const punto = (ll, op, tip, id) => {
    const mk = L.circleMarker(ll, op).bindTooltip(tip);
    if (id) mk.on("click", () => { APP.sedeSel = id; pintarRed(); });
    mk.addTo(capa);
  };
  const cerradoTip = (nombre, desde) => `<b>${esc(nombreLindo(nombre))}</b><br>Cerró en ${nombreMes(desde)}`;
  const reciente = (desde) => difMeses(desde, m) < MESES_VISIBLE_CERRADA;
  const hueco = { radius: 3, weight: 1, color: "#94A3B8", fillColor: "#fff", fillOpacity: 0.8, opacity: 0.7 };
  if (pasado) {
    // Conexiones de la red actual entre las sedes que operaban ese mes (y los hipodromos activos)
    const opera = (id) => esHip(id) ? hipActivo(id) : !!(H.primero[id] && H.primero[id] <= m && H.ultimo[id] >= m);
    for (const [a, b] of APP.grafo?.aristas || []) {
      const pa = ubic(a), pb = ubic(b); if (!pa || !pb || !opera(a) || !opera(b)) continue;
      dibujarArista(a, b, pa, pb, { resalta: APP.sedeSel === a || APP.sedeSel === b, opacidad: 0.5 });
    }
    // Ventas reales del mes: tamaño = venta; las que dejaron de vender, huecas
    const vm = H.venta[m] || {};
    let abiertas = 0, total = 0;
    for (const s of [...pts, ...cerradasHist]) {
      const id = s.sede_id, ini = H.primero[id], ult = H.ultimo[id];
      if (!ini || ini > m) continue;
      if (ult < m) { if (reciente(sumarMeses(ult, 1))) punto([s.lat, s.lon], hueco, cerradoTip(s.nombre, sumarMeses(ult, 1))); continue; }
      const v = vm[id] || 0; abiertas++; total += v;
      punto([s.lat, s.lon], { radius: 3 + 6 * Math.sqrt(v / H.maxV), weight: id === APP.sedeSel ? 3 : 1, color: id === APP.sedeSel ? "#0F1B2D" : bordeSede(id), fillColor: rgb(gestionDe(id).pleno), fillOpacity: 0.85 },
        `<b>${esc(nombreLindo(s.nombre))}</b><br>${v > 0 ? `Venta de ${nombreMes(m)}: ${fmt.clp(v)}` : `Sin ventas en ${nombreMes(m)}`}`, APP._porId[id] ? id : null);
    }
    const cerro = Object.keys(H.ultimo).filter((id) => H.ultimo[id] < m && H.ultimo[id] < H.corte).length;
    $("tiempo-txt").innerHTML = `Todo Chile: <b>${abiertas} sedes operando</b> · ${total > 0 ? `venta del mes ${fmt.clp(total)}` : "sin ventas registradas ese mes"}${cerro ? ` · ${cerro} cerradas desde ${nombreMes(H.inicio)}` : ""}`;
    APP._lineaEstado = { pasado: true, abiertas, total };
    return;
  }
  // Futuro: red que queda abierta y su rol en ese momento
  const c = corteEn(m), R = c?.roles || {};
  const abierta = (id) => esHip(id) ? hipActivo(id) : !(cal[id] && cal[id].mes <= m);
  for (const [a, b] of c?.aristas || APP.linea?.aristas || []) {
    const pa = ubic(a), pb = ubic(b); if (!pa || !pb || !abierta(a) || !abierta(b)) continue;
    const resalta = APP.sedeSel === a || APP.sedeSel === b;
    dibujarArista(a, b, pa, pb, { resalta, opacidad: 0.5 });
  }
  for (const s of cerradasHist) if (H.ultimo[s.sede_id] && reciente(sumarMeses(H.ultimo[s.sede_id], 1))) punto([s.lat, s.lon], { ...hueco, opacity: 0.4, fillOpacity: 0.4 }, cerradoTip(s.nombre, sumarMeses(H.ultimo[s.sede_id], 1)));
  const maxV = Math.max(...pts.map((s) => s.venta_12m_real || 0), 1);
  const esteMes = [];
  for (const s of pts) {
    const id = s.sede_id, k = cal[id], esSel = id === APP.sedeSel, etapa = k ? (k.tipo === "decidido" ? "cierre decidido" : `propuesta · ${textoVan(k)}`) : "";
    if (k && k.mes <= m) {
      const ahora = k.mes === m; if (ahora) esteMes.push(id);
      if (!ahora && !reciente(k.mes) && !esSel) continue;
      punto([s.lat, s.lon], ahora ? { radius: 7, weight: 2.5, color: "#F15A24", fillColor: "#fff", fillOpacity: 0.9 } : { ...hueco, color: esSel ? "#0F1B2D" : hueco.color },
        `<b>${esc(nombreLindo(s.nombre))}</b><br>${ahora ? "Cierra este mes" : "Cerrada desde " + nombreMes(k.mes)} (${etapa})`, id);
      continue;
    }
    const rr = R[id], rol = rr ? rr[0] : null;
    punto([s.lat, s.lon], { radius: 3.5 + 5.5 * Math.sqrt((s.venta_12m_real || 0) / maxV), weight: esSel ? 3 : rol === "CRITICA" ? 2.5 : 1, color: esSel ? "#0F1B2D" : rol === "CRITICA" ? "#2E3192" : bordeSede(id), fillColor: colorSalud(id, m), fillOpacity: 0.95 },
      `<b>${esc(nombreLindo(s.nombre))}</b><br>${rol ? `${ROLES[rol]?.nombre || esc(rol)}${rr[1] > 1 ? ` (${rr[1]})` : ""}<br>` : ""}${k ? `Cierra en ${nombreMes(k.mes)} (${etapa})` : mantieneDe(id) ? `Red mínima${mantieneDe(id).mejora ? ", mejorada" : ""}` : ""}`, id);
  }
  const quedan = pts.filter((s) => !(cal[s.sede_id] && cal[s.sede_id].mes <= m)).length;
  const sin = Object.entries(R).filter(([id, x]) => x[0] === "SIN RESPALDO" && abierta(id) && APP._porId[id]).length;
  $("tiempo-txt").innerHTML = `Todo Chile: <b>${quedan} sedes abiertas</b>${c ? ` · ${sin} sin alternativa` : ""}`
    + (esteMes.length ? ` · <b style="color:#C2410C">cierra${esteMes.length > 1 ? "n" : ""} este mes:</b> ${esteMes.map((id) => esc(nombreLindo(nombreNodo(id)))).join(", ")}` : "");
  APP._lineaEstado = { pasado: false, corte: c };
}
// Sedes abiertas en cada mes: con venta en el pasado, segun el calendario despues
function serieAbiertas(LT) {
  const k = LT.meses.length + JSON.stringify(LT.cal);
  if (APP._serie?.k === k && APP._serie.est === APP.est) return APP._serie.v;
  const { H, cal, meses } = LT, ids = Object.keys(H.primero), vig = Object.keys(cal);
  const v = meses.map((m) => (m <= H.corte ? ids.filter((id) => H.primero[id] <= m && H.ultimo[id] >= m).length : vig.filter((id) => cal[id].mes > m).length));
  APP._serie = { k, est: APP.est, v };
  return v;
}
function moverLinea(m) {
  if (m === APP.mesLinea) return;
  APP.mesLinea = m; pintarRed();
}
const VELOCIDADES = { lenta: 900, normal: 500, rápida: 200 };   // ms por mes; los meses con cierres duran el triple
function alternarPlay() {
  if (APP._play) { clearTimeout(APP._play); APP._play = null; return pintarRed(); }
  const { meses } = lineaTiempo();
  if (meses.indexOf(APP.mesLinea) >= meses.length - 1) APP.mesLinea = meses[0];
  const paso = () => {
    const LT = lineaTiempo(), M = LT.meses, i = M.indexOf(APP.mesLinea);
    if (APP.tab !== "red" || APP.vistaRed !== "tiempo" || i >= M.length - 1) { APP._play = null; return pintarRed(); }
    moverLinea(M[i + 1]);
    const conCierres = Object.values(LT.cal).some((k) => k.mes === M[i + 1]);
    APP._play = setTimeout(paso, (VELOCIDADES[APP.velLinea] || VELOCIDADES.normal) * (conCierres ? 3 : 1));
  };
  APP._play = setTimeout(paso, 1);
  pintarRed();
}
function pintarBarraTiempo(LT, m) {
  const { H, cal, meses } = LT, n = meses.length, pasado = m <= H.corte;
  const x = (mes) => (meses.indexOf(mes) / Math.max(1, n - 1)) * 100, iHoy = meses.indexOf(H.corte);
  $("tiempo-lbl").textContent = nombreMes(m).replace(/^./, (c) => c.toUpperCase());
  $("tiempo-sub").innerHTML = pasado ? `<span class="tl-chip real">Datos reales</span>` : `<span class="tl-chip plan">Plan de cierres</span>`;
  $("tiempo-play").innerHTML = APP._play ? `<svg viewBox="0 0 14 14"><rect x="2" y="1" width="3.5" height="12" rx="1"/><rect x="8.5" y="1" width="3.5" height="12" rx="1"/></svg>`
    : `<svg viewBox="0 0 14 14"><path d="M3 1.2v11.6c0 .6.7 1 1.2.6l8.6-5.8c.4-.3.4-1 0-1.3L4.2.6C3.7.3 3 .6 3 1.2z"/></svg>`;
  $("tiempo-play").title = APP._play ? "Pausar" : "Reproducir";
  $("tiempo-play").onclick = alternarPlay;
  const vel = APP.velLinea in VELOCIDADES ? APP.velLinea : "normal", vs = Object.keys(VELOCIDADES);
  $("tiempo-vel").textContent = `Velocidad ${vel}`;
  $("tiempo-vel").onclick = () => { APP.velLinea = vs[(vs.indexOf(vel) + 1) % vs.length]; pintarBarraTiempo(LT, APP.mesLinea); };
  // Curva: sedes abiertas (escala 0 - maximo); real en verde azulado, plan en gris punteado
  const v = serieAbiertas(LT), top = Math.max(1, ...v), X = (i) => (i / Math.max(1, n - 1)) * 1000, Y = (c) => 100 - (c / top) * 92;
  const tramo = (a, b) => v.slice(a, b + 1).map((c, k) => `${k ? "L" : "M"}${X(a + k).toFixed(1)},${Y(c).toFixed(1)}`).join("");
  const area = (a, b) => tramo(a, b) + `L${X(b)},100L${X(a)},100Z`;
  const ny = iHoy < 0 ? n - 1 : iHoy;
  let html = `<svg viewBox="0 0 1000 100" preserveAspectRatio="none">
    <rect x="${X(ny)}" y="0" width="${1000 - X(ny)}" height="100" fill="#F8FAFC"/>
    <path d="${area(0, ny)}" fill="${COLOR_PASADO}" fill-opacity=".14"/>
    <path d="${tramo(0, ny)}" fill="none" stroke="${COLOR_PASADO}" stroke-width="2" vector-effect="non-scaling-stroke"/>
    ${ny < n - 1 ? `<path d="${area(ny, n - 1)}" fill="#64748B" fill-opacity=".08"/>
    <path d="${tramo(ny, n - 1)}" fill="none" stroke="#64748B" stroke-width="2" stroke-dasharray="5 4" vector-effect="non-scaling-stroke"/>` : ""}
    <line x1="0" x2="1000" y1="100" y2="100" stroke="#CBD5E1" vector-effect="non-scaling-stroke"/>
  </svg>`;
  html += `<span class="tl-zona" style="left:0;color:${COLOR_PASADO}">Real</span>`;
  if (ny < n - 1) html += `<span class="tl-zona" style="right:0;color:#64748B">Plan</span><div class="tl-hoy" style="left:${x(H.corte)}%"><span>Hoy</span></div>`;
  for (const mes of meses) if (mes.endsWith("-01")) html += `<span class="tl-anio" style="left:${x(mes)}%">${mes.slice(0, 4)}</span>`;
  // Cierres: un punto por mes (lleno = decidido, hueco = propuesto, rojo = el mes que se ve)
  const porMes = {};
  for (const [id, k] of Object.entries(cal)) (porMes[k.mes] = porMes[k.mes] || []).push([id, k]);
  for (const [mes, l] of Object.entries(porMes)) {
    const dec = l.some(([, k]) => k.tipo === "decidido");
    html += `<span class="tl-cierre ${mes === m ? "ahora" : dec ? "decidido" : "propuesto"}" style="left:${x(mes)}%" title="${nombreMes(mes)}: ${esc(l.map(([id]) => nombreLindo(nombreNodo(id))).join(", "))}"></span>`;
  }
  html += `<div class="tl-cursor" style="left:${x(m)}%"></div>`;
  const P = $("tiempo-pista");
  P.innerHTML = html;
  if (!P._listo) {
    P._listo = true;
    const desde = (e) => { const r = P.getBoundingClientRect(), M = lineaTiempo().meses; return M[Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * (M.length - 1))]; };
    P.onpointerdown = (e) => { P.setPointerCapture(e.pointerId); P._arrastre = true; moverLinea(desde(e)); };
    P.onpointermove = (e) => { if (P._arrastre) moverLinea(desde(e)); };
    P.onpointerup = P.onpointercancel = () => { P._arrastre = false; };
    P.onkeydown = (e) => {
      const M = lineaTiempo().meses, i = M.indexOf(APP.mesLinea), d = { ArrowLeft: -1, ArrowRight: 1, PageDown: -12, PageUp: 12 }[e.key];
      if (d) { e.preventDefault(); moverLinea(M[Math.min(M.length - 1, Math.max(0, i + d))]); }
      else if (e.key === " ") { e.preventDefault(); alternarPlay(); }
    };
  }
}
function leyendaTiempo() {
  if (APP._lineaEstado?.pasado)
    return leyendaGestion(false) + `<span>Tamaño = venta del mes</span><span><i style="background:#fff;border:1px solid #94A3B8"></i>Cerró hace menos de un año</span>`;
  return leyendaGestion(true)
    + `<span title="${esc(ROLES.CRITICA.txt)}"><i style="background:#fff;border:2.5px solid #2E3192"></i>Otras dependen de ella</span>`
    + `<span><i style="background:#fff;border:2px solid #F15A24"></i>Cierra este mes</span><span><i style="background:#fff;border:1px solid #94A3B8"></i>Cerró hace menos de un año</span>`;
}
function pintarResumenTiempo() {
  const { H, cal } = lineaTiempo(), m = APP.mesLinea || H.corte, z = APP.zonaMapa;
  const enZona = (id) => z === "TODAS" || zonaDe(APP._porId[id] || {}) === z;
  $("red-resumen-tit").textContent = `Red en ${nombreMes(m)}`;
  $("red-cambios-tit").textContent = "Calendario de cierres";
  const c = corteEn(m);
  if (m <= H.corte || !c) {
    $("red-resumen").innerHTML = `<p class="text-xs text-slate-600">${m <= H.corte ? "Ventas reales del mes. Mueve la barra hacia la derecha para ver el calendario de cierres." : "Calculando…"}</p>`;
  } else {
    const filas = (c.resumen || []).filter((r) => z === "TODAS" || r.zona === z);
    $("red-resumen").innerHTML = !filas.length ? `<p class="text-xs text-slate-600">Ya no quedan sedes físicas${z === "TODAS" ? "" : " en esta zona"}.</p>` : kpisRed(sumaZonas(filas), null, z);
  }
  // Calendario por año (zona del mapa): una fila por año; el año del cursor se abre con los nombres
  const porAno = {}, G = gruposPlan();
  for (const [id, k] of [...G.decididos, ...G.firmes]) if (enZona(id)) (porAno[k.mes.slice(0, 4)] = porAno[k.mes.slice(0, 4)] || []).push([id, k]);
  const max = Math.max(1, ...Object.values(porAno).map((l) => l.length)), anoSel = m.slice(0, 4);
  $("red-cambios").innerHTML = `<div class="space-y-1">${Object.keys(porAno).sort().map((a) => {
    const l = porAno[a].sort((x, y) => (x[1].mes < y[1].mes ? -1 : x[1].mes > y[1].mes ? 1 : 0)), abierto = a === anoSel;
    const fila = `<button class="tl-ano ${abierto ? "on" : ""}" data-ano="${a}"><span class="w-10 text-left font-semibold">${a}</span>
      <span class="flex-1 h-1.5 rounded-full bg-slate-100"><span class="block h-1.5 rounded-full ${abierto ? "bg-green-800" : "bg-slate-300"}" style="width:${(l.length / max) * 100}%"></span></span>
      <span class="w-20 text-right">${l.length} cierre${l.length === 1 ? "" : "s"}</span></button>`;
    if (!abierto) return fila;
    return fila + `<ul class="tl-lista">${l.map(([id, k]) => `<li class="${k.mes <= m ? "hecho" : ""}"><a href="#" data-ir="${id}">${esc(nombreLindo(nombreNodo(id)))}</a>
      <span>${MESES_NOM[+k.mes.slice(5, 7) - 1]}${k.tipo === "decidido" ? " · decidido" : ""}</span></li>`).join("")}</ul>`;
  }).join("")}</div>
  ${(() => { const S = [...G.condicionados, ...G.seguimiento].filter(([id]) => enZona(id)).sort((a, b) => (a[1].mes < b[1].mes ? -1 : 1)); return S.length ? `<details class="mt-2 pt-2 border-t border-slate-100" ${APP._verSeg !== false ? "open" : ""} id="red-seguimiento">
    <summary class="tl-ano cursor-pointer"><span class="flex-1 text-left font-semibold">En seguimiento (desde ${+limiteFirmes().slice(0, 4) + 1})</span><span class="w-20 text-right">${S.length} sede${S.length === 1 ? "" : "s"}</span></summary>
    <table class="w-full text-xs mt-1"><thead><tr class="text-slate-500"><th class="text-left font-semibold py-1">Sede</th><th class="text-right font-semibold py-1">Cerrar si su venta anual baja de</th><th class="text-right font-semibold py-1">Falta caer</th><th class="text-right font-semibold py-1">Fecha estimada</th></tr></thead><tbody>
    ${S.map(([id, x]) => { const d = x.disparador; return `<tr class="border-t border-slate-100"><td class="py-1"><a href="#" data-sel="${id}" class="text-[#003058] hover:underline">${esc(nombreLindo(nombreNodo(id)))}</a></td>
      <td class="py-1 text-right tabular-nums">${d ? `$${pesos(d.venta / 1e6)}` : "-"}</td><td class="py-1 text-right tabular-nums">${d ? (d.caida > 0 ? `${fmt.num(d.caida * 100, 0)}%` : "ya está bajo") : "-"}</td>
      <td class="py-1 text-right">${x.tipo === "propuesto" ? nombreMes(x.mes) : "-"}</td></tr>`; }).join("")}</tbody></table></details>` : ""; })()}
  ${(() => { const M = G.red.filter(([id]) => enZona(id)); return M.length ? `<details class="mt-2 pt-2 border-t border-slate-100" ${APP._verMinima ? "open" : ""} id="red-minima">
    <summary class="tl-ano cursor-pointer"><span class="flex-1 text-left font-semibold">Red mínima: se mantienen</span><span class="w-20 text-right">${M.length} sede${M.length === 1 ? "" : "s"}</span></summary>
    <table class="w-full text-xs mt-1"><thead><tr class="text-slate-500"><th class="text-left font-semibold py-1">Sede</th><th class="text-right font-semibold py-1" title="Parte de sus clientes que habría que retener (en otras sedes o en el canal digital) para que cerrarla no destruya valor">Retención necesaria para cerrar</th><th class="text-right font-semibold py-1">Otra sede al alcance</th></tr></thead><tbody>
    ${M.sort((a, b) => (a[1].retNecesaria ?? 2) - (b[1].retNecesaria ?? 2)).map(([id, x]) => `<tr class="border-t border-slate-100"><td class="py-1"><a href="#" data-sel="${id}" class="text-[#003058] hover:underline">${esc(nombreLindo(nombreNodo(id)))}</a></td>
      <td class="py-1 text-right tabular-nums">${x.retNecesaria != null ? `${fmt.num(x.retNecesaria * 100, 0)}%` : "-"}</td><td class="py-1 text-right">${x.sinAlternativa ? "no" : "sí"}</td></tr>`).join("")}</tbody></table></details>` : ""; })()}
  ${G.sinDatos.filter(([id]) => enZona(id)).length ? `<p class="mt-2 pt-2 border-t border-slate-100 text-xs text-slate-600"><span class="font-semibold">Sin datos de gastos:</span> ${G.sinDatos.filter(([id]) => enZona(id)).map(([id]) => esc(nombreLindo(nombreNodo(id)))).join(", ")}</p>` : ""}
  ${G.externalizadas.filter(([id]) => enZona(id)).length ? `<p class="mt-2 pt-2 border-t border-slate-100 text-xs text-slate-600"><span class="font-semibold">Externalización decidida:</span> ${G.externalizadas.filter(([id]) => enZona(id)).map(([id]) => esc(nombreLindo(nombreNodo(id)))).join(", ")}</p>` : ""}
  ${G.renegociadas.filter(([id]) => enZona(id)).length ? `<p class="mt-2 pt-2 border-t border-slate-100 text-xs text-slate-600"><span class="font-semibold">Renegociación decidida:</span> ${G.renegociadas.filter(([id]) => enZona(id)).map(([id]) => esc(nombreLindo(nombreNodo(id)))).join(", ")}</p>` : ""}
  <details class="mt-2 text-[11px] text-slate-500"><summary class="cursor-pointer">Cómo se arma el plan</summary>
    <p class="mt-1">Decididos: en su fecha. El resto cierra si su VAN es positivo en al menos la probabilidad mínima de los escenarios simulados (pestaña Simulación VAN), en la primera fecha cuyo VAN esperado está a menos del margen del máximo. Si no, queda en la red mínima. Los cierres de los primeros años son firmes; los posteriores, y las sedes de la red mínima con VAN positivo en al menos la mitad de los escenarios o con VAN cercano a cero (dentro del margen de seguimiento), quedan en seguimiento: cierran cuando su venta anual baja del disparador, y se revisan una vez al año. Para cada sede de la red mínima se indica cuánto tendría que subir su venta para que una mejora con la inversión de referencia se pague. VAN después de impuesto, a 10 años más valor terminal. Hasta 2036 la venta de cada sede sigue su tendencia histórica (persistencia configurable); después, la caída se amortigua, salvo en los alrededores de la RM y en regiones, donde la población envejece sin recambio y la caída no se frena.</p>
    <div class="grid grid-cols-3 gap-2 mt-2">
      <label class="fld">Inversión de referencia MM$<input type="number" id="mej-inv" step="10" min="0" value="${APP.mejora.inversion}"></label>
      <label class="fld">Impuesto %<input type="number" id="fin-imp" step="0.5" min="0" max="60" value="${fmt.num(finz().impuesto * 100, 1).replace(",", ".")}"></label>
      <label class="fld">Capital de trabajo MM$<input type="number" id="fin-ct" step="5" min="0" value="${finz().capitalTrabajo}"></label>
      <label class="fld">Vida útil mejora (años)<input type="number" id="fin-vida" step="1" min="1" value="${finz().vidaUtil}"></label>
      <label class="fld">Alza real arriendo %<input type="number" id="fin-carr" step="0.5" value="${fmt.num(finz().crecArriendo * 100, 1).replace(",", ".")}"></label>
      <label class="fld">Alza real otros gastos %<input type="number" id="fin-cotr" step="0.5" value="${fmt.num(finz().crecOtros * 100, 1).replace(",", ".")}"></label>
      <label class="fld" title="Se cierra en la primera fecha cuyo VAN está a menos de este margen del máximo">Margen para adelantar cierres %<input type="number" id="fin-tol" step="1" min="0" max="50" value="${Math.round((finz().tolerancia ?? 0) * 100)}"></label>
      <label class="fld" title="Parte de los escenarios simulados en que el VAN del cierre debe ser positivo">Probabilidad mínima de VAN positivo %<input type="number" id="fin-prob" step="5" min="50" max="99" value="${Math.round(probMin() * 100)}"></label>
      <label class="fld" title="Escenario: meta de clientes que un programa activo lleva al canal digital en sedes sin otra sede al alcance, ajustada por la dificultad digital de la comuna. 0 = sin programa">Programa digital: meta de retención %<input type="number" id="fin-metadig" step="5" min="0" max="90" value="${Math.round((finz().metaDigital ?? 0) * 100)}"></label>
      <label class="fld" title="Costo del programa de migración digital por sede, se suma al costo de salida">Costo del programa por sede MM$<input type="number" id="fin-costoprog" step="5" min="0" value="${finz().costoPrograma ?? 0}"></label>
      <label class="fld" title="Sedes de la red mínima cuyo VAN de cierre está a menos de este monto bajo cero también quedan en seguimiento">Margen de seguimiento MM$<input type="number" id="fin-margenseg" step="5" min="0" value="${finz().margenSeguimiento ?? 25}"></label>
      <label class="fld" title="Los cierres que caen en estos primeros años del plan se deciden ahora; los posteriores quedan en seguimiento">Años de cierres firmes<input type="number" id="fin-firmes" step="1" min="1" max="10" value="${finz().anosFirmes ?? 3}"></label>
      <label class="fld" title="Cuánto de la tendencia de cada sede se mantiene de un año al siguiente hasta 2036. 100 = sigue la tendencia histórica">Persistencia de la tendencia %<input type="number" id="fin-amort" step="5" min="50" max="100" value="${Math.round(amortiguacion() * 100)}"></label>
    </div></details>`;
  $("red-cambios").querySelectorAll("[data-ano]").forEach((b) => (b.onclick = () => { const l = porAno[b.dataset.ano]; moverLinea(l.map(([, k]) => k.mes).sort()[0]); }));
  $("red-cambios").querySelectorAll("[data-ir]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); APP.sedeSel = a.dataset.ir; APP.mesLinea = cal[a.dataset.ir].mes; pintarRed(); }));
  $("red-cambios").querySelectorAll("[data-sel]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); APP.sedeSel = a.dataset.sel; pintarRed(); }));
  const mej = (id, k, f) => { const el = $(id); if (el) el.onchange = () => { APP.mejora = { ...APP.mejora, [k]: Math.max(0, +el.value || 0) * f }; pintarRed(); }; };
  if ($("red-minima")) $("red-minima").ontoggle = (e) => { APP._verMinima = e.target.open; };
  if ($("red-seguimiento")) $("red-seguimiento").querySelectorAll("[data-sel]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); APP.sedeSel = a.dataset.sel; pintarRed(); }));
  if ($("red-seguimiento")) $("red-seguimiento").ontoggle = (e) => { APP._verSeg = e.target.open; };
  const fz = (id, k, f) => { const el = $(id); if (el) el.onchange = () => { APP.finanzas = { ...finz(), [k]: Math.max(k === "vidaUtil" ? 1 : 0, +el.value || 0) * f }; pintarRed(); }; };
  fz("fin-imp", "impuesto", 0.01); fz("fin-firmes", "anosFirmes", 1); fz("fin-costoprog", "costoPrograma", 1); fz("fin-margenseg", "margenSeguimiento", 1); fz("fin-ct", "capitalTrabajo", 1); fz("fin-vida", "vidaUtil", 1);
  const fzr = (id, k) => { const el = $(id); if (el) el.onchange = () => { APP.finanzas = { ...finz(), [k]: (+el.value || 0) / 100 }; pintarRed(); }; };
  fzr("fin-carr", "crecArriendo"); fzr("fin-cotr", "crecOtros"); fzr("fin-tol", "tolerancia"); fzr("fin-prob", "probMin"); fzr("fin-amort", "amortiguacion"); fzr("fin-metadig", "metaDigital");
  mej("mej-inv", "inversion", 1);
}

function pintarFichaHipodromo(h) {
  const dentro = alcanceHipodromo(h), z = h.zona, activo = hipActivo(h.id);
  $("ficha").innerHTML = `<h2>${esc(h.nombre)}</h2><dl class="ficha">${[["Ciudad", h.ciudad], ["Zona", NOMBRE_ZONA[z] || "-"], ["En la red", activo ? "Activo: nodo fijo, no cierra" : "Desactivado: no es alternativa"],
      ["Sedes a su alcance", dentro.length]].map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v ?? "-")}</dd></div>`).join("")}</dl>
    <p class="text-xs text-slate-600 mt-1"><b>Sedes a ${textoAcceso(z)} o menos</b> (sus clientes pueden apostar en el hipódromo si la sede cierra): ${esc(dentro.map((d) => `${d.nombre} (${fmt.num(d.v, 0)} ${unidad(z)})`).join(", ") || "ninguna")}</p>
    <p class="text-[11px] text-slate-500 mt-1">Área en el mapa: hasta donde se llega desde el hipódromo en ${textoAcceso(z)}, con la misma regla que las sedes de su zona.</p>
    <div class="flex gap-2 mt-3 solo-edicion"><button class="btn-s" id="btn-hipo">${activo ? "Desactivar" : "Activar"} en la red</button></div>`;
  $("btn-hipo").onclick = () => alternarHipodromo(h.id);
}
// Dificultad de migrar al canal digital (0 a 100), según la comuna de la sede (Censo 2024, INE).
// Mitad: cuánto pesa el cliente típico (% de hombres de 50+). Mitad: años de estudio de los 50+ (a menos estudio, más difícil).
// Fundamento: en Chile el uso de internet de las personas mayores cae con la edad y sobre todo con la educación
// (Encuesta Calidad de Vida en la Vejez 2022 y CASEN 2022, Observatorio del Envejecimiento UC-Confuturo 2024).
// Cada parte es el percentil de la sede dentro de la red: 80 = más difícil que el 80% de las sedes.
const PESO_PERFIL = 0.5;   // [SUPUESTO] el resto (0,5) es escolaridad; con 3 cierres históricos no se puede estimar
function entornoDe(s) {
  if (s?.pct_hombres_50_mas == null || s?.escolaridad_50_mas == null) return null;
  if (APP._ent?.est !== APP.est) {
    const v = APP.est.sedes.filter((x) => x.grupo !== "DIGITAL" && x.pct_hombres_50_mas != null && x.escolaridad_50_mas != null);
    const orden = (k) => v.map((x) => x[k]).sort((a, b) => a - b);
    const prom = (k) => v.reduce((a, x) => a + x[k], 0) / v.length;
    APP._ent = { est: APP.est, H: orden("pct_hombres_50_mas"), E: orden("escolaridad_50_mas"), hRed: prom("pct_hombres_50_mas"), eRed: prom("escolaridad_50_mas") };
  }
  const A = APP._ent;
  const pct = (arr, x) => { const menos = arr.filter((y) => y < x).length, igual = arr.filter((y) => y === x).length; return (menos + igual / 2) / arr.length; };
  const pH = pct(A.H, s.pct_hombres_50_mas), pE = 1 - pct(A.E, s.escolaridad_50_mas);
  const d = Math.round(100 * (PESO_PERFIL * pH + (1 - PESO_PERFIL) * pE)), ptsH = Math.round(100 * PESO_PERFIL * pH);
  return { d, nivel: d >= 67 ? "Alta" : d <= 33 ? "Baja" : "Media", h: s.pct_hombres_50_mas, esc: s.escolaridad_50_mas, hRed: A.hRed, eRed: A.eRed, comuna: s.comuna_censo,
    ptsH, ptsE: d - ptsH, maxH: Math.round(100 * PESO_PERFIL), maxE: 100 - Math.round(100 * PESO_PERFIL) };
}
// Por qué una sede quedó sin etapa y dónde se corrige
function queRevisar(s) {
  const r = [];
  if (s.lat == null || s.lon == null) r.push("sin ubicación en el mapa");
  else { const a = alternativa(s); if (a && a.valor > umbralZona(zonaDe(s)) * 10) r.push("ubicación dudosa (muy lejos de las demás)"); }
  if (s.margen_base == null) r.push("sin margen: no aparece en la hoja anual o le falta el arriendo");
  return `<span class="text-[#C2410C]">${esc(r.join(" · ") || "-")}</span>`;
}
// Primera fecha en que una línea nueva le da a la sede una alternativa que hoy no tiene (dentro del umbral de su zona)
function alternativaFutura(s) {
  const z = zonaDe(s), modo = accesoZona(z).modo, red = APP.est.red, i = red.ids.indexOf(s.sede_id);
  if (i < 0 || !["metro", "rapido"].includes(modo)) return null;
  const U = umbralZona(z), hoy = matrizCosto()[i];
  for (const f of APP.est.tiempos?.futuras || []) {
    const M = matrizCosto(f.metro)[i];
    let mejor = null;
    red.ids.forEach((id, j) => { if (j !== i && M[j] <= U && hoy[j] > U && (!mejor || M[j] < mejor.v)) mejor = { id, v: M[j] }; });
    if (mejor) return { fecha: f.fecha, ...mejor };
  }
  return null;
}
function chipMigracion(s) {
  const e = entornoDe(s); if (!e) return "-";
  const col = { "Alta": "#C2410C", "Media": "#667085", "Baja": "#003058" }[e.nivel];
  return `<span class="chip" style="background:${col}14;color:${col};border-color:${col}40" title="${esc(e.comuna)}: ${fmt.pct(e.h)} hombres de 50+ (red ${fmt.pct(e.hRed)}), ${fmt.num(e.esc, 1)} años de estudio de los 50+ (red ${fmt.num(e.eRed, 1)})">${e.d} · ${e.nivel.toLowerCase()}</span> <span class="text-[11px] text-slate-500">${esc(e.comuna)}</span>`;
}
// VAN del cierre propuesto: positivo = conviene cerrar en esa fecha; negativo = cierra al final del horizonte (todas cierran)
// Reparto entre socios de un VAN (cierre o mejora): "Hipodromo Chile +a, Club Hipico -b · requiere acuerdo"
const UMBRAL_ACUERDO = 10;   // MM$: un socio que pierde menos que esto no cambia la conversacion
const requiereAcuerdo = (x, campo = "cierre") => { const v = PERSPECTIVAS.map(([h]) => x?.reparto?.[h]?.[campo] ?? 0); return v.some((a) => a > UMBRAL_ACUERDO) && v.some((a) => a < -UMBRAL_ACUERDO); };
const textoReparto = (x, campo = "cierre") => !x?.reparto ? "" :
  `${PERSPECTIVAS.map(([h, n]) => `${n} ${textoMM(x.reparto[h][campo])}`).join(", ")}${requiereAcuerdo(x, campo) ? " · requiere acuerdo" : ""}`;
const pesos = (mmv) => Math.round(Math.abs(mmv) * 1e6).toLocaleString("es-CL");   // millones -> pesos completos
const textoMM = (v) => `${v <= -0.5 ? "-" : ""}$${pesos(v)}`;
const textoVan = (k) => (k.van == null ? "sin proyección de demanda" : `VAN del cierre ${textoMM(k.van)}`);
const textoMantiene = (x) => x.van == null ? x.motivo
  : `${x.mejora ? "mejorada · " : ""}VAN de cerrarla ${textoMM(x.van)}${x.mejora ? ` · VAN de la mejora ${textoMM(x.vanMejora)}` : ""}`;
// A donde van los clientes si la sede cierra (en su fecha, o al final del horizonte si se mantiene): Huff + canal digital
function migracionDe(s, k) {
  const loc = DASHBOARD_DATA.locales[s.sede_id]; if (!loc) return null;
  const cal = calendarioCierres(), M = APP._calMemo.mantiene;
  const t = k ? k.mes : finPlan();
  const receptoras = conUso((DASHBOARD_DATA.huff_ids || []).filter((j) => j !== s.sede_id && !(cal[j] && cal[j].mes <= t)), s.sede_id, t, APP._calMemo.libro);
  const e = economiaCierre(s, loc, s.sede_id, receptoras, new Set(Object.keys(M).filter((id) => M[id].mejora)));
  const top = Object.entries(e.reparto).sort((a, b) => b[1] - a[1]).filter(([, p]) => p >= 0.01).slice(0, 3);
  return { fisica: e.physProb, digital: e.digProb, perdida: e.lossProb, top };
}
// Ficha de la sede = su plan de cierre: cuándo, qué avisar, adónde van sus clientes y qué cerrar antes
function pintarFicha() {
  const s = APP.est.sedes.find((x) => x.sede_id === APP.sedeSel);
  $("ficha").className = s || esHip(APP.sedeSel) ? "rounded-xl border border-slate-200 bg-slate-50 p-3" : "";
  if (esHip(APP.sedeSel)) { const h = hipPorId(APP.sedeSel); if (h) return pintarFichaHipodromo(h); }
  if (!s) { $("ficha").innerHTML = `<p class="text-[11px] text-slate-400">Clic en una sede o hipódromo del mapa para ver su plan de cierre.</p>`; return; }
  const r = APP.grafo?.hoy[s.sede_id] || rolDe(s.sede_id), red = APP.est.red, i = red.ids.indexOf(s.sede_id), C = matrizCosto(), z = zonaDe(s);
  const k = calendarioCierres()[s.sede_id];
  const [etiqueta, col] = s.cierre_decidido ? ["Cierre decidido", "#667085"] : mantieneDe(s.sede_id) ? ["Red mínima", "#003058"]
    : sinAlternativa(s) ? ["Sin alternativa", "#9D174D"] : ["Con alternativa", "#2E3192"];
  const linea = (lbl, txt, color) => `<div class="flex gap-3 py-1.5 border-t border-slate-200 first:border-0"><span class="w-24 shrink-0 text-[11px] text-slate-500 pt-px">${lbl}</span><span class="text-xs ${color || "text-slate-800"}">${txt}</span></div>`;
  const alts = (r?.alternativas || []).map((id) => ({ id, v: esHip(id) ? costoHip(hipPorId(id), i) : C[i]?.[red.ids.indexOf(id)] }));
  const clientes = alts.length
    ? `Pasan a <b>${esc(nombreLindo(nombreNodo(alts[0].id)))}</b>${esHip(alts[0].id) ? " (hipódromo)" : ""}, a ${fmt.num(alts[0].v, 0)} ${unidad(z)}${alts.length > 1 ? ` <span class="text-slate-500">(y ${alts.length - 1} más)</span>` : ""}`
    : `<b>Sin sede cerca:</b> migrar a sus clientes al canal digital antes de avisar`;
  const dep = (r?.dependen || []).filter((id) => !esHip(id));
  const filas = [
    linea("Cierre", k ? `<b>${nombreMes(k.mes)}</b> · ${k.tipo === "decidido" ? "decidido por la gerencia" : `propuesto, ${textoVan(k)}`}`
      : mantieneDe(s.sede_id) ? `<b>No cierra</b> · ${textoMantiene(mantieneDe(s.sede_id))}` : "Sin fecha"),
    k?.reparto || mantieneDe(s.sede_id)?.reparto ? linea(k ? "Para cada socio" : "Si cerrara", textoReparto(k || mantieneDe(s.sede_id))) : "",
    linea("Administra", nombreGestion(s).replace(/^el /, "")),
    k?.avisar ? linea("Avisar término", `antes de <b>${nombreMes(k.avisar)}</b>`) : "",
    (() => {
      const g = migracionDe(s, k); if (!g) return linea("Sus clientes", clientes, alts.length ? "" : "text-red-700");
      const e = entornoDe(s), seg = (p, c) => p > 0.005 ? `<span style="width:${p * 100}%;background:${c}"></span>` : "";
      const leyenda = (p, c, txt, tip = "") => `<span class="inline-flex items-center gap-1" ${tip ? `title="${esc(tip)}"` : ""}><i style="width:8px;height:8px;border-radius:2px;background:${c};display:inline-block"></i>${txt} <b>${fmt.pct(p)}</b></span>`;
      const tipDig = e ? `Dificultad de migrar ${e.d}/100. ${e.comuna}: ${fmt.pct(e.h)} hombres de 50+ (red ${fmt.pct(e.hRed)}), ${fmt.num(e.esc, 1)} años de estudio (red ${fmt.num(e.eRed, 1)})` : "";
      return linea(k ? "Sus clientes" : "Si cerrara", `<div class="flex h-2 w-full rounded-full overflow-hidden bg-slate-100 mb-1.5">${seg(g.fisica, "#003058")}${seg(g.digital, "#D99A00")}${seg(g.perdida, "#C0C8D0")}</div>
        <div class="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-600">${leyenda(g.fisica, "#003058", "otras sedes")}${leyenda(g.digital, "#D99A00", `digital${e ? ` (${e.nivel.toLowerCase()})` : ""}`, tipDig)}${leyenda(g.perdida, "#C0C8D0", "se pierden")}</div>
        ${g.top.length ? `<div class="text-[11px] text-slate-500 mt-1">${g.top.map(([id, p]) => `${esc(nombreLindo(nombreNodo(id)))} ${fmt.pct(p)}`).join(" · ")}</div>` : ""}`);
    })(),
    (() => {
      const e = entornoDe(s); if (!e) return "";
      const comp = (txt, val, red, pts, max, porque) => `<div class="grid grid-cols-[1fr_auto] gap-x-2 items-center mt-1">
        <span>${txt} <b>${val}</b> <span class="text-slate-500">(red ${red})</span></span><span class="text-right font-semibold">${pts}/${max}</span>
        <span class="h-1.5 rounded-full bg-slate-100 overflow-hidden"><span class="block h-1.5 rounded-full" style="width:${(pts / max) * 100}%;background:#D99A00"></span></span><span></span>
        <span class="col-span-2 text-[11px] text-slate-500">${porque}</span></div>`;
      const masH = e.h > e.hRed, masE = e.esc > e.eRed;
      return linea("Migrar a digital", `<b>${e.d}/100 · ${e.nivel.toLowerCase()}</b> <span class="text-slate-500">· ${esc(e.comuna)}, Censo 2024</span>`
        + comp("Hombres de 50+", fmt.pct(e.h), fmt.pct(e.hRed), e.ptsH, e.maxH, `${masH ? "Sobre" : "Bajo"} el promedio de la red: ${masH ? "sube" : "baja"} la dificultad.`)
        + comp("Estudio de los 50+", `${fmt.num(e.esc, 1)} años`, fmt.num(e.eRed, 1), e.ptsE, e.maxE, `${masE ? "Sobre" : "Bajo"} el promedio de la red: ${masE ? "baja" : "sube"} la dificultad.`)
        + `<div class="text-[11px] text-slate-500 mt-1">Más puntos, más difícil.</div>`);
    })(),
    (() => { const f = alternativaFutura(s); return f ? linea("Red futura", `Desde <b>${nombreMes(f.fecha)}</b>, con las líneas nuevas: alternativa <b>${esc(nombreLindo(nombreNodo(f.id)))}</b> a ${fmt.num(f.v, 0)} min`) : ""; })(),
    dep.length ? linea("Cerrar antes", `${dep.map((id) => esc(nombreLindo(nombreNodo(id)))).join(", ")} <span class="text-slate-500">(solo tienen a esta sede cerca)</span>`, "text-amber-800") : "",
  ].join("");
  $("ficha").innerHTML = `<div class="flex items-start justify-between gap-2 mb-1"><h2 class="!mb-0">${esc(nombreLindo(s.nombre))}</h2>
      <span class="chip shrink-0" style="background:${col}1A;color:${col};border-color:${col}55">${etiqueta}</span></div>
    <div>${filas}</div>
    <p class="text-[11px] text-slate-500 mt-1.5">Margen anual ${fmt.clp(s.margen_base)} · venta 12 meses ${fmt.clp(s.venta_12m_real)}${s.vencimiento_contrato ? ` · contrato vence ${fmt.fecha(s.vencimiento_contrato)}` : ""}</p>`;
}
function verEnDemanda(id) {
  if (!DASHBOARD_DATA.locales[id]) return;
  verEnCierreOptimo(id);
}

// =====================================================================
// Categorizacion: cuadrante margen x alternativa (en vivo) y calibracion de U0
// =====================================================================
// Todas las sedes fisicas cierran en el horizonte: la categoria define el orden, no si se cierra.
// Quedar sin alternativa no protege a una sede; solo pide migrar antes a sus clientes al canal digital.
const CATS = {
  "CIERRE EN CURSO":                 { color: "#667085", accion: "Cierre ya resuelto por la gerencia." },
  "CERRAR PRIMERO":                  { color: "#C2410C", accion: "Margen bajo el corte y sus clientes tienen otra sede cerca. Cerrar en la próxima ventana de aviso del contrato." },
  "CERRAR PRIMERO CON PLAN DIGITAL": { color: "#9D174D", accion: "Margen bajo el corte y sin otra sede cerca. Cerrar en la próxima ventana de aviso, migrando antes a sus clientes al canal digital." },
  "CERRAR DESPUÉS":                  { color: "#2E3192", accion: "Margen sobre el corte y otra sede cercana recibe a parte de sus clientes. Siguiente etapa." },
  "CERRAR AL FINAL":                 { color: "#003058", accion: "Margen sobre el corte y sin otra sede cerca: su cierre pierde la mayor parte de su venta. Última etapa, con migración digital previa." },
  "POR REVISAR":                 { color: "#667085", accion: "Le falta el margen o la ubicación para asignarle una etapa." },
};
const COLOR_CAT = Object.fromEntries(Object.entries(CATS).map(([k, v]) => [k, v.color]));
const ORDEN_CAT = Object.keys(CATS);
const ZONAS = { "SANTIAGO URBANO": 3, "ALREDEDORES RM": 8, "REGIONES": 15 };
const SANTIAGO_CENTRO = [-33.4489, -70.6693];
const mediana = (a) => { const b = a.filter((x) => x != null && !isNaN(x)).sort((x, y) => x - y); return b.length ? b[Math.floor((b.length - 1) / 2)] : null; };
const kmEntre = (a, b) => { const R = Math.PI / 180, x = (b[1] - a[1]) * R * Math.cos(((a[0] + b[0]) / 2) * R), y = (b[0] - a[0]) * R; return 6371 * Math.hypot(x, y); };

// Zona: la COMUNIDAD del cliente; si no es geografica (MINITRAK, BAM...), por ubicacion
function zonaDe(s) {
  if (s.grupo === "DIGITAL") return "DIGITAL";
  if (s.zona_red) return s.zona_red;     // calculada en Python con la misma regla
  const c = norm(s.zona_cliente || "");
  if (c.startsWith("SANTIAGO EXTERIOR")) return "ALREDEDORES RM";
  if (c.startsWith("SANTIAGO")) return "SANTIAGO URBANO";
  if (c === "ZONA SUR" || /^ZONA|REGION/.test(c)) return "REGIONES";
  if (s.lat == null) return "REGIONES";
  const d = kmEntre([s.lat, s.lon], SANTIAGO_CENTRO);
  return d <= 22 ? "SANTIAGO URBANO" : d <= 75 && s.lat > -34.3 && s.lat < -32.9 ? "ALREDEDORES RM" : "REGIONES";
}
function radioZona(z) { return (APP.radios && APP.radios[z]) || APP.est?.config?.radio_zona_km?.[z] || ZONAS[z] || 15; }

// Acceso a una sede alternativa: como llega el cliente (a pie, metro, auto) y en cuanto tiempo maximo.
// Sin tiempos de viaje (estado antiguo, mientras se calculan) se usa la distancia por calle.
const MODOS = { metro: "en metro o tren y a pie", pie: "a pie", auto: "en auto", rapido: "en el medio más rápido", km: "por calle" };
const ACCESO_DEF = { "SANTIAGO URBANO": { modo: "metro", umbral: 20 }, "ALREDEDORES RM": { modo: "auto", umbral: 15 }, "REGIONES": { modo: "auto", umbral: 20 } };
function accesoZona(z) {
  if (!APP.est?.tiempos) return { modo: "km", umbral: radioZona(z) };
  return (APP.acceso && APP.acceso[z]) || APP.est.config?.acceso_zona?.[z] || ACCESO_DEF[z] || { modo: "auto", umbral: 20 };
}
const unidad = (z) => (accesoZona(z).modo === "km" ? "km" : "min");
const umbralZona = (z) => +accesoZona(z).umbral;
const textoAcceso = (z) => `${fmt.num(umbralZona(z))} ${unidad(z)} ${MODOS[accesoZona(z).modo]}`;
// Matriz de costo entre sedes fisicas (min o km), cada par con el modo de su zona: misma regla que grafo.costo en Python
function matrizCosto(metroM = null) {
  const T0 = APP.est.tiempos, red = APP.est.red || { ids: [], km: [] };
  const T = metroM ? { ...T0, metro: metroM } : T0;
  const k = JSON.stringify([Object.keys(ACCESO_DEF).map(accesoZona), T0?.fuente]);
  if (!metroM && APP._costo?.k === k && APP._costo.est === APP.est) return APP._costo.M;
  const ids = red.ids, n = ids.length, zs = ids.map((id) => zonaDe(APP._porId[id] || {}));
  const M = ids.map(() => new Array(n).fill(9999));
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (zs[i] !== zs[j]) continue;
    const modo = accesoZona(zs[i]).modo;
    if (modo === "km") { M[i][j] = red.km[i][j]; continue; }
    const pie = T.pie[i][j] ?? 9999, auto = T.auto[i][j] ?? 9999;
    // Python da metro = mín(rieles, caminar en línea recta): si es solo la caminata estimada, vale la caminata real
    const m0 = T.metro[i][j] ?? 9999, soloCaminar = T.pie_est && Math.abs(m0 - (T.pie_est[i][j] ?? -1)) < 0.05;
    const metro = Math.min(soloCaminar ? 9999 : m0, pie);
    M[i][j] = modo === "pie" ? pie : modo === "metro" ? metro : modo === "auto" ? auto : Math.min(pie, metro, auto);
  }
  if (!metroM) APP._costo = { k, M, est: APP.est };
  return M;
}

// Cobertura: sede alternativa mas accesible en la misma zona (operando y sin cierre en curso)
function alternativa(s) {
  if (APP._alt && APP._alt.has(s.sede_id)) return APP._alt.get(s.sede_id);
  const red = APP.est.red || { ids: [], km: [] }, i = red.ids.indexOf(s.sede_id), C = matrizCosto();
  let mejor = null;
  if (i >= 0) {
    const z = zonaDe(s), porId = APP._porId;
    red.ids.forEach((id, j) => {
      const o = porId[id];
      if (j === i || !o || o.cierre_decidido || zonaDe(o) !== z || C[i][j] >= 9999) return;
      if (!mejor || C[i][j] < mejor.valor) mejor = { id, nombre: o.nombre, valor: C[i][j], km: red.km[i][j] };
    });
    for (const h of hipActivos()) {   // un hipodromo activo tambien recibe a los clientes (y no cierra)
      const v = costoHip(h, i);
      if (v < 9999 && (!mejor || v < mejor.valor)) mejor = { id: h.id, nombre: h.nombre, valor: v, km: kmEntre([h.lat, h.lon], [s.lat, s.lon]) * (APP.est.config?.factor_ruta || 1.3), hip: true };
    }
  }
  APP._alt.set(s.sede_id, mejor);
  return mejor;
}
// Corte de margen: fijo si se ingresa; si no, la mediana de la zona (todas cierran: el corte solo ordena, mitad antes y mitad después)
function umbralMargen(z = APP.zona) {
  if (APP.umbralMargen != null) return APP.umbralMargen;
  APP._medMargen = APP._medMargen?.est === APP.est ? APP._medMargen : { est: APP.est };
  if (!(z in APP._medMargen)) APP._medMargen[z] = mediana(APP.est.sedes.filter((s) => s.grupo !== "DIGITAL" && s.margen_base != null && zonaDe(s) === z).map((s) => s.margen_base)) ?? 0;
  return APP._medMargen[z];
}
function categoriaDe(s) {
  if (s.cierre_decidido) return "CIERRE EN CURSO";
  if (s.margen_base == null || s.lat == null) return "POR REVISAR";
  const a = alternativa(s), cubre = a && a.valor <= umbralZona(zonaDe(s)), positivo = s.margen_base >= umbralMargen(zonaDe(s));
  return positivo ? (cubre ? "CERRAR DESPUÉS" : "CERRAR AL FINAL") : (cubre ? "CERRAR PRIMERO" : "CERRAR PRIMERO CON PLAN DIGITAL");
}
function prepararCategorias() {
  APP._porId = Object.fromEntries(APP.est.sedes.map((s) => [s.sede_id, s]));
  APP._alt = new Map();
}


// =====================================================================
// PESTAÑA: ESTRATEGIA Y PORTAFOLIO MULTICRITERIO (MCKINSEY / BCG)
// =====================================================================

function setEscenarioScore(escenario) {
  if (escenario === "base") {
    APP.pesosScore = { vol: 0.35, efic: 0.40, tend: 0.25 };
  } else if (escenario === "efic") {
    APP.pesosScore = { vol: 0.20, efic: 0.60, tend: 0.20 };
  } else if (escenario === "vol") {
    APP.pesosScore = { vol: 0.60, efic: 0.25, tend: 0.15 };
  } else if (escenario === "tend") {
    APP.pesosScore = { vol: 0.25, efic: 0.30, tend: 0.45 };
  }

  $("sliderPesoVolumen").value = Math.round(APP.pesosScore.vol * 100);
  $("sliderPesoEficiencia").value = Math.round(APP.pesosScore.efic * 100);
  $("sliderPesoTendencia").value = Math.round(APP.pesosScore.tend * 100);
  $("valPesoVolumen").textContent = Math.round(APP.pesosScore.vol * 100) + "%";
  $("valPesoEficiencia").textContent = Math.round(APP.pesosScore.efic * 100) + "%";
  $("valPesoTendencia").textContent = Math.round(APP.pesosScore.tend * 100) + "%";

  ["base", "efic", "vol", "tend"].forEach(k => {
    const btn = $("btnEsc" + k.charAt(0).toUpperCase() + k.slice(1));
    if (btn) btn.classList.toggle("active-pill", k === escenario);
  });

  pintarEstrategiaPortafolio();
}

function onPesoScoreChange() {
  const v = +$("sliderPesoVolumen").value;
  const e = +$("sliderPesoEficiencia").value;
  const t = +$("sliderPesoTendencia").value;
  const tot = v + e + t;

  $("valPesoVolumen").textContent = v + "%";
  $("valPesoEficiencia").textContent = e + "%";
  $("valPesoTendencia").textContent = t + "%";

  APP.pesosScore = { vol: v / tot, efic: e / tot, tend: t / tot };
  $("infoSumaPesos").textContent = `Suma de pesos: ${tot}% (Normalizado: ${Math.round(APP.pesosScore.vol * 100)}% / ${Math.round(APP.pesosScore.efic * 100)}% / ${Math.round(APP.pesosScore.tend * 100)}%)`;

  ["base", "efic", "vol", "tend"].forEach(k => {
    const btn = $("btnEsc" + k.charAt(0).toUpperCase() + k.slice(1));
    if (btn) btn.classList.remove("active-pill");
  });

  pintarEstrategiaPortafolio();
}

function onUmbralesScoreChange() {
  const alto = +$("inpCorteAlto").value || 65;
  const bajo = +$("inpCorteBajo").value || 45;
  APP.umbralesScore.alto = alto;
  APP.umbralesScore.bajo = bajo;
  pintarEstrategiaPortafolio();
}

function filtrarArquetipo(arq) {
  if (APP.filtroArquetipoActivo === arq) {
    APP.filtroArquetipoActivo = null;
  } else {
    APP.filtroArquetipoActivo = arq;
  }
  pintarEstrategiaPortafolio();
}

function filtrarTablaPortafolio() {
  APP.filtroTextoPortafolio = ($("inpBuscarPortafolio")?.value || "").toLowerCase().trim();
  renderTablaPortafolio(calcularPortafolioMCDA());
}

function limpiarFiltrosPortafolio() {
  APP.filtroArquetipoActivo = null;
  APP.filtroTextoPortafolio = "";
  if ($("inpBuscarPortafolio")) $("inpBuscarPortafolio").value = "";
  pintarEstrategiaPortafolio();
}

// ACCION "EXTERNALIZAR" de la gerencia: la sede pasa a un tercero, no se evalua su cierre
const externaliza = (s) => /^EXTERNALIZ/i.test(String(s?.accion ?? "").trim());
// ACCION "RENEGOCIADO": la renegociacion ya esta en los costos de la hoja; la sede se evalua como cualquier otra
const renegociada = () => false;
// Matriz de decision del analisis "Decisiones Cierre - Criterios" del equipo: nivel del score relativo x materialidad
// del margen. No decide cierres por si sola; es la segunda llave del plan (un cierre necesita VAN y una de estas categorias)
const CATEGORIAS_SALIDA = new Set(["Salida / renegociación", "Reestructurar / validar salida", "Optimizar / evaluar salida"]);
function categoriaMatriz(nivel, materialidad, margen, mediana) {
  if (nivel === "Bajo") return margen >= mediana || materialidad === "Alta" ? "Revisión prioritaria" : materialidad === "Media" ? "Reestructurar / validar salida" : "Salida / renegociación";
  if (nivel === "Medio") return materialidad === "Alta" ? "Proteger / monitorear" : materialidad === "Media" ? "Optimizar" : "Optimizar / evaluar salida";
  return materialidad === "Alta" ? "Proteger / expandir" : materialidad === "Media" ? "Mantener / expansión condicionada" : "Mantener; revisar contrato";
}
// Score relativo de cada sede fisica (percentiles de volumen, eficiencia del arriendo y tendencia), robustez a los pesos,
// materialidad (terciles del margen) y categoria de la matriz. No depende del plan, asi el plan lo puede usar.
function portafolioBase() {
  const pesos = APP.pesosScore || { vol: 0.35, efic: 0.40, tend: 0.25 };
  const umbrales = APP.umbralesScore || { alto: 65, bajo: 45 };
  const clave = JSON.stringify([pesos, umbrales]);
  if (APP._pf?.est === APP.est && APP._pf.clave === clave) return APP._pf.m;
  const fisicas = (APP.est.sedes || []).filter((s) => s.grupo !== "DIGITAL"), N = Math.max(1, fisicas.length);
  const it = fisicas.map((s) => {
    const vtaMes = (s.venta_12m_real || 0) / 12 / 1e6, arrMes = (s.arriendo_mensual_clp || 0) / 1e6;
    return { id: s.sede_id, vtaMes, rentaPct: vtaMes > 0 ? arrMes / vtaMes : 0.05, tendRel: s.crecimiento_anual_pct || 0, margen: (s.margen_base || 0) / 1e6 };
  });
  const rank = (v, arr) => arr.filter((x) => x <= v).length;
  const aV = it.map((x) => x.vtaMes), aE = it.map((x) => x.rentaPct), aT = it.map((x) => x.tendRel);
  const mg = it.map((x) => x.margen).sort((a, b) => a - b), q = (f) => mg[Math.floor(f * (mg.length - 1))] || 0;
  const t1 = q(1 / 3), t2 = q(2 / 3), med = q(0.5);
  const nivelDe = (sc) => (sc >= umbrales.alto ? "Alto" : sc >= umbrales.bajo ? "Medio" : "Bajo");
  const m = {};
  for (const x of it) {
    const pV = (rank(x.vtaMes, aV) / N) * 100, pE = (1 - rank(x.rentaPct, aE) / N) * 100, pT = (rank(x.tendRel, aT) / N) * 100;
    const base = (pesos.vol * pV + pesos.efic * pE + pesos.tend * pT) / (pesos.vol + pesos.efic + pesos.tend);
    const alt = [0.20 * pV + 0.60 * pE + 0.20 * pT, 0.60 * pV + 0.25 * pE + 0.15 * pT, 0.25 * pV + 0.30 * pE + 0.45 * pT].map(nivelDe);
    const nivel = nivelDe(base), coinciden = alt.filter((n) => n === nivel).length;
    const materialidad = x.margen >= t2 ? "Alta" : x.margen >= t1 ? "Media" : "Baja";
    m[x.id] = { pctVol: pV, pctEfic: pE, pctTend: pT, scoreBase: base, nivel, materialidad, margen: x.margen,
      robustez: coinciden === 3 ? "Alta" : coinciden >= 2 ? "Media" : "Zona gris", categoria: categoriaMatriz(nivel, materialidad, x.margen, med) };
  }
  APP._pf = { est: APP.est, clave, m };
  return m;
}
function calcularPortafolioMCDA() {
  if (!APP.est) return null;
  const fisicas = (APP.est.sedes || []).filter(s => s.grupo !== "DIGITAL");
  if (!fisicas.length) return null;

  const N = fisicas.length;
  const pesos = APP.pesosScore || { vol: 0.35, efic: 0.40, tend: 0.25 };
  const umbrales = APP.umbralesScore || { alto: 65, bajo: 45, matAlta: 223.79, matBaja: 114.78, rentaMin: 0.012, rentaMax: 0.08 };

  // Extraer vectores para cálculo de percentiles exactos (RANK ascendente / N * 100)
  const items = fisicas.map(s => {
    const vtaMes = (s.venta_12m_real || 0) / 12 / 1e6; // MM CLP/mes
    const arrMes = (s.arriendo_mensual_clp || 0) / 1e6;
    const rentaPct = vtaMes > 0 ? (arrMes / vtaMes) : 0.05;
    const tendRel = s.crecimiento_anual_pct || 0;
    const margenAnual = (s.margen_base || 0) / 1e6;
    const distVecino = s.dist_vecino_km || 5.0;

    return {
      s,
      id: s.sede_id,
      nombre: s.nombre || s.sede_id,
      zona: zonaDe(s),
      vtaMes,
      arrMes,
      rentaPct,
      tendRel,
      margenAnual,
      distVecino,
      contrato: s.vencimiento_contrato ? String(s.vencimiento_contrato).slice(0, 10) : "Sin fecha",
      riesgoContrato: s.costo_cierre_clp > 0 ? "Alto" : (s.vencimiento_contrato ? "Medio" : "Bajo")
    };
  });

  const arrVol = items.map(x => x.vtaMes);
  const arrEfic = items.map(x => x.rentaPct);
  const arrTend = items.map(x => x.tendRel);

  const calcRank = (val, arr) => arr.filter(x => x <= val).length;
  const margenes = items.map(x => x.margenAnual).sort((a, b) => a - b), q = (f) => margenes[Math.floor(f * (margenes.length - 1))] || 0;
  const terciles = [q(1 / 3), q(2 / 3)];
  if (!APP._porId || !APP._alt) prepararCategorias();
  const cal = calendarioCierres();

  // Calcular percentiles y scores en los 4 escenarios
  const locales = items.map(it => {
    const pctVol = (calcRank(it.vtaMes, arrVol) / N) * 100;
    // Eficiencia: percentil invertido (menor arriendo/venta = mejor percentil)
    const pctEfic = (1 - (calcRank(it.rentaPct, arrEfic) / N)) * 100;
    const pctTend = (calcRank(it.tendRel, arrTend) / N) * 100;

    // 4 Escenarios de pesos
    const scoreBase = (pesos.vol * pctVol + pesos.efic * pctEfic + pesos.tend * pctTend) / (pesos.vol + pesos.efic + pesos.tend);
    const scoreEfic = 0.20 * pctVol + 0.60 * pctEfic + 0.20 * pctTend;
    const scoreVol = 0.60 * pctVol + 0.25 * pctEfic + 0.15 * pctTend;
    const scoreTend = 0.25 * pctVol + 0.30 * pctEfic + 0.45 * pctTend;

    const nivelDe = (sc) => (sc >= umbrales.alto ? "Alto" : (sc >= umbrales.bajo ? "Medio" : "Bajo"));
    const nivelBase = nivelDe(scoreBase);
    const nivelEfic = nivelDe(scoreEfic);
    const nivelVol = nivelDe(scoreVol);
    const nivelTend = nivelDe(scoreTend);

    // Robustez
    const coincideConBase = (nivelBase === nivelEfic ? 1 : 0) + (nivelBase === nivelVol ? 1 : 0) + (nivelBase === nivelTend ? 1 : 0);
    let robustez = "Zona gris";
    if (coincideConBase === 3) robustez = "Alta";
    else if (coincideConBase >= 2) robustez = "Media";

    // Materialidad: tercil del margen anual dentro de la red
    const materialidad = it.margenAnual >= terciles[1] ? "Alta" : (it.margenAnual >= terciles[0] ? "Media" : "Baja");

    // Peso del arriendo: sobre 4% de la venta conviene renegociar si la sede se mantiene
    const gateRenta = it.rentaPct > 0.04 ? "Revisar" : "OK";

    // Grupo estrategico = resultado del plan de la pestana Red de sedes (VAN del cierre y red minima)
    const k = cal[it.id], mt = mantieneDe(it.id);
    let arquetipo = "REVISAR", accion = "Por revisar: sin ubicación o sin datos", arqColor = "slate";
    const pf = portafolioBase()[it.id];
    if (mt?.externaliza) { arquetipo = "EXTERNALIZAR"; accion = "Externalización decidida por la gerencia"; arqColor = "slate"; }
    else if (mt?.renegociada) { arquetipo = "RENEGOCIADA"; accion = "Arriendo renegociado por la gerencia: se mantiene"; arqColor = "slate"; }
    else if (k?.tipo === "decidido") { arquetipo = "DECIDIDO"; accion = `Cierre decidido · ${nombreMes(k.mes)}`; arqColor = "slate"; }
    else if (k?.firme) { arquetipo = "CERRAR"; accion = `Cierra ${nombreMes(k.mes)} · ${textoVan(k)} · ${textoReparto(k)}`; arqColor = "rose"; }
    // FORTALECER (antes red minima mejorada, sin uso) agrupa ahora los cierres condicionados y las sedes en seguimiento
    else if (k) { arquetipo = "FORTALECER"; accion = `Condicionado: ${textoDisparador(k.disparador)}, se espera en ${nombreMes(k.mes)}`; arqColor = "amber"; }
    else if (mt?.protegida) { arquetipo = "FORTALECER"; accion = `En seguimiento: el VAN del cierre es positivo, pero el portafolio la protege (${pf?.categoria})`; arqColor = "amber"; }
    else if (mt?.seguimiento) { arquetipo = "FORTALECER"; accion = `En seguimiento: ${textoDisparador(mt.disparador)}`; arqColor = "amber"; }
    else if (mt?.sinDatos) { arquetipo = "REVISAR"; accion = "Sin datos de gastos: no se evalúa"; arqColor = "slate"; }
    else if (mt) { arquetipo = "TRANSFORMAR"; accion = `Red mínima${mt.retNecesaria != null ? `: cerrar convendría reteniendo ${fmt.num(mt.retNecesaria * 100, 0)}% de sus clientes${mt.sinAlternativa ? " (sin otra sede al alcance)" : ""}` : ""}${gateRenta === "Revisar" ? ", renegociar arriendo" : ""}`; arqColor = "sky"; }

    return {
      ...it,
      categoria: pf?.categoria,
      pctVol,
      pctEfic,
      pctTend,
      scoreBase,
      scoreEfic,
      scoreVol,
      scoreTend,
      nivelBase,
      materialidad,
      robustez,
      gateRenta,
      arquetipo,
      accion,
      arqColor
    };
  });

  return {
    locales,
    total: locales.length,
    altos: locales.filter(l => l.nivelBase === "Alto").length,
    medios: locales.filter(l => l.nivelBase === "Medio").length,
    bajos: locales.filter(l => l.nivelBase === "Bajo").length,
    zonaGris: locales.filter(l => l.robustez === "Zona gris").length,
    cntFortalecer: locales.filter(l => l.arquetipo === "FORTALECER").length,
    cntTransformar: locales.filter(l => l.arquetipo === "TRANSFORMAR").length,
    cntCerrar: locales.filter(l => l.arquetipo === "CERRAR").length,
    cntDecidido: locales.filter(l => l.arquetipo === "DECIDIDO").length
  };
}

// Grupos del plan: textos y estilos compartidos por la tabla, el filtro y la pestana Fecha de cierre
const ETIQUETA_ARQ = {
  DECIDIDO:    { txt: "Cierre decidido",     clase: "bg-[#F3F4F6] text-[#1F2937] border-[#D1D5DB]" },
  FORTALECER:  { txt: "Cierre condicionado", clase: "bg-[#FFF4ED] text-[#7C2D12] border-[#F7941D]" },
  CERRAR:      { txt: "Cierre firme",        clase: "bg-[#FDF3D1] text-[#C2410C] border-[#D99A00]" },
  EXTERNALIZAR: { txt: "Externalización",   clase: "bg-[#F3F4F6] text-[#1F2937] border-[#D1D5DB]" },
  RENEGOCIADA:  { txt: "Renegociada",        clase: "bg-[#F3F4F6] text-[#1F2937] border-[#D1D5DB]" },
  TRANSFORMAR: { txt: "Red mínima",          clase: "bg-[#F1F5F9] text-[#496276] border-[#CBD5E1]" },
  OTRO:        { txt: "Otro hipódromo",      clase: "bg-white text-slate-500 border-slate-200" },
  REVISAR:     { txt: "Por revisar",         clase: "bg-white text-slate-500 border-slate-200" },
};
function pintarEstrategiaPortafolio() {
  if (APP.tab !== "segmentos") return;
  const data = calcularPortafolioMCDA();
  if (!data) return;

  // Actualizar KPIs principales
  $("kpiPortafolioTotal").textContent = data.total;
  $("kpiPortafolioAlto").textContent = data.altos;
  $("kpiPortafolioMedio").textContent = data.medios;
  $("kpiPortafolioBajo").textContent = data.bajos;
  $("kpiPortafolioZonaGris").textContent = data.zonaGris;

  // Contadores de los 4 arquetipos
  $("cntArqFortalecer").textContent = data.cntFortalecer;
  $("cntArqTransformar").textContent = data.cntTransformar;
  $("cntArqCerrar").textContent = data.cntCerrar;
  $("cntArqDecidido").textContent = data.cntDecidido;

  // Actualizar estados visuales de las tarjetas de arquetipos
  const f = APP.filtroArquetipoActivo;
  ["Fortalecer", "Transformar", "Cerrar", "Decidido"].forEach(k => {
    const card = $("cardArq" + k);
    if (card) {
      const match = (f === k.toUpperCase());
      card.classList.toggle("ring-2", match);
      card.classList.toggle("ring-slate-800", match);
      card.classList.toggle("bg-slate-50/80", match);
    }
  });

  $("txtFiltroArquetipoActivo").textContent = f ? `Solo: ${ETIQUETA_ARQ[f]?.txt || f}` : "Todas las sedes";

  // Renderizar tabla
  renderTablaPortafolio(data);
}

function renderTablaPortafolio(data) {
  const cont = $("portafolio-tabla-container");
  if (!cont || !data) return;

  let filtrados = data.locales || [];

  // Filtro por arquetipo
  if (APP.filtroArquetipoActivo) {
    filtrados = filtrados.filter(l => l.arquetipo === APP.filtroArquetipoActivo);
  }

  // Filtro por texto
  if (APP.filtroTextoPortafolio) {
    const q = APP.filtroTextoPortafolio.toLowerCase();
    filtrados = filtrados.filter(l => (l.nombre || "").toLowerCase().includes(q) || (l.id || "").toLowerCase().includes(q) || (l.zona || "").toLowerCase().includes(q));
  }

  const orden = { DECIDIDO: 0, EXTERNALIZAR: 0, RENEGOCIADA: 0, CERRAR: 1, FORTALECER: 2, TRANSFORMAR: 3, OTRO: 4, REVISAR: 5 }, mes = (l) => calendarioCierres()[l.id]?.mes || "9999";
  filtrados.sort((a, b) => orden[a.arquetipo] - orden[b.arquetipo] || (mes(a) < mes(b) ? -1 : mes(a) > mes(b) ? 1 : b.scoreBase - a.scoreBase));

  const rows = filtrados.map(l => {
    const sano = (l.rentaPct || 0) <= 0.04;
    const etiquetaArriendo = sano
      ? `<span class="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold bg-[#E8EEF5] text-[#003058] border border-[#D1DCE8]">Sano</span>`
      : `<span class="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold bg-[#FDF3D1] text-[#C2410C] border border-[#D99A00]">Elevado</span>`;

    const sinAlt = sinAlternativa(l.s);
    const textoDistancia = sinAlt
      ? `<span class="text-[11px] text-[#9D174D] font-semibold">Sin alternativa</span>`
      : `<span class="text-[11px] text-[#003058] font-semibold">Con alternativa</span>`;


    const recLabel = esc(l.accion), recClass = ETIQUETA_ARQ[l.arquetipo]?.clase || ETIQUETA_ARQ.REVISAR.clase;

    return `
      <tr class="hover:bg-slate-50 transition-colors cursor-pointer" onclick="verEnCierreOptimo('${l.id}')">
        <td class="py-2.5 px-3">
          <div class="font-bold text-slate-800">${esc(l.nombre)}</div>
          <div class="text-[10px] font-mono text-slate-400">${esc(l.id)}</div>
        </td>
        <td class="py-2.5 px-3 text-slate-600">${esc(l.zona)}</td>
        <td class="py-2.5 px-3 text-right font-medium text-slate-700">$${(l.vtaMes || 0).toFixed(1)} M</td>
        <td class="py-2.5 px-3 text-right">
          <span class="font-medium ${sano ? 'text-slate-700' : 'text-[#C2410C] font-semibold'}">${((l.rentaPct || 0) * 100).toFixed(1)}%</span>
          <span class="ml-1.5">${etiquetaArriendo}</span>
        </td>
        <td class="py-2.5 px-3 text-right">
          ${textoDistancia}
        </td>
        <td class="py-2.5 px-3">
          <span class="inline-block px-2.5 py-1 rounded-md text-[11px] font-bold border ${recClass}">${recLabel}</span>
        </td>
      </tr>
    `;
  }).join("");

  cont.innerHTML = `
    <table class="w-full text-xs text-left border-collapse font-sans">
      <thead>
        <tr class="bg-slate-100 text-slate-700 font-bold border-b border-slate-300">
          <th class="py-2.5 px-3">Sede</th>
          <th class="py-2.5 px-3">Zona</th>
          <th class="py-2.5 px-3 text-right">Venta Mensual</th>
          <th class="py-2.5 px-3 text-right">Peso del Arriendo</th>
          <th class="py-2.5 px-3 text-right">Otra sede cerca</th>
          <th class="py-2.5 px-3">Plan</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-slate-100">
        ${rows || `<tr><td colspan="6" class="p-4 text-center text-slate-400">No se encontraron sedes con los filtros seleccionados.</td></tr>`}
      </tbody>
    </table>
  `;
}

function verEnCierreOptimo(sedeId) {
  APP.sedeCierreSel = sedeId;
  irA("cierre");
  if ($("selSedeCierre")) $("selSedeCierre").value = sedeId;
  pintarCierreOptimo();
  $("tab-cierre")?.scrollIntoView({ behavior: "smooth", block: "start" });
}
window.verEnCierreOptimo = verEnCierreOptimo;

function aplicarCierresEstrategicosAVAN() {
  APP._escenarioInicial = true;
  aplicarEscenarioDemanda("plan", false);
  irA("resultado");
}

function descargarCSVEstrategia() {
  const data = calcularPortafolioMCDA();
  if (!data || !data.locales) return;

  const filas = [
    ["Id_Sede", "Nombre", "Zona", "Volumen_M_CLP_mes", "Arriendo_Pct_Vta", "Gate_Renta", "Tendencia_Rel_pp", "Distancia_Vecino_km", "Score_MCDA_Base", "Score_Prioridad_Efic", "Score_Prioridad_Vol", "Score_Prioridad_Tend", "Nivel", "Robustez", "Arquetipo", "Accion_Recomendada"],
    ...data.locales.map(l => [
      l.id,
      `"${l.nombre.replace(/"/g, '""')}"`,
      `"${l.zona}"`,
      l.vtaMes.toFixed(2),
      (l.rentaPct * 100).toFixed(2) + "%",
      l.gateRenta,
      l.tendRel.toFixed(2),
      l.distVecino.toFixed(1),
      l.scoreBase.toFixed(2),
      l.scoreEfic.toFixed(2),
      l.scoreVol.toFixed(2),
      l.scoreTend.toFixed(2),
      l.nivelBase,
      l.robustez,
      `"${ETIQUETA_ARQ[l.arquetipo]?.txt || l.arquetipo}"`,
      `"${l.accion}"`
    ])
  ];

  const csv = filas.map(r => r.join(";")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `estrategia_portafolio_teletrak_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

// Compatibilidad con navegación anterior
function pintarSegmentos() {
  pintarEstrategiaPortafolio();
}


// Calibracion de U0 con los cierres pasados del propio Excel: cuánto de la venta de una sede cerrada recuperan sus vecinas
function pintarCalibracion() {
  const c = APP.est.calibracion || {}, ev = c.eventos || [];
  const frase = c.estado === "CALIBRADO"
    ? `En los ${ev.length} cierres pasados del Excel, las sedes cercanas recuperaron en promedio <b>${fmt.pct(c.retencion_observada_media)}</b> de la venta de la sede cerrada. El simulador usa esa proporción (U₀ ${fmt.num(c.u0, 2)}, λ ${fmt.num(c.lambda, 1)}).`
    : `Con los cierres pasados del Excel no se pudo estimar una cifra confiable${ev.length ? ` (${ev.length} cierres)` : ""}. El simulador usa un valor de referencia (U₀ ${fmt.num(c.u0, 2)}, λ ${fmt.num(c.lambda, 1)}).`;
  $("calibracion").innerHTML = `<p class="text-sm text-slate-700">${frase} El resto se va al canal digital o se pierde.${DASHBOARD_DATA?.huff_por_tiempo ? " El reparto entre sedes sigue el tiempo real de viaje (calles, metro o tren), no la distancia en línea recta." : ""}</p>
    ${ev.length ? `<details class="mt-3 text-xs"><summary class="cursor-pointer text-slate-600">Ver los cierres usados</summary><div class="mt-2">${tabla(ev, [
      { k: "nombre", t: "Sede que cerró" }, { k: "mes_cierre", t: "Cierre", f: (v) => String(v || "").slice(0, 7) },
      { k: "venta_perdida_mes", t: "Venta mensual $M", n: 1, f: fmt.mm }, { k: "sedes_cercanas", t: "Vecinas", n: 1 },
      { k: "retencion_observada", t: "Recuperado", n: 1, f: (v) => fmt.pct(v) }, { k: "retencion_huff", t: "Según modelo", n: 1, f: (v) => fmt.pct(v) }], { alto: 260 })}</div></details>` : ""}`;
}

// =====================================================================
// Sedes y contratos
// =====================================================================
const COLS_SEDES = [
  { k: "focal", t: "G9", f: (v, f) => f.grupo === "DIGITAL" ? "" : `<input type="checkbox" class="h-3.5 w-3.5 accent-green-800 cursor-pointer" data-star="${esc(f.sede_id)}" title="Cartera focal (G9)" ${APP.focal.has(f.sede_id) ? "checked" : ""}>` },
  { k: "sede_id", t: "Id" }, { k: "nombre", t: "Sede" }, { k: "grupo", t: "Grupo" }, { k: "cat", t: "Categoría", f: (v) => chipCat(v) },
  { k: "venta_12m_real", t: "Venta 12m $M", n: 1, f: fmt.mm }, { k: "crecimiento_anual_pct", t: "Crec. %", n: 1, f: (v) => fmt.num(v) },
  { k: "retencion_huff", t: "Retención", n: 1, f: (v) => fmt.pct(v) }, { k: "dist_vecino_km", t: "Vecino km", n: 1, f: (v) => fmt.num(v) },
  { k: "holgura", t: "Holgura eq.", n: 1, f: (v) => fmt.pct(v) }, { k: "prob_perdida", t: "P(pérdida)", n: 1, f: (v) => fmt.pct(v) },
  { k: "delta_ebitda", t: "Δ EBITDA cierre $M", n: 1, f: fmt.mm },
  { k: "comuna_censo", t: "Comuna" }, { k: "pct_hombres_50_mas", t: "Hombres 50+", n: 1, f: (v) => fmt.pct(v) },
  { k: "escolaridad_50_mas", t: "Estudio 50+ (años)", n: 1, f: (v) => fmt.num(v, 1) }, { k: "migracion", t: "Dificultad migrar (0-100)", n: 1 }, { k: "accion", t: "Acción" }, { k: "status", t: "Status" },
  { k: "vencimiento_contrato", t: "Vence", f: fmt.fecha }, { k: "fecha_limite_aviso", t: "Límite aviso", f: fmt.fecha },
];
function filasSedes() {
  if (!APP._alt) prepararCategorias();
  const ec = {}, ano1 = Math.min(...(APP.est.economia || []).map((e) => e.ano));
  for (const e of APP.est.economia || []) if (e.ano === ano1) ec[e.sede_id] = e;
  return APP.est.sedes.map((s) => ({ ...s, migracion: entornoDe(s)?.d, cat: categoriaDe(s), focal: APP.focal.has(s.sede_id) ? 1 : 0, holgura: ec[s.sede_id]?.holgura_equilibrio, prob_perdida: ec[s.sede_id]?.prob_perdida, delta_ebitda: ec[s.sede_id]?.delta_ebitda_cierre }));
}
function pintarSedes() {
  prepararCategorias();
  const q = ($("buscar")?.value || "").toLowerCase();
  const f = filasSedes().filter((s) => !q || [s.sede_id, s.nombre, s.accion, s.status, s.grupo].some((x) => String(x ?? "").toLowerCase().includes(q)));
  const { col, asc } = APP.orden;
  f.sort((a, b) => { const x = a[col], y = b[col]; if (x == null) return 1; if (y == null) return -1; return (x > y ? 1 : x < y ? -1 : 0) * (asc ? 1 : -1); });
  if ($("n-sedes")) $("n-sedes").textContent = `${f.length} sedes`;
  if ($("tabla-sedes")) {
    $("tabla-sedes").innerHTML = tabla(f, COLS_SEDES, { clic: "sede_id", alto: 640 });
    $("tabla-sedes").querySelectorAll("th").forEach((th) => (th.onclick = () => { APP.orden = { col: th.dataset.col, asc: APP.orden.col === th.dataset.col ? !APP.orden.asc : false }; pintarSedes(); }));
    $("tabla-sedes").querySelectorAll("tr.click").forEach((tr) => (tr.onclick = () => {
      APP.sedeCierreSel = tr.dataset.id;
      if ($("selSedeCierre")) $("selSedeCierre").value = tr.dataset.id;
      pintarCierreOptimo();
      $("tab-cierre")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }));
    $("tabla-sedes").querySelectorAll("[data-star]").forEach((b) => (b.onclick = (ev) => {
      ev.stopPropagation();
      const id = b.dataset.star;
      APP.focal.has(id) ? APP.focal.delete(id) : APP.focal.add(id);
      IDB.put("focal", [...APP.focal], "prefs");
      DASHBOARD_DATA = construirDashboardData(APP.est);
      iniciarDashboard(); pintarSedes();
    }));
  }
}


// =====================================================================
// Pestaña: Estado de Resultados Consolidado
// =====================================================================
function setAlcanceResultado(alcance) {
  APP.alcanceResultado = alcance;
  $("btnAlcanceRed").classList.toggle("active-pill", alcance === "CONSOLIDADO_RED");
  $("btnAlcanceRed").classList.toggle("text-slate-600", alcance !== "CONSOLIDADO_RED");
  $("btnAlcanceG9").classList.toggle("active-pill", alcance === "CONSOLIDADO_G9");
  $("btnAlcanceG9").classList.toggle("text-slate-600", alcance !== "CONSOLIDADO_G9");
  pintarResultado();
}

function onParamResultadoChange() {
  APP.retencionDigital = (+$("sliderRetencionDigital").value) / 100;
  APP.tasaDescuento = (+$("sliderTasaDescuento").value) / 100;
  sincronizarSupuestos();
  APP.factorCostoOnline = parseFloat($("selCostoOnline")?.value || "0.15");
  pintarResultado();
}

function cerrarMargenNegativo() {
  if (!APP.est || !DASHBOARD_DATA) return;
  const cfg = APP.est.config || {};
  const th = cfg.tasas_hipodromo || { HCH: 0.270, CHS: 0.095, VSC: 0.0875, CHC: 0.0875 };
  const tg = cfg.tasa_margen_global || 0.165;
  const mapaSedes = {};
  (APP.est.sedes || []).forEach(s => { mapaSedes[s.sede_id] = s; });

  DASHBOARD_DATA.red_ids.forEach(id => {
    const s = mapaSedes[id];
    const loc = DASHBOARD_DATA.locales[id];
    if (!s || !loc) return;
    const sm = (s.mix_HCH || 0) + (s.mix_CHS || 0) + (s.mix_VSC || 0) + (s.mix_CHC || 0);
const tasa = tasaComisionSede(s);
    const v = (loc.venta_base_2026_mm || 0) * 1e6;
    const fijos = ((s.arriendo_mensual_clp || 0) * 12) + (s.otros_fijos_anual_clp || 0);
    if ((v * tasa - fijos) < 0) {
      state.closedStores.add(id);
    }
  });
  updateClosureUI();
  renderAll();
  pintarResultado();
}

function limpiarCierresResultado() {
  clearClosures();
  updateClosureUI();
  renderAll();
  pintarResultado();
}

function toggleCierreDesdeResultado(id) {
  if (state.closedStores.has(id)) {
    state.closedStores.delete(id);
  } else {
    state.closedStores.add(id);
    if (!state.closureMonths) state.closureMonths = {};
    if (!state.closureMonths[id]) state.closureMonths[id] = 1;
  }
  const cb = document.querySelector(`#closureCheckboxesContainer input[value="${CSS.escape(id)}"]`);
  if (cb) cb.checked = state.closedStores.has(id);
  if (typeof updateClosureUI === "function") updateClosureUI();
  if (typeof renderAll === "function") renderAll();
  pintarResultado();
}

function filtrarLocalesResultado() {
  pintarListaLocalesResultado();
}

function pintarListaLocalesResultado() {
  const cont = $("resListaLocales");
  if (!cont || !DASHBOARD_DATA) return;
  const q = ($("resBuscarLocal")?.value || "").toLowerCase().trim();
  const mapaSedes = {};
  (APP.est?.sedes || []).forEach(s => { mapaSedes[s.sede_id] = s; });
  const cfg = APP.est?.config || {};
  const th = cfg.tasas_hipodromo || { HCH: 0.270, CHS: 0.095, VSC: 0.0875, CHC: 0.0875 };
  const tg = cfg.tasa_margen_global || 0.165;

  const ids = DASHBOARD_DATA.red_ids.filter(id => {
    if (!q) return true;
    const s = mapaSedes[id] || {};
    const loc = DASHBOARD_DATA.locales[id] || {};
    return id.toLowerCase().includes(q) || (s.nombre || loc.nombre || "").toLowerCase().includes(q);
  });



  cont.innerHTML = ids.map(id => {
    const s = mapaSedes[id] || {};
    const loc = DASHBOARD_DATA.locales[id] || {};
    const isClosed = state.closedStores.has(id);
    const mesCierre = getStoreClosureMonth(id);
    const vBase = loc.venta_base_2026_mm || 0;
    const arr = ((s.arriendo_mensual_clp || 0) / 1e6);
    const fijos = (arr * 12) + ((s.otros_fijos_anual_clp || 0) / 1e6);
    const sm = (s.mix_HCH || 0) + (s.mix_CHS || 0) + (s.mix_VSC || 0) + (s.mix_CHC || 0);
const tasa = tasaComisionSede(s);
    const margen = (vBase * tasa) - fijos;

    const selectorMesHtml = isClosed ? `
      <div class="mt-2 pt-1.5 border-t border-amber-200/80 flex items-center justify-between text-[11px]" onclick="event.stopPropagation()">
        <span class="text-amber-900 font-semibold text-[10.5px]">Mes de cierre efectivo:</span>
        <select class="bg-white border border-amber-300 text-amber-950 font-bold text-[10.5px] rounded px-1.5 py-0.5 shadow-2xs focus:ring-1 focus:ring-amber-500 cursor-pointer"
                onchange="cambiarMesCierre('${esc(id)}', this.value)">
          ${opcionesMesSim(mesCierre).map(m => `
            <option value="${m}" ${mesCierre === m ? 'selected' : ''}>${nombreMesSim(m)}</option>
          `).join('')}
        </select>
      </div>
    ` : '';

    return `
      <div class="p-2 rounded-lg border text-xs transition-all ${isClosed ? 'bg-amber-50/90 border-amber-300 text-amber-950' : 'bg-white border-slate-200 hover:bg-slate-50 text-slate-800'}">
        <label class="flex items-center justify-between cursor-pointer">
          <div class="flex items-center gap-2 overflow-hidden">
            <input type="checkbox" value="${esc(id)}" ${isClosed ? 'checked' : ''} onchange="toggleCierreDesdeResultado('${esc(id)}')" class="rounded border-slate-300 text-turf-700 focus:ring-turf-600 h-4 w-4">
            <div class="truncate">
              <span class="font-bold">${esc(id)}</span> <span class="text-slate-600 font-normal">${esc(s.nombre || loc.nombre || id)}</span>
              <span class="block text-[10.5px] text-slate-400">Venta: $${vBase.toFixed(1)}M · Arr: $${arr.toFixed(1)}M/m</span>
            </div>
          </div>
          <div class="text-right shrink-0 ml-2">
            <span class="text-[11px] font-bold ${margen >= 0 ? 'text-slate-700' : 'text-rose-600'}">
              ${margen >= 0 ? '+' : ''}$${margen.toFixed(1)}M
            </span>
            <span class="block text-[9px] uppercase tracking-wider ${isClosed ? 'text-amber-700 font-bold' : 'text-slate-400'}">${isClosed ? ('Cierra ' + nombreMesSim(mesCierre)) : 'Abierta'}</span>
          </div>
        </label>
        ${selectorMesHtml}
      </div>
    `;
  }).join("") || `<p class="text-xs text-slate-400 p-3 text-center">No se encontraron locales.</p>`;

  $("res-badge-cierres-count").textContent = `${state.closedStores.size} cerrados`;
}

function calcularEstadoResultado() {
  if (!APP.est || !DASHBOARD_DATA) return null;
  const cfg = APP.est.config || {};
  const anos = DASHBOARD_DATA.anos_proy || [2027, 2028, 2029, 2030, 2031];
  const isNom = (state.currencyMode === 'NOMINAL');
  const inflacion = cfg.inflacion_futura || 0.03;
  const tasaRetDigital = APP.retencionDigital ?? 0.35;
  const tasaDescuento = tasaEfectiva();
  const takeoutDigital = APP.takeoutDigital ?? 0.165;
  const scope = APP.alcanceResultado || "CONSOLIDADO_RED";

  let memberIds = (scope === "CONSOLIDADO_G9") ? DASHBOARD_DATA.g9_ids : DASHBOARD_DATA.red_ids;
  if (!memberIds || !memberIds.length) memberIds = DASHBOARD_DATA.red_ids;

  const mapaSedes = {};
  (APP.est.sedes || []).forEach(s => { mapaSedes[s.sede_id] = s; });

  const th = cfg.tasas_hipodromo || { HCH: 0.270, CHS: 0.095, VSC: 0.0875, CHC: 0.0875 };
  const tg = cfg.tasa_margen_global || 0.165;
  const tasaSede = (id) => tasaComisionSede(mapaSedes[id]);

  const fijosSede = (id, y = 0) => {
    const s = mapaSedes[id];
    if (!s) return { arriendo: 0, otros: 0, total: 0, costoCierre: 0 };
    const arr = (s.arriendo_mensual_clp || 0) * 12 * Math.pow(1 + finz().crecArriendo, y + 1);
    const otros = (s.otros_fijos_anual_clp || 0) * Math.pow(1 + finz().crecOtros, y + 1);
    return {
      arriendo: arr,
      otros: otros,
      total: arr + otros,
      costoCierre: s.costo_cierre_clp || 0
    };
  };

  const openRecipients = DASHBOARD_DATA.red_ids.filter(id => !state.closedStores.has(id));

  const huffProbs = {};
  state.closedStores.forEach(closedId => {
    let denom = state.u0;
    let scores = {};
    openRecipients.forEach(openId => {
      const dist = (DASHBOARD_DATA.matriz_distancias[closedId] && DASHBOARD_DATA.matriz_distancias[closedId][openId]) || 5.0;
      const distEff = Math.max(0.5, dist);
      const att = atractivoHuff(openId);
      const s = att * Math.pow(distEff, -state.lambda);
      scores[openId] = s;
      denom += s;
    });
    const leakProb = denom > 0 ? (state.u0 / denom) : 1.0;
    huffProbs[closedId] = {
      scores,
      denom,
      leakProb,
      digProb: leakProb * tasaRetDigital,
      lossProb: leakProb * (1 - tasaRetDigital)
    };
  });

  const resultadoPorAno = anos.map((ano, y) => {
    const facInfl = isNom ? Math.pow(1 + inflacion, y + 1) : 1.0;

    let ventaBaseTotal = 0;
    let comisionBaseTotal = 0;
    let arriendoBaseTotal = 0;
    let otrosFijosBaseTotal = 0;
    let fijosBaseTotal = 0;

    memberIds.forEach(id => {
      const loc = DASHBOARD_DATA.locales[id];
      if (!loc) return;
      const v = (isNom ? loc.proy_anual_base.nom_p50[y] : loc.proy_anual_base.real_p50[y]) || 0;
      const t = tasaSede(id);
      const cf = fijosSede(id, y);
      ventaBaseTotal += v;
      comisionBaseTotal += v * t;
      arriendoBaseTotal += (cf.arriendo * facInfl) / 1e6;
      otrosFijosBaseTotal += (cf.otros * facInfl) / 1e6;
      fijosBaseTotal += (cf.total * facInfl) / 1e6;
    });

    const ebitdaBase = comisionBaseTotal - fijosBaseTotal;

    let ventaAbiertas = 0;
    let comisionAbiertas = 0;
    let arriendoAbiertas = 0;
    let otrosFijosAbiertas = 0;
    let fijosAbiertas = 0;

    let ahorroArriendo = 0;
    let ahorroOtrosFijos = 0;
    let ahorroFijosTotal = 0;
    let costoCierreTotal = 0;

    memberIds.forEach(id => {
      const loc = DASHBOARD_DATA.locales[id];
      if (!loc) return;
      const v = (isNom ? loc.proy_anual_base.nom_p50[y] : loc.proy_anual_base.real_p50[y]) || 0;
      const t = tasaSede(id);
      const cf = fijosSede(id, y);
      const fracs = getClosureFractions(id, y);

      if (fracs.fracOpen > 0) {
        ventaAbiertas += v * fracs.fracOpen;
        comisionAbiertas += (v * t) * fracs.fracOpen;
        arriendoAbiertas += ((cf.arriendo * facInfl) / 1e6) * fracs.fracOpen;
        otrosFijosAbiertas += ((cf.otros * facInfl) / 1e6) * fracs.fracOpen;
        fijosAbiertas += ((cf.total * facInfl) / 1e6) * fracs.fracOpen;
      }

      if (fracs.fracClosed > 0) {
        ahorroArriendo += ((cf.arriendo * facInfl) / 1e6) * fracs.fracClosed;
        ahorroOtrosFijos += ((cf.otros * facInfl) / 1e6) * fracs.fracClosed;
        ahorroFijosTotal += ((cf.total * facInfl) / 1e6) * fracs.fracClosed;
      }

      if (fracs.closesInThisYear) {
        costoCierreTotal += (cf.costoCierre * facInfl) / 1e6;
      }
    });

    let ventaCapturaHuff = 0;
    let comisionCapturaHuff = 0;

    state.closedStores.forEach(closedId => {
      const closedLoc = DASHBOARD_DATA.locales[closedId];
      if (!closedLoc) return;
      const closedV = (isNom ? closedLoc.proy_anual_base.nom_p50[y] : closedLoc.proy_anual_base.real_p50[y]) || 0;
      const hp = huffProbs[closedId];
      if (!hp) return;

      const fracsClosed = getClosureFractions(closedId, y);
      if (fracsClosed.fracClosed <= 0) return;

      const vEfectivaCerrada = closedV * fracsClosed.fracClosed;

      memberIds.forEach(recId => {
        const fracsRec = getClosureFractions(recId, y);
        if (fracsRec.fracClosed >= 1.0) return; // Si la receptora esta cerrada en este periodo, no captura
        const sc = hp.scores[recId] || 0;
        const p = hp.denom > 0 ? (sc / hp.denom) : 0;
        const vCap = vEfectivaCerrada * p * (fracsRec.fracOpen > 0 ? fracsRec.fracOpen : 1.0);
        ventaCapturaHuff += vCap;
        comisionCapturaHuff += vCap * tasaSede(recId);
      });
    });

    let ventaMigracionDigital = 0;
    const cerradasParaDigital = (scope === "CONSOLIDADO_G9") 
      ? memberIds.filter(id => state.closedStores.has(id)) 
      : [...state.closedStores];

    let comisionDigitalHCH = 0;
    cerradasParaDigital.forEach(closedId => {
      const closedLoc = DASHBOARD_DATA.locales[closedId];
      if (!closedLoc) return;
      const closedV = (isNom ? closedLoc.proy_anual_base.nom_p50[y] : closedLoc.proy_anual_base.real_p50[y]) || 0;
      const hp = huffProbs[closedId];
      if (hp) {
        const fracsClosed = getClosureFractions(closedId, y);
        if (fracsClosed.fracClosed > 0) {
          ventaMigracionDigital += (closedV * fracsClosed.fracClosed) * hp.digProb;
          comisionDigitalHCH += (closedV * fracsClosed.fracClosed) * hp.digProb * tasaSede(closedId);
        }
      }
    });
    const comisionMigracionDigital = comisionDigitalHCH;

    const ventaProyectoTotal = ventaAbiertas + ventaCapturaHuff + ventaMigracionDigital;
    const comisionProyectoTotal = comisionAbiertas + comisionCapturaHuff + comisionMigracionDigital;
    const ventaFugaNeta = Math.max(0, ventaBaseTotal - ventaProyectoTotal);

    // Costo del cliente online vs presencial:
    const intensidadCostoPresencial = ventaBaseTotal > 0 ? (fijosBaseTotal / ventaBaseTotal) : 0.08;
    const costoOperacionalDigital = ventaMigracionDigital * (intensidadCostoPresencial * (APP.factorCostoOnline ?? 0.15));

    const egresosProyectoTotal = fijosAbiertas + costoCierreTotal + costoOperacionalDigital;
    const ebitdaProyecto = comisionProyectoTotal - egresosProyectoTotal;
    const deltaEbitda = ebitdaProyecto - ebitdaBase;
    const margenEbitda = ventaProyectoTotal > 0 ? (ebitdaProyecto / ventaProyectoTotal) : 0;

    return {
      ano,
      facInfl,
      ventaBaseTotal,
      comisionBaseTotal,
      arriendoBaseTotal,
      otrosFijosBaseTotal,
      fijosBaseTotal,
      ebitdaBase,
      ventaAbiertas,
      comisionAbiertas,
      arriendoAbiertas,
      otrosFijosAbiertas,
      fijosAbiertas,
      ahorroArriendo,
      ahorroOtrosFijos,
      ahorroFijosTotal,
      costoCierreTotal,
      costoOperacionalDigital,
      ventaCapturaHuff,
      comisionCapturaHuff,
      ventaMigracionDigital,
      comisionMigracionDigital,
      ventaFugaNeta,
      ventaProyectoTotal,
      comisionProyectoTotal,
      egresosProyectoTotal,
      ebitdaProyecto,
      deltaEbitda,
      margenEbitda
    };
  });

  const suma5Y = (key) => resultadoPorAno.reduce((acc, r) => acc + (r[key] || 0), 0);
  const total5Y = {
    ventaBaseTotal: suma5Y("ventaBaseTotal"),
    comisionBaseTotal: suma5Y("comisionBaseTotal"),
    arriendoBaseTotal: suma5Y("arriendoBaseTotal"),
    otrosFijosBaseTotal: suma5Y("otrosFijosBaseTotal"),
    fijosBaseTotal: suma5Y("fijosBaseTotal"),
    ebitdaBase: suma5Y("ebitdaBase"),

    ventaAbiertas: suma5Y("ventaAbiertas"),
    comisionAbiertas: suma5Y("comisionAbiertas"),
    arriendoAbiertas: suma5Y("arriendoAbiertas"),
    otrosFijosAbiertas: suma5Y("otrosFijosAbiertas"),
    fijosAbiertas: suma5Y("fijosAbiertas"),
    ahorroArriendo: suma5Y("ahorroArriendo"),
    ahorroOtrosFijos: suma5Y("ahorroOtrosFijos"),
    ahorroFijosTotal: suma5Y("ahorroFijosTotal"),
    costoCierreTotal: suma5Y("costoCierreTotal"),
    costoOperacionalDigital: suma5Y("costoOperacionalDigital"),
    ventaCapturaHuff: suma5Y("ventaCapturaHuff"),
    comisionCapturaHuff: suma5Y("comisionCapturaHuff"),
    ventaMigracionDigital: suma5Y("ventaMigracionDigital"),
    comisionMigracionDigital: suma5Y("comisionMigracionDigital"),
    ventaFugaNeta: suma5Y("ventaFugaNeta"),
    ventaProyectoTotal: suma5Y("ventaProyectoTotal"),
    comisionProyectoTotal: suma5Y("comisionProyectoTotal"),
    egresosProyectoTotal: suma5Y("egresosProyectoTotal"),
    ebitdaProyecto: suma5Y("ebitdaProyecto"),
    deltaEbitda: suma5Y("deltaEbitda")
  };
  total5Y.margenEbitda = total5Y.ventaProyectoTotal > 0 ? (total5Y.ebitdaProyecto / total5Y.ventaProyectoTotal) : 0;

  let vanIncremental = 0;
  resultadoPorAno.forEach((r, idx) => {
    vanIncremental += (r.deltaEbitda * (1 - finz().impuesto)) / Math.pow(1 + tasaDescuento, idx + 1);
  });

  const retencionVenta = total5Y.ventaBaseTotal > 0 ? (total5Y.ventaProyectoTotal / total5Y.ventaBaseTotal) : 1.0;
  const retencionComision = total5Y.comisionBaseTotal > 0 ? (total5Y.comisionProyectoTotal / total5Y.comisionBaseTotal) : 1.0;

  return {
    scope,
    anos,
    isNom,
    resultadoPorAno,
    total5Y,
    vanIncremental,
    retencionVenta,
    retencionComision
  };
}

function renderFilaPL(label, key, resultadoPorAno, total5Y, baseKey = null, opts = {}) {
  const isHead = opts.isHead;
  const isSub = opts.isSub;
  const isTotal = opts.isTotal;
  const isDelta = opts.isDelta;
  const isPct = opts.isPct;

  let trClass = "";
  if (isHead) trClass = "pl-section-head";
  else if (isTotal) trClass = "pl-total-row";
  else if (isDelta) trClass = (total5Y[key] >= 0 ? "pl-delta-row" : "pl-delta-row neg");
  else trClass = "hover:bg-slate-50";

  let tdLabelClass = "py-1.5 px-3";
  if (isSub) tdLabelClass += " pl-row-sub text-slate-500";
  if (isHead) tdLabelClass += " font-extrabold text-pizarra-900";
  if (isTotal) tdLabelClass += " font-bold text-pizarra-900";
  if (isDelta) tdLabelClass += " font-extrabold";

  const formatVal = (v) => {
    if (v == null || isNaN(v)) return "-";
    if (isPct) return (v * 100).toFixed(1) + "%";
    return (v < 0 ? "-" : (opts.showPlus && v > 0 ? "+" : "")) + "$" + pesos(v);
  };

  const val5Y = total5Y[key] || 0;
  let varPctText = "-";
  if (baseKey && total5Y[baseKey] != null && Math.abs(total5Y[baseKey]) > 0.01) {
    const diff = val5Y - total5Y[baseKey];
    const pct = (diff / Math.abs(total5Y[baseKey])) * 100;
    varPctText = (pct > 0 ? "+" : "") + pct.toFixed(1) + "%";
  }

  if (isHead) {
    return `
      <tr class="${trClass}">
        <td colspan="${resultadoPorAno.length + 3}" class="py-2 px-3 tracking-wider">${esc(label)}</td>
      </tr>
    `;
  }

  return `
    <tr class="${trClass}">
      <td class="${tdLabelClass}">${esc(label)}</td>
      ${resultadoPorAno.map(r => `<td class="py-1.5 px-2 text-right ${isTotal || isDelta ? 'font-bold' : ''}">${formatVal(r[key])}</td>`).join("")}
      <td class="py-1.5 px-3 text-right font-extrabold bg-slate-100/70 ${isDelta ? (val5Y >= 0 ? 'text-emerald-800' : 'text-rose-800') : ''}">${formatVal(val5Y)}</td>
      <td class="py-1.5 px-2 text-right font-semibold text-slate-500">${varPctText}</td>
    </tr>
  `;
}

// =====================================================================
// Demanda y VAN ordenada para la presentacion: escenario Plan / Solo decididos, tres indicadores y detalle plegado
// =====================================================================
// Supuestos financieros unicos (Demanda y VAN, Fecha de cierre y el plan): tasa de descuento y retencion digital
Object.defineProperty(APP, "tasaDescuentoCierre", { get: () => APP.tasaDescuento, set: (v) => { APP.tasaDescuento = v; }, configurable: true });
Object.defineProperty(APP, "retencionDigitalCierre", { get: () => APP.retencionDigital, set: (v) => { APP.retencionDigital = v; }, configurable: true });
function sincronizarSupuestos() {
  const t = Math.round(APP.tasaDescuento * 1000) / 10, r = Math.round(APP.retencionDigital * 100);
  for (const [sl, lb, v] of [["sliderTasaDescuento", "valTasaDescuento", t], ["sliderTasaDescuentoCierre", "valTasaDescuentoCierre", t],
    ["sliderRetencionDigital", "valRetencionDigital", r], ["sliderRetencionDigitalCierre", "valRetencionDigitalCierre", r]]) {
    if ($(sl)) $(sl).value = v;
    if ($(lb)) $(lb).textContent = `${fmt.num(v, 2)}%`;
  }
}
// Migracion de clientes al cerrar una sede. "modelo": Huff con tiempos de viaje (U0 de referencia 0,1736, 10% de los que
// no migran a otro local se van al canal digital; con los datos reales retiene ~18% en otros locales en promedio).
// "conservadora" (nombre interno): contraste con el supuesto de Hipodromo Chile, 30% a otros locales y 5% a digital en
// promedio de la red; Huff sigue repartiendo entre sedes segun la accesibilidad de cada una.
const MIGRACION_MODELO = { u0: 0.1736, retencionDigital: 0.10 };
const MIGRACION_CONSERVADORA = { fisica: 0.30, digital: 0.05 };
function u0ParaRetencion(objetivo) {
  const D = DASHBOARD_DATA, ids = D.huff_ids.filter((i) => D.locales[i]);
  const S = ids.map((c) => ids.reduce((a, j) => a + (j === c ? 0 : atractivoHuff(j) * Math.pow(Math.max(0.5, D.matriz_distancias[c]?.[j] ?? 5), -state.lambda)), 0));
  const media = (u0) => S.reduce((a, x) => a + x / (u0 + x), 0) / (S.length || 1);
  let lo = Math.log(1e-6), hi = Math.log(1e6);
  for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (media(Math.exp(m)) > objetivo) lo = m; else hi = m; }
  return Math.exp((lo + hi) / 2);
}
function aplicarMigracion(modo, repintar = true) {
  APP.migracion = modo === "conservadora" ? "conservadora" : "modelo";
  if (APP.migracion === "conservadora") {
    const C = MIGRACION_CONSERVADORA;
    state.u0 = u0ParaRetencion(C.fisica);
    APP.retencionDigital = C.digital / (1 - C.fisica);
  } else { state.u0 = MIGRACION_MODELO.u0; APP.retencionDigital = MIGRACION_MODELO.retencionDigital; }
  APP._calMemo = null;
  if (typeof sincronizarSupuestos === "function") sincronizarSupuestos();
  if (repintar) { if (APP.tab === "red") pintarRed(); else if (APP.tab === "segmentos") pintarSegmentos(); else if (APP.tab === "cierre") pintarCierreOptimo(); else { renderAll(); pintarResultado(); } }
}
// Mejora de una sede que se mantiene: en vez de suponer su efecto, cuanto tendria que subir su venta para que la inversion
// de referencia se pague (VAN = 0), despues de impuesto y con el escudo de la depreciacion.
function equilibrioMejora(id) {
  const s = APP._porId?.[id], loc = DASHBOARD_DATA?.locales?.[id];
  if (!s || !loc) return null;
  const cal = calendarioCierres(), fin = finPlan(), inicio = sumarMeses(historia().corte, 1);
  const rec = conUso(DASHBOARD_DATA.huff_ids.filter((j) => j !== id && !(cal[j] && cal[j].mes <= fin)), id, fin, APP._calMemo.libro);
  const E = escenariosSede(s, rec, inicio, new Set(), []);
  const base = E.mantener.com * (1 - finz().impuesto);
  return base > 0 ? Math.max(0, (-E.mejora.otro - (E.mejora.escudo || 0)) / base) : null;
}
const textoEquilibrio = (id) => { const u = equilibrioMejora(id); return u == null ? "-" : `+${fmt.num(u * 100, u < 0.1 ? 1 : 0)}% de venta`; };
// Mes de cierre en la escala de la simulacion: 1 = enero del primer ano proyectado
const mesSimulacion = (mes) => Math.max(1, (+mes.slice(0, 4) - (DASHBOARD_DATA.anos_proy || [2027])[0]) * 12 + +mes.slice(5, 7));
function cerradasDelPlan(modo) {
  const cal = calendarioCierres();
  return Object.entries(cal).filter(([id, k]) => DASHBOARD_DATA.huff_ids.includes(id) && (modo === "plan" || k.tipo === "decidido"));
}
function aplicarEscenarioDemanda(modo, repintar = true) {
  if (!APP.est || !DASHBOARD_DATA) return;
  if (!APP._porId || !APP._alt) prepararCategorias();
  state.closedStores.clear();   // los decididos quedan (no se reabren)
  if (!state.closureMonths) state.closureMonths = {};
  for (const [id, k] of cerradasDelPlan(modo)) { state.closureMonths[id] = mesSimulacion(k.mes); state.closedStores.add(id); }
  if (typeof updateClosureUI === "function") updateClosureUI();
  if (repintar) { renderAll(); pintarResultado(); }
}
// Escenario actual: Plan, Solo decididos o uno armado a mano en "Simular otro escenario"
function escenarioActual() {
  const igual = (lista) => lista.length === state.closedStores.size && lista.every(([id]) => state.closedStores.has(id));
  return igual(cerradasDelPlan("plan")) ? "plan" : igual(cerradasDelPlan("decididos")) ? "decididos" : "manual";
}
// Tres indicadores: venta y EBITDA del escenario frente a solo decididos (5 años, motor de la simulacion) y VAN del plan
function kpisPlan() {
  if (!$("kpiResVan") || !APP.est || !DASHBOARD_DATA) return;
  const actual = calcularEstadoResultado(); if (!actual) return;
  const guarda = state.closedStores;
  let dec;
  try { state.closedStores = new Set(cerradasDelPlan("decididos").map(([id]) => id)); dec = calcularEstadoResultado(); } finally { state.closedStores = guarda; }
  const t = actual.total5Y, d = dec.total5Y, modo = escenarioActual();
  const dif = (v) => `${v >= 0 ? "+" : "-"}$${pesos(v)}`;
  $("kpiResVenta").textContent = `$${pesos(t.ventaProyectoTotal)}`;
  $("kpiResVentaSub").textContent = modo === "decididos" ? "Red con solo los cierres decididos" : `${dif(t.ventaProyectoTotal - d.ventaProyectoTotal)} frente a solo decididos`;
  $("kpiResEbitda").textContent = `$${pesos(t.ebitdaProyecto)}`;
  $("kpiResEbitdaDelta").textContent = modo === "decididos" ? "Punto de comparación" : `${dif(t.ebitdaProyecto - d.ebitdaProyecto)} frente a solo decididos`;
  const van = $("kpiResVan"), cal = calendarioCierres(), M = APP._calMemo.mantiene;
  if (modo === "plan") {
    const v = Object.values(cal).filter((k) => k.tipo === "propuesto").reduce((a, k) => a + (k.van || 0), 0)
      + Object.values(M).filter((x) => x.mejora).reduce((a, x) => a + x.vanMejora, 0);
    van.textContent = dif(v);
    $("kpiResRetencion").textContent = "Suma del VAN de cada cierre y mejora del plan · 10 años más valor terminal";
  } else if (modo === "decididos") {
    van.textContent = "$0";
    $("kpiResRetencion").textContent = "Este escenario es la base: el plan se mide contra él";
  } else {
    van.textContent = dif(actual.vanIncremental - dec.vanIncremental);
    $("kpiResRetencion").textContent = `Escenario a mano frente a solo decididos · ${(DASHBOARD_DATA.anos_proy || []).length} años`;
  }
  document.querySelectorAll("#escenario-demanda [data-esc]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.esc === modo)));
  document.querySelectorAll("#migracion-demanda [data-mig]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mig === (APP.migracion || "modelo"))));
  const vals = Object.values(cal), nDec = vals.filter((k) => k.tipo === "decidido").length, prop = vals.filter((k) => k.tipo === "propuesto");
  const nMin = Object.keys(M).length, nMej = Object.values(M).filter((x) => x.mejora).length;
  const anos = prop.map((k) => +k.mes.slice(0, 4)), rango = anos.length ? `entre ${Math.min(...anos)} y ${Math.max(...anos)}` : "";
  const bPlan = document.querySelector('#escenario-demanda [data-esc="plan"]'), bDec = document.querySelector('#escenario-demanda [data-esc="decididos"]');
  if (bPlan) bPlan.textContent = `Con el plan (${nDec + prop.length} cierres)`;
  if (bDec) bDec.textContent = `Solo decididos (${nDec})`;
  const suma = (h) => prop.reduce((a, k) => a + (k.reparto?.[h]?.cierre || 0), 0) + Object.values(M).filter((x) => x.mejora).reduce((a, x) => a + (x.reparto?.[h]?.mejora || 0), 0);
  const nAcuerdo = prop.filter((k) => requiereAcuerdo(k)).length;
  const dato = (k, v, sub = "") => `<div><dt class="text-slate-500">${k}</dt><dd class="font-semibold text-pizarra-900 mt-0.5 text-sm tabular-nums">${v}</dd>${sub ? `<dd class="text-[11px] text-slate-500">${sub}</dd>` : ""}</div>`;
  const G = gruposPlan(), vanDe = (l) => l.reduce((a, [, k]) => a + (k.van || 0), 0);
  const anosF = G.firmes.map(([, k]) => +k.mes.slice(0, 4));
  if ($("resumen-plan")) $("resumen-plan").className = "w-full grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-x-6 gap-y-3 text-xs";
  if ($("resumen-plan")) $("resumen-plan").innerHTML = [
    dato("Cierres decididos por la gerencia", nDec),
    dato("Cierres firmes", G.firmes.length, `${anosF.length ? `${Math.min(...anosF)} a ${Math.max(...anosF)}, ` : ""}VAN ${textoMM(vanDe(G.firmes))}`),
    dato("Cierres condicionados", G.condicionados.length + G.seguimiento.length, `${G.condicionados.length} con fecha estimada (VAN ${textoMM(vanDe(G.condicionados))}) y ${G.seguimiento.length} en seguimiento`),
    dato("Red mínima", `${G.red.length} sedes`),
    dato("VAN del plan para Hipódromo Chile", textoMM(suma("HCH"))),
    dato("Para el Club Hípico", textoMM(suma("CHS")), nAcuerdo ? `${nAcuerdo} cierre${nAcuerdo === 1 ? "" : "s"} requiere${nAcuerdo === 1 ? "" : "n"} acuerdo` : ""),
  ].join("");
  const verSim = APP._verSim || modo === "manual";
  if ($("simulador-demanda")) $("simulador-demanda").style.display = verSim ? "" : "none";
  document.querySelectorAll("#escenario-demanda [data-esc]").forEach((b) => b.setAttribute("aria-pressed", String(verSim ? b.dataset.esc === "manual" : b.dataset.esc === modo)));
  if ($("sim-efecto")) $("sim-efecto").textContent = modo === "plan" ? "Hoy: el plan." : modo === "decididos" ? "Hoy: solo los decididos."
    : `Este escenario: EBITDA ${dif(t.ebitdaProyecto - d.ebitdaProyecto)} y VAN ${dif(actual.vanIncremental - dec.vanIncremental)} frente a solo decididos.`;
  if ($("escenario-manual")) $("escenario-manual").hidden = true;
}
function ordenarPestanaDemanda() {
  const tab = $("tab-demanda");
  if (!tab || APP._demandaOrdenada) return;
  APP._demandaOrdenada = true;
  const tarjeta = (el) => el?.closest(".card, .bg-white.rounded-2xl") || null;
  const porTexto = (sel, re) => [...tab.querySelectorAll(sel)].find((e) => re.test(e.textContent));
  const plegar = (el, titulo, sub) => {
    if (!el) return null;
    const d = document.createElement("details");
    d.className = "card plegado";
    d.innerHTML = `<summary class="cursor-pointer font-extrabold text-pizarra-900">${titulo} <span class="text-xs font-normal text-slate-500">· ${sub}</span></summary>`;
    el.classList.remove("card"); el.style.border = "0"; el.style.padding = "0"; el.style.marginTop = "12px"; el.style.boxShadow = "none";
    d.appendChild(el);
    return d;
  };
  // Selector de escenario arriba
  const sel = document.createElement("div");
  sel.className = "card flex flex-wrap items-center justify-between gap-3";
  sel.innerHTML = `<div class="w-full flex flex-wrap items-baseline gap-3"><h2 class="!mb-0 text-base font-extrabold">Demanda y VAN</h2>
      <a href="#" data-ir-red class="text-xs underline text-[#003058] font-semibold">Ver el calendario</a></div>
      <dl class="w-full grid grid-cols-2 md:grid-cols-5 gap-x-6 gap-y-3 text-xs" id="resumen-plan"></dl>
    <div class="flex items-center gap-2"><span class="text-xs text-slate-500" id="escenario-manual" hidden>Escenario armado a mano</span>
    <div class="seg-esc" id="migracion-demanda" role="group" aria-label="Migración de clientes">
      <button type="button" data-mig="modelo">Migración del modelo</button><button type="button" data-mig="conservadora">Supuesto HCH (30%)</button></div>
    <div class="seg-esc" id="escenario-demanda" role="group" aria-label="Escenario">
      <button type="button" data-esc="plan" aria-pressed="true">Con el plan</button><button type="button" data-esc="decididos" aria-pressed="false">Solo decididos</button><button type="button" data-esc="manual" aria-pressed="false">A mano</button></div></div>`;
  tab.prepend(sel);
  sel.querySelectorAll("[data-esc]").forEach((b) => (b.onclick = () => {
    APP._verSim = b.dataset.esc === "manual";
    if (APP._verSim) kpisPlan(); else aplicarEscenarioDemanda(b.dataset.esc);
  }));
  sel.addEventListener("click", (ev) => { const a = ev.target.closest("[data-ir-red]"); if (a) { ev.preventDefault(); irA("red"); } });
  sel.querySelectorAll("[data-mig]").forEach((b) => (b.onclick = () => { aplicarMigracion(b.dataset.mig, false); aplicarEscenarioDemanda(escenarioActual() === "decididos" ? "decididos" : "plan"); }));
  if ($("selMesCierreMasivo")) $("selMesCierreMasivo").innerHTML = opcionesMesSim().map((m) => `<option value="${m}">${nombreMesSim(m)}</option>`).join("");
  // Tres indicadores: venta, EBITDA y VAN del plan
  const grilla = $("kpiResVenta")?.closest(".grid");
  if (grilla) { grilla.classList.remove("md:grid-cols-5", "grid-cols-2"); grilla.classList.add("grid-cols-1", "md:grid-cols-3"); }
  for (const id of ["kpiResComision", "kpiResAhorroFijos"]) { const c = $(id)?.parentElement; if (c) c.hidden = true; }
  const etiqueta = (id, txt) => { const e = $(id)?.parentElement?.querySelector("span"); if (e) e.textContent = txt; };
  const n = (DASHBOARD_DATA.anos_proy || []).length;
  etiqueta("kpiResVenta", `Venta ${n} años`); etiqueta("kpiResEbitda", `EBITDA ${n} años`); etiqueta("kpiResVan", "VAN del plan");
  // Supuestos a Ajustes (un solo juego para toda la herramienta)
  const cuerpo = $("tab-informe")?.parentElement;
  const fin = tarjeta(porTexto("h2", /Parámetros Financieros/)), dem = tarjeta(porTexto("h3", /Parámetros de Demanda/));
  if (cuerpo && (fin || dem)) {
    const caja = document.createElement("div");
    caja.id = "ajustes-supuestos"; caja.className = "space-y-4 mb-6";
    caja.innerHTML = `<h3 class="text-xs font-bold uppercase tracking-wider text-slate-600">Supuestos del modelo</h3>`;
    if (fin) caja.appendChild(fin);
    if (dem) caja.appendChild(dem);
    cuerpo.prepend(caja);
  }
  // Simulador de sedes: va a Detalle por sucursal (es una herramienta de analisis), con botones sobrios y textos cortos
  const sim = tarjeta(porTexto("h2", /Simulador/));
  if (sim) {
    const columna = sim.parentElement;
    sim.id = "simulador-demanda"; sim.style.display = "none";
    sel.after(sim);
    if (columna && !columna.querySelector(".card, .bg-white.rounded-2xl, canvas")) {
      columna.style.display = "none";
      const g = $("mainDemandChart")?.closest("[class*='col-span-8']");
      if (g) g.className = g.className.replace(/lg:col-span-8/, "lg:col-span-12");
    }
    const sub = sim.querySelector("h2")?.parentElement?.querySelector("p");
    if (sub) sub.innerHTML = `<span id="sim-efecto" class="font-semibold text-[#003058]"></span>`;
    sim.classList.add("sim-limpio");
    const h = sim.querySelector("h2");
    if (h) { h.textContent = "Simulador de cierres"; h.className = "!mb-0 text-base font-extrabold text-pizarra-900"; }
    const textos = { "Decididas por gerencia": "Decididas", "Margen < 0": "Margen negativo", "Candidatas": "Propuestas del plan", "Aplicar a cerradas": "Aplicar" };
    for (const b of sim.querySelectorAll("button")) { const t = b.textContent.trim(); if (textos[t]) b.textContent = textos[t]; }
    // "Reabrir todas" pasa al encabezado, junto al contador, como enlace (en pantallas angostas bajaba sola a otra linea)
    const reabrir = [...sim.querySelectorAll("button")].find((b) => /Reabrir todas/.test(b.textContent)), cont = $("closedCountBadge");
    if (reabrir && cont) {
      const caja = document.createElement("div");
      caja.className = "flex flex-col items-end gap-1 shrink-0";
      cont.replaceWith(caja); caja.append(cont, reabrir);
      reabrir.classList.add("sim-link");
    }
    for (const el of sim.querySelectorAll("span, label, div")) {
      if (el.children.length) continue;
      const t = el.textContent.trim();
      if (/^Mes de cierre masivo:?$/i.test(t)) el.textContent = "Mes para todas las cerradas";
      if (/^Cerrar grupo:?$/i.test(t)) el.textContent = "Cerrar grupo completo";
    }
  }
  if (!DASHBOARD_DATA.g9_ids.length) {
    for (const id of ["btnGrp_G9", "tab_G9", "btnAlcanceG9"]) if ($(id)) $(id).hidden = true;
    for (const b of sim?.querySelectorAll("button") || []) if (/G9/.test(b.textContent)) b.hidden = true;
  }
  // Sede focal y alcance fuera: la pestana muestra siempre la red completa. Exportar va a los flujos y Restablecer a Ajustes
  const focal = tarjeta($("entitySelect"));
  const csv = focal && [...focal.querySelectorAll("button")].find((b) => /Exportar/.test(b.textContent));
  const reset = focal && [...focal.querySelectorAll("button")].find((b) => /Restablecer/.test(b.textContent));
  if (reset && $("ajustes-supuestos")) $("ajustes-supuestos").appendChild(reset);
  if (focal) focal.style.display = "none";
  if ($("entitySelect") && $("entitySelect").value !== "CONSOLIDADO_RED" && DASHBOARD_DATA.locales.CONSOLIDADO_RED) { $("entitySelect").value = "CONSOLIDADO_RED"; onEntityChange("CONSOLIDADO_RED"); }
  if (typeof setAlcanceResultado === "function" && APP.alcanceResultado !== "CONSOLIDADO_RED") setAlcanceResultado("CONSOLIDADO_RED");
  // Flujos año a año: abiertos, despues del grafico
  const tabla = tarjeta(porTexto("h2", /Consolidado de flujos/i));
  const calib = [...tab.querySelectorAll(":scope > details.card")].pop() || null;
  const flujos = plegar(tabla, "Flujos año a año", "respaldo para finanzas");
  if (flujos) {
    flujos.open = true; tab.insertBefore(flujos, calib);
    if (csv) { csv.classList.add("ml-3", "btn-s"); csv.addEventListener("click", (ev) => ev.stopPropagation()); flujos.querySelector("summary").appendChild(csv); }
  }
  // Respaldo historico de migracion: con 9 cierres la evidencia no es concluyente, no se muestra
  $("calibracion")?.closest("details")?.remove();
  sincronizarSupuestos();
}
// =====================================================================
// Detalle por sucursal: respaldo del VAN de una sede y VAN de sus alternativas
// =====================================================================
const CARD = "bg-white rounded-2xl border border-slate-200 p-5 shadow-sm";
const mm = (v, signo = false) => `${v < -0.5 ? "-" : signo && v > 0.5 ? "+" : ""}$${pesos(v)}`;
function ordenarPestanaDetalle() {
  const tab = $("tab-cierre");
  if (!tab || APP._detalleOrdenado || !$("selSedeCierre")) return;
  APP._detalleOrdenado = true;
  const tarjeta = (el) => el?.closest(".card, .bg-white.rounded-2xl") || null;
  const h2 = (re) => [...tab.querySelectorAll("h2")].find((e) => re.test(e.textContent));
  // Cabecera: titulo corto, sin bajada ni etiqueta; la linea de decision del plan bajo el selector
  const cab = tarjeta($("selSedeCierre"));
  const tit = h2(/Detalle por Sucursal/i);
  if (tit) { tit.textContent = "Detalle por sucursal"; tit.parentElement?.parentElement?.querySelector("p")?.remove(); }
  $("cierre-badge-estado")?.remove();
  const kpisViejos = $("kpiCierreFechaSugerida")?.closest(".grid");
  if (kpisViejos) kpisViejos.style.display = "none";
  const modo = $("cierre-modo-temporal"), csv = cab && [...cab.querySelectorAll("button")].find((b) => /Exportar/.test(b.textContent));
  if (cab) {
    const v = document.createElement("dl");
    v.id = "det-veredicto"; v.className = "grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-4 mt-5 pt-4 border-t border-slate-100";
    cab.appendChild(v);
    const caja = $("cierreInfoContrato")?.parentElement;   // el recuadro del contrato pasa a la grilla
    if (caja) caja.style.display = "none";
  }
  // Bloque de respaldo: cifras de 12 meses, alternativas y desglose del VAN
  const bloque = document.createElement("div");
  bloque.id = "det-respaldo"; bloque.className = "space-y-5";
  bloque.innerHTML = `
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3.5" id="det-cifras"></div>
    <div class="${CARD}"><h2 class="!mb-3 text-base font-extrabold text-pizarra-900">VAN por escenario</h2><div class="overflow-x-auto" id="det-alt"></div>
      <dl class="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3 mt-4 pt-4 border-t border-slate-100 text-xs" id="det-supuestos"></dl><span hidden id="det-desglose-tit"></span><div id="det-desglose" class="mt-3"></div></div>`;
  cab?.after(bloque);
  const colPrincipal = $("chartCierreOptimo")?.closest("[class*='col-span-8']");
  const graf = $("chartCierreOptimo")?.closest(".card, .bg-white.rounded-2xl");
  if (graf) bloque.insertBefore(graf, bloque.children[1]);
  // Columna lateral (diagnostico, impacto, parametros) fuera; el grafico ocupa el ancho
  const lateral = h2(/Diagn/i)?.closest("[class*='col-span-4']");
  if (lateral) lateral.style.display = "none";
  const principal = $("chartCierreOptimo")?.closest("[class*='col-span-8']");
  if (principal) principal.className = principal.className.replace(/lg:col-span-8/, "lg:col-span-12");
  const trayTit = h2(/Trayectoria/i);
  if (trayTit) { trayTit.textContent = "Trayectoria si se mantiene abierta"; trayTit.parentElement?.querySelector("p")?.remove(); }
  // Detalle de analista plegado: flujos mes a mes y simulador; el directorio sale (la lista esta en Estrategia y Portafolio)
  const plegar = (el, titulo) => {
    if (!el) return null;
    const d = document.createElement("details");
    d.className = "card plegado";
    d.innerHTML = `<summary class="cursor-pointer font-extrabold text-pizarra-900">${titulo}</summary>`;
    el.classList.remove("card"); Object.assign(el.style, { border: "0", padding: "0", marginTop: "12px", boxShadow: "none" });
    d.appendChild(el); return d;
  };
  const mensual = plegar(tarjeta($("cierre-tabla-container")), "Flujos mes a mes de la sede abierta");
  if (mensual) {
    const barra = document.createElement("div"); barra.className = "flex items-center gap-2 mt-3";
    if (modo) barra.appendChild(modo); if (csv) barra.appendChild(csv);
    mensual.insertBefore(barra, mensual.children[1]);
    tab.appendChild(mensual);
    // Es la sede abierta mes a mes (el escenario que el plan descarta): no respalda el VAN del cierre, no se muestra
    mensual.style.display = "none";
  }
  // El simulador a mano no se muestra: no cambia lo que muestra esta pestaña y la pregunta por sede la responde la tabla
  // de escenarios. Queda oculto porque el selector Con el plan / Solo decididos usa sus casillas por dentro.
  const sim = tab.querySelector(".sim-limpio");
  if (sim) sim.style.display = "none";
  const dir = tarjeta(h2(/Directorio/i));
  if (dir) dir.style.display = "none";
  // Fila del cuerpo original: queda vacia (el grafico subio y la tabla mensual se plego)
  if (colPrincipal && !colPrincipal.querySelector("canvas, table, .card, .bg-white.rounded-2xl")) colPrincipal.parentElement.style.display = "none";
}
// Valor del cierre año a año: componentes en valor presente (la linea acumulada termina en el VAN del cierre)
const COLOR_VALOR = [["gastos", "Gastos que se dejan de pagar", "#3D7AB8"], ["comision", "Ingreso que se pierde", "#C2414B"], ["fisica", "Recuperado en otras sedes", "#2E8B57"],
  ["digital", "Recuperado en el canal digital", "#7FC4A4"], ["imp", "Impuesto", "#A3ADBA"], ["ct", "Capital de trabajo", "#D99A00"]];
function pintarGraficoValor(D, t, hipotetico) {
  const cv = $("chartValorCierre"); if (!cv || !t) return;
  const anos = Object.keys(D.porAno).sort(), finA = finPlan().slice(0, 4);
  const cols = [...anos.map((a) => ({ et: a, vp: D.porAno[a].vp, v: D.porAno[a].desc })), { et: `Después de ${finA}`, vp: D.despues.vp, v: D.despues.desc }];
  const dentro = anos.reduce((x, a) => x + D.porAno[a].desc, 0), vt = D.despues.desc;
  const color = (v) => (v > 0.5 ? "text-emerald-800" : v < -0.5 ? "text-rose-800" : "");
  const dato = (k, v, c = "") => `<div><dt class="text-xs text-slate-500">${k}</dt><dd class="font-semibold text-sm tabular-nums mt-0.5 ${c}">${v}</dd></div>`;
  $("det-graf-tit").textContent = hipotetico ? `Valor de cerrarla en ${nombreMes(t)}, año a año` : "Valor del cierre año a año";
  $("det-graf-cifras").innerHTML = dato("Cierre", nombreMes(t)) + dato(anos[0] === finA ? `Valor en ${finA}` : `Valor de ${anos[0]} a ${finA}`, mm(dentro - D.costo, true), color(dentro - D.costo))
    + dato(`Valor después de ${finA}`, mm(vt, true), color(vt)) + dato("VAN del cierre", mm(D.total, true), color(D.total));
  const parte = Math.abs(D.total) > 0.5 ? Math.round((vt / D.total) * 100) : 0;
  $("det-graf-nota").textContent = vt > 0 && dentro - D.costo < 0
    ? `Hasta ${finA} el cierre pierde ${mm(-(dentro - D.costo))}. Todo su valor viene de después de ${finA}, donde se supone que los gastos siguen subiendo y la venta sigue con su tendencia.`
    : dentro - D.costo > 0 && vt > 0 ? `${100 - parte}% del valor se gana hasta ${finA} y ${parte}% después.`
    : D.total < 0 ? "Lo que se recupera en otras sedes y en el canal digital no alcanza a cubrir el ingreso que se pierde." : "";
  let acc = -D.costo; const linea = cols.map((c) => (acc += c.v));
  const ds = COLOR_VALOR.filter(([k]) => cols.some((c) => Math.abs(c.vp[k] || 0) > 0.0005)).map(([k, n, c]) => ({ type: "bar", label: n, data: cols.map((x) => x.vp[k] || 0), backgroundColor: c, stack: "s", order: 2, borderRadius: 2, maxBarThickness: 46 }));
  const ley = (c, n, alto = 10) => `<span class="inline-flex items-center gap-1.5"><i class="inline-block rounded-sm" style="width:10px;height:${alto}px;background:${c}"></i>${n}</span>`;
  $("det-graf-ley").innerHTML = ds.map((d) => ley(d.backgroundColor, d.label)).join("") + ley("#003058", "VAN acumulado", 3);
  ds.push({ type: "line", label: "VAN acumulado", data: linea, borderColor: "#003058", backgroundColor: "#003058", pointRadius: cols.map((_, i) => (i === cols.length - 1 ? 5 : 2)), borderWidth: 2.5, tension: 0.2, order: 1 });
  if (APP.chartValor) APP.chartValor.destroy();
  APP.chartValor = new Chart(cv, {
    data: { labels: cols.map((c) => c.et), datasets: ds },
    options: { responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (it) => `${it.dataset.label}: ${mm(it.parsed.y, true)}` } } },
      scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, grid: { color: "#E5E9EF" }, ticks: { callback: (v) => mm(v) } } } },
    plugins: [{ id: "vt", beforeDraw(ch) { const xs = ch.scales.x, a = ch.chartArea, n = cols.length; if (n < 2) return;
      const w = xs.getPixelForValue(n - 1) - xs.getPixelForValue(n - 2); ch.ctx.save(); ch.ctx.fillStyle = "#EEF2F6";
      ch.ctx.fillRect(xs.getPixelForValue(n - 1) - w / 2, a.top, w, a.bottom - a.top); ch.ctx.restore(); } }],
  });
}
// Linea vertical con la fecha de cierre en el grafico de trayectoria (Detalle por sucursal)
if (typeof Chart !== "undefined" && !Chart.registry?.plugins?.get?.("lineaCierre")) Chart.register({
  id: "lineaCierre",
  afterDatasetsDraw(ch) {
    const L = ch.$lineaCierre; if (!L || !ch.scales.x) return;
    const x = ch.scales.x.getPixelForValue(L.i), a = ch.chartArea, c = ch.ctx;
    c.save(); c.strokeStyle = "#F15A24"; c.lineWidth = 2; c.beginPath(); c.moveTo(x, a.top); c.lineTo(x, a.bottom); c.stroke();
    c.fillStyle = "#F15A24"; c.font = "600 11px Barlow, Inter, sans-serif"; const izq = x > a.right - 140;
    c.textAlign = izq ? "right" : "left"; c.fillText(L.texto, x + (izq ? -5 : 5), a.top + 12); c.restore();
  },
});
function pintarRespaldoVan() {
  if (!$("det-respaldo") || !APP.est || !DASHBOARD_DATA) return;
  if (!APP._porId || !APP._alt) prepararCategorias();
  const id = APP.sedeCierreSel || $("selSedeCierre")?.value, s = APP._porId[id], loc = DASHBOARD_DATA.locales[id];
  if (!s || !loc) { $("det-veredicto").textContent = "Esta sede no tiene proyección de demanda: no se puede evaluar."; return; }
  const cal = calendarioCierres(), k = cal[id], Mt = APP._calMemo.mantiene, mt = Mt[id];
  const inicio = sumarMeses(historia().corte, 1), fin = finPlan(), nombre = nombreLindo(s.nombre);
  const mejoradas = new Set(Object.keys(Mt).filter((x) => Mt[x].mejora));
  const receptoras = conUso(DASHBOARD_DATA.huff_ids.filter((j) => j !== id && !(cal[j] && cal[j].mes <= (k ? k.mes : fin))), id, k ? k.mes : fin, APP._calMemo.libro);
  // Alternativas: mantener como esta, mantener con mejora y cerrar en cada ventana de contrato
  let opciones = [], vanMejora = null;
  if (k?.tipo === "decidido") opciones = vanCierrePorMes(s, receptoras, [k.mes], inicio, mejoradas).opciones;
  else {
    const v = ventanasCierre(s, sumarMeses(inicio, sinAlternativa(s) ? mesesPlanDigital(s) : 0), fin);
    if (v.meses.length) ({ opciones, vanMejora } = vanCierrePorMes(s, receptoras, v.meses, inicio, mejoradas));
  }
  const mejor = opciones.length ? opciones.reduce((a, b) => (b.van > a.van ? b : a)) : null;
  const elegida = k ? k.mes : null;
  const visibles = opciones.length > 14 ? opciones.filter((o, i) => i === 0 || o.mes === mejor?.mes || o.mes === k?.mes || o.mes.endsWith("-01")) : opciones;
  // VAN por escenario, por componente (valor presente, 10 años más valor terminal)
  const E = escenariosSede(s, receptoras, inicio, mejoradas, visibles.map((o) => o.mes));
  const c = (v, b = "") => `<td class="py-1.5 px-3 text-right tabular-nums whitespace-nowrap ${b}">${Math.abs(v) < 0.5 ? "-" : mm(v)}</td>`;
  const fila = (txt, x, plan, base) => `<tr class="border-b border-slate-100 ${plan ? "font-bold bg-slate-50" : ""}"><td class="py-1.5 pr-4 whitespace-nowrap">${txt}</td>
    ${c(x.com)}${c(x.gas)}${c(x.rec)}${c(x.otro)}${c(x.ct)}${c(x.imp)}${c(x.van, "font-semibold")}
    <td class="py-1.5 px-3 text-right tabular-nums whitespace-nowrap ${x.van - base > 0.5 ? "text-emerald-800" : x.van - base < -0.5 ? "text-rose-800" : ""}">${Math.abs(x.van - base) < 0.5 ? "-" : mm(x.van - base, true)}</td>
    ${PERSPECTIVAS.map(([h]) => { const d = x.socio?.[h]; return d == null ? "<td></td>" : `<td class="py-1.5 px-3 text-right tabular-nums whitespace-nowrap ${d > 0.5 ? "text-emerald-800" : d < -0.5 ? "text-rose-800" : ""} ${h === HIPODROMO_CLIENTE ? "font-semibold" : ""}">${Math.abs(d) < 0.5 ? "-" : mm(d, true)}</td>`; }).join("")}
    <td class="py-1.5 pl-3 text-slate-600">${plan ? "Plan" : ""}</td></tr>`;
  let alt = `<table class="w-full text-xs"><thead><tr class="text-slate-500 border-b border-slate-200 align-bottom">
    <th class="py-1.5 text-left font-semibold whitespace-nowrap">Escenario</th><th class="py-1.5 px-3 text-right font-semibold" title="Ingreso de los hipódromos por las apuestas en la sede">Ingreso</th>
    <th class="py-1.5 px-3 text-right font-semibold">Gastos</th><th class="py-1.5 px-3 text-right font-semibold" title="Ingreso de los clientes que siguen apostando en otras sedes u online">Ingreso conservado</th>
    <th class="py-1.5 px-3 text-right font-semibold">Inversión o cierre</th><th class="py-1.5 px-3 text-right font-semibold">Capital de trabajo</th>
    <th class="py-1.5 px-3 text-right font-semibold">Impuesto (${fmt.num(finz().impuesto * 100, 1)}%)</th><th class="py-1.5 px-3 text-right font-semibold">VAN</th>
    <th class="py-1.5 px-3 text-right font-semibold" title="Diferencia frente a mantenerla como está">Diferencia</th>
    ${PERSPECTIVAS.map(([, n]) => `<th class="py-1.5 px-3 text-right font-semibold" title="Diferencia para ${n}">${n}</th>`).join("")}<th></th></tr></thead><tbody>`;
  const base = E.mantener.van;
  // Diferencia frente a mantenerla para cada socio (mismos escenarios, con el ingreso y los gastos de cada hipodromo)
  for (const [h] of PERSPECTIVAS) {
    const Eh = escenariosSede(s, receptoras, inicio, mejoradas, visibles.map((o) => o.mes), h), bh = Eh.mantener.van;
    (E.mantener.socio ??= {})[h] = 0; (E.mejora.socio ??= {})[h] = Eh.mejora.van - bh;
    Eh.cerrar.forEach((c, i) => { (E.cerrar[i].socio ??= {})[h] = c.van - bh; });
  }
  if (k?.tipo !== "decidido") {
    alt += fila("Mantener como está", E.mantener, !!mt && !mt.mejora, base);
  } else alt += fila("Mantener como está", E.mantener, false, base);
  for (const x of E.cerrar) alt += fila(`Cerrar en ${nombreMes(x.mes)}${k?.tipo === "decidido" ? " (decidido por la gerencia)" : ""}`, x, x.mes === elegida, base);
  $("det-alt").innerHTML = alt + "</tbody></table>";
  // Decision del plan y sus cifras clave, en una grilla de datos
  const dato = (k, val, grande = false, cls = "") => `<div><dt class="text-[11px] text-slate-500">${k}</dt>
    <dd class="${grande ? "text-lg font-extrabold" : "text-sm font-semibold"} ${cls || "text-pizarra-900"} mt-0.5 tabular-nums">${val}</dd></div>`;
  const colorV = (x) => (x > 0.5 ? "text-emerald-800" : x < -0.5 ? "text-rose-800" : "");
  const rx = k || mt;
  let decision, vanTxt = null, vanVal = 0;
  if (k?.tipo === "decidido") { decision = `Cierre decidido · ${nombreMes(k.mes)}`; vanVal = opciones[0]?.van ?? 0; vanTxt = "Valor del cierre"; }
  else if (k) { decision = k.firme ? `Cierre firme · ${nombreMes(k.mes)}` : `Cierre condicionado · se espera ${nombreMes(k.mes)}`; vanVal = k.van; vanTxt = "Valor del cierre"; }
  else if (mt?.seguimiento) { decision = "En seguimiento"; vanVal = mejor?.van ?? 0; vanTxt = mejor ? `Valor de cerrarla en ${nombreMes(mejor.mes)}` : null; }
  else if (mt?.mejora) { decision = "Se mantiene con mejora"; vanVal = mt.vanMejora; vanTxt = "Valor de la mejora"; }
  else if (mt) { decision = "Se mantiene"; vanVal = mejor?.van ?? 0; vanTxt = mejor ? `Valor de cerrarla en ${nombreMes(mejor.mes)}` : null; }
  else decision = "Sin evaluación";
  const campo = mt?.mejora ? "mejora" : "cierre";
  const v = $("det-veredicto");
  v.innerHTML = [
    dato("Decisión del plan", decision, true),
    vanTxt ? dato(`${vanTxt} (frente a mantenerla)`, mm(vanVal, true), true, colorV(vanVal)) : "",
    (k?.mc || mt?.mc) ? dato(`Escenarios con VAN positivo (mínimo ${fmt.num(probMin() * 100, 0)}%)`, `${fmt.num((k?.mc || mt.mc).prob * 100, 0)}%`, true,
      (k?.mc || mt.mc).prob >= probMin() ? "text-emerald-800" : "text-rose-800") : "",
    (k?.mc || mt?.mc) ? dato("VAN P10 a P90", `${mm((k?.mc || mt.mc).p10, true)} a ${mm((k?.mc || mt.mc).p90, true)}`) : "",
    rx?.disparador ? dato("Cerrar cuando su venta anual baje de", `$${pesos(rx.disparador.venta / 1e6)}`, true) : "",
    rx?.disparador ? dato("Venta de los últimos 12 meses", `$${pesos(rx.disparador.hoy / 1e6)}${rx.disparador.caida > 0 ? `, falta caer ${fmt.num(rx.disparador.caida * 100, 0)}%` : ""}`) : "",
    ...(rx?.reparto ? PERSPECTIVAS.map(([h, n]) => dato(`Para ${n}`, mm(rx.reparto[h][campo], true), h === HIPODROMO_CLIENTE, colorV(rx.reparto[h][campo]))) : []),
    dato("Acuerdo entre socios", rx?.reparto ? (requiereAcuerdo(rx, campo) ? "Requiere acuerdo" : "No requiere") : "-"),
    dato("Administra", nombreGestion(s).replace(/^el /, "").replace(/^./, (c) => c.toUpperCase())),
    dato("Contrato vence", s.vencimiento_contrato ? nombreMes(mes7(s.vencimiento_contrato)) : "Sin dato"),
    dato("Límite de aviso", s.fecha_limite_aviso ? nombreMes(mes7(s.fecha_limite_aviso)) : "Sin dato"),
    dato("Arriendo mensual", s.arriendo_mensual_clp ? fmt.clp(s.arriendo_mensual_clp) : "Sin dato"),
    !k ? dato(`Una mejora de $${pesos(APP.mejora.inversion)} se paga con`, textoEquilibrio(id)) : "",
  ].join("");
  // Disparador en el grafico de trayectoria: el ingreso de los hipodromos con el que conviene cerrar
  const ch = APP.chartCierre;
  if (ch && rx?.disparador) {
    const anual = APP.modoCierreTemporal === "anual", nivel = (rx.disparador.venta / 1e6) * tasaComisionSede(s) / (anual ? 1 : 12);
    ch.data.datasets = ch.data.datasets.filter((d) => d.label !== "Ingreso con el que conviene cerrar");
    ch.data.datasets.push({ type: "line", label: "Ingreso con el que conviene cerrar", data: ch.data.labels.map(() => +nivel.toFixed(2)), borderColor: "#F15A24",
      borderDash: [6, 4], borderWidth: 2, pointRadius: 0, fill: false, yAxisID: "y", order: 0 });
    ch.update();
  }
  // Linea vertical en la fecha de cierre del plan (o la estimada si esta en seguimiento)
  if (ch) {
    const mesC = k ? k.mes : mt?.seguimiento ? mt.mes : null, anual = APP.modoCierreTemporal === "anual";
    if (mesC) {
      const labs = ch.data.labels.map(String), clave = anual ? mesC.slice(0, 4) : mesC;
      let i = labs.indexOf(clave); if (i < 0) i = clave < labs[0] ? 0 : labs.length - 1;
      ch.$lineaCierre = { i, texto: `${k?.tipo === "decidido" ? "Cierre decidido" : k?.firme ? "Cierre" : "Cierre estimado"} ${nombreMes(mesC)}` };
    } else ch.$lineaCierre = null;
    ch.update();
  }
  // El grafico de trayectoria marca la fecha del plan (no la regla propia de la pestana)
  const ley = $("cierreGraficoLeyendaCorte");
  if (ley) { ley.className = "text-xs font-semibold text-slate-600"; ley.textContent = k ? `Cierre del plan: ${nombreMes(k.mes)}` : "El plan la mantiene"; }
  // Cifras de los ultimos 12 meses
  const e = economiaCierre(s, loc, id, receptoras, mejoradas);
  const venta = (s.venta_12m_real || 0) / 1e6, comision = venta * e.tasaSedePropia, gastos = e.costoFijoMensualBaseMM * 12;
  const tile = (lbl, val, cls = "") => `<div class="bg-white rounded-xl border border-slate-200 p-3.5"><span class="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">${lbl}</span>
    <div class="text-lg font-extrabold mt-0.5 tabular-nums ${cls}">${val}</div></div>`;
  $("det-cifras").innerHTML = tile("Venta 12 meses", mm(venta)) + tile("Ingreso neto hipódromos 12 meses", mm(comision)) + tile("Gastos 12 meses", mm(gastos))
    + tile("Resultado 12 meses", mm(comision - gastos, true), comision - gastos >= 0 ? "text-emerald-800" : "text-rose-800");
  // Respaldo del VAN: el cierre elegido (o la mejor fecha si se mantiene), por componente y por año
  const t = elegida || mejor?.mes;
  if (!t) { $("det-desglose-tit").textContent = "Respaldo del VAN"; $("det-desglose").innerHTML = `<p class="text-xs text-slate-500">${esc(mt?.motivo || "Sin ventanas de cierre dentro del horizonte.")}</p>`; $("det-supuestos").textContent = ""; return; }
  const D = desgloseCierre(s, receptoras, t, inicio, mejoradas);
  pintarGraficoValor(D, t, !k);
  const anos = Object.keys(D.porAno).sort(), finA = fin.slice(0, 4);
  const filas = [["Gastos que se dejan de pagar", "gastos"], ["Comisión que se pierde", "comision"], ["Recuperada en otras sedes", "fisica"], ["Recuperada en el canal digital", "digital"]];
  const celda = (v, b = "") => `<td class="py-1.5 px-2 text-right tabular-nums ${b}">${Math.abs(v) < 0.5 ? "-" : (v < 0 ? "-" : "") + "$" + pesos(v)}</td>`;
  let h = `<table class="w-full text-xs"><thead><tr class="text-slate-500 border-b border-slate-200"><th class="py-1.5 text-left font-semibold">Pesos</th>`
    + anos.map((a) => `<th class="py-1.5 px-2 text-right font-semibold">${a}</th>`).join("") + `<th class="py-1.5 px-2 text-right font-semibold">Después de ${finA}</th><th class="py-1.5 px-2 text-right font-semibold">VAN</th></tr></thead><tbody>`;
  for (const [lbl, c] of filas) h += `<tr class="border-b border-slate-100"><td class="py-1.5 pr-3">${lbl}</td>${anos.map((a) => celda(D.porAno[a][c])).join("")}${celda(D.despues[c])}${celda(D.van[c], "font-semibold")}</tr>`;
  h += `<tr class="border-b border-slate-100"><td class="py-1.5 pr-3">Impuesto (${fmt.num(finz().impuesto * 100, 1)}%)</td>${anos.map((a) => celda(D.porAno[a].imp)).join("")}${celda(D.despues.imp)}${celda(D.van.imp, "font-semibold")}</tr>`;
  h += `<tr class="border-b border-slate-100"><td class="py-1.5 pr-3">Costo de cierre, neto de impuesto</td>${anos.map(() => "<td></td>").join("")}<td></td>${celda(-D.costo, "font-semibold")}</tr>`;
  h += `<tr class="border-b border-slate-100"><td class="py-1.5 pr-3">Capital de trabajo liberado</td>${anos.map((a) => celda(D.porAno[a].ct)).join("")}<td></td>${celda(D.van.ct, "font-semibold")}</tr>`;
  const flujo = (o) => o.gastos + o.comision + o.fisica + o.digital + (o.imp || 0) + (o.ct || 0);
  h += `<tr class="font-semibold border-b border-slate-200"><td class="py-1.5 pr-3">Flujo del cierre</td>${anos.map((a) => celda(flujo(D.porAno[a]))).join("")}${celda(flujo(D.despues))}<td></td></tr>`;
  h += `<tr class="font-bold bg-slate-50"><td class="py-1.5 pr-3">Flujo descontado</td>${anos.map((a) => celda(D.porAno[a].desc)).join("")}${celda(D.despues.desc)}${celda(D.total, D.total >= 0 ? "text-emerald-800" : "text-rose-800")}</tr>`;
  $("det-desglose").innerHTML = `<details><summary class="cursor-pointer text-xs font-semibold text-[#003058]">Flujos año a año de cerrarla en ${nombreMes(t)}, frente a mantenerla</summary>
    <div class="overflow-x-auto mt-2">${h}</tbody></table></div></details>`;
  const pc = (x, d = 0) => `${fmt.num(x * 100, d)}%`;
  const mx = mixSede(s);
  const item = (k, v) => `<div><dt class="text-slate-500">${k}</dt><dd class="font-semibold text-pizarra-900 mt-0.5">${v}</dd></div>`;
  $("det-supuestos").innerHTML = [
    item("Tasa de descuento", `${pc(APP.tasaDescuento ?? 0.105, 2)} nominal${state.currencyMode === "NOMINAL" ? "" : ` (${pc(D.rA, 2)} real)`}`),
    item("Impuesto", pc(finz().impuesto, 1)),
    item("Horizonte", `${DASHBOARD_DATA.anos_proy[0]}-${finA} más valor terminal`),
    item("Regla del plan", `cierra si el VAN es positivo en al menos ${fmt.num(probMin() * 100, 0)}% de ${SIM.iteraciones} escenarios, en la primera fecha a menos de ${fmt.num((finz().tolerancia ?? 0) * 100, 0)}% del mayor VAN esperado`),
    item("Tendencia de su venta", `${D.g >= 0 ? "+" : ""}${pc(D.g, 1)} al año${amortiguacion() < 1 ? `, amortiguándose (${fmt.num(amortiguacion(), 2)} por año)` : ""} hasta ${finA}; después se amortigua (${fmt.num(PHI_TERMINAL, 3)} por año)`),
    item("Costo de salida", `${fmt.num(D.mesesSalida, 1)} meses de arriendo ($${pesos(D.costoBruto)}), ${mes7(s.vencimiento_contrato) && t < mes7(s.vencimiento_contrato) ? "antes de que venza el contrato" : "al vencer el contrato o sin contrato conocido"}`),
    item("Ingreso neto de los hipódromos", `${pc(D.tasa, 1)} de la venta (ley menos comisión de ${pc(tasaComisionVenta(), 1)})`),
    item("Apuestas por hipódromo", `Hipódromo Chile ${pc(mx.HCH)} · Club Hípico ${pc(mx.CHS)} · regiones ${pc((mx.VSC || 0) + (mx.CHC || 0))}`),
    item("Gastos", `repartidos entre los hipódromos según sus apuestas · arriendo +${fmt.num(finz().crecArriendo * 100, 1)}% y otros +${fmt.num(finz().crecOtros * 100, 1)}% real al año`),
    item("Capital de trabajo", `$${pesos(finz().capitalTrabajo)} por sede`),
    item("Si cierra, sus clientes", `${pc(D.physProb)} a sus 3 sedes más cercanas (hasta ${pc(D.physFull)} con toda la red, con tope de 25% de la venta de cada una), ${pc(D.digProb)} al canal digital y ${pc(D.lossProb)} se pierden`),
    item("Migración", APP.migracion === "conservadora" ? "supuesto de Hipódromo Chile (30% y 5%)" : "modelo Huff con tiempos de viaje"),
    item("Mejora", `inversión de referencia $${pesos(APP.mejora.inversion)}, depreciada en ${finz().vidaUtil} años; no entra al plan`),
  ].join("");
}
const _pintarCierreOptimo = pintarCierreOptimo;
pintarCierreOptimo = function () { ordenarPestanaDetalle(); _pintarCierreOptimo(); try { pintarRespaldoVan(); } catch (err) { console.error(err); } };
function pintarResultado() {
  pintarResultadoBase();
  kpisPlan();
}
function pintarResultadoBase() {
  const cont = $("res-tabla-container");
  if (!cont || !APP.est || !DASHBOARD_DATA) return;

  const data = calcularEstadoResultado();
  if (!data) return;

  const { anos, isNom, resultadoPorAno, total5Y, vanIncremental, retencionVenta } = data;

  // Actualizar badges KPI
  $("kpiResVenta").textContent = `$${total5Y.ventaProyectoTotal.toFixed(1)} M`;
  $("kpiResVentaSub").textContent = `Base: $${total5Y.ventaBaseTotal.toFixed(1)} M`;

  $("kpiResComision").textContent = `$${total5Y.comisionProyectoTotal.toFixed(1)} M`;
  $("kpiResComisionSub").textContent = `Base: $${total5Y.comisionBaseTotal.toFixed(1)} M`;

  $("kpiResAhorroFijos").textContent = `+$${total5Y.ahorroFijosTotal.toFixed(1)} M`;
  $("kpiResAhorroFijosSub").textContent = `${state.closedStores.size} sedes cerradas`;

  $("kpiResEbitda").textContent = `$${total5Y.ebitdaProyecto.toFixed(1)} M`;
  $("kpiResEbitdaDelta").textContent = `Δ EBITDA: ${total5Y.deltaEbitda >= 0 ? '+' : ''}$${total5Y.deltaEbitda.toFixed(1)} M`;

  $("kpiResVan").textContent = `${vanIncremental >= 0 ? '+' : ''}$${vanIncremental.toFixed(1)} M`;
  $("kpiResRetencion").textContent = `Retención Venta: ${(retencionVenta * 100).toFixed(1)}%`;

  if ($("res-modo-moneda")) $("res-modo-moneda").textContent = `Moneda: ${isNom ? 'Nominal (Inflación 3% anual)' : 'Real (Moneda constante)'}`;
  if ($("res-badge-ebitda5y")) $("res-badge-ebitda5y").textContent = `Total Δ EBITDA 5Y: ${total5Y.deltaEbitda >= 0 ? '+' : ''}$${total5Y.deltaEbitda.toFixed(1)} M`;

  // Construir tabla HTML
  let html = `
    <table class="w-full text-xs text-left border-collapse font-sans">
      <thead>
        <tr class="bg-slate-100 text-slate-700 font-bold border-b border-slate-300">
          <th class="py-2.5 px-3 min-w-[260px]">Flujo anual (pesos)</th>
          ${anos.map(y => `<th class="py-2.5 px-2 text-right">${y}</th>`).join("")}
          <th class="py-2.5 px-3 text-right bg-slate-200/70 font-extrabold text-pizarra-900">Total ${anos.length} años</th>
          <th class="py-2.5 px-2 text-right">Var % vs Base</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-slate-100">
  `;

  // 1. APUESTAS BRUTAS / HANDLE
  html += renderFilaPL("1. APUESTAS BRUTAS / HANDLE", null, resultadoPorAno, total5Y, null, { isHead: true });
  html += renderFilaPL("Venta Base Locales Abiertos", "ventaAbiertas", resultadoPorAno, total5Y, null, { isSub: true });
  html += renderFilaPL("(+) Migración a otros locales presenciales", "ventaCapturaHuff", resultadoPorAno, total5Y, null, { isSub: true, showPlus: true });
  html += renderFilaPL("(+) Migración a Canal Digital (Teletrak.cl)", "ventaMigracionDigital", resultadoPorAno, total5Y, null, { isSub: true, showPlus: true });
  html += renderFilaPL("(-) Fuga Neta Fuera del Sistema", "ventaFugaNeta", resultadoPorAno, total5Y, null, { isSub: true });
  html += renderFilaPL("Total Apuestas Brutas (Handle)", "ventaProyectoTotal", resultadoPorAno, total5Y, "ventaBaseTotal", { isTotal: true });

  // 2. INGRESOS NETOS POR COMISIÓN / TAKEOUT
  html += renderFilaPL("2. INGRESOS NETOS POR COMISIÓN / TAKEOUT", null, resultadoPorAno, total5Y, null, { isHead: true });
  html += renderFilaPL("Comisión Locales Abiertos", "comisionAbiertas", resultadoPorAno, total5Y, null, { isSub: true });
  html += renderFilaPL("(+) Comisión por migración a otros locales presenciales", "comisionCapturaHuff", resultadoPorAno, total5Y, null, { isSub: true, showPlus: true });
  html += renderFilaPL("(+) Comisión por Migración Digital", "comisionMigracionDigital", resultadoPorAno, total5Y, null, { isSub: true, showPlus: true });
  html += renderFilaPL("Total Ingresos Netos por Comisión", "comisionProyectoTotal", resultadoPorAno, total5Y, "comisionBaseTotal", { isTotal: true });

  // 3. EGRESOS OPERACIONALES
  html += renderFilaPL("3. EGRESOS OPERACIONALES (COSTOS FIJOS Y DIGITALES)", null, resultadoPorAno, total5Y, null, { isHead: true });
  html += renderFilaPL("Costos Fijos Red Abierta (Arriendos + Mantención)", "fijosAbiertas", resultadoPorAno, total5Y, null, { isSub: true });
  html += renderFilaPL("(-) Ahorro de Arriendos por Cierres", "ahorroArriendo", resultadoPorAno, total5Y, null, { isSub: true });
  html += renderFilaPL("(-) Ahorro Otros Costos Fijos por Cierres", "ahorroOtrosFijos", resultadoPorAno, total5Y, null, { isSub: true });
  html += renderFilaPL("(+) Costo Operacional Canal Digital Migrado", "costoOperacionalDigital", resultadoPorAno, total5Y, null, { isSub: true, showPlus: true });
  html += renderFilaPL("(+) Costos de Cierre / Salida", "costoCierreTotal", resultadoPorAno, total5Y, null, { isSub: true });
  html += renderFilaPL("Total Egresos Operacionales", "egresosProyectoTotal", resultadoPorAno, total5Y, "fijosBaseTotal", { isTotal: true });

  // 4. EBITDA Y VAN
  html += renderFilaPL("4. FLUJO OPERACIONAL (EBITDA) Y VALOR ACTUAL NETO (VAN)", null, resultadoPorAno, total5Y, null, { isHead: true });
  html += renderFilaPL("EBITDA Situación Base (Sin Cierres)", "ebitdaBase", resultadoPorAno, total5Y, null, {});
  html += renderFilaPL("EBITDA Con Proyecto (Con Cierres)", "ebitdaProyecto", resultadoPorAno, total5Y, "ebitdaBase", { isTotal: true });
  html += renderFilaPL("VARIACIÓN NETA (Δ EBITDA INCREMENTAL)", "deltaEbitda", resultadoPorAno, total5Y, null, { isDelta: true, showPlus: true });
  html += renderFilaPL("Margen EBITDA sobre Ventas (%)", "margenEbitda", resultadoPorAno, total5Y, null, { isSub: true, isPct: true });

  html += `
      </tbody>
    </table>
  `;

  cont.innerHTML = html;

  // Renderizar gráfico
  renderChartResultado(resultadoPorAno);

  // Renderizar lista interactiva de locales
  pintarListaLocalesResultado();
}

function renderChartResultado(resultadoPorAno) {
  const canvas = $("chartResultadoEbitda");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (APP.chartResultado) {
    APP.chartResultado.destroy();
    APP.chartResultado = null;
  }
  const labels = resultadoPorAno.map(r => String(r.ano));
  const dataBase = resultadoPorAno.map(r => +r.ebitdaBase.toFixed(1));
  const dataProyecto = resultadoPorAno.map(r => +r.ebitdaProyecto.toFixed(1));
  const dataDelta = resultadoPorAno.map(r => +r.deltaEbitda.toFixed(1));

  APP.chartResultado = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "EBITDA Base (Sin Cierres)",
          data: dataBase,
          backgroundColor: "#496276",
          borderRadius: 6,
          order: 2
        },
        {
          label: "EBITDA Con Proyecto",
          data: dataProyecto,
          backgroundColor: "#003058",
          borderRadius: 6,
          order: 3
        },
        {
          label: "Δ EBITDA Incremental",
          data: dataDelta,
          type: "line",
          borderColor: "#D99A00",
          backgroundColor: "#D99A00",
          borderWidth: 3,
          pointRadius: 4,
          pointHoverRadius: 6,
          fill: false,
          tension: 0.1,
          order: 1
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: "top",
          labels: { font: { size: 11, family: "Inter", weight: "600" }, boxWidth: 12, padding: 12 }
        },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: $${Number(ctx.raw).toLocaleString("es-CL", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} M`
          }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { weight: "700" } } },
        y: {
          grid: { color: "#F1F5F9" },
          ticks: {
            callback: (val) => `$${Number(val).toLocaleString("es-CL")}M`,
            font: { size: 10 }
          }
        }
      }
    }
  });
}

function descargarCSVResultado() {
  const data = calcularEstadoResultado();
  if (!data) return;
  const { anos, resultadoPorAno, total5Y } = data;

  const filas = [
    ["Línea de Flujo / VAN", ...anos, `Total ${anos.length} años`],
    ["1. APUESTAS BRUTAS / HANDLE"],
    ["Venta Base Locales Abiertos", ...resultadoPorAno.map(r => r.ventaAbiertas.toFixed(2)), total5Y.ventaAbiertas.toFixed(2)],
    ["(+) Migración a otros locales presenciales", ...resultadoPorAno.map(r => r.ventaCapturaHuff.toFixed(2)), total5Y.ventaCapturaHuff.toFixed(2)],
    ["(+) Migración a Canal Digital", ...resultadoPorAno.map(r => r.ventaMigracionDigital.toFixed(2)), total5Y.ventaMigracionDigital.toFixed(2)],
    ["(-) Fuga Neta Fuera del Sistema", ...resultadoPorAno.map(r => r.ventaFugaNeta.toFixed(2)), total5Y.ventaFugaNeta.toFixed(2)],
    ["Total Apuestas Brutas (Handle)", ...resultadoPorAno.map(r => r.ventaProyectoTotal.toFixed(2)), total5Y.ventaProyectoTotal.toFixed(2)],
    ["2. INGRESOS NETOS POR COMISIÓN"],
    ["Comisión Locales Abiertos", ...resultadoPorAno.map(r => r.comisionAbiertas.toFixed(2)), total5Y.comisionAbiertas.toFixed(2)],
    ["(+) Comisión por migración a otros locales presenciales", ...resultadoPorAno.map(r => r.comisionCapturaHuff.toFixed(2)), total5Y.comisionCapturaHuff.toFixed(2)],
    ["(+) Comisión por Migración Digital", ...resultadoPorAno.map(r => r.comisionMigracionDigital.toFixed(2)), total5Y.comisionMigracionDigital.toFixed(2)],
    ["Total Ingresos Netos por Comisión", ...resultadoPorAno.map(r => r.comisionProyectoTotal.toFixed(2)), total5Y.comisionProyectoTotal.toFixed(2)],
    ["3. EGRESOS OPERACIONALES"],
    ["Costos Fijos Red Abierta", ...resultadoPorAno.map(r => r.fijosAbiertas.toFixed(2)), total5Y.fijosAbiertas.toFixed(2)],
    ["(-) Ahorro de Arriendos por Cierres", ...resultadoPorAno.map(r => r.ahorroArriendo.toFixed(2)), total5Y.ahorroArriendo.toFixed(2)],
    ["(-) Ahorro de Otros Fijos por Cierres", ...resultadoPorAno.map(r => r.ahorroOtrosFijos.toFixed(2)), total5Y.ahorroOtrosFijos.toFixed(2)],
    ["(+) Costo Operacional Canal Digital Migrado", ...resultadoPorAno.map(r => r.costoOperacionalDigital.toFixed(2)), total5Y.costoOperacionalDigital.toFixed(2)],
    ["(+) Costos de Cierre / Salida", ...resultadoPorAno.map(r => r.costoCierreTotal.toFixed(2)), total5Y.costoCierreTotal.toFixed(2)],
    ["Total Egresos Operacionales", ...resultadoPorAno.map(r => r.egresosProyectoTotal.toFixed(2)), total5Y.egresosProyectoTotal.toFixed(2)],
    ["4. FLUJO OPERACIONAL (EBITDA) Y VAN"],
    ["EBITDA Situación Base (Sin Cierres)", ...resultadoPorAno.map(r => r.ebitdaBase.toFixed(2)), total5Y.ebitdaBase.toFixed(2)],
    ["EBITDA Con Proyecto (Con Cierres)", ...resultadoPorAno.map(r => r.ebitdaProyecto.toFixed(2)), total5Y.ebitdaProyecto.toFixed(2)],
    ["VARIACIÓN NETA (Δ EBITDA)", ...resultadoPorAno.map(r => r.deltaEbitda.toFixed(2)), total5Y.deltaEbitda.toFixed(2)],
    ["Margen EBITDA sobre Ventas (%)", ...resultadoPorAno.map(r => (r.margenEbitda * 100).toFixed(1) + "%"), (total5Y.margenEbitda * 100).toFixed(1) + "%"]
  ];

  const csv = filas.map(r => r.map(c => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `consolidado_van_${data.scope}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

// =====================================================================
// Eventos
// =====================================================================
document.querySelectorAll("#nav .nav-tab").forEach((b) => (b.onclick = () => irA(b.dataset.tab)));
if ($("f-excel")) $("f-excel").onchange = () => { if ($("btn-analizar")) $("btn-analizar").disabled = !$("f-excel").files.length; iniciarPython(); };
IDB.get("focal", "prefs").then((f) => { if (f) APP.focal = new Set(f); });
if ($("btn-analizar")) $("btn-analizar").onclick = analizar;
if ($("btn-saltar")) $("btn-saltar").onclick = () => { APP.saltarMapa = true; $("btn-saltar").classList.add("hidden"); };
if ($("btn-guardar")) $("btn-guardar").onclick = guardarEstado;
if ($("btn-presentar")) $("btn-presentar").onclick = () => presentar(!document.body.classList.contains("presentacion"));
if ($("sel-estado")) $("sel-estado").onchange = (e) => abrirEstado(APP.estados[+e.target.value], false);
if ($("buscar")) $("buscar").oninput = pintarSedes;
if ($("u-margen")) $("u-margen").onchange = (e) => { APP.umbralMargen = e.target.value === "" ? null : (+e.target.value || 0) * 1e6; pintarSegmentos(); };
window.cambiarModoRed = function(modo) {
  APP.vistaRed = modo;
  pintarRed();
};
$("red-modo")?.querySelectorAll("[data-modo]").forEach((b) => (b.onclick = () => window.cambiarModoRed(b.dataset.modo)));
if ($("btn-csv-sedes")) $("btn-csv-sedes").onclick = () => descargarCSV(filasSedes(), COLS_SEDES, "sedes.csv");
document.addEventListener("keydown", (e) => {
  if (!document.body.classList.contains("presentacion") || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
  if (e.key === "Escape") presentar(false);
  if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && APP.estados.length > 1) {
    const i = APP.estados.indexOf(APP.est), j = (i + (e.key === "ArrowRight" ? 1 : -1) + APP.estados.length) % APP.estados.length;
    abrirEstado(APP.estados[j], false);
  }
  if (/^[1-9]$/.test(e.key) && TABS[+e.key - 1]) irA(TABS[+e.key - 1]);
});
refrescarRecientes();
if (!APP.est) {
  document.querySelector(".barra-nav")?.classList.add("hidden");
}

// =====================================================================
// PESTAÑA: ESTIMACIÓN DE FECHA DE CIERRE POR SEDE (VAN Y FLUJOS)
// =====================================================================

function setCierreModoTemporal(modo) {
  APP.modoCierreTemporal = modo;
  $("btnCierreMensual")?.classList.toggle("active-pill", modo === "mensual");
  $("btnCierreMensual")?.classList.toggle("text-slate-600", modo !== "mensual");
  $("btnCierreAnual")?.classList.toggle("active-pill", modo === "anual");
  $("btnCierreAnual")?.classList.toggle("text-slate-600", modo !== "anual");
  pintarCierreOptimo();
}

function onSedeCierreChange() {
  const sel = $("selSedeCierre");
  if (!sel) return;
  APP.sedeCierreSel = sel.value;
  pintarCierreOptimo();
}

function onParamCierreChange() {
  APP.tasaDescuentoCierre = (+$("sliderTasaDescuentoCierre").value) / 100;
  APP.retencionDigitalCierre = (+$("sliderRetencionDigitalCierre").value) / 100;
  sincronizarSupuestos();
  pintarCierreOptimo();
}

function poblarSelectorSedesCierre() {
  const sel = $("selSedeCierre");
  if (!sel || !APP.est || !DASHBOARD_DATA) return;
  const current = APP.sedeCierreSel;
  const fisicas = (APP.est.sedes || []).filter(s => s.grupo !== "DIGITAL" && DASHBOARD_DATA.locales && DASHBOARD_DATA.locales[s.sede_id]);

  // Si ya tiene opciones cargadas y el id seleccionado sigue siendo válido, solo sincronizar el valor
  if (sel.options && sel.options.length > 0) {
    if (current && [...sel.options].some(o => o.value === current)) {
      sel.value = current;
      return;
    }
  }

  const g9 = fisicas.filter(s => (DASHBOARD_DATA.g9_ids || []).includes(s.sede_id));
  const rm = fisicas.filter(s => (DASHBOARD_DATA.rm_ids || []).includes(s.sede_id) && !(DASHBOARD_DATA.g9_ids || []).includes(s.sede_id));
  const reg = fisicas.filter(s => (DASHBOARD_DATA.regiones_ids || []).includes(s.sede_id));

  let html = "";
  if (g9.length) {
    html += `<optgroup label="Cartera Focal G9 (${g9.length} Sedes)">`;
    g9.forEach(s => {
      html += `<option value="${s.sede_id}">${esc(s.nombre || s.sede_id)} (${s.sede_id})</option>`;
    });
    html += `</optgroup>`;
  }
  if (rm.length) {
    html += `<optgroup label="Resto Región Metropolitana (${rm.length} Sedes)">`;
    rm.forEach(s => {
      html += `<option value="${s.sede_id}">${esc(s.nombre || s.sede_id)} (${s.sede_id})</option>`;
    });
    html += `</optgroup>`;
  }
  if (reg.length) {
    html += `<optgroup label="Sedes en Regiones (${reg.length} Sedes)">`;
    reg.forEach(s => {
      html += `<option value="${s.sede_id}">${esc(s.nombre || s.sede_id)} (${s.sede_id})</option>`;
    });
    html += `</optgroup>`;
  }
  sel.innerHTML = html;

  if (current && fisicas.some(s => s.sede_id === current)) {
    sel.value = current;
  } else if (g9.length) {
    sel.value = g9[0].sede_id;
    APP.sedeCierreSel = g9[0].sede_id;
  } else if (fisicas.length) {
    sel.value = fisicas[0].sede_id;
    APP.sedeCierreSel = fisicas[0].sede_id;
  }
}

// Hipodromos socios de Teletrak: cada uno recibe lo apostado a sus carreras por la tasa legal (hoja Y 2026, ING | Sin FP)
// y paga los gastos de las sedes que administra (GESTION). Perspectivas: "TOTAL" = el conjunto; "HCH", "CHS" = cada socio.
// Hipodromo Chile es el cliente: sus cifras se destacan, pero el plan se arma con el conjunto (los cierres se acuerdan entre socios).
const HIPODROMO_CLIENTE = "HCH";
const TASAS_LEGALES = { HCH: 0.165, CHS: 0.165, VSC: 0.175, CHC: 0.175 };
const gestionCod = (s) => String(s?.gestion || "").toUpperCase();
const esDelCliente = (s) => gestionCod(s) === HIPODROMO_CLIENTE;
const nombreGestionCorto = (s) => nombreGestion(s).replace(/^el /, "");
const nombreGestion = (s) => ({ HCH: "Hipódromo Chile", CHS: "el Club Hípico", VSC: "Valparaíso Sporting", CHC: "el Club Hípico de Concepción" })[gestionCod(s)] || "sin hipódromo asignado";
// Mezcla de apuestas por hipodromo de la sede (si no tiene, la promedio de la red)
function mixSede(s) {
  const sm = (s?.mix_HCH || 0) + (s?.mix_CHS || 0) + (s?.mix_VSC || 0) + (s?.mix_CHC || 0);
  if (sm > 0.05) return Object.fromEntries(Object.keys(TASAS_LEGALES).map((h) => [h, (s[`mix_${h}`] || 0) / sm]));
  if (APP._mixRed?.est !== APP.est) {
    const f = (APP.est?.sedes || []).filter((x) => x.grupo !== "DIGITAL" && (x.mix_HCH || x.mix_CHS || x.mix_VSC || x.mix_CHC));
    const v = Object.fromEntries(Object.keys(TASAS_LEGALES).map((h) => [h, f.length ? f.reduce((a, x) => a + (x[`mix_${h}`] || 0), 0) / f.length : 0.25]));
    APP._mixRed = { est: APP.est, v };
  }
  return APP._mixRed.v;
}
// Ingreso neto por cada peso apostado en la sede: lo que deja la ley al hipodromo de la carrera menos la comision variable
// (3,2% de la venta, hoja Y 2026), del conjunto de hipodromos o de uno de ellos. Va donde vaya el cliente.
const tasaComisionVenta = () => APP.est?.config?.tasa_comision_venta ?? 0.032;
function tasaComisionSede(s, persp = "TOTAL") {
  const m = mixSede(s), t = { ...TASAS_LEGALES, ...(APP.est?.config?.tasas_hipodromo || {}) };
  if (persp === "TOTAL") return Object.keys(TASAS_LEGALES).reduce((a, h) => a + m[h] * t[h], 0) - tasaComisionVenta();
  return (m[persp] || 0) * (t[persp] || 0) - tasaComisionVenta() * parteGastos(s, persp);
}
// Gastos de la sede (e inversion): los hipodromos se los reparten. [SUPUESTO] en proporcion a lo que cada uno recibe de la
// sede (su parte de las apuestas), hasta conocer la regla exacta; la hoja suma ARRIENDO 100% como el doble de la mitad.
const parteGastos = (s, persp = "TOTAL") => (persp === "TOTAL" ? 1 : mixSede(s)[persp] || 0);
const PERSPECTIVAS = [["HCH", "Hipódromo Chile"], ["CHS", "Club Hípico"]];
// Economia del cierre de una sede (comision, costos fijos y recaptura Huff + digital): la usan Fecha de cierre y la linea de tiempo
const TOPE_CAPACIDAD = 0.25;   // [SUPUESTO Ruben] una sede receptora absorbe hasta +25% de su venta
function economiaCierre(s, loc, sedeId, receptoras, mejoradas = null, persp = "TOTAL") {
  const retencionDigital = APP.retencionDigitalCierre ?? 0.35;
  const tasaSedePropia = tasaComisionSede(s, persp);

  // Costos fijos base
  const arriendoBaseCLP = s.arriendo_mensual_clp || 0;
  const otrosFijosBaseCLP = (s.otros_fijos_anual_clp || 0) / 12;
  const costoFijoMensualBaseMM = ((arriendoBaseCLP + otrosFijosBaseCLP) / 1e6) * parteGastos(s, persp);
  const costoCierreCLP = (s.costo_cierre_clp || 0) * parteGastos(s, persp);

  // Recaptura de red si cierra (Huff sobre las sedes receptoras dadas)
  const u0Val = (typeof state !== 'undefined' && state && state.u0 != null) ? state.u0 : 1.0;
  const lambdaVal = (typeof state !== 'undefined' && state && state.lambda != null) ? state.lambda : 1.5;
  const openRecipients = receptoras;
  let denomHuff = u0Val;
  const scoreMap = {};
  openRecipients.forEach(recId => {
    const dist = (DASHBOARD_DATA.matriz_distancias && DASHBOARD_DATA.matriz_distancias[sedeId] && DASHBOARD_DATA.matriz_distancias[sedeId][recId]) || 5.0;
    const distEff = Math.max(0.5, dist);
    const att = atractivoHuff(recId) * (mejoradas?.has(recId) ? 1 + APP.mejora.atractivo : 1);
    const sc = att * Math.pow(distEff, -lambdaVal);
    scoreMap[recId] = sc;
    denomHuff += sc;
  });

  // Motor de Ruben: cada receptora absorbe como maximo un 25% de su propia venta (tope de capacidad). Caso central: las 3
  // receptoras mas atractivas (Top-3); maximo: toda la red. El resto de los clientes no va a otra sede.
  // La capacidad se acumula: lo que una receptora ya absorbio de cierres anteriores del plan (receptoras.usado) se descuenta
  const vI = Math.max(1, s.venta_12m_real || 0), ventaDe = (id) => APP._porId?.[id]?.venta_12m_real || 0, usado = receptoras?.usado || {};
  const tope = (id) => (ventaDe(id) > 0 ? Math.max(0, TOPE_CAPACIDAD * ventaDe(id) - (usado[id] || 0)) / vI : Infinity);
  const parte = (lista, den) => Object.fromEntries(lista.map(([id, sc]) => [id, Math.min(sc / den, tope(id))]));
  const suma = (o) => Object.values(o).reduce((x, y) => x + y, 0);
  const todos = Object.entries(scoreMap), top3 = [...todos].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const physFull = todos.length ? Math.min(1, suma(parte(todos, denomHuff))) : 0;
  const absorcion = top3.length ? parte(top3, u0Val + top3.reduce((x, [, sc]) => x + sc, 0)) : {};
  const physProb = Math.min(physFull, suma(absorcion));
  const md = typeof digitalSede === "function" ? digitalSede(sedeId) : retencionDigital;
  const digProb = (1 - physProb) * md, lossProb = 1 - physProb - digProb;
  const fo = APP.factorCostoOnline ?? 0.15;

  // El cliente que se va a otra sede (de cualquier hipodromo) o al canal online sigue apostando a las mismas carreras:
  // ese ingreso se conserva (el digital, neto del costo del canal online). Se pierde lo de los clientes que dejan de apostar.
  const tasaRecapFisica = tasaSedePropia * physProb;
  const tasaRecapDigital = tasaSedePropia * digProb * (1 - fo);
  const tasaRecapTotal = tasaRecapFisica + tasaRecapDigital;

  const reparto = Object.fromEntries(openRecipients.map((id) => [id, denomHuff > 0 ? (scoreMap[id] || 0) / denomHuff : 0]));
  return { tasaSedePropia, arriendoBaseCLP, otrosFijosBaseCLP, costoFijoMensualBaseMM, costoCierreCLP, physProb, physFull, absorcion, digProb, lossProb, tasaRecapTotal, tasaRecapFisica, tasaRecapDigital, reparto };
}

function calcularCierreSede(sedeId) {
  if (!APP.est || !DASHBOARD_DATA) return null;
  const s = (APP.est.sedes || []).find(x => String(x.sede_id) === String(sedeId));
  const loc = (DASHBOARD_DATA.locales && DASHBOARD_DATA.locales[sedeId]) ? DASHBOARD_DATA.locales[sedeId] : null;
  if (!s || !loc) return null;

  const cfg = APP.est.config || {};
  const isNom = (typeof state !== 'undefined' && state && state.currencyMode === 'NOMINAL');
  const inflacion = cfg.inflacion_futura || 0.03;
  const tasaDescuento = tasaEfectiva();
  const retencionDigital = APP.retencionDigitalCierre ?? 0.35;
  const factorCostoOnline = APP.factorCostoOnline ?? 0.15;
  const takeoutDigital = APP.takeoutDigital ?? 0.165;
  const rMensual = Math.pow(1 + tasaDescuento, 1 / 12) - 1;

  const closedStores = (typeof state !== 'undefined' && state && state.closedStores) ? state.closedStores : new Set();
  const openRecipients = (DASHBOARD_DATA.huff_ids || []).filter(id => id !== sedeId && !closedStores.has(id));
  const { tasaSedePropia, arriendoBaseCLP, otrosFijosBaseCLP, costoFijoMensualBaseMM, costoCierreCLP, physProb, digProb, lossProb, tasaRecapTotal } =
    economiaCierre(s, loc, sedeId, openRecipients);

  // Generar proyección mensual (60 meses: 2027-01 a 2031-12)
  const anos = DASHBOARD_DATA.anos_proy || [2027, 2028, 2029, 2030, 2031];
  const weights = (loc.month_weights && loc.month_weights.length === 12) ? loc.month_weights : Array(12).fill(1 / 12);
  const mesesDetalle = [];

  let idxMes = 0;
  anos.forEach((ano, yIdx) => {
    const facInfl = isNom ? Math.pow(1 + inflacion, yIdx + 1) : 1.0;
    const ventaAnualBase = (isNom ? loc.proy_anual_base.nom_p50[yIdx] : loc.proy_anual_base.real_p50[yIdx]) || 0;

    for (let m = 1; m <= 12; m++) {
      const mesStr = `${ano}-${String(m).padStart(2, "0")}`;
      const w = weights[m - 1] || (1 / 12);
      const ventaMes = ventaAnualBase * w;
      const comisionMes = ventaMes * tasaSedePropia;
      const costoFijoMes = costoFijoMensualBaseMM * facInfl * factorGastos(s, yIdx);
      const ebitdaMes = comisionMes - costoFijoMes;
      const margenMesPct = ventaMes > 0 ? (ebitdaMes / ventaMes) : 0;

      // Efecto red
      const recapturaComisionMes = ventaMes * tasaRecapTotal;
      const perdidaNetaMargenMes = Math.max(0, comisionMes - recapturaComisionMes);
      const ahorroNetoCierreMes = costoFijoMes - perdidaNetaMargenMes;
      const flujoMantenerRedMes = -ahorroNetoCierreMes;

      mesesDetalle.push({
        idx: idxMes,
        ano,
        mes: m,
        mesStr,
        ventaMes,
        comisionMes,
        costoFijoMes,
        ebitdaMes,
        margenMesPct,
        recapturaComisionMes,
        perdidaNetaMargenMes,
        ahorroNetoCierreMes,
        flujoMantenerRedMes,
        facInfl
      });
      idxMes++;
    }
  });

  // Calcular VAN restante y VAN acumulado
  const nMeses = mesesDetalle.length;
  for (let i = 0; i < nMeses; i++) {
    let vanRestante = 0;
    for (let k = i; k < nMeses; k++) {
      vanRestante += mesesDetalle[k].ebitdaMes / Math.pow(1 + rMensual, k - i + 1);
    }
    mesesDetalle[i].vanRestante = vanRestante;

    let vanAcum = 0;
    for (let k = 0; k <= i; k++) {
      vanAcum += mesesDetalle[k].ebitdaMes / Math.pow(1 + rMensual, k + 1);
    }
    mesesDetalle[i].vanAcumulado = vanAcum;
  }

  // Identificar quiebres
  let primerMesEbitdaNegativo = null;
  let primerMesVanNegativo = null;
  let primerMesAhorroPositivo = null;

  for (let i = 0; i < nMeses; i++) {
    const item = mesesDetalle[i];
    if (item.ebitdaMes < 0 && !primerMesEbitdaNegativo) primerMesEbitdaNegativo = item.mesStr;
    if (item.vanRestante < 0 && !primerMesVanNegativo) primerMesVanNegativo = item.mesStr;
    if (item.ahorroNetoCierreMes > 0 && !primerMesAhorroPositivo) primerMesAhorroPositivo = item.mesStr;
  }

  // Análisis contractual
  const vencimiento = s.vencimiento_contrato ? String(s.vencimiento_contrato).slice(0, 10) : null;
  const mesVencimiento = vencimiento ? vencimiento.slice(0, 7) : null;
  const aviso = s.fecha_limite_aviso ? String(s.fecha_limite_aviso).slice(0, 10) : null;

  // Sugerencia estratégica de fecha de cierre
  let fechaSugerida = "Mantener Abierta";
  let motivoSugerencia = "Operación Rentable";
  let tipoAlerta = "verde";

  if (s.cierre_decidido && s.fecha_cierre_decidida) {
    fechaSugerida = String(s.fecha_cierre_decidida).slice(0, 7);
    motivoSugerencia = "Cierre Decidido por Gerencia";
    tipoAlerta = "ambar";
  } else if (primerMesVanNegativo) {
    if (mesVencimiento && mesVencimiento <= primerMesVanNegativo) {
      fechaSugerida = mesVencimiento;
      motivoSugerencia = "Al Vencimiento Contractual (Sin penalización)";
      tipoAlerta = "rojo";
    } else {
      fechaSugerida = primerMesVanNegativo;
      motivoSugerencia = "Cruce de VAN a Terreno Negativo";
      tipoAlerta = "rojo";
    }
  } else if (primerMesEbitdaNegativo) {
    fechaSugerida = primerMesEbitdaNegativo;
    motivoSugerencia = "Quiebre de Margen Operacional (EBITDA < 0)";
    tipoAlerta = "ambar";
  } else if (primerMesAhorroPositivo && physProb + digProb > 0.65) {
    fechaSugerida = mesVencimiento || primerMesAhorroPositivo;
    motivoSugerencia = "Captura de Red Favorable (Ahorro de Arriendo > Pérdida)";
    tipoAlerta = "ambar";
  }

  // Agrupación anual para la vista anual
  const resumenAnual = anos.map((ano) => {
    const itemsAno = mesesDetalle.filter(x => x.ano === ano);
    const ventaAno = itemsAno.reduce((acc, x) => acc + x.ventaMes, 0);
    const comisionAno = itemsAno.reduce((acc, x) => acc + x.comisionMes, 0);
    const costoFijoAno = itemsAno.reduce((acc, x) => acc + x.costoFijoMes, 0);
    const ebitdaAno = comisionAno - costoFijoAno;
    const margenAnoPct = ventaAno > 0 ? (ebitdaAno / ventaAno) : 0;
    const recapturaAno = itemsAno.reduce((acc, x) => acc + x.recapturaComisionMes, 0);
    const ahorroNetoAno = itemsAno.reduce((acc, x) => acc + x.ahorroNetoCierreMes, 0);
    const vanRestanteAno = itemsAno[0]?.vanRestante || 0;
    const vanAcumuladoAno = itemsAno[itemsAno.length - 1]?.vanAcumulado || 0;

    return {
      ano,
      ventaAno,
      comisionAno,
      costoFijoAno,
      ebitdaAno,
      margenAnoPct,
      recapturaAno,
      ahorroNetoAno,
      vanRestanteAno,
      vanAcumuladoAno
    };
  });

  const ahorroNetoTotal5Y = mesesDetalle.reduce((acc, x) => acc + Math.max(0, x.ahorroNetoCierreMes), 0);

  return {
    s,
    loc,
    sedeId,
    nombre: s.nombre || sedeId,
    tasaSedePropia,
    arriendoBaseCLP,
    otrosFijosBaseCLP,
    costoFijoMensualBaseMM,
    costoCierreCLP,
    vencimiento,
    mesVencimiento,
    aviso,
    physProb,
    digProb,
    lossProb,
    tasaRecapTotal,
    mesesDetalle,
    resumenAnual,
    primerMesEbitdaNegativo,
    primerMesVanNegativo,
    primerMesAhorroPositivo,
    fechaSugerida,
    motivoSugerencia,
    tipoAlerta,
    ahorroNetoTotal5Y
  };
}

function pintarCierreOptimo() {
  if (APP.tab !== "cierre") return;
  poblarSelectorSedesCierre();
  const sedeId = APP.sedeCierreSel || $("selSedeCierre")?.value;
  if (!sedeId) return;

  const data = calcularCierreSede(sedeId);
  if (!data) {
    const cont = $("cierre-tabla-container");
    if (cont) cont.innerHTML = `<p class="p-4 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg">No hay datos de proyección suficientes para la sede seleccionada (${esc(sedeId)}). Selecciona otra sede física.</p>`;
    return;
  }

  // 1. Cabecera y KPIs
  const { s, vencimiento, aviso, arriendoBaseCLP, fechaSugerida, motivoSugerencia, tipoAlerta,
    primerMesEbitdaNegativo, primerMesVanNegativo, ahorroNetoTotal5Y } = data;

  $("cierreInfoContrato").textContent = vencimiento ? fmt.fecha(vencimiento) : "Indefinido";
  $("cierreInfoAviso").textContent = aviso ? fmt.fecha(aviso) : "Sin aviso registrado";
  $("cierreInfoArriendo").textContent = fmt.clp(arriendoBaseCLP);

  const kpiFecha = $("kpiCierreFechaSugerida");
  kpiFecha.textContent = fechaSugerida;
  kpiFecha.className = `text-lg font-extrabold mt-0.5 ${tipoAlerta === 'verde' ? 'text-turf-800' : (tipoAlerta === 'ambar' ? 'text-amber-800' : 'text-rose-800')}`;
  $("kpiCierreFechaCriterio").textContent = motivoSugerencia;

  $("kpiCierreMesEbitda").textContent = primerMesEbitdaNegativo || "Siempre Rentable";
  $("kpiCierreMesEbitdaSub").textContent = primerMesEbitdaNegativo ? "Ingresos < Costos Fijos" : "EBITDA > 0 todo el quinquenio";

  $("kpiCierreMesVan").textContent = primerMesVanNegativo || "VAN Positivo";
  $("kpiCierreMesVanSub").textContent = primerMesVanNegativo ? "Mantener destruye valor" : "Genera valor acumulado";

  $("kpiCierreVencimiento").textContent = vencimiento ? fmt.fecha(vencimiento) : "No estipulado";
  $("kpiCierrePlazoAviso").textContent = aviso ? `Avisar antes de ${fmt.fecha(aviso)}` : "3 meses estándar";

  $("kpiCierreAhorroTotal").textContent = "$" + Number(ahorroNetoTotal5Y || 0).toLocaleString("es-CL", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " M";
  $("kpiCierreAhorroTotalSub").textContent = "Ahorro neto acumulado 5A";

  $("cierreGraficoLeyendaCorte").textContent = `Cierre sugerido: ${fechaSugerida}`;

  // 2. Gráfico
  renderChartCierre(data);

  // 3. Tabla
  renderTablaCierre(data);

  // 4. Diagnóstico lateral
  renderLateralCierre(data);
}

function renderChartCierre(data) {
  const canvas = $("chartCierreOptimo");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (APP.chartCierre) {
    APP.chartCierre.destroy();
    APP.chartCierre = null;
  }

  const modo = APP.modoCierreTemporal || "mensual";
  const labels = modo === "mensual" ? data.mesesDetalle.map(x => x.mesStr) : data.resumenAnual.map(x => String(x.ano));
  const dataComision = modo === "mensual" ? data.mesesDetalle.map(x => +x.comisionMes.toFixed(2)) : data.resumenAnual.map(x => +x.comisionAno.toFixed(2));
  const dataCostos = modo === "mensual" ? data.mesesDetalle.map(x => +x.costoFijoMes.toFixed(2)) : data.resumenAnual.map(x => +x.costoFijoAno.toFixed(2));
  const dataEbitda = modo === "mensual" ? data.mesesDetalle.map(x => +x.ebitdaMes.toFixed(2)) : data.resumenAnual.map(x => +x.ebitdaAno.toFixed(2));
  const dataVan = modo === "mensual" ? data.mesesDetalle.map(x => +x.vanAcumulado.toFixed(2)) : data.resumenAnual.map(x => +x.vanAcumuladoAno.toFixed(2));

  const bgEbitda = dataEbitda.map(v => v >= 0 ? "#C9D7E6" : "#F4C7B8");   // barras claras: el resultado queda de fondo

  APP.chartCierre = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Resultado mensual (EBITDA)",
          data: dataEbitda,
          backgroundColor: bgEbitda,
          borderRadius: 4,
          yAxisID: "y",
          order: 3
        },
        {
          label: "Ingreso de los hipódromos",
          data: dataComision,
          type: "line",
          borderColor: "#003058",
          backgroundColor: "#003058",
          borderWidth: 2,
          pointRadius: modo === "mensual" ? 1 : 4,
          tension: 0.1,
          yAxisID: "y",
          order: 2
        },
        {
          label: "Gastos de la sede",
          data: dataCostos,
          type: "line",
          borderColor: "#C2410C",
          backgroundColor: "#C2410C",
          borderWidth: 2,
          borderDash: [4, 4],
          pointRadius: 0,
          yAxisID: "y",
          order: 1
        },
        {
          label: "VAN Acumulado",
          data: dataVan,
          type: "line",
          borderColor: "#D99A00",
          backgroundColor: "#D99A00",
          borderWidth: 3,
          pointRadius: modo === "mensual" ? 1 : 4,
          tension: 0.2,
          yAxisID: "y1",
          order: 0
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          position: "top",
          labels: { font: { size: 11, family: "Inter", weight: "600" }, boxWidth: 12, padding: 10 }
        },
        tooltip: {
          callbacks: {
            label: (c) => `${c.dataset.label}: $${Number(c.raw).toLocaleString("es-CL", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MM CLP`
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            maxTicksLimit: modo === "mensual" ? 12 : 5,
            font: { size: 10, weight: "600" }
          }
        },
        y: {
          type: "linear",
          display: true,
          position: "left",
          grid: { color: "#F1F5F9" },
          ticks: {
            callback: (v) => `$${Number(v).toFixed(0)}M`,
            font: { size: 10 }
          },
          title: { display: true, text: "Flujo Mensual / Anual (MM CLP)", font: { size: 10, weight: "700" } }
        },
        y1: {
          type: "linear",
          display: true,
          position: "right",
          grid: { drawOnChartArea: false },
          ticks: {
            callback: (v) => `$${Number(v).toFixed(0)}M`,
            font: { size: 10 }
          },
          title: { display: true, text: "VAN Acumulado (MM CLP)", font: { size: 10, weight: "700" } }
        }
      }
    }
  });
}

function renderTablaCierre(data) {
  const cont = $("cierre-tabla-container");
  if (!cont) return;
  const modo = APP.modoCierreTemporal || "mensual";

  $("cierreTablaTitulo").textContent = modo === "mensual"
    ? `Cronograma mensual de flujos (${12 * DASHBOARD_DATA.anos_proy.length} meses, ${DASHBOARD_DATA.anos_proy[0]}-${DASHBOARD_DATA.anos_proy.at(-1)})`
    : `Consolidado anual de flujos (${DASHBOARD_DATA.anos_proy[0]}-${DASHBOARD_DATA.anos_proy.at(-1)})`;
  const isNom = (typeof state !== 'undefined' && state && state.currencyMode === 'NOMINAL');
  $("cierreTablaModo").textContent = `Moneda: ${isNom ? 'Nominal (+3% inf.)' : 'Real (Sep-26)'}`;

  let rowsHtml = "";

  if (modo === "mensual") {
    data.mesesDetalle.forEach(item => {
      const isNegEbitda = item.ebitdaMes < 0;
      const isNegVan = item.vanRestante < 0;
      let badge = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800">Rentable</span>`;
      if (isNegVan) {
        badge = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-100 text-rose-800">Cierre Óptimo</span>`;
      } else if (isNegEbitda) {
        badge = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800">Déficit Operativo</span>`;
      }

      rowsHtml += `
        <tr class="hover:bg-slate-50 transition-colors ${item.mesStr === data.fechaSugerida ? 'bg-amber-50/70 font-semibold' : ''}">
          <td class="py-1.5 px-3 font-mono text-[11px]">${item.mesStr}</td>
          <td class="py-1.5 px-2 text-right">$${item.ventaMes.toFixed(2)}</td>
          <td class="py-1.5 px-2 text-right font-medium text-turf-900">$${item.comisionMes.toFixed(2)}</td>
          <td class="py-1.5 px-2 text-right text-slate-600">$${item.costoFijoMes.toFixed(2)}</td>
          <td class="py-1.5 px-2 text-right font-bold ${isNegEbitda ? 'text-rose-600' : 'text-emerald-700'}">
            ${isNegEbitda ? '-' : '+'}$${Math.abs(item.ebitdaMes).toFixed(2)}
          </td>
          <td class="py-1.5 px-2 text-right text-slate-500">${(item.margenMesPct * 100).toFixed(1)}%</td>
          <td class="py-1.5 px-2 text-right text-emerald-700 font-medium">+$${item.ahorroNetoCierreMes.toFixed(2)}</td>
          <td class="py-1.5 px-2 text-right font-bold ${item.vanAcumulado >= 0 ? 'text-pizarra-900' : 'text-rose-600'}">
            $${item.vanAcumulado.toFixed(2)}
          </td>
          <td class="py-1.5 px-2 text-center">${badge}</td>
        </tr>
      `;
    });
  } else {
    data.resumenAnual.forEach(item => {
      const isNegEbitda = item.ebitdaAno < 0;
      const isNegVan = item.vanRestanteAno < 0;
      let badge = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800">Rentable</span>`;
      if (isNegVan) {
        badge = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-100 text-rose-800">Cierre Conveniente</span>`;
      } else if (isNegEbitda) {
        badge = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800">Déficit</span>`;
      }

      rowsHtml += `
        <tr class="hover:bg-slate-50 transition-colors">
          <td class="py-2 px-3 font-bold text-pizarra-900">${item.ano}</td>
          <td class="py-2 px-2 text-right">$${item.ventaAno.toFixed(2)}</td>
          <td class="py-2 px-2 text-right font-semibold text-turf-900">$${item.comisionAno.toFixed(2)}</td>
          <td class="py-2 px-2 text-right text-slate-600">$${item.costoFijoAno.toFixed(2)}</td>
          <td class="py-2 px-2 text-right font-bold ${isNegEbitda ? 'text-rose-600' : 'text-emerald-700'}">
            ${isNegEbitda ? '-' : '+'}$${Math.abs(item.ebitdaAno).toFixed(2)}
          </td>
          <td class="py-2 px-2 text-right text-slate-500">${(item.margenAnoPct * 100).toFixed(1)}%</td>
          <td class="py-2 px-2 text-right text-emerald-700 font-medium">+$${item.ahorroNetoAno.toFixed(2)}</td>
          <td class="py-2 px-2 text-right font-bold ${item.vanAcumuladoAno >= 0 ? 'text-pizarra-900' : 'text-rose-600'}">
            $${item.vanAcumuladoAno.toFixed(2)}
          </td>
          <td class="py-2 px-2 text-center">${badge}</td>
        </tr>
      `;
    });
  }

  cont.innerHTML = `
    <table class="w-full text-xs text-left border-collapse font-sans">
      <thead>
        <tr class="bg-slate-100 text-slate-700 font-bold border-b border-slate-300">
          <th class="py-2.5 px-3">Periodo</th>
          <th class="py-2.5 px-2 text-right">Venta / Handle</th>
          <th class="py-2.5 px-2 text-right">Comisión</th>
          <th class="py-2.5 px-2 text-right">Costos Fijos</th>
          <th class="py-2.5 px-2 text-right">EBITDA</th>
          <th class="py-2.5 px-2 text-right">Margen %</th>
          <th class="py-2.5 px-2 text-right">Ahorro Red</th>
          <th class="py-2.5 px-2 text-right">VAN Acumulado</th>
          <th class="py-2.5 px-2 text-center">Diagnóstico</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-slate-100">
        ${rowsHtml}
      </tbody>
    </table>
  `;
}

function renderLateralCierre(data) {
  const diag = $("cierreDiagnosticoDetalle");
  const impact = $("cierreImpactoRedDetalle");
  if (!diag || !impact) return;

  const { s, loc, tasaSedePropia, arriendoBaseCLP, otrosFijosBaseCLP, costoCierreCLP, physProb, digProb, lossProb } = data;

  const mcda = (typeof calcularPortafolioMCDA === "function") ? calcularPortafolioMCDA() : null;
  const lMcda = mcda?.locales?.find(x => String(x.id) === String(data.sedeId));

  diag.innerHTML = `
    <div class="py-1.5 flex justify-between items-center bg-slate-50 px-2 rounded-lg border border-slate-100">
      <span class="text-slate-600 font-semibold">Grupo en el plan:</span>
      <span class="font-extrabold px-2 py-0.5 rounded text-[11px] border ${(ETIQUETA_ARQ[lMcda?.arquetipo] || ETIQUETA_ARQ.REVISAR).clase}">
        ${lMcda ? ETIQUETA_ARQ[lMcda.arquetipo]?.txt || lMcda.arquetipo : "Evaluando"}
      </span>
    </div>
    <div class="py-1.5 flex justify-between">
      <span class="text-slate-500">Score Estratégico (0-100):</span>
      <span class="font-extrabold text-pizarra-900">${lMcda ? lMcda.scoreBase.toFixed(1) + " pts (" + lMcda.nivelBase + ")" : "-"}</span>
    </div>
    <div class="py-1.5 flex justify-between">
      <span class="text-slate-500">Certeza de la Recomendación:</span>
      <span class="font-semibold text-slate-700">${lMcda ? lMcda.robustez : "-"}</span>
    </div>
    <div class="py-1.5 flex justify-between">
      <span class="text-slate-500">Alerta de Arriendo:</span>
      <span class="font-semibold ${lMcda?.gateRenta === 'OK' ? 'text-emerald-700' : 'text-rose-600'}">${lMcda ? lMcda.gateRenta : "-"}</span>
    </div>
    <div class="py-1.5 flex justify-between border-t border-slate-100">
      <span class="text-slate-500">Grupo / Zona:</span>
      <span class="font-bold text-pizarra-900">${esc(s.grupo || loc.grupo)}</span>
    </div>
    <div class="py-1.5 flex justify-between">
      <span class="text-slate-500">Venta Base 12M:</span>
      <span class="font-bold text-pizarra-900">${fmt.clp(s.venta_12m_real || 0)}</span>
    </div>
    <div class="py-1.5 flex justify-between">
      <span class="text-slate-500">Takeout Efectivo:</span>
      <span class="font-bold text-turf-900">${(tasaSedePropia * 100).toFixed(1)}%</span>
    </div>
    <div class="py-1.5 flex justify-between">
      <span class="text-slate-500">Arriendo Mensual:</span>
      <span class="font-bold text-slate-800">${fmt.clp(arriendoBaseCLP)}</span>
    </div>
    <div class="py-1.5 flex justify-between">
      <span class="text-slate-500">Otros Fijos Mensual:</span>
      <span class="font-bold text-slate-800">${fmt.clp(otrosFijosBaseCLP)}</span>
    </div>
    <div class="py-1.5 flex justify-between">
      <span class="text-slate-500">Costo de Término / Cierre:</span>
      <span class="font-bold text-rose-800">${costoCierreCLP > 0 ? fmt.clp(costoCierreCLP) : "Sin costo estipulado"}</span>
    </div>
  `;

  impact.innerHTML = `
    <div class="space-y-1">
      <div class="flex justify-between text-[11px]">
        <span class="text-slate-600 font-medium">Migración a otros locales presenciales:</span>
        <span class="font-extrabold text-turf-800">${(physProb * 100).toFixed(1)}%</span>
      </div>
      <div class="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
        <div class="bg-turf-700 h-1.5 rounded-full" style="width: ${Math.min(100, Math.round(physProb * 100))}%"></div>
      </div>
    </div>

    <div class="space-y-1 pt-1.5">
      <div class="flex justify-between text-[11px]">
        <span class="text-slate-600 font-medium">Migración a Canal Digital (Teletrak.cl):</span>
        <span class="font-extrabold text-sky-800">${(digProb * 100).toFixed(1)}%</span>
      </div>
      <div class="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
        <div class="bg-sky-600 h-1.5 rounded-full" style="width: ${Math.min(100, Math.round(digProb * 100))}%"></div>
      </div>
    </div>

    <div class="space-y-1 pt-1.5">
      <div class="flex justify-between text-[11px]">
        <span class="text-slate-600 font-medium">Fuga Neta Fuera del Sistema:</span>
        <span class="font-extrabold text-slate-600">${(lossProb * 100).toFixed(1)}%</span>
      </div>
      <div class="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
        <div class="bg-slate-400 h-1.5 rounded-full" style="width: ${Math.min(100, Math.round(lossProb * 100))}%"></div>
      </div>
    </div>

    <div class="pt-2">
      <button type="button" onclick="cerrarSedeEnMesOptimo('${data.sedeId}', ${data.corteOptimo?.mesIndex || 1})"
              class="w-full py-2 px-3 rounded-lg text-xs font-bold bg-amber-600 hover:bg-amber-700 text-white shadow-xs transition-all cursor-pointer">
        Simular Cierre de esta Sede en Mes ${data.corteOptimo?.mesIndex || 1} (${nombreMesSim(data.corteOptimo?.mesIndex || 1)})
      </button>
    </div>
  `;
}

function descargarCSVCierre() {
  const sedeId = APP.sedeCierreSel || $("selSedeCierre")?.value;
  if (!sedeId) return;
  const data = calcularCierreSede(sedeId);
  if (!data) return;

  const modo = APP.modoCierreTemporal || "mensual";
  let csv = "";

  if (modo === "mensual") {
    csv = [
      ["Periodo", "Venta_MM_CLP", "Comision_MM_CLP", "CostosFijos_MM_CLP", "EBITDA_MM_CLP", "Margen_Pct", "AhorroNetoRed_MM_CLP", "VAN_Acumulado_MM_CLP"],
      ...data.mesesDetalle.map(item => [
        item.mesStr,
        item.ventaMes.toFixed(3),
        item.comisionMes.toFixed(3),
        item.costoFijoMes.toFixed(3),
        item.ebitdaMes.toFixed(3),
        (item.margenMesPct * 100).toFixed(2) + "%",
        item.ahorroNetoCierreMes.toFixed(3),
        item.vanAcumulado.toFixed(3)
      ])
    ].map(row => row.join(";")).join("\n");
  } else {
    csv = [
      ["Ano", "Venta_MM_CLP", "Comision_MM_CLP", "CostosFijos_MM_CLP", "EBITDA_MM_CLP", "Margen_Pct", "AhorroNetoRed_MM_CLP", "VAN_Acumulado_MM_CLP"],
      ...data.resumenAnual.map(item => [
        item.ano,
        item.ventaAno.toFixed(3),
        item.comisionAno.toFixed(3),
        item.costoFijoAno.toFixed(3),
        item.ebitdaAno.toFixed(3),
        (item.margenAnoPct * 100).toFixed(2) + "%",
        item.ahorroNetoAno.toFixed(3),
        item.vanAcumuladoAno.toFixed(3)
      ])
    ].map(row => row.join(";")).join("\n");
  }

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `cierre_estimado_${sedeId}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}


// =====================================================================
// PESTANA SIMULACION ESTOCASTICA DE VAN (tab-simulacion)
// =====================================================================
const SIM = {
  alcance: "FASE_1",
  sedeSel: null,
  iteraciones: 1000,
  escalaMf: 1.00,
  baseMd: 0.10,
  shockG: 0.0,
  wacc: 0.105,
  spreadCostos: 0.0,
  topeCap: 0.25,
  filtroTexto: "",
  filtroClasificacion: "TODAS",
  chartDensidad: null,
  chartTornado: null,
  chartCartera: null,
  sedesInsumos: [],
  resultadosMC: [],
  sedeSimMap: new Map()
};

function simMulberry32(seed) {
  let a = seed >>> 0;
  return function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function simCreateBoxMuller(prng) {
  let hasSpare = false;
  let spare = 0;
  return function(mean, std) {
    if (hasSpare) {
      hasSpare = false;
      return (mean || 0) + (std || 1) * spare;
    }
    let u = 0, v = 0;
    while (u === 0) u = prng();
    while (v === 0) v = prng();
    const mag = Math.sqrt(-2.0 * Math.log(u));
    spare = mag * Math.sin(2.0 * Math.PI * v);
    hasSpare = true;
    return (mean || 0) + (std || 1) * (mag * Math.cos(2.0 * Math.PI * v));
  };
}

function simSampleTriangular(prng, a, m, b) {
  if (b <= a) return a;
  const u = prng();
  const c = (m - a) / (b - a);
  if (u < c) {
    return a + Math.sqrt(u * (b - a) * (m - a));
  } else {
    return b - Math.sqrt((1.0 - u) * (b - a) * (b - m));
  }
}

function simSampleGamma(prng, norm, alpha) {
  if (alpha < 1.0) {
    const u = prng();
    return simSampleGamma(prng, norm, 1.0 + alpha) * Math.pow(u, 1.0 / alpha);
  }
  const d = alpha - 1.0 / 3.0;
  const c = 1.0 / Math.sqrt(9.0 * d);
  while (true) {
    let z = norm(0, 1);
    let v = 1.0 + c * z;
    if (v <= 0) continue;
    v = v * v * v;
    const u = prng();
    if (u < 1.0 - 0.0331 * z * z * z * z) return d * v;
    if (Math.log(u) < 0.5 * z * z + d * (1.0 - v + Math.log(v))) return d * v;
  }
}

function simSampleBeta(prng, norm, alpha, beta) {
  const x = simSampleGamma(prng, norm, alpha);
  const y = simSampleGamma(prng, norm, beta);
  return (x + y > 0) ? (x / (x + y)) : 0.5;
}

function simSamplePert(prng, norm, a, m, b) {
  if (b - a < 1e-7 || m <= a || m >= b) return m;
  const alpha = 1.0 + 4.0 * (m - a) / (b - a);
  const beta = 1.0 + 4.0 * (b - m) / (b - a);
  return a + (b - a) * simSampleBeta(prng, norm, alpha, beta);
}

// Motor de la pestana: el VAN de cerrar cada sede en su fecha del plan, con el mismo modelo y los mismos sorteos que usa el
// calendario (sorteosMC). Decididos: en su fecha. Propuestos: en la fecha elegida. Red minima: en su mejor fecha.
// Los vectores van en pesos (los graficos dividen por 1e6).
const ETIQUETA_SIM = { DECIDIDO: "Cierre decidido", PROPUESTO: "Cierre firme", CONDICIONADO: "Cierre condicionado", "RED MÍNIMA": "Red mínima" };
function simCorrerMotor() {
  if (!APP.est || !DASHBOARD_DATA) return;
  if (!APP._porId || !APP._alt) prepararCategorias();
  const cal = calendarioCierres(), M = APP._calMemo.mantiene, inicio = sumarMeses(historia().corte, 1), fin = finPlan();
  const abiertasEn = (id, t) => conUso(DASHBOARD_DATA.huff_ids.filter((j) => j !== id && !(cal[j] && cal[j].mes <= t)), id, t, APP._calMemo.libro);
  const resultados = [], sedeSimMap = new Map();
  for (const s of APP.est.sedes.filter((x) => x.grupo !== "DIGITAL" && (cal[x.sede_id] || (M[x.sede_id] && !M[x.sede_id].sinDatos && !M[x.sede_id].externaliza && !M[x.sede_id].renegociada)) && DASHBOARD_DATA.locales[x.sede_id])) {
    const id = s.sede_id, k = cal[id], x = M[id], mes = k ? k.mes : x.mes || fin;
    const B = baseCierre(s, abiertasEn(id, mes), inicio, new Set()), mc = mcCierre(B, [mes])[0];
    // Retencion de equilibrio: el VAN es lineal en la retencion total; la que deja el VAN del caso base en cero
    const v0 = vanDesdeBase(B, [mes], { ...pBase(B), R: 0 }).opciones[0].van, v1 = vanDesdeBase(B, [mes], { ...pBase(B), R: 1 }).opciones[0].van;
    const ret_be = v0 >= 0 ? 0 : v1 <= 0 ? 1 : -v0 / (v1 - v0);
    const clase = k?.tipo === "decidido" ? "DECIDIDO" : k?.firme ? "PROPUESTO" : k || x?.seguimiento ? "CONDICIONADO" : "RED MÍNIMA";
    const fila = {
      sede_id: id, nombre: s.nombre || id, grupo: s.grupo || "", comuna: s.comuna || "", mes,
      venta_base_real: s.venta_12m_real || 0, costos_fijos_anual: (s.arriendo_mensual_clp || 0) * 12 + (s.otros_fijos_anual_clp || 0),
      costo_cierre_clp: s.costo_cierre_clp || 0, mf_top3: B.e.physProb, mf_full: B.e.physFull, md_moda: B.e.digProb,
      van_base: vanDesdeBase(B, [mes]).opciones[0].van * 1e6,
      delta_van_p10: mc.p10 * 1e6, delta_van_p50: mc.p50 * 1e6, delta_van_p90: mc.p90 * 1e6, delta_van_media: mc.media * 1e6,
      prob_exito_cierre: mc.prob, cvar_5: mc.cvar5 * 1e6, retencion_esperada: mc.retEsp, retencion_breakeven: ret_be,
      clasificacion_sim: clase, vectorDeltaVan: mc.vector.map((v) => v * 1e6), _B: B,
    };
    resultados.push(fila); sedeSimMap.set(id, fila);
  }
  SIM.sedesInsumos = resultados;
  SIM.resultadosMC = resultados;
  SIM.sedeSimMap = sedeSimMap;
}

function simObtenerSedesEvaluadas() {
  const closedStores = state.closedStores || new Set();
  if (SIM.alcance === "CARTERA_ACTUAL") return SIM.resultadosMC.filter((s) => closedStores.has(s.sede_id));
  if (SIM.alcance === "FASE_1") return SIM.resultadosMC.filter((s) => s.clasificacion_sim === "PROPUESTO");
  if (SIM.alcance === "FASE_1_2") return SIM.resultadosMC.filter((s) => s.clasificacion_sim === "DECIDIDO" || s.clasificacion_sim === "PROPUESTO" || (s.clasificacion_sim === "CONDICIONADO" && calendarioCierres()[s.sede_id]));
  if (SIM.alcance === "SEDE_INDIVIDUAL") {
    const sel = SIM.sedeSel || SIM.resultadosMC[0]?.sede_id;
    return SIM.resultadosMC.filter((s) => s.sede_id === sel);
  }
  return [];
}

// Cartera: como todas las sedes usan los mismos sorteos, el VAN conjunto de cada escenario es la suma de los VAN de sus
// cierres (la interaccion entre cierres ya esta en las receptoras de cada uno: las sedes abiertas en su fecha)
function simCalcularCarteraConjunta(evaluadas) {
  const N = SIM.iteraciones, y = new Float64Array(N);
  if (!evaluadas || !evaluadas.length) return { n_sedes: 0, vectorConjunto: y };
  let sumRetEsp = 0, sumRetBe = 0, base = 0;
  for (const s of evaluadas) {
    sumRetEsp += s.retencion_esperada; sumRetBe += s.retencion_breakeven; base += s.van_base;
    for (let i = 0; i < N; i++) y[i] += s.vectorDeltaVan[i];
  }
  const x = Float64Array.from(y).sort(), q = (f) => x[Math.min(N - 1, Math.floor(N * f))];
  let sum = 0, pos = 0;
  for (const v of x) { sum += v; if (v > 0) pos++; }
  const cola = x.slice(0, Math.max(1, Math.floor(N * 0.05)));
  return {
    n_sedes: evaluadas.length, van_base: base,
    y_conj_p10: q(0.1), y_conj_p50: q(0.5), y_conj_p90: q(0.9),
    media: sum / N, probExito: pos / N, cvar5: cola.reduce((a, v) => a + v, 0) / cola.length,
    vectorConjunto: y, ret_esp_media: sumRetEsp / evaluadas.length, ret_be_media: sumRetBe / evaluadas.length,
  };
}

// Supuestos del caso base en el formato de un sorteo (para la sensibilidad y la retencion de equilibrio)
const pBase = (B) => ({ rA: tasaEfectiva(), dc: SIM.spreadCostos, phi: amortiguacion(), fo: APP.factorCostoOnline ?? 0.15,
  mf: B.e.physProb * SIM.escalaMf, md: B.md, dg: SIM.shockG, eps: null, uSal: null });
function simRenderizarGraficoDensidad(conjunto) {
  const ctx = document.getElementById("chartSimulacionDensidad")?.getContext("2d");
  if (!ctx) return;
  if (SIM.chartDensidad) SIM.chartDensidad.destroy();

  if (!conjunto || conjunto.n_sedes === 0) {
    SIM.chartDensidad = new Chart(ctx, {
      type: "bar",
      data: { labels: ["Sin datos"], datasets: [{ data: [0] }] },
      options: { responsive: true, maintainAspectRatio: false }
    });
    return;
  }

  const vec = conjunto.vectorConjunto;
  const N = vec.length;
  let minV = Infinity, maxV = -Infinity;
  for (let i = 0; i < N; i++) {
    const v = vec[i] / 1e6;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  if (minV === maxV) { minV -= 10; maxV += 10; }

  const numBins = 40;
  const binWidth = (maxV - minV) / numBins;
  const counts = new Int32Array(numBins);
  const binEdges = [];
  for (let b = 0; b < numBins; b++) {
    binEdges.push(minV + (b + 0.5) * binWidth);
  }

  for (let i = 0; i < N; i++) {
    const val = vec[i] / 1e6;
    let idx = Math.floor((val - minV) / binWidth);
    if (idx < 0) idx = 0;
    if (idx >= numBins) idx = numBins - 1;
    counts[idx]++;
  }

  const bgColors = binEdges.map(x => x < 0 ? "rgba(184, 111, 118, 0.85)" : "rgba(0, 48, 88, 0.85)");
  const borderColors = binEdges.map(x => x < 0 ? "#C2410C" : "#002444");

  const p10_mm = (conjunto.y_conj_p10 / 1e6).toFixed(1);
  const p50_mm = (conjunto.y_conj_p50 / 1e6).toFixed(1);
  const p90_mm = (conjunto.y_conj_p90 / 1e6).toFixed(1);
  const subElem = document.getElementById("simDensidadSub");
  if (subElem) {
    subElem.textContent = `P10: $${p10_mm}M | P50: $${p50_mm}M | P90: $${p90_mm}M (MM CLP)`;
  }

  SIM.chartDensidad = new Chart(ctx, {
    type: "bar",
    data: {
      labels: binEdges.map(x => x.toFixed(1)),
      datasets: [{
        label: "Frecuencia de Escenarios",
        data: Array.from(counts),
        backgroundColor: bgColors,
        borderColor: borderColors,
        borderWidth: 1,
        barPercentage: 1.0,
        categoryPercentage: 1.0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => `VAN cerca de ${mm(binEdges[items[0].dataIndex], true)}`,
            label: (item) => `Escenarios: ${item.parsed.y} (${(item.parsed.y / N * 100).toFixed(1)}%)`
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            maxTicksLimit: 10,
            font: { size: 10 },
            maxRotation: 0,
            callback: (v, idx) => mm(binEdges[idx] ?? 0)
          }
        },
        y: {
          grid: { color: "rgba(226, 232, 240, 0.8)" },
          ticks: { font: { size: 10 } }
        }
      }
    }
  });
}

function simActualizarKPIs(conjunto) {
  const set = (id, txt, cls) => { const el = $(id); if (el) { el.textContent = txt; if (cls) el.className = cls; } };
  const ids = ["simKpiDeltaVanP50", "simKpiBandaConfianza", "simKpiProbExito", "simKpiCvar5", "simKpiRetencion"];
  ids.forEach((id) => set(id + "Sub", ""));
  if (!conjunto || !conjunto.n_sedes) { ids.forEach((id) => set(id, "-")); return; }
  const v = (x) => mm(x / 1e6, true), color = (x) => `text-xl font-extrabold ${x >= 0 ? "text-emerald-700" : "text-rose-700"}`;
  set("simKpiDeltaVanP50", v(conjunto.y_conj_p50), color(conjunto.y_conj_p50));
  set("simKpiDeltaVanP50Sub", `VAN del plan, caso base: ${v(conjunto.van_base)}`);
  set("simKpiBandaConfianza", `${v(conjunto.y_conj_p10)} a ${v(conjunto.y_conj_p90)}`, "text-base font-extrabold text-slate-900");
  set("simKpiProbExito", `${fmt.num(conjunto.probExito * 100, 0)}%`,
    `text-xl font-extrabold ${conjunto.probExito >= probMin() ? "text-emerald-700" : conjunto.probExito >= 0.5 ? "text-amber-600" : "text-rose-700"}`);
  set("simKpiProbExitoSub", `Mínimo para proponer un cierre: ${fmt.num(probMin() * 100, 0)}%`);
  set("simKpiCvar5", v(conjunto.cvar5), color(conjunto.cvar5));
  set("simKpiRetencion", `${fmt.num(conjunto.ret_esp_media * 100, 1)}% y ${fmt.num(conjunto.ret_be_media * 100, 1)}%`, "text-xl font-extrabold text-slate-900");
  set("simKpiRetencionSub", "Promedio de las sedes evaluadas");
}

function simRenderizarTablaRanking() {
  const container = $("simTablaRankingContainer");
  if (!container) return;
  const txt = (SIM.filtroTexto || "").trim().toLowerCase(), clasifFiltro = SIM.filtroClasificacion || "TODAS";
  const closedStores = state.closedStores || new Set();
  let filas = SIM.resultadosMC || [];
  if (clasifFiltro !== "TODAS") filas = filas.filter((f) => f.clasificacion_sim === clasifFiltro);
  if (txt) filas = filas.filter((f) => [f.sede_id, f.nombre, f.comuna, f.grupo].some((x) => (x || "").toLowerCase().includes(txt)));
  if ($("simConteoFilas")) $("simConteoFilas").textContent = `${filas.length} sedes`;
  if (!filas.length) { container.innerHTML = `<div class="p-8 text-center text-xs text-slate-400">No hay sedes con ese filtro.</div>`; return; }
  const orden = { DECIDIDO: 0, PROPUESTO: 1, CONDICIONADO: 2, "RED MÍNIMA": 3 };
  filas = [...filas].sort((a, b) => orden[a.clasificacion_sim] - orden[b.clasificacion_sim] || (a.clasificacion_sim === "RED MÍNIMA" ? b.prob_exito_cierre - a.prob_exito_cierre : a.mes < b.mes ? -1 : 1));
  const m = (x) => mm(x / 1e6, true), pc = (x) => `${fmt.num(x * 100, 1)}%`;
  const th = (t, cls = "text-right") => `<th class="py-2 px-3 ${cls} font-semibold whitespace-nowrap">${t}</th>`;
  const td = (t, cls = "text-right") => `<td class="py-1.5 px-3 ${cls} tabular-nums whitespace-nowrap">${t}</td>`;
  container.innerHTML = `<table class="w-full text-xs border-collapse" id="simTablaRanking"><thead><tr class="text-slate-500 border-b border-slate-200 sticky top-0 bg-white z-10">
    ${th("Cerrar", "text-center")}${th("Sede", "text-left")}${th("En el plan", "text-left")}${th("Fecha", "text-left")}${th("Retención física")}${th("Retención digital")}
    ${th("Retención de equilibrio")}${th("VAN caso base")}${th("P10")}${th("P50")}${th("P90")}${th("Probabilidad VAN positivo")}${th("Peor 5%")}</tr></thead>
    <tbody class="divide-y divide-slate-100">${filas.map((r) => {
      const plan = r.clasificacion_sim !== "RED MÍNIMA";
      return `<tr class="${plan ? "font-medium" : "text-slate-600"} hover:bg-slate-50">
        <td class="py-1.5 px-3 text-center"><input type="checkbox" ${closedStores.has(r.sede_id) ? "checked" : ""} onchange="window.simToggleCierreSede('${r.sede_id}', this.checked)" class="rounded text-[#003058] focus:ring-0 cursor-pointer"></td>
        <td class="py-1.5 px-3 text-slate-900 cursor-pointer hover:text-[#003058] whitespace-nowrap" onclick="window.simSeleccionarSede('${r.sede_id}')">${esc(nombreLindo(r.nombre))}</td>
        ${td(ETIQUETA_SIM[r.clasificacion_sim], "text-left")}${td(nombreMes(r.mes), "text-left")}
        ${td(pc(r.mf_top3))}${td(pc(r.md_moda))}${td(pc(r.retencion_breakeven))}
        ${td(m(r.van_base), "text-right font-semibold")}${td(m(r.delta_van_p10))}${td(m(r.delta_van_p50))}${td(m(r.delta_van_p90))}
        ${td(`${fmt.num(r.prob_exito_cierre * 100, 0)}%`, `text-right font-semibold ${r.prob_exito_cierre >= probMin() ? "text-emerald-800" : "text-slate-700"}`)}${td(m(r.cvar_5))}</tr>`;
    }).join("")}</tbody></table>`;
}

function simPoblarSelectSedes() {
  const sel = $("simSelSede");
  if (!sel || !SIM.sedesInsumos.length) return;
  const prev = sel.value;
  sel.innerHTML = [...SIM.sedesInsumos].sort((a, b) => (nombreLindo(a.nombre) < nombreLindo(b.nombre) ? -1 : 1))
    .map((s) => `<option value="${s.sede_id}">${esc(nombreLindo(s.nombre))}</option>`).join("");
  if (prev && SIM.sedeSimMap.has(prev)) { sel.value = prev; SIM.sedeSel = prev; } else SIM.sedeSel = sel.value;
}

// Controles de Riesgo: numero de escenarios y que cierres se evaluan (los supuestos se mueven en Sensibilidad)
function simSincronizarControles() {
  if ($("simIteraciones")) $("simIteraciones").value = SIM.iteraciones;
  const r = document.querySelector(`input[name="simAlcance"][value="${SIM.alcance}"]`); if (r) r.checked = true;
}

function pintarSimulacion() {
  if (!APP.est || !DASHBOARD_DATA) return;
  simSincronizarControles();
  simCorrerMotor();
  simPoblarSelectSedes();
  const evaluadas = simObtenerSedesEvaluadas(), conjunto = simCalcularCarteraConjunta(evaluadas);
  const R = SIM.resultadosMC, n = (c) => R.filter((r) => r.clasificacion_sim === c).length;
  if ($("simResumen")) $("simResumen").textContent = `${SIM.iteraciones} escenarios. ${n("DECIDIDO")} cierres decididos, ${n("PROPUESTO")} firmes (VAN positivo en al menos el ${fmt.num(probMin() * 100, 0)}% de los escenarios), ${n("CONDICIONADO")} condicionados y ${n("RED MÍNIMA")} sedes en la red mínima.`;
  simActualizarKPIs(conjunto);
  simRenderizarGraficoDensidad(conjunto);
  const sub = $("simDensidadSub"); if (sub && conjunto.n_sedes) sub.textContent = `${conjunto.n_sedes} ${conjunto.n_sedes === 1 ? "sede" : "sedes"}: P10 ${mm(conjunto.y_conj_p10 / 1e6, true)}, P50 ${mm(conjunto.y_conj_p50 / 1e6, true)}, P90 ${mm(conjunto.y_conj_p90 / 1e6, true)}`;
  // Los cierres marcados a mano pueden no ser los del plan: se dice cuales difieren
  if (SIM.alcance === "CARTERA_ACTUAL" && $("simResumen")) {
    const enPlan = new Set(Object.keys(calendarioCierres())), marc = state.closedStores || new Set();
    const nom = (id) => nombreLindo(APP._porId[id]?.nombre || id);
    const mas = [...marc].filter((id) => !enPlan.has(id)).map(nom), menos = [...enPlan].filter((id) => !marc.has(id)).map(nom);
    if (mas.length || menos.length) $("simResumen").textContent += ` Los cierres marcados difieren del plan${mas.length ? `: marcados fuera del plan ${mas.join(", ")}` : ""}${menos.length ? `${mas.length ? ". Sin marcar" : ": sin marcar"} ${menos.join(", ")}` : ""}.`;
  }
  simRenderizarTablaRanking();
}

window.simRecalcular = function() {
  SIM.iteraciones = Number($("simIteraciones")?.value) || 1000;
  APP._calMemo = null;
  pintarSimulacion();
};

window.simCambiarAlcance = function(nuevoAlcance) {
  SIM.alcance = nuevoAlcance;
  pintarSimulacion();
};

window.simCambiarSedeSel = function(sedeId) {
  SIM.sedeSel = sedeId;
  const rInd = document.querySelector('input[name="simAlcance"][value="SEDE_INDIVIDUAL"]');
  if (rInd) rInd.checked = true;
  SIM.alcance = "SEDE_INDIVIDUAL";
  pintarSimulacion();
};

window.simSeleccionarSede = function(sedeId) {
  const sel = document.getElementById("simSelSede");
  if (sel) sel.value = sedeId;
  window.simCambiarSedeSel(sedeId);
};

window.simToggleCierreSede = function(sedeId, check) {
  if (!state.closedStores) state.closedStores = new Set();
  if (check) {
    state.closedStores.add(sedeId);
  } else {
    state.closedStores.delete(sedeId);
  }
  renderAll();
  window.alCambiarSimulador();
};

window.simFiltrarTabla = function() {
  const txtInput = document.getElementById("simFiltroTexto");
  const clasifSelect = document.getElementById("simFiltroClasificacion");
  SIM.filtroTexto = txtInput ? txtInput.value : "";
  SIM.filtroClasificacion = clasifSelect ? clasifSelect.value : "TODAS";
  simRenderizarTablaRanking();
};

window.simExportarCSV = function() {
  const filas = SIM.resultadosMC || [];
  if (!filas.length) return;
  const closedStores = state.closedStores || new Set(), q = (x) => `"${String(x ?? "").replace(/"/g, '""')}"`, $$ = (x) => Math.round(x);
  const lineas = [
    ["Sede_ID", "Nombre", "En_el_plan", "Fecha_cierre", "Retencion_fisica_pct", "Retencion_digital_pct", "Retencion_equilibrio_pct",
      "VAN_caso_base_CLP", "VAN_P10_CLP", "VAN_P50_CLP", "VAN_P90_CLP", "VAN_media_CLP", "Prob_VAN_positivo_pct", "Peor_5pct_CLP", "Escenarios", "Cerrada_en_Demanda"].join(";"),
    ...filas.map((f) => [f.sede_id, q(f.nombre), q(ETIQUETA_SIM[f.clasificacion_sim]), f.mes, (f.mf_top3 * 100).toFixed(2), (f.md_moda * 100).toFixed(2),
      (f.retencion_breakeven * 100).toFixed(2), $$(f.van_base), $$(f.delta_van_p10), $$(f.delta_van_p50), $$(f.delta_van_p90), $$(f.delta_van_media),
      (f.prob_exito_cierre * 100).toFixed(1), $$(f.cvar_5), SIM.iteraciones, closedStores.has(f.sede_id) ? "SI" : "NO"].join(";")),
  ];
  const blob = new Blob(["\ufeff" + lineas.join("\n")], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `riesgo_plan_cierres_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
};
// Que cierres se evaluan: un solo estado (SIM.alcance) para Riesgo y Sensibilidad. Sensibilidad no evalua los decididos
// (ya estan resueltos), asi que "Cierres firmes" = FASE_1 y cualquier otro alcance = firmes y condicionados.
const soloFirmes = () => SIM.alcance === "FASE_1";
// =====================================================================
// Sensibilidad y flexibilidad del plan
// Sensibilidad: el plan completo (cuantos cierres y su VAN) con cada supuesto en un valor bajo y uno alto.
// Flexibilidad: que pasa si los cierres se postergan 1 a 3 anos (a la primera ventana de contrato despues del atraso), y el
// valor de esperar un ano para decidir con la venta observada (opcion real: en cada escenario se cierra solo si conviene).
// =====================================================================
function resumenPlanActual() {
  const G = gruposPlan();
  const ids = (g) => g.map(([id]) => id);
  return { f: G.firmes.length, c: G.condicionados.length, s: G.seguimiento.length, van: [...G.firmes, ...G.condicionados].reduce((a, [, k]) => a + (k.van || 0), 0),
    ids: { f: ids(G.firmes), c: ids(G.condicionados), s: ids(G.seguimiento) } };
}
function casosSensibilidad() {
  const f0 = { ...finz() }, t0 = APP.tasaDescuento, mig0 = APP.migracion || "modelo", u00 = state.u0, rd0 = APP.retencionDigital;
  const fin = (o) => () => { APP.finanzas = { ...f0, ...o }; };
  const pc = (x) => `${fmt.num(x * 100, 1)}%`;
  return {
    restaurar: () => { APP.finanzas = f0; APP.tasaDescuento = t0; APP.migracion = mig0; state.u0 = u00; APP.retencionDigital = rd0; },
    casos: [
      ["Tasa de descuento (WACC nominal)", pc(t0 - 0.015), pc(t0 + 0.015), () => { APP.tasaDescuento = t0 - 0.015; }, () => { APP.tasaDescuento = t0 + 0.015; }],
      ["Alza real de los gastos", "-1 punto", "+1 punto", fin({ crecArriendo: f0.crecArriendo - 0.01, crecOtros: f0.crecOtros - 0.01 }), fin({ crecArriendo: f0.crecArriendo + 0.01, crecOtros: f0.crecOtros + 0.01 })],
      ["Persistencia de la tendencia", `${Math.round(((f0.amortiguacion ?? 1) - 0.15) * 100)}%`, `${Math.round((f0.amortiguacion ?? 1) * 100)}%`, fin({ amortiguacion: (f0.amortiguacion ?? 1) - 0.15 }), fin({})],
      ["Probabilidad mínima de VAN positivo", `${Math.round(((f0.probMin ?? 0.8) - 0.1) * 100)}%`, `${Math.round(((f0.probMin ?? 0.8) + 0.1) * 100)}%`, fin({ probMin: (f0.probMin ?? 0.8) - 0.1 }), fin({ probMin: Math.min(0.99, (f0.probMin ?? 0.8) + 0.1) })],
      ["Migración de clientes", "Modelo Huff", "Supuesto HCH (30%)", () => aplicarMigracion("modelo", false), () => aplicarMigracion("conservadora", false)],
      ["Programa digital en sedes sin alternativa", "Sin programa", "Meta 40%, $20.000.000 por sede", fin({ metaDigital: 0 }), fin({ metaDigital: 0.4, costoPrograma: 20 })],
    ],
  };
}
// Se calcula de a un caso por vez para no congelar la pagina; se recuerda mientras no cambien los supuestos
function calcularSensibilidad(alAvanzar) {
  calendarioCierres();
  const clave = APP._calMemo.clave;
  if (APP._sens?.clave === clave && APP._sens.listo) return alAvanzar(APP._sens);
  if (APP._sens?.clave === clave) return;   // ya en curso
  const S = (APP._sens = { clave, base: resumenPlanActual(), filas: [], listo: false });
  const { casos, restaurar } = casosSensibilidad();
  let i = 0;
  const paso = () => {
    if (APP._sens !== S) return;
    const [n, lb, lh, bajo, alto] = casos[i];
    bajo(); APP._calMemo = null; APP._sorteos = null; const L = resumenPlanActual();
    alto(); APP._calMemo = null; APP._sorteos = null; const H = resumenPlanActual();
    restaurar(); APP._calMemo = null; APP._sorteos = null; calendarioCierres();
    S.filas.push({ n, lb, lh, L, H }); i++;
    if (i >= casos.length) S.listo = true;
    alAvanzar(S);
    if (!S.listo) setTimeout(paso, 30);
  };
  alAvanzar(S);
  setTimeout(paso, 30);
}
function pintarSensibilidad(S) {
  if (APP.tab !== "sensibilidad" || !$("sens-tabla")) return;
  // La tabla se muestra entera cuando terminan todos los casos; mientras, solo el avance
  if (!S.listo) {
    const n = casosSensibilidad().casos.length, k = S.filas.length;
    $("sens-estado").textContent = `(calculando ${k} de ${n})`;
    $("sens-tabla").innerHTML = `<div class="py-3"><div class="h-1.5 w-full max-w-md bg-slate-200 rounded-full overflow-hidden"><div class="h-full bg-[#003058] transition-all" style="width:${Math.round((k / n) * 100)}%"></div></div></div>`;
    return;
  }
  $("sens-estado").textContent = "";
  // Cada escenario en una fila: composicion del plan (barra apilada), cambio en cada grupo y VAN frente al caso base (barra
  // divergente). Al hacer clic se listan las sedes que cambian de grupo.
  const GR = [["f", "Firmes", "#003058", "#fff"], ["c", "Condicionados", "#5b8fd4", "#fff"], ["s", "En seguimiento", "#c3d5ee", "#1f2937"]];
  const casos = [{ k: "base", n: "Caso base", v: "", x: S.base }, ...S.filas.flatMap((r, i) => [{ k: `${i}L`, n: r.n, v: r.lb, x: r.L, i }, { k: `${i}H`, n: r.n, v: r.lh, x: r.H, i }])];
  const maxTot = Math.max(1, ...casos.map(({ x }) => x.f + x.c + x.s)), maxDif = Math.max(1, ...casos.map(({ x }) => Math.abs(x.van - S.base.van)));
  if (!casos.some((c) => c.k === APP._sensSel)) APP._sensSel = casos.find((c) => c.k !== "base" && Math.abs(c.x.van - S.base.van) >= 0.5)?.k || "base";
  const barra = (x) => `<div class="flex h-5 rounded overflow-hidden bg-slate-100" style="width:${((x.f + x.c + x.s) / maxTot) * 100}%">${GR.map(([g, t, bg, fg]) => x[g]
    ? `<div class="flex items-center justify-center text-[10px] font-semibold border-r-2 border-white last:border-r-0" style="width:${(x[g] / (x.f + x.c + x.s)) * 100}%;background:${bg};color:${fg}" title="${t}: ${x[g]}">${x[g]}</div>` : "").join("")}</div>`;
  const cambios = (x) => GR.map(([g, t]) => { const d = x[g] - S.base[g]; return d ? `<span class="${d > 0 ? "text-[#2a78d6]" : "text-[#c03a39]"}">${d > 0 ? "+" : "−"}${Math.abs(d)} ${t.toLowerCase()}</span>` : ""; }).filter(Boolean).join(" · ") || `<span class="text-slate-400">sin cambios</span>`;
  const difVan = (x) => { const d = x.van - S.base.van, w = (Math.abs(d) / maxDif) * 50;
    return `<div class="relative h-3 w-full"><div class="absolute inset-y-0 left-1/2 w-px bg-slate-300"></div>${Math.abs(d) >= 0.5 ? `<div class="absolute inset-y-0 rounded-sm" style="${d > 0 ? "left:50%" : `left:${50 - w}%`};width:${w}%;background:${d > 0 ? "#2a78d6" : "#e34948"}"></div>` : ""}</div>
      <div class="text-[11px] text-right ${d > 0.5 ? "text-[#1f5fae]" : d < -0.5 ? "text-[#c03a39]" : "text-slate-400"}">${Math.abs(d) < 0.5 ? "igual" : mm(d, true)}</div>`; };
  const fila = (c) => `<button type="button" data-k="${c.k}" class="w-full grid grid-cols-12 gap-3 items-center text-left px-2 py-1.5 rounded-lg border ${c.k === APP._sensSel ? "border-[#003058] bg-slate-50" : "border-transparent hover:bg-slate-50"}">
      <span class="col-span-12 md:col-span-2 text-slate-700 font-medium">${c.k === "base" ? "Caso base" : esc(c.v)}</span>
      <span class="col-span-12 md:col-span-4">${barra(c.x)}</span>
      <span class="col-span-12 md:col-span-3 text-[11px]">${c.k === "base" ? `<span class="text-slate-500">${S.base.f + S.base.c} cierres en el plan</span>` : cambios(c.x)}</span>
      <span class="col-span-12 md:col-span-3"><div class="text-right font-semibold text-slate-900">${mm(c.x.van, true)}</div>${c.k === "base" ? "" : difVan(c.x)}</span></button>`;
  const leyenda = GR.map(([, t, bg]) => `<span class="inline-flex items-center gap-1"><span class="w-3 h-3 rounded-sm inline-block" style="background:${bg}"></span>${t}</span>`).join("");
  const sel = casos.find((c) => c.k === APP._sensSel);
  $("sens-tabla").innerHTML = `<div class="grid grid-cols-1 xl:grid-cols-3 gap-5">
    <div class="xl:col-span-2 space-y-1">
      <div class="hidden md:grid grid-cols-12 gap-3 px-2 pb-1 text-[11px] font-semibold text-slate-500 border-b border-slate-200">
        <span class="col-span-2">Escenario</span><span class="col-span-4 flex flex-wrap gap-3 font-normal">${leyenda}</span><span class="col-span-3">Cambio en el plan</span><span class="col-span-3 text-right">VAN del plan y diferencia</span></div>
      ${fila(casos[0])}
      ${S.filas.map((r, i) => `<div class="pt-2"><div class="px-2 text-[11px] font-bold uppercase tracking-wide text-slate-500">${esc(r.n)}</div>${fila(casos[1 + 2 * i])}${fila(casos[2 + 2 * i])}</div>`).join("")}
    </div>
    <div class="xl:sticky xl:top-4 self-start rounded-lg border border-slate-200 p-3 space-y-3" id="sens-detalle">${detalleCasoPlan(S.base, sel)}</div></div>`;
  $("sens-tabla").querySelectorAll("button[data-k]").forEach((b) => (b.onclick = () => { APP._sensSel = b.dataset.k; pintarSensibilidad(S); }));
}
// Sedes que cambian de grupo entre el caso base y un escenario rehecho
function detalleCasoPlan(base, c) {
  if (!c || c.k === "base") return `<p class="text-xs text-slate-500">Elige un escenario a la izquierda para ver qué sedes entran, salen o cambian de grupo.</p>`;
  const nom = (id) => esc(nombreLindo(APP._porId?.[id]?.nombre ?? id)), b = base.ids, x = c.x.ids;
  const enPlan = (g) => new Set([...g.f, ...g.c]), bp = enPlan(b), xp = enPlan(x), bf = new Set(b.f), xf = new Set(x.f), bs = new Set(b.s), xs = new Set(x.s);
  const grupos = [
    ["Se agregan al plan de cierres", [...xp].filter((id) => !bp.has(id)), "#2a78d6"],
    ["Salen del plan de cierres", [...bp].filter((id) => !xp.has(id)), "#e34948"],
    ["Pasan a firme", [...xf].filter((id) => bp.has(id) && !bf.has(id)), "#003058"],
    ["Pasan a condicionado", [...bf].filter((id) => xp.has(id) && !xf.has(id)), "#5b8fd4"],
    ["Entran a seguimiento", [...xs].filter((id) => !bs.has(id)), "#8a94a3"],
    ["Salen de seguimiento", [...bs].filter((id) => !xs.has(id)), "#8a94a3"],
  ].filter(([, l]) => l.length);
  const d = c.x.van - base.van;
  return `<div><div class="text-[11px] font-bold uppercase tracking-wide text-slate-500">${esc(c.n)}</div><div class="text-sm font-extrabold text-slate-900">${esc(c.v)}</div>
    <div class="text-xs text-slate-600 mt-1">VAN del plan ${mm(c.x.van, true)} (${Math.abs(d) < 0.5 ? "igual al caso base" : `${mm(d, true)} frente al caso base`})</div></div>
    ${grupos.length ? grupos.map(([t, l, col]) => `<div><div class="flex items-center gap-1.5 text-xs font-semibold text-slate-700"><span class="w-2.5 h-2.5 rounded-full inline-block" style="background:${col}"></span>${t} (${l.length})</div>
      <div class="flex flex-wrap gap-1 mt-1">${l.map((id) => `<span class="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 text-[11px]">${nom(id)}</span>`).join("")}</div></div>`).join("")
      : `<p class="text-xs text-slate-500">Las mismas sedes en los mismos grupos; solo cambia el VAN de cada cierre.</p>`}`;
}
function datosFlexibilidad() {
  calendarioCierres();
  if (APP._flex?.clave === APP._calMemo.clave) return APP._flex;
  const cal = calendarioCierres(), G = gruposPlan(), inicio = sumarMeses(historia().corte, 1), fin = finPlan();
  const filas = [], grupo = (g, tipo) => g.filter(([, k]) => k.mes).map(([id, k]) => [id, k, tipo]);
  for (const [id, k, tipo] of [...grupo(G.decididos, "decidido"), ...grupo(G.firmes, "firme"), ...grupo(G.condicionados, "condicionado"),
    ...grupo(G.seguimiento, "seguimiento"), ...grupo(G.red, "red")]) {
    const s = APP._porId[id];
    if (!s || !DASHBOARD_DATA.locales[id] || sinGastos(s)) continue;
    const rec = conUso(DASHBOARD_DATA.huff_ids.filter((j) => j !== id && !(cal[j] && cal[j].mes <= k.mes)), id, k.mes, APP._calMemo.libro);
    const B = baseCierre(s, rec, inicio, new Set()), v = ventanasCierre(s, inicio, fin).meses;
    const atrasos = [0, 1, 2, 3].map((d) => { const m = d ? v.find((x) => x >= sumarMeses(k.mes, 12 * d)) : k.mes; return m ? { m, v: vanDesdeBase(B, [m]).opciones[0].van } : null; });
    // Fecha de mayor VAN entre las ventanas del calendario (el plan toma la primera a menos de "tolerancia" del maximo)
    const vc = ventanasCierre(s, sumarMeses(inicio, sinAlternativa(s) ? mesesPlanDigital(s) : 0), fin).meses;
    const mejor = vc.length ? vanDesdeBase(B, vc).opciones.reduce((x, y) => (y.van > x.van ? y : x)) : null;
    const fila = { id, n: nombreLindo(s.nombre), tipo, enPlan: tipo === "firme" || tipo === "condicionado", firme: tipo === "firme", mes: k.mes, atrasos, vanRef: k.van, probRef: k.mc?.prob, mejor: mejor && { m: mejor.mes, v: mejor.van, prob: mejor.mes !== k.mes ? mcCierre(B, [mejor.mes])[0].prob : null } };
    const m1 = atrasos[1]?.m;
    if (m1) {
      // Esperar un ano y decidir = E[max(0, VAN un ano despues)]. Se separa en lo que gana solo cerrar mas tarde
      // (E[VAN un ano despues] - E[VAN hoy]) y el valor de decidir con la venta observada (opcion real, siempre >= 0)
      const [a, b] = mcCierre(B, [k.mes, m1]);
      let opc = 0; for (const y of b.vector) opc += Math.max(0, y);
      const esperar = opc / b.vector.length;
      Object.assign(fila, { hoy: a.media, tarde: b.media, esperar, postergar: b.media - a.media, info: esperar - b.media });
      fila.rec = esperar - a.media <= 0.5 ? "fecha" : fila.info > fila.postergar ? "esperar" : "tarde";
    }
    filas.push(fila);
  }
  // Sedes fisicas que no se pueden evaluar, con el motivo (para que la lista cubra toda la red)
  const vistos = new Set(filas.map((f) => f.id)), M = APP._calMemo.mantiene;
  const excluidas = APP.est.sedes.filter((s) => s.grupo !== "DIGITAL" && s.lat != null && !vistos.has(s.sede_id)).map((s) => ({ n: nombreLindo(s.nombre),
    motivo: sinGastos(s) ? "sin datos de gastos" : !DASHBOARD_DATA.locales[s.sede_id] ? "sin proyección de demanda" : M[s.sede_id]?.motivo || "sin fecha de cierre posible en el horizonte" }));
  return (APP._flex = { clave: APP._calMemo.clave, filas, excluidas });
}
function pintarFlexibilidad() {
  if (!APP.est || !DASHBOARD_DATA || !$("flex-tabla")) return;
  if (!APP._porId || !APP._alt) prepararCategorias();
  const F = datosFlexibilidad(), at = APP._atraso ?? 1, firmes = F.filas.filter((f) => f.firme);
  const total = (d) => firmes.reduce((a, f) => a + (f.atrasos[d]?.v ?? 0), 0), totales = [0, 1, 2, 3].map(total);
  $("flex-atraso").innerHTML = [0, 1, 2, 3].map((a) => `<button type="button" data-a="${a}" aria-pressed="${a === at}">${a === 0 ? "A tiempo" : `${a} año${a === 1 ? "" : "s"}`}</button>`).join("");
  $("flex-atraso").querySelectorAll("button").forEach((b) => (b.onclick = () => { APP._atraso = +b.dataset.a; pintarFlexibilidad(); }));
  const color = (v) => (v > 0.5 ? "text-emerald-800" : v < -0.5 ? "text-rose-800" : "");
  const dato = (k, v, cls = "", sub = "") => `<div><dt class="text-xs text-slate-500">${k}</dt><dd class="font-semibold text-lg tabular-nums mt-0.5 ${cls}">${v}</dd>${sub ? `<dd class="text-[11px] text-slate-500">${sub}</dd>` : ""}</div>`;
  const dif = totales[at] - totales[0], conOpc = F.filas.filter((f) => f.enPlan && f.hoy != null), esperan = conOpc.filter((f) => f.rec === "esperar");
  const valorFlex = esperan.reduce((a, f) => a + f.info, 0);
  $("flex-kpis").innerHTML = dato("VAN del plan a tiempo", mm(totales[0], true), "", `${firmes.length} cierre${firmes.length === 1 ? "" : "s"} firme${firmes.length === 1 ? "" : "s"}`)
    + dato(`VAN del plan con ${at ? `${at} año${at === 1 ? "" : "s"} de atraso` : "el calendario a tiempo"}`, mm(totales[at], true))
    + dato("Diferencia por postergar", at ? mm(dif, true) : "-", color(dif), at && Math.abs(totales[0]) > 0.5 ? signo((dif / Math.abs(totales[0])) * 100, 0, "%") : "")
    + dato("Conviene esperar y decidir", `${esperan.length} de ${conOpc.length} cierres`, "", esperan.length ? `valor de decidir con la venta observada ${mm(valorFlex, true)} · firmes y condicionados` : "firmes y condicionados: decidir con la venta observada no agrega valor");
  // Una fila por cierre: linea de tiempo (fecha del plan -> fecha con atraso), costo de postergar y valor de esperar
  const fin = finPlan(), t0 = F.filas.reduce((a, f) => (f.atrasos[0].m < a ? f.atrasos[0].m : a), fin), span = Math.max(1, difMeses(t0, fin));
  const pos = (m) => Math.max(0, Math.min(100, (difMeses(t0, m) / span) * 100));
  const anos = []; for (let y = +t0.slice(0, 4) + 1; y <= +fin.slice(0, 4); y++) anos.push(y);
  const difs = F.filas.map((f) => (f.atrasos[at] ? f.atrasos[at].v - f.atrasos[0].v : 0)), maxD = Math.max(1, ...difs.map(Math.abs));
  const maxO = Math.max(1, ...conOpc.map((f) => Math.abs(f.esperar - f.hoy)));
  const barraDiv = (d, max) => { const w = (Math.abs(d) / max) * 50;
    return `<div class="relative h-2.5 w-full"><div class="absolute inset-y-0 left-1/2 w-px bg-slate-300"></div>${Math.abs(d) >= 0.5 ? `<div class="absolute inset-y-0 rounded-sm" style="${d > 0 ? "left:50%" : `left:${50 - w}%`};width:${w}%;background:${d > 0 ? "#2a78d6" : "#e34948"}"></div>` : ""}</div>`; };
  const linea = (f) => { const a = f.atrasos[0], x = f.atrasos[at], p0 = pos(a.m), p1 = x ? pos(x.m) : 100;
    return `<div class="relative h-5">${anos.map((y) => `<div class="absolute inset-y-0 w-px bg-slate-100" style="left:${pos(`${y}-01`)}%"></div>`).join("")}
      <div class="absolute top-1/2 h-0.5 -translate-y-1/2" style="left:${p0}%;width:${Math.max(0, p1 - p0)}%;background:${x ? "#eb6834" : "repeating-linear-gradient(90deg,#eb6834 0 4px,transparent 4px 7px)"}"></div>
      <div class="absolute top-1/2 w-2.5 h-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#003058] ring-2 ring-white" style="left:${p0}%" title="Fecha del plan: ${nombreMes(a.m)}"></div>
      ${at && x ? `<div class="absolute top-1/2 w-2.5 h-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#eb6834] ring-2 ring-white" style="left:${p1}%" title="Con atraso: ${nombreMes(x.m)}"></div>` : ""}
      ${f.mejor ? `<div class="absolute top-1/2 ${f.mejor.m === a.m ? "w-4 h-4" : "w-3.5 h-3.5"} -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#003058]" style="left:${pos(f.mejor.m)}%" title="${f.mejor.m === a.m ? "La fecha del plan es la de mayor VAN" : `Fecha de mayor VAN: ${nombreMes(f.mejor.m)} (${mm(f.mejor.v - a.v, true)} sobre la fecha del plan)`}"></div>` : ""}</div>`; };
  const FILTROS = [["todas", "Todas", () => true], ["plan", "En el plan", (f) => f.enPlan], ["decidido", "Decididos", (f) => f.tipo === "decidido"],
    ["fuera", "Seguimiento y red mínima", (f) => f.tipo === "seguimiento" || f.tipo === "red"]];
  const fil = APP._flexFiltro || "todas", ok = FILTROS.find(([k]) => k === fil)[2], ordenG = { decidido: 0, firme: 1, condicionado: 2, seguimiento: 3, red: 4 };
  $("flex-filtro").innerHTML = FILTROS.map(([k, t, fn]) => `<button type="button" data-k="${k}" aria-pressed="${k === fil}">${t} (${F.filas.filter(fn).length})</button>`).join("");
  $("flex-filtro").querySelectorAll("button").forEach((b) => (b.onclick = () => { APP._flexFiltro = b.dataset.k; pintarFlexibilidad(); }));
  const filas = F.filas.map((f, i) => ({ f, d: difs[i] })).filter(({ f }) => ok(f))
    .sort((a, b) => ordenG[a.f.tipo] - ordenG[b.f.tipo] || (a.f.atrasos[0].m < b.f.atrasos[0].m ? -1 : a.f.atrasos[0].m > b.f.atrasos[0].m ? 1 : 0));
  if (!filas.some(({ f }) => f.id === APP._flexSel)) APP._flexSel = filas[0]?.f.id ?? null;
  const ejeAnos = `<div class="relative h-4 text-[10px] text-slate-400">${anos.filter((y, i) => anos.length <= 6 || i % 2 === 0).map((y) => `<span class="absolute -translate-x-1/2" style="left:${pos(`${y}-01`)}%">${y}</span>`).join("")}</div>`;
  $("flex-tabla").innerHTML = !filas.length ? `<p class="text-slate-500">No hay sedes en este grupo.</p>` : `
    <div class="hidden md:grid grid-cols-12 gap-3 px-2 pb-1 text-[11px] font-semibold text-slate-500 border-b border-slate-200 items-end">
      <span class="col-span-3">Sede</span><span class="col-span-5"><span class="flex gap-3 font-normal mb-1"><span class="inline-flex items-center gap-1"><span class="w-2.5 h-2.5 rounded-full bg-[#003058] inline-block"></span>Fecha del plan (o mejor fecha)</span><span class="inline-flex items-center gap-1"><span class="w-3 h-3 rounded-full border-2 border-[#003058] inline-block"></span>Fecha de mayor VAN</span>${at ? `<span class="inline-flex items-center gap-1"><span class="w-2.5 h-2.5 rounded-full bg-[#eb6834] inline-block"></span>Con ${at} año${at === 1 ? "" : "s"} de atraso</span>` : ""}</span>${ejeAnos}</span>
      <span class="col-span-2 text-right">${at ? "Costo de postergar" : "VAN a tiempo"}</span><span class="col-span-2 text-right">Valor de esperar</span></div>
    ${filas.map(({ f, d }) => { const x = f.atrasos[at], o = f.hoy != null ? f.esperar - f.hoy : null;
      return `<button type="button" data-id="${esc(f.id)}" class="w-full grid grid-cols-12 gap-3 items-center text-left px-2 py-1.5 rounded-lg border ${f.id === APP._flexSel ? "border-[#003058] bg-slate-50" : "border-transparent hover:bg-slate-50"}">
        <span class="col-span-12 md:col-span-3"><span class="font-medium text-slate-800">${esc(f.n)}</span> <span class="text-[10px] px-1.5 py-0.5 rounded ${ETQ_FLEX[f.tipo][1]}">${ETQ_FLEX[f.tipo][0]}</span></span>
        <span class="col-span-12 md:col-span-5">${linea(f)}</span>
        <span class="col-span-6 md:col-span-2">${at ? (x ? `${barraDiv(d, maxD)}<div class="text-[11px] text-right ${color(d)}">${mm(d, true)}</div>` : `<div class="text-[11px] text-right text-slate-500">después de 2036</div>`) : `<div class="text-right">${mm(f.atrasos[0].v, true)}</div>`}</span>
        <span class="col-span-6 md:col-span-2">${o == null ? `<div class="text-[11px] text-right text-slate-400">-</div>` : `${barraDiv(o, maxO)}<div class="text-[11px] text-right ${o > 0.5 ? "text-[#1f5fae] font-semibold" : "text-slate-500"}">${{ fecha: "cerrar en la fecha", tarde: `cerrar más tarde ${mm(o, true)}`, esperar: `esperar y decidir ${mm(o, true)}` }[f.rec]}</div>`}</span></button>`; }).join("")}`;
  if (fil === "todas" && F.excluidas.length) $("flex-tabla").insertAdjacentHTML("beforeend", `<div class="mt-3 pt-2 border-t border-slate-100 text-[11px] text-slate-500">
    <span class="font-semibold text-slate-600">Sin evaluar (${F.excluidas.length}):</span> ${F.excluidas.map((x) => `${esc(x.n)} (${esc(x.motivo)})`).join(" · ")}</div>`);
  $("flex-tabla").querySelectorAll("button[data-id]").forEach((b) => (b.onclick = () => { APP._flexSel = b.dataset.id; pintarFlexibilidad(); }));
  pintarDetalleFlex(F.filas.find((f) => f.id === APP._flexSel), at);
  // Eje ajustado a los datos: las diferencias por atraso son de pocos puntos y con el eje desde cero no se ven
  const pad = Math.max((Math.max(...totales) - Math.min(...totales)) * 0.35, Math.abs(totales[0]) * 0.005, 1);
  if ($("flex-sub-plan")) $("flex-sub-plan").textContent = `Suma de los ${firmes.length} cierre${firmes.length === 1 ? "" : "s"} firme${firmes.length === 1 ? "" : "s"}. Haz clic en un punto para elegir el atraso.`;
  const ctx = $("chartFlex");
  if (APP.chartFlex) APP.chartFlex.destroy();
  APP.chartFlex = new Chart(ctx, { type: "line", data: { labels: ["A tiempo", "1 año", "2 años", "3 años"], datasets: [{ data: totales, borderColor: "#003058", backgroundColor: "#003058",
    pointRadius: totales.map((_, i) => (i === at ? 7 : 4)), pointHoverRadius: 8, pointHitRadius: 18, borderWidth: 2, tension: 0.25 }] },
    options: { responsive: true, maintainAspectRatio: false, animation: false, onClick: (e, el) => { if (el.length) { APP._atraso = el[0].index; pintarFlexibilidad(); } },
      onHover: (e, el) => { e.native.target.style.cursor = el.length ? "pointer" : "default"; },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (it) => `${mm(it.parsed.y, true)}${it.dataIndex ? ` (${mm(it.parsed.y - totales[0], true)} frente a tiempo)` : ""}` } } },
      scales: { x: { grid: { display: false }, offset: true }, y: { beginAtZero: false, suggestedMin: Math.min(...totales) - pad, suggestedMax: Math.max(...totales) + pad, grid: { color: "#E5E9EF" }, ticks: { callback: (v) => mm(v), maxTicksLimit: 6 } } } } });
}
function pintarSensibilidadTab() {
  if (!APP.est || !DASHBOARD_DATA || !$("sens-controles")) return;
  if (!APP._porId || !APP._alt) prepararCategorias();
  pintarSensVan();
  calcularSensibilidad(pintarSensibilidad);
}
const ETQ_FLEX = { decidido: ["Decidido", "bg-slate-200 text-slate-800"], firme: ["Firme", "bg-[#003058] text-white"], condicionado: ["Cond.", "bg-[#c3d5ee] text-slate-800"],
  seguimiento: ["Seguimiento", "bg-amber-100 text-amber-900"], red: ["Red mínima", "bg-white border border-slate-300 text-slate-600"] };
// Detalle de un cierre en Flexibilidad: VAN segun el atraso y opcion de esperar un ano
function pintarDetalleFlex(f, at) {
  const caja = $("flex-detalle");
  if (!caja) return;
  APP.chartFlexSede?.destroy(); APP.chartFlexSede = null;
  if (!f) { caja.innerHTML = `<p class="text-xs text-slate-500">Elige un cierre para ver su detalle.</p>`; return; }
  const o = f.hoy != null ? f.esperar - f.hoy : null;
  caja.innerHTML = `<div><div class="text-[11px] font-bold uppercase tracking-wide text-slate-500">Detalle de una sede · ${{ decidido: "cierre decidido", firme: "cierre firme", condicionado: "cierre condicionado", seguimiento: "en seguimiento", red: "red mínima" }[f.tipo]}</div>
      <div class="text-sm font-extrabold text-slate-900">${esc(f.n)}</div><div class="text-xs text-slate-600">${f.enPlan || f.tipo === "decidido" ? "Fecha del plan" : "Mejor fecha de cierre"}: ${nombreMes(f.atrasos[0].m)}</div></div>
    ${f.enPlan ? "" : `<div class="text-xs px-2 py-1.5 rounded bg-slate-100 text-slate-700">${f.tipo === "decidido" ? "Cierre decidido por la gerencia: su fecha no se evalúa, el VAN es de referencia."
      : `No está en el plan de cierres: cerrarla en su mejor fecha da ${mm(f.atrasos[0].v, true)}${f.probRef != null ? `, con VAN positivo en el ${fmt.num(f.probRef * 100, 0)}% de los escenarios (mínimo ${fmt.num(probMin() * 100, 0)}%)` : ""}.`}</div>`}
    <div><div class="text-xs font-semibold text-slate-700 mb-1">VAN de cerrar ${esc(f.n)} según el atraso</div><div class="relative h-40"><canvas id="chartFlexSede"></canvas></div></div>
    ${!f.mejor || !f.enPlan ? "" : `<div class="text-xs px-2 py-1.5 rounded bg-slate-100 text-slate-700">${f.mejor.m === f.atrasos[0].m ? "La fecha del plan es la de mayor VAN."
      : `Fecha de mayor VAN: ${nombreMes(f.mejor.m)}, con ${mm(f.mejor.v - f.atrasos[0].v, true)} sobre la fecha del plan. ${f.mejor.m < f.atrasos[0].m && (f.mejor.prob ?? 1) < probMin()
        ? `El plan no la usa porque ahí el VAN es positivo solo en el ${fmt.num((f.mejor.prob ?? 0) * 100, 0)}% de los escenarios (mínimo ${fmt.num(probMin() * 100, 0)}%).`
        : (finz().tolerancia ?? 0) > 0 ? `El plan cierra antes porque acepta hasta ${Math.round(finz().tolerancia * 100)}% menos VAN para cerrar en la primera fecha posible.`
        : "El plan elige con el VAN promedio de la simulación, que es mayor en la fecha del plan."}`}</div>`}
    ${o == null ? `<p class="text-xs text-slate-500">No hay una ventana de contrato un año después para evaluar la espera.</p>` : `
    <div class="space-y-1.5"><div class="text-xs font-semibold text-slate-700">Esperar un año y decidir con la venta observada</div>
      <div class="flex justify-between text-xs"><span class="text-slate-500">Cerrar en la fecha del plan</span><span class="font-semibold tabular-nums">${mm(f.hoy, true)}</span></div>
      <div class="flex justify-between text-xs"><span class="text-slate-500">Esperar y decidir</span><span class="font-semibold tabular-nums">${mm(f.esperar, true)}</span></div>
      <div class="flex justify-between text-xs border-t border-slate-200 pt-1.5"><span class="text-slate-500">Diferencia</span><span class="font-semibold tabular-nums ${o > 0.5 ? "text-[#1f5fae]" : "text-slate-500"}">${mm(o, true)}</span></div>
      <div class="flex justify-between text-xs pl-3"><span class="text-slate-500">por cerrar más tarde</span><span class="tabular-nums">${mm(f.postergar, true)}</span></div>
      <div class="flex justify-between text-xs pl-3"><span class="text-slate-500">por decidir con la venta observada</span><span class="tabular-nums">${mm(f.info, true)}</span></div>
      <div class="text-xs mt-1 px-2 py-1.5 rounded ${o > 0.5 ? "bg-[#e3eefb] text-[#1f3f6e]" : "bg-slate-100 text-slate-700"}">${{
        fecha: "Conviene cerrar en la fecha del plan: esperar no agrega valor.",
        tarde: "Conviene cerrar más tarde: casi todo lo que se gana al esperar viene de la fecha, no de la información nueva.",
        esperar: "Conviene esperar un año y decidir con la venta observada: la información vale más que el cambio de fecha." }[f.rec]}</div></div>`}`;
  const et = ["A tiempo", "1 año", "2 años", "3 años"], d = f.atrasos.map((x) => x?.v ?? null);
  APP.chartFlexSede = new Chart($("chartFlexSede"), { type: "bar",
    data: { labels: et, datasets: [{ data: d, backgroundColor: d.map((v, i) => (i === at ? "#003058" : v != null && v < 0 ? "#e34948" : "#9fb4cf")), borderRadius: 4, barPercentage: 0.7 }] },
    options: { responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (it) => { const x = f.atrasos[it.dataIndex]; return x ? `${nombreMes(x.m)}: ${mm(x.v, true)}` : "después de 2036"; } } } },
      scales: { x: { grid: { display: false } }, y: { grid: { color: "#E5E9EF" }, ticks: { callback: (v) => mm(v), maxTicksLimit: 4 } } } } });
}
// =====================================================================
// Sensibilidad del VAN a mano: el plan queda fijo (cierres y fechas del caso base) y se recalcula el VAN de cada cierre con
// los supuestos que se mueven. Cada supuesto entra al juego p de flujosCierre; con todos en su valor base el VAN es el del plan.
// =====================================================================
const tasaDesdeNominal = (rN) => (state?.currencyMode === "NOMINAL" ? rN : (1 + rN) / (1 + inflacionModelo()) - 1);
const signo = (v, d, u) => `${v > 0 ? "+" : ""}${fmt.num(v, d)}${u}`;
const SENS_PARAMS = [
  { k: "venta", n: "Nivel de venta", min: -30, max: 30, paso: 5, base: () => 0, txt: (v) => signo(v, 0, "%"), ap: (p, v) => { p.kv = 1 + v / 100; } },
  { k: "tend", n: "Tendencia de la venta", min: -5, max: 5, paso: 0.5, base: () => 0, txt: (v) => signo(v, 1, " pts/año"), ap: (p, v) => { p.dg = v / 100; } },
  { k: "fis", n: "Retención en otras sedes", min: 0.5, max: 1.5, paso: 0.05, base: () => 1, txt: (v) => `x${fmt.num(v, 2)}`, ap: (p, v, B) => { p.mf = Math.min(1, B.e.physProb * v); } },
  { k: "dig", n: "Retención digital", min: -10, max: 20, paso: 1, base: () => 0, txt: (v) => signo(v, 0, " pts"), ap: (p, v, B) => { p.md = Math.max(0, Math.min(0.95, B.md + v / 100)); } },
  { k: "wacc", n: "Tasa de descuento (WACC nominal)", min: -3, max: 3, paso: 0.25, base: () => 0, txt: (v) => `${fmt.num(((APP.tasaDescuento ?? 0.105) + v / 100) * 100, 2)}%`,
    ap: (p, v) => { p.rA = tasaDesdeNominal((APP.tasaDescuento ?? 0.105) + v / 100); } },
  { k: "gastos", n: "Alza real de los gastos", min: -2, max: 3, paso: 0.25, base: () => 0, txt: (v) => signo(v, 2, " pts/año"), ap: (p, v) => { p.dc = v / 100; } },
  { k: "phi", n: "Persistencia de la tendencia", min: 0.6, max: 1, paso: 0.05, base: () => amortiguacion(), txt: (v) => fmt.num(v, 2), ap: (p, v) => { p.phi = v; } },
  { k: "online", n: "Costo del canal online", min: 0, max: 40, paso: 1, base: () => (APP.factorCostoOnline ?? 0.15) * 100, txt: (v) => `${fmt.num(v, 0)}%`, ap: (p, v) => { p.fo = v / 100; } },
];
// Color fijo por supuesto (sigue al supuesto, no a su posicion en el ranking)
const SENS_COLOR = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
const sensRango = (d) => { const b = d.base(); return [Math.min(d.min, b), Math.max(d.max, b)]; };
const sensValsBase = () => Object.fromEntries(SENS_PARAMS.map((d) => [d.k, d.base()]));
// Cierres del plan con su base de calculo; se recuerda mientras no cambie el calendario
function basesSens() {
  calendarioCierres();
  if (APP._sensB?.clave === APP._calMemo.clave) return APP._sensB.filas;
  const cal = APP._calMemo.cal, G = gruposPlan(), inicio = sumarMeses(historia().corte, 1);
  const filas = [...G.firmes, ...G.condicionados].map(([id, k]) => {
    const s = APP._porId[id];
    const rec = conUso(DASHBOARD_DATA.huff_ids.filter((j) => j !== id && !(cal[j] && cal[j].mes <= k.mes)), id, k.mes, APP._calMemo.libro);
    return { id, n: nombreLindo(s.nombre), firme: k.firme, mes: k.mes, B: baseCierre(s, rec, inicio, new Set()) };
  });
  APP._sensB = { clave: APP._calMemo.clave, filas };
  return filas;
}
function vanesSens(filas, vals) {
  return filas.map(({ B, mes }) => {
    const p = { rA: tasaEfectiva(), dc: 0, phi: amortiguacion(), fo: APP.factorCostoOnline ?? 0.15, mf: B.e.physProb, md: B.md, dg: 0, eps: null, uSal: null, kv: 1 };
    for (const d of SENS_PARAMS) d.ap(p, vals[d.k], B);
    return vanDesdeBase(B, [mes], p).opciones[0].van;
  });
}
const sumaSens = (filas, vals) => vanesSens(filas, vals).reduce((a, v) => a + v, 0);
function pintarSensVan() {
  if (!$("sens-controles")) return;
  const vb = sensValsBase();
  if (!APP._sensVals) APP._sensVals = { ...vb };
  const alc = soloFirmes() ? "FASE_1" : "FASE_1_2";
  $("sens-alcance").innerHTML = [["FASE_1", "Cierres firmes"], ["FASE_1_2", "Firmes y condicionados"]].map(([k, t]) => `<button type="button" data-k="${k}" aria-pressed="${k === alc}">${t}</button>`).join("");
  $("sens-alcance").querySelectorAll("button").forEach((b) => (b.onclick = () => { SIM.alcance = b.dataset.k; pintarSensVan(); }));
  $("sens-reset").onclick = () => { APP._sensVals = { ...vb }; pintarSensVan(); };
  $("sens-controles").innerHTML = SENS_PARAMS.map((d) => {
    const [lo, hi] = sensRango(d), v = APP._sensVals[d.k], mov = Math.abs(v - vb[d.k]) > 1e-9;
    return `<label class="block space-y-1 bg-white p-2.5 rounded-lg border ${mov ? "border-[#2a78d6]" : "border-slate-200"}" data-k="${d.k}">
      <span class="flex items-center justify-between gap-2 text-[11px] font-semibold text-slate-600"><span>${d.n}</span><span class="font-extrabold text-[#003058] tabular-nums" data-v>${d.txt(v)}</span></span>
      <input type="range" min="${lo}" max="${hi}" step="${d.paso}" value="${v}" class="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-[#003058]">
      <span class="flex justify-between text-[10px] text-slate-400 tabular-nums"><span>${d.txt(lo)}</span><span>base ${d.txt(vb[d.k])}</span><span>${d.txt(hi)}</span></span></label>`;
  }).join("");
  $("sens-controles").querySelectorAll("label").forEach((el) => {
    const d = SENS_PARAMS.find((x) => x.k === el.dataset.k), inp = el.querySelector("input");
    inp.oninput = () => {
      APP._sensVals[d.k] = +inp.value;
      el.querySelector("[data-v]").textContent = d.txt(+inp.value);
      el.classList.toggle("border-[#2a78d6]", Math.abs(+inp.value - vb[d.k]) > 1e-9);
      el.classList.toggle("border-slate-200", Math.abs(+inp.value - vb[d.k]) <= 1e-9);
      if (!APP._sensRaf) APP._sensRaf = requestAnimationFrame(() => { APP._sensRaf = null; actualizarSensVan(); });
    };
  });
  actualizarSensVan();
}
function actualizarSensVan() {
  if (!APP.est || !DASHBOARD_DATA || !$("sens-kpis")) return;
  if (!APP._porId || !APP._alt) prepararCategorias();
  const filas = basesSens().filter((f) => (soloFirmes() ? f.firme : true)), vals = APP._sensVals, vb = sensValsBase();
  const dato = (k, v, cls = "", sub = "") => `<div><dt class="text-xs text-slate-500">${k}</dt><dd class="font-semibold text-lg tabular-nums mt-0.5 ${cls}">${v}</dd>${sub ? `<dd class="text-[11px] text-slate-500">${sub}</dd>` : ""}</div>`;
  if (!filas.length) {
    $("sens-kpis").innerHTML = dato("VAN del plan", "-", "", "No hay cierres en el plan con estos filtros.");
    ["chartSensTornado", "chartSensCurvas", "chartSensSedes"].forEach((c) => { APP[c]?.destroy(); APP[c] = null; });
    $("sens-doble").innerHTML = "";
    return;
  }
  const vBase = vanesSens(filas, vb), vEsc = vanesSens(filas, vals);
  const tBase = vBase.reduce((a, v) => a + v, 0), tEsc = vEsc.reduce((a, v) => a + v, 0), dif = tEsc - tBase;
  const negB = vBase.filter((v) => v < 0).length, negE = vEsc.filter((v) => v < 0).length;
  const color = (v) => (v > 0.5 ? "text-emerald-800" : v < -0.5 ? "text-rose-800" : "");
  $("sens-kpis").innerHTML = dato("VAN del plan, caso base", mm(tBase, true), "", `${filas.length} cierre${filas.length === 1 ? "" : "s"}`)
    + dato("VAN del plan, escenario", mm(tEsc, true), color(tEsc))
    + dato("Cambio frente al caso base", Math.abs(dif) < 0.5 ? "-" : mm(dif, true), color(dif), Math.abs(tBase) > 0.5 && Math.abs(dif) >= 0.5 ? `${signo(dif / Math.abs(tBase) * 100, 0, "%")}` : "")
    + dato("Cierres con VAN negativo", `${negE} de ${filas.length}`, negE > negB ? "text-rose-800" : "", negB ? `${negB} en el caso base` : "ninguno en el caso base");
  const ejes = { grid: { color: "#E5E9EF" }, ticks: { callback: (v) => mm(v), maxRotation: 0, maxTicksLimit: 6 } };
  // Tornado: cada supuesto al minimo y al maximo de su rango, el resto como en el escenario
  const T = SENS_PARAMS.map((d, i) => {
    const [lo, hi] = sensRango(d), l = sumaSens(filas, { ...vals, [d.k]: lo }), h = sumaSens(filas, { ...vals, [d.k]: hi });
    return { d, i, lo, hi, l, h, swing: Math.abs(h - l) };
  }).sort((a, b) => b.swing - a.swing);
  const polar = (v) => (v >= tEsc ? "#2a78d6" : "#e34948");
  APP.chartSensTornado?.destroy();
  APP.chartSensTornado = new Chart($("chartSensTornado"), { type: "bar",
    data: { labels: T.map((t) => t.d.n), datasets: [
      { label: "mín", data: T.map((t) => [tEsc, t.l]), backgroundColor: T.map((t) => polar(t.l)), borderRadius: 4, borderSkipped: false, barPercentage: 0.7, grouped: false },
      { label: "máx", data: T.map((t) => [tEsc, t.h]), backgroundColor: T.map((t) => polar(t.h)), borderRadius: 4, borderSkipped: false, barPercentage: 0.7, grouped: false }] },
    options: { indexAxis: "y", responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (it) => { const t = T[it.dataIndex], m = it.datasetIndex === 0, v = m ? t.l : t.h;
        return `${t.d.txt(m ? t.lo : t.hi)}: VAN ${mm(v, true)} (${mm(v - tEsc, true)})`; } } } },
      scales: { x: ejes, y: { grid: { display: false }, ticks: { font: { size: 11 } } } } } });
  // Curvas: VAN del plan recorriendo el rango de los cuatro supuestos con mas efecto
  const pasos = [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1];
  const valorEn = (t, x) => { const v = vals[t.d.k]; return x < 0 ? v + x * (v - t.lo) : v + x * (t.hi - v); };
  APP.chartSensCurvas?.destroy();
  APP.chartSensCurvas = new Chart($("chartSensCurvas"), { type: "line",
    data: { labels: pasos.map((x) => (x === -1 ? "mínimo" : x === 0 ? "escenario" : x === 1 ? "máximo" : "")), datasets: T.slice(0, 4).map((t) => ({
      label: t.d.n, data: pasos.map((x) => sumaSens(filas, { ...vals, [t.d.k]: valorEn(t, x) })), borderColor: SENS_COLOR[t.i], backgroundColor: SENS_COLOR[t.i],
      borderWidth: 2, pointRadius: pasos.map((x) => (x === 0 ? 4 : 0)), pointHoverRadius: 5, tension: 0.2 })) },
    options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: { callbacks: { title: () => "", label: (it) => { const t = T[it.datasetIndex]; return `${t.d.n} ${t.d.txt(valorEn(t, pasos[it.dataIndex]))}: ${mm(it.parsed.y, true)}`; } } } },
      scales: { x: { grid: { display: false }, ticks: { autoSkip: false, maxRotation: 0 } }, y: ejes } } });
  // VAN de cada cierre, ordenado por el escenario
  const orden = filas.map((f, i) => ({ f, b: vBase[i], e: vEsc[i] })).sort((a, b) => b.e - a.e);
  $("sens-sedes-caja").style.height = `${Math.max(160, 24 * orden.length + 70)}px`;
  APP.chartSensSedes?.destroy();
  APP.chartSensSedes = new Chart($("chartSensSedes"), { type: "bar",
    data: { labels: orden.map((o) => `${o.f.n}${o.f.firme ? "" : " (cond.)"}`), datasets: [
      { label: "Caso base", data: orden.map((o) => o.b), backgroundColor: "#c9ced6", borderRadius: 4, barPercentage: 0.85, categoryPercentage: 0.8 },
      { label: "Escenario", data: orden.map((o) => o.e), backgroundColor: orden.map((o) => (o.e < 0 ? "#e34948" : "#2a78d6")), borderRadius: 4, barPercentage: 0.85, categoryPercentage: 0.8 }] },
    options: { indexAxis: "y", responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { position: "top", align: "end", labels: { boxWidth: 12, font: { size: 11 }, generateLabels: () => [
        { text: "Caso base", fillStyle: "#c9ced6", strokeStyle: "#c9ced6" }, { text: "Escenario, VAN positivo", fillStyle: "#2a78d6", strokeStyle: "#2a78d6" },
        { text: "Escenario, VAN negativo", fillStyle: "#e34948", strokeStyle: "#e34948" }] } },
        tooltip: { callbacks: { label: (it) => `${it.dataset.label}: ${mm(it.parsed.x, true)}`, afterBody: (its) => { const o = orden[its[0].dataIndex]; return `Cierre: ${nombreMes(o.f.mes)}. Cambio: ${mm(o.e - o.b, true)}`; } } } },
      scales: { x: ejes, y: { grid: { display: false }, ticks: { font: { size: 11 }, autoSkip: false } } } } });
  pintarDobleSens(filas, tEsc, T);
}
// Doble entrada: VAN del plan con dos supuestos en cinco valores cada uno (minimo, medio, escenario, medio, maximo)
function pintarDobleSens(filas, tEsc, T) {
  if (!APP._sensDoble) APP._sensDoble = [T[0].d.k, T[1].d.k];
  const [ka, kb] = APP._sensDoble, op = (sel) => SENS_PARAMS.map((d) => `<option value="${d.k}" ${d.k === sel ? "selected" : ""}>${d.n}</option>`).join("");
  $("sens-doble-a").innerHTML = op(ka); $("sens-doble-b").innerHTML = op(kb);
  $("sens-doble-a").onchange = (e) => { APP._sensDoble = [e.target.value, kb]; pintarDobleSens(filas, tEsc, T); };
  $("sens-doble-b").onchange = (e) => { APP._sensDoble = [ka, e.target.value]; pintarDobleSens(filas, tEsc, T); };
  const vals = APP._sensVals, A = SENS_PARAMS.find((d) => d.k === ka), Bp = SENS_PARAMS.find((d) => d.k === kb);
  const niveles = (d) => { const [lo, hi] = sensRango(d), v = vals[d.k]; return [lo, (lo + v) / 2, v, (v + hi) / 2, hi]; };
  const na = niveles(A), nb = ka === kb ? [vals[kb]] : niveles(Bp);
  const M = na.map((a) => nb.map((b) => sumaSens(filas, { ...vals, [ka]: a, [kb]: b })));
  // Intensidad segun el cambio relativo al escenario, saturada en +-50% (asi un extremo no deja al resto sin color)
  const ref = Math.max(1, Math.abs(tEsc));
  const fondo = (v) => { const x = (v - tEsc) / ref, al = Math.min(0.55, 0.08 + Math.abs(x) * 0.94); return Math.abs(v - tEsc) < 0.5 ? "#f0efec" : x > 0 ? `rgba(42,120,214,${al})` : `rgba(227,73,72,${al})`; };
  const th = (t, cls = "text-right") => `<th class="py-1.5 px-3 font-semibold text-slate-500 whitespace-nowrap ${cls}">${t}</th>`;
  $("sens-doble").innerHTML = `<thead><tr class="border-b border-slate-200">${th(`${esc(A.n)} ↓ / ${esc(Bp.n)} →`, "text-left")}${nb.map((b) => th(Bp.txt(b))).join("")}</tr></thead><tbody>
    ${M.map((fila, i) => `<tr class="border-b border-slate-100"><td class="py-1.5 pr-3 font-semibold text-slate-600 whitespace-nowrap">${A.txt(na[i])}</td>${fila.map((v, j) => {
      const actual = i === 2 && (nb.length === 1 || j === 2);
      return `<td class="py-1.5 px-3 text-right whitespace-nowrap text-slate-900 ${actual ? "font-bold outline outline-2 outline-[#1f2937] -outline-offset-2" : ""}" style="background:${fondo(v)}">${mm(v, true)}</td>`; }).join("")}</tr>`).join("")}</tbody>`;
}
