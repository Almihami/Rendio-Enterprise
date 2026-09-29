// aux-rx-vuelo.js — P8 · «Cambió mi vuelo» del rediseño del auxiliar (27-sep-2026).
//
// Porta RxFlight de rx-home.jsx con su marcado: rx-scr · RxHead «Cambió mi
// vuelo» · rx-body con rx-ob-h rx-in («¿Qué cambió?») · rx-input rx-in --d:1
// con el avión · rx-flight-new rx-in --d:2 (la hora de antes tachada → la de
// ahora) · rx-note rx-in --d:3 con el reloj · rx-foot con el botón; y al
// terminar, rx-center-in con RxCheck (rx-check) + h2 + p y «Listo» (pop).
//
// Lo que cambia por decisión (plan final §1.6, §3.12, D8 y D12):
//   · Campos PROPIOS (data-rx-field, estado de este módulo; nunca
//     auxState.form ni AuxRxPedir.flightField): vuelo (obligatorio en una
//     llegada; en una salida vacío = se conserva el que tenía), día y hora
//     (rx-fv-when, --d:1 como el campo del vuelo: el diseño no los trae).
//   · La hora es «como hoy»: en una llegada, la de aterrizaje; en una salida,
//     la de estar en MDE (no hay dato de salida del vuelo, D8).
//   · Nada de «Tu recogida pasa de 03:48 a 04:28. Carlos ya lo sabe»: no
//     calculamos recogidas aquí. La nota dice lo que VA a pasar según las
//     mismas reglas de la RPC (auxiliar_change_flight, 0089):
//       sin plan → «Actualizamos tu traslado»;
//       con plan, privado o dentro del plazo mínimo → «Coordinación ajusta tu
//       recogida y te confirma» (la RPC encola el aviso a los jefes).
//     El resultado de verdad es el que devuelve ApiAux.changeFlight: updated →
//     «Actualizamos tu traslado»; needs_ops → «Coordinación ajusta tu recogida
//     y te confirma»; un error → toast con el texto del servidor.
//   · Si hay varios traslados que se pueden cambiar y no se dijo cuál, una
//     hoja (rx-sh + rx-opt) para elegir.
//
// Animaciones: las del diseño (rx-in con los mismos --d; rx-check al terminar).
// Pasar del formulario al «hecho» o elegir otro traslado RECREA el cuerpo
// (.rx-body.rx-anim), como el cambio de rama de React; repintar la misma
// pantalla no anima (el shell pone .rx-noanim).
//
// Contrato: window.AuxRxVuelo = { candidates(), open(resId), predict(t, f), html() }.
// Registra AuxShell 'flight' y las acciones data-rx fv-pick, fv-choose, fv-send.
(function () {
  'use strict';

  const MAX_DAYS = 14;                       // la RPC acepta hasta 14 días adelante
  const STARTED = ['en_route', 'at_pickup', 'on_board', 'picked_up', 'en_route_home', 'delivered', 'no_show', 'cancelled'];
  const FLIGHT_RE = /^[A-Z]{0,3}[0-9]{2,5}$/;  // mismo patrón que auxiliar_change_flight
  const NO_DISP = 'Todavía no puedes cambiar el vuelo desde la app. Escríbele a Coordinación';

  const UI = () => window.AuxRxUI || null;
  const SH = () => window.AuxShell || null;
  const AX = () => window.Auxiliar || null;
  const safe = (f, fb) => { try { const v = f(); return v === undefined ? fb : v; } catch (_) { return fb; } };
  function esc(s) {
    const u = UI(); if (u && u.esc) return u.esc(s);
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  const ic = (n, s) => { const u = UI(); return u && u.ic ? u.ic(n, s) : ''; };
  const auxSt = () => { const a = AX(); return (a && a.state) || {}; };
  const trips = () => (Array.isArray(auxSt().trips) ? auxSt().trips : []);
  function settings() {
    try {
      // eslint-disable-next-line no-undef
      if (typeof state !== 'undefined' && state && state.settings) return state.settings;
    } catch (_) { /* */ }
    return (window.state && window.state.settings) || {};
  }
  function toast(msg, icon) {
    const s = SH();
    if (s && typeof s.toast === 'function') s.toast(msg, icon || 'Check');
    else if (typeof window.toast === 'function') window.toast(msg);
  }

  // ── Horas y días en Bogotá ───────────────────────────────────────────────
  const WD = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
  const MO = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  function bogDay(v) {
    const u = UI(); if (u && u.bogDay) { const d = safe(() => u.bogDay(v), ''); if (d) return d; }
    try {
      const p = {};
      new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(new Date(v)).forEach(x => { p[x.type] = x.value; });
      return p.year ? `${p.year}-${p.month}-${p.day}` : '';
    } catch (_) { return ''; }
  }
  const hmOnly = (v) => { const m = String(v || '').match(/^(\d{1,2}):(\d{2})/); return m ? m[1].padStart(2, '0') + ':' + m[2] : ''; };
  function pickupHM(iso) { const u = UI(); return iso && u && u.hm ? u.hm(iso) : ''; }
  function tsOf(date, time) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !hmOnly(time)) return null;
    const x = Date.parse(`${date}T${hmOnly(time)}:00-05:00`);   // Colombia no tiene horario de verano
    return isNaN(x) ? null : x;
  }
  const whenTs = (t) => (t ? tsOf(t.date, t.time) : null);
  function shortDay(d) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) return '';
    const now = Date.now();
    if (d === bogDay(now)) return 'hoy';
    if (d === bogDay(now + 86400e3)) return 'mañana';
    const x = new Date(d + 'T12:00:00-05:00');
    if (isNaN(x.getTime())) return '';
    return WD[x.getUTCDay()] + ' ' + x.getUTCDate() + ' ' + MO[x.getUTCMonth()];
  }
  // «de hoy» / «de mañana» / «del jue 16 oct»
  const deDay = (d) => { const s = shortDay(d); return !s ? '' : (s === 'hoy' || s === 'mañana' ? 'de ' + s : 'del ' + s); };
  // «hoy» / «mañana» / «el jue 16 oct»
  const elDay = (d) => { const s = shortDay(d); return !s ? '' : (s === 'hoy' || s === 'mañana' ? s : 'el ' + s); };
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const normFlight = (v) => String(v || '').replace(/[\s-]/g, '').toUpperCase();

  // ── Qué traslados se pueden cambiar ──────────────────────────────────────
  // Los mismos que acepta la RPC: suyos, sin cancelar y sin empezar (el
  // conductor no ha salido ni llegado a la parada).
  const arrived = (t) => !!((t && t._info && t._info.stop_status === 'arrived') || (t && t.stopStatus === 'arrived'));
  function isCandidate(t) {
    if (!t || !t.id || t.cancelledAt) return false;
    if (t.status !== 'pending' && t.status !== 'assigned') return false;
    if (t.rawStatus && STARTED.includes(t.rawStatus)) return false;
    if (arrived(t)) return false;
    const a = AX();
    if (a && typeof a.isUpcoming === 'function' && !safe(() => a.isUpcoming(t), true)) return false;
    return true;
  }
  function candidates() {
    return trips().filter(isCandidate)
      .map((t, i) => [t, whenTs(t), i])
      .sort((a, b) => (a[1] == null) - (b[1] == null) || (a[1] || 0) - (b[1] || 0) || a[2] - b[2])
      .map(x => x[0]);
  }
  const isLle = (t) => !!t && t.type === 'lle';
  function isPublished(t) {
    const i = window.AuxRxInicio;
    if (i && typeof i.isPublished === 'function') return !!safe(() => i.isPublished(t), false);
    return !!(t && (t.published === true || t.pickupAt));
  }
  const isPrivate = (t) => !!t && t.level === 'private' && (t.privateStatus === 'requested' || t.privateStatus === 'approved');

  // ── Estado del módulo ────────────────────────────────────────────────────
  // phase: 'form' | 'pick' (varios, falta elegir) | 'none' (ninguno) |
  //        'blocked' (el que llegó ya empezó o se canceló) | 'done'
  const fv = { key: null, el: null, phase: 'none', tripId: null, flight: '', date: '', time: '', sending: false, result: null, bound: false };
  const curTrip = () => (fv.tripId ? trips().find(t => t && t.id === fv.tripId) || null : null);

  function choose(t) {
    fv.tripId = t.id;
    fv.flight = normFlight(t.flight);
    fv.date = t.date || '';
    fv.time = hmOnly(t.time);
    fv.result = null;
    fv.phase = 'form';
  }
  function start(props) {
    const id = props && props.reservationId;
    fv.sending = false; fv.result = null;
    if (id) {
      const t = trips().find(x => x && x.id === id);
      if (t && isCandidate(t)) { choose(t); return; }
      if (t) { fv.tripId = t.id; fv.phase = 'blocked'; return; }
    }
    const list = candidates();
    if (list.length === 1) { choose(list[0]); return; }
    fv.tripId = null;
    fv.phase = list.length ? 'pick' : 'none';
  }

  // ── Qué va a pasar (las reglas de la RPC, 0089) ──────────────────────────
  function changes(t) {
    const nf = normFlight(fv.flight), of = normFlight(t && t.flight);
    const timeChanged = !!t && (fv.date !== (t.date || '') || fv.time !== hmOnly(t.time));
    // Salida: vacío = se conserva. Llegada: vaciarlo también es un cambio (y la
    // validación lo frena con su texto).
    const flightChanged = !!t && (nf ? nf !== of : (isLle(t) && !!of));
    return { timeChanged, flightChanged, any: timeChanged || flightChanged };
  }
  // f = {date, time} opcional (por defecto, lo escrito). → 'updated' | 'needs_ops'
  function predict(t, f) {
    if (!t) return null;
    const ff = f || { date: fv.date, time: fv.time };
    const nt = tsOf(ff.date, ff.time), ot = whenTs(t);
    if (f && nt != null && ot != null && nt === ot) return 'updated';   // misma hora: solo se anota el vuelo
    let lead = settings().aux_min_lead_hours;
    lead = lead == null || lead === '' || !isFinite(Number(lead)) ? 6 : Number(lead);
    const lim = Date.now() + lead * 3600e3;
    return (isPublished(t) || isPrivate(t) || (nt != null && nt < lim) || (ot != null && ot < lim)) ? 'needs_ops' : 'updated';
  }
  function validate(t) {
    const nf = normFlight(fv.flight);
    if (isLle(t) && !nf) return 'Escribe el número de vuelo en el que llegas';
    if (nf && !FLIGHT_RE.test(nf)) return 'Ese número de vuelo no se entiende (ej.: AV9412)';
    const nt = tsOf(fv.date, fv.time);
    if (nt == null) return 'Elige el día y la hora';
    if (nt <= Date.now()) return 'Esa hora ya pasó';
    if (nt > Date.now() + MAX_DAYS * 86400e3) return 'Solo puedes cambiarlo hasta 14 días adelante';
    return null;
  }

  // ── Marcado ──────────────────────────────────────────────────────────────
  function headHTML() {
    const u = UI();
    if (u && u.head) return u.head({ title: 'Cambió mi vuelo' });
    return `<div class="rx-head"><div class="rx-head-row"><button type="button" class="rx-ib" data-rx="rx-pop" aria-label="Volver">${ic('ChevronLeft', 22)}</button>`
      + '<div class="rx-head-c"><b>Cambió mi vuelo</b></div><div class="rx-head-r"></div></div></div>';
  }
  function btn(label, o) {
    const u = UI();
    if (u && u.btn) return u.btn(label, o);
    const a = o && o.attrs ? Object.keys(o.attrs).map(k => ` ${k}="${esc(o.attrs[k])}"`).join('') : '';
    return `<button type="button" class="rx-btn ${(o && o.kind) || 'pri'}"${o && o.disabled ? ' disabled' : ''}${a}>${esc(label)}</button>`;
  }
  function flightNewInner(t) {
    const oldT = hmOnly(t.time) || '--:--';
    const newT = hmOnly(fv.time) || '--:--';
    const dayChanged = !!(fv.date && t.date && fv.date !== t.date);
    const moved = dayChanged || (!!hmOnly(fv.time) && hmOnly(fv.time) !== hmOnly(t.time));
    return `<div><span>Antes${dayChanged && shortDay(t.date) ? ' · ' + esc(shortDay(t.date)) : ''}</span><b${moved ? ' class="strike"' : ''}>${esc(oldT)}</b></div>`
      + ic('ArrowRight', 18)
      + `<div><span>${isLle(t) ? 'Ahora aterrizas' : 'Ahora, en MDE'}${dayChanged && shortDay(fv.date) ? ' · ' + esc(shortDay(fv.date)) : ''}</span><b>${esc(newT)}</b></div>`;
  }
  function noteInner(t) {
    const ch = changes(t);
    const mode = ch.flightChanged && !ch.timeChanged ? 'updated' : predict(t);
    let txt;
    if (mode === 'needs_ops') {
      const pk = isPublished(t) ? pickupHM(t.pickupAt) : '';
      txt = pk ? `Tu recogida está a las <b>&nbsp;${esc(pk)}</b>. Coordinación la ajusta y te confirma.`
        : 'Coordinación ajusta tu recogida y te confirma.';
    } else {
      txt = ch.flightChanged && !ch.timeChanged ? 'Actualizamos el vuelo de tu traslado.' : 'Actualizamos tu traslado con la hora nueva.';
    }
    return ic('Clock', 15) + txt;
  }
  function whenField(label, key, type, value, extra, icon) {
    return `<label class="rx-field"><span>${esc(label)}</span><span class="rx-input">${ic(icon, 18)}`
      + `<input type="${type}" data-rx-field="${key}" value="${esc(value)}"${extra || ''} aria-label="${esc(label)}"></span></label>`;
  }
  function formHTML(t) {
    const lle = isLle(t);
    const today = bogDay(Date.now());
    const maxDay = bogDay(Date.now() + MAX_DAYS * 86400e3);
    const others = candidates().some(x => x.id !== t.id);
    const which = (lle ? 'llegada' : 'salida') + (deDay(t.date) ? ' ' + deDay(t.date) : '');
    return `<div class="rx-ob-h rx-in"><h1>¿Qué cambió?</h1><p>Tu <b>${esc(which)}</b>. Escribe el vuelo nuevo o confirma el mismo si solo cambió la hora.</p>`
      + (others ? '<button type="button" class="rx-fv-other" data-rx="fv-pick">Es otro traslado</button>' : '')
      + '</div>'
      + `<div class="rx-input rx-in" style="--d:1">${ic('Plane', 18)}<input type="text" data-rx-field="fv-flight" value="${esc(fv.flight)}"`
      + ` placeholder="${lle ? 'Número de vuelo' : 'Número de vuelo (opcional)'}" aria-label="Número de vuelo" maxlength="10" autocomplete="off" autocapitalize="characters" spellcheck="false"></div>`
      + '<div class="rx-fv-when rx-in" style="--d:1">'
      + whenField('Día', 'fv-date', 'date', fv.date, ` min="${esc(today)}" max="${esc(maxDay)}"`, 'Calendar')
      + whenField(lle ? 'Aterrizas' : 'Estar en MDE', 'fv-time', 'time', fv.time, '', 'Clock')
      + '</div>'
      + `<div class="rx-flight-new rx-in" style="--d:2">${flightNewInner(t)}</div>`
      + `<div class="rx-note rx-in" style="--d:3" data-fv="note">${noteInner(t)}</div>`;
  }
  function doneHTML() {
    const r = fv.result || {};
    const ops = r.mode === 'needs_ops';
    const u = UI();
    const chk = u && u.check ? u.check(ops ? 'info' : 'ok') : '';
    const day = elDay(r.date);
    const nueva = r.timeChanged
      ? (r.type === 'lle' ? 'Nueva hora de aterrizaje: ' : 'Nueva hora en MDE: ') + (day ? day + ' a las ' : '') + r.time
        + (r.flight && r.flightChanged ? ' · vuelo ' + r.flight : '')
      : 'Vuelo nuevo: ' + (r.flight || '') + '. La hora sigue igual';
    const p = ops
      ? 'Les pasamos tu cambio. ' + nueva + '. Mientras te confirman, tu traslado sigue como estaba.'
      : nueva + '.' + (r.timeChanged ? ' Te avisamos cuando armemos tu ruta.' : '');
    return `<div class="rx-center-in" data-fv="done" data-mode="${ops ? 'needs_ops' : 'updated'}">${chk}`
      + `<h2>${ops ? 'Coordinación ajusta tu recogida y te confirma' : 'Actualizamos tu traslado'}</h2>`
      + `<p>${esc(p)}</p></div>`;
  }
  function bodyInner() {
    const t = curTrip();
    if (fv.phase === 'done') return doneHTML();
    if (fv.phase === 'form' && t) return formHTML(t);
    if (fv.phase === 'pick') {
      return '<div class="rx-ob-h rx-in"><h1>¿Cuál traslado cambió?</h1>'
        + '<p>Tienes varios traslados que todavía no empiezan. Elige el del vuelo que cambió.</p></div>';
    }
    if (fv.phase === 'blocked' && t) {
      const title = t.status === 'cancelled' ? 'Ese traslado está cancelado'
        : t.status === 'done' ? 'Ese traslado ya terminó' : 'Tu traslado ya está en curso';
      return `<div class="rx-empty">${ic('AlertTriangle', 26)}<b>${esc(title)}</b>`
        + '<span>Desde aquí ya no se puede cambiar. Si cambió tu vuelo, escríbele a Coordinación.</span></div>';
    }
    return `<div class="rx-empty">${ic('Plane', 26)}<b>No tienes traslados por cambiar</b>`
      + '<span>Aquí aparecen tus traslados que todavía no empiezan.</span></div>';
  }
  function footInner() {
    const t = curTrip();
    if (fv.phase === 'done') return btn('Listo', { attrs: { 'data-rx': 'rx-pop' } });
    if (fv.phase === 'form' && t) {
      const ch = changes(t);
      return btn(fv.sending ? 'Enviando…' : 'Enviar el cambio', { disabled: fv.sending || !ch.any, attrs: { 'data-rx': 'fv-send' } });
    }
    if (fv.phase === 'pick') return btn('Elegir el traslado', { icon: 'Plane', attrs: { 'data-rx': 'fv-pick' } });
    if (fv.phase === 'blocked' && t) return btn('Escribir a Coordinación', { kind: 'sec', icon: 'Headset', attrs: { 'data-rx': 'open-coord', 'data-id': t.id } });
    return btn('Escribir a Coordinación', { kind: 'sec', icon: 'Headset', attrs: { 'data-rx': 'open-coord' } });
  }
  function html() {
    return '<div class="rx-scr rx-fv">' + headHTML()
      + `<div class="rx-body" data-fv="body">${bodyInner()}</div>`
      + `<div class="rx-foot" data-fv="foot">${footInner()}</div>`
      + '</div>';
  }

  // ── DOM de la pantalla montada ───────────────────────────────────────────
  function root() {
    const el = fv.el;
    return el && el.isConnected && !el.classList.contains('out') ? el : null;
  }
  const $ = (sel) => { const r = root(); return r ? r.querySelector(sel) : null; };
  function paintFoot() { const f = $('[data-fv="foot"]'); if (f) f.innerHTML = footInner(); }
  function paintLive() {
    const t = curTrip(); if (!t || fv.phase !== 'form') return;
    const fn = $('.rx-flight-new'); if (fn) fn.innerHTML = flightNewInner(t);
    const n = $('[data-fv="note"]'); if (n) n.innerHTML = noteInner(t);
    const b = $('[data-rx="fv-send"]');
    if (b) { if (!fv.sending && changes(t).any) b.removeAttribute('disabled'); else b.setAttribute('disabled', ''); }
  }
  // Cambio de rama (formulario ↔ hecho, otro traslado): el cuerpo se RECREA y
  // sus bloques vuelven a entrar, aunque la pantalla venga de un repintado.
  function remountBody() {
    const b = $('[data-fv="body"]');
    if (!b) return;
    const n = document.createElement('div');
    n.className = 'rx-body rx-anim';
    n.setAttribute('data-fv', 'body');
    n.innerHTML = bodyInner();
    b.replaceWith(n);
    paintFoot();
  }

  // ── Hoja para elegir el traslado ─────────────────────────────────────────
  function optHTML(t, i) {
    const lle = isLle(t);
    const title = (lle ? 'Llegada' : 'Salida') + (shortDay(t.date) ? ' · ' + shortDay(t.date) : '');
    const sub = (lle ? 'Aterrizas ' : 'Estar en MDE ') + (hmOnly(t.time) || '--:--') + (t.flight ? ' · ' + normFlight(t.flight) : '');
    return `<button type="button" class="rx-opt rx-in${t.id === fv.tripId ? ' on' : ''}" style="--d:${i}" data-rx="fv-choose" data-id="${esc(t.id)}">`
      + `<span class="rx-opt-ic">${ic(lle ? 'Home' : 'Plane', 18)}</span>`
      + `<span class="rx-opt-tx"><b>${esc(cap(title))}</b><span>${esc(sub)}</span></span></button>`;
  }
  function pickSheet() {
    const s = SH();
    const list = candidates();
    if (!s || typeof s.sheet !== 'function' || !list.length) return null;
    return s.sheet('<div class="rx-sh rx-fv-sh"><h3>¿Cuál traslado cambió?</h3>'
      + '<p>Elige el traslado del vuelo que cambió.</p>'
      + list.map(optHTML).join('') + '</div>');
  }
  function chooseAct(el) {
    const id = el && el.getAttribute('data-id');
    const t = trips().find(x => x && x.id === id);
    const s = SH();
    if (s && typeof s.closeSheet === 'function') s.closeSheet();
    if (!t || !isCandidate(t)) { toast('Ese traslado ya no se puede cambiar', 'AlertTriangle'); return; }
    if (fv.phase === 'form' && fv.tripId === t.id) return;
    choose(t);
    remountBody();
  }

  // ── Enviar ───────────────────────────────────────────────────────────────
  function refreshTrips() {
    const s = SH();
    if (s && typeof s.refreshTrips === 'function') { safe(() => s.refreshTrips(), null); return; }
    const a = AX();
    if (a && typeof a.reloadTrips === 'function') safe(() => a.reloadTrips({ silent: true }), null);
  }
  function sendAct() {
    if (fv.phase !== 'form' || fv.sending) return;
    const t = curTrip(); if (!t) return;
    const ch = changes(t);
    if (!ch.any) return;
    const bad = validate(t);
    if (bad) { toast(bad, 'AlertTriangle'); return; }
    const X = window.ApiAux;
    if (!X || typeof X.changeFlight !== 'function') { toast(NO_DISP, 'AlertTriangle'); return; }
    const payload = { flight: normFlight(fv.flight), date: fv.date, time: hmOnly(fv.time) };
    const key = fv.key;
    fv.sending = true;
    paintFoot();
    Promise.resolve()
      .then(() => X.changeFlight(t.id, payload))
      .then((r) => ({ r }), (e) => ({ e }))
      .then(({ r, e }) => {
        const here = key === fv.key && !!root();
        if (key === fv.key) fv.sending = false;
        if (e) { if (here) paintFoot(); toast((e && e.message) || 'No se pudo cambiar el vuelo', 'AlertTriangle'); return; }
        if (!r) { if (here) paintFoot(); toast(NO_DISP, 'AlertTriangle'); return; }
        if (r.unchanged) { if (here) paintFoot(); toast('Tu traslado ya tenía ese vuelo y esa hora', 'Info'); return; }
        const ops = r.mode === 'needs_ops';
        if (!ops) refreshTrips();
        if (!here) {
          // Se fue de la pantalla mientras se enviaba: que igual sepa qué pasó.
          toast(ops ? 'Coordinación ajusta tu recogida y te confirma' : 'Actualizamos tu traslado', ops ? 'Headset' : 'Check');
          return;
        }
        fv.result = {
          mode: ops ? 'needs_ops' : 'updated', type: t.type, date: payload.date, time: payload.time,
          flight: payload.flight || normFlight(t.flight), timeChanged: ch.timeChanged, flightChanged: ch.flightChanged,
        };
        fv.phase = 'done';
        remountBody();
      });
  }

  // ── Campos (estado propio; un solo oyente delegado) ──────────────────────
  function bindOnce() {
    if (fv.bound || typeof document === 'undefined') return;
    fv.bound = true;
    document.addEventListener('input', (e) => {
      const el = e.target;
      if (!el || !el.matches || !el.matches('[data-rx-field="fv-flight"], [data-rx-field="fv-date"], [data-rx-field="fv-time"]')) return;
      const k = el.getAttribute('data-rx-field');
      if (k === 'fv-flight') {
        // Como el diseño: se ve en mayúscula mientras se escribe.
        const up = String(el.value || '').toUpperCase();
        if (up !== el.value) {
          const p = el.selectionStart;
          el.value = up;
          try { if (p != null) el.setSelectionRange(p, p); } catch (_) { /* */ }
        }
        fv.flight = up;
      } else if (k === 'fv-date') fv.date = el.value || '';
      else fv.time = hmOnly(el.value);
      paintLive();
    });
  }

  // ── Pantalla «flight» ────────────────────────────────────────────────────
  const screen = {
    render(ctx) {
      if (ctx && ctx.reason === 'enter') {
        fv.key = ctx.key || null;
        start(ctx.props || {});
      }
      return html();
    },
    after(ctx) {
      fv.el = (ctx && ctx.el) || null;
      bindOnce();
      if (ctx && ctx.reason === 'enter' && fv.phase === 'pick') pickSheet();
    },
    // Lo escrito vive en el campo: una pasada del shell (refresco de viajes)
    // no repinta la pantalla.
    patch() { return true; },
    destroy(ctx) {
      if (ctx && ctx.reason === 'leave') { fv.el = null; fv.key = null; }
    },
  };

  window.AuxRxVuelo = {
    candidates,
    open: (reservationId) => { const s = SH(); return s && typeof s.push === 'function' ? s.push('flight', { reservationId: reservationId || null }) : null; },
    predict,
    html: () => html(),
  };

  const sh = SH();
  if (sh && typeof sh.register === 'function') {
    sh.register('flight', screen);
    sh.action('fv-pick', () => pickSheet());
    sh.action('fv-choose', chooseAct);
    sh.action('fv-send', sendAct);
  }
})();
