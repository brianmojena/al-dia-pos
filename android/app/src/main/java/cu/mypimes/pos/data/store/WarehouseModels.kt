package cu.mypimes.pos.data.store

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class WarehouseItemDto(
    val id: Long,
    val name: String,
    val unit: String? = null,
    val cost: Double = 0.0,
    val quantity: Double = 0.0,
)

/** Un pase entre almacén y tienda. `direction` es `to_store` o `to_warehouse`. */
@Serializable
data class WarehousePassDto(
    val id: Long,
    @SerialName("item_name") val itemName: String = "",
    val quantity: Double = 0.0,
    val direction: String = "to_store",
    @SerialName("created_product") val createdProduct: Int = 0,
    @SerialName("account_email") val accountEmail: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
)

@Serializable
data class ToStoreTransferRequest(
    @SerialName("warehouse_item_id") val warehouseItemId: Long,
    val quantity: Double,
    @SerialName("client_transfer_id") val clientTransferId: String,
    /** Solo si el producto aún no existe en la tienda; el servidor lo exige entonces. */
    @SerialName("sale_price") val salePrice: Double? = null,
)

@Serializable
data class FromStoreTransferRequest(
    @SerialName("product_id") val productId: Long,
    val quantity: Double,
    @SerialName("client_transfer_id") val clientTransferId: String,
)

/** Un cambio al almacén (alta, edición, reposición, borrado, importación). Solo lo ve el dueño. */
@Serializable
data class WarehouseChangeDto(
    val id: Long,
    val action: String = "",
    @SerialName("item_name") val itemName: String = "",
    val detail: String? = null,
    @SerialName("account_email") val accountEmail: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
)
