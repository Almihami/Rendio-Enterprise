// Operación en vivo en el TELÉFONO (26-oct-2026) — prueba jsdom.
//
// Lo que se vio a 390×860 (Chromium, igual en v213 y v214): la lista de carros
// en una franja de 35 px (solo el borde de la primera tarjeta), el mapa en 0 px
// —un bloque en blanco— y la actividad, que tenía que estar apagada, ocupando
// su fila. Dos causas en styles.css: (1) el corte de ≤1180 que apagaba
// .op-feed estaba escrito ANTES que la base de .op-feed (display:flex) y perdía
// —por eso, entre 769 y 1180 px, la actividad también partía en dos la lista y
// el mapa—; (2) a ≤760 la grilla tenía dos filas y tres hijos.
// Ahora, en el teléfono (≤768), pestañas Carros · Mapa · Actividad.
//
// Comprueba, con los archivos de verdad:
//   A) admin-operacion.js: las pestañas cambian #oper-ui[data-op-vista]; desde
//      el mapa o la actividad se vuelve a Carros con la tarjeta abierta; «Ver en
//      el mapa» lleva al mapa centrado en ese carro; con un carro tarde la
//      pestaña Mapa lleva el punto rojo; el contador de carros.
//   B) styles.css: el orden de las reglas que causó el bug (candado), y que las
//      tres vistas del teléfono existen.
//
// LO QUE NO CUBRE: el layout de verdad (jsdom no lo hace: alturas, que el mapa
// tenga cuadros, que no haya scroll). Eso se miró con Chromium a 360, 375, 390,
// 768, 1024 y 1440 px, y falta verlo en el teléfono del jefe (Safari de iPhone
// con sus barras, el inset del iPhone instalado, el dedo sobre el mapa).
//
//   cd rendio-backend && node scripts/_smoke-operacion-movil-1026-dom.mjs
process.env.TZ = 'America/Bogota';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const FIX = new URL('./fixtures/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null && d !== '' ? ' → ' + d : '')); } };
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// Tres carros inventados (nombres ficticios): uno rodando con GPS, uno sin
// turno ni posición, uno que ya terminó.
const vuelta = (hora, estado) => ({ hora, type: 'sal', estado, paradas: [{ nombre: 'Ana Prueba', lugar: 'Edificio Uno', status: estado === 'ok' ? 'delivered' : 'pending', recogio: '05:10', entrego: '05:40' }], motivos: [], faltan: 1 });
const LIVE = {
  source: 'live', day: '2026-10-26', feed: [],
  cars: [
    { id: 'AAA111', key: 'v:veh-AAA', plate: 'AAA111', driver: 'Carlos Prueba Uno', driverPhone: '300 000 0001', turno: 'abierto', type: 'sal', cap: 4, pax: 1,
      flight: 'AV0001', pres: '10:30', presAt: '2026-10-26T15:30:00Z', next: 'Ana Prueba · Edificio Uno', nextPos: [6.15, -75.37], status: 'Recogiendo',
      ahora: 'Recogiendo · va por Ana Prueba a Edificio Uno', enCurso: true, done: false, resumen: { hechas: 1, conNovedad: 0, sinMarcar: 0, faltan: 1 },
      pos: [6.16, -75.40], posSource: 'gps', posAt: new Date().toISOString(), vueltas: [vuelta('05:00', 'ok'), vuelta('10:00', 'curso')],
      feed: [{ k: 'ok', t: '05:40', h: 'dejó a Ana Prueba en el aeropuerto' }] },
    { id: 'd:dp-b', key: 'd:dp-b', plate: '', driver: 'Beatriz Prueba Dos', driverPhone: '', turno: 'sin', type: 'sal', cap: 4, pax: 0, status: 'Sin iniciar turno',
      ahora: 'Sin iniciar turno · primera vuelta 14:00', enCurso: false, done: false, resumen: { hechas: 0, conNovedad: 0, sinMarcar: 0, faltan: 1 },
      pos: null, vueltas: [vuelta('14:00', 'falta')], feed: [] },
    { id: 'CCC333', key: 'v:veh-CCC', plate: 'CCC333', driver: 'Camilo Prueba Tres', driverPhone: '', turno: 'cerrado', type: 'sal', cap: 4, pax: 0, status: 'Terminó',
      ahora: 'Terminó sus vueltas', enCurso: false, done: true, resumen: { hechas: 1, conNovedad: 0, sinMarcar: 0, faltan: 0 },
      pos: [6.17, -75.42], posSource: 'gps', posAt: new Date().toISOString(), vueltas: [vuelta('03:00', 'ok')], feed: [] },
  ],
};

console.log('\n── A · Pestañas del teléfono: Carros · Mapa · Actividad ──');
{
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const errors = [];
  w.console.error = (...x) => errors.push(x.map((y) => (y && y.message) || String(y)).join(' '));
  w.addEventListener('error', (e) => errors.push(e.message));
  w.state = { activeTab: 'oper', settings: {}, profile: { id: 'jefe', role: 'admin' } };
  w.toast = () => {};
  w.open = () => {};
  w.fetch = async () => { throw new Error('sin red'); };
  w.eval(readFileSync(FIX + 'fake-leaflet.js', 'utf8'));
  let datos = LIVE;
  w.Api = { listLiveOperation: async () => JSON.parse(JSON.stringify(datos)), listOpenRouteRisks: async () => [] };
  w.eval(read('admin-operacion.js') + '\n;window.__O = { opState, loadRealOps, stopOperTimers, renderOperacion, syncOperDelay };');
  w.document.querySelector('section[data-panel="oper"]').classList.remove('hidden');
  const q = (s) => w.document.querySelector(s);
  const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  const O = w.__O;
  const root = q('#oper-ui');
  const tab = (v) => q(`#oper-ui [data-op-tab="${v}"]`);
  const card = (k) => q(`#oper-carlist [data-key="${k}"]`);
  O.renderOperacion();
  await wait(80);

  t('arranca en Carros: #oper-ui[data-op-vista="cars"] y la pestaña marcada', root.dataset.opVista === 'cars' && tab('cars').classList.contains('on') && tab('cars').getAttribute('aria-selected') === 'true');
  t('la pestaña Carros dice cuántos hay (3)', q('#oper-tabN').textContent === '3', q('#oper-tabN').textContent);
  const inval0 = O.opState.map.invalidations || 0;
  click(tab('map')); await wait(60);
  t('tocar «Mapa» cambia la vista y las marcas', root.dataset.opVista === 'map' && tab('map').classList.contains('on') && !tab('cars').classList.contains('on') && tab('cars').getAttribute('aria-selected') === 'false');
  t('…y le pide a Leaflet que vuelva a medir', (O.opState.map.invalidations || 0) > inval0);
  click(tab('feed')); await wait(10);
  t('tocar «Actividad» cambia la vista', root.dataset.opVista === 'feed' && tab('feed').getAttribute('aria-selected') === 'true');
  click(q('#oper-feed [data-op-fs="v:veh-AAA"]')); await wait(10);
  t('tocar un carro en la actividad vuelve a Carros con su tarjeta abierta', root.dataset.opVista === 'cars' && !!card('v:veh-AAA').querySelector('.op-cc-det'));
  const verMapa = card('v:veh-AAA').querySelector('[data-op-mapa]');
  t('el detalle de un carro con GPS trae «Ver en el mapa» junto a «Llamar»', !!verMapa && !!card('v:veh-AAA').querySelector('.op-det-acts [data-op-call]'));
  click(verMapa); await wait(60);
  const ctr = O.opState.map.getCenter();
  t('«Ver en el mapa» lleva a la pestaña del mapa, centrado en ese carro', root.dataset.opVista === 'map' && ctr && ctr.lat === 6.16 && ctr.lng === -75.40 && O.opState.map.getZoom() >= 14, ctr && `${ctr.lat},${ctr.lng} z${O.opState.map.getZoom()}`);
  O.opState.markers.AAA111.fire('click'); await wait(10);
  t('tocar el carro en el mapa vuelve a Carros con su tarjeta abierta', root.dataset.opVista === 'cars' && !!card('v:veh-AAA').querySelector('.op-cc-det'));
  click(card('d:dp-b').querySelector('.op-cc-top')); await wait(10);
  t('sin posición no hay «Ver en el mapa» (no hay a dónde llevar)', !!card('d:dp-b').querySelector('.op-cc-det') && !card('d:dp-b').querySelector('[data-op-mapa]'));
  t('tocar la tarjeta desde Carros no cambia de pestaña', root.dataset.opVista === 'cars');

  O.opState.cars[0].state = 'late'; O.opState.cars[0].lateMin = 7; O.opState.cars[0].arrival = '10:37';
  O.syncOperDelay();
  t('con un carro tarde, la pestaña «Mapa» lleva el punto rojo y lo dice', tab('map').classList.contains('alerta') && tab('map').getAttribute('aria-label') === 'Mapa: un carro va tarde' && q('#oper-delay').classList.contains('show'));
  O.opState.cars[0].state = 'ontime'; O.syncOperDelay();
  t('…y se quita cuando ya nadie va tarde', !tab('map').classList.contains('alerta') && !tab('map').hasAttribute('aria-label'));

  datos = { source: 'live', day: '2026-10-26', cars: [], feed: [] };
  await O.loadRealOps(); await wait(10);
  t('sin carros, el contador de la pestaña queda vacío (no «0»)', q('#oper-tabN').textContent === '' && /No hay carros en operación/.test(q('#oper-carlist').textContent));
  O.stopOperTimers();
  t('sin errores de consola', errors.length === 0, errors.slice(0, 3).join(' | '));
}

console.log('\n── B · styles.css: el orden que causó el bug y las vistas del teléfono ──');
{
  const css = read('styles.css');
  const base = css.indexOf('#oper-ui .op-feed{background');
  const corte = css.indexOf('@media(max-width:1180px){\n  #oper-ui .op-stage');
  t('el corte de ≤1180 de .op-stage está DESPUÉS de la base de .op-feed (si no, pierde)', base > 0 && corte > base, `base ${base} · corte ${corte}`);
  t('ya no hay una regla que apague la actividad (dejaba sin los avisos del vigilante)', !/#oper-ui \.op-feed\{display:none\}/.test(css));
  t('no queda el corte de 760 px de Operación (el canon es 1180 / 900 / 768)', !/max-width:760px\)\{#oper-ui/.test(css));
  t('el teléfono tiene las tres vistas (Carros, Mapa, Actividad)', ['cars"] .op-stage > .op-cars', 'map"] .op-stage > .op-mapwrap', 'feed"] .op-stage > .op-feed'].every((s) => css.includes('#oper-ui[data-op-vista="' + s)));
  t('las vistas ocultas usan visibility (el mapa no se queda en 0×0)', /\.op-stage > \.op-feed \{ position: absolute; inset: 0; border: 0; visibility: hidden; \}/.test(css) && !/data-op-vista[^{]*\{[^}]*display:\s*none/.test(css));
  const html = read('index.html');
  t('index.html: #oper-ui arranca en la vista de Carros y trae las tres pestañas', /id="oper-ui"[^>]*data-op-vista="cars"/.test(html) && ['cars', 'map', 'feed'].every((v) => html.includes(`data-op-tab="${v}"`)));
}

console.log(`\n${ok}/${ok + bad} pasaron`);
console.log('NO cubierto: el layout real (alturas, cuadros del mapa, scroll) — mirado con Chromium a 360/375/390/768/1024/1440; falta el teléfono del jefe.');
process.exit(bad ? 1 : 0);
