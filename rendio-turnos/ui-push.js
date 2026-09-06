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
    // El vigilante de abajo puede dispararlo antes de que alguien entre.
    if (!state || !state.profile) return;
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
    //
    // OJO CON EL ADMIN: antes esta barra se metía como primer hijo de #app-shell,
    // pero en el rol admin ese elemento es una REJILLA con las posiciones puestas
    // a mano (#admin-side en la columna 1; #admin-mhead y #app-main en la 2). Un
    // hijo suelto, sin posición asignada, lo colocaba el navegador solo: caía en
    // la columna del sidebar y partía el texto en siete líneas dentro de 330 px.
    // Se veía en la franja donde los dos umbrales se contradecían (ver
    // adminOnPhone en core.js). Metiéndola en #app-main —la columna del
    // contenido— queda bien a cualquier ancho, aunque los cortes vuelvan a
    // separarse: no depende de que la rejilla tenga una columna o dos.
    const host = state.profile.role === 'admin'
      ? document.getElementById('app-main')
      : document.querySelector('#driver-tabs-root [data-dtab="home"]');
    if (!host) return;
    if (existing) return; // ya está
    const bar = document.createElement('div');
    bar.id = 'enable-push-bar';
    bar.className = 'push-bar';
    // Corto a propósito: es un aviso, no un instructivo. El detalle de por qué
    // importa ya lo sabe quien lo activa, y siete líneas en un aviso no se leen.
    const texto = state.profile.role === 'admin'
      ? '🔔 Activa las notificaciones y entérate de una emergencia de madrugada sin tener la app abierta.'
      : '🔔 Activa las notificaciones: mensajes de tus pasajeros, cambios de ruta, turnos y horarios.';
    bar.innerHTML = `<span>${texto}</span>
      <button id="enable-push-btn" class="wk-btn wk-coord-on" style="flex:0 0 auto;">Activar</button>`;
    // Admin: arriba del contenido. Conductor: al final del Inicio (bajo las 2 tarjetas).
    if (state.profile.role === 'admin') host.insertBefore(bar, host.firstChild);
    else host.appendChild(bar);
    document.getElementById('enable-push-btn').addEventListener('click', enablePush);
  }

  // El "¿es un celular?" se evaluaba UNA sola vez, al entrar. Si el jefe cambiaba
  // el zoom del navegador o el tamaño de la ventana, la barra se quedaba puesta
  // (o no aparecía) hasta recargar. Ahora se vuelve a decidir cuando la condición
  // cambia de verdad, que es como se descubrió esto: con el zoom del navegador,
  // una ventana de escritorio baja de 820 px CSS y la app la toma por celular.
  function watchAdminPhone() {
    if (!window.matchMedia) return;
    const mq = window.matchMedia('(max-width: 768px)');
    const alCambiar = () => { setupPushUI().catch(() => {}); };
    if (mq.addEventListener) mq.addEventListener('change', alCambiar);
    else if (mq.addListener) mq.addListener(alCambiar);   // Safari viejo
  }
  watchAdminPhone();

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
