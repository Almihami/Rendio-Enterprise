// 0169 · El conductor ve el día de todo el equipo y todos los vuelos (driver_day_board). SOLO agrega una función de lectura.
//   cd rendio-backend && set -a && source <.env.dev|.env.main> && set +a && node scripts/_aplicar-0169.mjs [--produccion] [--aplicar]
import pg from 'pg';
import { readFileSync } from 'node:fs';
const DEV = 'lxlphbafhtphulanhzlp', PROD = 'wvuurnfdrrdondrbbkhd';
const prod = process.argv.includes('--produccion'), aplicar = process.argv.includes('--aplicar');
const esperado = prod ? PROD : DEV;
if ((process.env.SUPABASE_PROJECT_REF || '') !== esperado || !(process.env.SUPABASE_URL || '').includes(esperado)) { console.error('ABORT: ambiente equivocado'); process.exit(2); }
const c = new pg.Client({ host: prod ? 'aws-1-us-west-2.pooler.supabase.com' : 'aws-1-us-east-1.pooler.supabase.com', port: 5432, database: 'postgres', user: 'postgres.' + esperado, password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false } });
await c.connect();
const q = async (s, v) => (await c.query(s, v)).rows, one = async (s, v) => (await q(s, v))[0];
const fallas = []; const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + JSON.stringify(d).slice(0, 300) : ''}`); if (!ok) fallas.push(n); };
const sql = readFileSync(new URL('../supabase/migrations/0169_conductor_dia_del_equipo.sql', import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const como = async (uid) => c.query(`SELECT set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true), set_config('request.jwt.claim.role', 'authenticated', true)`, [JSON.stringify({ sub: uid, role: 'authenticated' }), uid]);
console.log(`\n== 0169 ${aplicar ? 'APLICANDO' : 'EN SECO'} en ${prod ? 'PRODUCCIÓN' : 'dev'} ==`);
await c.query('BEGIN');
try {
  await c.query(`SET LOCAL lock_timeout = '5s'`);
  for (const f of ['my_driver_profile_id', 'current_user_org', 'dia_del_plan', 'short_name'])
    t('está ' + f, !!(await one(`SELECT 1 x FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = $1`, [f])));
  if (fallas.length) throw new Error('la base no está como se esperaba');
  await c.query(sql);
  const g = await one(`SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('anon', p.oid, 'EXECUTE') an, p.provolatile v FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'driver_day_board'`);
  t('existe, es de solo lectura (STABLE) y no la llaman anónimos', g && g.a === true && g.an === false && g.v === 's', g);
  const sin = (await one(`SELECT public.driver_day_board() x`)).x;
  t('sin sesión: vacío', sin && sin.day === null && Array.isArray(sin.vueltas) && sin.vueltas.length === 0, sin);
  const jefe = await one(`SELECT p.id FROM public.profiles p WHERE p.role = 'admin' AND p.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM public.driver_profiles d WHERE d.profile_id = p.id) ORDER BY p.created_at LIMIT 1`);
  if (jefe) { await como(jefe.id); const r = (await one(`SELECT public.driver_day_board() x`)).x; t('un jefe que no es conductor: vacío', r.vueltas.length === 0, r); }
  const drv = await one(`SELECT p.id FROM public.profiles p JOIN public.driver_profiles d ON d.profile_id = p.id WHERE p.deleted_at IS NULL AND p.organization_id IS NOT NULL
     ORDER BY (SELECT count(*) FROM public.route_assignments ra WHERE ra.driver_profile_id = d.id AND ra.planned_start_at > now() - interval '1 day') DESC LIMIT 1`);
  await como(drv.id);
  const r = (await one(`SELECT public.driver_day_board() x`)).x;
  t('un conductor: recibe el día y una lista', !!r.day && Array.isArray(r.vueltas), r.day);
  const paradas = r.vueltas.flatMap((v) => v.stops);
  t(`${r.vueltas.length} vueltas, ${paradas.length} paradas: cada vuelta trae quién la lleva y su gente`, r.vueltas.every((v) => v.id && v.direction && v.start_at && typeof v.mine === 'boolean' && Array.isArray(v.stops) && v.stops.length > 0));
  t('las paradas NO traen teléfono, dirección ni notas', paradas.every((s) => Object.keys(s).sort().join(',') === 'at,flight,name,req_at,reserve,status'), paradas[0] && Object.keys(paradas[0]));
  if (fallas.length) throw new Error('fallaron ' + fallas.length);
  if (aplicar) { await c.query('COMMIT'); console.log('\n✓ 0169 APLICADA en ' + (prod ? 'PRODUCCIÓN' : 'dev')); } else { await c.query('ROLLBACK'); console.log('\nEN SECO: no se guardó nada'); }
} catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('\n✗ NO se aplicó:', e.message); process.exitCode = 1; }
await c.end();
