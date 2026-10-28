package cu.mypimes.pos.domain.outbox

import cu.mypimes.pos.data.local.QueuedOperationEntity
import cu.mypimes.pos.domain.pos.PosSale
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * A5: reglas puras de la cola con dependencias. Aquí no hay Room ni red: las usan `OwnerOutbox`, `PosRepository`
 * e `InventoryRepository`, y las pruebas JVM las ejercitan solas.
 */
object Outbox {
    // Escrituras del dueño (A6).
    const val PRODUCT_CREATE = "product_create"
    const val PRODUCT_UPDATE = "product_update"
    const val PRODUCT_DELETE = "product_delete"
    const val PRODUCT_IMPORT = "product_import"
    const val WAREHOUSE_CREATE = "warehouse_create"
    const val WAREHOUSE_UPDATE = "warehouse_update"
    const val WAREHOUSE_DELETE = "warehouse_delete"
    const val WAREHOUSE_IMPORT = "warehouse_import"
    const val COUNT_CORRECT = "count_correct"
    const val SALE_CORRECT = "sale_correct"
    val OWNER_TYPES = setOf(
        PRODUCT_CREATE, PRODUCT_UPDATE, PRODUCT_DELETE, PRODUCT_IMPORT,
        WAREHOUSE_CREATE, WAREHOUSE_UPDATE, WAREHOUSE_DELETE, WAREHOUSE_IMPORT, COUNT_CORRECT, SALE_CORRECT,
    )

    const val STATUS_BLOCKED = "blocked"
    const val STATUS_REJECTED = "rejected"
    const val DEP_PREFIX = "Depende de"
    const val ROLE_OWNER = "dueño"
    const val ROLE_CASHIER = "cajero"

    /** Estados de los que una dependiente ya no puede esperar nada: la operación no va a subir sola. */
    private val DEAD = setOf(
        QueuedOperationEntity.STATUS_FAILED, QueuedOperationEntity.STATUS_CONFLICT,
        QueuedOperationEntity.STATUS_DISCARDED, STATUS_REJECTED, STATUS_BLOCKED,
    )

    /** Registros que se pueden crear sin red con id temporal negativo. */
    enum class Entity(val key: String, val createType: String, val field: String?, val pathPrefix: String) {
        PRODUCT("product", PRODUCT_CREATE, "product_id", "/api/products/"),
        WAREHOUSE("warehouse", WAREHOUSE_CREATE, null, "/api/warehouse/"),
    }

    fun label(type: String) = when (type) {
        PRODUCT_CREATE -> "el alta del producto"
        PRODUCT_UPDATE -> "la edición del producto"
        PRODUCT_DELETE -> "el borrado del producto"
        PRODUCT_IMPORT -> "la importación de productos"
        WAREHOUSE_CREATE -> "el alta del artículo de almacén"
        WAREHOUSE_UPDATE -> "la edición del artículo de almacén"
        WAREHOUSE_DELETE -> "el borrado del artículo de almacén"
        WAREHOUSE_IMPORT -> "la importación de almacén"
        COUNT_CORRECT -> "la corrección del arqueo"
        SALE_CORRECT -> "la corrección de la venta"
        "sale" -> "la venta"
        "inventory_count" -> "el arqueo"
        "close" -> "el cierre"
        "withdrawal" -> "la extracción"
        "purchase" -> "la compra de divisas"
        else -> "otra operación"
    }

    sealed interface Gate {
        object Ready : Gate
        object Wait : Gate
        class Block(val reason: String) : Gate
    }

    fun blockedReason(dep: QueuedOperationEntity): String =
        "$DEP_PREFIX ${label(dep.operationType)}, que no se subió" + (dep.lastError?.let { ": $it" } ?: "")

    /** `find` devuelve null cuando la dependencia ya se confirmó (y salió de la cola): entonces no espera. */
    fun gate(deps: List<String>, find: (String) -> QueuedOperationEntity?): Gate {
        var waiting = false
        for (id in deps) {
            val dep = find(id) ?: continue
            when {
                dep.status in DEAD -> return Gate.Block(blockedReason(dep))
                else -> waiting = true
            }
        }
        return if (waiting) Gate.Wait else Gate.Ready
    }

    class Settle(val block: Map<String, String>, val unblock: Set<String>)

    /**
     * Cascada: toda operación pendiente cuya dependencia murió pasa a `blocked` (con el motivo), también las
     * que dependen de otra ya bloqueada. Si la dependencia vuelve a `pending` (reintento) o se confirmó, las que
     * estaban bloqueadas SOLO por eso vuelven a `pending`. Nunca borra nada.
     */
    fun settle(queue: List<QueuedOperationEntity>, depsOf: Map<String, List<String>>): Settle {
        val byId = queue.associateBy { it.clientOperationId }
        val status = queue.associate { it.clientOperationId to it.status }.toMutableMap()
        val block = LinkedHashMap<String, String>()
        val unblock = LinkedHashSet<String>()
        for (op in queue.sortedWith(compareBy({ it.createdAt }, { it.clientOperationId }))) {
            val deps = depsOf[op.clientOperationId].orEmpty()
            if (deps.isEmpty()) continue
            val byDependency = op.status == STATUS_BLOCKED && op.lastError?.startsWith(DEP_PREFIX) == true
            if (op.status != QueuedOperationEntity.STATUS_PENDING && !byDependency) continue
            val dead = deps.firstOrNull { status[it] in DEAD }
            if (dead != null) {
                if (!byDependency) block[op.clientOperationId] = blockedReason(byId.getValue(dead))
                status[op.clientOperationId] = STATUS_BLOCKED
            } else if (byDependency) {
                unblock += op.clientOperationId
                status[op.clientOperationId] = QueuedOperationEntity.STATUS_PENDING
            }
        }
        return Settle(block, unblock)
    }

    // ---- Ids temporales ------------------------------------------------------

    fun isTemp(id: Long) = id < 0

    /** Ids negativos que la operación usa (en el cuerpo y en la ruta). */
    fun tempRefs(path: String, payload: String): Set<Pair<Entity, Long>> {
        val found = LinkedHashSet<Pair<Entity, Long>>()
        for (entity in Entity.values()) {
            if (path.startsWith(entity.pathPrefix)) {
                path.removePrefix(entity.pathPrefix).substringBefore('/').toLongOrNull()?.takeIf(::isTemp)?.let { found += entity to it }
            }
            val field = entity.field ?: continue
            walk(runCatching { Json.parseToJsonElement(payload) }.getOrNull()) { key, value ->
                if (key == field) value.longOrNull?.takeIf(::isTemp)?.let { found += entity to it }
            }
        }
        return found
    }

    private fun walk(element: JsonElement?, visit: (String, JsonPrimitive) -> Unit) {
        when (element) {
            is JsonObject -> element.forEach { (key, value) ->
                if (value is JsonPrimitive) visit(key, value) else walk(value, visit)
            }
            is JsonArray -> element.forEach { walk(it, visit) }
            else -> Unit
        }
    }

    /** Nueva (ruta, cuerpo) con el id temporal cambiado por el real; null si la operación no lo usaba. */
    fun rewrite(entity: Entity, from: Long, to: Long, path: String, payload: String): Pair<String, String>? {
        var newPath = path
        val segment = entity.pathPrefix + from
        if (path == segment || path.startsWith("$segment/")) newPath = entity.pathPrefix + to + path.removePrefix(segment)
        var newPayload = payload
        val field = entity.field
        if (field != null) {
            val parsed = runCatching { Json.parseToJsonElement(payload) }.getOrNull()
            val replaced = parsed?.let { replace(it, field, from, to) }
            if (replaced != null && replaced != parsed) newPayload = Json.encodeToString(JsonElement.serializer(), replaced)
        }
        return if (newPath == path && newPayload == payload) null else newPath to newPayload
    }

    private fun replace(element: JsonElement, field: String, from: Long, to: Long): JsonElement = when (element) {
        is JsonObject -> JsonObject(element.mapValues { (key, value) ->
            if (key == field && value is JsonPrimitive && value.longOrNull == from) JsonPrimitive(to) else replace(value, field, from, to)
        })
        is JsonArray -> JsonArray(element.map { replace(it, field, from, to) })
        else -> element
    }

    /** La venta con sus líneas apuntando al producto real; null si no usaba el temporal. */
    fun rewriteSale(sale: PosSale, from: Long, to: Long): PosSale? {
        if (sale.lines.none { it.product.id == from }) return null
        return sale.copy(lines = sale.lines.map {
            if (it.product.id == from) it.copy(product = it.product.copy(id = to)) else it
        })
    }
}
