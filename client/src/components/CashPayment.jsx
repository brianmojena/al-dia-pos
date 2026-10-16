import { useState } from 'react'
import { ChevronLeft } from 'lucide-react'
import { cashPaymentBreakdown } from '../lib/cashPayment.js'

export default function CashPayment({ total, fmt, disabled, onConfirm, onBack }) {
  const [amount, setAmount] = useState('')
  const breakdown = cashPaymentBreakdown(total, amount)

  const confirm = () => {
    const current = cashPaymentBreakdown(total, amount)
    if (disabled || !current.canConfirm) return
    onConfirm(amount)
  }

  let confirmLabel = 'Escribe cuánto CUP entregó el cliente'
  if (breakdown.validAmount) {
    if (breakdown.shortfallCents > 0) confirmLabel = `Falta ${fmt(breakdown.shortfallCents / 100)}`
    else if (breakdown.changeCents > 0) confirmLabel = `Cobrar · vuelto ${fmt(breakdown.changeCents / 100)}`
    else confirmLabel = 'Cobrar exacto'
  }

  return (
    <div>
      <label htmlFor="cash-amount" className="text-xs font-semibold text-gray-500 block mb-1">
        ¿Cuánto CUP entregó el cliente?
      </label>
      <input
        id="cash-amount"
        type="text"
        inputMode="decimal"
        autoFocus
        value={amount}
        onChange={(event) => setAmount(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') confirm() }}
        placeholder="0,00"
        className="w-full px-4 py-3 text-2xl font-bold rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-green-300"
      />

      <div className="mt-3 min-h-[44px]">
        {breakdown.validAmount && breakdown.changeCents > 0 && (
          <div className="flex justify-between items-center bg-green-50 rounded-xl px-4 py-2.5">
            <span className="text-sm font-semibold text-green-800">Vuelto</span>
            <span className="text-xl font-bold text-green-700">{fmt(breakdown.changeCents / 100)}</span>
          </div>
        )}
        {breakdown.validAmount && breakdown.shortfallCents > 0 && (
          <div className="flex justify-between items-center bg-blue-50 rounded-xl px-4 py-2.5">
            <span className="text-sm font-semibold text-blue-800">Falta</span>
            <span className="text-xl font-bold text-[#007AFF]">{fmt(breakdown.shortfallCents / 100)}</span>
          </div>
        )}
        {breakdown.validAmount && breakdown.shortfallCents === 0 && breakdown.changeCents === 0 && (
          <p className="text-sm text-center text-gray-500 py-2.5">Exacto, sin vuelto.</p>
        )}
      </div>

      <button
        type="button"
        onClick={confirm}
        disabled={disabled || !breakdown.canConfirm}
        className="w-full mt-3 bg-gray-900 text-white py-4 rounded-2xl font-bold text-base active:scale-95 transition-all disabled:opacity-40"
      >
        {confirmLabel}
      </button>
      <button
        type="button"
        onClick={onBack}
        className="w-full flex items-center justify-center gap-1 text-gray-400 py-3 text-sm hover:text-gray-600 transition-colors mt-2"
      >
        <ChevronLeft size={16} /> Volver a formas de pago
      </button>
    </div>
  )
}
