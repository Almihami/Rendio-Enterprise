#!/usr/bin/env node
// _e2e-republicar-local.mjs — Re-publicar el plan con una vuelta ya arrancada NO borra
// lo atendido (hallazgo del 12-oct-2026: nadie pasa las rutas a in_progress, así que
// saveRoutePlan borraba la vuelta «planned» con sus paradas atendidas).
//
// Independiente de la hora: arma su propio escenario para MAÑANA en la base LOCAL,
// re-publica con Api.saveRoutePlan desde la sesión real del jefe (Playwright contra la
// app de :5180) y revisa la base. Al final borra lo que creó.
//
//   cd rendio-backend/scripts && node _e2e-republicar-local.mjs
//
// NUNCA toca dev ni producción (_local-fixtures.mjs solo conecta a 127.0.0.1:54322).
import { readFileSync } from 'node:fs';
import { localClient } from './_local-fixtures.mjs';

const PW = process.env.E2E_PLAYWRIGHT || '/Users/harold/Documents/Rendio-Drivers/.e2e-tools/node_modules/playwright/index.mjs';
const { chromium } = await import(PW);
const APP = process.env.E2E_BASE || 'http://localhost:5180';
const PASS = (readFileSync(new URL('./_seed-e2e-local.mjs', import.meta.url), 'utf8').match(/E2E_PASSWORD\s*=\s*'([^']+)'/) || [])[1];
const pg = await localClient();
const q = async (s, p) => (await pg.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
let ok = 0, fail = 0;
const check = (n, c, d) => { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d != null ? ' → ' + d : ''}`); } };

const DIA = (await one(`SELECT to_char((now() + interval '1 day') AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD') d`)).d;
const per = async (email) => one(`SELECT p.id, ap.id aux, dp.id drv FROM public.profiles p LEFT JOIN public.auxiliar_profiles ap ON ap.profile_id = p.id
                                   LEFT JOIN public.driver_profiles dp ON dp.profile_id = p.id WHERE p.email = $1`, [email]);
const carlos = await per('carlos.local@rendio.test'), diana = await per('diana.local@rendio.test');
const T = [await per('tripu1.local@rendio.test'), await per('tripu2.local@rendio.test'), await per('tripu3.local@rendio.test')];
const [v1, v2] = await q(`SELECT id FROM public.vehicles WHERE internal_code IN ('V-01','V-02') ORDER BY internal_code`);
if (!carlos?.drv || !diana?.drv || T.some((t) => !t?.aux) || !v2) { console.error('falta la semilla (_seed-e2e-local.mjs)'); process.exit(2); }

const creadas = [];
const at = (hm) => `${DIA}T${hm}:00-05:00`;
async function reserva(t, hm) {
  const r = await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_h2a, required_arrival_at, pickup_address, pickup_latitude, pickup_longitude)
    VALUES ($1, 'home_to_airport', 'requested', $2, 'Prueba re-publicar', 6.1523, -75.3781) RETURNING id`, [t.aux, at(hm)]);
  creadas.push(r.id); return r.id;
}
async function limpiar() {
  if (!creadas.length) return;
  await q(`DELETE FROM public.route_assignments WHERE id IN (SELECT route_assignment_id FROM public.route_stops WHERE reservation_id = ANY($1))`, [creadas]);
  await q(`DELETE FROM public.route_stops WHERE reservation_id = ANY($1)`, [creadas]);
  await q(`DELETE FROM public.notification_outbox WHERE dedupe_key LIKE ANY($1)`, [creadas.map((id) => `trip:${id}:%`)]);
  await q(`DELETE FROM public.reservations WHERE id = ANY($1)`, [creadas]);
}
const paradas = async (ra) => q(`SELECT reservation_id rid, status FROM public.route_stops WHERE route_assignment_id = $1 ORDER BY stop_order`, [ra]);
const dups = async () => q(`SELECT reservation_id, count(*)::int n FROM public.route_stops WHERE reservation_id = ANY($1) GROUP BY reservation_id HAVING count(*) > 1`, [creadas]);
const rutaDe = async (rid) => one(`SELECT ra.id, ra.status, dp.profile_id FROM public.route_stops rs JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id
                                     JOIN public.driver_profiles dp ON dp.id = ra.driver_profile_id WHERE rs.reservation_id = $1`, [rid]);

const browser = await chromium.launch();
try {
  const [r1, r2, r3] = [await reserva(T[0], '10:00'), await reserva(T[1], '10:00'), await reserva(T[2], '10:30')];
  // A: carlos, ARRANCADA (r1 a bordo, r2 pendiente) · B: diana, sin arrancar (r3).
  const A = (await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at) VALUES ($1, $2, 'home_to_airport', 'planned', $3) RETURNING id`, [carlos.drv, v1.id, at('08:40')])).id;
  await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order) VALUES ($1, $2, 1), ($1, $3, 2)`, [A, r1, r2]);
  await q(`UPDATE public.route_stops SET status = 'picked_up', actual_pickup_at = now() WHERE reservation_id = $1`, [r1]);
  await q(`UPDATE public.reservations SET status_h2a = 'on_board' WHERE id = $1`, [r1]);
  const B = (await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at) VALUES ($1, $2, 'home_to_airport', 'planned', $3) RETURNING id`, [diana.drv, v2.id, at('09:10')])).id;
  await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order) VALUES ($1, $2, 1)`, [B, r3]);

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(APP);
  await p.fill('#login-email', 'jefe.local@rendio.test'); await p.fill('#login-password', PASS); await p.click('#login-submit');
  await p.waitForFunction(() => window.Api && Api.saveRoutePlan && document.getElementById('screen-login')?.classList.contains('hidden'), null, { timeout: 25000 });
  const publicar = (lanes) => p.evaluate(async ([d, l]) => { try { const x = await Api.saveRoutePlan(d, l); return { saved: x.saved, kept: x.kept, failed: x.failed, failMsg: x.failMsg, notify: (x.notify || []).length }; } catch (e) { return { error: e.message }; } }, [DIA, lanes]);
  const lane = (who, veh, hm, stops) => ({ driverProfileId: who.id, vehicleId: veh.id, type: 'sal', startAt: at(hm), stops, etas: {} });

  // 1) Re-publicar el MISMO plan.
  console.log('\n1) Re-publicar el mismo plan con la vuelta de Carlos a mitad');
  const r = await publicar([lane(carlos, v1, '08:40', [r1, r2]), lane(diana, v2, '09:10', [r3])]);
  check('saveRoutePlan sin errores ni fallas', !r.error && !r.failed, JSON.stringify(r));
  const aSigue = await one(`SELECT id FROM public.route_assignments WHERE id = $1`, [A]);
  check('la vuelta arrancada de Carlos sigue (mismo id)', !!aSigue);
  const pa = await paradas(A);
  check('…con sus 2 paradas en el mismo estado (a bordo + pendiente)', pa.length === 2 && pa[0].rid === r1 && pa[0].status === 'picked_up' && pa[1].rid === r2 && pa[1].status === 'pending', JSON.stringify(pa));
  check('…y la reserva de quien va a bordo sigue on_board', (await one(`SELECT status_h2a::text s FROM public.reservations WHERE id = $1`, [r1])).s === 'on_board');
  const b2 = await rutaDe(r3);
  check('la vuelta SIN arrancar de Diana se re-crea (id nuevo) con su parada', b2 && b2.id !== B && b2.profile_id === diana.id, JSON.stringify(b2));
  check('ninguna parada duplicada', (await dups()).length === 0, JSON.stringify(await dups()));
  check('el aviso: lo intacto se reporta como «intacto», no como nuevo', r.kept === 2, `kept=${r.kept}`);

  // 2) Pasarle la pendiente (r2) a Diana: se mueve; lo atendido no.
  console.log('\n2) Mover la parada PENDIENTE de Carlos a Diana');
  const r2p = await publicar([lane(carlos, v1, '08:40', [r1]), lane(diana, v2, '09:10', [r2, r3])]);
  check('saveRoutePlan sin errores', !r2p.error && !r2p.failed, JSON.stringify(r2p));
  const pa2 = await paradas(A);
  check('la vuelta de Carlos queda solo con lo atendido (r1 a bordo)', pa2.length === 1 && pa2[0].rid === r1 && pa2[0].status === 'picked_up', JSON.stringify(pa2));
  const d2 = await rutaDe(r2);
  check('r2 ahora está en una vuelta de Diana', d2 && d2.profile_id === diana.id, JSON.stringify(d2));
  check('sin duplicados', (await dups()).length === 0, JSON.stringify(await dups()));
  check('Diana recibe aviso de la parada que se le pasó (notify)', r2p.notify >= 1, `notify=${r2p.notify}`);

  // 3) Intentar «mover» lo atendido: no se mueve.
  console.log('\n3) Intentar mover lo YA atendido');
  const r3p = await publicar([lane(diana, v2, '09:10', [r1, r2, r3])]);
  check('saveRoutePlan sin errores', !r3p.error && !r3p.failed, JSON.stringify(r3p));
  const pa3 = await paradas(A);
  check('quien va a bordo sigue en la vuelta de Carlos', pa3.length === 1 && pa3[0].rid === r1 && pa3[0].status === 'picked_up', JSON.stringify(pa3));
  check('sin duplicados', (await dups()).length === 0, JSON.stringify(await dups()));
  await ctx.close();
} catch (e) { fail++; console.error('ERROR', e); }
finally { await browser.close(); await limpiar(); await pg.end(); }
console.log(`\n${ok} bien · ${fail} mal`);
process.exit(fail ? 1 : 0);
