package cu.mypimes.pos.domain.shared

import cu.mypimes.pos.data.auth.ApiUserDto
import java.time.Instant
import java.util.Base64
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerialName
import kotlinx.serialization.json.Json

@Serializable
data class SharedDeviceInfo(
    val id: String,
    @SerialName("owner_id") val ownerId: Int,
    val name: String = "",
    val continuous: Boolean,
    @SerialName("expires_at") val expiresAt: String,
    /** Caja central: el dueño de la tienda es miembro (con PIN de 8 dígitos). */
    val central: Boolean = false,
)

/** Cajero tal como llega del servidor. `pin` solo viene al canjear el código de activación. */
@Serializable
data class SharedWireCashier(
    val id: Int,
    val email: String = "",
    @SerialName("display_name") val displayName: String? = null,
    val user: ApiUserDto,
    val token: String,
    val pin: StoredPin? = null,
    val role: String = SharedLogic.ROLE_CASHIER,
)

@Serializable
data class SharedBundle(val device: SharedDeviceInfo, val cashiers: List<SharedWireCashier>)

@Serializable
data class SharedMember(
    val id: Int,
    val email: String = "",
    val displayName: String? = null,
    val user: ApiUserDto,
    val token: String,
    val pin: StoredPin,
    val failures: Int = 0,
    val blockedUntil: Long = 0,
    val disabled: Boolean = false,
    val accessError: String? = null,
    /** Compatibilidad: los registros guardados antes de la caja central no traen rol y son cajeros. */
    val role: String = SharedLogic.ROLE_CASHIER,
    /** Rondas de bloqueo seguidas sin acierto (solo el dueño: el bloqueo crece con ellas). */
    val lockRounds: Int = 0,
) {
    val isOwner: Boolean get() = role == SharedLogic.ROLE_OWNER
    val label: String get() = displayName?.takeIf { it.isNotBlank() } ?: email
}

/** Lo único persistido de la caja compartida (cifrado). Sin PIN en claro, solo verificadores. */
@Serializable
data class SharedEnrollment(
    val device: SharedDeviceInfo,
    val cashiers: List<SharedMember>,
    val blocked: String = "",
    val lastAccountId: Int? = null,
) {
    val activeMembers: List<SharedMember> get() = cashiers.filter { !it.disabled }
    val isCentral: Boolean get() = device.central
}

class SharedException(message: String) : Exception(message)

sealed interface UnlockResult {
    data class Ok(val record: SharedEnrollment, val member: SharedMember) : UnlockResult
    /** El intento fallido se persiste (contador de fallos), así que se devuelve el registro nuevo. */
    data class Failed(val record: SharedEnrollment, val message: String) : UnlockResult
}

/** Port de la lógica pura de `client/src/lib/sharedDevice.js`. */
object SharedLogic {
    const val MAX_FAILURES = 5
    const val LOCK_MS = 60_000L
    const val ROLE_CASHIER = "cajero"
    const val ROLE_OWNER = "dueño"
    const val OWNER_PIN_LENGTH = 8
    /** Bloqueo del dueño tras sucesivas rondas de 5 fallos: 60 s, 5 min, 1 h (la última se repite). */
    val OWNER_LOCKS_MS = longArrayOf(60_000L, 300_000L, 3_600_000L)
    private const val TOO_MANY = "Demasiados intentos. Espera un minuto y vuelve a intentar."
    const val REVOKED = "El acceso de esta caja fue retirado. Contacta al administrador; los cambios pendientes siguen guardados."

    data class Claims(
        val userId: Long?, val accountId: Long?, val role: String?, val deviceId: String?, val exp: Long?,
        val deviceMode: String? = null,
    )

    @Serializable
    private data class RawClaims(
        val userId: Long? = null, val accountId: Long? = null, val role: String? = null,
        val deviceId: String? = null, val exp: Long? = null, val deviceMode: String? = null,
    )

    fun claims(token: String): Claims? = runCatching {
        val part = token.split('.')[1]
        val raw = Json { ignoreUnknownKeys = true }.decodeFromString<RawClaims>(
            String(Base64.getUrlDecoder().decode(part), Charsets.UTF_8),
        )
        Claims(raw.userId, raw.accountId, raw.role, raw.deviceId, raw.exp, raw.deviceMode)
    }.getOrNull()

    /** Misma id de caja que `registerOf` del servidor: continua = una para todos; por turno = una por cajero. */
    fun registerOf(device: SharedDeviceInfo, accountId: Int) =
        "shared:${device.id}${if (device.continuous || device.central) "" else ":$accountId"}"

    /**
     * Caja central: catálogo y stock comparten una sola clave para todas las personas del aparato (la cola y las
     * ventas siguen por persona). Fuera del modo central, o con una cuenta de otra tienda, es la clave de la cuenta.
     */
    fun catalogKey(device: SharedDeviceInfo?, accountKey: String): String =
        if (device?.central == true && accountKey.substringBefore(':') == device.ownerId.toString()) "central:${device.id}" else accountKey

    fun validate(bundle: SharedBundle, nowMs: Long) {
        val (device, cashiers) = bundle
        if (device.id.isBlank() || device.ownerId <= 0 || cashiers.isEmpty() ||
            runCatching { Instant.parse(device.expiresAt) }.isFailure
        ) throw SharedException("La configuración de la caja no es válida.")
        val ids = HashSet<Int>()
        for (member in cashiers) {
            val c = claims(member.token)
            // El token de dueño solo vale en caja central y para el dueño de la tienda del aparato.
            val roleOk = if (member.role == ROLE_OWNER) {
                device.central && device.continuous && c?.role == ROLE_OWNER && c.deviceMode == "central" &&
                    member.id == device.ownerId && member.user.role == ROLE_OWNER && cashiers.count { it.role == ROLE_OWNER } == 1
            } else {
                member.role == ROLE_CASHIER && c?.role == ROLE_CASHIER && member.user.role == ROLE_CASHIER
            }
            if (!ids.add(member.id) || c?.deviceId != device.id || c.userId != device.ownerId.toLong() ||
                c.accountId != member.id.toLong() || !roleOk || member.user.id != member.id ||
                member.user.isAdmin || c.exp == null || c.exp * 1000 <= nowMs
            ) throw SharedException("Los accesos recibidos no corresponden a esta caja o han vencido.")
        }
    }

    /** Activación remota: cada cajero debe traer su PIN ya cifrado; aquí nadie teclea PIN. */
    fun install(bundle: SharedBundle, nowMs: Long): SharedEnrollment {
        validate(bundle, nowMs)
        val members = bundle.cashiers.map { c ->
            if (!PinCrypto.isValidStored(c.pin)) throw SharedException(
                if (c.role == ROLE_OWNER) "El dueño necesita un PIN de 8 dígitos." else "Cada cajero necesita un PIN de 6 dígitos.",
            )
            SharedMember(c.id, c.email, c.displayName, c.user, c.token, c.pin!!, role = c.role)
        }
        return SharedEnrollment(bundle.device, members)
    }

    fun refresh(record: SharedEnrollment, bundle: SharedBundle, nowMs: Long): SharedEnrollment {
        validate(bundle, nowMs)
        if (record.device.id != bundle.device.id || record.device.ownerId != bundle.device.ownerId ||
            record.device.continuous != bundle.device.continuous || record.device.central != bundle.device.central
        ) throw SharedException("La renovación no corresponde a la caja instalada.")
        val incoming = bundle.cashiers.associateBy { it.id }
        val members = record.cashiers.map { old ->
            val c = incoming[old.id]
            // Se conserva el PIN guardado; la renovación no lo trae.
            if (c != null) old.copy(email = c.email, displayName = c.displayName, user = c.user, token = c.token,
                disabled = false, accessError = null)
            else old.copy(disabled = true)
        }
        return record.copy(blocked = "", device = bundle.device, cashiers = members)
    }

    private fun ownerLockMessage(remainingMs: Long) = when {
        remainingMs > 300_000L -> "Demasiados intentos. Espera una hora y vuelve a intentar."
        remainingMs > 60_000L -> "Demasiados intentos. Espera 5 minutos y vuelve a intentar."
        else -> TOO_MANY
    }

    fun isExpired(record: SharedEnrollment, nowMs: Long) =
        record.blocked.isNotEmpty() || Instant.parse(record.device.expiresAt).toEpochMilli() <= nowMs

    fun block(record: SharedEnrollment, reason: String = REVOKED) = record.copy(blocked = reason)

    fun disable(record: SharedEnrollment, accountId: Int, reason: String?) = record.copy(
        cashiers = record.cashiers.map {
            if (it.id == accountId) it.copy(disabled = true, accessError = reason ?: "El acceso de este cajero fue retirado.") else it
        },
    )

    fun unlock(
        record: SharedEnrollment, id: Int, pin: String, nowMs: Long,
        derive: (String, String, Int) -> String = PinCrypto::derive,
    ): UnlockResult {
        if (isExpired(record, nowMs)) throw SharedException(
            record.blocked.ifEmpty { "Los accesos de esta caja vencieron. Conéctate y contacta al administrador; los datos pendientes siguen guardados." },
        )
        val member = record.cashiers.firstOrNull { it.id == id && !it.disabled }
            ?: throw SharedException("Este cajero no está autorizado en esta caja.")
        if (member.blockedUntil > nowMs) throw SharedException(if (member.isOwner) ownerLockMessage(member.blockedUntil - nowMs) else TOO_MANY)
        val exp = claims(member.token)?.exp
        if (exp == null || exp * 1000 <= nowMs) throw SharedException("El acceso de este cajero venció. Conéctate para renovarlo.")
        val validPin = if (member.isOwner) PinCrypto.isValidOwnerPin(pin) else PinCrypto.isValidPin(pin)
        val actual = if (validPin) derive(pin, member.pin.salt, member.pin.iterations) else ""
        if (!PinCrypto.equalHash(actual, member.pin.hash)) {
            var failures = member.failures + 1
            var until = member.blockedUntil
            var rounds = member.lockRounds
            if (failures >= MAX_FAILURES) {
                failures = 0
                until = nowMs + if (member.isOwner) OWNER_LOCKS_MS[minOf(rounds, OWNER_LOCKS_MS.size - 1)] else LOCK_MS
                if (member.isOwner) rounds++
            }
            val next = record.copy(cashiers = record.cashiers.map {
                if (it.id == id) it.copy(failures = failures, blockedUntil = until, lockRounds = rounds) else it
            })
            val locked = if (member.isOwner) ownerLockMessage(until - nowMs) else TOO_MANY
            return UnlockResult.Failed(next, if (until > nowMs) locked else "PIN incorrecto.")
        }
        val ok = member.copy(failures = 0, blockedUntil = 0, lockRounds = 0)
        return UnlockResult.Ok(
            record.copy(lastAccountId = id, cashiers = record.cashiers.map { if (it.id == id) ok else it }),
            ok,
        )
    }
}
