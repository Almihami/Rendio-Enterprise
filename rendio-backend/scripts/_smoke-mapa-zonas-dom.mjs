// mapa-zonas.js: tocar una zona la muestra (pedido de la profa, 14-oct-2026), en jsdom.
//
// La pieza compartida de Calibración › Zonas de tiempos y Cuentas de cobro ›
// Tarifas por sector. Comprueba que
//   · tocar un dibujo (o su nombre en la lista: enfocar) acerca el mapa a esa
//     zona, la resalta con su nombre fijo encima y apaga las demás;
//   · tocar el fondo la suelta;
//   · una zona sin dibujo lo dice en vez de no hacer nada;
//   · mientras se dibuja, nada de eso estorba: tocar encima de otra zona pone
//     esquina (el toque pasa al mapa) y enfocar no hace nada;
//   · las dos pantallas cablean el nombre de la zona a enfocar.
//
// NO cubre: Leaflet de verdad (va simulado: ni calles ni acercamiento real) ni el
// layout. Lo de verdad se miró en el navegador local (Calibración, 14-oct).
//
//   cd rendio-backend/scripts && node _smoke-mapa-zonas-dom.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d = '') => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d !== '' ? ' → ' + d : '')); } };

function fakeL(log) {
  const ev = () => { const h = {}; return { on(n, f) { (h[n] = h[n] || []).push(f); return this; }, fire(n, e) { (h[n] || []).forEach((f) => f(e)); }, has(n) { return !!(h[n] && h[n].length); } }; };
  const capa = (tipo, ll, o) => { const c = Object.assign(ev(), { tipo, ll, o, bindTooltip(tx, to) { c.tip = tx; c.tipO = to || {}; return c; }, addTo(g) { (g.items || (g.items = [])).push(c); return c; }, setLatLngs() {} }); return c; };
  return {
    map(el) { const m = Object.assign(ev(), { el, setView() { return m; }, fitBounds(b) { log.fit.push(b); return m; }, invalidateSize() {} }); log.map = m; return m; },
    tileLayer() { return { addTo() { return this; } }; },
    layerGroup() { const g = { items: [], addTo() { return g; }, clearLayers() { g.items = []; } }; log.grupos.push(g); return g; },
    polygon: (ll, o) => capa('polygon', ll, o),
    polyline: (ll, o) => capa('polyline', ll, o),
    circleMarker: (ll, o) => capa('punto', ll, o),
    marker: (ll, o) => capa('vertice', ll, o),
    divIcon: (o) => o,
  };
}

const BARRO = [[6.1523, -75.3970], [6.1488, -75.4030], [6.1523, -75.4089], [6.1559, -75.4030]];
const COLEGIOS = [[6.1400, -75.3800], [6.1380, -75.3860], [6.1420, -75.3880]];
const dom = new JSDOM('<!doctype html><div id="m"></div>', { runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
const log = { fit: [], grupos: [], avisos: [] };
w.L = fakeL(log);
w.eval(read('mapa-zonas.js') + '\nwindow.crearMapaZonas = crearMapaZonas;');
const mapa = w.crearMapaZonas({ el: w.document.getElementById('m'), aviso: (m) => log.avisos.push(m) });
const datos = { zonas: [{ name: 'Barro Blanco', polygon: BARRO, color: '#E2551A' }, { name: 'Colegios', polygon: COLEGIOS, color: '#16936A' }, { name: 'Porvenir', polygon: null, color: '#2563A8' }], puntos: [] };
mapa.pintar(datos);
const zonas = () => log.grupos[0].items;           // st.zonas es el primer layerGroup
const de = (n) => zonas().find((c) => c.tip === n);

console.log('Ver una zona');
t('cada dibujo se puede tocar (no pasa el toque al mapa)', zonas().length === 2 && zonas().every((c) => c.has('click') && c.o.bubblingMouseEvents === false));
const fits0 = log.fit.length;
de('Barro Blanco').fire('click');
t('tocar «Barro Blanco» la enfoca y acerca el mapa a su dibujo', mapa.enfocada() === 'Barro Blanco' && log.fit.length === fits0 + 1 && JSON.stringify(log.fit[log.fit.length - 1]) === JSON.stringify(BARRO));
t('…resaltada (borde 4, relleno 0,32) y con su nombre fijo encima', de('Barro Blanco').o.weight === 4 && de('Barro Blanco').o.fillOpacity === 0.32 && de('Barro Blanco').tipO.permanent === true);
t('…y las demás se apagan', de('Colegios').o.fillOpacity === 0.05 && de('Colegios').o.opacity === 0.45);
t('enfocar por nombre (el botón de la lista) hace lo mismo', mapa.enfocar('Colegios') === true && mapa.enfocada() === 'Colegios' && de('Colegios').o.weight === 4);
log.map.fire('click', { latlng: { lat: 6.13, lng: -75.37 } });
t('tocar el fondo la suelta y todo vuelve a verse igual', mapa.enfocada() === null && zonas().every((c) => c.o.weight === 2 && c.o.fillOpacity === 0.14));
t('una zona sin dibujo lo dice y no se enfoca', mapa.enfocar('Porvenir') === false && mapa.enfocada() === null && /«Porvenir» todavía no tiene dibujo/.test(log.avisos.pop() || ''));
mapa.enfocar('Barro Blanco');
mapa.pintar({ zonas: [{ name: 'Colegios', polygon: COLEGIOS, color: '#16936A' }], puntos: [] });
t('si la zona enfocada desaparece (la quitaron), se suelta', mapa.enfocada() === null);
mapa.pintar(datos);

console.log('Mientras se dibuja');
mapa.enfocar('Barro Blanco');
mapa.editar('Porvenir', '#2563A8', null);
t('empezar a dibujar suelta el foco', mapa.enfocada() === null);
t('las otras zonas dejan pasar el toque al mapa y no se enfocan', zonas().every((c) => c.o.bubblingMouseEvents === true && !c.has('click')));
t('enfocar no hace nada mientras se dibuja', mapa.enfocar('Colegios') === false && mapa.enfocada() === null);
log.map.fire('click', { latlng: { lat: 6.1523, lng: -75.4030 } });
t('tocar encima de otra zona pone esquina', mapa.editando().puntos === 1);
mapa.terminar();
t('al terminar, los dibujos se vuelven a poder tocar', zonas().every((c) => c.has('click')));

console.log('Las dos pantallas');
const zon = read('admin-zonas.js'), cob = read('admin-cobro.js');
t('Calibración: el nombre de la zona es un botón «ver» que llama a enfocar', /class="zn-ver" data-acc="ver"/.test(zon) && /data(set)?\.acc === 'ver'\) return zonasMapa\.mapa && zonasMapa\.mapa\.enfocar\(name\)/.test(zon));
t('Cuentas de cobro: el nombre del sector dibujado es un botón z-ver que llama a enfocar', /class="cb-zver" data-cb="z-ver"/.test(cob) && /case 'z-ver':[^\n]*cb\.zmapa\.enfocar\(s\.sector\)/.test(cob));

console.log(`\n${ok} ✓ · ${bad} ✗`);
process.exit(bad ? 1 : 0);
