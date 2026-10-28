package cu.mypimes.pos.ui.store

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CurrencyExchange
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
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
import cu.mypimes.pos.domain.Format
import cu.mypimes.pos.domain.Payment
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

/** Tasas de la tienda (dueño). Como ShopRatesCard de la web: cambiarlas necesita internet. */
@Composable
private fun ShopRatesCard(state: StoreUiState, session: Session, onSave: (String, String) -> Unit) {
    val shopUsd = session.user.usdRate
    val shopEur = session.user.eurRate
    var usd by rememberSaveable(shopUsd) { mutableStateOf(shopUsd?.toString() ?: "") }
    var eur by rememberSaveable(shopEur) { mutableStateOf(shopEur?.toString() ?: "") }
    fun typed(text: String): Double? = text.trim().replace(',', '.').takeIf { it.isNotEmpty() }?.toDoubleOrNull()
    val changed = typed(usd) != shopUsd || typed(eur) != shopEur

    AlDiaCard(Modifier.fillMaxWidth()) {
        Column {
            SectionTitle("Tasa de cambio de la tienda")
            Spacer(Modifier.height(4.dp))
            Text(
                "Los cajeros la pueden cambiar en su aparato; esas ventas te salen marcadas. Cambiarla necesita internet.",
                style = MaterialTheme.typography.labelSmall,
                color = AlDiaColors.TextTertiary,
            )
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AlDiaField(
                    label = "1 USD en pesos",
                    value = usd,
                    onValueChange = { usd = it },
                    modifier = Modifier.weight(1f),
                    placeholder = "Sin tasa",
                    keyboardType = KeyboardType.Decimal,
                    supporting = shopUsd?.let { "Ahora: ${Format.rate(it)}" },
                )
                AlDiaField(
                    label = "1 EUR en pesos",
                    value = eur,
                    onValueChange = { eur = it },
                    modifier = Modifier.weight(1f),
                    placeholder = "Sin tasa",
                    keyboardType = KeyboardType.Decimal,
                    supporting = shopEur?.let { "Ahora: ${Format.rate(it)}" },
                )
            }
            if (changed) {
                Spacer(Modifier.height(12.dp))
                PrimaryButton(
                    if (state.busy) "Guardando…" else "Guardar tasa de la tienda",
                    onClick = { onSave(usd, eur) },
                    enabled = !state.busy,
                    loading = state.busy,
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DivisasScreen(session: Session, viewModel: StoreViewModel) {
    val collected by viewModel.state.collectAsStateWithLifecycle()
    val state = if (collected.sessionToken == session.token) collected else StoreUiState(loading = true)
    val rates = state.rates

    var currency by rememberSaveable { mutableStateOf("USD") }
    var amount by rememberSaveable { mutableStateOf("") }
    var rateDraft by rememberSaveable { mutableStateOf("") }
    var editingRate by rememberSaveable { mutableStateOf(false) }

    val effective = rates[currency]
    val shopRate = effective?.shopRate
    val typedRate = rateDraft.replace(',', '.').toDoubleOrNull()
    val rate = if (editingRate) typedRate else effective?.rate
    val typed = amount.replace(',', '.').toDoubleOrNull()
    val validAmount = typed != null && typed > 0
    val validRate = rate != null && rate > 0
    val cup = if (validAmount && validRate) Payment.purchaseCup(typed!!, rate!!) else 0.0
    val differs = validRate && shopRate != null && kotlin.math.abs(rate!! - shopRate) > 0.005
    var pickedCurrency by remember { mutableStateOf(false) }

    LaunchedEffect(session.token) { viewModel.bindSession(session) }
    LaunchedEffect(state.rates) {
        if (!pickedCurrency && state.rates.isNotEmpty()) {
            currency = if (state.rates["USD"]?.rate == null && state.rates["EUR"]?.rate != null) "EUR" else "USD"
            pickedCurrency = true
        }
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
        Row(Modifier.fillMaxWidth().padding(top = 14.dp, bottom = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier.size(42.dp).clip(CircleShape).background(AlDiaColors.WarningSoft),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Default.CurrencyExchange, contentDescription = null, tint = AlDiaColors.Foreign, modifier = Modifier.size(22.dp))
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text("Divisas", style = MaterialTheme.typography.headlineMedium, color = AlDiaColors.TextPrimary)
                Text("Le compras billetes a alguien y pagas en pesos.", style = MaterialTheme.typography.bodySmall, color = AlDiaColors.TextSecondary)
            }
            IconButton(onClick = { viewModel.refresh(session) }, enabled = !state.refreshing) {
                if (state.refreshing) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = AlDiaColors.Blue)
                else Icon(Icons.Default.Refresh, contentDescription = "Actualizar", tint = AlDiaColors.TextSecondary)
            }
        }

        if (state.notice != null) {
            InfoBanner(state.notice!!, tone = AlDiaColors.Success)
            Spacer(Modifier.height(8.dp))
        }
        if (state.error != null) {
            ErrorBanner(state.error!!)
            Spacer(Modifier.height(8.dp))
        }

        AlDiaCard(Modifier.fillMaxWidth()) {
            Column {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    CurrencyChoice("USD", currency, AlDiaColors.Cash, Modifier.weight(1f)) {
                        currency = it; amount = ""; rateDraft = ""; editingRate = false
                    }
                    CurrencyChoice("EUR", currency, AlDiaColors.Euro, Modifier.weight(1f)) {
                        currency = it; amount = ""; rateDraft = ""; editingRate = false
                    }
                }
                Spacer(Modifier.height(14.dp))
                SectionTitle("A cuánto lo compras")
                Spacer(Modifier.height(6.dp))
                if (editingRate) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("1 $currency =", style = MaterialTheme.typography.bodyMedium, color = AlDiaColors.TextSecondary)
                        Spacer(Modifier.width(8.dp))
                        OutlinedTextField(
                            value = rateDraft,
                            onValueChange = { rateDraft = it },
                            modifier = Modifier.weight(1f),
                            singleLine = true,
                            placeholder = { Text("0", color = AlDiaColors.TextTertiary) },
                            textStyle = MaterialTheme.typography.titleMedium,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                            shape = RoundedCornerShape(12.dp),
                        )
                        TextButton(onClick = {
                            if (validRate) editingRate = false
                            else rateDraft = effective?.rate?.let { Format.foreign(it) } ?: ""
                        }) {
                            Text("OK", color = AlDiaColors.Foreign, fontWeight = FontWeight.Bold)
                        }
                    }
                } else {
                    Surface(
                        onClick = {
                            rateDraft = effective?.rate?.let { Format.foreign(it) } ?: ""
                            editingRate = true
                        },
                        shape = RoundedCornerShape(12.dp),
                        color = AlDiaColors.SurfaceMuted,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Row(Modifier.padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                if (validRate) "1 $currency = ${Format.rate(rate)}" else "Escribe la tasa",
                                style = MaterialTheme.typography.titleSmall,
                                color = if (validRate) AlDiaColors.TextPrimary else AlDiaColors.Danger,
                                modifier = Modifier.weight(1f),
                            )
                            Text("Cambiar", style = MaterialTheme.typography.labelLarge, color = AlDiaColors.Blue)
                        }
                    }
                    if (shopRate == null) {
                        Spacer(Modifier.height(4.dp))
                        Text(
                            "La tienda no tiene tasa puesta: escribe a cuánto compras.",
                            style = MaterialTheme.typography.labelSmall,
                            color = AlDiaColors.Warning,
                        )
                    } else {
                        Text(
                            if (effective?.usesDeviceRate == true) "Usando la tasa de este aparato." else "Usando la tasa de la tienda.",
                            style = MaterialTheme.typography.labelSmall,
                            color = AlDiaColors.TextTertiary,
                        )
                    }
                }
                Spacer(Modifier.height(14.dp))
                AlDiaField(
                    label = "¿Cuántos $currency compras?",
                    value = amount,
                    onValueChange = { amount = it },
                    placeholder = "0",
                    keyboardType = KeyboardType.Decimal,
                    big = true,
                )
                if (validAmount && validRate) {
                    Spacer(Modifier.height(12.dp))
                    AlDiaCard(Modifier.fillMaxWidth()) {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            KeyValueRow("Pagas en pesos", Format.money(cup, 2), bold = true)
                            KeyValueRow("Entran a la caja", "${Format.foreign(typed!!)} $currency", valueColor = AlDiaColors.Foreign)
                        }
                    }
                }
                if (differs) {
                    Spacer(Modifier.height(8.dp))
                    InfoBanner(
                        "La tienda tiene ${Format.rate(shopRate)}. El dueño verá que compraste a otra tasa.",
                        tone = AlDiaColors.Warning,
                    )
                }
                Spacer(Modifier.height(14.dp))
                PrimaryButton(
                    when {
                        state.busy -> "Registrando…"
                        !validRate -> "Escribe la tasa"
                        !validAmount -> "Escribe cuántos $currency compras"
                        else -> "Comprar ${Format.foreign(typed!!)} $currency por ${Format.money(cup, 2)}"
                    },
                    onClick = {
                        viewModel.buyCurrency(session, currency, amount, rate.toString())
                    },
                    enabled = validAmount && validRate && !state.busy,
                    loading = state.busy,
                )
            }
        }
        Spacer(Modifier.height(10.dp))

        if (state.pendingPurchases.isNotEmpty()) {
            AlDiaCard(Modifier.fillMaxWidth()) {
                Column {
                    SectionTitle("Compras por subir")
                    Spacer(Modifier.height(6.dp))
                    state.pendingPurchases.forEach { item ->
                        Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                "${Format.foreign(item.amount)} ${item.currency} a ${Format.rate(item.rate)}",
                                style = MaterialTheme.typography.bodySmall,
                                color = AlDiaColors.TextSecondary,
                                modifier = Modifier.weight(1f),
                            )
                            Pill("Por subir", AlDiaColors.Warning, AlDiaColors.WarningSoft)
                        }
                    }
                }
            }
            Spacer(Modifier.height(10.dp))
        }

        if (session.user.isOwner) {
            SectionTitle("Compras de hoy")
            Spacer(Modifier.height(8.dp))
            if (state.loading) {
                LoadingBlock()
            } else if (state.purchases.isEmpty()) {
                EmptyBlock("Todavía no hay compras hoy.", "Las compras que registres aparecerán aquí.")
            } else {
                AlDiaCard(Modifier.fillMaxWidth()) {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        state.purchases.forEachIndexed { index, purchase ->
                            if (index > 0) HorizontalDivider(color = AlDiaColors.BorderSoft)
                            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f)) {
                                    Text(
                                        "${Format.foreign(purchase.foreignAmount)} ${purchase.foreignCurrency} a ${Format.rate(purchase.exchangeRate)}",
                                        style = MaterialTheme.typography.titleSmall,
                                        color = AlDiaColors.TextPrimary,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                    Text(
                                        "${purchase.accountEmail ?: "Tienda"} · ${Format.time(purchase.createdAt)}",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = AlDiaColors.TextTertiary,
                                    )
                                    if (Payment.offShopPurchase(purchase.exchangeRate, purchase.shopRate)) {
                                        Text(
                                            "La tienda tenía ${Format.rate(purchase.shopRate)}",
                                            style = MaterialTheme.typography.labelSmall,
                                            color = AlDiaColors.Warning,
                                        )
                                    }
                                }
                                Text(
                                    "− ${Format.money(purchase.cupAmount, 2)}",
                                    style = MaterialTheme.typography.titleSmall,
                                    color = AlDiaColors.Danger,
                                )
                            }
                        }
                    }
                }
            }
        } else {
            InfoBanner("El historial de compras lo ve el dueño. Tu compra queda registrada igual.", tone = AlDiaColors.Blue)
        }
        if (session.user.isOwner) {
            Spacer(Modifier.height(18.dp))
            ShopRatesCard(state, onSave = { usd, eur -> viewModel.saveShopRates(session, usd, eur) }, session = session)
        }
        Spacer(Modifier.height(24.dp))
    }

    state.lastPurchase?.let { outcome ->
        ModalBottomSheet(
            onDismissRequest = viewModel::dismiss,
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            containerColor = AlDiaColors.Surface,
        ) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 22.dp).padding(bottom = 26.dp).imePadding()) {
                Text(if (outcome.pending) "Compra guardada" else "Compra registrada", style = MaterialTheme.typography.headlineSmall, color = AlDiaColors.TextPrimary)
                Text(
                    outcome.purchase?.let { "${Format.foreign(it.foreignAmount)} ${it.foreignCurrency} a ${Format.rate(it.exchangeRate)}" }
                        ?: "Queda pendiente de sincronizar.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = AlDiaColors.TextSecondary,
                )
                Spacer(Modifier.height(12.dp))
                AlDiaCard(Modifier.fillMaxWidth()) {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        KeyValueRow("Pagaste", Format.money(outcome.cup, 2), bold = true)
                        KeyValueRow("Entra a la caja", outcome.purchase?.let { "${Format.foreign(it.foreignAmount)} ${it.foreignCurrency}" } ?: "—", valueColor = AlDiaColors.Foreign)
                    }
                }
                if (outcome.error != null && outcome.pending) {
                    Spacer(Modifier.height(8.dp))
                    InfoBanner(outcome.error, tone = AlDiaColors.Warning)
                }
                Spacer(Modifier.height(14.dp))
                PrimaryButton("Entendido", onClick = viewModel::dismiss)
            }
        }
    }
}

@Composable
private fun CurrencyChoice(
    label: String,
    selected: String,
    color: Color,
    modifier: Modifier = Modifier,
    onSelect: (String) -> Unit,
) {
    Surface(
        onClick = { onSelect(label) },
        shape = RoundedCornerShape(12.dp),
        color = if (selected == label) color else AlDiaColors.SurfaceMuted,
        modifier = modifier,
    ) {
        Text(
            label,
            modifier = Modifier.padding(vertical = 11.dp),
            style = MaterialTheme.typography.titleSmall,
            color = if (selected == label) Color.White else AlDiaColors.TextSecondary,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
    }
}
