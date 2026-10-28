package cu.mypimes.pos.ui.store

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cu.mypimes.pos.data.auth.Session
import cu.mypimes.pos.data.auth.accountKeyFromToken
import cu.mypimes.pos.data.pos.ProductDto
import cu.mypimes.pos.data.store.FromStoreTransferRequest
import cu.mypimes.pos.data.store.ProductRepository
import cu.mypimes.pos.data.store.ToStoreTransferRequest
import cu.mypimes.pos.data.store.WarehouseChangeDto
import cu.mypimes.pos.data.store.WarehouseItemDto
import cu.mypimes.pos.data.store.WarehouseRepository
import cu.mypimes.pos.data.store.WarehousePassDto
import cu.mypimes.pos.domain.products.number
import cu.mypimes.pos.domain.products.stockLabel
import cu.mypimes.pos.domain.warehouse.salePriceError
import cu.mypimes.pos.domain.warehouse.transferQuantityError
import cu.mypimes.pos.domain.warehouse.warehouseItemError
import cu.mypimes.pos.domain.warehouse.warehouseKey
import dagger.hilt.android.lifecycle.HiltViewModel
import java.io.IOException
import java.util.UUID
import javax.inject.Inject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

enum class WarehouseView { LIST, ITEM, TO_STORE, FROM_STORE, HISTORY }

/** Alta si `editing` es null. En la edición, `quantity` es lo que llegó (reposición, opcional). */
data class ItemForm(
    val editing: WarehouseItemDto? = null,
    val name: String = "",
    val cost: String = "",
    val unit: String? = null,
    val quantity: String = "",
)

/** `clientId` se crea al abrir el pase: reintentar con el mismo id no lo duplica en el servidor. */
data class ToStoreForm(
    val item: WarehouseItemDto,
    val needsSalePrice: Boolean,
    val quantity: String = "",
    val salePrice: String = "",
    val clientId: String = UUID.randomUUID().toString(),
)

data class FromStoreForm(
    val product: ProductDto? = null,
    val quantity: String = "",
    val clientId: String = UUID.randomUUID().toString(),
)

data class WarehouseUiState(
    val items: List<WarehouseItemDto> = emptyList(),
    val products: List<ProductDto> = emptyList(),
    val loading: Boolean = true,
    val refreshing: Boolean = false,
    val busy: Boolean = false,
    /** Error de la pantalla o del formulario abierto. */
    val error: String? = null,
    val notice: String? = null,
    val view: WarehouseView = WarehouseView.LIST,
    val toStore: ToStoreForm? = null,
    val fromStore: FromStoreForm? = null,
    val item: ItemForm? = null,
    /** Solo el dueño. */
    val history: List<WarehousePassDto> = emptyList(),
    val changes: List<WarehouseChangeDto> = emptyList(),
    val historyLoading: Boolean = false,
    /** Cuándo se bajó lo que se ve, si sale del aparato por falta de red. */
    val staleSince: Long? = null,
)

@HiltViewModel
class WarehouseViewModel @Inject constructor(
    private val warehouse: WarehouseRepository,
    private val products: ProductRepository,
) : ViewModel() {
    private val _state = MutableStateFlow(WarehouseUiState())
    val state = _state.asStateFlow()

    private var boundToken: String? = null
    private var catalogJob: Job? = null

    fun bind(session: Session) {
        if (boundToken == session.token) return
        boundToken = session.token
        catalogJob?.cancel()
        _state.value = WarehouseUiState()
        val key = accountKeyFromToken(session.token, session.user.id)
        if (key == null) {
            _state.update { it.copy(loading = false, error = "No se pudo identificar la cuenta de esta sesión.") }
            return
        }
        catalogJob = viewModelScope.launch {
            products.catalog(key).collect { list -> _state.update { it.copy(products = list) } }
        }
        refresh(session)
    }

    /** Actualiza el almacén y el catálogo de la tienda (el POS debe ver el stock movido). */
    fun refresh(session: Session) {
        if (_state.value.refreshing) return
        viewModelScope.launch {
            _state.update { it.copy(refreshing = true) }
            val productError = products.refresh(session)
            try {
                val served = warehouse.items(session)
                _state.update { it.copy(items = served.data, staleSince = served.staleSince, refreshing = false, loading = false, error = productError) }
            } catch (error: IOException) {
                _state.update { it.copy(refreshing = false, loading = false, error = productError ?: error.message) }
            }
        }
    }

    fun openToStore(item: WarehouseItemDto) = _state.update {
        val inStore = it.products.any { p -> warehouseKey(p.name) == warehouseKey(item.name) }
        it.copy(view = WarehouseView.TO_STORE, toStore = ToStoreForm(item, needsSalePrice = !inStore), error = null, notice = null)
    }

    fun openFromStore() = _state.update {
        it.copy(view = WarehouseView.FROM_STORE, fromStore = FromStoreForm(), error = null, notice = null)
    }

    fun openNewItem() = _state.update {
        it.copy(view = WarehouseView.ITEM, item = ItemForm(), error = null, notice = null)
    }

    fun openEditItem(item: WarehouseItemDto) = _state.update {
        val cost = item.cost.toString().removeSuffix(".0")
        it.copy(view = WarehouseView.ITEM, item = ItemForm(item, item.name, cost, item.unit), error = null, notice = null)
    }

    fun setItem(form: ItemForm) = _state.update { it.copy(item = form) }

    fun saveItem(session: Session) {
        val current = _state.value
        val form = current.item ?: return
        if (current.busy) return
        val error = warehouseItemError(
            name = form.name,
            cost = form.cost,
            unit = form.unit,
            quantity = form.quantity,
            editingQuantity = form.editing?.quantity,
            takenNames = current.items.filter { it.id != form.editing?.id }.map { it.name },
        )
        if (error != null) {
            _state.update { it.copy(error = error) }
            return
        }
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            try {
                val saved = warehouse.saveItem(
                    session = session,
                    editing = form.editing,
                    name = form.name,
                    cost = number(form.cost.ifBlank { "0" }) ?: 0.0,
                    unit = form.unit,
                    quantity = number(form.quantity),
                )
                _state.update {
                    it.copy(busy = false, view = WarehouseView.LIST, item = null, notice = if (form.editing == null) "«${saved.name}» se añadió al almacén." else "«${saved.name}» se guardó.")
                }
                refresh(session)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                _state.update { it.copy(busy = false, error = error.message ?: "No se pudo guardar el artículo.") }
            }
        }
    }

    fun deleteItem(session: Session) {
        val item = _state.value.item?.editing ?: return
        if (_state.value.busy) return
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            try {
                warehouse.deleteItem(session, item.id)
                _state.update { it.copy(busy = false, view = WarehouseView.LIST, item = null, notice = "«${item.name}» se eliminó del almacén.") }
                refresh(session)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                _state.update { it.copy(busy = false, error = error.message ?: "No se pudo eliminar el artículo.") }
            }
        }
    }

    fun openHistory(session: Session) {
        _state.update { it.copy(view = WarehouseView.HISTORY, history = emptyList(), changes = emptyList(), historyLoading = true, error = null, notice = null) }
        viewModelScope.launch {
            try {
                val served = warehouse.transfers(session)
                // El registro de cambios no se guarda en el aparato: sin red queda vacío y el aviso lo dice.
                val changes = if (served.staleSince != null) emptyList() else warehouse.changes(session)
                _state.update { it.copy(history = served.data, changes = changes, historyLoading = false, staleSince = served.staleSince) }
            } catch (error: IOException) {
                _state.update { it.copy(error = error.message, historyLoading = false) }
            }
        }
    }

    fun setToStore(form: ToStoreForm) = _state.update { it.copy(toStore = form) }

    fun setFromStore(form: FromStoreForm) = _state.update { it.copy(fromStore = form) }

    /** Vuelve a la lista desde cualquier formulario o historial. */
    fun back() = _state.update {
        it.copy(view = WarehouseView.LIST, toStore = null, fromStore = null, item = null, error = null)
    }

    fun submitToStore(session: Session) {
        val current = _state.value
        val form = current.toStore ?: return
        if (current.busy) return
        val quantity = number(form.quantity)
        val error = transferQuantityError(form.quantity, form.item.unit, form.item.quantity)
            ?: salePriceError(form.salePrice, form.needsSalePrice)
        if (quantity == null || error != null) {
            _state.update { it.copy(error = error ?: "Escribe una cantidad.") }
            return
        }
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            try {
                val request = ToStoreTransferRequest(
                    warehouseItemId = form.item.id,
                    quantity = quantity,
                    clientTransferId = form.clientId,
                    salePrice = if (form.needsSalePrice) number(form.salePrice) else null,
                )
                val done = warehouse.toStore(session, request)
                _state.update {
                    it.copy(busy = false, view = WarehouseView.LIST, toStore = null, notice = "${moved(done.quantity, form.item.unit)} de «${form.item.name}» pasaron a la tienda.")
                }
                refresh(session)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                _state.update { it.copy(busy = false, error = error.message ?: "No se pudo transferir.") }
            }
        }
    }

    fun submitFromStore(session: Session) {
        val current = _state.value
        val form = current.fromStore ?: return
        val product = form.product ?: return
        if (current.busy) return
        val quantity = number(form.quantity)
        val error = transferQuantityError(form.quantity, product.unit, product.stock)
        if (quantity == null || error != null) {
            _state.update { it.copy(error = error ?: "Escribe una cantidad.") }
            return
        }
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            try {
                val done = warehouse.fromStore(session, FromStoreTransferRequest(product.id, quantity, form.clientId))
                _state.update {
                    it.copy(busy = false, view = WarehouseView.LIST, fromStore = null, notice = "${moved(done.quantity, product.unit)} de «${product.name}» pasaron al almacén.")
                }
                refresh(session)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                _state.update { it.copy(busy = false, error = error.message ?: "No se pudo pasar al almacén.") }
            }
        }
    }

    private fun moved(quantity: Double, unit: String?): String =
        stockLabel(quantity, unit, true, null)
}
