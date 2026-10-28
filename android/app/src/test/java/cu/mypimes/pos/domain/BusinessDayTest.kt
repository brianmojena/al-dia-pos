package cu.mypimes.pos.domain

import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Casos de `server/test/businessDay.test.js`: el día del negocio es el de Cuba, no el de UTC. */
class BusinessDayTest {
    @Test fun dayStartsAtMidnightInCubaNotUtc() {
        assertEquals(Instant.parse("2026-01-15T05:00:00Z"), BusinessDay.startOf(LocalDate.parse("2026-01-15"))) // invierno UTC-5
        assertEquals(Instant.parse("2026-06-15T04:00:00Z"), BusinessDay.startOf(LocalDate.parse("2026-06-15"))) // verano UTC-4
    }

    @Test fun anNinePmSaleBelongsToTheDayItWasMade() {
        // 21:00 del 10 de septiembre en Cuba son las 01:00 UTC del 11.
        assertEquals("2026-09-10", BusinessDay.dateOf("2026-09-11 01:00:00"))
    }

    @Test fun earlyMorningUtcIsStillThePreviousDayInCuba() {
        assertEquals("2026-07-13", BusinessDay.dateOf("2026-07-14T02:10:00Z"))
        assertEquals("2026-07-13", BusinessDay.dateOf("2026-07-14 03:59:59")) // verano: 23:59:59 local
        assertEquals("2026-07-14", BusinessDay.dateOf("2026-07-14 04:00:00")) // medianoche local exacta: día que empieza
        assertEquals("2026-01-14", BusinessDay.dateOf("2026-01-15 04:59:59")) // invierno
        assertEquals("2026-01-15", BusinessDay.dateOf("2026-01-15 05:00:00"))
    }

    @Test fun daylightSavingDaysLast23And25HoursAndNothingIsLostOrCountedTwice() {
        fun hours(date: String) = Duration.between(
            BusinessDay.startOf(LocalDate.parse(date)), BusinessDay.startOf(LocalDate.parse(date).plusDays(1)),
        ).toHours()
        assertEquals(23L, hours("2026-03-08")) // la medianoche del adelanto no existe
        assertEquals(25L, hours("2026-11-01"))
        assertEquals("2026-03-07", BusinessDay.dateOf("2026-03-08 04:59:59"))
        assertEquals("2026-03-08", BusinessDay.dateOf("2026-03-08 05:00:00")) // 01:00 local
        assertEquals("2026-11-01", BusinessDay.dateOf("2026-11-02 04:59:59"))
        assertEquals("2026-11-02", BusinessDay.dateOf("2026-11-02 05:00:00"))
        var day = LocalDate.parse("2026-01-01")
        repeat(400) { // los días son contiguos: el fin de uno es el inicio del siguiente
            val edge = BusinessDay.startOf(day.plusDays(1))
            assertEquals(day.toString(), BusinessDay.dateOf(edge.minusSeconds(1)).toString())
            assertEquals(day.plusDays(1).toString(), BusinessDay.dateOf(edge).toString())
            day = day.plusDays(1)
        }
    }

    @Test fun readsStoredTimestampsHoweverTheyComeLikeTheServer() {
        assertEquals("2026-07-14", BusinessDay.dateOf("2026-07-14 09:10:00"))
        assertEquals("2026-07-14", BusinessDay.dateOf("2026-07-14T09:10:00")) // la T sin zona también es UTC
        assertEquals("2026-07-14", BusinessDay.dateOf("2026-07-14T09:10:00.123Z"))
        assertEquals("2026-07-13", BusinessDay.dateOf("2026-07-14T03:30:00+00:00"))
        assertEquals("2026-07-14", BusinessDay.dateOf("2026-07-14T05:10:00-04:00"))
        assertEquals("2026-07-14", BusinessDay.dateOf("2026-07-14T05:10:00-0400"))
        assertEquals("2026-07-14", BusinessDay.dateOf("2026-07-14T23:30:00-04:00")) // zona explícita: manda la zona
        assertNull(BusinessDay.dateOf(null))
        assertNull(BusinessDay.dateOf(""))
        assertNull(BusinessDay.dateOf("no es una fecha"))
        assertNull(BusinessDay.dateOf("2026-07-14")) // sin hora no se puede atribuir un día: no se indexa
    }

    @Test fun matchesFormatBusinessDateForNow() {
        val before = Format.businessDate()
        val now = BusinessDay.dateOf(Instant.now()).toString()
        assertTrue(now == before || now == Format.businessDate()) // solo difiere si el reloj cruza la medianoche
    }
}
