package cu.mypimes.pos.data.store

import androidx.room.withTransaction
import cu.mypimes.pos.data.auth.ApiErrorDto
import cu.mypimes.pos.data.auth.Session
import cu.mypimes.pos.data.auth.accountKeyFromToken
import cu.mypimes.pos.data.local.CacheRecordEntity
import cu.mypimes.pos.data.local.IdMapEntity
import cu.mypimes.pos.data.local.LocalDao
import cu.mypimes.pos.data.local.LocalDatabase
import cu.mypimes.pos.data.local.LocalKinds
import cu.mypimes.pos.data.local.QueueRepository
import cu.mypimes.pos.data.local.QueuedOperationEntity
import cu.mypimes.pos.data.local.SaleIndex
import cu.mypimes.pos.data.local.SyncCursorEntity
import cu.mypimes.pos.data.local.dependenciesFor
import cu.mypimes.pos.data.local.shopPrefix
import cu.mypimes.pos.data.pos.PosRepository
import cu.mypimes.pos.data.pos.PosSyncScheduler
import cu.mypimes.pos.data.pos.ProductDto
import cu.mypimes.pos.data.shared.SharedDeviceRepository
import cu.mypimes.pos.domain.outbox.Outbox
import cu.mypimes.pos.domain.pos.PosSale
import java.io.IOException
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * A5/A6: escrituras del dueño en modo caja centralizada. Cada una se guarda en la cola con un `operation_id` estable
 * (el mismo UUID que `clientOperationId`) y su cuerpo exacto; sube en segundo plano con la credencial de quien la creó.
 * Fuera de modo central nadie llama a esto: las cuentas normales siguen online-only.
 */
@Singleton
class OwnerOutbox @Inject constructor(
    private val api: StoreApi,
    private val database: LocalDatabase,
    private val dao: LocalDao,
    private val queue: QueueRepository,
    private val json: Json,
    private val syncScheduler: PosSyncScheduler,
    private val shared: SharedDeviceRepository,
) {
    fun central(session: Session) = shared.isCentralOwner(session)

    /** Operaciones del dueño sin confirmar (pendientes o rechazadas), para el aviso «sin subir». */
    fun unsettled(accountKey: String): Flow<List<QueuedOperationEntity>> =
        dao.observeQueue(accountKey).map(OwnerOverlay::unsettled)

    suspend fun retry(operation: QueuedOperationEntity) {
        queue.retry(operation)
        runCatching { syncScheduler.schedule(operation.accountKey) }
    }

    suspend fun discard(operation: QueuedOperationEntity) = queue.discard(operation)

    /** Id temporal negativo, persistente y único por tienda (un contador por tipo en `sync_cursors`). */
    suspend fun nextTempId(accountKey: String, entity: Outbox.Entity): Long = database.withTransaction {
        val owner = accountKey.substringBefore(':')
        val name = "temp_id:${entity.key}"
        val last = dao.getCursors(owner).firstOrNull { it.cursorName == name }?.value ?: 0L
        (last - 1).also { dao.putCursors(listOf(SyncCursorEntity(owner, name, it))) }
    }

    /**
     * Guarda la operación con el cuerpo tal cual (incluido su `operation_id`) y las altas de las que depende.
     * Un id temporal que ya se confirmó se cambia por el real antes de guardar.
     */
    suspend fun enqueue(
        session: Session,
        type: String,
        method: String,
        path: String,
        body: JsonObject,
        operationId: String = UUID.randomUUID().toString(),
        entityRef: String? = null,
    ): String {
        val accountKey = requireAccount(session)
        var finalPath = path
        var payload = json.encodeToString(JsonObject.serializer(), body)
        for ((entity, id) in Outbox.tempRefs(finalPath, payload)) {
            val real = dao.mappedId(shopPrefix(accountKey), entity.key, id) ?: continue
            Outbox.rewrite(entity, id, real, finalPath, payload)?.let { (p, b) -> finalPath = p; payload = b }
        }
        val deps = dependenciesFor(dao, accountKey, finalPath, payload)
        dao.enqueueWithDependencies(
            QueuedOperationEntity(
                operationId, accountKey, type, finalPath, method.uppercase(), payload,
                createdAt = System.currentTimeMillis(), entityRef = entityRef, ownerRole = Outbox.ROLE_OWNER,
            ),
            deps,
        )
        runCatching { syncScheduler.schedule(accountKey) }
        return operationId
    }

    /**
     * Sube UNA operación con el cuerpo guardado. Devuelve true si hay que volver a bajar el catálogo.
     * Un fallo de red o del servidor (5xx) lanza IOException y la deja pendiente; un 400/403/404/409 la deja
     * `failed`/`conflict` con el motivo del servidor y NO la borra.
     */
    suspend fun send(session: Session, operation: QueuedOperationEntity): Boolean {
        val authorization = "Bearer ${session.token}"
        val url = operation.path.removePrefix("/api/")
        val response = try {
            when (operation.method) {
                "POST" -> api.rawPost(authorization, url, operation.payload.toRequestBody(JSON))
                "PUT" -> api.rawPut(authorization, url, operation.payload.toRequestBody(JSON))
                "DELETE" -> api.rawDelete(authorization, url)
                else -> throw IllegalStateException("Método no soportado: ${operation.method}")
            }
        } catch (error: IOException) {
            pending(operation, "Sin conexión. Se enviará al recuperar la red.")
            throw error
        }
        val code = response.code()
        val text = if (response.isSuccessful) response.body()?.string().orEmpty() else response.errorBody()?.string()
        return when {
            response.isSuccessful -> confirm(operation, text.orEmpty())
            // Borrar algo que ya no existe es el resultado que se quería.
            code == 404 && operation.method == "DELETE" -> confirm(operation, "")
            code == 401 -> {
                pending(operation, "Inicia sesión de nuevo para sincronizar.", bump = false)
                throw IOException("Sesión caducada")
            }
            code == 409 -> reject(operation, QueuedOperationEntity.STATUS_CONFLICT, text, "El servidor no aceptó el cambio (conflicto).")
            code in 400..499 -> reject(operation, QueuedOperationEntity.STATUS_FAILED, text, "El servidor rechazó el cambio.")
            else -> {
                pending(operation, "Error temporal ($code). Se reintentará.")
                throw IOException("Error temporal del servidor")
            }
        }
    }

    private suspend fun reject(operation: QueuedOperationEntity, status: String, body: String?, fallback: String): Boolean {
        val message = body?.let { runCatching { json.decodeFromString<ApiErrorDto>(it).error }.getOrNull() }
            ?.takeIf { it.isNotBlank() } ?: fallback
        dao.setQueueState(operation.clientOperationId, operation.accountKey, status, operation.attempts + 1, message)
        return false
    }

    private suspend fun pending(operation: QueuedOperationEntity, message: String, bump: Boolean = true) {
        dao.setQueueState(operation.clientOperationId, operation.accountKey, QueuedOperationEntity.STATUS_PENDING,
            operation.attempts + if (bump) 1 else 0, message)
    }

    /** Aplica el cambio confirmado a la caché y saca la operación de la cola, todo en una transacción. */
    private suspend fun confirm(operation: QueuedOperationEntity, text: String): Boolean {
        val key = operation.accountKey
        val catalog = shared.catalogKey(key) // caja central: el catálogo es uno solo para el aparato
        var refreshCatalog = false
        database.withTransaction {
            val body = runCatching { json.parseToJsonElement(operation.payload).jsonObject }.getOrNull()
            val id = operation.path.substringAfterLast('/').toLongOrNull()
            when (operation.operationType) {
                Outbox.PRODUCT_CREATE -> {
                    val saved = runCatching { json.decodeFromString<ProductSaveDto>(text) }.getOrNull()
                    val temp = operation.entityRef?.toLongOrNull()
                    if (saved != null && temp != null) {
                        // Si ya existía uno con ese nombre el servidor lo conserva tal cual: se vuelve a bajar el catálogo.
                        val row = if (saved.merged || body == null) null
                        else OwnerOverlay.newProduct(saved.id, body).let {
                            CacheRecordEntity(catalog, PosRepository.KIND_PRODUCTS, saved.id.toString(), json.encodeToString(it), System.currentTimeMillis())
                        }
                        refreshCatalog = row == null
                        replaceTemp(key, Outbox.Entity.PRODUCT, temp, saved.id, operation, row)
                    }
                }
                Outbox.WAREHOUSE_CREATE -> {
                    val saved = runCatching { json.decodeFromString<WarehouseItemDto>(text) }.getOrNull()
                    val temp = operation.entityRef?.toLongOrNull()
                    if (saved != null && temp != null) {
                        replaceTemp(key, Outbox.Entity.WAREHOUSE, temp, saved.id, operation,
                            CacheRecordEntity(key, LocalKinds.WAREHOUSE, saved.id.toString(), json.encodeToString(saved), System.currentTimeMillis()))
                    }
                }
                Outbox.PRODUCT_UPDATE -> if (id != null && body != null) {
                    dao.getCacheRecord(catalog, PosRepository.KIND_PRODUCTS, id.toString())
                        ?.let { row -> runCatching { json.decodeFromString<ProductDto>(row.payload) }.getOrNull()?.let { row to it } }
                        ?.let { (row, dto) -> dao.putCache(listOf(row.copy(payload = json.encodeToString(OwnerOverlay.editProduct(dto, body)), updatedAt = System.currentTimeMillis()))) }
                }
                Outbox.PRODUCT_DELETE -> if (id != null) dao.deleteCacheRecord(catalog, PosRepository.KIND_PRODUCTS, id.toString())
                Outbox.WAREHOUSE_UPDATE -> runCatching { json.decodeFromString<WarehouseItemDto>(text) }.getOrNull()?.let {
                    dao.putCache(listOf(CacheRecordEntity(key, LocalKinds.WAREHOUSE, it.id.toString(), json.encodeToString(it), System.currentTimeMillis())))
                }
                Outbox.WAREHOUSE_DELETE -> if (id != null) dao.deleteCacheRecord(key, LocalKinds.WAREHOUSE, id.toString())
                Outbox.COUNT_CORRECT -> runCatching { json.decodeFromString<InventoryCountDto>(text) }.getOrNull()?.let {
                    dao.putCache(listOf(CacheRecordEntity(key, InventoryRepository.KIND_COUNTS, it.id.toString(), json.encodeToString(it), System.currentTimeMillis())))
                }
                Outbox.PRODUCT_IMPORT -> refreshCatalog = true
                // Importar al almacén y corregir ventas: el estado nuevo llega con la siguiente bajada de cambios.
            }
            dao.deleteAcknowledged(operation.clientOperationId, key)
        }
        return refreshCatalog
    }

    /**
     * Alta confirmada: en UNA transacción guarda temporal -> real en `id_map`, reescribe los ids de las operaciones
     * pendientes de toda la tienda y de las ventas guardadas (caché y `sale_line`), y pone la fila real en la caché.
     * Repetirla no cambia nada (ya no queda ningún id temporal que reescribir).
     */
    suspend fun replaceTemp(
        accountKey: String,
        entity: Outbox.Entity,
        temp: Long,
        real: Long,
        created: QueuedOperationEntity,
        row: CacheRecordEntity?,
    ) = database.withTransaction {
        val prefix = shopPrefix(accountKey)
        dao.putIdMap(IdMapEntity(accountKey, entity.key, temp, real))
        for (op in dao.shopQueue(prefix)) {
            if (op.clientOperationId == created.clientOperationId || op.status == QueuedOperationEntity.STATUS_DISCARDED) continue
            val (path, payload) = Outbox.rewrite(entity, temp, real, op.path, op.payload) ?: continue
            dao.setQueueBody(op.clientOperationId, path, payload)
        }
        if (entity == Outbox.Entity.PRODUCT) {
            val rewritten = dao.shopCacheLike(prefix, PosRepository.KIND_SALES, "%\"id\":$temp,%").mapNotNull { cached ->
                runCatching { json.decodeFromString<PosSale>(cached.payload) }.getOrNull()
                    ?.let { Outbox.rewriteSale(it, temp, real) }?.let { cached.accountKey to it }
            }
            rewritten.groupBy({ it.first }, { it.second }).forEach { (account, sales) ->
                val now = System.currentTimeMillis()
                dao.putCache(sales.map { CacheRecordEntity(account, PosRepository.KIND_SALES, it.clientSaleId, json.encodeToString(it), now) })
                SaleIndex.store(dao, account, sales, json)
            }
        }
        if (row != null) dao.putCache(listOf(row))
    }

    private fun requireAccount(session: Session): String =
        accountKeyFromToken(session.token, session.user.id)
            ?: throw IllegalArgumentException("La sesión no contiene una identidad de cuenta válida")

    private companion object { val JSON = "application/json; charset=utf-8".toMediaType() }
}
