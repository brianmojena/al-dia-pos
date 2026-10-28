package cu.mypimes.pos.data.local

import cu.mypimes.pos.domain.pos.CartLine
import cu.mypimes.pos.domain.pos.PosProduct
import cu.mypimes.pos.domain.pos.PosSale
import java.time.LocalDate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SaleIndexTest {
    private fun sale(id: String, at: String, status: String = "synced", close: Long? = null, lines: List<CartLine> = emptyList()) =
        PosSale(id, 100.0, 100.0, at, status, serverId = if (status == "pending") null else id.hashCode().toLong(),
            lines = lines, cashCloseId = close, profit = 30.0, registerId = "caja-1")

    private fun rows(vararg sales: PosSale) = SaleIndex.rows("u1", sales.toList()) { "json-${it.clientSaleId}" }

    @Test fun businessDateFollowsCubaAndKeepsStatusAndPayload() {
        val result = rows(
            sale("a", "2026-09-11 01:00:00"),              // 21:00 del día 10 en Cuba
            sale("b", "2026-07-14T03:59:59Z"),             // madrugada UTC: aún 13
            sale("c", "2026-07-14 04:00:00", status = "voided"),
        ).sales.associateBy { it.clientSaleId }
        assertEquals("2026-09-10", result.getValue("a").businessDate)
        assertEquals("2026-07-13", result.getValue("b").businessDate)
        assertEquals("2026-07-14", result.getValue("c").businessDate)
        assertEquals("voided", result.getValue("c").status) // anulada: se conserva el estado, no se borra
        assertEquals("json-a", result.getValue("a").payloadJson)
        assertEquals("caja-1", result.getValue("a").registerId)
        assertEquals(30.0, result.getValue("a").profit!!, 0.0)
    }

    @Test fun salesWithoutAReadableDateAreSkippedNotInvented() {
        assertTrue(rows(sale("x", ""), sale("y", "ayer")).sales.isEmpty())
    }

    @Test fun linesKeepPositionPriceAndPackSize() {
        val product = PosProduct(7, "Refresco", 150.0, 0.0, packSize = 6, packPrice = 800.0)
        val broken = CartLine(PosProduct(8, "Caja", 10.0, 0.0), 1.0, isPack = true) // sin precio de paquete: NaN
        val result = rows(sale("a", "2026-10-28 14:00:00", lines = listOf(CartLine(product, 2.0), CartLine(product, 1.0, true), broken)))
        assertEquals(listOf(0, 1, 2), result.lines.map { it.idx })
        assertEquals(listOf(150.0, 800.0, 10.0), result.lines.map { it.unitPrice })
        assertEquals(listOf(null, 6, null), result.lines.map { it.packSize })
    }

    @Test fun backfillIsIdempotent() {
        val cached = listOf(sale("a", "2026-10-28 14:00:00"), sale("b", "2026-10-28 15:00:00"))
        assertEquals(2, SaleIndex.notIndexed(cached, emptySet()).size)
        val known = rows(*SaleIndex.notIndexed(cached, emptySet()).toTypedArray()).sales.map { it.clientSaleId }.toSet()
        assertTrue(SaleIndex.notIndexed(cached, known).isEmpty()) // segunda pasada: nada que hacer
        assertEquals(listOf("b"), SaleIndex.notIndexed(cached, setOf("a")).map { it.clientSaleId })
    }

    private val today = LocalDate.parse("2026-10-28") // corte: 90 días antes = 2026-07-30
    private fun prune(queued: Set<String> = emptySet(), vararg sales: PosSale) = SaleIndex.prunable(sales.toList(), queued, today, 90)

    @Test fun pruneOnlyRemovesOldSalesThatAreUploadedAndClosed() {
        val old = "2026-05-01 12:00:00"
        val result = prune(
            setOf("queued"),
            sale("ok", old, close = 4),
            sale("open", old),                              // vieja pero abierta (sin cierre)
            sale("pend", old, status = "pending", close = 4),
            sale("rej", old, status = "rejected", close = 4),
            sale("blk", old, status = "blocked", close = 4),
            sale("void", old, status = "voided", close = 4),
            sale("queued", old, close = 4),                 // sigue en la cola
            sale("recent", "2026-10-01 12:00:00", close = 4),
        )
        assertEquals(listOf("ok"), result)
    }

    @Test fun pruneHorizonIsBusinessDayExact() {
        // Corte = inicio del 30 jul en Cuba = 2026-07-30T04:00:00Z.
        assertEquals(listOf("before"), prune(emptySet(), sale("before", "2026-07-30 03:59:59", close = 1), sale("after", "2026-07-30 04:00:00", close = 1)))
    }
}
