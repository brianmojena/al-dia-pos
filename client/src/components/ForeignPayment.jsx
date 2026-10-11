import { useState } from 'react'
import { ChevronLeft, Pencil } from 'lucide-react'
import { foreignBreakdown, foreignNeeded, fmtForeign } from '../lib/payment'
import { setDeviceRate } from '../lib/exchangeRates'

const SYMBOL = { USD: 'USD', EUR: 'EUR' }

/**
 * Cobro en dólares o euros.
 *
 * El cajero elige la moneda y escribe cuántos billetes le dio el cliente; la
 * pantalla dice al momento si hay que dar vuelto en pesos o si el cliente
 * tiene que completar en pesos. La tasa sale de este aparato (o de la tienda)
 * y se puede cambiar aquí mismo: el cambio queda guardado en el aparato para
 * los próximos cobros, aunque no haya internet.
 */
export default function ForeignPayment({ total, rates, fmt, disabled, onConfirm, onBack }) {
  const [currency, setCurrency] = useState(() => (rates.USD.rate == null && rates.EUR.rate != null ? 'EUR' : 'USD'))
  const [amount, setAmount] = useState('')
  const [editingRate, setEditingRate] = useState(rates[currency].rate == null)
  const [rateDraft, setRateDraft] = useState(rates[currency].rate == null ? '' : String(rates[currency].rate))

  const current = rates[currency]
  const rate = editingRate ? Number(rateDraft) : current.rate
  const validRate = Number.isFinite(rate) && rate > 0
  const typed = Number(amount)
  const validAmount = amount.trim() !== '' && Number.isFinite(typed) && typed > 0
  const { cashToCollect, change } = foreignBreakdown(total, validAmount ? typed : 0, validRate ? rate : 0)

  const switchCurrency = (next) => {
    if (next === currency) return
    setCurrency(next)
    setAmount('')
    setEditingRate(rates[next].rate == null)
    setRateDraft(rates[next].rate == null ? '' : String(rates[next].rate))
  }

  // La tasa escrita se guarda en el aparato con OK, Enter o al cobrar: así la
  // próxima venta ya sale con ella. No al perder el foco: el aviso de tasa
  // distinta movería el botón "Cobrar" justo debajo del dedo.
  const commitRate = () => {
    const n = Number(rateDraft)
    if (!Number.isFinite(n) || n <= 0) return
    // Si escribió justo la de la tienda, el aparato vuelve a seguir a la tienda.
    setDeviceRate(currency, current.shopRate != null && Math.abs(n - current.shopRate) < 0.005 ? null : n)
    setEditingRate(false)
  }

  const confirm = () => {
    if (!validRate || !validAmount) return
    if (editingRate) commitRate()
    onConfirm({
      payment_method: 'divisa',
      foreign_currency: currency,
      foreign_amount: Math.round(typed * 100) / 100,
      exchange_rate: rate,
      shop_rate: current.shopRate,
    })
  }

  const differs = validRate && current.shopRate != null && Math.abs(rate - current.shopRate) > 0.005
  const confirmLabel = !validAmount
    ? `Escribe cuántos ${SYMBOL[currency]} te dio`
    : change > 0 ? `Cobrar ${fmtForeign(typed)} ${currency} · vuelto ${fmt(change)}`
    : cashToCollect > 0 ? `Cobrar ${fmtForeign(typed)} ${currency} + ${fmt(cashToCollect)}`
    : `Cobrar ${fmtForeign(typed)} ${currency}`

  return (
    <div>
      <div className="grid grid-cols-2 gap-2 mb-4">
        {['USD', 'EUR'].map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => switchCurrency(c)}
            className={`py-2.5 rounded-xl font-bold text-sm transition-all ${
              currency === c ? 'bg-amber-500 text-white shadow-md shadow-amber-200' : 'bg-gray-100 text-gray-500'
            }`}
          >
            {c === 'USD' ? 'Dólares (USD)' : 'Euros (EUR)'}
          </button>
        ))}
      </div>

      <div className="bg-amber-50 rounded-xl px-3 py-2.5 mb-4">
        {editingRate ? (
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-amber-800 flex-shrink-0">1 {currency} =</span>
            <input
              type="number" inputMode="decimal" min="0" step="any" autoFocus
              value={rateDraft}
              onChange={(e) => setRateDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') commitRate() }}
              placeholder="Tasa"
              className="flex-1 min-w-0 px-2 py-1 text-base font-bold rounded-lg border border-amber-200 focus:outline-none focus:ring-2 focus:ring-amber-300"
            />
            <span className="text-sm text-amber-800 flex-shrink-0">CUP</span>
            {current.rate != null && (
              <button type="button" onClick={commitRate} className="text-xs font-bold text-amber-800 px-2 py-1 rounded-lg bg-amber-100">
                OK
              </button>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => { setRateDraft(String(current.rate)); setEditingRate(true) }}
            className="w-full flex items-center justify-between text-sm"
            title="Toca para cambiar la tasa de este aparato"
          >
            <span className="font-semibold text-amber-800">1 {currency} = {fmt(current.rate)}</span>
            <span className="flex items-center gap-1 text-xs text-amber-700">
              {current.source === 'device' ? 'tasa de este aparato' : 'tasa de la tienda'} <Pencil size={12} />
            </span>
          </button>
        )}
        {differs && (
          <p className="text-[11px] text-orange-700 mt-1.5">
            La tienda tiene {fmt(current.shopRate)}. El dueño verá que cobraste a otra tasa.
          </p>
        )}
        {current.shopRate == null && (
          <p className="text-[11px] text-amber-700 mt-1.5">La tienda no tiene tasa puesta: se usa la de este aparato.</p>
        )}
      </div>

      <label className="text-xs font-semibold text-gray-500 block mb-1">¿Cuántos {currency} te dio el cliente?</label>
      <input
        type="number" inputMode="decimal" min="0" step="any"
        autoFocus={!editingRate}
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') confirm() }}
        placeholder={validRate ? `Hacen falta ${fmtForeign(foreignNeeded(total, rate))}` : '0'}
        className="w-full px-4 py-3 text-2xl font-bold rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-amber-300"
      />

      <div className="mt-3 min-h-[44px]">
        {validAmount && validRate && change > 0 && (
          <div className="flex justify-between items-center bg-green-50 rounded-xl px-4 py-2.5">
            <span className="text-sm font-semibold text-green-800">Vuelto en pesos</span>
            <span className="text-xl font-bold text-green-700">{fmt(change)}</span>
          </div>
        )}
        {validAmount && validRate && cashToCollect > 0 && (
          <div className="flex justify-between items-center bg-blue-50 rounded-xl px-4 py-2.5">
            <span className="text-sm font-semibold text-blue-800">Falta, en pesos</span>
            <span className="text-xl font-bold text-[#007AFF]">{fmt(cashToCollect)}</span>
          </div>
        )}
        {validAmount && validRate && change === 0 && cashToCollect === 0 && (
          <p className="text-sm text-center text-gray-500 py-2.5">Justo, sin vuelto.</p>
        )}
      </div>

      <button
        onClick={confirm}
        disabled={disabled || !validAmount || !validRate}
        className="w-full mt-3 bg-gray-900 text-white py-4 rounded-2xl font-bold text-base active:scale-95 transition-all disabled:opacity-40"
      >
        {confirmLabel}
      </button>
      <button
        onClick={onBack}
        className="w-full flex items-center justify-center gap-1 text-gray-400 py-3 text-sm hover:text-gray-600 transition-colors mt-2"
      >
        <ChevronLeft size={16} /> Otra forma de pago
      </button>
    </div>
  )
}
