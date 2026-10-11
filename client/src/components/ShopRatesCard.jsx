import { useEffect, useState } from 'react'
import { DollarSign, Check } from 'lucide-react'
import { apiFetch } from '../lib/api'
import { useAuth } from '../context/AuthContext'

/**
 * Tasa de la tienda, la que pone el dueño. Es con la que arrancan todos los
 * teléfonos y cajas; cada cajero la puede cambiar en su aparato, y entonces
 * sus ventas salen marcadas para que el dueño lo vea.
 *
 * Cambiarla necesita internet: es un dato de toda la tienda, no de este
 * aparato. Los aparatos se enteran en su próxima sincronización.
 */
export default function ShopRatesCard({ fmt }) {
  const { user, updateUser } = useAuth()
  const initial = () => ({
    usd_rate: user?.usd_rate == null ? '' : String(user.usd_rate),
    eur_rate: user?.eur_rate == null ? '' : String(user.eur_rate),
  })
  const [drafts, setDrafts] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => { setDrafts(initial()) }, [user?.usd_rate, user?.eur_rate]) // eslint-disable-line react-hooks/exhaustive-deps

  const changed = drafts.usd_rate !== initial().usd_rate || drafts.eur_rate !== initial().eur_rate

  const save = async (e) => {
    e.preventDefault()
    const body = {}
    for (const key of ['usd_rate', 'eur_rate']) {
      const text = drafts[key].trim()
      const n = Number(text)
      if (text !== '' && (!Number.isFinite(n) || n <= 0)) {
        setError('Las tasas tienen que ser números mayores que 0')
        return
      }
      body[key] = text === '' ? null : n
    }
    setSaving(true)
    setError('')
    try {
      const res = await apiFetch('/api/auth/settings', { method: 'PUT', body: JSON.stringify(body) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'No se pudo guardar la tasa')
      updateUser({ ...user, usd_rate: data.user.usd_rate, eur_rate: data.user.eur_rate })
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch (error) {
      setError(navigator.onLine === false || error.name === 'TypeError' || error.name === 'AbortError'
        ? 'Para cambiar la tasa de la tienda hace falta internet.'
        : error.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={save} className="bg-white rounded-2xl px-5 py-4 shadow-sm mt-5">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-10 h-10 bg-amber-50 rounded-xl flex items-center justify-center flex-shrink-0">
          <DollarSign size={19} className="text-amber-600" />
        </div>
        <div className="min-w-0">
          <p className="font-semibold text-gray-900 text-sm">Tasa de cambio de la tienda</p>
          <p className="text-xs text-gray-400 mt-0.5">
            Los cajeros la pueden cambiar en su aparato; esas ventas te salen marcadas.
          </p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {[['usd_rate', 'USD'], ['eur_rate', 'EUR']].map(([key, code]) => (
          <label key={key} className="block">
            <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">1 {code} en pesos</span>
            <input
              type="number" inputMode="decimal" min="0" step="any" placeholder="Sin tasa"
              value={drafts[key]}
              onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
              className="w-full mt-1 border border-gray-200 rounded-xl px-3 py-2.5 text-base font-bold focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400"
            />
            {user?.[key] != null && <span className="text-[11px] text-gray-400">Ahora: {fmt(user[key])}</span>}
          </label>
        ))}
      </div>
      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
      {(changed || saved) && (
        <button
          type="submit"
          disabled={saving || saved}
          className="w-full mt-3 bg-amber-500 text-white py-3 rounded-xl font-bold text-sm active:scale-95 transition-all disabled:opacity-60 flex items-center justify-center gap-1.5"
        >
          {saved ? <><Check size={16} /> Guardada</> : saving ? 'Guardando...' : 'Guardar tasa de la tienda'}
        </button>
      )}
    </form>
  )
}
