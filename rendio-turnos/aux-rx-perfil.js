// aux-rx-perfil.js — P7 · Perfil del tripulante (rediseño del auxiliar, 27-sep-2026).
//
// Porta RxMe de rx-me.jsx (entrega del diseñador 2026-09-27): mismo marcado y
// mismas clases (rx-me-hero, rx-me-stats, rx-lbl, rx-group, rx-row, rx-seg,
// rx-sh), mismas entradas escalonadas (.rx-in con --d 1·2·3) y los mismos
// contadores (RxCount: 800 ms desde 0, 1−(1−k)³). Registra en AuxShell:
//   · 'me'        la pestaña Perfil (plan final §3.10);
//   · 'residence' la pila «Mi residencia» (#27), con ESTADO PROPIO: nunca toca
//                 Auxiliar.state.form. Guarda con Api.saveMyResidence. Pinta la
//                 pantalla de P5 (AuxResidencias.pickerScreenHTML, que usa
//                 pickerHTML({mode:'perfil'})) y, si no existe, un selector propio.
// Acciones data-rx propias: me-level, pref-level (reemplaza la de P6, que lo
// permite), me-meet, me-meet-save, me-pwa, me-push, me-res-pick, me-res-save,
// me-res-retry. Campos: data-rx-field="meetingPoint" y "me-res-q".
//
// Lo que cambia respecto al diseño, por decisión (plan §1.6 / AJUSTES §4):
//   · «Coordinación» sin «24/7» ni «a cualquier hora»: el subtítulo es el horario
//     de Ajustes si está cargado; si no, «Escríbele a la operación» (D11).
//   · Pagos, Puntos e Invitar dicen «Todavía no disponible» mientras no existan
//     (AuxPagos.summary() null / AuxPuntos.enabled() falso). Puntos e Invitar,
//     además, sin flecha y sin acción, con la etiqueta «Pronto».
//   · Las cifras salen de ApiAux.getMyStats(); sin dato, «—» y «aún sin datos».
//     La tercera cifra (puntos) solo existe con Puntos encendido: la cuadrícula
//     es de 2.
//   · Select sin «kit de confort» (D3).
//   · Filas nuevas que el diseño no trae y el plan sí: Punto de encuentro,
//     Teléfono, Notificaciones y app (su hoja lleva #ax-pwa-bar: la base no
//     puede llevar ids de §2.4, regla #10), Ver la bienvenida, Algo no va bien
//     y Cambiar mi contraseña (solo si existe openCambiarMiClave).
//
// Apariencia: los botones del segmentado llevan data-ax="theme" (la acción de
// siempre: AuxPresentacion.setThemePref + auxRender). Como la pantalla sigue
// arriba, el shell llama a patch(): aquí se mueve el indicador con segSet (su
// transición de .35 s corre, como en React) y se cambia el subtítulo, sin
// repintar la pestaña.
(function () {
  'use strict';

  const UI = () => window.AuxRxUI;
  const SH = () => window.AuxShell;
  const AX = () => window.Auxiliar;
  const HDR = () => { const a = AX(); return (a && a.header) || null; };
  const STATE = () => { const a = AX(); return (a && a.state) || {}; };
  const esc = (s) => (UI() ? UI().esc(s) : String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'));
  const ic = (n, s, cls, style) => (UI() ? UI().ic(n, s, cls, style) : '');

  // Estado propio del módulo (no es el del pedido).
  const st = {
    stats: undefined,   // undefined = cargando · null = sin dato · {done, onTimePct, …}
    statsReq: 0,
    ops: undefined,     // {phone, hours} de ApiAux.getOpsContact (undefined = sin pedir)
    meHost: null,       // .rx-scrhost de la pestaña montada
    levelBusy: false,
    meetBusy: false,
    pwa: undefined,     // 'on' | 'off' | 'blocked' | 'na' (undefined = sin mirar todavía)
  };
  // Pila «Mi residencia».
  const R = {
    cat: null, loading: false, failed: false,
    q: '', saving: false, host: null,
  };

  // ── Datos ─────────────────────────────────────────────────────────────────
  const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  function sinceText(v) {
    if (!v) return '';
    const day = UI() ? UI().bogDay(v) : String(v).slice(0, 10);
    const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(day || '');
    if (!m) return '';
    const mi = Number(m[2]) - 1;
    return MESES[mi] ? MESES[mi] + ' ' + m[1] : '';
  }
  // «Auxiliar · Avianca · desde mar 2026» — lo vacío se omite.
  function heroLine() {
    const h = HDR();
    const since = h ? sinceText(h.joinedAt) : '';
    return ['Auxiliar', h && h.airlineName ? h.airlineName : '', since ? 'desde ' + since : ''].filter(Boolean).join(' · ');
  }
  function phoneText(p) {
    const raw = String(p || '').trim();
    if (!raw) return '';
    const d = raw.replace(/\D/g, '');
    if (d.length === 10) return d.slice(0, 3) + ' ' + d.slice(3, 6) + ' ' + d.slice(6);
    return raw;
  }
  function resText(r, unit) {
    if (!r) return '';
    return [r.name, unit].filter(Boolean).join(' · ');
  }
  const LEVELS = {
    shared: { ic: 'Users', tone: 'a2h', name: 'Compartido', toast: 'Compartido' },
    private: { ic: 'Sparkle', tone: 'plus', name: 'Privado · Select', toast: 'Privado' },
  };
  function levelMeta(v) {
    return LEVELS[v] || { ic: 'Users', tone: 'n', name: 'Sin elegir', toast: '' };
  }
  function normLevel(v) {
    const s = String(v || '').toLowerCase();
    if (s === 'shared' || s === 'compartido') return 'shared';
    if (s === 'private' || s === 'privado' || s === 'select') return 'private';
    return null;
  }
  function privEnabled() {
    try { return !!(window.AuxPrivado && typeof AuxPrivado.enabled === 'function' && AuxPrivado.enabled()); }
    catch (_) { return false; }
  }
  function paySummary() {
    try { return window.AuxPagos && typeof AuxPagos.summary === 'function' ? (AuxPagos.summary() || null) : null; }
    catch (_) { return null; }
  }
  const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('es-CO');
  function payRow() {
    const s = paySummary();
    if (!s) return { sub: 'Todavía no disponible', tone: 'n' };
    const status = s.status || '';
    let sub;
    if (status === 'pagado') sub = s.label || 'Al día';
    else if (status === 'review') sub = 'Comprobante en revisión';
    else {
      const lbl = String(s.label || '').toLowerCase();
      sub = [s.amountCOP != null ? money(s.amountCOP) : '', lbl].filter(Boolean).join(' · ') || 'Todavía no disponible';
    }
    return { sub, tone: status === 'bloqueado' || status === 'vencido' ? 'err' : 'n' };
  }
  function pointsOn() {
    try { return !!(window.AuxPuntos && typeof AuxPuntos.enabled === 'function' && AuxPuntos.enabled()); }
    catch (_) { return false; }
  }
  function pointsSummary() {
    try { return pointsOn() && typeof AuxPuntos.summary === 'function' ? (AuxPuntos.summary() || null) : null; }
    catch (_) { return null; }
  }
  function themePref() {
    try { return (window.AuxPresentacion && AuxPresentacion.themePref && AuxPresentacion.themePref()) || 'auto'; }
    catch (_) { return 'auto'; }
  }
  function themeSub(m) {
    return m === 'auto' ? 'Nocturno de 7:00 p. m. a 6:00 a. m.' : m === 'night' ? 'Nocturno' : 'Claro';
  }
  function opsHours() {
    const fromOps = st.ops && st.ops.hours ? String(st.ops.hours).trim() : '';
    if (fromOps) return fromOps;
    try {
      // eslint-disable-next-line no-undef
      const s = (typeof state !== 'undefined' && state && state.settings) || (window.state && window.state.settings) || {};
      return String(s.ops_contact_hours || '').trim();
    } catch (_) { return ''; }
  }
  function canChangePw() {
    // eslint-disable-next-line no-undef
    try { return typeof openCambiarMiClave === 'function'; } catch (_) { return false; }
  }

  // ── Notificaciones e instalar (#ax-pwa-bar) ──────────────────────────────
  // Regla #10 del plan final (y el control de AuxShell): la base (pestañas)
  // nunca lleva los ids de §2.4, y #ax-pwa-bar es uno. Por eso la barra vive en
  // la HOJA «Notificaciones y app» (la hoja sí puede llevarlos) y en Perfil
  // queda una fila con el estado. Adentro todo es lo de siempre: id
  // #ax-pwa-bar, data-ax="enable-push" / "install" y Auxiliar.setupPwa()
  // (auxSetupPwa) decide qué botón se ve. Si la integración exime a
  // #ax-pwa-bar de la regla, PWA_EN_HOJA = false la pone en la lista.
  const PWA_EN_HOJA = true;
  function pwaBarHTML(inSheet) {
    const U = UI();
    return `<div id="ax-pwa-bar" class="rx-me-pwa${inSheet ? ' rx-group' : ''} hidden">`
      + U.row({ icon: 'Bell', tone: 'info', title: 'Activar notificaciones', sub: 'Te avisamos cuando te asignen conductor y cuando esté por llegar', cls: 'hidden', attrs: { 'data-ax': 'enable-push' } })
      + U.row({ icon: 'Plus', tone: 'n', title: 'Instalar la app', sub: 'Queda en tu pantalla de inicio', cls: 'hidden', attrs: { 'data-ax': 'install' } })
      + '</div>';
  }
  function pwaSub() {
    const s = st.pwa;
    const ins = !!window.rendioInstall;
    const base = s === 'on' ? 'Activas'
      : s === 'off' ? 'Actívalas para saber cuándo llega tu conductor'
      : s === 'blocked' ? 'Bloqueadas en los ajustes del teléfono'
      : s === 'na' ? 'No disponibles en este navegador'
      : 'Los avisos de tu traslado';
    return ins && s !== 'off' ? base + ' · puedes instalar la app' : base;
  }
  // El mismo criterio de auxSetupPwa, como dato (para el subtítulo de la fila).
  async function pwaCheck() {
    let s;
    try {
      // eslint-disable-next-line no-undef
      const sup = typeof pushSupported === 'function' && pushSupported();
      if (!sup) s = 'na';
      else if (typeof Notification !== 'undefined' && Notification.permission === 'denied') s = 'blocked';
      else {
        const reg = await Promise.race([navigator.serviceWorker.ready, new Promise(r => setTimeout(() => r(null), 3000))]);
        if (reg && reg.pushManager) s = (await reg.pushManager.getSubscription()) ? 'on' : 'off';
      }
    } catch (_) { s = 'na'; }
    if (s === undefined || s === st.pwa) return;
    st.pwa = s;
    refreshMe();
  }
  function pwaSheetHTML() {
    return `<div class="rx-sh">
      <h3>Notificaciones y app</h3>
      <p>Con las notificaciones activas te avisamos cuando te asignen conductor y cuando esté por llegar.</p>
      ${pwaBarHTML(true)}
      <div class="rx-note" data-me-pwa-none hidden>${ic('Info', 15)}<span data-me-pwa-txt></span></div>
      ${UI().btn('Listo', { kind: 'ghost', attrs: { 'data-rx': 'sheet-close' } })}
    </div>`;
  }
  function pwaNoneText() {
    return st.pwa === 'on' ? 'Las notificaciones ya están activas en este teléfono.'
      : st.pwa === 'blocked' ? 'Las notificaciones están bloqueadas. Actívalas desde los ajustes del teléfono para esta app.'
      : 'Este navegador no deja activar las notificaciones desde aquí. Si instalas la app en tu pantalla de inicio, se pueden activar.';
  }
  function openPwa() {
    if (!SH()) return;
    SH().sheet(pwaSheetHTML(), {
      onClose: () => { pwaCheck(); },
      after(sh) {
        const sync = () => {
          const bar = sh.querySelector('#ax-pwa-bar');
          const none = sh.querySelector('[data-me-pwa-none]');
          if (!bar || !none) return;
          const empty = bar.classList.contains('hidden');
          none.hidden = !empty;
          const txt = none.querySelector('[data-me-pwa-txt]');
          if (txt) txt.textContent = empty ? pwaNoneText() : '';
        };
        let p = null;
        try { p = AX() && typeof AX().setupPwa === 'function' ? AX().setupPwa() : null; } catch (_) { p = null; }
        Promise.resolve(p).catch(() => null).then(() => pwaCheck()).then(sync);
        // Tras «Activar», auxiliar.js vuelve a llamar a auxSetupPwa: se mira otra vez.
        sh.addEventListener('click', (e) => {
          if (e.target && e.target.closest && e.target.closest('[data-ax="enable-push"]')) {
            [1500, 4000, 9000].forEach(ms => setTimeout(() => { if (sh.isConnected) { pwaCheck(); sync(); } }, ms));
          }
        });
      },
    });
  }

  // ── Perfil (me) ───────────────────────────────────────────────────────────
  // Celda de cifra. data-v: 'L' cargando · 'N' sin dato · el número.
  function statCell(key, v, label, o) {
    o = o || {};
    const loading = v === 'L', none = v === 'N';
    const val = loading || none ? '—' : String(v) + (o.suffix || '');
    return `<div data-me="${key}" data-v="${esc(v)}"><b${o.cls ? ` class="${o.cls}"` : ''}>${esc(val)}</b><span>${esc(label)}</span>`
      + (none ? '<em class="rx-me-nodata">aún sin datos</em>' : '') + '</div>';
  }
  function statsHTML() {
    const s = st.stats;
    const done = s === undefined ? 'L' : (s && Number.isFinite(Number(s.done)) ? Number(s.done) : 'N');
    const pct = s === undefined ? 'L' : (s && s.onTimePct != null && Number.isFinite(Number(s.onTimePct)) ? Math.round(Number(s.onTimePct)) : 'N');
    const pts = pointsOn();
    let h = statCell('st-done', done, 'viajes') + statCell('st-ontime', pct, 'a tiempo', { suffix: '%' });
    if (pts) {
      const ps = pointsSummary();
      const bal = ps && Number.isFinite(Number(ps.balance)) ? Number(ps.balance) : 'N';
      h += statCell('st-pts', bal, 'puntos', { cls: 'pts' });
    }
    return `<div class="rx-me-stats${pts ? '' : ' two'}" data-me="stats" data-n="${pts ? 3 : 2}">${h}</div>`;
  }

  function meHTML() {
    const U = UI();
    const p = STATE().profile || {};
    const h = HDR();
    const name = String(p.full_name || '').trim();
    const avatar = U.av(U.initials(name, 'A'), 'xl', '', { src: p.avatar_url || '' });

    // Tus viajes
    const res = h && h.residence ? resText(h.residence, h.unit) : '';
    const resSub = res || (h ? 'Sin residencia registrada' : 'No pudimos cargarla');
    const lv = levelMeta(h && h.preferredLevel);
    const meet = h && h.meetingPoint ? String(h.meetingPoint) : '';
    const phone = phoneText(p.phone);
    const pay = payRow();
    const viajes = [
      U.row({ icon: 'Home', tone: 'h2a', title: 'Mi residencia', sub: resSub, attrs: { 'data-rx': 'open-residence', 'data-me': 'row-res' } }),
      U.row({ icon: lv.ic, tone: lv.tone, title: 'Nivel preferido', sub: lv.name, attrs: { 'data-rx': 'me-level', 'data-me': 'row-level' } }),
      U.row({ icon: 'MapPin', tone: 'n', title: 'Punto de encuentro', sub: meet || 'Opcional · dónde esperas al conductor', attrs: { 'data-rx': 'me-meet', 'data-me': 'row-meet' } }),
      U.row({ tag: 'div', cls: 'static', icon: 'Phone', tone: 'n', title: 'Teléfono', sub: phone || 'Sin teléfono registrado', chevron: false, attrs: { 'data-me': 'row-phone' } }),
      U.row({ icon: 'Wallet', tone: pay.tone, title: 'Pagos y mensualidad', sub: pay.sub, attrs: { 'data-rx': 'rx-tab', 'data-tab': 'pagos', 'data-me': 'row-pay' } }),
    ].join('');

    // Beneficios
    const ptsOn = pointsOn();
    const soon = '<em class="rx-me-soon">Pronto</em>';
    let beneficios;
    if (ptsOn) {
      const ps = pointsSummary();
      const n = ps && Number.isFinite(Number(ps.balance)) ? Number(ps.balance) : null;
      const falta = n != null && ps.nextRewardName && Number.isFinite(Number(ps.nextRewardPts)) ? Number(ps.nextRewardPts) - n : null;
      const ptsSub = n == null ? 'Tus puntos'
        : n + ' pts' + (falta != null && falta > 0 ? ` · te faltan ${falta} para ${ps.nextRewardName}` : '');
      beneficios = U.row({ icon: 'Gift', tone: 'pts', title: 'Puntos Rendio', sub: ptsSub, attrs: { 'data-rx': 'me-push', 'data-to': 'points', 'data-me': 'row-points' } })
        + U.row({ icon: 'Users', tone: 'a2h', title: 'Invitar colegas', sub: 'Tu código para invitar', attrs: { 'data-rx': 'me-push', 'data-to': 'invite', 'data-me': 'row-invite' } });
    } else {
      beneficios = U.row({ tag: 'div', cls: 'static', icon: 'Gift', tone: 'pts', title: 'Puntos Rendio', sub: 'Todavía no disponible', right: soon, chevron: false, attrs: { 'data-me': 'row-points' } })
        + U.row({ tag: 'div', cls: 'static', icon: 'Users', tone: 'a2h', title: 'Invitar colegas', sub: 'Todavía no disponible', right: soon, chevron: false, attrs: { 'data-me': 'row-invite' } });
    }
    beneficios += U.row({ icon: 'Sparkle', tone: 'plus', title: 'Rendio Select', sub: privEnabled() ? 'El carro es solo para ti · con costo' : 'El carro es solo para ti · pronto', attrs: { 'data-rx': 'open-select', 'data-from': 'me', 'data-me': 'row-select' } });

    // Ayuda y ajustes
    const mode = themePref();
    const hours = opsHours();
    const ayuda = [
      U.row({ icon: 'Headset', tone: 'info', title: 'Coordinación', sub: hours || 'Escríbele a la operación', attrs: { 'data-rx': 'open-coord', 'data-me': 'row-coord' } }),
      `<div class="rx-row static"><span class="rx-row-ic t-n">${ic('Moon', 19)}</span><span class="rx-row-tx"><b>Apariencia</b><span data-me="theme-sub">${esc(themeSub(mode))}</span></span></div>`,
      `<div class="rx-px2">${U.seg(mode, [['auto', 'Automático'], ['light', 'Claro'], ['night', 'Nocturno']], {
        attrs: { 'data-me': 'theme-seg', 'data-v': mode },
        btnAttrs: (k) => ({ 'data-ax': 'theme', 'data-v': k }),
      })}</div>`,
      // #ax-pwa-bar va en la hoja (regla #10: la base no lleva ids de §2.4);
      // con PWA_EN_HOJA en false irían las filas aquí mismo.
      PWA_EN_HOJA
        ? U.row({ icon: 'Bell', tone: 'info', title: 'Notificaciones y app', sub: pwaSub(), attrs: { 'data-rx': 'me-pwa', 'data-me': 'row-pwa' } })
        : pwaBarHTML(),
      window.AuxPresentacion ? U.row({ icon: 'RotateCcw', tone: 'n', title: 'Ver la bienvenida', sub: 'La presentación del primer día', attrs: { 'data-ax': 'onb-again', 'data-me': 'row-onb' } }) : '',
      U.row({ icon: 'AlertTriangle', tone: 'n', title: 'Algo no va bien', sub: 'Qué hacer según lo que esté pasando', attrs: { 'data-ax': 'support', 'data-me': 'row-support' } }),
      canChangePw() ? U.row({ icon: 'Lock', tone: 'n', title: 'Cambiar mi contraseña', sub: 'Te pedimos la actual', attrs: { 'data-ax': 'change-pw', 'data-me': 'row-pw' } }) : '',
      U.row({ icon: 'LogOut', tone: 'n', title: 'Cerrar sesión', chevron: false, attrs: { 'data-ax': 'logout', 'data-me': 'row-logout' } }),
    ].join('');

    return `<div class="rx-scr"><div class="rx-body me">
      <div class="rx-me-hero rx-in">
        ${avatar}
        ${name ? `<h1 data-me="name">${esc(name)}</h1>` : ''}
        <span data-me="line">${esc(heroLine())}</span>
        ${statsHTML()}
      </div>
      <div class="rx-lbl">Tus viajes</div>
      <div class="rx-group rx-in" style="--d:1">${viajes}</div>
      <div class="rx-lbl">Beneficios</div>
      <div class="rx-group rx-in" style="--d:2">${beneficios}</div>
      <div class="rx-lbl">Ayuda y ajustes</div>
      <div class="rx-group rx-in" style="--d:3">${ayuda}</div>
    </div></div>`;
  }

  // RxCount: 800 ms desde 0 cada vez que la cifra cambia (o al montar).
  function countCell(cell) {
    const U = UI(); if (!U || !cell) return;
    const v = cell.getAttribute('data-v');
    if (v === 'L' || v === 'N' || v == null || v === '') return;
    const b = cell.querySelector('b'); if (!b) return;
    const pct = cell.getAttribute('data-me') === 'st-ontime';
    U.countUp(b, Number(v), pct ? { fmt: (n) => Math.round(n) + '%' } : undefined);
  }

  // Actualiza la pestaña montada SIN repintarla: como React con las mismas keys.
  // Devuelve false si cambió la forma (filas que aparecen o se van): el shell
  // repinta entonces con .rx-noanim.
  function patchMe(host) {
    host = host || st.meHost;
    if (!host || !host.isConnected) return false;
    const tmp = document.createElement('div');
    tmp.innerHTML = meHTML();
    const fresh = [...tmp.querySelectorAll('[data-me]')];
    const old = [...host.querySelectorAll('[data-me]')];
    const keys = (l) => l.map(n => n.getAttribute('data-me')).join('|');
    if (keys(fresh) !== keys(old)) return false;
    for (let i = 0; i < fresh.length; i++) {
      const n = fresh[i], o = old[i];
      const k = n.getAttribute('data-me');
      if (k === 'theme-seg') {
        const v = n.getAttribute('data-v');
        if (o.getAttribute('data-v') !== v) { UI().segSet(o, v); o.setAttribute('data-v', v); }
        continue;
      }
      if (k === 'stats') {
        if (o.getAttribute('data-n') !== n.getAttribute('data-n')) return false;
        continue;   // sus celdas van por separado
      }
      if (/^st-/.test(k)) {
        if (o.getAttribute('data-v') !== n.getAttribute('data-v')) {
          o.replaceWith(n);
          countCell(n);
        }
        continue;
      }
      if (o.outerHTML !== n.outerHTML) o.replaceWith(n);
    }
    return true;
  }

  function loadStats() {
    const X = window.ApiAux;
    if (!X || typeof X.getMyStats !== 'function') { st.stats = null; return Promise.resolve(); }
    const req = ++st.statsReq;
    return Promise.resolve().then(() => X.getMyStats()).catch(() => null).then((s) => {
      if (req !== st.statsReq) return;
      st.stats = s || null;
      refreshMe();
    });
  }
  // El horario de Coordinación lo cambia el jefe en Ajustes: se vuelve a pedir
  // cada vez que se entra a la pestaña (mientras llega, queda el último).
  function loadOps() {
    const X = window.ApiAux;
    if (!X || typeof X.getOpsContact !== 'function') return;
    Promise.resolve().then(() => X.getOpsContact()).catch(() => null).then((o) => {
      st.ops = o || null;
      refreshMe();
    });
  }
  function isTop(id) {
    try { const c = SH() && SH().current(); return !!(c && c.id === id); } catch (_) { return false; }
  }
  // Tras una carga: si la pestaña está montada, se parcha; si cambió la forma,
  // que el shell la repinte (sin animaciones).
  function refreshMe() {
    if (!st.meHost || !st.meHost.isConnected) return;
    if (!patchMe()) {
      if (isTop('me')) { try { SH().render(); } catch (_) { /* */ } }
    }
  }

  const ME = {
    render() { return meHTML(); },
    after(ctx) {
      st.meHost = ctx.host;
      if (ctx.reason === 'enter') {
        ctx.host.querySelectorAll('.rx-me-stats [data-me^="st-"]').forEach(countCell);
        loadStats();
        loadOps();
      } else {
        if (st.stats === undefined) loadStats();
        if (st.ops === undefined) loadOps();
      }
      if (PWA_EN_HOJA) { if (ctx.reason === 'enter' || st.pwa === undefined) pwaCheck(); }
      else { try { if (AX() && typeof AX().setupPwa === 'function') AX().setupPwa(); } catch (_) { /* */ } }
    },
    patch(ctx) { return patchMe(ctx.host); },
    destroy() { st.meHost = null; },
  };

  // ── Nivel preferido (hoja) ───────────────────────────────────────────────
  // Las tarjetas son de P6 (AuxPrivado.levelsHTML(null,{mode:'pref'})). Si aún no
  // existen, se pintan aquí con el marcado de RxLevelCard, honestas: Compartido
  // «Incluido», Directo «Pronto» y apagado, Privado «Con costo» (o «Pronto» en
  // primicia). Sin cupos (D5) y sin kit (D3).
  function levelCardsFallback(cur) {
    const inc = (arr) => arr.filter(Boolean).map(x => `<span>${ic('Check', 13)}${esc(x)}</span>`).join('');
    const priv = privEnabled();
    let privInc = [];
    try { privInc = (window.AuxPrivado && Array.isArray(AuxPrivado.INCLUYE) ? AuxPrivado.INCLUYE : []).slice(0, 2).map(x => (x && x.t) || ''); } catch (_) { /* */ }
    if (!privInc.length) privInc = ['Vehículo exclusivo'];
    const card = (o, d) => `<button type="button" class="rx-lv rx-in${o.vip ? ' vip' : ''}${o.on ? ' on' : ''}${o.off ? ' off' : ''}" style="--d:${d}"`
      + (o.off ? ' disabled aria-disabled="true"' : ` data-rx="pref-level" data-v="${o.v}"`) + '>'
      + `<span class="rx-lv-ic t-${o.tone}">${ic(o.ic, 20)}</span>`
      + `<span class="rx-lv-tx"><span class="rx-lv-h"><b>${esc(o.name)}</b><em>${esc(o.price)}</em></span>`
      + `<span class="rx-lv-t">${esc(o.tag)}</span><span class="rx-lv-inc">${inc(o.inc)}</span></span>`
      + '<span class="rx-radio"><i></i></span></button>';
    // Sin preferencia guardada, la elegida es Compartido (como en el pedido).
    return '<div class="rx-lvls" data-mode="pref">' + card({ v: 'shared', name: 'Compartido', price: 'Incluido', tag: 'Vas con tu tripulación', inc: ['Ruta agrupada por sector', 'Paradas en el camino'], ic: 'Users', tone: 'a2h', on: cur !== 'private' }, 0)
      + card({ v: 'direct', name: 'Directo', price: 'Pronto', tag: 'Sin desvíos: llegas antes', inc: ['Va derecho a tu destino'], ic: 'ArrowRight', tone: 'h2a', off: true }, 1)
      + card({ v: 'private', name: 'Privado · Select', price: priv ? 'Con costo' : 'Pronto', tag: 'El carro es solo tuyo', inc: privInc, ic: 'Sparkle', tone: 'plus', vip: true, on: cur === 'private', off: !priv }, 2)
      + '</div>';
  }
  function levelSheetHTML() {
    const h = HDR();
    const cur = h ? h.preferredLevel || null : null;
    let cards = '';
    try {
      if (window.AuxPrivado && typeof AuxPrivado.levelsHTML === 'function') cards = AuxPrivado.levelsHTML(null, { mode: 'pref', selected: cur }) || '';
    } catch (e) { console.error('[AuxRxPerfil] levelsHTML falló:', e); cards = ''; }
    if (!cards) cards = levelCardsFallback(cur);
    return `<div class="rx-sh"><h3>Nivel preferido</h3>${cards}</div>`;
  }
  function openLevel() {
    if (!SH()) return;
    SH().sheet(levelSheetHTML());
  }
  async function pickLevel(el) {
    const v = normLevel(el.getAttribute('data-v') || el.getAttribute('data-level') || el.getAttribute('data-id'));
    if (!v || st.levelBusy) return;
    if (el.classList.contains('off') || el.getAttribute('aria-disabled') === 'true') return;
    if (v === 'private' && !privEnabled()) return;
    const h = HDR();
    const X = window.ApiAux;
    // Se marca EN SU LUGAR al tocar (la transición del radio corre, como en el
    // diseño) y se guarda; si falla, vuelve a la de antes.
    const box = el.closest('.rx-lvls') || el.closest('.rx-sh') || el.parentNode;
    const antes = (h && h.preferredLevel) || null;
    const marcar = (cual) => {
      if (!box) return;
      box.querySelectorAll('.rx-lv[data-rx="pref-level"]').forEach(c => {
        const on = normLevel(c.getAttribute('data-v')) === cual;
        c.classList.toggle('on', on);
        c.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    };
    marcar(v);
    if (antes === v) { SH().closeSheet(); return; }
    if (!X || typeof X.saveMyPrefs !== 'function') { marcar(antes || 'shared'); SH().toast('No pudimos guardar tu preferencia', 'Info'); return; }
    st.levelBusy = true;
    let ok = null, err = '';
    try { ok = await X.saveMyPrefs({ preferredLevel: v }); } catch (e) { err = (e && e.message) || ''; }
    st.levelBusy = false;
    if (ok) {
      if (h) h.preferredLevel = v;
      SH().closeSheet();
      SH().toast('Ahora pides en ' + levelMeta(v).toast);
      refreshMe();
    } else {
      marcar(antes || 'shared');
      SH().toast(err || 'No pudimos guardar tu preferencia. Inténtalo de nuevo.', 'Info');
    }
  }

  // ── Punto de encuentro (hoja, data-rx-field: estado propio) ───────────────
  function meetSheetHTML() {
    const h = HDR();
    const cur = h && h.meetingPoint ? String(h.meetingPoint) : '';
    const where = h && h.residence && h.residence.name ? ` desde ${esc(h.residence.name)}` : '';
    return `<div class="rx-sh">
      <h3>Punto de encuentro</h3>
      <p>Opcional. Si esperas en un sitio puntual —«portería 2», «frente a la torre 3»—, escríbelo y tu conductor lo ve en tus próximos traslados${where}.</p>
      <label class="rx-field"><span>Dónde esperas</span>
        <div class="rx-input">${ic('MapPin', 18)}<input type="text" data-rx-field="meetingPoint" maxlength="120" autocomplete="off" enterkeyhint="done" value="${esc(cur)}" placeholder="Ej.: portería 2" /></div>
      </label>
      <div class="rx-me-err" data-me-err hidden></div>
      ${UI().btn('Guardar', { attrs: { 'data-rx': 'me-meet-save' } })}
      ${UI().btn('Ahora no', { kind: 'ghost', attrs: { 'data-rx': 'sheet-close' } })}
    </div>`;
  }
  function openMeet() {
    if (!SH()) return;
    SH().sheet(meetSheetHTML(), {
      after(sh) {
        const inp = sh.querySelector('[data-rx-field="meetingPoint"]');
        if (inp) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveMeet(sh); } });
      },
    });
  }
  function sheetErr(sh, msg) {
    const e = sh && sh.querySelector('[data-me-err]');
    if (!e) return;
    e.textContent = msg || '';
    e.hidden = !msg;
  }
  async function saveMeet(sh) {
    if (st.meetBusy || !sh) return;
    const inp = sh.querySelector('[data-rx-field="meetingPoint"]');
    const v = inp ? String(inp.value || '').trim() : '';
    const h = HDR();
    const X = window.ApiAux;
    if (v.length > 120) { sheetErr(sh, 'Máximo 120 caracteres.'); return; }
    if (h && String(h.meetingPoint || '') === v) { SH().closeSheet(); return; }
    if (!X || typeof X.saveMyPrefs !== 'function') { sheetErr(sh, 'No se puede guardar desde aquí todavía.'); return; }
    const btn = sh.querySelector('[data-rx="me-meet-save"]');
    st.meetBusy = true; if (btn) btn.disabled = true; sheetErr(sh, '');
    let ok = null, err = '';
    try { ok = await X.saveMyPrefs({ meetingPoint: v }); } catch (e) { err = (e && e.message) || ''; }
    st.meetBusy = false; if (btn) btn.disabled = false;
    if (ok) {
      if (h) h.meetingPoint = v;
      SH().closeSheet();
      SH().toast(v ? 'Punto de encuentro guardado' : 'Punto de encuentro borrado', 'MapPin');
      refreshMe();
    } else {
      sheetErr(sh, err || 'No pudimos guardarlo. Inténtalo de nuevo en un momento.');
    }
  }

  // ── Mi residencia (pila «residence», #27) ────────────────────────────────
  // Estado propio, nunca Auxiliar.state.form. Si P5 ya trae la pantalla
  // (AuxResidencias.pickerScreenHTML: selector con pickerHTML({mode:'perfil'}),
  // su estado `pst`, sus acciones res-p-pick / res-p-save / res-p-retry y su
  // buscador data-rx-field="res-q"), se usa ESA: además de guardar con
  // Api.saveMyResidence, deja al día el punto guardado del pedido (st.place),
  // cosa que desde aquí no se puede. Si no está, el selector propio de abajo
  // (Api.listResidences + hoja de confirmación), con su campo aparte
  // (data-rx-field="me-res-q") para no cruzarse con el de P5.
  function p5Screen() {
    const AR = window.AuxResidencias;
    return AR && typeof AR.pickerScreenHTML === 'function' ? AR : null;
  }
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  function ownListHTML() {
    const U = UI();
    const h = HDR();
    const q = R.q.trim();
    if (!q) return '';
    const list = (R.cat || []).filter(r => norm(r.name + ' ' + (r.sector || '')).includes(norm(q)));
    if (!list.length) {
      return `<div class="rx-me-none"><b>No encontramos «${esc(q)}»</b><span>Si tu conjunto no está en la lista, escríbele a Coordinación.</span></div>`;
    }
    return `<div class="rx-group">${list.map(r => {
      const cur = h && h.residenceId === r.id;
      return U.row({ icon: 'Home', tone: cur ? 'h2a' : 'n', title: r.name, sub: r.sector || '',
        right: cur ? '<em class="rx-me-cur">Actual</em>' : '', chevron: !cur,
        attrs: { 'data-rx': 'me-res-pick', 'data-id': r.id } });
    }).join('')}</div>`;
  }
  function ownPickerHTML() {
    const U = UI();
    if (R.loading || (!R.cat && !R.failed)) {
      return `<div class="rx-note">${ic('Clock', 15)}Cargando los conjuntos…</div>`;
    }
    if (R.failed || !R.cat) {
      return `<div class="rx-me-none"><b>No pudimos cargar los conjuntos</b><span>Revisa tu conexión e inténtalo otra vez.</span></div>`
        + U.btn('Reintentar', { kind: 'sec', icon: 'Refresh', attrs: { 'data-rx': 'me-res-retry' } });
    }
    return `<div class="rx-input search">${ic('Search', 18)}<input type="text" data-rx-field="me-res-q" value="${esc(R.q)}" placeholder="Busca tu conjunto o sector" autocomplete="off" enterkeyhint="search" /></div>`
      + `<div class="rx-note" data-me-hint${R.q.trim() ? ' hidden' : ''}>${ic('Info', 15)}Escribe el nombre de tu conjunto o el sector.</div>`
      + `<div class="rx-me-res-list" data-me-list>${ownListHTML()}</div>`;
  }

  function residenceHTML() {
    const U = UI();
    const h = HDR();
    const r1 = h && h.residence ? h.residence : null;
    const r2 = h && h.residence2 ? h.residence2 : null;
    const cur = r1
      ? U.row({ tag: 'div', cls: 'static', icon: 'Home', tone: 'h2a', title: r1.name || 'Tu conjunto', sub: [r1.sector, h.unit].filter(Boolean).join(' · '), chevron: false })
      : U.row({ tag: 'div', cls: 'static', icon: 'Home', tone: 'n', title: h ? 'Sin residencia registrada' : 'No pudimos cargar tu residencia', sub: h ? 'Elígela abajo' : 'Puedes elegirla abajo', chevron: false });
    const second = r2
      ? U.row({ tag: 'div', cls: 'static', icon: 'Home', tone: 'n', title: r2.name || 'Segunda unidad', sub: ['Segunda unidad', r2.sector, h.unit2].filter(Boolean).join(' · '), chevron: false })
      : '';
    return `<div class="rx-scr">
      ${U.head({ title: 'Mi residencia' })}
      <div class="rx-body">
        <div class="rx-lbl">${r2 ? 'Tus unidades' : 'Tu conjunto'}</div>
        <div class="rx-group rx-in">${cur}${second}</div>
        ${r2 ? `<div class="rx-note rx-in" style="--d:1">${ic('Info', 15)}<span>La segunda unidad no se cambia desde aquí. Para cambiarla, escríbele a Coordinación.</span></div>` : ''}
        <div class="rx-lbl">${r1 ? 'Cambiar de conjunto' : 'Elige tu conjunto'}</div>
        <div class="rx-me-picker rx-in" style="--d:2" data-me-picker>${ownPickerHTML()}</div>
      </div>
    </div>`;
  }

  // Repinta solo el selector (catálogo que llegó, reintento). Sin animaciones:
  // es la misma pantalla con datos nuevos.
  function repaintPicker() {
    const box = R.host && R.host.querySelector('[data-me-picker]');
    if (!box) return;
    box.classList.add('rx-noanim');
    box.innerHTML = ownPickerHTML();
  }
  // En cada tecla: solo la lista (el campo no se toca y no pierde el foco).
  function onResQuery(inp) {
    R.q = String(inp.value || '');
    const box = R.host && R.host.querySelector('[data-me-picker]');
    const list = box && box.querySelector('[data-me-list]');
    if (!list) return;
    list.innerHTML = ownListHTML();
    const hint = box.querySelector('[data-me-hint]');
    if (hint) hint.hidden = !!R.q.trim();
  }

  function loadCatalog(force) {
    const Api = window.Api;
    if (R.loading) return Promise.resolve();
    if (R.cat && !force) return Promise.resolve();
    R.loading = true; R.failed = false;
    const mine = Api && typeof Api.listResidences === 'function'
      ? Promise.resolve().then(() => Api.listResidences()).catch(() => null)
      : Promise.resolve(null);
    return mine.then((cat) => {
      R.cat = Array.isArray(cat) && cat.length ? cat : null;
      R.failed = !R.cat;
    }).finally(() => {
      R.loading = false;
      if (isTop('residence')) repaintPicker();
    });
  }

  function resSheetHTML(r) {
    const U = UI();
    const h = HDR();
    const unit = h && h.unit ? String(h.unit) : '';
    return `<div class="rx-sh">
      <h3>¿Cambiar tu residencia?</h3>
      <p>Tus próximos traslados van a usar <b>${esc(r.name)}</b>${r.sector ? ' · ' + esc(r.sector) : ''} como tu punto. Los que ya pediste no cambian.</p>
      ${unit ? `<div class="rx-note">${ic('Info', 15)}<span>Tu apartamento registrado es <b>${esc(unit)}</b>. Si también cambió, escríbele a Coordinación.</span></div>` : ''}
      <div class="rx-me-err" data-me-err hidden></div>
      ${U.btn('Guardar', { attrs: { 'data-rx': 'me-res-save', 'data-id': r.id } })}
      ${U.btn('Ahora no', { kind: 'ghost', attrs: { 'data-rx': 'sheet-close' } })}
    </div>`;
  }
  function findRes(id) {
    const h = HDR();
    const inCat = (R.cat || []).find(r => r.id === id);
    if (inCat) return inCat;
    if (h && h.residence && h.residence.id === id) return h.residence;
    return null;
  }
  function pickResidence(id) {
    if (!id || !SH()) return;
    const h = HDR();
    const r = findRes(id);
    if (!r) return;
    if (h && h.residenceId === id) { SH().toast('Ya es tu residencia', 'Home'); return; }
    SH().sheet(resSheetHTML(r));
  }
  async function saveResidence(el) {
    const id = el.getAttribute('data-id');
    const sh = el.closest('.rx-sheet');
    if (!id || R.saving) return;
    const Api = window.Api;
    if (!Api || typeof Api.saveMyResidence !== 'function') { sheetErr(sh, 'No se puede guardar desde aquí todavía.'); return; }
    const r = findRes(id);
    R.saving = true; el.disabled = true; sheetErr(sh, '');
    let err = '';
    try { await Api.saveMyResidence(id); } catch (e) { err = (e && e.message) || 'No pudimos guardarla'; }
    R.saving = false; el.disabled = false;
    if (err) { sheetErr(sh, err === 'Sin sesión' ? 'Tu sesión se cerró. Vuelve a entrar e inténtalo otra vez.' : 'No pudimos guardarla. Inténtalo de nuevo en un momento.'); return; }
    const h = HDR();
    if (h) {
      h.residenceId = id;
      h.residence = r ? { id, name: r.name, sector: r.sector || null } : { id, name: '', sector: null };
    }
    SH().closeSheet();
    SH().toast('Residencia actualizada', 'MapPin');
    SH().pop();
  }

  function bindResidence(el) {
    if (!el || el.__meBound) return;
    el.__meBound = true;
    el.addEventListener('input', (e) => {
      const t = e.target;
      if (!t || !t.matches || !t.matches('[data-rx-field="me-res-q"]')) return;
      onResQuery(t);
    });
  }

  const RES = {
    render(ctx) {
      const AR = p5Screen();
      if (AR) {
        if (ctx.reason === 'enter' && typeof AR.pickerReset === 'function') AR.pickerReset();
        return AR.pickerScreenHTML();
      }
      if (ctx.reason === 'enter') R.q = '';
      return residenceHTML();
    },
    after(ctx) {
      if (p5Screen()) return;   // P5 enlaza su buscador; sus res-p-* van por AuxShell.action
      R.host = ctx.host;
      bindResidence(ctx.el);
      if (!R.cat) loadCatalog();
    },
    // Con la pantalla de P5: su selector se actualiza con AuxShell.render()
    // (elegir, guardando…), así que se repinta como siempre. Con la propia: lo
    // de afuera (viajes, ajustes) no la toca, para no botar lo que se escribe.
    patch() { return !p5Screen(); },
    destroy(ctx) { if (ctx.reason === 'leave') R.host = null; },
  };

  // ── Registro ─────────────────────────────────────────────────────────────
  function register() {
    const S = SH();
    if (!S || typeof S.register !== 'function') return false;
    S.register('me', ME);
    S.register('residence', RES);
    S.action('me-level', () => openLevel());
    S.action('pref-level', (el) => { pickLevel(el); });
    S.action('me-meet', () => openMeet());
    S.action('me-pwa', () => openPwa());
    S.action('me-meet-save', (el) => { saveMeet(el.closest('.rx-sheet')); });
    S.action('me-push', (el) => { const to = el.getAttribute('data-to'); if (to) S.push(to, {}); });
    S.action('me-res-pick', (el) => pickResidence(el.getAttribute('data-id')));
    S.action('me-res-save', (el) => { saveResidence(el); });
    S.action('me-res-retry', () => { R.failed = false; loadCatalog(true); repaintPicker(); });
    return true;
  }
  register();

  window.AuxRxPerfil = {
    meHTML, residenceHTML, levelSheetHTML, meetSheetHTML,
    refresh: refreshMe, reloadStats: loadStats, register,
    // Para las pruebas: estado propio (nunca es Auxiliar.state.form).
    _st: st, _R: R,
  };
})();
