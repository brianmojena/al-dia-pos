package cu.mypimes.pos.domain

import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneOffset

/**
 * Día del negocio, la misma regla que `server/lib/businessDay.js`: todo se guarda en UTC y el día es el de la
 * zona de la tienda (Cuba). Una venta de las 9 de la noche en La Habana ya es del día siguiente en UTC, pero
 * pertenece al día en que se hizo. Java ya conoce los cambios de horario de la zona, así que no hacen falta
 * las fronteras a mano del servidor.
 */
object BusinessDay {
    // Como HAS_ZONE del servidor: el texto ya trae zona (Z o +05:00).
    private val HAS_ZONE = Regex("(Z|[+-]\\d{2}:?\\d{2})$", RegexOption.IGNORE_CASE)
    private val OFFSET_WITHOUT_COLON = Regex("([+-]\\d{2})(\\d{2})$")

    /**
     * Instante de lo que haya guardado (`instantFrom` del servidor): 'YYYY-MM-DD HH:MM:SS' es UTC, la 'T' es
     * opcional y, si trae zona, se respeta. Texto vacío, ilegible o solo con fecha: null.
     */
    fun instantOf(stored: String?): Instant? {
        val text = stored?.trim()?.replace(' ', 'T')?.takeIf { it.isNotEmpty() } ?: return null
        return runCatching {
            if (HAS_ZONE.containsMatchIn(text)) {
                OffsetDateTime.parse(text.replace(OFFSET_WITHOUT_COLON, "$1:$2").uppercase()).toInstant()
            } else LocalDateTime.parse(text).toInstant(ZoneOffset.UTC)
        }.getOrNull()
    }

    fun dateOf(instant: Instant): LocalDate = instant.atZone(Format.cubaZone).toLocalDate()

    /** 'YYYY-MM-DD' del día del negocio de una marca de tiempo guardada, o null si no se puede leer. */
    fun dateOf(stored: String?): String? = instantOf(stored)?.let { dateOf(it).toString() }

    /** Primer instante (inclusive) del día del negocio indicado; el día anterior termina justo aquí. */
    fun startOf(date: LocalDate): Instant = date.atStartOfDay(Format.cubaZone).toInstant()
}
