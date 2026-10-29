// aux-pausa.js — App del tripulante en pausa (28-oct-2026).
//
// La profa la apagó para los tripulantes: «hemos evidenciado varios
// inconvenientes; para pedir traslados retomen el link anterior». Con
// RENDIO_CONFIG.APP_TRIPULANTES_PAUSADA = true, el tripulante que entra (con
// sesión, recién registrado o retomando el registro) ve SOLO esta pantalla:
// el mensaje y el botón al formulario de siempre. No ve Inicio, Viajes ni
// Pagos, y «Crear cuenta» del login tampoco abre el registro.
// Conductores y jefes no pasan por aquí: su app sigue igual.
//
// Para volver a abrirla: false en config.js de dev Y de main + subir el
// CACHE_VERSION del sw.js (el SW sirve primero lo cacheado).
(function () {
  'use strict';

  function on() {
    return !!(window.RENDIO_CONFIG && window.RENDIO_CONFIG.APP_TRIPULANTES_PAUSADA === true);
  }
  function link() {
    return (window.RENDIO_CONFIG && window.RENDIO_CONFIG.APP_TRIPULANTES_LINK) || '';
  }
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // opts.sesion: true = ya entró con su cuenta (el botón de abajo cierra la
  // sesión); false = viene del login (el botón vuelve al login).
  function show(opts) {
    const sesion = !!(opts && opts.sesion);
    const url = link();
    // El splash y el login se esconden: esta pantalla queda sola.
    document.getElementById('screen-login')?.classList.add('hidden');
    let el = document.getElementById('aux-pausa');
    if (!el) {
      el = document.createElement('section');
      el.id = 'aux-pausa';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('aria-labelledby', 'aux-pausa-t');
      document.body.appendChild(el);
    }
    el.innerHTML = `<div class="axp-box">
      <img class="axp-logo" src="assets/logo-enterprise.png" alt="Rendio Enterprise" />
      <div class="axp-card">
        <div class="axp-ic" aria-hidden="true">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
        </div>
        <h1 id="aux-pausa-t">Estamos trabajando para mejorar el servicio</h1>
        <p>Hemos evidenciado varios inconvenientes con la app, así que la pausamos mientras los resolvemos.</p>
        <p><b>Para pedir tu traslado, usa el link de siempre:</b></p>
        ${url ? `<a class="axp-btn" href="${esc(url)}" target="_blank" rel="noopener">Pedir mi traslado</a>
        <a class="axp-url" href="${esc(url)}" target="_blank" rel="noopener">${esc(url.replace(/^https?:\/\//, ''))}</a>` : ''}
        <p class="axp-note">Te avisaremos cuando la app vuelva a estar disponible. Gracias por tu paciencia.</p>
      </div>
      <button type="button" class="axp-out" data-axp="${sesion ? 'logout' : 'back'}">${sesion ? 'Cerrar sesión' : 'Volver'}</button>
    </div>`;
    el.querySelector('[data-axp]')?.addEventListener('click', async (e) => {
      const accion = e.currentTarget.getAttribute('data-axp');
      if (accion === 'back') {
        el.remove();
        document.getElementById('screen-login')?.classList.remove('hidden');
        return;
      }
      try { if (window.Api && typeof Api.signOut === 'function') await Api.signOut(); } catch (_) {}
      location.reload();
    });
  }

  window.AuxPausa = { on, show };
})();
