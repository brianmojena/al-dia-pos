package cu.mypimes.pos.ui.store

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cu.mypimes.pos.data.auth.Session
import cu.mypimes.pos.data.pos.SaleDto
import cu.mypimes.pos.data.store.CorrectSaleRequest
import cu.mypimes.pos.data.store.DailyActivityDto
import cu.mypimes.pos.data.store.MonthDaysDto
import cu.mypimes.pos.data.store.SaleCorrectionDto
import cu.mypimes.pos.data.store.SalesRepository
import cu.mypimes.pos.domain.Format
import android.content.ContentResolver
import android.net.Uri
import java.io.IOException
import cu.mypimes.pos.domain.Payment
import cu.mypimes.pos.domain.sales.DaySales
import cu.mypimes.pos.domain.sales.SaleCorrections
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class SalesUiState(
    /** null = hoy (el servidor decide el día del negocio). */
    val date: String? = null,
    val day: DailyActivityDto? = null,
    val voided: List<SaleCorrectionDto> = emptyList(),
    val cashier: DaySales.CashierRow? = null,
    val loading: Boolean = true,
    val error: String? = null,
    val notice: String? = null,
    val selected: SaleDto? = null,
    val history: List<SaleCorrectionDto> = emptyList(),
    val busy: Boolean = false,
    val formError: String? = null,
    /** Vista por mes (web: Historial por mes): resumen de los días y Excel del servidor. */
    val monthMode: Boolean = false,
    val month: String = Format.businessDate().take(7),
    val monthData: MonthDaysDto? = null,
    val exporting: Boolean = false,
    /** Cuándo se bajó lo que se ve, si sale del aparato por falta de red. */
    val staleSince: Long? = null,
)

@HiltViewModel
class SalesViewModel @Inject constructor(
    private val repository: SalesRepository,
) : ViewModel() {
    private val _state = MutableStateFlow(SalesUiState())
    val state = _state.asStateFlow()
    private var loadJob: Job? = null
    private var monthJob: Job? = null

    fun load(session: Session, date: String? = _state.value.date) {
        loadJob?.cancel()
        monthJob?.cancel()
        _state.update { it.copy(date = date, loading = true, error = null, monthMode = false, cashier = if (date != it.date) null else it.cashier) }
        loadJob = viewModelScope.launch {
            try {
                val served = repository.day(session, date ?: Format.businessDate())
                val day = served.data
                // Las anuladas son un extra: si fallan (p. ej. sin red), la lista del día igual se muestra.
                val voided = if (served.staleSince != null) emptyList()
                else runCatching { repository.voidedOfDay(session, day.date) }.getOrDefault(emptyList())
                _state.update { it.copy(day = day, voided = voided, loading = false, date = day.date, staleSince = served.staleSince) }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                _state.update { it.copy(loading = false, error = error.message) }
            }
        }
    }

    fun showMonth(session: Session, month: String = _state.value.month) {
        loadJob?.cancel()
        monthJob?.cancel()
        _state.update { it.copy(monthMode = true, month = month, loading = true, error = null) }
        monthJob = viewModelScope.launch {
            try {
                val served = repository.month(session, month)
                val data = served.data
                _state.update { it.copy(monthData = data, month = data.month.ifBlank { month }, loading = false, staleSince = served.staleSince) }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                _state.update { it.copy(loading = false, error = error.message) }
            }
        }
    }

    /** Guarda el Excel del servidor del mes en el archivo que elige el usuario (selector del sistema). */
    fun saveExcel(session: Session, uri: Uri, resolver: ContentResolver) {
        if (_state.value.exporting) return
        _state.update { it.copy(exporting = true, error = null) }
        viewModelScope.launch {
            try {
                val bytes = repository.monthExcel(session, _state.value.month)
                withContext(Dispatchers.IO) {
                    val out = resolver.openOutputStream(uri) ?: throw IOException("No se pudo guardar el archivo.")
                    out.use { it.write(bytes) }
                }
                _state.update { it.copy(exporting = false, notice = "Excel guardado.") }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                _state.update { it.copy(exporting = false, error = error.message) }
            }
        }
    }

    fun filterBy(row: DaySales.CashierRow?) = _state.update { it.copy(cashier = row) }
    fun dismissNotice() = _state.update { it.copy(notice = null) }

    fun select(session: Session, sale: SaleDto?) {
        _state.update { it.copy(selected = sale, history = emptyList(), formError = null) }
        val id = sale?.id ?: return
        viewModelScope.launch {
            val rows = runCatching { repository.history(session, id) }.getOrNull() ?: return@launch
            _state.update { if (it.selected?.id == id) it.copy(history = rows) else it }
        }
    }

    fun correct(session: Session, sale: SaleDto, request: CorrectSaleRequest) {
        val id = sale.id ?: return
        if (_state.value.busy) return
        _state.update { it.copy(busy = true, formError = null) }
        viewModelScope.launch {
            try {
                val result = repository.correct(session, id, request)
                if (result.queued) {
                    _state.update { it.copy(busy = false, selected = null, notice = "Corrección guardada en el aparato. Sin subir: se aplicará en el servidor al recuperar la conexión.") }
                    return@launch
                }
                val correction = result.correction
                val what = if (request.action == "anular") "Venta anulada." else
                    "Cobro cambiado a ${Payment.paymentLabel(request.paymentMethod, request.foreignCurrency)}."
                val close = if (correction?.closeBefore != null && correction.closeAfter != null) {
                    " Cierre de caja: ${SaleCorrections.closeResult(correction.closeBefore.difference) { Format.money(it) }}" +
                        " → ${SaleCorrections.closeResult(correction.closeAfter.difference) { Format.money(it) }}."
                } else ""
                _state.update { it.copy(busy = false, selected = null, notice = what + close) }
                load(session)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                _state.update { it.copy(busy = false, formError = error.message) }
            }
        }
    }
}
