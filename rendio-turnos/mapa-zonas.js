// mapa-zonas.js — El mapa donde se dibujan zonas (0108/0109, 13-oct-2026).
//
// Una sola pieza para las dos pantallas que dibujan, para que se vean y se
// manejen igual:
//   · Calibración › Zonas (las zonas de TIEMPOS de Julián, admin-zonas.js)
//   · Cuentas de cobro › Tarifas por sector (los sectores de COBRO, admin-cobro.js)
// La pantalla pone los datos, los botones y la barra; esto pone el mapa, los
// dibujos, los puntos de los conjuntos y la edición.
//
// Ver: tocar un dibujo (o el nombre de la zona en la lista, con enfocar) acerca
// el mapa a esa zona y la resalta; tocar el fondo la suelta.
//
// Dibujar: cada toque en el mapa pone una esquina. Con tres o más, la esquina
// nueva entra en el lado más cercano (no al final), para que agregar un punto
// nunca cruce la figura. Los puntos se arrastran para moverlos y se tocan para
// quitarlos. «Deshacer» devuelve el paso anterior, sea cual sea.
//
// Comparte el ámbito global con los demás archivos: antes de agregar un nombre,
// correr rendio-backend/scripts/_nombres-repetidos.mjs.

// Colores de la paleta del diseñador primero (naranja, verde, ámbar), después
// los del tablero de rutas. Alcanzan para los 17 sectores de cobro sin repetir.
const MAPA_ZONAS_COLORES = ['#E2551A', '#16936A', '#2563A8', '#C9810F', '#7C5CD6', '#DB4B7A', '#0D9488', '#5B8A2B',
  '#9D174D', '#4F46E5', '#0EA5E9', '#B45309', '#65A30D', '#BE185D', '#475569', '#A855F7', '#14B8A6'];
const MAPA_ZONAS_SIN_COLOR = '#A39A8D';

// opts:
//   el        — el contenedor del mapa (si no viene, se crea uno; la pantalla lo
//               pone donde quiera y lo puede mover: Leaflet sigue pegado a él)
//   onCambio  — se llama cada vez que cambia la edición (para repintar la barra)
//   aviso     — cómo decir algo corto (toast)
//   sinAnimacion — para una pantalla que reescribe su HTML seguido (Cuentas de
//               cobro): si el mapa sale del documento a mitad de una animación
//               de acercar, la animación queda trabada y las calles se pintan
//               solo en un pedazo. Sin animaciones acerca igual, de un salto.
function crearMapaZonas(opts) {
  const o = opts || {};
  const el = o.el || document.createElement('div');
  el.classList.add('zn-map');
  const st = { map: null, zonas: null, puntos: null, edicion: null, ed: null, ultimo: null, encuadrar: true, foco: null };
  const avisar = () => { if (typeof o.onCambio === 'function') o.onCambio(); };
  const redondo = (n) => Math.round(n * 1e6) / 1e6;   // ~10 cm

  function iniciar() {
    if (st.map) return true;
    if (typeof L === 'undefined') {
      el.innerHTML = '<div class="zn-mapa-falla">No se pudo cargar el mapa (sin conexión).</div>';
      return false;
    }
    const quieto = o.sinAnimacion ? { zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false } : {};
    const map = L.map(el, Object.assign({ scrollWheelZoom: true }, quieto)).setView([6.152, -75.39], 14);   // Rionegro
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
    st.zonas = L.layerGroup().addTo(map);
    st.puntos = L.layerGroup().addTo(map);
    st.edicion = L.layerGroup().addTo(map);
    // Los puntos de los conjuntos dejan pasar el clic al mapa (las figuras de
    // Leaflet burbujean): tocar encima de un conjunto también pone esquina.
    map.on('click', (ev) => { if (st.ed) clic(ev.latlng); else if (st.foco) { st.foco = null; if (st.ultimo) pintar(st.ultimo); } });
    st.map = map;
    return true;
  }

  // El lado donde agregar la esquina nueva cuesta menos perímetro: así un punto
  // marcado afuera estira la figura hacia allá en vez de cruzarla.
  function mejorLado(puntos, p) {
    const k = Math.cos(p[0] * Math.PI / 180);
    const d = (a, b) => Math.hypot(a[0] - b[0], (a[1] - b[1]) * k);
    let mejor = 0, costo = Infinity;
    for (let i = 0; i < puntos.length; i++) {
      const a = puntos[i], b = puntos[(i + 1) % puntos.length];
      const c = d(a, p) + d(p, b) - d(a, b);
      if (c < costo) { costo = c; mejor = i; }
    }
    return mejor;
  }

  const paso = () => { if (st.ed) st.ed.historia.push(st.ed.puntos.map(p => p.slice())); };

  function clic(latlng) {
    const ed = st.ed;
    if (!ed) return;
    paso();
    const p = [redondo(latlng.lat), redondo(latlng.lng)];
    if (ed.puntos.length < 3) ed.puntos.push(p);
    else ed.puntos.splice(mejorLado(ed.puntos, p) + 1, 0, p);
    pintarEdicion();
    avisar();
  }

  function pintarEdicion() {
    if (!st.edicion) return;
    st.edicion.clearLayers();
    const ed = st.ed;
    el.classList.toggle('editando', !!ed);
    if (!ed) return;
    const c = ed.color, n = ed.puntos.length;
    let forma = null;
    if (n >= 3) forma = L.polygon(ed.puntos, { color: c, weight: 2, dashArray: '6 4', fillColor: c, fillOpacity: 0.2, interactive: false });
    else if (n === 2) forma = L.polyline(ed.puntos, { color: c, weight: 2, dashArray: '6 4', interactive: false });
    if (forma) forma.addTo(st.edicion);
    ed.puntos.forEach((p, i) => {
      const m = L.marker(p, {
        draggable: true, keyboard: false,
        icon: L.divIcon({ className: 'zn-vertice', html: `<span style="border-color:${c}"></span>`, iconSize: [18, 18], iconAnchor: [9, 9] }),
      });
      m.on('dragstart', () => paso());
      m.on('drag', (ev) => {
        const ll = ev.target.getLatLng();
        ed.puntos[i] = [redondo(ll.lat), redondo(ll.lng)];
        if (forma) forma.setLatLngs(ed.puntos);
      });
      m.on('dragend', () => { pintarEdicion(); avisar(); });
      // Leaflet no manda el clic después de arrastrar, así que mover no borra.
      m.on('click', () => {
        if (ed.puntos.length <= 3) { if (typeof o.aviso === 'function') o.aviso('Una zona necesita al menos 3 puntos.'); return; }
        paso();
        ed.puntos.splice(i, 1);
        pintarEdicion();
        avisar();
      });
      m.addTo(st.edicion);
    });
  }

  // datos: { zonas: [{ name, polygon, color }], puntos: [{ lat, lng, color, doble, texto }] }
  // La zona que se está editando no se pinta aquí: va con sus puntos editables.
  function pintar(datos) {
    st.ultimo = datos || { zonas: [], puntos: [] };
    if (!iniciar()) return;
    st.zonas.clearLayers();
    st.puntos.clearLayers();
    const editNombre = st.ed && st.ed.name;
    if (st.foco && !(st.ultimo.zonas || []).some(z => z.name === st.foco && z.polygon)) st.foco = null;
    (st.ultimo.zonas || []).forEach(z => {
      if (!z.polygon || z.name === editNombre) return;
      const foco = !editNombre && st.foco === z.name, apagada = !editNombre && st.foco && !foco;
      // Mientras se dibuja, el toque pasa al mapa (pone esquina); si no, tocar
      // la figura la muestra (pedido de la profa, 14-oct-2026).
      const capa = L.polygon(z.polygon, {
        color: z.color, weight: foco ? 4 : 2, fillColor: z.color,
        fillOpacity: editNombre ? 0.06 : foco ? 0.32 : apagada ? 0.05 : 0.14, opacity: apagada ? 0.45 : 1,
        bubblingMouseEvents: !!editNombre,
      }).bindTooltip(z.name, { sticky: !foco, permanent: foco, direction: 'center', className: foco ? 'zn-tip-foco' : '' }).addTo(st.zonas);
      if (!editNombre) capa.on('click', () => enfocar(z.name));
    });
    (st.ultimo.puntos || []).forEach(p => {
      if (p.lat == null || p.lng == null) return;
      L.circleMarker([p.lat, p.lng], {
        radius: 6, weight: p.doble ? 3 : 2, color: p.doble ? '#C9810F' : '#FFFFFF',
        fillColor: p.color || MAPA_ZONAS_SIN_COLOR, fillOpacity: 1,
      }).bindTooltip(p.texto || '').addTo(st.puntos);
    });
    if (st.encuadrar) {
      const pts = [];
      (st.ultimo.puntos || []).forEach(p => { if (p.lat != null && p.lng != null) pts.push([p.lat, p.lng]); });
      (st.ultimo.zonas || []).forEach(z => (z.polygon || []).forEach(p => pts.push(p)));
      if (pts.length) { st.map.fitBounds(pts, { padding: [24, 24], maxZoom: 15 }); st.encuadrar = false; }
    }
    pintarEdicion();
  }

  // Mostrar una zona: el mapa se acerca a su dibujo y la resalta (las demás se
  // apagan) hasta que se toque otra o el fondo. Sin dibujo, se dice.
  function enfocar(name) {
    if (st.ed) return false;
    const z = ((st.ultimo && st.ultimo.zonas) || []).find(x => x.name === name);
    if (!z || !z.polygon || !z.polygon.length) {
      if (typeof o.aviso === 'function') o.aviso(`«${name}» todavía no tiene dibujo. Toca «Dibujar» para hacerlo.`);
      return false;
    }
    st.foco = name;
    pintar(st.ultimo);
    if (st.map) st.map.fitBounds(z.polygon, { padding: [40, 40], maxZoom: 16 });
    if (el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return true;
  }

  return {
    el,
    pintar,
    enfocar,
    enfocada() { return st.foco; },
    // El contenedor estuvo oculto o se movió → recalcular tamaño.
    ajustar() { setTimeout(() => { try { st.map && st.map.invalidateSize(); } catch (e) {} }, 80); },
    editar(name, color, polygon) {
      st.foco = null;
      st.ed = { name, color: color || MAPA_ZONAS_SIN_COLOR, puntos: (polygon || []).map(p => [Number(p[0]), Number(p[1])]), historia: [] };
      if (st.ultimo) pintar(st.ultimo); else pintarEdicion();
      if (polygon && polygon.length && st.map) st.map.fitBounds(polygon, { padding: [40, 40], maxZoom: 16 });
      if (el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      avisar();
    },
    // Lo que la barra necesita saber. null = no se está dibujando.
    editando() {
      const ed = st.ed;
      return ed ? { name: ed.name, puntos: ed.puntos.length, puedeDeshacer: ed.historia.length > 0, listo: ed.puntos.length >= 3 } : null;
    },
    dibujo() { return st.ed ? st.ed.puntos.map(p => p.slice()) : null; },
    deshacer() {
      if (!st.ed || !st.ed.historia.length) return;
      st.ed.puntos = st.ed.historia.pop();
      pintarEdicion();
      avisar();
    },
    terminar() {
      st.ed = null;
      if (st.ultimo) pintar(st.ultimo); else pintarEdicion();
      avisar();
    },
  };
}
