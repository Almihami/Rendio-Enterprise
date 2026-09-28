// fixtures/fake-leaflet.js — Leaflet FALSO para pruebas jsdom (P2, rediseño del auxiliar 27-sep-2026).
//
// Se evalúa DENTRO de la ventana (window.eval(texto) en jsdom, o pegado en
// javascript_tool) y deja un window.L que NO dibuja nada: solo registra qué se
// monta. Sirve para probar qué pone la app en el mapa (plan §5 P4):
//   · cada marcador con divIcon crea en el contenedor del mapa un
//     <div class="leaflet-marker-icon {className}">{html}</div>, así la prueba
//     puede buscar .rx-lf-car / .rx-lf-pin / .rx-lf-apt en el DOM;
//   · L.__log guarda mapas, marcadores, líneas y capas; L.__markers(cls) filtra
//     los marcadores cuyo className o html contienen esa clase;
//   · L.__reset() lo vacía entre escenarios.
// Implementa lo que usan auxiliar.js y aux-residencias.js (map, tileLayer,
// marker, divIcon, polyline, circleMarker, layerGroup, latLng, latLngBounds) y
// algo más por si acaso. NO prueba el render real, ni los tiles, ni OSRM, ni el
// tamaño del mapa: jsdom no hace layout.
(function () {
  'use strict';
  const log = { maps: [], markers: [], lines: [], circles: [], groups: [], tiles: [], removed: [] };

  function LatLng(lat, lng) { this.lat = +lat; this.lng = +lng; }
  LatLng.prototype.equals = function (o) { o = toLL(o); return !!o && o.lat === this.lat && o.lng === this.lng; };
  LatLng.prototype.distanceTo = function (o) {
    o = toLL(o); const R = 6371000, r = Math.PI / 180;
    const dLat = (o.lat - this.lat) * r, dLng = (o.lng - this.lng) * r;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(this.lat * r) * Math.cos(o.lat * r) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  };
  function toLL(a, b) {
    if (a instanceof LatLng) return a;
    if (Array.isArray(a)) return new LatLng(a[0], a[1]);
    if (a && typeof a === 'object' && 'lat' in a) return new LatLng(a.lat, a.lng != null ? a.lng : a.lon);
    if (a != null && b != null) return new LatLng(a, b);
    return null;
  }
  function Bounds(pts) { this._pts = []; (pts || []).forEach(p => this.extend(p)); }
  Bounds.prototype.extend = function (p) {
    if (p instanceof Bounds) { p._pts.forEach(x => this._pts.push(x)); return this; }
    const ll = toLL(p); if (ll) this._pts.push(ll); return this;
  };
  Bounds.prototype.isValid = function () { return this._pts.length > 0; };
  Bounds.prototype.pad = function () { return this; };
  Bounds.prototype.getCenter = function () {
    const n = this._pts.length || 1;
    return new LatLng(this._pts.reduce((s, p) => s + p.lat, 0) / n, this._pts.reduce((s, p) => s + p.lng, 0) / n);
  };
  Bounds.prototype.contains = function (p) { const ll = toLL(p); return this._pts.some(x => x.equals(ll)); };

  // Base de todas las capas: eventos + addTo/remove.
  function Layer() { this._ev = {}; this._map = null; this._parent = null; this.options = {}; }
  Layer.prototype.on = function (n, fn) { String(n).split(/\s+/).forEach(k => (this._ev[k] = this._ev[k] || []).push(fn)); return this; };
  Layer.prototype.off = function (n, fn) { String(n).split(/\s+/).forEach(k => { this._ev[k] = (this._ev[k] || []).filter(f => fn && f !== fn); }); return this; };
  Layer.prototype.once = Layer.prototype.on;
  Layer.prototype.fire = function (n, data) { (this._ev[n] || []).slice().forEach(f => f.call(this, Object.assign({ target: this, type: n }, data || {}))); return this; };
  Layer.prototype.addTo = function (m) { m.addLayer(this); return this; };
  Layer.prototype.remove = function () { if (this._parent) this._parent.removeLayer(this); this._onRemove(); return this; };
  Layer.prototype._onAdd = function () {};
  Layer.prototype._onRemove = function () { log.removed.push(this); };
  Layer.prototype.bindTooltip = function (t, o) { this._tooltip = { text: t, opts: o || {} }; return this; };
  Layer.prototype.bindPopup = function (t, o) { this._popup = { text: t, opts: o || {} }; return this; };
  Layer.prototype.openPopup = function () { return this; };
  Layer.prototype.closePopup = function () { return this; };
  Layer.prototype.setStyle = function (s) { Object.assign(this.options, s || {}); return this; };
  Layer.prototype.bringToFront = function () { return this; };
  Layer.prototype.bringToBack = function () { return this; };
  const mapOf = (layer) => { let p = layer._parent; while (p && !(p instanceof FakeMap)) p = p._parent; return p || null; };

  // El mapa: guarda el contenedor para poder pintar ahí los marcadores.
  function FakeMap(el, opts) {
    Layer.call(this);
    this._el = typeof el === 'string' ? document.getElementById(el) : el;
    if (!this._el) throw new Error('fake-leaflet: Map container not found.');
    if (this._el._leaflet_id) throw new Error('fake-leaflet: Map container is already initialized.');
    this._el._leaflet_id = log.maps.length + 1;
    this._el.classList.add('leaflet-container');
    this._pane = document.createElement('div');
    this._pane.className = 'leaflet-marker-pane';
    this._el.appendChild(this._pane);
    this.options = opts || {};
    this._layers = new Set();
    this._view = null; this._zoom = null; this._bounds = null;
    this._removed = false;
    this.invalidations = 0;
    this.dragging = { enable() {}, disable() {} };
    log.maps.push(this);
  }
  FakeMap.prototype = Object.create(Layer.prototype);
  FakeMap.prototype.addLayer = function (l) { if (!this._layers.has(l)) { this._layers.add(l); l._parent = this; l._onAdd(this); } return this; };
  FakeMap.prototype.removeLayer = function (l) { if (this._layers.delete(l)) { l._parent = null; l._onRemove(); } return this; };
  FakeMap.prototype.hasLayer = function (l) { return this._layers.has(l); };
  FakeMap.prototype.eachLayer = function (fn) { this._layers.forEach(fn); return this; };
  FakeMap.prototype.setView = function (c, z) { this._view = toLL(c); if (z != null) this._zoom = z; return this; };
  FakeMap.prototype.panTo = function (c) { this._view = toLL(c); return this; };
  FakeMap.prototype.flyTo = FakeMap.prototype.setView;
  FakeMap.prototype.fitBounds = function (b) { this._bounds = b instanceof Bounds ? b : new Bounds(b); this._view = this._bounds.isValid() ? this._bounds.getCenter() : this._view; return this; };
  FakeMap.prototype.flyToBounds = FakeMap.prototype.fitBounds;
  FakeMap.prototype.getCenter = function () { return this._view; };
  FakeMap.prototype.getZoom = function () { return this._zoom; };
  FakeMap.prototype.setZoom = function (z) { this._zoom = z; return this; };
  FakeMap.prototype.getBounds = function () { return this._bounds || new Bounds(this._view ? [this._view] : []); };
  FakeMap.prototype.invalidateSize = function () { this.invalidations++; return this; };
  FakeMap.prototype.whenReady = function (fn) { fn.call(this); return this; };
  FakeMap.prototype.getContainer = function () { return this._el; };
  FakeMap.prototype.remove = function () {
    this._layers.forEach(l => { l._parent = null; l._onRemove(); });
    this._layers.clear();
    if (this._pane) this._pane.remove();
    if (this._el) { delete this._el._leaflet_id; this._el.classList.remove('leaflet-container'); }
    this._removed = true;
    return this;
  };

  function Group() { Layer.call(this); this._layers = new Set(); log.groups.push(this); }
  Group.prototype = Object.create(Layer.prototype);
  Group.prototype.addLayer = function (l) { this._layers.add(l); l._parent = this; if (mapOf(this)) l._onAdd(mapOf(this)); return this; };
  Group.prototype.removeLayer = function (l) { if (this._layers.delete(l)) { l._parent = null; l._onRemove(); } return this; };
  Group.prototype.clearLayers = function () { [...this._layers].forEach(l => this.removeLayer(l)); return this; };
  Group.prototype.eachLayer = function (fn) { this._layers.forEach(fn); return this; };
  Group.prototype.getLayers = function () { return [...this._layers]; };
  Group.prototype.hasLayer = function (l) { return this._layers.has(l); };
  Group.prototype._onAdd = function (m) { this._layers.forEach(l => l._onAdd(m)); };
  Group.prototype._onRemove = function () { this._layers.forEach(l => l._onRemove()); log.removed.push(this); };
  Group.prototype.getBounds = function () { const b = new Bounds(); this._layers.forEach(l => { if (l.getLatLng) b.extend(l.getLatLng()); }); return b; };

  function DivIcon(opts) { this.options = Object.assign({ className: 'leaflet-div-icon', html: '' }, opts || {}); }
  function DefaultIcon(opts) { this.options = Object.assign({ className: 'leaflet-default-icon' }, opts || {}); }

  function Marker(ll, opts) {
    Layer.call(this);
    this._ll = toLL(ll);
    this.options = Object.assign({}, opts || {});
    this._icon = null;
    this.dragging = { enable() {}, disable() {}, enabled: () => !!this.options.draggable };
    log.markers.push(this);
  }
  Marker.prototype = Object.create(Layer.prototype);
  Marker.prototype._paint = function () {
    const m = mapOf(this); if (!m || !m._pane) return;
    const ic = this.options.icon || new DefaultIcon();
    if (!this._icon) { this._icon = document.createElement('div'); m._pane.appendChild(this._icon); }
    this._icon.className = ('leaflet-marker-icon ' + (ic.options.className || '')).trim();
    this._icon.innerHTML = ic.options.html || '';
    this._icon.setAttribute('data-lat', this._ll ? this._ll.lat : '');
    this._icon.setAttribute('data-lng', this._ll ? this._ll.lng : '');
  };
  Marker.prototype._onAdd = function () { this._paint(); };
  Marker.prototype._onRemove = function () { if (this._icon) { this._icon.remove(); this._icon = null; } log.removed.push(this); };
  Marker.prototype.getLatLng = function () { return this._ll; };
  Marker.prototype.setLatLng = function (ll) { this._ll = toLL(ll); if (this._icon) this._paint(); return this.fire('move'); };
  Marker.prototype.setIcon = function (icon) { this.options.icon = icon; if (this._icon) this._paint(); return this; };
  Marker.prototype.getIcon = function () { return this.options.icon || null; };
  Marker.prototype.getElement = function () { return this._icon; };
  Marker.prototype.setZIndexOffset = function (z) { this.options.zIndexOffset = z; return this; };
  Marker.prototype.setOpacity = function (o) { this.options.opacity = o; return this; };
  Marker.prototype.classes = function () {
    const ic = this.options.icon; if (!ic) return '';
    return (ic.options.className || '') + ' ' + (ic.options.html || '');
  };

  function Poly(lls, opts) {
    Layer.call(this);
    this._lls = (lls || []).map(p => toLL(p));
    this.options = Object.assign({}, opts || {});
    log.lines.push(this);
  }
  Poly.prototype = Object.create(Layer.prototype);
  Poly.prototype.setLatLngs = function (lls) { this._lls = (lls || []).map(p => toLL(p)); return this; };
  Poly.prototype.getLatLngs = function () { return this._lls; };
  Poly.prototype.addLatLng = function (p) { this._lls.push(toLL(p)); return this; };
  Poly.prototype.getBounds = function () { return new Bounds(this._lls); };

  function Circle(ll, opts) {
    Layer.call(this);
    this._ll = toLL(ll);
    this.options = Object.assign({}, typeof opts === 'number' ? { radius: opts } : opts || {});
    log.circles.push(this);
  }
  Circle.prototype = Object.create(Layer.prototype);
  Circle.prototype.getLatLng = function () { return this._ll; };
  Circle.prototype.setLatLng = function (ll) { this._ll = toLL(ll); return this; };
  Circle.prototype.setRadius = function (r) { this.options.radius = r; return this; };
  Circle.prototype.getBounds = function () { return new Bounds([this._ll]); };

  function Tile(url, opts) { Layer.call(this); this.url = url; this.options = opts || {}; log.tiles.push(this); }
  Tile.prototype = Object.create(Layer.prototype);

  const L = {
    version: 'fake',
    map: (el, opts) => new FakeMap(el, opts),
    tileLayer: (url, opts) => new Tile(url, opts),
    marker: (ll, opts) => new Marker(ll, opts),
    divIcon: (opts) => new DivIcon(opts),
    icon: (opts) => new DefaultIcon(opts),
    polyline: (lls, opts) => new Poly(lls, opts),
    polygon: (lls, opts) => new Poly(lls, opts),
    circleMarker: (ll, opts) => new Circle(ll, opts),
    circle: (ll, opts) => new Circle(ll, opts),
    layerGroup: (ls) => { const g = new Group(); (ls || []).forEach(l => g.addLayer(l)); return g; },
    featureGroup: (ls) => { const g = new Group(); (ls || []).forEach(l => g.addLayer(l)); return g; },
    latLng: (a, b) => toLL(a, b),
    latLngBounds: (a, b) => (b ? new Bounds([a, b]) : new Bounds(Array.isArray(a) ? a : a ? [a] : [])),
    point: (x, y) => ({ x, y }),
    control: { zoom: () => ({ addTo() { return this; }, remove() { return this; } }), attribution: () => ({ addTo() { return this; } }) },
    DomUtil: { create: (tag, cls, parent) => { const e = document.createElement(tag); if (cls) e.className = cls; if (parent) parent.appendChild(e); return e; } },
    DomEvent: { disableClickPropagation() {}, disableScrollPropagation() {}, stopPropagation() {} },
    Util: { stamp: (o) => (o._leaflet_id = o._leaflet_id || Math.random()) },
    __log: log,
    // Marcadores vivos (en un mapa y sin quitar) cuyo className o html traen `cls`.
    __markers(cls) {
      return log.markers.filter(m => mapOf(m) && !mapOf(m)._removed && (!cls || m.classes().split(/[\s"'=<>]+/).includes(cls)));
    },
    __liveMaps() { return log.maps.filter(m => !m._removed); },
    __reset() { Object.keys(log).forEach(k => { log[k].length = 0; }); },
  };
  L.Map = FakeMap; L.Marker = Marker; L.DivIcon = DivIcon; L.Polyline = Poly; L.LatLng = LatLng; L.LatLngBounds = Bounds; L.LayerGroup = Group;
  window.L = L;
})();
