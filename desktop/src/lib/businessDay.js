/**
 * Copia del cálculo de fronteras de día de server/lib/businessDay.js.
 *
 * La duplicación es deliberada: electron-builder solo empaqueta desktop/, así
 * que un require fuera de esta carpeta funcionaría en desarrollo y fallaría en
 * la app instalada. Es la misma razón por la que src/router.js reimplementa la
 * API.
 *
 * Lo que tiene que seguir idéntico es el cálculo de fronteras (zoneOffsetMs,
 * startOfLocalDay, boundsForDate, todayBounds): si el escritorio y el servidor
 * discreparan sobre dónde empieza el día, las mismas ventas caerían en días
 * distintos según desde dónde se miren. Los tests del servidor lo cubren.
 *
 * El servidor tiene además shopLocalLabel, que aquí NO hace falta: sirve para
 * mandarle fechas ya formateadas en hora de la tienda a la app del dueño, y
 * esta caja no le formatea fechas a nadie más que a sí misma.
 *
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

module.exports = { TIME_ZONE, todayBounds, boundsForDate, businessToday, toSqlUtc, startOfLocalDay };
