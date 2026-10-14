// aux-rx-viajes.js — P3 · Viajes del rediseño del auxiliar (27-sep-2026).
//
// Porta RxTrips de rx-home.jsx: cabecera grande «Viajes», segmentado
// Próximos · Historial y la lista. Mismo marcado y clases (rx-head lg, rx-px,
// rx-seg, rx-body key={v}, rx-in --d, rx-empty, rx-pass, rx-hist, rx-row-ic,
// rx-row-tx, rx-hist-s).
//
// Un solo criterio de «próximo» (#20): Auxiliar.upcoming() / isUpcoming(t),
// el mismo que usa Inicio. El historial es Auxiliar.past(): cerrados y
// pendientes vencidos (estos con el chip «Sin realizar», Auxiliar.expired).
//
// Segmentado: el indicador se desliza sin repintar (AuxRxUI.segSet) y el
// .rx-body se RECREA (key={v} del diseño) para que las entradas corran otra vez.
//
// Contrato: window.AuxRxViajes = { html(), view() }. Registra AuxShell
// 'trips' y las acciones data-rx «trips-seg» y «trips-open».
(function () {
  'use strict';

  const UI = () => window.AuxRxUI || null;
  const AX = () => window.Auxiliar || null;
  const SH = () => window.AuxShell || null;
  const IN = () => window.AuxRxInicio || null;
  const safe = (f, fb) => { try { const v = f(); return v === undefined ? fb : v; } catch (_) { return fb; } };
  function esc(s) {
    const u = UI(); if (u && u.esc) return u.esc(s);
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  const ic = (n, s) => { const u = UI(); return u && u.ic ? u.ic(n, s) : ''; };
  const dayLabel = (d) => { const u = UI(); return u && u.dayLabel ? u.dayLabel(d) : String(d || ''); };

  // Vista elegida (se conserva al volver a la pestaña, como el useState del diseño
  // mientras la pestaña vive; al recrearla vuelve a «Próximos»).
  let view = 'next';

  const auxSt = () => { const a = AX(); return (a && a.state) || {}; };
  const list = (fn) => { const a = AX(); return a && typeof a[fn] === 'function' ? (safe(() => a[fn](), []) || []) : []; };
  function whenTs(t) {
    const i = IN(); if (i && i.whenTs) return i.whenTs(t);
    if (!t || !t.date || !t.time) return null;
    const x = new Date(t.date + 'T' + t.time + ':00-05:00').getTime();
    return isNaN(x) ? null : x;
  }
  const conjunto = (t) => { const i = IN(); return i && i.conjunto ? i.conjunto(t) : (String((t && t.address) || '').split(/[,·]/)[0].trim() || 'Casa'); };

  function passOf(t) {
    const i = IN();
    return i && typeof i.passHTML === 'function' ? i.passHTML(t) : '';
  }

  // Lo de la derecha de una fila del historial: estrellas, «Calificar» o el chip.
  function histRight(t) {
    const a = AX();
    if (t.status === 'done' && t.rated && Number(t.rating) > 0) {
      const s = Math.max(0, Math.min(5, Math.round(Number(t.rating))));
      return '<span class="rx-hist-s" aria-label="' + s + ' de 5">' + Array.from({ length: 5 }, (_, k) => '<i' + (k < s ? ' class="on"' : '') + '></i>').join('') + '</span>';
    }
    if (t.status === 'done' && t.driver && !t.rated) {
      const ts = t.droppedAt ? Date.parse(t.droppedAt) : whenTs(t);
      if (ts != null && !isNaN(ts) && Date.now() - ts < 7 * 86400e3) {
        // Sin data-* propio: el toque lo resuelve la fila («trips-open» mira si
        // cayó en este botón), así no se abren dos cosas con un solo toque.
        return '<button type="button" class="rx-hist-rate">Calificar</button>';
      }
    }
    if (a && typeof a.expired === 'function' && safe(() => a.expired(t), false)) {
      return '<span class="rx-hist-chip t-warn">Sin realizar</span>';
    }
    const m = (a && typeof a.statusMeta === 'function' ? safe(() => a.statusMeta(t.status), null) : null) || { cls: 'muted', label: t.status };
    const tone = t.status === 'cancelled' ? 'muted' : t.status === 'noshow' ? 'warn' : (m.cls || 'muted');
    return '<span class="rx-hist-chip t-' + esc(tone) + '">' + esc(m.label) + '</span>';
  }
  function histRow(t, i) {
    const lle = t.type === 'lle';
    const route = lle ? 'MDE → ' + conjunto(t) : conjunto(t) + ' → MDE';
    const sub = [dayLabel(t.date), t.flight || t.time || ''].filter(Boolean).join(' · ');
    return '<div class="rx-hist rx-in" style="--d:' + Math.min(i, 8) + '" role="button" tabindex="0" data-rx="trips-open" data-id="' + esc(t.id) + '">'
      + '<span class="rx-row-ic t-' + (lle ? 'a2h' : 'h2a') + '">' + ic(lle ? 'Home' : 'Plane', 18) + '</span>'
      + '<span class="rx-row-tx"><b>' + esc(route) + '</b><span>' + esc(sub) + '</span></span>'
      + histRight(t)
      + '</div>';
  }

  function bodyInner(v) {
    const u = UI();
    const S = auxSt();
    if (S.source === 'error') {
      return '<div class="rx-empty-trip rx-in">'
        + '<div class="rx-empty-ic">' + ic('CloudOff', 26) + '</div>'
        + '<b>No pudimos cargar tus viajes</b>'
        + '<span>Lo que ya pediste está guardado en nuestros servidores, no en el teléfono. Revisa tu conexión y reintenta.</span>'
        + (u && u.btn ? u.btn('Reintentar', { icon: 'Refresh', attrs: { 'data-ax': 'reload' } }) : '')
        + '</div>';
    }
    if (v === 'past') {
      const past = list('past');
      if (!past.length) return '<div class="rx-empty rx-in">' + ic('Clock', 28) + '<b>Todavía no tienes historial</b><span>Aquí quedan tus traslados cuando terminan.</span></div>';
      return past.map(histRow).join('');
    }
    const up = list('upcoming');
    if (!up.length) {
      return '<div class="rx-empty rx-in">' + ic('Calendar', 28) + '<b>Sin traslados programados</b>'
        + (u && u.btn ? u.btn('Pedir traslado', { kind: 'sec', icon: 'Plus', attrs: { 'data-ax': 'new' } }) : '')
        + '</div>';
    }
    return up.map((t, i) => '<div class="rx-in" style="--d:' + Math.min(i, 8) + '">' + passOf(t) + '</div>').join('');
  }
  const OPTS = [['next', 'Próximos'], ['past', 'Historial']];
  function html() {
    const u = UI();
    const head = u && u.head ? u.head({ back: false, large: true, title: 'Viajes' }) : '<div class="rx-head lg"><div class="rx-head-lg"><h1>Viajes</h1></div></div>';
    const seg = u && u.seg ? u.seg(view, OPTS, { name: 'trips', action: 'trips-seg' }) : '';
    return '<div class="rx-scr">' + head
      + '<div class="rx-px">' + seg + '</div>'
      + '<div class="rx-body" data-v="' + view + '">' + bodyInner(view) + '</div>'
      + '</div>';
  }

  function segAct(el) {
    const v = el && el.getAttribute('data-v');
    if (!v || !OPTS.some(o => o[0] === v)) return;
    const scr = el.closest('.rx-scr');
    const u = UI();
    if (u && u.segSet) u.segSet(el, v);
    if (v === view) return;
    view = v;
    const body = scr && scr.querySelector('.rx-body');
    if (!body) { const sh = SH(); if (sh) sh.render(); return; }
    // key={v}: el cuerpo se recrea y sus .rx-in vuelven a entrar.
    const n = document.createElement('div');
    n.className = 'rx-body rx-anim';
    n.setAttribute('data-v', v);
    n.innerHTML = bodyInner(v);
    body.replaceWith(n);
  }

  // Fila del historial: abre el viaje; si el toque cayó en «Calificar», con
  // la calificación abierta (Auxiliar.openTrip(id, {rate:true})).
  function openAct(el, ev) {
    const id = el && el.getAttribute('data-id');
    const a = AX();
    if (!id || !a || typeof a.openTrip !== 'function') return;
    const rate = !!(ev && ev.target && ev.target.closest && ev.target.closest('.rx-hist-rate'));
    if (rate) a.openTrip(id, { rate: true }); else a.openTrip(id);
  }

  let lastHTML = null;
  const screen = {
    render() { lastHTML = html(); return lastHTML; },
    patch() { return html() === lastHTML; },
    destroy(ctx) { if (ctx && ctx.reason === 'leave') view = 'next'; },
  };

  window.AuxRxViajes = { html, view: () => view };

  const sh = SH();
  if (sh && typeof sh.register === 'function') {
    sh.register('trips', screen);
    sh.action('trips-seg', segAct);
    sh.action('trips-open', openAct);
  }
})();
