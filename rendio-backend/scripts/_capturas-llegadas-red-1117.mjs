// Capturas del cambio del 17-nov-2026 (Harold): en Asignación, (1) una llegada con gente de horas
// distintas muestra cada hora con su persona, y con una sola hora queda igual; (2) quien no tiene
// vuelta sale EN SU HORA, en rojo, con «Ubicar». Mismo arranque que _capturas-hora-vuelo-1117.mjs
// (día de PRUEBA 12-oct, sin red), con el reloj del navegador a las 6:00 a. m. de ese día.
//   cd rendio-backend && node scripts/_capturas-llegadas-red-1117.mjs
import { chromium } from '/Users/harold/Documents/Rendio-Drivers/.e2e-tools/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const FIX = new URL('./fixtures/rutas-v2-dia.js', import.meta.url).pathname;
const OUT = '/Users/harold/Documents/Rendio-Drivers/capturas-llegadas-red-2026-11-17/';
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
for (const port of [5217, 5317, 5417, 5517]) { srv = await levantar(port); if (srv) { PORT = port; break; } }
if (!srv) throw new Error('no hubo puerto libre para el servidor');
const INYECCION = () => {
  let real;
  window.RV2Fixture.instalarFetch(window);
  Object.defineProperty(window, 'Api', {
    configurable: true,
    get() { return real; },
    set(v) {
      Object.keys(v).forEach((k) => { const f = v[k]; if (typeof f === 'function' && f.constructor && f.constructor.name === 'AsyncFunction') v[k] = async (...a) => { try { return await f(...a); } catch (_) { return null; } }; });
      v.getSettings = async () => ({ route_traffic_factor: 1 });
      v.listDrivers = async () => []; v.listAdmins = async () => []; v.listDriverRules = async () => [];
      window.__rv2log = window.RV2Fixture.instalar(v);
      real = v;
    },
  });
};
const browser = await chromium.launch();
const errores = [], fallas = [];
const ok = (n, c, d) => { console.log(`  ${c ? '✓' : '✗'} ${n}${c ? '' : ' → ' + JSON.stringify(d)}`); if (!c) fallas.push(n); };
async function abrir(width, height) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, locale: 'es-CO', timezoneId: 'America/Bogota', hasTouch: width < 768, isMobile: width < 768 });
  await ctx.route('**/*', (route) => { const u = route.request().url(); return u.startsWith(`http://localhost:${PORT}`) || /fonts\.(googleapis|gstatic)\.com/.test(u) ? route.continue() : route.abort(); });
  await ctx.addInitScript({ path: FIX });
  await ctx.addInitScript(INYECCION);
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date('2026-10-12T06:00:00-05:00'));
  page.on('pageerror', (e) => errores.push(`${width}: ${e.message}`));
  await page.goto(`http://localhost:${PORT}/#preview-admin`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('#app-shell.admin-shell') && typeof window.setTab === 'function', null, { timeout: 15000 });
  await page.evaluate(() => window.setTab('routes'));
  await page.waitForSelector('#rv2-list .rv2-row', { timeout: 15000 });
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await page.waitForTimeout(400);
  return { ctx, page };
}
const leer = (page) => page.evaluate(() => [...document.querySelectorAll('#rv2-list .rv2-row')].map((f) => {
  const w = f.querySelector('.when'), r = f.getBoundingClientRect();
  return { id: f.dataset.id || f.dataset.sinv || '', sinv: f.classList.contains('rv2-row--sinv'), tipo: (f.querySelector('.rv2-pill') || {}).textContent,
    cuando: w ? w.innerText.replace(/\n+/g, ' | ') : '', gente: [...f.querySelectorAll('.rv2-p .nm')].map((x) => x.textContent), hora: (f.closest('.rv2-gwrap').querySelector('.rv2-hour') || {}).textContent,
    cabe: f.scrollWidth <= f.clientWidth + 1, whenCabe: w ? w.scrollWidth <= w.clientWidth + 1 : null, ancho: Math.round(r.width) };
}));
for (const [w, h, pre] of [[1440, 900, 'pc'], [390, 844, 'cel']]) {
  console.log(`\n== ${pre} ${w}×${h}`);
  const { ctx, page } = await abrir(w, h);
  const filas = await leer(page);
  filas.filter((f) => f.tipo === 'Llegada' || f.sinv).forEach((f) => console.log('  ', JSON.stringify(f)));
  const dos = filas.find((f) => !f.sinv && f.gente.includes('Tomás Arias') && f.gente.includes('Sara Torres'));
  ok('la llegada de Tomás (16:00) y Sara (16:10) muestra las dos horas con su persona', !!dos && /16:00\s*\|?\s*Tomás A\./.test(dos.cuando) && /16:10\s*\|?\s*Sara T\./.test(dos.cuando), dos);
  const una = filas.find((f) => !f.sinv && f.tipo === 'Llegada' && f.gente.length === 1);
  ok('una llegada de una sola persona muestra UNA hora, como antes', !!una && !/\|.*\|.*\|/.test(una.cuando) && /Aterriza/.test(una.cuando), una);
  const sinv = filas.filter((f) => f.sinv);
  ok('Manuela Franco (salida 09:10) sale sin vuelta en la hora de las 9', sinv.some((f) => f.gente.includes('Manuela Franco') && /^09:00/.test(f.hora) && /Sin vuelta/.test(f.cuando)), sinv);
  ok('Kevin Uribe (llegada 15:05) sale sin vuelta en la hora de las 15', sinv.some((f) => f.gente.includes('Kevin Uribe') && /^15:00/.test(f.hora) && /15:05/.test(f.cuando)), sinv);
  ok('el encabezado de la hora cuenta «sin vuelta» aparte', sinv.every((f) => /sin vuelta/.test(f.hora)), sinv.map((f) => f.hora));
  ok('ninguna fila se desborda', filas.every((f) => f.cabe && f.whenCabe !== false), filas.filter((f) => !f.cabe || f.whenCabe === false));
  ok('la página no se desborda a lo ancho', await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
  // Capturas: la llegada de dos horas y una fila sin vuelta.
  await page.evaluate(() => { const f = [...document.querySelectorAll('#rv2-list .rv2-row')].find((x) => /Tomás Arias/.test(x.textContent) && /Sara Torres/.test(x.textContent)); if (f) f.scrollIntoView({ block: 'center' }); });
  await page.waitForTimeout(300); await page.screenshot({ path: `${OUT}${pre}-1-llegada-dos-horas.png` });
  await page.evaluate(() => { const f = document.querySelector('#rv2-list .rv2-row--sinv'); if (f) f.scrollIntoView({ block: 'center' }); });
  await page.waitForTimeout(300); await page.screenshot({ path: `${OUT}${pre}-2-sin-vuelta.png` });
  // «Ubicar» abre la hoja para meterla en una vuelta.
  await page.click('#rv2-list .rv2-row--sinv [data-act="route"]');
  await page.waitForTimeout(500);
  const hoja = await page.evaluate(() => { const s = document.querySelector('#rv2-sheet'); return s && !s.hidden ? s.innerText.slice(0, 160).replace(/\n+/g, ' | ') : null; });
  ok('«Ubicar» abre la hoja para elegir la vuelta', !!hoja, hoja);
  await page.screenshot({ path: `${OUT}${pre}-3-ubicar.png` });
  // Con el vuelo de Sara en vivo y tarde, su línea se marca.
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const R = window.RendioVuelos; if (!window.__p0) window.__p0 = R.para;
    R.para = (c) => (String(c).toUpperCase() === 'AV9420' ? { code: 'AV9420', direction: 'airport_to_home', status: 'in_air', delayMin: 40, schedAt: '2026-10-12T16:00:00-05:00', estimatedAt: '2026-10-12T16:40:00-05:00' } : null);
    window.RendioRutasV2.render();
  });
  await page.waitForTimeout(300);
  const tarde = (await leer(page)).find((f) => !f.sinv && f.gente.includes('Tomás Arias'));
  console.log('   con AV9420 40 min tarde:', JSON.stringify(tarde));
  ok('con el mismo vuelo 40 min tarde los dos quedan en UNA hora (16:40) y se dice tarde', !!tarde && /16:40/.test(tarde.cuando) && /tarde/.test(tarde.cuando), tarde);
  await page.evaluate(() => { const f = [...document.querySelectorAll('#rv2-list .rv2-row')].find((x) => /Tomás Arias/.test(x.textContent)); if (f) f.scrollIntoView({ block: 'center' }); });
  await page.waitForTimeout(300); await page.screenshot({ path: `${OUT}${pre}-4-vuelo-tarde.png` });
  await ctx.close();
}
console.log('\nerrores de página:', errores.length ? errores : 'ninguno');
console.log(fallas.length ? `✗ ${fallas.length} fallas` : '✓ todo bien', '· capturas en', OUT);
await browser.close();
srv.kill();
process.exit(fallas.length || errores.length ? 1 : 0);
