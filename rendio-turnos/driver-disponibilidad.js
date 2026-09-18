// driver-disponibilidad.js — Pantalla de Disponibilidad del conductor.
// Rediseño entregado por el diseñador el 2026-08-16 (Modelo A · "pintar la semana").
// Reemplaza el render de tarjetas por día que vivía en driver-perfil.js.
//
// Qué resuelve, según la entrega:
//   1) «No entienden Descanso vs No disponible» → se renombran a "Prefiero no" /
//      "No puedo" y cada uno carga SIEMPRE su consecuencia en una línea visible,
//      no en una leyenda al final de la pantalla que nadie lee.
//   2) «La fila Prefiero aparece y desaparece sola» → se elimina el selector
//      AM/PM/Indistinto. Marcar "Prefiero no" en la mañana YA es preferir la tarde.
//   3) «No ven cuántos días faltan» → medidor de 14 jornadas pegado arriba, con
//      conteo de faltantes y cuenta regresiva al corte.
//
// Cambio de fondo: las jornadas nacen en 'unset' (Sin marcar). Antes todo
// arrancaba en 'available' y el que no marcaba entraba igual a la programación.
//
// Comparte scope global con los demás módulos; el orden de carga está en index.html.

  // ====================================================================
  // Vocabulario de estados — la pieza que arregla la confusión #1.
  // Clave de UI ↔ estado que ya existe en la BD (enum availability_state).
  // ====================================================================
  const AV_ST = {
    none:  { api: 'unset',       label: 'Sin marcar',    verb: 'Sin marcar',
             help: 'Si lo dejas así, el jefe no sabe si cuenta contigo.' },
    puedo: { api: 'available',   label: 'Puedo',         verb: 'Puedo',
             help: 'Entro a la programación normal. Sin trámite.' },
    pref:  { api: 'prefer_rest', label: 'Prefiero no',   verb: 'Prefiero no',
             help: 'Es una preferencia. Si no hay con quién cubrir, igual te programan.' },
    no:    { api: 'unavailable', label: 'No puedo',      verb: 'No puedo',
             help: 'Es un bloqueo. Pides el permiso y el jefe lo aprueba o lo niega.' },
    lock:  { api: null,          label: 'Descanso fijo', verb: 'Fijo',
             help: 'Lo fijó tu jefe en tu contrato. No se puede cambiar desde acá.' },
  };
  const AV_API_TO_UI = { unset: 'none', available: 'puedo', prefer_rest: 'pref', unavailable: 'no' };
  // 2026-09-15 — se retira la brocha. Era un MODO OCULTO: la fila de arriba cambiaba
  // lo que hacía el dedo después, y quien no lo descubría veía una pantalla muerta
  // (le pasó a la profa). Ahora la semana nace propuesta en "Puedo" y cada toque
  // ROTA la jornada por este ciclo. Un solo gesto en toda la pantalla.
  const AV_CYCLE = ['puedo', 'pref', 'no'];
  const AV_BRUSHES = AV_CYCLE;   // se conserva el nombre: ahora alimenta la leyenda
  const AV_REASON_CHIPS = ['Cita médica', 'Viaje familiar', 'Estudio', 'Diligencia', 'Salud'];

  // Estado local de la pantalla (lo persistente vive en state.ownAvail).
  const avUI = { dirty: false, saved: false, sheet: null };

  const AV_HINT_IDLE = '<b>Estás en «Puedo» toda la semana.</b> Toca una jornada para cambiarla.';

  function avNextState(cur) {
    const i = AV_CYCLE.indexOf(cur);
    return AV_CYCLE[(i + 1) % AV_CYCLE.length];
  }

  // La línea de ayuda ya no anuncia la brocha: explica lo que ACABA de pasar.
  function avSetHint(uiState) {
    const hint = $('#av-hint');
    if (!hint) return;
    hint.innerHTML = uiState && AV_ST[uiState]
      ? `<b>${AV_ST[uiState].label}.</b> ${AV_ST[uiState].help}`
      : AV_HINT_IDLE;
  }

  // ---- Iconos (line icons del sistema del diseñador, strokeWidth 1.5) ----
  const AV_ICON_PATHS = {
    check: '<polyline points="20 6 9 17 4 12"/>',
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    chevronLeft: '<polyline points="15 18 9 12 15 6"/>',
    chevronRight: '<polyline points="9 18 15 12 9 6"/>',
    alert: '<path d="M10.29 3.86l-8.18 14a2 2 0 0 0 1.71 3h16.36a2 2 0 0 0 1.71-3l-8.18-14a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
    rotate: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.6V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.6"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    calendarCheck: '<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4M9 15l2 2 4-4"/>',
    swap: '<path d="M4 8h13l-3.5-3.5M20 16H7l3.5 3.5"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.6 7.6 0 0 1 15 0"/>',
    // Usados por las otras pestañas del conductor (driver-tabs.js, Perfil).
    car: '<path d="M5 17h14M5 17v3M19 17v3M5 17l1.5-5.5a2 2 0 0 1 1.9-1.5h7.2a2 2 0 0 1 1.9 1.5L19 17M3 17h18"/><circle cx="8" cy="17" r="1.2"/><circle cx="16" cy="17" r="1.2"/>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    fileText: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
    messageCircle: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
    arrowRight: '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
  };
  function avIcon(name, size = 16, sw = 1.5) {
    return `<svg class="lucide" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"
      aria-hidden="true">${AV_ICON_PATHS[name] || ''}</svg>`;
  }

  // ====================================================================
  // Lectura del estado
  // ====================================================================

  // El bloqueo por contrato (descanso fijo) gana sobre lo que haya guardado:
  // es parametrización del jefe, no del conductor.
  // Lo que de verdad está guardado. 'none' = la jornada nunca se confirmó.
  function avCellRawState(dayKey, shift) {
    if (Scheduler.ruleBlocked(state.profile, dayKey, shift)) return 'lock';
    const cell = state.ownAvail && state.ownAvail[dayKey];
    const raw = cell ? cell[shift] : 'unset';
    return AV_API_TO_UI[raw] || 'none';
  }

  // Lo que SE PINTA: lo no marcado se muestra como "Puedo", que es la propuesta que
  // el conductor acepta al guardar. Propuesta NO es guardado: mientras no confirme,
  // en la BD sigue 'unset' y no entra a la programación (regla de agosto intacta).
  function avEditable() {
    return !isSuspended() && !weekAvailClosed(state.currentWeek);
  }

  function avCellUiState(dayKey, shift) {
    const raw = avCellRawState(dayKey, shift);
    // En una semana ya cerrada NO se propone nada: se muestra lo que de verdad
    // quedó guardado. Pintar de verde lo que nunca confirmó sería mentirle.
    return raw === 'none' && avEditable() ? 'puedo' : raw;
  }

  function avCellProposed(dayKey, shift) {
    return avCellRawState(dayKey, shift) === 'none';
  }

  function avCells() {
    const out = [];
    Scheduler.weekDates(state.currentWeek).forEach(d => {
      out.push({ id: `${d.key}-am`, day: d.key, shift: 'am' });
      out.push({ id: `${d.key}-pm`, day: d.key, shift: 'pm' });
    });
    return out;
  }

  // 'faltan' conserva el nombre (lo leen driver-tabs.js y la home) pero cambió de
  // significado: ya no es "sin marcar" sino SIN CONFIRMAR.
  function avCounts() {
    let faltan = 0, marcables = 0, puedo = 0, pref = 0, no = 0;
    avCells().forEach(c => {
      const s = avCellUiState(c.day, c.shift);
      if (s === 'lock') return;
      marcables++;
      if (avCellProposed(c.day, c.shift)) faltan++;
      if (s === 'puedo') puedo++; else if (s === 'pref') pref++; else if (s === 'no') no++;
    });
    return { faltan, marcables, puedo, pref, no };
  }

  function avPendingCount() {
    let n = 0;
    Scheduler.DAYS.forEach(d => {
      const cell = state.ownAvail && state.ownAvail[d];
      if (!cell) return;
      ['am', 'pm'].forEach(sh => {
        const req = cell[`${sh}_request`];
        if (req && req.state === 'pending') n++;
      });
    });
    return n;
  }

  // Cuenta regresiva al corte del domingo 2:00 PM.
  function avCutoffText() {
    const ms = Scheduler.availabilityCutoff(state.currentWeek).getTime() - Date.now();
    if (ms <= 0) return { text: 'Cerrado', tone: 'var(--r-error)' };
    const h = Math.floor(ms / 3600000);
    const d = Math.floor(h / 24);
    if (d >= 1) return { text: `${d} d ${h % 24} h`, tone: 'var(--r-text-3)' };
    if (h >= 1) return { text: `${h} h ${Math.floor((ms % 3600000) / 60000)} m`, tone: 'var(--r-warn)' };
    return { text: `${Math.max(1, Math.floor(ms / 60000))} m`, tone: 'var(--r-error)' };
  }

  // Prioridad de avisos (spec del diseñador):
  // suspendido → reabierto → cerrado → cierra hoy → normal (sin aviso).
  function avNoticeHtml() {
    const note = (tone, icon, html) =>
      `<div class="rc-note ${tone}" style="margin-top:14px">
         <span class="rc-note-ic">${avIcon(icon, 17)}</span><span>${html}</span>
       </div>`;
    if (isSuspended()) {
      return note('err', 'alert', '<b>Tu cuenta está suspendida.</b> No entras a la programación hasta que tu jefe te reactive.');
    }
    const reopen = reopenInfo(state.currentWeek);
    if (reopen.active) {
      return note('ok', 'rotate', `<b>Tu jefe reabrió la semana hasta las ${hhmmCO(reopen.until)}.</b> Corrige y guarda antes de esa hora.`);
    }
    if (weekAvailClosed(state.currentWeek)) {
      return note('err', 'lock', '<b>Esta semana ya cerró.</b> Toca la flecha ▸ de arriba y marca la que viene. Si necesitas un cambio en esta, escríbele a tu jefe desde Solicitudes.');
    }
    if (Scheduler.availabilityClosingSoon(state.currentWeek)) {
      return note('warn', 'clock', '<b>Cierra hoy a las 2:00 p.m.</b> Guarda antes de esa hora.');
    }
    return '';
  }

  function avWeekSuspensionHtml() {
    if (!state.weekSuspension) return '';
    const why = state.weekSuspension.source === 'strikes' ? ` por acumular ${strikeLimit()} strikes` : '';
    return `<div class="rc-note warn" style="margin-top:10px">
      <span class="rc-note-ic">${avIcon('alert', 17)}</span>
      <span><b>Estás suspendido esta semana${why}.</b> No entras en la generación de turnos. Habla con tu jefe.</span>
    </div>`;
  }

  function avWeekRangeLabel() {
    const m = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
    const a = new Date(state.currentWeek + 'T00:00:00');
    const b = new Date(state.currentWeek + 'T00:00:00'); b.setDate(b.getDate() + 6);
    return a.getMonth() === b.getMonth()
      ? `${a.getDate()} — ${b.getDate()} de ${m[b.getMonth()]}`
      : `${a.getDate()} de ${m[a.getMonth()]} — ${b.getDate()} de ${m[b.getMonth()]}`;
  }

  // ====================================================================
  // Render
  // ====================================================================

  // Se conserva el nombre renderDriverDays(): lo llaman core.js y driver-home.js.
  function renderDriverDays() {
    const root = $('#driver-avail-root');
    if (!root) return;
    const readOnly = isSuspended() || weekAvailClosed(state.currentWeek);
    const blockedMsg = isSuspended() ? 'Cuenta suspendida' : (weekAvailClosed(state.currentWeek) ? 'Semana cerrada' : null);
    const week = Scheduler.weekDates(state.currentWeek);
    const todayISO = new Date().toISOString().slice(0, 10);
    const pend = avPendingCount();

    // 2026-09-15 — `rc-readonly` (pointer-events:none) se aplicaba a la RAÍZ, y la
    // cabecera con #av-prev/#av-next vive dentro: en una semana cerrada el conductor
    // no podía ni pasar a la semana que sí está abierta. Toca y no pasa NADA, que es
    // exactamente lo que se sintió como app rota. Ahora la clase cubre solo lo que
    // de verdad no se puede editar; navegar y leer siguen vivos.
    root.className = 'rc';
    root.innerHTML = `
      ${avStickyHtml()}

      <div style="margin-top:14px;text-align:center">
        <h1 class="rc-h">¿Cuándo puedes trabajar?</h1>
        <p class="rc-sub">${escapeHtml(firstNameOf(state.profile))}, arrancas disponible toda la semana. Toca las jornadas que no, y confirma antes del domingo.</p>
      </div>

      ${avNoticeHtml()}
      ${avWeekSuspensionHtml()}

      <div class="${readOnly ? 'rc-readonly' : ''}">
      <div class="rc-in" style="margin-top:16px">
        <div class="av-legend" aria-hidden="true">
          ${AV_CYCLE.map(k => `<span class="av-legend-it" data-k="${k}"><i></i>${AV_ST[k].label}</span>`).join('')}
        </div>
        <p class="av-hint" id="av-hint">${avEditable() ? AV_HINT_IDLE : 'Así quedó esta semana.'}</p>
      </div>

      <div class="av-grid rc-in d1" id="av-grid" style="margin-top:2px">
        <div></div>
        <div class="av-colhead">MAÑANA</div>
        <div class="av-colhead">TARDE</div>
        ${week.map(d => {
          const isToday = d.date === todayISO;
          const dayNum = new Date(d.date + 'T00:00:00').getDate();
          const mon = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'][new Date(d.date + 'T00:00:00').getMonth()];
          return `
            <button class="av-day ${isToday ? 'is-today' : ''}" data-day="${d.key}" type="button">
              <b>${d.label.slice(0, 3)}</b><span>${dayNum} ${mon}</span>
            </button>
            ${['am', 'pm'].map(sh => avCellHtml(d.key, sh)).join('')}`;
        }).join('')}
      </div>

      <div style="display:flex;gap:8px;margin-top:12px" class="rc-in d2">
        <button class="r-btn r-btn-ghost" id="av-all" type="button"
          style="flex:1;height:42px;font-size:13.5px;border-radius:12px">Volver todo a «Puedo»</button>
      </div>

      <p style="font-size:12px;color:var(--r-text-3);line-height:1.5;margin:14px 2px 0">
        Cada toque cambia la jornada: Puedo → Prefiero no → No puedo → Puedo. Arrastra para
        aplicar lo mismo a varias seguidas, o toca el día para mañana y tarde a la vez.
      </p>
      </div>

      ${pend > 0 ? `
        <button class="rc-link-row rc-in d3" id="av-goto-requests" type="button">
          <span class="rc-link-ic">${avIcon('clock', 15)}</span>
          <span class="t">
            <b>${pend} permiso${pend > 1 ? 's' : ''} en revisión</b>
            <span>El estado de aprobación vive en Solicitudes</span>
          </span>
          <span class="rc-link-chev">${avIcon('chevronRight', 17)}</span>
        </button>` : ''}

      ${avSaveBlockHtml(blockedMsg)}
    `;

    avBindScreen();
    avUpdateNavBadge(pend);
    updateDriverGreeting();
  }

  function avCellHtml(dayKey, shift) {
    const s = avCellUiState(dayKey, shift);
    const ic = { lock: 'lock', puedo: 'check', pref: 'moon', no: 'x' }[s];
    return `<div class="av-cell" data-cell="${dayKey}-${shift}" data-s="${s}" data-p="${avCellProposed(dayKey, shift) ? '1' : ''}">
      ${ic ? `<span class="av-cell-ic">${avIcon(ic, s === 'puedo' ? 15 : 14)}</span>` : ''}
      <span>${AV_ST[s].verb}</span>
    </div>`;
  }

  function avStickyHtml() {
    const cut = avCutoffText();
    return `<div class="rc-sticky">
      <div class="rc-weeknav">
        <button class="r-icon-btn" id="av-prev" type="button" aria-label="Semana anterior">${avIcon('chevronLeft', 19)}</button>
        <div class="rc-weeknav-mid">
          <div class="rc-eyebrow">Semana que se está armando</div>
          <div class="rc-weeknav-label">${avWeekRangeLabel()}</div>
        </div>
        <button class="r-icon-btn" id="av-next" type="button" aria-label="Semana siguiente">${avIcon('chevronRight', 19)}</button>
      </div>
      <div class="av-meter" id="av-meter">
        ${avCells().map(c => {
          const s = avCellUiState(c.day, c.shift);
          return `<i data-cell-meter="${c.id}" data-s="${s}" data-p="${avCellProposed(c.day, c.shift) ? '1' : ''}"></i>`;
        }).join('')}
      </div>
      <div class="av-status">
        <span class="av-left" id="av-left" style="color:${avStatusOk() ? 'var(--st-ok-fg)' : 'var(--r-warn)'}">
          ${avStatusLeftHtml()}
        </span>
        <span class="av-cut" style="color:${cut.tone}">${avIcon('clock', 13)} ${cut.text}</span>
      </div>
    </div>`;
  }

  // Resumen de la franja fija: lo que importa ya no es cuántas faltan por marcar
  // (ninguna: nacen en Puedo) sino si la semana está CONFIRMADA o no.
  // Corto a propósito: comparte renglón con la cuenta regresiva y el detalle ya
  // está en el medidor y en la grilla. Ojo con "confirmada": pintar la grilla NO
  // es guardarla — mientras haya cambios sin mandar, esto no puede decir que sí.
  function avStatusLeftHtml() {
    if (avCounts().faltan > 0) return 'Sin confirmar';
    return avUI.dirty ? 'Sin guardar' : 'Semana confirmada';
  }

  function avStatusOk() {
    return avCounts().faltan === 0 && !avUI.dirty;
  }

  function avSaveBlockHtml(blockedMsg) {
    if (blockedMsg) {
      return `<div class="rc-blocked">${avIcon('lock', 17)} ${blockedMsg} — no se puede guardar.</div>`;
    }
    const { faltan } = avCounts();
    const done = avUI.saved && !avUI.dirty && faltan === 0;
    const note = done
      ? 'Tu jefe ya lo ve. Puedes seguir cambiándola hasta el domingo a las 2:00 p.m.'
      : faltan > 0
        ? 'Hasta que confirmes, tu jefe no cuenta contigo para esta semana.'
        : 'Se guarda y tu jefe lo ve al instante.';
    return `<div style="margin-top:24px" id="av-save-block">
      <button class="rc-save-btn full ${done ? 'done' : ''}" id="av-save" type="button" ${(!avUI.dirty && faltan === 0 && !done) ? 'disabled' : ''}>
        ${done
          ? `<svg class="rc-check" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>Guardado`
          : (faltan > 0 ? 'Confirmar mi semana' : 'Guardar cambios')}
      </button>
      <p class="rc-savenote ${done ? 'ok' : ''}" id="av-save-note">${note}</p>
    </div>`;
  }

  // ====================================================================
  // Pintar
  // ====================================================================

  // Escribe en state.ownAvail (formato de la API) y refresca SOLO lo que cambió:
  // durante un arrastre no se puede re-renderizar la grilla, porque elementFromPoint
  // dejaría de encontrar las celdas al reemplazarse los nodos.
  function avPaint(ids, uiState) {
    const real = ids.filter(id => {
      const [day, shift] = id.split('-');
      return !Scheduler.ruleBlocked(state.profile, day, shift);
    });
    if (!real.length) return;
    const api = AV_ST[uiState].api;
    real.forEach(id => {
      const [day, shift] = id.split('-');
      state.ownAvail[day] = state.ownAvail[day] || { am: 'unset', pm: 'unset' };
      state.ownAvail[day][shift] = api;
      // Al salir de "No puedo" el motivo deja de aplicar.
      if (uiState !== 'no') state.ownAvail[day][`${shift}_reason`] = null;
      avRefreshCellDom(id);
    });
    avUI.dirty = true;
    avUI.saved = false;
    // El motivo del "No puedo" NO se pide acá: con el ciclo, el rojo puede ser una
    // parada de paso camino al verde. Se pide una sola vez al confirmar (avSave).
    avRefreshStatus();
  }

  function avRefreshCellDom(id) {
    const [day, shift] = id.split('-');
    const s = avCellUiState(day, shift);
    const cell = document.querySelector(`[data-cell="${id}"]`);
    if (cell) {
      const ic = { lock: 'lock', puedo: 'check', pref: 'moon', no: 'x' }[s];
      cell.dataset.s = s;
      cell.dataset.p = avCellProposed(day, shift) ? '1' : '';
      cell.innerHTML = `${ic ? `<span class="av-cell-ic">${avIcon(ic, s === 'puedo' ? 15 : 14)}</span>` : ''}<span>${AV_ST[s].verb}</span>`;
      cell.classList.remove('just-set');
      void cell.offsetWidth;   // reinicia la animación de rebote
      cell.classList.add('just-set');
    }
    const seg = document.querySelector(`[data-cell-meter="${id}"]`);
    if (seg) {
      seg.dataset.s = s;
      seg.dataset.p = avCellProposed(day, shift) ? '1' : '';
    }
  }

  // Medidor, contador y bloque de guardar, sin tocar la grilla.
  function avRefreshStatus() {
    const { faltan } = avCounts();
    const left = $('#av-left');
    if (left) {
      left.style.color = avStatusOk() ? 'var(--st-ok-fg)' : 'var(--r-warn)';
      left.innerHTML = avStatusLeftHtml();
    }
    const block = $('#av-save-block');
    if (block) {
      const wrap = document.createElement('div');
      wrap.innerHTML = avSaveBlockHtml(null);
      block.replaceWith(wrap.firstElementChild);
      $('#av-save')?.addEventListener('click', avSave);
    }
  }

  // ====================================================================
  // Hoja de motivo — una sola para toda la tanda del trazo
  // ====================================================================

  function avCellLabel(id) {
    const [day, shift] = id.split('-');
    const label = Scheduler.DAY_LABELS_ES[day] || day;
    const nice = label.charAt(0) + label.slice(1).toLowerCase();
    return `${nice} · ${shift === 'am' ? 'Mañana' : 'Tarde'}`;
  }

  function avOpenSheet(cells, thenSave) {
    // Motivo previo, si esas jornadas ya lo tenían.
    let prev = '';
    for (const id of cells) {
      const [day, shift] = id.split('-');
      const r = state.ownAvail[day] && state.ownAvail[day][`${shift}_reason`];
      if (r) { prev = r; break; }
    }
    avUI.sheet = { cells, text: prev, thenSave: !!thenSave };
    avRenderSheet();
    $('#av-back')?.classList.add('open');
    $('#av-sheet')?.classList.add('open');
    setTimeout(() => $('#av-reason')?.focus(), 380);
  }

  // Tres salidas: «Pedir permiso» (true) deja el motivo, «Mejor Prefiero no» ('pref')
  // baja la tanda a preferencia, y tocar el velo (core.js llama con false) CANCELA:
  // no cambia nada ni guarda. Antes del 18-sep el velo también bajaba a «Prefiero
  // no»; desde que la hoja sale al confirmar, eso además guardaba la semana.
  function avCloseSheet(how) {
    const sheet = avUI.sheet;
    avUI.sheet = null;
    $('#av-back')?.classList.remove('open');
    $('#av-sheet')?.classList.remove('open');
    if (!sheet) return;
    if (how === true) {
      // El motivo queda en todas las jornadas de la tanda.
      sheet.cells.forEach(id => {
        const [day, shift] = id.split('-');
        state.ownAvail[day] = state.ownAvail[day] || { am: 'unset', pm: 'unset' };
        state.ownAvail[day][`${shift}_reason`] = sheet.text.trim();
      });
    } else if (how === 'pref') {
      // "Mejor «Prefiero no»" devuelve TODA la tanda a preferencia blanda.
      avPaint(sheet.cells, 'pref');
    } else {
      return;
    }
    avRefreshStatus();
    // La hoja se abrió desde el botón de confirmar: retomar el guardado.
    if (sheet.thenSave) avSave();
  }

  function avRenderSheet() {
    const box = $('#av-sheet');
    if (!box) return;
    const s = avUI.sheet;
    const cells = s ? s.cells : [];
    const text = s ? s.text : '';
    const ok = !!text.trim();
    box.innerHTML = `
      <div class="rc-grab"></div>
      <h3>¿Por qué no puedes?</h3>
      <p class="rc-sheet-sub">
        ${cells.length <= 3
          ? escapeHtml(cells.map(avCellLabel).join(' · '))
          : `${cells.length} jornadas marcadas como «No puedo»`}.
        Esto queda como una <b>solicitud de permiso</b> — el jefe la aprueba o la niega.
      </p>
      <div class="rc-chips" id="av-chips">
        ${AV_REASON_CHIPS.map(c => `<button type="button" class="r-chip ${text === c ? 'on' : ''}" data-chip="${escapeHtml(c)}">${c}</button>`).join('')}
      </div>
      <textarea class="rc-ta" id="av-reason" rows="3" placeholder="Cuéntale al jefe en una línea…">${escapeHtml(text)}</textarea>
      <div class="rc-sheet-actions">
        <button class="r-btn r-btn-secondary" id="av-sheet-pref" type="button" style="flex:1">Mejor «Prefiero no»</button>
        <button class="r-btn r-btn-primary" id="av-sheet-ok" type="button" style="flex:1.3;${ok ? '' : 'opacity:.45;pointer-events:none'}">${s && s.thenSave ? 'Pedir permiso y confirmar' : 'Pedir permiso'}</button>
      </div>
      <p class="rc-sheet-foot">Sigue el estado en <b>Solicitudes</b>. Te avisamos cuando responda.</p>`;

    $('#av-chips')?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-chip]');
      if (!b || !avUI.sheet) return;
      avUI.sheet.text = b.dataset.chip;
      avRenderSheet();
    });
    $('#av-reason')?.addEventListener('input', (e) => {
      if (!avUI.sheet) return;
      avUI.sheet.text = e.target.value;
      const btn = $('#av-sheet-ok');
      if (btn) {
        const on = !!e.target.value.trim();
        btn.style.opacity = on ? '1' : '.45';
        btn.style.pointerEvents = on ? 'auto' : 'none';
      }
      $('#av-chips')?.querySelectorAll('[data-chip]').forEach(c =>
        c.classList.toggle('on', c.dataset.chip === e.target.value));
    });
    $('#av-sheet-pref')?.addEventListener('click', () => avCloseSheet('pref'));
    $('#av-sheet-ok')?.addEventListener('click', () => avCloseSheet(true));
  }

  // ====================================================================
  // Guardar
  // ====================================================================

  // Jornadas en "No puedo" a las que todavía no se les preguntó el motivo.
  function avNoWithoutReason() {
    return avCells().filter(c => {
      if (avCellUiState(c.day, c.shift) !== 'no') return false;
      const cell = state.ownAvail && state.ownAvail[c.day];
      return !(cell && (cell[`${c.shift}_reason`] || '').trim());
    }).map(c => c.id);
  }

  // Lo propuesto (verde punteado) se vuelve 'available' de verdad SOLO acá, al
  // confirmar. Se manda una copia: si el guardado falla, la pantalla no miente.
  function avPayloadConfirmado() {
    const out = {};
    Scheduler.DAYS.forEach(d => {
      const src = (state.ownAvail && state.ownAvail[d]) || {};
      out[d] = Object.assign({ am: 'unset', pm: 'unset' }, src);
    });
    avCells().forEach(c => {
      if (avCellProposed(c.day, c.shift)) out[c.day][c.shift] = 'available';
    });
    return out;
  }

  async function avSave() {
    if (isSuspended() || weekAvailClosed(state.currentWeek)) return;
    const pendientes = avNoWithoutReason();
    if (pendientes.length) { avOpenSheet(pendientes, true); return; }
    const btn = $('#av-save');
    const note = $('#av-save-note');
    if (btn) { btn.disabled = true; btn.textContent = 'Guardando…'; }
    try {
      await Api.saveDriverWeekAvailability(state.profile.id, state.currentWeek, avPayloadConfirmado());
      avUI.dirty = false;
      avUI.saved = true;
      await refreshDriverView();
    } catch (e) {
      console.error(e);
      if (btn) { btn.disabled = false; btn.textContent = 'Confirmar mi semana'; }
      if (note) { note.textContent = 'No se pudo guardar: ' + e.message; note.style.color = 'var(--r-error)'; }
    }
  }

  // ====================================================================
  // Eventos de la pantalla
  // ====================================================================

  function avBindScreen() {
    $('#av-prev')?.addEventListener('click', () => navigateDriverWeek(-7));
    $('#av-next')?.addEventListener('click', () => navigateDriverWeek(7));
    $('#av-goto-requests')?.addEventListener('click', () => setDriverTab('requests'));
    $('#av-save')?.addEventListener('click', avSave);

    $('#av-all')?.addEventListener('click', () => {
      avPaint(avCells().map(c => c.id), 'puedo');
      avSetHint('puedo');
    });

    const grid = $('#av-grid');
    if (grid) avBindPainting(grid);
  }

  // Un toque rota la jornada por el ciclo. Si el dedo sigue arrastrando, las demás
  // celdas del trazo reciben EL MISMO estado al que rotó la primera — así el
  // arrastre sigue sirviendo de atajo sin volverse impredecible.
  function avBindPainting(grid) {
    let painting = false;
    let stroke = new Set();
    let strokeState = null;

    const cellAt = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      return el && el.closest('[data-cell]');
    };
    const apply = (node, first) => {
      if (!node) return;
      const id = node.dataset.cell;
      const [day, shift] = id.split('-');
      if (Scheduler.ruleBlocked(state.profile, day, shift) || stroke.has(id)) return;
      stroke.add(id);
      if (first) strokeState = avNextState(avCellUiState(day, shift));
      if (!strokeState) return;
      avPaint([id], strokeState);
      avSetHint(strokeState);
    };

    grid.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.av-day')) return;   // el día tiene su propio handler
      painting = true;
      stroke = new Set();
      if (grid.setPointerCapture) { try { grid.setPointerCapture(e.pointerId); } catch (err) { /* noop */ } }
      apply(cellAt(e), true);
    });
    grid.addEventListener('pointermove', (e) => { if (painting) apply(cellAt(e), false); });
    const end = () => { if (!painting) return; painting = false; stroke = new Set(); strokeState = null; };
    grid.addEventListener('pointerup', end);
    grid.addEventListener('pointercancel', end);

    // Tocar la etiqueta del día pinta mañana y tarde.
    grid.addEventListener('click', (e) => {
      const b = e.target.closest('.av-day');
      if (!b) return;
      const day = b.dataset.day;
      // El día rota según su mañana; si esa está bloqueada por contrato, según la tarde.
      const base = ['am', 'pm'].map(sh => avCellUiState(day, sh)).find(s => s !== 'lock');
      if (!base) return;
      const next = avNextState(base);
      avPaint([`${day}-am`, `${day}-pm`], next);
      avSetHint(next);
    });
  }

  // ====================================================================
  // Barra de pestañas — mismo markup y mismo wiring, look nuevo
  // ====================================================================

  const AV_NAV_ICONS = { home: 'home', avail: 'calendar', schedule: 'calendarCheck', requests: 'swap', perfil: 'user' };

  function avUpgradeDriverNav() {
    const nav = document.getElementById('driver-nav');
    if (!nav || nav.classList.contains('rc-nav')) return;
    nav.classList.add('rc-nav');
    nav.querySelectorAll('.dnav-btn').forEach(btn => {
      const ic = btn.querySelector('.dnav-ic');
      const key = AV_NAV_ICONS[btn.dataset.dtab];
      if (ic && key) ic.innerHTML = avIcon(key, 21, 1.6);
    });
  }

  // Badges de la barra: permisos en revisión en Solicitudes, jornadas por marcar
  // en Disponibilidad (el diseño los pide en las dos).
  function avUpdateNavBadge(pendientes) {
    avSetNavDot('requests', pendientes);
    // Ya no es un conteo de jornadas sin marcar (nacen todas en Puedo): es un
    // aviso de que la semana está sin confirmar.
    avSetNavDot('avail', avStatusOk() ? 0 : '!');
  }

  function avSetNavDot(tab, n) {
    const btn = document.querySelector(`#driver-nav .dnav-btn[data-dtab="${tab}"]`);
    if (!btn) return;
    let dot = btn.querySelector('.dnav-dot');
    if (!n) { dot?.remove(); return; }
    if (!dot) {
      dot = document.createElement('span');
      dot.className = 'dnav-dot';
      btn.appendChild(dot);
    }
    dot.textContent = n > 9 ? '9+' : String(n);
  }

  // Subtítulo de la tarjeta de Disponibilidad en la home del conductor.
  function availabilitySummaryText() {
    const range = weekLabelES(state.currentWeek);
    if (avStatusOk()) return `Semana del ${range} confirmada. Puedes ajustarla.`;
    return `Confirma tu semana del ${range}.`;
  }

  // La barra de pestañas se puede revestir apenas está el DOM: no depende de sesión.
  avUpgradeDriverNav();
