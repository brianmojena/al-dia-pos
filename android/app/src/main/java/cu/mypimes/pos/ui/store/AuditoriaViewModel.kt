package cu.mypimes.pos.ui.store

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cu.mypimes.pos.data.auth.Session
import cu.mypimes.pos.data.store.AuditReportDto
import cu.mypimes.pos.data.store.AuditRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class AuditoriaUiState(
    /** null = todos los informes. */
    val severity: String? = null,
    val reports: List<AuditReportDto>? = null,
    val loading: Boolean = false,
    val error: String? = null,
)

@HiltViewModel
class AuditoriaViewModel @Inject constructor(
    private val repository: AuditRepository,
) : ViewModel() {
    private val _state = MutableStateFlow(AuditoriaUiState())
    val state = _state.asStateFlow()
    private var loadJob: Job? = null

    fun load(session: Session, severity: String? = _state.value.severity) {
        loadJob?.cancel()
        _state.update { it.copy(severity = severity, loading = true, error = null) }
        loadJob = viewModelScope.launch {
            try {
                val reports = repository.reports(session, severity)
                _state.update { it.copy(reports = reports, loading = false) }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                _state.update { it.copy(loading = false, error = error.message) }
            }
        }
    }
}
