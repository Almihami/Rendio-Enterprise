// 0167 · El jefe pasa a una persona a OTRA vuelta ya publicada (admin_pasar_reserva).
//   cd rendio-backend && set -a && source <.env.dev|.env.main> && set +a && node scripts/_aplicar-0167.mjs [--produccion] [--aplicar]
// Sin --aplicar: EN SECO (ROLLBACK). La prueba de mover usa dos vueltas reales que existan y SIEMPRE se deshace (savepoint).
import pg from 'pg';
import { readFileSync } from 'node:fs';
const DEV = 'lxlphbafhtphulanhzlp', PROD = 'wvuurnfdrrdondrbbkhd';
const prod = process.argv.includes('--produccion'), aplicar = process.argv.includes('--aplicar');
const esperado = prod ? PROD : DEV;
if ((process.env.SUPABASE_PROJECT_REF || '') !== esperado || !(process.env.SUPABASE_URL || '').includes(esperado)) { console.error('ABORT: ambiente equivocado'); process.exit(2); }
const c = new pg.Client({ host: prod ? 'aws-1-us-west-2.pooler.supabase.com' : 'aws-1-us-east-1.pooler.supabase.com', port: 5432, database: 'postgres', user: 'postgres.' + esperado, password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false } });
await c.connect();
const q = async (s, v) => (await c.query(s, v)).rows, one = async (s, v) => (await q(s, v))[0];
const fallas = []; const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + JSON.stringify(d) : ''}`); if (!ok) fallas.push(n); };
const sql = readFileSync(new URL('../supabase/migrations/0167_pasar_a_otra_vuelta.sql', import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const falla = async (s, v) => { await c.query('SAVEPOINT f'); try { await c.query(s, v); await c.query('RELEASE SAVEPOINT f'); return null; } catch (e) { await c.query('ROLLBACK TO SAVEPOINT f'); return e.message; } };
console.log(`\n== 0167 ${aplicar ? 'APLICANDO' : 'EN SECO'} en ${prod ? 'PRODUCCIÓN' : 'dev'} ==`);
await c.query('BEGIN');
try {
  await c.query(`SET LOCAL lock_timeout = '5s'`);
  for (const f of ['trip_notify', 'route_sync_assigned', 'sync_calculated_pickup', 'lugar_del_regreso', 'short_name', 'hm_bog', 'trip_kick'])
    t('está ' + f, !!(await one(`SELECT 1 x FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = $1`, [f])));
  if (fallas.length) throw new Error('la base no está como se esperaba');
  await c.query(sql);
  const g = await one(`SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('anon', p.oid, 'EXECUTE') an FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'admin_pasar_reserva'`);
  t('la función existe: la llaman las sesiones, no los anónimos', g && g.a === true && g.an === false, g);
  await c.query('SAVEPOINT prueba');
  let e = await falla(`SELECT public.admin_pasar_reserva(gen_random_uuid(), gen_random_uuid())`);
  t('sin sesión de jefe no deja', /Solo un jefe/.test(e || ''), e);
  const jefe = await one(`SELECT p.id, p.organization_id org FROM public.profiles p WHERE p.role = 'admin' AND p.deleted_at IS NULL AND p.organization_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.route_assignments ra WHERE ra.organization_id = p.organization_id AND ra.planned_start_at > now()) ORDER BY p.created_at LIMIT 1`)
    || await one(`SELECT p.id, p.organization_id org FROM public.profiles p WHERE p.role = 'admin' AND p.deleted_at IS NULL AND p.organization_id IS NOT NULL ORDER BY p.created_at LIMIT 1`);
  await c.query(`SELECT set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true), set_config('request.jwt.claim.role', 'authenticated', true)`, [JSON.stringify({ sub: jefe.id, role: 'authenticated' }), jefe.id]);
  t('como jefe: la sesión se reconoce', (await one(`SELECT public.current_user_role() r`)).r === 'admin');
  e = await falla(`SELECT public.admin_pasar_reserva(gen_random_uuid(), gen_random_uuid())`);
  t('pedido que no existe → lo dice', /Ese pedido no existe/.test(e || ''), e);
  const fut = await q(`SELECT ra.id, ra.direction d, (SELECT s.reservation_id FROM public.route_stops s JOIN public.reservations r ON r.id = s.reservation_id WHERE s.route_assignment_id = ra.id AND r.cancelled_at IS NULL ORDER BY s.stop_order LIMIT 1) rid,
       (SELECT count(*) FROM public.route_stops s WHERE s.route_assignment_id = ra.id)::int n
     FROM public.route_assignments ra WHERE ra.status IN ('draft', 'planned') AND ra.planned_start_at > now() + interval '20 minutes'
       AND NOT EXISTS (SELECT 1 FROM public.route_stops s WHERE s.route_assignment_id = ra.id AND s.status <> 'pending')
       AND EXISTS (SELECT 1 FROM public.route_stops s JOIN public.reservations r ON r.id = s.reservation_id JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id JOIN public.profiles pp ON pp.id = ap.profile_id WHERE s.route_assignment_id = ra.id AND pp.organization_id = $1)
     ORDER BY ra.planned_start_at LIMIT 60`, [jefe.org]);
  let probo = false;
  for (const dir of ['airport_to_home', 'home_to_airport']) {
    const xs = fut.filter((x) => x.d === dir && x.rid); if (xs.length < 2) continue;
    const a = xs[0], b = xs[1]; probo = true;
    const r = (await one(`SELECT public.admin_pasar_reserva($1, $2) x`, [a.rid, b.id])).x;
    const en = await q(`SELECT s.route_assignment_id ra, s.stop_order o FROM public.route_stops s WHERE s.reservation_id = $1 AND s.status = 'pending'`, [a.rid]);
    t(`${dir}: queda SOLO en la vuelta elegida`, en.length === 1 && en[0].ra === b.id && r.id === b.id && r.pax === b.n + 1, { r, en });
    const ord = (await q(`SELECT stop_order o FROM public.route_stops WHERE route_assignment_id = $1 ORDER BY stop_order`, [b.id])).map((x) => x.o);
    t(`${dir}: el orden queda corrido (1…n)`, ord.every((o, i) => o === i + 1), ord);
    t(`${dir}: su vuelta vieja se quitó si quedó vacía (${a.n === 1 ? 'iba sola' : 'iban ' + a.n})`, r.removed_route === (a.n === 1) && !!(await one(`SELECT 1 x FROM public.route_assignments WHERE id = $1`, [a.id])) === (a.n !== 1), r);
    t(`${dir}: repetir no hace nada`, (await one(`SELECT public.admin_pasar_reserva($1, $2) x`, [a.rid, b.id])).x.unchanged === true);
    const otro = fut.find((x) => x.d !== dir);
    if (otro) { e = await falla(`SELECT public.admin_pasar_reserva($1, $2)`, [a.rid, otro.id]); t(`${dir}: no deja cruzar a una vuelta del otro sentido`, /esa vuelta es de/.test(e || '') || /no existe/.test(e || ''), e); }
  }
  if (!probo) console.log('  · no hay dos vueltas futuras del mismo sentido para probar el paso (se probó en producción con ROLLBACK el 17-nov)');
  await c.query('ROLLBACK TO SAVEPOINT prueba');
  if (fallas.length) throw new Error('fallaron ' + fallas.length);
  if (aplicar) { await c.query('COMMIT'); console.log('\n✓ 0167 APLICADA en ' + (prod ? 'PRODUCCIÓN' : 'dev')); } else { await c.query('ROLLBACK'); console.log('\nEN SECO: no se guardó nada'); }
} catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('\n✗ NO se aplicó:', e.message); process.exitCode = 1; }
await c.end();
