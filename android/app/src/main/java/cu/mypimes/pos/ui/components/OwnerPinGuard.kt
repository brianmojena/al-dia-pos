package cu.mypimes.pos.ui.components

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import cu.mypimes.pos.domain.shared.SharedLogic
import kotlinx.coroutines.launch

/**
 * Las pantallas llaman `LocalRequireOwnerPin.current { acción }`. Fuera de la caja central (o del dueño)
 * la acción corre tal cual; en caja central pide el PIN del dueño salvo dentro de la ventana de gracia.
 */
val LocalRequireOwnerPin = staticCompositionLocalOf<(() -> Unit) -> Unit> { { it() } }

@Composable
fun OwnerPinGuard(
    needsPin: () -> Boolean,
    /** Devuelve null si el PIN es correcto; si no, el mensaje de error. */
    verify: suspend (String) -> String?,
    content: @Composable () -> Unit,
) {
    var pending by remember { mutableStateOf<(() -> Unit)?>(null) }
    val require: (() -> Unit) -> Unit = { action -> if (needsPin()) pending = action else action() }
    CompositionLocalProvider(LocalRequireOwnerPin provides require) { content() }
    pending?.let { action ->
        var pin by remember { mutableStateOf("") }
        var error by remember { mutableStateOf<String?>(null) }
        var busy by remember { mutableStateOf(false) }
        val scope = rememberCoroutineScope()
        AlertDialog(
            onDismissRequest = { if (!busy) pending = null },
            title = { Text("PIN del dueño") },
            text = {
                OutlinedTextField(
                    value = pin,
                    onValueChange = { pin = it.filter(Char::isDigit).take(SharedLogic.OWNER_PIN_LENGTH); error = null },
                    label = { Text("PIN de ${SharedLogic.OWNER_PIN_LENGTH} dígitos") },
                    singleLine = true, enabled = !busy, isError = error != null,
                    supportingText = error?.let { { Text(it) } },
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                )
            },
            confirmButton = {
                TextButton(enabled = !busy && pin.length == SharedLogic.OWNER_PIN_LENGTH, onClick = {
                    busy = true
                    scope.launch {
                        val message = verify(pin)
                        busy = false
                        if (message == null) { pending = null; action() } else { error = message; pin = "" }
                    }
                }) { Text("Confirmar") }
            },
            dismissButton = { TextButton(enabled = !busy, onClick = { pending = null }) { Text("Cancelar") } },
        )
    }
}
