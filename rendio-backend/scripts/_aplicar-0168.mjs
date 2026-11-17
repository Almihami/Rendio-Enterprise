// 0168 · Cancelar desde coordinación no deja la vuelta vacía (admin_cancel_reservation).
//   cd rendio-backend && set -a && source <.env.dev|.env.main> && set +a && node scripts/_aplicar-0168.mjs [--produccion] [--aplicar]
// Sin --aplicar: EN SECO (ROLLBACK). La prueba de cancelar usa pedidos reales y SIEMPRE se deshace (savepoint).
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
const sql = readFileSync(new URL('../supabase/migrations/0168_cancelar_no_deja_vuelta_vacia.sql', import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const def = async () => (await one(`SELECT pg_get_functiondef(p.oid) d FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'admin_cancel_reservation'`))?.d || '';
console.log(`\n== 0168 ${aplicar ? 'APLICANDO' : 'EN SECO'} en ${prod ? 'PRODUCCIÓN' : 'dev'} ==`);
await c.query('BEGIN');
try {
  await c.query(`SET LOCAL lock_timeout = '5s'`);
  const d0 = await def();
  t('admin_cancel_reservation es la de 0050 (sin limpiar vueltas)', /solo un admin puede cancelar traslados de otros/.test(d0) && !/v_vueltas/.test(d0) && /'auxiliar_profile_id', v_aux\)/.test(d0), d0.length);
  const g0 = await one(`SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('anon', p.oid, 'EXECUTE') an FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'admin_cancel_reservation'`);
  if (fallas.length) throw new Error('la base no está como se esperaba');
  await c.query(sql);
  const g = await one(`SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('anon', p.oid, 'EXECUTE') an FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'admin_cancel_reservation'`);
  t('los permisos quedan como estaban', g.a === g0.a && g.an === g0.an, { g0, g });
  await c.query('SAVEPOINT prueba');
  const fut = await q(`SELECT ra.id, (SELECT count(*) FROM public.route_stops s WHERE s.route_assignment_id = ra.id)::int n,
       (SELECT s.reservation_id FROM public.route_stops s JOIN public.reservations r ON r.id = s.reservation_id WHERE s.route_assignment_id = ra.id AND r.cancelled_at IS NULL ORDER BY s.stop_order LIMIT 1) rid
     FROM public.route_assignments ra WHERE ra.status IN ('draft', 'planned') AND ra.actual_start_at IS NULL AND ra.planned_start_at > now() + interval '20 minutes'
       AND NOT EXISTS (SELECT 1 FROM public.route_stops s WHERE s.route_assignment_id = ra.id AND s.status <> 'pending') ORDER BY ra.planned_start_at LIMIT 80`);
  const sola = fut.find((x) => x.n === 1 && x.rid), varias = fut.find((x) => x.n > 1 && x.rid);
  const jefeDe = async (rid) => one(`SELECT j.id FROM public.reservations r JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id JOIN public.profiles p ON p.id = ap.profile_id
     JOIN public.profiles j ON j.organization_id = p.organization_id AND j.role = 'admin' AND j.deleted_at IS NULL WHERE r.id = $1 ORDER BY j.created_at LIMIT 1`, [rid]);
  const como = async (uid) => c.query(`SELECT set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true), set_config('request.jwt.claim.role', 'authenticated', true)`, [JSON.stringify({ sub: uid, role: 'authenticated' }), uid]);
  if (sola) { await como((await jefeDe(sola.rid)).id);
    const r = (await one(`SELECT public.admin_cancel_reservation($1, 'prueba 0168') x`, [sola.rid])).x;
    t('iba sola: la vuelta se quita', r.ok === true && r.removed_routes === 1 && !(await one(`SELECT 1 x FROM public.route_assignments WHERE id = $1`, [sola.id])), r);
    t('…y el pedido queda cancelado', !!(await one(`SELECT 1 x FROM public.reservations WHERE id = $1 AND cancelled_at IS NOT NULL`, [sola.rid])));
  } else console.log('  · no hay una vuelta futura de una sola persona para probar');
  if (varias) { await como((await jefeDe(varias.rid)).id);
    const r = (await one(`SELECT public.admin_cancel_reservation($1, 'prueba 0168') x`, [varias.rid])).x;
    const n = (await one(`SELECT count(*)::int n FROM public.route_stops WHERE route_assignment_id = $1`, [varias.id])).n;
    t('iban varias: la vuelta sigue, con una persona menos', r.removed_routes === 0 && n === varias.n - 1, { r, n });
  } else console.log('  · no hay una vuelta futura de varias personas para probar');
  await c.query('ROLLBACK TO SAVEPOINT prueba');
  if (fallas.length) throw new Error('fallaron ' + fallas.length);
  if (aplicar) { await c.query('COMMIT'); console.log('\n✓ 0168 APLICADA en ' + (prod ? 'PRODUCCIÓN' : 'dev')); } else { await c.query('ROLLBACK'); console.log('\nEN SECO: no se guardó nada'); }
} catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('\n✗ NO se aplicó:', e.message); process.exitCode = 1; }
await c.end();
