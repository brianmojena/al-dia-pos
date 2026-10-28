package cu.mypimes.pos.data.auth

import java.util.Base64
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AuthDataTest {
    private val wireJson = Json { ignoreUnknownKeys = true }

    @Test
    fun accountKeyUsesOwnerAndCashierClaimsAndChecksApiIdentity() {
        val ownerToken = jwt("""{"userId":7,"accountId":7,"role":"dueño"}""")
        assertEquals("7:7", accountKeyFromToken(ownerToken, expectedAccountId = 7, expectedShopId = 7))

        val cashierToken = jwt("""{"userId":7,"accountId":13,"role":"cajero"}""")
        assertEquals("7:13", accountKeyFromToken(cashierToken, expectedAccountId = 13, expectedShopId = 7))
        assertNull(accountKeyFromToken(cashierToken, expectedAccountId = 7))
        assertNull(accountKeyFromToken(cashierToken, expectedAccountId = 13, expectedShopId = 13))
    }

    @Test
    fun accountKeySupportsLegacyOwnerClaimsAndRejectsInvalidTokens() {
        assertEquals("4:4", accountKeyFromToken(jwt("""{"userId":4}""")))
        assertNull(accountKeyFromToken(null))
        assertNull(accountKeyFromToken(""))
        assertNull(accountKeyFromToken("not-a-jwt"))
        assertNull(accountKeyFromToken("header.%%%invalid%%%.signature"))
        assertNull(accountKeyFromToken(jwt("""{"accountId":5}""")))
        assertNull(accountKeyFromToken(jwt("""{"userId":0,"accountId":5}""")))
    }

    @Test
    fun loginDtoMapsPublicUserSnakeCaseFieldsAndIgnoresOtherPublicFields() {
        val response = wireJson.decodeFromString<LoginResponse>(
            """{"token":"jwt-token","user":{"id":13,"email":"cashier@example.test","role":"cajero","store_name":"La Tienda","owner_id":7,"is_admin":false,"created_at":"2026-10-28T10:00:00.000Z","plan":"basic"}}""",
        )

        assertEquals("jwt-token", response.token)
        assertEquals(13, response.user.id)
        assertEquals("cashier@example.test", response.user.email)
        assertEquals("cajero", response.user.role)
        assertEquals("La Tienda", response.user.storeName)
        assertEquals(7, response.user.ownerId)
        assertFalse(response.user.isAdmin)

        val user = response.user.toApiUser()
        assertEquals("La Tienda", user.businessName)
        assertEquals("cajero", user.role)
        assertNull(user.name) // publicUser has store_name, not name
        assertFalse(user.isAdmin)
        assertEquals("7:13", accountKeyFromToken(jwt("""{"userId":7,"accountId":13}"""), user.id, response.user.ownerId))
    }

    @Test
    fun loginDtoPreservesOwnerRoleAndAdminFlag() {
        val response = wireJson.decodeFromString<LoginResponse>(
            """{"token":"owner-token","user":{"id":7,"email":"owner@example.test","role":"dueño","store_name":"Negocio","owner_id":null,"is_admin":true}}""",
        )
        val user = response.user.toApiUser()

        assertEquals("dueño", user.role)
        assertEquals("Negocio", user.businessName)
        assertTrue(user.isAdmin)
        assertNull(response.user.ownerId)
    }

    private fun jwt(payload: String): String {
        val encoded = Base64.getUrlEncoder().withoutPadding()
            .encodeToString(payload.toByteArray(Charsets.UTF_8))
        return "header.$encoded.signature"
    }
}
