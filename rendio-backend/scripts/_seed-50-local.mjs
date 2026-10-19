#!/usr/bin/env node
// _seed-50-local.mjs — Las MISMAS 50 reservas de prueba del 15-oct-2026 que se
// sembraron en dev (_seed-50-manana-dev.mjs), pero en la base LOCAL, para probar
// Asignación simple en el navegador antes de subir. Lee las 50 del archivo de datos
// del prototipo (Visual/prototipo-asignacion-simple-2026-10-14/datos.js: nombre,
// conjunto, tipo y hora) y:
//   · crea (o reusa) una cuenta de tripulante por persona: tri50.N@rendio.test,
//     con su conjunto del catálogo local;
//   · publica el horario de la semana con los conductores locales en AM y PM
//     (para que la asignación automática tenga a quién poner);
//   · borra las reservas «Prueba 50» de ese día y las vuelve a crear.
//
//   cd rendio-backend/scripts && node _seed-50-local.mjs
//
// NUNCA toca dev ni producción: solo 127.0.0.1 (aborta si no).
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { localClient } from './_local-fixtures.mjs';

// Misma contraseña de las cuentas locales (_seed-e2e-local.mjs; importarlo correría esa siembra).
const E2E_PASSWORD = 'Prueba-Local-2026!';
const env = Object.fromEntries(execSync('supabase status -o env', { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' })
  .split('\n').map((l) => l.match(/^([A-Z_]+)="?(.*?)"?$/)).filter(Boolean).map((m) => [m[1], m[2]]));
if (!/127\.0\.0\.1|localhost/.test(env.API_URL || '')) { console.error('ABORT: solo base local'); process.exit(2); }
const sb = createClient('http://127.0.0.1:54321', env.SERVICE_ROLE_KEY || env.SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const pg = await localClient();
const q = (s, p) => pg.query(s, p).then((r) => r.rows);

const DATOS = new URL('../../../Visual/prototipo-asignacion-simple-2026-10-14/datos.js', import.meta.url).pathname;
const D = (() => { const window = {}; eval(readFileSync(DATOS, 'utf8')); return window.DATOS; })();
const DAY = D.day;
const NEXT = new Date(Date.parse(DAY + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
const TAG = 'Prueba 50';

const [org] = await q(`select id from organizations where slug = 'rendio'`);
const RES = Object.fromEntries((await q(`select id, name from residences`)).map((r) => [r.name, r.id]));
const faltan = [...new Set(D.pax.map((p) => p.place))].filter((n) => !RES[n]);
if (faltan.length) { console.error('Conjuntos que no están en el catálogo local:', faltan); process.exit(1); }

// 1. Tripulantes
let creados = 0;
for (let i = 0; i < D.pax.length; i++) {
  const p = D.pax[i]; const email = `tri50.${i + 1}@rendio.test`;
  let [u] = await q(`select id from auth.users where email = $1`, [email]);
  if (!u) {
    const r = await sb.auth.admin.createUser({ email, password: E2E_PASSWORD, email_confirm: true, user_metadata: { full_name: p.name } });
    if (r.error) { console.error(email, r.error.message); process.exit(1); }
    u = { id: r.data.user.id }; creados++;
  }
  await q(`insert into profiles (id, organization_id, role, full_name, email, is_active) values ($1, $2, 'auxiliar', $3, $4, true)
           on conflict (id) do update set full_name = excluded.full_name, role = 'auxiliar', is_active = true`, [u.id, org.id, p.name, email]);
  const [ap] = await q(`select id from auxiliar_profiles where profile_id = $1`, [u.id]);
  if (ap) await q(`update auxiliar_profiles set residence_id = $2 where id = $1`, [ap.id, RES[p.place]]);
  else await q(`insert into auxiliar_profiles (profile_id, residence_id, home_address, home_latitude, home_longitude) values ($1, $2, null, null, null)`, [u.id, RES[p.place]]);
  p.apId = (await q(`select id from auxiliar_profiles where profile_id = $1`, [u.id]))[0].id;
}
console.log(`Tripulantes: ${D.pax.length} (${creados} nuevos)`);

// 2. Horario publicado de la semana: los conductores locales en AM y PM todos los días.
const drivers = (await q(`select p.id from driver_profiles dp join profiles p on p.id = dp.profile_id where p.is_active order by p.full_name`)).map((r) => r.id);
const lunes = (() => { const d = new Date(DAY + 'T12:00:00Z'); const w = d.getUTCDay(); d.setUTCDate(d.getUTCDate() - (w === 0 ? 6 : w - 1)); return d.toISOString().slice(0, 10); })();
const dia = { morning: drivers, afternoon: drivers, rest: [], coord_am: [], coord_pm: [] };
const data = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((k) => [k, dia]));
const [ws] = await q(`select id from weekly_schedules where week_start_date = $1`, [lunes]);
if (ws) await q(`update weekly_schedules set data = $2, published = true where id = $1`, [ws.id, JSON.stringify(data)]);
else await q(`insert into weekly_schedules (week_start_date, data, published) values ($1, $2, true)`, [lunes, JSON.stringify(data)]);
console.log(`Horario de la semana del ${lunes} publicado con ${drivers.length} conductores en AM y PM`);

// 3. Reservas del día (las «Prueba 50» de antes, fuera)
const viejas = (await q(`select id from reservations where notes like $1 and required_arrival_at >= $2 and required_arrival_at < $3`, [TAG + ' · %', DAY + 'T00:00:00-05:00', NEXT + 'T00:00:00-05:00'])).map((r) => r.id);
if (viejas.length) {
  await q(`delete from route_assignments where id in (select route_assignment_id from route_stops where reservation_id = any($1::uuid[]))`, [viejas]);
  await q(`delete from route_stops where reservation_id = any($1::uuid[])`, [viejas]);
  await q(`delete from reservations where id = any($1::uuid[])`, [viejas]);
}
for (const p of D.pax) {
  const lle = p.dir === 'lle';
  await q(`insert into reservations (auxiliar_profile_id, direction, status_h2a, status_a2h, required_arrival_at, residence_id, pickup_address, notes)
           values ($1, $2, $3, $4, $5, $6, '', $7)`,
    [p.apId, lle ? 'airport_to_home' : 'home_to_airport', lle ? null : 'requested', lle ? 'scheduled' : null, `${DAY}T${p.time}:00-05:00`, RES[p.place], `${TAG} · oleada ${p.dir} ${p.time}`]);
}
const [n] = await q(`select count(*) n, count(*) filter (where pickup_latitude is not null) c from reservations where notes like $1 and required_arrival_at >= $2 and required_arrival_at < $3`, [TAG + ' · %', DAY + 'T00:00:00-05:00', NEXT + 'T00:00:00-05:00']);
console.log(`Reservas del ${DAY}: ${n.n} (${n.c} con coordenadas). Entrar como jefe.local@rendio.test.`);
await pg.end();
