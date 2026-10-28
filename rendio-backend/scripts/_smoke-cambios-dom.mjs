// «CAMBIOS» DE LOS TRIPULANTES (0153, 28-oct-2026) — prueba jsdom de admin-cambios.js
// sobre Asignación de verdad (index.html + admin-consola.js + admin-rutas.js +
// admin-rutas-v2.js + admin-cambios.js) con el día de fixtures/rutas-v2-dia.js y un
// Api.listCrewChanges FALSO.
//
// Camilo: «necesito una opción que me muestre los cambios que hacen los TC, porque
// no me estoy dando cuenta de los cambios en la programación».
//
// Comprueba: el botón con el número de cambios NUEVOS (solo los del tripulante y
// después del corte), la hoja con qué cambió y cómo quedó en el tablero (en qué
// carro va, sin carro → «Ubicar», pidió después de abrir el día / canceló y sigue en
// el tablero → «Recargar el día»), lo de antes del corte plegado, que al abrirla se
// marca como visto, y que sin 0153 el botón no sale.
//
// LO QUE NO CUBRE: la base (admin_cambios_tripulantes y el trigger: eso es
// _aplicar-0153.mjs en seco contra dev) y el layout real.
//
//   cd rendio-backend && node scripts/_smoke-cambios-dom.mjs
process.env.TZ = 'America/Bogota';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const FIX = new URL('./fixtures/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null && d !== '' ? ' → ' + d : '')); } };
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);

async function boot(cambios) {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const errors = [], pedidos = [];
  w.console.error = (...a) => { errors.push(a.map((x) => (x && x.message) || String(x)).join(' ')); };
  w.addEventListener('error', (e) => errors.push(e.message));
  w.RENDIO_CONFIG = {};
  w.state = { settings: { route_traffic_factor: 1 }, profile: { id: 'jefe', role: 'admin' } };
  w.toast = () => {}; w.confirm = () => true;
  w.escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  w.$ = (s) => w.document.querySelector(s); w.$$ = (s) => w.document.querySelectorAll(s);
  w.fetch = async () => { throw new Error('sin red'); };
  w.eval(readFileSync(FIX + 'fake-leaflet.js', 'utf8'));
  w.eval(readFileSync(FIX + 'rutas-v2-dia.js', 'utf8'));
  w.RV2Fixture.instalarFetch(w);
  w.Api = {};
  const log = w.RV2Fixture.instalar(w.Api, {});
  w.Api.listCrewChanges = async (d0, d1) => { pedidos.push([d0, d1]); return typeof cambios === 'function' ? cambios() : cambios; };
  try {
    w.eval(read('admin-consola.js') + '\n' + read('admin-rutas.js') + '\n' + read('admin-rutas-v2.js') + '\n' + read('admin-cambios.js')
      + '\n;window.__T = { rt, renderRoutes };');
  } catch (e) { errors.push('eval: ' + e.message); }
  w.document.querySelector('section[data-panel="routes"]').classList.remove('hidden');
  const q = (s) => w.document.querySelector(s);
  const qa = (s) => [...w.document.querySelectorAll(s)];
  const click = (el) => { if (!el) throw new Error('no existe el elemento'); el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })); };
  await w.__T.renderRoutes();
  await wait(60);
  return { w, log, errors, pedidos, q, qa, click, C: () => w.RendioCambios, rt: () => w.__T.rt };
}

const DAY = '2026-10-12';
const at = (hm, dia = DAY) => new Date(`${dia}T${hm}:00-05:00`).toISOString().replace('Z', '+00:00');
// Lo que devuelve admin_cambios_tripulantes (la forma de 0153).
const FILAS = [
  // Manuela (sin carro en el tablero) pidió tarde.
  { id: 'c1', at: at('06:10'), rid: 'res-N', kind: 'nuevo', before: null, after: { when: at('09:10') }, by_owner: true, name: 'Manuela Franco', dir: 'sal', when: at('09:10'), cancelled: false, tarde: true, vuelta: null },
  // Natalia cambió el vuelo (va en V-01 en el tablero).
  { id: 'c2', at: at('05:30'), rid: 'res-F', kind: 'vuelo', before: { vuelo: 'AV9412', when: at('15:00') }, after: { vuelo: 'AV9418', when: at('15:40') }, by_owner: true, name: 'Natalia Duque', dir: 'lle', when: at('15:40'), cancelled: false, tarde: true, vuelta: null },
  // Mateo canceló, y el tablero (abierto antes) todavía lo tiene.
  { id: 'c3', at: at('05:00'), rid: 'res-I', kind: 'cancelado', before: { when: at('09:00') }, after: { motivo: 'me cambiaron la programación' }, by_owner: true, name: 'Mateo Zapata', dir: 'sal', when: at('09:00'), cancelled: true, tarde: true, vuelta: null },
  // Alguien que pidió después de abrir el día (no está en el tablero).
  { id: 'c4', at: at('07:20'), rid: 'res-NUEVA', kind: 'nuevo', before: null, after: { when: at('12:00') }, by_owner: true, name: 'Isabella Páez Gómez', dir: 'sal', when: at('12:00'), cancelled: false, tarde: true, vuelta: null },
  // Lo hizo Coordinación: no sale.
  { id: 'c5', at: at('07:30'), rid: 'res-A', kind: 'hora', before: { when: at('05:00') }, after: { when: at('05:20') }, by_owner: false, actor_role: 'admin', name: 'Laura Gómez', dir: 'sal', when: at('05:20'), cancelled: false, tarde: true, vuelta: null },
  // Antes del corte (ya venía en el Excel): plegado.
  { id: 'c6', at: at('15:00', '2026-10-11'), rid: 'res-C', kind: 'nuevo', before: null, after: { when: at('06:30') }, by_owner: true, name: 'José Ñáñez', dir: 'sal', when: at('06:30'), cancelled: false, tarde: false, vuelta: null },
];

console.log('\n── El botón y la hoja ──');
{
  const E = await boot(FILAS);
  const { q, qa, click, pedidos, w } = E;
  const b = q('#rv2-cambios');
  t('la barra trae «Cambios» antes de la Ruta de Julián', !!b && /Cambios/.test(txt(b)) && b.nextElementSibling && b.nextElementSibling.id !== 'rv2-cambios');
  t('pide los cambios del día (00:00 → 4:00 del día siguiente)', pedidos.length >= 1 && pedidos[0][0] === new Date(DAY + 'T00:00:00-05:00').toISOString() && pedidos[0][1] === new Date('2026-10-13T04:00:00-05:00').toISOString(), JSON.stringify(pedidos[0]));
  t('el número dice 4 nuevos (los del tripulante y después del corte; no el de Coordinación ni el de antes)', txt(b.querySelector('.rv2-badge')) === '4' && !b.querySelector('.rv2-badge').hidden && b.classList.contains('is-new'), txt(b));
  click(b); await wait(40);
  const sh = q('#rv2-sheet');
  t('abre «Cambios de los tripulantes · lun 12 oct»', !sh.hidden && /Cambios de los tripulantes · lun 12 oct/.test(txt(sh)), txt(sh) && txt(sh).slice(0, 80));
  const filas = qa('#rc-body .rc-list:not(.rc-list--antes) .rc-row');
  t('4 filas, lo más nuevo arriba, todas con «Nuevo»', filas.length === 4 && /Isabella/.test(txt(filas[0])) && filas.every((f) => f.classList.contains('is-new')), filas.map(txt).join(' | '));
  const fila = (n) => filas.find((f) => txt(f).includes(n));
  t('Manuela: «Pidió una salida: presentación 9:10» · «Sin carro en el tablero» con «Ubicar»', /Pidió una salida: presentación 9:10/.test(txt(fila('Manuela'))) && /Sin carro en el tablero/.test(txt(fila('Manuela'))) && !!fila('Manuela').querySelector('[data-act="route"][data-crew="rN"]'), txt(fila('Manuela')));
  t('Natalia: «Cambió su vuelo: AV9412 → AV9418 · 15:00 → 15:40» y «Va en V-01 …»', /Cambió su vuelo: AV9412 → AV9418 · 15:00 → 15:40/.test(txt(fila('Natalia'))) && /Va en V-01/.test(txt(fila('Natalia'))), txt(fila('Natalia')));
  t('Mateo: «Canceló su salida de las 9:00: «me cambiaron…»» y avisa que en el tablero sigue (Recargar)', /Canceló su salida de las 9:00: «me cambiaron la programación»/.test(txt(fila('Mateo'))) && /Ya no va, pero en tu tablero sigue en V-03/.test(txt(fila('Mateo'))) && !!fila('Mateo').querySelector('[data-cambios="recargar"]'), txt(fila('Mateo')));
  t('Isabella: pidió después de abrir el día → «Recargar el día»', /Pidió después de que abriste el día/.test(txt(fila('Isabella'))) && !!fila('Isabella').querySelector('[data-cambios="recargar"]'), txt(fila('Isabella')));
  t('lo de Coordinación (Laura) no sale', !qa('#rc-body .rc-row').some((f) => /Laura/.test(txt(f))));
  const antes = q('#rc-body [data-cambios="antes"]');
  t('lo de antes del corte va plegado: «Ver 1 de antes del corte (ya venían en el Excel)»', !!antes && /Ver 1 de antes del corte/.test(txt(antes)) && !q('#rc-body .rc-list--antes'), antes && txt(antes));
  click(antes); await wait(10);
  t('…y se despliega (José)', !!q('#rc-body .rc-list--antes') && /José/.test(txt(q('#rc-body .rc-list--antes'))));
  t('al abrirla queda visto: el número se apaga', q('#rv2-cambios .rv2-badge').hidden, txt(q('#rv2-cambios')));
  // «Ubicar» abre la hoja de siempre para ubicar a Manuela.
  // (la hoja se repintó al desplegar: se busca la fila de nuevo)
  const ubicar = qa('#rc-body .rc-row').find((f) => /Manuela/.test(txt(f))).querySelector('[data-act="route"]');
  click(ubicar); await wait(20);
  t('«Ubicar» abre la hoja de ubicar de Asignación', /Manuela/.test(txt(q('#rv2-sheet'))) && !q('#rc-body'), txt(q('#rv2-sheet')) && txt(q('#rv2-sheet')).slice(0, 80));
  t('sin errores de script', E.errors.length === 0, E.errors.join(' | '));
}

console.log('\n── Lo que llega después ──');
{
  let filas = FILAS.slice(0, 1);
  const E = await boot(() => filas);
  const { q, click, C } = E;
  t('1 nuevo al entrar', txt(q('#rv2-cambios .rv2-badge')) === '1');
  click(q('#rv2-cambios')); await wait(40);
  click(q('#rv2-sheet [data-act="sclose"]')); await wait(10);
  t('visto: sin número', q('#rv2-cambios .rv2-badge').hidden);
  // Un cambio nuevo, en el reloj de 90 s (aquí se lee a mano).
  filas = [{ ...FILAS[1], at: new Date(Date.now() + 60000).toISOString() }].concat(filas);
  await C().leer(E.rt().day, true); await wait(10);
  t('llega otro cambio: vuelve el número (1)', txt(q('#rv2-cambios .rv2-badge')) === '1' && !q('#rv2-cambios .rv2-badge').hidden, txt(q('#rv2-cambios')));
  t('sin errores de script', E.errors.length === 0, E.errors.join(' | '));
}

console.log('\n── Sin 0153 en la base ──');
{
  const E = await boot(null);
  t('el botón no sale (Api.listCrewChanges → null)', E.q('#rv2-cambios').hidden === true);
  t('sin errores de script', E.errors.length === 0, E.errors.join(' | '));
}

console.log(`\n${ok}/${ok + bad} pasaron${bad ? ` · ${bad} FALLARON` : ''}`);
console.log('NO cubierto: la base (admin_cambios_tripulantes, el trigger de reservations: _aplicar-0153.mjs), el layout real y el reloj de 90 s.');
process.exit(bad ? 1 : 0);
