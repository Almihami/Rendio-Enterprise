// 0158 · Despacho de llegadas en StandBy + ajustes del optimizador V2.
//
//   DEV:        cd rendio-backend && set -a && source <.env.dev> && set +a && node --experimental-strip-types scripts/_aplicar-0158.mjs [--aplicar]
//   PRODUCCIÓN: … source <.env.main> … node --experimental-strip-types scripts/_aplicar-0158.mjs --produccion [--aplicar]
//
// Todo en UNA transacción; solo con --aplicar (y todo bien) se confirma. 0158 solo
// AGREGA (columnas, una tabla, 4 funciones, un cron) y nace apagada.
// En dev, además, un caso armado dentro de la transacción (se deshace siempre):
//   una llegada en espera cuyo vuelo ya tiene hora de FlightRadar; A con turno
//   abierto pero lejos (El Carmen) y B con turno abierto en JMC →
//   · despacho_estado la trae con la hora en que SALE (aterrizaje + desembarque);
//   · el MOTOR de la app (el mismo de la Edge Function) se la da a B;
//   · despacho_asignar la deja con B, avisa a B y al tripulante y deja el rastro;
//   · otra vez no hace nada (ya tiene conductor);
//   · sin nadie que alcance → despacho_avisar: UN aviso por jefe, una sola vez;
//   · apagado → foto vacía y no asigna.
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const DEV = 'lxlphbafhtphulanhzlp', PROD = 'wvuurnfdrrdondrbbkhd';
const prod = process.argv.includes('--produccion');
const aplicar = process.argv.includes('--aplicar');
const ref = process.env.SUPABASE_PROJECT_REF || '';
const esperado = prod ? PROD : DEV;
if (ref !== esperado || !(process.env.SUPABASE_URL || '').includes(esperado)) {
  console.error(`ABORT: se esperaba ${prod ? 'PRODUCCIÓN' : 'dev'} (${esperado}) y se cargó ${ref || '(nada)'}.`); process.exit(2);
}
const Motor = createRequire(import.meta.url)(new URL('../../rendio-turnos/despacho-llegadas.js', import.meta.url).pathname);
const { armarEstado } = await import(new URL('../supabase/functions/despacho-llegadas/estado.ts', import.meta.url).pathname);
const c = new pg.Client({ host: prod ? 'aws-1-us-west-2.pooler.supabase.com' : 'aws-1-us-east-1.pooler.supabase.com', port: 5432,
  database: 'postgres', user: 'postgres.' + esperado, password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false }, statement_timeout: 60000 });
await c.connect();
const q = async (s, v) => (await c.query(s, v)).rows;
const one = async (s, v) => (await q(s, v))[0];
const amb = prod ? 'PRODUCCIÓN' : 'dev';
console.log(aplicar ? `\n== APLICANDO 0158 en ${amb} ==` : `\n== 0158 EN SECO contra ${amb} (se deshace) ==`);
const fallas = [];
const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); if (!ok) fallas.push(n); };
const fn = (n) => one(`SELECT prosrc FROM pg_proc WHERE proname = $1 AND pronamespace = 'public'::regnamespace`, [n]);
const sql = readFileSync(new URL('../supabase/migrations/0158_despacho_llegadas.sql', import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const como = async (uid) => { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]); await c.query('SET LOCAL ROLE authenticated'); };
const comoDb = async () => { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', '', true)`); };

await c.query('BEGIN');
try {
  await c.query(`SET LOCAL lock_timeout = '5s'`);
  for (const f of ['cadena_libre', 'reub_baja', 'flight_deplane_min', 'route_sync_assigned', 'trip_notify', 'trip_kick', 'ops_alert_recipients_of', 'hm_bog', 'lugar_del_regreso', 'set_updated_at', 'current_user_org', 'current_user_role']) {
    t(`existe public.${f}()`, !!(await fn(f)));
  }
  const cols = (await q(`SELECT table_name || '.' || column_name c FROM information_schema.columns WHERE table_schema = 'public' AND (table_name, column_name) IN
    (('route_assignments','para_tomar'),('route_assignments','pool'),('route_assignments','delegated_at'),('route_assignments','organization_id'),('route_stops','guest_lat'),
     ('reservations','ground_ops'),('reservations','reserve_place'),('reservations','flight_code'),('shifts','organization_id'),('airports','latitude'),
     ('app_settings','route_default_capacity'),('app_settings','route_service_min'),('app_settings','route_traffic_factor'))`)).map((r) => r.c);
  t('la base tiene las 13 columnas que 0158 lee', cols.length === 13, cols);
  if (fallas.length) throw new Error('la base no tiene lo que 0158 necesita: NO se toca');
  const antes = await one(`SELECT to_jsonb(s) j FROM public.app_settings s WHERE id = 'singleton'`);

  await c.query(sql);

  const s0 = await one(`SELECT despacho_activo, despacho_horizonte_min, despacho_juntar_min, despacho_espera_max_min, route_solver_v2, route_apoyo_car, route_buffer_flex_min, route_band_factors FROM public.app_settings WHERE id = 'singleton'`);
  t('nace APAGADA (despacho y optimizador V2)', s0.despacho_activo === false && s0.route_solver_v2 === 0 && s0.route_apoyo_car === 0 && s0.route_band_factors === null, s0);
  t('números por defecto: 20 / 6 / 15', s0.despacho_horizonte_min === 20 && s0.despacho_juntar_min === 6 && s0.despacho_espera_max_min === 15, s0);
  const despues = await one(`SELECT to_jsonb(s) j FROM public.app_settings s WHERE id = 'singleton'`);
  t('ningún ajuste de antes cambió', Object.keys(antes.j).every((k) => k === 'updated_at' || JSON.stringify(antes.j[k]) === JSON.stringify(despues.j[k])));
  for (const f of ['despacho_estado', 'despacho_asignar', 'despacho_avisar', 'despachar_llegadas']) {
    const g = await one(`SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('anon', p.oid, 'EXECUTE') n, has_function_privilege('service_role', p.oid, 'EXECUTE') s FROM pg_proc p WHERE p.proname = $1 AND p.pronamespace = 'public'::regnamespace`, [f]);
    t(`${f}: solo el servidor (la app no la puede llamar)`, g && g.a === false && g.n === false && g.s === true, g);
  }
  const rls = await one(`SELECT relrowsecurity r FROM pg_class WHERE oid = 'public.arrival_dispatch_log'::regclass`);
  t('arrival_dispatch_log con RLS', rls && rls.r === true);
  const job = await one(`SELECT schedule FROM cron.job WHERE jobname = 'despachar-llegadas'`).catch(() => null);
  t('cron despachar-llegadas cada 2 min', job && job.schedule === '*/2 * * * *', job);
  t('apagada: la foto sale vacía', JSON.stringify((await one(`SELECT public.despacho_estado() j`)).j) === '[]');
  t('apagada: el disparo dice «apagado»', /apagado/.test((await one(`SELECT public.despachar_llegadas() x`)).x));

  if (!prod) {
    await c.query('SAVEPOINT prueba');
    const org = (await one(`SELECT p.organization_id o FROM public.profiles p WHERE p.role = 'admin' AND p.deleted_at IS NULL AND p.organization_id IS NOT NULL
        AND (SELECT count(*) FROM public.driver_profiles dp JOIN public.profiles x ON x.id = dp.profile_id WHERE x.organization_id = p.organization_id AND x.deleted_at IS NULL AND x.is_active IS DISTINCT FROM false) >= 2
        AND EXISTS (SELECT 1 FROM public.auxiliar_profiles ap JOIN public.profiles x ON x.id = ap.profile_id WHERE x.organization_id = p.organization_id AND x.deleted_at IS NULL AND ap.residence_id IS NOT NULL)
        AND (SELECT count(*) FROM public.vehicles v WHERE v.organization_id = p.organization_id) >= 2
      LIMIT 1`) || {}).o;
    if (!org) console.log('  · (sin organización de prueba en dev)');
    else {
      const jefe = (await one(`SELECT id FROM public.profiles WHERE role = 'admin' AND organization_id = $1 AND deleted_at IS NULL LIMIT 1`, [org])).id;
      const [A, B] = await q(`SELECT dp.id, dp.profile_id, x.full_name FROM public.driver_profiles dp JOIN public.profiles x ON x.id = dp.profile_id
         WHERE x.organization_id = $1 AND x.deleted_at IS NULL AND x.is_active IS DISTINCT FROM false ORDER BY dp.id LIMIT 2`, [org]);
      const auxs = await q(`SELECT ap.id, ap.profile_id FROM public.auxiliar_profiles ap JOIN public.profiles x ON x.id = ap.profile_id
         WHERE x.organization_id = $1 AND x.deleted_at IS NULL AND ap.residence_id IS NOT NULL AND coalesce((to_jsonb(ap) ->> 'external')::boolean, false) = false
         ORDER BY ap.id LIMIT 2`, [org]);
      const vehs = await q(`SELECT id FROM public.vehicles WHERE organization_id = $1 ORDER BY id LIMIT 2`, [org]);
      // Limpio para la prueba (todo se deshace): ni turnos abiertos, ni GPS recientes, ni vueltas cerca.
      await c.query(`SELECT set_config('rendio.no_acomodar', 'on', true)`);
      await c.query(`UPDATE public.shifts SET status = 'closed', end_at = greatest(start_at, now()) WHERE organization_id = $1 AND status::text <> 'closed'`, [org]);
      await c.query(`DELETE FROM public.driver_locations WHERE recorded_at > now() - interval '1 hour'`);
      await c.query(`DELETE FROM public.route_assignments WHERE (driver_profile_id IN ($1, $2) OR (pool AND organization_id = $3)) AND planned_start_at BETWEEN now() - interval '6 hours' AND now() + interval '12 hours'`, [A.id, B.id, org]);
      // El vuelo aterriza dentro de ~2 min (FlightRadar); con el desembarque la persona sale en ~15–30.
      const base = (await one(`SELECT date_trunc('minute', now()) b`)).b;
      await como(jefe);
      const rid = (await one(`SELECT public.admin_create_reservation($1, 'lle', $2::timestamptz + interval '20 minutes', 'AV9901', NULL, false) id`, [auxs[0].id, base])).id;
      const rid2 = (await one(`SELECT public.admin_create_reservation($1, 'lle', $2::timestamptz + interval '5 minutes', 'AV9902', NULL, false) id`, [(auxs[1] || auxs[0]).id, base])).id;
      await comoDb();
      await c.query(`SELECT set_config('rendio.no_acomodar', 'on', true)`);
      await c.query(`DELETE FROM public.route_stops WHERE reservation_id IN ($1, $2)`, [rid, rid2]);   // por si el pedido nació con vuelta
      const enEspera = async (start, r) => {
        const ra = (await one(`INSERT INTO public.route_assignments (direction, status, planned_start_at, driver_profile_id, organization_id, pool, para_tomar)
           VALUES ('airport_to_home', 'planned', $1, NULL, $2, true, true) RETURNING id`, [start, org])).id;
        await c.query(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order) VALUES ($1, $2, 1)`, [ra, r]);
        return ra;
      };
      const V1 = await enEspera(new Date(Date.parse(base) + 40 * 60000).toISOString(), rid);
      await c.query(`INSERT INTO public.flight_statuses (organization_id, flight_code, flight_date, direction, sched_at, estimated_at, status, delay_min, source, fetched_at)
         VALUES ($1, 'AV9901', (($2::timestamptz + interval '20 minutes') AT TIME ZONE 'America/Bogota')::date, 'airport_to_home',
                 $2::timestamptz + interval '20 minutes', $2::timestamptz + interval '2 minutes', 'in_air', -18, 'flightradar24', now())
         ON CONFLICT (organization_id, flight_code, flight_date, direction) DO UPDATE SET estimated_at = EXCLUDED.estimated_at, actual_at = NULL, delay_min = -18, status = 'in_air', fetched_at = now()`, [org, base]);
      const dep = (await one(`SELECT public.flight_deplane_min('AV9901') m`)).m;
      // A: turno abierto, lejos (El Carmen). B: turno abierto, en JMC.
      await c.query(`INSERT INTO public.shifts (organization_id, driver_id, vehicle_id, status, start_at) VALUES ($1, $2, $3, 'active', now() - interval '1 hour')`, [org, A.id, vehs[0].id]);
      const turnoB = (await one(`INSERT INTO public.shifts (organization_id, driver_id, vehicle_id, status, start_at) VALUES ($1, $2, $3, 'active', now() - interval '1 hour') RETURNING id`, [org, B.id, vehs[1].id])).id;
      await c.query(`INSERT INTO public.driver_locations (driver_profile_id, latitude, longitude, recorded_at) VALUES ($1, 6.0837, -75.3341, now()), ($2, 6.1715, -75.4270, now())`, [A.id, B.id]);
      await c.query(`UPDATE public.app_settings SET despacho_activo = true WHERE id = 'singleton'`);

      const fotos = (await one(`SELECT public.despacho_estado() j`)).j;
      const foto = fotos.find((f) => f.org === org);
      t('encendida: la foto trae la organización', !!foto, fotos);
      const l1 = foto && foto.llegadas.find((l) => l.ra === V1);
      const saleEsp = Date.parse(base) + (2 + dep) * 60000;
      t(`la llegada sale a la hora de FlightRadar + desembarque (${dep} min), no a la programada`, l1 && Math.abs(Date.parse(l1.sale) - saleEsp) < 61000 && l1.pax === 1 && l1.lat != null, l1);
      const cA = foto && foto.carros.find((x) => x.dp === A.id), cB = foto && foto.carros.find((x) => x.dp === B.id);
      t('los dos conductores con turno abierto aparecen', !!cA && !!cB, foto && foto.carros);
      t('B está en JMC (GPS) y A no', cB && cB.known && cB.air === true && cA && cA.known && cA.air === false, { cA, cB });

      const { estado, aISO } = armarEstado(foto);
      const d = Motor.decidir(estado);
      const a1 = d.asignar.find((x) => x.ids[0] === V1);
      t('el motor se la da a B (el que está en JMC)', a1 && a1.carro === B.id && a1.espera <= 1, d);

      await c.query('SAVEPOINT caso');
      const ok1 = (await one(`SELECT public.despacho_asignar($1, $2, $3, $4, $5) x`, [V1, B.id, aISO(a1 ? a1.recoge : 0), l1 ? l1.sale : null, 0])).x;
      const v1 = await one(`SELECT driver_profile_id, vehicle_id, pool, para_tomar, status FROM public.route_assignments WHERE id = $1`, [V1]);
      t('despacho_asignar: la vuelta queda con B y con el carro de su turno', ok1 === true && v1.driver_profile_id === B.id && v1.vehicle_id === vehs[1].id && v1.status === 'planned', { ok1, v1 });
      const out = await q(`SELECT profile_id, title, body, url FROM public.notification_outbox WHERE created_at >= now() - interval '1 minute'`);
      const aB = out.find((o) => o.profile_id === B.profile_id && /Llegada para ti/.test(o.title));
      t('aviso a B: «Llegada para ti ✈️ · Recoge en JMC a las …»', !!aB && /Recoge en JMC a las \d/.test(aB.body), out.filter((o) => o.profile_id === B.profile_id));
      t('aviso al tripulante: «<B> te recoge 🚗»', !!out.find((o) => o.profile_id === auxs[0].profile_id && /te recoge/.test(o.title)), out.filter((o) => o.profile_id === auxs[0].profile_id));
      t('A no recibe nada', !out.some((o) => o.profile_id === A.profile_id));
      const st = await one(`SELECT status_a2h::text s FROM public.reservations WHERE id = $1`, [rid]);
      t('el pedido pasa a «conductor asignado»', st && st.s === 'driver_assigned', st);
      const lg = await one(`SELECT kind, driver_profile_id, who FROM public.arrival_dispatch_log WHERE route_assignment_id = $1`, [V1]);
      t('queda el rastro (asignada, a B, con el nombre)', lg && lg.kind === 'asignada' && lg.driver_profile_id === B.id && !!lg.who, lg);
      const ok2 = (await one(`SELECT public.despacho_asignar($1, $2, now(), now(), 0) x`, [V1, A.id])).x;
      t('otra vez no hace nada: ya tiene conductor', ok2 === false && (await one(`SELECT driver_profile_id d FROM public.route_assignments WHERE id = $1`, [V1])).d === B.id);
      t('ya no sale en la foto', !((await one(`SELECT public.despacho_estado() j`)).j.find((f) => f.org === org) || { llegadas: [] }).llegadas.some((l) => l.ra === V1));
      await c.query('ROLLBACK TO SAVEPOINT caso');

      // Nadie alcanza: B cierra turno y A (lejos) tiene una salida enseguida.
      await c.query('SAVEPOINT nadie');
      await c.query(`UPDATE public.shifts SET status = 'closed', end_at = now() WHERE id = $1`, [turnoB]);
      const f2 = (await one(`SELECT public.despacho_estado() j`)).j.find((f) => f.org === org);
      const e2 = armarEstado(f2); e2.estado.carros.forEach((x) => { x.salida = { primera: 'airport', etaPrimera: 10 }; });
      const d2 = Motor.decidir(e2.estado);
      t('sin quién alcance, el motor avisa «sin carro»', d2.asignar.length === 0 && d2.avisos.some((v) => v.id === V1 && v.tipo === 'sin_carro'), d2);
      const jefes = await q(`SELECT profile_id FROM public.ops_alert_recipients_of($1)`, [org]);
      const n1 = (await one(`SELECT public.despacho_avisar($1, 'sin_carro', $2, NULL) n`, [V1, l1 ? l1.sale : base])).n;
      const av = await q(`SELECT profile_id, title, body FROM public.notification_outbox WHERE created_at >= now() - interval '1 minute' AND title LIKE 'Una llegada necesita apoyo%'`);
      t('despacho_avisar: UN aviso por jefe', n1 === jefes.length && av.length === jefes.length && /ningún conductor en turno alcanza/.test(av[0].body), { n1, jefes: jefes.length, av });
      t('una sola vez por vuelta', (await one(`SELECT public.despacho_avisar($1, 'sin_carro', now(), NULL) n`, [V1])).n === 0);
      t('la vuelta sigue en espera (nadie la tocó)', (await one(`SELECT driver_profile_id d FROM public.route_assignments WHERE id = $1`, [V1])).d === null);
      await c.query('ROLLBACK TO SAVEPOINT nadie');

      t('el disparo, sin el secreto, lo dice (no revienta)', /faltan secretos|disparado|vault|pg_net/.test((await one(`SELECT public.despachar_llegadas() x`)).x));
      await c.query(`UPDATE public.app_settings SET despacho_activo = false WHERE id = 'singleton'`);
      t('apagada otra vez: no asigna', (await one(`SELECT public.despacho_asignar($1, $2, now(), now(), 0) x`, [V1, B.id])).x === false);
    }
    await c.query('ROLLBACK TO SAVEPOINT prueba');
  }
  if (fallas.length) throw new Error(fallas.length + ' comprobaciones fallaron');
  if (aplicar) { await c.query('COMMIT'); console.log(`\n✔ 0158 APLICADA en ${amb} (apagada).`); }
  else { await c.query('ROLLBACK'); console.log(`\n✔ En seco: todo bien. No se cambió nada en ${amb}.`); }
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error(`\n✗ ${e.message}\n  Se deshizo todo: ${amb} quedó como estaba.`);
  process.exitCode = 1;
} finally { await c.end(); }
