package cu.mypimes.pos.domain.pos

import org.junit.Assert.assertEquals
import org.junit.Test

class PosSaleReviewTest {
    private fun sale(id: String, status: String) = PosSale(
        clientSaleId = id, total = 10.0, cashReceived = 10.0, createdAt = "2026-10-28T12:00:00Z", status = status,
    )

    @Test fun showsOnlyReviewedSalesThatWereNotAcknowledged() {
        val sales = listOf(sale("a", "rejected"), sale("b", "synced"), sale("c", "blocked"), sale("d", "conflict"), sale("e", "pending"))

        assertEquals(listOf("a", "c", "d"), sales.unacknowledgedReviews(emptySet()).map { it.clientSaleId })
        assertEquals(listOf("c", "d"), sales.unacknowledgedReviews(setOf("a")).map { it.clientSaleId })
        assertEquals(emptyList<String>(), sales.unacknowledgedReviews(setOf("a", "c", "d")).map { it.clientSaleId })
    }
}
