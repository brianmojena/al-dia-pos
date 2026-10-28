package cu.mypimes.pos.ui.store

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cu.mypimes.pos.data.auth.Session
import cu.mypimes.pos.data.local.QueuedOperationEntity
import cu.mypimes.pos.data.pos.ProductDto
import cu.mypimes.pos.data.store.DayStockRowDto
import cu.mypimes.pos.data.store.RejectedCount
import cu.mypimes.pos.data.store.InventoryCountDto
import cu.mypimes.pos.data.store.InventoryCountItemDto
import cu.mypimes.pos.domain.Format
import cu.mypimes.pos.domain.inventory.CountEntry
import cu.mypimes.pos.domain.inventory.CountedLine
import cu.mypimes.pos.domain.inventory.accountLabel
import cu.mypimes.pos.domain.products.stockLabel
import cu.mypimes.pos.ui.components.AlDiaCard
import cu.mypimes.pos.ui.components.LocalRequireOwnerPin
import cu.mypimes.pos.ui.components.AlDiaField
import cu.mypimes.pos.ui.components.EmptyBlock
import cu.mypimes.pos.ui.components.ErrorBanner
import cu.mypimes.pos.ui.components.InfoBanner
import cu.mypimes.pos.ui.components.StaleNote
import cu.mypimes.pos.ui.components.LoadingBlock
import cu.mypimes.pos.ui.components.Pill
import cu.mypimes.pos.ui.components.PrimaryButton
import cu.mypimes.pos.ui.components.SectionTitle
import cu.mypimes.pos.ui.theme.AlDiaColors
import kotlin.math.abs

/** Pantalla Inventario, dentro de Más. Contar lo hacen todas las cuentas; historial y corrección, solo el dueño. */
@Composable
fun InventoryScreen(
    session: Session,
    viewModel: InventoryViewModel,
    onBack: () -> Unit,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    LaunchedEffect(session.token) { viewModel.bind(session) }
    BackHandler(enabled = state.view != InventoryView.COUNT) { viewModel.back() }

    when (state.view) {
        InventoryView.COUNT -> CountView(session, state, viewModel, onBack)
        InventoryView.RESULT -> state.result?.let { ResultView(it, onNew = viewModel::back) }
        InventoryView.DETAIL -> DetailView(session, state, viewModel)
    }
}

@Composable
private fun CountView(session: Session, state: InventoryUiState, viewModel: InventoryViewModel, onBack: () -> Unit) {
    val owner = session.user.isOwner
    var search by rememberSaveable { mutableStateOf("") }
    val countable = state.products.filter { it.unit == null || it.trackStock == 1 }
    val shown = countable.filter { it.name.contains(search.trim(), ignoreCase = true) }
    val dayRows = state.dayStock?.products?.associateBy { it.id }.orEmpty()
    val filled = countable.count { state.entries[it.id]?.filled == true }

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Row(Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Volver", tint = AlDiaColors.TextPrimary)
            }
            Column(Modifier.weight(1f)) {
                Text("Inventario", style = MaterialTheme.typography.headlineMedium, color = AlDiaColors.TextPrimary)
                Text("Contar el estante", style = MaterialTheme.typography.bodySmall, color = AlDiaColors.TextSecondary)
            }
            IconButton(onClick = { viewModel.refresh(session) }, enabled = !state.refreshing) {
                Icon(Icons.Default.Refresh, contentDescription = "Actualizar", tint = AlDiaColors.TextSecondary)
            }
        }

        InfoBanner(
            if (owner) {
                "Escribe lo que cuentas en el estante. Compara con el inicio del día y el stock actual para detectar diferencias. Lo que dejes en blanco no se toca."
            } else {
                "Escribe lo que cuentas en el estante. No te mostramos lo que dice el sistema hasta el final, para que cuentes de verdad en vez de confirmar un número. Lo que dejes en blanco no se toca."
            },
        )
        Spacer(Modifier.height(10.dp))
        if (owner) { OwnerQueueBanner(session); Spacer(Modifier.height(10.dp)) }
        StaleNote(state.staleSince, extra = "Sin conexión: el historial de arqueos y el inicio del día pueden no estar al día")
        state.error?.let {
            ErrorBanner(it)
            Spacer(Modifier.height(10.dp))
        }
        state.notice?.let {
            InfoBanner(it)
            Spacer(Modifier.height(10.dp))
        }

        // Fuera del `when` de abajo: aunque no haya productos, un conteo rechazado debe verse.
        if (state.rejected.isNotEmpty()) {
            RejectedCounts(state.rejected, onDiscard = { viewModel.discardRejected(it) })
            Spacer(Modifier.height(10.dp))
        }

        AlDiaField(value = search, onValueChange = { search = it }, placeholder = "Buscar producto...")
        Spacer(Modifier.height(12.dp))

        when {
            state.loading && countable.isEmpty() -> LoadingBlock()
            countable.isEmpty() -> EmptyBlock("No hay productos con control de stock", "Da de alta productos en Más > Productos.")
            shown.isEmpty() -> EmptyBlock("Ningún producto coincide con la búsqueda")
            else -> LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(shown, key = { it.id }) { product ->
                    CountRow(product, state.entries[product.id] ?: CountEntry(), dayRows[product.id], owner) {
                        viewModel.editCount(product.id, it)
                    }
                }
                if (owner && state.history.isNotEmpty()) {
                    item { SectionTitle("Arqueos anteriores", Modifier.padding(top = 10.dp)) }
                    items(state.history, key = { it.id }) { count ->
                        HistoryRow(count) { viewModel.openDetail(session, count.id) }
                    }
                }
                item { Spacer(Modifier.height(8.dp)) }
            }
        }

        Spacer(Modifier.height(10.dp))
        AlDiaField(value = state.note, onValueChange = viewModel::setNote, placeholder = "Nota (opcional): ej. conteo del cierre de mes")
        Spacer(Modifier.height(10.dp))
        Text(
            "$filled ${if (filled == 1) "producto contado" else "productos contados"}",
            style = MaterialTheme.typography.titleSmall,
            color = AlDiaColors.TextPrimary,
        )
        Text("de ${countable.size} en el inventario", style = MaterialTheme.typography.labelSmall, color = AlDiaColors.TextTertiary)
        Spacer(Modifier.height(8.dp))
        PrimaryButton(
            "Cerrar arqueo",
            onClick = { viewModel.submit(session) },
            enabled = filled > 0 && !state.busy,
            loading = state.busy,
        )
        Spacer(Modifier.height(12.dp))
    }
}

/** Lo que el servidor rechazó. El motivo es el suyo; descartar solo lo oculta, no borra nada. */
@Composable
private fun RejectedCounts(rejected: List<RejectedCount>, onDiscard: (QueuedOperationEntity) -> Unit) {
    val requireOwnerPin = LocalRequireOwnerPin.current
    var confirming by rememberSaveable { mutableStateOf<String?>(null) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SectionTitle("Arqueos que el servidor rechazó")
        rejected.forEach { item ->
            val op = item.operation
            AlDiaCard(Modifier.fillMaxWidth()) {
                Column {
                    Text(
                        "${Format.dateTime(op.createdAt)} · ${item.lines} ${if (item.lines == 1) "producto" else "productos"}",
                        style = MaterialTheme.typography.titleSmall,
                        color = AlDiaColors.TextPrimary,
                    )
                    Text(item.reason, style = MaterialTheme.typography.labelSmall, color = AlDiaColors.Danger)
                    TextButton(onClick = { confirming = op.clientOperationId }) { Text("Descartar") }
                }
            }
        }
    }
    confirming?.let { id ->
        val op = rejected.firstOrNull { it.operation.clientOperationId == id }?.operation
        AlertDialog(
            onDismissRequest = { confirming = null },
            title = { Text("¿Descartar este arqueo?") },
            text = { Text("Dejará de aparecer aquí y no se volverá a enviar. Sus datos se quedan guardados en el teléfono.") },
            confirmButton = {
                TextButton(onClick = {
                    op?.let { requireOwnerPin { onDiscard(it) } }
                    confirming = null
                }) { Text("Descartar") }
            },
            dismissButton = { TextButton(onClick = { confirming = null }) { Text("Cancelar") } },
        )
    }
}

@Composable
private fun CountRow(
    product: ProductDto,
    entry: CountEntry,
    day: DayStockRowDto?,
    owner: Boolean,
    onChange: (CountEntry) -> Unit,
) {
    AlDiaCard(Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(product.name, style = MaterialTheme.typography.titleSmall, color = AlDiaColors.TextPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (owner && day != null) {
                    Text(
                        "Inicial ${dayValue(day.openingStock, product)} · Entradas ${dayValue(day.entriesStock, product)} · Disponible ${dayValue(day.currentStock, product)}",
                        style = MaterialTheme.typography.labelSmall,
                        color = AlDiaColors.TextTertiary,
                    )
                }
            }
            CountInput(product.unit, product.packSize, entry, enabled = true, onChange = onChange)
        }
    }
}

@Composable
private fun CountInput(unit: String?, packSize: Int?, entry: CountEntry, enabled: Boolean, onChange: (CountEntry) -> Unit) {
    if (hasPack(unit, packSize)) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            AlDiaField(
                value = entry.packs,
                onValueChange = { onChange(entry.copy(packs = it)) },
                modifier = Modifier.width(72.dp),
                placeholder = "paq",
                enabled = enabled,
                keyboardType = KeyboardType.Number,
            )
            AlDiaField(
                value = entry.loose,
                onValueChange = { onChange(entry.copy(loose = it)) },
                modifier = Modifier.width(84.dp),
                placeholder = "sueltos",
                enabled = enabled,
                keyboardType = KeyboardType.Number,
            )
        }
    } else {
        Row(verticalAlignment = Alignment.CenterVertically) {
            AlDiaField(
                value = entry.text,
                onValueChange = { onChange(entry.copy(text = it)) },
                modifier = Modifier.width(96.dp),
                placeholder = "—",
                enabled = enabled,
                keyboardType = if (unit != null) KeyboardType.Decimal else KeyboardType.Number,
            )
            if (unit != null) {
                Text(" $unit", style = MaterialTheme.typography.labelSmall, color = AlDiaColors.TextTertiary)
            }
        }
    }
}

@Composable
private fun HistoryRow(count: InventoryCountDto, onClick: () -> Unit) {
    AlDiaCard(Modifier.fillMaxWidth().clickable(onClick = onClick)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                val who = accountLabel(count.accountEmail)?.let { " · $it" }.orEmpty()
                Text(
                    Format.dateTime(count.countedAt) + who,
                    style = MaterialTheme.typography.titleSmall,
                    color = AlDiaColors.TextPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    "${count.linesCount} ${if (count.linesCount == 1) "producto" else "productos"} contados",
                    style = MaterialTheme.typography.labelSmall,
                    color = AlDiaColors.TextTertiary,
                )
                count.note?.takeIf { it.isNotBlank() }?.let {
                    Text(it, style = MaterialTheme.typography.labelSmall, color = AlDiaColors.TextTertiary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            Spacer(Modifier.width(8.dp))
            when {
                count.unitsMissing > 0 -> Pill(
                    "−${Format.quantity(count.unitsMissing)} uds · ${Format.money(count.valueMissing)}",
                    AlDiaColors.Danger, AlDiaColors.DangerSoft,
                )
                count.unitsExtra > 0 -> Pill("+${Format.quantity(count.unitsExtra)} uds", AlDiaColors.Warning, AlDiaColors.WarningSoft)
                else -> Pill("Cuadró", AlDiaColors.Success, AlDiaColors.SuccessSoft)
            }
        }
    }
}

@Composable
private fun ResultView(result: CountResult, onNew: () -> Unit) {
    val summary = result.summary
    val cuadro = summary.withDifference == 0
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Text(
            "Resultado del arqueo",
            style = MaterialTheme.typography.headlineMedium,
            color = AlDiaColors.TextPrimary,
            modifier = Modifier.padding(top = 14.dp, bottom = 12.dp),
        )
        Surface(color = if (cuadro) AlDiaColors.Success else AlDiaColors.Danger, shape = RoundedCornerShape(24.dp), modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(22.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                if (cuadro) {
                    Text("Todo cuadró", style = MaterialTheme.typography.titleMedium, color = Color.White)
                    Text("${result.lines.size} productos contados", style = MaterialTheme.typography.bodySmall, color = Color.White.copy(alpha = 0.85f))
                } else if (summary.unitsMissing > 0) {
                    Text("Falta mercancía", style = MaterialTheme.typography.titleMedium, color = Color.White)
                    Text(Format.money(summary.valueMissing), style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.Bold, color = Color.White)
                    Text(
                        "${Format.quantity(summary.unitsMissing)} unidades a precio de venta",
                        style = MaterialTheme.typography.bodySmall,
                        color = Color.White.copy(alpha = 0.85f),
                    )
                } else {
                    Text("Hay mercancía de más", style = MaterialTheme.typography.titleMedium, color = Color.White)
                }
            }
        }
        Spacer(Modifier.height(12.dp))
        if (!cuadro && summary.unitsMissing > 0) {
            InfoBanner(
                "Mercancía que salió del estante sin una venta que la explique. Puede ser robo, merma, rotura o un error al recibir el pedido: " +
                    "el sistema no puede distinguirlos, pero ahora sabes cuánto y de qué.",
                tone = AlDiaColors.Warning,
            )
            Spacer(Modifier.height(12.dp))
        }

        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(result.lines, key = { it.productId }) { line ->
                AlDiaCard(Modifier.fillMaxWidth()) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(line.name, style = MaterialTheme.typography.titleSmall, color = AlDiaColors.TextPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(
                                "Sistema ${stockLabel(line.expected, line.unit, true, line.packSize)} · contado ${stockLabel(line.counted, line.unit, true, line.packSize)}",
                                style = MaterialTheme.typography.labelSmall,
                                color = AlDiaColors.TextTertiary,
                            )
                        }
                        DiffText(line.difference, line.unit, line.packSize)
                    }
                }
            }
        }

        Spacer(Modifier.height(10.dp))
        if (result.pending) {
            Text(
                "Guardado en este dispositivo. Pendiente de sincronizar.",
                style = MaterialTheme.typography.bodySmall,
                color = AlDiaColors.Warning,
                modifier = Modifier.fillMaxWidth(),
            )
        } else {
            Text(
                "El stock ya quedó ajustado a lo que contaste.",
                style = MaterialTheme.typography.labelSmall,
                color = AlDiaColors.TextTertiary,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        Spacer(Modifier.height(10.dp))
        PrimaryButton("Hacer otro arqueo", onClick = onNew)
        Spacer(Modifier.height(12.dp))
    }
}

@Composable
private fun DetailView(session: Session, state: InventoryUiState, viewModel: InventoryViewModel) {
    val requireOwnerPin = LocalRequireOwnerPin.current
    val count = state.detail
    val products = state.products.associateBy { it.id }
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Row(Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = viewModel::back) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Volver", tint = AlDiaColors.TextPrimary)
            }
            Text(
                "Detalle del arqueo",
                style = MaterialTheme.typography.headlineMedium,
                color = AlDiaColors.TextPrimary,
                modifier = Modifier.weight(1f),
            )
            if (count != null && !state.correcting) {
                TextButton(onClick = viewModel::startCorrection) {
                    Text("Corregir", color = AlDiaColors.Blue)
                }
            }
        }
        state.error?.let {
            ErrorBanner(it)
            Spacer(Modifier.height(10.dp))
        }
        state.notice?.let {
            InfoBanner(it)
            Spacer(Modifier.height(10.dp))
        }

        when {
            state.detailLoading -> LoadingBlock()
            count == null -> EmptyBlock("No se pudo abrir el arqueo", "Vuelve atrás e inténtalo de nuevo con conexión.")
            else -> {
                AlDiaCard(Modifier.fillMaxWidth()) {
                    Column {
                        val who = accountLabel(count.accountEmail)?.let { " · $it" }.orEmpty()
                        Text(Format.dateTime(count.countedAt) + who, style = MaterialTheme.typography.titleSmall, color = AlDiaColors.TextPrimary)
                        Text(
                            "${count.linesCount} ${if (count.linesCount == 1) "producto" else "productos"} contados",
                            style = MaterialTheme.typography.labelSmall,
                            color = AlDiaColors.TextTertiary,
                        )
                        count.note?.takeIf { it.isNotBlank() }?.let {
                            Text(it, style = MaterialTheme.typography.labelSmall, color = AlDiaColors.TextTertiary)
                        }
                    }
                }
                Spacer(Modifier.height(12.dp))
                if (state.correcting) {
                    InfoBanner("El stock se mueve por la diferencia que corrijas.")
                    Spacer(Modifier.height(10.dp))
                }

                LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(count.items.sortedBy { order(it.difference) }, key = { it.id }) { item ->
                        val product = products[item.productId]
                        DetailLine(
                            item = item,
                            unit = product?.unit,
                            packSize = product?.packSize,
                            correcting = state.correcting,
                            entry = state.correction[item.id] ?: CountEntry(),
                            onChange = { viewModel.editCorrection(item.id, it) },
                        )
                    }
                }

                if (state.correcting) {
                    Spacer(Modifier.height(10.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        OutlinedButton(onClick = viewModel::cancelCorrection, modifier = Modifier.weight(1f).height(52.dp), shape = RoundedCornerShape(16.dp)) {
                            Text("Cancelar")
                        }
                        PrimaryButton(
                            "Guardar corrección",
                            onClick = { requireOwnerPin { viewModel.saveCorrection(session) } },
                            modifier = Modifier.weight(1f),
                            loading = state.busy,
                        )
                    }
                }
                Spacer(Modifier.height(12.dp))
            }
        }
    }
}

@Composable
private fun DetailLine(
    item: InventoryCountItemDto,
    unit: String?,
    packSize: Int?,
    correcting: Boolean,
    entry: CountEntry,
    onChange: (CountEntry) -> Unit,
) {
    AlDiaCard(Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(item.productName, style = MaterialTheme.typography.titleSmall, color = AlDiaColors.TextPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    "Sistema ${stockLabel(item.expected, unit, true, packSize)} · contado ${stockLabel(item.counted, unit, true, packSize)}",
                    style = MaterialTheme.typography.labelSmall,
                    color = AlDiaColors.TextTertiary,
                )
                if (item.recountedLater) {
                    Text("Contado de nuevo después", style = MaterialTheme.typography.labelSmall, color = AlDiaColors.TextTertiary)
                }
            }
            if (correcting && !item.recountedLater) {
                CountInput(unit, packSize, entry, enabled = true, onChange = onChange)
            } else {
                DiffText(item.difference, unit, packSize)
            }
        }
    }
}

@Composable
private fun DiffText(difference: Double, unit: String?, packSize: Int?) {
    val suffix = when {
        hasPack(unit, packSize) -> " sueltos"
        unit != null -> " $unit"
        else -> ""
    }
    val (text, color) = when {
        difference == 0.0 -> "✓" to AlDiaColors.Success
        difference < 0 -> "−${Format.quantity(abs(difference))}$suffix" to AlDiaColors.Danger
        else -> "+${Format.quantity(difference)}$suffix" to AlDiaColors.Warning
    }
    Text(text, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold, color = color)
}

private fun hasPack(unit: String?, packSize: Int?) = unit == null && (packSize ?: 0) > 1

private fun dayValue(value: Double?, product: ProductDto): String =
    value?.let { stockLabel(it, product.unit, true, product.packSize) } ?: "—"

/** Faltantes primero, luego sobrantes y exactos. */
private fun order(difference: Double) = if (difference < 0) 0 else if (difference > 0) 1 else 2
