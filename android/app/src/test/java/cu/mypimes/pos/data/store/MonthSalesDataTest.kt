package cu.mypimes.pos.data.store

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Test

class MonthSalesDataTest {
    @Test
    fun decodesMonthSummaryFromServerIgnoringFieldsTheViewDoesNotUse() {
        val dto = Json { ignoreUnknownKeys = true }.decodeFromString<MonthDaysDto>(
            """{"month":"2026-10","totals":{"sales_count":3,"off_rate_count":0,"total":1500.5,"cash_total":1000,"transfer_total":0,"foreign_total":500.5,"usd_total":0,"eur_total":0,"profit":300},"days":[{"date":"2026-10-03","sales_count":3,"total":1500.5,"cash_total":1000,"transfer_total":0,"foreign_total":500.5,"profit":300,"stock_moves":2,"closes":null}]}""",
        )
        assertEquals("2026-10", dto.month)
        assertEquals(3, dto.totals.salesCount)
        assertEquals(1500.5, dto.totals.total, 0.001)
        assertEquals(1000.0, dto.totals.cashTotal, 0.001)
        assertEquals("2026-10-03", dto.days.single().date)
        assertEquals(3, dto.days.single().salesCount)
    }
}
