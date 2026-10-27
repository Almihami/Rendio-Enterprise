// 0151 · «Para tomar» desde el tablero, tomar aunque se cruce (avisa a Coordinación)
// y el conductor arma su llegada (agregar / soltar).
//
//   DEV:        cd rendio-backend && set -a && source <.env.dev> && set +a && node scripts/_aplicar-0151.mjs [--aplicar]
//   PRODUCCIÓN: cd rendio-backend && set -a && source <.env.main> && set +a && node scripts/_aplicar-0151.mjs --produccion [--aplicar]
//
// Todo en UNA transacción; solo con --aplicar (y todo bien) se confirma.
// ANTES: driver_take_route es EXACTAMENTE la de 0147 (huella del cuerpo).
// DESPUÉS: columna para_tomar, driver_take_route con «0151» y las funciones nuevas.
// En dev, además, una prueba de punta a punta con datos armados dentro de la
// transacción (se deshace siempre): un conductor con una llegada de 2, otra persona
// en la vuelta de otro conductor → candidatos, montarla, soltar a una (queda para
// tomar y la ve el otro conductor), el otro la toma aunque se le cruza (aviso a los
// jefes) y los avisos de cada paso.
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

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
console.log(aplicar ? `\n== APLICANDO 0151 en ${amb} ==` : `\n== 0151 EN SECO contra ${amb} (se deshace) ==`);
const fallas = [];
const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); if (!ok) fallas.push(n); };
const leer = (f) => readFileSync(new URL('../supabase/migrations/' + f, import.meta.url), 'utf8');
const cuerpo = (src, firma) => { const i = src.indexOf(firma); const a = src.indexOf('AS $$', i) + 5; return src.slice(a, src.indexOf('$$;', a)); };
const md5 = (s) => createHash('md5').update(s).digest('hex');
const fn = (n) => one(`SELECT prosrc FROM pg_proc WHERE proname = $1 AND pronamespace = 'public'::regnamespace`, [n]);
const sql = leer('0151_para_tomar_y_conductor.sql').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const como = async (uid) => { await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]); await c.query('SET LOCAL ROLE authenticated'); };
const comoDb = async () => { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', '', true)`); };
const falla = async (s, v) => { await c.query('SAVEPOINT f'); try { await c.query(s, v); await c.query('RELEASE SAVEPOINT f'); return null; } catch (e) { await c.query('ROLLBACK TO SAVEPOINT f'); return e; } };

await c.query('BEGIN');
try {
  await c.query(`SET LOCAL lock_timeout = '5s'`);
  const t0 = await fn('driver_take_route');
  const esp = md5(cuerpo(leer('0147_aviso_regreso_hotel.sql'), 'CREATE OR REPLACE FUNCTION public.driver_take_route('));
  const ya = t0 && /0151/.test(t0.prosrc);
  t(`driver_take_route es la de 0147${ya ? ' (o ya la de 0151)' : ''}`, !!t0 && (ya || md5(t0.prosrc) === esp), t0 ? md5(t0.prosrc) + ' ≠ ' + esp : 'no existe');
  for (const f of ['avisar_vuelta_para_tomar', 'hora_que_importa', 'lugar_del_regreso', 'reub_extremos', 'reub_conductor_libre', 'sync_calculated_pickup', 'trip_notify', 'my_driver_profile_id']) {
    t(`existe public.${f}()`, !!(await fn(f)));
  }
  if (fallas.length) throw new Error('la base no tiene lo que 0151 necesita, o driver_take_route no es la que se copió: NO se toca');

  await c.query(sql);

  t('driver_take_route lleva «0151»', /0151/.test((await fn('driver_take_route')).prosrc));
  const col = await one(`SELECT data_type, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'route_assignments' AND column_name = 'para_tomar'`);
  t('route_assignments.para_tomar (boolean, false)', col && col.data_type === 'boolean' && /false/.test(col.column_default || ''), col);
  for (const f of ['driver_llegada_candidatos', 'driver_llegada_agregar', 'driver_llegada_soltar', 'admin_routes_offer']) {
    const g = await one(`SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('anon', p.oid, 'EXECUTE') n FROM pg_proc p WHERE p.proname = $1 AND p.pronamespace = 'public'::regnamespace`, [f]);
    t(`${f}: la llama authenticated, no anon`, g && g.a && !g.n, g);
  }
  t('las ayudantes no se pueden llamar desde la app', !(await one(`SELECT has_function_privilege('authenticated', 'public.llegada_editable(uuid, uuid)', 'EXECUTE') x`)).x);

  if (!prod) {
    await c.query('SAVEPOINT prueba');
    // Datos armados: organización con jefe, 2 conductores y 3 tripulantes.
    const org = (await one(`SELECT p.organization_id o FROM public.profiles p WHERE p.role = 'admin' AND p.deleted_at IS NULL
        AND (SELECT count(*) FROM public.driver_profiles dp JOIN public.profiles x ON x.id = dp.profile_id WHERE x.organization_id = p.organization_id) >= 2
        AND (SELECT count(*) FROM public.auxiliar_profiles ap JOIN public.profiles x ON x.id = ap.profile_id WHERE x.organization_id = p.organization_id) >= 3
      LIMIT 1`) || {}).o;
    if (!org) console.log('  · (sin organización de prueba en dev)');
    else {
      const [d1, d2] = await q(`SELECT dp.id, dp.profile_id FROM public.driver_profiles dp JOIN public.profiles x ON x.id = dp.profile_id WHERE x.organization_id = $1 ORDER BY dp.id LIMIT 2`, [org]);
      const aux = await q(`SELECT ap.id FROM public.auxiliar_profiles ap JOIN public.profiles x ON x.id = ap.profile_id WHERE x.organization_id = $1 ORDER BY ap.id LIMIT 3`, [org]);
      const jefes = (await one(`SELECT count(*)::int n FROM public.ops_alert_recipients_of($1)`, [org])).n;
      await c.query(`SET LOCAL session_replication_role = replica`);   // sin acomodo automático ni avisos de los disparadores
      const base = await one(`SELECT * FROM public.reservations LIMIT 1`);
      const resv = [];
      for (const a of aux) {
        const r = await one(`INSERT INTO public.reservations SELECT (jsonb_populate_record(NULL::public.reservations, to_jsonb(b) || jsonb_build_object(
            'id', gen_random_uuid(), 'auxiliar_profile_id', $2::uuid, 'direction', 'airport_to_home', 'required_arrival_at', now() + interval '3 hours',
            'cancelled_at', NULL, 'status_a2h', 'scheduled', 'status_h2a', NULL, 'flight_id', NULL, 'flight_code', 'AV9999'))).*
          FROM public.reservations b WHERE b.id = $1 RETURNING id`, [base.id, a.id]);
        resv.push(r.id);
      }
      const ruta = async (dp, ids, extra = '') => {
        const r = await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at${extra ? ', pool, organization_id' : ''})
          VALUES ($1, NULL, 'airport_to_home', 'planned', now() + interval '3 hours 20 minutes'${extra ? ', true, $2' : ''}) RETURNING id`, extra ? [dp, org] : [dp]);
        for (let i = 0; i < ids.length; i++) await c.query(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order) VALUES ($1, $2, $3)`, [r.id, ids[i], i + 1]);
        return r.id;
      };
      const R1 = await ruta(d1.id, [resv[0], resv[1]]);
      const R2 = await ruta(d2.id, [resv[2]]);
      // Una salida de d2 a la misma hora: lo que se toma después se le cruza.
      const R3 = await one(`INSERT INTO public.route_assignments (driver_profile_id, direction, status, planned_start_at) VALUES ($1, 'home_to_airport', 'planned', now() + interval '3 hours 20 minutes') RETURNING id`, [d2.id]);
      await c.query(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order) SELECT $1, b.id, 1 FROM public.reservations b WHERE b.direction = 'home_to_airport' AND b.cancelled_at IS NULL LIMIT 1`, [R3.id]);
      await c.query(`SET LOCAL session_replication_role = origin`);
      const avisos = async (pre) => (await one(`SELECT count(*)::int n FROM public.notification_outbox WHERE dedupe_key LIKE $1`, [pre + '%'])).n;

      // 1. Candidatos para la llegada de d1: está la de d2 (con su nombre).
      await como(d1.profile_id);
      const cands = (await one(`SELECT public.driver_llegada_candidatos($1) j`, [R1])).j;
      const cand = (cands || []).find((x) => x.rid === resv[2]);
      t('candidatos: sale la persona que va con otro conductor, con su hora y con quién va', !!cand && cand.hora && cand.actual && cand.actual !== 'Sin carro', cands);
      t('…y no salen los que ya van en su vuelta', !(cands || []).some((x) => x.rid === resv[0] || x.rid === resv[1]));
      // 2. Montarla.
      const ag = (await one(`SELECT public.driver_llegada_agregar($1, $2) j`, [R1, resv[2]])).j;
      await comoDb();
      const enR1 = (await q(`SELECT reservation_id FROM public.route_stops WHERE route_assignment_id = $1 ORDER BY stop_order`, [R1])).map((x) => x.reservation_id);
      t('agregar: queda en su llegada, de última', enR1.length === 3 && enR1[2] === resv[2], enR1);
      t('…la vuelta del otro conductor, vacía, se borró', !(await one(`SELECT 1 x FROM public.route_assignments WHERE id = $1`, [R2])));
      t('…avisos: al tripulante, al otro conductor y a los jefes', (await avisos('llegadaadd:')) === 1 && (await avisos('llegadaquita:')) === 1 && (await avisos('llegadaadd-j:')) === jefes,
        [await avisos('llegadaadd:'), await avisos('llegadaquita:'), await avisos('llegadaadd-j:'), jefes]);
      // 3. Soltar a la primera.
      const st0 = (await one(`SELECT id FROM public.route_stops WHERE route_assignment_id = $1 AND reservation_id = $2`, [R1, resv[0]])).id;
      await como(d1.profile_id);
      const so = (await one(`SELECT public.driver_llegada_soltar($1, $2) j`, [R1, st0])).j;
      await comoDb();
      const nueva = await one(`SELECT ra.pool, ra.para_tomar, ra.organization_id = $2 org, ra.driver_profile_id, ra.status,
          (SELECT array_agg(reservation_id) FROM public.route_stops WHERE route_assignment_id = ra.id) gente FROM public.route_assignments ra WHERE ra.id = $1`, [so.id, org]);
      t('soltar: queda sola en una vuelta para tomar (pool + para_tomar, sin conductor, de la organización)', nueva && nueva.pool && nueva.para_tomar && nueva.org && !nueva.driver_profile_id && nueva.status === 'planned' && nueva.gente.length === 1 && nueva.gente[0] === resv[0], nueva);
      t('…avisos: a los jefes y al tripulante', (await avisos('llegadasuelta-j:')) === jefes && (await avisos('llegadasuelta-t:')) === 1, [await avisos('llegadasuelta-j:'), await avisos('llegadasuelta-t:')]);
      // 4. El otro conductor la ve y la toma, aunque se le cruza con su salida.
      await como(d2.profile_id);
      const libres = (await one(`SELECT public.driver_open_routes() j`)).j;
      t('el otro conductor la ve en «Vueltas para tomar» (marcada «se cruza»)', (libres || []).some((x) => x.id === so.id && x.cruza === true), (libres || []).map((x) => [x.id === so.id, x.cruza]));
      const tk = (await one(`SELECT public.driver_take_route($1) j`, [so.id])).j;
      await comoDb();
      t('la toma aunque se cruza (antes no lo dejaba) y la respuesta lo dice', tk && tk.id === so.id && typeof tk.cruza === 'string', tk);
      t('…a los jefes: «⚠️ … tomó una vuelta que se le cruza»', (await avisos('takecruza:')) === jefes, await avisos('takecruza:'));
      // 5. Lo que no se puede.
      await como(d2.profile_id);
      const e1 = await falla(`SELECT public.driver_llegada_agregar($1, $2)`, [R1, resv[1]]);
      t('agregar a la vuelta de otro conductor: «Esa vuelta no es tuya»', e1 && /no es tuya/.test(e1.message), e1 && e1.message);
      const e2 = await falla(`SELECT public.driver_llegada_candidatos($1)`, [R3.id]);
      t('en una salida no: «Solo se agrega o se suelta gente en una llegada»', e2 && /llegada/.test(e2.message), e2 && e2.message);
      await comoDb();
      // En el aeropuerto con alguien ya a bordo: sí se puede (es cuando ve «ya llegó»), pero no soltar al que subió.
      const subio = (await one(`UPDATE public.route_stops SET status = 'picked_up' WHERE route_assignment_id = $1 AND stop_order = (SELECT min(stop_order) FROM public.route_stops WHERE route_assignment_id = $1) RETURNING id`, [R1])).id;
      await como(d1.profile_id);
      const e5 = await falla(`SELECT public.driver_llegada_candidatos($1)`, [R1]);
      t('con alguien ya a bordo en JMC: todavía puede agregar', !e5, e5 && e5.message);
      const e6 = await falla(`SELECT public.driver_llegada_soltar($1, $2)`, [R1, subio]);
      t('…pero no soltar al que ya se subió', e6 && /ya se subió/.test(e6.message), e6 && e6.message);
      await comoDb();
      await c.query(`UPDATE public.route_stops SET status = 'delivered' WHERE id = $1`, [subio]);
      await como(d1.profile_id);
      const e3 = await falla(`SELECT public.driver_llegada_candidatos($1)`, [R1]);
      t('ya entregó a alguien (salió de JMC): no se le agrega ni se suelta', e3 && /ya salió de JMC/.test(e3.message), e3 && e3.message);
      const e4 = await falla(`SELECT public.admin_routes_offer(ARRAY[$1]::uuid[])`, [so.id]);
      t('admin_routes_offer: un conductor no la puede llamar', e4 && e4.code === '42501', e4 && e4.message);
      await comoDb();
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
