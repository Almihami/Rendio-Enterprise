// 0170 · «Inició / terminó una vuelta» también a los compañeros de turno.
//   cd rendio-backend && set -a && source <.env.dev|.env.main> && set +a && node scripts/_aplicar-0170.mjs [--produccion] [--aplicar]
// Sin --aplicar: EN SECO (ROLLBACK). La prueba marca una vuelta real y SIEMPRE se deshace (savepoint): no sale ningún aviso.
import pg from 'pg';
import { readFileSync } from 'node:fs';
const DEV = 'lxlphbafhtphulanhzlp', PROD = 'wvuurnfdrrdondrbbkhd';
const prod = process.argv.includes('--produccion'), aplicar = process.argv.includes('--aplicar');
const esperado = prod ? PROD : DEV;
if ((process.env.SUPABASE_PROJECT_REF || '') !== esperado || !(process.env.SUPABASE_URL || '').includes(esperado)) { console.error('ABORT: ambiente equivocado'); process.exit(2); }
const c = new pg.Client({ host: prod ? 'aws-1-us-west-2.pooler.supabase.com' : 'aws-1-us-east-1.pooler.supabase.com', port: 5432, database: 'postgres', user: 'postgres.' + esperado, password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false } });
await c.connect();
const q = async (s, v) => (await c.query(s, v)).rows, one = async (s, v) => (await q(s, v))[0];
const fallas = []; const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + JSON.stringify(d).slice(0, 400) : ''}`); if (!ok) fallas.push(n); };
const sql = readFileSync(new URL('../supabase/migrations/0170_aviso_inicio_fin_companeros.sql', import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const def = async (n) => (await one(`SELECT pg_get_functiondef(p.oid) d FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $1`, [n]))?.d || '';
console.log(`\n== 0170 ${aplicar ? 'APLICANDO' : 'EN SECO'} en ${prod ? 'PRODUCCIÓN' : 'dev'} ==`);
await c.query('BEGIN');
try {
  await c.query(`SET LOCAL lock_timeout = '5s'`);
  const a0 = await def('route_started_alert_enqueue'), b0 = await def('route_finished_alert');
  t('las dos funciones son las de antes (sin compañeros)', /inició una vuelta/.test(a0) && /terminó una vuelta/.test(b0) && !/conductores_del_turno/.test(a0) && !/conductores_del_turno/.test(b0));
  t('está conductores_del_turno', !!(await one(`SELECT 1 x FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'conductores_del_turno'`)));
  if (fallas.length) throw new Error('la base no está como se esperaba');
  await c.query(sql);
  t('quedaron con el lazo de compañeros y siguen avisando a los jefes', /conductores_del_turno/.test(await def('route_started_alert_enqueue')) && /conductores_del_turno/.test(await def('route_finished_alert')) && /ops_alert_recipients_of/.test(await def('route_started_alert_enqueue')) && /ops_alert_recipients_of/.test(await def('route_finished_alert')));
  await c.query('SAVEPOINT prueba');
  // Una vuelta sin arrancar, de UNA persona, con conductor, y con algún compañero en turno ahora.
  let v = await one(`SELECT ra.id, dp.profile_id drv, pd.organization_id org, (SELECT rs.id FROM public.route_stops rs WHERE rs.route_assignment_id = ra.id LIMIT 1) stop
      FROM public.route_assignments ra JOIN public.driver_profiles dp ON dp.id = ra.driver_profile_id JOIN public.profiles pd ON pd.id = dp.profile_id
     WHERE ra.status = 'planned' AND ra.planned_start_at > now() - interval '2 hours'
       AND (SELECT count(*) FROM public.route_stops rs LEFT JOIN public.reservations r ON r.id = rs.reservation_id WHERE rs.route_assignment_id = ra.id AND (r.id IS NULL OR r.cancelled_at IS NULL)) = 1
       AND NOT EXISTS (SELECT 1 FROM public.route_stops rs WHERE rs.route_assignment_id = ra.id AND rs.status <> 'pending')
     ORDER BY ra.planned_start_at LIMIT 1`);
  if (!v) {
    // No hay ninguna con conductor: dentro del savepoint se le pone uno a una pendiente de una persona (se deshace).
    const libre = await one(`SELECT ra.id, (SELECT rs.id FROM public.route_stops rs WHERE rs.route_assignment_id = ra.id LIMIT 1) stop,
          coalesce(ra.organization_id, (SELECT yp.organization_id FROM public.route_stops x JOIN public.reservations y ON y.id = x.reservation_id JOIN public.auxiliar_profiles ya ON ya.id = y.auxiliar_profile_id JOIN public.profiles yp ON yp.id = ya.profile_id WHERE x.route_assignment_id = ra.id LIMIT 1)) org
        FROM public.route_assignments ra
       WHERE ra.status = 'planned' AND ra.driver_profile_id IS NULL AND ra.delegated_at IS NULL AND ra.planned_start_at > now()
         AND (SELECT count(*) FROM public.route_stops rs LEFT JOIN public.reservations r ON r.id = rs.reservation_id WHERE rs.route_assignment_id = ra.id AND (r.id IS NULL OR r.cancelled_at IS NULL)) = 1
         AND NOT EXISTS (SELECT 1 FROM public.route_stops rs WHERE rs.route_assignment_id = ra.id AND rs.status <> 'pending')
       ORDER BY ra.planned_start_at LIMIT 1`);
    const d = libre && libre.org ? await one(`SELECT dp.id dp, p.id prof FROM public.profiles p JOIN public.driver_profiles dp ON dp.profile_id = p.id
        WHERE p.organization_id = $1 AND p.role = 'driver' AND p.deleted_at IS NULL ORDER BY (p.id IN (SELECT profile_id FROM public.conductores_del_turno($1, now()))) DESC LIMIT 1`, [libre.org]) : null;
    if (libre && d) { await c.query(`UPDATE public.route_assignments SET driver_profile_id = $2 WHERE id = $1`, [libre.id, d.dp]); v = { id: libre.id, drv: d.prof, org: libre.org, stop: libre.stop }; console.log('  · (para la prueba, dentro de lo que no se guarda, se le puso conductor a una vuelta pendiente)'); }
  }
  if (!v) console.log('  · no hay una vuelta de una persona sin arrancar para probar');
  else {
    const comp = (await q(`SELECT c.profile_id FROM public.conductores_del_turno($1, now()) c WHERE c.profile_id <> $2`, [v.org, v.drv])).map((x) => x.profile_id);
    const jefes = (await q(`SELECT profile_id FROM public.ops_alert_recipients_of($1)`, [v.org])).map((x) => x.profile_id);
    console.log(`  · vuelta ${v.id.slice(0, 8)}: ${jefes.length} jefes, ${comp.length} compañeros en turno ahora`);
    await c.query(`SELECT public.route_started_alert_enqueue($1)`, [v.id]);
    const ini = await q(`SELECT profile_id, title, body, url FROM public.notification_outbox WHERE dedupe_key LIKE 'ini:' || $1 || ':%'`, [v.id]);
    t('INICIÓ: les llega a los jefes', jefes.every((j) => ini.some((o) => o.profile_id === j)), ini.length);
    t(`INICIÓ: les llega a los ${comp.length} compañeros del turno`, comp.every((p) => ini.some((o) => o.profile_id === p && o.url === '/')), ini.map((o) => o.profile_id));
    t('INICIÓ: NO le llega al que la inició', !ini.some((o) => o.profile_id === v.drv));
    if (ini[0]) console.log('    «' + ini[0].title + ' — ' + ini[0].body + '»');
    await c.query(`UPDATE public.route_stops SET status = 'delivered' WHERE id = $1`, [v.stop]);
    const fin = await q(`SELECT profile_id, title, body, url FROM public.notification_outbox WHERE dedupe_key LIKE 'fin:' || $1 || ':%'`, [v.id]);
    t('TERMINÓ: les llega a los jefes', jefes.every((j) => fin.some((o) => o.profile_id === j)), fin.length);
    t(`TERMINÓ: les llega a los ${comp.length} compañeros del turno`, comp.every((p) => fin.some((o) => o.profile_id === p)), fin.map((o) => o.profile_id));
    t('TERMINÓ: NO le llega al que la terminó', !fin.some((o) => o.profile_id === v.drv));
    if (fin[0]) console.log('    «' + fin[0].title + ' — ' + fin[0].body + '»');
    await c.query(`UPDATE public.route_stops SET status = 'pending' WHERE id = $1`, [v.stop]);
    t('deshacer la última parada borra también el de los compañeros', (await q(`SELECT 1 FROM public.notification_outbox WHERE dedupe_key LIKE 'fin:' || $1 || ':%' AND sent_at IS NULL`, [v.id])).length === 0);
  }
  await c.query('ROLLBACK TO SAVEPOINT prueba');
  if (fallas.length) throw new Error('fallaron ' + fallas.length);
  if (aplicar) { await c.query('COMMIT'); console.log('\n✓ 0170 APLICADA en ' + (prod ? 'PRODUCCIÓN' : 'dev')); } else { await c.query('ROLLBACK'); console.log('\nEN SECO: no se guardó nada'); }
} catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('\n✗ NO se aplicó:', e.message); process.exitCode = 1; }
await c.end();
