package cu.mypimes.pos.domain.shared

import cu.mypimes.pos.data.auth.ApiUserDto
import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Casos de `sharedDevice.test.js`. */
class SharedEnrollmentTest {
    private val now = 1_800_000_000_000L
    // PBKDF2 real con pocas vueltas para que la prueba sea rápida.
    private val fast: (String, String, Int) -> String = { pin, salt, _ -> PinCrypto.derive(pin, salt, 1000) }

    private fun jwt(account: Int, exp: Long = now / 1000 + 86400, shop: Int = 7, device: String = "device-one") =
        "x." + Base64.getUrlEncoder().withoutPadding().encodeToString(
            """{"userId":$shop,"accountId":$account,"role":"cajero","deviceId":"$device","exp":$exp}""".toByteArray(),
        ) + ".x"

    private fun pin(value: String): StoredPin {
        val salt = "00112233445566778899aabbccddeeff"
        return StoredPin(salt, PinCrypto.derive(value, salt, 1000), 1000)
    }

    private fun bundle(continuous: Boolean = true, expAt: Long = now / 1000 + 86400, withPins: Boolean = true) = SharedBundle(
        SharedDeviceInfo("device-one", 7, "Mostrador", continuous, java.time.Instant.ofEpochMilli(now + 86_400_000).toString()),
        listOf(12, 13).map { id ->
            SharedWireCashier(id, "$id@test.local", "Cajero $id",
                ApiUserDto(id = id, email = "$id@test.local", role = "cajero"), jwt(id, expAt),
                if (withPins) pin(if (id == 12) "123456" else "654321") else null)
        },
    )

    private fun installed() = SharedLogic.install(bundle(), now)

    @Test
    fun installKeepsOnlyVerifiers() {
        val record = installed()
        val stored = kotlinx.serialization.json.Json.encodeToString(SharedEnrollment.serializer(), record)
        assertFalse(stored.contains("123456") || stored.contains("654321"))
        assertEquals(2, record.activeMembers.size)
    }

    @Test
    fun installNeedsPinsAndValidTokens() {
        try { SharedLogic.install(bundle(withPins = false), now); fail() } catch (e: SharedException) {
            assertEquals("Cada cajero necesita un PIN de 6 dígitos.", e.message)
        }
        val wrongShop = bundle().let { b -> b.copy(cashiers = b.cashiers.map { it.copy(token = jwt(it.id, shop = 99)) }) }
        try { SharedLogic.install(wrongShop, now); fail() } catch (e: SharedException) {
            assertTrue(e.message!!.contains("no corresponden"))
        }
        try { SharedLogic.install(bundle(expAt = now / 1000 - 1), now); fail() } catch (_: SharedException) {}
    }

    @Test
    fun eachPinSelectsItsOwnIdentity() {
        val ok = SharedLogic.unlock(installed(), 12, "123456", now, fast) as UnlockResult.Ok
        assertEquals(12, ok.member.user.id)
        assertEquals(12, ok.record.lastAccountId)
        val other = SharedLogic.unlock(ok.record, 13, "123456", now, fast)
        assertTrue(other is UnlockResult.Failed) // el PIN de 12 no abre a 13
    }

    @Test
    fun fiveFailuresBlockForAMinuteAndPersist() {
        var record = installed()
        repeat(4) {
            val r = SharedLogic.unlock(record, 12, "000000", now, fast) as UnlockResult.Failed
            assertEquals("PIN incorrecto.", r.message)
            record = r.record
        }
        val fifth = SharedLogic.unlock(record, 12, "000000", now, fast) as UnlockResult.Failed
        assertTrue(fifth.message.contains("Espera un minuto"))
        try { SharedLogic.unlock(fifth.record, 12, "123456", now, fast); fail() } catch (e: SharedException) {
            assertTrue(e.message!!.contains("Espera un minuto"))
        }
        assertTrue(SharedLogic.unlock(fifth.record, 12, "123456", now + 61_000, fast) is UnlockResult.Ok)
    }

    @Test
    fun unknownDisabledOrExpiredCannotEnter() {
        val record = installed()
        try { SharedLogic.unlock(record, 99, "123456", now, fast); fail() } catch (e: SharedException) {
            assertTrue(e.message!!.contains("no está autorizado"))
        }
        val disabled = SharedLogic.disable(record, 12, null)
        assertEquals(listOf(13), disabled.activeMembers.map { it.id })
        try { SharedLogic.unlock(disabled, 12, "123456", now, fast); fail() } catch (_: SharedException) {}
        val blocked = SharedLogic.block(record, "Caja retirada")
        try { SharedLogic.unlock(blocked, 13, "654321", now, fast); fail() } catch (e: SharedException) {
            assertEquals("Caja retirada", e.message)
        }
        try { SharedLogic.unlock(record, 13, "654321", now + 90_000_000, fast); fail() } catch (_: SharedException) {}
    }

    @Test
    fun renewalKeepsPinsAndRejectsOtherDeviceOrMode() {
        val record = SharedLogic.block(SharedLogic.disable(installed(), 12, "x"), "Caja retirada")
        val renewed = SharedLogic.refresh(record, bundle(withPins = false), now)
        assertEquals("", renewed.blocked)
        assertTrue(renewed.cashiers.none { it.disabled })
        assertEquals(record.cashiers[1].pin, renewed.cashiers[1].pin)
        try { SharedLogic.refresh(record, bundle(continuous = false), now); fail() } catch (e: SharedException) {
            assertTrue(e.message!!.contains("no corresponde"))
        }
        // Un cajero que ya no viene en la renovación queda deshabilitado, no borrado (conserva su credencial).
        val partial = bundle().let { it.copy(cashiers = it.cashiers.take(1)) }
        val after = SharedLogic.refresh(installed(), partial, now)
        assertTrue(after.cashiers.first { it.id == 13 }.disabled)
        assertNotNull(after.cashiers.first { it.id == 13 }.token)
    }

    @Test
    fun registerMatchesServerRule() {
        val device = bundle().device
        assertEquals("shared:device-one", SharedLogic.registerOf(device, 12))
        assertEquals("shared:device-one:12", SharedLogic.registerOf(device.copy(continuous = false), 12))
        assertEquals("device-one", SharedLogic.claims(jwt(12))?.deviceId)
        assertNull(SharedLogic.claims("basura"))
    }
}
