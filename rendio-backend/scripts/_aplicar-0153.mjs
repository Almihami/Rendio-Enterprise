// 0153 · Los cambios de los tripulantes (registro + admin_cambios_tripulantes) y el
// pedido desde la ruta pegada sin que el sistema lo acomode (admin_create_reservation
// con p_acomodar).
//
//   DEV:        cd rendio-backend && set -a && source <.env.dev> && set +a && node scripts/_aplicar-0153.mjs [--aplicar]
//   PRODUCCIÓN: cd rendio-backend && set -a && source <.env.main> && set +a && node scripts/_aplicar-0153.mjs --produccion [--aplicar]
//
// Todo en UNA transacción; solo con --aplicar (y todo bien) se confirma.
// ANTES: admin_create_reservation es EXACTAMENTE la de 0139 (huella del cuerpo).
// En dev, además, una prueba de punta a punta con datos armados dentro de la
// transacción (se deshace siempre):
//   · el jefe le crea el pedido a un tripulante con p_acomodar = false → queda el
//     registro «nuevo» (Coordinación) y el sistema NO lo mete en ninguna vuelta;
//   · el tripulante cambia la hora y cancela → «hora» y «cancelado» (por él);
//   · admin_cambios_tripulantes los devuelve; un tripulante no puede leerlos;
//   · «Esa vuelta no existe» (Camilo, 28-oct): una vuelta del tablero con solo un
//     pasajero sin cuenta y sin organización no se encuentra; con la organización
//     (lo que ahora guarda saveRoutePlan) sí.
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
console.log(aplicar ? `\n== APLICANDO 0153 en ${amb} ==` : `\n== 0153 EN SECO contra ${amb} (se deshace) ==`);
const fallas = [];
const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); if (!ok) fallas.push(n); };
const leer = (f) => readFileSync(new URL('../supabase/migrations/' + f, import.meta.url), 'utf8');
const cuerpo = (src, firma) => { const i = src.indexOf(firma); const a = src.indexOf('AS $$', i) + 5; return src.slice(a, src.indexOf('$$;', a)); };
const md5 = (s) => createHash('md5').update(s).digest('hex');
const sql = leer('0153_cambios_tripulantes_y_pedido_desde_ruta.sql').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const como = async (uid) => { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]); await c.query('SET LOCAL ROLE authenticated'); };
const comoDb = async () => { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', '', true)`); };
const falla = async (s, v) => { await c.query('SAVEPOINT f'); try { await c.query(s, v); await c.query('RELEASE SAVEPOINT f'); return null; } catch (e) { await c.query('ROLLBACK TO SAVEPOINT f'); return e; } };

await c.query('BEGIN');
try {
  await c.query(`SET LOCAL lock_timeout = '5s'`);
  const f0 = await q(`SELECT p.prosrc, pg_get_function_identity_arguments(p.oid) args FROM pg_proc p WHERE p.proname = 'admin_create_reservation' AND p.pronamespace = 'public'::regnamespace`);
  const esp = md5(cuerpo(leer('0139_externos_sin_app.sql'), 'CREATE OR REPLACE FUNCTION public.admin_create_reservation('));
  const ya = f0.some((x) => /0153/.test(x.prosrc));
  t(`admin_create_reservation es la de 0139${ya ? ' (o ya la de 0153)' : ''}`, f0.length === 1 && (ya || md5(f0[0].prosrc) === esp), f0.map((x) => x.args + ' ' + md5(x.prosrc)).join(' | ') + ' ≠ ' + esp);
  for (const f of ['set_updated_at', 'current_user_org', 'current_user_role', 'tg_reservations_acomodar', 'auxiliar_cancel_reservation', 'admin_route_set_driver']) {
    t(`existe public.${f}()`, !!(await one(`SELECT 1 x FROM pg_proc WHERE proname = $1 AND pronamespace = 'public'::regnamespace`, [f])));
  }
  for (const col of ['reserve_place', 'service_level', 'residence_unit', 'cancellation_reason', 'cancelled_by']) {
    t(`reservations.${col} existe`, !!(await one(`SELECT 1 x FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'reservations' AND column_name = $1`, [col])));
  }
  if (fallas.length) throw new Error('la base no tiene lo que 0153 necesita, o admin_create_reservation no es la que se copió: NO se toca');

  await c.query(sql);

  const f1 = await q(`SELECT pg_get_function_identity_arguments(p.oid) args FROM pg_proc p WHERE p.proname = 'admin_create_reservation' AND p.pronamespace = 'public'::regnamespace`);
  t('admin_create_reservation: UNA sola, con p_acomodar', f1.length === 1 && /p_acomodar boolean/.test(f1[0].args), f1.map((x) => x.args).join(' | '));
  const rls = await one(`SELECT relrowsecurity r FROM pg_class WHERE oid = 'public.reservation_changes'::regclass`);
  t('reservation_changes con RLS', rls && rls.r === true);
  const trg = await q(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.reservations'::regclass AND tgname LIKE 'tr_reservations_cambios%' ORDER BY 1`);
  t('los dos triggers en reservations', trg.map((x) => x.tgname).join() === 'tr_reservations_cambios_ins,tr_reservations_cambios_upd', trg.map((x) => x.tgname).join());
  for (const f of ['admin_cambios_tripulantes', 'admin_create_reservation']) {
    const g = await one(`SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('anon', p.oid, 'EXECUTE') n FROM pg_proc p WHERE p.proname = $1 AND p.pronamespace = 'public'::regnamespace`, [f]);
    t(`${f}: la llama authenticated, no anon`, g && g.a && !g.n, g);
  }
  t('el trigger no se puede llamar desde la app', !(await one(`SELECT has_function_privilege('authenticated', 'public.tg_reservations_cambios()', 'EXECUTE') x`)).x);
  t('vuelo_de_notas lee «Vuelo AV9563. …»', (await one(`SELECT public.vuelo_de_notas('Vuelo av9563. Regreso (Pedido por Coordinación.)') v`)).v === 'AV9563');

  if (!prod) {
    await c.query('SAVEPOINT prueba');
    const jefe = await one(`SELECT p.id, p.organization_id o FROM public.profiles p WHERE p.role = 'admin' AND p.deleted_at IS NULL AND p.organization_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM public.auxiliar_profiles ap JOIN public.profiles x ON x.id = ap.profile_id WHERE x.organization_id = p.organization_id AND x.deleted_at IS NULL)
        AND EXISTS (SELECT 1 FROM public.driver_profiles dp JOIN public.profiles x ON x.id = dp.profile_id WHERE x.organization_id = p.organization_id AND x.deleted_at IS NULL)
      LIMIT 1`);
    if (!jefe) console.log('  · (sin organización de prueba en dev)');
    else {
      const aux = await one(`SELECT ap.id, ap.profile_id FROM public.auxiliar_profiles ap JOIN public.profiles x ON x.id = ap.profile_id
         WHERE x.organization_id = $1 AND x.deleted_at IS NULL AND coalesce((to_jsonb(ap) ->> 'external')::boolean, false) = false ORDER BY ap.id LIMIT 1`, [jefe.o]);
      const drv = await one(`SELECT dp.id FROM public.driver_profiles dp JOIN public.profiles x ON x.id = dp.profile_id WHERE x.organization_id = $1 AND x.deleted_at IS NULL ORDER BY dp.id LIMIT 1`, [jefe.o]);
      const cuando = (await one(`SELECT date_trunc('day', now() AT TIME ZONE 'America/Bogota') + interval '20 days 10 hours' AS l`)).l;
      const whenIso = (await one(`SELECT ($1::timestamp AT TIME ZONE 'America/Bogota') w`, [cuando])).w;
      // a) el jefe le crea el pedido (ruta pegada): sin acomodar.
      await como(jefe.id);
      const rid = (await one(`SELECT public.admin_create_reservation($1, 'sal', $2, NULL, 'Desde la ruta de Julián.', false) id`, [aux.id, whenIso])).id;
      t('el jefe le crea el pedido (p_acomodar = false)', !!rid);
      t('…y el interruptor rendio.no_acomodar queda apagado después', (await one(`SELECT coalesce(current_setting('rendio.no_acomodar', true), '') v`)).v === '');
      await comoDb();
      const enVuelta = (await one(`SELECT count(*)::int n FROM public.route_stops WHERE reservation_id = $1`, [rid])).n;
      const rastro = (await one(`SELECT count(*)::int n FROM public.incidents WHERE reservation_id = $1`, [rid])).n;
      t('…el sistema NO lo metió en ninguna vuelta ni dejó rastro (lo mete el jefe)', enVuelta === 0 && rastro === 0, { enVuelta, rastro });
      const r1 = await one(`SELECT kind, by_owner, actor_role, organization_id = $2 org FROM public.reservation_changes WHERE reservation_id = $1`, [rid, jefe.o]);
      t('…queda «nuevo» en el registro, hecho por Coordinación (no por el tripulante)', r1 && r1.kind === 'nuevo' && r1.by_owner === false && r1.actor_role === 'admin' && r1.org, r1);
      // b) el tripulante cambia la hora (como lo haría auxiliar_change_flight) y su punto no.
      await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: aux.profile_id, role: 'authenticated' })]);
      await c.query(`UPDATE public.reservations SET required_arrival_at = required_arrival_at + interval '40 minutes', notes = 'Vuelo AV9999. (Pedido por Coordinación.)' WHERE id = $1`, [rid]);
      await c.query(`UPDATE public.reservations SET calculated_pickup_at = now() WHERE id = $1`, [rid]).catch(() => {});
      await comoDb();
      const r2 = await q(`SELECT kind, by_owner, before, after FROM public.reservation_changes WHERE reservation_id = $1 ORDER BY created_at, kind`, [rid]);
      const cambio = r2.find((x) => x.kind !== 'nuevo');
      t('el tripulante cambia hora y vuelo: UNA fila «vuelo», por él, con la hora de antes y la de ahora', r2.length === 2 && cambio && cambio.kind === 'vuelo' && cambio.by_owner === true
        && cambio.before && cambio.after && cambio.after.vuelo === 'AV9999' && cambio.before.when && cambio.after.when && Date.parse(cambio.after.when) - Date.parse(cambio.before.when) === 40 * 60000, r2);
      t('…lo que no es un cambio del pedido (calculated_pickup_at) no deja fila', r2.length === 2);
      // c) cancela desde la app.
      await como(aux.profile_id);
      const e0 = await falla(`SELECT public.auxiliar_cancel_reservation($1, 'me cambiaron la programación')`, [rid]);
      t('el tripulante cancela desde la app', !e0, e0 && e0.message);
      await comoDb();
      const r3 = await one(`SELECT by_owner, after FROM public.reservation_changes WHERE reservation_id = $1 AND kind = 'cancelado'`, [rid]);
      t('…queda «cancelado», por él, con el motivo', r3 && r3.by_owner === true && r3.after && r3.after.motivo === 'me cambiaron la programación', r3);
      // d) el jefe lo ve.
      await como(jefe.id);
      const d0 = (await one(`SELECT ($1::timestamp - interval '10 hours') AT TIME ZONE 'America/Bogota' d`, [cuando])).d;
      const lista = (await one(`SELECT public.admin_cambios_tripulantes($1, $1::timestamptz + interval '28 hours') j`, [d0])).j;
      const mias = (lista || []).filter((x) => x.rid === rid);
      t('admin_cambios_tripulantes: los 3 (nuevo, vuelo, cancelado), lo más nuevo primero', mias.map((x) => x.kind).join() === 'cancelado,vuelo,nuevo', mias.map((x) => x.kind));
      t('…con su nombre, sentido y «cancelado»; a 20 días, NO es «tarde» (antes del corte)', mias.every((x) => x.name && x.dir === 'sal' && x.cancelled === true && x.tarde === false), mias[0]);
      // Para hoy a las 11:30 p. m. el corte (7:30 p. m. de ayer) ya pasó: «tarde».
      const hoyNoche = (await one(`SELECT (date_trunc('day', now() AT TIME ZONE 'America/Bogota') + interval '23 hours 30 minutes') AT TIME ZONE 'America/Bogota' w`)).w;
      const e5 = await falla(`SELECT public.admin_create_reservation($1, 'lle', $2, 'AV1234', NULL, false)`, [aux.id, hoyNoche]);
      if (e5) console.log('  · (no se probó «tarde»: ' + e5.message + ')');
      else {
        const d1 = (await one(`SELECT date_trunc('day', now() AT TIME ZONE 'America/Bogota') AT TIME ZONE 'America/Bogota' d`)).d;
        const hoy = ((await one(`SELECT public.admin_cambios_tripulantes($1, $1::timestamptz + interval '28 hours') j`, [d1])).j || []).filter((x) => x.kind === 'nuevo' && x.dir === 'lle' && x.after && x.after.vuelo === 'AV1234');
        t('un pedido para hoy en la noche, hecho ahora: «tarde» (después del corte)', hoy.length === 1 && hoy[0].tarde === true, hoy);
      }
      await comoDb();
      // e) un tripulante no puede leer los cambios.
      await como(aux.profile_id);
      const e1 = await falla(`SELECT public.admin_cambios_tripulantes(now(), now() + interval '1 day')`);
      t('un tripulante no puede leer los cambios (42501)', e1 && e1.code === '42501', e1 && e1.message);
      const e2 = await falla(`SELECT count(*) FROM public.reservation_changes`);
      const visibles = e2 ? null : (await one(`SELECT count(*)::int n FROM public.reservation_changes`)).n;
      t('…ni la tabla (RLS: 0 filas)', e2 || visibles === 0, e2 ? e2.message : visibles);
      await comoDb();
      // f) «Esa vuelta no existe»: la vuelta solo con un sin cuenta.
      const ra = (await one(`INSERT INTO public.route_assignments (direction, status, planned_start_at) VALUES ('home_to_airport', 'draft', now() + interval '20 days') RETURNING id`)).id;
      await c.query(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, guest_name, guest_place) VALUES ($1, NULL, 1, 'Prueba Sin Cuenta', 'Conjunto')`, [ra]);
      await como(jefe.id);
      const e3 = await falla(`SELECT public.admin_route_set_driver($1, $2)`, [ra, drv.id]);
      t('CAUSA: vuelta del tablero solo con un sin cuenta y sin organización → «Esa vuelta no existe»', e3 && /no existe/.test(e3.message), e3 ? e3.message : 'no falló');
      await comoDb();
      await c.query(`UPDATE public.route_assignments SET organization_id = $2 WHERE id = $1`, [ra, jefe.o]);
      await como(jefe.id);
      const e4 = await falla(`SELECT public.admin_route_set_driver($1, $2)`, [ra, drv.id]);
      t('ARREGLO: con la organización (la que ahora guarda Publicar) sí se publica sola', !e4, e4 && e4.message);
      await comoDb();
    }
    await c.query('ROLLBACK TO SAVEPOINT prueba');
  }

  if (fallas.length) throw new Error(`${fallas.length} comprobaciones fallaron`);
  if (aplicar) { await c.query('COMMIT'); console.log(`\n✓ 0153 APLICADA en ${amb}.`); }
  else { await c.query('ROLLBACK'); console.log(`\n✓ En seco: todo bien. No se tocó ${amb} (ROLLBACK). Para aplicar: --aplicar`); }
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error(`\n✗ ${e.message}\n  ROLLBACK: ${amb} quedó como estaba.`);
  process.exitCode = 1;
} finally { await c.end(); }
