// '$ 1.234' para las cifras contables: es-ES, sin decimales. Contabilidad,
// Inicio y Auditoría mostraban dinero con esta misma línea copiada tres
// veces; ahora las tres leen de acá para que el formato no se diverga.
export const fmtMoney = (n) => '$ ' + new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 }).format(Math.round(Number(n) || 0))
