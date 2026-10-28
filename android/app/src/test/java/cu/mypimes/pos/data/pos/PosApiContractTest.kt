package cu.mypimes.pos.data.pos

import cu.mypimes.pos.domain.pos.PosCart
import cu.mypimes.pos.domain.pos.PosProduct
import cu.mypimes.pos.domain.pos.CartLine
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PosApiContractTest {
    private val json = Json { explicitNulls = false }

    @Test
    fun salePostUsesStableIdRegisterTimeItemsAndCashContract() {
        val request = CreateSaleRequest(
            clientSaleId = "client-uuid",
            registerId = "desk-device-uuid",
            soldAt = "2026-10-28T17:00:00Z",
            items = listOf(SaleItemRequest(41, 2.0, 17.5, packSize = 6)),
            paymentMethod = "efectivo",
            cashReceived = 40.0,
        )

        val body = json.encodeToString(request)
        assertTrue(body.contains("\"client_sale_id\":\"client-uuid\""))
        assertTrue(body.contains("\"register_id\":\"desk-device-uuid\""))
        assertTrue(body.contains("\"sold_at\":\"2026-10-28T17:00:00Z\""))
        assertTrue(body.contains("\"product_id\":41"))
        assertTrue(body.contains("\"unit_price\":17.5"))
        assertTrue(body.contains("\"pack_size\":6"))
        assertTrue(body.contains("\"payment_method\":\"efectivo\""))
        assertTrue(body.contains("\"cash_received\":40.0"))
    }

    @Test
    fun productWireMappingKeepsPackAndWeighedStockSemantics() {
        val piece = ProductDto(1, "Cigarros", 9.0, 20.0, trackStock = 1, packSize = 10, packPrice = 80.0).toProduct()
        val weighed = ProductDto(2, "Queso", 80.0, 3.25, unit = "kg", trackStock = 0).toProduct()

        assertEquals(10, piece.packSize)
        assertEquals(80.0, piece.packPrice!!, 0.0)
        assertTrue(piece.trackStock)
        assertFalse(weighed.trackStock)
        assertEquals("kg", weighed.unit)
    }

    @Test
    fun cartRejectsAggregatedStockAcrossPackAndLooseLines() {
        val product = PosProduct(8, "Caja", 5.0, 5.0, packSize = 4, packPrice = 18.0)
        val lines = listOf(CartLine(product, 1.0, isPack = true), CartLine(product, 2.0))

        val failure = runCatching { PosCart.validate(lines) }.exceptionOrNull()
        assertTrue(failure?.message?.contains("Stock insuficiente") == true)
    }
}
