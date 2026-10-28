package cu.mypimes.pos.data.sync

import cu.mypimes.pos.data.pos.ProductDto
import cu.mypimes.pos.data.pos.SaleDto
import cu.mypimes.pos.data.pos.SaleItemDto
import cu.mypimes.pos.data.pos.toPosSale
import cu.mypimes.pos.domain.pos.CartLine
import cu.mypimes.pos.domain.pos.PosProduct
import cu.mypimes.pos.domain.pos.PosSale
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.JsonArray

/** Una página de `GET /api/sync/snapshot?after_*` (la misma que usa la web). Las filas de caja se guardan como JSON para fusionarlas campo a campo, como el `upsert` de offlineModel.js. */
@Serializable
data class ChangesPage(
    val products: List<ProductDto>? = null,
    val sales: List<SaleDto> = emptyList(),
    @SerialName("sale_states") val saleStates: List<SaleStateDto> = emptyList(),
    @SerialName("purchase_states") val purchaseStates: List<JsonObject> = emptyList(),
    @SerialName("withdrawal_states") val withdrawalStates: List<JsonObject> = emptyList(),
    @SerialName("cash_closes") val cashCloses: List<JsonObject> = emptyList(),
    @SerialName("currency_purchases") val purchases: List<JsonObject> = emptyList(),
    @SerialName("cash_withdrawals") val withdrawals: List<JsonObject> = emptyList(),
    @SerialName("sale_corrections") val saleCorrections: List<SaleCorrectionDto> = emptyList(),
    @SerialName("cash_close_corrections") val closeCorrections: List<JsonObject> = emptyList(),
    @SerialName("inventory_counts") val inventoryCounts: List<JsonObject> = emptyList(),
    // Solo dueño (S5): almacén, pases y entradas de stock. `warehouse_live_ids` llega con el cursor de estados en 0.
    @SerialName("warehouse_items") val warehouseItems: List<JsonObject> = emptyList(),
    @SerialName("warehouse_states") val warehouseStates: List<JsonObject> = emptyList(),
    @SerialName("warehouse_live_ids") val warehouseLiveIds: List<Long>? = null,
    @SerialName("warehouse_transfers") val warehouseTransfers: List<JsonObject> = emptyList(),
    @SerialName("stock_entries") val stockEntries: List<JsonObject> = emptyList(),
    val cursors: Map<String, Long>? = null,
    @SerialName("has_more") val hasMore: Boolean = false,
)

@Serializable
data class SaleStateDto(
    val id: Long,
    @SerialName("cash_close_id") val cashCloseId: Long? = null,
    val closed: Int = 0,
)

@Serializable
data class SaleCorrectionDto(
    @SerialName("sale_id") val saleId: Long? = null,
    @SerialName("client_sale_id") val clientSaleId: String? = null,
    /** Venta como quedó; null cuando la corrección la anuló. */
    val sale: SaleDto? = null,
    @SerialName("cash_close") val cashClose: JsonObject? = null,
)

/** Cursores por cuenta en `sync_cursors`. Los de estado se reinician tras un recorrido completo para ver reaperturas, igual que la web. */
object ChangesCursors {
    /** Nombre de cursor -> parámetro de la consulta. Mismos nombres que CURSOR_PARAMS en offlineClient.js. */
    val PARAMS: Map<String, String> = linkedMapOf(
        "sale" to "after_sale", "sale_state" to "after_sale_state", "close" to "after_close",
        "count" to "after_count", "purchase" to "after_purchase", "purchase_state" to "after_purchase_state",
        "withdrawal" to "after_withdrawal", "withdrawal_state" to "after_withdrawal_state",
        "correction" to "after_correction", "close_correction" to "after_close_correction",
    )
    /** Solo el dueño los pide: el servidor no los manda a un cajero. */
    val OWNER_PARAMS: Map<String, String> = linkedMapOf(
        "warehouse" to "after_warehouse", "warehouse_state" to "after_warehouse_state",
        "warehouse_transfer" to "after_warehouse_transfer", "stock_entry" to "after_stock_entry",
    )
    val STATE_NAMES = listOf("sale_state", "purchase_state", "withdrawal_state")
    val OWNER_STATE_NAMES = listOf("warehouse_state")
    const val INITIALIZED = "initialized"
    const val SINCE = "initial_since"
    /** Fin de la última pasada completa (epoch ms): de ahí sale el «datos de hace X» de lo local. */
    const val LAST_OK = "last_ok_at"
    /** Días de historia con los que se hizo la última pasada completa del dueño (para ampliar instalaciones de 7 días). */
    const val HISTORY = "history_days"
    const val INITIAL_DAYS = 7L
    /** Horizonte de historia local del dueño: lo que baja la primera vez y lo que se conserva sin red. */
    const val HISTORY_DAYS = 90L

    fun paramsFor(owner: Boolean): Map<String, String> = if (owner) PARAMS + OWNER_PARAMS else PARAMS

    fun query(cursors: Map<String, Long>, sinceMillis: Long?, owner: Boolean = false): Map<String, String> {
        val params = linkedMapOf("limit" to "200", "max_bytes" to (512 * 1024).toString())
        paramsFor(owner).forEach { (name, param) -> params[param] = (cursors[name] ?: 0L).toString() }
        if (sinceMillis != null) params["since"] = java.time.Instant.ofEpochMilli(sinceMillis).toString()
        return params
    }

    /** Filas a guardar tras aplicar una página; se escriben en la misma transacción que los datos. */
    fun toRows(next: Map<String, Long>, previous: Map<String, Long>, hasMore: Boolean, sinceMillis: Long?, owner: Boolean = false, now: Long = 0L): Map<String, Long> {
        val rows = paramsFor(owner).keys.associateWith { next[it] ?: previous[it] ?: 0L }.toMutableMap()
        if (!hasMore) (if (owner) STATE_NAMES + OWNER_STATE_NAMES else STATE_NAMES).forEach { rows[it] = 0L }
        if (!hasMore && now > 0) rows[LAST_OK] = now
        if (!hasMore && owner) rows[HISTORY] = HISTORY_DAYS
        rows[INITIALIZED] = 1L
        rows[SINCE] = if (hasMore) sinceMillis ?: 0L else 0L
        return rows
    }
}

data class RowChanges(val upserts: Map<String, JsonObject>, val deletes: Set<String>)

object ChangesReconciler {
    const val STATUS_VOIDED = "voided"

    private fun JsonObject.text(key: String) = (this[key] as? JsonPrimitive)?.contentOrNull
    private fun JsonObject.number(key: String) = (this[key] as? JsonPrimitive)?.longOrNull
    private val STATE_FIELDS = setOf("cash_close_id", "voided_at")

    private fun lineOf(item: SaleItemDto) = CartLine(
        PosProduct(item.productId ?: 0L, item.productName ?: "Producto", item.unitPrice, 0.0), item.quantity,
    )

    /**
     * Ventas: una venta que sigue en la cola (`queued`) manda hasta que su ACK la reemplace; el servidor
     * manda en cierres, reaperturas y anulaciones. Devuelve solo las filas que cambiaron. Idempotente.
     */
    fun reconcileSales(cached: List<PosSale>, queued: Set<String>, page: ChangesPage): List<PosSale> {
        val rows = LinkedHashMap<String, PosSale>()
        cached.forEach { rows[it.clientSaleId] = it }
        val changed = LinkedHashSet<String>()
        fun find(serverId: Long?, clientId: String?): PosSale? =
            clientId?.let(rows::get) ?: serverId?.let { id -> rows.values.firstOrNull { it.serverId == id } }
        fun locked(row: PosSale?) = row != null && (row.clientSaleId in queued || row.status == STATUS_VOIDED)
        fun upsert(dto: SaleDto) {
            if (dto.clientSaleId in queued) return
            val old = find(dto.id, dto.clientSaleId)
            if (locked(old)) return
            val lines = old?.lines?.takeIf { it.isNotEmpty() } ?: dto.items.map(::lineOf)
            val fresh = dto.toPosSale(lines) ?: return
            val row = if (old != null) fresh.copy(clientSaleId = old.clientSaleId) else fresh
            rows[row.clientSaleId] = row
            changed += row.clientSaleId
        }
        page.sales.forEach(::upsert)
        for (state in page.saleStates) {
            val old = find(state.id, null)?.takeUnless(::locked) ?: continue
            val closeId = if (state.closed == 0) null else state.cashCloseId ?: old.cashCloseId
            if (old.cashCloseId == closeId) continue
            rows[old.clientSaleId] = old.copy(cashCloseId = closeId)
            changed += old.clientSaleId
        }
        for (close in page.cashCloses) {
            val closeId = close.number("id") ?: continue
            for (sold in (close["covered_sale_ids"] as? JsonArray).orEmpty()) {
                val old = find((sold as? JsonPrimitive)?.longOrNull, null)?.takeUnless(::locked) ?: continue
                if (old.cashCloseId == closeId) continue
                rows[old.clientSaleId] = old.copy(cashCloseId = closeId)
                changed += old.clientSaleId
            }
        }
        for (correction in page.saleCorrections) {
            val sale = correction.sale
            if (sale != null) { upsert(sale); continue }
            val old = find(correction.saleId, correction.clientSaleId)?.takeUnless(::locked) ?: continue
            rows[old.clientSaleId] = old.copy(status = STATUS_VOIDED)
            changed += old.clientSaleId
        }
        val before = cached.associateBy { it.clientSaleId }
        return changed.mapNotNull(rows::get).filter { before[it.clientSaleId] != it }
    }

    /** Fusiona altas y estados en filas JSON por `id`. Las que aún están en la cola no se tocan. */
    fun mergeRows(
        cached: Map<String, JsonObject>,
        incoming: List<JsonObject>,
        states: List<JsonObject>,
        queued: Set<String>,
        clientKey: String,
        dropWhenClosed: Boolean = false,
        accept: (JsonObject) -> Boolean = { true },
    ): RowChanges {
        val rows = LinkedHashMap(cached)
        val touched = LinkedHashSet<String>()
        fun queuedRow(row: JsonObject) = row.text(clientKey)?.let { it in queued } == true
        for (row in incoming) {
            val key = row.number("id")?.toString() ?: continue
            if (queuedRow(row) || !accept(row)) continue
            rows[key] = rows[key]?.let { JsonObject(it + row) } ?: row
            touched += key
        }
        for (state in states) {
            val key = state.number("id")?.toString() ?: continue
            val old = rows[key]?.takeUnless(::queuedRow) ?: continue
            rows[key] = JsonObject(old + state.filterKeys { it in STATE_FIELDS })
            touched += key
        }
        val deletes = if (dropWhenClosed) touched.filterTo(LinkedHashSet()) { rows[it]?.number("cash_close_id") != null } else emptySet()
        return RowChanges(touched.filter { it !in deletes }.associateWith { rows.getValue(it) }, deletes)
    }

    private val WAREHOUSE_STATE_FIELDS = setOf("id", "name", "unit", "cost", "quantity")

    /**
     * Almacén: las altas traen la fila completa y los estados refrescan nombre, unidad, costo y cantidad (si la
     * fila aún no existe se crea con ellos). `warehouse_live_ids` (si viene) manda: lo local que no esté ahí se borró.
     */
    fun warehouseRows(cached: Map<String, JsonObject>, page: ChangesPage): RowChanges {
        val rows = LinkedHashMap(cached)
        val touched = LinkedHashSet<String>()
        for (row in page.warehouseItems) {
            val key = row.number("id")?.toString() ?: continue
            rows[key] = rows[key]?.let { JsonObject(it + row) } ?: row
            touched += key
        }
        for (state in page.warehouseStates) {
            val key = state.number("id")?.toString() ?: continue
            val fields = state.filterKeys { it in WAREHOUSE_STATE_FIELDS }
            rows[key] = rows[key]?.let { JsonObject(it + fields) } ?: JsonObject(fields)
            touched += key
        }
        val live = page.warehouseLiveIds?.mapTo(HashSet()) { it.toString() }
        val deletes = if (live == null) emptySet() else rows.keys.filterTo(LinkedHashSet()) { it !in live }
        return RowChanges(touched.filter { it !in deletes }.associateWith { rows.getValue(it) }, deletes)
    }

    /** Filas inmutables por `id` (pases, entradas de stock): se guardan tal cual y repetirlas no cambia nada. */
    fun byId(incoming: List<JsonObject>): Map<String, JsonObject> =
        incoming.mapNotNull { row -> row.number("id")?.let { it.toString() to row } }.toMap()

    /** Conteos del historial: sin las líneas (el detalle se abre en línea) para no chocar con el formato de la lista. */
    fun countRows(incoming: List<JsonObject>): Map<String, JsonObject> =
        byId(incoming.map { JsonObject(it - "items") })

    /** Claves de filas cuyo `field` (fecha del servidor) es anterior al corte. Las que no se pueden leer se conservan. */
    fun olderThan(rows: List<Pair<String, JsonObject>>, field: String, cutoff: java.time.Instant): List<String> =
        rows.filter { (_, row) ->
            cu.mypimes.pos.domain.BusinessDay.instantOf(row.text(field))?.isBefore(cutoff) == true
        }.map { it.first }

    /** Cierres: altas, más los cierres corregidos que llegan dentro de las correcciones de venta y de cierre. */
    fun closeRows(page: ChangesPage): List<JsonObject> = page.cashCloses +
        page.saleCorrections.mapNotNull { it.cashClose } +
        page.closeCorrections.mapNotNull { it["cash_close"] as? JsonObject }
}
