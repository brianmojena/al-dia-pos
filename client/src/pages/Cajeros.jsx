import { useState, useEffect } from 'react'
import { Users, Plus, Trash2, X, ShieldCheck, AlertTriangle } from 'lucide-react'
import { apiFetch } from '../lib/api'
import { formatDateTime } from '../lib/dates'

const EMPTY = { email: '', password: '' }

export default function Cajeros() {
  const [cajeros,  setCajeros]  = useState([])
  const [loading,  setLoading]  = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form,     setForm]     = useState(EMPTY)
  const [saving,   setSaving]   = useState(false)
  const [error,    setError]    = useState('')

  const load = () =>
    apiFetch('/api/auth/cashiers').then(r => r.json()).then(d => {
      setCajeros(Array.isArray(d) ? d : [])
      setLoading(false)
    })

  useEffect(() => { load() }, [])

  const handleSubmit = async (e) => {
    e.preventDefault()
    setSaving(true)
    setError('')
    const res = await apiFetch('/api/auth/cashiers', {
      method: 'POST',
      body: JSON.stringify({ email: form.email.trim(), password: form.password }),
    })
    const data = await res.json()
    if (!res.ok) {
      setError(data.error || 'No se pudo crear el cajero.')
    } else {
      setForm(EMPTY)
      setShowForm(false)
      await load()
    }
    setSaving(false)
  }

  const handleDelete = async (id, email) => {
    if (!confirm(`¿Quitar el acceso de "${email}"? No podrá volver a entrar.`)) return
    await apiFetch(`/api/auth/cashiers/${id}`, { method: 'DELETE' })
    await load()
  }

  const field = 'w-full border border-gray-200 rounded-xl px-4 py-3 text-base focus:outline-none focus:border-[#007AFF] focus:ring-1 focus:ring-[#007AFF] transition-colors'

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <div className="w-8 h-8 border-2 border-[#007AFF] border-t-transparent rounded-full animate-spin" />
    </div>
  )

  return (
    <div className="p-5 md:p-8 max-w-2xl mx-auto pb-24 md:pb-8">
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-2xl font-bold text-gray-900">Cajeros</h2>
        <button
          onClick={() => { setShowForm(true); setError('') }}
          className="flex items-center gap-2 bg-[#007AFF] text-white px-5 py-2.5 rounded-xl font-semibold text-sm hover:bg-blue-600 active:scale-95 transition-all"
        >
          <Plus size={18} />
          Nuevo
        </button>
      </div>

      <div className="flex items-start gap-2.5 bg-blue-50 text-[#007AFF] rounded-xl px-4 py-3 mb-5">
        <ShieldCheck size={16} className="flex-shrink-0 mt-0.5" />
        <p className="text-xs leading-relaxed font-medium">
          Un cajero puede cobrar y cerrar la caja. <strong>No</strong> ve las ventas del día,
          el historial ni los precios de compra — por eso el conteo del cierre es a ciegas.
        </p>
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl">
            <div className="flex justify-between items-center px-6 py-5 border-b border-gray-100">
              <h3 className="text-lg font-semibold text-gray-900">Nuevo cajero</h3>
              <button
                onClick={() => setShowForm(false)}
                className="p-2 hover:bg-gray-100 rounded-xl transition-colors"
              >
                <X size={20} className="text-gray-500" />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">
                  Correo o usuario
                </label>
                <input
                  required type="email" autoComplete="off"
                  placeholder="cajero@mitienda.cu"
                  value={form.email}
                  onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                  className={field}
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">
                  Contraseña
                </label>
                <input
                  required type="text" minLength={6} autoComplete="off"
                  placeholder="Mínimo 6 caracteres"
                  value={form.password}
                  onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                  className={field}
                />
                <p className="text-[11px] text-gray-400 mt-1.5">
                  Se muestra en claro para que puedas dársela al cajero. Anótala — no se puede
                  volver a ver.
                </p>
              </div>

              {error && (
                <div className="flex items-start gap-2 bg-red-50 text-red-600 rounded-xl px-4 py-3 text-sm font-medium">
                  <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={saving}
                className="w-full bg-[#007AFF] text-white py-3.5 rounded-xl font-semibold text-base hover:bg-blue-600 active:scale-95 transition-all disabled:opacity-50 mt-2"
              >
                {saving ? 'Creando...' : 'Crear cajero'}
              </button>
            </form>
          </div>
        </div>
      )}

      <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
        {cajeros.length === 0 ? (
          <div className="py-16 text-center text-gray-400">
            <Users size={40} className="mx-auto mb-3 opacity-30" />
            <p className="text-sm">Todavía no hay cajeros</p>
            <p className="text-xs mt-1 opacity-70">Tú cobras con tu propia cuenta</p>
          </div>
        ) : (
          cajeros.map((c, idx) => (
            <div
              key={c.id}
              className={`flex items-center justify-between px-5 py-4 ${
                idx < cajeros.length - 1 ? 'border-b border-gray-50' : ''
              }`}
            >
              <div className="min-w-0">
                <p className="font-medium text-gray-900 text-sm truncate">{c.email}</p>
                <p className="text-xs text-gray-400 mt-0.5">Desde {formatDateTime(c.created_at)}</p>
              </div>
              <button
                onClick={() => handleDelete(c.id, c.email)}
                className="p-2 hover:bg-red-50 rounded-xl text-gray-300 hover:text-red-500 transition-colors flex-shrink-0"
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
