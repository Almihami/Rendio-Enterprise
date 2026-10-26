// Capturas con Chromium de verdad (Playwright) del DÍA MEZCLADO de Rutas del día
// (26-oct-2026): vueltas del tablero + unas vueltas pegadas con «Ruta de Julián».
// En el celular (390×844) y en el PC (1440×900), con las medidas que jsdom no da
// (desbordes, scroll de lado, alto de los botones). Mismo montaje que
// _capturas-lista-1026.mjs: servidor estático local, modo `#preview-admin`, el día
// de PRUEBA de fixtures/rutas-v2-dia.js y la red cortada.
//
//   cd rendio-backend && node scripts/_capturas-dia-mezclado-1026.mjs [carpeta]
//
// Lo que captura: la pantalla entera con el recuadro de la ruta pegada arriba de
// la lista (y el mapa, Avisos y Conductores), el recuadro solo y la hoja de
// Publicar con «La ruta de Julián … no se toca»; y, para comparar, el día SOLO de
// Julián (sin tablero), que se sigue viendo como antes.
import { chromium } from '/Users/harold/Documents/Rendio-Drivers/.e2e-tools/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const FIX = new URL('./fixtures/rutas-v2-dia.js', import.meta.url).pathname;
const OUT = (process.argv[2] || new URL('./_capturas-dia-mezclado-1026/', import.meta.url).pathname).replace(/\/?$/, '/');
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
for (const port of [5196, 5296, 5396, 5496]) { srv = await levantar(port); if (srv) { PORT = port; break; } }
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
      v.setVueltaDriver = async () => ({ status: 'planned', notified: 2 });
      v.delegateRoute = async (ra, n, p) => ({ delegated: true, name: n, phone: p, notified: 1 });
      v.setRouteDelegated = async (id, on) => ({ id, delegated: on, notified: 2 });
      // El día mezclado: el tablero (sin V-03 07:40, que lo pegado dejó vacía) +
      // 2 vueltas pegadas, como el lunes 26-oct a las 13:53.
      const DAY = window.RV2Fixture.DAY;
      const pub0 = v.getPublishedPlan;
      v.getPublishedPlan = async (day, o) => {
        const r = await pub0(day, o);
        if (!r || day !== DAY) return r;
        const p = (rid, name, j, at) => ({ stopId: 'pm-' + rid, rid, order: j + 1, status: 'pending', etaAt: `${DAY}T${at}:00-05:00`, name });
        const pool = [
          { id: 'pool-m1', type: 'sal', status: 'planned', startAt: `${DAY}T08:10:00-05:00`, pool: true, manualDay: DAY, deadlineAt: `${DAY}T08:50:00-05:00`, nota: '',
            vehicleId: null, planCar: null, carro: 'Carro', placa: null, cap: 4, driverProfileId: null, conductor: 'Sin conductor',
            delegated: true, delegateName: 'Felix Covault (Placa LLU676)', delegatePhone: '',
            pendientes: [p('res-I', 'Mateo Zapata', 0, '08:10'), p('res-J', 'Juliana Ossa', 1, '08:15')], atendidas: [] },
          { id: 'pool-m2', type: 'sal', status: 'planned', startAt: `${DAY}T08:30:00-05:00`, pool: true, manualDay: DAY, deadlineAt: `${DAY}T09:00:00-05:00`, nota: '',
            vehicleId: null, planCar: null, carro: 'Carro', placa: null, cap: 4, driverProfileId: 'd5', conductor: 'Rubén Díaz', delegated: false,
            pendientes: [p('res-N', 'Manuela Franco', 0, '08:30')], atendidas: [] },
        ];
        // «solo»: el día solo de Julián (sin tablero), para comparar.
        if (window.__escenario === 'solo') return { ...r, vueltas: pool };
        return { ...r, vueltas: r.vueltas.filter((x) => x.id !== 'ra-8').concat(pool) };
      };
      real = v;
    },
  });
};

const browser = await chromium.launch();
const medidas = [], errores = [];
async function abrir(width, height, escenario) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, locale: 'es-CO', timezoneId: 'America/Bogota', hasTouch: width < 768, isMobile: width < 768 });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(`http://localhost:${PORT}`) || /fonts\.(googleapis|gstatic)\.com/.test(u)) return route.continue();
    return route.abort();
  });
  await ctx.addInitScript((e) => { window.__escenario = e; }, escenario || 'mixto');
  await ctx.addInitScript({ path: FIX });
  await ctx.addInitScript(INYECCION);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errores.push(`${width}: ${e.message}`));
  await page.goto(`http://localhost:${PORT}/#preview-admin`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('#app-shell.admin-shell') && typeof window.setTab === 'function', null, { timeout: 15000 });
  await page.evaluate(() => window.setTab('routes'));
  if (escenario === 'solo') await page.waitForSelector('#rv2-list .rj-dia', { timeout: 15000 });
  else {
    await page.waitForSelector('#rv2-list .rj-dia.is-mixto', { timeout: 15000 });
    await page.waitForSelector('#rv2-list .rv2-row', { timeout: 15000 });
  }
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await page.waitForTimeout(500);
  return { ctx, page };
}
const shot = async (page, name, sel, full) => {
  await page.waitForTimeout(350);
  if (sel) { const el = await page.$(sel); if (el) { await el.scrollIntoViewIfNeeded(); await page.waitForTimeout(150); await el.screenshot({ path: OUT + name }); return; } }
  await page.screenshot({ path: OUT + name, fullPage: !!full });
};
const medir = async (page, etiqueta, sel) => {
  const m = await page.evaluate((s) => {
    const el = document.querySelector(s);
    const pagina = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    if (!el) return { falta: s, pagina };
    const r0 = el.getBoundingClientRect();
    const sobra = el.scrollWidth - el.clientWidth;
    // Hijos que se salen del recuadro por la derecha (texto o botones cortados).
    const fuera = [...el.querySelectorAll('*')].filter((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.right > r0.right + 1; })
      .map((x) => (x.className || x.tagName).toString().slice(0, 24)).slice(0, 6);
    const chicos = [...el.querySelectorAll('button, input, select, a')].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 44; })
      .map((b) => (b.dataset.rjDia || b.dataset.rjDeleg || b.dataset.rjDrv || b.id || b.dataset.act || b.className || b.tagName).toString().slice(0, 24) + ':' + Math.round(b.getBoundingClientRect().height));
    return { ancho: Math.round(r0.width), alto: Math.round(r0.height), pagina, sobra, fuera, chicos: chicos.slice(0, 8), nChicos: chicos.length };
  }, sel);
  medidas.push({ etiqueta, ...m });
};

for (const [w, h, tag] of [[390, 844, 'cel'], [1440, 900, 'pc']]) {
  const { ctx, page } = await abrir(w, h);
  // 1. La pantalla como la abre el jefe: frase, Avisos, Conductores, la ruta pegada y la lista.
  await page.evaluate(() => { const m = document.querySelector('#app-main'); if (m) m.scrollTop = 0; window.scrollTo(0, 0); });
  await shot(page, `${tag}-01-pantalla.png`, null, tag === 'pc');
  await medir(page, `${tag} pantalla`, '#routes-v2');
  // 2. El recuadro de la ruta pegada, arriba de la lista.
  await shot(page, `${tag}-02-recuadro-pegado.png`, '#rv2-list .rj-dia.is-mixto');
  await medir(page, `${tag} recuadro`, '#rv2-list .rj-dia.is-mixto');
  // 3. El recuadro y la primera hora del tablero juntos.
  await shot(page, `${tag}-03-lista.png`, '#rv2-list');
  await medir(page, `${tag} lista`, '#rv2-list');
  // 4. La hoja de Publicar con la línea de la ruta de Julián.
  await page.evaluate(() => { const b = window.innerWidth < 768 ? document.querySelector('#rv2-publishM') : document.querySelector('#rv2-publish'); b && b.click(); });
  await page.waitForTimeout(500);
  await shot(page, `${tag}-04-hoja-publicar.png`);
  await medir(page, `${tag} hoja publicar`, '#rv2-sheet');
  await ctx.close();
  // 5. Para comparar: el día SOLO de Julián (como era antes: sin tablero).
  const solo = await abrir(w, h, 'solo');
  await shot(solo.page, `${tag}-05-solo-julian.png`, '#rv2-list .rj-dia');
  await medir(solo.page, `${tag} solo julián`, '#rv2-list .rj-dia');
  await solo.ctx.close();
}
await browser.close();
srv.kill();
console.log(JSON.stringify(medidas, null, 1));
console.log('errores de página:', errores.length ? errores.join(' | ') : 'ninguno');
console.log('capturas en', OUT);
