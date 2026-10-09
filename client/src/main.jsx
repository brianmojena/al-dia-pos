import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { AuthProvider } from './context/AuthContext.jsx'
import { startOfflineSync } from './lib/offlineClient.js'
import './index.css'

// Arranca una sola vez, fuera de React: sube los cambios locales y descarga los datos al
// recuperar conexión y cada 20s como respaldo (por si el evento 'online' del
// navegador no dispara, que pasa más de lo que debería en redes inestables).
startOfflineSync()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </React.StrictMode>
)
