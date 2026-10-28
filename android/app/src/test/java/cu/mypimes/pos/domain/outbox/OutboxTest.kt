package cu.mypimes.pos.domain.outbox

import cu.mypimes.pos.data.local.QueuedOperationEntity
import cu.mypimes.pos.data.local.shopPrefix
import cu.mypimes.pos.data.pos.CreateSaleRequest
import cu.mypimes.pos.data.pos.SaleItemRequest
import cu.mypimes.pos.data.store.CountLineRequest
import cu.mypimes.pos.data.store.CreateInventoryCountRequest
import cu.mypimes.pos.domain.pos.CartLine
import cu.mypimes.pos.domain.pos.PosProduct
import cu.mypimes.pos.domain.pos.PosSale
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OutboxTest {
    private val json = Json { encodeDefaults = true }

    private fun op(id: String, type: String, at: Long, status: String = "pending", error: String? = null, path: String = "/api/x", payload: String = "{}", ref: String? = null) =
        QueuedOperationEntity(id, "1:1", type, path, "POST", payload, status, at, 0, error, entityRef = ref)

    // ---- gate -----------------------------------------------------------------------------------

    @Test fun anOperationWaitsWhileItsDependencyIsPendingAndGoesWhenItIsConfirmed() {
        val create = op("c", Outbox.PRODUCT_CREATE, 1)
        assertTrue(Outbox.gate(listOf("c")) { create } is Outbox.Gate.Wait)
        assertTrue(Outbox.gate(listOf("c")) { null } is Outbox.Gate.Ready) // confirmada: salió de la cola
        assertTrue(Outbox.gate(emptyList()) { null } is Outbox.Gate.Ready)
    }

    @Test fun aRejectedDependencyBlocksAndSaysWhy() {
        val create = op("c", Outbox.PRODUCT_CREATE, 1, status = "conflict", error = "Ya existe")
        val gate = Outbox.gate(listOf("c")) { create } as Outbox.Gate.Block
        assertTrue(gate.reason.startsWith(Outbox.DEP_PREFIX))
        assertTrue(gate.reason.contains("alta del producto") && gate.reason.contains("Ya existe"))
    }

    // ---- cascada --------------------------------------------------------------------------------

    @Test fun rejectionCascadesToEveryDependentAndNothingIsDeleted() {
        val queue = listOf(
            op("c", Outbox.PRODUCT_CREATE, 1, status = "failed", error = "Nombre inválido", ref = "-1"),
            op("s", "sale", 2), op("n", "inventory_count", 3), op("s2", "sale", 4), op("free", "sale", 5),
        )
        val deps = mapOf("s" to listOf("c"), "n" to listOf("c"), "s2" to listOf("s"))
        val plan = Outbox.settle(queue, deps)
        assertEquals(setOf("s", "n", "s2"), plan.block.keys) // s2 cuelga de s, que a su vez quedó bloqueada
        assertTrue(plan.block.values.all { it.startsWith(Outbox.DEP_PREFIX) })
        assertTrue(plan.unblock.isEmpty())
    }

    @Test fun retryingTheDependencyUnblocksOnlyWhatWasBlockedForIt() {
        val reason = "${Outbox.DEP_PREFIX} el alta del producto, que no se subió"
        val queue = listOf(
            op("c", Outbox.PRODUCT_CREATE, 1), // reintentada: pending
            op("s", "sale", 2, status = "blocked", error = reason),
            op("forbidden", "sale", 3, status = "blocked", error = "Operación no permitida"), // bloqueada por otra causa
        )
        val plan = Outbox.settle(queue, mapOf("s" to listOf("c"), "forbidden" to listOf("c")))
        assertEquals(setOf("s"), plan.unblock)
        assertTrue(plan.block.isEmpty())
    }

    // ---- orden global: simula la pasada de StoreRepository.sync con las mismas reglas -----------

    private fun drain(queue: MutableList<QueuedOperationEntity>, deps: Map<String, List<String>>, rejects: Set<String>): List<String> {
        val sent = mutableListOf<String>()
        fun settle() = Outbox.settle(queue, deps).let { plan ->
            plan.block.forEach { (id, why) -> queue.replaceAll { if (it.clientOperationId == id) it.copy(status = "blocked", lastError = why) else it } }
        }
        settle()
        for (queued in queue.filter { it.status == "pending" }.sortedBy { it.createdAt }) {
            val current = queue.first { it.clientOperationId == queued.clientOperationId }
            if (current.status != "pending") continue
            val gate = Outbox.gate(deps[current.clientOperationId].orEmpty()) { id -> queue.firstOrNull { it.clientOperationId == id } }
            if (gate !is Outbox.Gate.Ready) continue
            sent += current.clientOperationId
            if (current.clientOperationId in rejects) queue.replaceAll { if (it.clientOperationId == current.clientOperationId) it.copy(status = "conflict", lastError = "409") else it }
            else queue.removeAll { it.clientOperationId == current.clientOperationId } // confirmada
            settle()
        }
        return sent
    }

    @Test fun theGlobalPassFollowsCreatedAtAndHoldsBackDependents() {
        val queue = mutableListOf(
            op("withdraw", "withdrawal", 1), op("create", Outbox.PRODUCT_CREATE, 2, ref = "-1"),
            op("sale", "sale", 3), op("count", "inventory_count", 4), op("close", "close", 5),
        )
        val deps = mapOf("sale" to listOf("create"), "count" to listOf("create"))
        assertEquals(listOf("withdraw", "create", "sale", "count", "close"), drain(queue, deps, emptySet()))
        assertTrue(queue.isEmpty())
    }

    @Test fun aRejectedCreateBlocksSaleAndCountButNotUnrelatedWork() {
        val queue = mutableListOf(
            op("create", Outbox.PRODUCT_CREATE, 1, ref = "-1"), op("sale", "sale", 2), op("count", "inventory_count", 3), op("close", "close", 4),
        )
        val sent = drain(queue, mapOf("sale" to listOf("create"), "count" to listOf("create")), rejects = setOf("create"))
        assertEquals(listOf("create", "close"), sent)
        val left = queue.associateBy { it.clientOperationId }
        assertEquals(setOf("create", "sale", "count"), left.keys) // nada se borra
        assertEquals("conflict", left.getValue("create").status)
        assertEquals("blocked", left.getValue("sale").status)
        assertEquals("blocked", left.getValue("count").status)
        assertTrue(left.getValue("sale").lastError!!.startsWith(Outbox.DEP_PREFIX))
    }

    // ---- ids temporales -------------------------------------------------------------------------

    private fun saleBody(vararg ids: Long) = json.encodeToString(CreateSaleRequest(
        clientSaleId = "s1", registerId = "r", soldAt = "2026-10-28T10:00:00Z",
        items = ids.map { SaleItemRequest(it, 1.0, 10.0) }, paymentMethod = "efectivo", cashReceived = 10.0 * ids.size,
    ))
    private fun countBody(vararg ids: Long) = json.encodeToString(CreateInventoryCountRequest("c1", ids.map { CountLineRequest(it, 3.0) }, null))

    @Test fun createdOfflineProductIsRewrittenInSaleCountAndPathThenRepeatingChangesNothing() {
        val sale = saleBody(-1, 7)
        val count = countBody(-1, 7)
        assertEquals(setOf(Outbox.Entity.PRODUCT to -1L), Outbox.tempRefs("/api/sales", sale))
        assertEquals(setOf(Outbox.Entity.PRODUCT to -1L), Outbox.tempRefs("/api/products/-1", "{}"))

        val (path1, sale1) = Outbox.rewrite(Outbox.Entity.PRODUCT, -1, 55, "/api/sales", sale)!!
        val decodedSale = json.decodeFromString<CreateSaleRequest>(sale1)
        assertEquals(listOf(55L, 7L), decodedSale.items.map { it.productId })
        assertEquals("/api/sales", path1)
        assertEquals("s1", decodedSale.clientSaleId) // el resto del cuerpo (y su id) no cambia

        val (_, count1) = Outbox.rewrite(Outbox.Entity.PRODUCT, -1, 55, "/api/inventory-counts", count)!!
        assertEquals(listOf(55L, 7L), json.decodeFromString<CreateInventoryCountRequest>(count1).items.map { it.productId })
        assertEquals("/api/products/55", Outbox.rewrite(Outbox.Entity.PRODUCT, -1, 55, "/api/products/-1", "{}")!!.first)

        // Idempotente: una segunda confirmación ya no encuentra nada que reescribir.
        assertNull(Outbox.rewrite(Outbox.Entity.PRODUCT, -1, 55, "/api/sales", sale1))
        assertNull(Outbox.rewrite(Outbox.Entity.PRODUCT, -1, 55, "/api/inventory-counts", count1))
    }

    @Test fun rewriteIgnoresLookAlikeIdsAndOtherEntities() {
        assertNull(Outbox.rewrite(Outbox.Entity.PRODUCT, -1, 55, "/api/sales", saleBody(-10, 1)))
        assertNull(Outbox.rewrite(Outbox.Entity.PRODUCT, -1, 55, "/api/warehouse/-1", "{}")) // el -1 del almacén es otro registro
        assertEquals("/api/warehouse/9", Outbox.rewrite(Outbox.Entity.WAREHOUSE, -1, 9, "/api/warehouse/-1", "{}")!!.first)
        assertEquals("/api/products/55/x", Outbox.rewrite(Outbox.Entity.PRODUCT, -1, 55, "/api/products/-1/x", "{}")!!.first)
    }

    @Test fun cachedSalesPointToTheRealProductAfterwardsToo() {
        val sale = PosSale("s1", 20.0, 20.0, "2026-10-28T10:00:00Z", "pending", lines = listOf(
            CartLine(PosProduct(-1, "Nuevo", 10.0, 0.0), 2.0), CartLine(PosProduct(7, "Viejo", 10.0, 5.0), 1.0),
        ))
        val fixed = Outbox.rewriteSale(sale, -1, 55)!!
        assertEquals(listOf(55L, 7L), fixed.lines.map { it.product.id })
        assertNull(Outbox.rewriteSale(fixed, -1, 55))
    }

    @Test fun sameBodyStaysByteIdenticalWhenNothingIsRewritten() {
        val body = """{"name":"Té","sale_price":10.0,"operation_id":"abc-123"}"""
        assertNull(Outbox.rewrite(Outbox.Entity.PRODUCT, -1, 55, "/api/products", body)) // no se regenera ni se reordena
        assertEquals("1:%", shopPrefix("1:77"))
    }
}
