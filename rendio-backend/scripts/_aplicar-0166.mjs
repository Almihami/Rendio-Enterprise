// 0166 · El que tiene el carro de apoyo también ve y toma las llegadas.
//   cd rendio-backend && set -a && source <.env.dev|.env.main> && set +a && node scripts/_aplicar-0166.mjs [--produccion] [--aplicar]
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
const sql = readFileSync(new URL('../supabase/migrations/0166_apoyo_ve_y_toma.sql', import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const como = async (uid) => { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]); await c.query('SET LOCAL ROLE authenticated'); };
const comoDb = async () => { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', '', true)`); };
const falla = async (s, v) => { await c.query('SAVEPOINT f'); try { await c.query(s, v); await c.query('RELEASE SAVEPOINT f'); return null; } catch (e) { await c.query('ROLLBACK TO SAVEPOINT f'); return e.message; } };
const def = async (n) => (await one(`SELECT pg_get_functiondef(p.oid) d FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $1`, [n]))?.d || '';
console.log(`\n== 0166 ${aplicar ? 'APLICANDO' : 'EN SECO'} en ${prod ? 'PRODUCCIÓN' : 'dev'} ==`);
await c.query('BEGIN');
try {
  await c.query(`SET LOCAL lock_timeout = '5s'`);
  t('está 0165 (despacho_tomable)', !!(await one(`SELECT 1 x FROM pg_proc WHERE proname = 'despacho_tomable'`)));
  t('driver_open_routes es la de 0165', /nunca al que tiene el carro de apoyo/.test(await def('driver_open_routes')));
  t('driver_take_route es la de 0165', /Tienes el carro de apoyo: las llegadas te las da el sistema/.test(await def('driver_take_route')));
  if (fallas.length) throw new Error('la base no está como se esperaba');
  await c.query(sql);
  const g = Object.fromEntries((await q(`SELECT p.proname n, has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('anon', p.oid, 'EXECUTE') an FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('driver_open_routes','driver_take_route')`)).map((r) => [r.n, r]));
  t('los conductores siguen pudiendo listar y tomar', g.driver_open_routes?.a === true && g.driver_take_route?.a === true && g.driver_open_routes?.an === false && g.driver_take_route?.an === false, g);
  t('ya no hay bloqueo al de apoyo', !/Tienes el carro de apoyo: las llegadas/.test(await def('driver_take_route')) && !/apoyo_de_turno/.test(await def('driver_open_routes')));
  t('la ventana de 40 min sigue', /despacho_tomable/.test(await def('driver_open_routes')) && /Todavía no/.test(await def('driver_take_route')));
  if (!prod) {
    await c.query('SAVEPOINT prueba');
    const A = await one(`SELECT dp.id dp, p.id prof, p.organization_id org FROM public.profiles p JOIN public.driver_profiles dp ON dp.profile_id = p.id WHERE p.email = 'demo-conductor@rendio.demo'`);
    const B = await one(`SELECT dp.id dp, p.id prof FROM public.profiles p JOIN public.driver_profiles dp ON dp.profile_id = p.id WHERE p.organization_id = $1 AND p.role = 'driver' AND p.deleted_at IS NULL AND p.is_active IS DISTINCT FROM false AND p.id <> $2 ORDER BY p.created_at LIMIT 1`, [A.org, A.prof]);
    await c.query(`UPDATE public.app_settings SET despacho_activo = true WHERE id = 'singleton'`);
    await c.query(`DELETE FROM public.support_duty WHERE organization_id = $1`, [A.org]);
    await c.query(`INSERT INTO public.support_duty (organization_id, day, band, driver_profile_id)
                   SELECT $1, CASE WHEN l::time < time '02:00' THEN l::date - 1 ELSE l::date END, CASE WHEN l::time >= time '02:00' AND l::time < time '14:00' THEN 'am' ELSE 'pm' END, $2
                     FROM (SELECT now() AT TIME ZONE 'America/Bogota' l) z`, [A.org, B.dp]);
    const vuelta = async (min, nombre) => {
      const r = await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at, pool, para_tomar, organization_id)
                           VALUES (NULL, NULL, 'airport_to_home', 'planned', now() + make_interval(mins => $1), true, true, $2) RETURNING id`, [min, A.org]);
      await c.query(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, guest_name, guest_place) VALUES ($1, NULL, 1, $2, 'Prueba 0166')`, [r.id, nombre]);
      return r.id;
    };
    const R1 = await vuelta(20, 'Cerca Uno'), R2 = await vuelta(180, 'Lejos Dos'), R3 = await vuelta(15, 'Cerca Tres');
    const lista = async (uid) => { await como(uid); const r = await one(`SELECT public.driver_open_routes() x`); await comoDb(); return (r.x || []).map((o) => o.id); };
    let L = await lista(B.prof);
    t('el de apoyo VE la llegada que sale en 20 min', L.includes(R1), L.length);
    t('…y no la de dentro de 3 horas (misma ventana que todos)', !L.includes(R2));
    const jefes = (await q(`SELECT profile_id FROM public.ops_alert_recipients_of($1)`, [A.org])).map((r) => r.profile_id);
    const antes = new Set((await q(`SELECT id FROM public.notification_outbox WHERE title LIKE 'Salió el carro de apoyo%'`)).map((o) => o.id));
    await como(B.prof);
    let e = await falla(`SELECT public.driver_take_route($1)`, [R2]);
    t('el de apoyo tampoco puede tomar con horas de anticipación', /Todavía no/.test(e || ''), e);
    const r1 = await falla(`SELECT public.driver_take_route($1)`, [R1]);
    await comoDb();
    t('el de apoyo PUEDE tomar la que ya sale', r1 === null && (await one(`SELECT driver_profile_id dp FROM public.route_assignments WHERE id = $1`, [R1])).dp === B.dp, r1);
    const lg = await one(`SELECT kind, detail FROM public.arrival_dispatch_log WHERE route_assignment_id = $1`, [R1]);
    t('rastro «tomada» con apoyo = true', lg && lg.kind === 'tomada' && lg.detail && lg.detail.apoyo === true && lg.detail.por === 'conductor', lg);
    const nuevos = (await q(`SELECT profile_id, body FROM public.notification_outbox WHERE title LIKE 'Salió el carro de apoyo%'`)).filter((o) => !antes.has(o.id) && true);
    const av = await q(`SELECT id, profile_id, body FROM public.notification_outbox WHERE title LIKE 'Salió el carro de apoyo%' AND dedupe_key LIKE $1`, ['desp-apoyo-sale:' + R1 + ':%']);
    t(`a los jefes (${jefes.length}) les llega «Salió el carro de apoyo»`, jefes.length > 0 && av.length === jefes.length && /tomó la llegada de Cerca en JMC a las /.test(av[0].body), av.map((o) => o.body));
    await como(A.prof);
    const r3 = await falla(`SELECT public.driver_take_route($1)`, [R3]);
    await comoDb();
    const lg3 = await one(`SELECT kind, detail FROM public.arrival_dispatch_log WHERE route_assignment_id = $1`, [R3]);
    t('un conductor fijo toma igual que antes, sin aviso de apoyo', r3 === null && lg3 && lg3.detail.apoyo === false && !(await one(`SELECT 1 x FROM public.notification_outbox WHERE dedupe_key LIKE $1`, ['desp-apoyo-sale:' + R3 + ':%'])), { r3, lg3 });
    t('el sistema no le quita al de apoyo la que tomó', (await one(`SELECT public.despacho_asignar($1, $2, now(), now(), 0) x`, [R1, A.dp])).x === false);
    t('la revisión de atrasados corre sin error', (await falla(`SELECT public.despacho_soltar_atrasadas()`)) === null);
    await c.query('ROLLBACK TO SAVEPOINT prueba');
    t('los datos de la prueba se deshicieron', !(await one(`SELECT 1 x FROM public.route_stops WHERE guest_place = 'Prueba 0166'`)));
  }
  if (fallas.length) throw new Error(fallas.length + ' comprobaciones fallaron');
  if (aplicar) { await c.query('COMMIT'); console.log('\n✔ 0166 APLICADA.'); } else { await c.query('ROLLBACK'); console.log('\n✔ En seco: todo bien. No se cambió nada.'); }
} catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error(`\n✗ ${e.message}\n  Se deshizo todo.`); process.exitCode = 1; } finally { await c.end(); }
