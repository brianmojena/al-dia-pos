package cu.mypimes.pos.data.pos

import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import cu.mypimes.pos.data.auth.ApiUser
import cu.mypimes.pos.data.auth.Session
import cu.mypimes.pos.data.local.LocalDatabase
import cu.mypimes.pos.domain.pos.CartLine
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import retrofit2.Response
import java.io.IOException
import java.util.Base64
import java.util.UUID

/** All API and scheduler calls are fakes. Only a uniquely named test database is used. */
@RunWith(AndroidJUnit4::class)
class PosRepositoryIntegrationTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private lateinit var db: LocalDatabase
    private lateinit var name: String
    private lateinit var api: FakeApi
    private lateinit var repository: PosRepository
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
    private val session = Session(token(77), ApiUser(77, "test@example.test", null, "Prueba", "dueño", false))

    @Before fun prepare() {
        name = "pos-test-${UUID.randomUUID()}.db"
        db = Room.databaseBuilder(context, LocalDatabase::class.java, name).build()
        api = FakeApi()
        repository = repository()
    }

    @After fun cleanOnlyTestDatabase() {
        db.close()
        context.deleteDatabase(name)
    }

    private fun repository() = PosRepository(api, db, db.localDao(), json,
        object : RegisterIdStore { override fun getOrCreate() = "desk-test-device" },
        object : PosSyncScheduler { override fun schedule(accountKey: String) = Unit },
        object : CatalogScope { override fun catalogKey(accountKey: String) = accountKey })

    @Test fun offlineSaleSurvivesDatabaseReopenAndIsAccountScoped() = runBlocking {
        repository.refresh(session)
        val product = repository.products("77:77").first().single()
        api.offline = true
        val sale = repository.checkout(session, listOf(CartLine(product, 2.0)), "50")
        assertEquals("pending", sale.status)
        assertEquals(1, db.localDao().pending("77:77").size)
        assertEquals(8.0, repository.products("77:77").first().single().stock, 0.0)
        db.close()
        db = Room.databaseBuilder(context, LocalDatabase::class.java, name).build()
        repository = repository()
        assertEquals(sale.clientSaleId, repository.sales("77:77").first().single().clientSaleId)
        assertTrue(repository.products("88:88").first().isEmpty())
        assertTrue(repository.sales("88:88").first().isEmpty())
        assertTrue(db.localDao().pending("88:88").isEmpty())
        assertEquals("Bearer ${session.token}", api.lastAuthorization)
    }

    @Test fun lostResponseReusesUuidAndDoesNotRestoreOrDoubleDeductStock() = runBlocking {
        repository.refresh(session)
        val product = repository.products("77:77").first().single()
        api.loseNextAcknowledgement = true
        val saved = repository.checkout(session, listOf(CartLine(product, 2.0)), "50")
        assertEquals("pending", saved.status)
        assertEquals(1, api.accepted.size)
        repository.sync(session)
        assertEquals(2, api.postCalls)
        assertEquals(1, api.accepted.size)
        assertEquals(saved.clientSaleId, api.postedIds.distinct().single())
        assertTrue(db.localDao().pending("77:77").isEmpty())
        assertEquals(8.0, repository.products("77:77").first().single().stock, 0.0)
        repository.refresh(session)
        val history = repository.sales("77:77").first()
        assertEquals(1, history.size)
        assertEquals("synced", history.single().status)
        assertEquals(1, history.single().lines.size)
        assertEquals(8.0, repository.products("77:77").first().single().stock, 0.0)
    }

    @Test fun serverRejectionIsPreservedAndNotAutomaticallyRetried() = runBlocking {
        repository.refresh(session)
        api.reject = true
        val product = repository.products("77:77").first().single()
        val saved = repository.checkout(session, listOf(CartLine(product, 1.0)), "25")
        assertEquals("rejected", saved.status)
        assertEquals("Stock insuficiente", repository.sales("77:77").first().single().error)
        repository.sync(session)
        assertEquals(1, api.postCalls)
        assertEquals("rejected", db.localDao().getQueue("77:77").single().status)
    }

    @Test fun checkoutRevalidatesStockWhenTwoCartsUseSameSnapshot() = runBlocking {
        api.stock = 1.0
        repository.refresh(session)
        val product = repository.products("77:77").first().single()
        api.offline = true
        val results = listOf(
            async { runCatching { repository.checkout(session, listOf(CartLine(product, 1.0)), "25") } },
            async { runCatching { repository.checkout(session, listOf(CartLine(product, 1.0)), "25") } },
        ).map { it.await() }
        assertEquals(1, results.count { it.isSuccess })
        assertEquals(1, db.localDao().pending("77:77").size)
        assertEquals(0.0, repository.products("77:77").first().single().stock, 0.0)
    }

    @Test fun emptyAcknowledgementKeepsDurableOutbox() = runBlocking {
        repository.refresh(session)
        api.emptyAcknowledgement = true
        val product = repository.products("77:77").first().single()
        assertEquals("pending", repository.checkout(session, listOf(CartLine(product, 1.0)), "25").status)
        assertEquals(1, db.localDao().pending("77:77").size)
    }

    private class FakeApi : PosApi {
        var stock = 10.0
        var offline = false
        var reject = false
        var emptyAcknowledgement = false
        var loseNextAcknowledgement = false
        var postCalls = 0
        var lastAuthorization: String? = null
        val accepted = linkedMapOf<String, SaleDto>()
        val postedIds = mutableListOf<String>()

        override suspend fun products(authorization: String): Response<List<ProductDto>> {
            lastAuthorization = authorization
            if (offline) throw IOException("offline")
            return Response.success(listOf(ProductDto(1, "Arroz", 25.0, stock)))
        }
        override suspend fun sales(authorization: String, date: String): Response<List<SaleDto>> {
            lastAuthorization = authorization
            if (offline) throw IOException("offline")
            return Response.success(accepted.values.toList())
        }
        override suspend fun createSale(authorization: String, request: CreateSaleRequest): Response<SaleDto> {
            lastAuthorization = authorization
            postCalls++
            postedIds += request.clientSaleId
            if (offline) throw IOException("offline")
            if (reject) return Response.error(409, """{"error":"Stock insuficiente"}""".toResponseBody("application/json".toMediaType()))
            if (emptyAcknowledgement) return Response.success(null)
            val receipt = accepted.getOrPut(request.clientSaleId) {
                stock -= request.items.sumOf { it.quantity * (it.packSize ?: 1) }
                SaleDto(accepted.size.toLong() + 1, request.clientSaleId,
                    request.items.sumOf { it.quantity * it.unitPrice }, request.cashReceived, request.soldAt)
            }
            if (loseNextAcknowledgement) {
                loseNextAcknowledgement = false
                throw IOException("response lost")
            }
            return Response.success(receipt)
        }
    }

    companion object {
        private fun token(id: Int): String = "header." + Base64.getUrlEncoder().withoutPadding()
            .encodeToString("""{"userId":$id,"accountId":$id}""".toByteArray()) + ".signature"
    }
}
