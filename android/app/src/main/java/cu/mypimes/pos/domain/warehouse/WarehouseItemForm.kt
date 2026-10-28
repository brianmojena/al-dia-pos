package cu.mypimes.pos.domain.warehouse

import cu.mypimes.pos.domain.products.number
import cu.mypimes.pos.domain.products.validQuantity

/**
 * Mismas reglas que `server/routes/warehouse.js` (alta y edición). En el alta, `quantity` es la
 * cantidad inicial; en la edición, lo que llegó (reposición, opcional). `editingQuantity` es el
 * stock actual del artículo que se edita (null en el alta); `takenNames` son los nombres de los
 * demás artículos. Null si se puede guardar.
 */
fun warehouseItemError(
    name: String,
    cost: String,
    unit: String?,
    quantity: String,
    editingQuantity: Double?,
    takenNames: List<String>,
): String? {
    val clean = name.trim().replace(Regex("\\s+"), " ")
    if (clean.isEmpty()) return "Falta el nombre del artículo"
    val key = warehouseKey(clean)
    if (takenNames.any { warehouseKey(it) == key }) return "Ya hay un artículo con ese nombre en el almacén"
    if ((number(cost.ifBlank { "0" }) ?: -1.0) < 0) return "El costo no es válido"

    if (editingQuantity == null) {
        val value = if (quantity.isBlank()) 0.0 else number(quantity)
        if (value == null || !validQuantity(value, unit)) {
            return if (unit != null) "La cantidad debe ser un número mayor o igual a 0 (hasta 3 decimales)"
            else "La cantidad debe ser un entero mayor o igual a 0"
        }
    } else if (quantity.isNotBlank()) {
        val add = number(quantity)
        if (add == null || add <= 0 || !validQuantity(add, unit)) {
            return if (unit != null) "La cantidad a añadir debe ser mayor que 0 (hasta 3 decimales)"
            else "La cantidad a añadir debe ser un entero mayor que 0"
        }
    } else if (unit == null && !validQuantity(editingQuantity, null)) {
        return "Al quitar la unidad de medida hay que poner la cantidad en piezas enteras"
    }
    return null
}
