import { useState, useEffect, useRef } from 'react'
import {
  ChevronLeft, ChevronRight, Download, X, AlertTriangle, Trash2, BookOpen, WifiOff,
} from 'lucide-react'
import { businessDate } from '../lib/offlineModel.js'
import { apiFetch } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import { planOf } from '../lib/plans'
import { shiftMonth, monthLabel, dayLabel } from '../lib/months'
import { newId } from '../lib/newId'
import { formatTime } from '../lib/dates'
import { validateExpense } from '../lib/accountingValidation'

const fmt = (n) => '$ ' + new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 }).format(Math.round(n || 0))

export default function Contabilidad() {
  const { user } = useAuth()

  // Si no es enterprise, no permite ni llamar a la API
  if (planOf(user?.plan) !== 'enterprise') {
    return (
      <div className="p-5 md:p-8 max-w-2xl mx-auto pb-24 md:pb-8">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-2xl font-bold text-gray-900">Contabilidad</h2>
        </div>
        <div className="bg-white rounded-2xl shadow-sm p-8 text-center">
          <BookOpen size={40} className="mx-auto mb-3 text-gray-300" />
          <p className="text-base text-gray-700 font-semibold mb-1">
            La contabilidad es parte del plan Enterprise
          </p>
          <p className="text-sm text-gray-500">
            Actualiza tu plan para acceder a esta herramienta de análisis financiero.
          </p>
        </div>
      </div>
    )
  }

  return <ContabilidadContent />
}

function ContabilidadContent() {
  const { user } = useAuth()
  // businessDate() respeta la zona horaria local (Cuba: UTC-4) y no avanza un día
  // si se llama a las 8 pm del último día del mes.
  const currentMonth = businessDate().slice(0, 7) // YYYY-MM

  const [viewMonth, setViewMonth] = useState(currentMonth)
  const [summary, setSummary] = useState(null)
  const [expenses, setExpenses] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')

  // Estado del formulario para agregar gastos
  const [showExpenseForm, setShowExpenseForm] = useState(false)
  const [expenseMethod, setExpenseMethod] = useState('efectivo')
  const [expenseAmount, setExpenseAmount] = useState('')
  const [expenseConcept, setExpenseConcept] = useState('')
  const [expenseSubmitting, setExpenseSubmitting] = useState(false)
  const [expenseError, setExpenseError] = useState('')
  // Se mantiene entre reintentos para que el servidor reconozca el reintento y
  // no registre dos gastos. Se genera solo una vez al abrir el formulario.
  const expenseIdRef = useRef(null)

  const loadMonth = async (month) => {
    setLoading(true)
    setError('')
    try {
      const [summaryRes, expensesRes] = await Promise.all([
        apiFetch(`/api/accounting/summary?month=${month}`),
        apiFetch(`/api/accounting/expenses?month=${month}`),
      ])

      // Si falla por PLAN_REQUIRED, mostrar la tarjeta de plan
      if (summaryRes.status === 403) {
        const data = await summaryRes.json()
        if (data.code === 'PLAN_REQUIRED') {
          setError('plan-required')
          return
        }
      }

      if (!summaryRes.ok) throw new Error('No se pudo cargar el resumen del mes.')
      if (!expensesRes.ok) throw new Error('No se pudo cargar los gastos.')

      const summaryData = await summaryRes.json()
      const expensesData = await expensesRes.json()

      setSummary(summaryData)
      setExpenses(Array.isArray(expensesData) ? expensesData : [])
    } catch (err) {
      setError(err.message || 'No se pudieron cargar los datos.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadMonth(viewMonth)
  }, [viewMonth])

  const goMonth = (delta) => {
    setViewMonth((current) => shiftMonth(current, delta))
  }

  const handleAddExpense = async (e) => {
    e.preventDefault()
    if (expenseSubmitting) return

    // Validar usando función pura
    const validationError = validateExpense(expenseAmount, expenseConcept)
    if (validationError) {
      setExpenseError(validationError)
      return
    }

    setExpenseSubmitting(true)
    setExpenseError('')

    try {
      const res = await apiFetch('/api/accounting/expenses', {
        method: 'POST',
        body: JSON.stringify({
          client_expense_id: expenseIdRef.current,
          method: expenseMethod,
          amount: parseFloat(expenseAmount),
          concept: expenseConcept.trim(),
        }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'No se pudo guardar el gasto.')
      }

      // Limpiar formulario, ID y recargar
      setExpenseAmount('')
      setExpenseConcept('')
      setExpenseMethod('efectivo')
      setShowExpenseForm(false)
      expenseIdRef.current = null
      await loadMonth(viewMonth)
    } catch (err) {
      setExpenseError(err.message)
    } finally {
      setExpenseSubmitting(false)
    }
  }

  const handleVoidExpense = async (clientExpenseId) => {
    if (!window.confirm('¿Anular este gasto?')) return

    try {
      const res = await apiFetch(`/api/accounting/expenses/${clientExpenseId}/void`, {
        method: 'POST',
      })
      if (!res.ok) throw new Error('No se pudo anular el gasto.')
      await loadMonth(viewMonth)
    } catch (err) {
      setError(err.message)
    }
  }

  const downloadExcel = async () => {
    if (!viewMonth) return
    setExporting(true)
    setExportError('')
    try {
      const res = await apiFetch(`/api/accounting/export?month=${viewMonth}`)
      if (!res.ok) throw new Error('No se pudo generar el archivo.')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `contabilidad-${viewMonth}.xlsx`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (err) {
      setExportError(err.message)
    } finally {
      setExporting(false)
    }
  }

  const nextDisabled = !viewMonth || viewMonth >= currentMonth

  if (error === 'plan-required') {
    return (
      <div className="p-5 md:p-8 max-w-2xl mx-auto pb-24 md:pb-8">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-2xl font-bold text-gray-900">Contabilidad</h2>
        </div>
        <div className="bg-white rounded-2xl shadow-sm p-8 text-center">
          <BookOpen size={40} className="mx-auto mb-3 text-gray-300" />
          <p className="text-base text-gray-700 font-semibold mb-1">
            La contabilidad es parte del plan Enterprise
          </p>
          <p className="text-sm text-gray-500">
            Actualiza tu plan para acceder a esta herramienta de análisis financiero.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-5 md:p-8 max-w-4xl mx-auto pb-24 md:pb-8">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Contabilidad</h2>
      </div>

      {/* Navegación de mes */}
      <div className="flex items-center justify-between mb-6">
        <button
          onClick={() => goMonth(-1)}
          disabled={loading}
          className="p-2 rounded-xl hover:bg-gray-100 text-gray-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <ChevronLeft size={20} />
        </button>
        <p className="font-semibold text-gray-900 capitalize">
          {viewMonth ? monthLabel(viewMonth) : '—'}
        </p>
        <button
          onClick={() => goMonth(1)}
          disabled={nextDisabled || loading}
          className="p-2 rounded-xl hover:bg-gray-100 text-gray-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <ChevronRight size={20} />
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-8 h-8 border-2 border-[#007AFF] border-t-transparent rounded-full animate-spin" />
        </div>
      ) : error ? (
        <div className="bg-white rounded-2xl py-16 text-center text-gray-400 shadow-sm px-6">
          <WifiOff size={36} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm text-gray-500 mb-4">{error}</p>
          <button onClick={() => loadMonth(viewMonth)} className="text-sm font-semibold text-[#007AFF]">
            Reintentar
          </button>
        </div>
      ) : (
        <>
          {/* Tarjetas de resumen */}
          {summary && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
              {/* Ingresos */}
              <div className="bg-white rounded-2xl shadow-sm p-5">
                <p className="text-[11px] text-gray-400 uppercase tracking-wide mb-2 font-semibold">Ingresos</p>
                <p className="text-2xl font-bold text-gray-900">{fmt(summary.totals.income)}</p>
                {summary.totals.income_cash > 0 && (
                  <p className="text-[11px] text-gray-500 mt-2">Efectivo: {fmt(summary.totals.income_cash)}</p>
                )}
                {summary.totals.income_transfer > 0 && (
                  <p className="text-[11px] text-gray-500">Transferencia: {fmt(summary.totals.income_transfer)}</p>
                )}
                {summary.totals.income_foreign_cup > 0 && (
                  <p className="text-[11px] text-gray-500">Divisa: {fmt(summary.totals.income_foreign_cup)}</p>
                )}
              </div>

              {/* Ganancia */}
              <div className="bg-white rounded-2xl shadow-sm p-5">
                <p className="text-[11px] text-gray-400 uppercase tracking-wide mb-2 font-semibold">Ganancia</p>
                <p className="text-2xl font-bold text-green-600">{fmt(summary.totals.profit)}</p>
                <p className="text-[11px] text-gray-500 mt-2">De las ventas (sin gastos)</p>
              </div>

              {/* Gastos */}
              <div className="bg-white rounded-2xl shadow-sm p-5">
                <p className="text-[11px] text-gray-400 uppercase tracking-wide mb-2 font-semibold">Gastos</p>
                <p className="text-2xl font-bold text-gray-900">{fmt(summary.totals.expenses_cup)}</p>
                {(summary.totals.expenses_usd > 0 || summary.totals.expenses_eur > 0) && (
                  <p className="text-[11px] text-gray-500 mt-2">
                    {summary.totals.expenses_usd > 0 && `${fmt(summary.totals.expenses_usd)} USD`}
                    {summary.totals.expenses_usd > 0 && summary.totals.expenses_eur > 0 && ' · '}
                    {summary.totals.expenses_eur > 0 && `${fmt(summary.totals.expenses_eur)} EUR`}
                  </p>
                )}
              </div>

              {/* Resultado */}
              <div className={`rounded-2xl shadow-sm p-5 ${summary.totals.result_cup >= 0 ? 'bg-green-50' : 'bg-red-50'}`}>
                <p className="text-[11px] uppercase tracking-wide mb-2 font-semibold" style={{color: summary.totals.result_cup >= 0 ? '#059669' : '#dc2626'}}>
                  Resultado
                </p>
                <p className={`text-2xl font-bold ${summary.totals.result_cup >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {fmt(summary.totals.result_cup)}
                </p>
                <p className="text-[11px] mt-2" style={{color: summary.totals.result_cup >= 0 ? '#059669' : '#dc2626'}}>
                  Ganancia − gastos
                </p>
              </div>
            </div>
          )}

          {/* Botón de descargar Excel */}
          <div className="mb-6">
            <button
              onClick={downloadExcel}
              disabled={exporting}
              className="w-full flex items-center justify-center gap-2 bg-white border border-gray-200 text-gray-700 font-semibold text-sm py-3 rounded-2xl shadow-sm hover:bg-gray-50 active:scale-[0.99] transition-all disabled:opacity-50"
            >
              <Download size={16} />
              {exporting ? 'Generando...' : 'Descargar Excel'}
            </button>
            {exportError && (
              <p className="text-xs text-red-600 text-center mt-2">{exportError}</p>
            )}
          </div>

          {/* Formulario para agregar gasto */}
          {!showExpenseForm ? (
            <button
              onClick={() => {
                expenseIdRef.current = newId()
                setShowExpenseForm(true)
              }}
              className="w-full bg-white border border-gray-200 text-gray-700 font-semibold text-sm py-3 rounded-2xl shadow-sm hover:bg-gray-50 active:scale-[0.99] transition-all mb-6"
            >
              + Anotar gasto
            </button>
          ) : (
            <form onSubmit={handleAddExpense} className="bg-white rounded-2xl shadow-sm p-6 mb-6">
              <div className="flex items-center justify-between mb-4">
                <p className="font-semibold text-gray-900">Anotar un gasto</p>
                <button
                  type="button"
                  onClick={() => {
                    setShowExpenseForm(false)
                    setExpenseError('')
                    expenseIdRef.current = null
                  }}
                  className="p-1 hover:bg-gray-100 rounded-lg text-gray-400"
                >
                  <X size={18} />
                </button>
              </div>

              <div className="space-y-4">
                {/* Método de pago */}
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 block">
                    Apartado
                  </label>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {['efectivo', 'transferencia', 'USD', 'EUR'].map((method) => (
                      <button
                        key={method}
                        type="button"
                        onClick={() => setExpenseMethod(method)}
                        className={`py-2 px-3 rounded-lg text-sm font-semibold transition-colors ${
                          expenseMethod === method
                            ? 'bg-[#007AFF] text-white'
                            : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                        }`}
                      >
                        {method.charAt(0).toUpperCase() + method.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Monto */}
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">
                    Monto
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={expenseAmount}
                    onChange={(e) => setExpenseAmount(e.target.value)}
                    className="w-full border border-gray-200 rounded-xl px-4 py-3 text-base focus:outline-none focus:border-[#007AFF] focus:ring-1 focus:ring-[#007AFF] transition-colors"
                  />
                </div>

                {/* Concepto */}
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">
                    ¿En qué se gastó? *
                  </label>
                  <input
                    type="text"
                    placeholder="Describe el gasto (al menos 3 letras)"
                    value={expenseConcept}
                    onChange={(e) => setExpenseConcept(e.target.value)}
                    className="w-full border border-gray-200 rounded-xl px-4 py-3 text-base focus:outline-none focus:border-[#007AFF] focus:ring-1 focus:ring-[#007AFF] transition-colors"
                  />
                </div>

                {expenseError && (
                  <div className="flex items-start gap-2 bg-red-50 text-red-700 rounded-xl px-4 py-3 text-sm">
                    <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
                    <p>{expenseError}</p>
                  </div>
                )}

                <div className="flex gap-2 pt-2">
                  <button
                    type="submit"
                    disabled={expenseSubmitting}
                    className="flex-1 bg-[#007AFF] text-white font-semibold py-3 rounded-2xl hover:bg-blue-600 active:scale-[0.99] transition-all disabled:opacity-50"
                  >
                    {expenseSubmitting ? 'Guardando...' : 'Guardar'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowExpenseForm(false)
                      setExpenseError('')
                      expenseIdRef.current = null
                    }}
                    className="flex-1 bg-gray-100 text-gray-700 font-semibold py-3 rounded-2xl hover:bg-gray-200 active:scale-[0.99] transition-all"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            </form>
          )}

          {/* Aclaración sobre extracciones de caja */}
          <div className="flex items-start gap-2 bg-blue-50 text-blue-800 rounded-xl px-4 py-3 mb-6 text-sm">
            <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
            <p>Las extracciones de caja ya se cuentan como gasto automáticamente. No es necesario anotarlas de nuevo.</p>
          </div>

          {/* Lista de gastos del mes */}
          {expenses.length > 0 && (
            <div className="mb-6">
              <h3 className="font-semibold text-gray-900 mb-3">Gastos del mes</h3>
              <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
                {expenses.map((expense, idx) => (
                  <div
                    key={expense.id}
                    className={`px-5 py-4 flex items-start justify-between gap-3 ${
                      idx < expenses.length - 1 ? 'border-b border-gray-100' : ''
                    } ${expense.voided_at ? 'opacity-50' : ''}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <p className="text-sm font-semibold text-gray-900">{expense.concept}</p>
                        {expense.voided_at && (
                          <span className="text-xs font-semibold px-2 py-1 rounded-full bg-gray-200 text-gray-600">
                            Anulado
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-500">
                        {dayLabel(expense.created_at.split(' ')[0])} · {formatTime(expense.created_at)}
                      </p>
                      <p className="text-xs text-gray-400 mt-1">
                        Por: {expense.account_email}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      <span className="text-sm font-semibold text-gray-900">
                        {fmt(expense.amount)} <span className="text-xs text-gray-500 font-normal">{expense.method}</span>
                      </span>
                      {!expense.voided_at && (
                        <button
                          onClick={() => handleVoidExpense(expense.client_expense_id)}
                          className="p-2 hover:bg-red-50 rounded-lg text-gray-400 hover:text-red-600 transition-colors"
                          title="Anular"
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Lista por día */}
          {summary?.days && summary.days.length > 0 && (
            <div>
              <h3 className="font-semibold text-gray-900 mb-3">Por día</h3>
              <div className="space-y-2">
                {summary.days.map((day) => (
                  <div key={day.date} className="bg-white rounded-2xl shadow-sm px-5 py-4">
                    <div className="flex items-center justify-between mb-2 gap-2">
                      <p className="font-semibold text-gray-900 text-sm capitalize">{dayLabel(day.date)}</p>
                    </div>
                    <div className="grid grid-cols-3 gap-3 pt-3 border-t border-gray-100 text-center">
                      <div>
                        <p className="text-[11px] text-gray-400 mb-0.5">Ingresos</p>
                        <p className="text-sm font-semibold text-gray-800">{fmt(day.income)}</p>
                      </div>
                      <div>
                        <p className="text-[11px] text-gray-400 mb-0.5">Gastos</p>
                        <p className="text-sm font-semibold text-gray-800">{fmt(day.expenses_cup)}</p>
                      </div>
                      <div>
                        <p className="text-[11px] text-gray-400 mb-0.5">Resultado</p>
                        <p className={`text-sm font-semibold ${day.result_cup >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                          {fmt(day.result_cup)}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
