import { Navigate, useNavigate } from 'react-router-dom'
import { ArrowRight, CalendarClock, CheckCircle2 } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { planLabel } from '../lib/plans'

/**
 * Cartel de bienvenida tras registrarse: la tienda nace pendiente de
 * confirmación (el pago es en persona) con 7 días de prueba completa.
 * Si ya la confirmaron — o alguien entra directo a la URL — no aplica.
 */
export default function Bienvenida() {
  const { user } = useAuth()
  const navigate = useNavigate()

  if (!user || user.plan_status !== 'pending') return <Navigate to="/" replace />

  const dias = user.trial_days_left ?? 0

  return (
    <div className="min-h-screen bg-[#F5F5F7] flex items-center justify-center p-5">
      <div className="w-full max-w-md bg-white rounded-3xl p-7 shadow-sm text-center">
        <div className="w-14 h-14 bg-green-100 text-green-600 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <CheckCircle2 size={28} />
        </div>
        <h1 className="text-xl font-bold text-gray-900">¡Cuenta creada!</h1>
        <p className="text-sm text-gray-500 mt-1">
          {user.store_name} · Plan {planLabel(user.plan)}
        </p>

        <div className="mt-5 bg-amber-50 text-amber-800 rounded-2xl px-4 py-3.5 text-left flex gap-3">
          <CalendarClock size={20} className="flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold">
              Prueba gratuita: {dias} {dias === 1 ? 'día' : 'días'}
            </p>
            <p className="text-xs mt-1">
              Tu plan está <strong>pendiente de confirmación</strong>: el pago es en persona.
              Mientras tanto tienes todas las funciones de la app.
            </p>
          </div>
        </div>

        <p className="text-xs text-gray-400 mt-4">
          Cuando administración confirme tu pago, tu cuenta quedará activa definitivamente.
        </p>

        <button
          onClick={() => navigate('/pos')}
          className="mt-6 w-full bg-[#007AFF] text-white py-3.5 rounded-2xl font-bold text-base hover:bg-blue-600 active:scale-95 transition-all flex items-center justify-center gap-2"
        >
          Empezar a usar la app
          <ArrowRight size={18} />
        </button>
      </div>
    </div>
  )
}
