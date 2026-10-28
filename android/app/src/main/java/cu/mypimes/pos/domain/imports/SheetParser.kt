package cu.mypimes.pos.domain.imports

import java.nio.ByteBuffer
import java.nio.charset.Charset
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.text.Normalizer
import kotlin.math.abs
import kotlin.math.floor

/*
 * Lectura de hojas para importar (productos y almacén). Misma lógica que client/src/lib/productImport.js:
 * Excel en español usa ";" y miles con punto; Windows guarda en Windows-1252; Excel pega con tabuladores.
 */

const val MAX_IMPORT_ROWS = 2000
const val EXCEL_FILE_MESSAGE = "Ese es un archivo de Excel (.xlsx), no un CSV. En Excel: Archivo → Guardar como → " +
    "elige \"CSV (delimitado por comas)\" o \"CSV UTF-8\" y sube ese archivo. " +
    "También puedes seleccionar las celdas, copiarlas y usar \"Pegar desde Excel\"."
const val EMPTY_FILE_MESSAGE = "El archivo está vacío."

/** Una fila importable: la pantalla la muestra y el repositorio la envía solo si no tiene errores. */
interface ImportRow {
    /** Número de fila tal como se ve en la hoja (el encabezado es la 1). */
    val line: Int
    val name: String
    val errors: List<String>
    val creates: Boolean
    /** La hoja trae cantidad o stock para este artículo (si ya existe, reemplazarlo cambia su stock). */
    val setsStock: Boolean
}

/** `error` explica por qué no hay filas; `rows` son todas las filas, con sus errores. */
data class SheetPreview<out T>(val error: String? = null, val rows: List<T> = emptyList())

private val COMBINING_MARKS = Regex("[̀-ͯ]")
private val SPACES = Regex("[\\s ]+")

private fun stripAccents(s: String) = Normalizer.normalize(s, Normalizer.Form.NFD).replace(COMBINING_MARKS, "")

/** "  Azúcar  (1 LB) " y "azucar (1 lb)" son el mismo producto. */
fun normalizeName(name: String?): String = stripAccents(name.orEmpty()).lowercase().replace(SPACES, " ").trim()

private fun normalizeHeader(s: String) = stripAccents(s).lowercase().replace(Regex("[^a-z0-9]+"), " ").trim()

/** Un .xlsx es un ZIP: empieza con "PK\u0003\u0004". */
fun looksLikeExcelBinary(bytes: ByteArray): Boolean =
    bytes.size > 3 && bytes.copyOf(4).contentEquals(byteArrayOf(0x50, 0x4b, 0x03, 0x04))

/** UTF-8; si no es UTF-8 válido, casi seguro un CSV guardado por Excel en Windows (Windows-1252). */
fun decodeSheet(bytes: ByteArray): String {
    val text = try {
        Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
    } catch (_: CharacterCodingException) {
        String(bytes, Charset.forName("windows-1252"))
    }
    return text.removePrefix("﻿")
}

/** Tabulador > punto y coma > coma; en empate gana el primero. */
private fun detectDelimiter(text: String): Char {
    val firstLine = text.lines().firstOrNull { it.isNotBlank() }.orEmpty()
    val counts = mutableMapOf('\t' to 0, ';' to 0, ',' to 0)
    var inQuotes = false
    for (c in firstLine) {
        if (c == '"') inQuotes = !inQuotes
        else if (!inQuotes && c in counts) counts[c] = counts.getValue(c) + 1
    }
    return listOf('\t', ';', ',').fold('\t') { best, d -> if (counts.getValue(d) > counts.getValue(best)) d else best }
}

fun parseDelimited(text: String, delim: Char): List<List<String>> {
    val rows = mutableListOf<List<String>>()
    var row = mutableListOf<String>()
    val field = StringBuilder()
    var inQuotes = false
    var i = 0
    while (i < text.length) {
        val c = text[i]
        when {
            inQuotes -> if (c == '"') {
                if (text.getOrNull(i + 1) == '"') { field.append('"'); i++ } else inQuotes = false
            } else field.append(c)
            c == '"' && field.isEmpty() -> inQuotes = true
            c == delim -> { row.add(field.toString()); field.clear() }
            c == '\n' || c == '\r' -> {
                if (c == '\r' && text.getOrNull(i + 1) == '\n') i++
                row.add(field.toString()); rows.add(row); row = mutableListOf(); field.clear()
            }
            else -> field.append(c)
        }
        i++
    }
    if (field.isNotEmpty() || row.isNotEmpty()) { row.add(field.toString()); rows.add(row) }
    return rows
}

/** Tabla completa y posición del encabezado (primera fila con algo), o null si el texto está vacío. */
fun sheetTable(text: String): Pair<List<List<String>>, Int>? {
    val clean = text.removePrefix("﻿")
    if (clean.isBlank()) return null
    val table = parseDelimited(clean, detectDelimiter(clean))
    val header = table.indexOfFirst { row -> row.any { it.isNotBlank() } }
    return if (header < 0) null else table to header
}

/**
 * Columnas por título: primero coincidencias exactas de alias; después, por palabra contenida
 * ("Precio venta CUP"). Cada campo se asigna una sola vez.
 */
fun mapColumns(header: List<String>, aliases: Map<String, List<String>>, fallback: List<Pair<String, Regex>>): Map<String, Int> {
    val map = mutableMapOf<String, Int>()
    val taken = mutableSetOf<Int>()
    header.forEachIndexed { idx, cell ->
        val h = normalizeHeader(cell)
        aliases.entries.firstOrNull { (key, list) -> key !in map && h in list }?.let { map[it.key] = idx; taken += idx }
    }
    header.forEachIndexed { idx, cell ->
        if (idx in taken) return@forEachIndexed
        val h = normalizeHeader(cell)
        fallback.firstOrNull { (key, rx) -> key !in map && rx.containsMatchIn(h) }?.let { map[it.first] = idx }
    }
    return map
}

/**
 * Número escrito por una persona: "1.500", "1,5", "$ 990", "1.234,50", "990 CUP".
 * Null si la celda está vacía; NaN si no se puede interpretar.
 * Con un solo separador: grupos de exactamente 3 cifras son miles ("1.500" = 1500); lo demás es decimal.
 */
fun parseSheetNumber(raw: String?): Double? {
    var s = raw?.trim() ?: return null
    if (s.isEmpty()) return null
    s = s.replace(Regex("cup|usd|mn|\\$", RegexOption.IGNORE_CASE), "").replace(SPACES, "")
    if (s.isEmpty()) return null
    if (!Regex("-?[\\d.,]+").matches(s)) return Double.NaN

    val lastDot = s.lastIndexOf('.')
    val lastComma = s.lastIndexOf(',')
    if (lastDot >= 0 && lastComma >= 0) {
        val decimal = if (lastDot > lastComma) '.' else ','
        val thousands = if (decimal == '.') ',' else '.'
        s = s.split(thousands).joinToString("").replaceFirst(decimal.toString(), ".")
    } else if (lastDot >= 0 || lastComma >= 0) {
        val parts = s.split(if (lastDot >= 0) "." else ",")
        val head = parts[0].replace("-", "")
        val isThousands = head.length in 1..3 && head != "0" && parts.drop(1).all { it.length == 3 }
        s = when {
            isThousands -> parts.joinToString("")
            parts.size == 2 -> "${parts[0]}.${parts[1]}"
            else -> return Double.NaN
        }
    }
    return s.toDoubleOrNull()?.takeIf { it.isFinite() } ?: Double.NaN
}

/** Cantidad con unidad de peso: hasta 3 decimales; sin unidad: entera. */
fun withinQuantityRules(value: Double, unit: String?): Boolean =
    if (unit != null) abs(floor(value * 1000 + 0.5) / 1000 - value) < 1e-9 else value == floor(value)

fun String.collapseSpaces(): String = trim().replace(SPACES, " ")

fun Double?.orNullIfNaN(): Double? = this?.takeUnless { it.isNaN() }

/** Error si el nombre ya salió en una fila anterior (mismo criterio que la web). */
fun duplicateError(seen: MutableMap<String, Int>, name: String, line: Int): String? {
    val key = normalizeName(name)
    val first = seen[key]
    if (first != null) return "Repetido: ya aparece en la fila $first"
    seen[key] = line
    return null
}

fun tooManyRowsError(rows: Int): String? =
    if (rows > MAX_IMPORT_ROWS) "Son $rows filas; el máximo por archivo es $MAX_IMPORT_ROWS. Divídelo en partes." else null
