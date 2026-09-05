// PENDIENTE-verificacion-correo.js — NO SE CARGA. Es el paso del código por
// correo del registro, sacado del flujo el 2026-08-25.
//
// POR QUÉ SE SACÓ
// El correo que Supabase presta para pruebas admite unos 2 mensajes por hora
// (medido: el segundo intento seguido devuelve `429 email rate limit
// exceeded`). Con eso no se puede abrir el registro a los tripulantes — el
// tercero de la fila se queda sin código. Se retoma cuando el proyecto tenga
// plan pago / SMTP propio.
//
// Estaba TERMINADO y PROBADO cuando se sacó (48/48 en
// rendio-backend/scripts/_smoke-registro-dom.mjs): casillas con salto
// automático, pegar el código completo, reenvío con cuenta regresiva de 60 s,
// cambiar el correo, y un camino de rescate para pegar el enlace mientras la
// plantilla del correo no lleve el código.
//
// ─────────────────────────────────────────────────────────────────────────────
// CÓMO SE VUELVE A PONER
//
//  0. Panel de Supabase: encender Authentication → Sign In / Providers → Email
//     → «Confirm email», y pegar la plantilla (confirmacion-registro.html) en
//     Authentication → Emails → Confirm signup. SIN EL PASO 0 NADA DE ESTO
//     SIRVE: es el servidor el que decide si manda el correo.
//  1. api.js — devolver las tres funciones del final de este archivo y
//     añadirlas al objeto que se exporta.
//  2. config.js — devolver `OTP_LENGTH` (este proyecto emite 8 dígitos; si en
//     Authentication → Email OTP Length se baja a 6, poner 6).
//  3. aux-registro.js:
//       · const OTP_LEN = (window.RENDIO_CONFIG && window.RENDIO_CONFIG.OTP_LENGTH) || 8;
//       · al estado: otp:'', otpState:'idle', otpMsg:'', resendIn:0,
//         resendTimer:null, linkMode:false, linkVal:'' (y limpiarlos en reset())
//       · pegar de vuelta los tres bloques de abajo
//       · render(): la rama `st.view === 'codigo' ? codigoHTML()`
//       · afterRender(): el foco de la casilla que toca
//       · bindOnce(): la rama de `data-rg-otp` en 'input', el 'keydown' de
//         onOtpKey y el oyente de 'paste'
//       · onAction(): 'volver-datos', 'reenviar', 'modo-enlace', 'usar-enlace'
//       · crear(): en vez de ir derecho a 'perfil', ir a 'codigo' y arrancar
//         startResendClock()
//       · el registro vuelve a ser de 3 pasos (nPasos)
//  4. rc-auxiliar.css conserva los estilos .rg-otp*, .rg-resend* y .rg-link-box:
//     no hay que tocarlos.
//  5. La prueba de los dos caminos está en el historial de git, commit 95d2f19.
// ─────────────────────────────────────────────────────────────────────────────

// ══════════ 1 · La pantalla del código (aux-registro.js) ══════════

  function codigoHTML() {
    const boxes = [];
    for (let i = 0; i < OTP_LEN; i++) {
      const d = st.otp[i] || '';
      boxes.push(`<input class="rg-otp-box${d ? ' on' : ''}${st.otpState === 'error' ? ' bad' : ''}"
        data-rg-otp="${i}" type="text" inputmode="numeric" maxlength="1" value="${esc(d)}"
        autocomplete="${i === 0 ? 'one-time-code' : 'off'}" aria-label="Dígito ${i + 1}" />`);
    }
    const msg =
      st.otpState === 'verifying' ? `<span class="rg-otp-msg">Verificando…</span>`
      : st.otpState === 'error' ? `<span class="rg-otp-msg bad">${esc(st.otpMsg || 'El código no es válido o ya venció.')}</span>`
      : st.otpState === 'ok' ? `<span class="rg-otp-msg ok"><svg class="icon"><use href="#i-check"/></svg>Código correcto</span>`
      : `<span class="rg-otp-msg tip">Puedes pegarlo completo.</span>`;
    return `
      ${head(nPaso('codigo'), 'volver-datos')}
      <div class="ax-body">
        <h1 class="ax-form-title">Verifica tu correo</h1>
        <p class="ax-lead">Te enviamos un código de ${OTP_LEN} dígitos a <b>${esc(st.f.email)}</b>.</p>
        <div class="rg-otp">${boxes.join('')}</div>
        <div class="rg-otp-state">${msg}</div>
        <div class="rg-resend">
          ¿No te llegó?
          ${st.resendIn > 0
            ? `<span class="rg-resend-wait">Reenviar en 0:${String(st.resendIn).padStart(2, '0')}</span>`
            : `<button class="ax-link" data-rg="reenviar">Reenviar código</button>`}
        </div>
        <button class="ax-link rg-center" data-rg="volver-datos">Cambiar el correo</button>

        ${st.linkMode ? `
          <div class="ax-sec">¿Te llegó un enlace en vez de un código?</div>
          <div class="rg-link-box">
            <p>Pega acá el enlace completo del correo y lo abrimos por ti.</p>
            <input class="ax-input" data-rg-field="linkVal" type="text"
                   value="${esc(st.linkVal)}" placeholder="https://…" autocapitalize="none" spellcheck="false" />
            <button class="ax-btn ax-btn-ghost" data-rg="usar-enlace" ${st.linkVal ? '' : 'disabled'}>Usar el enlace</button>
          </div>`
          : `<button class="ax-link rg-center rg-soft" data-rg="modo-enlace">Me llegó un enlace, no un código</button>`}

        <div class="ax-hint"><svg class="icon"><use href="#i-clock"/></svg>El código vence a los 60 minutos. Si se te venció, pide otro.</div>
        <div class="ax-spacer"></div>
      </div>`;
  }


// ══════════ 2 · Las casillas: escribir, borrar, pegar ══════════

  function onOtpInput(i, input) {
    const ch = (input.value || '').replace(/\D/g, '').slice(-1);
    const arr = st.otp.padEnd(OTP_LEN, ' ').split('');
    arr[i] = ch || ' ';
    st.otp = arr.join('').replace(/\s+$/, '');
    input.value = ch;
    if (st.otpState === 'error') { st.otpState = 'idle'; st.otpMsg = ''; refreshOtpState(); }
    if (ch && i < OTP_LEN - 1) root()?.querySelector(`[data-rg-otp="${i + 1}"]`)?.focus();
    input.classList.toggle('on', !!ch);
    const full = st.otp.replace(/\s/g, '');
    if (full.length === OTP_LEN) verify(full);
  }

  function onOtpKey(ev) {
    const i = parseInt(ev.target.dataset.rgOtp, 10);
    if (ev.key === 'Backspace' && !ev.target.value && i > 0) {
      ev.preventDefault();
      const prev = root()?.querySelector(`[data-rg-otp="${i - 1}"]`);
      if (prev) { prev.value = ''; prev.classList.remove('on'); prev.focus(); }
      const arr = st.otp.padEnd(OTP_LEN, ' ').split(''); arr[i - 1] = ' ';
      st.otp = arr.join('').replace(/\s+$/, '');
    }
    if (ev.key === 'ArrowLeft' && i > 0) root()?.querySelector(`[data-rg-otp="${i - 1}"]`)?.focus();
    if (ev.key === 'ArrowRight' && i < OTP_LEN - 1) root()?.querySelector(`[data-rg-otp="${i + 1}"]`)?.focus();
  }

  function refreshOtpState() {
    const box = root()?.querySelector('.rg-otp-state');
    if (!box) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = codigoHTML();
    box.innerHTML = tmp.querySelector('.rg-otp-state')?.innerHTML || '';
    root()?.querySelectorAll('.rg-otp-box').forEach(b => b.classList.toggle('bad', st.otpState === 'error'));
  }


// ══════════ 3 · Reloj de reenvío, verificar y rescate por enlace ══════════

  function startResendClock() {
    if (st.resendTimer) clearInterval(st.resendTimer);
    st.resendIn = 60;
    st.resendTimer = setInterval(() => {
      st.resendIn--;
      if (st.resendIn <= 0) { clearInterval(st.resendTimer); st.resendTimer = null; }
      if (st.view !== 'codigo') return;
      const w = root()?.querySelector('.rg-resend');
      if (!w) return;
      const tmp = document.createElement('div');
      tmp.innerHTML = codigoHTML();
      w.innerHTML = tmp.querySelector('.rg-resend')?.innerHTML || '';
    }, 1000);
  }

  async function reenviar() {
    try {
      await Api.resendSignupOtp(st.f.email.trim());
      say('Te lo mandamos otra vez. Revisa también la carpeta de spam.');
      startResendClock(); render();
    } catch (e) {
      st.otpState = 'error'; st.otpMsg = mensajeSignup(e); refreshOtpState();
    }
  }

  async function verify(code) {
    if (st.otpState === 'verifying' || st.otpState === 'ok') return;
    st.otpState = 'verifying'; refreshOtpState();
    try {
      await Api.verifySignupOtp(st.f.email.trim(), code);
      st.otpState = 'ok'; refreshOtpState();
      setTimeout(() => { st.view = 'perfil'; render(); loadCat(); }, 550);
    } catch (e) {
      st.otpState = 'error';
      // Un solo mensaje para los dos casos a propósito: Supabase responde
      // «Token has expired or is invalid» tanto si el código está mal como si
      // se venció, y no hay forma de distinguirlos. Decir «ya venció» cuando en
      // realidad se equivocó de dígito manda a pedir otro código —y a gastar
      // uno de los pocos correos por hora— para nada.
      st.otpMsg = 'El código no coincide o ya venció. Revísalo, o pide uno nuevo.';
      st.otp = '';
      render();
    }
  }

  // Rescate: mientras la plantilla del correo no lleve el código, Supabase manda
  // un enlace. En vez de dejar al tripulante trancado, se acepta el enlace pegado
  // y se saca el token de ahí.
  async function usarEnlace() {
    const v = (st.linkVal || '').trim(); if (!v) return;
    try {
      let hash = null;
      try {
        const u = new URL(v);
        hash = u.searchParams.get('token_hash') || u.searchParams.get('token');
        if (!hash && u.hash) hash = new URLSearchParams(u.hash.slice(1)).get('token_hash');
      } catch (_) { hash = /^[A-Za-z0-9_-]{10,}$/.test(v) ? v : null; }
      if (!hash) throw new Error('link');
      await Api.verifySignupTokenHash(hash);
      st.otpState = 'ok'; render();
      setTimeout(() => { st.view = 'perfil'; render(); loadCat(); }, 400);
    } catch (e) {
      st.otpState = 'error';
      st.otpMsg = e?.message === 'link'
        ? 'Ese enlace no se entiende. Cópialo completo desde el correo.'
        : 'El enlace no sirvió: puede que ya se haya usado o vencido.';
      refreshOtpState();
    }
  }


// ══════════ 4 · Las tres funciones de api.js ══════════

  async function verifySignupOtp(email, token) {
    const { data, error } = await sb.auth.verifyOtp({ email, token, type: 'signup' });
    if (error) throw error;
    return data;
  }

  async function verifySignupTokenHash(tokenHash) {
    let { data, error } = await sb.auth.verifyOtp({ token_hash: tokenHash, type: 'signup' });
    if (error) ({ data, error } = await sb.auth.verifyOtp({ token_hash: tokenHash, type: 'email' }));
    if (error) throw error;
    return data;
  }

  async function resendSignupOtp(email) {
    const { error } = await sb.auth.resend({ type: 'signup', email });
    if (error) throw error;
    return true;
  }
