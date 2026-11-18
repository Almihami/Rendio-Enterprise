// 0178 · La hora de recogida solo se dice con la ruta del día PUBLICADA (marca real, no deducción).
//   cd rendio-backend && set -a && source <.env.dev|.env.main> && set +a && node scripts/_aplicar-0178.mjs [--produccion] [--aplicar]
// Sin --aplicar: EN SECO (ROLLBACK). Antes de tocar nada comprueba que reubicar_reserva y detect_late_bookings
// estén EXACTAMENTE como las leyó el generador (scripts/_base-0178/): si alguna cambió, no sigue.
// El caso armado (solo en dev) SIEMPRE se deshace (savepoints). Primero con las funciones de ANTES, para ver
// el problema del 17-nov (una vuelta suelta de madrugada → el sistema arma el pedido y dice la hora), y después
// con 0178: sin marca no hay hora; la marca la deja el jefe al publicar y nadie más.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const pg = createRequire('/Users/harold/Documents/Rendio-Drivers/Proyect-main-0164/rendio-backend/scripts/x.js')('pg');
const DEV = 'lxlphbafhtphulanhzlp', PROD = 'wvuurnfdrrdondrbbkhd';
const prod = process.argv.includes('--produccion'), aplicar = process.argv.includes('--aplicar');
const esperado = prod ? PROD : DEV;
if ((process.env.SUPABASE_PROJECT_REF || '') !== esperado || !(process.env.SUPABASE_URL || '').includes(esperado)) { console.error(`ABORT: se esperaba ${prod ? 'PRODUCCIÓN' : 'dev'} (${esperado})`); process.exit(2); }
const c = new pg.Client({ host: prod ? 'aws-1-us-west-2.pooler.supabase.com' : 'aws-1-us-east-1.pooler.supabase.com', port: 5432, database: 'postgres', user: 'postgres.' + esperado, password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false }, statement_timeout: 60000 });
await c.connect();
const q = async (s, v) => (await c.query(s, v)).rows, one = async (s, v) => (await q(s, v))[0];
const fallas = []; const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + (typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 600) : ''}`); if (!ok) fallas.push(n); };
const FNS = ['reubicar_reserva', 'detect_late_bookings'];
const base = (f) => readFileSync(new URL(`./_base-0178/prod-${f}.sql`, import.meta.url), 'utf8').trimEnd();
const def = async (f) => { const r = await q(`SELECT pg_get_functiondef(p.oid) d FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $1`, [f]); return r.length === 1 ? r[0].d.trimEnd() : null; };
const priv = (f) => one(`SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('anon', p.oid, 'EXECUTE') n, has_function_privilege('service_role', p.oid, 'EXECUTE') s FROM pg_proc p WHERE p.proname = $1 AND p.pronamespace = 'public'::regnamespace`, [f]);
const sql = readFileSync(new URL('../supabase/migrations/0178_hora_solo_con_ruta_publicada.sql', import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
// Actuar con la sesión de alguien: solo las credenciales (como dentro de una función del servidor) o también el rol de la app.
const sesion = async (uid) => { await c.query(`SELECT set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true), set_config('request.jwt.claim.role', 'authenticated', true)`, [JSON.stringify({ sub: uid, role: 'authenticated' }), uid]); };
const comoApp = async (uid) => { await sesion(uid); await c.query('SET LOCAL ROLE authenticated'); };
const comoDb = async () => { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', '', true), set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claim.role', '', true)`); };
const sinDisparadores = async (f) => { await c.query(`SET LOCAL session_replication_role = replica`); try { return await f(); } finally { await c.query(`SET LOCAL session_replication_role = origin`); } };

console.log(`\n== 0178 ${aplicar ? 'APLICANDO' : 'EN SECO'} en ${prod ? 'PRODUCCIÓN' : 'dev'} ==`);
await c.query('BEGIN');
try {
  await c.query(`SET LOCAL lock_timeout = '5s'`);
  const antes = {};
  for (const f of FNS) {
    const d = await def(f); antes[f] = await priv(f);
    const ya = !!d && /0178/.test(d);
    t(`${f} está como la leyó el generador${ya ? ' (ya es la de 0178)' : ''}`, !!d && (ya || d === base(f)), d ? 'la definición viva no es la de scripts/_base-0178' : 'no existe');
  }
  for (const f of ['dia_madrugada', 'current_user_role', 'current_user_org', 'set_updated_at', 'trip_notify', 'admin_route_set_driver', 'admin_manual_route_publish'])
    t('está ' + f, !!(await one(`SELECT 1 x FROM pg_proc WHERE proname = $1 AND pronamespace = 'public'::regnamespace`, [f])));
  if (fallas.length) throw new Error('la base no está como se esperaba: no se aplica');

  // ── El caso armado (solo dev) ──
  let caso = null;
  if (!prod) {
    const org = (await one(`SELECT p.organization_id o FROM public.profiles p WHERE p.role = 'admin' AND p.deleted_at IS NULL
        AND (SELECT count(*) FROM public.driver_profiles dp JOIN public.profiles x ON x.id = dp.profile_id WHERE x.organization_id = p.organization_id) >= 1
        AND (SELECT count(*) FROM public.auxiliar_profiles ap JOIN public.profiles x ON x.id = ap.profile_id WHERE x.organization_id = p.organization_id AND x.deleted_at IS NULL AND x.is_active IS DISTINCT FROM false) >= 2
      LIMIT 1`) || {}).o;
    if (org) {
      const jefe = await one(`SELECT p.id FROM public.profiles p WHERE p.organization_id = $1 AND p.role = 'admin' AND p.deleted_at IS NULL ORDER BY p.created_at LIMIT 1`, [org]);
      const d1 = await one(`SELECT dp.id, dp.profile_id FROM public.driver_profiles dp JOIN public.profiles x ON x.id = dp.profile_id WHERE x.organization_id = $1 AND x.deleted_at IS NULL ORDER BY dp.id LIMIT 1`, [org]);
      const molde = await one(`SELECT r.id, r.auxiliar_profile_id a FROM public.reservations r JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id JOIN public.profiles x ON x.id = ap.profile_id
          WHERE x.organization_id = $1 AND x.deleted_at IS NULL AND x.is_active IS DISTINCT FROM false AND r.direction = 'home_to_airport' AND r.pickup_latitude IS NOT NULL
            AND coalesce(r.service_level::text, 'shared') = 'shared' ORDER BY r.created_at DESC LIMIT 1`, [org]);
      const aux = molde && await q(`SELECT ap.id, ap.profile_id FROM public.auxiliar_profiles ap JOIN public.profiles x ON x.id = ap.profile_id
          WHERE x.organization_id = $1 AND x.deleted_at IS NULL AND x.is_active IS DISTINCT FROM false ORDER BY (ap.id = $2) DESC, ap.id LIMIT 2`, [org, molde.a]);
      // Seis días lejanos y vacíos (sin vueltas ni pedidos de esa organización cerca).
      let D0 = null;
      for (let salto = 25; salto <= 145 && !D0; salto += 20) {
        const n = (await one(`SELECT count(*)::int n FROM public.route_assignments ra WHERE ra.planned_start_at BETWEEN (now() + ($1 || ' days')::interval) - interval '2 days' AND (now() + ($1 || ' days')::interval) + interval '20 days'`, [String(salto)])).n;
        if (!n) D0 = salto;
      }
      if (jefe && d1 && molde && aux && aux.length === 2 && D0) {
        const dia = async (k) => (await one(`SELECT ((now() AT TIME ZONE 'America/Bogota')::date + $1::int)::text d`, [D0 + k])).d;
        caso = { org, jefe: jefe.id, d1, molde: molde.id, aux, D: [await dia(0), await dia(3), await dia(6), await dia(9), await dia(12), await dia(15)] };
        // El detector de «no tiene carro» solo mira 36 h adelante: su prueba va con MAÑANA, si mañana no tiene ya vueltas de un jefe.
        const man = await one(`SELECT ((now() AT TIME ZONE 'America/Bogota')::date + 1)::text d`);
        const ocupado = (await one(`SELECT count(*)::int n FROM public.route_assignments ra WHERE ra.status IN ('planned', 'in_progress') AND NOT coalesce(ra.auto_created, false)
            AND (ra.planned_start_at AT TIME ZONE 'America/Bogota')::date BETWEEN $1::date AND $1::date + 1`, [man.d])).n;
        caso.DT = ocupado ? null : man.d;
      }
    }
    if (!caso) console.log('  · (dev no tiene con qué armar el caso: jefe, conductor, dos tripulantes y un pedido de molde)');
  }
  const H = {};
  if (caso) {
    const { org } = caso;
    H.cuando = (d, hhmm) => one(`SELECT (($1::date + $2::time) AT TIME ZONE 'America/Bogota') t`, [d, hhmm]).then((x) => x.t);
    // Un pedido de salida (compartido) para ese día y hora, clonado del molde. Sin disparadores: reubicar se llama aparte.
    H.pedidoSql = `INSERT INTO public.reservations SELECT (jsonb_populate_record(NULL::public.reservations, to_jsonb(b) || jsonb_build_object(
          'id', gen_random_uuid(), 'auxiliar_profile_id', $2::uuid, 'direction', 'home_to_airport', 'required_arrival_at', (($3::date + $4::time) AT TIME ZONE 'America/Bogota'),
          'calculated_pickup_at', NULL, 'cancelled_at', NULL, 'cancelled_by', NULL, 'cancellation_reason', NULL, 'status_h2a', 'requested', 'status_a2h', NULL,
          'flight_id', NULL, 'flight_code', NULL, 'reserve_place', NULL, 'ground_ops', false, 'service_level', 'shared', 'private_status', NULL, 'quiet_ride', false,
          'rating', NULL, 'rating_tags', NULL, 'rated_at', NULL, 'ready_confirmed_at', NULL, 'boarding_check', NULL, 'boarding_checked_at', NULL, 'notes', NULL,
          'created_at', now(), 'updated_at', now()))).* FROM public.reservations b WHERE b.id = $1 RETURNING id`;
    H.pedido = (a, d, hhmm) => sinDisparadores(async () => (await one(H.pedidoSql, [caso.molde, a.id, d, hhmm])).id);
    H.vuelta = async (d, hhmm, extra = {}) => (await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at, pool, auto_created, organization_id, manual_day)
        VALUES ($1, NULL, $2, $3, (($4::date + $5::time) AT TIME ZONE 'America/Bogota'), $6, $7, $8, $9::date) RETURNING id`,
      [extra.driver || null, extra.dir || 'airport_to_home', extra.status || 'planned', d, hhmm, extra.pool ?? true, extra.auto ?? false, org, extra.manualDay || null])).id;
    H.marca = (d) => one(`SELECT source, published_by FROM public.route_published_days WHERE organization_id = $1 AND day = $2::date`, [org, d]);
    H.masUno = async (d) => (await one(`SELECT ($1::date + 1)::text d`, [d])).d;
    H.reubicar = async (res, motivo) => (await one(`SELECT public.reubicar_reserva($1, NULL, $2) j`, [res, motivo])).j;
    H.parada = (res) => one(`SELECT rs.id, ra.auto_created, ra.planned_start_at FROM public.route_stops rs JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id WHERE rs.reservation_id = $1`, [res]);
    H.avisos = (a) => q(`SELECT title, left(body, 140) body FROM public.notification_outbox WHERE profile_id = $1 AND created_at >= now() ORDER BY title`, [a.profile_id]);
    H.sinCarro = async (res) => { await c.query(`SELECT public.detect_late_bookings()`); return !!(await one(`SELECT 1 x FROM public.late_booking_candidates WHERE reservation_id = $1`, [res])); };
    H.sinFreno = () => c.query(`DELETE FROM public.acomodo_creadas WHERE organization_id = $1`, [org]);

    // ── ANTES: el problema, con las funciones de hoy ──
    console.log('\n  — ANTES de 0178 (lo que pasó el 17-nov) —');
    await c.query('SAVEPOINT antes');
    {
      const [D1] = caso.D, [a1, a2] = caso.aux;
      await H.sinFreno();
      await H.vuelta(D1, '00:40');   // una llegada de la madrugada, de la ruta del día anterior, sin su día del plan
      const p = await H.pedido(a1, D1, '09:30');
      const j = await H.reubicar(p, 'pedido');
      const av = await H.avisos(a1);
      t(`con una sola vuelta suelta a las 00:40, a quien pide para ese día el sistema le arma vuelta (${j.kind}) y le dice hora`, j.kind !== 'unplanned' && !!(await H.parada(p)) && av.some((x) => /Ya tienes carro/.test(x.title + x.body)), { j, av });
      console.log('    ·', av.map((x) => x.title + ' — ' + x.body).join(' | ') || '(sin aviso)');
      if (caso.DT) {
        await H.vuelta(caso.DT, '00:40');
        const p2 = await H.pedido(a2, caso.DT, '10:30');
        t('…y el detector de «no tiene carro» también da por publicado el día de esa vuelta de las 00:40', await H.sinCarro(p2));
      } else console.log('    · (mañana ya tiene vueltas en dev: la prueba del detector no corre)');
    }
    await c.query('ROLLBACK TO SAVEPOINT antes');
  }

  // ── La migración ──
  await c.query(sql);
  console.log('\n  — 0178 puesta —');
  t('existe route_published_days con RLS', (await one(`SELECT relrowsecurity r FROM pg_class WHERE oid = to_regclass('public.route_published_days')`) || {}).r === true);
  for (const f of ['marcar_dia_publicado', 'dia_publicado', 'tg_route_assignments_dia_publicado']) { const g = await priv(f); t(`${f}: ni la app ni anónimos la llaman`, !!g && !g.a && !g.n, g); }
  t('los dos disparadores de la marca están en route_assignments', (await q(`SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.route_assignments'::regclass AND tgname IN ('tr_route_assignments_dia_publicado_ins', 'tr_route_assignments_dia_publicado_upd') AND NOT tgisinternal`)).length === 2);
  const dR = await def('reubicar_reserva'), dD = await def('detect_late_bookings');
  t('reubicar_reserva decide con la marca (ya no con dia_del_plan)', /public\.dia_publicado\(r\.org, r\.required_arrival_at\)/.test(dR) && !/dia_del_plan/.test(dR));
  t('detect_late_bookings ya no usa dia_del_plan', !/dia_del_plan\(/.test(dD) && /0178/.test(dD));
  for (const f of FNS) { const g = await priv(f); t(`${f}: los mismos permisos de antes`, JSON.stringify(g) === JSON.stringify(antes[f]), { antes: antes[f], ahora: g }); }
  t('una sola firma de cada función', (await q(`SELECT 1 FROM pg_proc WHERE proname = ANY($1) AND pronamespace = 'public'::regnamespace`, [FNS])).length === 2);
  const marcas = await q(`SELECT d.day::text d, d.source, (SELECT count(*)::int FROM public.route_assignments ra WHERE ra.organization_id = d.organization_id AND NOT coalesce(ra.auto_created, false)
        AND coalesce(ra.manual_day, public.dia_madrugada(ra.planned_start_at), (ra.planned_start_at AT TIME ZONE 'America/Bogota')::date) = d.day) vueltas FROM public.route_published_days d ORDER BY 1`);
  console.log('    · días que quedan marcados como publicados:', marcas.map((m) => `${m.d} (${m.vueltas} vueltas del jefe)`).join(' · ') || 'ninguno');
  const hoy = (await one(`SELECT (now() AT TIME ZONE 'America/Bogota')::date::text d`)).d;
  t('ningún día marcado es anterior a ayer ni quedó sin vueltas', marcas.every((m) => m.vueltas > 0 && m.d >= new Date(Date.parse(hoy) - 86400000).toISOString().slice(0, 10)), marcas);
  // Pedidos por venir que hoy van en una vuelta que armó el sistema, en un día SIN marca (no debería haber).
  const colgados = await q(`SELECT (r.required_arrival_at AT TIME ZONE 'America/Bogota')::date::text d, count(*)::int n FROM public.route_stops rs JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id AND ra.auto_created AND ra.status = 'planned'
      JOIN public.reservations r ON r.id = rs.reservation_id JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id JOIN public.profiles pr ON pr.id = ap.profile_id
     WHERE r.required_arrival_at > now() AND r.cancelled_at IS NULL AND NOT public.dia_publicado(pr.organization_id, r.required_arrival_at) GROUP BY 1 ORDER BY 1`);
  console.log('    · pedidos por venir en vueltas del sistema en días sin marca:', colgados.map((x) => `${x.d}: ${x.n}`).join(' · ') || 'ninguno');

  if (caso) {
    console.log('\n  — DESPUÉS de 0178 —');
    await c.query('SAVEPOINT despues');
    const { org, jefe, d1 } = caso, [D1, D2, D3, D4, D5, D6] = caso.D, [a1, a2] = caso.aux;
    await H.sinFreno();

    // 1. El caso del 17-nov: la vuelta suelta ya no publica el día.
    await H.vuelta(D1, '00:40');
    t('la vuelta suelta de madrugada (la puso el sistema, sin sesión de jefe) no marca ningún día', !(await H.marca(D1)) && (await one(`SELECT count(*)::int n FROM public.route_published_days WHERE organization_id = $1 AND day >= $2::date - 1`, [org, D1])).n === 0);
    const p1 = await H.pedido(a1, D1, '09:30');
    const j1 = await H.reubicar(p1, 'pedido');
    const av1 = await H.avisos(a1);
    t(`quien pide para ese día queda SIN vuelta y SIN hora (${j1.kind})`, j1.kind === 'unplanned' && !(await H.parada(p1)) && av1.length === 0, { j1, av1 });
    // …y por el camino real: el pedido entra con sus disparadores (así lo hace la app).
    const e2e = await (async () => { await c.query('SAVEPOINT pedido_real'); try { const id = (await one(H.pedidoSql, [caso.molde, a2.id, D1, '11:00'])).id; return { id }; } catch (e) { await c.query('ROLLBACK TO SAVEPOINT pedido_real'); return { error: e.message }; } })();
    if (e2e.error) console.log('    · (el pedido con disparadores no se pudo insertar aquí: ' + e2e.error.slice(0, 120) + ')');
    else t('…igual si el pedido entra con sus disparadores: ni parada ni «Ya tienes carro»', !(await H.parada(e2e.id)) && !(await H.avisos(a2)).some((x) => /Ya tienes carro|armamos/.test(x.title + x.body)), await H.avisos(a2));
    if (caso.DT) {
      await H.vuelta(caso.DT, '00:40');
      const p1b = await H.pedido(a2, caso.DT, '10:30');
      t('el detector de «no tiene carro» ya no da por publicado el día de una vuelta suelta de las 00:40', !(await H.sinCarro(p1b)));
      // …pero si el jefe sí publicó ese día, sigue avisando de quien quedó por fuera.
      await sesion(jefe); await H.vuelta(caso.DT, '06:00', { driver: d1.id, dir: 'home_to_airport', pool: false }); await comoDb();
      t('…y con el día publicado de verdad sigue viendo a quien quedó sin carro', !!(await H.marca(caso.DT)) && (await H.sinCarro(p1b)));
    }

    // 2. El jefe publica desde el tablero (la app inserta la vuelta directo): queda la marca.
    await comoApp(jefe);
    await H.vuelta(D2, '05:00', { driver: d1.id, dir: 'home_to_airport', pool: false });
    const D2m = await H.masUno(D2);
    await H.vuelta(D2m, '00:40', { driver: d1.id, pool: false });   // la última llegada de esa noche, pasada la medianoche
    await comoDb();
    const m2 = await H.marca(D2);
    t('Publicar del tablero deja la marca del día, a nombre del jefe', !!m2 && m2.source === 'tablero' && m2.published_by === jefe, m2);
    t('…y su llegada de las 00:40 cuenta para ese día, no marca el siguiente', !(await H.marca(D2m)));
    const p2 = await H.pedido(a1, D2, '09:30');
    const j2 = await H.reubicar(p2, 'pedido');
    const av2 = await H.avisos(a1);
    t(`con la ruta ya publicada, quien pide tarde SÍ queda con vuelta y hora (${j2.kind})`, ['new', 'joined', 'retimed'].includes(j2.kind) && !!(await H.parada(p2)) && av2.some((x) => /Ya tienes carro/.test(x.title + x.body)), { j2, av2 });
    console.log('    ·', av2.map((x) => x.title + ' — ' + x.body).join(' | ') || '(sin aviso)');
    const f = async (d, hhmm) => (await one(`SELECT public.dia_publicado($1, (($2::date + $3::time) AT TIME ZONE 'America/Bogota')) x`, [org, d, hhmm])).x;
    t('dia_publicado: el día sí; su madrugada siguiente (00:30) sí; las 03:00 del otro día no', (await f(D2, '09:30')) === true && (await f(D2m, '00:30')) === true && (await f(D2m, '03:00')) === false);

    // 3. Un borrador que el jefe pasa a publicado poniéndole conductor.
    const b3 = await H.vuelta(D3, '06:00', { status: 'draft', dir: 'home_to_airport', pool: false });
    const p3 = await H.pedido(a1, D3, '06:40');
    await c.query(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, status, estimated_arrival_at) VALUES ($1, $2, 1, 'pending', (($3::date + time '06:10') AT TIME ZONE 'America/Bogota'))`, [b3, p3, D3]);
    t('un borrador no marca el día', !(await H.marca(D3)));
    await comoApp(jefe);
    const r3 = await (async () => { await c.query('SAVEPOINT s3'); try { return (await one(`SELECT public.admin_route_set_driver($1, $2) j`, [b3, d1.id])).j; } catch (e) { await c.query('ROLLBACK TO SAVEPOINT s3'); return { error: e.message }; } })();
    await comoDb();
    const m3 = await H.marca(D3);
    t('el jefe le pone conductor a ese borrador (queda publicada) → marca', !r3.error && !!m3 && m3.source === 'vuelta', { r3, m3 });

    // 4. Quién NO marca.
    await H.vuelta(D4, '07:00');   // sin sesión: el reloj
    t('una vuelta creada sin sesión (el reloj) no marca', !(await H.marca(D4)));
    await sesion(d1.profile_id); await H.vuelta(D4, '07:30'); await comoDb();
    t('una vuelta creada con la sesión de un conductor (soltar) no marca', !(await H.marca(D4)));
    await sesion(a1.profile_id); await H.vuelta(D4, '08:00'); await comoDb();
    t('una vuelta creada con la sesión de un tripulante no marca', !(await H.marca(D4)));
    await sesion(jefe); await H.vuelta(D4, '08:30', { auto: true }); await comoDb();
    t('una vuelta que armó el sistema (auto_created) no marca aunque la dispare un jefe', !(await H.marca(D4)));

    // 5. Pegar la ruta (admin_manual_route_publish): marca el día de la lista.
    const p5 = await H.pedido(a1, D5, '09:30');
    const b5 = [{ type: 'sal', flight: null, note: null, deadline_at: await H.cuando(D5, '09:30'), stops: [{ reservation_id: p5, at: await H.cuando(D5, '09:00') }] }];
    await comoApp(jefe);
    const r5 = await (async () => { await c.query('SAVEPOINT s5'); try { return (await one(`SELECT public.admin_manual_route_publish($1::date, $2::jsonb, '[]'::jsonb) j`, [D5, JSON.stringify(b5)])).j; } catch (e) { await c.query('ROLLBACK TO SAVEPOINT s5'); return { error: e.message }; } })();
    await comoDb();
    const m5 = await H.marca(D5);
    t(`pegar la ruta del día (creó ${r5.created ?? '?'} vuelta) → marca «pegar» a nombre del jefe`, !r5.error && r5.created === 1 && !!m5 && m5.source === 'pegar' && m5.published_by === jefe, { r5, m5 });

    // 6. A quien el jefe ya tiene en una vuelta suya no se le saca, aunque el día no tenga marca.
    const v6 = await H.vuelta(D6, '09:00', { driver: d1.id, dir: 'home_to_airport', pool: false });   // sin sesión de jefe: no marca
    const p6 = await H.pedido(a1, D6, '09:40');
    await c.query(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, status, estimated_arrival_at) VALUES ($1, $2, 1, 'pending', (($3::date + time '09:10') AT TIME ZONE 'America/Bogota'))`, [v6, p6, D6]);
    const j6 = await H.reubicar(p6, 'cambio');
    t(`día sin marca pero la persona va en una vuelta del jefe: no la saca (${j6.kind})`, !(await H.marca(D6)) && j6.kind !== 'unplanned' && !!(await H.parada(p6)), j6);
    const p6b = await H.pedido(a2, D6, '10:30');
    const j6b = await H.reubicar(p6b, 'pedido');
    t(`…y otro que pide para ese mismo día sin marca queda sin hora (${j6b.kind})`, j6b.kind === 'unplanned' && !(await H.parada(p6b)), j6b);

    await c.query('ROLLBACK TO SAVEPOINT despues');
    t('el caso armado se deshizo', (await one(`SELECT count(*)::int n FROM public.route_published_days WHERE organization_id = $1 AND (day >= $2::date - 1 OR day = $3::date)`, [org, D1, caso.DT])).n === 0);
  }
  if (fallas.length) throw new Error(fallas.length + ' comprobaciones fallaron');
  if (!aplicar) { await c.query('ROLLBACK'); console.log('\n  EN SECO: todo en verde y DESHECHO. Para confirmarlo: --aplicar'); }
  else { await c.query('COMMIT'); console.log('\n  ✓ 0178 APLICADA en ' + (prod ? 'PRODUCCIÓN' : 'dev')); }
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error('\n  ✗ NO se aplicó nada:', e.message); process.exitCode = 1;
}
await c.end();
