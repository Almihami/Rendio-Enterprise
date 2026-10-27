// Capturas con Chromium de verdad (Playwright) de 0151 en la app del CONDUCTOR
// (27-oct-2026): «Vueltas para tomar» con una que se cruza (ahora sí se toma), y su
// LLEGADA que no ha salido de JMC con «Agregar a alguien» y «Soltar», y la hoja de
// a quién puede montar. Y en ASIGNACIÓN, «Dejarla para tomar» y cómo se ve la fila.
// Celular 390×844 (el conductor) y PC 1440×900 (Asignación). Datos de prueba, sin red.
//
//   cd rendio-backend && node scripts/_capturas-conductor-0151.mjs [carpeta]
import { chromium } from '/Users/harold/Documents/Rendio-Drivers/.e2e-tools/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const FIX = new URL('./fixtures/rutas-v2-dia.js', import.meta.url).pathname;
const OUT = (process.argv[2] || '/Users/harold/Documents/Rendio-Drivers/capturas-para-tomar-2026-10-27/').replace(/\/?$/, '/');
const SERVE = '/Users/harold/Documents/Rendio-Drivers/.claude/serve.mjs';
mkdirSync(OUT, { recursive: true });

async function levantar(port) {
  const p = spawn(process.execPath, [SERVE, APP, String(port), 'nosw'], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((ok) => {
    const t = setTimeout(() => ok(null), 8000);
    p.stdout.on('data', (d) => { if (/http:\/\/localhost/.test(String(d))) { clearTimeout(t); ok(p); } });
    p.on('exit', () => { clearTimeout(t); ok(null); });
  });
}
let PORT = null, srv = null;
for (const port of [5241, 5341, 5441, 5541]) { srv = await levantar(port); if (srv) { PORT = port; break; } }
if (!srv) throw new Error('no hubo puerto libre');

const INYECCION = () => {
  let real;
  const NOW = Date.now(), MIN = 60000, iso = (m) => new Date(NOW + m * MIN).toISOString();
  const dia = (m) => new Date(NOW + m * MIN).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  const hm = (m) => new Date(NOW + m * MIN).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false });
  if (window.RV2Fixture) window.RV2Fixture.instalarFetch(window);
  Object.defineProperty(window, 'Api', {
    configurable: true,
    get() { return real; },
    set(v) {
      Object.keys(v).forEach((k) => {
        const f = v[k];
        if (typeof f === 'function' && f.constructor && f.constructor.name === 'AsyncFunction') v[k] = async (...a) => { try { return await f(...a); } catch (_) { return null; } };
      });
      v.getSettings = async () => ({ route_traffic_factor: 1, _loaded: true });
      v.listDrivers = async () => []; v.listAdmins = async () => []; v.listDriverRules = async () => [];
      if (window.RV2Fixture) window.__rv2log = window.RV2Fixture.instalar(v);
      const leg = (o) => Object.assign({ kind: 'dropoff', lat: 6.15, lng: -75.37, addr: 'El Olivar', unit: '', flight: 'AV9384', dl: '', phone: '', notes: '', bags: null, quiet: false, meetCode: '12', meetingPoint: '', level: 'shared', privateStatus: null, stopStatus: 'pending', pickup: '', eta: '' }, o);
      const APT = { kind: 'airport', name: 'Aeropuerto JMC', addr: 'Terminal', lat: 6.1715, lng: -75.427 };
      v.listMyVueltasForDriver = async () => [
        { id: 'V1', type: 'lle', start: hm(30), startAt: iso(30), done: false, assignmentId: 'A1', day: dia(30), opDay: dia(0),
          legs: [APT, leg({ name: 'Margy Evans Simanca', reservationId: 'R1', stopId: 'S1', addr: 'Riovivo', reqDay: dia(20), reqAt: iso(20) }),
            leg({ name: 'Sara Vanessa Londoño Quintero', reservationId: 'R2', stopId: 'S2', addr: 'Ébano', flight: 'AV9358', reqDay: dia(25), reqAt: iso(25) })] },
      ];
      v.getMyDriverProfileId = async () => 'DP1';
      v.driverOpenRoutes = async () => [
        { id: 'P1', direction: 'airport_to_home', planned_start_at: iso(40), stops: [{ name: 'Leslie Acosta Arango', place: 'Ébano', at: iso(40), guest: false }], cruza: true },
        { id: 'P2', direction: 'airport_to_home', planned_start_at: iso(150), stops: [{ name: 'Henry Gómez', place: 'Mota', at: iso(150), guest: false }], cruza: false },
      ];
      v.driverLlegadaCandidatos = async () => [
        { rid: 'R9', name: 'Ana Ríos Prueba', hora: hm(35), vuelo: 'AV9384', destino: 'Ébano', actual: 'Lennin V.' },
        { rid: 'R8', name: 'Tomás Gil Prueba', hora: hm(45), vuelo: 'P57298', destino: 'Mota', actual: 'Sin carro' },
        { rid: 'R7', name: 'Paula Londoño', hora: hm(50), vuelo: '', destino: 'Hotel Río Verde', actual: 'Para tomar' },
      ];
      v.countUnreadMessages = async () => ({});
      real = v;
    },
  });
};

const browser = await chromium.launch();
const errores = [], medidas = [];
async function abrir(width, height, rol, conFixture) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, locale: 'es-CO', timezoneId: 'America/Bogota', hasTouch: width < 768, isMobile: width < 768 });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(`http://localhost:${PORT}`) || /fonts\.(googleapis|gstatic)\.com/.test(u)) return route.continue();
    return route.abort();
  });
  if (conFixture) await ctx.addInitScript({ path: FIX });
  await ctx.addInitScript(INYECCION);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errores.push(`${rol} ${width}: ${e.message}`));
  await page.goto(`http://localhost:${PORT}/#preview-${rol}`, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  return { ctx, page };
}
const shot = async (page, name, sel) => {
  await page.waitForTimeout(400);
  if (sel) { const el = await page.$(sel); if (el) { await el.scrollIntoViewIfNeeded(); await page.waitForTimeout(150); await el.screenshot({ path: OUT + name }); return; } }
  await page.screenshot({ path: OUT + name });
};
const desborde = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

// ── Conductor (celular) ──
{
  const { ctx, page } = await abrir(390, 844, 'driver', false);
  await page.evaluate(async () => { if (window.DriverRutas) await window.DriverRutas.open({ id: 'preview-driver', full_name: 'Conductor Demo', role: 'driver' }); });
  await page.waitForTimeout(900);
  await page.evaluate(() => { const l = document.querySelector('.rt-libre'); if (l) l.scrollIntoView({ block: 'center' }); });
  await shot(page, 'cel-01-vueltas-para-tomar.png');
  medidas.push({ etiqueta: 'para tomar', tomar: await page.$$eval('.rt-libre [data-rt="take"]', (x) => x.length), cruza: await page.$$eval('.rt-libre [data-cruza="1"]', (x) => x.length), desborde: await desborde(page) });
  await page.evaluate(() => { const c = [...document.querySelectorAll('#driver-ruta-root [data-rt="detail"]')].find((x) => x.dataset.v === 'V1'); if (c) c.click(); });
  await page.waitForTimeout(900);
  await page.evaluate(() => { const s = document.querySelector('.rt-stops'); if (s) s.scrollIntoView({ block: 'start' }); });
  await shot(page, 'cel-02-llegada-agregar-soltar.png');
  medidas.push({ etiqueta: 'llegada', agregar: await page.$$eval('[data-rt="addpax"]', (x) => x.length), soltar: await page.$$eval('[data-rt="droppax"]', (x) => x.length), desborde: await desborde(page) });
  await page.evaluate(() => { const b = document.querySelector('[data-rt="addpax"]'); if (b) b.click(); });
  await page.waitForTimeout(900);
  await shot(page, 'cel-03-agregar-a-tu-llegada.png');
  medidas.push({ etiqueta: 'hoja agregar', filas: await page.$$eval('#rt-sheet-host .rt-addpax', (x) => x.length) });
  await ctx.close();
}
// ── Asignación (PC y celular) ──
for (const [w, h, tag] of [[1440, 900, 'pc'], [390, 844, 'cel']]) {
  const { ctx, page } = await abrir(w, h, 'admin', true);
  await page.waitForFunction(() => typeof window.setTab === 'function', null, { timeout: 15000 });
  await page.evaluate(() => window.setTab('routes'));
  await page.waitForSelector('#rv2-list .rv2-row', { timeout: 15000 });
  await page.waitForTimeout(600);
  const id = await page.evaluate(() => { const R = window.rt || (typeof rt !== 'undefined' ? rt : null); const l = R.lanes.find((x) => x.type === 'lle' && !(R.rv2Fijas || {})[x.id] && (R.order[x.id] || []).length); return l && l.id; });
  await page.evaluate((i) => { document.querySelector(`#rv2-list .rv2-row[data-id="${i}"]`).click(); }, id);
  await page.waitForTimeout(600);
  await page.evaluate((i) => { const b = document.querySelector(`#routes-v2 [data-act="assign"][data-id="${i}"]`); if (b) b.click(); }, id);
  await page.waitForTimeout(500);
  await page.evaluate(() => { const o = document.querySelector('#rv2-sheet [data-pick="__tomar"]'); if (o) { o.click(); o.scrollIntoView({ block: 'center' }); } });
  await shot(page, `${tag}-04-dejarla-para-tomar.png`);
  await page.evaluate(() => { const b = document.querySelector('#rv2-doAssign'); if (b) b.click(); });
  await page.waitForTimeout(500);
  await page.evaluate(() => { const c = document.querySelector('[data-act="close"]'); if (c && window.innerWidth < 768) c.click(); });
  await page.waitForTimeout(300);
  await shot(page, `${tag}-05-fila-para-tomar.png`, `#rv2-list .rv2-row[data-id="${id}"]`);
  medidas.push({ etiqueta: tag + ' fila', texto: await page.$eval(`#rv2-list .rv2-row[data-id="${id}"]`, (r) => r.textContent.replace(/\s+/g, ' ').trim().slice(0, 140)), desborde: await desborde(page) });
  await ctx.close();
}
await browser.close();
srv.kill();
console.log(JSON.stringify(medidas, null, 1));
console.log('errores de página:', errores.length ? errores.join(' | ') : 'ninguno');
console.log('capturas en', OUT);
