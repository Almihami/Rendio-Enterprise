// 0135 · Las eventualidades se acomodan solas, en el mejor sitio. Va encima de 0134.
//
//   LOCAL:  node scripts/_aplicar-0135.mjs --local [--con-previas] [--aplicar]
//           (--con-previas: la base local no tiene 0124–0134; se aplican en la
//            MISMA transacción solo para ensayar, y se deshace con todo)
//   DEV:    cd rendio-backend && set -a && source .env.dev && set +a && node scripts/_aplicar-0135.mjs [--aplicar]
//   PRODUCCIÓN (con su OK, después del respaldo en una carpeta NUEVA):
//           cd rendio-backend && set -a && source .env.main && set +a && node scripts/_aplicar-0135.mjs --produccion [--aplicar]
//
// Todo en UNA transacción; solo con --aplicar (y todo bien) se confirma.
//
// ANTES comprueba que la base tiene 0134 y que las tres funciones que 0135
// reemplaza (reubicar_reserva, reub_candidatas, auxiliar_change_flight) son
// EXACTAMENTE las del archivo 0134, y hm_bog la de 0125 (huella md5 del cuerpo). Si alguien las
// cambió, no aplica.
//
// Después comprueba que aplicar no mueve nada (paradas, reservas, vueltas, avisos
// y eventualidades idénticos) y MUESTRA lo que haría el primer barrido (la
// función que el cron corre cada 5 min) con los datos de hoy: qué vuelta corre,
// a quién mueve, qué eventualidad resuelve. Ese ensayo SIEMPRE se deshace: el
// barrido de verdad lo hace el cron después de confirmar.
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
console.log(aplicar ? `\n== APLICANDO 0135 en ${amb} ==` : `\n== 0135 EN SECO contra ${amb} (se deshace) ==`);
const fallas = [];
const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); if (!ok) fallas.push(n); };
const strip = (f) => readFileSync(new URL(f, import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');

const cuerpo = (file, name) => {
  const s = readFileSync(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8');
  const i = s.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  const a = s.indexOf('AS $$', i) + 'AS $$'.length, b = s.indexOf('$$;', a);
  return s.slice(a, b);
};
const md5 = (x) => createHash('md5').update(x).digest('hex');
const F0134 = '0134_reubicar_al_cambiar.sql';
const ESPERADAS = {
  reubicar_reserva: md5(cuerpo(F0134, 'reubicar_reserva')),
  reub_candidatas: md5(cuerpo(F0134, 'reub_candidatas')),
  auxiliar_change_flight: md5(cuerpo(F0134, 'auxiliar_change_flight')),
  hm_bog: md5(cuerpo('0125_ruta_de_julian.sql', 'hm_bog')),
};
const huellasDB = async () => Object.fromEntries((await q(`SELECT p.proname, md5(p.prosrc) h FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = ANY ($1)`, [Object.keys(ESPERADAS)])).map((r) => [r.proname, r.h]));
const huella = async () => one(`SELECT
    (SELECT md5(coalesce(string_agg(to_jsonb(s)::text, ',' ORDER BY id), '')) FROM public.route_stops s) paradas,
    (SELECT md5(coalesce(string_agg(to_jsonb(r)::text, ',' ORDER BY id), '')) FROM public.reservations r) reservas,
    (SELECT md5(coalesce(string_agg(to_jsonb(a)::text, ',' ORDER BY id), '')) FROM public.route_assignments a) vueltas,
    (SELECT count(*)::int FROM public.route_assignments) n_vueltas,
    (SELECT count(*)::int FROM public.notification_outbox) avisos,
    (SELECT count(*)::int FROM public.incidents) eventualidades`);
const hm = (x) => (x ? new Date(x).toLocaleString('es-CO', { timeZone: 'America/Bogota', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '—');

try {
  await c.query('BEGIN');
  if (conPrevias) {
    if (!(await one(`SELECT to_regprocedure('public.ops_alert_recipients_of(uuid)') IS NOT NULL AS ok`)).ok) await c.query(strip('../supabase/migrations/0117_avisos_desde_el_servidor.sql'));
    for (const m of ['0124_carro_del_turno', '0125_ruta_de_julian', '0126_vuelta_delegada', '0128_aviso_vuelta_terminada', '0129_conductor_de_una_vuelta', '0130_corte_de_pedidos', '0131_delegado_con_nombre', '0132_carro_del_plan', '0133_pasajero_sin_cuenta', '0134_reubicar_al_cambiar']) await c.query(strip(`../supabase/migrations/${m}.sql`));
    console.log('  · (ensayo local: 0124–0134 aplicadas dentro de esta misma transacción)');
  }
  // ── 0. Lo que tiene que estar ──
  const base = await one(`SELECT
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='route_assignments' AND column_name='auto_created') c0134,
      to_regprocedure('public.reubicar_reserva(uuid,timestamptz,text)') IS NOT NULL ya`);
  t('la base tiene 0134 (reubicar al cambiar de vuelo)', base.c0134, base);
  if (fallas.length) throw new Error('falta 0134: no se aplica');
  if (base.ya) console.log('  · 0135 ya estaba aplicada: se vuelve a correr (es idempotente).');
  else {
    const hoy = await huellasDB();
    const distintas = Object.keys(ESPERADAS).filter((f) => hoy[f] !== ESPERADAS[f]);
    t('reubicar_reserva, reub_candidatas y auxiliar_change_flight son las de 0134, y hm_bog la de 0125 (nadie las cambió)', distintas.length === 0, distintas.map((f) => `${f}: base ${hoy[f]} ≠ archivo ${ESPERADAS[f]}`).join(' · '));
    if (fallas.length) throw new Error('alguien cambió esas funciones: hay que volver a copiarlas en 0135');
  }

  const antes = await huella();
  await c.query(strip('../supabase/migrations/0135_acomodar_eventualidades.sql'));

  // ── 1. Lo nuevo quedó ──
  const o = await one(`SELECT
      to_regprocedure('public.reubicar_reserva(uuid)') IS NULL vieja_fuera,
      has_function_privilege('authenticated', 'public.reubicar_reserva(uuid,timestamptz,text)', 'EXECUTE') f1,
      has_function_privilege('authenticated', 'public.acomodar_eventualidades(timestamptz)', 'EXECUTE') f2,
      has_function_privilege('authenticated', 'public.reub_rastro(uuid,text,text,jsonb,text,jsonb)', 'EXECUTE') f3,
      has_function_privilege('authenticated', 'public.auxiliar_change_flight(uuid,text,timestamptz,text)', 'EXECUTE') cf,
      (SELECT count(*)::int FROM pg_trigger WHERE tgname = 'tr_reservations_acomodar' AND NOT tgisinternal) tg,
      to_regclass('cron.job') IS NOT NULL hay_cron`);
  t('reubicar_reserva nueva (la de 1 argumento salió); internas cerradas a la app; el cambio de vuelo abierto; trigger al pedir',
    o.vieja_fuera && !o.f1 && !o.f2 && !o.f3 && o.cf && o.tg === 1, o);
  if (o.hay_cron) {
    const job = await one(`SELECT schedule, command FROM cron.job WHERE jobname = 'acomodar-eventualidades'`);
    t('pg_cron: «acomodar-eventualidades» cada 5 min', job && job.schedule === '*/5 * * * *', job);
  }

  // ── 2. Aplicar no mueve nada ──
  const durante = await huella();
  t(`paradas, reservas, las ${antes.n_vueltas} vueltas, avisos y eventualidades: idénticos`, JSON.stringify(antes) === JSON.stringify(durante), { antes, durante });

  // ── 3. Ensayo del primer barrido (SIEMPRE se deshace) ──
  console.log('\n  Lo que haría el primer barrido con los datos de ahora (ensayo, se deshace):');
  const vueltasAntes = Object.fromEntries((await q(`SELECT id, planned_start_at, driver_profile_id, pool FROM public.route_assignments WHERE status IN ('planned','in_progress','draft')`)).map((x) => [x.id, x]));
  const paradasAntes = Object.fromEntries((await q(`SELECT rs.reservation_id rid, rs.route_assignment_id ra FROM public.route_stops rs JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
                                                     WHERE rs.reservation_id IS NOT NULL AND ra.status IN ('planned','in_progress','draft')`)).map((x) => [x.rid, x.ra]));
  const tope = await one(`SELECT (SELECT count(*)::int FROM public.notification_outbox) n`);
  const incAntes = Object.fromEntries((await q(`SELECT id, status::text FROM public.incidents`)).map((x) => [x.id, x.status]));
  await c.query('SAVEPOINT ensayo');
  const r = (await one(`SELECT public.acomodar_eventualidades() r`)).r;
  console.log(`    resultado: ${JSON.stringify(r)}`);
  const nombre = `(SELECT pp.full_name FROM public.driver_profiles dp JOIN public.profiles pp ON pp.id = dp.profile_id WHERE dp.id = %s)`;
  const vDespues = await q(`SELECT ra.id, ra.planned_start_at, ra.driver_profile_id, ra.pool, ra.auto_created, ${nombre.replace('%s', 'ra.driver_profile_id')} conductor
                              FROM public.route_assignments ra WHERE ra.status IN ('planned','in_progress','draft')`);
  for (const v of vDespues) {
    const a = vueltasAntes[v.id];
    if (!a) console.log(`    + vuelta NUEVA ${v.pool ? 'para tomar' : ''} a las ${hm(v.planned_start_at)}`);
    else if (+new Date(a.planned_start_at) !== +new Date(v.planned_start_at) || a.driver_profile_id !== v.driver_profile_id || a.pool !== v.pool)
      console.log(`    ~ vuelta de las ${hm(a.planned_start_at)} → ${hm(v.planned_start_at)}${a.driver_profile_id !== v.driver_profile_id ? ' · ' + (v.conductor || 'PARA TOMAR') : ' · sigue con ' + (v.conductor || 'nadie (para tomar)')}`);
  }
  for (const id of Object.keys(vueltasAntes)) if (!vDespues.some((v) => v.id === id)) console.log(`    − se quita la vuelta de las ${hm(vueltasAntes[id].planned_start_at)} (quedó vacía)`);
  const pDespues = await q(`SELECT rs.reservation_id rid, rs.route_assignment_id ra, p.full_name, ra.planned_start_at FROM public.route_stops rs
                              JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id JOIN public.reservations r ON r.id = rs.reservation_id
                              JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id JOIN public.profiles p ON p.id = ap.profile_id
                             WHERE ra.status IN ('planned','in_progress','draft')`);
  for (const p of pDespues) if (paradasAntes[p.rid] !== p.ra) console.log(`    → ${p.full_name}: ${paradasAntes[p.rid] ? 'cambia de vuelta' : 'entra'} a la de las ${hm(p.planned_start_at)}`);
  const incs = (await q(`SELECT i.id, i.description, i.status::text, i.resolution_notes, p.full_name FROM public.incidents i
                          LEFT JOIN public.reservations r ON r.id = i.reservation_id LEFT JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
                          LEFT JOIN public.profiles p ON p.id = ap.profile_id
                         `)).filter((i) => incAntes[i.id] !== i.status);
  for (const i of incs) console.log(`    · ${i.full_name || '?'} — ${i.status}: ${i.resolution_notes || i.description}`);
  const nAv = (await one(`SELECT count(*)::int n FROM public.notification_outbox`)).n - tope.n;
  console.log(`    avisos que saldrían: ${nAv}`);
  await c.query('ROLLBACK TO SAVEPOINT ensayo');
  t('el ensayo del barrido corrió sin errores (y se deshizo)', r && r.errores === 0, r);
  const tras = await huella();
  t('tras deshacer el ensayo, todo sigue idéntico', JSON.stringify(antes) === JSON.stringify(tras), { antes, tras });

  const fin = aplicar && !fallas.length ? 'COMMIT' : 'ROLLBACK';
  await c.query(fin);
  console.log(fallas.length
    ? `\n✗ ${fallas.length} comprobación(es) fallaron: ${fin}.`
    : `\n✓ Todo bien. ${fin === 'COMMIT' ? 'APLICADA en ' + amb + '. El cron hace el primer barrido en menos de 5 min.' : 'En seco: se deshizo (usa --aplicar).'}`);
} catch (e) {
  try { await c.query('ROLLBACK'); } catch (_) { /* */ }
  console.error('\n✗ Error, se deshizo todo:', e.message, e.where ? '· ' + e.where.split('\n')[0] : '');
  fallas.push('error');
} finally {
  await c.end();
}
process.exit(fallas.length ? 1 : 0);
