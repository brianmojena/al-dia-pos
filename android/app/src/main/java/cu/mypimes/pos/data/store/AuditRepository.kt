package cu.mypimes.pos.data.store

import cu.mypimes.pos.data.auth.ApiErrorDto
import cu.mypimes.pos.data.auth.Session
import java.io.IOException
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

@Serializable
data class AuditFindingDto(
    @SerialName("probable_cause") val probableCause: String? = null,
    val confidence: String? = null,
    val evidence: List<String> = emptyList(),
    val recommendation: String? = null,
)

@Serializable
data class AuditSignalDto(
    val title: String? = null,
    val severity: String? = null,
    val amount: Double? = null,
    val currency: String? = null,
)

@Serializable
data class AuditCloseDto(
    @SerialName("closed_at") val closedAt: String? = null,
    val difference: Double? = null,
    @SerialName("expected_cash") val expectedCash: Double? = null,
    @SerialName("counted_cash") val countedCash: Double? = null,
    @SerialName("cashier_email") val cashierEmail: String? = null,
)

/** Informe de auditoría de un cierre (web: `Auditoria.jsx` + `AuditReportCard.jsx`). Solo lectura: la web no reconoce ni resuelve informes. */
@Serializable
data class AuditReportDto(
    val id: Long = 0,
    val severity: String? = null,
    val headline: String? = null,
    val summary: String? = null,
    val findings: List<AuditFindingDto> = emptyList(),
    val signals: List<AuditSignalDto> = emptyList(),
    val questions: List<String> = emptyList(),
    @SerialName("next_step") val nextStep: String? = null,
    val status: String? = null,
    val model: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("source_revision") val sourceRevision: Int = 0,
    val close: AuditCloseDto? = null,
)

@Singleton
class AuditRepository @Inject constructor(
    private val api: StoreApi,
    private val json: Json,
) {
    /** `severity` null = todos. El servidor limita a 50 por defecto, igual que la web. */
    suspend fun reports(session: Session, severity: String?): List<AuditReportDto> {
        val response = try { api.auditReports("Bearer ${session.token}", severity) } catch (_: IOException) {
            throw IOException("Sin conexión con el servidor.")
        }
        if (!response.isSuccessful) {
            val message = response.errorBody()?.string()?.let { runCatching { json.decodeFromString<ApiErrorDto>(it).error }.getOrNull() }
            throw IOException(message?.takeIf { it.isNotBlank() } ?: "No se pudieron cargar los informes.")
        }
        return response.body() ?: throw IOException("No se pudieron cargar los informes.")
    }
}
