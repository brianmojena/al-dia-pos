package cu.mypimes.pos.ui.store

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Calculate
import androidx.compose.material.icons.filled.CurrencyExchange
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.FactCheck
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.Inventory2
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.ReceiptLong
import androidx.compose.material.icons.filled.Savings
import androidx.compose.material.icons.filled.UploadFile
import androidx.compose.material.icons.filled.Warehouse
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.Row
import cu.mypimes.pos.data.auth.Session
import cu.mypimes.pos.domain.accounting.Accounting
import cu.mypimes.pos.domain.auth.Plans
import cu.mypimes.pos.ui.components.AlDiaCard
import cu.mypimes.pos.ui.components.Pill
import cu.mypimes.pos.ui.theme.AlDiaColors

@Composable
fun MoreScreen(
    session: Session,
    onOpenDivisas: () -> Unit,
    onOpenCaja: () -> Unit,
    onOpenHistorial: () -> Unit,
    onOpenProductos: () -> Unit,
    onOpenInventario: () -> Unit,
    onOpenAlmacen: () -> Unit,
    onOpenImportProductos: () -> Unit,
    onOpenImportAlmacen: () -> Unit,
    onOpenCajeros: () -> Unit,
    onOpenPanel: () -> Unit,
    onOpenAuditoria: () -> Unit,
    onOpenContabilidad: () -> Unit,
    onOpenVentas: () -> Unit,
    /** Caja central + dueño: resumen «N sin subir · M por revisar»; null oculta la entrada. */
    reviewSummary: String?,
    onOpenRevisar: () -> Unit,
    onLogout: () -> Unit,
    onLock: (() -> Unit)?,
    onRefreshProfile: () -> Unit,
    version: String,
) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
        Column(Modifier.fillMaxWidth().padding(top = 14.dp, bottom = 12.dp)) {
            Text("Más", style = MaterialTheme.typography.headlineMedium, color = AlDiaColors.TextPrimary)
            Text(
                session.user.displayName,
                style = MaterialTheme.typography.bodySmall,
                color = AlDiaColors.TextSecondary,
            )
            // Estado de la suscripción, como el encabezado de la web: plan y, si la prueba corre, los días que quedan.
            Row(Modifier.padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(if (session.user.isOwner) "Plan ${Plans.label(session.user.plan)}" else "Cajero", style = MaterialTheme.typography.labelMedium, color = AlDiaColors.TextSecondary)
                val trial = session.user.trialDaysLeft
                if (session.user.isOwner && session.user.planStatus == "pending" && trial != null) {
                    Spacer(Modifier.width(8.dp))
                    Pill("Prueba · $trial ${if (trial == 1) "día" else "días"}", AlDiaColors.Warning, AlDiaColors.WarningSoft)
                }
            }
        }

        AlDiaCard(Modifier.fillMaxWidth()) {
            Column {
                MoreRow(Icons.Default.Inventory2, "Productos", "Catálogo, precios y stock", AlDiaColors.Success, onOpenProductos)
                // Igual que la web: la importación de productos es solo del dueño (el servidor lo exige).
                if (session.user.isOwner) {
                    HorizontalDivider(color = AlDiaColors.BorderSoft)
                    MoreRow(Icons.Default.UploadFile, "Importar productos", "Desde CSV o pegando una hoja de Excel", AlDiaColors.Success, onOpenImportProductos)
                }
                HorizontalDivider(color = AlDiaColors.BorderSoft)
                MoreRow(Icons.Default.FactCheck, "Inventario", "Conteo del estante y arqueos", AlDiaColors.Warning, onOpenInventario)
                // Misma regla que la web (RequireWarehouse): solo se oculta si la tienda tiene el almacén apagado.
                if (session.user.warehouseEnabled) {
                    HorizontalDivider(color = AlDiaColors.BorderSoft)
                    MoreRow(Icons.Default.Warehouse, "Almacén", "Mercancía guardada aparte de la tienda", AlDiaColors.Blue, onOpenAlmacen)
                    HorizontalDivider(color = AlDiaColors.BorderSoft)
                    MoreRow(Icons.Default.UploadFile, "Importar al almacén", "Desde CSV o pegando una hoja de Excel", AlDiaColors.Blue, onOpenImportAlmacen)
                }
                if (session.user.isOwner) {
                    HorizontalDivider(color = AlDiaColors.BorderSoft)
                    MoreRow(Icons.Default.Groups, "Cajeros", "Crear y quitar cuentas de cajeros", AlDiaColors.Blue, onOpenCajeros)
                }
                HorizontalDivider(color = AlDiaColors.BorderSoft)
                MoreRow(Icons.Default.CurrencyExchange, "Divisas", "Compra de USD y EUR, tasas", AlDiaColors.Foreign, onOpenDivisas)
                HorizontalDivider(color = AlDiaColors.BorderSoft)
                MoreRow(Icons.Default.Savings, "Caja y cierres", "Cierres, salidas y arqueo", AlDiaColors.Cash, onOpenCaja)
                HorizontalDivider(color = AlDiaColors.BorderSoft)
                MoreRow(Icons.Default.ReceiptLong, "Historial", "Ventas de hoy y su estado", AlDiaColors.Blue, onOpenHistorial)
                if (session.user.isOwner) {
                    HorizontalDivider(color = AlDiaColors.BorderSoft)
                    if (reviewSummary != null) {
                        MoreRow(Icons.Default.FactCheck, "Por revisar", reviewSummary, AlDiaColors.Danger, onOpenRevisar)
                        HorizontalDivider(color = AlDiaColors.BorderSoft)
                    }
                    MoreRow(Icons.Default.ReceiptLong, "Ventas por día", "Por cajero; cambiar cobro o anular", AlDiaColors.Blue, onOpenVentas)
                    HorizontalDivider(color = AlDiaColors.BorderSoft)
                    MoreRow(Icons.Default.Dashboard, "Panel del dueño", "Ventas de hoy, lo que hay en caja y alertas", AlDiaColors.Success, onOpenPanel)
                    HorizontalDivider(color = AlDiaColors.BorderSoft)
                    MoreRow(Icons.Default.AutoAwesome, "Auditoría", "Explicación de los cierres de caja", AlDiaColors.Blue, onOpenAuditoria)
                }
                // Misma regla que la web: solo dueño y plan Enterprise (el servidor lo vuelve a comprobar).
                if (Accounting.available(session.user.isOwner, session.user.plan)) {
                    HorizontalDivider(color = AlDiaColors.BorderSoft)
                    MoreRow(Icons.Default.Calculate, "Contabilidad", "Gastos del mes, resumen y Excel", AlDiaColors.Success, onOpenContabilidad)
                }
            }
        }
        Spacer(Modifier.height(12.dp))

        AlDiaCard(Modifier.fillMaxWidth()) {
            Column {
                MoreRow(Icons.Default.Refresh, "Actualizar cuenta", session.user.email, AlDiaColors.TextSecondary, onRefreshProfile)
                HorizontalDivider(color = AlDiaColors.BorderSoft)
                if (onLock != null) {
                    // Caja compartida: no se cierra la sesión (los recibos pendientes se conservan), se bloquea con PIN.
                    MoreRow(Icons.Default.Lock, "Bloquear / cambiar persona", "Vuelve a pedir el PIN", AlDiaColors.Blue, onLock)
                } else {
                    MoreRow(Icons.AutoMirrored.Filled.Logout, "Cerrar sesión", null, AlDiaColors.Danger, onLogout, danger = true)
                }
            }
        }
        Spacer(Modifier.height(16.dp))

        Text(
            version,
            style = MaterialTheme.typography.labelSmall,
            color = AlDiaColors.TextTertiary,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(16.dp))
    }
}

@Composable
private fun MoreRow(
    icon: ImageVector,
    title: String,
    subtitle: String?,
    color: Color,
    onClick: () -> Unit,
    danger: Boolean = false,
) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(34.dp).clip(CircleShape).background(color.copy(alpha = 0.12f)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(18.dp))
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(
                title,
                style = MaterialTheme.typography.titleSmall,
                color = if (danger) AlDiaColors.Danger else AlDiaColors.TextPrimary,
            )
            if (subtitle != null) {
                Text(
                    subtitle,
                    style = MaterialTheme.typography.labelSmall,
                    color = AlDiaColors.TextTertiary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}
