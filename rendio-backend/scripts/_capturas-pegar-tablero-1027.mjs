// Capturas con Chromium de verdad (Playwright) de PEGAR = LLENAR EL TABLERO
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
const OUT = (process.argv[2] || new URL('./_capturas-pegar-tablero-1027/', import.meta.url).pathname).replace(/\/?$/, '/');
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
  '10:30 Felipe (Altos del lago)', 'Deben estar 11:20', '',
  '14:40 Natalia (AV9412)', '',
  '16:10 Tomás y Sara (Av 9420)',
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
const medir = async (page, etiqueta, sel) => {
  const m = await page.evaluate((s) => {
    const el = document.querySelector(s);
    const pagina = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    if (!el) return { falta: s, pagina };
    const r0 = el.getBoundingClientRect();
    const fuera = [...el.querySelectorAll('*')].filter((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.right > r0.right + 1; })
      .map((x) => (x.className || x.tagName).toString().slice(0, 24)).slice(0, 6);
    return { ancho: Math.round(r0.width), alto: Math.round(r0.height), pagina, sobra: el.scrollWidth - el.clientWidth, fuera };
  }, sel);
  medidas.push({ etiqueta, ...m });
};

for (const [w, h, tag] of [[390, 844, 'cel'], [1440, 900, 'pc']]) {
  const { ctx, page } = await abrir(w, h);
  // 1. Pegar la ruta del jefe y leerla.
  await page.evaluate(() => document.querySelector('#rv2-julian').click());
  await page.waitForSelector('#rj-ta', { timeout: 5000 });
  await page.fill('#rj-ta', TEXTO);
  await page.evaluate(() => document.querySelector('#rv2-sheet [data-rj="leer"]').click());
  await page.waitForSelector('#rj-prev .rj-b', { timeout: 5000 });
  await page.waitForTimeout(300);
  await shot(page, `${tag}-01-hoja-pegar.png`);
  medidas.push({ etiqueta: `${tag} botón`, texto: await page.$eval('#rv2-sheet [data-rj="publicar"]', (b) => b.textContent.trim()) });
  // 2. «Pasar al tablero»: se abre la hoja de Publicar de siempre.
  await page.evaluate(() => document.querySelector('#rv2-sheet [data-rj="publicar"]').click());
  await page.waitForSelector('#rv2-doPublish', { timeout: 5000 });
  await shot(page, `${tag}-02-hoja-publicar.png`);
  medidas.push({ etiqueta: `${tag} aviso`, toast: await page.$eval('#rv2-toast', (t) => t.textContent.trim()).catch(() => null) });
  await page.evaluate(() => document.querySelector('#rv2-sheet [data-act="sclose"]').click());
  await page.waitForTimeout(300);
  // 3. La lista: lo pegado son filas del tablero como las demás.
  const ids = await page.evaluate(() => {
    const R = window.rt || (typeof rt !== 'undefined' ? rt : null);
    const de = (k) => R.lanes.find((l) => (R.order[l.id] || []).includes(k));
    return { jose: de('rC') && de('rC').id, pepe: de(Object.keys(R.aux).find((k) => R.aux[k].guest)) && de(Object.keys(R.aux).find((k) => R.aux[k].guest)).id, nat: de('rF') && de('rF').id, otra: de('rE') && de('rE').id };
  });
  medidas.push({ etiqueta: `${tag} vueltas`, ids, juliana: await page.$$eval('#rv2-list .rj-v, #rv2-list .rv2-row--julian', (x) => x.length) });
  await page.evaluate(() => { const m = document.querySelector('#app-main'); if (m) m.scrollTop = 0; window.scrollTo(0, 0); });
  await shot(page, `${tag}-03-lista.png`, null, tag === 'pc');
  await shot(page, `${tag}-04-fila-pegada-jose.png`, `#rv2-list .rv2-row[data-id="${ids.jose}"]`);
  await shot(page, `${tag}-05-fila-normal-valentina.png`, `#rv2-list .rv2-row[data-id="${ids.otra}"]`);
  await medir(page, `${tag} fila pegada`, `#rv2-list .rv2-row[data-id="${ids.jose}"]`);
  // 4. El detalle de la vuelta pegada: paradas, horas del jefe y el trayecto.
  for (const [k, nombre] of [['jose', '06-detalle-jose'], ['pepe', '07-detalle-pepe-sin-cuenta'], ['nat', '08-detalle-llegada']]) {
    if (!ids[k]) continue;
    await page.evaluate((id) => document.querySelector(`#rv2-list .rv2-row[data-id="${id}"]`).click(), ids[k]);
    await page.waitForTimeout(700);
    await shot(page, `${tag}-${nombre}.png`);
    medidas.push({ etiqueta: `${tag} ${nombre}`, mapa: await page.evaluate(() => { const m = document.querySelector('#rv2-mapwrap'); return m ? !m.hidden : null; }),
      detalle: await page.evaluate(() => { const d = document.querySelector('#rv2-detail'); return d ? d.textContent.replace(/\s+/g, ' ').trim().slice(0, 220) : null; }) });
    await page.evaluate(() => { const b = document.querySelector('#rv2-detail [data-act="dclose"], #rv2-detail [data-act="close"]'); if (b) b.click(); });
    await page.waitForTimeout(300);
  }
  await ctx.close();
}
await browser.close();
srv.kill();
console.log(JSON.stringify(medidas, null, 1));
console.log('errores de página:', errores.length ? errores.join(' | ') : 'ninguno');
console.log('capturas en', OUT);
