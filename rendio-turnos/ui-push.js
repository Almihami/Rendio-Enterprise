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

  // ms opcional: los avisos que dicen QUÉ HACER (ir a los ajustes del teléfono)
  // no se alcanzan a leer en 2,5 s.
  function toast(msg, ms) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add('hidden'), ms || 2500);
  }

  // ====================================================================
  // Web Push (Fase 5)
  // ====================================================================

  const VAPID_PUBLIC_KEY = (window.RENDIO_CONFIG && window.RENDIO_CONFIG.VAPID_PUBLIC_KEY) || '';

  function pushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && !!VAPID_PUBLIC_KEY;
  }
  // iPhone/iPad en Safari SIN instalar: iOS solo entrega avisos a la app que está
  // en la pantalla de inicio. Ahí «Activar notificaciones» no puede funcionar, y
  // hay que decirle a la persona qué hacer en vez de un «no disponible» a secas.
  function pushNeedsInstall() {
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    return ios && !standalone && !('PushManager' in window);
  }
  window.rendioPushNeedsInstall = pushNeedsInstall;
  const IOS_PUSH_MSG = 'En iPhone los avisos solo llegan con Rendio en tu pantalla de inicio: toca Compartir → «Agregar a inicio» y ábrela desde el ícono.';

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
    if (!pushSupported()) { toast(pushNeedsInstall() ? IOS_PUSH_MSG : 'Las notificaciones no están disponibles en este dispositivo.'); return; }
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
    if (state.profile.role === 'admin') refreshAdminPushItem();
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

  // ====================================================================
  // Un lugar FIJO para las notificaciones (pedido de la profa, 14-oct-2026)
  // ====================================================================
  // La barra de arriba desaparece apenas se activan, y después no quedaba
  // dónde ver si seguían activas ni cómo comprobar que suenan. Ahora:
  //   · conductor → una fila en su Perfil (driver-perfil.js);
  //   · jefe      → «Notificaciones» al pie del menú (#adm-push); en el celular
  //                 es el menú ☰, que es donde la profa pidió encontrarlo;
  //   · tripulante → ya lo tenía en su Perfil («Notificaciones y app»).

  // Estado en ESTE dispositivo: 'on' | 'off' | 'blocked' | 'install' (iPhone
  // sin la app en la pantalla de inicio) | 'na' (el navegador no las soporta).
  async function pushStatus() {
    if (!pushSupported()) return pushNeedsInstall() ? 'install' : 'na';
    if (Notification.permission === 'denied') return 'blocked';
    try {
      // serviceWorker.ready no resuelve NUNCA si el SW no se registró: tope de 3 s.
      const reg = await Promise.race([navigator.serviceWorker.ready, new Promise(r => setTimeout(() => r(null), 3000))]);
      if (!reg || !reg.pushManager) return 'na';
      return (await reg.pushManager.getSubscription()) ? 'on' : 'off';
    } catch (_) { return 'na'; }
  }
  const PUSH_STATUS_TXT = { on: 'Activas · probar', off: 'Actívalas', blocked: 'Bloqueadas', install: 'Instala la app', na: 'No disponibles' };

  // Al tocar la fila. Apagadas → se activan. Activas → se manda UNA DE PRUEBA:
  // es la única forma de saber que de verdad suenan en este celular. Las demás
  // → se dice qué hacer, no un «no disponible» a secas.
  async function pushRowTap() {
    const s = await pushStatus();
    if (s === 'off') { await enablePush(); return; }
    if (s === 'on') { await pushSendTest(); return; }
    toast(s === 'blocked'
      ? 'Están bloqueadas para Rendio. Actívalas en los ajustes del teléfono (Notificaciones) y vuelve a abrir la app.'
      : s === 'install' ? IOS_PUSH_MSG
      : 'Este navegador no permite notificaciones. Abre Rendio en Chrome o Safari actualizado.', 6000);
  }

  // La prueba vuelve a guardar la suscripción antes de enviar: si la base la
  // borró (send-push limpia las que el servicio de avisos da por vencidas), el
  // celular cree que están activas y no le llega nada. Así se arregla sola.
  async function pushSendTest() {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        const json = sub.toJSON();
        await Api.savePushSubscription({
          profileId: state.profile.id, endpoint: sub.endpoint,
          p256dh: json.keys.p256dh, auth: json.keys.auth, userAgent: navigator.userAgent,
        });
      }
      const r = await Api.sendPush({
        profileIds: [state.profile.id],
        title: '🔔 Prueba de Rendio',
        body: 'Si ves esto, los avisos sí te llegan.',
        url: '/',
      });
      toast(r && r.sent > 0
        ? 'Te enviamos una de prueba: debe llegarte en unos segundos.'
        : 'La prueba no salió. Vuelve a intentarlo en un rato.', 5000);
    } catch (e) {
      toast(navigator.onLine === false
        ? 'Sin conexión: no se pudo enviar la prueba.'
        : 'No se pudo enviar la prueba. Intenta de nuevo en un rato.', 4000);
    }
  }

  // Menú del jefe: el texto chico dice el estado sin abrir nada, y el punto de
  // color (CSS, por data-st) se ve aunque el menú esté colapsado.
  async function refreshAdminPushItem() {
    const it = document.getElementById('adm-push'); if (!it) return;
    const s = await pushStatus();
    it.dataset.st = s;
    const tx = document.getElementById('adm-push-st');
    if (tx) tx.textContent = PUSH_STATUS_TXT[s];
    it.title = 'Notificaciones: ' + PUSH_STATUS_TXT[s].toLowerCase();
  }
  // Delegado: el sidebar ya existe en el HTML, pero así no depende del orden de carga.
  const onAdmPush = async (e) => {
    if (!e.target.closest || !e.target.closest('#adm-push')) return;
    if (e.type === 'keydown') { if (e.key !== 'Enter' && e.key !== ' ') return; e.preventDefault(); }
    await pushRowTap();
    refreshAdminPushItem();
  };
  document.addEventListener('click', onAdmPush);
  document.addEventListener('keydown', onAdmPush);

  // El aviso a los jefes por una eventualidad ya NO sale de aquí (0117): lo
  // encola la base al guardar el reporte y lo manda dispatch-notifications, como
  // los avisos del vigilante de rutas. Desde el celular de quien reportaba no
  // salía nunca: la RLS no le deja a un conductor ni a un tripulante ver quiénes
  // son los jefes, así que la lista quedaba vacía.

  // Notificación best-effort (si la Edge Function no está desplegada, ignora).
  async function notify(profileIds, title, body, url) {
    if (!profileIds || !profileIds.length) return;
    try { await Api.sendPush({ profileIds, title, body, url: url || '/' }); }
    catch (e) { /* push opcional: nunca rompe el flujo principal */ }
  }

  document.addEventListener('DOMContentLoaded', boot);
