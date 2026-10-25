#!/usr/bin/env node
// _e2e-reserva-local.mjs — De reserva (0121) de punta a punta, con la app real
// (Playwright, iPhone) y la base LOCAL:
//   1. un tripulante pide una SALIDA de reserva al Hotel Movich con regreso el
//      mismo día: ninguna pantalla pide vuelo; el regreso pregunta «¿A qué hora
//      finaliza tu asignación?»;
//   2. en la base quedan DOS reservas con reserve_place = movich y sin vuelo;
//   3. abre el regreso → «Cambio de hora de llegada» arranca en Reserva · Movich.
// Al final borra lo que creó. Capturas en .e2e-tools/run/reserva.
//
//   (servidor reserva-local en :5201 y supabase start)
//   cd rendio-backend/scripts && node _e2e-reserva-local.mjs
//
// NUNCA toca dev ni producción (_local-fixtures.mjs solo conecta a 127.0.0.1:54322).
import { readFileSync, mkdirSync } from 'node:fs';
import { localClient } from './_local-fixtures.mjs';

const PW = process.env.E2E_PLAYWRIGHT || '/Users/harold/Documents/Rendio-Drivers/.e2e-tools/node_modules/playwright/index.mjs';
const { chromium, devices } = await import(PW);
const APP = process.env.E2E_BASE || 'http://localhost:5201';
const OUT = '/Users/harold/Documents/Rendio-Drivers/.e2e-tools/run/reserva';
mkdirSync(OUT, { recursive: true });
const PASS = (readFileSync(new URL('./_seed-e2e-local.mjs', import.meta.url), 'utf8').match(/E2E_PASSWORD\s*=\s*'([^']+)'/) || [])[1];
const email = 'tripu8.local@rendio.test';
const pg = await localClient();
const one = async (s, p) => (await pg.query(s, p)).rows[0];
let ok = 0, fail = 0;
const check = (n, c, d) => { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d != null ? ' → ' + d : ''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errores = [];

await pg.query(readFileSync(new URL('../supabase/migrations/0121_reserva_hotel.sql', import.meta.url), 'utf8'));
const ap = await one(`SELECT ap.id FROM public.auxiliar_profiles ap JOIN public.profiles p ON p.id = ap.profile_id WHERE p.email = $1`, [email]);
if (!ap) { console.error('Falta ' + email + ' en la base local: node _seed-e2e-local.mjs'); process.exit(2); }
const desde = new Date().toISOString();

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'es-CO', timezoneId: 'America/Bogota' });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errores.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errores.push(m.text().slice(0, 200)); });
  await p.goto(APP + '/');
  await p.waitForSelector('#login-email', { state: 'visible', timeout: 20000 });
  await p.fill('#login-email', email); await p.fill('#login-password', PASS); await p.click('#login-submit');
  await p.waitForFunction(() => window.Auxiliar && window.Auxiliar.state && window.Auxiliar.state.source && window.Auxiliar.state.source !== 'demo', null, { timeout: 25000 }).catch(() => {});
  await sleep(1500);
  for (let i = 0; i < 6; i++) {   // por si sale la bienvenida o el permiso
    const b = await p.$('[data-ax=onb-skip]:visible, [data-ax=onb-later]:visible'); if (!b) break; await b.click().catch(() => {}); await sleep(600);
  }

  console.log('\n1) Pide una salida de reserva al Movich con regreso');
  await p.evaluate(() => window.Auxiliar.newTrip()); await sleep(700);
  await p.click('[data-ax="type"][data-type="sal"]'); await sleep(900);
  await p.screenshot({ path: `${OUT}/01-paso-vuelo.png` });
  const t1 = await p.evaluate(() => document.getElementById('auxiliar-ui').innerText);
  check('pregunta «¿Vas en vuelo o de reserva?» y la sección va sin descripciones', /¿Vas en vuelo o de reserva\?/.test(t1) && /¿Regresas el mismo día\?/.test(t1) && !/Si vuelves hoy mismo/.test(t1) && !/reserva en firme/i.test(t1));
  await p.click('[data-ax="viaje"][data-v="reserva"]'); await sleep(400);
  await p.click('[data-ax="lugar"][data-v="movich"]'); await sleep(600);
  await p.screenshot({ path: `${OUT}/01b-reserva-lugar.png` });
  const t1b = await p.evaluate(() => document.getElementById('auxiliar-ui').innerText);
  check('el título pasa a «¿Cuándo es tu reserva?» y se ven los tres lugares', /¿Cuándo es tu reserva\?/.test(t1b) && /Río Verde/.test(t1b) && /Movich/.test(t1b) && /Aeropuerto/.test(t1b));
  await p.locator('[data-ax="date"]').nth(1).click(); await sleep(300);
  await p.fill('[data-field="time"]', '11:20'); await sleep(200);
  await p.click('[data-key="sameDayBack"]'); await sleep(400);
  await p.fill('[data-field="backTime"]', '18:30'); await sleep(400);
  await p.screenshot({ path: `${OUT}/02-reserva-movich.png`, fullPage: true });
  const t2 = await p.evaluate(() => document.getElementById('auxiliar-ui').innerText);
  check('de reserva: «¿A qué hora deseas estar en el hotel?» y el regreso «¿A qué hora finaliza tu asignación?», sin vuelo', /¿A qué hora deseas estar en el hotel\?/.test(t2) && /¿A qué hora finaliza tu asignación\?/.test(t2) && !(await p.$('[data-field="backFlightNum"]')) && !(await p.$('[data-key="isPernocta"]')));
  for (let i = 0; i < 6; i++) {
    const k = await p.evaluate(() => window.Auxiliar.stepKind());
    if (k === 'revisar') break;
    const dis = await p.evaluate(() => window.Auxiliar.ctaState().disabled);
    if (dis) { check('Continuar habilitado en ' + k, false); break; }
    await p.evaluate(() => { const b = document.querySelector('#auxiliar-ui [data-ax="next"], #auxiliar-ui .ax-cta-bar .rx-btn'); if (b) b.click(); });
    await sleep(700);
  }
  await p.screenshot({ path: `${OUT}/03-revisar.png`, fullPage: true });
  const t3 = await p.evaluate(() => document.getElementById('auxiliar-ui').innerText);
  check('el resumen dice Hotel Movich y «Finaliza tu asignación 18:30»', /Hotel Movich/.test(t3) && /Finaliza tu asignación 18:30/.test(t3), t3.slice(0, 200));
  await p.click('.rx-slide-k').catch(() => {}); await sleep(2500);
  await p.screenshot({ path: `${OUT}/04-pedido.png` });

  console.log('\n2) En la base');
  const filas = (await pg.query(`SELECT id, direction, reserve_place, notes, to_char(required_arrival_at AT TIME ZONE 'America/Bogota','HH24:MI') hora
                                  FROM public.reservations WHERE auxiliar_profile_id = $1 AND created_at >= $2 ORDER BY direction DESC`, [ap.id, desde])).rows;
  check('dos reservas, ida 11:20 y regreso 18:30, las dos en Movich y sin vuelo',
    filas.length === 2 && filas.every((f) => f.reserve_place === 'movich' && !/vuelo/i.test(f.notes || '')) && filas.some((f) => f.direction === 'home_to_airport' && f.hora === '11:20') && filas.some((f) => f.direction === 'airport_to_home' && f.hora === '18:30'),
    JSON.stringify(filas));

  console.log('\n3) El regreso se puede cambiar como reserva');
  const back = filas.find((f) => f.direction === 'airport_to_home');
  if (back) {
    await p.evaluate(() => window.AuxShell && AuxShell.refreshTrips && AuxShell.refreshTrips()); await sleep(1500);
    await p.evaluate((id) => window.AuxRxVuelo.open(id, { mode: 'llegada' }), back.id); await sleep(1200);
    await p.screenshot({ path: `${OUT}/05-cambio-llegada.png` });
    const t5 = await p.evaluate(() => (document.querySelector('#auxiliar-ui [data-scr="flight"]') || document.getElementById('auxiliar-ui')).innerText);
    check('«Cambio de hora de llegada» arranca en Reserva · Movich, sin vuelo y con «¿A qué hora finaliza tu asignación?»',
      /¿A qué hora finaliza tu asignación\?/.test(t5) && !!(await p.$('[data-rx="fv-viaje"][data-v="reserva"].on')) && !!(await p.$('[data-rx="fv-lugar"][data-v="movich"].on')) && !(await p.$('[data-rx-field="fv-flight"]')), t5.slice(0, 200));
  }
  check('sin errores de JavaScript', errores.length === 0, errores.slice(0, 4).join(' | '));
  await ctx.close();
} catch (e) { fail++; console.error('ERROR', e.message); }
finally {
  await browser.close();
  await pg.query(`DELETE FROM public.reservations WHERE auxiliar_profile_id = $1 AND created_at >= $2`, [ap.id, desde]).catch((e) => console.log('  (limpieza: ' + e.message + ')'));
  await pg.end();
}
console.log(`\n${ok} bien · ${fail} mal · capturas en ${OUT}`);
process.exit(fail ? 1 : 0);
