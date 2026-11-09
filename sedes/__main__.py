"""Linea de comandos.

Excel de rentabilidad del cliente (formato real):
    python -m sedes informe-carga rentabilidad.xlsx --coordenadas coordenadas.csv
    python -m sedes geocodificar rentabilidad.xlsx --salida coordenadas.csv
    python -m sedes analizar rentabilidad.xlsx --coordenadas coordenadas.csv --salida resultados.xlsx

Plantilla propia:
    python -m sedes plantilla plantilla_sedes.xlsx
    python -m sedes analizar datos.xlsx --salida resultados.xlsx

Datos sinteticos para probar:
    python -m sedes sintetico ejemplo.xlsx
    python -m sedes sintetico-cliente rentabilidad_sintetica.xlsx
"""
import argparse
import json
import sys
import time

from . import datos, estado, pipeline, plantilla, rentabilidad, sintetico


def _params(lista):
    out = {}
    for kv in lista or []:
        k, v = kv.split("=", 1)
        try:
            out[k] = json.loads(v)
        except json.JSONDecodeError:
            out[k] = v
    return out


def _es_cliente(fuente):
    hojas, _ = rentabilidad.leer_libro(fuente)
    return any(h.tipo == "HISTORICO" for h in hojas)


def _cargar(a, sobre):
    if _es_cliente(a.fuente):
        d, inf = rentabilidad.leer_rentabilidad(a.fuente, coordenadas=a.coordenadas,
                                                equivalencias=a.equivalencias, sobrescrituras=sobre)
        return d, inf
    return datos.leer_plantilla(a.fuente, sobrescrituras=sobre), None


def _guardar_informe(inf, destino):
    inf.a_excel(destino)
    if inf.pendientes is not None and len(inf.pendientes):
        pend = destino.rsplit(".", 1)[0] + "_equivalencias_pendientes.csv"
        # sede_id va vacio a proposito: la sugerencia se confirma copiandola a mano, nunca se acepta sola
        inf.pendientes.assign(sede_id="")[["nombre", "sede_id", "sugerencia_id", "sugerencia", "similitud", "hoja"]] \
            .to_csv(pend, index=False)
        print(f"Revisar y confirmar nombres en {pend} (guardar como equivalencias.csv con columnas nombre,sede_id)", file=sys.stderr)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="sedes", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def comunes(p):
        p.add_argument("fuente")
        p.add_argument("--coordenadas", help="CSV sede_id,lat,lon (de 'geocodificar')")
        p.add_argument("--equivalencias", help="CSV nombre,sede_id para nombres sin Id_Division")
        p.add_argument("--param", action="append", metavar="CLAVE=VALOR", help='ej. --param huff_lambda=3 --param \'sedes_g9=["006.003.020"]\'')

    p = sub.add_parser("plantilla", help="escribe la plantilla propia en blanco")
    p.add_argument("destino")
    p = sub.add_parser("sintetico", help="plantilla propia con datos sinteticos")
    p.add_argument("destino")
    p.add_argument("--semilla", type=int, default=7)
    p = sub.add_parser("sintetico-cliente", help="Excel sintetico con el formato del cliente")
    p.add_argument("destino")
    p.add_argument("--semilla", type=int, default=11)
    p = sub.add_parser("validar", help="valida la plantilla propia")
    p.add_argument("fuente")
    p = sub.add_parser("informe-carga", help="lee el Excel del cliente y genera el informe de carga")
    comunes(p)
    p.add_argument("--salida", default="informe_carga.xlsx")
    p = sub.add_parser("geocodificar", help="coordenadas desde las direcciones (envia SOLO direcciones a OpenStreetMap)")
    p.add_argument("fuente")
    p.add_argument("--salida", default="coordenadas.csv")
    p = sub.add_parser("analizar", help="corre todos los modulos")
    comunes(p)
    p.add_argument("--salida", default="resultados.xlsx")
    p.add_argument("--estado", help="guarda tambien un estado .sedes.json")
    p.add_argument("--nombre", default="")
    p.add_argument("--sim", type=int, help="numero de simulaciones Monte Carlo")
    p.add_argument("--incluir-datos", action="store_true", help="incluye datos crudos en el estado")
    a = ap.parse_args(argv)

    if a.cmd == "plantilla":
        plantilla.escribir(a.destino)
    elif a.cmd == "sintetico":
        plantilla.escribir(a.destino, sintetico.generar(a.semilla), nota=sintetico.NOTA)
    elif a.cmd == "sintetico-cliente":
        from . import sintetico_rentabilidad as sr
        _, coord = sr.escribir(a.destino, a.semilla)
        c = a.destino.rsplit(".", 1)[0] + "_coordenadas.csv"
        coord.to_csv(c, index=False)
        print(f"escrito {a.destino} y {c}", file=sys.stderr)
    elif a.cmd == "validar":
        try:
            d = datos.leer_plantilla(a.fuente)
        except datos.PlantillaInvalida as e:
            for pr in e.problemas:
                print(pr)
            return 1
        for pr in d.problemas:
            print(pr)
        print(f"OK: {len(d.sedes)} sedes, {len(d.ids_vigentes)} vigentes")
    elif a.cmd == "informe-carga":
        _, inf = rentabilidad.leer_rentabilidad(a.fuente, coordenadas=a.coordenadas,
                                                equivalencias=a.equivalencias, sobrescrituras=_params(a.param))
        print(inf.texto())
        _guardar_informe(inf, a.salida)
        print(f"\ninforme detallado en {a.salida}", file=sys.stderr)
    elif a.cmd == "geocodificar":
        from . import geocodificar
        dirs = rentabilidad.direcciones(a.fuente)
        print(f"{len(dirs)} direcciones. Se envian SOLO las direcciones a OpenStreetMap, 1 por segundo.", file=sys.stderr)
        res = geocodificar.geocodificar(dirs, a.salida, progreso=lambda m: print(m, file=sys.stderr))
        print(res["calidad"].value_counts().to_string())
    elif a.cmd == "analizar":
        sobre = _params(a.param)
        if a.sim:
            sobre["n_simulaciones"] = a.sim
        d, inf = _cargar(a, sobre)
        if inf is not None:
            _guardar_informe(inf, a.salida.rsplit(".", 1)[0] + "_informe_carga.xlsx")
        for pr in d.problemas:
            print(pr, file=sys.stderr)
        t0 = time.time()
        res = pipeline.analizar(d, progreso=lambda i, n, s: print(f"\rdemanda {i + 1}/{n}   ", end="", file=sys.stderr))
        print(f"\nlisto en {time.time() - t0:.0f} s", file=sys.stderr)
        pipeline.exportar_excel(res, a.salida)
        if a.estado:
            estado.guardar(res, d, a.estado, nombre=a.nombre, informe=inf, incluir_datos=a.incluir_datos)
    return 0


if __name__ == "__main__":
    sys.exit(main())
