package cu.mypimes.pos.data.store

import cu.mypimes.pos.data.auth.ApiErrorDto
import cu.mypimes.pos.data.auth.Session
import cu.mypimes.pos.data.local.LocalDao
import cu.mypimes.pos.data.pos.PosRepository
import cu.mypimes.pos.data.auth.accountKeyFromToken
import cu.mypimes.pos.data.pos.ProductDto
import cu.mypimes.pos.domain.outbox.Outbox
import cu.mypimes.pos.domain.products.ProductDraft
import cu.mypimes.pos.domain.products.ProductImportRow
import cu.mypimes.pos.domain.products.number
import java.io.IOException
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.math.floor
import kotlin.math.round
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

private const val IMPORT_OFFLINE = "Sin conexión con el servidor. Puede que la importación sí se haya guardado: revisa los productos antes de intentarlo otra vez."

@Serializable
data class ProductSaveDto(val id: Long, val name: String, val merged: Boolean = false)

/**
 * Productos desde la pantalla Más. Solo en línea: el alta, edición y baja se
 * envían al servidor y, si no hay red, se avisa sin guardar nada en el teléfono.
 * La lectura sale de la misma caché que usa el POS.
 */
@Singleton
class ProductRepository @Inject constructor(
    private val api: StoreApi,
    private val dao: LocalDao,
    private val json: Json,
    private val posRepository: PosRepository,
    private val outbox: OwnerOutbox,
) {
    /** Lo del servidor más lo que el dueño cambió sin red y aún no sube (ver `OwnerOverlay`). */
    fun catalog(accountKey: String): Flow<List<ProductDto>> =
        combine(dao.observeCache(posRepository.catalogKey(accountKey), PosRepository.KIND_PRODUCTS), posRepository.storeQueue(accountKey)) { rows, queue ->
            OwnerOverlay.products(rows.mapNotNull { row -> runCatching { json.decodeFromString<ProductDto>(row.payload) }.getOrNull() }, queue, json)
                .sortedBy { it.name.lowercase() }
        }

    /** Null si la lista quedó al día; si no, el motivo para mostrar. */
    suspend fun refresh(session: Session): String? = runCatching { posRepository.refreshCatalog(session) }
        .exceptionOrNull()?.let { "No se pudo actualizar la lista de productos. Revisa la conexión." }

    /** Caja central: las escrituras del dueño van a la cola y no necesitan red. */
    fun queuesWrites(session: Session) = outbox.central(session)

    /** Alta si `editing` es null; si no, edición. Mismo cuerpo que manda la web. */
    suspend fun save(
        session: Session,
        editing: ProductDto?,
        draft: ProductDraft,
        owner: Boolean,
        operationId: String,
    ): ProductSaveDto {
        val authorization = "Bearer ${session.token}"
        val body = draft.toRequest(editing, owner, operationId)
        if (outbox.central(session)) {
            // Caja central: primero a la cola con un operation_id estable; el alta recibe un id temporal negativo.
            val stable = JsonObject(body + ("operation_id" to JsonPrimitive(operationId)))
            if (editing == null) {
                val temp = outbox.nextTempId(accountKeyFromToken(session.token, session.user.id) ?: throw IOException("Sesión inválida"), Outbox.Entity.PRODUCT)
                outbox.enqueue(session, Outbox.PRODUCT_CREATE, "POST", "/api/products", stable, operationId, temp.toString())
                return ProductSaveDto(temp, draft.name.trim())
            }
            outbox.enqueue(session, Outbox.PRODUCT_UPDATE, "PUT", "/api/products/${editing.id}", stable, operationId)
            return ProductSaveDto(editing.id, draft.name.trim().ifEmpty { editing.name })
        }
        val response = network {
            if (editing == null) api.createProduct(authorization, body)
            else api.updateProduct(authorization, editing.id, body)
        }
        if (!response.isSuccessful) throw IOException(apiError(response.errorBody()?.string(), "No se pudo guardar el producto"))
        return response.body() ?: throw IOException("Respuesta vacía del servidor")
    }

    suspend fun delete(session: Session, id: Long) {
        if (outbox.central(session)) {
            val operationId = UUID.randomUUID().toString()
            outbox.enqueue(session, Outbox.PRODUCT_DELETE, "DELETE", "/api/products/$id", buildJsonObject { put("operation_id", operationId) }, operationId)
            return
        }
        val response = network { api.deleteProduct("Bearer ${session.token}", id) }
        if (!response.isSuccessful) throw IOException(apiError(response.errorBody()?.string(), "No se pudo eliminar el producto"))
    }

    /**
     * Importación masiva (solo dueño; el servidor lo exige). Todo o nada. Sin red no se guarda nada,
     * salvo que la respuesta se pierda: con "sumar" un reintento sumaría el stock otra vez.
     */
    suspend fun importRows(session: Session, rows: List<ProductImportRow>, addStock: Boolean): ImportResultDto {
        val body = buildJsonObject {
            put("stock_mode", if (addStock) "sumar" else "reemplazar")
            putJsonArray("items") {
                rows.forEach { row ->
                    add(buildJsonObject {
                        put("name", row.name)
                        put("sale_price", row.salePrice)
                        put("purchase_price", row.purchasePrice)
                        put("stock", row.stock)
                    })
                }
            }
        }
        if (outbox.central(session)) {
            val operationId = UUID.randomUUID().toString()
            outbox.enqueue(session, Outbox.PRODUCT_IMPORT, "POST", "/api/products/import",
                JsonObject(body + ("operation_id" to JsonPrimitive(operationId))), operationId)
            return ImportResultDto(total = rows.size, queued = true)
        }
        val response = try {
            api.importProducts("Bearer ${session.token}", body)
        } catch (error: IOException) {
            throw IOException(IMPORT_OFFLINE)
        }
        if (!response.isSuccessful) throw IOException(apiError(response.errorBody()?.string(), "No se pudo importar"))
        return response.body() ?: throw IOException("Respuesta vacía del servidor")
    }

    /**
     * Lo que el servidor exige en cada caso (server/routes/products.js):
     * el dueño manda todo; el cajero solo precio de venta y `add_stock`.
     * Un campo en null se manda explícito: así se quita la unidad o el paquete.
     */
    private fun ProductDraft.toRequest(editing: ProductDto?, owner: Boolean, operationId: String): JsonObject {
        val full = editing == null || owner
        val addQty = if (editing != null && tracksStock) addValue() ?: 0.0 else 0.0
        return buildJsonObject {
            if (full) {
                put("name", name.trim().replace(Regex("\\s+"), " "))
                put("purchase_price", costPerUnit())
                put("sale_price", number(salePrice))
                put("unit", unitOrNull)
                if (byWeight) put("track_stock", trackStock)
                put("pack_size", if (packOn) packSize.toInt() else null)
                put("pack_price", if (packOn) number(packPrice) else null)
                if (tracksStock) put("stock", stockValue() ?: 0.0)
            } else {
                put("sale_price", number(salePrice))
            }
            if (editing != null) {
                if (addQty > 0) put("add_stock", addQty)
                if (full && addQty == 0.0 && tracksStock && stockReason.isNotBlank() && stockValue() != editing.stock) {
                    put("stock_reason", stockReason.trim())
                }
                // Idempotencia: si la respuesta se pierde, reintentar no suma el stock dos veces.
                put("operation_id", operationId)
            }
        }
    }

    private inline fun <T> network(block: () -> T): T = try {
        block()
    } catch (error: IOException) {
        throw IOException("Sin conexión con el servidor. Revisa internet e inténtalo de nuevo; no se guardó nada.")
    }

    private fun apiError(body: String?, fallback: String): String =
        body?.let { runCatching { json.decodeFromString<ApiErrorDto>(it).error }.getOrNull() }
            ?.takeIf { it.isNotBlank() } ?: fallback
}

/** Valores del formulario a partir de un producto guardado. */
fun ProductDto.toDraft(): ProductDraft {
    val weighed = unit != null
    val size = packSize?.takeIf { !weighed && it > 1 }
    val purchase = purchasePrice
    return ProductDraft(
        name = name,
        salePrice = salePrice.field(),
        purchasePrice = purchase?.field().orEmpty(),
        byWeight = weighed,
        unit = unit ?: "lb",
        trackStock = unit == null || trackStock == 1,
        stock = if (size == null) stock.field() else "",
        packOn = size != null,
        packSize = size?.toString().orEmpty(),
        packPrice = if (size != null) packPrice?.field().orEmpty() else "",
        packCost = if (size != null && purchase != null) (round(purchase * size * 100) / 100).field() else "",
        stockPacks = if (size != null) floor(stock / size).toLong().toString() else "",
        stockLoose = if (size != null) (stock - floor(stock / size).toLong() * size).field() else "",
    )
}

private fun Double.field(): String = if (this == floor(this)) toLong().toString() else toString()
