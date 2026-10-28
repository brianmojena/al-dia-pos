package cu.mypimes.pos.domain.pos

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PosCartTest {
    private fun product(
        id: Long = 1,
        name: String = "Producto",
        price: Double = 10.0,
        stock: Double = 10.0,
        unit: String? = null,
        trackStock: Boolean = true,
        packSize: Int? = null,
        packPrice: Double? = null,
    ) = PosProduct(id, name, price, stock, unit, trackStock, packSize, packPrice)

    @Test fun acceptsWeightFractionsToThreeDecimals() {
        val weighted = product(unit = "kg", stock = 0.1)
        PosCart.validate(listOf(CartLine(weighted, 1.234)))
        assertThrows(IllegalArgumentException::class.java) {
            PosCart.validate(listOf(CartLine(weighted, 1.2345)))
        }
    }

    @Test fun weightQuantityMustMeetServerMinimum() {
        val weighted = product(unit = "kg")
        assertThrows(IllegalArgumentException::class.java) {
            PosCart.validate(listOf(CartLine(weighted, 0.0000001)))
        }
        PosCart.validate(listOf(CartLine(weighted, 0.001)))
    }

    @Test fun aggregateStockCountsLooseUnitsAndPacksTogether() {
        val item = product(stock = 5.0, packSize = 4, packPrice = 35.0)
        val lines = listOf(CartLine(item, 1.0, isPack = true), CartLine(item, 2.0))
        assertEquals(6.0, lines.sumOf { it.stockUnits }, 0.0)
        val error = assertThrows(IllegalArgumentException::class.java) { PosCart.validate(lines) }
        assertTrue(error.message!!.contains("Stock insuficiente"))
    }

    @Test fun pieceStockIsEnforcedEvenWhenSnapshotSaysNotToTrack() {
        val item = product(stock = 1.0, trackStock = false)
        val error = assertThrows(IllegalArgumentException::class.java) {
            PosCart.validate(listOf(CartLine(item, 2.0)))
        }
        assertTrue(error.message!!.contains("Stock insuficiente"))
    }

    @Test fun conflictingStockSnapshotsUseTheLowestAvailability() {
        val staleHigh = product(stock = 5.0)
        val currentLow = product(stock = 3.0)
        val lines = listOf(CartLine(staleHigh, 2.0), CartLine(currentLow, 2.0))
        val error = assertThrows(IllegalArgumentException::class.java) { PosCart.validate(lines) }
        assertTrue(error.message!!.contains("hay 3.0"))
    }

    @Test fun packageQuantityMustBeAnInteger() {
        val item = product(packSize = 4, packPrice = 35.0)
        assertThrows(IllegalArgumentException::class.java) {
            PosCart.validate(listOf(CartLine(item, 1.5, isPack = true)))
        }
    }

    @Test fun totalRoundsEachLineBeforeSummingLikeServer() {
        val first = CartLine(product(id = 1, price = 0.005), 1.0)
        val second = CartLine(product(id = 2, price = 0.005), 1.0)
        assertEquals(0.01, first.lineTotal, 0.0)
        assertEquals(0.02, PosCart.total(listOf(first, second)), 0.0)
    }

    @Test fun weightedItemsDoNotBlockSaleForInsufficientStock() {
        val weighted = product(unit = "lb", stock = 0.0, trackStock = true)
        PosCart.validate(listOf(CartLine(weighted, 2.5)))
    }

    @Test fun rejectsNegativeAndNonFiniteQuantities() {
        val item = product()
        listOf(-1.0, Double.NaN, Double.POSITIVE_INFINITY).forEach { quantity ->
            assertThrows(IllegalArgumentException::class.java) {
                PosCart.validate(listOf(CartLine(item, quantity)))
            }
        }
    }

    @Test fun repeatedCheckoutTapMergesLineAndUsesLatestProductSnapshot() {
        val oldSnapshot = product(price = 10.0)
        val latestSnapshot = product(name = "Precio actualizado", price = 12.0, stock = 8.0)
        val once = PosCart.add(emptyList(), oldSnapshot, 1.0)
        val twice = PosCart.add(once, latestSnapshot, 2.0)

        assertEquals(1, twice.size)
        assertEquals(3.0, twice.single().quantity, 0.0)
        assertEquals("Precio actualizado", twice.single().product.name)
        assertEquals(36.0, PosCart.total(twice), 0.0)
        assertFalse(PosCart.changeQuantity(twice, 0, 0.0).isNotEmpty())
    }

    @Test fun tapAddsOneMoreToExistingLineAndStopsAtStock() {
        val item = product(stock = 2.0)
        val once = PosCart.add(emptyList(), item, 1.0)
        val twice = PosCart.add(once, item, 1.0)
        assertEquals(2.0, twice.single().quantity, 0.0)
        val error = assertThrows(IllegalArgumentException::class.java) { PosCart.add(twice, item, 1.0) }
        assertTrue(error.message!!.contains("Stock insuficiente"))
        assertEquals(2.0, twice.single().quantity, 0.0)
    }

    @Test fun addRejectsNegativeIncrementBeforeMergingExistingLine() {
        val item = product()
        val existing = listOf(CartLine(item, 2.0))
        assertThrows(IllegalArgumentException::class.java) {
            PosCart.add(existing, item, -1.0)
        }
        assertEquals(2.0, existing.single().quantity, 0.0)
    }
}
