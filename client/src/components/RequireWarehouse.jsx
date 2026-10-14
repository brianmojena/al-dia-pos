import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

// Tiendas con el almacén apagado (users.warehouse_enabled = 0): la URL escrita
// a mano lleva a la venta en vez de a una pantalla que no usan.
export default function RequireWarehouse() {
  const { user } = useAuth()
  if (user?.warehouse_enabled === false) return <Navigate to="/pos" replace />
  return <Outlet />
}
