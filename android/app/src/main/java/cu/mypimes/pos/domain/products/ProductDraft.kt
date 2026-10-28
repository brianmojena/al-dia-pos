package cu.mypimes.pos.domain.products

import cu.mypimes.pos.domain.Format
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.roundToLong

/** Unidades de peso: mismas que server/lib/units.js. */
val PRODUCT_UNITS = listOf("lb", "kg", "g")
const val MAX_PACK_SIZE = 10000

/**
 * Formulario de producto tal como lo escribe la persona. Las reglas son las de
 * server/routes/products.js y client/src/pages/Products.jsx; el servidor vuelve
 * a validar, esto evita enviar lo que ya se sabe que va a fallar.
 */
data class ProductDraft(
    val name: String = "",
    val salePrice: String = "",
    val purchasePrice: String = "",
    val byWeight: Boolean = false,
    val unit: String = "lb",
    val trackStock: Boolean = true,
    val stock: String = "",
    val packOn: Boolean = false,
    val packSize: String = "",
    val packPrice: String = "",
    val packCost: String = "",
    val stockPacks: String = "",
    val stockLoose: String = "",
    val addStock: String = "",
    val addPacks: String = "",
    val addLoose: String = "",
    val stockReason: String = "",
) {
    /** Unidad que se guarda; null para un producto por pieza. */
    val unitOrNull: String? get() = if (byWeight) unit else null

    /** Un producto por peso tiene stock controlado solo si lo pide; el resto siempre lo lleva. */
    val tracksStock: Boolean get() = !byWeight || trackStock

    /** Sueltos o cantidad del stock (paquetes * tamaño + sueltos, si hay paquete). Null = inválido. */
    fun stockValue(): Double? = total(stockPacks, stockLoose, stock)

    /** Lo que llega a sumar al stock al editar. Null = inválido. */
    fun addValue(): Double? = total(addPacks, addLoose, addStock)

    /** Costo por suelto: con costo de paquete, costo del paquete / tamaño (como la web). */
    fun costPerUnit(): Double? {
        val size = packSize.toIntOrNull() ?: 0
        val packCostValue = number(packCost)
        if (packOn && size >= 2 && packCostValue != null && packCostValue > 0) return round4(packCostValue / size)
        return if (purchasePrice.isBlank()) null else number(purchasePrice)
    }

    /**
     * Primer error de validación en español, o null si el formulario se puede enviar.
     * `editing`: se edita un producto existente. `owner`: el dueño puede cambiarlo todo;
     * el cajero solo puede tocar el precio de venta y añadir stock.
     */
    fun validationError(editing: Boolean, owner: Boolean): String? {
        val full = !editing || owner
        if (packOn && byWeight) return "Un producto por peso no se vende por paquete"
        if (full && name.trim().isEmpty()) return "Escribe el nombre del producto"
        if (!isPrice(salePrice)) return "El precio de venta debe ser un número de 0 o más"
        if (full && purchasePrice.isNotBlank() && !isPrice(purchasePrice)) return "El precio de compra no es válido"
        if (full && byWeight && unit !in PRODUCT_UNITS) return "La unidad de medida no es válida (kg, g o lb)"
        if (packOn) {
            val size = packSize.toIntOrNull()
            if (size == null || size < 2 || size > MAX_PACK_SIZE) return "El paquete debe traer de 2 a $MAX_PACK_SIZE unidades"
            if (full && !isPrice(packPrice)) return "Falta el precio del paquete o no es válido"
            if (full && packCost.isNotBlank() && !isPrice(packCost)) return "El costo del paquete no es válido"
            if (whole(stockPacks) == null || whole(stockLoose) == null) return "Paquetes y sueltos deben ser números enteros de 0 o más"
        }
        if (full && tracksStock) {
            val stock = stockValue()
            if (stock == null || !validQuantity(stock, unitOrNull)) return stockError(unitOrNull)
        }
        if (editing && tracksStock) {
            val add = addValue()
            if (add == null || !validQuantity(add, unitOrNull)) {
                return if (unitOrNull != null) "La cantidad a añadir debe ser un número mayor o igual a 0 (hasta 3 decimales)"
                else "La cantidad a añadir debe ser un número entero mayor o igual a 0"
            }
        }
        return null
    }

    private fun total(packs: String, loose: String, plain: String): Double? =
        if (packOn) {
            val size = packSize.toIntOrNull() ?: return null
            val packCount = whole(packs) ?: return null
            val looseCount = whole(loose) ?: return null
            packCount * size + looseCount
        } else quantity(plain)

    private fun isPrice(text: String): Boolean = number(text)?.let { it >= 0 } == true

    companion object {
        fun stockError(unit: String?): String = if (unit != null)
            "El stock debe ser un número mayor o igual a 0 (hasta 3 decimales)"
        else "El stock debe ser un número entero mayor o igual a 0"
    }
}

/** "3" o "2,5"; null si no es un número finito. */
fun number(text: String): Double? = text.trim().replace(',', '.').toDoubleOrNull()?.takeIf { it.isFinite() }

/** Vacío = 0. Null si no es un entero mayor o igual a 0. */
fun whole(text: String): Double? = if (text.isBlank()) 0.0 else number(text)?.takeIf { it >= 0 && it == floor(it) }

/** Vacío = 0. Null si no es un número mayor o igual a 0. */
fun quantity(text: String): Double? = if (text.isBlank()) 0.0 else number(text)?.takeIf { it >= 0 }

/** Cantidad válida para ese producto: por peso hasta 3 decimales, por pieza entera. */
fun validQuantity(value: Double, unit: String?): Boolean {
    if (!value.isFinite() || value < 0) return false
    return if (unit != null) abs(round3(value) - value) < 1e-9 else value == floor(value)
}

fun round3(value: Double): Double = (value * 1000).roundToLong() / 1000.0
fun round4(value: Double): Double = (value * 10000).roundToLong() / 10000.0

/** Stock como se muestra en la lista: "3 paq + 7 sueltos", "2.5 kg", "Sin control". */
fun stockLabel(stock: Double, unit: String?, trackStock: Boolean, packSize: Int?): String = when {
    unit != null && !trackStock -> "Sin control"
    packSize != null && packSize > 1 -> packStockLabel(stock, packSize)
    unit != null -> "${Format.quantity(stock)} $unit"
    else -> Format.quantity(stock)
}

private fun packStockLabel(stock: Double, packSize: Int): String {
    val packs = floor(stock / packSize).toLong()
    val loose = stock - packs * packSize
    return when {
        packs == 0L -> "${Format.quantity(loose)} sueltos"
        loose == 0.0 -> "$packs paq"
        else -> "$packs paq + ${Format.quantity(loose)} sueltos"
    }
}
