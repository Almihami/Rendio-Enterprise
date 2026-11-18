// 0171 · En las llegadas, la hora que se dice es la del vuelo (avisos al tripulante + regla del combo).
//   cd rendio-backend && set -a && source <.env.dev|.env.main> && set +a && node scripts/_aplicar-0171.mjs [--produccion] [--aplicar]
// Sin --aplicar: EN SECO (ROLLBACK). Antes de tocar nada comprueba que las seis funciones estén EXACTAMENTE
// como las leyó el generador (scripts/_base-0171/): si alguna cambió, no sigue. Las pruebas SIEMPRE se deshacen (savepoint).
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const pg = createRequire('/Users/harold/Documents/Rendio-Drivers/Proyect-main-0164/rendio-backend/scripts/x.js')('pg');
const DEV = 'lxlphbafhtphulanhzlp', PROD = 'wvuurnfdrrdondrbbkhd';
const prod = process.argv.includes('--produccion'), aplicar = process.argv.includes('--aplicar');
const esperado = prod ? PROD : DEV;
if ((process.env.SUPABASE_PROJECT_REF || '') !== esperado || !(process.env.SUPABASE_URL || '').includes(esperado)) { console.error('ABORT: ambiente equivocado'); process.exit(2); }
const c = new pg.Client({ host: prod ? 'aws-1-us-west-2.pooler.supabase.com' : 'aws-1-us-east-1.pooler.supabase.com', port: 5432, database: 'postgres', user: 'postgres.' + esperado, password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false }, statement_timeout: 60000 });
await c.connect();
const q = async (s, v) => (await c.query(s, v)).rows, one = async (s, v) => (await q(s, v))[0];
const fallas = []; const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + JSON.stringify(d).slice(0, 400) : ''}`); if (!ok) fallas.push(n); };
const hm = (x) => (x ? new Date(x).toLocaleTimeString('en-GB', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit' }) : '--');
const FNS = ['detect_trip_reminders', 'reubicar_reserva', 'acomodar_eventualidades', 'admin_manual_route_set_times', 'admin_manual_route_publish', 'admin_pasar_reserva'];
const base = (f) => readFileSync(new URL(`./_base-0171/def-${f}.sql`, import.meta.url), 'utf8').trimEnd();
const def = async (f) => { const r = await q(`SELECT pg_get_functiondef(p.oid) d FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $1`, [f]); return r.length === 1 ? r[0].d.trimEnd() : null; };
const sql = readFileSync(new URL('../supabase/migrations/0171_hora_del_vuelo.sql', import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
console.log(`\n== 0171 ${aplicar ? 'APLICANDO' : 'EN SECO'} en ${prod ? 'PRODUCCIÓN' : 'dev'} ==`);
await c.query('BEGIN');
try {
  await c.query(`SET LOCAL lock_timeout = '5s'`);
  for (const f of FNS) t(`${f} está como la leyó el generador`, (await def(f)) === base(f));
  for (const f of ['reub_baja', 'reub_arriba5', 'flight_deplane_min', 'lugar_del_regreso', 'sync_calculated_pickup', 'trip_notify', 'hm_bog'])
    t('está ' + f, !!(await one(`SELECT 1 x FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = $1`, [f])));
  if (fallas.length) throw new Error('la base no está como se esperaba: no se aplica');
  const priv = async () => Object.fromEntries((await q(`SELECT p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('anon', p.oid, 'EXECUTE') n FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1)`, [FNS])).map((r) => [r.proname, `${r.a}/${r.n}`]));
  const antes = await priv();
  await c.query(sql);
  for (const f of FNS) t(`${f} quedó con 0171`, /0171/.test((await def(f)) || ''));
  t('los permisos de las seis no cambiaron', JSON.stringify(await priv()) === JSON.stringify(antes), await priv());

  await c.query('SAVEPOINT prueba');
  t('detect_trip_reminders() corre', !!(await one('SELECT public.detect_trip_reminders() x')));
  t('acomodar_eventualidades() corre', !!(await one('SELECT public.acomodar_eventualidades() x')));
  const rem = await q(`SELECT title FROM public.notification_outbox WHERE created_at >= now() AND title LIKE 'Tu conductor%'`);   // now() = el inicio de ESTA transacción
  console.log('  · recordatorios de llegada que saldrían ahora:', rem.length ? rem.map((x) => x.title).join(' | ') : 'ninguno');
  await c.query('ROLLBACK TO SAVEPOINT prueba');

  // La regla del combo, con vueltas reales (si las hay): alguien que llega en un vuelo, todavía pendiente, pasa a
  // una llegada que sale de JMC ANTES de que esa persona salga del avión.
  const cand = await one(`
    WITH per AS (
      SELECT r.id rid, rs.route_assignment_id de, pr.organization_id org, pr.full_name nombre, ap.profile_id crew,
             public.reub_arriba5(coalesce(public.reub_baja(pr.organization_id, r.flight_code, r.required_arrival_at), r.required_arrival_at)
               + make_interval(mins => coalesce(public.flight_deplane_min(r.flight_code), 15))) sale
        FROM public.reservations r JOIN public.route_stops rs ON rs.reservation_id = r.id AND rs.status = 'pending'
        JOIN public.route_assignments a ON a.id = rs.route_assignment_id AND a.status = 'planned'
        JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id JOIN public.profiles pr ON pr.id = ap.profile_id
       WHERE r.direction = 'airport_to_home' AND r.cancelled_at IS NULL AND r.flight_code IS NOT NULL
         AND NOT coalesce(r.ground_ops, false) AND r.reserve_place IS NULL AND r.required_arrival_at > now() + interval '40 minutes'
         AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = a.id AND x.status <> 'pending'))
    SELECT per.*, b.id a, b.planned_start_at ini,
           (SELECT p.id FROM public.profiles p WHERE p.role = 'admin' AND p.deleted_at IS NULL AND p.organization_id = per.org ORDER BY p.created_at LIMIT 1) jefe
      FROM per JOIN public.route_assignments b ON b.direction = 'airport_to_home' AND b.status = 'planned' AND b.id <> per.de AND b.delegated_at IS NULL
           AND b.planned_start_at > now() + interval '30 minutes' AND b.planned_start_at < per.sale - interval '5 minutes'
           AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = b.id AND x.status <> 'pending')
           AND EXISTS (SELECT 1 FROM public.route_stops x JOIN public.reservations y ON y.id = x.reservation_id JOIN public.auxiliar_profiles ya ON ya.id = y.auxiliar_profile_id
                         JOIN public.profiles yp ON yp.id = ya.profile_id WHERE x.route_assignment_id = b.id AND yp.organization_id = per.org)
     ORDER BY per.sale - b.planned_start_at LIMIT 1`);
  if (!cand || !cand.jefe) console.log('  · regla del combo: aquí no hay dos llegadas pendientes que sirvan para probarla (se prueba donde las haya)');
  else {
    await c.query('SAVEPOINT combo');
    await c.query(`SELECT set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true), set_config('request.jwt.claim.role', 'authenticated', true)`, [JSON.stringify({ sub: cand.jefe, role: 'authenticated' }), cand.jefe]);
    console.log(`  · prueba: ${cand.nombre.split(' ')[0]} (sale del avión ${hm(cand.sale)}) → llegada de las ${hm(cand.ini)}`);
    const r = (await one('SELECT public.admin_pasar_reserva($1, $2) x', [cand.rid, cand.a])).x;
    const b = await one('SELECT planned_start_at FROM public.route_assignments WHERE id = $1', [cand.a]);
    t('el combo tomó la hora en que esa persona sale del avión', +new Date(b.planned_start_at) === +new Date(cand.sale), { quedo: hm(b.planned_start_at), esperaba: hm(cand.sale), r });
    const av = await q(`SELECT o.title, o.body, o.profile_id FROM public.notification_outbox o WHERE o.created_at >= now() AND (o.dedupe_key LIKE '%' || $1 || '%' OR o.dedupe_key LIKE '%' || $2 || '%' OR o.dedupe_key LIKE '%' || $3 || '%')`, [cand.rid, cand.a, cand.de]);
    const suyo = av.find((x) => x.profile_id === cand.crew && /Te movimos/.test(x.title));
    t('a esa persona: «Te esperamos en JMC cuando aterrices», sin hora', !!suyo && /Te esperamos en JMC cuando aterrices/.test(suyo.body) && !/\d:\d\d/.test(suyo.body), suyo || av);
    await c.query('SELECT public.acomodar_eventualidades()');
    const donde = await q(`SELECT rs.route_assignment_id ra FROM public.route_stops rs JOIN public.route_assignments a ON a.id = rs.route_assignment_id WHERE rs.reservation_id = $1 AND a.status IN ('draft', 'planned', 'in_progress')`, [cand.rid]);
    t('…y el acomodo automático NO la vuelve a sacar del combo', donde.length === 1 && donde[0].ra === cand.a, donde);
    console.log('    avisos de la prueba:', av.map((x) => `${x.title} — ${x.body}`).join(' | ').slice(0, 600));
    await c.query('ROLLBACK TO SAVEPOINT combo');
  }
  if (fallas.length) throw new Error(`${fallas.length} comprobación(es) fallaron`);
  if (aplicar) { await c.query('COMMIT'); console.log(`\n✓ 0171 APLICADA en ${prod ? 'PRODUCCIÓN' : 'dev'}`); } else { await c.query('ROLLBACK'); console.log('\nEN SECO: todo en orden, no se guardó nada'); }
} catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('\n✗ NO se aplicó nada:', e.message); process.exitCode = 1; }
await c.end();
