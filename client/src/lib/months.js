// Utilidades de fecha para el Historial por mes. Todo trabaja con las claves
// "YYYY-MM" / "YYYY-MM-DD" que manda el servidor — nunca con new Date(texto),
// que en Cuba (detrás de UTC) corre el día un día para atrás si se construye
// a partir de una fecha "pelada" sin hora. Acá se arma la fecha a mano con
// los componentes (año, mes, día) para que eso no pase nunca.

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
]
const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']

const pad2 = (n) => String(n).padStart(2, '0')

// 'YYYY-MM' -> [año, mes] (mes 1-12)
const splitMonth = (month) => String(month).split('-').map(Number)

// 'YYYY-MM-DD' -> [año, mes, día]
const splitDate = (date) => String(date).split('-').map(Number)

// shiftMonth('2026-01', -1) === '2025-12'
export const shiftMonth = (month, delta) => {
  const [y, m] = splitMonth(month)
  // Se suma en "meses desde el año 0" para que el acarreo de año salga solo,
  // sin pelear con Date ni con meses 0-based a medio camino.
  const totalMonths = y * 12 + (m - 1) + delta
  const year = Math.floor(totalMonths / 12)
  const monthIndex = totalMonths - year * 12
  return `${year}-${pad2(monthIndex + 1)}`
}

// monthLabel('2026-09') === 'septiembre 2026'
export const monthLabel = (month) => {
  const [y, m] = splitMonth(month)
  return `${MESES[m - 1]} ${y}`
}

// dayLabel('2026-09-15') === 'martes 15 sep'
export const dayLabel = (date) => {
  const [y, m, d] = splitDate(date)
  const weekday = DIAS[new Date(y, m - 1, d).getDay()]
  return `${weekday} ${d} ${MESES_CORTOS[m - 1]}`
}

// Mismo criterio que isSquare en Caja.jsx: redondea antes de comparar porque
// una suma de decimales puede dejar una diferencia de 0.0000001 que no es un
// descuadre real. `closes` es lo que manda /api/reports/days por día: null si
// no hubo cierre de caja ese día, o { count, difference, short }.
export const closeStatus = (closes) => {
  if (!closes) return { kind: 'none', amount: 0 }
  const diff = Math.round(closes.difference || 0)
  if (diff === 0) return { kind: 'square', amount: 0 }
  return diff < 0 ? { kind: 'short', amount: Math.abs(diff) } : { kind: 'over', amount: diff }
}
