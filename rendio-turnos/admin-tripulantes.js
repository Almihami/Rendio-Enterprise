// admin-tripulantes.js — El padrón de tripulantes, del lado del jefe (0075).
//
// POR QUÉ EXISTE
// Desde que el TCP se registra solo, el equipo deja de escribir esos datos… y
// pasa a necesitar verlos. Dos cosas concretas que antes no se podían hacer sin
// entrar a la base de datos:
//
//   1. CORREGIR LA ANTIGÜEDAD. El registro estampa la fecha del día en que la
//      persona abrió la app. Para el que entra hoy esa ES su fecha; para los que
//      ya llevaban meses con Rendio, no. De esa fecha van a colgar las
//      promociones por tiempo, así que alguien tiene que poder corregirla — y
//      ese alguien es el admin, nunca el interesado (0075 lo tapa con un
//      trigger, no solo con esta pantalla).
//   2. VER A QUIÉN SE RECOGE Y DÓNDE. Aerolínea, conjunto, apartamento, segunda
//      unidad y teléfono, que hasta ahora vivían repartidos entre un WhatsApp y
//      la cabeza del coordinador.
//
// LO QUE NO HACE
// No crea ni borra tripulantes: ese es justo el trabajo que el registro vino a
// quitar. Tampoco edita la dirección de nadie — el punto de recogida es del
// tripulante y él lo corrige desde su app; que el jefe pueda moverle la portería
// a alguien sin que se entere es precisamente el problema que resolvió 0055.

(function () {
  'use strict';

  const st = {
    items: null, airlines: null, loading: false,
    q: '', filtro: 'todos',        // todos | sin-fecha | dos-unidades
    editing: null,                  // id del tripulante con la fecha abierta
    busy: null,
    airOpen: false, airName: '', airCode: '', airBusy: false,
  };

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const norm = (s) => (s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  const hoyISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });

  // Cuánto lleva con nosotros, en palabras. El número exacto de días no le sirve
  // a nadie; «1 año y 2 meses» sí, porque es el lenguaje en que están escritos
  // los beneficios que vienen después.
  function antiguedad(iso) {
    if (!iso) return null;
    const a = new Date(iso + 'T12:00:00-05:00'), b = new Date(hoyISO() + 'T12:00:00-05:00');
    if (isNaN(a)) return null;
    let meses = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
    if (b.getDate() < a.getDate()) meses--;
    if (meses < 0) return { txt: 'Fecha futura', meses, raro: true };
    if (meses === 0) {
      const dias = Math.round((b - a) / 86400000);
      return { txt: dias <= 0 ? 'Desde hoy' : dias === 1 ? '1 día' : dias + ' días', meses: 0 };
    }
    if (meses < 12) return { txt: meses === 1 ? '1 mes' : meses + ' meses', meses };
    const y = Math.floor(meses / 12), m = meses % 12;
    return { txt: (y === 1 ? '1 año' : y + ' años') + (m ? ' y ' + (m === 1 ? '1 mes' : m + ' meses') : ''), meses };
  }

  const fechaES = (iso) => {
    if (!iso) return '—';
    try {
      return new Date(iso + 'T12:00:00-05:00')
        .toLocaleDateString('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'short', year: 'numeric' });
    } catch (_) { return iso; }
  };

  // Punto de entrada de la pestaña.
  function abrir() {
    if (!st.items && !st.loading) load();
    paint();
  }

  async function load() {
    st.loading = true; paint();
    try {
      const [items, airlines] = await Promise.all([
        Api.listAuxiliares(),
        Api.listAirlines(true),
      ]);
      st.items = items; st.airlines = airlines;
    } catch (e) {
      st.items = null;
      console.error(e);
    } finally { st.loading = false; paint(); }
  }

  function visibles() {
    let l = st.items || [];
    if (st.q) {
      const q = norm(st.q);
      l = l.filter(a => norm([a.name, a.email, a.phone, a.airline, a.res1?.name, a.res2?.name,
        a.unit1, a.unit2].filter(Boolean).join(' ')).includes(q));
    }
    if (st.filtro === 'sin-fecha') l = l.filter(a => !a.joinedAt);
    if (st.filtro === 'dos-unidades') l = l.filter(a => !!a.res2);
    return l;
  }

  function paint() {
    const root = document.getElementById('tp-body'); if (!root) return;
    const total = (st.items || []).length;
    const cnt = document.getElementById('tp-count'); if (cnt) cnt.textContent = total;

    if (st.loading && !st.items) {
      root.innerHTML = `<div class="tp-empty">Cargando el padrón…</div>`;
      return;
    }
    if (!st.items) {
      root.innerHTML = `<div class="tp-empty"><b>No pudimos cargar los tripulantes.</b>
        <span>Revisa la conexión.</span>
        <button class="set-btn ghost" data-tp="reload">Reintentar</button></div>`;
      return;
    }
    if (!total) {
      root.innerHTML = `<div class="tp-empty"><b>Todavía no hay tripulantes registrados.</b>
        <span>Aparecen solos acá cuando se crean su cuenta desde la app.</span></div>`;
      return;
    }

    const l = visibles();
    const sinFecha = st.items.filter(a => !a.joinedAt).length;
    root.innerHTML = `
      ${sinFecha ? `<div class="tp-nota">
        <svg class="icon"><use href="#i-info"/></svg>
        <div><b>${sinFecha} ${sinFecha === 1 ? 'tripulante no tiene' : 'tripulantes no tienen'} fecha de ingreso.</b>
        <span>Sin ella no se les puede calcular la antigüedad para las promociones.</span></div>
      </div>` : ''}
      ${l.length ? `<div class="tp-list">${l.map(fila).join('')}</div>`
        : `<div class="tp-empty"><b>Nadie coincide con la búsqueda.</b></div>`}`;
  }

  function fila(a) {
    const ant = antiguedad(a.joinedAt);
    const editando = st.editing === a.id;
    const punto = a.res1
      ? esc(a.res1.name) + (a.unit1 ? ' · <b>' + esc(a.unit1) + '</b>' : '')
      : (a.homeAddress ? esc(a.homeAddress) + ' <i>(pin propio)</i>' : '<i>sin punto</i>');
    const punto2 = a.res2
      ? esc(a.res2.name) + (a.unit2 ? ' · <b>' + esc(a.unit2) + '</b>' : '')
      : null;
    return `
      <div class="tp-row${editando ? ' open' : ''}">
        <div class="tp-main">
          <div class="tp-who">
            <b>${esc(a.name)}</b>
            <span>${esc(a.email)}${a.phone ? ' · ' + esc(a.phone) : ' · <i>sin teléfono</i>'}</span>
          </div>
          <div class="tp-air">${a.airline ? esc(a.airline) : '<i>sin aerolínea</i>'}</div>
          <div class="tp-punto">
            <div>${punto}</div>
            ${punto2 ? `<div class="tp-punto2"><span class="tp-tag">2ª unidad</span>${punto2}</div>` : ''}
          </div>
          <div class="tp-ant">
            ${a.joinedAt
              ? `<b class="${ant?.raro ? 'raro' : ''}">${esc(ant?.txt || '')}</b><span>desde ${fechaES(a.joinedAt)}</span>`
              : `<b class="falta">Sin fecha</b><span>se registró ${fechaES((a.createdAt || '').slice(0, 10))}</span>`}
          </div>
          <button class="set-btn ghost tp-edit" data-tp="edit" data-id="${esc(a.id)}">
            ${editando ? 'Cerrar' : (a.joinedAt ? 'Cambiar fecha' : 'Poner fecha')}
          </button>
        </div>
        ${editando ? `
          <div class="tp-editor">
            <label>Está con Rendio desde
              <input type="date" id="tp-date" value="${esc(a.joinedAt || '')}" max="${hoyISO()}" />
            </label>
            <button class="set-btn primary" data-tp="save" data-id="${esc(a.id)}" ${st.busy === a.id ? 'disabled' : ''}>
              ${st.busy === a.id ? 'Guardando…' : 'Guardar'}
            </button>
            <p>La estampa el registro con el día en que se creó la cuenta. Corrígela para quien
               ya llevaba tiempo con nosotros: de esta fecha salen los beneficios por antigüedad.</p>
          </div>` : ''}
      </div>`;
  }

  // ---- Aerolíneas del desplegable ----
  function paintAirlines() {
    const box = document.getElementById('tp-air-box'); if (!box) return;
    if (!st.airOpen) { box.innerHTML = ''; box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const l = st.airlines || [];
    box.innerHTML = `
      <div class="tp-air-head">
        <b>Aerolíneas del desplegable</b>
        <span>Es lo que ve el tripulante al registrarse. Apagar una no borra a nadie: deja de ofrecerse a los nuevos.</span>
      </div>
      <div class="tp-air-list">
        ${l.map(a => `
          <div class="tp-air-row${a.is_active ? '' : ' off'}">
            <b>${esc(a.name)}</b>${a.iata_code ? `<span class="tp-tag">${esc(a.iata_code)}</span>` : ''}
            <button class="set-btn ghost" data-tp="air-toggle" data-id="${esc(a.id)}" data-on="${a.is_active ? '1' : '0'}">
              ${a.is_active ? 'Apagar' : 'Encender'}
            </button>
          </div>`).join('') || '<div class="tp-empty">No hay ninguna.</div>'}
      </div>
      <div class="tp-air-new">
        <input id="tp-air-name" placeholder="Nombre (ej: Copa Airlines)" value="${esc(st.airName)}" />
        <input id="tp-air-code" placeholder="Sigla (CM)" maxlength="3" value="${esc(st.airCode)}" />
        <button class="set-btn primary" data-tp="air-add" ${st.airBusy || !st.airName.trim() ? 'disabled' : ''}>
          ${st.airBusy ? 'Agregando…' : 'Agregar'}
        </button>
      </div>
      <p class="tp-air-nota">Ojo: el cálculo de desembarque solo está medido para Avianca y Wingo.
         Una aerolínea nueva usa el tiempo genérico hasta que la operación la mida.</p>`;
  }

  // ---- eventos ----
  let bound = false;
  function bind() {
    if (bound) return; bound = true;
    const ui = document.getElementById('tripulantes-ui'); if (!ui) return;

    ui.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-tp]'); if (!b || b.disabled) return;
      const a = b.dataset.tp;
      if (a === 'reload') { st.items = null; return load(); }
      if (a === 'filtro') {
        st.filtro = b.dataset.f;
        ui.querySelectorAll('[data-tp="filtro"]').forEach(x => x.classList.toggle('on', x === b));
        return paint();
      }
      if (a === 'edit') {
        st.editing = st.editing === b.dataset.id ? null : b.dataset.id;
        return paint();
      }
      if (a === 'save') return guardarFecha(b.dataset.id);
      if (a === 'air') { st.airOpen = !st.airOpen; return paintAirlines(); }
      if (a === 'air-add') return agregarAerolinea();
      if (a === 'air-toggle') {
        try {
          await Api.setAirlineActive(b.dataset.id, b.dataset.on !== '1');
          st.airlines = await Api.listAirlines(true);
          paintAirlines();
        } catch (err) { toast('No se pudo cambiar la aerolínea.'); }
        return;
      }
    });

    ui.addEventListener('input', (e) => {
      if (e.target.id === 'tp-search') { st.q = e.target.value; return paint(); }
      if (e.target.id === 'tp-air-name') { st.airName = e.target.value;
        const btn = ui.querySelector('[data-tp="air-add"]'); if (btn) btn.disabled = !st.airName.trim() || st.airBusy; return; }
      if (e.target.id === 'tp-air-code') { st.airCode = e.target.value; return; }
    });
  }

  async function guardarFecha(id) {
    const inp = document.getElementById('tp-date'); if (!inp) return;
    const v = inp.value || null;
    if (v && v > hoyISO()) { toast('Esa fecha todavía no llega.'); return; }
    st.busy = id; paint();
    try {
      await Api.setAuxiliarJoinedAt(id, v);
      const it = (st.items || []).find(x => x.id === id);
      if (it) it.joinedAt = v;
      st.editing = null;
      toast('Antigüedad actualizada.');
    } catch (e) {
      toast(e?.message || 'No se pudo guardar la fecha.');
    } finally { st.busy = null; paint(); }
  }

  async function agregarAerolinea() {
    const n = st.airName.trim(); if (!n) return;
    st.airBusy = true; paintAirlines();
    try {
      await Api.createAirline({ name: n, code: st.airCode.trim() });
      st.airName = ''; st.airCode = '';
      st.airlines = await Api.listAirlines(true);
      toast('Aerolínea agregada.');
    } catch (e) {
      toast(/duplicate|unique/i.test(e?.message || '') ? 'Esa aerolínea ya está.' : 'No se pudo agregar.');
    } finally { st.airBusy = false; paintAirlines(); }
  }

  function renderTripulantes() {
    bind();
    abrir();
    paintAirlines();
  }

  window.AdminTripulantes = { render: renderTripulantes, state: st };
  window.renderTripulantes = renderTripulantes;
})();
