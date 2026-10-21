import { useState } from 'react'
import { Lock, RefreshCw, LogOut } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { planOf } from '../lib/plans'
import PlanCards from './PlanCards'

/**
 * Pantalla de espera cuando la prueba gratuita venció sin que el
 * administrador confirmara la tienda. "Verificar de nuevo" refresca el
 * usuario contra el servidor: si ya la confirmaron, la app se desbloquea sola.
 */
export default function LockedScreen() {
  const { user, refreshUser, logout } = useAuth()
  const [checking, setChecking] = useState(false)
  const [sinConfirmar, setSinConfirmar] = useState(false)

  const check = async () => {
    setChecking(true)
    setSinConfirmar(false)
    try {
      await refreshUser()
      // Si administración ya confirmó, refreshUser actualiza el usuario y esta
      // pantalla desaparece; si seguimos aquí, es que todavía no.
      setSinConfirmar(true)
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#F5F5F7] flex items-center justify-center p-5">
      <div className="w-full max-w-md bg-white rounded-3xl p-7 shadow-sm text-center">
        <div className="w-14 h-14 bg-amber-100 text-amber-700 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <Lock size={26} />
        </div>
        <h1 className="text-xl font-bold text-gray-900">Tu prueba gratuita terminó</h1>
        <p className="text-sm text-gray-500 mt-2">
          La cuenta de <strong>{user?.store_name}</strong> está esperando la
          confirmación de administración. Elige tu plan: el pago es en persona y, en cuanto
          se confirme, podrás seguir usando la app.
        </p>

        <div className="mt-5">
          <PlanCards current={planOf(user?.plan)} />
        </div>

        {sinConfirmar && (
          <p className="text-sm text-amber-700 bg-amber-50 rounded-xl px-3 py-2 mt-4">
            Todavía no aparece confirmada. Vuelve a intentarlo en un rato.
          </p>
        )}

        <div className="flex flex-col gap-2 mt-6">
          <button
            onClick={check}
            disabled={checking}
            className="w-full py-3 rounded-2xl bg-[#007AFF] text-white font-semibold flex items-center justify-center gap-2 disabled:opacity-60"
          >
            <RefreshCw size={16} className={checking ? 'animate-spin' : ''} />
            {checking ? 'Verificando…' : 'Verificar de nuevo'}
          </button>
          <button
            onClick={logout}
            className="w-full py-3 rounded-2xl bg-gray-100 text-gray-700 font-semibold flex items-center justify-center gap-2"
          >
            <LogOut size={16} />
            Cerrar sesión
          </button>
        </div>
      </div>
    </div>
  )
}
