// 0176 · Una llegada se adelanta cuando alguien sale de ella.
//   cd rendio-backend && set -a && source <.env.dev|.env.main> && set +a && node scripts/_aplicar-0176.mjs [--produccion] [--aplicar]
// Sin --aplicar: EN SECO (ROLLBACK). Las pruebas usan vueltas reales y SIEMPRE se deshacen (savepoints).
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const pg = createRequire('/Users/harold/Documents/Rendio-Drivers/Proyect-main-0164/rendio-backend/scripts/x.js')('pg');
const DEV = 'lxlphbafhtphulanhzlp', PROD = 'wvuurnfdrrdondrbbkhd';
const prod = process.argv.includes('--produccion'), aplicar = process.argv.includes('--aplicar');
const esperado = prod ? PROD : DEV;
if ((process.env.SUPABASE_PROJECT_REF || '') !== esperado || !(process.env.SUPABASE_URL || '').includes(esperado)) { console.error('ABORT: ambiente equivocado'); process.exit(2); }
const c = new pg.Client({ host: prod ? 'aws-1-us-west-2.pooler.supabase.com' : 'aws-1-us-east-1.pooler.supabase.com', port: 5432, database: 'postgres', user: 'postgres.' + esperado, password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false }, statement_timeout: 120000 });
await c.connect();
const q = async (s, v) => (await c.query(s, v)).rows, one = async (s, v) => (await q(s, v))[0];
const fallas = []; const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + JSON.stringify(d).slice(0, 500) : ''}`); if (!ok) fallas.push(n); };
const hm = (x) => (x ? new Date(x).toLocaleString('en-GB', { timeZone: 'America/Bogota', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '--');
const sql = readFileSync(new URL('../supabase/migrations/0176_llegada_se_adelanta.sql', import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
// Cuándo sale del terminal cada persona (la misma cuenta de 0176 / 0171).
const LISTO = `public.reub_arriba5(coalesce(public.reub_baja(coalesce(ra.organization_id, p.organization_id), r.flight_code, r.required_arrival_at), r.required_arrival_at)
  + make_interval(mins => CASE WHEN coalesce(r.ground_ops, false) OR r.reserve_place IS NOT NULL THEN 0 ELSE coalesce(public.flight_deplane_min(r.flight_code), 15) END))`;
const gente = (ra) => q(`SELECT x.id stop, r.id rid, split_part(p.full_name,' ',1) n, ${LISTO} listo, x.estimated_arrival_at eta
    FROM public.route_stops x JOIN public.route_assignments ra ON ra.id = x.route_assignment_id JOIN public.reservations r ON r.id = x.reservation_id
    JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id JOIN public.profiles p ON p.id = ap.profile_id
   WHERE x.route_assignment_id = $1 ORDER BY x.stop_order`, [ra]);

console.log(`\n== 0176 ${aplicar ? 'APLICANDO' : 'EN SECO'} en ${prod ? 'PRODUCCIÓN' : 'dev'} ==`);
await c.query('BEGIN');
try {
  await c.query(`SET LOCAL lock_timeout = '5s'`);
  for (const f of ['reub_baja', 'reub_arriba5', 'flight_deplane_min', 'reub_extremos', 'reub_conductor_libre', 'lugar_del_regreso', 'trip_notify', 'hm_bog'])
    t('está ' + f, !!(await one(`SELECT 1 x FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = $1`, [f])));
  t('todavía no está llegada_adelantar', !(await one(`SELECT 1 x FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'llegada_adelantar'`)));
  t('route_stops no tiene ya el disparador', !(await one(`SELECT 1 x FROM pg_trigger WHERE tgname = 'tr_route_stops_llegada_adelanta'`)));
  if (fallas.length) throw new Error('la base no está como se esperaba: no se aplica');
  await c.query(sql);
  t('quedó la función', !!(await one(`SELECT 1 x FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'llegada_adelantar'`)));
  t('quedó el disparador en route_stops', !!(await one(`SELECT 1 x FROM pg_trigger WHERE tgname = 'tr_route_stops_llegada_adelanta' AND NOT tgisinternal`)));
  t('ni anon ni authenticated pueden llamarla', !(await one(`SELECT has_function_privilege('authenticated', 'public.llegada_adelantar(uuid,uuid)', 'EXECUTE') OR has_function_privilege('anon', 'public.llegada_adelantar(uuid,uuid)', 'EXECUTE') x`)).x);

  // Llegadas reales que sirven para probar: planeadas, sin arrancar, sin delegar, sin pasajeros sin cuenta, de 2+ personas, en 40 min o más.
  const cands = await q(`SELECT ra.id, ra.planned_start_at ini, ra.driver_profile_id drv, (SELECT count(*)::int FROM public.route_stops x WHERE x.route_assignment_id = ra.id) n
      FROM public.route_assignments ra
     WHERE ra.direction = 'airport_to_home' AND ra.status = 'planned' AND ra.delegated_at IS NULL AND ra.planned_start_at > now() + interval '40 minutes'
       AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = ra.id AND (x.status <> 'pending' OR x.reservation_id IS NULL))
       AND (SELECT count(*) FROM public.route_stops x WHERE x.route_assignment_id = ra.id) >= 2
     ORDER BY ra.driver_profile_id IS NOT NULL, ra.planned_start_at LIMIT 60`);
  console.log(`  · llegadas de 2+ personas para probar: ${cands.length}`);
  if (cands.length) {
    const v = cands[0];
    const g = await gente(v.id);
    // El caso de Nicol: la vuelta quedó con la hora de alguien que llega tarde. Se le pone la hora del último
    // + 30 min (como si estuviera esa persona) y sale el último: debe volver a la hora de los que quedan.
    await c.query('SAVEPOINT a');
    const ultimo = g.slice().sort((a, b) => b.listo - a.listo)[0];
    const resto = g.filter((x) => x.stop !== ultimo.stop);
    const tarde = new Date(Math.max(...g.map((x) => +new Date(x.listo))) + 30 * 60000);
    await q(`UPDATE public.route_assignments SET planned_start_at = $2 WHERE id = $1`, [v.id, tarde]);
    const [{ ahora }] = await q(`SELECT now() ahora`);
    await q(`DELETE FROM public.route_stops WHERE id = $1`, [ultimo.stop]);
    const despues = await one(`SELECT planned_start_at FROM public.route_assignments WHERE id = $1`, [v.id]);
    const esperado = new Date(Math.max(...resto.map((x) => +new Date(x.listo)), +new Date(Date.now() + 10 * 60000)));
    const piso = await one(`SELECT public.reub_arriba5(now() + interval '10 minutes') p`);
    const esp = new Date(Math.max(+esperado, +new Date(piso.p)));
    console.log(`  · vuelta ${v.id.slice(0, 8)} (${v.drv ? 'con conductor' : 'en espera'}) puesta a las ${hm(tarde)}; sale ${ultimo.n} (listo ${hm(ultimo.listo)}); quedan ${resto.map((x) => `${x.n} ${hm(x.listo)}`).join(', ')} → ahora ${hm(despues.planned_start_at)}`);
    if (v.drv) {
      const avisos = await q(`SELECT title, body FROM public.notification_outbox WHERE created_at >= $1 AND title LIKE 'Tu llegada sale antes%'`, [ahora]);
      if (+new Date(despues.planned_start_at) === +tarde) console.log('    (no se movió: el conductor no alcanzaba según sus otras vueltas — es lo esperado en ese caso)');
      else { t('se adelantó a la hora de los que quedan', +new Date(despues.planned_start_at) === +esp, { esp: hm(esp), hay: hm(despues.planned_start_at) }); t('al conductor le llega «Tu llegada sale antes»', avisos.length === 1, avisos); if (avisos[0]) console.log('    aviso:', avisos[0].body); }
    } else t('se adelantó a la hora de los que quedan', +new Date(despues.planned_start_at) === +esp, { esp: hm(esp), hay: hm(despues.planned_start_at) });
    const etas = await gente(v.id);
    t('las horas de entrega se corrieron igual', etas.every((x, i) => { const antes = resto.find((r) => r.stop === x.stop); return !antes.eta || !x.eta || (+new Date(x.eta) - +new Date(antes.eta)) === (+new Date(despues.planned_start_at) - +tarde); }));
    await c.query('ROLLBACK TO SAVEPOINT a');

    // Lo mismo con una vuelta que tiene conductor: se adelanta solo si le alcanza, y le llega el aviso.
    // Si ninguna llegada próxima tiene conductor (con el despacho las reparte el sistema), se le pone uno a
    // la primera DENTRO de la prueba (se deshace): el que menos vueltas tenga ese día.
    let vd = cands.find((x) => x.drv);
    await c.query('SAVEPOINT a2');
    if (!vd) {
      const d = await one(`SELECT dp.id FROM public.driver_profiles dp JOIN public.profiles p ON p.id = dp.profile_id
          WHERE p.deleted_at IS NULL AND p.organization_id = (SELECT coalesce(ra.organization_id, (SELECT pr.organization_id FROM public.route_stops x JOIN public.reservations r ON r.id = x.reservation_id JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id JOIN public.profiles pr ON pr.id = ap.profile_id WHERE x.route_assignment_id = ra.id LIMIT 1)) FROM public.route_assignments ra WHERE ra.id = $1)
          ORDER BY (SELECT count(*) FROM public.route_assignments o WHERE o.driver_profile_id = dp.id AND o.planned_start_at BETWEEN $2::timestamptz - interval '12 hours' AND $2::timestamptz + interval '12 hours') LIMIT 1`, [v.id, v.ini]);
      if (d) { await q(`UPDATE public.route_assignments SET driver_profile_id = $2, pool = false, para_tomar = false WHERE id = $1`, [v.id, d.id]); vd = { ...v, drv: d.id }; console.log('  · (ninguna próxima tenía conductor: se le pone uno a la de prueba, dentro de la transacción)'); }
    }
    if (vd) {
      const gd = await gente(vd.id);
      const ul = gd.slice().sort((a, b) => b.listo - a.listo)[0];
      const re = gd.filter((x) => x.stop !== ul.stop);
      const td = new Date(Math.max(...gd.map((x) => +new Date(x.listo))) + 30 * 60000);
      await q(`UPDATE public.route_assignments SET planned_start_at = $2 WHERE id = $1`, [vd.id, td]);
      const [{ ahora: a2 }] = await q(`SELECT now() ahora`);
      await q(`DELETE FROM public.route_stops WHERE id = $1`, [ul.stop]);
      const dd = await one(`SELECT planned_start_at FROM public.route_assignments WHERE id = $1`, [vd.id]);
      const av = await q(`SELECT body FROM public.notification_outbox WHERE created_at >= $1 AND title LIKE 'Tu llegada sale antes%'`, [a2]);
      console.log(`  · con conductor ${vd.id.slice(0, 8)}: puesta ${hm(td)}, sale ${ul.n}, quedan ${re.map((x) => `${x.n} ${hm(x.listo)}`).join(', ')} → ${hm(dd.planned_start_at)}${av[0] ? ' · aviso: ' + av[0].body : ' · sin aviso'}`);
      t('con conductor: o se adelantó y le avisó, o no le alcanzaba y quedó igual', (+new Date(dd.planned_start_at) < +td && av.length === 1) || (+new Date(dd.planned_start_at) === +td && av.length === 0), { hay: hm(dd.planned_start_at), av });
    }
    await c.query('ROLLBACK TO SAVEPOINT a2');

    // Sale alguien que NO es el último: la hora no cambia.
    await c.query('SAVEPOINT b');
    const primero = g.slice().sort((a, b) => a.listo - b.listo)[0];
    if (+new Date(primero.listo) < +new Date(ultimo.listo)) {
      const ini0 = (await one(`SELECT planned_start_at FROM public.route_assignments WHERE id = $1`, [v.id])).planned_start_at;
      await q(`DELETE FROM public.route_stops WHERE id = $1`, [primero.stop]);
      const ini1 = (await one(`SELECT planned_start_at FROM public.route_assignments WHERE id = $1`, [v.id])).planned_start_at;
      t('si sale alguien que no era el último, la hora no se toca (o solo baja a la de los que quedan)', +new Date(ini1) <= +new Date(ini0) && +new Date(ini1) >= Math.min(+new Date(ini0), Math.max(...g.filter((x) => x.stop !== primero.stop).map((x) => +new Date(x.listo)))), { ini0: hm(ini0), ini1: hm(ini1) });
    } else console.log('  · (todos salen a la misma hora: se salta la prueba del que no es el último)');
    await c.query('ROLLBACK TO SAVEPOINT b');

    // Con el interruptor de scripts, no se mueve.
    await c.query('SAVEPOINT c');
    await q(`UPDATE public.route_assignments SET planned_start_at = $2 WHERE id = $1`, [v.id, tarde]);
    await q(`SELECT set_config('rendio.no_adelantar', 'on', true)`);
    await q(`DELETE FROM public.route_stops WHERE id = $1`, [ultimo.stop]);
    t('con rendio.no_adelantar = on no se mueve', +new Date((await one(`SELECT planned_start_at FROM public.route_assignments WHERE id = $1`, [v.id])).planned_start_at) === +tarde);
    await c.query('ROLLBACK TO SAVEPOINT c');

    // Borrar la vuelta entera (cascada, como Publicar) no falla.
    await c.query('SAVEPOINT d');
    let err = null; try { await q(`DELETE FROM public.route_assignments WHERE id = $1`, [v.id]); } catch (e) { err = e.message; }
    t('borrar la vuelta entera (cascada) no falla', !err, err);
    await c.query('ROLLBACK TO SAVEPOINT d');
  } else console.log('  · no hay llegadas de 2+ personas en las próximas horas en esta base: solo se comprobó que quedó puesta');

  if (fallas.length) throw new Error(`${fallas.length} comprobación(es) fallaron`);
  if (aplicar) { await c.query('COMMIT'); console.log('\n✓ 0176 APLICADA'); }
  else { await c.query('ROLLBACK'); console.log('\nEN SECO: todo bien, no se guardó nada (ROLLBACK)'); }
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error('\n✗ NO SE APLICÓ:', e.message);
  process.exitCode = 1;
}
await Promise.race([c.end(), new Promise((r) => setTimeout(r, 5000))]);
process.exit(process.exitCode || 0);
