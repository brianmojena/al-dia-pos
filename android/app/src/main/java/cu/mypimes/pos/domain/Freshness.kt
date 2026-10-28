package cu.mypimes.pos.domain

/** «Datos de hace X» para lo que se muestra desde el aparato en vez de la nube. */
object Freshness {
    fun ago(sinceMillis: Long, nowMillis: Long): String {
        val minutes = ((nowMillis - sinceMillis).coerceAtLeast(0L)) / 60_000L
        return when {
            minutes < 1 -> "hace un momento"
            minutes < 60 -> "hace $minutes min"
            minutes < 24 * 60 -> "hace ${minutes / 60} h"
            else -> { val days = minutes / (24 * 60); if (days == 1L) "hace 1 día" else "hace $days días" }
        }
    }

    fun label(sinceMillis: Long, nowMillis: Long = System.currentTimeMillis()) = "Datos de ${ago(sinceMillis, nowMillis)}"
}
