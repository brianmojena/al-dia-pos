package cu.mypimes.pos.ui.pos

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cu.mypimes.pos.data.auth.Session
import cu.mypimes.pos.domain.Format
import cu.mypimes.pos.domain.Payment
import cu.mypimes.pos.domain.pos.PosSale
import cu.mypimes.pos.ui.components.AlDiaCard
import cu.mypimes.pos.ui.components.EmptyBlock
import cu.mypimes.pos.ui.components.ErrorBanner
import cu.mypimes.pos.ui.components.InfoBanner
import cu.mypimes.pos.ui.components.KeyValueRow
import cu.mypimes.pos.ui.components.LoadingBlock
import cu.mypimes.pos.ui.components.Pill
import cu.mypimes.pos.ui.components.PrimaryButton
import cu.mypimes.pos.ui.components.SectionTitle
import cu.mypimes.pos.ui.theme.AlDiaColors

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HistoryScreen(session: Session, viewModel: PosViewModel) {
    val collected by viewModel.state.collectAsStateWithLifecycle()
    val state = if (collected.sessionToken == session.token) collected else PosUiState(loading = true)
    var selected by remember { mutableStateOf<PosSale?>(null) }

    LaunchedEffect(session.token) { viewModel.bindSession(session) }

    val totals = remember(state.sales) {
        var cash = 0.0
        var transfer = 0.0
        var foreign = 0.0
        state.sales.filterNot { it.isVoided }.forEach { sale ->
            val split = Payment.paymentSplit(
                sale.total, sale.paymentMethod, sale.transferAmount,
                sale.foreignCurrency, sale.foreignAmount, sale.exchangeRate,
            )
            cash += split.cash
            transfer += split.transfer
            foreign += split.foreign_cup
        }
        Triple(Payment.round2(cash), Payment.round2(transfer), Payment.round2(foreign))
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
        Row(Modifier.fillMaxWidth().padding(top = 14.dp, bottom = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Historial", style = MaterialTheme.typography.headlineMedium, color = AlDiaColors.TextPrimary)
                Text("Ventas de hoy · ${state.sales.size}", style = MaterialTheme.typography.bodySmall, color = AlDiaColors.TextSecondary)
            }
            if (state.syncing) {
                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = AlDiaColors.Blue)
                Spacer(Modifier.width(8.dp))
            }
            IconButton(onClick = { viewModel.sync(session) }, enabled = !state.syncing) {
                Icon(Icons.Default.Refresh, contentDescription = "Sincronizar", tint = AlDiaColors.TextSecondary)
            }
        }

        AlDiaCard(Modifier.fillMaxWidth()) {
            Column {
                Text("Vendido hoy", style = MaterialTheme.typography.labelMedium, color = AlDiaColors.TextSecondary)
                Text(Format.money(state.sales.filterNot { it.isVoided }.sumOf { it.total }, 2), style = MaterialTheme.typography.headlineLarge, color = AlDiaColors.TextPrimary)
                Spacer(Modifier.height(10.dp))
                HorizontalDivider(color = AlDiaColors.BorderSoft)
                Spacer(Modifier.height(10.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    MiniTotal("Efectivo", totals.first, AlDiaColors.Cash, Modifier.weight(1f))
                    MiniTotal("Transfer.", totals.second, AlDiaColors.Transfer, Modifier.weight(1f))
                    MiniTotal("Divisas", totals.third, AlDiaColors.Foreign, Modifier.weight(1f))
                }
            }
        }
        Spacer(Modifier.height(10.dp))

        if (state.pendingSales > 0) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.CloudOff, contentDescription = null, tint = AlDiaColors.Warning, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
                Text(
                    "${state.pendingSales} venta(s) sin subir",
                    style = MaterialTheme.typography.bodySmall,
                    color = AlDiaColors.Warning,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = { viewModel.sync(session) }, enabled = !state.syncing) {
                    Text("Sincronizar", color = AlDiaColors.Blue)
                }
            }
            Spacer(Modifier.height(4.dp))
        }
        if (state.actionMessage != null) {
            InfoBanner(state.actionMessage!!, tone = AlDiaColors.Success)
            Spacer(Modifier.height(8.dp))
        }
        if (state.error != null) {
            ErrorBanner(state.error!!)
            Spacer(Modifier.height(8.dp))
        }

        when {
            state.loading -> LoadingBlock()
            state.sales.isEmpty() -> EmptyBlock("Todavía no hay ventas hoy", "Las ventas que cobres aparecerán aquí, incluso sin conexión.")
            else -> state.sales.forEach { sale ->
                SaleRow(sale) { selected = sale }
                Spacer(Modifier.height(8.dp))
            }
        }
        Spacer(Modifier.height(24.dp))
    }

    selected?.let { sale ->
        ModalBottomSheet(
            onDismissRequest = { selected = null },
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            containerColor = AlDiaColors.Surface,
        ) {
            SaleDetailSheet(sale, onDone = { selected = null })
        }
    }
}

@Composable
private fun MiniTotal(label: String, value: Double, color: Color, modifier: Modifier = Modifier) {
    Column(modifier) {
        Text(label, style = MaterialTheme.typography.labelSmall, color = AlDiaColors.TextTertiary)
        Text(Format.money(value), style = MaterialTheme.typography.titleSmall, color = color, maxLines = 1)
    }
}

private fun statusLabel(sale: PosSale): Pair<String, Color> = when (sale.status) {
    "voided" -> "Anulada" to AlDiaColors.Danger
    "synced" -> if (sale.isClosed) "Cerrada" to AlDiaColors.Blue else "Sincronizada" to AlDiaColors.Success
    "rejected" -> "Rechazada" to AlDiaColors.Danger
    "blocked" -> "Bloqueada" to AlDiaColors.Danger
    "conflict" -> "Revisar" to AlDiaColors.Danger
    else -> "Pendiente" to AlDiaColors.Warning
}

@Composable
private fun SaleRow(sale: PosSale, onClick: () -> Unit) {
    val (label, color) = statusLabel(sale)
    Surface(onClick = onClick, shape = RoundedCornerShape(18.dp), color = Color.White) {
        Column(Modifier.fillMaxWidth().padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(Format.money(sale.total, 2), style = MaterialTheme.typography.titleMedium, color = AlDiaColors.TextPrimary)
                    Text(
                        sale.label + if (sale.foreignCurrency != null) " · ${Format.foreign(sale.foreignAmount ?: 0.0)} ${sale.foreignCurrency}" else "",
                        style = MaterialTheme.typography.bodySmall,
                        color = AlDiaColors.TextSecondary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                Column(horizontalAlignment = Alignment.End) {
                    Pill(label, color, color.copy(alpha = 0.12f))
                    Spacer(Modifier.height(3.dp))
                    Text(Format.time(sale.createdAt), style = MaterialTheme.typography.labelSmall, color = AlDiaColors.TextTertiary)
                }
            }
            if (sale.stockShort && !sale.isSynced && !sale.needsReview) {
                Spacer(Modifier.height(6.dp))
                Text("Vigilar: $STOCK_SHORT_NOTICE", style = MaterialTheme.typography.labelSmall, color = AlDiaColors.Warning, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            if (sale.needsReview && sale.error != null) {
                Spacer(Modifier.height(6.dp))
                Text(sale.error, style = MaterialTheme.typography.labelSmall, color = AlDiaColors.Danger, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SaleDetailSheet(sale: PosSale, onDone: () -> Unit) {
    val (label, color) = statusLabel(sale)
    Column(
        Modifier.fillMaxWidth().heightIn(max = 560.dp).verticalScroll(rememberScrollState())
            .padding(horizontal = 22.dp).padding(bottom = 26.dp).imePadding(),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Venta", style = MaterialTheme.typography.headlineSmall, color = AlDiaColors.TextPrimary)
                Text(Format.dateTime(sale.createdAt), style = MaterialTheme.typography.bodySmall, color = AlDiaColors.TextSecondary)
            }
            Pill(label, color, color.copy(alpha = 0.12f))
        }
        Text(Format.money(sale.total, 2), style = MaterialTheme.typography.headlineLarge, color = AlDiaColors.TextPrimary)
        Spacer(Modifier.height(10.dp))

        if (sale.lines.isNotEmpty()) {
            SectionTitle("Productos")
            Spacer(Modifier.height(6.dp))
            AlDiaCard(Modifier.fillMaxWidth()) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    sale.lines.forEach { line ->
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(
                                    line.product.name + if (line.isPack) " · paquete x${line.product.packSize}" else "",
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = AlDiaColors.TextPrimary,
                                    maxLines = 2,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                Text(
                                    "${Format.quantity(line.quantity)} × ${Format.money(line.unitPrice, 2)}",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = AlDiaColors.TextTertiary,
                                )
                            }
                            Text(Format.money(line.lineTotal, 2), style = MaterialTheme.typography.bodyMedium, color = AlDiaColors.TextPrimary)
                        }
                    }
                }
            }
            Spacer(Modifier.height(10.dp))
        }

        AlDiaCard(Modifier.fillMaxWidth()) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                KeyValueRow("Cobro", sale.label)
                when (sale.paymentMethod) {
                    "efectivo" -> {
                        if (sale.cashReceived > 0) {
                            KeyValueRow("Recibido", Format.money(sale.cashReceived, 2))
                            KeyValueRow("Vuelto", Format.money((sale.cashReceived - sale.total).coerceAtLeast(0.0), 2), valueColor = AlDiaColors.Success)
                        }
                    }
                    "mixto" -> {
                        val transfer = sale.transferAmount ?: 0.0
                        KeyValueRow("Transferencia", Format.money(transfer, 2), valueColor = AlDiaColors.Transfer)
                        KeyValueRow("Efectivo", Format.money((sale.total - transfer).coerceAtLeast(0.0), 2), valueColor = AlDiaColors.Cash)
                    }
                    "divisa" -> {
                        KeyValueRow(
                            "Divisa",
                            "${Format.foreign(sale.foreignAmount ?: 0.0)} ${sale.foreignCurrency ?: ""}",
                            valueColor = AlDiaColors.Foreign,
                        )
                        KeyValueRow("Tasa", Format.rate(sale.exchangeRate))
                    }
                    else -> Unit
                }
                if (sale.serverId != null) KeyValueRow("Folio", "#${sale.serverId}")
                if (sale.isClosed) KeyValueRow("Cierre de caja", "#${sale.cashCloseId}")
            }
        }

        if (sale.error != null) {
            Spacer(Modifier.height(10.dp))
            InfoBanner(sale.error, tone = if (sale.needsReview) AlDiaColors.Danger else AlDiaColors.Warning)
        }
        if (sale.stockShort && !sale.isSynced) {
            Spacer(Modifier.height(10.dp))
            InfoBanner(STOCK_SHORT_NOTICE, tone = AlDiaColors.Warning)
        }
        if (sale.isVoided) {
            Spacer(Modifier.height(10.dp))
            InfoBanner("El servidor anuló esta venta; no cuenta en los totales ni en la caja.", tone = AlDiaColors.Danger)
        }
        if (sale.status == "pending") {
            Spacer(Modifier.height(10.dp))
            InfoBanner("Está guardada en el teléfono; se subirá cuando haya conexión.", tone = AlDiaColors.Warning)
        }
        Spacer(Modifier.height(14.dp))
        PrimaryButton("Cerrar", onDone)
    }
}
