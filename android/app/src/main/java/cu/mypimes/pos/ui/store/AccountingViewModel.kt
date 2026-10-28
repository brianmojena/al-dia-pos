package cu.mypimes.pos.ui.store

import android.content.ContentResolver
import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cu.mypimes.pos.data.auth.Session
import cu.mypimes.pos.data.store.AccountingRepository
import cu.mypimes.pos.data.store.AccountingSummaryDto
import cu.mypimes.pos.data.store.CreateExpenseRequest
import cu.mypimes.pos.data.store.ExpenseDto
import cu.mypimes.pos.domain.Format
import cu.mypimes.pos.domain.accounting.Accounting
import dagger.hilt.android.lifecycle.HiltViewModel
import java.io.IOException
import java.time.YearMonth
import java.util.UUID
import javax.inject.Inject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class AccountingUiState(
    /** 'YYYY-MM' del negocio; empieza en el mes en curso. */
    val month: String = Format.businessDate().take(7),
    val summary: AccountingSummaryDto? = null,
    val expenses: List<ExpenseDto> = emptyList(),
    val loading: Boolean = true,
    val error: String? = null,
    val notice: String? = null,
    val busy: Boolean = false,
    val formOpen: Boolean = false,
    val formError: String? = null,
    /** Id de cliente del gasto en curso: se reutiliza en reintentos para que el servidor no lo duplique. */
    val formId: String? = null,
    /** Gasto pendiente de confirmar la anulación. */
    val toVoid: ExpenseDto? = null,
)

@HiltViewModel
class AccountingViewModel @Inject constructor(
    private val repository: AccountingRepository,
) : ViewModel() {
    private val _state = MutableStateFlow(AccountingUiState())
    val state = _state.asStateFlow()
    private var loadJob: Job? = null

    fun load(session: Session, month: String = _state.value.month) {
        loadJob?.cancel()
        _state.update { it.copy(month = month, loading = true, error = null) }
        loadJob = viewModelScope.launch {
            try {
                val summary = repository.summary(session, month)
                val expenses = repository.expenses(session, month)
                _state.update { it.copy(summary = summary, expenses = expenses, loading = false) }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                _state.update { it.copy(loading = false, error = error.message) }
            }
        }
    }

    fun shift(session: Session, delta: Int) {
        val target = Accounting.shiftMonth(_state.value.month, delta)
        if (delta > 0 && !Accounting.canGoNext(_state.value.month, YearMonth.now(Format.cubaZone))) return
        load(session, target)
    }

    fun canGoNext(): Boolean = Accounting.canGoNext(_state.value.month, YearMonth.now(Format.cubaZone))

    fun openForm() = _state.update { it.copy(formOpen = true, formError = null, formId = UUID.randomUUID().toString()) }
    fun closeForm() = _state.update { it.copy(formOpen = false, formError = null, formId = null) }
    fun dismissNotice() = _state.update { it.copy(notice = null) }
    fun askVoid(expense: ExpenseDto?) = _state.update { it.copy(toVoid = expense) }

    fun addExpense(session: Session, method: String, amount: String, concept: String) {
        if (_state.value.busy) return
        Accounting.expenseError(amount, concept)?.let { message -> _state.update { it.copy(formError = message) }; return }
        val value = Accounting.parseAmount(amount) ?: return
        val id = _state.value.formId ?: UUID.randomUUID().toString()
        _state.update { it.copy(busy = true, formError = null) }
        viewModelScope.launch {
            try {
                repository.addExpense(session, CreateExpenseRequest(id, method, value, concept.trim()))
                _state.update { it.copy(busy = false, formOpen = false, formId = null, notice = "Gasto anotado.") }
                load(session)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                _state.update { it.copy(busy = false, formError = error.message) }
            }
        }
    }

    fun voidExpense(session: Session, expense: ExpenseDto) {
        if (_state.value.busy) return
        _state.update { it.copy(busy = true, toVoid = null, error = null) }
        viewModelScope.launch {
            try {
                repository.voidExpense(session, expense.clientExpenseId)
                _state.update { it.copy(busy = false, notice = "Gasto anulado.") }
                load(session)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                _state.update { it.copy(busy = false, error = error.message) }
            }
        }
    }

    /** Guarda el Excel del servidor en el archivo que eligió el usuario con el selector del sistema. */
    fun saveExcel(session: Session, uri: Uri, resolver: ContentResolver) {
        if (_state.value.busy) return
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            try {
                val bytes = repository.exportMonth(session, _state.value.month)
                withContext(Dispatchers.IO) {
                    val out = resolver.openOutputStream(uri) ?: throw IOException("No se pudo guardar el archivo.")
                    out.use { it.write(bytes) }
                }
                _state.update { it.copy(busy = false, notice = "Excel guardado.") }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                _state.update { it.copy(busy = false, error = error.message) }
            }
        }
    }
}
