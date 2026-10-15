import { BrowserRouter, HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
import RequireAuth from './components/RequireAuth'
import RequireOwner from './components/RequireOwner'
import RequireWarehouse from './components/RequireWarehouse'
import Login from './pages/Login'
import Register from './pages/Register'
import Dashboard from './pages/Dashboard'
import Products from './pages/Products'
import POS from './pages/POS'
import Sales from './pages/Sales'
import Caja from './pages/Caja'
import Divisas from './pages/Divisas'
import Almacen from './pages/Almacen'
import Cajeros from './pages/Cajeros'
import Inventario from './pages/Inventario'
import ImportarProductos from './pages/ImportarProductos'
import { isElectron } from './lib/api'

// BrowserRouter necesita una URL real de servidor (usa el History API sobre
// el pathname) — bajo file:// ese pathname es la ruta completa al archivo en
// disco, así que ninguna ruta matchea nunca. HashRouter (usa el fragmento
// #/pos) no tiene ese problema y funciona igual de bien empaquetado.
const Router = isElectron() ? HashRouter : BrowserRouter

export default function App() {
  return (
    <Router>
      <Routes>
        <Route path="/login"    element={<Login />} />
        <Route path="/register" element={<Register />} />

        <Route element={<RequireAuth />}>
          <Route path="/" element={<Layout />}>
            <Route index element={<Navigate to="/pos" replace />} />
            <Route path="pos"  element={<POS />} />
            <Route path="caja" element={<Caja />} />
            {/* Cualquier cuenta compra divisas; el historial lo ve solo el dueño. */}
            <Route path="divisas" element={<Divisas />} />
            {/* El empleado entra para dar de alta productos nuevos; la
                pantalla le oculta editar, borrar, importar. Cualquier cuenta
                puede contar inventario (el servidor registra quién y el dueño lo ve). */}
            <Route path="products" element={<Products />} />
            {/* Todas las cuentas usan el almacén (alta, edición, importación,
                borrado y transferencia); el servidor registra quién lo hizo
                y solo la principal ve ese historial. */}
            <Route element={<RequireWarehouse />}>
              <Route path="almacen" element={<Almacen />} />
              <Route path="almacen/importar" element={<ImportarProductos target="almacen" />} />
            </Route>
            {/* El conteo de inventario lo puede hacer cualquier cuenta; el dueño ve
                quién contó. Pero solo el dueño ve el historial de conteos. */}
            <Route path="inventario" element={<Inventario />} />

            {/* Un cajero solo cobra y cierra la caja: el resto (excepto contar
                inventario) ni lo ve. */}
            <Route element={<RequireOwner />}>
              <Route path="dashboard" element={<Dashboard />} />
              <Route path="sales"      element={<Sales />} />
              <Route path="cajeros"    element={<Cajeros />} />
              <Route path="products/importar" element={<ImportarProductos />} />
            </Route>
          </Route>
        </Route>
      </Routes>
    </Router>
  )
}
