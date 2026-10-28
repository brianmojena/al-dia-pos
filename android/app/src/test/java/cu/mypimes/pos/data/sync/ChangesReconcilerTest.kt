package cu.mypimes.pos.data.sync

import cu.mypimes.pos.domain.pos.PosSale
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChangesReconcilerTest {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
    private val page: ChangesPage = json.decodeFromString(
        javaClass.classLoader!!.getResource("sync-changes-page.json")!!.readText(),
    )

    private fun sale(client: String, serverId: Long?, status: String = "synced", closeId: Long? = null) =
        PosSale(client, 100.0, 100.0, "2026-10-28 10:00:00", status, serverId = serverId, cashCloseId = closeId)

    private fun apply(cached: List<PosSale>, queued: Set<String> = emptySet(), p: ChangesPage = page): List<PosSale> {
        val byKey = cached.associateBy { it.clientSaleId }.toMutableMap()
        ChangesReconciler.reconcileSales(cached, queued, p).forEach { byKey[it.clientSaleId] = it }
        return byKey.values.toList()
    }

    @Test fun serverCloseMarksCoveredSaleAndStateReopensIt() {
        val cached = listOf(sale("c-101", 101), sale("c-103", 103, closeId = 5), sale("c-104", 104))
        val result = apply(cached).associateBy { it.clientSaleId }
        assertEquals(7L, result.getValue("c-101").cashCloseId)
        assertNull(result.getValue("c-103").cashCloseId) // reabierta
        assertEquals(7L, result.getValue("c-104").cashCloseId)
    }

    @Test fun pendingLocalSaleIsNeverOverwrittenByTheServerRow() {
        val local = sale("c-pending", null, status = "pending")
        val result = apply(listOf(local), queued = setOf("c-pending"))
        assertEquals(local, result.single { it.clientSaleId == "c-pending" })
    }

    @Test fun voidedCorrectionMarksSaleButNotAQueuedOne() {
        val result = apply(listOf(sale("c-105", 105), sale("c-x", 106))).associateBy { it.clientSaleId }
        assertEquals("voided", result.getValue("c-105").status)
        assertEquals("synced", result.getValue("c-x").status)
        val queued = apply(listOf(sale("c-105", 105, status = "pending")), queued = setOf("c-105"))
        assertEquals("pending", queued.single { it.clientSaleId == "c-105" }.status)
    }

    @Test fun reapplyingTheSamePageIsIdempotent() {
        val cached = listOf(sale("c-101", 101), sale("c-105", 105))
        val once = apply(cached)
        assertEquals(once.sortedBy { it.clientSaleId }, apply(once).sortedBy { it.clientSaleId })
        assertTrue(ChangesReconciler.reconcileSales(once, emptySet(), page).isEmpty())
    }

    @Test fun newServerSaleKeepsItemsAsReceiptLines() {
        val created = apply(emptyList()).first { it.clientSaleId == "c-101" }
        assertEquals("Refresco", created.lines.single().product.name)
        assertEquals(300.0, created.lines.single().lineTotal, 0.0)
        assertEquals(300.0, created.total, 0.0)
    }

    @Test fun withdrawalVoidedElsewhereAndClosedOnesLeaveTheOpenList() {
        val open = mapOf("31" to page.withdrawals[1], "30" to page.withdrawals[0])
        val changes = ChangesReconciler.mergeRows(open, page.withdrawals, page.withdrawalStates, emptySet(), "client_withdrawal_id", dropWhenClosed = true)
        assertEquals(setOf("30"), changes.deletes)
        assertEquals("2026-10-28 15:00:00", (changes.upserts.getValue("31")["voided_at"] as JsonPrimitive).content)
    }

    @Test fun closeCorrectionMergesFieldsInsteadOfReplacingTheRow() {
        val cached = mapOf("7" to buildJsonObject { put("id", 7); put("expected_cash", 1000); put("difference", -10) })
        val changes = ChangesReconciler.mergeRows(cached, listOf(page.saleCorrections.single().cashClose!!), emptyList(), emptySet(), "client_close_id")
        val row: JsonObject = changes.upserts.getValue("7")
        assertEquals("1000", (row["expected_cash"] as JsonPrimitive).content)
        assertEquals("0", (row["difference"] as JsonPrimitive).content)
        assertEquals(1, ChangesReconciler.closeRows(page).count { it["id"].toString() == "7" && it.containsKey("correction_revision") && it["correction_revision"].toString() == "1" })
    }

    @Test fun queuedWithdrawalRowFromServerIsSkipped() {
        val changes = ChangesReconciler.mergeRows(emptyMap(), page.withdrawals, emptyList(), setOf("w-31"), "client_withdrawal_id")
        assertEquals(setOf("30"), changes.upserts.keys)
    }

    @Test fun cursorsRoundTripLikeTheWeb() {
        val query = ChangesCursors.query(mapOf("sale" to 5L), 1_000L)
        assertEquals("5", query["after_sale"])
        assertEquals("0", query["after_close_correction"])
        assertEquals(10, query.keys.count { it.startsWith("after_") })
        assertEquals("1970-01-01T00:00:01Z", query["since"])
        val mid = ChangesCursors.toRows(mapOf("sale" to 9L, "sale_state" to 40L), emptyMap(), hasMore = true, sinceMillis = 1_000L)
        assertEquals(40L, mid["sale_state"]); assertEquals(1_000L, mid[ChangesCursors.SINCE])
        val done = ChangesCursors.toRows(page.cursors!!, mid, hasMore = false, sinceMillis = 1_000L)
        assertEquals(102L, done["sale"])
        assertEquals(listOf(0L, 0L, 0L), ChangesCursors.STATE_NAMES.map { done[it] }) // se reinician para ver reaperturas
        assertEquals(0L, done[ChangesCursors.SINCE]); assertEquals(1L, done[ChangesCursors.INITIALIZED])
    }

    @Test fun roomSchemaStillHasTheCursorTable() {
        val schema = java.io.File("schemas/cu.mypimes.pos.data.local.LocalDatabase/1.json").readText()
        assertTrue(schema.contains("\"tableName\": \"sync_cursors\""))
        assertTrue(schema.contains("`accountKey` TEXT NOT NULL, `cursorName` TEXT NOT NULL, `value` INTEGER NOT NULL"))
    }
}
