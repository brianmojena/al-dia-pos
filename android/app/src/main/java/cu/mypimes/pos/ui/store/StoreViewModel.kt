package cu.mypimes.pos.ui.store

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cu.mypimes.pos.data.auth.AuthRepository
import cu.mypimes.pos.data.auth.DeviceRatesStore
import cu.mypimes.pos.data.auth.EffectiveRate
import cu.mypimes.pos.data.auth.Session
import cu.mypimes.pos.data.auth.accountKeyFromToken
import cu.mypimes.pos.data.store.CashCloseDto
import cu.mypimes.pos.data.sync.ChangesSync
import cu.mypimes.pos.data.store.CashCloseSummaryDto
import cu.mypimes.pos.data.store.CurrencyPurchaseDto
import cu.mypimes.pos.data.store.CurrentPeriodDto
import cu.mypimes.pos.data.store.DashboardDto
import cu.mypimes.pos.data.store.PendingClose
import cu.mypimes.pos.data.store.PendingPurchase
import cu.mypimes.pos.data.store.PendingWithdrawal
import cu.mypimes.pos.data.store.PurchaseOutcome
import cu.mypimes.pos.data.store.StoreRepository
import cu.mypimes.pos.data.store.WithdrawalDto
import cu.mypimes.pos.domain.Format
import cu.mypimes.pos.domain.Payment
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

data class StoreUiState(
    val sessionToken: String? = null,
    val period: CurrentPeriodDto? = null,
    val closes: List<CashCloseDto> = emptyList(),
    val summary: List<CashCloseSummaryDto> = emptyList(),
    val openWithdrawals: List<WithdrawalDto> = emptyList(),
    val pendingCloses: List<PendingClose> = emptyList(),
    val pendingWithdrawals: List<PendingWithdrawal> = emptyList(),
    val pendingPurchases: List<PendingPurchase> = emptyList(),
    val purchases: List<CurrencyPurchaseDto> = emptyList(),
    val dashboard: DashboardDto? = null,
    val dashboardSavedAt: Long? = null,
    val rates: Map<String, EffectiveRate> = emptyMap(),
    val loading: Boolean = true,
    val refreshing: Boolean = false,
    val busy: Boolean = false,
    val error: String? = null,
    val notice: String? = null,
    val lastClose: CashCloseDto? = null,
    val lastPurchase: PurchaseOutcome? = null,
    val detail: CashCloseDto? = null,
    val detailLoading: Boolean = false,
) {
    val pendingTotal: Int
        get() = pendingCloses.size + pendingWithdrawals.size + pendingPurchases.size
}

@HiltViewModel
class StoreViewModel @Inject constructor(
    private val repository: StoreRepository,
    private val authRepository: AuthRepository,
    private val changesSync: ChangesSync,
    private val deviceRates: DeviceRatesStore,
) : ViewModel() {
    private val _state = MutableStateFlow(StoreUiState())
    val state = _state.asStateFlow()

    private var activeSession: Session? = null
    private var accountKey: String? = null
    private var jobs = mutableListOf<Job>()

    fun bindSession(session: Session) {
        if (activeSession?.token == session.token) return
        if (authRepository.session.value?.token != session.token) {
            clear()
            return
        }
        jobs.forEach(Job::cancel)
        jobs = mutableListOf()
        activeSession = session
        val key = accountKeyFromToken(session.token, session.user.id)
        accountKey = key
        _state.value = StoreUiState(
            sessionToken = session.token,
            loading = true,
            rates = ratesFor(session),
        )
        if (key == null) {
            _state.value = StoreUiState(loading = false, error = "No se pudo identificar la cuenta de esta sesión.")
            return
        }
        collect(key, { repository.period(key) }) { _state.value = _state.value.copy(period = it) }
        collect(key, { repository.closes(key) }) { _state.value = _state.value.copy(closes = it) }
        collect(key, { repository.summary(key) }) { _state.value = _state.value.copy(summary = it) }
        collect(key, { repository.openWithdrawals(key) }) { _state.value = _state.value.copy(openWithdrawals = it) }
        collect(key, { repository.pendingCloses(key) }) { _state.value = _state.value.copy(pendingCloses = it) }
        collect(key, { repository.pendingWithdrawals(key) }) { _state.value = _state.value.copy(pendingWithdrawals = it) }
        collect(key, { repository.pendingPurchases(key) }) { _state.value = _state.value.copy(pendingPurchases = it) }
        collect(key, { repository.purchases(key) }) { _state.value = _state.value.copy(purchases = it) }
        collect(key, { repository.dashboard(key) }) { _state.value = _state.value.copy(dashboard = it) }
        collect(key, { repository.dashboardSavedAt(key) }) { _state.value = _state.value.copy(dashboardSavedAt = it) }
        refresh(session)
    }

    fun refresh(session: Session) {
        if (_state.value.refreshing || _state.value.busy) return
        _state.value = _state.value.copy(refreshing = true, error = null)
        viewModelScope.launch {
            var firstError: String? = null
            try {
                val isOwner = session.user.isOwner
                try { changesSync.sync(session) } catch (error: Exception) {
                    if (error is CancellationException) throw error
                    firstError = error.message
                }
                repository.refreshCaja(session)?.let { firstError = it }
                if (isOwner) {
                    repository.refreshSummary(session)?.let { firstError = firstError ?: it }
                    repository.refreshDashboard(session)?.let { firstError = firstError ?: it }
                    repository.refreshPurchases(session, Format.businessDate())?.let { firstError = firstError ?: it }
                }
                if (activeSession?.token == session.token) {
                    _state.value = _state.value.copy(
                        error = firstError?.takeIf { _state.value.closes.isEmpty() && _state.value.period == null },
                        loading = false,
                    )
                }
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                if (activeSession?.token == session.token) {
                    _state.value = _state.value.copy(error = error.message ?: "No se pudo actualizar.", loading = false)
                }
            } finally {
                if (activeSession?.token == session.token) {
                    _state.value = _state.value.copy(refreshing = false, loading = false)
                }
            }
        }
    }

    fun refreshRates(session: Session) {
        if (activeSession?.token == session.token) _state.value = _state.value.copy(rates = ratesFor(session))
    }

    fun setDeviceRate(currency: String, rate: Double?) {
        val session = activeSession ?: return
        deviceRates.setDeviceRate(currency, rate)
        _state.value = _state.value.copy(rates = ratesFor(session))
    }

    fun closePeriod(
        session: Session,
        counted: String,
        countedUsd: String,
        countedEur: String,
        openingFloat: String,
        note: String,
    ) {
        if (!startBusy(session)) return
        viewModelScope.launch {
            try {
                val amount = parse(counted) ?: throw IllegalArgumentException("Escribe el efectivo contado")
                require(amount >= 0) { "El efectivo contado no puede ser negativo" }
                val result = repository.closePeriod(
                    session = session,
                    countedCash = amount,
                    countedUsd = parse(countedUsd) ?: 0.0,
                    countedEur = parse(countedEur) ?: 0.0,
                    openingFloat = parse(openingFloat) ?: 0.0,
                    note = note,
                )
                if (activeSession?.token == session.token) {
                    _state.value = _state.value.copy(
                        lastClose = result.close,
                        notice = result.close?.let { "Caja cerrada." } ?: result.error,
                        error = if (result.close == null && !result.pending) result.error else if (result.error != null && result.pending) null else null,
                    )
                }
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                if (activeSession?.token == session.token) {
                    _state.value = _state.value.copy(error = error.message ?: "No se pudo cerrar la caja.")
                }
            } finally {
                finishBusy(session)
            }
        }
    }

    fun withdraw(session: Session, amount: String, note: String) {
        if (!startBusy(session)) return
        viewModelScope.launch {
            try {
                val value = parse(amount) ?: throw IllegalArgumentException("Escribe cuánto sacas")
                require(value > 0) { "La salida debe ser mayor que cero" }
                require(note.trim().length >= 3) { "Escribe el motivo (mínimo 3 caracteres)" }
                val result = repository.withdraw(session, value, note)
                if (activeSession?.token == session.token) {
                    _state.value = _state.value.copy(
                        notice = result.withdrawal?.let { "Salida anotada." } ?: result.error,
                        error = if (result.withdrawal == null && !result.pending) result.error else null,
                    )
                }
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                if (activeSession?.token == session.token) {
                    _state.value = _state.value.copy(error = error.message ?: "No se pudo anotar la salida.")
                }
            } finally {
                finishBusy(session)
            }
        }
    }

    fun voidWithdrawal(session: Session, clientWithdrawalId: String?) {
        if (clientWithdrawalId == null || !startBusy(session)) {
            if (clientWithdrawalId == null) _state.value = _state.value.copy(error = "Esta salida no se puede anular desde aquí.")
            return
        }
        viewModelScope.launch {
            try {
                val message = repository.voidWithdrawal(session, clientWithdrawalId)
                if (activeSession?.token == session.token) {
                    _state.value = _state.value.copy(
                        error = message,
                        notice = if (message == null) "Salida anulada." else null,
                    )
                }
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                if (activeSession?.token == session.token) {
                    _state.value = _state.value.copy(error = error.message ?: "No se pudo anular la salida.")
                }
            } finally {
                finishBusy(session)
            }
        }
    }

    fun buyCurrency(session: Session, currency: String, amount: String, rate: String) {
        if (!startBusy(session)) return
        viewModelScope.launch {
            try {
                // purchaseFields redondea el monto a centavos, igual que la web.
                val fields = Payment.purchaseFields(currency, parse(amount), parse(rate), deviceRates.effective(session.user, currency).shopRate)
                val result = repository.buyCurrency(
                    session = session,
                    currency = currency,
                    amount = fields.foreign_amount,
                    rate = fields.exchange_rate,
                    shopRate = deviceRates.effective(session.user, currency).shopRate,
                )
                if (activeSession?.token == session.token) {
                    _state.value = _state.value.copy(
                        lastPurchase = result,
                        notice = result.purchase?.let { "Compra registrada." } ?: result.error,
                        error = if (result.purchase == null && !result.pending) result.error else null,
                    )
                }
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                if (activeSession?.token == session.token) {
                    _state.value = _state.value.copy(error = error.message ?: "No se pudo registrar la compra.")
                }
            } finally {
                finishBusy(session)
            }
        }
    }

    /** Tasas de la tienda (dueño, en línea). Vacío borra la tasa, como en la web. */
    fun saveShopRates(session: Session, usd: String, eur: String) {
        if (!startBusy(session)) return
        viewModelScope.launch {
            try {
                val usdRate = parseShopRate(usd, "dólar")
                val eurRate = parseShopRate(eur, "euro")
                val user = repository.saveShopRates(session, usdRate, eurRate)
                authRepository.updateShopRates(user.usdRate, user.eurRate)
                if (activeSession?.token == session.token) {
                    val current = authRepository.session.value ?: session
                    _state.value = _state.value.copy(rates = ratesFor(current), notice = "Tasa de la tienda guardada.")
                }
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                if (activeSession?.token == session.token) {
                    _state.value = _state.value.copy(error = error.message ?: "No se pudo guardar la tasa de la tienda.")
                }
            } finally {
                finishBusy(session)
            }
        }
    }

    private fun parseShopRate(raw: String, name: String): Double? {
        if (raw.isBlank()) return null
        val value = parse(raw)
        require(value != null && value > 0) { "La tasa del $name tiene que ser un número mayor que 0" }
        return value
    }

    fun sync(session: Session) {
        if (!startBusy(session)) return
        viewModelScope.launch {
            try {
                repository.sync(session)
                changesSync.sync(session)
                if (activeSession?.token == session.token) _state.value = _state.value.copy(notice = "Sincronización solicitada.")
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                if (activeSession?.token == session.token) {
                    _state.value = _state.value.copy(error = error.message ?: "No se pudo sincronizar.")
                }
            } finally {
                finishBusy(session)
            }
        }
    }

    fun dismiss() {
        _state.value = _state.value.copy(error = null, notice = null, lastClose = null, lastPurchase = null, detail = null)
    }

    fun openDetail(session: Session, id: Long) {
        _state.value = _state.value.copy(detailLoading = true, detail = _state.value.closes.firstOrNull { it.id == id })
        viewModelScope.launch {
            try {
                val close = repository.closeDetail(session, id)
                if (activeSession?.token == session.token) _state.value = _state.value.copy(detail = close, detailLoading = false)
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                if (activeSession?.token == session.token) _state.value = _state.value.copy(detailLoading = false)
            }
        }
    }

    private fun startBusy(session: Session): Boolean {
        if (activeSession?.token != session.token || _state.value.busy) return false
        _state.value = _state.value.copy(busy = true, error = null, notice = null)
        return true
    }

    private fun finishBusy(session: Session) {
        if (activeSession?.token == session.token) _state.value = _state.value.copy(busy = false)
    }

    private fun parse(raw: String): Double? = raw.trim().replace(',', '.').toDoubleOrNull()

    private fun ratesFor(session: Session): Map<String, EffectiveRate> =
        listOf("USD", "EUR").associateWith { deviceRates.effective(session.user, it) }

    private fun <T> collect(key: String, source: suspend () -> kotlinx.coroutines.flow.Flow<T>, sink: (T) -> Unit) {
        jobs += viewModelScope.launch {
            source().collectLatest { value -> if (accountKey == key) sink(value) }
        }
    }

    private fun clear() {
        jobs.forEach(Job::cancel)
        jobs = mutableListOf()
        activeSession = null
        accountKey = null
        _state.value = StoreUiState(loading = false)
    }
}
