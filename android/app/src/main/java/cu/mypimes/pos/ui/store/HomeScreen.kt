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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.ArrowDownward
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Inventory2
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.TrendingUp
import androidx.compose.material.icons.filled.WarningAmber
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cu.mypimes.pos.data.auth.Session
import cu.mypimes.pos.domain.Format
import cu.mypimes.pos.ui.components.AlDiaCard
import cu.mypimes.pos.ui.components.EmptyBlock
import cu.mypimes.pos.ui.components.ErrorBanner
import cu.mypimes.pos.ui.components.InfoBanner
import cu.mypimes.pos.ui.components.KeyValueRow
import cu.mypimes.pos.ui.components.LoadingBlock
import cu.mypimes.pos.ui.components.Pill
import cu.mypimes.pos.ui.components.SectionTitle
import cu.mypimes.pos.ui.components.StaleNote
import cu.mypimes.pos.ui.theme.AlDiaColors
import java.time.LocalDate

@Composable
fun HomeScreen(session: Session, viewModel: StoreViewModel, onBack: (() -> Unit)? = null) {
    val collected by viewModel.state.collectAsStateWithLifecycle()
    val state = if (collected.sessionToken == session.token) collected else StoreUiState(loading = true)
    val dashboard = state.dashboard

    LaunchedEffect(session.token) { viewModel.bindSession(session); if (session.user.isOwner) viewModel.refresh(session) }

    if (!session.user.isOwner) {
        Column(Modifier.fillMaxSize().padding(16.dp)) {
            InfoBanner("El inicio es solo para el dueño de la tienda.", tone = AlDiaColors.Warning)
        }
        return
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
        Row(Modifier.fillMaxWidth().padding(top = 14.dp, bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            if (onBack != null) {
                IconButton(onClick = onBack) {
                    Icon(Icons.Default.ArrowBack, contentDescription = "Volver", tint = AlDiaColors.TextSecondary)
                }
            }
            Column(Modifier.weight(1f)) {
                Text("Inicio", style = MaterialTheme.typography.headlineMedium, color = AlDiaColors.TextPrimary)
                Text(
                    Format.dayLabel(LocalDate.now(Format.cubaZone)),
                    style = MaterialTheme.typography.bodySmall,
                    color = AlDiaColors.TextSecondary,
                )
            }
            IconButton(onClick = { viewModel.refresh(session) }, enabled = !state.refreshing) {
                if (state.refreshing) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = AlDiaColors.Blue)
                else Icon(Icons.Default.Refresh, contentDescription = "Actualizar", tint = AlDiaColors.TextSecondary)
            }
        }

        // Con el panel recién bajado no se dice nada; pasado un minuto es lo guardado en el aparato (sin red se ve igual).
        StaleNote(state.dashboardSavedAt?.takeIf { !state.refreshing && System.currentTimeMillis() - it > 60_000L })
        if (state.refreshing && dashboard == null) {
            LoadingBlock()
            return@Column
        }
        if (state.error != null && dashboard == null) {
            ErrorBanner(state.error!!)
            Spacer(Modifier.height(10.dp))
        }
        if (dashboard == null) {
            EmptyBlock("Sin datos todavía", "Actualiza para cargar el resumen del negocio.")
            Spacer(Modifier.height(10.dp))
            return@Column
        }

        SalesHero(
            sales = dashboard.today.sales,
            profit = dashboard.today.profit,
            count = dashboard.today.count,
        )
        Spacer(Modifier.height(10.dp))

        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            MetricCard(
                "Efectivo", Format.money(dashboard.holdings.cash), "En gavetas",
                AlDiaColors.Cash, Icons.Default.ArrowDownward, Modifier.weight(1f),
            )
            MetricCard(
                "Transferencias", Format.money(dashboard.holdings.transfer), "Banco",
                AlDiaColors.Transfer, Icons.Default.ArrowUpward, Modifier.weight(1f),
            )
        }
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            MetricCard(
                "Dólares", Format.foreign(dashboard.holdings.usd), "USD",
                AlDiaColors.Foreign, Icons.Default.TrendingUp, Modifier.weight(1f),
            )
            MetricCard(
                "Euros", Format.foreign(dashboard.holdings.eur), "EUR",
                AlDiaColors.Euro, Icons.Default.TrendingUp, Modifier.weight(1f),
            )
        }
        Spacer(Modifier.height(10.dp))

        if (dashboard.openWithdrawals.isNotEmpty()) {
            AlDiaCard(Modifier.fillMaxWidth()) {
                Column {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("Salidas sin cerrar", style = MaterialTheme.typography.titleSmall, color = AlDiaColors.TextPrimary, modifier = Modifier.weight(1f))
                        Text(
                            Format.money(dashboard.openWithdrawals.sumOf { it.amount }),
                            style = MaterialTheme.typography.titleSmall,
                            color = AlDiaColors.Danger,
                        )
                    }
                    Spacer(Modifier.height(6.dp))
                    dashboard.openWithdrawals.take(3).forEach { withdrawal ->
                        Text(
                            "${Format.money(withdrawal.amount)} · ${withdrawal.note ?: "Sin nota"}",
                            style = MaterialTheme.typography.bodySmall,
                            color = AlDiaColors.TextSecondary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
            Spacer(Modifier.height(10.dp))
        }

        AlDiaCard(Modifier.fillMaxWidth()) {
            Column {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        Modifier.size(34.dp).clip(CircleShape).background(AlDiaColors.BlueSoft),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(Icons.Default.Inventory2, contentDescription = null, tint = AlDiaColors.Blue, modifier = Modifier.size(18.dp))
                    }
                    Spacer(Modifier.width(10.dp))
                    Text("Inventario", style = MaterialTheme.typography.titleSmall, color = AlDiaColors.TextPrimary, modifier = Modifier.weight(1f))
                    Pill("${dashboard.inventory.units} u.", AlDiaColors.Blue, AlDiaColors.BlueSoft)
                }
                Spacer(Modifier.height(10.dp))
                KeyValueRow("Costo", Format.money(dashboard.inventory.cost))
                KeyValueRow("Venta potencial", Format.money(dashboard.inventory.retail))
                if (dashboard.warehouse.items > 0) {
                    HorizontalDivider(color = AlDiaColors.BorderSoft)
                    KeyValueRow("Almacén", "${dashboard.warehouse.items} artículos · ${Format.money(dashboard.warehouse.cost)}")
                    dashboard.warehouse.lastTransfer?.let { transfer ->
                        Text(
                            "Último: ${transfer.itemName ?: "—"} · ${Format.dateTime(transfer.createdAt)}",
                            style = MaterialTheme.typography.labelSmall,
                            color = AlDiaColors.TextTertiary,
                        )
                    }
                }
            }
        }
        Spacer(Modifier.height(10.dp))

        if (dashboard.lowStock.isNotEmpty()) {
            AlDiaCard(Modifier.fillMaxWidth()) {
                Column {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.WarningAmber, contentDescription = null, tint = AlDiaColors.Warning, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(8.dp))
                        Text("Stock bajo", style = MaterialTheme.typography.titleSmall, color = AlDiaColors.TextPrimary, modifier = Modifier.weight(1f))
                        Text("${dashboard.lowStock.size}", style = MaterialTheme.typography.labelLarge, color = AlDiaColors.Warning)
                    }
                    Spacer(Modifier.height(8.dp))
                    dashboard.lowStock.take(6).forEach { product ->
                        Row(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
                            Text(
                                product.name,
                                style = MaterialTheme.typography.bodySmall,
                                color = AlDiaColors.TextSecondary,
                                modifier = Modifier.weight(1f),
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Text(
                                "${Format.quantity(product.stock)}${product.unit?.let { " $it" } ?: ""}",
                                style = MaterialTheme.typography.bodySmall,
                                color = AlDiaColors.Danger,
                                fontWeight = FontWeight.SemiBold,
                            )
                        }
                    }
                }
            }
            Spacer(Modifier.height(10.dp))
        }

        SectionTitle("Auditoría")
        Spacer(Modifier.height(8.dp))
        AlDiaCard(Modifier.fillMaxWidth()) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                val last = dashboard.audit.lastCashClose
                if (last != null) {
                    KeyValueRow("Último cierre", Format.dateTime(last.closedAt))
                    KeyValueRow(
                        "Diferencia",
                        Format.signedMoney(last.difference ?: 0.0),
                        valueColor = if ((last.difference ?: 0.0) < -0.005) AlDiaColors.Danger else AlDiaColors.Success,
                        bold = true,
                    )
                } else {
                    Text("Sin cierres registrados.", style = MaterialTheme.typography.bodySmall, color = AlDiaColors.TextTertiary)
                }
                if (dashboard.audit.rejectedSales > 0 || dashboard.audit.offRateSales > 0) {
                    HorizontalDivider(color = AlDiaColors.BorderSoft)
                    if (dashboard.audit.rejectedSales > 0) {
                        KeyValueRow("Ventas rechazadas", dashboard.audit.rejectedSales.toString(), valueColor = AlDiaColors.Danger)
                    }
                    if (dashboard.audit.offRateSales > 0) {
                        KeyValueRow("Cobros fuera de tasa", dashboard.audit.offRateSales.toString(), valueColor = AlDiaColors.Warning)
                    }
                }
                dashboard.audit.cashierSummary.firstOrNull()?.let { pattern ->
                    HorizontalDivider(color = AlDiaColors.BorderSoft)
                    Text(
                        "${pattern.accountEmail ?: "Cajero"}: ${pattern.closes} cierre(s), ${pattern.timesShort} corto(s)",
                        style = MaterialTheme.typography.labelSmall,
                        color = AlDiaColors.TextTertiary,
                    )
                }
            }
        }
        Spacer(Modifier.height(10.dp))

        if (dashboard.recentSales.isNotEmpty()) {
            SectionTitle("Últimas ventas")
            Spacer(Modifier.height(8.dp))
            AlDiaCard(Modifier.fillMaxWidth()) {
                Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                    dashboard.recentSales.take(5).forEachIndexed { index, sale ->
                        if (index > 0) HorizontalDivider(color = AlDiaColors.BorderSoft)
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(
                                    Format.money(sale.total, 2),
                                    style = MaterialTheme.typography.titleSmall,
                                    color = AlDiaColors.TextPrimary,
                                )
                                Text(
                                    "${Format.time(sale.createdAt)} · ${sale.paymentMethod ?: "efectivo"}",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = AlDiaColors.TextTertiary,
                                )
                            }
                            sale.foreignCurrency?.let {
                                Pill("${Format.foreign(sale.foreignAmount ?: 0.0)} $it", AlDiaColors.Foreign, AlDiaColors.ForeignSoft)
                            } ?: Pill(
                                cu.mypimes.pos.domain.Payment.paymentLabel(sale.paymentMethod, null),
                                AlDiaColors.TextSecondary,
                                AlDiaColors.SurfaceMuted,
                            )
                        }
                    }
                }
            }
            Spacer(Modifier.height(10.dp))
        }

        Spacer(Modifier.height(16.dp))
    }
}

@Composable
private fun SalesHero(sales: Double, profit: Double, count: Int) {
    Box(
        Modifier.fillMaxWidth()
            .clip(RoundedCornerShape(24.dp))
            .background(AlDiaColors.TextPrimary)
            .padding(20.dp),
    ) {
        Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "Ventas de hoy",
                    style = MaterialTheme.typography.labelLarge,
                    color = Color.White.copy(alpha = 0.7f),
                    modifier = Modifier.weight(1f),
                )
                Pill("$count venta(s)", Color.White, Color.White.copy(alpha = 0.14f))
            }
            Spacer(Modifier.height(6.dp))
            Text(Format.money(sales, 2), style = MaterialTheme.typography.displaySmall, color = Color.White, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(6.dp))
            Text(
                "Ganancia ${Format.money(profit)}",
                style = MaterialTheme.typography.bodyMedium,
                color = AlDiaColors.SuccessSoft,
            )
        }
    }
}

@Composable
private fun MetricCard(
    label: String,
    value: String,
    caption: String,
    color: Color,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    modifier: Modifier = Modifier,
) {
    AlDiaCard(modifier) {
        Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
                Text(label, style = MaterialTheme.typography.labelMedium, color = AlDiaColors.TextSecondary)
            }
            Spacer(Modifier.height(6.dp))
            Text(value, style = MaterialTheme.typography.titleLarge, color = AlDiaColors.TextPrimary, maxLines = 1)
            Text(caption, style = MaterialTheme.typography.labelSmall, color = AlDiaColors.TextTertiary)
        }
    }
}
