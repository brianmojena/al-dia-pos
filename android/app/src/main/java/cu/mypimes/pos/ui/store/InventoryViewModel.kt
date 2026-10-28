package cu.mypimes.pos.ui.store

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cu.mypimes.pos.data.auth.Session
import cu.mypimes.pos.data.auth.accountKeyFromToken
import cu.mypimes.pos.data.pos.ProductDto
import cu.mypimes.pos.data.store.CorrectionLineRequest
import cu.mypimes.pos.data.store.CountLineRequest
import cu.mypimes.pos.data.store.DayStockDto
import cu.mypimes.pos.data.store.InventoryCountDto
import cu.mypimes.pos.data.store.InventoryRepository
import cu.mypimes.pos.data.store.ProductRepository
import cu.mypimes.pos.data.store.RejectedCount
import cu.mypimes.pos.data.local.QueuedOperationEntity
import cu.mypimes.pos.domain.inventory.CountEntry
import cu.mypimes.pos.domain.inventory.CountSummary
import cu.mypimes.pos.domain.inventory.CountedLine
import cu.mypimes.pos.domain.inventory.countSummary
import cu.mypimes.pos.domain.inventory.countedQuantity
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

enum class InventoryView { COUNT, RESULT, DETAIL }

data class CountResult(val lines: List<CountedLine>, val summary: CountSummary, val pending: Boolean)

data class InventoryUiState(
    val products: List<ProductDto> = emptyList(),
    val loading: Boolean = true,
    val refreshing: Boolean = false,
    val busy: Boolean = false,
    val error: String? = null,
    val notice: String? = null,
    val view: InventoryView = InventoryView.COUNT,
    /** Lo tecleado por producto. Un producto en blanco significa "no lo conté", no "conté cero". */
    val entries: Map<Long, CountEntry> = emptyMap(),
    val note: String = "",
    val result: CountResult? = null,
    /** Solo el dueño. */
    val history: List<InventoryCountDto> = emptyList(),
    /** Solo el dueño; null si no hay red. */
    val dayStock: DayStockDto? = null,
    /** Cuándo se bajó lo que se ve (historial o stock del día) si el servidor no respondió. */
    val staleSince: Long? = null,
    val detail: InventoryCountDto? = null,
    val detailLoading: Boolean = false,
    val correcting: Boolean = false,
    /** Solo las líneas que el dueño tocó, por id de línea. */
    val correction: Map<Long, CountEntry> = emptyMap(),
    /** Conteos que el servidor rechazó y siguen en la cola, para todas las cuentas. */
    val rejected: List<RejectedCount> = emptyList(),
)

@HiltViewModel
class InventoryViewModel @Inject constructor(
    private val products: ProductRepository,
    private val inventory: InventoryRepository,
) : ViewModel() {
    private val _state = MutableStateFlow(InventoryUiState())
    val state = _state.asStateFlow()

    private var boundToken: String? = null
    private var catalogJob: Job? = null
    private var historyJob: Job? = null
    private var rejectedJob: Job? = null

    fun bind(session: Session) {
        if (boundToken == session.token) return
        boundToken = session.token
        catalogJob?.cancel()
        historyJob?.cancel()
        rejectedJob?.cancel()
        _state.value = InventoryUiState()
        val key = accountKeyFromToken(session.token, session.user.id)
        if (key == null) {
            _state.update { it.copy(loading = false, error = "No se pudo identificar la cuenta de esta sesión.") }
            return
        }
        catalogJob = viewModelScope.launch {
            products.catalog(key).collect { list -> _state.update { it.copy(products = list, loading = false) } }
        }
        rejectedJob = viewModelScope.launch {
            inventory.rejectedCounts(key).collect { list -> _state.update { it.copy(rejected = list) } }
        }
        if (session.user.isOwner) {
            historyJob = viewModelScope.launch {
                inventory.counts(key).collect { list -> _state.update { it.copy(history = list) } }
            }
        }
        refresh(session)
    }

    fun refresh(session: Session) {
        if (_state.value.refreshing) return
        viewModelScope.launch {
            _state.update { it.copy(refreshing = true, error = null) }
            val productError = products.refresh(session)
            val owner = session.user.isOwner
            val historyError = if (owner) inventory.refreshCounts(session) else null
            val day = if (owner) inventory.dayStock(session) else null
            val stale = if (historyError != null || day?.staleSince != null) inventory.historySavedAt(session) else null
            _state.update { it.copy(refreshing = false, loading = false, error = productError ?: historyError, dayStock = day?.data, staleSince = stale) }
        }
    }

    /** Solo marca el conteo como descartado (lo quita de la lista; sus datos se quedan en la cola). */
    fun discardRejected(operation: QueuedOperationEntity) {
        viewModelScope.launch { inventory.discardRejected(operation) }
    }

    fun editCount(productId: Long, entry: CountEntry) = _state.update { it.copy(entries = it.entries + (productId to entry)) }

    fun setNote(note: String) = _state.update { it.copy(note = note) }

    fun submit(session: Session) {
        val current = _state.value
        if (current.busy) return
        val counted = mutableListOf<Pair<ProductDto, Double>>()
        for ((id, entry) in current.entries) {
            if (!entry.filled) continue
            val product = current.products.firstOrNull { it.id == id } ?: continue
            val value = countedQuantity(entry, product.packSize, product.unit)
            if (value == null) {
                _state.update { it.copy(error = "Revisa los números: hay uno vacío o no válido.") }
                return
            }
            counted += product to value
        }
        if (counted.isEmpty()) {
            _state.update { it.copy(error = "Cuenta al menos un producto.") }
            return
        }
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            try {
                val lines = counted.map { (product, value) -> CountLineRequest(product.id, value) }
                val outcome = inventory.submitCount(session, lines, current.note.trim().ifEmpty { null })
                val packSizes = current.products.associate { it.id to it.packSize }
                val units = current.products.associate { it.id to it.unit }
                val sent = outcome.count
                val result = when {
                    sent != null -> resultOf(sent.items.map { item ->
                        CountedLine(item.productId, item.productName, item.expected, item.counted, item.unitPrice,
                            packSizes[item.productId], units[item.productId])
                    }, pending = false)
                    outcome.pending -> resultOf(counted.map { (p, value) ->
                        CountedLine(p.id, p.name, p.stock, value, p.salePrice, p.packSize, p.unit)
                    }, pending = true)
                    else -> null
                }
                if (result != null) {
                    _state.update {
                        it.copy(busy = false, error = null, entries = emptyMap(), note = "", result = result, view = InventoryView.RESULT)
                    }
                } else {
                    _state.update { it.copy(busy = false, error = outcome.error ?: "No se pudo registrar el arqueo.") }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                _state.update { it.copy(busy = false, error = error.message ?: "No se pudo registrar el arqueo.") }
            }
        }
    }

    fun openDetail(session: Session, id: Long) {
        _state.update {
            it.copy(view = InventoryView.DETAIL, detail = null, detailLoading = true, correcting = false, correction = emptyMap(), error = null)
        }
        viewModelScope.launch {
            try {
                val count = inventory.countDetail(session, id)
                _state.update { it.copy(detail = count, detailLoading = false) }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                _state.update {
                    it.copy(view = InventoryView.COUNT, detailLoading = false, error = error.message ?: "No se pudo abrir el arqueo.")
                }
            }
        }
    }

    fun startCorrection() = _state.update { it.copy(correcting = true, correction = emptyMap(), error = null) }

    fun editCorrection(itemId: Long, entry: CountEntry) = _state.update { it.copy(correction = it.correction + (itemId to entry)) }

    fun cancelCorrection() = _state.update { it.copy(correcting = false, correction = emptyMap(), error = null) }

    fun saveCorrection(session: Session) {
        val current = _state.value
        val count = current.detail ?: return
        if (current.busy) return
        val changes = mutableListOf<CorrectionLineRequest>()
        for ((itemId, entry) in current.correction) {
            val item = count.items.firstOrNull { it.id == itemId } ?: continue
            val product = current.products.firstOrNull { it.id == item.productId }
            val value = countedQuantity(entry, product?.packSize, product?.unit)
            if (value == null) {
                _state.update { it.copy(error = "Revisa los números: hay uno vacío o no válido.") }
                return
            }
            if (value != item.counted) changes += CorrectionLineRequest(itemId, value)
        }
        if (changes.isEmpty()) {
            cancelCorrection()
            return
        }
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            try {
                val updated = inventory.correct(session, count.id, changes)
                _state.update {
                    // Sin resultado = quedó en la cola (caja central): el arqueo mostrado no cambia hasta que suba.
                    if (updated == null) it.copy(busy = false, correcting = false, correction = emptyMap(),
                        notice = "Corrección guardada en el aparato. Sin subir: moverá el stock al recuperar la conexión.")
                    else it.copy(busy = false, detail = updated, correcting = false, correction = emptyMap())
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                _state.update { it.copy(busy = false, error = error.message ?: "No se pudo guardar la corrección.") }
            }
        }
    }

    /** Vuelve al conteo: desde el detalle, desde el resultado o al cancelar. */
    fun back() = _state.update {
        it.copy(view = InventoryView.COUNT, result = null, detail = null, correcting = false, correction = emptyMap(), error = null, notice = null)
    }
}

/** Faltantes primero, luego sobrantes y exactos, como en la web. */
private fun resultOf(lines: List<CountedLine>, pending: Boolean) = CountResult(
    lines = lines.sortedBy { line -> if (line.difference < 0) 0 else if (line.difference > 0) 1 else 2 },
    summary = countSummary(lines),
    pending = pending,
)
