const test = require('node:test');
const assert = require('node:assert/strict');
const { boundsForDate, startOfLocalDay } = require('../lib/businessDay');

/**
 * "Hoy" tiene que significar el día del dueño en Cuba, no el día UTC. Antes de
 * esto, el dashboard cambiaba de día a las 8:00 pm hora local: a las nueve de
 * la noche el negocio aparecía casi en cero.
 */

const HAVANA = 'America/Havana';

// Reinterpreta un 'YYYY-MM-DD HH:MM:SS' UTC como hora de pared cubana.
const enHoraDeCuba = (sqlUtc) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: HAVANA, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(sqlUtc.replace(' ', 'T') + 'Z'));

const duracionHoras = ({ start, end }) =>
  (new Date(end.replace(' ', 'T') + 'Z') - new Date(start.replace(' ', 'T') + 'Z')) / 3_600_000;

test('día del negocio', async (t) => {
  await t.test('el día empieza a medianoche en Cuba, no en UTC', async () => {
    // Invierno: Cuba está en UTC−5.
    assert.equal(boundsForDate('2026-01-15').start, '2026-01-15 05:00:00');
    // Verano: UTC−4.
    assert.equal(boundsForDate('2026-06-15').start, '2026-06-15 04:00:00');

    for (const fecha of ['2026-01-15', '2026-06-15', '2026-09-10']) {
      assert.equal(enHoraDeCuba(boundsForDate(fecha).start), `${fecha}, 00:00`);
    }
  });

  await t.test('una venta de las 9 de la noche cae en el día correcto', async () => {
    // El caso que rompía el dashboard: 21:00 del 10 de septiembre en Cuba son
    // ya las 01:00 UTC del día 11.
    const ventaUtc = '2026-09-11 01:00:00';
    assert.equal(enHoraDeCuba(ventaUtc), '2026-09-10, 21:00', 'la venta es de la noche del 10 en Cuba');

    const dia10 = boundsForDate('2026-09-10');
    assert.ok(ventaUtc >= dia10.start && ventaUtc < dia10.end, 'debe contarse en el día 10');

    const dia11 = boundsForDate('2026-09-11');
    assert.ok(!(ventaUtc >= dia11.start && ventaUtc < dia11.end), 'y NO en el día 11');
  });

  await t.test('los días de cambio de horario duran 23 y 25 horas', async () => {
    // En Cuba el reloj se adelanta a las 00:00 del segundo domingo de marzo —
    // esa medianoche no existe, así que el día empieza a la 01:00.
    const adelanto = boundsForDate('2026-03-08');
    assert.equal(duracionHoras(adelanto), 23);
    assert.equal(enHoraDeCuba(adelanto.start), '2026-03-08, 01:00');

    // Y se atrasa el primer domingo de noviembre: ese día tiene 25 horas.
    const atraso = boundsForDate('2026-11-01');
    assert.equal(duracionHoras(atraso), 25);
    assert.equal(enHoraDeCuba(atraso.start), '2026-11-01, 00:00');
  });

  await t.test('los días son contiguos todo el año: ninguna venta se pierde ni se cuenta dos veces', async () => {
    let cursor = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 400; i++) {
      const hoy = new Date(cursor).toISOString().slice(0, 10);
      const manana = new Date(cursor + 86_400_000).toISOString().slice(0, 10);
      assert.equal(
        boundsForDate(hoy).end,
        boundsForDate(manana).start,
        `el día ${hoy} debe terminar exactamente donde empieza ${manana}`
      );
      cursor += 86_400_000;
    }
  });

  await t.test('el desbordamiento de mes y de año se normaliza', async () => {
    assert.equal(boundsForDate('2026-01-31').end, boundsForDate('2026-02-01').start);
    assert.equal(boundsForDate('2026-12-31').end, boundsForDate('2027-01-01').start);
    // 29 de febrero de un año bisiesto.
    assert.equal(boundsForDate('2028-02-28').end, boundsForDate('2028-02-29').start);
  });

  await t.test('otra zona horaria da otras fronteras', async () => {
    // La zona es configurable; el resto de la lógica no cambia.
    const madrid = startOfLocalDay(2026, 6, 15, 'Europe/Madrid');
    assert.equal(madrid.toISOString(), '2026-06-14T22:00:00.000Z', 'Madrid en junio es UTC+2');
  });
});
