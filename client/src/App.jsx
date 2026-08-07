import { BrowserRouter, HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
import RequireAuth from './components/RequireAuth'
import Login from './pages/Login'
import Register from './pages/Register'
import Dashboard from './pages/Dashboard'
import Products from './pages/Products'
import POS from './pages/POS'
import Sales from './pages/Sales'
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
            <Route path="dashboard" element={<Dashboard />} />
            <Route path="pos"       element={<POS />} />
            <Route path="products"  element={<Products />} />
            <Route path="sales"     element={<Sales />} />
          </Route>
        </Route>
      </Routes>
    </Router>
  )
}
