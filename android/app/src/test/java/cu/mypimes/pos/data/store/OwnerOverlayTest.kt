package cu.mypimes.pos.data.store

import cu.mypimes.pos.data.local.QueuedOperationEntity
import cu.mypimes.pos.data.pos.ProductDto
import cu.mypimes.pos.domain.outbox.Outbox
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlinx.serialization.json.Json

class OwnerOverlayTest {
    private val json = Json
    private fun op(id: String, type: String, at: Long, path: String, payload: String, status: String = "pending", error: String? = null, ref: String? = null) =
        QueuedOperationEntity(id, "1:1", type, path, "POST", payload, status, at, 0, error, entityRef = ref, ownerRole = "dueño")

    private val server = listOf(ProductDto(7, "Aceite", salePrice = 100.0, stock = 10.0, purchasePrice = 60.0))

    @Test fun offlineCreateShowsUpWithItsTemporaryNegativeId() {
        val create = op("c", Outbox.PRODUCT_CREATE, 1, "/api/products", """{"name":"Té","sale_price":25.0,"purchase_price":10.0,"stock":4,"operation_id":"c"}""", ref = "-1")
        val result = OwnerOverlay.products(server, listOf(create), json)
        assertEquals(listOf(7L, -1L), result.map { it.id })
        assertEquals(4.0, result.last().stock, 0.0)
        assertEquals(25.0, result.last().salePrice, 0.0)
    }

    @Test fun editsStockAdditionsAndDeletesApplyInOrder() {
        val ops = listOf(
            op("e1", Outbox.PRODUCT_UPDATE, 1, "/api/products/7", """{"sale_price":120.0,"add_stock":5.0,"stock":99.0,"operation_id":"e1"}"""),
            op("e2", Outbox.PRODUCT_UPDATE, 2, "/api/products/7", """{"name":"Aceite 1L","operation_id":"e2"}"""),
        )
        val edited = OwnerOverlay.products(server, ops, json).single()
        assertEquals("Aceite 1L", edited.name)
        assertEquals(120.0, edited.salePrice, 0.0)
        assertEquals(15.0, edited.stock, 0.0) // add_stock manda sobre stock, como el servidor
        assertTrue(OwnerOverlay.products(server, ops + op("d", Outbox.PRODUCT_DELETE, 3, "/api/products/7", "{}"), json).isEmpty())
    }

    @Test fun aRejectedChangeRevertsTheRowButStaysVisibleInTheQueue() {
        val rejected = op("e", Outbox.PRODUCT_UPDATE, 1, "/api/products/7", """{"sale_price":1.0}""", status = "conflict", error = "El producto cambió en otro aparato")
        assertEquals(100.0, OwnerOverlay.products(server, listOf(rejected), json).single().salePrice, 0.0)
        val shown = OwnerOverlay.unsettled(listOf(rejected))
        assertEquals(listOf("El producto cambió en otro aparato"), shown.map { it.lastError })
    }

    @Test fun aServerRefreshNeverErasesAPendingCreate() {
        val create = op("c", Outbox.PRODUCT_CREATE, 1, "/api/products", """{"name":"Té","sale_price":25.0}""", ref = "-2")
        val refreshedFromServer = server + ProductDto(8, "Sal", salePrice = 5.0)
        assertEquals(listOf(7L, 8L, -2L), OwnerOverlay.products(refreshedFromServer, listOf(create), json).map { it.id })
    }

    @Test fun warehouseCreateEditAndDelete() {
        val base = listOf(WarehouseItemDto(3, "Harina", "lb", 2.0, 10.0))
        val ops = listOf(
            op("w1", Outbox.WAREHOUSE_CREATE, 1, "/api/warehouse", """{"name":"Azúcar","cost":3.0,"unit":null,"quantity":8.0}""", ref = "-1"),
            op("w2", Outbox.WAREHOUSE_UPDATE, 2, "/api/warehouse/3", """{"name":"Harina","cost":2.5,"unit":"lb","add_quantity":5.0}"""),
            op("w3", Outbox.WAREHOUSE_UPDATE, 3, "/api/warehouse/-1", """{"name":"Azúcar","cost":3.5,"unit":null,"add_quantity":2.0}"""),
        )
        val result = OwnerOverlay.warehouse(base, ops, json).associateBy { it.id }
        assertEquals(15.0, result.getValue(3).quantity, 0.0)
        assertEquals(2.5, result.getValue(3).cost, 0.0)
        assertEquals(10.0, result.getValue(-1).quantity, 0.0)
        assertEquals(3.5, result.getValue(-1).cost, 0.0)
        assertTrue(OwnerOverlay.warehouse(base, ops + op("w4", Outbox.WAREHOUSE_DELETE, 4, "/api/warehouse/3", "{}"), json).none { it.id == 3L })
    }
}
