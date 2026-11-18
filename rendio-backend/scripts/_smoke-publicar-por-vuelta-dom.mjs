// PUBLICAR VUELTA POR VUELTA (17-nov-2026) — prueba jsdom.
//
// El 17-nov, 7:04 p. m.: un jefe movió a UNA persona (Gersey) en Asignación y le dio
// Publicar. saveRoutePlan borraba «todo lo del día que no ha arrancado» y lo volvía a
// crear con lo que tuviera ESA pantalla: se recrearon 14 vueltas (8 de la mañana, ya
// pasadas, sin conductor) y las llegadas de las 11:35 y 11:55 p. m., que esa pantalla
// no tenía, se borraron: 5 personas sin carro esa noche.
//
// PARTE 1 · api.js DE VERDAD con un `sb` FALSO (el 17-nov en pequeño):
//   · mover a una persona → se borran y se crean SOLO las dos vueltas tocadas; las de
//     la mañana no se recrean y las que la pantalla no cargó siguen;
//   · sin cambios → no se escribe nada;
//   · conflictos: la fila tiene otra gente que al leerla (otro jefe / el sistema), o
//     alguien ya va en otra vuelta que no se está cambiando → esa vuelta NO se guarda,
//     lo que depende de ella tampoco (nadie queda en dos vueltas ni sin la suya), y lo
//     demás sí se publica;
//   · quitar una vuelta, re-optimizar, una reserva cancelada que dejó su parada, una
//     vuelta arrancada, la para tomar del sistema y la pegada: como siempre;
//   · SIN opts.porVuelta (la vista anterior): el día entero, igual que antes.
// PARTE 2 · el tablero DE VERDAD (admin-rutas.js + admin-rutas-v2.js) con un Api
//   falso: qué manda rtSavePlan (raId, cambio, quitadas, base, conocidas), el registro
//   por vuelta (rt.pubBase) después de publicar, el aviso de conflicto y la vista anterior.
//
// NO CUBRE: la base real (RLS, FKs, que PostgREST acepte los filtros tal cual), dos
// jefes publicando en el mismo segundo (no hay transacción: son varias llamadas), un
// navegador ni un teléfono de verdad, ni los avisos push reales.
//
//   cd rendio-backend && node scripts/_smoke-publicar-por-vuelta-dom.mjs
process.env.TZ = 'America/Bogota';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const FIX = new URL('./fixtures/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null && d !== '' ? ' → ' + d : '')); } };
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const clon = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

/* ═════════════ PARTE 1 · saveRoutePlan de verdad, base falsa ═════════════ */
function fakeSb(DB) {
  const log = { deletes: [], selects: [], inserts: { route_assignments: [], route_stops: [] } };
  let n = 0;
  return {
    log,
    from(table) {
      let op = 'select', row = null, single = false;
      const filtros = [];
      const b = {
        select(s) { if (op === 'select' && s) log.selects.push([table, s]); return b; },
        single() { single = true; return b; }, maybeSingle() { single = true; return b; },
        order() { return b; }, limit() { return b; },
        insert(r) { op = 'insert'; row = r; return b; },
        delete() { op = 'delete'; return b; },
        update(r) { op = 'update'; row = r; return b; },
      };
      ['eq', 'in', 'is', 'not', 'or', 'gte', 'lte', 'lt', 'gt', 'neq'].forEach((f) => { b[f] = (...a) => { filtros.push([f, ...a]); return b; }; });
      b.then = (res, rej) => {
        let out = { data: null, error: null };
        if (op === 'delete') {
          const ids = (filtros.find((x) => x[0] === 'in' && x[1] === 'id') || [])[2] || null;
          log.deletes.push({ table, ids: ids ? ids.slice() : null, filtros });
        } else if (op === 'insert') {
          if (table === 'route_assignments') { const id = 'nueva-' + (++n); log.inserts.route_assignments.push(Object.assign({ id }, row)); out = { data: single ? { id } : [{ id }], error: null }; }
          else log.inserts[table] = (log.inserts[table] || []).concat(row);
        } else if (table === 'route_assignments') out = { data: clon(DB.plan), error: null };
        else if (table === 'driver_profiles') out = { data: [{ id: 'dp-juan', profile_id: 'p-juan' }, { id: 'dp-miguel', profile_id: 'p-miguel' }], error: null };
        else out = { data: [], error: null };
        return Promise.resolve(out).then(res, rej);
      };
      return b;
    },
    rpc: async () => ({ data: null, error: null }),
    auth: { getSession: async () => ({ data: { session: null } }), getUser: async () => ({ data: { user: null } }) },
  };
}
function bootApi(plan) {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = dom.window;
  const errors = [];
  w.addEventListener('error', (e) => errors.push(e.message));
  w.console.error = (...a) => errors.push(a.map(String).join(' '));
  w.console.warn = () => {};
  w.RENDIO_CONFIG = {};
  w.sb = fakeSb({ plan });
  w.eval('var state = { profile: { id: "jefe", role: "admin", organization_id: "org1" }, settings: {} };');
  w.eval(read('api.js'));
  return { w, errors, L: w.sb.log, guardar: (lanes, pv) => (pv === undefined ? w.Api.saveRoutePlan(DIA, lanes) : w.Api.saveRoutePlan(DIA, lanes, { porVuelta: pv })) };
}

const DIA = '2026-11-17';
// Cada parada trae su reserva (por vuelta se pide `reservations(cancelled_at)`, como en getPublishedPlan).
const st = (id, rid, status, extra) => Object.assign({ id, reservation_id: rid, status: status || 'pending', estimated_arrival_at: null, reservations: rid ? { cancelled_at: null } : null }, extra || {});
const fila = (id, hm, tipo, drv, stops, extra) => Object.assign({ id, status: 'planned', direction: tipo === 'lle' ? 'airport_to_home' : 'home_to_airport',
  planned_start_at: `${DIA}T${hm}:00-05:00`, driver_profile_id: drv ? 'dp-' + drv : null, pool: false, para_tomar: false, auto_created: false,
  delegated_at: null, delegate_name: null, driver_profiles: drv ? { profile_id: 'p-' + drv } : null, route_stops: stops }, extra || {});
const TOMAR = { pool: true, para_tomar: true };
// El 17-nov en pequeño. La pantalla del jefe NO tiene n2335 ni n2355 (ni la pegada ni la sola).
const base17 = () => [
  fila('m0300', '03:00', 'sal', 'juan', [st('s-x', 'res-x', 'delivered')]),                       // de la mañana, hecha
  fila('m0620', '06:20', 'sal', null, [st('s-jairo', 'res-jairo')], { status: 'draft' }),          // de la mañana, sin marcar
  fila('m0825', '08:25', 'lle', null, [st('s-ana', 'res-ana')]),                                   // ídem
  fila('m1220', '12:20', 'sal', null, [st('s-gsal', 'res-gersey-sal')]),                           // la salida de Gersey, sin marcar
  fila('n1955', '19:55', 'lle', 'juan', [st('s-fer', 'res-fernando'), st('s-glle', 'res-gersey'), st('s-karol', 'res-karol')]),
  fila('n2207', '22:07', 'lle', null, [st('s-lauray', 'res-lauray'), st('s-joss', 'res-joss')], TOMAR),
  fila('n2335', '23:35', 'lle', null, [st('s-andrea', 'res-andrea'), st('s-luz', 'res-luz'), st('s-fabi', 'res-fabiana'), st('s-lauraa', 'res-lauraa')], TOMAR),
  fila('n2355', '23:55', 'lle', null, [st('s-michell', 'res-michell')], TOMAR),
  fila('pegada', '21:00', 'lle', null, [st('s-sara', 'res-sara')], { pool: true }),                                   // la pegó Julián
  fila('sola', '21:30', 'lle', null, [st('s-pedro', 'res-pedro')], { pool: true, auto_created: true }),               // la armó el sistema, sin tomar
];
const lane = (laneId, raId, cambio, tipo, hm, drv, stops, extra) => Object.assign({ laneId, raId, cambio, driverProfileId: drv ? 'p-' + drv : null, type: tipo,
  startAt: `${DIA}T${hm}:00-05:00`, stops, vehicleId: null, planCar: 'Carro 1', etas: {} }, extra || {});
// La pantalla del jefe tal como la leyó (nada tocado).
const pantalla = () => [
  lane('L-m0300', 'm0300', false, 'sal', '03:00', 'juan', ['res-x']),
  lane('L-m0620', 'm0620', false, 'sal', '06:20', null, ['res-jairo']),
  lane('L-m0825', 'm0825', false, 'lle', '08:25', null, ['res-ana']),
  lane('L-m1220', 'm1220', false, 'sal', '12:20', null, ['res-gersey-sal']),
  lane('L-n1955', 'n1955', false, 'lle', '19:55', 'juan', ['res-fernando', 'res-gersey', 'res-karol']),
  lane('L-n2207', 'n2207', false, 'lle', '22:07', null, ['res-lauray', 'res-joss'], { paraTomar: true }),
];
const BASE = { m0300: 'res-x', m0620: 'res-jairo', m0825: 'res-ana', m1220: 'res-gersey-sal', n1955: 'res-fernando,res-gersey,res-karol', n2207: 'res-joss,res-lauray' };
const CONOCIDAS = ['res-x', 'res-jairo', 'res-ana', 'res-gersey-sal', 'res-fernando', 'res-gersey', 'res-karol', 'res-lauray', 'res-joss'];
const pv = (extra) => Object.assign({ quitadas: [], base: Object.assign({}, BASE), conocidas: CONOCIDAS.slice() }, extra || {});
// Mover a Gersey de la llegada de las 19:55 a la de las 22:07.
const moverGersey = (lanes) => lanes.map((l) => (l.laneId === 'L-n1955' ? Object.assign({}, l, { cambio: true, stops: ['res-fernando', 'res-karol'] })
  : l.laneId === 'L-n2207' ? Object.assign({}, l, { cambio: true, stops: ['res-lauray', 'res-joss', 'res-gersey'] }) : l));
const borradas = (L) => L.deletes.filter((d) => d.table === 'route_assignments').flatMap((d) => d.ids || ['TODO-EL-DIA']).sort();
const paradasBorradas = (L) => L.deletes.filter((d) => d.table === 'route_stops').flatMap((d) => d.ids || []);
const creadas = (L) => L.inserts.route_assignments;
const subidas = (L) => L.inserts.route_stops.map((s) => s.reservation_id).filter(Boolean).sort();

console.log('\n── 1 · El 17-nov: mover a UNA persona y Publicar ──');
{
  const B = bootApi(base17());
  const r = await B.guardar(moverGersey(pantalla()), pv());
  t('publica sin errores ni conflictos', r && r.failed === 0 && r.conflictos.length === 0 && B.errors.length === 0, JSON.stringify(r && { f: r.failed, c: r.conflictos }) + ' ' + B.errors.join(' | '));
  t('se borran SOLO las dos vueltas tocadas (19:55 y 22:07)', borradas(B.L).join(',') === 'n1955,n2207', borradas(B.L).join(','));
  t('…y se crean dos, no catorce', creadas(B.L).length === 2 && r.saved === 2, creadas(B.L).length + ' / ' + r.saved);
  t('Gersey queda en la de las 22:07 con Laura y Josselyn; Fernando y Karol en la suya', subidas(B.L).join(',') === 'res-fernando,res-gersey,res-joss,res-karol,res-lauray', subidas(B.L).join(','));
  t('las de la mañana NO se recrean (ni Jairo, ni Ana, ni la salida de Gersey)', !subidas(B.L).some((x) => ['res-jairo', 'res-ana', 'res-gersey-sal', 'res-x'].includes(x)) && r.intactas === 4, 'intactas ' + r.intactas);
  t('las llegadas de las 11:35 y 11:55 p. m., que la pantalla no tenía, NO se tocan', !borradas(B.L).some((x) => ['n2335', 'n2355', 'TODO-EL-DIA'].includes(x)) && !subidas(B.L).some((x) => /andrea|luz|fabiana|lauraa|michell/.test(x)));
  t('la que no cambió conserva su fila; la que cambió estrena fila y dice con quién quedó',
    r.ids['L-m0620'] && r.ids['L-m0620'].id === 'm0620' && r.ids['L-m0620'].intacta === true && /^nueva-/.test(r.ids['L-n2207'].id) && r.ids['L-n2207'].rids.slice().sort().join(',') === 'res-gersey,res-joss,res-lauray', JSON.stringify(r.ids));
  const tomar = creadas(B.L).find((x) => x.para_tomar);
  t('la de las 22:07 sigue «para tomar» y con su organización', !!tomar && tomar.pool === true && tomar.organization_id === 'org1' && tomar.status === 'planned', JSON.stringify(tomar));
  t('no se le avisa a nadie de la mañana', !(r.notify || []).some((n) => ['res-jairo', 'res-ana', 'res-gersey-sal', 'res-x'].includes(n.reservationId)), JSON.stringify(r.notify));
  t('la lectura pide si la reserva está cancelada (solo por vuelta)', B.L.selects.some(([tb, s]) => tb === 'route_assignments' && /reservations\(cancelled_at\)/.test(s)));
}

console.log('\n── 2 · Publicar sin haber tocado nada ──');
{
  const B = bootApi(base17());
  const r = await B.guardar(pantalla(), pv());
  t('no se borra ni se crea nada', B.L.deletes.length === 0 && creadas(B.L).length === 0 && B.L.inserts.route_stops.length === 0, JSON.stringify(B.L.deletes.map((d) => d.ids)));
  t('…y lo dice: 0 guardadas, 6 intactas', r.saved === 0 && r.intactas === 6 && r.conflictos.length === 0 && r.porVuelta === true, JSON.stringify({ s: r.saved, i: r.intactas }));
}

console.log('\n── 3 · La vista anterior (sin opts.porVuelta): el día entero, como siempre ──');
{
  const B = bootApi(base17());
  const sinMarcas = moverGersey(pantalla()).map(({ raId, cambio, ...l }) => l);
  const r = await B.guardar(sinMarcas);
  const del = B.L.deletes.filter((d) => d.table === 'route_assignments');
  t('borra por día (sin lista de filas), con el filtro de siempre', del.length === 1 && del[0].ids === null && del[0].filtros.some((f) => f[0] === 'or' && f[1] === 'pool.eq.false,para_tomar.eq.true')
    && del[0].filtros.some((f) => f[0] === 'not' && f[1] === 'id' && /m0300/.test(f[3])), JSON.stringify(del.map((d) => d.filtros)));
  t('vuelve a crear las 5 vueltas sin arrancar de la pantalla', creadas(B.L).length === 5 && r.saved === 5 && r.skipped === 1, creadas(B.L).length + ' / ' + JSON.stringify({ s: r.saved, k: r.skipped }));
  t('devuelve lo de siempre (sin conflictos ni intactas)', r.conflictos === undefined && r.intactas === undefined && r.porVuelta === undefined && !!r.ids['L-n1955']);
  t('la lectura NO cambia (sin reservations)', !B.L.selects.some(([tb, s]) => tb === 'route_assignments' && /reservations\(/.test(s)));
}

console.log('\n── 4 · Conflicto: otro jefe le metió a alguien a la de las 22:07 después de abrir el día ──');
{
  const plan = base17();
  plan.find((v) => v.id === 'n2207').route_stops.push(st('s-nuevo', 'res-nuevo'));
  const B = bootApi(plan);
  // Además del movimiento de Gersey, el jefe le puso conductor a la de las 08:25 (no tiene que ver).
  const lanes = moverGersey(pantalla()).map((l) => (l.laneId === 'L-m0825' ? Object.assign({}, l, { cambio: true, driverProfileId: 'p-miguel' }) : l));
  const r = await B.guardar(lanes, pv());
  const m = Object.fromEntries(r.conflictos.map((c) => [c.laneId, c.motivo]));
  t('la de las 22:07 NO se guarda (tiene otra gente)', m['L-n2207'] === 'otra-gente', JSON.stringify(r.conflictos));
  t('…ni la de las 19:55, que dependía de ella (Gersey no se queda sin vuelta)', !!m['L-n1955'] && !borradas(B.L).includes('n1955') && !borradas(B.L).includes('n2207'), JSON.stringify(m) + ' borradas ' + borradas(B.L).join(','));
  t('Gersey no queda en dos vueltas ni se mueve a medias', !subidas(B.L).includes('res-gersey') && !subidas(B.L).includes('res-nuevo'), subidas(B.L).join(','));
  t('lo demás SÍ se publica: la de las 08:25 con su conductor', borradas(B.L).join(',') === 'm0825' && creadas(B.L).length === 1 && creadas(B.L)[0].driver_profile_id === 'dp-miguel' && subidas(B.L).join(',') === 'res-ana' && r.saved === 1, borradas(B.L).join(',') + ' / ' + JSON.stringify(creadas(B.L)));
  t('las que chocaron conservan su fila (marcadas como conflicto)', r.ids['L-n2207'].id === 'n2207' && r.ids['L-n2207'].conflicto === true && r.ids['L-n1955'].id === 'n1955' && r.ids['L-n1955'].conflicto === true, JSON.stringify(r.ids));
  t('el conflicto trae la hora y el tipo para decirlo en pantalla', r.conflictos.every((c) => c.startAt && c.type === 'lle'));
}

console.log('\n── 5 · Conflicto: la pantalla cree que Andrea está sin carro y ya va en la de las 11:35 p. m. ──');
{
  const B = bootApi(base17());
  const lanes = pantalla().concat([lane('L-nueva', null, true, 'lle', '23:20', 'miguel', ['res-andrea'])]);
  const r = await B.guardar(lanes, pv({ conocidas: CONOCIDAS.concat(['res-andrea']) }));
  t('la vuelta nueva NO se guarda (Andrea ya va en otra que no se está cambiando)', r.conflictos.length === 1 && r.conflictos[0].motivo === 'ya-en-otra' && r.conflictos[0].laneId === 'L-nueva', JSON.stringify(r.conflictos));
  t('no se borra nada y Andrea no queda en dos vueltas', B.L.deletes.length === 0 && creadas(B.L).length === 0 && !r.ids['L-nueva']);
}

console.log('\n── 6 · Conflicto: la fila tiene gente que la pantalla no pudo cargar ──');
{
  const B = bootApi(base17());
  // La pantalla cargó la de las 11:35 solo con Andrea y Luz (a Fabiana y Laura A. no las tiene).
  const lanes = pantalla().concat([lane('L-n2335', 'n2335', true, 'lle', '23:35', 'miguel', ['res-andrea', 'res-luz'], { paraTomar: false })]);
  const r = await B.guardar(lanes, pv({ base: Object.assign({}, BASE, { n2335: 'res-andrea,res-fabiana,res-lauraa,res-luz' }), conocidas: CONOCIDAS.concat(['res-andrea', 'res-luz']) }));
  t('no se guarda: se perderían Fabiana y Laura A.', r.conflictos.length === 1 && r.conflictos[0].motivo === 'gente-no-cargada' && B.L.deletes.length === 0 && creadas(B.L).length === 0, JSON.stringify(r.conflictos));
}

console.log('\n── 7 · Quitar una vuelta (el jefe la vació) ──');
{
  const B = bootApi(base17());
  const r = await B.guardar(pantalla().filter((l) => l.laneId !== 'L-n2207'), pv({ quitadas: ['n2207', 'ya-no-existe'] }));
  t('se borra esa fila y ninguna otra; no se crea nada', borradas(B.L).join(',') === 'n2207' && creadas(B.L).length === 0 && r.quitadas.join(',') === 'n2207' && r.conflictos.length === 0, borradas(B.L).join(',') + ' ' + JSON.stringify(r.quitadas));
  // …pero si alguien le metió gente después, no se borra.
  const plan = base17(); plan.find((v) => v.id === 'n2207').route_stops.push(st('s-nuevo', 'res-nuevo'));
  const B2 = bootApi(plan);
  const r2 = await B2.guardar(pantalla().filter((l) => l.laneId !== 'L-n2207'), pv({ quitadas: ['n2207'] }));
  t('una quitada a la que le cambió la gente NO se borra (y se avisa)', B2.L.deletes.length === 0 && r2.quitadas.length === 0 && r2.conflictos.length === 1 && r2.conflictos[0].quitada === true && r2.conflictos[0].raId === 'n2207', JSON.stringify(r2.conflictos));
  // …y una que ya arrancó tampoco.
  const B3 = bootApi(base17());
  const r3 = await B3.guardar(pantalla().filter((l) => l.laneId !== 'L-m0300'), pv({ quitadas: ['m0300'] }));
  t('una vuelta ya hecha nunca se borra, aunque no esté en la pantalla', B3.L.deletes.length === 0 && r3.quitadas.length === 0 && r3.conflictos.length === 0);
}

console.log('\n── 8 · Re-optimizar y Publicar: se cambia lo que la pantalla tenía, nada más ──');
{
  const B = bootApi(base17());
  const nuevas = [
    lane('N1', null, true, 'sal', '06:20', 'juan', ['res-jairo']), lane('N2', null, true, 'lle', '08:25', 'juan', ['res-ana']),
    lane('N3', null, true, 'sal', '12:20', 'juan', ['res-gersey-sal']), lane('N4', null, true, 'lle', '19:55', 'miguel', ['res-fernando', 'res-karol', 'res-gersey']),
    lane('N5', null, true, 'lle', '22:07', 'miguel', ['res-lauray', 'res-joss']), lane('L-m0300', 'm0300', false, 'sal', '03:00', 'juan', ['res-x']),
  ];
  const r = await B.guardar(nuevas, pv({ quitadas: ['m0620', 'm0825', 'm1220', 'n1955', 'n2207'] }));
  t('se borran las 5 que la pantalla tenía sin arrancar', borradas(B.L).join(',') === 'm0620,m0825,m1220,n1955,n2207', borradas(B.L).join(','));
  t('…y se crean las 5 nuevas; la hecha y las de las 11:35/11:55 p. m. siguen', creadas(B.L).length === 5 && r.saved === 5 && r.intactas === 1 && r.conflictos.length === 0 && !subidas(B.L).some((x) => /andrea|michell|res-x/.test(x)), creadas(B.L).length + ' ' + JSON.stringify(r.conflictos));
}

console.log('\n── 9 · Lo de siempre sigue igual por vuelta ──');
{
  // Una reserva cancelada que dejó su parada no cuenta como «otra gente».
  const plan = base17(); plan.find((v) => v.id === 'n2207').route_stops.push(st('s-canc', 'res-cancelada', 'pending', { reservations: { cancelled_at: '2026-11-17T20:00:00Z' } }));
  const B = bootApi(plan);
  const r = await B.guardar(moverGersey(pantalla()), pv());
  t('reserva cancelada con parada: no es conflicto, la vuelta se guarda', r.conflictos.length === 0 && borradas(B.L).join(',') === 'n1955,n2207' && !subidas(B.L).includes('res-cancelada'), JSON.stringify(r.conflictos));

  // La vuelta ya hecha a la que el jefe le agregó a alguien: su fila no se borra.
  const B2 = bootApi(base17());
  const lanes2 = pantalla().map((l) => (l.laneId === 'L-m0300' ? Object.assign({}, l, { cambio: true, stops: ['res-x', 'res-zoe'] }) : l));
  const r2 = await B2.guardar(lanes2, pv({ conocidas: CONOCIDAS.concat(['res-zoe']) }));
  t('vuelta arrancada: su fila no se borra y a quien ya se entregó no se le toca', !borradas(B2.L).includes('m0300') && !subidas(B2.L).includes('res-x') && subidas(B2.L).join(',') === 'res-zoe' && r2.conflictos.length === 0, borradas(B2.L).join(',') + ' / ' + subidas(B2.L).join(','));

  // La para tomar que armó el sistema cede al tablero; la pegada de Julián se salta.
  const B3 = bootApi(base17());
  const r3 = await B3.guardar(pantalla().concat([lane('L-otra', null, true, 'lle', '21:15', 'miguel', ['res-pedro', 'res-sara'])]), pv({ conocidas: CONOCIDAS.concat(['res-pedro', 'res-sara']) }));
  t('quien iba en la para tomar del sistema sale de ella y entra a la vuelta nueva', paradasBorradas(B3.L).includes('s-pedro') && subidas(B3.L).includes('res-pedro') && r3.conflictos.length === 0, JSON.stringify(r3.conflictos) + ' ' + paradasBorradas(B3.L).join(','));
  t('…y quien va en una vuelta pegada se sigue saltando', !subidas(B3.L).includes('res-sara') && !paradasBorradas(B3.L).includes('s-sara') && !borradas(B3.L).includes('pegada'));

  // La pantalla tiene una vuelta que la base ya no tiene (otro jefe la cambió).
  const B4 = bootApi(base17());
  const r4 = await B4.guardar(pantalla().concat([lane('L-fantasma', 'ya-no-existe', false, 'lle', '20:00', 'juan', ['res-karol'])]), pv());
  t('vuelta sin tocar que ya no existe en la base: no se crea ni se borra nada, y se avisa', B4.L.deletes.length === 0 && creadas(B4.L).length === 0 && r4.viejas.join(',') === 'L-fantasma' && !r4.ids['L-fantasma'], JSON.stringify(r4.viejas));
}

/* ═════════════ PARTE 2 · el tablero de verdad, Api falso ═════════════ */
async function bootTablero() {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const errors = [];
  w.console.error = (...a) => { errors.push(a.map((x) => (x && x.message) || String(x)).join(' ')); };
  w.addEventListener('error', (e) => errors.push(e.message));
  w.RENDIO_CONFIG = {};
  w.state = { settings: { route_traffic_factor: 1 }, profile: { id: 'jefe', role: 'admin' } };
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
  try {
    w.eval(read('admin-consola.js') + '\n' + read('admin-rutas.js') + '\n' + read('admin-rutas-v2.js') +
      '\n;window.__T = { rt, renderRoutes, rtLoad, rtSavePlan, rtFirmaPlan, rtFirmaLane, rtBaseLimpia };');
  } catch (e) { errors.push('eval: ' + e.message); }
  w.document.querySelector('section[data-panel="routes"]').classList.remove('hidden');
  await w.__T.renderRoutes();
  await wait(40);
  // Un saveRoutePlan que contesta como el de verdad por vuelta, y anota lo que le llega.
  const llamadas = [];
  let n = 0, forzar = null;
  w.Api.saveRoutePlan = async (...args) => {
    const [day, lanes, opts] = args;
    llamadas.push({ nArgs: args.length, day, lanes: clon(lanes), opts: clon(opts) });
    const PV = opts && opts.porVuelta;
    if (!PV) return { saved: lanes.length, skipped: 0, kept: 0, failed: 0, failMsg: '', notify: [] };
    const ids = {}, conflictos = [], borradasIds = PV.quitadas.slice();
    let saved = 0, intactas = 0;
    lanes.forEach((l) => {
      if (forzar && forzar(l)) { conflictos.push({ laneId: l.laneId, raId: l.raId, motivo: 'otra-gente', startAt: l.startAt, type: l.type }); if (l.raId) ids[l.laneId] = { id: l.raId, status: 'planned', conflicto: true }; return; }
      if (l.raId && l.cambio === false) { ids[l.laneId] = { id: l.raId, status: 'planned', intacta: true }; intactas++; return; }
      if (l.raId) borradasIds.push(l.raId);
      ids[l.laneId] = { id: 'pub-' + (++n), status: 'planned', rids: l.stops.slice() }; saved++;
    });
    return { saved, skipped: 0, kept: 0, failed: 0, failMsg: '', notify: [], ofrecer: [], ids, porVuelta: true, intactas, conflictos, viejas: [], quitadas: PV.quitadas.slice(), borradas: borradasIds };
  };
  const dichos = [];
  const publicar = async () => { const r = await w.__T.rtSavePlan({ toast: (m) => dichos.push(m) }); await wait(5); return r; };
  return { w, errors, T: w.__T, rt: w.__T.rt, V2: w.RendioRutasV2, llamadas, dichos, publicar, forzarConflicto: (f) => { forzar = f; } };
}
const ult = (b) => b.llamadas[b.llamadas.length - 1];
const cambiadas = (ll) => ll.lanes.filter((l) => l.cambio !== false).map((l) => l.laneId).sort();

console.log('\n── 10 · El tablero: registro por vuelta y qué viaja al publicar ──');
{
  const b = await bootTablero();
  const { rt, T } = b;
  const conFila = rt.lanes.filter((l) => l.raId);
  t('al abrir el día hay un registro por cada vuelta publicada (9)', rt.pubBase && Object.keys(rt.pubBase).length === 9 && conFila.length === 9 && conFila.every((l) => rt.pubBase[l.raId] && rt.pubBase[l.raId].firma), JSON.stringify(Object.keys(rt.pubBase || {})));
  const lKL = rt.lanes.find((l) => (rt.order[l.id] || []).join(',') === 'rK,rL');
  t('…con la gente que cada fila tiene en la base', !!lKL && rt.pubBase[lKL.raId].rids === 'res-K,res-L', lKL && JSON.stringify(rt.pubBase[lKL.raId]));
  // Primer Publicar: guarda lo que la app puso sola al abrir (conductor del turno).
  await b.publicar();
  const p1 = ult(b);
  t('Publicar manda las 9 vueltas, cada una con su fila (raId) y si cambió', p1.nArgs === 3 && p1.lanes.length === 9 && p1.lanes.every((l) => l.raId && typeof l.cambio === 'boolean'), JSON.stringify(p1.lanes.map((l) => [l.laneId, l.raId, l.cambio])));
  t('…con quitadas (ninguna), la gente de cada fila y las reservas que la pantalla conoce', p1.opts.porVuelta.quitadas.length === 0 && Object.keys(p1.opts.porVuelta.base).length === 9 && p1.opts.porVuelta.base[lKL.raId] === 'res-K,res-L' && p1.opts.porVuelta.conocidas.length === 16 && p1.opts.porVuelta.conocidas.includes('res-K'), JSON.stringify([p1.opts.porVuelta.quitadas, p1.opts.porVuelta.conocidas.length]));
  // Segundo Publicar sin tocar nada.
  await b.publicar();
  t('volver a publicar sin tocar: ninguna vuelta viaja como cambio', cambiadas(ult(b)).length === 0 && ult(b).opts.porVuelta.quitadas.length === 0, cambiadas(ult(b)).join(','));
  t('…y el aviso lo dice', /No hay cambios por publicar/.test(b.dichos[b.dichos.length - 1]), b.dichos[b.dichos.length - 1]);

  // Mover a UNA persona entre dos vueltas (como Gersey).
  const idsAntes = Object.fromEntries(rt.lanes.map((l) => [l.id, l.raId]));
  b.V2._mover('rC', 'V-01·V2', 'V-02·V1'); await wait(5);
  const r = await b.publicar();
  const p3 = ult(b);
  t('mover a una persona: viajan como cambio SOLO las dos vueltas tocadas', cambiadas(p3).join(',') === 'V-01·V2,V-02·V1', cambiadas(p3).join(','));
  t('…las otras 7 van marcadas «sin cambio» con su fila de siempre', p3.lanes.filter((l) => l.cambio === false).length === 7 && p3.lanes.filter((l) => l.cambio === false).every((l) => l.raId === idsAntes[l.laneId]));
  t('el aviso dice lo que pasó de verdad', /Publicado: 2 vueltas cambiaron\. Las otras 7 quedaron como estaban, sin tocar\./.test(b.dichos[b.dichos.length - 1]) && r.ok === true, b.dichos[b.dichos.length - 1]);
  const l1 = rt.lanes.find((l) => l.id === 'V-01·V2'), l2 = rt.lanes.find((l) => l.id === 'V-02·V1');
  t('las dos estrenan fila y el registro las sigue (la fila vieja sale del registro)', /^pub-/.test(l1.raId) && /^pub-/.test(l2.raId) && rt.pubBase[l1.raId] && rt.pubBase[l2.raId] && !rt.pubBase[idsAntes['V-01·V2']] && !rt.pubBase[idsAntes['V-02·V1']] && Object.keys(rt.pubBase).length === 9, JSON.stringify(Object.keys(rt.pubBase)));
  t('…con la gente que quedó en cada una', rt.pubBase[l2.raId].rids.split(',').includes('res-C') && !rt.pubBase[l1.raId].rids.split(',').includes('res-C'), JSON.stringify([rt.pubBase[l1.raId].rids, rt.pubBase[l2.raId].rids]));
  t('queda publicado (sin cambios pendientes)', rt.firmaPublicada === T.rtFirmaPlan() && rt.lanes.filter((l) => l.raId).every((l) => T.rtBaseLimpia(l)));

  // Vaciar una vuelta: su fila viaja como quitada.
  const lIJ = rt.lanes.find((l) => (rt.order[l.id] || []).join(',') === 'rI,rJ');
  const filaIJ = lIJ.raId;
  rt.pool.push(...rt.order[lIJ.id]); rt.order[lIJ.id] = [];
  await b.publicar();
  t('vaciar una vuelta: su fila viaja en «quitadas» y nada más cambia', ult(b).opts.porVuelta.quitadas.join(',') === filaIJ && cambiadas(ult(b)).length === 0 && ult(b).lanes.length === 8, JSON.stringify([ult(b).opts.porVuelta.quitadas, cambiadas(ult(b))]));
  t('…y sale del registro', !rt.pubBase[filaIJ]);
  t('sin errores de consola', b.errors.length === 0, b.errors.join(' | '));
}

console.log('\n── 11 · El tablero: conflicto ──');
{
  const b = await bootTablero();
  const { rt, T } = b;
  await b.publicar();   // deja la pantalla igual a la base
  const antes = Object.fromEntries(rt.lanes.map((l) => [l.id, l.raId]));
  b.V2._mover('rC', 'V-01·V2', 'V-02·V1'); await wait(5);
  b.forzarConflicto((l) => l.laneId === 'V-02·V1' || l.laneId === 'V-01·V2');
  const r = await b.publicar();
  const dicho = b.dichos[b.dichos.length - 1];
  t('el aviso dice cuáles vueltas no se guardaron y qué hacer', /^No se guardaron 2 vueltas de las \d\d:\d\d, \d\d:\d\d: alguien más las cambió después de que abriste el día\. Vuelve a leer el día y repite el cambio\. No se publicó nada\./.test(dicho), dicho);
  t('el plan NO queda como publicado', r.ok === false && r.conflictos === 2 && rt.firmaPublicada !== T.rtFirmaPlan());
  const l2 = rt.lanes.find((l) => l.id === 'V-02·V1');
  t('la vuelta conserva su fila y sigue contando como cambio del jefe', l2.raId === antes['V-02·V1'] && !!rt.pubBase[l2.raId] && !T.rtBaseLimpia(l2));
  b.forzarConflicto(null);
  await b.publicar();
  t('al volver a publicar (ya sin choque) vuelve a viajar como cambio', cambiadas(ult(b)).join(',') === 'V-01·V2,V-02·V1', cambiadas(ult(b)).join(','));
}

console.log('\n── 11b · Con conflicto, Asignación vuelve a leer el día sola ──');
{
  const b = await bootTablero();
  const { rt, w } = b;
  const q = (s) => w.document.querySelector(s);
  const click = (el) => { if (!el) throw new Error('no existe el elemento'); el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })); };
  const chk = (id) => { const c = q(id); if (!c) return; c.checked = true; c.dispatchEvent(new w.Event('change', { bubbles: true })); };
  await b.publicar();
  b.V2._mover('rC', 'V-01·V2', 'V-02·V1'); await wait(5);
  t('antes de publicar, C está en la otra vuelta (cambio del jefe en pantalla)', (rt.order['V-02·V1'] || []).includes('rC'));
  b.forzarConflicto((l) => l.laneId === 'V-02·V1' || l.laneId === 'V-01·V2');
  let lecturas = 0;
  const leer = w.Api.getPublishedPlan; w.Api.getPublishedPlan = async (...a) => { lecturas++; return leer(...a); };
  // Por la hoja de Publicar, como lo hace el jefe.
  click(q('#rv2-publish')); await wait(10);
  if (q('#rv2-doPublish') && !q('#rv2-doPublish').disabled) click(q('#rv2-doPublish'));
  else { click(q('#rv2-forceOpen')); chk('#rv2-forceRisk'); chk('#rv2-forceUnr'); click(q('#rv2-doForce')); }
  await wait(250);
  const dicho = (q('#rv2-toast') ? q('#rv2-toast').textContent : '').replace(/\s+/g, ' ').trim();
  t('se llamó a publicar y hubo conflicto', b.llamadas.length === 2 && ult(b).lanes.filter((l) => l.cambio !== false).length === 2, String(b.llamadas.length));
  t('el día se volvió a leer de la base', lecturas >= 2, 'lecturas ' + lecturas);
  t('la pantalla quedó como la base (C de vuelta en su vuelta) y con su registro', (w.__T.rt.order['V-01·V2'] || []).includes('rC') && !(w.__T.rt.order['V-02·V1'] || []).includes('rC') && Object.keys(w.__T.rt.pubBase).length === 9, JSON.stringify([w.__T.rt.order['V-01·V2'], w.__T.rt.order['V-02·V1']]));
  t('el aviso se queda y dice que ya se volvió a leer', /No se guardaron 2 vueltas/.test(dicho) && /Ya se volvió a leer el día: repite el cambio\./.test(dicho) && !q('#rv2-toast').hidden, dicho);
  t('sin errores de consola', b.errors.length === 0, b.errors.join(' | '));
}

console.log('\n── 12 · La vista anterior no cambia ──');
{
  const b = await bootTablero();
  const { rt, T } = b;
  await T.rtLoad('2026-10-12'); await wait(10);   // como carga la vista anterior: sin lo publicado
  t('sin registro por vuelta', rt.pubBase === null);
  const l0 = rt.lanes[0];
  rt.order[l0.id] = ['rC']; rt.pool = rt.pool.filter((k) => k !== 'rC');
  await b.publicar();
  const p = ult(b);
  t('publica como siempre: saveRoutePlan(día, vueltas), sin opciones ni marcas', p.nArgs === 2 && p.opts === undefined && p.lanes.length === 1 && !('raId' in p.lanes[0]) && !('cambio' in p.lanes[0]), JSON.stringify([p.nArgs, Object.keys(p.lanes[0])]));
  t('…y con el aviso de siempre', /^Plan publicado/.test(b.dichos[b.dichos.length - 1]), b.dichos[b.dichos.length - 1]);
}

console.log(`\n${ok}/${ok + bad} pasaron`);
console.log('NO cubierto: la base real (RLS, FKs, filtros de PostgREST), dos jefes publicando en el mismo segundo, navegador y teléfono reales, push real.');
process.exit(bad ? 1 : 0);
