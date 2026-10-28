package cu.mypimes.pos.domain.sales

import cu.mypimes.pos.data.pos.SaleDto
import cu.mypimes.pos.data.store.CorrectSaleRequest
import cu.mypimes.pos.domain.Payment
import kotlin.math.abs
import kotlin.math.roundToLong

/**
 * Corrección de ventas del dueño (web: `SaleCorrection.jsx` + `nextPayment` de `server/lib/saleCorrections.js`).
 * Aquí solo se valida y se arma la petición, igual que la web; las cuentas del cierre y el stock las hace el
 * servidor. Las reglas de cobro son las de [Payment] (sin cuentas nuevas).
 */
object SaleCorrections {
    val methods = listOf("efectivo" to "Efectivo", "transferencia" to "Transf.", "mixto" to "Mixto", "divisa" to "Divisa")

    /** Lo que el dueño teclea: texto, como en la web (admite coma decimal). */
    data class Choice(
        val method: String = "efectivo",
        val transfer: String = "",
        val currency: String = "USD",
        val amount: String = "",
        val rate: String = "",
    )

    data class Built(val request: CorrectSaleRequest? = null, val error: String? = null)

    private fun num(text: String): Double = text.trim().replace(',', '.').toDoubleOrNull() ?: Double.NaN

    private fun plain(value: Double?): String = when {
        value == null || !value.isFinite() || value == 0.0 -> ""
        value == value.roundToLong().toDouble() -> value.roundToLong().toString()
        else -> value.toString()
    }

    /** `openPayment` de la web: propone el otro cobro y parte de lo que ya tenía la venta. */
    fun initialChoice(sale: SaleDto, shopRate: (String) -> Double?): Choice {
        val current = sale.paymentMethod ?: "efectivo"
        val code = sale.foreignCurrency ?: "USD"
        val rate = sale.exchangeRate ?: shopRate(code)
        val amount = sale.foreignAmount ?: rate?.let { Payment.foreignNeeded(sale.total, it) }
        return Choice(
            method = if (current == "efectivo") "transferencia" else "efectivo",
            transfer = plain(sale.transferAmount),
            currency = code,
            amount = plain(amount),
            rate = plain(rate),
        )
    }

    /** `changeCurrency` de la web: tasa de la tienda y billetes necesarios para cubrir el total. */
    fun withCurrency(choice: Choice, total: Double, code: String, shopRate: Double?): Choice = choice.copy(
        currency = code,
        rate = plain(shopRate),
        amount = plain(shopRate?.let { Payment.foreignNeeded(total, it) }),
    )

    fun voidRequest(reason: String) = CorrectSaleRequest(action = "anular", reason = cleanReason(reason))

    private fun cleanReason(reason: String): String? = reason.trim().take(200).ifEmpty { null }

    fun paymentRequest(sale: SaleDto, choice: Choice, reason: String): Built {
        val total = sale.total
        var transfer: Double? = null
        var foreign: Payment.ForeignFields? = null
        when (choice.method) {
            "efectivo", "transferencia" -> Unit
            "mixto" -> {
                val raw = num(choice.transfer)
                transfer = Payment.round2(raw)
                if (!raw.isFinite() || transfer <= 0) return Built(error = "Falta el monto transferido del cobro mixto")
                if (transfer >= total) return Built(error = "El monto transferido tiene que ser menor que el total")
            }
            "divisa" -> foreign = try {
                Payment.foreignFields("divisa", choice.currency, num(choice.amount), num(choice.rate), null)
            } catch (error: IllegalArgumentException) {
                return Built(error = error.message)
            }
            else -> return Built(error = "Forma de pago inválida")
        }
        if (samePayment(sale, choice.method, transfer, foreign)) return Built(error = "La venta ya tiene esa forma de pago")
        return Built(
            CorrectSaleRequest(
                action = "pago",
                reason = cleanReason(reason),
                paymentMethod = choice.method,
                transferAmount = transfer,
                foreignCurrency = foreign?.foreign_currency,
                foreignAmount = foreign?.foreign_amount,
                exchangeRate = foreign?.exchange_rate,
            ),
        )
    }

    // `samePayment` del servidor: Number(null) cuenta como 0 en cuanto uno de los dos es número.
    private fun sameNumber(a: Double?, b: Double?): Boolean =
        if (a == null && b == null) true else abs((a ?: 0.0) - (b ?: 0.0)) == 0.0

    private fun samePayment(sale: SaleDto, method: String, transfer: Double?, foreign: Payment.ForeignFields?): Boolean =
        (sale.paymentMethod ?: "efectivo") == method &&
            sameNumber(sale.transferAmount, transfer) &&
            sale.foreignCurrency == foreign?.foreign_currency &&
            sameNumber(sale.foreignAmount, foreign?.foreign_amount) &&
            sameNumber(sale.exchangeRate, foreign?.exchange_rate)

    /** «faltaron 1.200» / «cuadró» / «sobraron 300», para contar cómo quedó un cierre. */
    fun closeResult(difference: Double?, money: (Double) -> String): String {
        val d = Math.round(difference ?: 0.0)
        return when {
            d == 0L -> "cuadró"
            d < 0 -> "faltaron ${money((-d).toDouble())}"
            else -> "sobraron ${money(d.toDouble())}"
        }
    }
}
