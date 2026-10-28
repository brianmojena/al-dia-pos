package cu.mypimes.pos.data.local

/** Un dato y, si salió de lo guardado en el aparato por falta de red, cuándo se bajó por última vez (epoch ms). */
data class Served<T>(val data: T, val staleSince: Long? = null)

/** Falta de red (no una respuesta del servidor): las pantallas del dueño pueden servirse de lo guardado. */
class OfflineException(message: String) : java.io.IOException(message)
