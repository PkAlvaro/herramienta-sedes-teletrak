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
    # Logos de Teletrak e Hipodromo Chile, incrustados (uso local autorizado)
    for clave, archivo in (("__LOGO_TELETRAK__", "teletrak.png"), ("__LOGO_HIPODROMO__", "hipodromo_chile.png"), ("__ICONO__", "icono.png")):
        datos = base64.b64encode((RAIZ / "ui" / "marca" / archivo).read_bytes()).decode()
        html = html.replace(clave, "data:image/png;base64," + datos, 1)
    destino.write_text(html, encoding="utf-8")
    return destino, len(html)


if __name__ == "__main__":
    d, n = construir()
    print(f"{d.name}: {n / 1024:.0f} KB")
