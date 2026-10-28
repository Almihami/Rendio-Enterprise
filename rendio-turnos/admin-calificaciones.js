// admin-calificaciones.js — Rutas › Análisis › Calificaciones (28-oct-2026).
//
// Camilo (jefe), 11:20 a. m.: «lo de calificadas ponlo en otro lado, no sé, de
// servicio al cliente o métricas». Antes era un filtro de Reservas («Calificadas»)
// que mezclaba las estrellas con la operación del día. Aquí van solas: el promedio,
// cuántas de 5, las bajas (1–3★) que hay que atender, lo que más dicen, cómo le va
// a cada conductor y la lista, lo más nuevo primero.
//
// Datos: Api.listRatings(días) — reservations.rating / rating_tags / rated_at (0048)
// con el conductor de su vuelta. Solo lo que hay en la base: sin calificaciones,
// la pantalla lo dice (no se inventa un promedio).
//
// Módulo cerrado (IIFE): core.setTab('calificaciones') → window.renderCalificaciones().
// Para las pruebas: renderCalificaciones._st.
(function () {
  'use strict';
  const W = window;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Las etiquetas de «algo salió mal» de la app del tripulante (aux-rx-viaje.js TAGS_BAD).
  const MALAS = new Set(['Llegó tarde', 'Manejo brusco', 'Carro sucio', 'No encontré el carro', 'Otro']);
  const st = { dias: 30, solo: 'todas', filas: null, error: '', leyendo: false };
  const root = () => document.getElementById('cal-ui');

  const cuando = (iso) => {
    try {
      const d = new Date(iso);
      const dia = d.toLocaleDateString('es-CO', { timeZone: 'America/Bogota', weekday: 'short', day: 'numeric', month: 'short' }).replace(/\./g, '');
      const h = d.toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: 'numeric', minute: '2-digit', hour12: true })
        .replace(/\s+/g, ' ').replace(/a\.?\s?m\.?/i, 'a. m.').replace(/p\.?\s?m\.?/i, 'p. m.');
      return `${dia.charAt(0).toUpperCase() + dia.slice(1)} · ${h}`;
    } catch (_) { return ''; }
  };
  const corto = (n) => { const p = String(n || '').trim().split(/\s+/); return p[0] + (p[1] ? ' ' + p[1].charAt(0) + '.' : ''); };
  const estrellas = (n) => '★'.repeat(n) + '<i>' + '★'.repeat(5 - n) + '</i>';
  const coma = (x) => x.toFixed(1).replace('.', ',');
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

  async function leer() {
    if (!W.Api || typeof Api.listRatings !== 'function') { st.error = 'recarga la página'; pintar(); return; }
    st.leyendo = true; pintar();
    try {
      const r = await Api.listRatings(st.dias);
      if (r === null) { st.error = 'revisa la conexión o los permisos'; st.filas = null; }
      else { st.error = ''; st.filas = r; }
    } catch (e) { st.error = (e && e.message) || 'error'; st.filas = null; }
    st.leyendo = false;
    pintar();
  }

  function resumenHTML(fs) {
    const n = fs.length;
    const prom = fs.reduce((a, f) => a + f.rating, 0) / n;
    const cinco = fs.filter((f) => f.rating === 5).length;
    const bajas = fs.filter((f) => f.rating <= 3).length;
    const cuenta = {};
    fs.forEach((f) => f.tags.forEach((t) => { cuenta[t] = (cuenta[t] || 0) + 1; }));
    const top = Object.entries(cuenta).sort((a, b) => b[1] - a[1])[0];
    return '<div class="cal-sum">'
      + `<div class="cal-k"><span>Promedio</span><b>★ ${coma(prom)}</b><small>de ${n} ${n === 1 ? 'calificación' : 'calificaciones'}</small></div>`
      + `<div class="cal-k"><span>Con 5 estrellas</span><b>${pct(cinco, n)}%</b><small>${cinco} de ${n}</small></div>`
      + `<div class="cal-k${bajas ? ' is-bad' : ''}"><span>Bajas (1 a 3★)</span><b>${bajas}</b><small>${bajas ? 'para revisar con el conductor' : 'ninguna en este periodo'}</small></div>`
      + `<div class="cal-k"><span>Lo que más dicen</span><b class="cal-k-t">${top ? esc(top[0]) : '—'}</b><small>${top ? `${top[1]} ${top[1] === 1 ? 'vez' : 'veces'}` : 'sin etiquetas'}</small></div>`
      + '</div>';
  }
  function barrasHTML(fs) {
    const n = fs.length;
    return '<section class="cal-card"><h2>Estrellas</h2><ul class="cal-bars">'
      + [5, 4, 3, 2, 1].map((s) => {
        const c = fs.filter((f) => f.rating === s).length;
        return `<li><span>${s}★</span><i><b style="width:${pct(c, n)}%" class="s${s}"></b></i><em>${c}</em></li>`;
      }).join('') + '</ul></section>';
  }
  function conductoresHTML(fs) {
    const por = {};
    fs.forEach((f) => { const k = f.driver || ''; (por[k] = por[k] || []).push(f.rating); });
    const filas = Object.entries(por).map(([k, xs]) => ({ k, n: xs.length, p: xs.reduce((a, b) => a + b, 0) / xs.length, bajas: xs.filter((x) => x <= 3).length }))
      .sort((a, b) => (a.k ? 0 : 1) - (b.k ? 0 : 1) || b.n - a.n);
    return '<section class="cal-card"><h2>Por conductor</h2><table class="cal-tab"><thead><tr><th>Conductor</th><th>Promedio</th><th>Calificaciones</th><th>Bajas</th></tr></thead><tbody>'
      + filas.map((r) => `<tr><td>${r.k ? esc(r.k) : '<span class="cal-mute">Sin conductor en la app</span>'}</td><td>★ ${coma(r.p)}</td><td>${r.n}</td><td class="${r.bajas ? 'cal-bad' : ''}">${r.bajas}</td></tr>`).join('')
      + '</tbody></table></section>';
  }
  function filaHTML(f) {
    const tipo = f.type === 'lle' ? '<em class="cal-dir lle">↓ Llegada</em>' : '<em class="cal-dir sal">↑ Salida</em>';
    const tags = f.tags.length ? `<div class="cal-tags">${f.tags.map((t) => `<span class="${MALAS.has(t) ? 'bad' : ''}">${esc(t)}</span>`).join('')}</div>` : '';
    return `<div class="cal-row${f.rating <= 3 ? ' is-bad' : ''}"><div class="cal-stars" aria-label="${f.rating} de 5">${estrellas(f.rating)}</div>`
      + `<div class="cal-main"><b>${esc(f.name)}</b><span>${tipo} ${esc(cuando(f.when))} · ${f.driver ? 'con ' + esc(corto(f.driver)) : 'sin conductor en la app'}</span>${tags}</div>`
      + `<small>Calificó ${esc(cuando(f.ratedAt))}</small></div>`;
  }

  function pintar() {
    const r = root(); if (!r) return;
    const chip = (k, v, txt) => `<button class="cal-fbtn${st[k] === v ? ' on' : ''}" data-cal-${k}="${v}">${txt}</button>`;
    let h = '<div class="sh-phead"><div><h1>Calificaciones <span class="sh-ct">' + (st.filas ? st.filas.length : 0) + '</span></h1>'
      + '<p>Lo que los tripulantes califican al terminar cada traslado: las estrellas, lo que marcaron y con quién iban. Las bajas (1 a 3★) van en rojo: son las que hay que hablar con el conductor.</p></div>'
      + '<div class="cal-hacts"><button class="set-btn ghost" data-cal="leer"><svg class="icon"><use href="#i-refresh"/></svg>Refrescar</button></div></div>'
      + '<div class="cal-tools"><div class="cal-bar" role="group" aria-label="Periodo">' + chip('dias', 7, 'Últimos 7 días') + chip('dias', 30, '30 días') + chip('dias', 90, '90 días') + '</div>'
      + '<div class="cal-bar" role="group" aria-label="Cuáles">' + chip('solo', 'todas', 'Todas') + chip('solo', 'bajas', 'Solo las bajas') + '</div></div>';
    if (st.leyendo && !st.filas) h += '<p class="cal-msg">Leyendo las calificaciones…</p>';
    else if (st.error && !st.filas) h += `<p class="cal-msg bad">No se pudieron leer las calificaciones: ${esc(st.error)}.</p>`;
    else if (st.filas && !st.filas.length) h += `<div class="cal-empty"><svg class="icon"><use href="#i-medal"/></svg><h3>Sin calificaciones</h3><p>Nadie ha calificado un traslado en ${st.dias === 7 ? 'los últimos 7 días' : `los últimos ${st.dias} días`}.</p></div>`;
    else if (st.filas) {
      const fs = st.filas;
      const lista = st.solo === 'bajas' ? fs.filter((f) => f.rating <= 3) : fs;
      h += resumenHTML(fs) + '<div class="cal-grid">' + barrasHTML(fs) + conductoresHTML(fs) + '</div>'
        + `<h2 class="cal-h">${st.solo === 'bajas' ? 'Las bajas' : 'Todas'}, lo más nuevo primero <span>${lista.length}</span></h2>`
        + (lista.length ? `<div class="cal-list">${lista.map(filaHTML).join('')}</div>` : '<p class="cal-msg">Ninguna baja en este periodo.</p>');
    }
    r.innerHTML = h;
  }

  let atado = false;
  function atar() {
    const r = root(); if (!r || atado) return;
    atado = true;
    r.addEventListener('click', (e) => {
      const d = e.target.closest('[data-cal-dias]');
      if (d) { st.dias = Number(d.getAttribute('data-cal-dias')) || 30; leer(); return; }
      const s = e.target.closest('[data-cal-solo]');
      if (s) { st.solo = s.getAttribute('data-cal-solo'); pintar(); return; }
      if (e.target.closest('[data-cal="leer"]')) leer();
    });
  }

  function renderCalificaciones() { atar(); pintar(); return leer(); }
  renderCalificaciones._st = st;
  W.renderCalificaciones = renderCalificaciones;
})();
