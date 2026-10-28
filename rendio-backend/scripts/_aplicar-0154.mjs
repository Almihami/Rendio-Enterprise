// 0154 · El acomodo de llegadas le pasa la vuelta al conductor que SÍ alcanza.
//
//   DEV:        cd rendio-backend && set -a && source <.env.dev> && set +a && node scripts/_aplicar-0154.mjs [--aplicar]
//   PRODUCCIÓN: cd rendio-backend && set -a && source <.env.main> && set +a && node scripts/_aplicar-0154.mjs --produccion [--aplicar]
//
// Todo en UNA transacción; solo con --aplicar (y todo bien) se confirma.
// ANTES: reub_nota y acomodar_eventualidades son EXACTAMENTE las de 0144 (huellas).
// En dev, además, el caso de Henry del 28-oct de punta a punta, con datos armados
// dentro de la transacción (se deshace siempre):
//   A tiene una llegada y justo después otra; el vuelo viene tarde y A no alcanza
//   la hora nueva. B está libre en JMC (GPS) con turno abierto →
//   · la vuelta se corre y queda con B (sigue siendo del tablero, no «para tomar»);
//   · avisos: A («la hace B»), B («Te asignamos una llegada»), jefes (una línea),
//     tripulante («te lleva B»); rastro resuelto «A no alcanzaba y se la pasé a B»;
//   · otra pasada no repite nada;
//   · sin B con turno abierto → para tomar, como antes;
//   · con el freno puesto (4 reasignaciones en 30 min) → para tomar, como antes;
//   · si A sí alcanza → se corre y sigue con A (aviso con la llave nueva, una vez).
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
console.log(aplicar ? `\n== APLICANDO 0154 en ${amb} ==` : `\n== 0154 EN SECO contra ${amb} (se deshace) ==`);
const fallas = [];
const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); if (!ok) fallas.push(n); };
const leer = (f) => readFileSync(new URL('../supabase/migrations/' + f, import.meta.url), 'utf8');
const cuerpo = (src, firma) => { const i = src.indexOf(firma); const a = src.indexOf('AS $$', i) + 5; return src.slice(a, src.indexOf('$$;', a)); };
const md5 = (s) => createHash('md5').update(s).digest('hex');
const fn = (n) => one(`SELECT prosrc FROM pg_proc WHERE proname = $1 AND pronamespace = 'public'::regnamespace`, [n]);
const sql = leer('0154_acomodo_asigna_conductor.sql').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const como = async (uid) => { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]); await c.query('SET LOCAL ROLE authenticated'); };
const comoDb = async () => { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', '', true)`); };

await c.query('BEGIN');
try {
  await c.query(`SET LOCAL lock_timeout = '5s'`);
  const v144 = leer('0144_avisos_por_turno_y_freno.sql');
  for (const [f, firma] of [['reub_nota', 'CREATE OR REPLACE FUNCTION public.reub_nota('], ['acomodar_eventualidades', 'CREATE OR REPLACE FUNCTION public.acomodar_eventualidades(']]) {
    const x = await fn(f); const esp = md5(cuerpo(v144, firma)); const ya = x && /0154/.test(x.prosrc);
    t(`${f} es la de 0144${ya ? ' (o ya la de 0154)' : ''}`, !!x && (ya || md5(x.prosrc) === esp), x ? md5(x.prosrc) + ' ≠ ' + esp : 'no existe');
  }
  for (const f of ['cadena_candidato', 'cadena_libre', 'conductores_del_turno', 'reub_extremos', 'reub_conductor_libre', 'short_name', 'ops_alert_recipients_of', 'trip_notify', 'reub_rastro', 'avisar_vuelta_para_tomar']) {
    t(`existe public.${f}()`, !!(await fn(f)));
  }
  if (fallas.length) throw new Error('la base no tiene lo que 0154 necesita, o las funciones no son las que se copiaron: NO se toca');

  await c.query(sql);

  t('acomodar_eventualidades y reub_nota llevan «0154»', /0154/.test((await fn('acomodar_eventualidades')).prosrc) && /0154/.test((await fn('reub_nota')).prosrc));
  for (const f of ['acomodo_otro_conductor', 'acomodo_reasignar_permitido']) {
    const g = await one(`SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE') a FROM pg_proc p WHERE p.proname = $1 AND p.pronamespace = 'public'::regnamespace`, [f]);
    t(`${f}: solo la base (la app no la puede llamar)`, g && g.a === false, g);
  }
  t('la nota dice a quién se la pasó', (await one(`SELECT public.reub_nota('{"kind":"retimed","from_at":"2026-10-28T16:37:00Z","start_at":"2026-10-28T17:05:00Z","driver_name":"Juan Ospina","reassigned_from":"Daniel Alvarez"}'::jsonb) n`)).n
    === 'Se resolvió sola: su vuelta pasó de las 11:37 a las 12:05; Daniel Alvarez no alcanzaba y se la pasé a Juan Ospina.');

  if (!prod) {
    await c.query('SAVEPOINT prueba');
    const org = (await one(`SELECT p.organization_id o FROM public.profiles p WHERE p.role = 'admin' AND p.deleted_at IS NULL AND p.organization_id IS NOT NULL
        AND (SELECT count(*) FROM public.driver_profiles dp JOIN public.profiles x ON x.id = dp.profile_id WHERE x.organization_id = p.organization_id AND x.deleted_at IS NULL AND x.is_active IS DISTINCT FROM false) >= 2
        AND EXISTS (SELECT 1 FROM public.auxiliar_profiles ap JOIN public.profiles x ON x.id = ap.profile_id WHERE x.organization_id = p.organization_id AND x.deleted_at IS NULL AND ap.residence_id IS NOT NULL)
        AND EXISTS (SELECT 1 FROM public.vehicles v WHERE v.organization_id = p.organization_id)
      LIMIT 1`) || {}).o;
    if (!org) console.log('  · (sin organización de prueba en dev)');
    else {
      const jefe = (await one(`SELECT id FROM public.profiles WHERE role = 'admin' AND organization_id = $1 AND deleted_at IS NULL LIMIT 1`, [org])).id;
      const [A, B] = await q(`SELECT dp.id, dp.profile_id, x.full_name FROM public.driver_profiles dp JOIN public.profiles x ON x.id = dp.profile_id
         WHERE x.organization_id = $1 AND x.deleted_at IS NULL AND x.is_active IS DISTINCT FROM false ORDER BY dp.id LIMIT 2`, [org]);
      const auxs = await q(`SELECT ap.id, ap.profile_id FROM public.auxiliar_profiles ap JOIN public.profiles x ON x.id = ap.profile_id
         WHERE x.organization_id = $1 AND x.deleted_at IS NULL AND ap.residence_id IS NOT NULL AND coalesce((to_jsonb(ap) ->> 'external')::boolean, false) = false
         ORDER BY ap.id LIMIT 2`, [org]);
      const veh = (await one(`SELECT id FROM public.vehicles WHERE organization_id = $1 ORDER BY id LIMIT 1`, [org])).id;
      // Limpio para la prueba: ni turnos abiertos, ni GPS recientes, ni vueltas de A/B cerca (todo se deshace).
      await c.query(`SELECT set_config('rendio.no_acomodar', 'on', true)`);
      await c.query(`UPDATE public.shifts SET status = 'closed', end_at = greatest(start_at, now()) WHERE organization_id = $1 AND status::text <> 'closed'`, [org]);
      await c.query(`DELETE FROM public.driver_locations WHERE recorded_at > now() - interval '1 hour'`);
      await c.query(`DELETE FROM public.route_assignments WHERE driver_profile_id IN ($1, $2) AND planned_start_at BETWEEN now() - interval '6 hours' AND now() + interval '12 hours'`, [A.id, B.id]);
      await c.query(`DELETE FROM public.incidents WHERE organization_id = $1 AND occurred_at > now() - interval '1 hour'`, [org]);
      // Las horas: la llegada sale de JMC dentro de 40 min; el vuelo baja 35 min tarde.
      const base = (await one(`SELECT date_trunc('minute', now()) + interval '40 minutes' b`)).b;
      await como(jefe);
      const rid = (await one(`SELECT public.admin_create_reservation($1, 'lle', $2::timestamptz - interval '20 minutes', 'AV9901', NULL, false) id`, [auxs[0].id, base])).id;
      const rid2 = (await one(`SELECT public.admin_create_reservation($1, 'lle', $2::timestamptz + interval '35 minutes', 'AV9902', NULL, false) id`, [auxs[1] ? auxs[1].id : auxs[0].id, base])).id;
      await comoDb();
      await c.query(`SELECT set_config('rendio.no_acomodar', 'on', true)`);
      const fc = (await one(`SELECT flight_code FROM public.reservations WHERE id = $1`, [rid])).flight_code;
      t('el pedido de prueba quedó con su vuelo (AV9901)', fc === 'AV9901', fc);
      const nueva = async (start, drv, r) => {
        const ra = (await one(`INSERT INTO public.route_assignments (direction, status, planned_start_at, driver_profile_id, organization_id)
           VALUES ('airport_to_home', 'planned', $1, $2, $3) RETURNING id`, [start, drv, org])).id;
        await c.query(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order) VALUES ($1, $2, 1)`, [ra, r]);
        return ra;
      };
      const V1 = await nueva(base, A.id, rid);
      // A tiene otra llegada justo después: con la hora nueva de V1 no alcanza.
      await nueva(new Date(Date.parse(base) + 45 * 60000).toISOString(), A.id, rid2);
      await c.query(`INSERT INTO public.flight_statuses (organization_id, flight_code, flight_date, direction, sched_at, estimated_at, status, delay_min, source, fetched_at)
         VALUES ($1, 'AV9901', (($2::timestamptz - interval '20 minutes') AT TIME ZONE 'America/Bogota')::date, 'airport_to_home',
                 $2::timestamptz - interval '20 minutes', $2::timestamptz + interval '15 minutes', 'delayed', 35, 'flightradar24', now())
         ON CONFLICT (organization_id, flight_code, flight_date, direction) DO UPDATE SET estimated_at = EXCLUDED.estimated_at, delay_min = 35, status = 'delayed', fetched_at = now()`, [org, base]);
      // B: turno abierto y en JMC (GPS de ahora).
      const turnoB = (await one(`INSERT INTO public.shifts (organization_id, driver_id, vehicle_id, status, start_at) VALUES ($1, $2, $3, 'active', now() - interval '1 hour') RETURNING id`, [org, B.id, veh])).id;
      await c.query(`INSERT INTO public.driver_locations (driver_profile_id, latitude, longitude, recorded_at) VALUES ($1, 6.1715, -75.4270, now())`, [B.id]);
      const avisos0 = (await one(`SELECT coalesce(max(id::text), '') m, count(*)::int n FROM public.notification_outbox`)).n;

      await c.query('SAVEPOINT caso');
      const r1 = (await one(`SELECT public.acomodar_eventualidades(now()) j`)).j;
      const v1 = await one(`SELECT planned_start_at, driver_profile_id, pool, coalesce(auto_created, false) auto FROM public.route_assignments WHERE id = $1`, [V1]);
      t('el acomodo corrió (sin errores)', r1 && r1.errores === 0 && r1.vuelos >= 1, r1);
      t('CASO HENRY: la vuelta se corrió y quedó con B (no «para tomar»)', v1 && v1.driver_profile_id === B.id && v1.pool === false && v1.auto === false && Date.parse(v1.planned_start_at) > Date.parse(base), v1);
      const out = await q(`SELECT profile_id, title, body FROM public.notification_outbox WHERE created_at >= now() - interval '1 minute' ORDER BY id`);
      const a = (pid, re) => out.find((o) => o.profile_id === pid && re.test(o.title));
      t('aviso a A: «Ya no haces una vuelta… la hace B»', !!a(A.profile_id, /Ya no haces una vuelta/) && /la hace /.test(a(A.profile_id, /Ya no haces/).body), out.filter((o) => o.profile_id === A.profile_id));
      t('aviso a B: «Te asignamos una llegada 🛬»', !!a(B.profile_id, /Te asignamos una llegada/), out.filter((o) => o.profile_id === B.profile_id));
      const jefes = await q(`SELECT profile_id FROM public.ops_alert_recipients_of($1)`, [org]);
      t('a los jefes, una línea «Pasé una llegada a otro conductor»', jefes.every((j) => out.filter((o) => o.profile_id === j.profile_id && /Pasé una llegada/.test(o.title)).length === 1), jefes.length);
      t('al tripulante: «… te lleva <B>»', !!out.find((o) => o.profile_id === auxs[0].profile_id && /te lleva /.test(o.body)), out.filter((o) => o.profile_id === auxs[0].profile_id));
      t('nadie recibe «Hay una vuelta para tomar» (ya tiene conductor)', !out.some((o) => /vuelta para tomar/.test(o.title)));
      const inc = await one(`SELECT status, resolution_notes FROM public.incidents WHERE reservation_id = $1 ORDER BY occurred_at DESC LIMIT 1`, [rid]);
      t('el rastro queda resuelto: «… no alcanzaba y se la pasé a …»', inc && inc.status === 'resolved' && /no alcanzaba y se la pasé a /.test(inc.resolution_notes || ''), inc);
      const r2 = (await one(`SELECT public.acomodar_eventualidades(now()) j`)).j;
      const n2 = (await one(`SELECT count(*)::int n FROM public.notification_outbox WHERE created_at >= now() - interval '1 minute'`)).n;
      t('otra pasada no la vuelve a mover ni repite avisos', n2 === out.length && (await one(`SELECT driver_profile_id d FROM public.route_assignments WHERE id = $1`, [V1])).d === B.id, { antes: out.length, despues: n2, r2 });
      await c.query('ROLLBACK TO SAVEPOINT caso');

      // Sin nadie con turno abierto → para tomar, como antes.
      await c.query('SAVEPOINT sinb');
      await c.query(`UPDATE public.shifts SET status = 'closed', end_at = now() WHERE id = $1`, [turnoB]);
      await one(`SELECT public.acomodar_eventualidades(now()) j`);
      const v2 = await one(`SELECT driver_profile_id, pool, coalesce(auto_created, false) auto FROM public.route_assignments WHERE id = $1`, [V1]);
      t('sin otro conductor con turno abierto: queda para tomar (como antes)', v2 && v2.driver_profile_id === null && v2.pool === true && v2.auto === true, v2);
      await c.query('ROLLBACK TO SAVEPOINT sinb');

      // Con el freno puesto (4 reasignaciones en la última media hora) → para tomar.
      await c.query('SAVEPOINT freno');
      for (let i = 0; i < 4; i++) {
        await c.query(`INSERT INTO public.incidents (organization_id, reservation_id, category, severity, status, description, scope, source, details, occurred_at, resolved_at)
           VALUES ($1, $2, 'flight_delay', 'low', 'resolved', 'prueba freno', 'operacion', 'system', jsonb_build_object('auto', true, 'reubicada', jsonb_build_object('reassigned_from', 'X', 'start_at', $3::text)), now(), now())`,
          [org, rid2, 'f' + i]);
      }
      t('el freno se pone con 4 reasignaciones en 30 min', (await one(`SELECT public.acomodo_reasignar_permitido($1) p`, [org])).p === false);
      await one(`SELECT public.acomodar_eventualidades(now()) j`);
      const v3 = await one(`SELECT driver_profile_id, pool FROM public.route_assignments WHERE id = $1`, [V1]);
      t('…y con el freno puesto queda para tomar (no reasigna)', v3 && v3.driver_profile_id === null && v3.pool === true, v3);
      await c.query('ROLLBACK TO SAVEPOINT freno');

      // Si A sí alcanza (sin la otra llegada) → se corre y sigue con A, un solo aviso.
      await c.query('SAVEPOINT alcanza');
      await c.query(`DELETE FROM public.route_assignments WHERE driver_profile_id = $1 AND id <> $2`, [A.id, V1]);
      await one(`SELECT public.acomodar_eventualidades(now()) j`);
      await one(`SELECT public.acomodar_eventualidades(now()) j`);
      const v4 = await one(`SELECT driver_profile_id, pool FROM public.route_assignments WHERE id = $1`, [V1]);
      const av4 = await q(`SELECT title FROM public.notification_outbox WHERE profile_id = $1 AND created_at >= now() - interval '1 minute'`, [A.profile_id]);
      t('si A alcanza: se corre y sigue con A, con UN aviso «Tu vuelta cambió de hora»', v4 && v4.driver_profile_id === A.id && v4.pool === false
        && av4.filter((x) => /Tu vuelta cambió de hora/.test(x.title)).length === 1, { v4, av4 });
      await c.query('ROLLBACK TO SAVEPOINT alcanza');
      void avisos0;
    }
    await c.query('ROLLBACK TO SAVEPOINT prueba');
  }

  if (fallas.length) throw new Error(`${fallas.length} comprobaciones fallaron`);
  if (aplicar) { await c.query('COMMIT'); console.log(`\n✓ 0154 APLICADA en ${amb}.`); }
  else { await c.query('ROLLBACK'); console.log(`\n✓ En seco: todo bien. No se tocó ${amb} (ROLLBACK). Para aplicar: --aplicar`); }
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error(`\n✗ ${e.message}\n  ROLLBACK: ${amb} quedó como estaba.`);
  process.exitCode = 1;
} finally { await c.end(); }
