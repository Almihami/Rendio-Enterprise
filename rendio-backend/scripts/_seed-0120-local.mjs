#!/usr/bin/env node
// _seed-0120-local.mjs — Turnos de prueba en la base LOCAL para ver «Ajustar
// horas» (0120) en el Balance, en el corte 10 → 24 oct 2026:
//   Carlos: 14-oct completo 05:00–17:00 · 15-oct auto-cerrado 14:00 → 16-oct
//           13:00 (el sistema) · 16-oct arranque falso · 20-oct completo
//   Diana:  14-oct completo 14:00 → 01:30 · 18-oct completo 05:00–17:00
// Todos llevan notes = 'PRUEBA-0120'. Borra los de una corrida anterior y los
// ajustes de esas personas en el corte.
//
//   cd rendio-backend/scripts && node _seed-0120-local.mjs            (siembra)
//   cd rendio-backend/scripts && node _seed-0120-local.mjs --limpiar  (solo borra)
//
// NUNCA toca dev ni producción (_local-fixtures.mjs solo conecta a 127.0.0.1:54322).
import { localClient } from './_local-fixtures.mjs';

const c = await localClient();
const one = async (s, p) => (await c.query(s, p)).rows[0];
const quien = async email => one(`SELECT p.id pid, p.organization_id org, dp.id did FROM public.profiles p
  LEFT JOIN public.driver_profiles dp ON dp.profile_id = p.id WHERE p.email = $1`, [email]);
const jefe = await quien('jefe.local@rendio.test');
const carlos = await quien('carlos.local@rendio.test');
const diana = await quien('diana.local@rendio.test');
const pedro = await quien('pedro.local@rendio.test');
if (!jefe || !carlos?.did || !diana?.did || !pedro?.did) { console.error('Faltan las cuentas de prueba: node _seed-e2e-local.mjs'); process.exit(2); }
const carro = await one(`SELECT id FROM public.vehicles WHERE organization_id = $1 ORDER BY created_at LIMIT 1`, [jefe.org]);
if (!carro) { console.error('La organización del jefe local no tiene carros.'); process.exit(2); }
const dids = [carlos.did, diana.did, pedro.did];

await c.query('BEGIN');
await c.query(`DELETE FROM public.shift_hour_adjustments WHERE driver_id = ANY($1) AND work_date BETWEEN '2026-10-10' AND '2026-10-24'`, [dids]);
await c.query(`DELETE FROM public.shifts WHERE notes = 'PRUEBA-0120'`);
if (!process.argv.includes('--limpiar')) {
  const t = (did, ini, fin, abre, cierra) => c.query(
    `INSERT INTO public.shifts (organization_id, driver_id, vehicle_id, status, start_at, end_at, opening_km, closing_km, notes)
     VALUES ($1, $2, $3, 'closed', $4, $5, $6, $7, 'PRUEBA-0120')`, [jefe.org, did, carro.id, ini, fin, abre, cierra]);
  await t(carlos.did, '2026-10-14T05:00:00-05:00', '2026-10-14T17:00:00-05:00', 51000, 51180);
  await t(carlos.did, '2026-10-15T14:00:00-05:00', '2026-10-16T13:00:00-05:00', 51180, null);
  await t(carlos.did, '2026-10-16T04:30:00-05:00', '2026-10-16T04:40:00-05:00', null, null);
  await t(carlos.did, '2026-10-20T05:05:00-05:00', '2026-10-20T16:50:00-05:00', 51400, 51590);
  await t(diana.did, '2026-10-14T14:00:00-05:00', '2026-10-15T01:30:00-05:00', 62000, 62150);
  await t(diana.did, '2026-10-18T05:00:00-05:00', '2026-10-18T17:00:00-05:00', 62150, 62300);
}
await c.query('COMMIT');
const n = await one(`SELECT count(*)::int n FROM public.shifts WHERE notes = 'PRUEBA-0120'`);
const otros = await one(`SELECT count(*)::int n FROM public.shifts WHERE organization_id = $1 AND notes IS DISTINCT FROM 'PRUEBA-0120'
  AND start_at >= '2026-10-10T00:00:00-05:00' AND start_at < '2026-10-25T00:00:00-05:00'`, [jefe.org]);
console.log(`${n.n} turnos de prueba en la base local (+ ${otros.n} de otras pruebas en ese corte).`);
console.log(JSON.stringify({ carlos: carlos.did, diana: diana.did, pedro: pedro.did, pedroPid: pedro.pid }));
await c.end();
