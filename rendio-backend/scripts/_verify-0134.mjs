// Verificación de 0134 (cambió de vuelo o canceló: el sistema decide solo) contra
// la base LOCAL (127.0.0.1:54322). Aplica 0124, 0125, 0126 y 0134 dentro de una
// transacción que se deshace: no queda nada. Nunca apunta a dev ni a producción.
//
//   cd rendio-backend/scripts && node _verify-0134.mjs
//
// Qué prueba (el día de la ruta es MAÑANA en Bogotá):
//   A. Salida que entra con una vecina de su conjunto: misma hora que la vecina,
//      sale de su vuelta vieja (que queda vacía y se quita), avisos a los dos
//      conductores y a ella, reserva con la hora nueva, eventualidad RESUELTA.
//   B. Salida que entra de PRIMERA (conjunto a una cuadra de la primera recogida).
//   C. La vuelta se llenó (cupo 4): vuelta NUEVA para tomar (pool, auto_created) con
//      la hora estimada, «Deben estar» = su presentación, aviso a los conductores,
//      la ven en «Vueltas para tomar», el tripulante con driver_pending.
//   D. Llegada que entra de ÚLTIMA en la vuelta que sale de JMC cuando ya bajó.
//   E. Llegada sin vuelta que le sirva: vuelta nueva para tomar a la hora en que baja.
//   F. A NADIE más se le movió la hora en ninguno de los casos.
//   G. El privado sigue pasando por Coordinación (no cambia la reserva).
//   H. Un día sin ruta publicada: se cambia la reserva y queda el rastro.
//   I. Muy encima de la hora: la eventualidad queda ABIERTA (suena a los jefes).
//   J. Venía de una vuelta delegada: la eventualidad queda ABIERTA.
//   K. Cancelar: sale, la vuelta vacía se quita, rastro resuelto; con más gente
//      la vuelta se queda.
//   L. Permisos: las funciones internas no se llaman desde la app.
//   M. El down deja el cambio de vuelo como en 0126 y la cancelación como en 0117.
//
// NO cubre: la pantalla (aux-rx-vuelo.js y el tablero: _smoke-rx-vuelo-dom y
// _smoke-rutas-v2-dom), la push de verdad, tiempos de carretera reales (aquí la
// cuenta sin mapa), ni dev/producción.
import fs from 'node:fs';
import { localClient, fixtures, user, asUser } from './_local-fixtures.mjs';

let ok = 0, fail = 0;
const check = (n, cond, det) => {
  if (cond) { ok++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + (typeof det === 'string' ? det : JSON.stringify(det)) : ''}`); }
};
const c = await localClient();
const q = async (s, p) => (await c.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
const asDb = async () => { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', '', true)`); };
const strip = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const outbox = async (prof, like) => { await asDb(); return q(`SELECT title, body FROM public.notification_outbox WHERE profile_id = $1 AND (title ILIKE $2 OR body ILIKE $2) ORDER BY created_at`, [prof, like]); };
const huella = async (f) => (await one(`SELECT md5(p.prosrc) h FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1`, [f])).h;
const ms = (x) => (x ? new Date(x).getTime() : null);

await c.query('BEGIN');
try {
  if (!(await one(`SELECT to_regprocedure('public.ops_alert_recipients_of(uuid)') IS NOT NULL AS ok`)).ok) await c.query(strip('../supabase/migrations/0117_avisos_desde_el_servidor.sql'));
  await c.query(strip('../supabase/migrations/0124_carro_del_turno.sql'));
  await c.query(strip('../supabase/migrations/0125_ruta_de_julian.sql'));
  await c.query(strip('../supabase/migrations/0126_vuelta_delegada.sql'));
  // Lo que ya está en dev encima de 0126 (0128–0133): 0134 va después.
  for (const m of ['0128_aviso_vuelta_terminada', '0129_conductor_de_una_vuelta', '0130_corte_de_pedidos', '0131_delegado_con_nombre', '0132_carro_del_plan', '0133_pasajero_sin_cuenta']) await c.query(strip(`../supabase/migrations/${m}.sql`));
  const h0126 = { cf: await huella('auxiliar_change_flight'), cc: await huella('auxiliar_cancel_reservation') };
  await c.query(strip('../supabase/migrations/0134_reubicar_al_cambiar.sql'));
  await c.query(strip('../supabase/migrations/0134_reubicar_al_cambiar.sql'));
  check('0134 se aplica encima de 0126 y 0128–0133 (y se puede volver a correr)', true);

  const fx = await fixtures(c);
  const S = await one(`SELECT route_airport_buffer_min buf, route_service_min srv, route_traffic_factor tf, route_airport_factor af, route_merge_window_min win FROM public.app_settings WHERE id = 'singleton'`);
  const jefe = await user(c, fx.org, 'admin', 'Julián prueba 0134');
  const drv = async (name) => { const u = await user(c, fx.org, 'driver', name); return { u, dp: (await one(`INSERT INTO public.driver_profiles (profile_id) VALUES ($1) RETURNING id`, [u])).id }; };
  const JUAN = await drv('Juan Andres prueba 0134'), DANI = await drv('Daniel Alvarez prueba 0134');
  const bosques = (await one(`INSERT INTO public.residences (organization_id, name, latitude, longitude, sector) VALUES ($1, 'Bosques del Norte', 6.1530, -75.3790, 'Rionegro') RETURNING id`, [fx.org])).id;
  const RES = { [fx.olivar]: [6.1523, -75.3781], [fx.llano]: [6.1175, -75.4152], [bosques]: [6.1530, -75.3790] };
  const trip = async (name, resid) => { const u = await user(c, fx.org, 'auxiliar', name); return { u, a: (await one(`INSERT INTO public.auxiliar_profiles (profile_id, residence_id) VALUES ($1, $2) RETURNING id`, [u, resid])).id, resid }; };
  const ANA = await trip('Ana Olivar', fx.olivar), MARIA = await trip('Maria Llano', fx.llano), SARA = await trip('Sara Olivar', fx.olivar);
  const PEDRO = await trip('Pedro Bosques', bosques), LUZ = await trip('Luz Llano', fx.llano);
  const JESS = await trip('Jessica Llegada', fx.olivar), KAROL = await trip('Karol Llegada', fx.llano), NOC = await trip('Noche Llegada', fx.olivar);
  const PRIV = await trip('Privada Prueba', fx.olivar), HOYP = await trip('Hoy Prueba', fx.olivar), TARDE = await trip('Tarde Prueba', fx.olivar);
  const DELE = await trip('Delegada Prueba', fx.olivar), CANC = await trip('Cancela Prueba', fx.olivar), CANC2 = await trip('Cancela Dos', fx.olivar);
  const man = (await one(`SELECT ((now() AT TIME ZONE 'America/Bogota')::date + 1)::text d`)).d;
  const at = (d, hm) => `${d}T${hm}:00-05:00`;
  const res = async (X, dir, whenIso, extra = {}) => {
    const [lat, lng] = RES[X.resid];
    return (await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, ${dir === 'sal' ? 'status_h2a' : 'status_a2h'}, required_arrival_at, pickup_address, pickup_latitude, pickup_longitude, residence_id, notes, service_level, private_status)
      VALUES ($1, $2, $3, $4::timestamptz, 'Rionegro', $5, $6, $7, $8, $9, $10) RETURNING id`,
      [X.a, dir === 'sal' ? 'home_to_airport' : 'airport_to_home', dir === 'sal' ? 'requested' : 'scheduled', whenIso, lat, lng, X.resid,
        extra.notes || (dir === 'lle' ? 'Vuelo AV9563.' : null), extra.level || 'shared', extra.privStatus || null])).id;
  };
  const vuelta = async (dp, dir, startIso, paradas, extra = {}) => {
    const ra = (await one(`INSERT INTO public.route_assignments (driver_profile_id, direction, status, planned_start_at, plan_car, delegated_at)
      VALUES ($1, $2, 'planned', $3::timestamptz, 'Carro 1', $4) RETURNING id`, [dp, dir === 'sal' ? 'home_to_airport' : 'airport_to_home', startIso, extra.delegada ? new Date().toISOString() : null])).id;
    let i = 0;
    for (const [rid, eta] of paradas) await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at) VALUES ($1, $2, $3, $4::timestamptz)`, [ra, rid, ++i, eta]);
    return ra;
  };
  // Si la función falla, se muestra el error de verdad (no el «transacción abortada» de después).
  const cambiar = async (X, rid, whenIso, flight = '') => {
    await c.query('SAVEPOINT sp_cf');
    await asUser(c, X.u, 'auxiliar');
    try { const r = (await one(`SELECT public.auxiliar_change_flight($1, $2, $3::timestamptz, NULL) r`, [rid, flight, whenIso])).r; await c.query('RELEASE SAVEPOINT sp_cf'); await asDb(); return r; }
    catch (e) { await c.query('ROLLBACK TO SAVEPOINT sp_cf'); await asDb(); console.log('    (error de la base: ' + e.message + (e.where ? ' · ' + e.where.split('\n')[0] : '') + ')'); return { error: e.message }; }
  };
  const paradasDe = async (ra) => q(`SELECT rs.reservation_id rid, rs.stop_order o, rs.estimated_arrival_at eta FROM public.route_stops rs WHERE rs.route_assignment_id = $1 ORDER BY stop_order`, [ra]);
  const inc = async (rid) => one(`SELECT status::text, severity::text, resolution_notes, details FROM public.incidents WHERE reservation_id = $1 ORDER BY created_at DESC LIMIT 1`, [rid]);
  // Foto de las horas de TODOS los demás (para F).
  const fotoOtros = async (excepto) => Object.fromEntries((await q(`SELECT rs.reservation_id rid, rs.estimated_arrival_at eta, ra.planned_start_at st, ra.direction FROM public.route_stops rs JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id WHERE rs.reservation_id <> ALL($1::uuid[])`, [excepto])).map((x) => [x.rid, x.direction === 'airport_to_home' ? ms(x.st) : ms(x.eta)]));
  const sinCambios = (a, b) => Object.keys(a).filter((k) => k in b && a[k] !== b[k]);

  // ── Plan publicado de mañana ──
  const rAna = await res(ANA, 'sal', at(man, '05:30')), rMaria = await res(MARIA, 'sal', at(man, '05:30'));
  const rSara = await res(SARA, 'sal', at(man, '07:30')), rPedro = await res(PEDRO, 'sal', at(man, '08:30')), rLuz = await res(LUZ, 'sal', at(man, '10:00'));
  const V1 = await vuelta(JUAN.dp, 'sal', at(man, '04:00'), [[rAna, at(man, '04:20')], [rMaria, at(man, '04:40')]]);
  const V2 = await vuelta(DANI.dp, 'sal', at(man, '06:15'), [[rSara, at(man, '06:20')]]);
  const V3 = await vuelta(DANI.dp, 'sal', at(man, '07:15'), [[rPedro, at(man, '07:20')]]);
  const V4 = await vuelta(DANI.dp, 'sal', at(man, '08:45'), [[rLuz, at(man, '08:50')]]);
  const rJess = await res(JESS, 'lle', at(man, '12:30')), rKarol = await res(KAROL, 'lle', at(man, '15:30')), rNoc = await res(NOC, 'lle', at(man, '17:00'));
  const V5 = await vuelta(JUAN.dp, 'lle', at(man, '13:00'), [[rJess, null]]);
  const V6 = await vuelta(DANI.dp, 'lle', at(man, '16:00'), [[rKarol, null]]);
  const V6b = await vuelta(DANI.dp, 'lle', at(man, '17:30'), [[rNoc, null]]);

  // ── A. Con la vecina de su conjunto ──
  console.log('\nA. Salida: entra con la vecina de su mismo conjunto');
  let antes = await fotoOtros([rSara]);
  const a = await cambiar(SARA, rSara, at(man, '05:40'));
  const pV1 = await paradasDe(V1);
  check('responde «reassigned» · entró en una vuelta que ya existía (joined)', a && a.mode === 'reassigned' && a.reassign && a.reassign.kind === 'joined' && a.reassign.ra_id === V1, a);
  check('entra justo después de Ana (su vecina), con la MISMA hora (4:20)', pV1.map((x) => x.rid).join() === [rAna, rSara, rMaria].join() && ms(pV1[1].eta) === Date.parse(at(man, '04:20')), pV1);
  check('su vuelta vieja quedó vacía y se quitó', !(await one(`SELECT 1 FROM public.route_assignments WHERE id = $1`, [V2])));
  const rs = await one(`SELECT required_arrival_at, calculated_pickup_at, status_h2a::text h2a FROM public.reservations WHERE id = $1`, [rSara]);
  check('la reserva tiene la hora nueva (5:40), recogida 4:20 y queda asignada', ms(rs.required_arrival_at) === Date.parse(at(man, '05:40')) && ms(rs.calculated_pickup_at) === Date.parse(at(man, '04:20')) && rs.h2a === 'assigned', rs);
  check('a Sara: «Listo: te movimos de vuelta» con 4:20 y quién la lleva', (await outbox(SARA.u, 'Listo: te movimos de vuelta%')).some((x) => /4:20/.test(x.body) && /te lleva Juan/.test(x.body)), await outbox(SARA.u, '%'));
  check('a Daniel (la perdió): «ya no va en tu vuelta»', (await outbox(DANI.u, 'Cambió un traslado de tu ruta')).some((x) => /Sara Olivar cambió su vuelo: ya no va en tu vuelta/.test(x.body)));
  check('a Juan (la recibe): «Se sumó alguien a tu vuelta» con la recogida y el conjunto', (await outbox(JUAN.u, 'Se sumó alguien a tu vuelta')).some((x) => /recogida 4:20 en El Olivar/.test(x.body)));
  let e = await inc(rSara);
  check('Eventualidades: RESUELTA sola, con lo que pasó', e && e.status === 'resolved' && /Se resolvió sola: pasó a la vuelta de las 4:00 de Juan/.test(e.resolution_notes) && e.details.auto === true, e);
  let difs = sinCambios(antes, await fotoOtros([rSara]));
  check('F · a nadie más se le movió la hora', difs.length === 0, difs);

  // ── B. De primera ──
  console.log('\nB. Salida: entra de PRIMERA (a una cuadra de la primera recogida)');
  antes = await fotoOtros([rPedro]);
  const b = await cambiar(PEDRO, rPedro, at(man, '05:35'));
  const pV1b = await paradasDe(V1);
  const tramo = Math.max(2, 0.0 + 0) ; // (el número exacto lo calcula la base; aquí se mira que quede antes y redondo)
  check('entra de primera en la vuelta de Juan, antes de Ana', b.reassign && b.reassign.kind === 'joined' && pV1b[0].rid === rPedro && pV1b[1].rid === rAna, pV1b);
  check('su recogida es antes que la de Ana y en múltiplo de 5', ms(pV1b[0].eta) < ms(pV1b[1].eta) && new Date(pV1b[0].eta).getUTCMinutes() % 5 === 0 && ms(pV1b[1].eta) - ms(pV1b[0].eta) <= 15 * 60000, pV1b.map((x) => x.eta));
  difs = sinCambios(antes, await fotoOtros([rPedro]));
  check('F · a nadie más se le movió la hora (la vuelta solo arranca igual o antes)', difs.length === 0, difs);
  check('su vuelta vieja también se quitó', !(await one(`SELECT 1 FROM public.route_assignments WHERE id = $1`, [V3])));
  void tramo;

  // ── C. Lleno: vuelta nueva para tomar ──
  console.log('\nC. La vuelta de Juan se llenó (4): vuelta NUEVA para tomar');
  antes = await fotoOtros([rLuz]);
  const cc = await cambiar(LUZ, rLuz, at(man, '05:45'));
  const nv = cc.reassign && await one(`SELECT * FROM public.route_assignments WHERE id = $1`, [cc.reassign.ra_id]);
  check('no cabía: «new», una vuelta para tomar creada sola, de su organización y del día', cc.reassign && cc.reassign.kind === 'new' && nv && nv.pool === true && nv.auto_created === true && nv.organization_id === fx.org && nv.driver_profile_id === null && String(nv.manual_day).length > 0, nv);
  // La hora que espera: presentación − (tramo a JMC sin mapa + colchón + servicio), redondeada hacia abajo a 5.
  const km = (await one(`SELECT public.tramo_km(6.1175, -75.4152, 6.1645, -75.4231) k`)).k;
  const tramoMin = Math.max(2, km * 1.4 / 30 * 60) * Number(S.tf) * Number(S.af);
  let esperada = Date.parse(at(man, '05:45')) - Math.ceil(tramoMin + S.buf + S.srv) * 60000;
  esperada -= (new Date(esperada).getUTCMinutes() % 5) * 60000;
  const pN = await paradasDe(nv.id);
  check(`su recogida estimada: ${new Date(esperada).toISOString().slice(11, 16)} UTC («Deben estar» 5:45)`, pN.length === 1 && ms(pN[0].eta) === esperada && ms(nv.deadline_at) === Date.parse(at(man, '05:45')) && ms(nv.planned_start_at) === esperada, { eta: pN[0] && pN[0].eta, esperada: new Date(esperada).toISOString(), dl: nv.deadline_at });
  check('a los conductores: «Hay una vuelta para tomar» (cambió de vuelo)', (await outbox(JUAN.u, 'Hay una vuelta para tomar')).some((x) => /cambió de vuelo/.test(x.body)) && (await outbox(DANI.u, 'Hay una vuelta para tomar')).length >= 1);
  await asUser(c, DANI.u, 'driver'); const abiertas = (await one(`SELECT public.driver_open_routes() l`)).l || []; await asDb();
  check('Daniel la ve en «Vueltas para tomar»', abiertas.some((v) => v.id === nv.id), abiertas.map((v) => v.id));
  await asUser(c, LUZ.u, 'auxiliar'); const misL = (await one(`SELECT public.auxiliar_my_trips(30) j`)).j.find((x) => x.id === rLuz); await asDb();
  check('Luz: publicada, con su hora y driver_pending (falta quién la tome)', misL && misL.published === true && misL.driver_pending === true && ms(misL.pickup_at) === esperada, misL && [misL.published, misL.driver_pending, misL.pickup_at]);
  check('a Luz: «Te armamos una vuelta» con la hora y «Te avisamos quién te recoge»', (await outbox(LUZ.u, 'Te armamos una vuelta%')).some((x) => /para estar en JMC a las 5:45/.test(x.body) && /Te avisamos quién te recoge/.test(x.body)));
  e = await inc(rLuz);
  check('Eventualidades: resuelta sola, «se creó una vuelta nueva para tomar»', e && e.status === 'resolved' && /vuelta nueva para tomar/.test(e.resolution_notes), e);
  difs = sinCambios(antes, await fotoOtros([rLuz]));
  check('F · a nadie más se le movió la hora', difs.length === 0, difs);

  // ── D. Llegada que entra de última ──
  console.log('\nD. Llegada: entra de ÚLTIMA en la que sale de JMC cuando ya bajó');
  antes = await fotoOtros([rKarol]);
  const d = await cambiar(KAROL, rKarol, at(man, '12:40'), 'AV9563');
  const pV5 = await paradasDe(V5);
  const dep = (await one(`SELECT public.flight_deplane_min('AV9563') m`)).m;
  check(`aterriza 12:40 + ${dep} min de desembarque: entra en la de Juan de las 13:00, de última`, d.reassign && d.reassign.kind === 'joined' && d.reassign.ra_id === V5 && pV5.map((x) => x.rid).join() === [rJess, rKarol].join(), { d, pV5 });
  check('a Karol: «te esperamos en JMC a las 13:00»', (await outbox(KAROL.u, 'Listo: te movimos de vuelta%')).some((x) => /te esperamos en JMC a las 13:00/.test(x.body)));
  check('su llegada vieja (16:00) quedó vacía y se quitó', !(await one(`SELECT 1 FROM public.route_assignments WHERE id = $1`, [V6])));
  difs = sinCambios(antes, await fotoOtros([rKarol]));
  check('F · la de Jessica sigue saliendo a las 13:00', difs.length === 0, difs);

  // ── E. Llegada sin vuelta ──
  console.log('\nE. Llegada sin vuelta que le sirva: vuelta nueva para tomar');
  const ee = await cambiar(NOC, rNoc, at(man, '20:00'), 'AV9563');
  const nvL = ee.reassign && await one(`SELECT * FROM public.route_assignments WHERE id = $1`, [ee.reassign.ra_id]);
  let salida = Date.parse(at(man, '20:00')) + dep * 60000; const resto = new Date(salida).getUTCMinutes() % 5; if (resto) salida += (5 - resto) * 60000;
  check('vuelta nueva de llegada para tomar, que sale de JMC cuando baja (redondeada hacia arriba)', ee.reassign && ee.reassign.kind === 'new' && nvL && nvL.direction === 'airport_to_home' && nvL.pool && nvL.auto_created && ms(nvL.planned_start_at) === salida, { nvL, salida: new Date(salida).toISOString() });

  // ── G. Privado ──
  console.log('\nG. El privado sigue pasando por Coordinación');
  const rPriv = await res(PRIV, 'sal', at(man, '09:30'), { level: 'private', privStatus: 'approved' });
  await vuelta(JUAN.dp, 'sal', at(man, '08:20'), [[rPriv, at(man, '08:30')]]);
  const g = await cambiar(PRIV, rPriv, at(man, '10:30'));
  const rp = await one(`SELECT required_arrival_at FROM public.reservations WHERE id = $1`, [rPriv]);
  check('privado: «needs_ops» y la reserva NO cambia', g.mode === 'needs_ops' && ms(rp.required_arrival_at) === Date.parse(at(man, '09:30')), { g, rp });

  // ── H. Día sin ruta publicada ──
  console.log('\nH. Un día que todavía no tiene ruta publicada');
  const lejos = new Date(Date.now() + 5 * 3600000), luego = new Date(Date.now() + 4 * 3600000);
  const rHoy = await res(HOYP, 'sal', lejos.toISOString());
  const h = await cambiar(HOYP, rHoy, luego.toISOString());
  const rh = await one(`SELECT required_arrival_at FROM public.reservations WHERE id = $1`, [rHoy]);
  e = await inc(rHoy);
  check('encima de la hora y sin ruta publicada: se cambia la reserva («unplanned») y queda el rastro', h.mode === 'reassigned' && h.reassign.kind === 'unplanned' && ms(rh.required_arrival_at) === luego.getTime() && e && e.status === 'resolved' && /todavía no tiene ruta publicada/.test(e.resolution_notes), { h, e });

  // ── I. Muy encima ──
  console.log('\nI. Muy encima de la hora: la eventualidad queda abierta');
  const rT0 = await res(TARDE, 'sal', new Date(Date.now() + 5 * 3600000).toISOString());
  await vuelta(JUAN.dp, 'sal', new Date(Date.now() + 4 * 3600000).toISOString(), [[rT0, new Date(Date.now() + 4 * 3600000).toISOString()]]);
  const it = await cambiar(TARDE, rT0, new Date(Date.now() + 55 * 60000).toISOString());
  e = await inc(rT0);
  check('recogida en menos de 45 min: «tight», eventualidad ABIERTA y de prioridad alta', it.reassign && it.reassign.tight === true && e && e.status === 'open' && e.severity === 'high' && /muy encima de la hora/.test(e.resolution_notes), { it: it.reassign, e });

  // ── J. Venía de una delegada ──
  console.log('\nJ. Venía de una vuelta delegada');
  const rDel = await res(DELE, 'sal', at(man, '11:30'));
  const VD = await vuelta(null, 'sal', at(man, '10:20'), [[rDel, at(man, '10:30')]], { delegada: true });
  const jj = await cambiar(DELE, rDel, at(man, '11:00'));
  e = await inc(rDel);
  check('sale de la delegada y la eventualidad queda ABIERTA («avísale a quien la iba a hacer»)', jj.reassign && jj.reassign.was_delegated === true && e && e.status === 'open' && /DELEGADA/.test(e.resolution_notes) && !(await one(`SELECT 1 FROM public.route_assignments WHERE id = $1`, [VD])), { jj: jj.reassign, e });

  // ── K. Cancelar ──
  console.log('\nK. Cancelar');
  const rC = await res(CANC, 'sal', at(man, '12:30')), rC2 = await res(CANC2, 'sal', at(man, '12:30'));
  const VC = await vuelta(DANI.dp, 'sal', at(man, '11:20'), [[rC, at(man, '11:30')]]);
  await asUser(c, CANC.u, 'auxiliar'); const k1 = (await one(`SELECT public.auxiliar_cancel_reservation($1, 'Me cambiaron el turno') r`, [rC])).r; await asDb();
  e = await inc(rC);
  check('sola en su vuelta: sale, la vuelta vacía se quita y queda el rastro resuelto', k1.vueltas_quitadas === 1 && !(await one(`SELECT 1 FROM public.route_assignments WHERE id = $1`, [VC])) && e && e.status === 'resolved' && /canceló su traslado de las 11:30: Me cambiaron el turno/.test((await one(`SELECT description FROM public.incidents WHERE reservation_id = $1`, [rC])).description) && /la vuelta quedó vacía y se quitó/.test(e.resolution_notes), { k1, e });
  check('a Daniel: «Traslado cancelado»', (await outbox(DANI.u, 'Traslado cancelado')).length >= 1);
  const VC2 = await vuelta(DANI.dp, 'sal', at(man, '11:40'), [[rC2, at(man, '11:50')], [rAna, at(man, '11:55')]]);
  await asUser(c, CANC2.u, 'auxiliar'); const k2 = (await one(`SELECT public.auxiliar_cancel_reservation($1, NULL) r`, [rC2])).r; await asDb();
  check('con más gente en la vuelta: sale ella y la vuelta se queda', k2.vueltas_quitadas === 0 && !!(await one(`SELECT 1 FROM public.route_assignments WHERE id = $1`, [VC2])));

  // ── N. El pasajero sin cuenta ocupa puesto ──
  console.log('\nN. El pasajero sin cuenta (0133) también ocupa puesto');
  const T1 = await trip('Uno Olivar', fx.olivar), T2 = await trip('Dos Olivar', fx.olivar), T3 = await trip('Tres Olivar', fx.olivar), TOM = await trip('Tomas Olivar', fx.olivar);
  const r1 = await res(T1, 'sal', at(man, '15:30')), r2 = await res(T2, 'sal', at(man, '15:30')), r3 = await res(T3, 'sal', at(man, '15:30')), rTom = await res(TOM, 'sal', at(man, '18:00'));
  const VG = await vuelta(JUAN.dp, 'sal', at(man, '14:20'), [[r1, at(man, '14:30')], [r2, at(man, '14:30')], [r3, at(man, '14:30')]]);
  await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at, guest_name, guest_place, guest_residence_id, guest_lat, guest_lng)
           VALUES ($1, NULL, 4, $2::timestamptz, 'Kriss', 'El Olivar', $3, 6.1523, -75.3781)`, [VG, at(man, '14:30'), fx.olivar]);
  await vuelta(DANI.dp, 'sal', at(man, '16:50'), [[rTom, at(man, '17:00')]]);
  const nn = await cambiar(TOM, rTom, at(man, '15:40'));
  check('3 tripulantes + Kriss = 4: está llena aunque Tomás sea de El Olivar → vuelta nueva para tomar', nn.reassign && nn.reassign.kind === 'new' && (await paradasDe(VG)).length === 4, nn.reassign);

  // ── L. Permisos ──
  console.log('\nL. Permisos');
  const pr = await one(`SELECT has_function_privilege('authenticated', 'public.reubicar_reserva(uuid)', 'EXECUTE') r1,
                               has_function_privilege('authenticated', 'public.reub_candidatas(uuid,int)', 'EXECUTE') r2,
                               has_function_privilege('authenticated', 'public.auxiliar_change_flight(uuid,text,timestamptz,text)', 'EXECUTE') r3`);
  check('reubicar_reserva y reub_candidatas no se llaman desde la app; el cambio de vuelo sí', pr.r1 === false && pr.r2 === false && pr.r3 === true, pr);
  void jefe;

  // ── M. El down ──
  console.log('\nM. El down');
  await c.query('SAVEPOINT down');
  await c.query(strip('../down_migrations/0134_reubicar_al_cambiar.down.sql'));
  const hd = { cf: await huella('auxiliar_change_flight'), cc: await huella('auxiliar_cancel_reservation') };
  const col = await one(`SELECT count(*)::int n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'route_assignments' AND column_name = 'auto_created'`);
  check('el down deja el cambio de vuelo y la cancelación EXACTAMENTE como antes, y quita la columna', hd.cf === h0126.cf && hd.cc === h0126.cc && col.n === 0, { hd, h0126, col });
  await c.query('ROLLBACK TO SAVEPOINT down');
} catch (e) {
  fail++; console.log('  ✗ error: ' + e.message);
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok} ✓ · ${fail} ✗`);
console.log('NO cubre: la pantalla, la push de verdad, tiempos de carretera reales (aquí la cuenta sin mapa) ni dev/producción.');
process.exit(fail ? 1 : 0);
