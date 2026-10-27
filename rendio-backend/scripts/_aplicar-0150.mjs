// 0150 · «No tiene carro»: los de una misma pasada del detector salen en UNA
// notificación por jefe (antes, una por persona y por jefe).
//
//   DEV:        cd rendio-backend && set -a && source <.env.dev> && set +a && node scripts/_aplicar-0150.mjs [--aplicar]
//   PRODUCCIÓN: cd rendio-backend && set -a && source <.env.main> && set +a && node scripts/_aplicar-0150.mjs --produccion [--aplicar]
//
// Todo en UNA transacción; solo con --aplicar (y todo bien) se confirma.
// ANTES: detect_late_bookings es EXACTAMENTE la de 0146 (huella del cuerpo).
// DESPUÉS: el detector lleva «0150», late_bookings_alert existe y, probado dentro
// de la transacción (se deshace siempre la prueba): dos sin carro → UNA notificación
// por jefe con los dos nombres; uno solo → el aviso de siempre (inc:); y el detector
// corre sin error.
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const DEV = 'lxlphbafhtphulanhzlp', PROD = 'wvuurnfdrrdondrbbkhd';
const prod = process.argv.includes('--produccion');
const aplicar = process.argv.includes('--aplicar');
const ref = process.env.SUPABASE_PROJECT_REF || '';
const esperado = prod ? PROD : DEV;
if (ref !== esperado || !(process.env.SUPABASE_URL || '').includes(esperado)) {
  console.error(`ABORT: se esperaba ${prod ? 'PRODUCCIÓN' : 'dev'} (${esperado}) y se cargó ${ref || '(nada)'}.`); process.exit(2);
}
const c = new pg.Client({ host: prod ? 'aws-1-us-west-2.pooler.supabase.com' : 'aws-1-us-east-1.pooler.supabase.com', port: 5432,
  database: 'postgres', user: 'postgres.' + esperado, password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false }, statement_timeout: 60000 });
await c.connect();
const q = async (s, v) => (await c.query(s, v)).rows;
const one = async (s, v) => (await q(s, v))[0];
const amb = prod ? 'PRODUCCIÓN' : 'dev';
console.log(aplicar ? `\n== APLICANDO 0150 en ${amb} ==` : `\n== 0150 EN SECO contra ${amb} (se deshace) ==`);
const fallas = [];
const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); if (!ok) fallas.push(n); };
const leer = (f) => readFileSync(new URL('../supabase/migrations/' + f, import.meta.url), 'utf8');
const cuerpo = (src, firma) => { const i = src.indexOf(firma); const a = src.indexOf('AS $$', i) + 5; return src.slice(a, src.indexOf('$$;', a)); };
const md5 = (s) => createHash('md5').update(s).digest('hex');
const detector = () => one(`SELECT prosrc FROM pg_proc WHERE proname = 'detect_late_bookings' AND pronamespace = 'public'::regnamespace`);
const sql = leer('0150_sin_carro_agrupado.sql').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');

await c.query('BEGIN');
try {
  await c.query(`SET LOCAL lock_timeout = '5s'`);
  const d0 = await detector();
  const esp = md5(cuerpo(leer('0146_llegada_atrasada_sin_carro.sql'), 'CREATE OR REPLACE FUNCTION public.detect_late_bookings()'));
  const ya = d0 && /0150/.test(d0.prosrc);
  t(`detect_late_bookings es la de 0146${ya ? ' (o ya la de 0150)' : ''}`, !!d0 && (ya || md5(d0.prosrc) === esp), d0 ? md5(d0.prosrc) + ' ≠ ' + esp : 'no existe');
  if (fallas.length) throw new Error('el detector no es el que se copió: NO se toca');

  await c.query(sql);

  t('el detector lleva la guarda 0150', /0150/.test((await detector()).prosrc));
  const f = await one(`SELECT prosecdef FROM pg_proc WHERE proname = 'late_bookings_alert' AND pronamespace = 'public'::regnamespace`);
  t('late_bookings_alert existe (SECURITY DEFINER)', f && f.prosecdef === true);

  // La prueba, dentro de un SAVEPOINT que se deshace siempre.
  await c.query('SAVEPOINT p');
  const rs = await q(`SELECT r.id, pr.organization_id org FROM public.reservations r
      JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id JOIN public.profiles pr ON pr.id = ap.profile_id
     WHERE r.cancelled_at IS NULL ORDER BY r.created_at DESC LIMIT 3`);
  const org = rs[0] && rs[0].org;
  const jefes = org ? (await one(`SELECT count(*)::int n FROM public.ops_alert_recipients_of($1)`, [org])).n : 0;
  if (rs.length < 3 || !jefes) console.log('  · (sin reservas o jefes para probar el aviso agrupado)');
  else {
    const abrir = async (rid) => (await one(`INSERT INTO public.incidents (organization_id, reservation_id, category, severity, status, description, scope, source, dedupe_key, occurred_at)
      VALUES ($1, $2::uuid, 'late_booking', 'high', 'open', 'prueba 0150 (se deshace)', 'operacion', 'system', $3, now()) RETURNING id`, [org, rid, 'prueba0150:' + rid])).id;
    const a = await abrir(rs[0].id), b = await abrir(rs[1].id);
    const n2 = await one(`SELECT public.late_bookings_alert(ARRAY[$1, $2]::uuid[]) n`, [a, b]);
    const g = await q(`SELECT title, body FROM public.notification_outbox WHERE dedupe_key LIKE 'lategrp:%' AND created_at = now()`);
    t(`dos sin carro: UNA notificación por jefe (${jefes}), «🚨 2 tripulantes no tienen carro»`, g.length === jefes && g.every((x) => x.title === '🚨 2 tripulantes no tienen carro'), g);
    t('…que trae los dos (nombre y hora) y lleva a Asignación', g.length > 0 && (g[0].body.match(/\((llega|sale) \d/g) || []).length === 2, g[0] && g[0].body);
    t('…y no salió el aviso de cada uno por separado', (await one(`SELECT count(*)::int n FROM public.notification_outbox WHERE incident_id IN ($1, $2)`, [a, b])).n === 0);
    t('…las dos eventualidades quedan selladas (notified_at)', (await one(`SELECT count(*)::int n FROM public.incidents WHERE id IN ($1, $2) AND notified_at IS NOT NULL`, [a, b])).n === 2);
    t('devuelve a cuántos jefes avisó', n2.n === jefes, n2);
    const u = await abrir(rs[2].id);
    await c.query(`SELECT public.late_bookings_alert(ARRAY[$1]::uuid[])`, [u]);
    t('uno solo: el aviso de siempre (inc:…) a cada jefe', (await one(`SELECT count(*)::int n FROM public.notification_outbox WHERE incident_id = $1 AND dedupe_key LIKE 'inc:%'`, [u])).n === jefes);
  }
  const corrida = await one(`SELECT public.detect_late_bookings() n`);
  t('el detector corre sin error', corrida && corrida.n != null, corrida);
  await c.query('ROLLBACK TO SAVEPOINT p');

  if (fallas.length) throw new Error(`${fallas.length} comprobación(es) en rojo`);
  if (!aplicar) { await c.query('ROLLBACK'); console.log('\n  EN SECO: todo en verde y DESHECHO. Para confirmarlo: --aplicar'); await c.end(); process.exit(0); }
  await c.query('COMMIT');
  console.log('  ✓ COMMIT ' + new Date().toLocaleTimeString('es-CO', { timeZone: 'America/Bogota' }));
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error(`\n  ✗ NO SE APLICÓ (se deshizo todo): ${e.message}`); await c.end(); process.exit(1);
}
await c.end();
process.exit(0);
