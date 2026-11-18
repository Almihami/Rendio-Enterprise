// 0175 · Lo que viaja en las próximas horas no lo detiene el freno del acomodo.
//   cd rendio-backend && set -a && source <.env.dev|.env.main> && set +a && node scripts/_aplicar-0175.mjs [--produccion] [--aplicar]
// Sin --aplicar: EN SECO (ROLLBACK). Antes de tocar nada comprueba que las dos funciones estén EXACTAMENTE como
// las leyó el generador (scripts/_base-0175/): si alguna cambió, no sigue.
// La prueba usa la base real y SIEMPRE se deshace (savepoints): quita las paradas de hasta 5 personas que viajan
// en las próximas horas (lo que hizo el Publicar del 17-nov) y de 5 de más adelante, llena el tope de vueltas
// nuevas, abre los «sin carro» con el detector y corre el acomodo: primero el de antes, después el de 0175.
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
const FNS = ['acomodar_eventualidades', 'acomodo_frenado'];
const base = (f) => readFileSync(new URL(`./_base-0175/def-${f}.sql`, import.meta.url), 'utf8').trimEnd();
const def = async (f) => { const r = await q(`SELECT pg_get_functiondef(p.oid) d FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $1`, [f]); return r.length === 1 ? r[0].d.trimEnd() : null; };
const sql = readFileSync(new URL('../supabase/migrations/0175_lo_urgente_no_se_frena.sql', import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');

// El escenario del 17-nov, sobre la base real. Devuelve qué pasó con cada grupo.
async function escenario(etiqueta) {
  await c.query('SAVEPOINT esc');
  try {
    const [{ ahora }] = await q(`SELECT now() ahora`);
    // Personas con parada pendiente en una vuelta planeada que no ha arrancado, de un traslado compartido.
    const cand = (desde, hasta) => q(`
      SELECT DISTINCT ON (r.id) r.id rid, r.required_arrival_at req, rs.route_assignment_id ra, pr.full_name n, pr.organization_id org
        FROM public.reservations r JOIN public.route_stops rs ON rs.reservation_id = r.id AND rs.status = 'pending'
        JOIN public.route_assignments a ON a.id = rs.route_assignment_id AND a.status = 'planned' AND a.delegated_at IS NULL
        JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id JOIN public.profiles pr ON pr.id = ap.profile_id
       WHERE r.cancelled_at IS NULL AND coalesce(r.service_level::text, 'shared') <> 'private'
         AND r.required_arrival_at > now() + $1::interval AND r.required_arrival_at < now() + $2::interval
         AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = a.id AND x.status <> 'pending')
       ORDER BY r.id LIMIT 5`, [desde, hasta]);
    const urg = await cand('45 minutes', '5 hours 30 minutes');
    const tarde = await cand('8 hours', '36 hours');
    if (!urg.length) { console.log(`  · ${etiqueta}: no hay nadie con vuelta en las próximas horas para probar`); return null; }
    const org = urg[0].org;
    const todos = [...urg, ...tarde.filter((x) => x.org === org)];
    // Lo que hizo el Publicar: sus paradas se borran (y las vueltas que quedan vacías, también).
    const ras = [...new Set(todos.map((x) => x.ra))];
    await q(`DELETE FROM public.route_stops WHERE reservation_id = ANY($1::uuid[])`, [todos.map((x) => x.rid)]);
    await q(`DELETE FROM public.route_assignments a WHERE a.id = ANY($1::uuid[]) AND NOT EXISTS (SELECT 1 FROM public.route_stops x WHERE x.route_assignment_id = a.id)`, [ras]);
    // El tope de vueltas nuevas, lleno (como esa tarde, con los pedidos de mañana).
    const max = (await one(`SELECT coalesce(acomodo_max_nuevas, 4) m FROM public.app_settings WHERE id = 'singleton'`)).m;
    for (let i = 0; i < max; i++) await q(`INSERT INTO public.acomodo_creadas (organization_id, reservation_id) VALUES ($1, NULL)`, [org]);
    const frenadoSin = (await one(`SELECT public.acomodo_frenado($1) f`, [org])).f;
    await q(`SELECT public.detect_late_bookings()`);
    // Si el detector no abrió alguno (p. ej. ya tenía un rastro con la misma llave), se abre como él lo hace.
    for (const x of todos) {
      const abierto = await one(`SELECT 1 x FROM public.incidents WHERE reservation_id = $1 AND category = 'late_booking' AND status IN ('open','in_progress') AND NOT coalesce((details->>'auto')::boolean, false)`, [x.rid]);
      // El detector espera 4 min antes de abrirlo (late_booking_candidates): aquí se abre como él, ya.
      if (!abierto) await q(`INSERT INTO public.incidents (organization_id, reservation_id, category, severity, status, description, scope, source, details, dedupe_key, occurred_at)
        VALUES ($1, $2::uuid, 'late_booking', 'high', 'open', 'prueba 0175: no tiene carro', 'operacion', 'system', '{}'::jsonb, 'late:' || $3, now())`, [x.org, x.rid, x.rid]);
    }
    const t0 = (await one(`SELECT clock_timestamp() t`)).t;
    const res = (await one(`SELECT public.acomodar_eventualidades() x`)).x;
    const conVuelta = async (xs) => (await q(`SELECT DISTINCT rs.reservation_id FROM public.route_stops rs JOIN public.route_assignments a ON a.id = rs.route_assignment_id
        WHERE rs.reservation_id = ANY($1::uuid[]) AND a.status IN ('planned','in_progress')`, [xs.map((x) => x.rid)])).length;
    const avisos = await q(`SELECT title, left(body, 220) b, count(*)::int n FROM public.notification_outbox WHERE created_at >= $1 AND (title LIKE 'Repuse%' OR title LIKE 'Frené%') GROUP BY 1, 2`, [ahora]);
    const out = { urg: urg.length, urgRepuestos: await conVuelta(urg), tarde: tarde.filter((x) => x.org === org).length, tardeRepuestos: await conVuelta(tarde.filter((x) => x.org === org)), frenadoSin, res, avisos };
    console.log(`  · ${etiqueta}: urgentes ${out.urgRepuestos}/${out.urg} con vuelta · de más adelante ${out.tardeRepuestos}/${out.tarde} · acomodo ${JSON.stringify(res)}`);
    console.log(`    urgentes: ${urg.map((x) => `${x.n.split(' ').slice(0, 2).join(' ')} ${hm(x.req)}`).join(' · ')}`);
    avisos.forEach((a) => console.log(`    aviso a ${a.n} jefe(s): ${a.title} — ${a.b}`));
    return out;
  } finally { await c.query('ROLLBACK TO SAVEPOINT esc'); }
}

console.log(`\n== 0175 ${aplicar ? 'APLICANDO' : 'EN SECO'} en ${prod ? 'PRODUCCIÓN' : 'dev'} ==`);
await c.query('BEGIN');
try {
  await c.query(`SET LOCAL lock_timeout = '5s'`);
  for (const f of FNS) t(`${f} está como la leyó el generador`, (await def(f)) === base(f));
  for (const f of ['reubicar_reserva', 'detect_late_bookings', 'acomodo_aviso_freno', 'ops_alert_recipients_of', 'trip_notify', 'hm_bog', 'reub_nota'])
    t('está ' + f, !!(await one(`SELECT 1 x FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = $1`, [f])));
  t('app_settings todavía no tiene acomodo_urgente_horas', !(await one(`SELECT 1 x FROM information_schema.columns WHERE table_schema='public' AND table_name='app_settings' AND column_name='acomodo_urgente_horas'`)));
  if (fallas.length) throw new Error('la base no está como se esperaba: no se aplica');

  console.log('\n-- Antes de 0175 (el acomodo de hoy):');
  const antes = await escenario('ANTES');

  const priv = async () => Object.fromEntries((await q(`SELECT p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('anon', p.oid, 'EXECUTE') n FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1)`, [FNS])).map((r) => [r.proname, `${r.a}/${r.n}`]));
  const pAntes = await priv();
  await c.query(sql);
  console.log('\n-- 0175 puesta:');
  for (const f of FNS) t(`${f} quedó con 0175`, /0175/.test((await def(f)) || ''));
  t('los permisos de las dos no cambiaron', JSON.stringify(await priv()) === JSON.stringify(pAntes), await priv());
  t('acomodo_urgente_horas = 6', (await one(`SELECT acomodo_urgente_horas h FROM public.app_settings WHERE id = 'singleton'`)).h === 6);
  // El tope, solo con el interruptor.
  await c.query('SAVEPOINT tope');
  const org = (await one(`SELECT id FROM public.organizations ORDER BY created_at LIMIT 1`)).id;
  for (let i = 0; i < 6; i++) await q(`INSERT INTO public.acomodo_creadas (organization_id) VALUES ($1)`, [org]);
  t('con el tope lleno, frena', (await one(`SELECT public.acomodo_frenado($1) f`, [org])).f === true);
  await q(`SELECT set_config('rendio.acomodo_urgente', 'on', true)`);
  t('con rendio.acomodo_urgente = on, no frena', (await one(`SELECT public.acomodo_frenado($1) f`, [org])).f === false);
  await q(`SELECT set_config('rendio.acomodo_urgente', 'off', true)`);
  t('vuelve a frenar con off', (await one(`SELECT public.acomodo_frenado($1) f`, [org])).f === true);
  await c.query('ROLLBACK TO SAVEPOINT tope');
  // Se corre UNA vez sobre la base de hoy y se deshace: aplicar la migración no debe acomodar nada de verdad
  // (eso lo hace el cron cada 5 minutos, ya con 0175).
  await c.query('SAVEPOINT corre');
  const rHoy = (await one('SELECT public.acomodar_eventualidades() x')).x;
  t('acomodar_eventualidades() corre sin errores en la base de hoy', !!rHoy && rHoy.errores === 0, rHoy);
  t('el interruptor queda apagado al terminar', ((await one(`SELECT coalesce(current_setting('rendio.acomodo_urgente', true), '') v`)).v || 'off') !== 'on');
  await c.query('ROLLBACK TO SAVEPOINT corre');

  console.log('\n-- Con 0175:');
  const despues = await escenario('CON 0175');
  if (antes && despues) {
    t('con 0175 TODOS los urgentes vuelven a tener vuelta', despues.urgRepuestos === despues.urg, despues);
    t('con 0175 sale el aviso «Repuse…» a los jefes', despues.avisos.some((a) => /^Repuse/.test(a.title)), despues.avisos);
    t('con 0175 no hay errores en el acomodo', despues.res.errores === 0, despues.res);
    if (despues.tarde > (await one(`SELECT coalesce(acomodo_max_nuevas, 4) m FROM public.app_settings WHERE id = 'singleton'`)).m)
      t('lo de más adelante sigue frenado (tanda)', despues.tardeRepuestos === 0, despues);
    console.log(`  · antes: ${antes.urgRepuestos}/${antes.urg} urgentes repuestos · con 0175: ${despues.urgRepuestos}/${despues.urg}`);
  } else console.log('  · sin escenario: no hay vueltas en las próximas horas en esta base');

  if (fallas.length) throw new Error(`${fallas.length} comprobación(es) fallaron`);
  if (aplicar) { await c.query('COMMIT'); console.log('\n✓ 0175 APLICADA'); }
  else { await c.query('ROLLBACK'); console.log('\nEN SECO: todo bien, no se guardó nada (ROLLBACK)'); }
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error('\n✗ NO SE APLICÓ:', e.message);
  process.exitCode = 1;
}
await Promise.race([c.end(), new Promise((r) => setTimeout(r, 5000))]);
process.exit(process.exitCode || 0);
