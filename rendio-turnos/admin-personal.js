// admin-personal.js — Admin: personal (workers) + ajustes/reglas.
// Extraído de app.js (split mecánico 2026-07-10, sin cambios de lógica).
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
  // pegar y acá se sigue buscando por id. Si algún día esto se parte en archivos
  // sueltos, el corte ya está hecho: son estas tres funciones con sus guardados.
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

  // Rutas › Configuración › Calibración — los 26 del optimizador, más la tabla de
  // tiempos y las zonas, que son la otra mitad del mismo cálculo.
  function renderCalibracion() {
    const S = state.settings;
    if ($('#setting-aux-wait')) $('#setting-aux-wait').value = S.aux_wait_minutes != null ? S.aux_wait_minutes : 5;
    if ($('#setting-aux-lead')) $('#setting-aux-lead').value = S.aux_min_lead_hours != null ? S.aux_min_lead_hours : 6;
    // 0069 · traslado privado. El desplegable de vehículos se llena aparte
    // (es una consulta), pero el valor se deja puesto para que al llegar la
    // lista quede seleccionado el que ya estaba.
    if ($('#setting-priv-enabled')) $('#setting-priv-enabled').checked = S.aux_private_enabled === true;
    if ($('#setting-priv-price')) $('#setting-priv-price').value = S.aux_private_price_cop != null ? S.aux_private_price_cop : 150000;
    if ($('#setting-priv-block')) $('#setting-priv-block').value = S.aux_private_block_min != null ? S.aux_private_block_min : 90;
    if ($('#setting-route-merge')) $('#setting-route-merge').value = S.route_merge_window_min != null ? S.route_merge_window_min : 30;
    if ($('#setting-route-service')) $('#setting-route-service').value = S.route_service_min != null ? S.route_service_min : 3;
    if ($('#setting-route-traffic')) $('#setting-route-traffic').value = S.route_traffic_factor != null ? S.route_traffic_factor : 1.05;
    if ($('#setting-route-buffer')) $('#setting-route-buffer').value = S.route_airport_buffer_min != null ? S.route_airport_buffer_min : 10;
    if ($('#setting-route-aero')) $('#setting-route-aero').value = S.route_airport_factor != null ? S.route_airport_factor : 0.8;
    if ($('#setting-route-wait')) $('#setting-route-wait').value = S.route_max_wait_min != null ? S.route_max_wait_min : 0;
    if ($('#setting-route-wait-peak')) $('#setting-route-wait-peak').value = S.route_max_wait_peak_min != null ? S.route_max_wait_peak_min : 0;
    // Desembarque por aerolínea (0058).
    if ($('#setting-deplane-av-nac')) $('#setting-deplane-av-nac').value = S.route_deplane_av_nac_min != null ? S.route_deplane_av_nac_min : 15;
    if ($('#setting-deplane-av-int')) $('#setting-deplane-av-int').value = S.route_deplane_av_int_min != null ? S.route_deplane_av_int_min : 20;
    if ($('#setting-deplane-js-nac')) $('#setting-deplane-js-nac').value = S.route_deplane_js_nac_min != null ? S.route_deplane_js_nac_min : 25;
    if ($('#setting-deplane-js-int')) $('#setting-deplane-js-int').value = S.route_deplane_js_int_min != null ? S.route_deplane_js_int_min : 30;
    if ($('#setting-deplane-wingo')) $('#setting-deplane-wingo').value = S.route_deplane_wingo_min != null ? S.route_deplane_wingo_min : 20;
    if ($('#setting-deplane-fallback')) $('#setting-deplane-fallback').value = S.route_deplane_min != null ? S.route_deplane_min : 20;
    // 0062: corrimiento de domingos y festivos. 0 es válido, así que no se usa `||`.
    if ($('#setting-holiday-shift')) $('#setting-holiday-shift').value = S.route_holiday_shift_min != null ? S.route_holiday_shift_min : 0;
    // 0071: colchón de la tabla de zona. 0 = usar su tabla completa.
    if ($('#setting-zone-cushion')) $('#setting-zone-cushion').value = S.route_zone_cushion_min != null ? S.route_zone_cushion_min : 25;
    // 0074: cómo despacha él. Sin la migración los campos quedan con el default
    // y guardar sigue funcionando (la cascada de saveSettings baja un escalón).
    if ($('#setting-cars-count')) $('#setting-cars-count').value = S.route_cars_count != null ? S.route_cars_count : 2;
    if ($('#setting-rescue-early')) $('#setting-rescue-early').value = S.route_rescue_early === false ? 0 : (S.route_rescue_max_early_min != null ? S.route_rescue_max_early_min : 45);
    if ($('#setting-car-priority')) $('#setting-car-priority').value = S.route_car_priority === false ? '0' : '1';
    if ($('#setting-max-early')) $('#setting-max-early').value = S.route_max_early_min != null ? S.route_max_early_min : 60;
    if ($('#setting-sweep-tol')) $('#setting-sweep-tol').value = S.route_sweep_tol_min != null ? S.route_sweep_tol_min : 2;
    // Estas tres sí son consultas, y por eso viven acá y no en Ajustes: solo las
    // paga quien viene a calibrar. La de la camioneta NO se aplaza hasta que el
    // jefe despliegue "Traslados de auxiliares": el botón Guardar de esta misma
    // pantalla manda el vehículo, y si el desplegable llegara tarde se guardaría
    // el valor viejo. Ver privVehiculoAGuardar(), que existe por eso mismo.
    fillPrivateVehicles();
    renderRouteTables();
    renderResidenceZones();
    setPrepararBloque('calib');
  }

  // Turnos › Revisión › Flota — los carros. Una sola consulta, la de la lista.
  function renderFlota() {
    renderVehiclesSettings();
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

  // --- Vehículos (admin) — alta/baja/edición de la flota, en Turnos › Revisión › Flota ---
  const VEH_STATUS_ES = { available: 'Disponible', in_use: 'En uso', reserved: 'Reservado', maintenance: 'En revisión', blocked: 'Cambio de aceite' };
  let vehiclesEditId = null;       // si está editando un vehículo existente
  let vehiclesCache = [];          // para poblar el form al editar
  // ---- LA TABLA DE TIEMPOS DE JULIÁN (0062) --------------------------------
  // Las zonas son suyas y son fijas: si algún día agrega una, se agrega aquí y
  // en la migración. El orden es el que él usó al dictarlas.
  const RT_ZONAS = ['Fontibón', 'Porvenir', 'Sendai/San Antonio', 'Marinilla'];
  const RT_FRANJA_LABEL = (f, t) => {
    const h = (n) => n === 0 ? '12 a.m.' : n === 12 ? '12 m.' : n < 12 ? `${n} a.m.` : n === 24 ? '12 a.m.' : `${n - 12} p.m.`;
    return `${h(f)} – ${h(t)}`;
  };
  let rtTablas = null;   // {zonas, tramos} tal como vinieron de la BD

  async function renderRouteTables() {
    const tz = $('#zone-times-table'), tl = $('#leg-times-table'), warn = $('#zone-times-warn');
    if (!tz || !tl) return;
    if (!Api.getRouteTables) { tz.innerHTML = ''; return; }
    let t = null;
    try { t = await Api.getRouteTables(null); } catch (e) { t = null; }
    if (!t || !Object.keys(t.zonas || {}).length) {
      // Sin la migración: se dice, no se finge una tabla vacía editable.
      tz.innerHTML = '<tr><td class="franja">La tabla todavía no está en esta base de datos.</td></tr>';
      tl.innerHTML = ''; if (warn) warn.textContent = '';
      return;
    }
    rtTablas = t;
    const franjas = (t.zonas[RT_ZONAS[0]] || []).map(r => ({ f: r.band_from, to: r.band_to }));
    const celda = (val, asum, ds) =>
      `<input type="number" min="0" max="240" value="${val}" class="${asum ? 'asumida' : ''}" ${ds} />`;

    tz.innerHTML =
      `<tr><th class="franja">Franja</th>${RT_ZONAS.map(z => `<th>${z}</th>`).join('')}</tr>` +
      franjas.map(fr => {
        const tds = RT_ZONAS.map(z => {
          const r = (t.zonas[z] || []).find(x => x.band_from === fr.f);
          if (!r) return '<td>—</td>';
          const d = `data-kind="zona" data-zone="${z}" data-band="${fr.f}"`;
          return `<td>${celda(r.min_minutes, r.asumida, d + ' data-lim="min"')}<span class="sep">/</span>${celda(r.max_minutes, r.asumida, d + ' data-lim="max"')}</td>`;
        }).join('');
        return `<tr><td class="franja">${RT_FRANJA_LABEL(fr.f, fr.to)}</td>${tds}</tr>`;
      }).join('');

    tl.innerHTML =
      '<tr><th class="franja">Franja</th><th>Desde la última persona recogida</th></tr>' +
      (t.tramos || []).map(r => {
        const d = `data-kind="tramo" data-band="${r.band_from}"`;
        return `<tr><td class="franja">${RT_FRANJA_LABEL(r.band_from, r.band_to)}</td>`
          + `<td>${celda(r.min_minutes, r.asumida, d + ' data-lim="min"')}<span class="sep">/</span>${celda(r.max_minutes, r.asumida, d + ' data-lim="max"')}</td></tr>`;
      }).join('');

    // Lo que falta confirmarle, dicho sin adornos.
    if (warn) {
      const asum = [...(t.tramos || []), ...Object.values(t.zonas).flat()].filter(r => r.asumida).length;
      const sin = (t.sinConfirmar || []).length;
      warn.innerHTML = [
        asum ? `<b>${asum} casilla${asum > 1 ? 's' : ''} con borde punteado</b>: la franja de 12 a 2 de la mañana no la dictó él, se copió de la de 7 p.m. a 12. Al guardar dejan de estar marcadas.` : '',
        sin ? `<b>${sin} conjunto${sin > 1 ? 's' : ''} sin zona</b>: sus traslados se programan con el cálculo por carretera, no con esta tabla.` : '',
      ].filter(Boolean).join('<br>');
    }
  }

  async function saveRouteTables() {
    if (!rtTablas || !Api.saveRouteTables) return;
    const zonas = [], tramos = [];
    document.querySelectorAll('#zone-times-table input, #leg-times-table input').forEach(inp => {
      const n = Math.min(240, Math.max(0, parseInt(inp.value, 10) || 0));
      const band = Number(inp.dataset.band);
      const arr = inp.dataset.kind === 'zona' ? zonas : tramos;
      const llave = inp.dataset.kind === 'zona'
        ? r => r.zone === inp.dataset.zone && r.band_from === band
        : r => r.band_from === band;
      let row = arr.find(llave);
      if (!row) { row = inp.dataset.kind === 'zona' ? { zone: inp.dataset.zone, band_from: band } : { band_from: band }; arr.push(row); }
      row[inp.dataset.lim === 'min' ? 'min_minutes' : 'max_minutes'] = n;
    });
    // El máximo nunca por debajo del mínimo: la BD lo rechazaría y el admin se
    // quedaría sin saber por qué. Se corrige aquí y se avisa.
    let ajustadas = 0;
    [...zonas, ...tramos].forEach(r => {
      if (r.max_minutes < r.min_minutes) { r.max_minutes = r.min_minutes; ajustadas++; }
    });
    const btn = $('#save-route-tables-btn'); if (btn) btn.disabled = true;
    try {
      await Api.saveRouteTables(zonas, tramos);
      await renderRouteTables();
      toast(ajustadas ? `Tabla guardada (${ajustadas} máximo${ajustadas > 1 ? 's' : ''} subido${ajustadas > 1 ? 's' : ''} al mínimo).` : 'Tabla de tiempos guardada.');
    } catch (e) {
      toast('No se pudo guardar la tabla: ' + (e.message || e));
    } finally { if (btn) btn.disabled = false; }
  }

  // ---- ZONA DE CADA CONJUNTO ------------------------------------------------
  async function renderResidenceZones() {
    const box = $('#residence-zones');
    if (!box || !Api.listResidencesZones) return;
    let rows = null;
    try { rows = await Api.listResidencesZones(); } catch (e) { rows = null; }
    if (!rows) { box.innerHTML = '<p class="set-hint">El catálogo de residencias no está disponible en esta base de datos.</p>'; return; }
    // Sin asignar primero: es la lista de trabajo, no un detalle al final.
    rows.sort((a, b) => (!!a.zona_jefe - !!b.zona_jefe) || a.name.localeCompare(b.name, 'es'));
    box.innerHTML = rows.map(r => `
      <div class="rz-row ${r.zona_jefe ? '' : 'sin'}">
        <div class="rz-name">${escapeHtml(r.name)}<small>${escapeHtml(r.sector || "sin sector")}</small></div>
        <select data-id="${r.id}">
          <option value="">Sin asignar</option>
          ${RT_ZONAS.map(z => `<option value="${escapeHtml(z)}" ${r.zona_jefe === z ? 'selected' : ''}>${escapeHtml(z)}</option>`).join('')}
        </select>
      </div>`).join('');
    box.querySelectorAll('select').forEach(sel => {
      sel.addEventListener('change', async () => {
        try {
          await Api.saveResidenceZone(sel.dataset.id, sel.value);
          sel.closest('.rz-row').classList.toggle('sin', !sel.value);
          await renderRouteTables();   // el contador de "sin zona" cambia
        } catch (e) { toast('No se pudo guardar la zona: ' + (e.message || e)); }
      });
    });
  }

  async function renderVehiclesSettings() {
    const box = $('#vehicles-list');
    if (!box) return;
    box.innerHTML = '<p class="set-hint">Cargando…</p>';
    let vehs = [];
    try { vehs = await Api.listVehiclesForShift(); }
    catch (e) { console.error(e); box.innerHTML = '<p class="set-hint">No se pudieron cargar los vehículos.</p>'; return; }
    vehiclesCache = vehs;
    setOilBadge(vehs);   // refresca el "!" de Ajustes con la lista ya cargada
    if (!vehs.length) { box.innerHTML = '<p class="set-hint">Aún no hay vehículos. Agrega el primero abajo.</p>'; return; }
    box.innerHTML = vehs.map(v => {
      const overridden = !!v.oil_override_at;               // conductor lo desbloqueó
      const oilPending = v.status === 'blocked' || overridden; // aceite vencido (con o sin override)
      // Botón "Cambio de aceite hecho": para carros bloqueados por aceite Y para
      // los que el conductor desbloqueó (siguen disponibles pero con aceite pendiente).
      const oilBtn = oilPending
        ? `<button class="set-btn dark" data-veh-oilchange="${v.id}" title="Registrar cambio de aceite">Cambio de aceite hecho</button>`
        : '';
      // 'maintenance' (NO APTO) se regresa a servicio por la vía normal.
      const restoreBtn = (v.status === 'maintenance')
        ? `<button class="set-btn dark" data-veh-restore="${v.id}" title="Regresar a servicio">Regresar a servicio</button>`
        : '';
      const oilAlert = oilPending
        ? `<span style="display:block;margin-top:3px;color:#dc2626;font-weight:800;font-size:11px">🛢️ Cambio de aceite pendiente${overridden ? ' · desbloqueado por conductor' : ''}</span>`
        : '';
      const intv = v.maintenance_interval_km ? ` · aceite c/${(v.maintenance_interval_km).toLocaleString('es-CO')} km` : '';
      return `<div class="veh-row" data-veh="${v.id}">
      <div class="veh-info"><b>${escapeHtml(v.internal_code || v.license_plate || 'Auto')}</b><span>${escapeHtml(v.license_plate || '')} · ${escapeHtml([v.brand, v.model].filter(Boolean).join(' ') || '—')} · ${v.capacity} pas · ${(v.current_km || 0).toLocaleString('es-CO')} km${intv}</span>${oilAlert}</div>
      <span class="veh-stat st-${v.status}">${VEH_STATUS_ES[v.status] || escapeHtml(v.status || '')}</span>
      ${oilBtn}${restoreBtn}
      <button class="set-btn ghost" data-veh-edit="${v.id}" title="Editar" style="height:34px">Editar</button>
      <button class="veh-del" data-veh-del="${v.id}" title="Eliminar vehículo"><svg class="icon" style="width:15px;height:15px"><use href="#i-trash"/></svg></button>
    </div>`;
    }).join('');
  }

  function onEditVehicle(id) {
    const v = vehiclesCache.find(x => x.id === id); if (!v) return;
    vehiclesEditId = id;
    const set = (f, val) => { const el = $('#new-veh-' + f); if (el) el.value = val != null ? val : ''; };
    set('code', v.internal_code); set('plate', v.license_plate); set('brand', v.brand); set('model', v.model);
    set('capacity', v.capacity || 4); set('km', v.current_km || 0);
    set('interval', v.maintenance_interval_km || 7000); set('lastmaint', v.last_maintenance_km != null ? v.last_maintenance_km : '');
    set('soat', v.soat_expires_at || ''); set('tecno', v.tecnomec_expires_at || '');
    const btn = $('#new-veh-create-btn'); if (btn) btn.innerHTML = '<svg class="icon"><use href="#i-check"/></svg>Guardar cambios';
    const st = $('#new-veh-state'); if (st) st.textContent = `Editando ${v.internal_code || v.license_plate || ''}…`;
    $('#new-veh-code')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function resetVehicleForm() {
    vehiclesEditId = null;
    ['code', 'plate', 'brand', 'model', 'soat', 'tecno', 'lastmaint'].forEach(f => { const el = $('#new-veh-' + f); if (el) el.value = ''; });
    if ($('#new-veh-capacity')) $('#new-veh-capacity').value = '4';
    if ($('#new-veh-km')) $('#new-veh-km').value = '0';
    if ($('#new-veh-interval')) $('#new-veh-interval').value = '7000';
    const btn = $('#new-veh-create-btn'); if (btn) btn.innerHTML = '<svg class="icon"><use href="#i-plus"/></svg>Agregar vehículo';
    const st = $('#new-veh-state'); if (st) st.textContent = '';
  }

  async function onCreateVehicle() {
    const code = ($('#new-veh-code') && $('#new-veh-code').value || '').trim();
    const plate = ($('#new-veh-plate') && $('#new-veh-plate').value || '').trim();
    if (!code || !plate) { toast('Código interno y placa son obligatorios.'); return; }
    const km = Math.max(0, parseInt($('#new-veh-km').value, 10) || 0);
    const interval = Math.max(500, parseInt($('#new-veh-interval') && $('#new-veh-interval').value, 10) || 7000);
    const lastRaw = ($('#new-veh-lastmaint') && $('#new-veh-lastmaint').value) || '';
    // Baseline de mantto: si lo dejan vacío, usa el km actual (evita bug 4).
    const lastMaint = (lastRaw !== '' && !isNaN(parseInt(lastRaw, 10))) ? Math.max(0, parseInt(lastRaw, 10)) : km;
    const veh = {
      organization_id: state.profile.organization_id,
      internal_code: code,
      license_plate: plate.toUpperCase(),
      brand: ($('#new-veh-brand').value || '').trim() || null,
      model: ($('#new-veh-model').value || '').trim() || null,
      capacity: Math.min(4, Math.max(1, parseInt($('#new-veh-capacity').value, 10) || 4)),
      current_km: km,
      last_maintenance_km: lastMaint,
      maintenance_interval_km: interval,
      soat_expires_at: $('#new-veh-soat').value || null,
      tecnomec_expires_at: $('#new-veh-tecno').value || null,
    };
    const btn = $('#new-veh-create-btn'); const st = $('#new-veh-state');
    const editing = !!vehiclesEditId;
    btn.disabled = true; if (st) st.textContent = editing ? 'Guardando…' : 'Creando…';
    try {
      if (editing) {
        const { organization_id, ...patch } = veh;   // no se cambia la organización
        await Api.updateVehicle(vehiclesEditId, patch);
        toast('Vehículo actualizado.');
      } else {
        await Api.createVehicle(veh);
        toast('Vehículo agregado.');
      }
      resetVehicleForm();
      renderVehiclesSettings();
    } catch (e) {
      console.error(e);
      if (st) st.textContent = '';
      const msg = /unique|duplicate/i.test(e.message || '') ? 'Ya existe un vehículo con ese código o placa.' : (e.message || 'error');
      alert((editing ? 'No se pudo actualizar: ' : 'No se pudo agregar: ') + msg);
    } finally { btn.disabled = false; }
  }

  async function onDeleteVehicle(id) {
    const v = (await safeVehicles()).find(x => x.id === id);
    if (v && v.status === 'in_use' && !confirm('Este vehículo está EN USO en un turno activo. ¿Eliminarlo igual? Mejor espera a que el turno cierre.')) return;
    if (!confirm('¿Eliminar este vehículo? Dejará de aparecer para los conductores. El historial de turnos e inspecciones se conserva.')) return;
    try { await Api.softDeleteVehicle(id); toast('Vehículo eliminado.'); renderVehiclesSettings(); }
    catch (e) { console.error(e); alert('No se pudo eliminar: ' + (e.message || 'error')); }
  }

  // 'maintenance' (p. ej. NO APTO): regresar a servicio sin tocar el contador.
  // El caso 'blocked'/override por aceite va por onRegisterOilChange (0041).
  async function onRestoreVehicle(id) {
    const v = (await safeVehicles()).find(x => x.id === id);
    const label = v ? (v.internal_code || v.license_plate || 'este vehículo') : 'este vehículo';
    if (!confirm(`¿Regresar ${label} a servicio? Quedará Disponible para los conductores.`)) return;
    try {
      await Api.returnVehicleToService(id, 'Regreso a servicio desde Flota');
      toast('Vehículo disponible.');
      renderVehiclesSettings();
    } catch (e) {
      console.error(e);
      const msg = /VEHICLE_HAS_ACTIVE_SHIFT/.test(e.message || '')
        ? 'Hay un turno en curso con ese vehículo. Ciérralo primero en Turnos activos.'
        : (e.message || 'error');
      alert('No se pudo regresar a servicio: ' + msg);
    }
  }
  // Admin registra el cambio de aceite (0041): reinicia el contador, limpia el
  // override del conductor y regresa a servicio si estaba bloqueado.
  async function onRegisterOilChange(id) {
    const v = (await safeVehicles()).find(x => x.id === id);
    const label = v ? (v.internal_code || v.license_plate || 'este vehículo') : 'este vehículo';
    const wasOverride = v && v.oil_override_at;
    const msg = wasOverride
      ? `¿Registrar el cambio de aceite de ${label}? Un conductor lo desbloqueó y sigue pendiente. Se reinicia el contador de km.`
      : `¿Registrar el cambio de aceite de ${label}? Quedará Disponible y se reinicia el contador de km.`;
    if (!confirm(msg)) return;
    try {
      await Api.registerOilChange(id, 'Cambio de aceite registrado desde Flota');
      toast('Cambio de aceite registrado.');
      renderVehiclesSettings();
    } catch (e) {
      console.error(e);
      alert('No se pudo registrar el cambio de aceite: ' + (e.message || 'error'));
    }
  }

  async function safeVehicles() { try { return await Api.listVehiclesForShift(); } catch (e) { return []; } }

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

  // Rutas › Configuración › Calibración — los 26 del optimizador (27 columnas:
  // route_rescue_early sale de que la madrugada sea mayor que 0, no de un campo).
  async function onSaveCalibracion() {
    const next = {
      aux_wait_minutes: Math.min(60, Math.max(1, parseInt($('#setting-aux-wait') && $('#setting-aux-wait').value, 10) || 5)),
      // 0 = sin anticipación mínima. `|| 6` lo pisaría, así que se valida aparte.
      aux_min_lead_hours: (() => {
        const n = parseInt($('#setting-aux-lead') && $('#setting-aux-lead').value, 10);
        return isNaN(n) ? 6 : Math.min(72, Math.max(0, n));
      })(),
      // 0069. El vacío del desplegable es null a propósito: "sin camioneta
      // elegida" es un estado válido, y con él la app no ofrece el privado.
      aux_private_enabled: !!($('#setting-priv-enabled') && $('#setting-priv-enabled').checked),
      aux_private_vehicle_id: privVehiculoAGuardar(),
      aux_private_price_cop: Math.max(1, parseInt($('#setting-priv-price') && $('#setting-priv-price').value, 10) || 150000),
      aux_private_block_min: Math.min(480, Math.max(10, parseInt($('#setting-priv-block') && $('#setting-priv-block').value, 10) || 90)),
      // Optimizador. Igual que aux_min_lead_hours, 0 es un valor VÁLIDO
      // (0 = no juntar oleadas), así que `|| default` lo pisaría.
      route_merge_window_min: (() => {
        const n = parseInt($('#setting-route-merge') && $('#setting-route-merge').value, 10);
        return isNaN(n) ? 30 : Math.min(120, Math.max(0, n));
      })(),
      route_service_min: (() => {
        const n = parseInt($('#setting-route-service') && $('#setting-route-service').value, 10);
        return isNaN(n) ? 3 : Math.min(20, Math.max(0, n));
      })(),
      route_traffic_factor: (() => {
        const n = parseFloat($('#setting-route-traffic') && $('#setting-route-traffic').value);
        return isNaN(n) ? 1.05 : Math.min(2, Math.max(1, n));
      })(),
      // 0060: corrige SOLO el tramo a/desde MDE. Va por debajo de 1 a propósito
      // (OSRM sobreestima ese corredor), así que el mínimo no puede ser 1.
      route_airport_factor: (() => {
        const n = parseFloat($('#setting-route-aero') && $('#setting-route-aero').value);
        return isNaN(n) ? 0.8 : Math.min(1.5, Math.max(0.5, n));
      })(),
      // 0061: techo de espera. 0 = sin techo, así que no se usa `|| default`.
      // 0062: corrimiento de domingo/festivo. 0 = tratarlo como día normal.
      ...Object.fromEntries([
        ['route_max_wait_min', '#setting-route-wait'],
        ['route_max_wait_peak_min', '#setting-route-wait-peak'],
        ['route_holiday_shift_min', '#setting-holiday-shift'],
        ['route_zone_cushion_min', '#setting-zone-cushion'],
        ['route_rescue_max_early_min', '#setting-rescue-early'],
        ['route_max_early_min', '#setting-max-early'],
        ['route_sweep_tol_min', '#setting-sweep-tol'],
      ].map(([col, sel]) => {
        const n = parseInt($(sel) && $(sel).value, 10);
        return [col, isNaN(n) ? 0 : Math.min(180, Math.max(0, n))];
      })),
      // 0074: cuántos carros planea el tablero y si se llena un carro antes de
      // sacar el siguiente. El rescate se apaga poniendo la madrugada en 0, que
      // es lo que significa "no adelantar a nadie".
      route_cars_count: (() => {
        const n = parseInt($('#setting-cars-count') && $('#setting-cars-count').value, 10);
        return isNaN(n) ? 2 : Math.min(6, Math.max(1, n));
      })(),
      route_rescue_early: (parseInt($('#setting-rescue-early') && $('#setting-rescue-early').value, 10) || 0) > 0,
      route_car_priority: ($('#setting-car-priority') && $('#setting-car-priority').value) !== '0',
      // Desembarque por aerolínea (0058). Mismo patrón: 0 es válido (un vuelo
      // que suelta a la gente de inmediato), así que no se usa `|| default`.
      ...Object.fromEntries([
        ['route_deplane_av_nac_min', '#setting-deplane-av-nac', 15],
        ['route_deplane_av_int_min', '#setting-deplane-av-int', 20],
        ['route_deplane_js_nac_min', '#setting-deplane-js-nac', 25],
        ['route_deplane_js_int_min', '#setting-deplane-js-int', 30],
        ['route_deplane_wingo_min', '#setting-deplane-wingo', 20],
        ['route_deplane_min', '#setting-deplane-fallback', 20],
      ].map(([col, sel, def]) => {
        const n = parseInt($(sel) && $(sel).value, 10);
        return [col, isNaN(n) ? def : Math.min(90, Math.max(0, n))];
      })),
      route_airport_buffer_min: (() => {
        const n = parseInt($('#setting-route-buffer') && $('#setting-route-buffer').value, 10);
        return isNaN(n) ? 10 : Math.min(45, Math.max(0, n));
      })(),
    };
    // ENCENDIDO SIN CAMIONETA NO ES ENCENDIDO. La app ofrece el privado solo si
    // se cumplen las tres: interruptor + camioneta + tarifa (aux-privado.js).
    // Marcar la casilla y dejar el desplegable en «— Sin definir —» se guardaba
    // sin decir nada, y el jefe quedaba viendo el privado «encendido» mientras
    // al tripulante no le salía el paso. Se guarda todo lo demás, esto no, y se
    // dice por qué.
    let avisoPrivado = '';
    if (next.aux_private_enabled && !next.aux_private_vehicle_id) {
      next.aux_private_enabled = false;
      if ($('#setting-priv-enabled')) $('#setting-priv-enabled').checked = false;
      avisoPrivado = 'El traslado privado NO quedó encendido: falta elegir cuál carro es la camioneta. '
        + 'Lo demás sí se guardó.';
    }
    await setGuardarBloque('calib', next, avisoPrivado);
  }
  // Llena el desplegable de "cuál carro es la camioneta" (0069). Se consulta
  // aparte porque es una lectura de la flota, no del objeto de ajustes.
  // Se marca el bloqueado, para que no se elija por error un carro fuera de
  // servicio como vehículo de un servicio que se cobra.
  async function fillPrivateVehicles() {
    const sel = $('#setting-priv-vehicle'); if (!sel) return;
    const actual = state.settings && state.settings.aux_private_vehicle_id;
    // `data-flota` dice si lo que se ve en el desplegable es la flota de verdad.
    // Mientras carga —o si la consulta falló— lo que muestre NO es una elección
    // del jefe, y guardar no puede tomarlo como tal. Ver privVehiculoAGuardar().
    sel.dataset.flota = 'cargando';
    let lista = null;
    try { if (window.Api && Api.listVehiclesBasic) lista = await Api.listVehiclesBasic(); } catch (_) {}
    if (!Array.isArray(lista)) {
      sel.innerHTML = '<option value="">No se pudo cargar la flota</option>';
      sel.dataset.flota = 'fallo';
      setRepintarValores('calib');
      return;
    }
    sel.innerHTML = '<option value="">— Sin definir —</option>' + lista.map(v =>
      '<option value="' + v.id + '"' + (v.id === actual ? ' selected' : '') + '>'
      + (v.plate || '?') + ' · ' + (v.label || '') + ' (' + (v.capacity || '?') + ' puestos)'
      + (v.status === 'blocked' ? ' — BLOQUEADO' : '') + '</option>').join('');
    sel.dataset.flota = 'ok';
    // La pastilla de "Traslados de auxiliares" ya se pintó con el desplegable
    // vacío (esto es una consulta, llega después del render). Sin este repintado,
    // la sección cerrada mentiría: diría «— Sin definir —» con la camioneta puesta.
    setRepintarValores('calib');
  }

  // QUÉ CAMIONETA SE MANDA A GUARDAR.
  //
  // Antes era `select.value || null`, y ahí había un fallo silencioso feo: el
  // desplegable nace VACÍO en index.html y se llena con una consulta aparte
  // (fillPrivateVehicles), sin bloquear el botón de Guardar. Si esa consulta
  // fallaba —o si el jefe alcanzaba a guardar antes de que llegara—, se
  // escribía `aux_private_vehicle_id = NULL` aunque el jefe estuviera cambiando
  // los strikes y no hubiera tocado el privado. Y sin camioneta el privado no
  // se ofrece: quedaba apagado sin que nadie lo apagara, con el interruptor
  // todavía marcado en la pantalla.
  //
  // Ahora: si lo que hay en pantalla no es la flota de verdad, se manda la
  // camioneta que YA estaba guardada. Vaciarla a mano sí vale — eso es una
  // decisión, no un accidente.
  function privVehiculoAGuardar() {
    const sel = $('#setting-priv-vehicle');
    const guardada = (state.settings && state.settings.aux_private_vehicle_id) || null;
    if (!sel || sel.dataset.flota !== 'ok') return guardada;
    return sel.value || null;
  }
