# Herramienta de análisis de sedes Teletrak

Núcleo en Python para analizar la red de sedes: demanda, cobertura en red, economía y segmentación. Después se le suma una interfaz web que corre el mismo código en el navegador (Pyodide), sin servidor y sin que los datos salgan del equipo.

Herramienta desarrollada por el Grupo 21 para el curso ICS 3913 Evaluación de Proyectos (PUC, 2026). Este repositorio contiene solo la herramienta y datos sintéticos. Los datos reales del cliente no se incluyen. Para revisarla basta abrir `herramienta_sedes.html` y cargar `datos_ejemplo/rentabilidad_sintetica.xlsx`.

## Cómo usarla

1. Abrir `herramienta_sedes.html` (doble clic) en Chrome, Edge, Firefox o Brave. No se instala nada.
2. En **Nuevo análisis**, elegir el Excel de rentabilidad y apretar **Analizar**. El Excel no está en el repo: cada uno usa su copia.
3. La primera vez necesita internet (descarga Python en el navegador, mapas y ubica las sedes) y tarda 1 a 2 minutos. Después queda en **Retomar análisis** de ese navegador.

Para probar sin el Excel real: `datos_ejemplo/rentabilidad_sintetica.xlsx`.

## Cómo modificarla

```bash
uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -e ".[dev]"
.venv/bin/python -m pytest -q tests                              # tests
.venv/bin/python ui/extender_dashboard.py ui/base_ruben.html     # regenera ui/app.html
.venv/bin/python construir_ui.py                                 # arma herramienta_sedes.html (se versiona)
```

## Interfaz (detalle)

Abrir `herramienta_sedes.html` en Chrome, Edge o Firefox, elegir el Excel de rentabilidad y apretar **Analizar**. No pide nada más.

- **Ubicación de las sedes:** se obtiene sola desde las direcciones de la hoja Y 202X. Se consultan solo las direcciones en OpenStreetMap (una por segundo) y quedan guardadas en el navegador, así que la segunda vez no se consulta nada. Si una dirección no aparece, se usa el centro de la comuna o de Santiago, y el informe lo marca.
- **Nombres sin Id** (EN PROCESO, CTA ARRIENDO): los iguales o casi iguales (≥80% de parecido) se cruzan solos y quedan listados para revisar. Los demás se eligen de una lista en el informe de carga con "Guardar y reanalizar". La elección queda guardada.
- **Cartera focal (G9):** se marca con ★ en Sedes y contratos.
- **Parámetros:** no se muestran. El cálculo usa los valores por defecto del núcleo. Lo que vale la pena mover en vivo (λ, U₀, g₁, κ, φ, shock, inflación) está en los sliders del dashboard de demanda.
- **Privacidad:** el Excel se procesa en el navegador con el mismo código Python del paquete (Pyodide).
- **Tiempos:** la primera vez tarda 1-2 minutos, entre cargar Python y ubicar las direcciones. Después tarda unos segundos.
- **Guardar estado:** guarda el análisis y la vista en este navegador. La pestaña Carga muestra primero "Retomar análisis" (lo guardado y los Excel ya analizados) y debajo "Nuevo análisis". **Presentar:** igual que antes.
- **Línea de tiempo (Red de sedes):** barra de meses con botón Reproducir. Hasta el último mes con datos muestra las sedes con venta real de VTA HIST, incluidas las ya cerradas (ubicadas por su nombre). Después muestra el calendario de cierres: los decididos por la gerencia van en su fecha; los demás son una propuesta, en la que cada sede cierra en el primer vencimiento de contrato que se alcanza a avisar dentro de su etapa (cerrar primero: desde hoy; después: +12 meses; al final: +24 meses; con plan digital: 6 meses más), suponiendo renovación anual. La red y los roles se recalculan en cada fecha (`grafo.linea_tiempo`).

**Marca:** franja verde Teletrak con los logos de Teletrak e Hipódromo Chile (`ui/marca/`, incrustados por `construir_ui.py`; uso local autorizado). Paleta: verde #00853A, índigo #2E3192 y naranja #F15A24 de Teletrak como principales; marino #003058 y grises #98A0B0/#C0C8D0 de Hipódromo Chile como secundarios. Títulos en Barlow Semi Condensed, texto en Inter. `extender_dashboard.py` recolorea también la base de Rubén (tabla `PALETA`).

**Base visual:** es el dashboard de demanda y Huff de R. Malis (`modelo_simple/Dashboard_Demanda_Huff_Teletrak.html`), extendido. `ui/extender_dashboard.py` toma su HTML (`ui/base_ruben.html`, sin datos) y aplica cambios trazables, cada uno verificado contra el original:
- `DASHBOARD_DATA` se arma en el navegador desde el Excel cargado (`ui/capa_datos.js`).
- Se corrigieron cosas fijas: años 2027-2031, Ids TLK-xx, banda P10-P90 de ±12% (ahora usa los percentiles del Monte Carlo) y atractivo Huff en MM CLP (ahora es opcional).
- Se agregaron las pestañas Carga, Informe de carga, Red de sedes, Categorización, Sedes y contratos, más estados y presentación. El mapa y el simulador comparten el mismo escenario de cierres.
- Queda pendiente la "serie limpia" (aislamiento de picos de `aislar_picos_y_red.py`). Por ahora se muestra la serie cruda.

Para reconstruir después de cambiar `sedes/*.py` o `ui/*`:
```bash
.venv/bin/python ui/extender_dashboard.py ui/base_ruben.html   # regenera ui/app.html desde la base de Rubén
.venv/bin/python construir_ui.py                                 # empaqueta todo en herramienta_sedes.html
```
Si Rubén actualiza su dashboard, se copia sin datos a `ui/base_ruben.html` y se corre lo mismo. El script avisa si algún cambio dejó de calzar.

## Uso por línea de comandos

```bash
uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -e ".[dev]"

.venv/bin/python -m sedes plantilla plantilla_sedes.xlsx          # plantilla en blanco
.venv/bin/python -m sedes validar mis_datos.xlsx                  # revisa formato y consistencia
.venv/bin/python -m sedes analizar mis_datos.xlsx --salida resultados.xlsx --estado base.sedes.json --sim 5000
```

`datos_ejemplo/ejemplo_sintetico.xlsx` trae datos inventados con el formato correcto, para probar.

## Excel de rentabilidad del cliente (formato real)

La herramienta lee directo el Excel de rentabilidad Teletrak. Reconoce las hojas por sus columnas, así que cualquier hoja "Y 202X" nueva funciona sin cambios.

| Hoja | Tipo | Aporta |
|---|---|---|
| Y 2025 (y anteriores) | ANUAL | Ventas 2022-2025 por hipódromo, P&L, TÉRMINO, AVISO, PPR, ACCIÓN |
| Y 2026 (y siguientes) | MENSUAL | Ventas e ingresos enero-agosto, P&L, fecha de término (última columna ARRIENDO) |
| VTA HIST | HISTORICO | Ventas diarias por sede y hipódromo. Es la base del ETS |
| EN PROCESO | EN_PROCESO | STATUS, VIGENCIA, AVISO. Manda en todo lo de cierres |
| CTA ARRIENDO | ARRIENDO | Arriendo mensual 2025-2027 |

```bash
# 1. Informe de carga: cuadres entre hojas, identidades contables, nombres sin resolver, alertas de contrato
.venv/bin/python -m sedes informe-carga rentabilidad.xlsx --salida informe_carga.xlsx

# 2. Coordenadas (una vez). Envía SOLO las direcciones a OpenStreetMap. Se puede cortar y retomar.
.venv/bin/python -m sedes geocodificar rentabilidad.xlsx --salida coordenadas.csv

# 3. Análisis completo
.venv/bin/python -m sedes analizar rentabilidad.xlsx --coordenadas coordenadas.csv \
    --equivalencias equivalencias.csv --salida resultados.xlsx --estado base.sedes.json \
    --param 'sedes_g9=["006.003.020", "..."]'
```

- **Nombres sin Id_Division** (EN PROCESO y CTA ARRIENDO): se resuelven sin importar tildes, mayúsculas ni el prefijo TLK. Los que no calzan quedan en `*_equivalencias_pendientes.csv` con una sugerencia, pero el `sede_id` va vacío y hay que confirmarlo a mano.
- **Mes de corte**: el último mes completo de VTA HIST.
- **Jornadas**: días con venta en la sede.
- **IPC**: serie pública del INE en `sedes/datos_publicos/ipc_ine.csv`, que hay que actualizar cada mes.
- **Supuestos configurables**: `vendido_sigue_operando` (VENDIDO = sigue captando demanda sin costo propio) y `tolerancia_cuadre` (0,5%).
- `python -m sedes sintetico-cliente x.xlsx` genera un Excel inventado con este mismo formato y sus defectos conocidos, para probar.

## Formato de datos (plantilla propia)

Lo define `sedes/esquema.py`. La hoja LEEME de la plantilla lo describe columna por columna.

| Hoja | Contenido |
|---|---|
| SEDES | Una fila por sede: grupo, coordenadas, estado, arriendo, costos fijos, vencimiento de contrato |
| VENTAS_MENSUALES | Formato largo: sede, mes, hipódromo, venta nominal, jornadas |
| IPC | Variación mensual INE, para deflactar |
| DISTANCIAS (opcional) | km por ruta. Si falta se usa línea recta x `factor_ruta` |
| PARAMETROS (opcional) | Sobrescribe valores de `sedes/config.py` |

## Módulos

| Módulo | Qué hace |
|---|---|
| `datos` | Lee y valida la plantilla, arma la matriz de distancias |
| `demanda` | ETS(A,N,A) sobre ln(venta real / jornada) + Monte Carlo, igual que `modelo_simple/modelo_demanda.py`. Fallback estacional ingenuo con poca historia |
| `huff` | Redistribución por Huff (simultánea y en cascada), redundancia por sede, calibración de U₀ |
| `red` | Clusters espaciales (DBSCAN con radio RM y regiones), vecino más cercano, vecinos en radio |
| `grafo` | Red de alternativas con networkx: zonas (Santiago urbano, alrededores RM, regiones), aristas entre sedes de la misma zona dentro del umbral de acceso, rol de cada sede (sin alternativa, alternativa de otras, con alternativa), redes locales y comparación hoy vs escenario de cierres. Los roles no protegen sedes: todas cierran en el horizonte, el rol indica qué cierres requieren migración digital y el orden conveniente |
| `transporte` | Tiempos entre sedes por modo. Rieles: grafo dirigido (networkx) con el Metro de Santiago (`datos_publicos/metro_santiago.csv`) y los trenes EFE (`datos_publicos/trenes_efe.csv`: Nos, Rancagua, San Fernando, Chillán, Biotren L1 y L2, Corto Laja), todos de OpenStreetMap, con velocidad y espera por línea (alta en los de larga distancia) y combinación en estaciones a menos de 400 m. El mapa marca como punto fijo los cuatro hipódromos (`datos_publicos/hipodromos.csv`), integrados a la red como nodos fijos: no cierran ni se cuentan como sedes, pero son alternativa para las sedes a su alcance (misma regla de acceso de su zona), con líneas, área alcanzable y ficha igual que una sede (`alcance_hipodromos`, `grafo.analizar(..., fijos=)`). A pie y en auto: OSRM sobre calles de OpenStreetMap, pedido desde el navegador (solo coordenadas; auto con 25% de congestión y 3 min de estacionamiento); sin conexión se estiman por distancia. Modo y umbral por zona en `acceso_zona` |
| Caminos reales | Todo tiempo entre lugares va por calles: OSRM (OpenStreetMap) da a pie y en auto entre sedes, la caminata de cada sede y cada hipódromo a sus estaciones cercanas (menos de 1,6 km) y los tiempos de los hipódromos a las sedes. Python recalcula metro y tren con esa caminata (`matrices(..., acceso=)`). El simulador Huff reparte la venta según el tiempo de viaje del modo de la zona, convertido a distancia equivalente con la velocidad típica de la zona para conservar la escala de λ. Solo se envían coordenadas; queda en caché del navegador. El área alcanzable del mapa es una isócrona por calles: al elegir una sede o hipódromo se piden a OSRM los tiempos a una grilla polar (24 direcciones × 8 distancias) y se dibuja el borde alcanzable; las manchas de las estaciones usan la velocidad de caminata medida ahí. Las conexiones del mapa se dibujan por su camino real: ruta peatonal o en auto por calles (OSRM `route`), o caminata a la estación + estaciones del recorrido (`transporte.ruta_metro`) + caminata final. Sin conexión, se usa la línea recta × 1,3 y círculos |
| Líneas futuras | `datos_publicos/lineas_futuras.csv`: estaciones de OpenStreetMap con apertura estimada, estado y fuente por tramo. Tren Alameda-Melipilla desde Lo Errázuriz (jun-2028; el tramo soterrado a Alameda está postergado), Metro Línea 7 (dic-2028), Tren Santiago-Batuco (Batuco-Quilicura dic-2029; tramo soterrado Renca-Quinta Normal en licitación, dic-2031), Línea 9 por tramos (2030 a 2033) y Línea 8 (2032-2033). `transporte.matrices` entrega los tiempos en metro o tren desde cada apertura (`futuras`); el mapa las dibuja punteadas y la línea de tiempo recalcula la red desde cada fecha. Actualizar las fechas en el CSV cuando cambien los plazos |
| `censo` | Dificultad de migrar al canal digital (0 a 100) según la comuna de la sede: comuna por coordenadas (límites comunales de la BCN, `datos_publicos/comunas_bcn.json`) y Censo 2024 del INE (`datos_publicos/censo2024_comunas.csv`). Mitad: percentil de % de hombres de 50+ (perfil del cliente de sede). Mitad: percentil inverso de los años de estudio de los 50+. Fundamento: el uso de internet de las personas mayores cae con la edad y la educación, mientras que el acceso en el hogar ya es casi universal (Encuesta Calidad de Vida en la Vejez 2022 y CASEN 2022, Observatorio del Envejecimiento UC-Confuturo 2024); por eso internet en el hogar se guarda solo como referencia. La dificultad fija el plazo del plan digital (3 a 9 meses) en la línea de tiempo. Se regenera con `python -m sedes.preparar_censo D1.xlsx H1.xlsx P7.xlsx comunas.shp` |
| `economia` | Margen por mix de hipódromos, equilibrio, probabilidad de pérdida, ΔEBITDA de cerrar |
| `segmentacion` | k-means sobre variables estandarizadas, k por silhouette, perfiles descritos |
| `estado` | Huella de datos y estados `.sedes.json` para retomar o presentar |
| `rentabilidad` | Lector del Excel del cliente e informe de carga |
| `geocodificar` | Coordenadas desde direcciones (Nominatim, con caché y reanudación) |

## Diferencia con el dashboard Huff original

`huff_atractivo = "relativo"` (defecto) usa A_j = venta_j / venta promedio. Así U₀ significa lo mismo sin importar la escala de las ventas. Con `"mm_clp"` el cálculo es idéntico al dashboard original, donde A_j va en MM CLP y U₀ = 0,1736 casi no pesa frente a sedes cercanas.

## Privacidad

`.gitignore` bloquea todo `.xlsx`, `.csv` y `.sedes.json` salvo la plantilla y el ejemplo sintético.
