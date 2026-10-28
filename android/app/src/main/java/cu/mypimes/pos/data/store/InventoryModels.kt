package cu.mypimes.pos.data.store

import cu.mypimes.pos.domain.inventory.InventoryCheck
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class InventoryCountItemDto(
    val id: Long,
    @SerialName("product_id") val productId: Long,
    @SerialName("product_name") val productName: String = "",
    val expected: Double = 0.0,
    val counted: Double = 0.0,
    val difference: Double = 0.0,
    @SerialName("unit_price") val unitPrice: Double = 0.0,
    @SerialName("recounted_later") val recountedLater: Boolean = false,
)

/** La lista del historial no trae `items`; el detalle sí. */
@Serializable
data class InventoryCountDto(
    val id: Long,
    @SerialName("client_count_id") val clientCountId: String? = null,
    @SerialName("counted_at") val countedAt: String? = null,
    @SerialName("account_email") val accountEmail: String? = null,
    @SerialName("lines_count") val linesCount: Int = 0,
    @SerialName("units_missing") val unitsMissing: Double = 0.0,
    @SerialName("units_extra") val unitsExtra: Double = 0.0,
    @SerialName("value_missing") val valueMissing: Double = 0.0,
    val note: String? = null,
    val items: List<InventoryCountItemDto> = emptyList(),
)

@Serializable
data class CountLineRequest(
    @SerialName("product_id") val productId: Long,
    val counted: Double,
)

@Serializable
data class CreateInventoryCountRequest(
    @SerialName("client_count_id") val clientCountId: String,
    val items: List<CountLineRequest>,
    val note: String? = null,
)

@Serializable
data class CorrectionLineRequest(
    @SerialName("item_id") val itemId: Long,
    val counted: Double,
)

@Serializable
data class UpdateInventoryCountRequest(val items: List<CorrectionLineRequest>)

@Serializable
data class DayStockRowDto(
    val id: Long,
    @SerialName("opening_stock") val openingStock: Double? = null,
    @SerialName("entries_stock") val entriesStock: Double? = null,
    @SerialName("current_stock") val currentStock: Double? = null,
)

@Serializable
data class DayStockDto(val date: String = "", val products: List<DayStockRowDto> = emptyList())

@Serializable
data class UncountedSoldDto(@SerialName("product_name") val productName: String = "")

/** Cruce con el último arqueo que el servidor adjunta al detalle de un cierre (solo dueño). */
@Serializable
data class InventoryCheckDto(
    val available: Boolean = false,
    val verdict: String = "parcial",
    val message: String = "",
    @SerialName("counted_at") val countedAt: String? = null,
    @SerialName("counted_by") val countedBy: String? = null,
    @SerialName("closed_by") val closedBy: String? = null,
    @SerialName("products_counted") val productsCounted: Int? = null,
    @SerialName("products_total") val productsTotal: Int? = null,
    @SerialName("units_missing") val unitsMissing: Double = 0.0,
    @SerialName("value_missing") val valueMissing: Double = 0.0,
    @SerialName("units_extra") val unitsExtra: Double = 0.0,
    @SerialName("value_extra") val valueExtra: Double = 0.0,
    @SerialName("cash_difference") val cashDifference: Double? = null,
    @SerialName("uncounted_sold_products_count") val uncountedSoldCount: Int = 0,
    @SerialName("uncounted_sold_products") val uncountedSold: List<UncountedSoldDto> = emptyList(),
    @SerialName("stock_adjustments_count") val adjustmentsCount: Int = 0,
    @SerialName("stock_adjustment_units_in") val adjustmentUnitsIn: Double = 0.0,
    @SerialName("stock_adjustment_units_out") val adjustmentUnitsOut: Double = 0.0,
) {
    fun toDomain() = InventoryCheck(
        available = available,
        verdict = verdict,
        message = message,
        countedAt = countedAt,
        countedBy = countedBy,
        closedBy = closedBy,
        productsCounted = productsCounted,
        productsTotal = productsTotal,
        unitsMissing = unitsMissing,
        unitsExtra = unitsExtra,
        valueMissing = valueMissing,
        valueExtra = valueExtra,
        cashDifference = cashDifference,
        uncountedSoldNames = uncountedSold.map { it.productName },
        uncountedSoldCount = uncountedSoldCount,
        adjustmentsCount = adjustmentsCount,
        adjustmentUnitsIn = adjustmentUnitsIn,
        adjustmentUnitsOut = adjustmentUnitsOut,
    )
}
