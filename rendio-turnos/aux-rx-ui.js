// aux-rx-ui.js — P1 · Sistema visual del rediseño del auxiliar (27-sep-2026).
//
// Qué es: las primitivas de la entrega del diseñador (rx-core.jsx, icons.jsx,
// branding.jsx) pasadas a JS sin React: cada función devuelve HTML (string) con las
// MISMAS clases, la MISMA estructura y los MISMOS estilos en línea que el JSX, para
// que el CSS portado (rx-auxiliar.css, generado) las pinte idénticas, animaciones
// incluidas. Y el sprite de íconos: <svg id="rx-sprite"> con un <symbol id="rx-X">
// por cada ícono de RXI (rx-core.jsx) y de window.ICON (icons.jsx), con los trazos
// copiados tal cual (56 nombres; en el choque de «X» gana RXI, que es idéntico).
//
// Contrato (plan final §5 «P1»):
//   window.AuxRxUI = { ic, logo, esc, initials, hm, dayLabel, btn, head, seg, toggle,
//                      row, av, check, confetti, stepCtl, sheet, countUp, … }
// Extras para no perder animaciones al actualizar sin React (ANIMACIONES §5):
//   segSet, toggleSet, stepCtlSet, remount, sheetOpen, sheetClose, lfIcon, ICONS, reduced.
//
// Reglas:
// · Los textos que recibe se ESCAPAN (title, sub, label…). Lo que se llama «…HTML»
//   o `right`/`html` en las opciones va tal cual: es marcado armado por quien llama.
// · Acciones: nada de onclick. Cada primitiva acepta `attrs` (objeto → atributos
//   escapados, o string ya armado) para poner data-ax / data-rx / id, y el listener
//   delegado del shell (AuxShell.action) o de auxiliar.js hace el resto.
// · Hora y día SIEMPRE en hora de Bogotá, no la del teléfono.
// · Nada inventado: si no hay dato, la primitiva no se lo saca de la manga
//   (initials('') → 'A', hm(null) → '', dayLabel(null) → '').
(function () {
  'use strict';

  var TZ = 'America/Bogota';
  var SPRITE_ID = 'rx-sprite';

  // ── Trazos de los íconos (copiados de icons.jsx y rx-core.jsx; la prueba
  //    _smoke-rx-ui-dom.mjs los compara uno por uno contra las fuentes) ──────────
  var ICONS = {
    AlertTriangle: '<path d="M10.29 3.86l-8.18 14a2 2 0 0 0 1.71 3h16.36a2 2 0 0 0 1.71-3l-8.18-14a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    ArrowRight: '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
    Battery: '<rect x="2" y="7" width="16" height="10" rx="2"/><line x1="22" y1="11" x2="22" y2="13"/><line x1="6" y1="10" x2="6" y2="14"/><line x1="10" y1="10" x2="10" y2="14"/>',
    Bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
    Briefcase: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
    Calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
    Camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="4"/>',
    Car: '<path d="M5 17h14M5 17v3M19 17v3M5 17l1.5-5.5a2 2 0 0 1 1.9-1.5h7.2a2 2 0 0 1 1.9 1.5L19 17M3 17h18"/><circle cx="8" cy="17" r="1.2"/><circle cx="16" cy="17" r="1.2"/>',
    Check: '<polyline points="20 6 9 17 4 12"/>',
    ChevronDown: '<polyline points="6 9 12 15 18 9"/>',
    ChevronLeft: '<polyline points="15 18 9 12 15 6"/>',
    ChevronRight: '<polyline points="9 18 15 12 9 6"/>',
    Clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    Cloud: '<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>',
    CloudOff: '<path d="M22.61 16.95A5 5 0 0 0 18 10h-1.26a8 8 0 0 0-7.05-6"/><path d="M5 5a8 8 0 0 0 4 15h9a5 5 0 0 0 1.7-.3"/><line x1="1" y1="1" x2="23" y2="23"/>',
    Copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    Disc: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>',
    Droplet: '<path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.32 0z"/>',
    Eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    FileText: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
    Fuel: '<line x1="3" y1="22" x2="15" y2="22"/><line x1="4" y1="9" x2="14" y2="9"/><path d="M14 22V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v18"/><path d="M14 13h2a2 2 0 0 1 2 2v2a2 2 0 0 0 2 2 2 2 0 0 0 2-2V9.83a2 2 0 0 0-.59-1.42L18 5"/>',
    Gauge: '<path d="M12 14l4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
    Gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7M7.5 8a2.5 2.5 0 0 1 0-5C10 3 12 8 12 8s2-5 4.5-5a2.5 2.5 0 0 1 0 5"/>',
    Headset: '<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>',
    Home: '<path d="M3 10l9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 13 15 13 15 22"/>',
    Info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
    Lightbulb: '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7 3 3 0 0 1 1 2.3v1h6v-1a3 3 0 0 1 1-2.3A7 7 0 0 0 12 2z"/>',
    Lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    LogOut: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
    Mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
    MapPin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
    MessageCircle: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
    Minus: '<line x1="5" y1="12" x2="19" y2="12"/>',
    Moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
    Nav: '<polygon points="3 11 22 2 13 21 11 13 3 11"/>',
    Phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.2 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.1 9.9a16 16 0 0 0 6 6l1.26-1.26a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
    Plane: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
    Plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    Refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"/>',
    RotateCcw: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
    Route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
    Search: '<circle cx="11" cy="11" r="7.5"/><line x1="21" y1="21" x2="16.5" y2="16.5"/>',
    Send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
    Share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/><line x1="15.4" y1="6.5" x2="8.6" y2="10.5"/>',
    Shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    Sparkle: '<path d="M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z"/>',
    Star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    Sun: '<circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="6.34" y2="6.34"/><line x1="17.66" y1="17.66" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="6.34" y2="17.66"/><line x1="17.66" y1="6.34" x2="19.07" y2="4.93"/>',
    Tire: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5"/><line x1="12" y1="3" x2="12" y2="8.5"/><line x1="12" y1="15.5" x2="12" y2="21"/><line x1="3" y1="12" x2="8.5" y2="12"/><line x1="15.5" y1="12" x2="21" y2="12"/>',
    User: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    Users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    Wallet: '<path d="M20 12V8H6a2 2 0 0 1-2-2c0-1.1.9-2 2-2h12v4"/><path d="M4 6v12c0 1.1.9 2 2 2h14v-4"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>',
    Wifi: '<path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>',
    Wrench: '<path d="M14.7 6.3a4 4 0 0 0 5 5L21 13l-7 7a3 3 0 1 1-4-4l7-7-1.3-1.3a4 4 0 0 0-1-1z"/>',
    X: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    Zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  };

  // ── Utilidades ──────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // attrs({ 'data-ax': 'trip', 'data-id': 7, disabled: true, hidden: false }) → ' data-ax="trip" data-id="7" disabled'
  function attrs(a) {
    if (!a) return '';
    if (typeof a === 'string') return a.trim() ? ' ' + a.trim() : '';
    var out = '';
    Object.keys(a).forEach(function (k) {
      var v = a[k];
      if (v == null || v === false) return;
      out += ' ' + k + (v === true ? '' : '="' + esc(v) + '"');
    });
    return out;
  }
  function cx() {
    var out = [];
    for (var i = 0; i < arguments.length; i++) if (arguments[i]) out.push(String(arguments[i]).trim());
    return out.filter(Boolean).join(' ');
  }
  // React escribe los números de un style con «px» y sin redondear: igual aquí.
  function px(n) { return String(n) + 'px'; }
  function noop() {}
  function reduced() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
    catch (e) { return false; }
  }

  // ── Sprite ──────────────────────────────────────────────────────────────────
  function ensureSprite() {
    if (typeof document === 'undefined' || !document.body) return null;
    var el = document.getElementById(SPRITE_ID);
    if (el) return el;
    var html = '<svg xmlns="http://www.w3.org/2000/svg" id="' + SPRITE_ID + '" style="display:none" aria-hidden="true">'
      + Object.keys(ICONS).map(function (n) { return '<symbol id="rx-' + n + '" viewBox="0 0 24 24">' + ICONS[n] + '</symbol>'; }).join('')
      + '</svg>';
    var wrap = document.createElement('div');
    wrap.innerHTML = html;                 // el parser de HTML deja el <svg> en su espacio de nombres
    el = wrap.firstChild;
    document.body.appendChild(el);
    return el;
  }

  // ic('Plane', 20, 'cls', 'color:var(--r-text-3)') — el <Ic n s style/> del diseño.
  // fill/stroke/linecap/linejoin van como ATRIBUTOS, como en el diseño, para que
  // cualquier regla del diseño sobre el svg (estrellas, .rx-drv-st…) les gane igual.
  function ic(n, s, cls, style) {
    if (!Object.prototype.hasOwnProperty.call(ICONS, n)) return '';
    ensureSprite();
    s = s == null ? 20 : s;
    return '<svg class="' + cx('rx-ic lucide', cls) + '" width="' + s + '" height="' + s + '" viewBox="0 0 24 24"'
      + ' fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"'
      + ' aria-hidden="true" focusable="false"' + (style ? ' style="' + esc(style) + '"' : '')
      + '><use href="#rx-' + n + '"></use></svg>';
  }

  // logo({ height:28, tagline:false, tone:'dark'|'light', color, accent }) — RendioLogo de branding.jsx.
  function logo(o) {
    o = o || {};
    var height = o.height == null ? 28 : o.height;
    var tone = o.tone || 'dark';
    var accent = o.accent || '#F26522';
    var fg = o.color || (tone === 'light' ? '#FFFFFF' : '#18181B');
    var sub = tone === 'light' ? 'rgba(255,255,255,0.55)' : 'rgba(24,24,27,0.55)';
    var fontSize = height * 0.95, dotSize = height * 0.22;
    return '<div style="display:inline-flex;align-items:center;gap:' + px(height * 0.4) + ';line-height:1">'
      + '<span style="display:inline-flex;align-items:center;gap:' + px(height * 0.18) + '">'
      + '<span style="width:' + px(dotSize) + ';height:' + px(dotSize) + ';border-radius:50%;background:' + esc(accent) + ';flex-shrink:0;align-self:center"></span>'
      + '<span style="font-family:&quot;SF Pro Display&quot;, -apple-system, &quot;Inter&quot;, system-ui, sans-serif;font-weight:800;font-size:' + px(fontSize) + ';letter-spacing:' + px(-fontSize * 0.045) + ';color:' + esc(fg) + '">Rendio</span>'
      + '</span>'
      + (o.tagline ? '<span style="font-size:' + px(height * 0.32) + ';font-weight:400;color:' + sub + ';letter-spacing:' + px(height * 0.06) + ';text-transform:uppercase;font-family:-apple-system, &quot;Inter&quot;, system-ui, sans-serif;align-self:center;white-space:nowrap">Crew Route</span>' : '')
      + '</div>';
  }

  // ── Nombres, horas y días (siempre hora de Bogotá) ─────────────────────────────
  // initials('Laura Gómez') → 'LG'; una palabra → su inicial; sin nombre → 'A' (plan §3.2).
  function initials(name, fallback) {
    var w = String(name == null ? '' : name).trim().split(/\s+/).filter(Boolean);
    if (!w.length) return fallback == null ? 'A' : fallback;
    var s = w.length === 1 ? w[0].charAt(0) : w[0].charAt(0) + w[w.length - 1].charAt(0);
    return s.toUpperCase();
  }
  // Colombia no tiene horario de verano: UTC−5 todo el año. Se usa Intl si está y el
  // desfase fijo si no (jsdom sin ICU, navegadores viejos): dan lo mismo.
  function bogParts(d) {
    try {
      var p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
      var g = function (t) { var x = p.find(function (q) { return q.type === t; }); return x ? x.value : ''; };
      var h = g('hour') === '24' ? '00' : g('hour');
      if (g('year') && g('minute')) return { day: g('year') + '-' + g('month') + '-' + g('day'), hm: h + ':' + g('minute') };
    } catch (e) { /* cae al desfase fijo */ }
    var b = new Date(d.getTime() - 5 * 3600e3), z = function (n) { return (n < 10 ? '0' : '') + n; };
    return { day: b.getUTCFullYear() + '-' + z(b.getUTCMonth() + 1) + '-' + z(b.getUTCDate()), hm: z(b.getUTCHours()) + ':' + z(b.getUTCMinutes()) };
  }
  function toDate(v) {
    if (v == null || v === '') return null;
    var d = v instanceof Date ? v : new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  // hm('2026-10-15T01:30:00Z') → '20:30' (Bogotá). hm('4:05') → '04:05'. Sin dato → ''.
  function hm(v) {
    if (v == null || v === '') return '';
    var m = typeof v === 'string' && v.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (m) return (m[1].length === 1 ? '0' : '') + m[1] + ':' + m[2];
    var d = toDate(v);
    return d ? bogParts(d).hm : '';
  }
  // bogDay(iso|Date|'YYYY-MM-DD') → 'YYYY-MM-DD' en Bogotá.
  function bogDay(v) {
    if (v == null || v === '') return '';
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    var d = toDate(v);
    return d ? bogParts(d).day : '';
  }
  var WD = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
  var MO = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  function addDay(day, n) {
    var p = day.split('-').map(Number), d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n, 12));
    return d.toISOString().slice(0, 10);
  }
  // dayLabel('2026-10-14') con hoy 14-oct → 'Hoy · mar 14 oct'; mañana → 'Mañana · mié 15 oct';
  // otro día → 'Jue 16 oct' (los tres formatos del diseño). `now` solo para pruebas.
  function dayLabel(v, now) {
    var d = bogDay(v);
    if (!d) return '';
    var today = bogDay(now || new Date());
    var p = d.split('-').map(Number), wd = new Date(Date.UTC(p[0], p[1] - 1, p[2], 12)).getUTCDay();
    var base = WD[wd] + ' ' + p[2] + ' ' + MO[p[1] - 1];
    if (d === today) return 'Hoy · ' + base;
    if (d === addDay(today, 1)) return 'Mañana · ' + base;
    return base.charAt(0).toUpperCase() + base.slice(1);
  }

  // ── Primitivas (rx-core.jsx) ─────────────────────────────────────────────────
  // btn('Continuar', { kind:'pri'|'sec'|'ghost'|'danger'|'pts'|'brass', icon, cls, attrs, disabled, html })
  function btn(label, o) {
    o = o || {};
    return '<button type="button" class="' + cx('rx-btn', o.kind || 'pri', o.cls) + '"' + (o.disabled ? ' disabled' : '') + attrs(o.attrs) + '>'
      + (o.icon ? ic(o.icon, 19) : '') + (o.html ? label : esc(label)) + '</button>';
  }
  // head({ title, eyebrow, back:true|false|{attrs}, right:'html', large, sub })
  // back:true → botón «Volver» con data-rx="rx-pop" (la acción de la pila del shell).
  function head(o) {
    o = o || {};
    var back = o.back === false ? ''
      : '<button type="button" class="rx-ib"' + attrs(o.back && o.back !== true ? o.back : { 'data-rx': 'rx-pop' }) + ' aria-label="Volver">' + ic('ChevronLeft', 22) + '</button>';
    var eb = o.eyebrow ? '<span>' + esc(o.eyebrow) + '</span>' : '';
    return '<div class="' + cx('rx-head', o.large && 'lg') + '">'
      + '<div class="rx-head-row">' + back
      + (!o.large ? '<div class="rx-head-c">' + eb + '<b>' + esc(o.title) + '</b></div>' : '')
      + '<div class="rx-head-r">' + (o.right || '') + '</div>'
      + '</div>'
      + (o.large ? '<div class="rx-head-lg">' + eb + '<h1>' + esc(o.title) + '</h1>' + (o.sub ? '<p>' + esc(o.sub) + '</p>' : '') + '</div>' : '')
      + '</div>';
  }
  // seg(v, [['next','Próximos'],['past','Historial']], { name, cls, action:'seg', btnAttrs(k) })
  // Cada botón lleva data-rx="seg" data-seg=name data-v=k (o lo que devuelva btnAttrs).
  // Para cambiar de opción SIN repintar (y que el indicador se deslice con su
  // transición de .35 s) usar segSet(el, v).
  function seg(v, opts, o) {
    o = o || {};
    opts = opts || [];
    var i = Math.max(0, opts.findIndex(function (x) { return x[0] === v; }));
    var h = '<div class="' + cx('rx-seg', o.cls) + '" style="--n:' + opts.length + '"' + (o.name ? ' data-rx-seg="' + esc(o.name) + '"' : '') + attrs(o.attrs) + '>'
      + '<span class="rx-seg-ind" style="transform:translateX(' + (i * 100) + '%)"></span>';
    opts.forEach(function (x) {
      var a = typeof o.btnAttrs === 'function' ? o.btnAttrs(x[0]) : { 'data-rx': o.action || 'seg', 'data-seg': o.name || null, 'data-v': x[0] };
      h += '<button type="button"' + (v === x[0] ? ' class="on"' : '') + attrs(a) + '>' + esc(x[1]) + '</button>';
    });
    return h + '</div>';
  }
  function segSet(el, v) {
    var root = el && (el.classList && el.classList.contains('rx-seg') ? el : el.closest && el.closest('.rx-seg'));
    if (!root) return false;
    var btns = Array.prototype.filter.call(root.children, function (c) { return c.tagName === 'BUTTON'; });
    var i = btns.findIndex(function (b) { return b.getAttribute('data-v') === String(v); });
    if (i < 0) return false;
    btns.forEach(function (b, k) { if (k === i) b.className = 'on'; else b.removeAttribute('class'); });
    var ind = root.querySelector('.rx-seg-ind');
    if (ind) ind.style.transform = 'translateX(' + (i * 100) + '%)';
    return true;
  }
  // toggle(on, attrs) — el interruptor del diseño. toggleSet(el,on) lo mueve sin repintar.
  function toggle(on, a) {
    return '<button type="button" class="' + cx('rx-tg', on && 'on') + '"' + attrs(a) + ' aria-pressed="' + (on ? 'true' : 'false') + '"><i></i></button>';
  }
  function toggleSet(el, on) {
    if (!el) return false;
    el.classList.toggle('on', !!on);
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
    return true;
  }
  // row({ icon, tone:'n'|'h2a'|'a2h'|'plus'|'pts'|'info'|'err', title, sub, right:'html',
  //       chevron:true, attrs, cls, tag:'button'|'div' })
  function row(o) {
    o = o || {};
    var tag = o.tag || 'button';
    return '<' + tag + (tag === 'button' ? ' type="button"' : '') + ' class="' + cx('rx-row', o.cls) + '"' + attrs(o.attrs) + '>'
      + (o.icon ? '<span class="rx-row-ic t-' + esc(o.tone || 'n') + '">' + ic(o.icon, 19) + '</span>' : '')
      + '<span class="rx-row-tx"><b>' + esc(o.title) + '</b>' + (o.sub ? '<span>' + esc(o.sub) + '</span>' : '') + '</span>'
      + (o.right || '')
      + (o.chevron !== false ? ic('ChevronRight', 18, '', 'color: var(--r-text-3)') : '')
      + '</' + tag + '>';
  }
  // av('LG', 'md'|'sm'|'lg'|'xl', 'lt', { src }) — con foto, las iniciales quedan
  // debajo (si la foto no carga, se ven ellas y no un ícono roto).
  function av(ini, size, tone, o) {
    o = o || {};
    var src = o.src ? '<img src="' + esc(o.src) + '" alt="" loading="lazy" decoding="async">' : '';
    return '<span class="' + cx('rx-av', size || 'md', tone, src && 'has-img') + '">' + esc(ini) + src + '</span>';
  }
  // check('ok'|'pts'|'info', 92) — el visto que se dibuja (rxDraw) y salta (rxPop).
  function check(tone, size) {
    size = size == null ? 92 : size;
    return '<div class="rx-check t-' + esc(tone || 'ok') + '" style="width:' + px(size) + ';height:' + px(size) + '">'
      + '<svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="24"></circle><polyline points="15 27 23 35 38 18"></polyline></svg></div>';
  }
  // confetti(26, colores, { cls:'rx-confetti', mod:8, step:60 }) — RxConfetti.
  // El del cobro (Cb2Party): confetti(22, ['#F26522','#10B981','#F59E0B','#3B82F6'], { cls:'cb2-confetti', mod:7, step:70 }).
  function confetti(n, colors, o) {
    o = o || {};
    n = n == null ? 26 : n;
    var C = colors || ['#F26522', '#10B981', '#F59E0B', '#6A3FC0', '#3B82F6'];
    var mod = o.mod || 8, step = o.step == null ? 60 : o.step, h = '';
    for (var i = 0; i < n; i++) {
      h += '<i style="left:' + ((i * 37) % 100) + '%;animation-delay:' + ((i % mod) * step) + 'ms;--r:' + ((i * 53) % 360) + 'deg;--c:' + C[i % C.length] + '"></i>';
    }
    return '<div class="' + esc(o.cls || 'rx-confetti') + '">' + h + '</div>';
  }
  // stepCtl(1, { dec:{attrs}, inc:{attrs} }) — el − N + de las maletas (rx-book.jsx).
  // Por defecto data-rx="bags-dec"/"bags-inc". stepCtlSet(el, v) recrea el número para
  // que vuelva a saltar (key={f.bags} en el diseño).
  function stepCtl(v, o) {
    o = o || {};
    return '<div class="rx-step-ctl"' + attrs(o.attrs) + '>'
      + '<button type="button"' + attrs(o.dec || { 'data-rx': 'bags-dec' }) + ' aria-label="Menos">' + ic('Minus', 16) + '</button>'
      + '<b>' + esc(v) + '</b>'
      + '<button type="button"' + attrs(o.inc || { 'data-rx': 'bags-inc' }) + ' aria-label="Más">' + ic('Plus', 16) + '</button>'
      + '</div>';
  }
  function stepCtlSet(el, v) {
    var root = el && (el.classList && el.classList.contains('rx-step-ctl') ? el : el.closest && el.closest('.rx-step-ctl'));
    var b = root && root.querySelector('b');
    if (!b) return false;
    var n = b.ownerDocument.createElement('b');
    n.className = 'rx-anim';
    n.textContent = String(v);
    b.parentNode.replaceChild(n, b);
    return true;
  }
  // remount(el) — el re-montaje por key del diseño: el nodo se RECREA (no basta cambiar
  // su texto) y lleva .rx-anim, así anima aunque la capa tenga .rx-noanim.
  function remount(el, html) {
    if (!el || !el.parentNode) return el;
    var n = el.cloneNode(html == null);
    if (html != null) n.innerHTML = html;
    n.classList.add('rx-anim');
    el.parentNode.replaceChild(n, el);
    return n;
  }

  // ── Hoja inferior (RxSheet) ──────────────────────────────────────────────────
  // sheet('html', { tall, cls }) → el marcado. sheetOpen(host, 'html', {tall, onClose})
  // lo monta en host (reemplaza la hoja anterior) y lo cierra con su animación al tocar
  // el fondo: .out y se desmonta a los 220 ms, como el diseño.
  function sheet(content, o) {
    o = o || {};
    return '<div class="rx-sheet-bg" data-rx-sheet-bg><div class="' + cx('rx-sheet', o.tall && 'tall', o.cls) + '"><div class="rx-grab"></div>' + (content || '') + '</div></div>';
  }
  function sheetClose(bg, cb) {
    if (!bg || bg.__rxClosing) return false;
    bg.__rxClosing = true;
    bg.classList.add('out');
    setTimeout(function () {
      if (bg.parentNode) bg.parentNode.removeChild(bg);
      if (typeof cb === 'function') cb();
    }, 220);
    return true;
  }
  function sheetOpen(host, content, o) {
    o = o || {};
    if (!host) return null;
    host.innerHTML = sheet(content, o);
    var bg = host.lastElementChild;
    var close = function (cb) { return sheetClose(bg, function () { if (typeof o.onClose === 'function') o.onClose(); if (typeof cb === 'function') cb(); }); };
    bg.addEventListener('click', function (e) { if (e.target === bg) close(); });
    return { el: bg, close: close };
  }

  // ── Contadores (RxCount 800 ms desde 0 · useCountUp 700 ms desde el valor anterior) ──
  // countUp(el, 48)                          → RxCount: de 0 a 48 en 800 ms.
  // countUp(el, monto, { ms:700, from:'prev', fmt }) → useCountUp: la primera vez pone el
  //   valor sin animar; después anima desde el último valor al que LLEGÓ.
  // Curva: 1 − (1 − k)³ por requestAnimationFrame, igual que el diseño. Devuelve cancelar.
  function countUp(el, to, o) {
    o = o || {};
    if (!el) return noop;
    var ms = o.ms == null ? 800 : o.ms;
    var fmt = typeof o.fmt === 'function' ? o.fmt : Math.round;
    if (el.__rxCount) { el.__rxCount(); el.__rxCount = null; }
    to = Number(to);
    if (!isFinite(to)) return noop;
    var from;
    if (o.from === 'prev') {
      if (typeof el.__rxCountV !== 'number') { el.__rxCountV = to; el.textContent = fmt(to); return noop; }
      from = el.__rxCountV;
    } else from = o.from == null ? 0 : Number(o.from);
    if (from === to || ms <= 0 || reduced()) { el.textContent = fmt(to); el.__rxCountV = to; return noop; }
    var raf = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : function (f) { return setTimeout(function () { f(now()); }, 16); };
    var caf = window.cancelAnimationFrame ? window.cancelAnimationFrame.bind(window) : clearTimeout;
    var t0 = now(), id, done = false;
    el.textContent = fmt(from);
    var step = function (t) {
      var k = Math.min(1, (t - t0) / ms);
      el.textContent = fmt(from + (to - from) * (1 - Math.pow(1 - k, 3)));
      if (k < 1) id = raf(step);
      else { done = true; el.__rxCountV = to; el.__rxCount = null; }
    };
    id = raf(step);
    var cancel = function () { if (!done) { caf(id); done = true; } };
    el.__rxCount = cancel;
    return cancel;
  }
  function now() { return (window.performance && window.performance.now) ? window.performance.now() : Date.now(); }

  // ── Marcadores de Leaflet del viaje en vivo (plan §1.5) ────────────────────────
  // L.divIcon(AuxRxUI.lfIcon('pin'|'apt'|'car')). Los estilos están en rx-aux-app.css.
  var LF = {
    pin: { s: 34, svg: '<circle r="15" class="pin-halo"></circle><circle r="8" class="pin a"></circle>' },
    apt: { s: 22, svg: '<rect x="-8" y="-8" width="16" height="16" rx="4" class="pin b"></rect>' },
    car: { s: 38, svg: '<circle r="17" class="car-halo"></circle><circle r="10" class="car-dot"></circle><circle r="3.5" class="car-in"></circle>' },
  };
  function lfIcon(kind) {
    var k = LF[kind];
    if (!k) return null;
    var h = k.s / 2;
    return {
      className: 'rx-lf-' + kind,
      html: '<svg viewBox="' + (-h) + ' ' + (-h) + ' ' + k.s + ' ' + k.s + '" aria-hidden="true">' + k.svg + '</svg>',
      iconSize: [k.s, k.s],
      iconAnchor: [h, h],
    };
  }

  try { ensureSprite(); } catch (e) { /* sin document: se crea en el primer ic() */ }

  window.AuxRxUI = {
    ic: ic, logo: logo, esc: esc, initials: initials, hm: hm, dayLabel: dayLabel,
    btn: btn, head: head, seg: seg, toggle: toggle, row: row, av: av, check: check,
    confetti: confetti, stepCtl: stepCtl, sheet: sheet, countUp: countUp,
    // extras
    attrs: attrs, bogDay: bogDay, segSet: segSet, toggleSet: toggleSet, stepCtlSet: stepCtlSet,
    remount: remount, sheetOpen: sheetOpen, sheetClose: sheetClose, lfIcon: lfIcon,
    ensureSprite: ensureSprite, reduced: reduced,
    ICONS: Object.keys(ICONS),
  };
})();
