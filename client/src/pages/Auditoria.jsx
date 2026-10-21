import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { Bot, RefreshCw, Sparkles } from 'lucide-react'
import { apiFetch } from '../lib/api'
import { isElectron } from '../lib/network.js'
import { useAuth } from '../context/AuthContext'
import AuditReportCard from '../components/AuditReportCard'

export default function Auditoria() {
  const { user } = useAuth()
  const [reports, setReports] = useState(null)
  const [filter, setFilter] = useState('all')
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  const load = async ({ silent = false } = {}) => {
    if (!silent) setRefreshing(true)
    setError('')
    try {
      const query = filter === 'all' ? '' : `?severity=${filter}`
      const res = await apiFetch(`/api/audit/reports${query}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'No se pudieron cargar los informes')
      setReports(Array.isArray(data) ? data : [])
    } catch (err) {
      setError(err.message || 'No se pudieron cargar los informes')
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => { if (!isElectron() && user?.role !== 'cajero') void load() }, [filter, user?.role])

  // La nube es la única que tiene los informes: en el escritorio offline no
  // hay nada que mostrar y es mejor volver al inicio que enseñar una pantalla vacía.
  if (isElectron() || user?.role === 'cajero') return <Navigate to="/" replace />

  return (
    <div className="p-5 md:p-8 max-w-3xl mx-auto pb-24 md:pb-8">
      <div className="flex items-start justify-between gap-3 mb-1">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#007AFF] text-white flex items-center justify-center">
            <Sparkles size={20} />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-gray-900">Auditoría</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              Explicaciones de tus cierres de caja
            </p>
          </div>
        </div>
        <button
          onClick={() => load()}
          disabled={refreshing}
          title="Actualizar"
          className="p-2.5 rounded-xl bg-white border border-gray-200 text-gray-500 hover:text-[#007AFF] hover:border-blue-200 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={17} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="flex items-start gap-2.5 bg-blue-50 text-[#007AFF] rounded-xl px-4 py-3 my-5">
        <Bot size={16} className="flex-shrink-0 mt-0.5" />
        <p className="text-xs leading-relaxed font-medium">
          La IA revisa el cierre y explica qué pudo pasar. No cambia los totales
          y no acusa a nadie: las cifras salen de las reglas de la tienda y la IA
          solo las redacta. Al modelo no se le envían correos ni identificadores.
        </p>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1 mb-4">
        {[
          ['all', 'Todos'],
          ['critical', 'Riesgo alto'],
          ['warning', 'Para revisar'],
          ['info', 'Observaciones'],
          ['ok', 'Sin anomalías'],
        ].map(([value, label]) => (
          <button
            key={value}
            onClick={() => setFilter(value)}
            className={`flex-shrink-0 text-xs font-semibold px-3.5 py-2 rounded-full border transition-colors ${
              filter === value
                ? 'bg-[#007AFF] text-white border-[#007AFF]'
                : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {error && (
        <div className="bg-red-50 text-red-700 rounded-xl px-4 py-3 text-sm mb-4">
          {error}
          <button onClick={() => load()} className="underline font-semibold ml-1">Reintentar</button>
        </div>
      )}

      {reports === null && !error ? (
        <div className="flex justify-center py-16">
          <div className="w-8 h-8 border-2 border-[#007AFF] border-t-transparent rounded-full animate-spin" />
        </div>
      ) : reports?.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm py-16 px-6 text-center">
          <Sparkles size={38} className="mx-auto mb-3 text-gray-300" />
          <p className="text-sm font-semibold text-gray-700">Todavía no hay informes</p>
          <p className="text-xs text-gray-400 mt-1 max-w-sm mx-auto">
            Se genera uno después de cada cierre. Si acabas de cerrar la caja, puede tardar
            un minuto en aparecer.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {reports?.map((report) => <AuditReportCard key={report.id} report={report} />)}
        </div>
      )}
    </div>
  )
}
