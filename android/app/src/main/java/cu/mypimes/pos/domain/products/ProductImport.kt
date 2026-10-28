package cu.mypimes.pos.domain.products

import cu.mypimes.pos.domain.imports.ImportRow
import cu.mypimes.pos.domain.imports.SheetPreview
import cu.mypimes.pos.domain.imports.collapseSpaces
import cu.mypimes.pos.domain.imports.duplicateError
import cu.mypimes.pos.domain.imports.mapColumns
import cu.mypimes.pos.domain.imports.normalizeName
import cu.mypimes.pos.domain.imports.orNullIfNaN
import cu.mypimes.pos.domain.imports.parseSheetNumber
import cu.mypimes.pos.domain.imports.EMPTY_FILE_MESSAGE
import cu.mypimes.pos.domain.imports.sheetTable
import cu.mypimes.pos.domain.imports.tooManyRowsError
import kotlin.math.floor

/** Mismas reglas que server/routes/products.js (carga masiva) y client/src/lib/productImport.js. */
data class ProductImportRow(
    override val line: Int,
    override val name: String,
    val salePrice: Double?,
    val purchasePrice: Double?,
    val stock: Double?,
    override val errors: List<String>,
    override val creates: Boolean,
) : ImportRow {
    override val setsStock: Boolean get() = stock != null
}

private val PRODUCT_COLUMNS = mapOf(
    "name" to listOf("nombre", "producto", "nombre del producto", "nombre producto", "descripcion", "articulo"),
    "sale_price" to listOf("precio venta", "precio de venta", "venta", "precio", "pvp", "precio al publico"),
    "purchase_price" to listOf("precio compra", "precio de compra", "compra", "costo", "coste", "precio costo", "precio de costo"),
    "stock" to listOf("stock", "cantidad", "existencia", "existencias", "inventario", "unidades", "uds"),
)

private val PRODUCT_FALLBACK = listOf(
    "purchase_price" to Regex("compra|costo|coste"),
    "sale_price" to Regex("venta|precio"),
    "stock" to Regex("stock|cantidad|existenc"),
    "name" to Regex("nombre|producto|articulo|descripcion"),
)

/** Interpreta el texto completo y lo cruza con los nombres que ya hay en la tienda. `line` cuenta desde el encabezado. */
fun buildProductImport(text: String, existingNames: List<String>): SheetPreview<ProductImportRow> {
    val (table, headerIndex) = sheetTable(text) ?: return SheetPreview(error = EMPTY_FILE_MESSAGE)
    val columns = mapColumns(table[headerIndex], PRODUCT_COLUMNS, PRODUCT_FALLBACK)
    if (!columns.containsKey("name") || !columns.containsKey("sale_price")) {
        return SheetPreview(
            error = "No encuentro las columnas. La primera fila tiene que tener los títulos, por ejemplo: " +
                "nombre · precio_venta · precio_compra · stock.",
        )
    }
    val existing = existingNames.map(::normalizeName).toSet()
    val seen = mutableMapOf<String, Int>()
    val rows = mutableListOf<ProductImportRow>()

    for (i in headerIndex + 1 until table.size) {
        val cells = table[i]
        if (cells.all { it.isBlank() }) continue
        fun cell(key: String): String = columns[key]?.let { cells.getOrNull(it) }.orEmpty()
        val line = i + 1
        val errors = mutableListOf<String>()

        val name = cell("name").collapseSpaces()
        val saleRaw = cell("sale_price")
        val purchaseRaw = cell("purchase_price")
        val stockRaw = cell("stock")
        val sale = parseSheetNumber(saleRaw)
        val purchase = parseSheetNumber(purchaseRaw)
        val stock = parseSheetNumber(stockRaw)

        if (name.isEmpty()) errors += "Falta el nombre"
        else if (name.length > 120) errors += "El nombre es demasiado largo"

        when {
            sale == null -> errors += "Falta el precio de venta"
            sale.isNaN() -> errors += "Precio de venta no válido: \"${saleRaw.trim()}\""
            sale < 0 -> errors += "El precio de venta no puede ser negativo"
        }
        if (purchase != null && purchase.isNaN()) errors += "Precio de compra no válido: \"${purchaseRaw.trim()}\""
        else if (purchase != null && purchase < 0) errors += "El precio de compra no puede ser negativo"

        if (stock != null && stock.isNaN()) errors += "Stock no válido: \"${stockRaw.trim()}\""
        else if (stock != null && stock != floor(stock)) errors += "El stock tiene que ser un número entero"
        else if (stock != null && stock < 0) errors += "El stock no puede ser negativo"

        if (name.isNotEmpty()) duplicateError(seen, name, line)?.let { errors += it }

        rows += ProductImportRow(
            line = line,
            name = name,
            salePrice = sale.orNullIfNaN(),
            purchasePrice = purchase.orNullIfNaN(),
            stock = stock.orNullIfNaN(),
            errors = errors,
            creates = normalizeName(name) !in existing,
        )
    }

    if (rows.isEmpty()) return SheetPreview(error = "El archivo tiene títulos pero ninguna fila con productos.")
    tooManyRowsError(rows.size)?.let { return SheetPreview(error = it) }
    return SheetPreview(rows = rows)
}
