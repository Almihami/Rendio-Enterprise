// admin-pedido-externo.js — Reservas › «Nuevo pedido» (0139, 26-oct-2026).
//
// Pendiente de los jefes (26-oct): «revisar cómo parametrizar para que el sistema
// inserte en ruta a Kriss y los que no están registrados, cuando sean servicios que
// pidan externos». Hasta hoy alguien sin cuenta solo entraba escrito en la ruta
// pegada de Julián (0133), y ese pedido no salía en el Excel, el tablero, Vuelos
// ni Operación: todo eso sale de Reservas.
//
// Aquí el jefe pide un traslado A NOMBRE de alguien:
//   · un tripulante que ya está (con app o un externo que ya se cargó), o
//   · un EXTERNO nuevo: nombre, teléfono, conjunto y apto. Queda como tripulante
//     sin app (no entra, no le llegan avisos, no se le cobra) y la próxima vez se
//     busca por su nombre.
// El pedido queda igual que si lo hubiera hecho el tripulante (Api.adminCreateReservation):
// sale en el Excel, el tablero lo rutea, Vuelos sigue su vuelo y, si el día ya está
// publicado, el sistema lo acomoda solo (0135).
//
// Módulo cerrado (IIFE). Lo abre el botón #rv-new de Reservas (admin-reservas.js
// llama a RendioPedido.bind() al pintar). Para las pruebas: RendioPedido._st.
(function () {
  'use strict';
  const W = window;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const hoyBog = () => new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
  const masDias = (d, n) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

  const st = {
    abierto: false, quien: 'buscar',      // 'buscar' (ya está) | 'nuevo' (externo nuevo)
    q: '', elegido: null,                  // { id, name, external, punto }
    nuevo: { name: '', phone: '', residenceId: '', unit: '' },
    tipo: 'sal', fecha: '', hora: '', vuelo: '', nota: '',
    tripulantes: null, conjuntos: null, cargando: false, guardando: false, msg: '', err: false,
  };

  const box = () => document.getElementById('rv-new-box');

  async function cargarListas() {
    if (st.tripulantes && st.conjuntos) return;
    st.cargando = true; pintar();
    try {
      const [ts, cs] = await Promise.all([
        W.Api && Api.listAuxiliares ? Api.listAuxiliares().catch(() => []) : [],
        W.Api && Api.listResidences ? Api.listResidences().catch(() => []) : [],
      ]);
      st.tripulantes = (ts || []).filter((a) => !a.deleted && a.active);
      st.conjuntos = (cs || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'es'));
    } finally { st.cargando = false; }
  }

  function abrir() {
    st.abierto = true; st.msg = ''; st.err = false;
    if (!st.fecha) st.fecha = masDias(hoyBog(), 1);
    pintar();
    cargarListas().then(pintar);
    setTimeout(() => { const i = document.getElementById(st.quien === 'nuevo' ? 'rvn-name' : 'rvn-q'); if (i) i.focus(); }, 30);
  }
  function cerrar() {
    st.abierto = false; st.elegido = null; st.q = ''; st.msg = ''; st.err = false;
    st.quien = 'buscar'; st.tipo = 'sal';
    st.nuevo = { name: '', phone: '', residenceId: '', unit: '' };
    st.hora = ''; st.vuelo = ''; st.nota = '';
    pintar();
  }

  function coincidencias() {
    const q = norm(st.q);
    if (!q || !st.tripulantes) return [];
    return st.tripulantes.filter((a) => norm(a.name).includes(q)).slice(0, 8);
  }
  const puntoDe = (a) => (a.res1 ? a.res1.name + (a.unit1 ? ' · ' + a.unit1 : '') : (a.homeAddress || 'sin punto'));

  function pintar() {
    const b = box(); if (!b) return;
    b.hidden = !st.abierto;
    if (!st.abierto) { b.innerHTML = ''; return; }
    const lle = st.tipo === 'lle';
    const seg = (k, v, txt) => `<button type="button" class="rv-fbtn${st[k] === v ? ' on' : ''}" data-rvn-${k}="${v}">${txt}</button>`;
    let quien;
    if (st.quien === 'buscar') {
      if (st.elegido) {
        quien = `<div class="rvn-elegido"><b>${esc(st.elegido.name)}</b>${st.elegido.external ? ' <span class="rv-tag ext">Externo · sin app</span>' : ''}<span>${esc(st.elegido.punto)}</span><button type="button" class="set-btn sm ghost" data-rvn="otro">Cambiar</button></div>`;
      } else {
        const ms = coincidencias();
        quien = `<input class="set-input" id="rvn-q" type="search" autocomplete="off" placeholder="${st.cargando ? 'Cargando tripulantes…' : 'Escribe el nombre (tripulante o externo ya cargado)'}" value="${esc(st.q)}" />`
          + (st.q && !st.cargando ? `<div class="rvn-ops" role="listbox">${ms.map((a) => `<button type="button" role="option" class="rvn-op" data-rvn-pick="${esc(a.id)}"><b>${esc(a.name)}</b>${a.external ? ' <span class="rv-tag ext">Externo</span>' : ''}<span>${esc(puntoDe(a))}</span></button>`).join('')
            || '<p class="rvn-hint">Nadie con ese nombre. Si no tiene la app, agrégalo como <button type="button" class="rvn-lnk" data-rvn-quien="nuevo">externo nuevo</button>.</p>'}</div>` : '');
      }
    } else {
      const n = st.nuevo;
      quien = '<div class="rvn-grid">'
        + `<label class="set-field"><span>Nombre y apellido</span><input class="set-input" id="rvn-name" value="${esc(n.name)}" placeholder="Kriss Montoya" autocomplete="off" /></label>`
        + `<label class="set-field"><span>Teléfono (opcional)</span><input class="set-input" id="rvn-phone" type="tel" inputmode="tel" value="${esc(n.phone)}" placeholder="300 123 4567" /></label>`
        + `<label class="set-field"><span>Conjunto donde se recoge</span><select class="set-input" id="rvn-res"><option value="">${st.cargando ? 'Cargando…' : 'Elige el conjunto…'}</option>${(st.conjuntos || []).map((c) => `<option value="${esc(c.id)}"${n.residenceId === c.id ? ' selected' : ''}>${esc(c.name)}${c.sector ? ' · ' + esc(c.sector) : ''}</option>`).join('')}</select></label>`
        + `<label class="set-field"><span>Torre / apto (opcional)</span><input class="set-input" id="rvn-unit" value="${esc(n.unit)}" placeholder="Torre 2 · 504" /></label>`
        + '</div><p class="rvn-hint">Queda guardado como <b>externo sin app</b>: no entra a la app, no le llegan avisos y no se le cobra. La próxima vez búscalo por su nombre. ¿No está el conjunto? Agrégalo en Conjuntos.</p>';
    }
    b.innerHTML = '<div class="rvn-card">'
      + '<div class="rvn-h"><b>Nuevo pedido</b><span>A nombre de un tripulante o de alguien sin la app. Sale en el Excel, el tablero lo rutea y, si el día ya está publicado, el sistema lo acomoda.</span></div>'
      + `<div class="rv-bar" role="group" aria-label="Para quién">${seg('quien', 'buscar', 'Ya está registrado')}${seg('quien', 'nuevo', 'Externo nuevo (sin app)')}</div>`
      + `<div class="rvn-quien">${quien}</div>`
      + `<div class="rv-bar" role="group" aria-label="Salida o llegada">${seg('tipo', 'sal', '↑ Salida a JMC')}${seg('tipo', 'lle', '↓ Llegada a casa')}</div>`
      + '<div class="rvn-grid">'
      + `<label class="set-field"><span>Día</span><input class="set-input" id="rvn-fecha" type="date" value="${esc(st.fecha)}" min="${esc(hoyBog())}" /></label>`
      + `<label class="set-field"><span>${lle ? 'Hora de aterrizaje' : 'Hora de presentación en JMC'}</span><input class="set-input" id="rvn-hora" type="time" step="300" value="${esc(st.hora)}" /></label>`
      + `<label class="set-field"><span>Vuelo${lle ? '' : ' (opcional)'}</span><input class="set-input" id="rvn-vuelo" value="${esc(st.vuelo)}" placeholder="AV9563" autocapitalize="characters" autocomplete="off" /></label>`
      + `<label class="set-field"><span>Nota (opcional)</span><input class="set-input" id="rvn-nota" value="${esc(st.nota)}" placeholder="Lo pidió la aerolínea, maleta grande…" /></label>`
      + '</div>'
      + '<p class="rvn-hint">Después de medianoche y antes de las 2:00 a. m. es la madrugada: pon el día del calendario (el sistema la cuenta con el turno de la tarde anterior).</p>'
      + (st.msg ? `<p class="rvn-msg${st.err ? ' bad' : ''}" role="status">${esc(st.msg)}</p>` : '')
      + `<div class="rvn-acts"><button type="button" class="set-btn ghost" data-rvn="cerrar">Cancelar</button><button type="button" class="set-btn" data-rvn="pedir"${st.guardando ? ' disabled' : ''}>${st.guardando ? 'Guardando…' : 'Pedir el traslado'}</button></div>`
      + '</div>';
  }

  // Lo escrito se guarda en st sin repintar (no se pierde el foco al teclear).
  function leer() {
    const v = (id) => { const e = document.getElementById(id); return e ? e.value : null; };
    if (v('rvn-name') != null) st.nuevo.name = v('rvn-name');
    if (v('rvn-phone') != null) st.nuevo.phone = v('rvn-phone');
    if (v('rvn-res') != null) st.nuevo.residenceId = v('rvn-res');
    if (v('rvn-unit') != null) st.nuevo.unit = v('rvn-unit');
    if (v('rvn-fecha') != null) st.fecha = v('rvn-fecha');
    if (v('rvn-hora') != null) st.hora = v('rvn-hora');
    if (v('rvn-vuelo') != null) st.vuelo = v('rvn-vuelo');
    if (v('rvn-nota') != null) st.nota = v('rvn-nota');
  }

  async function pedir() {
    leer();
    const falta = st.quien === 'buscar' && !st.elegido ? 'Elige a quién es el traslado.'
      : st.quien === 'nuevo' && st.nuevo.name.trim().length < 3 ? 'Escribe el nombre del externo.'
      : st.quien === 'nuevo' && !st.nuevo.residenceId ? 'Elige el conjunto donde se recoge.'
      : !/^\d{4}-\d{2}-\d{2}$/.test(st.fecha || '') ? 'Elige el día.'
      : !/^\d{2}:\d{2}$/.test(st.hora || '') ? (st.tipo === 'lle' ? 'Escribe la hora de aterrizaje.' : 'Escribe la hora de presentación.')
      : '';
    if (falta) { st.msg = falta; st.err = true; pintar(); return; }
    st.guardando = true; st.msg = ''; st.err = false; pintar();
    try {
      let auxId = st.elegido && st.elegido.id, nombre = st.elegido && st.elegido.name;
      if (st.quien === 'nuevo') {
        const x = await Api.createExternal({ name: st.nuevo.name.trim(), phone: st.nuevo.phone.trim(), residenceId: st.nuevo.residenceId, unit: st.nuevo.unit.trim() });
        auxId = x.auxiliar_profile_id; nombre = x.name;
        st.tripulantes = null;   // que el nuevo salga en la búsqueda la próxima vez
      }
      await Api.adminCreateReservation({ auxId, type: st.tipo, whenIso: `${st.fecha}T${st.hora}:00-05:00`, flight: st.vuelo.trim(), note: st.nota.trim() });
      const cuando = new Date(`${st.fecha}T12:00:00-05:00`).toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'America/Bogota' }).replace(/\./g, '');
      const txt = `Pedido creado: ${nombre} · ${st.tipo === 'lle' ? 'llegada' : 'salida'} ${cuando} · ${st.hora}.`;
      st.guardando = false;
      cerrar();
      if (typeof W.toast === 'function') W.toast(txt);
      if (typeof W.renderReservas === 'function') W.renderReservas();
    } catch (e) {
      st.guardando = false; st.err = true;
      st.msg = 'No se pudo: ' + ((e && e.message) || 'error');
      pintar();
    }
  }

  let atado = false;
  function bind() {
    const root = document.getElementById('rv-ui');
    if (!root || atado) return;
    atado = true;
    root.addEventListener('click', (e) => {
      if (e.target.closest('#rv-new')) { if (st.abierto) cerrar(); else abrir(); return; }
      const b = box(); if (!b || !b.contains(e.target)) return;
      const q = e.target.closest('[data-rvn-quien]');
      if (q) { leer(); st.quien = q.getAttribute('data-rvn-quien'); st.msg = ''; pintar(); setTimeout(() => { const i = document.getElementById(st.quien === 'nuevo' ? 'rvn-name' : 'rvn-q'); if (i) i.focus(); }, 20); return; }
      const t = e.target.closest('[data-rvn-tipo]');
      if (t) { leer(); st.tipo = t.getAttribute('data-rvn-tipo'); pintar(); return; }
      const pk = e.target.closest('[data-rvn-pick]');
      if (pk) {
        const a = (st.tripulantes || []).find((x) => x.id === pk.getAttribute('data-rvn-pick'));
        if (a) { st.elegido = { id: a.id, name: a.name, external: !!a.external, punto: puntoDe(a) }; st.q = ''; st.msg = ''; pintar(); }
        return;
      }
      const act = e.target.closest('[data-rvn]');
      if (!act) return;
      const k = act.getAttribute('data-rvn');
      if (k === 'cerrar') cerrar();
      else if (k === 'otro') { st.elegido = null; pintar(); setTimeout(() => { const i = document.getElementById('rvn-q'); if (i) i.focus(); }, 20); }
      else if (k === 'pedir') pedir();
    });
    root.addEventListener('input', (e) => {
      if (e.target && e.target.id === 'rvn-q') {
        st.q = e.target.value;
        const pos = e.target.selectionStart;
        pintar();
        const i = document.getElementById('rvn-q'); if (i) { i.focus(); try { i.setSelectionRange(pos, pos); } catch (_) { /* */ } }
      }
    });
    root.addEventListener('change', (e) => { if (e.target && /^rvn-/.test(e.target.id || '')) leer(); });
  }

  W.RendioPedido = { bind, abrir, cerrar, _st: st, _pedir: pedir };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind); else bind();
})();
