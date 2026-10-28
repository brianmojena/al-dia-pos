package cu.mypimes.pos.domain.cashiers

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CashiersTest {
    @Test
    fun seatLimitCountsTheOwnerAndUnknownPlansFallBackToBasic() {
        assertEquals(5, Plans.maxUsers(null))
        assertEquals(5, Plans.maxUsers("premium"))
        assertEquals(10, Plans.maxUsers("enterprise"))
        assertEquals("Basic", Plans.label("dev"))
        assertFalse(atSeatLimit("basic", 3))
        assertTrue(atSeatLimit("basic", 4))
        assertTrue(atSeatLimit("enterprise", 9))
    }

    @Test
    fun formRulesMatchTheServer() {
        assertEquals("Email y contraseña son requeridos", cashierFormError("", "abcdef"))
        assertEquals("La contraseña debe tener al menos 6 caracteres", cashierFormError("a@b.cu", "12345"))
        assertNull(cashierFormError("cajero@mitienda.cu", "123456"))
    }
}
