package cu.mypimes.pos.data.store

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AccountingAuditDataTest {
    private val wire = Json { ignoreUnknownKeys = true }

    @Test
    fun auditReportDecodesNullableFieldsFromTheServer() {
        val report = wire.decodeFromString<AuditReportDto>(
            """
            {"id":7,"severity":"warning","headline":"Diferencia de caja","summary":"Faltan 120.",
             "findings":[{"probable_cause":"Vuelto mal dado","confidence":"media","evidence":["Cambio de 120"],"recommendation":null}],
             "signals":[{"title":"Vuelto","severity":"warning","amount":120.5,"currency":"CUP","evidence":"e"}],
             "questions":["¿Hubo cambio?"],"next_step":null,"status":"ok","model":null,
             "created_at":"2026-10-27 10:00:00","source_revision":2,
             "close":{"closed_at":"2026-10-27 09:00:00","difference":-120.5,"expected_cash":1000,"counted_cash":879.5,"cashier_email":"ana@x.cu"},
             "metrics":{"ignored":true}}
            """.trimIndent(),
        )
        assertEquals(7L, report.id)
        assertEquals("Vuelto mal dado", report.findings.single().probableCause)
        assertNull(report.findings.single().recommendation)
        assertEquals(-120.5, report.close!!.difference!!, 0.0)
        assertNull(report.nextStep)
    }

    @Test
    fun expenseAndSummaryDecodeWithVoidedRows() {
        val expense = wire.decodeFromString<ExpenseDto>(
            """{"id":3,"client_expense_id":"abc","method":"USD","amount":5.5,"concept":"Bolsas",
               "account_email":"dueno@x.cu","created_at":"2026-10-20 12:00:00","voided_at":"2026-10-21 08:00:00"}""",
        )
        assertEquals("abc", expense.clientExpenseId)
        assertEquals("2026-10-21 08:00:00", expense.voidedAt)

        val summary = wire.decodeFromString<AccountingSummaryDto>(
            """{"month":"2026-10","totals":{"income":1000,"profit":400,"expenses_cup":150,"expenses_usd":0,"expenses_eur":0,"result_cup":250},
               "days":[{"date":"2026-10-20","income":1000,"profit":400,"expenses_cup":150,"result_cup":250}]}""",
        )
        assertEquals(250.0, summary.totals.resultCup, 0.0)
        assertEquals(0.0, summary.totals.incomeCash, 0.0)
        assertEquals("2026-10-20", summary.days.single().date)
    }
}
