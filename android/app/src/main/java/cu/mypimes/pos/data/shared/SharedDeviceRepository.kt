package cu.mypimes.pos.data.shared

import cu.mypimes.pos.data.auth.ApiErrorDto
import cu.mypimes.pos.data.auth.AuthRepository
import cu.mypimes.pos.data.auth.SecureSessionStore
import cu.mypimes.pos.data.auth.Session
import cu.mypimes.pos.data.local.LocalDao
import cu.mypimes.pos.domain.shared.OwnerReauth
import cu.mypimes.pos.domain.shared.SharedEnrollment
import cu.mypimes.pos.domain.shared.SharedException
import cu.mypimes.pos.domain.shared.SharedLogic
import cu.mypimes.pos.domain.shared.UnlockResult
import java.io.IOException
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/**
 * Caja compartida: varios cajeros en un aparato, cada uno con su PIN y su propio token de servidor.
 * El PIN solo protege el uso diario en este aparato; la autorización real la firma el servidor.
 */
@Singleton
class SharedDeviceRepository @Inject constructor(
    private val api: SharedApi,
    private val store: SecureSessionStore,
    private val auth: AuthRepository,
    private val dao: LocalDao,
    private val json: Json,
) {
    private val mutex = Mutex()
    private val _enrollment = MutableStateFlow(load())
    val enrollment: StateFlow<SharedEnrollment?> = _enrollment.asStateFlow()

    /** Cada arranque de la app pide PIN, igual que la web. */
    private val _locked = MutableStateFlow(true)
    val locked: StateFlow<Boolean> = _locked.asStateFlow()

    @Volatile private var cartPending = false
    private val reauth = OwnerReauth()

    private fun load(): SharedEnrollment? =
        store.readShared()?.let { runCatching { json.decodeFromString<SharedEnrollment>(it) }.getOrNull() }

    private fun save(record: SharedEnrollment) {
        store.writeShared(json.encodeToString(record))
        _enrollment.value = record
    }

    /** El código se dicta con espacios o guiones: se limpia igual que el servidor. */
    fun cleanCode(value: String) = value.uppercase().filter { it in '0'..'9' || it in 'A'..'Z' }.take(12)

    suspend fun activate(rawCode: String) = mutex.withLock {
        val code = cleanCode(rawCode)
        if (code.length != 12) throw SharedException("El código de activación tiene 12 caracteres.")
        // Antes de canjear: el código es de un solo uso y no debe gastarse si hay datos pendientes.
        if (dao.countUnresolved() > 0) {
            throw SharedException("Sincroniza todos los cambios pendientes de este dispositivo antes de configurarlo. Los datos se conservan.")
        }
        val response = try {
            api.activate(ActivateRequest(code))
        } catch (_: IOException) {
            throw SharedException("Sin conexión con el servidor. El código no se gastó; inténtalo de nuevo con internet.")
        }
        if (!response.isSuccessful) throw SharedException(errorOf(response.errorBody()?.string()) ?: "No se pudo activar la caja.")
        val bundle = response.body() ?: throw SharedException("No se pudo activar la caja.")
        try {
            save(SharedLogic.install(bundle, System.currentTimeMillis()))
        } catch (error: Exception) {
            throw SharedException("El código ya se usó, pero este aparato no pudo guardar la caja: ${error.message} Pide un código nuevo al administrador.")
        }
        // Sin cola pendiente (comprobado arriba), así que cerrar la sesión anterior no pierde nada.
        auth.logout()
        cartPending = false
        _locked.value = true
    }

    suspend fun unlock(id: Int, pin: String) = mutex.withLock {
        val record = _enrollment.value ?: throw SharedException("Este dispositivo todavía no está configurado.")
        val prior = record.lastAccountId
        if (cartPending && prior != null && prior != id) {
            throw SharedException("Cobra o vacía el carrito antes de cambiar de cajero. Puedes volver a entrar con el PIN del cajero anterior.")
        }
        // PBKDF2 con 210000 vueltas: fuera del hilo principal.
        when (val result = withContext(Dispatchers.Default) { SharedLogic.unlock(record, id, pin, System.currentTimeMillis()) }) {
            is UnlockResult.Failed -> {
                save(result.record)
                throw SharedException(result.message)
            }
            is UnlockResult.Ok -> {
                save(result.record)
                auth.adopt(Session(result.member.token, result.member.user.toApiUser()))
                cartPending = false
                reauth.close()
                _locked.value = false
            }
        }
    }

    /** Modo de caja centralizada: el aparato es central y la sesión es la del dueño. Solo entonces sus escrituras van a la cola. */
    fun isCentralOwner(session: Session): Boolean =
        _enrollment.value?.isCentral == true && SharedLogic.claims(session.token)?.role == SharedLogic.ROLE_OWNER

    /** Clave del catálogo y el stock: una sola para todo el aparato en modo central (ver `SharedLogic.catalogKey`). */
    fun catalogKey(accountKey: String) = SharedLogic.catalogKey(_enrollment.value?.device, accountKey)

    /** Caja central con el dueño como sesión actual: sus acciones destructivas piden el PIN otra vez. */
    fun ownerGuardActive(): Boolean {
        val record = _enrollment.value?.takeIf { it.isCentral } ?: return false
        val accountId = auth.session.value?.token?.let { SharedLogic.claims(it)?.accountId } ?: return false
        return record.cashiers.any { it.isOwner && it.id.toLong() == accountId }
    }

    /** Falta el PIN si el guardia está activo y la ventana de gracia (2 min) ya se cerró. */
    fun needsOwnerPin() = ownerGuardActive() && !reauth.isOpen(System.currentTimeMillis())

    /** Revalida el PIN del dueño (mismos fallos y bloqueo creciente que al entrar) sin cambiar de sesión. */
    suspend fun verifyOwnerPin(pin: String) = mutex.withLock {
        val record = _enrollment.value ?: throw SharedException("Este dispositivo todavía no está configurado.")
        val owner = record.cashiers.firstOrNull { it.isOwner && !it.disabled } ?: throw SharedException("El dueño no está autorizado en esta caja.")
        when (val result = withContext(Dispatchers.Default) { SharedLogic.unlock(record, owner.id, pin, System.currentTimeMillis()) }) {
            is UnlockResult.Failed -> { save(result.record); throw SharedException(result.message) }
            is UnlockResult.Ok -> { save(result.record); reauth.open(System.currentTimeMillis()) }
        }
    }

    /** Bloquear no borra ni sube nada. Con carrito abierto solo puede volver a entrar el mismo cajero. */
    fun lock(hasCart: Boolean) {
        cartPending = hasCart
        reauth.close()
        _locked.value = true
    }

    /**
     * Renueva en lote los accesos (30 días): una sola llamada reemite los tokens del dueño y de todos
     * los cajeros, y el servidor acepta cualquiera. Sirve con la pantalla de PIN puesta. Sin red no hace nada.
     * Si el servidor retira el aparato o al miembro, solo se bloquea: la cola y los datos locales quedan.
     */
    suspend fun renew() = mutex.withLock {
        val record = _enrollment.value ?: return@withLock
        val now = System.currentTimeMillis()
        val sessionToken = auth.session.value?.token?.takeIf { SharedLogic.claims(it)?.deviceId == record.device.id }
        val token = sessionToken ?: record.activeMembers.firstOrNull { (SharedLogic.claims(it.token)?.exp ?: 0) * 1000 > now }?.token
            ?: return@withLock
        val claims = SharedLogic.claims(token) ?: return@withLock
        val response = try { api.renew("Bearer $token") } catch (_: IOException) { return@withLock }
        if (response.isSuccessful) {
            val bundle = response.body() ?: return@withLock
            val next = runCatching { SharedLogic.refresh(record, bundle, now) }.getOrNull() ?: return@withLock
            save(next)
            if (sessionToken != null) {
                val current = next.cashiers.firstOrNull { it.id.toLong() == claims.accountId && !it.disabled }
                if (current != null) auth.adopt(Session(current.token, current.user.toApiUser())) else _locked.value = true
            }
            return@withLock
        }
        val code = runCatching { json.decodeFromString<ApiErrorDto>(response.errorBody()?.string().orEmpty()).code }.getOrNull()
        when {
            response.code() == 403 && code == "DEVICE_REVOKED" -> { save(SharedLogic.block(record)); _locked.value = true }
            response.code() == 403 && code == "MEMBER_REVOKED" -> {
                claims.accountId?.let { save(SharedLogic.disable(record, it.toInt(), null)) }
                if (sessionToken != null) _locked.value = true
            }
        }
    }

    /** Credencial original de un cajero, para subir sus operaciones aunque atienda otro. */
    fun credentialFor(accountKey: String): Session? {
        val record = _enrollment.value ?: return null
        val (shop, account) = accountKey.split(':').takeIf { it.size == 2 } ?: return null
        if (shop.toIntOrNull() != record.device.ownerId) return null
        val member = record.cashiers.firstOrNull { it.id == account.toIntOrNull() } ?: return null
        return Session(member.token, member.user.toApiUser())
    }

    /** Id de caja del servidor para la sesión actual si es de la caja compartida; si no, null. */
    fun registerIdForCurrent(): String? {
        val record = _enrollment.value ?: return null
        val token = auth.session.value?.token ?: return null
        val claims = SharedLogic.claims(token) ?: return null
        if (claims.deviceId != record.device.id) return null
        return SharedLogic.registerOf(record.device, claims.accountId?.toInt() ?: return null)
    }

    private fun errorOf(body: String?) =
        body?.let { runCatching { json.decodeFromString<ApiErrorDto>(it).error }.getOrNull() }?.takeIf { it.isNotBlank() }
}
