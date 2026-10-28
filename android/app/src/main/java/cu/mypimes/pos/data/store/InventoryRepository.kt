package cu.mypimes.pos.data.store

import cu.mypimes.pos.data.auth.ApiErrorDto
import cu.mypimes.pos.data.auth.Session
import cu.mypimes.pos.data.auth.accountKeyFromToken
import cu.mypimes.pos.data.local.CacheRecordEntity
import cu.mypimes.pos.data.local.LocalDao
import cu.mypimes.pos.data.local.LocalKinds
import cu.mypimes.pos.data.local.Served
import cu.mypimes.pos.data.sync.ChangesCursors
import cu.mypimes.pos.domain.Format
import cu.mypimes.pos.data.local.QueueRepository
import cu.mypimes.pos.data.local.QueuedOperationEntity
import cu.mypimes.pos.data.local.dependenciesFor
import cu.mypimes.pos.data.local.gateOf
import cu.mypimes.pos.data.local.ownerRoleOf
import cu.mypimes.pos.domain.outbox.Outbox
import cu.mypimes.pos.data.pos.PosSyncScheduler
import java.io.IOException
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

data class CountOutcome(
    val count: InventoryCountDto? = null,
    val pending: Boolean = false,
    val error: String? = null,
)

/** Un conteo rechazado por el servidor. `reason` es el texto que mandó el servidor. */
data class RejectedCount(val operation: QueuedOperationEntity, val lines: Int, val reason: String)

/** Solo los conteos en estado failed o conflict; los descartados y los pendientes no aparecen. */
internal fun rejectedCountsOf(operations: List<QueuedOperationEntity>, json: Json): List<RejectedCount> =
    operations.filter {
        it.operationType == InventoryRepository.OP_COUNT &&
            (it.status == QueuedOperationEntity.STATUS_FAILED || it.status == QueuedOperationEntity.STATUS_CONFLICT)
    }.map { op ->
        RejectedCount(
            operation = op,
            lines = runCatching { json.decodeFromString<CreateInventoryCountRequest>(op.payload).items.size }.getOrDefault(0),
            reason = op.lastError ?: "El servidor rechazó el arqueo.",
        )
    }

/**
 * Inventario: arqueos. Contar se encola con un id de cliente estable (reintentar no duplica el
 * arqueo). Corregir un arqueo mueve el stock, así que va solo en línea, como en la web.
 */
@Singleton
class InventoryRepository @Inject constructor(
    private val api: StoreApi,
    private val dao: LocalDao,
    private val queue: QueueRepository,
    private val json: Json,
    private val syncScheduler: PosSyncScheduler,
    private val outbox: OwnerOutbox,
) {
    private val mutex = Mutex()

    /** Historial guardado en Room, más reciente primero. Solo el dueño lo llena. */
    fun counts(accountKey: String): Flow<List<InventoryCountDto>> =
        dao.observeCache(accountKey, KIND_COUNTS).map { rows ->
            rows.mapNotNull { row -> runCatching { json.decodeFromString<InventoryCountDto>(row.payload) }.getOrNull() }
                .sortedWith(compareByDescending<InventoryCountDto> { it.countedAt.orEmpty() }.thenByDescending { it.id })
        }

    /** Conteos que el servidor rechazó y siguen en la cola. Se muestran; no se reintentan solos. */
    fun rejectedCounts(accountKey: String): Flow<List<RejectedCount>> =
        queue.observe(accountKey).map { rejectedCountsOf(it, json) }

    /** Solo marca el conteo como descartado; no borra la operación ni sus datos. */
    suspend fun discardRejected(operation: QueuedOperationEntity) = queue.discard(operation)

    /** Null si el historial quedó al día. Un cajero no debe llamarlo (el servidor responde 403). */
    suspend fun refreshCounts(session: Session): String? = try {
        val accountKey = requireAccount(session)
        val response = api.counts("Bearer ${session.token}")
        if (!response.isSuccessful) throw IOException(apiError(response.errorBody()?.string(), "No se pudo cargar el historial."))
        val now = System.currentTimeMillis()
        dao.replaceCacheKind(accountKey, KIND_COUNTS, response.body().orEmpty().map {
            CacheRecordEntity(accountKey, KIND_COUNTS, it.id.toString(), json.encodeToString(it), now)
        })
        null
    } catch (error: IOException) {
        "No se pudo actualizar el historial de arqueos. Revisa la conexión."
    }

    /**
     * Stock del día (solo dueño). Con red se guarda la última respuesta buena; sin red se sirve esa misma, con su
     * antigüedad, solo si es de hoy (el «inicio del día» de otro día engañaría al contar). Null si no hay nada.
     */
    suspend fun dayStock(session: Session): Served<DayStockDto?> {
        val key = requireAccount(session)
        return try {
            val body = api.dayStock("Bearer ${session.token}").let { if (it.isSuccessful) it.body() else null }
            if (body != null) {
                dao.putCache(listOf(CacheRecordEntity(key, LocalKinds.DAY_STOCK, "today", json.encodeToString(body), System.currentTimeMillis())))
            }
            Served(body)
        } catch (error: IOException) {
            val saved = dao.getCacheRecord(key, LocalKinds.DAY_STOCK, "today")
            val day = saved?.let { runCatching { json.decodeFromString<DayStockDto>(it.payload) }.getOrNull() }
            if (saved != null && day != null && day.date == Format.businessDate()) Served(day, saved.updatedAt) else Served(null)
        }
    }

    /** Cuándo se bajó por última vez el historial de arqueos (null si nunca). */
    suspend fun historySavedAt(session: Session): Long? = requireAccount(session).let { key ->
        dao.getCursors(key).firstOrNull { it.cursorName == ChangesCursors.LAST_OK }?.value?.takeIf { it > 0 }
    }

    suspend fun countDetail(session: Session, id: Long): InventoryCountDto {
        val response = online("Hace falta conexión para abrir el arqueo.") {
            api.countDetail("Bearer ${session.token}", id)
        }
        if (!response.isSuccessful) throw IOException(apiError(response.errorBody()?.string(), "No se pudo abrir el arqueo."))
        return response.body() ?: throw IOException("No se pudo abrir el arqueo.")
    }

    /**
     * Cada cambio mueve el stock por la diferencia, igual que en la web. En línea, como siempre; en caja central
     * el dueño la deja en la cola (con `operation_id` estable) y el arqueo mostrado no cambia hasta que suba.
     */
    suspend fun correct(session: Session, id: Long, changes: List<CorrectionLineRequest>): InventoryCountDto? {
        val accountKey = requireAccount(session)
        if (outbox.central(session)) {
            val operationId = UUID.randomUUID().toString()
            outbox.enqueue(session, Outbox.COUNT_CORRECT, "PUT", "/api/inventory-counts/$id",
                kotlinx.serialization.json.buildJsonObject {
                    putJsonArray("items") {
                        changes.forEach { add(buildJsonObject { put("item_id", it.itemId); put("counted", it.counted) }) }
                    }
                    put("operation_id", operationId)
                }, operationId)
            return null
        }
        val response = online("Hace falta conexión para corregir un arqueo.") {
            api.correctCount("Bearer ${session.token}", id, UpdateInventoryCountRequest(changes))
        }
        if (!response.isSuccessful) throw IOException(apiError(response.errorBody()?.string(), "No se pudo guardar la corrección."))
        val body = response.body() ?: throw IOException("No se pudo guardar la corrección.")
        cache(accountKey, body)
        return body
    }

    /** Se encola antes de enviar. Sin red queda pendiente con el mismo id hasta el siguiente sync. */
    suspend fun submitCount(session: Session, lines: List<CountLineRequest>, note: String?): CountOutcome = mutex.withLock {
        val accountKey = requireAccount(session)
        val request = CreateInventoryCountRequest(clientCountId = UUID.randomUUID().toString(), items = lines, note = note)
        val payload = json.encodeToString(request)
        // A5: un arqueo con un producto creado sin red sube después de su alta.
        val id = queue.enqueue(accountKey, OP_COUNT, "/api/inventory-counts", "POST", payload, request.clientCountId,
            dependsOn = dependenciesFor(dao, accountKey, "/api/inventory-counts", payload), ownerRole = ownerRoleOf(session.token))
        runCatching { syncScheduler.schedule(accountKey) }
        val operation = queue.pending(accountKey).firstOrNull { it.clientOperationId == id }
            ?: return@withLock CountOutcome(pending = true)
        if (gateOf(dao, operation) !is Outbox.Gate.Ready) return@withLock CountOutcome(pending = true)
        try {
            CountOutcome(count = postCount(session, operation))
        } catch (rejected: CountRejected) {
            CountOutcome(error = rejected.message)
        } catch (_: IOException) {
            CountOutcome(pending = true)
        }
    }

    /** Sube los conteos pendientes en orden. Al primer fallo de red se detiene y deja el resto pendiente. */
    suspend fun syncCounts(session: Session) {
        val accountKey = requireAccount(session)
        for (operation in queue.pending(accountKey).filter { it.operationType == OP_COUNT }) {
            try {
                syncOne(session, operation)
            } catch (_: IOException) {
                return
            }
        }
    }

    /** Sube un conteo de la cola (orden global de `StoreRepository.sync`). Lanza IOException si falla la red. */
    suspend fun syncOne(session: Session, operation: QueuedOperationEntity) {
        mutex.withLock {
            when (val gate = gateOf(dao, operation)) {
                is Outbox.Gate.Wait -> return
                is Outbox.Gate.Block -> {
                    dao.setQueueState(operation.clientOperationId, operation.accountKey, Outbox.STATUS_BLOCKED, operation.attempts, gate.reason)
                    return
                }
                else -> Unit
            }
            try {
                postCount(session, operation)
            } catch (_: CountRejected) {
                // Queda marcado en la cola con el motivo del servidor; no se reintenta a ciegas.
            }
        }
    }

    private suspend fun postCount(session: Session, operation: QueuedOperationEntity): InventoryCountDto {
        val request = json.decodeFromString<CreateInventoryCountRequest>(operation.payload)
        val response = api.createCount("Bearer ${session.token}", request)
        return when {
            response.isSuccessful -> {
                val body = response.body() ?: throw IOException("El servidor no confirmó el arqueo")
                cache(operation.accountKey, body)
                queue.acknowledge(operation)
                body
            }
            response.code() == 401 -> throw IOException("Sesión caducada")
            response.code() == 409 -> {
                val message = apiError(response.errorBody()?.string(), "El arqueo entra en conflicto con el servidor.")
                queue.markConflict(operation, message)
                throw CountRejected(message)
            }
            response.code() == 400 || response.code() == 403 -> {
                val message = apiError(response.errorBody()?.string(), "El servidor rechazó el arqueo.")
                queue.markFailed(operation, message)
                throw CountRejected(message)
            }
            else -> throw IOException("Error temporal del servidor (${response.code()})")
        }
    }

    private suspend fun cache(accountKey: String, count: InventoryCountDto) {
        dao.putCache(listOf(
            CacheRecordEntity(accountKey, KIND_COUNTS, count.id.toString(), json.encodeToString(count), System.currentTimeMillis()),
        ))
    }

    private inline fun <T> online(message: String, block: () -> T): T = try {
        block()
    } catch (error: IOException) {
        throw IOException(message)
    }

    private fun requireAccount(session: Session): String =
        accountKeyFromToken(session.token, session.user.id)
            ?: throw IllegalArgumentException("La sesión no contiene una identidad de cuenta válida")

    private fun apiError(body: String?, fallback: String): String =
        body?.let { runCatching { json.decodeFromString<ApiErrorDto>(it).error }.getOrNull() }
            ?.takeIf { it.isNotBlank() } ?: fallback

    class CountRejected(message: String) : Exception(message)

    companion object {
        const val KIND_COUNTS = "inventory_counts"
        const val OP_COUNT = "inventory_count"
    }
}
