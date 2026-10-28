package cu.mypimes.pos.domain.accounting

import java.time.YearMonth
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AccountingTest {
    @Test
    fun onlyEnterpriseOwnersSeeAccounting() {
        assertTrue(Accounting.available(isOwner = true, plan = "enterprise"))
        assertFalse(Accounting.available(isOwner = true, plan = "basic"))
        assertFalse(Accounting.available(isOwner = true, plan = "premium"))
        assertFalse(Accounting.available(isOwner = false, plan = "enterprise"))
    }

    @Test
    fun amountAcceptsCommaAndRejectsGarbage() {
        assertEquals(1.5, Accounting.parseAmount("1,5")!!, 0.0)
        assertEquals(12.0, Accounting.parseAmount(" 12 ")!!, 0.0)
        assertNull(Accounting.parseAmount("abc"))
        assertNull(Accounting.parseAmount("NaN"))
    }

    @Test
    fun expenseFormRulesMatchTheServer() {
        assertEquals("El monto debe ser mayor que 0.", Accounting.expenseError("", "Bolsas"))
        assertEquals("El monto debe ser mayor que 0.", Accounting.expenseError("0", "Bolsas"))
        // 0,004 se redondea a 0 centavos: el servidor lo rechazaría, así que la app también.
        assertEquals("El monto debe ser mayor que 0.", Accounting.expenseError("0,004", "Bolsas"))
        assertEquals("El concepto debe tener al menos 3 letras.", Accounting.expenseError("10", "  ab "))
        assertEquals("Escribe en qué se gastó (entre 3 y 200 caracteres).", Accounting.expenseError("10", "x".repeat(201)))
        assertNull(Accounting.expenseError("0,01", "Bolsas"))
    }

    @Test
    fun monthNavigationCrossesYearsAndStopsAtThisMonth() {
        assertEquals("2025-12", Accounting.shiftMonth("2026-01", -1))
        assertEquals("2027-01", Accounting.shiftMonth("2026-12", 1))
        val today = YearMonth.of(2026, 10)
        assertFalse(Accounting.canGoNext("2026-10", today))
        assertTrue(Accounting.canGoNext("2026-09", today))
    }

    @Test
    fun methodLabelsCoverTheFourApartados() {
        assertEquals(listOf("Efectivo", "Transferencia", "Dólares", "Euros"), Accounting.methods.map { Accounting.methodLabel(it) })
    }
}
