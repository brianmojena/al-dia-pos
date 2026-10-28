package cu.mypimes.pos.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cu.mypimes.pos.data.auth.AuthRepository
import cu.mypimes.pos.data.auth.Session
import cu.mypimes.pos.domain.auth.AccountForms
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.launch

@HiltViewModel
class AuthViewModel @Inject constructor(
    private val authRepository: AuthRepository,
) : ViewModel() {
    private val _session = MutableStateFlow<Session?>(null)
    val session = _session.asStateFlow()

    private val _checkingSession = MutableStateFlow(true)
    val checkingSession = _checkingSession.asStateFlow()

    private val _loading = MutableStateFlow(false)
    val loading = _loading.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error = _error.asStateFlow()

    /** Tras crear la tienda: se muestra el cartel de bienvenida con los días de prueba. */
    private val _welcome = MutableStateFlow(false)
    val welcome = _welcome.asStateFlow()

    init {
        viewModelScope.launch {
            authRepository.session
                .catch {
                    _session.value = null
                    _checkingSession.value = false
                }
                .collect { current ->
                    _session.value = current
                    _checkingSession.value = false
                }
        }
        // Como loadMe() en la web: al abrir se pregunta al servidor si la prueba venció (sin red, no pasa nada).
        refreshProfile()
    }

    fun register(storeName: String, email: String, password: String, confirm: String) = accountAction(
        "No se pudo crear la cuenta. Comprueba tu conexión e inténtalo de nuevo.",
        AccountForms.validateRegister(storeName, email, password, confirm),
    ) {
        authRepository.register(storeName, email, password)
        _welcome.value = true
    }

    fun resetPassword(email: String, code: String, password: String, confirm: String, onDone: () -> Unit) = accountAction(
        "No se pudo cambiar la contraseña. Comprueba tu conexión e inténtalo de nuevo.",
        AccountForms.validateReset(email, code, password, confirm),
    ) {
        authRepository.resetPassword(email, code, password)
        onDone()
    }

    fun dismissWelcome() {
        _welcome.value = false
    }

    private fun accountAction(fallback: String, invalid: String?, block: suspend () -> Unit) {
        if (_loading.value) return
        if (invalid != null) {
            _error.value = invalid
            return
        }
        _loading.value = true
        _error.value = null
        viewModelScope.launch {
            try {
                block()
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                _error.value = error.message?.takeIf(String::isNotBlank) ?: fallback
            } finally {
                _loading.value = false
            }
        }
    }

    fun login(email: String, password: String) {
        if (_loading.value) return
        _loading.value = true
        _error.value = null
        viewModelScope.launch {
            try {
                authRepository.login(email.trim(), password)
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                _error.value = error.message?.takeIf(String::isNotBlank)
                    ?: "No se pudo iniciar sesión. Comprueba tu conexión e inténtalo de nuevo."
            } finally {
                _loading.value = false
            }
        }
    }

    fun logout() {
        try {
            authRepository.logout()
            _error.value = null
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            _error.value = error.message?.takeIf(String::isNotBlank)
                ?: "No se pudo cerrar la sesión. Inténtalo de nuevo."
        }
    }

    /** [onDone] corre también si falla la red: la pantalla de bloqueo lo usa para decir «todavía no». */
    fun refreshProfile(onDone: () -> Unit = {}) {
        viewModelScope.launch {
            try {
                authRepository.refreshProfile()
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                // A transient network failure must not sign the cashier out of the UI.
            }
            onDone()
        }
    }

    fun clearError() {
        _error.value = null
    }
}
