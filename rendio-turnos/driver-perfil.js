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

  function profileMainHtml() {
    const d = state.profileData; const p = d.prof; const dp = p.driver || {};
    const av = p.avatar_url;
    const lic = dp.license_number ? `${escapeHtml(dp.license_number)}${dp.license_expires_at ? ' · vence ' + new Date(dp.license_expires_at).getFullYear() : ''}` : '—';
    const sc = d.activeStrikes.length;
    const strikeCard = strikeCardHtml(sc, d.susp);
    const next = d.rewards.find(r => r.km_threshold > d.kmTotal);
    const faltan = next ? next.km_threshold - d.kmTotal : 0;
    const ov = d.openShift && d.openShift.vehicles ? d.openShift.vehicles : null;
    return `
      <div class="pt-1 pb-2"><h2 class="text-[22px] font-extrabold text-ink leading-tight">Perfil</h2></div>
      <div class="space-y-5 pb-6">
        <div class="flex items-center gap-4">
          <button id="pf-avatar-btn" class="relative w-20 h-20 rounded-full bg-gradient-to-br from-brand-400 to-brand-600 text-white text-2xl font-extrabold flex items-center justify-center shadow-brand ring-4 ring-white overflow-hidden active:scale-95">
            ${av ? `<img src="${escapeHtml(av)}" class="w-full h-full object-cover">` : escapeHtml(initialsOf(p.full_name || 'Conductor'))}
            <span class="absolute bottom-0 right-0 w-6 h-6 rounded-full bg-white text-brand-600 border-2 border-white flex items-center justify-center text-[11px]">✎</span>
          </button>
          <input id="pf-avatar-input" type="file" accept="image/*" class="hidden">
          <div>
            <p class="text-xl font-extrabold text-ink">${escapeHtml(p.full_name || 'Conductor')}</p>
            <p class="text-sm text-slate-500">Conductor${p.home_base ? ' · ' + escapeHtml(p.home_base) : ''}</p>
            ${p.is_active === false ? '<p class="text-[11px] text-rose-600 font-bold mt-1">Cuenta suspendida</p>' : '<p class="text-[11px] text-emerald-600 font-bold mt-1 flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>Activo</p>'}
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3">
          ${pfField('Cédula', p.document_id || '—')}
          ${pfField('Teléfono', p.phone || '—')}
          ${pfField('Licencia', lic)}
          ${pfField('Base', p.home_base || '—')}
        </div>

        ${strikeCard}

        <button id="pf-rewards-btn" class="sheen w-full text-left rounded-2xl p-5 bg-gradient-to-br from-brand-500 to-brand-600 text-white shadow-brand active:scale-[.99] transition">
          <div class="flex items-center justify-between">
            <span class="text-xs font-bold uppercase tracking-wider text-white/85">🎁 Recompensas</span>
            ${currentTier(d.kmTotal, d.rewards) ? `<span class="text-[10px] font-bold bg-white/20 rounded-full px-2 py-0.5">Nivel ${TIER_META[currentTier(d.kmTotal, d.rewards)].label}</span>` : ''}
          </div>
          <p class="text-3xl font-extrabold mt-2 tabular-nums">${d.kmTotal.toLocaleString('es-CO')} <span class="text-base font-bold text-white/80">km</span></p>
          <p class="text-[12px] text-white/85 mt-2">${next ? `Te faltan ${faltan.toLocaleString('es-CO')} km para ${escapeHtml(next.title)}` : (d.rewards.length ? '¡Todo desbloqueado!' : 'Aún no hay recompensas configuradas')}</p>
          <span class="inline-flex items-center gap-1 mt-3 text-sm font-bold">Ver recompensas →</span>
        </button>

        <div class="rounded-2xl bg-white border border-slate-200 shadow-card flex items-center gap-3 px-4 py-3.5">
          <span class="w-9 h-9 rounded-lg bg-slate-100 flex items-center justify-center text-lg shrink-0">🚐</span>
          <div class="flex-1"><p class="text-sm font-semibold text-ink">Vehículo actual</p><p class="text-[11px] text-slate-400">${ov ? escapeHtml((ov.internal_code || ov.license_plate || '') + ' · ' + [ov.brand, ov.model].filter(Boolean).join(' ')) : 'Sin turno activo'}</p></div>
        </div>

        <button id="pf-logout" class="w-full text-center text-sm font-bold text-rose-500 py-2">Cerrar sesión</button>
      </div>`;
  }
  function pfField(label, val) {
    return `<div class="rounded-2xl bg-white border border-slate-200 p-3.5"><p class="text-[10px] text-slate-400 font-bold uppercase tracking-wide">${escapeHtml(label)}</p><p class="text-sm font-bold text-ink mt-0.5">${escapeHtml(String(val))}</p></div>`;
  }
  function currentTier(km, rewards) {
    const unlocked = rewards.filter(r => km >= r.km_threshold);
    if (!unlocked.length) return null;
    const top = unlocked[unlocked.length - 1];
    return top.tier in TIER_META ? top.tier : null;
  }
  function strikeCardHtml(count, susp) {
    let cls, icon, titleCol, title, sub;
    if (susp) { cls = 'bg-rose-50 border-2 border-rose-300'; icon = '🚫'; titleCol = 'text-rose-700'; title = 'Suspendido la próxima semana'; sub = 'Por acumular 3 strikes'; }
    else if (count >= 2) { cls = 'bg-rose-50 border-2 border-rose-200'; icon = '🚨'; titleCol = 'text-rose-700'; title = `${count} de 3 strikes`; sub = '¡Cuidado! Un strike más y te suspenden'; }
    else if (count === 1) { cls = 'bg-amber-50 border-2 border-amber-200'; icon = '⚠️'; titleCol = 'text-amber-700'; title = '1 de 3 strikes'; sub = 'Revisa el motivo y cuida tu operación'; }
    else { cls = 'bg-white border border-slate-200 shadow-card'; icon = '✅'; titleCol = 'text-emerald-700'; title = 'Sin strikes'; sub = 'Buen historial — sigue así'; }
    const dotCol = count >= 2 || susp ? 'bg-rose-500' : (count === 1 ? 'bg-amber-500' : 'bg-emerald-500');
    const dots = [1, 2, 3].map(i => `<div class="w-6 h-1.5 rounded-full ${i <= count ? dotCol : 'bg-slate-200'}"></div>`).join('');
    return `<button id="pf-strikes-btn" class="w-full text-left rounded-2xl p-4 ${cls} active:scale-[.99] transition">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-xl bg-white flex items-center justify-center text-xl shrink-0 shadow-sm">${icon}</div>
        <div class="flex-1 min-w-0"><p class="text-sm font-extrabold ${titleCol}">${title}</p><p class="text-xs text-slate-500">${sub}</p></div>
        <span class="${titleCol} font-bold">›</span>
      </div>
      <div class="flex gap-1.5 mt-3">${dots}</div>
    </button>`;
  }

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

  // Saludo de la home ("Carlos · Martes 10 de junio") + estado de la tarjeta de disponibilidad.
  function updateDriverHome() {
    const sub = $('#driver-home-sub');
    if (sub && state.profile) {
      const name = firstNameOf(state.profile);
      const today = new Date().toLocaleDateString('es-CO',
        { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Bogota' });
      sub.textContent = `${name} · ${today.charAt(0).toUpperCase()}${today.slice(1)}`;
    }
    const cardSub = $('#driver-availability-card-sub');
    if (cardSub) cardSub.textContent = availabilitySummaryText();
  }

  // La pantalla de Disponibilidad (tarjetas por día, selector de estado en modal,
  // fila Prefiero AM/PM y barra fija de Guardar) se reemplazó por completo el
  // 2026-08-16 con el rediseño del diseñador: ahora vive en driver-disponibilidad.js
  // (grilla 7×2 que se pinta arrastrando + medidor de 14 jornadas). Allá quedaron
  // renderDriverDays() y availabilitySummaryText(), que este archivo sigue llamando.


  async function renderDriverRequests() {
    const box = $('#driver-requests-container');
    try {
      const reqs = await Api.listMyApprovalRequests(state.profile.id, state.currentWeek);
      const icons = { pending: '⏳', approved: '✓', rejected: '✗' };
      const reqCards = reqs.map(r => {
        const dayLabel = Scheduler.DAY_LABELS_ES[Scheduler.DAYS[r.day_of_week]] || '—';
        const kindLabel = r.kind === 'unavailable' ? 'No disponible' : 'Descanso';
        const stateLabel = { pending: 'Pendiente', approved: 'Aprobada', rejected: 'Rechazada' }[r.state] || r.state;
        return `<div class="request-card" data-state="${r.state}">
          <div class="request-card-icon">${icons[r.state] || '?'}</div>
          <div class="flex-1 min-w-0">
            <p class="text-sm font-semibold text-ink">${dayLabel} · ${r.shift.toUpperCase()}</p>
            <p class="text-xs text-slate-600">${kindLabel} · <strong>${stateLabel}</strong></p>
            ${r.reason ? `<p class="text-xs text-slate-500 mt-1">${escapeHtml(r.reason)}</p>` : ''}
            ${r.admin_note ? `<p class="text-xs text-slate-500 mt-1 italic">Nota admin: ${escapeHtml(r.admin_note)}</p>` : ''}
          </div>
        </div>`;
      }).join('');

      // Descansos entre semana sin solicitud formal: se muestran como
      // "Pendiente — se confirma al publicar" para que el conductor sepa que
      // su intención está registrada (el scheduler la respeta) pero el admin
      // decide al publicar el horario.
      const haveReq = new Set(reqs.map(r => `${r.day_of_week}-${r.shift}`));
      const pendingCards = [];
      Scheduler.DAYS.forEach((dayKey, idx) => {
        const cell = state.ownAvail && state.ownAvail[dayKey];
        if (!cell) return;
        ['am', 'pm'].forEach(sh => {
          if (cell[sh] === 'prefer_rest' && !haveReq.has(`${idx}-${sh}`)) {
            const dayLabel = Scheduler.DAY_LABELS_ES[dayKey] || '—';
            pendingCards.push(`<div class="request-card" data-state="pending">
              <div class="request-card-icon">⏳</div>
              <div class="flex-1 min-w-0">
                <p class="text-sm font-semibold text-ink">${dayLabel} · ${sh.toUpperCase()}</p>
                <p class="text-xs text-slate-600">Descanso · <strong>Pendiente</strong></p>
                <p class="text-xs text-slate-500 mt-1">Se confirma cuando el admin publique el horario.</p>
              </div>
            </div>`);
          }
        });
      });

      box.innerHTML = (reqCards + pendingCards.join('')) ||
        '<p class="text-xs text-slate-500 bg-white border border-slate-200 rounded-xl p-4 text-center">No tienes solicitudes esta semana.</p>';
    } catch (e) {
      box.innerHTML = `<p class="text-sm text-rose-600 p-3">Error: ${e.message}</p>`;
    }
  }

  async function renderDriverPublishedSchedule() {
    const container = $('#driver-schedule-container');
    const summaryBox = $('#driver-week-summary');
    const sch = await Api.getSchedule(state.currentWeek);
    if (!sch || !sch.published) {
      container.innerHTML = '<p class="p-6 text-sm text-slate-500 text-center">Esta semana no tiene horario publicado todavía.</p>';
      if (summaryBox) {
        summaryBox.innerHTML = `<div class="rounded-xl border border-brand-100 bg-gradient-to-br from-brand-50 to-white p-4 shadow-card">
          <p class="text-sm font-bold text-ink">Mi semana</p>
          <p class="text-sm text-slate-600 mt-1.5">Tu horario aún no está publicado para esta semana.</p>
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
    if (summaryBox) {
      if (!myShifts.length) {
        summaryBox.innerHTML = `<div class="bg-white border border-slate-200 rounded-xl p-4 shadow-card">
          <p class="text-sm font-bold text-ink">Mi semana</p>
          <p class="text-sm text-slate-500 mt-1">No tienes turnos asignados esta semana.</p>
        </div>`;
      } else {
        const horas = myShifts.length * ((state.settings && state.settings.shift_hours) || 12);
        const items = myShifts.map(s => `<li class="flex items-center justify-between border-b border-slate-100 last:border-0 py-1.5">
          <span class="text-sm text-ink">${s.d.label} ${s.d.dayNum}</span>
          <span class="text-xs font-semibold ${s.lead ? 'text-orange-600' : 'text-slate-600'}">${s.shift}${s.lead ? ' · ★ Líder' : ''}</span>
        </li>`).join('');
        summaryBox.innerHTML = `<div class="bg-white border border-slate-200 rounded-xl p-4 shadow-card">
          <p class="text-sm font-bold text-ink">Mi semana</p>
          <p class="text-xs text-slate-500 mt-0.5 mb-2">${myShifts.length} turno${myShifts.length === 1 ? '' : 's'} · ${horas} h aprox.</p>
          <ul>${items}</ul>
        </div>`;
      }
    }

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
    box.innerHTML = `
      <div class="flex items-center justify-between mb-2">
        <h3 class="text-sm font-bold text-ink">Cambios de turno</h3>
        ${canPropose ? '<button id="swap-propose-btn" class="wk-btn wk-coord-on" style="flex:0 0 auto;">+ Proponer cambio</button>' : ''}
      </div>
      ${incomingHtml || ''}
      ${othersHtml || ''}
      ${(!incoming.length && !others.length) ? '<p class="text-xs text-slate-500 bg-white border border-slate-200 rounded-xl p-3 text-center">No tienes cambios de turno esta semana.</p>' : ''}`;

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

