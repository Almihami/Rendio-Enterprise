// Capturas con Chromium de verdad (Playwright) de los pedidos de Camilo del
// 28-oct-2026 (tarde): Asignación con UNA sola barra de desplazamiento (Avisos en
// una barrita, Conductores a todo el ancho y el detalle como cajón al tocar la
// vuelta), Reservas sin «En pie»/«Calificadas» y con «Cambios» (la campana roja), y
// la pantalla nueva Rutas › Análisis › Calificaciones. Montaje copiado de
// _capturas-camilo-1028.mjs: servidor estático local, `#preview-admin`, el día de
// PRUEBA de fixtures/rutas-v2-dia.js y la red cortada. Las reservas, los cambios y
// las calificaciones son de PRUEBA (abajo, en la inyección).
//
//   cd rendio-backend && node scripts/_capturas-camilo-1028b.mjs [carpeta]
import { chromium } from '/Users/harold/Documents/Rendio-Drivers/.e2e-tools/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const FIX = new URL('./fixtures/rutas-v2-dia.js', import.meta.url).pathname;
const OUT = (process.argv[2] || new URL('./_capturas-camilo-1028b/', import.meta.url).pathname).replace(/\/?$/, '/');
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
      // 28-oct (tarde): Reservas con cambios de los tripulantes y Calificaciones (de PRUEBA).
      const ahora = Date.now(), H = 3600000;
      const iso = (ms) => new Date(ms).toISOString();
      const hm = (ms) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      const R = (id, type, name, ms, o = {}) => Object.assign({ id, type, name, profileId: 'p-' + id, phone: '3001112233', address: o.addr || 'Olivar Apartamentos, Rionegro', when: iso(ms),
        date: iso(ms).slice(0, 10), time: hm(ms), groundOps: false, flight: type === 'lle' ? 'AV9414' : '', notes: '', raw: 'requested', status: o.st || 'pending',
        cancelledAt: o.cancel ? iso(ahora - 2 * H) : null, cancelReason: o.cancel ? 'Me cambiaron la programación' : '', createdAt: iso(ahora - 30 * H), isPernocta: false, isReserva: true,
        readyAt: null, rating: o.rating || 0, ratingTags: [], ratedAt: null, reservePlace: null }, o.x || {});
      window.__res = [
        R('r1', 'sal', 'Lina Marcela Ospina', ahora + 2 * H, { st: 'assigned' }),
        R('r2', 'lle', 'Kriss Daniela Arango', ahora + 3 * H, { addr: 'Campus Reservado, Rionegro' }),
        R('r3', 'sal', 'Margy Lorena Ruiz', ahora + 5 * H, { cancel: true, st: 'cancelled' }),
        R('r4', 'lle', 'Sara Villegas Mejía', ahora + 7 * H, { st: 'assigned' }),
        R('r5', 'sal', 'Isabella Páez Gómez', ahora + 26 * H),
        R('r6', 'lle', 'Valeria Ríos Arango', ahora + 28 * H, { st: 'assigned' }),
        R('r7', 'sal', 'Juliana Ossa', ahora - 20 * H, { st: 'done', rating: 5 }),
      ];
      v.listReservationsAdmin = async () => JSON.parse(JSON.stringify(window.__res));
      v.getRequestCutoff = async () => ({ corte: 1170 });
      const C = (id, rid, kind, msAt, before, after, dir) => ({ id, rid, kind, at: iso(msAt), before, after, by_owner: true, dir, name: (window.__res.find((x) => x.id === rid) || {}).name, tarde: true, cancelled: kind === 'cancelado', vuelta: null });
      const cambios = () => [
        C('k1', 'r1', 'hora', ahora - 20 * 60000, { when: iso(ahora + 1.5 * H) }, { when: iso(ahora + 2 * H) }, 'sal'),
        C('k2', 'r2', 'vuelo', ahora - 50 * 60000, { vuelo: 'AV9412', when: iso(ahora + 2.5 * H) }, { vuelo: 'AV9414', when: iso(ahora + 3 * H) }, 'lle'),
        C('k3', 'r3', 'cancelado', ahora - 2 * H, { when: iso(ahora + 5 * H) }, { motivo: 'Me cambiaron la programación' }, 'sal'),
        C('k4', 'r6', 'lugar', ahora - 4 * H, { lugar: null }, { lugar: 'rio_verde' }, 'lle'),
      ];
      v.listCrewChanges = async () => cambios();
      const F = (id, rating, tags, h, drv, dir, name) => ({ id, type: dir, when: iso(ahora - h * H - 2 * H), rating, tags, ratedAt: iso(ahora - h * H), name, driver: drv });
      v.listRatings = async () => [
        F('q1', 2, ['Llegó tarde'], 3, 'Daniel Alvarez Torres', 'lle', 'Sara Villegas Mejía'),
        F('q2', 5, ['Puntual', 'Amable'], 5, 'Juan Ospina', 'sal', 'Juliana Ossa'),
        F('q3', 5, ['Puntual', 'Manejo seguro'], 9, 'Miguel Ángel Peña', 'sal', 'Lady Johanna Aguirre'),
        F('q4', 4, ['Carro limpio'], 20, 'Daniel Alvarez Torres', 'sal', 'Valentina Ríos'),
        F('q5', 5, ['Puntual'], 30, 'Juan Ospina', 'lle', 'Natalia Duque'),
        F('q6', 3, ['Manejo brusco'], 50, 'Miguel Ángel Peña', 'lle', 'Tomás Arias'),
        F('q7', 5, [], 70, null, 'sal', 'Paula Henao'),
      ];
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
// Cuántas cajas se desplazan por dentro (lo que Camilo llama «líneas de scroll»).
const scrolls = (page, raiz) => page.evaluate((r) => {
  const out = [];
  const se = document.scrollingElement;
  if (se && se.scrollHeight > se.clientHeight + 2) out.push('página');
  document.querySelectorAll(r + ' *, #app-main, main, #app-shell, body').forEach((e) => {
    const cs = getComputedStyle(e);
    if (!/(auto|scroll)/.test(cs.overflowY)) return;
    if (e.scrollHeight <= e.clientHeight + 2 || e.clientHeight === 0) return;
    if (e.closest('.rv2-detail:not(.is-open)')) return;
    out.push((e.id ? '#' + e.id : e.tagName.toLowerCase()) + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).join('.') : '') + ` (${e.clientHeight}/${e.scrollHeight})`);
  });
  return out;
}, raiz);
const anchoDeMas = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const caja = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; }, sel);

for (const [w, h, tag] of [[1440, 900, 'pc'], [1280, 800, 'pc1280'], [390, 844, 'cel']]) {
  const { ctx, page } = await abrir(w, h);
  // ── Asignación ──
  const r = await page.evaluate(() => { const x = document.querySelector('#routes-v2'); return { lay: x.dataset.lay, fila: x.dataset.fila }; });
  medidas.push({ etiqueta: `${tag} asignación`, diseño: r, scrolls: await scrolls(page, '#routes-v2'), avisos: await caja(page, '#rv2-avisos'), conductores: await caja(page, '#rv2-drivers'),
    lista: await caja(page, '#rv2-list'), detalle: await caja(page, '#rv2-detail'), anchoDeMas: await anchoDeMas(page) });
  await shot(page, `${tag}-01-asignacion.png`);
  await shot(page, `${tag}-01b-asignacion-entera.png`, null, true);
  // Bajando: la barra de arriba se queda a la vista (en el PC).
  await page.evaluate(() => { const m = document.querySelector('#app-main'); m.scrollTop = 900; });
  await page.waitForTimeout(300);
  medidas.push({ etiqueta: `${tag} bajando`, barra: await caja(page, '#routes-v2 .rv2-bar'), publicar: await caja(page, '#rv2-publish'), main: await page.evaluate(() => document.querySelector('#app-main').scrollTop) });
  await shot(page, `${tag}-01c-bajando.png`);
  await page.evaluate(() => { document.querySelector('#app-main').scrollTop = 0; });
  await page.evaluate(() => document.querySelector('#rv2-avisos .rv2-avbar').click());
  await shot(page, `${tag}-02-avisos-abiertos.png`, '#rv2-summary');
  medidas.push({ etiqueta: `${tag} avisos abiertos`, scrolls: await scrolls(page, '#routes-v2'), avisos: await caja(page, '#rv2-avisos') });
  await page.evaluate(() => document.querySelector('#rv2-avisos .rv2-avbar').click());
  await page.evaluate(() => { const row = document.querySelectorAll('#rv2-list .rv2-row')[2]; row.scrollIntoView({ block: 'center' }); row.click(); });
  await page.waitForTimeout(700);
  await shot(page, `${tag}-03-vuelta-abierta.png`);
  medidas.push({ etiqueta: `${tag} vuelta abierta`, detalle: await caja(page, '#rv2-detail'), abierto: await page.evaluate(() => document.querySelector('#rv2-detail').classList.contains('is-open')), scrolls: await scrolls(page, '#routes-v2') });
  await page.evaluate(() => { const x = document.querySelector('#rv2-detail [data-act="close"]') || document.querySelector('#rv2-scrim'); if (x) x.click(); });
  await page.waitForTimeout(400);
  // ── Reservas ──
  // Sin red, las consultas sueltas a Supabase (maletas, externos, delegadas, vuelos) no
  // responden nunca: aquí contestan vacío al instante (lo que se mira son los datos de prueba).
  await page.evaluate(() => {
    const vacio = () => { const p = new Proxy(function () {}, { get: (t, k) => (k === 'then' ? (res) => res({ data: [], error: null }) : () => p), apply: () => p }); return p; };
    sb.from = () => vacio();
    sb.rpc = async () => ({ data: null, error: { message: 'sin red' } });
  });
  await page.evaluate(() => { try { localStorage.removeItem('rendio.reservas.cambios.visto'); } catch (_) {} window.setTab('reservas'); });
  try { await page.waitForSelector('#rv-list .rv-row', { timeout: 10000 }); } catch (e) { console.log('RESERVAS NO CARGÓ:', await page.evaluate(() => [document.querySelector('[data-panel="reservas"]').className, (document.querySelector('#rv-list') || {}).innerText].join(' · ')), errores); throw e; }
  await page.waitForTimeout(500);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, `${tag}-04-reservas.png`);
  medidas.push({ etiqueta: `${tag} reservas`, filtros: await page.$$eval('#rv-ui [data-rv-f]', (bs) => bs.filter((b) => !b.hidden).map((b) => b.textContent.replace(/\s+/g, ' ').trim())),
    campana: await page.$eval('#rv-fcambios', (b) => ({ roja: b.classList.contains('is-new'), punto: !b.querySelector('.rv-dot').hidden, color: getComputedStyle(b.querySelector('.rv-bell .icon')).color, title: b.title })),
    filas: await page.$$eval('#rv-list [data-rv-row]', (rs) => rs.map((x) => x.dataset.rvRow)), anchoDeMas: await anchoDeMas(page) });
  await shot(page, `${tag}-04b-filtros.png`, '#rv-ui .rv-tools');
  await page.evaluate(() => document.querySelector('#rv-fcambios').click());
  await page.waitForTimeout(400);
  await shot(page, `${tag}-05-reservas-cambios.png`);
  medidas.push({ etiqueta: `${tag} cambios`, filas: await page.$$eval('#rv-list [data-rv-row]', (rs) => rs.map((x) => x.querySelector('.rv-top b').textContent + ' · ' + (x.querySelector('.rv-cambios') || {}).innerText)),
    campana: await page.$eval('#rv-fcambios', (b) => ({ roja: b.classList.contains('is-new'), punto: !b.querySelector('.rv-dot').hidden })), anchoDeMas: await anchoDeMas(page) });
  // ── Calificaciones ──
  await page.evaluate(() => window.setTab('calificaciones'));
  await page.waitForSelector('#cal-ui .cal-row', { timeout: 10000 });
  await page.waitForTimeout(400);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, `${tag}-06-calificaciones.png`, null, true);
  medidas.push({ etiqueta: `${tag} calificaciones`, resumen: await page.$eval('#cal-ui .cal-sum', (e) => e.innerText.replace(/\s+/g, ' ')), filas: await page.$$eval('#cal-ui .cal-row', (rs) => rs.length),
    menu: await page.evaluate(() => [...document.querySelectorAll('#adm-snav .grp')].map((g) => g.innerText.replace(/\s+/g, ' ').trim()).filter((t) => /Análisis/.test(t))), anchoDeMas: await anchoDeMas(page) });
  await ctx.close();
}
await browser.close();
srv.kill();
console.log(JSON.stringify(medidas, null, 1));
console.log('errores de página:', errores.length ? errores.join(' | ') : 'ninguno');
console.log('capturas en', OUT);
