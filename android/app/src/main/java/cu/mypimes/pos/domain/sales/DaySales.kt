package cu.mypimes.pos.domain.sales

import cu.mypimes.pos.data.pos.SaleDto
import cu.mypimes.pos.domain.Payment

/** Resúmenes de las ventas de un día para el dueño: por forma de pago y por cajero. */
object DaySales {
    data class CashierRow(val email: String?, val count: Int, val total: Double)

    /** Lo cobrado por forma de pago con la misma cuenta del arqueo (`paymentSplit` con semántica del servidor). */
    fun split(sales: List<SaleDto>): Payment.Split {
        var cash = 0.0; var transfer = 0.0; var usd = 0.0; var eur = 0.0
        for (sale in sales) {
            val s = Payment.paymentSplit(
                sale.total, sale.paymentMethod, sale.transferAmount,
                sale.foreignCurrency, sale.foreignAmount, sale.exchangeRate, serverSemantics = true,
            )
            cash += s.cash; transfer += s.transfer; usd += s.usd; eur += s.eur
        }
        return Payment.Split(Payment.round2(cash), Payment.round2(transfer), Payment.round2(usd), Payment.round2(eur))
    }

    fun total(sales: List<SaleDto>): Double = Payment.round2(sales.sumOf { Payment.round2(it.total) })

    fun byCashier(sales: List<SaleDto>): List<CashierRow> =
        sales.groupBy { it.accountEmail }
            .map { (email, rows) -> CashierRow(email, rows.size, total(rows)) }
            .sortedByDescending { it.total }

    fun filter(sales: List<SaleDto>, cashier: CashierRow?): List<SaleDto> =
        if (cashier == null) sales else sales.filter { it.accountEmail == cashier.email }

    /** «yamila@mitienda.cu» → «yamila»; sin atribución (ventas viejas) → null. */
    fun accountLabel(email: String?): String? = email?.substringBefore('@')?.takeIf { it.isNotBlank() }
}
