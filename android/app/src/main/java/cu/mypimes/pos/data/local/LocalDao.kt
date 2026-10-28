package cu.mypimes.pos.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import kotlinx.coroutines.flow.Flow

@Dao
interface LocalDao {
    @Query("SELECT * FROM cache_records WHERE accountKey = :accountKey AND kind = :kind ORDER BY recordKey")
    fun observeCache(accountKey: String, kind: String): Flow<List<CacheRecordEntity>>

    @Query("SELECT * FROM cache_records WHERE accountKey = :accountKey AND kind = :kind ORDER BY recordKey")
    suspend fun getCacheKind(accountKey: String, kind: String): List<CacheRecordEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun putCache(records: List<CacheRecordEntity>)

    @Query("DELETE FROM cache_records WHERE accountKey = :accountKey AND kind = :kind AND recordKey = :recordKey")
    suspend fun deleteCacheRecord(accountKey: String, kind: String, recordKey: String)

    @Query("DELETE FROM cache_records WHERE accountKey = :accountKey AND kind = :kind")
    suspend fun deleteCacheKind(accountKey: String, kind: String)

    @Query("SELECT * FROM cache_records WHERE accountKey = :accountKey AND kind = :kind AND recordKey = :recordKey LIMIT 1")
    suspend fun getCacheRecord(accountKey: String, kind: String, recordKey: String): CacheRecordEntity?

    @Query("SELECT * FROM sync_cursors WHERE accountKey = :accountKey")
    suspend fun getCursors(accountKey: String): List<SyncCursorEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun putCursors(cursors: List<SyncCursorEntity>)

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun enqueue(operation: QueuedOperationEntity)

    @Query("SELECT * FROM operation_queue WHERE accountKey = :accountKey AND status = 'pending' ORDER BY createdAt, clientOperationId")
    suspend fun pending(accountKey: String): List<QueuedOperationEntity>

    @Query("SELECT * FROM operation_queue WHERE accountKey = :accountKey ORDER BY createdAt, clientOperationId")
    fun observeQueue(accountKey: String): Flow<List<QueuedOperationEntity>>

    @Query("SELECT * FROM operation_queue WHERE accountKey = :accountKey ORDER BY createdAt, clientOperationId")
    suspend fun getQueue(accountKey: String): List<QueuedOperationEntity>

    // --- A5: cola global con dependencias (los prefijos son «tienda:%»: una caja central reúne dueño y cajeros) ---

    /** Cola de todas las personas de la tienda en este aparato (modo central). */
    @Query("SELECT * FROM operation_queue WHERE accountKey LIKE :shopPrefix ORDER BY createdAt, clientOperationId")
    fun observeShopQueue(shopPrefix: String): Flow<List<QueuedOperationEntity>>

    /** Última bajada correcta de cualquier persona de la tienda (la bajada solo corre tras subir lo pendiente). */
    @Query("SELECT MAX(value) FROM sync_cursors WHERE accountKey LIKE :shopPrefix AND cursorName = 'last_ok_at'")
    fun observeShopLastOk(shopPrefix: String): Flow<Long?>

    @Query("SELECT * FROM operation_queue WHERE clientOperationId = :id LIMIT 1")
    suspend fun operationById(id: String): QueuedOperationEntity?

    @Query("SELECT * FROM operation_queue WHERE accountKey LIKE :shopPrefix ORDER BY createdAt, clientOperationId")
    suspend fun shopQueue(shopPrefix: String): List<QueuedOperationEntity>

    /** Alta (aún en la cola) que crea el registro temporal `entityRef` de ese tipo. */
    @Query("SELECT * FROM operation_queue WHERE accountKey LIKE :shopPrefix AND operationType = :type AND entityRef = :entityRef LIMIT 1")
    suspend fun creatorOf(shopPrefix: String, type: String, entityRef: String): QueuedOperationEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun putDependencies(rows: List<OutboxDependencyEntity>)

    /** La operación y sus dependencias (`dependsOn` = la primera; todas en `outbox_dependency`) o ninguna. */
    @Transaction
    suspend fun enqueueWithDependencies(operation: QueuedOperationEntity, deps: List<String>) {
        enqueue(operation.copy(dependsOn = deps.firstOrNull()))
        if (deps.isNotEmpty()) putDependencies(deps.distinct().map { OutboxDependencyEntity(operation.clientOperationId, it) })
    }

    @Query("SELECT d.* FROM outbox_dependency d JOIN operation_queue q ON q.clientOperationId = d.clientOperationId WHERE q.accountKey LIKE :shopPrefix")
    suspend fun shopDependencies(shopPrefix: String): List<OutboxDependencyEntity>

    @Query("SELECT dependsOnClientOperationId FROM outbox_dependency WHERE clientOperationId = :id")
    suspend fun dependenciesOf(id: String): List<String>

    @Query("UPDATE operation_queue SET path = :path, payload = :payload WHERE clientOperationId = :id")
    suspend fun setQueueBody(id: String, path: String, payload: String)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun putIdMap(row: IdMapEntity)

    @Query("SELECT serverId FROM id_map WHERE accountKey LIKE :shopPrefix AND entity = :entity AND localId = :localId LIMIT 1")
    suspend fun mappedId(shopPrefix: String, entity: String, localId: Long): Long?

    @Query("SELECT * FROM cache_records WHERE accountKey LIKE :shopPrefix AND kind = :kind AND payload LIKE :needle")
    suspend fun shopCacheLike(shopPrefix: String, kind: String, needle: String): List<CacheRecordEntity>

    /** Operaciones aún sin resolver en cualquier cuenta (para no reemplazar una caja con datos pendientes). */
    @Query("SELECT COUNT(*) FROM operation_queue WHERE status NOT IN ('discarded', 'rejected')")
    suspend fun countUnresolved(): Int

    @Query("UPDATE operation_queue SET status = :status, attempts = :attempts, lastError = :error WHERE clientOperationId = :id AND accountKey = :accountKey")
    suspend fun setQueueState(id: String, accountKey: String, status: String, attempts: Int, error: String?)

    @Query("DELETE FROM operation_queue WHERE clientOperationId = :id AND accountKey = :accountKey")
    suspend fun deleteAcknowledged(id: String, accountKey: String)

    /** Atomically stores a delta page's cache and cursors for one account. */
    @Transaction
    suspend fun applyCachePage(records: List<CacheRecordEntity>, cursors: List<SyncCursorEntity>) {
        if (records.isNotEmpty()) putCache(records)
        if (cursors.isNotEmpty()) putCursors(cursors)
    }

    /** Replaces one account's server catalog without touching its sales or outbox. */
    @Transaction
    suspend fun replaceCacheKind(accountKey: String, kind: String, records: List<CacheRecordEntity>) {
        deleteCacheKind(accountKey, kind)
        if (records.isNotEmpty()) putCache(records)
    }

    // --- Índice de ventas (tablas `sale` y `sale_line`) ---

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun putSales(rows: List<SaleEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun putSaleLines(rows: List<SaleLineEntity>)

    @Query("DELETE FROM sale_line WHERE accountKey = :accountKey AND clientSaleId IN (:ids)")
    suspend fun deleteSaleLines(accountKey: String, ids: List<String>)

    @Query("DELETE FROM sale WHERE accountKey = :accountKey AND clientSaleId IN (:ids)")
    suspend fun deleteSales(accountKey: String, ids: List<String>)

    @Query("DELETE FROM cache_records WHERE accountKey = :accountKey AND kind = :kind AND recordKey IN (:keys)")
    suspend fun deleteCacheRecords(accountKey: String, kind: String, keys: List<String>)

    @Query("SELECT clientSaleId FROM sale WHERE accountKey = :accountKey")
    suspend fun indexedSaleIds(accountKey: String): List<String>

    @Query("SELECT * FROM sale_line WHERE accountKey = :accountKey AND clientSaleId = :clientSaleId ORDER BY idx")
    suspend fun saleLines(accountKey: String, clientSaleId: String): List<SaleLineEntity>

    /**
     * Ventas del rango [from, to) de días del negocio que cuentan para un reporte: sin anuladas y sin las que el
     * servidor rechazó o bloqueó (el estado de la cola manda sobre el de la fila, como en el historial del POS).
     */
    @Query(
        "SELECT s.* FROM sale s LEFT JOIN operation_queue q ON q.accountKey = s.accountKey AND q.clientOperationId = s.clientSaleId " +
            "WHERE s.accountKey = :accountKey AND s.businessDate >= :from AND s.businessDate < :to " +
            "AND s.status IN ('synced', 'pending') AND (q.status IS NULL OR q.status NOT IN ('rejected', 'blocked', 'conflict', 'failed', 'discarded')) " +
            "ORDER BY s.createdAt DESC, s.clientSaleId",
    )
    suspend fun reportableSales(accountKey: String, from: String, to: String): List<SaleEntity>

    /** Reemplaza las filas de esas ventas (y sus líneas) en una sola transacción. */
    @Transaction
    suspend fun replaceSales(accountKey: String, sales: List<SaleEntity>, lines: List<SaleLineEntity>) {
        if (sales.isEmpty()) return
        sales.map { it.clientSaleId }.chunked(SQL_CHUNK).forEach { deleteSaleLines(accountKey, it) }
        putSales(sales)
        if (lines.isNotEmpty()) putSaleLines(lines)
    }

    /** Poda: quita las ventas de la caché y del índice. Nunca toca la cola. */
    @Transaction
    suspend fun pruneSales(accountKey: String, cacheKind: String, ids: List<String>) {
        ids.chunked(SQL_CHUNK).forEach {
            deleteSaleLines(accountKey, it)
            deleteSales(accountKey, it)
            deleteCacheRecords(accountKey, cacheKind, it)
        }
    }

    private companion object { const val SQL_CHUNK = 500 }
}
