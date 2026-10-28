// Capturas con Chromium de verdad (Playwright) de VOLVER A PEGAR LA RUTA (27-oct-2026,
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
const OUT = (process.argv[2] || new URL('./_capturas-repegar-1027/', import.meta.url).pathname).replace(/\/?$/, '/');
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
        if (x && window.__leslie) x.aux.rZ = Object.assign({}, x.aux.rI, { n: 'Leslie Mora Ríos', dl: '09:40', reservationId: 'res-Z', auxId: 'aux-rZ', zona: 'Cerezos', sector: 'Rionegro', lat: 6.021 });
        return x;
      };
      real = v;
    },
  });
};


const PRIMERA = ['5:30 José (Cerezos)', '5:40 Cami (Ébano)', 'Deben estar 6:10', '', '5:20 Valentina (Solare)', 'Deben estar 5:50', '',
  '7:10 La flaca (Piedemonte)', '7:20 Sergio (Hotel Sandiego)', 'Deben estar 7:40', '', '8:20 Pepe (Mota)', 'Deben estar 8:50', '',
  '8:40 Mateo (Cámbulo)', '8:45 Juliana (Aurora)', 'Deben estar 9:00', '', '10:30 Felipe (Altos del lago)', 'Deben estar 11:20', '',
  '14:40 Natalia (AV9412)', '', '15:05 Kevin (AV9414)', '', '16:10 Tomás y Sara (Av 9420)'].join('\n');
const SEGUNDA = ['5:30 José (Cerezos)', 'Deben estar 6:10', '', '5:20 Valentina (Solare)', '5:35 Cami (Ébano)', 'Deben estar 5:50', '',
  '7:10 La flaca (Piedemonte)', 'Deben estar 7:40', '', '8:25 Pepe M (Mota)', 'Deben estar 8:50', '',
  '8:40 Mateo (Cámbulo)', '8:45 Juliana (Aurora)', 'Deben estar 9:00', '', '9:10 Lesli (Cerezos)', 'Deben estar 9:40', '', '9:15 Kriss', '',
  '10:30 Felipe (Altos del lago)', 'Deben estar 11:20', '', '14:40 Natalia (AV9412)', '', '15:05 Kevin (AV9414)', '', '16:10 Tomás y Sara (Av 9420)'].join('\n');

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


const anchoDeMas = (page) => page.evaluate(() => {
  const sh = document.querySelector('#rv2-sheet');
  return { pagina: document.documentElement.scrollWidth - document.documentElement.clientWidth, hoja: sh && !sh.hidden ? sh.scrollWidth - sh.clientWidth : null };
});
const pegar = async (page, texto) => {
  await page.evaluate(() => document.querySelector('#rv2-julian').click());
  await page.waitForSelector('#rj-ta', { timeout: 5000 });
  await page.fill('#rj-ta', texto);
  await page.evaluate(() => document.querySelector('#rv2-sheet [data-rj="leer"]').click());
  await page.waitForSelector('#rj-prev .rj-b', { timeout: 5000 });
  await page.waitForTimeout(400);
};
const estado = (page) => page.evaluate(() => {
  const en = (k) => rt.lanes.filter((l) => (rt.order[l.id] || []).includes(k)).length;
  const llaves = Object.keys(rt.aux);
  return { repetidos: llaves.filter((k) => en(k) > 1).map((k) => rt.aux[k].n), sinCuenta: llaves.filter((k) => rt.aux[k].guest).map((k) => rt.aux[k].n + ' ×' + en(k)),
    sinCarro: rt.pool.map((k) => (rt.aux[k] || {}).n), vueltas: rt.lanes.filter((l) => (rt.order[l.id] || []).length).length,
    leslie: llaves.filter((k) => rt.aux[k].reservationId === 'res-Z').map((k) => en(k)) };
});
const filaDe = (page, nombre) => page.evaluateHandle((n) => [...document.querySelectorAll('#rj-prev .rj-p')].find((p) => p.querySelector('.rj-w').textContent.trim().startsWith(n)), nombre);
const leerFila = (page, nombre) => page.evaluate((n) => { const p = [...document.querySelectorAll('#rj-prev .rj-p')].find((x) => x.querySelector('.rj-w').textContent.trim().startsWith(n)); return p ? p.dataset.st + ' · ' + ((p.querySelector('small') || {}).textContent || '') : null; }, nombre);

for (const [w, h, tag] of [[390, 844, 'cel'], [1440, 900, 'pc']]) {
  const { ctx, page } = await abrir(w, h);
  // 1. La primera ruta del día. «La flaca» (apodo sin aprender) sale de opción por su
  // conjunto y su hora: el jefe toca «Va en la ruta (tiene la app)».
  await pegar(page, PRIMERA);
  medidas.push({ etiqueta: `${tag} La flaca`, estado: await leerFila(page, 'La flaca'), primera: await (await filaDe(page, 'La flaca')).evaluate((p) => { const o = p.querySelector('optgroup[label="Más probables"] option'); return o ? o.textContent : null; }) });
  await shot(page, `${tag}-01a-la-flaca.png`, '#rj-prev .rj-p[data-st="falta"]');
  await (await (await filaDe(page, 'La flaca')).$('select')).selectOption('__app'); await page.waitForTimeout(250);
  medidas.push({ etiqueta: `${tag} La flaca con «Va en la ruta (tiene la app)»`, estado: await leerFila(page, 'La flaca'), elegido: await (await filaDe(page, 'La flaca')).evaluate((p) => p.querySelector('select').selectedOptions[0].textContent) });
  await shot(page, `${tag}-01-pegar-modo.png`);
  medidas.push({ etiqueta: `${tag} 1ª pegada`, boton: await page.$eval('#rv2-sheet [data-rj="publicar"]', (b) => b.textContent.trim() + (b.disabled ? ' (apagado)' : '')),
    modo: await page.$eval('#rj-prev input[name="rj-modo"]:checked', (x) => x.value), ancho: await anchoDeMas(page),
    opciones: await page.$$eval('#rj-prev .rj-p select', (ss) => [...ss[0].options].slice(0, 3).map((o) => o.textContent.trim())) });
  await page.evaluate(() => document.querySelector('#rv2-sheet [data-rj="publicar"]').click());
  await page.waitForTimeout(800);
  await cerrar(page); await page.waitForTimeout(300);
  medidas.push({ etiqueta: `${tag} tras 1ª`, ...(await estado(page)) });
  // 2. La actualización (Cami con Valentina, Sergio ya no, «Pepe M», Leslie nueva, Kriss sin la app).
  await page.evaluate(() => { window.__leslie = true; });
  await pegar(page, SEGUNDA);
  await shot(page, `${tag}-02-actualizacion.png`);
  medidas.push({ etiqueta: `${tag} Lesli`, estado: await leerFila(page, 'Lesli'), elegido: await (await filaDe(page, 'Lesli')).evaluate((p) => p.querySelector('select').selectedOptions[0].textContent) });
  medidas.push({ etiqueta: `${tag} Kriss`, estado: await leerFila(page, 'Kriss') });
  await (await (await filaDe(page, 'Kriss')).$('select')).selectOption('__app'); await page.waitForTimeout(250);
  medidas.push({ etiqueta: `${tag} Kriss con «Va en la ruta (tiene la app)»`, estado: await leerFila(page, 'Kriss') });
  await (await (await filaDe(page, 'Kriss')).$('select')).selectOption('__guest'); await page.waitForTimeout(250);
  await shot(page, `${tag}-03-kriss-sin-app.png`, '#rj-prev .rj-sum');
  medidas.push({ etiqueta: `${tag} 2ª pegada`, boton: await page.$eval('#rv2-sheet [data-rj="publicar"]', (b) => b.textContent.trim() + (b.disabled ? ' (apagado)' : '')),
    modo: await page.$eval('#rj-prev input[name="rj-modo"]:checked', (x) => x.value), ancho: await anchoDeMas(page) });
  await page.evaluate(() => document.querySelector('#rv2-sheet [data-rj="publicar"]').click());
  await page.waitForTimeout(800);
  medidas.push({ etiqueta: `${tag} aviso`, texto: await page.evaluate(() => (document.querySelector('#rv2-toast') || {}).textContent) });
  await cerrar(page); await page.waitForTimeout(300);
  medidas.push({ etiqueta: `${tag} tras actualización`, ...(await estado(page)) });
  await shot(page, `${tag}-04-tablero-actualizado.png`);
  // 3. Pasar a una vuelta sola: Juliana sale de la vuelta con Mateo.
  await page.evaluate(() => document.querySelector('#rv2-list [data-act="move"][data-crew="rJ"]').click());
  await page.waitForSelector('#routes-v2 [data-act="sola"]', { timeout: 5000 });
  await page.evaluate(() => { const b = document.querySelector('#routes-v2 [data-act="sola"]'); if (b && b.scrollIntoView) b.scrollIntoView({ block: 'center' }); });
  await shot(page, `${tag}-05-mover-con-sola.png`);
  await page.evaluate(() => document.querySelector('#routes-v2 [data-act="sola"]').click());
  await page.waitForTimeout(800);
  await shot(page, `${tag}-06-vuelta-sola.png`);
  medidas.push({ etiqueta: `${tag} sola`, aviso: await page.evaluate(() => (document.querySelector('#rv2-toast') || {}).textContent),
    juliana: await page.evaluate(() => { const l = rt.lanes.find((x) => (rt.order[x.id] || []).includes('rJ')); return l ? [l.id, rt.order[l.id].join(), l.start] : null; }),
    cambiar: await page.evaluate(() => !!document.querySelector('#rv2-detail [data-act="assign"]')), ancho: await anchoDeMas(page) });
  await page.evaluate(() => { const b = document.querySelector('#rv2-detail [data-act="close"]'); if (b) b.click(); });
  await page.waitForTimeout(300);
  // 4. Ubicar a Sergio (sin carro) también ofrece «En una vuelta sola».
  await page.evaluate(() => { const b = document.querySelector('#routes-v2 [data-act="route"][data-crew="rG"]'); if (b) b.click(); });
  await page.waitForTimeout(500);
  await shot(page, `${tag}-07-ubicar-sola.png`);
  medidas.push({ etiqueta: `${tag} ubicar`, hay: await page.evaluate(() => !!document.querySelector('#rv2-sheet [data-act="sola"]')), ancho: await anchoDeMas(page) });
  await ctx.close();
}
await browser.close();
srv.kill();
console.log(JSON.stringify(medidas, null, 1));
console.log('errores de página:', errores.length ? errores.join(' | ') : 'ninguno');
console.log('capturas en', OUT);
