package cu.mypimes.pos.domain.warehouse

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class WarehouseTransferTest {
    @Test fun quantityMustBePositiveAndFitTheUnit() {
        assertNull(transferQuantityError("2", "kg", 5.0))
        assertNull(transferQuantityError("2,5", "kg", 5.0))
        assertNotNull(transferQuantityError("0", "kg", 5.0))
        assertNotNull(transferQuantityError("", "kg", 5.0))
        assertNotNull(transferQuantityError("1.2345", "kg", 5.0))
        assertNotNull(transferQuantityError("1.5", null, 5.0))
    }

    @Test fun quantityCannotExceedWhatIsAtTheSource() {
        assertEquals("Solo hay 5 kg", transferQuantityError("6", "kg", 5.0))
        assertEquals("Solo hay 3", transferQuantityError("4", null, 3.0))
        assertNull(transferQuantityError("3", null, 3.0))
    }

    @Test fun salePriceIsRequiredOnlyWhenTheProductIsNew() {
        assertNotNull(salePriceError("", needed = true))
        assertNull(salePriceError("150", needed = true))
        assertNull(salePriceError("", needed = false))
    }

    @Test fun namesMatchLikeTheServerIgnoringAccentsCaseAndSpaces() {
        assertEquals(warehouseKey("Café con Leche"), warehouseKey("  cafe   CON leche "))
        assertNotEquals(warehouseKey("Arroz"), warehouseKey("Arroz integral"))
    }
}
