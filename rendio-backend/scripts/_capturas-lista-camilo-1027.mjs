// Capturas con Chromium de verdad (Playwright) de la LISTA DE CAMILO (27-oct-2026):
// Avisos más bajos y Conductores sin descripción, «Cambiar hora» en cada vuelta,
// el Excel que pregunta de qué día, «Elige quién es» al pegar, y los conductores de
// confianza al delegar. Base: el montaje de PEGAR = LLENAR EL TABLERO
// (27-oct-2026). La profa: «esas tarjetas son diferentes, no se puede ver el
// trayecto… no debemos generar esas discrepancias». Lo que se mira: después de
// pegar la ruta del jefe, cada vuelta es una fila del tablero como las demás, y
// al abrirla se ve el detalle de siempre (paradas, horas, mapa del trayecto). Y la
// hoja de Publicar de siempre.
// En el celular (390×844) y en el PC (1440×900). Mismo montaje que
// _capturas-julian-lista-1026.mjs: servidor estático local, `#preview-admin`, el
// día de PRUEBA de fixtures/rutas-v2-dia.js y la red cortada.
//
//   cd rendio-backend && node scripts/_capturas-pegar-tablero-1027.mjs [carpeta]
import { chromium } from '/Users/harold/Documents/Rendio-Drivers/.e2e-tools/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const FIX = new URL('./fixtures/rutas-v2-dia.js', import.meta.url).pathname;
const OUT = (process.argv[2] || new URL('./_capturas-lista-camilo-1027/', import.meta.url).pathname).replace(/\/?$/, '/');
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
for (const port of [5198, 5298, 5398, 5498]) { srv = await levantar(port); if (srv) { PORT = port; break; } }
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
      v.listCrewAliases = async () => [];
      v.listDelegateContacts = async () => [{ id: 'c1', name: 'Uber de Camilo', phone: '311 222 3344' }, { id: 'c2', name: 'Pedro Gómez', phone: '310 999 8877' }];
      v.removeDelegateContact = async () => {};
      v.saveDelegateContact = async () => 'c3';
      v.saveCrewAliases = async (a) => a.length;
      v.listResidencesAdmin = async () => [{ id: 'res-mota', name: 'Mota', is_active: true, latitude: 6.155, longitude: -75.374, zona_jefe: 'Rionegro' }];
      const plan0 = v.listRoutePlanning;
      v.listRoutePlanning = async (t, d) => {
        const x = await plan0(t, d);
        if (x) Object.keys(x.aux).forEach((k) => { x.aux[k].auxId = 'aux-' + k; });
        return x;
      };
      real = v;
    },
  });
};

const TEXTO = [
  '5:30 José (Cerezos)', '5:40 Cami (Ébano)', 'Deben estar 6:10', '',
  '8:20 Pepe (Mota)', 'Deben estar 8:50', '',
  '10:30 Felipe (Altos del lago)', '10:35 Juan', '', '14:40 Natalia (AV9412)',
].join('\n');

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
  await page.waitForTimeout(500);
  return { ctx, page };
}
const shot = async (page, name, sel, full) => {
  await page.waitForTimeout(350);
  if (sel) { const el = await page.$(sel); if (el) { await el.scrollIntoViewIfNeeded(); await page.waitForTimeout(150); await el.screenshot({ path: OUT + name }); return; } }
  await page.screenshot({ path: OUT + name, fullPage: !!full });
};
const alto = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().height) : null; }, sel);
const cerrar = (page) => page.evaluate(() => { const b = document.querySelector('#rv2-sheet [data-act="sclose"]'); if (b) b.click(); });

for (const [w, h, tag] of [[390, 844, 'cel'], [1440, 900, 'pc']]) {
  const { ctx, page } = await abrir(w, h);
  // 1. Arriba: Avisos y Conductores.
  await page.evaluate(() => { const m = document.querySelector('#app-main'); if (m) m.scrollTop = 0; window.scrollTo(0, 0); });
  await shot(page, `${tag}-01-avisos-conductores.png`, '#rv2-summary');
  medidas.push({ etiqueta: `${tag} alto`, avisos: await alto(page, '#rv2-avisos'), conductores: await alto(page, '#rv2-drivers'), lista: await alto(page, '#rv2-avisos .rv2-al'), pagina: await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) });
  // 2. Filas con «Cambiar hora».
  const id = await page.evaluate(() => { const b = document.querySelector('#rv2-list .rv2-row [data-act="hora"]'); return b ? b.dataset.id : null; });
  await shot(page, `${tag}-02-fila-cambiar-hora.png`, `#rv2-list .rv2-row[data-id="${id}"]`);
  medidas.push({ etiqueta: `${tag} filas con Cambiar hora`, n: await page.$$eval('#rv2-list .rv2-row [data-act="hora"]', (x) => x.length), filas: await page.$$eval('#rv2-list .rv2-row', (x) => x.length) });
  // 3. La hoja «Cambiar hora».
  await page.evaluate((i) => document.querySelector(`#rv2-list .rv2-row [data-act="hora"][data-id="${i}"]`).click(), id);
  await page.waitForSelector('#rv2-sheet .rj-h-in', { timeout: 5000 });
  await shot(page, `${tag}-03-hoja-cambiar-hora.png`);
  await cerrar(page); await page.waitForTimeout(300);
  // 4. Excel: pregunta de qué día.
  await page.evaluate(() => document.querySelector('#rv2-xlsx').click());
  await page.waitForTimeout(400);
  await shot(page, `${tag}-04-excel-que-dia.png`);
  medidas.push({ etiqueta: `${tag} excel`, opciones: await page.$$eval('#rv2-sheet [data-rj="xl"]', (x) => x.map((b) => b.textContent.replace(/\s+/g, ' ').trim())) });
  await cerrar(page); await page.waitForTimeout(300);
  // 5. Pegar: «Elige quién es» y las opciones nuevas.
  await page.evaluate(() => document.querySelector('#rv2-julian').click());
  await page.waitForSelector('#rj-ta', { timeout: 5000 });
  await page.fill('#rj-ta', TEXTO);
  await page.evaluate(() => document.querySelector('#rv2-sheet [data-rj="leer"]').click());
  await page.waitForSelector('#rj-prev .rj-b', { timeout: 5000 });
  await page.waitForTimeout(300);
  await shot(page, `${tag}-05-pegar-elige-quien.png`);
  medidas.push({ etiqueta: `${tag} pegar`, boton: await page.$eval('#rv2-sheet [data-rj="publicar"]', (b) => b.textContent.trim() + (b.disabled ? ' (apagado)' : '')),
    opciones: await page.$$eval('#rj-prev .rj-p[data-st="falta"] select option', (x) => x.slice(0, 4).map((o) => o.textContent.trim())) });
  await cerrar(page); await page.waitForTimeout(300);
  // 6. Delegar: conductores de confianza.
  await page.evaluate((i) => document.querySelector(`#rv2-list .rv2-row[data-id="${i}"]`).click(), id);
  await page.waitForTimeout(600);
  await shot(page, `${tag}-06-detalle-con-cambiar-hora.png`);
  await page.evaluate(() => document.querySelector('#rv2-detail [data-act="assign"]').click());
  await page.waitForSelector('#rv2-sheet [data-pick="__deleg"]', { timeout: 5000 });
  await page.evaluate(() => document.querySelector('#rv2-sheet [data-pick="__deleg"]').click());
  await page.evaluate(() => document.querySelector('#rv2-doAssign').click());
  await page.waitForSelector('#rv2-dlg', { timeout: 5000 });
  await page.evaluate(() => document.querySelector('#rv2-dlg [data-dpick="nuevo"]').click());
  await page.waitForTimeout(300);
  await shot(page, `${tag}-07-delegar-confianza.png`);
  await ctx.close();
}
await browser.close();
srv.kill();
console.log(JSON.stringify(medidas, null, 1));
console.log('errores de página:', errores.length ? errores.join(' | ') : 'ninguno');
console.log('capturas en', OUT);
