package cu.mypimes.pos.domain.inventory

import cu.mypimes.pos.domain.products.number
import cu.mypimes.pos.domain.products.round3
import cu.mypimes.pos.domain.products.validQuantity
import cu.mypimes.pos.domain.products.whole
import kotlin.math.roundToLong

/** Lo que se escribe en la pantalla de conteo. Paquetes y sueltos van aparte para productos con paquete. */
data class CountEntry(val text: String = "", val packs: String = "", val loose: String = "") {
    val filled: Boolean get() = text.isNotBlank() || packs.isNotBlank() || loose.isNotBlank()
}

/** Una línea del arqueo con las mismas reglas que server/routes/inventoryCounts.js. */
data class CountedLine(
    val productId: Long,
    val name: String,
    val expected: Double,
    val counted: Double,
    val unitPrice: Double,
    val packSize: Int? = null,
    val unit: String? = null,
) {
    val difference: Double get() = round3(counted - expected)
}

data class CountSummary(
    val withDifference: Int,
    val unitsMissing: Double,
    val unitsExtra: Double,
    /** Faltante valorizado a precio de venta, con dos decimales. */
    val valueMissing: Double,
)

fun countSummary(lines: List<CountedLine>): CountSummary {
    var withDifference = 0
    var missing = 0.0
    var extra = 0.0
    var value = 0.0
    for (line in lines) {
        val diff = line.difference
        if (diff == 0.0) continue
        withDifference++
        if (diff < 0) {
            missing += -diff
            value += -diff * line.unitPrice
        } else {
            extra += diff
        }
    }
    return CountSummary(withDifference, round3(missing), round3(extra), (value * 100).roundToLong() / 100.0)
}

/** Paquetes y sueltos a sueltos. Null si no se contó nada o algún campo no es entero >= 0. */
fun packCountTotal(packs: String, loose: String, packSize: Int): Double? {
    if (packs.isBlank() && loose.isBlank()) return null
    val packCount = whole(packs.trim()) ?: return null
    val looseCount = whole(loose.trim()) ?: return null
    return packCount * packSize + looseCount
}

/** Cantidad contada de un producto, o null si está vacío o no es válido para su unidad. */
fun countedQuantity(entry: CountEntry, packSize: Int?, unit: String?): Double? =
    if (packSize != null && packSize > 1 && unit == null) packCountTotal(entry.packs, entry.loose, packSize)
    else number(entry.text)?.takeIf { entry.text.isNotBlank() && validQuantity(it, unit) }

/** Nombre antes de la @ del correo: "yamila@tienda.cu" → "yamila". Null si no hay cuenta. */
fun accountLabel(email: String?): String? = email?.substringBefore('@')?.takeIf { it.isNotBlank() }
