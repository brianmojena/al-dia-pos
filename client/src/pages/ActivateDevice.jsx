import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AlertCircle, KeyRound, RefreshCw } from 'lucide-react'
import { apiFetch } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import { installSharedDevice } from '../lib/sharedDevice.js'
import { canReplaceSharedDevice } from '../lib/offlineClient.js'

// El servidor usa el alfabeto tipo Crockford: se limpia la entrada igual que
// allí (sin separadores, en mayúsculas) para que el código se pueda dictar con
// guiones o espacios de más sin fallar.
const cleanCode = (value) => value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 12)

/**
 * Activa una caja compartida en ESTE aparato canjeando un código de un solo uso
 * que el administrador generó a distancia. No requiere cuenta: el código es la
 * credencial. Los PIN ya vienen cifrados, así que aquí no se teclea ninguno.
 */
export default function ActivateDevice() {
  const navigate = useNavigate()
  const { completeSharedSetup } = useAuth()
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    if (busy) return
    setError('')
    if (code.length !== 12) { setError('El código de activación tiene 12 caracteres.'); return }
    setBusy(true)
    try {
      // Comprobar el aparato ANTES de canjear: el código es de un solo uso y no
      // debe gastarse si este aparato todavía tiene datos pendientes.
      const gate = await canReplaceSharedDevice()
      if (!gate?.allowed) throw new Error(gate?.error || 'No se puede activar la caja en este dispositivo.')
      const res = await apiFetch('/api/shared', { method: 'POST', body: JSON.stringify({ code }) })
      const bundle = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(bundle.error || 'No se pudo activar la caja.')
      try {
        await installSharedDevice(bundle)
      } catch (installError) {
        throw new Error(`El código ya se usó, pero este aparato no pudo guardar la caja: ${installError.message} Pide un código nuevo al administrador.`)
      }
      completeSharedSetup()
      navigate('/cajero', { replace: true })
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="min-h-screen bg-[#F5F5F7] flex items-center justify-center p-5">
      <div className="w-full max-w-sm">
        <div className="text-center mb-6">
          <div className="w-14 h-14 bg-blue-100 text-[#007AFF] rounded-2xl mx-auto mb-3 flex items-center justify-center"><KeyRound size={26} /></div>
          <h1 className="text-2xl font-bold text-gray-900">Activar esta caja</h1>
          <p className="text-sm text-gray-500 mt-1">Introduce el código que te dio el administrador.</p>
        </div>
        <form onSubmit={submit} className="bg-white rounded-3xl p-6 shadow-sm">
          {error && (
            <div className="flex items-center gap-2 bg-red-50 text-red-600 text-sm px-4 py-3 rounded-xl mb-4">
              <AlertCircle size={16} className="flex-shrink-0" />
              {error}
            </div>
          )}
          <label htmlFor="activation-code" className="block text-sm text-gray-500 mb-1.5">Código de activación</label>
          <input
            id="activation-code"
            value={code}
            onChange={(e) => setCode(cleanCode(e.target.value))}
            inputMode="text"
            autoComplete="off"
            autoCapitalize="characters"
            placeholder="XXXX-XXXX-XXXX"
            className="w-full text-center tracking-[0.4em] text-xl font-semibold border border-gray-200 rounded-xl py-3 focus:outline-none focus:ring-2 focus:ring-[#007AFF]"
          />
          <button
            type="submit"
            disabled={busy || code.length !== 12}
            className="w-full mt-4 flex items-center justify-center gap-1.5 bg-[#007AFF] text-white py-3 rounded-xl font-semibold disabled:opacity-40"
          >
            {busy && <RefreshCw size={16} className="animate-spin" />}
            {busy ? 'Activando…' : 'Activar la caja'}
          </button>
          <p className="text-xs text-gray-400 mt-3">
            El código es de un solo uso y vence a los 30 minutos. Si ya venció o se usó, pide uno nuevo.
          </p>
        </form>
        <Link to="/login" className="block text-center text-sm text-gray-500 underline mt-5">Volver a iniciar sesión</Link>
      </div>
    </main>
  )
}
