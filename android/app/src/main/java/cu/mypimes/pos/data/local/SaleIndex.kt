package cu.mypimes.pos.data.local

import androidx.room.withTransaction
import cu.mypimes.pos.data.pos.PosRepository
import cu.mypimes.pos.domain.BusinessDay
import cu.mypimes.pos.domain.pos.PosSale
import java.time.LocalDate
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json

/** Convierte `PosSale` en filas de `sale`/`sale_line`. Es un índice derivado: la caché `pos_sales` sigue intacta. */
object SaleIndex {
    /** Marca en `sync_cursors`: el índice ya se rellenó desde la caché de ventas de esta cuenta. */
    const val BUILT = "sale_index_built"

    class Rows(val sales: List<SaleEntity>, val lines: List<SaleLineEntity>)

    /** Las ventas sin fecha legible no se indexan (no hay día al que atribuirlas); siguen en la caché. */
    fun rows(accountKey: String, sales: List<PosSale>, payload: (PosSale) -> String): Rows {
        val saleRows = ArrayList<SaleEntity>(sales.size)
        val lineRows = ArrayList<SaleLineEntity>()
        for (sale in sales) {
            val date = BusinessDay.dateOf(sale.createdAt) ?: continue
            saleRows += SaleEntity(
                accountKey, sale.clientSaleId, sale.serverId, date, sale.createdAt, sale.total, sale.profit,
                sale.paymentMethod, sale.cashCloseId, sale.registerId.orEmpty(), sale.status, payload(sale),
            )
            sale.lines.forEachIndexed { idx, line ->
                lineRows += SaleLineEntity(
                    accountKey, sale.clientSaleId, idx, line.product.id, line.product.name, line.quantity,
                    line.unitPrice.takeIf { it.isFinite() } ?: line.product.salePrice, null,
                    if (line.isPack) line.product.packSize else null,
                )
            }
        }
        return Rows(saleRows, lineRows)
    }

    suspend fun store(dao: LocalDao, accountKey: String, sales: List<PosSale>, json: Json) {
        if (sales.isEmpty()) return
        val rows = rows(accountKey, sales) { json.encodeToString(PosSale.serializer(), it) }
        dao.replaceSales(accountKey, rows.sales, rows.lines)
    }

    /** Lo que el relleno todavía debe indexar; con todo ya indexado devuelve vacío (repetirlo no cambia nada). */
    fun notIndexed(cached: List<PosSale>, known: Set<String>): List<PosSale> = cached.filter { it.clientSaleId !in known }

    /**
     * Primer arranque tras migrar: rellena `sale` con lo que ya había en `pos_sales`. Idempotente: no pisa filas ya
     * indexadas y si se interrumpe antes de la marca, se repite sin duplicar nada.
     */
    suspend fun ensureBuilt(database: LocalDatabase, accountKey: String, json: Json) {
        val dao = database.localDao()
        if (dao.getCursors(accountKey).any { it.cursorName == BUILT }) return
        database.withTransaction {
        val cached = dao.getCacheKind(accountKey, PosRepository.KIND_SALES).mapNotNull { row ->
            runCatching { json.decodeFromString<PosSale>(row.payload) }.getOrNull()
        }
        store(dao, accountKey, notIndexed(cached, dao.indexedSaleIds(accountKey).toHashSet()), json)
        dao.putCursors(listOf(SyncCursorEntity(accountKey, BUILT, 1L)))
        }
    }

    /**
     * Ventas que la poda puede quitar: más viejas que el horizonte, ya subidas Y cerradas, y que no están en la
     * cola. Nada pendiente, rechazado ni por revisar se poda jamás.
     */
    fun prunable(sales: List<PosSale>, queued: Set<String>, today: LocalDate, days: Long): List<String> {
        val cutoff = BusinessDay.startOf(today.minusDays(days))
        return sales.filter { sale ->
            sale.clientSaleId !in queued && sale.isClosed &&
                BusinessDay.instantOf(sale.createdAt)?.isBefore(cutoff) == true
        }.map { it.clientSaleId }
    }
}
