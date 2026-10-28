package cu.mypimes.pos.data.store

import cu.mypimes.pos.data.auth.ApiErrorDto
import cu.mypimes.pos.data.auth.Session
import cu.mypimes.pos.data.auth.accountKeyFromToken
import cu.mypimes.pos.data.local.LocalDao
import cu.mypimes.pos.data.local.LocalDatabase
import cu.mypimes.pos.data.local.OfflineException
import cu.mypimes.pos.data.local.SaleEntity
import cu.mypimes.pos.data.local.SaleIndex
import cu.mypimes.pos.data.local.Served
import cu.mypimes.pos.data.sync.ChangesCursors
import cu.mypimes.pos.domain.pos.PosSale
import cu.mypimes.pos.domain.sales.LocalReports
import java.time.LocalDate
import java.time.YearMonth
import kotlinx.serialization.decodeFromString
import cu.mypimes.pos.domain.outbox.Outbox
import java.io.IOException
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import retrofit2.Response

/** Cómo estaba (o quedó) el cobro de una venta en una corrección. */
@Serializable
data class PaymentSnapshotDto(
    @SerialName("payment_method") val paymentMethod: String? = null,
    @SerialName("foreign_currency") val foreignCurrency: String? = null,
    val total: Double? = null,
    @SerialName("created_at") val createdAt: String? = null,
)

@Serializable
data class CloseSnapshotDto(val difference: Double? = null)

@Serializable
data class SaleCorrectionDto(
    val id: Long = 0,
    @SerialName("sale_id") val saleId: Long? = null,
    val action: String = "",
    val before: PaymentSnapshotDto? = null,
    val after: PaymentSnapshotDto? = null,
    @SerialName("close_before") val closeBefore: CloseSnapshotDto? = null,
    @SerialName("close_after") val closeAfter: CloseSnapshotDto? = null,
    val reason: String? = null,
    @SerialName("account_email") val accountEmail: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
)

/** `action` es «pago» o «anular»; los campos de cobro solo viajan en «pago» (el servidor recalcula todo lo demás). */
@Serializable
data class CorrectSaleRequest(
    val action: String,
    val reason: String? = null,
    @SerialName("payment_method") val paymentMethod: String? = null,
    @SerialName("transfer_amount") val transferAmount: Double? = null,
    @SerialName("foreign_currency") val foreignCurrency: String? = null,
    @SerialName("foreign_amount") val foreignAmount: Double? = null,
    @SerialName("exchange_rate") val exchangeRate: Double? = null,
)

@Serializable
data class CorrectSaleResponse(val correction: SaleCorrectionDto? = null, @kotlinx.serialization.Transient val queued: Boolean = false)

/**
 * Ventas del dueño por día y su corrección (web: `Sales.jsx` + `SaleCorrection.jsx`).
 * Solo en línea, como la web: la corrección se aplica en el servidor, que recalcula el cierre de caja y el stock.
 * No usa la cola: repetir una corrección no duplica nada (cambiar al mismo cobro da 400 y anular dos veces da 404).
 */
@Singleton
class SalesRepository @Inject constructor(
    private val api: StoreApi,
    private val json: Json,
    private val database: LocalDatabase,
    private val dao: LocalDao,
    private val outbox: OwnerOutbox,
) {
    /** Con red manda el servidor; sin red se arma con las ventas guardadas (hasta 90 días) y dice desde cuándo son. */
    suspend fun day(session: Session, date: String): Served<DailyActivityDto> = try {
        Served(call("No se pudieron cargar las ventas del día.") { api.activityDay(auth(session), date) })
    } catch (offline: OfflineException) {
        val key = localKey(session, offline)
        val day = LocalDate.parse(date)
        val sales = dao.reportableSales(key, date, day.plusDays(1).toString()).mapNotNull(::decode).map(LocalReports::saleDto)
        val saved = dao.getCacheRecord(key, StoreRepository.KIND_ACTIVITY, date)
            ?.let { runCatching { json.decodeFromString<DailyActivityDto>(it.payload) }.getOrNull() }
        val base = LocalReports.day(date, sales)
        Served(
            if (saved == null) base else base.copy(transfers = saved.transfers, purchases = saved.purchases, withdrawals = saved.withdrawals, cashCloses = saved.cashCloses),
            lastSync(key) ?: throw offline,
        )
    }

    suspend fun month(session: Session, month: String): Served<MonthDaysDto> = try {
        Served(call("No se pudo cargar el resumen del mes.") { api.monthDays(auth(session), month) })
    } catch (offline: OfflineException) {
        val key = localKey(session, offline)
        val first = YearMonth.parse(month).atDay(1)
        val sales = dao.reportableSales(key, first.toString(), first.plusMonths(1).toString()).mapNotNull(::decode).map(LocalReports::saleDto)
        Served(LocalReports.month(month, sales), lastSync(key) ?: throw offline)
    }

    private suspend fun localKey(session: Session, offline: OfflineException): String {
        val key = accountKeyFromToken(session.token, session.user.id) ?: throw offline
        SaleIndex.ensureBuilt(database, key, json)
        return key
    }

    private suspend fun lastSync(key: String) = dao.getCursors(key).firstOrNull { it.cursorName == ChangesCursors.LAST_OK }?.value?.takeIf { it > 0 }

    private fun decode(row: SaleEntity) = runCatching { json.decodeFromString<PosSale>(row.payloadJson) }.getOrNull()

    suspend fun monthExcel(session: Session, month: String): ByteArray =
        call("No se pudo generar el archivo.", "Conéctate a internet para descargar el Excel.") {
            api.monthExcel(auth(session), month)
        }.bytes()

    suspend fun voidedOfDay(session: Session, date: String): List<SaleCorrectionDto> =
        call("No se pudieron cargar las ventas anuladas.") { api.saleCorrectionsOfDay(auth(session), date) }
            .filter { it.action == "anular" }

    suspend fun history(session: Session, saleId: Long): List<SaleCorrectionDto> =
        call("No se pudo cargar el historial de correcciones.") { api.saleCorrections(auth(session), saleId) }

    suspend fun correct(session: Session, saleId: Long, request: CorrectSaleRequest): CorrectSaleResponse {
        if (outbox.central(session)) {
            // Caja central: a la cola con operation_id estable; el servidor recalcula cierre y stock al recibirla.
            val operationId = java.util.UUID.randomUUID().toString()
            val body = json.parseToJsonElement(json.encodeToString(CorrectSaleRequest.serializer(), request)).jsonObject
            outbox.enqueue(session, Outbox.SALE_CORRECT, "POST", "/api/sales/$saleId/correct",
                kotlinx.serialization.json.JsonObject(body + ("operation_id" to kotlinx.serialization.json.JsonPrimitive(operationId))), operationId)
            return CorrectSaleResponse(queued = true)
        }
        return call("No se pudo corregir la venta.", "Para corregir ventas hace falta internet.") {
            api.correctSale(auth(session), saleId, request)
        }
    }

    private suspend fun <T> call(fallback: String, offline: String = "Sin conexión con el servidor.", block: suspend () -> Response<T>): T {
        val response = try { block() } catch (_: IOException) { throw OfflineException(offline) }
        if (!response.isSuccessful) {
            val message = response.errorBody()?.string()?.let { runCatching { json.decodeFromString<ApiErrorDto>(it).error }.getOrNull() }
            throw IOException(message?.takeIf { it.isNotBlank() } ?: fallback)
        }
        return response.body() ?: throw IOException(fallback)
    }

    private fun auth(session: Session) = "Bearer ${session.token}"
}
