// DE RESERVA (0121, 25-oct-2026): lo que va a la base, lo que lee el tablero,
// lo que ve el conductor y que la reserva no suma desembarque.
//
// Pedido de la profa (3 audios): «¿Vas en vuelo o de reserva?»; de reserva no
// se pide vuelo, se elige Río Verde, Movich o Aero y la hora del regreso es
// «¿A qué hora finaliza tu asignación?». Las pantallas del tripulante las
// cubren _smoke-rx-pedir-dom, _smoke-flujo-0915-dom y _smoke-rx-viaje-dom; el
// mensaje del WhatsApp, _smoke-whatsapp-dom; la base, _aplicar-0121.mjs.
//
//   cd rendio-backend && node scripts/_smoke-reserva-0121-dom.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d = '') => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d ? ' → ' + d : '')); } };

const manana = new Date(Date.now() + 86400e3).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
const at = (hm) => `${manana}T${hm}:00-05:00`;
const AUX = (name) => ({ profiles: { id: 'u-' + name, full_name: name, phone: '3001112233' } });

// ── Una base falsa (mismo patrón que _smoke-madrugada-1020-dom) ──────────────
function baseFalsa(tablas, inserts) {
  const val = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? Date.parse(v) : v);
  return {
    from(name) {
      const ops = []; let one = null; let ins = null;
      const bld = {
        select() { return bld; }, eq(c, v) { ops.push(['eq', c, v]); return bld; }, gte(c, v) { ops.push(['gte', c, v]); return bld; },
        lte(c, v) { ops.push(['lte', c, v]); return bld; }, lt(c, v) { ops.push(['lt', c, v]); return bld; }, in(c, v) { ops.push(['in', c, v]); return bld; },
        is(c, v) { ops.push(['is', c, v]); return bld; }, order(c) { ops.push(['order', c]); return bld; }, limit() { return bld; },
        neq() { return bld; }, not() { return bld; }, or() { return bld; },
        maybeSingle() { one = 'maybe'; return bld; }, single() { one = 'single'; return bld; },
        insert(row) { ins = row; return bld; },
        then(ok2, ko) {
          if (ins) { inserts.push({ tabla: name, row: ins }); return Promise.resolve({ data: { id: 'nueva-' + inserts.length }, error: null }).then(ok2, ko); }
          let rows = (tablas[name] || []).slice();
          for (const [op, c, v] of ops) {
            if (op === 'eq') rows = rows.filter((r) => r[c] === v);
            else if (op === 'gte') rows = rows.filter((r) => r[c] == null || val(r[c]) >= val(v));
            else if (op === 'lte') rows = rows.filter((r) => val(r[c]) <= val(v));
            else if (op === 'lt') rows = rows.filter((r) => val(r[c]) < val(v));
            else if (op === 'in') rows = rows.filter((r) => v.includes(r[c]));
            else if (op === 'is') rows = rows.filter((r) => (r[c] ?? null) === v);
            else if (op === 'order') rows.sort((a, z) => (val(a[c]) > val(z[c]) ? 1 : -1));
          }
          return Promise.resolve({ data: JSON.parse(JSON.stringify(one ? (rows[0] || null) : rows)), error: null }).then(ok2, ko);
        },
      };
      return bld;
    },
    rpc: async () => ({ data: null, error: null }),
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }), getSession: async () => ({ data: { session: null } }) },
  };
}

const R = {
  karol: { id: 'res-karol', direction: 'airport_to_home', pickup_address: 'Olivar, Rionegro', pickup_latitude: 6.15, pickup_longitude: -75.37,
    required_arrival_at: at('18:30'), status_a2h: 'scheduled', notes: null, is_overnight: false, is_firm: true, ground_ops: false, reserve_place: 'movich',
    auxiliar_profiles: AUX('Karol Londoño'), flights: null, residences: { name: 'Olivar', zona_jefe: null, sector: '' }, residence_id: null },
  juan: { id: 'res-juan', direction: 'airport_to_home', pickup_address: 'Cerezos, Rionegro', pickup_latitude: 6.14, pickup_longitude: -75.38,
    required_arrival_at: at('18:20'), status_a2h: 'scheduled', notes: 'Vuelo AV9412.', is_overnight: true, is_firm: true, ground_ops: false, reserve_place: null,
    auxiliar_profiles: AUX('Juan Martínez'), flights: null, residences: { name: 'Cerezos', zona_jefe: null, sector: '' }, residence_id: null },
  lesmes: { id: 'res-lesmes', direction: 'airport_to_home', pickup_address: 'Terra, Rionegro', pickup_latitude: 6.13, pickup_longitude: -75.39,
    required_arrival_at: at('16:00'), status_a2h: 'scheduled', notes: null, is_overnight: false, is_firm: true, ground_ops: false, reserve_place: 'aero',
    auxiliar_profiles: AUX('Lesmes'), flights: null, residences: { name: 'Terra', zona_jefe: null, sector: '' }, residence_id: null },
};
const tablas = {
  auxiliar_profiles: [{ id: 'ap1', profile_id: 'u1' }],
  driver_profiles: [{ id: 'dp1', profile_id: 'u1' }],
  app_settings: [{ id: 'singleton', route_cars_count: 2, route_night_cutoff_min: 120 }],
  vehicles: [{ id: 'veh-1', internal_code: 'RD-01', license_plate: 'ABC123', capacity: 4, is_active: true }],
  reservations: [R.karol, R.juan, R.lesmes],
  route_assignments: [{ id: 'ra-1', direction: 'airport_to_home', planned_start_at: at('18:35'), status: 'planned', driver_profile_id: 'dp1',
    route_stops: [{ stop_order: 1, reservation_id: R.karol.id, status: 'pending', actual_arrival_at: null, estimated_arrival_at: null, reservations: R.karol },
      { stop_order: 2, reservation_id: R.juan.id, status: 'pending', actual_arrival_at: null, estimated_arrival_at: null, reservations: R.juan }] }],
};

console.log('\n── A · api.js: los tres lugares, lo que se guarda y lo que se lee ──');
const inserts = [];
{
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = dom.window;
  w.sb = baseFalsa(tablas, inserts);
  w.RENDIO_CONFIG = {};
  w.eval(read('api.js'));
  const A = w.Api;
  const L = A.reservePlaces();
  t('tres lugares en orden: Río Verde, Movich, Aeropuerto', L.map((x) => x.key).join() === 'rio_verde,movich,aero' && L.map((x) => x.short).join() === 'Río Verde,Movich,Aeropuerto');
  t('las coordenadas que dio la profa (Movich y Río Verde)', A.reservePlace('movich').lat === 6.1726933265356125 && A.reservePlace('movich').lng === -75.43533347469526
    && A.reservePlace('rio_verde').lat === 6.156991101546355 && A.reservePlace('rio_verde').lng === -75.4355739305156);
  t('solo los hoteles son hotel; una llave desconocida no existe', A.reservePlace('rio_verde').hotel && A.reservePlace('movich').hotel && !A.reservePlace('aero').hotel && A.reservePlace('hilton') === null);

  await A.createReservation({ type: 'lle', date: manana, time: '18:30', address: 'Olivar', lat: 6.15, lng: -75.37, flight: 'AV9412', isPernocta: true, reservePlace: 'movich', notes: 'Portería 2' });
  const r1 = inserts[0] && inserts[0].row;
  t('crear de reserva: reserve_place = movich, sin «Vuelo …» en las notas, sin pernocta, is_firm true',
    r1 && r1.reserve_place === 'movich' && r1.notes === 'Portería 2' && r1.is_overnight === false && r1.is_firm === true, JSON.stringify(r1));
  await A.createReservation({ type: 'lle', date: manana, time: '18:30', address: 'Olivar', lat: 6.15, lng: -75.37, flight: 'AV9412', reservePlace: 'hilton' });
  const r2 = inserts[1] && inserts[1].row;
  t('una llave desconocida no viaja: es un vuelo de siempre', r2 && !('reserve_place' in r2) && /^Vuelo AV9412\./.test(r2.notes || ''), JSON.stringify(r2));
  await A.createReservation({ type: 'sal', date: manana, time: '05:10', address: 'Olivar', lat: 6.15, lng: -75.37, groundOps: true, reservePlace: 'movich' });
  const r3 = inserts[2] && inserts[2].row;
  t('en tierra nunca va de reserva', r3 && r3.ground_ops === true && !('reserve_place' in r3), JSON.stringify(r3));

  const vs = await A.listMyVueltasForDriver('u1');
  const st = vs && vs[0] && vs[0].legs.filter((x) => x.reservationId);
  t('conductor: la parada de Karol trae reserva = movich y sin vuelo', st && st[0].reserva === 'movich' && st[0].flight === '', JSON.stringify(st && st[0] && { r: st[0].reserva, f: st[0].flight }));
  t('… y la de Juan (vuelo) sigue con su vuelo y sin reserva', st && st[1].reserva === null && st[1].flight === 'AV9412');

  const plan = await A.listRoutePlanning('lle', manana);
  const aux = (plan && plan.aux) || {};
  const de = (id) => Object.values(aux).find((a) => a.reservationId === id) || {};
  t('tablero: la reserva en Movich es hotel, sin vuelo y sin desembarque (tierra = true)', de(R.karol.id).reserva === 'movich' && de(R.karol.id).hotel === true && de(R.karol.id).vuelo === '' && de(R.karol.id).tierra === true, JSON.stringify(de(R.karol.id)));
  t('tablero: la PERNOCTA ya no pinta «Hotel» (bug del 25-oct)', de(R.juan.id).hotel === false && de(R.juan.id).pernocta === true && de(R.juan.id).vuelo === 'AV9412');
  t('tablero: la reserva en el aeropuerto no es hotel, pero tampoco suma desembarque', de(R.lesmes.id).reserva === 'aero' && de(R.lesmes.id).hotel === false && de(R.lesmes.id).tierra === true);
}

console.log('\n── B · el conductor lo ve en la parada ──');
{
  const dr = read('driver-rutas.js');
  const i = dr.indexOf('  function reservaTxt(st) {'); const j = dr.indexOf('\n  }\n', i);
  const Api = { reservePlace: (k) => ({ movich: { name: 'Hotel Movich', hotel: true }, aero: { name: 'Aeropuerto JMC', hotel: false } })[k] || null };
  const fn = new Function('window', 'Api', 'first', dr.slice(i, j + 4) + '\nreturn reservaTxt;')({ Api }, Api, (n) => String(n || '').trim().split(/\s+/)[0]);
  t('llegada desde el Movich: «Recoges a Karol en el Hotel Movich, no en el aeropuerto»', fn({ name: 'Karol Londoño', kind: 'dropoff', reserva: 'movich' }) === 'Recoges a Karol en el Hotel Movich, no en el aeropuerto');
  t('salida al Movich: «Dejas a Dayana en el Hotel Movich, no en el aeropuerto»', fn({ name: 'Dayana Vargas', kind: 'pickup', reserva: 'movich' }) === 'Dejas a Dayana en el Hotel Movich, no en el aeropuerto');
  t('reserva en el aeropuerto: «Recoges a Lesmes en el aeropuerto, sin vuelo»', fn({ name: 'Lesmes', kind: 'dropoff', reserva: 'aero' }) === 'Recoges a Lesmes en el aeropuerto, sin vuelo');
  t('en vuelo no dice nada', fn({ name: 'Juan', kind: 'dropoff', reserva: null }) === '');
  t('el bloque de información y el chip de la parada lo usan', /const res = reservaTxt\(st\);/.test(dr) && /st\.reserva && window\.Api && Api\.reservePlace/.test(dr));
}

console.log('\n── C · el tablero: la reserva no suma desembarque ──');
{
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://localhost/' });
  const w = dom.window;
  const CONSOLA = read('admin-consola.js');
  const helpers = CONSOLA.slice(0, CONSOLA.indexOf('  // ---------------- CONSOLA'));
  w.eval(`var state = { settings: {} };\nconst Api = window.__ApiStub = {};\nconst $ = (s) => document.querySelector(s);\nconst $$ = (s) => document.querySelectorAll(s);\nfunction toast() {}\n`
    + helpers + '\n' + read('admin-rutas.js') + '\n;window.__rt = rt;');
  const rt = w.__rt;
  rt.aux = {
    v: { n: 'Juan', type: 'lle', dl: '18:00', vuelo: 'AV9412', tierra: false, reserva: null },
    r: { n: 'Karol', type: 'lle', dl: '18:00', vuelo: '', tierra: true, reserva: 'movich' },
  };
  const conVuelo = w.rtDeplaneOf(['v'], 18 * 60);
  const reserva = w.rtDeplaneOf(['r'], 18 * 60);
  t('un vuelo suma desembarque; la reserva sola, cero', conVuelo > 0 && reserva === 0, JSON.stringify({ conVuelo, reserva }));
  w.__ApiStub.reservePlace = (k) => ({ movich: { name: 'Hotel Movich', short: 'Movich', hotel: true } })[k] || null;
  t('la tarjeta dice «Movich», no «Tierra»', /Movich/.test(w.rtAuxCard('r')) && !/>Tierra</.test(w.rtAuxCard('r')));
}

console.log(`\n${ok}/${ok + bad} pasaron${bad ? ' · ' + bad + ' FALLARON' : ''}`);
console.log('NO cubierto: el optimizador NO rutea al hotel (lo trata como JMC: está a 1–2 km); la base real (eso es _aplicar-0121.mjs); el layout (jsdom).');
process.exit(bad ? 1 : 0);
