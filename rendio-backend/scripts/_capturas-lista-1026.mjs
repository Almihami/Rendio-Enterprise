// Capturas con Chromium de verdad (Playwright) de lo nuevo de la lista de los
// jefes del 26-oct-2026, en el celular (390×844) y en el PC (1440×900), con las
// medidas que jsdom no da (desbordes, alto de los botones, si el pie de la hoja
// cabe). Mismo montaje que _capturas-rutas-v2.mjs: servidor estático local, modo
// `#preview-admin`, el día de PRUEBA de fixtures/rutas-v2-dia.js y la red cortada.
//
//   cd rendio-backend && node scripts/_capturas-lista-1026.mjs [carpeta]
//
// Lo que captura: «✓ N vueltas terminadas», la tarjeta Conductores con «Carro N»,
// la hoja de la vuelta con «Solo en el tablero / Guardar y publicar», «Delegar a…»
// (libreta y a mano), «¿Qué carro es…?», Reservas con «Late» y la revisión de la
// ruta de Julián con «Va sin cuenta».
import { chromium } from '/Users/harold/Documents/Rendio-Drivers/.e2e-tools/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const FIX = new URL('./fixtures/rutas-v2-dia.js', import.meta.url).pathname;
const OUT = (process.argv[2] || new URL('./_capturas-lista-1026/', import.meta.url).pathname).replace(/\/?$/, '/');
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
for (const port of [5195, 5295, 5395, 5495]) { srv = await levantar(port); if (srv) { PORT = port; break; } }
if (!srv) throw new Error('no hubo puerto libre para el servidor');

const INYECCION = () => {
  let real;
  window.RV2Fixture.instalarFetch(window);
  Object.defineProperty(window, 'Api', {
    configurable: true,
    get() { return real; },
    set(v) {
      Object.keys(v).forEach((k) => {
        const f = v[k];
        if (typeof f === 'function' && f.constructor && f.constructor.name === 'AsyncFunction') {
          v[k] = async (...a) => { try { return await f(...a); } catch (_) { return null; } };
        }
      });
      v.getSettings = async () => ({ route_traffic_factor: 1 });
      v.listDrivers = async () => [];
      v.listAdmins = async () => [];
      v.listDriverRules = async () => [];
      window.__rv2log = window.RV2Fixture.instalar(v);
      // Lo nuevo (0129–0133), con datos de prueba.
      v.setVueltaDriver = async () => ({ status: 'planned', notified: 2 });
      v.delegateRoute = async (ra, n, p) => ({ delegated: true, name: n, phone: p, notified: 1 });
      v.listDelegateContacts = async () => [{ id: 'c1', name: 'Uber de Camilo', phone: '311 222 3344' }, { id: 'c2', name: 'Pedro Gómez Restrepo', phone: '310 999 8877' }];
      v.listVehiclesForShift = async () => [
        { id: 'veh-prw', internal_code: 'PRW443', license_plate: 'PRW443', brand: 'Hyundai', model: 'H1', capacity: 4, status: 'available' },
        { id: 'veh-hyu', internal_code: 'HYU376', license_plate: 'HYU376', brand: 'Hyundai', model: 'H1', capacity: 4, status: 'in_use' },
        { id: 'veh-zzz', internal_code: 'ZZZ999', license_plate: 'ZZZ999', brand: 'Chevrolet', model: 'N300', capacity: 6, status: 'available' }];
      v.setPlanCarVehicle = async () => 2;
      v.getRequestCutoff = async () => ({ corte: 1180, noche: 120, enBase: true });
      v.listResidencesAdmin = async () => [{ id: 'res-mota', name: 'Mota', is_active: true }];
      const B = (s) => new Date(s + '-05:00').toISOString();
      const R = (id, dir, when, creada, nombre) => ({ id, type: dir, name: nombre, when: B(when), createdAt: B(creada), status: 'pending', address: 'El Olivar · Rionegro', flight: dir === 'lle' ? 'AV9563' : '', time: when.slice(11, 16) });
      v.listReservationsAdmin = async () => [R('a1', 'sal', '2026-11-02T06:00:00', '2026-11-01T10:00:00', 'Laura Gómez'), R('a2', 'lle', '2026-11-02T15:00:00', '2026-11-01T21:05:00', 'Kevin Uribe'), R('a3', 'sal', '2026-11-02T09:00:00', '2026-11-01T19:41:00', 'Sara Ríos')];
      real = v;
    },
  });
};

const browser = await chromium.launch();
const medidas = [], errores = [];
async function abrir(width, height) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, locale: 'es-CO', timezoneId: 'America/Bogota', hasTouch: width < 768, isMobile: width < 768 });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(`http://localhost:${PORT}`) || /fonts\.(googleapis|gstatic)\.com/.test(u)) return route.continue();
    return route.abort();
  });
  await ctx.addInitScript({ path: FIX });
  await ctx.addInitScript(INYECCION);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errores.push(`${width}: ${e.message}`));
  await page.goto(`http://localhost:${PORT}/#preview-admin`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('#app-shell.admin-shell') && typeof window.setTab === 'function', null, { timeout: 15000 });
  await page.evaluate(() => window.setTab('routes'));
  await page.waitForSelector('#rv2-list .rv2-row', { timeout: 15000 });
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await page.waitForTimeout(400);
  return { ctx, page };
}
const shot = async (page, name, sel) => {
  await page.waitForTimeout(350);
  if (sel) { const el = await page.$(sel); if (el) { await el.scrollIntoViewIfNeeded(); await page.waitForTimeout(150); await el.screenshot({ path: OUT + name }); return; } }
  await page.screenshot({ path: OUT + name });
};
const medir = async (page, etiqueta, sel) => {
  const m = await page.evaluate((s) => {
    const el = document.querySelector(s);
    const pagina = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    if (!el) return { falta: s, pagina };
    const sobra = el.scrollWidth - el.clientWidth;
    const chicos = [...el.querySelectorAll('button, input, select, a')].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 44; })
      .map((b) => (b.id || b.dataset.act || b.dataset.pick || b.dataset.dpick || b.dataset.pcar || b.className || b.tagName).toString().slice(0, 24) + ':' + Math.round(b.getBoundingClientRect().height));
    const foot = el.querySelector('.rv2-sh-foot');
    const pie = foot ? { sobra: foot.scrollWidth - foot.clientWidth, botones: [...foot.querySelectorAll('button')].map((b) => Math.round(b.getBoundingClientRect().width) + '×' + Math.round(b.getBoundingClientRect().height) + ' «' + b.textContent.trim().slice(0, 22) + '»') } : null;
    return { pagina, sobra, pie, chicos: chicos.slice(0, 8), nChicos: chicos.length };
  }, sel);
  medidas.push({ etiqueta, ...m });
};

for (const [w, h, tag] of [[390, 844, 'cel'], [1440, 900, 'pc']]) {
  const { ctx, page } = await abrir(w, h);
  // 1. Las terminadas, recogidas al final.
  await shot(page, `${tag}-01-terminadas.png`, '#rv2-list .rv2-hechas');
  await medir(page, `${tag} terminadas`, '#rv2-list');
  // 2. Conductores con «Carro N».
  await shot(page, `${tag}-02-conductores.png`, '#rv2-drivers');
  await medir(page, `${tag} conductores`, '#rv2-drivers');
  // 3. La hoja de la vuelta con «Guardar y publicar».
  const id = await page.evaluate(() => { const r = [...document.querySelectorAll('#rv2-list .rv2-row')].find((x) => x.querySelector('.drv:not(.none)')); return r && r.dataset.id; });
  await page.evaluate((i) => { const r = document.querySelector(`#rv2-list .rv2-row[data-id="${i}"]`); r && r.click(); }, id);
  await page.waitForTimeout(300);
  await page.evaluate((i) => { const b = document.querySelector(`#routes-v2 [data-act="assign"][data-id="${i}"]`); b && b.click(); }, id);
  await page.waitForTimeout(400);
  await page.evaluate(() => { const o = [...document.querySelectorAll('#rv2-sheet [data-pick]')].find((x) => !x.disabled && !x.dataset.pick.startsWith('__')); o && o.click(); });
  await shot(page, `${tag}-03-hoja-guardar-y-publicar.png`);
  await medir(page, `${tag} hoja vuelta`, '#rv2-sheet');
  // 4. «Delegar a…» con la libreta, y a mano.
  await page.evaluate(() => { const o = document.querySelector('#rv2-sheet [data-pick="__deleg"]'); o && o.click(); });
  await page.evaluate(() => { const b = document.querySelector('#rv2-doPub'); b && b.click(); });
  await page.waitForTimeout(500);
  await shot(page, `${tag}-04-delegar-libreta.png`);
  await medir(page, `${tag} delegar libreta`, '#rv2-sheet');
  await page.evaluate(() => { const b = document.querySelector('#rv2-dlg [data-dpick="nuevo"]'); b && b.click(); });
  await page.fill('#rv2-dlg-n', 'Taxi Rionegro').catch(() => {});
  await page.fill('#rv2-dlg-p', '604 555 1234').catch(() => {});
  await shot(page, `${tag}-05-delegar-a-mano.png`);
  await medir(page, `${tag} delegar a mano`, '#rv2-sheet');
  await page.evaluate(() => { const b = document.querySelector('#rv2-sheet [data-act="sclose"]'); b && b.click(); });
  await page.waitForTimeout(300);
  // 5. «¿Qué carro es…?»
  await page.evaluate(() => { const b = document.querySelector('#rv2-drivers [data-act="plancar"]'); b && b.click(); });
  await page.waitForTimeout(500);
  await shot(page, `${tag}-06-que-carro.png`);
  await medir(page, `${tag} qué carro`, '#rv2-sheet');
  await page.evaluate(() => { const b = document.querySelector('#rv2-sheet [data-act="sclose"]'); b && b.click(); });
  // 6. Reservas con «Late».
  await page.evaluate(() => window.setTab('reservas'));
  await page.waitForTimeout(700);
  await shot(page, `${tag}-07-reservas-late.png`, '#rv-ui');
  await medir(page, `${tag} reservas`, '#rv-ui .rv-tools');
  await ctx.close();
}
await browser.close();
srv.kill();
console.log(JSON.stringify(medidas, null, 1));
console.log('errores de página:', errores.length ? errores.join(' | ') : 'ninguno');
console.log('capturas en', OUT);
