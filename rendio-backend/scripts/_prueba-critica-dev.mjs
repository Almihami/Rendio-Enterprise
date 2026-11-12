// CASO CRÍTICO EN VIVO — SOLO DEV. Arma un día difícil, deja que el sistema real
// (cron cada 2 min → Edge Function → base) decida solo, le mueve el piso a mitad
// de camino y al final REVISA el resultado punto por punto. Limpia siempre.
//
//   cd rendio-backend && set -a && source <.env.dev> && set +a && node scripts/_prueba-critica-dev.mjs
//
// El caso:
//   · 2 carros fijos: Julián en JMC con una SALIDA fija más tarde (hay que respetársela),
//     Juan en Rionegro. Un conductor con el APOYO parqueado en JMC, sin turno abierto.
//   · 7 llegadas. Cuatro salen casi juntas (el pico). Una se CANCELA antes de la
//     primera revisión. A una le ATRASAN el vuelo 20 min. A otra se lo ADELANTAN 25.
// Dura unos 11 minutos (5 revisiones del sistema).
import pg from 'pg';
const DEV = 'lxlphbafhtphulanhzlp';
if ((process.env.SUPABASE_PROJECT_REF || '') !== DEV || !(process.env.SUPABASE_URL || '').includes(DEV)) { console.error('ABORT: esto es solo para dev'); process.exit(2); }
const c = new pg.Client({ host: 'aws-1-us-east-1.pooler.supabase.com', port: 5432, database: 'postgres', user: 'postgres.' + DEV, password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false }, statement_timeout: 60000 });
await c.connect();
const q = async (s, v) => (await c.query(s, v)).rows, one = async (s, v) => (await q(s, v))[0];
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const hm = (d) => new Date(d).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false });
const LUGAR = { jmc: [6.1715, -75.4270], rionegro: [6.1537, -75.3738] };
// [correo, vuelo, minutos hasta ATERRIZAR desde T0]  (sale ≈ aterriza + 18)
const LLEG = [
  ['prueba.valeria@rendio.demo', 'AV9901', -8], ['prueba.camila@rendio.demo', 'AV9902', -7], ['laura.gomez@rendio.demo', 'AV9903', -6],
  ['mateo.cardona@rendio.demo', 'AV9904', -5], ['andres.pena@rendio.demo', 'AV9907', -4],        // ← se cancela
  ['manuela.gil@rendio.demo', 'AV9905', 6],                                                       // ← le atrasan 20
  ['sara.quintero@rendio.demo', 'AV9906', 24],                                                    // ← le adelantan 25
];
const fallas = [], notas = [];
const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + JSON.stringify(d) : ''}`); if (!ok) fallas.push(n); };

const J = await one(`SELECT id, organization_id org FROM public.profiles WHERE email = 'demo-admin@rendio.demo'`);
const cond = async (e) => one(`SELECT dp.id, dp.profile_id, p.full_name FROM public.profiles p JOIN public.driver_profiles dp ON dp.profile_id = p.id WHERE p.email = $1`, [e]);
const A = await cond('julian.lopez@rendio.com'), B = await cond('juan.franco@rendio.co'), AP = await cond('demo-conductor@rendio.demo');
const T = await q(`SELECT p.email, p.full_name, ap.id aux, ap.profile_id FROM public.profiles p JOIN public.auxiliar_profiles ap ON ap.profile_id = p.id WHERE p.email = ANY($1)`, [LLEG.map((x) => x[0])]);
const VUELOS = LLEG.map((x) => x[1]);
let jefesAntes = null; const ids = {};       // vuelo → { ra, rid, nombre }
let salidaJulian = null, T0 = null;

async function limpiar() {
  await c.query(`SELECT set_config('rendio.no_acomodar', 'on', false)`);
  const res = (await q(`SELECT id FROM public.reservations WHERE auxiliar_profile_id = ANY($1) AND required_arrival_at > now() - interval '1 day'`, [T.map((x) => x.aux)])).map((r) => r.id);
  const ras = (await q(`SELECT DISTINCT route_assignment_id id FROM public.route_stops WHERE reservation_id = ANY($1)`, [res])).map((r) => r.id);
  if (salidaJulian) ras.push(salidaJulian);
  await c.query(`DELETE FROM public.arrival_dispatch_log WHERE route_assignment_id = ANY($1)`, [ras]);
  await c.query(`DELETE FROM public.route_stops WHERE route_assignment_id = ANY($1)`, [ras]);
  await c.query(`DELETE FROM public.route_assignments WHERE id = ANY($1)`, [ras]);
  await c.query(`DELETE FROM public.incidents WHERE reservation_id = ANY($1)`, [res]).catch(() => {});
  await c.query(`DELETE FROM public.notification_outbox WHERE created_at > now() - interval '40 minutes' AND sent_at IS NULL AND profile_id = ANY($1)`, [[J.id, A.profile_id, B.profile_id, AP.profile_id, ...T.map((x) => x.profile_id)]]);
  await c.query(`DELETE FROM public.reservations WHERE id = ANY($1)`, [res]);
  await c.query(`DELETE FROM public.flight_statuses WHERE flight_code = ANY($1)`, [VUELOS]);
  await c.query(`DELETE FROM public.driver_locations WHERE driver_profile_id = ANY($1) AND recorded_at > now() - interval '1 day'`, [[A.id, B.id, AP.id]]);
  await c.query(`DELETE FROM public.support_duty WHERE driver_profile_id = $1 AND day >= current_date - 1`, [AP.id]);
  await c.query(`UPDATE public.shifts SET status = 'closed', end_at = now() WHERE driver_id = ANY($1) AND status::text <> 'closed' AND notes = 'PRUEBA critica'`, [[A.id, B.id]]);
  if (jefesAntes) { for (const a of jefesAntes) await c.query(`UPDATE public.profiles SET receives_ops_alerts = $2 WHERE id = $1`, [a.id, a.r]); jefesAntes = null; }
}
const gps = (dp, donde) => c.query(`INSERT INTO public.driver_locations (driver_profile_id, latitude, longitude, recorded_at) VALUES ($1, $2, $3, now())`, [dp, ...LUGAR[donde]]);
const estado = async () => q(`SELECT r.flight_code vuelo, ra.id ra, ra.driver_profile_id dp, ra.planned_start_at ini, r.cancelled_at IS NOT NULL cancelada,
     public.reub_baja(ra.organization_id, r.flight_code, r.required_arrival_at) + make_interval(mins => coalesce(public.flight_deplane_min(r.flight_code), 20)) sale
   FROM public.reservations r JOIN public.route_stops rs ON rs.reservation_id = r.id JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
  WHERE r.flight_code = ANY($1) AND r.required_arrival_at > now() - interval '3 hours' ORDER BY r.flight_code`, [VUELOS]);
const nom = (dp) => (dp === A.id ? 'Julián (fijo)' : dp === B.id ? 'Juan (fijo)' : dp === AP.id ? 'APOYO' : dp ? 'otro' : '—');
const pintar = async (titulo) => { console.log(`\n${titulo} · ${hm(new Date())}`); (await estado()).forEach((e) => console.log(`    ${e.vuelo} ${ids[e.vuelo].nombre.padEnd(15)} sale ${hm(e.sale)} · ${e.cancelada ? 'CANCELADA' : e.dp ? `${nom(e.dp)}, recoge ${hm(e.ini)}` : 'en espera'}`)); };
// Espera a que el cron haya corrido de verdad N veces desde que se armó (no por reloj:
// la 1ª corrida de esta prueba tomó la «1ª revisión» antes de que hubiera ocurrido).
const esperarRevision = async (n) => { for (;;) { const r = await one(`SELECT count(*)::int k FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid WHERE j.jobname = 'despachar-llegadas' AND d.start_time > $1::timestamptz AND d.status = 'succeeded'`, [armado]); if (r.k >= n) { await dormir(8000); return; } await dormir(3000); } };
let armado = null;

try {
  await limpiar();
  // Los jefes reales tienen teléfono en dev: durante la prueba, avisos solo al jefe de prueba.
  jefesAntes = await q(`SELECT id, receives_ops_alerts r FROM public.profiles WHERE organization_id = $1 AND role = 'admin' AND deleted_at IS NULL`, [J.org]);
  await c.query(`UPDATE public.profiles SET receives_ops_alerts = (id = $2) WHERE organization_id = $1 AND role = 'admin' AND deleted_at IS NULL`, [J.org, J.id]);
  const set0 = await one(`SELECT despacho_activo a FROM public.app_settings WHERE id = 'singleton'`);
  if (!set0.a) throw new Error('el despacho está apagado en dev');
  for (;;) { const s = new Date().getSeconds(), m = new Date().getMinutes(); if (m % 2 === 0 && s >= 8 && s <= 20) break; await dormir(1500); }   // justo después de una revisión
  T0 = (await one(`SELECT date_trunc('minute', now()) b`)).b;
  const en = (min) => new Date(Date.parse(T0) + min * 60000).toISOString();
  const vehs = await q(`SELECT id FROM public.vehicles WHERE organization_id = $1 AND deleted_at IS NULL AND status::text <> 'inactive' ORDER BY internal_code DESC LIMIT 2`, [J.org]);
  await c.query(`UPDATE public.shifts SET status = 'closed', end_at = now() WHERE driver_id = ANY($1) AND status::text <> 'closed'`, [[A.id, B.id, AP.id]]);
  for (const [d, v] of [[A, vehs[0]], [B, vehs[1]]]) await c.query(`INSERT INTO public.shifts (organization_id, driver_id, vehicle_id, status, start_at, notes) VALUES ($1, $2, $3, 'active', now() - interval '1 hour', 'PRUEBA critica')`, [J.org, d.id, v.id]);
  await gps(A.id, 'jmc'); await gps(B.id, 'rionegro'); await gps(AP.id, 'jmc');
  await c.query(`INSERT INTO public.support_duty (organization_id, day, band, driver_profile_id)
     SELECT $1, CASE WHEN l::time < time '02:00' THEN l::date - 1 ELSE l::date END, CASE WHEN l::time >= time '02:00' AND l::time < time '14:00' THEN 'am' ELSE 'pm' END, $2 FROM (SELECT now() AT TIME ZONE 'America/Bogota' AS l) x
     ON CONFLICT (organization_id, day, band) DO UPDATE SET driver_profile_id = EXCLUDED.driver_profile_id`, [J.org, AP.id]);
  // La salida fija de Julián: primera casa en Rionegro a T0+75.
  salidaJulian = (await one(`INSERT INTO public.route_assignments (direction, status, planned_start_at, driver_profile_id, organization_id) VALUES ('home_to_airport', 'planned', $1, $2, $3) RETURNING id`, [en(75), A.id, J.org])).id;
  await c.query(`INSERT INTO public.route_stops (route_assignment_id, guest_name, guest_lat, guest_lng, stop_order, estimated_arrival_at) VALUES ($1, 'Salida de prueba', 6.1537, -75.3738, 1, $2)`, [salidaJulian, en(75)]);
  for (const [email, vuelo, enMin] of LLEG) {
    const x = T.find((y) => y.email === email);
    const prog = en(enMin + 10), real = en(enMin);
    await c.query('BEGIN');
    await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: J.id, role: 'authenticated' })]); await c.query('SET LOCAL ROLE authenticated');
    const rid = (await one(`SELECT public.admin_create_reservation($1, 'lle', $2::timestamptz, $3, NULL, false) id`, [x.aux, prog, vuelo])).id;
    await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', '', true)`); await c.query(`SELECT set_config('rendio.no_acomodar', 'on', true)`);
    await c.query(`DELETE FROM public.route_stops WHERE reservation_id = $1`, [rid]);
    const dep = (await one(`SELECT coalesce(public.flight_deplane_min($1), 20) m`, [vuelo])).m;
    const ra = (await one(`INSERT INTO public.route_assignments (direction, status, planned_start_at, organization_id, pool, para_tomar) VALUES ('airport_to_home', 'planned', $1::timestamptz + make_interval(mins => $2), $3, true, true) RETURNING id`, [prog, dep, J.org])).id;
    await c.query(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at) VALUES ($1, $2, 1, $3::timestamptz + make_interval(mins => $4 + 20))`, [ra, rid, prog, dep]);
    await c.query(`INSERT INTO public.flight_statuses (organization_id, flight_code, flight_date, direction, sched_at, estimated_at, status, delay_min, source, fetched_at)
       VALUES ($1, $2, ($3::timestamptz AT TIME ZONE 'America/Bogota')::date, 'airport_to_home', $3, $4, 'in_air', -10, 'flightradar24', now())
       ON CONFLICT (organization_id, flight_code, flight_date, direction) DO UPDATE SET sched_at = EXCLUDED.sched_at, estimated_at = EXCLUDED.estimated_at, actual_at = NULL, delay_min = -10, status = 'in_air', fetched_at = now()`, [J.org, vuelo, prog, real]);
    await c.query('COMMIT');
    ids[vuelo] = { ra, rid, nombre: x.full_name };
  }
  // ANTES de la primera revisión: Andrés cancela.
  await c.query(`SELECT set_config('rendio.no_acomodar', 'on', false)`);
  await c.query(`UPDATE public.reservations SET cancelled_at = now() WHERE id = $1`, [ids.AV9907.rid]);
  armado = (await one(`SELECT now() n`)).n;
  await pintar('ARMADO (Andrés canceló)');

  await esperarRevision(1);
  await pintar('1ª REVISIÓN: el pico');
  const tras1 = await estado();
  // A mitad de camino: a Manuela le ATRASAN el vuelo 20 min; a Sara se lo ADELANTAN 25.
  await c.query(`UPDATE public.flight_statuses SET estimated_at = estimated_at + interval '20 minutes', delay_min = 10, status = 'delayed', fetched_at = now() WHERE flight_code = 'AV9905'`);
  await c.query(`UPDATE public.flight_statuses SET estimated_at = estimated_at - interval '25 minutes', delay_min = -35, fetched_at = now() WHERE flight_code = 'AV9906'`);
  console.log(`\n  → ${hm(new Date())}: a Manuela le atrasan el vuelo 20 min; a Sara se lo adelantan 25`);
  const saraAntes = (await estado()).find((e) => e.vuelo === 'AV9906');
  for (let i = 2; i <= 5; i++) {
    await esperarRevision(i);
    for (const d of [A, B, AP]) {          // el GPS de los que siguen libres no se deja envejecer
      const libre = !(await one(`SELECT 1 x FROM public.route_assignments WHERE driver_profile_id = $1 AND direction = 'airport_to_home' AND status = 'planned' AND planned_start_at > now() - interval '2 hours'`, [d.id]));
      const u = await one(`SELECT latitude, longitude FROM public.driver_locations WHERE driver_profile_id = $1 ORDER BY recorded_at DESC LIMIT 1`, [d.id]);
      if (libre && u) await c.query(`INSERT INTO public.driver_locations (driver_profile_id, latitude, longitude, recorded_at) VALUES ($1, $2, $3, now())`, [d.id, u.latitude, u.longitude]);
    }
    await pintar(`${i}ª REVISIÓN`);
  }

  // ───────────────────────────── VERIFICACIÓN ─────────────────────────────
  console.log('\nVERIFICACIÓN');
  const fin = await estado(); const de = (v) => fin.find((e) => e.vuelo === v);
  const log = await q(`SELECT l.route_assignment_id ra, l.kind, l.wait_min w, l.driver_profile_id dp, l.detail, l.created_at FROM public.arrival_dispatch_log l WHERE l.route_assignment_id = ANY($1) ORDER BY l.created_at`, [Object.values(ids).map((x) => x.ra)]);
  const asign = log.filter((l) => l.kind === 'asignada');
  const pico = ['AV9901', 'AV9902', 'AV9903', 'AV9904'];
  t('el pico (4 llegadas) quedó asignado completo en la 1ª revisión', pico.every((v) => tras1.find((e) => e.vuelo === v).dp), tras1.filter((e) => pico.includes(e.vuelo)).map((e) => [e.vuelo, nom(e.dp)]));
  t('cada llegada se asignó UNA sola vez', pico.concat(['AV9905', 'AV9906']).every((v) => asign.filter((l) => l.ra === ids[v].ra).length <= 1), asign.length);
  t('la cancelada NUNCA se asignó', !de('AV9907').dp && !log.some((l) => l.ra === ids.AV9907.ra), de('AV9907'));
  t('en el pico se usaron los 3 carros (2 fijos + apoyo)', new Set(pico.map((v) => de(v).dp)).size === 3, pico.map((v) => nom(de(v).dp)));
  const primeroApoyo = asign.find((l) => l.dp === AP.id);
  t('el apoyo quedó marcado en el rastro', !!primeroApoyo && primeroApoyo.detail && primeroApoyo.detail.apoyo === true && asign.filter((l) => l.dp !== AP.id).every((l) => !(l.detail && l.detail.apoyo)), asign.map((l) => [nom(l.dp), l.detail]));
  const sj = await one(`SELECT driver_profile_id dp, planned_start_at ini, (SELECT status FROM public.route_stops WHERE route_assignment_id = ra.id) st FROM public.route_assignments ra WHERE id = $1`, [salidaJulian]);
  t('la SALIDA fija de Julián sigue intacta (mismo conductor, misma hora)', sj.dp === A.id && Date.parse(sj.ini) === Date.parse(en(75)) && sj.st === 'pending', sj);
  const deJulian = fin.filter((e) => e.dp === A.id);
  t('lo que se le dio a Julián le deja llegar a su salida (recoge ≥ 30 min antes)', deJulian.every((e) => Date.parse(e.ini) <= Date.parse(en(75)) - 30 * 60000), deJulian.map((e) => [e.vuelo, hm(e.ini)]));
  const man = de('AV9905');
  t('vuelo ATRASADO (Manuela): no se asignó antes de tiempo ni quedó a la hora vieja', !man.dp || Date.parse(man.ini) >= Date.parse(man.sale) - 60000, { asignada: nom(man.dp), recoge: hm(man.ini), sale: hm(man.sale) });
  const sara = de('AV9906');
  // Con el vuelo adelantado entra al reparto 25 min antes de lo programado. La hora de la
  // vuelta es la de recogida real (puede coincidir con la programada si el carro llega tarde).
  const logSara = asign.find((l) => l.ra === ids.AV9906.ra);
  t('vuelo ADELANTADO (Sara): el sistema la tomó con la hora nueva del vuelo y la asignó', !!sara.dp && !!logSara && Date.parse(sara.sale) < Date.parse(saraAntes.ini) - 20 * 60000 && Date.parse(sara.ini) >= Date.parse(sara.sale) - 60000, { conductor: nom(sara.dp), programada: hm(saraAntes.ini), sale: hm(sara.sale), recoge: hm(sara.ini) });
  t('nadie es recogido ANTES de salir del avión', fin.filter((e) => e.dp).every((e) => Date.parse(e.ini) >= Date.parse(e.sale) - 60000), fin.filter((e) => e.dp).map((e) => [e.vuelo, hm(e.sale), hm(e.ini)]));
  const largas = asign.filter((l) => l.w > 15), avisadas = log.filter((l) => l.kind === 'espera_larga');
  t('toda espera de más de 15 min tuvo su aviso a los jefes, y solo esas', largas.every((l) => avisadas.some((a) => a.ra === l.ra)) && avisadas.every((a) => largas.some((l) => l.ra === a.ra)), { largas: largas.map((l) => l.w), avisos: avisadas.length });
  const out = await q(`SELECT o.profile_id, o.title, o.dedupe_key k, o.sent_at FROM public.notification_outbox o WHERE o.created_at >= $1::timestamptz AND (o.dedupe_key LIKE 'desp%')`, [T0]);
  t('ningún aviso repetido (una llave, un aviso)', new Set(out.map((o) => o.k)).size === out.length, out.length);
  t('ningún aviso de la prueba salió a un teléfono real', out.every((o) => !o.sent_at), out.filter((o) => o.sent_at).map((o) => o.title));
  t('cada conductor recibió un aviso por cada llegada que le tocó', [A, B, AP].every((d) => out.filter((o) => o.profile_id === d.profile_id && /llegada para ti/i.test(o.title)).length === asign.filter((l) => l.dp === d.id).length), [A, B, AP].map((d) => [nom(d.id), out.filter((o) => o.profile_id === d.profile_id).length, asign.filter((l) => l.dp === d.id).length]));
  t('cada tripulante asignado supo quién lo recoge', asign.every((l) => out.some((o) => o.k.startsWith('desp-tr:' + l.ra))), asign.length);
  const cron = await q(`SELECT d.status FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid WHERE j.jobname = 'despachar-llegadas' AND d.start_time >= $1::timestamptz`, [T0]);
  t(`las ${cron.length} revisiones automáticas corrieron sin fallar`, cron.length >= 5 && cron.every((x) => x.status === 'succeeded'), cron.map((x) => x.status));
  const cuando = asign.filter((l) => pico.includes(Object.keys(ids).find((k) => ids[k].ra === l.ra))).map((l) => hm(l.created_at));
  t('las 4 del pico se decidieron en la MISMA revisión', new Set(cuando).size === 1 && cuando.length === 4, cuando);
  const http = await q(`SELECT status_code s, content::text c FROM net._http_response WHERE created >= $1::timestamptz AND content::text LIKE '%en_espera%'`, [T0]);
  t('la función del servidor respondió bien todas las veces y sin errores', http.length >= 1 && http.every((h) => h.s === 200 && /"errores":\[\]/.test(h.c)), http.map((h) => [h.s, (h.c.match(/"errores":\[[^\]]*\]/) || [''])[0]]));

  console.log('\nRESUMEN DE ESPERAS');
  asign.forEach((l) => { const v = Object.keys(ids).find((k) => ids[k].ra === l.ra); console.log(`    ${ids[v].nombre.padEnd(15)} → ${nom(l.dp).padEnd(14)} espera ${String(l.w).padStart(2)} min${l.w > 15 ? '  (avisó a jefes)' : ''}`); });
  console.log(fallas.length ? `\n✗ ${fallas.length} de las comprobaciones fallaron.` : '\n✔ Todas las comprobaciones pasaron.');
} catch (e) {
  console.error('\n✗ La prueba se cayó: ' + e.message); process.exitCode = 1;
} finally {
  try { await c.query('ROLLBACK').catch(() => {}); await limpiar(); console.log('limpio: datos de prueba borrados y avisos de los jefes como estaban'); } catch (e) { console.error('OJO: no se pudo limpiar: ' + e.message); }
  await c.end();
}
