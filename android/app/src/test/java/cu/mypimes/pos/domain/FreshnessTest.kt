package cu.mypimes.pos.domain

import org.junit.Assert.assertEquals
import org.junit.Test

class FreshnessTest {
    private val now = 10_000_000_000L
    private fun ago(minutes: Long) = Freshness.label(now - minutes * 60_000, now)

    @Test fun labelsAgeInMinutesHoursAndDays() {
        assertEquals("Datos de hace un momento", Freshness.label(now - 5_000, now))
        assertEquals("Datos de hace 5 min", ago(5))
        assertEquals("Datos de hace 3 h", ago(185))
        assertEquals("Datos de hace 1 día", ago(24 * 60 + 5))
        assertEquals("Datos de hace 4 días", ago(4 * 24 * 60))
        assertEquals("Datos de hace un momento", Freshness.label(now + 60_000, now)) // reloj adelantado: no negativo
    }
}
