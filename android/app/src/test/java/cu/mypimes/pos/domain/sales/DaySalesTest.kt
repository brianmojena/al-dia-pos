package cu.mypimes.pos.domain.sales

import cu.mypimes.pos.data.pos.SaleDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DaySalesTest {
    private val sales = listOf(
        SaleDto(id = 1, total = 1000.0, paymentMethod = "efectivo", accountEmail = "ana@t.cu"),
        SaleDto(id = 2, total = 500.0, paymentMethod = "mixto", transferAmount = 200.0, accountEmail = "ana@t.cu"),
        // 2 USD a 350 = 700 de 1000: 300 en efectivo (el resto lo completó el cliente).
        SaleDto(id = 3, total = 1000.0, paymentMethod = "divisa", foreignCurrency = "USD", foreignAmount = 2.0, exchangeRate = 350.0, accountEmail = "luis@t.cu"),
        // 3 EUR a 400 = 1200 de 1000: 200 de vuelto en efectivo.
        SaleDto(id = 4, total = 1000.0, paymentMethod = "divisa", foreignCurrency = "EUR", foreignAmount = 3.0, exchangeRate = 400.0, accountEmail = "luis@t.cu"),
        SaleDto(id = 5, total = 100.0, paymentMethod = "transferencia"),
    )

    @Test
    fun splitUsesTheSameAccountsAsTheCashCount() {
        val s = DaySales.split(sales)
        assertEquals(1000.0 + 300.0 + 300.0 + (1000.0 - 1200.0), s.cash, 0.001)
        assertEquals(200.0 + 100.0, s.transfer, 0.001)
        assertEquals(2.0, s.usd, 0.001)
        assertEquals(3.0, s.eur, 0.001)
        assertEquals(3600.0, DaySales.total(sales), 0.001)
    }

    @Test
    fun cashiersAreGroupedSortedAndFiltered() {
        val rows = DaySales.byCashier(sales)
        assertEquals(listOf("luis@t.cu", "ana@t.cu", null), rows.map { it.email })
        assertEquals(2, rows[1].count); assertEquals(1500.0, rows[1].total, 0.001)
        assertEquals(listOf(1L, 2L), DaySales.filter(sales, rows[1]).map { it.id })
        assertEquals(5, DaySales.filter(sales, null).size)
        assertEquals("ana", DaySales.accountLabel("ana@t.cu")); assertNull(DaySales.accountLabel(null))
    }
}
