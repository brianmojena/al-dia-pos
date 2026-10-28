package cu.mypimes.pos.domain

import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.TextStyle
import java.util.Locale
import kotlin.math.abs
import kotlin.math.roundToLong

/** Texto de dinero y fechas con el mismo tono que la web (es-ES, día del negocio en Cuba). */
object Format {
    val cubaZone: ZoneId = ZoneId.of("America/Havana")
    private val locale = Locale.forLanguageTag("es-ES")

    fun businessDate(): String = LocalDate.now(cubaZone).toString()

    fun money(value: Double, decimals: Int = 0): String {
        if (!value.isFinite()) return "$ 0"
        val factor = if (decimals == 0) 1L else 100L
        val cents = (value * factor).let { if (it < 0) -(-it).roundToLong() else it.roundToLong() }
        val whole = cents / factor
        val fraction = abs(cents % 100L)
        val grouped = whole.toString().reversed().chunked(3).joinToString(".").reversed()
        val sign = if (cents < 0) "-" else ""
        return if (decimals == 0 || fraction == 0L) "$sign$ $grouped"
        else "$sign$ $grouped,${fraction.toString().padStart(2, '0')}"
    }

    fun money2(value: Double): String = money(value, decimals = 2)

    fun signedMoney(value: Double): String {
        val prefix = if (value > 0.004) "+ " else if (value < -0.004) "− " else ""
        val decimals = if (abs(value - value.roundToLong()) > 0.004) 2 else 0
        return prefix + money(abs(value), decimals = decimals)
    }

    fun quantity(value: Double): String {
        if (!value.isFinite()) return "0"
        return if (abs(value - value.roundToLong()) < 0.0005) value.roundToLong().toString()
        else String.format(locale, "%.3f", value).trimEnd('0').trimEnd('.')
    }

    fun rate(value: Double?): String =
        if (value == null || !value.isFinite() || value <= 0) "—" else money(value, decimals = 2).removeSuffix(",00")

    fun foreign(value: Double): String =
        if (abs(value - value.roundToLong()) < 0.0005) value.roundToLong().toString()
        else String.format(locale, "%.2f", value)

    fun parseInstant(raw: String?): Instant? {
        if (raw.isNullOrBlank()) return null
        val value = raw.trim()
        runCatching { return Instant.parse(value) }
        runCatching {
            return LocalDateTime.parse(value.replace(' ', 'T'))
                .atZone(ZoneId.of("UTC")).toInstant()
        }
        runCatching {
            return LocalDate.parse(value.take(10)).atStartOfDay(cubaZone).toInstant()
        }
        return null
    }

    fun dateTime(raw: String?): String {
        val instant = parseInstant(raw) ?: return "—"
        val local = instant.atZone(cubaZone)
        val day = local.format(DateTimeFormatter.ofPattern("d MMM", locale))
        return "$day · ${local.format(DateTimeFormatter.ofPattern("HH:mm"))}"
    }

    fun dateTime(epochMillis: Long): String = dateTime(Instant.ofEpochMilli(epochMillis).toString())

    fun time(raw: String?): String {
        val instant = parseInstant(raw) ?: return "—"
        return instant.atZone(cubaZone).format(DateTimeFormatter.ofPattern("HH:mm"))
    }

    fun dayLabel(raw: String?): String {
        val instant = parseInstant(raw) ?: return "—"
        val local = instant.atZone(cubaZone).toLocalDate()
        return dayLabel(local)
    }

    fun dayLabel(date: LocalDate): String {
        val weekday = date.dayOfWeek.getDisplayName(TextStyle.FULL, locale).replaceFirstChar { it.uppercase(locale) }
        val month = date.month.getDisplayName(TextStyle.FULL, locale)
        return "$weekday ${date.dayOfMonth} de $month"
    }

    fun shortDay(date: LocalDate): String {
        val month = date.month.getDisplayName(TextStyle.SHORT, locale).removeSuffix(".")
        return "${date.dayOfMonth} $month"
    }

    fun isToday(date: LocalDate): Boolean = date == LocalDate.now(cubaZone)
}
