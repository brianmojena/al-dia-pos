package cu.mypimes.pos.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cu.mypimes.pos.domain.shared.SharedEnrollment
import cu.mypimes.pos.domain.shared.SharedLogic
import cu.mypimes.pos.ui.components.AlDiaCard
import cu.mypimes.pos.ui.components.AlDiaField
import cu.mypimes.pos.ui.components.ErrorBanner
import cu.mypimes.pos.ui.components.InfoBanner
import cu.mypimes.pos.ui.components.PrimaryButton
import cu.mypimes.pos.ui.theme.AlDiaColors

/** Web: `ActivateDevice.jsx`. El código de un solo uso es la credencial; los PIN ya vienen cifrados. */
@Composable
fun ActivateDeviceScreen(viewModel: SharedDeviceViewModel, onDone: () -> Unit, onBack: () -> Unit) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    var code by rememberSaveable { mutableStateOf("") }
    Column(
        Modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Activar esta caja", style = MaterialTheme.typography.headlineMedium)
        Text("Introduce el código que te dio el administrador.", style = MaterialTheme.typography.bodyMedium,
            color = AlDiaColors.TextSecondary, textAlign = TextAlign.Center)
        Spacer(Modifier.height(20.dp))
        AlDiaCard(Modifier.fillMaxWidth()) {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                state.error?.let { ErrorBanner(it) }
                AlDiaField(
                    "Código de activación", code, { code = viewModel.cleanCode(it); viewModel.clearError() },
                    placeholder = "XXXX XXXX XXXX", enabled = !state.busy, big = true, autoFocus = true,
                    supporting = "12 caracteres, vale 30 minutos y solo se puede usar una vez.",
                )
                PrimaryButton("Activar caja", { viewModel.activate(code, onDone) }, enabled = code.length == 12, loading = state.busy)
            }
        }
        TextButton(onClick = onBack, enabled = !state.busy) { Text("Volver") }
    }
}

/** Web: `SharedCashier.jsx`. Elegir persona y PIN (6 dígitos el cajero, 8 el dueño; teclado numérico propio). */
@Composable
fun SharedCashierScreen(
    record: SharedEnrollment,
    viewModel: SharedDeviceViewModel,
    onActivateAnother: () -> Unit,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    var selectedId by rememberSaveable { mutableStateOf<Int?>(null) }
    var pin by remember { mutableStateOf("") }
    val selected = record.activeMembers.firstOrNull { it.id == selectedId }
    val pinLength = if (selected?.isOwner == true) SharedLogic.OWNER_PIN_LENGTH else 6
    val enter = { value: String ->
        selected?.let { member -> viewModel.unlock(member.id, value) }
        pin = ""
    }
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(record.device.name.ifBlank { "Caja compartida" }, style = MaterialTheme.typography.headlineMedium)
        Text(
            if (record.device.continuous) "Caja continua · relevo sin cerrar" else "Caja por turno · cierre antes del relevo",
            style = MaterialTheme.typography.bodyMedium, color = AlDiaColors.TextSecondary,
        )
        Spacer(Modifier.height(20.dp))
        AlDiaCard(Modifier.fillMaxWidth()) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                if (SharedLogic.isExpired(record, System.currentTimeMillis())) {
                    InfoBanner(record.blocked.ifEmpty { "Los accesos necesitan revisión del administrador. Las operaciones pendientes siguen guardadas." }, tone = AlDiaColors.Warning)
                }
                if (selected == null) {
                    Text("¿Quién va a atender?", style = MaterialTheme.typography.titleMedium)
                    record.activeMembers.sortedByDescending { it.isOwner }.forEach { member ->
                        OutlinedButton(
                            onClick = { selectedId = member.id; pin = ""; viewModel.clearError() },
                            modifier = Modifier.fillMaxWidth().height(52.dp),
                        ) { Text(if (member.isOwner) "${member.label} · Dueño" else member.label) }
                    }
                } else {
                    TextButton(onClick = { selectedId = null; pin = ""; viewModel.clearError() }, enabled = !state.busy) { Text("← Cambiar selección") }
                    Text(selected.label, style = MaterialTheme.typography.titleMedium)
                    Text("Introduce tu PIN de $pinLength dígitos", style = MaterialTheme.typography.bodySmall, color = AlDiaColors.TextSecondary)
                    Text(
                        "●".repeat(pin.length).padEnd(pinLength, '○'),
                        style = MaterialTheme.typography.headlineMedium, letterSpacing = 8.sp,
                    )
                    val press = { digit: Char ->
                        if (!state.busy && pin.length < pinLength) {
                            pin += digit
                            if (pin.length == pinLength) enter(pin)
                        }
                    }
                    listOf("123", "456", "789").forEach { rowDigits ->
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            rowDigits.forEach { d -> Button(onClick = { press(d) }, enabled = !state.busy) { Text(d.toString()) } }
                        }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(onClick = { pin = "" }, enabled = !state.busy) { Text("Borrar") }
                        Button(onClick = { press('0') }, enabled = !state.busy) { Text("0") }
                        OutlinedButton(onClick = { pin = pin.dropLast(1) }, enabled = !state.busy) { Text("⌫") }
                    }
                }
                state.error?.let { ErrorBanner(it) }
            }
        }
        TextButton(onClick = onActivateAnother, enabled = !state.busy) { Text("Activar con un código nuevo") }
    }
}
