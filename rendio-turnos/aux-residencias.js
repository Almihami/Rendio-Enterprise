// aux-residencias.js — El paso del punto del pedido, sobre el catálogo verificado (0055).
// (Era «el paso 3»; desde el 15-sep-2026 solo aparece cuando hay algo que elegir.)
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
    // El auxiliar pidió cambiar el punto que le pusimos solo. Mientras esté en
    // true no se vuelve a autocompletar: si no, tocar «Cambiar» devolvería el
    // mismo punto en el siguiente repintado y el botón parecería roto.
    picking: false,
    // Con dos unidades: el tripulante pidió salir de un tercer sitio hoy, así
    // que se le abre el catálogo completo en vez del selector de dos.
    otro: false,
  };

  // Comparación sin acentos ni mayúsculas: nadie escribe "Cámbulo" con tilde en
  // un teclado de teléfono a las 11 de la noche.
  const norm = (s) => (s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // ── Rediseño (P5, 27-sep-2026) ───────────────────────────────────────────
  // Con el shell nuevo encendido, el paso se pinta con el aspecto rx (rx-opt,
  // rx-input search, rx-lbl, rx-note) y el MISMO contrato: data-ax="res-*",
  // #axr-q, .axr-list, .axr-hint, .axr-search. Apagado, todo como siempre.
  const rxOn = () => {
    try { return !!(window.AuxShell && typeof AuxShell.on === 'function' && AuxShell.on() && window.AuxRxUI); }
    catch (_) { return false; }
  };
  const rxIc = (n, sz) => (window.AuxRxUI ? AuxRxUI.ic(n, sz) : '');
  // El aviso: con el rediseño, el toast del shell; si no, el de siempre.
  function say(msg, icon) {
    try { if (rxOn() && typeof AuxShell.toast === 'function') { AuxShell.toast(msg, icon || 'Check'); return; } } catch (_) { /* */ }
    if (typeof toast === 'function') toast(msg);
  }

  // ---------- carga ----------
  // Se llama al entrar al rol y al arrancar un pedido. Si falla, no se bloquea
  // al auxiliar: cae al camino manual, que es el que existía antes de este archivo.
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
      // Si el auxiliar ya está parado en el paso del punto, se repinta: si no,
      // se queda mirando el spinner para siempre porque nadie más lo va a
      // despertar. El paso se reconoce por NOMBRE (15-sep-2026: ya no es
      // siempre el 3); el número queda como respaldo para un auxiliar.js viejo.
      // SE PREGUNTA ANTES DE APAGAR `loading`, a propósito: con el catálogo
      // recién puesto y una sola unidad, stepKind() ya haría el autocompletado
      // y el paso 'donde' desaparecería de la lista — «no estaba en donde», y
      // nadie repintaría el spinner que sigue en pantalla.
      const A = window.Auxiliar;
      const enDonde = A && A.state && A.state.view === 'form'
        && (A.stepKind ? A.stepKind() === 'donde' : A.state.step === 3);
      st.loading = false;
      if (enDonde) A.rerender();
      else if (pickerOpen()) { try { AuxShell.render(); } catch (_) { /* */ } }
    }
  }

  const byId = (id) => (st.cat || []).find(r => r.id === id) || null;

  // ── Dos unidades (0075) ──────────────────────────────────────────────────
  // «Unidad» es el apartamento. Quien registró dos sitios elige en CADA pedido
  // de cuál sale: es lo que pidió el jefe — «a los que tengan la otra opción de
  // unidad, que se le abra como una selección: sea la unidad 1 o sea la 2».
  // Se modela como la pareja completa conjunto+apartamento, así que la elección
  // puede cambiar la portería a la que va el carro, no solo el timbre.
  const hasTwo = () => !!(st.place?.residenceId && st.place?.residenceId2);
  function unitN(n) {
    if (!st.place) return null;
    const id = n === 1 ? st.place.residenceId : st.place.residenceId2;
    if (!id) return null;
    const r = byId(id) || (n === 1 ? st.place.residence : st.place.residence2);
    if (!r) return null;
    return { n, id, res: r, unit: (n === 1 ? st.place.unit : st.place.unit2) || '' };
  }
  // Cuál de las dos está elegida en este pedido (o null si ninguna).
  function chosenN(f) {
    if (!hasTwo() || !f.residenceId) return null;
    if (f.residenceId === st.place.residenceId && (f.residenceUnit || '') === (st.place.unit || '')) return 1;
    if (f.residenceId === st.place.residenceId2 && (f.residenceUnit || '') === (st.place.unit2 || '')) return 2;
    return null;
  }
  function unitCardHTML(u, sel) {
    return `<button class="ax-opt${sel ? ' sel' : ''}" data-ax="res-unit" data-n="${u.n}">
      <span class="ax-opt-ic axr-unit-ic"><svg class="icon"><use href="#i-home"/></svg></span>
      <div><b>${esc(u.unit || 'Unidad ' + u.n)}</b><span>${esc(u.res.name)}${u.res.sector ? ' · ' + esc(u.res.sector) : ''}</span></div>
      <span class="ax-radio">${sel ? '<svg class="icon"><use href="#i-check"/></svg>' : ''}</span>
    </button>`;
  }
  function unitChooserHTML(f) {
    const a = unitN(1), b = unitN(2);
    if (!a || !b) return '';
    const c = chosenN(f);
    if (rxOn()) return rxUnitChooserHTML(a, b, c);
    return `
      <div class="axr-lbl">¿De cuál sales?</div>
      ${unitCardHTML(a, c === 1)}
      ${unitCardHTML(b, c === 2)}
      <div class="axr-otro">
        <button class="ax-link" data-ax="res-otro">Hoy salgo de otro lado</button>
      </div>`;
  }
  // El punto guardado solo cuenta si sigue vivo en el catálogo: si la operación
  // desactivó el conjunto, no se le ofrece como atajo.
  function savedRes() {
    const id = st.place?.residenceId; if (!id) return null;
    return byId(id) || (st.place.residence || null);
  }

  // ── Autocompletar el punto del registro (profa, 7-sep-2026) ──────────────
  //
  // «Si solo tiene una dirección asociada, que se autocomplete; si tiene 2, que
  // despliegue una lista.» Es lo que el registro promete cuando pide el punto:
  // «esto queda guardado, no vas a tener que escribirlo otra vez».
  //
  // Debajo de esta función vivía la nota que decía justo lo contrario. Sus dos
  // razones se atendieron, no se ignoraron:
  //  · «Unas veces abría resuelto y otras no»: eso pasaba porque se autoelegía
  //    con lo que hubiera llegado. Ahora solo se autocompleta con el catálogo YA
  //    cargado, y mientras carga el paso muestra su propio estado — así que el
  //    resultado es el mismo siempre.
  //  · «Quien se acaba de mudar necesita ver la lista»: la ve en un toque con
  //    «Cambiar», y el paso dice que el punto lo pusimos nosotros.
  // Con DOS unidades no se autocompleta nada: adivinar de cuál de sus dos casas
  // sale hoy es justo lo que el jefe pidió preguntar.
  function autofill(f) {
    if (!st.cat || !st.cat.length) return false;   // sin catálogo no hay qué poner
    if (f.residenceId || f.manualAddr) return false;
    if (st.picking || st.otro) return false;       // lo está cambiando a mano
    if (hasTwo()) return false;                    // dos unidades → elige él
    const r = savedRes(); if (!r) return false;
    f.residenceId = r.id;
    f.residenceUnit = st.place?.unit || null;
    f.address = r.name + (r.sector ? ', ' + r.sector : '');
    f.lat = r.latitude; f.lng = r.longitude;
    f.locConfirmed = true; f.manualAddr = false;
    f.placeAuto = true;                            // para decirlo en pantalla
    return true;
  }

  // ¿El paso del punto está resuelto? Con residencia elegida sí — la coordenada
  // la pone el trigger desde el catálogo, así que no hay pin que confirmar.
  function ready(f) {
    if (f.residenceId) return true;
    return !!(f.address && f.locConfirmed);
  }

  // «Cambiar» desde el RESUMEN (15-sep-2026). Con una sola unidad el paso del
  // punto ya no se ve —se pone solo—, así que el resumen es donde el tripulante
  // dice «hoy no salgo de ahí». Se vacía el punto y se marca `picking` para que
  // autofill no se lo vuelva a poner en el siguiente repintado; `otro` en falso
  // para que, con dos unidades, lo que se abra sea el selector de las dos y no
  // el catálogo entero. auxiliar.js pone `f.dondeForced` y salta al paso.
  function forcePick(f) {
    st.picking = true; st.otro = false; st.q = '';
    f.residenceId = null; f.residenceUnit = null;
    f.address = ''; f.lat = null; f.lng = null;
    f.locConfirmed = false; f.placeAuto = false;
    // Si el pedido venía del camino manual, «Cambiar» abre el CATÁLOGO (que es
    // lo que el botón dice), no otra vez la dirección en blanco; el camino
    // manual sigue a un toque en «Mi punto no está en la lista».
    f.manualAddr = false;
    destroyMap();
  }

  // ---------- pantalla ----------
  // Devuelve null cuando el paso del punto debe pintarlo auxiliar.js con el
  // camino viejo (el auxiliar pidió escribir la dirección, o el catálogo no cargó).
  function html(f) {
    if (f.manualAddr) return null;
    if (st.loading || (!st.cat && !st.failed)) {
      if (rxOn()) return `<div class="rx-pd-load rx-in"><span class="rx-spin dk"></span>Cargando los puntos de recogida…</div>`;
      return `<div class="axr-load"><span class="axr-spin"></span>Cargando los puntos de recogida…</div>`;
    }
    if (st.failed || !st.cat || !st.cat.length) return null;
    // Con dos unidades registradas, lo primero es elegir de cuál sale. Solo si
    // dice «hoy salgo de otro lado» (st.otro) se le muestra el catálogo entero.
    if (hasTwo() && !st.otro) {
      const cuerpo = unitChooserHTML(f);
      if (cuerpo) return cuerpo + (chosenN(f) ? confirmHTML(f, true) : '');
    }
    if (f.residenceId) return confirmHTML(f);
    return pickHTML(f);
  }

  function pickHTML(f) {
    if (rxOn()) return rxPickHTML(f);
    const isLle = f.type === 'lle';
    const saved = savedRes();
    const q = st.q;
    // BUSCADOR PRIMERO (profa, 15-sep-2026): la lista entera no se pinta al
    // entrar —42 filas para bajar con el dedo hasta la suya—; aparece solo
    // cuando hay texto. Sin texto la lista queda VACÍA pero presente, para que
    // onQuery la llene en cada tecla sin repintar el paso (y sin perder el foco).
    const list = q
      ? st.cat.filter(r => norm(r.name + ' ' + (r.sector || '')).includes(norm(q)))
      : [];

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

    // Sin texto: '' exacto (ni un espacio), que es lo que `.axr-list:empty`
    // necesita para esconder el marco vacío.
    const rows = !q ? '' : list.length ? list.map((r, i) => `
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
      <div class="axr-hint"${q ? ' hidden' : ''}>Escribe el nombre de tu conjunto o el sector.</div>
      <div class="axr-list">${rows}</div>
      <button class="axr-manual" data-ax="res-manual">
        <span class="axr-manual-ic"><svg class="icon"><use href="#i-plus"/></svg></span>
        <span class="axr-manual-txt">
          <b>Mi punto no está en la lista</b>
          <span>Escribe la dirección y ubica el pin</span>
        </span>
      </button>`;
  }

  // `compacto` = viene colgado del selector de dos unidades: ya se sabe cuál es
  // y por qué, así que sobran el botón de cambiar y el de guardar como mi punto.
  function confirmHTML(f, compacto) {
    const r = byId(f.residenceId) || st.place?.residence;
    if (!r) return null;
    if (rxOn()) return rxConfirmHTML(f, r, compacto);
    const isLle = f.type === 'lle';
    const yaEsSuPunto = compacto || st.place?.residenceId === r.id;
    return `
      <div class="axr-picked">
        <div class="axr-picked-head">
          <div>
            <b>${esc(r.name)}</b>
            ${r.sector ? `<span>${esc(r.sector)}</span>` : ''}
          </div>
          ${compacto ? '' : `<button class="ax-link" data-ax="res-change">Cambiar</button>`}
        </div>
        ${f.placeAuto ? `<div class="axr-auto"><svg class="icon"><use href="#i-check"/></svg>
          Es el punto que dejaste en tu registro. Si hoy sales de otro lado, toca «Cambiar».</div>` : ''}
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
        </button>`}`;
    // AQUÍ VIVÍAN la pernocta, la reserva en firme y las notas (vía
    // Auxiliar.toggleHTML/fieldHTML). Se mudaron el 15-sep-2026: este paso ya
    // no lo ve todo el mundo, y esos datos son del viaje, no del punto. Los
    // toggles están en «Datos del vuelo» y las notas en «Revisa y confirma».
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
  // OJO con los nombres: auxiliar.js solo delega en este módulo las acciones que
  // empiezan por `res-`. Una acción que se llame «unit-pick» llega al dispatcher
  // general, no la reclama nadie y el botón queda muerto sin decir nada.
  function handle(action, el, f) {
    if (action === 'res-pick') {
      const r = byId(el.dataset.id); if (!r) return true;
      f.residenceId = r.id;
      // El apartamento solo se arrastra si el conjunto elegido es uno de los
      // suyos; si eligió otro sitio, el apartamento del perfil no significa
      // nada ahí y mandarlo mandaría al conductor a timbrar a una puerta que
      // no existe.
      f.residenceUnit = (st.place && r.id === st.place.residenceId) ? (st.place.unit || null)
        : (st.place && r.id === st.place.residenceId2) ? (st.place.unit2 || null)
        : null;
      // El texto y la coord se guardan solo para PINTAR (resumen del paso 4 y
      // tarjetas). Al crear la reserva NO se envían: los pone el trigger desde
      // el catálogo. Ver createReservation en api.js.
      f.address = r.name + (r.sector ? ', ' + r.sector : '');
      f.lat = r.latitude; f.lng = r.longitude;
      f.locConfirmed = true; f.manualAddr = false; f.placeAuto = false;
      st.q = '';
      return true;
    }
    if (action === 'res-unit') {
      const u = unitN(parseInt(el.dataset.n, 10)); if (!u) return true;
      f.residenceId = u.id;
      f.residenceUnit = u.unit || null;
      f.address = u.res.name + (u.res.sector ? ', ' + u.res.sector : '');
      f.lat = u.res.latitude; f.lng = u.res.longitude;
      f.locConfirmed = true; f.manualAddr = false;
      return true;
    }
    if (action === 'res-otro') {
      // No borra lo elegido a lo bruto: si ya había una unidad puesta se
      // conserva hasta que escoja otra cosa, para no dejar el paso en rojo.
      st.otro = true; st.q = ''; f.placeAuto = false;
      f.residenceId = null; f.residenceUnit = null;
      f.address = ''; f.lat = null; f.lng = null; f.locConfirmed = false;
      destroyMap();
      return true;
    }
    if (action === 'res-change') {
      st.picking = true;                 // no se lo volvamos a poner solo
      f.residenceId = null; f.address = ''; f.lat = null; f.lng = null;
      f.locConfirmed = false; f.placeAuto = false;
      destroyMap();
      return true;
    }
    if (action === 'res-retry') { retry(); return true; }
    if (action === 'res-manual') {
      // Camino de excepción: el de siempre. Se limpia la residencia para que no
      // queden los dos puestos y gane el que no eligió.
      st.picking = true;
      f.manualAddr = true; f.residenceId = null; f.placeAuto = false;
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
      say('Listo — la próxima vez lo tendrás de una.');
    } catch (_) {
      say('No se pudo guardar tu punto. Puedes seguir con el traslado igual.', 'AlertTriangle');
    } finally {
      st.saving = false;
      if (window.Auxiliar?.rerender) window.Auxiliar.rerender();
    }
  }

  // El buscador escribe en el estado del módulo y repinta SOLO la lista, para no
  // remontar el input y perder el foco/cursor en cada tecla.
  function onQuery(v, f) {
    st.q = v;
    if (rxOn()) return rxOnQuery(v, f);
    const cont = document.querySelector('.axr-list');
    if (!cont) { return false; }
    const tmp = document.createElement('div');
    tmp.innerHTML = pickHTML(f);
    const fresh = tmp.querySelector('.axr-list');
    if (fresh) cont.innerHTML = fresh.innerHTML;
    // La ayuda «Escribe el nombre…» se va cuando ya está escribiendo.
    const hint = document.querySelector('.axr-hint');
    if (hint) hint.hidden = !!v;
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

  // Volver a intentar la carga del catálogo. Existe porque el paso del punto ya
  // no se cae en silencio al camino manual cuando la lista no llegó: lo dice y
  // ofrece reintentar (la causa típica es la sesión, no la red).
  function retry() {
    st.cat = null; st.failed = false; st.loading = false;
    load();
  }

  // Un pedido nuevo arranca limpio: si el anterior terminó en «hoy salgo de otro
  // lado», el siguiente tiene que volver a ofrecerle sus dos unidades. (El
  // `dondeForced` del «Cambiar» vive en el form, que auxiliar.js crea nuevo.)
  function newTrip() { st.otro = false; st.q = ''; st.picking = false; }

  // ════════════════════════════════════════════════════════════════════════
  // ASPECTO RX DEL PASO DEL PUNTO (P5, 27-sep-2026)
  // Mismas acciones (res-*), mismo #axr-q y mismas clases de enganche
  // (.axr-list, .axr-hint, .axr-search, .axr-clear), con el marcado del
  // diseño: rx-opt (con radio), rx-input search, rx-lbl y rx-note.
  // ════════════════════════════════════════════════════════════════════════
  const matches = (q) => q ? (st.cat || []).filter(r => norm(r.name + ' ' + (r.sector || '')).includes(norm(q))) : [];

  // Una opción del diseño (rx-book.jsx paso 2). `attrs` va tal cual.
  function rxOptHTML(o) {
    return `<button type="button" class="rx-opt rx-in${o.on ? ' on' : ''}${o.dashed ? ' dashed' : ''}" style="--d:${o.d || 0}" ${o.attrs || ''}>`
      + `<span class="rx-opt-ic">${rxIc(o.icon, 18)}</span>`
      + `<span class="rx-opt-tx"><b>${esc(o.title)}</b>${o.sub ? `<span>${esc(o.sub)}</span>` : ''}</span>`
      + (o.radio === false ? '' : `<span class="rx-radio"><i></i></span>`)
      + `</button>`;
  }
  function rxUnitChooserHTML(a, b, c) {
    const u = (x, d) => rxOptHTML({
      icon: 'Home', title: x.unit || ('Unidad ' + x.n),
      sub: x.res.name + (x.res.sector ? ' · ' + x.res.sector : ''),
      on: c === x.n, d,
      attrs: `data-ax="res-unit" data-n="${x.n}" data-rx-key="unit:${x.n}"`,
    });
    return `<div class="rx-lbl">¿De cuál sales?</div>` + u(a, 0) + u(b, 1)
      + rxOptHTML({ icon: 'MapPin', title: 'Hoy salgo de otro lado', sub: 'Busca otro conjunto del catálogo',
        attrs: 'data-ax="res-otro" data-rx-key="res-otro"', d: 2, dashed: true, radio: false });
  }
  function rxRowHTML(r, i, attrs, on) {
    return rxOptHTML({
      icon: 'MapPin', title: r.name, sub: [r.sector, r.access_note].filter(Boolean).join(' · '),
      on: !!on, d: i, attrs,
    });
  }
  function rxNoneHTML(q, manual) {
    return `<div class="rx-note" data-rx-key="none:${esc(q)}">${rxIc('Info', 15)}<span><b>No encontramos «${esc(q)}».</b> `
      + `Puede que tu conjunto no esté en el catálogo todavía.${manual ? ' Abajo puedes escribir la dirección.' : ''}</span></div>`;
  }
  function rxListInner(q) {
    if (!q) return '';
    const list = matches(q);
    return list.length
      ? list.map((r, i) => rxRowHTML(r, i, `data-ax="res-pick" data-id="${esc(r.id)}" data-rx-key="res:${esc(r.id)}"`)).join('')
      : rxNoneHTML(q, true);
  }
  const rxClearHTML = () => `<button type="button" class="rx-pd-search-clear axr-clear" data-ax="res-clear" aria-label="Limpiar">${rxIc('X', 16)}</button>`;

  function rxPickHTML(f) {
    const isLle = f.type === 'lle';
    const saved = savedRes();
    const q = st.q;
    let h = `<div class="rx-note">${rxIc('Info', 15)}<span>${isLle
      ? 'Elige dónde te dejamos. Ya tenemos ubicadas las porterías de Rionegro.'
      : 'Elige el punto. Ya tenemos ubicadas las porterías de Rionegro.'}</span></div>`;
    // «Tu punto» se esconde (no se quita) mientras hay texto: así la forma del
    // paso no cambia al escribir y un repintado no rehace el buscador.
    if (saved) {
      h += `<div class="rx-lbl" data-rx-key="saved-lbl"${q ? ' hidden' : ''}>Tu punto</div>`
        + rxOptHTML({ icon: 'Home', title: saved.name, sub: [saved.sector, 'Ubicación verificada'].filter(Boolean).join(' · '),
          attrs: `data-ax="res-pick" data-id="${esc(saved.id)}" data-rx-key="saved"${q ? ' hidden' : ''}`, d: 0 });
    }
    h += `<div class="rx-lbl" data-rx-key="search-lbl">${saved && !q ? 'Otro punto' : 'Busca tu conjunto'}</div>`;
    h += `<div class="rx-input search axr-search rx-in" style="--d:1" data-rx-key="search">${rxIc('Search', 18)}`
      + `<input id="axr-q" type="text" value="${esc(q)}" placeholder="Busca tu conjunto o sector" autocomplete="off" />`
      + (q ? rxClearHTML() : '') + `</div>`;
    h += `<div class="rx-note axr-hint"${q ? ' hidden' : ''}>${rxIc('Info', 15)}<span>Escribe el nombre de tu conjunto o el sector.</span></div>`;
    h += `<div class="rx-list axr-list">${rxListInner(q)}</div>`;
    h += rxOptHTML({ icon: 'Plus', title: 'Mi punto no está en la lista', sub: 'Escribe la dirección y ubica el pin',
      attrs: 'data-ax="res-manual" data-rx-key="manual"', d: 2, dashed: true, radio: false });
    return h;
  }

  function rxConfirmHTML(f, r, compacto) {
    const isLle = f.type === 'lle';
    const yaEsSuPunto = compacto || st.place?.residenceId === r.id;
    let h = '';
    if (!compacto) {
      h += `<div class="rx-opt on rx-in" style="--d:0" data-rx-key="picked:${esc(r.id)}">`
        + `<span class="rx-opt-ic">${rxIc('Home', 18)}</span>`
        + `<span class="rx-opt-tx"><b>${esc(r.name)}</b>${r.sector ? `<span>${esc(r.sector)}</span>` : ''}</span>`
        + `<button type="button" class="rx-pd-link" data-ax="res-change">Cambiar</button></div>`;
    }
    if (f.placeAuto) {
      h += `<div class="rx-note ok rx-in" style="--d:1">${rxIc('Check', 15)}<span>Es el punto que dejaste en tu registro. Si hoy sales de otro lado, toca «Cambiar».</span></div>`;
    }
    h += `<div id="axr-map" class="rx-pd-map rx-in" style="--d:2" data-rx-keep="1"></div>`;
    h += `<div class="rx-note ok rx-in" style="--d:3">${rxIc('Check', 15)}<span><b>Ubicación verificada.</b> No necesitas mover el pin. ${isLle ? 'Ahí te dejamos.' : 'Ahí te recogemos.'}</span></div>`;
    if (r.access_note) h += `<div class="rx-note">${rxIc('MapPin', 15)}<span>${esc(r.access_note)}</span></div>`;
    if (!yaEsSuPunto && window.AuxRxUI) {
      h += AuxRxUI.btn(st.saving ? 'Guardando…' : 'Guardar como mi punto',
        { kind: 'sec', icon: 'Home', attrs: { 'data-ax': 'res-save' }, disabled: st.saving });
    }
    return h;
  }

  // Filas que siguen en la lista se QUEDAN (no vuelven a «entrar» en cada
  // tecla); las nuevas entran con su rx-in. Como las filas con key de React.
  function rxReconcile(cont, html) {
    const t = document.createElement('template');
    t.innerHTML = html;
    const fresh = [...t.content.children];
    const old = new Map([...cont.children].map(n => [n.getAttribute('data-rx-key'), n]));
    const out = fresh.map(n => {
      const k = n.getAttribute('data-rx-key');
      const o = k != null ? old.get(k) : null;
      if (o) { old.delete(k); return o; }
      return n;
    });
    old.forEach(n => n.remove());
    out.forEach((n, i) => { if (cont.children[i] !== n) cont.insertBefore(n, cont.children[i] || null); });
  }
  function rxOnQuery(v) {
    const inp = document.getElementById('axr-q');
    const box = (inp && inp.closest('[data-scr]')) || document;
    const cont = box.querySelector('.axr-list');
    if (!cont) return false;
    rxReconcile(cont, rxListInner(v));
    const hint = box.querySelector('.axr-hint');
    if (hint) hint.hidden = !!v;
    const sv = box.querySelectorAll('[data-rx-key="saved-lbl"], [data-rx-key="saved"]');
    sv.forEach(n => { n.hidden = !!v; });
    const lbl = box.querySelector('[data-rx-key="search-lbl"]');
    if (lbl) lbl.textContent = (sv.length && !v) ? 'Otro punto' : 'Busca tu conjunto';
    const search = box.querySelector('.axr-search');
    if (search) {
      const has = search.querySelector('.axr-clear');
      if (v && !has) search.insertAdjacentHTML('beforeend', rxClearHTML());
      else if (!v && has) has.remove();
    }
    return true;
  }

  // ════════════════════════════════════════════════════════════════════════
  // MI RESIDENCIA DESDE PERFIL (pila «residence», plan final §3.10 #27)
  // Estado PROPIO: no lee ni escribe auxState.form, y no usa data-ax res-* ni
  // data-field (auxiliar.js los ignora fuera del pedido). Acciones data-rx:
  // res-p-pick, res-p-save, res-p-retry; buscador data-rx-field="res-q".
  // Guarda con Api.saveMyResidence (solo el conjunto; el apartamento no).
  // ════════════════════════════════════════════════════════════════════════
  const pst = { q: '', sel: null, saving: false };
  const hdr = () => (window.Auxiliar && window.Auxiliar.header) || null;
  function pickerOpen() {
    try { return !!(window.AuxShell && typeof AuxShell.current === 'function' && (AuxShell.current() || {}).id === 'residence'); }
    catch (_) { return false; }
  }
  function curResId() {
    const H = hdr();
    return (H && H.residenceId) || (st.place && st.place.residenceId) || null;
  }
  function curRes() {
    const id = curResId(); if (!id) return null;
    const H = hdr();
    return byId(id) || (H && H.residence && H.residence.id === id ? H.residence : null)
      || (st.place && st.place.residence && st.place.residence.id === id ? st.place.residence : null);
  }
  function pickerReset() { pst.q = ''; pst.sel = null; pst.saving = false; }
  function pOpt(r, on, d, key) {
    return rxOptHTML({ icon: 'Home', title: r.name, sub: r.sector || '', on, d,
      attrs: `data-rx="res-p-pick" data-id="${esc(r.id)}" data-rx-key="${key}"` });
  }
  function pListInner() {
    const q = pst.q; if (!q) return '';
    const list = matches(q);
    return list.length
      ? list.map((r, i) => rxRowHTML(r, i, `data-rx="res-p-pick" data-id="${esc(r.id)}" data-rx-key="pr:${esc(r.id)}"`, pst.sel === r.id)).join('')
      : rxNoneHTML(q, false);
  }
  // El cuerpo del selector (sin cabecera ni pie): lo usa la pila «residence».
  function pickerHTML(o) {
    o = o || {};
    bindPicker();
    if (!st.cat && !st.loading && !st.failed) load();
    if (st.loading || (!st.cat && !st.failed)) {
      return `<div class="rx-pd-load"><span class="rx-spin dk"></span>Cargando el catálogo de conjuntos…</div>`;
    }
    if (!st.cat || !st.cat.length) {
      return `<div class="rx-note bad">${rxIc('AlertTriangle', 15)}<span>No pudimos cargar el catálogo de conjuntos. Vuelve a intentarlo en un momento.</span></div>`
        + (window.AuxRxUI ? AuxRxUI.btn('Reintentar', { kind: 'ghost', icon: 'Refresh', attrs: { 'data-rx': 'res-p-retry' } }) : '');
    }
    const cur = curRes();
    const sel = pst.sel || (cur && cur.id) || null;
    let h = `<div class="rx-lbl">Tu residencia</div>`;
    h += cur ? pOpt(cur, sel === cur.id, 0, 'p:cur')
      : `<div class="rx-note">${rxIc('Info', 15)}<span>Todavía no tienes una residencia guardada. Búscala abajo.</span></div>`;
    const nueva = (pst.sel && (!cur || pst.sel !== cur.id)) ? byId(pst.sel) : null;
    if (nueva) {
      h += pOpt(nueva, true, 1, 'p:new:' + esc(nueva.id));
      h += `<div class="rx-note">${rxIc('Info', 15)}<span>Aquí solo cambia el conjunto. Si también cambió tu apartamento, avísale a Coordinación.</span></div>`;
    }
    h += `<div class="rx-lbl">${cur ? 'Cambiarla por otra' : 'Busca tu conjunto'}</div>`;
    h += `<div class="rx-input search rx-in" style="--d:2" data-rx-key="p-search">${rxIc('Search', 18)}`
      + `<input type="text" data-rx-field="res-q" value="${esc(pst.q)}" placeholder="Busca tu conjunto o sector" autocomplete="off" aria-label="Buscar conjunto" /></div>`;
    h += `<div class="rx-list" data-rx-res-list>${pListInner()}</div>`;
    const H = hdr();
    if (H && H.residenceId2) {
      const r2 = byId(H.residenceId2) || H.residence2 || null;
      const nom = r2 ? r2.name + (H.unit2 ? ' · ' + H.unit2 : '') : '';
      h += `<div class="rx-note">${rxIc('Info', 15)}<span>Tu segunda unidad${nom ? ' (' + esc(nom) + ')' : ''} no se cambia aquí: para cambiarla, escríbele a Coordinación.</span></div>`;
    }
    return h;
  }
  function pickerFootHTML() {
    const can = !!pst.sel && pst.sel !== curResId() && !pst.saving;
    return window.AuxRxUI ? AuxRxUI.btn(pst.saving ? 'Guardando…' : 'Guardar',
      { attrs: { 'data-rx': 'res-p-save', 'aria-disabled': can ? 'false' : 'true' }, disabled: !can }) : '';
  }
  function pickerScreenHTML() {
    const head = window.AuxRxUI ? AuxRxUI.head({ title: 'Mi residencia', back: true }) : '';
    return `<div class="rx-scr">${head}<div class="rx-body">${pickerHTML({ mode: 'perfil' })}</div>`
      + `<div class="rx-foot">${pickerFootHTML()}</div></div>`;
  }
  function repaintPicker() {
    if (pickerOpen()) { try { AuxShell.render(); } catch (_) { /* */ } }
  }
  function pickerPick(id) {
    if (!id || pst.saving) return;
    pst.sel = id === curResId() ? null : id;
    pst.q = '';
    repaintPicker();
  }
  async function pickerSave() {
    if (pst.saving || !pst.sel || pst.sel === curResId()) return;
    if (!window.Api || typeof Api.saveMyResidence !== 'function') { say('No se pudo guardar tu residencia. Intenta otra vez.', 'AlertTriangle'); return; }
    const id = pst.sel;
    pst.saving = true; repaintPicker();
    try {
      await Api.saveMyResidence(id);
      const r = byId(id);
      const H = hdr();
      if (H) { H.residenceId = id; if (r) H.residence = { id: r.id, name: r.name, sector: r.sector || null }; }
      if (!st.place) st.place = {};
      st.place.residenceId = id; if (r) st.place.residence = r;
      pickerReset();
      say('Listo, tu residencia quedó guardada.');
      if (pickerOpen() && typeof AuxShell.pop === 'function') AuxShell.pop(); else repaintPicker();
    } catch (_) {
      pst.saving = false; repaintPicker();
      say('No se pudo guardar tu residencia. Intenta otra vez.', 'AlertTriangle');
    }
  }
  // El buscador del selector: repinta SOLO su lista (el campo no se remonta).
  function bindPicker() {
    const r = document.getElementById('auxiliar-ui');
    if (!r || r.__rxResPickerBound) return;
    r.__rxResPickerBound = true;
    r.addEventListener('input', (e) => {
      const t = e.target;
      if (!t || !t.matches || !t.matches('[data-rx-field="res-q"]')) return;
      pst.q = t.value;
      const box = t.closest('[data-scr]') || r;
      const cont = box.querySelector('[data-rx-res-list]');
      if (cont) rxReconcile(cont, pListInner());
    });
  }
  (function registerPicker() {
    const Sh = window.AuxShell;
    if (!Sh || typeof Sh.action !== 'function') return;
    Sh.action('res-p-pick', (el) => pickerPick(el.getAttribute('data-id')));
    Sh.action('res-p-save', () => { pickerSave(); });
    Sh.action('res-p-retry', () => { retry(); repaintPicker(); });
    // Pantalla por defecto de la pila «residence». Si Perfil (P7) registra la
    // suya después, esa manda (register reemplaza).
    if (typeof Sh.register === 'function' && !(typeof Sh.registered === 'function' && Sh.registered('residence'))) {
      Sh.register('residence', {
        render(ctx) { if (ctx && ctx.reason === 'enter') pickerReset(); return pickerScreenHTML(); },
        after() { bindPicker(); },
      });
    }
  })();

  window.AuxResidencias = {
    load, html, handle, afterRender, ready, onQuery, destroyMap, newTrip,
    autofill, retry, forcePick,
    // Mi residencia desde Perfil (estado propio, nunca auxState.form).
    pickerHTML, pickerFootHTML, pickerScreenHTML, pickerReset,
    pickerState: () => ({ q: pst.q, sel: pst.sel, saving: pst.saving }),
    hasCatalog: () => !!(st.cat && st.cat.length),
    // El catálogo no está disponible (falló o llegó vacío). No es lo mismo que
    // «no hay conjuntos»: hoy la causa más común es entrar sin sesión, y ahí la
    // consulta responde cero filas sin error por la RLS de la tabla.
    unavailable: () => !st.loading && !(st.cat && st.cat.length),
    loading: () => st.loading,
    hasTwoUnits: hasTwo,
    count: () => (st.cat || []).length,
  };
})();
