// Verificación de 0129 (cambiar el conductor de UNA vuelta publicada, sin
// re-publicar el día) contra la base LOCAL (127.0.0.1:54322). Aplica lo que falte
// (0117, 0124–0126) y 0129 dentro de una transacción que se deshace: no queda nada.
// Nunca apunta a dev ni a producción.
//
//   cd rendio-backend/scripts && node _verify-0129.mjs
//
// Qué prueba:
//   1. Vuelta del tablero con Juan → Daniel: cambia SOLO esa fila (la otra vuelta
//      ni se toca), la placa pasa a la del turno de Daniel, las reservas siguen
//      «asignadas» con su hora. Avisos: a los tripulantes «Te cambiamos el
//      conductor 🔄 · Ahora te recoge Daniel Álvarez a las 4:30 en el carro HYU376.»,
//      a Daniel «Te asignaron una vuelta 🗺️», a Juan «Ya no haces una vuelta».
//      Ponerle el mismo conductor no cambia ni avisa nada.
//   2. Quitar el conductor: borrador, sin placa, reservas «pedidas»; a Daniel «Ya
//      no haces»; a los tripulantes nada.
//   3. Un borrador sin conductor → Juan: publicada; «Juan Andres te recoge 🚗».
//   4. Una delegada → Daniel: deja de ser delegada.
//   5. Una pegada por Julián (pool): el jefe se la da a Daniel → ya no sale en la
//      lista de Juan; sin conductor → vuelve a la lista (planned, no borrador).
//   6. La que ya arrancó no se cambia por aquí; un conductor de otra organización
//      tampoco; ni conductor ni tripulante ni anónimo llaman la función; el jefe de
//      otra organización no la ve.
//   7. El down quita la función.
//
// NO cubre: la pantalla (Asignación: _smoke-rutas-v2-dom.mjs), la push de verdad
// ni dev/producción.
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
async function debeFallar(sql, params) {
  await c.query('SAVEPOINT sp_f');
  try { await c.query(sql, params); await c.query('RELEASE SAVEPOINT sp_f'); return null; }
  catch (e) { await c.query('ROLLBACK TO SAVEPOINT sp_f'); return e; }
}
const asDb = async () => { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', '', true)`); };
const strip = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const existe = async (sql) => (await one(`SELECT (${sql}) IS NOT NULL AS ok`)).ok;

await c.query('BEGIN');
try {
  if (!(await existe(`to_regprocedure('public.ops_alert_recipients_of(uuid)')`))) await c.query(strip('../supabase/migrations/0117_avisos_desde_el_servidor.sql'));
  if (!(await existe(`(SELECT 1 FROM information_schema.columns WHERE table_name = 'route_assignments' AND column_name = 'plan_car')`))) await c.query(strip('../supabase/migrations/0124_carro_del_turno.sql'));
  if (!(await existe(`to_regprocedure('public.hm_bog(timestamptz)')`))) await c.query(strip('../supabase/migrations/0125_ruta_de_julian.sql'));
  if (!(await existe(`to_regprocedure('public.admin_route_set_delegated(uuid,boolean)')`))) await c.query(strip('../supabase/migrations/0126_vuelta_delegada.sql'));
  await c.query(strip('../supabase/migrations/0129_conductor_de_una_vuelta.sql'));
  await c.query(strip('../supabase/migrations/0129_conductor_de_una_vuelta.sql'));
  check('0129 se aplica encima de 0126 (y se puede volver a correr)', true);

  const fx = await fixtures(c);
  const jefe = await user(c, fx.org, 'admin', 'Camilo prueba 0129');
  const drv = async (name, org = fx.org) => { const u = await user(c, org, 'driver', name); return { u, dp: (await one(`INSERT INTO public.driver_profiles (profile_id) VALUES ($1) RETURNING id`, [u])).id }; };
  const JUAN = await drv('Juan Andres prueba 0129'), DANI = await drv('Daniel Álvarez prueba 0129');
  const HYU = (await one(`INSERT INTO public.vehicles (organization_id, internal_code, license_plate) VALUES ($1, 'HYU376', 'HYU376') RETURNING id`, [fx.org])).id;
  const PRW = (await one(`INSERT INTO public.vehicles (organization_id, internal_code, license_plate) VALUES ($1, 'PRW443', 'PRW443') RETURNING id`, [fx.org])).id;
  const trip = async (name) => { const u = await user(c, fx.org, 'auxiliar', name); return { u, a: (await one(`INSERT INTO public.auxiliar_profiles (profile_id, residence_id) VALUES ($1, $2) RETURNING id`, [u, fx.olivar])).id }; };
  const LUZ = await trip('Luz Bomba prueba'), SARA = await trip('Sara Villegas prueba'), JESS = await trip('Jessica Mora prueba'), MAR = await trip('Margy Ruiz prueba');
  const hoy = (await one(`SELECT (now() AT TIME ZONE 'America/Bogota')::date::text d`)).d;
  const at = (hm) => `${hoy}T${hm}:00-05:00`;
  // Turnos abiertos hoy desde las 3:00: Juan en PRW443, Daniel en HYU376 (0124 pone la placa).
  await q(`INSERT INTO public.shifts (organization_id, driver_id, vehicle_id, status, start_at) VALUES ($1, $2, $3, 'active', $4::timestamptz), ($1, $5, $6, 'active', $4::timestamptz)`, [fx.org, JUAN.dp, PRW, at('03:00'), DANI.dp, HYU]);
  const res = async (X, whenIso) => (await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_h2a, required_arrival_at, pickup_address, pickup_latitude, pickup_longitude, residence_id)
      VALUES ($1, 'home_to_airport', 'requested', $2::timestamptz, 'El Olivar, Rionegro', 6.1523, -75.3781, $3) RETURNING id`, [X.a, whenIso, fx.olivar])).id;
  const vuelta = async (o) => {
    const ra = (await one(`INSERT INTO public.route_assignments (driver_profile_id, direction, status, planned_start_at, pool, organization_id, delegated_at)
        VALUES ($1, 'home_to_airport', $2, $3::timestamptz, $4, $5, $6) RETURNING id`, [o.d || null, o.st || 'planned', o.t, !!o.pool, o.pool ? fx.org : null, o.deleg ? new Date().toISOString() : null])).id;
    for (let i = 0; i < o.stops.length; i++) await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at) VALUES ($1, $2, $3, $4::timestamptz)`, [ra, o.stops[i][0], i + 1, o.stops[i][1]]);
    await q(`SELECT public.route_sync_assigned($1)`, [ra]);
    return ra;
  };
  const fila = async (ra) => { await asDb(); return one(`SELECT ra.driver_profile_id AS d, ra.status, ra.vehicle_id AS v, ra.delegated_at AS deleg, ra.ctid::text AS u FROM public.route_assignments ra WHERE id = $1`, [ra]); };
  const reserva = async (id) => { await asDb(); return one(`SELECT status_h2a::text h2a, calculated_pickup_at FROM public.reservations WHERE id = $1`, [id]); };
  const avisos = async (prof, like) => { await asDb(); return q(`SELECT title, body FROM public.notification_outbox WHERE profile_id = $1 AND dedupe_key LIKE 'setdrv:%' AND (title ILIKE $2 OR body ILIKE $2) ORDER BY created_at`, [prof, like]); };
  const poner = async (ra, d, quien = jefe, rol = 'admin') => { await asUser(c, quien, rol); try { return (await one(`SELECT public.admin_route_set_driver($1, $2) r`, [ra, d])).r; } finally { await asDb(); } };
  const abiertas = async (D) => { await asUser(c, D.u, 'driver'); const l = (await one(`SELECT public.driver_open_routes() l`)).l; await asDb(); return l || []; };

  // ── 1. Juan → Daniel ──────────────────────────────────────────────────────
  console.log('\n1. Cambiar el conductor de una vuelta publicada');
  const rLuz = await res(LUZ, at('06:00')), rSara = await res(SARA, at('06:00')), rJess = await res(JESS, at('09:00'));
  const raA = await vuelta({ d: JUAN.dp, t: at('04:20'), stops: [[rLuz, at('04:30')], [rSara, at('04:40')]] });
  const raB = await vuelta({ d: JUAN.dp, t: at('07:20'), stops: [[rJess, at('07:30')]] });
  const antesB = await fila(raB);
  check('arranca con Juan en su carro (PRW443) y las reservas «asignadas»', (await fila(raA)).v === PRW && (await reserva(rLuz)).h2a === 'assigned');
  const r1 = await poner(raA, DANI.dp);
  const fA = await fila(raA), fB = await fila(raB);
  check('la vuelta queda con Daniel, publicada', fA.d === DANI.dp && fA.status === 'planned', fA);
  check('la placa pasa a la del turno de Daniel (HYU376)', fA.v === HYU && r1.plate === 'HYU376', { v: fA.v, plate: r1.plate });
  check('la OTRA vuelta de Juan ni se toca (la fila no se reescribió: mismo ctid)', fB.d === JUAN.dp && String(fB.u) === String(antesB.u), { antesB, fB });
  const rl = await reserva(rLuz);
  check('las reservas siguen «asignadas» y con su hora (4:30)', rl.h2a === 'assigned' && Date.parse(rl.calculated_pickup_at) === Date.parse(at('04:30')), rl);
  const aLuz = await avisos(LUZ.u, '%');
  check('a Luz: «Te cambiamos el conductor 🔄 · Ahora te recoge Daniel Álvarez a las 4:30 en el carro HYU376.»', aLuz.length === 1 && aLuz[0].title === 'Te cambiamos el conductor 🔄' && aLuz[0].body === 'Ahora te recoge Daniel Álvarez a las 4:30 en el carro HYU376.', aLuz);
  check('responde a cuántos tripulantes avisó (2)', r1.notified === 2, r1);
  const aDan = await avisos(DANI.u, 'Te asignaron%');
  check('a Daniel: «Te asignaron una vuelta 🗺️ · Salida de las 4:30 · 2 tripulantes…»', aDan.length === 1 && /^Salida de las 4:30 · 2 tripulantes\./.test(aDan[0].body), aDan);
  const aJuan = await avisos(JUAN.u, 'Ya no haces%');
  check('a Juan: «Ya no haces una vuelta · …la vuelta de las 4:30 a otro conductor.»', aJuan.length === 1 && /4:30 a otro conductor/.test(aJuan[0].body), aJuan);
  check('a Jessica (la otra vuelta) no le llega nada', (await avisos(JESS.u, '%')).length === 0);
  const r1b = await poner(raA, DANI.dp);
  check('ponerle el mismo conductor: no cambia ni avisa', r1b.unchanged === true && (await avisos(LUZ.u, '%')).length === 1, r1b);

  // ── 2. Quitar el conductor ────────────────────────────────────────────────
  console.log('\n2. Dejarla sin conductor');
  await poner(raA, null);
  const fA2 = await fila(raA);
  check('queda en borrador y sin placa', fA2.d === null && fA2.status === 'draft' && fA2.v === null, fA2);
  check('sus reservas vuelven a «pedida»', (await reserva(rLuz)).h2a === 'requested' && (await reserva(rSara)).h2a === 'requested');
  check('a Daniel: «Ya no haces una vuelta»', (await avisos(DANI.u, 'Ya no haces%')).length === 1);
  check('a los tripulantes no les llega nada nuevo', (await avisos(LUZ.u, '%')).length === 1);

  // ── 3. Borrador → Juan ────────────────────────────────────────────────────
  console.log('\n3. Un borrador recibe conductor');
  await poner(raA, JUAN.dp);
  const fA3 = await fila(raA);
  check('queda publicada con Juan en PRW443', fA3.d === JUAN.dp && fA3.status === 'planned' && fA3.v === PRW, fA3);
  check('las reservas, otra vez «asignadas»', (await reserva(rLuz)).h2a === 'assigned');
  const aLuz3 = await avisos(LUZ.u, '%');
  check('a Luz (no tenía conductor): «Juan Andres te recoge 🚗 · Te recoge a las 4:30 en el carro PRW443.»', aLuz3.length === 2 && aLuz3[1].title === 'Juan Andres te recoge 🚗' && aLuz3[1].body === 'Te recoge a las 4:30 en el carro PRW443.', aLuz3);

  // ── 4. Delegada → Daniel ──────────────────────────────────────────────────
  console.log('\n4. Una delegada recibe conductor');
  const rMar = await res(MAR, at('12:00'));
  const raD = await vuelta({ t: at('10:20'), deleg: true, stops: [[rMar, at('10:30')]] });
  const r4 = await poner(raD, DANI.dp);
  const fD = await fila(raD);
  check('deja de ser delegada y queda con Daniel', fD.deleg === null && fD.d === DANI.dp && fD.status === 'planned' && r4.was_delegated === true, { fD, r4 });
  check('a Margy: «Daniel Álvarez te recoge 🚗»', (await avisos(MAR.u, 'Daniel Álvarez te recoge%')).length === 1);

  // ── 5. Ruta de Julián (pool) ──────────────────────────────────────────────
  console.log('\n5. Una vuelta de la ruta de Julián');
  const rP = await res(SARA, at('15:00'));
  const raP = await vuelta({ t: at('13:20'), pool: true, stops: [[rP, at('13:30')]] });
  check('nadie la tiene: sale en la lista de Juan', (await abiertas(JUAN)).some((v) => v.id === raP));
  await poner(raP, DANI.dp);
  check('el jefe se la da a Daniel: ya no sale en la lista de Juan', !(await abiertas(JUAN)).some((v) => v.id === raP) && (await fila(raP)).d === DANI.dp);
  await poner(raP, null);
  const fP = await fila(raP);
  check('sin conductor vuelve a la lista (planned, no borrador)', fP.status === 'planned' && fP.d === null && (await abiertas(JUAN)).some((v) => v.id === raP), fP);

  // ── 6. Reglas y permisos ──────────────────────────────────────────────────
  console.log('\n6. Reglas y permisos');
  await q(`UPDATE public.route_stops SET status = 'arrived' WHERE route_assignment_id = $1`, [raB]);
  await asUser(c, jefe, 'admin');
  const e1 = await debeFallar(`SELECT public.admin_route_set_driver($1, $2)`, [raB, DANI.dp]);
  await asDb();
  check('la que ya arrancó no se cambia por aquí', e1 && /ya arrancó/.test(e1.message), e1 && e1.message);
  const otraOrg = (await one(`INSERT INTO public.organizations (name, slug) VALUES ('Otra 0129', 'otra-0129-' || substr(md5(random()::text), 1, 6)) RETURNING id`)).id;
  const AJENO = await drv('Conductor ajeno 0129', otraOrg);
  await asUser(c, jefe, 'admin');
  const e2 = await debeFallar(`SELECT public.admin_route_set_driver($1, $2)`, [raA, AJENO.dp]);
  await asDb();
  check('un conductor de otra organización no se puede poner', e2 && /no existe/.test(e2.message), e2 && e2.message);
  const jefeAjeno = await user(c, otraOrg, 'admin', 'Jefe ajeno 0129');
  // Con un conductor DE SU organización, para que lo que frene sea la vuelta (la del
  // tablero trae organization_id NULL: sin el coalesce de la guarda, pasaba).
  await asUser(c, jefeAjeno, 'admin');
  const e3 = await debeFallar(`SELECT public.admin_route_set_driver($1, $2)`, [raA, AJENO.dp]);
  await asDb();
  check('el jefe de otra organización no ve la vuelta del tablero (organization_id NULL)', e3 && /Esa vuelta no existe/.test(e3.message) && (await fila(raA)).d !== AJENO.dp, e3 && e3.message);
  for (const [quien, rol] of [[JUAN.u, 'driver'], [LUZ.u, 'auxiliar']]) {
    await asUser(c, quien, rol);
    const e = await debeFallar(`SELECT public.admin_route_set_driver($1, $2)`, [raA, DANI.dp]);
    await asDb();
    check(`un ${rol === 'driver' ? 'conductor' : 'tripulante'} no puede`, e && /Solo un jefe/.test(e.message), e && e.message);
  }
  const anon = await one(`SELECT has_function_privilege('anon', 'public.admin_route_set_driver(uuid,uuid)', 'EXECUTE') a`);
  check('anónimo no puede', anon.a === false);

  // ── 7. Down ───────────────────────────────────────────────────────────────
  console.log('\n7. Reversa');
  await c.query(strip('../down_migrations/0129_conductor_de_una_vuelta.down.sql'));
  check('el down quita la función', !(await existe(`to_regprocedure('public.admin_route_set_driver(uuid,uuid)')`)));
} catch (e) {
  fail++; console.log('  ✗ ERROR', e.message, e.where || '');
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok} ✓ · ${fail} ✗`);
process.exit(fail ? 1 : 0);
