package cu.mypimes.pos.data.store

import cu.mypimes.pos.data.auth.ApiErrorDto
import cu.mypimes.pos.data.auth.Session
import java.io.IOException
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import retrofit2.Response

@Serializable
data class CashierDto(
    val id: Int,
    val email: String,
    val role: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
)

@Serializable
data class CreateCashierRequest(val email: String, val password: String)

/**
 * Gestión de cajeros (solo dueño; el servidor lo exige con `requireOwner`). Solo en línea, como la web.
 * Crear no lleva id de cliente: repetirlo tras un corte falla con 409 "ya existe", sin duplicar la cuenta.
 * Quitar es idempotente (repetirlo da 404).
 */
@Singleton
class CashiersRepository @Inject constructor(
    private val api: StoreApi,
    private val json: Json,
) {
    suspend fun list(session: Session): List<CashierDto> =
        call("No se pudo cargar la lista de cajeros.") { api.cashiers(auth(session)) }

    suspend fun create(session: Session, email: String, password: String): CashierDto =
        call("No se pudo crear el cajero.", "Conéctate a internet para crear cuentas de cajeros.") {
            api.createCashier(auth(session), CreateCashierRequest(email.trim(), password))
        }

    suspend fun remove(session: Session, id: Int) {
        call("No se pudo quitar el acceso.", "Conéctate a internet para quitar el acceso de cajeros.") {
            api.deleteCashier(auth(session), id)
        }
    }

    private suspend fun <T> call(fallback: String, offline: String = "Sin conexión con el servidor.", block: suspend () -> Response<T>): T {
        val response = try { block() } catch (_: IOException) { throw IOException(offline) }
        if (!response.isSuccessful) {
            val message = response.errorBody()?.string()?.let { runCatching { json.decodeFromString<ApiErrorDto>(it).error }.getOrNull() }
            throw IOException(message?.takeIf { it.isNotBlank() } ?: fallback)
        }
        return response.body() ?: throw IOException(fallback)
    }

    private fun auth(session: Session) = "Bearer ${session.token}"
}
