package cu.mypimes.pos.data.store

import cu.mypimes.pos.data.local.QueuedOperationEntity
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Test

class RejectedCountsTest {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
    private val payload = """{"client_count_id":"c1","items":[{"product_id":1,"counted":2.0},{"product_id":2,"counted":0.0}]}"""

    private fun op(
        id: String,
        status: String,
        type: String = InventoryRepository.OP_COUNT,
        error: String? = null,
        body: String = payload,
    ) = QueuedOperationEntity(
        clientOperationId = id, accountKey = "acc", operationType = type, path = "/api/inventory-counts",
        method = "POST", payload = body, status = status, createdAt = 1L, lastError = error,
    )

    @Test fun showsOnlyRejectedCountsWithLinesAndServerReason() {
        val rows = rejectedCountsOf(
            listOf(
                op("pending", QueuedOperationEntity.STATUS_PENDING),
                op("failed", QueuedOperationEntity.STATUS_FAILED, error = "Producto no encontrado"),
                op("conflict", QueuedOperationEntity.STATUS_CONFLICT),
                op("discarded", QueuedOperationEntity.STATUS_DISCARDED, error = "viejo"),
                op("sale", QueuedOperationEntity.STATUS_FAILED, type = "sale", error = "otra cosa"),
            ),
            json,
        )
        assertEquals(listOf("failed", "conflict"), rows.map { it.operation.clientOperationId })
        assertEquals(2, rows[0].lines)
        assertEquals("Producto no encontrado", rows[0].reason)
        assertEquals("El servidor rechazó el arqueo.", rows[1].reason)
    }

    @Test fun unreadablePayloadStillShowsWithZeroLines() {
        val row = rejectedCountsOf(listOf(op("bad", QueuedOperationEntity.STATUS_FAILED, error = "e", body = "{no json")), json).single()
        assertEquals(0, row.lines)
    }
}
