// 0172 · «Soltar» en JMC = se demora → la siguiente recogida (reubicar_reserva, motivo 'soltada').
//   cd rendio-backend && set -a && source <.env.dev|.env.main> && set +a && node scripts/_aplicar-0172.mjs [--produccion] [--aplicar]
// Sin --aplicar: EN SECO (ROLLBACK). Antes de tocar nada comprueba que driver_llegada_soltar sea la de 0151 y
// reubicar_reserva la de 0171 (o ya las de 0172). El caso armado (solo en dev) SIEMPRE se deshace (savepoint):
// una llegada con tres personas, una vuelta en espera que sale de JMC en minutos, y se suelta a cada una.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const pg = createRequire('/Users/harold/Documents/Rendio-Drivers/Proyect-main-0164/rendio-backend/scripts/x.js')('pg');
const DEV = 'lxlphbafhtphulanhzlp', PROD = 'wvuurnfdrrdondrbbkhd';
const prod = process.argv.includes('--produccion'), aplicar = process.argv.includes('--aplicar');
const esperado = prod ? PROD : DEV;
if ((process.env.SUPABASE_PROJECT_REF || '') !== esperado || !(process.env.SUPABASE_URL || '').includes(esperado)) { console.error(`ABORT: se esperaba ${prod ? 'PRODUCCIÓN' : 'dev'} (${esperado})`); process.exit(2); }
const c = new pg.Client({ host: prod ? 'aws-1-us-west-2.pooler.supabase.com' : 'aws-1-us-east-1.pooler.supabase.com', port: 5432, database: 'postgres', user: 'postgres.' + esperado, password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false }, statement_timeout: 60000 });
await c.connect();
const q = async (s, v) => (await c.query(s, v)).rows, one = async (s, v) => (await q(s, v))[0];
const fallas = []; const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + (typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 500) : ''}`); if (!ok) fallas.push(n); };
const hm = (x) => (x ? new Date(x).toLocaleTimeString('en-GB', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit' }) : '--');
const leer = (f) => readFileSync(new URL('../supabase/migrations/' + f, import.meta.url), 'utf8');
const cuerpo = (src, firma) => { const i = src.indexOf(firma); const a = src.indexOf('AS $$', i) + 5; return src.slice(a, src.indexOf('$$;', a)); };
const md5 = (s) => createHash('md5').update(s).digest('hex');
const fn = (n) => one(`SELECT prosrc FROM pg_proc WHERE proname = $1 AND pronamespace = 'public'::regnamespace`, [n]);
const sql = leer('0172_soltar_a_su_hora.sql').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const como = async (uid) => { await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]); await c.query('SET LOCAL ROLE authenticated'); };
const comoDb = async () => { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', '', true)`); };
const falla = async (s, v) => { await c.query('SAVEPOINT f'); try { await c.query(s, v); await c.query('RELEASE SAVEPOINT f'); return null; } catch (e) { await c.query('ROLLBACK TO SAVEPOINT f'); return e; } };

console.log(`\n== 0172 ${aplicar ? 'APLICANDO' : 'EN SECO'} en ${prod ? 'PRODUCCIÓN' : 'dev'} ==`);
await c.query('BEGIN');
try {
  await c.query(`SET LOCAL lock_timeout = '5s'`);
  const f0 = await fn('driver_llegada_soltar');
  const esp = md5(cuerpo(leer('0151_para_tomar_y_conductor.sql'), 'CREATE OR REPLACE FUNCTION public.driver_llegada_soltar('));
  const ya = f0 && /0172/.test(f0.prosrc);
  t(`driver_llegada_soltar es la de 0151${ya ? ' (ya es la de 0172)' : ''}`, !!f0 && (ya || md5(f0.prosrc) === esp), f0 ? md5(f0.prosrc) + ' ≠ ' + esp : 'no existe');
  const r0 = await fn('reubicar_reserva');
  const m171 = leer('0171_hora_del_vuelo.sql'), i171 = m171.indexOf('CREATE OR REPLACE FUNCTION public.reubicar_reserva(');
  const c171 = m171.slice(m171.indexOf('AS $function$', i171) + 13, m171.indexOf('$function$', m171.indexOf('AS $function$', i171) + 13));
  const yaR = r0 && /'soltada'/.test(r0.prosrc);
  t(`reubicar_reserva es la de 0171${yaR ? ' (ya es la de 0172)' : ''}`, !!r0 && (yaR || md5(r0.prosrc) === md5(c171)), r0 ? md5(r0.prosrc) + ' ≠ ' + md5(c171) : 'no existe');
  for (const f of ['llegada_editable', 'reub_baja', 'reub_arriba5', 'reub_candidatas', 'acomodo_frenado', 'flight_deplane_min', 'despacho_encendido', 'dia_madrugada', 'route_sync_assigned', 'sync_calculated_pickup', 'avisar_vuelta_para_tomar', 'ops_alert_recipients_of', 'trip_notify', 'hm_bog', 'short_name'])
    t('está ' + f, !!(await fn(f)));
  if (fallas.length) throw new Error('la base no está como se esperaba: no se aplica');
  const priv = () => one(`SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('anon', p.oid, 'EXECUTE') n FROM pg_proc p WHERE p.proname = 'driver_llegada_soltar' AND p.pronamespace = 'public'::regnamespace`);
  await c.query(sql);
  t('driver_llegada_soltar quedó con 0172', /reubicar_reserva\(v_res, v_sale, 'soltada'\)/.test((await fn('driver_llegada_soltar')).prosrc));
  t('reubicar_reserva quedó con el motivo «soltada»', /'soltada'/.test((await fn('reubicar_reserva')).prosrc));
  const firmas = await q(`SELECT pg_get_function_identity_arguments(p.oid) a FROM pg_proc p WHERE p.proname IN ('driver_llegada_soltar', 'reubicar_reserva') AND p.pronamespace = 'public'::regnamespace ORDER BY 1`);
  t('las mismas firmas de antes (una de cada una)', firmas.length === 2, firmas);
  const g = await priv(); t('la llama authenticated, no anon', g && g.a && !g.n, g);

  if (!prod) {
    await c.query('SAVEPOINT prueba');
    const org = (await one(`SELECT p.organization_id o FROM public.profiles p WHERE p.role = 'admin' AND p.deleted_at IS NULL
        AND (SELECT count(*) FROM public.driver_profiles dp JOIN public.profiles x ON x.id = dp.profile_id WHERE x.organization_id = p.organization_id) >= 1
        AND (SELECT count(*) FROM public.auxiliar_profiles ap JOIN public.profiles x ON x.id = ap.profile_id WHERE x.organization_id = p.organization_id) >= 3
      LIMIT 1`) || {}).o;
    if (!org) console.log('  · (sin organización de prueba en dev: el caso armado no corrió)');
    else {
      const d1 = await one(`SELECT dp.id, dp.profile_id FROM public.driver_profiles dp JOIN public.profiles x ON x.id = dp.profile_id WHERE x.organization_id = $1 ORDER BY dp.id LIMIT 1`, [org]);
      const aux = await q(`SELECT ap.id FROM public.auxiliar_profiles ap JOIN public.profiles x ON x.id = ap.profile_id WHERE x.organization_id = $1 ORDER BY ap.id LIMIT 3`, [org]);
      const jefes = (await one(`SELECT count(*)::int n FROM public.ops_alert_recipients_of($1)`, [org])).n;
      const rep = (await one(`SELECT public.despacho_encendido() x`)).x;
      console.log(`  · caso armado: ${jefes} jefes con alertas · reparto ${rep ? 'ENCENDIDO' : 'apagado'}`);
      await c.query(`SET LOCAL session_replication_role = replica`);   // sin acomodo automático ni avisos de los disparadores
      const base = await one(`SELECT id FROM public.reservations LIMIT 1`);
      const pedido = async (a, cuando, vuelo, lugar) => (await one(`INSERT INTO public.reservations SELECT (jsonb_populate_record(NULL::public.reservations, to_jsonb(b) || jsonb_build_object(
            'id', gen_random_uuid(), 'auxiliar_profile_id', $2::uuid, 'direction', 'airport_to_home', 'required_arrival_at', now() + ($3 || ' minutes')::interval,
            'cancelled_at', NULL, 'status_a2h', 'driver_assigned', 'status_h2a', NULL, 'flight_id', NULL, 'flight_code', $4::text, 'reserve_place', $5::text,
            'ground_ops', false, 'service_level', 'shared', 'private_status', NULL))).*
          FROM public.reservations b WHERE b.id = $1 RETURNING id`, [base.id, a, String(cuando), vuelo, lugar])).id;
      const A = await pedido(aux[0].id, 180, 'ZZ9384', null);     // aterriza en 3 h: sin dato de FlightRadar
      const B = await pedido(aux[1].id, -60, 'ZZ9234', null);     // aterrizó hace 1 h y se demora (el caso de Taborda)
      const C = await pedido(aux[2].id, 90, null, 'aero');        // de reserva en JMC: sin desembarque
      const D = await pedido(aux[0].id, -30, 'ZZ9111', null);     // va en la vuelta que sale de JMC en minutos
      const R1 = (await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at, organization_id) VALUES ($1, NULL, 'airport_to_home', 'planned', now() + interval '20 minutes', $2) RETURNING id`, [d1.id, org])).id;
      for (const [i, r] of [A, B, C].entries()) await c.query(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, status) VALUES ($1, $2, $3, $4)`, [R1, r, i + 1, i === 1 ? 'arrived' : 'pending']);
      // La siguiente recogida: en espera (sin conductor), sale de JMC 5 min después de «ya».
      const R2 = (await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at, pool, organization_id) VALUES (NULL, NULL, 'airport_to_home', 'planned', public.reub_arriba5(now()) + interval '5 minutes', true, $1) RETURNING id`, [org])).id;
      await c.query(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, status) VALUES ($1, $2, 1, 'pending')`, [R2, D]);
      await c.query(`SET LOCAL session_replication_role = origin`);
      const avisos = async (pre) => q(`SELECT title, body FROM public.notification_outbox WHERE dedupe_key LIKE $1`, [pre + '%']);
      const avisosDe = async (r) => q(`SELECT o.title, o.body FROM public.notification_outbox o JOIN public.auxiliar_profiles ap ON ap.profile_id = o.profile_id
          JOIN public.reservations y ON y.auxiliar_profile_id = ap.id WHERE y.id = $1 AND o.created_at >= now()`, [r]);
      const parada = async (r) => (await one(`SELECT id FROM public.route_stops WHERE route_assignment_id = $1 AND reservation_id = $2`, [R1, r])).id;
      const dondeVa = (r) => one(`SELECT ra.id, ra.pool, ra.para_tomar, ra.auto_created, ra.driver_profile_id, ra.status, ra.planned_start_at,
          round(extract(epoch FROM ra.planned_start_at - now()) / 60)::int en_min, extract(minute FROM ra.planned_start_at)::int % 5 = 0 multiplo,
          (SELECT count(*)::int FROM public.route_stops x WHERE x.route_assignment_id = ra.id) n
          FROM public.route_stops rs JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id WHERE rs.reservation_id = $1`, [r]);
      const suelta = async (r) => { const s = await parada(r); await como(d1.profile_id); const j = (await one(`SELECT public.driver_llegada_soltar($1, $2) j`, [R1, s])).j; await comoDb(); return j; };

      // 1. Taborda (ya aterrizó, «llegué» en JMC): pasa a la vuelta que sale en minutos.
      const rB = await suelta(B);
      const vB = await dondeVa(B);
      t(`soltar a la que ya aterrizó: pasa a la siguiente recogida (kind ${rB.kind}, sale ${hm(vB && vB.planned_start_at)})`, rB.kind === 'joined' && vB && vB.id === R2 && vB.n === 2, { rB, vB });
      const bj = await avisos('llegadasuelta-j:' + rB.id);
      t(`…aviso a los ${jefes} jefes: «· se demora — Pasó a la vuelta de las…»`, jefes === 0 || (bj.length === jefes && /· se demora$/.test(bj[0].title) && /Pasó a la vuelta de las/.test(bj[0].body)), bj[0]);
      const bt = await avisosDe(B);
      t('…y al tripulante «Cambió quién te recoge»', bt.some((x) => /Cambió quién te recoge/.test(x.title) && /Tu conductor tuvo que salir/.test(x.body)), bt);
      console.log('    ·', bj[0] ? bj[0].title + ' — ' + bj[0].body : '(sin jefes con alertas)');
      t('…su pedido queda «sin conductor» (la vuelta que la recibe está en espera)', (await one(`SELECT status_a2h::text s FROM public.reservations WHERE id = $1`, [B])).s === 'scheduled');

      // 2. La que aterriza en 3 h: nadie sale a esa hora → su propia vuelta, a SU hora.
      const rA = await suelta(A);
      const vA = await dondeVa(A);
      t(`soltar a la que aterriza en 3 h: ${rA.kind === 'joined' ? 'se juntó con otra' : 'su propia vuelta'} a su hora (sale ${hm(vA.planned_start_at)}, en ${vA.en_min} min)`,
        ['new', 'joined'].includes(rA.kind) && vA.en_min >= 195 && vA.en_min <= 215 && vA.status === 'planned' && (rA.kind === 'joined' || (vA.pool && !vA.driver_profile_id && vA.multiplo)), { rA, vA });
      const aj = await avisos('llegadasuelta-j:' + rA.id), ac = await avisos('reub-pool:' + rA.id);
      t(`…aviso a los jefes con el texto del reparto ${rep ? 'encendido' : 'apagado'}`, jefes === 0 || rA.kind === 'joined' || (aj.length === jefes && (rep ? /Quedó en espera/.test(aj[0].body) : /Quedó para tomar/.test(aj[0].body))), aj[0]);
      t(rep ? '…y NO suena «Hay una vuelta para tomar» a los conductores (reparto encendido)' : '…«Hay una vuelta para tomar» a los conductores del turno', rep ? ac.length === 0 : true, ac);

      // 3. El freno del acomodo puesto (ya armó muchas): a quien suelta un conductor no lo frena.
      for (let i = 0; i < 12; i++) await c.query(`INSERT INTO public.acomodo_creadas (organization_id, reservation_id, route_assignment_id) VALUES ($1, $2, $3)`, [org, D, R2]);
      const rC = await suelta(C);
      const vC = await dondeVa(C);
      t(`con el freno puesto igual le arma su vuelta, a su hora sin desembarque (kind ${rC.kind}, en ${vC.en_min} min)`, ['new', 'joined'].includes(rC.kind) && vC.en_min >= 90 && vC.en_min <= 110 && (rC.kind === 'joined' || (vC.pool && !vC.driver_profile_id)), { rC, vC });
      t('…sin el aviso «no armo más sola» a los jefes', (await q(`SELECT 1 FROM public.notification_outbox WHERE created_at >= now() AND body LIKE '%no armo más sola%'`)).length === 0);
      t('…y el «urgente» no se queda prendido para lo que siga', (await one(`SELECT coalesce(current_setting('rendio.acomodo_urgente', true), '') v`)).v !== 'on');
      t('…la vuelta del conductor, ya sin nadie, se borró', !(await one(`SELECT 1 x FROM public.route_assignments WHERE id = $1`, [R1])));
      // 4. No se suelta de una vuelta ajena.
      await como(d1.profile_id);
      const e1 = await falla(`SELECT public.driver_llegada_soltar($1, $2)`, [R2, (await one(`SELECT id FROM public.route_stops WHERE route_assignment_id = $1 LIMIT 1`, [R2])).id]);
      await comoDb();
      t('no se suelta de una vuelta que no es tuya', !!e1, e1 && e1.message);
    }
    await c.query('ROLLBACK TO SAVEPOINT prueba');
    t('el caso armado se deshizo', (await one(`SELECT count(*)::int n FROM public.notification_outbox WHERE dedupe_key LIKE 'llegadasuelta%' AND created_at >= now()`)).n === 0);
  }
  if (fallas.length) throw new Error(fallas.length + ' comprobaciones fallaron');
  if (!aplicar) { await c.query('ROLLBACK'); console.log('\n  EN SECO: todo en verde y DESHECHO. Para confirmarlo: --aplicar'); }
  else { await c.query('COMMIT'); console.log('\n  ✓ 0172 APLICADA en ' + (prod ? 'PRODUCCIÓN' : 'dev')); }
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error('\n  ✗ NO se aplicó nada:', e.message); process.exitCode = 1;
}
await c.end();
