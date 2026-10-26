// admin-entregas.js — Rutas › Asignación › «Entregas de turno» (0140, 26-oct-2026).
//
// Pedido de los jefes: «que en el módulo administrativo nosotros podamos poner a
// quién le entrega el turno cada conductor y a ellos les aparezca en la app bien
// visible; cuando entreguen el turno que pongan entregado».
//
// Una tarjeta sobre la lista del día con las entregas de carro (la de las 2:00 p. m.
// y la de la madrugada). Quién recibe sale SOLO del plan publicado (el que maneja
// ese carro en la franja siguiente, admin_handovers); el jefe solo corrige: otro
// conductor, un jefe, o un lugar escrito («En casa de Julián»), o vuelve a
// «Automático». El estado se ve en la misma fila: automático/elegido, sin definir,
// ✓ entregado (lo toca el conductor), recibido (cuando el otro inicia turno).
//
// Módulo cerrado (IIFE): window.RendioEntregas.pintar(contenedor, día) lo llama
// admin-rutas-v2.js en cada render (y con el refresco de cada minuto). Lee la base
// como mucho cada 60 s por día; `forzar` (tras un cambio) lee ya.
// También lo usa Operación: RendioEntregas.deConductor(profileId) da la entrega de
// hoy de ese conductor (si ya se leyó).
(function () {
  'use strict';
  const W = window;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hm12 = (iso) => {
    try {
      const d = new Date(iso);
      const [h, m] = d.toLocaleTimeString('en-GB', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).split(':').map(Number);
      return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'a. m.' : 'p. m.'}`;
    } catch (_) { return ''; }
  };
  const corto = (n) => { const p = String(n || '').trim().split(/\s+/); return p[0] + (p[1] ? ' ' + p[1] : ''); };

  const st = { porDia: {}, leyendo: {}, editando: null, admins: null, falta: false };

  async function leer(dia, forzar) {
    const c = st.porDia[dia];
    if (!forzar && c && Date.now() - c.at < 60000) return c.rows;
    if (st.leyendo[dia]) return st.leyendo[dia];
    st.leyendo[dia] = (async () => {
      try {
        const rows = W.Api && Api.listHandovers ? await Api.listHandovers(dia) : null;
        st.falta = rows === null;
        st.porDia[dia] = { at: Date.now(), rows: rows || [] };
        return rows || [];
      } catch (_) { return (st.porDia[dia] && st.porDia[dia].rows) || []; }
      finally { st.leyendo[dia] = null; }
    })();
    return st.leyendo[dia];
  }

  // Estado de una fila, en palabras y con su tono.
  function estado(r) {
    if (r.sigue) return { t: 'Sigue con el carro', k: 'muted' };
    if (r.received_at) return { t: `Recibido ${hm12(r.received_at)}${r.delivered_at ? ' · entregado ' + hm12(r.delivered_at) : ''}`, k: 'ok' };
    if (r.delivered_at) return { t: `✓ Entregado ${hm12(r.delivered_at)}`, k: 'ok' };
    if (!r.to && !r.to_text) return { t: 'Sin definir: elige a quién', k: 'warn' };
    const tarde = Date.now() > Date.parse(r.due_at) + 15 * 60000;
    if (tarde && Date.now() < Date.parse(r.due_at) + 3 * 3600000) return { t: 'Sin marcar «Entregado»', k: 'bad' };
    return { t: r.manual ? 'Elegido por Coordinación' : 'Automático', k: 'muted' };
  }

  function filaHTML(r) {
    const e = estado(r);
    const key = r.band + '|' + r.from.id;
    const editando = st.editando === key;
    const a = r.sigue ? 'sigue' : r.to ? esc(corto(r.to.name)) : r.to_text ? esc(r.to_text) : '<i>sin definir</i>';
    let edit = '';
    if (editando) {
      // rt (admin-rutas.js) es global de script, no de window: se busca de las dos formas.
      const todos = (W.rt && W.rt.drivers) || (typeof rt !== 'undefined' && rt && rt.drivers) || [];
      const conductores = todos.filter((d) => d && d.id && d.id !== r.from.id)
        .slice().sort((x, y) => String(x.n || '').localeCompare(String(y.n || ''), 'es'));
      const jefes = (st.admins || []).filter((p) => !conductores.some((d) => d.id === p.id));
      edit = `<div class="rv2-ent-edit"><select aria-label="Quién recibe el carro de ${esc(r.from.name)}" data-ent-sel>`
        + '<option value="">Elige quién recibe…</option>'
        + (conductores.length ? '<optgroup label="Conductores">' + conductores.map((d) => `<option value="p:${esc(d.id)}"${r.to && r.to.id === d.id ? ' selected' : ''}>${esc(d.n || 'Conductor')}</option>`).join('') + '</optgroup>' : '')
        + (jefes.length ? '<optgroup label="Jefes">' + jefes.map((p) => `<option value="p:${esc(p.id)}"${r.to && r.to.id === p.id ? ' selected' : ''}>${esc(p.full_name || 'Jefe')}</option>`).join('') + '</optgroup>' : '')
        + `<option value="t:"${r.to_text ? ' selected' : ''}>Otro: lo deja en un lugar…</option>`
        + (r.manual ? '<option value="auto">Volver a automático</option>' : '')
        + `</select><input class="rv2-ent-txt" data-ent-txt placeholder="En casa de Julián" value="${esc(r.to_text || '')}" ${r.to_text ? '' : 'hidden'} maxlength="80" />`
        + `<button class="rv2-btn rv2-btn--sm rv2-btn--cta" data-ent-ok="${esc(key)}">Guardar</button><button class="rv2-btn rv2-btn--sm" data-ent-x>Cancelar</button></div>`;
    }
    return `<li class="rv2-ent" data-k="${e.k}">`
      + `<div class="rv2-ent-t"><b>${esc(hm12(r.due_at))}</b><small>${r.band === 'am' ? 'Mañana → tarde' : 'Tarde → mañana'}${r.car ? ' · ' + esc(r.car) : ''}${r.plate && r.plate !== r.car ? ' · ' + esc(r.plate) : ''}</small></div>`
      + `<div class="rv2-ent-m"><span><b>${esc(corto(r.from.name))}</b> → ${a}</span><small class="rv2-ent-st">${esc(e.t)}</small></div>`
      + (r.sigue || r.delivered_at || editando ? '' : `<button class="rv2-btn rv2-btn--sm" data-ent-edit="${esc(key)}">Cambiar</button>`)
      + edit + '</li>';
  }

  function html(rows) {
    const vis = (rows || []).filter((r) => !r.sigue || rows.length <= 4);
    if (!vis.length) return '';
    const faltan = vis.filter((r) => !r.sigue && !r.to && !r.to_text).length;
    return `<h2>🔑 Entregas de turno${faltan ? ` <span class="n">${faltan}</span>` : ''}</h2>`
      + '<p class="sub">A quién le entrega el carro cada conductor al terminar su turno. Sale solo del plan publicado (quien maneja ese carro después); cámbialo si es otro. Al conductor le aparece en Inicio desde 2 h antes y marca «Entregado».</p>'
      + '<ul class="rv2-ents">' + vis.map(filaHTML).join('') + '</ul>';
  }

  let atado = null;
  function atar(box, dia) {
    box.dataset.dia = dia;
    if (atado === box) return;
    atado = box;
    box.addEventListener('click', async (e) => {
      const d = box.dataset.dia;
      const ed = e.target.closest('[data-ent-edit]');
      if (ed) {
        st.editando = ed.getAttribute('data-ent-edit');
        if (!st.admins && W.Api && Api.listAdmins) { try { st.admins = await Api.listAdmins(); } catch (_) { st.admins = []; } }
        pintar(box, d);
        const s = box.querySelector('[data-ent-sel]'); if (s) s.focus();
        return;
      }
      if (e.target.closest('[data-ent-x]')) { st.editando = null; pintar(box, d); return; }
      const ok = e.target.closest('[data-ent-ok]');
      if (ok) {
        const [band, from] = ok.getAttribute('data-ent-ok').split('|');
        const sel = box.querySelector('[data-ent-sel]'), txt = box.querySelector('[data-ent-txt]');
        const v = sel ? sel.value : '';
        if (!v) { if (sel) sel.focus(); return; }
        const o = v === 'auto' ? { auto: true } : v.startsWith('p:') ? { to: v.slice(2) } : { text: (txt && txt.value || '').trim() };
        if (o.text === '') { if (txt) { txt.hidden = false; txt.focus(); } return; }
        ok.disabled = true;
        try {
          await Api.setHandover(d, band, from, o);
          st.editando = null;
          await leer(d, true);
          aviso(v === 'auto' ? 'La entrega volvió a lo automático.' : 'Entrega guardada: al conductor le aparece en Inicio.');
        } catch (err) { aviso('No se pudo: ' + ((err && err.message) || 'error')); ok.disabled = false; return; }
        pintar(box, d);
      }
    });
    box.addEventListener('change', (e) => {
      if (!e.target.matches('[data-ent-sel]')) return;
      const txt = box.querySelector('[data-ent-txt]');
      if (txt) { txt.hidden = e.target.value !== 't:'; if (!txt.hidden) txt.focus(); }
    });
  }
  function aviso(m) { const v = W.RendioRutasV2; if (v && typeof v.toast === 'function') v.toast(m); else if (typeof W.toast === 'function') W.toast(m); }

  // Pinta lo que haya leído (al instante) y, si hace falta, lee y vuelve a pintar.
  function pintar(box, dia, forzar) {
    if (!box) return;
    if (!dia) { box.hidden = true; box.innerHTML = ''; return; }
    atar(box, dia);
    const c = st.porDia[dia];
    const dibujar = (rows) => {
      if (box.dataset.dia !== dia) return;
      // Mientras se elige a quién, no se repinta por debajo (se perdería la selección).
      if (st.editando && box.querySelector('[data-ent-sel]') && !forzar) return;
      const h = st.falta ? '' : html(rows);
      box.hidden = !h; box.innerHTML = h;
    };
    if (c) dibujar(c.rows);
    if (forzar || !c || Date.now() - c.at >= 60000) leer(dia, forzar).then(dibujar);
  }

  // Para Operación: la entrega de hoy (o de la madrugada) de un conductor, si ya se leyó.
  function deConductor(profileId, dia) {
    const dias = dia ? [dia] : Object.keys(st.porDia);
    for (const d of dias) {
      const r = ((st.porDia[d] && st.porDia[d].rows) || []).find((x) => x.from && x.from.id === profileId && !x.sigue
        && Date.now() < Date.parse(x.due_at) + 3 * 3600000 && Date.now() > Date.parse(x.due_at) - 8 * 3600000);
      if (r) return r;
    }
    return null;
  }

  W.RendioEntregas = { pintar, leer, deConductor, estado, hm12, _st: st, _html: html };
})();
