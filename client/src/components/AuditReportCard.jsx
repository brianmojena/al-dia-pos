import { useState } from 'react'
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Info, RefreshCw, ShieldAlert,
} from 'lucide-react'
import { formatDateTime } from '../lib/dates'
import { accountLabel } from '../lib/accountLabel'

const fmt = (n) => '$ ' + new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 }).format(Math.round(Number(n) || 0))
const fmtAmount = (n, currency = 'CUP') => {
  const value = Number(n) || 0
  if (!currency || currency === 'CUP') return fmt(value)
  return `${new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 }).format(value)} ${currency}`
}
const fmtSigned = (n) => {
  const value = Math.round(Number(n) || 0)
  if (value === 0) return fmt(0)
  return `${value < 0 ? '−' : '+'}${fmt(Math.abs(value))}`
}

export const AUDIT_SEVERITY = {
  critical: { label: 'Riesgo alto', badge: 'bg-red-100 text-red-700', dot: 'bg-red-500', Icon: ShieldAlert },
  warning: { label: 'Para revisar', badge: 'bg-amber-100 text-amber-700', dot: 'bg-amber-500', Icon: AlertTriangle },
  info: { label: 'Observación', badge: 'bg-blue-100 text-blue-700', dot: 'bg-blue-500', Icon: Info },
  ok: { label: 'Sin anomalías', badge: 'bg-green-100 text-green-700', dot: 'bg-green-500', Icon: CheckCircle2 },
}

export const auditSeverityOf = (report) => AUDIT_SEVERITY[report?.severity] || AUDIT_SEVERITY.info

const sourceLabel = (report) => {
  if (report.status === 'fallback') return 'Respaldo automático'
  if (report.model) return 'IA + reglas'
  return 'Solo reglas'
}

const confidenceLabel = (value) => (
  value === 'alta' ? 'Confianza alta' : value === 'baja' ? 'Confianza baja' : 'Confianza media'
)

export default function AuditReportCard({ report, showStore = false, onRetry = null }) {
  const [open, setOpen] = useState(false)
  const tone = auditSeverityOf(report)
  const close = report.close
  const difference = Number(close?.difference) || 0
  const cashier = accountLabel(close?.cashier_email)
    || report.metrics?.close?.closing_cashier_label
    || null

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      <button
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="w-full text-left p-5 hover:bg-gray-50/60 transition-colors"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-full ${tone.badge}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${tone.dot}`} />
                {tone.label}
              </span>
              <span className="text-[11px] font-medium text-gray-400">{sourceLabel(report)}</span>
              {showStore && report.store_name && (
                <span className="text-[11px] font-semibold text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full truncate max-w-[14rem]">
                  {report.store_name}
                </span>
              )}
            </div>
            <p className="font-bold text-gray-900 leading-snug">{report.headline}</p>
            <p className="text-sm text-gray-500 mt-1 line-clamp-2">{report.summary}</p>
            <p className="text-[11px] text-gray-400 mt-2">
              {close?.closed_at ? `Cierre del ${formatDateTime(close.closed_at)}` : 'Cierre no disponible'}
              {cashier ? ` · ${cashier}` : ''}
              {report.source_revision > 0 ? ` · revisión ${report.source_revision}` : ''}
            </p>
          </div>
          <div className="flex flex-col items-end gap-1 flex-shrink-0">
            {close && (
              <span className={`text-sm font-bold ${
                difference < 0 ? 'text-red-600' : difference > 0 ? 'text-orange-500' : 'text-green-600'
              }`}>
                {fmtSigned(difference)}
              </span>
            )}
            {open ? <ChevronUp size={18} className="text-gray-300" /> : <ChevronDown size={18} className="text-gray-300" />}
          </div>
        </div>
      </button>

      {open && (
        <div className="border-t border-gray-100 px-5 py-5 bg-gray-50/40">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-5">
            {[
              ['Esperado', fmt(close?.expected_cash ?? report.metrics?.close?.expected_cash)],
              ['Contado', fmt(close?.counted_cash ?? report.metrics?.close?.counted_cash)],
              ['Diferencia', fmtSigned(difference)],
              ['Señales', String(report.signals?.length || 0)],
            ].map(([label, value]) => (
              <div key={label} className="bg-white rounded-xl border border-gray-100 px-3 py-2.5">
                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">{label}</p>
                <p className="text-sm font-bold text-gray-900 mt-0.5">{value}</p>
              </div>
            ))}
          </div>

          {report.signals?.length > 0 && (
            <div className="mb-5">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Señales detectadas</p>
              <div className="flex flex-wrap gap-2">
                {report.signals.map((signal, index) => {
                  const signalTone = AUDIT_SEVERITY[signal.severity] || AUDIT_SEVERITY.info
                  return (
                    <span
                      key={`${signal.id}-${index}`}
                      className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1.5 rounded-lg ${signalTone.badge}`}
                      title={signal.evidence}
                    >
                      {signal.title}
                      {signal.amount != null && signal.amount !== 0 && (
                        <strong>{fmtAmount(signal.amount, signal.currency)}</strong>
                      )}
                    </span>
                  )
                })}
              </div>
            </div>
          )}

          {report.findings?.length > 0 ? (
            <div className="space-y-3">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Qué pudo pasar</p>
              {report.findings.map((finding, index) => (
                <div key={index} className="bg-white rounded-xl border border-gray-100 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-semibold text-gray-900">{finding.probable_cause}</p>
                    <span className="flex-shrink-0 text-[10px] font-semibold text-gray-400 uppercase tracking-wide">
                      {confidenceLabel(finding.confidence)}
                    </span>
                  </div>
                  {finding.evidence?.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {finding.evidence.map((item, evidenceIndex) => (
                        <li key={evidenceIndex} className="text-xs text-gray-500 leading-relaxed flex gap-1.5">
                          <span className="text-gray-300">·</span>
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {finding.recommendation && (
                    <p className="text-xs text-[#007AFF] mt-2 font-medium">{finding.recommendation}</p>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-500">
              No se detectaron anomalías monetarias en este cierre.
            </p>
          )}

          {report.questions?.length > 0 && (
            <div className="mt-4">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Para confirmar</p>
              <ul className="space-y-1">
                {report.questions.map((question, index) => (
                  <li key={index} className="text-xs text-gray-500">· {question}</li>
                ))}
              </ul>
            </div>
          )}

          {report.next_step && (
            <p className="text-xs text-gray-600 bg-white border border-gray-100 rounded-xl px-3.5 py-3 mt-4">
              <strong className="text-gray-800">Siguiente paso:</strong> {report.next_step}
            </p>
          )}

          <p className="text-[10px] text-gray-400 mt-4">
            Generado {formatDateTime(report.created_at)}
            {report.model ? ` · ${report.model}` : ''}
            {report.status === 'fallback' ? ' · la IA no estaba disponible; se muestra el informe automático' : ''}
          </p>

          {onRetry && report.status === 'fallback' && (
            <button
              onClick={() => onRetry(report)}
              className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-[#007AFF] bg-blue-50 hover:bg-blue-100 rounded-lg px-3 py-2 transition-colors"
            >
              <RefreshCw size={13} /> Reintentar con IA
            </button>
          )}
        </div>
      )}
    </div>
  )
}
