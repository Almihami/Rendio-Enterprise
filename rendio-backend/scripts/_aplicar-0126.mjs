// 0126 · La vuelta DELEGADA (la hace alguien de afuera). Va ENCIMA de 0125.
//
//   LOCAL:  node scripts/_aplicar-0126.mjs --local [--con-0125] [--aplicar]
//           (--con-0125: la base local no tiene 0125; se aplica en la MISMA
//            transacción solo para ensayar, y se deshace con todo)
//   DEV:    cd rendio-backend && set -a && source .env.dev && set +a && node scripts/_aplicar-0126.mjs [--aplicar]
//   PRODUCCIÓN (con su OK, después del respaldo en una carpeta NUEVA):
//           cd rendio-backend && set -a && source .env.main && set +a && node scripts/_aplicar-0126.mjs --produccion [--aplicar]
//
// Todo en UNA transacción; solo con --aplicar (y todo bien) se confirma.
//
// ANTES comprueba que 0125 está aplicada y que las siete funciones que 0126
// reemplaza son EXACTAMENTE las de 0125 (huella md5 del cuerpo). Si alguien las
// cambió después de 0125, no aplica: habría que volver a copiarlas.
//
// Después comprueba que aplicar no mueve nada: paradas, reservas, vueltas y
// avisos idénticos; lo que ve cada tripulante es lo mismo de antes más
// «delegated: false»; los conductores ven las mismas vueltas para tomar.
import pg from 'pg';
import { readFileSync } from 'node:fs';

const DEV = 'lxlphbafhtphulanhzlp', PROD = 'wvuurnfdrrdondrbbkhd';
const local = process.argv.includes('--local');
const con0125 = process.argv.includes('--con-0125');
const prod = process.argv.includes('--produccion');
const aplicar = process.argv.includes('--aplicar');
if (con0125 && (!local || aplicar)) { console.error('ABORT: --con-0125 es solo para ensayar en LOCAL (sin --aplicar).'); process.exit(2); }
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
console.log(aplicar ? `\n== APLICANDO 0126 en ${amb} ==` : `\n== 0126 EN SECO contra ${amb} (se deshace) ==`);
const fallas = [];
const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); if (!ok) fallas.push(n); };
const como = async (sub, rol) => {
  await q(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub, role: 'authenticated', user_role: rol })]);
  await c.query('SET LOCAL ROLE authenticated');
};
const comoDb = async () => { await c.query('RESET ROLE'); await q(`SELECT set_config('request.jwt.claims', '', true)`); };
const strip = (f) => readFileSync(new URL(f, import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');

const FUNCS = ['sync_calculated_pickup', 'auxiliar_my_trips', 'auxiliar_change_flight', 'detect_late_bookings', 'driver_open_routes', 'driver_take_route', 'pool_unclaimed_alerts'];
const huellasDB = async () => Object.fromEntries((await q(`SELECT p.proname, md5(p.prosrc) h FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = ANY ($1)`, [FUNCS])).map((r) => [r.proname, r.h]));
const COLS_NUEVAS = ['delegated_at', 'delegated_by'];
const huella = async () => one(`SELECT
    (SELECT md5(coalesce(string_agg(to_jsonb(s)::text, ',' ORDER BY id), '')) FROM public.route_stops s) paradas,
    (SELECT md5(coalesce(string_agg(to_jsonb(r)::text, ',' ORDER BY id), '')) FROM public.reservations r) reservas,
    (SELECT md5(coalesce(string_agg((to_jsonb(a) ${COLS_NUEVAS.map((k) => `- '${k}'`).join(' ')} - 'updated_at')::text, ',' ORDER BY id), '')) FROM public.route_assignments a) vueltas,
    (SELECT count(*)::int FROM public.route_assignments) n_vueltas,
    (SELECT count(*)::int FROM public.notification_outbox) avisos,
    (SELECT count(*)::int FROM public.incidents) eventualidades`);
const sinDelegada = (x) => JSON.stringify(x, (k, v) => (k === 'delegated' ? undefined : v));

try {
  await c.query('BEGIN');
  if (con0125) {
    if (!(await one(`SELECT to_regprocedure('public.ops_alert_recipients_of(uuid)') IS NOT NULL AS ok`)).ok) await c.query(strip('../supabase/migrations/0117_avisos_desde_el_servidor.sql'));
    await c.query(strip('../supabase/migrations/0124_carro_del_turno.sql'));
    await c.query(strip('../supabase/migrations/0125_ruta_de_julian.sql'));
    console.log('  · (ensayo local: 0124 y 0125 aplicadas dentro de esta misma transacción)');
  }
  // ── 0. Lo que tiene que estar ──
  const base = await one(`SELECT
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='route_assignments' AND column_name='pool') c0125,
      EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'driver_take_route') f0125,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='route_assignments' AND column_name='delegated_at') ya`);
  t('la base tiene 0125 (la ruta de Julián): 0126 va encima', base.c0125 && base.f0125, base);
  if (fallas.length) throw new Error('falta 0125: no se aplica');
  // Las 7 funciones tienen que ser las de 0125 (si 0126 ya estaba, las de 0126).
  const src0125 = readFileSync(new URL('../supabase/migrations/0125_ruta_de_julian.sql', import.meta.url), 'utf8');
  const hoy = await huellasDB();
  if (base.ya) console.log('  · 0126 ya estaba aplicada: se vuelve a correr (es idempotente).');
  else {
    // Huella esperada: la que deja 0125 en ESTA base (se aplica en un SAVEPOINT y se deshace).
    await c.query('SAVEPOINT h0125');
    await c.query(src0125.replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, ''));
    const esperadas = await huellasDB();
    await c.query('ROLLBACK TO SAVEPOINT h0125');
    const distintas = FUNCS.filter((f) => hoy[f] !== esperadas[f]);
    t('las 7 funciones que 0126 reemplaza son EXACTAMENTE las de 0125 (nadie las cambió)', distintas.length === 0, distintas.join(', '));
    if (fallas.length) throw new Error('alguien cambió funciones de 0125: hay que volver a copiarlas en 0126');
  }

  const antes = await huella();
  const trips = await q(`SELECT DISTINCT ON (ap.profile_id) ap.profile_id pid FROM public.reservations r
                           JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
                          WHERE r.required_arrival_at > now() - interval '20 days'
                          ORDER BY ap.profile_id, r.required_arrival_at DESC LIMIT 8`);
  const vistaAntes = {};
  for (const r of trips) { await como(r.pid, 'auxiliar'); vistaAntes[r.pid] = (await one(`SELECT public.auxiliar_my_trips(30) v`)).v; await comoDb(); }
  const cond = await one(`SELECT p.id FROM public.driver_profiles dp JOIN public.profiles p ON p.id = dp.profile_id WHERE p.deleted_at IS NULL ORDER BY p.created_at LIMIT 1`);
  let abiertasAntes = null;
  if (cond) { await como(cond.id, 'driver'); abiertasAntes = (await one(`SELECT public.driver_open_routes() l`)).l; await comoDb(); }

  await c.query(strip('../supabase/migrations/0126_vuelta_delegada.sql'));

  // ── 1. Lo nuevo quedó ──
  const o = await one(`SELECT
      (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='route_assignments' AND column_name = ANY ($1))::int cols,
      EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'route_assignments_delegada_sin_conductor') chk,
      has_function_privilege('authenticated', 'public.admin_route_set_delegated(uuid,boolean)', 'EXECUTE') f_auth,
      has_function_privilege('anon', 'public.admin_route_set_delegated(uuid,boolean)', 'EXECUTE') f_anon`, [COLS_NUEVAS]);
  t('2 columnas nuevas, la restricción «delegada ⇒ sin conductor» y la función para jefes (no anónimo)', o.cols === 2 && o.chk && o.f_auth && !o.f_anon, o);
  const nuevas = await huellasDB();
  t('las 7 copias quedaron reemplazadas', FUNCS.every((f) => nuevas[f] && nuevas[f] !== (base.ya ? '' : hoy[f])), nuevas);

  // ── 2. Aplicar no mueve nada ──
  const durante = await huella();
  t(`paradas, reservas, las ${antes.n_vueltas} vueltas, avisos y eventualidades: idénticos`, JSON.stringify(antes) === JSON.stringify(durante), { antes, durante });
  let iguales = 0, conMarca = 0;
  for (const r of trips) {
    await como(r.pid, 'auxiliar');
    const v = (await one(`SELECT public.auxiliar_my_trips(30) v`)).v;
    await comoDb();
    if (sinDelegada(v) === sinDelegada(vistaAntes[r.pid])) iguales++;
    const lista = Array.isArray(v) ? v : [];
    if (lista.every((x) => x.delegated === false)) conMarca++;
  }
  t(`lo que ven ${trips.length} tripulantes con viajes recientes: igual que antes`, iguales === trips.length, `${iguales}/${trips.length}`);
  t('…con «delegated: false» (todavía ninguna vuelta delegada)', conMarca === trips.length, `${conMarca}/${trips.length}`);
  if (cond) {
    await como(cond.id, 'driver'); const ab = (await one(`SELECT public.driver_open_routes() l`)).l; await comoDb();
    t('un conductor ve las mismas «Vueltas para tomar» que antes', JSON.stringify(ab) === JSON.stringify(abiertasAntes), { antes: abiertasAntes, despues: ab });
  }

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
