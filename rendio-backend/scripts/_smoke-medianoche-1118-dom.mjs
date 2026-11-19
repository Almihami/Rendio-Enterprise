// PASADA LA MEDIANOCHE (18-nov-2026) — prueba jsdom.
//
// Caso real: María Camila Cano (AV9242, aterriza 23:20) salía en Asignación como
// «Sin vuelta · No tiene carro» teniendo vuelta a las 00:10: a las 23:11 un jefe le
// había corrido la hora al combo y quedó del día siguiente. El plan se guarda por
// fecha de calendario, así que el tablero de su día no traía la vuelta y el del día
// siguiente la traía sin su gente (el pedido era de ayer). Sin verla, los jefes
// pegaron otras encima: María Camila quedó en tres vueltas.
//
// Comprueba:
//   A) api.js DE VERDAD con un `sb` falso: getPublishedPlan(día) devuelve aparte
//      (`sigue`) las vueltas PUBLICADAS de las 6 h siguientes que llevan a alguien
//      cuyo pedido es de ese día; no las de borrador, ni las que ya tienen día del
//      plan (las pegadas), ni las de gente solo del otro día, ni un pedido cancelado;
//      `vueltas` queda igual que antes.
//   B) Asignación de verdad (index.html + admin-*.js) con el día de prueba:
//      · sin el arreglo de datos (plan sin `sigue`) la persona sale «Sin vuelta»;
//      · con `sigue`: ya no sale «Sin vuelta», no queda en «sin carro», y su vuelta
//        va como fila propia «Sale después de medianoche», en su hora (23:20), con
//        toda su gente y los botones que aplican por id;
//      · la que era del tablero con conductor fijo no ofrece «Cambiar hora»;
//      · el otro lado: la vuelta de las 00:10 de HOY con gente de AYER va como fila
//        «Gente de otro día» (antes no se pintaba), con todos, sin crear carro de más;
//      · la hoja de pegar sigue reconociendo a la persona por su cuenta.
//
// NO cubre: la base real (el filtro de PostgREST, RLS), el layout (jsdom no lo
// hace), ni que los botones guarden en la base (son los mismos de las filas que
// arma el sistema: _smoke-ruta-julian-dom y _smoke-rutas-v2-dom).
//
//   cd rendio-backend && node scripts/_smoke-medianoche-1118-dom.mjs
process.env.TZ = 'America/Bogota';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const FIX = new URL('./fixtures/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null && d !== '' ? ' → ' + d : '')); } };
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── A · api.js: getPublishedPlan trae aparte las de después de medianoche ──');
{
  const DAY = '2026-11-18', SIG = '2026-11-19';
  const iso = (d, hm) => new Date(`${d}T${hm}:00-05:00`).toISOString();
  const stop = (id, rid, dia, hm, nombre, extra = {}) => ({ id, stop_order: 1, status: 'pending', estimated_arrival_at: null, reservation_id: rid, actual_arrival_at: null, actual_dropoff_at: null,
    reservations: rid ? Object.assign({ pickup_address: 'Ruta 39', pickup_latitude: 6.15, pickup_longitude: -75.37, required_arrival_at: iso(dia, hm), residence_id: null, cancelled_at: null,
      auxiliar_profiles: { profiles: { full_name: nombre } } }, extra) : null });
  const ra = (id, dia, hm, stops, extra = {}) => Object.assign({ id, direction: 'airport_to_home', status: 'planned', planned_start_at: `${dia}T${hm}:00-05:00`, driver_profile_id: null, vehicle_id: null,
    plan_car: 'Carro 1', pool: true, para_tomar: true, auto_created: false, manual_day: null, deadline_at: null, manual_note: null, delegated_at: null, delegate_name: null, delegate_phone: null,
    plan_vehicle_id: null, vehicles: null, driver_profiles: null, route_stops: stops }, extra);
  const tablas = {
    route_assignments: [
      ra('ra-hoy', DAY, '23:30', [stop('s0', 'res-h', DAY, '23:10', 'Hoy Temprano')], { pool: false, para_tomar: false }),
      ra('ra-sig1', SIG, '00:10', [stop('s1', 'res-z', DAY, '23:20', 'María Noche')]),
      ra('ra-sig2', SIG, '00:30', [stop('s2', 'res-m', SIG, '00:05', 'Mañana Solo')]),
      ra('ra-sig3', SIG, '00:15', [stop('s3', 'res-b', DAY, '23:40', 'En Borrador')], { status: 'draft' }),
      ra('ra-sig4', SIG, '00:20', [stop('s4', 'res-p', DAY, '23:45', 'Pegada Mañana')], { manual_day: SIG, para_tomar: false }),
      ra('ra-sig5', SIG, '00:25', [stop('s5', 'res-c', DAY, '23:50', 'Cancelada', { cancelled_at: iso(DAY, '22:00') })]),
      ra('ra-sig6', SIG, '07:00', [stop('s6', 'res-l', DAY, '23:55', 'Muy Lejos')]),
      ra('ra-mad', SIG, '00:20', [stop('s7', 'res-j', DAY, '23:58', 'Pegada Hoy')], { manual_day: DAY, para_tomar: false }),
      ra('ra-sig7', SIG, '00:40', [stop('s8', 'res-x', DAY, '23:59', 'Con Conductor')], { pool: false, para_tomar: false, driver_profile_id: 'dp1', driver_profiles: { profile_id: 'd1', profiles: { full_name: 'Juan Ospina' } } }),
    ],
  };
  const val = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? Date.parse(v) : v);
  const log = [];
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = dom.window;
  w.sb = {
    from(name) {
      const qd = { table: name, ops: [] }; log.push(qd); let one = null;
      const bld = {
        select(c) { qd.ops.push(['select', c]); return bld; }, eq(c, v) { qd.ops.push(['eq', c, v]); return bld; },
        gte(c, v) { qd.ops.push(['gte', c, v]); return bld; }, lte(c, v) { qd.ops.push(['lte', c, v]); return bld; }, lt(c, v) { qd.ops.push(['lt', c, v]); return bld; },
        gt(c, v) { qd.ops.push(['gt', c, v]); return bld; }, in(c, v) { qd.ops.push(['in', c, v]); return bld; }, is(c, v) { qd.ops.push(['is', c, v]); return bld; },
        not() { return bld; }, or() { return bld; }, neq() { return bld; },
        order(c, o) { qd.ops.push(['order', c, o || {}]); return bld; }, limit(n) { qd.ops.push(['limit', n]); return bld; },
        maybeSingle() { one = 'maybe'; return bld; }, single() { one = 'single'; return bld; },
        then(ok2, ko) {
          let rows = (tablas[name] || []).slice();
          for (const [op, c, v] of qd.ops) {
            if (op === 'eq') rows = rows.filter((r) => r[c] === v);
            else if (op === 'gte') rows = rows.filter((r) => val(r[c]) >= val(v));
            else if (op === 'lte') rows = rows.filter((r) => val(r[c]) <= val(v));
            else if (op === 'lt') rows = rows.filter((r) => val(r[c]) < val(v));
            else if (op === 'gt') rows = rows.filter((r) => val(r[c]) > val(v));
            else if (op === 'in') rows = rows.filter((r) => v.includes(r[c]));
            else if (op === 'is') rows = rows.filter((r) => (r[c] ?? null) === v);
            else if (op === 'order') rows.sort((a, z) => (val(a[c]) > val(z[c]) ? 1 : -1));
          }
          const data = one ? (rows[0] || null) : rows;
          return Promise.resolve({ data: JSON.parse(JSON.stringify(data)), error: null }).then(ok2, ko);
        },
      };
      return bld;
    },
    rpc: async () => ({ data: null, error: null }),
    auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) },
  };
  w.RENDIO_CONFIG = {};
  const errs = [];
  w.console.error = (...a) => errs.push(a.map(String).join(' '));
  w.eval(read('api.js'));
  const A = w.Api;
  const E = ['draft', 'planned', 'in_progress', 'completed'];
  const p = await A.getPublishedPlan(DAY, { estados: E });
  const ids = (xs) => (xs || []).map((v) => v.id).sort().join(',');
  t('`vueltas` del día queda como antes: la de las 23:30 y la madrugada pegada con este día', ids(p.vueltas) === 'ra-hoy,ra-mad', ids(p.vueltas));
  t('`sigue` trae las publicadas de después de medianoche con gente de este día (para tomar y con conductor)', ids(p.sigue) === 'ra-sig1,ra-sig7', ids(p.sigue));
  const s1 = (p.sigue || []).find((v) => v.id === 'ra-sig1') || {};
  t('…con la forma de siempre: hora, para tomar, su gente con nombre y la hora que pidió', s1.type === 'lle' && s1.paraTomar === true && s1.pool === true && Date.parse(s1.startAt) === Date.parse(iso(SIG, '00:10'))
    && (s1.pendientes || []).length === 1 && s1.pendientes[0].rid === 'res-z' && s1.pendientes[0].name === 'María Noche' && Date.parse(s1.pendientes[0].dueAt) === Date.parse(iso(DAY, '23:20')), JSON.stringify(s1).slice(0, 300));
  const s7 = (p.sigue || []).find((v) => v.id === 'ra-sig7') || {};
  t('…la del tablero con conductor trae su conductor y no es «para tomar»', s7.pool === false && s7.driverProfileId === 'd1' && s7.conductor === 'Juan Ospina', JSON.stringify([s7.pool, s7.driverProfileId, s7.conductor]));
  t('no entra la de gente SOLO del otro día', !(p.sigue || []).some((v) => v.id === 'ra-sig2'));
  t('no entra un borrador (no está publicada)', !(p.sigue || []).some((v) => v.id === 'ra-sig3'));
  t('no entra la que ya tiene día del plan (la pegada de mañana es de mañana)', !(p.sigue || []).some((v) => v.id === 'ra-sig4'));
  t('no entra si el único pedido de hoy está cancelado', !(p.sigue || []).some((v) => v.id === 'ra-sig5'));
  t('no entra la de más de 6 h después (07:00)', !(p.sigue || []).some((v) => v.id === 'ra-sig6'));
  const q = log.filter((x) => x.table === 'route_assignments').find((x) => x.ops.some((o) => o[0] === 'is' && o[1] === 'manual_day'));
  const gt = q && q.ops.find((o) => o[0] === 'gt'), lt = q && q.ops.find((o) => o[0] === 'lt');
  t('la consulta pide: después de las 23:59:59 del día, antes de las 06:00 del siguiente, sin día del plan', !!q && gt[1] === 'planned_start_at' && gt[2] === DAY + 'T23:59:59-05:00'
    && lt[1] === 'planned_start_at' && Date.parse(lt[2]) === Date.parse(iso(SIG, '06:00')) && q.ops.some((o) => o[0] === 'is' && o[2] === null), JSON.stringify([gt, lt]));
  log.length = 0;
  const p2 = await A.getPublishedPlan(DAY, { estados: E, sinSigue: true });
  t('con { sinSigue } no pide ni devuelve nada de más', (p2.sigue || []).length === 0 && !log.some((x) => x.table === 'route_assignments' && x.ops.some((o) => o[0] === 'is' && o[1] === 'manual_day')) && ids(p2.vueltas) === 'ra-hoy,ra-mad');
  const p3 = await A.getPublishedPlan(SIG, { estados: E });
  t('el día siguiente sigue trayendo sus vueltas de madrugada como antes (la pegada de ayer, no)', ids(p3.vueltas) === 'ra-sig1,ra-sig2,ra-sig3,ra-sig4,ra-sig5,ra-sig6,ra-sig7' || ids(p3.vueltas) === 'ra-mad,ra-sig1,ra-sig2,ra-sig3,ra-sig4,ra-sig5,ra-sig6,ra-sig7', ids(p3.vueltas));
  t('sin errores en consola (api.js)', errs.length === 0, errs.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
const DAY = '2026-10-12', SIG = '2026-10-13';
const persona = (n, dl, rid, vuelo, zona) => ({ n, zona, sector: 'Rionegro', resId: null, zonaJefe: null, dir: zona + ', Rionegro', lat: 6.02, lng: -75.41, dl, pax: 1, type: 'lle',
  reservationId: rid, tel: '', vuelo, tierra: false, notas: '', hotel: false });
const parada = (stopId, rid, name, order, extra = {}) => Object.assign({ stopId, rid, order, status: 'pending', name, etaAt: null, dueAt: null, pax: 1, guest: false }, extra);
const vuelta = (id, startAt, pendientes, extra = {}) => Object.assign({ id, type: 'lle', status: 'planned', startAt, vehicleId: null, planCar: 'Carro 1', carro: 'Carro 1', placa: null, cap: 4,
  pool: true, paraTomar: true, autoCreated: false, manualDay: null, delegated: false, driverProfileId: null, conductor: 'Sin conductor', pendientes, atendidas: [],
  fin: { estado: 'falta', motivos: [], faltan: 0, at: '', finAt: null, esperado: null, ocultaDesde: null, oculta: false } }, extra);

async function boot({ sigue = [], extra = [], ahora = '23:00' } = {}) {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const errors = [];
  w.console.error = (...a) => { errors.push(a.map((x) => (x && x.message) || String(x)).join(' ')); };
  w.addEventListener('error', (e) => errors.push(e.message));
  // El reloj de la pantalla: las 23:00 del día de prueba (las filas «sin vuelta» de
  // hace más de una hora no se pintan).
  const fijo = Date.parse(`${DAY}T${ahora}:00-05:00`);
  w.Date.now = () => fijo;
  w.RENDIO_CONFIG = {};
  w.state = { settings: { route_traffic_factor: 1, despacho_activo: true }, profile: { id: 'jefe', role: 'admin' } };
  w.toast = () => {};
  w.confirm = () => true;
  w.escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  w.$ = (s) => w.document.querySelector(s); w.$$ = (s) => w.document.querySelectorAll(s);
  w.fetch = async () => { throw new Error('sin red'); };
  w.eval(readFileSync(FIX + 'fake-leaflet.js', 'utf8'));
  w.eval(readFileSync(FIX + 'rutas-v2-dia.js', 'utf8'));
  w.RV2Fixture.instalarFetch(w);
  w.Api = {};
  w.RV2Fixture.instalar(w.Api, { publicado: true });
  // + María Noche (aterriza 23:20) y Sara Tarde (23:50): gente de ESTE día.
  const plan0 = w.Api.listRoutePlanning;
  w.Api.listRoutePlanning = async (tipo, day) => {
    const r = await plan0(tipo, day);
    if (r) { r.aux.rZ = persona('María Noche', '23:20', 'res-Z', 'AV9242', 'Ruta 39'); r.aux.rY = persona('Sara Tarde', '23:50', 'res-Y', 'P57049', 'Carmen');
      Object.keys(r.aux).forEach((k) => { r.aux[k].auxId = 'aux-' + k; }); }
    return r;
  };
  const pub0 = w.Api.getPublishedPlan;
  w.Api.getPublishedPlan = async (day, o) => {
    const r = await pub0(day, o);
    if (day === DAY) { r.vueltas = r.vueltas.concat(JSON.parse(JSON.stringify(extra))); r.sigue = JSON.parse(JSON.stringify(sigue)); }
    return r;
  };
  // Los botones por id de las filas del sistema (0145, 0129) y pasar a otra vuelta (0167).
  w.Api.adminManualRouteSetTimes = async () => ({});
  w.Api.setVueltaDriver = async () => ({});
  w.Api.pasarReserva = async () => ({});
  try {
    w.eval(read('admin-consola.js') + '\n' + read('admin-rutas.js') + '\n' + read('admin-rutas-v2.js') + '\n' + read('admin-ruta-julian.js') +
      '\n;window.__T = { rt, renderRoutes, rtLoad };');
  } catch (e) { errors.push('eval: ' + e.message); }
  w.document.querySelector('section[data-panel="routes"]').classList.remove('hidden');
  const q = (s) => w.document.querySelector(s);
  const qa = (s) => [...w.document.querySelectorAll(s)];
  await w.__T.renderRoutes();
  await wait(60);
  return { w, errors, q, qa, rt: w.__T.rt, V2: () => w.RendioRutasV2 };
}

const SIG1 = vuelta('ra-sig1', `${SIG}T00:10:00-05:00`, [
  parada('g-1', null, 'Valen Sincuenta', 1, { guest: true }), parada('st-z', 'res-Z', 'María Noche', 2), parada('st-y', 'res-Y', 'Sara Tarde', 3)]);

console.log('\n── B1 · Antes: sin la vuelta de después de medianoche, la persona sale «Sin vuelta» ──');
{
  const b = await boot();
  t('María Noche (23:20) está en «sin carro»', b.rt.pool.includes('rZ'), JSON.stringify(b.rt.pool));
  t('…y la lista la pinta «Sin vuelta · No tiene carro»', !!b.q('.rv2-row--sinv[data-sinv="rZ"]') && /No tiene carro/.test(txt(b.q('.rv2-row--sinv[data-sinv="rZ"]'))), txt(b.q('.rv2-row--sinv[data-sinv="rZ"]')));
  t('sin errores de script', b.errors.length === 0, b.errors.join(' | '));
  globalThis.__lanes0 = (b.rt.lanes || []).length; globalThis.__cars0 = (b.rt.cars || []).map((c) => c.id).join(',');
}

console.log('\n── B2 · Con la vuelta que sale a las 00:10: se ve en su día, por su id ──');
{
  const b = await boot({ sigue: [SIG1] });
  t('María Noche y Sara Tarde ya NO salen «Sin vuelta»', !b.q('.rv2-row--sinv[data-sinv="rZ"]') && !b.q('.rv2-row--sinv[data-sinv="rY"]'), b.qa('.rv2-row--sinv').map((r) => r.getAttribute('data-sinv')).join());
  t('…ni quedan en «sin carro» (Optimizar y Ubicar no las vuelven a rutear)', !b.rt.pool.includes('rZ') && !b.rt.pool.includes('rY') && !b.rt.aux.rZ && !b.rt.aux.rY, JSON.stringify(b.rt.pool));
  t('quien de verdad no tiene vuelta sigue saliendo (Kevin, 15:05, queda en «sin carro»)', b.rt.pool.includes('rO'), JSON.stringify(b.rt.pool));
  const fila = b.q('.rv2-row--sola[data-sola="ra-sig1"]');
  t('la vuelta va como fila propia', !!fila);
  const T = txt(fila) || '';
  t('…dice por qué: «Sale después de medianoche» (no «La armó el sistema»)', /Sale después de medianoche/.test(T) && !/La armó el sistema/.test(T), T);
  t('…con TODA su gente: María Noche, Sara Tarde y el sin cuenta', /María Noche/.test(T) && /Sara Tarde/.test(T) && /Valen Sincuenta/.test(T) && /sin cuenta/.test(T), T);
  t('…se lee por la hora del vuelo, cada una con la suya (23:20 y 23:50)', /23:20/.test(T) && /23:50/.test(T), T);
  t('…en espera, la reparte el sistema', /En espera · la reparte el sistema/.test(T), T);
  t('…con los botones que aplican por id: «Cambiar hora» y «Asignar conductor»', !!fila && !!fila.querySelector('[data-rj-hora="ra-sig1"]') && !!fila.querySelector('[data-rj-drv="ra-sig1"]'), fila && fila.innerHTML.slice(-400));
  t('…y cada persona con cuenta se puede pasar a otra vuelta', !!fila && fila.querySelectorAll('[data-pasar]').length === 2, String(fila && fila.querySelectorAll('[data-pasar]').length));
  const bloque = fila && fila.closest('section, .rv2-hour, .rv2-hgroup, div[data-h]');
  const antes = b.qa('.rv2-row').map((r) => r.getAttribute('data-sola') || r.getAttribute('data-sinv') || r.getAttribute('data-id') || '?');
  t('…y NO va en el bloque de madrugada de arriba (es del final del día)', !!fila && !fila.closest('.rv2-mad'), bloque && bloque.className);
  t('…va después de las vueltas de la tarde (la última fila de las que faltan)', antes.indexOf('ra-sig1') > 0, antes.join(' '));
  t('los botones la encuentran por su id (RendioRutasV2.pegadas)', (b.V2().pegadas() || []).some((v) => v.id === 'ra-sig1'));
  t('la hoja de pegar la sigue reconociendo por su cuenta (no entra a «ajenas»)', !(b.rt.rv2Ajenas || []).includes('res-Z') && !!(b.rt.rv2AuxSolas || {})['res-Z'], JSON.stringify(b.rt.rv2Ajenas));
  t('el tablero no cambia: las mismas vueltas y los mismos carros', (b.rt.lanes || []).length === globalThis.__lanes0 && (b.rt.cars || []).map((c) => c.id).join(',') === globalThis.__cars0,
    `${(b.rt.lanes || []).length} vs ${globalThis.__lanes0} · ${(b.rt.cars || []).map((c) => c.id).join(',')}`);
  t('sin errores de script', b.errors.length === 0, b.errors.join(' | '));
}

console.log('\n── B3 · La que era del tablero con conductor fijo: sin «Cambiar hora» ──');
{
  const conDrv = vuelta('ra-sig7', `${SIG}T00:05:00-05:00`, [parada('st-z', 'res-Z', 'María Noche', 1)], { pool: false, paraTomar: false, driverProfileId: 'd4', conductor: 'Diego Salazar' });
  const b = await boot({ sigue: [conDrv] });
  const fila = b.q('.rv2-row--sola[data-sola="ra-sig7"]'), T = txt(fila) || '';
  t('se ve con su conductor', !!fila && /Diego Salazar/.test(T) && /Sale después de medianoche/.test(T), T);
  t('no ofrece «Cambiar hora» (esa función solo acepta las de tomar o pegadas)', !!fila && !fila.querySelector('[data-rj-hora]'), fila && fila.innerHTML.slice(-300));
  t('sí ofrece cambiar el conductor', !!fila && !!fila.querySelector('[data-rj-drv="ra-sig7"]'));
  t('María Noche ya no sale «Sin vuelta»', !b.q('.rv2-row--sinv[data-sinv="rZ"]') && !b.rt.pool.includes('rZ'));
  const sinDrv = vuelta('ra-sig8', `${SIG}T00:05:00-05:00`, [parada('st-z', 'res-Z', 'María Noche', 1)], { pool: false, paraTomar: false });
  const c = await boot({ sigue: [sinDrv] });
  t('del tablero y sin conductor: dice «Sin conductor», no «la reparte el sistema»', /Sin conductor/.test(txt(c.q('.rv2-row--sola[data-sola="ra-sig8"]')) || '') && !/la reparte el sistema/.test(txt(c.q('.rv2-row--sola[data-sola="ra-sig8"]')) || ''), txt(c.q('.rv2-row--sola[data-sola="ra-sig8"]')));
  t('sin errores de script', b.errors.length === 0 && c.errors.length === 0, b.errors.concat(c.errors).join(' | '));
}

console.log('\n── B4 · El otro lado: la vuelta de las 00:10 de HOY con gente de AYER ──');
{
  const deAyer = vuelta('ra-ayer', `${DAY}T00:10:00-05:00`, [
    parada('g-2', null, 'Otra Sincuenta', 1, { guest: true }), parada('st-a', 'res-AYER', 'Lina Deayer', 2), parada('st-b', 'res-AYER2', 'Beto Deayer', 3)], { planCar: 'Carro 9', carro: 'Carro 9' });
  const b = await boot({ extra: [deAyer], ahora: '00:05' });
  const fila = b.q('.rv2-row--sola[data-sola="ra-ayer"]'), T = txt(fila) || '';
  t('antes no se pintaba; ahora va como fila propia «Gente de otro día»', !!fila && /Gente de otro día/.test(T), T);
  t('…con todos: Lina, Beto y el sin cuenta', /Lina Deayer/.test(T) && /Beto Deayer/.test(T) && /Otra Sincuenta/.test(T), T);
  t('…en el bloque de madrugada (cierre del turno PM de ayer), a las 00:10', !!fila && !!fila.closest('.rv2-mad') && /00:10/.test(T), T);
  t('…con sus botones por id', !!fila && !!fila.querySelector('[data-rj-hora="ra-ayer"]') && !!fila.querySelector('[data-rj-drv="ra-ayer"]'));
  t('no crea un carro de más en el tablero ni una fila del tablero vacía', !(b.rt.cars || []).some((c) => c.id === 'Carro 9') && !(b.rt.lanes || []).some((l) => l.raId === 'ra-ayer'), (b.rt.cars || []).map((c) => c.id).join(','));
  t('el sin cuenta de esa vuelta no cae en «sin carro»', !(b.rt.pool || []).some((k) => /^g/.test(k)), JSON.stringify(b.rt.pool));
  t('las vueltas del tablero del día siguen todas', (b.rt.lanes || []).length === globalThis.__lanes0, `${(b.rt.lanes || []).length} vs ${globalThis.__lanes0}`);
  // Una vuelta que REPITE a alguien del día (ya va en otra) sigue como antes: no se pinta.
  const repetida = vuelta('ra-rep', `${DAY}T16:40:00-05:00`, [parada('st-k', 'res-K', 'Tomás Arias', 1)], { planCar: 'V-03', carro: 'V-03', pool: false, paraTomar: false, driverProfileId: 'd4', conductor: 'Diego Salazar' });
  const c = await boot({ extra: [repetida] });
  t('la que repite a alguien del día no se vuelve fila «de otro día» (queda como antes)', !c.q('.rv2-row--sola[data-sola="ra-rep"]'));
  t('un borrador con gente de otro día tampoco', !(await boot({ extra: [Object.assign({}, deAyer, { id: 'ra-bor', status: 'draft' })], ahora: '00:05' })).q('.rv2-row--sola[data-sola="ra-bor"]'));
  t('sin errores de script', b.errors.length === 0 && c.errors.length === 0, b.errors.concat(c.errors).join(' | '));
}

console.log(`\n${ok}/${ok + bad} pasaron${bad ? ` · ${bad} FALLARON` : ''}`);
console.log('NO cubierto: la base real (filtro de PostgREST, RLS), el layout (jsdom no lo hace) y que los botones guarden (son los de las filas del sistema: _smoke-ruta-julian-dom, _smoke-rutas-v2-dom).');
process.exit(bad ? 1 : 0);
