package cu.mypimes.pos.data.auth

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.inject.Inject
import javax.inject.Singleton

/** Encrypts the bearer token with an AES-256 key held by Android Keystore. */
@Singleton
class SecureSessionStore @Inject constructor(@ApplicationContext context: Context) {
    private val prefs = context.getSharedPreferences("secure_session", Context.MODE_PRIVATE)
    private val shared = context.getSharedPreferences("secure_shared_device", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }

    @Synchronized
    fun read(): Session? {
        val iv = prefs.getString(KEY_IV, null) ?: return null
        val encrypted = prefs.getString(KEY_TOKEN, null) ?: return null
        val userJson = prefs.getString(KEY_USER, null) ?: return null
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(128, decode(iv)))
            val token = String(cipher.doFinal(decode(encrypted)), Charsets.UTF_8)
            val user = json.decodeFromString(ApiUserStorage.serializer(), userJson).toApiUser()
            if (accountKeyFromToken(token, expectedAccountId = user.id) == null) {
                clear()
                return null
            }
            Session(token, user)
        } catch (_: Exception) {
            clear()
            null
        }
    }

    @Synchronized
    fun write(session: Session) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val encrypted = encode(cipher.doFinal(session.token.toByteArray(Charsets.UTF_8)))
        val userJson = json.encodeToString(ApiUserStorage.from(session.user))
        check(prefs.edit().putString(KEY_IV, encode(cipher.iv)).putString(KEY_TOKEN, encrypted)
            .putString(KEY_USER, userJson).commit()) { "No se pudo guardar la sesión" }
    }

    @Synchronized
    fun clear() {
        check(prefs.edit().clear().commit()) { "No se pudo cerrar la sesión de forma segura" }
    }

    /**
     * Caja compartida: JSON con los tokens de cada cajero y los verificadores de PIN, cifrado con
     * la misma llave del Keystore. Vive aparte de la sesión para que cerrar sesión no lo borre.
     */
    @Synchronized
    fun readShared(): String? {
        val iv = shared.getString(KEY_IV, null) ?: return null
        val encrypted = shared.getString(KEY_TOKEN, null) ?: return null
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(128, decode(iv)))
            String(cipher.doFinal(decode(encrypted)), Charsets.UTF_8)
        } catch (_: Exception) {
            null // No se borra: puede ser un fallo transitorio del Keystore y aquí hay recibos pendientes.
        }
    }

    @Synchronized
    fun writeShared(value: String) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val encrypted = encode(cipher.doFinal(value.toByteArray(Charsets.UTF_8)))
        check(shared.edit().putString(KEY_IV, encode(cipher.iv)).putString(KEY_TOKEN, encrypted).commit()) {
            "No se pudo guardar la caja compartida"
        }
    }

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(KeyGenParameterSpec.Builder(KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build())
        return generator.generateKey()
    }

    @kotlinx.serialization.Serializable
    private data class ApiUserStorage(
        val id: Int,
        val email: String,
        val businessName: String?,
        val role: String?,
        val isAdmin: Boolean,
        val transferLimit: Double? = null,
        val usdRate: Double? = null,
        val eurRate: Double? = null,
        val warehouseEnabled: Boolean = true,
        val plan: String? = null,
        val cashierDayBreakdown: Boolean = false,
        val planStatus: String = "active",
        val trialDaysLeft: Int? = null,
        val locked: Boolean = false,
    ) {
        fun toApiUser() = ApiUser(
            id = id, email = email, name = null, businessName = businessName, role = role,
            isAdmin = isAdmin, transferLimit = transferLimit, usdRate = usdRate, eurRate = eurRate,
            warehouseEnabled = warehouseEnabled, plan = plan, cashierDayBreakdown = cashierDayBreakdown,
            planStatus = planStatus, trialDaysLeft = trialDaysLeft, locked = locked,
        )
        companion object {
            fun from(user: ApiUser) = ApiUserStorage(
                user.id, user.email, user.businessName, user.role, user.isAdmin,
                user.transferLimit, user.usdRate, user.eurRate, user.warehouseEnabled,
                user.plan, user.cashierDayBreakdown, user.planStatus, user.trialDaysLeft, user.locked,
            )
        }
    }

    private fun encode(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.NO_WRAP)
    private fun decode(value: String) = Base64.decode(value, Base64.NO_WRAP)

    private companion object {
        const val KEYSTORE = "AndroidKeyStore"
        const val KEY_ALIAS = "mypimes_session_aes_gcm_v1"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val KEY_IV = "token_iv"
        const val KEY_TOKEN = "token_ciphertext"
        const val KEY_USER = "user"
    }
}
