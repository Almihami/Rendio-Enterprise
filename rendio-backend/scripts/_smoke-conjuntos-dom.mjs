// Rutas › Configuración › Conjuntos (0112, 14-oct-2026), en jsdom.
//
//   1. Lo cableado: la sección en index.html, el script y el CSS, el menú de
//      Rutas › Configuración, core.js (setTab → renderConjuntos) y sw.js (v180 o
//      más, con los dos archivos en el APP_SHELL).
//   2. La lista: activos / desactivados con su número, tripulantes por conjunto,
//      buscador sin tildes ni mayúsculas.
//   3. Agregar: el botón queda apagado hasta tener nombre y pin; el pin sale de
//      tocar el mapa o de pegar la coordenada de Google Maps; un punto fuera de la
//      caja de 0055 se rechaza; nombre repetido se avisa antes de ir a la base;
//      guarda con createResidence y recarga.
//   4. Editar: tocar un punto del mapa abre ese conjunto; mover el pin dice
//      cuántos viajes ya pedidos se actualizan; guarda SOLO lo que cambió; el error
//      de la base se ve en el editor; Escape cierra.
//   5. Desactivar con confirmación que nombra a quienes viven ahí; reactivar desde
//      «Desactivados» sin preguntar.
//
// NO cubre: el mapa real (Leaflet va simulado: aquí no hay calles ni arrastre de
// verdad), el layout (jsdom no pinta) ni la base (eso es _verify-0112.mjs).
//
//   cd rendio-backend/scripts && node _smoke-conjuntos-dom.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d = '') => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d !== '' ? ' → ' + d : '')); } };
const esperaMucho = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); };

// ── 1. Lo cableado ──────────────────────────────────────────────────────────
console.log('Cableado');
const html = read('index.html'), sw = read('sw.js'), core = read('core.js'), consola = read('admin-consola.js');
t('index.html: sección data-panel="conjuntos" con #conjuntos-ui.set-ui y #cj-root', /<section data-panel="conjuntos"[\s\S]*?id="conjuntos-ui" class="set-ui"[\s\S]*?id="cj-root"/.test(html));
t('index.html: carga admin-conjuntos.js y admin-conjuntos.css', /<script src="admin-conjuntos\.js"><\/script>/.test(html) && /href="admin-conjuntos\.css"/.test(html));
t('sw.js: v180 o más y los dos archivos en el APP_SHELL', Number((sw.match(/CACHE_VERSION = 'rendio-turnos-v(\d+)'/) || [])[1]) >= 180 && /'\/admin-conjuntos\.js'/.test(sw) && /'\/admin-conjuntos\.css'/.test(sw));
t('menú: «Conjuntos» en Rutas › Configuración, junto a Calibración', /id: 'cfg'[\s\S]*?id: 'calib'[\s\S]*?id: 'conjuntos', name: 'Conjuntos'[\s\S]*?tab: 'conjuntos'/.test(consola));
t('core.js: setTab(\'conjuntos\') llama a renderConjuntos (con guarda)', /name === 'conjuntos'\) \{ if \(typeof window\.renderConjuntos === 'function'\) window\.renderConjuntos\(\); \}/.test(core));

// ── El montaje ──────────────────────────────────────────────────────────────
const CATALOGO = () => [
  { id: 'r-olivar', name: 'El Olivar', latitude: 6.1523, longitude: -75.3781, access_note: 'Portería 2', is_active: true, zona_jefe: null },
  { id: 'r-cambulo', name: 'Cámbulo', latitude: 6.1488, longitude: -75.3902, access_note: null, is_active: true, zona_jefe: 'Porvenir' },
  { id: 'r-forest', name: 'Forest', latitude: 6.1301, longitude: -75.4102, access_note: null, is_active: true, zona_jefe: null },
  { id: 'r-viejo', name: 'Conjunto Viejo', latitude: 6.1600, longitude: -75.3700, access_note: null, is_active: false, zona_jefe: null },
];

function fakeL(log) {
  const ev = () => { const h = {}; return { on(n, f) { (h[n] = h[n] || []).push(f); return this; }, fire(n, e) { (h[n] || []).forEach((f) => f(e)); } }; };
  return {
    map(el) { const m = Object.assign(ev(), { el, z: 13, setView(c, z) { m.center = c; m.z = z; return m; }, getZoom() { return m.z; }, fitBounds(b) { m.bounds = b; return m; }, invalidateSize() {} }); log.map = m; return m; },
    tileLayer() { return { addTo() { return this; } }; },
    layerGroup() { const g = { items: [], addTo() { return g; }, clearLayers() { g.items = []; } }; log.puntos = g; return g; },
    circleMarker(ll, o) { const c = Object.assign(ev(), { ll, o, bindTooltip(tx) { c.tip = tx; return c; }, addTo(g) { g.items.push(c); return c; } }); return c; },
    marker(ll, o) { const mk = Object.assign(ev(), { ll, o, getLatLng() { return { lat: mk.ll[0], lng: mk.ll[1] }; }, addTo() { log.pin = mk; return mk; }, remove() { if (log.pin === mk) log.pin = null; } }); return mk; },
    divIcon(o) { return o; },
  };
}

async function montar() {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window, d = w.document;
  const log = { calls: [], toasts: [], confirms: [] };
  w.toast = (m) => log.toasts.push(m);
  w.__confirm = [];
  w.confirm = (m) => { log.confirms.push(m); return w.__confirm.length ? w.__confirm.shift() : true; };
  w.L = fakeL(log);
  w.__cat = CATALOGO();
  w.__fallar = null;
  w.Api = {
    listResidencesAdmin: async () => { log.calls.push(['list']); return JSON.parse(JSON.stringify(w.__cat)); },
    residenceMemberCounts: async () => ({ 'r-olivar': 3, 'r-cambulo': 1, 'r-viejo': 2 }),
    countUpcomingTripsAt: async (id) => { log.calls.push(['count', id]); return id === 'r-olivar' ? 2 : 0; },
    createResidence: async (o) => {
      log.calls.push(['create', o]);
      if (w.__fallar) { const e = new Error(w.__fallar); w.__fallar = null; throw e; }
      w.__cat.push({ id: 'r-nuevo', name: o.name, latitude: o.latitude, longitude: o.longitude, access_note: o.accessNote || null, is_active: true, zona_jefe: null });
      return 'r-nuevo';
    },
    updateResidence: async (id, p) => {
      log.calls.push(['update', id, p]);
      if (w.__fallar) { const e = new Error(w.__fallar); w.__fallar = null; throw e; }
      const r = w.__cat.find((x) => x.id === id); Object.assign(r, p);
    },
  };
  w.eval(read('admin-conjuntos.js'));
  await w.renderConjuntos();
  await esperaMucho();
  return { w, d, log, q: (s) => d.querySelector(s), qa: (s) => [...d.querySelectorAll(s)] };
}
const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const click = (w, el) => el && el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const escribir = (w, el, v) => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };

// ── 2. La lista ─────────────────────────────────────────────────────────────
console.log('Lista');
{
  const { w, q, qa, log } = await montar();
  t('el resumen cuenta activos y desactivados', /3 conjuntos activos · 1 desactivado/.test(txt(q('#cj-resumen'))), txt(q('#cj-resumen')));
  t('filtro «Activos 3 · Desactivados 1», Activos encendido', qa('#cj-filtro button').map(txt).join('|') === 'Activos 3|Desactivados 1' && q('#cj-filtro [data-v="activos"]').classList.contains('on'), qa('#cj-filtro button').map(txt).join('|'));
  t('la lista muestra solo los activos, con sus tripulantes y la nota', qa('.cj-row').length === 3 && txt(q('.cj-row[data-id="r-olivar"] small')) === '3 tripulantes · Portería 2' && txt(q('.cj-row[data-id="r-forest"] small')) === '0 tripulantes', txt(q('.cj-row[data-id="r-olivar"] small')));
  t('el mapa pinta un punto por conjunto activo y se encuadra', log.puntos.items.length === 3 && !!log.map.bounds);
  escribir(w, q('#cj-q'), 'CAMBULO');
  t('buscar sin tildes ni mayúsculas: «CAMBULO» encuentra «Cámbulo»', qa('.cj-row').length === 1 && !!q('.cj-row[data-id="r-cambulo"]'));
  escribir(w, q('#cj-q'), 'zzz');
  t('sin resultados lo dice', /Ningún conjunto con ese nombre/.test(txt(q('#cj-lista'))));
  escribir(w, q('#cj-q'), '');
  click(w, q('#cj-filtro [data-v="inactivos"]'));
  t('«Desactivados»: solo el desactivado, con «Reactivar» (sin Editar)', qa('.cj-row').length === 1 && !!q('.cj-row.off[data-id="r-viejo"] [data-cj="reactivar"]') && !q('.cj-row [data-cj="editar"]'));
  t('…y el mapa muestra también el gris', log.puntos.items.length === 4 && log.puntos.items.some((c) => c.o.fillColor === '#A39A8D'));
}

// ── 3. Agregar ──────────────────────────────────────────────────────────────
console.log('Agregar');
{
  const { w, q, log } = await montar();
  click(w, q('#cj-agregar'));
  t('«Agregar conjunto» abre el editor vacío', /Conjunto nuevo/.test(txt(q('#cj-editor'))) && q('#cj-nombre').value === '' && q('#cj-coord').value === '');
  t('mientras se edita: «Agregar», Editar y Desactivar quedan apagados; el mapa en modo pin', q('#cj-agregar').disabled && q('.cj-row [data-cj="editar"]').disabled && q('#cj-map').classList.contains('editando'));
  t('…y la pista dice que se toca el mapa donde está la portería', /Toca el mapa donde está la portería/.test(txt(q('#cj-maphint'))));
  t('sin nombre ni pin, «Agregar» apagado', q('#cj-guardar').disabled);
  escribir(w, q('#cj-nombre'), 'Torres de Barro Blanco');
  t('con nombre y sin pin, sigue apagado', q('#cj-guardar').disabled);
  log.map.fire('click', { latlng: { lat: 4.711, lng: -74.0721 } });
  t('tocar fuera del Oriente (Bogotá) se rechaza y no pone pin', /fuera del Oriente/.test(txt(q('#cj-ed-msg'))) && !log.pin);
  log.map.fire('click', { latlng: { lat: 6.15123456, lng: -75.40411111 } });
  t('tocar el mapa pone el pin (redondeado) y lo escribe en el campo', !!log.pin && q('#cj-coord').value === '6.151235, -75.404111' && !/fuera/.test(txt(q('#cj-ed-msg'))), q('#cj-coord').value);
  t('con nombre y pin, «Agregar» se enciende', !q('#cj-guardar').disabled);
  t('el pin se arrastra (draggable) y queda encima', log.pin.o.draggable === true && log.pin.o.zIndexOffset === 1000);
  log.pin.ll = [6.1520, -75.4050]; log.pin.fire('dragend', { target: log.pin });
  t('arrastrar el pin cambia la coordenada', q('#cj-coord').value === '6.152000, -75.405000');
  q('#cj-coord').focus();
  escribir(w, q('#cj-coord'), '6.153123, -75.379012');
  t('pegar la coordenada de Google Maps mueve el pin y centra el mapa', log.pin.ll[0] === 6.153123 && log.pin.ll[1] === -75.379012 && log.map.center[0] === 6.153123);
  escribir(w, q('#cj-coord'), 'en la portería');
  q('#cj-coord').dispatchEvent(new w.FocusEvent('focusout', { bubbles: true }));
  t('una coordenada que no se entiende se dice al salir del campo', /No entendí esa coordenada/.test(txt(q('#cj-ed-msg'))));
  escribir(w, q('#cj-coord'), '6.153123, -75.379012');
  escribir(w, q('#cj-nombre'), '  el olivar ');
  click(w, q('#cj-guardar'));
  await esperaMucho();
  t('nombre repetido (sin importar mayúsculas/espacios): se avisa y no va a la base', /Ya hay un conjunto con ese nombre/.test(txt(q('#cj-ed-msg'))) && !log.calls.some((c) => c[0] === 'create'));
  escribir(w, q('#cj-nombre'), 'Conjunto Viejo');
  click(w, q('#cj-guardar'));
  t('…si el repetido está desactivado, dice que se reactive', /desactivado: reactívalo/.test(txt(q('#cj-ed-msg'))));
  escribir(w, q('#cj-nombre'), 'Torres de Barro Blanco');
  escribir(w, q('#cj-nota'), 'Portería principal');
  w.__fallar = 'Ya hay un conjunto con ese nombre.';
  click(w, q('#cj-guardar'));
  await esperaMucho();
  t('si la base se queja, el mensaje sale en el editor y se puede reintentar', /Ya hay un conjunto con ese nombre/.test(txt(q('#cj-ed-msg'))) && !q('#cj-guardar').disabled && !!q('.cj-ed'));
  click(w, q('#cj-guardar'));
  await esperaMucho();
  const cr = log.calls.filter((c) => c[0] === 'create').pop();
  t('guarda con createResidence(nombre, pin, nota)', cr && cr[1].name === 'Torres de Barro Blanco' && cr[1].latitude === 6.153123 && cr[1].longitude === -75.379012 && cr[1].accessNote === 'Portería principal', JSON.stringify(cr));
  t('avisa, cierra el editor y recarga la lista con el nuevo', log.toasts.includes('«Torres de Barro Blanco» agregado') && !q('.cj-ed') && !!q('.cj-row[data-id="r-nuevo"]') && /4 conjuntos activos/.test(txt(q('#cj-resumen'))));
  t('al cerrar, el pin se quita y el mapa vuelve a abrir conjuntos', !log.pin && !q('#cj-map').classList.contains('editando'));
}

// ── 4. Editar ───────────────────────────────────────────────────────────────
console.log('Editar');
{
  const { w, q, log } = await montar();
  const punto = log.puntos.items.find((c) => c.tip === 'El Olivar');
  punto.fire('click');
  await esperaMucho();
  t('tocar un punto del mapa abre ese conjunto con sus datos', /Editar conjunto/.test(txt(q('#cj-editor'))) && q('#cj-nombre').value === 'El Olivar' && q('#cj-nota').value === 'Portería 2' && q('#cj-coord').value === '6.152300, -75.378100');
  t('…dice cuántos tripulantes viven ahí y resalta la fila', /3 tripulantes viven aquí/.test(txt(q('.cj-ed-h'))) && q('.cj-row[data-id="r-olivar"]').classList.contains('sel'));
  t('…su punto se cambia por el pin que se arrastra, y los demás no se pueden tocar', !!log.pin && !log.puntos.items.some((c) => c.tip === 'El Olivar') && log.puntos.items.every((c) => c.o.interactive === false));
  t('…y centra el mapa en él', log.map.center[0] === 6.1523 && log.map.z >= 16);
  t('sin cambios, «Guardar cambios» apagado', q('#cj-guardar').disabled);
  log.map.fire('click', { latlng: { lat: 6.1531, lng: -75.379 } });
  t('mover el pin: dice que 2 viajes ya pedidos se actualizan', /2 viajes ya pedidos a este conjunto se actualizan con el cambio \(el carro va al punto nuevo\)/.test(txt(q('#cj-ed-msg'))), txt(q('#cj-ed-msg')));
  click(w, q('#cj-guardar'));
  await esperaMucho();
  const up = log.calls.filter((c) => c[0] === 'update').pop();
  t('guarda SOLO el pin (sin tocar nombre ni nota)', up && up[1] === 'r-olivar' && JSON.stringify(up[2]) === JSON.stringify({ latitude: 6.1531, longitude: -75.379 }), JSON.stringify(up));
  t('avisa y cierra', log.toasts.includes('«El Olivar» guardado') && !q('.cj-ed'));

  click(w, q('.cj-row[data-id="r-cambulo"] [data-cj="editar"]'));
  await esperaMucho();
  escribir(w, q('#cj-nombre'), 'Cámbulo Reservado');
  t('renombrar sin viajes pedidos no promete nada', txt(q('#cj-ed-msg')) === '');
  w.__fallar = 'Solo un jefe puede cambiar los conjuntos. Vuelve a entrar e inténtalo de nuevo.';
  click(w, q('#cj-guardar'));
  await esperaMucho();
  t('el error de permisos sale en el editor', /Solo un jefe puede cambiar/.test(txt(q('#cj-ed-msg'))));
  click(w, q('#cj-guardar'));
  await esperaMucho();
  const up2 = log.calls.filter((c) => c[0] === 'update').pop();
  t('renombrar guarda nombre y nota, no el pin', up2 && JSON.stringify(up2[2]) === JSON.stringify({ name: 'Cámbulo Reservado', access_note: '' }), JSON.stringify(up2 && up2[2]));

  click(w, q('.cj-row[data-id="r-forest"] [data-cj="editar"]'));
  q('#cj-nombre').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  t('Escape cierra el editor sin guardar', !q('.cj-ed') && log.calls.filter((c) => c[0] === 'update').length === 3);
}

// ── 5. Desactivar y reactivar ───────────────────────────────────────────────
console.log('Desactivar');
{
  const { w, q, log } = await montar();
  w.__confirm = [false];
  click(w, q('.cj-row[data-id="r-olivar"] [data-cj="desactivar"]'));
  await esperaMucho();
  t('pide confirmación nombrando a los 3 que viven ahí', /¿Desactivar «El Olivar»\?[\s\S]*Los 3 tripulantes que viven ahí lo conservan y sus viajes siguen igual/.test(log.confirms[0] || ''), log.confirms[0]);
  t('si dice que no, no pasa nada', !log.calls.some((c) => c[0] === 'update'));
  click(w, q('.cj-row[data-id="r-olivar"] [data-cj="desactivar"]'));
  await esperaMucho();
  t('si dice que sí: is_active = false', JSON.stringify(log.calls.filter((c) => c[0] === 'update').pop()) === JSON.stringify(['update', 'r-olivar', { is_active: false }]));
  t('avisa y sale de Activos', log.toasts.includes('«El Olivar» desactivado') && !q('.cj-row[data-id="r-olivar"]') && /2 conjuntos activos · 2 desactivados/.test(txt(q('#cj-resumen'))));
  click(w, q('#cj-filtro [data-v="inactivos"]'));
  const n0 = log.confirms.length;
  click(w, q('.cj-row[data-id="r-viejo"] [data-cj="reactivar"]'));
  await esperaMucho();
  t('reactivar no pregunta y vuelve a la lista', log.confirms.length === n0 && JSON.stringify(log.calls.filter((c) => c[0] === 'update').pop()) === JSON.stringify(['update', 'r-viejo', { is_active: true }]) && log.toasts.includes('«Conjunto Viejo» reactivado'));
}

// ── El lector de coordenadas ────────────────────────────────────────────────
console.log('Coordenadas');
{
  const { w } = await montar();
  const leer = w.renderConjuntos._leer;
  t('«6.153123, -75.379012» (Google Maps)', JSON.stringify(leer('6.153123, -75.379012')) === '{"lat":6.153123,"lng":-75.379012}');
  t('«6.1531 -75.379» (con espacio)', JSON.stringify(leer('6.1531 -75.379')) === '{"lat":6.1531,"lng":-75.379}');
  t('un enlace de Google Maps «…/@6.1531,-75.379,17z»', JSON.stringify(leer('https://www.google.com/maps/@6.1531,-75.379,17z')) === '{"lat":6.1531,"lng":-75.379}');
  t('texto sin coordenada → null', leer('portería 2') === null);
}

console.log(`\n${ok} ✓ · ${bad} ✗`);
process.exit(bad ? 1 : 0);
