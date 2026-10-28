package cu.mypimes.pos.data.sync

import java.io.IOException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Bajada del dueño: almacén con borrados, pases, entradas, cursores y recorrido por páginas. */
class OwnerPullTest {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    private fun item(id: Long, name: String, qty: Double = 1.0, extra: Boolean = true) = buildJsonObject {
        put("id", id); put("name", name); put("unit", JsonPrimitive(null as String?)); put("cost", 10.0); put("quantity", qty)
        if (extra) put("user_id", 1)
    }
    private fun state(id: Long, name: String, qty: Double, unit: String? = null) = buildJsonObject {
        put("id", id); put("name", name); put("unit", unit); put("cost", 12.0); put("quantity", qty)
    }
    private fun page(
        items: List<JsonObject> = emptyList(), states: List<JsonObject> = emptyList(), live: List<Long>? = null,
        cursors: Map<String, Long>? = null, hasMore: Boolean = false,
    ) = ChangesPage(warehouseItems = items, warehouseStates = states, warehouseLiveIds = live, cursors = cursors, hasMore = hasMore)

    @Test fun warehousePagesInsertRefreshAndDeleteByLiveIds() {
        val first = ChangesReconciler.warehouseRows(emptyMap(), page(items = listOf(item(1, "Arroz", 5.0), item(2, "Aceite"))))
        assertEquals(setOf("1", "2"), first.upserts.keys); assertTrue(first.deletes.isEmpty())
        val cached = first.upserts

        // Estados: refrescan cantidad, costo, nombre y unidad; lo que no es de estado se conserva.
        val refreshed = ChangesReconciler.warehouseRows(cached, page(states = listOf(state(1, "Arroz blanco", 3.5, "kg"))))
        val row = refreshed.upserts.getValue("1")
        assertEquals("Arroz blanco", (row["name"] as JsonPrimitive).content)
        assertEquals("kg", (row["unit"] as JsonPrimitive).content)
        assertEquals(3.5, (row["quantity"] as JsonPrimitive).content.toDouble(), 0.0)
        assertEquals("1", (row["user_id"] as JsonPrimitive).content)
        assertEquals(setOf("1"), refreshed.upserts.keys) // solo lo que cambió

        // Pasada completa (cursor en 0): los ids que ya no están vivos se borran.
        val withDeletes = ChangesReconciler.warehouseRows(cached, page(states = listOf(state(1, "Arroz", 5.0)), live = listOf(1L)))
        assertEquals(setOf("2"), withDeletes.deletes)
        assertEquals(setOf("1"), withDeletes.upserts.keys)

        // Un estado de una fila que aún no se bajó la crea; no se pierde.
        val created = ChangesReconciler.warehouseRows(emptyMap(), page(states = listOf(state(9, "Nuevo", 2.0))))
        assertEquals("Nuevo", (created.upserts.getValue("9")["name"] as JsonPrimitive).content)
    }

    @Test fun warehouseApplyIsIdempotentAndNoLiveIdsMeansNoDeletes() {
        val p = page(items = listOf(item(1, "Arroz")), states = listOf(state(1, "Arroz", 1.0)))
        val once = ChangesReconciler.warehouseRows(emptyMap(), p)
        val twice = ChangesReconciler.warehouseRows(once.upserts, p)
        assertEquals(once.upserts, twice.upserts)
        assertTrue(twice.deletes.isEmpty())
        assertTrue(ChangesReconciler.warehouseRows(once.upserts, page()).upserts.isEmpty())
        // Lista vacía de vivos = tienda sin almacén: borra todo lo local (distinto de "no vino la lista").
        assertEquals(setOf("1"), ChangesReconciler.warehouseRows(once.upserts, page(live = emptyList())).deletes)
    }

    @Test fun passesStockEntriesAndCountsAreStoredByIdWithoutLines() {
        val rows = ChangesReconciler.byId(listOf(item(4, "Pase"), item(4, "Pase"), buildJsonObject { put("name", "sin id") }))
        assertEquals(setOf("4"), rows.keys)
        val counts = ChangesReconciler.countRows(listOf(buildJsonObject { put("id", 3); put("lines_count", 2); put("items", JsonPrimitive("x")) }))
        assertFalse(counts.getValue("3").containsKey("items"))
        assertTrue(counts.getValue("3").containsKey("lines_count"))
    }

    @Test fun olderThanUsesTheServerTimestampAndKeepsUnreadableRows() {
        val cutoff = java.time.Instant.parse("2026-07-30T04:00:00Z")
        fun row(at: String?) = buildJsonObject { put("id", 1); if (at != null) put("created_at", at) }
        val old = ChangesReconciler.olderThan(listOf("a" to row("2026-07-30 03:59:59"), "b" to row("2026-07-30 04:00:00"), "c" to row(null), "d" to row("?")), "created_at", cutoff)
        assertEquals(listOf("a"), old)
    }

    @Test fun ownerQueriesAskForWarehouseCursorsAndCashiersDoNot() {
        val owner = ChangesCursors.query(mapOf("warehouse" to 8L), null, owner = true)
        assertEquals("8", owner["after_warehouse"]); assertEquals("0", owner["after_warehouse_state"])
        assertEquals("0", owner["after_warehouse_transfer"]); assertEquals("0", owner["after_stock_entry"])
        assertEquals(14, owner.keys.count { it.startsWith("after_") })
        assertNull(ChangesCursors.query(emptyMap(), null)["after_warehouse"])
    }

    @Test fun warehouseStateCursorResetsAfterAFullPassLikeSaleState() {
        val mid = ChangesCursors.toRows(mapOf("warehouse_state" to 30L, "warehouse" to 9L), emptyMap(), hasMore = true, sinceMillis = 5L, owner = true, now = 99L)
        assertEquals(30L, mid["warehouse_state"]); assertEquals(9L, mid["warehouse"]); assertNull(mid[ChangesCursors.LAST_OK])
        val done = ChangesCursors.toRows(mapOf("warehouse_state" to 55L, "stock_entry" to 4L), mid, hasMore = false, sinceMillis = 5L, owner = true, now = 99L)
        assertEquals(0L, done["warehouse_state"])
        assertEquals(9L, done["warehouse"]); assertEquals(4L, done["stock_entry"])
        assertEquals(99L, done[ChangesCursors.LAST_OK]); assertEquals(ChangesCursors.HISTORY_DAYS, done[ChangesCursors.HISTORY])
    }

    private fun cursors(sale: Long, warehouse: Long) = ChangesCursors.paramsFor(true).keys.associateWith { 0L } + mapOf("sale" to sale, "warehouse" to warehouse)

    @Test fun cursorsDoNotAdvanceWhenApplyingAPageFailsHalfway() = runBlocking {
        val served = listOf(
            page(cursors = cursors(10, 5), hasMore = true),
            page(cursors = cursors(20, 9), hasMore = false),
        )
        val requested = mutableListOf<Map<String, String>>()
        var fetched = 0
        val committed = mutableListOf<Map<String, Long>>() // lo que quedaría guardado en Room (apply atómico)
        var failSecond = true
        val run = suspend {
            pullPages(ChangesCursors.paramsFor(true).keys.associateWith { 0L }, null, true, now = { 7L },
                fetch = { requested += it; served[fetched++] },
                apply = { _, rows -> if (rows["sale"] == 20L && failSecond) throw IllegalStateException("se cortó la transacción"); committed += rows })
        }
        try { run(); fail("debía fallar") } catch (_: IllegalStateException) {}
        assertEquals(1, committed.size) // la 2.ª página no guardó nada, ni datos ni cursores
        assertEquals(10L, committed.single()["sale"])
        assertNull(committed.single()[ChangesCursors.LAST_OK]) // la pasada no se da por terminada
        assertEquals("10", requested[1]["after_sale"]) // el pedido 2 usó el cursor de la página 1, ya aplicada

        // Reintento desde lo guardado: repite justo la página que falló y esta vez termina.
        failSecond = false; fetched = 1; requested.clear()
        pullPages(committed.single().filterKeys { it in ChangesCursors.paramsFor(true) }, 5L, true, now = { 7L },
            fetch = { requested += it; served[fetched++] }, apply = { _, rows -> committed += rows })
        assertEquals("10", requested.single()["after_sale"])
        assertEquals(20L, committed.last()["sale"]); assertEquals(7L, committed.last()[ChangesCursors.LAST_OK])
    }

    @Test fun aServerThatDoesNotAdvanceStopsInsteadOfLooping() = runBlocking {
        val stuck = page(cursors = cursors(0, 0), hasMore = true)
        try {
            pullPages(ChangesCursors.paramsFor(true).keys.associateWith { 0L }, null, true, fetch = { stuck }, apply = { _, _ -> })
            fail("debía detenerse")
        } catch (error: IOException) { assertTrue(error.message!!.contains("avanzar")) }
    }

    @Test fun decodesTheOwnerFieldsOfASnapshotPage() {
        val decoded: ChangesPage = json.decodeFromString("""{"warehouse_items":[{"id":1,"name":"A"}],"warehouse_states":[{"id":1,"name":"A","unit":null,"cost":1,"quantity":2}],"warehouse_live_ids":[1],"warehouse_transfers":[{"id":3}],"stock_entries":[{"id":4}],"inventory_counts":[{"id":5}],"cursors":{"warehouse":1},"has_more":false}""")
        assertEquals(listOf(1L), decoded.warehouseLiveIds)
        assertEquals(1, decoded.warehouseTransfers.size); assertEquals(1, decoded.stockEntries.size); assertEquals(1, decoded.inventoryCounts.size)
        assertNull(json.decodeFromString<ChangesPage>("""{"cursors":{},"has_more":false}""").warehouseLiveIds) // sin lista: no se borra nada
    }
}
