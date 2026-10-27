// 0152 · Detector de cadena (en sombra) y «Pasar a X».
//
//   DEV:        cd rendio-backend && set -a && source <.env.dev> && set +a && node scripts/_aplicar-0152.mjs [--aplicar]
//   PRODUCCIÓN: cd rendio-backend && set -a && source <.env.main> && set +a && node scripts/_aplicar-0152.mjs --produccion [--aplicar]
//
// Todo en UNA transacción; solo con --aplicar (y todo bien) se confirma.
// ANTES: existen las funciones que 0152 usa (no cambia ninguna).
// En dev, además, el caso de Enrique de punta a punta con datos armados dentro de
// la transacción (se deshace siempre): Juan tiene una llegada que no alcanza
// porque su vuelta anterior termina tarde; Daniel viene con una salida a JMC y sí
// alcanza → detección, aviso a los jefes (uno), la tarjeta, «Pasar a Daniel», lo
// que ya no se puede, «delegar» cuando nadie alcanza, descartar y el interruptor.
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
const c = new pg.Client({ host: prod ? 'aws-1-us-west-2.pooler.supabase.com' : 'aws-1-us-east-1.pooler.supabase.com', port: 5432,
  database: 'postgres', user: 'postgres.' + esperado, password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false }, statement_timeout: 60000 });
await c.connect();
const q = async (s, v) => (await c.query(s, v)).rows;
const one = async (s, v) => (await q(s, v))[0];
const amb = prod ? 'PRODUCCIÓN' : 'dev';
console.log(aplicar ? `\n== APLICANDO 0152 en ${amb} ==` : `\n== 0152 EN SECO contra ${amb} (se deshace) ==`);
const fallas = [];
const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); if (!ok) fallas.push(n); };
const leer = (f) => readFileSync(new URL('../supabase/migrations/' + f, import.meta.url), 'utf8');
const fn = (n) => one(`SELECT prosrc FROM pg_proc WHERE proname = $1 AND pronamespace = 'public'::regnamespace`, [n]);
const sql = leer('0152_detector_cadena.sql').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const como = async (uid) => { await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]); await c.query('SET LOCAL ROLE authenticated'); };
const comoDb = async () => { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', '', true)`); };
const falla = async (s, v) => { await c.query('SAVEPOINT f'); try { await c.query(s, v); await c.query('RELEASE SAVEPOINT f'); return null; } catch (e) { await c.query('ROLLBACK TO SAVEPOINT f'); return e; } };

await c.query('BEGIN');
try {
  await c.query(`SET LOCAL lock_timeout = '5s'`);
  for (const f of ['reub_extremos', 'reub_conductor_libre', 'reub_leg', 'conductores_del_turno', 'turno_de', 'admin_route_set_driver',
    'trip_notify', 'trip_kick', 'ops_alert_recipients_of', 'hm_bog', 'short_name', 'current_user_org', 'current_user_role', 'set_updated_at']) {
    t(`existe public.${f}()`, !!(await fn(f)));
  }
  const yaEsta = await one(`SELECT to_regclass('public.route_chain_alerts') r`);
  if (yaEsta.r) console.log('  · route_chain_alerts ya existe: se vuelve a correr (idempotente)');
  if (fallas.length) throw new Error('la base no tiene lo que 0152 necesita: NO se toca');
  const huellas = {};
  for (const f of ['admin_route_set_driver', 'reub_conductor_libre', 'reub_extremos', 'conductores_del_turno', 'detect_route_risks', 'acomodar_eventualidades']) huellas[f] = (await fn(f) || {}).prosrc;

  await c.query(sql);

  for (const f of Object.keys(huellas)) t(`${f}() quedó igual (0152 no la toca)`, ((await fn(f)) || {}).prosrc === huellas[f]);
  const cols = (await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'app_settings' AND column_name LIKE 'cadena_%'`)).map((x) => x.column_name).sort();
  t('app_settings: cadena_activa, cadena_horizonte_min, cadena_max_hora, cadena_min_tarde', cols.join() === 'cadena_activa,cadena_horizonte_min,cadena_max_hora,cadena_min_tarde', cols);
  t('route_chain_alerts con RLS', (await one(`SELECT relrowsecurity r FROM pg_class WHERE oid = 'public.route_chain_alerts'::regclass`)).r);
  for (const f of ['admin_cadena_ver', 'admin_cadena_aplicar', 'admin_cadena_descartar', 'admin_cadena_encender']) {
    const g = await one(`SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('anon', p.oid, 'EXECUTE') n FROM pg_proc p WHERE p.proname = $1 AND p.pronamespace = 'public'::regnamespace`, [f]);
    t(`${f}: la llama authenticated, no anon`, g && g.a && !g.n, g);
  }
  for (const f of ['detect_route_chains', 'cadena_evaluar', 'cadena_candidato', 'cadena_libre', 'cadena_aviso_del_jefe']) {
    const g = await one(`SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE') a FROM pg_proc p WHERE p.proname = $1 AND p.pronamespace = 'public'::regnamespace`, [f]);
    t(`${f}: no se puede llamar desde la app`, g && !g.a, g);
  }
  await c.query('SAVEPOINT cj');
  const job = await one(`SELECT schedule FROM cron.job WHERE jobname = 'detect-route-chains'`).catch(() => null);
  if (!job) await c.query('ROLLBACK TO SAVEPOINT cj'); else await c.query('RELEASE SAVEPOINT cj');
  t('pg_cron: detect-route-chains cada 5 min', job && job.schedule === '2-59/5 * * * *', job);
  // Una pasada real contra lo que hay (en seco se deshace): que no reviente.
  await c.query('SAVEPOINT real');
  const e0 = await falla(`SELECT public.detect_route_chains() n`);
  t('una pasada sobre los datos de hoy no da error', !e0, e0 && e0.message);
  const hoy = await q(`SELECT a.kind, a.late_min, a.why, a.suggested_why, public.hm_bog(a.need_at) hora FROM public.route_chain_alerts a ORDER BY a.need_at`);
  console.log(`  · con los datos de ${amb} de ahora: ${hoy.length} detección(es)` + (hoy.length ? '\n' + hoy.map((x) => `      ${x.hora} ${x.kind} +${x.late_min} min · ${x.why}${x.suggested_why ? ' → ' + x.suggested_why : ''}`).join('\n') : ''));
  await c.query('ROLLBACK TO SAVEPOINT real');

  if (!prod) {
    await c.query('SAVEPOINT prueba');
    const libres = `NOT EXISTS (SELECT 1 FROM public.route_assignments ra WHERE ra.driver_profile_id = dp.id AND ra.planned_start_at BETWEEN now() - interval '13 hours' AND now() + interval '13 hours')`;
    const org = (await one(`SELECT p.organization_id o FROM public.profiles p WHERE p.role = 'admin' AND p.deleted_at IS NULL
        AND (SELECT count(*) FROM public.driver_profiles dp JOIN public.profiles x ON x.id = dp.profile_id WHERE x.organization_id = p.organization_id AND ${libres}) >= 2
        AND EXISTS (SELECT 1 FROM public.vehicles v WHERE v.organization_id = p.organization_id)
        AND (SELECT count(*) FROM public.auxiliar_profiles ap JOIN public.profiles x ON x.id = ap.profile_id WHERE x.organization_id = p.organization_id) >= 1
      LIMIT 1`) || {}).o;
    if (!org) { console.log('  · (sin organización de prueba en dev)'); fallas.push('sin datos de prueba'); }
    else {
      const [D, C] = await q(`SELECT dp.id, dp.profile_id FROM public.driver_profiles dp JOIN public.profiles x ON x.id = dp.profile_id
        WHERE x.organization_id = $1 AND x.deleted_at IS NULL AND x.is_active IS DISTINCT FROM false AND ${libres} ORDER BY dp.id LIMIT 2`, [org]);
      const jefe = await one(`SELECT id FROM public.profiles WHERE organization_id = $1 AND role = 'admin' AND deleted_at IS NULL LIMIT 1`, [org]);
      const veh = await one(`SELECT id FROM public.vehicles WHERE organization_id = $1 ORDER BY capacity DESC LIMIT 1`, [org]);
      const aux = await one(`SELECT ap.id FROM public.auxiliar_profiles ap JOIN public.profiles x ON x.id = ap.profile_id WHERE x.organization_id = $1 LIMIT 1`, [org]);
      const jefes = (await one(`SELECT count(*)::int n FROM public.ops_alert_recipients_of($1)`, [org])).n;
      await c.query(`SET LOCAL session_replication_role = replica`);   // sin disparadores (acomodo, avisos) al armar
      const base = await one(`SELECT * FROM public.reservations WHERE pickup_latitude IS NOT NULL AND cancelled_at IS NULL LIMIT 1`);
      const reserva = async (dir) => (await one(`INSERT INTO public.reservations SELECT (jsonb_populate_record(NULL::public.reservations, to_jsonb(b) || jsonb_build_object(
          'id', gen_random_uuid(), 'auxiliar_profile_id', $2::uuid, 'direction', $3::text, 'cancelled_at', NULL, 'flight_id', NULL, 'flight_code', 'AV9999',
          'status_a2h', CASE WHEN $3 = 'airport_to_home' THEN 'scheduled' END, 'status_h2a', CASE WHEN $3 = 'home_to_airport' THEN 'assigned' END,
          'disembark_gate', NULL))).*
        FROM public.reservations b WHERE b.id = $1 RETURNING id`, [base.id, aux.id, dir])).id;
      const vuelta = async (dp, dir, ini, st = 'planned', extra = {}) => {
        const r = await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at, actual_start_at, organization_id)
          VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5), $6, $7) RETURNING id`,
          [dp, veh.id, dir, st, ini, st === 'in_progress' ? new Date(Date.now() + ini * 60000) : null, org]);
        await c.query(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at, status)
          VALUES ($1, $2, 1, now() + make_interval(mins => $3), $4)`, [r.id, await reserva(dir), extra.etaMin ?? ini, extra.stop || 'pending']);
        return r.id;
      };
      // Juan (D): una llegada que debía arrancar hace 10 min y no ha arrancado → termina tarde; luego la de Enrique (V) en 12 min.
      const P = await vuelta(D.id, 'airport_to_home', -10);
      const V = await vuelta(D.id, 'airport_to_home', 12);
      // Daniel (C): viene con una salida hacia JMC (arrancó hace 30 min, recogió hace 25) y tiene el turno abierto.
      const Q = await vuelta(C.id, 'home_to_airport', -30, 'in_progress', { etaMin: -25, stop: 'picked_up' });
      await c.query(`INSERT INTO public.shifts (organization_id, driver_id, vehicle_id, start_at) VALUES ($1, $2, $3, now() - interval '2 hours')`, [org, C.id, veh.id]);
      await c.query(`SET LOCAL session_replication_role = origin`);
      await c.query(`UPDATE public.app_settings SET cadena_activa = true, cadena_min_tarde = 10, cadena_max_hora = 6 WHERE id = 'singleton'`);
      await c.query(`DELETE FROM public.route_chain_alerts`);   // las de los datos de dev no cuentan en esta prueba
      const avisos = async (pre) => (await one(`SELECT count(*)::int n FROM public.notification_outbox WHERE dedupe_key LIKE $1`, [pre + '%'])).n;

      const ev = (await one(`SELECT public.cadena_evaluar($1, true) j`, [V])).j;
      t('Juan no alcanza la de Enrique (10+ min tarde)', ev && ev.known && ev.late_min >= 10, ev);
      t('…y el recomendado es Daniel', ev && ev.best && ev.best.dp === C.id, ev && ev.best);
      const evQ = (await one(`SELECT public.cadena_evaluar($1, false) j`, [P])).j;
      t('la vuelta anterior de Juan no se marca (no tiene nada antes)', !evQ || evQ.known === false || evQ.late_min < 10, evQ);

      // 1. El detector.
      const n1 = (await one(`SELECT public.detect_route_chains() n`)).n;
      const al = await one(`SELECT * FROM public.route_chain_alerts WHERE route_assignment_id = $1 AND resolved_at IS NULL`, [V]);
      t('detector: una detección «reasignar» con Daniel', al && al.kind === 'reasignar' && al.suggested_driver_id === C.id && al.late_min >= 10, al);
      t('…y un aviso a cada jefe, con el enlace a la tarjeta', n1 >= 1 && al && (await avisos('cadena:' + al.id)) === jefes, [n1, al && await avisos('cadena:' + al.id), jefes]);
      const txt = al && await one(`SELECT title, body, url FROM public.notification_outbox WHERE dedupe_key LIKE $1 LIMIT 1`, ['cadena:' + al.id + '%']);
      if (txt) console.log(`      «${txt.title}» — ${txt.body}  [${txt.url}]`);
      t('…el texto dice quién no alcanza, a quién se recomienda y lleva a #/rutas?cadena=', txt && /no alcanza/.test(txt.title) && /Recomendado: /.test(txt.body) && txt.url === '/#/rutas?cadena=' + al.id, txt);
      const n2 = (await one(`SELECT public.detect_route_chains() n`)).n;
      t('una segunda pasada no repite el aviso', n2 === 0 && (await avisos('cadena:' + al.id)) === jefes, [n2, await avisos('cadena:' + al.id)]);

      // 2. La tarjeta.
      await como(D.profile_id);
      const e1 = await falla(`SELECT public.admin_cadena_ver($1)`, [al.id]);
      t('un conductor no ve la tarjeta (42501)', e1 && e1.code === '42501', e1 && e1.message);
      await comoDb(); await como(jefe.id);
      const ver = (await one(`SELECT public.admin_cadena_ver($1) j`, [al.id])).j;
      t('el jefe la ve: recomendado, «sigue alcanzando» y el estado de ahora', ver && ver.suggested_name && ver.sigue && ver.sigue.ok === true && ver.ahora && ver.ahora.quien, ver);
      const vis = (await one(`SELECT count(*)::int n FROM public.route_chain_alerts`)).n;
      t('…y por RLS ve las detecciones de su organización', vis >= 1, vis);

      // 3. «Pasar a Daniel».
      const ap = (await one(`SELECT public.admin_cadena_aplicar($1) j`, [al.id])).j;
      await comoDb();
      const vNow = await one(`SELECT driver_profile_id, status FROM public.route_assignments WHERE id = $1`, [V]);
      t('«Pasar a Daniel»: la vuelta queda con Daniel y planeada', ap && ap.ok === true && vNow.driver_profile_id === C.id && vNow.status === 'planned', [ap, vNow]);
      const alR = await one(`SELECT resolution, resolved_by FROM public.route_chain_alerts WHERE id = $1`, [al.id]);
      t('…la detección queda «aplicado» por el jefe', alR.resolution === 'aplicado' && alR.resolved_by === jefe.id, alR);
      const pN = await one(`SELECT count(*)::int n FROM public.notification_outbox WHERE profile_id = $1 AND created_at > now() - interval '1 minute'`, [C.profile_id]).catch(() => ({ n: -1 }));
      t('…a Daniel le llegó el aviso de siempre (admin_route_set_driver)', pN.n !== 0, pN);
      await como(jefe.id);
      const ap2 = (await one(`SELECT public.admin_cadena_aplicar($1) j`, [al.id])).j;
      t('tocarlo otra vez no hace nada: «Ya se la pasaron…»', ap2 && ap2.ok === false && /Ya se la pasaron/.test(ap2.motivo), ap2);
      await comoDb();

      // 4. Nadie alcanza → «delegar»; descartar; no se vuelve a avisar.
      await c.query(`SET LOCAL session_replication_role = replica`);
      const V3 = await vuelta(D.id, 'airport_to_home', 13);
      await c.query(`SET LOCAL session_replication_role = origin`);
      await c.query(`SELECT public.detect_route_chains()`);
      const al3 = await one(`SELECT * FROM public.route_chain_alerts WHERE route_assignment_id = $1 AND resolved_at IS NULL`, [V3]);
      t('otra de Juan a la misma hora: Daniel ya está ocupado → «delegar»', al3 && al3.kind === 'delegar' && !al3.suggested_driver_id, al3);
      const txt3 = al3 && await one(`SELECT body FROM public.notification_outbox WHERE dedupe_key LIKE $1 LIMIT 1`, ['cadena:' + al3.id + '%']);
      t('…el aviso recomienda delegarla', txt3 && /delegarla/.test(txt3.body), txt3);
      await como(jefe.id);
      const ap3 = (await one(`SELECT public.admin_cadena_aplicar($1) j`, [al3.id])).j;
      t('«Pasar» sin recomendado: no toca nada y dice que se delegue', ap3 && ap3.ok === false && /delégala/.test(ap3.motivo), ap3);
      await c.query(`SELECT public.admin_cadena_descartar($1)`, [al3.id]);
      await comoDb();
      await c.query(`SELECT public.detect_route_chains()`);
      const otra = await one(`SELECT count(*)::int n FROM public.route_chain_alerts WHERE route_assignment_id = $1 AND resolved_at IS NULL`, [V3]);
      t('descartada: el detector no la vuelve a abrir', otra.n === 0, otra);

      // 5. El jefe le cambia el conductor por su lado → la detección se cierra sola.
      await c.query(`SET LOCAL session_replication_role = replica`);
      const V4 = await vuelta(D.id, 'airport_to_home', 14);
      await c.query(`SET LOCAL session_replication_role = origin`);
      await c.query(`SELECT public.detect_route_chains()`);
      const al4 = await one(`SELECT id FROM public.route_chain_alerts WHERE route_assignment_id = $1 AND resolved_at IS NULL`, [V4]);
      await c.query(`UPDATE public.route_assignments SET driver_profile_id = $2 WHERE id = $1`, [V4, C.id]);
      await c.query(`SELECT public.detect_route_chains()`);
      const al4r = al4 && await one(`SELECT resolution FROM public.route_chain_alerts WHERE id = $1`, [al4.id]);
      t('si un jefe la cambia en el tablero, la detección queda «cambio»', al4r && al4r.resolution === 'cambio', al4r);

      // 6. El interruptor.
      await como(D.profile_id);
      const e2 = await falla(`SELECT public.admin_cadena_encender(false)`);
      t('un conductor no lo puede apagar', e2 && e2.code === '42501', e2 && e2.message);
      await comoDb(); await como(jefe.id);
      await c.query(`SELECT public.admin_cadena_encender(false)`);
      await comoDb();
      await c.query(`SET LOCAL session_replication_role = replica`);
      await vuelta(D.id, 'airport_to_home', 15);
      await c.query(`SET LOCAL session_replication_role = origin`);
      const nOff = (await one(`SELECT public.detect_route_chains() n`)).n;
      const abiertasOff = (await one(`SELECT count(*)::int n FROM public.route_chain_alerts WHERE resolved_at IS NULL AND created_at > now() - interval '1 second'`)).n;
      t('apagado: el detector no hace nada', nOff === 0, [nOff, abiertasOff]);
    }
    await c.query('ROLLBACK TO SAVEPOINT prueba');
  }

  if (fallas.length) throw new Error(`${fallas.length} comprobación(es) en rojo`);
  if (!aplicar) { await c.query('ROLLBACK'); console.log('\n  EN SECO: todo en verde y DESHECHO. Para confirmarlo: --aplicar'); await c.end(); process.exit(0); }
  await c.query('COMMIT');
  console.log('  ✓ COMMIT ' + new Date().toLocaleTimeString('es-CO', { timeZone: 'America/Bogota' }));
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error(`\n  ✗ NO SE APLICÓ (se deshizo todo): ${e.message}`); await c.end(); process.exit(1);
}
await c.query(`NOTIFY pgrst, 'reload schema'`);
await c.end();
process.exit(0);
