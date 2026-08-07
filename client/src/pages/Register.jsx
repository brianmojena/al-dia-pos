import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Mail, Lock, Store, AlertCircle, Check, Sparkles, FlaskConical } from 'lucide-react'
import { useAuth } from '../context/AuthContext'

const PLANS = [
  {
    id: 'premium',
    icon: Sparkles,
    title: 'Plan Premium',
    price: '$5 USD',
    priceNote: '/mes',
    tag: 'Simulado — sin cobro real',
    features: ['Acceso completo a la app', 'Soporte prioritario', 'Ideal para tu negocio en marcha'],
  },
  {
    id: 'dev',
    icon: FlaskConical,
    title: 'Plan Dev',
    price: 'Gratis',
    priceNote: 'modo prueba',
    tag: 'Para probar el prototipo',
    features: ['Acceso completo mientras se desarrolla', 'Sin costo', 'Pensado para testers'],
  },
]

export default function Register() {
  const { register } = useAuth()
  const navigate = useNavigate()
  const [storeName,  setStoreName]  = useState('')
  const [email,      setEmail]      = useState('')
  const [password,   setPassword]   = useState('')
  const [confirm,    setConfirm]    = useState('')
  const [plan,       setPlan]       = useState('premium')
  const [error,      setError]      = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    if (password !== confirm) {
      setError('Las contraseñas no coinciden')
      return
    }
    if (password.length < 6) {
      setError('La contraseña debe tener al menos 6 caracteres')
      return
    }
    setSubmitting(true)
    try {
      await register({ email, password, store_name: storeName, plan })
      navigate('/pos')
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#F5F5F7] flex items-center justify-center p-5 py-10">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 bg-[#007AFF] rounded-2xl flex items-center justify-center text-white font-bold text-2xl mb-3">M</div>
          <h1 className="text-2xl font-bold text-gray-900">Crea tu cuenta</h1>
          <p className="text-sm text-gray-500 mt-1">Empieza a gestionar tu negocio</p>
        </div>

        <form onSubmit={handleSubmit} className="bg-white rounded-3xl p-6 shadow-sm space-y-4">
          {error && (
            <div className="flex items-center gap-2 bg-red-50 text-red-600 text-sm px-4 py-3 rounded-xl">
              <AlertCircle size={16} className="flex-shrink-0" />
              {error}
            </div>
          )}

          <div className="relative">
            <Store size={17} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              required
              value={storeName}
              onChange={e => setStoreName(e.target.value)}
              placeholder="Nombre de tu tienda"
              className="w-full bg-gray-50 border border-gray-200 rounded-2xl pl-11 pr-4 py-3.5 text-base focus:outline-none focus:border-[#007AFF] focus:ring-1 focus:ring-[#007AFF] transition-colors"
            />
          </div>

          <div className="relative">
            <Mail size={17} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="email"
              required
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="Correo electrónico"
              className="w-full bg-gray-50 border border-gray-200 rounded-2xl pl-11 pr-4 py-3.5 text-base focus:outline-none focus:border-[#007AFF] focus:ring-1 focus:ring-[#007AFF] transition-colors"
            />
          </div>

          <div className="relative">
            <Lock size={17} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="password"
              required
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Contraseña (mínimo 6 caracteres)"
              className="w-full bg-gray-50 border border-gray-200 rounded-2xl pl-11 pr-4 py-3.5 text-base focus:outline-none focus:border-[#007AFF] focus:ring-1 focus:ring-[#007AFF] transition-colors"
            />
          </div>

          <div className="relative">
            <Lock size={17} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="password"
              required
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              placeholder="Confirmar contraseña"
              className="w-full bg-gray-50 border border-gray-200 rounded-2xl pl-11 pr-4 py-3.5 text-base focus:outline-none focus:border-[#007AFF] focus:ring-1 focus:ring-[#007AFF] transition-colors"
            />
          </div>

          {/* Plan selector */}
          <div>
            <p className="text-sm font-semibold text-gray-700 mb-2">Elige un plan</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {PLANS.map(p => {
                const Icon = p.icon
                const selected = plan === p.id
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setPlan(p.id)}
                    className={`relative text-left rounded-2xl p-4 border-2 transition-all ${
                      selected ? 'border-[#007AFF] bg-blue-50/40' : 'border-gray-200 bg-white hover:border-gray-300'
                    }`}
                  >
                    {selected && (
                      <div className="absolute top-3 right-3 w-5 h-5 bg-[#007AFF] rounded-full flex items-center justify-center">
                        <Check size={12} className="text-white" strokeWidth={3} />
                      </div>
                    )}
                    <Icon size={20} className={selected ? 'text-[#007AFF]' : 'text-gray-400'} />
                    <p className="font-bold text-gray-900 mt-2">{p.title}</p>
                    <p className="text-lg font-bold text-gray-900 mt-0.5">
                      {p.price} <span className="text-xs font-medium text-gray-400">{p.priceNote}</span>
                    </p>
                    <p className="text-[11px] text-gray-400 mt-1">{p.tag}</p>
                    <ul className="mt-2.5 space-y-1">
                      {p.features.map(f => (
                        <li key={f} className="text-xs text-gray-500 flex items-start gap-1.5">
                          <Check size={11} className="mt-0.5 flex-shrink-0 text-green-500" />
                          {f}
                        </li>
                      ))}
                    </ul>
                  </button>
                )
              })}
            </div>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full bg-[#007AFF] text-white py-3.5 rounded-2xl font-bold text-base hover:bg-blue-600 active:scale-95 transition-all disabled:opacity-50 shadow-lg shadow-blue-200"
          >
            {submitting ? 'Creando cuenta...' : 'Crear cuenta'}
          </button>
        </form>

        <p className="text-center text-sm text-gray-500 mt-5">
          ¿Ya tienes cuenta?{' '}
          <Link to="/login" className="text-[#007AFF] font-semibold hover:underline">
            Inicia sesión
          </Link>
        </p>
      </div>
    </div>
  )
}
