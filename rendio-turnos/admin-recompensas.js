// admin-recompensas.js — Admin: recompensas (solicitudes + catálogo).
// Extraído de app.js (split mecánico 2026-07-10, sin cambios de lógica).
// Comparte scope global con los demás módulos; el orden de carga está en index.html.
  // ====================================================================
  // Admin: Recompensas (diseño UX/UI) — solicitudes + catálogo + agregar/editar
  // (km por conductor vive ahora en Personal)
  // ====================================================================
  const rewardsAdminState = { editId: null, data: { rewards: [], redemptions: [] } };
  const RW_LEVELS = { plata: { label: 'Plata', icon: 'i-medal' }, oro: { label: 'Oro', icon: 'i-medal' }, diamante: { label: 'Diamante', icon: 'i-gem' } };
  function rwTierEmblem(level, sm) { const L = RW_LEVELS[level] || RW_LEVELS.plata; return `<span class="tier ${level}${sm ? ' sm' : ''}"><svg class="icon"><use href="#${L.icon}"/></svg></span>`; }
  function rwInitials(n) { const p = (n || '').trim().split(/\s+/); return (((p[0] || '')[0] || '') + ((p[1] || p[0] || '')[0] || '')).toUpperCase() || '·'; }

  async function renderRewardsAdmin() {
    const box = $('#rewards-ui'); if (!box) return;
    box.innerHTML = '<p style="padding:24px;color:var(--ink2)">Cargando…</p>';
    let rewards = [], redemptions = [];
    try {
      [rewards, redemptions] = await Promise.all([
        Api.listAllRewards().catch(() => []),
        Api.listRedemptionsAdmin().catch(() => []),
      ]);
    } catch (e) { console.error(e); }
    rewardsAdminState.data = { rewards, redemptions };
    drawRewardsAdmin();
  }

  function drawRewardsAdmin() {
    const box = $('#rewards-ui'); if (!box) return;
    const { rewards, redemptions } = rewardsAdminState.data;
    const esc = escapeHtml;
    const fmtWhen = (s) => { try { return new Date(s).toLocaleString('es-CO', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/Bogota' }); } catch (e) { return ''; } };

    // --- Solicitudes de redención ---
    const pend = (redemptions || []).filter(r => r.status === 'pending').length;
    const redListHtml = (redemptions || []).length ? (redemptions || []).map(r => {
      const prof = r.driver_profiles && r.driver_profiles.profiles;
      const who = (prof && prof.full_name) || '—';
      const rw = r.rewards || { title: '—', tier: 'plata', km_threshold: 0 };
      const color = colorOfId((prof && prof.id) || r.id);
      if (r.status !== 'pending') {
        const isOk = r.status === 'delivered' || r.status === 'approved';
        return `<div class="redrow done">
          <span class="avt" style="background:${color}">${esc(rwInitials(who))}</span>
          <div class="rwho"><b>${esc(who)}</b><div class="meta"><span class="rw">${rwTierEmblem(rw.tier, true)}${esc(rw.title)}</span></div></div>
          <span class="kmtag">${(rw.km_threshold || 0).toLocaleString('es-CO')} km</span>
          <span class="resolved ${isOk ? 'ok' : 'no'}"><svg class="icon"><use href="#${isOk ? 'i-check' : 'i-x'}"/></svg>${isOk ? 'Entregado' : 'Rechazado'} <button class="undo" data-undo="${r.id}">Deshacer</button></span>
        </div>`;
      }
      return `<div class="redrow">
        <span class="avt" style="background:${color}">${esc(rwInitials(who))}</span>
        <div class="rwho"><b>${esc(who)}</b><div class="meta"><span class="rw">${rwTierEmblem(rw.tier, true)}${esc(rw.title)}</span><span class="when"><svg class="icon" style="width:12px;height:12px"><use href="#i-clock"/></svg>${esc(fmtWhen(r.requested_at))}</span></div></div>
        <span class="kmtag">${(rw.km_threshold || 0).toLocaleString('es-CO')} km</span>
        <div class="ractions">
          <button class="rbtn no" data-red="rejected" data-id="${r.id}"><svg><use href="#i-x"/></svg>Rechazar</button>
          <button class="rbtn ok" data-red="delivered" data-id="${r.id}"><svg><use href="#i-check"/></svg>Entregar</button>
        </div>
      </div>`;
    }).join('') : `<div class="emptyrow"><div class="circle"><svg class="icon"><use href="#i-check"/></svg></div><b>No hay solicitudes de redención</b><span>Cuando un conductor pida canjear un premio, aparecerá aquí.</span></div>`;

    // --- Catálogo ---
    const sorted = [...(rewards || [])].sort((a, b) => a.km_threshold - b.km_threshold);
    const ed = rewardsAdminState.editId ? (rewards || []).find(r => r.id === rewardsAdminState.editId) : null;
    const catHtml = sorted.length ? sorted.map(c => `<div class="rwd ${c.active ? '' : 'off'}">
        ${rwTierEmblem(c.tier)}
        <div class="rinfo"><div class="rtop"><b>${esc(c.title)}</b><span class="levelchip ${c.tier}">${(RW_LEVELS[c.tier] || {}).label || c.tier}</span><span class="km">${(c.km_threshold || 0).toLocaleString('es-CO')} km</span></div><div class="desc">${esc(c.description || '')}</div></div>
        <div class="rctl">
          <span class="tglabel ${c.active ? 'on' : ''}">${c.active ? 'Activa' : 'Off'}</span>
          <button class="tg ${c.active ? 'on' : ''}" data-tg="${c.id}" title="Activar / desactivar"></button>
          <button class="cfgbtn" data-edit="${c.id}" title="Editar"><svg class="icon" style="width:15px;height:15px"><use href="#i-edit"/></svg></button>
          <button class="cfgbtn danger" data-del="${c.id}" title="Eliminar"><svg class="icon" style="width:15px;height:15px"><use href="#i-trash"/></svg></button>
        </div>
      </div>`).join('') : `<div class="emptyrow"><div class="circle" style="background:var(--orange-soft);color:var(--orange)"><svg class="icon"><use href="#i-gift"/></svg></div><b>Aún no hay recompensas</b><span>Crea la primera abajo.</span></div>`;

    box.innerHTML = `
      <div class="phead"><h1>Recompensas</h1><p>Define los premios por kilometraje y atiende las solicitudes de redención de los conductores.</p></div>

      <div class="card">
        <div class="ch"><div class="ci"><svg class="icon"><use href="#i-inbox"/></svg></div><div><h2>Solicitudes de redención</h2><p>Premios que un conductor pidió canjear. Entrégalos o recházalos.</p></div><span class="count${pend ? ' alert' : ''}">${pend}</span></div>
        <div class="cbody flush">${redListHtml}</div>
      </div>

      <div class="card">
        <div class="ch"><div class="ci"><svg class="icon"><use href="#i-gift"/></svg></div><div><h2>Catálogo de recompensas</h2><p>Premios disponibles, ordenados por kilometraje. Desactiva sin perder el historial.</p></div><span class="count">${(rewards || []).filter(c => c.active).length} activas</span></div>
        <div class="cbody flush">${catHtml}</div>
      </div>

      <div class="card" style="margin-bottom:0">
        <div class="ch"><div class="ci"><svg class="icon"><use href="#i-plus"/></svg></div><div><h2>${ed ? 'Editar recompensa' : 'Agregar recompensa'}</h2><p>${ed ? 'Modifica el premio y guarda los cambios.' : 'Crea un nuevo premio. Aparece de inmediato en la app del conductor.'}</p></div></div>
        <div class="cbody">
          <div class="grid2">
            <div class="field"><label>Título</label><input class="input" id="rw-title" placeholder="Ej: Bono de gasolina" value="${ed ? esc(ed.title) : ''}"></div>
            <div class="field"><label>Km para desbloquear</label><input class="input mono" id="rw-km" type="number" min="0" step="500" placeholder="5000" value="${ed ? ed.km_threshold : ''}"></div>
          </div>
          <div class="grid2" style="margin-top:14px">
            <div class="field"><label>Nivel</label><div class="selwrap"><select class="sel" id="rw-tier">
              <option value="plata"${ed && ed.tier === 'plata' ? ' selected' : ''}>Plata</option>
              <option value="oro"${ed && ed.tier === 'oro' ? ' selected' : ''}>Oro</option>
              <option value="diamante"${ed && ed.tier === 'diamante' ? ' selected' : ''}>Diamante</option>
            </select><span class="chev"><svg class="icon"><use href="#i-chev"/></svg></span></div></div>
            <div class="field"><label>Descripción</label><input class="input" id="rw-desc" placeholder="Ej: $50.000 en combustible" value="${ed ? esc(ed.description || '') : ''}"></div>
          </div>
          <div class="formfoot"><button class="btn" id="rw-save"><svg class="icon"><use href="#i-plus"/></svg>${ed ? 'Guardar cambios' : 'Agregar recompensa'}</button>${ed ? '<button class="btn ghost" id="rw-cancel">Cancelar</button>' : ''}<span id="rw-state" style="font-size:12px;color:var(--ink2)"></span></div>
        </div>
      </div>`;
    bindRewardsAdmin();
  }

  function bindRewardsAdmin() {
    const box = $('#rewards-ui'); if (!box) return;
    box.querySelectorAll('[data-red]').forEach(b => b.addEventListener('click', () => resolveRedeem(b.dataset.id, b.dataset.red)));
    box.querySelectorAll('[data-undo]').forEach(b => b.addEventListener('click', () => resolveRedeem(b.dataset.undo, 'pending')));
    box.querySelectorAll('[data-tg]').forEach(b => b.addEventListener('click', () => onToggleReward(b.dataset.tg)));
    box.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => { rewardsAdminState.editId = b.dataset.edit; drawRewardsAdmin(); }));
    box.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => onDeleteReward(b.dataset.del)));
    $('#rw-save')?.addEventListener('click', onSaveReward);
    $('#rw-cancel')?.addEventListener('click', () => { rewardsAdminState.editId = null; drawRewardsAdmin(); });
  }

  async function onSaveReward() {
    const title = ($('#rw-title')?.value || '').trim();
    const km = parseInt($('#rw-km')?.value, 10);
    const tier = $('#rw-tier')?.value || 'plata';
    const desc = ($('#rw-desc')?.value || '').trim() || null;
    const st = $('#rw-state');
    if (!title) { if (st) st.textContent = 'Escribe un título.'; return; }
    if (!(km >= 0)) { if (st) st.textContent = 'Indica los km para desbloquear.'; return; }
    try {
      if (rewardsAdminState.editId) {
        await Api.updateReward(rewardsAdminState.editId, { title, km_threshold: km, tier, description: desc });
        rewardsAdminState.editId = null;
        toast('Recompensa actualizada.');
      } else {
        await Api.createReward({ organization_id: state.profile.organization_id, title, km_threshold: km, tier, description: desc });
        toast('“' + title + '” agregada al catálogo.');
        // Avisar a los conductores que hay una recompensa nueva.
        try { await notify((state.drivers || []).map(d => d.id), '🎁 Nueva recompensa', `Ya puedes ganar "${title}" con tus kilómetros (${km.toLocaleString('es-CO')} km).`, '/'); } catch (e) { /* push best-effort */ }
      }
      renderRewardsAdmin();
    } catch (e) { console.error(e); if (st) st.textContent = 'No se pudo guardar: ' + (e.message || 'error'); }
  }
  async function onDeleteReward(id) {
    if (!confirm('¿Eliminar esta recompensa? Las solicitudes ya hechas se conservan.')) return;
    try { await Api.deleteReward(id); toast('Recompensa eliminada.'); renderRewardsAdmin(); }
    catch (e) { console.error(e); toast('No se pudo eliminar: ' + (e.message || 'error')); }
  }
  async function onToggleReward(id) {
    const r = (rewardsAdminState.data.rewards || []).find(x => x.id === id); if (!r) return;
    try { await Api.updateReward(id, { active: !r.active }); toast(r.title + (r.active ? ' desactivada.' : ' activada.')); renderRewardsAdmin(); }
    catch (e) { console.error(e); toast('No se pudo cambiar el estado.'); }
  }
  async function resolveRedeem(id, status) {
    if (status !== 'pending') {
      const label = status === 'delivered' ? 'marcar como ENTREGADA' : 'RECHAZAR';
      if (!confirm(`¿${label} esta solicitud?`)) return;
    }
    try {
      await Api.resolveRedemption(id, status, null);
      // Push al conductor cuando se resuelve (no en "deshacer").
      if (status === 'delivered' || status === 'rejected') {
        const r = (rewardsAdminState.data.redemptions || []).find(x => x.id === id);
        const pid = r && r.driver_profiles && r.driver_profiles.profiles && r.driver_profiles.profiles.id;
        const title = (r && r.rewards && r.rewards.title) || 'tu recompensa';
        if (pid) {
          try {
            await notify([pid],
              status === 'delivered' ? '🎁 Recompensa entregada' : 'Recompensa no aprobada',
              status === 'delivered' ? `Tu recompensa "${title}" fue entregada. ¡Disfrútala!` : `Tu solicitud de "${title}" no fue aprobada. Habla con tu administrador.`,
              '/');
          } catch (e) { /* push best-effort */ }
        }
      }
      renderRewardsAdmin();
    } catch (e) { console.error(e); toast('No se pudo actualizar: ' + (e.message || 'error')); }
  }

