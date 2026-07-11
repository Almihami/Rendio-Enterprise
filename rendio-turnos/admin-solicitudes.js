// admin-solicitudes.js — Admin: solicitudes (aprobaciones).
// Extraído de app.js (split mecánico 2026-07-10, sin cambios de lógica).
// Comparte scope global con los demás módulos; el orden de carga está en index.html.
  // ====================================================================
  // Admin: approvals tab
  // ====================================================================

  async function refreshApprovals() {
    const container = $('#approvals-container');
    const setT = (sel, v) => { const el = $(sel); if (el) el.textContent = v; };
    container.innerHTML = '<div class="sol-empty"><p>Cargando…</p></div>';
    try {
      const driversById = {};
      state.drivers.forEach(d => { driversById[d.id] = d; });
      // Ignora solicitudes huérfanas (conductor borrado/suspendido o no vigente).
      const items = (await Api.listPendingApprovals(state.currentWeek))
        .filter(r => driversById[r.profile_id]);

      const TOTAL = state.drivers.length;
      const cupoOf = (shift) => ((shift === 'am' ? (state.settings && state.settings.morning_slots) : (state.settings && state.settings.afternoon_slots)) || 2);

      // Agrupa por slot (día-jornada) y deriva el tipo según el cupo real:
      // puedes liberar = (total - descansos fijos) - cupo. Si piden más → conflicto.
      const map = {};
      items.forEach(r => {
        const key = `${r.day_of_week}-${r.shift}`;
        (map[key] = map[key] || { key, day_of_week: r.day_of_week, shift: r.shift, items: [] }).items.push(r);
      });
      const groups = Object.values(map).map(g => {
        const dayKey = Scheduler.DAYS[g.day_of_week];
        const pend = g.items.filter(i => i.state === 'pending');
        let fixed = 0;
        state.drivers.forEach(d => { try { if (Scheduler.ruleBlocked(d, dayKey, g.shift)) fixed++; } catch (e) { /* */ } });
        const cupo = cupoOf(g.shift);
        const maxGrant = Math.max(0, (TOTAL - fixed) - cupo);
        const atWheel = Math.max(cupo, TOTAL - fixed - pend.length);
        let kind = 'single';
        if (pend.length > maxGrant) kind = 'conflict';
        else if (pend.length > 1) kind = 'review';
        return { ...g, dayKey, pend, maxGrant, atWheel, kind };
      }).filter(g => g.pend.length > 0)
        .sort((a, b) => a.day_of_week - b.day_of_week || a.shift.localeCompare(b.shift));

      const allPend = groups.reduce((a, g) => a + g.pend.length, 0);
      const nConf = groups.filter(g => g.kind === 'conflict').reduce((a, g) => a + g.pend.length, 0);
      const nSingle = groups.filter(g => g.kind === 'single').reduce((a, g) => a + g.pend.length, 0);
      setT('#solic-count', allPend); setT('#solic-n-all', allPend); setT('#solic-n-conf', nConf); setT('#solic-n-single', nSingle);

      if (allPend === 0) {
        container.innerHTML = `<div class="sol-empty"><div class="circle"><svg class="icon"><use href="#i-check"/></svg></div><h3>Todo al día</h3><p>No hay solicitudes pendientes esta semana.</p></div>`;
        refreshPendingBadge();
        return;
      }

      const filter = state._solicFilter || 'all';
      const shown = groups.filter(g => filter === 'all' ? true : g.kind === filter);
      container.innerHTML = shown.length
        ? shown.map(g => approvalGroupHtml(g, driversById)).join('')
        : `<div class="sol-empty"><h3>Sin solicitudes en este filtro</h3><p>Cambia de pestaña para ver el resto.</p></div>`;

      container.querySelectorAll('button[data-action]').forEach(btn => btn.addEventListener('click', () => onApprovalAction(btn)));
      container.querySelectorAll('button[data-gok]').forEach(btn => btn.addEventListener('click', () => onApproveSlot(btn)));
    } catch (e) {
      container.innerHTML = `<div class="sol-empty"><h3>Error</h3><p>${escapeHtml(e.message)}</p></div>`;
    }
    refreshPendingBadge();
  }

  function approvalGroupHtml(g, driversById) {
    const dayLabel = Scheduler.DAY_LABELS_ES[g.dayKey] || '';
    const tag = g.kind === 'conflict'
      ? `<span class="sol-gtag conflict"><svg class="icon" style="width:13px;height:13px"><use href="#i-warn"/></svg>Conflicto · sobran ${g.pend.length - g.maxGrant}</span>`
      : g.kind === 'single'
        ? `<span class="sol-gtag single"><svg class="icon" style="width:13px;height:13px"><use href="#i-check"/></svg>Singleton</span>`
        : `<span class="sol-gtag review">${g.pend.length} pendientes</span>`;
    const ga = g.kind === 'conflict' ? ''
      : `<div class="sol-gactions"><button class="sol-minibtn green" data-gok="${g.key}" data-ids="${g.pend.map(r => r.id).join(',')}"><svg class="icon"><use href="#i-check"/></svg>Aprobar slot</button></div>`;
    return `<div class="sol-group ${g.kind === 'conflict' ? 'conflict' : ''}">
      <div class="sol-ghead">
        <span class="sol-slot"><b>${dayLabel}</b><span class="band ${g.shift}">${g.shift.toUpperCase()}</span></span>
        <span class="sol-cupoinfo">Piden <b>${g.pend.length}</b> · puedes liberar <b>${g.maxGrant}</b> · quedan <b>${g.atWheel}</b> al volante</span>
        ${tag}${ga}
      </div>
      ${g.items.map(r => approvalRowHtml(r, driversById)).join('')}
    </div>`;
  }

  function approvalRowHtml(r, driversById) {
    const d = driversById[r.profile_id];
    const name = (d && d.name) || 'Conductor eliminado';
    const reasonTxt = r.kind === 'unavailable' ? (r.reason || '(sin texto)') : 'Descanso';
    const avt = `<span class="sol-avt" style="background:${colorOfId(r.profile_id)}">${escapeHtml(initialsOf(name))}</span>`;
    if (r.state !== 'pending') {
      const ok = r.state === 'approved';
      return `<div class="sol-req done">${avt}
        <div class="sol-who"><b>${escapeHtml(name)}</b><div class="meta"><span class="rsn">${escapeHtml(reasonTxt)}</span></div></div>
        <span class="sol-resolved ${ok ? 'ok' : 'no'}"><svg class="icon"><use href="#${ok ? 'i-check' : 'i-x'}"/></svg>${ok ? 'Aprobado' : 'Rechazado'}</span>
      </div>`;
    }
    const prio = (d && d.priority) || 1;
    const senior = `<span class="sol-senior s${prio}"><span class="dot"></span>${prio} · ${SR_LABELS[prio] || ''}</span>`;
    const note = r.admin_note ? `<span class="rsn" style="color:var(--ink2);font-weight:400">· ${escapeHtml(r.admin_note)}</span>` : '';
    return `<div class="sol-req">${avt}
      <div class="sol-who"><b>${escapeHtml(name)}</b><div class="meta"><span class="rsn">${escapeHtml(reasonTxt)}</span>${note}</div></div>
      ${senior}
      <div class="sol-ractions">
        <button class="sol-rbtn ok" data-action="approve" data-id="${r.id}"><svg class="icon"><use href="#i-check"/></svg>Aprobar</button>
        <button class="sol-rbtn no" data-action="reject" data-id="${r.id}"><svg class="icon"><use href="#i-x"/></svg>Rechazar</button>
      </div>
    </div>`;
  }

  async function onApproveSlot(btn) {
    const ids = (btn.dataset.ids || '').split(',').filter(Boolean);
    if (!ids.length) return;
    btn.disabled = true;
    try {
      for (const id of ids) await Api.resolveApproval(id, 'approved', null);
      await refreshApprovals();
      toast(`${ids.length} descanso(s) aprobado(s).`);
    } catch (e) {
      alert('Error: ' + e.message);
      btn.disabled = false;
    }
  }

  async function onApprovalAction(btn) {
    const id = btn.dataset.id;
    const action = btn.dataset.action;
    let note = null;
    if (action === 'reject') {
      note = prompt('Nota para el conductor (opcional):') || null;
    }
    btn.disabled = true;
    try {
      await Api.resolveApproval(id, action === 'approve' ? 'approved' : 'rejected', note);
      await refreshApprovals();
      toast(action === 'approve' ? '✓ Aprobada' : '✗ Rechazada');
    } catch (e) {
      alert('Error: ' + e.message);
      btn.disabled = false;
    }
  }

  async function onAutoResolve() {
    if (!confirm('¿Auto-aprobar solicitudes de fin de semana que sean singleton (1 solo conductor)?')) return;
    try {
      const n = await Api.runAutoResolve();
      toast(`${n} auto-aprobada(s)`);
      await refreshApprovals();
    } catch (e) {
      alert('Error: ' + e.message);
    }
  }

  function approvalBadgeHtml(req) {
    if (!req) return '';
    const label = { pending: 'Pendiente', approved: 'Aprobada', rejected: 'Rechazada' }[req.state] || req.state;
    return `<span class="approval-badge" data-state="${req.state}">${label}</span>`;
  }

