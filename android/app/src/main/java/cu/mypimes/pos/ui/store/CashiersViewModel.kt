package cu.mypimes.pos.ui.store

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cu.mypimes.pos.data.auth.Session
import cu.mypimes.pos.data.store.CashierDto
import cu.mypimes.pos.data.store.CashiersRepository
import cu.mypimes.pos.domain.cashiers.cashierFormError
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class CashiersUiState(
    val cashiers: List<CashierDto> = emptyList(),
    val loading: Boolean = true,
    val busy: Boolean = false,
    val error: String? = null,
    val formOpen: Boolean = false,
    val formError: String? = null,
)

@HiltViewModel
class CashiersViewModel @Inject constructor(
    private val repository: CashiersRepository,
) : ViewModel() {
    private val _state = MutableStateFlow(CashiersUiState())
    val state = _state.asStateFlow()

    fun refresh(session: Session) {
        viewModelScope.launch {
            try {
                val list = repository.list(session)
                _state.update { it.copy(cashiers = list, loading = false, error = null) }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                _state.update { it.copy(loading = false, error = error.message) }
            }
        }
    }

    fun openForm() = _state.update { it.copy(formOpen = true, formError = null) }
    fun closeForm() = _state.update { it.copy(formOpen = false, formError = null) }

    fun create(session: Session, email: String, password: String) {
        if (_state.value.busy) return
        cashierFormError(email, password)?.let { message -> _state.update { it.copy(formError = message) }; return }
        _state.update { it.copy(busy = true, formError = null) }
        viewModelScope.launch {
            try {
                repository.create(session, email, password)
                _state.update { it.copy(busy = false, formOpen = false) }
                refresh(session)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                _state.update { it.copy(busy = false, formError = error.message) }
            }
        }
    }

    fun remove(session: Session, id: Int) {
        if (_state.value.busy) return
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            try {
                repository.remove(session, id)
                _state.update { it.copy(busy = false) }
                refresh(session)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                _state.update { it.copy(busy = false, error = error.message) }
            }
        }
    }
}
