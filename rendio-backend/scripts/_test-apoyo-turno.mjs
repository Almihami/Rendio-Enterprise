// 0163 · El apoyo del lado del conductor (driver-apoyo-turno.js + driver-gps-turno.js).
//   node rendio-backend/scripts/_test-apoyo-turno.mjs
// Cubre: qué turno es «ahora» en Bogotá, cuándo el apoyo es suyo, qué dice la
// tarjeta y que la ubicación se manda sin turno abierto solo mientras lo tiene.
// NO cubre: el GPS real del teléfono, el layout de la tarjeta ni el push.
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const lee = (f) => readFileSync(new URL('../../rendio-turnos/' + f, import.meta.url), 'utf8');
let ok = 0, mal = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { mal++; console.log('  ✗ ' + n + (d !== undefined ? ' → ' + JSON.stringify(d) : '')); } };

function mundo({ rol = 'driver', turno = null } = {}) {
  const box = { innerHTML: '' }; const enviados = [];
  const w = {
    document: { getElementById: (id) => (id === 'driver-home-apoyo' ? box : null), addEventListener() {}, visibilityState: 'visible' },
    setInterval() { return 0; }, navigator: {}, console, Intl, Date, Promise, isFinite, Number, String, Array,
    state: { profile: { role: rol } }, sf: turno ? { activeShift: turno } : undefined,
    Api: { mySupportDuty: async () => w._filas, sendDriverLocation: async (id, la, lo) => { enviados.push({ id, la, lo }); } }, _filas: [],
  };
  w.window = w; vm.createContext(w);
  vm.runInContext(lee('driver-gps-turno.js'), w); vm.runInContext(lee('driver-apoyo-turno.js'), w);
  return { w, box, enviados };
}
const bog = (s) => new Date(s + '-05:00');   // hora de Bogotá

console.log('\n== El apoyo del lado del conductor ==');
{
  const { w } = mundo(); const R = w.RendioApoyo;
  const td = (s) => { const x = R._turnoDe(R._bogota(bog(s))); return x.day + ' ' + x.band; };
  t('10:00 es el turno de la mañana de hoy', td('2026-11-16T10:00') === '2026-11-16 am', td('2026-11-16T10:00'));
  t('14:00 ya es el de la tarde', td('2026-11-16T14:00') === '2026-11-16 pm', td('2026-11-16T14:00'));
  t('0:30 sigue siendo el de la tarde de AYER', td('2026-11-16T00:30') === '2026-11-15 pm', td('2026-11-16T00:30'));
  t('2:00 a. m. arranca el de la mañana', td('2026-11-16T02:00') === '2026-11-16 am', td('2026-11-16T02:00'));
}
{
  const { w, box } = mundo(); const R = w.RendioApoyo;
  w._filas = [{ day: '2026-11-16', band: 'pm', driver_profile_id: 'dp-1' }];
  await R.render(true);
  t('en la mañana todavía NO es suyo', R.activo(bog('2026-11-16T10:00')) === false);
  t('…y la tarjeta dice desde cuándo', (R._texto(bog('2026-11-16T10:00')) || {}).sub === 'Hoy desde las 2:00 p. m.', R._texto(bog('2026-11-16T10:00')));
  t('a las 3 p. m. ya es suyo', R.activo(bog('2026-11-16T15:00')) === true && R.conductor(bog('2026-11-16T15:00')) === 'dp-1');
  t('…y dice hasta cuándo', (R._texto(bog('2026-11-16T15:00')) || {}).sub === 'Ahora · hasta las 2:00 a. m.', R._texto(bog('2026-11-16T15:00')));
  t('a la 1 a. m. del día siguiente sigue siendo suyo', R.activo(bog('2026-11-17T01:00')) === true);
  t('a las 3 a. m. ya no, y la tarjeta no sale', R.activo(bog('2026-11-17T03:00')) === false && R._texto(bog('2026-11-17T03:00')) === null);
  w._filas = [{ day: '2026-11-17', band: 'am', driver_profile_id: 'dp-1' }];
  await R.render(true);
  t('el de mañana en la mañana: «Mañana desde las 2:00 a. m.»', (R._texto(bog('2026-11-16T22:00')) || {}).sub === 'Mañana desde las 2:00 a. m.', R._texto(bog('2026-11-16T22:00')));
  t('…pasada la medianoche: «Hoy desde las 2:00 a. m.»', (R._texto(bog('2026-11-17T00:30')) || {}).sub === 'Hoy desde las 2:00 a. m.', R._texto(bog('2026-11-17T00:30')));
  t('la tarjeta se pinta con el título', /Tienes el carro de apoyo/.test(box.innerHTML) || R._texto() === null, box.innerHTML.slice(0, 80));
}
{
  // La ubicación: sin turno y sin apoyo no se manda; con el apoyo de AHORA sí; con turno, la del turno.
  const ahora = new Date(); const { w, enviados } = mundo(); const R = w.RendioApoyo, G = w.RendioGpsTurno;
  t('sin turno ni apoyo: no hay a nombre de quién mandar', G._conductor() === null);
  const tn = R._turnoDe(R._bogota(ahora));
  w._filas = [{ day: tn.day, band: tn.band, driver_profile_id: 'dp-apoyo' }];
  await R.render(true);
  t('con el apoyo de este turno: se manda a su nombre aunque no haya turno abierto', G._conductor() === 'dp-apoyo', G._conductor());
  G._mandar({ latitude: 6.17, longitude: -75.42 }, true);
  t('…y el punto sale', enviados.length === 1 && enviados[0].id === 'dp-apoyo', enviados);
  const c = mundo({ turno: { driver_id: 'dp-turno', end_at: null } });
  c.w._filas = [{ day: tn.day, band: tn.band, driver_profile_id: 'dp-apoyo' }];
  await c.w.RendioApoyo.render(true);
  t('con turno abierto manda la del turno, como antes', c.w.RendioGpsTurno._conductor() === 'dp-turno');
  const j = mundo({ rol: 'admin' });
  j.w._filas = [{ day: tn.day, band: tn.band, driver_profile_id: 'x' }];
  await j.w.RendioApoyo.render(true);
  t('a un jefe no le sale nada', j.box.innerHTML === '' && j.w.RendioApoyo.activo() === false);
}
console.log(`\n${ok}/${ok + mal} pasaron`);
process.exit(mal ? 1 : 0);
