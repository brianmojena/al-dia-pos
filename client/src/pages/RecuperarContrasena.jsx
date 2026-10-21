import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Mail, Lock, AlertCircle, Eye, EyeOff, CheckCircle, MessageCircle } from 'lucide-react'
import { apiFetch } from '../lib/api'

const WHATSAPP_SOPORTE = '5359306972'

export default function RecuperarContrasena() {
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [success, setSuccess] = useState(false)

  const handleCodeChange = (e) => {
    const value = e.target.value
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
    setCode(value)
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')

    if (!email.trim()) {
      setError('Por favor ingresa tu correo')
      return
    }

    if (!code) {
      setError('Por favor ingresa el código')
      return
    }

    if (newPassword !== confirmPassword) {
      setError('Las contraseñas no coinciden')
      return
    }

    if (newPassword.length < 6) {
      setError('La contraseña debe tener al menos 6 caracteres')
      return
    }

    setSubmitting(true)
    try {
      const res = await apiFetch('/api/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({
          email: email.trim(),
          code: code.trim(),
          new_password: newPassword,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || 'No se pudo resetear la contraseña')
      }
      setSuccess(true)
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  if (success) {
    return (
      <div className="min-h-screen bg-[#F5F5F7] flex items-center justify-center p-5">
        <div className="w-full max-w-sm">
          <div className="flex flex-col items-center mb-8">
            <div className="w-14 h-14 bg-[#007AFF] rounded-2xl flex items-center justify-center text-white font-bold text-2xl mb-3">
              M
            </div>
            <h1 className="text-2xl font-bold text-gray-900">Mi Tienda</h1>
            <p className="text-sm text-gray-500 mt-1">Recuperar contraseña</p>
          </div>

          <div className="bg-white rounded-3xl p-6 shadow-sm">
            <div className="flex flex-col items-center text-center">
              <CheckCircle size={48} className="text-green-500 mb-4" />
              <h2 className="text-xl font-bold text-gray-900 mb-2">
                ¡Listo!
              </h2>
              <p className="text-sm text-gray-600 mb-6">
                Ya puedes entrar con tu nueva contraseña.
              </p>
              <Link
                to="/login"
                className="block w-full text-center bg-[#007AFF] text-white py-3.5 rounded-2xl font-bold text-base hover:bg-blue-600 active:scale-95 transition-all shadow-lg shadow-blue-200"
              >
                Ir a iniciar sesión
              </Link>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#F5F5F7] flex items-center justify-center p-5 py-10">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 bg-[#007AFF] rounded-2xl flex items-center justify-center text-white font-bold text-2xl mb-3">
            M
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Recuperar contraseña</h1>
          <p className="text-sm text-gray-500 mt-1">Sigue estos pasos</p>
        </div>

        {/* Pasos */}
        <div className="mb-5 bg-blue-50 rounded-2xl px-4 py-4 space-y-2 text-sm">
          <p className="text-gray-700">
            <span className="font-bold text-[#007AFF]">1.</span> Escríbenos por WhatsApp y cuéntanos que olvidaste tu contraseña.
          </p>
          <p className="text-gray-700">
            <span className="font-bold text-[#007AFF]">2.</span> Te daremos un código (válido 15 minutos).
          </p>
          <p className="text-gray-700">
            <span className="font-bold text-[#007AFF]">3.</span> Escríbelo aquí con tu nueva contraseña.
          </p>
        </div>

        {/* Botón WhatsApp */}
        {WHATSAPP_SOPORTE && (
          <a
            href={`https://wa.me/${WHATSAPP_SOPORTE}?text=${encodeURIComponent(
              'Hola, olvidé mi contraseña de la app'
            )}`}
            target="_blank"
            rel="noopener noreferrer"
            className="w-full flex items-center justify-center gap-2 bg-green-500 text-white py-3.5 rounded-2xl font-bold text-base hover:bg-green-600 active:scale-95 transition-all shadow-lg shadow-green-200 mb-5"
          >
            <MessageCircle size={18} />
            Escribir por WhatsApp
          </a>
        )}

        <form onSubmit={handleSubmit} className="bg-white rounded-3xl p-6 shadow-sm space-y-4">
          {error && (
            <div className="flex items-center gap-2 bg-red-50 text-red-600 text-sm px-4 py-3 rounded-xl">
              <AlertCircle size={16} className="flex-shrink-0" />
              {error}
            </div>
          )}

          <div className="relative">
            <Mail size={17} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Correo electrónico"
              autoComplete="email"
              inputMode="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="w-full bg-gray-50 border border-gray-200 rounded-2xl pl-11 pr-4 py-3.5 text-base focus:outline-none focus:border-[#007AFF] focus:ring-1 focus:ring-[#007AFF] transition-colors"
            />
          </div>

          <div className="relative">
            <input
              type="text"
              required
              value={code}
              onChange={handleCodeChange}
              placeholder="Código (8 caracteres)"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              maxLength={12}
              className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-4 py-3.5 text-base font-mono text-center tracking-widest focus:outline-none focus:border-[#007AFF] focus:ring-1 focus:ring-[#007AFF] transition-colors"
            />
          </div>

          <div className="relative">
            <Lock size={17} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type={showPassword ? 'text' : 'password'}
              required
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Nueva contraseña"
              autoComplete="new-password"
              className="w-full bg-gray-50 border border-gray-200 rounded-2xl pl-11 pr-12 py-3.5 text-base focus:outline-none focus:border-[#007AFF] focus:ring-1 focus:ring-[#007AFF] transition-colors"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
              className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
            >
              {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
            </button>
          </div>

          <div className="relative">
            <Lock size={17} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type={showPassword ? 'text' : 'password'}
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirmar contraseña"
              autoComplete="new-password"
              className="w-full bg-gray-50 border border-gray-200 rounded-2xl pl-11 pr-12 py-3.5 text-base focus:outline-none focus:border-[#007AFF] focus:ring-1 focus:ring-[#007AFF] transition-colors"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
              className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
            >
              {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
            </button>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full bg-[#007AFF] text-white py-3.5 rounded-2xl font-bold text-base hover:bg-blue-600 active:scale-95 transition-all disabled:opacity-50 shadow-lg shadow-blue-200"
          >
            {submitting ? 'Enviando...' : 'Cambiar contraseña'}
          </button>
        </form>

        <Link to="/login" className="block text-center text-sm text-gray-500 mt-5 underline">
          Volver a iniciar sesión
        </Link>
      </div>
    </div>
  )
}
