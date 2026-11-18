// Capturas del cambio del 17-nov-2026 (Julián: en las llegadas, solo la hora del vuelo): la tarjeta de
// una llegada en Asignación, en celular y en PC, con la hora pedida, con el vuelo en vivo y ya aterrizado.
// Mismo arranque que _capturas-rutas-v2.mjs (día de PRUEBA, sin red). Escribe en Rendio-Drivers/capturas-hora-vuelo-2026-11-17/.
//   cd rendio-backend && node scripts/_capturas-hora-vuelo-1117.mjs
import { chromium } from '/Users/harold/Documents/Rendio-Drivers/.e2e-tools/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync, statSync, readdirSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const FIX = new URL('./fixtures/rutas-v2-dia.js', import.meta.url).pathname;
const OUT = '/Users/harold/Documents/Rendio-Drivers/capturas-hora-vuelo-2026-11-17/';
const SERVE = '/Users/harold/Documents/Rendio-Drivers/.claude/serve.mjs';
mkdirSync(OUT, { recursive: true });

// 5191 es el puerto de esta tarea; si otra sesión lo tiene ocupado (pasa: hay
// varias copias de trabajo), se prueba el siguiente libre. Lo que se sirve es
// SIEMPRE la carpeta rendio-turnos de esta copia.
async function levantar(port) {
  const p = spawn(process.execPath, [SERVE, APP, String(port), 'nosw'], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((ok) => {
    const t = setTimeout(() => ok(null), 8000);
    p.stdout.on('data', (d) => { if (/http:\/\/localhost/.test(String(d))) { clearTimeout(t); ok(p); } });
    p.on('exit', () => { clearTimeout(t); ok(null); });
  });
}
let PORT = null, srv = null;
for (const port of [5191, 5291, 5391, 5491]) { srv = await levantar(port); if (srv) { PORT = port; break; } }
if (!srv) throw new Error('no hubo puerto libre para el servidor');
console.log('Servidor en', PORT);

// Inyección (corre ANTES que los scripts de la app): cuando api.js publique
// window.Api, se reemplazan las funciones que leen Supabase por las del día de
// prueba, y las demás se envuelven para que sin red devuelvan null en vez de
// reventar el arranque.
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
      // route_traffic_factor 1: la tabla falsa de OSRM y la de «TomTom» dan lo mismo.
      v.getSettings = async () => ({ route_traffic_factor: 1 });
      v.listDrivers = async () => [];
      v.listAdmins = async () => [];
      v.listDriverRules = async () => [];
      window.__rv2log = window.RV2Fixture.instalar(v);
      real = v;
    },
  });
};

const browser = await chromium.launch();
const medidas = [];
const errores = [];

async function abrir(width, height) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, locale: 'es-CO', timezoneId: 'America/Bogota', hasTouch: width < 768, isMobile: width < 768 });
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
  await page.waitForTimeout(350);
  return { ctx, page };
}
const shot = async (page, name) => { await page.waitForTimeout(320); await page.screenshot({ path: OUT + name }); };
async function medir(page, etiqueta) {
  const m = await page.evaluate(() => {
    const r = document.querySelector('#routes-v2');
    const main = document.querySelector('#app-main');
    const lw = document.querySelector('#rv2-listwrap');
    const fila = document.querySelector('#rv2-list .rv2-row');
    const sobra = (el) => (el ? el.scrollWidth - el.clientWidth : null);
    // Botones visibles de menos de 44 px de alto (solo importa en el celular).
    const chicos = [...document.querySelectorAll('#routes-v2 button, #routes-v2 a.rv2-ic, .rv2-sheet button')]
      .filter((b) => { const s = b.getBoundingClientRect(); return s.width > 0 && s.height > 0 && getComputedStyle(b).visibility !== 'hidden'; })
      .filter((b) => b.getBoundingClientRect().height < 44)
      .map((b) => (b.id || b.className || b.tagName) + ':' + Math.round(b.getBoundingClientRect().height));
    return {
      ancho: r.clientWidth, lay: r.dataset.lay, fila: r.dataset.fila, det: r.dataset.det,
      desbordePagina: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      desbordeMain: sobra(main), desbordeLista: sobra(lw),
      filaCabe: fila ? fila.scrollWidth <= fila.clientWidth + 1 : null,
      fuente: getComputedStyle(document.querySelector('#routes-v2 .rv2-title')).fontFamily,
      chicos: chicos.slice(0, 12), nChicos: chicos.length,
    };
  });
  medidas.push({ etiqueta, ...m });
}


const ID = 'V-01·V3';
const vivo = async (page, extra) => {
  await page.evaluate(([id, extra]) => {
    const fila = document.querySelector(`#rv2-list .rv2-row[data-id="${id}"]`);
    const cod = ((fila && fila.querySelector('.rv2-p .org') || {}).textContent || '').replace(/[()\s-]/g, '').toUpperCase();
    const R = window.RendioVuelos;
    if (!window.__para0) window.__para0 = R.para;
    R.para = extra ? ((c) => (String(c).replace(/[\s-]/g, '').toUpperCase() === cod ? Object.assign({ code: cod, direction: 'airport_to_home', schedAt: '2026-10-12T15:00:00-05:00' }, extra) : null)) : window.__para0;
    window.RendioRutasV2.render();
    const f2 = document.querySelector(`#rv2-list .rv2-row[data-id="${id}"]`);
    if (f2) f2.scrollIntoView({ block: 'center' });
  }, [ID, extra]);
  await page.waitForTimeout(250);
};
const leerFila = (page) => page.evaluate((id) => { const f = document.querySelector(`#rv2-list .rv2-row[data-id="${id}"]`); const w = f && f.querySelector('.when'); const r = f && f.getBoundingClientRect();
  return f ? { cuando: [...w.children].map((x) => x.textContent).join(' | '), chips: [...f.querySelectorAll('.rv2-p')].map((x) => x.textContent.replace(/\s+/g, ' ').trim()), encabezado: (f.closest('.rv2-gwrap').querySelector('.rv2-hour') || {}).textContent, ancho: Math.round(r.width), cabe: f.scrollWidth <= f.clientWidth + 1, whenAncho: Math.round(w.getBoundingClientRect().width), whenCabe: w.scrollWidth <= w.clientWidth + 1 } : null; }, ID);
for (const [w, h, pre] of [[390, 844, 'cel'], [1440, 900, 'pc']]) {
  const { ctx, page } = await abrir(w, h);
  await vivo(page, null);
  await shot(page, `${pre}-1-hora-pedida.png`); console.log(pre, 'pedida   ', JSON.stringify(await leerFila(page)));
  await vivo(page, { status: 'in_air', delayMin: 39, estimatedAt: '2026-10-12T15:39:00-05:00' });
  await shot(page, `${pre}-2-en-vuelo-tarde.png`); console.log(pre, 'en vuelo ', JSON.stringify(await leerFila(page)));
  await vivo(page, { status: 'landed', delayMin: 41, actualAt: '2026-10-12T15:41:00-05:00' });
  await shot(page, `${pre}-3-aterrizo.png`); console.log(pre, 'aterrizó ', JSON.stringify(await leerFila(page)));
  await page.click(`#rv2-list .rv2-row[data-id="${ID}"] .when`);
  await page.waitForTimeout(500);
  await shot(page, `${pre}-4-detalle.png`);
  await ctx.close();
}
console.log('errores de página:', errores.length ? errores : 'ninguno');
await browser.close();
srv.kill();
