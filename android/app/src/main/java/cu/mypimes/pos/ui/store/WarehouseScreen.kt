package cu.mypimes.pos.ui.store

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cu.mypimes.pos.data.auth.Session
import cu.mypimes.pos.data.store.WarehouseChangeDto
import cu.mypimes.pos.data.store.WarehouseItemDto
import cu.mypimes.pos.data.store.WarehousePassDto
import cu.mypimes.pos.domain.Format
import cu.mypimes.pos.domain.inventory.accountLabel
import cu.mypimes.pos.domain.products.PRODUCT_UNITS
import cu.mypimes.pos.domain.products.stockLabel
import cu.mypimes.pos.ui.components.AlDiaCard
import cu.mypimes.pos.ui.components.LocalRequireOwnerPin
import cu.mypimes.pos.ui.components.AlDiaField
import cu.mypimes.pos.ui.components.EmptyBlock
import cu.mypimes.pos.ui.components.ErrorBanner
import cu.mypimes.pos.ui.components.InfoBanner
import cu.mypimes.pos.ui.components.StaleNote
import cu.mypimes.pos.ui.components.LoadingBlock
import cu.mypimes.pos.ui.components.PrimaryButton
import cu.mypimes.pos.ui.theme.AlDiaColors

/** Pantalla Almacén, dentro de Más. Ver y pasar mercancía lo hace cualquier cuenta; el historial, solo el dueño. */
@Composable
fun WarehouseScreen(
    session: Session,
    viewModel: WarehouseViewModel,
    onBack: () -> Unit,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    LaunchedEffect(session.token) { viewModel.bind(session) }
    BackHandler(enabled = state.view != WarehouseView.LIST) { viewModel.back() }

    when (state.view) {
        WarehouseView.LIST -> ListView(session, state, viewModel, onBack)
        WarehouseView.ITEM -> ItemView(session, state, viewModel)
        WarehouseView.TO_STORE -> state.toStore?.let { ToStoreView(session, it, state, viewModel) }
        WarehouseView.FROM_STORE -> FromStoreView(session, state, viewModel)
        WarehouseView.HISTORY -> HistoryView(state, viewModel)
    }
}

@Composable
private fun Header(title: String, subtitle: String, onBack: () -> Unit, trailing: @Composable () -> Unit = {}) {
    Row(Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = onBack) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Volver", tint = AlDiaColors.TextPrimary)
        }
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.headlineMedium, color = AlDiaColors.TextPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = AlDiaColors.TextSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        trailing()
    }
}

@Composable
private fun ListView(session: Session, state: WarehouseUiState, viewModel: WarehouseViewModel, onBack: () -> Unit) {
    var search by rememberSaveable { mutableStateOf("") }
    val shown = state.items.filter { it.name.contains(search.trim(), ignoreCase = true) }
    val total = state.items.sumOf { it.quantity * it.cost }

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Header("Almacén", "Mercancía guardada aparte de la tienda", onBack) {
            IconButton(onClick = { viewModel.refresh(session) }, enabled = !state.refreshing) {
                Icon(Icons.Default.Refresh, contentDescription = "Actualizar", tint = AlDiaColors.TextSecondary)
            }
        }
        Text("Importe total al costo: ${Format.money2(total)}", style = MaterialTheme.typography.bodySmall, color = AlDiaColors.TextSecondary)
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = viewModel::openNewItem, modifier = Modifier.weight(1f)) { Text("Nuevo") }
            OutlinedButton(onClick = viewModel::openFromStore, modifier = Modifier.weight(1f)) { Text("Desde la tienda") }
            if (session.user.isOwner) {
                OutlinedButton(onClick = { viewModel.openHistory(session) }, modifier = Modifier.weight(1f)) { Text("Historial") }
            }
        }
        Spacer(Modifier.height(10.dp))
        if (session.user.isOwner) { OwnerQueueBanner(session); Spacer(Modifier.height(10.dp)) }
        state.notice?.let {
            InfoBanner(it)
            Spacer(Modifier.height(10.dp))
        }
        StaleNote(state.staleSince, extra = "Sin conexión: puedes ver el almacén, pero no cambiarlo")
        state.error?.let {
            ErrorBanner(it)
            Spacer(Modifier.height(10.dp))
        }

        AlDiaField(value = search, onValueChange = { search = it }, placeholder = "Buscar en el almacén...")
        Spacer(Modifier.height(12.dp))

        when {
            state.loading && state.items.isEmpty() -> LoadingBlock()
            state.items.isEmpty() && state.error != null -> EmptyBlock("No se pudo cargar el almacén", "Revisa la conexión y toca Actualizar.")
            state.items.isEmpty() -> EmptyBlock("No hay artículos en el almacén")
            shown.isEmpty() -> EmptyBlock("Ningún artículo coincide con la búsqueda")
            else -> LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(shown, key = { it.id }) { item -> ItemRow(item, onEdit = { viewModel.openEditItem(item) }) { viewModel.openToStore(item) } }
                item { Spacer(Modifier.height(8.dp)) }
            }
        }
    }
}

@Composable
private fun ItemRow(item: WarehouseItemDto, onEdit: () -> Unit, onTransfer: () -> Unit) {
    AlDiaCard(Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f).clickable(onClick = onEdit)) {
                Text(item.name, style = MaterialTheme.typography.titleSmall, color = AlDiaColors.TextPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    "Costo ${Format.money2(item.cost)}${item.unit?.let { " por $it" }.orEmpty()} · Importe ${Format.money2(item.quantity * item.cost)}",
                    style = MaterialTheme.typography.labelSmall,
                    color = AlDiaColors.TextTertiary,
                )
            }
            Text(stockLabel(item.quantity, item.unit, true, null), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold, color = AlDiaColors.TextPrimary)
            IconButton(onClick = onTransfer, enabled = item.quantity > 0) {
                Icon(
                    Icons.AutoMirrored.Filled.ArrowForward,
                    contentDescription = "Pasar a la tienda",
                    tint = if (item.quantity > 0) AlDiaColors.Blue else AlDiaColors.TextTertiary,
                )
            }
        }
    }
}

/** Alta y edición. Reponer es la misma pantalla: en la edición, "Cantidad que llegó" se suma al stock. */
@Composable
private fun ItemView(session: Session, state: WarehouseUiState, viewModel: WarehouseViewModel) {
    val requireOwnerPin = LocalRequireOwnerPin.current
    val form = state.item ?: return
    val editing = form.editing
    var confirmDelete by remember { mutableStateOf(false) }

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp).verticalScroll(rememberScrollState())) {
        Header(if (editing == null) "Nuevo artículo" else "Editar artículo", editing?.name ?: "Alta en el almacén", onBack = viewModel::back)
        state.error?.let {
            ErrorBanner(it)
            Spacer(Modifier.height(10.dp))
        }
        AlDiaField(
            label = "Nombre",
            value = form.name,
            onValueChange = { viewModel.setItem(form.copy(name = it)) },
            placeholder = "Ej: Harina de trigo",
        )
        Spacer(Modifier.height(12.dp))
        AlDiaField(
            label = "Costo",
            value = form.cost,
            onValueChange = { viewModel.setItem(form.copy(cost = it)) },
            placeholder = "0",
            keyboardType = KeyboardType.Decimal,
        )
        Spacer(Modifier.height(12.dp))
        Text("Unidad", style = MaterialTheme.typography.labelSmall, color = AlDiaColors.TextSecondary)
        Spacer(Modifier.height(6.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(selected = form.unit == null, onClick = { viewModel.setItem(form.copy(unit = null)) }, label = { Text("Pieza") })
            PRODUCT_UNITS.forEach { unit ->
                FilterChip(selected = form.unit == unit, onClick = { viewModel.setItem(form.copy(unit = unit)) }, label = { Text(unit) })
            }
        }
        Spacer(Modifier.height(12.dp))
        AlDiaField(
            label = if (editing == null) "Cantidad inicial" else "Cantidad que llegó (opcional)",
            value = form.quantity,
            onValueChange = { viewModel.setItem(form.copy(quantity = it)) },
            placeholder = "0",
            keyboardType = if (form.unit != null) KeyboardType.Decimal else KeyboardType.Number,
        )
        if (editing != null) {
            Spacer(Modifier.height(6.dp))
            Text("Hay ${stockLabel(editing.quantity, editing.unit, true, null)}", style = MaterialTheme.typography.labelSmall, color = AlDiaColors.TextTertiary)
        }
        Spacer(Modifier.height(18.dp))
        PrimaryButton(
            if (editing == null) "Guardar artículo" else "Guardar cambios",
            onClick = { viewModel.saveItem(session) },
            modifier = Modifier.fillMaxWidth(),
            loading = state.busy,
        )
        // Borrar es solo del dueño; el servidor lo deja a cualquier cuenta.
        if (editing != null && session.user.isOwner) {
            TextButton(onClick = { confirmDelete = true }, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) {
                Text("Eliminar del almacén", color = AlDiaColors.Danger)
            }
        }
        Spacer(Modifier.height(12.dp))
    }

    if (confirmDelete && editing != null) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Eliminar artículo") },
            text = { Text("¿Eliminar «${editing.name}» del almacén? No se puede deshacer.") },
            confirmButton = {
                TextButton(onClick = { confirmDelete = false; requireOwnerPin { viewModel.deleteItem(session) } }) { Text("Eliminar", color = AlDiaColors.Danger) }
            },
            dismissButton = {
                TextButton(onClick = { confirmDelete = false }) { Text("Cancelar") }
            },
        )
    }
}

@Composable
private fun ToStoreView(session: Session, form: ToStoreForm, state: WarehouseUiState, viewModel: WarehouseViewModel) {
    val unit = form.item.unit
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Header("Pasar a la tienda", form.item.name, onBack = viewModel::back)
        InfoBanner("En el almacén hay ${stockLabel(form.item.quantity, unit, true, null)}. Lo que pasas sale del almacén y entra al stock de la tienda.")
        Spacer(Modifier.height(14.dp))
        AlDiaField(
            label = "Cantidad",
            value = form.quantity,
            onValueChange = { viewModel.setToStore(form.copy(quantity = it)) },
            placeholder = "0",
            keyboardType = if (unit != null) KeyboardType.Decimal else KeyboardType.Number,
        )
        if (form.needsSalePrice) {
            Spacer(Modifier.height(12.dp))
            InfoBanner("«${form.item.name}» aún no está en la tienda. Se creará con el precio de venta que pongas aquí.")
            Spacer(Modifier.height(10.dp))
            AlDiaField(
                label = "Precio de venta",
                value = form.salePrice,
                onValueChange = { viewModel.setToStore(form.copy(salePrice = it)) },
                placeholder = "0.00",
                keyboardType = KeyboardType.Decimal,
            )
        }
        Spacer(Modifier.height(12.dp))
        state.error?.let {
            ErrorBanner(it)
            Spacer(Modifier.height(10.dp))
        }
        Spacer(Modifier.weight(1f))
        PrimaryButton(
            "Pasar a la tienda",
            onClick = { viewModel.submitToStore(session) },
            modifier = Modifier.fillMaxWidth(),
            loading = state.busy,
        )
        Spacer(Modifier.height(12.dp))
    }
}

@Composable
private fun FromStoreView(session: Session, state: WarehouseUiState, viewModel: WarehouseViewModel) {
    val form = state.fromStore ?: return
    val product = form.product
    var search by rememberSaveable { mutableStateOf("") }
    // Los productos sin control de stock por peso no pasan al almacén (lo rechaza el servidor igual).
    val pickable = state.products.filter {
        it.stock > 0 && (it.unit == null || it.trackStock != 0) && it.name.contains(search.trim(), ignoreCase = true)
    }

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Header(
            "Desde la tienda",
            product?.name ?: "Elige el producto que pasas al almacén",
            onBack = viewModel::back,
        )
        state.error?.let {
            ErrorBanner(it)
            Spacer(Modifier.height(10.dp))
        }
        if (product == null) {
            AlDiaField(value = search, onValueChange = { search = it }, placeholder = "Buscar producto...")
            Spacer(Modifier.height(12.dp))
            if (pickable.isEmpty()) {
                EmptyBlock("No hay productos con stock para pasar")
            } else {
                LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(pickable, key = { it.id }) { p ->
                        // Un producto nuevo recibe un id de cliente nuevo: otro producto es otro pase.
                        AlDiaCard(Modifier.fillMaxWidth().clickable { viewModel.setFromStore(FromStoreForm(product = p)) }) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(p.name, style = MaterialTheme.typography.titleSmall, color = AlDiaColors.TextPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                                Text(stockLabel(p.stock, p.unit, true, p.packSize), style = MaterialTheme.typography.labelSmall, color = AlDiaColors.TextTertiary)
                            }
                        }
                    }
                }
            }
        } else {
            InfoBanner("En la tienda hay ${stockLabel(product.stock, product.unit, true, product.packSize)}. Lo que pasas sale del stock de la tienda y entra al almacén.")
            Spacer(Modifier.height(14.dp))
            AlDiaField(
                label = "Cantidad",
                value = form.quantity,
                onValueChange = { viewModel.setFromStore(form.copy(quantity = it)) },
                placeholder = "0",
                keyboardType = if (product.unit != null) KeyboardType.Decimal else KeyboardType.Number,
            )
            TextButton(onClick = { viewModel.setFromStore(FromStoreForm()) }) { Text("Cambiar producto") }
            Spacer(Modifier.weight(1f))
            PrimaryButton(
                "Pasar al almacén",
                onClick = { viewModel.submitFromStore(session) },
                modifier = Modifier.fillMaxWidth(),
                loading = state.busy,
            )
            Spacer(Modifier.height(12.dp))
        }
    }
}

@Composable
private fun HistoryView(state: WarehouseUiState, viewModel: WarehouseViewModel) {
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Header("Historial del almacén", "Cambios y pases entre la tienda y el almacén", onBack = viewModel::back)
        StaleNote(state.staleSince, extra = "El registro de cambios necesita internet; los pases son los últimos 90 días")
        state.error?.let {
            ErrorBanner(it)
            Spacer(Modifier.height(10.dp))
        }
        when {
            state.historyLoading -> LoadingBlock()
            state.history.isEmpty() && state.changes.isEmpty() && state.error == null -> EmptyBlock("Todavía no hay movimientos")
            else -> LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (state.changes.isNotEmpty()) {
                    item { Text("Cambios en el almacén", style = MaterialTheme.typography.labelMedium, color = AlDiaColors.TextSecondary) }
                    items(state.changes, key = { "c${it.id}" }) { ChangeRow(it) }
                }
                if (state.history.isNotEmpty()) {
                    item { Text("Pases entre la tienda y el almacén", style = MaterialTheme.typography.labelMedium, color = AlDiaColors.TextSecondary) }
                    items(state.history, key = { "p${it.id}" }) { TransferRow(it) }
                }
                item { Spacer(Modifier.height(8.dp)) }
            }
        }
    }
}

@Composable
private fun ChangeRow(c: WarehouseChangeDto) {
    AlDiaCard(Modifier.fillMaxWidth()) {
        Column {
            Text(
                "${c.action.replaceFirstChar { it.uppercase() }} · ${c.itemName}",
                style = MaterialTheme.typography.titleSmall,
                color = AlDiaColors.TextPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            c.detail?.takeIf { it.isNotBlank() }?.let {
                Text(it, style = MaterialTheme.typography.labelSmall, color = AlDiaColors.TextTertiary)
            }
            Text(
                Format.dateTime(c.createdAt) + (accountLabel(c.accountEmail)?.let { " · $it" }.orEmpty()),
                style = MaterialTheme.typography.labelSmall,
                color = AlDiaColors.TextTertiary,
            )
        }
    }
}

@Composable
private fun TransferRow(t: WarehousePassDto) {
    val toWarehouse = t.direction == "to_warehouse"
    val created = t.createdProduct == 1
    val detail = when {
        created && toWarehouse -> " · creó el artículo en el almacén"
        created -> " · creó el producto en la tienda"
        else -> ""
    }
    AlDiaCard(Modifier.fillMaxWidth()) {
        Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(t.itemName, style = MaterialTheme.typography.titleSmall, color = AlDiaColors.TextPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Text(Format.quantity(t.quantity), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold, color = AlDiaColors.TextPrimary)
            }
            Text(
                (if (toWarehouse) "Tienda → almacén" else "Almacén → tienda") + detail,
                style = MaterialTheme.typography.labelSmall,
                color = AlDiaColors.TextTertiary,
            )
            Text(
                Format.dateTime(t.createdAt) + (accountLabel(t.accountEmail)?.let { " · $it" }.orEmpty()),
                style = MaterialTheme.typography.labelSmall,
                color = AlDiaColors.TextTertiary,
            )
        }
    }
}
