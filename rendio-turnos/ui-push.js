// ui-push.js — UI helpers, PWA install prompt, Web Push y arranque (DOMContentLoaded).
// Extraído de app.js (split mecánico 2026-07-10, sin cambios de lógica).
// Comparte scope global con los demás módulos; el orden de carga está en index.html.
  // ====================================================================
  // UI helpers
  // ====================================================================

  // ====================================================================
  // PWA install prompt
  // ====================================================================

  let deferredInstallPrompt = null;

  function setupInstallPrompt() {
    const btn = $('#install-btn');
    const btnMobile = $('#install-btn-mobile');
    const iosModal = $('#ios-install-modal');
    const iosClose = $('#ios-install-close');

    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
    if (isStandalone) return; // ya instalado

    const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      // Al admin solo se le ofrece instalar desde el celular (ver setupPushUI).
      if (state.profile?.role === 'admin' && !adminOnPhone()) return;
      btn.classList.remove('hidden');
      btnMobile.classList.remove('hidden');
    });

    if (isIos && (state.profile?.role !== 'admin' || adminOnPhone())) {
      // iOS Safari nunca dispara beforeinstallprompt; mostramos botón con instrucciones.
      btn.classList.remove('hidden');
      btnMobile.classList.remove('hidden');
    }

    const onClick = async () => {
      if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        const { outcome } = await deferredInstallPrompt.userChoice;
        if (outcome === 'accepted') {
          btn.classList.add('hidden');
          btnMobile.classList.add('hidden');
        }
        deferredInstallPrompt = null;
      } else if (isIos) {
        iosModal.classList.remove('hidden');
      } else {
        toast('Para instalar: menú del navegador → "Instalar app" / "Agregar a inicio".');
      }
    };
    // Expuesto para que el rol Auxiliar (UI aparte del shell) también ofrezca "Instalar".
    window.rendioInstall = { prompt: onClick, isIos };
    btn.addEventListener('click', onClick);
    btnMobile.addEventListener('click', onClick);
    iosClose.addEventListener('click', () => iosModal.classList.add('hidden'));
    iosModal.addEventListener('click', (e) => {
      if (e.target.id === 'ios-install-modal') iosModal.classList.add('hidden');
    });

    window.addEventListener('appinstalled', () => {
      btn.classList.add('hidden');
      btnMobile.classList.add('hidden');
      toast('¡App instalada!');
    });
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add('hidden'), 2500);
  }

  // ====================================================================
  // Web Push (Fase 5)
  // ====================================================================

  const VAPID_PUBLIC_KEY = (window.RENDIO_CONFIG && window.RENDIO_CONFIG.VAPID_PUBLIC_KEY) || '';

  function pushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && !!VAPID_PUBLIC_KEY;
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  // Suscribe el dispositivo y guarda la suscripción en la BD.
  async function enablePush() {
    if (!pushSupported()) { toast('Las notificaciones no están disponibles en este dispositivo.'); return; }
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { toast('No autorizaste las notificaciones.'); return; }
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });
      }
      const json = sub.toJSON();
      await Api.savePushSubscription({
        profileId: state.profile.id,
        endpoint: sub.endpoint,
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
        userAgent: navigator.userAgent,
      });
      toast('🔔 Notificaciones activadas.');
      setupPushUI(); // oculta el botón
    } catch (e) {
      toast('No se pudieron activar las notificaciones.');
      console.error(e);
    }
  }

  // Inyecta el botón "Activar notificaciones" si aplica (no soportado / ya
  // suscrito / permiso denegado → no se muestra).
  async function setupPushUI() {
    const existing = document.getElementById('enable-push-bar');
    // El admin en el COMPUTADOR sigue sin barra: es un módulo de escritorio y la
    // barra se quitó a propósito en junio para no ensuciar la consola. En el
    // CELULAR sí se muestra: es el único canal por el que un jefe se entera de
    // una falla mecánica a las 4 de la mañana sin tener la pantalla abierta.
    if (state.profile?.role === 'admin' && !adminOnPhone()) { existing?.remove(); return; }
    if (!pushSupported() || Notification.permission === 'denied') { existing?.remove(); return; }
    let alreadySub = false;
    try {
      const reg = await navigator.serviceWorker.ready;
      alreadySub = !!(await reg.pushManager.getSubscription());
    } catch (e) { /* ignore */ }
    if (alreadySub) { existing?.remove(); return; }

    // Contenedor según el rol (conductor: dentro de la pestaña Inicio).
    const host = state.profile.role === 'admin'
      ? document.getElementById('app-shell')
      : document.querySelector('#driver-tabs-root [data-dtab="home"]');
    if (!host) return;
    if (existing) return; // ya está
    const bar = document.createElement('div');
    bar.id = 'enable-push-bar';
    bar.className = 'push-bar';
    const texto = state.profile.role === 'admin'
      ? '🔔 Activa las notificaciones en este celular: es como te enteras de una falla mecánica o una emergencia de madrugada, sin tener la app abierta.'
      : '🔔 Activa las notificaciones: mensajes de tus pasajeros, cambios de ruta, turnos y horarios.';
    bar.innerHTML = `<span>${texto}</span>
      <button id="enable-push-btn" class="wk-btn wk-coord-on" style="flex:0 0 auto;">Activar</button>`;
    // Admin: arriba del shell. Conductor: al final del Inicio (debajo de las 2 tarjetas).
    if (state.profile.role === 'admin') host.insertBefore(bar, host.firstChild);
    else host.appendChild(bar);
    document.getElementById('enable-push-btn').addEventListener('click', enablePush);
  }

  // Aviso a los jefes de operación por una eventualidad.
  //
  // El push sale del dispositivo de QUIEN REPORTA: el conductor y el tripulante
  // siempre tienen la app abierta en ese momento, así que no hace falta que la
  // base llame a nadie. Lo que nace en el servidor —el vigilante de rutas, la API
  // de vuelos— va por otro camino (bandeja de salida, migración 0064).
  //
  // La URL lleva a la eventualidad exacta, no a la app en general: a las 4am
  // nadie quiere ponerse a buscar cuál fue.
  async function notifyOps(title, body, incidentId) {
    try {
      const ids = await Api.opsAlertProfileIds();
      if (!ids || !ids.length) return;
      const url = incidentId ? `/#/eventualidades?ev=${incidentId}` : '/#/eventualidades';
      await Api.sendPush({ profileIds: ids, title, body, url });
    } catch (e) { /* el reporte ya quedó guardado; el aviso es best-effort */ }
  }

  // Notificación best-effort (si la Edge Function no está desplegada, ignora).
  async function notify(profileIds, title, body, url) {
    if (!profileIds || !profileIds.length) return;
    try { await Api.sendPush({ profileIds, title, body, url: url || '/' }); }
    catch (e) { /* push opcional: nunca rompe el flujo principal */ }
  }

  document.addEventListener('DOMContentLoaded', boot);
