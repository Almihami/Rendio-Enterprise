// Capturas con Chromium (Playwright) de los pendientes de los jefes del 26-oct
// (0137–0140), en 1440×900 y 390×844, con datos de PRUEBA inyectados: la red hacia
// Supabase y los mapas se corta, nada sale del equipo y ninguna base se toca.
//
//   Admin  (#preview-admin): Asignación con lo terminado recogido y «Entregas de
//          turno»; Reservas con «+ Nuevo pedido» abierto (externo nuevo) y una
//          fila «Externo · sin app»; Calibración con los minutos nuevos.
//   Conductor (#preview-driver): Inicio con la tarjeta de entrega y «Tu día»; Mi
//          día con «Pasaron sin marcar» y «Vueltas para tomar».
//
// Escribe en Rendio-Drivers/capturas-pendientes-2026-10-26/ y mide desbordes.
//   cd rendio-backend && node scripts/_capturas-pendientes-1026.mjs
import { chromium } from '/Users/harold/Documents/Rendio-Drivers/.e2e-tools/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const FIX = new URL('./fixtures/rutas-v2-dia.js', import.meta.url).pathname;
const OUT = '/Users/harold/Documents/Rendio-Drivers/capturas-pendientes-2026-10-26/';
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
for (const port of [5237, 5337, 5437, 5537]) { srv = await levantar(port); if (srv) { PORT = port; break; } }
if (!srv) throw new Error('no hubo puerto libre');
console.log('Servidor en', PORT);

// Corre ANTES que la app: cuando api.js publique window.Api, se reemplazan las que
// leen la base por datos de prueba y las demás devuelven null sin red.
const INYECCION = () => {
  let real;
  const NOW = Date.now(), MIN = 60000, iso = (m) => new Date(NOW + m * MIN).toISOString();
  const dia = (m) => new Date(NOW + m * MIN).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  const hm = (m) => new Date(NOW + m * MIN).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false });
  if (window.RV2Fixture) window.RV2Fixture.instalarFetch(window);
  Object.defineProperty(window, 'Api', {
    configurable: true,
    get() { return real; },
    set(v) {
      Object.keys(v).forEach((k) => {
        const f = v[k];
        if (typeof f === 'function' && f.constructor && f.constructor.name === 'AsyncFunction') v[k] = async (...a) => { try { return await f(...a); } catch (_) { return null; } };
      });
      v.getSettings = async () => ({ route_traffic_factor: 1, _loaded: true });
      v.listDrivers = async () => []; v.listAdmins = async () => [{ id: 'j1', full_name: 'Camilo Jefe' }]; v.listDriverRules = async () => [];
      v.getRouteFinishRules = async () => ({ hide: 10, unmarked: 30, handoverLead: 120, handoverLate: 15, enBase: true, handoverEnBase: true });
      // ── Asignación (el día de prueba de fixtures/rutas-v2-dia.js) ──
      if (window.RV2Fixture) {
        window.RV2Fixture.instalar(v);
        const D = window.RV2Fixture.DAY;
        const vs = window.RV2Fixture.vueltas();
        const hecha = (x) => { x.atendidas = x.pendientes.concat(x.atendidas).map((s) => ({ ...s, status: 'delivered' })); x.pendientes = []; };
        hecha(vs[1]); vs[1].fin = { estado: 'ok', motivos: [], faltan: 0, at: '06:30', ocultaDesde: NOW + 8 * MIN };
        hecha(vs[3]); vs[3].fin = { estado: 'ok', motivos: [], faltan: 0, at: '05:40', ocultaDesde: NOW - 50 * MIN };
        vs[4].fin = { estado: 'sinmarcar', motivos: [], faltan: 2, at: '', ocultaDesde: NOW - MIN };
        vs[6].fin = { estado: 'sinmarcar', motivos: [], faltan: 1, at: '', ocultaDesde: NOW + 10 * MIN };
        v.getPublishedPlan = async () => ({ day: D, vueltas: JSON.parse(JSON.stringify(vs)), publicado: true });
        const due = (h, d = D) => new Date(`${d}T${h}:00-05:00`).toISOString();
        v.listHandovers = async () => [
          { op_day: D, band: 'am', due_at: due('14:00'), car: 'V-01', plate: 'PRW443', from: { id: 'd1', name: 'Carlos Mejía Ruiz' }, to: { id: 'd4', name: 'Daniel Restrepo' }, to_text: null, manual: false, sigue: false, delivered_at: due('13:55'), received_at: null },
          { op_day: D, band: 'am', due_at: due('14:00'), car: 'V-02', plate: null, from: { id: 'd2', name: 'Miguel Peña' }, to: { id: 'd2', name: 'Miguel Peña' }, manual: false, sigue: true, delivered_at: null },
          { op_day: D, band: 'pm', due_at: due('02:00', '2026-10-13'), car: 'V-03', plate: null, from: { id: 'd4', name: 'Daniel Restrepo' }, to: null, to_text: null, manual: false, sigue: false, delivered_at: null },
        ];
        v.setHandover = async () => ({});
      }
      // ── Reservas ──
      v.listReservationsAdmin = async () => [
        { id: 'rv1', type: 'sal', name: 'Kriss Montoya', profileId: 'pK', phone: '3001234567', address: 'Campus Reservado', when: iso(600), date: dia(600), time: hm(600), status: 'pending', createdAt: iso(-60), notes: '(Pedido por Coordinación.)' },
        { id: 'rv2', type: 'lle', name: 'Laura Gómez', profileId: 'pL', phone: '', address: 'El Olivar · Torre 2', when: iso(700), date: dia(700), time: hm(700), status: 'assigned', flight: 'AV9563', createdAt: iso(-3000) },
      ];
      v.listExternalAuxIds = async () => ({ aux: new Set(['aK']), profiles: new Set(['pK']) });
      v.listAuxiliares = async () => [
        { id: 'aL', name: 'Laura Gómez', active: true, deleted: false, external: false, res1: { name: 'El Olivar' }, unit1: 'T2 504' },
        { id: 'aK', name: 'Kriss Montoya', active: true, deleted: false, external: true, res1: { name: 'Campus Reservado' }, unit1: '' },
      ];
      v.listResidences = async () => [{ id: 'r1', name: 'El Olivar', sector: 'Rionegro' }, { id: 'r2', name: 'Campus Reservado', sector: 'Llanogrande' }];
      v.getRequestCutoff = async () => ({ corte: 1180, noche: 120, enBase: true });
      // ── Conductor ──
      const leg = (o) => Object.assign({ kind: 'pickup', lat: 6.15, lng: -75.37, addr: 'El Olivar', unit: '', flight: '', dl: '', phone: '', notes: '', bags: null, quiet: false, meetCode: '12', meetingPoint: '', level: 'shared', privateStatus: null, stopStatus: 'pending', pickup: '', eta: '' }, o);
      const APT = { kind: 'airport', name: 'Aeropuerto JMC', addr: 'Terminal', lat: 6.1715, lng: -75.427 };
      const vuelta = (id, m, done, vencida, nom) => ({ id, type: 'sal', start: hm(m), startAt: iso(m), done, vencida: !!vencida, assignmentId: 'A' + id, day: dia(m), opDay: dia(0),
        legs: [leg({ name: nom, reservationId: 'R' + id, stopStatus: done ? 'delivered' : 'pending', dl: hm(m + 60) }), APT] });
      v.listMyVueltasForDriver = async () => [vuelta('V1', -300, true, false, 'Sara Ríos'), vuelta('V2', -150, false, true, 'Michell Rodríguez'), vuelta('V3', 40, false, false, 'Margy Evans')];
      v.getMyDriverProfileId = async () => 'DP1';
      v.driverOpenRoutes = async () => [
        { id: 'P1', direction: 'home_to_airport', planned_start_at: iso(50), deadline_at: iso(95), stops: [{ name: 'Laura Gómez', place: 'El Olivar', at: iso(55), guest: false }], cruza: true },
        { id: 'P2', direction: 'home_to_airport', planned_start_at: iso(200), deadline_at: iso(245), stops: [{ name: 'Kriss Montoya', place: 'Campus Reservado', at: iso(210), guest: true }], cruza: false },
      ];
      v.driverMyHandovers = async () => [{ op_day: dia(0), band: 'am', role: 'entrega', due_at: iso(95), car: 'Carro 1', plate: 'PRW443',
        from: { id: 'pD', name: 'Conductor Demo' }, to: { id: 'pX', name: 'Daniel Restrepo Gil', phone: '310 555 0000' }, to_text: null, delivered_at: null }];
      real = v;
    },
  });
};

const browser = await chromium.launch();
const medidas = [], errores = [];
async function abrir(width, height, rol, conFixture) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, locale: 'es-CO', timezoneId: 'America/Bogota', hasTouch: width < 768, isMobile: width < 768 });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(`http://localhost:${PORT}`) || /fonts\.(googleapis|gstatic)\.com/.test(u)) return route.continue();
    return route.abort();
  });
  if (conFixture) await ctx.addInitScript({ path: FIX });
  await ctx.addInitScript(INYECCION);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errores.push(`${rol} ${width}: ${e.message}`));
  await page.goto(`http://localhost:${PORT}/#preview-${rol}`, { waitUntil: 'load' });
  await page.waitForTimeout(900);
  return { ctx, page };
}
const shot = async (page, name, full) => { await page.waitForTimeout(350); await page.screenshot({ path: OUT + name, fullPage: !!full }); };
const medir = async (page, etiqueta) => {
  const m = await page.evaluate(() => ({ desbordePagina: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    desbordeMain: (() => { const x = document.querySelector('#app-main'); return x ? x.scrollWidth - x.clientWidth : null; })() }));
  medidas.push({ etiqueta, ...m });
};

for (const [W, H, tag] of [[1440, 900, 'pc'], [390, 844, 'cel']]) {
  // Asignación
  {
    const { ctx, page } = await abrir(W, H, 'admin', true);
    await page.waitForFunction(() => typeof window.setTab === 'function', null, { timeout: 15000 });
    await page.evaluate(() => window.setTab('routes'));
    await page.waitForSelector('#rv2-list .rv2-row', { timeout: 15000 });
    await page.waitForTimeout(600);
    await page.evaluate(() => { const e = document.querySelector('#rv2-entregas'); if (e && e.scrollIntoView) e.scrollIntoView({ block: 'start' }); });
    await medir(page, tag + ' asignación');
    await shot(page, `${tag}-01-asignacion-entregas.png`);
    await page.evaluate(() => { const m = document.querySelector('#app-main'); const b = document.querySelector('#rv2-list .rv2-hechas-b'); if (b) b.scrollIntoView({ block: 'center' }); });
    await shot(page, `${tag}-02-asignacion-terminadas.png`);
    await page.click('#rv2-list .rv2-hechas-b');
    await page.waitForTimeout(250);
    await page.evaluate(() => { const b = document.querySelector('#rv2-list .rv2-hechas-b'); if (b) b.scrollIntoView({ block: 'start' }); });
    await shot(page, `${tag}-03-asignacion-terminadas-abiertas.png`);
    // Cambiar a quién recibe (la de la tarde, sin definir)
    await page.evaluate(() => { const e = document.querySelector('#rv2-entregas'); if (e) e.scrollIntoView({ block: 'start' }); });
    const b = await page.$('#rv2-entregas [data-ent-edit]');
    if (b) { await b.click(); await page.waitForTimeout(300); await shot(page, `${tag}-04-entregas-cambiar.png`); }
    await ctx.close();
  }
  // Reservas + Nuevo pedido
  {
    const { ctx, page } = await abrir(W, H, 'admin', false);
    await page.waitForFunction(() => typeof window.setTab === 'function', null, { timeout: 15000 });
    // Reservas lee algunas cosas directo con window.sb (maletas, delegadas, vuelos): sin
    // red el cliente real se queda esperando, así que se le pone uno vacío.
    await page.evaluate(() => {
      const vacio = () => { const b = new Proxy({}, { get: (_, k) => (k === 'then' ? (ok) => Promise.resolve({ data: [], error: null }).then(ok) : () => b) }); return b; };
      window.sb = { from: vacio, rpc: async () => ({ data: null, error: null }), auth: { getUser: async () => ({ data: { user: null } }) } };
    });
    await page.evaluate(() => window.setTab('reservas'));
    try { await page.waitForSelector('#rv-list .rv-row', { timeout: 6000 }); }
    catch (e) { console.log('RESERVAS no pintó:', await page.evaluate(() => (document.querySelector('#rv-list') || {}).innerHTML || '(sin #rv-list)'), await page.evaluate(() => [...document.querySelectorAll('section[data-panel]')].filter((x) => !x.classList.contains('hidden')).map((x) => x.dataset.panel))); throw e; }
    await page.waitForTimeout(300);
    await shot(page, `${tag}-05-reservas-externo.png`);
    await page.click('#rv-new'); await page.waitForTimeout(300);
    await page.click('[data-rvn-quien="nuevo"]'); await page.waitForTimeout(300);
    await page.fill('#rvn-name', 'Pepe Pérez'); await page.fill('#rvn-phone', '300 123 4567');
    await page.selectOption('#rvn-res', 'r2'); await page.fill('#rvn-unit', 'Casa 4');
    await page.fill('#rvn-hora', '05:30');
    await medir(page, tag + ' nuevo pedido');
    await shot(page, `${tag}-06-nuevo-pedido-externo.png`);
    await page.click('[data-rvn-quien="buscar"]'); await page.waitForTimeout(200);
    await page.fill('#rvn-q', 'kri'); await page.dispatchEvent('#rvn-q', 'input'); await page.waitForTimeout(300);
    await shot(page, `${tag}-07-nuevo-pedido-buscar.png`);
    await ctx.close();
  }
  // Calibración
  if (tag === 'pc') {
    const { ctx, page } = await abrir(W, H, 'admin', false);
    await page.waitForFunction(() => typeof window.setTab === 'function', null, { timeout: 15000 });
    await page.evaluate(() => window.setTab('calibracion'));
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      const d = [...document.querySelectorAll('details.set-sec')].find((x) => /Vueltas terminadas y entrega de turno/.test(x.textContent));
      if (d) { const acc = d.closest('details.set-card-acc'); if (acc) acc.open = true; d.open = true; d.scrollIntoView({ block: 'start' }); }
    });
    await shot(page, `${tag}-08-calibracion.png`);
    await ctx.close();
  }
  // Conductor
  {
    const { ctx, page } = await abrir(W, H, 'driver', false);
    await page.waitForTimeout(1200);
    await page.evaluate(async () => { if (typeof renderDriverInicio === 'function') await renderDriverInicio(); });
    await page.waitForTimeout(600);
    await medir(page, tag + ' conductor inicio');
    await shot(page, `${tag}-09-conductor-inicio.png`);
    await page.evaluate(async () => { if (window.DriverRutas) await window.DriverRutas.open({ id: 'preview-driver', full_name: 'Conductor Demo', role: 'driver' }); });
    await page.waitForTimeout(900);
    await shot(page, `${tag}-10-conductor-mi-dia.png`);
    await page.evaluate(() => { const b = document.querySelector('[data-rt="toggle-past"]'); if (b) { b.click(); } });
    await page.waitForTimeout(400);
    await page.evaluate(() => { const b = document.querySelector('[data-rt="toggle-past"]'); if (b) b.scrollIntoView({ block: 'start' }); });
    await shot(page, `${tag}-11-conductor-pasadas-y-tomar.png`);
    await ctx.close();
  }
}
await browser.close();
srv.kill();
console.log('\nMedidas:'); medidas.forEach((m) => console.log(' ', JSON.stringify(m)));
console.log('\nErrores de página:', errores.length ? errores : 'ninguno');
