import { useState } from 'react'
import { X } from 'lucide-react'
import { setDeviceRate } from '../lib/exchangeRates'

/**
 * Tasas con que cobra este aparato. El cajero las cambia aquí y quedan
 * guardadas en el teléfono o la caja, con o sin internet, hasta que alguien
 * las vuelva a cambiar. "Usar la de la tienda" borra la del aparato y vuelve
 * a seguir la que puso el dueño.
 */
export default function DeviceRatesEditor({ rates, fmt, onClose }) {
  const [drafts, setDrafts] = useState({
    USD: rates.USD.rate == null ? '' : String(rates.USD.rate),
    EUR: rates.EUR.rate == null ? '' : String(rates.EUR.rate),
  })
  const [error, setError] = useState('')

  const save = () => {
    for (const currency of ['USD', 'EUR']) {
      const text = drafts[currency].trim()
      const n = Number(text)
      if (text !== '' && (!Number.isFinite(n) || n <= 0)) {
        setError(`La tasa del ${currency === 'USD' ? 'dólar' : 'euro'} tiene que ser un número mayor que 0`)
        return
      }
    }
    for (const currency of ['USD', 'EUR']) {
      const text = drafts[currency].trim()
      const shop = rates[currency].shopRate
      const n = Number(text)
      // Vacío, o igual a la de la tienda: el aparato sigue a la tienda.
      setDeviceRate(currency, text === '' || (shop != null && Math.abs(n - shop) < 0.005) ? null : n)
    }
    onClose()
  }

  const useShop = (currency) => {
    setDrafts((d) => ({ ...d, [currency]: rates[currency].shopRate == null ? '' : String(rates[currency].shopRate) }))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-3xl p-6 shadow-2xl w-80 mx-4">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-lg font-bold text-gray-900">Tasa de cambio</h3>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg"><X size={18} className="text-gray-400" /></button>
        </div>
        <p className="text-xs text-gray-400 mb-5">
          Se guarda en este aparato, aunque no haya internet. El dueño ve a qué tasa cobraste cada venta.
        </p>

        {['USD', 'EUR'].map((currency) => {
          const shop = rates[currency].shopRate
          return (
            <div key={currency} className="mb-4">
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">
                1 {currency} en pesos
              </label>
              <input
                type="number" inputMode="decimal" min="0" step="any"
                value={drafts[currency]}
                onChange={(e) => setDrafts((d) => ({ ...d, [currency]: e.target.value }))}
                placeholder="Sin tasa"
                className="w-full border border-gray-200 rounded-xl px-4 py-3 text-lg font-bold focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400"
              />
              <div className="flex items-center justify-between mt-1.5 text-[11px]">
                <span className="text-gray-400">
                  {shop == null ? 'La tienda no tiene tasa puesta' : `Tienda: ${fmt(shop)}`}
                </span>
                {shop != null && Number(drafts[currency]) !== shop && (
                  <button onClick={() => useShop(currency)} className="font-semibold text-amber-700">
                    Usar la de la tienda
                  </button>
                )}
              </div>
            </div>
          )
        })}

        {error && <p className="text-xs text-red-600 mb-3">{error}</p>}

        <button
          onClick={save}
          className="w-full bg-amber-500 text-white py-3.5 rounded-2xl font-bold active:scale-95 transition-all shadow-md shadow-amber-200"
        >
          Guardar en este aparato
        </button>
      </div>
    </div>
  )
}
