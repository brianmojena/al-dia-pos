package cu.mypimes.pos.data.pos

import cu.mypimes.pos.domain.pos.CartLine
import cu.mypimes.pos.domain.pos.PosProduct
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PosResponseReconciliationTest {
    @Test
    fun emptyOrMismatchedSuccessBodyCannotAcknowledgeAnOutboxSale() {
        assertThrows(java.io.IOException::class.java) {
            requireConfirmedSale(null, "sale-local-1")
        }
        assertThrows(java.io.IOException::class.java) {
            requireConfirmedSale(SaleDto(), "sale-local-1")
        }
        assertThrows(java.io.IOException::class.java) {
            requireConfirmedSale(SaleDto(id = 15, clientSaleId = "different-sale"), "sale-local-1")
        }
    }

    @Test
    fun matchingClientIdOrServerIdIsRequiredConfirmation() {
        assertEquals("sale-local-1", requireConfirmedSale(
            SaleDto(clientSaleId = "sale-local-1"), "sale-local-1",
        ).clientSaleId)
        assertEquals(15L, requireConfirmedSale(SaleDto(id = 15), "sale-local-1").id)

        val localReceipt = requireConfirmedSale(SaleDto(id = 15), "sale-local-1")
            .toPosSale(fallbackClientSaleId = "sale-local-1")
        assertEquals("sale-local-1", localReceipt?.clientSaleId)
        assertEquals(15L, localReceipt?.serverId)
    }

    @Test
    fun remoteHistoryWithoutLinesKeepsTheCachedReceiptLines() {
        val lines = listOf(CartLine(PosProduct(7, "Arroz", 25.0, 8.0), 2.0))
        val remote = SaleDto(id = 52, total = 50.0, createdAt = "2026-10-28T17:00:00Z")
            .toPosSale(lines)

        assertEquals("server:52", remote?.clientSaleId)
        assertEquals(lines, remote?.lines)
        assertTrue(remote?.lines?.isNotEmpty() == true)
    }
}
