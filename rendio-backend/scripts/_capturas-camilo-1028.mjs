// Capturas con Chromium de verdad (Playwright) de la lista de Camilo del 28-oct-2026:
// la barra con «Cambios» y «Enrutar», la hoja de cambios de los tripulantes, el
// pegado contra la base de tripulantes («tiene cuenta y no pidió: se le crea el
// pedido») y el aviso de Enrutar. Montaje copiado de _capturas-repegar-1027.mjs:
// (de ahí:) Capturas de VOLVER A PEGAR LA RUTA (27-oct-2026,
// 2ª, pedido de la profa): las dos opciones nuevas («Va en la ruta (tiene la app y le
// llega aviso)» / «Va, pero no tiene la app»), «Rearmar el día con esta ruta», la
// actualización que rearma el tablero sin repetidos, y «Pasar a una vuelta sola».
// (Montaje copiado de _capturas-lista-camilo-1027.mjs:)
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
const OUT = (process.argv[2] || new URL('./_capturas-camilo-1028/', import.meta.url).pathname).replace(/\/?$/, '/');
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
      window.__apodos = window.__apodos || [];   // como la base (0149): lo aprendido vuelve en la próxima pegada
      v.listCrewAliases = async () => window.__apodos.slice();
      v.listDelegateContacts = async () => [{ id: 'c1', name: 'Uber de Camilo', phone: '311 222 3344' }, { id: 'c2', name: 'Pedro Gómez', phone: '310 999 8877' }];
      v.removeDelegateContact = async () => {};
      v.saveDelegateContact = async () => 'c3';
      v.saveCrewAliases = async (a) => { a.forEach((x) => window.__apodos.push({ alias: x.alias, auxId: x.auxiliar_profile_id })); return a.length; };
      v.listResidencesAdmin = async () => [{ id: 'res-mota', name: 'Mota', is_active: true, latitude: 6.155, longitude: -75.374, zona_jefe: 'Rionegro' }];
      const plan0 = v.listRoutePlanning;
      v.listRoutePlanning = async (t, d) => {
        const x = await plan0(t, d);
        if (x) Object.keys(x.aux).forEach((k) => { x.aux[k].auxId = 'aux-' + k; });
        // Leslie pidió después de abrir el día.
        if (x) Object.assign(x.aux, JSON.parse(JSON.stringify(window.__extra || {})));
        if (x && window.__leslie) x.aux.rZ = Object.assign({}, x.aux.rI, { n: 'Leslie Mora Ríos', dl: '09:40', reservationId: 'res-Z', auxId: 'aux-rZ', zona: 'Cerezos', sector: 'Rionegro', lat: 6.021 });
        return x;
      };
      // 28-oct: la base de tripulantes, el pedido a su nombre y los cambios.
      window.__extra = window.__extra || {};
      v.listAuxiliares = async () => [
        { id: 'aux-isa', name: 'Isabella Páez Gómez', active: true, deleted: false, res1: { name: 'Marinilla Real', sector: 'Marinilla' } },
        { id: 'aux-va1', name: 'Valeria Ríos Arango', active: true, deleted: false, res1: { name: 'Solare', sector: 'Marinilla' } },
        { id: 'aux-va2', name: 'Valeria Soto', active: true, deleted: false, res1: null }];
      v.adminCreateReservation = async (f) => {
        const n = Object.keys(window.__extra).length + 1;
        const nombre = { 'aux-isa': 'Isabella Páez Gómez', 'aux-va1': 'Valeria Ríos Arango', 'aux-va2': 'Valeria Soto' }[f.auxId];
        const hm = new Date(f.whenIso).toLocaleTimeString('en-GB', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
        window.__extra['rX' + n] = { n: nombre, zona: 'Marinilla Real', sector: 'Marinilla', resId: null, zonaJefe: null, dir: 'Marinilla', lat: 6.03 + n / 1000, lng: -75.41,
          dl: hm, pax: 1, type: f.type, reservationId: 'res-X' + n, tel: '', vuelo: '', tierra: false, notas: '', hotel: false, auxId: f.auxId };
        return 'res-X' + n;
      };
      const at = (hm, dia = '2026-10-12') => new Date(`${dia}T${hm}:00-05:00`).toISOString();
      v.listCrewChanges = async () => [
        { id: 'c1', at: at('06:10'), rid: 'res-N', kind: 'nuevo', after: { when: at('09:10') }, by_owner: true, name: 'Manuela Franco', dir: 'sal', when: at('09:10'), cancelled: false, tarde: true },
        { id: 'c2', at: at('05:30'), rid: 'res-F', kind: 'vuelo', before: { vuelo: 'AV9412', when: at('15:00') }, after: { vuelo: 'AV9418', when: at('15:40') }, by_owner: true, name: 'Natalia Duque', dir: 'lle', when: at('15:40'), cancelled: false, tarde: true },
        { id: 'c3', at: at('05:00'), rid: 'res-I', kind: 'cancelado', before: { when: at('09:00') }, after: { motivo: 'me cambiaron la programación' }, by_owner: true, name: 'Mateo Zapata', dir: 'sal', when: at('09:00'), cancelled: true, tarde: true },
        { id: 'c4', at: at('07:20'), rid: 'res-NUEVA', kind: 'nuevo', after: { when: at('12:00') }, by_owner: true, name: 'Laura Restrepo Cano', dir: 'sal', when: at('12:00'), cancelled: false, tarde: true },
        { id: 'c6', at: at('15:00', '2026-10-11'), rid: 'res-C', kind: 'nuevo', after: { when: at('06:30') }, by_owner: true, name: 'José Ñáñez', dir: 'sal', when: at('06:30'), cancelled: false, tarde: false }];
      real = v;
    },
  });
};



const TEXTO = ['11:20 Isabella Páez Gómez ) (Marinilla (Isabella y Valeria)', 'Deben estar 12:10', '', '8:20 Valeria (Mota)', 'Deben estar 9:00', '',
  '5:30 José (Cerezos)', '5:40 Cami (Ébano)', 'Deben estar 6:10'].join('\n');

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
  await page.waitForTimeout(700);
  return { ctx, page };
}
const shot = async (page, name, sel, full) => {
  await page.waitForTimeout(350);
  if (sel) { const el = await page.$(sel); if (el) { await el.scrollIntoViewIfNeeded(); await page.waitForTimeout(150); await el.screenshot({ path: OUT + name }); return; } }
  await page.screenshot({ path: OUT + name, fullPage: !!full });
};
const cerrar = (page) => page.evaluate(() => { const b = document.querySelector('#rv2-sheet [data-act="sclose"]'); if (b) b.click(); });
const anchoDeMas = (page) => page.evaluate(() => {
  const sh = document.querySelector('#rv2-sheet');
  const bar = document.querySelector('#routes-v2 .rv2-bar');
  return { pagina: document.documentElement.scrollWidth - document.documentElement.clientWidth, hoja: sh && !sh.hidden ? sh.scrollWidth - sh.clientWidth : null,
    barra: bar ? bar.scrollWidth - bar.clientWidth : null };
});
const caja = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 0 && getComputedStyle(e).display !== 'none' }; }, sel);

for (const [w, h, tag] of [[390, 844, 'cel'], [1440, 900, 'pc']]) {
  const { ctx, page } = await abrir(w, h);
  await page.waitForTimeout(400);
  medidas.push({ etiqueta: `${tag} barra`, cambios: await caja(page, '#rv2-cambios'), badge: await page.$eval('#rv2-cambios .rv2-badge', (b) => (b.hidden ? 'oculto' : b.textContent)), enrutar: await caja(page, '#rv2-enrutar'), ancho: await anchoDeMas(page) });
  await shot(page, `${tag}-01-barra.png`, '#routes-v2 .rv2-bar');
  // 1. Cambios
  await page.evaluate(() => document.querySelector('#rv2-cambios').click());
  await page.waitForSelector('#rc-body .rc-row', { timeout: 5000 });
  await shot(page, `${tag}-02-cambios.png`);
  medidas.push({ etiqueta: `${tag} cambios`, filas: await page.$$eval('#rc-body .rc-list:not(.rc-list--antes) .rc-row', (rs) => rs.map((r) => r.innerText.replace(/\s+/g, ' ').trim())), ancho: await anchoDeMas(page) });
  await cerrar(page); await page.waitForTimeout(300);
  medidas.push({ etiqueta: `${tag} tras abrir`, badge: await page.$eval('#rv2-cambios .rv2-badge', (b) => (b.hidden ? 'oculto' : b.textContent)) });
  // 2. Pegar contra la base de tripulantes
  await page.evaluate(() => document.querySelector('#rv2-julian').click());
  await page.waitForSelector('#rj-ta', { timeout: 5000 });
  await page.fill('#rj-ta', TEXTO);
  await page.evaluate(() => document.querySelector('#rv2-sheet [data-rj="leer"]').click());
  await page.waitForSelector('#rj-prev .rj-b', { timeout: 5000 });
  await page.waitForTimeout(400);
  await shot(page, `${tag}-03-pegar-isabella.png`);
  await page.evaluate(() => { const p = [...document.querySelectorAll('#rj-prev .rj-p')].find((x) => x.querySelector('.rj-w').textContent.trim().startsWith('Valeria')); const s = p.querySelector('select'); s.value = 'aux:aux-va1'; s.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForTimeout(300);
  await shot(page, `${tag}-04-pegar-valeria.png`, '#rj-prev');
  medidas.push({ etiqueta: `${tag} pegado`, filas: await page.$$eval('#rj-prev .rj-p', (ps) => ps.map((p) => p.dataset.st + ' · ' + p.querySelector('.rj-w').textContent.trim() + ' → ' + p.querySelector('select').selectedOptions[0].textContent + ' · ' + ((p.querySelector('small') || {}).textContent || ''))),
    boton: await page.$eval('#rv2-sheet [data-rj="publicar"]', (b) => b.textContent.trim() + (b.disabled ? ' (apagado)' : '')), ancho: await anchoDeMas(page) });
  await page.evaluate(() => document.querySelector('#rv2-sheet [data-rj="publicar"]').click());
  await page.waitForTimeout(900);
  await cerrar(page); await page.waitForTimeout(300);
  medidas.push({ etiqueta: `${tag} tras pasar`, toast: await page.evaluate(() => (document.querySelector('#rv2-toast') || {}).textContent),
    isabella: await page.evaluate(() => { const k = Object.keys(rt.aux).find((x) => rt.aux[x].n === 'Isabella Páez Gómez'); const l = k && rt.lanes.find((y) => (rt.order[y.id] || []).includes(k)); return l ? [l.car, l.start, rt.aux[k].reservationId, !!rt.aux[k].guest] : null; }) });
  // 3. Enrutar (la madrugada del día de prueba, con un choque a propósito)
  await page.evaluate(() => {
    Date.now = () => Date.parse('2026-10-12T02:00:00-05:00');
    const l = rt.lanes.find((x) => (rt.order[x.id] || []).includes('rD')); l.drv = 'd2'; RendioRutasV2.render();
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector('#rv2-enrutar').click());
  await page.waitForTimeout(500);
  await shot(page, `${tag}-05-enrutar.png`);
  medidas.push({ etiqueta: `${tag} enrutar`, toast: await page.evaluate(() => (document.querySelector('#rv2-toast') || {}).textContent), toastCaja: await caja(page, '#rv2-toast'), ancho: await anchoDeMas(page) });
  await ctx.close();
}
await browser.close();
srv.kill();
console.log(JSON.stringify(medidas, null, 1));
console.log('errores de página:', errores.length ? errores.join(' | ') : 'ninguno');
console.log('capturas en', OUT);
