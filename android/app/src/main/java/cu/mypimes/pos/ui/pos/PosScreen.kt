package cu.mypimes.pos.ui.pos

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.ShoppingCart
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.foundation.layout.heightIn
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cu.mypimes.pos.data.auth.Session
import cu.mypimes.pos.domain.Format
import cu.mypimes.pos.domain.Payment
import cu.mypimes.pos.domain.pos.CartLine
import cu.mypimes.pos.domain.pos.PaymentChoice
import cu.mypimes.pos.domain.pos.PosProduct
import cu.mypimes.pos.domain.pos.PosSale
import cu.mypimes.pos.ui.components.AlDiaCard
import cu.mypimes.pos.ui.components.AlDiaField
import cu.mypimes.pos.ui.components.EmptyBlock
import cu.mypimes.pos.ui.components.ErrorBanner
import cu.mypimes.pos.ui.components.InfoBanner
import cu.mypimes.pos.ui.components.LoadingBlock
import cu.mypimes.pos.ui.components.Pill
import cu.mypimes.pos.ui.components.PrimaryButton
import cu.mypimes.pos.ui.components.SectionTitle
import cu.mypimes.pos.ui.theme.AlDiaColors
import java.text.Normalizer
import java.util.Locale
import kotlin.math.abs
import kotlin.math.roundToInt

private fun amount(value: Double): String =
    Format.money(value, if (abs(value - value.toLong()) < 0.005) 0 else 2)

private fun normalize(value: String): String =
    Normalizer.normalize(value, Normalizer.Form.NFD)
        .replace(Regex("\\p{M}+"), "")
        .lowercase(Locale.forLanguageTag("es"))
        .trim()

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PosScreen(
    session: Session,
    onOpenHistory: () -> Unit,
    viewModel: PosViewModel = hiltViewModel(),
) {
    val collected by viewModel.state.collectAsStateWithLifecycle()
    val state = if (collected.sessionToken == session.token) collected else PosUiState(loading = true)

    var search by rememberSaveable { mutableStateOf("") }
    var adding by remember { mutableStateOf<PosProduct?>(null) }
    var cartOpen by remember { mutableStateOf(false) }
    var checkoutOpen by remember { mutableStateOf(false) }
    var receipt by remember { mutableStateOf<PosSale?>(null) }

    LaunchedEffect(session.token) {
        search = ""
        adding = null
        cartOpen = false
        checkoutOpen = false
        receipt = null
        viewModel.bindSession(session)
    }
    LaunchedEffect(state.lastSavedSale?.clientSaleId) {
        state.lastSavedSale?.let {
            receipt = it
            checkoutOpen = false
            cartOpen = false
            viewModel.dismissMessages()
        }
    }
    LaunchedEffect(state.error) {
        if (state.error != null && !checkoutOpen) cartOpen = false
    }
    BackHandler(enabled = cartOpen || checkoutOpen || receipt != null) {
        when {
            receipt != null -> receipt = null
            checkoutOpen -> checkoutOpen = false
            else -> cartOpen = false
        }
    }

    val products = remember(state.products, search) {
        val needle = normalize(search)
        // Igual que la web: lo agotado no se muestra (salvo productos por peso).
        state.products.filter { (it.unit != null || it.stock > 0) && (needle.isBlank() || normalize(it.name).contains(needle)) }
    }

    val screenWidth = LocalConfiguration.current.screenWidthDp
    val wide = screenWidth >= 840
    val cart: @Composable (dismissable: Boolean) -> Unit = { dismissable ->
        CartSheet(
            lines = state.cart,
            total = state.total,
            blocked = state.hasPendingClose,
            onQuantity = viewModel::changeQuantity,
            onRemove = viewModel::removeLine,
            onClear = viewModel::clearCart,
            onCheckout = {
                cartOpen = false
                checkoutOpen = true
            },
            onDismiss = if (dismissable) ({ cartOpen = false }) else null,
        )
    }

    Box(Modifier.fillMaxSize().background(AlDiaColors.Background)) {
        Column(Modifier.fillMaxSize().padding(end = if (wide) 380.dp else 0.dp)) {
            PosHeader(
                user = session.user.displayName,
                offline = state.refreshFailed,
                refreshing = state.refreshing,
                pending = state.pendingSales,
                onRefresh = viewModel::refresh,
                onOpenHistory = onOpenHistory,
            )
            SearchBar(search = search, onSearch = { search = it })
            if (state.error != null && !cartOpen && !checkoutOpen) {
                Column(Modifier.padding(horizontal = 16.dp)) {
                    ErrorBanner(state.error!!)
                    Spacer(Modifier.height(8.dp))
                }
            }
            if (state.hasPendingClose) {
                Column(Modifier.padding(horizontal = 16.dp)) {
                    InfoBanner(
                        "Hay un cierre de caja pendiente de sincronizar. Conéctate para confirmarlo antes de cobrar.",
                        tone = AlDiaColors.Foreign,
                    )
                    Spacer(Modifier.height(8.dp))
                }
            }
            if (state.unreviewed.isNotEmpty()) {
                val count = state.unreviewed.size
                val plural = if (count == 1) "" else "s"
                val reason = state.unreviewed.first().error?.let { "\n$it" }.orEmpty()
                Column(Modifier.padding(horizontal = 16.dp)) {
                    ErrorBanner("$count venta$plural rechazada$plural por el servidor.$reason")
                    TextButton(onClick = viewModel::acknowledgeReviews, Modifier.align(Alignment.End)) { Text("Entendido") }
                    Spacer(Modifier.height(8.dp))
                }
            }
            when {
                state.loading -> LoadingBlock()
                products.isEmpty() -> EmptyBlock(
                    title = if (search.isBlank()) "Todavía no hay productos" else "Sin resultados",
                    message = if (search.isBlank()) "Actualiza el catálogo para empezar a vender." else "Prueba con otro nombre.",
                    modifier = Modifier.padding(16.dp),
                )
                else -> LazyVerticalGrid(
                    columns = if (screenWidth >= 600) GridCells.Adaptive(160.dp) else GridCells.Fixed(2),
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 120.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    items(products, key = { it.id }) { product ->
                        val inCart = state.cart.filter { it.product.id == product.id }.sumOf { it.stockUnits }
                        ProductCard(
                            product = product,
                            inCart = inCart,
                            oversell = state.central,
                            onTap = {
                                // Por peso se pide la cantidad; el resto añade 1 suelto al instante.
                                if (product.unit != null) adding = product
                                else viewModel.addProduct(product, 1.0, false)
                            },
                            onPack = { viewModel.addProduct(product, 1.0, true) },
                        )
                    }
                }
            }
        }

        if (state.cart.isNotEmpty() && !wide) {
            CartBar(
                count = state.cartCount,
                total = state.total,
                enabled = !state.hasPendingClose,
                onOpen = { cartOpen = true },
                modifier = Modifier.align(Alignment.BottomCenter),
            )
        }
        if (wide) {
            Surface(
                modifier = Modifier.align(Alignment.CenterEnd).width(380.dp).fillMaxHeight(),
                color = AlDiaColors.Surface,
            ) {
                Column(Modifier.padding(top = 14.dp)) { cart(false) }
            }
        }
    }

    adding?.let { product ->
        AddProductSheet(
            product = product,
            inCart = state.cart.filter { it.product.id == product.id }.sumOf { it.quantity },
            onDismiss = { adding = null },
            onAdd = { quantity ->
                viewModel.setWeightQuantity(product, quantity)
                adding = null
            },
            onError = { adding = null },
        )
    }

    if (cartOpen) {
        ModalBottomSheet(
            onDismissRequest = { cartOpen = false },
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            containerColor = AlDiaColors.Surface,
        ) {
            cart(true)
        }
    }

    if (checkoutOpen) {
        ModalBottomSheet(
            onDismissRequest = { checkoutOpen = false },
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            containerColor = AlDiaColors.Surface,
        ) {
            CheckoutSheet(
                total = state.total,
                userRates = state.rates,
                transferLimit = session.user.transferLimit,
                submitting = state.syncing,
                error = state.error,
                onSetDeviceRate = viewModel::setDeviceRate,
                onConfirm = { choice -> viewModel.checkout(session, choice) },
                onDismiss = { checkoutOpen = false },
            )
        }
    }

    receipt?.let { sale ->
        ModalBottomSheet(
            onDismissRequest = { receipt = null },
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            containerColor = AlDiaColors.Surface,
        ) {
            ReceiptSheet(sale = sale, onDone = { receipt = null })
        }
    }
}

@Composable
private fun PosHeader(
    user: String,
    offline: Boolean,
    refreshing: Boolean,
    pending: Int,
    onRefresh: () -> Unit,
    onOpenHistory: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().padding(start = 20.dp, end = 12.dp, top = 14.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text("Venta", style = MaterialTheme.typography.headlineMedium, color = AlDiaColors.TextPrimary)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(user, style = MaterialTheme.typography.bodySmall, color = AlDiaColors.TextSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (offline) {
                    Spacer(Modifier.width(8.dp))
                    Pill("Sin conexión", AlDiaColors.Warning, AlDiaColors.WarningSoft)
                } else if (pending > 0) {
                    Spacer(Modifier.width(8.dp))
                    Pill("$pending sin subir", AlDiaColors.Warning, AlDiaColors.WarningSoft)
                }
            }
        }
        IconButton(onClick = onOpenHistory) {
            Icon(Icons.Default.ShoppingCart, contentDescription = "Historial", tint = AlDiaColors.TextSecondary)
        }
        IconButton(onClick = onRefresh, enabled = !refreshing) {
            if (refreshing) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = AlDiaColors.Blue)
            else Icon(Icons.Default.Refresh, contentDescription = "Actualizar", tint = AlDiaColors.TextSecondary)
        }
    }
}

@Composable
private fun SearchBar(search: String, onSearch: (String) -> Unit) {
    OutlinedTextField(
        value = search,
        onValueChange = onSearch,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
        placeholder = { Text("Buscar producto", color = AlDiaColors.TextTertiary) },
        leadingIcon = { Icon(Icons.Default.Search, contentDescription = null, tint = AlDiaColors.TextTertiary) },
        trailingIcon = {
            if (search.isNotEmpty()) {
                IconButton(onClick = { onSearch("") }) {
                    Icon(Icons.Default.Close, contentDescription = "Limpiar", tint = AlDiaColors.TextTertiary)
                }
            }
        },
        singleLine = true,
        shape = RoundedCornerShape(14.dp),
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = AlDiaColors.Blue,
            unfocusedBorderColor = Color.Transparent,
            focusedContainerColor = Color.White,
            unfocusedContainerColor = Color.White,
        ),
    )
}

@Composable
private fun ProductCard(
    product: PosProduct,
    inCart: Double,
    onTap: () -> Unit,
    onPack: () -> Unit,
    /** Caja central: el stock local no limita lo que se añade al carrito (A7b). */
    oversell: Boolean = false,
) {
    val low = product.trackStock && product.stock <= 5
    // Igual que la web: no se puede añadir más que el stock; el paquete cuenta sus unidades.
    val full = !oversell && product.trackStock && inCart >= product.stock
    val packSize = product.packSize
    val hasPack = packSize != null && product.packPrice != null && product.unit == null
    val packFull = !oversell && product.trackStock && packSize != null && inCart + packSize > product.stock
    Surface(
        onClick = onTap,
        enabled = !full,
        shape = RoundedCornerShape(18.dp),
        color = Color.White,
        border = BorderStroke(1.dp, AlDiaColors.BorderSoft),
    ) {
        Column(Modifier.padding(14.dp).heightIn(min = 116.dp), verticalArrangement = Arrangement.SpaceBetween) {
            Column {
                Text(
                    product.name,
                    style = MaterialTheme.typography.titleSmall,
                    color = AlDiaColors.TextPrimary,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.height(4.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                    if (product.packSize != null) Pill("Paquete x${product.packSize}", AlDiaColors.Blue, AlDiaColors.BlueSoft)
                    if (product.unit != null) Pill(product.unit, AlDiaColors.Euro, AlDiaColors.EuroSoft)
                }
                if (inCart > 0) {
                    Spacer(Modifier.height(4.dp))
                    Pill(
                        if (product.unit != null) "${Format.quantity(inCart)} ${product.unit} en carrito"
                        else "${Format.quantity(inCart)} en carrito",
                        AlDiaColors.Success,
                        AlDiaColors.SuccessSoft,
                    )
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.Bottom) {
                Column {
                    Text(amount(product.salePrice), style = MaterialTheme.typography.titleMedium, color = AlDiaColors.TextPrimary)
                    if (product.trackStock) {
                        Text(
                            if (product.unit != null) "${Format.quantity(product.stock)} ${product.unit}"
                            else "${Format.quantity(product.stock)} disponibles",
                            style = MaterialTheme.typography.labelSmall,
                            color = if (low) AlDiaColors.Danger else AlDiaColors.TextTertiary,
                        )
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (hasPack) {
                        Surface(
                            onClick = onPack,
                            enabled = !packFull,
                            shape = RoundedCornerShape(10.dp),
                            color = if (packFull) AlDiaColors.SurfaceMuted else AlDiaColors.BlueSoft,
                        ) {
                            Text(
                                "Paq. x$packSize",
                                modifier = Modifier.padding(horizontal = 8.dp, vertical = 6.dp),
                                style = MaterialTheme.typography.labelSmall,
                                color = if (packFull) AlDiaColors.TextTertiary else AlDiaColors.Blue,
                            )
                        }
                    }
                    Box(
                        Modifier.size(30.dp).clip(CircleShape).background(if (full) AlDiaColors.SurfaceMuted else AlDiaColors.BlueSoft),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            Icons.Default.Add,
                            contentDescription = "Añadir",
                            tint = if (full) AlDiaColors.TextTertiary else AlDiaColors.Blue,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun CartBar(
    count: Double,
    total: Double,
    enabled: Boolean,
    onOpen: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier = modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
        shape = RoundedCornerShape(20.dp),
        color = AlDiaColors.TextPrimary,
        shadowElevation = 8.dp,
    ) {
        Row(
            Modifier.clickable(enabled = enabled, onClick = onOpen).padding(horizontal = 18.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Default.ShoppingCart, contentDescription = null, tint = Color.White, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text("${Format.quantity(count)} artículos", style = MaterialTheme.typography.bodySmall, color = Color.White.copy(alpha = 0.7f))
                Text(amount(total), style = MaterialTheme.typography.titleLarge, color = Color.White)
            }
            Surface(color = AlDiaColors.Blue, shape = RoundedCornerShape(12.dp)) {
                Text(
                    if (enabled) "Cobrar" else "Cierre pendiente",
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 9.dp),
                    style = MaterialTheme.typography.labelLarge,
                    color = Color.White,
                )
            }
        }
    }
}

@Composable
private fun CartSheet(
    lines: List<CartLine>,
    total: Double,
    blocked: Boolean,
    onQuantity: (Int, Double) -> Unit,
    onRemove: (Int) -> Unit,
    onClear: () -> Unit,
    onCheckout: () -> Unit,
    onDismiss: (() -> Unit)?,
) {
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 24.dp).imePadding(),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("Carrito", style = MaterialTheme.typography.headlineSmall, color = AlDiaColors.TextPrimary, modifier = Modifier.weight(1f))
            TextButton(onClick = onClear) { Text("Vaciar", color = AlDiaColors.Danger) }
        }
        Spacer(Modifier.height(8.dp))
        Column(Modifier.verticalScroll(rememberScrollState()).weight(1f, fill = false)) {
            lines.forEachIndexed { index, line ->
                CartLineRow(
                    line = line,
                    onChange = { onQuantity(index, it) },
                    onRemove = { onRemove(index) },
                )
                HorizontalDivider(color = AlDiaColors.BorderSoft)
            }
        }
        Spacer(Modifier.height(12.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text("Total", style = MaterialTheme.typography.titleMedium, color = AlDiaColors.TextSecondary)
            Text(amount(total), style = MaterialTheme.typography.headlineMedium, color = AlDiaColors.TextPrimary)
        }
        if (blocked) {
            Spacer(Modifier.height(10.dp))
            InfoBanner("Cierra la caja pendiente antes de cobrar otra venta.", tone = AlDiaColors.Foreign)
        }
        Spacer(Modifier.height(14.dp))
        PrimaryButton("Cobrar ${amount(total)}", onCheckout, enabled = !blocked && lines.isNotEmpty())
        if (onDismiss != null) {
            Spacer(Modifier.height(6.dp))
            TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) {
                Text("Seguir vendiendo", color = AlDiaColors.TextSecondary)
            }
        }
    }
}

@Composable
private fun CartLineRow(line: CartLine, onChange: (Double) -> Unit, onRemove: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(
                line.product.name + if (line.isPack) " · paquete x${line.product.packSize}" else "",
                style = MaterialTheme.typography.bodyLarge,
                color = AlDiaColors.TextPrimary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                "${Format.quantity(line.quantity)} × ${amount(line.unitPrice)}",
                style = MaterialTheme.typography.bodySmall,
                color = AlDiaColors.TextSecondary,
            )
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            StepButton("−") { onChange((line.quantity - stepFor(line)).coerceAtLeast(0.0)) }
            Text(
                Format.quantity(line.quantity),
                modifier = Modifier.width(46.dp),
                style = MaterialTheme.typography.titleSmall,
                color = AlDiaColors.TextPrimary,
            )
            StepButton("+") { onChange(line.quantity + stepFor(line)) }
        }
        Spacer(Modifier.width(6.dp))
        Text(amount(line.lineTotal), style = MaterialTheme.typography.titleSmall, color = AlDiaColors.TextPrimary)
        IconButton(onClick = onRemove, modifier = Modifier.size(34.dp)) {
            Icon(Icons.Default.Delete, contentDescription = "Quitar", tint = AlDiaColors.TextTertiary, modifier = Modifier.size(17.dp))
        }
    }
}

private fun stepFor(line: CartLine): Double = if (line.product.unit != null) 0.25 else 1.0

@Composable
private fun StepButton(text: String, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        shape = CircleShape,
        color = AlDiaColors.SurfaceMuted,
        modifier = Modifier.size(30.dp),
    ) {
        Box(contentAlignment = Alignment.Center) {
            Text(text, style = MaterialTheme.typography.titleMedium, color = AlDiaColors.TextPrimary)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AddProductSheet(
    product: PosProduct,
    inCart: Double,
    onDismiss: () -> Unit,
    onAdd: (Double) -> Unit,
    onError: () -> Unit,
) {
    // La cantidad ya en carrito se muestra para corregirla: al confirmar se fija, no se suma.
    var quantity by rememberSaveable { mutableStateOf(if (inCart > 0) trimNumber(inCart) else "1") }
    val parsed = quantity.replace(',', '.').toDoubleOrNull()
    val valid = parsed != null && parsed > 0
    val focusRequester = remember { FocusRequester() }
    LaunchedEffect(Unit) { focusRequester.requestFocus() }
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = AlDiaColors.Surface,
    ) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 28.dp).imePadding()) {
            Text(product.name, style = MaterialTheme.typography.headlineSmall, color = AlDiaColors.TextPrimary)
            Spacer(Modifier.height(4.dp))
            Text(
                if (product.trackStock) "Hay ${Format.quantity(product.stock)} ${product.unit}" else "Sin control de stock",
                style = MaterialTheme.typography.bodySmall,
                color = AlDiaColors.TextSecondary,
            )
            Spacer(Modifier.height(18.dp))
            SectionTitle("Cantidad (${product.unit})")
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                StepButton("−") {
                    val current = parsed ?: 1.0
                    quantity = trimNumber((current - 0.25).coerceAtLeast(0.0))
                }
                OutlinedTextField(
                    value = quantity,
                    onValueChange = { quantity = it },
                    modifier = Modifier.weight(1f).padding(horizontal = 10.dp).focusRequester(focusRequester),
                    singleLine = true,
                    textStyle = MaterialTheme.typography.headlineSmall.copy(fontWeight = FontWeight.Bold),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal, imeAction = ImeAction.Done),
                    shape = RoundedCornerShape(14.dp),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = AlDiaColors.Blue,
                        unfocusedBorderColor = AlDiaColors.Border,
                    ),
                )
                StepButton("+") {
                    val current = parsed ?: 0.0
                    quantity = trimNumber(current + 0.25)
                }
            }
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                QUICK_WEIGHTS.forEach { q ->
                    ChoicePill(trimNumber(q), parsed == q) { quantity = trimNumber(q) }
                }
            }
            Spacer(Modifier.height(18.dp))
            InfoBanner("Total: ${amount((parsed ?: 0.0) * product.salePrice)}")
            Spacer(Modifier.height(14.dp))
            PrimaryButton(
                if (inCart > 0) "Actualizar cantidad" else "Añadir al carrito",
                onClick = { if (valid) onAdd(parsed!!) else onError() },
                enabled = valid,
            )
            TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) {
                Text("Cancelar", color = AlDiaColors.TextSecondary)
            }
        }
    }
}

private val QUICK_WEIGHTS = listOf(0.25, 0.5, 1.0, 2.0)

private fun trimNumber(value: Double): String =
    if (abs(value - value.toLong()) < 0.0005) value.toLong().toString()
    else String.format(Locale.US, "%.2f", value).trimEnd('0').trimEnd('.')

@Composable
private fun ChoicePill(text: String, selected: Boolean, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(12.dp),
        color = if (selected) AlDiaColors.Blue else AlDiaColors.SurfaceMuted,
    ) {
        Text(
            text,
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
            style = MaterialTheme.typography.labelLarge,
            color = if (selected) Color.White else AlDiaColors.TextSecondary,
        )
    }
}

@Composable
private fun CheckoutSheet(
    total: Double,
    userRates: Map<String, cu.mypimes.pos.data.auth.EffectiveRate>,
    transferLimit: Double?,
    submitting: Boolean,
    error: String?,
    onSetDeviceRate: (String, Double?) -> Unit,
    onConfirm: (PaymentChoice) -> Unit,
    onDismiss: () -> Unit,
) {
    var method by rememberSaveable { mutableStateOf("efectivo") }
    var cashInput by rememberSaveable { mutableStateOf("") }
    var transferInput by rememberSaveable { mutableStateOf(Payment.initialTransfer(total, transferLimit).let(::trimNumber)) }
    var currency by rememberSaveable { mutableStateOf("USD") }
    var foreignInput by rememberSaveable { mutableStateOf("") }
    var editingRate by rememberSaveable { mutableStateOf(false) }
    var rateDraft by rememberSaveable { mutableStateOf("") }

    val effective = userRates[currency]
    val rate = effective?.rate
    val cash = Payment.cashPaymentBreakdown(total, cashInput)
    val cap = Payment.maxTransfer(total, transferLimit)
    val transfer = Payment.clampTransfer(transferInput, total, transferLimit)
    val foreignAmount = foreignInput.replace(',', '.').toDoubleOrNull() ?: 0.0
    val foreign = Payment.foreignBreakdown(total, foreignAmount, rate ?: 0.0)
    val foreignValid = foreignAmount > 0 && rate != null && rate > 0 && foreign.foreignCup <= total + 0.005

    val canConfirm = when (method) {
        "transferencia" -> true
        "mixto" -> transfer > 0
        "divisa" -> foreignValid
        else -> cash.canConfirm
    }

    Column(
        Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 24.dp).imePadding().verticalScroll(rememberScrollState()),
    ) {
        Text("Cobrar", style = MaterialTheme.typography.headlineSmall, color = AlDiaColors.TextPrimary)
        Text(amount(total), style = MaterialTheme.typography.headlineLarge, color = AlDiaColors.TextPrimary)
        Spacer(Modifier.height(16.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            MethodPill("Efectivo", "efectivo", method, AlDiaColors.Cash, Modifier.weight(1f)) { method = it }
            MethodPill("Transfer.", "transferencia", method, AlDiaColors.Transfer, Modifier.weight(1f)) { method = it }
            MethodPill("Mixto", "mixto", method, AlDiaColors.Euro, Modifier.weight(1f)) { method = it }
            MethodPill("Divisa", "divisa", method, AlDiaColors.Foreign, Modifier.weight(1f)) { method = it }
        }
        Spacer(Modifier.height(18.dp))

        when (method) {
            "transferencia" -> {
                AlDiaCard(Modifier.fillMaxWidth()) {
                    Column {
                        SectionTitle("Transferencia")
                        Spacer(Modifier.height(8.dp))
                        Text(
                            "Cobra los ${amount(total)} completos por transferencia.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = AlDiaColors.TextSecondary,
                        )
                        if (transferLimit != null) {
                            Spacer(Modifier.height(8.dp))
                            Pill("Tope de la tienda: ${amount(transferLimit)}", AlDiaColors.Transfer, AlDiaColors.TransferSoft)
                        }
                    }
                }
            }
            "mixto" -> {
                SectionTitle("Parte por transferencia")
                Spacer(Modifier.height(8.dp))
                AlDiaField(
                    value = transferInput,
                    onValueChange = { transferInput = it },
                    placeholder = "0",
                    keyboardType = KeyboardType.Decimal,
                    big = true,
                    supporting = "Máximo ${amount(cap)}. El resto se cobra en efectivo.",
                )
                Spacer(Modifier.height(10.dp))
                Slider(
                    value = transfer.toFloat().coerceIn(0f, cap.toFloat().coerceAtLeast(0.001f)),
                    onValueChange = { transferInput = trimNumber(it.toDouble()) },
                    valueRange = 0f..cap.toFloat().coerceAtLeast(0.001f),
                    colors = SliderDefaults.colors(
                        thumbColor = AlDiaColors.Blue,
                        activeTrackColor = AlDiaColors.Blue,
                        inactiveTrackColor = AlDiaColors.Border,
                    ),
                )
                Spacer(Modifier.height(6.dp))
                AlDiaCard(Modifier.fillMaxWidth()) {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        KeyValueLine("Transferencia", amount(transfer), AlDiaColors.Transfer)
                        KeyValueLine("Efectivo", amount((total - transfer).coerceAtLeast(0.0)), AlDiaColors.Cash, bold = true)
                    }
                }
            }
            "divisa" -> {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    ChoicePill("USD", currency == "USD") { currency = "USD" }
                    ChoicePill("EUR", currency == "EUR") { currency = "EUR" }
                }
                Spacer(Modifier.height(12.dp))
                RateRow(
                    currency = currency,
                    effective = effective,
                    editing = editingRate || rate == null,
                    draft = rateDraft,
                    onDraft = { rateDraft = it },
                    onEdit = {
                        rateDraft = rate?.let(::trimNumber) ?: ""
                        editingRate = true
                    },
                    onSave = {
                        val value = rateDraft.replace(',', '.').toDoubleOrNull()
                        if (value != null && value > 0) {
                            onSetDeviceRate(currency, value)
                            editingRate = false
                        }
                    },
                )
                Spacer(Modifier.height(14.dp))
                SectionTitle("¿Cuántos $currency entregó el cliente?")
                Spacer(Modifier.height(8.dp))
                AlDiaField(
                    value = foreignInput,
                    onValueChange = { foreignInput = it },
                    placeholder = "0",
                    keyboardType = KeyboardType.Decimal,
                    big = true,
                    supporting = if (rate != null) "Vale ${amount(foreign.foreignCup)} en pesos." else "Escribe primero la tasa.",
                )
                Spacer(Modifier.height(10.dp))
                if (foreignValid) {
                    AlDiaCard(Modifier.fillMaxWidth()) {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            KeyValueLine("Divisa recibida", "${Format.foreign(foreignAmount)} $currency", AlDiaColors.Foreign)
                            if (foreign.cashToCollect > 0) {
                                KeyValueLine("Faltan en efectivo", amount(foreign.cashToCollect), AlDiaColors.Cash, bold = true)
                            }
                            if (foreign.change > 0) {
                                KeyValueLine("Vuelto en efectivo", amount(foreign.change), AlDiaColors.Success, bold = true)
                            }
                        }
                    }
                }
            }
            else -> {
                SectionTitle("Efectivo recibido")
                Spacer(Modifier.height(8.dp))
                AlDiaField(
                    value = cashInput,
                    onValueChange = { cashInput = it },
                    placeholder = "0",
                    keyboardType = KeyboardType.Decimal,
                    big = true,
                    supporting = "Total a cobrar: ${amount(total)}",
                )
                Spacer(Modifier.height(10.dp))
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(quickAmounts(total)) { value ->
                        Surface(
                            onClick = { cashInput = trimNumber(value) },
                            shape = RoundedCornerShape(12.dp),
                            color = AlDiaColors.SurfaceMuted,
                        ) {
                            Text(
                                amount(value),
                                modifier = Modifier.padding(horizontal = 14.dp, vertical = 9.dp),
                                style = MaterialTheme.typography.labelLarge,
                                color = AlDiaColors.TextPrimary,
                            )
                        }
                    }
                }
                Spacer(Modifier.height(12.dp))
                if (cash.validAmount) {
                    AlDiaCard(Modifier.fillMaxWidth()) {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            KeyValueLine("Recibido", amount(cash.receivedCents!! / 100.0), AlDiaColors.TextPrimary)
                            if (cash.canConfirm) {
                                KeyValueLine("Vuelto", amount(cash.changeCents / 100.0), AlDiaColors.Success, bold = true)
                            } else {
                                KeyValueLine("Faltan", amount(cash.shortfallCents / 100.0), AlDiaColors.Danger, bold = true)
                            }
                        }
                    }
                }
            }
        }

        if (error != null) {
            Spacer(Modifier.height(12.dp))
            ErrorBanner(error)
        }

        Spacer(Modifier.height(18.dp))
        PrimaryButton(
            if (submitting) "Cobrando…" else "Confirmar cobro",
            onClick = {
                val choice = when (method) {
                    "transferencia" -> PaymentChoice(method = "transferencia")
                    "mixto" -> PaymentChoice(method = "mixto", transferAmount = transfer)
                    "divisa" -> PaymentChoice(
                        method = "divisa", currency = currency, foreignAmount = foreignAmount,
                        exchangeRate = rate, shopRate = effective?.shopRate,
                    )
                    else -> PaymentChoice(method = "efectivo", cashReceived = cashInput)
                }
                onConfirm(choice)
            },
            enabled = canConfirm,
            loading = submitting,
        )
        TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth(), enabled = !submitting) {
            Text("Cancelar", color = AlDiaColors.TextSecondary)
        }
    }
}

@Composable
private fun MethodPill(
    text: String,
    value: String,
    selected: String,
    color: Color,
    modifier: Modifier = Modifier,
    onClick: (String) -> Unit,
) {
    Surface(
        onClick = { onClick(value) },
        shape = RoundedCornerShape(12.dp),
        color = if (selected == value) color else AlDiaColors.SurfaceMuted,
        modifier = modifier,
    ) {
        Text(
            text,
            modifier = Modifier.padding(vertical = 11.dp),
            style = MaterialTheme.typography.labelLarge,
            color = if (selected == value) Color.White else AlDiaColors.TextSecondary,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
    }
}

@Composable
private fun RateRow(
    currency: String,
    effective: cu.mypimes.pos.data.auth.EffectiveRate?,
    editing: Boolean,
    draft: String,
    onDraft: (String) -> Unit,
    onEdit: () -> Unit,
    onSave: () -> Unit,
) {
    AlDiaCard(Modifier.fillMaxWidth()) {
        if (editing) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("1 $currency =", style = MaterialTheme.typography.bodyMedium, color = AlDiaColors.TextSecondary)
                Spacer(Modifier.width(8.dp))
                OutlinedTextField(
                    value = draft,
                    onValueChange = onDraft,
                    modifier = Modifier.weight(1f),
                    singleLine = true,
                    textStyle = MaterialTheme.typography.titleMedium,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    shape = RoundedCornerShape(10.dp),
                )
                TextButton(onClick = onSave) { Text("OK", color = AlDiaColors.Foreign, fontWeight = FontWeight.Bold) }
            }
        } else {
            Row(Modifier.fillMaxWidth().clickable(onClick = onEdit), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(
                        "1 $currency = ${amount(effective?.rate ?: 0.0)}",
                        style = MaterialTheme.typography.titleSmall,
                        color = AlDiaColors.TextPrimary,
                    )
                    Text(
                        if (effective?.usesDeviceRate == true) "Tasa de este aparato" else "Tasa de la tienda",
                        style = MaterialTheme.typography.labelSmall,
                        color = AlDiaColors.TextTertiary,
                    )
                }
                Text("Cambiar", style = MaterialTheme.typography.labelLarge, color = AlDiaColors.Foreign)
            }
        }
    }
}

@Composable
private fun KeyValueLine(label: String, value: String, color: Color, bold: Boolean = false) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = AlDiaColors.TextSecondary)
        Text(
            value,
            style = if (bold) MaterialTheme.typography.titleMedium else MaterialTheme.typography.bodyLarge,
            color = color,
            fontWeight = if (bold) FontWeight.Bold else FontWeight.Medium,
        )
    }
}

private fun quickAmounts(total: Double): List<Double> {
    val rounded = Math.ceil(total).toDouble()
    val candidates = listOf(rounded, Math.ceil(total / 5) * 5.0, Math.ceil(total / 10) * 10.0, Math.ceil(total / 50) * 50.0, Math.ceil(total / 100) * 100.0)
    return candidates.distinct().filter { it >= total }
}

@Composable
private fun ReceiptSheet(sale: PosSale, onDone: () -> Unit) {
    val color = if (sale.status == "synced") AlDiaColors.Success else AlDiaColors.Warning
    val label = when (sale.status) {
        "synced" -> "Venta registrada"
        "rejected", "blocked", "conflict" -> "Venta guardada para revisión"
        else -> "Venta guardada"
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = 22.dp).padding(bottom = 28.dp)) {
        Box(
            Modifier.size(52.dp).clip(CircleShape).background(color.copy(alpha = 0.12f)),
            contentAlignment = Alignment.Center,
        ) {
            Text("✓", style = MaterialTheme.typography.headlineMedium, color = color)
        }
        Spacer(Modifier.height(12.dp))
        Text(label, style = MaterialTheme.typography.headlineSmall, color = AlDiaColors.TextPrimary)
        Text(amount(sale.total), style = MaterialTheme.typography.headlineLarge, color = AlDiaColors.TextPrimary)
        Spacer(Modifier.height(14.dp))
        AlDiaCard(Modifier.fillMaxWidth()) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                KeyValueLine("Cobro", sale.label, AlDiaColors.TextPrimary)
                when (sale.paymentMethod) {
                    "efectivo" -> {
                        val change = (sale.cashReceived - sale.total).coerceAtLeast(0.0)
                        KeyValueLine("Recibido", amount(sale.cashReceived), AlDiaColors.TextSecondary)
                        KeyValueLine("Vuelto", amount(change), AlDiaColors.Success, bold = true)
                    }
                    "mixto" -> {
                        val transfer = sale.transferAmount ?: 0.0
                        KeyValueLine("Transferencia", amount(transfer), AlDiaColors.Transfer)
                        KeyValueLine("Efectivo", amount((sale.total - transfer).coerceAtLeast(0.0)), AlDiaColors.Cash)
                    }
                    "divisa" -> {
                        KeyValueLine(
                            "Divisa",
                            "${Format.foreign(sale.foreignAmount ?: 0.0)} ${sale.foreignCurrency ?: ""} a ${amount(sale.exchangeRate ?: 0.0)}",
                            AlDiaColors.Foreign,
                        )
                        val cup = Payment.round2((sale.foreignAmount ?: 0.0) * (sale.exchangeRate ?: 0.0))
                        val rest = Payment.round2(sale.total - cup)
                        if (rest > 0) KeyValueLine("Faltó en efectivo", amount(rest), AlDiaColors.Cash)
                        if (rest < 0) KeyValueLine("Vuelto", amount(-rest), AlDiaColors.Success)
                    }
                }
                if (sale.error != null) {
                    Text(sale.error, style = MaterialTheme.typography.bodySmall, color = AlDiaColors.Warning)
                }
                if (sale.stockShort && !sale.isSynced) {
                    Text(STOCK_SHORT_NOTICE, style = MaterialTheme.typography.bodySmall, color = AlDiaColors.Warning)
                }
            }
        }
        Spacer(Modifier.height(16.dp))
        PrimaryButton("Nueva venta", onDone)
    }
}
