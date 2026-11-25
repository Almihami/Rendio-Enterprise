// 0179 · La hora de recogida se dice aunque la vuelta no tenga conductor (auxiliar_my_trips).
//   cd rendio-backend && set -a && source <.env.dev|.env.main> && set +a && node scripts/_aplicar-0179.mjs [--produccion] [--aplicar]
//
// dev sin --aplicar: EN SECO (todo se deshace con ROLLBACK).
//   1. A cada tripulante: la función viva contra el cuerpo NUEVO corrido como consulta. Solo
//      puede cambiar la salida en una vuelta sin conductor de un día publicado.
//   2. Un caso armado (día lejano y vacío): borrador antes y después de publicar el día, la
//      madrugada, una llegada en borrador, un borrador automático y el mismo con conductor;
//      primero con la función de ANTES (el problema del 24-nov) y después con 0179.
// --produccion sin --aplicar: SOLO LECTURA (BEGIN READ ONLY): solo el paso 1, con la gente real.
// --aplicar: las mismas comprobaciones y, si todo pasa, aplica 0179 (COMMIT). El caso armado
//   nunca se queda (savepoint).
// Antes de tocar nada comprueba que auxiliar_my_trips esté EXACTAMENTE como la leyó el
// generador (scripts/_base-0179/prod-auxiliar_my_trips.sql): si cambió, no sigue.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const pg = createRequire('/Users/harold/Documents/Rendio-Drivers/Proyect-main-0164/rendio-backend/scripts/x.js')('pg');
const DEV = 'lxlphbafhtphulanhzlp', PROD = 'wvuurnfdrrdondrbbkhd';
const prod = process.argv.includes('--produccion'), aplicar = process.argv.includes('--aplicar');
const esperado = prod ? PROD : DEV;
if ((process.env.SUPABASE_PROJECT_REF || '') !== esperado || !(process.env.SUPABASE_URL || '').includes(esperado)) { console.error(`ABORT: se esperaba ${prod ? 'PRODUCCIÓN' : 'dev'} (${esperado})`); process.exit(2); }
const c = new pg.Client({ host: prod ? 'aws-1-us-west-2.pooler.supabase.com' : 'aws-1-us-east-1.pooler.supabase.com', port: 5432, database: 'postgres', user: 'postgres.' + esperado, password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false }, statement_timeout: 120000 });
await c.connect();
const q = async (s, v) => (await c.query(s, v)).rows, one = async (s, v) => (await q(s, v))[0];
const fallas = []; const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + (typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 700) : ''}`); if (!ok) fallas.push(n); };
const hm = (x) => x ? new Date(x).toLocaleString('es-CO', { timeZone: 'America/Bogota', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '-';

const MIG = readFileSync(new URL('../supabase/migrations/0179_hora_sin_conductor.sql', import.meta.url), 'utf8');
const sql = MIG.replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const base = readFileSync(new URL('./_base-0179/prod-auxiliar_my_trips.sql', import.meta.url), 'utf8').trimEnd();
// El cuerpo NUEVO como consulta suelta: v_aux, v_days y v_org pasan a ser parámetros.
const cuerpo = (() => {
  const a = MIG.indexOf('RETURN COALESCE(('), b = MIG.indexOf("), '[]'::jsonb);");
  if (a < 0 || b < a) throw new Error('no encontré el cuerpo de la función en la migración');
  const s = MIG.slice(a + 'RETURN COALESCE(('.length, b);
  return 'SELECT COALESCE((' + s.replace(/\bv_aux\b/g, '$1::uuid').replace(/\bv_days\b/g, '$2::int').replace(/\bv_org\b/g, '$3::uuid') + "), '[]'::jsonb) j";
})();
const def = async () => { const r = await q(`SELECT pg_get_functiondef(p.oid) d FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'auxiliar_my_trips'`); return r.length === 1 ? r[0].d.trimEnd() : null; };
const priv = () => one(`SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('anon', p.oid, 'EXECUTE') n FROM pg_proc p WHERE p.proname = 'auxiliar_my_trips' AND p.pronamespace = 'public'::regnamespace`);
// La función como la llama la app: con la sesión del tripulante.
const comoApp = async (uid) => {
  await c.query(`SELECT set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true), set_config('request.jwt.claim.role', 'authenticated', true)`, [JSON.stringify({ sub: uid, role: 'authenticated' }), uid]);
  await c.query('SET LOCAL ROLE authenticated');
};
const comoDb = async () => { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', '', true), set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claim.role', '', true)`); };
const viva = async (uid) => { await c.query('SAVEPOINT v'); try { await comoApp(uid); return (await one(`SELECT public.auxiliar_my_trips(60) j`)).j || []; } finally { await c.query('ROLLBACK TO SAVEPOINT v'); await comoDb(); } };
const nueva = async (g) => (await one(cuerpo, [g.aux, 60, g.org])).j || [];
const sinDisparadores = async (f) => { await c.query(`SET LOCAL session_replication_role = replica`); try { return await f(); } finally { await c.query(`SET LOCAL session_replication_role = origin`); } };

// Qué cambia de un viaje a otro (por id).
const CLAVES = ['published', 'pickup_at', 'meet_code', 'pickup_pos', 'pickup_total', 'stop_status', 'arrived_at', 'picked_at', 'dropped_at', 'driver_pending', 'delegated', 'delegate', 'driver', 'vehicle', 'raw_status'];
function cambios(antes, despues) {
  const A = Object.fromEntries(antes.map((x) => [x.id, x])), out = [];
  if (antes.length !== despues.length) out.push({ id: '*', k: 'cantidad', a: antes.length, d: despues.length });
  for (const x of despues) {
    const y = A[x.id]; if (!y) { out.push({ id: x.id, k: 'nuevo' }); continue; }
    const ks = Object.keys({ ...x, ...y }).filter((k) => JSON.stringify(x[k]) !== JSON.stringify(y[k]));
    if (ks.length) out.push({ id: x.id, ks, antes: y, despues: x });
  }
  return out;
}
// El único cambio permitido: salida que antes no estaba publicada y ahora sí, sin conductor, con hora.
const esperado0179 = (ch) => ch.antes && ch.despues.direction === 'home_to_airport' && ch.antes.published === false && ch.despues.published === true
  && ch.despues.driver === null && ch.despues.vehicle === null && ch.despues.meet_code === null && ch.despues.driver_pending === true
  && ch.ks.every((k) => ['published', 'pickup_at', 'pickup_pos', 'pickup_total', 'stop_status', 'driver_pending'].includes(k));

console.log(`\n== 0179 ${aplicar ? 'APLICANDO' : prod ? 'SOLO LECTURA' : 'EN SECO'} en ${prod ? 'PRODUCCIÓN' : 'dev'} ==`);
await c.query(prod && !aplicar ? 'BEGIN TRANSACTION READ ONLY' : 'BEGIN');
try {
  await c.query(`SET LOCAL lock_timeout = '5s'`);
  const d0 = await def(), p0 = await priv();
  const ya = !!d0 && /0179/.test(d0);
  t(`auxiliar_my_trips está como la leyó el generador${ya ? ' (ya es la de 0179)' : ''}`, !!d0 && (ya || d0 === base), d0 ? 'la definición viva no es la de scripts/_base-0179' : 'no existe');
  for (const f of ['dia_publicado', 'dia_madrugada']) t('está ' + f, !!(await one(`SELECT 1 x FROM pg_proc WHERE proname = $1 AND pronamespace = 'public'::regnamespace`, [f])));
  t('está la tabla route_published_days', !!(await one(`SELECT to_regclass('public.route_published_days') r`)).r);
  if (fallas.length) throw new Error('la base no está como se esperaba: no se aplica');

  // ── 1. Cada tripulante: función viva contra el cuerpo nuevo ──
  const gente = await q(`SELECT ap.id aux, p.id uid, p.full_name n, p.organization_id org FROM public.auxiliar_profiles ap JOIN public.profiles p ON p.id = ap.profile_id
      WHERE p.deleted_at IS NULL AND EXISTS (SELECT 1 FROM public.reservations r WHERE r.auxiliar_profile_id = ap.id AND r.required_arrival_at >= now() - interval '60 days') ORDER BY p.full_name`);
  let iguales = 0; const nuevos = [], raros = [];
  for (const g of gente) {
    const antes = await viva(g.uid), despues = await nueva(g);
    const ch = cambios(antes, despues);
    if (!ch.length) { iguales++; continue; }
    for (const x of ch) (esperado0179(x) ? nuevos : raros).push({ g, x });
  }
  console.log(`  · ${gente.length} tripulantes: ${iguales} ven exactamente lo mismo`);
  for (const { g, x } of nuevos) console.log(`      ahora ve su hora: ${g.n} · salida ${x.despues.date} ${x.despues.time} → te recogemos ${hm(x.despues.pickup_at)}${x.despues.pickup_pos ? ` (recogida ${x.despues.pickup_pos}/${x.despues.pickup_total})` : ''}`);
  t('lo único que cambia es la salida sin conductor de un día publicado (ahora con hora)', !raros.length, raros.slice(0, 3).map(({ g, x }) => ({ n: g.n, ...x, antes: undefined, despues: undefined, a: x.antes && Object.fromEntries((x.ks || []).map((k) => [k, x.antes[k]])), d: x.despues && Object.fromEntries((x.ks || []).map((k) => [k, x.despues[k]])) })));
  t('ninguna salida nueva sin hora', nuevos.every(({ x }) => x.despues.pickup_at), nuevos.filter(({ x }) => !x.despues.pickup_at).map(({ g }) => g.n));

  if (!prod || aplicar) {
    // ── 2. El caso armado (solo dev), con la función de antes y con 0179 ──
    await c.query('SAVEPOINT caso');
    let caso = null;
    if (!prod) {
      const org = (await one(`SELECT p.organization_id o FROM public.profiles p WHERE p.role = 'admin' AND p.deleted_at IS NULL
          AND (SELECT count(*) FROM public.driver_profiles dp JOIN public.profiles x ON x.id = dp.profile_id WHERE x.organization_id = p.organization_id) >= 1
          AND (SELECT count(*) FROM public.auxiliar_profiles ap JOIN public.profiles x ON x.id = ap.profile_id WHERE x.organization_id = p.organization_id AND x.deleted_at IS NULL) >= 2
        LIMIT 1`) || {}).o;
      const d1 = org && await one(`SELECT dp.id FROM public.driver_profiles dp JOIN public.profiles x ON x.id = dp.profile_id WHERE x.organization_id = $1 AND x.deleted_at IS NULL ORDER BY dp.id LIMIT 1`, [org]);
      const molde = org && await one(`SELECT r.id, r.auxiliar_profile_id a FROM public.reservations r JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id JOIN public.profiles x ON x.id = ap.profile_id
          WHERE x.organization_id = $1 AND x.deleted_at IS NULL AND r.direction = 'home_to_airport' ORDER BY r.created_at DESC LIMIT 1`, [org]);
      const aux = molde && await q(`SELECT ap.id, ap.profile_id uid, x.organization_id org FROM public.auxiliar_profiles ap JOIN public.profiles x ON x.id = ap.profile_id
          WHERE x.organization_id = $1 AND x.deleted_at IS NULL ORDER BY (ap.id = $2) DESC, ap.id LIMIT 2`, [org, molde.a]);
      let D = null;
      for (let salto = 40; salto <= 200 && !D; salto += 20) {
        const n = (await one(`SELECT (SELECT count(*) FROM public.route_assignments ra WHERE ra.planned_start_at BETWEEN now() + make_interval(days => $1::int - 3) AND now() + make_interval(days => $1::int + 3))
            + (SELECT count(*) FROM public.route_published_days d WHERE d.day BETWEEN (now() AT TIME ZONE 'America/Bogota')::date + $1::int - 3 AND (now() AT TIME ZONE 'America/Bogota')::date + $1::int + 3) n`, [salto])).n;
        if (!+n) D = (await one(`SELECT ((now() AT TIME ZONE 'America/Bogota')::date + $1::int)::text d`, [salto])).d;
      }
      if (org && d1 && molde && aux && aux.length === 2 && D) caso = { org, d1: d1.id, molde: molde.id, A: aux[0], B: aux[1], D, D1: (await one(`SELECT ($1::date + 1)::text d`, [D])).d };
      if (!caso) console.log('  · (dev no tiene con qué armar el caso: jefe, conductor, dos tripulantes y un pedido de molde)');
    }
    if (caso) {
      const { org, A, B, D, D1 } = caso;
      const pedido = (a, dir, d, hhmm) => sinDisparadores(async () => (await one(`INSERT INTO public.reservations SELECT (jsonb_populate_record(NULL::public.reservations, to_jsonb(b) || jsonb_build_object(
          'id', gen_random_uuid(), 'auxiliar_profile_id', $2::uuid, 'direction', $5::text, 'required_arrival_at', (($3::date + $4::time) AT TIME ZONE 'America/Bogota'),
          'calculated_pickup_at', NULL, 'cancelled_at', NULL, 'cancelled_by', NULL, 'cancellation_reason', NULL,
          'status_h2a', CASE WHEN $5 = 'home_to_airport' THEN 'requested' END, 'status_a2h', CASE WHEN $5 = 'airport_to_home' THEN 'scheduled' END,
          'flight_id', NULL, 'reserve_place', NULL, 'ground_ops', false, 'service_level', 'shared', 'private_status', NULL, 'meet_code', '77',
          'rating', NULL, 'ready_confirmed_at', NULL, 'notes', NULL, 'created_at', now(), 'updated_at', now()))).* FROM public.reservations b WHERE b.id = $1 RETURNING id`,
        [caso.molde, a.id, d, hhmm, dir])).id);
      const vuelta = (d, hhmm, o = {}) => sinDisparadores(async () => (await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at, pool, auto_created, organization_id, plan_car)
          VALUES ($1, NULL, $2, $3, (($4::date + $5::time) AT TIME ZONE 'America/Bogota'), false, $6, $7, 'Carro 3') RETURNING id`,
        [o.driver || null, o.dir || 'home_to_airport', o.status || 'draft', d, hhmm, o.auto ?? false, org])).id);
      const parada = (ra, res, n, d, hhmm) => sinDisparadores(() => c.query(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, status, estimated_arrival_at)
          VALUES ($1, $2, $3, 'pending', (($4::date + $5::time) AT TIME ZONE 'America/Bogota'))`, [ra, res, n, d, hhmm]));
      const cuando = async (d, hhmm) => new Date((await one(`SELECT (($1::date + $2::time) AT TIME ZONE 'America/Bogota') t`, [d, hhmm])).t).getTime();
      const de = async (a, res) => (await viva(a.uid)).find((x) => x.id === res) || null;
      const marcar = (d) => c.query(`INSERT INTO public.route_published_days (organization_id, day, source) VALUES ($1, $2::date, 'prueba-0179') ON CONFLICT DO NOTHING`, [org, d]);

      console.log(`\n  -- Caso armado: día ${D}`);
      // Salida en borrador (Carro 3) con dos personas: A a las 05:10, B a las 05:25.
      const pA = await pedido(A, 'home_to_airport', D, '06:00'), pB = await pedido(B, 'home_to_airport', D, '06:00');
      const v1 = await vuelta(D, '05:10'); await parada(v1, pA, 1, D, '05:10'); await parada(v1, pB, 2, D, '05:25');
      // Madrugada del día siguiente (cuenta para D), una llegada y una automática, en borrador.
      const pM = await pedido(A, 'home_to_airport', D1, '02:30'); const vM = await vuelta(D1, '01:30'); await parada(vM, pM, 1, D1, '01:40');
      const pL = await pedido(A, 'airport_to_home', D, '15:00'); const vL = await vuelta(D, '15:10', { dir: 'airport_to_home' }); await parada(vL, pL, 1, D, '15:10');
      const pX = await pedido(B, 'home_to_airport', D, '20:00'); const vX = await vuelta(D, '19:00', { auto: true }); await parada(vX, pX, 1, D, '19:00');

      const antesSin = await de(A, pA);
      await marcar(D);
      const antesCon = await de(A, pA);
      t('ANTES (función de antes): día sin publicar → sin hora', antesSin && antesSin.published === false && antesSin.pickup_at === null, antesSin);
      t('ANTES (función de antes): día YA publicado y aun así sin hora (el problema del 24-nov)', antesCon && antesCon.published === false && antesCon.pickup_at === null, antesCon);

      await c.query(sql);
      const ahA = await de(A, pA), ahB = await de(B, pB);
      t('0179: día publicado → A ve su hora (05:10, la de su parada)', ahA && ahA.published === true && Date.parse(ahA.pickup_at) === await cuando(D, '05:10'), ahA);
      t('0179: B ve la suya (05:25)', ahB && ahB.published === true && Date.parse(ahB.pickup_at) === await cuando(D, '05:25'), ahB);
      t('0179: «tu ruta está lista, falta conductor» (driver_pending), sin conductor, sin carro, sin código', ahA && ahA.driver_pending === true && ahA.driver === null && ahA.vehicle === null && ahA.meet_code === null && ahA.delegated === false, ahA);
      t('0179: su lugar en la vuelta: A 1/2 y B 2/2', ahA && ahA.pickup_pos === 1 && ahA.pickup_total === 2 && ahB && ahB.pickup_pos === 2 && ahB.pickup_total === 2, [ahA && [ahA.pickup_pos, ahA.pickup_total], ahB && [ahB.pickup_pos, ahB.pickup_total]]);
      const ahM = await de(A, pM);
      t('0179: la madrugada siguiente (01:40) cuenta para el día publicado', ahM && ahM.published === true && Date.parse(ahM.pickup_at) === await cuando(D1, '01:40'), ahM);
      const ahL = await de(A, pL), ahX = await de(B, pX);
      t('0179: la llegada en borrador sigue sin hora', ahL && ahL.published === false && ahL.pickup_at === null, ahL);
      t('0179: el borrador automático sigue sin hora', ahX && ahX.published === false && ahX.pickup_at === null, ahX);
      // Otro día sin marca: el borrador sigue sin hora.
      const D2 = (await one(`SELECT ($1::date + 3)::text d`, [D])).d;
      const pS = await pedido(B, 'home_to_airport', D2, '09:00'); const vS = await vuelta(D2, '08:00'); await parada(vS, pS, 1, D2, '08:10');
      const ahS = await de(B, pS);
      t('0179: día SIN publicar → el borrador sigue sin hora («te avisamos cuando armemos tu ruta»)', ahS && ahS.published === false && ahS.pickup_at === null, ahS);
      // Con conductor: lo de siempre (la hora es calculated_pickup_at; aquí vacía, como antes).
      await sinDisparadores(() => c.query(`UPDATE public.route_assignments SET status = 'planned', driver_profile_id = $2 WHERE id = $1`, [v1, caso.d1]));
      await sinDisparadores(() => c.query(`UPDATE public.reservations SET calculated_pickup_at = (($2::date + time '05:12') AT TIME ZONE 'America/Bogota') WHERE id = $1`, [pA, D]));
      const ahC = await de(A, pA);
      t('0179: con conductor, como siempre (su hora calculada, su conductor, su código)', ahC && ahC.published === true && Date.parse(ahC.pickup_at) === await cuando(D, '05:12') && ahC.driver && ahC.driver_pending === false && ahC.meet_code === '77', ahC);
    }
    await c.query('ROLLBACK TO SAVEPOINT caso');

    // ── 3. Aplicada de verdad (dentro de la transacción): la función nueva = el cuerpo probado ──
    await c.query(sql);
    t('auxiliar_my_trips quedó con 0179', /0179/.test(await def()));
    const p1 = await priv();
    t('los permisos no cambiaron', JSON.stringify(p1) === JSON.stringify(p0), { antes: p0, despues: p1 });
    let dist = 0;
    for (const g of gente) { if (JSON.stringify(await viva(g.uid)) !== JSON.stringify(await nueva(g))) dist++; }
    t(`la función aplicada da lo mismo que el cuerpo probado (${gente.length} tripulantes)`, dist === 0, `${dist} distintos`);
  }

  if (fallas.length) throw new Error(fallas.length + ' comprobaciones fallaron');
  if (aplicar) { await c.query('COMMIT'); console.log('\nAPLICADA 0179.'); }
  else { await c.query('ROLLBACK'); console.log(`\nTodo en verde. ${prod ? 'Solo se leyó.' : 'En seco: no quedó nada.'}`); }
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error('\nNO SE APLICÓ:', e.message);
  process.exitCode = 1;
} finally { await c.end(); }
