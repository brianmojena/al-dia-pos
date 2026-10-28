package cu.mypimes.pos.domain.pos

import cu.mypimes.pos.domain.Payment
import kotlinx.serialization.Serializable

@Serializable
data class PosProduct(
    val id: Long,
    val name: String,
    val salePrice: Double,
    val stock: Double,
    val unit: String? = null,
    val trackStock: Boolean = true,
    val packSize: Int? = null,
    val packPrice: Double? = null,
)

@Serializable
data class CartLine(
    val product: PosProduct,
    val quantity: Double,
    val isPack: Boolean = false,
) {
    val unitPrice: Double
        get() = if (isPack) product.packPrice ?: Double.NaN else product.salePrice

    val stockUnits: Double
        get() = quantity * if (isPack) (product.packSize ?: 0).toDouble() else 1.0

    val lineTotal: Double
        get() = Payment.round2(quantity * unitPrice)
}

@Serializable
data class PosSale(
    val clientSaleId: String,
    val total: Double,
    val cashReceived: Double,
    val createdAt: String,
    val status: String,
    val error: String? = null,
    val serverId: Long? = null,
    val lines: List<CartLine> = emptyList(),
    val paymentMethod: String = "efectivo",
    val transferAmount: Double? = null,
    val foreignCurrency: String? = null,
    val foreignAmount: Double? = null,
    val exchangeRate: Double? = null,
    val shopRate: Double? = null,
    val cashCloseId: Long? = null,
    /** Solo los trae el servidor al dueño (`profit`, quién cobró) o la propia venta (`registerId`); alimentan los reportes sin red. */
    val profit: Double? = null,
    val registerId: String? = null,
    val accountEmail: String? = null,
    /** Caja central: se cobró con más cantidad que el stock de este aparato; el servidor lo confirma al subir. */
    val stockShort: Boolean = false,
) {
    val label: String get() = cu.mypimes.pos.domain.Payment.paymentLabel(paymentMethod, foreignCurrency)
    val isPending: Boolean get() = status == "pending"
    val isSynced: Boolean get() = status == "synced"
    /** El dueño o otra caja la anuló en el servidor; no cuenta en los totales. */
    val isVoided: Boolean get() = status == "voided"
    val isClosed: Boolean get() = !isVoided && status == "synced" && cashCloseId != null
    val needsReview: Boolean get() = status == "rejected" || status == "blocked" || status == "conflict"
}

/** Ventas que el servidor rechazó o bloqueó y que el cajero aún no reconoció en el aviso del POS. */
fun List<PosSale>.unacknowledgedReviews(acknowledged: Set<String>): List<PosSale> =
    filter { it.needsReview && it.clientSaleId !in acknowledged }

/** Lo que el cajero eligió en la hoja de cobro, antes de convertirlo en petición. */
data class PaymentChoice(
    val method: String = "efectivo",
    val cashReceived: String = "",
    val transferAmount: Double = 0.0,
    val currency: String? = null,
    val foreignAmount: Double = 0.0,
    val exchangeRate: Double? = null,
    val shopRate: Double? = null,
    val transferLimit: Double? = null,
)
