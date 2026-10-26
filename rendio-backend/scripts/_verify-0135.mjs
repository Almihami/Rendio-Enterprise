// Verificación de 0135 (las eventualidades se acomodan solas, en el mejor sitio)
// contra la base LOCAL (127.0.0.1:54322). Aplica 0124–0134 y 0135 dentro de una
// transacción que se deshace: no queda nada. Nunca apunta a dev ni a producción.
//
//   cd rendio-backend/scripts && node _verify-0135.mjs
//
// Qué prueba (el día de la ruta es MAÑANA en Bogotá):
//   A. Llegada sola en su vuelta, cambia de vuelo y su conductor alcanza: la
//      MISMA vuelta se corre de hora (el caso de Margy), con avisos y rastro.
//   B. Llegada sola cuyo conductor NO alcanza a la hora nueva: entra en otra.
//   C. Salida que puede juntarse con su vecina casi sin desvío: se junta (un
//      viaje menos) aunque su conductor pudiera correrse.
//   D. Salida que entra ENTRE dos recogidas (hay hueco) sin mover a nadie.
//   E. Pidió con el día publicado: entra sola al pedir + rastro resuelto; día
//      sin publicar, privado o con el interruptor de scripts: no se toca.
//   F. Flightradar24: vienen tarde TODOS los de la vuelta → la vuelta se corre;
//      el conductor no alcanza → queda para tomar; solo uno tarde → ese se mueve;
//      correrlo otra vez no repite nada.
//   G. Cambio de vuelo que quedó esperando a Coordinación (antes de 0134): el
//      sistema lo aplica y lo reubica.
//   H. «X no tiene carro» abierta: el sistema la ubica y la resuelve (de reserva
//      en un hotel, nunca con los que salen de JMC).
//   I. A NADIE más se le movió la hora de recogida en ninguno de los casos.
//   J. Permisos y el down.
//
// NO cubre: la pantalla (aux-rx-vuelo.js: _smoke-rx-vuelo-dom), la push de
// verdad, tiempos reales de carretera (aquí la cuenta sin mapa), el pg_cron de
// verdad (se llama la función a mano), ni dev/producción.
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
const huella = async (f) => (await one(`SELECT md5(string_agg(p.prosrc, '|' ORDER BY p.oid)) h FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1`, [f])).h;
const ms = (x) => (x ? new Date(x).getTime() : null);
const hm = (x) => new Date(new Date(x).getTime() - 5 * 3600000).toISOString().slice(11, 16).replace(/^0/, '');
const acomodar = (on) => q(`SELECT set_config('rendio.no_acomodar', $1, true)`, [on ? '' : 'on']);

await c.query('BEGIN');
try {
  if (!(await one(`SELECT to_regprocedure('public.ops_alert_recipients_of(uuid)') IS NOT NULL AS ok`)).ok) await c.query(strip('../supabase/migrations/0117_avisos_desde_el_servidor.sql'));
  for (const m of ['0124_carro_del_turno', '0125_ruta_de_julian', '0126_vuelta_delegada', '0128_aviso_vuelta_terminada', '0129_conductor_de_una_vuelta',
    '0130_corte_de_pedidos', '0131_delegado_con_nombre', '0132_carro_del_plan', '0133_pasajero_sin_cuenta', '0134_reubicar_al_cambiar']) await c.query(strip(`../supabase/migrations/${m}.sql`));
  const h0134 = { cf: await huella('auxiliar_change_flight'), rr: await huella('reubicar_reserva'), cand: await huella('reub_candidatas'), hb: await huella('hm_bog') };
  await c.query(strip('../supabase/migrations/0135_acomodar_eventualidades.sql'));
  await c.query(strip('../supabase/migrations/0135_acomodar_eventualidades.sql'));
  check('0135 se aplica encima de 0134 (y se puede volver a correr)', true);
  const hb = await one(`SELECT public.hm_bog('2026-10-27T00:00:00-05:00') a, public.hm_bog('2026-10-27T00:35:00-05:00') b, public.hm_bog('2026-10-27T09:05:00-05:00') c, public.hm_bog('2026-10-27T21:45:00-05:00') d`);
  check('la hora corta: medianoche «0:00» (antes «:00»), «0:35», «9:05», «21:45»', hb.a === '0:00' && hb.b === '0:35' && hb.c === '9:05' && hb.d === '21:45', hb);
  await acomodar(false);   // el armado del plan de prueba no debe disparar el acomodo al pedir

  const fx = await fixtures(c);
  const drv = async (name) => { const u = await user(c, fx.org, 'driver', name); return { u, dp: (await one(`INSERT INTO public.driver_profiles (profile_id) VALUES ($1) RETURNING id`, [u])).id }; };
  const JUAN = await drv('Juan Ospina prueba'), DANI = await drv('Daniel Alvarez prueba'), MIGU = await drv('Miguel Rios prueba'), CARL = await drv('Carlos Zea prueba');
  const bosques = (await one(`INSERT INTO public.residences (organization_id, name, latitude, longitude, sector) VALUES ($1, 'Bosques del Norte', 6.1530, -75.3790, 'Rionegro') RETURNING id`, [fx.org])).id;
  const RES = { [fx.olivar]: [6.1523, -75.3781], [fx.llano]: [6.1175, -75.4152], [bosques]: [6.1530, -75.3790] };
  let nTrip = 0;
  const trip = async (name, resid) => { const u = await user(c, fx.org, 'auxiliar', name + ' ' + (++nTrip)); return { u, a: (await one(`INSERT INTO public.auxiliar_profiles (profile_id, residence_id) VALUES ($1, $2) RETURNING id`, [u, resid])).id, resid, name }; };
  const man = (await one(`SELECT ((now() AT TIME ZONE 'America/Bogota')::date + 1)::text d`)).d;
  const pas = (await one(`SELECT ((now() AT TIME ZONE 'America/Bogota')::date + 4)::text d`)).d;
  const at = (d, h) => `${d}T${h}:00-05:00`;
  const res = async (X, dir, whenIso, extra = {}) => {
    const [lat, lng] = RES[X.resid];
    return (await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, ${dir === 'sal' ? 'status_h2a' : 'status_a2h'}, required_arrival_at, pickup_address, pickup_latitude, pickup_longitude, residence_id, notes, service_level, private_status, reserve_place)
      VALUES ($1, $2, $3, $4::timestamptz, 'Rionegro', $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [X.a, dir === 'sal' ? 'home_to_airport' : 'airport_to_home', dir === 'sal' ? 'requested' : 'scheduled', whenIso, lat, lng, X.resid,
        extra.notes !== undefined ? extra.notes : (dir === 'lle' ? 'Vuelo AV9563.' : null), extra.level || 'shared', extra.privStatus || null, extra.place || null])).id;
  };
  const vuelta = async (dp, dir, startIso, paradas, extra = {}) => {
    const ra = (await one(`INSERT INTO public.route_assignments (driver_profile_id, direction, status, planned_start_at, plan_car, deadline_at)
      VALUES ($1, $2, 'planned', $3::timestamptz, 'Carro 1', $4::timestamptz) RETURNING id`, [dp, dir === 'sal' ? 'home_to_airport' : 'airport_to_home', startIso, extra.dl || null])).id;
    let i = 0;
    for (const [rid, eta] of paradas) await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at) VALUES ($1, $2, $3, $4::timestamptz)`, [ra, rid, ++i, eta]);
    return ra;
  };
  const cambiar = async (X, rid, whenIso, flight = '') => {
    await c.query('SAVEPOINT sp_cf');
    await asUser(c, X.u, 'auxiliar');
    try { const r = (await one(`SELECT public.auxiliar_change_flight($1, $2, $3::timestamptz, NULL) r`, [rid, flight, whenIso])).r; await c.query('RELEASE SAVEPOINT sp_cf'); await asDb(); return r; }
    catch (e) { await c.query('ROLLBACK TO SAVEPOINT sp_cf'); await asDb(); console.log('    (error de la base: ' + e.message + (e.where ? ' · ' + e.where.split('\n')[0] : '') + ')'); return { error: e.message }; }
  };
  const barrer = async () => {
    await c.query('SAVEPOINT sp_ac');
    try { const r = (await one(`SELECT public.acomodar_eventualidades() r`)).r; await c.query('RELEASE SAVEPOINT sp_ac'); return r; }
    catch (e) { await c.query('ROLLBACK TO SAVEPOINT sp_ac'); console.log('    (error de la base: ' + e.message + (e.where ? ' · ' + e.where.split('\n')[0] : '') + ')'); return { error: e.message }; }
  };
  const paradasDe = async (ra) => q(`SELECT rs.reservation_id rid, rs.stop_order o, rs.estimated_arrival_at eta FROM public.route_stops rs WHERE rs.route_assignment_id = $1 ORDER BY stop_order`, [ra]);
  const vueltaDe = async (rid) => one(`SELECT ra.* FROM public.route_stops rs JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id WHERE rs.reservation_id = $1 AND ra.status IN ('planned','in_progress')`, [rid]);
  const existe = async (ra) => !!(await one(`SELECT 1 FROM public.route_assignments WHERE id = $1`, [ra]));
  const inc = async (rid, extra = '') => one(`SELECT id, status::text, severity::text, category::text, description, resolution_notes, details, dedupe_key FROM public.incidents WHERE reservation_id = $1 ${extra} ORDER BY created_at DESC LIMIT 1`, [rid]);
  // La recogida de cada salida y la salida de JMC de cada llegada, de TODOS (para I).
  const foto = async () => Object.fromEntries((await q(`SELECT rs.reservation_id rid, rs.estimated_arrival_at eta, ra.planned_start_at st, ra.direction FROM public.route_stops rs JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id WHERE rs.reservation_id IS NOT NULL`)).map((x) => [x.rid, x.direction === 'airport_to_home' ? ms(x.st) : ms(x.eta)]));
  const movidos = (a, b, excepto) => Object.keys(a).filter((k) => !excepto.includes(k) && k in b && a[k] !== b[k]);
  const dep = (await one(`SELECT public.flight_deplane_min('AV9384') m`)).m;
  const arriba5 = (t) => { const r = new Date(t).getUTCMinutes() % 5; return r ? t + (5 - r) * 60000 : t; };

  // ── El plan publicado de mañana ──
  const MARGY = await trip('Margy Lopez', fx.olivar), OTRA1 = await trip('Otra Llegada', fx.llano), OTRA2 = await trip('Otra Mas', fx.olivar);
  const rMargy = await res(MARGY, 'lle', at(man, '20:00'), { notes: 'Vuelo AV9358. · Regreso del mismo día' });
  const rO1 = await res(OTRA1, 'lle', at(man, '22:40')), rO2 = await res(OTRA2, 'lle', at(man, '23:30'));
  const VM = await vuelta(JUAN.dp, 'lle', at(man, '20:10'), [[rMargy, at(man, '20:32')]]);
  const VJ23 = await vuelta(JUAN.dp, 'lle', at(man, '23:00'), [[rO1, null]]);
  const VJ2345 = await vuelta(JUAN.dp, 'lle', at(man, '23:45'), [[rO2, null]]);

  // ── A. El caso de Margy ──
  console.log('\nA. Llegada sola, cambia de vuelo y su conductor alcanza: se corre SU vuelta');
  let f0 = await foto();
  const a = await cambiar(MARGY, rMargy, at(man, '21:30'), 'AV9384');
  const esperada = arriba5(Date.parse(at(man, '21:30')) + dep * 60000);
  const vm = await one(`SELECT * FROM public.route_assignments WHERE id = $1`, [VM]);
  check(`«retimed»: la misma vuelta (con Juan) sale de JMC a las ${hm(esperada)}`, a.reassign && a.reassign.kind === 'retimed' && a.reassign.ra_id === VM && vm.driver_profile_id === JUAN.dp && ms(vm.planned_start_at) === esperada, { a: a.reassign, vm: vm && vm.planned_start_at });
  const pM = await paradasDe(VM);
  check('su parada se corrió igual (la hora a la casa también)', pM.length === 1 && ms(pM[0].eta) === Date.parse(at(man, '20:32')) + (esperada - Date.parse(at(man, '20:10'))), pM);
  const rM = await one(`SELECT required_arrival_at, notes, flight_code FROM public.reservations WHERE id = $1`, [rMargy]);
  check('la reserva: 21:30, vuelo AV9384, «Regreso del mismo día» se conserva', ms(rM.required_arrival_at) === Date.parse(at(man, '21:30')) && rM.flight_code === 'AV9384' && /Regreso del mismo día$/.test(rM.notes), rM);
  check('a Margy: «te esperamos en JMC a las …, te lleva Juan»', (await outbox(MARGY.u, 'Listo: ajustamos tu traslado%')).some((x) => x.body.includes('te esperamos en JMC a las ' + hm(esperada)) && /te lleva Juan/.test(x.body)), await outbox(MARGY.u, '%'));
  check('a Juan: «Tu vuelta cambió de hora» 20:10 → nueva', (await outbox(JUAN.u, 'Tu vuelta cambió de hora')).some((x) => x.body.includes('de las 20:10 a las ' + hm(esperada))), await outbox(JUAN.u, '%'));
  let e = await inc(rMargy);
  check('Eventualidades: RESUELTA, «su vuelta pasó de las 20:10 a las …(sigue con Juan…)»', e && e.status === 'resolved' && e.resolution_notes.includes('pasó de las 20:10 a las ' + hm(esperada)) && /sigue con Juan/.test(e.resolution_notes), e);
  let mov = movidos(f0, await foto(), [rMargy]);
  check('I · a nadie más se le movió la hora', mov.length === 0, mov);

  // ── B. Su conductor no alcanza ──
  console.log('\nB. Llegada sola cuyo conductor NO alcanza a la hora nueva: entra en otra');
  const LINA = await trip('Lina Olivar', fx.olivar), KAROL = await trip('Karol Llano', fx.llano);
  const rLina = await res(LINA, 'lle', at(man, '14:00')), rKarol = await res(KAROL, 'lle', at(man, '15:40'));
  const VL = await vuelta(DANI.dp, 'lle', at(man, '14:20'), [[rLina, null]]);
  const VK = await vuelta(DANI.dp, 'lle', at(man, '16:00'), [[rKarol, null]]);
  f0 = await foto();
  const b = await cambiar(LINA, rLina, at(man, '15:40'), 'AV9384');
  const pK = await paradasDe(VK);
  check('no se corre (Daniel tiene la de las 16:00): entra en esa, de última', b.reassign && b.reassign.kind === 'joined' && b.reassign.ra_id === VK && pK.map((x) => x.rid).join() === [rKarol, rLina].join(), { b: b.reassign, pK });
  check('su vuelta vieja quedó vacía y se quitó', !(await existe(VL)));
  mov = movidos(f0, await foto(), [rLina]);
  check('I · la de Karol sigue saliendo a las 16:00', mov.length === 0, mov);

  // ── C. Juntarse casi sin desvío gana ──
  console.log('\nC. Salida que se puede juntar con su vecina: se junta (un viaje menos)');
  const ANA = await trip('Ana Olivar', fx.olivar), SOFI = await trip('Sofi Olivar', fx.olivar);
  const rAna = await res(ANA, 'sal', at(man, '07:30')), rSofi = await res(SOFI, 'sal', at(man, '10:00'));
  const VA = await vuelta(CARL.dp, 'sal', at(man, '06:20'), [[rAna, at(man, '06:20')]]);
  const VS = await vuelta(MIGU.dp, 'sal', at(man, '09:00'), [[rSofi, at(man, '09:00')]]);
  f0 = await foto();
  const cc = await cambiar(SOFI, rSofi, at(man, '07:35'));
  const pA = await paradasDe(VA);
  check('entra con Ana (su vecina) a la MISMA hora, en la vuelta de Carlos', cc.reassign && cc.reassign.kind === 'joined' && cc.reassign.ra_id === VA && pA.length === 2 && ms(pA[1].eta) === Date.parse(at(man, '06:20')), { cc: cc.reassign, pA });
  check('la de Miguel (solo ella) se quitó: un viaje menos', !(await existe(VS)));
  check('a Miguel: «ya no va en tu vuelta»', (await outbox(MIGU.u, 'Cambió un traslado de tu ruta')).length >= 1);
  mov = movidos(f0, await foto(), [rSofi]);
  check('I · a nadie más se le movió la hora', mov.length === 0, mov);

  // ── D. Entre dos recogidas ──
  console.log('\nD. Salida que entra ENTRE dos recogidas (hay hueco)');
  const LUZ = await trip('Luz Llano', fx.llano), PEDRO = await trip('Pedro Bosques', bosques), TERE = await trip('Tere Olivar', fx.olivar);
  const rLuz = await res(LUZ, 'sal', at(man, '05:20')), rPedro = await res(PEDRO, 'sal', at(man, '05:20')), rTere = await res(TERE, 'sal', at(man, '12:00'));
  const VD = await vuelta(DANI.dp, 'sal', at(man, '04:00'), [[rLuz, at(man, '04:00')], [rPedro, at(man, '04:45')]]);
  const VT = await vuelta(MIGU.dp, 'sal', at(man, '11:00'), [[rTere, at(man, '11:00')]]);
  f0 = await foto();
  const d = await cambiar(TERE, rTere, at(man, '05:35'));
  const pD = await paradasDe(VD);
  check('entra de SEGUNDA, entre Luz (4:00) y Pedro (4:45)', d.reassign && d.reassign.kind === 'joined' && pD.map((x) => x.rid).join() === [rLuz, rTere, rPedro].join(), { d: d.reassign, pD });
  check('su recogida queda entre las dos y en múltiplo de 5', pD.length === 3 && ms(pD[1].eta) > ms(pD[0].eta) && ms(pD[1].eta) < ms(pD[2].eta) && new Date(pD[1].eta).getUTCMinutes() % 5 === 0, pD.map((x) => x.eta));
  check('la vuelta sigue arrancando a las 4:00 (nadie madruga)', ms((await one(`SELECT planned_start_at FROM public.route_assignments WHERE id = $1`, [VD])).planned_start_at) === Date.parse(at(man, '04:00')));
  check('la de Miguel de las 11:00 se quitó', !(await existe(VT)));
  mov = movidos(f0, await foto(), [rTere]);
  check('I · Luz y Pedro conservan su hora', mov.length === 0, mov);

  // ── E. Pidió con el día publicado ──
  console.log('\nE. Pidió con el día publicado: entra sola al pedir');
  await acomodar(true);
  const PEPA = await trip('Pepa Olivar', fx.olivar);
  f0 = await foto();
  const rPepa = await res(PEPA, 'sal', at(man, '07:40'));
  const vPepa = await vueltaDe(rPepa);
  check('al pedir quedó en la vuelta de Carlos con Ana y Sofi (su conjunto)', vPepa && vPepa.id === VA, vPepa);
  e = await inc(rPepa);
  check('rastro «late_booking» RESUELTO solo (no suena a nadie)', e && e.status === 'resolved' && e.category === 'late_booking' && /con el día ya publicado/.test(e.description) && /Se resolvió sola/.test(e.resolution_notes) && e.dedupe_key === 'lateauto:' + rPepa, e);
  check('a Pepa: «Ya tienes carro»', (await outbox(PEPA.u, 'Ya tienes carro%')).some((x) => /te recogemos a las 6:20/.test(x.body)), await outbox(PEPA.u, '%'));
  mov = movidos(f0, await foto(), [rPepa]);
  check('I · a nadie más se le movió la hora', mov.length === 0, mov);
  const LEJ = await trip('Lejana Olivar', fx.olivar);
  const rLej = await res(LEJ, 'sal', at(pas, '07:40'));
  check('un día SIN ruta publicada: no se toca (lo rutea el tablero) y no deja rastro', !(await vueltaDe(rLej)) && !(await inc(rLej)));
  const PRI = await trip('Privada Olivar', fx.olivar);
  const rPri = await res(PRI, 'sal', at(man, '07:40'), { level: 'private', privStatus: 'requested' });
  check('un privado: no se toca', !(await vueltaDe(rPri)));
  await acomodar(false);
  const SCR = await trip('Script Olivar', fx.olivar);
  const rScr = await res(SCR, 'sal', at(man, '07:40'));
  check('con el interruptor de los scripts (rendio.no_acomodar): no se toca', !(await vueltaDe(rScr)));

  // ── F. Flightradar24 ──
  console.log('\nF. Flightradar24: vuelos que bajan después de que sale su vuelta');
  const JESS = await trip('Jess Olivar', fx.olivar), NINA = await trip('Nina Olivar', fx.olivar);
  const rJess = await res(JESS, 'lle', at(man, '12:30'), { notes: 'Vuelo AV9563.' }), rNina = await res(NINA, 'lle', at(man, '12:30'), { notes: 'Vuelo AV9563.' });
  const VF = await vuelta(JUAN.dp, 'lle', at(man, '13:00'), [[rJess, at(man, '13:25')], [rNina, at(man, '13:25')]]);
  const LUCI = await trip('Luci Llano', fx.llano), OTRA3 = await trip('Otra Llano', fx.llano);
  const rLuci = await res(LUCI, 'lle', at(man, '10:40'), { notes: 'Vuelo LA4040.' }), rO3 = await res(OTRA3, 'lle', at(man, '11:30'), { notes: 'Vuelo LA4041.' });
  const VG = await vuelta(DANI.dp, 'lle', at(man, '11:00'), [[rLuci, null]]);
  const VG2 = await vuelta(DANI.dp, 'lle', at(man, '11:50'), [[rO3, null]]);
  const TETE = await trip('Tete Olivar', fx.olivar), ROSA = await trip('Rosa Olivar', fx.olivar);
  const rTete = await res(TETE, 'lle', at(man, '16:00'), { notes: 'Vuelo AV2222.' }), rRosa = await res(ROSA, 'lle', at(man, '16:00'), { notes: 'Vuelo AV3333.' });
  const VP = await vuelta(MIGU.dp, 'lle', at(man, '16:30'), [[rTete, null], [rRosa, null]]);
  const fs_ = async (code, iso, delay, status = 'delayed') => q(`INSERT INTO public.flight_statuses (organization_id, flight_code, flight_date, direction, sched_at, estimated_at, status, delay_min, source)
      VALUES ($1, $2, $3::date, 'airport_to_home', $4::timestamptz - make_interval(mins => $5), $4::timestamptz, $6, $5, 'mock')`, [fx.org, code, man, iso, delay, status]);
  await fs_('AV9563', at(man, '13:20'), 50);          // Jess y Nina: las dos tarde
  await fs_('LA4040', at(man, '11:30'), 50);          // Luci: tarde, y Daniel sale 11:50 con otra
  await fs_('AV3333', at(man, '17:10'), 70);          // Rosa tarde; Tete (AV2222) sin dato: a tiempo
  await fs_('AV2222', at(man, '16:00'), 0, 'scheduled');
  f0 = await foto();
  const s1 = await barrer();
  const depAV = (await one(`SELECT public.flight_deplane_min('AV9563') m`)).m, depLA = (await one(`SELECT public.flight_deplane_min('LA4040') m`)).m, depAV3 = (await one(`SELECT public.flight_deplane_min('AV3333') m`)).m;
  const vf = await one(`SELECT * FROM public.route_assignments WHERE id = $1`, [VF]);
  const espF = arriba5(Date.parse(at(man, '13:20')) + depAV * 60000);
  check(`las dos vienen tarde: la vuelta de Juan entera sale de JMC a las ${hm(espF)} (con Juan)`, vf && ms(vf.planned_start_at) === espF && vf.driver_profile_id === JUAN.dp && (await paradasDe(VF)).length === 2, { s1, vf: vf && [vf.planned_start_at, vf.driver_profile_id] });
  check('a Jess y Nina: «Tu vuelo viene a otra hora» · a Juan: «Tu vuelta cambió de hora»', (await outbox(JESS.u, 'Tu vuelo viene a otra hora%')).length === 1 && (await outbox(NINA.u, 'Tu vuelo viene a otra hora%')).length === 1 && (await outbox(JUAN.u, '%ahora sale de JMC a las ' + hm(espF) + '%')).length === 1);
  e = await inc(rJess);
  check('rastro «flight_delay» RESUELTO para cada una', e && e.status === 'resolved' && e.category === 'flight_delay' && e.resolution_notes.includes('pasó de las 13:00 a las ' + hm(espF)) && !!(await inc(rNina)), e);
  const vg = await one(`SELECT * FROM public.route_assignments WHERE id = $1`, [VG]);
  const espG = arriba5(Date.parse(at(man, '11:30')) + depLA * 60000);
  check(`Daniel no alcanza (sale 11:50 con otra): la de Luci queda PARA TOMAR a las ${hm(espG)}`, vg && vg.pool === true && vg.auto_created === true && vg.driver_profile_id === null && ms(vg.planned_start_at) === espG, vg && [vg.pool, vg.driver_profile_id, vg.planned_start_at]);
  check('a Daniel: «Ya no haces una vuelta» · a los conductores: «Hay una vuelta para tomar»', (await outbox(DANI.u, 'Ya no haces una vuelta')).length === 1 && (await outbox(MIGU.u, 'Hay una vuelta para tomar')).some((x) => /el vuelo viene tarde/.test(x.body)));
  const vRosa = await vueltaDe(rRosa);
  const espR = arriba5(Date.parse(at(man, '17:10')) + depAV3 * 60000);
  check(`solo Rosa viene tarde: sale de la vuelta de Miguel y queda en una que sale a las ${hm(espR)} o después`, vRosa && vRosa.id !== VP && ms(vRosa.planned_start_at) >= espR && (await paradasDe(VP)).map((x) => x.rid).join() === rTete, { vRosa: vRosa && [vRosa.id, vRosa.planned_start_at] });
  check('Tete sigue en la de las 16:30', ms((await one(`SELECT planned_start_at FROM public.route_assignments WHERE id = $1`, [VP])).planned_start_at) === Date.parse(at(man, '16:30')));
  mov = movidos(f0, await foto(), [rJess, rNina, rLuci, rRosa]);
  check('I · a nadie más se le movió la hora', mov.length === 0, mov);
  const nInc = (await one(`SELECT count(*)::int n FROM public.incidents`)).n, nOut = (await one(`SELECT count(*)::int n FROM public.notification_outbox`)).n;
  const s2 = await barrer();
  check('correrlo otra vez no hace nada (ni rastros ni avisos repetidos)', s2.vuelos === 0 && (await one(`SELECT count(*)::int n FROM public.incidents`)).n === nInc && (await one(`SELECT count(*)::int n FROM public.notification_outbox`)).n === nOut, { s2 });

  // ── G. Cambio de vuelo que quedó esperando ──
  console.log('\nG. Cambio de vuelo que quedó esperando a Coordinación (antes de 0134)');
  const CAMI = await trip('Cami Olivar', fx.olivar);
  const rCami = await res(CAMI, 'lle', at(man, '18:00'), { notes: 'Vuelo AV9358. Llevo maleta' });
  const VC = await vuelta(MIGU.dp, 'lle', at(man, '18:20'), [[rCami, null]]);
  const viejo = (await one(`INSERT INTO public.incidents (organization_id, reservation_id, category, severity, status, description, scope, source, details)
    VALUES ($1, $2, 'flight_delay', 'medium', 'open', 'Cambió su vuelo (llegada): viejo', 'operacion', 'system', $3) RETURNING id`,
    [fx.org, rCami, { kind: 'aux_change_flight', old_when: at(man, '18:00'), new_when: at(man, '18:40'), old_flight: 'AV9358', new_flight: 'AV9000', direction: 'airport_to_home', published: true }])).id;
  const ultimo = (await one(`INSERT INTO public.incidents (organization_id, reservation_id, category, severity, status, description, scope, source, details, created_at)
    VALUES ($1, $2, 'flight_delay', 'medium', 'open', 'Cambió su vuelo (llegada): último', 'operacion', 'system', $3, now() + interval '1 second') RETURNING id`,
    [fx.org, rCami, { kind: 'aux_change_flight', old_when: at(man, '18:00'), new_when: at(man, '19:00'), old_flight: 'AV9358', new_flight: 'AV9384', direction: 'airport_to_home', published: true }])).id;
  const sg = await barrer();
  const rC = await one(`SELECT required_arrival_at, notes, flight_code FROM public.reservations WHERE id = $1`, [rCami]);
  check('aplica el ÚLTIMO que pidió: 19:00, vuelo AV9384, su nota se conserva', sg.cambios === 1 && ms(rC.required_arrival_at) === Date.parse(at(man, '19:00')) && rC.flight_code === 'AV9384' && rC.notes === 'Vuelo AV9384. Llevo maleta', { sg, rC });
  const vc = await one(`SELECT * FROM public.route_assignments WHERE id = $1`, [VC]);
  check('y la reubica: Miguel alcanza, su vuelta se corre', vc && vc.driver_profile_id === MIGU.dp && ms(vc.planned_start_at) === arriba5(Date.parse(at(man, '19:00')) + dep * 60000), vc && vc.planned_start_at);
  const ev = await q(`SELECT id, status::text, resolution_notes FROM public.incidents WHERE id = ANY ($1::uuid[])`, [[viejo, ultimo]]);
  check('las dos eventualidades quedan RESUELTAS con lo que hizo el sistema', ev.length === 2 && ev.every((x) => x.status === 'resolved' && /El sistema aplicó el cambio que había pedido \(.*19:00 · vuelo AV9384\)/.test(x.resolution_notes)), ev);

  // ── H. «No tiene carro» abierta ──
  console.log('\nH. «X no tiene carro» abierta: el sistema la ubica');
  const PAU = await trip('Paula Olivar', fx.olivar);
  await acomodar(false);
  const rPau = await res(PAU, 'lle', at(man, '23:35'), { notes: null, place: 'rio_verde' });
  await acomodar(true);
  await q(`INSERT INTO public.incidents (organization_id, reservation_id, category, severity, status, description, scope, source, details, dedupe_key)
    VALUES ($1, $2, 'late_booking', 'high', 'open', 'Paula no tiene carro', 'operacion', 'system', '{"kind":"late_booking"}', $3)`, [fx.org, rPau, 'late:' + rPau]);
  f0 = await foto();
  const sh = await barrer();
  const vPau = await vueltaDe(rPau);
  e = await inc(rPau, `AND category = 'late_booking'`);
  check('de reserva en el Hotel Río Verde: NO entra en la de Juan de las 23:45 (sale de JMC); vuelta NUEVA para tomar a las 23:35', sh.sin_carro === 1 && vPau && vPau.id !== VJ2345 && vPau.pool === true && vPau.auto_created === true && ms(vPau.planned_start_at) === Date.parse(at(man, '23:35')), { sh, vPau: vPau && [vPau.id, vPau.planned_start_at, vPau.pool] });
  check('la eventualidad queda RESUELTA con lo que hizo', e && e.status === 'resolved' && /Se resolvió sola/.test(e.resolution_notes), e);
  mov = movidos(f0, await foto(), [rPau]);
  check('I · a nadie más se le movió la hora', mov.length === 0, mov);

  // ── J. Permisos y el down ──
  console.log('\nJ. Permisos y el down');
  const pr = await one(`SELECT has_function_privilege('authenticated', 'public.reubicar_reserva(uuid,timestamptz,text)', 'EXECUTE') a,
                               has_function_privilege('authenticated', 'public.acomodar_eventualidades(timestamptz)', 'EXECUTE') b,
                               has_function_privilege('authenticated', 'public.reub_rastro(uuid,text,text,jsonb,text,jsonb)', 'EXECUTE') c2,
                               has_function_privilege('anon', 'public.reub_conductor_libre(uuid,uuid,uuid,timestamptz,uuid,double precision,double precision,boolean,timestamptz,uuid,double precision,double precision,boolean)', 'EXECUTE') d,
                               has_function_privilege('authenticated', 'public.auxiliar_change_flight(uuid,text,timestamptz,text)', 'EXECUTE') f`);
  check('las internas no se llaman desde la app; el cambio de vuelo sí', !pr.a && !pr.b && !pr.c2 && !pr.d && pr.f, pr);
  const cron = await one(`SELECT to_regclass('cron.job') IS NOT NULL AS hay`);
  if (cron.hay) check('pg_cron: «acomodar-eventualidades» cada 5 min', !!(await one(`SELECT 1 FROM cron.job WHERE jobname = 'acomodar-eventualidades' AND schedule = '*/5 * * * *'`)));
  await c.query('SAVEPOINT down');
  await c.query(strip('../down_migrations/0135_acomodar_eventualidades.down.sql'));
  const hd = { cf: await huella('auxiliar_change_flight'), rr: await huella('reubicar_reserva'), cand: await huella('reub_candidatas'), hb: await huella('hm_bog') };
  const tg = await one(`SELECT count(*)::int n FROM pg_trigger WHERE tgname = 'tr_reservations_acomodar'`);
  check('el down deja el cambio de vuelo y la reubicación EXACTAMENTE como en 0134 y quita el acomodo al pedir', hd.cf === h0134.cf && hd.rr === h0134.rr && hd.cand === h0134.cand && hd.hb === h0134.hb && tg.n === 0, { hd, h0134, tg });
  await c.query('ROLLBACK TO SAVEPOINT down');
} catch (e) {
  fail++; console.log('  ✗ error: ' + e.message + (e.where ? ' · ' + e.where.split('\n')[0] : ''));
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok} ✓ · ${fail} ✗`);
console.log('NO cubre: la pantalla, la push de verdad, tiempos reales de carretera (aquí la cuenta sin mapa), el pg_cron de verdad, ni dev/producción.');
process.exit(fail ? 1 : 0);
