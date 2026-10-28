package cu.mypimes.pos.domain.accounting

import java.time.YearMonth
import kotlin.math.round

/** Reglas de contabilidad (espejo de `client/src/lib/accountingValidation.js`; el servidor valida de nuevo). */
object Accounting {
    /** Apartados de un gasto: los mismos que `WITHDRAWAL_METHODS` del servidor. */
    val methods = listOf("efectivo", "transferencia", "USD", "EUR")

    fun methodLabel(method: String?): String = when (method) {
        "transferencia" -> "Transferencia"
        "USD" -> "Dólares"
        "EUR" -> "Euros"
        else -> "Efectivo"
    }

    /** Solo el dueño con plan Enterprise ve la contabilidad (el servidor responde 403 PLAN_REQUIRED en Basic). */
    fun available(isOwner: Boolean, plan: String?): Boolean = isOwner && plan == "enterprise"

    /** Acepta coma o punto decimal. Devuelve null si no es un número finito. */
    fun parseAmount(text: String): Double? = text.trim().replace(',', '.').toDoubleOrNull()?.takeIf { it.isFinite() }

    /** Error del formulario de gasto, o null. El monto se valida ya redondeado a centavos, como hace el servidor. */
    fun expenseError(amountText: String, concept: String): String? {
        val amount = parseAmount(amountText)
        val text = concept.trim()
        return when {
            amount == null || round(amount * 100) <= 0 -> "El monto debe ser mayor que 0."
            text.length < 3 -> "El concepto debe tener al menos 3 letras."
            text.length > 200 -> "Escribe en qué se gastó (entre 3 y 200 caracteres)."
            else -> null
        }
    }

    /** Mes 'YYYY-MM' desplazado. */
    fun shiftMonth(month: String, delta: Int): String = YearMonth.parse(month).plusMonths(delta.toLong()).toString()

    /** No se avanza más allá del mes en curso (`today` del negocio). */
    fun canGoNext(month: String, today: YearMonth): Boolean = YearMonth.parse(month) < today
}
