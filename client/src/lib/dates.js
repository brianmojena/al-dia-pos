// El servidor devuelve las fechas como 'YYYY-MM-DD HH:MM:SS' en UTC, sin
// sufijo de zona. `new Date(...)` sobre ese texto lo interpreta como hora
// LOCAL, así que las ventas se mostraban corridas varias horas y se agrupaban
// bajo el día equivocado. Basta con decirle al navegador que es UTC.
//
// Lo mismo vale para las filas que traen la 'T' de ISO pero tampoco dicen la
// zona (datos de demostración y filas viejas): antes se dejaban pasar tal cual
// y JavaScript las leía como hora local, así que la misma venta aparecía a una
// hora en la pantalla y a otra en el Excel del mes, que lo resuelve el
// servidor (ver server/lib/businessDay.js). Solo se respeta la zona cuando el
// texto la trae de verdad.
const TIENE_ZONA = /(Z|[+-]\d{2}:?\d{2})$/

export const parseServerDate = (value) => {
  if (!value) return null
  const s = String(value).trim().replace(' ', 'T')
  const d = new Date(TIENE_ZONA.test(s) ? s : `${s}Z`)
  return Number.isNaN(d.getTime()) ? null : d
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
