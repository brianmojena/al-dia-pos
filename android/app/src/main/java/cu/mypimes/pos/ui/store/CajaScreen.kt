package cu.mypimes.pos.ui.store

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
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
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Calculate
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.WarningAmber
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cu.mypimes.pos.data.auth.Session
import cu.mypimes.pos.data.store.CashCloseDto
import cu.mypimes.pos.data.store.CashCloseSummaryDto
import cu.mypimes.pos.data.store.WithdrawalDto
import cu.mypimes.pos.domain.Format
import cu.mypimes.pos.domain.inventory.CheckTone
import cu.mypimes.pos.domain.inventory.InventoryCheck
import cu.mypimes.pos.domain.inventory.RowTone
import cu.mypimes.pos.domain.inventory.checkTone
import cu.mypimes.pos.domain.inventory.crossCheckRows
import cu.mypimes.pos.ui.components.AlDiaCard
import cu.mypimes.pos.ui.components.AlDiaField
import cu.mypimes.pos.ui.components.EmptyBlock
import cu.mypimes.pos.ui.components.ErrorBanner
import cu.mypimes.pos.ui.components.InfoBanner
import cu.mypimes.pos.ui.components.KeyValueRow
import cu.mypimes.pos.ui.components.LoadingBlock
import cu.mypimes.pos.ui.components.Pill
import cu.mypimes.pos.ui.components.PrimaryButton
import cu.mypimes.pos.ui.components.SectionTitle
import cu.mypimes.pos.ui.theme.AlDiaColors
import kotlin.math.abs

private fun money(value: Double?): String = Format.money(value ?: 0.0)

private fun diffColor(value: Double): Color = when {
    abs(value) < 0.005 -> AlDiaColors.Success
    value > 0 -> AlDiaColors.Transfer
    else -> AlDiaColors.Danger
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CajaScreen(session: Session, viewModel: StoreViewModel) {
    val collected by viewModel.state.collectAsStateWithLifecycle()
    val state = if (collected.sessionToken == session.token) collected else StoreUiState(loading = true)

    var counted by rememberSaveable { mutableStateOf("") }
    var countedUsd by rememberSaveable { mutableStateOf("") }
    var countedEur by rememberSaveable { mutableStateOf("") }
    var openingFloat by rememberSaveable { mutableStateOf("") }
    var note by rememberSaveable { mutableStateOf("") }
    var withdrawalOpen by remember { mutableStateOf(false) }
    var confirmVoid by remember { mutableStateOf<WithdrawalDto?>(null) }

    val isOwner = session.user.isOwner
    val openWithdrawals = remember(state.openWithdrawals) { state.openWithdrawals.filter { it.voidedAt == null } }
    val rates = state.rates

    LaunchedEffect(session.token) { viewModel.bindSession(session) }
    LaunchedEffect(state.lastClose) {
        if (state.lastClose != null) {
            counted = ""
            countedUsd = ""
            countedEur = ""
            openingFloat = ""
            note = ""
        }
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
        Row(Modifier.fillMaxWidth().padding(top = 14.dp, bottom = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Caja", style = MaterialTheme.typography.headlineMedium, color = AlDiaColors.TextPrimary)
                Text(
                    if (isOwner) "Toda la tienda" else "Tu gaveta",
                    style = MaterialTheme.typography.bodySmall,
                    color = AlDiaColors.TextSecondary,
                )
            }
            IconButton(onClick = { viewModel.refresh(session) }, enabled = !state.refreshing) {
                if (state.refreshing) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = AlDiaColors.Blue)
                else Icon(Icons.Default.Refresh, contentDescription = "Actualizar", tint = AlDiaColors.TextSecondary)
            }
        }

        if (state.pendingTotal > 0) {
            InfoBanner(
                "${state.pendingTotal} operación(es) guardada(s) en este teléfono, esperando conexión.",
                tone = AlDiaColors.Warning,
            )
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.CloudOff, contentDescription = null, tint = AlDiaColors.Warning, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
                TextButton(onClick = { viewModel.sync(session) }, enabled = !state.busy) {
                    Text("Sincronizar ahora", color = AlDiaColors.Blue, fontWeight = FontWeight.SemiBold)
                }
            }
            Spacer(Modifier.height(4.dp))
        }
        if (state.notice != null) {
            InfoBanner(state.notice!!, tone = AlDiaColors.Success)
            Spacer(Modifier.height(8.dp))
        }
        if (state.error != null) {
            ErrorBanner(state.error!!)
            Spacer(Modifier.height(8.dp))
        }

        if (state.loading) {
            LoadingBlock()
            return@Column
        }

        PeriodCard(openedAt = state.period?.openedAt, isFirstClose = state.period?.isFirstClose == true)
        Spacer(Modifier.height(10.dp))

        if (!isOwner) {
            WithdrawalsCard(
                open = openWithdrawals,
                pending = state.pendingWithdrawals,
                busy = state.busy,
                onAdd = { withdrawalOpen = true },
                onVoid = { confirmVoid = it },
            )
            Spacer(Modifier.height(10.dp))
        }

        if (state.pendingCloses.isNotEmpty()) {
            AlDiaCard(Modifier.fillMaxWidth()) {
                Column {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.WarningAmber, contentDescription = null, tint = AlDiaColors.Warning, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(8.dp))
                        Text("Cierre pendiente de subir", style = MaterialTheme.typography.titleSmall, color = AlDiaColors.TextPrimary)
                    }
                    Spacer(Modifier.height(8.dp))
                    state.pendingCloses.forEach { pending ->
                        Text(
                            "Contado ${money(pending.countedCash)} · ${Format.dateTime(pending.queuedAt)}",
                            style = MaterialTheme.typography.bodySmall,
                            color = AlDiaColors.TextSecondary,
                        )
                        pending.lastError?.let {
                            Text(it, style = MaterialTheme.typography.labelSmall, color = AlDiaColors.TextTertiary)
                        }
                    }
                    Spacer(Modifier.height(10.dp))
                    InfoBanner("Mientras no se suba el cierre no se pueden cobrar ventas nuevas.", tone = AlDiaColors.Warning)
                }
            }
            Spacer(Modifier.height(10.dp))
        } else {
            AlDiaCard(Modifier.fillMaxWidth()) {
                Column {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.Calculate, contentDescription = null, tint = AlDiaColors.Blue, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(8.dp))
                        Text("Cerrar caja", style = MaterialTheme.typography.titleMedium, color = AlDiaColors.TextPrimary)
                    }
                    Spacer(Modifier.height(12.dp))
                    AlDiaField(
                        label = "Efectivo contado *",
                        value = counted,
                        onValueChange = { counted = it },
                        placeholder = "0",
                        keyboardType = KeyboardType.Decimal,
                        big = true,
                        supporting = if (isOwner) "Pesos que hay físicamente en todas las cajas." else "Pesos que hay físicamente en la gaveta.",
                    )
                    Spacer(Modifier.height(10.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        if (rates["USD"]?.hasRate == true) {
                            AlDiaField(
                                label = "Dólares",
                                value = countedUsd,
                                onValueChange = { countedUsd = it },
                                placeholder = "0",
                                keyboardType = KeyboardType.Decimal,
                                modifier = Modifier.weight(1f),
                            )
                        }
                        if (rates["EUR"]?.hasRate == true) {
                            AlDiaField(
                                label = "Euros",
                                value = countedEur,
                                onValueChange = { countedEur = it },
                                placeholder = "0",
                                keyboardType = KeyboardType.Decimal,
                                modifier = Modifier.weight(1f),
                            )
                        }
                    }
                    if (rates.values.any { it.hasRate }) {
                        Spacer(Modifier.height(4.dp))
                        Text(
                            "Los billetes en divisa se cuentan aparte, sin convertirlos.",
                            style = MaterialTheme.typography.labelSmall,
                            color = AlDiaColors.TextTertiary,
                        )
                    }
                    Spacer(Modifier.height(10.dp))
                    AlDiaField(
                        label = "Fondo inicial",
                        value = openingFloat,
                        onValueChange = { openingFloat = it },
                        placeholder = "0",
                        keyboardType = KeyboardType.Decimal,
                        supporting = "Opcional: el cambio que quedó en la gaveta.",
                    )
                    Spacer(Modifier.height(10.dp))
                    AlDiaField(
                        label = "Nota",
                        value = note,
                        onValueChange = { note = it.take(200) },
                        placeholder = "Ej: faltó un billete de 100",
                    )
                    Spacer(Modifier.height(14.dp))
                    PrimaryButton(
                        if (state.busy) "Cerrando…" else "Cerrar caja",
                        onClick = {
                            viewModel.closePeriod(session, counted, countedUsd, countedEur, openingFloat, note)
                        },
                        enabled = counted.isNotBlank() && !state.busy,
                        loading = state.busy,
                    )
                }
            }
            Spacer(Modifier.height(10.dp))
        }

        if (state.pendingWithdrawals.isNotEmpty() && isOwner) {
            AlDiaCard(Modifier.fillMaxWidth()) {
                Column {
                    SectionTitle("Salidas por subir")
                    Spacer(Modifier.height(6.dp))
                    state.pendingWithdrawals.forEach {
                        KeyValueRow("${money(it.amount)} · ${it.note ?: "Sin nota"}", Format.dateTime(it.queuedAt))
                    }
                }
            }
            Spacer(Modifier.height(10.dp))
        }

        if (isOwner && state.summary.isNotEmpty()) {
            SectionTitle("Resumen por caja")
            Spacer(Modifier.height(8.dp))
            AlDiaCard(Modifier.fillMaxWidth()) {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    state.summary.forEachIndexed { index, row ->
                        if (index > 0) HorizontalDivider(color = AlDiaColors.BorderSoft)
                        SummaryRow(row)
                    }
                }
            }
            Spacer(Modifier.height(10.dp))
        }

        SectionTitle("Historial de cierres")
        Spacer(Modifier.height(8.dp))
        if (state.closes.isEmpty()) {
            EmptyBlock("Todavía no hay cierres", "Cuando cierres la caja aparecerá aquí.")
        } else {
            state.closes.forEach { close ->
                CloseRow(close, isOwner) { viewModel.openDetail(session, close.id) }
                Spacer(Modifier.height(8.dp))
            }
        }
        Spacer(Modifier.height(24.dp))
    }

    if (withdrawalOpen) {
        WithdrawalSheet(
            busy = state.busy,
            onDismiss = { withdrawalOpen = false },
            onSubmit = { amount, reason ->
                viewModel.withdraw(session, amount, reason)
                withdrawalOpen = false
            },
        )
    }

    state.lastClose?.let { close ->
        ModalBottomSheet(
            onDismissRequest = viewModel::dismiss,
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            containerColor = AlDiaColors.Surface,
        ) {
            CloseResultSheet(close, onDone = viewModel::dismiss)
        }
    }

    state.detail?.let { close ->
        ModalBottomSheet(
            onDismissRequest = viewModel::dismiss,
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            containerColor = AlDiaColors.Surface,
        ) {
            CloseDetailSheet(close, loading = state.detailLoading, onDone = viewModel::dismiss)
        }
    }

    confirmVoid?.let { withdrawal ->
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { confirmVoid = null },
            title = { Text("Anular salida") },
            text = { Text("Se anulará la salida de ${money(withdrawal.amount)}${withdrawal.note?.let { " ($it)" } ?: ""}. El dinero volverá a contar en la caja.") },
            confirmButton = {
                TextButton(onClick = {
                    viewModel.voidWithdrawal(session, withdrawal.clientWithdrawalId)
                    confirmVoid = null
                }) { Text("Anular", color = AlDiaColors.Danger) }
            },
            dismissButton = {
                TextButton(onClick = { confirmVoid = null }) { Text("Cancelar") }
            },
        )
    }
}

@Composable
private fun PeriodCard(openedAt: String?, isFirstClose: Boolean) {
    AlDiaCard(Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier.size(38.dp).clip(CircleShape).background(AlDiaColors.BlueSoft),
                contentAlignment = Alignment.Center,
            ) {
                Text("C", style = MaterialTheme.typography.titleMedium, color = AlDiaColors.Blue, fontWeight = FontWeight.Bold)
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    if (isFirstClose) "Primer cierre" else "Período abierto",
                    style = MaterialTheme.typography.titleSmall,
                    color = AlDiaColors.TextPrimary,
                )
                Text(
                    if (openedAt == null) "Sin movimientos todavía" else "Desde ${Format.dateTime(openedAt)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = AlDiaColors.TextSecondary,
                )
            }
            Pill("Abierta", AlDiaColors.Success, AlDiaColors.SuccessSoft)
        }
    }
}

@Composable
private fun WithdrawalsCard(
    open: List<WithdrawalDto>,
    pending: List<cu.mypimes.pos.data.store.PendingWithdrawal>,
    busy: Boolean,
    onAdd: () -> Unit,
    onVoid: (WithdrawalDto) -> Unit,
) {
    AlDiaCard(Modifier.fillMaxWidth()) {
        Column {
            Text("Dinero que sacaste de la caja", style = MaterialTheme.typography.titleSmall, color = AlDiaColors.TextPrimary)
            Text(
                "Anota los pagos o retiros antes de cerrar para que no salgan como faltante.",
                style = MaterialTheme.typography.bodySmall,
                color = AlDiaColors.TextSecondary,
            )
            Spacer(Modifier.height(8.dp))
            open.forEach { withdrawal ->
                Row(Modifier.fillMaxWidth().padding(vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(money(withdrawal.amount), style = MaterialTheme.typography.titleSmall, color = AlDiaColors.TextPrimary)
                        Text(
                            withdrawal.note ?: "Sin motivo",
                            style = MaterialTheme.typography.bodySmall,
                            color = AlDiaColors.TextSecondary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(Format.dateTime(withdrawal.createdAt), style = MaterialTheme.typography.labelSmall, color = AlDiaColors.TextTertiary)
                    }
                    TextButton(onClick = { onVoid(withdrawal) }, enabled = !busy) {
                        Text("Anular", color = AlDiaColors.Danger, style = MaterialTheme.typography.labelMedium)
                    }
                }
            }
            pending.forEach { item ->
                Row(Modifier.fillMaxWidth().padding(vertical = 5.dp)) {
                    Text(money(item.amount), style = MaterialTheme.typography.bodyMedium, color = AlDiaColors.TextSecondary)
                    Spacer(Modifier.width(8.dp))
                    Text(item.note ?: "", style = MaterialTheme.typography.bodySmall, color = AlDiaColors.TextTertiary, modifier = Modifier.weight(1f))
                    Pill("Por subir", AlDiaColors.Warning, AlDiaColors.WarningSoft)
                }
            }
            if (open.isNotEmpty() || pending.isNotEmpty()) {
                HorizontalDivider(color = AlDiaColors.BorderSoft)
                Spacer(Modifier.height(8.dp))
                KeyValueRow(
                    "Salidas anotadas",
                    money(open.sumOf { it.amount } + pending.sumOf { it.amount }),
                    bold = true,
                )
            }
            Spacer(Modifier.height(6.dp))
            Surface(
                onClick = onAdd,
                shape = RoundedCornerShape(12.dp),
                color = AlDiaColors.BlueSoft,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Row(Modifier.padding(vertical = 11.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Default.Add, contentDescription = null, tint = AlDiaColors.Blue, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("Anotar salida de efectivo", style = MaterialTheme.typography.labelLarge, color = AlDiaColors.Blue)
                }
            }
        }
    }
}

@Composable
private fun SummaryRow(row: CashCloseSummaryDto) {
    Column {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(
                    row.registerName ?: row.accountEmail ?: row.registerId ?: "Caja",
                    style = MaterialTheme.typography.titleSmall,
                    color = AlDiaColors.TextPrimary,
                )
                Text(
                    "${row.closes} cierre(s) · ${Format.dateTime(row.lastCloseAt)}",
                    style = MaterialTheme.typography.labelSmall,
                    color = AlDiaColors.TextTertiary,
                )
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(money(row.totalDifference), style = MaterialTheme.typography.titleSmall, color = diffColor(row.totalDifference))
                if (row.timesShort > 0) {
                    Text("${row.timesShort} corto(s)", style = MaterialTheme.typography.labelSmall, color = AlDiaColors.Danger)
                }
            }
        }
    }
}

@Composable
private fun CloseRow(close: CashCloseDto, isOwner: Boolean, onClick: () -> Unit) {
    Surface(onClick = onClick, shape = RoundedCornerShape(18.dp), color = Color.White) {
        Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(Format.dayLabel(close.closedAt), style = MaterialTheme.typography.titleSmall, color = AlDiaColors.TextPrimary)
                Text(
                    "${close.salesCount} venta(s) · ${if (isOwner) (close.accountEmail ?: "Dueño") else "Tu cierre"}${if (close.correctionRevision > 0) " · corregido" else ""}",
                    style = MaterialTheme.typography.bodySmall,
                    color = AlDiaColors.TextSecondary,
                )
                Text(
                    "Esperado ${money(close.expectedCash)} · contado ${money(close.countedCash)}",
                    style = MaterialTheme.typography.labelSmall,
                    color = AlDiaColors.TextTertiary,
                )
            }
            Column(horizontalAlignment = Alignment.End) {
                Pill(
                    Format.signedMoney(close.cashDifference),
                    diffColor(close.cashDifference),
                    diffColor(close.cashDifference).copy(alpha = 0.12f),
                )
                Text(Format.time(close.closedAt), style = MaterialTheme.typography.labelSmall, color = AlDiaColors.TextTertiary)
            }
            Icon(Icons.Default.ChevronRight, contentDescription = null, tint = AlDiaColors.TextTertiary, modifier = Modifier.size(18.dp))
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun WithdrawalSheet(busy: Boolean, onDismiss: () -> Unit, onSubmit: (String, String) -> Unit) {
    var amount by rememberSaveable { mutableStateOf("") }
    var reason by rememberSaveable { mutableStateOf("") }
    var localError by remember { mutableStateOf<String?>(null) }
    val valid = amount.trim().toDoubleOrNull()?.let { it > 0 } == true && reason.trim().length >= 3
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = AlDiaColors.Surface,
    ) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 24.dp).imePadding()) {
            Text("Anotar salida", style = MaterialTheme.typography.headlineSmall, color = AlDiaColors.TextPrimary)
            Text(
                "Registra el dinero que sacaste para que el cierre no lo marque como faltante.",
                style = MaterialTheme.typography.bodySmall,
                color = AlDiaColors.TextSecondary,
            )
            Spacer(Modifier.height(14.dp))
            AlDiaField(
                label = "Cuánto sacas",
                value = amount,
                onValueChange = { amount = it; localError = null },
                placeholder = "0",
                keyboardType = KeyboardType.Decimal,
                big = true,
            )
            Spacer(Modifier.height(10.dp))
            AlDiaField(
                label = "Motivo *",
                value = reason,
                onValueChange = { reason = it.take(200); localError = null },
                placeholder = "Ej: pagué al proveedor del café",
                supporting = "Mínimo 3 caracteres",
            )
            if (localError != null) {
                Spacer(Modifier.height(8.dp))
                ErrorBanner(localError!!)
            }
            Spacer(Modifier.height(14.dp))
            PrimaryButton(
                if (busy) "Guardando…" else "Anotar salida",
                onClick = {
                    if (valid) onSubmit(amount, reason) else localError = "Completa el monto y el motivo"
                },
                enabled = valid && !busy,
                loading = busy,
            )
            TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) {
                Text("Cancelar", color = AlDiaColors.TextSecondary)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CloseResultSheet(close: CashCloseDto, onDone: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 22.dp).padding(bottom = 26.dp)) {
        Text("Caja cerrada", style = MaterialTheme.typography.headlineSmall, color = AlDiaColors.TextPrimary)
        Text(
            Format.dateTime(close.closedAt ?: close.openedAt),
            style = MaterialTheme.typography.bodySmall,
            color = AlDiaColors.TextSecondary,
        )
        Spacer(Modifier.height(14.dp))
        AlDiaCard(Modifier.fillMaxWidth()) {
            Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                KeyValueRow("Fondo inicial", money(close.openingFloat))
                KeyValueRow("Efectivo esperado", money(close.expectedCash))
                KeyValueRow("Efectivo contado", money(close.countedCash), bold = true)
                KeyValueRow("Diferencia", Format.signedMoney(close.cashDifference), valueColor = diffColor(close.cashDifference), bold = true)
                if ((close.expectedUsd ?: 0.0) != 0.0 || (close.countedUsd ?: 0.0) != 0.0) {
                    HorizontalDivider(color = AlDiaColors.BorderSoft)
                    KeyValueRow("USD esperado / contado", "${Format.foreign(close.expectedUsd ?: 0.0)} / ${Format.foreign(close.countedUsd ?: 0.0)}")
                }
                if ((close.expectedEur ?: 0.0) != 0.0 || (close.countedEur ?: 0.0) != 0.0) {
                    KeyValueRow("EUR esperado / contado", "${Format.foreign(close.expectedEur ?: 0.0)} / ${Format.foreign(close.countedEur ?: 0.0)}")
                }
                if ((close.withdrawnCash) != 0.0) {
                    KeyValueRow("Salidas de efectivo", money(close.withdrawnCash), valueColor = AlDiaColors.TextSecondary)
                }
            }
        }
        Spacer(Modifier.height(14.dp))
        PrimaryButton("Entendido", onDone)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CloseDetailSheet(close: CashCloseDto, loading: Boolean, onDone: () -> Unit) {
    Column(Modifier.fillMaxWidth().heightIn(max = 560.dp).verticalScroll(rememberScrollState()).padding(horizontal = 22.dp).padding(bottom = 26.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Detalle del cierre", style = MaterialTheme.typography.headlineSmall, color = AlDiaColors.TextPrimary, modifier = Modifier.weight(1f))
            if (loading) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = AlDiaColors.Blue)
        }
        Text(Format.dateTime(close.closedAt), style = MaterialTheme.typography.bodySmall, color = AlDiaColors.TextSecondary)
        Spacer(Modifier.height(14.dp))
        AlDiaCard(Modifier.fillMaxWidth()) {
            Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                KeyValueRow("Ventas", close.salesCount.toString())
                KeyValueRow("Fondo inicial", money(close.openingFloat))
                KeyValueRow("Efectivo esperado", money(close.expectedCash))
                KeyValueRow("Efectivo contado", money(close.countedCash))
                KeyValueRow("Diferencia", Format.signedMoney(close.cashDifference), valueColor = diffColor(close.cashDifference), bold = true)
                KeyValueRow("Transferencias", money(close.expectedTransfer))
                if ((close.expectedUsd ?: 0.0) != 0.0 || (close.countedUsd ?: 0.0) != 0.0) {
                    HorizontalDivider(color = AlDiaColors.BorderSoft)
                    KeyValueRow("USD esperado", Format.foreign(close.expectedUsd ?: 0.0))
                    KeyValueRow("USD contado", Format.foreign(close.countedUsd ?: 0.0))
                    KeyValueRow("Diferencia USD", Format.foreign(close.usdDifference), valueColor = diffColor(close.usdDifference))
                }
                if ((close.expectedEur ?: 0.0) != 0.0 || (close.countedEur ?: 0.0) != 0.0) {
                    HorizontalDivider(color = AlDiaColors.BorderSoft)
                    KeyValueRow("EUR esperado", Format.foreign(close.expectedEur ?: 0.0))
                    KeyValueRow("EUR contado", Format.foreign(close.countedEur ?: 0.0))
                    KeyValueRow("Diferencia EUR", Format.foreign(close.eurDifference), valueColor = diffColor(close.eurDifference))
                }
                if ((close.withdrawnCash) != 0.0) {
                    HorizontalDivider(color = AlDiaColors.BorderSoft)
                    KeyValueRow("Salidas de efectivo", money(close.withdrawnCash))
                }
                if (!close.note.isNullOrBlank()) {
                    HorizontalDivider(color = AlDiaColors.BorderSoft)
                    Text(close.note!!, style = MaterialTheme.typography.bodySmall, color = AlDiaColors.TextSecondary)
                }
                if (close.replay) {
                    Text("Este cierre se reconoció como reintento.", style = MaterialTheme.typography.labelSmall, color = AlDiaColors.TextTertiary)
                }
            }
        }
        close.inventoryCheck?.let { check ->
            Spacer(Modifier.height(14.dp))
            InventoryCrossCheckCard(check.toDomain())
        }
        Spacer(Modifier.height(14.dp))
        PrimaryButton("Cerrar", onDone)
    }
}

/** Cruce con el último arqueo. Solo llega al dueño; el veredicto y las cifras las calcula el servidor. */
@Composable
private fun InventoryCrossCheckCard(check: InventoryCheck) {
    val (fg, bg) = when (checkTone(check.verdict)) {
        CheckTone.OK -> AlDiaColors.Success to AlDiaColors.SuccessSoft
        CheckTone.ALERT -> AlDiaColors.Danger to AlDiaColors.DangerSoft
        CheckTone.WARNING -> AlDiaColors.Warning to AlDiaColors.WarningSoft
        CheckTone.NEUTRAL -> AlDiaColors.TextSecondary to AlDiaColors.SurfaceMuted
    }
    AlDiaCard(Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
            SectionTitle("Cruce con el último arqueo")
            Surface(color = bg, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
                Text(check.message, style = MaterialTheme.typography.bodyMedium, color = fg, modifier = Modifier.padding(12.dp))
            }
            crossCheckRows(check).forEach { row ->
                KeyValueRow(row.label, row.value, valueColor = when (row.tone) {
                    RowTone.RED -> AlDiaColors.Danger
                    RowTone.ORANGE, RowTone.AMBER -> AlDiaColors.Warning
                    RowTone.GREEN -> AlDiaColors.Success
                    RowTone.DEFAULT -> AlDiaColors.TextPrimary
                })
            }
        }
    }
}
