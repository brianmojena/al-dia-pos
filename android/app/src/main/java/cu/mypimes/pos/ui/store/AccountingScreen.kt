package cu.mypimes.pos.ui.store

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cu.mypimes.pos.data.auth.Session
import cu.mypimes.pos.data.store.AccountingDayDto
import cu.mypimes.pos.data.store.AccountingTotalsDto
import cu.mypimes.pos.data.store.ExpenseDto
import cu.mypimes.pos.domain.Format
import cu.mypimes.pos.domain.accounting.Accounting
import cu.mypimes.pos.domain.sales.DaySales
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
import java.time.YearMonth
import java.time.format.DateTimeFormatter
import java.util.Locale

internal const val XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

/** Contabilidad del dueño (plan Enterprise): resumen del mes, gastos y Excel (web: `Contabilidad.jsx`). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AccountingScreen(session: Session, viewModel: AccountingViewModel, onBack: () -> Unit) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    LaunchedEffect(session.token) { viewModel.load(session) }
    val saveExcel = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(XLSX_MIME)) { uri ->
        uri?.let { viewModel.saveExcel(session, it, context.contentResolver) }
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
        Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Volver") }
            Text("Contabilidad", style = MaterialTheme.typography.headlineSmall, color = AlDiaColors.TextPrimary, modifier = Modifier.weight(1f))
            IconButton(onClick = { viewModel.load(session) }, enabled = !state.loading) {
                Icon(Icons.Default.Refresh, contentDescription = "Actualizar", tint = AlDiaColors.TextSecondary)
            }
        }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { viewModel.shift(session, -1) }, enabled = !state.loading) {
                Icon(Icons.Default.ChevronLeft, contentDescription = "Mes anterior")
            }
            Text(
                monthTitle(state.month), style = MaterialTheme.typography.titleMedium, color = AlDiaColors.TextPrimary,
                modifier = Modifier.weight(1f), textAlign = TextAlign.Center,
            )
            IconButton(onClick = { viewModel.shift(session, 1) }, enabled = !state.loading && viewModel.canGoNext()) {
                Icon(Icons.Default.ChevronRight, contentDescription = "Mes siguiente")
            }
        }
        state.notice?.let {
            InfoBanner(it, tone = AlDiaColors.Success)
            TextButton(onClick = viewModel::dismissNotice) { Text("Entendido") }
        }
        state.error?.let { ErrorBanner(it); Spacer(Modifier.height(10.dp)) }

        val summary = state.summary
        if (summary == null) {
            if (state.loading) LoadingBlock()
        } else {
            SummaryCard(summary.totals)
            Spacer(Modifier.height(10.dp))
            PrimaryButton("Anotar gasto", onClick = viewModel::openForm, enabled = !state.busy)
            Spacer(Modifier.height(8.dp))
            OutlinedButton(
                onClick = { saveExcel.launch("contabilidad-${state.month}.xlsx") },
                enabled = !state.busy && !state.loading,
                modifier = Modifier.fillMaxWidth().height(48.dp),
            ) {
                Icon(Icons.Default.Download, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text("Descargar Excel")
            }
            Spacer(Modifier.height(10.dp))
            InfoBanner("Las extracciones de caja ya cuentan como gasto automáticamente. No hace falta anotarlas de nuevo.")

            Spacer(Modifier.height(14.dp))
            SectionTitle("Gastos del mes")
            Spacer(Modifier.height(6.dp))
            if (state.expenses.isEmpty()) {
                EmptyBlock("Sin gastos anotados este mes")
            } else {
                AlDiaCard(Modifier.fillMaxWidth()) {
                    Column {
                        state.expenses.forEachIndexed { index, expense ->
                            if (index > 0) HorizontalDivider(color = AlDiaColors.BorderSoft)
                            ExpenseRow(expense) { viewModel.askVoid(expense) }
                        }
                    }
                }
            }

            if (summary.days.isNotEmpty()) {
                Spacer(Modifier.height(14.dp))
                SectionTitle("Por día")
                Spacer(Modifier.height(6.dp))
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    summary.days.forEach { DayCard(it) }
                }
            }
        }
        Spacer(Modifier.height(24.dp))
    }

    if (state.formOpen) {
        var method by remember { mutableStateOf("efectivo") }
        var amount by remember { mutableStateOf("") }
        var concept by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { if (!state.busy) viewModel.closeForm() },
            title = { Text("Anotar gasto") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("Apartado", style = MaterialTheme.typography.labelMedium, color = AlDiaColors.TextSecondary)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Accounting.methods.forEach { option ->
                            FilterChip(
                                selected = method == option,
                                onClick = { method = option },
                                enabled = !state.busy,
                                label = { Text(Accounting.methodLabel(option)) },
                            )
                        }
                    }
                    AlDiaField("Monto", amount, { amount = it }, placeholder = "0", enabled = !state.busy, keyboardType = KeyboardType.Decimal)
                    AlDiaField("Concepto", concept, { concept = it }, placeholder = "Ej.: bolsas, cinta, luz", enabled = !state.busy)
                    state.formError?.let { ErrorBanner(it) }
                }
            },
            confirmButton = {
                PrimaryButton("Anotar gasto", { viewModel.addExpense(session, method, amount, concept) }, loading = state.busy, height = 44)
            },
            dismissButton = { TextButton(onClick = viewModel::closeForm, enabled = !state.busy) { Text("Cancelar") } },
        )
    }

    state.toVoid?.let { expense ->
        AlertDialog(
            onDismissRequest = { viewModel.askVoid(null) },
            title = { Text("Anular gasto") },
            text = { Text("¿Anular \"${expense.concept}\"? Queda en la lista como anulado y deja de contar en el resumen.") },
            confirmButton = { TextButton(onClick = { viewModel.voidExpense(session, expense) }) { Text("Anular") } },
            dismissButton = { TextButton(onClick = { viewModel.askVoid(null) }) { Text("Cancelar") } },
        )
    }
}

internal fun monthTitle(month: String): String =
    YearMonth.parse(month).format(DateTimeFormatter.ofPattern("MMMM yyyy", Locale.forLanguageTag("es-ES")))
        .replaceFirstChar { it.uppercase() }

@Composable
private fun SummaryCard(t: AccountingTotalsDto) {
    AlDiaCard(Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            KeyValueRow("Ingresos", Format.money(t.income), bold = true)
            if (t.incomeCash > 0) KeyValueRow("Efectivo", Format.money(t.incomeCash), valueColor = AlDiaColors.TextSecondary)
            if (t.incomeTransfer > 0) KeyValueRow("Transferencia", Format.money(t.incomeTransfer), valueColor = AlDiaColors.TextSecondary)
            if (t.incomeForeignCup > 0) KeyValueRow("Divisa", Format.money(t.incomeForeignCup), valueColor = AlDiaColors.TextSecondary)
            KeyValueRow("Ganancia de las ventas", Format.money(t.profit), valueColor = AlDiaColors.Success)
            KeyValueRow("Gastos", Format.money(t.expensesCup), valueColor = AlDiaColors.Warning)
            if (t.expensesUsd > 0 || t.expensesEur > 0) {
                Text(
                    listOfNotNull(
                        t.expensesUsd.takeIf { it > 0 }?.let { "${Format.foreign(it)} USD" },
                        t.expensesEur.takeIf { it > 0 }?.let { "${Format.foreign(it)} EUR" },
                    ).joinToString(" · "),
                    style = MaterialTheme.typography.labelSmall, color = AlDiaColors.TextTertiary,
                )
            }
            HorizontalDivider(color = AlDiaColors.BorderSoft)
            KeyValueRow(
                "Resultado", Format.money(t.resultCup), bold = true,
                valueColor = if (t.resultCup >= 0) AlDiaColors.Success else AlDiaColors.Danger,
            )
            Text("Ganancia de las ventas − gastos", style = MaterialTheme.typography.labelSmall, color = AlDiaColors.TextTertiary)
        }
    }
}

@Composable
private fun ExpenseRow(expense: ExpenseDto, onVoid: () -> Unit) {
    val voided = expense.voidedAt != null
    Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(
                expense.concept, style = MaterialTheme.typography.titleSmall,
                color = if (voided) AlDiaColors.TextTertiary else AlDiaColors.TextPrimary,
                textDecoration = if (voided) TextDecoration.LineThrough else null,
            )
            Text(
                Format.dateTime(expense.createdAt) + (DaySales.accountLabel(expense.accountEmail)?.let { " · $it" } ?: ""),
                style = MaterialTheme.typography.labelSmall, color = AlDiaColors.TextTertiary,
            )
        }
        if (voided) Pill("Anulado", AlDiaColors.TextSecondary, AlDiaColors.SurfaceMuted)
        Text(
            amountText(expense), style = MaterialTheme.typography.titleSmall, color = AlDiaColors.TextPrimary,
            modifier = Modifier.padding(horizontal = 8.dp),
        )
        if (!voided) {
            IconButton(onClick = onVoid) { Icon(Icons.Default.Delete, contentDescription = "Anular gasto", tint = AlDiaColors.Danger) }
        }
    }
}

private fun amountText(expense: ExpenseDto): String = when (expense.method) {
    "USD" -> "${Format.foreign(expense.amount)} USD"
    "EUR" -> "${Format.foreign(expense.amount)} EUR"
    else -> Format.money(expense.amount, 2)
}

@Composable
private fun DayCard(day: AccountingDayDto) {
    AlDiaCard(Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(Format.dayLabel(day.date), style = MaterialTheme.typography.titleSmall, color = AlDiaColors.TextPrimary)
            KeyValueRow("Ingresos", Format.money(day.income), valueColor = AlDiaColors.TextSecondary)
            KeyValueRow("Gastos", Format.money(day.expensesCup), valueColor = AlDiaColors.TextSecondary)
            KeyValueRow(
                "Resultado", Format.money(day.resultCup), bold = true,
                valueColor = if (day.resultCup >= 0) AlDiaColors.Success else AlDiaColors.Danger,
            )
        }
    }
}
