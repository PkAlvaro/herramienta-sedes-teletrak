"""Contrato de la plantilla Excel: hojas, columnas, tipos y obligatoriedad.

Es la unica fuente de verdad del formato. La plantilla en blanco, el validador
y el generador sintetico se construyen a partir de este archivo.
"""

ESQUEMA_VERSION = "1.0"

# Cada columna: (nombre, tipo, obligatoria, descripcion)
# tipos: str, float, int, date, month (primer dia del mes)
HOJAS = {
    "SEDES": [
        ("sede_id", "str", True, "Codigo unico, por ejemplo TLK-31"),
        ("nombre", "str", True, "Nombre de la sede"),
        ("grupo", "str", True, "G9, RM, REGIONES o DIGITAL"),
        ("region", "str", False, "Region"),
        ("comuna", "str", False, "Comuna"),
        ("lat", "float", True, "Latitud en grados decimales (vacia solo en DIGITAL)"),
        ("lon", "float", True, "Longitud en grados decimales (vacia solo en DIGITAL)"),
        ("estado", "str", True, "VIGENTE o CERRADA"),
        ("fecha_apertura", "date", False, "Fecha de apertura"),
        ("fecha_cierre", "date", False, "Solo si ya esta cerrada"),
        ("m2", "float", False, "Superficie"),
        ("arriendo_mensual_clp", "float", False, "Canon mensual vigente en pesos"),
        ("otros_fijos_anual_clp", "float", False, "Costos fijos evitables no arriendo, anual"),
        ("vencimiento_contrato", "date", False, "Fecha de termino del contrato de arriendo"),
        ("aviso_termino_meses", "float", False, "Meses de aviso para no renovar"),
        ("costo_cierre_clp", "float", False, "Costo unico de cerrar (indemnizaciones, multas, retiro)"),
    ],
    "VENTAS_MENSUALES": [
        ("sede_id", "str", True, "Debe existir en SEDES"),
        ("mes", "month", True, "Primer dia del mes, por ejemplo 2025-03-01"),
        ("hipodromo", "str", True, "HCH, CHS, VSC, CHC u OTRO"),
        ("venta_nominal_clp", "float", True, "Venta del mes en pesos corrientes"),
        ("jornadas", "float", True, "Jornadas con venta en el mes (se repite igual en cada hipodromo)"),
    ],
    "IPC": [
        ("mes", "month", True, "Primer dia del mes"),
        ("var_mensual_pct", "float", True, "Variacion mensual del IPC en %, INE"),
    ],
    "DISTANCIAS": [
        ("origen", "str", True, "sede_id"),
        ("destino", "str", True, "sede_id"),
        ("km", "float", True, "Distancia por ruta en km"),
    ],
    "PARAMETROS": [
        ("parametro", "str", True, "Nombre del parametro (ver LEEME)"),
        ("valor", "str", True, "Valor. Numeros con punto decimal"),
    ],
}

HOJAS_OBLIGATORIAS = ["SEDES", "VENTAS_MENSUALES", "IPC"]
HOJAS_OPCIONALES = ["DISTANCIAS", "PARAMETROS"]

LEEME = [
    "HERRAMIENTA DE ANALISIS DE SEDES TELETRAK - PLANTILLA DE DATOS",
    f"Version del formato: {ESQUEMA_VERSION}",
    "",
    "Hojas obligatorias: SEDES, VENTAS_MENSUALES, IPC.",
    "Hojas opcionales: DISTANCIAS (si falta se calcula en linea recta x factor_ruta) y PARAMETROS.",
    "",
    "Reglas:",
    "- No cambiar nombres de hojas ni de columnas. Se pueden agregar columnas extra, se ignoran.",
    "- Fechas como fecha de Excel o texto AAAA-MM-DD.",
    "- Montos en pesos chilenos sin separador de miles.",
    "- VENTAS_MENSUALES va en formato largo: una fila por sede, mes e hipodromo.",
    "- Las sedes DIGITAL pueden ir sin coordenadas. No participan en la red fisica.",
    "",
    "El detalle de cada columna esta en la tabla de abajo.",
]
