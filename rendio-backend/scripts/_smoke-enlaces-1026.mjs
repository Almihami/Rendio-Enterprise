// Enlaces de las notificaciones nuevas del 26-oct-2026 — prueba de applyDeepLink
// (core.js DE VERDAD: se saca la función del archivo y se corre con dobles).
//
//   · «✅ X terminó una vuelta» (0128) → #/operacion abre Operación ('oper').
//   · «Nadie ha tomado una vuelta» (0125/0126) → #/rutas abre Asignación ('routes');
//     hasta el 26-oct ese enlace no abría nada.
//   · «📋 El Excel de mañana está listo» (0130) → #/rutas?excel=AAAA-MM-DD abre
//     Asignación y le pide a admin-ruta-julian.js el Excel de ESE día.
//   · Lo de antes sigue igual (#/vuelos, #/reservas?chat=); un tripulante no entra
//     por aquí; el hash se limpia.
//
// NO cubre: el service worker que abre la app al tocar la notificación, ni la
// descarga real en un teléfono (iOS puede pedir un toque: para eso queda el botón).
//
//   cd rendio-backend && node scripts/_smoke-enlaces-1026.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const src = readFileSync(APP + 'core.js', 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null && d !== '' ? ' → ' + d : '')); } };
const wait = (ms = 20) => new Promise(r => setTimeout(r, ms));
const i0 = src.indexOf('  function applyDeepLink() {');
const i1 = src.indexOf('\n  }\n', i0);
const fn = i0 >= 0 && i1 > i0 ? src.slice(i0, i1 + 4) : null;
t('core.js trae applyDeepLink', !!fn);

function run(hash, role = 'admin') {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'http://localhost/' + hash });
  const w = dom.window;
  const tabs = [], excel = [];
  w.__tabs = tabs;
  w.state = { profile: { role } };
  w.evtState = {}; w.rvState = {};
  w.setTab = (n) => tabs.push(n);
  w.renderVuelos = () => {};
  w.RendioRutaJulian = { ofrecer: (d) => excel.push(d) };
  w.eval(fn + '\n;window.__r = applyDeepLink();');
  return { w, tabs, excel, r: w.__r };
}

console.log('\n── Los enlaces nuevos ──');
{
  const a = run('#/operacion');
  t('#/operacion abre Operación', a.r === true && a.tabs.join() === 'oper', a.tabs.join());
  const b = run('#/rutas');
  t('#/rutas abre Asignación (antes no abría nada)', b.r === true && b.tabs.join() === 'routes', b.tabs.join());
  t('…sin pedir Excel', b.excel.length === 0);
  const c = run('#/rutas?excel=2026-11-02');
  await wait(10);
  t('#/rutas?excel=2026-11-02 abre Asignación y pide el Excel de ESE día', c.tabs.join() === 'routes' && c.excel.join() === '2026-11-02', JSON.stringify([c.tabs, c.excel]));
  t('y limpia el hash (un refresco no lo vuelve a descargar)', c.w.location.hash === '', c.w.location.hash);
}

console.log('\n── Lo de antes sigue igual ──');
{
  const v = run('#/vuelos');
  t('#/vuelos abre Vuelos', v.tabs.join() === 'vuelos');
  const r = run('#/reservas?chat=abc');
  t('#/reservas?chat= abre Reservas con el hilo', r.tabs.join() === 'reservas' && r.w.rvState.focusChatId === 'abc');
  const x = run('#/rutas?excel=2026-11-02', 'auxiliar');
  await wait(10);
  t('un tripulante no entra por aquí (ni pestaña ni Excel)', x.r === false && x.tabs.length === 0 && x.excel.length === 0);
  const n = run('#/nada');
  t('un enlace desconocido no hace nada', n.r === false && n.tabs.length === 0);
}

console.log(`\n${ok}/${ok + bad} pasaron${bad ? ' · ' + bad + ' FALLARON' : ''}`);
console.log('NO cubierto: el service worker al tocar la notificación ni la descarga real en el teléfono.');
process.exit(bad ? 1 : 0);
