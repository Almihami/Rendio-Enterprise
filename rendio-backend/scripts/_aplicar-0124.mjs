// 0124 · El carro de la vuelta sale del turno del conductor.
//
//   LOCAL:  node scripts/_aplicar-0124.mjs --local [--aplicar]
//   DEV:    cd rendio-backend && set -a && source .env.dev && set +a && node scripts/_aplicar-0124.mjs [--aplicar]
//   PRODUCCIÓN (con su OK, después del respaldo):
//           cd rendio-backend && set -a && source .env.main && set +a && node scripts/_aplicar-0124.mjs --produccion [--aplicar]
//
// Todo en UNA transacción; solo con --aplicar (y todo bien) se confirma. Dice qué
// vueltas cambian de carro al aplicar (las de los turnos ya abiertos) y comprueba
// que nada más se mueva: paradas, reservas y turnos idénticos; de las vueltas solo
// cambia vehicle_id de esas. Después, en un SAVEPOINT que siempre se deshace,
// prueba los dos disparadores con un turno de verdad.
import pg from 'pg';
import { readFileSync } from 'node:fs';

const DEV = 'lxlphbafhtphulanhzlp', PROD = 'wvuurnfdrrdondrbbkhd';
const local = process.argv.includes('--local');
const prod = process.argv.includes('--produccion');
const aplicar = process.argv.includes('--aplicar');
let c, amb;
if (local) {
  c = new pg.Client({ connectionString: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' });
  amb = 'LOCAL';
} else {
  const ref = process.env.SUPABASE_PROJECT_REF || '';
  const esperado = prod ? PROD : DEV;
  if (ref !== esperado || !(process.env.SUPABASE_URL || '').includes(esperado)) {
    console.error(`ABORT: se esperaba ${prod ? 'PRODUCCIÓN' : 'dev'} (${esperado}) y se cargó ${ref || '(nada)'}.`);
    process.exit(2);
  }
  c = new pg.Client({ host: prod ? 'aws-1-us-west-2.pooler.supabase.com' : 'aws-1-us-east-1.pooler.supabase.com',
    port: 5432, user: 'postgres.' + ref, password: process.env.SUPABASE_DB_PASSWORD, database: 'postgres',
    ssl: { rejectUnauthorized: false }, statement_timeout: 120000 });
  amb = prod ? 'PRODUCCIÓN' : 'dev';
}
await c.connect();
const q = async (s, v) => (await c.query(s, v)).rows;
const one = async (s, v) => (await q(s, v))[0];
console.log(aplicar ? `\n== APLICANDO 0124 en ${amb} ==` : `\n== 0124 EN SECO contra ${amb} (se deshace) ==`);
const fallas = [];
const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); if (!ok) fallas.push(n); };
const huella = async () => one(`SELECT
    (SELECT md5(coalesce(string_agg(to_jsonb(s)::text, ',' ORDER BY id), '')) FROM public.route_stops s) paradas,
    (SELECT md5(coalesce(string_agg(to_jsonb(r)::text, ',' ORDER BY id), '')) FROM public.reservations r) reservas,
    (SELECT md5(coalesce(string_agg(to_jsonb(x)::text, ',' ORDER BY id), '')) FROM public.shifts x) turnos,
    (SELECT md5(coalesce(string_agg((to_jsonb(a) - 'vehicle_id' - 'plan_car' - 'updated_at')::text, ',' ORDER BY id), '')) FROM public.route_assignments a) vueltas,
    (SELECT count(*)::int FROM public.route_assignments) n_vueltas`);

try {
  const antes = await huella();
  const vAntes = Object.fromEntries((await q(`SELECT id, vehicle_id FROM public.route_assignments`)).map((r) => [r.id, r.vehicle_id]));
  await c.query('BEGIN');
  await c.query(readFileSync(new URL('../supabase/migrations/0124_carro_del_turno.sql', import.meta.url), 'utf8')
    .replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, ''));

  const o = await one(`SELECT
      (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='route_assignments' AND column_name='plan_car')::int col,
      EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'tr_route_assignments_vehicle_from_shift') t1,
      EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'tr_shifts_vehicle_to_routes') t2,
      has_function_privilege('authenticated', 'public.route_vehicle_from_shift(uuid,timestamptz)', 'EXECUTE') f_auth`);
  t('la columna plan_car y los dos disparadores quedaron; la función interna no se llama desde la app', o.col === 1 && o.t1 && o.t2 && !o.f_auth, o);

  const cambios = await q(`SELECT ra.id, ra.planned_start_at, ra.status, v.internal_code AS nuevo, pr.full_name AS conductor
                             FROM public.route_assignments ra
                             LEFT JOIN public.vehicles v ON v.id = ra.vehicle_id
                             LEFT JOIN public.driver_profiles dp ON dp.id = ra.driver_profile_id
                             LEFT JOIN public.profiles pr ON pr.id = dp.profile_id`);
  const realmente = (await q(`SELECT id, vehicle_id FROM public.route_assignments`)).filter((r) => (vAntes[r.id] || null) !== (r.vehicle_id || null));
  console.log(`  · vueltas que pasan al carro del turno abierto de su conductor: ${realmente.length}`);
  for (const r of realmente.slice(0, 12)) {
    const x = cambios.find((y) => y.id === r.id);
    console.log(`    - ${x.conductor || 'sin conductor'} · ${new Date(x.planned_start_at).toLocaleString('es-CO', { timeZone: 'America/Bogota' })} · ${x.status} → ${x.nuevo}`);
  }
  const durante = await huella();
  t(`paradas, reservas, turnos y el resto de las ${antes.n_vueltas} vueltas: idénticos`, JSON.stringify(antes) === JSON.stringify(durante), { antes, durante });
  const terminadas = (await q(`SELECT id, vehicle_id, status FROM public.route_assignments WHERE status IN ('completed', 'cancelled')`))
    .filter((r) => (vAntes[r.id] || null) !== (r.vehicle_id || null));
  t('ninguna vuelta terminada o cancelada cambió de carro', terminadas.length === 0, terminadas.length);

  // ── Los disparadores con datos de verdad (se deshace) ──
  await c.query('SAVEPOINT prueba');
  const base = await one(`SELECT dp.id dp, p.organization_id org FROM public.driver_profiles dp JOIN public.profiles p ON p.id = dp.profile_id
                           WHERE p.deleted_at IS NULL ORDER BY p.created_at LIMIT 1`);
  const vs = await q(`SELECT v.id FROM public.vehicles v WHERE v.deleted_at IS NULL
                        AND NOT EXISTS (SELECT 1 FROM public.shifts s WHERE s.vehicle_id = v.id AND s.status IN ('active', 'closing'))
                      ORDER BY v.internal_code LIMIT 2`);
  if (base && vs.length >= 1) {
    await q(`UPDATE public.shifts SET status = 'closed', end_at = greatest(start_at, now()) WHERE driver_id = $1 AND status IN ('active', 'closing')`, [base.dp]);
    const ra = (await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at, plan_car)
                            VALUES ($1, NULL, 'airport_to_home', 'planned', now() + interval '2 hours', 'Carro 1') RETURNING id, vehicle_id`, [base.dp]));
    t('publicar sin placa y sin turno abierto: queda sin carro', ra.vehicle_id === null, ra);
    const sh = (await one(`INSERT INTO public.shifts (organization_id, driver_id, vehicle_id, status, start_at) VALUES ($1, $2, $3, 'vehicle_selected', now()) RETURNING id`, [base.org, base.dp, vs[0].id])).id;
    t('eligió carro pero no inspeccionó: todavía sin carro', (await one(`SELECT vehicle_id v FROM public.route_assignments WHERE id = $1`, [ra.id])).v === null);
    await q(`UPDATE public.shifts SET status = 'active' WHERE id = $1`, [sh]);
    t('turno activo: la vuelta queda en el carro del turno', (await one(`SELECT vehicle_id v FROM public.route_assignments WHERE id = $1`, [ra.id])).v === vs[0].id);
    const ra2 = (await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at, plan_car)
                             VALUES ($1, NULL, 'home_to_airport', 'planned', now() + interval '4 hours', 'Carro 1') RETURNING vehicle_id`, [base.dp]));
    t('publicar con el turno abierto: nace en ese carro', ra2.vehicle_id === vs[0].id);
  } else t('hay un conductor y un carro libre para la prueba', false, { base: !!base, carros: vs.length });
  await c.query('ROLLBACK TO SAVEPOINT prueba');
  const despues = await huella();
  t('después de deshacer la prueba, todo como recién aplicada', JSON.stringify(durante) === JSON.stringify(despues));

  const fin = aplicar && !fallas.length ? 'COMMIT' : 'ROLLBACK';
  await c.query(fin);
  console.log(fallas.length
    ? `\n✗ ${fallas.length} comprobación(es) fallaron: ${fin}.`
    : `\n✓ Todo bien. ${fin === 'COMMIT' ? 'APLICADA en ' + amb + '.' : 'En seco: se deshizo (usa --aplicar).'}`);
} catch (e) {
  try { await c.query('ROLLBACK'); } catch (_) { /* */ }
  console.error('\n✗ Error, se deshizo todo:', e.message);
  fallas.push('error');
} finally {
  await c.end();
}
process.exit(fallas.length ? 1 : 0);
