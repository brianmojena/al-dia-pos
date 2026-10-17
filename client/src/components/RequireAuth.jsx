import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import LockedScreen from './LockedScreen'
import SharedCashier from '../pages/SharedCashier'
import { getSharedContext } from '../lib/sharedDevice.js'

export default function RequireAuth() {
  const { user, loading, sharedDevice, sharedLocked } = useAuth()

  if (loading) return (
    <div className="flex items-center justify-center h-screen bg-[#F5F5F7]">
      <div className="w-8 h-8 border-2 border-[#007AFF] border-t-transparent rounded-full animate-spin" />
    </div>
  )

  if (!user) return <Navigate to={sharedDevice ? '/cajero' : '/login'} replace />
  if (sharedLocked && getSharedContext()) return <SharedCashier />

  // Prueba gratuita vencida sin confirmar: nada de la app es accesible. La
  // pantalla de espera deja reintentar (por si administración ya confirmó) o
  // cerrar sesión.
  if (user.locked) return <LockedScreen />

  return <Outlet />
}
