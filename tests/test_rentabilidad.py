import numpy as np
import pandas as pd
import pytest

from sedes import pipeline, rentabilidad as R, sintetico_rentabilidad as SR


@pytest.fixture(scope="module")
def excel():
    return SR.escribir(semilla=5)


@pytest.fixture(scope="module")
def leido(excel):
    xlsx, coord = excel
    return R.leer_rentabilidad(xlsx, coordenadas=coord,
                               sobrescrituras={"fecha_referencia": "2026-11-01", "n_simulaciones": 200})


def test_clasifica_las_cinco_hojas(leido):
    _, inf = leido
    assert dict(zip(inf.hojas["hoja"], inf.hojas["tipo"])) == {
        "Y 2025": "ANUAL", "Y 2026": "MENSUAL", "VTA HIST": "HISTORICO",
        "EN PROCESO": "EN_PROCESO", "CTA ARRIENDO": "ARRIENDO"}


def test_detecta_defectos_del_historico(leido):
    _, inf = leido
    txt = " ".join(p.mensaje for p in inf.problemas)
    assert "20251110" in txt and "fuera de orden" in txt


def test_fecha_repetida_se_suma_y_cuadra(leido):
    _, inf = leido
    assert inf.cuadre["ok"].all()


def test_corte_en_ultimo_mes_completo(leido):
    d, _ = leido
    assert d.config["fecha_corte"] == "2026-09-01"
    assert d.ventas["mes"].max() == pd.Timestamp("2026-09-01")


def test_jornadas_son_dias_con_venta(leido):
    d, _ = leido
    assert d.ventas["jornadas"].between(1, 31).all()


def test_identidades_encuentran_la_formula_correcta(leido):
    _, inf = leido
    r = inf.identidades.set_index("regla")["resultado"]
    assert r["MARGEN = COMISION - GASTOS"] == "100%"
    assert r["MARGEN = INGRESOS - GASTOS"] != "100%"
    assert r["CHS|2025 = CHS|2025#2"] == "100%"
    assert "0.1050" in r["FONDO PREMIOS / VTA|2025"]


def test_resuelve_nombres_con_tildes_y_prefijos(leido):
    _, inf = leido
    assert inf.pendientes["nombre"].tolist() == ["Local Inexistente 99"]


def test_equivalencias_resuelven_pendientes(excel, leido):
    xlsx, coord = excel
    d0, _ = leido
    sid = d0.sedes.index[0]
    _, inf = R.leer_rentabilidad(xlsx, coordenadas=coord, equivalencias={"Local Inexistente 99": sid},
                                 sobrescrituras={"fecha_referencia": "2026-11-01"})
    assert len(inf.pendientes) == 0


def test_estados_y_grupos(leido):
    d, _ = leido
    s = d.sedes
    assert (s.loc[s["accion"].astype(str).str.upper() == "VIRTUAL", "grupo"] == "DIGITAL").all()
    assert (s.loc[s["gestion"].astype(str).str.upper() == "CERRADO", "estado"] == "CERRADA").all()
    vend = s["accion"].astype(str).str.upper() == "VENDIDO"
    assert (s.loc[vend, "estado"] == "VIGENTE").all() and (s.loc[vend, "arriendo_mensual_clp"] == 0).all()


def test_plazo_vencido_se_alerta(leido):
    _, inf = leido
    assert "PLAZO DE AVISO VENCIDO" in set(inf.contratos["alerta"])


def test_hipodromo_desconocido_avisa():
    hojas, coord = SR.generar(semilla=5)
    hojas["VTA HIST"].loc[0, "HIPÓDROMO"] = "PALERMO"
    import io
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as xw:
        for n, df in hojas.items():
            df.to_excel(xw, sheet_name=n, index=False)
    _, inf = R.leer_rentabilidad(buf.getvalue(), coordenadas=coord, sobrescrituras={"fecha_referencia": "2026-11-01"})
    assert any("PALERMO" in p.mensaje for p in inf.problemas)


def test_pipeline_con_formato_cliente(leido):
    d, _ = leido
    res = pipeline.analizar(d)
    assert (res["demanda_anual"]["metodo"] == "SIMPLE_RED").all()
    fis = res["sedes"][res["sedes"]["grupo"] != "DIGITAL"]
    assert fis["segmento"].notna().all()


@pytest.mark.parametrize("txt,dias", [("180 días", 180), ("60 dias", 60), ("3 meses", 90), (90, 90)])
def test_a_dias(txt, dias):
    assert R.a_dias(txt) == dias


def test_ui_api_desde_filas_del_navegador(excel):
    """Simula lo que entrega SheetJS: {hoja: filas} con fechas como texto AAAA-MM-DD."""
    import io, json
    from sedes import ui_api
    xlsx, coord = excel
    libro = pd.read_excel(io.BytesIO(xlsx), sheet_name=None, header=None)
    filas = {h: [[(v.strftime("%Y-%m-%d") if isinstance(v, pd.Timestamp) else (None if pd.isna(v) else v)) for v in fila]
                 for fila in df.itertuples(index=False)] for h, df in libro.items()}
    out = json.loads(ui_api.ejecutar(json.dumps(filas, default=str), coordenadas_csv=coord.to_csv(index=False),
                                     params=json.dumps({"fecha_referencia": "2026-11-01", "n_simulaciones": 100})))
    assert out["formato"] == ui_api.FORMATO
    assert out["informe"]["resumen"]["mes de corte"] == "2026-09-01"
    assert len(out["red"]["ids"]) == len(out["red"]["km"]) > 10
    assert all(r["ok"] for r in out["informe"]["cuadre_fallas"]) and not out["informe"]["cuadre_fallas"]


def test_nombre_parecido_se_asigna_solo():
    hojas, coord = SR.generar(semilla=5)
    hojas["EN PROCESO"].loc[1, "DIVISIÓN"] = hojas["EN PROCESO"].loc[1, "DIVISIÓN"] + " XX"   # typo menor
    import io
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as xw:
        for n, df in hojas.items():
            df.to_excel(xw, sheet_name=n, index=False)
    _, inf = R.leer_rentabilidad(buf.getvalue(), coordenadas=coord, sobrescrituras={"fecha_referencia": "2026-11-01"})
    assert len(inf.automaticas) == 1 and inf.automaticas.iloc[0]["similitud"] >= 0.8
    assert inf.pendientes["nombre"].tolist() == ["Local Inexistente 99"]


def test_ui_api_direcciones(excel):
    import io, json
    from sedes import ui_api
    xlsx, _ = excel
    libro = pd.read_excel(io.BytesIO(xlsx), sheet_name=None, header=None)
    filas = {h: [[None if pd.isna(v) else (str(v) if isinstance(v, pd.Timestamp) else v) for v in f] for f in df.itertuples(index=False)] for h, df in libro.items()}
    d = json.loads(ui_api.direcciones(json.dumps(filas, default=str)))
    assert len(d) > 50 and {"sede_id", "direccion", "zona"} <= set(d[0])


def test_categorias_familias_y_calibracion(leido):
    d, _ = leido
    res = pipeline.analizar(d)
    s = res["sedes"]
    # los cierres decididos son un hecho: categoria propia y no sirven de receptoras
    dec = s["cierre_decidido"].fillna(False).astype(bool)
    assert dec.any() and (s.loc[dec, "categoria"] == "CIERRE EN CURSO").all()
    assert set(s["categoria"]) <= set(pipeline.CATEGORIAS)
    fams = res["extras"]["familias"]
    assert {"geografica", "comercial", "completa"} <= set(fams)
    g = fams["geografica"]
    assert len(g["estabilidad"]) == len(g["ids"]) and 2 <= g["k_sugerido"] <= 8
    cal = res["extras"]["calibracion"]
    assert cal["estado"] in ("CALIBRADO", "SIN CALIBRAR")


def test_calibracion_recupera_retencion_sintetica():
    """El sintetico traspasa 45% de la venta de cada cierre a sus 3 vecinas: la retencion observada debe acercarse."""
    from sedes import calibracion, demanda
    xlsx, coord = SR.escribir(semilla=11)
    d, _ = R.leer_rentabilidad(xlsx, coordenadas=coord, sobrescrituras={"fecha_referencia": "2026-11-01"})
    hist, corte, _ = demanda.serie_historica(d)
    cal = calibracion.calibrar(d, hist, corte)
    assert cal["estado"] == "CALIBRADO" and cal["n_eventos"] >= 2
    assert 0.25 <= cal["retencion_observada_media"] <= 0.6


def test_encabezado_id_division_con_tilde_y_espacio():
    """'Id División' (como puede venir en el Excel real) debe reconocerse igual que 'Id_Division'."""
    hojas, coord = SR.generar(semilla=5)
    hojas["Y 2025"] = hojas["Y 2025"].rename(columns={"Id_Division": "Id División"})
    import io
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as xw:
        for n, df in hojas.items():
            df.to_excel(xw, sheet_name=n, index=False)
    d, inf = R.leer_rentabilidad(buf.getvalue(), coordenadas=coord, sobrescrituras={"fecha_referencia": "2026-11-01"})
    assert "ANUAL" in set(inf.hojas["tipo"])
    assert d.sedes["margen_hoja"].notna().sum() > 30
    col = inf.columnas.set_index(["hoja", "campo"])
    assert col.loc[("Y 2025", "MARGEN"), "encontrada"]


def test_direcciones_incluye_sedes_sin_direccion_por_nombre(excel):
    import io
    xlsx, _ = excel
    hojas = pd.read_excel(io.BytesIO(xlsx), sheet_name=None)
    hojas["Y 2026"] = hojas["Y 2026"].iloc[5:]          # 5 sedes sin fila (y sin direccion) en la hoja mensual
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as xw:
        for n, df in hojas.items():
            df.to_excel(xw, sheet_name=n, index=False)
    d = R.direcciones(buf.getvalue())
    assert (d["tipo"] == "nombre").sum() >= 4
    assert not d.loc[d["tipo"] == "nombre", "direccion"].str.contains("TLK").any()


def test_grafo_roles_en_cadena():
    from sedes import grafo
    # A - B - C en linea (2 km entre vecinas) y D aislada, todas en Santiago urbano
    ids = ["A", "B", "C", "D"]
    km = np.array([[0, 2, 4, 20], [2, 0, 2, 20], [4, 2, 0, 20], [20, 20, 20, 0]], float)
    z = {i: "SANTIAGO URBANO" for i in ids}
    r = grafo.analizar(ids, km, z, {i: 1.0 for i in ids}, ["B"], {"SANTIAGO URBANO": 3.0})
    hoy, esc = r["hoy"], r["escenario"]
    assert hoy["D"]["rol"] == "SIN RESPALDO"
    assert hoy["B"]["rol"] == "CRITICA" and hoy["B"]["dependen"] == ["A", "C"]
    assert hoy["A"]["rol"] == "REDUNDANTE" and hoy["A"]["red_local"] == "Santiago urbano 1"
    # Al cerrar B, A y C pierden su unica alternativa
    assert esc["A"]["pierde_respaldo"] and esc["C"]["pierde_respaldo"] and "B" not in esc
    assert r["resumen_escenario"][0]["sin_respaldo"] == 3


def test_linea_de_tiempo_corta_la_red_en_cada_fecha():
    from sedes import grafo
    ids = ["A", "B", "C", "D"]
    km = np.array([[0, 2, 4, 20], [2, 0, 2, 20], [4, 2, 0, 20], [20, 20, 20, 0]], float)
    z = {i: "SANTIAGO URBANO" for i in ids}
    r = grafo.linea_tiempo(ids, km, z, {}, {"SANTIAGO URBANO": 3.0},
                           [{"fecha": "2026-10", "cerradas": []}, {"fecha": "2027-03", "cerradas": ["B"]}])
    hoy, despues = r["cortes"]
    assert hoy["roles"]["B"][0] == "CRITICA" and len(r["aristas"]) == 2
    assert "B" not in despues["roles"] and despues["roles"]["A"] == ["SIN RESPALDO", 0]
    assert despues["resumen"][0]["sedes"] == 3


def test_grafo_en_resultado(leido):
    d, _ = leido
    res = pipeline.analizar(d)
    g = res["extras"]["grafo"]
    assert set(res["sedes"]["zona_red"].dropna()) <= {"SANTIAGO URBANO", "ALREDEDORES RM", "REGIONES", "DIGITAL"}
    assert g["hoy"] and {"rol", "vecinas", "red_local"} <= set(next(iter(g["hoy"].values())))
    assert set(g["cerradas"]) == set(res["sedes"].index[res["sedes"]["cierre_decidido"].fillna(False).astype(bool)]) & set(g["hoy"])
    # Sedes ya cerradas con ubicacion, para el pasado de la linea de tiempo
    assert not set(res["sedes_cerradas"].index) & set(res["sedes"].index)


def test_metro_acorta_viajes_largos_y_nunca_supera_caminar():
    from sedes import transporte as T
    lat = [-33.4378, -33.4183, -33.4378]; lon = [-70.6505, -70.6017, -70.661]   # Plaza de Armas, Tobalaba, 1 km al oeste
    km = T._km(np.array(lat)[:, None], np.array(lon)[:, None], np.array(lat)[None], np.array(lon)[None]) * 1.3
    m, pie = T.minutos_metro(lat, lon, km), T.minutos_pie(km)
    assert m[0, 1] < pie[0, 1] / 2 and 15 < m[0, 1] < 35
    assert (m <= pie + 1e-9).all()


def test_grafo_usa_modo_de_acceso_por_zona():
    from sedes import grafo
    km = np.array([[0, 5.0], [5.0, 0]])
    t = {"pie": [[0, 60], [60, 0]], "metro": [[0, 18], [18, 0]], "auto": [[0, 12], [12, 0]]}
    z = ["SANTIAGO URBANO"] * 2
    C = grafo.costo(km, t, z, {"SANTIAGO URBANO": {"modo": "metro", "umbral": 20}})
    assert C[0, 1] == 18
    assert grafo.costo(km, t, z, {"SANTIAGO URBANO": {"modo": "pie", "umbral": 20}})[0, 1] == 60
    assert grafo.costo(km, t, ["SANTIAGO URBANO", "REGIONES"], {"SANTIAGO URBANO": {"modo": "km", "umbral": 3}})[0, 1] == 9999


def test_tren_nos_combina_con_metro_en_alameda():
    from sedes import transporte as T
    G = T.grafo_metro()
    assert G.has_edge(("Nos", "Alameda"), ("1", "Estación Central")) and G.has_edge(("Nos", "Lo Valledor"), ("6", "Lo Valledor"))
    # Estacion Central -> San Bernardo: en tren mucho mas rapido que caminando
    lat = [-33.4520, -33.5925]; lon = [-70.6790, -70.6996]
    km = T._km(np.array(lat)[:, None], np.array(lon)[:, None], np.array(lat)[None], np.array(lon)[None]) * 1.3
    assert T.minutos_metro(lat, lon, km)[0, 1] < 45 < T.minutos_pie(km)[0, 1]


def test_estaciones_homonimas_lejanas_no_combinan():
    from sedes import transporte as T
    G = T.grafo_metro()
    assert not G.has_edge(("Laja", "San Miguel"), ("2", "San Miguel"))
    assert G.has_edge(("Laja", "Concepción"), ("Biotren L1", "Concepción"))


def test_alcance_de_hipodromos():
    from sedes import transporte as T
    lat = [-33.4100, -36.80]; lon = [-70.6600, -73.05]      # cerca del Hipodromo Chile y en Concepcion
    H = {h["codigo"]: h for h in T.alcance_hipodromos(lat, lon)}
    assert set(H) == {"HCH", "CHS", "VSC", "CHC"}
    assert H["HCH"]["zona"] == "SANTIAGO URBANO" and H["CHC"]["zona"] == "REGIONES"
    assert H["HCH"]["metro"][0] < 20 and H["HCH"]["metro"][1] > 1000


def test_hipodromo_es_alternativa_fija():
    from sedes import grafo
    # A - HIP a 2 km; B aislada. El hipodromo no cierra ni se cuenta como sede
    ids = ["A", "B", "HIP"]
    km = np.array([[0, 20, 2], [20, 0, 20], [2, 20, 0]], float)
    z = {i: "SANTIAGO URBANO" for i in ids}
    r = grafo.analizar(ids, km, z, {}, ["HIP", "A"], {"SANTIAGO URBANO": 3.0}, fijos=["HIP"])
    assert r["cerradas"] == ["A"] and r["hoy"]["A"]["rol"] == "REDUNDANTE"
    assert r["resumen_hoy"][0]["sedes"] == 2 and r["resumen_hoy"][0]["sin_respaldo"] == 1


def test_corte_de_margen_por_defecto_es_la_mediana_de_la_zona():
    # Todas con margen positivo: igual se reparten entre cerrar primero y cerrar despues
    from sedes import config
    ficha = pd.DataFrame({"margen_base": [10.0, 20.0, 30.0, 40.0, 100.0, 200.0],
                          "retencion_huff": [0.9, 0.9, 0.9, 0.9, 0.9, 0.9],
                          "zona_red": ["SANTIAGO URBANO"] * 4 + ["REGIONES"] * 2})
    cat = pipeline.categorizar(ficha, {**config.DEFAULTS, "umbral_retencion": 0.5}).tolist()
    assert cat[:4] == ["CERRAR PRIMERO", "CERRAR PRIMERO", "CERRAR DESPUES", "CERRAR DESPUES"]
    assert cat[4:] == ["CERRAR PRIMERO", "CERRAR DESPUES"]


def test_entorno_censo_por_comuna():
    # Comuna por coordenadas (límites BCN) y perfil del Censo 2024 (INE)
    from sedes import censo, transporte
    h = transporte.hipodromos()
    p = censo.perfil(h["lat"], h["lon"])
    assert p["comuna_censo"].tolist() == ["Independencia", "Santiago", "Viña del Mar", "Hualpén"]
    assert p["pct_hombres_50_mas"].between(0.05, 0.3).all() and p["escolaridad_50_mas"].between(6, 18).all()
    assert censo.comuna_de([-40.0], [-80.0]) == [None]          # en el mar, lejos de la costa


def test_codigos_disponible_no_son_sedes(excel, tmp_path):
    # Filas "DISPONIBLE" de la hoja anual: código de división sin sede asignada
    import openpyxl
    xlsx, coord = excel
    import io
    wb = openpyxl.load_workbook(io.BytesIO(xlsx))
    ws = next(wb[n] for n in wb.sheetnames if n.strip().upper().startswith("Y 2025"))
    enc = [c.value for c in ws[1]]
    fila = [None] * len(enc)
    fila[enc.index("Id_Division")], fila[enc.index("DIVISIÓN")] = "009.009.999", "DISPONIBLE"
    ws.append(fila)
    vacia = [None] * len(enc)
    vacia[enc.index("Id_Division")] = "009.009.998"           # Id valido sin nombre ni ventas
    ws.append(vacia)
    destino = tmp_path / "con_disponible.xlsx"
    wb.save(destino)
    d, inf = R.leer_rentabilidad(destino, coordenadas=coord, sobrescrituras={"fecha_referencia": "2026-11-01", "n_simulaciones": 200})
    assert d.sedes.at["009.009.999", "estado"] == "DISPONIBLE"
    assert "009.009.999" not in d.ids_vigentes
    assert d.sedes.at["009.009.998", "estado"] == "DISPONIBLE" and "009.009.998" not in d.ids_vigentes
    assert any(p.hoja == "SEDES" and "sin sede" in p.mensaje for p in inf.problemas)
    fila = inf.disponibles.set_index("sede_id").loc["009.009.999"]
    assert fila["venta_12m_nominal"] == 0 and "Y 2025" in fila["hojas"]


def test_lineas_futuras_se_suman_desde_su_apertura():
    from sedes import transporte as T, grafo
    lat = np.array([-33.6635, -33.5675, -33.4010, -33.4060]); lon = np.array([-70.9290, -70.8160, -70.7450, -70.5990])
    km = T._km(lat[:, None], lon[:, None], lat[None], lon[None]) * 1.3
    m = T.matrices(["TAL", "PH", "REN", "VIT"], lat, lon, km, ["ALREDEDORES RM", "ALREDEDORES RM", "SANTIAGO URBANO", "SANTIAGO URBANO"])
    f = {x["fecha"]: x["metro"] for x in m["futuras"]}
    assert m["metro"][0][1] > 150 and f["2028-06"][0][1] < 45          # Talagante-Padre Hurtado: tren a Melipilla
    assert f["2028-06"][2][3] > 150 and f["2028-12"][2][3] < 60        # Renca-Vitacura: Línea 7
    assert set(T.estaciones("2026-11")["estacion"]) == set(T.estaciones()["estacion"])
    # Un corte con su propia matriz rearma el grafo
    ids = ["A", "B"]; z = {i: "SANTIAGO URBANO" for i in ids}
    r = grafo.linea_tiempo(ids, [[0, 50], [50, 0]], z, {}, {"SANTIAGO URBANO": 20.0},
                           [{"fecha": "2026-10", "cerradas": []}, {"fecha": "2028-12", "cerradas": [], "km": [[0, 15], [15, 0]]}])
    assert r["cortes"][0]["roles"]["A"][0] == "SIN RESPALDO" and r["cortes"][1]["aristas"] == [["A", "B"]]


def test_caminata_real_a_estaciones_reemplaza_la_linea_recta():
    from sedes import transporte as T
    lat = np.array([-33.4378, -33.4183]); lon = np.array([-70.6505, -70.6017])     # Plaza de Armas, Tobalaba
    km = T._km(lat[:, None], lon[:, None], lat[None], lon[None]) * 1.3
    base = T.matrices(["A", "B"], lat, lon, km, ["SANTIAGO URBANO"] * 2)
    real = T.matrices(["A", "B"], lat, lon, km, ["SANTIAGO URBANO"] * 2,
                      acceso={"A": {"5|Plaza de Armas": 12.0, "3|Plaza de Armas": 12.0}, "B": {"1|Tobalaba": 9.0, "4|Tobalaba": 9.0}})
    assert real["metro"][0][1] > base["metro"][0][1] + 10 and real["fuente"]["acceso"].startswith("OpenStreetMap")


def test_ruta_metro_entre_dos_puntos():
    from sedes import transporte as T
    r = T.ruta_metro((-33.4378, -70.6505), (-33.4183, -70.6017), 60.0)           # Plaza de Armas -> Tobalaba
    assert r["modo"] == "metro" and r["camino"][0][3] == "Plaza de Armas" and r["camino"][-1][3] == "Tobalaba"
    assert T.ruta_metro((-33.4378, -70.6505), (-33.4400, -70.6470), 6.0)["modo"] == "pie"
