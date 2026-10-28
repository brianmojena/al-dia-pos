package cu.mypimes.pos.domain.auth

/** Espejo de `client/src/lib/plans.js` y de `server/lib/plans.js` (mismos topes; el árbitro es el servidor). */
object Plans {
    const val BASIC = "basic"
    const val ENTERPRISE = "enterprise"

    // Un plan desconocido (valores viejos 'premium'/'dev') se trata como Basic, igual que el servidor.
    fun planOf(plan: String?): String = if (plan == ENTERPRISE) ENTERPRISE else BASIC
    fun label(plan: String?): String = if (planOf(plan) == ENTERPRISE) "Enterprise" else "Basic"
    fun maxUsers(plan: String?): Int = if (planOf(plan) == ENTERPRISE) 10 else 5
}

/** Reglas de los formularios de cuenta, iguales que en `Register.jsx` y `RecuperarContrasena.jsx`. */
object AccountForms {
    const val MIN_PASSWORD = 6
    /** Soporte por WhatsApp de la recuperación de contraseña (mismo número que la web). */
    const val WHATSAPP_SUPPORT = "5359306972"

    /** El código de recuperación es alfanumérico en mayúsculas; se filtra mientras se escribe. */
    fun normalizeCode(raw: String): String = raw.uppercase().filter { it in 'A'..'Z' || it in '0'..'9' }

    fun validateRegister(storeName: String, email: String, password: String, confirm: String): String? = when {
        storeName.isBlank() -> "Escribe el nombre de tu tienda"
        email.isBlank() -> "Escribe tu correo electrónico"
        password != confirm -> "Las contraseñas no coinciden"
        password.length < MIN_PASSWORD -> "La contraseña debe tener al menos $MIN_PASSWORD caracteres"
        else -> null
    }

    fun validateReset(email: String, code: String, password: String, confirm: String): String? = when {
        email.isBlank() -> "Por favor ingresa tu correo"
        code.isBlank() -> "Por favor ingresa el código"
        password != confirm -> "Las contraseñas no coinciden"
        password.length < MIN_PASSWORD -> "La contraseña debe tener al menos $MIN_PASSWORD caracteres"
        else -> null
    }
}
