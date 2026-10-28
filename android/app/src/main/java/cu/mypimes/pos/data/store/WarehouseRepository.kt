package cu.mypimes.pos.data.store

import cu.mypimes.pos.data.auth.ApiErrorDto
import cu.mypimes.pos.data.auth.Session
import cu.mypimes.pos.data.auth.accountKeyFromToken
import cu.mypimes.pos.data.local.LocalDao
import cu.mypimes.pos.data.local.LocalKinds
import cu.mypimes.pos.data.local.OfflineException
import cu.mypimes.pos.data.local.Served
import cu.mypimes.pos.data.sync.ChangesCursors
import cu.mypimes.pos.domain.outbox.Outbox
import cu.mypimes.pos.domain.warehouse.WarehouseImportRow
import java.io.IOException
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import retrofit2.Response

/**
 * Almacén solo en línea, como en la web: no hay cola ni caché. Sin red se avisa y no se guarda nada.
 * Cada pase lleva un id de cliente estable, así que reintentar el mismo pase no lo duplica.
 */
@Singleton
class WarehouseRepository @Inject constructor(
    private val api: StoreApi,
    private val json: Json,
    private val dao: LocalDao,
    private val outbox: OwnerOutbox,
) {
    /** Con red manda el servidor; sin red, el dueño ve el último almacén bajado, con su antigüedad. Siempre con lo pendiente del dueño encima. */
    suspend fun items(session: Session): Served<List<WarehouseItemDto>> = try {
        Served(withPending(session, call("No se pudo cargar el almacén.") { api.warehouse(auth(session)) }))
    } catch (offline: OfflineException) {
        val saved = saved<WarehouseItemDto>(session, LocalKinds.WAREHOUSE, offline)
        Served(withPending(session, saved.data).sortedBy { it.name.lowercase() }, saved.staleSince)
    }

    private suspend fun withPending(session: Session, items: List<WarehouseItemDto>): List<WarehouseItemDto> {
        val key = accountKeyFromToken(session.token, session.user.id) ?: return items
        return OwnerOverlay.warehouse(items, dao.getQueue(key), json)
    }

    private fun stable(body: JsonObject, operationId: String) = JsonObject(body + ("operation_id" to JsonPrimitive(operationId)))

    /**
     * Alta si `editing` es null; si no, edición. Sin id de cliente: el servidor no lo acepta aquí.
     * Reponer manda `add_quantity` (se suma), nunca el total, como la web.
     */
    suspend fun saveItem(
        session: Session,
        editing: WarehouseItemDto?,
        name: String,
        cost: Double,
        unit: String?,
        quantity: Double?,
    ): WarehouseItemDto {
        val body = buildJsonObject {
            put("name", name.trim().replace(Regex("\\s+"), " "))
            put("cost", cost)
            // Explícito: sin "unit" el servidor conserva la unidad anterior y no se puede pasar a pieza.
            put("unit", unit)
            if (editing == null) put("quantity", quantity ?: 0.0)
            else if (quantity != null && quantity > 0) put("add_quantity", quantity)
        }
        if (outbox.central(session)) {
            // Caja central: a la cola con operation_id estable; el alta recibe un id temporal negativo.
            val operationId = UUID.randomUUID().toString()
            val queued = stable(body, operationId)
            if (editing == null) {
                val temp = outbox.nextTempId(accountKeyFromToken(session.token, session.user.id) ?: throw IOException("Sesión inválida"), Outbox.Entity.WAREHOUSE)
                outbox.enqueue(session, Outbox.WAREHOUSE_CREATE, "POST", "/api/warehouse", queued, operationId, temp.toString())
                return WarehouseItemDto(temp, name.trim().replace(Regex("\\s+"), " "), unit, cost, quantity ?: 0.0)
            }
            outbox.enqueue(session, Outbox.WAREHOUSE_UPDATE, "PUT", "/api/warehouse/${editing.id}", queued, operationId)
            return OwnerOverlay.editItem(editing, body)
        }
        return call(SAVE_FAILED, offline = UNSAFE_OFFLINE) {
            if (editing == null) api.createWarehouseItem(auth(session), body)
            else api.updateWarehouseItem(auth(session), editing.id, body)
        }
    }

    /** Caja central: las escrituras del dueño van a la cola y no necesitan red. */
    fun queuesWrites(session: Session) = outbox.central(session)

    /** Importación masiva (cualquier cuenta, como la web). Todo o nada. */
    suspend fun importRows(session: Session, rows: List<WarehouseImportRow>, addStock: Boolean): ImportResultDto {
        val body = buildJsonObject {
            put("stock_mode", if (addStock) "sumar" else "reemplazar")
            putJsonArray("items") {
                rows.forEach { row ->
                    add(buildJsonObject {
                        put("name", row.name)
                        put("unit", row.unit)
                        put("cost", row.cost)
                        put("quantity", row.quantity)
                    })
                }
            }
        }
        if (outbox.central(session)) {
            val operationId = UUID.randomUUID().toString()
            outbox.enqueue(session, Outbox.WAREHOUSE_IMPORT, "POST", "/api/warehouse/import", stable(body, operationId), operationId)
            return ImportResultDto(total = rows.size, queued = true)
        }
        val response = try {
            api.importWarehouse(auth(session), body)
        } catch (error: IOException) {
            throw IOException(UNSAFE_OFFLINE)
        }
        if (!response.isSuccessful) {
            val message = response.errorBody()?.string()?.let { runCatching { json.decodeFromString<ApiErrorDto>(it).error }.getOrNull() }
            throw IOException(message?.takeIf { it.isNotBlank() } ?: "No se pudo importar.")
        }
        return response.body() ?: throw IOException("No se pudo importar.")
    }

    /** Solo dueño en la pantalla; el servidor deja borrar a cualquier cuenta. */
    suspend fun deleteItem(session: Session, id: Long) {
        if (outbox.central(session)) {
            val operationId = UUID.randomUUID().toString()
            outbox.enqueue(session, Outbox.WAREHOUSE_DELETE, "DELETE", "/api/warehouse/$id", buildJsonObject { put("operation_id", operationId) }, operationId)
            return
        }
        call(DELETE_FAILED, offline = UNSAFE_OFFLINE) { api.deleteWarehouseItem(auth(session), id) }
    }

    /** Solo dueño: el servidor responde 403 a un cajero. */
    suspend fun changes(session: Session): List<WarehouseChangeDto> =
        call("No se pudo cargar el historial.") { api.warehouseChanges(auth(session)) }

    /** Solo dueño: el servidor responde 403 a un cajero. */
    suspend fun transfers(session: Session): Served<List<WarehousePassDto>> = try {
        Served(call("No se pudo cargar el historial.") { api.warehouseTransfers(auth(session)) })
    } catch (offline: OfflineException) {
        val saved = saved<WarehousePassDto>(session, LocalKinds.WAREHOUSE_TRANSFERS, offline)
        Served(saved.data.sortedWith(compareByDescending<WarehousePassDto> { it.createdAt.orEmpty() }.thenByDescending { it.id }), saved.staleSince)
    }

    private suspend inline fun <reified T> saved(session: Session, kind: String, offline: OfflineException): Served<List<T>> {
        val key = accountKeyFromToken(session.token, session.user.id)
        if (key == null || !session.user.isOwner) throw offline
        val since = dao.getCursors(key).firstOrNull { it.cursorName == ChangesCursors.LAST_OK }?.value?.takeIf { it > 0 } ?: throw offline
        return Served(dao.getCacheKind(key, kind).mapNotNull { runCatching { json.decodeFromString<T>(it.payload) }.getOrNull() }, since)
    }

    suspend fun toStore(session: Session, request: ToStoreTransferRequest): WarehousePassDto =
        call("No se pudo transferir.") { api.transferToStore(auth(session), request) }

    suspend fun fromStore(session: Session, request: FromStoreTransferRequest): WarehousePassDto =
        call("No se pudo pasar al almacén.") { api.transferToWarehouse(auth(session), request) }

    private suspend fun <T> call(
        fallback: String,
        offline: String = "Sin conexión con el servidor. No se guardó nada; revisa internet e inténtalo de nuevo.",
        block: suspend () -> Response<T>,
    ): T {
        val response = try {
            block()
        } catch (error: IOException) {
            throw OfflineException(offline)
        }
        if (!response.isSuccessful) {
            val message = response.errorBody()?.string()?.let { runCatching { json.decodeFromString<ApiErrorDto>(it).error }.getOrNull() }
            throw IOException(message?.takeIf { it.isNotBlank() } ?: fallback)
        }
        return response.body() ?: throw IOException(fallback)
    }

    private fun auth(session: Session) = "Bearer ${session.token}"

    private companion object {
        const val SAVE_FAILED = "No se pudo guardar el artículo."
        const val DELETE_FAILED = "No se pudo eliminar el artículo."
        // Alta, reposición y borrado no llevan id de cliente: si la respuesta se pierde, puede que ya estén guardados.
        const val UNSAFE_OFFLINE = "Sin conexión con el servidor. Puede que el cambio sí se haya guardado: revisa el almacén antes de intentarlo otra vez."
    }
}
