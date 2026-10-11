// Capturas de Rutas › Asignación v2 con Chromium de verdad (Playwright), en
// 1440×900, 1024×768 y 390×844, y medidas de layout que jsdom no puede dar.
//
// Levanta el servidor estático de siempre (.claude/serve.mjs, puerto 5191, sin
// service worker), abre la app en el modo local `#preview-admin` y le inyecta
// el día de PRUEBA de fixtures/rutas-v2-dia.js reemplazando SOLO funciones de
// window.Api desde el script de prueba. La red hacia Supabase, OSRM y los
// mapas se corta: nada sale del equipo y la app real no se toca.
//
// Escribe las capturas en scripts/_capturas-v2/ y al final imprime las
// medidas (desbordes horizontales, alto de los botones en el celular, modo
// de diseño elegido para cada ancho).
//
//   cd rendio-backend && node scripts/_capturas-rutas-v2.mjs
import { chromium } from '/Users/harold/Documents/Rendio-Drivers/.e2e-tools/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync, statSync, readdirSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const FIX = new URL('./fixtures/rutas-v2-dia.js', import.meta.url).pathname;
const OUT = new URL('./_capturas-v2/', import.meta.url).pathname;
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

// ── PC 1440×900 ────────────────────────────────────────────────────────────
{
  const { ctx, page } = await abrir(1440, 900);
  await medir(page, 'pc lista+detalle');
  await shot(page, '01-pc-lista-detalle.png');
  await page.click('#rv2-detail [data-act="apply"]');
  await shot(page, '02-pc-sugerencia-aplicada.png');
  await page.click('#rv2-toast [data-act="undo"]');
  await page.click('#rv2-chips [data-k="unrouted"]');
  await page.click('#rv2-list [data-act="route"][data-crew="rN"]');
  await shot(page, '03-pc-rutear.png');
  await page.click('#rv2-sheet [data-act="sclose"]');
  await page.click('#rv2-chips [data-k="nodriver"]');
  await page.click('.rv2-row[data-id="V-01·V3"] [data-act="assign"]');
  await shot(page, '04-pc-asignar-conductor.png');
  await page.click('#rv2-sheet [data-act="sclose"]');
  await page.click('#rv2-chips [data-k="all"]');
  await page.click('.rv2-seg [data-view="carros"]');
  await medir(page, 'pc carros');
  await shot(page, '05-pc-vista-carros.png');
  await page.click('.rv2-seg [data-view="lista"]');
  await page.click('#rv2-publish');
  await page.click('#rv2-forceOpen');
  await shot(page, '06-pc-publicar.png');
  await page.click('#rv2-sheet [data-act="sclose"]');
  // Con el menú lateral plegado (72 px) el ancho alcanza para la fila completa.
  await page.evaluate(() => document.querySelector('#app-shell').classList.add('collapsed'));
  await page.waitForTimeout(300);
  await medir(page, 'pc menú plegado');
  await shot(page, '07-pc-menu-plegado.png');
  await page.evaluate(() => document.querySelector('#app-shell').classList.remove('collapsed'));
  // La vista anterior sigue ahí (enlace discreto) y vuelve con «Vista nueva».
  await page.click('#routes-v2 [data-act="vista"][data-v="v1"]');
  await page.waitForTimeout(300);
  await shot(page, '16-pc-vista-anterior.png');
  await page.click('#rt-vistaNueva');
  await page.waitForSelector('#rv2-list .rv2-row');
  await ctx.close();
}
// ── PC grande 1920×1080 (el ancho de las capturas del diseñador) ─────────────
{
  const { ctx, page } = await abrir(1920, 1080);
  await medir(page, 'pc 1920');
  await shot(page, '08-pc-1920.png');
  await ctx.close();
}
// ── Tablet 1024×768 ────────────────────────────────────────────────────────
{
  const { ctx, page } = await abrir(1024, 768);
  await medir(page, 'tablet lista');
  await shot(page, '09-tablet-lista.png');
  await page.click('.rv2-row[data-id="V-01·V2"]');
  await shot(page, '10-tablet-cajon.png');
  await page.keyboard.press('Escape');
  await ctx.close();
}
// ── Celular 390×844 ────────────────────────────────────────────────────────
{
  const { ctx, page } = await abrir(390, 844);
  await medir(page, 'cel lista');
  await shot(page, '11-cel-lista.png');
  await page.click('.rv2-row[data-id="V-01·V2"]');
  await medir(page, 'cel detalle');
  await shot(page, '12-cel-detalle.png');
  await page.click('#rv2-detail .rv2-stops [data-act="move"][data-crew="rC"]');
  await medir(page, 'cel mover');
  await shot(page, '13-cel-mover-a.png');
  await page.click('#rv2-sheet [data-act="sclose"]');
  await page.click('#rv2-detail .rv2-back');
  await page.click('#rv2-publishM');
  await shot(page, '14-cel-publicar.png');
  await page.click('#rv2-sheet [data-act="sclose"]');
  await page.evaluate(() => { const m = document.querySelector('#app-main'); m.scrollTop = m.scrollHeight; });
  await shot(page, '15-cel-final-lista.png');
  await ctx.close();
}

await browser.close();
srv.kill();

console.log('\nMedidas:');
medidas.forEach((m) => console.log(' ', JSON.stringify(m)));
console.log('\nErrores de página:', errores.length ? errores : 'ninguno');
const archivos = readdirSync(OUT).filter((f) => f.endsWith('.png'));
const total = archivos.reduce((s, f) => s + statSync(OUT + f).size, 0);
console.log(`\n${archivos.length} capturas en ${OUT} · ${(total / 1048576).toFixed(2)} MB`);
