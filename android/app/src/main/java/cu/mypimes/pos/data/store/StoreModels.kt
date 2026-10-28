package cu.mypimes.pos.data.store

import cu.mypimes.pos.data.pos.ProductDto
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class CurrentPeriodDto(
    @SerialName("opened_at") val openedAt: String? = null,
    @SerialName("is_first_close") val isFirstClose: Boolean = false,
    @SerialName("has_sales") val hasSales: Boolean = false,
)

@Serializable
data class CashCloseDto(
    val id: Long,
    @SerialName("client_close_id") val clientCloseId: String? = null,
    @SerialName("opened_at") val openedAt: String? = null,
    @SerialName("closed_at") val closedAt: String? = null,
    @SerialName("opening_float") val openingFloat: Double = 0.0,
    @SerialName("expected_cash") val expectedCash: Double? = null,
    @SerialName("counted_cash") val countedCash: Double? = null,
    val difference: Double? = null,
    @SerialName("expected_transfer") val expectedTransfer: Double? = null,
    @SerialName("sales_count") val salesCount: Int = 0,
    val note: String? = null,
    @SerialName("register_id") val registerId: String? = null,
    @SerialName("account_email") val accountEmail: String? = null,
    @SerialName("expected_usd") val expectedUsd: Double? = null,
    @SerialName("counted_usd") val countedUsd: Double? = null,
    @SerialName("difference_usd") val differenceUsd: Double? = null,
    @SerialName("expected_eur") val expectedEur: Double? = null,
    @SerialName("counted_eur") val countedEur: Double? = null,
    @SerialName("difference_eur") val differenceEur: Double? = null,
    @SerialName("withdrawn_cash") val withdrawnCash: Double = 0.0,
    @SerialName("withdrawn_transfer") val withdrawnTransfer: Double = 0.0,
    @SerialName("withdrawn_usd") val withdrawnUsd: Double = 0.0,
    @SerialName("withdrawn_eur") val withdrawnEur: Double = 0.0,
    @SerialName("correction_revision") val correctionRevision: Int = 0,
    @SerialName("idempotent_replay") val replay: Boolean = false,
    @SerialName("inventory_check") val inventoryCheck: InventoryCheckDto? = null,
) {
    val cashDifference: Double get() = difference ?: 0.0
    val usdDifference: Double get() = differenceUsd ?: 0.0
    val eurDifference: Double get() = differenceEur ?: 0.0
}

@Serializable
data class CashCloseSummaryDto(
    @SerialName("account_id") val accountId: Long? = null,
    @SerialName("account_email") val accountEmail: String? = null,
    @SerialName("register_id") val registerId: String? = null,
    @SerialName("register_name") val registerName: String? = null,
    val attribution: String? = null,
    val closes: Int = 0,
    @SerialName("total_difference") val totalDifference: Double = 0.0,
    @SerialName("worst_difference") val worstDifference: Double = 0.0,
    @SerialName("times_short") val timesShort: Int = 0,
    @SerialName("total_difference_usd") val totalDifferenceUsd: Double = 0.0,
    @SerialName("total_difference_eur") val totalDifferenceEur: Double = 0.0,
    @SerialName("last_close_at") val lastCloseAt: String? = null,
)

@Serializable
data class WithdrawalDto(
    val id: Long,
    @SerialName("client_withdrawal_id") val clientWithdrawalId: String? = null,
    val method: String = "efectivo",
    val amount: Double = 0.0,
    val note: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("register_id") val registerId: String? = null,
    @SerialName("account_email") val accountEmail: String? = null,
    @SerialName("cash_close_id") val cashCloseId: Long? = null,
    @SerialName("voided_at") val voidedAt: String? = null,
)

@Serializable
data class CurrencyPurchaseDto(
    val id: Long,
    @SerialName("client_purchase_id") val clientPurchaseId: String? = null,
    @SerialName("foreign_currency") val foreignCurrency: String = "USD",
    @SerialName("foreign_amount") val foreignAmount: Double = 0.0,
    @SerialName("exchange_rate") val exchangeRate: Double = 0.0,
    @SerialName("shop_rate") val shopRate: Double? = null,
    @SerialName("cup_amount") val cupAmount: Double = 0.0,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("account_email") val accountEmail: String? = null,
    @SerialName("cash_close_id") val cashCloseId: Long? = null,
)

@Serializable
data class TodayDto(
    val sales: Double = 0.0,
    val profit: Double = 0.0,
    val count: Int = 0,
)

@Serializable
data class HoldingsDto(
    val cash: Double = 0.0,
    val transfer: Double = 0.0,
    val usd: Double = 0.0,
    val eur: Double = 0.0,
)

@Serializable
data class InventorySummaryDto(
    val cost: Double = 0.0,
    val retail: Double = 0.0,
    val units: Int = 0,
)

@Serializable
data class WarehouseSummaryDto(
    val items: Int = 0,
    val cost: Double = 0.0,
    @SerialName("lastTransfer") val lastTransfer: WarehouseTransferDto? = null,
)

@Serializable
data class WarehouseTransferDto(
    @SerialName("item_name") val itemName: String? = null,
    val quantity: Double = 0.0,
    @SerialName("account_email") val accountEmail: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("created_at_label") val createdAtLabel: String? = null,
)

@Serializable
data class LastCloseAuditDto(
    val id: Long = 0,
    @SerialName("closed_at") val closedAt: String? = null,
    @SerialName("closed_at_label") val closedAtLabel: String? = null,
    val difference: Double? = null,
    @SerialName("expected_cash") val expectedCash: Double? = null,
    @SerialName("counted_cash") val countedCash: Double? = null,
    @SerialName("sales_count") val salesCount: Int = 0,
    @SerialName("account_email") val accountEmail: String? = null,
)

@Serializable
data class CashierPatternDto(
    @SerialName("account_email") val accountEmail: String? = null,
    val closes: Int = 0,
    @SerialName("total_difference") val totalDifference: Double = 0.0,
    @SerialName("times_short") val timesShort: Int = 0,
)

@Serializable
data class AuditDto(
    @SerialName("lastCashClose") val lastCashClose: LastCloseAuditDto? = null,
    @SerialName("cashierSummary") val cashierSummary: List<CashierPatternDto> = emptyList(),
    @SerialName("rejectedSales") val rejectedSales: Int = 0,
    @SerialName("offRateSales") val offRateSales: Int = 0,
)

@Serializable
data class DashboardDto(
    val today: TodayDto = TodayDto(),
    val holdings: HoldingsDto = HoldingsDto(),
    @SerialName("open_withdrawals") val openWithdrawals: List<WithdrawalDto> = emptyList(),
    val inventory: InventorySummaryDto = InventorySummaryDto(),
    val warehouse: WarehouseSummaryDto = WarehouseSummaryDto(),
    @SerialName("lowStock") val lowStock: List<ProductDto> = emptyList(),
    @SerialName("recentSales") val recentSales: List<cu.mypimes.pos.data.pos.SaleDto> = emptyList(),
    val audit: AuditDto = AuditDto(),
)

@Serializable
data class DailyActivityDto(
    val date: String = "",
    @SerialName("day_label") val dayLabel: String = "",
    val prev: String? = null,
    val next: String? = null,
    val summary: TodayDto = TodayDto(),
    val sales: List<cu.mypimes.pos.data.pos.SaleDto> = emptyList(),
    val transfers: List<WarehouseTransferDto> = emptyList(),
    val purchases: List<CurrencyPurchaseDto> = emptyList(),
    val withdrawals: List<WithdrawalDto> = emptyList(),
    @SerialName("cashCloses") val cashCloses: List<CashCloseDto> = emptyList(),
)

@Serializable
data class CreateCloseRequest(
    @SerialName("client_close_id") val clientCloseId: String,
    @SerialName("register_id") val registerId: String,
    @SerialName("counted_cash") val countedCash: Double,
    @SerialName("counted_usd") val countedUsd: Double = 0.0,
    @SerialName("counted_eur") val countedEur: Double = 0.0,
    @SerialName("opening_float") val openingFloat: Double = 0.0,
    val note: String? = null,
    @SerialName("closed_at") val closedAt: String? = null,
)

@Serializable
data class CreateWithdrawalRequest(
    @SerialName("client_withdrawal_id") val clientWithdrawalId: String,
    val method: String = "efectivo",
    val amount: Double,
    val note: String? = null,
    @SerialName("register_id") val registerId: String,
    @SerialName("withdrawn_at") val withdrawnAt: String? = null,
)

@Serializable
data class CreatePurchaseRequest(
    @SerialName("client_purchase_id") val clientPurchaseId: String,
    @SerialName("foreign_currency") val foreignCurrency: String,
    @SerialName("foreign_amount") val foreignAmount: Double,
    @SerialName("exchange_rate") val exchangeRate: Double,
    @SerialName("shop_rate") val shopRate: Double? = null,
    @SerialName("register_id") val registerId: String,
    @SerialName("sold_at") val soldAt: String? = null,
)

/** A close that lives only on this device until the outbox reaches the cloud. */
data class PendingClose(
    val clientCloseId: String,
    val countedCash: Double,
    val countedUsd: Double,
    val countedEur: Double,
    val openingFloat: Double,
    val note: String?,
    val queuedAt: Long,
    val status: String,
    val lastError: String?,
)

data class PendingWithdrawal(
    val clientWithdrawalId: String,
    val amount: Double,
    val note: String?,
    val queuedAt: Long,
    val status: String,
    val lastError: String?,
)

data class PendingPurchase(
    val clientPurchaseId: String,
    val currency: String,
    val amount: Double,
    val rate: Double,
    val cup: Double,
    val queuedAt: Long,
    val status: String,
    val lastError: String?,
)

/** Resumen de un mes (`GET /api/reports/days`, solo dueño). Solo los campos que usa la vista. */
@Serializable
data class MonthDaysDto(
    val month: String = "",
    val totals: MonthTotalsDto = MonthTotalsDto(),
    val days: List<MonthDayDto> = emptyList(),
)

@Serializable
data class MonthTotalsDto(
    @SerialName("sales_count") val salesCount: Int = 0,
    val total: Double = 0.0,
    @SerialName("cash_total") val cashTotal: Double = 0.0,
    @SerialName("transfer_total") val transferTotal: Double = 0.0,
    @SerialName("foreign_total") val foreignTotal: Double = 0.0,
    val profit: Double = 0.0,
)

@Serializable
data class MonthDayDto(
    val date: String = "",
    @SerialName("sales_count") val salesCount: Int = 0,
    val total: Double = 0.0,
    val profit: Double = 0.0,
)
