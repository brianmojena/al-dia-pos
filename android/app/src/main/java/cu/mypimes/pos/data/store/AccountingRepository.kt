package cu.mypimes.pos.data.store

import cu.mypimes.pos.data.auth.ApiErrorDto
import cu.mypimes.pos.data.auth.Session
import java.io.IOException
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.ResponseBody
import retrofit2.Response

@Serializable
data class ExpenseDto(
    val id: Long = 0,
    @SerialName("client_expense_id") val clientExpenseId: String = "",
    val method: String = "efectivo",
    val amount: Double = 0.0,
    val concept: String = "",
    @SerialName("account_email") val accountEmail: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("voided_at") val voidedAt: String? = null,
)

@Serializable
data class CreateExpenseRequest(
    @SerialName("client_expense_id") val clientExpenseId: String,
    val method: String,
    val amount: Double,
    val concept: String,
)

@Serializable
data class AccountingTotalsDto(
    val income: Double = 0.0,
    @SerialName("income_cash") val incomeCash: Double = 0.0,
    @SerialName("income_transfer") val incomeTransfer: Double = 0.0,
    @SerialName("income_foreign_cup") val incomeForeignCup: Double = 0.0,
    val profit: Double = 0.0,
    @SerialName("expenses_cup") val expensesCup: Double = 0.0,
    @SerialName("expenses_usd") val expensesUsd: Double = 0.0,
    @SerialName("expenses_eur") val expensesEur: Double = 0.0,
    @SerialName("result_cup") val resultCup: Double = 0.0,
)

@Serializable
data class AccountingDayDto(
    val date: String,
    val income: Double = 0.0,
    val profit: Double = 0.0,
    @SerialName("expenses_cup") val expensesCup: Double = 0.0,
    @SerialName("result_cup") val resultCup: Double = 0.0,
)

@Serializable
data class AccountingSummaryDto(
    val month: String = "",
    val totals: AccountingTotalsDto = AccountingTotalsDto(),
    val days: List<AccountingDayDto> = emptyList(),
)

/**
 * Contabilidad del dueño con plan Enterprise (web: `Contabilidad.jsx`). Solo en línea, como la web.
 * Anotar un gasto lleva id de cliente: repetirlo tras un corte devuelve el mismo gasto, sin duplicarlo.
 * Anular es idempotente. El Excel lo genera el servidor; la app solo lo guarda.
 */
@Singleton
class AccountingRepository @Inject constructor(
    private val api: StoreApi,
    private val json: Json,
) {
    suspend fun summary(session: Session, month: String): AccountingSummaryDto =
        call("No se pudo cargar el resumen del mes.") { api.accountingSummary(auth(session), month) }

    suspend fun expenses(session: Session, month: String): List<ExpenseDto> =
        call("No se pudo cargar los gastos.") { api.accountingExpenses(auth(session), month) }

    suspend fun addExpense(session: Session, request: CreateExpenseRequest): ExpenseDto =
        call("No se pudo guardar el gasto.", "Conéctate a internet para anotar gastos.") {
            api.createExpense(auth(session), request)
        }

    suspend fun voidExpense(session: Session, clientExpenseId: String) {
        call("No se pudo anular el gasto.", "Conéctate a internet para anular gastos.") {
            api.voidExpense(auth(session), clientExpenseId)
        }
    }

    suspend fun exportMonth(session: Session, month: String): ByteArray =
        call("No se pudo generar el archivo.", "Conéctate a internet para descargar el Excel.") {
            api.accountingExport(auth(session), month)
        }.bytes()

    private suspend fun <T> call(fallback: String, offline: String = "Sin conexión con el servidor.", block: suspend () -> Response<T>): T {
        val response = try { block() } catch (_: IOException) { throw IOException(offline) }
        if (!response.isSuccessful) {
            val code = response.errorBody()?.string()?.let { runCatching { json.decodeFromString<ApiErrorDto>(it) }.getOrNull() }
            throw IOException(
                when {
                    code?.code == "PLAN_REQUIRED" || response.code() == 402 -> "La contabilidad es parte del plan Enterprise."
                    response.code() == 403 -> "Solo el dueño puede usar la contabilidad."
                    else -> code?.error?.takeIf { it.isNotBlank() } ?: fallback
                },
            )
        }
        return response.body() ?: throw IOException(fallback)
    }

    private fun auth(session: Session) = "Bearer ${session.token}"
}
