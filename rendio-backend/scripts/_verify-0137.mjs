// Verificación de 0137 (vueltas terminadas + recordatorio al conductor) contra la
// base LOCAL (127.0.0.1:54322). Pone la base al día hasta 0136 y aplica 0137 dentro
// de una transacción que se deshace: no queda nada.
//
//   cd rendio-backend/scripts && node _verify-0137.mjs
//
// Qué prueba:
//   1. route_expected_end: salida = presentación más tardía; llegada = entrega
//      estimada más tardía (o salida + 90); solo sin cuenta = última recogida + 40;
//      una cancelada no cuenta; sin paradas vivas = NULL.
//   2. route_unmarked_reminders: antes del fin + 10 min no avisa; después, UN aviso
//      al conductor con los que le faltan («Laura Gómez y Sara Ríos»), y no se repite.
//      No avisa: vuelta toda marcada, delegada, de hace más de 6 h, sin conductor.
//   3. Ajustes: 10 y 30 por defecto; fuera de rango se rechaza; el aviso usa el valor.
//   4. El reloj 'route-unmarked-reminders' queda agendado.
//   5. El down quita todo.
//
// NO cubre: las pantallas (_smoke-vueltas-terminadas-dom.mjs), la push de verdad.
import { localClient, fixtures, user, asUser } from './_local-fixtures.mjs';
import { cadenaHasta0136, migracion, reversa } from './_local-cadena-0136.mjs';

let ok = 0, fail = 0;
const check = (n, cond, det) => {
  if (cond) { ok++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + (typeof det === 'string' ? det : JSON.stringify(det)) : ''}`); }
};
const c = await localClient();
const q = async (s, p) => (await c.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
const asDb = async () => { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', '', true)`); };
async function debeFallar(sql, params) {
  await c.query('SAVEPOINT sp_f');
  try { await c.query(sql, params); await c.query('RELEASE SAVEPOINT sp_f'); return null; }
  catch (e) { await c.query('ROLLBACK TO SAVEPOINT sp_f'); return e; }
}

await c.query('BEGIN');
try {
  await cadenaHasta0136(c);
  await c.query(migracion('0137_vueltas_terminadas'));
  await c.query(migracion('0137_vueltas_terminadas'));
  check('0137 se aplica encima de 0136 (y se puede volver a correr)', true);

  const fx = await fixtures(c);
  const man = (await one(`SELECT ((now() AT TIME ZONE 'America/Bogota')::date + 1)::text d`)).d;
  const at = (hm) => `${man}T${hm}:00-05:00`;
  const trip = async (name) => { const u = await user(c, fx.org, 'auxiliar', name); return { u, a: (await one(`INSERT INTO public.auxiliar_profiles (profile_id, residence_id) VALUES ($1, $2) RETURNING id`, [u, fx.olivar])).id }; };
  const LAURA = { u: fx.auxUser, a: fx.aux }, SARA = await trip('Sara Ríos prueba'), HENRY = await trip('Henry Cano prueba');
  const res = async (X, dir, whenIso) => (await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, ${dir === 'sal' ? 'status_h2a' : 'status_a2h'}, required_arrival_at, pickup_address, pickup_latitude, pickup_longitude, residence_id)
      VALUES ($1, $2, $3, $4::timestamptz, 'El Olivar, Rionegro', 6.1523, -75.3781, $5) RETURNING id`,
    [X.a, dir === 'sal' ? 'home_to_airport' : 'airport_to_home', dir === 'sal' ? 'requested' : 'scheduled', whenIso, fx.olivar])).id;
  const vuelta = async (dir, start, stops, extra = {}) => {
    const ra = (await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at, delegated_at)
        VALUES ($1, $2, $3, 'planned', $4::timestamptz, $5) RETURNING id`,
      [extra.sinConductor || extra.delegada ? null : fx.driver, extra.delegada ? null : fx.vehicle, dir === 'sal' ? 'home_to_airport' : 'airport_to_home', start, extra.delegada ? new Date().toISOString() : null])).id;
    for (let i = 0; i < stops.length; i++) {
      const [x, hora] = stops[i];
      if (x && x.guest) await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, guest_name, stop_order, estimated_arrival_at) VALUES ($1, NULL, $2, $3, $4)`, [ra, x.guest, i + 1, hora]);
      else await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at) VALUES ($1, $2, $3, $4)`, [ra, x, i + 1, hora]);
    }
    return ra;
  };
  const fin = async (ra) => { const r = await one(`SELECT public.route_expected_end($1) f`, [ra]); return r.f ? r.f.toISOString() : null; };
  const iso = (s) => new Date(s).toISOString();
  const recordar = async (nowIso) => (await one(`SELECT public.route_unmarked_reminders($1::timestamptz) n`, [nowIso])).n;
  const avisosDe = async (ra) => q(`SELECT profile_id, title, body, url FROM public.notification_outbox WHERE dedupe_key = $1`, ['sinmarcar:' + ra]);
  const marcarParada = (ra, orden, st) => q(`UPDATE public.route_stops SET status = $3 WHERE route_assignment_id = $1 AND stop_order = $2`, [ra, orden, st]);

  // ── 1. El fin esperado ───────────────────────────────────────────────────────
  console.log('\n1. route_expected_end');
  const rL = await res(LAURA, 'sal', at('06:00')), rS = await res(SARA, 'sal', at('06:20'));
  const raS = await vuelta('sal', at('05:10'), [[rL, at('05:20')], [rS, at('05:30')]]);
  check('salida: la presentación más tardía (6:20)', (await fin(raS)) === iso(at('06:20')), await fin(raS));
  await q(`UPDATE public.reservations SET cancelled_at = now() WHERE id = $1`, [rS]);
  check('una cancelada no cuenta (queda 6:00)', (await fin(raS)) === iso(at('06:00')), await fin(raS));
  await q(`UPDATE public.reservations SET cancelled_at = NULL WHERE id = $1`, [rS]);
  const rH = await res(HENRY, 'lle', at('12:00'));
  const raL = await vuelta('lle', at('12:20'), [[rH, at('12:55')]]);
  check('llegada: la entrega estimada más tardía (12:55)', (await fin(raL)) === iso(at('12:55')), await fin(raL));
  const rH2 = await res(HENRY, 'lle', at('18:00'));
  const raL2 = await vuelta('lle', at('18:20'), [[rH2, null]]);
  check('llegada sin estimado: salida de JMC + 90 min (19:50)', (await fin(raL2)) === iso(at('19:50')), await fin(raL2));
  const raG = await vuelta('sal', at('09:00'), [[{ guest: 'Kriss Prueba' }, at('09:10')]]);
  check('salida solo con un sin cuenta: última recogida + 40 min (9:50)', (await fin(raG)) === iso(at('09:50')), await fin(raG));
  const raV = (await one(`INSERT INTO public.route_assignments (driver_profile_id, direction, status, planned_start_at) VALUES ($1, 'home_to_airport', 'planned', $2) RETURNING id`, [fx.driver, at('10:00')])).id;
  check('sin paradas: NULL', (await fin(raV)) === null);

  // ── 2. El recordatorio ──────────────────────────────────────────────────────
  console.log('\n2. route_unmarked_reminders');
  check('a las 6:25 (fin 6:20 + 5): todavía no', (await recordar(at('06:25'))) === 0 && (await avisosDe(raS)).length === 0);
  const n1 = await recordar(at('06:31'));
  const a1 = await avisosDe(raS);
  check('a las 6:31 (fin + 11): UN aviso', a1.length === 1, { n1, a1 });
  check('al conductor (su perfil), con la ruta', a1[0] && a1[0].profile_id === fx.drvUser && a1[0].url === '/#/ruta', a1[0]);
  check('título «✅ ¿Ya terminaste la vuelta de las 5:20?» (la primera recogida)', a1[0] && a1[0].title === '✅ ¿Ya terminaste la vuelta de las 5:20?', a1[0] && a1[0].title);
  check('cuerpo con los que faltan «Laura Gómez y Sara Ríos»', a1[0] && a1[0].body === 'Te falta marcar a Laura Gómez y Sara Ríos. Toca para marcarlo: así sale de la lista de los jefes.', a1[0] && a1[0].body);
  await recordar(at('06:40'));
  check('no se repite', (await avisosDe(raS)).length === 1);
  // Toda marcada: nada.
  const rL3 = await res(LAURA, 'sal', at('15:00'));
  const raOk = await vuelta('sal', at('14:10'), [[rL3, at('14:20')]]);
  await marcarParada(raOk, 1, 'delivered');
  await recordar(at('15:30'));
  check('vuelta toda marcada: no avisa', (await avisosDe(raOk)).length === 0);
  // Una marcada y otra no: solo nombra la que falta.
  const rL4 = await res(LAURA, 'sal', at('17:00')), rS4 = await res(SARA, 'sal', at('17:00'));
  const raMedia = await vuelta('sal', at('16:10'), [[rL4, at('16:20')], [rS4, at('16:30')]]);
  await marcarParada(raMedia, 1, 'delivered');
  await recordar(at('17:15'));
  const a4 = await avisosDe(raMedia);
  check('a medias: nombra solo a la que falta («Sara Ríos»)', a4.length === 1 && a4[0].body.startsWith('Te falta marcar a Sara Ríos.'), a4);
  // Llegada con no se presentó + sin cuenta pendiente.
  const rH5 = await res(HENRY, 'lle', at('20:00'));
  const raLle = await vuelta('lle', at('20:20'), [[rH5, at('20:50')], [{ guest: 'Kriss Prueba' }, at('21:00')]]);
  await marcarParada(raLle, 1, 'no_show');
  await recordar(at('21:11'));
  const a5 = await avisosDe(raLle);
  check('llegada: el no se presentó cuenta como marcado; falta Kriss (sin cuenta)', a5.length === 1 && a5[0].body.startsWith('Te falta marcar a Kriss Prueba.') && a5[0].title === '✅ ¿Ya terminaste la vuelta de las 20:20?', a5);
  // Delegada y sin conductor: nada.
  const rL6 = await res(LAURA, 'sal', at('22:00'));
  const raDel = await vuelta('sal', at('21:10'), [[rL6, at('21:20')]], { delegada: true });
  const rS7 = await res(SARA, 'sal', at('22:00'));
  const raSin = await vuelta('sal', at('21:10'), [[rS7, at('21:20')]], { sinConductor: true });
  await recordar(at('22:30'));
  check('delegada: no avisa', (await avisosDe(raDel)).length === 0);
  check('sin conductor: no avisa', (await avisosDe(raSin)).length === 0);
  // Más de 6 h después del fin: nada (si el reloj estuvo caído no despierta a nadie con lo viejo).
  const rH8 = await res(HENRY, 'lle', at('01:00'));
  const raVieja = await vuelta('lle', at('01:20'), [[rH8, at('01:50')]]);
  await recordar(at('08:30'));
  check('de hace más de 6 h: no avisa', (await avisosDe(raVieja)).length === 0);

  // ── 3. Ajustes ──────────────────────────────────────────────────────────────
  console.log('\n3. Ajustes');
  const s = await one(`SELECT route_done_hide_min h, route_unmarked_min u FROM public.app_settings WHERE id = 'singleton'`);
  check('route_done_hide_min = 10 y route_unmarked_min = 30 por defecto', s && s.h === 10 && s.u === 30, s);
  check('route_done_hide_min fuera de rango (300) se rechaza', !!(await debeFallar(`UPDATE public.app_settings SET route_done_hide_min = 300 WHERE id = 'singleton'`)));
  check('route_unmarked_min fuera de rango (1) se rechaza', !!(await debeFallar(`UPDATE public.app_settings SET route_unmarked_min = 1 WHERE id = 'singleton'`)));
  await q(`UPDATE public.app_settings SET route_done_hide_min = 30 WHERE id = 'singleton'`);
  const rL9 = await res(LAURA, 'sal', at('11:00'));
  const raCfg = await vuelta('sal', at('10:10'), [[rL9, at('10:20')]]);
  await recordar(at('11:20'));
  check('con 30 min en Ajustes, a las 11:20 (fin + 20) todavía no avisa', (await avisosDe(raCfg)).length === 0);
  await recordar(at('11:31'));
  check('… y a las 11:31 sí', (await avisosDe(raCfg)).length === 1);
  await q(`UPDATE public.app_settings SET route_done_hide_min = 10 WHERE id = 'singleton'`);
  // El jefe lee los ajustes (el conductor también: la app los usa).
  const fxJefe = await user(c, fx.org, 'admin', 'Jefe prueba 0137');
  await asUser(c, fxJefe, 'admin');
  const sj = await one(`SELECT route_done_hide_min h, route_unmarked_min u FROM public.app_settings WHERE id = 'singleton'`);
  await asDb();
  check('el jefe los lee por la API (RLS de app_settings)', sj && sj.h === 10 && sj.u === 30, sj);
  await asUser(c, fx.drvUser, 'driver');
  const fd = await one(`SELECT public.route_expected_end($1) f`, [raS]);
  await asDb();
  check('route_expected_end se puede llamar con sesión', !!(fd && fd.f));

  // ── 4. Reloj ────────────────────────────────────────────────────────────────
  console.log('\n4. Reloj');
  const j = await one(`SELECT schedule FROM cron.job WHERE jobname = 'route-unmarked-reminders'`).catch(() => null);
  check('route-unmarked-reminders cada 5 min', j && j.schedule === '*/5 * * * *', j);

  // ── 5. Down ─────────────────────────────────────────────────────────────────
  console.log('\n5. Down');
  await c.query(reversa('0137_vueltas_terminadas'));
  const quedan = await one(`SELECT to_regprocedure('public.route_unmarked_reminders(timestamptz)') a, to_regprocedure('public.route_expected_end(uuid)') b,
      (SELECT count(*) FROM information_schema.columns WHERE table_name = 'app_settings' AND column_name IN ('route_done_hide_min', 'route_unmarked_min'))::int n,
      (SELECT count(*) FROM cron.job WHERE jobname = 'route-unmarked-reminders')::int jobs`);
  check('el down quita funciones, columnas y reloj', !quedan.a && !quedan.b && quedan.n === 0 && quedan.jobs === 0, quedan);
} catch (e) {
  fail++; console.log('  ✗ ERROR', e.message, e.where || '');
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok} ✓ · ${fail} ✗`);
process.exit(fail ? 1 : 0);
