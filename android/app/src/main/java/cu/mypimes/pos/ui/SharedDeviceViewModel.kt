package cu.mypimes.pos.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cu.mypimes.pos.data.shared.SharedDeviceRepository
import cu.mypimes.pos.domain.shared.SharedException
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class SharedUiState(val busy: Boolean = false, val error: String? = null)

@HiltViewModel
class SharedDeviceViewModel @Inject constructor(
    private val repository: SharedDeviceRepository,
) : ViewModel() {
    val enrollment = repository.enrollment
    val locked = repository.locked

    private val _state = MutableStateFlow(SharedUiState())
    val state = _state.asStateFlow()

    fun clearError() = _state.update { it.copy(error = null) }

    fun cleanCode(value: String) = repository.cleanCode(value)

    /** Devuelve por `onDone` solo si salió bien; el error queda en el estado. */
    fun activate(code: String, onDone: () -> Unit) = run(onDone) { repository.activate(code) }

    fun unlock(id: Int, pin: String, onDone: () -> Unit = {}) = run(onDone) { repository.unlock(id, pin) }

    fun needsOwnerPin() = repository.needsOwnerPin()

    fun ownerGuardActive() = repository.ownerGuardActive()

    /** Null si el PIN del dueño es correcto; si no, el mensaje para mostrar. */
    suspend fun verifyOwnerPin(pin: String): String? = try {
        repository.verifyOwnerPin(pin); null
    } catch (error: SharedException) { error.message }

    fun lock(hasCart: Boolean) = repository.lock(hasCart)

    fun renew() {
        viewModelScope.launch {
            try { repository.renew() } catch (cancelled: CancellationException) { throw cancelled } catch (_: Exception) { /* sin red: se reintenta luego */ }
        }
    }

    private fun run(onDone: () -> Unit, block: suspend () -> Unit) {
        if (_state.value.busy) return
        _state.update { SharedUiState(busy = true) }
        viewModelScope.launch {
            try {
                block()
                _state.update { SharedUiState() }
                onDone()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                _state.update { SharedUiState(error = error.message ?: "No se pudo completar la acción.") }
            }
        }
    }
}
