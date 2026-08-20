import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { AuthProvider } from './context/AuthContext.jsx'
import { startAutoFlush } from './lib/salesQueue.js'
import './index.css'

// Arranca una sola vez, fuera de React: drena la cola de ventas offline al
// recuperar conexión y cada 20s como respaldo (por si el evento 'online' del
// navegador no dispara, que pasa más de lo que debería en redes inestables).
startAutoFlush()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </React.StrictMode>
)
