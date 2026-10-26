// Capturas con Chromium de verdad (Playwright) de la ruta de Julián DENTRO de la
// lista de Rutas del día (26-oct-2026, audios de los jefes de las 4:22–4:26 p. m.):
// cada vuelta pegada en su hora, la barra de arriba, el choque de un conductor con
// una vuelta pegada, la hoja «Cambiar hora» (0145) y la hoja de pegar con «(aero r)».
// En el celular (390×844) y en el PC (1440×900), con las medidas que jsdom no da
// (desbordes, scroll de lado, alto de los botones). Mismo montaje que
// _capturas-dia-mezclado-1026.mjs: servidor estático local, `#preview-admin`, el
// día de PRUEBA de fixtures/rutas-v2-dia.js y la red cortada.
//
//   cd rendio-backend && node scripts/_capturas-julian-lista-1026.mjs [carpeta]
import { chromium } from '/Users/harold/Documents/Rendio-Drivers/.e2e-tools/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const FIX = new URL('./fixtures/rutas-v2-dia.js', import.meta.url).pathname;
const OUT = (process.argv[2] || new URL('./_capturas-julian-lista-1026/', import.meta.url).pathname).replace(/\/?$/, '/');
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
for (const port of [5197, 5297, 5397, 5497]) { srv = await levantar(port); if (srv) { PORT = port; break; } }
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
      v.adminManualRouteSetTimes = async () => ({ notified: 2, driver_notified: true });
      // La hoja de pegar: sin la base (los apodos y los conjuntos se piden aparte).
      v.listCrewAliases = async () => [];
      v.listResidencesAdmin = async () => [];
      // Kevin, de reserva en el Hotel Río Verde (0121).
      const plan0 = v.listRoutePlanning;
      v.listRoutePlanning = async (t, d) => {
        const x = await plan0(t, d);
        if (x) Object.keys(x.aux).forEach((k) => { x.aux[k].auxId = 'aux-' + k; });
        if (x && x.aux.rO) Object.assign(x.aux.rO, { reserva: 'rio_verde', hotel: true, tierra: true, vuelo: '' });
        return x;
      };
      const DAY = window.RV2Fixture.DAY;
      const pub0 = v.getPublishedPlan;
      v.getPublishedPlan = async (day, o) => {
        const r = await pub0(day, o);
        if (!r || day !== DAY) return r;
        const p = (rid, name, j, at, extra) => Object.assign({ stopId: 'pm-' + (rid || name), rid, order: j + 1, status: 'pending', etaAt: at ? `${DAY}T${at}:00-05:00` : null, name, lat: 6.02, lng: -75.4 }, extra || {});
        const base = { pool: true, manualDay: DAY, nota: '', vehicleId: null, planCar: null, carro: 'Carro', placa: null, cap: 4, delegated: false, atendidas: [] };
        const pool = [
          // Delegada a alguien de afuera (como la de las 14:00 del 26-oct).
          Object.assign({}, base, { id: 'pool-m1', type: 'sal', status: 'planned', startAt: `${DAY}T08:10:00-05:00`, deadlineAt: `${DAY}T08:50:00-05:00`,
            driverProfileId: null, conductor: 'Sin conductor', delegated: true, delegateName: 'Felix Covault (Placa LLU676)', delegatePhone: '',
            pendientes: [p('res-I', 'Mateo Zapata', 0, '08:10'), p('res-J', 'Juliana Ossa', 1, '08:15')] }),
          // Tomada por Jorge, que a esa hora tiene V-01 del tablero: sale el aviso de choque.
          Object.assign({}, base, { id: 'pool-m2', type: 'sal', status: 'planned', startAt: `${DAY}T05:40:00-05:00`, deadlineAt: `${DAY}T06:20:00-05:00`,
            driverProfileId: 'd1', conductor: 'Jorge Pérez', placa: 'HYU376',
            pendientes: [p('res-N', 'Manuela Franco', 0, '05:40'), p(null, 'Primo de Manuela', 1, '05:45', { guest: true })] }),
          // La llegada de Kevin desde el hotel, que nadie ha tomado.
          Object.assign({}, base, { id: 'pool-m3', type: 'lle', status: 'planned', startAt: `${DAY}T15:40:00-05:00`, deadlineAt: null,
            driverProfileId: null, conductor: 'Sin conductor', pendientes: [p('res-O', 'Kevin Uribe', 0, null)] }),
        ];
        return { ...r, vueltas: r.vueltas.filter((x) => x.id !== 'ra-8').concat(pool) };
      };
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
  await page.waitForSelector('#rv2-list .rj-barra', { timeout: 15000 });
  await page.waitForSelector('#rv2-list .rv2-row--julian', { timeout: 15000 });
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
    const fuera = [...el.querySelectorAll('*')].filter((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.right > r0.right + 1; })
      .map((x) => (x.className || x.tagName).toString().slice(0, 24)).slice(0, 6);
    const chicos = [...el.querySelectorAll('button, input, select, a')].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 44; })
      .map((b) => (b.dataset.rjHora ? 'hora' : b.dataset.rjDia || b.dataset.rjDeleg || b.dataset.rjDrv || b.id || b.dataset.act || b.className || b.tagName).toString().slice(0, 24) + ':' + Math.round(b.getBoundingClientRect().height));
    return { ancho: Math.round(r0.width), alto: Math.round(r0.height), pagina, sobra, fuera, chicos: chicos.slice(0, 8), nChicos: chicos.length };
  }, sel);
  medidas.push({ etiqueta, ...m });
};
const irA = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); if (el) el.scrollIntoView({ block: 'start' }); }, sel);

for (const [w, h, tag] of [[390, 844, 'cel'], [1440, 900, 'pc']]) {
  const { ctx, page } = await abrir(w, h);
  // 1. La pantalla como la abre el jefe: la barra arriba y las pegadas en la lista.
  await page.evaluate(() => { const m = document.querySelector('#app-main'); if (m) m.scrollTop = 0; window.scrollTo(0, 0); });
  await shot(page, `${tag}-01-pantalla.png`, null, tag === 'pc');
  await medir(page, `${tag} pantalla`, '#routes-v2');
  // 2. La barra de la ruta pegada.
  await shot(page, `${tag}-02-barra.png`, '#rv2-list .rj-barra');
  await medir(page, `${tag} barra`, '#rv2-list .rj-barra');
  // 3. La hora de las 5 con la pegada de Jorge junto a su V-01 del tablero.
  await shot(page, `${tag}-03-hora-con-pegada.png`, '#rv2-list .rv2-row--julian[data-julian="pool-m2"]');
  const g = await page.evaluateHandle(() => document.querySelector('#rv2-list .rv2-row--julian[data-julian="pool-m2"]').closest('.rv2-gwrap'));
  await g.asElement().screenshot({ path: OUT + `${tag}-03b-grupo.png` });
  await medir(page, `${tag} fila pegada (tomada)`, '#rv2-list .rv2-row--julian[data-julian="pool-m2"]');
  await shot(page, `${tag}-04-delegada.png`, '#rv2-list .rv2-row--julian[data-julian="pool-m1"]');
  await medir(page, `${tag} fila pegada (delegada)`, '#rv2-list .rv2-row--julian[data-julian="pool-m1"]');
  await shot(page, `${tag}-05-llegada-hotel.png`, '#rv2-list .rv2-row--julian[data-julian="pool-m3"]');
  await medir(page, `${tag} fila pegada (llegada libre)`, '#rv2-list .rv2-row--julian[data-julian="pool-m3"]');
  // 4. Avisos: el choque de Jorge con su vuelta pegada.
  await irA(page, '#rv2-avisos');
  await shot(page, `${tag}-06-avisos.png`, '#rv2-avisos');
  // 5. «Cambiar hora» de la salida (corriendo la primera a 6:00).
  await page.evaluate(() => document.querySelector('#rv2-list .rv2-row--julian[data-julian="pool-m2"] [data-rj-hora]').click());
  await page.waitForSelector('#rv2-sheet .rj-h-in', { timeout: 5000 });
  await page.fill('#rv2-sheet .rj-h-in >> nth=0', '06:00');
  await page.waitForTimeout(200);
  await shot(page, `${tag}-07-cambiar-hora-salida.png`);
  await medir(page, `${tag} hoja cambiar hora`, '#rv2-sheet');
  medidas.push({ etiqueta: `${tag} horas tras mover la primera`, valores: await page.$$eval('#rv2-sheet .rj-h-in', (xs) => xs.map((x) => x.value)) });
  await page.click('#rv2-sheet [data-rj="hora-ok"]');
  await page.waitForTimeout(400);
  medidas.push({ etiqueta: `${tag} aviso al guardar`, toast: await page.$eval('#rv2-toast', (t) => t.textContent.trim()).catch(() => null) });
  // 6. «Cambiar hora» de la llegada (el día se vuelve a leer después de guardar).
  await page.waitForSelector('#rv2-list .rv2-row--julian[data-julian="pool-m3"] [data-rj-hora]', { timeout: 15000 });
  await page.evaluate(() => document.querySelector('#rv2-list .rv2-row--julian[data-julian="pool-m3"] [data-rj-hora]').click());
  await page.waitForSelector('#rv2-sheet .rj-h-in', { timeout: 5000 });
  await shot(page, `${tag}-08-cambiar-hora-llegada.png`);
  await page.evaluate(() => { const b = document.querySelector('#rv2-sheet [data-act="sclose"]'); if (b) b.click(); });
  await page.waitForTimeout(300);
  // 7. La hoja de pegar con «(aero r)»: se lee como llegada desde JMC.
  await page.waitForSelector('#rv2-julian', { timeout: 15000 });
  await page.evaluate(() => document.querySelector('#rv2-julian').click());
  await page.waitForSelector('#rj-ta', { timeout: 5000 });
  await page.fill('#rj-ta', '15:40 Kevin (Río Verde)\n\n16:20 Natalia y Tomás (aero r)\n\n16:40 Paula (Fontibón)\nDeben estar 17:20');
  await page.evaluate(() => document.querySelector('#rv2-sheet [data-rj="leer"]').click());
  await page.waitForSelector('#rj-prev .rj-b', { timeout: 5000 });
  await page.waitForTimeout(300);
  await shot(page, `${tag}-09-pegar-aero-r.png`);
  await medir(page, `${tag} hoja pegar`, '#rv2-sheet');
  await ctx.close();
}
await browser.close();
srv.kill();
console.log(JSON.stringify(medidas, null, 1));
console.log('errores de página:', errores.length ? errores.join(' | ') : 'ninguno');
console.log('capturas en', OUT);
