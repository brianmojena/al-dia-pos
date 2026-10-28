package cu.mypimes.pos.ui.pos

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cu.mypimes.pos.data.auth.AuthRepository
import cu.mypimes.pos.data.auth.DeviceRatesStore
import cu.mypimes.pos.data.auth.EffectiveRate
import cu.mypimes.pos.data.auth.Session
import cu.mypimes.pos.data.auth.accountKeyFromToken
import cu.mypimes.pos.data.pos.PosRepository
import cu.mypimes.pos.data.sync.ChangesSync
import cu.mypimes.pos.domain.pos.CartLine
import cu.mypimes.pos.domain.pos.PaymentChoice
import cu.mypimes.pos.domain.pos.PosCart
import cu.mypimes.pos.domain.pos.PosProduct
import cu.mypimes.pos.domain.pos.PosSale
import dagger.hilt.android.lifecycle.HiltViewModel
import java.io.IOException
import javax.inject.Inject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

data class PosUiState(
    val sessionToken: String? = null,
    val products: List<PosProduct> = emptyList(),
    val sales: List<PosSale> = emptyList(),
    val cart: List<CartLine> = emptyList(),
    val rates: Map<String, EffectiveRate> = emptyMap(),
    val hasPendingClose: Boolean = false,
    val unreviewed: List<PosSale> = emptyList(),
    val loading: Boolean = true,
    /** Caja central: el stock de este aparato no bloquea añadir ni cobrar (A7b). */
    val central: Boolean = false,
    val refreshing: Boolean = false,
    val syncing: Boolean = false,
    val error: String? = null,
    val refreshFailed: Boolean = false,
    val actionMessage: String? = null,
    val lastSavedSale: PosSale? = null,
) {
    val cartCount: Double get() = cart.sumOf { it.quantity }
    val total: Double get() = PosCart.total(cart)
    val pendingSales: Int get() = sales.count { it.status != "synced" && !it.isVoided }
}

@HiltViewModel
class PosViewModel @Inject constructor(
    private val repository: PosRepository,
    private val authRepository: AuthRepository,
    private val deviceRates: DeviceRatesStore,
    private val changesSync: ChangesSync,
) : ViewModel() {
    private val _state = MutableStateFlow(PosUiState())
    val state = _state.asStateFlow()

    private var activeSession: Session? = null
    private var accountKey: String? = null
    private var productsJob: Job? = null
    private var salesJob: Job? = null
    private var pendingJob: Job? = null
    private var reviewJob: Job? = null
    private var busy = false

    /** Rebinds both live streams to the new account and never carries cart state across sessions. */
    fun bindSession(session: Session) {
        if (activeSession?.token == session.token) return
        val current = authRepository.session.value
        if (current?.token != session.token) {
            clearAccountState()
            return
        }
        productsJob?.cancel()
        salesJob?.cancel()
        pendingJob?.cancel()
        reviewJob?.cancel()
        activeSession = session
        accountKey = accountKeyFromToken(session.token, session.user.id)
        busy = false
        _state.value = PosUiState(
            sessionToken = session.token,
            loading = true,
            central = accountKey?.let(repository::isCentral) == true,
            rates = ratesFor(session),
        )
        val key = accountKey
        if (key == null) {
            _state.value = PosUiState(loading = false, error = "No se pudo identificar la cuenta de esta sesión.")
            return
        }
        productsJob = viewModelScope.launch {
            repository.products(key).collectLatest { products ->
                if (accountKey == key) _state.value = _state.value.copy(products = products, loading = false)
            }
        }
        salesJob = viewModelScope.launch {
            repository.sales(key).collectLatest { sales ->
                if (accountKey == key) _state.value = _state.value.copy(sales = sales)
            }
        }
        pendingJob = viewModelScope.launch {
            repository.hasPendingClose(key).collectLatest { pending ->
                if (accountKey == key) _state.value = _state.value.copy(hasPendingClose = pending)
            }
        }
        reviewJob = viewModelScope.launch {
            repository.unacknowledgedReviews(key).collectLatest { unreviewed ->
                if (accountKey == key) _state.value = _state.value.copy(unreviewed = unreviewed)
            }
        }
        refresh(session)
    }

    fun rates(): Map<String, EffectiveRate> = _state.value.rates

    fun setDeviceRate(currency: String, rate: Double?) {
        val session = activeSession ?: return
        deviceRates.setDeviceRate(currency, rate)
        _state.value = _state.value.copy(rates = ratesFor(session))
    }

    fun addProduct(product: PosProduct, quantity: Double, isPack: Boolean) {
        if (busy) return
        try {
            _state.value = _state.value.copy(cart = PosCart.add(_state.value.cart, product, quantity, isPack, enforceStock = !_state.value.central), error = null)
        } catch (error: Exception) {
            _state.value = _state.value.copy(error = error.message ?: "No se pudo añadir el producto.")
        }
    }

    fun changeQuantity(index: Int, quantity: Double) {
        if (busy || index !in _state.value.cart.indices) return
        try {
            _state.value = _state.value.copy(cart = PosCart.changeQuantity(_state.value.cart, index, quantity, enforceStock = !_state.value.central), error = null)
        } catch (error: Exception) {
            _state.value = _state.value.copy(error = error.message ?: "Cantidad no válida.")
        }
    }

    /** Fija la cantidad de un producto por peso en el carrito (no suma). */
    fun setWeightQuantity(product: PosProduct, quantity: Double) {
        val index = _state.value.cart.indexOfFirst { it.product.id == product.id && !it.isPack }
        if (index >= 0) changeQuantity(index, quantity) else addProduct(product, quantity, false)
    }

    fun removeLine(index: Int) = changeQuantity(index, 0.0)

    fun clearCart() {
        if (busy) return
        _state.value = _state.value.copy(cart = emptyList(), error = null)
    }

    fun refresh() {
        val session = activeSession ?: return
        refresh(session)
    }

    fun refresh(session: Session) {
        if (busy || _state.value.refreshing) return
        _state.value = _state.value.copy(refreshing = true, error = null, refreshFailed = false)
        viewModelScope.launch {
            try {
                repository.refresh(session)
                changesSync.sync(session)
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                if (activeSession?.token == session.token) {
                    val message = if (error is IOException) "Sin conexión. Se mantienen los datos guardados; puedes reintentar."
                    else error.message ?: "No se pudo actualizar. Puedes reintentar."
                    _state.value = _state.value.copy(error = message, refreshFailed = true)
                }
            } finally {
                if (activeSession?.token == session.token) _state.value = _state.value.copy(refreshing = false, loading = false)
            }
        }
    }

    fun checkout(session: Session, choice: PaymentChoice) {
        if (busy || activeSession?.token != session.token) return
        val lines = _state.value.cart
        try {
            PosCart.validate(lines, enforceStock = !_state.value.central)
        } catch (error: Exception) {
            _state.value = _state.value.copy(error = error.message ?: "Revisa el carrito.")
            return
        }
        busy = true
        _state.value = _state.value.copy(syncing = true, error = null, actionMessage = null)
        viewModelScope.launch {
            try {
                val sale = repository.checkout(session, lines, choice.copy(transferLimit = session.user.transferLimit))
                if (activeSession?.token == session.token) {
                    // A returned sale means the repository has committed it locally, even offline.
                    _state.value = _state.value.copy(
                        cart = emptyList(), syncing = false, lastSavedSale = sale,
                        actionMessage = when (sale.status) {
                            "synced" -> "Venta sincronizada."
                            "rejected" -> "Venta guardada, pero rechazada por el servidor: ${sale.error ?: "revisa el historial"}"
                            "blocked" -> "Venta guardada, pero bloqueada por el servidor: ${sale.error ?: "revisa el historial"}"
                            else -> "Guardada en dispositivo. Queda pendiente de sincronización." +
                                if (sale.stockShort) " $STOCK_SHORT_NOTICE" else ""
                        },
                    )
                }
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                if (activeSession?.token == session.token) {
                    // Preserve the cart: an exception cannot be treated as a successful local save.
                    _state.value = _state.value.copy(syncing = false, error = error.message ?: "No se confirmó el guardado. Revisa el historial antes de volver a cobrar.")
                }
            } finally {
                if (activeSession?.token == session.token) {
                    busy = false
                    _state.value = _state.value.copy(syncing = false)
                }
            }
        }
    }

    fun sync(session: Session) {
        if (busy || activeSession?.token != session.token) return
        busy = true
        _state.value = _state.value.copy(syncing = true, error = null, actionMessage = null)
        viewModelScope.launch {
            try {
                repository.sync(session)
                changesSync.sync(session)
                if (activeSession?.token == session.token) _state.value = _state.value.copy(actionMessage = "Sincronización solicitada.")
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                if (activeSession?.token == session.token) _state.value = _state.value.copy(error = error.message ?: "No se pudo sincronizar. Las operaciones siguen guardadas.")
            } finally {
                if (activeSession?.token == session.token) {
                    busy = false
                    _state.value = _state.value.copy(syncing = false)
                }
            }
        }
    }

    /** Reconoce el aviso del POS; las ventas siguen en el historial con su estado. */
    fun acknowledgeReviews() {
        val key = accountKey ?: return
        val ids = _state.value.unreviewed.map { it.clientSaleId }
        if (ids.isEmpty()) return
        viewModelScope.launch { repository.acknowledgeReviews(key, ids) }
    }

    fun dismissMessages() {
        _state.value = _state.value.copy(error = null, actionMessage = null, lastSavedSale = null)
    }

    private fun ratesFor(session: Session): Map<String, EffectiveRate> =
        listOf("USD", "EUR").associateWith { deviceRates.effective(session.user, it) }

    private fun clearAccountState() {
        productsJob?.cancel()
        salesJob?.cancel()
        pendingJob?.cancel()
        reviewJob?.cancel()
        productsJob = null
        salesJob = null
        pendingJob = null
        reviewJob = null
        activeSession = null
        accountKey = null
        busy = false
        _state.value = PosUiState(loading = false)
    }
}

const val STOCK_SHORT_NOTICE = "Stock de este aparato no alcanza; el servidor lo confirmará."
