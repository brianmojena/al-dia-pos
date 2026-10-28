package cu.mypimes.pos.domain.pos

import cu.mypimes.pos.domain.Payment
import kotlin.math.floor

object PosCart {
    private val weightUnits = setOf("kg", "g", "lb")
    private const val MAX_PACK_SIZE = 10_000

    /** Each line is rounded first, then the resulting lines are summed like the server. */
    fun total(lines: List<CartLine>): Double = Payment.round2(lines.sumOf { it.lineTotal })

    /** Adds a new line or combines it with the same product and sale type. */
    fun add(
        lines: List<CartLine>,
        product: PosProduct,
        quantity: Double,
        isPack: Boolean = false,
        enforceStock: Boolean = true,
    ): List<CartLine> {
        require(quantity.isFinite() && quantity > 0.0) {
            "El incremento de ${product.name} debe ser finito y mayor que cero"
        }
        val index = lines.indexOfFirst { it.product.id == product.id && it.isPack == isPack }
        val updated = lines.toMutableList()
        if (index >= 0) {
            // Replace the catalog snapshot with the current one, preserving quantity.
            updated[index] = CartLine(product, updated[index].quantity + quantity, isPack)
        } else {
            updated += CartLine(product, quantity, isPack)
        }
        return updated.toList().also { validate(it, enforceStock) }
    }

    /** A zero quantity removes the selected line. */
    fun changeQuantity(lines: List<CartLine>, index: Int, quantity: Double, enforceStock: Boolean = true): List<CartLine> {
        require(index in lines.indices) { "La línea del carrito no existe" }
        if (quantity == 0.0) return lines.toMutableList().also { it.removeAt(index) }.toList()
        val updated = lines.toMutableList()
        updated[index] = updated[index].copy(quantity = quantity)
        return updated.toList().also { validate(it, enforceStock) }
    }

    /** Un producto cuyo total pedido supera el stock que hay en el aparato. */
    data class StockGap(val name: String, val available: Double, val requested: Double)

    /** Validates quantities, prices, pack definitions, and (unless `enforceStock` is false) aggregate tracked stock. */
    fun validate(lines: List<CartLine>, enforceStock: Boolean = true) {
        validateLines(lines)
        // A7b: en caja central el stock local puede estar viejo; el servidor decide al subir la venta.
        if (enforceStock) stockGaps(lines).firstOrNull()?.let { gap ->
            throw IllegalArgumentException("Stock insuficiente de ${gap.name}: hay ${gap.available} y se solicitan ${gap.requested}")
        }
    }

    /** Productos pedidos por encima del stock local (los de peso no cuentan, como en el servidor). */
    fun stockGaps(lines: List<CartLine>): List<StockGap> {
        val requiredStock = mutableMapOf<Long, Double>()
        val stockByProduct = mutableMapOf<Long, Double>()
        lines.forEach { line ->
            val unit = line.product.unit?.trim()?.lowercase()
            if (unit?.let(weightUnits::contains) != true) {
                requiredStock[line.product.id] = (requiredStock[line.product.id] ?: 0.0) + line.stockUnits
                stockByProduct[line.product.id] = minOf(stockByProduct[line.product.id] ?: line.product.stock, line.product.stock)
            }
        }
        return requiredStock.mapNotNull { (productId, requested) ->
            val requestedRounded = roundQty(requested)
            val available = stockByProduct.getValue(productId)
            if (requestedRounded <= available) null
            else StockGap(lines.first { it.product.id == productId }.product.name, available, requestedRounded)
        }
    }

    private fun validateLines(lines: List<CartLine>) {

        lines.forEach { line ->
            val product = line.product
            require(product.name.isNotBlank()) { "El producto no tiene nombre" }
            require(product.salePrice.isFinite() && product.salePrice >= 0.0) {
                "El precio de ${product.name} no es válido"
            }
            require(product.stock.isFinite() && product.stock >= 0.0) {
                "El stock de ${product.name} no es válido"
            }
            val unit = product.unit?.trim()?.lowercase()
            require(product.unit == null || unit?.let(weightUnits::contains) == true) {
                "La unidad de ${product.name} no es válida (kg, g o lb)"
            }

            require(line.quantity.isFinite() && line.quantity > 0.0) {
                "La cantidad de ${product.name} debe ser mayor que cero"
            }
            if (unit?.let(weightUnits::contains) == true) {
                require(line.quantity >= 0.001) {
                    "La cantidad de ${product.name} debe ser al menos 0.001 ${unit}"
                }
                require(kotlin.math.abs(roundQty(line.quantity) - line.quantity) < 1e-9) {
                    "La cantidad de ${product.name} admite hasta 3 decimales"
                }
                require(!line.isPack) { "Un producto por peso no se vende por paquete" }
            } else {
                require(line.quantity == floor(line.quantity)) {
                    "La cantidad de ${product.name} tiene que ser un número entero"
                }
            }

            if (line.isPack) {
                val packSize = product.packSize
                require(unit?.let(weightUnits::contains) != true && packSize != null && packSize in 2..MAX_PACK_SIZE) {
                    "El paquete de ${product.name} debe traer entre 2 y $MAX_PACK_SIZE unidades"
                }
                require(product.packPrice != null && product.packPrice.isFinite() && product.packPrice >= 0.0) {
                    "El precio del paquete de ${product.name} no es válido"
                }
            }

            require(line.unitPrice.isFinite() && line.unitPrice >= 0.0) {
                "El precio de ${product.name} no es válido"
            }
            require(line.lineTotal.isFinite()) { "El importe de ${product.name} no es válido" }
        }
    }

    private fun roundQty(value: Double): Double = floor(value * 1000.0 + 0.5) / 1000.0
}
