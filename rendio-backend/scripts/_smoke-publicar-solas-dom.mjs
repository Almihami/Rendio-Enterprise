// Publicar el tablero con gente que estaba en una vuelta «para tomar» que armó el
// sistema (28-oct-2026) — prueba con api.js DE VERDAD y un `sb` FALSO.
//
// Camilo (2:08 p. m., captura del conductor): «aparecen servicios a tomar a pesar
// de que en admin ya están asignados y finalizados». Margy («Quedó para tomar sola:
// el vuelo llegó tarde…»), Lina y Kriss («Creada sola: pidió con el día publicado»)
// seguían en «Vueltas para tomar» porque Publicar SALTABA a quien iba en una de esas
// vueltas (enPool): el jefe la veía en su carro y la base la dejaba en la para tomar.
//
// Comprueba en saveRoutePlan:
//   · quien el jefe puso en una vuelta del tablero SALE de la para tomar del sistema
//     (se borra su parada) y entra a la vuelta nueva;
//   · si la para tomar queda vacía, se borra (solo si sigue sin tomar: pool +
//     auto_created + sin conductor + planned); si le queda otro (un sin cuenta), no;
//   · la que ya TOMÓ un conductor, o la que arrancó, no se toca (como antes);
//   · quien está en una para tomar y NO va en el tablero se queda donde está;
//   · las pegadas viejas (pool sin auto_created) se siguen saltando;
//   · si la base no deja borrar la parada, la persona NO entra a la vuelta nueva
//     (nunca en las dos).
//
// NO cubre: la base real (RLS, FKs, el orden real de las consultas en PostgREST) ni
// la app del conductor; la lista que ve el conductor es driver_open_routes (0138).
//
//   cd rendio-backend && node scripts/_smoke-publicar-solas-dom.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null && d !== '' ? ' → ' + d : '')); } };

// La base falsa: el plan que lee saveRoutePlan y lo que escribe.
function fakeSb(DB) {
  const log = { deletes: [], inserts: { route_assignments: [], route_stops: [] }, seq: [] };
  let n = 0;
  const sb = {
    log,
    from(table) {
      let op = 'select', row = null, single = false;
      const filtros = [];
      const b = {
        select() { return b; }, single() { single = true; return b; }, maybeSingle() { single = true; return b; },
        order() { return b; }, limit() { return b; },
        insert(r) { op = 'insert'; row = r; return b; },
        delete() { op = 'delete'; return b; },
        update(r) { op = 'update'; row = r; return b; },
      };
      ['eq', 'in', 'is', 'not', 'or', 'gte', 'lte', 'lt', 'gt', 'neq'].forEach((f) => { b[f] = (...a) => { filtros.push([f, ...a]); return b; }; });
      b.then = (res, rej) => {
        let out = { data: null, error: null };
        log.seq.push(op + ':' + table + (op === 'delete' ? ':' + (((filtros.find((x) => x[0] === 'in' && x[1] === 'id') || [])[2]) || []).join('|') : ''));
        if (op === 'delete') {
          const ids = (filtros.find((x) => x[0] === 'in' && x[1] === 'id') || [])[2] || null;
          log.deletes.push({ table, ids, filtros });
          if (table === 'route_stops' && DB.falloBorrarParada && ids && ids.some((i) => DB.falloBorrarParada.includes(i))) out = { data: null, error: { message: 'no deja' } };
        } else if (op === 'insert') {
          if (table === 'route_assignments') { const id = 'nueva-' + (++n); log.inserts.route_assignments.push(Object.assign({ id }, row)); out = { data: single ? { id } : [{ id }], error: null }; }
          else { log.inserts[table] = (log.inserts[table] || []).concat(row); }
        } else if (table === 'route_assignments') out = { data: JSON.parse(JSON.stringify(DB.plan)), error: null };
        else if (table === 'driver_profiles') out = { data: [{ id: 'dp-daniel', profile_id: 'p-daniel' }, { id: 'dp-juan', profile_id: 'p-juan' }], error: null };
        else out = { data: [], error: null };
        return Promise.resolve(out).then(res, rej);
      };
      return b;
    },
    rpc: async () => ({ data: null, error: null }),
    auth: { getSession: async () => ({ data: { session: null } }), getUser: async () => ({ data: { user: null } }) },
  };
  return sb;
}
function boot(DB) {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = dom.window;
  const errors = [];
  w.addEventListener('error', (e) => errors.push(e.message));
  w.console.error = (...a) => errors.push(a.map(String).join(' '));
  w.console.warn = () => {};
  w.RENDIO_CONFIG = {};
  w.sb = fakeSb(DB);
  w.eval('var state = { profile: { id: "jefe", role: "admin", organization_id: "org1" }, settings: {} };');
  w.eval(read('api.js'));
  return { w, errors, sb: w.sb };
}

const DIA = '2026-10-28';
const pend = (id, rid, extra) => Object.assign({ id, reservation_id: rid, status: 'pending', estimated_arrival_at: null }, extra || {});
// La para tomar que armó el sistema (sin tomar): Lina sola.
const solaLina = { id: 'ra-lina', status: 'planned', direction: 'home_to_airport', planned_start_at: DIA + 'T19:40:00Z', driver_profile_id: null,
  pool: true, para_tomar: false, auto_created: true, delegated_at: null, delegate_name: null, driver_profiles: null, route_stops: [pend('st-lina', 'res-lina')] };
// Margy y un sin cuenta en la misma para tomar.
const solaMargy = { id: 'ra-margy', status: 'planned', direction: 'airport_to_home', planned_start_at: DIA + 'T18:15:00Z', driver_profile_id: null,
  pool: true, para_tomar: false, auto_created: true, delegated_at: null, delegate_name: null, driver_profiles: null,
  route_stops: [pend('st-margy', 'res-margy'), pend('st-guest', null)] };
// Kriss: ya la TOMÓ Juan.
const tomadaKriss = { id: 'ra-kriss', status: 'planned', direction: 'airport_to_home', planned_start_at: DIA + 'T21:20:00Z', driver_profile_id: 'dp-juan',
  pool: true, para_tomar: false, auto_created: true, delegated_at: null, delegate_name: null, driver_profiles: { profile_id: 'p-juan' }, route_stops: [pend('st-kriss', 'res-kriss')] };
// Una pegada vieja de Julián (pool sin auto_created).
const pegadaSara = { id: 'ra-sara', status: 'planned', direction: 'home_to_airport', planned_start_at: DIA + 'T11:00:00Z', driver_profile_id: null,
  pool: true, para_tomar: false, auto_created: false, delegated_at: null, delegate_name: null, driver_profiles: null, route_stops: [pend('st-sara', 'res-sara')] };
// Otro en una para tomar del sistema que el jefe NO puso en el tablero.
const solaPedro = { id: 'ra-pedro', status: 'planned', direction: 'home_to_airport', planned_start_at: DIA + 'T23:00:00Z', driver_profile_id: null,
  pool: true, para_tomar: false, auto_created: true, delegated_at: null, delegate_name: null, driver_profiles: null, route_stops: [pend('st-pedro', 'res-pedro')] };
const plan = () => [solaLina, solaMargy, tomadaKriss, pegadaSara, solaPedro];
const lane = (laneId, drv, type, startAt, stops) => ({ laneId, driverProfileId: drv, type, startAt, stops, vehicleId: null, planCar: 'Carro 1' });
const LANES = [
  lane('C1·V1', 'p-daniel', 'sal', DIA + 'T19:30:00Z', ['res-lina', 'res-sara', 'res-ana']),
  lane('C2·V1', 'p-daniel', 'lle', DIA + 'T18:20:00Z', ['res-margy', 'res-kriss']),
];
const borradoDe = (log, table) => log.deletes.filter((d) => d.table === table && d.ids).flatMap((d) => d.ids);
const paradasNuevas = (log) => log.inserts.route_stops.map((s) => s.reservation_id).filter(Boolean);

console.log('\n── El jefe puso a Lina y a Margy en vueltas del tablero ──');
{
  const B = boot({ plan: plan() });
  const r = await B.w.Api.saveRoutePlan(DIA, LANES);
  const L = B.sb.log;
  t('publica sin errores', r && r.failed === 0 && B.errors.length === 0, JSON.stringify(r) + ' ' + B.errors.join(' | '));
  t('se borra la parada de Lina y la de Margy de sus para tomar', ['st-lina', 'st-margy'].every((x) => borradoDe(L, 'route_stops').includes(x)), borradoDe(L, 'route_stops').join(','));
  t('…y ninguna otra parada (ni el sin cuenta, ni Kriss, ni Pedro)', !['st-guest', 'st-kriss', 'st-pedro', 'st-sara'].some((x) => borradoDe(L, 'route_stops').includes(x)));
  const delRa = L.deletes.filter((d) => d.table === 'route_assignments' && d.ids);
  t('la para tomar de Lina, que quedó vacía, se borra (y la de Margy no: le queda el sin cuenta)', delRa.some((d) => d.ids.includes('ra-lina')) && !delRa.some((d) => d.ids.includes('ra-margy')), JSON.stringify(delRa.map((d) => d.ids)));
  const borrarSola = delRa.find((d) => d.ids.includes('ra-lina'));
  const f = (k, v) => borrarSola && borrarSola.filtros.some((x) => x[0] === k && x[1] === v[0] && (v.length < 2 || x[2] === v[1]));
  t('…solo si sigue sin tomar (pool + auto_created + sin conductor + planned)', f('eq', ['pool', true]) && f('eq', ['auto_created', true]) && f('is', ['driver_profile_id', null]) && f('eq', ['status', 'planned']),
    borrarSola && JSON.stringify(borrarSola.filtros));
  t('nunca se borran las vueltas de Kriss (tomada), Pedro (no está en el tablero) ni la pegada de Sara', !delRa.some((d) => d.ids.some((i) => ['ra-kriss', 'ra-pedro', 'ra-sara'].includes(i))));
  const nuevas = paradasNuevas(L);
  t('Lina y Margy entran a sus vueltas nuevas', nuevas.includes('res-lina') && nuevas.includes('res-margy'), nuevas.join(','));
  t('Kriss (la tomó Juan) y Sara (pegada) se siguen saltando', !nuevas.includes('res-kriss') && !nuevas.includes('res-sara'), nuevas.join(','));
  t('Ana (sin vuelta antes) entra como siempre', nuevas.includes('res-ana'));
  t('a Lina y a Margy se les avisa su conductor (antes no tenían)', ['res-lina', 'res-margy'].every((x) => (r.notify || []).some((n) => n.reservationId === x && n.driverProfileId === 'p-daniel')), JSON.stringify(r.notify));
  const iBorra = L.seq.findIndex((x) => x.startsWith('delete:route_stops:') && x.includes('st-lina'));
  const iCrea = L.seq.findIndex((x) => x === 'insert:route_assignments');
  t('las paradas se sacan de la para tomar ANTES de crear las vueltas nuevas', iBorra >= 0 && iCrea > iBorra, L.seq.join(' → '));
}

console.log('\n── Si la base no deja sacar a alguien de la para tomar ──');
{
  const B = boot({ plan: plan(), falloBorrarParada: ['st-lina'] });
  const r = await B.w.Api.saveRoutePlan(DIA, LANES);
  const nuevas = paradasNuevas(B.sb.log);
  t('Lina NO entra a la vuelta nueva (se queda en la para tomar: nunca en las dos)', !nuevas.includes('res-lina') && !nuevas.includes('res-margy'), nuevas.join(','));
  t('…ni se borra ninguna para tomar', !B.sb.log.deletes.some((d) => d.table === 'route_assignments' && d.ids && d.ids.some((i) => ['ra-lina', 'ra-margy'].includes(i))));
  t('el resto se publica igual', r && r.saved >= 1 && nuevas.includes('res-ana'), JSON.stringify(r));
}

console.log('\n── Nadie de una para tomar en el tablero ──');
{
  const B = boot({ plan: plan() });
  await B.w.Api.saveRoutePlan(DIA, [lane('C1·V1', 'p-daniel', 'sal', DIA + 'T19:30:00Z', ['res-ana'])]);
  t('no se toca ninguna parada de las para tomar', borradoDe(B.sb.log, 'route_stops').length === 0, borradoDe(B.sb.log, 'route_stops').join(','));
}

console.log('\n── La para tomar que ya arrancó ──');
{
  const arr = JSON.parse(JSON.stringify(solaLina)); arr.route_stops = [pend('st-lina', 'res-lina', { status: 'arrived' })];
  const B = boot({ plan: [arr] });
  await B.w.Api.saveRoutePlan(DIA, [LANES[0]]);
  t('no se le quita a nadie (y Lina no se duplica)', borradoDe(B.sb.log, 'route_stops').length === 0 && !paradasNuevas(B.sb.log).includes('res-lina'), paradasNuevas(B.sb.log).join(','));
}

console.log(`\n${ok} ✓ · ${bad} ✗`);
console.log('NO cubierto: la base real (RLS, FKs) ni driver_open_routes; el tablero y el pegado están en _smoke-rutas-v2-dom / _smoke-ruta-julian-dom.');
process.exit(bad ? 1 : 0);
