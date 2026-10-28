package cu.mypimes.pos.data.store

import cu.mypimes.pos.data.local.QueuedOperationEntity
import cu.mypimes.pos.data.pos.ProductDto
import cu.mypimes.pos.domain.outbox.Outbox
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject

/**
 * A6: lo que el dueño cambió sin red, aplicado encima de lo que bajó del servidor. La caché sigue siendo la verdad
 * del servidor; la cola es la verdad de lo pendiente. Así una descarga nueva nunca pisa un cambio sin subir, y una
 * operación rechazada deja de aplicarse (la fila vuelve a lo del servidor) pero sigue visible en la cola.
 * Solo se aplican las operaciones `pending`; las bloqueadas, en conflicto o fallidas no.
 */
object OwnerOverlay {
    private fun applicable(ops: List<QueuedOperationEntity>, vararg types: String) = ops
        .filter { it.status == QueuedOperationEntity.STATUS_PENDING && it.operationType in types }
        .sortedWith(compareBy({ it.createdAt }, { it.clientOperationId }))

    private fun body(op: QueuedOperationEntity, json: Json): JsonObject? =
        runCatching { json.parseToJsonElement(op.payload).jsonObject }.getOrNull()

    private fun idOf(op: QueuedOperationEntity) = op.path.substringAfterLast('/').toLongOrNull()

    private fun JsonObject.double(key: String) = (this[key] as? JsonPrimitive)?.doubleOrNull
    private fun JsonObject.text(key: String) = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

    fun products(base: List<ProductDto>, ops: List<QueuedOperationEntity>, json: Json): List<ProductDto> {
        var list = base
        for (op in applicable(ops, Outbox.PRODUCT_CREATE, Outbox.PRODUCT_UPDATE, Outbox.PRODUCT_DELETE)) {
            val b = body(op, json)
            list = when (op.operationType) {
                Outbox.PRODUCT_CREATE -> {
                    val id = op.entityRef?.toLongOrNull()
                    if (b == null || id == null || list.any { it.id == id }) list else list + newProduct(id, b)
                }
                Outbox.PRODUCT_DELETE -> list.filter { it.id != idOf(op) }
                else -> list.map { if (it.id == idOf(op) && b != null) editProduct(it, b) else it }
            }
        }
        return list
    }

    fun newProduct(id: Long, b: JsonObject): ProductDto {
        val unit = b.text("unit")
        val track = if (b.containsKey("track_stock")) (b["track_stock"] as? JsonPrimitive)?.intOrNull ?: 1 else if (unit == null) 1 else 0
        return ProductDto(
            id = id, name = b.text("name").orEmpty(), salePrice = b.double("sale_price") ?: 0.0,
            stock = if (track == 1) b.double("stock") ?: 0.0 else 0.0, unit = unit, trackStock = track,
            packSize = (b["pack_size"] as? JsonPrimitive)?.intOrNull, packPrice = b.double("pack_price"),
            purchasePrice = b.double("purchase_price") ?: 0.0,
        )
    }

    /** Los mismos campos que el servidor aplica en `PUT /products/:id`; una clave ausente no cambia nada. */
    fun editProduct(p: ProductDto, b: JsonObject): ProductDto {
        var r = p
        b.text("name")?.let { r = r.copy(name = it) }
        b.double("sale_price")?.let { r = r.copy(salePrice = it) }
        b.double("purchase_price")?.let { r = r.copy(purchasePrice = it) }
        if (b.containsKey("unit")) r = r.copy(unit = b.text("unit"))
        if (b.containsKey("pack_size")) r = r.copy(packSize = (b["pack_size"] as? JsonPrimitive)?.intOrNull)
        if (b.containsKey("pack_price")) r = r.copy(packPrice = b.double("pack_price"))
        if (b.containsKey("track_stock")) r = r.copy(trackStock = (b["track_stock"] as? JsonPrimitive)?.intOrNull ?: 1)
        // Igual que el servidor: si hay cantidad a añadir, esa manda y el total se ignora.
        val add = b.double("add_stock")?.takeIf { it > 0 }
        if (add != null) r = r.copy(stock = r.stock + add) else b.double("stock")?.let { r = r.copy(stock = it) }
        return r
    }

    fun warehouse(base: List<WarehouseItemDto>, ops: List<QueuedOperationEntity>, json: Json): List<WarehouseItemDto> {
        var list = base
        for (op in applicable(ops, Outbox.WAREHOUSE_CREATE, Outbox.WAREHOUSE_UPDATE, Outbox.WAREHOUSE_DELETE)) {
            val b = body(op, json)
            list = when (op.operationType) {
                Outbox.WAREHOUSE_CREATE -> {
                    val id = op.entityRef?.toLongOrNull()
                    if (b == null || id == null || list.any { it.id == id }) list
                    else list + WarehouseItemDto(id, b.text("name").orEmpty(), b.text("unit"), b.double("cost") ?: 0.0, b.double("quantity") ?: 0.0)
                }
                Outbox.WAREHOUSE_DELETE -> list.filter { it.id != idOf(op) }
                else -> list.map { if (it.id == idOf(op) && b != null) editItem(it, b) else it }
            }
        }
        return list
    }

    fun editItem(i: WarehouseItemDto, b: JsonObject): WarehouseItemDto {
        var r = i
        b.text("name")?.let { r = r.copy(name = it) }
        b.double("cost")?.let { r = r.copy(cost = it) }
        if (b.containsKey("unit")) r = r.copy(unit = if (b["unit"] is JsonNull) null else b.text("unit"))
        b.double("add_quantity")?.let { r = r.copy(quantity = r.quantity + it) }
        return r
    }

    /** Operaciones del dueño que aún no están confirmadas (pendientes o rechazadas): la base del aviso «sin subir». */
    fun unsettled(ops: List<QueuedOperationEntity>) = ops.filter {
        it.operationType in Outbox.OWNER_TYPES && it.status != QueuedOperationEntity.STATUS_DISCARDED
    }
}
