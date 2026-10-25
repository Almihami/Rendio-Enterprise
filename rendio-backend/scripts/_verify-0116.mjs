// 0116 · Tiempos aprendidos de los viajes reales, contra la base LOCAL (supabase start).
//
//   cd rendio-backend/scripts && node _verify-0116.mjs
//
// Todo dentro de una transacción que se deshace: aplica 0116, arma sus propias
// vueltas (_local-fixtures) con marcas y GPS, y comprueba
//   · una salida bien marcada da sus 9 tramos con los minutos exactos y «ok»;
//   · dos del mismo conjunto no cuentan como viaje (es caminar);
//   · una salida marcada toda junto en el aeropuerto queda «dudosa», con motivo;
//   · una llegada: aeropuerto → casa, casa → casa y la vuelta completa;
//   · después de un «no se presentó» el tramo siguiente no se mide;
//   · sin GPS se mide igual pero queda «sin comprobar»;
//   · domingo y festivo quedan como «festivo»;
//   · medir dos veces da lo mismo; un «deshacer» del conductor se refleja;
//   · una vuelta ya medida de hace más de 6 días no se rehace;
//   · lo que ve el jefe: margen, plan vs. real, tramo final contra Julián, conductores;
//   · permisos: solo el jefe de esa organización ve y mide; la medición interna no la llama nadie;
//   · el reloj de pg_cron quedó.
import { readFileSync } from 'node:fs';
import { localClient, fixtures, user, asUser, asAdminDb } from './_local-fixtures.mjs';

const c = await localClient();
const q = async (s, p) => (await c.query(s, p)).rows;
const one = async (s, p) => (await c.query(s, p)).rows[0];
let ok = 0, fail = 0;
const check = (n, cond, det) => { if (cond) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + JSON.stringify(det) : ''}`); } };
const SQL = readFileSync(new URL('../supabase/migrations/0116_tiempos_aprendidos.sql', import.meta.url), 'utf8')
  .replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');

// Corre `fn` como `quien`/`rol`; devuelve [resultado, mensaje de error].
const como = async (quien, rol, sql, params) => {
  await c.query('SAVEPOINT s');
  try {
    await asUser(c, quien, rol);
    const r = await q(sql, params);
    await asAdminDb(c);
    await c.query('RELEASE SAVEPOINT s');
    return [r, null];
  } catch (e) { await c.query('ROLLBACK TO SAVEPOINT s'); await asAdminDb(c); return [null, e.message]; }
};

await c.query('BEGIN');
try {
  await c.query(SQL);
  const fx = await fixtures(c);
  const APT = { lat: 6.1645, lng: -75.4231 };
  const OLIVAR = { id: fx.olivar, lat: 6.1523, lng: -75.3781 };
  const LLANO = { id: fx.llano, lat: 6.1175, lng: -75.4152 };
  const MARI = { id: (await one(`INSERT INTO public.residences (organization_id, name, latitude, longitude, sector)
    VALUES ($1, 'Marinilla Centro', 6.1739, -75.3360, 'Marinilla') RETURNING id`, [fx.org])).id, lat: 6.1739, lng: -75.3360 };
  const admin = await user(c, fx.org, 'admin', 'Jefa Prueba');

  // Un tripulante nuevo por reserva: así ninguna regla de «una reserva por día» estorba.
  let nAux = 0;
  const reserva = async (dir, punto, dl) => {
    const u = await user(c, fx.org, 'auxiliar', 'Tripulante 0116 #' + (++nAux));
    const aux = (await one(`INSERT INTO public.auxiliar_profiles (profile_id, residence_id) VALUES ($1, $2) RETURNING id`, [u, punto.id])).id;
    return (await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_h2a, status_a2h, required_arrival_at,
        residence_id, pickup_address, pickup_latitude, pickup_longitude)
      VALUES ($1, $2::public.trip_direction,
        CASE WHEN $2 = 'home_to_airport' THEN 'requested'::public.reservation_status_h2a END,
        CASE WHEN $2 = 'airport_to_home' THEN 'scheduled'::public.reservation_status_a2h END,
        $3, $4, 'Prueba 0116', $5, $6) RETURNING id`, [aux, dir, dl, punto.id, punto.lat, punto.lng])).id;
  };
  const vuelta = async (dir, inicio) => (await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at)
    VALUES ($1, $2, $3::public.trip_direction, 'planned', $4) RETURNING id`, [fx.driver, fx.vehicle, dir, inicio])).id;
  const parada = async (ra, rid, orden, m) => q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order,
      estimated_arrival_at, actual_arrival_at, actual_pickup_at, actual_dropoff_at, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [ra, rid, orden, m.eta || null, m.arr || null, m.pick || null, m.drp || null, m.st || 'pending']);
  // Ping GPS a ~30 m del punto.
  const gps = async (ra, punto, at) => q(`INSERT INTO public.driver_locations (driver_profile_id, route_assignment_id, latitude, longitude, source, recorded_at)
    VALUES ($1, $2, $3, $4, 'gps', $5)`, [fx.driver, ra, punto.lat + 0.0002, punto.lng + 0.0002, at]);
  const tramos = async (ra) => q(`SELECT kind, minutes::float AS min, quality, quality_reason AS why, pax, ref_hour, day_type,
      start_gps_m, end_gps_m, from_residence_id, to_residence_id
    FROM public.route_trip_legs WHERE route_assignment_id = $1 ORDER BY started_at, kind`, [ra]);
  const de = (ts, k) => ts.filter(t => t.kind === k);
  const medir = async (desde) => (await one(`SELECT public.collect_trip_legs($1::timestamptz) AS r`, [desde || '2000-01-01'])).r;
  // Las fechas van a horas relativas a un martes normal (20-oct-2026), hora de Bogotá.
  const t = (hhmm, dia = '2026-10-20') => `${dia} ${hhmm}:00-05`;

  // ── A. Salida bien marcada: Marinilla → El Olivar (dos del mismo conjunto) → aeropuerto
  console.log('\nA. Salida bien marcada');
  const A = await vuelta('home_to_airport', t('02:50'));
  const a1 = await reserva('home_to_airport', MARI, t('04:30'));
  const a2 = await reserva('home_to_airport', OLIVAR, t('04:30'));
  const a3 = await reserva('home_to_airport', OLIVAR, t('04:40'));
  await parada(A, a1, 1, { eta: t('03:02'), arr: t('03:00'), pick: t('03:04'), drp: t('03:50'), st: 'delivered' });
  await parada(A, a2, 2, { eta: t('03:20'), arr: t('03:25'), pick: t('03:27'), drp: t('03:50'), st: 'delivered' });
  await parada(A, a3, 3, { eta: t('03:20'), arr: t('03:27'), pick: t('03:28'), drp: t('03:50'), st: 'delivered' });
  for (const [p, h] of [[MARI, '03:00'], [MARI, '03:04'], [OLIVAR, '03:25'], [OLIVAR, '03:27'], [OLIVAR, '03:28'], [APT, '03:50']]) await gps(A, p, t(h));
  const rA = await medir();
  const tA = await tramos(A);
  check('9 tramos (3 esperas · 3 puertas · 1 entre casas · tramo final · vuelta)', tA.length === 9, tA.map(x => x.kind));
  check('todos «ok» (marcados en el momento, con GPS)', tA.every(x => x.quality === 'ok'), tA.filter(x => x.quality !== 'ok'));
  check('esperas 4 · 2 · 1 min', JSON.stringify(de(tA, 'espera').map(x => x.min)) === '[4,2,1]', de(tA, 'espera').map(x => x.min));
  check('plan vs. real en la puerta: −2 · +5 · +7', JSON.stringify(de(tA, 'puerta').map(x => x.min)) === '[-2,5,7]', de(tA, 'puerta').map(x => x.min));
  const cc = de(tA, 'casa_casa');
  check('Marinilla → El Olivar 21 min; entre las dos de El Olivar no hay viaje', cc.length === 1 && cc[0].min === 21
    && cc[0].from_residence_id === MARI.id && cc[0].to_residence_id === OLIVAR.id, cc);
  const tf = de(tA, 'casa_aeropuerto')[0];
  check('tramo final: última recogida 03:28 → aeropuerto 03:50 = 22 min, 3 personas', tf && tf.min === 22 && tf.pax === 3, tf);
  const vs = de(tA, 'vuelta_salida')[0];
  check('vuelta completa: primera recogida 03:04 → aeropuerto = 46 min', vs && vs.min === 46, vs);
  check('franja = la de la presentación más temprana (04:30 → hora 4), día normal', tA.every(x => x.ref_hour === 4 && x.day_type === 'normal'), tA.map(x => [x.ref_hour, x.day_type]));
  check('GPS comprobado en ambos extremos del tramo final (< 100 m)', tf && tf.start_gps_m != null && tf.start_gps_m < 100 && tf.end_gps_m < 100, tf);
  check('la medición dice cuántas vueltas y tramos', rA && rA.vueltas >= 1 && rA.tramos >= 9, rA);

  // ── B. Salida marcada TODA junto en el aeropuerto
  console.log('\nB. Marcas a destiempo');
  const B = await vuelta('home_to_airport', t('05:00'));
  const b1 = await reserva('home_to_airport', LLANO, t('06:30'));
  const b2 = await reserva('home_to_airport', MARI, t('06:30'));
  await parada(B, b1, 1, { arr: t('05:40'), pick: '2026-10-20 05:40:20-05', drp: t('05:42'), st: 'delivered' });
  await parada(B, b2, 2, { arr: '2026-10-20 05:40:40-05', pick: t('05:41'), drp: t('05:42'), st: 'delivered' });
  for (const h of ['05:40', '05:41', '05:42']) await gps(B, APT, t(h));
  await medir();
  const tB = await tramos(B);
  const viajesB = tB.filter(x => ['casa_casa', 'casa_aeropuerto', 'vuelta_salida'].includes(x.kind));
  check('los viajes quedan «dudosos»', viajesB.length >= 2 && viajesB.every(x => x.quality === 'dudosa'), viajesB);
  check('el motivo dice que marcó lejos del punto', viajesB.some(x => /marcó a .* del punto/.test(x.why || '')), viajesB.map(x => x.why));
  const ccB = de(tB, 'casa_casa')[0];
  check('Llanogrande → Marinilla en 20 segundos: «imposible manejando»', ccB && /imposible manejando/.test(ccB.why || ''), ccB);

  // ── C. Llegada: aeropuerto → Llanogrande → El Olivar
  console.log('\nC. Llegada');
  const C = await vuelta('airport_to_home', t('09:50'));
  const c1 = await reserva('airport_to_home', LLANO, t('09:40'));
  const c2 = await reserva('airport_to_home', OLIVAR, t('09:40'));
  await parada(C, c1, 1, { arr: t('09:55'), pick: t('10:00'), drp: t('10:25'), st: 'delivered' });
  await parada(C, c2, 2, { arr: t('09:55'), pick: t('10:02'), drp: t('10:45'), st: 'delivered' });
  for (const [p, h] of [[APT, '10:00'], [APT, '10:02'], [LLANO, '10:25'], [OLIVAR, '10:45']]) await gps(C, p, t(h));
  await medir();
  const tC = await tramos(C);
  const ac = de(tC, 'aeropuerto_casa')[0], vl = de(tC, 'vuelta_llegada')[0], ccC = de(tC, 'casa_casa')[0];
  check('sale del aeropuerto cuando sube el último (10:02) → Llanogrande 10:25 = 23 min', ac && ac.min === 23, ac);
  check('Llanogrande → El Olivar 20 min', ccC && ccC.min === 20, ccC);
  check('vuelta de llegada 43 min, 2 personas, franja de la salida (hora 10)', vl && vl.min === 43 && vl.pax === 2 && vl.ref_hour === 10, vl);
  check('llegada sin «espera» ni «puerta» (no aplican)', !de(tC, 'espera').length && !de(tC, 'puerta').length, tC.map(x => x.kind));
  check('todo «ok»', tC.every(x => x.quality === 'ok'), tC.filter(x => x.quality !== 'ok'));

  // ── D. «No se presentó» en la mitad + sin GPS
  console.log('\nD. «No se presentó» y sin GPS');
  const D = await vuelta('home_to_airport', t('12:00'));
  const d1 = await reserva('home_to_airport', MARI, t('14:00'));
  const d2 = await reserva('home_to_airport', LLANO, t('14:00'));
  const d3 = await reserva('home_to_airport', OLIVAR, t('14:00'));
  await parada(D, d1, 1, { arr: t('12:58'), pick: t('13:00'), drp: t('13:55'), st: 'delivered' });
  await parada(D, d2, 2, { arr: t('13:15'), st: 'no_show' });
  await parada(D, d3, 3, { arr: t('13:30'), pick: t('13:31'), drp: t('13:55'), st: 'delivered' });
  await medir();
  const tD = await tramos(D);
  const ccD = de(tD, 'casa_casa');
  check('se mide el tramo HASTA el que no salió (13:00 → 13:15)', ccD.length === 1 && ccD[0].min === 15, ccD);
  check('el tramo DESPUÉS del «no se presentó» no se mide', !ccD.some(x => x.from_residence_id === LLANO.id), ccD);
  check('tramo final desde la última recogida (13:31 → 13:55 = 24)', de(tD, 'casa_aeropuerto')[0]?.min === 24, de(tD, 'casa_aeropuerto'));
  check('vuelta de 2 personas (el que no salió no cuenta)', de(tD, 'vuelta_salida')[0]?.pax === 2, de(tD, 'vuelta_salida'));
  check('sin GPS: se mide, queda «ok» y sin comprobar', tD.every(x => x.quality === 'ok' && x.start_gps_m == null && x.end_gps_m == null), tD);

  // ── E. Domingo y festivo
  console.log('\nE. Domingo y festivo');
  const E1 = await vuelta('home_to_airport', t('03:00', '2026-10-25'));
  const e1 = await reserva('home_to_airport', OLIVAR, t('04:30', '2026-10-25'));
  await parada(E1, e1, 1, { arr: t('03:40', '2026-10-25'), pick: t('03:42', '2026-10-25'), drp: t('04:00', '2026-10-25'), st: 'delivered' });
  const E2 = await vuelta('home_to_airport', t('03:00', '2026-11-02'));
  const e2 = await reserva('home_to_airport', OLIVAR, t('04:30', '2026-11-02'));
  await parada(E2, e2, 1, { arr: t('03:40', '2026-11-02'), pick: t('03:42', '2026-11-02'), drp: t('04:00', '2026-11-02'), st: 'delivered' });
  await medir();
  check('domingo 25-oct → festivo', (await tramos(E1)).every(x => x.day_type === 'festivo'));
  check('lunes 2-nov (Todos los Santos) → festivo', (await tramos(E2)).every(x => x.day_type === 'festivo'));

  // ── F. Medir dos veces · deshacer
  console.log('\nF. Repetir y deshacer');
  const total1 = (await one(`SELECT count(*)::int n FROM public.route_trip_legs`)).n;
  await medir();
  check('medir dos veces da lo mismo', (await one(`SELECT count(*)::int n FROM public.route_trip_legs`)).n === total1);
  await q(`UPDATE public.route_stops SET actual_pickup_at = NULL, status = 'arrived' WHERE route_assignment_id = $1 AND reservation_id = $2`, [A, a1]);
  await medir();
  const tA2 = await tramos(A);
  check('«deshacer» la recogida de Marinilla: su espera y su tramo desaparecen', !tA2.some(x => x.kind === 'espera' && x.from_residence_id === MARI.id)
    && !de(tA2, 'casa_casa').length, tA2.map(x => x.kind));
  check('la vuelta ahora arranca en El Olivar (03:27 → 03:50 = 23) con 2 personas', de(tA2, 'vuelta_salida')[0]?.min === 23 && de(tA2, 'vuelta_salida')[0]?.pax === 2, de(tA2, 'vuelta_salida'));
  await q(`UPDATE public.route_stops SET actual_pickup_at = $3, status = 'delivered' WHERE route_assignment_id = $1 AND reservation_id = $2`, [A, a1, t('03:04')]);
  await medir();

  // ── G. Una vuelta medida de hace 10 días no se rehace
  console.log('\nG. Vueltas viejas');
  const G = await vuelta('home_to_airport', new Date(Date.now() - 10 * 864e5).toISOString());
  const g1 = await reserva('home_to_airport', LLANO, new Date(Date.now() - 10 * 864e5 + 3600e3).toISOString());
  const hace10 = (min) => new Date(Date.now() - 10 * 864e5 + min * 60e3).toISOString();
  await parada(G, g1, 1, { arr: hace10(0), pick: hace10(2), drp: hace10(20), st: 'delivered' });
  await medir('2000-01-01');
  const antes = (await tramos(G)).length;
  check('la primera vez sí se mide (no tenía tramos)', antes > 0, antes);
  await q(`UPDATE public.route_stops SET actual_dropoff_at = $2 WHERE route_assignment_id = $1`, [G, hace10(80)]);
  await medir('2000-01-01');
  check('ya medida y de hace más de 6 días: no se vuelve a medir', (await tramos(G)).find(x => x.kind === 'casa_aeropuerto')?.min === 18, (await tramos(G)).map(x => [x.kind, x.min]));

  // ── H. Lo que ve el jefe
  console.log('\nH. Pantalla del jefe');
  const [rows, err] = await como(admin, 'admin', `SELECT public.admin_learned_times(3650, 1) AS r`);
  const L = rows && rows[0].r;
  check('el jefe la lee sin error', !err && L, err);
  if (L) {
    const m2 = (L.margen || []).find(x => x.band === 2);
    check('margen en el aeropuerto franja 2–6: vuelta A llegó 40 min antes (04:30 − 03:50)', m2 && m2.n >= 1 && m2.peor <= 40, L.margen);
    const p2 = (L.puerta || []).find(x => x.band === 2);
    check('plan vs. real franja 2–6: 3 puertas, mediana +5, 1 tarde (+7)', p2 && p2.n === 3 && Number(p2.mediana) === 5 && p2.tarde === 1, p2);
    const tod = (L.tramo_final || []).find(x => x.band === 2 && x.zona === 'Todas' && x.day_type === 'normal');
    const jul = await one(`SELECT min_minutes, max_minutes FROM public.route_leg_times WHERE band_from = 2`);
    check('tramo final franja 2–6 «Todas» con el número de Julián al lado', tod && tod.n >= 1 && (jul ? tod.julian_min === jul.min_minutes : true), tod);
    check('los dudosos NO entran en las cuentas (la vuelta B no aparece en el margen de la franja 6–9)', !(L.margen || []).some(x => x.band === 6), L.margen);
    const yo = (L.conductores || []).find(x => x.nombre === 'Carlos Mejía');
    check('conductores: Carlos con sus tramos dudosos contados', yo && yo.dudosos >= 2 && yo.total > yo.dudosos, yo);
    check('lista de dudosos con su motivo', (L.dudosos || []).length >= 2 && L.dudosos.every(x => x.motivo), (L.dudosos || []).slice(0, 2));
    check('resumen: vueltas, tramos, dudosos y última medición', L.resumen && L.resumen.vueltas >= 6 && L.resumen.dudosos >= 2 && L.ultima_medicion, L.resumen);
    check('las franjas son las de Julián', Array.isArray(L.franjas) && L.franjas.length >= 5, L.franjas);
    check('conjuntos: El Olivar → aeropuerto aparece', (L.conjuntos || []).some(x => x.conjunto === 'El Olivar'), L.conjuntos);
    check('llegadas: aeropuerto → primera casa', (L.llegadas || []).some(x => x.n >= 1 && Number(x.mediana) === 23), L.llegadas);
  }

  // ── I. Permisos
  console.log('\nI. Permisos');
  const [, eDrv] = await como(fx.drvUser, 'driver', `SELECT public.admin_learned_times()`);
  check('un conductor no puede ver la pantalla', /Solo un jefe/.test(eDrv || ''), eDrv);
  const [, eAux] = await como(fx.auxUser, 'auxiliar', `SELECT public.admin_learned_times()`);
  check('un tripulante tampoco', /Solo un jefe/.test(eAux || ''), eAux);
  const [legsDrv] = await como(fx.drvUser, 'driver', `SELECT count(*)::int n FROM public.route_trip_legs`);
  check('un conductor no lee la tabla (0 filas)', legsDrv && legsDrv[0].n === 0, legsDrv);
  const [legsAdm] = await como(admin, 'admin', `SELECT count(*)::int n FROM public.route_trip_legs`);
  check('el jefe sí la lee', legsAdm && legsAdm[0].n > 0, legsAdm);
  const otraOrg = (await one(`INSERT INTO public.organizations (name, slug) VALUES ('Otra 0116', 'otra-0116-' || substr(md5(random()::text), 1, 6)) RETURNING id`)).id;
  const otroJefe = await user(c, otraOrg, 'admin', 'Jefe de otra empresa');
  const [legsOtro] = await como(otroJefe, 'admin', `SELECT count(*)::int n FROM public.route_trip_legs`);
  check('el jefe de OTRA organización no ve nada', legsOtro && legsOtro[0].n === 0, legsOtro);
  const [lo] = await como(otroJefe, 'admin', `SELECT public.admin_learned_times(3650, 1) AS r`);
  check('…ni en la pantalla (0 vueltas)', lo && lo[0].r.resumen.vueltas === 0, lo && lo[0].r.resumen);
  const [, eCol] = await como(admin, 'admin', `SELECT public.collect_trip_legs()`);
  check('la medición interna no la llama nadie desde la app (ni el jefe)', /permission denied|permiso/i.test(eCol || ''), eCol);
  const [med] = await como(admin, 'admin', `SELECT public.admin_collect_trip_legs() AS r`);
  check('«Medir ahora» del jefe funciona', med && med[0].r && med[0].r.vueltas >= 1, med);
  const [medOtro] = await como(otroJefe, 'admin', `SELECT public.admin_collect_trip_legs() AS r`);
  check('«Medir ahora» del jefe de otra organización no cuenta viajes ajenos', medOtro && medOtro[0].r.vueltas === 0 && medOtro[0].r.tramos === 0, medOtro && medOtro[0].r);
  const [, eMed] = await como(fx.drvUser, 'driver', `SELECT public.admin_collect_trip_legs()`);
  check('«Medir ahora» no lo puede usar un conductor', /Solo un jefe/.test(eMed || ''), eMed);

  // ── K. Pernocta (hotel): no se mide lo que toca esa puerta
  console.log('\nK. Pernocta');
  const K = await vuelta('airport_to_home', t('16:00'));
  const k1 = await reserva('airport_to_home', LLANO, t('15:40'));
  const k2 = await reserva('airport_to_home', OLIVAR, t('15:40'));
  await q(`UPDATE public.reservations SET is_overnight = true WHERE id = $1`, [k1]);
  await parada(K, k1, 1, { pick: t('16:00'), drp: t('16:20'), st: 'delivered' });
  await parada(K, k2, 2, { pick: t('16:01'), drp: t('16:40'), st: 'delivered' });
  await gps(K, APT, t('16:01'));
  await q(`INSERT INTO public.driver_locations (driver_profile_id, route_assignment_id, latitude, longitude, source, recorded_at)
    VALUES ($1, $2, 6.1567, -75.4356, 'gps', $3)`, [fx.driver, K, t('16:20')]);   // en el hotel, no en Llanogrande
  await medir();
  const tK = await tramos(K);
  check('ni aeropuerto → hotel, ni hotel → casa, ni la vuelta: nada que toque la pernocta', tK.length === 0, tK.map(x => [x.kind, x.why]));
  check('y el conductor no queda con «dudosos» por eso', !tK.some(x => x.quality === 'dudosa'));

  // ── J. Zonas y reloj
  console.log('\nJ. Zonas y reloj');
  const caja = JSON.stringify([[0.4, -80.6], [0.4, -80.4], [0.6, -80.4], [0.6, -80.6]]);
  check('punto dentro del dibujo', (await one(`SELECT public.zona_contiene_punto($1::jsonb, 0.5, -80.5) AS r`, [caja])).r === true);
  check('punto fuera del dibujo', (await one(`SELECT public.zona_contiene_punto($1::jsonb, 0.7, -80.5) AS r`, [caja])).r === false);
  await q(`INSERT INTO public.route_zones (name, polygon, sort_order) VALUES ('Prueba 0116', $1::jsonb, 99)`, [caja]);
  check('zona efectiva: la del dibujo', (await one(`SELECT public.zona_efectiva(NULL, 0.5, -80.5) AS r`)).r === 'Prueba 0116');
  check('zona efectiva: la puesta a mano gana', (await one(`SELECT public.zona_efectiva('Marinilla', 0.5, -80.5) AS r`)).r === 'Marinilla');
  await q(`INSERT INTO public.route_zones (name, polygon, sort_order) VALUES ('Prueba 0116 b', $1::jsonb, 99)`, [caja]);
  check('zona efectiva: dos dibujos encimados → ninguna (que decida una persona)', (await one(`SELECT public.zona_efectiva(NULL, 0.5, -80.5) AS r`)).r === null);
  const job = await one(`SELECT schedule, command FROM cron.job WHERE jobname = 'collect-trip-legs'`).catch(() => null);
  check('pg_cron: «collect-trip-legs» cada hora al minuto 7', job && job.schedule === '7 * * * *' && /collect_trip_legs/.test(job.command), job);
} catch (e) { fail++; console.error('ERROR', e); }
finally { await c.query('ROLLBACK'); await c.end(); }
console.log(`\n${ok} bien · ${fail} mal`);
process.exit(fail ? 1 : 0);
