import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

// El servidor vuelve a comprobar el email permitido en cada petición.
export default function RequireAdmin() {
  const { user } = useAuth()
  if (!user?.is_admin) return <Navigate to="/pos" replace />
  return <Outlet />
}
