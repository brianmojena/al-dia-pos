package cu.mypimes.pos.domain.shared

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class PinCryptoTest {
    @Test
    fun matchesTheWebDerivation() {
        // Vector calculado con PBKDF2-HMAC-SHA256 de Node (crypto.pbkdf2Sync), igual que crypto.subtle en la web.
        assertEquals(
            "53e4107d602dab1f28023566252fa14d98a72a96a547da4bc64a80b32e087164",
            PinCrypto.derive("123456", "00112233445566778899aabbccddeeff", 210_000),
        )
    }

    @Test
    fun hashPinUsesRandomSaltAndNeverStoresThePin() {
        val a = PinCrypto.hashPin("123456")
        val b = PinCrypto.hashPin("123456")
        assertEquals(210_000, a.iterations)
        assertEquals(32, a.salt.length)
        assertEquals(64, a.hash.length)
        assertNotEquals(a.salt, b.salt)
        assertNotEquals(a.hash, b.hash)
        assertFalse(a.salt.contains("123456") || a.hash.contains("123456"))
        assertEquals(a.hash, PinCrypto.derive("123456", a.salt, a.iterations))
        assertTrue(PinCrypto.isValidStored(a))
    }

    @Test
    fun rejectsPinsThatAreNotSixDigits() {
        listOf("12345", "1234567", "12345a", "").forEach {
            try { PinCrypto.hashPin(it); fail("aceptó $it") } catch (e: IllegalArgumentException) {
                assertEquals("Cada cajero necesita un PIN de 6 dígitos.", e.message)
            }
        }
    }

    @Test
    fun equalHashComparesWholeStrings() {
        assertTrue(PinCrypto.equalHash("abc", "abc"))
        assertFalse(PinCrypto.equalHash("abc", "abd"))
        assertFalse(PinCrypto.equalHash("abc", "ab"))
    }
}
