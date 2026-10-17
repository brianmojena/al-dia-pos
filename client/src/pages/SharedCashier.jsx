import { useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { LockKeyhole, Delete, Users } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { getSharedMembers, isSharedExpired } from '../lib/sharedDevice.js'

export default function SharedCashier() {
  const { sharedDevice, sharedLocked, user, unlockCashier } = useAuth()
  const navigate = useNavigate()
  const [selected, setSelected] = useState(null)
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  if (!sharedDevice) return <Navigate to="/login" replace />
  if (user && !sharedLocked && !user.is_admin) return <Navigate to="/pos" replace />
  const enter = async (value) => {
    if (busy || value.length !== 6) return
    setBusy(true); setError('')
    try { await unlockCashier(selected.id, value); navigate('/pos', { replace: true }) }
    catch (e) { setError(e.message); setPin('') }
    finally { setBusy(false) }
  }
  const changePin = (value) => { setPin(value); if (value.length === 6) void enter(value) }
  return (
    <main className="min-h-screen bg-[#F5F5F7] flex items-center justify-center p-5">
      <div className="w-full max-w-sm">
        <div className="text-center mb-6">
          <div className="w-14 h-14 bg-blue-100 text-[#007AFF] rounded-2xl mx-auto mb-3 flex items-center justify-center"><Users size={26} /></div>
          <h1 className="text-2xl font-bold text-gray-900">{sharedDevice.name}</h1>
          <p className="text-sm text-gray-500 mt-1">{sharedDevice.continuous ? 'Caja continua · relevo sin cerrar' : 'Caja por turno · cierre antes del relevo'}</p>
        </div>
        <section className="bg-white rounded-3xl p-6 shadow-sm">
          {isSharedExpired() && <p role="alert" className="text-sm text-amber-800 bg-amber-50 rounded-xl p-3 mb-4">Los accesos necesitan revisión del administrador. Las operaciones pendientes siguen guardadas.</p>}
          {!selected ? <>
            <h2 className="font-semibold text-gray-900 mb-4">¿Quién va a atender?</h2>
            <div className="space-y-2">{getSharedMembers().map((member) => <button key={member.id} onClick={() => { setSelected(member); setError(''); setPin('') }} className="w-full text-left p-4 rounded-2xl bg-gray-50 hover:bg-blue-50 border border-gray-100 font-semibold text-gray-800 flex items-center justify-between"><span>{member.display_name || member.email}</span><LockKeyhole size={17} className="text-gray-400" /></button>)}</div>
          </> : <>
            <button disabled={busy} onClick={() => { setSelected(null); setPin(''); setError('') }} className="text-sm text-gray-500 mb-4">← Cambiar selección</button>
            <h2 className="font-semibold text-gray-900 text-center">{selected.display_name || selected.email}</h2>
            <form onSubmit={(e) => { e.preventDefault(); void enter(pin) }}>
              <label htmlFor="cashier-pin" className="block text-sm text-gray-500 text-center mt-1">Introduce tu PIN de 6 dígitos</label>
              <input id="cashier-pin" type="password" inputMode="numeric" autoComplete="off" maxLength={6} disabled={busy} value={pin} onChange={(e) => changePin(e.target.value.replace(/\D/g, '').slice(0, 6))} className="w-full text-center tracking-[0.65em] text-3xl border border-gray-200 rounded-xl py-3 mt-4 mb-4 focus:outline-none focus:ring-2 focus:ring-[#007AFF]" />
              <div className="grid grid-cols-3 gap-2">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => <button key={n} type="button" disabled={busy} onClick={() => changePin((pin + n).slice(0, 6))} className="rounded-xl bg-gray-50 hover:bg-blue-50 py-3 text-xl font-semibold disabled:opacity-50">{n}</button>)}
                <button type="button" disabled={busy} onClick={() => setPin('')} className="rounded-xl bg-gray-50 text-xs font-semibold">Borrar</button>
                <button type="button" disabled={busy} onClick={() => changePin((pin + '0').slice(0, 6))} className="rounded-xl bg-gray-50 py-3 text-xl font-semibold">0</button>
                <button type="button" aria-label="Borrar último dígito" disabled={busy} onClick={() => setPin((p) => p.slice(0, -1))} className="rounded-xl bg-gray-50 flex items-center justify-center"><Delete size={20} /></button>
              </div>
              <button disabled={busy || pin.length !== 6} className="w-full mt-4 py-3 bg-[#007AFF] text-white rounded-xl font-semibold disabled:opacity-40">{busy ? 'Entrando…' : 'Entrar'}</button>
            </form>
          </>}
          {error && <p role="alert" className="mt-4 text-sm text-red-700 bg-red-50 rounded-xl p-3">{error}</p>}
        </section>
        <Link to="/login?admin=1" className="block text-center text-sm text-gray-500 underline mt-5">Administración del dispositivo</Link>
      </div>
    </main>
  )
}
