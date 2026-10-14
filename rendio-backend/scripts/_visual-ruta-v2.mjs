#!/usr/bin/env node
// _visual-ruta-v2.mjs — Capturas lado a lado: prototipo del diseñador (entrega del
// 12-oct-2026) vs la app, pantalla por pantalla, para revisar la ruta del conductor v2.
//
// Necesita: base LOCAL arriba con la semilla (_seed-e2e-local.mjs) y las vueltas de
// carlos (_seed-ruta-v2-local.mjs, este script lo corre), la app en :5180 (e2e-serve)
// y la carpeta Visual servida en :5174 (preview «visual-entregas»).
//
//   node _visual-ruta-v2.mjs [--noche] [--ancho=390] [--alto=844] [--solo=app|diseno]
//
// Salida: .e2e-tools/run/ruta-v2/<tema>-<ancho>x<alto>/{diseno,app}/NN-nombre.png y un
// index.html que las pone lado a lado. NUNCA toca dev ni producción.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localClient } from './_local-fixtures.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const PW = process.env.E2E_PLAYWRIGHT || '/Users/harold/Documents/Rendio-Drivers/.e2e-tools/node_modules/playwright/index.mjs';
const { chromium } = await import(PW);
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const NOCHE = process.argv.includes('--noche');
const W = +arg('ancho', 390), H = +arg('alto', 844);
const SOLO = arg('solo', '');
const APP = 'http://localhost:5180';
const DIS = 'http://localhost:5174/entrega-ruta-conductor-2026-10-12/entrega-ruta-conductor/Ruta%20Conductor%20v2%20(un%20solo%20archivo).html';
const OUT = join('/Users/harold/Documents/Rendio-Drivers/.e2e-tools/run/ruta-v2', `${NOCHE ? 'noche' : 'dia'}-${W}x${H}`);
const PASS = (readFileSync(join(AQUI, '_seed-e2e-local.mjs'), 'utf8').match(/E2E_PASSWORD\s*=\s*'([^']+)'/) || [])[1];
mkdirSync(join(OUT, 'diseno'), { recursive: true });
mkdirSync(join(OUT, 'app'), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pares = [];   // [nombre, diseño?, app?]
const errores = [];
const anota = (n) => { if (!pares.find((p) => p[0] === n)) pares.push([n]); };

const browser = await chromium.launch();

// ───────────────────────────── prototipo del diseñador
async function diseno() {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  p.setDefaultTimeout(15000);
  await p.goto(DIS);
  await p.waitForSelector('.rx-phone');
  await p.evaluate(() => localStorage.removeItem('rt-route-v2'));
  await p.reload(); await p.waitForSelector('.rx-phone');
  const tema = async () => { await p.click(`.rx-demo button:has-text("${NOCHE ? 'Nocturno' : 'Claro'}")`); await sleep(300); };
  const salta = async (t) => { await p.click(`.rx-demo button:has-text("${t}")`); await sleep(900); };
  const shot = async (n) => { anota(n); await sleep(700); await (await p.$('.rx-phone')).screenshot({ path: join(OUT, 'diseno', n + '.png') }); };
  await tema();
  await salta('Inicio del día'); await shot('01-mi-dia');
  await p.click('.rx-phone .rt-hero .rt-crew'); await shot('02-detalle-salida');
  await p.locator('.rx-phone .rx-layer').last().locator('.rx-foot .rx-btn').click(); await shot('03-ejecucion-en-camino');
  await salta('V1 · en la casa de Ana'); await shot('04-en-el-punto-codigo');
  await p.click('.rx-phone .rt-code-m .rt-link'); await shot('05-sin-codigo');
  await salta('V1 · José no sale'); await shot('06-espera');
  await p.click('.rx-demo button:has-text("Cumplir espera")'); await sleep(1200);
  await p.click('.rx-phone .rt-link.err'); await shot('07-confirmar-no-show');
  await p.click('.rx-phone .rx-sheet-bg', { position: { x: 20, y: 20 } }); await sleep(400);
  await salta('V1 · rumbo a MDE'); await shot('08-rumbo-aeropuerto');
  await p.click('.rx-phone .rt-cta .rx-btn.dark'); await shot('09-en-mde-salida');
  await p.click('.rx-phone .rt-cta .rx-btn.tone'); await sleep(600); await shot('10-vuelta-completa');
  await salta('V2 · llegada, rumbo a MDE'); await shot('11-llegada-rumbo-mde');
  await salta('V2 · en MDE con 3 auxiliares'); await shot('12-lista-aeropuerto');
  await p.click('.rx-phone .rt-cr-acts button:has-text("Sin código")'); await shot('13-fila-confirmar');
  await p.click('.rx-phone .rt-cr-acts button:has-text("Escribir")'); await shot('14-chat');
  await p.click('.rx-phone .rx-sheet-bg', { position: { x: 20, y: 20 } }); await sleep(400);
  await p.click('.rx-phone .rt-foot .rt-link:has-text("Reportar")'); await sleep(300);
  await p.click('.rx-phone .rt-opt:has-text("Trancón")'); await shot('15-reportar');
  await p.click('.rx-phone .rx-sheet-bg', { position: { x: 20, y: 20 } }); await sleep(400);
  await p.click('.rx-phone .rt-sos'); await shot('16-sos');
  await p.click('.rx-phone .rx-sheet-bg', { position: { x: 20, y: 20 } }); await sleep(400);
  await p.click('.rx-phone .rt-x-tools .rx-ib'); await shot('17-mapa-grande');
  await p.click('.rx-phone .rx-sheet-bg', { position: { x: 20, y: 20 } }); await sleep(400);
  await p.click('.rx-demo button:has-text("GPS lejos")');
  await salta('V2 · llegada, rumbo a MDE');
  await p.click('.rx-phone .rt-cta .rx-btn.dark'); await shot('18-gps-lejos');
  await ctx.close();
}

// ───────────────────────────── la app
async function app() {
  execFileSync('node', [join(AQUI, '_seed-ruta-v2-local.mjs'), '--propias'], { stdio: 'inherit' });
  const pg = await localClient();
  const legs = (await pg.query(`select ra.direction, rs.stop_order, r.id, r.pickup_latitude lat, r.pickup_longitude lng, r.meet_code
      from route_assignments ra join route_stops rs on rs.route_assignment_id = ra.id join reservations r on r.id = rs.reservation_id
      join driver_profiles dp on dp.id = ra.driver_profile_id join auth.users u on u.id = dp.profile_id
     where u.email = 'carlos.local@rendio.test' and (ra.planned_start_at at time zone 'America/Bogota')::date = (now() at time zone 'America/Bogota')::date
     order by ra.planned_start_at, rs.stop_order`)).rows;
  // Espera de 1 min para poder ver «No se presentó» sin esperar 5 (se restaura al final).
  const [{ aux_wait_minutes: espera0 }] = (await pg.query(`select aux_wait_minutes from app_settings limit 1`)).rows;
  await pg.query(`update app_settings set aux_wait_minutes = 1`);
  const restaura = async () => { try { await pg.query(`update app_settings set aux_wait_minutes = $1`, [espera0]); } catch (e) { /* */ } };
  process.once('SIGTERM', async () => { await restaura(); process.exit(143); });
  process.once('SIGINT', async () => { await restaura(); process.exit(130); });
  try {
  const sal = legs.filter((l) => l.direction === 'home_to_airport');
  const MDE = { latitude: 6.1715, longitude: -75.4270 };
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, geolocation: { latitude: sal[0].lat + 0.01, longitude: sal[0].lng + 0.004 }, permissions: ['geolocation'] });
  const p = await ctx.newPage();
  p.setDefaultTimeout(20000);
  p.on('pageerror', (e) => errores.push(String(e && e.stack || e)));
  p.on('console', (m) => { if (m.type() === 'error' && !/favicon|ERR_|tile\.openstreetmap|router\.project-osrm/i.test(m.text())) errores.push('console: ' + m.text()); });
  await p.goto(APP);
  if (NOCHE) await p.evaluate(() => localStorage.setItem('rendio.driver.theme', 'dark'));
  else await p.evaluate(() => localStorage.removeItem('rendio.driver.theme'));
  await p.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('rendio-rt-v2')) localStorage.removeItem(k); });
  await p.fill('input[type=email]', 'carlos.local@rendio.test');
  await p.fill('input[type=password]', PASS);
  await p.click('button[type=submit]');
  await p.waitForSelector('[data-vuelta]', { timeout: 20000 });
  const shot = async (n) => { anota(n); await sleep(800); await p.screenshot({ path: join(OUT, 'app', n + '.png') }); };
  const ui = (s) => `#driver-ruta-ui ${s}`;
  const top = (s) => `#driver-ruta-ui #rt-layers > .rx-layer:last-child ${s}`;
  await p.click('[data-vuelta]');
  await p.waitForSelector(ui('.rt-hero'));
  await shot('01-mi-dia');
  await p.click(ui('.rt-hero .rt-crew')); await p.waitForSelector(top('.rt-stops'));
  await shot('02-detalle-salida');
  await p.click(top('.rx-foot .rx-btn')); await p.waitForSelector(top('.rt-xs'));
  await shot('03-ejecucion-en-camino');
  // Llega a la casa 1 (GPS en la puerta: no pide confirmar).
  await ctx.setGeolocation({ latitude: sal[0].lat, longitude: sal[0].lng }); await sleep(1500);
  await p.click(top('.rt-cta [data-rt=arrive]')); await p.waitForSelector(top('.rt-wait'));
  await shot('04-en-el-punto-codigo');
  if (await p.$(top('.rt-code-m [data-rt=nc]'))) { await p.click(top('.rt-code-m [data-rt=nc]')); await shot('05-sin-codigo'); await p.click(top('[data-rt=nc-off]')); await sleep(500); }
  // Código bueno → a bordo y a la casa 2.
  if (sal[0].meet_code) { await p.fill(top('.rt-code input'), sal[0].meet_code); await sleep(2500); }
  else { await p.click(top('[data-rt=board]')); await sleep(1500); }
  // Casa 2: llega y espera a que se cumpla el minuto para «No se presentó».
  if (sal[1]) {
    await ctx.setGeolocation({ latitude: sal[1].lat, longitude: sal[1].lng }); await sleep(1500);
    await p.click(top('.rt-cta [data-rt=arrive]')); await p.waitForSelector(top('.rt-wait'));
    await shot('06-espera');
    await p.waitForSelector(top('.rt-link.err[data-rt=noshow]:not([disabled])'), { timeout: 90000 });
    await p.click(top('.rt-link.err[data-rt=noshow]'));
    await p.waitForSelector(ui('#rt-sheet-host .rx-sh')); await shot('07-confirmar-no-show');
    await p.click(ui('#rt-sheet-host [data-rt=noshow-yes]')); await sleep(1500);
  }
  // Casa 3: llega y sube sin código.
  if (sal[2]) {
    await ctx.setGeolocation({ latitude: sal[2].lat, longitude: sal[2].lng }); await sleep(1500);
    await p.click(top('.rt-cta [data-rt=arrive]')); await p.waitForSelector(top('.rt-wait'));
    if (await p.$(top('.rt-code-m [data-rt=nc]'))) { await p.click(top('.rt-code-m [data-rt=nc]')); await sleep(400); }
    await p.click(top('[data-rt=board]')); await sleep(1500);
  }
  await shot('08-rumbo-aeropuerto');
  await ctx.setGeolocation(MDE); await sleep(1500);
  await p.click(top('.rt-cta [data-rt=arrive]')); await sleep(800);
  await shot('09-en-mde-salida');
  await p.click(top('.rt-cta [data-rt=finish]')); await sleep(1200);
  await shot('10-vuelta-completa');
  // Llegada: V2 desde la vuelta completa.
  await p.click(top('.rx-foot [data-rt=nextv]')); await p.waitForSelector(top('.rt-stops'));
  await ctx.setGeolocation({ latitude: 6.20, longitude: -75.45 });
  await p.click(top('.rx-foot .rx-btn')); await p.waitForSelector(top('.rt-xs'));
  await shot('11-llegada-rumbo-mde');
  // GPS lejos → pide confirmar.
  await p.click(top('.rt-cta [data-rt=arrive]')); await p.waitForSelector(ui('#rt-sheet-host .rx-sh'));
  await shot('18-gps-lejos');
  await p.click(ui('#rt-sheet-host [data-rt=sheet-close]')); await sleep(500);
  await ctx.setGeolocation(MDE); await sleep(1500);
  await p.click(top('.rt-cta [data-rt=arrive]')); await p.waitForSelector(top('.rt-cr'));
  await shot('12-lista-aeropuerto');
  await p.click(top('.rt-cr-acts [data-ask=nocode]')); await shot('13-fila-confirmar');
  await p.click(top('.rt-cr-ask [data-rt=ask-no]')); await sleep(300);
  await p.click(top('.rt-cr-acts [data-rt=chat]')); await p.waitForSelector(ui('#rt-sheet-host .rt-chat'));
  await shot('14-chat');
  await p.click(ui('#rt-sheet-host .rx-sheet-bg'), { position: { x: 20, y: 20 } }); await sleep(500);
  await p.click(top('.rt-foot [data-rt=report]')); await sleep(400);
  await p.click(ui('#rt-sheet-host .rt-opt[data-x=tra]')); await shot('15-reportar');
  await p.click(ui('#rt-sheet-host .rx-sheet-bg'), { position: { x: 20, y: 20 } }); await sleep(500);
  await p.click(top('.rt-sos')); await shot('16-sos');
  await p.click(ui('#rt-sheet-host .rx-sheet-bg'), { position: { x: 20, y: 20 } }); await sleep(500);
  await p.click(top('.rt-x-tools [data-rt=bigmap]')); await sleep(3500); await shot('17-mapa-grande');
  await ctx.close();
  } finally { await restaura(); await pg.end(); }
}

try {
  if (SOLO !== 'app') await diseno().catch((e) => { errores.push('diseño: ' + e.message); console.error('diseño:', e.message); });
  if (SOLO !== 'diseno') await app().catch((e) => { errores.push('app: ' + e.message); console.error('app:', e.message); });
} finally { await browser.close(); }

pares.sort((a, b) => a[0].localeCompare(b[0]));
writeFileSync(join(OUT, 'index.html'), `<!doctype html><meta charset=utf-8><title>Ruta v2 · diseño vs app</title>
<style>body{font:14px system-ui;background:#eee;margin:20px}h2{margin:28px 0 8px}div{display:flex;gap:20px;align-items:flex-start}img{width:390px;border:1px solid #ccc;background:#fff}figure{margin:0}figcaption{font-weight:600;margin-bottom:4px}</style>
<h1>Ruta del conductor v2 · ${NOCHE ? 'nocturno' : 'claro'} · ${W}×${H}</h1>
${errores.length ? `<pre style="color:#b00">${errores.map((e) => e.replace(/</g, '&lt;')).join('\n')}</pre>` : '<p>Sin errores de JavaScript.</p>'}
${pares.map(([n]) => `<h2>${n}</h2><div><figure><figcaption>Diseño</figcaption><img src="diseno/${n}.png"></figure><figure><figcaption>App</figcaption><img src="app/${n}.png"></figure></div>`).join('\n')}`);
console.log(`listo · ${OUT}/index.html · ${errores.length} errores`);
if (errores.length) console.log(errores.join('\n'));
