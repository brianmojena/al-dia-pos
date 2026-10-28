package cu.mypimes.pos.ui.store

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cu.mypimes.pos.data.auth.Session
import cu.mypimes.pos.data.auth.accountKeyFromToken
import cu.mypimes.pos.data.pos.ProductDto
import cu.mypimes.pos.data.store.ProductRepository
import cu.mypimes.pos.domain.products.ProductDraft
import dagger.hilt.android.lifecycle.HiltViewModel
import java.util.UUID
import javax.inject.Inject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class ProductsUiState(
    val products: List<ProductDto> = emptyList(),
    val loading: Boolean = true,
    val refreshing: Boolean = false,
    val busy: Boolean = false,
    val error: String? = null,
    val notice: String? = null,
    val formOpen: Boolean = false,
    val editing: ProductDto? = null,
    val formError: String? = null,
)

@HiltViewModel
class ProductsViewModel @Inject constructor(
    private val repository: ProductRepository,
) : ViewModel() {
    private val _state = MutableStateFlow(ProductsUiState())
    val state = _state.asStateFlow()

    private var boundToken: String? = null
    private var listJob: Job? = null
    // Un id por formulario de edición: reintentar tras un fallo de red no duplica el stock añadido.
    private var operationId = UUID.randomUUID().toString()

    fun bind(session: Session) {
        if (boundToken == session.token) return
        boundToken = session.token
        listJob?.cancel()
        _state.value = ProductsUiState()
        val key = accountKeyFromToken(session.token, session.user.id)
        if (key == null) {
            _state.update { it.copy(loading = false, error = "No se pudo identificar la cuenta de esta sesión.") }
            return
        }
        listJob = viewModelScope.launch {
            repository.catalog(key).collect { list -> _state.update { it.copy(products = list, loading = false) } }
        }
        refresh(session)
    }

    fun refresh(session: Session) {
        if (_state.value.refreshing) return
        viewModelScope.launch { load(session) }
    }

    private suspend fun load(session: Session) {
        _state.update { it.copy(refreshing = true, error = null) }
        val error = repository.refresh(session)
        _state.update { it.copy(refreshing = false, loading = false, error = error) }
    }

    fun openNew() = _state.update { it.copy(formOpen = true, editing = null, formError = null) }

    fun openEdit(product: ProductDto) {
        operationId = UUID.randomUUID().toString()
        _state.update { it.copy(formOpen = true, editing = product, formError = null) }
    }

    fun closeForm() = _state.update { it.copy(formOpen = false, editing = null, formError = null) }

    fun dismissNotice() = _state.update { it.copy(notice = null) }

    fun save(session: Session, draft: ProductDraft) {
        val current = _state.value
        if (current.busy) return
        val owner = session.user.isOwner
        draft.validationError(editing = current.editing != null, owner = owner)?.let { error ->
            _state.update { it.copy(formError = error) }
            return
        }
        _state.update { it.copy(busy = true, formError = null, notice = null) }
        viewModelScope.launch {
            try {
                val saved = repository.save(session, current.editing, draft, owner, operationId)
                operationId = UUID.randomUUID().toString()
                val notice = if (saved.merged) {
                    "«${saved.name}» ya existía, así que no se creó otro. Se mantienen su precio y su stock."
                } else null
                _state.update { it.copy(busy = false, formOpen = false, editing = null, notice = notice) }
                load(session)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                _state.update { it.copy(busy = false, formError = error.message ?: "No se pudo guardar el producto") }
            }
        }
    }

    fun delete(session: Session) {
        val product = _state.value.editing ?: return
        if (_state.value.busy) return
        _state.update { it.copy(busy = true, formError = null) }
        viewModelScope.launch {
            try {
                repository.delete(session, product.id)
                _state.update { it.copy(busy = false, formOpen = false, editing = null, notice = "«${product.name}» se eliminó.") }
                load(session)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                _state.update { it.copy(busy = false, formError = error.message ?: "No se pudo eliminar el producto") }
            }
        }
    }
}
