package cu.mypimes.pos.data.auth

import java.util.Base64
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json

/**
 * Decodes JWT ownership claims for local scoping; the server remains responsible for signature
 * verification. A supplied API account id must match the token's accountId claim.
 */
fun accountKeyFromToken(
    token: String?,
    expectedAccountId: Int? = null,
    expectedShopId: Int? = null,
): String? {
    if (token.isNullOrBlank()) return null
    val encodedPayload = token.split('.').getOrNull(1) ?: return null
    return runCatching {
        val bytes = Base64.getUrlDecoder().decode(encodedPayload)
        val claims = Json { ignoreUnknownKeys = true }.decodeFromString<IdentityClaims>(String(bytes, Charsets.UTF_8))
        // userId is always the shop scope; pre-role tokens omit accountId, not userId.
        val shopId = claims.userId?.takeIf { it > 0 } ?: return null
        val accountId = (claims.accountId ?: claims.userId)?.takeIf { it > 0 } ?: return null
        if (expectedAccountId != null && accountId != expectedAccountId.toLong()) return null
        if (expectedShopId != null && shopId != expectedShopId.toLong()) return null
        "$shopId:$accountId"
    }.getOrNull()
}

@Serializable
private data class IdentityClaims(val userId: Long? = null, val accountId: Long? = null)
