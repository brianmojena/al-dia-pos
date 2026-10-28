package cu.mypimes.pos.data.pos

import cu.mypimes.pos.data.local.LocalDao
import cu.mypimes.pos.data.local.QueueRepository
import cu.mypimes.pos.data.local.QueuedOperationEntity
import cu.mypimes.pos.domain.outbox.Outbox
import cu.mypimes.pos.domain.outbox.QueueReview
import cu.mypimes.pos.domain.pos.CartLine
import cu.mypimes.pos.domain.pos.PosCart
import cu.mypimes.pos.domain.pos.PosProduct
import cu.mypimes.pos.domain.pos.PosSale
import cu.mypimes.pos.domain.shared.SharedDeviceInfo
import cu.mypimes.pos.domain.shared.SharedLogic
import java.lang.reflect.Proxy
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** A7/A8/A9: catálogo y stock compartidos, cobro sin bloqueo solo en central y lectura de la cola. */
class CentralStockTest {
    private val json = Json
    private val owner = "7:7"
    private val cashier = "7:13"

    private fun device(central: Boolean) = SharedDeviceInfo("dev1", 7, "Caja", true, "2030-01-01T00:00:00Z", central)

    private fun op(id: String, account: String, type: String, at: Long, path: String, payload: String, status: String = "pending", error: String? = null, ref: String? = null) =
        QueuedOperationEntity(id, account, type, path, "POST", payload, status, at, 2, error, entityRef = ref)

    private fun saleOp(id: String, account: String, productId: Long, qty: Double, at: Long = 10, status: String = "pending", error: String? = null) =
        op(id, account, PosRepository.OP_SALE, at, "/api/sales", json.encodeToString(
            CreateSaleRequest(id, "shared:dev1", "2026-10-28T10:00:00Z", listOf(SaleItemRequest(productId, qty, 10.0)), "efectivo", 100.0),
        ), status, error)

    @Test fun inCentralModeEveryPersonOfTheDeviceSharesOneCatalogKey() {
        assertEquals("central:dev1", SharedLogic.catalogKey(device(true), owner))
        assertEquals("central:dev1", SharedLogic.catalogKey(device(true), cashier))
        // Otra tienda, caja no central o sin caja: la clave de siempre.
        assertEquals("8:8", SharedLogic.catalogKey(device(true), "8:8"))
        assertEquals(cashier, SharedLogic.catalogKey(device(false), cashier))
        assertEquals(owner, SharedLogic.catalogKey(null, owner))
    }

    @Test fun ownerCreatesWithoutNetworkAndCashierSeesAndSellsIt() {
        val create = op("c", owner, Outbox.PRODUCT_CREATE, 1, "/api/products", """{"name":"Té","sale_price":25.0,"stock":4,"operation_id":"c"}""", ref = "-1")
        val queue = listOf(create)
        assertEquals(listOf(-1L), PosStock.visible(emptyList(), queue, json).map { it.id })
        // El cajero vende 3 del producto temporal: el dueño ve 1 (la venta del cajero baja el stock visible).
        val withSale = queue + saleOp("s1", cashier, -1, 3.0)
        assertEquals(1.0, PosStock.visible(emptyList(), withSale, json).single().stock, 0.0)
    }

    @Test fun reservationsCountTheQueueOfEveryone() {
        val base = listOf(ProductDto(5, "Aceite", salePrice = 10.0, stock = 10.0))
        val queue = listOf(saleOp("a", owner, 5, 2.0), saleOp("b", cashier, 5, 3.0), saleOp("c", cashier, 5, 1.0, status = "discarded"))
        assertEquals(5.0, PosStock.reserved(queue, json)[5L]!!, 0.0) // lo descartado ya no reserva
        assertEquals(5.0, PosStock.visible(base, queue, json).single().stock, 0.0)
        // Con solo la cola de una persona (cuentas normales) el cálculo no cambia.
        assertEquals(8.0, PosStock.visible(base, queue.take(1), json).single().stock, 0.0)
    }

    @Test fun neverShowsNegativeStock() {
        val base = listOf(ProductDto(5, "Aceite", salePrice = 10.0, stock = 1.0))
        assertEquals(0.0, PosStock.visible(base, listOf(saleOp("a", owner, 5, 4.0)), json).single().stock, 0.0)
    }

    @Test fun cashierPullDoesNotEraseTheCostTheOwnerDownloaded() {
        val existing = listOf(ProductDto(5, "Aceite", salePrice = 10.0, stock = 10.0, purchasePrice = 6.0))
        val fromCashier = listOf(ProductDto(5, "Aceite", salePrice = 11.0, stock = 9.0), ProductDto(6, "Sal", salePrice = 1.0))
        val merged = PosStock.keepCosts(fromCashier, existing)
        assertEquals(6.0, merged[0].purchasePrice!!, 0.0)
        assertEquals(11.0, merged[0].salePrice, 0.0)
        assertNull(merged[1].purchasePrice)
    }

    private val low = PosProduct(1, "Aceite", 10.0, 2.0)

    @Test fun cartBlocksOnLocalStockOutsideCentralButNotInCentral() {
        assertThrows(IllegalArgumentException::class.java) { PosCart.add(emptyList(), low, 3.0) }
        val lines = PosCart.add(emptyList(), low, 3.0, enforceStock = false)
        PosCart.validate(lines, enforceStock = false)
        assertThrows(IllegalArgumentException::class.java) { PosCart.validate(lines) }
        assertEquals(listOf("Aceite"), PosCart.stockGaps(lines).map { it.name })
        assertTrue(PosCart.stockGaps(listOf(CartLine(low, 2.0))).isEmpty())
        // Lo demás sigue validándose aunque no se mire el stock.
        assertThrows(IllegalArgumentException::class.java) { PosCart.validate(listOf(CartLine(low, 1.5)), enforceStock = false) }
    }

    @Test fun indicatorCountsUnsentAndToReviewIgnoringDiscarded() {
        val ops = listOf(
            saleOp("a", owner, 5, 1.0), saleOp("b", cashier, 5, 1.0),
            saleOp("c", cashier, 5, 1.0, status = "rejected", error = "Stock insuficiente para Aceite"),
            op("d", owner, "close", 3, "/api/cash-closes", "{}", status = "conflict", error = "Ya cerrado"),
            op("e", cashier, PosRepository.OP_SALE, 4, "/api/sales", "{}", status = "blocked", error = "Depende de la venta"),
            op("f", owner, Outbox.PRODUCT_UPDATE, 5, "/api/products/1", "{}", status = "failed", error = "No"),
            saleOp("g", cashier, 5, 1.0, status = "discarded"),
        )
        val counts = QueueReview.counts(ops.filter { it.status != "discarded" })
        assertEquals(2, counts.unsent)
        assertEquals(4, counts.review)
        assertEquals("2 sin subir · 4 por revisar", counts.text)
        assertTrue(QueueReview.counts(emptyList()).clean)
        val groups = QueueReview.grouped(ops)
        assertEquals(listOf("f", "c"), groups.getValue(QueueReview.Group.REJECTED).map { it.clientOperationId })
        assertEquals(listOf("d"), groups.getValue(QueueReview.Group.CONFLICT).map { it.clientOperationId })
        assertEquals(listOf("e"), groups.getValue(QueueReview.Group.BLOCKED).map { it.clientOperationId })
    }

    @Test fun stockRejectionShowsProductQuantityAndServerStockWhenGiven() {
        val sale = PosSale("c", 30.0, 30.0, "2026-10-28T10:00:00Z", "rejected",
            lines = listOf(CartLine(PosProduct(5, "Aceite", 10.0, 0.0), 3.0), CartLine(PosProduct(6, "Sal", 1.0, 0.0), 1.0)))
        val plain = QueueReview.stockLines(sale, "Stock insuficiente para Aceite")
        assertEquals(listOf(QueueReview.StockLine("Aceite", 3.0, null)), plain)
        assertEquals(2.0, QueueReview.stockLines(sale, "Stock insuficiente para Aceite: hay 2")[0].serverStock!!, 0.0)
        assertTrue(QueueReview.stockLines(sale, "Operación no permitida").isEmpty())
        assertTrue(QueueReview.stockLines(null, "Stock insuficiente").isEmpty())
    }

    @Test fun discardOnlyMarksTheRowAndKeepsItsReasonAndData() = runBlocking {
        val calls = mutableListOf<Pair<String, List<Any?>>>()
        val dao = Proxy.newProxyInstance(javaClass.classLoader, arrayOf(LocalDao::class.java)) { _, method, args ->
            calls += method.name to args.orEmpty().toList()
            kotlin.Unit
        } as LocalDao
        val rejected = saleOp("c", cashier, 5, 3.0, status = "rejected", error = "Stock insuficiente para Aceite")
        QueueRepository(dao).discard(rejected)
        assertEquals(1, calls.size)
        assertEquals("setQueueState", calls[0].first)
        assertEquals(listOf("c", cashier, QueuedOperationEntity.STATUS_DISCARDED, 2, "Stock insuficiente para Aceite"), calls[0].second.take(5))
        assertFalse(calls.any { it.first.startsWith("delete") })
        // Descartada deja de contar, pero la fila (con su motivo) sigue en la cola.
        val after = rejected.copy(status = QueuedOperationEntity.STATUS_DISCARDED)
        assertEquals(0, QueueReview.counts(listOf(after)).review)
        assertEquals(rejected.payload, after.payload)
    }
}
