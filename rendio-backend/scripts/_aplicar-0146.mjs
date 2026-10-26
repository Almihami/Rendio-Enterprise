// 0146 · Una llegada con el vuelo atrasado no se vuelve invisible para el
// «no tiene carro».
//
//   DEV:    cd rendio-backend && set -a && source .env.dev && set +a && node scripts/_aplicar-0146.mjs [--aplicar]
//   PRODUCCIÓN (con su OK y respaldo en carpeta NUEVA antes):
//           cd rendio-backend && set -a && source .env.main && set +a && node scripts/_aplicar-0146.mjs --produccion [--aplicar]
//
// Todo en UNA transacción; solo con --aplicar (y todo bien) se confirma.
// ANTES exige la huella md5 del detector de 0143 (dev y producción el 26-oct;
// 0144 no lo toca), o que ya esté 0146, y que existan reub_baja/hm_bog (0135) y
// dia_madrugada (0143).
// DESPUÉS, en SAVEPOINTs que siempre se deshacen, con los datos reales:
//   · quiénes quedan anotados «sin carro» con el detector de antes y con 0146
//     (los que aparecen solo con 0146 son las llegadas que antes eran invisibles);
//   · la pasada siguiente (5 min después): cuántas alertas se abrirían, cuántas
//     push y cuántas alertas abiertas se cerrarían solas. Nada de eso se manda:
//     la bandeja y pg_net solo envían lo confirmado.
import pg from 'pg';
import { readFileSync } from 'node:fs';

const DEV = 'lxlphbafhtphulanhzlp', PROD = 'wvuurnfdrrdondrbbkhd';
const prod = process.argv.includes('--produccion');
const aplicar = process.argv.includes('--aplicar');
const ref = process.env.SUPABASE_PROJECT_REF || '';
const esperado = prod ? PROD : DEV;
if (ref !== esperado || !(process.env.SUPABASE_URL || '').includes(esperado)) {
  console.error(`ABORT: se esperaba ${prod ? 'PRODUCCIÓN' : 'dev'} (${esperado}) y se cargó ${ref || '(nada)'}.`); process.exit(2);
}
const c = new pg.Client({ host: prod ? 'aws-1-us-west-2.pooler.supabase.com' : 'aws-1-us-east-1.pooler.supabase.com', port: 6543,
  database: 'postgres', user: 'postgres.' + esperado, password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false }, statement_timeout: 120000 });
await c.connect();
const q = async (s, v) => (await c.query(s, v)).rows;
const one = async (s, v) => (await q(s, v))[0];
const amb = prod ? 'PRODUCCIÓN' : 'dev';
console.log(aplicar ? `\n== APLICANDO 0146 en ${amb} ==` : `\n== 0146 EN SECO contra ${amb} (se deshace) ==`);
const fallas = [];
const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); if (!ok) fallas.push(n); };
const strip = (f) => readFileSync(new URL(f, import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const DET = 'public.detect_late_bookings()';
const H0143 = '4168e00fa1cfd7b4dc15b2360b9c370b';   // el detector de 0143 (dev y producción, 26-oct)
const huella = async (sig) => (await one(`SELECT md5(prosrc) h, prosrc FROM pg_proc WHERE oid = to_regprocedure($1)`, [sig])) || {};
const es0146 = (f) => (f.prosrc || '').includes('0146');

const anotados = async () => q(`SELECT lb.reservation_id id, split_part(p.full_name, ' ', 1) || ' ' || split_part(p.full_name, ' ', 2) quien,
    to_char(r.required_arrival_at AT TIME ZONE 'America/Bogota', 'MM-DD HH24:MI') hora, r.direction::text dir, r.flight_code vuelo,
    to_char(public.reub_baja(p.organization_id, r.flight_code, r.required_arrival_at) AT TIME ZONE 'America/Bogota', 'HH24:MI') fr24
  FROM late_booking_candidates lb JOIN reservations r ON r.id = lb.reservation_id
  JOIN auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id JOIN profiles p ON p.id = ap.profile_id ORDER BY r.required_arrival_at`);
// Una pasada ahora y la siguiente «5 min después» (lo anotado envejece 10 min; las vueltas no se tocan).
const dosPasadas = async () => {
  await c.query('SAVEPOINT prueba');
  try {
    const box0 = (await one(`SELECT count(*)::int n FROM notification_outbox`)).n;
    const abiertas0 = await q(`SELECT id FROM incidents WHERE category = 'late_booking' AND resolved_at IS NULL`);
    await q(`SELECT public.detect_late_bookings()`);
    const lista = await anotados();
    await q(`UPDATE late_booking_candidates SET created_at = created_at - interval '10 minutes'`);
    const abiertas = (await one(`SELECT public.detect_late_bookings() n`)).n;
    const push = (await one(`SELECT count(*)::int n FROM notification_outbox`)).n - box0;
    const textos = await q(`SELECT description d FROM incidents WHERE category = 'late_booking' AND created_at = now() ORDER BY description`);
    const cerradas = await q(`SELECT i.resolution_notes nota FROM incidents i WHERE i.id = ANY ($1::uuid[]) AND i.resolved_at IS NOT NULL`, [abiertas0.map((x) => x.id)]);
    return { lista, abiertas, push, textos, cerradas, abiertasAntes: abiertas0.length };
  } finally { await c.query('ROLLBACK TO SAVEPOINT prueba'); }
};
const muestra = (titulo, r) => {
  console.log(`  ${titulo}: ${r.lista.length} anotados «sin carro»; la pasada siguiente abriría ${r.abiertas} alerta(s) (${r.push} push) y cerraría ${r.cerradas.length} de ${r.abiertasAntes} abiertas`);
  for (const a of r.lista) console.log(`    · ${a.quien} · ${a.hora} · ${a.dir}${a.vuelo ? ' · ' + a.vuelo : ''}${a.fr24 ? ' · FR24 ' + a.fr24 : ''}`);
  for (const x of r.textos) console.log(`    » ${x.d}`);
  for (const x of r.cerradas) console.log(`    ✓ cerraría: ${x.nota}`);
};

// Fuera de la transacción: si cron no se deja leer, no la deja abortada.
const cron = await q(`SELECT jobname, schedule, active FROM cron.job WHERE command ILIKE '%detect_late_bookings%'`).catch(() => null);
console.log(`  pg_cron que corre el detector: ${cron === null ? '(no se pudo leer cron.job)' : cron.length ? cron.map((j) => `${j.jobname} (${j.schedule}${j.active ? '' : ', EN PAUSA'})`).join(', ') : 'NINGUNO (el detector no está corriendo solo)'}`);

await c.query('BEGIN');
try {
  await c.query(`SET LOCAL lock_timeout = '5s'`);
  const h0 = await huella(DET);
  console.log(`  detector: ${h0.h === H0143 ? 'el de 0143 (el de hoy)' : es0146(h0) ? '0146 (ya estaba)' : 'OTRO ' + h0.h}`);
  if (h0.h !== H0143 && !es0146(h0)) throw new Error('alguien cambió detect_late_bookings: mirar qué antes de pisarlo (copiar desde la versión nueva)');
  const req = await one(`SELECT to_regprocedure('public.reub_baja(uuid,text,timestamptz)') IS NOT NULL rb, to_regprocedure('public.hm_bog(timestamptz)') IS NOT NULL hm,
    to_regprocedure('public.dia_madrugada(timestamptz)') IS NOT NULL dm, to_regprocedure('public.dia_del_plan(date,timestamptz)') IS NOT NULL dp,
    to_regprocedure('public.hora_que_importa(uuid)') IS NULL OR $1 AS hq`, [es0146(h0)]);
  t('están reub_baja y hm_bog (0135), dia_madrugada (0143), dia_del_plan (0141); hora_que_importa no existe todavía', Object.values(req).every(Boolean), req);

  const viejo = es0146(h0) ? null : await dosPasadas();
  if (viejo) muestra('con el detector de HOY (0143)', viejo);

  const antes = await one(`SELECT (SELECT count(*) FROM incidents)::int inc, (SELECT count(*) FROM notification_outbox)::int box,
    (SELECT count(*) FROM route_assignments)::int ra, (SELECT count(*) FROM route_stops)::int rs, (SELECT count(*) FROM reservations)::int res,
    (SELECT count(*) FROM late_booking_candidates)::int lb`);
  await c.query(strip('../supabase/migrations/0146_llegada_atrasada_sin_carro.sql'));
  const h1 = await huella(DET);
  t('el detector quedó con 0146', es0146(h1), h1.h);
  const perm = await one(`SELECT has_function_privilege('authenticated', 'public.hora_que_importa(uuid)', 'EXECUTE') a,
    has_function_privilege('anon', 'public.hora_que_importa(uuid)', 'EXECUTE') b, has_function_privilege('authenticated', '${DET}', 'EXECUTE') d`);
  t('permisos: hora_que_importa y el detector cerrados para la app', !perm.a && !perm.b && !perm.d, perm);
  const desp = await one(`SELECT (SELECT count(*) FROM incidents)::int inc, (SELECT count(*) FROM notification_outbox)::int box,
    (SELECT count(*) FROM route_assignments)::int ra, (SELECT count(*) FROM route_stops)::int rs, (SELECT count(*) FROM reservations)::int res,
    (SELECT count(*) FROM late_booking_candidates)::int lb`);
  t('aplicarla no movió nada (eventualidades, avisos, vueltas, paradas, reservas, anotados)', JSON.stringify(antes) === JSON.stringify(desp), { antes, desp });

  const nuevo = await dosPasadas();
  muestra('con 0146', nuevo);
  if (viejo) {
    const ids = new Set(viejo.lista.map((a) => a.id));
    const solo = nuevo.lista.filter((a) => !ids.has(a.id));
    console.log(`  aparecen SOLO con 0146 (llegadas que antes eran invisibles): ${solo.length}`);
    for (const a of solo) console.log(`    · ${a.quien} · ${a.hora}${a.vuelo ? ' · ' + a.vuelo : ''}${a.fr24 ? ' · FR24 ' + a.fr24 : ''}`);
    const nids = new Set(nuevo.lista.map((a) => a.id));
    t('nadie que el detector de hoy anota deja de anotarse con 0146', viejo.lista.every((a) => nids.has(a.id)), viejo.lista.filter((a) => !nids.has(a.id)));
  }
  t('no es una tormenta (≤ 4 alertas nuevas en la pasada siguiente)', nuevo.abiertas <= 4, nuevo.abiertas);
  if (fallas.length || !aplicar) { await c.query('ROLLBACK'); console.log(fallas.length ? `\n✗ ${fallas.length} fallas: NO se aplicó` : '\nEn seco: se deshizo.'); }
  else { await c.query('COMMIT'); console.log(`\nCOMMIT ${new Date().toLocaleTimeString('es-CO', { timeZone: 'America/Bogota' })}`); }
} catch (e) {
  await c.query('ROLLBACK'); console.log('  ✗ ' + e.message + (e.where ? ' · ' + e.where.split('\n')[0] : '')); fallas.push('error');
}
await c.end();
process.exit(fallas.length ? 1 : 0);
