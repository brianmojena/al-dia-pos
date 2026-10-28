package cu.mypimes.pos.domain.inventory

import cu.mypimes.pos.domain.Format

/** Cruce del último arqueo con un cierre. El servidor calcula el veredicto y las cifras; aquí solo se muestran. */
data class InventoryCheck(
    val available: Boolean,
    val verdict: String,
    val message: String,
    val countedAt: String? = null,
    val countedBy: String? = null,
    val closedBy: String? = null,
    val productsCounted: Int? = null,
    val productsTotal: Int? = null,
    val unitsMissing: Double = 0.0,
    val unitsExtra: Double = 0.0,
    val valueMissing: Double = 0.0,
    val valueExtra: Double = 0.0,
    val cashDifference: Double? = null,
    val uncountedSoldNames: List<String> = emptyList(),
    val uncountedSoldCount: Int = 0,
    val adjustmentsCount: Int = 0,
    val adjustmentUnitsIn: Double = 0.0,
    val adjustmentUnitsOut: Double = 0.0,
)

enum class CheckTone { OK, ALERT, WARNING, NEUTRAL }

enum class RowTone { DEFAULT, RED, ORANGE, AMBER, GREEN }

data class CheckRow(val label: String, val value: String, val tone: RowTone = RowTone.DEFAULT)

/** cuadra → OK; respaldo → ALERT; diferencias → WARNING; el resto (parcial, sin_arqueo) → NEUTRAL. */
fun checkTone(verdict: String): CheckTone = when (verdict) {
    "cuadra" -> CheckTone.OK
    "respaldo" -> CheckTone.ALERT
    "diferencias" -> CheckTone.WARNING
    else -> CheckTone.NEUTRAL
}

fun crossCheckRows(check: InventoryCheck?): List<CheckRow> {
    if (check == null || !check.available) return emptyList()
    val rows = mutableListOf<CheckRow>()

    if (check.countedAt != null && check.countedBy != null) {
        rows += CheckRow("Arqueo", "${Format.dateTime(check.countedAt)} · ${accountLabel(check.countedBy) ?: check.countedBy}")
    }
    check.closedBy?.let { rows += CheckRow("Cierre realizado por", accountLabel(it) ?: it) }

    if (check.uncountedSoldCount > 0) {
        rows += CheckRow(
            "Productos vendidos sin contar",
            check.uncountedSoldNames.filter { it.isNotBlank() }.joinToString(", ").ifEmpty { check.uncountedSoldCount.toString() },
            RowTone.AMBER,
        )
    }
    if (check.adjustmentsCount > 0) {
        rows += CheckRow(
            "Ajustes de stock desde conteo anterior",
            "${check.adjustmentsCount} · +${Format.quantity(check.adjustmentUnitsIn)} / −${Format.quantity(check.adjustmentUnitsOut)} unidades",
            RowTone.AMBER,
        )
    }
    if (check.productsCounted != null && check.productsTotal != null) {
        rows += CheckRow("Productos contados", "${check.productsCounted} de ${check.productsTotal}")
    }
    if (check.unitsMissing > 0) {
        rows += CheckRow("Faltan", "${Format.quantity(check.unitsMissing)} unidades · ${Format.money(check.valueMissing)}", RowTone.RED)
    }
    if (check.unitsExtra > 0) {
        rows += CheckRow("Sobran", "${Format.quantity(check.unitsExtra)} unidades · ${Format.money(check.valueExtra)}", RowTone.ORANGE)
    }
    check.cashDifference?.let { cash ->
        val tone = when {
            cash < 0 -> RowTone.RED
            cash > 0 -> RowTone.ORANGE
            else -> RowTone.GREEN
        }
        rows += CheckRow("Diferencia de caja", Format.money(cash), tone)
    }
    return rows
}
