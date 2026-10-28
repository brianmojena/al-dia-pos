package cu.mypimes.pos.data.local

import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.Flow

/** Account-scoped durable outbox. This class does not send operations to the server. */
@Singleton
class QueueRepository @Inject constructor(private val dao: LocalDao) {
    fun observe(accountKey: String): Flow<List<QueuedOperationEntity>> = dao.observeQueue(accountKey)

    suspend fun enqueue(
        accountKey: String,
        operationType: String,
        path: String,
        method: String,
        payload: String,
        clientOperationId: String = UUID.randomUUID().toString(),
        createdAt: Long = System.currentTimeMillis(),
        dependsOn: List<String> = emptyList(),
        entityRef: String? = null,
        ownerRole: String = "cajero",
    ): String {
        require(accountKey.isNotBlank()) { "La operación necesita una cuenta propietaria" }
        require(clientOperationId.isNotBlank()) { "La operación necesita un ID estable" }
        require(operationType.isNotBlank() && path.startsWith("/api/") && method.isNotBlank())
        dao.enqueueWithDependencies(QueuedOperationEntity(clientOperationId, accountKey, operationType,
            path, method.uppercase(), payload, createdAt = createdAt, dependsOn = dependsOn.firstOrNull(),
            entityRef = entityRef, ownerRole = ownerRole), dependsOn)
        return clientOperationId
    }

    suspend fun pending(accountKey: String) = dao.pending(accountKey)

    suspend fun markFailed(operation: QueuedOperationEntity, error: String) = dao.setQueueState(
        operation.clientOperationId, operation.accountKey,
        QueuedOperationEntity.STATUS_FAILED, operation.attempts + 1, error,
    )

    suspend fun markConflict(operation: QueuedOperationEntity, error: String) = dao.setQueueState(
        operation.clientOperationId, operation.accountKey,
        QueuedOperationEntity.STATUS_CONFLICT, operation.attempts + 1, error,
    )

    /** Solo cambia el estado: la operación y su motivo siguen en la cola. */
    suspend fun discard(operation: QueuedOperationEntity) = dao.setQueueState(
        operation.clientOperationId, operation.accountKey,
        QueuedOperationEntity.STATUS_DISCARDED, operation.attempts, operation.lastError,
    )

    suspend fun retry(operation: QueuedOperationEntity) = dao.setQueueState(
        operation.clientOperationId, operation.accountKey,
        QueuedOperationEntity.STATUS_PENDING, operation.attempts, null,
    )

    /** Only a caller holding a confirmed server acknowledgement should invoke this. */
    suspend fun acknowledge(operation: QueuedOperationEntity) =
        dao.deleteAcknowledged(operation.clientOperationId, operation.accountKey)
}
