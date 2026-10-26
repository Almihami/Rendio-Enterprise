// Verificación de 0132 (el carro del plan y el aviso si el conductor sale en otro)
// contra la base LOCAL (127.0.0.1:54322). Aplica lo que falte (0117, 0124, 0125) y
// 0132 dentro de una transacción que se deshace: no queda nada.
//
//   cd rendio-backend/scripts && node _verify-0132.mjs
//
// Qué prueba:
//   1. Juan tiene dos vueltas hoy con el carro del plan PRW443.
//   2. Inicia turno en PRW443: nadie recibe aviso; la placa real de sus vueltas es
//      PRW443 (0124 sigue igual) y plan_vehicle_id no cambia.
//   3. Daniel tiene el plan en HYU376 e inicia en ZZZ999: a los jefes (los marcados)
//      «🚗 Daniel Álvarez salió en ZZZ999 · El plan decía HYU376 … sus tripulantes
//      ven ZZZ999.»; sus vueltas quedan con ZZZ999 (manda la inspección). No se
//      repite si el turno se vuelve a guardar; si cambia OTRA vez de carro, sí.
//   4. Sin carro del plan, no avisa. Un turno que no queda activo, tampoco.
//   5. Si armar el aviso falla, el turno se guarda igual. El down lo quita todo.
//
// NO cubre: la pantalla (_smoke-rutas-v2-dom.mjs · shift-flow), la push de verdad, dev/producción.
import fs from 'node:fs';
import { localClient, fixtures, user } from './_local-fixtures.mjs';

let ok = 0, fail = 0;
const check = (n, cond, det) => {
  if (cond) { ok++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + (typeof det === 'string' ? det : JSON.stringify(det)) : ''}`); }
};
const c = await localClient();
const q = async (s, p) => (await c.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
const strip = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const existe = async (sql) => (await one(`SELECT (${sql}) IS NOT NULL AS ok`)).ok;

await c.query('BEGIN');
try {
  if (!(await existe(`to_regprocedure('public.ops_alert_recipients_of(uuid)')`))) await c.query(strip('../supabase/migrations/0117_avisos_desde_el_servidor.sql'));
  if (!(await existe(`(SELECT 1 FROM information_schema.columns WHERE table_name = 'route_assignments' AND column_name = 'plan_car')`))) await c.query(strip('../supabase/migrations/0124_carro_del_turno.sql'));
  if (!(await existe(`to_regprocedure('public.short_name(text)')`))) await c.query(strip('../supabase/migrations/0125_ruta_de_julian.sql'));
  await c.query(strip('../supabase/migrations/0132_carro_del_plan.sql'));
  await c.query(strip('../supabase/migrations/0132_carro_del_plan.sql'));
  check('0132 se aplica (y se puede volver a correr)', true);

  const fx = await fixtures(c);
  const jefe = await user(c, fx.org, 'admin', 'Camilo prueba 0132');
  const jefe2 = await user(c, fx.org, 'admin', 'Christian prueba 0132');
  await q(`UPDATE public.profiles SET receives_ops_alerts = (id = $1) WHERE id = ANY($2)`, [jefe, [jefe, jefe2]]);
  const car = async (code) => (await one(`INSERT INTO public.vehicles (organization_id, internal_code, license_plate) VALUES ($1, $2, $2) RETURNING id`, [fx.org, code])).id;
  const PRW = await car('PRW443'), HYU = await car('HYU376'), ZZZ = await car('ZZZ999');
  const drv = async (name) => { const u = await user(c, fx.org, 'driver', name); return { u, dp: (await one(`INSERT INTO public.driver_profiles (profile_id) VALUES ($1) RETURNING id`, [u])).id }; };
  const JUAN = await drv('Juan Andres prueba 0132'), DANI = await drv('Daniel Álvarez prueba 0132'), OTRO = await drv('Otro Sinplan prueba 0132');
  const hoy = (await one(`SELECT (now() AT TIME ZONE 'America/Bogota')::date::text d`)).d;
  const at = (hm) => `${hoy}T${hm}:00-05:00`;
  const vuelta = async (d, t, plan) => (await one(`INSERT INTO public.route_assignments (driver_profile_id, direction, status, planned_start_at, plan_car, plan_vehicle_id)
      VALUES ($1, 'home_to_airport', 'planned', $2::timestamptz, 'Carro 1', $3) RETURNING id`, [d, t, plan])).id;
  const j1 = await vuelta(JUAN.dp, at('05:00'), PRW), j2 = await vuelta(JUAN.dp, at('09:00'), PRW);
  const d1 = await vuelta(DANI.dp, at('05:10'), HYU);
  const o1 = await vuelta(OTRO.dp, at('05:20'), null);
  const turno = async (d, v, st = 'active') => (await one(`INSERT INTO public.shifts (organization_id, driver_id, vehicle_id, status, start_at) VALUES ($1, $2, $3, $4, $5::timestamptz) RETURNING id`, [fx.org, d, v, st, at('04:00')])).id;
  const avisos = async (prof) => q(`SELECT title, body, url FROM public.notification_outbox WHERE profile_id = $1 AND dedupe_key LIKE 'plancar:%' ORDER BY created_at`, [prof]);
  const fila = async (ra) => one(`SELECT vehicle_id v, plan_vehicle_id p FROM public.route_assignments WHERE id = $1`, [ra]);

  console.log('\n1–2. Sale en el carro del plan');
  await turno(JUAN.dp, PRW);
  check('Juan inicia en PRW443 (el del plan): no hay aviso', (await avisos(jefe)).length === 0);
  const fj = await fila(j1);
  check('sus vueltas: placa real PRW443 (0124) y el plan sigue en PRW443', fj.v === PRW && fj.p === PRW && (await fila(j2)).v === PRW, fj);

  console.log('\n3. Sale en otro carro');
  const sD = await turno(DANI.dp, ZZZ);
  const a = await avisos(jefe);
  check('Daniel inicia en ZZZ999 y el plan decía HYU376: UN aviso al jefe marcado', a.length === 1 && (await avisos(jefe2)).length === 0, a);
  check('«🚗 Daniel Álvarez salió en ZZZ999»', a[0] && a[0].title === '🚗 Daniel Álvarez salió en ZZZ999', a[0] && a[0].title);
  check('«El plan decía HYU376 para sus vueltas de hoy. Manda la inspección: sus tripulantes ven ZZZ999.» → Asignación', a[0] && a[0].body === 'El plan decía HYU376 para sus vueltas de hoy. Manda la inspección: sus tripulantes ven ZZZ999.' && a[0].url === '/#/rutas', a[0] && a[0].body);
  check('manda la inspección: su vuelta sale con ZZZ999 (y el plan sigue diciendo HYU376)', (await fila(d1)).v === ZZZ && (await fila(d1)).p === HYU, await fila(d1));
  await q(`UPDATE public.shifts SET status = 'active' WHERE id = $1`, [sD]);
  await q(`UPDATE public.shifts SET start_at = start_at WHERE id = $1`, [sD]);
  check('guardar el turno otra vez no repite el aviso', (await avisos(jefe)).length === 1);
  await q(`UPDATE public.shifts SET vehicle_id = $2 WHERE id = $1`, [sD, PRW]);
  check('si cambia OTRA vez de carro (a PRW443), avisa de nuevo', (await avisos(jefe)).length === 2 && /salió en PRW443/.test((await avisos(jefe))[1].title));
  await q(`UPDATE public.shifts SET vehicle_id = $2 WHERE id = $1`, [sD, HYU]);
  check('…y si vuelve al del plan (HYU376), no', (await avisos(jefe)).length === 2);

  console.log('\n4. Sin plan, o sin turno activo');
  await turno(OTRO.dp, ZZZ);
  check('sin carro del plan: no avisa', (await avisos(jefe)).length === 2);
  const JOSE = await drv('Jose Cerrado prueba 0132');
  await vuelta(JOSE.dp, at('06:00'), HYU);
  await turno(JOSE.dp, ZZZ, 'closed');
  check('un turno que no queda activo no avisa', (await avisos(jefe)).length === 2);

  console.log('\n5. Nunca frena el turno · reversa');
  const PEPE = await drv('Pepe Falla prueba 0132');
  await vuelta(PEPE.dp, at('06:30'), HYU);
  await q(`ALTER TABLE public.notification_outbox RENAME TO notification_outbox_0132`);
  let err = null; let sP = null;
  try { sP = await turno(PEPE.dp, ZZZ); } catch (e) { err = e; }
  await q(`ALTER TABLE public.notification_outbox_0132 RENAME TO notification_outbox`);
  check('sin bandeja de avisos, el turno se guarda igual', !err && !!sP, err && err.message);
  const pub = await one(`SELECT has_function_privilege('authenticated', 'public.shifts_plan_vehicle_alert()', 'EXECUTE') a`);
  check('la app no puede llamar la función del disparador', pub.a === false);
  await c.query(strip('../down_migrations/0132_carro_del_plan.down.sql'));
  const d = await one(`SELECT (SELECT count(*)::int FROM pg_trigger WHERE tgname = 'tr_shifts_plan_vehicle_alert') t,
      (SELECT count(*)::int FROM information_schema.columns WHERE table_name = 'route_assignments' AND column_name = 'plan_vehicle_id') col`);
  check('el down quita el disparador y la columna', d.t === 0 && d.col === 0, d);
} catch (e) {
  fail++; console.log('  ✗ ERROR', e.message, e.where || '');
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok} ✓ · ${fail} ✗`);
process.exit(fail ? 1 : 0);
