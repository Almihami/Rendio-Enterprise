// 0161 · El conductor con una llegada ya asignada queda libre después de ella (asigna y avisa).
//   cd rendio-backend && set -a && source <.env.dev|.env.main> && set +a && node --experimental-strip-types scripts/_aplicar-0161.mjs [--produccion] [--aplicar]
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
const sql = readFileSync(new URL('../supabase/migrations/0161_despacho_libre_despues_de_llegada.sql', import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
console.log(`\n== 0161 ${aplicar ? 'APLICANDO' : 'EN SECO'} en ${prod ? 'PRODUCCIÓN' : 'dev'} ==`);
await c.query('BEGIN');
try {
  await c.query(`SET LOCAL lock_timeout = '5s'`);
  t('está la 0158 (despacho_estado)', !!(await one(`SELECT 1 x FROM pg_proc WHERE proname = 'despacho_estado'`)));
  if (fallas.length) throw new Error('falta la 0158');
  await c.query(sql);
  const g = await one(`SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('service_role', p.oid, 'EXECUTE') s FROM pg_proc p WHERE p.proname = 'despacho_estado'`);
  t('despacho_estado: solo el servidor', g && g.a === false && g.s === true, g);
  if (!prod) {
    await c.query('SAVEPOINT prueba');
    const J = await one(`SELECT id, organization_id org FROM public.profiles WHERE email = 'demo-admin@rendio.demo'`);
    const B = await one(`SELECT dp.id FROM public.profiles p JOIN public.driver_profiles dp ON dp.profile_id = p.id WHERE p.email = 'juan.franco@rendio.co'`);
    const X = await q(`SELECT ap.id FROM public.profiles p JOIN public.auxiliar_profiles ap ON ap.profile_id = p.id WHERE p.email IN ('prueba.mateo@rendio.demo', 'prueba.camila@rendio.demo') ORDER BY p.email`);
    const veh = await one(`SELECT id FROM public.vehicles WHERE organization_id = $1 AND deleted_at IS NULL ORDER BY internal_code LIMIT 1`, [J.org]);
    await c.query(`SELECT set_config('rendio.no_acomodar', 'on', true)`);
    await c.query(`UPDATE public.shifts SET status = 'closed', end_at = greatest(start_at, now()) WHERE organization_id = $1 AND status::text <> 'closed'`, [J.org]);
    await c.query(`DELETE FROM public.driver_locations WHERE recorded_at > now() - interval '1 hour'`);
    await c.query(`DELETE FROM public.route_assignments WHERE (driver_profile_id = $1 OR (pool AND organization_id = $2)) AND planned_start_at BETWEEN now() - interval '6 hours' AND now() + interval '12 hours'`, [B.id, J.org]);
    await c.query(`INSERT INTO public.shifts (organization_id, driver_id, vehicle_id, status, start_at) VALUES ($1, $2, $3, 'active', now() - interval '1 hour')`, [J.org, B.id, veh.id]);
    await c.query(`INSERT INTO public.driver_locations (driver_profile_id, latitude, longitude, recorded_at) VALUES ($1, 6.1715, -75.4270, now())`, [B.id]);
    await c.query(`UPDATE public.app_settings SET despacho_activo = true WHERE id = 'singleton'`);
    const base = (await one(`SELECT date_trunc('minute', now()) b`)).b;
    const llegada = async (aux, enMin, vuelo) => {
      const hora = new Date(Date.parse(base) + enMin * 60000).toISOString();
      await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: J.id, role: 'authenticated' })]); await c.query('SET LOCAL ROLE authenticated');
      const rid = (await one(`SELECT public.admin_create_reservation($1, 'lle', $2::timestamptz, $3, NULL, false) id`, [aux, hora, vuelo])).id;
      await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', '', true)`); await c.query(`SELECT set_config('rendio.no_acomodar', 'on', true)`);
      await c.query(`DELETE FROM public.route_stops WHERE reservation_id = $1`, [rid]);
      const dep = (await one(`SELECT coalesce(public.flight_deplane_min($1), 20) m`, [vuelo])).m;
      const ra = (await one(`INSERT INTO public.route_assignments (direction, status, planned_start_at, organization_id, pool, para_tomar) VALUES ('airport_to_home', 'planned', $1::timestamptz + make_interval(mins => $2), $3, true, true) RETURNING id`, [hora, dep, J.org])).id;
      await c.query(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at) VALUES ($1, $2, 1, $3::timestamptz + make_interval(mins => $4 + 25))`, [ra, rid, hora, dep]);
      return ra;
    };
    // Dos llegadas que salen casi juntas y UN solo conductor, decididas en revisiones distintas.
    const V1 = await llegada(X[0].id, -8, 'AV9906'), V2 = await llegada(X[1].id, -6, 'AV9907');
    const foto = async () => (await one(`SELECT public.despacho_estado() j`)).j.find((f) => f.org === J.org);
    let e = armarEstado(await foto()); let d = Motor.decidir(e.estado);
    const a1 = d.asignar.find((x) => x.ids[0] === V1);
    t('1ª revisión: la primera llegada va al conductor, sin espera', a1 && a1.carro === B.id && a1.espera <= 5, d);
    await one(`SELECT public.despacho_asignar($1, $2, $3, $3, 0) x`, [V1, B.id, e.aISO(a1.recoge)]);
    const f2 = await foto(); const cB = f2.carros.find((x) => x.dp === B.id);
    const finV1 = Date.parse((await one(`SELECT (public.reub_extremos($1)).fin_at f`, [V1])).f);
    t('2ª revisión: el conductor aparece libre DESPUÉS de la llegada que ya tiene', cB && Date.parse(cB.free_at) >= finV1 && cB.air === false && cB.salida === null, { cB, finV1: new Date(finV1).toISOString() });
    e = armarEstado(f2); d = Motor.decidir(e.estado);
    const a2 = d.asignar.find((x) => x.ids[0] === V2);
    t('…y la segunda SE ASIGNA al mismo conductor (antes: «ningún conductor alcanza»)', a2 && a2.carro === B.id && a2.espera > 15, d);
    t('…con el aviso de espera larga, no «sin carro»', d.avisos.some((v) => v.id === V2 && v.tipo === 'espera_larga') && !d.avisos.some((v) => v.tipo === 'sin_carro'), d.avisos);
    // Las salidas siguen mandando: con una SALIDA encima no se le da la llegada.
    await c.query(`UPDATE public.route_assignments SET driver_profile_id = NULL WHERE id = $1`, [V1]);
    const sal = (await one(`INSERT INTO public.route_assignments (direction, status, planned_start_at, driver_profile_id, organization_id) VALUES ('home_to_airport', 'planned', now() + interval '25 minutes', $1, $2) RETURNING id`, [B.id, J.org])).id;
    await c.query(`INSERT INTO public.route_stops (route_assignment_id, guest_name, guest_lat, guest_lng, stop_order, estimated_arrival_at) VALUES ($1, 'Prueba', 6.1537, -75.3738, 1, now() + interval '25 minutes')`, [sal]);
    const f3 = await foto(); const cB3 = f3.carros.find((x) => x.dp === B.id);
    t('con una SALIDA en 25 min: sigue siendo compromiso (las salidas mandan)', cB3 && cB3.salida && cB3.salida.air === false, cB3);
    d = Motor.decidir(armarEstado(f3).estado);
    t('…y no se le quita a su salida: aviso «sin carro»', d.asignar.length === 0 && d.avisos.some((v) => v.tipo === 'sin_carro'), d);
    await c.query('ROLLBACK TO SAVEPOINT prueba');
  }
  if (fallas.length) throw new Error(fallas.length + ' comprobaciones fallaron');
  if (aplicar) { await c.query('COMMIT'); console.log('\n✔ 0161 APLICADA.'); } else { await c.query('ROLLBACK'); console.log('\n✔ En seco: todo bien. No se cambió nada.'); }
} catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error(`\n✗ ${e.message}\n  Se deshizo todo.`); process.exitCode = 1; } finally { await c.end(); }
