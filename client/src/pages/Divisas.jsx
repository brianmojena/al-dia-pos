import { useLocalRefresh } from '../lib/useLocalRefresh.js'
import { useState, useEffect, useRef } from 'react'
import { ArrowLeftRight, Check, AlertTriangle, Pencil, CloudOff } from 'lucide-react'
import { apiFetch } from '../lib/api'
import { newId } from '../lib/newId'
import { formatDateTime } from '../lib/dates'
import { accountLabel } from '../lib/accountLabel'
import { useAuth } from '../context/AuthContext'
import { useExchangeRates } from '../lib/exchangeRates'
import { purchaseCup, offShopPurchase, fmtForeign } from '../lib/payment'

const fmt = (n) => '$ ' + new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 }).format(n || 0)

/**
 * Compra de dólares o euros.
 *
 * La tienda le compra billetes a alguien y le paga en pesos de la gaveta: el
 * sistema resta esos pesos del efectivo y suma los billetes de esa moneda, y
 * el arqueo de la caja los espera así. La tasa arranca en la de este aparato
 * (o la de la tienda) y se puede cambiar en el momento; el cambio vale solo
 * para esta compra, porque lo normal es comprar a otra tasa que a la que se
 * cobra y no hay que mover la tasa de las ventas.
 *
 * Cualquier cuenta puede comprar. El historial es del dueño: un cajero solo
 * ve la confirmación de lo que acaba de registrar.
 */
export default function Divisas() {
  const { user } = useAuth()
  const isOwner = user?.role !== 'cajero'
  const rates = useExchangeRates(user)
  const [currency, setCurrency] = useState(() => (rates.USD.rate == null && rates.EUR.rate != null ? 'EUR' : 'USD'))
  const [amount, setAmount] = useState('')
  const [rateDraft, setRateDraft] = useState(null) // null = la tasa del aparato o la tienda
  const [editingRate, setEditingRate] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(null)
  const [recent, setRecent] = useState([])
  // Se mantiene entre reintentos para que el servidor reconozca el reintento y
  // no registre dos compras iguales.
  const purchaseIdRef = useRef(null)

  const current = rates[currency]
  const rate = rateDraft == null ? current.rate : Number(rateDraft)
  const validRate = Number.isFinite(rate) && rate > 0
  const typed = Number(amount)
  const validAmount = amount.trim() !== '' && Number.isFinite(typed) && typed > 0
  const cup = validAmount && validRate ? purchaseCup(typed, rate) : 0
  const differs = validRate && current.shopRate != null && Math.abs(rate - current.shopRate) > 0.005

  const load = async () => {
    if (!isOwner) return
    try {
      const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Havana' }).format(new Date())
      const res = await apiFetch(`/api/currency-purchases?date=${today}`)
      const data = await res.json()
      if (res.ok && Array.isArray(data)) setRecent(data)
    } catch { /* el historial es un extra: sin él la compra sigue funcionando */ }
  }
  useEffect(() => { load() }, [])
  useLocalRefresh(load)

  const switchCurrency = (next) => {
    if (next === currency) return
    setCurrency(next)
    setAmount('')
    setRateDraft(null)
    setEditingRate(false)
    purchaseIdRef.current = null
    setError('')
  }

  const startEditingRate = () => {
    setRateDraft(validRate ? String(rate) : '')
    setEditingRate(true)
  }

  const confirm = async () => {
    if (submitting || !validAmount || !validRate) return
    setSubmitting(true)
    setError('')
    if (!purchaseIdRef.current) purchaseIdRef.current = newId()
    try {
      const res = await apiFetch('/api/currency-purchases', {
        method: 'POST',
        body: JSON.stringify({
          client_purchase_id: purchaseIdRef.current,
          foreign_currency: currency,
          foreign_amount: Math.round(typed * 100) / 100,
          exchange_rate: rate,
          shop_rate: current.shopRate,
          register_id: 'web',
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error || 'No se pudo registrar la compra. Intenta de nuevo.')
        return
      }
      purchaseIdRef.current = null
      setDone({ currency, amount: Math.round(typed * 100) / 100, rate, cup, pending: !!data.pending })
      setAmount('')
      setRateDraft(null)
      setEditingRate(false)
      await load()
    } catch (err) {
      setError(err.message || 'No se pudo guardar la compra. Vuelve a intentar.')
    } finally {
      setSubmitting(false)
    }
  }

  const noRate = current.rate == null && rateDraft == null

  return (
    <div className="max-w-xl mx-auto p-4 md:p-6">
      <div className="flex items-center gap-3 mb-5">
        <div className="w-10 h-10 rounded-2xl bg-amber-100 text-amber-700 flex items-center justify-center">
          <ArrowLeftRight size={20} />
        </div>
        <div>
          <h2 className="text-xl font-bold text-gray-900">Comprar divisas</h2>
          <p className="text-xs text-gray-500">Pagas en pesos de la caja y se suman los billetes</p>
        </div>
      </div>

      {done && (
        <div className="bg-green-50 rounded-2xl px-4 py-3 mb-4 flex items-start gap-3">
          <Check size={20} className="text-green-600 mt-0.5 flex-shrink-0" />
          <div className="text-sm text-green-800">
            <p className="font-bold">
              Compraste {fmtForeign(done.amount)} {done.currency} a {fmt(done.rate)}
            </p>
            <p>Saliron {fmt(done.cup)} de la caja y entraron {fmtForeign(done.amount)} {done.currency}.</p>
            {done.pending && (
              <p className="flex items-center gap-1 text-xs text-green-700 mt-1">
                <CloudOff size={12} /> Guardada; se sube cuando haya conexión.
              </p>
            )}
          </div>
        </div>
      )}

      <div className="bg-white rounded-2xl shadow-sm p-4">
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
          {editingRate || noRate ? (
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-amber-800 flex-shrink-0">1 {currency} =</span>
              <input
                type="number" inputMode="decimal" min="0" step="any" autoFocus
                value={rateDraft ?? ''}
                onChange={(e) => setRateDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && validRate) setEditingRate(false) }}
                placeholder="A cuánto lo compras"
                className="flex-1 min-w-0 px-2 py-1 text-base font-bold rounded-lg border border-amber-200 focus:outline-none focus:ring-2 focus:ring-amber-300"
              />
              <span className="text-sm text-amber-800 flex-shrink-0">CUP</span>
              {validRate && (
                <button type="button" onClick={() => setEditingRate(false)} className="text-xs font-bold text-amber-800 px-2 py-1 rounded-lg bg-amber-100">
                  OK
                </button>
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={startEditingRate}
              className="w-full flex items-center justify-between text-sm"
              title="Toca para cambiar la tasa de esta compra"
            >
              <span className="font-semibold text-amber-800">1 {currency} = {fmt(rate)}</span>
              <span className="flex items-center gap-1 text-xs text-amber-700">
                {rateDraft != null ? 'tasa de esta compra' : current.source === 'device' ? 'tasa de este aparato' : 'tasa de la tienda'} <Pencil size={12} />
              </span>
            </button>
          )}
          {differs && (
            <p className="text-[11px] text-orange-700 mt-1.5">
              La tienda tiene {fmt(current.shopRate)}. El dueño verá que compraste a otra tasa.
            </p>
          )}
          {current.shopRate == null && (
            <p className="text-[11px] text-amber-700 mt-1.5">La tienda no tiene tasa puesta: escribe a cuánto compras.</p>
          )}
        </div>

        <label className="text-xs font-semibold text-gray-500 block mb-1">¿Cuántos {currency} compras?</label>
        <input
          type="number" inputMode="decimal" min="0" step="any"
          autoFocus={!editingRate && !noRate}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') confirm() }}
          placeholder="0"
          className="w-full px-4 py-3 text-2xl font-bold rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-amber-300"
        />

        <div className="mt-3 min-h-[44px]">
          {validAmount && validRate && (
            <div className="flex justify-between items-center bg-blue-50 rounded-xl px-4 py-2.5">
              <span className="text-sm font-semibold text-blue-800">Pagas, en pesos</span>
              <span className="text-xl font-bold text-[#007AFF]">{fmt(cup)}</span>
            </div>
          )}
        </div>

        {error && (
          <div className="flex items-start gap-2 text-sm text-red-600 bg-red-50 rounded-xl px-3 py-2 mt-3">
            <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" /> {error}
          </div>
        )}

        <button
          onClick={confirm}
          disabled={submitting || !validAmount || !validRate}
          className="w-full mt-3 bg-gray-900 text-white py-4 rounded-2xl font-bold text-base active:scale-95 transition-all disabled:opacity-40"
        >
          {submitting ? 'Guardando…'
            : !validRate ? 'Escribe la tasa'
            : !validAmount ? `Escribe cuántos ${currency} compras`
            : `Comprar ${fmtForeign(typed)} ${currency} por ${fmt(cup)}`}
        </button>
      </div>

      {isOwner && (
        <div className="mt-6">
          <h3 className="text-sm font-bold text-gray-700 mb-2">Compras de hoy</h3>
          {recent.length === 0 ? (
            <p className="text-sm text-gray-400 bg-white rounded-2xl px-4 py-5 text-center">Todavía no hay compras hoy.</p>
          ) : (
            <div className="bg-white rounded-2xl shadow-sm divide-y divide-gray-50">
              {recent.map((p) => (
                <div key={p.id} className="px-4 py-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900">
                      {fmtForeign(p.foreign_amount)} {p.foreign_currency} a {fmt(p.exchange_rate)}
                    </p>
                    <p className="text-xs text-gray-400 truncate">
                      {formatDateTime(p.created_at)} · {accountLabel(p.account_email)}
                    </p>
                    {offShopPurchase(p) && (
                      <p className="text-[11px] text-orange-600 flex items-center gap-1">
                        <AlertTriangle size={11} /> La tienda tenía {fmt(p.shop_rate)}
                      </p>
                    )}
                  </div>
                  <span className="text-sm font-bold text-red-600 flex-shrink-0">− {fmt(p.cup_amount)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
