/**
 * Fronteras del "día del negocio".
 *
 * Todo se ALMACENA en UTC: created_at viene de datetime('now') de SQLite, que
 * es UTC. Eso está bien y no se toca — es lo único que ordena correctamente y
 * sobrevive a los cambios de horario.
 *
 * El problema era otro: "hoy" se calculaba comparando date(created_at) contra
 * la fecha UTC. En Cuba (UTC−4/−5) eso hace que el día del dashboard cambie a
 * las 8:00 pm hora local — a las 9 de la noche el dueño veía el día casi en
 * cero, con todas las ventas de la tarde ya contadas como "ayer".
 *
 * La solución es calcular en JavaScript, que sí conoce la base de datos de
 * zonas horarias, en qué instantes UTC empieza y termina el día local, y pasar
 * ese rango a SQL como una simple comparación de textos.
 */

// Una sola zona para todo el despliegue: todos los negocios están en Cuba.
// Si algún día hay tiendas en husos distintos, esto pasa a ser una columna de
// users y el resto del archivo no cambia.
const TIME_ZONE = process.env.SHOP_TIMEZONE || 'America/Havana';

const pad = (n) => String(n).padStart(2, '0');

// 'YYYY-MM-DD HH:MM:SS' en UTC — exactamente el formato en que SQLite guarda
// created_at, para poder compararlos como texto.
const toSqlUtc = (date) =>
  `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
  `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;

// Desfase de la zona respecto a UTC en un instante dado, en milisegundos.
// Se obtiene formateando el instante en esa zona y releyendo el resultado como
// si fuera UTC: la diferencia entre ambos ES el desfase.
function zoneOffsetMs(instant, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const { type, value } of dtf.formatToParts(instant)) p[type] = value;

  const asIfUtc = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour), Number(p.minute), Number(p.second)
  );
  return asIfUtc - instant.getTime();
}

/**
 * Instante UTC en que empieza el día local indicado.
 *
 * Se aproxima dos veces a propósito: el desfase depende del instante, y el
 * instante es justo lo que estamos buscando. La primera pasada usa el desfase
 * de la medianoche UTC; la segunda lo recalcula ya cerca de la respuesta, que
 * es lo que hace correcta la frontera en los días de cambio de horario (en
 * Cuba el cambio ocurre precisamente a medianoche).
 *
 * Los desbordamientos de mes/año los normaliza Date.UTC: pedir el día 32 de
 * septiembre devuelve el 2 de octubre, que es justo lo que queremos para
 * calcular el final del día.
 */
function startOfLocalDay(year, month, day, timeZone = TIME_ZONE) {
  const midnightUtc = Date.UTC(year, month - 1, day, 0, 0, 0);

  const offsetA = zoneOffsetMs(new Date(midnightUtc), timeZone);
  const candidateA = midnightUtc - offsetA;
  const offsetB = zoneOffsetMs(new Date(candidateA), timeZone);
  const candidateB = midnightUtc - offsetB;

  // Caso normal: el desfase no cambió entre una pasada y la otra.
  if (offsetA === offsetB) return new Date(candidateB);

  // Hay un cambio de horario justo en la frontera del día. En Cuba el salto de
  // primavera ocurre a las 00:00 locales, o sea que esa medianoche NO EXISTE:
  // el reloj va de 23:59:59 a 01:00:00. Nos quedamos con el instante más
  // tardío, que es el primero que de verdad pertenece al día pedido — si
  // tomáramos el otro, una hora de ventas de la noche anterior se contaría
  // dentro del día siguiente.
  //
  // El salto de otoño (una medianoche que ocurre dos veces) no llega hasta
  // aquí: en ese caso ambas pasadas coinciden y gana la primera ocurrencia,
  // que es la correcta.
  return new Date(Math.max(candidateA, candidateB));
}

/** Fecha de hoy en la zona del negocio, como 'YYYY-MM-DD'. */
function businessToday(timeZone = TIME_ZONE) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/**
 * Rango [start, end) que cubre un día local completo, en formato UTC de SQLite.
 * Semiabierto a propósito: una venta registrada exactamente en la medianoche
 * pertenece al día que empieza, no al que termina, y ningún instante cae en
 * dos días a la vez.
 */
function boundsForDate(dateStr, timeZone = TIME_ZONE) {
  const [year, month, day] = String(dateStr).split('-').map(Number);
  if (!year || !month || !day) throw new Error(`Fecha inválida: ${dateStr}`);
  return {
    start: toSqlUtc(startOfLocalDay(year, month, day, timeZone)),
    end:   toSqlUtc(startOfLocalDay(year, month, day + 1, timeZone)),
  };
}

/** Rango del día de hoy del negocio. */
function todayBounds(timeZone = TIME_ZONE) {
  const date = businessToday(timeZone);
  return { date, ...boundsForDate(date, timeZone) };
}

const LABEL_FORMAT = new Intl.DateTimeFormat('es-ES', {
  timeZone: TIME_ZONE,
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
});

// Ya trae zona: termina en Z o en un desplazamiento tipo +05:00.
const HAS_ZONE = /(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Convierte lo que haya guardado en la columna a un instante real.
 *
 * Casi todas las filas son 'YYYY-MM-DD HH:MM:SS' (lo que escribe datetime('now'),
 * siempre UTC), pero hay filas viejas y datos de demostración con la 'T' de ISO
 * o con la Z ya puesta. Sin esto, un texto con 'T' y sin zona lo interpretaba
 * JavaScript como hora LOCAL y la misma venta salía con una hora en el Excel y
 * otra distinta en la pantalla; y a un texto que ya terminaba en Z se le pegaba
 * una segunda Z, con lo que la fila quedaba fuera del reporte.
 */
function instantFrom(stored) {
  if (!stored) return null;
  const text = String(stored).trim().replace(' ', 'T');
  const instant = new Date(HAS_ZONE.test(text) ? text : `${text}Z`);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

/**
 * Un instante UTC expresado en HORA DE LA TIENDA, listo para mostrar.
 *
 * Lo formatea el servidor a propósito, en vez de mandar el timestamp crudo y
 * que cada cliente lo resuelva: la zona relevante es la del negocio, no la del
 * dispositivo. El dueño que está de viaje quiere leer "cerró a las 9:15 pm"
 * en hora de su tienda, no traducido al huso donde él se encuentre.
 */
function shopLocalLabel(sqlUtc) {
  const instant = instantFrom(sqlUtc);
  return instant ? LABEL_FORMAT.format(instant) : null;
}

const DATE_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});
const TIME_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE, hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
});

/**
 * A qué día local (hora de la tienda) pertenece un instante guardado en UTC.
 *
 * Es la mitad "lectura" de boundsForDate: boundsForDate contesta "¿qué rango
 * UTC cubre el día X?" y esta contesta la pregunta inversa, "¿de qué día es
 * esta fila?" — la que necesita agrupar ventas y cierres por día para el
 * histórico mensual, en vez de filtrar un solo día a la vez.
 */
function shopLocalDate(sqlUtc, timeZone = TIME_ZONE) {
  const instant = instantFrom(sqlUtc);
  if (!instant) return null;
  const dtf = timeZone === TIME_ZONE ? DATE_FORMAT : new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return dtf.format(instant);
}

/** Solo la hora ('HH:MM') de un instante UTC, en hora de la tienda — para columnas
 * de Excel donde la fecha y la hora van separadas en vez de en una sola etiqueta. */
function shopLocalTime(sqlUtc, timeZone = TIME_ZONE) {
  const instant = instantFrom(sqlUtc);
  if (!instant) return null;
  const dtf = timeZone === TIME_ZONE ? TIME_FORMAT : new Intl.DateTimeFormat('en-GB', {
    timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
  });
  return dtf.format(instant);
}

/** Mes de hoy en la zona del negocio, como 'YYYY-MM'. */
function businessCurrentMonth(timeZone = TIME_ZONE) {
  return businessToday(timeZone).slice(0, 7);
}

/**
 * Rango [start, end) que cubre un MES local completo, en formato UTC de SQLite.
 * Construido sobre boundsForDate, igual que un día: el inicio es la frontera
 * del día 1, el fin la frontera del día 1 del mes siguiente. Date.UTC ya
 * normaliza diciembre -> enero del año siguiente, así que no hay que tratar
 * ese caso aparte.
 *
 * Lanza si el mes no tiene forma 'YYYY-MM' o el mes no está entre 01 y 12 —
 * las rutas de /api/reports capturan eso y responden 400.
 */
function monthBounds(monthStr, timeZone = TIME_ZONE) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(monthStr || '').trim());
  if (!m) throw new Error(`Mes inválido: ${monthStr}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error(`Mes inválido: ${monthStr}`);

  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear  = month === 12 ? year + 1 : year;

  return {
    month: `${m[1]}-${m[2]}`,
    start: boundsForDate(`${m[1]}-${m[2]}-01`, timeZone).start,
    end:   boundsForDate(`${nextYear}-${pad(nextMonth)}-01`, timeZone).start,
  };
}

module.exports = {
  TIME_ZONE, todayBounds, boundsForDate, businessToday, toSqlUtc, startOfLocalDay, shopLocalLabel,
  shopLocalDate, shopLocalTime, businessCurrentMonth, monthBounds,
};
