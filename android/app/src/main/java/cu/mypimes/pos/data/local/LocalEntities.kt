package cu.mypimes.pos.data.local

import androidx.room.Entity
import androidx.room.ColumnInfo
import androidx.room.Index
import androidx.room.PrimaryKey

/** JSON snapshots allow the app to add cached server resources without losing old cache rows. */
@Entity(tableName = "cache_records", primaryKeys = ["accountKey", "kind", "recordKey"])
data class CacheRecordEntity(
    val accountKey: String,
    val kind: String,
    val recordKey: String,
    val payload: String,
    val updatedAt: Long,
)

@Entity(tableName = "sync_cursors", primaryKeys = ["accountKey", "cursorName"])
data class SyncCursorEntity(
    val accountKey: String,
    val cursorName: String,
    val value: Long,
)

@Entity(
    tableName = "operation_queue",
    indices = [Index(value = ["accountKey", "status", "createdAt"]), Index(value = ["clientOperationId"], unique = true)],
)
data class QueuedOperationEntity(
    @PrimaryKey val clientOperationId: String,
    val accountKey: String,
    val operationType: String,
    val path: String,
    val method: String,
    val payload: String,
    /** pending, failed, conflict or discarded. All states are durable and never auto-deleted. */
    val status: String = STATUS_PENDING,
    val createdAt: Long,
    val attempts: Int = 0,
    val lastError: String? = null,
    /** A5: id de la operación que debe subir antes que esta. Nulo mientras nadie lo use. */
    val dependsOn: String? = null,
    /** A5: id temporal (negativo) del registro local que esta operación crea. */
    val entityRef: String? = null,
    /** Quién la originó: 'cajero' o 'dueño'. Las filas anteriores a v2 son del cajero. */
    @ColumnInfo(defaultValue = "'cajero'") val ownerRole: String = "cajero",
) {
    companion object {
        const val STATUS_PENDING = "pending"
        const val STATUS_FAILED = "failed"
        const val STATUS_CONFLICT = "conflict"
        /** El usuario lo descartó: no se envía, pero la fila y su motivo se conservan. */
        const val STATUS_DISCARDED = "discarded"
    }
}

/**
 * Índice de ventas para consultar por día sin red. Es derivado: la fuente sigue siendo la caché `pos_sales`
 * (`payloadJson` es el mismo `PosSale`). `businessDate` es el día del negocio en Cuba (ver `BusinessDay`).
 */
@Entity(
    tableName = "sale",
    primaryKeys = ["accountKey", "clientSaleId"],
    indices = [Index(value = ["accountKey", "businessDate"]), Index(value = ["accountKey", "cashCloseId"])],
)
data class SaleEntity(
    val accountKey: String,
    val clientSaleId: String,
    val serverId: Long?,
    val businessDate: String,
    val createdAt: String,
    val total: Double,
    val profit: Double?,
    val paymentMethod: String,
    val cashCloseId: Long?,
    val registerId: String,
    val status: String,
    val payloadJson: String,
)

@Entity(tableName = "sale_line", primaryKeys = ["accountKey", "clientSaleId", "idx"])
data class SaleLineEntity(
    val accountKey: String,
    val clientSaleId: String,
    val idx: Int,
    val productId: Long,
    val name: String,
    val qty: Double,
    val unitPrice: Double,
    val unitCost: Double?,
    val packSize: Int?,
)

/** A5 (aún sin uso): una operación que no puede subir hasta que otra termine. */
@Entity(tableName = "outbox_dependency", primaryKeys = ["clientOperationId", "dependsOnClientOperationId"])
data class OutboxDependencyEntity(
    val clientOperationId: String,
    val dependsOnClientOperationId: String,
)

/** A5 (aún sin uso): id temporal local -> id definitivo del servidor. */
@Entity(tableName = "id_map", primaryKeys = ["accountKey", "entity", "localId"])
data class IdMapEntity(
    val accountKey: String,
    val entity: String,
    val localId: Long,
    val serverId: Long,
)
