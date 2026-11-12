// 0159 · Despacho: la hora de la vuelta al asignar, texto neutro y «Nadie ha tomado» callado para llegadas.
//   cd rendio-backend && set -a && source <.env.dev|.env.main> && set +a && node scripts/_aplicar-0159.mjs [--produccion] [--aplicar]
// Una transacción; solo con --aplicar se confirma. En dev arma un caso y lo deshace.
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const DEV = 'lxlphbafhtphulanhzlp', PROD = 'wvuurnfdrrdondrbbkhd';
const prod = process.argv.includes('--produccion'), aplicar = process.argv.includes('--aplicar');
const esperado = prod ? PROD : DEV;
if ((process.env.SUPABASE_PROJECT_REF || '') !== esperado || !(process.env.SUPABASE_URL || '').includes(esperado)) { console.error('ABORT: ambiente equivocado'); process.exit(2); }
const c = new pg.Client({ host: prod ? 'aws-1-us-west-2.pooler.supabase.com' : 'aws-1-us-east-1.pooler.supabase.com', port: 5432, database: 'postgres', user: 'postgres.' + esperado, password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false }, statement_timeout: 60000 });
await c.connect();
const q = async (s, v) => (await c.query(s, v)).rows, one = async (s, v) => (await q(s, v))[0];
const fallas = []; const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + JSON.stringify(d) : ''}`); if (!ok) fallas.push(n); };
const leer = (f) => readFileSync(new URL('../supabase/migrations/' + f, import.meta.url), 'utf8');
const cuerpo = (src, firma) => { const i = src.indexOf(firma); const a = src.indexOf('AS $$', i) + 5; return src.slice(a, src.indexOf('$$;', a)); };
const md5 = (s) => createHash('md5').update(s).digest('hex');
const fn = (n) => one(`SELECT prosrc FROM pg_proc WHERE proname = $1 AND pronamespace = 'public'::regnamespace`, [n]);
const sql = leer('0159_despacho_hora_y_avisos.sql').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
console.log(`\n== 0159 ${aplicar ? 'APLICANDO' : 'EN SECO'} en ${prod ? 'PRODUCCIÓN' : 'dev'} ==`);
await c.query('BEGIN');
try {
  await c.query(`SET LOCAL lock_timeout = '5s'`);
  const pu = await fn('pool_unclaimed_alerts');
  t('pool_unclaimed_alerts es la de 0126 (o ya la de 0159)', !!pu && (/0159/.test(pu.prosrc) || md5(pu.prosrc) === md5(cuerpo(leer('0126_vuelta_delegada.sql'), 'CREATE OR REPLACE FUNCTION public.pool_unclaimed_alerts()'))));
  const da = await fn('despacho_asignar');
  t('despacho_asignar es la de 0158 (o ya la de 0159)', !!da && (/0159/.test(da.prosrc) || md5(da.prosrc) === md5(cuerpo(leer('0158_despacho_llegadas.sql'), 'CREATE OR REPLACE FUNCTION public.despacho_asignar('))));
  t('existe sync_calculated_pickup', !!(await fn('sync_calculated_pickup')));
  if (fallas.length) throw new Error('la base no es la esperada: NO se toca');
  await c.query(sql);
  for (const f of ['despacho_asignar', 'despacho_avisar', 'pool_unclaimed_alerts']) {
    const g = await one(`SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('anon', p.oid, 'EXECUTE') n FROM pg_proc p WHERE p.proname = $1 AND p.pronamespace = 'public'::regnamespace`, [f]);
    t(`${f}: la app no la puede llamar`, g && g.a === false && g.n === false, g);
  }
  if (!prod) {
    await c.query('SAVEPOINT prueba');
    const J = await one(`SELECT id, organization_id org FROM public.profiles WHERE email = 'demo-admin@rendio.demo'`);
    const B = await one(`SELECT dp.id, dp.profile_id FROM public.profiles p JOIN public.driver_profiles dp ON dp.profile_id = p.id WHERE p.email = 'juan.franco@rendio.co'`);
    const X = await one(`SELECT ap.id, ap.profile_id FROM public.profiles p JOIN public.auxiliar_profiles ap ON ap.profile_id = p.id WHERE p.email = 'prueba.mateo@rendio.demo'`);
    const veh = await one(`SELECT id FROM public.vehicles WHERE organization_id = $1 AND deleted_at IS NULL ORDER BY internal_code LIMIT 1`, [J.org]);
    await c.query(`SELECT set_config('rendio.no_acomodar', 'on', true)`);
    await c.query(`UPDATE public.shifts SET status = 'closed', end_at = greatest(start_at, now()) WHERE organization_id = $1 AND status::text <> 'closed'`, [J.org]);
    await c.query(`INSERT INTO public.shifts (organization_id, driver_id, vehicle_id, status, start_at) VALUES ($1, $2, $3, 'active', now() - interval '1 hour')`, [J.org, B.id, veh.id]);
    const base = (await one(`SELECT date_trunc('hour', now()) + interval '1 hour' b`)).b;          // hora en punto
    await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: J.id, role: 'authenticated' })]); await c.query('SET LOCAL ROLE authenticated');
    const rid = (await one(`SELECT public.admin_create_reservation($1, 'lle', $2::timestamptz, 'AV9909', NULL, false) id`, [X.id, base])).id;
    await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', '', true)`); await c.query(`SELECT set_config('rendio.no_acomodar', 'on', true)`);
    await c.query(`DELETE FROM public.route_stops WHERE reservation_id = $1`, [rid]);
    const ini0 = new Date(Date.parse(base) + 20 * 60000).toISOString();
    const ra = (await one(`INSERT INTO public.route_assignments (direction, status, planned_start_at, organization_id, pool, para_tomar) VALUES ('airport_to_home', 'planned', $1, $2, true, true) RETURNING id`, [ini0, J.org])).id;
    await c.query(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at) VALUES ($1, $2, 1, $3::timestamptz + interval '20 minutes')`, [ra, rid, ini0]);
    await c.query(`UPDATE public.app_settings SET despacho_activo = true WHERE id = 'singleton'`);
    // «Nadie ha tomado»: callado para la llegada con el despacho encendido; suena con él apagado.
    await c.query(`UPDATE public.route_assignments SET planned_start_at = now() + interval '30 minutes' WHERE id = $1`, [ra]);
    await c.query(`UPDATE public.route_stops SET estimated_arrival_at = now() + interval '30 minutes' WHERE route_assignment_id = $1`, [ra]);
    await c.query('SAVEPOINT un');
    await one(`SELECT public.pool_unclaimed_alerts() n`);
    t('despacho encendido: «Nadie ha tomado» NO suena por la llegada en espera', (await one(`SELECT count(*)::int n FROM public.notification_outbox WHERE dedupe_key LIKE 'unclaimed:' || $1 || ':%'`, [ra])).n === 0);
    await c.query(`UPDATE public.app_settings SET despacho_activo = false WHERE id = 'singleton'`);
    await one(`SELECT public.pool_unclaimed_alerts() n`);
    t('despacho apagado: suena como siempre', (await one(`SELECT count(*)::int n FROM public.notification_outbox WHERE dedupe_key LIKE 'unclaimed:' || $1 || ':%'`, [ra])).n >= 1);
    await c.query('ROLLBACK TO SAVEPOINT un');
    await c.query(`UPDATE public.route_assignments SET planned_start_at = $2 WHERE id = $1`, [ra, ini0]);
    await c.query(`UPDATE public.route_stops SET estimated_arrival_at = $2::timestamptz + interval '20 minutes' WHERE route_assignment_id = $1`, [ra, ini0]);
    // Vuelo adelantado: recoge 12 min antes de lo programado (a :08) → la vuelta queda a :10.
    const recoge = new Date(Date.parse(base) + 8 * 60000).toISOString(), esperada = new Date(Date.parse(base) + 10 * 60000).toISOString();
    const ok = (await one(`SELECT public.despacho_asignar($1, $2, $3, $3, 0) x`, [ra, B.id, recoge])).x;
    const v = await one(`SELECT ra.planned_start_at ini, ra.driver_profile_id d, (SELECT estimated_arrival_at FROM public.route_stops WHERE route_assignment_id = ra.id) eta, (SELECT calculated_pickup_at FROM public.reservations WHERE id = $2) pedido FROM public.route_assignments ra WHERE ra.id = $1`, [ra, rid]);
    t('asigna y deja la vuelta a la hora en que recoge (redondeada a 5)', ok === true && v.d === B.id && new Date(v.ini).toISOString() === esperada, v);
    t('la parada se corre lo mismo (10 min antes)', new Date(v.eta).toISOString() === new Date(Date.parse(ini0) + 10 * 60000).toISOString(), v);
    t('el pedido del tripulante toma la hora nueva', v.pedido && new Date(v.pedido).toISOString() === esperada, v);
    const hm = (await one(`SELECT public.hm_bog($1::timestamptz) h`, [esperada])).h;
    const av = await one(`SELECT body FROM public.notification_outbox WHERE dedupe_key = 'desp:' || $1 || ':' || $2`, [ra, B.id]);
    t(`el aviso al conductor dice la MISMA hora que su pantalla (${hm})`, av && av.body.includes('a las ' + hm), av);
    const lg = await one(`SELECT pickup_at FROM public.arrival_dispatch_log WHERE route_assignment_id = $1`, [ra]);
    t('el rastro guarda la hora de la vuelta', lg && new Date(lg.pickup_at).toISOString() === esperada, lg);
    await c.query(`UPDATE public.route_assignments SET driver_profile_id = NULL WHERE id = $1`, [ra]);
    await one(`SELECT public.despacho_avisar($1, 'sin_carro', now(), NULL) n`, [ra]);
    const tx = await one(`SELECT body FROM public.notification_outbox WHERE dedupe_key LIKE 'desp-apoyo:' || $1 || ':%' LIMIT 1`, [ra]);
    t('texto del aviso sin género', tx && /alcanza a hacer esa recogida/.test(tx.body) && !/recogerla/.test(tx.body), tx);
    await c.query('ROLLBACK TO SAVEPOINT prueba');
  }
  if (fallas.length) throw new Error(fallas.length + ' comprobaciones fallaron');
  if (aplicar) { await c.query('COMMIT'); console.log('\n✔ 0159 APLICADA.'); } else { await c.query('ROLLBACK'); console.log('\n✔ En seco: todo bien. No se cambió nada.'); }
} catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error(`\n✗ ${e.message}\n  Se deshizo todo.`); process.exitCode = 1; } finally { await c.end(); }
