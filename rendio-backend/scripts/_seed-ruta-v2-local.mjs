#!/usr/bin/env node
// _seed-ruta-v2-local.mjs — Publica DOS vueltas de HOY para carlos.local en la base
// LOCAL, para ver y probar la ruta del conductor v2 sin pasar por Asignación:
//   V1 · salida  (casa → MDE)  con las salidas de hoy de la semilla (_seed-e2e-local.mjs)
//   V2 · llegada (MDE → casa)  con las llegadas de hoy
// Deja las paradas en «pendiente», las reservas en su estado inicial y les pone
// maletas, punto de encuentro y una nota a algunos tripulantes para que la pantalla
// tenga qué pintar. Idempotente: borra antes las vueltas de hoy de carlos.
//
//   node _seed-ruta-v2-local.mjs              → publica (horas reales de la semilla)
//   node _seed-ruta-v2-local.mjs --ahora      → mueve las horas para que V1 arranque ya
//   node _seed-ruta-v2-local.mjs --propias    → crea SUS PROPIAS reservas (tripu1…5) a
//        horas contadas desde ahora: sirve a cualquier hora (de noche la semilla ya no
//        tiene salidas «de hoy»). Las anota en .seed-ruta-v2.json y las borra al repetir.
//
// NUNCA toca dev ni producción: _local-fixtures.mjs solo conecta a 127.0.0.1:54322.
import { localClient } from './_local-fixtures.mjs';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const AHORA = process.argv.includes('--ahora');
const PROPIAS = process.argv.includes('--propias');
const NOTA = new URL('./.seed-ruta-v2.json', import.meta.url).pathname;
const pg = await localClient();
const q = (sql, p) => pg.query(sql, p).then((r) => r.rows);
const hoy = (await q(`select to_char(now() at time zone 'America/Bogota','YYYY-MM-DD') d`))[0].d;

const [drv] = await q(`select dp.id from driver_profiles dp join profiles p on p.id = dp.profile_id
                        join auth.users u on u.id = p.id where u.email = 'carlos.local@rendio.test'`);
if (!drv) { console.error('falta carlos.local (correr _seed-e2e-local.mjs)'); process.exit(1); }
const [veh] = await q(`select id from vehicles where internal_code = 'V-01'`);

// Reservas propias: las de la corrida anterior fuera, y 3 salidas + 2 llegadas nuevas.
if (PROPIAS) {
  const prev = existsSync(NOTA) ? JSON.parse(readFileSync(NOTA, 'utf8')) : [];
  if (prev.length) {
    await q(`delete from route_assignments where id in (select route_assignment_id from route_stops where reservation_id = any($1::uuid[]))`, [prev]);
    await q(`delete from route_stops where reservation_id = any($1::uuid[])`, [prev]);
    await q(`delete from notification_outbox where dedupe_key like any($1)`, [prev.map((id) => `trip:${id}:%`)]);
    await q(`delete from reservations where id = any($1::uuid[])`, [prev]);
  }
  const auxes = await q(`select ap.id, coalesce(rr.name, 'Casa') res, rr.latitude lat, rr.longitude lng from auth.users u join profiles p on p.id = u.id
                          join auxiliar_profiles ap on ap.profile_id = p.id left join residences rr on rr.id = ap.residence_id
                         where u.email in ('tripu1.local@rendio.test','tripu2.local@rendio.test','tripu3.local@rendio.test','tripu4.local@rendio.test','tripu5.local@rendio.test')
                         order by u.email`);
  const ids = [];
  for (const [i, a] of auxes.entries()) {
    const lle = i >= 3;
    const r = (await q(`insert into reservations (auxiliar_profile_id, direction, status_h2a, status_a2h, required_arrival_at, pickup_address, pickup_latitude, pickup_longitude)
      values ($1, $2::trip_direction, case when $2 = 'home_to_airport' then 'requested'::reservation_status_h2a end, case when $2 = 'airport_to_home' then 'scheduled'::reservation_status_a2h end,
              now() + ($3 || ' minutes')::interval, $4, $5, $6) returning id`,
      [a.id, lle ? 'airport_to_home' : 'home_to_airport', lle ? 20 : 85, a.res, a.lat ?? 6.1523, a.lng ?? -75.3781]))[0];
    ids.push(r.id);
  }
  writeFileSync(NOTA, JSON.stringify(ids));
}

const sal = PROPIAS ? await q(`select id from reservations where id = any($1::uuid[]) and direction = 'home_to_airport' order by id`, [JSON.parse(readFileSync(NOTA, 'utf8'))]) : await q(`select r.id from reservations r where r.cancelled_at is null and r.direction = 'home_to_airport'
                     and (r.required_arrival_at at time zone 'America/Bogota')::date = $1::date
                     order by r.required_arrival_at, r.id limit 3`, [hoy]);
const lle = PROPIAS ? await q(`select id from reservations where id = any($1::uuid[]) and direction = 'airport_to_home' order by id`, [JSON.parse(readFileSync(NOTA, 'utf8'))]) : await q(`select r.id from reservations r where r.cancelled_at is null and r.direction = 'airport_to_home'
                     and (r.required_arrival_at at time zone 'America/Bogota')::date = $1::date
                     order by r.required_arrival_at, r.id limit 3`, [hoy]);
if (!sal.length || !lle.length) { console.error('no hay salidas/llegadas de hoy (correr _seed-e2e-local.mjs --reservas)'); process.exit(1); }

await q('begin');
try {
  // Vueltas de hoy de carlos fuera (las paradas caen en cascada).
  await q(`delete from route_assignments where driver_profile_id = $1 and (planned_start_at at time zone 'America/Bogota')::date = $2::date`, [drv.id, hoy]);
  const ids = [...sal, ...lle].map((r) => r.id);
  await q(`delete from route_stops where reservation_id = any($1::uuid[])`, [ids]);
  if (AHORA) {
    // V1 sale en 2 min: presentación a +85 min; la llegada aterriza a +100 min.
    await q(`update reservations set required_arrival_at = now() + interval '85 minutes' where id = any($1::uuid[])`, [sal.map((r) => r.id)]);
    await q(`update reservations set required_arrival_at = now() + interval '100 minutes' where id = any($1::uuid[])`, [lle.map((r) => r.id)]);
  }
  await q(`update reservations set status_h2a = 'requested', boarding_check = null, boarding_checked_at = null where id = any($1::uuid[])`, [sal.map((r) => r.id)]);
  await q(`update reservations set status_a2h = 'scheduled', boarding_check = null, boarding_checked_at = null where id = any($1::uuid[])`, [lle.map((r) => r.id)]);
  // Datos que la pantalla pinta (0086): maletas, punto de encuentro, nota.
  await q(`update reservations set bags = 2, meeting_point = 'Portería 2, frente al parqueadero', notes = 'El timbre no sirve, mejor escríbeme.' where id = $1`, [sal[0].id]);
  if (sal[1]) await q(`update reservations set bags = 1, meeting_point = null, notes = null where id = $1`, [sal[1].id]);
  if (sal[2]) await q(`update reservations set bags = 1, meeting_point = 'Lobby de la torre 2', notes = null where id = $1`, [sal[2].id]);
  await q(`update reservations set bags = 1, meeting_point = 'Puerta 3, salida de pasajeros' where id = any($1::uuid[])`, [lle.map((r) => r.id)]);

  const [pres] = await q(`select min(required_arrival_at) t from reservations where id = any($1::uuid[])`, [sal.map((r) => r.id)]);
  const startSal = new Date(new Date(pres.t).getTime() - 80 * 60000);
  const [v1] = await q(`insert into route_assignments (driver_profile_id, vehicle_id, direction, planned_start_at, status)
                        values ($1, $2, 'home_to_airport', $3, 'planned') returning id`, [drv.id, veh.id, startSal]);
  for (const [i, r] of sal.entries()) {
    await q(`insert into route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at) values ($1, $2, $3, $4)`,
      [v1.id, r.id, i + 1, new Date(startSal.getTime() + (15 + i * 13) * 60000)]);
  }
  const [land] = await q(`select min(required_arrival_at) t from reservations where id = any($1::uuid[])`, [lle.map((r) => r.id)]);
  const startLle = new Date(new Date(land.t).getTime() + 15 * 60000);
  const [v2] = await q(`insert into route_assignments (driver_profile_id, vehicle_id, direction, planned_start_at, status)
                        values ($1, $2, 'airport_to_home', $3, 'planned') returning id`, [drv.id, veh.id, startLle]);
  for (const [i, r] of lle.entries()) {
    await q(`insert into route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at) values ($1, $2, $3, $4)`,
      [v2.id, r.id, i + 1, new Date(startLle.getTime() + (28 + i * 16) * 60000)]);
  }
  await q('commit');
  console.log(`LISTO · ${hoy} · V1 salida ${v1.id} (${sal.length} paradas) · V2 llegada ${v2.id} (${lle.length} paradas)`);
} catch (e) { await q('rollback'); console.error(e.message); process.exit(1); }
await pg.end();
