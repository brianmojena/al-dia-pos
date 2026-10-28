package cu.mypimes.pos.domain

import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/** Money rules ported from client/src/lib/payment.js, cashPayment.js and server/lib/payment.js. */
object Payment {
    val currencies = listOf("USD", "EUR")
    val withdrawalMethods = listOf("efectivo", "transferencia", "USD", "EUR")

    data class Split(val cash: Double, val transfer: Double, val usd: Double = 0.0, val eur: Double = 0.0, val foreign_cup: Double = 0.0)
    data class ForeignBreakdown(val foreignCup: Double, val cashToCollect: Double, val change: Double)
    data class CashBreakdown(val totalCents: Double?, val receivedCents: Long?, val changeCents: Double, val shortfallCents: Double, val validAmount: Boolean, val canConfirm: Boolean)
    data class WithdrawalFields(val method: String, val amount: Double, val note: String?)
    data class ForeignFields(val foreign_currency: String?, val foreign_amount: Double?, val exchange_rate: Double?, val shop_rate: Double?)
    data class PurchaseFields(val foreign_currency: String, val foreign_amount: Double, val exchange_rate: Double, val shop_rate: Double?, val cup_amount: Double)

    // Adding .5 first can round 0.49999999999999994 up due to that addition.
    private fun jsRound(value: Double): Double {
        if (!value.isFinite()) return value
        if (value >= -0.5 && value < 0.0) return -0.0
        val integer = floor(value)
        return integer + if (value - integer >= 0.5) 1.0 else 0.0
    }
    private fun jsNumber(value: Any?): Double = when (value) {
        null -> 0.0
        is Number -> value.toDouble()
        is Boolean -> if (value) 1.0 else 0.0
        is String -> value.trim().let { if (it.isEmpty()) 0.0 else it.toDoubleOrNull() ?: Double.NaN }
        else -> Double.NaN
    }
    // Mirrors `Number(value) || 0`, separately from Number coercion used by validators.
    private fun jsNumberOrZero(value: Any?): Double = jsNumber(value).let { if (it == 0.0 || it.isNaN()) 0.0 else it }
    fun round2(value: Any?): Double {
        return jsRound(jsNumberOrZero(value) * 100.0) / 100.0
    }

    /** Client semantics: mixed transfer is preserved as supplied; server rounds it to cents. */
    fun paymentSplit(total: Any?, method: String?, transferAmount: Any? = null, foreignCurrency: String? = null, foreignAmount: Any? = null, exchangeRate: Any? = null, serverSemantics: Boolean = false): Split {
        val t = jsNumberOrZero(total)
        return when (method) {
            "transferencia" -> Split(0.0, t)
            "mixto" -> {
                val transfer = if (serverSemantics) round2(transferAmount) else jsNumberOrZero(transferAmount)
                val cash = t - transfer
                Split(if (serverSemantics) round2(cash) else cash, transfer)
            }
            "divisa" -> {
                val amount = round2(foreignAmount)
                val cup = round2(amount * jsNumberOrZero(exchangeRate))
                Split(round2(t - cup), 0.0, if (foreignCurrency == "USD") amount else 0.0, if (foreignCurrency == "EUR") amount else 0.0, cup)
            }
            else -> Split(t, 0.0)
        }
    }

    fun paymentLabel(method: String?, currency: String?): String = when (method) {
        "transferencia" -> "Transferencia"
        "mixto" -> "Mixto"
        "divisa" -> if (currency == "EUR") "Euros" else "Dólares"
        else -> "Efectivo"
    }
    fun offShopRate(method: String?, exchangeRate: Any?, shopRate: Any?): Boolean = method == "divisa" && shopRate != null && kotlin.math.abs(jsNumber(exchangeRate) - jsNumber(shopRate)) > 0.005
    fun foreignBreakdown(total: Any?, amount: Any?, rate: Any?): ForeignBreakdown {
        val cup = round2(jsNumberOrZero(amount) * jsNumberOrZero(rate))
        val rest = round2(jsNumber(total) - cup)
        return ForeignBreakdown(cup, max(0.0, rest), max(0.0, -rest))
    }
    fun foreignNeeded(total: Any?, rate: Any?): Double {
        val r = jsNumber(rate)
        return if (r > 0) ceil((jsNumber(total) / r) * 100.0) / 100.0 else 0.0
    }
    fun maxTransfer(total: Double, transferLimit: Double?): Double = max(0.0, min(total, transferLimit ?: total))
    fun initialTransfer(total: Double, transferLimit: Double?): Double = min(jsRound(total / 2), maxTransfer(total, transferLimit))
    fun clampTransfer(value: Any?, total: Double, transferLimit: Double?): Double {
        val n = when (value) { is Number -> value.toDouble(); is String -> value.trim().toDoubleOrNull() ?: Double.NaN; else -> Double.NaN }
        if (!n.isFinite()) return 0.0
        return min(max(0.0, n), maxTransfer(total, transferLimit))
    }
    fun mixedPayload(total: Double, transfer: Double): Map<String, Any> = when {
        transfer <= 0 -> mapOf("payment_method" to "efectivo")
        transfer >= total -> mapOf("payment_method" to "transferencia")
        else -> mapOf("payment_method" to "mixto", "transfer_amount" to transfer)
    }

    fun withdrawalSplit(method: String, amount: Any?, voided: Boolean): Split {
        val amountRounded = if (voided) 0.0 else round2(amount)
        val n = round2(-amountRounded)
        return Split(if (method == "efectivo") n else 0.0, if (method == "transferencia") n else 0.0,
            if (method == "USD") n else 0.0, if (method == "EUR") n else 0.0)
    }
    fun withdrawalFields(method: String, amount: Any?, note: Any?): WithdrawalFields {
        require(method in withdrawalMethods) { "Apartado inválido" }
        val n = jsNumber(amount)
        require(amount != null && amount != "" && n.isFinite() && round2(n) > 0) { "Falta cuánto dinero se extrae" }
        val clean = note?.toString()?.trim()?.take(200)?.ifEmpty { null }
        return WithdrawalFields(method, round2(n), clean)
    }
    fun purchaseSplit(currency: String, foreignAmount: Any?, cupAmount: Any?): Split {
        val amount = round2(foreignAmount)
        return Split(-round2(cupAmount), 0.0, if (currency == "USD") amount else 0.0, if (currency == "EUR") amount else 0.0)
    }
    fun purchaseCup(amount: Any?, rate: Any?): Double = round2(round2(amount) * jsNumberOrZero(rate))
    fun offShopPurchase(exchangeRate: Any?, shopRate: Any?): Boolean = shopRate != null && kotlin.math.abs(jsNumber(exchangeRate) - jsNumber(shopRate)) > 0.005
    fun foreignFields(method: String?, currency: String?, amount: Any?, rate: Any?, shopRate: Any?): ForeignFields {
        if (method != "divisa") return ForeignFields(null, null, null, null)
        require(currency != null && currency in currencies) { "Moneda inválida: solo USD o EUR" }
        val n = jsNumber(amount)
        require(amount != null && n.isFinite() && round2(n) > 0) { "Falta cuántos dólares o euros entregó el cliente" }
        val r = jsNumber(rate)
        require(rate != null && r.isFinite() && r > 0) { "Falta la tasa de cambio del cobro" }
        val shop = if (shopRate == null) null else jsNumber(shopRate).takeIf { it.isFinite() && it > 0 }
        return ForeignFields(currency, round2(n), r, shop)
    }
    fun purchaseFields(currency: String?, amount: Any?, rate: Any?, shopRate: Any?): PurchaseFields {
        require(currency != null && currency in currencies) { "Moneda inválida: solo USD o EUR" }
        val n = jsNumber(amount)
        require(amount != null && n.isFinite() && round2(n) > 0) { "Falta cuántos dólares o euros se compran" }
        val r = jsNumber(rate)
        require(rate != null && r.isFinite() && r > 0) { "Falta la tasa de la compra" }
        val shop = if (shopRate == null) null else jsNumber(shopRate).takeIf { it.isFinite() && it > 0 }
        return PurchaseFields(currency!!, round2(n), r, shop, purchaseCup(n, r))
    }

    /** Returns safe integer cents, matching parseCupCents' strict decimal grammar. */
    fun parseCupCents(value: Any?): Long? {
        if (value !is String) return null
        val match = Regex("^(\\d+)(?:[.,](\\d{1,2}))?$").matchEntire(value.trim()) ?: return null
        val whole = match.groupValues[1].toLongOrNull() ?: return null
        val frac = match.groupValues[2].padEnd(2, '0').ifEmpty { "0" }.toLongOrNull() ?: return null
        val maxWhole = 9_007_199_254_740_991L / 100L
        val maxRemainder = 9_007_199_254_740_991L % 100L
        if (whole > maxWhole || (whole == maxWhole && frac > maxRemainder)) return null
        val total = whole * 100L + frac
        return total
    }
    fun cashPaymentBreakdown(total: Double, amountReceived: Any?): CashBreakdown {
        val totalCents = if (total.isFinite() && total >= 0) jsRound(total * 100.0) else null
        val received = parseCupCents(amountReceived)
        val valid = received != null && received > 0
        if (totalCents == null || !valid) return CashBreakdown(totalCents, received, 0.0, 0.0, valid, false)
        val difference = received!!.toDouble() - totalCents
        return CashBreakdown(totalCents, received, max(0.0, difference), max(0.0, -difference), true, difference >= 0)
    }
}
