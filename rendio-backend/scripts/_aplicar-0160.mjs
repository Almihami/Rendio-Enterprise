// 0160 · La llegada en espera toma la hora real cuando el vuelo se adelanta.
//   cd rendio-backend && set -a && source <.env.dev|.env.main> && set +a && node scripts/_aplicar-0160.mjs [--produccion] [--aplicar]
import pg from 'pg';
import { readFileSync } from 'node:fs';
const DEV = 'lxlphbafhtphulanhzlp', PROD = 'wvuurnfdrrdondrbbkhd';
const prod = process.argv.includes('--produccion'), aplicar = process.argv.includes('--aplicar');
const esperado = prod ? PROD : DEV;
if ((process.env.SUPABASE_PROJECT_REF || '') !== esperado || !(process.env.SUPABASE_URL || '').includes(esperado)) { console.error('ABORT: ambiente equivocado'); process.exit(2); }
const c = new pg.Client({ host: prod ? 'aws-1-us-west-2.pooler.supabase.com' : 'aws-1-us-east-1.pooler.supabase.com', port: 5432, database: 'postgres', user: 'postgres.' + esperado, password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false }, statement_timeout: 60000 });
await c.connect();
const q = async (s, v) => (await c.query(s, v)).rows, one = async (s, v) => (await q(s, v))[0];
const fallas = []; const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + JSON.stringify(d) : ''}`); if (!ok) fallas.push(n); };
const sql = readFileSync(new URL('../supabase/migrations/0160_despacho_hora_en_espera.sql', import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
console.log(`\n== 0160 ${aplicar ? 'APLICANDO' : 'EN SECO'} en ${prod ? 'PRODUCCIÓN' : 'dev'} ==`);
await c.query('BEGIN');
try {
  await c.query(`SET LOCAL lock_timeout = '5s'`);
  t('está la 0158 (despachar_llegadas)', !!(await one(`SELECT 1 x FROM pg_proc WHERE proname = 'despachar_llegadas'`)));
  if (fallas.length) throw new Error('falta la 0158');
  await c.query(sql);
  const g = await one(`SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('service_role', p.oid, 'EXECUTE') s FROM pg_proc p WHERE p.proname = 'despacho_poner_horas'`);
  t('despacho_poner_horas: solo el servidor', g && g.a === false && g.s === true, g);
  if (!prod) {
    await c.query('SAVEPOINT prueba');
    const J = await one(`SELECT id, organization_id org FROM public.profiles WHERE email = 'demo-admin@rendio.demo'`);
    const X = await one(`SELECT ap.id FROM public.profiles p JOIN public.auxiliar_profiles ap ON ap.profile_id = p.id WHERE p.email = 'prueba.mateo@rendio.demo'`);
    await c.query(`SELECT set_config('rendio.no_acomodar', 'on', true)`);
    const base = (await one(`SELECT date_trunc('hour', now()) + interval '1 hour' b`)).b;
    await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: J.id, role: 'authenticated' })]); await c.query('SET LOCAL ROLE authenticated');
    const rid = (await one(`SELECT public.admin_create_reservation($1, 'lle', $2::timestamptz, 'AV9908', NULL, false) id`, [X.id, base])).id;
    await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', '', true)`); await c.query(`SELECT set_config('rendio.no_acomodar', 'on', true)`);
    await c.query(`DELETE FROM public.route_stops WHERE reservation_id = $1`, [rid]);
    const dep = (await one(`SELECT coalesce(public.flight_deplane_min('AV9908'), 20) m`)).m;
    const ini0 = new Date(Date.parse(base) + dep * 60000).toISOString();
    const ra = (await one(`INSERT INTO public.route_assignments (direction, status, planned_start_at, organization_id, pool, para_tomar) VALUES ('airport_to_home', 'planned', $1, $2, true, true) RETURNING id`, [ini0, J.org])).id;
    await c.query(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at) VALUES ($1, $2, 1, $3::timestamptz + interval '20 minutes')`, [ra, rid, ini0]);
    const vuelo = async (min, estado) => c.query(`INSERT INTO public.flight_statuses (organization_id, flight_code, flight_date, direction, sched_at, estimated_at, status, delay_min, source, fetched_at)
       VALUES ($1, 'AV9908', ($2::timestamptz AT TIME ZONE 'America/Bogota')::date, 'airport_to_home', $2, $2::timestamptz + make_interval(mins => $3), $4, $3, 'flightradar24', now())
       ON CONFLICT (organization_id, flight_code, flight_date, direction) DO UPDATE SET estimated_at = EXCLUDED.estimated_at, delay_min = EXCLUDED.delay_min, status = EXCLUDED.status, fetched_at = now()`, [J.org, base, min, estado]);
    const ver = async () => one(`SELECT ra.planned_start_at ini, (SELECT estimated_arrival_at FROM public.route_stops WHERE route_assignment_id = ra.id) eta, (SELECT calculated_pickup_at FROM public.reservations WHERE id = $2) pedido FROM public.route_assignments ra WHERE ra.id = $1`, [ra, rid]);
    const iso = (d) => new Date(d).toISOString();
    await c.query(`UPDATE public.app_settings SET despacho_activo = false WHERE id = 'singleton'`);
    await vuelo(-14, 'in_air');
    t('despacho apagado: no mueve nada', (await one(`SELECT public.despacho_poner_horas() n`)).n === 0 && iso((await ver()).ini) === ini0);
    await c.query(`UPDATE public.app_settings SET despacho_activo = true WHERE id = 'singleton'`);
    const n1 = (await one(`SELECT public.despacho_poner_horas() n`)).n; const v1 = await ver();
    const esperada = new Date(Math.ceil((Date.parse(base) + (dep - 14) * 60000) / 300000) * 300000).toISOString();
    t('vuelo 14 min adelantado: la vuelta en espera toma la hora real (a múltiplo de 5)', n1 === 1 && iso(v1.ini) === esperada, { n1, v1, esperada });
    t('la parada y el pedido se corren igual', iso(v1.eta) === new Date(Date.parse(esperada) + 20 * 60000).toISOString() && v1.pedido && iso(v1.pedido) === esperada, v1);
    t('otra pasada no la vuelve a mover', (await one(`SELECT public.despacho_poner_horas() n`)).n === 0);
    await vuelo(25, 'delayed');
    t('vuelo ATRASADO: aquí no se toca (eso es de acomodar_eventualidades)', (await one(`SELECT public.despacho_poner_horas() n`)).n === 0 && iso((await ver()).ini) === esperada);
    await vuelo(-2, 'in_air');
    await c.query(`UPDATE public.route_assignments SET planned_start_at = $2 WHERE id = $1`, [ra, ini0]);
    t('adelanto de 2 min: no vale la pena mover', (await one(`SELECT public.despacho_poner_horas() n`)).n === 0);
    t('el disparo la llama sin romperse', /faltan secretos|disparado|pg_net|vault/.test((await one(`SELECT public.despachar_llegadas() x`)).x));
    await c.query('ROLLBACK TO SAVEPOINT prueba');
  }
  if (fallas.length) throw new Error(fallas.length + ' comprobaciones fallaron');
  if (aplicar) { await c.query('COMMIT'); console.log('\n✔ 0160 APLICADA.'); } else { await c.query('ROLLBACK'); console.log('\n✔ En seco: todo bien. No se cambió nada.'); }
} catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error(`\n✗ ${e.message}\n  Se deshizo todo.`); process.exitCode = 1; } finally { await c.end(); }
