import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import {
  ChevronLeft, ChevronRight, Download, X, AlertTriangle, Trash2, BookOpen, WifiOff, ArrowUpRight, ArrowDownRight,
} from 'lucide-react'
import { businessDate } from '../lib/offlineModel.js'
import { apiFetch } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import { planOf } from '../lib/plans'
import { shiftMonth, monthLabel, dayLabel } from '../lib/months'
import { newId } from '../lib/newId'
import { formatTime } from '../lib/dates'
import { validateExpense } from '../lib/accountingValidation'
import { WITHDRAWAL_KINDS, WITHDRAWAL_KIND_LABELS, EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABELS } from '../lib/payment.js'
import { accountingCsv } from '../lib/offlineExport.js'
import { useLocalRefresh } from '../lib/useLocalRefresh.js'

const fmt = (n) => '$ ' + new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 }).format(Math.round(n || 0))

// Aviso amarillo: las extracciones sin tipo no restan del resultado hasta clasificarlas.
export function UnclassifiedNotice({ count, cup, onGo }) {
  if (!count) return null
  return (
    <div className="flex items-start gap-3 bg-amber-50 border border-amber-300 rounded-2xl px-5 py-4 mb-6">
      <AlertTriangle size={18} className="text-amber-600 flex-shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-amber-800">
          {`Tienes ${count} ${count === 1 ? 'extracción' : 'extracciones'} sin clasificar (${fmt(cup)}). No se descuentan del resultado hasta que ${count === 1 ? 'la' : 'las'} clasifiques.`}
        </p>
        <button type="button" onClick={onGo} className="mt-2 text-sm font-semibold text-amber-800 underline">
          Ir a la lista
        </button>
      </div>
    </div>
  )
}

// Compras de mercancía y retiros personales: se muestran, pero no restan del resultado.
export function WithdrawalTotals({ totals }) {
  return (
    <div className="bg-white rounded-2xl shadow-sm p-5 mb-6">
      <div className="flex items-center justify-between text-sm mb-2">
        <span className="text-gray-700">Compras de mercancía</span>
        <span className="font-semibold text-gray-900">{fmt(totals.merchandise_cup ?? 0)}</span>
      </div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-gray-700">Retiros personales</span>
        <span className="font-semibold text-gray-900">{fmt(totals.personal_cup ?? 0)}</span>
      </div>
      <p className="text-[11px] text-gray-500 mt-3">
        No se descuentan del resultado. La mercancía ya está en el costo de lo vendido, y los retiros personales son dinero tuyo.
      </p>
    </div>
  )
}

// Las sin clasificar van primero; Array.sort es estable, así que cada grupo
// conserva el orden del servidor (más recientes primero).
export function WithdrawalRows({ rows, savingId, onKindChange }) {
  const ordered = [...rows].sort((a, b) => Number(b.kind == null) - Number(a.kind == null))
  return (
    <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
      {ordered.map((w, idx) => (
        <div
          key={w.client_withdrawal_id}
          className={`px-5 py-4 flex items-start justify-between gap-3 ${
            idx < ordered.length - 1 ? 'border-b border-gray-100' : ''
          } ${w.kind == null ? 'bg-amber-50' : ''}`}
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-gray-900">{w.note || 'Sin nota'}</p>
            <p className="text-xs text-gray-500">
              {dayLabel(w.created_at.split(' ')[0])} · {formatTime(w.created_at)}
              {w.method !== 'efectivo' && ` · ${w.method}`}
            </p>
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            <span className="text-sm font-semibold text-gray-900">{fmt(w.amount)}</span>
            <select
              aria-label="Tipo de extracción"
              value={w.kind ?? ''}
              disabled={savingId === w.client_withdrawal_id}
              onChange={(e) => onKindChange(w.client_withdrawal_id, e.target.value)}
              className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs bg-white focus:outline-none focus:border-[#007AFF] disabled:opacity-50"
            >
              <option value="">Sin clasificar</option>
              {WITHDRAWAL_KINDS.map((kind) => (
                <option key={kind} value={kind}>{WITHDRAWAL_KIND_LABELS[kind]}</option>
              ))}
            </select>
          </div>
        </div>
      ))}
    </div>
  )
}

// Variación frente al mes anterior, en las tarjetas del resumen. `good` dice
// si subir es bueno para esa cifra: para los gastos, subir es malo.
export function Delta({ current, previous, good = true }) {
  if (previous == null || !(previous > 0)) return null
  const pct = Math.round(((current - previous) / previous) * 100)
  if (!pct) return null
  const up = pct > 0
  const favorable = up === good
  const Icon = up ? ArrowUpRight : ArrowDownRight
  return (
    <span className={`inline-flex items-center gap-0.5 text-[11px] font-semibold mt-2 ${favorable ? 'text-green-600' : 'text-red-600'}`}>
      <Icon size={12} aria-hidden="true" />
      {`${Math.abs(pct)}% vs mes anterior`}
    </span>
  )
}

// "¿En qué se fue el dinero?": una barra por categoría de gasto. Tocar una
// categoría filtra la lista de gastos. `cup` ya incluye las divisas convertidas,
// así que es la cifra comparable entre categorías.
export function CategoryBreakdown({ categoryTotals, filter, onFilter }) {
  const entries = Object.entries(categoryTotals || {})
    .map(([category, v]) => ({ category, cup: v.cup || 0, usd: v.usd || 0, eur: v.eur || 0 }))
    .sort((a, b) => b.cup - a.cup)
  if (!entries.length) return null
  const max = Math.max(...entries.map((e) => e.cup), 1)
  return (
    <div className="bg-white rounded-2xl shadow-sm p-5 mb-6">
      <p className="text-[11px] text-gray-400 uppercase tracking-wide mb-3 font-semibold">¿En qué se fue el dinero?</p>
      <div className="space-y-3">
        {entries.map(({ category, cup, usd, eur }) => {
          const label = EXPENSE_CATEGORY_LABELS[category] || 'Sin categoría'
          const active = filter === category
          const native = [usd > 0 && `${fmt(usd)} USD`, eur > 0 && `${fmt(eur)} EUR`].filter(Boolean).join(' · ')
          return (
            <button
              key={category}
              type="button"
              aria-pressed={active}
              onClick={() => onFilter(active ? '' : category)}
              className="w-full text-left group"
            >
              <div className="flex items-baseline justify-between gap-3 mb-1">
                <span className={`text-sm font-semibold group-hover:text-[#007AFF] ${active ? 'text-[#007AFF]' : 'text-gray-700'}`}>{label}</span>
                <span className="text-sm font-semibold text-gray-900 tabular-nums">
                  {/* Una categoría solo en divisa sin tasa no resta pesos: encabeza con su moneda. */}
                  {cup > 0 && fmt(cup)}
                  {cup > 0 && native && <span className="text-xs text-gray-500 font-normal"> ({native})</span>}
                  {cup === 0 && native && <span className="text-xs text-gray-500 font-normal">{native}</span>}
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-colors ${active ? 'bg-[#007AFF]' : 'bg-[#007AFF]/50 group-hover:bg-[#007AFF]'}`}
                  style={{ width: `${Math.max(4, Math.round((cup / max) * 100))}%` }}
                />
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// Lista de gastos del mes: píldora de categoría, recategorizar en línea y
// filtro activo. La píldora de "Sin categoría" se muestra en gris cuando el
// gasto es viejo o llegó de un cliente que aún no manda categoría.
export function ExpenseRows({ rows, filter, savingId, onCategoryChange, onVoid }) {
  const visible = filter ? rows.filter((e) => (e.category || 'sin_categoria') === filter) : rows
  const filterLabel = EXPENSE_CATEGORY_LABELS[filter] || (filter ? 'Sin categoría' : '')
  return (
    <div>
      <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
        {visible.map((expense, idx) => (
          <div
            key={expense.id}
            className={`px-5 py-4 flex items-start justify-between gap-3 ${
              idx < visible.length - 1 ? 'border-b border-gray-100' : ''
            } ${expense.voided_at ? 'opacity-50' : ''}`}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
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
                {expense.voided_at && expense.voided_by_email && ` · Anuló: ${expense.voided_by_email}`}
              </p>
            </div>
            <div className="flex items-center gap-3 flex-shrink-0">
              <span className="text-sm font-semibold text-gray-900">
                {fmt(expense.amount)} <span className="text-xs text-gray-500 font-normal">{expense.method}</span>
              </span>
              <select
                aria-label="Categoría del gasto"
                value={EXPENSE_CATEGORIES.includes(expense.category) ? expense.category : ''}
                disabled={savingId === expense.client_expense_id}
                onChange={(e) => onCategoryChange(expense.client_expense_id, e.target.value || null)}
                className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs bg-white focus:outline-none focus:border-[#007AFF] disabled:opacity-50"
              >
                <option value="">Sin categoría</option>
                {EXPENSE_CATEGORIES.map((category) => (
                  <option key={category} value={category}>{EXPENSE_CATEGORY_LABELS[category]}</option>
                ))}
              </select>
              {!expense.voided_at && (
                <button
                  onClick={() => onVoid(expense.client_expense_id)}
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
      {visible.length === 0 && (
        <p className="text-sm text-gray-500 px-1 py-3">
          {filter ? `No hay gastos de ${filterLabel} este mes.` : 'No hay gastos este mes.'}
        </p>
      )}
    </div>
  )
}

// Vista anual: una fila por mes, números a la derecha, total del año al pie.
// Tocar un mes abre ese mes en la vista mensual.
export function YearView({ year, months, totals, loading, error, onRetry, onPickMonth }) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="w-8 h-8 border-2 border-[#007AFF] border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }
  if (error) {
    return (
      <div className="bg-white rounded-2xl py-12 text-center text-gray-400 shadow-sm px-6 mb-6">
        <WifiOff size={32} className="mx-auto mb-3 opacity-30" />
        <p className="text-sm text-gray-500 mb-3">{error}</p>
        <button onClick={onRetry} className="text-sm font-semibold text-[#007AFF]">Reintentar</button>
      </div>
    )
  }
  return (
    <div className="bg-white rounded-2xl shadow-sm overflow-hidden mb-6">
      <div className="grid grid-cols-4 gap-2 px-5 py-3 border-b border-gray-100 text-[11px] text-gray-400 uppercase tracking-wide font-semibold">
        <span>Mes</span>
        <span className="text-right">Ingresos</span>
        <span className="text-right">Gastos</span>
        <span className="text-right">Resultado</span>
      </div>
      {(months || []).map((m) => (
        <button
          key={m.month}
          type="button"
          onClick={() => onPickMonth(m.month)}
          className="w-full grid grid-cols-4 gap-2 px-5 py-3 border-b border-gray-100 text-sm text-left hover:bg-gray-50 transition-colors"
        >
          <span className="font-semibold text-gray-900 capitalize">{monthLabel(m.month).split(' ')[0]}</span>
          <span className="text-right text-gray-800 tabular-nums">{fmt(m.income)}</span>
          <span className="text-right text-gray-800 tabular-nums">{fmt(m.expenses_cup)}</span>
          <span className={`text-right font-semibold tabular-nums ${m.result_cup >= 0 ? 'text-green-600' : 'text-red-600'}`}>
            {fmt(m.result_cup)}
          </span>
        </button>
      ))}
      {(months || []).length === 0 && (
        <p className="px-5 py-6 text-sm text-gray-500">Sin datos este año todavía.</p>
      )}
      <div className="grid grid-cols-4 gap-2 px-5 py-3 bg-gray-50 text-sm font-bold text-gray-900">
        <span>Total {year}</span>
        <span className="text-right tabular-nums">{fmt(totals?.income || 0)}</span>
        <span className="text-right tabular-nums">{fmt(totals?.expenses_cup || 0)}</span>
        <span className={`text-right tabular-nums ${(totals?.result_cup || 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
          {fmt(totals?.result_cup || 0)}
        </span>
      </div>
    </div>
  )
}

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
  const [viewMode, setViewMode] = useState('mes') // 'mes' | 'año'
  const [summary, setSummary] = useState(null)
  const [expenses, setExpenses] = useState([])
  const [withdrawals, setWithdrawals] = useState([])
  const [kindSavingId, setKindSavingId] = useState(null)
  const [kindError, setKindError] = useState('')
  const withdrawalsRef = useRef(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')

  // Vista anual (solo con conexión: la vista anual no está en la cola offline)
  const viewYear = viewMonth.slice(0, 4)
  const [yearData, setYearData] = useState(null)
  const [yearLoading, setYearLoading] = useState(false)
  const [yearError, setYearError] = useState('')

  // Desglose por categoría: tocar una categoría filtra la lista de gastos
  const [categoryFilter, setCategoryFilter] = useState('')
  const [categorySavingId, setCategorySavingId] = useState(null)
  const [categoryError, setCategoryError] = useState('')

  // Estado del formulario para agregar gastos
  const [showExpenseForm, setShowExpenseForm] = useState(false)
  const [expenseMethod, setExpenseMethod] = useState('efectivo')
  const [expenseAmount, setExpenseAmount] = useState('')
  const [expenseConcept, setExpenseConcept] = useState('')
  // La categoría recuerda la última que se usó en este aparato; si nunca se
  // anotó un gasto, arranca en Otros.
  const [expenseCategory, setExpenseCategory] = useState(() => {
    try { return localStorage.getItem('mypimes_last_expense_category') || 'otros' } catch { return 'otros' }
  })
  const [expenseSubmitting, setExpenseSubmitting] = useState(false)
  const [expenseError, setExpenseError] = useState('')
  // Se mantiene entre reintentos para que el servidor reconozca el reintento y
  // no registre dos gastos. Se genera solo una vez al abrir el formulario.
  const expenseIdRef = useRef(null)

  // silent: recarga sin desmontar la página (no spinner, no borrar el error),
  // para que al clasificar varias extracciones seguidas no se pierda el scroll.
  const loadMonth = async (month, { silent = false } = {}) => {
    if (!silent) {
      setLoading(true)
      setError('')
    }
    try {
      // El resumen del mes anterior alimenta las flechas de comparación. Pedirlo
      // aparte (y no confiar en summary.previous) hace que funcione igual con la
      // proyección local y sincroniza el historial del mes anterior al visitar un mes.
      const [summaryRes, expensesRes, withdrawalsRes, prevRes] = await Promise.all([
        apiFetch(`/api/accounting/summary?month=${month}`),
        apiFetch(`/api/accounting/expenses?month=${month}`),
        apiFetch(`/api/accounting/withdrawals?month=${month}`),
        apiFetch(`/api/accounting/summary?month=${shiftMonth(month, -1)}`),
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
      if (!withdrawalsRes.ok) throw new Error('No se pudo cargar las extracciones.')

      const summaryData = await summaryRes.json()
      const expensesData = await expensesRes.json()
      const withdrawalsData = await withdrawalsRes.json()
      const prevData = prevRes.ok ? await prevRes.json().catch(() => null) : null

      // Un mes anterior sin ningún movimiento no sirve para comparar: dejar las
      // flechas fuera en vez de mostrar un -100% falso.
      const previous = prevData?.days?.length > 0
        ? {
          income: prevData.totals.income,
          profit: prevData.totals.profit,
          expenses_cup: prevData.totals.expenses_cup,
          result_cup: prevData.totals.result_cup,
        }
        : (summaryData.previous ?? null)

      setSummary({ ...summaryData, previous })
      setExpenses(Array.isArray(expensesData) ? expensesData : [])
      setWithdrawals(Array.isArray(withdrawalsData) ? withdrawalsData : [])
    } catch (err) {
      setError(err.message || 'No se pudieron cargar los datos.')
    } finally {
      if (!silent) setLoading(false)
    }
  }

  useEffect(() => {
    loadMonth(viewMonth)
  }, [viewMonth])
  // Los gastos y el resumen son offline-capables: al confirmarse la subida de
  // una operación (o llegar una página del snapshot) se refresca en silencio.
  useLocalRefresh(() => loadMonth(viewMonth, { silent: true }))

  const loadYear = (year) => {
    setYearLoading(true)
    setYearError('')
    apiFetch(`/api/accounting/year?year=${year}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || 'No se pudo cargar la vista anual.')
        setYearData(data)
      })
      .catch((err) => {
        setYearError(navigator.onLine === false
          ? 'La vista anual necesita conexión.'
          : (err.message || 'No se pudo cargar la vista anual.'))
      })
      .finally(() => setYearLoading(false))
  }

  useEffect(() => {
    if (viewMode === 'año') loadYear(viewYear)
  }, [viewMode, viewYear])

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
          category: expenseCategory,
        }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'No se pudo guardar el gasto.')
      }

      // La próxima vez que anote un gasto, arranca en la categoría de esta.
      try { localStorage.setItem('mypimes_last_expense_category', expenseCategory) } catch { /* sin espacio: no pasa nada */ }

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

  // Recategorizar en línea: igual que clasificar extracciones, no mueve dinero.
  const handleCategoryChange = async (clientExpenseId, category) => {
    if (navigator.onLine === false) {
      setCategoryError('Conéctate para cambiar la categoría del gasto.')
      return
    }
    setCategorySavingId(clientExpenseId)
    setCategoryError('')
    try {
      const res = await apiFetch(`/api/accounting/expenses/${clientExpenseId}/category`, {
        method: 'PATCH',
        body: JSON.stringify({ category }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'No se pudo cambiar la categoría.')
      }
      await loadMonth(viewMonth, { silent: true })
    } catch (err) {
      setCategoryError(err.message)
    } finally {
      setCategorySavingId(null)
    }
  }

  // Al guardar se recarga el mes entero: el resumen y la lista quedan al día.
  const handleKindChange = async (clientWithdrawalId, value) => {
    setKindSavingId(clientWithdrawalId)
    setKindError('')
    try {
      // La clasificación aún no funciona sin conexión: la cola solo cubre los gastos.
      if (navigator.onLine === false) throw new Error('Conéctate para clasificar la extracción.')
      const res = await apiFetch(`/api/cash-withdrawals/${clientWithdrawalId}/kind`, {
        method: 'PATCH',
        body: JSON.stringify({ kind: value || null }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'No se pudo cambiar el tipo de la extracción.')
      }
      await loadMonth(viewMonth, { silent: true })
    } catch (err) {
      setKindError(err.message)
    } finally {
      setKindSavingId(null)
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

  const saveBlob = (blob, filename) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }

  const downloadExcel = async () => {
    if (!viewMonth) return
    setExporting(true)
    setExportError('')
    try {
      if (navigator.onLine === false) throw new Error('offline')
      const res = await apiFetch(`/api/accounting/export?month=${viewMonth}`)
      if (!res.ok) throw new Error('No se pudo generar el archivo.')
      saveBlob(await res.blob(), `contabilidad-${viewMonth}.xlsx`)
    } catch (err) {
      if (err.message !== 'offline') {
        setExportError(err.message)
      } else {
        // Sin conexión: CSV con lo descargado, mismo criterio que el historial de ventas.
        try {
          const csv = accountingCsv(summary, expenses, viewMonth)
          saveBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `contabilidad-${viewMonth}.csv`)
        } catch {
          setExportError('Sin conexión no se pudo generar el archivo.')
        }
      }
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

      {/* Navegación de mes / año */}
      <div className="flex items-center justify-between mb-6">
        <button
          onClick={() => goMonth(-1)}
          disabled={loading}
          className="p-2 rounded-xl hover:bg-gray-100 text-gray-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <ChevronLeft size={20} />
        </button>
        <div className="flex flex-col items-center gap-2">
          <p className="font-semibold text-gray-900 capitalize">
            {viewMode === 'año' ? viewYear : (viewMonth ? monthLabel(viewMonth) : '—')}
          </p>
          <div className="flex items-center gap-1 bg-gray-100 rounded-xl p-1">
            <button
              onClick={() => setViewMode('mes')}
              aria-pressed={viewMode === 'mes'}
              className={`px-3 py-1 rounded-lg text-xs font-semibold transition-colors ${
                viewMode === 'mes' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Mes
            </button>
            <button
              onClick={() => setViewMode('año')}
              aria-pressed={viewMode === 'año'}
              className={`px-3 py-1 rounded-lg text-xs font-semibold transition-colors ${
                viewMode === 'año' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Año
            </button>
          </div>
        </div>
        <button
          onClick={() => goMonth(1)}
          disabled={nextDisabled || loading}
          className="p-2 rounded-xl hover:bg-gray-100 text-gray-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <ChevronRight size={20} />
        </button>
      </div>

      {viewMode === 'año' ? (
        <YearView
          year={viewYear}
          months={yearData?.months || []}
          totals={yearData?.totals}
          loading={yearLoading}
          error={yearError}
          onRetry={() => loadYear(viewYear)}
          onPickMonth={(month) => { setViewMonth(month); setViewMode('mes') }}
        />
      ) : loading ? (
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
            <UnclassifiedNotice
              count={summary.totals.unclassified_count ?? 0}
              cup={summary.totals.unclassified_cup ?? 0}
              onGo={() => withdrawalsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            />
          )}

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
                <Delta current={summary.totals.income} previous={summary.previous?.income} />
              </div>

              {/* Ganancia */}
              <div className="bg-white rounded-2xl shadow-sm p-5">
                <p className="text-[11px] text-gray-400 uppercase tracking-wide mb-2 font-semibold">Ganancia</p>
                <p className="text-2xl font-bold text-green-600">{fmt(summary.totals.profit)}</p>
                <p className="text-[11px] text-gray-500 mt-2">De las ventas (sin gastos)</p>
                <Delta current={summary.totals.profit} previous={summary.previous?.profit} />
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
                <Delta current={summary.totals.expenses_cup} previous={summary.previous?.expenses_cup} good={false} />
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
                  Ganancia menos gastos (las divisas cuentan a la tasa del día que se anotaron)
                </p>
                {summary.totals.missing_rate_count > 0 && (
                  <p className="text-[11px] text-amber-700 mt-1">
                    {`${summary.totals.missing_rate_count} ${summary.totals.missing_rate_count === 1 ? 'gasto en divisa sin tasa no se descuenta' : 'gastos en divisa sin tasa no se descuentan'}. `}
                    <Link to="/" className="underline font-semibold">Fija la tasa en Inicio</Link>
                  </p>
                )}
                <Delta current={summary.totals.result_cup} previous={summary.previous?.result_cup} />
              </div>
            </div>
          )}
          {summary && <WithdrawalTotals totals={summary.totals} />}

          {/* Desglose por categoría: tocar una filtra la lista de gastos */}
          {summary?.totals?.category_totals && Object.keys(summary.totals.category_totals).length > 0 && (
            <CategoryBreakdown
              categoryTotals={summary.totals.category_totals}
              filter={categoryFilter}
              onFilter={setCategoryFilter}
            />
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

                {/* Categoría: recuerda la última usada en este aparato */}
                <div>
                  <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 block">
                    Categoría
                  </label>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {EXPENSE_CATEGORIES.map((category) => (
                      <button
                        key={category}
                        type="button"
                        aria-pressed={expenseCategory === category}
                        onClick={() => setExpenseCategory(category)}
                        className={`py-2 px-3 rounded-lg text-sm font-semibold transition-colors ${
                          expenseCategory === category
                            ? 'bg-[#007AFF] text-white'
                            : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                        }`}
                      >
                        {EXPENSE_CATEGORY_LABELS[category]}
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
            <p>Las extracciones de caja clasificadas como Gasto del negocio ya se cuentan como gasto automáticamente. No es necesario anotarlas de nuevo.</p>
          </div>

          {/* Lista de gastos del mes: con filtro por categoría y recategorizar en línea */}
          {expenses.length > 0 && (
            <div className="mb-6">
              <div className="flex items-center justify-between gap-3 mb-3">
                <h3 className="font-semibold text-gray-900">Gastos del mes</h3>
                {categoryFilter && (
                  <button
                    type="button"
                    onClick={() => setCategoryFilter('')}
                    className="text-xs font-semibold text-[#007AFF] bg-blue-50 rounded-full px-3 py-1.5 hover:bg-blue-100 transition-colors"
                  >
                    {EXPENSE_CATEGORY_LABELS[categoryFilter] || 'Sin categoría'} · ver todas
                  </button>
                )}
              </div>
              <ExpenseRows
                rows={expenses}
                filter={categoryFilter}
                savingId={categorySavingId}
                onCategoryChange={handleCategoryChange}
                onVoid={handleVoidExpense}
              />
              {categoryError && <p role="alert" className="text-sm text-red-600 mt-2">{categoryError}</p>}
            </div>
          )}

          {/* Extracciones del mes: cada una se clasifica para saber si resta del resultado */}
          <div ref={withdrawalsRef} className="mb-6">
            <h3 className="font-semibold text-gray-900 mb-1">Extracciones del mes</h3>
            <p className="text-xs text-gray-500 mb-3">Clasifica cada extracción. Solo Gasto del negocio resta del resultado.</p>
            {kindError && <p role="alert" className="text-sm text-red-600 mb-3">{kindError}</p>}
            {withdrawals.length > 0 ? (
              <WithdrawalRows rows={withdrawals} savingId={kindSavingId} onKindChange={handleKindChange} />
            ) : (
              <p className="text-sm text-gray-500">No hay extracciones este mes.</p>
            )}
          </div>

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
