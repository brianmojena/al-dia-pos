package cu.mypimes.pos.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CurrencyExchange
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.PointOfSale
import androidx.compose.material.icons.filled.ReceiptLong
import androidx.compose.material.icons.filled.Savings
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.NavigationRailItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.foundation.layout.Column
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import cu.mypimes.pos.BuildConfig
import cu.mypimes.pos.data.auth.Session
import cu.mypimes.pos.ui.pos.HistoryScreen
import cu.mypimes.pos.ui.pos.PosScreen
import cu.mypimes.pos.ui.pos.PosViewModel
import cu.mypimes.pos.ui.store.CajaScreen
import cu.mypimes.pos.ui.store.AccountingScreen
import cu.mypimes.pos.ui.store.AccountingViewModel
import cu.mypimes.pos.ui.store.AuditoriaScreen
import cu.mypimes.pos.ui.store.AuditoriaViewModel
import cu.mypimes.pos.ui.store.CashiersScreen
import cu.mypimes.pos.ui.store.CashiersViewModel
import cu.mypimes.pos.ui.store.DivisasScreen
import cu.mypimes.pos.ui.store.HomeScreen
import cu.mypimes.pos.ui.store.InventoryScreen
import cu.mypimes.pos.ui.store.ImportScreen
import cu.mypimes.pos.ui.store.ImportTarget
import cu.mypimes.pos.ui.store.ImportViewModel
import cu.mypimes.pos.ui.store.InventoryViewModel
import cu.mypimes.pos.ui.store.MoreScreen
import cu.mypimes.pos.ui.store.PorRevisarScreen
import cu.mypimes.pos.ui.store.SyncStatusBar
import cu.mypimes.pos.ui.store.SyncStatusViewModel
import cu.mypimes.pos.ui.store.SalesScreen
import cu.mypimes.pos.ui.store.SalesViewModel
import cu.mypimes.pos.ui.store.ProductsScreen
import cu.mypimes.pos.ui.store.ProductsViewModel
import cu.mypimes.pos.ui.store.StoreViewModel
import cu.mypimes.pos.ui.store.WarehouseScreen
import cu.mypimes.pos.ui.store.WarehouseViewModel
import cu.mypimes.pos.ui.theme.AlDiaColors

private enum class Tab(val label: String, val icon: ImageVector) {
    Venta("Venta", Icons.Filled.PointOfSale),
    Caja("Caja", Icons.Filled.Savings),
    Divisas("Divisas", Icons.Filled.CurrencyExchange),
    Historial("Historial", Icons.Filled.ReceiptLong),
    Mas("Más", Icons.Filled.MoreHoriz),
}

@Composable
fun MainShell(
    session: Session,
    onLogout: () -> Unit,
    onRefreshProfile: () -> Unit,
    /** Solo en caja compartida: bloquea con PIN (recibe si hay carrito abierto). Sustituye a «Cerrar sesión». */
    onLock: ((Boolean) -> Unit)? = null,
) {
    val posViewModel: PosViewModel = hiltViewModel()
    val storeViewModel: StoreViewModel = hiltViewModel()
    val productsViewModel: ProductsViewModel = hiltViewModel()
    val inventoryViewModel: InventoryViewModel = hiltViewModel()
    val warehouseViewModel: WarehouseViewModel = hiltViewModel()
    val importViewModel: ImportViewModel = hiltViewModel()
    val cashiersViewModel: CashiersViewModel = hiltViewModel()
    val salesViewModel: SalesViewModel = hiltViewModel()
    val accountingViewModel: AccountingViewModel = hiltViewModel()
    val auditoriaViewModel: AuditoriaViewModel = hiltViewModel()
    val syncStatusViewModel: SyncStatusViewModel = hiltViewModel()
    val syncStatus by syncStatusViewModel.state.collectAsStateWithLifecycle()
    var tabName by rememberSaveable { mutableStateOf(Tab.Venta.name) }
    // Productos, Inventario y Almacén viven dentro de Más (no son pestañas): se abren desde ese menú.
    var productsOpen by rememberSaveable { mutableStateOf(false) }
    var inventoryOpen by rememberSaveable { mutableStateOf(false) }
    var warehouseOpen by rememberSaveable { mutableStateOf(false) }
    var importOpen by rememberSaveable { mutableStateOf(false) }
    var cashiersOpen by rememberSaveable { mutableStateOf(false) }
    var salesOpen by rememberSaveable { mutableStateOf(false) }
    var panelOpen by rememberSaveable { mutableStateOf(false) }
    var auditoriaOpen by rememberSaveable { mutableStateOf(false) }
    var contabilidadOpen by rememberSaveable { mutableStateOf(false) }
    var revisarOpen by rememberSaveable { mutableStateOf(false) }
    BackHandler(enabled = (revisarOpen || productsOpen || inventoryOpen || warehouseOpen || importOpen || cashiersOpen || salesOpen || panelOpen || auditoriaOpen || contabilidadOpen) && tabName == Tab.Mas.name) {
        revisarOpen = false
        cashiersOpen = false
        salesOpen = false
        panelOpen = false
        auditoriaOpen = false
        contabilidadOpen = false
        productsOpen = false
        inventoryOpen = false
        warehouseOpen = false
        importOpen = false
    }
    val tab = Tab.entries.firstOrNull { it.name == tabName } ?: Tab.Venta
    val tablet = LocalConfiguration.current.screenWidthDp >= 600
    val maxWidth = if (tablet && tab != Tab.Venta) 720.dp else Dp.Infinity

    Scaffold(
        containerColor = AlDiaColors.Background,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        bottomBar = {
            if (!tablet) NavigationBar(containerColor = Color.White, tonalElevation = 0.dp, windowInsets = WindowInsets(0, 0, 0, 0)) {
                Tab.entries.forEach { entry ->
                    NavigationBarItem(
                        selected = tab == entry,
                        onClick = { tabName = entry.name; productsOpen = false; inventoryOpen = false; warehouseOpen = false; importOpen = false; cashiersOpen = false; salesOpen = false; panelOpen = false; auditoriaOpen = false; contabilidadOpen = false; revisarOpen = false },
                        icon = { Icon(entry.icon, contentDescription = entry.label) },
                        label = { Text(entry.label, style = MaterialTheme.typography.labelSmall) },
                        colors = NavigationBarItemDefaults.colors(
                            selectedIconColor = AlDiaColors.Blue,
                            selectedTextColor = AlDiaColors.Blue,
                            unselectedIconColor = AlDiaColors.TextTertiary,
                            unselectedTextColor = AlDiaColors.TextTertiary,
                            indicatorColor = AlDiaColors.BlueSoft,
                        ),
                    )
                }
            }
        },
    ) { padding ->
        Row(Modifier.fillMaxSize().padding(padding).background(AlDiaColors.Background)) {
            if (tablet) NavigationRail(containerColor = Color.White, windowInsets = WindowInsets(0, 0, 0, 0)) {
                Tab.entries.forEach { entry ->
                    NavigationRailItem(
                        selected = tab == entry,
                        onClick = { tabName = entry.name; productsOpen = false; inventoryOpen = false; warehouseOpen = false; importOpen = false; cashiersOpen = false; salesOpen = false; panelOpen = false; auditoriaOpen = false; contabilidadOpen = false; revisarOpen = false },
                        icon = { Icon(entry.icon, contentDescription = entry.label) },
                        label = { Text(entry.label, style = MaterialTheme.typography.labelSmall) },
                        colors = NavigationRailItemDefaults.colors(
                            selectedIconColor = AlDiaColors.Blue,
                            selectedTextColor = AlDiaColors.Blue,
                            unselectedIconColor = AlDiaColors.TextTertiary,
                            unselectedTextColor = AlDiaColors.TextTertiary,
                            indicatorColor = AlDiaColors.BlueSoft,
                        ),
                    )
                }
            }
            Box(Modifier.weight(1f).fillMaxHeight(), contentAlignment = Alignment.TopCenter) {
                Column(Modifier.fillMaxSize().widthIn(max = maxWidth)) {
                    // A8: en caja central, lo pendiente y lo rechazado se ve en todas las pantallas.
                    SyncStatusBar(session, syncStatusViewModel, onOpenReview = if (session.user.isOwner) ({ tabName = Tab.Mas.name; revisarOpen = true }) else null)
                    Box(Modifier.weight(1f).fillMaxWidth()) {
                    when (tab) {
                        Tab.Venta -> PosScreen(
                            session = session,
                            onOpenHistory = { tabName = Tab.Historial.name },
                            viewModel = posViewModel,
                        )
                        Tab.Caja -> CajaScreen(session, storeViewModel)
                        Tab.Divisas -> DivisasScreen(session, storeViewModel)
                        Tab.Historial -> HistoryScreen(session, posViewModel)
                        Tab.Mas -> when {
                            revisarOpen -> PorRevisarScreen(session, syncStatusViewModel, onBack = { revisarOpen = false })
                            salesOpen -> SalesScreen(session, salesViewModel, onBack = { salesOpen = false })
                            panelOpen -> HomeScreen(session, storeViewModel, onBack = { panelOpen = false })
                            auditoriaOpen -> AuditoriaScreen(session, auditoriaViewModel, onBack = { auditoriaOpen = false })
                            contabilidadOpen -> AccountingScreen(session, accountingViewModel, onBack = { contabilidadOpen = false })
                            cashiersOpen -> CashiersScreen(session, cashiersViewModel, onBack = { cashiersOpen = false })
                            importOpen -> ImportScreen(
                                session = session,
                                viewModel = importViewModel,
                                onBack = { importOpen = false; cashiersOpen = false; salesOpen = false; panelOpen = false; auditoriaOpen = false; contabilidadOpen = false },
                                onDone = {
                                    importOpen = false
                                    productsViewModel.refresh(session)
                                    warehouseViewModel.refresh(session)
                                },
                            )
                            productsOpen -> ProductsScreen(
                                session = session,
                                viewModel = productsViewModel,
                                onBack = { productsOpen = false },
                            )
                            inventoryOpen -> InventoryScreen(
                                session = session,
                                viewModel = inventoryViewModel,
                                onBack = { inventoryOpen = false },
                            )
                            warehouseOpen -> WarehouseScreen(
                                session = session,
                                viewModel = warehouseViewModel,
                                onBack = { warehouseOpen = false },
                            )
                            else -> MoreScreen(
                                session = session,
                                onOpenDivisas = { tabName = Tab.Divisas.name },
                                onOpenCaja = { tabName = Tab.Caja.name },
                                onOpenHistorial = { tabName = Tab.Historial.name },
                                onOpenProductos = { productsOpen = true },
                                onOpenInventario = { inventoryOpen = true },
                                onOpenAlmacen = { warehouseOpen = true },
                                onOpenImportProductos = {
                                    importViewModel.bind(session, ImportTarget.PRODUCTOS)
                                    importOpen = true
                                },
                                onOpenImportAlmacen = {
                                    importViewModel.bind(session, ImportTarget.ALMACEN)
                                    importOpen = true
                                },
                                onOpenCajeros = { cashiersOpen = true },
                                onOpenPanel = { panelOpen = true },
                                onOpenAuditoria = { auditoriaOpen = true },
                                onOpenContabilidad = { contabilidadOpen = true },
                                onOpenVentas = { salesOpen = true },
                                reviewSummary = if (session.user.isOwner && syncStatus.central) syncStatus.counts.text else null,
                                onOpenRevisar = { revisarOpen = true },
                                onLogout = onLogout,
                                onLock = onLock?.let { lock -> { lock(posViewModel.state.value.cart.isNotEmpty()) } },
                                onRefreshProfile = onRefreshProfile,
                                version = "${BuildConfig.VERSION_NAME}${if (BuildConfig.DEBUG) " · debug" else ""}",
                            )
                        }
                    }
                    }
                }
            }
        }
    }
}
