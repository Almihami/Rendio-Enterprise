// horario.js — Horario: schedule admin, tablero v4 drag&drop, vista móvil, publicar, editor de celda.
// Extraído de app.js (split mecánico 2026-07-10, sin cambios de lógica).
// Comparte scope global con los demás módulos; el orden de carga está en index.html.
  // ====================================================================
  // Admin: schedule
  // ====================================================================

  // Calcula quién queda FUERA del pool del board: no llenó disponibilidad (corte
  // pasado) o está suspendido esta semana. Se guarda en state para que renderPool
  // lo lea síncrono. Fail-safe: si una consulta falla, no excluye a nadie.
  async function refreshExclusions() {
    state._excludedIds = new Set();
    state._suspendedIds = new Set();
    try {
      if (weekAvailClosed(state.currentWeek)) {
        const submitted = await Api.listSubmittedDriverIds(state.currentWeek);
        state.drivers.forEach(d => { if (!submitted.has(d.id)) state._excludedIds.add(d.id); });
      }
    } catch (e) { state._excludedIds = new Set(); }
    try {
      const susp = await Api.getWeekSuspensions(state.currentWeek);
      if (susp && susp.size) state.drivers.forEach(d => { if (susp.has(d.id)) state._suspendedIds.add(d.id); });
    } catch (e) { /* fail-safe */ }
  }

  async function refreshScheduleData() {
    $('#week-start-input').value = state.currentWeek;
    state.availability = await Api.getWeeklyAvailability(state.currentWeek, state.drivers);
    const sch = await Api.getSchedule(state.currentWeek);
    state.schedule = sch ? sch.data : null;
    $('#published-pill').classList.toggle('hidden', !sch?.published);
    await refreshExclusions();
    renderSchedule();
    refreshPendingBadge();
    // Aviso de cambios de turno aceptados entre conductores (post-publicación).
    try {
      const swaps = sch?.published ? await Api.listAcceptedSwaps(state.currentWeek) : [];
      const box = $('#schedule-warnings');
      if (swaps.length && box) {
        const names = (sch.data && sch.data._names) || {};
        const lbl = (d, s) => `${Scheduler.DAY_LABELS_ES[Scheduler.DAYS[d]]} ${s.toUpperCase()}`;
        box.innerHTML = `<p class="text-indigo-700 font-semibold">🔄 ${swaps.length} cambio(s) de turno aceptado(s) entre conductores:</p>
          <ul class="list-disc pl-5 mt-1">${swaps.map(s =>
            `<li>${escapeHtml(names[s.requester_id] || '—')} (${lbl(s.from_day, s.from_shift)}) ⇄ ${escapeHtml(names[s.target_id] || '—')} (${lbl(s.to_day, s.to_shift)})</li>`).join('')}</ul>
          <p class="text-xs text-slate-500 mt-1">Se reflejan en la vista de los conductores. Si regeneras y publicas, se reinician.</p>`;
        box.classList.remove('hidden');
      }
    } catch (e) { /* sin aviso si falla */ }
  }

  function navigateWeek(deltaDays) {
    setCurrentWeekManual(Scheduler.addDays(state.currentWeek, deltaDays));
    refreshScheduleData();
  }

  function nameOf(id) {
    const w = state.drivers.find(d => d.id === id) || state.admins.find(a => a.id === id);
    return w ? w.name : '—';
  }

  const COORD_KINDS = ['coord_am', 'coord_pm'];
  const isCoordKind = (k) => COORD_KINDS.includes(k);
  // --- Reapertura temporal de disponibilidad (admin reabre una semana 2h) ---
  // Devuelve {active, until} si esa semana está reabierta y vigente.
  function reopenInfo(weekStartISO) {
    const s = state.settings || {};
    if (s.reopen_week_start === weekStartISO && s.reopen_until) {
      const until = new Date(s.reopen_until).getTime();
      if (Date.now() < until) return { active: true, until };
    }
    return { active: false, until: 0 };
  }
  // Cerrada = pasó el corte del sábado Y NO hay reapertura vigente.
  function weekAvailClosed(weekStartISO) {
    if (!Scheduler.availabilityClosed(weekStartISO)) return false;
    return !reopenInfo(weekStartISO).active;
  }
  const hhmmCO = ts => new Date(ts).toLocaleTimeString('es-CO', {
    timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: true,
  });

  const coordinatorAdmins = () => state.admins.filter(a => a.is_coordinator);
  // Daniel: conductor que también coordina (≥1 jornada/semana; ese día no conduce).
  const FLEX_COORD_EMAIL = 'daniel.alvarez@rendio.co'; // Daniel Alvarez Torres
  const flexCoordinator = () => state.drivers.find(d => (d.email || '').toLowerCase() === FLEX_COORD_EMAIL) || null;
  const coordPeople = () => {
    const fc = flexCoordinator();
    return fc ? [...coordinatorAdmins(), fc] : coordinatorAdmins();
  };

  // ====================================================================
  // Admin: Horario — Tablero v4 (board drag & drop)
  // El board reemplaza la tabla. Misma lógica/datos (state.schedule); solo
  // cambia la presentación. Generar autollena; arrastrar ajusta a mano. La
  // persistencia sigue siendo manual (Guardar/Publicar).
  // ====================================================================

  let boardDrag = null;        // { id, src }  src = "day-kind-index" | "pool"
  let boardJustPlaced = null;  // "day-kind-index": anima el último drop
  let boardBound = false;      // bind de listeners una sola vez
  let boardBadgeT = null;

  // Carriles del board derivados de settings + 2 de coordinación.
  function boardLanes() {
    const s = state.settings || { morning_slots: 2, afternoon_slots: 2 };
    const lanes = [];
    for (let i = 0; i < (s.morning_slots || 0); i++) lanes.push({ kind: 'morning', index: i, group: 'am' });
    for (let i = 0; i < (s.afternoon_slots || 0); i++) lanes.push({ kind: 'afternoon', index: i, group: 'pm' });
    // Filas de líder SOLO para el vistazo del admin: reflejan a UNO de los
    // conductores de la jornada (coord_am ⊆ morning, coord_pm ⊆ afternoon). NO
    // son cupo aparte → dayCoverage las excluye (la cobertura sigue en 4/día).
    lanes.push({ kind: 'coord_am', index: 0, group: 'co' });
    lanes.push({ kind: 'coord_pm', index: 0, group: 'co' });
    return lanes;
  }
  const BOARD_GROUP_LABEL = { am: 'Mañana', pm: 'Tarde', co: 'Líder' };
  const laneShift = (kind) => (kind === 'morning' || kind === 'coord_am') ? 'am' : 'pm';
  const laneLabel = (lane) => ({ morning: 'Mañana', afternoon: 'Tarde', coord_am: 'Líder AM', coord_pm: 'Líder PM' }[lane.kind] || lane.kind);
  const laneShortLabel = (lane) => lane.group === 'am' ? 'AM' : lane.group === 'pm' ? 'PM' : (lane.kind === 'coord_am' ? 'Líder AM' : 'Líder PM');
  const hardLabel = (k) => ({ unavailable: 'no disp.', rule: 'descanso fijo', double: 'doble sin autorizar', pmam: 'tarde→madrugada', triple: 'más de 24 h', rest: 'descanso tras doble' }[k] || 'conflicto');

  const isExcluded = (id) => !!(state._excludedIds && state._excludedIds.has(id));
  const isSuspendedId = (id) => !!(state._suspendedIds && state._suspendedIds.has(id));

  function initialsOf(name) {
    const p = String(name || '—').trim().split(/\s+/);
    return ((p[0] || '')[0] || '') + ((p[1] || '')[0] || '');
  }
  function firstTwo(name) {
    const p = String(name || '—').trim().split(/\s+/);
    return p[0] + (p[1] ? ' ' + p[1][0] + '.' : '');
  }
  function colorOfId(id) {
    const palette = ['#3B82F6', '#0EA5A0', '#8B5CF6', '#2563A8', '#16936A', '#7C5CD6', '#D98A12', '#0EA5E9', '#DB4B3F', '#F26522'];
    let h = 0; const s = String(id);
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return palette[h % palette.length];
  }

  // Carga semanal (manejo + coordinación) de un id sobre state.schedule.
  function boardLoadOf(id) {
    if (!state.schedule) return 0;
    let n = 0;
    Scheduler.DAYS.forEach(day => {
      const d = state.schedule[day]; if (!d) return;
      // Liderar no suma carga aparte: el líder ya está contado en su jornada.
      ['morning', 'afternoon'].forEach(k => { if ((d[k] || []).includes(id)) n++; });
    });
    return n;
  }

  // Conflicto DURO al tener `id` en day/kind: no disponible / descanso fijo / doble turno.
  function dayConflict(day, id, kind) {
    if (!id) return null;
    const shift = laneShift(kind);
    try { if (Scheduler.getState(state.availability, id, day, shift) === 'unavailable') return 'unavailable'; } catch (e) { /* */ }
    const who = state.drivers.find(d => d.id === id) || state.admins.find(a => a.id === id);
    try { if (who && Scheduler.ruleBlocked(who, day, shift)) return 'rule'; } catch (e) { /* */ }
    // Doble turno (27-sep-2026): una doble AUTORIZADA no es conflicto. Sí lo son
    // la no autorizada (mañana+tarde o tarde→madrugada), más de 24 h seguidas y
    // trabajar en el descanso obligatorio que va después de una doble.
    if (!state.schedule || isCoordKind(kind)) return null;
    const code = Scheduler.doubleIssues(state.schedule, id, Scheduler.restSlotsFor(state.settings)).get(Scheduler.slotOf(day, shift));
    return code || null;
  }
  // Conflicto SUAVE: pidió descanso esa jornada (ámbar, no bloquea).
  function daySoft(day, id, kind) {
    if (!id || isCoordKind(kind)) return false;
    try { return Scheduler.getState(state.availability, id, day, laneShift(kind)) === 'prefer_rest'; } catch (e) { return false; }
  }
  function conflictMsg(key, id, day) {
    const nm = (nameOf(id) || '').split(' ')[0];
    const dl = (Scheduler.DAY_LABELS_ES[day] || day).toLowerCase();
    const why = { unavailable: 'no está disponible', rule: 'tiene descanso fijo', double: 'quedaría con mañana y tarde sin una doble autorizada',
      pmam: 'quedaría de tarde a madrugada sin una doble autorizada', triple: 'quedaría con más de 24 h seguidas',
      rest: 'estaría en su descanso después de una doble' }[key] || 'tiene un conflicto';
    return `${nm} ${why} el ${dl}. Queda marcado en rojo.`;
  }

  function dayCoverage(dayKey) {
    const d = state.schedule?.[dayKey];
    let filled = 0, total = 0;
    boardLanes().forEach(l => {
      if (isCoordKind(l.kind)) return; // el líder no es cupo aparte, ya conduce su jornada
      total++;
      if (d?.[l.kind]?.[l.index]) filled++;
    });
    return { filled, total };
  }

  // ---- Liderazgo: el líder es UNO de los conductores de la jornada ----
  // coord_am ⊆ morning, coord_pm ⊆ afternoon (un id por jornada). Estas ayudas
  // mantienen esa invariante y permiten marcar/quitar el líder desde la tarjeta.
  const coordKeyOf = (kind) => kind === 'morning' ? 'coord_am' : kind === 'afternoon' ? 'coord_pm' : null;
  function isLeaderCard(day, kind, id) {
    const ck = coordKeyOf(kind); if (!ck) return false;
    return (state.schedule?.[day]?.[ck] || []).includes(id);
  }
  // Quita del líder a quien ya no esté en su jornada (evita el "líder fantasma").
  function cleanLeaders(day) {
    const s = state.schedule?.[day]; if (!s) return;
    const morn = new Set((s.morning || []).filter(Boolean));
    const aft = new Set((s.afternoon || []).filter(Boolean));
    s.coord_am = (s.coord_am || []).filter(id => morn.has(id));
    s.coord_pm = (s.coord_pm || []).filter(id => aft.has(id));
  }
  function cleanAllLeaders() { if (state.schedule) Scheduler.DAYS.forEach(cleanLeaders); }
  // Marca/desmarca a un conductor de la jornada como líder (toggle). Solo quien
  // esté marcado como "Líder de turno" (can_coordinate) puede liderar.
  function boardSetLeader(day, kind, id) {
    const ck = coordKeyOf(kind); if (!ck) return;
    ensureScheduleShape();
    const drv = state.drivers.find(d => d.id === id);
    if (!drv || !drv.can_coordinate) { flashBoard('Solo un conductor marcado como "Líder de turno" puede liderar la jornada.'); return; }
    const cur = (state.schedule[day][ck] || [])[0] || null;
    state.schedule[day][ck] = (cur === id) ? [] : [id]; // un líder por jornada
    renderSchedule();
  }

  // ---- Render principal (reemplaza la tabla anterior) ----
  function renderSchedule() {
    cleanAllLeaders();
    if (state.schedule) Scheduler.cleanDoubles(state.schedule);
    renderBoardChrome();
    renderKPIs();
    renderPool();
    renderBoardGrid();
    renderWorkerSummary();
    bindBoard();
    // Vista móvil de solo lectura (responsive). Aislada: si fallara, no rompe el Tablero.
    try { renderScheduleMobile(); } catch (e) { console.error('schedule mobile render', e); }
  }

  // ====================================================================
  // Horario — vista MÓVIL de solo lectura (diseño UX). Misma data que el
  // Tablero (state.schedule); en computador se usa el Tablero drag&drop.
  // ====================================================================
  const smState = { sel: 0, mode: 'dia', open: new Set(), weekKey: null };
  const SM_DOW = ['LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB', 'DOM'];
  const SM_DOWLONG = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
  function smFname(id) { const p = (nameOf(id) || '').trim().split(/\s+/); return p[0] + (p[1] ? ' ' + p[1][0] + '.' : ''); }
  function smTodayIndex() {
    try { const monday = new Date(state.currentWeek + 'T00:00:00'); const n = new Date(); const t = new Date(n.getFullYear(), n.getMonth(), n.getDate()); const diff = Math.round((t - monday) / 86400000); return (diff >= 0 && diff <= 6) ? diff : -1; } catch (e) { return -1; }
  }
  function smBands() {
    const s = state.settings || {};
    return [
      { k: 'morning', label: 'Mañana', short: 'AM', icon: 'i-sunrise', slots: Math.max(0, s.morning_slots || 0) },
      { k: 'afternoon', label: 'Tarde', short: 'PM', icon: 'i-sunset', slots: Math.max(0, s.afternoon_slots || 0) },
    ];
  }
  function smCoordMembers(dayKey) {
    const d = (state.schedule && state.schedule[dayKey]) || {};
    return [
      { id: (d.coord_am || [])[0] || null, kind: 'coord_am', label: 'Líder AM' },
      { id: (d.coord_pm || [])[0] || null, kind: 'coord_pm', label: 'Líder PM' },
    ];
  }
  const smCov = (di) => dayCoverage(Scheduler.DAYS[di]);
  const smCovClass = (f, t) => f >= t ? '' : (t - f >= 2 ? 'alert' : 'warn');
  function smDayConfCount(di) {
    const dayKey = Scheduler.DAYS[di]; const d = (state.schedule && state.schedule[dayKey]) || {}; let n = 0;
    smBands().forEach(b => (d[b.k] || []).forEach(id => { if (id && dayConflict(dayKey, id, b.k)) n++; }));
    return n;
  }
  function smTotals() { let f = 0, t = 0, conf = 0; for (let i = 0; i < 7; i++) { const c = smCov(i); f += c.filled; t += c.total; conf += smDayConfCount(i); } return { f, t, huecos: t - f, conf }; }

  function smArow(dayKey, id, kind, bandLabel) {
    if (!id) return `<div class="empty"><span class="ei"><svg class="icon" style="width:14px;height:14px"><use href="#i-plus"/></svg></span><div><b>Sin cubrir</b><span>${escapeHtml(bandLabel)} · cupo libre</span></div></div>`;
    const conf = dayConflict(dayKey, id, kind); const soft = daySoft(dayKey, id, kind); const isLeader = isLeaderCard(dayKey, kind, id);
    const dbl = !conf && state.schedule && Scheduler.doubleAt(state.schedule, id, dayKey, laneShift(kind));
    const tag = conf ? `<span class="tag conf"><svg class="icon" style="width:11px;height:11px"><use href="#i-alert"/></svg>Conflicto</span>`
      : dbl ? `<span class="tag" style="background:var(--amber-soft);color:var(--amber)">⇆ Doble</span>`
      : isLeader ? `<span class="tag coord">★ Líder de turno</span>`
        : (soft ? `<span class="tag" style="background:var(--amber-soft);color:var(--amber)">Pidió descanso</span>` : '');
    const sub = conf ? (conf === 'rule' ? 'Descanso fijo este día' : conf === 'unavailable' ? 'No disponible este día' : hardLabel(conf)) : (isLeader ? bandLabel + ' · Líder' : dbl && dbl.nota ? bandLabel + ' · ' + dbl.nota : bandLabel);
    return `<div class="arow ${conf ? 'conf' : ''}"><span class="av" style="background:${colorOfId(id)}">${escapeHtml(initialsOf(nameOf(id)))}</span><div class="nm"><b>${escapeHtml(nameOf(id))}</b><span>${escapeHtml(sub)}</span></div>${tag}</div>`;
  }
  function smBandBlock(di, b) {
    const dayKey = Scheduler.DAYS[di]; const d = (state.schedule && state.schedule[dayKey]) || {};
    const members = []; for (let i = 0; i < b.slots; i++) members.push((d[b.k] || [])[i] || null);
    const filled = members.filter(Boolean).length; const cl = smCovClass(filled, b.slots || 0);
    return `<div class="band"><div class="band-h"><span class="bi"><svg class="icon"><use href="#${b.icon}"/></svg></span><div><div class="bt">${b.label}</div><div class="bsub">Turno de ${b.short}</div></div><span class="cvpill ${cl}">${filled}/${b.slots}</span></div><div class="band-b">${members.map(id => smArow(dayKey, id, b.k, b.label)).join('')}</div></div>`;
  }
  function smCoordBlock(di) {
    const dayKey = Scheduler.DAYS[di]; const mem = smCoordMembers(dayKey);
    const filled = mem.filter(m => m.id).length; const cl = smCovClass(filled, mem.length);
    return `<div class="band"><div class="band-h"><span class="bi"><svg class="icon"><use href="#i-star"/></svg></span><div><div class="bt">Coordinación</div><div class="bsub">Líder del día</div></div><span class="cvpill ${cl}">${filled}/${mem.length}</span></div><div class="band-b">${mem.map(m => smArow(dayKey, m.id, m.kind, m.label)).join('')}</div></div>`;
  }
  function smRenderKpis() {
    const el = $('#sm-kpis'); if (!el) return;
    const T = smTotals(); const pct = T.t ? Math.round(T.f / T.t * 100) : 0; const cc = pct >= 90 ? 'ok' : pct >= 75 ? 'warn' : 'alert';
    el.innerHTML = `<div class="kpi ${cc}"><em>Cobertura</em><b>${pct}%</b><span>${T.f}/${T.t} cupos</span></div>
      <div class="kpi ${T.huecos ? 'warn' : 'ok'}"><em>Huecos</em><b>${T.huecos}</b><span>${T.huecos ? 'por cubrir' : 'completo'}</span></div>
      <div class="kpi ${T.conf ? 'alert' : 'ok'}"><em>Conflictos</em><b>${T.conf}</b><span>${T.conf ? 'revisar' : 'sin alertas'}</span></div>`;
  }
  function smRenderStrip() {
    const el = $('#sm-strip'); if (!el) return; const wk = Scheduler.weekDates(state.currentWeek); const ti = smTodayIndex();
    el.innerHTML = wk.map((dd, di) => { const c = smCov(di); const pct = c.total ? Math.round(c.filled / c.total * 100) : 0;
      return `<div class="dcell ${smCovClass(c.filled, c.total)} ${di === ti ? 'today' : ''} ${di === smState.sel ? 'sel' : ''}" data-sm-day="${di}"><div class="dow">${SM_DOW[di]}</div><div class="dnum">${String(dd.dayNum).padStart(2, '0')}</div><div class="cv"><i style="width:${pct}%"></i></div></div>`;
    }).join('');
  }
  function smRenderDia() {
    const el = $('#sm-scroll'); if (!el) return; const di = smState.sel; const ti = smTodayIndex(); const c = smCov(di); const wk = Scheduler.weekDates(state.currentWeek);
    el.innerHTML = `<div class="daytitle"><b>${SM_DOWLONG[di]}</b><span>${String(wk[di].dayNum).padStart(2, '0')}</span>${di === ti ? '<span class="tnow">Hoy</span>' : ''}</div>
      ${smBands().map(b => smBandBlock(di, b)).join('')}
      <div class="footnote">El ★ marca al líder de cada jornada.<br>Asignación de la semana · <b>${c.filled}/${c.total} cupos</b> cubiertos este día.<br>Para editar el horario, abre el Tablero desde un computador.</div>`;
  }
  function smRenderSemana() {
    const el = $('#sm-scroll'); if (!el) return; const ti = smTodayIndex(); const wk = Scheduler.weekDates(state.currentWeek);
    el.innerHTML = wk.map((dd, di) => {
      const c = smCov(di); const cl = smCovClass(c.filled, c.total); const dayKey = Scheduler.DAYS[di]; const d = (state.schedule && state.schedule[dayKey]) || {};
      const bandRows = smBands().map(b => {
        let chips = ''; for (let i = 0; i < b.slots; i++) { const id = (d[b.k] || [])[i] || null;
          const lead = !!(id && isLeaderCard(dayKey, b.k, id));
          chips += id ? `<span class="nchip ${lead ? 'coord' : ''} ${dayConflict(dayKey, id, b.k) ? 'conf' : ''}"><span class="dd" style="background:${colorOfId(id)}">${escapeHtml(initialsOf(nameOf(id)))}</span>${lead ? '★ ' : ''}${escapeHtml(smFname(id))}</span>` : `<span class="nchip gap">Hueco</span>`; }
        return `<div class="brow"><span class="blab">${b.short}</span><div class="chips">${chips}</div></div>`;
      }).join('');
      return `<div class="wkcard ${di === ti ? 'today' : ''} ${smState.open.has(di) ? 'open' : ''}" data-sm-wk="${di}"><div class="wkc-h" data-sm-toggle="${di}"><div class="wd"><b>${String(dd.dayNum).padStart(2, '0')}</b><span>${SM_DOW[di]}</span></div>${di === ti ? '<span class="tag coord" style="margin-left:8px">Hoy</span>' : ''}<span class="cvpill ${cl}">${c.filled}/${c.total}</span><span class="chev"><svg class="icon"><use href="#i-chev"/></svg></span></div><div class="wkc-b">${bandRows}</div></div>`;
    }).join('') + `<div class="footnote">Toca un día para ver el detalle. Para editar, usa el Tablero en computador.</div>`;
  }
  function smRenderBody() { smState.mode === 'dia' ? smRenderDia() : smRenderSemana(); }

  function renderScheduleMobile() {
    const box = $('#schedule-mobile'); if (!box) return;
    if (smState.weekKey !== state.currentWeek) { smState.weekKey = state.currentWeek; const ti = smTodayIndex(); smState.sel = ti >= 0 ? ti : 0; smState.open = new Set([smState.sel]); }
    if (smState.sel > 6 || smState.sel < 0) smState.sel = 0;
    let mon = ''; try { mon = new Date(state.currentWeek + 'T00:00:00').toLocaleDateString('es-CO', { month: 'short', timeZone: 'America/Bogota' }).replace('.', ''); } catch (e) { /* */ }
    let yr = ''; try { yr = String(new Date(state.currentWeek + 'T00:00:00').getFullYear()); } catch (e) { /* */ }
    const wk = Scheduler.weekDates(state.currentWeek);
    const range = `${String(wk[0].dayNum).padStart(2, '0')} – ${String(wk[6].dayNum).padStart(2, '0')} ${mon}${yr ? ' · ' + yr : ''}`.trim();
    const cut = weekAvailClosed(state.currentWeek) ? 'Corte cerrado' : 'Disponibilidad abierta';
    box.innerHTML = `
      <div class="sm-wknav">
        <button id="sm-prev" aria-label="Semana anterior"><svg class="icon"><use href="#i-l"/></svg></button>
        <div class="wk"><b>${range}</b><span><i></i>${cut}</span></div>
        <button id="sm-next" aria-label="Semana siguiente"><svg class="icon"><use href="#i-r"/></svg></button>
      </div>
      <div class="kpis" id="sm-kpis"></div>
      <div class="strip" id="sm-strip"></div>
      <div class="modebar">
        <div class="seg" id="sm-modeseg"><button data-m="dia" class="${smState.mode === 'dia' ? 'on' : ''}">Día</button><button data-m="semana" class="${smState.mode === 'semana' ? 'on' : ''}">Semana</button></div>
        <div class="leg"><span><i></i>Asignado</span><span><i class="h"></i>Hueco</span><span><i class="c"></i>Conflicto</span></div>
      </div>
      <div class="scroll" id="sm-scroll"></div>`;
    smRenderKpis(); smRenderStrip(); smRenderBody();
    bindScheduleMobile();
  }
  function bindScheduleMobile() {
    const box = $('#schedule-mobile'); if (!box || box._smBound) return; box._smBound = true;
    box.addEventListener('click', (e) => {
      const dc = e.target.closest('[data-sm-day]'); if (dc) { smState.sel = +dc.dataset.smDay; smState.mode = 'dia'; renderScheduleMobile(); return; }
      const ms = e.target.closest('#sm-modeseg button'); if (ms) { smState.mode = ms.dataset.m; $('#sm-modeseg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b === ms)); smRenderBody(); return; }
      const tg = e.target.closest('[data-sm-toggle]'); if (tg) { const di = +tg.dataset.smToggle; smState.open.has(di) ? smState.open.delete(di) : smState.open.add(di); smRenderSemana(); return; }
      if (e.target.closest('#sm-prev')) { navigateWeek(-7); return; }
      if (e.target.closest('#sm-next')) { navigateWeek(7); return; }
    });
  }

  function renderBoardChrome() {
    let saved = null;
    try { saved = localStorage.getItem('rendio-board-theme'); } catch (e) { /* */ }
    applyBoardTheme(saved === 'dark' ? 'dark' : 'light');

    const week = Scheduler.weekDates(state.currentWeek);
    const lbl = $('#board-week-label');
    if (lbl) {
      let mon = '';
      try { mon = new Date(state.currentWeek + 'T00:00:00').toLocaleDateString('es-CO', { month: 'short', timeZone: 'America/Bogota' }).replace('.', ''); } catch (e) { /* */ }
      lbl.textContent = `${String(week[0].dayNum).padStart(2, '0')} – ${String(week[6].dayNum).padStart(2, '0')} ${mon}`.trim();
    }
    const chip = $('#board-cutoff-chip');
    if (chip) {
      const info = reopenInfo(state.currentWeek);
      if (info.active) { chip.textContent = `Reabierta hasta ${hhmmCO(info.until)}`; chip.className = 'chip ok'; }
      else if (weekAvailClosed(state.currentWeek)) { chip.textContent = 'Corte cerrado'; chip.className = 'chip'; }
      else { chip.textContent = 'Disponibilidad abierta'; chip.className = 'chip ok'; }
    }
  }

  function renderKPIs() {
    const el = $('#kpis'); if (!el) return;
    const week = Scheduler.weekDates(state.currentWeek);
    let filled = 0, total = 0, coordDays = 0, conf = 0;
    week.forEach(d => {
      const cov = dayCoverage(d.key);
      filled += cov.filled; total += cov.total;
      const day = state.schedule?.[d.key];
      if (day?.coord_am?.[0] && day?.coord_pm?.[0]) coordDays++;
      boardLanes().forEach(l => {
        if (isCoordKind(l.kind)) return; // el líder ya se contó en su jornada
        const id = day?.[l.kind]?.[l.index];
        if (id && dayConflict(d.key, id, l.kind)) conf++;
      });
    });
    const huecos = total - filled;
    const pct = total ? Math.round(filled / total * 100) : 0;
    const loads = state.drivers.map(d => ({ id: d.id, l: boardLoadOf(d.id) }));
    const maxL = loads.reduce((m, x) => Math.max(m, x.l), 0);
    const top = loads.filter(x => x.l === maxL && maxL > 0).map(x => (nameOf(x.id) || '').split(' ')[0]);
    const low = loads.filter(x => !isExcluded(x.id) && !isSuspendedId(x.id) && x.l <= 2).map(x => (nameOf(x.id) || '').split(' ')[0]);
    const rc = pct >= 90 ? 'var(--green)' : pct >= 75 ? 'var(--amber)' : 'var(--red)';
    const covClass = pct >= 90 ? 'ok' : pct >= 75 ? 'warn' : 'alert';
    const dots = (n, cls) => { const k = Math.min(n, 7); return k ? Array.from({ length: k }).map(() => `<i class="${cls}"></i>`).join('') : '<i></i>'; };
    el.innerHTML = `
      <div class="k ${covClass}">
        <div class="ring" style="--p:${pct};--rc:${rc}"><b>${pct}</b></div>
        <div class="tx"><em>Cobertura</em><b>${filled}/${total}</b><span>cupos cubiertos</span></div>
      </div>
      <div class="k ${huecos ? 'warn' : 'ok'}"><div class="tx"><em>Huecos</em><b>${huecos}</b><span>${huecos ? 'por cubrir' : 'todo cubierto'}</span><div class="dotrow">${dots(huecos, 'w')}</div></div></div>
      <div class="k ${conf ? 'alert' : 'ok'}"><div class="tx"><em>Conflictos</em><b>${conf}</b><span>${conf ? 'revisa el rojo' : 'sin conflictos'}</span><div class="dotrow">${dots(conf, 'e')}</div></div></div>
      <div class="k ${coordDays < 7 ? 'warn' : 'ok'}"><div class="tx"><em>Liderazgo</em><b>${coordDays}/7</b><span>días con líder</span></div></div>
      <div class="k ${maxL >= 5 ? 'warn' : ''}"><div class="tx"><em>Balance</em><b>${top[0] || '—'}${maxL ? ' ' + maxL + '/5' : ''}</b><span>${low.length ? 'Carga baja: ' + low.slice(0, 2).join(', ') : 'reparto equilibrado'}</span></div></div>`;
  }

  function renderPool() {
    const list = $('#plist'); if (!list) return;
    const filter = (state._poolFilter || '').toLowerCase();
    list.innerHTML = state.drivers.map(d => {
      const out = isExcluded(d.id) || isSuspendedId(d.id);
      const l = boardLoadOf(d.id);
      const pct = Math.min(l / 5 * 100, 100);
      const cls = out ? 'out' : l >= 5 ? 'hi' : l <= 2 ? 'lo' : '';
      const mc = l >= 5 ? 'hi' : l <= 2 ? 'lo' : '';
      const sub = out ? (isSuspendedId(d.id) ? 'Suspendido' : 'Fuera del corte')
        : (d.can_coordinate ? 'Puede liderar' : 'Disponible');
      const hidden = filter && !(d.name || '').toLowerCase().includes(filter) ? ' hidden' : '';
      return `<div class="pcard ${cls}"${out ? '' : ' draggable="true"'} data-driver="${d.id}" data-src="pool"${hidden}>
        <span class="av" style="background:${colorOfId(d.id)}">${escapeHtml(initialsOf(d.name))}</span>
        <div class="nm"><b>${escapeHtml(d.name)}</b><span>${escapeHtml(sub)}</span></div>
        <div class="load"><b>${out ? '—' : l + '/5'}</b><div class="meter ${mc}"><i style="width:${out ? 0 : pct}%"></i></div></div>
      </div>`;
    }).join('');
    const cnt = $('#poolcount');
    if (cnt) cnt.textContent = String(state.drivers.filter(d => !isExcluded(d.id) && !isSuspendedId(d.id)).length);
  }

  function renderBoardGrid() {
    const weekEl = $('#week'); if (!weekEl) return;
    const week = Scheduler.weekDates(state.currentWeek);
    const lanes = boardLanes();
    const sched = state.schedule;
    let todayISO = '';
    try { todayISO = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }); } catch (e) { /* */ }

    weekEl.style.gridTemplateRows = `auto ${lanes.map(() => 'minmax(46px,auto)').join(' ')}`;

    let monAbbr = '';
    try { monAbbr = new Date(state.currentWeek + 'T00:00:00').toLocaleDateString('es-CO', { month: 'short', timeZone: 'America/Bogota' }).replace('.', '').toUpperCase(); } catch (e) { /* */ }
    let h = `<div class="corner">${escapeHtml(monAbbr)}</div>`;

    week.forEach(d => {
      const cov = dayCoverage(d.key);
      const pct = cov.total ? Math.round(cov.filled / cov.total * 100) : 0;
      const cls = cov.filled < cov.total ? (cov.total - cov.filled >= 2 ? 'alert' : 'warn') : '';
      const today = d.date === todayISO ? 'today' : '';
      h += `<div class="dhead ${cls} ${today}">
          <div class="drow"><span class="dnum">${String(d.dayNum).padStart(2, '0')}</span><span class="dow">${escapeHtml(String(d.label).slice(0, 3))}</span></div>
          <div class="cvbar"><i style="width:${pct}%"></i></div>
          <div class="cvtx">${cov.filled}/${cov.total} cupos</div>
        </div>`;
    });

    lanes.forEach(lane => {
      h += `<div class="bl">${escapeHtml(laneLabel(lane))}</div>`;
      week.forEach((d, di) => {
        const wknd = di >= 5 ? 'wknd' : '';
        const id = sched?.[d.key]?.[lane.kind]?.[lane.index] || null;
        const coordLane = isCoordKind(lane.kind);
        let inner;
        if (id) {
          const hard = dayConflict(d.key, id, lane.kind);
          const soft = !hard && daySoft(d.key, id, lane.kind);
          const nm = nameOf(id);
          const justCls = boardJustPlaced === `${d.key}-${lane.kind}-${lane.index}` ? 'just' : '';
          if (coordLane) {
            // Fila de líder (vistazo admin): refleja al líder; su ★/cambio vive en la
            // tarjeta de Mañana/Tarde. La X quita el liderazgo (no saca de la jornada).
            const cardCls = ['coord', hard ? 'conf' : '', justCls].filter(Boolean).join(' ');
            inner = `<div class="asg ${cardCls}" data-day="${d.key}" data-kind="${lane.kind}" data-index="${lane.index}">
                <span class="av" style="background:${colorOfId(id)}">${escapeHtml(initialsOf(nm))}</span>
                <div class="nm"><b>${escapeHtml(firstTwo(nm))}</b><span>${escapeHtml(hard ? '⚠ ' + hardLabel(hard) : '★ Lidera')}</span></div>
                <span class="x" data-remove="${d.key}-${lane.kind}-${lane.index}" title="Quitar líder"><svg class="icon" style="width:13px;height:13px"><use href="#i-x"/></svg></span>
              </div>`;
          } else {
            const isLeader = isLeaderCard(d.key, lane.kind, id);
            const dbl = !hard && Scheduler.doubleAt(sched, id, d.key, laneShift(lane.kind));
            const cardCls = [
              isLeader ? 'coord lead-on' : '',
              hard ? 'conf' : '',
              soft ? 'soft' : '',
              dbl ? 'dbl' : '',
              justCls,
            ].filter(Boolean).join(' ');
            // El líder se marca con fondo naranja + "★ Lidera" en el subtítulo (sin
            // elemento suelto que desalinee las tarjetas). Se cambia desde las filas
            // Líder AM/PM. Mismo layout que las demás → avatares alineados.
            const subtxt = hard ? '⚠ ' + hardLabel(hard) : (isLeader ? '★ Lidera' + (dbl ? ' · doble' : '') : dbl ? '⇆ Doble' : BOARD_GROUP_LABEL[lane.group]);
            const tip = dbl ? ` title="${escapeAttr('Doble autorizada' + (dbl.nota ? ': ' + dbl.nota : ''))}"` : '';
            inner = `<div class="asg ${cardCls}" draggable="true" data-driver="${id}" data-day="${d.key}" data-kind="${lane.kind}" data-index="${lane.index}"${tip}>
                <span class="av" style="background:${colorOfId(id)}">${escapeHtml(initialsOf(nm))}</span>
                <div class="nm"><b>${escapeHtml(firstTwo(nm))}</b><span>${escapeHtml(subtxt)}</span></div>
                <span class="x" data-remove="${d.key}-${lane.kind}-${lane.index}" title="Quitar"><svg class="icon" style="width:13px;height:13px"><use href="#i-x"/></svg></span>
              </div>`;
          }
        } else {
          const lbl = coordLane ? '+ líder' : '+ asignar';
          inner = `<div class="drop" data-day="${d.key}" data-kind="${lane.kind}" data-index="${lane.index}">${lbl}<small>${escapeHtml(laneShortLabel(lane))}</small></div>`;
        }
        h += `<div class="zone ${wknd}" data-day="${d.key}" data-kind="${lane.kind}" data-index="${lane.index}"><div class="slot">${inner}</div></div>`;
      });
    });
    weekEl.innerHTML = h;
    boardJustPlaced = null;
  }

  // ---- Mutación del board (en memoria; persiste con Guardar/Publicar) ----
  function ensureScheduleShape() {
    state.schedule = state.schedule || Scheduler.emptySchedule();
    Scheduler.DAYS.forEach(d => {
      state.schedule[d] = state.schedule[d] || {};
      ['morning', 'afternoon', 'rest', 'coord_am', 'coord_pm'].forEach(k => {
        state.schedule[d][k] = state.schedule[d][k] || [];
      });
    });
  }
  function boardRemoveFrom(src) {
    if (!src || src === 'pool' || !state.schedule) return;
    const [day, kind, index] = src.split('-');
    if (state.schedule[day] && state.schedule[day][kind]) {
      state.schedule[day][kind][+index] = null;
      rebuildRestRow(day); // recalcula descanso y limpia al líder si salió de la jornada
    }
  }
  function boardPlaceInto(day, kind, index, id, src) {
    ensureScheduleShape();
    // Soltar en la fila de líder: solo un conductor de esa jornada que pueda liderar.
    if (isCoordKind(kind)) {
      const shiftKind = kind === 'coord_am' ? 'morning' : 'afternoon';
      const drv = state.drivers.find(d => d.id === id);
      if (!drv || !drv.can_coordinate) { flashBoard('Solo un conductor marcado como "Líder de turno" puede liderar.'); return; }
      if (!(state.schedule[day][shiftKind] || []).includes(id)) { flashBoard('El líder debe ser uno de los conductores de esa jornada; ponlo primero en Mañana/Tarde.'); return; }
      state.schedule[day][kind] = [id];
      boardJustPlaced = `${day}-${kind}-${index}`;
      renderSchedule();
      return;
    }
    // ¿Queda pegado a otra jornada suya? Mañana+tarde del mismo día, o tarde→
    // madrugada del día siguiente. Eso es una doble: la decide el jefe (D1).
    const [srcDay, srcKind] = (src && src !== 'pool') ? src.split('-') : [null, null];
    const tiene = (d, k) => (state.schedule[d]?.[k] || []).includes(id) && !(srcDay === d && srcKind === k);
    const di = Scheduler.DAYS.indexOf(day);
    const other = kind === 'morning' ? 'afternoon' : 'morning';
    if (tiene(day, other)) return preguntarDoble({ day, kind, index, id, src, tipo: 'dia', startDay: day });
    if (kind === 'morning' && di > 0 && tiene(Scheduler.DAYS[di - 1], 'afternoon'))
      return preguntarDoble({ day, kind, index, id, src, tipo: 'noche', startDay: Scheduler.DAYS[di - 1] });
    if (kind === 'afternoon' && di < 6 && tiene(Scheduler.DAYS[di + 1], 'morning'))
      return preguntarDoble({ day, kind, index, id, src, tipo: 'noche', startDay: day });
    colocar(state.schedule, day, kind, index, id, src, true);
    despuesDeColocar(day, kind, index, id);
  }

  // Pone a `id` en la celda, sobre el horario `sch`. mover:true lo saca de la otra
  // jornada de ese día (lo de siempre); false lo deja en las dos (doble).
  // Se vacía EN SU LUGAR (null), nunca filtrando: filtrar corría a los demás de
  // puesto, y al vaciar la celda de origen se borraba a OTRO conductor (con
  // morning=[A,B], mover a A dejaba [null] y B desaparecía sin aviso).
  function colocar(sch, day, kind, index, id, src, mover) {
    (mover ? ['morning', 'afternoon'] : [kind]).forEach(k => {
      sch[day][k] = (sch[day][k] || []).map(x => (x === id ? null : x));
    });
    if (src && src !== 'pool') {
      const [sd, sk, si] = src.split('-');
      const arr = sch[sd]?.[sk];
      if (arr && arr[+si] === id) arr[+si] = null;
    }
    while (sch[day][kind].length <= index) sch[day][kind].push(null);
    sch[day][kind][index] = id;
  }
  function despuesDeColocar(day, kind, index, id) {
    Scheduler.DAYS.forEach(d => { if (state.schedule[d]) rebuildRestRow(d); });
    boardJustPlaced = `${day}-${kind}-${index}`;
    renderSchedule();
    const c = dayConflict(day, id, kind);
    if (c) flashBoard(conflictMsg(c, id, day));
  }

  // ---- Doble turno (27-sep-2026) ----
  // «¿Mover o doblar?». Solo el jefe crea una doble y siempre con motivo (D1).
  // Si el conductor no marcó «Puedo doblar» ese día se avisa, pero se puede
  // doblar igual: la marca solo dice quién está dispuesto (D7).
  function preguntarDoble({ day, kind, index, id, src, tipo, startDay }) {
    const fn = (nameOf(id) || 'Conductor').split(' ')[0];
    const dia = (k) => (Scheduler.DAY_LABELS_ES[k] || k).toLowerCase();
    const next = Scheduler.DAYS[Scheduler.DAYS.indexOf(startDay) + 1];
    const restH = Number(state.settings && state.settings.double_rest_hours) || 24;
    const puede = state.availability?.[id]?.[startDay]?.shift_pref === 'both';
    const desc = tipo === 'dia'
      ? `${escapeHtml(fn)} ya tiene la ${kind === 'morning' ? 'tarde' : 'mañana'} del ${dia(day)}. Si lo doblas, hace mañana y tarde: 24 h seguidas.`
      : `${escapeHtml(fn)} quedaría con la tarde del ${dia(startDay)} y la madrugada del ${dia(next)}: 24 h seguidas.`;
    const body = `
      <p style="font-size:13.5px;color:var(--ink2);line-height:1.45">${desc}</p>
      ${puede ? `<p class="set-hint" style="margin-top:8px">✓ Marcó «Puedo doblar» el ${dia(startDay)}.</p>`
              : `<div class="usr-reason">⚠ ${escapeHtml(fn)} no marcó «Puedo doblar» el ${dia(startDay)}. Si lo doblas igual, queda autorizado por ti.</div>`}
      <div class="set-field" style="margin-top:14px"><label>Motivo de la doble</label>
        <input class="set-input" data-f="nota" type="text" maxlength="140" placeholder="Ej: Juan se incapacitó, cubre su tarde">
      </div>
      <p class="set-hint">Después de la doble van ${restH} h de descanso: no puede quedar en las jornadas siguientes.</p>`;
    const ov = usrModal('dbl-modal', tipo === 'dia' ? '¿Mover o doblar?' : 'Doble noche', escapeHtml(nameOf(id) || ''), body,
      `<button class="wk-btn wk-coord-off" data-usr="cancel">Cancelar</button>
       ${tipo === 'dia' ? `<button class="wk-btn wk-coord-off" data-usr="move">Mover a la ${kind === 'morning' ? 'mañana' : 'tarde'}</button>` : ''}
       <button class="wk-btn wk-coord-on" data-usr="double">${puede ? 'Doblar' : 'Doblar igual'}</button>`);
    // Si mientras el modal estaba abierto se recargó el horario (cambio de semana),
    // la celda ya no existe: no se toca nada.
    const sch0 = state.schedule;
    const vigente = () => !!(state.schedule && state.schedule === sch0 && state.schedule[day] && state.schedule[startDay]);
    ov.querySelector('[data-usr="move"]')?.addEventListener('click', () => {
      ov.remove();
      if (!vigente()) return;
      colocar(state.schedule, day, kind, index, id, src, true);
      despuesDeColocar(day, kind, index, id);
    });
    ov.querySelector('[data-usr="double"]').addEventListener('click', () => {
      if (!vigente()) { ov.remove(); return; }
      const nota = ov.querySelector('[data-f="nota"]').value.trim();
      if (!nota) { usrShowErr(ov, 'Escribe el motivo: queda en el horario.'); return; }
      // Se prueba sobre una copia: si rompe las 24 h o el descanso, no se toca nada.
      const prueba = JSON.parse(JSON.stringify(state.schedule));
      colocar(prueba, day, kind, index, id, src, false);
      const dbl = { day: startDay, id, tipo, nota, por: (state.profile && state.profile.full_name) || null, at: new Date().toISOString() };
      prueba._doubles = [...Scheduler.doublesOf(prueba).filter(x => !(x.id === id && x.day === startDay && x.tipo === tipo)), dbl];
      const iss = [...Scheduler.doubleIssues(prueba, id, Scheduler.restSlotsFor(state.settings)).entries()]
        .filter(([, c]) => c === 'triple' || c === 'rest').sort((a, b) => a[0] - b[0]);
      if (iss.length) {
        const [k, c] = iss[0];
        const donde = `${dia(Scheduler.DAYS[Math.floor(k / 2)])} ${k % 2 ? 'tarde' : 'mañana'}`;
        usrShowErr(ov, c === 'triple'
          ? `Serían más de 24 h seguidas: ${fn} también está el ${donde}. Quítalo de ahí primero.`
          : `Después de la doble van ${restH} h de descanso y ${fn} está el ${donde}. Quítalo de ahí primero.`);
        return;
      }
      ov.remove();
      state.schedule._doubles = prueba._doubles;
      colocar(state.schedule, day, kind, index, id, src, false);
      despuesDeColocar(day, kind, index, id);
      flashBoard(`Doble autorizada: ${fn}. Se le avisa al publicar.`);
    });
  }

  function flashBoard(msg) {
    const b = $('#badge'), t = $('#badgetx');
    if (!b || !t) return;
    t.textContent = msg;
    b.classList.add('show');
    clearTimeout(boardBadgeT);
    boardBadgeT = setTimeout(() => b.classList.remove('show'), 3200);
  }

  function applyBoardTheme(theme) {
    const b = $('#schedule-board'); if (!b) return;
    b.setAttribute('data-theme', theme);
    const use = b.querySelector('#board-theme-toggle .icon use');
    if (use) use.setAttribute('href', theme === 'dark' ? '#i-sun' : '#i-moon');
  }
  function toggleBoardTheme() {
    const b = $('#schedule-board'); if (!b) return;
    const next = b.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyBoardTheme(next);
    try { localStorage.setItem('rendio-board-theme', next); } catch (e) { /* */ }
  }

  // Listeners delegados en #schedule-board, una sola vez.
  function bindBoard() {
    if (boardBound) return;
    const board = $('#schedule-board'); if (!board) return;
    boardBound = true;

    board.addEventListener('dragstart', e => {
      const c = e.target.closest('[data-driver]'); if (!c) return;
      if (c.classList.contains('out')) { e.preventDefault(); return; }
      boardDrag = { id: c.dataset.driver, src: c.dataset.src || `${c.dataset.day}-${c.dataset.kind}-${c.dataset.index}` };
      c.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', boardDrag.id); } catch (_) { /* */ }
    });
    board.addEventListener('dragend', () => {
      board.querySelectorAll('.dragging').forEach(x => x.classList.remove('dragging'));
      board.querySelectorAll('.zone.over').forEach(x => x.classList.remove('over'));
      $('#poolzone')?.classList.remove('drophere');
      boardDrag = null;
    });
    board.addEventListener('dragover', e => {
      if (e.target.closest('.zone') || e.target.closest('#poolzone')) e.preventDefault();
    });
    board.addEventListener('dragenter', e => {
      const z = e.target.closest('.zone');
      if (z) { board.querySelectorAll('.zone.over').forEach(x => x.classList.remove('over')); z.classList.add('over'); $('#poolzone')?.classList.remove('drophere'); return; }
      if (e.target.closest('#poolzone')) { $('#poolzone')?.classList.add('drophere'); board.querySelectorAll('.zone.over').forEach(x => x.classList.remove('over')); }
    });
    board.addEventListener('drop', e => {
      if (!boardDrag) return;
      const z = e.target.closest('.zone'), p = e.target.closest('#poolzone');
      if (z) {
        e.preventDefault();
        boardPlaceInto(z.dataset.day, z.dataset.kind, +z.dataset.index, boardDrag.id, boardDrag.src);
      } else if (p) {
        e.preventDefault();
        if (boardDrag.src && boardDrag.src !== 'pool') { boardRemoveFrom(boardDrag.src); renderSchedule(); }
      }
    });
    // Click: X = quitar; celda = editor (también fallback táctil en móvil).
    board.addEventListener('click', e => {
      const x = e.target.closest('[data-remove]');
      if (x) { e.stopPropagation(); boardRemoveFrom(x.dataset.remove); renderSchedule(); return; }
      const lead = e.target.closest('[data-lead]');
      if (lead) { e.stopPropagation(); const a = lead.closest('.asg'); if (a) boardSetLeader(a.dataset.day, a.dataset.kind, a.dataset.driver); return; }
      const cell = e.target.closest('.asg, .drop');
      if (cell && cell.dataset.day) openCellEditor(cell);
    });

    $('#board-theme-toggle')?.addEventListener('click', toggleBoardTheme);
    $('#pool-search')?.addEventListener('input', e => { state._poolFilter = e.target.value; renderPool(); });
    $('#board-week-label')?.addEventListener('click', () => {
      const inp = $('#week-start-input'); if (!inp) return;
      if (inp.showPicker) { try { inp.showPicker(); return; } catch (_) { /* */ } }
      inp.focus();
    });
  }

  function renderWorkerSummary() {
    const box = $('#worker-summary');
    if (!state.schedule) { box.innerHTML = '<p class="text-slate-500 text-xs">Aún no se ha generado un horario.</p>'; return; }
    const counts = {};
    state.drivers.forEach(d => counts[d.id] = { m: 0, t: 0, r: 0 });
    Scheduler.DAYS.forEach(key => {
      const day = state.schedule[key];
      if (!day) return;
      (day.morning || []).forEach(id => counts[id] && counts[id].m++);
      (day.afternoon || []).forEach(id => counts[id] && counts[id].t++);
      (day.rest || []).forEach(id => counts[id] && counts[id].r++);
    });
    box.innerHTML = state.drivers.map(d => {
      const c = counts[d.id];
      const total = c.m + c.t;
      return `<div class="flex justify-between border-b border-slate-100 py-1">
        <span>${d.name}</span>
        <span class="text-slate-600 text-xs">${total} turnos · ${c.m}M / ${c.t}T · ${c.r} descansos</span>
      </div>`;
    }).join('');
  }

  async function onReopenAvailability() {
    const wk = state.currentWeek;
    const info = reopenInfo(wk);
    try {
      if (info.active) {
        if (!confirm(`La disponibilidad de esta semana está reabierta hasta las ${hhmmCO(info.until)}. ¿Cerrarla ahora?`)) return;
        await Api.setAvailabilityReopen(wk, null);
        state.settings = { ...state.settings, reopen_week_start: null, reopen_until: null };
        toast('Reapertura cerrada.');
      } else {
        if (!confirm('¿Reabrir la disponibilidad de ESTA semana por 2 horas para TODOS los conductores? Podrán entrar a corregir/llenar; al vencerse vuelve a cerrarse.')) return;
        const until = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
        await Api.setAvailabilityReopen(wk, until);
        state.settings = { ...state.settings, reopen_week_start: wk, reopen_until: until };
        toast(`Disponibilidad reabierta hasta las ${hhmmCO(until)} (2 h). Avisa a los conductores.`);
      }
    } catch (e) {
      alert('No se pudo cambiar la reapertura: ' + e.message + '\n(¿Falta aplicar la migración 0014?)');
    }
  }

  async function onGenerate() {
    // El admin decide al PUBLICAR: las solicitudes quedan PENDIENTES hasta entonces.
    // El generador respeta lo que pidió cada conductor (pending o approved). Si
    // queda un cupo sin cubrir (todos pidieron descanso/unavailable), aparece en
    // las "Advertencias" para que el admin edite manualmente o cierre solicitudes
    // desde la pestaña Solicitudes.
    try { state.settings = await Api.getSettings(); } catch (e) { /* usa cacheado */ }
    await doGenerate();
  }

  async function doGenerate() {
    state.availability = await Api.getWeeklyAvailability(state.currentWeek, state.drivers);

    // Regla del corte, sábado 4:00 PM (hora Colombia): si ya pasó, el conductor
    // que NO guardó disponibilidad para esta semana queda FUERA del generador
    // (no maneja, no descansa, no coordina). El admin lo puede rescatar
    // llenándole la disponibilidad consolidada (no tiene candado).
    let pool = state.drivers;
    let excluded = [];
    if (weekAvailClosed(state.currentWeek)) {
      try {
        const submitted = await Api.listSubmittedDriverIds(state.currentWeek);
        excluded = state.drivers.filter(d => !submitted.has(d.id));
        pool = state.drivers.filter(d => submitted.has(d.id));
      } catch (e) {
        pool = state.drivers; excluded = []; // si la consulta falla, no excluir (fail-safe)
      }
    }

    // Suspendidos esta semana (por llegar al límite de strikes en el mes, o
    // manual): fuera del generador.
    let suspendedThisWeek = [];
    try {
      const susp = await Api.getWeekSuspensions(state.currentWeek);
      if (susp.size) {
        suspendedThisWeek = pool.filter(d => susp.has(d.id));
        pool = pool.filter(d => !susp.has(d.id));
      }
    } catch (e) { /* fail-safe: no excluir por suspensión si falla */ }

    // Regla PM→AM entre semanas: quien cerró el DOMINGO PM de la semana
    // anterior (manejo + coordinación) no puede madrugar el lunes de esta.
    // Sembramos esos ids para que el generador los excluya del AM del lunes.
    let seedPmIds = [];
    try {
      const prevWeek = Scheduler.addDays(state.currentWeek, -7);
      const prev = await Api.getSchedule(prevWeek);
      const sun = prev?.data?.sun;
      if (sun) {
        seedPmIds = [...(sun.afternoon || []), ...(sun.coord_pm || [])].filter(Boolean);
      }
    } catch (e) { /* sin semana previa: no se siembra (fail-safe) */ }

    const flexCand = flexCoordinator();
    const flexId = (flexCand && pool.some(d => d.id === flexCand.id)) ? flexCand.id : null;
    // Pool de coordinadores = admins con is_coordinator + conductores con
    // can_coordinate (Daniel queda fuera: tiene su garantía dura aparte).
    const coordPool = [
      ...coordinatorAdmins(),
      ...pool.filter(d => d.can_coordinate && d.id !== flexId),
    ];
    // Dobles ya marcadas en el tablero: el generador las respeta (y su descanso).
    // Las de alguien que quedó fuera de la generación se pierden, y se dice.
    const poolIds = new Set(pool.map(d => d.id));
    const prevDoubles = Scheduler.doublesOf(state.schedule);
    const keepDoubles = prevDoubles.filter(x => poolIds.has(x.id));
    const lostDoubles = prevDoubles.filter(x => !poolIds.has(x.id));
    const { schedule, warnings } = Scheduler.generateSchedule({
      doubles: keepDoubles,
      restSlots: Scheduler.restSlotsFor(state.settings),
      drivers: pool,
      admins: coordPool,
      settings: { morningSlots: state.settings.morning_slots, afternoonSlots: state.settings.afternoon_slots, coordSlots: state.settings.coord_slots || 1 },
      availability: state.availability,
      flexCoordinatorId: flexId,
      weekStart: state.currentWeek,
      // Nonce nuevo por clic: cada "Generar" baraja distinto (siempre válido).
      // Lo que el admin elija se fija al Guardar/Publicar.
      nonce: Date.now() + '-' + Math.random(),
      seedPmIds,
    });
    // Lo ya avisado sobrevive a regenerar: si no, al publicar se re-avisarían
    // las dobles que se conservaron.
    const avisadas = state.schedule && state.schedule._doublesAvisadas;
    state.schedule = schedule;
    if (avisadas) state.schedule._doublesAvisadas = avisadas;
    if (keepDoubles.length) warnings.unshift(`Se respetaron ${keepDoubles.length} doble(s) marcada(s) y su descanso.`);
    lostDoubles.forEach(x => warnings.unshift(`Se quitó la doble de ${escapeHtml(nameOf(x.id) || 'un conductor')} (${Scheduler.DAY_LABELS_ES[x.day]}): no entra en esta generación.`));
    // El pool del board atenúa a los excluidos/suspendidos de esta generación.
    state._excludedIds = new Set(excluded.map(d => d.id));
    state._suspendedIds = new Set(suspendedThisWeek.map(d => d.id));
    const box = $('#schedule-warnings');
    const cutLbl = Scheduler.availabilityCutoffLabel(state.currentWeek);
    const exclMsg = excluded.length
      ? `<p class="text-rose-700 font-semibold">⛔ ${excluded.length} conductor(es) fuera por no llenar disponibilidad antes del ${cutLbl.day} ${cutLbl.date} a las ${cutLbl.time}: ${excluded.map(d => escapeHtml(d.name)).join(', ')}</p>`
      : '';
    const suspMsg = suspendedThisWeek.length
      ? `<p class="text-amber-700 font-semibold">🚫 ${suspendedThisWeek.length} conductor(es) suspendido(s) esta semana (${strikeLimit()} strikes en el mes / manual): ${suspendedThisWeek.map(d => escapeHtml(d.name)).join(', ')}</p>`
      : '';
    if (warnings.length || exclMsg || suspMsg) {
      box.innerHTML = exclMsg + suspMsg + (warnings.length
        ? '<strong>Advertencias:</strong><ul class="list-disc pl-5 mt-1">' +
          warnings.map(w => `<li>${w}</li>`).join('') + '</ul>'
        : '');
      box.classList.remove('hidden');
    } else {
      box.classList.add('hidden');
    }
    renderSchedule();
    toast('Horario generado. Guardar / Publicar para persistir.');
  }

  // ====================================================================
  // Publicar: reconcilia solicitudes pending → approved/rejected según el
  // horario final. Si el conductor quedó descansando ese día/jornada (no en
  // morning/afternoon ni en coord_*), su pending pasa a APPROVED; si quedó
  // trabajando o coordinando, pasa a REJECTED. El admin firma con su acción
  // de "Publicar" — antes no se toca ninguna solicitud.
  // ====================================================================

  async function reconcilePendingApprovals() {
    const all = await Api.listPendingApprovals(state.currentWeek);
    const ids = new Set(state.drivers.map(d => d.id));
    const pending = all.filter(r => r.state === 'pending' && ids.has(r.profile_id));
    if (!pending.length) return 0;
    const sched = state.schedule || {};
    let resolved = 0;
    for (const r of pending) {
      const day = Scheduler.DAYS[r.day_of_week];
      const slot = r.shift === 'am' ? 'morning' : 'afternoon';
      const coord = r.shift === 'am' ? 'coord_am' : 'coord_pm';
      const working = (sched[day]?.[slot] || []).includes(r.profile_id)
                   || (sched[day]?.[coord] || []).includes(r.profile_id);
      const decision = working ? 'rejected' : 'approved';
      const note = working
        ? 'Rechazado al publicar: la cobertura del día requería tu jornada.'
        : 'Aprobado al publicar: el horario final respeta tu solicitud.';
      try {
        await Api.resolveApproval(r.id, decision, note);
        resolved++;
      } catch (e) { /* ignora una y sigue con las demás */ }
    }
    return resolved;
  }

  async function onSaveSchedule(publish) {
    if (!state.schedule) { toast('Genera o edita el horario primero.'); return; }
    try {
      let avisos = null;
      const avisadasAntes = state.schedule._doublesAvisadas;
      if (publish) {
        const n = await reconcilePendingApprovals();
        if (n) toast(`${n} solicitud(es) resueltas al publicar.`);
        avisos = dobleCambios();
      }
      await Api.saveSchedule(state.currentWeek, state.schedule, { published: publish, drivers: [...state.drivers, ...state.admins] });
      $('#published-pill').classList.toggle('hidden', !publish);
      refreshPendingBadge();
      if (publish) {
        notify(state.drivers.map(d => d.id), 'Horario publicado',
          `Ya está disponible el horario de la semana del ${weekLabelES(state.currentWeek)}.`, '/');
        if (avisos) avisos.forEach(a => notify([a.id], a.title, a.body, '/'));
      }
      toast(publish ? 'Horario publicado.' : 'Horario guardado.');
    } catch (e) {
      // No se guardó: lo "ya avisado" vuelve a como estaba, para avisar al reintentar.
      if (state.schedule) state.schedule._doublesAvisadas = avisadasAntes;
      alert('Error al guardar: ' + e.message);
    }
  }

  // A quién avisar al publicar: a quien le pusieron o le quitaron una doble
  // desde la última vez que se avisó EN ESTA SEMANA. Lo ya avisado se guarda
  // dentro del mismo horario (data._doublesAvisadas), así no se cruza con otra
  // semana ni se repite al recargar. Deja la marca puesta antes de guardar.
  function dobleCambios() {
    const ahora = Scheduler.doublesOf(state.schedule);
    const antes = Array.isArray(state.schedule._doublesAvisadas) ? state.schedule._doublesAvisadas : [];
    const key = x => `${x.id}|${x.day}|${x.tipo}`;
    const kA = new Set(antes.map(key)), kN = new Set(ahora.map(key));
    const dia = (k) => (Scheduler.DAY_LABELS_ES[k] || k).toLowerCase();
    const next = (k) => dia(Scheduler.DAYS[Scheduler.DAYS.indexOf(k) + 1] || k);
    const txt = x => x.tipo === 'dia' ? `mañana y tarde del ${dia(x.day)}` : `tarde del ${dia(x.day)} y madrugada del ${next(x.day)}`;
    const out = [
      ...ahora.filter(x => !kA.has(key(x))).map(x =>
        ({ id: x.id, title: 'Te asignaron una doble', body: `Doblas ${txt(x)}.${x.nota ? ' Motivo: ' + x.nota : ''}` })),
      ...antes.filter(x => !kN.has(key(x))).map(x =>
        ({ id: x.id, title: 'Se quitó tu doble', body: `Ya no doblas ${txt(x)}. Revisa tu horario.` })),
    ];
    state.schedule._doublesAvisadas = ahora.map(x => ({ id: x.id, day: x.day, tipo: x.tipo }));
    return out;
  }

  async function onClearSchedule() {
    if (!confirm('¿Borrar el horario guardado de esta semana?')) return;
    try {
      await Api.deleteSchedule(state.currentWeek);
      state.schedule = null;
      $('#published-pill').classList.add('hidden');
      renderSchedule();
      toast('Horario eliminado.');
    } catch (e) {
      alert('Error al borrar: ' + e.message);
    }
  }

  // ====================================================================
  // Admin: cell editor
  // ====================================================================

  let editingCell = null;

  function openCellEditor(cell) {
    editingCell = cell;
    const kind = cell.dataset.kind;
    const day = cell.dataset.day;
    $('#cell-editor-title').textContent =
      `Editar ${kindLabel(kind)} · ${Scheduler.DAY_LABELS_ES[day]}`;
    const select = $('#cell-editor-select');
    const options = ['<option value="">— vacío —</option>'];
    // Fila de líder: solo los conductores de esa jornada que pueden liderar.
    let people;
    if (isCoordKind(kind)) {
      const shiftKind = kind === 'coord_am' ? 'morning' : 'afternoon';
      const ids = new Set((state.schedule?.[day]?.[shiftKind] || []).filter(Boolean));
      people = state.drivers.filter(p => ids.has(p.id) && p.can_coordinate);
      if (!people.length) options[0] = '<option value="">— nadie de esta jornada puede liderar —</option>';
    } else {
      people = state.drivers;
    }
    people.forEach(p => options.push(`<option value="${p.id}">${p.name}</option>`));
    select.innerHTML = options.join('');
    if (state.schedule) {
      const idx = parseInt(cell.dataset.index, 10);
      const id = state.schedule[day]?.[kind]?.[idx];
      if (id) select.value = id;
    }
    $('#cell-editor').classList.remove('hidden');
  }

  function kindLabel(k) {
    return { morning: 'Mañana', afternoon: 'Tarde', rest: 'Descanso', coord_am: 'Líder de turno AM', coord_pm: 'Líder de turno PM' }[k] || k;
  }

  function closeCellEditor() {
    editingCell = null;
    $('#cell-editor').classList.add('hidden');
  }

  function saveCellEditor() {
    if (!editingCell) return;
    const kind = editingCell.dataset.kind;
    const day = editingCell.dataset.day;
    const index = parseInt(editingCell.dataset.index, 10);
    const id = $('#cell-editor-select').value || null;

    state.schedule = state.schedule || Scheduler.emptySchedule();
    const sched = state.schedule;
    Scheduler.DAYS.forEach(d => {
      sched[d] = sched[d] || {};
      ['morning', 'afternoon', 'rest', 'coord_am', 'coord_pm'].forEach(k => {
        sched[d][k] = sched[d][k] || [];
      });
    });

    // Fila de líder: solo setea coord_am/coord_pm (el líder ya conduce su jornada;
    // no se toca morning/afternoon/rest). cleanLeaders valida que siga en su jornada.
    if (isCoordKind(kind)) {
      sched[day][kind] = id ? [id] : [];
      cleanLeaders(day);
      closeCellEditor();
      renderSchedule();
      return;
    }

    closeCellEditor();
    if (!id) {
      while (sched[day][kind].length <= index) sched[day][kind].push(null);
      sched[day][kind][index] = null;
      rebuildRestRow(day);
      renderSchedule();
      return;
    }
    // Mismo camino que arrastrar: si queda pegado a otra jornada suya, se
    // pregunta si es mover o doblar (y ya no corre a nadie de puesto).
    boardPlaceInto(day, kind, index, id, null);
  }

  function rebuildRestRow(day) {
    const sched = state.schedule[day];
    const used = new Set([...(sched.morning || []), ...(sched.afternoon || [])].filter(Boolean));
    sched.rest = state.drivers.filter(d => !used.has(d.id)).map(d => d.id);
    cleanLeaders(day); // el líder debe seguir estando en su jornada
  }

