package cu.mypimes.pos.data.auth

import android.content.Context
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * La tasa de cambio es del aparato, no de la cuenta: si otro cajero entra en
 * este mismo teléfono, cobra con la tasa que quedó puesta. Espejo de
 * client/src/lib/exchangeRates.js.
 */
data class EffectiveRate(
    val currency: String,
    val rate: Double?,
    val source: String?,
    val shopRate: Double?,
) {
    val hasRate: Boolean get() = rate != null && rate > 0
    val usesDeviceRate: Boolean get() = source == "device"
}

@Singleton
class DeviceRatesStore @Inject constructor(@ApplicationContext context: Context) {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun deviceRate(currency: String): Double? {
        val value = prefs.getFloat(key(currency), UNSET)
        return value.takeIf { it > 0f }?.toDouble()
    }

    fun setDeviceRate(currency: String, rate: Double?) {
        val editor = prefs.edit()
        if (rate == null || !(rate > 0)) editor.remove(key(currency))
        else editor.putFloat(key(currency), rate.toFloat())
        editor.apply()
    }

    fun effective(user: ApiUser, currency: String): EffectiveRate {
        val shop = user.shopRate(currency)
        val device = deviceRate(currency)
        return when {
            device != null -> EffectiveRate(currency, device, "device", shop)
            shop != null -> EffectiveRate(currency, shop, "shop", shop)
            else -> EffectiveRate(currency, null, null, null)
        }
    }

    private fun key(currency: String) = "rate_$currency"

    private companion object {
        const val PREFS = "mypimes_device_rates"
        const val UNSET = -1f
    }
}
