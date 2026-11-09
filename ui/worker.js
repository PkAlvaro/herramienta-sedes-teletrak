// Web Worker: corre el nucleo Python (paquete sedes) con Pyodide sin bloquear la interfaz.
// Recibe el Excel ya leido por SheetJS ({hoja: filas}); nunca envia datos fuera del navegador.
const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.28.3/full/";
importScripts(PYODIDE + "pyodide.js");

let py = null;

async function iniciar(fuentes) {
  postMessage({ tipo: "estado", texto: "Cargando Python en el navegador (la primera vez toma 20-40 s)" });
  py = await loadPyodide({ indexURL: PYODIDE });
  postMessage({ tipo: "estado", texto: "Descargando librerías de cálculo (pandas, statsmodels, scikit-learn)" });
  await py.loadPackage(["numpy", "pandas", "scipy", "statsmodels", "scikit-learn"], {
    messageCallback: (m) => { const p = /Loaded (.*)/.exec(m); if (p) postMessage({ tipo: "estado", texto: "Librerías listas: " + p[1].slice(0, 80) }); },
    errorCallback: (m) => postMessage({ tipo: "estado", texto: "Problema descargando librerías: " + m }),
  });
  // networkx: se carga solo la rueda (Python puro); su dependencia declarada (matplotlib) no se usa
  await py.loadPackage([PYODIDE + "networkx-3.4.2-py3-none-any.whl"]);
  for (const [ruta, texto] of Object.entries(fuentes)) {
    const dir = "/home/pyodide/" + ruta.split("/").slice(0, -1).join("/");
    py.FS.mkdirTree(dir);
    py.FS.writeFile("/home/pyodide/" + ruta, texto);
  }
  py.runPython("import sys; sys.path.insert(0, '/home/pyodide'); import sedes.ui_api");
  postMessage({ tipo: "listo" });
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.tipo === "iniciar") {
      await iniciar(m.fuentes);
    } else if (m.tipo === "direcciones") {
      postMessage({ tipo: "estado", texto: "Preparando las hojas del Excel en Python" });
      py.globals.set("libro_json", m.libro);
      const out = py.runPython("from sedes import ui_api\nui_api.direcciones(libro_json)");
      postMessage({ tipo: "estado", texto: "Hojas listas" });
      postMessage({ tipo: "direcciones", json: out });
    } else if (m.tipo === "grafo") {
      py.globals.set("entrada_grafo", m.entrada);
      postMessage({ tipo: "grafo", json: py.runPython("from sedes import ui_api\nui_api.grafo_red(entrada_grafo)") });
    } else if (m.tipo === "linea") {
      py.globals.set("entrada_linea", m.entrada);
      postMessage({ tipo: "linea", json: py.runPython("from sedes import ui_api\nui_api.linea_tiempo(entrada_linea)") });
    } else if (m.tipo === "rutas") {
      py.globals.set("entrada_rutas", m.entrada);
      postMessage({ tipo: "rutas", json: py.runPython("from sedes import ui_api\nui_api.rutas_metro(entrada_rutas)") });
    } else if (m.tipo === "tiempos") {
      py.globals.set("entrada_t", m.entrada);
      postMessage({ tipo: "tiempos", json: py.runPython("from sedes import ui_api\nui_api.tiempos_metro(entrada_t)") });
    } else if (m.tipo === "analizar") {
      postMessage({ tipo: "estado", texto: "Leyendo hojas y cruzando datos" });
      py.globals.set("libro_json", m.libro);
      py.globals.set("coord_csv", m.coordenadas || null);
      py.globals.set("equiv_csv", m.equivalencias || null);
      py.globals.set("params_json", JSON.stringify(m.params || {}));
      py.globals.set("progreso_js", (i, n, s) => postMessage({ tipo: "progreso", i, n, s }));
      const out = py.runPython(
        "from sedes import ui_api\n" +
        "ui_api.ejecutar(libro_json, coord_csv, equiv_csv, params_json, progreso=progreso_js)"
      );
      postMessage({ tipo: "resultado", json: out });
    }
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    // De un traceback de Python, mostrar la ultima linea (el error en si) y guardar el resto
    const lineas = msg.trim().split("\n");
    postMessage({ tipo: "error", texto: lineas[lineas.length - 1], detalle: msg });
  }
};
