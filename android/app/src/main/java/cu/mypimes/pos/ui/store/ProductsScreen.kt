package cu.mypimes.pos.ui.store

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Switch
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cu.mypimes.pos.data.auth.Session
import cu.mypimes.pos.data.pos.ProductDto
import cu.mypimes.pos.data.store.toDraft
import cu.mypimes.pos.domain.Format
import cu.mypimes.pos.domain.products.PRODUCT_UNITS
import cu.mypimes.pos.domain.products.ProductDraft
import cu.mypimes.pos.domain.products.stockLabel
import cu.mypimes.pos.ui.components.AlDiaCard
import cu.mypimes.pos.ui.components.LocalRequireOwnerPin
import cu.mypimes.pos.ui.components.AlDiaField
import cu.mypimes.pos.ui.components.EmptyBlock
import cu.mypimes.pos.ui.components.ErrorBanner
import cu.mypimes.pos.ui.components.InfoBanner
import cu.mypimes.pos.ui.components.LoadingBlock
import cu.mypimes.pos.ui.components.Pill
import cu.mypimes.pos.ui.components.PrimaryButton
import cu.mypimes.pos.ui.components.SectionTitle
import cu.mypimes.pos.ui.theme.AlDiaColors
import kotlin.math.floor

/** Pantalla Productos, dentro de Más. La lista y el alta son para todos; editar y borrar, según rol. */
@Composable
fun ProductsScreen(
    session: Session,
    viewModel: ProductsViewModel,
    onBack: () -> Unit,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val owner = session.user.isOwner
    var search by rememberSaveable { mutableStateOf("") }

    LaunchedEffect(session.token) { viewModel.bind(session) }

    val shown = state.products.filter { it.name.contains(search.trim(), ignoreCase = true) }

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Row(Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Volver", tint = AlDiaColors.TextPrimary)
            }
            Column(Modifier.weight(1f)) {
                Text("Productos", style = MaterialTheme.typography.headlineMedium, color = AlDiaColors.TextPrimary)
                Text(
                    "${state.products.size} en total",
                    style = MaterialTheme.typography.bodySmall,
                    color = AlDiaColors.TextSecondary,
                )
            }
            IconButton(onClick = { viewModel.refresh(session) }, enabled = !state.refreshing) {
                if (state.refreshing) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = AlDiaColors.Blue)
                else Icon(Icons.Default.Refresh, contentDescription = "Actualizar", tint = AlDiaColors.TextSecondary)
            }
            IconButton(onClick = viewModel::openNew) {
                Icon(Icons.Default.Add, contentDescription = "Nuevo producto", tint = AlDiaColors.Blue)
            }
        }

        if (!owner) {
            InfoBanner(
                "Puedes dar de alta productos nuevos, cambiar su precio de venta y añadir stock (queda a tu nombre). " +
                    "Los demás cambios y la eliminación los hace el dueño.",
            )
            Spacer(Modifier.height(10.dp))
        }
        if (owner) { OwnerQueueBanner(session); Spacer(Modifier.height(10.dp)) }
        state.notice?.let {
            InfoBanner(it, Modifier.clickable(onClick = viewModel::dismissNotice), tone = AlDiaColors.Warning)
            Spacer(Modifier.height(10.dp))
        }
        state.error?.let {
            ErrorBanner(it)
            Spacer(Modifier.height(10.dp))
        }

        AlDiaField(value = search, onValueChange = { search = it }, placeholder = "Buscar producto...")
        Spacer(Modifier.height(12.dp))

        when {
            state.loading && state.products.isEmpty() -> LoadingBlock()
            state.products.isEmpty() -> EmptyBlock("Todavía no hay productos", "Pulsa + para dar de alta el primero.")
            shown.isEmpty() -> EmptyBlock("Ningún producto coincide con la búsqueda")
            else -> LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(shown, key = { it.id }) { product ->
                    ProductRow(product, owner) { viewModel.openEdit(product) }
                }
                item { Spacer(Modifier.height(16.dp)) }
            }
        }
    }

    if (state.formOpen) {
        ProductSheet(
            editing = state.editing,
            owner = owner,
            busy = state.busy,
            error = state.formError,
            onSave = { draft -> viewModel.save(session, draft) },
            onDelete = { viewModel.delete(session) },
            onDismiss = viewModel::closeForm,
        )
    }
}

@Composable
private fun ProductRow(product: ProductDto, owner: Boolean, onClick: () -> Unit) {
    val untracked = product.unit != null && product.trackStock == 0
    val (textColor, background) = when {
        untracked -> AlDiaColors.TextSecondary to AlDiaColors.SurfaceMuted
        product.stock <= 0.0 -> AlDiaColors.Danger to AlDiaColors.DangerSoft
        product.stock <= 5.0 -> AlDiaColors.Warning to AlDiaColors.WarningSoft
        else -> AlDiaColors.Success to AlDiaColors.SuccessSoft
    }
    val suffix = product.unit?.let { " / $it" }.orEmpty()
    val pack = product.packSize?.takeIf { product.unit == null && it > 1 }
    AlDiaCard(Modifier.fillMaxWidth().clickable(onClick = onClick)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(
                    product.name,
                    style = MaterialTheme.typography.titleSmall,
                    color = AlDiaColors.TextPrimary,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    buildString {
                        append(priceText(product.salePrice)).append(suffix)
                        if (pack != null) append("  ·  paquete ×$pack ${priceText(product.packPrice ?: 0.0)}")
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = AlDiaColors.TextSecondary,
                )
                val purchase = product.purchasePrice
                if (owner && purchase != null) {
                    Text(
                        "Costo ${priceText(purchase)}$suffix",
                        style = MaterialTheme.typography.labelSmall,
                        color = AlDiaColors.TextTertiary,
                    )
                }
            }
            Spacer(Modifier.width(10.dp))
            Pill(
                stockLabel(product.stock, product.unit, product.trackStock != 0, pack),
                color = textColor,
                background = background,
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ProductSheet(
    editing: ProductDto?,
    owner: Boolean,
    busy: Boolean,
    error: String?,
    onSave: (ProductDraft) -> Unit,
    onDelete: () -> Unit,
    onDismiss: () -> Unit,
) {
    val requireOwnerPin = LocalRequireOwnerPin.current
    // Lo que la web deja al cajero: precio de venta y stock que llega. Lo demás, solo al dueño.
    val full = editing == null || owner
    var draft by remember { mutableStateOf(editing?.toDraft() ?: ProductDraft()) }
    var confirmDelete by remember { mutableStateOf(false) }
    fun edit(change: (ProductDraft) -> ProductDraft) { draft = change(draft) }

    val tracked = draft.tracksStock
    val unitSuffix = draft.unitOrNull?.let { " ($it)" }.orEmpty()
    val priceSuffix = draft.unitOrNull?.let { " por $it" }.orEmpty()
    val stockNow = draft.stockValue()
    // Corrección: cambió el stock a mano sin añadir mercancía (la web también lo anota).
    val stockFix = editing != null && full && tracked && stockNow != null && stockNow != editing.stock &&
        (draft.addValue() ?: 0.0) == 0.0

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = AlDiaColors.Surface,
    ) {
        Column(
            Modifier.fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp)
                .padding(bottom = 24.dp)
                .imePadding(),
        ) {
            Text(
                when {
                    editing == null -> "Nuevo producto"
                    owner -> "Editar producto"
                    else -> "Editar precio y stock"
                },
                style = MaterialTheme.typography.headlineSmall,
                color = AlDiaColors.TextPrimary,
            )
            Spacer(Modifier.height(14.dp))

            AlDiaField(
                label = "Nombre del producto",
                value = draft.name,
                onValueChange = { v -> edit { it.copy(name = v) } },
                placeholder = "Ej: Coca-Cola 600ml",
                enabled = full,
            )

            if (full) {
                Spacer(Modifier.height(12.dp))
                ToggleRow(
                    "Se vende por peso",
                    checked = draft.byWeight,
                    onChange = { on -> edit { it.copy(byWeight = on, packOn = if (on) false else it.packOn) } },
                )
                if (draft.byWeight) {
                    Spacer(Modifier.height(8.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        PRODUCT_UNITS.forEach { unit ->
                            FilterChip(
                                selected = draft.unit == unit,
                                onClick = { edit { it.copy(unit = unit) } },
                                label = { Text(unit) },
                            )
                        }
                    }
                    Spacer(Modifier.height(8.dp))
                    ToggleRow(
                        "Llevar control de stock",
                        supporting = "Opcional. Si lo apagas, se vende sin contar lo que queda.",
                        checked = draft.trackStock,
                        onChange = { on -> edit { it.copy(trackStock = on) } },
                    )
                } else {
                    Spacer(Modifier.height(8.dp))
                    ToggleRow(
                        "También se vende por paquete",
                        supporting = "Ej.: cajetilla de 20 cigarros.",
                        checked = draft.packOn,
                        onChange = { on -> edit { it.copy(packOn = on) } },
                    )
                }
                if (draft.packOn && !draft.byWeight) {
                    Spacer(Modifier.height(10.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        AlDiaField(
                            label = "Unidades por paquete",
                            value = draft.packSize,
                            onValueChange = { v -> edit { it.copy(packSize = v) } },
                            placeholder = "20",
                            keyboardType = KeyboardType.Number,
                            modifier = Modifier.weight(1f),
                        )
                        AlDiaField(
                            label = "Precio del paquete",
                            value = draft.packPrice,
                            onValueChange = { v -> edit { it.copy(packPrice = v) } },
                            placeholder = "0",
                            keyboardType = KeyboardType.Decimal,
                            modifier = Modifier.weight(1f),
                        )
                    }
                    Spacer(Modifier.height(10.dp))
                    AlDiaField(
                        label = "Costo del paquete",
                        value = draft.packCost,
                        onValueChange = { v -> edit { it.copy(packCost = v) } },
                        placeholder = "0",
                        keyboardType = KeyboardType.Decimal,
                        supporting = draft.costPerUnit()?.takeIf { draft.packCost.isNotBlank() }
                            ?.let { "Cada suelto te cuesta ${priceText(it)}" },
                    )
                }
            }

            Spacer(Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                if (full) {
                    AlDiaField(
                        label = "Precio compra$priceSuffix",
                        value = draft.purchasePrice,
                        onValueChange = { v -> edit { it.copy(purchasePrice = v) } },
                        placeholder = "0",
                        keyboardType = KeyboardType.Decimal,
                        modifier = Modifier.weight(1f),
                    )
                }
                AlDiaField(
                    label = "Precio venta$priceSuffix",
                    value = draft.salePrice,
                    onValueChange = { v -> edit { it.copy(salePrice = v) } },
                    placeholder = "0",
                    keyboardType = KeyboardType.Decimal,
                    modifier = Modifier.weight(1f),
                )
            }

            if (tracked) {
                Spacer(Modifier.height(12.dp))
                if (!draft.packOn) {
                    AlDiaField(
                        label = (if (editing == null) "Stock inicial" else "Stock") + unitSuffix,
                        value = draft.stock,
                        onValueChange = { v -> edit { it.copy(stock = v) } },
                        placeholder = "0",
                        enabled = full,
                        keyboardType = if (draft.byWeight) KeyboardType.Decimal else KeyboardType.Number,
                    )
                } else {
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        AlDiaField(
                            label = if (editing == null) "Paquetes iniciales" else "Paquetes",
                            value = draft.stockPacks,
                            onValueChange = { v -> edit { it.copy(stockPacks = v) } },
                            placeholder = "0",
                            enabled = full,
                            keyboardType = KeyboardType.Number,
                            modifier = Modifier.weight(1f),
                        )
                        AlDiaField(
                            label = "Sueltos",
                            value = draft.stockLoose,
                            onValueChange = { v -> edit { it.copy(stockLoose = v) } },
                            placeholder = "0",
                            enabled = full,
                            keyboardType = KeyboardType.Number,
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
                if (stockFix) {
                    Spacer(Modifier.height(6.dp))
                    Text(
                        "Corrección: ${stockText(editing.stock, draft)} → ${stockText(stockNow, draft)}. Queda anotada a tu nombre.",
                        style = MaterialTheme.typography.bodySmall,
                        color = AlDiaColors.TextTertiary,
                    )
                    Spacer(Modifier.height(6.dp))
                    AlDiaField(
                        value = draft.stockReason,
                        onValueChange = { v -> edit { it.copy(stockReason = v.take(200)) } },
                        placeholder = "Motivo (opcional): conteo, se rompieron...",
                    )
                }
            }

            if (editing != null && tracked) {
                Spacer(Modifier.height(12.dp))
                if (!draft.packOn) {
                    AlDiaField(
                        label = "Añadir al stock$unitSuffix",
                        value = draft.addStock,
                        onValueChange = { v -> edit { it.copy(addStock = v) } },
                        placeholder = "0",
                        keyboardType = if (draft.byWeight) KeyboardType.Decimal else KeyboardType.Number,
                        supporting = "Mercancía que llegó. Se suma al stock actual.",
                    )
                } else {
                    SectionTitle("¿Cuántos llegaron?")
                    Spacer(Modifier.height(6.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        AlDiaField(
                            label = "Paquetes",
                            value = draft.addPacks,
                            onValueChange = { v -> edit { it.copy(addPacks = v) } },
                            placeholder = "0",
                            keyboardType = KeyboardType.Number,
                            modifier = Modifier.weight(1f),
                        )
                        AlDiaField(
                            label = "Sueltos",
                            value = draft.addLoose,
                            onValueChange = { v -> edit { it.copy(addLoose = v) } },
                            placeholder = "0",
                            keyboardType = KeyboardType.Number,
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
            }

            if (error != null) {
                Spacer(Modifier.height(12.dp))
                ErrorBanner(error)
            }
            Spacer(Modifier.height(14.dp))
            PrimaryButton(
                text = when {
                    busy -> "Guardando…"
                    editing == null -> "Guardar producto"
                    else -> "Guardar cambios"
                },
                onClick = { onSave(draft) },
                enabled = !busy,
                loading = busy,
            )
            if (editing != null && owner) {
                TextButton(onClick = { confirmDelete = true }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                    Text("Eliminar producto", color = AlDiaColors.Danger)
                }
            }
            TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) {
                Text("Cancelar", color = AlDiaColors.TextSecondary)
            }
        }
    }

    if (confirmDelete && editing != null) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Eliminar producto") },
            text = { Text("¿Eliminar «${editing.name}»? No se puede deshacer.") },
            confirmButton = {
                TextButton(onClick = { confirmDelete = false; requireOwnerPin(onDelete) }) { Text("Eliminar", color = AlDiaColors.Danger) }
            },
            dismissButton = {
                TextButton(onClick = { confirmDelete = false }) { Text("Cancelar") }
            },
        )
    }
}

@Composable
private fun ToggleRow(
    title: String,
    checked: Boolean,
    onChange: (Boolean) -> Unit,
    supporting: String? = null,
) {
    Row(
        Modifier.fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .clickable { onChange(!checked) }
            .padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleSmall, color = AlDiaColors.TextPrimary)
            if (supporting != null) {
                Text(supporting, style = MaterialTheme.typography.bodySmall, color = AlDiaColors.TextTertiary)
            }
        }
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

private fun priceText(value: Double): String =
    if (value == floor(value)) Format.money(value) else Format.money2(value)

private fun stockText(stock: Double, draft: ProductDraft): String {
    val size = draft.packSize.toIntOrNull()?.takeIf { draft.packOn && it > 1 }
    return stockLabel(stock, draft.unitOrNull, true, size)
}
