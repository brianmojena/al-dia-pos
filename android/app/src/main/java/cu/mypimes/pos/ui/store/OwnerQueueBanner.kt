package cu.mypimes.pos.ui.store

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.TextButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cu.mypimes.pos.data.auth.Session
import cu.mypimes.pos.data.auth.accountKeyFromToken
import cu.mypimes.pos.data.local.QueuedOperationEntity
import cu.mypimes.pos.data.store.OwnerOutbox
import cu.mypimes.pos.domain.outbox.Outbox
import cu.mypimes.pos.ui.components.ErrorBanner
import cu.mypimes.pos.ui.components.InfoBanner
import cu.mypimes.pos.ui.theme.AlDiaColors
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.launch

@HiltViewModel
class OwnerQueueViewModel @Inject constructor(private val outbox: OwnerOutbox) : ViewModel() {
    fun operations(session: Session): Flow<List<QueuedOperationEntity>> =
        accountKeyFromToken(session.token, session.user.id)?.let(outbox::unsettled) ?: emptyFlow()

    fun retry(operation: QueuedOperationEntity) {
        viewModelScope.launch { outbox.retry(operation) }
    }
}

/**
 * A6: cambios del dueño en caja central que aún no están en el servidor. Los pendientes se avisan como «sin subir»;
 * los rechazados se muestran siempre con el motivo del servidor (nunca se ocultan) y se pueden reintentar.
 */
@Composable
fun OwnerQueueBanner(session: Session, viewModel: OwnerQueueViewModel = hiltViewModel()) {
    val flow = remember(session.token) { viewModel.operations(session) }
    val operations by flow.collectAsState(initial = emptyList())
    if (operations.isEmpty()) return
    val waiting = operations.count { it.status == QueuedOperationEntity.STATUS_PENDING }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (waiting > 0) {
            InfoBanner(
                if (waiting == 1) "1 cambio sin subir: está guardado en este aparato y se enviará al recuperar la conexión."
                else "$waiting cambios sin subir: están guardados en este aparato y se enviarán al recuperar la conexión.",
                tone = AlDiaColors.Warning,
            )
        }
        operations.filter { it.status != QueuedOperationEntity.STATUS_PENDING }.forEach { op ->
            Column {
                ErrorBanner(
                    (if (op.status == Outbox.STATUS_BLOCKED) "Bloqueado: " else "Rechazado: ") +
                        Outbox.label(op.operationType).replaceFirstChar { it.uppercase() } + ". " +
                        (op.lastError ?: "El servidor no lo aceptó."),
                )
                TextButton(onClick = { viewModel.retry(op) }) {
                    Text("Reintentar", style = MaterialTheme.typography.labelLarge)
                }
            }
        }
        Spacer(Modifier.height(4.dp))
    }
}
