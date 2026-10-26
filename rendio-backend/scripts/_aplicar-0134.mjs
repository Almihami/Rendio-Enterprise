// 0134 · Cambió de vuelo o canceló: el sistema decide solo. Va encima de 0126 y 0128–0133.
//
//   LOCAL:  node scripts/_aplicar-0134.mjs --local [--con-previas] [--aplicar]
//           (--con-previas: la base local no tiene 0124–0133; se aplican en la
//            MISMA transacción solo para ensayar, y se deshace con todo)
//   DEV:    cd rendio-backend && set -a && source .env.dev && set +a && node scripts/_aplicar-0134.mjs [--aplicar]
//   PRODUCCIÓN (con su OK, después del respaldo en una carpeta NUEVA):
//           cd rendio-backend && set -a && source .env.main && set +a && node scripts/_aplicar-0134.mjs --produccion [--aplicar]
//
// Todo en UNA transacción; solo con --aplicar (y todo bien) se confirma.
//
// ANTES comprueba que la base tiene 0126, 0132 y 0133, y que las dos funciones
// que 0134 reemplaza son EXACTAMENTE las de sus archivos: auxiliar_change_flight
// la de 0126 y auxiliar_cancel_reservation la de 0117 (huella md5 del cuerpo,
// calculada del archivo). Si alguien las cambió, no aplica.
//
// Después comprueba que aplicar no mueve nada (paradas, reservas, vueltas,
// avisos y eventualidades idénticos; lo que ve cada tripulante, igual) y que las
// funciones internas no quedan abiertas a la app.
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const DEV = 'lxlphbafhtphulanhzlp', PROD = 'wvuurnfdrrdondrbbkhd';
const local = process.argv.includes('--local');
const conPrevias = process.argv.includes('--con-previas');
const prod = process.argv.includes('--produccion');
const aplicar = process.argv.includes('--aplicar');
if (conPrevias && (!local || aplicar)) { console.error('ABORT: --con-previas es solo para ensayar en LOCAL (sin --aplicar).'); process.exit(2); }
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
console.log(aplicar ? `\n== APLICANDO 0134 en ${amb} ==` : `\n== 0134 EN SECO contra ${amb} (se deshace) ==`);
const fallas = [];
const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); if (!ok) fallas.push(n); };
const como = async (sub, rol) => {
  await q(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub, role: 'authenticated', user_role: rol })]);
  await c.query('SET LOCAL ROLE authenticated');
};
const comoDb = async () => { await c.query('RESET ROLE'); await q(`SELECT set_config('request.jwt.claims', '', true)`); };
const strip = (f) => readFileSync(new URL(f, import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');

// El cuerpo exacto de una función en un archivo de migración (lo que guarda prosrc).
const cuerpo = (file, name) => {
  const s = readFileSync(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8');
  const i = s.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  const a = s.indexOf('AS $$', i) + 'AS $$'.length, b = s.indexOf('$$;', a);
  return s.slice(a, b);
};
const md5 = (x) => createHash('md5').update(x).digest('hex');
const ESPERADAS = {
  auxiliar_change_flight: md5(cuerpo('0126_vuelta_delegada.sql', 'auxiliar_change_flight')),
  auxiliar_cancel_reservation: md5(cuerpo('0117_avisos_desde_el_servidor.sql', 'auxiliar_cancel_reservation')),
};
const huellasDB = async () => Object.fromEntries((await q(`SELECT p.proname, md5(p.prosrc) h FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = ANY ($1)`, [Object.keys(ESPERADAS)])).map((r) => [r.proname, r.h]));
const huella = async () => one(`SELECT
    (SELECT md5(coalesce(string_agg(to_jsonb(s)::text, ',' ORDER BY id), '')) FROM public.route_stops s) paradas,
    (SELECT md5(coalesce(string_agg(to_jsonb(r)::text, ',' ORDER BY id), '')) FROM public.reservations r) reservas,
    (SELECT md5(coalesce(string_agg((to_jsonb(a) - 'auto_created' - 'updated_at')::text, ',' ORDER BY id), '')) FROM public.route_assignments a) vueltas,
    (SELECT count(*)::int FROM public.route_assignments) n_vueltas,
    (SELECT count(*)::int FROM public.notification_outbox) avisos,
    (SELECT count(*)::int FROM public.incidents) eventualidades`);

try {
  await c.query('BEGIN');
  if (conPrevias) {
    if (!(await one(`SELECT to_regprocedure('public.ops_alert_recipients_of(uuid)') IS NOT NULL AS ok`)).ok) await c.query(strip('../supabase/migrations/0117_avisos_desde_el_servidor.sql'));
    for (const m of ['0124_carro_del_turno', '0125_ruta_de_julian', '0126_vuelta_delegada', '0128_aviso_vuelta_terminada', '0129_conductor_de_una_vuelta', '0130_corte_de_pedidos', '0131_delegado_con_nombre', '0132_carro_del_plan', '0133_pasajero_sin_cuenta']) await c.query(strip(`../supabase/migrations/${m}.sql`));
    console.log('  · (ensayo local: 0124–0133 aplicadas dentro de esta misma transacción)');
  }
  // ── 0. Lo que tiene que estar ──
  const base = await one(`SELECT
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='route_assignments' AND column_name='delegated_at') c0126,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='route_assignments' AND column_name='plan_vehicle_id') c0132,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='route_stops' AND column_name='guest_name') c0133,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='route_assignments' AND column_name='auto_created') ya`);
  t('la base tiene 0126 (delegada), 0132 (carro del plan) y 0133 (pasajero sin cuenta)', base.c0126 && base.c0132 && base.c0133, base);
  if (fallas.length) throw new Error('falta lo previo: no se aplica');
  if (base.ya) console.log('  · 0134 ya estaba aplicada: se vuelve a correr (es idempotente).');
  else {
    const hoy = await huellasDB();
    const distintas = Object.keys(ESPERADAS).filter((f) => hoy[f] !== ESPERADAS[f]);
    t('auxiliar_change_flight es la de 0126 y auxiliar_cancel_reservation la de 0117 (nadie las cambió)', distintas.length === 0, distintas.map((f) => `${f}: base ${hoy[f]} ≠ archivo ${ESPERADAS[f]}`).join(' · '));
    if (fallas.length) throw new Error('alguien cambió esas funciones: hay que volver a copiarlas en 0134');
  }

  const antes = await huella();
  const trips = await q(`SELECT DISTINCT ON (ap.profile_id) ap.profile_id pid FROM public.reservations r
                           JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
                          WHERE r.required_arrival_at > now() - interval '20 days'
                          ORDER BY ap.profile_id, r.required_arrival_at DESC LIMIT 8`);
  const vistaAntes = {};
  for (const r of trips) { await como(r.pid, 'auxiliar'); vistaAntes[r.pid] = (await one(`SELECT public.auxiliar_my_trips(30) v`)).v; await comoDb(); }

  await c.query(strip('../supabase/migrations/0134_reubicar_al_cambiar.sql'));

  // ── 1. Lo nuevo quedó ──
  const o = await one(`SELECT
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='route_assignments' AND column_name='auto_created') col,
      to_regprocedure('public.reubicar_reserva(uuid)') IS NOT NULL f1,
      has_function_privilege('authenticated', 'public.reubicar_reserva(uuid)', 'EXECUTE') f1_app,
      has_function_privilege('authenticated', 'public.reub_candidatas(uuid,integer)', 'EXECUTE') f2_app,
      has_function_privilege('authenticated', 'public.auxiliar_change_flight(uuid,text,timestamptz,text)', 'EXECUTE') cf_app,
      has_function_privilege('authenticated', 'public.auxiliar_cancel_reservation(uuid,text)', 'EXECUTE') cc_app`);
  t('columna auto_created y reubicar_reserva; las internas cerradas a la app; cambio de vuelo y cancelar abiertos', o.col && o.f1 && !o.f1_app && !o.f2_app && o.cf_app && o.cc_app, o);
  const nuevas = await huellasDB();
  t('las dos funciones quedaron reemplazadas', Object.keys(ESPERADAS).every((f) => nuevas[f] && nuevas[f] !== ESPERADAS[f]), nuevas);

  // ── 2. Aplicar no mueve nada ──
  const durante = await huella();
  t(`paradas, reservas, las ${antes.n_vueltas} vueltas, avisos y eventualidades: idénticos`, JSON.stringify(antes) === JSON.stringify(durante), { antes, durante });
  let iguales = 0;
  for (const r of trips) {
    await como(r.pid, 'auxiliar');
    const v = (await one(`SELECT public.auxiliar_my_trips(30) v`)).v;
    await comoDb();
    if (JSON.stringify(v) === JSON.stringify(vistaAntes[r.pid])) iguales++;
  }
  t(`lo que ven ${trips.length} tripulantes con viajes recientes: igual que antes`, iguales === trips.length, `${iguales}/${trips.length}`);

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
