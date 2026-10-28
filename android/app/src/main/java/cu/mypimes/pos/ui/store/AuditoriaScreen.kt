package cu.mypimes.pos.ui.store

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cu.mypimes.pos.data.auth.Session
import cu.mypimes.pos.data.store.AuditReportDto
import cu.mypimes.pos.domain.Format
import cu.mypimes.pos.ui.components.AlDiaCard
import cu.mypimes.pos.ui.components.EmptyBlock
import cu.mypimes.pos.ui.components.ErrorBanner
import cu.mypimes.pos.ui.components.InfoBanner
import cu.mypimes.pos.ui.components.LoadingBlock
import cu.mypimes.pos.ui.components.Pill
import cu.mypimes.pos.ui.theme.AlDiaColors

/** Filtros de severidad, en el mismo orden y con las mismas etiquetas que la web (`Auditoria.jsx`). */
private val severityFilters = listOf(
    null to "Todos",
    "critical" to "Riesgo alto",
    "warning" to "Para revisar",
    "info" to "Observaciones",
    "ok" to "Sin anomalías",
)

/** Informes de auditoría de los cierres de caja (solo dueño, solo lectura; web: `Auditoria.jsx`). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AuditoriaScreen(session: Session, viewModel: AuditoriaViewModel, onBack: () -> Unit) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    LaunchedEffect(session.token) { viewModel.load(session) }

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Volver") }
            Text("Auditoría", style = MaterialTheme.typography.headlineSmall, color = AlDiaColors.TextPrimary, modifier = Modifier.weight(1f))
            IconButton(onClick = { viewModel.load(session) }, enabled = !state.loading) {
                Icon(Icons.Default.Refresh, contentDescription = "Actualizar", tint = AlDiaColors.TextSecondary)
            }
        }
        InfoBanner(
            "La IA revisa el cierre y explica qué pudo pasar. No cambia los totales y no acusa a nadie: " +
                "las cifras salen de las reglas de la tienda y la IA solo las redacta.",
        )
        Spacer(Modifier.height(10.dp))
        FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            severityFilters.forEach { (value, label) ->
                FilterChip(
                    selected = state.severity == value,
                    onClick = { viewModel.load(session, value) },
                    label = { Text(label) },
                )
            }
        }
        Spacer(Modifier.height(10.dp))
        state.error?.let { ErrorBanner(it); Spacer(Modifier.height(10.dp)) }

        val reports = state.reports
        when {
            reports == null && state.loading -> LoadingBlock()
            reports == null -> Unit
            reports.isEmpty() -> EmptyBlock(
                "Todavía no hay informes",
                "Se genera uno después de cada cierre. Si acabas de cerrar la caja, puede tardar un minuto.",
            )
            else -> LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(reports, key = { it.id }) { report -> ReportCard(report) }
                item { Spacer(Modifier.height(16.dp)) }
            }
        }
    }
}

@Composable
private fun ReportCard(report: AuditReportDto) {
    var open by rememberSaveable(report.id) { mutableStateOf(false) }
    val (label, color, background) = severityStyle(report.severity)
    AlDiaCard(Modifier.fillMaxWidth().clickable { open = !open }) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Pill(label, color, background)
                Spacer(Modifier.weight(1f))
                report.close?.difference?.let { diff ->
                    Text(
                        Format.signedMoney(diff), style = MaterialTheme.typography.titleSmall,
                        color = when {
                            diff < 0 -> AlDiaColors.Danger
                            diff > 0 -> AlDiaColors.Warning
                            else -> AlDiaColors.Success
                        },
                    )
                }
            }
            Text(
                report.headline ?: "Informe de cierre", style = MaterialTheme.typography.titleSmall,
                color = AlDiaColors.TextPrimary, maxLines = if (open) Int.MAX_VALUE else 2, overflow = TextOverflow.Ellipsis,
            )
            report.summary?.takeIf { it.isNotBlank() }?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = AlDiaColors.TextSecondary,
                    maxLines = if (open) Int.MAX_VALUE else 2, overflow = TextOverflow.Ellipsis)
            }
            Text(
                listOfNotNull(
                    report.close?.closedAt?.let { "Cierre del ${Format.dateTime(it)}" } ?: "Cierre no disponible",
                    report.close?.cashierEmail?.substringBefore('@')?.takeIf { it.isNotBlank() },
                ).joinToString(" · "),
                style = MaterialTheme.typography.labelSmall, color = AlDiaColors.TextTertiary,
            )
            if (open) ReportDetail(report)
        }
    }
}

@Composable
private fun ReportDetail(report: AuditReportDto) {
    val close = report.close
    Spacer(Modifier.height(4.dp))
    if (close != null) {
        Text(
            "Esperado ${Format.money(close.expectedCash ?: 0.0)} · Contado ${Format.money(close.countedCash ?: 0.0)}",
            style = MaterialTheme.typography.bodySmall, color = AlDiaColors.TextSecondary,
        )
    }
    if (report.signals.isNotEmpty()) {
        Text("Señales detectadas", style = MaterialTheme.typography.labelMedium, color = AlDiaColors.TextSecondary)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            report.signals.forEach { signal ->
                val (_, color, background) = severityStyle(signal.severity)
                val amount = signal.amount?.takeIf { it != 0.0 }?.let { " ${Format.money(it, 2)}" }.orEmpty()
                Pill("${signal.title.orEmpty()}$amount", color, background)
            }
        }
    }
    if (report.findings.isEmpty()) {
        Text("No se detectaron anomalías monetarias en este cierre.", style = MaterialTheme.typography.bodySmall, color = AlDiaColors.TextSecondary)
    } else {
        report.findings.forEach { finding ->
            Column(Modifier.fillMaxWidth().padding(top = 4.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(
                    "${finding.probableCause.orEmpty()} · ${confidenceLabel(finding.confidence)}",
                    style = MaterialTheme.typography.titleSmall, color = AlDiaColors.TextPrimary,
                )
                finding.evidence.forEach { item ->
                    Text("· $item", style = MaterialTheme.typography.bodySmall, color = AlDiaColors.TextSecondary)
                }
                finding.recommendation?.takeIf { it.isNotBlank() }?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall, color = AlDiaColors.Blue)
                }
            }
        }
    }
    if (report.questions.isNotEmpty()) {
        Text("Para confirmar", style = MaterialTheme.typography.labelMedium, color = AlDiaColors.TextSecondary)
        report.questions.forEach { Text("· $it", style = MaterialTheme.typography.bodySmall, color = AlDiaColors.TextSecondary) }
    }
    report.nextStep?.takeIf { it.isNotBlank() }?.let {
        Text("Siguiente paso: $it", style = MaterialTheme.typography.bodySmall, color = AlDiaColors.TextPrimary)
    }
    Text(
        "Generado ${Format.dateTime(report.createdAt)}" +
            (report.model?.let { " · $it" } ?: "") +
            (if (report.status == "fallback") " · la IA no estaba disponible; se muestra el informe automático" else ""),
        style = MaterialTheme.typography.labelSmall, color = AlDiaColors.TextTertiary,
    )
}

/** Etiqueta, texto y fondo de cada severidad (mismos nombres que `AUDIT_SEVERITY` de la web). */
private fun severityStyle(severity: String?): Triple<String, Color, Color> = when (severity) {
    "critical" -> Triple("Riesgo alto", AlDiaColors.Danger, AlDiaColors.DangerSoft)
    "warning" -> Triple("Para revisar", AlDiaColors.Warning, AlDiaColors.WarningSoft)
    "ok" -> Triple("Sin anomalías", AlDiaColors.Success, AlDiaColors.SuccessSoft)
    else -> Triple("Observación", AlDiaColors.Blue, AlDiaColors.BlueSoft)
}

private fun confidenceLabel(value: String?): String = when (value) {
    "alta" -> "Confianza alta"
    "baja" -> "Confianza baja"
    else -> "Confianza media"
}
