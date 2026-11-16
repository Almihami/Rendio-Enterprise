// 0165 · Llegadas: el sistema reparte Y el conductor puede tomar.
//   cd rendio-backend && set -a && source <.env.dev|.env.main> && set +a && node scripts/_aplicar-0165.mjs [--produccion] [--aplicar]
// Sin --aplicar corre EN SECO: aplica, prueba (en dev, con datos armados) y deshace todo.
import pg from 'pg';
import { readFileSync } from 'node:fs';
const DEV = 'lxlphbafhtphulanhzlp', PROD = 'wvuurnfdrrdondrbbkhd';
const prod = process.argv.includes('--produccion'), aplicar = process.argv.includes('--aplicar');
const esperado = prod ? PROD : DEV;
if ((process.env.SUPABASE_PROJECT_REF || '') !== esperado || !(process.env.SUPABASE_URL || '').includes(esperado)) { console.error('ABORT: ambiente equivocado'); process.exit(2); }
const c = new pg.Client({ host: prod ? 'aws-1-us-west-2.pooler.supabase.com' : 'aws-1-us-east-1.pooler.supabase.com', port: 5432, database: 'postgres', user: 'postgres.' + esperado, password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false }, statement_timeout: 60000 });
await c.connect();
const q = async (s, v) => (await c.query(s, v)).rows, one = async (s, v) => (await q(s, v))[0];
const fallas = []; const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + JSON.stringify(d) : ''}`); if (!ok) fallas.push(n); };
const sql = readFileSync(new URL('../supabase/migrations/0165_llegadas_reparte_y_se_toman.sql', import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const como = async (uid) => { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]); await c.query('SET LOCAL ROLE authenticated'); };
const comoDb = async () => { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', '', true)`); };
// Una llamada que DEBE fallar: devuelve el mensaje (o null si no falló), sin tumbar la transacción.
const falla = async (s, v) => { await c.query('SAVEPOINT f'); try { await c.query(s, v); await c.query('RELEASE SAVEPOINT f'); return null; } catch (e) { await c.query('ROLLBACK TO SAVEPOINT f'); return e.message; } };
const def = async (n) => (await one(`SELECT pg_get_functiondef(p.oid) d FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $1`, [n]))?.d || '';
console.log(`\n== 0165 ${aplicar ? 'APLICANDO' : 'EN SECO'} en ${prod ? 'PRODUCCIÓN' : 'dev'} ==`);
await c.query('BEGIN');
try {
  await c.query(`SET LOCAL lock_timeout = '5s'`);
  t('está 0163 (despacho_soltar_atrasadas) y 0162 (apoyo_de_turno)', !!(await one(`SELECT 1 x FROM pg_proc WHERE proname = 'despacho_soltar_atrasadas'`)) && !!(await one(`SELECT 1 x FROM pg_proc WHERE proname = 'apoyo_de_turno'`)));
  // Lo que hay ahora tiene que ser lo de 0163: si alguien cambió estas funciones después, no se pisa a ciegas.
  const antesAbrir = await def('driver_open_routes'), antesTomar = await def('driver_take_route'), antesSoltar = await def('despacho_soltar_atrasadas');
  t('driver_open_routes es la de 0163', /0163: con el despacho encendido las llegadas las reparte el sistema/.test(antesAbrir) && !/0165/.test(antesAbrir));
  t('driver_take_route es la de 0163', /Las llegadas las reparte el sistema cuando el vuelo confirma la hora/.test(antesTomar) && !/0165/.test(antesTomar));
  t('despacho_soltar_atrasadas es la de 0163', /kind = 'devuelta'/.test(antesSoltar) && !/0165/.test(antesSoltar));
  if (fallas.length) throw new Error('la base no está como se esperaba');
  const filas0 = (await one(`SELECT count(*)::int n FROM public.arrival_dispatch_log`)).n;
  await c.query(sql);
  t('existe despacho_tomable', !!(await one(`SELECT 1 x FROM pg_proc WHERE proname = 'despacho_tomable'`)));
  const g = Object.fromEntries((await q(`SELECT p.proname n, has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('anon', p.oid, 'EXECUTE') an FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('driver_open_routes','driver_take_route','despacho_soltar_atrasadas','despacho_tomable')`)).map((r) => [r.n, r]));
  t('los conductores siguen pudiendo listar y tomar', g.driver_open_routes?.a === true && g.driver_take_route?.a === true && g.driver_open_routes?.an === false && g.driver_take_route?.an === false, g);
  t('despacho_tomable y despacho_soltar_atrasadas son solo del servidor', g.despacho_tomable?.a === false && g.despacho_soltar_atrasadas?.a === false, g);
  t('el rastro acepta «tomada»', /tomada/.test((await one(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname = 'arrival_dispatch_log_kind_valid'`)).d));
  t('no se tocó ninguna fila del rastro', (await one(`SELECT count(*)::int n FROM public.arrival_dispatch_log`)).n === filas0);
  t('driver_release_route no cambió (soltar sigue siendo de Coordinación)', /Esta llegada te la asignó el sistema/.test(await def('driver_release_route')));

  if (!prod) {
    await c.query('SAVEPOINT prueba');
    const A = await one(`SELECT dp.id dp, p.id prof, p.organization_id org FROM public.profiles p JOIN public.driver_profiles dp ON dp.profile_id = p.id WHERE p.email = 'demo-conductor@rendio.demo'`);
    const B = await one(`SELECT dp.id dp, p.id prof FROM public.profiles p JOIN public.driver_profiles dp ON dp.profile_id = p.id WHERE p.organization_id = $1 AND p.role = 'driver' AND p.deleted_at IS NULL AND p.is_active IS DISTINCT FROM false AND p.id <> $2 ORDER BY p.created_at LIMIT 1`, [A.org, A.prof]);
    t('hay dos conductores de prueba', !!A && !!B, { A, B });
    await c.query(`UPDATE public.app_settings SET despacho_activo = true WHERE id = 'singleton'`);
    await c.query(`DELETE FROM public.support_duty WHERE organization_id = $1`, [A.org]);
    const vuelta = async (dir, min, nombre) => {
      const r = await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at, pool, para_tomar, organization_id)
                           VALUES (NULL, NULL, $1, 'planned', now() + make_interval(mins => $2), true, true, $3) RETURNING id`, [dir, min, A.org]);
      await c.query(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, guest_name, guest_place) VALUES ($1, NULL, 1, $2, 'Prueba 0165')`, [r.id, nombre]);
      return r.id;
    };
    const R1 = await vuelta('airport_to_home', 25, 'Cerca Uno'), R2 = await vuelta('airport_to_home', 180, 'Lejos Dos'), R3 = await vuelta('home_to_airport', 180, 'Salida Tres');
    const lista = async (uid) => { await como(uid); const r = await one(`SELECT public.driver_open_routes() x`); await comoDb(); return (r.x || []).map((o) => o.id); };
    let L = await lista(A.prof);
    t('el conductor ve la llegada que sale en 25 min', L.includes(R1), L.length);
    t('NO ve la llegada de dentro de 3 horas', !L.includes(R2));
    t('las salidas para tomar siguen saliendo igual', L.includes(R3));
    await como(A.prof);
    let e = await falla(`SELECT public.driver_take_route($1)`, [R2]);
    t('no deja tomar la de dentro de 3 horas («Todavía no…»)', /Todavía no/.test(e || ''), e);
    const r1 = await falla(`SELECT public.driver_take_route($1)`, [R1]);
    await comoDb();
    const f1 = await one(`SELECT driver_profile_id dp, status FROM public.route_assignments WHERE id = $1`, [R1]);
    t('deja tomar la que sale en 25 min', r1 === null && f1.dp === A.dp, { r1, f1 });
    const lg = await q(`SELECT kind, driver_profile_id dp, who, detail FROM public.arrival_dispatch_log WHERE route_assignment_id = $1`, [R1]);
    t('queda el rastro «tomada» por ese conductor', lg.length === 1 && lg[0].kind === 'tomada' && lg[0].dp === A.dp && lg[0].who === 'Cerca', lg);
    const asg = await one(`SELECT public.despacho_asignar($1, $2, now(), now(), 0) x`, [R1, B.dp]);
    t('el sistema NO puede dársela a otro (despacho_asignar → false)', asg.x === false && (await one(`SELECT driver_profile_id dp FROM public.route_assignments WHERE id = $1`, [R1])).dp === A.dp, asg);
    // Aunque tuviera un rastro viejo de «asignada» al mismo conductor, tomada manda: no vuelve a la espera.
    await c.query(`INSERT INTO public.arrival_dispatch_log (organization_id, route_assignment_id, driver_profile_id, kind, wait_min) VALUES ($1, $2, $3, 'asignada', 0)`, [A.org, R1, A.dp]);
    const st = await falla(`SELECT public.despacho_soltar_atrasadas()`);
    t('la revisión de atrasados corre sin error y no se la quita', st === null && (await one(`SELECT driver_profile_id dp FROM public.route_assignments WHERE id = $1`, [R1])).dp === A.dp, st);
    t('no quedó ningún «devuelta» para esa vuelta', !(await one(`SELECT 1 x FROM public.arrival_dispatch_log WHERE route_assignment_id = $1 AND kind = 'devuelta'`, [R1])));
    const disp = await one(`SELECT public.despachar_llegadas() x`);
    t('el disparo del reparto sigue contestando', typeof disp.x === 'string' && !/error/i.test(disp.x), disp);
    await como(B.prof);
    e = await falla(`SELECT public.driver_take_route($1)`, [R1]);
    await comoDb();
    t('otro conductor ya no la puede tomar («ya la tomó otro conductor»)', /ya la tomó otro conductor/.test(e || ''), e);
    L = await lista(B.prof);
    t('ni le sale en la lista al otro', !L.includes(R1));
    // El de apoyo
    const R4 = await vuelta('airport_to_home', 20, 'Cerca Cuatro');
    await c.query(`INSERT INTO public.support_duty (organization_id, day, band, driver_profile_id)
                   SELECT $1, CASE WHEN l::time < time '02:00' THEN l::date - 1 ELSE l::date END, CASE WHEN l::time >= time '02:00' AND l::time < time '14:00' THEN 'am' ELSE 'pm' END, $2
                     FROM (SELECT now() AT TIME ZONE 'America/Bogota' l) z`, [A.org, B.dp]);
    L = await lista(B.prof);
    t('al que tiene el apoyo NO le salen las llegadas', !L.includes(R4), L.length);
    t('…pero sí las salidas para tomar', L.includes(R3));
    await como(B.prof);
    e = await falla(`SELECT public.driver_take_route($1)`, [R4]);
    await comoDb();
    t('el de apoyo no puede tomar una llegada', /carro de apoyo/.test(e || ''), e);
    L = await lista(A.prof);
    t('al conductor fijo sí le sale esa llegada', L.includes(R4));
    // El sistema sigue pudiendo repartir la que nadie tomó
    const asg4 = await one(`SELECT public.despacho_asignar($1, $2, now() + interval '20 minutes', now() + interval '20 minutes', 0) x`, [R4, A.dp]);
    t('la que nadie tomó, el sistema la reparte como siempre', asg4.x === true && (await one(`SELECT driver_profile_id dp FROM public.route_assignments WHERE id = $1`, [R4])).dp === A.dp, asg4);
    await como(A.prof);
    e = await falla(`SELECT public.driver_release_route($1)`, [R4]);
    await comoDb();
    t('la que dio el sistema no se suelta desde la app (como antes)', /te la asignó el sistema/.test(e || ''), e);
    // Despacho apagado = como antes de 0163
    await c.query(`UPDATE public.app_settings SET despacho_activo = false WHERE id = 'singleton'`);
    L = await lista(B.prof);
    t('con el reparto APAGADO las llegadas se ofrecen a todos sin ventana (como antes)', L.includes(R2), L.length);
    await como(B.prof);
    const r2 = await falla(`SELECT public.driver_take_route($1)`, [R2]);
    await comoDb();
    t('…y se pueden tomar, sin rastro de despacho', r2 === null && !(await one(`SELECT 1 x FROM public.arrival_dispatch_log WHERE route_assignment_id = $1`, [R2])), r2);
    await c.query('ROLLBACK TO SAVEPOINT prueba');
    t('los datos de la prueba se deshicieron', !(await one(`SELECT 1 x FROM public.route_stops WHERE guest_place = 'Prueba 0165'`)));
  }
  if (fallas.length) throw new Error(fallas.length + ' comprobaciones fallaron');
  if (aplicar) { await c.query('COMMIT'); console.log('\n✔ 0165 APLICADA.'); } else { await c.query('ROLLBACK'); console.log('\n✔ En seco: todo bien. No se cambió nada.'); }
} catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error(`\n✗ ${e.message}\n  Se deshizo todo.`); process.exitCode = 1; } finally { await c.end(); }
