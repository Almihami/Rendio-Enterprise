// admin-personal.js — Admin: personal (workers), strikes, reglas, prioridad y
// Turnos › Configuración › Ajustes (los 13 del turno).
// Extraído de app.js (split mecánico 2026-07-10, sin cambios de lógica).
// El 2026-09-12 se le sacaron Calibración (admin-calibracion.js) y Flota
// (admin-flota.js), que eran el 65% del archivo. Acá se quedaron los helpers
// set* porque los usan los TRES módulos de Ajustes y el mismo nombre no se
// puede declarar dos veces: es un solo scope global para todos estos archivos.
// Comparte scope global con los demás módulos; el orden de carga está en index.html.
  // ====================================================================
  // Admin: workers + settings
  // ====================================================================

  function workerCardHtml(w, opts) {
    const initial = (w.name || w.email).slice(0, 1).toUpperCase();
    const roleColor = opts.kind === 'admin' ? 'bg-brand' : (opts.kind === 'suspended' ? 'bg-slate-400' : 'bg-slate-200');
    const roleLabel = opts.kind === 'admin' ? 'Administrador' : (opts.kind === 'suspended' ? 'Suspendido' : 'Conductor');
    const roleTxt = opts.kind === 'admin' ? 'text-brand' : (opts.kind === 'suspended' ? 'text-amber-600' : 'text-slate-500');
    return `<div class="worker-card ${opts.kind === 'admin' ? 'coordinator' : ''} ${opts.kind === 'suspended' ? 'is-suspended' : ''}">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-full ${roleColor} text-white font-bold flex items-center justify-center text-sm">${initial}</div>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold text-ink truncate">${escapeHtml(w.name)}</p>
          <p class="text-xs text-slate-500 truncate">${escapeHtml(w.email)}</p>
          <p class="text-[10px] uppercase font-bold tracking-wider ${roleTxt} mt-0.5">${roleLabel}</p>
        </div>
      </div>
      ${opts.badges ? `<div class="worker-badges">${opts.badges}</div>` : ''}
      ${opts.actions || ''}
    </div>`;
  }

  async function renderWorkers() {
    const list = $('#workers-list');
    list.innerHTML = '<p class="text-sm text-slate-500">Cargando…</p>';
    let admins, drivers, strikeCounts, weekSusp, rulesRows, sched, closedShifts;
    try {
      [admins, drivers, strikeCounts, weekSusp, rulesRows, sched, closedShifts] = await Promise.all([
        Api.listAdmins(), Api.listAllDriversForAdmin(),
        Api.getActiveStrikeCounts().catch(() => new Map()),
        Api.getWeekSuspensions(state.currentWeek).catch(() => new Map()),
        Api.listDriverRules().catch(() => []),
        Api.getSchedule(state.currentWeek).catch(() => null),
        Api.listClosedShiftsAdmin().catch(() => []),
      ]);
    } catch (e) {
      list.innerHTML = `<p class="text-sm text-rose-600">Error cargando personal: ${escapeHtml(e.message)}</p>`;
      return;
    }
    state._strikeCounts = strikeCounts;
    // Km acumulado por persona (profile_id) desde los turnos cerrados.
    const kmByProfile = new Map();
    (closedShifts || []).forEach(s => {
      const pid = s.driver_profiles && s.driver_profiles.profile_id;
      if (!pid) return;
      const km = Math.max(0, (s.closing_km || 0) - (s.opening_km || 0));
      const cur = kmByProfile.get(pid) || { km: 0, turns: 0 };
      cur.km += km; cur.turns += 1; kmByProfile.set(pid, cur);
    });
    // ---- Reskin dirección C (maestro-detalle). VISUAL ONLY: reusa onWorkerAction y Api.* ----
    const rulesMap = Api.rulesToMap(rulesRows);              // { profileId: Set('day-shift') }
    const DAYS = Scheduler.DAYS;                              // mon..sun
    const DLABEL = { mon: 'Lun', tue: 'Mar', wed: 'Mié', thu: 'Jue', fri: 'Vie', sat: 'Sáb', sun: 'Dom' };

    // Carga de la semana (solo lectura, desde el horario guardado si existe).
    const loadOf = {};
    const bump = (id, k) => { const o = loadOf[id] = loadOf[id] || { am: 0, pm: 0, co: 0, total: 0 }; o[k]++; if (k !== 'co') o.total++; };
    if (sched && sched.data) DAYS.forEach(day => {
      const d = sched.data[day]; if (!d) return;
      (d.morning   || []).forEach(id => bump(id, 'am'));
      (d.afternoon || []).forEach(id => bump(id, 'pm'));
      (d.coord_am  || []).forEach(id => bump(id, 'co'));
      (d.coord_pm  || []).forEach(id => bump(id, 'co'));
    });

    const restText = (id) => {
      const set = rulesMap[id]; if (!set || !set.size) return '';
      const byDay = {};
      [...set].forEach(k => { const [day, sh] = k.split('-'); (byDay[day] = byDay[day] || []).push(sh); });
      return DAYS.filter(d => byDay[d]).map(d => {
        const sh = byDay[d].sort(); const both = sh.includes('am') && sh.includes('pm');
        return DLABEL[d] + (both ? '' : ' ' + sh.map(s => s.toUpperCase()).join('/'));
      }).join(' · ');
    };

    const people = [
      ...admins.map(a => ({ id: a.id, name: a.full_name, email: a.email, role: 'admin',
        coord: a.is_coordinator !== false, active: true, strikes: 0, suspWeek: false, rest: '',
        alerts: a.receives_ops_alerts === true,
        load: { am: 0, pm: 0, co: 0, total: 0 } })),
      ...drivers.map(d => ({ id: d.id, name: d.name, email: d.email, role: 'driver',
        coord: d.can_coordinate === true, active: d.active !== false,
        strikes: strikeCounts.get(d.id) || 0, suspWeek: weekSusp.has(d.id), suspRow: weekSusp.get(d.id) || null,
        km: (kmByProfile.get(d.id) || {}).km || 0, turns: (kmByProfile.get(d.id) || {}).turns || 0,
        rest: restText(d.id), load: loadOf[d.id] || { am: 0, pm: 0, co: 0, total: 0 } })),
    ];
    if (!state._pcSel || !people.find(p => p.id === state._pcSel)) state._pcSel = people[0] ? people[0].id : null;

    const PAL = ['#3B82F6', '#0EA5A0', '#8B5CF6', '#2563A8', '#16936A', '#7C5CD6', '#D98A12', '#0EA5E9', '#9A8D7A'];
    const colorOf = (p) => { if (p.role === 'admin') return '#F26522';
      let h = 0; for (let i = 0; i < p.id.length; i++) h = (h * 31 + p.id.charCodeAt(i)) >>> 0; return PAL[h % PAL.length]; };
    const initials = (n) => { const a = (n || '').trim().split(/\s+/); return (((a[0] || '')[0] || '') + ((a[1] || '')[0] || '')).toUpperCase() || '·'; };
    const loadCls = (t) => t >= 5 ? 'hi' : t <= 2 ? 'lo' : '';
    // El 3 estaba quemado a mano en esta pantalla, y eso era un bug viejo: el
    // límite se puede cambiar en Ajustes desde hace rato y aquí se seguía
    // pintando "3" pasara lo que pasara. Si el jefe lo pone en 5, ahora se
    // dibujan 5 puntos y "En riesgo" empieza en el quinto. strikeLimit() vive en
    // core.js y es FUNCIÓN porque state.settings solo se llena al iniciar sesión.
    const statusInfo = (p) => !p.active ? { cls: 'sus', dot: 'sus', label: 'Suspendido' }
      : p.suspWeek ? { cls: 'warn', dot: 'warn', label: 'Susp. esta semana' }
      : p.strikes >= strikeLimit() ? { cls: 'risk', dot: 'risk', label: 'En riesgo' }
      : { cls: '', dot: 'ok', label: 'Activo' };
    const strikesEl = (p) => { const lim = strikeLimit(); const risk = p.strikes >= lim ? 'risk' : ''; let d = '';
      for (let i = 0; i < lim; i++) d += `<i class="${i < p.strikes ? 'f' : ''}"></i>`; return `<span class="strikes ${risk}">${d}</span>`; };
    const SI = '<svg class="pc-icon" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>';

    list.classList.add('pc');
    list.innerHTML = `<div class="md">
      <div class="mdlist">
        <div class="lh"><div class="pc-search">${SI}<input id="pc-q" placeholder="Buscar persona…" autocomplete="off"></div></div>
        <div id="pc-rows"></div>
      </div>
      <div id="pc-detail"></div>
    </div>`;
    const rowsEl = list.querySelector('#pc-rows');
    const detEl = list.querySelector('#pc-detail');

    const rowHtml = (p) => {
      const si = statusInfo(p);
      return `<div class="mrow ${p.id === state._pcSel ? 'on' : ''} ${!p.active ? 'sus' : ''}" data-sel="${p.id}">
        <span class="av" style="background:${colorOf(p)}">${initials(p.name)}</span>
        <div class="nm"><b>${escapeHtml(p.name)}</b><span>${p.role === 'admin' ? 'Administrador' : (p.rest ? 'Descanso: ' + escapeHtml(p.rest) : 'Conductor')}</span></div>
        ${p.role === 'admin'
          ? `<span class="sdot ${si.dot}"></span>`
          : `<span class="mini ${loadCls(p.load.total)}"><i style="width:${Math.min(p.load.total / 5 * 100, 100)}%"></i></span>`}
      </div>`;
    };

    const detailHtml = (p) => {
      if (!p) return '';
      const si = statusInfo(p); const adm = p.role === 'admin'; const L = p.load;
      const nm = escapeAttr(p.name);
      // El bloque de Confiabilidad dice de qué MES habla, y no es adorno: desde la
      // migración 0077 el conteo se reinicia cada mes. Un "2 de 3" pelado se lee
      // como el acumulado de toda la vida del conductor, y con esa lectura el jefe
      // termina suspendiendo a quien ya pagó lo suyo en agosto.
      const lim = strikeLimit();
      const mesActual = Scheduler.monthLabelES(strikePeriod());
      return `<div class="detail">
        <div class="dhead">
          <span class="av" style="background:${colorOf(p)}">${initials(p.name)}</span>
          <div style="flex:1;min-width:0">
            <h2>${escapeHtml(p.name)}</h2><div class="mail">${escapeHtml(p.email || '')}</div>
            <div class="chips">
              <span class="statechip ${si.cls}"><span class="sdot ${si.dot}"></span>${si.label}</span>
              ${p.coord ? '<span class="statechip coord">★ Líder</span>' : ''}
              ${adm && p.alerts ? '<span class="statechip coord">🔔 Alertas</span>' : ''}
              <span class="statechip role">${adm ? 'Administrador' : 'Conductor'}</span>
            </div>
          </div>
        </div>
        <div class="dbody">
          <div class="dblock">
            <h3>Carga de la semana</h3>
            ${adm ? '<p style="font-size:13px;color:var(--pc-ink2)">Los administradores no entran al reparto de turnos.</p>'
              : `<div class="bigload ${loadCls(L.total)}"><span class="num">${L.total}<s>/5</s></span><span class="bar"><i style="width:${Math.min(L.total / 5 * 100, 100)}%"></i></span></div>
                 <div class="breakdown"><div><b>${L.am}</b>AM</div><div><b>${L.pm}</b>PM</div><div><b>${L.co}</b>Coord</div></div>
                 ${!sched ? '<p style="font-size:11px;color:var(--pc-ink3);margin-top:10px">Sin horario guardado esta semana.</p>' : ''}`}
          </div>
          <div class="dblock">
            <h3>Reglas</h3>
            <div class="ruleitem"><span class="t">Puede liderar</span><span class="v">${p.coord ? 'Sí' : 'No'}</span></div>
            <div class="ruleitem"><span class="t">Descanso fijo</span><span class="v ${p.rest ? 'lock' : ''}">${p.rest ? '🔒 ' + escapeHtml(p.rest) : '—'}</span></div>
            ${p.suspWeek ? '<div class="ruleitem"><span class="t">Esta semana</span><span class="v">Suspendido</span></div>' : ''}
          </div>
          <div class="dblock full">
            <h3>Confiabilidad — ${p.strikes} de ${lim} strikes en ${mesActual}</h3>
            ${adm ? '<p style="font-size:13px;color:var(--pc-ink2)">No aplica a administradores.</p>'
              : (p.strikes === 0 ? `<p style="font-size:13px;color:var(--pc-ink2)">Sin strikes en ${mesActual}. Historial limpio.</p>`
                 : `<div style="display:flex;align-items:center;gap:12px">${strikesEl(p)}<span style="font-size:13px;color:var(--pc-ink2)">${p.strikes} de ${lim} activos en ${mesActual}. Al llegar a ${lim} queda suspendido la semana siguiente. Abre el historial para el detalle.</span></div>`)}
          </div>
          ${adm ? '' : `<div class="dblock full">
            <h3>Kilometraje acumulado</h3>
            <div style="display:flex;align-items:baseline;gap:10px">
              <span style="font-size:24px;font-weight:800;color:var(--pc-ink)">${(p.km || 0).toLocaleString('es-CO')}<span style="font-size:13px;font-weight:600;color:var(--pc-ink2)"> km</span></span>
              <span style="font-size:13px;color:var(--pc-ink2)">· ${p.turns || 0} turno(s) cerrado(s)</span>
            </div>
          </div>`}
        </div>
        <div class="dactions">
          <button class="pc-btn ${p.coord ? 'on' : ''}" data-act="${adm ? (p.coord ? 'coord-off' : 'coord-on') : (p.coord ? 'dcoord-off' : 'dcoord-on')}" data-id="${p.id}" data-name="${nm}">${p.coord ? '✓ Lidera' : '✕ No lidera'}</button>
          ${adm ? `<button class="pc-btn ${p.alerts ? 'on' : ''}" data-act="${p.alerts ? 'alerts-off' : 'alerts-on'}" data-id="${p.id}" data-name="${nm}" title="Recibe en su celular las eventualidades de la operación (falla mecánica, botón rojo, carro atrasado)">${p.alerts ? '🔔 Recibe alertas' : '🔕 Sin alertas'}</button>` : ''}
          ${adm ? '' : `<button class="pc-btn" data-act="strike" data-id="${p.id}" data-name="${nm}">⚠ Strike</button>
          <button class="pc-btn" data-act="strikes-history" data-id="${p.id}" data-name="${nm}">Historial</button>
          ${p.suspWeek ? `<button class="pc-btn" data-act="lift-susp" data-id="${p.id}" data-name="${nm}" data-susp-id="${p.suspRow ? p.suspRow.id : ''}">✓ Levantar suspensión</button>` : ''}
          <div class="spacer"></div>
          <button class="pc-btn" data-act="${p.active ? 'suspend' : 'reactivate'}" data-id="${p.id}" data-name="${nm}">${p.active ? 'Suspender' : 'Reactivar'}</button>
          <button class="pc-btn danger" data-act="delete" data-id="${p.id}" data-name="${nm}">Eliminar</button>`}
        </div>
      </div>`;
    };

    const paint = () => {
      const q = (list.querySelector('#pc-q')?.value || '').toLowerCase().trim();
      const match = (p) => !q || p.name.toLowerCase().includes(q) || (p.email || '').toLowerCase().includes(q);
      const adminRows = people.filter(p => p.role === 'admin' && match(p)).map(rowHtml).join('');
      const drvRows = people.filter(p => p.role === 'driver' && match(p)).map(rowHtml).join('');
      rowsEl.innerHTML =
        ((adminRows ? `<div class="pc-secth">Administradores</div>${adminRows}` : '') +
         (drvRows ? `<div class="pc-secth">Conductores</div>${drvRows}` : '')) ||
        '<div style="padding:16px;color:var(--pc-ink3);font-size:13px">Sin coincidencias.</div>';
      detEl.innerHTML = detailHtml(people.find(p => p.id === state._pcSel));
      detEl.querySelectorAll('button[data-act]').forEach(btn => btn.addEventListener('click', () => onWorkerAction(btn)));
    };

    rowsEl.addEventListener('click', (e) => {
      const r = e.target.closest('[data-sel]'); if (!r) return;
      state._pcSel = r.dataset.sel; paint();
    });
    list.querySelector('#pc-q').addEventListener('input', paint);
    paint();
  }

  async function onWorkerAction(btn) {
    const id = btn.dataset.id;
    const name = btn.dataset.name;
    const act = btn.dataset.act;

    // --- Strikes (Fase 2) ---
    if (act === 'strike') {
      const reason = prompt(`Razón del strike para ${name} (queda en el historial):`, '');
      if (reason === null) return;
      if (!reason.trim()) { toast('El strike necesita una razón.'); return; }
      btn.disabled = true;
      try {
        const lim = strikeLimit();
        const mes = Scheduler.monthLabelES(strikePeriod());
        const before = state._strikeCounts?.get(id) || 0;
        await Api.addStrike({ profileId: id, reason: reason.trim(), weekStart: state.currentWeek, createdBy: state.profile.id });
        // OJO, son DOS relojes distintos y es fácil confundirlos al escribir estos
        // textos: los strikes se CUENTAN por mes (al pasar a octubre el contador
        // vuelve a cero), pero la suspensión que dispara el último sigue siendo de
        // UNA SEMANA. "Acumulaste 3 este mes: quedas por fuera la semana siguiente"
        // es lo correcto. Lo que decía antes —"3 strikes", a secas, sin ventana—
        // era la versión vieja, cuando el contador no se reiniciaba nunca.
        const llegoAlTope = before + 1 >= lim;
        notify([id], llegoAlTope ? 'Suspendido la próxima semana' : 'Recibiste un strike',
          llegoAlTope ? `Acumulaste ${lim} strikes en ${mes}: quedas suspendido la próxima semana.` : `Motivo: ${reason.trim()}`, '/');
        await renderWorkers();
        // Si era el último, el trigger ya creó la suspensión de la próxima semana.
        if (llegoAlTope) {
          alert(`⚠ ${name} llegó a ${lim} strikes en ${mes}. Quedó SUSPENDIDO automáticamente la semana siguiente. Esos strikes quedan consumidos y el conteo del mes vuelve a empezar.`);
        } else {
          toast(`Strike registrado (${before + 1} de ${lim} en ${mes}).`);
        }
      } catch (e) {
        alert('Error al registrar el strike: ' + e.message);
        btn.disabled = false;
      }
      return;
    }
    if (act === 'strikes-history') {
      btn.disabled = true;
      try {
        const strikes = await Api.listDriverStrikes(id);
        openStrikesModal(name, id, strikes);
      } catch (e) {
        alert('Error al cargar el historial: ' + e.message);
      }
      btn.disabled = false;
      return;
    }
    // Levantar la suspensión SEMANAL (la que arma el último strike del mes o una
    // manual). Aquí no se toca nada del conteo mensual: son cosas distintas.
    // Quitar la suspensión de esta semana no le devuelve el mes limpio a nadie.
    if (act === 'lift-susp') {
      const suspId = btn.dataset.suspId;
      if (!suspId) { toast('No encuentro la suspensión de esta semana.'); return; }
      if (!confirm(`¿Levantar la suspensión de esta semana de ${name}? Volverá a entrar en la generación de turnos y podrá operar.`)) return;
      btn.disabled = true;
      try {
        await Api.liftSuspension(suspId, state.profile.id);
        notify([id], 'Suspensión levantada', 'Tu suspensión de esta semana fue levantada. Ya puedes operar normalmente.', '/');
        await renderWorkers();
        toast('Suspensión levantada.');
      } catch (e) {
        alert('Error al levantar la suspensión: ' + e.message);
        btn.disabled = false;
      }
      return;
    }

    if (act === 'delete' && !confirm(`¿Eliminar a ${name}? Desaparece del sistema y de la generación. Los horarios pasados donde aparece NO se borran.`)) return;
    if (act === 'suspend' && !confirm(`¿Suspender a ${name}? Saldrá de la generación de horarios hasta que lo reactives.`)) return;
    btn.disabled = true;
    const msg = {
      suspend: 'Conductor suspendido.', reactivate: 'Conductor reactivado.',
      delete: 'Conductor eliminado.',
      'coord-off': `${name} ya no entra como Líder de turno.`, 'coord-on': `${name} ahora entra como Líder de turno.`,
      'dcoord-off': `${name} ya no entra como Líder de turno.`, 'dcoord-on': `${name} ahora puede liderar.`,
      'alerts-on': `${name} recibirá las eventualidades en su celular.`,
      'alerts-off': `${name} ya no recibirá eventualidades.`,
    };
    try {
      if (act === 'suspend') await Api.setProfileActive(id, false);
      else if (act === 'reactivate') await Api.setProfileActive(id, true);
      else if (act === 'delete') await Api.softDeleteProfile(id);
      else if (act === 'coord-off') await Api.setAdminCoordinator(id, false);
      else if (act === 'coord-on') await Api.setAdminCoordinator(id, true);
      else if (act === 'dcoord-off') await Api.setDriverCanCoordinate(id, false);
      else if (act === 'dcoord-on') await Api.setDriverCanCoordinate(id, true);
      else if (act === 'alerts-off') await Api.setOpsAlerts(id, false);
      else if (act === 'alerts-on') await Api.setOpsAlerts(id, true);
      state.drivers = await Api.listDrivers();
      state.admins = (await Api.listAdmins()).map(a => ({ id: a.id, name: a.full_name, email: a.email, is_coordinator: a.is_coordinator !== false, receives_ops_alerts: a.receives_ops_alerts === true }));
      await renderWorkers();
      toast(msg[act] || 'Hecho.');
    } catch (e) {
      alert('Error: ' + e.message);
      btn.disabled = false;
    }
  }

  // Modal de historial de strikes (inyectado al vuelo).
  // El historial es de TODA la vida del conductor, pero lo que pesa hoy es lo del
  // mes en curso. Por eso va agrupado por mes, con el mes de hoy arriba: lo de
  // septiembre decide si se suspende, lo de agosto ya es memoria.
  function openStrikesModal(name, profileId, strikes) {
    document.getElementById('strikes-modal')?.remove();
    const fmt = iso => { try { return new Date(iso).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' }); } catch { return iso; } };
    const lim = strikeLimit();
    const mesActual = strikePeriod();
    // A qué mes pertenece cada strike. period_start llega con la migración 0077;
    // mientras no esté aplicada se deduce del created_at, que es exactamente lo
    // que la migración hace con los strikes viejos — así el historial se ve igual
    // antes y después de aplicarla. Se pasa como Date y NO como texto: created_at
    // es una marca de tiempo completa (con hora y zona) y monthStartISO solo le
    // pega 'T00:00:00' a las fechas sueltas.
    // Son DOS preguntas distintas y confundirlas descuadra la pantalla:
    //
    //   mesDe()       -> ¿de qué mes lo MUESTRO? Para el encabezado del grupo y
    //                    la etiqueta. Aquí el created_at sí sirve de respaldo:
    //                    es la misma fecha con la que 0077 etiqueta a los viejos.
    //
    //   mesContable() -> ¿a qué mes PERTENECE para CONTARLO? Solo period_start.
    //                    Si no viene (la migración todavía no ha corrido) la
    //                    respuesta honesta es "no se sabe", y entonces cuenta
    //                    como de este mes — que es exactamente lo que hacen
    //                    api.js y la pantalla del conductor en ese mismo caso.
    //
    // Mezclarlas era pintar dos números distintos de la misma persona: el badge
    // de la ficha decía 2 (porque sin migración api.js suma todo lo vivo) y este
    // modal, abierto desde ESA misma ficha, decía 1 y marcaba el otro "Expirado".
    // Y el peor efecto no era el número: al anular, el aviso afirmaba "hoy no
    // cuenta para la suspensión" sobre un strike que el trigger sí estaba sumando.
    const mesDe = s => s.period_start
      ? Scheduler.monthStartISO(s.period_start)
      : Scheduler.monthStartISO(new Date(s.created_at));
    const mesContable = s => s.period_start ? Scheduler.monthStartISO(s.period_start) : mesActual;
    const expirado = s => !s.voided_at && !s.consumed_at && mesContable(s) < mesActual;
    // Cuatro estados, no tres. El que faltaba es 'Expirado': un strike que nadie
    // anuló y que no costó suspensión, pero que es de un mes ya cerrado y hoy no
    // cuenta para nada. No es lo mismo que 'Anulado' (alguien se lo perdonó a
    // mano) ni que 'Consumido' (ese sí costó una semana por fuera), y el conductor
    // tiene derecho a ver la diferencia el día que venga a reclamar.
    const statusOf = s => s.voided_at ? '<span class="strike-tag strike-tag-void">Anulado</span>'
      : s.consumed_at ? '<span class="strike-tag strike-tag-consumed">Consumido</span>'
      : expirado(s) ? '<span class="strike-tag strike-tag-expired">Expirado</span>'
      : '<span class="strike-tag strike-tag-active">Activo</span>';
    // La semana sigue en la línea: el conteo es mensual, pero la suspensión que
    // sale de él es semanal y el jefe necesita saber de cuál semana se habla.
    const itemHtml = s => `
      <div class="strike-item">
        <div class="strike-item-main">
          <p class="strike-item-reason">${escapeHtml(s.reason)}</p>
          <p class="strike-item-meta">${fmt(s.created_at)} · semana ${s.week_start_date}</p>
        </div>
        <div class="strike-item-side">
          ${statusOf(s)}
          ${!s.voided_at ? `<button data-void-id="${s.id}" data-consumed="${s.consumed_at ? '1' : ''}" data-expired="${expirado(s) ? '1' : ''}" class="wk-btn wk-strike-void">Anular</button>` : ''}
        </div>
      </div>`;
    // Agrupado por mes, el actual arriba. Las llaves son ISO 'AAAA-MM-01', así que
    // ordenarlas como texto ya las ordena por fecha: no hace falta parsear nada.
    const porMes = new Map();
    strikes.forEach(s => {
      const m = mesDe(s);
      if (!porMes.has(m)) porMes.set(m, []);
      porMes.get(m).push(s);
    });
    const meses = [...porMes.keys()].sort().reverse();
    const rows = meses.length ? meses.map(m => {
      const items = porMes.get(m);
      const vivos = items.filter(s => !s.voided_at && !s.consumed_at).length;
      // En el mes en curso el número que importa es cuántos van contra el tope.
      // En los meses cerrados eso ya no significa nada: ahí se dice cuántos hubo.
      const detalle = m === mesActual
        ? `${vivos} de ${lim} activos`
        : `${items.length} strike${items.length > 1 ? 's' : ''}`;
      return `<p class="strike-month">${Scheduler.monthLabelES(m)}<span>${detalle}</span></p>` + items.map(itemHtml).join('');
    }).join('') : '<p class="text-sm text-slate-500">Sin strikes registrados.</p>';
    // El número de arriba cuenta SOLO el mes en curso, que es el que decide la
    // suspensión. Antes contaba todo lo vivo desde el principio de los tiempos
    // —el contador no se reiniciaba nunca— y ese era el bug de fondo: un conductor
    // con un strike en marzo y otro en julio aparecía a uno de quedar suspendido.
    const active = strikes.filter(s => !s.voided_at && !s.consumed_at && mesContable(s) === mesActual).length;
    const overlay = document.createElement('div');
    overlay.id = 'strikes-modal';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-card">
        <div class="modal-head">
          <h3 class="modal-title">Strikes — ${escapeHtml(name)}</h3>
          <p class="modal-subtitle">Activos en ${Scheduler.monthLabelES(mesActual)}: <strong>${active} de ${lim}</strong></p>
        </div>
        <div class="strikes-list">${rows}</div>
        <div class="modal-actions">
          <button id="strikes-modal-close" class="wk-btn">Cerrar</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#strikes-modal-close').addEventListener('click', () => overlay.remove());
    overlay.querySelectorAll('[data-void-id]').forEach(b => {
      b.addEventListener('click', async () => {
        const consumed = b.dataset.consumed === '1';
        const isExpired = b.dataset.expired === '1';
        const msg = consumed
          ? '¿Anular este strike YA consumido? Queda marcado en el historial, pero esto NO levanta una suspensión ya aplicada. Para desbloquear al conductor usa “Levantar suspensión” en su ficha.'
          // Uno expirado ya no cuenta contra nadie: anularlo no cambia el número de
          // este mes. Decir "no contará para la suspensión" ahí sería prometer algo
          // que ya pasó solo, y el jefe creería que le hizo un favor al conductor.
          : isExpired
          ? '¿Anular este strike? Es de un mes ya cerrado: hoy no cuenta para la suspensión. Anularlo solo cambia cómo queda en el historial.'
          : '¿Anular este strike? No contará para la suspensión de este mes (queda en historial).';
        if (!confirm(msg)) return;
        b.disabled = true;
        try {
          await Api.voidStrike(b.dataset.voidId, state.profile.id);
          overlay.remove();
          await renderWorkers();
          toast('Strike anulado.');
        } catch (e) { alert('Error: ' + e.message); b.disabled = false; }
      });
    });
  }

  // ════════════════════════════════════════════════════════════════════
  // AJUSTES, PARTIDO EN TRES (2026-09-11)
  //
  // renderSettings pintaba 39 controles de dos mundos que no se hablan y, de
  // paso, disparaba cuatro consultas: la tabla de tiempos, las zonas, la flota y
  // el desplegable de la camioneta. El jefe entraba a subir el límite de strikes
  // y pagaba las cuatro. Ahora cada pantalla pinta y pide LO SUYO:
  //
  //   renderSettings    → Turnos › Configuración › Ajustes      (13 del turno)
  //   renderCalibracion → Rutas  › Configuración › Calibración  (26 del optimizador)
  //   renderFlota       → Turnos › Revisión › Flota             (los carros)
  //
  // Los ids de los inputs NO cambiaron: el markup se mudó de sección con cortar y
  // pegar y acá se sigue buscando por id.
  //
  // 2026-09-12: el día de los archivos sueltos llegó y el corte estaba donde
  // decía. renderCalibracion se fue con su guardado a admin-calibracion.js y
  // renderFlota a admin-flota.js; acá solo quedó renderSettings. Las tres se
  // siguen llamando desde setTab (core.js) igual que antes: cambió el archivo,
  // no el scope.
  // ════════════════════════════════════════════════════════════════════

  // Turnos › Configuración › Ajustes — jornadas, cupos, strikes e inicio rápido.
  // Cero consultas: todo sale de state.settings, que ya está en memoria.
  function renderSettings() {
    const S = state.settings;
    $('#setting-morning-label').value = S.morning_label;
    $('#setting-afternoon-label').value = S.afternoon_label;
    $('#setting-morning-slots').value = S.morning_slots;
    $('#setting-afternoon-slots').value = S.afternoon_slots;
    if ($('#setting-coord-slots')) $('#setting-coord-slots').value = S.coord_slots != null ? S.coord_slots : 1;
    if ($('#setting-shift-hours')) $('#setting-shift-hours').value = S.shift_hours != null ? S.shift_hours : 12;
    if ($('#setting-auto-close-hours')) $('#setting-auto-close-hours').value = S.auto_close_hours != null ? S.auto_close_hours : 14;
    if ($('#setting-reservation-idle')) $('#setting-reservation-idle').value = S.reservation_idle_minutes != null ? S.reservation_idle_minutes : 60;
    if ($('#setting-strike-limit')) $('#setting-strike-limit').value = S.strike_limit != null ? S.strike_limit : 3;
    if ($('#setting-fast-start-enabled')) $('#setting-fast-start-enabled').checked = S.fast_start_enabled !== false;
    if ($('#setting-fast-start-from')) $('#setting-fast-start-from').value = S.fast_start_from_hour != null ? S.fast_start_from_hour : 12;
    if ($('#setting-fast-start-to')) $('#setting-fast-start-to').value = S.fast_start_to_hour != null ? S.fast_start_to_hour : 16;
    if ($('#setting-inspection-grace')) $('#setting-inspection-grace').value = S.inspection_grace_minutes != null ? S.inspection_grace_minutes : 90;
    renderPriorityList();
    renderRulesEditor();
    setPrepararBloque('turno');
  }

  // ════════════════════════════════════════════════════════════════════
  // GUARDADO HONESTO (2026-09-11)
  //
  // El acordeón abrió un hueco: con las secciones plegadas se puede editar un
  // campo, cerrar la sección y salir creyendo que quedó guardado — acá nada se
  // guarda solo. Tres piezas lo tapan, y las tres ya tenían CSS escrito:
  //
  //   .set-sec-dot   punto naranja en el summary, visible AUNQUE esté cerrada.
  //   .set-sec-val   con la sección cerrada, el valor actual de sus campos, para
  //                  barrer el acordeón leyendo números sin abrir nada.
  //   .set-savebar   el botón pegado al pie, diciendo cuántos campos cubre.
  //
  // Lo sucio se escucha en la TARJETA entera (data-bloque), no en los <details>:
  // en Ajustes hay nueve campos fuera de toda sección plegable y son la mitad de
  // la pantalla. Escuchando solo los <details>, esa mitad no avisaría nada.
  // ════════════════════════════════════════════════════════════════════
  const SET_BLOQUES = {
    turno: { tab: 'settings',    nombre: 'Ajustes del turno',          chip: '#set-saved-params', toast: 'Ajustes del turno guardados.' },
    calib: { tab: 'calibracion', nombre: 'Calibración del optimizador', chip: '#set-saved-calib',  toast: 'Calibración guardada.' },
  };
  // Vive en JS y no en el DOM porque hay que poder preguntarlo desde setTab
  // (core.js) cuando el jefe ya va saliendo del módulo.
  const setBloquesSucios = new Set();

  function setTarjetaDe(clave) { return document.querySelector(`.set-card[data-bloque="${clave}"]`); }
  function setCamposDe(card) { return card.querySelectorAll('input, select, textarea'); }

  // El valor que se muestra en la pastilla de una sección cerrada. Corto a
  // propósito: es para barrer con la vista, no para leerlo con lupa.
  function setValorCorto(el) {
    if (!el) return '';
    if (el.type === 'checkbox') return el.checked ? 'sí' : 'no';
    if (el.tagName === 'SELECT') {
      const o = el.options[el.selectedIndex];
      const t = (o ? o.textContent : '').trim();
      return !t ? '—' : (t.length > 18 ? t.slice(0, 17) + '…' : t);
    }
    const v = String(el.value == null ? '' : el.value).trim();
    return v === '' ? '—' : v;
  }

  function setPintarValores(card) {
    card.querySelectorAll('.set-sec[data-secval]').forEach(sec => {
      const pastilla = sec.querySelector('.set-sec-val');
      if (!pastilla) return;
      pastilla.textContent = sec.dataset.secval.split(',')
        .map(id => setValorCorto(document.getElementById(id.trim())))
        .filter(Boolean).join(' · ');
    });
  }

  // Repinta las pastillas de un bloque desde afuera. Lo usa fillPrivateVehicles,
  // que llega tarde (es una consulta) y cambia el texto del desplegable.
  function setRepintarValores(clave) {
    const card = setTarjetaDe(clave);
    if (card) setPintarValores(card);
  }

  function setPintarBarra(clave) {
    const card = setTarjetaDe(clave);
    if (!card) return;
    const nota = card.querySelector('.set-savebar .set-savenote');
    if (!nota) return;
    const n = setCamposDe(card).length;
    nota.innerHTML = setBloquesSucios.has(clave)
      ? `<b>Hay cambios sin guardar.</b> Este botón manda los ${n} campos de esta pantalla, abiertos o plegados.`
      : `Manda los ${n} campos de esta pantalla, abiertos o plegados.`;
  }

  function setBloqueLimpio(clave) {
    setBloquesSucios.delete(clave);
    const card = setTarjetaDe(clave);
    if (!card) return;
    card.querySelectorAll('.set-sec.sucio').forEach(s => s.classList.remove('sucio'));
    setPintarValores(card);
    setPintarBarra(clave);
  }

  // Un solo par de oyentes por tarjeta, delegados. 'input' agarra lo que se
  // escribe; 'change' los checkbox y los desplegables, que en algunos navegadores
  // no disparan 'input'. Pintar el valor en cada tecla es barato (son ocho
  // pastillas) y evita depender de 'toggle', que en <details> no burbujea.
  function setEngancharBloque(clave) {
    const card = setTarjetaDe(clave);
    if (!card || card.dataset.enganchado === '1') return;
    card.dataset.enganchado = '1';
    const oido = (e) => {
      if (!e.target.matches('input, select, textarea')) return;
      setBloquesSucios.add(clave);
      const sec = e.target.closest('.set-sec');
      if (sec) sec.classList.add('sucio');
      setPintarValores(card);
      setPintarBarra(clave);
    };
    card.addEventListener('input', oido);
    card.addEventListener('change', oido);
  }

  // Se llama al final de cada render: los valores acaban de venir de la base, así
  // que nada está sucio. Poner .value a mano NO dispara 'input', o sea que este
  // repintado no se marca solo como cambio del jefe.
  function setPrepararBloque(clave) {
    setEngancharBloque(clave);
    setBloqueLimpio(clave);
  }

  // La puerta de salida que consulta setTab (core.js). Devuelve false para
  // quedarse. Si el jefe decide irse, se limpia el sucio: se va sabiendo, y al
  // volver el render repinta desde la base de todas formas.
  function setPuedeSalirDelModulo(destino) {
    const clave = Object.keys(SET_BLOQUES).find(k => SET_BLOQUES[k].tab === state.activeTab);
    if (!clave || destino === state.activeTab) return true;
    if (!setBloquesSucios.has(clave)) return true;
    const ok = confirm(`Quedan cambios sin guardar en ${SET_BLOQUES[clave].nombre}.\n\n`
      + 'Acá nada se guarda solo: si sales ahora, lo que cambiaste se pierde.\n\n'
      + '¿Salir de todas formas?');
    if (ok) setBloqueLimpio(clave);
    return ok;
  }

  // --- Editor de parametrización: descansos fijos por conductor (Fase 4) ---
  // Pinta sobre los elementos estáticos del panel de Ajustes (paleta limpia):
  // <select #rules-driver-select> + grilla <div #rules-grid>.
  function renderRulesEditor() {
    const sel = $('#rules-driver-select');
    const grid = $('#rules-grid');
    if (!sel || !grid) return;
    const drivers = [...state.drivers].sort((a, b) => a.name.localeCompare(b.name));
    if (!drivers.length) {
      sel.innerHTML = '';
      grid.innerHTML = '<p class="set-hint">No hay conductores activos.</p>';
      return;
    }
    if (!state._rulesDriverId || !drivers.some(d => d.id === state._rulesDriverId)) {
      state._rulesDriverId = drivers[0].id;
    }
    const cur = state._rulesDriverId;

    sel.innerHTML = drivers.map(d => `<option value="${d.id}"${d.id === cur ? ' selected' : ''}>${escapeHtml(d.name)}</option>`).join('');
    sel.onchange = (e) => { state._rulesDriverId = e.target.value; renderRulesEditor(); };

    const rulesFor = new Set((state.rules || [])
      .filter(r => r.profile_id === cur)
      .map(r => `${r.day_of_week}-${r.shift}`));
    grid.innerHTML = Scheduler.DAYS.map((dayKey, di) => {
      const label = Scheduler.DAY_LABELS_ES[dayKey];
      const wknd = di >= 5 ? ' wknd' : '';
      const cell = (shift) => {
        const on = rulesFor.has(`${di}-${shift}`);
        const lock = on ? '<svg class="icon"><use href="#i-lock"/></svg>' : '';
        return `<button class="set-tg${on ? ' on' : ''}" data-rule-day="${di}" data-rule-shift="${shift}">${lock}${shift.toUpperCase()}</button>`;
      };
      return `<div class="set-drow${wknd}"><span class="set-dname">${label}</span><div class="set-twin">${cell('am')}${cell('pm')}</div></div>`;
    }).join('');

    grid.querySelectorAll('.set-tg').forEach(b => {
      b.addEventListener('click', () => onToggleRule(cur, parseInt(b.dataset.ruleDay, 10), b.dataset.ruleShift, b));
    });
  }

  async function onToggleRule(profileId, dayOfWeek, shift, btn) {
    const wasOn = btn.classList.contains('on');
    btn.disabled = true;
    try {
      if (wasOn) await Api.deleteDriverRule({ profileId, dayOfWeek, shift });
      else await Api.addDriverRule({ profileId, dayOfWeek, shift, createdBy: state.profile.id });
      await loadRules();          // recarga state.rules + Scheduler.setRules
      renderRulesEditor();
      // Si la consolidada está visible, refrescarla para reflejar el cambio.
      if (state.activeTab === 'availability') refreshAvailabilityMatrix();
      toast(wasOn ? 'Bloqueo quitado.' : 'Bloqueo agregado.');
    } catch (e) {
      alert('Error al guardar la regla: ' + e.message);
      btn.disabled = false;
    }
  }

  // Prioridad por antigüedad. 1=nuevo, 2=con tiempo, 3=antiguo (desempate SUAVE);
  // 4=máxima (Julián): prioridad DURA, entra siempre primero (ver scheduler.js).
  const SR_LABELS = { 1: 'Nuevo', 2: 'Con tiempo', 3: 'Antiguo', 4: 'Máxima' };
  function renderPriorityList() {
    const box = $('#priority-list');
    if (!box) return;
    const drivers = [...state.drivers].sort((a, b) => a.name.localeCompare(b.name));
    if (!drivers.length) {
      box.innerHTML = '<p class="set-hint">No hay conductores activos.</p>';
      return;
    }
    box.innerHTML = drivers.map(d => {
      const p = d.priority || 1;
      const segs = [1, 2, 3, 4].map(n =>
        `<button data-srval="${n}" class="${p === n ? 'on s' + n : ''}"><span class="num">${n}</span>${p === n ? SR_LABELS[n] : ''}</button>`
      ).join('');
      return `<div class="set-prow">
        <span class="set-avt" style="background:${colorOfId(d.id)}">${escapeHtml(initialsOf(d.name))}</span>
        <div class="set-pinfo"><b>${escapeHtml(d.name)}</b><span>${escapeHtml(d.email || '')}</span></div>
        <div class="set-seg3" data-prio-id="${d.id}">${segs}</div>
      </div>`;
    }).join('');
    box.querySelectorAll('.set-seg3').forEach(seg => {
      seg.querySelectorAll('button[data-srval]').forEach(btn => {
        btn.addEventListener('click', () => onChangePriority(seg.dataset.prioId, parseInt(btn.dataset.srval, 10)));
      });
    });
  }

  async function onChangePriority(id, rawValue) {
    const value = parseInt(rawValue, 10) || 1;
    const d = state.drivers.find(x => x.id === id);
    if (d && d.priority === value) return;            // ya está en ese valor
    const seg = document.querySelector(`.set-seg3[data-prio-id="${id}"]`);
    if (seg) seg.querySelectorAll('button').forEach(b => (b.disabled = true));
    try {
      await Api.setDriverPriority(id, value);
      if (d) d.priority = value;
      renderPriorityList();
      toast('Prioridad actualizada.');
    } catch (e) {
      alert('Error al guardar prioridad: ' + e.message);
      renderPriorityList();
    }
  }

  // --- Crear conductor, ahora desde Personal (antes vivía en Ajustes) ---
  // Caracteres seguros (sin O/0, l/I/1) para que el conductor no se confunda
  // al teclear la contraseña.
  function generateReadablePassword(len = 10) {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    let out = '';
    const arr = new Uint32Array(len);
    crypto.getRandomValues(arr);
    for (let i = 0; i < len; i++) out += chars[arr[i] % chars.length];
    return out;
  }

  function onGenerateDriverPassword() {
    $('#new-driver-password').value = generateReadablePassword(10);
  }

  async function onCreateDriver() {
    const btn = $('#new-driver-create-btn');
    const stateEl = $('#new-driver-state');
    const name = $('#new-driver-name').value.trim();
    const email = $('#new-driver-email').value.trim().toLowerCase();
    const password = $('#new-driver-password').value;
    const priority = parseInt($('#new-driver-priority').value, 10) || 1;
    const canCoord = $('#new-driver-can-coord').checked;
    // Opcional, pero sin él el botón de llamar de la app queda muerto.
    const phone = ($('#new-driver-phone')?.value || '').trim().replace(/[^\d+]/g, '');

    const setState = (text, tone) => {
      stateEl.textContent = text;
      stateEl.className = {
        ok: 'text-xs text-emerald-700 font-semibold',
        err: 'text-xs text-rose-600 font-semibold',
        info: 'text-xs text-slate-500',
      }[tone] || 'text-xs text-slate-500';
    };

    if (!name) { setState('Falta el nombre completo.', 'err'); return; }
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { setState('Email inválido.', 'err'); return; }
    if (!password || password.length < 8) { setState('Contraseña mínimo 8 caracteres.', 'err'); return; }

    btn.disabled = true;
    btn.textContent = 'Creando…';
    setState('Creando cuenta en Supabase…', 'info');
    try {
      const created = await Api.createDriver({
        email, password, full_name: name, phone,
        priority, can_coordinate: canCoord,
      });
      // Refresca la lista de conductores en memoria para que aparezca al instante.
      state.drivers = await Api.listDrivers();
      // Mensaje copiable con las credenciales.
      const credLine = `${email} / ${password}`;
      setState(`✓ Creado. Credenciales: ${credLine}`, 'ok');
      toast(`Conductor "${name}" creado. Pásale: ${credLine}`);
      // Limpia el form (deja el toast/cred visible).
      $('#new-driver-name').value = '';
      $('#new-driver-email').value = '';
      if ($('#new-driver-phone')) $('#new-driver-phone').value = '';
      $('#new-driver-password').value = '';
      $('#new-driver-priority').value = '1';
      $('#new-driver-can-coord').checked = false;
      // Si está la vista Personal abierta, también refrescarla.
      if (state.activeTab === 'workers') await renderWorkers();
      renderPriorityList();
    } catch (e) {
      setState(`✗ ${e.message || 'Error creando conductor'}`, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Crear conductor';
    }
  }

  // GUARDAR LO MÍO SIN PISAR LO DEL VECINO.
  //
  // Api.saveSettings escribe SIEMPRE las 40 columnas: es una cascada fija que va
  // bajando escalones si a la base le falta una migración. No sabe de guardados
  // parciales. Si Calibración le mandara solo sus 27 columnas, las 13 del turno
  // irían en `undefined` y quedaríamos colgados de que JSON.stringify las bote —
  // un detalle de la librería, no una promesa que alguien nos haya hecho.
  //
  // Por eso cada pantalla manda el objeto COMPLETO: lo que ya está guardado, con
  // sus campos encima. Lo de la otra pantalla viaja igualito a como estaba.
  async function setGuardarBloque(clave, cambios, aviso) {
    const card = setTarjetaDe(clave);
    const btn = card && card.querySelector('.set-savebar .set-btn');
    if (btn) btn.disabled = true;
    try {
      const next = { ...state.settings, ...cambios };
      await Api.saveSettings(next);
      state.settings = next;
      setBloqueLimpio(clave);
      const chip = $(SET_BLOQUES[clave].chip);
      if (chip) { chip.classList.add('show'); setTimeout(() => chip.classList.remove('show'), 1800); }
      toast(SET_BLOQUES[clave].toast);
      if (aviso) alert(aviso);
    } catch (e) {
      alert('Error al guardar ajustes: ' + (e.message || e));
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // Turnos › Configuración › Ajustes — los 13 del turno del conductor.
  async function onSaveSettings() {
    await setGuardarBloque('turno', {
      morning_label: $('#setting-morning-label').value,
      afternoon_label: $('#setting-afternoon-label').value,
      morning_slots: Math.max(1, parseInt($('#setting-morning-slots').value, 10) || 2),
      afternoon_slots: Math.max(1, parseInt($('#setting-afternoon-slots').value, 10) || 2),
      coord_slots: Math.max(1, parseInt($('#setting-coord-slots') && $('#setting-coord-slots').value, 10) || 1),
      shift_hours: Math.max(1, parseInt($('#setting-shift-hours') && $('#setting-shift-hours').value, 10) || 12),
      auto_close_hours: Math.min(72, Math.max(1, parseInt($('#setting-auto-close-hours') && $('#setting-auto-close-hours').value, 10) || 14)),
      reservation_idle_minutes: Math.min(240, Math.max(5, parseInt($('#setting-reservation-idle') && $('#setting-reservation-idle').value, 10) || 60)),
      strike_limit: Math.min(10, Math.max(1, parseInt($('#setting-strike-limit') && $('#setting-strike-limit').value, 10) || 3)),
      fast_start_enabled: !!($('#setting-fast-start-enabled') && $('#setting-fast-start-enabled').checked),
      fast_start_from_hour: Math.min(23, Math.max(0, parseInt($('#setting-fast-start-from') && $('#setting-fast-start-from').value, 10) || 12)),
      fast_start_to_hour: Math.min(24, Math.max(1, parseInt($('#setting-fast-start-to') && $('#setting-fast-start-to').value, 10) || 16)),
      inspection_grace_minutes: Math.min(480, Math.max(15, parseInt($('#setting-inspection-grace') && $('#setting-inspection-grace').value, 10) || 90)),
    });
  }
