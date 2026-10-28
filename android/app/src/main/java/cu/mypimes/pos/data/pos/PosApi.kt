package cu.mypimes.pos.data.pos

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import cu.mypimes.pos.domain.pos.CartLine
import cu.mypimes.pos.domain.pos.PosSale
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.POST
import retrofit2.http.Query

/** Wire API kept separate from the app's stable POS models. */
interface PosApi {
    @GET("products")
    suspend fun products(@Header("Authorization") authorization: String): Response<List<ProductDto>>

    @GET("sales")
    suspend fun sales(
        @Header("Authorization") authorization: String,
        @Query("date") date: String,
    ): Response<List<SaleDto>>

    @POST("sales")
    suspend fun createSale(
        @Header("Authorization") authorization: String,
        @Body request: CreateSaleRequest,
    ): Response<SaleDto>
}

@Serializable
data class ProductDto(
    val id: Long,
    val name: String,
    @SerialName("sale_price") val salePrice: Double = 0.0,
    val stock: Double = 0.0,
    val unit: String? = null,
    @SerialName("track_stock") val trackStock: Int? = null,
    @SerialName("pack_size") val packSize: Int? = null,
    @SerialName("pack_price") val packPrice: Double? = null,
    // Costo por suelto: solo lo usa la pantalla de productos (dueño). Puede faltar en caché antigua.
    @SerialName("purchase_price") val purchasePrice: Double? = null,
) {
    fun toProduct() = cu.mypimes.pos.domain.pos.PosProduct(
        id = id, name = name, salePrice = salePrice, stock = stock, unit = unit,
        trackStock = unit == null || trackStock == null || trackStock == 1,
        packSize = packSize, packPrice = packPrice,
    )
}

@Serializable
data class SaleItemRequest(
    @SerialName("product_id") val productId: Long,
    val quantity: Double,
    @SerialName("unit_price") val unitPrice: Double,
    @SerialName("pack_size") val packSize: Int? = null,
)

@Serializable
data class CreateSaleRequest(
    @SerialName("client_sale_id") val clientSaleId: String,
    @SerialName("register_id") val registerId: String,
    @SerialName("sold_at") val soldAt: String,
    val items: List<SaleItemRequest>,
    @SerialName("payment_method") val paymentMethod: String,
    @SerialName("cash_received") val cashReceived: Double,
    @SerialName("transfer_amount") val transferAmount: Double? = null,
    @SerialName("foreign_currency") val foreignCurrency: String? = null,
    @SerialName("foreign_amount") val foreignAmount: Double? = null,
    @SerialName("exchange_rate") val exchangeRate: Double? = null,
    @SerialName("shop_rate") val shopRate: Double? = null,
)

@Serializable
data class SaleDto(
    val id: Long? = null,
    @SerialName("client_sale_id") val clientSaleId: String? = null,
    val total: Double = 0.0,
    @SerialName("cash_received") val cashReceived: Double? = null,
    @SerialName("created_at") val createdAt: String? = null,
    val error: String? = null,
    @SerialName("payment_method") val paymentMethod: String? = null,
    @SerialName("transfer_amount") val transferAmount: Double? = null,
    @SerialName("foreign_currency") val foreignCurrency: String? = null,
    @SerialName("foreign_amount") val foreignAmount: Double? = null,
    @SerialName("exchange_rate") val exchangeRate: Double? = null,
    @SerialName("shop_rate") val shopRate: Double? = null,
    @SerialName("register_id") val registerId: String? = null,
    @SerialName("cash_close_id") val cashCloseId: Long? = null,
    val profit: Double? = null,
    /** Quién cobró; solo lo envía el servidor al dueño (/dashboard/day). */
    @SerialName("account_email") val accountEmail: String? = null,
    val items: List<SaleItemDto> = emptyList(),
)

@Serializable
data class SaleItemDto(
    val id: Long? = null,
    @SerialName("product_id") val productId: Long? = null,
    @SerialName("product_name") val productName: String? = null,
    val quantity: Double = 0.0,
    @SerialName("unit_price") val unitPrice: Double = 0.0,
)

@Serializable
data class ErrorDto(val error: String? = null)

/** Server history omits item details, so callers provide the cached receipt lines when available. */
internal fun SaleDto.toPosSale(
    lines: List<CartLine> = emptyList(),
    fallbackClientSaleId: String? = null,
): PosSale? {
    val stableId = clientSaleId?.takeIf { it.isNotBlank() }
        ?: fallbackClientSaleId?.takeIf { it.isNotBlank() }
        ?: id?.let { "server:$it" }
        ?: return null
    return PosSale(stableId, total, cashReceived ?: 0.0, createdAt ?: "", "synced",
        error = error, serverId = id, lines = lines,
        paymentMethod = paymentMethod ?: "efectivo", transferAmount = transferAmount,
        foreignCurrency = foreignCurrency, foreignAmount = foreignAmount,
        exchangeRate = exchangeRate, shopRate = shopRate, cashCloseId = cashCloseId,
        profit = profit, registerId = registerId, accountEmail = accountEmail)
}

/** A success HTTP code without an identifying receipt is ambiguous and must be retried by client UUID. */
internal fun requireConfirmedSale(dto: SaleDto?, expectedClientSaleId: String): SaleDto {
    if (dto == null) throw java.io.IOException("El servidor no confirmó la venta; sigue pendiente.")
    val returnedClientId = dto.clientSaleId?.takeIf { it.isNotBlank() }
    if (returnedClientId != null && returnedClientId != expectedClientSaleId) {
        throw java.io.IOException("El servidor devolvió otro identificador de venta; sigue pendiente.")
    }
    if (returnedClientId == null && dto.id == null) {
        throw java.io.IOException("La respuesta no contiene una confirmación de venta; sigue pendiente.")
    }
    return dto
}
