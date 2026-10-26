// Verificación de 0146 (una llegada con el vuelo atrasado no se vuelve invisible
// para el «no tiene carro») contra la base LOCAL (127.0.0.1:54322). Aplica
// 0124–0136, 0141, 0143 y 0144 (lo que hay en producción) y encima 0146, dentro
// de una transacción que se deshace: no queda nada. Nunca apunta a dev ni a
// producción.
//
//   cd rendio-backend/scripts && node _verify-0146.mjs        (entre las 4 a. m. y las 9 p. m.)
//
// Las horas van relativas a «ahora» (como el caso real: la prueba corre cuando
// Manuela ya debió aterrizar). El día publicado es el de hoy: por eso no corre
// de noche, cuando «ahora ± 3 h» se pasa de día.
//
//   M. Manuela (el caso del 26-oct): llegada AV269 programada hace 25 min,
//      Flightradar24 dice que baja 29 min tarde, sin vuelta, día publicado.
//      · Con 0143 no avisa nunca (la prueba exige que el código viejo FALLE así)
//        y una alerta ya abierta se cierra sola «la hora del servicio ya pasó».
//      · Con 0146 avisa (grave, con el vuelo atrasado en el texto, push al jefe),
//        la alerta se queda abierta mientras ella espera, el acomodo no la mueve
//        sola, y se cierra cuando un jefe la pone en una vuelta o cuando pasa una
//        hora desde que bajó.
//   A. Llegada a tiempo: con carro, nada cambia (sin aviso). Sin carro, su hora
//      es la programada (FR24 a tiempo o adelantado no la mueve) y deja de contar
//      una hora después de la programada.
//   E. Llegada ya entregada (sin vuelta: la atendieron por fuera): no avisa, y si
//      tenía la alerta abierta se cierra sola.
//   S. Salidas: exactamente igual que antes (avisa antes de su hora, no después).
//   D. Vuelo atrasado pero el día no tiene plan publicado: no avisa (como antes).
//   C. Permisos, que se puede volver a correr, y el down vuelve a 0143.
//
// NO cubre: la push de verdad, el pg_cron de verdad, la Edge Function de vuelos
// (se escribe la fila de flight_statuses a mano, como la deja FR24), ni
// dev/producción.
import fs from 'node:fs';
import { localClient, fixtures, user } from './_local-fixtures.mjs';

let ok = 0, fail = 0;
const check = (n, cond, det) => {
  if (cond) { ok++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + (typeof det === 'string' ? det : JSON.stringify(det)) : ''}`); }
};
const c = await localClient();
const q = async (s, p) => (await c.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
const strip = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const huella = async (sig) => (await one(`SELECT md5(prosrc) h FROM pg_proc WHERE oid = to_regprocedure($1)`, [sig]))?.h || null;
const DET = 'public.detect_late_bookings()';
// El detector de 0143, el que tienen dev y producción el 26-oct-2026 (0144 no lo toca).
const H0143 = '4168e00fa1cfd7b4dc15b2360b9c370b';

const hora = (await one(`SELECT extract(hour FROM now() AT TIME ZONE 'America/Bogota')::int h`)).h;
if (hora >= 21 || hora < 4) { console.log('Correr entre las 4 a. m. y las 9 p. m. (las horas de la prueba son «ahora ± 3 h» y tienen que caer hoy).'); process.exit(2); }

await c.query('BEGIN');
try {
  if (!(await one(`SELECT to_regprocedure('public.ops_alert_recipients_of(uuid)') IS NOT NULL AS ok`)).ok) await c.query(strip('../supabase/migrations/0117_avisos_desde_el_servidor.sql'));
  for (const m of ['0124_carro_del_turno', '0125_ruta_de_julian', '0126_vuelta_delegada', '0127_aviso_sin_carro_espera', '0128_aviso_vuelta_terminada',
    '0129_conductor_de_una_vuelta', '0130_corte_de_pedidos', '0131_delegado_con_nombre', '0132_carro_del_plan', '0133_pasajero_sin_cuenta',
    '0134_reubicar_al_cambiar', '0135_acomodar_eventualidades', '0136_aviso_vuelta_iniciada', '0141_sin_carro_dia_del_plan',
    '0143_pegar_no_borra_automaticas', '0144_avisos_por_turno_y_freno']) await c.query(strip(`../supabase/migrations/${m}.sql`));
  const antes = await huella(DET);
  console.log(`  huella del detector antes de 0146 (0143): ${antes}`);
  check('lo de antes de 0146 es el detector de 0143 (_aplicar-0146 exige esta misma huella en dev y producción)', antes === H0143, antes);

  await q(`SELECT set_config('rendio.no_acomodar', 'on', true)`);   // el disparador del acomodo no se mete al crear reservas
  const fx = await fixtures(c);
  const jefe = await user(c, fx.org, 'admin', 'Christian prueba 0146');
  const JUAN = (await one(`INSERT INTO public.driver_profiles (profile_id) VALUES ($1) RETURNING id`, [await user(c, fx.org, 'driver', 'Juan Ospina prueba 0146')])).id;
  let n = 0;
  const trip = async (name) => { const u = await user(c, fx.org, 'auxiliar', `${name} prueba0146 ${++n}`); return (await one(`INSERT INTO public.auxiliar_profiles (profile_id, residence_id) VALUES ($1, $2) RETURNING id`, [u, fx.olivar])).id; };
  // «ahora + min» en el reloj de la base (todo el script usa el mismo now(): una sola transacción).
  const en = async (min) => (await one(`SELECT (now() + make_interval(mins => $1))::text t`, [min])).t;
  const res = async (a, dir, min, vuelo, extra = {}) => (await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, ${dir === 'sal' ? 'status_h2a' : 'status_a2h'}, required_arrival_at, pickup_address, pickup_latitude, pickup_longitude, residence_id, notes)
      VALUES ($1, $2, $3, now() + make_interval(mins => $4), 'El Olivar, Rionegro', 6.1523, -75.3781, $5, $6) RETURNING id`,
    [a, dir === 'sal' ? 'home_to_airport' : 'airport_to_home', dir === 'sal' ? 'requested' : (extra.status || 'scheduled'), min, fx.olivar, vuelo ? `Vuelo ${vuelo}.` : null])).id;
  // La fila que deja Flightradar24 (0118): sched_at = la hora de la reserva; delay_min = baja − esa hora.
  const fr24 = async (rid, delay, { landed = false } = {}) => {
    const r = await one(`SELECT flight_code, required_arrival_at FROM public.reservations WHERE id = $1`, [rid]);
    await q(`INSERT INTO public.flight_statuses (organization_id, flight_code, flight_date, direction, sched_at, estimated_at, actual_at, status, delay_min, source)
      VALUES ($1, $2, ($3::timestamptz AT TIME ZONE 'America/Bogota')::date, 'airport_to_home', $3::timestamptz,
              $3::timestamptz + make_interval(mins => $4), CASE WHEN $5 THEN $3::timestamptz + make_interval(mins => $4) END,
              CASE WHEN $5 THEN 'landed' ELSE 'in_air' END, $4, 'flightradar24')
      ON CONFLICT (organization_id, flight_code, flight_date, direction) DO UPDATE SET estimated_at = EXCLUDED.estimated_at, actual_at = EXCLUDED.actual_at,
        status = EXCLUDED.status, delay_min = EXCLUDED.delay_min, fetched_at = now()`, [fx.org, r.flight_code, r.required_arrival_at, delay, landed]);
  };
  const vuelta = async (rid, dir, min, extra = {}) => {
    const ra = (await one(`INSERT INTO public.route_assignments (driver_profile_id, direction, status, planned_start_at, plan_car, pool, auto_created, organization_id)
      VALUES ($1, $2, 'planned', now() + make_interval(mins => $3), 'Carro 1', $4, false, $5) RETURNING id`,
      [extra.dp === undefined ? JUAN : extra.dp, dir === 'sal' ? 'home_to_airport' : 'airport_to_home', min, !!extra.pool, fx.org])).id;
    if (rid) await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order) VALUES ($1, $2, 1)`, [ra, rid]);
    return ra;
  };
  // El reloj del detector: lo anotado y las vueltas «envejecen» (como _verify-0143).
  const pasan = async (min) => {
    await q(`UPDATE public.late_booking_candidates SET created_at = created_at - make_interval(mins => $1)`, [min]);
    await q(`UPDATE public.route_assignments SET created_at = created_at - make_interval(mins => $1)`, [min]);
  };
  const dosPasadas = async () => { await pasan(10); await q(`SELECT public.detect_late_bookings()`); await pasan(10); await q(`SELECT public.detect_late_bookings()`); };
  const alerta = async (rid) => one(`SELECT id, status::text st, severity::text sev, description d, resolution_notes nota, details FROM public.incidents
    WHERE reservation_id = $1::uuid AND category = 'late_booking' AND dedupe_key = 'late:' || $1::uuid::text ORDER BY created_at DESC LIMIT 1`, [rid]);
  const abierta = async (rid) => { const a = await alerta(rid); return !!a && a.st !== 'resolved'; };
  const enSavepoint = async (fn) => { await c.query('SAVEPOINT sp'); try { return await fn(); } finally { await c.query('ROLLBACK TO SAVEPOINT sp'); } };
  // Una alerta abierta «de antes» (la que abrió el detector cuando todavía faltaba tiempo).
  const abrirAMano = async (rid) => q(`INSERT INTO public.incidents (organization_id, reservation_id, category, severity, status, description, scope, source, details, dedupe_key, occurred_at)
    VALUES ($1, $2::uuid, 'late_booking', 'high', 'open', 'X no tiene carro (de antes)', 'operacion', 'system', '{}'::jsonb, 'late:' || $2::uuid::text, now() - interval '30 minutes')`, [fx.org, rid]);

  // ── El día publicado: Juan tiene una vuelta de hoy con otra tripulante ─────
  const OTRA = await trip('Otra');
  const rOtra = await res(OTRA, 'lle', 30, 'LA4025');
  await vuelta(rOtra, 'lle', 45);
  const hm = async (min) => (await one(`SELECT public.hm_bog(now() + make_interval(mins => $1)) h`, [min])).h;

  // ── Los tripulantes ───────────────────────────────────────────────────────
  const rMan = await res(await trip('Manuela'), 'lle', -35, 'AV269');          // programada hace 35 min
  await fr24(rMan, 29, { landed: true });                                      // FR24: aterrizó 29 min tarde (hace 6 min)
  const rMan2 = await res(await trip('Mariana'), 'lle', -25, 'AV270');         // programada hace 25 min, todavía en el aire
  await fr24(rMan2, 29);                                                       // con la alerta ya abierta de antes
  const rTiempoCarro = await res(await trip('Laura'), 'lle', 20, 'AV9563');     // a tiempo, con carro
  await fr24(rTiempoCarro, 0);
  await vuelta(rTiempoCarro, 'lle', 35);
  const rTiempo = await res(await trip('Sara'), 'lle', -20, 'AV8410');          // a tiempo (FR24 dice 0), sin carro, hace 20 min
  await fr24(rTiempo, 0, { landed: true });
  const rAdel = await res(await trip('Yerly'), 'lle', 50, 'JA5116');            // adelantado 15 min
  await fr24(rAdel, -15);
  const rEntregada = await res(await trip('Paula'), 'lle', -30, 'AV9325', { status: 'delivered' });   // ya entregada (por fuera)
  await fr24(rEntregada, 29);
  const rEntregada2 = await res(await trip('Paula vieja'), 'lle', -30, 'AV9326', { status: 'delivered' });
  await fr24(rEntregada2, 29);
  const rSalFut = await res(await trip('Camilo'), 'sal', 90);                   // salida en 1,5 h sin carro
  const rSalPas = await res(await trip('Moisés'), 'sal', -10);                  // salida de hace 10 min sin carro
  const rManana = await res(await trip('Tomás'), 'lle', 24 * 60 - 25, 'AV271'); // mañana, atrasado, día sin plan
  await fr24(rManana, 29);

  const escenario = async () => {
    await abrirAMano(rMan2); await abrirAMano(rEntregada2);
    await dosPasadas();
    const r = {};
    for (const [k, id] of Object.entries({ man: rMan, man2: rMan2, tiempoCarro: rTiempoCarro, tiempo: rTiempo, adel: rAdel, ent: rEntregada, ent2: rEntregada2, salFut: rSalFut, salPas: rSalPas, manana: rManana }))
      r[k] = await alerta(id);
    r.push = (await one(`SELECT count(*)::int n FROM public.notification_outbox WHERE profile_id = $1 AND body LIKE 'Manuela%'`, [jefe])).n;
    r.pushTexto = await one(`SELECT title, body FROM public.notification_outbox WHERE profile_id = $1 AND body LIKE 'Manuela%' LIMIT 1`, [jefe]);
    return r;
  };

  // ── Con 0143 (lo de hoy en producción) ─────────────────────────────────────
  const viejo = await enSavepoint(escenario);
  check('M. (código viejo, 0143) Manuela sin vuelta después de su hora programada NO avisa', !viejo.man, viejo.man);
  check('M. (código viejo) la alerta que ya estaba abierta se cierra sola «la hora del servicio ya pasó» aunque su vuelo no ha bajado',
    viejo.man2?.st === 'resolved' && /ya pasó/.test(viejo.man2?.nota || ''), viejo.man2);
  check('S. (código viejo) la salida en 1,5 h sin carro avisa; la de hace 10 min no', !!viejo.salFut && !viejo.salPas, { f: viejo.salFut?.d, p: viejo.salPas });

  // ── 0146 ──────────────────────────────────────────────────────────────────
  await c.query(strip('../supabase/migrations/0146_llegada_atrasada_sin_carro.sql'));
  await c.query(strip('../supabase/migrations/0146_llegada_atrasada_sin_carro.sql'));
  check('0146 se aplica encima de 0144 (y se puede volver a correr)', true);
  const hq = async (rid) => (await one(`SELECT extract(epoch FROM public.hora_que_importa(id) - required_arrival_at)::int / 60 AS min
    FROM public.reservations WHERE id = $1`, [rid])).min;
  const hqs = { man: await hq(rMan), tiempo: await hq(rTiempo), adel: await hq(rAdel), sal: await hq(rSalFut), salPas: await hq(rSalPas) };
  check('hora_que_importa: Manuela = la de FR24 (+29 min); a tiempo = la programada; adelantado NO la acorta; salida = la de siempre',
    hqs.man === 29 && hqs.tiempo === 0 && hqs.adel === 0 && hqs.sal === 0 && hqs.salPas === 0, hqs);

  const nuevo = await enSavepoint(async () => {
    const r = await escenario();
    // El acomodo no la mueve sola (su hora ya pasó): queda para un jefe.
    await q(`SELECT public.acomodar_eventualidades()`);
    r.manVueltas = (await one(`SELECT count(*)::int n FROM public.route_stops WHERE reservation_id = $1`, [rMan])).n;
    r.manTrasAcomodo = await alerta(rMan);
    // Otra pasada: sigue abierta, sin otro aviso.
    await pasan(10); await q(`SELECT public.detect_late_bookings()`);
    r.manOtraPasada = await alerta(rMan);
    r.pushOtraPasada = (await one(`SELECT count(*)::int n FROM public.notification_outbox WHERE profile_id = $1 AND body LIKE 'Manuela%'`, [jefe])).n;
    r.nIncMan = (await one(`SELECT count(*)::int n FROM public.incidents WHERE reservation_id = $1 AND category = 'late_booking'`, [rMan])).n;
    // Un jefe la pone en una vuelta → se cierra sola.
    await c.query('SAVEPOINT asignar');
    await vuelta(rMan, 'lle', 10);
    await q(`SELECT public.detect_late_bookings()`);
    r.manAsignada = await alerta(rMan);
    await c.query('ROLLBACK TO SAVEPOINT asignar');
    // El reloj corre: todo se mueve `min` minutos hacia atrás (la reserva y lo que dijo FR24).
    const corre = async (min) => {
      await q(`UPDATE public.reservations SET required_arrival_at = required_arrival_at - make_interval(mins => $3) WHERE id IN ($1, $2)`, [rMan, rTiempo, min]);
      await q(`UPDATE public.flight_statuses SET sched_at = sched_at - make_interval(mins => $2), estimated_at = estimated_at - make_interval(mins => $2),
        actual_at = actual_at - make_interval(mins => $2) WHERE organization_id = $1 AND flight_code IN ('AV269', 'AV8410')`, [fx.org, min]);
      await q(`SELECT public.detect_late_bookings()`);
    };
    // 50 min después de que bajó (44 + los 6 que ya llevaba): sigue abierta.
    await corre(44);
    r.man50 = await alerta(rMan);
    // 66 min después de que bajó → se cierra sola, y no vuelve a anotarse.
    await corre(16);
    r.manHoraPasada = await alerta(rMan);
    r.tiempoHoraPasada = await alerta(rTiempo);
    r.manAnotada = !!(await one(`SELECT 1 FROM public.late_booking_candidates WHERE reservation_id = $1`, [rMan]));
    return r;
  });
  const m = nuevo.man;
  console.log(`  · texto de Manuela: «${m?.d}»`);
  console.log(`  · texto de la llegada a tiempo sin carro: «${nuevo.tiempo?.d}»`);
  console.log(`  · al cerrarse sola (Manuela): «${nuevo.manHoraPasada?.nota}»`);
  console.log(`  · push al jefe: «${nuevo.pushTexto?.title}» — «${nuevo.pushTexto?.body}»`);
  check('M. Manuela (vuelo atrasado, sin vuelta, después de su hora programada) SÍ avisa, grave', !!m && m.st === 'open' && m.sev === 'high', m);
  check('M. el aviso dice que el vuelo viene atrasado y a qué hora baja (no «faltan -0,4 h»)',
    !!m && m.d.includes(`(su vuelo AV269 viene atrasado: ${await hm(-6)} en vez de ${await hm(-35)}).`) && !/-\d/.test(m.d), m?.d);
  check('M. al jefe le llega la push (una)', nuevo.push === 1, nuevo.push);
  check('M. la alerta que ya estaba abierta se queda abierta mientras su vuelo no ha bajado + 1 h', nuevo.man2?.st === 'open', nuevo.man2);
  check('M. el acomodo no la mueve sola (su hora ya pasó: la asigna un jefe) y la alerta sigue', nuevo.manVueltas === 0 && nuevo.manTrasAcomodo?.st === 'open', { v: nuevo.manVueltas, a: nuevo.manTrasAcomodo?.st });
  check('M. otra pasada del reloj: sigue abierta, sin otra alerta ni otra push', nuevo.manOtraPasada?.st === 'open' && nuevo.nIncMan === 1 && nuevo.pushOtraPasada === 1,
    { st: nuevo.manOtraPasada?.st, n: nuevo.nIncMan, push: nuevo.pushOtraPasada });
  check('M. cuando un jefe la pone en una vuelta, se cierra sola', nuevo.manAsignada?.st === 'resolved' && /en una ruta/.test(nuevo.manAsignada?.nota || ''), nuevo.manAsignada);
  check('M. 50 min después de que bajó su vuelo sigue abierta (sigue esperando en JMC)', nuevo.man50?.st === 'open', nuevo.man50);
  check('M. una hora después de que bajó su vuelo, se cierra sola y ya no se anota', nuevo.manHoraPasada?.st === 'resolved' && /pasó una hora desde su llegada/.test(nuevo.manHoraPasada?.nota || '') && !nuevo.manAnotada,
    { a: nuevo.manHoraPasada, anotada: nuevo.manAnotada });

  check('A. llegada a tiempo CON carro: sin aviso (nada cambia)', !nuevo.tiempoCarro, nuevo.tiempoCarro);
  check('A. llegada a tiempo SIN carro 20 min después de su hora: avisa con su hora programada (no inventa atraso)',
    nuevo.tiempo?.st === 'open' && nuevo.tiempo.d.includes(`su llegada era a las ${await hm(-20)} y sigue sin carro`) && !/atrasado/.test(nuevo.tiempo.d), nuevo.tiempo);
  check('A. y deja de contar una hora después de la programada (FR24 a tiempo no la estira)', nuevo.tiempoHoraPasada?.st === 'resolved', nuevo.tiempoHoraPasada);
  check('A. llegada adelantada sin carro, todavía por delante: avisa como antes («faltan … h»)', nuevo.adel?.st === 'open' && /\(faltan 0\.8 h\)\.$/.test(nuevo.adel.d), nuevo.adel?.d);

  check('E. llegada ya entregada (sin vuelta, vuelo atrasado): no avisa', !nuevo.ent, nuevo.ent);
  check('E. y si tenía la alerta abierta, se cierra sola', nuevo.ent2?.st === 'resolved' && /entregado/.test(nuevo.ent2?.nota || ''), nuevo.ent2);

  check('S. salidas igual que antes: la de 1,5 h avisa con el mismo texto; la de hace 10 min no',
    nuevo.salFut?.st === 'open' && nuevo.salFut.d === viejo.salFut?.d && !nuevo.salPas, { nuevo: nuevo.salFut?.d, viejo: viejo.salFut?.d, pas: nuevo.salPas });
  check('D. vuelo atrasado pero su día (mañana) sin plan publicado: no avisa', !nuevo.manana, nuevo.manana);

  // ── C. Permisos y el down ────────────────────────────────────────────────
  const perm = await one(`SELECT has_function_privilege('authenticated', 'public.hora_que_importa(uuid)', 'EXECUTE') a,
    has_function_privilege('anon', 'public.hora_que_importa(uuid)', 'EXECUTE') b, has_function_privilege('authenticated', '${DET}', 'EXECUTE') d`);
  check('permisos: hora_que_importa y el detector cerrados para la app (solo el servidor)', !perm.a && !perm.b && !perm.d, perm);
  const con = await huella(DET);
  console.log(`  huella del detector con 0146: ${con}`);
  await c.query('SAVEPOINT down');
  await c.query(strip('../down_migrations/0146_llegada_atrasada_sin_carro.down.sql'));
  const tras = await huella(DET);
  const sinFn = (await one(`SELECT to_regprocedure('public.hora_que_importa(uuid)') IS NULL ok`)).ok;
  check('C. el down vuelve exactamente al detector de 0143 y quita hora_que_importa', tras === antes && sinFn, { tras, antes, sinFn });
  await c.query('ROLLBACK TO SAVEPOINT down');
} catch (e) {
  fail++; console.log('  ✗ error: ' + e.message + (e.where ? ' · ' + e.where.split('\n')[0] : ''));
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok}/${ok + fail} ${fail ? '✗' : '✓'}`);
process.exit(fail ? 1 : 0);
