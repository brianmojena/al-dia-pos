import { useState } from 'react'
import { Banknote, Smartphone, ChevronLeft } from 'lucide-react'
import { maxTransfer, initialTransfer, clampTransfer, mixedPayload } from '../lib/payment'

/**
 * Cobro "transferencia + efectivo".
 *
 * El slider reparte el total: a la izquierda lo que se transfiere, a la
 * derecha lo que entra en efectivo. Se monta de nuevo cada vez que se abre,
 * así que siempre arranca en 50/50. Para la cifra exacta que dice el cliente
 * ("te transfiero 1.350") se toca cualquiera de los dos montos y se escribe;
 * el otro lado se calcula solo.
 */
export default function MixedPayment({ total, transferLimit, fmt, disabled, onConfirm, onBack }) {
  const max = maxTransfer(total, transferLimit)
  const [transfer, setTransfer] = useState(() => initialTransfer(total, transferLimit))
  const [editing, setEditing] = useState(null) // 'transfer' | 'cash' | null
  const [draft, setDraft] = useState('')

  const cash = total - transfer
  const limited = max < total
  // La barra siempre representa el total entero, con o sin techo: así el
  // tramo verde es de verdad el efectivo que falta cobrar. El techo solo frena
  // el tirador (clampTransfer), no achica la barra.
  const percent = total > 0 ? (transfer / total) * 100 : 0

  const startEdit = (side) => {
    setEditing(side)
    setDraft(String(Math.round(side === 'transfer' ? transfer : cash)))
  }

  // El monto escrito, traducido a "cuánto se transfiere". Si lo escrito no es
  // un número se queda como estaba.
  const transferFromDraft = () => {
    const typed = Number(draft)
    if (draft.trim() === '' || !Number.isFinite(typed)) return transfer
    return clampTransfer(editing === 'transfer' ? typed : total - typed, total, transferLimit)
  }

  const commitEdit = () => {
    if (editing === null) return
    setTransfer(transferFromDraft())
    setEditing(null)
  }

  // Si la cajera escribió un monto y toca "Cobrar" sin confirmarlo antes, se
  // cobra lo que escribió, no lo que había antes de empezar a escribir.
  const confirm = () => {
    const finalTransfer = editing === null ? transfer : transferFromDraft()
    if (editing !== null) { setTransfer(finalTransfer); setEditing(null) }
    onConfirm(mixedPayload(total, finalTransfer))
  }

  // El botón dice exactamente lo que se va a cobrar: es lo último que mira la
  // cajera antes de confirmar, y un "Cobrar" a secas no le dice si el reparto
  // quedó como el cliente pidió.
  const payload = mixedPayload(total, transfer)
  const confirmLabel =
    payload.payment_method === 'efectivo' ? 'Cobrar todo en efectivo'
    : payload.payment_method === 'transferencia' ? 'Cobrar todo por transferencia'
    : `Cobrar ${fmt(transfer)} + ${fmt(cash)}`

  // Función y no componente a propósito: declarada como <Amount/> dentro del
  // render, React la remontaría en cada tecla y el campo perdería el foco.
  const amount = ({ side, value, label, icon: Icon, color, align }) => (
    <div className={`flex-1 min-w-0 ${align === 'right' ? 'text-right' : ''}`}>
      <p className={`flex items-center gap-1 text-xs font-semibold ${color} ${align === 'right' ? 'justify-end' : ''}`}>
        <Icon size={13} /> {label}
      </p>
      {editing === side ? (
        <input
          type="number"
          inputMode="numeric"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => { if (e.key === 'Enter') commitEdit() }}
          className={`w-full mt-1 px-2 py-1 text-lg font-bold rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-[#007AFF]/30 ${align === 'right' ? 'text-right' : ''}`}
        />
      ) : (
        <button
          type="button"
          onClick={() => startEdit(side)}
          className="mt-1 text-lg font-bold text-gray-900 underline decoration-dotted decoration-gray-300 underline-offset-4"
          title="Toca para escribir el monto exacto"
        >
          {fmt(value)}
        </button>
      )}
    </div>
  )

  return (
    <div>
      <div className="flex gap-4 mb-3">
        {amount({ side: 'transfer', value: transfer, label: 'Transferencia', icon: Smartphone, color: 'text-[#007AFF]' })}
        {amount({ side: 'cash', value: cash, label: 'Efectivo', icon: Banknote, color: 'text-green-600', align: 'right' })}
      </div>

      <input
        type="range"
        min={0}
        max={total}
        step={1}
        value={transfer}
        onChange={(e) => { setEditing(null); setTransfer(clampTransfer(e.target.value, total, transferLimit)) }}
        aria-label="Reparto entre transferencia y efectivo"
        className="split-slider w-full"
        style={{ background: `linear-gradient(to right, #007AFF ${percent}%, #22c55e ${percent}%)` }}
      />

      <p className="text-xs text-gray-400 text-center mt-2">
        {limited
          ? `Máximo por transferencia: ${fmt(transferLimit)}`
          : 'Toca un monto para escribir la cifra exacta'}
      </p>

      <button
        onClick={confirm}
        disabled={disabled}
        className="w-full mt-4 bg-gray-900 text-white py-4 rounded-2xl font-bold text-lg active:scale-95 transition-all disabled:opacity-50"
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
