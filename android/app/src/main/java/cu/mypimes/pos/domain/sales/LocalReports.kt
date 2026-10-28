package cu.mypimes.pos.domain.sales

import cu.mypimes.pos.data.pos.SaleDto
import cu.mypimes.pos.data.pos.SaleItemDto
import cu.mypimes.pos.data.store.DailyActivityDto
import cu.mypimes.pos.data.store.MonthDayDto
import cu.mypimes.pos.data.store.MonthDaysDto
import cu.mypimes.pos.data.store.MonthTotalsDto
import cu.mypimes.pos.data.store.TodayDto
import cu.mypimes.pos.domain.BusinessDay
import cu.mypimes.pos.domain.Format
import cu.mypimes.pos.domain.Payment
import cu.mypimes.pos.domain.pos.PosSale
import java.time.LocalDate

/** Ventas por día y por mes armadas con lo guardado en el aparato, con las mismas cuentas que `reports.js`. */
object LocalReports {
    fun saleDto(sale: PosSale) = SaleDto(
        id = sale.serverId, clientSaleId = sale.clientSaleId, total = sale.total, cashReceived = sale.cashReceived,
        createdAt = sale.createdAt, paymentMethod = sale.paymentMethod, transferAmount = sale.transferAmount,
        foreignCurrency = sale.foreignCurrency, foreignAmount = sale.foreignAmount, exchangeRate = sale.exchangeRate,
        shopRate = sale.shopRate, registerId = sale.registerId, cashCloseId = sale.cashCloseId, profit = sale.profit,
        accountEmail = sale.accountEmail,
        items = sale.lines.map { SaleItemDto(null, it.product.id, it.product.name, it.quantity, it.unitPrice.takeIf(Double::isFinite) ?: it.product.salePrice) },
    )

    private fun summary(sales: List<SaleDto>) = TodayDto(
        sales = DaySales.total(sales), profit = Payment.round2(sales.sumOf { it.profit ?: 0.0 }), count = sales.size,
    )

    /** Las listas que no son ventas (cierres, retiros, compras, pases) se completan aparte con lo que haya guardado. */
    fun day(date: String, sales: List<SaleDto>): DailyActivityDto {
        val day = LocalDate.parse(date)
        return DailyActivityDto(
            date = date, dayLabel = Format.dayLabel(day), prev = day.minusDays(1).toString(),
            next = day.plusDays(1).takeUnless { it.isAfter(LocalDate.now(Format.cubaZone)) }?.toString(),
            summary = summary(sales), sales = sales.sortedByDescending { it.createdAt },
        )
    }

    /** `sales` ya son las del mes; el día de cada una es su día del negocio. Los días van del más reciente al más antiguo. */
    fun month(month: String, sales: List<SaleDto>): MonthDaysDto {
        val byDay = sales.groupBy { BusinessDay.dateOf(it.createdAt) }.filterKeys { it != null }
        val days = byDay.map { (date, rows) ->
            MonthDayDto(date!!, rows.size, DaySales.total(rows), Payment.round2(rows.sumOf { it.profit ?: 0.0 }))
        }.sortedByDescending { it.date }
        val splits = sales.map {
            Payment.paymentSplit(it.total, it.paymentMethod, it.transferAmount, it.foreignCurrency, it.foreignAmount, it.exchangeRate, serverSemantics = true)
        }
        return MonthDaysDto(month, MonthTotalsDto(
            salesCount = sales.size, total = DaySales.total(sales),
            cashTotal = Payment.round2(splits.sumOf { it.cash }), transferTotal = Payment.round2(splits.sumOf { it.transfer }),
            foreignTotal = Payment.round2(splits.sumOf { it.foreign_cup }),
            profit = Payment.round2(sales.sumOf { it.profit ?: 0.0 }),
        ), days)
    }
}
