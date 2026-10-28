package cu.mypimes.pos.domain.inventory

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class InventoryCountTest {
    @Test fun packCountMultipliesPacksAndAddsLoose() {
        assertEquals(67.0, packCountTotal("3", "7", 20)!!, 1e-9)
        assertEquals(40.0, packCountTotal("2", "", 20)!!, 1e-9)
        assertEquals(5.0, packCountTotal("", "5", 20)!!, 1e-9)
    }

    @Test fun packCountRejectsEmptyNegativeAndFractionalValues() {
        assertNull(packCountTotal("", "", 20))
        assertNull(packCountTotal("-1", "0", 20))
        assertNull(packCountTotal("1.5", "0", 20))
    }

    @Test fun summaryValuesMissingUnitsAtSalePriceAndCountsExtra() {
        val lines = listOf(
            CountedLine(1, "Arroz", expected = 10.0, counted = 8.0, unitPrice = 300.0, packSize = null),
            CountedLine(2, "Pan", expected = 5.0, counted = 7.0, unitPrice = 20.0, packSize = null),
            CountedLine(3, "Sal", expected = 3.0, counted = 3.0, unitPrice = 50.0, packSize = null),
        )
        val summary = countSummary(lines)
        assertEquals(2, summary.withDifference)
        assertEquals(2.0, summary.unitsMissing, 1e-9)
        assertEquals(2.0, summary.unitsExtra, 1e-9)
        assertEquals(600.0, summary.valueMissing, 1e-9)
    }

    @Test fun weightedDifferencesKeepThreeDecimals() {
        val summary = countSummary(listOf(CountedLine(4, "Queso", expected = 2.5, counted = 2.25, unitPrice = 800.0, packSize = null)))
        assertEquals(0.25, summary.unitsMissing, 1e-9)
        assertEquals(200.0, summary.valueMissing, 1e-9)
    }

    @Test fun countedQuantityUsesPacksForPackProductsAndUnitRulesOtherwise() {
        assertEquals(22.0, countedQuantity(CountEntry(packs = "1", loose = "2"), packSize = 20, unit = null)!!, 1e-9)
        assertNull(countedQuantity(CountEntry(), packSize = 20, unit = null))
        assertNull(countedQuantity(CountEntry(text = "12,5"), packSize = null, unit = null))
        assertEquals(2.5, countedQuantity(CountEntry(text = "2,5"), packSize = null, unit = "kg")!!, 1e-9)
        assertNull(countedQuantity(CountEntry(text = "abc"), packSize = null, unit = "kg"))
    }
}
