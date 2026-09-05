// driver-perfil.js — Conductor: perfil, strikes, recompensas, cambios de turno.
// Extraído de app.js (split mecánico 2026-07-10, sin cambios de lógica).
// Comparte scope global con los demás módulos; el orden de carga está en index.html.
  // ====================================================================
  // Perfil del conductor (Fase B/C/D): datos, foto, strikes, recompensas
  // ====================================================================
  const TIER_META = { plata: { label: 'Plata', emoji: '🥈' }, oro: { label: 'Oro', emoji: '🥇' }, diamante: { label: 'Diamante', emoji: '💎' } };

  function nextWeekMondayISO() {
    const d = new Date();
    const dow = (d.getDay() + 6) % 7;          // 0 = lunes
    d.setDate(d.getDate() - dow + 7);          // lunes de la próxima semana
    return d.toISOString().slice(0, 10);
  }
  function kmDrivenOf(sh) { return Math.max(0, (sh.closing_km || 0) - (sh.opening_km || 0)); }

  async function renderDriverProfile() {
    const box = $('#driver-profile-container'); if (!box) return;
    if (!state.profileView) state.profileView = 'main';
    box.innerHTML = '<p class="text-sm text-slate-500 p-4">Cargando perfil…</p>';
    try {
      if (!state.driverId) { try { state.driverId = await Api.getMyDriverProfileId(state.profile.id); } catch (e) { /* */ } }
      const did = state.driverId;
      const [prof, strikes, closed, rewards, redemptions, openShift, susp] = await Promise.all([
        Api.getMyFullProfile().catch(() => state.profile),
        Api.listDriverStrikes(state.profile.id).catch(() => []),
        did ? Api.listMyClosedShifts(did).catch(() => []) : Promise.resolve([]),
        Api.listRewards().catch(() => []),
        did ? Api.listMyRedemptions(did).catch(() => []) : Promise.resolve([]),
        did ? Api.getMyOpenShift(did).catch(() => null) : Promise.resolve(null),
        Api.getMyWeekSuspension(state.profile.id, nextWeekMondayISO()).catch(() => null),
      ]);
      const activeStrikes = (strikes || []).filter(s => !s.voided_at && !s.consumed_at);
      const kmTotal = (closed || []).reduce((s, sh) => s + kmDrivenOf(sh), 0);
      state.profileData = { prof: prof || state.profile, strikes: strikes || [], activeStrikes, closed: closed || [], rewards: rewards || [], redemptions: redemptions || [], openShift, susp, kmTotal };
      drawProfileView();
    } catch (e) {
      console.error(e);
      box.innerHTML = '<p class="text-sm text-rose-500 p-4">No se pudo cargar el perfil.</p>';
    }
  }

  function drawProfileView() {
    const box = $('#driver-profile-container'); if (!box) return;
    const v = state.profileView || 'main';
    box.innerHTML = v === 'rewards' ? rewardsViewHtml() : v === 'strikes' ? strikesViewHtml() : profileMainHtml();
    bindProfile();
    box.scrollTop = 0; window.scrollTo(0, 0);
  }

  // Perfil del rediseño 2026-08-16 (rc-tabs.jsx · TabPerfil).
  // Se conservan dos cosas que el diseño no traía pero que ya están en producción
  // y el conductor usa: la tarjeta de recompensas por km y el detalle de strikes.
  // Los vencimientos que muestra "Documentos" salen de datos reales
  // (driver_profiles.license/eps/arl_expires_at, vehicles.soat/tecnomec_expires_at);
  // la fila que no tenga fecha en BD no se dibuja.
  function profileMainHtml() {
    const d = state.profileData; const p = d.prof; const dp = p.driver || {};
    const av = p.avatar_url;
    const sc = d.activeStrikes.length;
    const next = d.rewards.find(r => r.km_threshold > d.kmTotal);
    const faltan = next ? next.km_threshold - d.kmTotal : 0;
    const ov = d.openShift && d.openShift.vehicles ? d.openShift.vehicles : null;
    const tier = currentTier(d.kmTotal, d.rewards);

    const docs = [
      ['Licencia de conducción', dp.license_expires_at, 'fileText'],
      ['EPS', dp.eps_expires_at, 'shield'],
      ['ARL', dp.arl_expires_at, 'shield'],
      ['SOAT del vehículo', ov && ov.soat_expires_at, 'shield'],
      ['Tecnomecánica', ov && ov.tecnomec_expires_at, 'fileText'],
    ].filter(([, fecha]) => !!fecha);

    return `
      <div class="rc-pf-head rc-in">
        <button id="pf-avatar-btn" class="rc-pf-avt" type="button">
          ${av ? `<img src="${escapeHtml(av)}" alt="">` : escapeHtml(initialsOf(p.full_name || 'Conductor'))}
        </button>
        <input id="pf-avatar-input" type="file" accept="image/*" class="hidden">
        <span>
          <span class="rc-pf-name">${escapeHtml(p.full_name || 'Conductor')}</span>
          <span class="rc-pf-sub">Conductor${p.document_id ? ' · C.C. ' + escapeHtml(p.document_id) : ''}${p.home_base ? ' · ' + escapeHtml(p.home_base) : ''}</span>
        </span>
      </div>

      <div style="margin-top:16px" class="rc-in d1">${profileStrikeNoteHtml(sc, d.susp)}</div>

      <div class="rc-sechd">Recompensas por kilómetro</div>
      <button id="pf-rewards-btn" class="rc-pf-km rc-in d2" type="button">
        <span class="l">${tier ? `Nivel ${TIER_META[tier].label}` : 'Kilómetros acumulados'}</span>
        <span class="n" style="display:block">${d.kmTotal.toLocaleString('es-CO')} km</span>
        <span class="s" style="display:block">${next ? `Te faltan ${faltan.toLocaleString('es-CO')} km para ${escapeHtml(next.title)}` : (d.rewards.length ? '¡Todo desbloqueado!' : 'Aún no hay recompensas configuradas')}</span>
      </button>

      <div class="rc-sechd">Mi vehículo</div>
      <div class="rc-card rc-in d3">
        <div style="display:flex;align-items:center;gap:12px">
          <span style="width:40px;height:40px;border-radius:12px;background:var(--r-surface-2);color:var(--r-text-2);display:flex;align-items:center;justify-content:center;flex-shrink:0">${avIcon('car', 21)}</span>
          <span style="flex:1;min-width:0">
            <span style="display:block;font-size:15px;font-weight:650">${ov ? escapeHtml(ov.internal_code || ov.license_plate || '—') : 'Sin turno activo'}</span>
            <span style="display:block;font-size:12.5px;color:var(--r-text-2);margin-top:1px">${ov ? escapeHtml([ov.brand, ov.model, ov.color].filter(Boolean).join(' · ')) : 'Aparece cuando inicies turno'}</span>
          </span>
        </div>
      </div>

      ${docs.length ? `
        <div class="rc-sechd">Documentos</div>
        <div class="rc-card tight rc-in d3">
          ${docs.map(([label, fecha, ic], i) => {
            const dt = new Date(fecha + 'T00:00:00');
            const dias = Math.round((dt - new Date()) / 86400000);
            const tono = dias < 0 ? 'var(--r-error)' : (dias <= 30 ? 'var(--r-warn)' : null);
            const txt = dias < 0 ? 'Vencido' : `Vence ${dt.toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' })}`;
            return `<div class="rc-listrow"${i === docs.length - 1 ? ' style="border-bottom:0"' : ''}>
              <span class="ic"${tono ? ` style="color:${tono}"` : ''}>${avIcon(ic, 18)}</span>
              <span class="lbl">${escapeHtml(label)}</span>
              <span class="val"${tono ? ` style="color:${tono};font-weight:650"` : ''}>${txt}</span>
            </div>`;
          }).join('')}
        </div>` : ''}

      <div class="rc-sechd">Preferencias</div>
      <div class="rc-card rc-in d3">
        <div style="font-size:13.5px;font-weight:600;margin-bottom:9px">Tema de la app</div>
        <div class="rc-seg" id="pf-theme">
          <button data-t="light" class="${rcTheme() === 'light' ? 'on' : ''}" type="button">Claro</button>
          <button data-t="dark" class="${rcTheme() === 'dark' ? 'on' : ''}" type="button">Oscuro</button>
        </div>
        <p style="font-size:11.5px;color:var(--r-text-3);margin:9px 0 0;line-height:1.45">
          El modo oscuro baja el brillo en los turnos de madrugada y gasta menos batería.
        </p>
      </div>

      <div class="rc-card tight" style="margin-top:10px">
        <button class="rc-listrow" id="pf-strikes-btn" type="button">
          <span class="ic">${avIcon('alert', 18)}</span>
          <span class="lbl">Mis strikes</span>
          <span class="val">${sc === 0 ? 'Ninguno' : `${sc} de 3`}</span>
          <span class="chev">${avIcon('chevronRight', 16)}</span>
        </button>
        <button class="rc-listrow" id="pf-logout" type="button" style="border-bottom:0">
          <span class="ic" style="color:var(--r-error)">${avIcon('x', 18)}</span>
          <span class="lbl" style="color:var(--r-error)">Cerrar sesión</span>
        </button>
      </div>
      <div style="height:20px"></div>`;
  }

  // Nota de strikes: verde sin strikes, ámbar con uno, rojo de dos en adelante.
  function profileStrikeNoteHtml(count, susp) {
    if (susp) {
      return `<div class="rc-note err"><span class="rc-note-ic">${avIcon('alert', 17)}</span>
        <span><b>Suspendido la próxima semana.</b> Por acumular 3 strikes. Habla con tu jefe.</span></div>`;
    }
    if (count === 0) {
      return `<div class="rc-note ok"><span class="rc-note-ic">${avIcon('shield', 17)}</span>
        <span><b>Sin strikes.</b> Buen historial — sigue así.</span></div>`;
    }
    const tone = count >= 2 ? 'err' : 'warn';
    const dots = [1, 2, 3].map(i => `<i class="${i <= count ? (count >= 2 ? 'on' : 'warn') : ''}"></i>`).join('');
    return `<div class="rc-note ${tone}" style="flex-direction:column;align-items:stretch">
      <span style="display:flex;gap:10px"><span class="rc-note-ic">${avIcon('alert', 17)}</span>
      <span><b>${count} de 3 strikes.</b> ${count >= 2 ? 'Uno más y te suspenden una semana.' : 'Revisa el motivo y cuida tu operación.'}</span></span>
      <span class="rc-strikedots">${dots}</span>
    </div>`;
  }
  function currentTier(km, rewards) {
    const unlocked = rewards.filter(r => km >= r.km_threshold);
    if (!unlocked.length) return null;
    const top = unlocked[unlocked.length - 1];
    return top.tier in TIER_META ? top.tier : null;
  }
  // strikeCardHtml() se retiró con el rediseño 2026-08-16: la reemplaza
  // profileStrikeNoteHtml(), que usa la pieza RcNote del sistema nuevo.

  function strikesViewHtml() {
    const d = state.profileData;
    const susp = d.susp;
    // Detalle: strikes no anulados (incluye los "consumidos" del ciclo que generó
    // la suspensión, para que un conductor suspendido vea por qué).
    const shown = (d.strikes || []).filter(s => !s.voided_at);
    const count = susp ? 3 : d.activeStrikes.length;
    const fmtD = (s) => { try { return new Date(s + 'T00:00:00').toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return s; } };
    const list = shown.slice(0, 3).map((s, i) => `<div class="rounded-2xl bg-white border border-slate-200 p-4 flex gap-3">
        <div class="w-8 h-8 rounded-full bg-rose-100 text-rose-700 font-extrabold flex items-center justify-center shrink-0 text-sm">${Math.min(shown.length, 3) - i}</div>
        <div class="flex-1 min-w-0"><p class="text-sm font-bold text-ink">${escapeHtml(s.reason || 'Strike')}</p><p class="text-[11px] text-slate-400 mt-1">Semana ${escapeHtml(fmtD(s.week_start_date))} · asignado por el administrador</p></div>
      </div>`).join('') || '<p class="text-sm text-slate-500">No tienes strikes activos. 🎉</p>';
    const suspBlock = susp ? `<div class="rounded-3xl bg-gradient-to-br from-rose-600 to-rose-700 text-white p-6 text-center shadow-lg mb-4">
        <div class="w-16 h-16 rounded-full bg-white/20 flex items-center justify-center text-3xl mx-auto mb-3">🚫</div>
        <p class="text-xl font-extrabold">Suspensión activa</p>
        <p class="text-sm text-white/85 mt-1.5">La próxima semana no podrás iniciar turnos ni marcar disponibilidad. La levanta tu administrador.</p>
      </div>` : '';
    return `
      <button id="pf-back" class="flex items-center gap-1 text-sm font-bold text-slate-600 py-2 mb-1">‹ Volver al perfil</button>
      <h2 class="text-[22px] font-extrabold text-ink leading-tight mb-3">Strikes</h2>
      ${suspBlock}
      <div class="rounded-3xl bg-white border-2 ${count >= 2 || susp ? 'border-rose-200' : count === 1 ? 'border-amber-200' : 'border-emerald-200'} p-5 text-center shadow-card mb-4">
        <p class="text-[11px] font-bold uppercase tracking-wider ${count >= 2 || susp ? 'text-rose-600' : count === 1 ? 'text-amber-600' : 'text-emerald-600'}">Strikes acumulados</p>
        <p class="text-5xl font-extrabold text-ink mt-1">${count}<span class="text-2xl text-slate-300"> / 3</span></p>
      </div>
      <div class="rounded-2xl bg-slate-100 p-4 mb-4"><p class="text-sm font-bold text-ink">¿Qué pasa al llegar a 3 strikes?</p><p class="text-xs text-slate-500 mt-1">Tu cuenta se suspende la semana siguiente: no podrás iniciar turnos ni marcar disponibilidad hasta que el administrador lo resuelva.</p></div>
      <h3 class="text-[13px] font-bold uppercase tracking-wider text-slate-500 mb-2">Detalle</h3>
      <div class="space-y-2.5 pb-6">${list}</div>`;
  }

  function rewardsViewHtml() {
    const d = state.profileData;
    const km = d.kmTotal;
    const next = d.rewards.find(r => r.km_threshold > km);
    const faltan = next ? next.km_threshold - km : 0;
    const base = (() => { const prev = [...d.rewards].reverse().find(r => r.km_threshold <= km); return prev ? prev.km_threshold : 0; })();
    const pct = next ? Math.min(100, Math.round((km - base) / (next.km_threshold - base) * 100)) : 100;
    const redByReward = {}; (d.redemptions || []).forEach(r => { if (!redByReward[r.reward_id] || r.status !== 'rejected') redByReward[r.reward_id] = r; });
    const cards = d.rewards.length ? d.rewards.map(r => {
      const unlocked = km >= r.km_threshold;
      const red = redByReward[r.id];
      const requested = red && red.status !== 'rejected';
      const tm = TIER_META[r.tier] || { label: r.tier, emoji: '🎁' };
      const foot = !unlocked
        ? `<div class="mt-3"><div class="h-2 rounded-full bg-slate-100 overflow-hidden"><div class="h-full bg-brand-300 rounded-full" style="width:${Math.min(100, Math.round(km / r.km_threshold * 100))}%"></div></div><p class="text-[11px] text-slate-400 mt-1.5 text-center">🔒 Faltan ${(r.km_threshold - km).toLocaleString('es-CO')} km</p></div>`
        : requested
          ? `<button disabled class="mt-3 w-full bg-emerald-50 text-emerald-700 font-bold py-2.5 rounded-xl text-sm">${red.status === 'delivered' ? '✓ Entregado' : '⏳ Solicitado'}</button>`
          : `<button data-redeem="${r.id}" class="mt-3 w-full bg-brand text-white font-bold py-2.5 rounded-xl shadow-brand active:scale-[.98] text-sm">Redimir</button>`;
      return `<div class="snap-start shrink-0 w-[240px] rounded-2xl bg-white border-2 overflow-hidden flex flex-col ${unlocked && !requested ? 'border-emerald-200 shadow-card' : 'border-slate-200'}">
          <div class="h-24 flex items-center justify-center text-5xl ${unlocked ? 'bg-gradient-to-br from-brand-50 to-brand-100' : 'bg-slate-100 grayscale opacity-70'}">${tm.emoji}</div>
          <div class="p-4 flex-1 flex flex-col">
            <div class="flex items-center justify-between">
              <span class="text-[10px] font-bold uppercase tracking-wide rounded-full px-2 py-0.5 ${unlocked ? (requested ? 'text-slate-500 bg-slate-100' : 'text-emerald-700 bg-emerald-50') : 'text-slate-400 bg-slate-100'}">${unlocked ? (requested ? 'Solicitado' : 'Disponible') : 'Bloqueado'}</span>
              <span class="text-[11px] font-bold text-slate-400">${r.km_threshold.toLocaleString('es-CO')} km</span>
            </div>
            <p class="text-[15px] font-extrabold text-ink mt-2 leading-tight">${escapeHtml(r.title)}</p>
            <p class="text-xs text-slate-500 mt-0.5 flex-1">${escapeHtml(r.description || '')}</p>
            ${foot}
          </div>
        </div>`;
    }).join('') : '<div class="px-1 text-sm text-slate-500">Aún no hay recompensas configuradas. Tu administrador las definirá pronto.</div>';
    const hist = d.closed.length ? d.closed.map(sh => {
      const k = kmDrivenOf(sh); const veh = sh.vehicles ? (sh.vehicles.internal_code || sh.vehicles.license_plate || '') : '';
      const date = sh.end_at ? new Date(sh.end_at).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' }) : '';
      return `<div class="flex items-center justify-between px-4 py-3 border-b border-slate-100 last:border-0">
          <div class="flex items-center gap-3"><div class="w-9 h-9 rounded-lg bg-emerald-50 flex items-center justify-center text-sm">🚐</div><div><p class="text-sm font-semibold text-ink">${escapeHtml(date)}</p><p class="text-[11px] text-slate-400">${escapeHtml(veh || 'Turno')}</p></div></div>
          <span class="text-sm font-bold tabular-nums text-emerald-600">+${k.toLocaleString('es-CO')} km</span>
        </div>`;
    }).join('') : '<div class="px-4 py-4 text-sm text-slate-500">Aún no has cerrado turnos.</div>';
    return `
      <button id="pf-back" class="flex items-center gap-1 text-sm font-bold text-slate-600 py-2 mb-1">‹ Volver al perfil</button>
      <h2 class="text-[22px] font-extrabold text-ink leading-tight mb-3">Recompensas</h2>
      <div class="rounded-3xl bg-gradient-to-br from-brand-500 to-brand-700 text-white p-5 shadow-brand">
        <p class="text-xs uppercase tracking-wider text-white/80 font-bold">Kilómetros acumulados</p>
        <p class="text-4xl font-extrabold mt-1 tabular-nums">${km.toLocaleString('es-CO')} <span class="text-lg font-bold text-white/80">km</span></p>
        <div class="mt-4">
          <div class="flex justify-between text-[11px] font-semibold text-white/85 mb-1.5"><span>${next ? 'Próxima: ' + escapeHtml(next.title) : '¡Todo desbloqueado!'}</span><span>${next ? next.km_threshold.toLocaleString('es-CO') + ' km' : ''}</span></div>
          <div class="h-2.5 rounded-full bg-white/25 overflow-hidden"><div class="h-full bg-white rounded-full transition-all" style="width:${pct}%"></div></div>
          ${next ? `<p class="text-[11px] text-white/85 mt-1.5">Te faltan ${faltan.toLocaleString('es-CO')} km</p>` : ''}
        </div>
      </div>
      <div class="flex items-center justify-between pt-5 mb-3"><h3 class="text-[13px] font-bold uppercase tracking-wider text-slate-500">Canjea tus kilómetros</h3><span class="text-[11px] font-semibold text-slate-400">desliza →</span></div>
      <div class="flex gap-3 overflow-x-auto pb-1 snap-x" style="scrollbar-width:none">${cards}</div>
      <h3 class="text-[13px] font-bold uppercase tracking-wider text-slate-500 pt-6 mb-2">Mi kilometraje</h3>
      <div class="rounded-2xl bg-white border border-slate-200 shadow-card overflow-hidden mb-2"><div class="flex items-center justify-between px-4 py-3 bg-slate-50"><span class="text-[11px] font-bold uppercase tracking-wider text-slate-400">Turnos cerrados</span><span class="text-sm font-extrabold text-ink">${d.closed.length}</span></div>${hist}</div>
      <p class="text-[11px] text-slate-400 text-center mt-3 pb-6">Acumulado total: <strong class="text-ink">${km.toLocaleString('es-CO')} km</strong></p>`;
  }

  function bindProfile() {
    const box = $('#driver-profile-container'); if (!box) return;
    $('#pf-rewards-btn')?.addEventListener('click', () => { state.profileView = 'rewards'; drawProfileView(); });
    $('#pf-strikes-btn')?.addEventListener('click', () => { state.profileView = 'strikes'; drawProfileView(); });
    $('#pf-back')?.addEventListener('click', () => { state.profileView = 'main'; drawProfileView(); });
    $('#pf-logout')?.addEventListener('click', onLogout);
    $('#pf-avatar-btn')?.addEventListener('click', () => $('#pf-avatar-input')?.click());
    $('#pf-avatar-input')?.addEventListener('change', onPickAvatar);
    // Tema claro/oscuro de las pestañas del conductor (rediseño 2026-08-16).
    $('#pf-theme')?.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-t]');
      if (!b) return;
      rcSetTheme(b.dataset.t);
      $('#pf-theme').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    });
    box.querySelectorAll('[data-redeem]').forEach(b => b.addEventListener('click', () => onRedeem(b.dataset.redeem)));
  }

  async function onPickAvatar(input) {
    const file = input.files && input.files[0]; input.value = '';
    if (!file) return;
    try {
      toast('Subiendo foto…');
      const blob = await compressImage(file, 512, 0.85);
      const url = await Api.uploadMyAvatar(blob);
      if (state.profile) state.profile.avatar_url = url;
      if (state.profileData && state.profileData.prof) state.profileData.prof.avatar_url = url;
      drawProfileView();
      toast('Foto actualizada.');
    } catch (e) { console.error(e); toast('No se pudo subir la foto.'); }
  }

  async function onRedeem(rewardId) {
    const d = state.profileData; const r = d.rewards.find(x => x.id === rewardId);
    if (!r) return;
    if (!confirm(`¿Redimir "${r.title}"? Se enviará una solicitud a tu administrador.`)) return;
    try {
      await Api.redeemReward(rewardId);
      toast('¡Solicitud enviada! Tu administrador la revisará.');
      await renderDriverProfile();
    } catch (e) {
      console.error(e);
      const m = (e && e.message) || '';
      if (/NOT_ENOUGH_KM/.test(m)) toast('Aún no tienes los km suficientes para esta recompensa.');
      else if (/ALREADY_REQUESTED/.test(m)) toast('Ya solicitaste esta recompensa.');
      else if (/REWARD_INACTIVE/.test(m)) toast('Esa recompensa ya no está disponible.');
      else toast('No se pudo redimir: ' + m);
    }
  }

  // La home del conductor la pinta driver-tabs.js desde el rediseño 2026-08-16
  // (saludo, "Tu día" con la vuelta asignada y el aviso de jornadas por marcar).
  function updateDriverHome() {
    renderDriverInicio();
  }

  // La pantalla de Disponibilidad (tarjetas por día, selector de estado en modal,
  // fila Prefiero AM/PM y barra fija de Guardar) se reemplazó por completo el
  // 2026-08-16 con el rediseño del diseñador: ahora vive en driver-disponibilidad.js
  // (grilla 7×2 que se pinta arrastrando + medidor de 14 jornadas). Allá quedaron
  // renderDriverDays() y availabilitySummaryText(), que este archivo sigue llamando.


  // Tarjetas de permiso del rediseño 2026-08-16 (rc-tabs.jsx · TabSolicitudes).
  // El estado de aprobación vive acá desde que salió de la grilla de Disponibilidad.
  const SOLIC_EST = { pending: ['pendiente', 'En revisión', 'clock'], approved: ['aprobada', 'Aprobada', 'check'], rejected: ['rechazada', 'Negada', 'x'] };

  function solicCardHtml({ est, kind, titulo, motivo, fecha, nota }) {
    const [cls, label, ic] = SOLIC_EST[est] || SOLIC_EST.pending;
    return `<div class="rc-card" style="margin-bottom:9px">
      <div class="rc-solc-head">
        <span class="rc-solc-kind">${escapeHtml(kind)}</span>
        <span class="rc-solc-est ${cls}">${avIcon(ic, 12)}${label}</span>
      </div>
      <div class="rc-solc-t">${escapeHtml(titulo)}</div>
      ${motivo ? `<div class="rc-solc-m">${escapeHtml(motivo)}</div>` : ''}
      ${fecha ? `<div class="rc-solc-f">${escapeHtml(fecha)}</div>` : ''}
      ${nota ? `<div class="rc-solc-nota"><b>Tu jefe:</b> ${escapeHtml(nota)}</div>` : ''}
    </div>`;
  }

  async function renderDriverRequests() {
    const box = $('#driver-requests-container');
    if (!box) return;
    try {
      const reqs = await Api.listMyApprovalRequests(state.profile.id, state.currentWeek);
      const nice = (dayKey) => {
        const l = Scheduler.DAY_LABELS_ES[dayKey] || '—';
        return l.charAt(0) + l.slice(1).toLowerCase();
      };
      const reqCards = reqs.map(r => solicCardHtml({
        est: r.state,
        kind: 'Permiso',
        titulo: `${nice(Scheduler.DAYS[r.day_of_week])} · ${r.shift === 'am' ? 'Mañana' : 'Tarde'}`,
        motivo: r.reason || (r.kind === 'prefer_rest' ? 'Prefiero no trabajar' : 'No puedo'),
        fecha: r.resolved_at
          ? `${r.state === 'approved' ? 'Aprobada' : 'Negada'} el ${new Date(r.resolved_at).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', timeZone: 'America/Bogota' })}`
          : 'Esperando respuesta de tu jefe',
        nota: r.admin_note || null,
      })).join('');

      // Descansos entre semana sin solicitud formal: el conductor debe saber que
      // su intención está registrada (el generador la respeta) aunque el admin
      // solo la confirme al publicar el horario.
      const haveReq = new Set(reqs.map(r => `${r.day_of_week}-${r.shift}`));
      const pendingCards = [];
      Scheduler.DAYS.forEach((dayKey, idx) => {
        const cell = state.ownAvail && state.ownAvail[dayKey];
        if (!cell) return;
        ['am', 'pm'].forEach(sh => {
          if (cell[sh] === 'prefer_rest' && !haveReq.has(`${idx}-${sh}`)) {
            pendingCards.push(solicCardHtml({
              est: 'pending', kind: 'Permiso',
              titulo: `${nice(dayKey)} · ${sh === 'am' ? 'Mañana' : 'Tarde'}`,
              motivo: 'Prefiero no trabajar',
              fecha: 'Se confirma cuando tu jefe publique el horario',
            }));
          }
        });
      });

      box.innerHTML = (reqCards + pendingCards.join('')) || `
        <div class="rc-empty">
          <span class="rc-empty-ic">${avIcon('check', 20)}</span>
          <b>Sin permisos esta semana</b>
          <p>Los permisos salen de marcar «No puedo» en Disponibilidad.</p>
        </div>`;
      applyDriverSolicFilter();
    } catch (e) {
      box.innerHTML = `<div class="rc-note err" style="margin-bottom:9px"><span class="rc-note-ic">${avIcon('alert', 17)}</span><span>No se pudieron cargar tus permisos: ${escapeHtml(e.message)}</span></div>`;
    }
  }

  async function renderDriverPublishedSchedule() {
    const container = $('#driver-schedule-container');
    const summaryBox = $('#driver-week-summary');
    const sch = await Api.getSchedule(state.currentWeek);
    if (!sch || !sch.published) {
      container.innerHTML = '<p style="padding:20px;font-size:13px;color:var(--r-text-3);text-align:center">Esta semana no tiene horario publicado todavía.</p>';
      renderDriverHorarioHead(null);
      if (summaryBox) {
        summaryBox.innerHTML = `<div class="rc-empty rc-in d1" style="margin-top:16px">
          <span class="rc-empty-ic">${avIcon('calendarCheck', 20)}</span>
          <b>Todavía no hay horario</b>
          <p>Tu jefe publica la semana el domingo. Te avisamos cuando esté.</p>
        </div>`;
      }
      return;
    }
    // Overlay de swaps aceptados: el conductor ve el horario YA con los cambios.
    try {
      const accepted = await Api.listAcceptedSwaps(state.currentWeek);
      if (accepted.length) sch.data = Scheduler.applySwaps(sch.data, accepted);
    } catch (e) { /* sin overlay si falla */ }

    const driverNames = sch.data._names || {};
    if (!driverNames[state.profile.id]) driverNames[state.profile.id] = state.profile.full_name;
    // Guardado para la sección de cambios de turno (swaps).
    state.pubSched = sch.data;
    state.pubNames = driverNames;

    const week = Scheduler.weekDates(state.currentWeek);

    // --- Mi semana: lista corta de mis turnos + totales ---
    const myShifts = [];
    week.forEach(d => {
      const day = sch.data[d.key] || {};
      const meId = state.profile.id;
      // El líder conduce su jornada: un solo turno (no se duplica ni las horas).
      if ((day.morning || []).includes(meId)) myShifts.push({ d, shift: 'AM', lead: (day.coord_am || []).includes(meId) });
      if ((day.afternoon || []).includes(meId)) myShifts.push({ d, shift: 'PM', lead: (day.coord_pm || []).includes(meId) });
    });
    renderDriverHorarioHead(myShifts.length);
    if (summaryBox) summaryBox.innerHTML = driverWeekListHtml(week, myShifts);

    let html = '<table class="w-full text-xs" id="schedule-table">';
    html += '<caption class="text-base font-bold py-3">HORARIO SEMANAL</caption>';
    html += '<thead><tr><th class="cell-label">FRANJA</th>' +
      week.map(d => `<th>${d.label.slice(0,3)} ${d.dayNum}</th>`).join('') + '</tr></thead><tbody>';
    for (let i = 0; i < state.settings.morning_slots; i++) {
      html += '<tr class="row-morning">';
      if (i === 0) html += `<td class="cell-label" rowspan="${state.settings.morning_slots}">MAÑANA (${state.settings.morning_label})</td>`;
      week.forEach(d => {
        const id = sch.data[d.key]?.morning?.[i];
        const name = (driverNames[id] || '—').toUpperCase();
        const cls = id === state.profile.id ? 'shift-cell my-shift-cell' : 'shift-cell';
        html += `<td class="${cls}">${escapeHtml(name)}</td>`;
      });
      html += '</tr>';
    }
    for (let i = 0; i < state.settings.afternoon_slots; i++) {
      html += '<tr class="row-afternoon">';
      if (i === 0) html += `<td class="cell-label" rowspan="${state.settings.afternoon_slots}">TARDE (${state.settings.afternoon_label})</td>`;
      week.forEach(d => {
        const id = sch.data[d.key]?.afternoon?.[i];
        const name = (driverNames[id] || '—').toUpperCase();
        const cls = id === state.profile.id ? 'shift-cell my-shift-cell' : 'shift-cell';
        html += `<td class="${cls}">${escapeHtml(name)}</td>`;
      });
      html += '</tr>';
    }
    [['coord_am', 'LÍDER DE TURNO AM'], ['coord_pm', 'LÍDER DE TURNO PM']].forEach(([kind, label]) => {
      html += '<tr class="row-coord"><td class="cell-label">' + label + '</td>';
      week.forEach(d => {
        const id = sch.data[d.key]?.[kind]?.[0];
        const name = (driverNames[id] || '—').toUpperCase();
        const cls = id === state.profile.id ? 'shift-cell my-shift-cell' : 'shift-cell';
        html += `<td class="${cls}">${escapeHtml(name)}</td>`;
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    container.innerHTML = html;
  }

  // Lista de la semana del rediseño 2026-08-16 (rc-tabs.jsx · TabHorario): una
  // tarjeta por día con sus jornadas.
  //
  // El diseño mostraba además hora de inicio/fin, placa y tipo de vuelta
  // (salida/llegada/hotel). Ninguno de los tres existe hoy en el horario
  // publicado: weekly_schedules.data solo guarda ids de conductor por
  // mañana/tarde. Las ranuras están puestas y vacías — el día que la BD tenga
  // esos campos, se llenan solas y no hay que volver a tocar esta plantilla.
  function driverWeekListHtml(week, myShifts) {
    const mine = {};
    myShifts.forEach(s => { mine[`${s.d.key}-${s.shift.toLowerCase()}`] = s; });
    const mon = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];

    const slot = (dayKey, sh) => {
      const s = mine[`${dayKey}-${sh}`];
      if (!s) {
        // Descanso fijo de contrato: se distingue de "no le tocó turno".
        if (Scheduler.ruleBlocked(state.profile, dayKey, sh)) {
          return `<div class="rc-hslot lock">${avIcon('lock', 13)} Descanso fijo de contrato</div>`;
        }
        return '';
      }
      // hora y placa: ranuras vacías hasta que el horario publicado las traiga.
      const hora = s.hora || '';
      const placa = s.placa || '';
      return `<div class="rc-hslot ${sh}">
        <span class="k">${sh.toUpperCase()}</span>
        <span class="t">${escapeHtml(hora)}</span>
        ${s.lead ? '<span class="lead">★ Líder</span>' : ''}
        ${placa ? `<span class="v">${escapeHtml(placa)}</span>` : ''}
      </div>`;
    };

    return `<div style="margin-top:16px;display:flex;flex-direction:column;gap:8px" class="rc-in d1">
      ${week.map(d => {
        const am = slot(d.key, 'am');
        const pm = slot(d.key, 'pm');
        const libre = !am && !pm;
        const dNum = new Date(d.date + 'T00:00:00').getDate();
        const dMon = mon[new Date(d.date + 'T00:00:00').getMonth()];
        const nombre = d.label.charAt(0) + d.label.slice(1).toLowerCase();
        return `<div class="rc-hday${libre ? ' libre' : ''}">
          <div class="rc-hday-head">
            <b>${nombre}</b><span>${dNum} ${dMon}</span>
            ${libre ? '<span class="none">Sin turno</span>' : ''}
          </div>
          ${libre ? '' : `<div class="rc-hday-body">${am}${pm}</div>`}
        </div>`;
      }).join('')}
    </div>`;
  }

  // ====================== Cambios de turno entre conductores (Fase 3) ======================

  const SHIFT_ES = { am: 'Mañana', pm: 'Tarde' };

  // Turnos de MANEJO (morning/afternoon) de un conductor en el horario publicado.
  function drivingShiftsOf(data, profileId) {
    const out = [];
    Scheduler.DAYS.forEach((day, di) => {
      const d = data[day] || {};
      if ((d.morning || []).includes(profileId)) out.push({ day, di, shift: 'am' });
      if ((d.afternoon || []).includes(profileId)) out.push({ day, di, shift: 'pm' });
    });
    return out;
  }

  function swapStateLabel(s) {
    return { pending: 'Pendiente', accepted: 'Aceptado', rejected: 'Rechazado', cancelled: 'Cancelado' }[s] || s;
  }

  async function renderDriverSwaps() {
    // Contenedor (se inyecta antes del horario si no existe en el HTML).
    let box = document.getElementById('driver-swaps-container');
    if (!box) {
      const schedWrap = document.getElementById('driver-schedule-container');
      if (!schedWrap || !schedWrap.parentNode) return;
      box = document.createElement('div');
      box.id = 'driver-swaps-container';
      box.className = 'mb-4';
      schedWrap.parentNode.insertBefore(box, schedWrap);
    }
    const data = state.pubSched;
    if (!data) { box.innerHTML = ''; return; }
    const meId = state.profile.id;

    let mySwaps = [];
    try { mySwaps = await Api.listMySwaps(meId, state.currentWeek); } catch (e) { /* vacío */ }
    const names = state.pubNames || {};
    const label = (di, shift) => `${Scheduler.DAY_LABELS_ES[Scheduler.DAYS[di]]} · ${SHIFT_ES[shift]}`;

    // Entrantes (yo soy el destinatario y está pendiente).
    const incoming = mySwaps.filter(s => s.target_id === meId && s.state === 'pending');
    const incomingHtml = incoming.map(s => `
      <div class="swap-card" data-state="pending">
        <p class="swap-card-title">${escapeHtml(names[s.requester_id] || 'Un compañero')} te propone un cambio</p>
        <p class="swap-card-detail">Te daría: <strong>${label(s.from_day, s.from_shift)}</strong><br>A cambio de tu: <strong>${label(s.to_day, s.to_shift)}</strong></p>
        ${s.note ? `<p class="swap-card-note">"${escapeHtml(s.note)}"</p>` : ''}
        <div class="swap-card-actions">
          <button data-swap-accept="${s.id}" class="wk-btn wk-coord-on">Aceptar</button>
          <button data-swap-reject="${s.id}" class="wk-btn">Rechazar</button>
        </div>
      </div>`).join('');

    // Salientes / historial (yo solicité, o ya resueltas).
    const others = mySwaps.filter(s => !(s.target_id === meId && s.state === 'pending'));
    const othersHtml = others.map(s => {
      const mine = s.requester_id === meId;
      const who = mine ? (names[s.target_id] || 'Compañero') : (names[s.requester_id] || 'Compañero');
      return `<div class="swap-card" data-state="${s.state}">
        <p class="swap-card-title">${mine ? 'Pediste a' : 'Te pidió'} ${escapeHtml(who)} · <strong>${swapStateLabel(s.state)}</strong></p>
        <p class="swap-card-detail">${label(s.from_day, s.from_shift)} ⇄ ${label(s.to_day, s.to_shift)}</p>
        ${(mine && s.state === 'pending') ? `<div class="swap-card-actions"><button data-swap-cancel="${s.id}" class="wk-btn">Cancelar</button></div>` : ''}
      </div>`;
    }).join('');

    const canPropose = drivingShiftsOf(data, meId).length > 0 && !state.weekSuspension;
    // Rediseño 2026-08-16: "Pedir cambio de turno" sube a acción principal de la
    // pantalla (botón sólido de ancho completo), como pide la nota de alineación
    // del diseñador — una sola jerarquía de botón por pantalla.
    box.innerHTML = `
      ${incomingHtml || ''}
      ${othersHtml || ''}
      ${(!incoming.length && !others.length) ? `
        <div class="rc-empty">
          <span class="rc-empty-ic">${avIcon('swap', 20, 1.6)}</span>
          <b>Sin cambios de turno</b>
          <p>Los cambios de turno los pides con el botón de abajo.</p>
        </div>` : ''}
      ${canPropose ? `<button id="swap-propose-btn" class="r-btn r-btn-primary" type="button"
          style="width:100%;margin-top:14px;height:54px;font-size:16px;border-radius:14px">
          ${avIcon('plus', 19)} Pedir cambio de turno
        </button>` : ''}`;

    document.getElementById('swap-propose-btn')?.addEventListener('click', openSwapModal);
    box.querySelectorAll('[data-swap-accept]').forEach(b => b.addEventListener('click', () => onSwapDecision(b.dataset.swapAccept, 'accepted', b)));
    box.querySelectorAll('[data-swap-reject]').forEach(b => b.addEventListener('click', () => onSwapDecision(b.dataset.swapReject, 'rejected', b)));
    box.querySelectorAll('[data-swap-cancel]').forEach(b => b.addEventListener('click', () => onSwapDecision(b.dataset.swapCancel, 'cancelled', b)));
  }

  // Al aceptar: re-validar con el horario actual y el email del que acepta.
  async function onSwapDecision(id, decision, btn) {
    if (decision === 'cancelled' && !confirm('¿Cancelar esta solicitud de cambio?')) return;
    if (decision === 'rejected' && !confirm('¿Rechazar este cambio?')) return;
    btn.disabled = true;
    try {
      if (decision === 'accepted') {
        const swaps = await Api.listMySwaps(state.profile.id, state.currentWeek);
        const sw = swaps.find(s => s.id === id);
        if (!sw) throw new Error('La solicitud ya no existe.');
        // Validar de nuevo contra el horario actual (incluye ambas partes por id).
        const fresh = await Api.getSchedule(state.currentWeek);
        const dById = {
          [sw.requester_id]: { id: sw.requester_id, name: (state.pubNames || {})[sw.requester_id] },
          [state.profile.id]: { id: state.profile.id, name: state.profile.full_name, email: state.profile.email },
        };
        const v = Scheduler.validateSwap(fresh?.data || {}, sw, dById);
        if (!v.ok) { alert('No se puede aceptar: ' + v.reason); btn.disabled = false; return; }
      }
      await Api.decideSwap(id, decision);
      // Avisar al solicitante el resultado (si yo soy el destinatario que decide).
      if (decision === 'accepted' || decision === 'rejected') {
        const swaps2 = await Api.listMySwaps(state.profile.id, state.currentWeek).catch(() => []);
        const sw2 = swaps2.find(s => s.id === id);
        if (sw2 && sw2.requester_id !== state.profile.id) {
          notify([sw2.requester_id], 'Cambio de turno',
            `${state.profile.full_name} ${decision === 'accepted' ? 'aceptó' : 'rechazó'} tu cambio.`, '/');
        }
      }
      await refreshDriverView();
      toast({ accepted: 'Cambio aceptado.', rejected: 'Cambio rechazado.', cancelled: 'Solicitud cancelada.' }[decision]);
    } catch (e) {
      alert('Error: ' + e.message);
      btn.disabled = false;
    }
  }

  // Modal para proponer un cambio: elijo MI turno y el turno de un compañero.
  function openSwapModal() {
    document.getElementById('swap-modal')?.remove();
    const data = state.pubSched, names = state.pubNames || {}, meId = state.profile.id;
    const myShifts = drivingShiftsOf(data, meId);
    // Turnos de los DEMÁS conductores (posibles destinos).
    const otherShifts = [];
    Scheduler.DAYS.forEach((day, di) => {
      const d = data[day] || {};
      (d.morning || []).forEach(id => { if (id && id !== meId) otherShifts.push({ id, di, shift: 'am' }); });
      (d.afternoon || []).forEach(id => { if (id && id !== meId) otherShifts.push({ id, di, shift: 'pm' }); });
    });
    const lbl = (di, shift) => `${Scheduler.DAY_LABELS_ES[Scheduler.DAYS[di]]} · ${SHIFT_ES[shift]}`;
    const myOpts = myShifts.map((s, i) => `<option value="${i}">${lbl(s.di, s.shift)}</option>`).join('');
    const otherOpts = otherShifts.map((s, i) => `<option value="${i}">${escapeHtml(names[s.id] || 'Compañero')} — ${lbl(s.di, s.shift)}</option>`).join('');

    const overlay = document.createElement('div');
    overlay.id = 'swap-modal';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-card">
        <div class="modal-head">
          <h3 class="modal-title">Proponer cambio de turno</h3>
          <p class="modal-subtitle">Tu turno se intercambia con el de un compañero. Él debe aceptar.</p>
        </div>
        <label class="swap-field"><span>Cedo mi turno</span>
          <select id="swap-from">${myOpts}</select></label>
        <label class="swap-field"><span>A cambio del turno de</span>
          <select id="swap-to">${otherOpts}</select></label>
        <label class="swap-field"><span>Mensaje (opcional)</span>
          <input id="swap-note" type="text" maxlength="140" placeholder="Ej: tengo una cita ese día"></label>
        <div class="modal-actions">
          <button id="swap-cancel-btn" class="wk-btn">Cancelar</button>
          <button id="swap-send-btn" class="wk-btn wk-coord-on" style="flex:0 0 auto;">Enviar propuesta</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#swap-cancel-btn').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#swap-send-btn').addEventListener('click', async () => {
      const fi = parseInt(overlay.querySelector('#swap-from').value, 10);
      const ti = parseInt(overlay.querySelector('#swap-to').value, 10);
      const mine = myShifts[fi], theirs = otherShifts[ti];
      if (!mine || !theirs) { alert('Elige los dos turnos.'); return; }
      const swap = {
        requester_id: meId, target_id: theirs.id,
        from_day: mine.di, from_shift: mine.shift, to_day: theirs.di, to_shift: theirs.shift,
      };
      const dById = {
        [meId]: { id: meId, name: state.profile.full_name, email: state.profile.email },
        [theirs.id]: { id: theirs.id, name: names[theirs.id] },
      };
      const v = Scheduler.validateSwap(data, swap, dById);
      if (!v.ok) { alert('Ese cambio no es válido: ' + v.reason); return; }
      const btn = overlay.querySelector('#swap-send-btn');
      btn.disabled = true;
      try {
        await Api.createSwap({
          requesterId: meId, targetId: theirs.id, weekStart: state.currentWeek,
          fromDay: mine.di, fromShift: mine.shift, toDay: theirs.di, toShift: theirs.shift,
          note: overlay.querySelector('#swap-note').value.trim() || null,
        });
        notify([theirs.id], 'Cambio de turno', `${state.profile.full_name} te propone un cambio de turno.`, '/');
        overlay.remove();
        await refreshDriverView();
        toast('Propuesta enviada. Tu compañero debe aceptarla.');
      } catch (e) { alert('Error al enviar: ' + e.message); btn.disabled = false; }
    });
  }

