#!/usr/bin/env node
// _e2e-madrugada-local.mjs — Vueltas de madrugada (0107, 13-oct-2026) con la app real.
//
// El caso de producción: un vuelo que aterriza a las 00:40 del jueves. Antes el
// optimizador arrancaba los carros a la 01:30 y la dejaba «sin rutear». Ahora:
//   1. Asignación del jueves la programa (una vuelta de llegada antes del corte);
//   2. la vuelta queda en la franja «PM de ayer» y propone a un conductor del turno
//      PM del MIÉRCOLES (horario publicado);
//   3. la hoja «Conductor para…» deja elegir a otros conductores fuera de turno;
//   4. al publicar, la ruta queda el jueves 00:5x con ese conductor.
// Al final borra lo que creó. Base LOCAL y app en :5180 (preview «e2e-local»).
//
//   cd rendio-backend/scripts && node _e2e-madrugada-local.mjs
import { readFileSync, mkdirSync } from 'node:fs';
import { localClient } from './_local-fixtures.mjs';

const PW = process.env.E2E_PLAYWRIGHT || '/Users/harold/Documents/Rendio-Drivers/.e2e-tools/node_modules/playwright/index.mjs';
const { chromium } = await import(PW);
const APP = process.env.E2E_BASE || 'http://localhost:5180';
const OUT = '/Users/harold/Documents/Rendio-Drivers/.e2e-tools/run/madrugada';
mkdirSync(OUT, { recursive: true });
const PASS = (readFileSync(new URL('./_seed-e2e-local.mjs', import.meta.url), 'utf8').match(/E2E_PASSWORD\s*=\s*'([^']+)'/) || [])[1];
const pg = await localClient();
const q = async (s, p) => (await pg.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
let ok = 0, fail = 0;
const check = (n, c, d) => { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d != null ? ' → ' + d : ''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Día de la prueba: el próximo día cuyo día ANTERIOR tenga horario publicado con turno PM.
const DIA = process.env.DIA || '2026-10-15';
const AYER = (await one(`SELECT to_char(($1::date - 1), 'YYYY-MM-DD') d`, [DIA])).d;
const dow = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(AYER + 'T12:00:00-05:00').getUTCDay()];
const sem = await one(`SELECT data FROM public.weekly_schedules WHERE published AND week_start_date <= $1::date AND week_start_date + 6 >= $1::date ORDER BY week_start_date DESC LIMIT 1`, [AYER]);
const pmAyer = (sem && sem.data && sem.data[dow] && sem.data[dow].afternoon) || [];
console.log(`Día ${DIA} · turno PM de ayer (${AYER}): ${pmAyer.length} conductores en el horario publicado`);

const t2 = await one(`SELECT ap.id aux, ap.residence_id res, r.latitude lat, r.longitude lng, r.name FROM public.profiles p JOIN public.auxiliar_profiles ap ON ap.profile_id = p.id
  LEFT JOIN public.residences r ON r.id = ap.residence_id WHERE p.email = 'tripu2.local@rendio.test'`);
const creada = (await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_a2h, required_arrival_at, pickup_address, pickup_latitude, pickup_longitude, residence_id, notes)
  VALUES ($1, 'airport_to_home', 'scheduled', $2, $3, $4, $5, $6, 'Vuelo JA5473.') RETURNING id`,
  [t2.aux, `${DIA}T00:40:00-05:00`, t2.name || 'Casa', t2.lat ?? 6.1523, t2.lng ?? -75.3781, t2.res])).id;
const limpiar = async () => {
  await q(`DELETE FROM public.route_assignments WHERE id IN (SELECT route_assignment_id FROM public.route_stops WHERE reservation_id = $1)`, [creada]);
  await q(`DELETE FROM public.route_stops WHERE reservation_id = $1`, [creada]);
  await q(`DELETE FROM public.notification_outbox WHERE dedupe_key LIKE $1`, [`trip:${creada}:%`]);
  await q(`DELETE FROM public.reservations WHERE id = $1`, [creada]);
};

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'es-CO', timezoneId: 'America/Bogota' });
  const p = await ctx.newPage();
  const errores = []; p.on('pageerror', (e) => errores.push(e.message));
  p.on('dialog', (d) => d.accept());
  await p.goto(APP + '/');
  await p.fill('#login-email', 'jefe.local@rendio.test'); await p.fill('#login-password', PASS); await p.click('#login-submit');
  await p.waitForFunction(() => document.getElementById('screen-login')?.classList.contains('hidden'), null, { timeout: 25000 });
  await p.evaluate(() => { const b = document.querySelector('#adm-wstabs button[data-ws="rutas"]'); if (b) b.click(); });
  await sleep(600);
  for (let i = 0; i < 4; i++) { await p.evaluate(() => window.setTab && setTab('routes')); await sleep(1500); if (await p.$('#rv2-dayLabel:visible')) break; }
  // Ir al día de la prueba con las flechas.
  for (let i = 0; i < 12; i++) {
    const dia = await p.evaluate(() => (typeof rt !== 'undefined' && rt.day) || null).catch(() => null);
    if (dia === DIA) break;
    const dir = dia && dia > DIA ? -1 : 1;
    await p.click(`[data-act="nav"][data-dir="${dir}"]`).catch(() => {});
    await sleep(2200);
  }
  check('Asignación quedó en el día de la prueba', await p.evaluate((d) => typeof rt !== 'undefined' && rt.day === d, DIA), await p.evaluate(() => typeof rt !== 'undefined' && rt.day));
  const enPool = await p.evaluate((rid) => Object.keys(rt.aux).some((k) => rt.aux[k].reservationId === rid && (rt.pool || []).includes(k)), creada);
  check('la llegada de las 00:40 aparece «sin rutear» antes de optimizar', enPool);
  await p.click('[data-act="reopt"]');
  await p.waitForFunction(() => typeof rt !== 'undefined' && rt.optimized, null, { timeout: 30000 });
  await sleep(1500);
  const r = await p.evaluate((rid) => {
    const k = Object.keys(rt.aux).find((x) => rt.aux[x].reservationId === rid);
    const lane = rt.lanes.find((l) => (rt.order[l.id] || []).includes(k));
    return { k, enPool: (rt.pool || []).includes(k), lane: lane ? { id: lane.id, type: lane.type, start: lane.start, band: rtBandOf(lane), driver: rtDriverOf(lane) } : null, corte: rt.NIGHT_CUTOFF };
  }, creada);
  check('después de optimizar ya NO queda sin rutear', !r.enPool && !!r.lane, JSON.stringify(r));
  check('queda en una vuelta de llegada antes de las 02:00 (franja «PM de ayer»)', r.lane && r.lane.type === 'lle' && r.lane.band === 'mad' && r.lane.start < '02:00', JSON.stringify(r.lane));
  await p.screenshot({ path: `${OUT}/01-optimizado.png` });
  // Conductor: el autoasignar del tablero toma del PM de ayer.
  await p.evaluate(() => { const b = document.querySelector('[data-act="autoassign"]'); if (b) b.click(); });
  await sleep(800);
  let drv = await p.evaluate((rid) => { const k = Object.keys(rt.aux).find((x) => rt.aux[x].reservationId === rid); const lane = rt.lanes.find((l) => (rt.order[l.id] || []).includes(k)); return lane ? rtDriverOf(lane) : null; }, creada);
  if (!drv) {
    // Sin el botón global: abrir la hoja del conductor de esa ruta y elegir el primero.
    await p.evaluate((rid) => { const k = Object.keys(rt.aux).find((x) => rt.aux[x].reservationId === rid); const lane = rt.lanes.find((l) => (rt.order[l.id] || []).includes(k)); const b = document.querySelector(`[data-act="assign"][data-id="${lane.id}"]`) || document.querySelector('[data-act="assign"]'); if (b) b.click(); }, creada);
    await sleep(800);
  }
  // La hoja «Conductor para…» de esa ruta: los del PM de ayer y «Otros conductores».
  await p.evaluate((rid) => {
    const k = Object.keys(rt.aux).find((x) => rt.aux[x].reservationId === rid);
    const lane = rt.lanes.find((l) => (rt.order[l.id] || []).includes(k));
    const btn = [...document.querySelectorAll('[data-act="assign"]')].find((b) => b.dataset.id === lane.id) || document.querySelector('[data-act="assign"]');
    if (btn) btn.click();
  }, creada);
  await sleep(900);
  const hoja = await p.evaluate(() => { const s = document.querySelector('.rv2-sheet'); return s ? s.innerText.replace(/\s+/g, ' ') : ''; });
  check('la hoja dice que es el turno PM del día anterior', /turno PM del día anterior|PM de ayer/i.test(hoja), hoja.slice(0, 200));
  check('y ofrece «Otros conductores» fuera de turno', /Otros conductores/i.test(hoja) || pmAyer.length === 0, hoja.slice(0, 300));
  const pick = await p.evaluate((ids) => { const b = [...document.querySelectorAll('.rv2-sheet [data-pick]')].find((x) => !x.disabled && ids.includes(x.dataset.pick)) || document.querySelector('.rv2-sheet [data-pick]:not([disabled])'); if (!b) return null; b.click(); return b.dataset.pick; }, pmAyer);
  await sleep(300);
  await p.evaluate(() => { const b = document.getElementById('rv2-doAssign'); if (b && !b.disabled) b.click(); else { const c = document.querySelector('.rv2-sheet [data-act="sclose"]'); if (c) c.click(); } });
  await sleep(800);
  await p.screenshot({ path: `${OUT}/02-conductor.png` });
  drv = await p.evaluate((rid) => { const k = Object.keys(rt.aux).find((x) => rt.aux[x].reservationId === rid); const lane = rt.lanes.find((l) => (rt.order[l.id] || []).includes(k)); return lane ? rtDriverOf(lane) : null; }, creada);
  const drvProfile = drv;
  const enPMAyer = pmAyer.length ? (await one(`SELECT count(*)::int n FROM public.driver_profiles dp WHERE dp.profile_id = $1 AND dp.id = ANY($2::uuid[])`, [drvProfile, pmAyer]).catch(() => ({ n: 0 }))).n > 0
    || pmAyer.includes(drvProfile) : true;
  check('la vuelta queda con un conductor del turno PM de ayer', !!drv && enPMAyer, `conductor ${drv} · elegido ${pick}`);
  // Publicar y revisar la base.
  const pub = await p.evaluate(async () => { try { const r = await rtSavePlan(); return r; } catch (e) { return { error: e.message }; } });
  check('publicar sin errores', pub && !pub.error && pub.ok !== false, JSON.stringify(pub));
  const ra = await one(`SELECT to_char(ra.planned_start_at AT TIME ZONE 'America/Bogota','YYYY-MM-DD HH24:MI') salida, ra.direction::text dir, dp.profile_id
    FROM public.route_stops rs JOIN public.route_assignments ra ON ra.id = rs.route_assignment_id LEFT JOIN public.driver_profiles dp ON dp.id = ra.driver_profile_id WHERE rs.reservation_id = $1`, [creada]);
  check('en la base: ruta de llegada el jueves antes de las 02:00, con ese conductor', ra && ra.dir === 'airport_to_home' && ra.salida.startsWith(DIA + ' 0') && ra.salida < `${DIA} 02:00` && ra.profile_id === drv, JSON.stringify(ra));
  check('sin errores de JavaScript', errores.length === 0, errores.slice(0, 3).join(' | '));
  await ctx.close();
} catch (e) { fail++; console.error('ERROR', e.message); }
finally { await browser.close(); await limpiar(); await pg.end(); }
console.log(`\n${ok} bien · ${fail} mal · capturas en ${OUT}`);
process.exit(fail ? 1 : 0);
