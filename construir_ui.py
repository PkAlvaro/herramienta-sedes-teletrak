"""Arma herramienta_sedes.html: interfaz + worker + codigo Python del paquete, en un solo archivo.

    .venv/bin/python construir_ui.py

El HTML resultante no contiene datos: el usuario carga su Excel al abrirlo.
Hay que volver a correr este script cada vez que cambia sedes/*.py o ui/*.
"""
import base64
import json
from pathlib import Path

RAIZ = Path(__file__).parent
EXCLUIR = {"__main__.py", "geocodificar.py", "plantilla.py", "preparar_censo.py", "sintetico.py", "sintetico_rentabilidad.py"}


def zip_openpyxl():
    """openpyxl y et_xmlfile del entorno local en un zip (base64); None si no estan instalados."""
    try:
        import et_xmlfile
        import openpyxl
    except ImportError:
        return None
    import io
    import zipfile
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for mod in (openpyxl, et_xmlfile):
            base = Path(mod.__file__).parent
            for f in sorted(base.rglob("*.py")):
                z.write(f, f.relative_to(base.parent).as_posix())
    return base64.b64encode(buf.getvalue()).decode()


def construir(destino=RAIZ / "herramienta_sedes.html"):
    fuentes = {f"sedes/{p.name}": p.read_text(encoding="utf-8")
               for p in sorted((RAIZ / "sedes").glob("*.py")) if p.name not in EXCLUIR}
    for p in sorted([*(RAIZ / "sedes" / "datos_publicos").glob("*.csv"), *(RAIZ / "sedes" / "datos_publicos").glob("*.json")]):
        fuentes[f"sedes/datos_publicos/{p.name}"] = p.read_text(encoding="utf-8")
    html = (RAIZ / "ui" / "app.html").read_text(encoding="utf-8")
    js_fuentes = json.dumps(fuentes, ensure_ascii=False).replace("</", "<\\/")
    worker = (RAIZ / "ui" / "worker.js").read_text(encoding="utf-8")
    assert "</script" not in worker
    html = html.replace("__FUENTES__", js_fuentes, 1).replace("__WORKER__", worker, 1)
    # Coordenadas fijas de las sedes (solo en el repo privado; sin el archivo se geocodifica en el navegador)
    coords = RAIZ / "ui" / "coordenadas_fijas.json"
    if coords.exists():
        html = html.replace("/*__COORDS__*/{}", json.dumps(json.loads(coords.read_text(encoding="utf-8"))), 1)
    # Tiempos de viaje fijos (rutas reales de la corrida del informe; solo en el repo privado)
    tiempos = RAIZ / "ui" / "tiempos_fijos.json"
    if tiempos.exists():
        html = html.replace("/*__TIEMPOS__*/null", json.dumps(json.loads(tiempos.read_text(encoding="utf-8")), separators=(",", ":")).replace("</", "<\\/"), 1)
    # Logos de Teletrak e Hipodromo Chile, incrustados (uso local autorizado)
    for clave, archivo in (("__LOGO_TELETRAK__", "teletrak.png"), ("__LOGO_HIPODROMO__", "hipodromo_chile.png"), ("__ICONO__", "icono.png")):
        datos = base64.b64encode((RAIZ / "ui" / "marca" / archivo).read_bytes()).decode()
        html = html.replace(clave, "data:image/png;base64," + datos, 1)
    # openpyxl (Python puro) incrustado: el Excel con formato se arma sin descargar nada de PyPI
    zip_oxl = zip_openpyxl()
    if zip_oxl:
        html = html.replace("</body>", f'<script type="text/plain" id="zip-openpyxl">{zip_oxl}</script>\n</body>', 1)
    destino.write_text(html, encoding="utf-8")
    return destino, len(html)


if __name__ == "__main__":
    d, n = construir()
    print(f"{d.name}: {n / 1024:.0f} KB")
