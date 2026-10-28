package cu.mypimes.pos.data.auth

import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

@Singleton
class AuthRepository @Inject constructor(
    private val api: ApiService,
    private val sessionStore: SecureSessionStore,
) {
    private val mutableSession = MutableStateFlow(sessionStore.read())
    val session: StateFlow<Session?> = mutableSession.asStateFlow()

    suspend fun login(email: String, password: String) {
        val response = api.login(LoginRequest(email.trim(), password))
        if (!response.isSuccessful) throw apiError(response.code(), response.errorBody()?.string())
        adoptSession(response.body() ?: error("Respuesta de inicio de sesión vacía"))
    }

    /** Crea la tienda (queda con prueba de 7 días). El servidor devuelve la misma sesión que el login. */
    suspend fun register(storeName: String, email: String, password: String) {
        val response = api.register(RegisterRequest(storeName = storeName.trim(), email = email.trim(), password = password))
        if (!response.isSuccessful) throw apiError(response.code(), response.errorBody()?.string(), "No se pudo crear la cuenta")
        adoptSession(response.body() ?: error("Respuesta de registro vacía"))
    }

    /** Canjea el código que da administración por WhatsApp. No inicia sesión: el usuario entra después. */
    suspend fun resetPassword(email: String, code: String, newPassword: String) {
        val response = api.resetPassword(ResetPasswordRequest(email.trim(), code.trim(), newPassword))
        if (!response.isSuccessful) throw apiError(response.code(), response.errorBody()?.string(), "No se pudo cambiar la contraseña")
    }

    private fun adoptSession(body: LoginResponse) {
        require(body.token.isNotBlank()) { "El servidor no devolvió una sesión válida" }
        val user = body.user.toApiUser()
        val shopId = body.user.ownerId ?: user.id.takeIf { user.role == "dueño" }
        require(accountKeyFromToken(body.token, user.id, shopId) != null) {
            "La identidad de la cuenta no coincide con la sesión del servidor"
        }
        val session = Session(body.token, user)
        sessionStore.write(session)
        mutableSession.value = session
    }

    /** Tras guardar las tasas de la tienda, para que los cobros de esta sesión usen las nuevas. */
    fun updateShopRates(usd: Double?, eur: Double?) {
        val current = mutableSession.value ?: return
        val refreshed = current.copy(user = current.user.copy(usdRate = usd, eurRate = eur))
        sessionStore.write(refreshed)
        mutableSession.value = refreshed
    }

    /** Caja compartida: pone como sesión actual al cajero que acaba de entrar con su PIN. */
    fun adopt(session: Session) {
        require(accountKeyFromToken(session.token, session.user.id) != null) { "La identidad de la cuenta no coincide" }
        sessionStore.write(session)
        mutableSession.value = session
    }

    fun logout() {
        // Room data is account scoped and intentionally remains on this device.
        sessionStore.clear()
        mutableSession.value = null
    }

    /**
     * Refreshes shop settings (rates, transfer limit, warehouse flag) without
     * touching the token. Called quietly on start; a network failure keeps the
     * stored profile so the POS can still sell offline.
     */
    suspend fun refreshProfile() {
        val current = mutableSession.value ?: return
        val response = api.me()
        if (!response.isSuccessful) {
            if (response.code() == 401) {
                sessionStore.clear()
                mutableSession.value = null
            }
            return
        }
        val user = response.body()?.user?.toApiUser() ?: return
        val refreshed = current.copy(user = user)
        sessionStore.write(refreshed)
        mutableSession.value = refreshed
    }

    private fun apiError(status: Int, payload: String?, fallback: String = "No se pudo iniciar sesión"): Exception {
        val message = runCatching {
            kotlinx.serialization.json.Json { ignoreUnknownKeys = true }
                .decodeFromString<ApiErrorDto>(payload.orEmpty()).error
        }
            .getOrNull()
        return Exception(message ?: "$fallback ($status)")
    }
}
