// native.js — Puente con la app de Play Store y App Store (Capacitor, 31-oct-2026).
//
// La app de las tiendas es ESTA MISMA web metida en un contenedor nativo
// (rendio-app/). En rendio.co y en la PWA este archivo no hace nada:
// RendioNative.isNative es false y todo sigue como siempre.
//
// Dentro de la app nativa resuelve lo que una página web no puede:
//   · GPS que sigue con Waze abierto y la pantalla apagada (driver-rutas.js).
//   · El ping de ubicación por la red nativa: Android frena las peticiones del
//     WebView a los 5 min en segundo plano (api.js → sendDriverLocation).
//   · Avisos push nativos (FCM en Android, APNs en iPhone). Se guardan en
//     push_subscriptions con endpoint «fcm:<token>» / «apns:<token>»; send-push
//     y dispatch-notifications los reconocen por ese prefijo.
//   · Enlaces afuera (Waze, WhatsApp, tel:, comprobantes): se abren en su app.
//   · Descargas (los Excel): el WebView no descarga; se ofrece «Compartir/Guardar».
//   · «Actualiza la app»: si la versión instalada es más vieja que la mínima.
//   · Botón atrás de Android: minimiza en vez de cerrar (el GPS sigue).
//
// Se carga justo después de config.js. Los plugins se piden por nombre a
// Capacitor (no hay empaquetador): window.Capacitor lo inyecta la app nativa.
(function () {
  const C = window.Capacitor;
  const isNative = !!(C && typeof C.isNativePlatform === 'function' && C.isNativePlatform());
  const platform = isNative ? C.getPlatform() : 'web';
  const cfg = (window.RENDIO_CONFIG && window.RENDIO_CONFIG.APP) || {};

  const plugins = {};
  function P(name) {
    if (!isNative) return null;
    if (!plugins[name]) plugins[name] = (C.Plugins && C.Plugins[name]) || C.registerPlugin(name);
    return plugins[name];
  }
  const say = (m, ms) => { if (typeof window.toast === 'function') window.toast(m, ms); };

  if (!isNative) {
    window.RendioNative = { isNative: false, platform: 'web' };
    return;
  }

  document.documentElement.classList.add('rn-native', 'rn-' + platform);
  // Lo propio de la app: sin «Instalar app» (ya está instalada) y las dos
  // ventanas de este archivo (aviso del GPS y «Actualiza Rendio»).
  const css = document.createElement('style');
  css.textContent = '.rn-native #install-btn,.rn-native #install-btn-mobile{display:none!important}'
    + '.rn-modal{position:fixed;inset:0;z-index:2147483200;background:rgba(10,10,10,.55);display:flex;align-items:flex-end;justify-content:center;'
    + 'padding:16px 16px calc(16px + env(safe-area-inset-bottom));font-family:Inter,system-ui,-apple-system,sans-serif}'
    + '.rn-modal.rn-fija{background:#0A0A0A;align-items:center}'
    + '.rn-card{background:#fff;color:#0A0A0A;border-radius:20px;padding:22px 20px 18px;max-width:440px;width:100%;box-shadow:0 12px 40px rgba(0,0,0,.3)}'
    + '.rn-card h2{font-size:19px;font-weight:700;margin:0 0 10px}.rn-card p{font-size:15px;line-height:1.45;margin:0 0 10px;color:#1F1F1F}'
    + '.rn-acts{display:flex;gap:10px;justify-content:flex-end;margin-top:14px}'
    + '.rn-btn{background:#F4791F;color:#fff;border:0;border-radius:999px;padding:11px 20px;font-weight:600;font-size:15px}'
    + '.rn-btn.ghost{background:transparent;color:#1F1F1F}';
  document.head.appendChild(css);

  // ── Enlaces afuera ────────────────────────────────────────────────────────────
  // Waze, WhatsApp, Google Maps, tel:, los comprobantes firmados, el link de la
  // pausa del tripulante… En el WebView un target=_blank no abre nada; se le pasa
  // al sistema, que lo abre en la app que corresponda (o en el navegador).
  function esAfuera(url) {
    try {
      const u = new URL(url, location.href);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin !== location.origin;
      return /^(tel|mailto|sms|whatsapp|waze|geo|comgooglemaps):$/.test(u.protocol);
    } catch (_) { return false; }
  }
  function abrirAfuera(url) {
    // openUrl no falla: si nada en el teléfono abre ese enlace, responde completed:false.
    P('AppLauncher').openUrl({ url: String(url) })
      .then((r) => { if (r && r.completed === false) say('No se pudo abrir el enlace.'); })
      .catch(() => say('No se pudo abrir el enlace.'));
  }
  // window.open('', '_blank') y después w.location.href = url (admin-cobro abre
  // la ventana con el toque y la llena cuando el enlace está firmado): se
  // devuelve una «ventana» de mentiras que abre afuera cuando le ponen la url.
  function ventanaDeMentiras(url) {
    const w = {
      closed: false, opener: null,
      close() { w.closed = true; }, focus() {}, blur() {},
      location: {
        get href() { return url || 'about:blank'; },
        set href(u) { abrirAfuera(u); },
        assign(u) { abrirAfuera(u); },
        replace(u) { abrirAfuera(u); },
      },
    };
    return w;
  }
  const openWeb = window.open.bind(window);
  window.open = function (url, target, features) {
    const u = url == null ? '' : String(url);
    if (!u || u === 'about:blank') return ventanaDeMentiras('');
    if (esAfuera(u)) { abrirAfuera(u); return ventanaDeMentiras(u); }
    return openWeb(u, target, features);
  };
  // Los <a target="_blank"> y los <a href="https://otro.sitio">. Va en la fase de
  // burbuja de window: si la pantalla ya manejó el clic (preventDefault), no se
  // abre dos veces.
  window.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button) return;
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || a.hasAttribute('download')) return;
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
    if (a.target === '_blank' || esAfuera(href)) {
      if (!esAfuera(href)) return;
      e.preventDefault();
      abrirAfuera(new URL(href, location.href).href);
    }
  });

  // ── Descargas → Compartir / Guardar ──────────────────────────────────────────
  // Los Excel se bajan con a.href = blob: + a.download + a.click() (balance,
  // horario, cobro, ruta). El WebView ignora el download: el archivo se escribe
  // en la caché de la app y se abre la hoja del sistema para guardarlo o mandarlo.
  function blobABase64(blob) {
    return new Promise((ok, mal) => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result).split(',')[1] || '');
      r.onerror = () => mal(r.error);
      r.readAsDataURL(blob);
    });
  }
  async function guardarArchivo(blob, nombre) {
    const name = String(nombre || 'archivo').replace(/[\\/:*?"<>|]+/g, '_');
    try {
      const data = await blobABase64(blob);
      const res = await P('Filesystem').writeFile({ path: name, data, directory: 'CACHE' });
      await P('Share').share({ title: name, files: [res.uri], dialogTitle: 'Guardar o enviar' });
    } catch (e) {
      // Cerrar la hoja de compartir sin elegir también llega como error.
      if (!/cancel/i.test(String(e && (e.message || e)))) say('No se pudo guardar el archivo.');
    }
  }
  const clickWeb = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    const href = this.href || '';
    if (this.hasAttribute('download') && /^(blob|data):/.test(href)) {
      const nombre = this.getAttribute('download') || 'archivo';
      fetch(href).then((r) => r.blob()).then((b) => guardarArchivo(b, nombre))
        .catch(() => say('No se pudo guardar el archivo.'));
      return;
    }
    return clickWeb.call(this);
  };

  // ── GPS ───────────────────────────────────────────────────────────────────────
  // Durante una vuelta, la ubicación sigue con Waze adelante o la pantalla
  // apagada. En Android eso exige una notificación fija («Rendio está usando tu
  // ubicación»); en iPhone, la barra azul arriba. Antes de pedir el permiso la
  // primera vez se explica para qué (lo exige Google y lo revisa Apple).
  const AVISO_GPS_KEY = 'rn-aviso-gps-v1';
  function avisoGpsVisto() { try { return localStorage.getItem(AVISO_GPS_KEY) === '1'; } catch (_) { return false; } }
  function marcarAvisoGps() { try { localStorage.setItem(AVISO_GPS_KEY, '1'); } catch (_) { /* */ } }
  // «Ahora no»: el Inicio vuelve a pedir el GPS cada vez que se pinta con una
  // vuelta en curso; durante 10 min no se insiste.
  let gpsRechazado = 0;
  let avisoAbierto = null;   // si lo piden dos veces seguidas, una sola ventana
  function avisoGps() {
    if (avisoGpsVisto()) return Promise.resolve(true);
    if (Date.now() - gpsRechazado < 10 * 60 * 1000) return Promise.resolve(false);
    if (avisoAbierto) return avisoAbierto;
    avisoAbierto = new Promise((ok) => {
      const v = document.createElement('div');
      v.className = 'rn-modal';
      v.innerHTML = '<div class="rn-card" role="dialog" aria-modal="true" aria-labelledby="rn-gps-t">'
        + '<h2 id="rn-gps-t">Tu ubicación durante las vueltas</h2>'
        + '<p>Mientras tengas una vuelta en curso, Rendio comparte tu ubicación con los jefes y con los tripulantes que vas a recoger, '
        + '<b>también cuando la app está en segundo plano</b> (por ejemplo, con Waze abierto o la pantalla apagada).</p>'
        + '<p>Al terminar la vuelta se deja de compartir. No se usa para nada más.</p>'
        + '<div class="rn-acts"><button type="button" data-r="no" class="rn-btn ghost">Ahora no</button>'
        + '<button type="button" data-r="si" class="rn-btn">Continuar</button></div></div>';
      document.body.appendChild(v);
      v.addEventListener('click', (e) => {
        const r = e.target.closest && e.target.closest('[data-r]');
        if (!r) return;
        v.remove();
        avisoAbierto = null;
        if (r.dataset.r === 'si') { marcarAvisoGps(); ok(true); } else { gpsRechazado = Date.now(); ok(false); }
      });
    });
    return avisoAbierto;
  }
  // Los watchers del GPS viven en el teléfono, no en la página: si la página se
  // recarga (cerrar sesión, eliminar la cuenta…) Capacitor olvida a quién avisar
  // pero el GPS y la notificación fija siguen. Se anotan aquí y, al cargar, se
  // apagan los que quedaron de la página anterior.
  const GPS_WATCHERS_KEY = 'rn-gps-watchers';
  function watchersAnotados() { try { return JSON.parse(localStorage.getItem(GPS_WATCHERS_KEY) || '[]'); } catch (_) { return []; } }
  function anotarWatchers(ids) { try { localStorage.setItem(GPS_WATCHERS_KEY, JSON.stringify(ids)); } catch (_) { /* */ } }
  function apagarWatchersViejos() {
    const viejos = watchersAnotados();
    if (!viejos.length) return;
    anotarWatchers([]);
    viejos.forEach((id) => P('BackgroundGeolocation').removeWatcher({ id }).catch(() => {}));
  }
  apagarWatchersViejos();
  // La forma de GeolocationPosition, para que onPos de driver-rutas.js no cambie.
  function comoPosicion(l) {
    return {
      coords: {
        latitude: l.latitude, longitude: l.longitude, accuracy: l.accuracy,
        altitude: l.altitude, altitudeAccuracy: l.altitudeAccuracy,
        heading: l.bearing, speed: l.speed,
      },
      timestamp: l.time || Date.now(),
    };
  }
  const geo = {
    // Devuelve (promesa) el id para clear(), o null si la persona no aceptó.
    async watch(onPos, onErr) {
      if (!(await avisoGps())) { if (onErr) onErr({ code: 'NOT_AUTHORIZED' }); return null; }
      // Android 13+: sin este permiso no se ve la notificación fija y el sistema
      // puede cortar el GPS en segundo plano.
      if (platform === 'android') {
        try { await P('PushNotifications').requestPermissions(); } catch (_) { /* sigue igual */ }
      }
      const id = await P('BackgroundGeolocation').addWatcher({
        backgroundTitle: 'Rendio · vuelta en curso',
        backgroundMessage: 'Compartiendo tu ubicación con los jefes y tus pasajeros.',
        requestPermissions: true,
        stale: false,
        distanceFilter: 15,
      }, (loc, err) => {
        if (err) {
          if (err.code === 'NOT_AUTHORIZED') {
            say('Rendio no tiene permiso de ubicación. Actívalo en los ajustes del teléfono.', 6000);
          }
          if (onErr) onErr(err);
          return;
        }
        if (loc) onPos(comoPosicion(loc));
      });
      anotarWatchers(watchersAnotados().concat(id));
      return id;
    },
    clear(id) {
      if (id == null) return;
      anotarWatchers(watchersAnotados().filter((x) => x !== id));
      P('BackgroundGeolocation').removeWatcher({ id }).catch(() => {});
    },
  };

  // ── Peticiones que no deben frenarse en segundo plano ────────────────────────
  // Inserta una fila en la API REST de Supabase por la red NATIVA (CapacitorHttp)
  // con la sesión del usuario: la misma RLS que el insert normal de supabase-js.
  async function insertarRest(tabla, fila) {
    const sb = window.sb;
    const conf = window.RENDIO_CONFIG || {};
    if (!sb || !conf.SUPABASE_URL) throw new Error('sin cliente');
    const { data } = await sb.auth.getSession();
    const token = data && data.session && data.session.access_token;
    if (!token) throw new Error('sin sesión');
    const r = await P('CapacitorHttp').request({
      method: 'POST',
      url: conf.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/' + tabla,
      headers: {
        apikey: conf.SUPABASE_ANON_KEY,
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      data: fila,
    });
    if (!r || r.status >= 300) throw new Error('HTTP ' + (r && r.status));
  }

  // ── Push nativo ───────────────────────────────────────────────────────────────
  // Apagado hasta que la app tenga Firebase (google-services.json) y la llave de
  // Apple en Firebase/Supabase: sin eso, register() en Android tumba la app.
  // Se prende con RENDIO_CONFIG.APP.PUSH_NATIVO (rendio-app/entornos.json).
  const pushOn = !!cfg.PUSH_NATIVO;
  const PUSH_TOKEN_KEY = 'rn-push-token';
  const prefijo = platform === 'ios' ? 'apns:' : 'fcm:';
  let esperandoToken = null;
  // state es el global de core.js (const, no cuelga de window).
  const perfilActual = () => (typeof state !== 'undefined' && state && state.profile && state.profile.id) || '';
  // Se guarda {p: perfil, t: token}: en un teléfono que usan dos conductores,
  // el token anotado es de quien lo activó, no de quien entró después.
  function anotado() { try { return JSON.parse(localStorage.getItem(PUSH_TOKEN_KEY) || 'null') || {}; } catch (_) { return {}; } }
  function tokenGuardado() { const a = anotado(); return a.t && a.p === perfilActual() ? a.t : ''; }
  async function guardarToken(token) {
    const pid = perfilActual();
    if (!pid || !window.Api || !Api.savePushSubscription) return;
    let ver = '';
    try { const i = await P('App').getInfo(); ver = i.version + ' (' + i.build + ')'; } catch (_) { /* */ }
    await Api.savePushSubscription({
      profileId: pid, endpoint: prefijo + token, p256dh: 'native', auth: 'native',
      userAgent: 'RendioApp/' + ver + ' ' + platform,
    });
    try { localStorage.setItem(PUSH_TOKEN_KEY, JSON.stringify({ p: pid, t: token })); } catch (_) { /* */ }
  }
  // Al cerrar sesión (Api.signOut): se borra el token de la base mientras la
  // sesión todavía sirve. Si no, los avisos de esta persona le seguirían
  // llegando a quien entre después en este teléfono.
  async function olvidarToken() {
    const a = anotado();
    try { localStorage.removeItem(PUSH_TOKEN_KEY); } catch (_) { /* */ }
    if (!a.t || !window.Api || !Api.deletePushSubscription) return;
    try { await Api.deletePushSubscription(prefijo + a.t); } catch (_) { /* sin red: la base lo limpia cuando falle */ }
  }
  // Clic en un aviso: la url es una ruta de la app con hash («/#/rutas»,
  // «/#/viaje?r=…»). Se cambia el hash como hacía el service worker; core.js y
  // aux-shell.js lo leen en hashchange (o al entrar, si la app venía cerrada).
  function abrirAviso(url) {
    try {
      const u = new URL(url || '/', location.href);
      if (u.origin !== location.origin) return;
      if (!u.hash) return;
      history.replaceState(null, '', location.pathname + location.search + '#');
      location.hash = u.hash;
    } catch (_) { /* aviso sin enlace */ }
  }
  if (pushOn) {
    const PN = P('PushNotifications');
    PN.addListener('registration', (t) => {
      const v = t && t.value;
      if (!v) return;
      guardarToken(v).then(() => { if (esperandoToken) esperandoToken.ok(v); })
        .catch((e) => { if (esperandoToken) esperandoToken.mal(e); });
    });
    PN.addListener('registrationError', (e) => { if (esperandoToken) esperandoToken.mal(e); });
    // Con la app adelante el sistema ya muestra el aviso (presentationOptions en
    // capacitor.config.json). Las pantallas que se refrescan con un aviso
    // (aux-shell.js, aux-rx-coord.js) escuchan 'rendio-push', como el
    // postMessage del service worker en la web.
    PN.addListener('pushNotificationReceived', (n) => {
      const d = (n && n.data) || {};
      window.dispatchEvent(new CustomEvent('rendio-push', { cancelable: true, detail: { title: n.title, body: n.body, url: d.url } }));
    });
    PN.addListener('pushNotificationActionPerformed', (a) => {
      const d = (a && a.notification && a.notification.data) || {};
      abrirAviso(d.url);
    });
    if (platform === 'android') {
      PN.createChannel({
        id: 'rendio', name: 'Avisos de Rendio', description: 'Vueltas, mensajes y emergencias',
        importance: 5, visibility: 1, vibration: true, sound: 'default',
      }).catch(() => {});
    }
  }
  const push = {
    available: pushOn,
    // 'on' | 'off' | 'blocked' | 'na' — los mismos estados que ui-push.js.
    async status() {
      if (!pushOn) return 'na';
      try {
        const p = await P('PushNotifications').checkPermissions();
        if (p.receive === 'denied') return 'blocked';
        if (p.receive !== 'granted') return 'off';
        return tokenGuardado() ? 'on' : 'off';
      } catch (_) { return 'na'; }
    },
    // Pide permiso, registra el teléfono y guarda el token. true si quedó.
    async enable() {
      if (!pushOn) return false;
      const PN = P('PushNotifications');
      let p = await PN.checkPermissions();
      if (p.receive === 'prompt' || p.receive === 'prompt-with-rationale') p = await PN.requestPermissions();
      if (p.receive !== 'granted') return false;
      const listo = new Promise((ok, mal) => { esperandoToken = { ok, mal }; });
      await PN.register();
      await Promise.race([listo, new Promise((_, mal) => setTimeout(() => mal(new Error('sin token')), 15000))]);
      return true;
    },
    // Para textos que no pueden esperar una promesa: ¿este teléfono ya las activó?
    activas() { return pushOn && !!tokenGuardado(); },
    // Vuelve a guardar el token (la base pudo borrarlo por vencido) antes de una prueba.
    async resave() {
      const t = tokenGuardado();
      if (pushOn && t) await guardarToken(t);
    },
    olvidar: olvidarToken,
  };
  // Al entrar con sesión: si ya había permiso, el token se refresca solo (los
  // tokens cambian y la base borra los que el servicio da por muertos).
  async function pushAlEntrar() {
    if (!pushOn) return;
    try {
      const p = await P('PushNotifications').checkPermissions();
      if (p.receive === 'granted') await P('PushNotifications').register();
    } catch (_) { /* best-effort */ }
  }

  // ── «Actualiza la app» ────────────────────────────────────────────────────────
  // rendio.co/app-version.json dice la versión mínima por plataforma (número de
  // compilación: versionCode en Android, CFBundleVersion en iPhone). Si la
  // instalada es más vieja, una pantalla que no se cierra manda a la tienda.
  async function revisarVersion() {
    if (!cfg.VERSION_URL) return;
    try {
      // Por la red nativa: rendio.co no manda cabeceras CORS para la app.
      const [info, r] = await Promise.all([
        P('App').getInfo(),
        P('CapacitorHttp').get({ url: cfg.VERSION_URL + '?t=' + Date.now(), headers: { 'Cache-Control': 'no-cache' } }),
      ]);
      if (!r || r.status !== 200) return;
      const v = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
      const reg = v && v[platform];
      if (!reg || !reg.min) return;
      const instalada = Number(info.build), minima = Number(reg.min);
      // Un número raro (p. ej. «1.0.1») no puede dejar la app bloqueada para siempre.
      if (!isFinite(instalada) || !isFinite(minima) || instalada >= minima) return;
      const tienda = reg.store || '';
      const d = document.createElement('div');
      d.className = 'rn-modal rn-fija';
      d.innerHTML = '<div class="rn-card" role="alertdialog" aria-modal="true" aria-labelledby="rn-up-t">'
        + '<h2 id="rn-up-t">Actualiza Rendio</h2>'
        + '<p>' + (reg.msg || 'Hay una versión nueva de la app. Actualízala para seguir usándola.') + '</p>'
        + (tienda ? '<div class="rn-acts"><button type="button" class="rn-btn" data-r="ir">Actualizar</button></div>' : '')
        + '</div>';
      document.body.appendChild(d);
      d.addEventListener('click', (e) => {
        if (e.target.closest && e.target.closest('[data-r="ir"]')) abrirAfuera(tienda);
      });
    } catch (_) { /* sin red: se revisa en la próxima apertura */ }
  }

  // ── Arranque ──────────────────────────────────────────────────────────────────
  function alCargar() {
    // Barra de estado con letra clara, como la PWA en iPhone (black-translucent).
    P('SystemBars').setStyle({ style: 'DARK' }).catch(() => {});
    P('SplashScreen').hide().catch(() => {});
    revisarVersion();
    // Botón atrás de Android: si se puede volver dentro de la app, vuelve; si no,
    // se minimiza en vez de cerrar (cerrarla cortaría el GPS de la vuelta).
    P('App').addListener('backButton', (ev) => {
      if (ev && ev.canGoBack) history.back();
      else P('App').minimizeApp().catch(() => {});
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', alCargar);
  else alCargar();

  window.RendioNative = {
    isNative: true,
    platform,
    geo,
    push,
    pushAlEntrar,
    insertarRest,
    guardarArchivo,
    abrirAfuera,
  };
})();
