// Verificación de 0099: estado de vuelos.
//   1. flight_code_from_notes = la misma lectura que _flightFromNotes de api.js
//   2. relleno (backfill) desde las notas, sin mover updated_at
//   3. disparador: insertar, «Cambió mi vuelo» (notas nuevas), código a mano
//   4. flight_status_targets: ventana de 12 h, sin repetir, 20 min / 120 min,
//      lo terminado no se consulta, otra organización aparte, bandera apagada
//   5. flight_status_record: upsert y un «unknown» no pisa un dato bueno
//   6. flight_delay_alerts: texto, destinatarios (jefes marcados de la org +
//      conductor de la ruta publicada), dedupe, umbral de 15 min, cancelado,
//      salidas no avisan, bandera apagada, no toca required_arrival_at
//   7. RLS de flight_statuses y permisos de las funciones
//   8. poll_flight_status y el cron
//
// Base LOCAL (127.0.0.1:54322), todo dentro de una transacción que se deshace.
// Filtra siempre por las organizaciones de la prueba: la base local puede tener
// otras filas.
//   cd rendio-backend && node scripts/_verify-0099.mjs
//
// LO QUE NO CUBRE: la Edge Function (Deno, llamada HTTP al proveedor), pg_net
// de verdad (la petición queda en cola y se deshace con el ROLLBACK), el push.
import { localClient, fixtures, user } from './_local-fixtures.mjs';

const c = await localClient();
const q = async (s, p) => (await c.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
let ok = 0, fail = 0;
const check = (n, cond, det) => { if (cond) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + det : ''}`); } };
const como = async (uid) => { await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]); await c.query('SET LOCAL ROLE authenticated'); };
const comoDb = async () => { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', '', true)`); };
async function intenta(sql, params) {
  await c.query('SAVEPOINT sp');
  try { const r = await c.query(sql, params); await c.query('RELEASE SAVEPOINT sp'); return { rows: r.rows, count: r.rowCount }; }
  catch (e) { await c.query('ROLLBACK TO SAVEPOINT sp'); return { err: e.message }; }
}
// La misma función de api.js (y api-aux.js), copiada tal cual.
function _flightFromNotes(notes) {
  const m = String(notes || '').match(/vuelo\s*:?\s*([A-Za-z]{0,3})\s*-?\s*(\d{2,5})/i);
  return m ? (m[1] + m[2]).toUpperCase() : '';
}
const hhmm = (d) => new Date(d).toLocaleTimeString('en-GB', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false });

await c.query('BEGIN');
try {
  await q(`INSERT INTO public.app_settings (id) VALUES ('singleton') ON CONFLICT (id) DO NOTHING`);
  // Desembarques fijos para la prueba (no dependen de lo que tenga la base local).
  await q(`UPDATE public.app_settings SET flight_api_enabled = true, route_deplane_min = 19,
             route_deplane_av_nac_min = 15, route_deplane_av_int_min = 20, route_deplane_js_nac_min = 25,
             route_deplane_js_int_min = 30, route_deplane_wingo_min = 22 WHERE id = 'singleton'`);

  const fx = await fixtures(c);
  // Otra organización (fixtures() no se puede llamar dos veces: repite correos).
  const otraOrg = async (tag) => {
    const org = (await one(`INSERT INTO public.organizations (name, slug) VALUES ($1, $2 || substr(md5(random()::text), 1, 6)) RETURNING id`, ['Prueba ' + tag, 'prueba-' + tag + '-'])).id;
    const resi = (await one(`INSERT INTO public.residences (organization_id, name, latitude, longitude, sector) VALUES ($1, 'El Olivar', 6.1523, -75.3781, 'Rionegro') RETURNING id`, [org])).id;
    const auxUser = await user(c, org, 'auxiliar', 'Tripulante de ' + tag);
    const aux = (await one(`INSERT INTO public.auxiliar_profiles (profile_id, residence_id) VALUES ($1, $2) RETURNING id`, [auxUser, resi])).id;
    return { org, olivar: resi, auxUser, aux };
  };
  const fx2 = await otraOrg('dos');
  const jefe = await user(c, fx.org, 'admin', 'Jefa marcada');
  const jefe2 = await user(c, fx.org, 'admin', 'Jefe sin marcar');
  const jefeOtra = await user(c, fx2.org, 'admin', 'Jefe de otra organización');
  await q(`UPDATE public.profiles SET receives_ops_alerts = true WHERE id = ANY($1::uuid[])`, [[jefe, jefeOtra]]);
  const drv2User = await user(c, fx.org, 'driver', 'Conductor de ruta cancelada');
  const drv2 = (await one(`INSERT INTO public.driver_profiles (profile_id) VALUES ($1) RETURNING id`, [drv2User])).id;
  const solaUser = await user(c, fx.org, 'auxiliar', 'Tripulante sin vuelos');
  await q(`INSERT INTO public.auxiliar_profiles (profile_id, residence_id) VALUES ($1, $2)`, [solaUser, fx.olivar]);

  const at = async (min) => (await one(`SELECT now() + make_interval(mins => $1::int) AS t`, [min])).t;
  const res = async (aux, dir, whenMin, notes, extra = {}) => (await one(`INSERT INTO public.reservations
      (auxiliar_profile_id, direction, status_h2a, status_a2h, required_arrival_at, residence_id, notes, ground_ops, cancelled_at)
    VALUES ($1, $2::public.trip_direction,
      CASE WHEN $2 = 'home_to_airport' THEN coalesce($7, 'requested')::public.reservation_status_h2a END,
      CASE WHEN $2 = 'airport_to_home' THEN coalesce($7, 'scheduled')::public.reservation_status_a2h END,
      now() + make_interval(mins => $3::int), $4, $5, $6, $8) RETURNING id, flight_code, required_arrival_at`,
    [aux, dir, whenMin, fx.olivar, notes, !!extra.ground, extra.status || null, extra.cancelled ? new Date() : null]));
  const orgs = [fx.org, fx2.org];
  const targets = async (pNow, limit) => q(`SELECT * FROM public.flight_status_targets(coalesce($1::timestamptz, now()), $2) WHERE organization_id = ANY($3::uuid[]) ORDER BY organization_id, flight_code`,
    [pNow || null, limit || 50, orgs]);

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n1. flight_code_from_notes = _flightFromNotes de la app');
  const notas = ['Vuelo AV9412. Hola', 'Vuelo AV-9412.', 'Vuelo ja 5116.', 'Vuelo 5116.', 'vuelo: LA4025 llego cansada',
    'Sin vuelo', '', null, 'Vuelo J65417. · Regreso del mismo día', 'VUELO AVA 9563', 'Vuelo de las 5', 'Vuelo AV9 ',
    'nota vuelo P5 7400 y vuelo AV1', 'Vuelo AV123456', 'El vuelo   -  4025', 'vuelo:jec1234'];
  const malas = [];
  for (const n of notas) {
    const pg = (await one(`SELECT public.flight_code_from_notes($1) v`, [n])).v;
    if ((pg ?? '') !== _flightFromNotes(n)) malas.push(`${JSON.stringify(n)}: sql=${pg} js=${_flightFromNotes(n)}`);
  }
  check(`las ${notas.length} notas de prueba dan el mismo vuelo en SQL y en JS`, malas.length === 0, malas.join(' | '));

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n2. Relleno desde las notas');
  await q(`ALTER TABLE public.reservations DISABLE TRIGGER tr_reservations_flight_code`);
  const v1 = await res(fx.aux, 'airport_to_home', 600, 'Vuelo AV-9412. Llego con maleta');
  const v2 = await res(fx.aux, 'home_to_airport', 900, 'Vuelo la 4025.');
  const v3 = await res(fx.aux, 'home_to_airport', 950, 'Sin número');
  await q(`ALTER TABLE public.reservations ENABLE TRIGGER tr_reservations_flight_code`);
  check('sin el disparador nacen sin código (como las reservas de antes)', v1.flight_code === null && v2.flight_code === null);
  // (fijar updated_at a mano también dispara set_updated_at: se apaga para esto)
  await q(`ALTER TABLE public.reservations DISABLE TRIGGER tr_reservations_set_updated_at`);
  await q(`UPDATE public.reservations SET updated_at = '2026-01-01T00:00:00Z' WHERE id = ANY($1::uuid[])`, [[v1.id, v2.id, v3.id]]);
  await q(`ALTER TABLE public.reservations ENABLE TRIGGER tr_reservations_set_updated_at`);
  const n = (await one(`SELECT public.backfill_reservation_flight_codes() n`)).n;
  const rel = await q(`SELECT id, flight_code, updated_at FROM public.reservations WHERE id = ANY($1::uuid[])`, [[v1.id, v2.id, v3.id]]);
  const by = Object.fromEntries(rel.map(r => [r.id, r]));
  check('relleno: AV-9412 → AV9412, la 4025 → LA4025, sin número → NULL', by[v1.id].flight_code === 'AV9412' && by[v2.id].flight_code === 'LA4025' && by[v3.id].flight_code === null, JSON.stringify(rel.map(r => r.flight_code)));
  check('el relleno cuenta lo que llenó (≥ 2)', Number(n) >= 2, n);
  check('el relleno NO mueve updated_at', rel.every(r => new Date(r.updated_at).toISOString() === '2026-01-01T00:00:00.000Z'), rel.map(r => r.updated_at).join());
  const trg = await one(`SELECT tgenabled FROM pg_trigger WHERE tgname = 'tr_reservations_set_updated_at' AND tgrelid = 'public.reservations'::regclass`);
  check('…y deja encendido el disparador de updated_at', trg && trg.tgenabled === 'O', trg && trg.tgenabled);

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n3. Disparador');
  const d1 = await res(fx.aux, 'airport_to_home', 700, 'Vuelo AV9563. Ojo con la maleta');
  check('al insertar, el código sale de las notas', d1.flight_code === 'AV9563', d1.flight_code);
  const d2 = (await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_a2h, required_arrival_at, residence_id, notes, flight_code)
      VALUES ($1, 'airport_to_home', 'scheduled', now() + interval '11 hours', $2, 'Vuelo LA4025.', 'av-9563') RETURNING flight_code`, [fx.aux, fx.olivar])).flight_code;
  check('código escrito a mano gana y se normaliza (av-9563 → AV9563)', d2 === 'AV9563', d2);
  await q(`UPDATE public.reservations SET notes = 'Vuelo LA4025. Ojo con la maleta' WHERE id = $1`, [d1.id]);
  let cod = (await one(`SELECT flight_code FROM public.reservations WHERE id = $1`, [d1.id])).flight_code;
  check('«Cambió mi vuelo» (notas nuevas) → el código se recalcula', cod === 'LA4025', cod);
  await q(`UPDATE public.reservations SET bags = 2 WHERE id = $1`, [d1.id]);
  cod = (await one(`SELECT flight_code FROM public.reservations WHERE id = $1`, [d1.id])).flight_code;
  check('cambiar otra cosa no lo toca', cod === 'LA4025', cod);
  await q(`UPDATE public.reservations SET flight_code = 'p5 7400' WHERE id = $1`, [d1.id]);
  cod = (await one(`SELECT flight_code FROM public.reservations WHERE id = $1`, [d1.id])).flight_code;
  check('escribirlo a mano en un UPDATE: P5 7400 → P57400', cod === 'P57400', cod);
  await q(`UPDATE public.reservations SET notes = 'Ya no tengo vuelo' WHERE id = $1`, [d1.id]);
  cod = (await one(`SELECT flight_code FROM public.reservations WHERE id = $1`, [d1.id])).flight_code;
  check('notas sin vuelo → NULL (lo mismo que lee la app)', cod === null, cod);
  const mala = await intenta(`UPDATE public.reservations SET flight_code = '¿¿??' WHERE id = $1`, [d1.id]);
  check('un código con basura se rechaza', !!mala.err, JSON.stringify(mala));
  await q(`DELETE FROM public.reservations WHERE id = ANY($1::uuid[])`, [[v1.id, v2.id, v3.id, d1.id]]);
  await q(`DELETE FROM public.reservations WHERE auxiliar_profile_id = $1 AND flight_code = 'AV9563' AND notes = 'Vuelo LA4025.'`, [fx.aux]);

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n4. Qué vuelos consultar');
  const A = await res(fx.aux, 'airport_to_home', 120, 'Vuelo AV9563. ');
  const B = await res(fx.vecino, 'airport_to_home', 125, 'Vuelo AV 9563. ');
  const C = await res(fx.vecino, 'home_to_airport', 300, 'Vuelo LA4025. ');
  await res(fx.aux, 'airport_to_home', 13 * 60, 'Vuelo AV1111.');                       // fuera de 12 h
  await res(fx.aux, 'airport_to_home', 180, 'Vuelo 5116.');                             // sin sigla
  await res(fx.aux, 'airport_to_home', 60, 'Vuelo AV2222.', { cancelled: true });       // cancelada
  await res(fx.aux, 'airport_to_home', 60, 'Vuelo AV3333.', { ground: true });          // tierra
  await res(fx.aux, 'airport_to_home', -120, 'Vuelo AV4444.');                          // ya pasó, sin dato
  const I = await res(fx.aux, 'airport_to_home', -120, 'Vuelo AV5555.');                // ya pasó, pero viene tarde
  await res(fx.aux, 'airport_to_home', 60, 'Vuelo AV6666.', { status: 'delivered' });   // entregada
  const O = await res(fx2.aux, 'airport_to_home', 130, 'Vuelo AV9563.');               // la otra organización
  check('las reservas nacen con su código', A.flight_code === 'AV9563' && B.flight_code === 'AV9563' && C.flight_code === 'LA4025', [A.flight_code, B.flight_code, C.flight_code].join());

  let T = await targets();
  const codes = (rows) => rows.map(r => `${r.organization_id === fx.org ? 'o1' : 'o2'}:${r.flight_code}:${r.direction === 'airport_to_home' ? 'lle' : 'sal'}`).sort();
  check('sin datos todavía: AV9563 (las dos reservas = 1), LA4025 y el AV9563 de la otra organización',
    JSON.stringify(codes(T)) === JSON.stringify(['o1:AV9563:lle', 'o1:LA4025:sal', 'o2:AV9563:lle']), JSON.stringify(codes(T)));
  const tA = T.find(r => r.organization_id === fx.org && r.flight_code === 'AV9563');
  check('…el grupo cuenta 2 reservas y su hora es la más temprana', tA && tA.reservations === 2 && new Date(tA.ref_at).getTime() === new Date(A.required_arrival_at).getTime(), tA && `${tA.reservations} ${tA.ref_at}`);
  check('…su día es el día de Bogotá de la reserva', tA && (await one(`SELECT ($1::timestamptz AT TIME ZONE 'America/Bogota')::date::text d`, [A.required_arrival_at])).d === (await one(`SELECT $1::date::text d`, [tA.flight_date])).d);
  const day = async (r) => (await one(`SELECT ($1::timestamptz AT TIME ZONE 'America/Bogota')::date::text d`, [r.required_arrival_at])).d;
  const dA = await day(A), dC = await day(C), dI = await day(I), dO = await day(O);

  // flight_status_record
  const rec = async (rows) => (await one(`SELECT public.flight_status_record($1::jsonb) n`, [JSON.stringify(rows)])).n;
  const fsRow = async (org, code, dir) => one(`SELECT * FROM public.flight_statuses WHERE organization_id = $1 AND flight_code = $2 AND direction = $3`, [org, code, dir]);
  const base = (org, code, d, dir, o = {}) => Object.assign({ organization_id: org, flight_code: code, flight_date: d, direction: dir, source: 'mock', raw: { prueba: true } }, o);

  await rec([base(fx.org, 'AV5555', dI, 'airport_to_home', { status: 'delayed', sched_at: await at(-120), estimated_at: await at(20), delay_min: 140, fetched_at: await at(-30) })]);
  T = await targets();
  check('vuelo de hace 2 h que sigue en el aire (estimada en 20 min): se consulta', T.some(r => r.flight_code === 'AV5555'), JSON.stringify(codes(T)));
  check('el de hace 2 h sin dato (AV4444): no', !T.some(r => r.flight_code === 'AV4444'));

  await rec([base(fx.org, 'AV9563', dA, 'airport_to_home', { status: 'scheduled', sched_at: A.required_arrival_at, fetched_at: await at(-10) })]);
  T = await targets();
  check('consultado hace 10 min: no se repite', !T.some(r => r.organization_id === fx.org && r.flight_code === 'AV9563'));
  check('…pero el de la otra organización sigue (es otra fila)', T.some(r => r.organization_id === fx2.org && r.flight_code === 'AV9563'));
  await q(`UPDATE public.flight_statuses SET fetched_at = now() - interval '25 minutes' WHERE organization_id = $1 AND flight_code = 'AV9563'`, [fx.org]);
  T = await targets();
  check('consultado hace 25 min (aterriza en 2 h): vuelve a tocar', T.some(r => r.organization_id === fx.org && r.flight_code === 'AV9563'));

  await rec([base(fx.org, 'LA4025', dC, 'home_to_airport', { status: 'scheduled', sched_at: await at(390), fetched_at: await at(-30) })]);
  T = await targets();
  check('salida a 5 h consultada hace 30 min: espera (lejos = cada 2 h)', !T.some(r => r.flight_code === 'LA4025'));
  await q(`UPDATE public.flight_statuses SET fetched_at = now() - interval '130 minutes' WHERE flight_code = 'LA4025' AND organization_id = $1`, [fx.org]);
  T = await targets();
  check('…consultada hace 130 min: vuelve a tocar', T.some(r => r.flight_code === 'LA4025'));
  T = await targets(null, 1);
  check('p_limit = 1 → solo el más próximo', T.length <= 1 && (T.length === 0 || T[0].flight_code === 'AV5555' || T[0].flight_code === 'AV9563'), JSON.stringify(codes(T)));

  await q(`UPDATE public.flight_statuses SET status = 'in_air', fetched_at = now() - interval '3 hours' WHERE flight_code = 'LA4025' AND organization_id = $1`, [fx.org]);
  await q(`UPDATE public.flight_statuses SET status = 'landed', fetched_at = now() - interval '3 hours' WHERE flight_code = 'AV5555' AND organization_id = $1`, [fx.org]);
  T = await targets();
  check('salida que despegó y llegada que aterrizó: no se consultan más', !T.some(r => r.flight_code === 'LA4025' || r.flight_code === 'AV5555'), JSON.stringify(codes(T)));
  await q(`UPDATE public.flight_statuses SET status = 'scheduled', fetched_at = now() - interval '3 hours' WHERE flight_code = 'LA4025' AND organization_id = $1`, [fx.org]);

  await q(`UPDATE public.app_settings SET flight_api_enabled = false WHERE id = 'singleton'`);
  T = await targets();
  check('bandera apagada → no hay nada que consultar', T.length === 0, T.length);
  await q(`UPDATE public.app_settings SET flight_api_enabled = true WHERE id = 'singleton'`);

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n5. Guardar lo que trajo el proveedor');
  const est = await at(145);   // 25 min después de la reserva A
  let nrec = await rec([base(fx.org, 'av 9563', dA, 'airport_to_home', { status: 'in_air', sched_at: A.required_arrival_at, estimated_at: est, delay_min: 25, terminal: '1', gate: '12' })]);
  let fsA = await fsRow(fx.org, 'AV9563', 'airport_to_home');
  check('upsert sobre la misma fila (código normalizado), con sus datos', nrec === 1 && fsA.status === 'in_air' && fsA.delay_min === 25 && fsA.gate === '12', JSON.stringify({ nrec, s: fsA.status, d: fsA.delay_min }));
  check('…y fetched_at = ahora', Date.now() - new Date(fsA.fetched_at).getTime() < 120000);
  const nUnico = Number((await one(`SELECT count(*) n FROM public.flight_statuses WHERE organization_id = $1 AND flight_code = 'AV9563'`, [fx.org])).n);
  check('una sola fila por organización+vuelo+día+sentido', nUnico === 1, nUnico);
  await q(`UPDATE public.flight_statuses SET fetched_at = now() - interval '1 hour' WHERE id = $1`, [fsA.id]);
  await rec([base(fx.org, 'AV9563', dA, 'airport_to_home', { status: 'unknown', raw: { motivo: 'no lo encontré' } })]);
  const fsU = await fsRow(fx.org, 'AV9563', 'airport_to_home');
  check('un «unknown» después de un dato bueno NO lo borra…', fsU.status === 'in_air' && fsU.delay_min === 25 && fsU.estimated_at !== null && fsU.raw && !fsU.raw.motivo, JSON.stringify({ s: fsU.status, d: fsU.delay_min }));
  check('…pero anota la consulta (respeta los 20 min)', Date.now() - new Date(fsU.fetched_at).getTime() < 120000);
  const malo = await intenta(`SELECT public.flight_status_record($1::jsonb)`, [JSON.stringify([base(fx.org, 'AV9563', dA, 'airport_to_home', { status: 'volando' })])]);
  check('un estado inventado se rechaza', !!malo.err);

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n6. Avisos');
  // Plan publicado: A en la ruta del conductor (planned); B en una ruta CANCELADA de otro.
  const ra1 = (await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at) VALUES ($1, $2, 'airport_to_home', 'planned', now() + interval '2 hours') RETURNING id`, [fx.driver, fx.vehicle])).id;
  await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order) VALUES ($1, $2, 1)`, [ra1, A.id]);
  const ra2 = (await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at) VALUES ($1, $2, 'airport_to_home', 'cancelled', now() + interval '2 hours') RETURNING id`, [drv2, fx.vehicle])).id;
  await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order) VALUES ($1, $2, 1)`, [ra2, B.id]);

  const dep = Number((await one(`SELECT public.flight_deplane_min('AV9563') n`)).n);
  check('desembarque de AV9563 = Avianca nacional (15)', dep === 15, dep);
  // Dentro de la transacción now() no avanza: los avisos se separan por su
  // dedupe_key (flt:<vuelo>:<tipo>:<persona>), no por la hora.
  const outbox = async (kind) => q(`SELECT profile_id, title, body, url, dedupe_key FROM public.notification_outbox
      WHERE dedupe_key LIKE 'flt:' || $1::text || ':' || coalesce($2, '') || '%' ORDER BY profile_id`, [fsA.id, kind ? kind + ':' : null]);
  const alerts = async () => Number((await one(`SELECT public.flight_delay_alerts() n`)).n);
  const quien = (rows) => rows.map(r => r.profile_id === jefe ? 'jefa' : r.profile_id === fx.drvUser ? 'conductor' : r.profile_id === jefe2 ? 'jefe2' : r.profile_id === jefeOtra ? 'otra' : r.profile_id === drv2User ? 'conductor2' : 'otro').sort();
  const losDos = (rows) => JSON.stringify(quien(rows)) === JSON.stringify(['conductor', 'jefa']);

  let nA = await alerts();
  let ob = await outbox();
  check('25 min tarde → avisa a la jefa marcada y al conductor de la ruta publicada', losDos(ob), JSON.stringify(quien(ob)));
  check('no al admin sin marcar (hay alguien marcado), ni al de otra organización, ni al conductor de la ruta cancelada', !quien(ob).some(x => ['jefe2', 'otra', 'conductor2'].includes(x)));
  const esperado = `Vuelo AV9563 aterriza ${hhmm(est)} (25 min tarde). Recogida sugerida ${hhmm(new Date(est).getTime() + 15 * 60000)}`;
  check('el texto: «' + esperado + '»', ob.length && ob.every(r => r.body === esperado), ob[0] && ob[0].body);
  check('título «Vuelo retrasado»; la jefa va a Reservas y el conductor a su ruta', ob.every(r => r.title === 'Vuelo retrasado') && ob.find(r => r.profile_id === jefe)?.url === '/#/reservas' && ob.find(r => r.profile_id === fx.drvUser)?.url === '/', JSON.stringify(ob.map(r => [r.title, r.url])));
  check('dedupe_key = flt:<vuelo>:delay:25:<persona>', ob.every(r => r.dedupe_key === `flt:${fsA.id}:delay:25:${r.profile_id}`), ob[0] && ob[0].dedupe_key);
  nA = await alerts();
  check('correrlo otra vez no repite (nada nuevo en ningún vuelo)', nA === 0 && (await outbox()).length === 2, nA);

  const setDelay = async (d) => q(`UPDATE public.flight_statuses SET delay_min = $2, estimated_at = sched_at + make_interval(mins => $2::int) WHERE id = $1`, [fsA.id, d]);
  await setDelay(32);
  nA = await alerts();
  check('25 → 32 (cambió 7): no avisa', nA === 0 && (await outbox()).length === 2, nA);
  await setDelay(45);
  nA = await alerts();
  ob = await outbox('delay:45');
  check('25 → 45 (cambió 20): avisa otra vez a los dos', nA === 2 && losDos(ob) && ob.every(r => /\(45 min tarde\)/.test(r.body)), `${nA} ${ob[0] && ob[0].body}`);
  await setDelay(10);
  await alerts();
  ob = await outbox('delay:10');
  check('45 → 10 (se puso al día): avisa «(10 min tarde)»', losDos(ob) && ob.every(r => /\(10 min tarde\)/.test(r.body)), ob[0] && ob[0].body);
  await setDelay(-15);
  await alerts();
  ob = await outbox('delay:-15');
  check('10 → -15: «Vuelo adelantado … (15 min antes)»', losDos(ob) && ob.every(r => r.title === 'Vuelo adelantado' && /\(15 min antes\)/.test(r.body)), ob[0] && `${ob[0].title} · ${ob[0].body}`);
  await q(`UPDATE public.flight_statuses SET status = 'landed', actual_at = sched_at + interval '2 minutes', delay_min = 2 WHERE id = $1`, [fsA.id]);
  await alerts();
  ob = await outbox('delay:2');
  check('aterrizó 2 min tarde (-15 → 2, cambió 17): «aterrizó … (2 min tarde)»', losDos(ob) && ob.every(r => / aterrizó \d{2}:\d{2} \(2 min tarde\)/.test(r.body)), ob[0] && ob[0].body);
  await q(`UPDATE public.flight_statuses SET status = 'cancelled', actual_at = NULL, estimated_at = NULL, delay_min = NULL WHERE id = $1`, [fsA.id]);
  await alerts();
  ob = await outbox('cancelled');
  check('cancelado: «Vuelo cancelado … aparece cancelado»', losDos(ob) && ob.every(r => r.title === 'Vuelo cancelado' && /aparece cancelado/.test(r.body)), ob[0] && ob[0].body);
  nA = await alerts();
  check('…una sola vez', nA === 0 && (await outbox('cancelled')).length === 2, nA);
  const n5555 = (await q(`SELECT 1 FROM public.notification_outbox o JOIN public.flight_statuses f ON o.dedupe_key LIKE 'flt:' || f.id::text || ':%' WHERE f.organization_id = $1 AND f.flight_code = 'AV5555'`, [fx.org])).length;
  check('el vuelo de anoche que aterrizó 140 min tarde también avisó (a la jefa: sin ruta, sin conductor)', n5555 === 1, n5555);
  const ra = await one(`SELECT required_arrival_at FROM public.reservations WHERE id = $1`, [A.id]);
  check('required_arrival_at NO se tocó', new Date(ra.required_arrival_at).getTime() === new Date(A.required_arrival_at).getTime());

  // Salida retrasada: no avisa (el aviso es de llegadas).
  await rec([base(fx.org, 'LA4025', dC, 'home_to_airport', { status: 'delayed', sched_at: await at(390), estimated_at: await at(430), delay_min: 40 })]);
  const fsC = await fsRow(fx.org, 'LA4025', 'home_to_airport');
  nA = await alerts();
  const obC = await q(`SELECT 1 FROM public.notification_outbox WHERE dedupe_key LIKE 'flt:' || $1::text || ':%'`, [fsC.id]);
  check('una SALIDA 40 min tarde no avisa', obC.length === 0, obC.length);

  // Llegada retrasada sin nadie activo (la única reserva se canceló): no avisa.
  const Z = await res(fx.aux, 'airport_to_home', 200, 'Vuelo AV7777.');
  await q(`UPDATE public.reservations SET cancelled_at = now() WHERE id = $1`, [Z.id]);
  await rec([base(fx.org, 'AV7777', await day(Z), 'airport_to_home', { status: 'delayed', sched_at: Z.required_arrival_at, estimated_at: await at(240), delay_min: 40 })]);
  nA = await alerts();
  const fsZ = await fsRow(fx.org, 'AV7777', 'airport_to_home');
  const obZ = await q(`SELECT 1 FROM public.notification_outbox WHERE dedupe_key LIKE 'flt:' || $1::text || ':%'`, [fsZ.id]);
  check('vuelo retrasado sin reservas activas: no avisa a nadie', obZ.length === 0, obZ.length);

  // Otra organización: le avisa a SU jefe (y a nadie de la primera).
  await rec([base(fx2.org, 'AV9563', dO, 'airport_to_home', { status: 'in_air', sched_at: O.required_arrival_at, estimated_at: await at(160), delay_min: 30 })]);
  nA = await alerts();
  const fsO = await fsRow(fx2.org, 'AV9563', 'airport_to_home');
  const obO = await q(`SELECT profile_id FROM public.notification_outbox WHERE dedupe_key LIKE 'flt:' || $1::text || ':%'`, [fsO.id]);
  check('el mismo vuelo en la otra organización avisa solo a su jefe (sin plan publicado, sin conductor)', obO.length === 1 && obO[0].profile_id === jefeOtra, JSON.stringify(obO));

  // Nadie marcado en la organización → todos los admins activos (regla de 0066).
  const fx3 = await otraOrg('tres');
  const j3a = await user(c, fx3.org, 'admin', 'Admin uno sin marcar');
  const j3b = await user(c, fx3.org, 'admin', 'Admin dos sin marcar');
  const P = await res(fx3.aux, 'airport_to_home', 150, 'Vuelo P57400.');
  await rec([base(fx3.org, 'P57400', await day(P), 'airport_to_home', { status: 'delayed', sched_at: P.required_arrival_at, estimated_at: await at(170), delay_min: 20 })]);
  nA = await alerts();
  const fsP = await fsRow(fx3.org, 'P57400', 'airport_to_home');
  const obP = await q(`SELECT profile_id, body FROM public.notification_outbox WHERE dedupe_key LIKE 'flt:' || $1::text || ':%'`, [fsP.id]);
  // Con jefes marcados en OTRAS organizaciones: la regla va por organización.
  check('organización sin jefes marcados: avisa a sus dos admins activos (regla de 0066, por organización)',
    obP.length === 2 && obP.every(x => [j3a, j3b].includes(x.profile_id)), JSON.stringify(obP.map(x => x.profile_id)));
  const est3 = (await one(`SELECT estimated_at FROM public.flight_statuses WHERE id = $1`, [fsP.id])).estimated_at;
  check('Wingo (P5): la recogida sugerida suma 22 min', obP.length && obP[0].body.endsWith('Recogida sugerida ' + hhmm(new Date(est3).getTime() + 22 * 60000)), obP[0] && obP[0].body);

  await q(`UPDATE public.app_settings SET flight_api_enabled = false WHERE id = 'singleton'`);
  await q(`UPDATE public.flight_statuses SET status = 'in_air', delay_min = 90, estimated_at = sched_at + interval '90 minutes', alerted_status = 'in_air' WHERE id = $1`, [fsO.id]);
  nA = await alerts();
  check('bandera apagada → no avisa', nA === 0, nA);
  await q(`UPDATE public.app_settings SET flight_api_enabled = true WHERE id = 'singleton'`);

  console.log('\n   Desembarque (gemelo de rtDeplaneVuelo)');
  const dm = async (code) => Number((await one(`SELECT public.flight_deplane_min($1) n`, [code])).n);
  const casos = { AV9563: 15, AV123: 20, 'JA5816': 30, J65417: 25, JEC1234: 25, P57400: 22, LA4025: 19, '5116': 25, '5816': 30, '1234': 15, '033': 20, '': 19, 'XX99': 19 };
  const mal = [];
  for (const [k, v] of Object.entries(casos)) { const r = await dm(k); if (r !== v) mal.push(`${k}: ${r}≠${v}`); }
  check('AV nac/int, JetSmart nac/int (JA/J6/JEC), Wingo, LATAM y sin sigla = las reglas de admin-rutas', mal.length === 0, mal.join(' | '));

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n7. RLS y permisos');
  const ver = async (uid) => { await como(uid); const r = await intenta(`SELECT flight_code, direction::text AS d, organization_id FROM public.flight_statuses WHERE organization_id = ANY($1::uuid[]) ORDER BY 1, 2`, [[fx.org, fx2.org, fx3.org]]); await comoDb(); return r; };
  let r = await ver(jefe);
  const lista = (x) => (x.rows || []).map(y => `${y.organization_id === fx.org ? 'o1' : y.organization_id === fx2.org ? 'o2' : 'o3'}:${y.flight_code}`).sort().join(',');
  check('la jefa ve los vuelos de SU organización', !r.err && lista(r) === 'o1:AV5555,o1:AV7777,o1:AV9563,o1:LA4025', r.err || lista(r));
  r = await ver(fx.drvUser);
  check('el conductor de la organización también', !r.err && lista(r) === 'o1:AV5555,o1:AV7777,o1:AV9563,o1:LA4025', r.err || lista(r));
  r = await ver(fx.auxUser);
  check('la tripulante ve SOLO el vuelo de sus reservas (AV9563; AV5555 y AV7777 también son suyos)', !r.err && lista(r) === 'o1:AV5555,o1:AV7777,o1:AV9563', r.err || lista(r));
  r = await ver(fx.vecinoUser);
  check('la vecina ve AV9563 y LA4025 (los suyos)', !r.err && lista(r) === 'o1:AV9563,o1:LA4025', r.err || lista(r));
  r = await ver(solaUser);
  check('una tripulante sin vuelos no ve ninguno', !r.err && lista(r) === '', r.err || lista(r));
  r = await ver(jefeOtra);
  check('el jefe de otra organización solo ve los suyos', !r.err && lista(r) === 'o2:AV9563', r.err || lista(r));
  await como(jefe);
  const ins = await intenta(`INSERT INTO public.flight_statuses (organization_id, flight_code, flight_date, direction) VALUES ($1, 'AV1', now()::date, 'airport_to_home')`, [fx.org]);
  const upd = await intenta(`UPDATE public.flight_statuses SET delay_min = 0 WHERE organization_id = $1`, [fx.org]);
  const tg = await intenta(`SELECT * FROM public.flight_status_targets()`);
  const rc = await intenta(`SELECT public.flight_status_record('[]'::jsonb)`);
  const al = await intenta(`SELECT public.flight_delay_alerts()`);
  const pl = await intenta(`SELECT public.poll_flight_status()`);
  await comoDb();
  check('desde el cliente nadie escribe (ni la jefa)', !!ins.err && (!!upd.err || upd.count === 0), `${ins.err} · ${upd.err || upd.count}`);
  check('las funciones del servidor no se llaman desde el cliente', !!tg.err && !!rc.err && !!al.err && !!pl.err, [tg.err, rc.err, al.err, pl.err].map(x => x ? 'denegado' : 'PASÓ').join());
  const srv = await one(`SELECT has_function_privilege('service_role', 'public.flight_status_targets(timestamptz, integer)', 'EXECUTE') a,
                                has_function_privilege('service_role', 'public.flight_status_record(jsonb)', 'EXECUTE') b,
                                has_function_privilege('service_role', 'public.flight_delay_alerts(timestamptz)', 'EXECUTE') c,
                                has_function_privilege('anon', 'public.flight_status_targets(timestamptz, integer)', 'EXECUTE') d`);
  check('la llave de servicio (Edge Function) sí puede; anon no', srv.a && srv.b && srv.c && !srv.d, JSON.stringify(srv));

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n8. El disparo y el reloj');
  await q(`UPDATE public.app_settings SET flight_api_enabled = false WHERE id = 'singleton'`);
  let p = (await one(`SELECT public.poll_flight_status() v`)).v;
  check('bandera apagada → «apagado…», sin llamar nada', /^apagado/.test(p), p);
  await q(`UPDATE public.app_settings SET flight_api_enabled = true WHERE id = 'singleton'`);
  await q(`UPDATE public.flight_statuses SET fetched_at = now() - interval '3 hours', status = 'scheduled' WHERE organization_id = $1 AND flight_code = 'AV9563'`, [fx.org]);
  const secretos = (await q(`SELECT name FROM vault.decrypted_secrets WHERE name IN ('flight_status_url', 'service_role_key')`)).map(x => x.name);
  p = (await one(`SELECT public.poll_flight_status() v`)).v;
  if (secretos.length < 2) check('sin los secretos del Vault lo DICE (sin fallar): «' + p + '»', /^faltan secretos en Vault: .*flight_status_url/.test(p) || (secretos.includes('flight_status_url') && /service_role_key/.test(p)), p);
  else check('con los secretos en el Vault: dispara (queda en cola de pg_net y se deshace)', /^disparado con \d+ vuelos/.test(p), p);
  const job = await one(`SELECT schedule, command FROM cron.job WHERE jobname = 'poll-flight-status'`);
  check('pg_cron: poll-flight-status cada 15 min', job && job.schedule === '*/15 * * * *' && /poll_flight_status\(\)/.test(job.command), job && JSON.stringify(job));
  const col = await one(`SELECT column_default FROM information_schema.columns WHERE table_name = 'app_settings' AND column_name = 'flight_api_enabled'`);
  check('flight_api_enabled nace en false', col && col.column_default === 'false', col && col.column_default);
} catch (e) {
  fail++; console.log('  ✗ excepción:', e.message);
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok} ✓ · ${fail} ✗`);
process.exit(fail ? 1 : 0);
