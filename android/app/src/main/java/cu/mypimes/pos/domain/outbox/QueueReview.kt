package cu.mypimes.pos.domain.outbox

import cu.mypimes.pos.data.local.QueuedOperationEntity
import cu.mypimes.pos.domain.pos.PosSale

/**
 * A8/A9: lectura de la cola para el indicador «N sin subir · M por revisar» y el panel «Por revisar».
 * Solo mira estados: no cambia ni borra nada. Lo descartado ya no cuenta, pero su fila se conserva.
 */
object QueueReview {
    data class Counts(val unsent: Int, val review: Int) {
        val clean: Boolean get() = unsent == 0 && review == 0
        val text: String get() = "$unsent sin subir · $review por revisar"
    }

    enum class Group(val title: String) {
        REJECTED("Rechazadas por el servidor"),
        CONFLICT("En conflicto"),
        BLOCKED("Bloqueadas por dependencia"),
    }

    /** `failed` es un 4xx del servidor (no es conflicto): se agrupa con las rechazadas. */
    fun groupOf(op: QueuedOperationEntity): Group? = when (op.status) {
        Outbox.STATUS_REJECTED, QueuedOperationEntity.STATUS_FAILED -> Group.REJECTED
        QueuedOperationEntity.STATUS_CONFLICT -> Group.CONFLICT
        Outbox.STATUS_BLOCKED -> Group.BLOCKED
        else -> null
    }

    fun counts(ops: List<QueuedOperationEntity>) = Counts(
        unsent = ops.count { it.status == QueuedOperationEntity.STATUS_PENDING },
        review = ops.count { groupOf(it) != null },
    )

    /** Siempre las tres claves, cada una de la más vieja a la más nueva. */
    fun grouped(ops: List<QueuedOperationEntity>): Map<Group, List<QueuedOperationEntity>> {
        val sorted = ops.sortedWith(compareBy({ it.createdAt }, { it.clientOperationId }))
        return Group.entries.associateWith { group -> sorted.filter { groupOf(it) == group } }
    }

    /** Un producto de una venta rechazada por stock, con lo que dijo el servidor si lo dijo en el mensaje. */
    data class StockLine(val product: String, val quantity: Double, val serverStock: Double?)

    fun isStockMessage(message: String?) = message?.contains("stock", ignoreCase = true) == true

    /** «hay 3» / «hay 2.5» en el mensaje del servidor; null si no lo trae (hoy solo trae el nombre del producto). */
    fun serverStock(message: String?): Double? =
        message?.let { Regex("""\bhay\s+(\d+(?:[.,]\d+)?)""", RegexOption.IGNORE_CASE).find(it) }
            ?.groupValues?.get(1)?.replace(',', '.')?.toDoubleOrNull()

    /** Solo si el motivo habla de stock; prefiere las líneas cuyo producto aparece en el mensaje. */
    fun stockLines(sale: PosSale?, message: String?): List<StockLine> {
        if (sale == null || !isStockMessage(message)) return emptyList()
        val named = sale.lines.filter { message!!.contains(it.product.name, ignoreCase = true) }
        val stock = serverStock(message)
        return (named.ifEmpty { sale.lines }).map { StockLine(it.product.name, it.quantity, stock) }
    }
}
