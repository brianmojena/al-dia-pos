package cu.mypimes.pos.ui.store

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cu.mypimes.pos.data.auth.Session
import cu.mypimes.pos.data.store.CashierDto
import cu.mypimes.pos.domain.Format
import cu.mypimes.pos.domain.cashiers.Plans
import cu.mypimes.pos.domain.cashiers.atSeatLimit
import cu.mypimes.pos.domain.cashiers.seatsUsed
import cu.mypimes.pos.ui.components.AlDiaCard
import cu.mypimes.pos.ui.components.AlDiaField
import cu.mypimes.pos.ui.components.EmptyBlock
import cu.mypimes.pos.ui.components.ErrorBanner
import cu.mypimes.pos.ui.components.InfoBanner
import cu.mypimes.pos.ui.components.LoadingBlock
import cu.mypimes.pos.ui.components.PrimaryButton
import cu.mypimes.pos.ui.theme.AlDiaColors

/** Gestión de cajeros del dueño (web: `Cajeros.jsx`). */
@Composable
fun CashiersScreen(session: Session, viewModel: CashiersViewModel, onBack: () -> Unit) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    var toRemove by remember { mutableStateOf<CashierDto?>(null) }
    LaunchedEffect(session.token) { viewModel.refresh(session) }
    val plan = session.user.plan
    val atLimit = atSeatLimit(plan, state.cashiers.size)

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Volver") }
            Column(Modifier.weight(1f)) {
                Text("Cajeros", style = MaterialTheme.typography.headlineSmall, color = AlDiaColors.TextPrimary)
                Text(
                    "${seatsUsed(state.cashiers.size)} de ${Plans.maxUsers(plan)} usuarios del Plan ${Plans.label(plan)}" +
                        if (atLimit) " — límite alcanzado" else "",
                    style = MaterialTheme.typography.labelSmall,
                    color = if (atLimit) AlDiaColors.Warning else AlDiaColors.TextTertiary,
                )
            }
            IconButton(onClick = viewModel::openForm, enabled = !atLimit) {
                Icon(Icons.Default.Add, contentDescription = "Nuevo cajero", tint = if (atLimit) AlDiaColors.TextTertiary else AlDiaColors.Blue)
            }
        }
        Spacer(Modifier.height(8.dp))
        InfoBanner(
            "Un cajero puede cobrar, cerrar la caja, dar de alta productos nuevos y contar inventario. " +
                "No puede cambiar precios ni borrar productos existentes, y no ve las ventas del día, " +
                "el historial de arqueos, ni los precios de compra.",
        )
        Spacer(Modifier.height(10.dp))
        state.error?.let { ErrorBanner(it); Spacer(Modifier.height(10.dp)) }
        when {
            state.loading && state.cashiers.isEmpty() -> LoadingBlock()
            state.cashiers.isEmpty() -> EmptyBlock("Todavía no hay cajeros", "Tú cobras con tu propia cuenta.")
            else -> LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(state.cashiers, key = { it.id }) { cashier ->
                    AlDiaCard(Modifier.fillMaxWidth()) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(cashier.email, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold,
                                    color = AlDiaColors.TextPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text("Desde ${Format.dateTime(cashier.createdAt)}", style = MaterialTheme.typography.labelSmall,
                                    color = AlDiaColors.TextTertiary)
                            }
                            IconButton(onClick = { toRemove = cashier }, enabled = !state.busy) {
                                Icon(Icons.Default.Delete, contentDescription = "Quitar acceso", tint = AlDiaColors.Danger)
                            }
                        }
                    }
                }
            }
        }
    }

    toRemove?.let { cashier ->
        AlertDialog(
            onDismissRequest = { toRemove = null },
            title = { Text("Quitar acceso") },
            text = { Text("¿Quitar el acceso de \"${cashier.email}\"? No podrá volver a entrar.") },
            confirmButton = { TextButton(onClick = { viewModel.remove(session, cashier.id); toRemove = null }) { Text("Quitar") } },
            dismissButton = { TextButton(onClick = { toRemove = null }) { Text("Cancelar") } },
        )
    }

    if (state.formOpen) {
        var email by remember { mutableStateOf("") }
        var password by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { if (!state.busy) viewModel.closeForm() },
            title = { Text("Nuevo cajero") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    AlDiaField("Correo o usuario", email, { email = it }, placeholder = "cajero@mitienda.cu", enabled = !state.busy)
                    AlDiaField(
                        "Contraseña", password, { password = it }, placeholder = "Mínimo 6 caracteres", enabled = !state.busy,
                        supporting = "Se muestra en claro para que puedas dársela al cajero. Anótala: no se puede volver a ver.",
                    )
                    state.formError?.let { ErrorBanner(it) }
                }
            },
            confirmButton = {
                PrimaryButton("Crear cajero", { viewModel.create(session, email, password) }, loading = state.busy, height = 44)
            },
            dismissButton = { TextButton(onClick = viewModel::closeForm, enabled = !state.busy) { Text("Cancelar") } },
        )
    }
}
