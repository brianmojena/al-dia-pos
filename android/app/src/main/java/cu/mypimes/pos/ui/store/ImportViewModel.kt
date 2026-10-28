package cu.mypimes.pos.ui.store

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cu.mypimes.pos.data.auth.Session
import cu.mypimes.pos.data.auth.accountKeyFromToken
import cu.mypimes.pos.data.store.ImportResultDto
import cu.mypimes.pos.data.store.ProductRepository
import cu.mypimes.pos.data.store.WarehouseRepository
import cu.mypimes.pos.domain.imports.EXCEL_FILE_MESSAGE
import cu.mypimes.pos.domain.imports.ImportRow
import cu.mypimes.pos.domain.imports.SheetPreview
import cu.mypimes.pos.domain.imports.decodeSheet
import cu.mypimes.pos.domain.imports.looksLikeExcelBinary
import cu.mypimes.pos.domain.products.ProductImportRow
import cu.mypimes.pos.domain.products.buildProductImport
import cu.mypimes.pos.domain.warehouse.ExistingArticle
import cu.mypimes.pos.domain.warehouse.WarehouseImportRow
import cu.mypimes.pos.domain.warehouse.buildWarehouseImport
import dagger.hilt.android.lifecycle.HiltViewModel
import java.io.IOException
import javax.inject.Inject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

enum class ImportTarget { PRODUCTOS, ALMACEN }

data class ImportUiState(
    val target: ImportTarget? = null,
    val loading: Boolean = true,
    val loadError: String? = null,
    val existing: List<ExistingArticle> = emptyList(),
    val fileName: String? = null,
    val excel: Boolean = false,
    val content: String = "",
    val preview: SheetPreview<ImportRow>? = null,
    val addStock: Boolean = true,
    val busy: Boolean = false,
    val error: String? = null,
    val done: ImportResultDto? = null,
) {
    val valid: List<ImportRow> get() = preview?.rows?.filter { it.errors.isEmpty() }.orEmpty()
    /** Hay artículos que ya existen y la hoja trae stock para ellos: ahí importa la elección de sumar o reemplazar. */
    val replacesStock: Boolean get() = valid.any { !it.creates && it.setsStock }
}

/** Carga masiva de productos y del almacén desde Más. Misma lógica y reglas que la web (ImportarProductos.jsx). */
@HiltViewModel
class ImportViewModel @Inject constructor(
    private val products: ProductRepository,
    private val warehouse: WarehouseRepository,
) : ViewModel() {
    private val _state = MutableStateFlow(ImportUiState())
    val state = _state.asStateFlow()

    private var loadJob: Job? = null

    /** Siempre empieza de cero: cada apertura carga la lista actual para marcar nuevos y actualizaciones. */
    fun bind(session: Session, target: ImportTarget) {
        loadJob?.cancel()
        _state.value = ImportUiState(target = target)
        loadJob = viewModelScope.launch {
            try {
                val existing = loadExisting(session, target)
                _state.update { withPreview(it.copy(loading = false, existing = existing)) }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                _state.update { it.copy(loading = false, loadError = error.message ?: "No se pudo cargar la lista actual.") }
            }
        }
    }

    private suspend fun loadExisting(session: Session, target: ImportTarget): List<ExistingArticle> = when (target) {
        ImportTarget.PRODUCTOS -> {
            // En caja central se puede importar sin red: va a la cola con lo último guardado como referencia.
            products.refresh(session)?.let { if (!products.queuesWrites(session)) throw IOException(it) }
            val key = accountKeyFromToken(session.token, session.user.id)
                ?: throw IOException("No se pudo identificar la cuenta de esta sesión.")
            products.catalog(key).first().map { ExistingArticle(it.name, null) }
        }
        ImportTarget.ALMACEN -> {
            val served = warehouse.items(session)
            // Importar compara con el almacén real: una copia guardada podría estar vieja.
            if (served.staleSince != null && !warehouse.queuesWrites(session)) throw IOException("Sin conexión con el servidor. Para importar hace falta internet.")
            served.data.map { ExistingArticle(it.name, it.unit) }
        }
    }

    /** Archivo elegido. `bytes` null = no se pudo leer. */
    fun onFile(name: String, bytes: ByteArray?) {
        if (bytes == null) {
            _state.update { it.copy(error = "No se pudo leer el archivo. Vuelve a elegirlo.") }
            return
        }
        val excel = looksLikeExcelBinary(bytes)
        _state.update {
            withPreview(it.copy(fileName = name, excel = excel, content = if (excel) "" else decodeSheet(bytes), error = null, done = null))
        }
    }

    /** Texto pegado desde Excel o Google Sheets. */
    fun onPaste(text: String) {
        _state.update { withPreview(it.copy(fileName = null, excel = false, content = text, error = null, done = null)) }
    }

    fun setAddStock(add: Boolean) = _state.update { it.copy(addStock = add) }

    fun confirm(session: Session) {
        val current = _state.value
        val target = current.target ?: return
        if (current.busy || current.loading || current.loadError != null || current.valid.isEmpty()) return
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            try {
                val result = when (target) {
                    ImportTarget.PRODUCTOS -> products.importRows(session, current.valid.filterIsInstance<ProductImportRow>(), current.addStock)
                    ImportTarget.ALMACEN -> warehouse.importRows(session, current.valid.filterIsInstance<WarehouseImportRow>(), current.addStock)
                }
                _state.update { it.copy(busy = false, done = result) }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                _state.update { it.copy(busy = false, error = error.message ?: "No se pudo importar.") }
            }
        }
    }

    private fun withPreview(s: ImportUiState): ImportUiState {
        val text = s.content
        val target = s.target
        val preview: SheetPreview<ImportRow>? = when {
            target == null -> null
            s.excel -> SheetPreview(error = EXCEL_FILE_MESSAGE)
            s.fileName == null && text.isBlank() -> null
            target == ImportTarget.PRODUCTOS -> buildProductImport(text, s.existing.map { it.name })
            else -> buildWarehouseImport(text, s.existing)
        }
        return s.copy(preview = preview)
    }
}
