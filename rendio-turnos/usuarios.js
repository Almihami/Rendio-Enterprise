// usuarios.js — Usuarios (0081, 27-sep-2026): los modales que abre el jefe desde
// Personal (conductores y jefes) y Tripulantes: editar datos, restablecer
// contraseña, el banner de solicitudes de contraseña (0104) y el de «Cambiar mi
// contraseña», que usan los tres roles. Toda la escritura pasa por las
// funciones de la base (Api.admin*), que validan que quien llama sea jefe.
// La sección «Usuarios» que juntaba todas las cuentas (11-oct) se quitó el
// 13-oct: cada quien se gestiona en la pantalla de su espacio.
// Comparte scope global con los demás módulos; el orden de carga está en index.html.

  // Regla única de contraseña (U7): 10 o más caracteres, con letras y números.
  // La misma la vuelve a validar la base.
  const USR_PW_RULE = 'Mínimo 10 caracteres, con letras y números.';
  function usrPasswordOk(p) { return typeof p === 'string' && p.length >= 10 && /[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(p) && /\d/.test(p); }

  // Temporal legible (sin O/0, l/I/1) que SIEMPRE cumple la regla: un sorteo de
  // 10 caracteres puede salir sin ningún número.
  function usrTempPassword() {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    for (;;) {
      const arr = new Uint32Array(10);
      crypto.getRandomValues(arr);
      let out = '';
      for (let i = 0; i < arr.length; i++) out += chars[arr[i] % chars.length];
      if (usrPasswordOk(out)) return out;
    }
  }

  // Marco común: tarjeta de modal con los campos del sistema de Ajustes adentro.
  function usrModal(id, title, subtitle, bodyHtml, actionsHtml, { closable = true } = {}) {
    document.getElementById(id)?.remove();
    const overlay = document.createElement('div');
    overlay.id = id;
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-card usr-card">
        <div class="modal-head">
          <h3 class="modal-title">${escapeHtml(title)}</h3>
          ${subtitle ? `<p class="modal-subtitle">${subtitle}</p>` : ''}
        </div>
        <div class="set-ui usr-body" data-theme="light">${bodyHtml}</div>
        <p class="usr-err hidden" data-usr="err"></p>
        <div class="modal-actions">${actionsHtml}</div>
      </div>`;
    document.body.appendChild(overlay);
    if (closable) {
      overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
      overlay.querySelectorAll('[data-usr="cancel"]').forEach(b => b.addEventListener('click', () => overlay.remove()));
    }
    return overlay;
  }
  function usrShowErr(overlay, msg) {
    const el = overlay.querySelector('[data-usr="err"]');
    el.textContent = msg || '';
    el.classList.toggle('hidden', !msg);
  }
  const usrField = (label, key, value, type = 'text', extra = '') =>
    `<div class="set-field"><label>${label}</label><input class="set-input" data-f="${key}" type="${type}" value="${escapeAttr(value == null ? '' : String(value))}" ${extra}></div>`;

  // ─────────────────────────────────────────────────────────────────────
  // Editar datos (U1, U4). Qué campos salen depende del rol.
  // ─────────────────────────────────────────────────────────────────────
  async function openEditarDatos(profileId, onDone) {
    let p;
    try { p = await Api.getProfileForEdit(profileId); }
    catch (e) { alert('No se pudo cargar la ficha: ' + e.message); return; }
    const d = p.driver || {};
    let airlines = [];
    if (p.role === 'auxiliar') { try { airlines = (await Api.listAirlines()) || []; } catch (_) {} }

    const soyYo = state.profile && state.profile.id === p.id;
    let body = usrField('Nombre completo', 'full_name', p.full_name)
      + `<div class="set-grid2" style="margin-top:14px">
          ${usrField('Correo (usuario para entrar)', 'email', p.email, 'email', 'autocomplete="off"')}
          ${usrField('Teléfono', 'phone', p.phone, 'tel', 'inputmode="tel"')}
        </div>`;
    if (p.role !== 'auxiliar') {
      body += `<div class="set-grid2" style="margin-top:14px">
          ${usrField('Cédula', 'document_id', p.document_id)}
          ${usrField('Base', 'home_base', p.home_base)}
        </div>`;
    }
    if (p.role === 'driver') {
      body += `<div class="set-grid2" style="margin-top:14px">
          ${usrField('Licencia (número)', 'license_number', d.license_number)}
          ${usrField('Vence la licencia', 'license_expires_at', d.license_expires_at, 'date')}
          ${usrField('EPS', 'eps_provider', d.eps_provider)}
          ${usrField('Vence la EPS', 'eps_expires_at', d.eps_expires_at, 'date')}
          ${usrField('ARL', 'arl_provider', d.arl_provider)}
          ${usrField('Vence la ARL', 'arl_expires_at', d.arl_expires_at, 'date')}
        </div>`;
    }
    if (p.role === 'auxiliar') {
      const cur = (p.aux && p.aux.airline_id) || '';
      body += `<div class="set-field" style="margin-top:14px"><label>Aerolínea</label><div class="set-selwrap"><select class="set-sel" data-f="airline_id">
          <option value="">— Sin aerolínea —</option>
          ${airlines.filter(a => a.is_active !== false || a.id === cur).map(a => `<option value="${escapeAttr(a.id)}" ${a.id === cur ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('')}
        </select></div></div>`;
    }
    body += `<p class="set-hint" style="margin-top:12px">${soyYo
      ? 'Si cambias tu correo, desde ya entras con el nuevo.'
      : 'Si cambias el correo, la persona entra desde ya con el nuevo y la misma contraseña. Queda registrado en la bitácora.'}</p>`;

    const ov = usrModal('usr-edit-modal', 'Editar datos', escapeHtml(p.full_name || ''), body,
      `<button class="wk-btn wk-coord-off" data-usr="cancel">Cancelar</button><button class="wk-btn wk-coord-on" data-usr="save">Guardar</button>`);

    ov.querySelector('[data-usr="save"]').addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      const orig = {
        full_name: p.full_name || '', email: p.email || '', phone: p.phone || '',
        document_id: p.document_id || '', home_base: p.home_base || '',
        license_number: d.license_number || '', license_expires_at: d.license_expires_at || '',
        eps_provider: d.eps_provider || '', eps_expires_at: d.eps_expires_at || '',
        arl_provider: d.arl_provider || '', arl_expires_at: d.arl_expires_at || '',
        airline_id: (p.aux && p.aux.airline_id) || '',
      };
      const changes = {};
      let newEmail = null;
      ov.querySelectorAll('[data-f]').forEach(inp => {
        const k = inp.dataset.f; const v = inp.value.trim();
        if (v === (orig[k] || '')) return;
        if (k === 'email') newEmail = v.toLowerCase(); else changes[k] = v;
      });
      if ('full_name' in changes && changes.full_name.length < 3) { usrShowErr(ov, 'Escribe el nombre completo.'); return; }
      if (newEmail !== null && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(newEmail)) { usrShowErr(ov, 'El correo no parece válido.'); return; }
      if (!Object.keys(changes).length && newEmail === null) { ov.remove(); return; }
      btn.disabled = true; usrShowErr(ov, '');
      try {
        if (Object.keys(changes).length) await Api.adminUpdateProfile(p.id, changes);
        if (newEmail !== null) await Api.adminSetEmail(p.id, newEmail);
        ov.remove();
        toast('Datos guardados.');
        if (onDone) await onDone();
      } catch (e) {
        usrShowErr(ov, e.message || 'No se pudo guardar.');
        btn.disabled = false;
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // Restablecer contraseña (U2). Temporal generada o una que escriba el jefe.
  // Se muestra UNA vez y no queda guardada en ningún lado de la app.
  // onDone (opcional, 0104): se llama cuando la contraseña ya quedó puesta
  // (usrPedidoAccion lo usa para cerrar el pedido de «Olvidé mi contraseña»).
  // ─────────────────────────────────────────────────────────────────────
  function openRestablecerClave(profileId, name, onDone) {
    const temp = usrTempPassword();
    const body = `
      <div class="set-field"><label>Contraseña nueva</label>
        <div class="set-pwwrap">
          <input class="set-input mono" data-usr="pw" type="text" autocomplete="new-password" value="${temp}">
          <button class="set-btn ghost" data-usr="gen" type="button" title="Generar otra">Otra</button>
        </div>
        <div class="set-hint">${USR_PW_RULE} Puedes dejar la generada o escribir una.</div>
      </div>
      <label class="set-checkrow" style="margin-top:10px">
        <input type="checkbox" class="set-chk-input" data-usr="force" checked>
        <span class="set-chk"><svg class="icon" style="width:13px;height:13px"><use href="#i-check"/></svg></span>
        <span>Pedirle que la cambie al entrar</span>
      </label>
      <p class="set-hint">Se cierran las sesiones que tenga abiertas: tendrá que volver a entrar.</p>`;
    const ov = usrModal('usr-pw-modal', 'Restablecer contraseña', escapeHtml(name || ''), body,
      `<button class="wk-btn wk-coord-off" data-usr="cancel">Cancelar</button><button class="wk-btn wk-coord-on" data-usr="save">Poner contraseña</button>`);
    const pwIn = ov.querySelector('[data-usr="pw"]');
    ov.querySelector('[data-usr="gen"]').addEventListener('click', () => { pwIn.value = usrTempPassword(); });
    ov.querySelector('[data-usr="save"]').addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      const pw = pwIn.value.trim();
      const force = ov.querySelector('[data-usr="force"]').checked;
      if (!usrPasswordOk(pw)) { usrShowErr(ov, USR_PW_RULE); return; }
      btn.disabled = true; usrShowErr(ov, '');
      try {
        await Api.adminSetPassword(profileId, pw, force);
      } catch (e) {
        usrShowErr(ov, e.message || 'No se pudo cambiar.');
        btn.disabled = false;
        return;
      }
      // Sin esperarlo: la contraseña se muestra ya.
      if (onDone) Promise.resolve().then(onDone).catch((e) => console.error(e));
      // Pantalla de resultado: la única vez que se ve.
      ov.querySelector('.usr-body').innerHTML = `
        <p style="font-size:13px;color:var(--ink2)">Pásale esta contraseña a <b>${escapeHtml(name || '')}</b>. No se vuelve a mostrar.</p>
        <div class="set-pwwrap" style="margin-top:10px">
          <input class="set-input mono" readonly value="${escapeAttr(pw)}">
          <button class="set-btn ghost" data-usr="copy" type="button">Copiar</button>
        </div>
        <p class="set-hint">${force ? 'Al entrar, la app le pedirá cambiarla.' : 'Puede seguir usándola.'}</p>`;
      ov.querySelector('.modal-actions').innerHTML = '<button class="wk-btn wk-coord-on" data-usr="cancel">Listo</button>';
      ov.querySelector('[data-usr="cancel"]').addEventListener('click', () => ov.remove());
      ov.querySelector('[data-usr="copy"]').addEventListener('click', async (e2) => {
        try { await navigator.clipboard.writeText(pw); e2.currentTarget.textContent = 'Copiada'; }
        catch (_) { ov.querySelector('.usr-body input').select(); }
      });
    });
  }

  // Suspender / eliminar / reactivar por la función de 0081 (bloquea la cuenta,
  // cierra sesiones, deja bitácora). Si la base todavía no tiene 0081, se hace
  // como antes, directo sobre el perfil.
  async function usrSetStatus(id, status, reason, { wasDeleted = false } = {}) {
    try { await Api.adminSetStatus(id, status, reason); return; }
    catch (e) {
      if (!/admin_set_status|schema cache|Could not find the function/i.test(e.message || '')) throw e;
    }
    if (status === 'deleted') await Api.softDeleteProfile(id);
    else if (status === 'active' && wasDeleted) await Api.undeleteProfile(id);
    else await Api.setProfileActive(id, status === 'active');
  }

  // ─────────────────────────────────────────────────────────────────────
  // Crear una cuenta de conductor o de jefe (U6). Un jefe nace como conductor
  // (create-driver solo sabe eso) y se promueve en el mismo paso; si la
  // promoción falla queda de conductor y se devuelve el error para decirlo.
  // Con forceChange, además se le marca que cambie la contraseña al entrar
  // (es la misma función de «Restablecer», con la clave que se acaba de poner).
  // La usa «Crear conductor» de Personal (que también crea jefes).
  // ─────────────────────────────────────────────────────────────────────
  async function usrCrearCuenta({ name, email, phone, password, role = 'driver', priority = 1, canCoord = false, forceChange = false }) {
    const created = await Api.createDriver({ email, password, full_name: name, phone, priority, can_coordinate: canCoord });
    let promoteError = null, forceError = null;
    if (role === 'admin' && created && created.id) {
      try { await Api.adminSetRole(created.id, 'admin'); } catch (e) { promoteError = e; }
    }
    if (forceChange && created && created.id) {
      try { await Api.adminSetPassword(created.id, password, true); } catch (e) { forceError = e; }
    }
    return { created, promoteError, forceError };
  }
  // U10: el correo de un eliminado no se puede volver a crear (la cuenta sigue
  // existiendo). Devuelve de quién es, para ofrecer restaurarlo, o null.
  async function usrEliminadoConCorreo(err, email) {
    if (!/ya existe/i.test((err && err.message) || '')) return null;
    const del = await Api.listDeletedProfiles().catch(() => []);
    return (del || []).find(x => (x.email || '').toLowerCase() === (email || '').toLowerCase()) || null;
  }
  // ─────────────────────────────────────────────────────────────────────
  // Solicitudes de contraseña (0104). Quien no puede entrar la pide desde el
  // login («¿Problemas para entrar?») y el jefe la atiende ARRIBA de la
  // pantalla donde ya gestiona a esa persona: Personal muestra las de
  // conductores y jefes; Tripulantes, las de tripulantes (13-oct-2026, al
  // quitar la sección Usuarios, que juntaba a 10 conductores con 200
  // tripulantes en una sola lista). Las dos pantallas pintan el mismo banner
  // (usrPedidosHTML) y le pasan los clics a usrPedidoAccion.
  // ─────────────────────────────────────────────────────────────────────
  // roles: los de esa pantalla. '' = el pedido se quedó sin cuenta (la persona
  // se borró de la base): sale en Personal, solo para descartarlo.
  async function usrPedidosClave(roles) {
    if (typeof Api.listPasswordResetRequests !== 'function') return [];
    // Si falla, la pantalla sale igual: es un aviso de más, no lo principal.
    try { return (await Api.listPasswordResetRequests()).filter(r => roles.includes(r.role || '')); }
    catch (e) { console.error(e); return []; }
  }

  // «hace 5 min», «hace 2 h», «hace 3 días»: cuánto lleva esperando.
  function usrHaceCuanto(iso) {
    const t = iso ? new Date(iso).getTime() : NaN;
    if (!isFinite(t)) return '';
    const min = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (min < 1) return 'hace un momento';
    if (min < 60) return `hace ${min} min`;
    const h = Math.round(min / 60);
    if (h < 24) return `hace ${h} h`;
    const d = Math.round(h / 24);
    return d === 1 ? 'hace 1 día' : `hace ${d} días`;
  }

  function usrPedidosHTML(list) {
    if (!list || !list.length) return '';
    return `<div class="usr-pw" role="region" aria-label="Solicitudes de contraseña">
      <div class="usr-pw-head">
        <svg class="icon"><use href="#i-lock"/></svg>
        <div><b>Solicitudes de contraseña <span class="usr-pw-n">${list.length}</span></b>
          <span>Pidieron una contraseña nueva desde la pantalla de entrada. Ponle una temporal y pásasela por WhatsApp o llamada: al entrar, la cambia.</span></div>
      </div>
      <div class="usr-pw-list">${list.map(r => {
        const quien = r.name || r.contact || 'Sin nombre';
        return `<div class="usr-pw-row" data-pw="${escapeAttr(r.id)}">
          <div class="usr-pw-who"><b>${escapeHtml(quien)}</b><span>${r.name && r.contact ? escapeHtml(r.contact) + ' · ' : ''}${escapeHtml(usrHaceCuanto(r.createdAt))}${r.profileId ? '' : ' · ya no tiene cuenta'}</span></div>
          <div class="usr-pw-acts">
            ${r.profileId ? `<button class="usr-pw-btn primary" data-usr-pw="reset" data-id="${escapeAttr(r.id)}">Restablecer</button>` : ''}
            <button class="usr-pw-btn" data-usr-pw="dismiss" data-id="${escapeAttr(r.id)}">Descartar</button>
          </div>
        </div>`;
      }).join('')}</div>
    </div>`;
  }

  // Un clic en el banner. «Restablecer» abre el modal de siempre y, cuando la
  // temporal queda puesta, el pedido pasa a «done» (la base también lo cierra
  // sola por la bitácora de 0081); «Descartar» lo pasa a «dismissed».
  // onChange(lista) recibe la lista sin ese pedido; onRestablecido (opcional)
  // recarga la pantalla para que salga «Clave temporal».
  async function usrPedidoAccion(btn, list, onChange, onRestablecido) {
    const r = (list || []).find(x => x.id === btn.dataset.id); if (!r) return;
    const sin = () => (list || []).filter(x => x.id !== r.id);
    if (btn.dataset.usrPw === 'reset') {
      if (!r.profileId) return;
      openRestablecerClave(r.profileId, r.name || r.contact, async () => {
        try { await Api.resolvePasswordResetRequest(r.id, 'done'); } catch (e) { console.error(e); }
        onChange(sin());
        if (onRestablecido) await onRestablecido();
      });
      return;
    }
    if (btn.dataset.usrPw === 'dismiss') {
      btn.disabled = true;
      try {
        await Api.resolvePasswordResetRequest(r.id, 'dismissed');
        onChange(sin());
        toast('Pedido descartado.');
      } catch (e) {
        btn.disabled = false;
        alert('Error: ' + ((e && e.message) || 'no se pudo'));
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Cambiar mi contraseña (U8: pide la actual). Con forced:true es la pantalla
  // obligatoria después de una temporal: no se cierra, solo se cambia o se sale.
  // Devuelve una promesa que se resuelve cuando la cambió.
  // ─────────────────────────────────────────────────────────────────────
  function openCambiarMiClave({ forced = false } = {}) {
    return new Promise((resolve) => {
      const body = `
        ${forced ? '<p style="font-size:13px;color:var(--ink2);margin-bottom:12px">Entraste con una contraseña temporal. Ponte una tuya para seguir.</p>' : ''}
        ${usrField(forced ? 'Contraseña temporal' : 'Contraseña actual', 'cur', '', 'password', 'autocomplete="current-password"')}
        <div style="margin-top:14px">${usrField('Contraseña nueva', 'new', '', 'password', 'autocomplete="new-password"')}</div>
        <div style="margin-top:14px">${usrField('Repite la nueva', 'rep', '', 'password', 'autocomplete="new-password"')}</div>
        <p class="set-hint">${USR_PW_RULE}</p>`;
      const ov = usrModal('usr-mypw-modal', 'Cambiar mi contraseña', '', body,
        forced
          ? `<button class="wk-btn wk-coord-off" data-usr="logout">Salir</button><button class="wk-btn wk-coord-on" data-usr="save">Cambiar</button>`
          : `<button class="wk-btn wk-coord-off" data-usr="cancel">Cancelar</button><button class="wk-btn wk-coord-on" data-usr="save">Cambiar</button>`,
        { closable: !forced });
      ov.querySelector('[data-usr="logout"]')?.addEventListener('click', () => onLogout());
      ov.querySelector('[data-usr="save"]').addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        const val = k => ov.querySelector(`[data-f="${k}"]`).value;
        const cur = val('cur'), nw = val('new'), rep = val('rep');
        if (!cur) { usrShowErr(ov, 'Escribe tu contraseña actual.'); return; }
        if (!usrPasswordOk(nw)) { usrShowErr(ov, USR_PW_RULE); return; }
        if (nw !== rep) { usrShowErr(ov, 'Las dos contraseñas nuevas no coinciden.'); return; }
        btn.disabled = true; usrShowErr(ov, '');
        try {
          await Api.changeMyPassword(cur, nw);
          if (state.profile) state.profile.must_change_password = false;
          ov.remove();
          toast('Contraseña cambiada.');
          resolve(true);
        } catch (e) {
          usrShowErr(ov, e.message || 'No se pudo cambiar.');
          btn.disabled = false;
        }
      });
    });
  }
