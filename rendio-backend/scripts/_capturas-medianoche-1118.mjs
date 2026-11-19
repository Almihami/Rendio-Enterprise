// Capturas del arreglo «pasada la medianoche» (18-nov-2026) en un navegador de verdad
// (Chromium), PC y celular, con el día de PRUEBA 12-oct y sin red:
//   antes   → María Noche (aterriza 23:20) sale «Sin vuelta · No tiene carro» aunque su
//             vuelta existe a las 00:10 del día siguiente (la base la tiene; el tablero no);
//   después → su vuelta va como fila propia «Sale después de medianoche», en su hora;
//   ayer    → el otro lado: la vuelta de las 00:10 de hoy con gente de ayer («Gente de otro día»).
//   cd rendio-backend && node scripts/_capturas-medianoche-1118.mjs
import { chromium } from '/Users/harold/Documents/Rendio-Drivers/.e2e-tools/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const FIX = new URL('./fixtures/rutas-v2-dia.js', import.meta.url).pathname;
const OUT = '/Users/harold/Documents/Rendio-Drivers/capturas-medianoche-2026-11-18/';
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
for (const port of [5218, 5318, 5418, 5518]) { srv = await levantar(port); if (srv) { PORT = port; break; } }
if (!srv) throw new Error('no hubo puerto libre para el servidor');
const INYECCION = (caso) => {
  let real;
  const DAY = '2026-10-12', SIG = '2026-10-13';
  const persona = (n, dl, rid, vuelo, zona) => ({ n, zona, sector: 'Rionegro', resId: null, zonaJefe: null, dir: zona + ', Rionegro', lat: 6.02, lng: -75.41, dl, pax: 1, type: 'lle',
    reservationId: rid, tel: '', vuelo, tierra: false, notas: '', hotel: false });
  const parada = (stopId, rid, name, order, extra) => Object.assign({ stopId, rid, order, status: 'pending', name, etaAt: null, dueAt: null, pax: 1, guest: false }, extra || {});
  const vuelta = (id, startAt, pendientes, extra) => Object.assign({ id, type: 'lle', status: 'planned', startAt, vehicleId: null, planCar: 'Carro 1', carro: 'Carro 1', placa: null, cap: 4,
    pool: true, paraTomar: true, autoCreated: false, manualDay: null, delegated: false, driverProfileId: null, conductor: 'Sin conductor', pendientes, atendidas: [],
    fin: { estado: 'falta', motivos: [], faltan: 0, at: '', finAt: null, esperado: null, ocultaDesde: null, oculta: false } }, extra || {});
  window.RV2Fixture.instalarFetch(window);
  Object.defineProperty(window, 'Api', {
    configurable: true,
    get() { return real; },
    set(v) {
      Object.keys(v).forEach((k) => { const f = v[k]; if (typeof f === 'function' && f.constructor && f.constructor.name === 'AsyncFunction') v[k] = async (...a) => { try { return await f(...a); } catch (_) { return null; } }; });
      v.getSettings = async () => ({ route_traffic_factor: 1, despacho_activo: true });
      v.listDrivers = async () => []; v.listAdmins = async () => []; v.listDriverRules = async () => [];
      window.__rv2log = window.RV2Fixture.instalar(v);
      const plan0 = v.listRoutePlanning;
      v.listRoutePlanning = async (tipo, day) => {
        const r = await plan0(tipo, day);
        if (r) { r.aux.rZ = persona('María Noche', '23:20', 'res-Z', 'AV9242', 'Ruta 39'); r.aux.rY = persona('Sara Tarde', '23:50', 'res-Y', 'P57049', 'Carmen de Viboral'); }
        return r;
      };
      const pub0 = v.getPublishedPlan;
      v.getPublishedPlan = async (day, o) => {
        const r = await pub0(day, o);
        if (day !== DAY) return r;
        // Lo que devuelve el api.js nuevo: `sigue` = las de después de medianoche con gente de este día.
        if (caso === 'despues') r.sigue = [vuelta('ra-sig1', SIG + 'T00:10:00-05:00', [parada('g-1', null, 'Valentina Vanegas', 1, { guest: true }), parada('st-z', 'res-Z', 'María Noche', 2), parada('st-y', 'res-Y', 'Sara Tarde', 3)])];
        if (caso === 'ayer') r.vueltas = r.vueltas.concat([vuelta('ra-ayer', DAY + 'T00:10:00-05:00', [parada('st-a', 'res-AYER', 'Lina Deayer', 1), parada('st-b', 'res-AYER2', 'Beto Deayer', 2)], { planCar: 'Carro 9', carro: 'Carro 9' })]);
        return r;
      };
      real = v;
    },
  });
};
const browser = await chromium.launch();
const errores = [], fallas = [];
const ok = (n, c, d) => { console.log(`  ${c ? '✓' : '✗'} ${n}${c ? '' : ' → ' + JSON.stringify(d)}`); if (!c) fallas.push(n); };
async function abrir(width, height, caso, hora) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, locale: 'es-CO', timezoneId: 'America/Bogota', hasTouch: width < 768, isMobile: width < 768 });
  await ctx.route('**/*', (route) => { const u = route.request().url(); return u.startsWith(`http://localhost:${PORT}`) || /fonts\.(googleapis|gstatic)\.com/.test(u) ? route.continue() : route.abort(); });
  await ctx.addInitScript({ path: FIX });
  await ctx.addInitScript(INYECCION, caso);
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date(`2026-10-12T${hora}:00-05:00`));
  page.on('pageerror', (e) => errores.push(`${width} ${caso}: ${e.message}`));
  await page.goto(`http://localhost:${PORT}/#preview-admin`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('#app-shell.admin-shell') && typeof window.setTab === 'function', null, { timeout: 15000 });
  await page.evaluate(() => window.setTab('routes'));
  await page.waitForSelector('#rv2-list .rv2-row', { timeout: 15000 });
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await page.waitForTimeout(500);
  return { ctx, page };
}
const leer = (page) => page.evaluate(() => [...document.querySelectorAll('#rv2-list .rv2-row')].map((f) => {
  const w = f.querySelector('.when'), r = f.getBoundingClientRect(), g = f.closest('.rv2-gwrap'), tag = f.querySelector('.rj-tag');
  const tr = tag ? tag.getBoundingClientRect() : null;
  return { id: f.dataset.id || f.dataset.sinv || f.dataset.sola || '', sinv: f.classList.contains('rv2-row--sinv'), sola: f.classList.contains('rv2-row--sola'), mad: !!f.closest('.rv2-mad'),
    tipo: (f.querySelector('.rv2-pill') || {}).textContent, cuando: w ? w.innerText.replace(/\n+/g, ' | ') : '', tag: tag ? tag.textContent : '', quien: (f.querySelector('.drv') || {}).textContent || '',
    gente: [...f.querySelectorAll('.rv2-p .nm')].map((x) => x.textContent.trim()), botones: [...f.querySelectorAll('.rj-acts button')].map((b) => b.textContent.trim()),
    hora: g && g.querySelector('.rv2-hour') ? g.querySelector('.rv2-hour').textContent.replace(/\s+/g, ' ').trim() : '',
    cabe: f.scrollWidth <= f.clientWidth + 1, tagVisible: tr ? tr.width > 20 && tr.height > 8 && tr.right <= window.innerWidth + 1 : null, alto: Math.round(r.height), ancho: Math.round(r.width) };
}));
const centrar = (page, sel) => page.evaluate((s) => { const f = document.querySelector(s); if (f) f.scrollIntoView({ block: 'center' }); }, sel);
for (const [w, h, pre] of [[1440, 900, 'pc'], [390, 844, 'cel']]) {
  console.log(`\n== ${pre} ${w}×${h}`);
  { // ANTES: lo que se veía (la captura de Harold): «Sin vuelta · No tiene carro».
    const { ctx, page } = await abrir(w, h, 'antes', '23:00');
    const filas = await leer(page);
    const z = filas.find((f) => f.sinv && f.gente.includes('María Noche'));
    console.log('   antes:', JSON.stringify(z));
    ok('antes: María Noche (23:20) sale «Sin vuelta» en la hora de las 23', !!z && /^23:00/.test(z.hora) && /Sin vuelta/.test(z.cuando), z);
    await centrar(page, '#rv2-list .rv2-row--sinv[data-sinv="rZ"]'); await page.waitForTimeout(300); await page.screenshot({ path: `${OUT}${pre}-1-antes-sin-vuelta.png` });
    await ctx.close();
  }
  { // DESPUÉS: la vuelta de las 00:10 se ve en su día.
    const { ctx, page } = await abrir(w, h, 'despues', '23:00');
    const filas = await leer(page);
    const s = filas.find((f) => f.id === 'ra-sig1');
    console.log('   después:', JSON.stringify(s));
    ok('después: nadie de esa vuelta sale «Sin vuelta»', !filas.some((f) => f.sinv && (f.gente.includes('María Noche') || f.gente.includes('Sara Tarde'))), filas.filter((f) => f.sinv));
    ok('la vuelta va como fila, con sus tres personas', !!s && s.sola && ['Valentina Vanegas', 'María Noche', 'Sara Tarde'].every((n) => s.gente.some((g) => g.startsWith(n))), s);
    ok('…en la hora de las 23 (se lee por el vuelo: 23:20 y 23:50), no en la madrugada de arriba', !!s && /^23:00/.test(s.hora) && /23:20/.test(s.cuando) && /23:50/.test(s.cuando) && !s.mad, s);
    ok('…dice «Sale después de medianoche» y «En espera · la reparte el sistema»', !!s && s.tag === 'Sale después de medianoche' && /En espera · la reparte el sistema/.test(s.quien), s);
    ok('…con «Cambiar hora» y «Asignar conductor»', !!s && s.botones.includes('Cambiar hora') && s.botones.includes('Asignar conductor'), s && s.botones);
    ok('la etiqueta se ve entera y la fila no se desborda', !!s && s.tagVisible === true && s.cabe, s);
    ok('ninguna fila se desborda', filas.every((f) => f.cabe), filas.filter((f) => !f.cabe));
    ok('la página no se desborda a lo ancho', await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
    await centrar(page, '#rv2-list .rv2-row--sola[data-sola="ra-sig1"]'); await page.waitForTimeout(300); await page.screenshot({ path: `${OUT}${pre}-2-despues-fila.png` });
    // «Cambiar hora» abre la hoja de siempre con la hora de la vuelta (00:10).
    await page.click('#rv2-list .rv2-row--sola[data-sola="ra-sig1"] [data-rj-hora]');
    await page.waitForTimeout(500);
    const hoja = await page.evaluate(() => { const x = document.querySelector('#rv2-sheet'); return x && !x.hidden ? { txt: x.innerText.slice(0, 200).replace(/\n+/g, ' | '), val: (x.querySelector('.rj-h-in') || {}).value || null } : null; });
    console.log('   hoja:', JSON.stringify(hoja));
    ok('«Cambiar hora» abre la hoja con la hora real de la vuelta (00:10)', !!hoja && hoja.val === '00:10', hoja);
    await page.screenshot({ path: `${OUT}${pre}-3-cambiar-hora.png` });
    await ctx.close();
  }
  { // AYER: la vuelta de las 00:10 de hoy con gente de ayer.
    const { ctx, page } = await abrir(w, h, 'ayer', '00:05');
    const filas = await leer(page);
    const a = filas.find((f) => f.id === 'ra-ayer');
    console.log('   ayer:', JSON.stringify(a));
    ok('la vuelta de las 00:10 con gente de ayer se ve, en la madrugada, con sus dos personas', !!a && a.sola && a.mad && a.gente.some((g) => g.startsWith('Lina Deayer')) && a.gente.some((g) => g.startsWith('Beto Deayer')) && /00:10/.test(a.cuando), a);
    ok('…dice «Gente de otro día», se ve entera y no se desborda', !!a && a.tag === 'Gente de otro día' && a.tagVisible === true && a.cabe, a);
    ok('la página no se desborda a lo ancho', await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
    await centrar(page, '#rv2-list .rv2-row--sola[data-sola="ra-ayer"]'); await page.waitForTimeout(300); await page.screenshot({ path: `${OUT}${pre}-4-gente-de-ayer.png` });
    await ctx.close();
  }
}
console.log('\nerrores de página:', errores.length ? errores : 'ninguno');
console.log(fallas.length ? `✗ ${fallas.length} fallas` : '✓ todo bien', '· capturas en', OUT);
await browser.close();
srv.kill();
process.exit(fallas.length || errores.length ? 1 : 0);
