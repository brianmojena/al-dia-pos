import { useEffect, useState } from 'react'
import { Pencil, Ban, History } from 'lucide-react'
import { apiFetch, isElectron } from '../lib/api'
import { syncOffline } from '../lib/offlineClient.js'
import { useAuth } from '../context/AuthContext'
import { paymentLabel, foreignNeeded, fmtForeign } from '../lib/payment'
import { accountLabel } from '../lib/accountLabel'

const fmt = (n) => '$ ' + new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 }).format(Math.round(n || 0))
const when = (s) => new Date(String(s).replace(' ', 'T') + 'Z').toLocaleString()
const num = (v) => parseFloat(String(v ?? '').replace(',', '.'))

// "faltaron 1.200" / "cuadró" / "sobraron 300", para contar cómo quedó un cierre.
export const closeResult = (difference) => {
  const d = Math.round(Number(difference) || 0)
  if (d === 0) return 'cuadró'
  return d < 0 ? `faltaron ${fmt(-d)}` : `sobraron ${fmt(d)}`
}

/**
 * Lo que cambió una corrección, en una línea: "Efectivo → Transferencia" o
 * "Anulada". Si la venta estaba en un cierre, cómo quedó ese cierre.
 */
export function CorrectionLine({ correction: c, showSale = false }) {
  const sold = c.before?.created_at ? when(c.before.created_at) : ''
  const what = c.action === 'anular'
    ? `${showSale ? `Venta de ${fmt(c.before?.total)} (${sold}) ` : 'Venta '}anulada`
    : `${showSale ? `Venta de ${fmt(c.before?.total)}: ` : ''}${paymentLabel(c.before || {})} → ${paymentLabel(c.after || {})}`
  return (
    <div className="text-xs text-gray-600">
      <p>
        <span className="font-semibold text-gray-800">{what}</span>
        <span className="text-gray-400"> · {accountLabel(c.account_email) || 'cuenta principal'} · {when(c.created_at)}</span>
      </p>
      {c.reason && <p className="text-gray-500 italic">«{c.reason}»</p>}
      {c.close_before && c.close_after && (
        <p className="text-gray-500">Cierre de caja: {closeResult(c.close_before.difference)} → {closeResult(c.close_after.difference)}</p>
      )}
    </div>
  )
}

/**
 * Corrección de una venta por la cuenta principal: cambiar la forma de pago o
 * anularla (las unidades vuelven al stock). Se hace en el servidor, así que
 * necesita internet; si la venta estaba en un cierre, el cierre se recalcula.
 */
export default function SaleCorrection({ sale, items = [], onChanged }) {
  const { user } = useAuth()
  const [mode, setMode] = useState(null) // null | 'pago' | 'anular'
  const [method, setMethod] = useState('efectivo')
  const [transfer, setTransfer] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [amount, setAmount] = useState('')
  const [rate, setRate] = useState('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [history, setHistory] = useState([])

  useEffect(() => {
    if (sale.pending) return
    let alive = true
    apiFetch(`/api/sales/${sale.id}/corrections`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => { if (alive) setHistory(Array.isArray(rows) ? rows : []) })
      .catch(() => {})
    return () => { alive = false }
  }, [sale.id, sale.pending])

  if (sale.pending) {
    return <p className="text-xs text-gray-400 mt-3">Esta venta todavía no subió. Se podrá corregir cuando sincronice.</p>
  }

  const shopRate = (code) => Number(code === 'EUR' ? user?.eur_rate : user?.usd_rate) || ''
  const openPayment = () => {
    const current = sale.payment_method || 'efectivo'
    setMethod(current === 'efectivo' ? 'transferencia' : 'efectivo')
    setTransfer(sale.transfer_amount ?? '')
    const code = sale.foreign_currency || 'USD'
    setCurrency(code)
    const r = sale.exchange_rate || shopRate(code)
    setRate(r)
    setAmount(sale.foreign_amount ?? (r ? foreignNeeded(sale.total, r) : ''))
    setReason('')
    setError('')
    setMode('pago')
  }
  const openVoid = () => { setReason(''); setError(''); setMode('anular') }

  const changeCurrency = (code) => {
    setCurrency(code)
    const r = shopRate(code)
    setRate(r)
    setAmount(r ? foreignNeeded(sale.total, r) : '')
  }

  const submit = async () => {
    const body = { action: mode, reason: reason.trim() || undefined }
    if (mode === 'pago') {
      body.payment_method = method
      if (method === 'mixto') body.transfer_amount = num(transfer)
      if (method === 'divisa') Object.assign(body, { foreign_currency: currency, foreign_amount: num(amount), exchange_rate: num(rate) })
    }
    setSaving(true)
    setError('')
    try {
      if (!isElectron() && navigator.onLine === false) throw new Error('Para corregir ventas hace falta internet.')
      const res = await apiFetch(`/api/sales/${sale.id}/correct`, { method: 'POST', body: JSON.stringify(body) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'No se pudo corregir la venta.')
      // En el teléfono las ventas se leen de la copia local: hay que bajarla de nuevo.
      if (!isElectron()) await syncOffline().catch(() => {})
      setMode(null)
      if (data.correction) setHistory((h) => [data.correction, ...h])
      onChanged?.(data)
    } catch (err) {
      setError(err.message === 'Failed to fetch' ? 'Para corregir ventas hace falta internet.' : err.message)
    } finally {
      setSaving(false)
    }
  }

  const units = items.reduce((n, i) => n + Number(i.quantity || 0), 0)
  const input = 'w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#007AFF]/30 bg-white'

  return (
    <div className="mt-3 pt-3 border-t border-gray-200">
      {history.length > 0 && (
        <div className="mb-3 space-y-2">
          <p className="flex items-center gap-1 text-[11px] font-semibold text-gray-400 uppercase tracking-wide">
            <History size={12} /> Correcciones
          </p>
          {history.map((c) => <CorrectionLine key={c.id} correction={c} />)}
        </div>
      )}

      {mode === null && (
        <div className="flex gap-2">
          <button onClick={openPayment} className="flex-1 flex items-center justify-center gap-1.5 text-xs font-semibold text-[#007AFF] bg-white border border-gray-200 rounded-xl py-2 hover:bg-blue-50">
            <Pencil size={13} /> Cambiar forma de pago
          </button>
          <button onClick={openVoid} className="flex-1 flex items-center justify-center gap-1.5 text-xs font-semibold text-red-600 bg-white border border-gray-200 rounded-xl py-2 hover:bg-red-50">
            <Ban size={13} /> Anular venta
          </button>
        </div>
      )}

      {mode === 'pago' && (
        <div className="space-y-2.5">
          <p className="text-sm font-semibold text-gray-800">¿Cómo se cobró de verdad? <span className="font-normal text-gray-400">(ahora: {paymentLabel(sale)})</span></p>
          <div className="grid grid-cols-4 gap-1.5">
            {[['efectivo', 'Efectivo'], ['transferencia', 'Transf.'], ['mixto', 'Mixto'], ['divisa', 'Divisa']].map(([value, label]) => (
              <button key={value} onClick={() => setMethod(value)}
                className={`text-xs font-semibold py-2 rounded-xl border ${method === value ? 'bg-[#007AFF] text-white border-[#007AFF]' : 'bg-white text-gray-700 border-gray-200'}`}>
                {label}
              </button>
            ))}
          </div>
          {method === 'mixto' && (
            <label className="block text-xs text-gray-500">
              Cuánto fue por transferencia (el resto, hasta {fmt(sale.total)}, en efectivo)
              <input className={input} inputMode="decimal" value={transfer} onChange={(e) => setTransfer(e.target.value)} />
            </label>
          )}
          {method === 'divisa' && (
            <div className="grid grid-cols-3 gap-2">
              <label className="block text-xs text-gray-500">Moneda
                <select className={input} value={currency} onChange={(e) => changeCurrency(e.target.value)}>
                  <option value="USD">USD</option>
                  <option value="EUR">EUR</option>
                </select>
              </label>
              <label className="block text-xs text-gray-500">Billetes
                <input className={input} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </label>
              <label className="block text-xs text-gray-500">Tasa
                <input className={input} inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
              </label>
              {num(amount) > 0 && num(rate) > 0 && (
                <p className="col-span-3 text-xs text-gray-500">
                  {fmtForeign(num(amount))} {currency} = {fmt(num(amount) * num(rate))}
                  {Math.round(sale.total - num(amount) * num(rate)) > 0 && <> · el cliente completó {fmt(sale.total - num(amount) * num(rate))} en efectivo</>}
                  {Math.round(sale.total - num(amount) * num(rate)) < 0 && <> · vuelto {fmt(num(amount) * num(rate) - sale.total)}</>}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {mode === 'anular' && (
        <div className="bg-red-50 rounded-xl px-3 py-2.5 text-sm text-red-800">
          <p className="font-semibold">¿Anular la venta de {fmt(sale.total)}?</p>
          <p className="text-xs mt-0.5">
            La venta desaparece del historial{units > 0 && <> y {units === 1 ? 'vuelve 1 unidad' : `vuelven ${units} unidades`} al stock</>}.
            Si ya estaba en un cierre de caja, ese cierre se recalcula. Queda anotado quién la anuló.
          </p>
        </div>
      )}

      {mode !== null && (
        <div className="mt-2.5 space-y-2">
          <input className={input} placeholder="Motivo (opcional)" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex gap-2">
            <button onClick={() => setMode(null)} disabled={saving} className="flex-1 text-xs font-semibold text-gray-600 bg-white border border-gray-200 rounded-xl py-2">
              Cancelar
            </button>
            <button onClick={submit} disabled={saving}
              className={`flex-1 text-xs font-semibold text-white rounded-xl py-2 disabled:opacity-50 ${mode === 'anular' ? 'bg-red-600' : 'bg-[#007AFF]'}`}>
              {saving ? 'Guardando...' : mode === 'anular' ? 'Sí, anular' : 'Guardar'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Ventas anuladas: ya no salen en la lista, así que se muestran aparte. Con
 * date, las de las ventas de ese día; sin date, las últimas. Necesita
 * internet; sin red simplemente no aparece.
 */
export function VoidedSales({ date, refreshKey }) {
  const [rows, setRows] = useState([])
  useEffect(() => {
    let alive = true
    apiFetch(`/api/sales/corrections${date ? `?date=${date}` : ''}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => { if (alive) setRows(Array.isArray(data) ? data.filter((c) => c.action === 'anular') : []) })
      .catch(() => {})
    return () => { alive = false }
  }, [date, refreshKey])
  if (rows.length === 0) return null
  return (
    <div className="bg-white rounded-2xl shadow-sm px-5 py-4 mt-4 space-y-2.5">
      <p className="flex items-center gap-1 text-xs font-semibold text-gray-400 uppercase tracking-wide">
        <Ban size={12} /> {rows.length === 1 ? 'Venta anulada' : 'Ventas anuladas'}
      </p>
      {rows.map((c) => <CorrectionLine key={c.id} correction={c} showSale />)}
    </div>
  )
}
