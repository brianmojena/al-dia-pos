package cu.mypimes.pos.data.sync

import androidx.room.withTransaction
import cu.mypimes.pos.data.auth.Session
import cu.mypimes.pos.data.auth.accountKeyFromToken
import cu.mypimes.pos.data.local.CacheRecordEntity
import cu.mypimes.pos.data.local.LocalDao
import cu.mypimes.pos.data.local.LocalDatabase
import cu.mypimes.pos.data.local.LocalKinds
import cu.mypimes.pos.data.local.SaleIndex
import cu.mypimes.pos.data.local.SyncCursorEntity
import cu.mypimes.pos.data.pos.PosRepository
import cu.mypimes.pos.data.store.InventoryRepository
import cu.mypimes.pos.data.store.StoreRepository
import cu.mypimes.pos.domain.BusinessDay
import cu.mypimes.pos.domain.Format
import cu.mypimes.pos.domain.pos.PosSale
import java.io.IOException
import java.time.LocalDate
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * Baja los cambios del servidor por páginas y los aplica a la caché sin pisar la cola.
 * Cada página (datos + cursores) se guarda en una sola transacción de Room: si algo falla, el cursor no avanza.
 */
@Singleton
class ChangesSync @Inject constructor(
    private val api: SyncApi,
    private val database: LocalDatabase,
    private val dao: LocalDao,
    private val json: Json,
    private val posRepository: PosRepository,
) {
    private val mutex = Mutex()
    private var lastOk: Pair<String, Long>? = null

    suspend fun sync(session: Session) = mutex.withLock {
        val accountKey = accountKeyFromToken(session.token, session.user.id)
            ?: throw IllegalArgumentException("La sesión no contiene una identidad de cuenta válida")
        // Sin red también: el índice de ventas se rellena desde la caché antes de intentar nada en línea.
        SaleIndex.ensureBuilt(database, accountKey, json)
        // shortcut: pantallas que abren a la vez no repiten el recorrido; sube a un cursor de tiempo si molesta.
        lastOk?.let { (key, at) -> if (key == accountKey && System.currentTimeMillis() - at < THROTTLE_MS) return@withLock }
        // Primero lo local: un ACK perdido se resuelve reenviando el mismo UUID antes de leer el stock.
        posRepository.sync(session)
        posRepository.exclusive { pull(accountKey, "Bearer ${session.token}", session.user.isOwner) }
        lastOk = accountKey to System.currentTimeMillis()
    }

    private suspend fun pull(accountKey: String, authorization: String, owner: Boolean) {
        val saved = dao.getCursors(accountKey).associate { it.cursorName to it.value }
        val now = System.currentTimeMillis()
        // Una instalación anterior al horizonte de 90 días repite el recorrido una vez (idempotente) para traer esa historia.
        val widen = owner && saved[ChangesCursors.HISTORY] != ChangesCursors.HISTORY_DAYS && (saved[ChangesCursors.SINCE] ?: 0L) <= 0L
        val days = if (owner) ChangesCursors.HISTORY_DAYS else ChangesCursors.INITIAL_DAYS
        val sinceMillis = saved[ChangesCursors.SINCE]?.takeIf { it > 0 }
            ?: if (widen || saved[ChangesCursors.INITIALIZED] == null) now - days * 86_400_000 else null
        val start = ChangesCursors.paramsFor(owner).keys.associateWith { if (widen) 0L else saved[it] ?: 0L }
        pullPages(start, sinceMillis, owner, fetch = { query ->
            val response = api.changes(authorization, query)
            if (response.code() == 401) throw IOException("Renueva tu sesión para sincronizar. Los datos locales siguen disponibles.")
            if (!response.isSuccessful) throw IOException("No se pudieron descargar los datos de la tienda (${response.code()})")
            response.body() ?: throw IOException("La nube devolvió una respuesta vacía")
        }, apply = { page, rows -> apply(accountKey, page, rows, owner) })
    }

    private suspend fun apply(accountKey: String, page: ChangesPage, cursorRows: Map<String, Long>, owner: Boolean) {
        val now = System.currentTimeMillis()
        val today = Format.businessDate()
        database.withTransaction {
            val queued = dao.getQueue(accountKey).mapTo(HashSet()) { it.clientOperationId }
            page.products?.let { products ->
                // Caja central: el catálogo es uno solo para el aparato (ver `PosRepository.catalogKey`).
                dao.replaceCacheKind(posRepository.catalogKey(accountKey), PosRepository.KIND_PRODUCTS, posRepository.catalogRecords(accountKey, products, now))
            }
            if (page.touchesSales()) {
                val cached = dao.getCacheKind(accountKey, PosRepository.KIND_SALES).mapNotNull { row ->
                    runCatching { json.decodeFromString<PosSale>(row.payload) }.getOrNull()
                }
                val changed = ChangesReconciler.reconcileSales(cached, queued, page)
                dao.putCache(changed.map {
                    CacheRecordEntity(accountKey, PosRepository.KIND_SALES, it.clientSaleId, json.encodeToString(it), now)
                })
                SaleIndex.store(dao, accountKey, changed, json)
            }
            merge(accountKey, StoreRepository.KIND_CLOSES, ChangesReconciler.closeRows(page), emptyList(), queued, "client_close_id", now = now)
            merge(accountKey, StoreRepository.KIND_WITHDRAWALS, page.withdrawals, page.withdrawalStates, queued, "client_withdrawal_id", now = now)
            merge(accountKey, StoreRepository.KIND_OPEN_WITHDRAWALS, page.withdrawals, page.withdrawalStates, queued, "client_withdrawal_id", dropWhenClosed = true, now = now)
            // Esa lista es "compras de hoy" en Divisas: las de días anteriores solo actualizan filas ya guardadas.
            merge(accountKey, StoreRepository.KIND_PURCHASES, page.purchases, page.purchaseStates, queued, "client_purchase_id", now = now) {
                (it["created_at"] as? JsonPrimitive)?.contentOrNull?.let { at ->
                    Format.parseInstant(at)?.atZone(Format.cubaZone)?.toLocalDate()?.toString() == today
                } == true
            }
            storeRows(accountKey, InventoryRepository.KIND_COUNTS, ChangesReconciler.countRows(page.inventoryCounts), now)
            storeWarehouse(accountKey, page, now)
            storeRows(accountKey, LocalKinds.WAREHOUSE_TRANSFERS, ChangesReconciler.byId(page.warehouseTransfers), now)
            storeRows(accountKey, LocalKinds.STOCK_ENTRIES, ChangesReconciler.byId(page.stockEntries), now)
            if (!page.hasMore) prune(accountKey, queued)
            dao.putCursors(cursorRows.map { SyncCursorEntity(accountKey, it.key, it.value) })
        }
    }

    private suspend fun storeRows(accountKey: String, kind: String, rows: Map<String, JsonObject>, now: Long) {
        if (rows.isNotEmpty()) dao.putCache(rows.map { CacheRecordEntity(accountKey, kind, it.key, it.value.toString(), now) })
    }

    private suspend fun storeWarehouse(accountKey: String, page: ChangesPage, now: Long) {
        if (page.warehouseItems.isEmpty() && page.warehouseStates.isEmpty() && page.warehouseLiveIds == null) return
        val cached = dao.getCacheKind(accountKey, LocalKinds.WAREHOUSE).mapNotNull { row ->
            (runCatching { json.parseToJsonElement(row.payload) }.getOrNull() as? JsonObject)?.let { row.recordKey to it }
        }.toMap()
        val changes = ChangesReconciler.warehouseRows(cached, page)
        changes.deletes.forEach { dao.deleteCacheRecord(accountKey, LocalKinds.WAREHOUSE, it) }
        storeRows(accountKey, LocalKinds.WAREHOUSE, changes.upserts, now)
    }

    /**
     * Al terminar una pasada: quita lo que ya salió del horizonte de 90 días. Ventas solo si están subidas y
     * cerradas (nunca pendientes, rechazadas ni por revisar); pases y entradas de stock por su fecha.
     */
    private suspend fun prune(accountKey: String, queued: Set<String>) {
        val sales = dao.getCacheKind(accountKey, PosRepository.KIND_SALES).mapNotNull { row ->
            runCatching { json.decodeFromString<PosSale>(row.payload) }.getOrNull()
        }
        val old = SaleIndex.prunable(sales, queued, LocalDate.now(Format.cubaZone), ChangesCursors.HISTORY_DAYS)
        if (old.isNotEmpty()) dao.pruneSales(accountKey, PosRepository.KIND_SALES, old)
        val cutoff = BusinessDay.startOf(LocalDate.now(Format.cubaZone).minusDays(ChangesCursors.HISTORY_DAYS))
        for (kind in listOf(LocalKinds.WAREHOUSE_TRANSFERS, LocalKinds.STOCK_ENTRIES)) {
            val rows = dao.getCacheKind(accountKey, kind).mapNotNull { row ->
                (runCatching { json.parseToJsonElement(row.payload) }.getOrNull() as? JsonObject)?.let { row.recordKey to it }
            }
            ChangesReconciler.olderThan(rows, "created_at", cutoff).forEach { dao.deleteCacheRecord(accountKey, kind, it) }
        }
    }

    private fun ChangesPage.touchesSales() =
        sales.isNotEmpty() || saleStates.isNotEmpty() || saleCorrections.isNotEmpty() || cashCloses.isNotEmpty()

    private suspend fun merge(
        accountKey: String,
        kind: String,
        incoming: List<JsonObject>,
        states: List<JsonObject>,
        queued: Set<String>,
        clientKey: String,
        dropWhenClosed: Boolean = false,
        now: Long,
        accept: (JsonObject) -> Boolean = { true },
    ) {
        if (incoming.isEmpty() && states.isEmpty()) return
        val cached = dao.getCacheKind(accountKey, kind).mapNotNull { row ->
            (runCatching { json.parseToJsonElement(row.payload) }.getOrNull() as? JsonObject)?.let { row.recordKey to it }
        }.toMap()
        val changes = ChangesReconciler.mergeRows(cached, incoming, states, queued, clientKey, dropWhenClosed, accept)
        changes.deletes.forEach { dao.deleteCacheRecord(accountKey, kind, it) }
        if (changes.upserts.isNotEmpty()) dao.putCache(changes.upserts.map { CacheRecordEntity(accountKey, kind, it.key, it.value.toString(), now) })
    }

    private companion object { const val THROTTLE_MS = 10_000L }
}

/**
 * Recorre las páginas del servidor. `apply` guarda datos y cursores en una sola transacción: si lanza, el
 * recorrido se detiene y los cursores guardados no avanzan, así que el próximo intento repite esa página.
 * Los cursores del siguiente pedido salen solo de páginas ya aplicadas.
 */
internal suspend fun pullPages(
    start: Map<String, Long>,
    sinceMillis: Long?,
    owner: Boolean,
    now: () -> Long = System::currentTimeMillis,
    fetch: suspend (Map<String, String>) -> ChangesPage,
    apply: suspend (ChangesPage, Map<String, Long>) -> Unit,
) {
    var cursors = start
    while (true) {
        val page = fetch(ChangesCursors.query(cursors, sinceMillis, owner))
        val next = page.cursors ?: throw IOException("La nube no usa la descarga por cursores; actualiza el servidor")
        if (page.hasMore && ChangesCursors.paramsFor(owner).keys.all { (next[it] ?: cursors.getValue(it)) == cursors.getValue(it) }) {
            throw IOException("La nube no pudo avanzar la sincronización; vuelve a intentar")
        }
        val rows = ChangesCursors.toRows(next, cursors, page.hasMore, sinceMillis, owner, now())
        apply(page, rows)
        if (!page.hasMore) return
        cursors = rows.filterKeys { it in ChangesCursors.paramsFor(owner) }
    }
}
