import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

// Comodidad, no seguridad: quien de verdad impide que un cajero lea el
// dashboard es el servidor (403 en middleware/auth.js). Esto solo evita que
// escribir la URL a mano lleve a una pantalla rota llena de errores.
export default function RequireOwner() {
  const { user } = useAuth()
  if (user?.role === 'cajero') return <Navigate to="/pos" replace />
  return <Outlet />
}
