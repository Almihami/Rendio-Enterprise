// Verificación de 0144 («Hay una vuelta para tomar» solo al turno, el freno del
// acomodo y la bandeja de avisos sin repetidos) contra la base LOCAL
// (127.0.0.1:54322). Aplica 0124–0136, 0141, 0143 y 0144 dentro de una
// transacción que se deshace. La prueba de dos corridas a la vez (H2) necesita
// filas confirmadas: las crea con una marca y las borra al final.
// Nunca apunta a dev ni a producción.
//
//   cd rendio-backend/scripts && node _verify-0144.mjs        (antes de las 8 p. m.)
//
//   A. turno_de: la madrugada es la tarde del día anterior; corte–14:00 mañana.
//   B. conductores_del_turno: horario publicado, cambios de turno aceptados,
//      turno abierto (solo si es el turno de ahora), inactivos/borrados fuera.
//   C. avisar_vuelta_para_tomar: solo a los del turno; sin nadie → jefes, una vez.
//   D. El caso de hoy: llegada 23:59 sin carro → vuelta nueva → el aviso solo a
//      los de la tarde (antes: a todos).
//   E. El freno: pasado el máximo en media hora no arma más (kind 'held'), la
//      reserva queda como estaba y a los jefes les llega UN aviso.
//   F. El freno por tanda: más «sin carro» a la vez que el máximo → no acomoda
//      ninguno; con pocos, acomoda.
//   G. Soltar una vuelta: «Hay una vuelta libre» solo a los demás del turno.
//   H. La bandeja: cada fila la aparta UNA corrida (también con dos a la vez).
//   I. Permisos, que se puede volver a correr y el down.
//
// NO cubre: la push de verdad, la función dispatch-notifications corriendo (se
// prueba la RPC que usa), el pg_cron de verdad, el retraso FR24 (usa el mismo
// avisar_vuelta_para_tomar), ni dev/producción.
import fs from 'node:fs';
import { localClient, fixtures, user, asUser, asAdminDb } from './_local-fixtures.mjs';

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
const SIG = {
  rr: 'public.reubicar_reserva(uuid,timestamptz,text)', nota: 'public.reub_nota(jsonb)',
  ac: 'public.acomodar_eventualidades(timestamptz)', rel: 'public.driver_release_route(uuid)',
};
const huellas = async () => { const o = {}; for (const [k, s] of Object.entries(SIG)) o[k] = await huella(s); return o; };
const mismo = (a, b) => [...a].sort().join(',') === [...b].sort().join(',');

const hora = (await one(`SELECT extract(hour FROM now() AT TIME ZONE 'America/Bogota')::int h`)).h;
if (hora >= 20) { console.log('Correr antes de las 8 p. m. (las llegadas de la noche tienen que estar por delante).'); process.exit(2); }

await c.query('BEGIN');
try {
  if (!(await one(`SELECT to_regprocedure('public.ops_alert_recipients_of(uuid)') IS NOT NULL AS ok`)).ok) await c.query(strip('../supabase/migrations/0117_avisos_desde_el_servidor.sql'));
  for (const m of ['0124_carro_del_turno', '0125_ruta_de_julian', '0126_vuelta_delegada', '0127_aviso_sin_carro_espera', '0128_aviso_vuelta_terminada',
    '0129_conductor_de_una_vuelta', '0130_corte_de_pedidos', '0131_delegado_con_nombre', '0132_carro_del_plan', '0133_pasajero_sin_cuenta',
    '0134_reubicar_al_cambiar', '0135_acomodar_eventualidades', '0136_aviso_vuelta_iniciada', '0141_sin_carro_dia_del_plan',
    '0143_pegar_no_borra_automaticas']) await c.query(strip(`../supabase/migrations/${m}.sql`));
  const antes = await huellas();

  await c.query(strip('../supabase/migrations/0144_avisos_por_turno_y_freno.sql'));
  await c.query(strip('../supabase/migrations/0144_avisos_por_turno_y_freno.sql'));
  check('0144 se aplica encima de 0143 (y se puede volver a correr)', true);
  const desp = await huellas();
  check('cambian las cuatro funciones que copia', Object.keys(SIG).every((k) => antes[k] && desp[k] && antes[k] !== desp[k]), { antes, desp });

  await q(`SELECT set_config('rendio.no_acomodar', 'on', true)`);   // armar sin que el disparador actúe
  const fx = await fixtures(c);
  const conductor = async (name) => {
    const u = await user(c, fx.org, 'driver', name);
    return { u, dp: (await one(`INSERT INTO public.driver_profiles (profile_id) VALUES ($1) RETURNING id`, [u])).id };
  };
  const AM = await conductor('Mañanero prueba'), PM = await conductor('Tardero prueba'), PM2 = await conductor('Tardero dos prueba');
  const OFF = await conductor('Descansa prueba'), OPEN = await conductor('Turno abierto prueba');
  const INACT = await conductor('Inactivo prueba'), DEL = await conductor('Borrado prueba');
  await q(`UPDATE public.profiles SET is_active = false WHERE id = $1`, [INACT.u]);
  await q(`UPDATE public.profiles SET deleted_at = now() WHERE id = $1`, [DEL.u]);
  const JUAN = (await conductor('Juan Ospina prueba')).dp;
  const jefe = await user(c, fx.org, 'admin', 'Christian prueba');
  const jefes = (await q(`SELECT profile_id FROM public.ops_alert_recipients_of($1)`, [fx.org])).map((r) => r.profile_id);
  check('hay un jefe que recibe avisos', jefes.includes(jefe), jefes);

  // El horario: mañana AM, tarde PM + PM2 + los inactivos, todos los días de tres semanas.
  const hoy = (await one(`SELECT (now() AT TIME ZONE 'America/Bogota')::date::text d`)).d;
  const man = (await one(`SELECT ((now() AT TIME ZONE 'America/Bogota')::date + 1)::text d`)).d;
  const at = (d, h) => `${d}T${h}:00-05:00`;
  const DIAS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const semana = (extra = {}) => Object.fromEntries(DIAS.map((d) => [d, { morning: [AM.u], afternoon: [PM.u, PM2.u, INACT.u, DEL.u], rest: [OFF.u], ...extra }]));
  for (const k of [-7, 0, 7]) {
    await q(`INSERT INTO public.weekly_schedules (week_start_date, data, published)
      VALUES ((now() AT TIME ZONE 'America/Bogota')::date - (extract(isodow FROM (now() AT TIME ZONE 'America/Bogota')::date)::int - 1) + $1::int, $2, true)
      ON CONFLICT (week_start_date) DO UPDATE SET data = EXCLUDED.data, published = true`, [k, JSON.stringify(semana())]);
  }
  // Turno abierto de OPEN (sin estar en el horario).
  await q(`INSERT INTO public.shifts (organization_id, driver_id, vehicle_id, status, start_at) VALUES ($1, $2, $3, 'active', now() - interval '1 hour')`,
    [fx.org, OPEN.dp, fx.vehicle]);

  // Oráculo independiente del turno (en JS, con el corte de 120 min).
  const turnoJS = (iso) => {
    const d = new Date(Date.parse(iso) - 5 * 3600000);                        // Bogotá (UTC−5, sin horario de verano)
    const m = d.getUTCHours() * 60 + d.getUTCMinutes();
    const dia = new Date(d.getTime() - (m < 120 ? 86400000 : 0)).toISOString().slice(0, 10);
    return `${dia}/${m < 120 || m >= 840 ? 'pm' : 'am'}`;
  };
  const ahora = turnoJS(new Date().toISOString());
  const esperados = (iso) => [...(turnoJS(iso).endsWith('/am') ? [AM.u] : [PM.u, PM2.u]), ...(turnoJS(iso) === ahora ? [OPEN.u] : [])];
  const delTurno = async (iso) => (await q(`SELECT profile_id FROM public.conductores_del_turno($1, $2::timestamptz)`, [fx.org, iso])).map((r) => r.profile_id);
  const enSavepoint = async (fn) => { await c.query('SAVEPOINT sp'); try { return await fn(); } finally { await c.query('ROLLBACK TO SAVEPOINT sp'); } };
  const avisos = async (title, desde) => (await q(`SELECT profile_id, dedupe_key, body FROM public.notification_outbox WHERE title = $1 AND created_at >= $2::timestamptz`, [title, desde]));
  const t0 = (await one(`SELECT now()::text t`)).t;   // now() es fijo dentro de la transacción: todo lo nuevo tiene created_at = t0

  // ── A. turno_de ──
  const td = async (iso) => { const r = await one(`SELECT dia::text, turno FROM public.turno_de($1::timestamptz)`, [iso]); return `${r.dia}/${r.turno}`; };
  const casosA = [[at(hoy, '00:30'), null, 'pm'], [at(hoy, '01:59'), null, 'pm'], [at(hoy, '02:00'), hoy, 'am'], [at(hoy, '13:59'), hoy, 'am'],
    [at(hoy, '14:00'), hoy, 'pm'], [at(hoy, '23:59'), hoy, 'pm'], [at(man, '00:00'), hoy, 'pm']];
  for (const [iso, dia, tr] of casosA) {
    const got = await td(iso), want = turnoJS(iso);
    check(`A. ${iso.slice(0, 16)} → ${want}`, got === want && want.endsWith('/' + tr) && (!dia || want.startsWith(dia)), { got, want });
  }

  // ── B. conductores_del_turno ──
  for (const iso of [at(hoy, '09:00'), at(hoy, '16:00'), at(man, '00:30'), at(man, '10:00')]) {
    const got = await delTurno(iso);
    check(`B. ${iso.slice(0, 16)}: los de ${turnoJS(iso)} y nadie más`, mismo(got, esperados(iso)), { got: got.length, want: esperados(iso).length });
  }
  const b1 = await delTurno(at(hoy, '16:00'));
  check('B. fuera: el de descanso, el inactivo y el borrado', ![OFF.u, INACT.u, DEL.u].some((x) => b1.includes(x)));
  check('B. turno abierto: entra en el turno de ahora', (await delTurno(new Date(Date.now() + 60000).toISOString())).includes(OPEN.u));
  check('B. turno abierto: no entra en un turno de pasado mañana', !(await delTurno(new Date(Date.now() + 2 * 86400000).toISOString())).includes(OPEN.u));
  const swap = await enSavepoint(async () => {
    await q(`INSERT INTO public.shift_swaps (requester_id, target_id, week_start_date, from_day, from_shift, to_day, to_shift, state, decided_at)
      VALUES ($1, $2, $3::date - (extract(isodow FROM $3::date)::int - 1), extract(isodow FROM $3::date)::int - 1, 'am',
              extract(isodow FROM $3::date)::int - 1, 'pm', 'accepted', now())`, [AM.u, PM.u, hoy]);
    return { tarde: await delTurno(at(hoy, '16:00')), manana: await delTurno(at(hoy, '09:00')) };
  });
  check('B. cambio de turno aceptado: el de la mañana pasa a la tarde', swap.tarde.includes(AM.u) && !swap.tarde.includes(PM.u), swap);
  check('B. … y el de la tarde pasa a la mañana', swap.manana.includes(PM.u) && !swap.manana.includes(AM.u), swap);
  const pasado = (await one(`SELECT ((now() AT TIME ZONE 'America/Bogota')::date + 35)::text d`)).d;   // semana sin horario
  await q(`DELETE FROM public.weekly_schedules WHERE week_start_date = $1::date - (extract(isodow FROM $1::date)::int - 1)`, [pasado]);
  check('B. semana sin horario publicado: nadie', (await delTurno(at(pasado, '16:00'))).length === 0);

  // ── C. avisar_vuelta_para_tomar ──
  const c1 = await enSavepoint(async () => {
    const n = (await one(`SELECT public.avisar_vuelta_para_tomar($1, $2::timestamptz, 'Hay una vuelta para tomar', 'Salida de las 16:00 (Ana).', 'prueba-c1') n`,
      [fx.org, at(hoy, '16:00')])).n;
    const a = await avisos('Hay una vuelta para tomar', t0);
    return { n, a, jefe: (await avisos('Nadie del turno para esta vuelta ⚠️', t0)).length };
  });
  check('C. avisa a los del turno y a nadie más', mismo(c1.a.map((x) => x.profile_id), esperados(at(hoy, '16:00'))) && c1.n === c1.a.length, c1);
  check('C. la llave es la de antes (prefijo:conductor) y el texto termina en «Tómala en Ruta si puedes.»',
    c1.a.every((x) => x.dedupe_key === `prueba-c1:${x.profile_id}` && x.body.endsWith('Tómala en Ruta si puedes.')), c1.a[0]);
  check('C. con gente del turno, a los jefes no les llega nada', c1.jefe === 0, c1);
  const c2 = await enSavepoint(async () => {
    for (let i = 0; i < 2; i++) await q(`SELECT public.avisar_vuelta_para_tomar($1, $2::timestamptz, 'Hay una vuelta para tomar', 'Salida de las 16:00 (Ana).', 'prueba-c2')`, [fx.org, at(pasado, '16:00')]);
    return { drv: (await avisos('Hay una vuelta para tomar', t0)).length, jefe: await avisos('Nadie del turno para esta vuelta ⚠️', t0) };
  });
  check('C. sin nadie del turno: a ningún conductor, y a los jefes UNA vez (aunque se llame dos)', c2.drv === 0 && c2.jefe.length === jefes.length, c2);
  const c3 = await enSavepoint(async () => {
    await q(`SELECT public.avisar_vuelta_para_tomar($1, $2::timestamptz, 'Hay una vuelta libre', 'Se liberó.', 'prueba-c3', $3, false)`, [fx.org, at(pasado, '16:00'), PM.u]);
    await q(`SELECT public.avisar_vuelta_para_tomar($1, $2::timestamptz, 'Hay una vuelta libre', 'Se liberó.', 'prueba-c3b', $3, false)`, [fx.org, at(hoy, '16:00'), PM.u]);
    return { jefe: (await avisos('Nadie del turno para esta vuelta ⚠️', t0)).length, a: (await avisos('Hay una vuelta libre', t0)).map((x) => x.profile_id) };
  });
  check('C. p_jefes = false: sin nadie, no molesta a los jefes', c3.jefe === 0, c3);
  check('C. p_except: el que soltó no recibe', !c3.a.includes(PM.u) && c3.a.includes(PM2.u), c3);

  // ── El día de hoy publicado (tablero, con conductor) ──
  const COORD = { [fx.olivar]: [6.1523, -75.3781], [fx.llano]: [6.1175, -75.4152] };
  let n = 0;
  const trip = async (name, resid) => {
    const u = await user(c, fx.org, 'auxiliar', `${name} ${++n}`);
    return { u, a: (await one(`INSERT INTO public.auxiliar_profiles (profile_id, residence_id) VALUES ($1, $2) RETURNING id`, [u, resid])).id, resid };
  };
  const res = async (X, dir, whenIso) => {
    const [lat, lng] = COORD[X.resid];
    return (await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, ${dir === 'sal' ? 'status_h2a' : 'status_a2h'}, required_arrival_at, pickup_address, pickup_latitude, pickup_longitude, residence_id, notes)
      VALUES ($1, $2, $3, $4::timestamptz, 'Rionegro', $5, $6, $7, $8) RETURNING id`,
      [X.a, dir === 'sal' ? 'home_to_airport' : 'airport_to_home', dir === 'sal' ? 'requested' : 'scheduled', whenIso, lat, lng, X.resid,
        dir === 'lle' ? 'Vuelo AV9563.' : null])).id;
  };
  const vuelta = async (dp, dir, startIso, rid, extra = {}) => {
    const ra = (await one(`INSERT INTO public.route_assignments (driver_profile_id, direction, status, planned_start_at, plan_car, pool, organization_id, manual_day)
      VALUES ($1, $2, 'planned', $3::timestamptz, 'Carro 1', $4, $5, $6::date) RETURNING id`,
      [dp, dir === 'sal' ? 'home_to_airport' : 'airport_to_home', startIso, !!extra.pool, fx.org, extra.dia || null])).id;
    if (rid) await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order) VALUES ($1, $2, 1)`, [ra, rid]);
    return ra;
  };
  const vueltaDe = async (rid) => one(`SELECT ra.id, ra.auto_created FROM public.route_stops rs JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
    WHERE rs.reservation_id = $1 AND ra.status IN ('planned','in_progress')`, [rid]);
  const A0 = await trip('Ana', fx.olivar);
  await vuelta(JUAN, 'sal', at(hoy, '22:40'), await res(A0, 'sal', at(hoy, '23:30')));
  const pedir = async (X, dir, iso) => {   // como el tripulante: con el disparador encendido
    await q(`SELECT set_config('rendio.no_acomodar', '', true)`);
    const id = await res(X, dir, iso);
    await q(`SELECT set_config('rendio.no_acomodar', 'on', true)`);
    return id;
  };

  // ── D0. Lo que corría (0143, sin 0144): tiene que avisarles a TODOS ──
  const viejo = await enSavepoint(async () => {
    await c.query(strip('../down_migrations/0144_avisos_por_turno_y_freno.down.sql'));
    const P = await trip('Paula vieja', fx.llano);
    await pedir(P, 'lle', at(hoy, '23:59'));
    return (await avisos('Hay una vuelta para tomar', t0)).map((x) => x.profile_id);
  });
  check('D0. (código viejo) el aviso le llega a todos los activos: también al de la mañana, al de descanso y al de turno abierto',
    [AM.u, OFF.u, OPEN.u, PM.u, PM2.u].every((x) => viejo.includes(x)), viejo.length);

  // ── D. El caso de hoy ──
  const d = await enSavepoint(async () => {
    const P = await trip('Paula', fx.llano);
    const rP = await pedir(P, 'lle', at(hoy, '23:59'));
    const v = await vueltaDe(rP);
    const start = v && (await one(`SELECT planned_start_at::text s FROM public.route_assignments WHERE id = $1`, [v.id])).s;
    return { v, start, a: (await avisos('Hay una vuelta para tomar', t0)).map((x) => x.profile_id),
             crew: (await avisos('Te armamos una vuelta 🚗', t0)).length, cuenta: (await one(`SELECT count(*)::int n FROM public.acomodo_creadas`)).n };
  });
  check('D. Paula (pidió con hoy publicado) queda en una vuelta nueva para tomar', d.v && d.v.auto_created, d);
  check('D. «Hay una vuelta para tomar» solo a los de la tarde de hoy (la vuelta sale a medianoche)',
    d.start && mismo(d.a, esperados(d.start)) && !d.a.includes(AM.u) && !d.a.includes(OFF.u), { a: d.a.length, want: d.start && esperados(d.start).length });
  check('D. a ella le llega «Te armamos una vuelta» y la vuelta cuenta para el freno', d.crew === 1 && d.cuenta === 1, d);

  // ── E. El freno (máximo 2 en media hora) ──
  const e = await enSavepoint(async () => {
    await q(`UPDATE public.app_settings SET acomodo_max_nuevas = 2 WHERE id = 'singleton'`);
    const Q = [await trip('Uno', fx.olivar), await trip('Dos', fx.llano), await trip('Tres', fx.olivar), await trip('Cuatro', fx.llano)];
    const r = [];
    for (const [i, h] of [[0, '20:40'], [1, '21:40'], [2, '22:40'], [3, '23:20']]) r.push(await pedir(Q[i], 'lle', at(hoy, h)));
    const vs = []; for (const id of r) vs.push(!!(await vueltaDe(id)));
    const directo = (await one(`SELECT public.reubicar_reserva($1, NULL, 'pedido') v`, [r[3]])).v;
    const nota = (await one(`SELECT public.reub_nota($1::jsonb) t`, [directo])).t;
    return { vs, directo, nota, cuenta: (await one(`SELECT count(*)::int n FROM public.acomodo_creadas`)).n,
             freno: await avisos('Frené el acomodo automático ⚠️', t0), pool: (await avisos('Hay una vuelta para tomar', t0)).length };
  });
  check('E. arma las 2 primeras y frena las otras 2 (se quedan como estaban: sin vuelta)', JSON.stringify(e.vs) === '[true,true,false,false]' && e.cuenta === 2, e.vs);
  check('E. reubicar_reserva frenada dice kind held y tight (para que su eventualidad quede abierta)', e.directo.kind === 'held' && e.directo.tight === true, e.directo);
  check('E. la nota habla del freno y no de «muy encima»', /freno/.test(e.nota) && !/muy encima/.test(e.nota), e.nota);
  check('E. a los jefes: UN «Frené el acomodo automático» cada uno, no uno por reserva', e.freno.length === jefes.length && e.freno.every((x) => jefes.includes(x.profile_id)), e.freno.length);
  check('E. «Hay una vuelta para tomar» solo por las 2 armadas', e.pool === 2 * esperados(at(hoy, '21:00')).length, { pool: e.pool, por: esperados(at(hoy, '21:00')).length });

  // ── F. El freno por tanda («sin carro» abiertas en el barrido) ──
  const sinCarro = async (k, base) => {
    const ids = [];
    for (let i = 0; i < k; i++) {
      const X = await trip(`Sin carro ${base}${i}`, i % 2 ? fx.llano : fx.olivar);
      const rid = await res(X, 'lle', at(hoy, `${19 + Math.floor(i / 2)}:${i % 2 ? '50' : '10'}`));
      await q(`INSERT INTO public.incidents (organization_id, reservation_id, category, status, description, scope, source, details)
        VALUES ($1, $2, 'late_booking', 'open', 'X no tiene carro (prueba)', 'operacion', 'system', '{}')`, [fx.org, rid]);
      ids.push(rid);
    }
    return ids;
  };
  const f1 = await enSavepoint(async () => {
    const ids = await sinCarro(5, 'a');
    const r = (await one(`SELECT public.acomodar_eventualidades() r`)).r;
    let con = 0; for (const id of ids) if (await vueltaDe(id)) con++;
    return { r, con, freno: (await avisos('Frené el acomodo automático ⚠️', t0)).length,
             abiertas: (await one(`SELECT count(*)::int n FROM public.incidents WHERE reservation_id = ANY($1) AND status = 'open'`, [ids])).n };
  });
  check('F. 5 «sin carro» a la vez (máximo 4): no acomoda a ninguno', f1.con === 0 && f1.r.sin_carro === 0 && f1.r.frenadas === 5, f1);
  check('F. … quedan abiertas para un jefe y llega UN aviso por jefe', f1.abiertas === 5 && f1.freno === jefes.length, f1);
  const f2 = await enSavepoint(async () => {
    const ids = await sinCarro(3, 'b');
    const r = (await one(`SELECT public.acomodar_eventualidades() r`)).r;
    let con = 0; for (const id of ids) if (await vueltaDe(id)) con++;
    return { r, con, freno: (await avisos('Frené el acomodo automático ⚠️', t0)).length };
  });
  check('F. 3 «sin carro» (máximo 4): las acomoda como siempre, sin aviso de freno', f2.con === 3 && f2.r.sin_carro === 3 && f2.freno === 0, f2);

  // ── G. Soltar una vuelta ──
  const g = await enSavepoint(async () => {
    const X = await trip('Suelta', fx.olivar);
    const rid = await res(X, 'sal', at(hoy, '19:30'));
    const ra = await vuelta(PM.dp, 'sal', at(hoy, '18:45'), rid, { pool: true, dia: hoy });
    await asUser(c, PM.u, 'driver');
    await q(`SELECT public.driver_release_route($1)`, [ra]);
    await asAdminDb(c);
    return { a: (await avisos('Hay una vuelta libre', t0)).map((x) => x.profile_id), jefe: (await avisos('Soltaron una vuelta', t0)).length,
             nadie: (await avisos('Nadie del turno para esta vuelta ⚠️', t0)).length };
  });
  const gEsp = esperados(at(hoy, '18:45')).filter((x) => x !== PM.u);
  check('G. «Hay una vuelta libre» solo a los demás del turno de la tarde', mismo(g.a, gEsp) && !g.a.includes(AM.u) && !g.a.includes(OFF.u), { a: g.a.length, want: gEsp.length });
  check('G. a los jefes les sigue llegando «Soltaron una vuelta» (y no el de «nadie del turno»)', g.jefe === jefes.length && g.nadie === 0, g);

  // ── H. La bandeja ──
  const h = await enSavepoint(async () => {
    await q(`UPDATE public.notification_outbox SET claimed_at = now() WHERE sent_at IS NULL`);   // lo que ya hubiera en la base local, fuera
    for (let i = 0; i < 3; i++) await q(`INSERT INTO public.notification_outbox (profile_id, title, body) VALUES ($1, 'Prueba bandeja', $2)`, [PM.u, `fila ${i}`]);
    await q(`UPDATE public.notification_outbox SET claimed_at = NULL WHERE title = 'Prueba bandeja'`);
    const a = (await q(`SELECT * FROM public.claim_notification_outbox(2)`)).length;
    const b = (await q(`SELECT * FROM public.claim_notification_outbox(5)`)).length;
    const c0 = (await q(`SELECT * FROM public.claim_notification_outbox(5)`)).length;
    await q(`UPDATE public.notification_outbox SET claimed_at = now() - interval '3 minutes' WHERE title = 'Prueba bandeja' AND body = 'fila 0'`);
    const viejo = (await q(`SELECT * FROM public.claim_notification_outbox(5)`)).length;
    await q(`UPDATE public.notification_outbox SET sent_at = now() WHERE title = 'Prueba bandeja'`);
    await q(`UPDATE public.notification_outbox SET claimed_at = now() - interval '3 minutes' WHERE title = 'Prueba bandeja'`);
    const enviadas = (await q(`SELECT * FROM public.claim_notification_outbox(5)`)).length;
    return { a, b, c0, viejo, enviadas };
  });
  check('H. aparta 2, luego la que queda, luego nada', h.a === 2 && h.b === 1 && h.c0 === 0, h);
  check('H. una apartada hace más de 2 min (la corrida murió) se vuelve a apartar; una enviada nunca', h.viejo === 1 && h.enviadas === 0, h);

  // ── I. Permisos y el down ──
  const perm = await one(`SELECT has_function_privilege('authenticated', 'public.claim_notification_outbox(integer)', 'EXECUTE') a,
    has_function_privilege('anon', 'public.claim_notification_outbox(integer)', 'EXECUTE') b,
    has_function_privilege('service_role', 'public.claim_notification_outbox(integer)', 'EXECUTE') s,
    has_function_privilege('authenticated', 'public.conductores_del_turno(uuid, timestamptz)', 'EXECUTE') d,
    has_function_privilege('authenticated', 'public.avisar_vuelta_para_tomar(uuid, timestamptz, text, text, text, uuid, boolean)', 'EXECUTE') e,
    has_function_privilege('authenticated', '${SIG.rr}', 'EXECUTE') f,
    has_function_privilege('authenticated', '${SIG.rel}', 'EXECUTE') g`);
  check('I. permisos: la bandeja solo para service_role; lo nuevo cerrado; soltar sigue abierto al conductor',
    !perm.a && !perm.b && perm.s && !perm.d && !perm.e && !perm.f && perm.g, perm);
  await c.query('SAVEPOINT down');
  await c.query(strip('../down_migrations/0144_avisos_por_turno_y_freno.down.sql'));
  const tras = await huellas();
  const quedan = await one(`SELECT to_regprocedure('public.claim_notification_outbox(integer)') IS NULL a, to_regprocedure('public.conductores_del_turno(uuid,timestamptz)') IS NULL b,
    to_regclass('public.acomodo_creadas') IS NULL c,
    NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'notification_outbox' AND column_name = 'claimed_at') d`);
  check('I. el down vuelve exactamente a las funciones de antes y quita lo nuevo',
    Object.keys(SIG).every((k) => tras[k] === antes[k]) && Object.values(quedan).every(Boolean), { tras, antes, quedan });
  await c.query('ROLLBACK TO SAVEPOINT down');
  console.log(`  huellas antes de 0144: ${JSON.stringify(antes)}`);
  console.log(`  huellas con 0144:      ${JSON.stringify(desp)}`);
} catch (e) {
  fail++; console.log('  ✗ error: ' + e.message + (e.where ? ' · ' + e.where.split('\n')[0] : ''));
} finally {
  await c.query('ROLLBACK');
}

// ── H2. Dos corridas A LA VEZ (filas confirmadas, se borran al final) ──
// Solo la parte de la bandeja de 0144 (columna + función), confirmada en la base
// local mientras dura la prueba; al final se quita.
const c2 = await localClient();
const MARCA = 'Prueba 0144 dos corridas ' + Date.now();
try {
  await c.query(`ALTER TABLE public.notification_outbox ADD COLUMN IF NOT EXISTS claimed_at timestamptz`);
  const fn = fs.readFileSync(new URL('../supabase/migrations/0144_avisos_por_turno_y_freno.sql', import.meta.url), 'utf8');
  const i = fn.indexOf('CREATE OR REPLACE FUNCTION public.claim_notification_outbox(');
  await c.query(fn.slice(i, fn.indexOf('\n$$;', i) + 4));
  // Lo pendiente que ya hubiera en la base local queda fuera (la columna se quita al final).
  await c.query(`UPDATE public.notification_outbox SET claimed_at = now() WHERE sent_at IS NULL`);
  const prof = (await one(`SELECT id FROM public.profiles LIMIT 1`)).id;
  for (let k = 0; k < 6; k++) await c.query(`INSERT INTO public.notification_outbox (profile_id, title, body, claimed_at) VALUES ($1, $2, $3, NULL)`, [prof, MARCA, `fila ${k}`]);
  // La corrida 1 aparta y NO confirma todavía; la 2 corre a la vez.
  await c.query('BEGIN');
  const r1 = (await c.query(`SELECT id FROM public.claim_notification_outbox(200) WHERE title = $1`, [MARCA])).rows.map((r) => r.id);
  const r2 = (await c2.query(`SELECT id FROM public.claim_notification_outbox(200) WHERE title = $1`, [MARCA])).rows.map((r) => r.id);
  await c.query('COMMIT');
  const r3 = (await c2.query(`SELECT id FROM public.claim_notification_outbox(200) WHERE title = $1`, [MARCA])).rows.map((r) => r.id);
  check('H2. dos corridas a la vez: la primera aparta las 6 y la segunda ninguna (ni durante ni después)',
    r1.length === 6 && r2.length === 0 && r3.length === 0, { r1: r1.length, r2: r2.length, r3: r3.length });
} catch (e) {
  fail++; console.log('  ✗ H2 error: ' + e.message);
} finally {
  await c.query(`DELETE FROM public.notification_outbox WHERE title = $1`, [MARCA]).catch(() => {});
  await c.query(`DROP FUNCTION IF EXISTS public.claim_notification_outbox(integer)`).catch(() => {});
  await c.query(`ALTER TABLE public.notification_outbox DROP COLUMN IF EXISTS claimed_at`).catch(() => {});
  await c.end(); await c2.end();
}
console.log(`\n${ok}/${ok + fail} ${fail ? '✗' : '✓'}`);
process.exit(fail ? 1 : 0);
