// Prueba de punta a punta de api-aux.js (window.ApiAux) contra el stack LOCAL
// de Supabase: GoTrue de verdad (usuarios con contraseña), PostgREST y RLS.
//
//   cd rendio-backend/scripts && node _smoke-api-aux-local.mjs
//
// Qué prueba que las _verify-008x (SQL puro) no:
//   · que el JS llama a las RPC con los nombres y argumentos correctos;
//   · la forma del viaje T que arma mapTrip, y que coincide con la de
//     Api.listMyReservations en los campos comunes (reloadTrips fusiona las dos);
//   · null sin sesión o sin RPC (nunca datos falsos); los errores del servidor
//     llegan con su texto;
//   · el push de Coordinación (título, destinatarios, URL) con un espía;
//   · Api.getMyAuxHeader (P0) leyendo lo que guarda ApiAux.saveMyPrefs.
//
// A DIFERENCIA de las _verify, esto NO corre en una transacción: crea una
// organización de prueba, 4 usuarios y sus filas, y los BORRA al final (también
// si algo falla). Mientras corre (unos segundos) existe una jefa de prueba más
// en la base local. Se niega a correr fuera de 127.0.0.1.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';

const API = 'http://127.0.0.1:54321';
const DB = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
// Secreto del stack local de Supabase CLI (el de fábrica, público). Nunca el de dev.
const SECRET = process.env.LOCAL_JWT_SECRET || 'super-secret-jwt-token-with-at-least-32-characters-long';
const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');

let ok = 0, fail = 0;
const t = (n, cond, det) => { if (cond) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + det : ''}`); } };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (p) => { const h = b64({ alg: 'HS256', typ: 'JWT' }), q = b64(p); return `${h}.${q}.${crypto.createHmac('sha256', SECRET).update(`${h}.${q}`).digest('base64url')}`; };
const now = Math.floor(Date.now() / 1000);
const ANON = sign({ role: 'anon', iss: 'supabase-demo', iat: now, exp: now + 3600 });
const SVC = sign({ role: 'service_role', iss: 'supabase-demo', iat: now, exp: now + 3600 });
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const PASS = 'Prueba-local-' + crypto.randomBytes(6).toString('hex');

const db = new pg.Client({ connectionString: DB }); await db.connect();
const one = async (s, p) => (await db.query(s, p)).rows[0];
const admin = createClient(API, SVC, opts);

// Un navegador de mentira con api.js + api-aux.js cargados sobre el cliente dado.
function navegador(sb) {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = dom.window;
  w.sb = sb;
  w.eval(read('api.js'));
  w.__push = [];
  w.Api.sendPush = async (p) => { w.__push.push(p); return { sent: 1 }; };
  w.eval(read('api-aux.js'));
  return w;
}
async function sesion(email) {
  const sb = createClient(API, ANON, opts);
  const { error } = await sb.auth.signInWithPassword({ email, password: PASS });
  if (error) throw new Error('No pude entrar como ' + email + ': ' + error.message);
  return navegador(sb);
}

const ids = { users: [] };
let opsAntes = null;
try {
  // ── Preparación ──────────────────────────────────────────────────────────
  const tag = crypto.randomBytes(3).toString('hex');
  const mk = async (who) => {
    const email = `p9.${who}.${tag}@prueba.local`;
    const { data, error } = await admin.auth.admin.createUser({ email, password: PASS, email_confirm: true });
    if (error) throw new Error('createUser: ' + error.message);
    ids.users.push(data.user.id);
    return { id: data.user.id, email };
  };
  const [A, B, J, D] = [await mk('a'), await mk('b'), await mk('jefa'), await mk('drv')];
  ids.org = (await one(`INSERT INTO public.organizations (name, slug) VALUES ('Prueba P9', 'prueba-p9-' || $1) RETURNING id`, [tag])).id;
  const res = (await one(`INSERT INTO public.residences (organization_id, name, latitude, longitude, sector) VALUES ($1, 'El Olivar', 6.1523, -75.3781, 'Rionegro') RETURNING id`, [ids.org])).id;
  for (const [u, role, name] of [[A, 'auxiliar', 'Laura Prueba'], [B, 'auxiliar', 'Bea Prueba'], [J, 'admin', 'Jefa Prueba'], [D, 'driver', 'Pedro Conductor']]) {
    await db.query(`INSERT INTO public.profiles (id, organization_id, role, full_name, email) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET organization_id = EXCLUDED.organization_id, role = EXCLUDED.role, full_name = EXCLUDED.full_name`, [u.id, ids.org, role, name, u.email]);
  }
  await db.query(`UPDATE public.profiles SET phone = '3001112233', avatar_url = 'https://x.test/p.jpg' WHERE id = $1`, [D.id]);
  const auxA = (await one(`INSERT INTO public.auxiliar_profiles (profile_id, residence_id, joined_at) VALUES ($1, $2, '2026-03-02') RETURNING id`, [A.id, res])).id;
  const auxB = (await one(`INSERT INTO public.auxiliar_profiles (profile_id, residence_id) VALUES ($1, $2) RETURNING id`, [B.id, res])).id;
  const drv = (await one(`INSERT INTO public.driver_profiles (profile_id) VALUES ($1) RETURNING id`, [D.id])).id;
  ids.drv = drv; ids.aux = [auxA, auxB];
  const veh = (await one(`INSERT INTO public.vehicles (organization_id, internal_code, license_plate, brand, model) VALUES ($1, 'P9-01', 'PNU913', 'Renault', 'Duster') RETURNING id`, [ids.org])).id;
  const reserva = async (aux, dir, when, notes) => (await one(`INSERT INTO public.reservations
      (auxiliar_profile_id, direction, status_h2a, status_a2h, required_arrival_at, notes, residence_id)
    VALUES ($1, $2::public.trip_direction,
      CASE WHEN $2 = 'home_to_airport' THEN 'requested'::public.reservation_status_h2a END,
      CASE WHEN $2 = 'airport_to_home' THEN 'scheduled'::public.reservation_status_a2h END,
      ${when}, $3, $4) RETURNING id, meet_code`, [aux, dir, notes, res]));
  // s1: sin plan. s2: publicado. l1: llegada a las 20:30 de Bogotá (dentro de 5 días). sB: de B.
  const s1 = await reserva(auxA, 'home_to_airport', "now() + interval '3 days'", 'Vuelo AV9412. Llevo perro');
  const s2 = await reserva(auxA, 'home_to_airport', "now() + interval '4 days'", 'Vuelo JA5116.');
  const l1 = await reserva(auxA, 'airport_to_home',
    "((date_trunc('day', now() AT TIME ZONE 'America/Bogota') + interval '5 days 20 hours 30 minutes') AT TIME ZONE 'America/Bogota')", 'Vuelo AV8520.');
  const sB = await reserva(auxB, 'home_to_airport', "now() + interval '3 days'", null);
  ids.res = [s1.id, s2.id, l1.id, sB.id];
  const ra = (await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at)
      VALUES ($1, $2, 'home_to_airport', 'planned', now() + interval '4 days' - interval '2 hours') RETURNING id`, [drv, veh])).id;
  await db.query(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at)
      VALUES ($1, $2, 1, now() + interval '4 days' - interval '95 minutes')`, [ra, s2.id]);
  opsAntes = await one(`SELECT ops_contact_phone, ops_contact_hours FROM public.app_settings WHERE id = 'singleton'`);

  // ── 1. Sin sesión ────────────────────────────────────────────────────────
  console.log('\n1. Sin sesión: todo null, nada inventado');
  const w0 = navegador(createClient(API, ANON, opts));
  t('window.ApiAux existe con el contrato completo',
    ['listMyTrips', 'getMyStats', 'saveMyPrefs', 'changeFlight', 'crewList', 'crewSend', 'crewMarkRead', 'crewUnread', 'crewThreadsAdmin', 'getOpsContact', 'setOpsContact', 'setVehicleColor']
      .every(k => typeof w0.ApiAux[k] === 'function'));
  t('listMyTrips → null', (await w0.ApiAux.listMyTrips()) === null);
  t('getMyStats → null', (await w0.ApiAux.getMyStats()) === null);
  t('crewList → null', (await w0.ApiAux.crewList()) === null);
  t('crewUnread → null', (await w0.ApiAux.crewUnread()) === null);
  t('getOpsContact → null', (await w0.ApiAux.getOpsContact()) === null);
  t('saveMyPrefs → null', (await w0.ApiAux.saveMyPrefs({ meetingPoint: 'x' })) === null);
  t('crewSend → null', (await w0.ApiAux.crewSend('hola')) === null);

  // ── 2. Tripulante A: mis viajes ──────────────────────────────────────────
  console.log('\n2. Tripulante A: mis viajes (forma T)');
  const wA = await sesion(A.email);
  const trips = await wA.ApiAux.listMyTrips();
  t('trae sus 3 (no el de B)', Array.isArray(trips) && trips.length === 3 && !trips.some(x => x.id === sB.id), trips && trips.length);
  const T1 = trips.find(x => x.id === s1.id), T2 = trips.find(x => x.id === s2.id), L1 = trips.find(x => x.id === l1.id);
  t('sin plan: pickupAt null, meetCode vacío, published false, driver null', T1 && T1.pickupAt === null && T1.meetCode === '' && T1.published === false && T1.driver === null, JSON.stringify(T1 && { p: T1.pickupAt, m: T1.meetCode }));
  t('vuelo y notas del tripulante separados', T1 && T1.flight === 'AV9412' && T1.notesUser === 'Llevo perro', T1 && `${T1.flight}/${T1.notesUser}`);
  t('publicado: pickupAt, código, conductor con first/initials/phone', T2 && T2.published && T2.pickupAt && T2.meetCode === s2.meet_code
    && T2.driver && T2.driver.first === 'Pedro' && T2.driver.initials === 'PC' && T2.driver.phone === '3001112233' && T2.driver.avatarUrl, JSON.stringify(T2 && T2.driver));
  t('publicado: estrella oculta con < 10 calificaciones', T2 && T2.driver.rating === null && T2.driver.ratingN === 0);
  t('publicado: vehicle con placa y t.driver.plate para lo heredado', T2 && T2.vehicle && T2.vehicle.plate === 'PNU913' && T2.vehicle.brand === 'Renault' && T2.driver.plate === 'PNU913', JSON.stringify(T2 && T2.vehicle));
  t('llegada de las 20:30 de Bogotá: time 20:30, type lle', L1 && L1.time === '20:30' && L1.type === 'lle', L1 && `${L1.date} ${L1.time}`);
  t('campos nuevos presentes', T1 && ['bags', 'quiet', 'meetingPoint', 'createdAt', 'stopStatus', 'arrivedAt', 'pickedAt', 'droppedAt', 'requiredAt'].every(k => k in T1));

  console.log('\n   …y coincide con Api.listMyReservations en lo común');
  const viejos = await wA.Api.listMyReservations();
  const COMUNES = ['id', 'type', 'date', 'time', 'status', 'flight', 'notes', 'notesUser', 'level', 'privateStatus', 'residenceId', 'address', 'isPernocta', 'isReserva', 'readyAt', 'rated', 'cancelledAt'];
  for (const v of viejos || []) {
    const n = trips.find(x => x.id === v.id);
    const dif = COMUNES.filter(k => JSON.stringify(v[k]) !== JSON.stringify(n && n[k]));
    t(`${v.type} ${v.date} ${v.time}: mismos ${COMUNES.length} campos`, n && dif.length === 0, dif.map(k => `${k}: ${JSON.stringify(v[k])} ≠ ${JSON.stringify(n && n[k])}`).join('; '));
  }
  t('pickupAt: la hora publicada es la misma en las dos fuentes', viejos && Date.parse(viejos.find(x => x.id === s2.id).pickupAt) === Date.parse(T2.pickupAt));

  // ── 3. Cifras y preferencias ─────────────────────────────────────────────
  console.log('\n3. Cifras y preferencias');
  const st = await wA.ApiAux.getMyStats();
  t('getMyStats: done 0, pct null (aún sin datos)', st && st.done === 0 && st.onTimePct === null && st.on_time_pct === null, JSON.stringify(st));
  t('saveMyPrefs guarda', (await wA.ApiAux.saveMyPrefs({ preferredLevel: 'private', meetingPoint: '  Portería 2  ' })) === true);
  const ap = await one(`SELECT preferred_service_level::text l, meeting_point m FROM public.auxiliar_profiles WHERE id = $1`, [auxA]);
  t('…en la base: private y «Portería 2»', ap.l === 'private' && ap.m === 'Portería 2', JSON.stringify(ap));
  const H = await wA.Api.getMyAuxHeader();
  t('Api.getMyAuxHeader (P0) lo lee: preferredLevel y meetingPoint', H && H.preferredLevel === 'private' && H.meetingPoint === 'Portería 2' && H.joinedAt === '2026-03-02', JSON.stringify(H && { l: H.preferredLevel, m: H.meetingPoint, j: H.joinedAt }));
  let e = null; try { await wA.ApiAux.saveMyPrefs({ meetingPoint: 'x'.repeat(121) }); } catch (x) { e = x.message; }
  t('punto de 121 → error claro', e && /120/.test(e), e);
  e = null; try { await wA.ApiAux.saveMyPrefs({ preferredLevel: 'directo' }); } catch (x) { e = x.message; }
  t('nivel que no existe → error', !!e, e);
  t('saveMyPrefs({meetingPoint:""}) borra solo el punto', (await wA.ApiAux.saveMyPrefs({ meetingPoint: '' })) === true
    && (await one(`SELECT meeting_point m, preferred_service_level::text l FROM public.auxiliar_profiles WHERE id = $1`, [auxA])).m === null);

  // ── 4. Cambió mi vuelo ───────────────────────────────────────────────────
  console.log('\n4. Cambió mi vuelo');
  const dia = (await one(`SELECT to_char((now() + interval '3 days') AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD') d`)).d;
  let cf = await wA.ApiAux.changeFlight(s1.id, { flight: 'av9500', date: dia, time: '23:10' });
  t('sin plan → updated', cf && cf.mode === 'updated', JSON.stringify(cf));
  const s1db = await one(`SELECT notes, to_char(required_arrival_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD HH24:MI') h FROM public.reservations WHERE id = $1`, [s1.id]);
  t('…la base tiene la hora de Bogotá y el vuelo nuevo', s1db.h === `${dia} 23:10` && s1db.notes === 'Vuelo AV9500. Llevo perro', JSON.stringify(s1db));
  const dia2 = (await one(`SELECT to_char((now() + interval '4 days') AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD') d`)).d;
  cf = await wA.ApiAux.changeFlight(s2.id, { flight: 'JA5116', date: dia2, time: '23:50' });
  t('publicado → needs_ops con incidentId', cf && cf.mode === 'needs_ops' && cf.incidentId, JSON.stringify(cf));
  e = null; try { await wA.ApiAux.changeFlight(s1.id, { flight: 'AV1', date: '2020-01-01', time: '05:00' }); } catch (x) { e = x.message; }
  t('hora pasada → el texto del servidor llega tal cual', e === 'Esa hora ya pasó', e);
  e = null; try { await wA.ApiAux.changeFlight(s1.id, { flight: 'AV1', date: 'mañana', time: '5' }); } catch (x) { e = x.message; }
  t('fecha mal formada → «Elige el día y la hora» (sin ir al servidor)', e === 'Elige el día y la hora', e);
  e = null; try { await wA.ApiAux.changeFlight(sB.id, { flight: 'AV9412', date: dia, time: '10:00' }); } catch (x) { e = x.message; }
  t('el traslado de B → «Ese traslado no es tuyo»', e === 'Ese traslado no es tuyo', e);

  // ── 5. Coordinación ──────────────────────────────────────────────────────
  console.log('\n5. Coordinación');
  const env = await wA.ApiAux.crewSend('No encuentro al conductor', { reservationId: s2.id });
  t('A envía: destinatarios incluyen a la jefa', env && env.recipients.includes(J.id) && env.senderRole === 'auxiliar', JSON.stringify(env));
  const p1 = wA.__push[0];
  t('push a los jefes: «Mensaje de un tripulante» → #/coordinacion?aux=', p1 && p1.title === 'Mensaje de un tripulante' && p1.url === '/#/coordinacion?aux=' + auxA && p1.profileIds.includes(J.id) && p1.body === 'No encuentro al conductor', JSON.stringify(p1));
  t('notified = true (el espía dijo sent:1)', env.notified === true);
  let hilo = await wA.ApiAux.crewList();
  t('crewList: 1 mensaje suyo con el traslado como contexto', hilo && hilo.length === 1 && hilo[0].mine && hilo[0].role === 'auxiliar' && hilo[0].reservation && hilo[0].reservation.id === s2.id && hilo[0].reservation.type === 'sal', JSON.stringify(hilo));
  e = null; try { await wA.ApiAux.crewSend('   '); } catch (x) { e = x.message; }
  t('mensaje vacío → «Escribe el mensaje»', e === 'Escribe el mensaje', e);
  const wB = await sesion(B.email);
  t('B no ve el hilo de A (crewList → [])', JSON.stringify(await wB.ApiAux.crewList()) === '[]');
  t('B ve solo su viaje', (await wB.ApiAux.listMyTrips()).map(x => x.id).join() === sB.id);
  const wJ = await sesion(J.email);
  const th = await wJ.ApiAux.crewThreadsAdmin();
  t('bandeja de la jefa: el hilo de A con 1 sin leer', th && th.length === 1 && th[0].auxId === auxA && th[0].unread === 1 && th[0].name === 'Laura Prueba' && th[0].residence === 'El Olivar', JSON.stringify(th));
  t('jefa: crewUnread = 1', (await wJ.ApiAux.crewUnread()) === 1);
  const rj = await wJ.ApiAux.crewSend('Ya te llamamos', { auxId: auxA });
  const p2 = wJ.__push[0];
  t('la jefa responde: push «Coordinación» a A → #/coordinacion', rj && p2 && p2.title === 'Coordinación' && p2.url === '/#/coordinacion' && JSON.stringify(p2.profileIds) === JSON.stringify([A.id]), JSON.stringify(p2));
  t('jefa marca leído el hilo de A (1)', (await wJ.ApiAux.crewMarkRead(auxA)) === 1);
  t('A: 1 sin leer', (await wA.ApiAux.crewUnread()) === 1);
  hilo = await wA.ApiAux.crewList();
  const ult = hilo[hilo.length - 1];
  t('A ve «admin», mine=false, sin id de quién', ult.role === 'admin' && ult.mine === false && !('sender_profile_id' in ult), JSON.stringify(ult));
  t('A marca leído (1) y queda en 0', (await wA.ApiAux.crewMarkRead()) === 1 && (await wA.ApiAux.crewUnread()) === 0);
  t('un tripulante pidiendo la bandeja → null', (await wA.ApiAux.crewThreadsAdmin()) === null);

  // ── 6. Contacto de Coordinación y color del carro ────────────────────────
  console.log('\n6. Contacto de Coordinación y color');
  t('sin cargar: {phone:"", hours:""} (la pantalla no muestra nada)', JSON.stringify(await wA.ApiAux.getOpsContact()) === JSON.stringify({ phone: String(opsAntes.ops_contact_phone || ''), hours: String(opsAntes.ops_contact_hours || '') }));
  t('la jefa guarda teléfono y horario', (await wJ.ApiAux.setOpsContact({ phone: '6045551234', hours: 'Todos los días · 3:00 a. m. a 11:00 p. m.' })) === true);
  const oc = await wA.ApiAux.getOpsContact();
  t('A los lee', oc && oc.phone === '6045551234' && /3:00/.test(oc.hours), JSON.stringify(oc));
  e = null; try { await wA.ApiAux.setOpsContact({ phone: '1' }); } catch (x) { e = x.message; }
  t('A no puede cambiarlos (error claro)', e && /administrador/.test(e), e);
  t('la jefa pone el color del carro', (await wJ.ApiAux.setVehicleColor(veh, 'Blanco')) === true);
  const T2b = (await wA.ApiAux.listMyTrips()).find(x => x.id === s2.id);
  t('…y A lo ve en su viaje', T2b && T2b.vehicle && T2b.vehicle.color === 'Blanco', JSON.stringify(T2b && T2b.vehicle));
  e = null; try { await wA.ApiAux.setVehicleColor(veh, 'Rosado'); } catch (x) { e = x.message; }
  t('A no puede cambiar el color', !!e, e);

  // ── 7. Conductor y base sin migraciones ──────────────────────────────────
  console.log('\n7. Conductor, y una base sin 0086–0089');
  const wD = await sesion(D.email);
  t('conductor: listMyTrips → null (no es tripulante)', (await wD.ApiAux.listMyTrips()) === null);
  t('conductor: getMyStats → null', (await wD.ApiAux.getMyStats()) === null);
  // Cliente que responde como PostgREST cuando la función/columna no existe.
  const sinMig = {
    auth: { getSession: async () => ({ data: { session: { user: { id: A.id } } } }) },
    rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.auxiliar_my_trips' } }),
    from: () => { const q = { update: () => q, select: () => q, eq: () => q, maybeSingle: async () => ({ data: null, error: { code: '42703', message: 'column does not exist' } }), then: (res) => res({ data: null, error: { code: 'PGRST204', message: "Could not find the 'meeting_point' column" } }) }; return q; },
  };
  const wX = navegador(sinMig);
  t('RPC ausente: listMyTrips → null', (await wX.ApiAux.listMyTrips()) === null);
  t('RPC ausente: changeFlight → null (no lanza)', (await wX.ApiAux.changeFlight(s1.id, { flight: 'AV1', date: dia, time: '10:00' })) === null);
  t('RPC ausente: crewSend → null', (await wX.ApiAux.crewSend('hola')) === null);
  t('columna ausente: saveMyPrefs → null', (await wX.ApiAux.saveMyPrefs({ meetingPoint: 'x' })) === null);
  t('columna ausente: getOpsContact → null', (await wX.ApiAux.getOpsContact()) === null);
  t('columna ausente: setVehicleColor → null', (await wX.ApiAux.setVehicleColor(veh, 'Azul')) === null);
} catch (err) {
  fail++; console.log('  ✗ EXCEPCIÓN: ' + (err && err.stack || err));
} finally {
  // ── Limpieza: no queda nada de la prueba ─────────────────────────────────
  try {
    if (opsAntes) await db.query(`UPDATE public.app_settings SET ops_contact_phone = $1, ops_contact_hours = $2 WHERE id = 'singleton'`, [opsAntes.ops_contact_phone, opsAntes.ops_contact_hours]);
    if (ids.org) {
      await db.query(`DELETE FROM public.incidents WHERE organization_id = $1`, [ids.org]);
      await db.query(`DELETE FROM public.crew_messages WHERE organization_id = $1`, [ids.org]).catch(() => {});
    }
    if (ids.drv) await db.query(`DELETE FROM public.route_assignments WHERE driver_profile_id = $1`, [ids.drv]);
    if (ids.res) await db.query(`DELETE FROM public.audit_events WHERE entity_id = ANY($1::uuid[])`, [ids.res]).catch(() => {});
    if (ids.aux) await db.query(`DELETE FROM public.reservations WHERE auxiliar_profile_id = ANY($1::uuid[])`, [ids.aux]);
    if (ids.users.length) await db.query(`DELETE FROM auth.users WHERE id = ANY($1::uuid[])`, [ids.users]);
    if (ids.org) {
      await db.query(`DELETE FROM public.vehicles WHERE organization_id = $1`, [ids.org]);
      await db.query(`DELETE FROM public.airports WHERE organization_id = $1`, [ids.org]);
      await db.query(`DELETE FROM public.organizations WHERE id = $1`, [ids.org]);
    }
    const quedan = await one(`SELECT (SELECT count(*) FROM auth.users WHERE id = ANY($1::uuid[]))::int u,
        (SELECT count(*) FROM public.organizations WHERE id = $2)::int o`, [ids.users, ids.org || null]);
    t('limpieza: no quedó ningún usuario ni la organización de prueba', quedan.u === 0 && quedan.o === 0, JSON.stringify(quedan));
  } catch (e) { fail++; console.log('  ✗ LIMPIEZA: ' + e.message); }
  await db.end();
}
console.log(`\n${ok} ✓ · ${fail} ✗`);
console.log('NO cubre: layout, animación, Leaflet real, push real (sendPush es un espía), ni la base de dev/producción.');
process.exit(fail ? 1 : 0);
