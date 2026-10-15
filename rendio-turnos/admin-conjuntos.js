// admin-conjuntos.js — Rutas › Configuración › Conjuntos (0112, 14-oct-2026).
//
// El catálogo de conjuntos (0055) se llenó por script con la lista de Julián y no
// tenía pantalla: no se podía agregar uno, corregir su pin ni sacarlo de la
// lista. Pedido de la profa el 14-oct: «agregar con pin en el mapa, editar
// nombre y pin, y desactivar en vez de borrar».
//
//   · El pin va sobre la PORTERÍA: es donde para el carro (0055). Se pone tocando
//     el mapa, arrastrándolo o pegando la coordenada de Google Maps (los
//     conjuntos cerrados de Rionegro no salen en el mapa abierto; en Google sí).
//   · Mover el pin o renombrar pone al día los viajes ya pedidos que todavía no
//     pasan (trigger de 0112). La pantalla dice cuántos son antes de guardar.
//   · Desactivar = sale de la lista para elegir (tripulante y registro); quien ya
//     vive ahí lo conserva y sus viajes siguen igual. No se borra nunca.
//   · La zona de tiempos y el sector de cobro de un conjunto nuevo salen solos
//     del dibujo que lo contiene (0108/0109): aquí no se eligen.
//
// Módulo cerrado (IIFE): solo exporta window.renderConjuntos (core.js → setTab).
(function () {
  'use strict';

  // La caja del CHECK residences_coords_oriente (0055): lo que la base acepta.
  const CAJA = { latMin: 5.9, latMax: 6.5, lngMin: -75.7, lngMax: -75.1 };
  const redondo = (n) => Math.round(Number(n) * 1e6) / 1e6;   // ~10 cm

  const cj = {
    lista: null,        // residences (activos y desactivados) · null = no cargó
    miembros: {},       // { residence_id: n tripulantes }
    error: '',
    filtro: 'activos',  // 'activos' | 'inactivos'
    q: '',
    ed: null,           // { id|null, name, note, lat, lng, orig, viajes, busy, err }
    mapa: null, puntos: null, pin: null, encuadrado: false,
    cargando: false,
  };

  const $r = () => document.getElementById('cj-root');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const avisar = (m) => { if (typeof window.toast === 'function') window.toast(m); };
  const plural = (n, s, p) => `${n} ${n === 1 ? s : p}`;
  const dentro = (lat, lng) => lat >= CAJA.latMin && lat <= CAJA.latMax && lng >= CAJA.lngMin && lng <= CAJA.lngMax;
  const fmt = (lat, lng) => (lat == null || lng == null ? '' : `${redondo(lat).toFixed(6)}, ${redondo(lng).toFixed(6)}`);

  // «6.153123, -75.379012» (lo que copia Google Maps), «6.1531 -75.379», o un
  // enlace con «@6.1531,-75.379,17z». null si no se entiende.
  function leerCoordenada(txt) {
    const m = String(txt || '').match(/(-?\d{1,2}\.\d+)\s*[,;\s]\s*(-?\d{1,3}\.\d+)/);
    if (!m) return null;
    const lat = Number(m[1]), lng = Number(m[2]);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat: redondo(lat), lng: redondo(lng) } : null;
  }

  // ── Datos ──────────────────────────────────────────────────────────────────
  async function cargar() {
    const A = window.Api;
    if (!A || typeof A.listResidencesAdmin !== 'function') { cj.lista = null; cj.error = 'Esta versión de la app no trae la lista de conjuntos.'; return; }
    cj.cargando = true;
    const [lista, miembros] = await Promise.all([
      A.listResidencesAdmin().catch((e) => { cj.error = (e && e.message) || 'No se pudo cargar la lista.'; return null; }),
      typeof A.residenceMemberCounts === 'function' ? A.residenceMemberCounts().catch(() => null) : null,
    ]);
    cj.cargando = false;
    cj.lista = lista;
    if (lista) cj.error = '';
    cj.miembros = miembros || {};
    cj.sinMiembros = !miembros;
  }
  const porId = (id) => (cj.lista || []).find((r) => r.id === id) || null;
  const visibles = () => {
    const q = cj.q.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    return (cj.lista || []).filter((r) => (cj.filtro === 'activos' ? r.is_active : !r.is_active))
      .filter((r) => !q || r.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').includes(q));
  };

  // ── El esqueleto (una vez): el mapa no se puede volver a crear en cada repinte ─
  function esqueleto(root) {
    root.innerHTML = `
      <div class="set-card" id="cj-card">
        <div class="set-ch">
          <div class="set-ci"><svg class="icon"><use href="#i-pin"/></svg></div>
          <div>
            <h2>Catálogo de conjuntos</h2>
            <p id="cj-resumen">Cargando…</p>
          </div>
          <button class="set-btn sm" id="cj-agregar" data-cj="agregar"><svg class="icon"><use href="#i-plus"/></svg>Agregar conjunto</button>
        </div>
        <div class="set-cb">
          <div id="cj-editor"></div>
          <div class="zn-map" id="cj-map"></div>
          <p class="set-hint cj-maphint" id="cj-maphint"></p>
          <div class="cj-tools">
            <div class="cj-buscar"><svg class="icon"><use href="#i-search"/></svg><input class="set-input" id="cj-q" type="search" placeholder="Buscar conjunto" aria-label="Buscar conjunto" autocomplete="off" /></div>
            <div class="set-seg3" id="cj-filtro" role="tablist" aria-label="Qué conjuntos ver"></div>
          </div>
          <div class="zn-lista cj-lista" id="cj-lista"></div>
        </div>
      </div>`;
  }

  // ── El mapa ────────────────────────────────────────────────────────────────
  function iniciarMapa() {
    if (cj.mapa) return true;
    const el = document.getElementById('cj-map');
    if (!el) return false;
    if (typeof L === 'undefined') { el.innerHTML = '<div class="zn-mapa-falla">No se pudo cargar el mapa (sin conexión).</div>'; return false; }
    const map = L.map(el, { scrollWheelZoom: true }).setView([6.152, -75.39], 13);   // Rionegro
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
    cj.puntos = L.layerGroup().addTo(map);
    map.on('click', (ev) => { if (cj.ed && !cj.ed.busy) ponerPin(ev.latlng.lat, ev.latlng.lng); });
    cj.mapa = map;
    return true;
  }

  function pintarMapa() {
    if (!iniciarMapa()) return;
    const el = document.getElementById('cj-map');
    el.classList.toggle('editando', !!cj.ed);
    cj.puntos.clearLayers();
    const ed = cj.ed;
    // Los de la vista actual; el que se edita va aparte, como pin que se arrastra.
    const lista = (cj.lista || []).filter((r) => (cj.filtro === 'activos' ? r.is_active : true));
    lista.forEach((r) => {
      if (ed && ed.id === r.id) return;
      const m = L.circleMarker([r.latitude, r.longitude], {
        radius: 6, weight: 2, color: '#FFFFFF',
        fillColor: r.is_active ? '#E2551A' : '#A39A8D', fillOpacity: r.is_active ? 1 : 0.7,
        // Mientras se edita, tocar encima de otro conjunto pone el pin ahí (el
        // clic pasa al mapa); si no, abre ese conjunto.
        interactive: !ed, bubblingMouseEvents: false,
      }).bindTooltip(r.name + (r.is_active ? '' : ' · desactivado'));
      if (!ed) m.on('click', () => editar(r.id));
      m.addTo(cj.puntos);
    });
    if (cj.pin) { cj.pin.remove(); cj.pin = null; }
    if (ed && ed.lat != null && ed.lng != null) {
      cj.pin = L.marker([ed.lat, ed.lng], {
        draggable: !ed.busy, keyboard: false, zIndexOffset: 1000,
        icon: L.divIcon({ className: 'cj-pin', html: '<span></span>', iconSize: [28, 28], iconAnchor: [14, 34] }),
      }).addTo(cj.mapa);
      cj.pin.on('dragend', (ev) => { const ll = ev.target.getLatLng(); ponerPin(ll.lat, ll.lng); });
    }
    if (!cj.encuadrado && lista.length) {
      cj.mapa.fitBounds(lista.map((r) => [r.latitude, r.longitude]), { padding: [24, 24], maxZoom: 15 });
      cj.encuadrado = true;
    }
    const hint = document.getElementById('cj-maphint');
    if (hint) hint.innerHTML = ed
      ? (ed.lat == null ? '<b>Toca el mapa donde está la portería</b> (o pega la coordenada de Google Maps arriba).' : 'Arrastra el pin o toca otro punto del mapa para moverlo. Va sobre la <b>portería</b>: es donde para el carro.')
      : 'Toca un punto del mapa para editar ese conjunto. Gris = desactivado.';
  }
  function ajustarMapa() { setTimeout(() => { try { cj.mapa && cj.mapa.invalidateSize(); } catch (_) { /* */ } }, 80); }

  function ponerPin(lat, lng) {
    const ed = cj.ed; if (!ed) return;
    lat = redondo(lat); lng = redondo(lng);
    if (!dentro(lat, lng)) { ed.err = 'Ese punto queda fuera del Oriente antioqueño. Revisa el pin.'; pintarEditorEstado(); return; }
    ed.lat = lat; ed.lng = lng; ed.err = '';
    const inp = document.getElementById('cj-coord');
    if (inp && document.activeElement !== inp) inp.value = fmt(lat, lng);
    pintarMapa();
    pintarEditorEstado();
  }

  // ── El editor (agregar o editar) ───────────────────────────────────────────
  function editar(id) {
    const r = id ? porId(id) : null;
    if (id && !r) return;
    cj.ed = r
      ? { id: r.id, name: r.name, note: r.access_note || '', lat: r.latitude, lng: r.longitude, activo: r.is_active,
          orig: { name: r.name, note: r.access_note || '', lat: r.latitude, lng: r.longitude }, viajes: null, busy: false, err: '' }
      : { id: null, name: '', note: '', lat: null, lng: null, activo: true, orig: null, viajes: null, busy: false, err: '' };
    pintarEditor();
    pintarMapa();
    pintarLista();
    if (r && cj.mapa) cj.mapa.setView([r.latitude, r.longitude], Math.max(cj.mapa.getZoom(), 16));
    const box = document.getElementById('cj-editor');
    if (box && box.scrollIntoView) box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    const nom = document.getElementById('cj-nombre');
    if (nom && !r) nom.focus();
    // Cuántos viajes ya pedidos siguen al pin si se mueve (0112).
    if (r && window.Api && typeof Api.countUpcomingTripsAt === 'function') {
      const ed = cj.ed;
      Api.countUpcomingTripsAt(r.id).then((n) => { if (cj.ed === ed) { ed.viajes = n; pintarEditorEstado(); } }).catch(() => {});
    }
  }
  function cerrarEditor() {
    cj.ed = null;
    pintarEditor(); pintarMapa(); pintarLista();
  }

  const cambio = (ed) => !ed.orig ? null : {
    nombre: ed.name.trim() !== ed.orig.name || ed.note.trim() !== (ed.orig.note || '').trim(),
    pin: ed.lat !== ed.orig.lat || ed.lng !== ed.orig.lng,
  };

  function pintarEditor() {
    const box = document.getElementById('cj-editor'); if (!box) return;
    const ed = cj.ed;
    if (!ed) { box.innerHTML = ''; box.classList.remove('cj-ed-on'); return; }
    box.classList.add('cj-ed-on');
    const n = ed.id ? (cj.miembros[ed.id] || 0) : 0;
    box.innerHTML = `
      <div class="cj-ed" role="group" aria-label="${ed.id ? 'Editar conjunto' : 'Conjunto nuevo'}">
        <div class="cj-ed-h"><b>${ed.id ? 'Editar conjunto' : 'Conjunto nuevo'}</b>${ed.id ? `<span>${cj.sinMiembros ? '' : plural(n, 'tripulante vive aquí', 'tripulantes viven aquí')}</span>` : ''}</div>
        <div class="set-grid2">
          <div class="set-field"><label for="cj-nombre">Nombre</label>
            <input class="set-input" id="cj-nombre" maxlength="80" value="${esc(ed.name)}" placeholder="Torres de Barro Blanco" autocomplete="off" /></div>
          <div class="set-field"><label for="cj-nota">Nota de acceso (opcional)</label>
            <input class="set-input" id="cj-nota" maxlength="120" value="${esc(ed.note)}" placeholder="Portería 2 · reja verde" autocomplete="off" /></div>
        </div>
        <div class="set-field cj-coordf"><label for="cj-coord">Pin de la portería</label>
          <input class="set-input mono" id="cj-coord" value="${esc(fmt(ed.lat, ed.lng))}" placeholder="Toca el mapa o pega la coordenada: 6.153123, -75.379012" autocomplete="off" inputmode="decimal" /></div>
        <div class="cj-ed-msg" id="cj-ed-msg"></div>
        <div class="cj-ed-acts">
          <button class="set-btn ghost sm" data-cj="cancelar">Cancelar</button>
          <button class="set-btn dark sm" data-cj="guardar" id="cj-guardar">${ed.id ? 'Guardar cambios' : 'Agregar'}</button>
        </div>
      </div>`;
    pintarEditorEstado();
  }

  // Lo que cambia sin repintar los campos (para no perder el cursor).
  function pintarEditorEstado() {
    const ed = cj.ed; if (!ed) return;
    const msg = document.getElementById('cj-ed-msg'), btn = document.getElementById('cj-guardar');
    const c = cambio(ed);
    const listo = ed.name.trim() !== '' && ed.lat != null && ed.lng != null;
    const algo = !c || c.nombre || c.pin;
    if (btn) { btn.disabled = ed.busy || !listo || !algo; btn.textContent = ed.busy ? 'Guardando…' : (ed.id ? 'Guardar cambios' : 'Agregar'); }
    if (!msg) return;
    if (ed.err) { msg.className = 'cj-ed-msg err'; msg.textContent = ed.err; return; }
    msg.className = 'cj-ed-msg';
    if (c && (c.pin || c.nombre) && ed.viajes) {
      msg.innerHTML = `<b>${plural(ed.viajes, 'viaje ya pedido', 'viajes ya pedidos')}</b> a este conjunto ${ed.viajes === 1 ? 'se actualiza' : 'se actualizan'} con el cambio${c.pin ? ' (el carro va al punto nuevo)' : ''}. Si la ruta de ese día ya está publicada, vuelve a optimizarla.`;
    } else if (!ed.id) {
      msg.textContent = 'La zona de tiempos y el sector de cobro salen solos del dibujo que lo contenga.';
    } else msg.textContent = '';
  }

  async function guardar() {
    const ed = cj.ed; if (!ed || ed.busy) return;
    const name = ed.name.trim();
    if (!name) { ed.err = 'Falta el nombre del conjunto.'; pintarEditorEstado(); return; }
    if (ed.lat == null) { ed.err = 'Falta el pin: toca el mapa donde está la portería.'; pintarEditorEstado(); return; }
    const otro = (cj.lista || []).find((r) => r.id !== ed.id && r.name.trim().toLowerCase() === name.toLowerCase());
    if (otro) { ed.err = `Ya hay un conjunto con ese nombre${otro.is_active ? '' : ' (está desactivado: reactívalo en «Desactivados»)'}.`; pintarEditorEstado(); return; }
    ed.busy = true; ed.err = ''; pintarEditorEstado(); pintarMapa();
    try {
      if (ed.id) {
        const c = cambio(ed), p = {};
        if (c.nombre) { p.name = name; p.access_note = ed.note; }
        if (c.pin) { p.latitude = ed.lat; p.longitude = ed.lng; }
        await Api.updateResidence(ed.id, p);
        avisar(`«${name}» guardado`);
      } else {
        await Api.createResidence({ name, latitude: ed.lat, longitude: ed.lng, accessNote: ed.note });
        avisar(`«${name}» agregado`);
        cj.filtro = 'activos';
      }
      cj.ed = null;
      await cargar();
      pintarTodo();
    } catch (e) {
      ed.busy = false; ed.err = (e && e.message) || 'No se pudo guardar.';
      pintarEditorEstado(); pintarMapa();
    }
  }

  async function activar(id, activo) {
    const r = porId(id); if (!r) return;
    const n = cj.miembros[id] || 0;
    if (!activo) {
      const quien = n ? ` ${n === 1 ? 'La persona que vive ahí lo conserva' : `Los ${n} tripulantes que viven ahí lo conservan`} y sus viajes siguen igual.` : '';
      if (!window.confirm(`¿Desactivar «${r.name}»?\n\nYa no saldrá en la lista para elegir punto de recogida.${quien} Se puede reactivar cuando quieras.`)) return;
    }
    try {
      await Api.updateResidence(id, { is_active: !!activo });
      avisar(activo ? `«${r.name}» reactivado` : `«${r.name}» desactivado`);
      if (cj.ed && cj.ed.id === id) cj.ed = null;
      await cargar();
      pintarTodo();
    } catch (e) { avisar((e && e.message) || 'No se pudo guardar.'); }
  }

  // ── La lista ───────────────────────────────────────────────────────────────
  function pintarLista() {
    const el = document.getElementById('cj-lista'); if (!el) return;
    const act = (cj.lista || []).filter((r) => r.is_active).length, ina = (cj.lista || []).length - act;
    const res = document.getElementById('cj-resumen');
    if (res) res.textContent = cj.lista
      ? `${plural(act, 'conjunto activo', 'conjuntos activos')}${ina ? ` · ${plural(ina, 'desactivado', 'desactivados')}` : ''}. El tripulante elige el suyo de esta lista.`
      : (cj.error || 'Cargando…');
    const seg = document.getElementById('cj-filtro');
    if (seg) seg.innerHTML = [['activos', 'Activos', act], ['inactivos', 'Desactivados', ina]].map(([k, t, n]) =>
      `<button type="button" role="tab" data-cj="filtro" data-v="${k}" aria-selected="${cj.filtro === k}" class="${cj.filtro === k ? 'on' : ''}">${t} <span class="num">${n}</span></button>`).join('');
    const add = document.getElementById('cj-agregar');
    if (add) add.disabled = !cj.lista || !!cj.ed;
    if (!cj.lista) { el.innerHTML = `<p class="set-hint">${esc(cj.error || 'Cargando…')}</p>`; return; }
    const vis = visibles();
    const editando = !!cj.ed;
    el.innerHTML = vis.length ? vis.map((r) => {
      const n = cj.miembros[r.id] || 0;
      const sub = [cj.sinMiembros ? '' : plural(n, 'tripulante', 'tripulantes'), r.access_note || ''].filter(Boolean).join(' · ');
      const sel = cj.ed && cj.ed.id === r.id;
      return `
        <div class="zn-row cj-row${sel ? ' sel' : ''}${r.is_active ? '' : ' off'}" data-id="${esc(r.id)}">
          <span class="zn-sw cj-sw"></span>
          <div class="zn-info"><button type="button" class="cj-nombre" data-cj="ver" ${editando ? 'disabled' : ''}>${esc(r.name)}</button>${sub ? `<small>${esc(sub)}</small>` : ''}</div>
          <div class="zn-acc">
            ${r.is_active
              ? `<button class="set-btn ghost sm" data-cj="editar" ${editando ? 'disabled' : ''}><svg class="icon"><use href="#i-edit"/></svg>Editar</button>
                 <button class="set-btn ghost sm" data-cj="desactivar" ${editando ? 'disabled' : ''}>Desactivar</button>`
              : `<button class="set-btn ghost sm" data-cj="reactivar" ${editando ? 'disabled' : ''}>Reactivar</button>`}
          </div>
        </div>`;
    }).join('')
      : `<p class="set-hint">${cj.q.trim() ? 'Ningún conjunto con ese nombre.' : cj.filtro === 'activos' ? 'Todavía no hay conjuntos. Agrega el primero.' : 'No hay conjuntos desactivados.'}</p>`;
  }

  function pintarTodo() { pintarEditor(); pintarLista(); pintarMapa(); }

  // ── Eventos (delegados en la raíz, una vez) ────────────────────────────────
  function enlazar(root) {
    if (root.__cj) return; root.__cj = true;
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-cj]'); if (!b || b.disabled) return;
      const a = b.getAttribute('data-cj');
      const id = b.closest('[data-id]') && b.closest('[data-id]').getAttribute('data-id');
      if (a === 'agregar') editar(null);
      else if (a === 'cancelar') cerrarEditor();
      else if (a === 'guardar') guardar();
      else if (a === 'editar') editar(id);
      else if (a === 'ver') { const r = porId(id); if (r && r.is_active) editar(id); else if (r && cj.mapa) cj.mapa.setView([r.latitude, r.longitude], 16); }
      else if (a === 'desactivar') activar(id, false);
      else if (a === 'reactivar') activar(id, true);
      else if (a === 'filtro') { cj.filtro = b.getAttribute('data-v'); pintarLista(); pintarMapa(); }
    });
    root.addEventListener('input', (e) => {
      const t = e.target, ed = cj.ed;
      if (t.id === 'cj-q') { cj.q = t.value; pintarLista(); return; }
      if (!ed) return;
      if (t.id === 'cj-nombre') { ed.name = t.value; ed.err = ''; pintarEditorEstado(); }
      else if (t.id === 'cj-nota') { ed.note = t.value; pintarEditorEstado(); }
      else if (t.id === 'cj-coord') {
        const p = leerCoordenada(t.value);
        if (p) { ponerPin(p.lat, p.lng); if (cj.mapa && dentro(p.lat, p.lng)) cj.mapa.setView([p.lat, p.lng], Math.max(cj.mapa.getZoom(), 16)); }
      }
    });
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && cj.ed && /^cj-(nombre|nota|coord)$/.test(e.target.id)) { e.preventDefault(); guardar(); }
      if (e.key === 'Escape' && cj.ed) cerrarEditor();
    });
    root.addEventListener('focusout', (e) => {
      // La coordenada mal pegada se dice al salir del campo, no a cada tecla.
      if (e.target.id !== 'cj-coord' || !cj.ed) return;
      const v = e.target.value.trim();
      if (v && !leerCoordenada(v)) { cj.ed.err = 'No entendí esa coordenada. Cópiala de Google Maps así: 6.153123, -75.379012'; pintarEditorEstado(); }
      else if (!v || leerCoordenada(v)) e.target.value = fmt(cj.ed.lat, cj.ed.lng);
    });
  }

  async function renderConjuntos() {
    const root = $r(); if (!root) return;
    if (!root.querySelector('#cj-card')) esqueleto(root);
    enlazar(root);
    cj.ed = null;
    pintarTodo();
    ajustarMapa();
    await cargar();
    pintarTodo();
    ajustarMapa();
  }

  window.renderConjuntos = renderConjuntos;
  // Para las pruebas (jsdom): el estado y el lector de coordenadas.
  window.renderConjuntos._cj = cj;
  window.renderConjuntos._leer = leerCoordenada;
})();
