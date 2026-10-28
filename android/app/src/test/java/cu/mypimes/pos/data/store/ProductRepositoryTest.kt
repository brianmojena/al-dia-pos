package cu.mypimes.pos.data.store

import cu.mypimes.pos.data.pos.ProductDto
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ProductRepositoryTest {
    @Test fun editingAPackProductShowsPacksLooseAndCostPerLoose() {
        val draft = ProductDto(id = 9, name = "Popular", salePrice = 15.0, stock = 67.0, packSize = 20, packPrice = 280.0,
            purchasePrice = 2.5).toDraft()
        assertTrue(draft.packOn)
        assertEquals("3", draft.stockPacks)
        assertEquals("7", draft.stockLoose)
        assertEquals("20", draft.packSize)
        assertEquals("50", draft.packCost)
        assertEquals(67.0, draft.stockValue()!!, 1e-9)
    }

    @Test fun cachedRowWithoutPurchasePriceLeavesTheFieldBlank() {
        // Caché de una versión anterior: sin costo, el formulario lo deja vacío y no envía 0.
        val draft = ProductDto(id = 1, name = "Arroz", salePrice = 300.0, stock = 12.0).toDraft()
        assertEquals("", draft.purchasePrice)
        assertEquals("12", draft.stock)
        assertTrue(!draft.byWeight)
    }

    @Test fun weighedProductKeepsUnitAndTrackFlag() {
        val draft = ProductDto(id = 2, name = "Queso", salePrice = 800.0, stock = 2.5, unit = "kg", trackStock = 0).toDraft()
        assertTrue(draft.byWeight)
        assertEquals("kg", draft.unit)
        assertEquals(false, draft.trackStock)
    }

    @Test fun explicitNullsAreSentSoTheServerClearsUnitAndPack() {
        // El servidor distingue "no vino" de "null": sin esto no se puede quitar la unidad ni el paquete.
        val body = Json { explicitNulls = false }.encodeToString(
            kotlinx.serialization.json.JsonObject.serializer(),
            buildJsonObject { put("unit", null as String?); put("pack_size", null as Number?) },
        )
        assertEquals("{\"unit\":null,\"pack_size\":null}", body)
    }
}
