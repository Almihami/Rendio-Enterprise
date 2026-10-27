// admin-cadena.js — La tarjeta del detector de cadena (0152).
// Comparte scope global con los demás módulos; el orden de carga está en index.html.
//
// 27-oct-2026: Enrique salió de JMC a las 11:30 con un conductor que terminaba
// otra vuelta a las 11:35, y Daniel estaba libre en JMC desde las 11:20. La base
// (detect_route_chains, cada 5 min) detecta eso antes y les avisa a los jefes:
// «⚠️ Enrique (11:30): Juan no alcanza … Recomendado: Daniel». El aviso trae
// `#/rutas?cadena=<id>` (core.js → applyDeepLink) y aquí se abre la tarjeta:
// qué pasa, a quién se recomienda y UN toque para pasársela. «Pasar a Daniel»
// publica SOLO esa vuelta (admin_route_set_driver por dentro, como «Guardar y
// publicar» de la hoja de la vuelta), con los avisos de siempre. Antes de
// publicar, la base vuelve a revisar que Daniel siga alcanzando.
// EN SOMBRA: el sistema no mueve a nadie solo; esto solo lo hace un jefe.
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hm = (iso) => {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Bogota' }); }
    catch (e) { return '—'; }
  };
  // Nombre y primer apellido, como short_name() de la base.
  const corto = (n) => String(n || '').trim().split(/\s+/).slice(0, 2).join(' ');
  const say = (m) => { if (typeof window.toast === 'function') window.toast(m); };
  const RES = {
    aplicado: 'Ya se la pasaron al recomendado.',
    cambio: 'Ya le cambiaron el conductor a esa vuelta.',
    arranco: 'Esa vuelta ya arrancó.',
    ya_alcanza: 'Ya no hace falta: su conductor ahora alcanza.',
    descartado: 'Esta recomendación se descartó.',
    vencida: 'Esta recomendación ya venció.',
  };
  const st = { id: null, data: null, busy: false };

  const panel = () => document.getElementById('cadena');
  function bind() {
    const p = panel(); if (!p || p.dataset.bound) return;
    p.dataset.bound = '1';
    p.addEventListener('click', onClick);
  }
  function cerrar() {
    const p = panel(); if (p) p.classList.add('hidden');
    st.id = null; st.data = null; st.busy = false;
  }
  function pintar(html, sub) {
    const b = document.getElementById('cd-body'); if (b) b.innerHTML = html;
    const s = document.getElementById('cd-sub'); if (s) s.textContent = sub || '';
  }

  async function abrir(id) {
    const p = panel(); if (!p || !id) return;
    bind();
    st.id = id; st.data = null; st.busy = false;
    p.classList.remove('hidden');
    pintar('<p class="ac-load">Revisando la vuelta…</p>', '');
    if (!window.Api || typeof Api.cadenaVer !== 'function') { pintar('<div class="ac-nope"><b>No se pudo abrir</b><span>Recarga la app.</span></div>'); return; }
    let d;
    try { d = await Api.cadenaVer(id); }
    catch (e) {
      if (st.id === id) pintar(`<div class="ac-nope"><b>No se pudo abrir</b><span>${esc((e && e.message) || 'Revisa la señal e inténtalo otra vez.')}</span></div>`);
      return;
    }
    if (st.id !== id) return;
    st.data = d || {};
    pintarDatos();
  }

  function pintarDatos() {
    const d = st.data || {};
    const a = (d.ahora && d.ahora.known) ? d.ahora : null;   // recalculado al abrir
    const sub = `${(d.ahora && d.ahora.tipo) || 'Vuelta'} de las ${hm(d.need_at)}${d.ahora && d.ahora.quien ? ' · ' + d.ahora.quien : ''}`;
    const cond = corto(d.ahora && d.ahora.driver_name) || 'Su conductor';
    if (d.resolved_at) {
      pintar(`<div class="ac-nope"><b>${esc(RES[d.resolution] || 'Esta recomendación ya se resolvió.')}</b><span>No hay nada que hacer aquí.</span></div>` + pie(false), sub);
      return;
    }
    const late = a ? a.late_min : d.late_min;
    const eta = a ? a.eta_at : d.eta_at;
    const why = (a ? a.why : d.why) || '';
    let h = '<div class="ac-lbl">Qué pasa</div>';
    if (late != null && late <= 4) {
      h += `<div class="ac-opt ok"><div class="ac-opt-top"><b>${esc(cond)} ahora sí alcanza</b><span class="ac-extra">${hm(eta)}</span></div>`
        + `<div class="ac-opt-sub">${esc(cond)} ${esc(why)} y llega ${hm(eta)}. Puedes descartar esta recomendación.</div></div>`;
    } else {
      h += `<div class="ac-opt bad"><div class="ac-opt-top"><b>${esc(cond)} no alcanza</b><span class="ac-extra">+${esc(late)} min</span></div>`
        + `<div class="ac-opt-sub">${esc(cond)} ${esc(why)} y llegaría ${hm(eta)}. Tiene que estar a las ${hm(d.need_at)}.</div></div>`;
    }
    if (d.kind === 'reasignar' && d.suggested) {
      const n = corto(d.suggested_name) || 'el recomendado';
      const sigue = d.sigue || {};
      const ok = sigue.ok !== false;
      h += '<div class="ac-lbl off">Recomendado</div>'
        + `<div class="ac-opt ${ok ? 'ok' : 'bad'}"><div class="ac-opt-top"><b>${esc(n)}</b>`
        + `<span class="ac-tag ${ok ? 'ok' : 'bad'}">${ok ? 'Alcanza' : 'Ya no alcanza'}</span>`
        + `<span class="ac-extra">${hm(ok && sigue.eta ? sigue.eta : d.suggested_eta_at)}</span></div>`
        + `<div class="ac-opt-sub">${esc(n)} ${esc(d.suggested_why || '')}${ok ? ' y llega ' + hm(sigue.eta || d.suggested_eta_at) + '.' : ' · ' + esc(sigue.motivo || '') + '.'}</div></div>`
        + `<button class="cd-cta" data-cd="aplicar"${ok ? '' : ' disabled'}>Pasar a ${esc(n)}</button>`
        + `<p class="cd-nota">${ok ? `Publica solo esta vuelta y les avisa a ${esc(n)}, a ${esc(cond)} y a los tripulantes. El resto del día no se toca.` : 'Mira las otras opciones: puede haber otro conductor o toca delegarla.'}</p>`;
    } else {
      h += '<div class="ac-lbl off">Recomendado</div>'
        + '<div class="ac-nope tercero"><b>Delegarla</b><span>Nadie del turno alcanza a llegar a tiempo. Delégala a un Uber o a un conductor de confianza.</span></div>';
    }
    pintar(h + pie(true), sub);
  }

  function pie(abierta) {
    const d = st.data || {};
    return '<div class="cd-acc">'
      + `<button class="ac-btn" data-cd="opciones">${d.kind === 'delegar' && abierta ? 'Delegar u otras opciones' : 'Ver otras opciones'}</button>`
      + (abierta ? '<button class="ac-btn" data-cd="descartar">Descartar</button>' : '')
      + '</div>'
      + '<div class="ac-nota"><p>Es una recomendación: el sistema no mueve a nadie solo.</p>'
      + `<p><button class="cd-link" data-cd="apagar">${d.activa === false ? 'Volver a encender estas recomendaciones' : 'Apagar estas recomendaciones'}</button></p></div>`;
  }

  // «Ver otras opciones»: la hoja «Conductor de esta vuelta» de Asignación.
  async function otrasOpciones(route, dia, hora) {
    const V2 = window.RendioRutasV2;
    const pista = () => say(`Abre la vuelta de las ${hora} en Asignación y toca «Cambiar».`);
    if (!V2 || typeof V2.abrirVuelta !== 'function') { pista(); return; }
    try {
      if (dia && typeof V2.diaActual === 'function' && V2.diaActual() !== dia && typeof V2.cargarDia === 'function') await V2.cargarDia(dia);
    } catch (e) { /* abajo se intenta igual */ }
    for (let i = 0; i < 40; i++) {   // la carga del día puede tardar unos segundos
      if (V2.abrirVuelta(route)) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    pista();
  }

  async function onClick(e) {
    if (e.target === panel()) { cerrar(); return; }   // tocar fuera de la tarjeta
    const b = e.target.closest('[data-cd], #cd-close'); if (!b) return;
    if (b.id === 'cd-close') { cerrar(); return; }
    if (b.disabled || st.busy) return;
    const act = b.dataset.cd, id = st.id, d = st.data || {};
    if (act === 'aplicar') {
      st.busy = true; b.disabled = true; b.textContent = 'Publicando…';
      let r;
      try { r = await Api.cadenaAplicar(id); }
      catch (err) { st.busy = false; b.disabled = false; b.textContent = 'Reintentar'; say((err && err.message) || 'No se pudo publicar.'); return; }
      if (r && r.ok) {
        const V2 = window.RendioRutasV2;
        try { if (V2 && typeof V2.reflejar === 'function') V2.reflejar(r.route || d.route, r.profile_id); } catch (err) { /* el tablero se pone al día al recargar */ }
        cerrar();
        say(`Listo: ${corto(r.name) || 'el recomendado'} hace esa vuelta. Ya les avisamos.`);
      } else {
        say((r && r.motivo) || 'No se pudo.');
        await abrir(id);   // ya no aplica: se repinta con lo de ahora
      }
      return;
    }
    if (act === 'descartar') {
      try { await Api.cadenaDescartar(id); } catch (err) { say((err && err.message) || 'No se pudo descartar.'); return; }
      cerrar(); say('Descartada: no te volvemos a avisar de esa vuelta con ese conductor.');
      return;
    }
    if (act === 'opciones') {
      const route = d.route, dia = d.ahora && d.ahora.dia, hora = hm(d.need_at);
      cerrar();
      otrasOpciones(route, dia, hora);
      return;
    }
    if (act === 'apagar') {
      const on = d.activa === false;
      if (!on && typeof window.confirm === 'function'
          && !window.confirm('¿Apagar las recomendaciones de «no alcanza»? Dejan de llegar estos avisos hasta que las vuelvas a encender desde una de estas tarjetas.')) return;
      try { await Api.cadenaEncender(on); } catch (err) { say((err && err.message) || 'No se pudo.'); return; }
      if (st.data) st.data.activa = on;
      say(on ? 'Recomendaciones encendidas.' : 'Recomendaciones apagadas.');
      pintarDatos();
    }
  }

  window.RendioCadena = { abrir, cerrar, _st: st };
})();
