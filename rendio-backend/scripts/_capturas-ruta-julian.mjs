// Capturas de la ruta de Julián (0125) con Chromium de verdad (Playwright):
// la hoja con la ruta leída, el día publicado y la tarjeta «Vueltas para tomar»
// del conductor, en 1440×900 y 390×844, con medidas de desborde que jsdom no da.
// Mismo montaje que _capturas-rutas-v2.mjs: servidor local sin service worker,
// #preview-admin, el día de PRUEBA (fixtures/rutas-v2-dia.js) y red cortada.
//
//   cd rendio-backend && node scripts/_capturas-ruta-julian.mjs [carpeta]
import { chromium } from '/Users/harold/Documents/Rendio-Drivers/.e2e-tools/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const FIX = new URL('./fixtures/rutas-v2-dia.js', import.meta.url).pathname;
const OUT = (process.argv[2] || new URL('./_capturas-julian/', import.meta.url).pathname).replace(/\/?$/, '/');
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
for (const port of [5225, 5325, 5425]) { srv = await levantar(port); if (srv) { PORT = port; break; } }
if (!srv) throw new Error('no hubo puerto libre');

const INYECCION = () => {
  let real;
  window.RV2Fixture.instalarFetch(window);
  Object.defineProperty(window, 'Api', {
    configurable: true,
    get() { return real; },
    set(v) {
      Object.keys(v).forEach((k) => {
        const f = v[k];
        if (typeof f === 'function' && f.constructor && f.constructor.name === 'AsyncFunction') v[k] = async (...a) => { try { return await f(...a); } catch (_) { return null; } };
      });
      v.getSettings = async () => ({ route_traffic_factor: 1 });
      v.listDrivers = async () => []; v.listAdmins = async () => []; v.listDriverRules = async () => [];
      window.__rv2log = window.RV2Fixture.instalar(v);
      const plan0 = v.listRoutePlanning;
      v.listRoutePlanning = async (t, d) => { const r = await plan0(t, d); if (r) Object.keys(r.aux).forEach((k) => { r.aux[k].auxId = 'aux-' + k; }); return r; };
      v.listCrewAliases = async () => [{ alias: 'la flaca', auxId: 'aux-rH' }];
      let pub = null;
      v.adminManualRoutePublish = async (day, blocks) => { pub = blocks; return { created: blocks.length, kept: 0, removed: 0, skipped: 0, notified: blocks.reduce((a, b) => a + b.stops.length, 0), vueltas: blocks.length }; };
      const nombre = (rid) => { const c = window.RV2Fixture.crew().aux['r' + rid.slice(4)]; return c ? c.n : 'Tripulante'; };
      const pub0 = v.getPublishedPlan;
      v.getPublishedPlan = async (day, o) => {
        const r = await pub0(day, o);
        if (!pub || day !== window.RV2Fixture.DAY) return r;
        const pool = pub.map((b, i) => ({ id: 'pool-' + i, type: b.type, status: 'planned', startAt: b.stops[0].at, pool: true, manualDay: day, deadlineAt: b.deadline_at, nota: b.note || '',
          carro: 'Carro', placa: null, cap: 4, driverProfileId: null, conductor: 'Sin conductor', atendidas: [],
          pendientes: b.stops.map((s, j) => ({ stopId: 'p' + i + j, rid: s.reservation_id, order: j + 1, status: 'pending', etaAt: s.at, name: nombre(s.reservation_id) })) }));
        Object.assign(pool[1], { driverProfileId: 'd1', conductor: 'Jorge Pérez', placa: 'HYU376' });
        Object.assign(pool[0], { driverProfileId: 'd2', conductor: 'Luis Arango', status: 'in_progress' });
        pool[0].atendidas = [Object.assign(pool[0].pendientes.shift(), { status: 'picked_up' })];
        return { day, vueltas: r.vueltas.slice(0, 2).concat(pool), publicado: true };
      };
      real = v;
    },
  });
};
const TEXTO = ['3:50 Laura G (Olivar)', '4:00 Andres (Río vivo)', 'Deben estar 4:40', '', '5:30 José (Cerezos)', '5:40 Cami (Ébano)', 'Deben estar 6:10', '',
  '7:10 La flaca (Piedemonte)', 'Deben estar 7:40 Va a hotel', '', '8:20 Pepe (Mota)', 'Deben estar 8:50', '', '10:30 Felipe (Altos del lago)', 'Deben estar 11:20', '',
  '14:40 Natalia y Kevin (AV9412)', '', '16:10 Tomás y Sara (Av 9420)'].join('\n');

const browser = await chromium.launch();
const errores = [], medidas = [];
async function abrir(width, height) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, locale: 'es-CO', timezoneId: 'America/Bogota', hasTouch: width < 768, isMobile: width < 768 });
  await ctx.route('**/*', (route) => { const u = route.request().url(); return (u.startsWith(`http://localhost:${PORT}`) || /fonts\.(googleapis|gstatic)\.com/.test(u)) ? route.continue() : route.abort(); });
  await ctx.addInitScript({ path: FIX });
  await ctx.addInitScript(INYECCION);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errores.push(`${width}: ${e.message}`));
  page.on('dialog', (d) => d.accept());
  await page.goto(`http://localhost:${PORT}/#preview-admin`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('#app-shell.admin-shell') && typeof window.setTab === 'function', null, { timeout: 15000 });
  await page.evaluate(() => window.setTab('routes'));
  await page.waitForSelector('#rv2-list .rv2-row', { timeout: 15000 });
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await page.waitForTimeout(350);
  return { ctx, page };
}
const medir = async (page, etiqueta) => medidas.push({ etiqueta, ...(await page.evaluate(() => {
  const sh = document.querySelector('#rv2-sheet');
  const sobra = (el) => (el ? el.scrollWidth - el.clientWidth : null);
  const selects = [...document.querySelectorAll('#rj-prev select')].map((s) => s.getBoundingClientRect());
  const hoja = sh ? sh.getBoundingClientRect() : null;
  return {
    pagina: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    hoja: hoja && hoja.width ? [Math.round(hoja.left), Math.round(hoja.right)] : null, vw: innerWidth,
    hojaDesborda: sobra(document.querySelector('#rv2-sheet .rv2-sh-body')),
    selectFuera: hoja ? selects.filter((r) => r.right > hoja.right + 1 || r.left < hoja.left - 1).length : null,
    lista: sobra(document.querySelector('#rv2-listwrap')),
    diaFilasFuera: [...document.querySelectorAll('.rj-v')].filter((v) => v.scrollWidth > v.clientWidth + 1).length,
  };
})) });
const shot = async (page, n, full) => { await page.waitForTimeout(350); await page.screenshot({ path: OUT + n, fullPage: !!full }); };
async function flujo(width, height, pre) {
  const { ctx, page } = await abrir(width, height);
  await page.click('#rv2-julian');
  await page.fill('#rj-ta', TEXTO);
  await shot(page, pre + '-1-pegar.png');
  await page.click('#rv2-sheet [data-rj="leer"]');
  await page.waitForSelector('#rj-prev .rj-p');
  await medir(page, pre + ' hoja leída');
  await shot(page, pre + '-2-leida.png');
  await page.evaluate(() => { const b = document.querySelector('#rv2-sheet .rv2-sh-body'); if (b) b.scrollTop = 9999; });
  await shot(page, pre + '-3-leida-abajo.png');
  await page.evaluate(() => { const f = [...document.querySelectorAll('#rj-prev .rj-p')].find((p) => p.querySelector('.rj-w').textContent.startsWith('Kevin'));
    const s = f.querySelector('select'); s.value = 'res-O'; s.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.click('#rv2-sheet [data-rj="publicar"]');
  await page.waitForSelector('.rj-dia');
  await medir(page, pre + ' día publicado');
  await shot(page, pre + '-4-dia.png');
  await ctx.close();
}
await flujo(1440, 900, 'pc');
await flujo(390, 844, 'cel');

// Conductor: «Vueltas para tomar» (390×844), con la app del conductor de verdad.
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'es-CO', timezoneId: 'America/Bogota', hasTouch: true, isMobile: true });
  await ctx.route('**/*', (route) => { const u = route.request().url(); return (u.startsWith(`http://localhost:${PORT}`) || /fonts\.(googleapis|gstatic)\.com/.test(u)) ? route.continue() : route.abort(); });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errores.push(`cond: ${e.message}`));
  await page.goto(`http://localhost:${PORT}/#preview-driver`, { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  await page.evaluate(async () => {
    const HOY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    const at = (hm) => `${HOY}T${hm}:00-05:00`;
    Object.assign(window.Api, {
      listMyVueltasForDriver: async () => [],
      driverOpenRoutes: async () => [
        { id: 'P1', direction: 'home_to_airport', planned_start_at: at('03:40'), deadline_at: at('04:40'), note: 'Va a hotel', day: HOY,
          stops: [{ at: at('03:50'), name: 'Laura G.', place: 'Olivar Apartamentos' }, { at: at('04:00'), name: 'Andrés R.', place: 'Río Vivo' }, { at: at('04:10'), name: 'Valentina R.', place: 'Solare' }] },
        { id: 'P2', direction: 'airport_to_home', planned_start_at: at('14:55'), day: HOY, stops: [{ at: null, name: 'Natalia D.', place: 'Mirador', flight: 'AV9412' }, { name: 'Kevin U.', place: 'Laureles' }] }],
      getMyDriverProfileId: async () => 'DP1', countUnreadMessages: async () => ({}),
    });
    // Se muestra la ruta del conductor sola (el resto del cascarón no importa aquí).
    document.querySelectorAll('section[data-panel]').forEach((s) => s.classList.add('hidden'));
    const root = document.getElementById('driver-ruta-root');
    let el = root; while (el && el !== document.body) { el.classList && el.classList.remove('hidden'); el.hidden = false; el.style.display = ''; el = el.parentElement; }
    await window.DriverRutas.open({ id: 'pD', full_name: 'Jorge Arango', role: 'driver' });
  });
  await page.waitForTimeout(800);
  medidas.push({ etiqueta: 'conductor', ...(await page.evaluate(() => ({
    pagina: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    tarjetas: document.querySelectorAll('.rt-vc.rt-libre').length,
    fuera: [...document.querySelectorAll('.rt-vc.rt-libre')].filter((v) => v.scrollWidth > v.clientWidth + 1).length,
    boton: (() => { const b = document.querySelector('.rt-libre [data-rt="take"]'); if (!b) return null; const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })(),
  }))) });
  await page.screenshot({ path: OUT + 'cond-1-libres.png' });
  await ctx.close();
}
await browser.close();
srv.kill();
console.log('Medidas:'); medidas.forEach((m) => console.log(' ', JSON.stringify(m)));
console.log('Errores de página:', errores.length ? errores : 'ninguno');
console.log('Capturas en', OUT);
