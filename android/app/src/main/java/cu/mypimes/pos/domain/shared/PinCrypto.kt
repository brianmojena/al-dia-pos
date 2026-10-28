package cu.mypimes.pos.domain.shared

import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec
import kotlinx.serialization.Serializable

/** Verificador de PIN guardado: nunca el PIN en claro. */
@Serializable
data class StoredPin(val salt: String, val hash: String, val iterations: Int)

/**
 * Port exacto de `derivePin` y `hashPin` de `client/src/lib/sharedDevice.js`:
 * PBKDF2-HMAC-SHA256, sal en hexadecimal, 210000 vueltas, 256 bits, salida en hexadecimal.
 */
object PinCrypto {
    const val ITERATIONS = 210_000
    private val PIN = Regex("^\\d{6}$")
    private val HEX = Regex("^(?:[a-f0-9]{2})+$")

    private val OWNER_PIN = Regex("^\\d{8}$")

    fun isValidPin(pin: String?) = pin != null && PIN.matches(pin)

    /** El dueño de una caja central usa 8 dígitos; los cajeros siguen en 6. */
    fun isValidOwnerPin(pin: String?) = pin != null && OWNER_PIN.matches(pin)

    fun derive(pin: String, saltHex: String, iterations: Int = ITERATIONS): String {
        require(HEX.matches(saltHex)) { "Acceso local dañado. Contacta al administrador." }
        val spec = PBEKeySpec(pin.toCharArray(), hexToBytes(saltHex), iterations, 256)
        try {
            return bytesToHex(SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded)
        } finally {
            spec.clearPassword()
        }
    }

    fun hashPin(pin: String, random: SecureRandom = SecureRandom()): StoredPin {
        require(isValidPin(pin)) { "Cada cajero necesita un PIN de 6 dígitos." }
        val salt = bytesToHex(ByteArray(16).also(random::nextBytes))
        return StoredPin(salt, derive(pin, salt), ITERATIONS)
    }

    /** Comparación en tiempo constante (la web usa un XOR acumulado por lo mismo). */
    fun equalHash(a: String, b: String) =
        MessageDigest.isEqual(a.toByteArray(Charsets.UTF_8), b.toByteArray(Charsets.UTF_8))

    fun isValidStored(pin: StoredPin?) = pin != null && HEX.matches(pin.salt) &&
        Regex("^[a-f0-9]{64}$").matches(pin.hash) && pin.iterations > 0

    private fun bytesToHex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }
    private fun hexToBytes(hex: String) = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}
