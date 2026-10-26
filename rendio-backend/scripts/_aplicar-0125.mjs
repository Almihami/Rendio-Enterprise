// 0125 · La ruta de Julián (vueltas pegadas que los conductores toman).
//
//   LOCAL:  node scripts/_aplicar-0125.mjs --local [--aplicar]
//   DEV:    cd rendio-backend && set -a && source .env.dev && set +a && node scripts/_aplicar-0125.mjs [--aplicar]
//   PRODUCCIÓN (con su OK, después del respaldo en una carpeta NUEVA):
//           cd rendio-backend && set -a && source .env.main && set +a && node scripts/_aplicar-0125.mjs --produccion [--aplicar]
//
// Todo en UNA transacción; solo con --aplicar (y todo bien) se confirma.
//
// ANTES de aplicar comprueba que las cuatro funciones que 0125 reemplaza
// (sync_calculated_pickup, auxiliar_my_trips, auxiliar_change_flight,
// detect_late_bookings) son EXACTAMENTE las que se copiaron (huella md5 del
// cuerpo, igual en local, dev y producción el 25-oct-2026). Si alguien las cambió
// después, no aplica: habría que volver a copiarlas.
//
// Después comprueba que aplicar no mueve nada: paradas, reservas, vueltas y
// avisos idénticos; lo que ve cada tripulante (auxiliar_my_trips) es lo mismo de
// antes más «driver_pending: false»; detect_late_bookings abriría las mismas
// eventualidades. Y en un SAVEPOINT que siempre se deshace: el jefe publica una
// ruta vacía, un conductor lee «Vueltas para tomar» y el reloj de «nadie la tomó»
// corre sin avisar a nadie.
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
console.log(aplicar ? `\n== APLICANDO 0125 en ${amb} ==` : `\n== 0125 EN SECO contra ${amb} (se deshace) ==`);
const fallas = [];
const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); if (!ok) fallas.push(n); };
const como = async (sub, rol) => {
  await q(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub, role: 'authenticated', user_role: rol })]);
  await c.query('SET LOCAL ROLE authenticated');
};
const comoDb = async () => { await c.query('RESET ROLE'); await q(`SELECT set_config('request.jwt.claims', '', true)`); };

// El cuerpo de las funciones que 0125 copia y reemplaza (md5 de prosrc, 25-oct-2026).
const COPIADAS = {
  sync_calculated_pickup: '933a4e214d637efca058ee38f4bd6db6',
  auxiliar_my_trips: 'afe11728c45b4c15343d8a35f18f6335',
  auxiliar_change_flight: '32f24f3248d947d17a20e1edadf6fde9',
  detect_late_bookings: 'a10a56bb5b6187f67b328f9c0191effa',
};
const COLS_NUEVAS = ['pool', 'organization_id', 'manual_day', 'deadline_at', 'manual_note'];
const huella = async () => one(`SELECT
    (SELECT md5(coalesce(string_agg(to_jsonb(s)::text, ',' ORDER BY id), '')) FROM public.route_stops s) paradas,
    (SELECT md5(coalesce(string_agg(to_jsonb(r)::text, ',' ORDER BY id), '')) FROM public.reservations r) reservas,
    (SELECT md5(coalesce(string_agg((to_jsonb(a) ${COLS_NUEVAS.map((k) => `- '${k}'`).join(' ')} - 'updated_at')::text, ',' ORDER BY id), '')) FROM public.route_assignments a) vueltas,
    (SELECT count(*)::int FROM public.route_assignments) n_vueltas,
    (SELECT count(*)::int FROM public.notification_outbox) avisos,
    (SELECT count(*)::int FROM public.incidents) eventualidades`);
const sinPendiente = (x) => JSON.stringify(x, (k, v) => (k === 'driver_pending' ? undefined : v));

try {
  // ── 0. Lo que tiene que estar ──
  const pre = await q(`SELECT p.proname, md5(p.prosrc) h FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public' AND p.proname = ANY ($1)`, [Object.keys(COPIADAS)]);
  const distintas = Object.keys(COPIADAS).filter((f) => !pre.some((r) => r.proname === f && r.h === COPIADAS[f]));
  t('las 4 funciones que 0125 reemplaza son las que se copiaron (nadie las cambió desde el 25-oct)', distintas.length === 0, distintas.join(', '));
  const base = await one(`SELECT
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='route_assignments' AND column_name='plan_car') c0124,
      EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'ops_alert_recipients_of') c0117,
      EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'flight_deplane_min') c0099,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='route_assignments' AND column_name='pool') ya`);
  t('la base tiene 0099, 0117 y 0124 (0125 las usa)', base.c0124 && base.c0117 && base.c0099, base);
  if (base.ya) console.log('  · 0125 ya estaba aplicada: se vuelve a correr (es idempotente).');
  if (fallas.length) throw new Error('falta lo previo: no se aplica');

  await c.query('BEGIN');
  const antes = await huella();
  // Lo que ve cada tripulante HOY (con la función de antes).
  const trips = await q(`SELECT DISTINCT ON (ap.profile_id) ap.profile_id pid FROM public.reservations r
                           JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
                          WHERE r.required_arrival_at > now() - interval '20 days'
                          ORDER BY ap.profile_id, r.required_arrival_at DESC LIMIT 8`);
  const vistaAntes = {};
  for (const r of trips) { await como(r.pid, 'auxiliar'); vistaAntes[r.pid] = (await one(`SELECT public.auxiliar_my_trips(30) v`)).v; await comoDb(); }
  await c.query('SAVEPOINT tarde0');
  const tardias0 = (await one(`SELECT public.detect_late_bookings() n`)).n;
  await c.query('ROLLBACK TO SAVEPOINT tarde0');

  await c.query(readFileSync(new URL('../supabase/migrations/0125_ruta_de_julian.sql', import.meta.url), 'utf8')
    .replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, ''));

  // ── 1. Lo nuevo quedó ──
  const o = await one(`SELECT
      (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='route_assignments' AND column_name = ANY ($1))::int cols,
      (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.crew_aliases'::regclass) rls,
      (SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname IN ('idx_route_assignments_pool_open', 'idx_route_assignments_manual_day'))::int idx,
      has_function_privilege('authenticated', 'public.admin_manual_route_publish(date,jsonb,jsonb)', 'EXECUTE') f_pub,
      has_function_privilege('authenticated', 'public.driver_take_route(uuid)', 'EXECUTE') f_take,
      has_function_privilege('authenticated', 'public.driver_release_route(uuid)', 'EXECUTE') f_rel,
      has_function_privilege('authenticated', 'public.driver_open_routes()', 'EXECUTE') f_open,
      has_function_privilege('anon', 'public.driver_take_route(uuid)', 'EXECUTE') f_anon,
      has_function_privilege('authenticated', 'public.route_sync_assigned(uuid)', 'EXECUTE') f_int1,
      has_function_privilege('authenticated', 'public.pool_unclaimed_alerts()', 'EXECUTE') f_int2`, [COLS_NUEVAS]);
  t('5 columnas nuevas en route_assignments, crew_aliases con RLS, sus 2 índices', o.cols === 5 && o.rls === true && o.idx === 2, o);
  t('la app puede publicar, ver, tomar y soltar; anónimo no; lo interno no se llama desde la app', o.f_pub && o.f_take && o.f_rel && o.f_open && !o.f_anon && !o.f_int1 && !o.f_int2, o);
  const cron = await q(`SELECT jobname, schedule, active, command FROM cron.job WHERE jobname = 'pool-unclaimed-alerts'`).catch(() => null);
  t('el reloj «nadie tomó la vuelta» quedó programado cada 5 minutos', cron && cron.length === 1 && cron[0].schedule === '*/5 * * * *' && cron[0].active && /pool_unclaimed_alerts/.test(cron[0].command), cron);

  // ── 2. Aplicar no mueve nada ──
  const durante = await huella();
  t(`paradas, reservas, las ${antes.n_vueltas} vueltas, avisos y eventualidades: idénticos`, JSON.stringify(antes) === JSON.stringify(durante), { antes, durante });
  let iguales = 0, conMarca = 0;
  for (const r of trips) {
    await como(r.pid, 'auxiliar');
    const v = (await one(`SELECT public.auxiliar_my_trips(30) v`)).v;
    await comoDb();
    if (sinPendiente(v) === sinPendiente(vistaAntes[r.pid])) iguales++;
    const lista = Array.isArray(v) ? v : (v && (v.trips || v.items)) || [];
    if (!lista.length || lista.every((x) => x.driver_pending === false)) conMarca++;
  }
  t(`lo que ven ${trips.length} tripulantes con viajes recientes: igual que antes`, iguales === trips.length, `${iguales}/${trips.length}`);
  t('…y con «driver_pending: false» (ninguna vuelta pegada todavía)', conMarca === trips.length, `${conMarca}/${trips.length}`);
  await c.query('SAVEPOINT tarde1');
  const tardias1 = (await one(`SELECT public.detect_late_bookings() n`)).n;
  await c.query('ROLLBACK TO SAVEPOINT tarde1');
  t(`detect_late_bookings abriría lo mismo que antes (${tardias0})`, tardias0 === tardias1, { antes: tardias0, despues: tardias1 });

  // ── 3. Probar con usuarios de verdad (se deshace) ──
  await c.query('SAVEPOINT prueba');
  const jefe = await one(`SELECT p.id FROM public.profiles p WHERE p.role = 'admin' AND p.deleted_at IS NULL AND p.organization_id IS NOT NULL ORDER BY p.created_at LIMIT 1`);
  const cond = await one(`SELECT p.id FROM public.driver_profiles dp JOIN public.profiles p ON p.id = dp.profile_id WHERE p.deleted_at IS NULL ORDER BY p.created_at LIMIT 1`);
  if (jefe) {
    await como(jefe.id, 'admin');
    const r = (await one(`SELECT public.admin_manual_route_publish('2099-01-01'::date, '[]'::jsonb, '[]'::jsonb) r`)).r;
    const n = (await one(`SELECT public.admin_manual_route_clear('2099-01-01'::date) n`)).n;
    const ali = (await q(`SELECT count(*)::int n FROM public.crew_aliases`))[0].n;
    await comoDb();
    t('el jefe publica (una ruta vacía) y la quita sin error', r && r.created === 0 && r.vueltas === 0 && n === 0, r);
    t('el jefe lee los apodos (todavía ninguno)', ali === 0, ali);
  } else t('hay un jefe para la prueba', false);
  if (cond) {
    await como(cond.id, 'driver');
    const L = (await one(`SELECT public.driver_open_routes() l`)).l;
    let e = null;
    try { await c.query('SAVEPOINT tomar'); await q(`SELECT public.driver_take_route(gen_random_uuid())`); } catch (x) { e = x; }
    await c.query('ROLLBACK TO SAVEPOINT tomar');
    await comoDb();
    t('un conductor lee «Vueltas para tomar» (vacía)', Array.isArray(L) && L.length === 0, L);
    t('tomar una vuelta que no existe lo dice en español', e && /no está disponible|ya la tomó/.test(e.message), e && e.message);
  } else t('hay un conductor para la prueba', false);
  const av = (await one(`SELECT public.pool_unclaimed_alerts() n`)).n;
  t('el reloj corre y no avisa a nadie (no hay vueltas pegadas)', av === 0, av);
  await c.query('ROLLBACK TO SAVEPOINT prueba');
  const despues = await huella();
  t('después de deshacer la prueba, todo como recién aplicada', JSON.stringify(durante) === JSON.stringify(despues), { durante, despues });

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
