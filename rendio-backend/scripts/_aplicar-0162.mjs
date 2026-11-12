// 0162 · El carro de apoyo: quién lo tiene, cuándo sale y cuántas vueltas hizo.
//   cd rendio-backend && set -a && source <.env.dev|.env.main> && set +a && node --experimental-strip-types scripts/_aplicar-0162.mjs [--produccion] [--aplicar]
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
const sql = readFileSync(new URL('../supabase/migrations/0162_carro_de_apoyo.sql', import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const como = async (uid) => { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]); await c.query('SET LOCAL ROLE authenticated'); };
const comoDb = async () => { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', '', true)`); };
console.log(`\n== 0162 ${aplicar ? 'APLICANDO' : 'EN SECO'} en ${prod ? 'PRODUCCIÓN' : 'dev'} ==`);
await c.query('BEGIN');
try {
  await c.query(`SET LOCAL lock_timeout = '5s'`);
  const d1 = await one(`SELECT prosrc FROM pg_proc WHERE proname = 'despacho_estado'`), d2 = await one(`SELECT prosrc FROM pg_proc WHERE proname = 'despacho_asignar'`);
  t('están 0161 (despacho_estado) y 0159 (despacho_asignar)', d1 && /0161|0162/.test(d1.prosrc) && d2 && /0159|0162/.test(d2.prosrc));
  if (fallas.length) throw new Error('faltan migraciones anteriores');
  await c.query(sql);
  for (const [f, app, srv] of [['admin_set_support_duty', true, null], ['admin_apoyo_resumen', true, null], ['apoyo_de_turno', false, true], ['despacho_estado', false, true], ['despacho_asignar', false, true]]) {
    const g = await one(`SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('anon', p.oid, 'EXECUTE') n, has_function_privilege('service_role', p.oid, 'EXECUTE') s FROM pg_proc p WHERE p.proname = $1 AND p.pronamespace = 'public'::regnamespace`, [f]);
    t(`${f}: ${app ? 'la usa el jefe desde la app' : 'solo el servidor'}`, g && g.a === app && g.n === false && (srv == null || g.s === srv), g);
  }
  t('support_duty con RLS', (await one(`SELECT relrowsecurity r FROM pg_class WHERE oid = 'public.support_duty'::regclass`)).r === true);
  if (!prod) {
    await c.query('SAVEPOINT prueba');
    const J = await one(`SELECT id, organization_id org FROM public.profiles WHERE email = 'demo-admin@rendio.demo'`);
    const drv = async (e) => one(`SELECT dp.id, dp.profile_id, p.full_name FROM public.profiles p JOIN public.driver_profiles dp ON dp.profile_id = p.id WHERE p.email = $1`, [e]);
    const A = await drv('julian.lopez@rendio.com'), B = await drv('juan.franco@rendio.co');
    const X = await q(`SELECT ap.id, ap.profile_id FROM public.profiles p JOIN public.auxiliar_profiles ap ON ap.profile_id = p.id WHERE p.email IN ('prueba.mateo@rendio.demo', 'prueba.camila@rendio.demo') ORDER BY p.email`);
    const veh = await one(`SELECT id FROM public.vehicles WHERE organization_id = $1 AND deleted_at IS NULL ORDER BY internal_code LIMIT 1`, [J.org]);
    await c.query(`SELECT set_config('rendio.no_acomodar', 'on', true)`);
    await c.query(`UPDATE public.shifts SET status = 'closed', end_at = greatest(start_at, now()) WHERE organization_id = $1 AND status::text <> 'closed'`, [J.org]);
    await c.query(`DELETE FROM public.driver_locations WHERE recorded_at > now() - interval '1 hour'`);
    await c.query(`DELETE FROM public.route_assignments WHERE (driver_profile_id IN ($1, $2) OR (pool AND organization_id = $3)) AND planned_start_at BETWEEN now() - interval '6 hours' AND now() + interval '12 hours'`, [A.id, B.id, J.org]);
    await c.query(`UPDATE public.app_settings SET despacho_activo = true WHERE id = 'singleton'`);
    const hoy = await one(`SELECT (CASE WHEN (now() AT TIME ZONE 'America/Bogota')::time < time '02:00' THEN (now() AT TIME ZONE 'America/Bogota')::date - 1 ELSE (now() AT TIME ZONE 'America/Bogota')::date END)::text d,
       CASE WHEN (now() AT TIME ZONE 'America/Bogota')::time >= time '02:00' AND (now() AT TIME ZONE 'America/Bogota')::time < time '14:00' THEN 'am' ELSE 'pm' END b`);
    // Un conductor cualquiera no puede definir el apoyo; el jefe sí (y con el id de perfil también).
    await como(A.profile_id);
    let negado = false; try { await c.query('SAVEPOINT x'); await one(`SELECT public.admin_set_support_duty($1::date, $2, $3)`, [hoy.d, hoy.b, B.id]); } catch (e) { negado = e.code === '42501'; await c.query('ROLLBACK TO SAVEPOINT x'); }
    t('un conductor NO puede definir el apoyo', negado);
    await como(J.id);
    await one(`SELECT public.admin_set_support_duty($1::date, $2, $3)`, [hoy.d, hoy.b, B.profile_id]);
    await comoDb();
    t('el jefe define el apoyo y apoyo_de_turno lo devuelve para AHORA', (await one(`SELECT public.apoyo_de_turno($1, now()) x`, [J.org])).x === B.id);
    t('…y no para el otro turno', (await one(`SELECT public.apoyo_de_turno($1, now() + interval '13 hours') x`, [J.org])).x !== B.id);
    // A: carro fijo, con turno, lejos (El Carmen). B: tiene el apoyo, SIN turno abierto.
    await c.query(`INSERT INTO public.shifts (organization_id, driver_id, vehicle_id, status, start_at) VALUES ($1, $2, $3, 'active', now() - interval '1 hour')`, [J.org, A.id, veh.id]);
    await c.query(`INSERT INTO public.driver_locations (driver_profile_id, latitude, longitude, recorded_at) VALUES ($1, 6.0837, -75.3341, now()), ($2, 6.1715, -75.4270, now())`, [A.id, B.id]);
    const base = (await one(`SELECT date_trunc('minute', now()) b`)).b;
    const llegada = async (aux, enMin, vuelo) => {
      const hora = new Date(Date.parse(base) + enMin * 60000).toISOString();
      await como(J.id);
      const rid = (await one(`SELECT public.admin_create_reservation($1, 'lle', $2::timestamptz, $3, NULL, false) id`, [aux, hora, vuelo])).id;
      await comoDb(); await c.query(`SELECT set_config('rendio.no_acomodar', 'on', true)`);
      await c.query(`DELETE FROM public.route_stops WHERE reservation_id = $1`, [rid]);
      const dep = (await one(`SELECT coalesce(public.flight_deplane_min($1), 20) m`, [vuelo])).m;
      const ra = (await one(`INSERT INTO public.route_assignments (direction, status, planned_start_at, organization_id, pool, para_tomar) VALUES ('airport_to_home', 'planned', $1::timestamptz + make_interval(mins => $2), $3, true, true) RETURNING id`, [hora, dep, J.org])).id;
      await c.query(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at) VALUES ($1, $2, 1, $3::timestamptz + make_interval(mins => $4 + 25))`, [ra, rid, hora, dep]);
      return { ra, rid };
    };
    const L1 = await llegada(X[0].id, -8, 'AV9904');
    const foto = async () => (await one(`SELECT public.despacho_estado() j`)).j.find((f) => f.org === J.org);
    const f1 = await foto(); const cA = f1.carros.find((x) => x.dp === A.id), cB = f1.carros.find((x) => x.dp === B.id);
    t('el de apoyo entra a la foto SIN turno abierto y marcado', cB && cB.apoyo === true && cA && cA.apoyo === false, f1.carros);
    let e = armarEstado(f1); let d = Motor.decidir(e.estado);
    const a1 = d.asignar.find((x) => x.ids[0] === L1.ra);
    t('el fijo está lejos (espera > 15): el motor llama al APOYO', a1 && a1.carro === B.id && a1.apoyo === true && a1.espera <= 15, d);
    await c.query('SAVEPOINT caso');
    await one(`SELECT public.despacho_asignar($1, $2, $3, $3, $4) x`, [L1.ra, B.id, e.aISO(a1.recoge), Math.round(a1.espera)]);
    const out = await q(`SELECT profile_id, title, body FROM public.notification_outbox WHERE created_at >= now() - interval '1 minute'`);
    t('al de apoyo: «Apoyo: llegada para ti ✈️»', out.some((o) => o.profile_id === B.profile_id && /^Apoyo: llegada para ti/.test(o.title)), out.filter((o) => o.profile_id === B.profile_id));
    const jefes = await q(`SELECT profile_id FROM public.ops_alert_recipients_of($1)`, [J.org]);
    t('a los jefes: «Salió el carro de apoyo 🚐» (uno por jefe)', jefes.every((j) => out.filter((o) => o.profile_id === j.profile_id && /Salió el carro de apoyo/.test(o.title)).length === 1), out.map((o) => o.title));
    t('al tripulante: quién lo recoge', out.some((o) => o.profile_id === X[0].profile_id && /te recoge/.test(o.title)));
    t('el rastro queda marcado como apoyo', (await one(`SELECT detail FROM public.arrival_dispatch_log WHERE route_assignment_id = $1`, [L1.ra])).detail.apoyo === true);
    // Cuenta de vueltas: 0 hasta que recoge a alguien; después 1 vuelta, 1 persona.
    await como(J.id);
    const r0 = await q(`SELECT * FROM public.admin_apoyo_resumen($1::date, $1::date)`, [hoy.d]);
    await comoDb();
    await c.query(`UPDATE public.route_stops SET status = 'delivered', actual_pickup_at = now(), actual_dropoff_at = now() WHERE route_assignment_id = $1`, [L1.ra]);
    await como(J.id);
    const r1 = await q(`SELECT * FROM public.admin_apoyo_resumen($1::date, $1::date)`, [hoy.d]);
    await comoDb();
    t('conteo para el pago: 0 antes de recoger, 1 vuelta y 1 persona después', r0.length === 0 && r1.length === 1 && r1[0].driver_profile_id === B.id && r1[0].vueltas === 1 && r1[0].personas === 1, { r0, r1 });
    await c.query('ROLLBACK TO SAVEPOINT caso');
    // Si el fijo SÍ alcanza, el apoyo no se toca.
    await c.query(`INSERT INTO public.driver_locations (driver_profile_id, latitude, longitude, recorded_at) VALUES ($1, 6.1715, -75.4270, now() + interval '1 second')`, [A.id]);
    d = Motor.decidir(armarEstado(await foto()).estado);
    t('si el carro fijo alcanza, el apoyo NO sale', d.asignar.length === 1 && d.asignar[0].carro === A.id && d.asignar[0].apoyo === false, d);
    // Sin nadie con el apoyo: como antes.
    await como(J.id); await one(`SELECT public.admin_set_support_duty($1::date, $2, NULL)`, [hoy.d, hoy.b]); await comoDb();
    const f3 = await foto();
    t('sin apoyo definido: la foto solo trae a los de turno', f3.carros.length === 1 && f3.carros[0].apoyo === false, f3.carros);
    await c.query('ROLLBACK TO SAVEPOINT prueba');
  }
  if (fallas.length) throw new Error(fallas.length + ' comprobaciones fallaron');
  if (aplicar) { await c.query('COMMIT'); console.log('\n✔ 0162 APLICADA.'); } else { await c.query('ROLLBACK'); console.log('\n✔ En seco: todo bien. No se cambió nada.'); }
} catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error(`\n✗ ${e.message}\n  Se deshizo todo.`); process.exitCode = 1; } finally { await c.end(); }
