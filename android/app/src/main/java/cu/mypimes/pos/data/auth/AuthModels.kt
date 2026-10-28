package cu.mypimes.pos.data.auth

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** Stable application model exposed to the UI and domain layers. */
data class Session(val token: String, val user: ApiUser)

data class ApiUser(
    val id: Int,
    val email: String,
    val name: String?,
    val businessName: String?,
    val role: String?,
    val isAdmin: Boolean,
    val transferLimit: Double? = null,
    val usdRate: Double? = null,
    val eurRate: Double? = null,
    val warehouseEnabled: Boolean = true,
    val plan: String? = null,
    val cashierDayBreakdown: Boolean = false,
    /** "pending" mientras administración no confirma el pago; "active" después. */
    val planStatus: String = "active",
    val trialDaysLeft: Int? = null,
    /** Prueba vencida sin confirmar: la app se bloquea hasta que confirmen la tienda (igual que la web). */
    val locked: Boolean = false,
) {
    val isOwner: Boolean get() = role != ROLE_CASHIER
    val isCashier: Boolean get() = role == ROLE_CASHIER
    val displayName: String get() = businessName?.takeIf { it.isNotBlank() } ?: email.substringBefore('@')

    fun shopRate(currency: String): Double? = when (currency) {
        "USD" -> usdRate
        "EUR" -> eurRate
        else -> null
    }

    companion object {
        const val ROLE_CASHIER = "cajero"
    }
}

@Serializable
data class LoginRequest(val email: String, val password: String)

@Serializable
data class LoginResponse(val token: String, val user: ApiUserDto)

@Serializable
data class RegisterRequest(
    @SerialName("store_name") val storeName: String,
    val email: String,
    val password: String,
)

@Serializable
data class ResetPasswordRequest(
    val email: String,
    val code: String,
    @SerialName("new_password") val newPassword: String,
)

/** Wire model. Names reflect the actual publicUser() response from the server. */
@Serializable
data class ApiUserDto(
    val id: Int,
    val email: String,
    val role: String? = null,
    @SerialName("store_name") val storeName: String? = null,
    @SerialName("owner_id") val ownerId: Int? = null,
    @SerialName("is_admin") val isAdmin: Boolean = false,
    @SerialName("transfer_limit") val transferLimit: Double? = null,
    @SerialName("usd_rate") val usdRate: Double? = null,
    @SerialName("eur_rate") val eurRate: Double? = null,
    @SerialName("warehouse_enabled") val warehouseEnabled: Boolean = true,
    val plan: String? = null,
    @SerialName("cashier_day_breakdown") val cashierDayBreakdown: Boolean = false,
    @SerialName("plan_status") val planStatus: String = "active",
    @SerialName("trial_days_left") val trialDaysLeft: Int? = null,
    val locked: Boolean = false,
) {
    fun toApiUser() = ApiUser(
        id = id,
        email = email,
        name = null,
        businessName = storeName,
        role = role,
        isAdmin = isAdmin,
        transferLimit = transferLimit,
        usdRate = usdRate,
        eurRate = eurRate,
        warehouseEnabled = warehouseEnabled,
        plan = plan,
        cashierDayBreakdown = cashierDayBreakdown,
        planStatus = planStatus,
        trialDaysLeft = trialDaysLeft,
        locked = locked,
    )
}

@Serializable
data class ApiErrorDto(val error: String? = null, val code: String? = null)
