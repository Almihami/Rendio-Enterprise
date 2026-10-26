// 0137–0140 · Pendientes de los jefes del 26-oct: vueltas terminadas fuera de la lista
// (0137), «Vueltas para tomar» (0138), externos sin app (0139), entrega de turno (0140).
//
//   LOCAL:  node scripts/_aplicar-0137-0140.mjs --local [--aplicar]
//   DEV:    cd rendio-backend && set -a && source .env.dev && set +a && node scripts/_aplicar-0137-0140.mjs [--aplicar]
//   PRODUCCIÓN (con su OK, después del respaldo en una carpeta NUEVA):
//           cd rendio-backend && set -a && source .env.main && set +a && node scripts/_aplicar-0137-0140.mjs --produccion [--aplicar]
//   REVERSA: … --reversa [--aplicar]   (corre los down en orden inverso; OJO: 0140 borra
//            shift_handovers; 0139 NO borra los externos creados ni sus reservas)
//
// Todo en UNA transacción; solo con --aplicar (y todo bien) se confirma.
//
// ANTES comprueba:
//   · las previas: 0097 (trip_notify), 0107, 0117 (ops_alert_recipients_of), 0119
//     (welcome_seen_at), 0124/0132 (plan_car, plan_vehicle_id), 0125 (hm_bog), 0126,
//     0130 (hm12_bog), 0133 (guest_name), 0135 (reub_extremos, reub_conductor_libre);
//   · que driver_open_routes y driver_take_route (las que reemplaza 0138) son EXACTAMENTE
//     las de 0126: se aplica el bloque de 0126 en un punto de guardado, se mide su
//     huella y se deshace. Si alguien las cambió después, no aplica;
//   · que la base deja crear la cuenta de un externo (INSERT en auth.users, 0139), en
//     un punto de guardado que se deshace.
// DESPUÉS comprueba que aplicar no mueve nada (paradas, reservas, vueltas, avisos,
// tripulantes, cobro iguales), que existen las funciones, los dos relojes y la tabla,
// y cuántas entregas de turno saldrían hoy.
// La app que lo usa es la v223: aplicar esto ANTES de publicar la app (si la app llega
// primero, cae a lo de siempre: 10/30 min por defecto, sin «Nuevo pedido» ni entregas).
import pg from 'pg';
import { readFileSync } from 'node:fs';

const DEV = 'lxlphbafhtphulanhzlp', PROD = 'wvuurnfdrrdondrbbkhd';
const local = process.argv.includes('--local');
const prod = process.argv.includes('--produccion');
const aplicar = process.argv.includes('--aplicar');
const reversa = process.argv.includes('--reversa');
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
const que = reversa ? 'la REVERSA de 0137–0140' : '0137–0140';
console.log(aplicar ? `\n== APLICANDO ${que} en ${amb} ==` : `\n== ${que} EN SECO contra ${amb} (se deshace) ==`);
const fallas = [];
const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); if (!ok) fallas.push(n); };
const strip = (f) => readFileSync(new URL(f, import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const MIG = ['0137_vueltas_terminadas', '0138_vueltas_para_tomar', '0139_externos_sin_app', '0140_entrega_de_turno'];
const huellaFn = async (fn) => (await one(`SELECT md5(p.prosrc) h FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1`, [fn])).h;
// Los bloques de 0126 de las dos funciones que reemplaza 0138.
const de0126 = (() => {
  const s = readFileSync(new URL('../supabase/migrations/0126_vuelta_delegada.sql', import.meta.url), 'utf8');
  const corta = (ini) => { const i = s.indexOf(ini); const j = s.indexOf('\n$$;', i); return s.slice(i, j + 4); };
  return corta('CREATE OR REPLACE FUNCTION public.driver_open_routes()') + '\n' + corta('CREATE OR REPLACE FUNCTION public.driver_take_route(p_route uuid)');
})();
const foto = async () => one(`SELECT
    (SELECT md5(coalesce(string_agg(to_jsonb(s)::text, ',' ORDER BY id), '')) FROM public.route_stops s) paradas,
    (SELECT md5(coalesce(string_agg(to_jsonb(r)::text, ',' ORDER BY id), '')) FROM public.reservations r) reservas,
    (SELECT md5(coalesce(string_agg(to_jsonb(a)::text, ',' ORDER BY id), '')) FROM public.route_assignments a) vueltas,
    (SELECT count(*)::int FROM public.auxiliar_profiles) tripulantes,
    (SELECT count(*)::int FROM public.auxiliar_billing) cuentas,
    (SELECT count(*)::int FROM public.notification_outbox) avisos`);

try {
  await c.query('BEGIN');
  // Solo para probar este script en la base LOCAL (que no tiene 0124–0136): las pone
  // dentro de la misma transacción, que sin --aplicar se deshace.
  if (local && process.argv.includes('--con-cadena')) { const { cadenaHasta0136 } = await import('./_local-cadena-0136.mjs'); await cadenaHasta0136(c); }
  if (reversa) {
    for (const m of MIG.slice().reverse()) { await c.query(strip(`../down_migrations/${m}.down.sql`)); t(`reversa de ${m}`, true); }
    const quedan = await one(`SELECT to_regprocedure('public.route_unmarked_reminders(timestamptz)') a, to_regclass('public.shift_handovers') b,
        to_regprocedure('public.admin_create_external(text,text,uuid,text)') c2,
        (SELECT count(*)::int FROM cron.job WHERE jobname IN ('route-unmarked-reminders', 'handover-alerts')) jobs`);
    t('no queda nada de 0137–0140', !quedan.a && !quedan.b && !quedan.c2 && quedan.jobs === 0, quedan);
  } else {
    const base = await one(`SELECT
        to_regprocedure('public.trip_notify(uuid,text,text,text,text)') IS NOT NULL r0097,
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='app_settings' AND column_name='route_night_cutoff_min') r0107,
        to_regprocedure('public.ops_alert_recipients_of(uuid)') IS NOT NULL r0117,
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND column_name='welcome_seen_at') r0119,
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='route_assignments' AND column_name='plan_car') r0124,
        to_regprocedure('public.hm_bog(timestamptz)') IS NOT NULL AND to_regprocedure('public.short_name(text)') IS NOT NULL r0125,
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='route_assignments' AND column_name='delegated_at') r0126,
        to_regprocedure('public.hm12_bog(integer)') IS NOT NULL r0130,
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='route_assignments' AND column_name='plan_vehicle_id') r0132,
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='route_stops' AND column_name='guest_name') r0133,
        to_regprocedure('public.reub_conductor_libre(uuid,uuid,uuid,timestamptz,uuid,double precision,double precision,boolean,timestamptz,uuid,double precision,double precision,boolean)') IS NOT NULL r0135`);
    Object.entries(base).forEach(([k, v]) => t(`${k.slice(1)} aplicada`, v === true));
    if (fallas.length) throw new Error('faltan migraciones previas');

    // driver_open_routes / driver_take_route deben ser las de 0126.
    const h = { o: await huellaFn('driver_open_routes'), t: await huellaFn('driver_take_route') };
    await c.query('SAVEPOINT sp_h'); await c.query(de0126);
    const h26 = { o: await huellaFn('driver_open_routes'), t: await huellaFn('driver_take_route') };
    await c.query('ROLLBACK TO SAVEPOINT sp_h');
    t('driver_open_routes y driver_take_route son EXACTAMENTE las de 0126', h.o === h26.o && h.t === h26.t, { h, h26 });
    // ¿Se puede crear la cuenta de un externo? (0139 escribe en auth.users)
    await c.query('SAVEPOINT sp_a');
    try {
      await c.query(`INSERT INTO auth.users (id, instance_id, aud, role, email, banned_until, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
        VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'prueba.aplicar.' || md5(random()::text) || '@sin-app.invalid', 'infinity', '{}', '{}', now(), now())`);
      t('la base deja crear la cuenta de un externo (auth.users)', true);
    } catch (e) { t('la base deja crear la cuenta de un externo (auth.users)', false, e.message); }
    await c.query('ROLLBACK TO SAVEPOINT sp_a');
    if (fallas.length) throw new Error('las comprobaciones previas fallaron');

    const antes = await foto();
    for (const m of MIG) await c.query(strip(`../supabase/migrations/${m}.sql`));
    const despues = await foto();
    t('aplicar no mueve paradas, reservas, vueltas, tripulantes, cuentas ni avisos', JSON.stringify(antes) === JSON.stringify(despues), { antes, despues });
    const ok = await one(`SELECT
        (SELECT route_done_hide_min FROM public.app_settings WHERE id = 'singleton') hide,
        (SELECT route_unmarked_min FROM public.app_settings WHERE id = 'singleton') unmarked,
        (SELECT handover_lead_min FROM public.app_settings WHERE id = 'singleton') lead,
        to_regclass('public.shift_handovers') IS NOT NULL tabla,
        (SELECT count(*)::int FROM cron.job WHERE jobname IN ('route-unmarked-reminders', 'handover-alerts')) jobs,
        has_function_privilege('authenticated', 'public.admin_create_external(text,text,uuid,text)', 'EXECUTE') ext,
        has_function_privilege('anon', 'public.admin_create_external(text,text,uuid,text)', 'EXECUTE') ext_anon,
        has_function_privilege('authenticated', 'public.handover_alerts(timestamptz)', 'EXECUTE') alertas,
        has_function_privilege('authenticated', 'public.driver_my_handovers(timestamptz)', 'EXECUTE') mias,
        (SELECT count(*)::int FROM public.auxiliar_profiles WHERE external) externos`);
    t('ajustes 10 / 30 / 120', ok.hide === 10 && ok.unmarked === 30 && ok.lead === 120, ok);
    t('tabla shift_handovers y los dos relojes (route-unmarked-reminders, handover-alerts)', ok.tabla && ok.jobs === 2, ok);
    t('la app llama admin_create_external y driver_my_handovers (anon no); los relojes no', ok.ext && !ok.ext_anon && ok.mias && !ok.alertas, ok);
    t('nadie queda marcado como externo al aplicar', ok.externos === 0, ok);
    const hoy = await q(`SELECT o.name, x.band, count(*) FILTER (WHERE NOT x.sigue)::int entregas, count(*) FILTER (WHERE x.sigue)::int siguen,
        count(*) FILTER (WHERE NOT x.sigue AND x.to_profile IS NULL)::int sin_definir
      FROM public.organizations o CROSS JOIN LATERAL public.handover_effective(o.id, public.handover_op_day(now())) x GROUP BY 1, 2 ORDER BY 1, 2`);
    console.log('  · entregas de turno de hoy:', hoy.length ? hoy.map((r) => `${r.name} ${r.band}: ${r.entregas} (${r.sin_definir} sin definir), ${r.siguen} siguen`).join(' · ') : 'ninguna (sin vueltas publicadas con conductor hoy)');
    const sm = await one(`SELECT count(*)::int n FROM public.route_assignments ra
       WHERE ra.status IN ('planned', 'in_progress') AND ra.driver_profile_id IS NOT NULL AND ra.delegated_at IS NULL
         AND ra.planned_start_at BETWEEN now() - interval '12 hours' AND now()
         AND public.route_expected_end(ra.id) + interval '10 minutes' < now() AND public.route_expected_end(ra.id) > now() - interval '6 hours'
         AND EXISTS (SELECT 1 FROM public.route_stops rs WHERE rs.route_assignment_id = ra.id AND coalesce(rs.status, 'pending') NOT IN ('delivered', 'no_show'))`);
    console.log(`  · al encender el reloj, ${sm.n} ${sm.n === 1 ? 'conductor recibiría' : 'conductores recibirían'} «¿Ya terminaste la vuelta…?» (vueltas de las últimas 6 h sin marcar)`);
  }
  if (fallas.length) throw new Error('verificación con fallas');
  if (aplicar) { await c.query('COMMIT'); console.log(`\n✓ ${que} APLICADA en ${amb}`); }
  else { await c.query('ROLLBACK'); console.log(`\n✓ en seco OK (nada quedó en ${amb}); para aplicar: --aplicar`); }
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error(`\n✗ NO se aplicó: ${e.message}${fallas.length ? ' · ' + fallas.join(' | ') : ''}`);
  process.exitCode = 1;
} finally {
  await c.end();
}
