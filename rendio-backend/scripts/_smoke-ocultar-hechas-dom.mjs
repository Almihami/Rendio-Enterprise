// Las vueltas que el conductor ya hizo se guardan (26-oct-2026) — prueba jsdom.
//
// Pedido de la profa: «los conductores están viendo las rutas que ya hicieron;
// en todos los lugares donde aparecen deberían ocultarse, que se puedan mostrar
// cuando quieran, pero que se vayan ocultando».
// Dónde aparecían: Inicio («Tu día», todas las del día, también las «Terminada»,
// antes de las que faltan) y la Ruta («Mi día», sección «Completadas» abierta).
//
// Comprueba, con los archivos de verdad (driver-tabs.js + driver-disponibilidad.js
// para avIcon, aux-rx-ui.js + driver-rutas.js):
//   A) Inicio: solo las que faltan; «N vueltas hechas · Toca para verlas» las
//      muestra y las vuelve a guardar; al volver a Inicio están guardadas; todas
//      hechas → «Terminaste tus vueltas de hoy».
//   B) Mi día: «Completadas · N · Ver» cerrada; abre y cierra; al volver a entrar
//      a la ruta está cerrada; la barra de avance sigue contando las hechas.
//
// LO QUE NO CUBRE: el layout (mirado con Chromium a 390 px) ni el teléfono.
//
//   cd rendio-backend && node scripts/_smoke-ocultar-hechas-dom.mjs
process.env.TZ = 'America/Bogota';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null && d !== '' ? ' → ' + d : '')); } };
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const tx = (e) => (e ? e.textContent.replace(/\s+/g, ' ').trim() : '');

const MIN = 60000, NOW = Date.now();
const iso = (m) => new Date(NOW + m * MIN).toISOString();
const hm = (m) => new Date(NOW + m * MIN).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false });
const dia = (m) => new Date(NOW + m * MIN).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
const leg = (o) => Object.assign({ kind: 'pickup', lat: 6.15, lng: -75.37, addr: 'Olivar', unit: '', flight: '', dl: '', phone: '', notes: '', bags: null, quiet: false,
  meetCode: '12', meetingPoint: '', level: 'shared', privateStatus: null, stopStatus: 'pending', pickup: '', eta: '' }, o);
const APT = { kind: 'airport', name: 'Aeropuerto JMC', addr: 'Terminal', lat: 6.1715, lng: -75.427 };
const vuelta = (id, m, hecha) => ({ id, type: 'sal', start: hm(m), startAt: iso(m), done: hecha, assignmentId: 'A' + id, day: dia(m), opDay: dia(0), legs: [
  leg({ name: 'Persona ' + id, reservationId: 'R' + id, stopStatus: hecha ? 'delivered' : 'pending', dl: hm(m + 60) }), APT] });
let VUELTAS = [vuelta('V1', -300, true), vuelta('V2', -180, true), vuelta('V3', 40, false), vuelta('V4', 160, false)];

function boot() {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const errores = [];
  w.addEventListener('error', (e) => errores.push(e.message));
  w.console.error = (...x) => errores.push(x.map((y) => (y && y.message) || String(y)).join(' '));
  w.RENDIO_CONFIG = {}; w.toast = () => {}; w.L = undefined;
  w.escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  w.$ = (s) => w.document.querySelector(s); w.$$ = (s) => w.document.querySelectorAll(s);
  w.Element.prototype.scrollIntoView = function () {};
  w.fetch = async () => { throw new Error('sin red'); };
  w.state = { settings: { aux_wait_minutes: 5 }, profile: { id: 'pD', full_name: 'Jorge Prueba', role: 'driver' } };
  w.Api = { listMyVueltasForDriver: async () => JSON.parse(JSON.stringify(VUELTAS)), driverOpenRoutes: async () => [],
    getMyDriverProfileId: async () => 'DP1', countUnreadMessages: async () => ({}), sendDriverLocation: async () => {} };
  for (const f of ['driver-disponibilidad.js', 'driver-tabs.js', 'aux-rx-ui.js', 'driver-rutas.js']) {
    try { w.eval(read(f)); } catch (e) { errores.push(f + ': ' + e.message); }
  }
  w.DriverRutas.background = () => {}; w.DriverRutas.deepLink = () => {};
  return { w, errores };
}

console.log('\n── A · Inicio: «Tu día» muestra lo que falta; lo hecho, con un toque ──');
{
  const { w, errores } = boot();
  const box = () => w.document.getElementById('driver-home-ruta');
  const cards = () => [...box().querySelectorAll('[data-vuelta]')];
  await w.eval('renderDriverHomeRuta()'); await wait(40);
  t('solo las 2 que faltan (las terminadas no salen)', cards().length === 2 && !/Terminada/.test(tx(box())), tx(box()).slice(0, 200));
  t('«Iniciar ruta» sigue con la primera que falta', /Iniciar ruta · /.test(tx(box())) && box().querySelector('[data-vuelta-start="AV3"]'));
  const tg = () => box().querySelector('[data-vuelta-hechas]');
  t('abajo: «2 vueltas hechas · Toca para verlas», cerrado', tg() && /2 vueltas hechas/.test(tx(tg())) && /Toca para verlas/.test(tx(tg())) && tg().getAttribute('aria-expanded') === 'false', tx(tg()));
  tg().click(); await wait(10);
  t('tocar las muestra (debajo, con «Terminada»)', cards().length === 4 && /Terminada/.test(tx(box())) && /Toca para ocultarlas/.test(tx(tg())) && tg().getAttribute('aria-expanded') === 'true');
  t('…y las hechas quedan después del botón (lo que falta sigue arriba)', cards().slice(2).every((c) => /Terminada/.test(tx(c))));
  tg().click(); await wait(10);
  t('tocar otra vez las guarda', cards().length === 2);
  tg().click(); await wait(10);
  await w.eval('renderDriverHomeRuta()'); await wait(40);
  t('al volver a Inicio vuelven a estar guardadas', cards().length === 2 && tg().getAttribute('aria-expanded') === 'false');
  VUELTAS = VUELTAS.map((v) => Object.assign({}, v, { done: true }));
  await w.eval('renderDriverHomeRuta()'); await wait(40);
  t('todas hechas: «Terminaste tus vueltas de hoy» y «4 vueltas hechas»', cards().length === 0 && /Terminaste tus vueltas de hoy/.test(tx(box())) && /4 vueltas hechas/.test(tx(tg())));
  VUELTAS = [vuelta('V1', -300, true), vuelta('V2', -180, true), vuelta('V3', 40, false), vuelta('V4', 160, false)];
  VUELTAS.splice(0, 2);
  await w.eval('renderDriverHomeRuta()'); await wait(40);
  t('sin ninguna hecha: no sale el botón', !tg() && cards().length === 2);
  t('sin errores de script', errores.length === 0, errores.join(' | '));
}

console.log('\n── B · La Ruta («Mi día»): «Completadas» cerrada ──');
{
  VUELTAS = [vuelta('V1', -300, true), vuelta('V2', -180, true), vuelta('V3', 40, false), vuelta('V4', 160, false)];
  const { w, errores } = boot();
  const root = () => w.document.getElementById('driver-ruta-root');
  const q = (s) => root().querySelector(s);
  const vcs = () => [...root().querySelectorAll('#rt-base .rt-vc')];
  await w.DriverRutas.open(w.state.profile); await wait(80);
  const tg = () => q('.rt-donetg');
  t('«Completadas · 2 · Ver», cerrada: solo se ve «Más tarde» (V4)', tg() && /Completadas · 2/.test(tx(tg())) && /Ver/.test(tx(tg())) && tg().getAttribute('aria-expanded') === 'false' && vcs().map((x) => x.dataset.v).join() === 'V4', vcs().map((x) => x.dataset.v).join());
  t('la barra de avance sigue contando las hechas («2 de 4 vueltas»)', /2 de 4 vueltas/.test(tx(q('.rt-dayprog'))));
  tg().click(); await wait(20);
  t('tocar «Ver» las muestra, con «Hecha», y el botón dice «Ocultar»', vcs().map((x) => x.dataset.v).join() === 'V4,V1,V2' && /Hecha/.test(tx(vcs()[1])) && /Ocultar/.test(tx(tg())) && tg().getAttribute('aria-expanded') === 'true');
  tg().click(); await wait(20);
  t('tocar «Ocultar» las guarda', vcs().length === 1);
  tg().click(); await wait(20);
  w.DriverRutas.close(); await wait(10);
  await w.DriverRutas.open(w.state.profile); await wait(80);
  t('al volver a entrar a la ruta están guardadas otra vez', vcs().length === 1 && tg().getAttribute('aria-expanded') === 'false');
  t('una hecha se sigue abriendo («Vuelta completada»)', (() => { tg().click(); const c = vcs().find((x) => x.dataset.v === 'V1'); return c && c.dataset.rt === 'done'; })());
  w.DriverRutas.close();
  t('sin errores de script', errores.length === 0, errores.join(' | '));
}

console.log(`\n${ok}/${ok + bad} pasaron`);
console.log('NO cubierto: el layout (mirado con Chromium a 390 px) ni el teléfono del conductor.');
process.exit(bad ? 1 : 0);
