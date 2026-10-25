// camara-app.js — La cámara DENTRO de la app, para Android.
//
// POR QUÉ (24-oct-2026). Con <input type="file" capture> el teléfono abre SU
// cámara, que es otra app. Mientras esa cámara está al frente, Android puede
// cerrar la pestaña de Chrome para liberar memoria: al tocar «Aceptar» la app
// arranca de cero (pantalla blanca, logo, «Hola») y la foto se pierde. Le pasó a
// Miguel Ángel Peña: el 21-oct no pudo iniciar turno y el 22-oct no pudo hacer
// la inspección diferida (le cayó el strike). Hay video del 22-oct, 2:56 p. m.
// El mismo teléfono sí pudo el 15, 17 y 18: depende de la memoria libre que
// tenga en ese momento, por eso falla "a veces".
//
// Con getUserMedia la cámara vive dentro de la página: Chrome nunca pasa a
// segundo plano y Android no tiene nada que cerrar.
//
// SOLO ANDROID. En iPhone la cámara del input se abre encima de Safari, sin
// salirse de la app, y ese camino funciona: no se toca.
//
// NUNCA DEJA AL CONDUCTOR SIN FOTO. Si no hay permiso, si la cámara está ocupada
// o si el navegador no la entrega, la pantalla ofrece la cámara del teléfono de
// siempre (el input `respaldo`, que sigue con su propio 'change').
//
// Uso:
//   CamaraApp.disponible()  → true solo en Android con getUserMedia.
//   CamaraApp.tomar({ titulo, detalle, maxDim, quality, respaldo, galeria })
//     → Promise<Blob|null>. Blob = JPEG ya reducido a maxDim/quality, lo mismo
//       que entrega compressPhoto. null = canceló, o se fue por el respaldo.
//     · galeria: true agrega «Galería» (comprobantes que ya tenía fotografiados);
//       abre el mismo `respaldo`, que para eso no lleva `capture`.
(function () {
  const ANDROID = /Android/i.test(navigator.userAgent || '');
  // Si el conductor negó el permiso, Chrome lo recuerda y cada intento fallaría
  // al instante: el resto de la sesión se va derecho a la cámara del teléfono
  // en vez de mostrarle el mismo error 11 veces.
  const CLAVE_DENEGADA = 'rendio-camara-denegada';
  // Si a los 8 s la cámara no entrega ni un cuadro, algo anda mal: se ofrece la
  // del teléfono en vez de dejarlo mirando una pantalla negra.
  const ESPERA_CUADRO_MS = 8000;
  let viva = null;   // una sola cámara abierta a la vez

  function disponible() {
    return ANDROID && !!window.isSecureContext &&
      !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }
  function denegada() { try { return sessionStorage.getItem(CLAVE_DENEGADA) === '1'; } catch (_) { return false; } }
  function marcarDenegada() { try { sessionStorage.setItem(CLAVE_DENEGADA, '1'); } catch (_) { /* sin sessionStorage: se vuelve a preguntar */ } }

  function tomar(op) {
    op = op || {};
    if (viva) return Promise.resolve(null);
    // Sin cámara propia: el input de siempre, DENTRO del mismo toque del
    // conductor (fuera de él, Chrome no deja abrir el selector de archivos).
    if (!disponible() || denegada()) { if (op.respaldo) op.respaldo.click(); return Promise.resolve(null); }
    return new Promise((resolve) => { viva = abrir(op, resolve); });
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function abrir(op, resolve) {
    const maxDim = op.maxDim || 1280, quality = op.quality || 0.6;
    const raiz = document.createElement('div');
    raiz.id = 'camara-app';
    raiz.setAttribute('role', 'dialog');
    raiz.setAttribute('aria-modal', 'true');
    raiz.setAttribute('aria-label', 'Cámara');
    raiz.className = 'fixed inset-0 bg-black text-white flex flex-col select-none';
    raiz.style.zIndex = '60';
    raiz.innerHTML = `
      <div class="relative flex-1 min-h-0 overflow-hidden">
        <video data-cam="video" playsinline muted autoplay class="absolute inset-0 w-full h-full object-contain"></video>
        <img data-cam="foto" alt="Foto tomada" class="hidden absolute inset-0 w-full h-full object-contain">
        <div data-cam="destello" class="absolute inset-0 bg-white pointer-events-none" style="opacity:0;transition:opacity .18s ease-out"></div>
        <div class="absolute top-0 left-0 right-0 flex items-start gap-3 px-4 pb-6 bg-gradient-to-b from-black/70 to-transparent" style="padding-top:calc(12px + env(safe-area-inset-top))">
          <button data-cam="cerrar" type="button" aria-label="Cerrar la cámara" class="w-10 h-10 shrink-0 rounded-full bg-black/40 text-white text-xl leading-none flex items-center justify-center active:scale-95">✕</button>
          <div class="min-w-0 pt-0.5">
            <p class="text-[15px] font-bold leading-tight">${esc(op.titulo || 'Foto')}</p>
            ${op.detalle ? `<p class="text-[12px] text-white/75 leading-snug mt-0.5">${esc(op.detalle)}</p>` : ''}
          </div>
        </div>
        <div data-cam="aviso" class="absolute inset-0 flex items-center justify-center px-8 text-center pointer-events-none">
          <p class="text-sm text-white/80">Abriendo la cámara…</p>
        </div>
      </div>
      <div data-cam="barra" class="shrink-0 bg-black px-6 pt-4" style="padding-bottom:calc(18px + env(safe-area-inset-bottom))"></div>`;
    document.body.appendChild(raiz);
    const $c = (k) => raiz.querySelector(`[data-cam="${k}"]`);
    const video = $c('video'), foto = $c('foto'), barra = $c('barra'), aviso = $c('aviso');

    let stream = null, track = null, linterna = false, fotoBlob = null, fotoUrl = null;
    let estado = 'abriendo', terminada = false, intento = 0, reloj = null;

    // «Atrás» del teléfono cierra la cámara y no la pantalla de abajo. Mismo
    // patrón que el chat de Coordinación: entrada en el historial al abrir, y el
    // cierre por botón la deshace con history.back().
    try { history.pushState({ camaraApp: 1 }, ''); } catch (_) { /* sin historial: queda el ✕ */ }

    function apagar() {
      clearTimeout(reloj);
      if (stream) stream.getTracks().forEach(t => { try { t.stop(); } catch (_) { /* */ } });
      stream = null; track = null; linterna = false;
      try { video.srcObject = null; } catch (_) { /* */ }
    }
    function terminar(resultado, desdeHistorial) {
      if (terminada) return;
      terminada = true;
      apagar();
      document.removeEventListener('visibilitychange', alCambiarVisibilidad);
      window.removeEventListener('popstate', alVolver);
      if (fotoUrl) URL.revokeObjectURL(fotoUrl);   // quien recibe el Blob hace su propia URL
      raiz.remove();
      viva = null;
      if (!desdeHistorial && history.state && history.state.camaraApp) { try { history.back(); } catch (_) { /* */ } }
      resolve(resultado || null);
    }
    function alVolver() { if (!(history.state && history.state.camaraApp)) terminar(null, true); }
    window.addEventListener('popstate', alVolver);

    // Si el conductor bloquea el teléfono con la cámara abierta, se suelta la
    // cámara (batería, y otras apps la necesitan); al volver se enciende sola.
    function alCambiarVisibilidad() {
      if (document.visibilityState === 'hidden') apagar();
      else if (estado === 'vivo' || estado === 'abriendo') encender();
    }
    document.addEventListener('visibilitychange', alCambiarVisibilidad);

    function mostrarAviso(html) { aviso.innerHTML = html || ''; aviso.classList.toggle('hidden', !html); }

    function pintarVivo(conLinterna) {
      estado = 'vivo';
      video.classList.remove('hidden'); foto.classList.add('hidden');
      const lado = 'w-14 h-14 rounded-full flex flex-col items-center justify-center text-[10px] font-bold active:scale-95';
      barra.innerHTML = `
        <div class="flex items-center justify-between max-w-sm mx-auto">
          ${conLinterna
            ? `<button data-cam="linterna" type="button" aria-pressed="${linterna}" class="${lado} ${linterna ? 'bg-amber-300 text-black' : 'bg-white/15 text-white'}"><span class="text-lg leading-none">💡</span>Luz</button>`
            : '<span class="w-14 h-14"></span>'}
          <button data-cam="disparar" type="button" aria-label="Tomar la foto" class="w-[76px] h-[76px] rounded-full border-4 border-white/90 flex items-center justify-center active:scale-95 disabled:opacity-40" ${video.videoWidth ? '' : 'disabled'}>
            <span class="w-[60px] h-[60px] rounded-full bg-white"></span>
          </button>
          ${op.galeria && op.respaldo
            ? `<button data-cam="galeria" type="button" class="${lado} bg-white/15 text-white"><span class="text-lg leading-none">🖼</span>Galería</button>`
            : '<span class="w-14 h-14"></span>'}
        </div>`;
      $c('disparar').addEventListener('click', disparar);
      $c('linterna')?.addEventListener('click', alternarLinterna);
      $c('galeria')?.addEventListener('click', irAlRespaldo);
    }
    function pintarRevisar() {
      estado = 'revisar';
      video.classList.add('hidden'); foto.classList.remove('hidden');
      mostrarAviso('');
      barra.innerHTML = `
        <div class="grid grid-cols-2 gap-3 max-w-sm mx-auto">
          <button data-cam="repetir" type="button" class="rounded-xl bg-white/15 text-white font-bold py-3.5 text-base active:scale-[.98]">Repetir</button>
          <button data-cam="usar" type="button" class="rounded-xl bg-brand text-white font-bold py-3.5 text-base active:scale-[.98]">Usar foto</button>
        </div>`;
      $c('repetir').addEventListener('click', () => {
        if (fotoUrl) URL.revokeObjectURL(fotoUrl);
        fotoUrl = null; fotoBlob = null; foto.removeAttribute('src');
        encender();
      });
      $c('usar').addEventListener('click', () => terminar(fotoBlob));
    }
    // Falló la cámara de la app: se explica en una línea y se ofrece la del
    // teléfono. `reintentable`: la cámara estaba ocupada y puede soltarse.
    function pintarFallo(texto, reintentable) {
      estado = 'fallo';
      apagar();
      video.classList.add('hidden'); foto.classList.add('hidden');
      mostrarAviso(`<p class="text-[15px] leading-snug text-white/90">${esc(texto)}</p>`);
      barra.innerHTML = `
        <div class="space-y-2.5 max-w-sm mx-auto">
          ${op.respaldo ? `<button data-cam="respaldo" type="button" class="w-full rounded-xl bg-brand text-white font-bold py-3.5 text-base active:scale-[.98]">Usar la cámara del teléfono</button>` : ''}
          ${reintentable ? `<button data-cam="reintentar" type="button" class="w-full rounded-xl bg-white/15 text-white font-bold py-3 text-sm active:scale-[.98]">Intentar de nuevo</button>` : ''}
        </div>`;
      $c('respaldo')?.addEventListener('click', irAlRespaldo);
      $c('reintentar')?.addEventListener('click', encender);
    }
    // Se sale por el input de siempre. El click va DENTRO del toque del
    // conductor (este mismo manejador): Chrome no abre el selector si no.
    function irAlRespaldo() {
      const inp = op.respaldo;
      terminar(null);
      if (inp) inp.click();
    }

    async function encender() {
      const mio = ++intento;
      apagar();
      estado = 'abriendo';
      video.classList.remove('hidden'); foto.classList.add('hidden');
      mostrarAviso('<p class="text-sm text-white/80">Abriendo la cámara…</p>');
      barra.innerHTML = '<div class="h-[76px]"></div>';
      let s;
      try {
        // 4:3 a 1920 como ideal: alcanza de sobra para 1280/1600 y no obliga a
        // la cámara a recortar (las "ideal" nunca hacen fallar la petición).
        s = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } },
        });
      } catch (e) {
        if (terminada || mio !== intento) return;
        const n = e && e.name;
        if (n === 'NotAllowedError' || n === 'SecurityError') {
          marcarDenegada();
          pintarFallo('La app no tiene permiso para usar la cámara. Puedes dárselo en los permisos del sitio, o tomar la foto con la cámara del teléfono.', false);
        } else if (n === 'NotReadableError' || n === 'AbortError') {
          pintarFallo('La cámara está ocupada por otra app. Ciérrala e intenta de nuevo, o usa la cámara del teléfono.', true);
        } else {
          pintarFallo('No pudimos abrir la cámara de la app. Usa la cámara del teléfono.', false);
        }
        return;
      }
      // Cerró, o pidió otro intento, mientras Chrome preguntaba el permiso.
      if (terminada || mio !== intento) { s.getTracks().forEach(t => t.stop()); return; }
      stream = s;
      track = s.getVideoTracks()[0] || null;
      video.srcObject = s;
      try { await video.play(); } catch (_) { /* autoplay + muted: casi nunca falla; el cuadro igual llega */ }
      let conLinterna = false;
      try { conLinterna = !!(track && track.getCapabilities && track.getCapabilities().torch); } catch (_) { /* */ }
      const listo = () => {
        if (terminada || mio !== intento) return;
        clearTimeout(reloj);
        mostrarAviso('');
        pintarVivo(conLinterna);
      };
      if (video.videoWidth) listo();
      else {
        video.addEventListener('loadeddata', listo, { once: true });
        reloj = setTimeout(() => {
          if (!terminada && mio === intento && !video.videoWidth) pintarFallo('La cámara de la app no respondió. Usa la cámara del teléfono.', true);
        }, ESPERA_CUADRO_MS);
      }
    }

    // De noche (las inspecciones de las 2 a. m.) el baúl y la llanta de repuesto
    // salen negros sin luz. Solo aparece si el teléfono la tiene.
    async function alternarLinterna() {
      if (!track) return;
      const quiero = !linterna;
      try { await track.applyConstraints({ advanced: [{ torch: quiero }] }); linterna = quiero; }
      catch (_) { /* el teléfono dijo que tenía y no: se queda como está */ }
      if (estado === 'vivo') pintarVivo(true);
    }

    function disparar() {
      const w = video.videoWidth, h = video.videoHeight;
      if (!w || !h) return;
      const boton = $c('disparar'); if (boton) boton.disabled = true;
      const escala = Math.min(1, maxDim / Math.max(w, h));
      const lienzo = document.createElement('canvas');
      lienzo.width = Math.round(w * escala);
      lienzo.height = Math.round(h * escala);
      lienzo.getContext('2d').drawImage(video, 0, 0, lienzo.width, lienzo.height);
      const d = $c('destello');
      d.style.transition = 'none'; d.style.opacity = '0.85';
      requestAnimationFrame(() => { d.style.transition = 'opacity .18s ease-out'; d.style.opacity = '0'; });
      lienzo.toBlob((b) => {
        if (terminada) return;
        if (!b) { if (boton) boton.disabled = false; return; }
        fotoBlob = b;
        fotoUrl = URL.createObjectURL(b);
        foto.src = fotoUrl;
        apagar();   // libera la cámara (y apaga la luz) mientras revisa
        pintarRevisar();
      }, 'image/jpeg', quality);
    }

    $c('cerrar').addEventListener('click', () => terminar(null));
    encender();
    return { terminar };
  }

  window.CamaraApp = { disponible, tomar };
})();
