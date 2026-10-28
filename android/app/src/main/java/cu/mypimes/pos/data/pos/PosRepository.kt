package cu.mypimes.pos.data.pos

import android.content.Context
import android.util.Log
import androidx.room.withTransaction
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import cu.mypimes.pos.data.auth.Session
import cu.mypimes.pos.data.auth.SecureSessionStore
import cu.mypimes.pos.data.auth.accountKeyFromToken
import cu.mypimes.pos.data.local.CacheRecordEntity
import cu.mypimes.pos.data.local.LocalDao
import cu.mypimes.pos.data.local.LocalDatabase
import cu.mypimes.pos.data.local.QueuedOperationEntity
import cu.mypimes.pos.data.local.SaleIndex
import cu.mypimes.pos.data.local.dependenciesFor
import cu.mypimes.pos.data.local.gateOf
import cu.mypimes.pos.data.local.shopPrefix
import cu.mypimes.pos.data.local.ownerRoleOf
import cu.mypimes.pos.data.store.OwnerOverlay
import cu.mypimes.pos.domain.outbox.Outbox
import cu.mypimes.pos.domain.Payment
import cu.mypimes.pos.domain.pos.CartLine
import cu.mypimes.pos.domain.pos.PosCart
import cu.mypimes.pos.domain.pos.PaymentChoice
import cu.mypimes.pos.domain.pos.PosProduct
import cu.mypimes.pos.domain.pos.PosSale
import cu.mypimes.pos.domain.pos.unacknowledgedReviews
import dagger.hilt.EntryPoint
import dagger.hilt.InstallIn
import dagger.hilt.android.EntryPointAccessors
import dagger.hilt.components.SingletonComponent
import java.io.IOException
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

@Singleton
class PosRepository @Inject constructor(
    private val api: PosApi,
    private val database: LocalDatabase,
    private val dao: LocalDao,
    private val json: Json,
    private val registerIdStore: RegisterIdStore,
    private val syncScheduler: PosSyncScheduler,
    private val catalogScope: CatalogScope,
) {
    private val mutex = Mutex()

    /** Caja central: catálogo y stock compartidos por todo el aparato. Cualquier otra cuenta devuelve su propia clave. */
    fun catalogKey(accountKey: String): String = catalogScope.catalogKey(accountKey)

    fun isCentral(accountKey: String): Boolean = catalogKey(accountKey) != accountKey

    /** Cola que reserva stock y aplica altas del dueño: en caja central la de TODAS las personas; si no, la de la cuenta. */
    fun storeQueue(accountKey: String): Flow<List<QueuedOperationEntity>> =
        if (isCentral(accountKey)) dao.observeShopQueue(shopPrefix(accountKey)) else dao.observeQueue(accountKey)

    private suspend fun storeQueueNow(accountKey: String): List<QueuedOperationEntity> =
        if (isCentral(accountKey)) dao.shopQueue(shopPrefix(accountKey)) else dao.getQueue(accountKey)

    fun products(accountKey: String): Flow<List<PosProduct>> = combine(
        dao.observeCache(catalogKey(accountKey), KIND_PRODUCTS), storeQueue(accountKey),
    ) { cached, queue ->
        // A6: lo que el dueño cambió sin red (altas con id temporal, ediciones, borrados) se ve ya, encima de la caché.
        PosStock.visible(cached.mapNotNull { row -> runCatching { json.decodeFromString<ProductDto>(row.payload) }.getOrNull() }, queue, json)
    }

    /** Guarda el catálogo bajado; en caja central conserva el costo que el cajero no recibe. */
    suspend fun catalogRecords(accountKey: String, incoming: List<ProductDto>, now: Long): List<CacheRecordEntity> {
        val catalog = catalogKey(accountKey)
        val rows = if (catalog == accountKey) incoming else PosStock.keepCosts(incoming, dao.getCacheKind(catalog, KIND_PRODUCTS).mapNotNull {
            runCatching { json.decodeFromString<ProductDto>(it.payload) }.getOrNull()
        })
        return rows.map { CacheRecordEntity(catalog, KIND_PRODUCTS, it.id.toString(), json.encodeToString(it), now) }
    }

    fun hasPendingClose(accountKey: String): Flow<Boolean> =
        dao.observeQueue(accountKey).map { queue ->
            queue.any { it.operationType == OP_CLOSE && it.status in UNCONFIRMED }
        }

    fun sales(accountKey: String): Flow<List<PosSale>> = combine(
        dao.observeCache(accountKey, KIND_SALES), dao.observeQueue(accountKey),
    ) { cached, queue ->
        val byClientId = linkedMapOf<String, PosSale>()
        cached.forEach { row ->
            runCatching { json.decodeFromString<PosSale>(row.payload) }.getOrNull()?.let { sale ->
                sale.serverId?.let { byClientId.remove("server:$it") }
                byClientId[sale.clientSaleId] = sale
            }
        }
        queue.filter { it.operationType == OP_SALE }.forEach { operation ->
            val sale = runCatching { json.decodeFromString<CreateSaleRequest>(operation.payload).toSale(operation.status, operation.lastError) }.getOrNull()
            if (sale != null) {
                val prior = byClientId[sale.clientSaleId]
                byClientId[sale.clientSaleId] = if (prior != null) prior.copy(status = operation.status, error = operation.lastError)
                else sale
            }
        }
        byClientId.values
            .groupBy { it.serverId?.let { id -> "server-id:$id" } ?: "client-id:${it.clientSaleId}" }
            .values
            .map { matches -> matches.firstOrNull { it.serverId != null && it.clientSaleId != "server:${it.serverId}" } ?: matches.first() }
            .filter { it.status != STATUS_SYNCED && it.status != STATUS_VOIDED || isToday(it.createdAt) }
            .sortedByDescending { it.createdAt }
    }

    /** Revisiones del servidor que el cajero no ha reconocido. La venta sigue en el historial. */
    fun unacknowledgedReviews(accountKey: String): Flow<List<PosSale>> = combine(
        sales(accountKey), dao.observeCache(accountKey, KIND_ACKNOWLEDGED),
    ) { sales, acks -> sales.unacknowledgedReviews(acks.mapTo(HashSet()) { it.recordKey }) }

    /** Solo guarda la marca de aviso visto: no toca la venta ni la cola. */
    suspend fun acknowledgeReviews(accountKey: String, clientSaleIds: List<String>) {
        dao.putCache(clientSaleIds.map { CacheRecordEntity(accountKey, KIND_ACKNOWLEDGED, it, "", System.currentTimeMillis()) })
    }

    // La descarga incremental trae varios días; el historial es el de hoy (lo pendiente o por revisar siempre se ve).
    private fun isToday(createdAt: String) =
        cu.mypimes.pos.domain.Format.parseInstant(createdAt)?.atZone(cu.mypimes.pos.domain.Format.cubaZone)
            ?.toLocalDate()?.let(cu.mypimes.pos.domain.Format::isToday) ?: true

    suspend fun refresh(session: Session) = mutex.withLock {
        val accountKey = requireAccount(session)
        val authorization = "Bearer ${session.token}"
        // Do not fetch stock while a previous POST may have succeeded without its ACK
        // being committed locally. Reposting its stable UUID resolves that ambiguity first.
        if (!syncPending(session, accountKey)) return@withLock

        val todayInCuba = LocalDate.now(ZoneId.of(CUBA_ZONE)).format(DateTimeFormatter.ISO_LOCAL_DATE)
        val salesResponse = api.sales(authorization, todayInCuba)
        if (!salesResponse.isSuccessful) throw responseException(salesResponse.code(), salesResponse.errorBody()?.string())
        val products = fetchCatalog(authorization, accountKey)
        val cachedSales = dao.getCacheKind(accountKey, KIND_SALES).mapNotNull { row ->
            runCatching { json.decodeFromString<PosSale>(row.payload) }.getOrNull()?.let { it.clientSaleId to it }
        }.toMap()
        val now = System.currentTimeMillis()
        val refreshed = salesResponse.body().orEmpty().mapNotNull { dto ->
            val prior = dto.clientSaleId?.let(cachedSales::get)
                ?: dto.id?.let { id -> cachedSales.values.firstOrNull { it.serverId == id } }
            dto.toPosSale(prior?.lines.orEmpty())
        }
        val rows = refreshed.map { CacheRecordEntity(accountKey, KIND_SALES, it.clientSaleId, json.encodeToString(it), now) }
        database.withTransaction {
            dao.deleteCacheKind(catalogKey(accountKey), KIND_PRODUCTS)
            if (products.isNotEmpty()) dao.putCache(products)
            if (rows.isNotEmpty()) dao.putCache(rows)
            SaleIndex.store(dao, accountKey, refreshed, json)
        }
    }

    /** Vuelve a bajar solo el catálogo (tras editar productos desde Más). */
    suspend fun refreshCatalog(session: Session) = mutex.withLock {
        val accountKey = requireAccount(session)
        val products = fetchCatalog("Bearer ${session.token}", accountKey)
        database.withTransaction {
            dao.deleteCacheKind(catalogKey(accountKey), KIND_PRODUCTS)
            if (products.isNotEmpty()) dao.putCache(products)
        }
    }

    suspend fun checkout(session: Session, lines: List<CartLine>, cashReceived: String): PosSale =
        checkout(session, lines, PaymentChoice(method = "efectivo", cashReceived = cashReceived))

    suspend fun checkout(session: Session, lines: List<CartLine>, choice: PaymentChoice): PosSale = mutex.withLock {
        val accountKey = requireAccount(session)
        require(lines.isNotEmpty()) { "El carrito está vacío" }
        // Un cierre pendiente cubriría estas ventas nuevas al subir: se bloquea
        // el cobro hasta que el cierre llegue a la nube, igual que en la web.
        require(dao.getQueue(accountKey).none { it.operationType == OP_CLOSE && it.status in UNCONFIRMED }) {
            "Hay un cierre de caja pendiente de sincronizar. Conéctate para confirmarlo antes de cobrar otra venta."
        }
        val total = PosCart.total(lines)
        val payment = resolvePayment(total, choice)
        val createdAt = java.time.Instant.now().toString()
        val clientId = UUID.randomUUID().toString()
        val request = CreateSaleRequest(
            clientSaleId = clientId,
            registerId = registerIdStore.getOrCreate(),
            soldAt = createdAt,
            items = lines.map { line -> SaleItemRequest(
                productId = line.product.id,
                quantity = line.quantity,
                unitPrice = line.unitPrice,
                packSize = if (line.isPack) line.product.packSize else null,
            ) },
            paymentMethod = payment.method,
            cashReceived = payment.cashReceived,
            transferAmount = payment.transferAmount,
            foreignCurrency = payment.currency,
            foreignAmount = payment.foreignAmount,
            exchangeRate = payment.exchangeRate,
            shopRate = payment.shopRate,
        )
        val draft = request.toSale(STATUS_PENDING).copy(lines = lines)
        val central = isCentral(accountKey)
        val operation = QueuedOperationEntity(
            clientOperationId = clientId,
            accountKey = accountKey,
            operationType = OP_SALE,
            path = "/api/sales",
            method = "POST",
            payload = json.encodeToString(request),
            status = QueuedOperationEntity.STATUS_PENDING,
            createdAt = System.currentTimeMillis(),
        )
        // Persist both the user's sale receipt and its outbox row before any network I/O.
        val sale = database.withTransaction {
            val queued = storeQueueNow(accountKey)
            val baseProducts = OwnerOverlay.products(dao.getCacheKind(catalogKey(accountKey), KIND_PRODUCTS).mapNotNull { row ->
                runCatching { json.decodeFromString<ProductDto>(row.payload) }.getOrNull()
            }, queued, json).map { it.toProduct() }.associateBy { it.id }
            val reservations = PosStock.reserved(queued, json)
            val checkedLines = lines.map { line ->
                val current = baseProducts[line.product.id]
                    ?: throw IllegalArgumentException("${line.product.name} ya no está en el catálogo guardado; actualiza los productos")
                val available = (current.stock - (reservations[current.id] ?: 0.0)).coerceAtLeast(0.0)
                line.copy(product = line.product.copy(stock = available, unit = current.unit, trackStock = current.trackStock))
            }
            // A7b: en caja central el stock de este aparato no bloquea el cobro; el servidor decide al subirla.
            PosCart.validate(checkedLines, enforceStock = !central)
            val stored = draft.copy(stockShort = central && PosCart.stockGaps(checkedLines).isNotEmpty())
            dao.putCache(listOf(cacheSale(accountKey, stored)))
            SaleIndex.store(dao, accountKey, listOf(stored), json)
            // A5: una venta con un producto creado sin red sube después de su alta.
            dao.enqueueWithDependencies(
                operation.copy(ownerRole = ownerRoleOf(session.token)),
                dependenciesFor(dao, accountKey, operation.path, operation.payload),
            )
            stored
        }
        try {
            // Scheduling is best effort; still try the immediate send if it fails.
            runCatching { syncScheduler.schedule(accountKey) }
                .onFailure { Log.e(TAG, "No se pudo programar la sincronización de la venta ${sale.clientSaleId}", it) }
            sendOne(session, operation, sale)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            Log.e(TAG, "La venta ${sale.clientSaleId} quedó guardada y pendiente", error)
            val message = "La venta quedó guardada y sigue pendiente de sincronización. ${error.message.orEmpty()}".trim()
            runCatching {
                dao.setQueueState(operation.clientOperationId, accountKey, STATUS_PENDING, operation.attempts + 1, message)
            }
            sale.copy(error = message)
        }
    }

    /** Para la descarga incremental: nada se cobra ni se confirma mientras se aplica una página. */
    suspend fun <T> exclusive(block: suspend () -> T): T = mutex.withLock { block() }

    suspend fun sync(session: Session) = mutex.withLock {
        val accountKey = requireAccount(session)
        syncPending(session, accountKey)
        Unit
    }

    /** Returns false only when authentication is required; transient errors throw, leaving refresh untouched. */
    private suspend fun syncPending(session: Session, accountKey: String): Boolean {
        for (operation in dao.pending(accountKey).filter { it.operationType == OP_SALE }) {
            if (!sendPendingSale(session, accountKey, operation)) return false
        }
        return true
    }

    /** Sube una venta de la cola (para el orden global de `StoreRepository.sync`). False si hace falta iniciar sesión. */
    suspend fun syncOne(session: Session, operation: QueuedOperationEntity): Boolean = mutex.withLock {
        sendPendingSale(session, operation.accountKey, operation)
    }

    private suspend fun sendPendingSale(session: Session, accountKey: String, operation: QueuedOperationEntity): Boolean {
        val authorization = "Bearer ${session.token}"
        // A5: no sube mientras su alta siga pendiente; si esa alta murió, queda bloqueada (nunca borrada).
        when (val gate = gateOf(dao, operation)) {
            is Outbox.Gate.Wait -> return true
            is Outbox.Gate.Block -> {
                dao.setQueueState(operation.clientOperationId, accountKey, STATUS_BLOCKED, operation.attempts, gate.reason)
                return true
            }
            else -> Unit
        }
        val requestResult = runCatching { json.decodeFromString<CreateSaleRequest>(operation.payload) }
        if (requestResult.isFailure) {
            val error = requestResult.exceptionOrNull()
            dao.setQueueState(operation.clientOperationId, accountKey, STATUS_REJECTED, operation.attempts + 1,
                "La venta local no se puede leer: ${error?.message ?: "datos dañados"}")
            return true
        }
        val request = requestResult.getOrThrow()
        val localSale = dao.getCacheRecord(accountKey, KIND_SALES, operation.clientOperationId)
            ?.let { runCatching { json.decodeFromString<PosSale>(it.payload) }.getOrNull() }
            ?: request.toSale(STATUS_PENDING)
        val response = try {
            api.createSale(authorization, request)
        } catch (error: IOException) {
            // Keep pending; WorkManager retries safely with this same UUID.
            dao.setQueueState(operation.clientOperationId, accountKey, STATUS_PENDING,
                operation.attempts + 1, "Sin conexión. La venta quedó guardada y se reintentará.")
            throw error
        }
        when {
            response.isSuccessful -> {
                val body = requireConfirmedSale(response.body(), request.clientSaleId)
                val remote = body.toPosSale(localSale.lines, request.clientSaleId)!!
                persistAcknowledged(accountKey, operation, request, localSale, remote)
            }
            response.code() == 401 -> {
                dao.setQueueState(operation.clientOperationId, accountKey, STATUS_PENDING,
                    operation.attempts, "Inicia sesión de nuevo para sincronizar esta venta.")
                return false
            }
            response.code() == 403 -> dao.setQueueState(operation.clientOperationId, accountKey, STATUS_BLOCKED,
                operation.attempts + 1, apiError(response.errorBody()?.string(), "Operación no permitida para esta cuenta"))
            response.code() == 400 || response.code() == 409 -> dao.setQueueState(operation.clientOperationId, accountKey, STATUS_REJECTED,
                operation.attempts + 1, apiError(response.errorBody()?.string(), "El servidor rechazó la venta"))
            else -> {
                val error = "Error temporal del servidor (${response.code()}); la venta sigue pendiente."
                dao.setQueueState(operation.clientOperationId, accountKey, STATUS_PENDING, operation.attempts + 1, error)
                throw IOException(error)
            }
        }
        return true
    }

    private suspend fun sendOne(session: Session, operation: QueuedOperationEntity, localSale: PosSale): PosSale {
        // A5: con un alta sin subir delante, la venta espera (o queda bloqueada en la siguiente pasada).
        if (gateOf(dao, operation) !is Outbox.Gate.Ready) return localSale
        return try {
            val request = json.decodeFromString<CreateSaleRequest>(operation.payload)
            val response = api.createSale("Bearer ${session.token}", request)
            when {
                response.isSuccessful -> {
                    val body = requireConfirmedSale(response.body(), request.clientSaleId)
                    val sale = body.toPosSale(localSale.lines, request.clientSaleId)!!.copy(status = STATUS_SYNCED)
                    persistAcknowledged(operation.accountKey, operation, request, localSale, sale)
                    sale
                }
                response.code() == 401 -> {
                    val error = "Inicia sesión de nuevo para sincronizar esta venta."
                    dao.setQueueState(operation.clientOperationId, operation.accountKey, STATUS_PENDING, operation.attempts, error)
                    localSale.copy(error = error)
                }
                response.code() == 403 -> {
                    val error = apiError(response.errorBody()?.string(), "Operación no permitida para esta cuenta")
                    dao.setQueueState(operation.clientOperationId, operation.accountKey, STATUS_BLOCKED, operation.attempts + 1, error)
                    localSale.copy(status = STATUS_BLOCKED, error = error)
                }
                response.code() == 400 || response.code() == 409 -> {
                    val error = apiError(response.errorBody()?.string(), "El servidor rechazó la venta")
                    dao.setQueueState(operation.clientOperationId, operation.accountKey, STATUS_REJECTED, operation.attempts + 1, error)
                    localSale.copy(status = STATUS_REJECTED, error = error)
                }
                else -> {
                    val error = "Error temporal del servidor (${response.code()}); la venta quedó guardada."
                    dao.setQueueState(operation.clientOperationId, operation.accountKey, STATUS_PENDING, operation.attempts + 1, error)
                    localSale.copy(error = error)
                }
            }
        } catch (error: IOException) {
            val message = "Sin conexión. La venta quedó guardada para sincronizar después."
            dao.setQueueState(operation.clientOperationId, operation.accountKey, STATUS_PENDING, operation.attempts + 1, message)
            localSale.copy(error = message)
        }
    }

    private data class ResolvedPayment(
        val method: String,
        val cashReceived: Double,
        val transferAmount: Double? = null,
        val currency: String? = null,
        val foreignAmount: Double? = null,
        val exchangeRate: Double? = null,
        val shopRate: Double? = null,
    )

    /** Traduce la elección de la UI a lo que acepta el servidor, con las mismas reglas de la web. */
    private fun resolvePayment(total: Double, choice: PaymentChoice): ResolvedPayment {
        return when (choice.method) {
            "transferencia" -> ResolvedPayment("transferencia", 0.0)
            "mixto" -> {
                val transfer = Payment.clampTransfer(choice.transferAmount, total, choice.transferLimit)
                when {
                    transfer <= 0.0 -> ResolvedPayment("efectivo", 0.0)
                    transfer >= total -> ResolvedPayment("transferencia", 0.0)
                    else -> ResolvedPayment("mixto", 0.0, Payment.round2(transfer))
                }
            }
            "divisa" -> {
                val fields = Payment.foreignFields(
                    "divisa", choice.currency, choice.foreignAmount, choice.exchangeRate, choice.shopRate,
                )
                val cup = Payment.foreignBreakdown(total, fields.foreign_amount, fields.exchange_rate).foreignCup
                require(cup <= total + 0.005) {
                    "La divisa entregada cubre más que el total; devuelve el vuelto en pesos y vuelve a intentar"
                }
                ResolvedPayment(
                    "divisa", 0.0, null, fields.foreign_currency,
                    fields.foreign_amount, fields.exchange_rate, fields.shop_rate,
                )
            }
            else -> {
                val cash = Payment.cashPaymentBreakdown(total, choice.cashReceived)
                require(cash.canConfirm) {
                    if (cash.validAmount) "El efectivo recibido no alcanza para cubrir el total"
                    else "Escribe un efectivo recibido válido"
                }
                ResolvedPayment("efectivo", cash.receivedCents!! / 100.0)
            }
        }
    }

    private fun requireAccount(session: Session): String = accountKeyFromToken(session.token, session.user.id)
        ?: throw IllegalArgumentException("La sesión no contiene una identidad de cuenta válida")

    private fun cacheSale(accountKey: String, sale: PosSale) = CacheRecordEntity(
        accountKey, KIND_SALES, sale.clientSaleId, json.encodeToString(sale), System.currentTimeMillis(),
    )

    private suspend fun fetchCatalog(authorization: String, accountKey: String): List<CacheRecordEntity> {
        val response = api.products(authorization)
        if (!response.isSuccessful) throw responseException(response.code(), response.errorBody()?.string())
        return catalogRecords(accountKey, response.body().orEmpty(), System.currentTimeMillis())
    }

    private suspend fun persistAcknowledged(
        accountKey: String,
        operation: QueuedOperationEntity,
        request: CreateSaleRequest,
        localSale: PosSale,
        confirmedSale: PosSale,
    ) {
        database.withTransaction {
            val stockByProduct = request.items.groupBy { it.productId }
            val catalog = catalogKey(accountKey)
            val productRows = dao.getCacheKind(catalog, KIND_PRODUCTS).map { row ->
                val dto = runCatching { json.decodeFromString<ProductDto>(row.payload) }.getOrNull()
                val soldLines = dto?.let { stockByProduct[it.id] }.orEmpty()
                if (dto == null || soldLines.isEmpty()) row else {
                    val requested = soldLines.sumOf { it.quantity * (it.packSize ?: 1) }
                    val newStock = if (dto.unit != null) {
                        if (dto.trackStock == 0) dto.stock
                        else roundQuantity((dto.stock - minOf(dto.stock, requested)).coerceAtLeast(0.0))
                    } else roundQuantity((dto.stock - requested).coerceAtLeast(0.0))
                    row.copy(payload = json.encodeToString(dto.copy(stock = newStock)), updatedAt = System.currentTimeMillis())
                }
            }
            dao.deleteCacheKind(catalog, KIND_PRODUCTS)
            if (productRows.isNotEmpty()) dao.putCache(productRows)
            val synced = confirmedSale.copy(lines = localSale.lines, status = STATUS_SYNCED)
            dao.putCache(listOf(cacheSale(accountKey, synced)))
            SaleIndex.store(dao, accountKey, listOf(synced), json)
            dao.deleteAcknowledged(operation.clientOperationId, accountKey)
        }
    }

    private fun roundQuantity(value: Double): Double = kotlin.math.floor(value * 1000.0 + 0.5) / 1000.0

    private fun responseException(code: Int, body: String?): IOException = IOException(apiError(body, "Error al descargar datos ($code)"))

    private fun apiError(body: String?, fallback: String): String = body?.let {
        runCatching { json.decodeFromString<ErrorDto>(it).error }.getOrNull()
    }?.takeIf { it.isNotBlank() } ?: fallback

    private fun CreateSaleRequest.toSale(status: String, error: String? = null) = PosSale(
        clientSaleId = clientSaleId,
        total = Payment.round2(items.sumOf { Payment.round2(it.quantity * it.unitPrice) }),
        cashReceived = cashReceived,
        createdAt = soldAt,
        status = status,
        error = error,
        paymentMethod = paymentMethod,
        transferAmount = transferAmount,
        foreignCurrency = foreignCurrency,
        foreignAmount = foreignAmount,
        exchangeRate = exchangeRate,
        shopRate = shopRate,
        registerId = registerId,
        lines = items.map { item ->
            val product = cu.mypimes.pos.domain.pos.PosProduct(item.productId, "Producto #${item.productId}", item.unitPrice,
                0.0, packSize = item.packSize)
            CartLine(product, item.quantity, item.packSize != null)
        },
    )

    companion object {
        const val KIND_PRODUCTS = "pos_products"
        const val KIND_SALES = "pos_sales"
        const val KIND_ACKNOWLEDGED = "pos_acknowledged_reviews"
        const val OP_SALE = "sale"
        const val OP_CLOSE = "close"
        const val STATUS_PENDING = "pending"
        const val STATUS_SYNCED = "synced"
        const val STATUS_REJECTED = "rejected"
        const val STATUS_BLOCKED = "blocked"
        const val STATUS_VOIDED = "voided"
        private const val CUBA_ZONE = "America/Havana"
        private const val TAG = "PosRepository"
        private val UNCONFIRMED = setOf(STATUS_PENDING, STATUS_REJECTED, STATUS_BLOCKED)
    }
}

@EntryPoint
@InstallIn(SingletonComponent::class)
interface PosWorkerEntryPoint {
    fun posRepository(): PosRepository
    fun changesSync(): cu.mypimes.pos.data.sync.ChangesSync
    fun storeRepository(): cu.mypimes.pos.data.store.StoreRepository
    fun sessionStore(): SecureSessionStore
    fun sharedDevice(): cu.mypimes.pos.data.shared.SharedDeviceRepository
}

class PosSyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val expectedAccount = inputData.getString(INPUT_ACCOUNT) ?: return Result.failure()
        val entryPoint = EntryPointAccessors.fromApplication(applicationContext, PosWorkerEntryPoint::class.java)
        val current = entryPoint.sessionStore().read()
        // Caja compartida: las operaciones de otro cajero suben con su propia credencial, nunca con la del actual.
        val session = current?.takeIf { accountKeyFromToken(it.token, it.user.id) == expectedAccount }
            ?: entryPoint.sharedDevice().credentialFor(expectedAccount)
            ?: return Result.success()
        return try {
            entryPoint.storeRepository().sync(session)
            entryPoint.changesSync().sync(session)
            Result.success()
        } catch (_: IOException) {
            Result.retry()
        } catch (_: Exception) {
            Result.retry()
        }
    }

    companion object { const val INPUT_ACCOUNT = "account_key" }
}
