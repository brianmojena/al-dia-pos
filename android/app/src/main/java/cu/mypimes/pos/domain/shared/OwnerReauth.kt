package cu.mypimes.pos.domain.shared

/** Ventana de gracia tras validar el PIN del dueño para una acción destructiva (caja central). */
class OwnerReauth {
    private var validUntil = 0L

    fun isOpen(nowMs: Long) = nowMs < validUntil
    fun open(nowMs: Long) { validUntil = nowMs + GRACE_MS }
    fun close() { validUntil = 0 }

    companion object {
        /** No configurable: dos minutos para encadenar acciones sin pedir el PIN cada vez. */
        const val GRACE_MS = 120_000L
    }
}
