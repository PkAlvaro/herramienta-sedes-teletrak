"""Prepara los datos públicos del entorno de cada sede (se corre una vez, fuera del navegador).

Fuentes oficiales:
- INE, Censo de Población y Vivienda 2024 (censo2024.ine.gob.cl/estadisticas):
  D1 "Población censada por sexo y edad en grupos quinquenales" (hoja 4, por comuna) y
  H1 "Servicios básicos del hogar" (hoja 6, equipos y servicios del hogar por comuna) y
  P7 "Educación" (hoja 6, años de escolaridad promedio por grupo de edad y comuna).
- Biblioteca del Congreso Nacional, mapas vectoriales: "División comunal" (comunas_final.zip).
  Uso libre citando a la BCN. Viene en Web Mercator; se pasa a latitud/longitud y se simplifica.

Salidas en sedes/datos_publicos/: censo2024_comunas.csv y comunas_bcn.json.
Requiere pyshp y shapely (no van en el navegador):

    python -m sedes.preparar_censo D1.xlsx H1.xlsx P7.xlsx comunas.shp
"""
import json
import math
import sys
from pathlib import Path

import pandas as pd

SALIDA = Path(__file__).parent / "datos_publicos"
EDADES_50 = ["50 a 54", "55 a 59", "60 a 64", "65 a 69", "70 a 74", "75 a 79", "80 a 84", "85 o más"]


def _tabla(xlsx, hoja):
    df = pd.read_excel(xlsx, hoja, header=3)
    df = df[pd.to_numeric(df["Código comuna"], errors="coerce") > 0].copy()
    df["codigo_comuna"] = df["Código comuna"].astype(int)
    return df


def censo(d1, h1, p7):
    ed = _tabla(d1, "4")
    ed = ed[~ed["Grupos de edad"].astype(str).str.startswith("Total")]
    for c in ("Población censada", "Hombres"):
        ed[c] = pd.to_numeric(ed[c], errors="coerce")
    g = ed.groupby(["codigo_comuna", "Comuna", "Región"])
    out = g[["Población censada", "Hombres"]].sum().rename(columns={"Población censada": "poblacion", "Hombres": "hombres"})
    out["hombres_50_mas"] = ed[ed["Grupos de edad"].isin(EDADES_50)].groupby("codigo_comuna")["Hombres"].sum().reindex(out.index.get_level_values(0)).values
    out = out.reset_index().rename(columns={"Comuna": "comuna", "Región": "region"})
    eq = _tabla(h1, "6")
    col = eq.columns[6]                                   # Sí / No / no informado
    fija = [c for c in eq.columns if str(c).startswith("Internet fija")][0]
    movil = [c for c in eq.columns if str(c).startswith("Internet móvil")][0]
    for c in (fija, movil):                               # celdas reservadas vienen como texto
        eq[c] = pd.to_numeric(eq[c], errors="coerce")
    si = eq[eq[col] == "Sí"].set_index("codigo_comuna")
    resp = eq[eq[col].isin(["Sí", "No"])].groupby("codigo_comuna")[[fija, movil]].sum()
    out["pct_internet_fija"] = (si[fija] / resp[fija]).reindex(out["codigo_comuna"]).round(4).values
    out["pct_internet_movil"] = (si[movil] / resp[movil]).reindex(out["codigo_comuna"]).round(4).values
    out["pct_hombres_50_mas"] = (out["hombres_50_mas"] / out["poblacion"]).round(4)
    # Escolaridad de los 50+: promedio de cada tramo de edad ponderado por su población
    es = _tabla(p7, "6")
    es = es[es["Grupos de edad"].isin(EDADES_50)].copy()
    es["anos"] = pd.to_numeric(es["Años de escolaridad promedio"], errors="coerce")
    pob = ed[ed["Grupos de edad"].isin(EDADES_50)][["codigo_comuna", "Grupos de edad", "Población censada"]]
    es = es.merge(pob, on=["codigo_comuna", "Grupos de edad"], how="left").dropna(subset=["anos", "Población censada"])
    esc = es.groupby("codigo_comuna").apply(lambda g: (g["anos"] * g["Población censada"]).sum() / g["Población censada"].sum(), include_groups=False)
    out["escolaridad_50_mas"] = esc.reindex(out["codigo_comuna"]).round(2).values
    return out


def _lonlat(x, y):
    R = 6378137.0
    return round(math.degrees(x / R), 4), round(math.degrees(2 * math.atan(math.exp(y / R)) - math.pi / 2), 4)


def comunas(shp, tol_rm=70.0, tol_resto=1200.0):
    """Polígonos por código de comuna. Más detalle en la RM (comunas chicas, sedes cerca de los límites)."""
    import shapefile
    from shapely.geometry import shape
    r = shapefile.Reader(str(shp), encoding="utf-8")
    out = {}
    for sr in r.iterShapeRecords():
        cod = int(sr.record["cod_comuna"])
        tol = tol_rm if int(sr.record["codregion"]) == 13 else tol_resto
        geo = shape(sr.shape.__geo_interface__).simplify(tol, preserve_topology=True)
        polis = geo.geoms if geo.geom_type == "MultiPolygon" else [geo]
        anillos = []
        for p in polis:
            if p.area < 3e6:                               # islotes menores a 3 km2
                continue
            anillos.append([_lonlat(x, y) for x, y in p.exterior.coords])
        out[cod] = anillos
    return out


if __name__ == "__main__":
    d1, h1, p7, shp = sys.argv[1:5]
    c = censo(d1, h1, p7)
    c.to_csv(SALIDA / "censo2024_comunas.csv", index=False)
    poli = comunas(shp)
    (SALIDA / "comunas_bcn.json").write_text(json.dumps(poli, separators=(",", ":")), encoding="utf-8")
    sin = sorted(set(c["codigo_comuna"]) - set(poli))
    print(f"{len(c)} comunas en el censo, {len(poli)} polígonos; sin polígono: {sin}")
