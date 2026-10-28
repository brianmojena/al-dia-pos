package cu.mypimes.pos.domain.sales

import cu.mypimes.pos.data.pos.SaleDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LocalReportsTest {
    private fun sale(at: String, total: Double, method: String = "efectivo", profit: Double? = 10.0, transfer: Double? = null) =
        SaleDto(createdAt = at, total = total, paymentMethod = method, profit = profit, transferAmount = transfer)

    @Test fun monthGroupsByBusinessDayAndSplitsPayments() {
        val sales = listOf(
            sale("2026-10-28 14:00:00", 100.0),
            sale("2026-10-29 02:30:00", 50.0, "transferencia"),   // 22:30 del 28 en Cuba: cuenta el 28
            sale("2026-10-30 03:00:00", 200.0, "mixto", transfer = 80.0), // 23:00 del 29
        )
        val month = LocalReports.month("2026-10", sales)
        assertEquals(listOf("2026-10-29", "2026-10-28"), month.days.map { it.date })
        assertEquals(listOf(1, 2), month.days.map { it.salesCount })
        assertEquals(150.0, month.days.last().total, 0.0)
        assertEquals(3, month.totals.salesCount); assertEquals(350.0, month.totals.total, 0.0)
        assertEquals(220.0, month.totals.cashTotal, 0.0)       // 100 + (200-80)
        assertEquals(130.0, month.totals.transferTotal, 0.0)   // 50 + 80
        assertEquals(30.0, month.totals.profit, 0.0)
    }

    @Test fun missingProfitCountsAsZeroAndAnEmptyDayIsEmpty() {
        assertEquals(0.0, LocalReports.month("2026-10", listOf(sale("2026-10-28 14:00:00", 5.0, profit = null))).totals.profit, 0.0)
        val day = LocalReports.day("2026-10-28", emptyList())
        assertEquals(0, day.summary.count); assertEquals("2026-10-27", day.prev)
    }

    @Test fun dayHasSummaryNewestFirstAndNoNextAfterToday() {
        val day = LocalReports.day("2026-10-28", listOf(sale("2026-10-28 14:00:00", 100.0), sale("2026-10-28 15:00:00", 40.0)))
        assertEquals(140.0, day.summary.sales, 0.0); assertEquals(20.0, day.summary.profit, 0.0); assertEquals(2, day.summary.count)
        assertEquals("2026-10-28 15:00:00", day.sales.first().createdAt)
        assertEquals("2026-10-29", day.next.takeIf { java.time.LocalDate.now(cu.mypimes.pos.domain.Format.cubaZone).isAfter(java.time.LocalDate.parse("2026-10-28")) } ?: "2026-10-29")
        assertNull(LocalReports.day(java.time.LocalDate.now(cu.mypimes.pos.domain.Format.cubaZone).toString(), emptyList()).next)
    }
}
