package cu.mypimes.pos.domain.warehouse

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WarehouseItemFormTest {
    private val taken = listOf("Arroz", "Harina de trigo")

    @Test fun nameIsRequiredAndUniqueIgnoringAccentsAndCase() {
        assertEquals("Falta el nombre del artículo", warehouseItemError("  ", "", null, "", null, taken))
        assertEquals("Ya hay un artículo con ese nombre en el almacén", warehouseItemError("  ARROZ ", "", null, "", null, taken))
        assertEquals("Ya hay un artículo con ese nombre en el almacén", warehouseItemError("harina  de trigo", "", null, "", null, taken))
        assertNull(warehouseItemError("Azúcar", "", null, "", null, taken))
    }

    @Test fun costIsOptionalButMustBeANonNegativeNumber() {
        assertNull(warehouseItemError("Azúcar", "", null, "", null, taken))
        assertNull(warehouseItemError("Azúcar", "12,5", null, "", null, taken))
        assertEquals("El costo no es válido", warehouseItemError("Azúcar", "abc", null, "", null, taken))
        assertEquals("El costo no es válido", warehouseItemError("Azúcar", "-1", null, "", null, taken))
    }

    @Test fun initialQuantityOnCreateFollowsTheUnit() {
        assertNull(warehouseItemError("Azúcar", "", "kg", "2,5", null, taken))
        assertNull(warehouseItemError("Azúcar", "", null, "", null, taken))
        assertEquals("La cantidad debe ser un entero mayor o igual a 0", warehouseItemError("Azúcar", "", null, "1.5", null, taken))
        assertEquals("La cantidad debe ser un número mayor o igual a 0 (hasta 3 decimales)", warehouseItemError("Azúcar", "", "kg", "1.2345", null, taken))
    }

    @Test fun restockOnEditMustBePositiveAndFitTheUnit() {
        assertNull(warehouseItemError("Arroz", "", "kg", "3", 5.0, taken.drop(1)))
        assertNull(warehouseItemError("Arroz", "", null, "", 5.0, taken.drop(1)))
        assertEquals("La cantidad a añadir debe ser un entero mayor que 0", warehouseItemError("Arroz", "", null, "0", 5.0, taken.drop(1)))
        assertEquals("La cantidad a añadir debe ser un entero mayor que 0", warehouseItemError("Arroz", "", null, "2.5", 5.0, taken.drop(1)))
    }

    @Test fun editingKeepsItsOwnNameButNotAnotherItems() {
        // takenNames son los OTROS artículos: el propio nombre no cuenta.
        assertNull(warehouseItemError("arroz", "", null, "", 5.0, listOf("Harina")))
        assertEquals("Ya hay un artículo con ese nombre en el almacén", warehouseItemError("Harina", "", null, "", 5.0, listOf("Harina")))
    }

    @Test fun removingTheUnitNeedsWholePiecesWhenNoRestockIsGiven() {
        assertEquals("Al quitar la unidad de medida hay que poner la cantidad en piezas enteras", warehouseItemError("Arroz", "", null, "", 2.5, emptyList()))
        assertNull(warehouseItemError("Arroz", "", null, "", 2.0, emptyList()))
        assertNull(warehouseItemError("Arroz", "", null, "4", 2.5, emptyList()))
    }
}
