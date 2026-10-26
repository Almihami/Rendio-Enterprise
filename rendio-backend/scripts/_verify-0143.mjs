// Verificación de 0143 (pegar la ruta de Julián ya no borra lo que armó el
// sistema; la madrugada cuenta también para el día anterior) contra la base
// LOCAL (127.0.0.1:54322). Aplica 0124–0136, 0141 y 0143 dentro de una
// transacción que se deshace: no queda nada. Nunca apunta a dev ni a producción.
//
//   cd rendio-backend/scripts && node _verify-0143.mjs        (antes de las 9 p. m.)
//
//   A. Pegar (el caso de las 4:20:34 p. m. del 26-oct): hay vueltas armadas solas
//      (una sin tomar, una tomada por un conductor, una de alguien que SÍ viene en
//      lo pegado). Con 0133 se borran las que no vienen (la prueba exige que el
//      código viejo FALLE así). Con 0143: se quedan; quien viene en lo pegado sale
//      de su vuelta automática (sin quedar en dos carros) y, si la tenía un
//      conductor, se le avisa. Volver a pegar y «Quitar la ruta» tampoco las tocan.
//   B. Madrugada: HOY publicado, mañana sin plan. Con 0141, quien sale 0:55 de
//      mañana sin carro no avisa. Con 0143 avisa, el acomodo la ubica (día del plan
//      = hoy) y un pedido nuevo de 1:30 a. m. entra solo. Los de mañana de día
//      siguen sin sonar.
//   C. Las huellas: lo de antes de 0143 es idéntico a producción; el down vuelve.
//
// NO cubre: la pantalla, la push de verdad, el pg_cron de verdad, ni dev/producción.
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
const huella = async (sig) => (await one(`SELECT md5(prosrc) h FROM pg_proc WHERE oid = to_regprocedure($1)`, [sig]))?.h || null;
const F = { pub: 'public.admin_manual_route_publish(date,jsonb,jsonb)', clr: 'public.admin_manual_route_clear(date)',
  det: 'public.detect_late_bookings()', rr: 'public.reubicar_reserva(uuid,timestamptz,text)' };
// Producción y dev el 26-oct-2026 a las 4:45 p. m., con 0141 (las mismas en los dos).
const PROD = { pub: '34fc4cdee3644ed9e337d657987fabeb', clr: '45cc9be26c002f5fa8cc9ff3664be5ce',
  det: 'ef0b6f54b699a25b6a8ad61019b054e8', rr: '481ec704bb105ccc831bd7ac6f976176' };
const huellas = async () => { const o = {}; for (const [k, s] of Object.entries(F)) o[k] = await huella(s); return o; };

const hora = (await one(`SELECT extract(hour FROM now() AT TIME ZONE 'America/Bogota')::int h`)).h;
if (hora >= 21) { console.log('Correr antes de las 9 p. m.'); process.exit(2); }

await c.query('BEGIN');
try {
  if (!(await one(`SELECT to_regprocedure('public.ops_alert_recipients_of(uuid)') IS NOT NULL AS ok`)).ok) await c.query(strip('../supabase/migrations/0117_avisos_desde_el_servidor.sql'));
  for (const m of ['0124_carro_del_turno', '0125_ruta_de_julian', '0126_vuelta_delegada', '0127_aviso_sin_carro_espera', '0128_aviso_vuelta_terminada',
    '0129_conductor_de_una_vuelta', '0130_corte_de_pedidos', '0131_delegado_con_nombre', '0132_carro_del_plan', '0133_pasajero_sin_cuenta',
    '0134_reubicar_al_cambiar', '0135_acomodar_eventualidades', '0136_aviso_vuelta_iniciada', '0141_sin_carro_dia_del_plan']) await c.query(strip(`../supabase/migrations/${m}.sql`));
  const antes = await huellas();
  check('lo de antes de 0143 es idéntico a producción (pegar 0133, quitar 0125, detector y reubicar 0141)', JSON.stringify(antes) === JSON.stringify(PROD), antes);

  await q(`SELECT set_config('rendio.no_acomodar', 'on', true)`);
  const fx = await fixtures(c);
  const jefe = await user(c, fx.org, 'admin', 'Christian prueba 0143');
  const drv = async (name) => { const u = await user(c, fx.org, 'driver', name); return { u, dp: (await one(`INSERT INTO public.driver_profiles (profile_id) VALUES ($1) RETURNING id`, [u])).id }; };
  const JUAN = await drv('Juan Ospina prueba 0143'), DANI = await drv('Daniel Alvarez prueba 0143');
  let n = 0;
  const trip = async (name) => { const u = await user(c, fx.org, 'auxiliar', `${name} ${++n}`); return { u, a: (await one(`INSERT INTO public.auxiliar_profiles (profile_id, residence_id) VALUES ($1, $2) RETURNING id`, [u, fx.olivar])).id }; };
  const hoy = (await one(`SELECT (now() AT TIME ZONE 'America/Bogota')::date::text d`)).d;
  const man = (await one(`SELECT ((now() AT TIME ZONE 'America/Bogota')::date + 1)::text d`)).d;
  const at = (d, h) => `${d}T${h}:00-05:00`;
  const res = async (X, dir, whenIso) => (await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, ${dir === 'sal' ? 'status_h2a' : 'status_a2h'}, required_arrival_at, pickup_address, pickup_latitude, pickup_longitude, residence_id, notes)
      VALUES ($1, $2, $3, $4::timestamptz, 'El Olivar, Rionegro', 6.1523, -75.3781, $5, $6) RETURNING id`,
    [X.a, dir === 'sal' ? 'home_to_airport' : 'airport_to_home', dir === 'sal' ? 'requested' : 'scheduled', whenIso, fx.olivar, dir === 'lle' ? 'Vuelo AV9563.' : null])).id;
  const vuelta = async (rid, dir, startIso, extra = {}) => {
    const ra = (await one(`INSERT INTO public.route_assignments (driver_profile_id, direction, status, planned_start_at, plan_car, pool, auto_created, organization_id, manual_day)
      VALUES ($1, $2, 'planned', $3::timestamptz, 'Carro 1', $4, $5, $6, $7::date) RETURNING id`,
      [extra.dp || null, dir === 'sal' ? 'home_to_airport' : 'airport_to_home', startIso, !!extra.pool, !!extra.auto, fx.org, extra.dia || null])).id;
    await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order) VALUES ($1, $2, 1)`, [ra, rid]);
    return ra;
  };
  const existe = async (ra) => !!(await one(`SELECT 1 FROM public.route_assignments WHERE id = $1`, [ra]));
  const vueltasDe = async (rid) => q(`SELECT ra.id, coalesce(ra.auto_created, false) auto, ra.pool FROM public.route_stops rs JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
    WHERE rs.reservation_id = $1 AND ra.status IN ('planned','in_progress')`, [rid]);
  const pegar = async (dia, bloques) => { await asUser(c, jefe, 'admin'); try { return (await one(`SELECT public.admin_manual_route_publish($1::date, $2::jsonb, '[]'::jsonb) r`, [dia, JSON.stringify(bloques)])).r; } finally { await asDb(); } };
  const quitar = async (dia) => { await asUser(c, jefe, 'admin'); try { return (await one(`SELECT public.admin_manual_route_clear($1::date) n`, [dia])).n; } finally { await asDb(); } };
  const enSavepoint = async (fn) => { await c.query('SAVEPOINT sp'); try { return await fn(); } finally { await c.query('ROLLBACK TO SAVEPOINT sp'); } };

  // ── A. Pegar ──────────────────────────────────────────────────────────────
  const L = await trip('Luz'), W = await trip('Manuela'), X = await trip('Paula'), Qp = await trip('Sara'), T = await trip('Tomás');
  const rL = await res(L, 'sal', at(man, '05:30')), rW = await res(W, 'lle', at(man, '16:35')), rX = await res(X, 'lle', at(man, '23:59'));
  const rQ = await res(Qp, 'sal', at(man, '08:00')), rT = await res(T, 'sal', at(man, '09:00'));
  const pegarEscenario = async () => {
    const aW = await vuelta(rW, 'lle', at(man, '16:55'), { pool: true, auto: true, dia: man });
    const aX = await vuelta(rX, 'lle', at(man, '23:59'), { pool: true, auto: true, dia: man, dp: DANI.dp });
    const aQ = await vuelta(rQ, 'sal', at(man, '07:10'), { pool: true, auto: true, dia: man });
    const aT = await vuelta(rT, 'sal', at(man, '08:10'), { pool: true, auto: true, dia: man, dp: DANI.dp });
    const RUTA = (conQT) => [
      { type: 'sal', deadline_at: at(man, '05:30'), stops: [{ reservation_id: rL, at: at(man, '04:15') }] },
      ...(conQT ? [{ type: 'sal', deadline_at: at(man, '08:00'), stops: [{ reservation_id: rQ, at: at(man, '07:00') }, { reservation_id: rT, at: at(man, '07:10') }] }] : []),
    ];
    const p1 = await pegar(man, RUTA(true));
    const r = { p1, w: await existe(aW), x: await existe(aX), q: await existe(aQ), t: await existe(aT),
      qVueltas: await vueltasDe(rQ), tVueltas: await vueltasDe(rT),
      avisoDani: (await q(`SELECT count(*)::int n FROM public.notification_outbox WHERE profile_id = $1 AND title = 'Cambió una vuelta que tomaste'`, [DANI.u]))[0].n };
    const p2 = await pegar(man, RUTA(false));
    r.p2 = p2; r.w2 = await existe(aW); r.x2 = await existe(aX);
    r.clear = await quitar(man); r.w3 = await existe(aW); r.x3 = await existe(aX);
    r.pegadasQuedan = (await one(`SELECT count(*)::int n FROM public.route_assignments WHERE pool AND NOT coalesce(auto_created,false) AND manual_day = $1::date AND organization_id = $2`, [man, fx.org])).n;
    return r;
  };
  const viejoA = await enSavepoint(pegarEscenario);
  check('A. (código viejo) pegar BORRA las vueltas armadas solas que no vienen en lo pegado (Manuela y la tomada de Paula)', !viejoA.w && !viejoA.x, viejoA);

  // ── B. Madrugada (antes de 0143, con 0141) ────────────────────────────────
  const A = await trip('Ana'), M = await trip('Moisés'), Y = await trip('Sebastian'), N = await trip('Yerly'), Y2 = await trip('Josmar');
  const rA = await res(A, 'sal', at(hoy, '23:30'));
  await vuelta(rA, 'sal', at(hoy, '22:40'), { dp: JUAN.dp });
  const rM = await res(M, 'sal', at(man, '00:55')), rY = await res(Y, 'sal', at(man, '10:00'));
  const pasan = async (min) => {
    await q(`UPDATE public.late_booking_candidates SET created_at = created_at - make_interval(mins => $1)`, [min]);
    await q(`UPDATE public.route_assignments SET created_at = created_at - make_interval(mins => $1)`, [min]);
  };
  const dosPasadas = async () => { await pasan(10); await q(`SELECT public.detect_late_bookings()`); await pasan(10); await q(`SELECT public.detect_late_bookings()`); };
  const abierta = async (rid) => !!(await one(`SELECT 1 FROM public.incidents WHERE reservation_id = $1 AND category = 'late_booking' AND NOT coalesce((details->>'auto')::boolean, false)`, [rid]));
  const madrugada = async () => {
    await q(`SELECT set_config('rendio.no_acomodar', 'on', true)`);
    await dosPasadas();
    const r = { m: await abierta(rM), y: await abierta(rY) };
    await q(`SELECT public.acomodar_eventualidades()`);
    r.mVuelta = await one(`SELECT coalesce(ra.auto_created,false) auto, ra.manual_day::text dia FROM public.route_stops rs JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id WHERE rs.reservation_id = $1`, [rM]);
    r.yVuelta = (await vueltasDe(rY)).length;
    await q(`SELECT set_config('rendio.no_acomodar', '', true)`);
    const rN = await res(N, 'lle', at(man, '01:30')), rY2 = await res(Y2, 'sal', at(man, '11:00'));
    r.nEntro = (await vueltasDe(rN)).length > 0; r.y2Entro = (await vueltasDe(rY2)).length > 0;
    return r;
  };
  const viejoB = await enSavepoint(madrugada);
  check('B. (código viejo, 0141) la salida de las 0:55 sin carro NO avisa', viejoB.m === false && viejoB.y === false, viejoB);

  // ── 0143 ──────────────────────────────────────────────────────────────────
  await c.query(strip('../supabase/migrations/0143_pegar_no_borra_automaticas.sql'));
  await c.query(strip('../supabase/migrations/0143_pegar_no_borra_automaticas.sql'));
  check('0143 se aplica encima de 0141 (y se puede volver a correr)', true);
  const a = await enSavepoint(pegarEscenario);
  check('A. pegar: la vuelta armada sola de Manuela (no viene en lo pegado) se queda', a.w, a);
  check('A. pegar: la armada sola de Paula, tomada por un conductor, se queda (con su conductor)', a.x, a);
  check('A. quien SÍ viene en lo pegado sale de su vuelta automática: queda en UNA sola vuelta, la pegada',
    !a.q && a.qVueltas.length === 1 && !a.qVueltas[0].auto && a.qVueltas[0].pool && a.tVueltas.length === 1 && !a.tVueltas[0].auto, a);
  check('A. la automática que tenía un conductor y quedó vacía: se quita y al conductor le llega «Cambió una vuelta que tomaste»', !a.t && a.avisoDani === 1, a);
  check('A. volver a pegar sin ellas: las armadas solas siguen ahí', a.w2 && a.x2, a);
  check('A. «Quitar la ruta» quita lo pegado y deja las armadas solas', a.w3 && a.x3 && a.pegadasQuedan === 0 && a.clear >= 1, a);
  const b = await enSavepoint(madrugada);
  check('B. madrugada: la salida de las 0:55 sin carro SÍ avisa (hoy está publicado)', b.m === true, b);
  check('B. y el acomodo la ubica en una vuelta armada sola del día de HOY (su plan)', b.mVuelta && b.mVuelta.auto && b.mVuelta.dia === hoy, b);
  check('B. los de mañana de día siguen sin sonar ni vuelta (mañana sin plan)', b.y === false && b.yVuelta === 0 && b.y2Entro === false, b);
  check('B. un pedido nuevo de la madrugada (1:30 a. m.) entra solo', b.nEntro === true, b);
  const dm = await one(`SELECT public.dia_madrugada($1::timestamptz)::text a, public.dia_madrugada($2::timestamptz)::text b, public.dia_madrugada($3::timestamptz)::text c3`,
    [at(man, '00:00'), at(man, '01:59'), at(man, '02:00')]);
  check('dia_madrugada: 0:00 y 1:59 son del día anterior; 2:00 ya no', dm.a === hoy && dm.b === hoy && dm.c3 === null, dm);

  // ── C. Permisos y el down ────────────────────────────────────────────────
  const perm = await one(`SELECT has_function_privilege('authenticated', '${F.pub}', 'EXECUTE') pub, has_function_privilege('anon', '${F.pub}', 'EXECUTE') pub_anon,
    has_function_privilege('authenticated', '${F.clr}', 'EXECUTE') clr, has_function_privilege('authenticated', 'public.dia_madrugada(timestamptz)', 'EXECUTE') dm,
    has_function_privilege('authenticated', '${F.rr}', 'EXECUTE') rr`);
  check('permisos: pegar/quitar para jefes (authenticated, no anon); dia_madrugada y reubicar cerradas', perm.pub && !perm.pub_anon && perm.clr && !perm.dm && !perm.rr, perm);
  await c.query('SAVEPOINT down');
  await c.query(strip('../down_migrations/0143_pegar_no_borra_automaticas.down.sql'));
  const tras = await huellas();
  const sinDm = (await one(`SELECT to_regprocedure('public.dia_madrugada(timestamptz)') IS NULL ok`)).ok;
  check('C. el down vuelve exactamente a lo de producción y quita dia_madrugada', JSON.stringify(tras) === JSON.stringify(PROD) && sinDm, tras);
  await c.query('ROLLBACK TO SAVEPOINT down');
} catch (e) {
  fail++; console.log('  ✗ error: ' + e.message + (e.where ? ' · ' + e.where.split('\n')[0] : ''));
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok}/${ok + fail} ${fail ? '✗' : '✓'}`);
process.exit(fail ? 1 : 0);
