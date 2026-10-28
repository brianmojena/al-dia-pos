package cu.mypimes.pos.domain.cashiers

/** Espejo de `client/src/lib/plans.js` (el servidor es el árbitro; aquí solo se avisa antes de un 409). */
object Plans {
    private val plans = mapOf("basic" to ("Basic" to 5), "enterprise" to ("Enterprise" to 10))
    private fun of(plan: String?) = plans[plan] ?: plans.getValue("basic")
    fun label(plan: String?) = of(plan).first
    fun maxUsers(plan: String?) = of(plan).second
}

/** La cuenta principal también ocupa una plaza. */
fun seatsUsed(cashiers: Int) = cashiers + 1

fun atSeatLimit(plan: String?, cashiers: Int) = seatsUsed(cashiers) >= Plans.maxUsers(plan)

/** Mismas reglas de formulario que el servidor (`POST /api/auth/cashiers`). Devuelve el error o null. */
fun cashierFormError(email: String, password: String): String? = when {
    email.isBlank() || password.isBlank() -> "Email y contraseña son requeridos"
    !Regex("^[^\\s@]+@[^\\s@]+$").matches(email.trim()) -> "Escribe un correo o usuario válido, por ejemplo cajero@mitienda.cu"
    password.length < 6 -> "La contraseña debe tener al menos 6 caracteres"
    else -> null
}
