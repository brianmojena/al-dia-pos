package cu.mypimes.pos.domain.warehouse

import cu.mypimes.pos.domain.Format
import cu.mypimes.pos.domain.products.number
import cu.mypimes.pos.domain.products.validQuantity
import java.text.Normalizer

/** Mismo criterio que la web y el servidor: sin tildes, en minúsculas y con espacios simples. */
fun warehouseKey(name: String): String = Normalizer.normalize(name, Normalizer.Form.NFD)
    .replace(Regex("\\p{Mn}+"), "").lowercase().replace(Regex("\\s+"), " ").trim()

/** Null si la cantidad sirve; si no, el motivo. `available` es lo que hay en el origen del pase. */
fun transferQuantityError(text: String, unit: String?, available: Double): String? {
    val value = number(text)
    return when {
        value == null || value <= 0 || !validQuantity(value, unit) ->
            if (unit != null) "La cantidad debe ser mayor que 0 (hasta 3 decimales)" else "La cantidad debe ser un entero mayor que 0"
        value > available + 1e-9 -> "Solo hay ${Format.quantity(available)}${unit?.let { " $it" }.orEmpty()}"
        else -> null
    }
}

/** Si el producto aún no está en la tienda, hace falta su precio de venta (el servidor lo exige igual). */
fun salePriceError(text: String, needed: Boolean): String? =
    if (!needed || (number(text) ?: -1.0) >= 0) null
    else "Indica el precio de venta: este producto aún no está en la tienda"
