// aux-anuncio.js — El anuncio de UNA sola vez del tripulante (26-nov-2026).
//
// QUÉ ES
// Un popup que le sale a cada tripulante una vez al entrar a Inicio y no vuelve.
// Hoy lleva la expectativa de Navidad: se abre el telón y dice «Esta Navidad
// Rendio te premia · Próximamente». No tiene botón para volver a verlo, a
// propósito (Harold: «lo abren hoy y ya mañana no les sale y no pueden volverlo
// a ver»).
//
// «UNA VEZ» VIVE EN LA CUENTA (0180), como la bienvenida (0119)
// profiles.announcements_seen = { clave: fecha } llega con el perfil. La marca
// del teléfono (localStorage) queda de respaldo: sin señal al marcar, o una base
// sin 0180. Solo con la del teléfono les saldría varias veces: en iPhone, Safari
// y el ícono del inicio no comparten almacenamiento.
//
// SE MARCA AL APARECER, no al cerrarlo: si cierra la app a mitad de la
// animación, igual ya lo vio.
//
// CUÁNDO SALE
// Al entrar a Inicio (lo llama aux-rx-inicio.js en after()), 0,9 s después, para
// que la app aparezca primero. Nunca con un viaje en curso, ni en la bienvenida,
// ni encima de otra hoja, ni con la pestaña en segundo plano; en esos casos
// espera a la próxima entrada. Las dos ilustraciones se cargan ANTES de abrir: si
// no llegan, no sale y no se marca.
//
// ES EL ÚNICO PUNTO DE LA APP QUE SE ABRE SOLO. El diseño del rol pide que nada se
// abra sin que lo toquen; esta es la excepción que pidió Harold, una vez por
// persona.
//
// CÓMO SE PINTA
// Usa la hoja del shell (AuxShell.sheet) para heredar el velo, el toque afuera y
// el botón atrás del teléfono, y la convierte en tarjeta centrada con dos clases
// (rx-nv-bg / rx-nv). El aspecto está en rx-aux-anuncio.css.
//
// PARA CAMBIAR DE ANUNCIO: otra `key` (y su contenido en html()). Para apagarlo:
// `activo: false`. Pasada la fecha `hasta` deja de salir solo.
(function () {
  'use strict';

  const ANUNCIO = {
    key: 'navidad-2026-expectativa',
    activo: true,
    // Días de Bogotá, inclusive. Después de Navidad «Próximamente» ya no aplica.
    desde: '2026-11-26',
    hasta: '2026-12-25',
    img: ['assets/navidad/telon.svg', 'assets/navidad/cenefa.svg'],
  };
  const TZ = 'America/Bogota';
  const LS = 'rendio.aux.anuncio.';
  const ESPERA_MS = 900;      // la app primero, el anuncio después
  const CARGA_MS = 6000;      // sin ilustraciones en este tiempo: otro día
  const ANCHO = 342, ALTO = 452;

  const AX = () => window.Auxiliar || null;
  const SH = () => window.AuxShell || null;
  const safe = (f, fb) => { try { const v = f(); return v === undefined ? fb : v; } catch (_) { return fb; } };

  function perfil() { return safe(() => (AX() && AX().state && AX().state.profile) || null, null); }
  function quien() { const p = perfil(); return p && p.id ? String(p.id) : null; }

  function hoy() {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
    catch (_) { return new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10); }
  }
  function enFecha() { const d = hoy(); return d >= ANUNCIO.desde && d <= ANUNCIO.hasta; }

  // ── «Ya lo vio» ───────────────────────────────────────────────────────────
  function vistoCuenta() {
    const p = perfil();
    return !!(p && p.announcements_seen && p.announcements_seen[ANUNCIO.key]);
  }
  function vistoTel() {
    const id = quien();
    if (!id) return false;
    return safe(() => !!localStorage.getItem(LS + ANUNCIO.key + '.' + id), false);
  }
  // A la cuenta, sin esperar la red. Una vez por cuenta y sesión; si falla, la
  // próxima entrada lo reintenta (visto() sube la marca del teléfono).
  const subidas = new Set();
  function subir() {
    const id = quien();
    if (!id || vistoCuenta() || subidas.has(id) || id.startsWith('preview-')) return;
    const A = window.Api;
    if (!A || typeof A.markAnnouncementSeen !== 'function') return;
    subidas.add(id);
    Promise.resolve().then(() => A.markAnnouncementSeen(ANUNCIO.key)).then((lista) => {
      // El perfil en memoria queda al día: no depende de volver a cargarlo.
      const q = perfil();
      if (q && String(q.id) === id) {
        q.announcements_seen = (lista && typeof lista === 'object') ? lista
          : Object.assign({}, q.announcements_seen, { [ANUNCIO.key]: new Date().toISOString() });
      }
    }).catch((e) => {
      subidas.delete(id);
      console.warn('[AuxAnuncio] no se pudo guardar el anuncio visto en la cuenta:', e && e.message);
    });
  }
  function visto() {
    if (vistoCuenta()) return true;
    const t = vistoTel();
    if (t) subir();            // lo vio en este teléfono sin señal: que la cuenta lo sepa
    return t;
  }
  function marcar() {
    const id = quien();
    if (id) safe(() => localStorage.setItem(LS + ANUNCIO.key + '.' + id, new Date().toISOString()), null);
    subir();
  }

  // ── «Le toca ahora» ───────────────────────────────────────────────────────
  function enCurso() {
    const a = AX(); const ri = window.AuxRxInicio;
    if (!a || typeof a.upcoming !== 'function' || !ri || typeof ri.isLive !== 'function') return false;
    return safe(() => (a.upcoming() || []).some(ri.isLive), false);
  }
  function raiz() { return document.getElementById('auxiliar-ui'); }
  function enInicio() {
    const sh = SH();
    if (!sh || typeof sh.on !== 'function' || !sh.on() || typeof sh.current !== 'function') return false;
    const c = safe(() => sh.current(), null);
    return !!(c && c.id === 'home' && c.tab === 'inicio');
  }
  // Le falta verlo: encendido, en fecha, es un tripulante y no lo ha visto. Es lo
  // que NO cambia de un momento a otro; lo demás (dónde está, qué tiene abierto)
  // se mira justo antes de abrir.
  function pendiente() {
    if (!ANUNCIO.activo || !enFecha()) return false;
    const p = perfil();
    if (!p || !p.id || p.role !== 'auxiliar' || p.must_change_password) return false;
    return !visto();
  }
  function puede() {
    if (!pendiente()) return false;
    const p = perfil();
    // Solo con los viajes ya cargados: sin señal, lo primero que debe ver es que
    // no hay señal (y sin viajes no se sabe si hay uno en curso). La vista previa
    // local nunca tiene datos; ahí se deja pasar para poder mirarlo.
    const st = safe(() => AX().state, null) || {};
    if (st.source !== 'live' && !String(p.id).startsWith('preview-')) return false;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
    // Con «Hay una versión nueva · Actualizar» en pantalla (index.html) no sale:
    // si toca Actualizar la app se recarga y lo habría perdido sin verlo. Sale
    // después de actualizar, o la próxima vez que abra.
    if (typeof document !== 'undefined' && document.getElementById('sw-update-toast')) return false;
    if (!enInicio() || enCurso()) return false;
    const r = raiz();
    if (!r || r.querySelector('.rx-sheet-bg')) return false;   // ya hay una hoja arriba
    return true;
  }

  // ── Las ilustraciones, antes de abrir ─────────────────────────────────────
  let cargadas = null;
  function cargar() {
    if (cargadas) return cargadas;
    const una = (src) => new Promise((ok) => {
      const im = new Image();
      im.onload = () => ok(true);
      im.onerror = () => ok(false);
      im.src = src;
    });
    const todas = Promise.all(ANUNCIO.img.map(una)).then((r) => r.every(Boolean));
    const tope = new Promise((ok) => setTimeout(() => ok(false), CARGA_MS));
    cargadas = Promise.race([todas, tope]).then((ok) => { if (!ok) cargadas = null; return ok; });
    return cargadas;
  }

  // ── El popup ──────────────────────────────────────────────────────────────
  function ic(n, s) { const sh = SH(); return sh && typeof sh.ic === 'function' ? sh.ic(n, s) : ''; }
  const DESTELLO = '<svg class="rx-nv-dest" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z"/></svg>';
  // La nieve: dónde nace cada copo (dentro de la tarjeta de 342×452), tamaño,
  // fuerza, cuánto tarda en caer y en qué punto de la caída arranca. Arriba del
  // escenario (b, cae 34 px) y a los lados del título (a, cae 56 px): nunca pasa
  // por encima del texto.
  const COPOS = [
    ['b', 108, 44, 4, .5, 6, -1], ['b', 128, 50, 3, .4, 7, -4], ['b', 150, 42, 5, .3, 5.5, -2.5],
    ['b', 170, 52, 3, .5, 6.5, -5], ['b', 190, 44, 4, .35, 7.5, -3], ['b', 206, 50, 3, .45, 6, -.5],
    ['a', 52, 236, 4, .4, 8, -2], ['a', 64, 244, 3, .3, 9, -6], ['a', 276, 238, 3, .45, 7, -3.5], ['a', 288, 246, 4, .3, 8.5, -1],
  ];
  function html() {
    const copos = COPOS.map(([k, x, y, s, o, t, d]) =>
      `<span class="rx-nv-copo ${k}" aria-hidden="true" style="left:${x}px;top:${y}px;--s:${s}px;--o:${o};--t:${t}s;--dl:${d}s"></span>`).join('');
    return '<div class="rx-nv-fit"><div class="rx-nv-card">'
      + '<span class="rx-nv-glow" aria-hidden="true"></span>'
      + `<img class="rx-nv-telon" src="${ANUNCIO.img[0]}" alt="" aria-hidden="true" width="${ANCHO}" height="${ALTO}">`
      + copos
      + '<div class="rx-nv-in">'
      +   '<div class="rx-nv-fichas" aria-hidden="true">'
      +     '<span class="rx-nv-f" style="--k:0"><b>?</b></span>'
      +     '<span class="rx-nv-f" style="--k:1"><b>?</b></span>'
      +     '<span class="rx-nv-regalo"><span>' + ic('Gift', 20) + '</span></span>'
      +     DESTELLO
      +   '</div>'
      +   '<h2 class="rx-nv-t" id="rx-nv-t">'
      +     '<span class="rx-nv-t1 rx-nv-r" style="--d:0">Esta Navidad</span>'
      +     '<span class="rx-nv-t2 rx-nv-r" style="--d:1"><i aria-hidden="true"></i>Rendio</span>'
      +     '<span class="rx-nv-t3 rx-nv-r" style="--d:2">te premia</span>'
      +   '</h2>'
      +   '<span class="rx-nv-prox rx-nv-r" style="--d:3">Próximamente</span>'
      +   '<button type="button" class="rx-btn pri rx-nv-ok rx-nv-r" style="--d:4" data-nv="cerrar">Estaré pendiente</button>'
      + '</div>'
      + '<span class="rx-nv-pano l" aria-hidden="true"></span><span class="rx-nv-pano r" aria-hidden="true"></span>'
      + `<img class="rx-nv-cenefa" src="${ANUNCIO.img[1]}" alt="" aria-hidden="true" width="${ANCHO}" height="${ALTO}">`
      + '<button type="button" class="rx-nv-x" data-nv="cerrar" aria-label="Cerrar">' + ic('X', 20) + '</button>'
      + '</div></div>';
  }

  let abierto = false;
  function vestir(el) {
    const bg = el.parentNode;
    el.classList.add('rx-nv');
    if (bg && bg.classList) bg.classList.add('rx-nv-bg');
    el.setAttribute('aria-labelledby', 'rx-nv-t');
    // En teléfonos angostos o bajitos la tarjeta se encoge entera (ilustración y
    // texto juntos), nunca se corta.
    const fit = el.querySelector('.rx-nv-fit');
    if (fit && bg) {
      const w = bg.clientWidth || 0, h = bg.clientHeight || 0;
      const k = (w && h) ? Math.min(1, (w - 32) / ANCHO, (h - 32) / ALTO) : 1;
      if (k > 0 && k < 1) fit.style.setProperty('--nv-k', k.toFixed(4));
    }
    el.addEventListener('click', (e) => {
      const b = e.target && e.target.closest ? e.target.closest('[data-nv="cerrar"]') : null;
      if (b) { const sh = SH(); if (sh && sh.closeSheet) sh.closeSheet(); }
    });
    // Si otra hoja reemplaza el contenido (el shell reutiliza la misma), se le
    // devuelve su forma de hoja normal.
    if (typeof MutationObserver === 'function') {
      const mo = new MutationObserver(() => {
        if (el.querySelector('.rx-nv-fit')) return;
        el.classList.remove('rx-nv');
        if (bg && bg.classList) bg.classList.remove('rx-nv-bg');
        el.removeAttribute('aria-labelledby');
        mo.disconnect();
      });
      mo.observe(el, { childList: true });
    }
  }
  function abrir() {
    const sh = SH();
    if (abierto || !sh || typeof sh.sheet !== 'function') return false;
    const el = sh.sheet(html(), { after: vestir, onClose() { abierto = false; } });
    if (!el) return false;
    abierto = true;
    marcar();
    return true;
  }

  // ── La entrada a Inicio ───────────────────────────────────────────────────
  // Inicio avisa cada vez que se pinta o se repasa. Si a la persona le falta verlo
  // se arma el reloj, y «¿le toca ahora?» se contesta cuando el reloj suena, no
  // en el aviso: al salir de la bienvenida Inicio avisa mientras esa pantalla
  // todavía se está yendo, y decidir en ese instante lo dejaba sin salir.
  // En un teléfono que instala la app por primera vez, el service worker toma el
  // control unos segundos después de abrir y ahí aparece «Hay una versión nueva».
  // Se le da un momento para que ese aviso salga ANTES que el anuncio (y entonces
  // puede() lo frena). Con la app ya instalada no hay espera.
  const SW_MS = 5000;
  async function swAsentado() {
    const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : null;
    if (!sw || sw.controller) return;
    await Promise.race([Promise.resolve(sw.ready).catch(() => {}), new Promise((r) => setTimeout(r, SW_MS))]);
    await new Promise((r) => setTimeout(r, 400));    // el aviso se pinta al tomar control
  }

  let reloj = null;
  function alEntrar() {
    if (abierto || reloj || !pendiente()) return;
    reloj = setTimeout(async () => {
      if (!puede()) { reloj = null; return; }
      try { await swAsentado(); } catch (_) { /* sin service worker: se sigue */ }
      const ok = puede() && await cargar();
      reloj = null;
      if (!ok || abierto || !puede()) return;
      abrir();
    }, ESPERA_MS);
  }
  // La app vuelve al frente (estaba en segundo plano cuando Inicio avisó).
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') alEntrar();
    });
  }

  window.AuxAnuncio = {
    alEntrar,
    // Para pruebas.
    _: { ANUNCIO, pendiente, puede, visto, vistoCuenta, vistoTel, marcar, abrir, cargar, html, enFecha, LS,
      olvidarCarga() { cargadas = null; } },
  };
})();
