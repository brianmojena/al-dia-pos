package cu.mypimes.pos.ui.store

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cu.mypimes.pos.data.auth.Session
import cu.mypimes.pos.domain.Format
import cu.mypimes.pos.domain.imports.ImportRow
import cu.mypimes.pos.domain.products.ProductImportRow
import cu.mypimes.pos.domain.warehouse.WarehouseImportRow
import cu.mypimes.pos.ui.components.AlDiaCard
import cu.mypimes.pos.ui.components.AlDiaField
import cu.mypimes.pos.ui.components.ErrorBanner
import cu.mypimes.pos.ui.components.InfoBanner
import cu.mypimes.pos.ui.components.Pill
import cu.mypimes.pos.ui.components.PrimaryButton
import cu.mypimes.pos.ui.components.SectionTitle
import cu.mypimes.pos.ui.theme.AlDiaColors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private const val PREVIEW_LIMIT = 300
private const val ERROR_LIMIT = 50
private val PICK_MIME_TYPES = arrayOf(
    "text/*",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/octet-stream",
)

/** Importar productos o artículos del almacén desde un CSV del sistema o texto pegado. Solo dueño en productos (lo valida el servidor). */
@Composable
fun ImportScreen(
    session: Session,
    viewModel: ImportViewModel,
    onBack: () -> Unit,
    onDone: () -> Unit,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val target = state.target ?: return
    val isWarehouse = target == ImportTarget.ALMACEN
    val noun = if (isWarehouse) "artículo" else "producto"
    val nouns = if (isWarehouse) "artículos" else "productos"
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var showPaste by rememberSaveable { mutableStateOf(false) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) scope.launch {
            val (name, bytes) = withContext(Dispatchers.IO) { readPicked(context, uri) }
            showPaste = false
            viewModel.onFile(name, bytes)
        }
    }

    val preview = state.preview
    val rows = preview?.rows.orEmpty()
    val valid = state.valid
    val invalid = rows.filter { it.errors.isNotEmpty() }
    val creates = valid.count { it.creates }
    val updates = valid.size - creates

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).imePadding().padding(horizontal = 16.dp)) {
        Row(Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Volver", tint = AlDiaColors.TextPrimary)
            }
            Text(
                if (isWarehouse) "Importar al almacén" else "Importar productos",
                style = MaterialTheme.typography.headlineSmall,
                color = AlDiaColors.TextPrimary,
            )
        }

        val done = state.done
        if (done != null) {
            AlDiaCard(Modifier.fillMaxWidth()) {
                Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
                    Text(if (done.queued) "${done.total} $nouns guardados en el aparato" else "${done.total} $nouns cargados", style = MaterialTheme.typography.titleLarge, color = AlDiaColors.Success)
                    Text(if (done.queued) "Sin subir: se enviarán al recuperar la conexión." else "${done.created} nuevos · ${done.updated} actualizados", style = MaterialTheme.typography.bodyMedium, color = AlDiaColors.TextSecondary)
                }
            }
            Spacer(Modifier.height(16.dp))
            PrimaryButton(if (isWarehouse) "Listo, ver almacén" else "Listo, ver productos", onClick = onDone, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(24.dp))
            return@Column
        }

        SectionTitle("1 · Prepara la lista")
        AlDiaCard(Modifier.fillMaxWidth()) {
            Text(
                if (isWarehouse) {
                    "Una fila por artículo. Columnas: nombre, costo, y opcionalmente unidad (kg, g o lb; vacía = por pieza) y cantidad."
                } else {
                    "Una fila por producto. Columnas: nombre, precio_venta, y opcionalmente precio_compra y stock."
                },
                style = MaterialTheme.typography.bodyMedium,
                color = AlDiaColors.TextSecondary,
            )
            Spacer(Modifier.height(8.dp))
            Text(
                if (isWarehouse) "Ejemplo: nombre · unidad · costo · cantidad" else "Ejemplo: nombre · precio_venta · precio_compra · stock",
                style = MaterialTheme.typography.labelSmall,
                color = AlDiaColors.TextTertiary,
            )
        }
        Spacer(Modifier.height(12.dp))

        SectionTitle("2 · Súbela")
        AlDiaCard(Modifier.fillMaxWidth()) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PrimaryButton(
                    "Elegir archivo",
                    onClick = { picker.launch(PICK_MIME_TYPES) },
                    modifier = Modifier.weight(1f),
                    height = 48,
                )
                OutlinedButton(onClick = { showPaste = !showPaste }, modifier = Modifier.weight(1f).height(48.dp)) {
                    Text("Pegar desde Excel")
                }
            }
            state.fileName?.let {
                Spacer(Modifier.height(10.dp))
                Text("Archivo: $it", style = MaterialTheme.typography.labelMedium, color = AlDiaColors.TextSecondary)
            }
            if (showPaste) {
                Spacer(Modifier.height(10.dp))
                AlDiaField(
                    value = state.content,
                    onValueChange = viewModel::onPaste,
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = false,
                    placeholder = "Selecciona las celdas en Excel (incluida la fila de títulos), cópialas y pégalas aquí.",
                )
            }
        }
        Spacer(Modifier.height(12.dp))

        if (state.loading) InfoBanner("Cargando la lista actual para marcar nuevos y actualizaciones…")
        state.loadError?.let { ErrorBanner(it) }
        preview?.error?.let { ErrorBanner(it) }

        if (rows.isNotEmpty()) {
            SectionTitle("3 · Revisa antes de guardar")
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                CountTile(creates, "nuevos", AlDiaColors.SuccessSoft, AlDiaColors.Success, Modifier.weight(1f))
                CountTile(updates, "actualizan", AlDiaColors.BlueSoft, AlDiaColors.Blue, Modifier.weight(1f))
                CountTile(invalid.size, "con errores", AlDiaColors.DangerSoft, AlDiaColors.Danger, Modifier.weight(1f))
            }
            Spacer(Modifier.height(12.dp))

            if (state.replacesStock) {
                AlDiaCard(Modifier.fillMaxWidth()) {
                    Text(
                        "Hay $nouns que ya existían. ${if (isWarehouse) "Su costo pasa a ser el del archivo." else "Su precio pasa a ser el del archivo."} " +
                            "¿Qué hacemos con ${if (isWarehouse) "la cantidad" else "el stock"}?",
                        style = MaterialTheme.typography.bodySmall,
                        color = AlDiaColors.TextSecondary,
                    )
                    StockChoice("Sumar al que hay", "50 + 20 = 70", state.addStock) { viewModel.setAddStock(true) }
                    StockChoice("Reemplazar", "50 → 20", !state.addStock) { viewModel.setAddStock(false) }
                    Text(
                        "Las celdas de costo o ${if (isWarehouse) "cantidad" else "stock"} que dejes vacías no cambian lo que ya había.",
                        style = MaterialTheme.typography.labelSmall,
                        color = AlDiaColors.TextTertiary,
                    )
                }
                Spacer(Modifier.height(12.dp))
            }

            if (valid.isNotEmpty()) {
                AlDiaCard(Modifier.fillMaxWidth()) {
                    Column {
                        valid.take(PREVIEW_LIMIT).forEachIndexed { index, row ->
                            if (index > 0) Spacer(Modifier.height(10.dp))
                            ValidRow(row)
                        }
                        if (valid.size > PREVIEW_LIMIT) {
                            Spacer(Modifier.height(8.dp))
                            Text("Mostrando $PREVIEW_LIMIT de ${valid.size}. Se importan todos.", style = MaterialTheme.typography.labelSmall, color = AlDiaColors.TextTertiary)
                        }
                    }
                }
                Spacer(Modifier.height(12.dp))
            }

            if (invalid.isNotEmpty()) {
                AlDiaCard(Modifier.fillMaxWidth()) {
                    Column {
                        invalid.take(ERROR_LIMIT).forEachIndexed { index, row ->
                            if (index > 0) Spacer(Modifier.height(10.dp))
                            Text("Fila ${row.line} · ${row.name.ifBlank { "(sin nombre)" }}", style = MaterialTheme.typography.titleSmall, color = AlDiaColors.TextPrimary)
                            Text(row.errors.joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = AlDiaColors.Danger)
                        }
                        if (invalid.size > ERROR_LIMIT) {
                            Spacer(Modifier.height(8.dp))
                            Text("…y ${invalid.size - ERROR_LIMIT} filas más con errores", style = MaterialTheme.typography.labelSmall, color = AlDiaColors.TextTertiary)
                        }
                    }
                }
                Spacer(Modifier.height(12.dp))
            }
        }

        state.error?.let { ErrorBanner(it) }

        if (valid.isNotEmpty() || rows.isNotEmpty()) {
            val label = if (valid.size == 1) noun else nouns
            PrimaryButton(
                "Importar ${valid.size} $label",
                onClick = { viewModel.confirm(session) },
                modifier = Modifier.fillMaxWidth(),
                enabled = valid.isNotEmpty() && !state.loading && state.loadError == null,
                loading = state.busy,
            )
            if (invalid.isNotEmpty() && valid.isNotEmpty()) {
                Spacer(Modifier.height(6.dp))
                Text(
                    "Las ${invalid.size} filas con errores se omiten. Puedes corregirlas y volver a subir el archivo después.",
                    style = MaterialTheme.typography.labelSmall,
                    color = AlDiaColors.TextTertiary,
                )
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun CountTile(value: Int, label: String, background: Color, color: Color, modifier: Modifier) {
    Column(
        modifier
            .clip(RoundedCornerShape(14.dp))
            .background(background)
            .padding(vertical = 10.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(value.toString(), style = MaterialTheme.typography.titleLarge, color = color, fontWeight = FontWeight.Bold)
        Text(label, style = MaterialTheme.typography.labelSmall, color = color)
    }
}

@Composable
private fun StockChoice(title: String, example: String, selected: Boolean, onSelect: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onSelect).padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = null)
        Column {
            Text(title, style = MaterialTheme.typography.titleSmall, color = AlDiaColors.TextPrimary)
            Text(example, style = MaterialTheme.typography.labelSmall, color = AlDiaColors.TextTertiary)
        }
    }
}

@Composable
private fun ValidRow(row: ImportRow) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(row.name, style = MaterialTheme.typography.titleSmall, color = AlDiaColors.TextPrimary, fontWeight = FontWeight.SemiBold)
            Text(summary(row), style = MaterialTheme.typography.labelSmall, color = AlDiaColors.TextSecondary)
        }
        Spacer(Modifier.width(8.dp))
        if (row.creates) Pill("Nuevo", AlDiaColors.Success, AlDiaColors.SuccessSoft)
        else Pill("Actualiza", AlDiaColors.Blue, AlDiaColors.BlueSoft)
    }
}

private fun summary(row: ImportRow): String = when (row) {
    is ProductImportRow -> listOfNotNull(
        row.salePrice?.let { "Venta ${Format.money2(it)}" },
        row.purchasePrice?.let { "Compra ${Format.money2(it)}" },
        row.stock?.let { "Stock ${Format.quantity(it)}" },
    ).joinToString(" · ")
    is WarehouseImportRow -> listOfNotNull(
        row.unit ?: "pieza",
        row.cost?.let { "Costo ${Format.money2(it)}" },
        row.quantity?.let { "Cantidad ${Format.quantity(it)}" },
    ).joinToString(" · ")
    else -> ""
}

/** Nombre y contenido del archivo elegido; contenido null si no se puede leer. */
private fun readPicked(context: Context, uri: Uri): Pair<String, ByteArray?> {
    val name = context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
        ?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }
        ?: "archivo"
    val bytes = runCatching { context.contentResolver.openInputStream(uri)?.use { it.readBytes() } }.getOrNull()
    return name to bytes
}
