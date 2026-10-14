// admin-coordinacion.js — Admin › Rutas › Operación › Coordinación.
// Rediseño del auxiliar (27-sep-2026), paquete P10. Habla con 0088 por ApiAux.
//
// QUÉ ES. La bandeja de lo que los tripulantes les escriben a los jefes: UN
// hilo por tripulante (crew_messages). No es el chat del traslado (ese sigue en
// reservation_messages, tres puntas, y se abre desde Reservas): si el tripulante
// escribe desde un viaje, la reserva viaja como CONTEXTO del mensaje y aquí sale
// un enlace a ese chat (#/reservas?chat=<id>).
//
// Contrato con core.js: window.renderCoordinacion() al entrar a la pestaña y
// window.stopCoordTimer() al salir (core.setTab los llama con typeof). La
// entrada «Coordinación» de la consola aparece sola cuando renderCoordinacion
// existe.
//
// Lo que se pinta sale de la base o dice que no hay dato: sin 0088 la bandeja
// dice que no se pudo cargar; sin teléfono ni horario cargados el formulario
// queda vacío y avisa que el tripulante no ve ninguno (nunca un horario inventado).
//
// Enlace profundo #/coordinacion?aux=<auxiliar_profile_id>: es la URL del push
// «Mensaje de un tripulante» (ApiAux.crewSend). core.applyDeepLink todavía no lo
// conoce, así que este módulo lo resuelve para el jefe: en hashchange y, en
// frío, esperando a que core termine de entrar (ver coDeepLinkAlArrancar).
(function () {
  'use strict';

  const CO_POLL_MS = 5000;   // igual que el chat del jefe: no hay Realtime

  const co = {
    threads: undefined,      // undefined = nunca cargó · null = falló · [] = vacía
    sig: '',                 // firma de la lista pintada (no repintar si no cambió)
    loading: false,
    openAux: null,           // hilo abierto (auxiliar_profiles.id)
    msgs: undefined,         // undefined = cargando · null = falló · []
    msgSig: '',
    seq: 0,                  // descarta respuestas de un hilo que ya se cerró
    sending: false,
    ctxRid: null,            // reserva que viaja como contexto de la respuesta
    ctxOff: false,           // el jefe quitó el contexto a mano
    contact: undefined,      // {phone, hours} | null (no se pudo leer)
    contactBusy: false,
    contactMsg: '',
    poll: null,
    bound: false,
    pendingAux: null,        // del enlace profundo, se consume al pintar
  };

  // ── utilidades ───────────────────────────────────────────────────────────
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const say = (m) => { if (typeof window.toast === 'function') window.toast(m); };
  const api = () => (window.ApiAux && typeof window.ApiAux === 'object') ? window.ApiAux : null;
  const root = () => document.getElementById('coordinacion-ui');
  const $co = (id) => document.getElementById(id);

  function ini(name) {
    const w = String(name || '').trim().split(/\s+/).filter(Boolean);
    return ((w[0] || '')[0] || '').toUpperCase() + ((w[1] || '')[0] || '').toUpperCase() || '·';
  }
  const bogDay = (iso) => {
    try { return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }); } catch (_) { return ''; }
  };
  const hm = (iso) => {
    try { return new Date(iso).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false }); }
    catch (_) { return ''; }
  };
  // 'YYYY-MM-DD' → «jue 16 oct». Mediodía de Bogotá para que no se corra el día.
  function dayShort(ymd) {
    if (!ymd) return '';
    try {
      return new Date(ymd + 'T12:00:00-05:00').toLocaleDateString('es-CO', {
        timeZone: 'America/Bogota', weekday: 'short', day: 'numeric', month: 'short',
      }).replace(/\./g, '').replace(/,/g, '');
    } catch (_) { return ymd; }
  }
  function dayLabel(ymd) {
    const hoy = bogDay(Date.now());
    const ayer = bogDay(Date.now() - 86400000);
    return ymd === hoy ? 'Hoy' : ymd === ayer ? 'Ayer' : dayShort(ymd);
  }
  // Hora si es de hoy; si no, el día.
  const when = (iso) => !iso ? '' : (bogDay(iso) === bogDay(Date.now()) ? hm(iso) : dayShort(bogDay(iso)));

  const threadOf = (auxId) => (Array.isArray(co.threads) ? co.threads.find(t => t.auxId === auxId) : null) || null;

  // «Salida del jue 16 oct · 05:30». Sin fecha, solo el tipo.
  function resLabel(r) {
    if (!r) return '';
    const tipo = r.type === 'lle' ? 'Llegada' : 'Salida';
    const d = r.date ? ' del ' + dayShort(r.date) : '';
    return `${tipo}${d}${r.time ? ' · ' + r.time : ''}`;
  }
  const resHref = (rid) => '#/reservas?chat=' + encodeURIComponent(rid);

  // ── armazón ──────────────────────────────────────────────────────────────
  function shellHTML() {
    return `<div class="co-wrap">
      <div class="sh-phead">
        <div>
          <h1>Coordinación <span class="sh-ct" id="co-count">0</span></h1>
          <p>Lo que los tripulantes les escriben a los jefes: <b>un hilo por persona</b>, con el traslado como contexto cuando escriben desde un viaje.</p>
          <details class="rd-why"><summary aria-expanded="false">¿Y el chat del traslado?<svg class="icon details-chevron"><use href="#i-chev"/></svg></summary><div class="rd-why-body">Lo que es de un viaje puntual con su conductor sigue en <b>Reservas</b>. Aquí llega lo que el tripulante quiere decirle a la operación. Si el mensaje trae un traslado, el enlace abre ese chat.</div></details>
        </div>
        <button class="set-btn ghost" data-co="refresh"><svg class="icon"><use href="#i-refresh"/></svg>Refrescar</button>
      </div>
      <div id="co-contact"></div>
      <div class="co-grid" id="co-grid">
        <div class="co-list" id="co-list" role="list"></div>
        <div class="co-thread" id="co-thread"></div>
      </div>
    </div>`;
  }
  function ensureShell() {
    const r = root(); if (!r) return false;
    if (!r.querySelector('.co-wrap')) {
      r.innerHTML = shellHTML();
      co.sig = ''; co.msgSig = '';
    }
    return true;
  }

  // ── teléfono y horario de Coordinación (app_settings, 0088) ──────────────
  function contactHTML() {
    const c = co.contact;
    if (c === undefined) return '<div class="co-card co-contact"><div class="co-card-s">Cargando el teléfono y el horario…</div></div>';
    if (c === null) {
      return `<div class="co-card co-contact"><div class="co-card-s">
        <b>No se pudo leer el teléfono y el horario de Coordinación.</b>
        <span>Revisa la conexión. Mientras tanto el tripulante no ve ninguno de los dos.</span>
        <button class="set-btn ghost" data-co="contact-reload">Reintentar</button></div></div>`;
    }
    const resumen = (c.phone || c.hours)
      ? [c.phone ? `Teléfono <b>${esc(c.phone)}</b>` : 'Sin teléfono', c.hours ? `Horario <b>${esc(c.hours)}</b>` : 'sin horario'].join(' · ')
      : 'Sin teléfono ni horario: el tripulante no ve ninguno de los dos.';
    const abierto = !(c.phone || c.hours);
    return `<details class="co-card co-contact"${abierto ? ' open' : ''}>
      <summary><span class="co-card-t">Lo que ve el tripulante</span><span class="co-card-r">${resumen}</span><svg class="icon details-chevron"><use href="#i-chev"/></svg></summary>
      <div class="co-card-b">
        <div class="co-f">
          <label for="co-phone">Teléfono de Coordinación</label>
          <input class="set-input" id="co-phone" type="tel" maxlength="30" autocomplete="off" value="${esc(c.phone)}" placeholder="El número que verá el tripulante" />
        </div>
        <div class="co-f">
          <label for="co-hours">Horario</label>
          <input class="set-input" id="co-hours" type="text" maxlength="60" autocomplete="off" value="${esc(c.hours)}" placeholder="Ej: Lun a dom · 4:00 a. m. a 10:00 p. m." />
        </div>
        <div class="co-f-foot">
          <span class="co-hint">Vacío = no se muestra. Nada se inventa en su pantalla.</span>
          <span class="co-cstate" id="co-cstate">${esc(co.contactMsg)}</span>
          <button class="set-btn" data-co="contact-save"${co.contactBusy ? ' disabled' : ''}>${co.contactBusy ? 'Guardando…' : 'Guardar'}</button>
        </div>
      </div>
    </details>`;
  }
  function paintContact() {
    const el = $co('co-contact'); if (!el) return;
    // No se repinta encima de lo que el jefe está escribiendo.
    const f = document.activeElement;
    if (f && el.contains(f) && (f.id === 'co-phone' || f.id === 'co-hours')) return;
    el.innerHTML = contactHTML();
  }
  async function loadContact() {
    const a = api();
    let c = null;
    try { c = (a && typeof a.getOpsContact === 'function') ? await a.getOpsContact() : null; } catch (_) { c = null; }
    co.contact = c || null;
    co.contactMsg = '';
    paintContact();
  }
  async function saveContact() {
    const a = api(); if (!a || typeof a.setOpsContact !== 'function' || co.contactBusy) return;
    const phone = ($co('co-phone') && $co('co-phone').value || '').trim();
    const hours = ($co('co-hours') && $co('co-hours').value || '').trim();
    co.contactBusy = true; co.contactMsg = '';
    const act = document.activeElement; if (act && act.blur) act.blur();
    paintContact();
    try {
      const ok = await a.setOpsContact({ phone, hours });
      if (ok === null) {
        co.contactMsg = 'No se guardó: la base todavía no tiene este campo.';
      } else {
        co.contact = { phone, hours };
        co.contactMsg = 'Guardado.';
        say(phone || hours ? 'Teléfono y horario guardados.' : 'Listo: el tripulante ya no ve teléfono ni horario.');
      }
    } catch (e) {
      co.contactMsg = (e && e.message) || 'No se pudo guardar.';
    } finally {
      co.contactBusy = false;
      paintContact();
    }
  }

  // ── bandeja ──────────────────────────────────────────────────────────────
  function rowHTML(t) {
    const on = t.auxId === co.openAux;
    const lugar = [t.residence, t.sector].filter(Boolean).join(' · ');
    const quien = t.lastRole === 'admin' ? 'Coordinación: ' : '';
    return `<button class="co-row${on ? ' on' : ''}${t.unread ? ' unread' : ''}" data-co="open" data-aux="${esc(t.auxId)}" role="listitem">
      <span class="co-av">${esc(ini(t.name))}</span>
      <span class="co-row-b">
        <span class="co-row-t"><b>${esc(t.name || 'Tripulante')}</b><time>${esc(when(t.lastAt))}</time></span>
        ${lugar ? `<span class="co-row-s">${esc(lugar)}</span>` : ''}
        <span class="co-row-p">${esc(quien + (t.lastBody || ''))}</span>
      </span>
      ${t.unread ? `<i class="co-badge" aria-label="${t.unread} sin leer">${t.unread > 9 ? '9+' : t.unread}</i>` : ''}
    </button>`;
  }
  function paintList(force) {
    const el = $co('co-list'); if (!el) return;
    const cnt = $co('co-count');
    if (co.threads === undefined) {
      if (cnt) cnt.textContent = '0';
      el.innerHTML = '<div class="co-empty">Cargando la bandeja…</div>';
      co.sig = '';
      return;
    }
    if (co.threads === null) {
      el.innerHTML = `<div class="co-empty"><b>No se pudo cargar la bandeja</b>
        <span>Revisa la conexión y vuelve a intentar.</span>
        <button class="set-btn ghost" data-co="reload">Reintentar</button></div>`;
      co.sig = '';
      return;
    }
    const unread = co.threads.reduce((n, t) => n + (t.unread || 0), 0);
    if (cnt) cnt.textContent = String(unread);
    const sig = JSON.stringify([co.openAux, co.threads.map(t => [t.auxId, t.lastAt, t.unread, t.lastBody, t.name])]);
    if (!force && sig === co.sig) return;
    co.sig = sig;
    if (!co.threads.length) {
      el.innerHTML = `<div class="co-empty"><b>Ningún tripulante ha escrito todavía</b>
        <span>Cuando alguien escriba desde su app, en Coordinación, su hilo aparece aquí.</span></div>`;
      return;
    }
    el.innerHTML = co.threads.map(rowHTML).join('');
  }
  async function loadThreads(silent) {
    const a = api();
    if (co.loading) return;
    co.loading = true;
    if (!silent && co.threads === undefined) paintList();
    let r = null;
    try { r = (a && typeof a.crewThreadsAdmin === 'function') ? await a.crewThreadsAdmin() : null; } catch (_) { r = null; }
    co.loading = false;
    // En el sondeo, un fallo no borra lo que ya se ve: se reintenta en 5 s.
    if (r === null && silent && Array.isArray(co.threads)) return;
    co.threads = Array.isArray(r) ? r : null;
    // Lo que el jefe está leyendo no cuenta como sin leer.
    if (co.openAux && Array.isArray(co.threads)) { const t = threadOf(co.openAux); if (t) t.unread = 0; }
    paintList();
    if (co.openAux) paintThreadHead();
  }

  // ── hilo ─────────────────────────────────────────────────────────────────
  function threadHeadHTML() {
    const t = threadOf(co.openAux);
    const name = (t && t.name) || 'Tripulante';
    const lugar = t ? [t.residence, t.sector].filter(Boolean).join(' · ') : '';
    const tel = t && t.phone ? String(t.phone).replace(/[^\d+]/g, '') : '';
    return `<button class="co-ic co-back" data-co="close" aria-label="Volver a la bandeja"><svg class="icon"><use href="#i-back"/></svg></button>
      <span class="co-av">${esc(ini(name))}</span>
      <div class="co-who"><b>${esc(name)}</b><span>${esc(lugar || 'Tripulante')}</span></div>
      ${tel ? `<a class="co-ic" href="tel:${esc(tel)}" title="Llamar a ${esc(name)}" aria-label="Llamar"><svg class="icon"><use href="#i-phone"/></svg></a>` : ''}`;
  }
  function paintThreadHead() {
    const h = $co('co-th-head'); if (h) h.innerHTML = threadHeadHTML();
    const i = $co('co-input');
    if (i) { const t = threadOf(co.openAux); i.placeholder = `Escríbele a ${((t && t.name) || 'el tripulante').split(' ')[0]}…`; }
  }
  function paintThread() {
    const el = $co('co-thread'); if (!el) return;
    const grid = $co('co-grid');
    if (grid) grid.classList.toggle('has-open', !!co.openAux);
    if (!co.openAux) {
      el.innerHTML = `<div class="co-th-none"><svg class="icon"><use href="#i-chat"/></svg><b>Elige un hilo</b><span>Para leerlo y responderle al tripulante.</span></div>`;
      co.msgSig = '';
      return;
    }
    el.innerHTML = `<div class="co-th-head" id="co-th-head"></div>
      <div class="co-msgs" id="co-msgs" aria-live="polite"></div>
      <div class="co-ctx" id="co-ctx"></div>
      <div class="co-foot">
        <input id="co-input" type="text" maxlength="500" autocomplete="off" placeholder="Escríbele al tripulante…" />
        <button class="set-btn" data-co="send" id="co-send"><svg class="icon"><use href="#i-send"/></svg>Enviar</button>
      </div>`;
    co.msgSig = '';
    paintThreadHead();
    paintMsgs();
    paintCtx();
  }
  function msgHTML(m) {
    const mio = m.role === 'admin';
    const r = m.reservation;
    const ctx = r && r.id ? `<a class="co-msg-ctx" href="${esc(resHref(r.id))}" data-co="res-chat" data-rid="${esc(r.id)}">
        <svg class="icon"><use href="#i-route"/></svg><span>${esc(resLabel(r))}</span><u>Abrir el chat del traslado</u></a>` : '';
    const leido = mio && m.read ? ' · Leído' : '';
    return `<div class="co-msg ${mio ? 'mine' : 'their'}${m._tmp ? ' tmp' : ''}">
      <em>${mio ? 'Coordinación' : 'Tripulante'}</em>
      <p>${esc(m.body)}</p>
      ${ctx}
      <span>${esc(hm(m.at))}${leido}</span>
    </div>`;
  }
  function paintMsgs() {
    const el = $co('co-msgs'); if (!el) return;
    if (co.msgs === undefined) { el.innerHTML = '<p class="co-load">Cargando…</p>'; co.msgSig = ''; return; }
    if (co.msgs === null) {
      el.innerHTML = `<div class="co-empty"><b>No se pudo cargar el hilo</b><span>Revisa la conexión y vuelve a intentar.</span>
        <button class="set-btn ghost" data-co="msgs-reload">Reintentar</button></div>`;
      co.msgSig = '';
      return;
    }
    const sig = JSON.stringify(co.msgs.map(m => [m.id, m.read, m._tmp ? 1 : 0]));
    if (sig === co.msgSig) return;
    const abajo = el.scrollHeight - el.scrollTop - el.clientHeight < 40 || !co.msgSig;
    co.msgSig = sig;
    if (!co.msgs.length) {
      el.innerHTML = `<div class="co-empty"><b>Este hilo está vacío</b><span>Lo que escribas le llega al tripulante como «Coordinación», sin tu nombre.</span></div>`;
      return;
    }
    let dia = '';
    el.innerHTML = co.msgs.map(m => {
      const d = bogDay(m.at);
      const sep = d && d !== dia ? `<div class="co-day">${esc(dayLabel(d))}</div>` : '';
      dia = d || dia;
      return sep + msgHTML(m);
    }).join('');
    if (abajo) el.scrollTop = el.scrollHeight;
  }
  // La respuesta lleva como contexto el traslado del último mensaje del
  // tripulante que traía uno (así él ve de qué viaje se le habla). El jefe lo
  // puede quitar.
  function defaultCtx() {
    if (!Array.isArray(co.msgs)) return null;
    for (let i = co.msgs.length - 1; i >= 0; i--) {
      const m = co.msgs[i];
      if (m.role === 'auxiliar' && m.reservation && m.reservation.id) return m.reservation;
    }
    return null;
  }
  function ctxRes() {
    if (co.ctxOff || !co.ctxRid || !Array.isArray(co.msgs)) return null;
    const m = co.msgs.find(x => x.reservation && x.reservation.id === co.ctxRid);
    return m ? m.reservation : null;
  }
  function paintCtx() {
    const el = $co('co-ctx'); if (!el) return;
    const r = ctxRes();
    el.innerHTML = r ? `<span>Sobre: <b>${esc(resLabel(r))}</b></span><button data-co="ctx-off" aria-label="Responder sin el traslado">Quitar</button>` : '';
    el.classList.toggle('on', !!r);
  }
  async function loadMsgs(silent) {
    const aux = co.openAux; if (!aux) return;
    const a = api();
    const my = ++co.seq;
    let r = null;
    try { r = (a && typeof a.crewList === 'function') ? await a.crewList(aux) : null; } catch (_) { r = null; }
    if (my !== co.seq || co.openAux !== aux) return;   // cerró o cambió de hilo
    if (r === null && silent && Array.isArray(co.msgs)) return;
    const tmp = Array.isArray(co.msgs) ? co.msgs.filter(m => m._tmp) : [];
    co.msgs = Array.isArray(r) ? r.concat(tmp) : null;
    if (Array.isArray(co.msgs) && !co.ctxOff) {
      const d = defaultCtx(); co.ctxRid = d ? d.id : null;
    }
    paintMsgs();
    paintCtx();
    // Leer = marcar leído para todo el equipo (crew_mark_read de 0088).
    if (Array.isArray(r) && r.some(m => m.role === 'auxiliar' && !m.read) && a && typeof a.crewMarkRead === 'function') {
      try { await a.crewMarkRead(aux); } catch (_) { /* se reintenta en el próximo sondeo */ }
      const t = threadOf(aux); if (t && t.unread) { t.unread = 0; paintList(); }
    }
  }
  function openThread(auxId) {
    if (!auxId) return;
    co.openAux = auxId; co.msgs = undefined; co.ctxRid = null; co.ctxOff = false; co.sending = false;
    const t = threadOf(auxId); if (t) t.unread = 0;
    paintList(true);
    paintThread();
    loadMsgs(false);
    const i = $co('co-input');
    // En el celular el teclado taparía el hilo: solo se enfoca en escritorio.
    if (i && window.matchMedia && window.matchMedia('(min-width: 1000px)').matches) { try { i.focus(); } catch (_) { /* */ } }
  }
  function closeThread() {
    co.openAux = null; co.msgs = undefined; co.seq++;
    paintList(true);
    paintThread();
  }

  async function send() {
    const aux = co.openAux; const a = api();
    const i = $co('co-input');
    if (!aux || !i || co.sending) return;
    const body = i.value.trim(); if (!body) return;
    if (!a || typeof a.crewSend !== 'function') { say('Coordinación todavía no está disponible.'); return; }
    const rid = ctxRes() ? co.ctxRid : null;
    co.sending = true;
    const btn = $co('co-send'); if (btn) btn.disabled = true;
    i.value = '';
    // Optimista: la burbuja aparece de una; si falla se quita y se devuelve el texto.
    const temp = { id: 'tmp' + Date.now(), role: 'admin', mine: true, body, at: new Date().toISOString(), read: false, _tmp: true,
      reservation: rid ? (ctxRes() || null) : null };
    co.msgs = (Array.isArray(co.msgs) ? co.msgs : []).concat([temp]);
    paintMsgs();
    const quitar = () => { co.msgs = (co.msgs || []).filter(m => m.id !== temp.id); paintMsgs(); };
    try {
      const r = await a.crewSend(body, { auxId: aux, reservationId: rid || undefined });
      if (r === null) {
        quitar(); i.value = body;
        say('No se envió: la base todavía no tiene Coordinación.');
        return;
      }
      const n = Array.isArray(r.recipients) ? r.recipients.length : 0;
      if (!n) say('Guardado en el hilo, pero no había a quién avisarle.');
      else if (r.notified === false) say('Enviado, pero no tiene notificaciones activadas: lo verá al abrir la app.');
      else say('Mensaje enviado.');
      if (co.openAux === aux) {
        co.msgs = (co.msgs || []).filter(m => m.id !== temp.id);
        await loadMsgs(false);
      }
      loadThreads(true);
    } catch (e) {
      quitar(); i.value = body;
      say((e && e.message) ? e.message : 'No se pudo enviar el mensaje.');
    } finally {
      co.sending = false;
      const b = $co('co-send'); if (b) b.disabled = false;
    }
  }

  // ── sondeo ───────────────────────────────────────────────────────────────
  function visible() {
    const r = root(); if (!r) return false;
    const sec = r.closest('section[data-panel]');
    return !sec || !sec.classList.contains('hidden');
  }
  function tick() {
    if (!visible()) { stopCoordTimer(); return; }
    loadThreads(true);
    if (co.openAux) loadMsgs(true);
  }
  function stopCoordTimer() {
    if (co.poll) { clearInterval(co.poll); co.poll = null; }
  }

  // ── eventos ──────────────────────────────────────────────────────────────
  function bind() {
    const r = root(); if (!r || co.bound) return;
    co.bound = true;
    r.addEventListener('click', (e) => {
      const el = e.target.closest('[data-co]'); if (!el || !r.contains(el)) return;
      const act = el.getAttribute('data-co');
      if (act === 'open') { openThread(el.getAttribute('data-aux')); return; }
      if (act === 'close') { closeThread(); return; }
      if (act === 'send') { send(); return; }
      if (act === 'ctx-off') { co.ctxOff = true; paintCtx(); return; }
      if (act === 'refresh') { loadThreads(false); loadContact(); if (co.openAux) loadMsgs(false); return; }
      if (act === 'reload') { co.threads = undefined; paintList(); loadThreads(false); return; }
      if (act === 'msgs-reload') { co.msgs = undefined; paintMsgs(); loadMsgs(false); return; }
      if (act === 'contact-save') { saveContact(); return; }
      if (act === 'contact-reload') { co.contact = undefined; paintContact(); loadContact(); return; }
      // 'res-chat' es un <a href="#/reservas?chat=…">: el hashchange de core
      // abre Reservas con ese hilo. No se intercepta.
    });
    // Enter manda: en el teclado del celular el botón queda tapado.
    r.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target && e.target.id === 'co-input' && !e.shiftKey) { e.preventDefault(); send(); }
    });
  }

  function renderCoordinacion() {
    if (!ensureShell()) return;
    bind();
    const pend = co.pendingAux; co.pendingAux = null;
    paintContact();
    paintList(true);
    if (pend) openThread(pend);
    else paintThread();
    // Al entrar se pide de nuevo y sin red se dice (la lista vieja no se
    // presenta como vigente); solo el sondeo cada 5 s calla un fallo suelto.
    loadThreads(false);
    loadContact();
    if (co.openAux && !pend) loadMsgs(true);
    stopCoordTimer();
    co.poll = setInterval(tick, CO_POLL_MS);
  }

  // ── enlace profundo #/coordinacion?aux=<id> (solo el jefe) ───────────────
  const esJefe = () => {
    try { return typeof state !== 'undefined' && !!state && !!state.profile && state.profile.role === 'admin'; }
    catch (_) { return false; }
  };
  function leerHash() {
    const m = String(location.hash || '').match(/^#\/coordinacion(?:\?(.*))?$/i);
    if (!m) return null;
    const q = new URLSearchParams(m[1] || '');
    return { aux: q.get('aux') || null };
  }
  // Consume el hash y abre la pestaña. Devuelve true si lo tomó.
  function tomarHash() {
    const d = leerHash(); if (!d || !esJefe()) return false;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (_) { /* */ }
    if (d.aux) co.pendingAux = d.aux;
    if (typeof setTab === 'function') setTab('coordinacion');       // core.js (ámbito global)
    else renderCoordinacion();
    return true;
  }
  // Con la app ya abierta el service worker solo cambia el hash. El tripulante
  // también tiene #/coordinacion (lo resuelve aux-shell): por eso esJefe().
  window.addEventListener('hashchange', () => { try { tomarHash(); } catch (_) { /* */ } });
  // En frío: core.enterApp llama applyDeepLink (que no conoce esta ruta, así que
  // no toca el hash) y cae a la consola con setTab('consola'). Se espera a ESE
  // setTab —state.activeTab deja de ser el de arranque— y recién ahí se abre la
  // pestaña; antes, enterApp la pisaría con la consola. Tope: 60 s. Si quien
  // entra no es jefe, el hash no se toca (es del tripulante: aux-shell).
  (function coDeepLinkAlArrancar() {
    if (!leerHash()) return;
    let inicial;
    try { inicial = (typeof state !== 'undefined' && state) ? state.activeTab : undefined; } catch (_) { /* */ }
    let n = 0;
    const iv = setInterval(() => {
      n++;
      let rol = null, entro = false;
      try {
        rol = (typeof state !== 'undefined' && state && state.profile) ? state.profile.role : null;
        entro = !!rol && state.activeTab !== inicial;
      } catch (_) { /* */ }
      const otro = !!rol && rol !== 'admin';
      if (entro || otro || n > 240 || !leerHash()) {
        clearInterval(iv);
        if (entro && rol === 'admin') { try { tomarHash(); } catch (_) { /* */ } }
      }
    }, 250);
  })();

  // Para que core.applyDeepLink (si algún día conoce #/coordinacion) pase el
  // tripulante antes de setTab('coordinacion'): renderCoordinacion.focus(auxId).
  // Va colgada de renderCoordinacion y no suelta en window: el contrato de los
  // paneles publica solo render*/stop*Timer.
  function coordFocus(auxId) {
    if (!auxId) return;
    if (visible() && root() && root().querySelector('.co-wrap')) openThread(auxId);
    else co.pendingAux = auxId;
  }

  renderCoordinacion.focus = coordFocus;
  window.renderCoordinacion = renderCoordinacion;
  window.stopCoordTimer = stopCoordTimer;
})();
