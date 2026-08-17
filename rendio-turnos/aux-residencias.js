// aux-residencias.js — Paso 3 del pedido, sobre el catálogo verificado (0055).
//
// POR QUÉ EXISTE ESTE ARCHIVO
// La migración 0055 se escribió en agosto con una frase explícita: «El auxiliar
// ELIGE su conjunto de una lista; no escribe». Nunca se implementó del lado del
// pasajero. Hasta hoy el auxiliar escribía su dirección en texto libre y la
// geocodificábamos con Nominatim, que de los 41 conjuntos donde vive la
// tripulación conoce 4 — y donde acierta el nombre puede errar el tramo (el caso
// que originó la tabla quedó a 2.106 m del sitio). Un carro mandado a 2 km del
// punto a las 3 de la mañana es un vuelo perdido.
//
// Rediseño del diseñador (§7 de la entrega 2026-08-17), respetado tal cual:
// elegir el conjunto es el camino PRINCIPAL, escribir + arrastrar pin queda como
// camino de EXCEPCIÓN, y el punto guardado va arriba para que el caso normal se
// resuelva en un toque y sin pin.
//
// TRES COSAS DEL DISEÑO QUE NO SE PINTAN, A PROPÓSITO
//  · «11 compañeros» por conjunto: el auxiliar solo puede leer SU perfil
//    (p_auxiliar_profiles_select_own). Contar los demás sería inventar un número
//    o abrir a cada tripulante el padrón de dónde vive el resto.
//  · «Portería principal / norte» por conjunto: es residences.access_note, y hoy
//    está vacía en las 41 filas. El selector se pinta solo si la fila trae texto.
//  · «Otros 10 salen de aquí»: mismo motivo que el primero.
// Ver [feedback-no-inventar-datos]. Las ranuras quedan listas: el día que la BD
// las llene, aparecen solas.

(function () {
  'use strict';

  const st = {
    cat: null,        // catálogo cargado (array) o null si aún no / falló
    place: null,      // punto guardado del auxiliar (Api.getMyAuxiliarPlace)
    loading: false,
    failed: false,
    q: '',            // texto del buscador
    saving: false,
  };

  // Comparación sin acentos ni mayúsculas: nadie escribe "Cámbulo" con tilde en
  // un teclado de teléfono a las 11 de la noche.
  const norm = (s) => (s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // ---------- carga ----------
  // Se llama al entrar al paso 3. Si falla, no se bloquea al auxiliar: cae al
  // camino manual, que es el que existía antes de este archivo.
  async function load() {
    if (st.cat || st.loading) return;
    st.loading = true; st.failed = false;
    try {
      const [cat, place] = await Promise.all([
        window.Api?.listResidences ? Api.listResidences() : null,
        window.Api?.getMyAuxiliarPlace ? Api.getMyAuxiliarPlace() : null,
      ]);
      st.cat = Array.isArray(cat) ? cat : null;
      st.place = place || null;
      st.failed = !st.cat;
    } catch (_) { st.failed = true; st.cat = null; }
    finally {
      st.loading = false;
      // Si el auxiliar ya está parado en el paso 3, se repinta: si no, se queda
      // mirando el spinner para siempre porque nadie más lo va a despertar.
      const A = window.Auxiliar;
      if (A && A.state && A.state.view === 'form' && A.state.step === 3) A.rerender();
    }
  }

  const byId = (id) => (st.cat || []).find(r => r.id === id) || null;
  // El punto guardado solo cuenta si sigue vivo en el catálogo: si la operación
  // desactivó el conjunto, no se le ofrece como atajo.
  function savedRes() {
    const id = st.place?.residenceId; if (!id) return null;
    return byId(id) || (st.place.residence || null);
  }

  // ¿El paso 3 está resuelto? Con residencia elegida sí — la coordenada la pone
  // el trigger desde el catálogo, así que no hay pin que confirmar.
  function ready(f) {
    if (f.residenceId) return true;
    return !!(f.address && f.locConfirmed);
  }

  // ---------- pantalla ----------
  // Devuelve null cuando el paso 3 debe pintarlo auxiliar.js con el camino viejo
  // (el auxiliar pidió escribir la dirección, o el catálogo no cargó).
  function html(f) {
    if (f.manualAddr) return null;
    if (st.loading || (!st.cat && !st.failed)) {
      return `<div class="axr-load"><span class="axr-spin"></span>Cargando los puntos de recogida…</div>`;
    }
    if (st.failed || !st.cat || !st.cat.length) return null;
    if (f.residenceId) return confirmHTML(f);
    return pickHTML(f);
  }

  function pickHTML(f) {
    const isLle = f.type === 'lle';
    const saved = savedRes();
    const q = st.q;
    const list = q
      ? st.cat.filter(r => norm(r.name + ' ' + (r.sector || '')).includes(norm(q)))
      : st.cat;

    const savedBlock = (!q && saved) ? `
      <div class="axr-lbl">Tu punto</div>
      <button class="axr-saved" data-ax="res-pick" data-id="${esc(saved.id)}">
        <span class="axr-saved-ic"><svg class="icon"><use href="#i-home"/></svg></span>
        <span class="axr-saved-txt">
          <b>${esc(saved.name)}</b>
          ${saved.sector ? `<span>${esc(saved.sector)}</span>` : ''}
          <em><svg class="icon"><use href="#i-check"/></svg>Ubicación verificada</em>
        </span>
        <svg class="icon axr-chev"><use href="#i-chev"/></svg>
      </button>` : '';

    const rows = list.length ? list.map((r, i) => `
      <button class="axr-row${i === 0 ? ' first' : ''}" data-ax="res-pick" data-id="${esc(r.id)}">
        <span class="axr-row-txt">
          <b>${esc(r.name)}</b>
          ${r.sector || r.access_note ? `<span>${esc([r.sector, r.access_note].filter(Boolean).join(' · '))}</span>` : ''}
        </span>
        <svg class="icon axr-chev"><use href="#i-chev"/></svg>
      </button>`).join('') : `
      <div class="axr-none">
        <b>No encontramos «${esc(q)}»</b>
        <span>Puede que tu punto no esté en el catálogo todavía. Abajo puedes escribir la dirección.</span>
      </div>`;

    return `
      <p class="ax-lead">${isLle
        ? 'Elige dónde te dejamos. Ya tenemos ubicadas las porterías de Rionegro.'
        : 'Elige el punto. Ya tenemos ubicadas las porterías de Rionegro.'}</p>
      ${savedBlock}
      <div class="axr-lbl">${saved && !q ? 'Otro punto' : 'Busca tu conjunto'}</div>
      <div class="axr-search">
        <svg class="icon"><use href="#i-search"/></svg>
        <input id="axr-q" type="text" value="${esc(q)}" placeholder="Busca tu conjunto o sector" autocomplete="off" />
        ${q ? `<button class="axr-clear" data-ax="res-clear" aria-label="Limpiar">
          <svg class="icon"><use href="#i-x"/></svg></button>` : ''}
      </div>
      <div class="axr-list">${rows}</div>
      <button class="axr-manual" data-ax="res-manual">
        <span class="axr-manual-ic"><svg class="icon"><use href="#i-plus"/></svg></span>
        <span class="axr-manual-txt">
          <b>Mi punto no está en la lista</b>
          <span>Escribe la dirección y ubica el pin</span>
        </span>
      </button>`;
  }

  function confirmHTML(f) {
    const r = byId(f.residenceId) || st.place?.residence;
    if (!r) return null;
    const isLle = f.type === 'lle';
    const yaEsSuPunto = st.place?.residenceId === r.id;
    return `
      <div class="axr-picked">
        <div class="axr-picked-head">
          <div>
            <b>${esc(r.name)}</b>
            ${r.sector ? `<span>${esc(r.sector)}</span>` : ''}
          </div>
          <button class="ax-link" data-ax="res-change">Cambiar</button>
        </div>
        <div id="axr-map" class="axr-map"></div>
        <div class="axr-verified">
          <span class="axr-verified-ic"><svg class="icon"><use href="#i-check"/></svg></span>
          <div>
            <b>Ubicación verificada</b>
            <span>No necesitas mover el pin. ${isLle ? 'Ahí te dejamos.' : 'Ahí te recogemos.'}</span>
          </div>
        </div>
      </div>
      ${r.access_note ? `<div class="ax-hint"><svg class="icon"><use href="#i-pin"/></svg>${esc(r.access_note)}</div>` : ''}
      ${yaEsSuPunto ? '' : `
        <button class="axr-save${st.saving ? ' busy' : ''}" data-ax="res-save"${st.saving ? ' disabled' : ''}>
          <svg class="icon"><use href="#i-save"/></svg>${st.saving ? 'Guardando…' : 'Guardar como mi punto'}
        </button>`}
      <div class="ax-toggles">
        ${window.Auxiliar?.toggleHTML
          ? window.Auxiliar.toggleHTML('¿Es una pernocta?', 'isPernocta', f.isPernocta, 'Pasas la noche entre vuelos (hotel).')
            + window.Auxiliar.toggleHTML('¿Es una reserva en firme?', 'isReserva', f.isReserva !== false, 'Confírmanos que el viaje va.')
          : ''}
      </div>
      ${window.Auxiliar?.fieldHTML
        ? window.Auxiliar.fieldHTML('Notas para el conductor (opcional)', 'notes', f.notes || '', 'Ej: portería 3, timbre 302', 'textarea')
        : ''}`;
  }

  // ---------- mapa del punto verificado ----------
  // Pin FIJO, no arrastrable: la coordenada la midió la operación a mano con el
  // pin de Google Maps. Dejarlo arrastrable invitaría a "corregir" un dato que
  // está bien y a mandar el carro a donde no es.
  let map = null;
  function afterRender(f) {
    if (!f.residenceId) { destroyMap(); return; }
    const r = byId(f.residenceId) || st.place?.residence;
    const el = document.getElementById('axr-map');
    if (!r || !el || typeof L === 'undefined') return;
    destroyMap();
    map = L.map(el, { zoomControl: false, attributionControl: false,
      dragging: false, scrollWheelZoom: false, doubleClickZoom: false,
      boxZoom: false, keyboard: false, touchZoom: false, tap: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
    map.setView([r.latitude, r.longitude], 16);
    L.marker([r.latitude, r.longitude]).addTo(map);
    setTimeout(() => { try { map.invalidateSize(); } catch (_) {} }, 60);
  }
  function destroyMap() {
    if (!map) return;
    try { map.remove(); } catch (_) {}
    map = null;
  }

  // ---------- eventos ----------
  // Devuelve true si consumió el clic (auxiliar.js repinta) y 'silent' si ya se
  // encargó del repintado por su cuenta.
  function handle(action, el, f) {
    if (action === 'res-pick') {
      const r = byId(el.dataset.id); if (!r) return true;
      f.residenceId = r.id;
      // El texto y la coord se guardan solo para PINTAR (resumen del paso 4 y
      // tarjetas). Al crear la reserva NO se envían: los pone el trigger desde
      // el catálogo. Ver createReservation en api.js.
      f.address = r.name + (r.sector ? ', ' + r.sector : '');
      f.lat = r.latitude; f.lng = r.longitude;
      f.locConfirmed = true; f.manualAddr = false;
      st.q = '';
      return true;
    }
    if (action === 'res-change') {
      f.residenceId = null; f.address = ''; f.lat = null; f.lng = null;
      f.locConfirmed = false;
      destroyMap();
      return true;
    }
    if (action === 'res-manual') {
      // Camino de excepción: el de siempre. Se limpia la residencia para que no
      // queden los dos puestos y gane el que no eligió.
      f.manualAddr = true; f.residenceId = null;
      f.address = ''; f.lat = null; f.lng = null; f.locConfirmed = false;
      destroyMap();
      return true;
    }
    if (action === 'res-catalog') { f.manualAddr = false; return true; }
    if (action === 'res-clear') { st.q = ''; return true; }
    if (action === 'res-save') { saveMine(f); return 'silent'; }
    return false;
  }

  async function saveMine(f) {
    if (st.saving || !f.residenceId) return;
    st.saving = true;
    if (window.Auxiliar?.rerender) window.Auxiliar.rerender();
    try {
      await Api.saveMyResidence(f.residenceId);
      if (!st.place) st.place = {};
      st.place.residenceId = f.residenceId;
      st.place.residence = byId(f.residenceId);
      if (typeof toast === 'function') toast('Listo — la próxima vez lo tendrás de una.');
    } catch (_) {
      if (typeof toast === 'function') toast('No se pudo guardar tu punto. Puedes seguir con el traslado igual.');
    } finally {
      st.saving = false;
      if (window.Auxiliar?.rerender) window.Auxiliar.rerender();
    }
  }

  // El buscador escribe en el estado del módulo y repinta SOLO la lista, para no
  // remontar el input y perder el foco/cursor en cada tecla.
  function onQuery(v, f) {
    st.q = v;
    const cont = document.querySelector('.axr-list');
    if (!cont) { return false; }
    const tmp = document.createElement('div');
    tmp.innerHTML = pickHTML(f);
    const fresh = tmp.querySelector('.axr-list');
    if (fresh) cont.innerHTML = fresh.innerHTML;
    // El botón de limpiar aparece/desaparece según haya texto.
    const search = document.querySelector('.axr-search');
    if (search) {
      const has = !!search.querySelector('.axr-clear');
      if (v && !has) {
        const b = document.createElement('button');
        b.className = 'axr-clear'; b.setAttribute('data-ax', 'res-clear');
        b.setAttribute('aria-label', 'Limpiar');
        b.innerHTML = '<svg class="icon"><use href="#i-x"/></svg>';
        search.appendChild(b);
      } else if (!v && has) { search.querySelector('.axr-clear').remove(); }
    }
    return true;
  }

  // Deliberadamente NO se autoselecciona el punto guardado.
  //
  // Se probó y se descartó: el atajo quedaba dependiendo de si el catálogo ya
  // había llegado (unas veces el paso 3 abría resuelto y otras no, con los
  // mismos datos), y sobre todo, quien se acaba de mudar necesita VER la lista.
  // La maqueta del diseñador tampoco autoselecciona: pone «Tus puntos» arriba.
  // Es un toque, no cero — y siempre el mismo.

  window.AuxResidencias = {
    load, html, handle, afterRender, ready, onQuery, destroyMap,
    hasCatalog: () => !!(st.cat && st.cat.length),
    count: () => (st.cat || []).length,
  };
})();
