package cu.mypimes.pos.domain.shared

import cu.mypimes.pos.data.auth.ApiUserDto
import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Dueño como miembro de la caja central (A1). */
class CentralOwnerTest {
    private val now = 1_800_000_000_000L
    private val fast: (String, String, Int) -> String = { pin, salt, _ -> PinCrypto.derive(pin, salt, 1000) }
    private val salt = "00112233445566778899aabbccddeeff"
    private fun pin(v: String) = StoredPin(salt, PinCrypto.derive(v, salt, 1000), 1000)

    private fun jwt(account: Int, role: String, mode: String? = null, shop: Int = 7) =
        "x." + Base64.getUrlEncoder().withoutPadding().encodeToString(
            ("""{"userId":$shop,"accountId":$account,"role":"$role","deviceId":"d1","exp":${now / 1000 + 86400}""" +
                (mode?.let { ""","deviceMode":"$it"""" } ?: "") + "}").toByteArray(),
        ) + ".x"

    private fun owner(mode: String? = "central", role: String = "dueño") = SharedWireCashier(
        7, "dueno@test.local", "Dueño", ApiUserDto(id = 7, email = "dueno@test.local", role = "dueño"),
        jwt(7, role, mode), pin("12345678"), role = "dueño",
    )

    private fun cashier() = SharedWireCashier(
        12, "12@test.local", "Cajero", ApiUserDto(id = 12, email = "12@test.local", role = "cajero"),
        jwt(12, "cajero"), pin("123456"),
    )

    private fun bundle(central: Boolean = true, ownerMember: SharedWireCashier = owner()) = SharedBundle(
        SharedDeviceInfo("d1", 7, "Central", true, java.time.Instant.ofEpochMilli(now + 86_400_000).toString(), central),
        listOf(ownerMember, cashier()),
    )

    @Test
    fun oldStoreWithoutRoleStillReads() {
        val old = """{"device":{"id":"d1","owner_id":7,"continuous":true,"expires_at":"2030-01-01T00:00:00Z"},
            "cashiers":[{"id":12,"user":{"id":12,"email":"a@b.c","role":"cajero"},"token":"t",
            "pin":{"salt":"00","hash":"x","iterations":1},"failures":2}]}"""
        val record = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }.decodeFromString<SharedEnrollment>(old)
        assertFalse(record.isCentral)
        assertEquals("cajero", record.cashiers[0].role)
        assertEquals(2, record.cashiers[0].failures)
        assertEquals(0, record.cashiers[0].lockRounds)
    }

    @Test
    fun ownerTokenOnlyValidInCentralDevice() {
        val record = SharedLogic.install(bundle(), now)
        val member = record.cashiers.first { it.isOwner }
        assertEquals("dueño", member.role)
        assertFalse(member.user.isAdmin)
        assertTrue(member.user.toApiUser().isOwner)
        for (bad in listOf(
            bundle(central = false),
            bundle(ownerMember = owner(mode = null)),
            bundle(ownerMember = owner(role = "cajero")),
        )) try { SharedLogic.validate(bad, now); fail() } catch (_: SharedException) {}
        // Un cajero no puede hacerse pasar por dueño con rol de miembro.
        val fake = bundle().let { b -> b.copy(cashiers = listOf(b.cashiers[0], b.cashiers[1].copy(role = "dueño"))) }
        try { SharedLogic.validate(fake, now); fail() } catch (_: SharedException) {}
    }

    @Test
    fun ownerNeedsEightDigitsAndLockGrows() {
        var record = SharedLogic.install(bundle(), now)
        assertTrue(SharedLogic.unlock(record, 7, "123456", now, fast) is UnlockResult.Failed)
        var t = now
        val waits = listOf(60_000L, 300_000L, 3_600_000L, 3_600_000L)
        for (wait in waits) {
            var last: UnlockResult.Failed? = null
            repeat(5) { last = SharedLogic.unlock(record, 7, "00000000", t, fast) as UnlockResult.Failed; record = last!!.record }
            val until = record.cashiers.first { it.isOwner }.blockedUntil
            assertEquals(t + wait, until)
            t = until + 1
        }
        val ok = SharedLogic.unlock(record, 7, "12345678", t, fast) as UnlockResult.Ok
        assertEquals(0, ok.member.lockRounds)
    }

    @Test
    fun cashierLockStaysFlat() {
        var record = SharedLogic.install(bundle(), now)
        repeat(5) { record = (SharedLogic.unlock(record, 12, "000000", now, fast) as UnlockResult.Failed).record }
        assertEquals(now + 60_000L, record.cashiers.first { it.id == 12 }.blockedUntil)
        assertEquals(0, record.cashiers.first { it.id == 12 }.lockRounds)
    }

    @Test
    fun reauthWindowOpensAndExpires() {
        val reauth = OwnerReauth()
        assertFalse(reauth.isOpen(now))
        reauth.open(now)
        assertTrue(reauth.isOpen(now + OwnerReauth.GRACE_MS - 1))
        assertFalse(reauth.isOpen(now + OwnerReauth.GRACE_MS))
        reauth.open(now); reauth.close()
        assertFalse(reauth.isOpen(now))
    }

    @Test
    fun ownerRegisterIsTheDeviceOne() {
        val device = bundle().device
        assertEquals("shared:d1", SharedLogic.registerOf(device, 7))
        assertEquals(SharedLogic.registerOf(device, 12), SharedLogic.registerOf(device, 7))
        assertEquals("shared:d1", SharedLogic.registerOf(device.copy(continuous = false), 7)) // central nunca es por turno
    }
}
