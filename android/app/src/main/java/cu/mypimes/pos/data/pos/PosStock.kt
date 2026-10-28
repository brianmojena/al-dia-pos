package cu.mypimes.pos.data.pos

import cu.mypimes.pos.data.local.QueuedOperationEntity
import cu.mypimes.pos.data.store.OwnerOverlay
import cu.mypimes.pos.domain.pos.PosProduct
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json

/**
 * Reglas puras del catálogo y el stock que ve el POS. En caja central la caché de productos es una sola para todo el
 * aparato y la cola es la de todas las personas; aquí no se sabe de eso: quien llama decide qué cola pasa.
 */
object PosStock {
    private val UNCONFIRMED = setOf(
        PosRepository.STATUS_PENDING, PosRepository.STATUS_REJECTED, PosRepository.STATUS_BLOCKED,
    )

    /** Unidades de cada producto ya vendidas en la cola sin confirmar (de cualquier persona cuya cola se pase). */
    fun reserved(queue: List<QueuedOperationEntity>, json: Json): Map<Long, Double> {
        val reserved = mutableMapOf<Long, Double>()
        queue.filter { it.operationType == PosRepository.OP_SALE && it.status in UNCONFIRMED }.forEach { operation ->
            runCatching { json.decodeFromString<CreateSaleRequest>(operation.payload) }.getOrNull()?.items.orEmpty().forEach { item ->
                reserved[item.productId] = (reserved[item.productId] ?: 0.0) + item.quantity * (item.packSize ?: 1)
            }
        }
        return reserved
    }

    /** Caché del servidor + cambios del dueño sin subir (A6) − ventas sin subir. Nunca baja de 0. */
    fun visible(base: List<ProductDto>, queue: List<QueuedOperationEntity>, json: Json): List<PosProduct> {
        val pending = reserved(queue, json)
        return OwnerOverlay.products(base, queue, json).map { it.toProduct() }.map { product ->
            if (!product.trackStock) product
            else product.copy(stock = (product.stock - (pending[product.id] ?: 0.0)).coerceAtLeast(0.0))
        }
    }

    /**
     * El servidor de la tienda compartida no manda el costo a los cajeros: al guardar su bajada en la caché común no
     * se debe borrar el costo que ya bajó el dueño (la pantalla de productos lo muestra y lo reenvía al editar).
     */
    fun keepCosts(incoming: List<ProductDto>, existing: List<ProductDto>): List<ProductDto> {
        val costs = existing.associate { it.id to it.purchasePrice }
        return incoming.map { if (it.purchasePrice == null) it.copy(purchasePrice = costs[it.id]) else it }
    }
}
