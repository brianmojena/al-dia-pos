package cu.mypimes.pos.ui.store

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import cu.mypimes.pos.data.auth.Session
import cu.mypimes.pos.data.auth.accountKeyFromToken
import cu.mypimes.pos.data.local.LocalDao
import cu.mypimes.pos.data.local.QueuedOperationEntity
import cu.mypimes.pos.data.local.shopPrefix
import cu.mypimes.pos.data.pos.PosRepository
import cu.mypimes.pos.data.shared.SharedDeviceRepository
import cu.mypimes.pos.data.store.OwnerOutbox
import cu.mypimes.pos.data.store.StoreRepository
import cu.mypimes.pos.data.sync.ChangesSync
import cu.mypimes.pos.domain.Format
import cu.mypimes.pos.domain.Freshness
import cu.mypimes.pos.domain.outbox.Outbox
import cu.mypimes.pos.domain.outbox.QueueReview
import cu.mypimes.pos.domain.pos.PosSale
import cu.mypimes.pos.ui.components.AlDiaCard
import cu.mypimes.pos.ui.components.EmptyBlock
import cu.mypimes.pos.ui.components.ErrorBanner
import cu.mypimes.pos.ui.components.LocalRequireOwnerPin
import cu.mypimes.pos.ui.components.SectionTitle
import cu.mypimes.pos.ui.theme.AlDiaColors
import dagger.hilt.android.lifecycle.HiltViewModel
import java.io.IOException
import javax.inject.Inject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json

/** Una operación de la cola lista para mostrarse: quién la hizo, qué era y qué dijo el servidor. */
data class ReviewItem(
    val operation: QueuedOperationEntity,
    val who: String,
    val title: String,
    val reason: String,
    val stock: List<QueueReview.StockLine>,
    val detail: String,
)

data class SyncStatusState(
    /** Solo en caja central se muestra el indicador. */
    val central: Boolean = false,
    val counts: QueueReview.Counts = QueueReview.Counts(0, 0),
    val groups: Map<QueueReview.Group, List<ReviewItem>> = emptyMap(),
    val lastOkAt: Long? = null,
    val uploading: Boolean = false,
    val message: String? = null,
)

/** A8/A9: indicador permanente y panel «Por revisar» de la caja central. Solo lee estados; descartar es una marca. */
@HiltViewModel
class SyncStatusViewModel @Inject constructor(
    private val shared: SharedDeviceRepository,
    private val dao: LocalDao,
    private val store: StoreRepository,
    private val changes: ChangesSync,
    private val outbox: OwnerOutbox,
    private val json: Json,
) : ViewModel() {
    private val _state = MutableStateFlow(SyncStatusState())
    val state = _state.asStateFlow()
    private var job: Job? = null
    private var token: String? = null

    fun bind(session: Session) {
        if (token == session.token) return
        token = session.token
        job?.cancel()
        val key = accountKeyFromToken(session.token, session.user.id)
        if (key == null || shared.catalogKey(key) == key) { // catalogKey distinta de la cuenta = caja central
            _state.value = SyncStatusState()
            return
        }
        val prefix = shopPrefix(key)
        job = viewModelScope.launch {
            combine(dao.observeShopQueue(prefix), dao.observeShopLastOk(prefix)) { ops, lastOk ->
                val live = ops.filter { it.status != QueuedOperationEntity.STATUS_DISCARDED }
                val groups = QueueReview.grouped(live).mapValues { (_, list) -> list.map { item(it) } }
                _state.update { it.copy(central = true, counts = QueueReview.counts(live), groups = groups, lastOkAt = lastOk?.takeIf { v -> v > 0 }) }
            }.collect {}
        }
    }

    private suspend fun item(op: QueuedOperationEntity): ReviewItem {
        val sale = if (op.operationType == PosRepository.OP_SALE) {
            dao.getCacheRecord(op.accountKey, PosRepository.KIND_SALES, op.clientOperationId)
                ?.let { runCatching { json.decodeFromString<PosSale>(it.payload) }.getOrNull() }
        } else null
        val reason = op.lastError ?: "El servidor no dio un motivo."
        val lines = sale?.lines?.joinToString("\n") { "${it.product.name} × ${Format.quantity(it.quantity)}" }
        return ReviewItem(
            operation = op,
            who = whoIs(op),
            title = Outbox.label(op.operationType).replaceFirstChar { it.uppercase() },
            reason = reason,
            stock = QueueReview.stockLines(sale, op.lastError),
            detail = lines ?: op.payload.take(500),
        )
    }

    private fun whoIs(op: QueuedOperationEntity): String {
        val id = op.accountKey.substringAfter(':').toIntOrNull()
        val member = shared.enrollment.value?.cashiers?.firstOrNull { it.id == id }
        return member?.let { it.label + if (it.isOwner) " (dueño)" else "" } ?: "Cuenta ${op.accountKey}"
    }

    fun retry(op: QueuedOperationEntity) { viewModelScope.launch { outbox.retry(op) } }

    /** Solo la marca de descartada: la fila, su motivo y los datos de la venta se conservan. */
    fun discard(op: QueuedOperationEntity) { viewModelScope.launch { outbox.discard(op) } }

    /** Sube la cola de todas las personas con la credencial de cada una; sin red no pasa nada, todo queda guardado. */
    fun uploadNow(session: Session) {
        if (_state.value.uploading) return
        val key = accountKeyFromToken(session.token, session.user.id) ?: return
        _state.update { it.copy(uploading = true, message = null) }
        viewModelScope.launch {
            val message = try {
                // Dos pasadas: lo que esperaba una alta de otra persona sube en la segunda.
                repeat(2) {
                    val pending = dao.shopQueue(shopPrefix(key)).filter { it.status == QueuedOperationEntity.STATUS_PENDING }
                    if (pending.isEmpty()) return@repeat
                    for (account in pending.groupBy { it.accountKey }.entries.sortedBy { e -> e.value.minOf { it.createdAt } }.map { it.key }) {
                        store.sync(if (account == key) session else shared.credentialFor(account) ?: continue)
                    }
                }
                changes.sync(session)
                null
            } catch (error: CancellationException) {
                throw error
            } catch (error: IOException) {
                "Sin conexión. Todo sigue guardado en este aparato."
            } catch (error: Exception) {
                error.message ?: "No se pudo subir. Todo sigue guardado en este aparato."
            }
            _state.update { it.copy(uploading = false, message = message) }
        }
    }
}

/** Franja fina con «N sin subir · M por revisar», la última bajada correcta y «Subir ahora». Nada fuera de caja central. */
@Composable
fun SyncStatusBar(session: Session, viewModel: SyncStatusViewModel, onOpenReview: (() -> Unit)?) {
    androidx.compose.runtime.LaunchedEffect(session.token) { viewModel.bind(session) }
    val state by viewModel.state.collectAsStateWithLifecycle()
    if (!state.central) return
    val tone = when {
        state.counts.review > 0 -> AlDiaColors.Danger
        state.counts.unsent > 0 -> AlDiaColors.Warning
        else -> AlDiaColors.Success
    }
    Column(Modifier.fillMaxWidth().background(tone.copy(alpha = 0.09f))) {
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(
                Modifier.weight(1f).padding(vertical = 4.dp).let { if (onOpenReview != null && state.counts.review > 0) it.clickable(onClick = onOpenReview) else it },
            ) {
                Text(state.counts.text, style = MaterialTheme.typography.labelLarge, color = tone)
                Text(
                    state.lastOkAt?.let { "Última subida correcta: ${Freshness.ago(it, System.currentTimeMillis())}" } ?: "Aún sin subida correcta",
                    style = MaterialTheme.typography.labelSmall, color = AlDiaColors.TextSecondary,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            TextButton(onClick = { viewModel.uploadNow(session) }, enabled = !state.uploading) {
                Text(if (state.uploading) "Subiendo…" else "Subir ahora")
            }
        }
        state.message?.let {
            Text(it, style = MaterialTheme.typography.labelSmall, color = AlDiaColors.Danger, modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 4.dp))
        }
    }
}

/** A9: panel del dueño con lo que el servidor no aceptó. Reintentar sube de nuevo; descartar solo marca (pide el PIN). */
@Composable
fun PorRevisarScreen(session: Session, viewModel: SyncStatusViewModel, onBack: () -> Unit) {
    androidx.compose.runtime.LaunchedEffect(session.token) { viewModel.bind(session) }
    val state by viewModel.state.collectAsStateWithLifecycle()
    val requireOwnerPin = LocalRequireOwnerPin.current
    var detail by remember { mutableStateOf<ReviewItem?>(null) }
    var toDiscard by remember { mutableStateOf<ReviewItem?>(null) }

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Volver") }
            Column {
                Text("Por revisar", style = MaterialTheme.typography.headlineMedium, color = AlDiaColors.TextPrimary)
                Text(state.counts.text, style = MaterialTheme.typography.bodySmall, color = AlDiaColors.TextSecondary)
            }
        }
        Spacer(Modifier.height(8.dp))
        if (state.counts.review == 0) {
            EmptyBlock("Nada por revisar", "Todo lo que subió este aparato fue aceptado por el servidor.")
            return@Column
        }
        LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            QueueReview.Group.entries.forEach { group ->
                val list = state.groups[group].orEmpty()
                if (list.isNotEmpty()) {
                    item { SectionTitle("${group.title} (${list.size})") }
                    items(list, key = { it.operation.clientOperationId }) { entry ->
                        AlDiaCard(Modifier.fillMaxWidth()) {
                            Column {
                                Text(entry.title, style = MaterialTheme.typography.titleSmall, color = AlDiaColors.TextPrimary)
                                Text(
                                    "${entry.who} · ${Format.dateTime(entry.operation.createdAt)}",
                                    style = MaterialTheme.typography.labelSmall, color = AlDiaColors.TextTertiary,
                                )
                                Spacer(Modifier.height(6.dp))
                                ErrorBanner(entry.reason)
                                entry.stock.forEach {
                                    Text(
                                        "${it.product}: se vendieron ${Format.quantity(it.quantity)}" +
                                            (it.serverStock?.let { s -> "; el servidor dijo que hay ${Format.quantity(s)}" } ?: ""),
                                        style = MaterialTheme.typography.bodySmall, color = AlDiaColors.TextSecondary,
                                    )
                                }
                                Row {
                                    TextButton(onClick = { viewModel.retry(entry.operation) }) { Text("Reintentar") }
                                    TextButton(onClick = { detail = entry }) { Text("Ver detalle") }
                                    TextButton(onClick = { toDiscard = entry }) { Text("Descartar", color = AlDiaColors.Danger) }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    detail?.let { entry ->
        AlertDialog(
            onDismissRequest = { detail = null },
            title = { Text(entry.title) },
            text = {
                Text(
                    "${entry.who}\n${Format.dateTime(entry.operation.createdAt)}\nIntentos: ${entry.operation.attempts}\n\n" +
                        "${entry.reason}\n\n${entry.detail}",
                )
            },
            confirmButton = { TextButton(onClick = { detail = null }) { Text("Cerrar") } },
        )
    }
    toDiscard?.let { entry ->
        AlertDialog(
            onDismissRequest = { toDiscard = null },
            title = { Text("¿Descartar esta operación?") },
            text = { Text("Se marca como descartada y deja de contar como pendiente. No se borra nada: el motivo y los datos se conservan.") },
            confirmButton = {
                TextButton(onClick = { toDiscard = null; requireOwnerPin { viewModel.discard(entry.operation) } }) {
                    Text("Descartar", color = AlDiaColors.Danger)
                }
            },
            dismissButton = { TextButton(onClick = { toDiscard = null }) { Text("Cancelar") } },
        )
    }
}
