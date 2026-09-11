// El servidor devuelve las fechas como 'YYYY-MM-DD HH:MM:SS' en UTC, sin
// sufijo de zona. `new Date(...)` sobre ese texto lo interpreta como hora
// LOCAL, así que las ventas se mostraban corridas varias horas y se agrupaban
// bajo el día equivocado. Basta con decirle al navegador que es UTC.
export const parseServerDate = (value) => {
  if (!value) return null
  const s = String(value)
  return new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z')
}

export const formatTime = (value) =>
  parseServerDate(value)?.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) ?? '—'

export const formatDayLabel = (value) =>
  parseServerDate(value)?.toLocaleDateString('es-ES', {
    weekday: 'long', day: 'numeric', month: 'long',
  }) ?? '—'

export const formatDateTime = (value) =>
  parseServerDate(value)?.toLocaleString('es-ES', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  }) ?? '—'
