// driver-celular.js — Conductor: su celular (pedido del jefe de operación,
// 11-oct-2026). Comparte el ámbito global: todo lleva prefijo drvTel.
//
// En producción solo 3 de 19 conductores tenían celular y el botón «Llamar al
// conductor» del tripulante no marcaba a nadie. Dos puertas:
//   · drvTelPedirSiFalta() — al entrar a la app de conductor (core.js · enterApp),
//     si profiles.phone está vacío, una ventana que NO se cierra hasta guardar un
//     celular válido (o cerrar sesión).
//   · drvTelAbrir() — la misma ventana, cerrable, desde «Mi celular» del Perfil.
// Las dos guardan con Api.setMyPhone (RPC set_my_phone, 0098) y validan antes con
// Api.normalizarCelular: 10 dígitos que empiezan por 3; espacios, guiones y +57
// valen, y se guarda normalizado.
//
// La ventana es la misma pieza que «Cambiar mi contraseña» (usuarios.js:
// modal-overlay + modal-card usr-card + campos set-*), armada aquí para no
// depender del orden de carga de ese archivo.

  // «3001234567» → «300 123 4567». Lo que no sea un celular de 10 dígitos se
  // muestra tal cual (un fijo viejo, por ejemplo).
  function drvTelFormato(tel) {
    const d = String(tel || '').replace(/\D/g, '');
    return d.length === 10 ? `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}` : String(tel || '').trim();
  }
  const drvTelEsc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const DRV_TEL_REGLA = 'El celular debe tener 10 dígitos y empezar por 3.';

  // Devuelve una promesa con el número guardado, o null si la cerraron sin guardar
  // (solo la no obligatoria se puede cerrar).
  function drvTelAbrir({ forzado = false } = {}) {
    return new Promise((resolve) => {
      document.getElementById('drv-tel-modal')?.remove();
      const actual = (typeof state !== 'undefined' && state.profile && state.profile.phone) || '';
      const ov = document.createElement('div');
      ov.id = 'drv-tel-modal';
      ov.className = 'modal-overlay';
      // Encima de todo lo del conductor (asistente de turno, mapa, chat: hasta 3200).
      ov.style.zIndex = '4000';
      ov.setAttribute('role', 'dialog');
      ov.setAttribute('aria-modal', 'true');
      ov.setAttribute('aria-labelledby', 'drv-tel-title');
      ov.innerHTML = `
        <div class="modal-card usr-card">
          <div class="modal-head">
            <h3 class="modal-title" id="drv-tel-title">${forzado ? 'Tu celular' : 'Mi celular'}</h3>
            <p class="modal-subtitle">Escribe tu celular para que los tripulantes te puedan llamar.</p>
          </div>
          <div class="set-ui usr-body" data-theme="light">
            <div class="set-field"><label for="drv-tel-input">Celular</label>
              <input id="drv-tel-input" class="set-input" data-drv-tel="input" type="tel" inputmode="tel" autocomplete="tel"
                maxlength="20" placeholder="300 123 4567" value="${drvTelEsc(actual ? drvTelFormato(actual) : '')}"></div>
            <p class="set-hint">10 dígitos, empieza por 3. Lo usan los tripulantes de tu ruta y tu jefe para llamarte.</p>
          </div>
          <p class="usr-err hidden" data-drv-tel="err" role="alert"></p>
          <div class="modal-actions">
            ${forzado
              ? '<button class="wk-btn wk-coord-off" type="button" data-drv-tel="salir">Cerrar sesión</button>'
              : '<button class="wk-btn wk-coord-off" type="button" data-drv-tel="cancelar">Cancelar</button>'}
            <button class="wk-btn wk-coord-on" type="button" data-drv-tel="guardar">Guardar</button>
          </div>
        </div>`;
      document.body.appendChild(ov);
      const inp = ov.querySelector('[data-drv-tel="input"]');
      const err = ov.querySelector('[data-drv-tel="err"]');
      const btn = ov.querySelector('[data-drv-tel="guardar"]');
      const mostrarError = (m) => { err.textContent = m || ''; err.classList.toggle('hidden', !m); };
      const cerrar = (valor) => { ov.remove(); resolve(valor); };
      if (!forzado) {
        ov.addEventListener('click', (e) => { if (e.target === ov) cerrar(null); });
        ov.querySelector('[data-drv-tel="cancelar"]').addEventListener('click', () => cerrar(null));
      } else {
        ov.querySelector('[data-drv-tel="salir"]').addEventListener('click', () => { if (typeof onLogout === 'function') onLogout(); });
      }
      let ocupado = false;
      async function guardar() {
        if (ocupado) return;
        const texto = inp.value;
        if (!Api.normalizarCelular(texto)) { mostrarError(DRV_TEL_REGLA); inp.focus(); return; }
        ocupado = true; btn.disabled = true; mostrarError('');
        try {
          const guardado = await Api.setMyPhone(texto);
          if (typeof state !== 'undefined' && state.profile) state.profile.phone = guardado;
          if (typeof state !== 'undefined' && state.profileData && state.profileData.prof) state.profileData.prof.phone = guardado;
          if (typeof toast === 'function') toast('Celular guardado.');
          cerrar(guardado);
        } catch (e) {
          mostrarError((e && e.message) || 'No pudimos guardarlo. Inténtalo de nuevo en un momento.');
          ocupado = false; btn.disabled = false;
        }
      }
      btn.addEventListener('click', guardar);
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); guardar(); } });
      inp.addEventListener('input', () => mostrarError(''));
      try { inp.focus(); } catch (_) { /* */ }
    });
  }

  // Al entrar: solo conductores, solo si el celular está vacío. La vista previa
  // local (#preview-driver, sin cuenta) no se tranca con esto.
  function drvTelPedirSiFalta() {
    if (typeof state === 'undefined' || !state.profile || state.profile.role !== 'driver') return null;
    if (String(state.profile.id || '').startsWith('preview-')) return null;
    if (String(state.profile.phone || '').trim()) return null;
    return drvTelAbrir({ forzado: true });
  }
