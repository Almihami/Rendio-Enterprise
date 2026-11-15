// 0163 · Despacho «a ras»: llegadas que no se toman a mano, el de apoyo se entera y se reparte de nuevo si el conductor se atrasa.
//   cd rendio-backend && set -a && source <.env.dev|.env.main> && set +a && node --experimental-strip-types scripts/_aplicar-0163.mjs [--produccion] [--aplicar]
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const DEV = 'lxlphbafhtphulanhzlp', PROD = 'wvuurnfdrrdondrbbkhd';
const prod = process.argv.includes('--produccion'), aplicar = process.argv.includes('--aplicar');
const esperado = prod ? PROD : DEV;
if ((process.env.SUPABASE_PROJECT_REF || '') !== esperado || !(process.env.SUPABASE_URL || '').includes(esperado)) { console.error('ABORT: ambiente equivocado'); process.exit(2); }
const Motor = createRequire(import.meta.url)(new URL('../../rendio-turnos/despacho-llegadas.js', import.meta.url).pathname);
const { armarEstado } = await import(new URL('../supabase/functions/despacho-llegadas/estado.ts', import.meta.url).pathname);
const c = new pg.Client({ host: prod ? 'aws-1-us-west-2.pooler.supabase.com' : 'aws-1-us-east-1.pooler.supabase.com', port: 5432, database: 'postgres', user: 'postgres.' + esperado, password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false }, statement_timeout: 60000 });
await c.connect();
const q = async (s, v) => (await c.query(s, v)).rows, one = async (s, v) => (await q(s, v))[0];
const fallas = []; const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + JSON.stringify(d) : ''}`); if (!ok) fallas.push(n); };
const sql = readFileSync(new URL('../supabase/migrations/0163_despacho_a_ras.sql', import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const como = async (uid) => { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]); await c.query('SET LOCAL ROLE authenticated'); };
const comoDb = async () => { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', '', true)`); };
console.log(`\n== 0163 ${aplicar ? 'APLICANDO' : 'EN SECO'} en ${prod ? 'PRODUCCIÓN' : 'dev'} ==`);
await c.query('BEGIN');
try {
  await c.query(`SET LOCAL lock_timeout = '5s'`);
  const d1 = await one(`SELECT prosrc FROM pg_proc WHERE proname = 'despacho_asignar'`), d2 = await one(`SELECT prosrc FROM pg_proc WHERE proname = 'cadena_evaluar'`);
  t('están 0162 (despacho_asignar con apoyo) y 0152 (cadena_evaluar)', !!(d1 && /apoyo_de_turno/.test(d1.prosrc) && d2));
  if (fallas.length) throw new Error('faltan migraciones anteriores');
  await c.query(sql);
  for (const [f, app, srv] of [['despacho_encendido', false, true], ['apoyo_avisar', false, true], ['despacho_soltar_atrasadas', false, true],
    ['driver_open_routes', true, null], ['driver_take_route', true, null], ['driver_release_route', true, null], ['admin_set_support_duty', true, null],
    ['avisar_vuelta_para_tomar', false, null], ['despachar_llegadas', false, null]]) {
    const g = await one(`SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('anon', p.oid, 'EXECUTE') n, has_function_privilege('service_role', p.oid, 'EXECUTE') s FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace WHERE ns.nspname = 'public' AND p.proname = $1`, [f]);
    t(`${f}: ${app ? 'la usa la app' : 'solo el servidor'}`, g && g.a === app && g.n === false && (srv == null || g.s === srv), g);
  }
  t('el rastro acepta «devuelta»', /devuelta/.test((await one(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname = 'arrival_dispatch_log_kind_valid'`)).d));
  t('despachar_llegadas llama a despacho_soltar_atrasadas', /despacho_soltar_atrasadas/.test((await one(`SELECT prosrc FROM pg_proc WHERE proname = 'despachar_llegadas'`)).prosrc));
  if (!prod) {
    await c.query('SAVEPOINT prueba');
    const J = await one(`SELECT id, organization_id org FROM public.profiles WHERE email = 'demo-admin@rendio.demo'`);
    const drv = async (e) => one(`SELECT dp.id, dp.profile_id, p.full_name FROM public.profiles p JOIN public.driver_profiles dp ON dp.profile_id = p.id WHERE p.email = $1`, [e]);
    const A = await drv('julian.lopez@rendio.com'), B = await drv('juan.franco@rendio.co');
    const X = await q(`SELECT ap.id, ap.profile_id FROM public.profiles p JOIN public.auxiliar_profiles ap ON ap.profile_id = p.id WHERE p.email IN ('prueba.mateo@rendio.demo', 'prueba.camila@rendio.demo') ORDER BY p.email`);
    const vehs = await q(`SELECT id FROM public.vehicles WHERE organization_id = $1 AND deleted_at IS NULL ORDER BY internal_code LIMIT 2`, [J.org]);
    if (!J || !A || !B || X.length < 2 || vehs.length < 2) throw new Error('faltan las cuentas de prueba de dev');
    const noAcomodar = () => c.query(`SELECT set_config('rendio.no_acomodar', 'on', true)`);
    await noAcomodar();
    await c.query(`UPDATE public.shifts SET status = 'closed', end_at = greatest(start_at, now()) WHERE organization_id = $1 AND status::text <> 'closed'`, [J.org]);
    await c.query(`DELETE FROM public.driver_locations WHERE recorded_at > now() - interval '1 hour'`);
    await c.query(`DELETE FROM public.route_assignments WHERE (driver_profile_id IN ($1, $2) OR (pool AND organization_id = $3)) AND planned_start_at BETWEEN now() - interval '12 hours' AND now() + interval '48 hours'`, [A.id, B.id, J.org]);
    await c.query(`UPDATE public.app_settings SET despacho_activo = true WHERE id = 'singleton'`);
    const hoy = await one(`SELECT (CASE WHEN (now() AT TIME ZONE 'America/Bogota')::time < time '02:00' THEN (now() AT TIME ZONE 'America/Bogota')::date - 1 ELSE (now() AT TIME ZONE 'America/Bogota')::date END)::text d,
       CASE WHEN (now() AT TIME ZONE 'America/Bogota')::time >= time '02:00' AND (now() AT TIME ZONE 'America/Bogota')::time < time '14:00' THEN 'am' ELSE 'pm' END b`);
    // Dentro de una transacción created_at es la hora en que empezó: lo «nuevo» se saca por id.
    const todos = async () => q(`SELECT id, profile_id, title, body, dedupe_key FROM public.notification_outbox WHERE created_at >= now() - interval '5 minutes'`);
    let vistos = new Set();
    const marca = async () => { vistos = new Set((await todos()).map((o) => o.id)); };
    const buzon = async () => (await todos()).filter((o) => !vistos.has(o.id));
    // Una llegada en espera (como la deja «Llegadas en espera» + Publicar) y una salida para tomar.
    const llegada = async (aux, vuelo, iniMin) => {
      await como(J.id);
      const rid = (await one(`SELECT public.admin_create_reservation($1, 'lle', now() + make_interval(mins => $2), $3, NULL, false) id`, [aux, iniMin - 20, vuelo])).id;
      await comoDb(); await noAcomodar();
      await c.query(`DELETE FROM public.route_stops WHERE reservation_id = $1`, [rid]);
      const ra = (await one(`INSERT INTO public.route_assignments (direction, status, planned_start_at, organization_id, pool, para_tomar) VALUES ('airport_to_home', 'planned', now() + make_interval(mins => $1), $2, true, true) RETURNING id`, [iniMin, J.org])).id;
      await c.query(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at) VALUES ($1, $2, 1, now() + make_interval(mins => $3 + 25))`, [ra, rid, iniMin]);
      return { ra, rid };
    };
    const salidaLibre = async (enMin) => {
      const ra = (await one(`INSERT INTO public.route_assignments (direction, status, planned_start_at, organization_id, pool, para_tomar) VALUES ('home_to_airport', 'planned', now() + make_interval(mins => $1), $2, true, true) RETURNING id`, [enMin, J.org])).id;
      await c.query(`INSERT INTO public.route_stops (route_assignment_id, stop_order, guest_name, guest_place, guest_lat, guest_lng, estimated_arrival_at) VALUES ($1, 1, 'Prueba Salida', 'Rionegro', 6.1551, -75.3737, now() + make_interval(mins => $2))`, [ra, enMin]);
      return ra;
    };
    await c.query(`INSERT INTO public.shifts (organization_id, driver_id, vehicle_id, status, start_at) VALUES ($1, $2, $3, 'active', now() - interval '2 hours'), ($1, $4, $5, 'active', now() - interval '2 hours')`, [J.org, A.id, vehs[0].id, B.id, vehs[1].id]);

    // ── 1. Las llegadas en espera no se toman a mano ───────────────────────────
    console.log('\n  1 · Las llegadas en espera no se toman a mano');
    const L1 = await llegada(X[0].id, 'AV9911', 90);
    const S1 = await salidaLibre(120);
    await como(A.profile_id);
    let abiertas = (await one(`SELECT public.driver_open_routes() j`)).j;
    t('«Vueltas para tomar» NO muestra la llegada en espera', !abiertas.some((v) => v.id === L1.ra), abiertas.map((v) => v.direction));
    t('…y SÍ sigue mostrando la salida', abiertas.some((v) => v.id === S1), abiertas.map((v) => v.direction));
    let err = null; try { await c.query('SAVEPOINT x'); await one(`SELECT public.driver_take_route($1) j`, [L1.ra]); } catch (e) { err = e; await c.query('ROLLBACK TO SAVEPOINT x'); }
    t('tomar la llegada a mano: «las reparte el sistema»', !!(err && err.code === 'P0001' && /reparte el sistema/.test(err.message)), err && err.message);
    await como(A.profile_id);
    const tomada = (await one(`SELECT public.driver_take_route($1) j`, [S1])).j;
    t('la salida se toma como siempre', tomada && tomada.id === S1, tomada);
    const suelta = (await one(`SELECT public.driver_release_route($1) j`, [S1])).j;
    t('…y se suelta como siempre', suelta && suelta.id === S1, suelta);
    await comoDb(); await noAcomodar();
    await marca();
    const nLle = (await one(`SELECT public.avisar_vuelta_para_tomar($1, now() + interval '90 minutes', 'Hay una vuelta para tomar', 'Llegada de las 10:00 (Mateo).', $2) n`, [J.org, 'tomarpub:' + L1.ra])).n;
    const nKey = (await one(`SELECT public.avisar_vuelta_para_tomar($1, now() + interval '90 minutes', 'Hay una vuelta libre', 'Se liberó la vuelta de las 10:00.', $2) n`, [J.org, 'releasedrv:' + L1.ra + ':x'])).n;
    t('«Hay una vuelta para tomar» NO suena por una llegada (por el texto y por la llave)', nLle === 0 && nKey === 0 && (await buzon()).length === 0, { nLle, nKey, b: await buzon() });
    await c.query(`SELECT public.avisar_vuelta_para_tomar($1, now() + interval '120 minutes', 'Hay una vuelta para tomar', 'Salida de las 11:00 (Prueba).', $2)`, [J.org, 'tomarpub:' + S1]);
    t('…y SÍ suena por una salida (a conductores del turno, o a jefes si no hay)', (await buzon()).some((o) => (o.dedupe_key || '').startsWith('tomarpub:' + S1)), await buzon());
    await c.query(`UPDATE public.app_settings SET despacho_activo = false WHERE id = 'singleton'`);
    await como(A.profile_id);
    abiertas = (await one(`SELECT public.driver_open_routes() j`)).j;
    await comoDb(); await noAcomodar();
    t('con el despacho APAGADO todo queda como antes: la llegada vuelve a la lista', abiertas.some((v) => v.id === L1.ra));
    await c.query(`UPDATE public.app_settings SET despacho_activo = true WHERE id = 'singleton'`);
    t('el sistema sí se la da a un conductor', (await one(`SELECT public.despacho_asignar($1, $2, NULL, now() + interval '90 minutes', 0) x`, [L1.ra, A.id])).x === true);
    await como(A.profile_id);
    err = null; try { await c.query('SAVEPOINT x'); await one(`SELECT public.driver_release_route($1) j`, [L1.ra]); } catch (e) { err = e; await c.query('ROLLBACK TO SAVEPOINT x'); }
    t('la llegada que dio el sistema no se suelta desde la app', !!(err && err.code === 'P0001' && /asignó el sistema/.test(err.message)), err && err.message);
    await comoDb(); await noAcomodar();
    await c.query(`DELETE FROM public.route_assignments WHERE id IN ($1, $2)`, [L1.ra, S1]);
    await c.query(`UPDATE public.reservations SET cancelled_at = now() WHERE id = $1`, [L1.rid]);

    // ── 2. El de apoyo se entera ───────────────────────────────────────────────
    console.log('\n  2 · El de apoyo se entera');
    await marca();
    await como(J.id); await one(`SELECT public.admin_set_support_duty($1::date, $2, $3)`, [hoy.d, hoy.b, B.id]); await comoDb();
    let bz = await buzon();
    t('al marcarlo: «Tienes el carro de apoyo 🚐» al conductor', bz.filter((o) => o.profile_id === B.profile_id && /^Tienes el carro de apoyo/.test(o.title)).length === 1, bz);
    t('el aviso dice el turno con horas', bz.some((o) => o.profile_id === B.profile_id && /de 2:00 (a|p)\. m\. a 2:00 (a|p)\. m\./.test(o.body)), bz.map((o) => o.body));
    await marca();
    await como(J.id); await one(`SELECT public.admin_set_support_duty($1::date, $2, $3)`, [hoy.d, hoy.b, B.id]); await comoDb();
    t('guardar el mismo otra vez no repite el aviso', (await buzon()).length === 0, await buzon());
    await como(J.id); await one(`SELECT public.admin_set_support_duty($1::date, $2, $3)`, [hoy.d, hoy.b, A.profile_id]); await comoDb();
    bz = await buzon();
    t('al cambiarlo: «Ya no tienes…» al anterior y «Tienes…» al nuevo', bz.some((o) => o.profile_id === B.profile_id && /^Ya no tienes/.test(o.title)) && bz.some((o) => o.profile_id === A.profile_id && /^Tienes el carro/.test(o.title)), bz);
    await marca();
    await como(J.id); await one(`SELECT public.admin_set_support_duty($1::date, $2, NULL)`, [hoy.d, hoy.b]); await comoDb();
    t('al quitarlo: «Ya no tienes el carro de apoyo»', (await buzon()).some((o) => o.profile_id === A.profile_id && /^Ya no tienes/.test(o.title)), await buzon());
    await marca();
    await como(J.id); await one(`SELECT public.admin_set_support_duty(($1::date - 3), $2, $3)`, [hoy.d, hoy.b, B.id]); await comoDb();
    t('un turno de días pasados no avisa', (await buzon()).length === 0, await buzon());

    // ── 3. Si el conductor asignado se atrasa ──────────────────────────────────
    console.log('\n  3 · Si el conductor asignado se atrasa, la llegada se reparte de nuevo');
    await noAcomodar();
    // A (fijo) va en una salida que arrancó tarde y sigue en curso, lejos; B está libre en JMC.
    const vieja = (await one(`INSERT INTO public.route_assignments (direction, status, planned_start_at, organization_id, driver_profile_id, pool) VALUES ('home_to_airport', 'planned', now() - interval '30 minutes', $1, $2, false) RETURNING id`, [J.org, A.id])).id;
    await c.query(`INSERT INTO public.route_stops (route_assignment_id, stop_order, guest_name, guest_place, guest_lat, guest_lng, estimated_arrival_at, status, actual_pickup_at) VALUES ($1, 1, 'Prueba Tarde', 'El Carmen', 6.0837, -75.3341, now() - interval '25 minutes', 'picked_up', now() - interval '3 minutes')`, [vieja]);
    await c.query(`INSERT INTO public.driver_locations (driver_profile_id, latitude, longitude, recorded_at) VALUES ($1, 6.1715, -75.4270, now())`, [B.id]);
    const L2 = await llegada(X[1].id, 'AV9912', 1);
    t('el sistema se la dio a A', (await one(`SELECT public.despacho_asignar($1, $2, NULL, now(), 0) x`, [L2.ra, A.id])).x === true);
    const ev = (await one(`SELECT public.cadena_evaluar($1, true) j`, [L2.ra])).j;
    t('el detector ve que A no alcanza (10+ min) y que B sí', ev && ev.known === true && ev.late_min >= 10 && ev.best && ev.best.dp === B.id, ev);
    await c.query('SAVEPOINT nadie');
    await c.query(`UPDATE public.shifts SET status = 'closed', end_at = now() WHERE driver_id = $1 AND status::text <> 'closed'`, [B.id]);
    await c.query(`DELETE FROM public.driver_locations WHERE driver_profile_id = $1`, [B.id]);
    await marca();
    const n0 = (await one(`SELECT public.despacho_soltar_atrasadas() n`)).n;
    const jefes = await q(`SELECT profile_id FROM public.ops_alert_recipients_of($1)`, [J.org]);
    bz = await buzon();
    t('si NADIE más alcanza: se queda con A y los jefes se enteran (uno por jefe)', n0 === 0 && (await one(`SELECT driver_profile_id d FROM public.route_assignments WHERE id = $1`, [L2.ra])).d === A.id
      && jefes.length > 0 && jefes.every((j) => bz.filter((o) => o.profile_id === j.profile_id && /necesita apoyo/.test(o.title)).length === 1), { n0, bz: bz.map((o) => o.title), jefes: jefes.length });
    await c.query('ROLLBACK TO SAVEPOINT nadie');
    await marca();
    const n1 = (await one(`SELECT public.despacho_soltar_atrasadas() n`)).n;
    const r1 = await one(`SELECT driver_profile_id d, vehicle_id v, pool FROM public.route_assignments WHERE id = $1`, [L2.ra]);
    t('con B libre en JMC: la llegada vuelve a la espera', n1 === 1 && r1.d === null && r1.v === null && r1.pool === true, { n1, r1 });
    bz = await buzon();
    t('a A le llega «Ya no recoges esta llegada»', bz.filter((o) => o.profile_id === A.profile_id && /^Ya no recoges esta llegada/.test(o.title)).length === 1, bz.map((o) => o.title));
    const rastro = await q(`SELECT kind, driver_profile_id, wait_min, detail FROM public.arrival_dispatch_log WHERE route_assignment_id = $1 ORDER BY created_at`, [L2.ra]);
    t('queda el rastro «devuelta» con cuánto iba tarde y quién alcanzaba', rastro.some((g) => g.kind === 'devuelta' && g.driver_profile_id === A.id && g.wait_min >= 10 && g.detail && g.detail.mejor === B.id), rastro);
    const foto = (await one(`SELECT public.despacho_estado() j`)).j.find((f) => f.org === J.org);
    const e2 = armarEstado(foto); const dec = Motor.decidir(e2.estado);
    const a2 = dec.asignar.find((x) => x.ids[0] === L2.ra);
    t('en esa misma pasada el motor se la da a B', !!(a2 && a2.carro === B.id), dec);
    await marca();
    t('…y la base la asigna', !!a2 && (await one(`SELECT public.despacho_asignar($1, $2, $3, $4, $5) x`, [L2.ra, B.id, e2.aISO(a2.recoge), e2.aISO(e2.estado.llegadas.find((l) => l.id === L2.ra).sale), Math.round(a2.espera)])).x === true);
    t('al tripulante le llega quién lo recoge AHORA', (await buzon()).some((o) => o.profile_id === X[1].profile_id && /te recoge/.test(o.title)), (await buzon()).map((o) => o.title));
    t('no hay vaivén: una segunda revisión no la vuelve a soltar', (await one(`SELECT public.despacho_soltar_atrasadas() n`)).n === 0);
    // Una que va a tiempo no se toca.
    const L3 = await llegada(X[0].id, 'AV9913', 5);
    await c.query(`SELECT public.despacho_asignar($1, $2, NULL, now(), 0)`, [L3.ra, B.id]);
    await c.query(`UPDATE public.route_assignments SET planned_start_at = now() + interval '40 minutes' WHERE id = $1`, [L2.ra]);
    t('la que va a tiempo no se toca', (await one(`SELECT public.despacho_soltar_atrasadas() n`)).n === 0 && (await one(`SELECT driver_profile_id d FROM public.route_assignments WHERE id = $1`, [L3.ra])).d === B.id);
    const txt = (await one(`SELECT public.despachar_llegadas() x`)).x;
    t('despachar_llegadas corre entera con el paso nuevo', /^(sin llegadas en espera|disparado con|faltan secretos|vault no disponible|pg_net no disponible)/.test(txt), txt);
    await c.query('ROLLBACK TO SAVEPOINT prueba');
  }
  if (fallas.length) throw new Error(fallas.length + ' comprobaciones fallaron');
  if (aplicar) { await c.query('COMMIT'); console.log('\n✔ 0163 APLICADA.'); } else { await c.query('ROLLBACK'); console.log('\n✔ En seco: todo bien. No se cambió nada.'); }
} catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error(`\n✗ ${e.message}\n  Se deshizo todo.`); process.exitCode = 1; } finally { await c.end(); }
