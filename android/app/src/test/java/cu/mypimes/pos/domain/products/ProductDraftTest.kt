package cu.mypimes.pos.domain.products

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProductDraftTest {
    private val create = ProductDraft(name = "Arroz", salePrice = "300")

    @Test fun createNeedsNameAndSalePrice() {
        assertEquals("Escribe el nombre del producto", create.copy(name = "  ").validationError(editing = false, owner = true))
        assertEquals("El precio de venta debe ser un número de 0 o más", create.copy(salePrice = "").validationError(false, true))
        assertNull(create.copy(name = "Arroz").validationError(false, true))
    }

    @Test fun salePriceZeroIsAllowedLikeTheServerButNegativeIsNot() {
        assertNull(create.copy(salePrice = "0").validationError(false, true))
        assertEquals("El precio de venta debe ser un número de 0 o más", create.copy(salePrice = "-1").validationError(false, true))
        assertEquals("El precio de venta debe ser un número de 0 o más", create.copy(salePrice = "NaN").validationError(false, true))
    }

    @Test fun commaDecimalsAreAccepted() {
        assertEquals(2.5, number("2,5")!!, 1e-9)
        assertNull(number("abc"))
        assertEquals("El precio de venta debe ser un número de 0 o más", create.copy(salePrice = "12,5,5").validationError(false, true))
    }

    @Test fun purchasePriceIsOptionalButMustBeValidWhenGiven() {
        assertNull(create.copy(purchasePrice = "").validationError(false, true))
        assertEquals("El precio de compra no es válido", create.copy(purchasePrice = "-3").validationError(false, true))
    }

    @Test fun packNeedsTwoOrMoreUnitsAndAPrice() {
        val pack = create.copy(packOn = true, packPrice = "800")
        assertNull(pack.copy(packSize = "20").validationError(false, true))
        assertEquals("El paquete debe traer de 2 a 10000 unidades", pack.copy(packSize = "1").validationError(false, true))
        assertEquals("El paquete debe traer de 2 a 10000 unidades", pack.copy(packSize = "2.5").validationError(false, true))
        assertEquals("El paquete debe traer de 2 a 10000 unidades", pack.copy(packSize = "20000").validationError(false, true))
        assertEquals("Falta el precio del paquete o no es válido", pack.copy(packSize = "20", packPrice = "").validationError(false, true))
    }

    @Test fun packCannotBeWeighed() {
        val both = create.copy(packOn = true, packSize = "20", packPrice = "800", byWeight = true)
        assertEquals("Un producto por peso no se vende por paquete", both.validationError(false, true))
    }

    @Test fun packStockIsPacksTimesSizePlusLoose() {
        val draft = create.copy(packOn = true, packSize = "20", packPrice = "800", stockPacks = "3", stockLoose = "7")
        assertEquals(67.0, draft.stockValue()!!, 1e-9)
        assertEquals("Paquetes y sueltos deben ser números enteros de 0 o más",
            draft.copy(stockLoose = "1.5").validationError(false, true))
    }

    @Test fun costPerLooseUsesPackCostWhenGiven() {
        val draft = create.copy(packOn = true, packSize = "20", purchasePrice = "9", packCost = "100")
        assertEquals(5.0, draft.costPerUnit()!!, 1e-9)
        assertEquals(9.0, create.copy(purchasePrice = "9").costPerUnit()!!, 1e-9)
        assertNull(create.costPerUnit())
    }

    @Test fun pieceStockMustBeWholeAndWeightStockUpToThreeDecimals() {
        assertEquals("El stock debe ser un número entero mayor o igual a 0", create.copy(stock = "2.5").validationError(false, true))
        assertEquals("El stock debe ser un número mayor o igual a 0 (hasta 3 decimales)",
            create.copy(byWeight = true, unit = "kg", stock = "2.1234").validationError(false, true))
        assertNull(create.copy(byWeight = true, unit = "kg", stock = "2.123").validationError(false, true))
        assertNull(create.copy(byWeight = true, unit = "kg", stock = "2,5").validationError(false, true))
    }

    @Test fun negativeStockIsRejected() {
        assertEquals("El stock debe ser un número entero mayor o igual a 0", create.copy(stock = "-1").validationError(false, true))
    }

    @Test fun untrackedWeightProductSkipsStockChecks() {
        val draft = create.copy(byWeight = true, unit = "lb", trackStock = false, stock = "garbage")
        assertTrue(draft.validationError(false, true) == null)
        assertFalse(draft.tracksStock)
    }

    @Test fun addStockMustBeNonNegativeAndWholeForPieces() {
        val edit = create.copy(addStock = "-2")
        assertEquals("La cantidad a añadir debe ser un número entero mayor o igual a 0",
            edit.validationError(editing = true, owner = true))
        assertEquals("La cantidad a añadir debe ser un número entero mayor o igual a 0",
            create.copy(addStock = "1.5").validationError(editing = true, owner = true))
        assertNull(create.copy(addStock = "4").validationError(editing = true, owner = true))
        assertNull(create.copy(byWeight = true, unit = "kg", addStock = "1.5").validationError(editing = true, owner = true))
    }

    @Test fun cashierEditOnlyChecksSalePriceAndAddedStock() {
        // Un cajero no edita nombre, costo ni stock: datos viejos o vacíos no le bloquean la venta de precio.
        val cashier = ProductDraft(name = "", salePrice = "350", purchasePrice = "-5", stock = "x", addStock = "2")
        assertNull(cashier.validationError(editing = true, owner = false))
        assertEquals("El precio de venta debe ser un número de 0 o más",
            cashier.copy(salePrice = "").validationError(editing = true, owner = false))
    }

    @Test fun stockLabelShowsPacksLooseAndNoControl() {
        assertEquals("3 paq + 7 sueltos", stockLabel(67.0, null, true, 20))
        assertEquals("2 paq", stockLabel(40.0, null, true, 20))
        assertEquals("7 sueltos", stockLabel(7.0, null, true, 20))
        assertEquals("12", stockLabel(12.0, null, true, null))
        assertEquals("2,5 kg", stockLabel(2.5, "kg", true, null))
        assertEquals("Sin control", stockLabel(2.5, "kg", false, null))
    }
}
