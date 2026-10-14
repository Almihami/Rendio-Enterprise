// admin-zonas.js — Rutas › Configuración › Calibración › Zonas (0108, 13-oct-2026).
//
// Las zonas de la tabla de tiempos ya no son cuatro nombres fijos en el código:
// aquí se crean, se DIBUJAN en el mapa, se renombran y se quitan. Así describió
// la profa Barro Blanco: una elipse sobre la vía al aeropuerto.
//
// Cada conjunto toma la zona del dibujo que contiene su punto. Las excepciones
// se ponen a mano más abajo («Zona de cada conjunto», admin-calibracion.js) y
// ganan siempre. La regla vive en zonas-dibujo.js.
//
// Dibujar: cada toque en el mapa pone una esquina. Con tres o más, la esquina
// nueva entra en el lado más cercano (no al final), para que agregar un punto
// nunca cruce la figura. Los puntos se arrastran para moverlos y se tocan para
// quitarlos. «Deshacer» devuelve el paso anterior, sea cual sea.
//
// Comparte el ámbito global con los demás módulos (sin IIFE): zonasMapa,
// zonasRecargar y renderZonasCard los usa admin-calibracion.js. Antes de
// agregar un nombre, correr rendio-backend/scripts/_nombres-repetidos.mjs.

  // Colores de la paleta del diseñador primero (naranja, verde, ámbar), después
  // los del tablero de rutas. El color va por posición en la lista.
  const ZONA_COLORES = ['#E2551A', '#16936A', '#2563A8', '#C9810F', '#7C5CD6', '#DB4B7A', '#0D9488', '#5B8A2B', '#9D174D', '#4F46E5'];
  const ZONA_SIN_COLOR = '#A39A8D';

  const zonasMapa = {
    lista: null,          // route_zones [{ name, polygon, sort_order }] · null = la base no tiene 0108
    residencias: null,    // catálogo activo [{ id, name, sector, zona_jefe, latitude, longitude }]
    ordenFilas: null,     // orden fijo de la lista de excepciones (ver renderResidenceZones)
    map: null, capaZonas: null, capaConjuntos: null, capaEdicion: null,
    encuadrar: true,      // ajustar el mapa a los conjuntos la primera vez que hay datos
    editando: null,       // { name, puntos: [[lat, lng]], historia: [[[lat, lng]]] }
    renombrando: null,    // nombre de la zona que se está renombrando
    bound: false,
  };

  function zonaColor(name) {
    const i = (zonasMapa.lista || []).findIndex(z => z.name === name);
    return i < 0 ? ZONA_SIN_COLOR : ZONA_COLORES[i % ZONA_COLORES.length];
  }

  // Trae la lista de zonas y el catálogo UNA vez y pinta las tres tarjetas que
  // dependen de ellos: el mapa, la tabla de tiempos y las excepciones.
  async function zonasRecargar() {
    const [lista, res] = await Promise.all([
      Api.listRouteZones ? Api.listRouteZones().catch(() => null) : null,
      Api.listResidencesZones ? Api.listResidencesZones().catch(() => null) : null,
    ]);
    zonasMapa.lista = lista;
    zonasMapa.residencias = res;
    zonasMapa.ordenFilas = null;
    if (zonasMapa.editando && !(lista || []).some(z => z.name === zonasMapa.editando.name)) zonasMapa.editando = null;
    renderZonasCard();
    renderRouteTables();
    renderResidenceZones();
  }

  function renderZonasCard() {
    const card = $('#zonas-card');
    if (!card) return;
    zonasEnlazar(card);
    const sinTabla = !zonasMapa.lista;
    $('#zonas-map').classList.toggle('hidden', sinTabla);
    $('#zona-agregar-btn').classList.toggle('hidden', sinTabla);
    if (sinTabla) {
      // Sin la migración: se dice, no se finge un editor que no guarda.
      $('#zonas-lista').innerHTML = '<p class="set-hint">Las zonas dibujadas todavía no están en esta base de datos (falta la migración 0108). Mientras tanto, la zona de cada conjunto se pone a mano abajo.</p>';
      $('#zonas-aviso').innerHTML = '';
      return;
    }
    zonasPintarMapa();
    zonasPintarLista();
    zonasPintarEdicion();
  }

  // ---- EL MAPA ---------------------------------------------------------------
  function zonasMapaInit() {
    const el = $('#zonas-map');
    if (!el) return false;
    if (typeof L === 'undefined') {
      el.innerHTML = '<div class="zn-mapa-falla">No se pudo cargar el mapa (sin conexión).</div>';
      return false;
    }
    if (!zonasMapa.map) {
      const map = L.map(el, { scrollWheelZoom: true }).setView([6.152, -75.39], 14);   // Rionegro
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
      zonasMapa.capaZonas = L.layerGroup().addTo(map);
      zonasMapa.capaConjuntos = L.layerGroup().addTo(map);
      zonasMapa.capaEdicion = L.layerGroup().addTo(map);
      // Los puntos de los conjuntos dejan pasar el clic al mapa (las figuras de
      // Leaflet burbujean): tocar encima de un conjunto también pone esquina.
      map.on('click', (ev) => zonaEdicionClic(ev.latlng));
      zonasMapa.map = map;
    }
    // La pestaña estaba oculta al crear el mapa → recalcular tamaño al mostrarse.
    setTimeout(() => { try { zonasMapa.map && zonasMapa.map.invalidateSize(); } catch (e) {} }, 80);
    return true;
  }

  function zonasPintarMapa() {
    if (!zonasMapaInit()) return;
    const { map, capaZonas, capaConjuntos } = zonasMapa;
    capaZonas.clearLayers();
    capaConjuntos.clearLayers();
    const dib = zonasMapa.lista || [];
    const editNombre = zonasMapa.editando && zonasMapa.editando.name;
    dib.forEach(z => {
      // La que se está editando se pinta aparte (zonasPintarEdicion).
      if (!z.polygon || z.name === editNombre) return;
      const c = zonaColor(z.name);
      L.polygon(z.polygon, { color: c, weight: 2, fillColor: c, fillOpacity: editNombre ? 0.06 : 0.14 })
        .bindTooltip(z.name, { sticky: true }).addTo(capaZonas);
    });
    (zonasMapa.residencias || []).forEach(r => {
      if (r.latitude == null || r.longitude == null) return;
      const e = zonaEfectiva(r.zona_jefe, dib, r.latitude, r.longitude);
      const doble = !e.zona && e.en.length > 1;
      const como = e.origen === 'mano' ? `${e.zona} (a mano)`
        : e.zona ? `${e.zona} (por el dibujo)`
        : doble ? `en dos zonas: ${e.en.join(', ')}` : 'sin zona';
      L.circleMarker([r.latitude, r.longitude], {
        radius: 6, weight: doble ? 3 : 2, color: doble ? '#C9810F' : '#FFFFFF',
        fillColor: e.zona ? zonaColor(e.zona) : ZONA_SIN_COLOR, fillOpacity: 1,
      }).bindTooltip(`${r.name} · ${como}`).addTo(capaConjuntos);
    });
    if (zonasMapa.encuadrar) {
      const pts = [];
      (zonasMapa.residencias || []).forEach(r => { if (r.latitude != null && r.longitude != null) pts.push([r.latitude, r.longitude]); });
      dib.forEach(z => (z.polygon || []).forEach(p => pts.push(p)));
      if (pts.length) { map.fitBounds(pts, { padding: [24, 24], maxZoom: 15 }); zonasMapa.encuadrar = false; }
    }
  }

  // ---- LA LISTA DE ZONAS -----------------------------------------------------
  function zonasPintarLista() {
    const el = $('#zonas-lista'), aviso = $('#zonas-aviso');
    const dib = zonasMapa.lista || [];
    const cuenta = {};
    let dobles = 0;
    (zonasMapa.residencias || []).forEach(r => {
      const e = zonaEfectiva(r.zona_jefe, dib, r.latitude, r.longitude);
      if (e.zona) cuenta[e.zona] = (cuenta[e.zona] || 0) + 1;
      else if (e.en.length > 1) dobles++;
    });
    const editando = !!zonasMapa.editando;
    const plural = (n, s, p) => `${n} ${n === 1 ? s : p}`;
    el.innerHTML = dib.length ? dib.map(z => {
      const n = cuenta[z.name] || 0;
      const estado = (z.polygon ? '' : 'sin dibujo · ') + plural(n, 'conjunto', 'conjuntos');
      if (zonasMapa.renombrando === z.name) {
        return `
        <div class="zn-row" data-zona="${escapeHtml(z.name)}">
          <span class="zn-sw" style="background:${zonaColor(z.name)}"></span>
          <div class="zn-info zn-renombrar">
            <input class="zn-input" id="zona-renombrar-input" maxlength="60" value="${escapeHtml(z.name)}" aria-label="Nuevo nombre de la zona" />
            <div class="zn-err hidden" id="zona-renombrar-err"></div>
          </div>
          <div class="zn-acc">
            <button class="set-btn dark sm" data-acc="renombrar-ok">Guardar</button>
            <button class="set-btn ghost sm" data-acc="renombrar-no">Cancelar</button>
          </div>
        </div>`;
      }
      return `
        <div class="zn-row" data-zona="${escapeHtml(z.name)}">
          <span class="zn-sw" style="background:${zonaColor(z.name)}"></span>
          <div class="zn-info"><b>${escapeHtml(z.name)}</b><small>${estado}</small></div>
          <div class="zn-acc">
            <button class="set-btn ghost sm" data-acc="dibujar" ${editando ? 'disabled' : ''}>${z.polygon ? 'Editar dibujo' : 'Dibujar'}</button>
            <button class="set-btn ghost sm" data-acc="renombrar" ${editando ? 'disabled' : ''}>Renombrar</button>
            <button class="zn-quitar" data-acc="quitar" ${editando ? 'disabled' : ''} aria-label="Quitar la zona ${escapeHtml(z.name)}" title="Quitar zona"><svg class="icon"><use href="#i-trash"/></svg></button>
          </div>
        </div>`;
    }).join('') : '<p class="set-hint">Todavía no hay zonas. Crea la primera con «Agregar zona».</p>';
    aviso.innerHTML = dobles
      ? `<b>${plural(dobles, 'conjunto queda', 'conjuntos quedan')} dentro de dos zonas a la vez</b> (borde ámbar en el mapa): ahí los dibujos se enciman. ${dobles === 1 ? 'Queda' : 'Quedan'} sin zona hasta que se corrija el dibujo o se ${dobles === 1 ? 'le' : 'les'} ponga a mano.`
      : '';
    $('#zona-agregar-btn').disabled = editando;
    if (zonasMapa.renombrando) {
      const inp = $('#zona-renombrar-input');
      if (inp && document.activeElement !== inp) { inp.focus(); inp.select(); }
    }
  }

  // ---- CREAR, RENOMBRAR, QUITAR ----------------------------------------------
  function zonaNombreInvalido(name, actual) {
    if (!name) return 'Escribe el nombre de la zona.';
    if (name.length > 60) return 'El nombre es muy largo (máximo 60 letras).';
    const igual = (zonasMapa.lista || []).some(z => z.name !== actual && z.name.toLowerCase() === name.toLowerCase());
    return igual ? 'Ya hay una zona con ese nombre.' : '';
  }
  function zonaErrorTexto(e) {
    return e && e.code === '23505' ? 'Ya hay una zona con ese nombre.' : 'No se pudo guardar: ' + ((e && e.message) || e);
  }
  const zonaNombreLimpio = (v) => String(v || '').trim().replace(/\s+/g, ' ');

  function zonaNuevaAbrir() {
    zonasMapa.renombrando = null;
    $('#zona-nueva').classList.remove('hidden');
    $('#zona-nueva-err').classList.add('hidden');
    $('#zona-nueva-nombre').focus();
  }
  function zonaNuevaCerrar() {
    $('#zona-nueva').classList.add('hidden');
    $('#zona-nueva-nombre').value = '';
  }
  async function zonaNuevaCrear() {
    const inp = $('#zona-nueva-nombre'), err = $('#zona-nueva-err'), btn = $('#zona-nueva-crear');
    const name = zonaNombreLimpio(inp.value);
    const msg = zonaNombreInvalido(name);
    if (msg) { err.textContent = msg; err.classList.remove('hidden'); inp.focus(); return; }
    btn.disabled = true;
    try {
      const orden = Math.max(0, ...(zonasMapa.lista || []).map(z => Number(z.sort_order) || 0)) + 1;
      await Api.createRouteZone(name, orden);
      zonaNuevaCerrar();
      await zonasRecargar();
      zonaEdicionEmpezar(name);
      toast(`Zona «${name}» creada. Ahora márcala en el mapa.`);
    } catch (e) {
      err.textContent = zonaErrorTexto(e); err.classList.remove('hidden');
    } finally { btn.disabled = false; }
  }

  async function zonaRenombrarGuardar(name) {
    const inp = $('#zona-renombrar-input'), err = $('#zona-renombrar-err');
    if (!inp) return;
    const nuevo = zonaNombreLimpio(inp.value);
    if (nuevo === name) { zonasMapa.renombrando = null; zonasPintarLista(); return; }
    const msg = zonaNombreInvalido(nuevo, name);
    if (msg) { err.textContent = msg; err.classList.remove('hidden'); inp.focus(); return; }
    try {
      // La BD lo propaga (ON UPDATE CASCADE): la columna de minutos y los
      // conjuntos puestos a mano siguen apuntando a la misma zona.
      await Api.updateRouteZone(name, { name: nuevo });
      zonasMapa.renombrando = null;
      await zonasRecargar();
      toast(`«${name}» ahora se llama «${nuevo}».`);
    } catch (e) {
      err.textContent = zonaErrorTexto(e); err.classList.remove('hidden');
    }
  }

  async function zonaQuitar(name) {
    const aMano = (zonasMapa.residencias || []).filter(r => r.zona_jefe === name).length;
    const msg = `¿Quitar la zona «${name}»?\n\nSe borran su dibujo y su columna de minutos en la tabla de tiempos.`
      + (aMano ? `\n${aMano} ${aMano === 1 ? 'conjunto que la tenía puesta a mano vuelve' : 'conjuntos que la tenían puesta a mano vuelven'} a «Según el mapa».` : '')
      + '\n\nNo se puede deshacer.';
    if (!confirm(msg)) return;
    try {
      await Api.deleteRouteZone(name);
      await zonasRecargar();
      toast(`Zona «${name}» quitada.`);
    } catch (e) { toast('No se pudo quitar la zona: ' + ((e && e.message) || e)); }
  }

  // ---- DIBUJAR ---------------------------------------------------------------
  const zonaRedondo = (n) => Math.round(n * 1e6) / 1e6;   // ~10 cm

  function zonaEdicionEmpezar(name) {
    const z = (zonasMapa.lista || []).find(x => x.name === name);
    if (!z) return;
    zonasMapa.renombrando = null;
    zonasMapa.editando = { name, puntos: (z.polygon || []).map(p => [Number(p[0]), Number(p[1])]), historia: [] };
    renderZonasCard();
    if (z.polygon && zonasMapa.map) zonasMapa.map.fitBounds(z.polygon, { padding: [40, 40], maxZoom: 16 });
    const el = $('#zonas-map');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function zonaEdicionPaso() {
    const ed = zonasMapa.editando;
    if (ed) ed.historia.push(ed.puntos.map(p => p.slice()));
  }

  // El lado donde agregar la esquina nueva cuesta menos perímetro: así un punto
  // marcado afuera estira la figura hacia allá en vez de cruzarla.
  function zonaMejorLado(puntos, p) {
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

  function zonaEdicionClic(latlng) {
    const ed = zonasMapa.editando;
    if (!ed) return;
    zonaEdicionPaso();
    const p = [zonaRedondo(latlng.lat), zonaRedondo(latlng.lng)];
    if (ed.puntos.length < 3) ed.puntos.push(p);
    else ed.puntos.splice(zonaMejorLado(ed.puntos, p) + 1, 0, p);
    zonasPintarEdicion();
  }

  function zonasPintarEdicion() {
    const ed = zonasMapa.editando;
    $('#zona-editbar').classList.toggle('hidden', !ed);
    $('#zonas-map').classList.toggle('editando', !!ed);
    if (!zonasMapa.capaEdicion) return;
    zonasMapa.capaEdicion.clearLayers();
    if (!ed) return;
    const c = zonaColor(ed.name), n = ed.puntos.length;
    $('#zona-editbar-t').innerHTML = `Marcando <b>${escapeHtml(ed.name)}</b> · ${n} ${n === 1 ? 'punto' : 'puntos'}`
      + `<small>${n < 3
        ? 'Toca el mapa para poner las esquinas de la zona (mínimo 3).'
        : 'Toca el mapa para agregar una esquina. Arrastra un punto para moverlo; tócalo para quitarlo.'}</small>`;
    let forma = null;
    if (n >= 3) forma = L.polygon(ed.puntos, { color: c, weight: 2, dashArray: '6 4', fillColor: c, fillOpacity: 0.2, interactive: false });
    else if (n === 2) forma = L.polyline(ed.puntos, { color: c, weight: 2, dashArray: '6 4', interactive: false });
    if (forma) forma.addTo(zonasMapa.capaEdicion);
    ed.puntos.forEach((p, i) => {
      const m = L.marker(p, {
        draggable: true, keyboard: false,
        icon: L.divIcon({ className: 'zn-vertice', html: `<span style="border-color:${c}"></span>`, iconSize: [18, 18], iconAnchor: [9, 9] }),
      });
      m.on('dragstart', () => zonaEdicionPaso());
      m.on('drag', (ev) => {
        const ll = ev.target.getLatLng();
        ed.puntos[i] = [zonaRedondo(ll.lat), zonaRedondo(ll.lng)];
        if (forma) forma.setLatLngs(ed.puntos);
      });
      m.on('dragend', () => zonasPintarEdicion());
      // Leaflet no manda el clic después de arrastrar, así que mover no borra.
      m.on('click', () => {
        if (ed.puntos.length <= 3) { toast('Una zona necesita al menos 3 puntos.'); return; }
        zonaEdicionPaso();
        ed.puntos.splice(i, 1);
        zonasPintarEdicion();
      });
      m.addTo(zonasMapa.capaEdicion);
    });
    $('#zona-deshacer-btn').disabled = !ed.historia.length;
    $('#zona-guardar-dibujo-btn').disabled = n < 3;
  }

  function zonaEdicionDeshacer() {
    const ed = zonasMapa.editando;
    if (!ed || !ed.historia.length) return;
    ed.puntos = ed.historia.pop();
    zonasPintarEdicion();
  }

  function zonaEdicionCancelar() {
    zonasMapa.editando = null;
    renderZonasCard();
  }

  async function zonaEdicionGuardar() {
    const ed = zonasMapa.editando;
    if (!ed || ed.puntos.length < 3) return;
    const btn = $('#zona-guardar-dibujo-btn');
    btn.disabled = true;
    try {
      await Api.updateRouteZone(ed.name, { polygon: ed.puntos });
      zonasMapa.editando = null;
      await zonasRecargar();
      toast(`Dibujo de «${ed.name}» guardado.`);
    } catch (e) {
      toast('No se pudo guardar el dibujo: ' + ((e && e.message) || e));
      btn.disabled = false;
    }
  }

  // ---- EVENTOS (una sola vez, por delegación) --------------------------------
  function zonasEnlazar(card) {
    if (zonasMapa.bound) return;
    zonasMapa.bound = true;
    card.addEventListener('click', (ev) => {
      const t = ev.target.closest('button');
      if (!t || t.disabled) return;
      if (t.id === 'zona-agregar-btn') return zonaNuevaAbrir();
      if (t.id === 'zona-nueva-crear') return zonaNuevaCrear();
      if (t.id === 'zona-nueva-cancelar') return zonaNuevaCerrar();
      if (t.id === 'zona-deshacer-btn') return zonaEdicionDeshacer();
      if (t.id === 'zona-cancelar-dibujo-btn') return zonaEdicionCancelar();
      if (t.id === 'zona-guardar-dibujo-btn') return zonaEdicionGuardar();
      const fila = t.closest('[data-zona]');
      if (!fila) return;
      const name = fila.dataset.zona;
      if (t.dataset.acc === 'dibujar') return zonaEdicionEmpezar(name);
      if (t.dataset.acc === 'renombrar') { zonaNuevaCerrar(); zonasMapa.renombrando = name; return zonasPintarLista(); }
      if (t.dataset.acc === 'renombrar-ok') return zonaRenombrarGuardar(name);
      if (t.dataset.acc === 'renombrar-no') { zonasMapa.renombrando = null; return zonasPintarLista(); }
      if (t.dataset.acc === 'quitar') return zonaQuitar(name);
    });
    card.addEventListener('keydown', (ev) => {
      if (ev.target.id === 'zona-nueva-nombre') {
        if (ev.key === 'Enter') { ev.preventDefault(); zonaNuevaCrear(); }
        if (ev.key === 'Escape') zonaNuevaCerrar();
      }
      if (ev.target.id === 'zona-renombrar-input') {
        const fila = ev.target.closest('[data-zona]');
        if (ev.key === 'Enter') { ev.preventDefault(); zonaRenombrarGuardar(fila.dataset.zona); }
        if (ev.key === 'Escape') { zonasMapa.renombrando = null; zonasPintarLista(); }
      }
    });
    card.addEventListener('input', (ev) => {
      if (ev.target.id === 'zona-nueva-nombre') $('#zona-nueva-err').classList.add('hidden');
      if (ev.target.id === 'zona-renombrar-input') { const e = $('#zona-renombrar-err'); if (e) e.classList.add('hidden'); }
    });
  }
