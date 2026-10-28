package cu.mypimes.pos.data.network

import cu.mypimes.pos.BuildConfig
import cu.mypimes.pos.data.auth.SecureSessionStore
import okhttp3.Interceptor
import okhttp3.Response
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Adds the current bearer credential per request. It deliberately has no logging.
 * Future background sync must capture the token and account key at sync start and use that
 * immutable pair for all its requests; it must not read a newly signed-in account mid-sync.
 */
@Singleton
class AuthorizationInterceptor @Inject constructor(
    private val sessionStore: SecureSessionStore,
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val token = sessionStore.read()?.token
        val explicitAuthorization = chain.request().header("Authorization")
        val request = chain.request().newBuilder().apply {
            // Informativo: el servidor todavía no exige versión mínima (no hay endpoint para ello).
            header("X-App-Version", BuildConfig.VERSION_NAME)
            // Explicit immutable credentials are used by background/outbox calls.
            // Normal app calls still receive the current stored session token.
            if (explicitAuthorization == null && !token.isNullOrBlank()) {
                header("Authorization", "Bearer $token")
            }
        }.build()
        return chain.proceed(request)
    }
}
