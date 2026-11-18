// chat-turno.js — la pantalla del chat del turno (0173, 17-nov-2026).
// Harold: «un chat donde desde el sistema nos podamos comunicar con los conductores…
// un chat grupal que se limpie cada que cambian de turno».
//
// UNA sola pantalla para las dos puntas:
//   · Conductor → pestaña «Chat» de Mi día (driver-rutas.js) y fila en Inicio (driver-tabs.js).
//   · Jefe      → «Chat» en Operación (admin-operacion.js): pestaña en el teléfono,
//                 columna derecha (Actividad | Chat) en el computador.
//
//   window.ChatTurno = {
//     montar(host, { rol }), desmontar(), montado(),
//     resumen(), refrescarResumen(), alCambiar(fn),   // globo de «sin leer» y último mensaje
//     pedirAbrir(), tomarPedido(),                    // el aviso (push) que abre el chat
//   }
//
// Nada inventado: si la base no tiene 0173, resumen().falta === true y nadie muestra
// el chat. El hilo se vuelve a leer cada 5 s mientras está a la vista (no hay Realtime
// en el proyecto; el aviso de verdad es el push). El campo de escribir NO se repinta
// nunca: lo que se va escribiendo no se pierde con cada lectura.
(function () {
  'use strict';

  const A = () => (typeof window !== 'undefined' && window.ApiChatTurno) || null;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const BANDA = { am: 'mañana', pm: 'tarde' };
  // Respuestas de un toque para el conductor (va manejando).
  const RAPIDAS = ['Recibido', 'Ya estoy en JMC', 'Terminé, ¿cuál sigue?', 'Voy tarde'];
  const IC_SEND = '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>';
  const IC_CHEV = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
  const IC_CHAT = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>';
  const IC_BACK = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>';

  const hm = (iso) => {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: 'numeric', minute: '2-digit', hour12: true })
        .replace(/[  ]/g, ' ').replace(/\s*a\.?\s?m\.?$/i, ' a. m.').replace(/\s*p\.?\s?m\.?$/i, ' p. m.');
    } catch (_) { return ''; }
  };
  // «Lun 16 nov»: armado a mano (cada navegador escribe distinto la fecha corta en español).
  const DIAS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'], MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const diaTxt = (day) => {
    const d = new Date(String(day || '').slice(0, 10) + 'T12:00:00Z');
    return isNaN(d.getTime()) ? String(day || '') : DIAS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MESES[d.getUTCMonth()];
  };
  const lista = (a) => (a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' y ' + a[a.length - 1]);

  // ── El resumen (globo y último mensaje) ──────────────────────────────────────
  // falta: null = todavía no se sabe · true = la base no tiene el chat · false = sí.
  const R = { v: { falta: null, member: false, n: 0, last: null, band: null, error: null }, oyentes: new Set(), timer: null, ocupado: false };
  const avisar = () => { R.oyentes.forEach((fn) => { try { fn(R.v); } catch (_) { /* un oyente roto no tumba a los demás */ } }); };
  async function refrescarResumen() {
    const api = A();
    if (!api) { R.v = Object.assign({}, R.v, { falta: true }); avisar(); return R.v; }
    if (R.ocupado) return R.v;
    R.ocupado = true;
    try {
      const r = await api.resumen();
      if (r.falta) R.v = { falta: true, member: false, n: 0, last: null, band: null, error: null };
      else if (r.error) R.v = Object.assign({}, R.v, { error: r.error });   // se queda con lo último que supo
      else R.v = { falta: false, member: r.member, n: r.n, last: r.last, band: r.band, error: null };
    } catch (_) { /* sin red: se queda con lo último */ } finally { R.ocupado = false; }
    avisar();
    return R.v;
  }
  function alCambiar(fn) {
    if (typeof fn !== 'function') return () => {};
    R.oyentes.add(fn);
    if (!R.timer && typeof setInterval === 'function') {
      R.timer = setInterval(() => { if (!R.oyentes.size || (typeof document !== 'undefined' && document.hidden)) return; refrescarResumen(); }, 30000);
    }
    return () => { R.oyentes.delete(fn); if (!R.oyentes.size && R.timer) { clearInterval(R.timer); R.timer = null; } };
  }

  // ── El hilo ──────────────────────────────────────────────────────────────────
  const S = {
    host: null, rol: 'driver', data: null, ahora: null, estado: 'cargando', error: '',
    draft: '', timer: null, ocupado: false, enviando: false, tmp: [],
    firma: null, firmaTop: null, bajar: false, vistos: new Set(), leidoAbierto: null,
    hist: null, histAbierto: false, viendo: null,
  };
  const vivo = () => !!(S.host && typeof document !== 'undefined' && document.contains(S.host));
  // ¿El chat está de verdad a la vista? Si el jefe pasó a otra pantalla o a otra
  // pestaña del teléfono, no se lee ni se marca «leído» nada (sería mentira).
  function aLaVista() {
    if (!vivo() || document.hidden) return false;
    if (!document.documentElement.clientWidth) return true;   // sin motor de diseño (las pruebas)
    if (!S.host.getClientRects().length) return false;        // display:none en algún padre
    try { return window.getComputedStyle(S.host).visibility !== 'hidden'; } catch (_) { return true; }
  }
  const q = (sel) => (S.host ? S.host.querySelector(sel) : null);

  function armazon() {
    return '<div class="ct ct--' + (S.rol === 'admin' ? 'adm' : 'drv') + '">'
      + '<div class="ct-top" data-ct-top hidden></div>'
      + '<div class="ct-msgs" data-ct-msgs aria-live="polite"></div>'
      + '<div class="ct-qr" data-ct-qr hidden>' + RAPIDAS.map((t) => '<button type="button" data-ct="rapida">' + esc(t) + '</button>').join('') + '</div>'
      + '<div class="ct-foot" data-ct-foot hidden>'
      + '<textarea data-ct-in rows="1" maxlength="500" autocomplete="off" enterkeyhint="send" aria-label="Escribir en el chat del turno"></textarea>'
      + '<button type="button" class="ct-send" data-ct="enviar" aria-label="Enviar" disabled>' + IC_SEND + '</button>'
      + '</div></div>';
  }

  // Quiénes están: una frase para el conductor, cajitas para el jefe.
  function topHTML() {
    const d = S.data;
    if (S.histAbierto) return '<button type="button" class="ct-volver" data-ct="volver">' + IC_BACK + 'Volver al chat</button><b class="ct-tit">Turnos anteriores</b>';
    if (S.viendo) return '<button type="button" class="ct-volver" data-ct="volver">' + IC_BACK + 'Turno de ahora</button><b class="ct-tit">' + esc(diaTxt(S.viendo.day) + ' · ' + (BANDA[S.viendo.band] || '')) + '</b>';
    if (S.estado !== 'ok' || !d) return S.rol === 'admin' && S.estado !== 'falta' ? '<span class="ct-nadie"></span><button type="button" class="ct-link" data-ct="hist">Turnos anteriores</button>' : '';
    if (S.rol === 'admin') {
      const cajas = d.drivers.length
        ? d.drivers.map((p) => '<span class="ct-chip"><i></i>' + esc(p.name) + '</span>').join('')
        : '<span class="ct-nadie">No hay conductores en turno ahora.</span>';
      return '<div class="ct-chips">' + cajas + '</div><button type="button" class="ct-link" data-ct="hist">Turnos anteriores</button>';
    }
    const jefes = d.admins.filter((p) => p.id !== d.me).map((p) => '<b>' + esc(p.name) + '</b>');
    const comp = d.drivers.filter((p) => p.id !== d.me).map((p) => '<b>' + esc(p.name) + '</b>');
    const partes = [];
    if (jefes.length) partes.push(lista(jefes) + (jefes.length === 1 ? ' (jefe)' : ' (jefes)'));
    comp.forEach((c) => partes.push(c));
    partes.push('tú');
    return '<p class="ct-quienes">En este chat: ' + lista(partes) + '</p>';
  }

  // «Leído por 2 de 2» (jefe): cuántos conductores del turno ya lo leyeron; al tocarlo, quiénes.
  function leidoJefe(m, d) {
    const n = d.drivers.length;
    if (!n) return { pie: m.readAny ? 'Leído' : 'Enviado', extra: '' };
    const pie = '<button type="button" class="ct-leido" data-ct="leido" data-id="' + esc(m.id) + '" aria-expanded="' + (S.leidoAbierto === m.id) + '">Leído por ' + m.readDrivers + ' de ' + n + '</button>';
    if (S.leidoAbierto !== m.id) return { pie, extra: '' };
    const si = d.drivers.filter((p) => m.readIds.includes(p.id)).map((p) => p.name);
    const no = d.drivers.filter((p) => !m.readIds.includes(p.id)).map((p) => p.name);
    const extra = '<span class="ct-quien">' + esc((si.length ? 'Lo leyó ' + lista(si) + '.' : 'Nadie lo ha leído.') + (no.length ? ' Falta ' + lista(no) + '.' : '')) + '</span>';
    return { pie, extra };
  }

  function burbuja(m, prev, d) {
    const mio = m.mine === true;
    const racha = prev && prev.senderId === m.senderId;   // misma persona seguida: el nombre va una vez
    const quien = !mio && !racha
      ? '<b class="ct-by">' + esc(m.sender || (m.role === 'admin' ? 'Jefe' : 'Conductor')) + (m.role === 'admin' ? '<em>JEFE</em>' : '') + '</b>' : '';
    let pie = esc(hm(m.at)), extra = '';
    if (m.fallo) pie = 'No se envió' + (m.error ? ': ' + esc(m.error) : '');
    else if (m.tmp && !m.id) pie = 'Enviando…';
    else if (mio && S.rol === 'admin' && !m.tmp) { const l = leidoJefe(m, d); pie += ' · ' + l.pie; extra = l.extra; }
    else if (mio) pie += '<i class="ct-ck' + (m.readAny ? ' leido' : '') + '" aria-label="' + (m.readAny ? 'Leído' : 'Enviado') + '">' + (m.readAny ? '✓✓' : '✓') + '</i>';
    return '<div class="ct-b ' + (mio ? 'out' : 'in') + (m.tmp ? ' tmp' : '') + (m.fallo ? ' fallo' : '') + '" data-mid="' + esc(m.id || m.key) + '">'
      + quien + '<p>' + esc(m.body) + '</p><small>' + pie + '</small>' + extra + '</div>';
  }

  function vacio(titulo, texto, boton) {
    return '<div class="ct-empty">' + (titulo ? '<b>' + esc(titulo) + '</b>' : '') + (texto ? '<span>' + esc(texto) + '</span>' : '')
      + (boton ? '<button type="button" data-ct="reintentar">' + esc(boton) + '</button>' : '') + '</div>';
  }

  function cuerpoHTML() {
    const d = S.data;
    if (S.estado === 'falta') return vacio('El chat del turno todavía no está disponible', '');
    if (S.estado === 'fuera') return vacio('El chat es de quienes están en turno', 'Entras solo cuando empiece tu turno o cuando lo inicies.');
    if (S.estado === 'sin') return vacio('Este chat es de los jefes y los conductores', '');
    if (S.estado === 'error' && !d) return vacio('No se pudo cargar el chat', S.error || 'Revisa la señal y vuelve a intentar.', 'Reintentar');
    if (!d) return vacio('', 'Cargando el chat…');
    const sep = '<div class="ct-sep">' + esc(S.viendo
      ? diaTxt(d.day) + ' · turno de la ' + (BANDA[d.band] || '')
      : 'Turno de la ' + (BANDA[d.band] || '') + (d.since ? ' · desde las ' + hm(d.since) : '')) + '</div>';
    const pend = S.viendo ? [] : S.tmp.filter((t) => !t.id || !d.messages.some((m) => m.id === t.id));
    const todos = d.messages.concat(pend);
    if (!todos.length) {
      return sep + vacio(S.viendo ? 'En ese turno no se escribió nada' : 'Todavía no hay mensajes en este turno',
        S.viendo ? '' : 'Lo que se escriba aquí lo ven los jefes y los conductores que están en turno.');
    }
    return sep + todos.map((m, i) => burbuja(m, todos[i - 1], d)).join('');
  }

  function histHTML() {
    if (S.hist === null) return vacio('', 'Cargando los turnos anteriores…');
    if (!S.hist.length) return vacio('Todavía no hay turnos anteriores', 'Aquí queda cada turno cuando termina.');
    return '<div class="ct-hist">' + S.hist.map((h) => '<button type="button" class="ct-hrow" data-ct="turno" data-day="' + esc(h.day) + '" data-band="' + esc(h.band) + '">'
      + '<span><b>' + esc(diaTxt(h.day) + ' · ' + (BANDA[h.band] || '')) + '</b><small>' + h.n + (h.n === 1 ? ' mensaje' : ' mensajes') + (h.lastAt ? ' · el último a las ' + esc(hm(h.lastAt)) : '') + '</small></span>'
      + IC_CHEV + '</button>').join('') + '</div>';
  }

  function ajustarCampo() {
    const i = q('[data-ct-in]'); if (!i) return;
    i.style.height = 'auto';
    const alto = Math.min(120, i.scrollHeight || 0);
    if (alto) i.style.height = alto + 'px';
  }

  function pintar() {
    if (!vivo()) return;
    const top = q('[data-ct-top]'), box = q('[data-ct-msgs]'), qr = q('[data-ct-qr]'), foot = q('[data-ct-foot]'), inp = q('[data-ct-in]'), btn = q('[data-ct="enviar"]');
    if (!box) return;
    const d = S.data;
    const puede = S.estado === 'ok' && !!d && d.canWrite && !S.viendo && !S.histAbierto;
    // ¿Estaba abajo? Se mira ANTES de mover nada: al aparecer el campo de escribir el
    // hilo se encoge, y si se baja primero el último mensaje queda tapado.
    const abajo = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
    const t = topHTML();
    if (t !== S.firmaTop) { top.innerHTML = t; S.firmaTop = t; }
    top.hidden = !t;
    qr.hidden = !(puede && S.rol === 'driver');
    foot.hidden = !puede;
    if (puede) {
      inp.placeholder = S.rol === 'admin' ? 'Escribe al turno…' : 'Escribe al equipo del turno';
      if (inp.value !== S.draft && (typeof document === 'undefined' || document.activeElement !== inp)) { inp.value = S.draft; ajustarCampo(); }
      btn.disabled = !S.draft.trim() || S.enviando;
    }
    const h = S.histAbierto ? histHTML() : cuerpoHTML();
    if (h !== S.firma) {
      const primera = S.firma === null;
      box.innerHTML = h; S.firma = h;
      if (S.histAbierto) box.scrollTop = 0;
      else if (primera || abajo || S.bajar) box.scrollTop = box.scrollHeight;
      S.bajar = false;
    } else if (abajo && !S.histAbierto) box.scrollTop = box.scrollHeight;   // el hilo cambió de alto: sigue abajo
  }

  // Lo nuevo de los demás, a la vista = leído.
  function leerNuevos() {
    const d = S.data; if (!d || !d.current) return;
    const nuevos = d.messages.filter((m) => !m.mine && !S.vistos.has(m.id));
    if (!nuevos.length) return;
    nuevos.forEach((m) => S.vistos.add(m.id));
    const api = A(); if (!api) return;
    Promise.resolve(api.marcarLeido()).then(() => { if (R.v.n) { R.v = Object.assign({}, R.v, { n: 0 }); avisar(); } }, () => {});
  }

  async function cargar(silencio) {
    const api = A();
    if (!api || S.ocupado) return;
    S.ocupado = true;
    const pide = S.viendo;
    let r = null;
    try { r = pide ? await api.leer(pide.day, pide.band) : await api.leer(); }
    catch (e) { r = { error: (e && e.message) || 'Revisa la señal y vuelve a intentar.' }; }
    finally { S.ocupado = false; }
    if (pide !== S.viendo) return;   // cambió de turno mientras leía
    if (r.falta) { S.estado = 'falta'; S.data = null; }
    else if (r.error) { if (!S.data || !silencio) { S.estado = 'error'; S.error = r.error; } }
    else if (r.ok === false) { S.estado = r.reason === 'fuera_de_turno' ? 'fuera' : 'sin'; S.data = null; }
    else {
      // Cambió el turno: el chat arranca limpio.
      if (S.data && !pide && (S.data.day !== r.day || S.data.band !== r.band)) { S.vistos = new Set(); S.tmp = []; S.leidoAbierto = null; }
      S.data = r; S.estado = 'ok';
      if (!pide) { S.ahora = r; S.tmp = S.tmp.filter((x) => x.fallo || !x.id || !r.messages.some((m) => m.id === x.id)); }
    }
    pintar();
    if (S.estado === 'ok' && !pide && aLaVista()) leerNuevos();
  }

  async function enviar(texto) {
    const body = String(texto || '').trim();
    const api = A(), d = S.data;
    if (!body || !api || S.enviando || !d || !d.canWrite || S.viendo) return;
    S.enviando = true;
    const tmp = { key: 'tmp-' + Date.now(), tmp: true, mine: true, body, at: new Date().toISOString(), senderId: d.me, role: d.role, sender: '', readAny: false, readDrivers: 0, readIds: [], readNames: [] };
    S.tmp.push(tmp);
    const delCampo = S.draft.trim() === body;
    if (delCampo) { S.draft = ''; const i = q('[data-ct-in]'); if (i) { i.value = ''; ajustarCampo(); } }
    S.bajar = true; pintar();
    try { const r = await api.enviar(body); tmp.id = r.id || null; if (!tmp.id) tmp.id = tmp.key; }
    catch (e) {
      tmp.fallo = true; tmp.error = (e && e.message) || '';
      // Lo escrito vuelve al campo para reintentar (si no escribió otra cosa mientras tanto).
      if (delCampo && !S.draft) { S.draft = body; const i = q('[data-ct-in]'); if (i) { i.value = body; ajustarCampo(); } }
      setTimeout(() => { S.tmp = S.tmp.filter((x) => x !== tmp); pintar(); }, 7000);
    } finally { S.enviando = false; }
    S.bajar = true; pintar();
    if (!tmp.fallo) { await cargar(true); refrescarResumen(); }
  }

  async function abrirHist() {
    S.histAbierto = true; S.viendo = null; pintar();
    const api = A();
    const h = api ? await api.historial() : null;
    if (!vivo() || !S.histAbierto) return;
    S.hist = h || [];
    pintar();
  }
  function verTurno(day, band) {
    if (!day || !band) return;
    S.viendo = { day, band }; S.histAbierto = false; S.data = null; S.estado = 'cargando'; S.firma = null;
    pintar(); cargar(false);
  }
  function volver() {
    if (S.viendo) { S.viendo = null; S.data = S.ahora || null; S.estado = S.data ? 'ok' : 'cargando'; }
    S.histAbierto = false; S.firma = null;
    pintar(); cargar(true);
  }

  // En el teléfono del conductor el chat ocupa lo que queda de la pantalla (y se
  // encoge con el teclado): el campo de escribir siempre queda a la vista.
  function medir() {
    if (!vivo() || S.rol !== 'driver') return;
    const vv = typeof window !== 'undefined' && window.visualViewport;
    const alto = (vv && vv.height) || window.innerHeight || 700;
    const top = S.host.getBoundingClientRect().top;
    const barra = document.querySelector('#driver-ruta-ui .rt-nowbar');
    const resta = barra ? (barra.offsetHeight || 0) + 14 : 0;
    S.host.style.setProperty('--ct-h', Math.max(300, Math.round(alto - top - 14 - resta)) + 'px');
  }

  function alClic(e) {
    const b = e.target && e.target.closest ? e.target.closest('[data-ct]') : null;
    if (!b || !vivo() || !S.host.contains(b)) return;
    const a = b.dataset.ct;
    if (a === 'enviar') { const i = q('[data-ct-in]'); enviar(i ? i.value : S.draft); }
    else if (a === 'rapida') enviar(b.textContent);
    else if (a === 'leido') { S.leidoAbierto = S.leidoAbierto === b.dataset.id ? null : b.dataset.id; pintar(); }
    else if (a === 'hist') abrirHist();
    else if (a === 'turno') verTurno(b.dataset.day, b.dataset.band);
    else if (a === 'volver') volver();
    else if (a === 'reintentar') { S.estado = 'cargando'; S.error = ''; pintar(); cargar(false); }
  }
  function alEscribir(e) {
    if (!e.target || !e.target.matches || !e.target.matches('[data-ct-in]')) return;
    S.draft = e.target.value;
    ajustarCampo();
    const btn = q('[data-ct="enviar"]'); if (btn) btn.disabled = !S.draft.trim() || S.enviando;
  }
  function alTecla(e) {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || !e.target || !e.target.matches || !e.target.matches('[data-ct-in]')) return;
    e.preventDefault();
    enviar(e.target.value);
  }

  function desmontar() {
    if (S.timer) { clearInterval(S.timer); S.timer = null; }
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', medir);
      if (window.visualViewport) window.visualViewport.removeEventListener('resize', medir);
    }
    if (S.host) {
      S.host.removeEventListener('click', alClic);
      S.host.removeEventListener('input', alEscribir);
      S.host.removeEventListener('keydown', alTecla);
    }
    S.host = null;
  }

  function montar(host, opts) {
    if (!host) return false;
    desmontar();
    S.host = host;
    S.rol = opts && opts.rol === 'admin' ? 'admin' : 'driver';
    S.viendo = null; S.histAbierto = false; S.firma = null; S.firmaTop = null;
    S.data = S.ahora; S.estado = S.data ? 'ok' : 'cargando';
    host.innerHTML = armazon();
    host.addEventListener('click', alClic);
    host.addEventListener('input', alEscribir);
    host.addEventListener('keydown', alTecla);
    window.addEventListener('resize', medir);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', medir);
    medir();
    pintar();
    cargar(false);
    S.timer = setInterval(() => {
      if (!vivo()) { desmontar(); return; }
      if (!aLaVista() || S.viendo || S.histAbierto) return;
      medir();
      cargar(true);
    }, 5000);
    return true;
  }

  // ── Inicio del conductor: la fila «Chat del turno» ───────────────────────────
  // Solo si está en turno (el chat es del turno). Dice el último mensaje y cuántos
  // hay sin leer; al tocarla abre Mi día en la pestaña del chat.
  const F = { box: null, firma: null, deja: null, abrir: null };
  function pintarFila(v) {
    const box = F.box;
    if (!box || typeof document === 'undefined' || !document.contains(box)) return;
    let h = '';
    if (v && v.falta === false && v.member) {
      const l = v.last;
      const texto = l ? (l.mine ? 'Tú: ' : (l.sender ? l.sender + ': ' : '')) + l.body : 'Escríbeles a los jefes y a tus compañeros de turno.';
      h = '<button type="button" class="rc-link-row rc-chat-row rc-in d2" data-chat-turno style="margin:14px 0 6px">'
        + '<span class="rc-link-ic" style="background:var(--r-accent-soft);color:var(--r-accent)">' + IC_CHAT + '</span>'
        + '<span class="t"><b>Chat del turno</b><span>' + esc(texto) + '</span></span>'
        + (v.n ? '<i class="ct-n" aria-label="' + v.n + ' sin leer">' + (v.n > 9 ? '9+' : v.n) + '</i>' : '')
        + '<span class="rc-link-chev">' + IC_CHEV + '</span></button>';
    }
    if (h !== F.firma) { box.innerHTML = h; F.firma = h; }
  }
  function filaInicio(box, abrir) {
    if (!box) return;
    F.abrir = abrir;
    if (F.box !== box) {
      F.box = box; F.firma = null;
      box.addEventListener('click', (e) => { if (e.target && e.target.closest && e.target.closest('[data-chat-turno]') && typeof F.abrir === 'function') F.abrir(); });
    }
    if (!F.deja) F.deja = alCambiar(pintarFila);
    pintarFila(R.v);
    refrescarResumen();
  }

  // El aviso (push) pide abrir el chat; la pantalla que lo aloja lo recoge al pintarse.
  let pedido = false;

  window.ChatTurno = {
    montar, desmontar, montado: vivo,
    resumen: () => R.v, refrescarResumen, alCambiar, filaInicio,
    pedirAbrir: () => { pedido = true; },
    tomarPedido: () => { const p = pedido; pedido = false; return p; },
    // Para las pruebas.
    _estado: () => S, _hm: hm, _leer: (silencio) => cargar(silencio !== false),
  };
})();
