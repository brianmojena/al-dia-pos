package cu.mypimes.pos.domain.warehouse

import cu.mypimes.pos.domain.imports.EMPTY_FILE_MESSAGE
import cu.mypimes.pos.domain.imports.ImportRow
import cu.mypimes.pos.domain.imports.SheetPreview
import cu.mypimes.pos.domain.imports.collapseSpaces
import cu.mypimes.pos.domain.imports.duplicateError
import cu.mypimes.pos.domain.imports.mapColumns
import cu.mypimes.pos.domain.imports.normalizeName
import cu.mypimes.pos.domain.imports.orNullIfNaN
import cu.mypimes.pos.domain.imports.parseSheetNumber
import cu.mypimes.pos.domain.imports.sheetTable
import cu.mypimes.pos.domain.imports.tooManyRowsError
import cu.mypimes.pos.domain.imports.withinQuantityRules
import kotlin.math.floor

/** Artículo que ya está en el almacén: su unidad se conserva si el archivo no la trae. */
data class ExistingArticle(val name: String, val unit: String?)

/** Mismas reglas que server/routes/warehouse.js (carga masiva) y client/src/lib/productImport.js. */
data class WarehouseImportRow(
    override val line: Int,
    override val name: String,
    val unit: String?,
    val cost: Double?,
    val quantity: Double?,
    override val errors: List<String>,
    override val creates: Boolean,
) : ImportRow {
    override val setsStock: Boolean get() = quantity != null
}

private val WAREHOUSE_UNITS = listOf("kg", "g", "lb")

private val WAREHOUSE_COLUMNS = mapOf(
    "name" to listOf("nombre", "articulo", "producto", "nombre del articulo", "descripcion"),
    "unit" to listOf("unidad", "unidad de medida", "medida", "um"),
    "cost" to listOf("costo", "coste", "precio costo", "precio de costo", "precio compra", "precio de compra", "compra"),
    "quantity" to listOf("cantidad", "stock", "existencia", "existencias", "unidades", "uds"),
)

private val WAREHOUSE_FALLBACK = listOf(
    "cost" to Regex("costo|coste|compra"),
    "quantity" to Regex("cantidad|stock|existenc"),
    "unit" to Regex("unidad|medida"),
    "name" to Regex("nombre|articulo|producto|descripcion"),
)

/** Como buildProductImport, pero para el almacén: nombre, unidad (kg, g, lb o vacía = pieza), costo y cantidad. */
fun buildWarehouseImport(text: String, existing: List<ExistingArticle>): SheetPreview<WarehouseImportRow> {
    val (table, headerIndex) = sheetTable(text) ?: return SheetPreview(error = EMPTY_FILE_MESSAGE)
    val columns = mapColumns(table[headerIndex], WAREHOUSE_COLUMNS, WAREHOUSE_FALLBACK)
    if (!columns.containsKey("name") || !columns.containsKey("cost")) {
        return SheetPreview(
            error = "No encuentro las columnas. La primera fila tiene que tener los títulos, por ejemplo: " +
                "nombre · unidad · costo · cantidad.",
        )
    }
    val prior = existing.associateBy { normalizeName(it.name) }
    val seen = mutableMapOf<String, Int>()
    val rows = mutableListOf<WarehouseImportRow>()

    for (i in headerIndex + 1 until table.size) {
        val cells = table[i]
        if (cells.all { it.isBlank() }) continue
        fun cell(key: String): String = columns[key]?.let { cells.getOrNull(it) }.orEmpty()
        val line = i + 1
        val errors = mutableListOf<String>()

        val name = cell("name").collapseSpaces()
        val unitRaw = cell("unit")
        val unitKey = unitRaw.trim().lowercase()
        val costRaw = cell("cost")
        val qtyRaw = cell("quantity")
        val cost = parseSheetNumber(costRaw)
        val quantity = parseSheetNumber(qtyRaw)
        val before = if (name.isNotEmpty()) prior[normalizeName(name)] else null

        if (name.isEmpty()) errors += "Falta el nombre"
        else if (name.length > 120) errors += "El nombre es demasiado largo"

        // Sin unidad en el archivo, un artículo existente conserva la suya.
        val unit: String? = when {
            unitKey == "" && before != null -> before.unit
            unitKey == "" || unitKey == "pieza" || unitKey == "unidad" || unitKey == "u" -> null
            unitKey in WAREHOUSE_UNITS -> unitKey
            else -> {
                errors += "Unidad no válida: \"${unitRaw.trim()}\" (usa kg, g o lb, o déjala vacía)"
                null
            }
        }
        if (before != null && errors.isEmpty() && before.unit != unit) errors += "Ya está en el almacén con otra unidad de medida"

        if (cost == null && before == null) errors += "Falta el costo"
        else if (cost != null && cost.isNaN()) errors += "Costo no válido: \"${costRaw.trim()}\""
        else if (cost != null && cost < 0) errors += "El costo no puede ser negativo"

        if (quantity != null && quantity.isNaN()) errors += "Cantidad no válida: \"${qtyRaw.trim()}\""
        else if (quantity != null && quantity < 0) errors += "La cantidad no puede ser negativa"
        else if (quantity != null && unit == null && quantity != floor(quantity)) errors += "Sin unidad de medida la cantidad tiene que ser un número entero"
        else if (quantity != null && unit != null && !withinQuantityRules(quantity, unit)) errors += "La cantidad admite hasta 3 decimales"

        if (name.isNotEmpty()) duplicateError(seen, name, line)?.let { errors += it }

        rows += WarehouseImportRow(
            line = line,
            name = name,
            unit = unit,
            cost = cost.orNullIfNaN(),
            quantity = quantity.orNullIfNaN(),
            errors = errors,
            creates = before == null,
        )
    }

    if (rows.isEmpty()) return SheetPreview(error = "El archivo tiene títulos pero ninguna fila con artículos.")
    tooManyRowsError(rows.size)?.let { return SheetPreview(error = it) }
    return SheetPreview(rows = rows)
}
