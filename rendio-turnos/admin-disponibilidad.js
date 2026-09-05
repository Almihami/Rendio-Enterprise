// admin-disponibilidad.js — Admin: matriz de disponibilidad consolidada.
// Extraído de app.js (split mecánico 2026-07-10, sin cambios de lógica).
// Comparte scope global con los demás módulos; el orden de carga está en index.html.
  // ====================================================================
  // Admin: availability matrix
  // ====================================================================

  async function refreshAvailabilityMatrix() {
    state.availability = await Api.getWeeklyAvailability(state.currentWeek, state.drivers);
    renderAvailability();
    refreshPendingBadge();
  }

  // Estado visual de un slot (paleta limpia) a partir del estado crudo +
  // la solicitud de aprobación + el bloqueo por parametrización.
  //   avail = trabaja · req = descanso pedido · off = aprobado · rej = rechazado
  //   lock = fijo · none = sin marcar (el conductor no respondió: no entra a la
  //   generación desde el rediseño 2026-08-16)
  function availVisual(av, shift, blocked) {
    if (blocked) return 'lock';
    const raw = av[shift] || 'unset';
    if (raw === 'unset') return 'none';
    if (raw === 'available') return 'avail';
    const req = av[`${shift}_request`];
    if (req && req.state === 'approved') return 'off';
    if (req && req.state === 'rejected') return 'rej';
    return 'req';
  }

  // Render del matriz de disponibilidad (sin fetch). Lo llama
  // refreshAvailabilityMatrix (tras traer datos) y los filtros/búsqueda.
  function renderAvailability() {
    const head = $('#avail-head'), body = $('#avail-body');
    if (!head || !body) return;
    const week = Scheduler.weekDates(state.currentWeek);
    const WKND = [5, 6];
    const MON = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
    const lbl = $('#avail-week-label');
    if (lbl && week.length) {
      const m0 = new Date(week[0].date + 'T00:00:00').getMonth();
      const m6 = new Date(week[6].date + 'T00:00:00').getMonth();
      lbl.textContent = m0 === m6
        ? `${week[0].dayNum} – ${week[6].dayNum} ${MON[m6]}`
        : `${week[0].dayNum} ${MON[m0]} – ${week[6].dayNum} ${MON[m6]}`;
    }
    const cupoAm = (state.settings && state.settings.morning_slots) || 2;
    const cupoPm = (state.settings && state.settings.afternoon_slots) || 2;

    // Mapa visual por driver/día/jornada.
    const vis = {};
    state.drivers.forEach(d => {
      vis[d.id] = {};
      week.forEach(day => {
        const av = state.availability[d.id]?.[day.key] || { am: 'unset', pm: 'unset' };
        vis[d.id][day.key] = {
          am: availVisual(av, 'am', Scheduler.ruleBlocked(d, day.key, 'am')),
          pm: availVisual(av, 'pm', Scheduler.ruleBlocked(d, day.key, 'pm')),
        };
      });
    });

    // Resumen.
    let nReq = 0, nOff = 0, nLock = 0, nNone = 0;
    state.drivers.forEach(d => week.forEach(day => ['am', 'pm'].forEach(b => {
      const v = vis[d.id][day.key][b];
      if (v === 'req') nReq++; else if (v === 'off') nOff++; else if (v === 'lock') nLock++; else if (v === 'none') nNone++;
    })));
    const working = (dayKey, b) => state.drivers.filter(d => {
      const v = vis[d.id][dayKey][b]; return v === 'avail' || v === 'rej';
    }).length;
    let underCupo = 0;
    week.forEach(day => { if (working(day.key, 'am') < cupoAm) underCupo++; if (working(day.key, 'pm') < cupoPm) underCupo++; });
    const sum = $('#avail-summary');
    if (sum) sum.innerHTML = `
      <div class="av-scard" data-jump="pending"><div class="ic blue"><svg class="icon"><use href="#i-clock"/></svg></div><div><div class="n">${nReq}</div><div class="l">Descansos pedidos</div></div></div>
      <div class="av-scard"><div class="ic rest"><svg class="icon"><use href="#i-zzz"/></svg></div><div><div class="n">${nOff}</div><div class="l">Descansos aprobados</div></div></div>
      <div class="av-scard"><div class="ic lock"><svg class="icon"><use href="#i-lock"/></svg></div><div><div class="n">${nLock}</div><div class="l">Descansos fijos</div></div></div>
      <div class="av-scard"><div class="ic warn"><svg class="icon"><use href="#i-warn"/></svg></div><div><div class="n">${underCupo}</div><div class="l">Slots bajo cupo</div></div></div>
      <div class="av-scard"><div class="ic none"><svg class="icon"><use href="#i-clock"/></svg></div><div><div class="n">${nNone}</div><div class="l">Sin marcar</div></div></div>`;

    // Cabecera.
    head.innerHTML = `<tr><th class="namehead">Conductor</th>${week.map((d, i) => `<th><div class="dcell${WKND.includes(i) ? ' wknd' : ''}"><div class="dow">${d.label.slice(0, 3)}</div><div class="dnum">${d.dayNum}</div></div></th>`).join('')}</tr>`;

    // Filtro + búsqueda.
    const filter = state._availFilter || 'all';
    const q = ($('#avail-search') && $('#avail-search').value || '').toLowerCase().trim();
    const isVisible = d => {
      if (q && !d.name.toLowerCase().includes(q)) return false;
      if (filter === 'all') return true;
      let change = false, pend = false;
      week.forEach(day => ['am', 'pm'].forEach(b => { const v = vis[d.id][day.key][b]; if (v !== 'avail') change = true; if (v === 'req') pend = true; }));
      return filter === 'changes' ? change : pend;
    };
    const rows = state.drivers.filter(isVisible);

    // Fila de cobertura + filas de conductores.
    const pip = (n, cupo) => { const cls = n < cupo ? (n === 0 ? 'bad' : 'warn') : ''; return `<span class="covpip ${cls}"><span class="d"></span>${n}</span>`; };
    let html = `<tr class="covrow"><td class="namehead2">Al volante / cupo</td>${week.map(d => `<td><div class="covcell">${pip(working(d.key, 'am'), cupoAm)}${pip(working(d.key, 'pm'), cupoPm)}</div></td>`).join('')}</tr>`;
    if (!rows.length) html += `<tr><td class="name">—</td><td colspan="7" class="av-none">Sin coincidencias.</td></tr>`;
    const ICON = { req: 'i-clock', off: 'i-zzz', rej: 'i-x', lock: 'i-lock' };
    rows.forEach(d => {
      const role = d.can_coordinate ? 'Líder de turno' : 'Conductor';
      html += `<tr><td class="name"><div class="person"><span class="av-avt" style="background:${colorOfId(d.id)}">${escapeHtml(initialsOf(d.name))}</span><div><b>${escapeHtml(d.name)}</b><span>${role}</span></div></div></td>`;
      week.forEach((day, i) => {
        const av = state.availability[d.id]?.[day.key] || { am: 'unset', pm: 'unset' };
        const cell = (b) => {
          const v = vis[d.id][day.key][b];
          const blocked = v === 'lock';
          const rawState = blocked ? 'blocked' : (av[b] || 'unset');
          const reason = av[`${b}_reason`];
          const ic = ICON[v] ? `<svg class="icon ic"><use href="#${ICON[v]}"/></svg>` : '';
          const tip = blocked ? ' title="Descanso fijo (parametrización)"' : (reason ? ` title="${escapeAttr(reason)}"` : '');
          return `<button class="av-slot ${v}" data-id="${d.id}" data-day="${day.key}" data-shift="${b}" data-state="${rawState}"${blocked ? ' data-blocked="1"' : ''}${tip}>${ic}<span class="lbl">${b.toUpperCase()}</span></button>`;
        };
        html += `<td class="daycell${WKND.includes(i) ? ' wknd' : ''}"><span class="slots">${cell('am')}${cell('pm')}</span></td>`;
      });
      html += '</tr>';
    });
    body.innerHTML = html;
    body.querySelectorAll('.av-slot').forEach(btn => btn.addEventListener('click', () => rotateAvailPill(btn)));
  }

  function escapeAttr(s) {
    return String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function miniBadge(req) {
    if (!req) return '';
    const dot = { pending: '🟦', approved: '✅', rejected: '✖' }[req.state] || '';
    return ` ${dot}`;
  }

  async function rotateAvailPill(btn) {
    if (btn.dataset.blocked === '1') {
      toast('Bloqueado por parametrización. Se edita en las reglas del conductor.');
      return;
    }
    // 'unset' entra al ciclo para que el admin pueda deshacer una marcación suya
    // y devolver la jornada a "sin marcar" (la consolidada es editable).
    const order = ['unset', 'available', 'prefer_rest', 'unavailable'];
    const cur = order.indexOf(btn.dataset.state);
    const next = order[(cur < 0 ? 0 : cur + 1) % order.length];
    const id = btn.dataset.id;
    const day = btn.dataset.day;
    const shift = btn.dataset.shift;
    state.availability[id] = state.availability[id] || {};
    state.availability[id][day] = state.availability[id][day] || { am: 'unset', pm: 'unset' };

    const existingReq = state.availability[id][day][`${shift}_request`];
    if (existingReq && (existingReq.state === 'approved' || existingReq.state === 'rejected')) {
      const verb = existingReq.state === 'approved' ? 'aprobada' : 'rechazada';
      if (!confirm(`Esta jornada ya tiene una solicitud ${verb}. Cambiarla la reabrirá como pendiente y se perderá la decisión y la nota del admin. ¿Continuar?`)) return;
    }

    let reason = state.availability[id][day][`${shift}_reason`] || null;
    if (next === 'unavailable') {
      reason = prompt('Razón de "No disponible" (admin):', reason || '');
      if (!reason || !reason.trim()) return;
    } else {
      reason = null;
    }
    state.availability[id][day][shift] = next;
    state.availability[id][day][`${shift}_reason`] = reason;

    try {
      await Api.upsertAvailabilityRow({
        profileId: id, weekStart: state.currentWeek, day,
        am: state.availability[id][day].am,
        pm: state.availability[id][day].pm,
        am_reason: state.availability[id][day].am_reason,
        pm_reason: state.availability[id][day].pm_reason,
        shift_pref: state.availability[id][day].shift_pref || 'any',
      });
      await refreshAvailabilityMatrix();
      refreshPendingBadge();
    } catch (e) {
      alert('Error al guardar disponibilidad: ' + e.message);
      await refreshAvailabilityMatrix();
    }
  }

