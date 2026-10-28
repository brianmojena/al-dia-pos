package cu.mypimes.pos.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import cu.mypimes.pos.R
import cu.mypimes.pos.data.auth.ApiUser
import cu.mypimes.pos.domain.auth.AccountForms
import cu.mypimes.pos.domain.auth.Plans
import cu.mypimes.pos.ui.components.AlDiaCard
import cu.mypimes.pos.ui.components.ErrorBanner
import cu.mypimes.pos.ui.components.InfoBanner
import cu.mypimes.pos.ui.components.Pill
import cu.mypimes.pos.ui.components.PrimaryButton
import cu.mypimes.pos.ui.theme.AlDiaColors

/** Pantallas de cuenta (registro, recuperación, bienvenida y bloqueo por prueba vencida), como en la web. */

@Composable
internal fun RegisterScreen(
    loading: Boolean,
    error: String?,
    onSubmit: (storeName: String, email: String, password: String, confirm: String) -> Unit,
    onBack: () -> Unit,
    onErrorDismiss: () -> Unit,
) {
    var storeName by rememberSaveable { mutableStateOf("") }
    var email by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var passwordVisible by rememberSaveable { mutableStateOf(false) }
    // Los planes no se muestran aquí (como la web): la tienda nace con prueba y el plan por defecto.
    AccountPage(title = "Crea tu cuenta", subtitle = "Empieza a gestionar tu negocio") {
        InfoBanner(
            "7 días gratis con todas las funciones. Al terminar la prueba te mostraremos los planes; " +
                "el pago es en persona y solo si decides quedarte.",
            tone = AlDiaColors.Success,
        )
        OutlinedTextField(
            value = storeName,
            onValueChange = { storeName = it; if (error != null) onErrorDismiss() },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Nombre de tu tienda") },
            singleLine = true,
            enabled = !loading,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
        )
        OutlinedTextField(
            value = email,
            onValueChange = { email = it; if (error != null) onErrorDismiss() },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Correo electrónico") },
            singleLine = true,
            enabled = !loading,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next),
        )
        PasswordField(
            value = password,
            onValueChange = { password = it; if (error != null) onErrorDismiss() },
            label = "Contraseña (mínimo 6 caracteres)",
            enabled = !loading,
            visible = passwordVisible,
            onToggle = { passwordVisible = !passwordVisible },
            imeAction = ImeAction.Next,
        )
        PasswordField(
            value = confirm,
            onValueChange = { confirm = it; if (error != null) onErrorDismiss() },
            label = "Confirmar contraseña",
            enabled = !loading,
            visible = passwordVisible,
            onToggle = { passwordVisible = !passwordVisible },
            imeAction = ImeAction.Done,
        )
        if (error != null) ErrorBanner(error)
        PrimaryButton(
            text = if (loading) "Creando cuenta…" else "Crear cuenta",
            onClick = { onSubmit(storeName, email, password, confirm) },
            enabled = !loading,
            loading = loading,
        )
        TextButton(onClick = onBack, enabled = !loading) { Text("¿Ya tienes cuenta? Inicia sesión") }
    }
}

@Composable
internal fun RecoverScreen(
    loading: Boolean,
    error: String?,
    onSubmit: (email: String, code: String, password: String, confirm: String, onDone: () -> Unit) -> Unit,
    onBack: () -> Unit,
    onErrorDismiss: () -> Unit,
) {
    var email by rememberSaveable { mutableStateOf("") }
    var code by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var passwordVisible by rememberSaveable { mutableStateOf(false) }
    var done by rememberSaveable { mutableStateOf(false) }
    val context = LocalContext.current

    if (done) {
        AccountPage(title = "¡Listo!", subtitle = "Ya puedes entrar con tu nueva contraseña.") {
            Box(
                Modifier.size(56.dp).align(Alignment.CenterHorizontally).clip(CircleShape).background(AlDiaColors.CashSoft),
                contentAlignment = Alignment.Center,
            ) { Icon(Icons.Default.CheckCircle, contentDescription = null, tint = AlDiaColors.Cash, modifier = Modifier.size(30.dp)) }
            PrimaryButton(text = "Ir a iniciar sesión", onClick = onBack)
        }
        return
    }

    AccountPage(title = "Recuperar contraseña", subtitle = "Sigue estos pasos") {
        AlDiaCard(Modifier.fillMaxWidth()) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("1. Escríbenos por WhatsApp y cuéntanos que olvidaste tu contraseña.", style = MaterialTheme.typography.bodyMedium)
                Text("2. Te daremos un código (válido 15 minutos).", style = MaterialTheme.typography.bodyMedium)
                Text("3. Escríbelo aquí con tu nueva contraseña.", style = MaterialTheme.typography.bodyMedium)
            }
        }
        PrimaryButton(
            text = "Escribir por WhatsApp",
            color = AlDiaColors.Success,
            onClick = {
                val text = Uri.encode("Hola, olvidé mi contraseña de la app")
                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://wa.me/${AccountForms.WHATSAPP_SUPPORT}?text=$text")))
            },
        )
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
            value = code,
            onValueChange = { code = AccountForms.normalizeCode(it); if (error != null) onErrorDismiss() },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Código de recuperación") },
            singleLine = true,
            enabled = !loading,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
        )
        PasswordField(
            value = password,
            onValueChange = { password = it; if (error != null) onErrorDismiss() },
            label = "Nueva contraseña (mínimo 6 caracteres)",
            enabled = !loading,
            visible = passwordVisible,
            onToggle = { passwordVisible = !passwordVisible },
            imeAction = ImeAction.Next,
        )
        PasswordField(
            value = confirm,
            onValueChange = { confirm = it; if (error != null) onErrorDismiss() },
            label = "Confirmar contraseña",
            enabled = !loading,
            visible = passwordVisible,
            onToggle = { passwordVisible = !passwordVisible },
            imeAction = ImeAction.Done,
        )
        if (error != null) ErrorBanner(error)
        PrimaryButton(
            text = if (loading) "Cambiando…" else "Cambiar contraseña",
            onClick = { onSubmit(email, code, password, confirm) { done = true } },
            enabled = !loading,
            loading = loading,
        )
        TextButton(onClick = onBack, enabled = !loading) { Text("Volver a iniciar sesión") }
    }
}

@Composable
internal fun WelcomeScreen(user: ApiUser, onStart: () -> Unit) {
    val days = user.trialDaysLeft ?: 0
    AccountPage(title = "¡Cuenta creada!", subtitle = "${user.displayName} · Plan ${Plans.label(user.plan)}") {
        InfoBanner(
            "Prueba gratuita: $days ${if (days == 1) "día" else "días"}\n" +
                "Tu plan está pendiente de confirmación: el pago es en persona. " +
                "Mientras tanto tienes todas las funciones de la app.",
            tone = AlDiaColors.Warning,
        )
        Text(
            "Cuando administración confirme tu pago, tu cuenta quedará activa definitivamente.",
            style = MaterialTheme.typography.bodySmall,
            color = AlDiaColors.TextTertiary,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )
        PrimaryButton(text = "Empezar a usar la app", onClick = onStart)
    }
}

/** Prueba vencida sin confirmar: la app entera queda bloqueada hasta que administración confirme la tienda. */
@Composable
internal fun LockedScreen(user: ApiUser, onRefresh: (onDone: () -> Unit) -> Unit, onLogout: () -> Unit) {
    var checking by remember { mutableStateOf(false) }
    var notConfirmed by remember { mutableStateOf(false) }
    AccountPage(title = "Tu prueba gratuita terminó", subtitle = "") {
        Box(
            Modifier.size(56.dp).align(Alignment.CenterHorizontally).clip(CircleShape).background(AlDiaColors.WarningSoft),
            contentAlignment = Alignment.Center,
        ) { Icon(Icons.Default.Lock, contentDescription = null, tint = AlDiaColors.Warning, modifier = Modifier.size(26.dp)) }
        Text(
            "La cuenta de ${user.displayName} está esperando la confirmación de administración. Elige tu plan: " +
                "el pago es en persona y, en cuanto se confirme, podrás seguir usando la app.",
            style = MaterialTheme.typography.bodyMedium,
            color = AlDiaColors.TextSecondary,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )
        PlanCards(current = Plans.planOf(user.plan))
        if (notConfirmed) InfoBanner("Todavía no aparece confirmada. Vuelve a intentarlo en un rato.", tone = AlDiaColors.Warning)
        PrimaryButton(
            text = if (checking) "Verificando…" else "Verificar de nuevo",
            loading = checking,
            onClick = {
                checking = true
                notConfirmed = false
                onRefresh { checking = false; notConfirmed = true }
            },
        )
        PrimaryButton(text = "Cerrar sesión", onClick = onLogout, color = AlDiaColors.TextSecondary)
    }
}

private data class PlanCard(val id: String, val title: String, val price: String, val features: List<String>)

// Mismos precios y textos que `client/src/components/PlanCards.jsx`; el cobro es en persona (no hay pasarela).
@Composable
internal fun PlanCards(current: String) {
    val plans = listOf(
        PlanCard(Plans.BASIC, "Plan Basic", "\$10 USD", listOf("Hasta 5 usuarios simultáneos", "Todas las funciones de la app")),
        PlanCard(Plans.ENTERPRISE, "Plan Enterprise", "\$15 USD", listOf("Hasta 10 usuarios simultáneos", "App de monitorización para el jefe", "Gestión de hasta 2 sucursales")),
    )
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        plans.forEach { plan ->
            val selected = current == plan.id
            AlDiaCard(Modifier.fillMaxWidth()) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(plan.title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                        if (selected) Pill("Tu plan", AlDiaColors.Blue, AlDiaColors.BlueSoft)
                    }
                    Text("${plan.price} /mes", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                    Text("Pago físico (en persona)", style = MaterialTheme.typography.labelSmall, color = AlDiaColors.TextTertiary)
                    plan.features.forEach { feature ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Default.Check, contentDescription = null, tint = AlDiaColors.Success, modifier = Modifier.size(14.dp))
                            Spacer(Modifier.width(6.dp))
                            Text(feature, style = MaterialTheme.typography.bodySmall, color = AlDiaColors.TextSecondary)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun PasswordField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    enabled: Boolean,
    visible: Boolean,
    onToggle: () -> Unit,
    imeAction: ImeAction,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = Modifier.fillMaxWidth(),
        label = { Text(label) },
        singleLine = true,
        enabled = enabled,
        visualTransformation = if (visible) VisualTransformation.None else PasswordVisualTransformation(),
        trailingIcon = {
            TextButton(onClick = onToggle, enabled = enabled) { Text(if (visible) "Ocultar" else "Ver") }
        },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = imeAction),
    )
}

/** Mismo marco que la pantalla de inicio de sesión: logo, título y el formulario debajo. */
@Composable
private fun AccountPage(title: String, subtitle: String, content: @Composable ColumnScope.() -> Unit) {
    Box(
        modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).imePadding(),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Image(
                painter = painterResource(R.drawable.al_dia_icon),
                contentDescription = "Al Día",
                modifier = Modifier.size(64.dp).clip(RoundedCornerShape(18.dp)),
            )
            Spacer(Modifier.height(14.dp))
            Text(title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
            if (subtitle.isNotBlank()) {
                Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = AlDiaColors.TextSecondary, textAlign = TextAlign.Center)
            }
            Spacer(Modifier.height(20.dp))
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(14.dp), content = content)
        }
    }
}
