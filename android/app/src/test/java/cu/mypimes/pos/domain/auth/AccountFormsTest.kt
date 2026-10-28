package cu.mypimes.pos.domain.auth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AccountFormsTest {
    @Test
    fun planesDesconocidosSeTratanComoBasic() {
        assertEquals("Basic", Plans.label("premium"))
        assertEquals("Basic", Plans.label(null))
        assertEquals("Enterprise", Plans.label("enterprise"))
        assertEquals(5, Plans.maxUsers("dev"))
        assertEquals(10, Plans.maxUsers("enterprise"))
    }

    @Test
    fun codigoSoloAlfanumericoEnMayusculas() {
        assertEquals("AB12CD", AccountForms.normalizeCode(" ab-12 cd!"))
    }

    @Test
    fun registroValidaEnElMismoOrdenQueLaWeb() {
        assertEquals("Las contraseñas no coinciden", AccountForms.validateRegister("Tienda", "a@b.cu", "123456", "123457"))
        assertEquals("La contraseña debe tener al menos 6 caracteres", AccountForms.validateRegister("Tienda", "a@b.cu", "12345", "12345"))
        assertEquals("Escribe el nombre de tu tienda", AccountForms.validateRegister(" ", "a@b.cu", "123456", "123456"))
        assertNull(AccountForms.validateRegister("Tienda", "a@b.cu", "123456", "123456"))
    }

    @Test
    fun recuperacionPideCorreoYCodigoAntesDeLasContrasenas() {
        assertEquals("Por favor ingresa el código", AccountForms.validateReset("a@b.cu", "", "x", "y"))
        assertEquals("Las contraseñas no coinciden", AccountForms.validateReset("a@b.cu", "ABC", "123456", "654321"))
        assertNull(AccountForms.validateReset("a@b.cu", "ABC123", "123456", "123456"))
    }
}
