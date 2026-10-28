package cu.mypimes.pos.ui.store

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Refresh
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.ui.platform.LocalContext
import cu.mypimes.pos.data.store.MonthDayDto
import cu.mypimes.pos.data.store.MonthDaysDto
import cu.mypimes.pos.domain.accounting.Accounting
import java.time.LocalDate
import java.time.YearMonth
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cu.mypimes.pos.data.auth.Session
import cu.mypimes.pos.data.pos.SaleDto
import cu.mypimes.pos.data.store.SaleCorrectionDto
import cu.mypimes.pos.domain.Format
import cu.mypimes.pos.domain.Payment
import cu.mypimes.pos.domain.sales.DaySales
import cu.mypimes.pos.domain.sales.SaleCorrections
import cu.mypimes.pos.ui.components.AlDiaCard
import cu.mypimes.pos.ui.components.LocalRequireOwnerPin
import cu.mypimes.pos.ui.components.AlDiaField
import cu.mypimes.pos.ui.components.EmptyBlock
import cu.mypimes.pos.ui.components.ErrorBanner
import cu.mypimes.pos.ui.components.InfoBanner
import cu.mypimes.pos.ui.components.StaleNote
import cu.mypimes.pos.ui.components.KeyValueRow
import cu.mypimes.pos.ui.components.LoadingBlock
import cu.mypimes.pos.ui.components.Pill
import cu.mypimes.pos.ui.components.PrimaryButton
import cu.mypimes.pos.ui.components.SectionTitle
import cu.mypimes.pos.ui.theme.AlDiaColors

/** Ventas del dueño por día, con filtro por cajero y corrección de cobro o anulación (web: `Sales.jsx`). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SalesScreen(session: Session, viewModel: SalesViewModel, onBack: () -> Unit) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    LaunchedEffect(session.token) { viewModel.load(session, null) }
    val context = LocalContext.current
    val saveExcel = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(XLSX_MIME)) { uri ->
        uri?.let { viewModel.saveExcel(session, it, context.contentResolver) }
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
        Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Volver") }
            Text("Ventas", style = MaterialTheme.typography.headlineSmall, color = AlDiaColors.TextPrimary, modifier = Modifier.weight(1f))
            IconButton(onClick = { if (state.monthMode) viewModel.showMonth(session) else viewModel.load(session) }, enabled = !state.loading) {
                if (state.loading) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = AlDiaColors.Blue)
                else Icon(Icons.Default.Refresh, contentDescription = "Actualizar", tint = AlDiaColors.TextSecondary)
            }
        }
        Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(selected = !state.monthMode, onClick = { if (state.monthMode) viewModel.load(session, state.date) }, label = { Text("Día") })
            FilterChip(selected = state.monthMode, onClick = { if (!state.monthMode) viewModel.showMonth(session) }, label = { Text("Mes") })
        }
        val day = state.day.takeUnless { state.monthMode }
        if (day != null) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { viewModel.load(session, day.prev) }, enabled = day.prev != null && !state.loading) {
                    Icon(Icons.Default.ChevronLeft, contentDescription = "Día anterior")
                }
                Text(
                    day.dayLabel.replaceFirstChar { it.uppercase() },
                    style = MaterialTheme.typography.titleMedium, color = AlDiaColors.TextPrimary,
                    modifier = Modifier.weight(1f), textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                )
                IconButton(onClick = { viewModel.load(session, day.next) }, enabled = day.next != null && !state.loading) {
                    Icon(Icons.Default.ChevronRight, contentDescription = "Día siguiente")
                }
            }
        }
        if (session.user.isOwner) { OwnerQueueBanner(session); Spacer(Modifier.height(10.dp)) }
        state.notice?.let {
            InfoBanner(it, tone = AlDiaColors.Success)
            TextButton(onClick = viewModel::dismissNotice) { Text("Entendido") }
        }
        StaleNote(state.staleSince, extra = "Sin conexión: solo hay los últimos 90 días y las anuladas no se listan.")
        state.error?.let { ErrorBanner(it); Spacer(Modifier.height(10.dp)) }

        if (state.monthMode) {
            MonthPanel(session, state, viewModel, onExcel = { saveExcel.launch("ventas-${state.month}.xlsx") })
        } else if (day == null) {
            if (state.loading) LoadingBlock()
        } else {
            val shown = DaySales.filter(day.sales, state.cashier)
            DaySummary(shown)
            val cashiers = DaySales.byCashier(day.sales)
            if (cashiers.size > 1) {
                Spacer(Modifier.height(10.dp))
                SectionTitle("Por cajero")
                Spacer(Modifier.height(6.dp))
                FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(selected = state.cashier == null, onClick = { viewModel.filterBy(null) }, label = { Text("Todos") })
                    cashiers.forEach { row ->
                        FilterChip(
                            selected = state.cashier?.email == row.email,
                            onClick = { viewModel.filterBy(row) },
                            label = { Text("${DaySales.accountLabel(row.email) ?: "Sin cajero"} · ${row.count} · ${Format.money(row.total)}") },
                        )
                    }
                }
            }
            Spacer(Modifier.height(10.dp))
            if (shown.isEmpty()) EmptyBlock("Sin ventas ese día")
            else AlDiaCard(Modifier.fillMaxWidth()) {
                Column {
                    shown.forEachIndexed { index, sale ->
                        if (index > 0) HorizontalDivider(color = AlDiaColors.BorderSoft)
                        SaleRow(sale) { viewModel.select(session, sale) }
                    }
                }
            }
            if (state.voided.isNotEmpty()) {
                Spacer(Modifier.height(14.dp))
                SectionTitle(if (state.voided.size == 1) "Venta anulada" else "Ventas anuladas")
                Spacer(Modifier.height(6.dp))
                AlDiaCard(Modifier.fillMaxWidth()) {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        state.voided.forEach { CorrectionLine(it, showSale = true) }
                    }
                }
            }
        }
        Spacer(Modifier.height(24.dp))
    }

    state.selected?.let { sale ->
        SaleSheet(session, sale, viewModel, state)
    }
}

@Composable
private fun DaySummary(sales: List<SaleDto>) {
    val split = DaySales.split(sales)
    AlDiaCard(Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                "${sales.size} ${if (sales.size == 1) "venta" else "ventas"} · ${Format.money(DaySales.total(sales), 2)}",
                style = MaterialTheme.typography.titleMedium, color = AlDiaColors.TextPrimary,
            )
            KeyValueRow("Efectivo", Format.money(split.cash, 2), valueColor = AlDiaColors.Cash)
            KeyValueRow("Transferencia", Format.money(split.transfer, 2), valueColor = AlDiaColors.Transfer)
            if (split.usd > 0) KeyValueRow("Dólares", "${Format.foreign(split.usd)} USD", valueColor = AlDiaColors.Foreign)
            if (split.eur > 0) KeyValueRow("Euros", "${Format.foreign(split.eur)} EUR", valueColor = AlDiaColors.Euro)
            val profit = sales.sumOf { it.profit ?: 0.0 }
            KeyValueRow("Ganancia estimada", Format.money(profit), valueColor = AlDiaColors.Success)
        }
    }
}

@Composable
private fun SaleRow(sale: SaleDto, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text("Venta #${sale.id}", style = MaterialTheme.typography.titleSmall, color = AlDiaColors.TextPrimary)
            Text(
                Format.time(sale.createdAt) + (DaySales.accountLabel(sale.accountEmail)?.let { " · $it" } ?: ""),
                style = MaterialTheme.typography.labelSmall, color = AlDiaColors.TextTertiary,
            )
        }
        Pill(Payment.paymentLabel(sale.paymentMethod, sale.foreignCurrency), AlDiaColors.TextSecondary, AlDiaColors.SurfaceMuted)
        Text(
            Format.money(sale.total, 2), style = MaterialTheme.typography.titleSmall, color = AlDiaColors.TextPrimary,
            modifier = Modifier.padding(start = 10.dp),
        )
    }
}

@Composable
private fun CorrectionLine(c: SaleCorrectionDto, showSale: Boolean = false) {
    val what = if (c.action == "anular") {
        (if (showSale) "Venta de ${Format.money(c.before?.total ?: 0.0)} (${Format.time(c.before?.createdAt)}) " else "Venta ") + "anulada"
    } else {
        (if (showSale) "Venta de ${Format.money(c.before?.total ?: 0.0)}: " else "") +
            "${Payment.paymentLabel(c.before?.paymentMethod, c.before?.foreignCurrency)} → " +
            Payment.paymentLabel(c.after?.paymentMethod, c.after?.foreignCurrency)
    }
    Column {
        Text(what, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = AlDiaColors.TextPrimary)
        Text(
            "${DaySales.accountLabel(c.accountEmail) ?: "cuenta principal"} · ${Format.dateTime(c.createdAt)}",
            style = MaterialTheme.typography.labelSmall, color = AlDiaColors.TextTertiary,
        )
        c.reason?.let { Text("«$it»", style = MaterialTheme.typography.labelSmall, color = AlDiaColors.TextSecondary) }
        if (c.closeBefore != null && c.closeAfter != null) {
            Text(
                "Cierre de caja: ${SaleCorrections.closeResult(c.closeBefore.difference) { Format.money(it) }} → " +
                    SaleCorrections.closeResult(c.closeAfter.difference) { Format.money(it) },
                style = MaterialTheme.typography.labelSmall, color = AlDiaColors.TextSecondary,
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SaleSheet(session: Session, sale: SaleDto, viewModel: SalesViewModel, state: SalesUiState) {
    val requireOwnerPin = LocalRequireOwnerPin.current
    var mode by remember(sale.id) { mutableStateOf<String?>(null) } // null | "pago" | "anular"
    var choice by remember(sale.id) { mutableStateOf(SaleCorrections.Choice()) }
    var reason by remember(sale.id) { mutableStateOf("") }
    var localError by remember(sale.id) { mutableStateOf<String?>(null) }
    val shopRate = { code: String -> session.user.shopRate(code) }
    val units = sale.items.sumOf { it.quantity }

    ModalBottomSheet(onDismissRequest = { if (!state.busy) viewModel.select(session, null) }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = AlDiaColors.Background) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(bottom = 26.dp).imePadding(),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text("Venta #${sale.id}", style = MaterialTheme.typography.headlineSmall, color = AlDiaColors.TextPrimary)
            Text(
                Format.dateTime(sale.createdAt) + (DaySales.accountLabel(sale.accountEmail)?.let { " · $it" } ?: ""),
                style = MaterialTheme.typography.bodySmall, color = AlDiaColors.TextSecondary,
            )
            Text(Format.money(sale.total, 2), style = MaterialTheme.typography.headlineLarge, color = AlDiaColors.TextPrimary)
            AlDiaCard(Modifier.fillMaxWidth()) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    sale.items.forEach { item ->
                        KeyValueRow("${item.productName ?: "Producto"} × ${Format.quantity(item.quantity)}", Format.money(item.quantity * item.unitPrice, 2))
                    }
                    HorizontalDivider(color = AlDiaColors.BorderSoft)
                    KeyValueRow("Cobro", Payment.paymentLabel(sale.paymentMethod, sale.foreignCurrency))
                    if (sale.paymentMethod == "mixto") KeyValueRow("Transferencia", Format.money(sale.transferAmount ?: 0.0, 2))
                    if (sale.paymentMethod == "divisa") {
                        KeyValueRow("Divisa", "${Format.foreign(sale.foreignAmount ?: 0.0)} ${sale.foreignCurrency ?: ""}")
                        KeyValueRow("Tasa", Format.rate(sale.exchangeRate))
                    }
                    sale.profit?.let { KeyValueRow("Ganancia estimada", Format.money(it), valueColor = AlDiaColors.Success) }
                    if (sale.cashCloseId != null) KeyValueRow("Cierre de caja", "#${sale.cashCloseId}")
                }
            }
            if (state.history.isNotEmpty()) {
                SectionTitle("Correcciones")
                AlDiaCard(Modifier.fillMaxWidth()) {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) { state.history.forEach { CorrectionLine(it) } }
                }
            }

            when (mode) {
                null -> Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    PrimaryButton("Cambiar cobro", {
                        choice = SaleCorrections.initialChoice(sale, shopRate); reason = ""; localError = null; mode = "pago"
                    }, Modifier.weight(1f), height = 46)
                    PrimaryButton("Anular venta", { reason = ""; localError = null; mode = "anular" }, Modifier.weight(1f), color = AlDiaColors.Danger, height = 46)
                }
                "pago" -> {
                    SectionTitle("Nueva forma de cobro")
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        SaleCorrections.methods.forEach { (value, label) ->
                            FilterChip(selected = choice.method == value, onClick = { choice = choice.copy(method = value) }, label = { Text(label) })
                        }
                    }
                    if (choice.method == "mixto") {
                        AlDiaField(
                            "Cuánto fue por transferencia", choice.transfer, { choice = choice.copy(transfer = it) },
                            keyboardType = KeyboardType.Decimal, supporting = "El resto, hasta ${Format.money(sale.total, 2)}, en efectivo.",
                        )
                    }
                    if (choice.method == "divisa") {
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Payment.currencies.forEach { code ->
                                FilterChip(
                                    selected = choice.currency == code,
                                    onClick = { choice = SaleCorrections.withCurrency(choice, sale.total, code, shopRate(code)) },
                                    label = { Text(code) },
                                )
                            }
                        }
                        AlDiaField("Billetes", choice.amount, { choice = choice.copy(amount = it) }, keyboardType = KeyboardType.Decimal)
                        AlDiaField("Tasa", choice.rate, { choice = choice.copy(rate = it) }, keyboardType = KeyboardType.Decimal)
                        val amount = choice.amount.replace(',', '.').toDoubleOrNull() ?: 0.0
                        val rate = choice.rate.replace(',', '.').toDoubleOrNull() ?: 0.0
                        if (amount > 0 && rate > 0) {
                            val b = Payment.foreignBreakdown(sale.total, amount, rate)
                            Text(
                                "${Format.foreign(amount)} ${choice.currency} = ${Format.money(b.foreignCup, 2)}" +
                                    (if (Math.round(b.cashToCollect) > 0) " · el cliente completó ${Format.money(b.cashToCollect, 2)} en efectivo" else "") +
                                    (if (Math.round(b.change) > 0) " · vuelto ${Format.money(b.change, 2)}" else ""),
                                style = MaterialTheme.typography.bodySmall, color = AlDiaColors.TextSecondary,
                            )
                        }
                    }
                }
                else -> InfoBanner(
                    "¿Anular la venta de ${Format.money(sale.total, 2)}? Desaparece del historial" +
                        (if (units > 0) " y vuelven ${Format.quantity(units)} unidades al stock" else "") +
                        ". Si ya estaba en un cierre de caja, ese cierre se recalcula. Queda anotado quién la anuló.",
                    tone = AlDiaColors.Danger,
                )
            }
            if (mode != null) {
                AlDiaField("Motivo (opcional)", reason, { reason = it.take(200) })
                (localError ?: state.formError)?.let { ErrorBanner(it) }
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    TextButton(onClick = { mode = null; localError = null }, enabled = !state.busy, modifier = Modifier.weight(1f)) { Text("Cancelar") }
                    PrimaryButton(
                        if (mode == "anular") "Sí, anular" else "Guardar",
                        {
                            if (mode == "anular") requireOwnerPin { viewModel.correct(session, sale, SaleCorrections.voidRequest(reason)) }
                            else {
                                val built = SaleCorrections.paymentRequest(sale, choice, reason)
                                localError = built.error
                                built.request?.let { requireOwnerPin { viewModel.correct(session, sale, it) } }
                            }
                        },
                        Modifier.weight(1f), loading = state.busy, color = if (mode == "anular") AlDiaColors.Danger else AlDiaColors.Blue, height = 46,
                    )
                }
            }
        }
    }
}

/** Vista por mes: navegación, resumen, Excel del servidor y la lista de días (tocar uno abre ese día). */
@Composable
private fun MonthPanel(session: Session, state: SalesUiState, viewModel: SalesViewModel, onExcel: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = { viewModel.showMonth(session, Accounting.shiftMonth(state.month, -1)) }, enabled = !state.loading) {
            Icon(Icons.Default.ChevronLeft, contentDescription = "Mes anterior")
        }
        Text(
            monthTitle(state.month),
            style = MaterialTheme.typography.titleMedium, color = AlDiaColors.TextPrimary,
            modifier = Modifier.weight(1f), textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
        IconButton(
            onClick = { viewModel.showMonth(session, Accounting.shiftMonth(state.month, 1)) },
            enabled = !state.loading && Accounting.canGoNext(state.month, YearMonth.now(Format.cubaZone)),
        ) { Icon(Icons.Default.ChevronRight, contentDescription = "Mes siguiente") }
    }
    if (state.loading) { LoadingBlock(); return }
    val data = state.monthData ?: return
    MonthSummary(data)
    Spacer(Modifier.height(10.dp))
    PrimaryButton(
        text = if (state.exporting) "Generando Excel…" else "Descargar Excel del mes",
        onClick = onExcel,
        enabled = !state.exporting,
        loading = state.exporting,
        color = AlDiaColors.Success,
    )
    Spacer(Modifier.height(10.dp))
    if (data.days.isEmpty()) EmptyBlock("Sin ventas en ${monthTitle(state.month)}")
    else AlDiaCard(Modifier.fillMaxWidth()) {
        Column {
            data.days.forEachIndexed { index, day ->
                if (index > 0) HorizontalDivider(color = AlDiaColors.BorderSoft)
                MonthDayRow(day) { viewModel.load(session, day.date) }
            }
        }
    }
}

@Composable
private fun MonthSummary(data: MonthDaysDto) {
    val totals = data.totals
    AlDiaCard(Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                "Total del mes · ${totals.salesCount} ${if (totals.salesCount == 1) "venta" else "ventas"}",
                style = MaterialTheme.typography.labelSmall, color = AlDiaColors.TextTertiary,
            )
            Text(Format.money(totals.total), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, color = AlDiaColors.TextPrimary)
            Text(
                "Efectivo ${Format.money(totals.cashTotal)} · Transf. ${Format.money(totals.transferTotal)}" +
                    if (totals.foreignTotal != 0.0) " · Divisa ${Format.money(totals.foreignTotal)}" else "",
                style = MaterialTheme.typography.bodySmall, color = AlDiaColors.TextSecondary,
            )
            Text("Ganancia ${Format.money(totals.profit)}", style = MaterialTheme.typography.bodySmall, color = AlDiaColors.Success)
        }
    }
}

@Composable
private fun MonthDayRow(day: MonthDayDto, onOpen: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onOpen).padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(Format.dayLabel(LocalDate.parse(day.date)), style = MaterialTheme.typography.titleSmall, color = AlDiaColors.TextPrimary)
            Text(
                "${day.salesCount} ${if (day.salesCount == 1) "venta" else "ventas"} · ganancia ${Format.money(day.profit)}",
                style = MaterialTheme.typography.labelSmall, color = AlDiaColors.TextTertiary,
            )
        }
        Text(Format.money(day.total), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, color = AlDiaColors.TextPrimary)
    }
}
