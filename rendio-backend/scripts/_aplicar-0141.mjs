// 0141 · Una vuelta que armó el sistema solo NO publica el día.
//
//   DEV:    cd rendio-backend && set -a && source .env.dev && set +a && node scripts/_aplicar-0141.mjs [--aplicar]
//   PRODUCCIÓN (con su OK):
//           cd rendio-backend && set -a && source .env.main && set +a && node scripts/_aplicar-0141.mjs --produccion [--aplicar] [--reanudar]
//
// Todo en UNA transacción; solo con --aplicar (y todo bien) se confirma.
// ANTES exige las huellas md5 de lo que reemplaza (detector de 0127 y
// reubicar_reserva de 0135, iguales en dev y producción el 26-oct 16:30), o que
// ya esté 0141 (se puede volver a correr).
// DESPUÉS, en un SAVEPOINT que siempre se deshace, una pasada de verdad del
// detector y del acomodo con los datos reales: cuántas eventualidades, vueltas y
// avisos saldrían en el momento de reanudar.
// --reanudar (solo producción, el 26-oct quedaron en pausa a mano): vuelve a
// encender el acomodo (cron + disparador «al pedir») y el «no tiene carro» en
// detect-ops-events. Se niega si la pasada de prueba crearía más de 5 cosas.
import pg from 'pg';
import { readFileSync } from 'node:fs';

const DEV = 'lxlphbafhtphulanhzlp', PROD = 'wvuurnfdrrdondrbbkhd';
const prod = process.argv.includes('--produccion');
const aplicar = process.argv.includes('--aplicar');
const reanudar = process.argv.includes('--reanudar');
const ref = process.env.SUPABASE_PROJECT_REF || '';
const esperado = prod ? PROD : DEV;
if (ref !== esperado || !(process.env.SUPABASE_URL || '').includes(esperado)) {
  console.error(`ABORT: se esperaba ${prod ? 'PRODUCCIÓN' : 'dev'} (${esperado}) y se cargó ${ref || '(nada)'}.`); process.exit(2);
}
if (reanudar && !prod) { console.error('ABORT: --reanudar es solo para producción.'); process.exit(2); }
const c = new pg.Client({ host: prod ? 'aws-1-us-west-2.pooler.supabase.com' : 'aws-1-us-east-1.pooler.supabase.com', port: 6543,
  database: 'postgres', user: 'postgres.' + esperado, password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false }, statement_timeout: 120000 });
await c.connect();
const q = async (s, v) => (await c.query(s, v)).rows;
const one = async (s, v) => (await q(s, v))[0];
const amb = prod ? 'PRODUCCIÓN' : 'dev';
console.log(aplicar ? `\n== APLICANDO 0141 en ${amb} ==` : `\n== 0141 EN SECO contra ${amb} (se deshace) ==`);
const fallas = [];
const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); if (!ok) fallas.push(n); };
const strip = (f) => readFileSync(new URL(f, import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const DET = 'public.detect_late_bookings()', RR = 'public.reubicar_reserva(uuid,timestamptz,text)';
const H = { det0127: 'cfd8c22d60b87b40561568fdb6073cbc', rr0135: '5a62cc628808a4aedb03855f42a3e40f' };
const huella = async (sig) => (await one(`SELECT md5(prosrc) h, prosrc FROM pg_proc WHERE oid = to_regprocedure($1)`, [sig])) || {};
const es0141 = (f) => (f.prosrc || '').includes('dia_del_plan') && (f.prosrc || '').includes('auto_created');

await c.query('BEGIN');
try {
  await c.query(`SET LOCAL lock_timeout = '5s'`);
  const d0 = await huella(DET), r0 = await huella(RR);
  console.log(`  detector: ${d0.h === H.det0127 ? '0127' : es0141(d0) ? '0141 (ya estaba)' : 'OTRO ' + d0.h} · reubicar: ${r0.h === H.rr0135 ? '0135' : es0141(r0) ? '0141 (ya estaba)' : 'OTRO ' + r0.h}`);
  if (!(d0.h === H.det0127 || es0141(d0)) || !(r0.h === H.rr0135 || es0141(r0))) throw new Error('alguien cambió el detector o reubicar_reserva: mirar qué antes de pisarlo');

  const antes = await one(`SELECT (SELECT count(*) FROM incidents)::int inc, (SELECT count(*) FROM notification_outbox)::int box,
    (SELECT count(*) FROM route_assignments)::int ra, (SELECT count(*) FROM route_stops)::int rs, (SELECT count(*) FROM reservations)::int res`);
  await c.query(strip('../supabase/migrations/0141_sin_carro_dia_del_plan.sql'));
  const d1 = await huella(DET), r1 = await huella(RR);
  t('detector y reubicar_reserva quedaron con la regla de 0141', es0141(d1) && es0141(r1));
  t('dia_del_plan existe y da el día del plan', (await one(`SELECT public.dia_del_plan('2026-10-26', '2026-10-27T00:00:00-05:00')::text a,
    public.dia_del_plan(NULL, '2026-10-27T00:00:00-05:00')::text b`)).a === '2026-10-26');
  const perm = await one(`SELECT has_function_privilege('authenticated', 'public.dia_del_plan(date, timestamptz)', 'EXECUTE') a,
    has_function_privilege('anon', '${RR}', 'EXECUTE') b, has_function_privilege('authenticated', '${RR}', 'EXECUTE') b2`);
  t('permisos cerrados a anon/authenticated', !perm.a && !perm.b && !perm.b2, perm);
  const desp = await one(`SELECT (SELECT count(*) FROM incidents)::int inc, (SELECT count(*) FROM notification_outbox)::int box,
    (SELECT count(*) FROM route_assignments)::int ra, (SELECT count(*) FROM route_stops)::int rs, (SELECT count(*) FROM reservations)::int res`);
  t('aplicarla no movió nada (eventualidades, avisos, vueltas, paradas, reservas)', JSON.stringify(antes) === JSON.stringify(desp), { antes, desp });

  // Pasada de verdad (siempre se deshace): qué saldría al encender.
  await c.query('SAVEPOINT prueba');
  const ini = await one(`SELECT (SELECT count(*) FROM late_booking_candidates)::int cand`);
  const nDet = (await one(`SELECT public.detect_late_bookings() n`)).n;
  const ac = (await one(`SELECT public.acomodar_eventualidades() r`)).r;
  const fin = await one(`SELECT (SELECT count(*) FROM incidents)::int inc, (SELECT count(*) FROM notification_outbox)::int box,
    (SELECT count(*) FROM route_assignments)::int ra, (SELECT count(*) FROM late_booking_candidates)::int cand`);
  const porDia = await q(`SELECT (r.required_arrival_at AT TIME ZONE 'America/Bogota')::date::text dia, count(*)::int n
    FROM late_booking_candidates lb JOIN reservations r ON r.id = lb.reservation_id GROUP BY 1 ORDER BY 1`);
  await c.query('ROLLBACK TO SAVEPOINT prueba');
  const nuevas = { eventualidades: fin.inc - desp.inc, avisos: fin.box - desp.box, vueltas: fin.ra - desp.ra };
  console.log(`  pasada de prueba: detector abrió ${nDet}; acomodo ${JSON.stringify(ac)}; anotadas ${ini.cand}→${fin.cand} ${JSON.stringify(porDia)}`);
  console.log(`  saldría en total: ${JSON.stringify(nuevas)}`);

  if (reanudar) {
    const grande = nuevas.eventualidades + nuevas.vueltas > 5 || nuevas.avisos > 20;
    t('la pasada de prueba es chica (≤ 5 eventualidades+vueltas, ≤ 20 avisos)', !grande, nuevas);
    if (!grande) {
      const jobs = await q(`SELECT jobid, jobname, active, command FROM cron.job WHERE jobname IN ('acomodar-eventualidades', 'detect-ops-events')`);
      const acom = jobs.find((j) => j.jobname === 'acomodar-eventualidades'), det = jobs.find((j) => j.jobname === 'detect-ops-events');
      await q(`SELECT cron.alter_job($1, active := true)`, [acom.jobid]);
      await q(`SELECT cron.alter_job($1, command := 'SELECT public.detect_ops_events(); SELECT public.detect_late_bookings();')`, [det.jobid]);
      await c.query(`ALTER TABLE public.reservations ENABLE TRIGGER tr_reservations_acomodar`);
      const j2 = await q(`SELECT jobname, active, command FROM cron.job WHERE jobname IN ('acomodar-eventualidades', 'detect-ops-events') ORDER BY jobname`);
      const tg = await one(`SELECT tgenabled FROM pg_trigger WHERE tgname = 'tr_reservations_acomodar'`);
      t('reanudado: acomodo encendido, «no tiene carro» de vuelta en el reloj, disparador «al pedir» encendido',
        j2.every((j) => j.active) && j2.find((j) => j.jobname === 'detect-ops-events').command.includes('detect_late_bookings') && tg.tgenabled === 'O', { j2, tg });
    }
  }
  if (fallas.length || !aplicar) { await c.query('ROLLBACK'); console.log(fallas.length ? `\n✗ ${fallas.length} fallas: NO se aplicó` : '\nEn seco: se deshizo.'); }
  else { await c.query('COMMIT'); console.log(`\nCOMMIT ${new Date().toLocaleTimeString('es-CO', { timeZone: 'America/Bogota' })}`); }
} catch (e) {
  await c.query('ROLLBACK'); console.log('  ✗ ' + e.message + (e.where ? ' · ' + e.where.split('\n')[0] : '')); fallas.push('error');
}
await c.end();
process.exit(fallas.length ? 1 : 0);
