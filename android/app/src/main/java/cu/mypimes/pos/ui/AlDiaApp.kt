package cu.mypimes.pos.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cu.mypimes.pos.R
import androidx.compose.runtime.key
import androidx.compose.material3.AlertDialog

@Composable
fun AlDiaApp(viewModel: AuthViewModel) {
    val session by viewModel.session.collectAsStateWithLifecycle()
    val checking by viewModel.checkingSession.collectAsStateWithLifecycle()
    val loading by viewModel.loading.collectAsStateWithLifecycle()
    val error by viewModel.error.collectAsStateWithLifecycle()
    val sharedVm: SharedDeviceViewModel = androidx.hilt.navigation.compose.hiltViewModel()
    val shared by sharedVm.enrollment.collectAsStateWithLifecycle()
    val sharedLocked by sharedVm.locked.collectAsStateWithLifecycle()
    val welcome by viewModel.welcome.collectAsStateWithLifecycle()
    var activating by rememberSaveable { mutableStateOf(false) }
    var authPage by rememberSaveable { mutableStateOf(AuthPage.LOGIN) }
    // Sesión de un miembro de esta caja (token con el deviceId instalado). El dueño solo entra así en caja central.
    val sharedSession = shared != null && session?.let {
        cu.mypimes.pos.domain.shared.SharedLogic.claims(it.token)?.deviceId == shared!!.device.id
    } == true
    // Renovación en lote al abrir y cada 6 h con red (también con la pantalla de PIN puesta).
    androidx.compose.runtime.LaunchedEffect(shared?.device?.id) {
        while (shared != null) {
            sharedVm.renew()
            kotlinx.coroutines.delay(6 * 60 * 60 * 1000L)
        }
    }

    when {
        checking -> LoadingScreen()
        activating -> ActivateDeviceScreen(sharedVm, onDone = { activating = false }, onBack = { activating = false })
        shared != null && (session == null || (sharedSession && sharedLocked)) ->
            SharedCashierScreen(shared!!, sharedVm, onActivateAnother = { activating = true })
        session != null && welcome -> WelcomeScreen(session!!.user, onStart = viewModel::dismissWelcome)
        session != null && session!!.user.locked -> LockedScreen(
            user = session!!.user,
            onRefresh = viewModel::refreshProfile,
            onLogout = viewModel::logout,
        )
        session != null -> key(session!!.token) {
            cu.mypimes.pos.ui.components.OwnerPinGuard(sharedVm::needsOwnerPin, sharedVm::verifyOwnerPin) {
                MainShell(
                    session = session!!,
                    onLogout = viewModel::logout,
                    onRefreshProfile = viewModel::refreshProfile,
                    onLock = if (sharedSession) sharedVm::lock else null,
                )
            }
            if (error != null) {
                AlertDialog(
                    onDismissRequest = viewModel::clearError,
                    title = { Text("No se pudo completar la acción") },
                    text = { Text(error!!) },
                    confirmButton = { TextButton(onClick = viewModel::clearError) { Text("Entendido") } },
                )
            }
        }
        else -> when (authPage) {
            AuthPage.LOGIN -> LoginScreen(
                loading = loading,
                error = error,
                onLogin = viewModel::login,
                onErrorDismiss = viewModel::clearError,
                onActivate = { activating = true },
                onRegister = { viewModel.clearError(); authPage = AuthPage.REGISTER },
                onRecover = { viewModel.clearError(); authPage = AuthPage.RECOVER },
            )
            AuthPage.REGISTER -> RegisterScreen(
                loading = loading,
                error = error,
                onSubmit = viewModel::register,
                onBack = { viewModel.clearError(); authPage = AuthPage.LOGIN },
                onErrorDismiss = viewModel::clearError,
            )
            AuthPage.RECOVER -> RecoverScreen(
                loading = loading,
                error = error,
                onSubmit = viewModel::resetPassword,
                onBack = { viewModel.clearError(); authPage = AuthPage.LOGIN },
                onErrorDismiss = viewModel::clearError,
            )
        }
    }
}

private enum class AuthPage { LOGIN, REGISTER, RECOVER }

@Composable
private fun LoadingScreen() {
    Box(
        modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background),
        contentAlignment = Alignment.Center,
    ) {
        CircularProgressIndicator()
    }
}

@Composable
internal fun LoginScreen(
    loading: Boolean,
    error: String?,
    onLogin: (String, String) -> Unit,
    onErrorDismiss: () -> Unit,
    onActivate: () -> Unit = {},
    onRegister: () -> Unit = {},
    onRecover: () -> Unit = {},
) {
    var email by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var passwordVisible by rememberSaveable { mutableStateOf(false) }
    val canSubmit = email.isNotBlank() && password.isNotBlank() && !loading

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .imePadding(),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Image(
                painter = painterResource(R.drawable.al_dia_icon),
                contentDescription = "Al Día",
                modifier = Modifier.size(80.dp).clip(RoundedCornerShape(22.dp)),
            )
            Spacer(Modifier.height(18.dp))
            Text("Al Día", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(5.dp))
            Text("Tu negocio, al día", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(28.dp))

            Card(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(24.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
            ) {
                Column(Modifier.fillMaxWidth().padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("Iniciar sesión", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                        Text("Entra a la cuenta de tu negocio", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    OutlinedTextField(
                        value = email,
                        onValueChange = { email = it; if (error != null) onErrorDismiss() },
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("Correo electrónico") },
                        singleLine = true,
                        enabled = !loading,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next),
                    )
                    OutlinedTextField(
                        value = password,
                        onValueChange = { password = it; if (error != null) onErrorDismiss() },
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("Contraseña") },
                        singleLine = true,
                        enabled = !loading,
                        visualTransformation = if (passwordVisible) VisualTransformation.None else PasswordVisualTransformation(),
                        trailingIcon = {
                            TextButton(onClick = { passwordVisible = !passwordVisible }, enabled = !loading) {
                                Text(if (passwordVisible) "Ocultar" else "Ver")
                            }
                        },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                    )
                    if (error != null) {
                        Text(
                            error,
                            color = MaterialTheme.colorScheme.error,
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    Button(
                        onClick = { onLogin(email, password) },
                        enabled = canSubmit,
                        modifier = Modifier.fillMaxWidth().height(52.dp),
                        shape = RoundedCornerShape(14.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.primary),
                    ) {
                        if (loading) {
                            CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                            Spacer(Modifier.width(10.dp))
                            Text("Conectando…")
                        } else {
                            Text("Entrar", fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
            }
            TextButton(onClick = onRecover, enabled = !loading) { Text("¿Olvidaste tu contraseña?") }
            TextButton(onClick = onActivate, enabled = !loading) { Text("Activar esta caja con un código") }
            TextButton(onClick = onRegister, enabled = !loading) { Text("¿No tienes cuenta? Regístrate") }
            Spacer(Modifier.height(14.dp))
            Text("Acceso seguro para dueños y cajeros", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

