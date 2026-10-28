package cu.mypimes.pos.domain.inventory

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.Test

// Mismos casos que client/src/lib/inventoryCrossCheck.test.js.
class InventoryCrossCheckTest {
    @Test fun toneFollowsTheVerdict() {
        assertEquals(CheckTone.OK, checkTone("cuadra"))
        assertEquals(CheckTone.ALERT, checkTone("respaldo"))
        assertEquals(CheckTone.WARNING, checkTone("diferencias"))
        assertEquals(CheckTone.NEUTRAL, checkTone("parcial"))
        assertEquals(CheckTone.NEUTRAL, checkTone("sin_arqueo"))
        assertEquals(CheckTone.NEUTRAL, checkTone("desconocido"))
    }

    @Test fun nullOrUnavailableCheckHasNoRows() {
        assertTrue(crossCheckRows(null).isEmpty())
        assertTrue(crossCheckRows(InventoryCheck(available = false, verdict = "sin_arqueo", message = "")).isEmpty())
    }

    @Test fun fullCheckShowsCountLossSurplusAndCashDifference() {
        val rows = crossCheckRows(InventoryCheck(
            available = true, verdict = "diferencias", message = "",
            countedAt = "2026-10-22 14:30:00", countedBy = "yamila@tienda.cu",
            productsCounted = 120, productsTotal = 150,
            unitsMissing = 5.0, valueMissing = 250.0,
            unitsExtra = 2.0, valueExtra = 100.0,
            cashDifference = -150.0,
        ))
        assertEquals(5, rows.size)
        assertEquals("Arqueo", rows[0].label)
        assertTrue(rows[0].value.contains("yamila"))
        assertEquals("Productos contados", rows[1].label)
        assertEquals("120 de 150", rows[1].value)
        assertEquals("Faltan", rows[2].label)
        assertTrue(rows[2].value.contains("5 unidades"))
        assertEquals(RowTone.RED, rows[2].tone)
        assertEquals("Sobran", rows[3].label)
        assertTrue(rows[3].value.contains("2 unidades"))
        assertEquals(RowTone.ORANGE, rows[3].tone)
        assertEquals("Diferencia de caja", rows[4].label)
        assertEquals(RowTone.RED, rows[4].tone)
    }

    @Test fun showsSoldWithoutCountAdjustmentsAndWhoClosed() {
        val rows = crossCheckRows(InventoryCheck(
            available = true, verdict = "parcial", message = "",
            closedBy = "dueno@tienda.cu",
            uncountedSoldCount = 1, uncountedSoldNames = listOf("Agotado"),
            adjustmentsCount = 6, adjustmentUnitsIn = 22.0, adjustmentUnitsOut = 20.0,
        ))
        assertTrue(rows.any { it.label == "Cierre realizado por" && it.value.contains("dueno") })
        assertTrue(rows.any { it.label == "Productos vendidos sin contar" && it.value.contains("Agotado") })
        assertTrue(rows.any { it.label == "Ajustes de stock desde conteo anterior" && it.value.contains("22") })
    }

    @Test fun zeroMissingAndSurplusRowsAreHidden() {
        val rows = crossCheckRows(InventoryCheck(
            available = true, verdict = "cuadra", message = "",
            countedAt = "2026-10-22 14:30:00", countedBy = "yamila@tienda.cu",
            productsCounted = 150, productsTotal = 150,
            unitsMissing = 0.0, unitsExtra = 0.0, cashDifference = 0.0,
        ))
        assertEquals(listOf("Arqueo", "Productos contados", "Diferencia de caja"), rows.map { it.label })
        assertFalse(rows.any { it.label == "Faltan" || it.label == "Sobran" })
    }

    @Test fun cashDifferenceColorFollowsItsSign() {
        assertEquals(RowTone.ORANGE, crossCheckRows(InventoryCheck(true, "", "", cashDifference = 100.0)).single().tone)
        assertEquals(RowTone.RED, crossCheckRows(InventoryCheck(true, "", "", cashDifference = -100.0)).single().tone)
        assertEquals(RowTone.GREEN, crossCheckRows(InventoryCheck(true, "", "", cashDifference = 0.0)).single().tone)
    }

    @Test fun accountLabelIsTheNameBeforeTheAt() {
        assertEquals("yamila", accountLabel("yamila@tienda.cu"))
        assertEquals(null, accountLabel(null))
        assertEquals(null, accountLabel(""))
    }
}
