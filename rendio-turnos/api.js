(function () {
  const sb = window.sb;

  async function signIn(email, password) {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  }

  async function signOut() {
    await sb.auth.signOut();
  }

  async function getSession() {
    const { data } = await sb.auth.getSession();
    return data.session;
  }

  async function getCurrentProfile() {
    const session = await getSession();
    if (!session) return null;
    const { data, error } = await sb
      .from('profiles')
      .select('id, full_name, email, role, organization_id, is_active')
      .eq('id', session.user.id)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  async function listDrivers() {
    const sel = cols => sb.from('profiles').select(cols)
      .eq('role', 'driver').is('deleted_at', null).order('full_name');
    // Fallback en capas: 0012 (priority) y 0013 (can_coordinate) podrían no
    // estar aplicadas todavía. Conserva priority si solo falta can_coordinate.
    let { data, error } = await sel('id, full_name, email, role, is_active, priority, can_coordinate');
    if (error) ({ data, error } = await sel('id, full_name, email, role, is_active, priority'));
    if (error) ({ data, error } = await sel('id, full_name, email, role, is_active'));
    if (error) throw error;
    return (data || []).filter(p => p.is_active !== false)
      .map(p => ({
        id: p.id, name: p.full_name, email: p.email,
        priority: p.priority || 1,
        can_coordinate: p.can_coordinate === true,
      }));
  }

  async function setDriverPriority(profileId, value) {
    const v = Math.min(4, Math.max(1, parseInt(value, 10) || 1));
    const { error } = await sb
      .from('profiles')
      .update({ priority: v })
      .eq('id', profileId);
    if (error) throw error;
  }

  async function setDriverCanCoordinate(profileId, value) {
    const { error } = await sb
      .from('profiles')
      .update({ can_coordinate: value })
      .eq('id', profileId);
    if (error) throw error;
  }

  // Crea un conductor nuevo vía Edge Function (requiere sesión admin activa).
  // Devuelve { id, email, full_name, priority, can_coordinate } o lanza Error.
  async function createDriver({ email, password, full_name, priority = 1, can_coordinate = false }) {
    const { data, error } = await sb.functions.invoke('create-driver', {
      body: { email, password, full_name, priority, can_coordinate },
    });
    if (error) {
      // sb.functions.invoke envuelve el body de error en `error.context.body` si la
      // function respondió con status no-2xx. Intentamos extraer el mensaje real.
      let msg = error.message || 'Error desconocido';
      try {
        const ctx = error.context;
        if (ctx) {
          if (typeof ctx.body === 'string') {
            const parsed = JSON.parse(ctx.body);
            if (parsed?.error) msg = parsed.error;
          } else if (ctx.body?.error) {
            msg = ctx.body.error;
          } else if (typeof ctx.json === 'function') {
            const j = await ctx.json();
            if (j?.error) msg = j.error;
          }
        }
      } catch { /* deja msg original */ }
      throw new Error(msg);
    }
    if (data?.error) throw new Error(data.error);
    return data;
  }

  async function listAdmins() {
    let { data, error } = await sb
      .from('profiles')
      .select('id, full_name, email, role, is_active, is_coordinator')
      .eq('role', 'admin')
      .is('deleted_at', null)
      .order('full_name');
    if (error) {
      // Fallback: la migración 0011 (is_coordinator) aún no aplicada.
      ({ data, error } = await sb
        .from('profiles')
        .select('id, full_name, email, role, is_active')
        .eq('role', 'admin')
        .is('deleted_at', null)
        .order('full_name'));
      if (error) throw error;
    }
    return (data || [])
      .filter(p => p.is_active !== false)
      .map(p => ({ ...p, is_coordinator: p.is_coordinator !== false }));
  }

  async function setAdminCoordinator(profileId, value) {
    const { error } = await sb
      .from('profiles')
      .update({ is_coordinator: value })
      .eq('id', profileId);
    if (error) throw error;
  }

  // Conductores no borrados (activos + suspendidos) — para el módulo Personal.
  async function listAllDriversForAdmin() {
    const sel = cols => sb.from('profiles').select(cols)
      .eq('role', 'driver').is('deleted_at', null).order('full_name');
    let { data, error } = await sel('id, full_name, email, role, is_active, can_coordinate');
    if (error) ({ data, error } = await sel('id, full_name, email, role, is_active')); // 0013 sin aplicar
    if (error) throw error;
    return (data || []).map(p => ({
      id: p.id, name: p.full_name, email: p.email,
      active: p.is_active !== false,
      can_coordinate: p.can_coordinate === true,
    }));
  }

  // Conductores que SÍ guardaron disponibilidad para esa semana (≥1 fila).
  // Si no llenaron y ya pasó el corte del sábado → quedan fuera del generador.
  async function listSubmittedDriverIds(weekStart) {
    const { data, error } = await sb
      .from('driver_availability')
      .select('profile_id')
      .eq('week_start_date', weekStart);
    if (error) throw error;
    return new Set((data || []).map(r => r.profile_id));
  }

  async function setProfileActive(profileId, active) {
    const { error } = await sb
      .from('profiles')
      .update({ is_active: active })
      .eq('id', profileId);
    if (error) throw error;
  }

  async function softDeleteProfile(profileId) {
    const { error } = await sb
      .from('profiles')
      .update({ deleted_at: new Date().toISOString(), is_active: false })
      .eq('id', profileId);
    if (error) throw error;
  }

  function toAvailMap(rows, drivers) {
    const map = {};
    drivers.forEach(d => {
      map[d.id] = {};
      Scheduler.DAYS.forEach(day => {
        map[d.id][day] = { am: 'available', pm: 'available', am_reason: null, pm_reason: null, shift_pref: 'any' };
      });
    });
    rows.forEach(r => {
      const day = Scheduler.DAYS[r.day_of_week];
      if (!day) return;
      map[r.profile_id] = map[r.profile_id] || {};
      map[r.profile_id][day] = {
        am: r.am_state, pm: r.pm_state,
        am_reason: r.am_reason || null, pm_reason: r.pm_reason || null,
        shift_pref: r.shift_pref || 'any',
      };
    });
    return map;
  }

  async function getWeeklyAvailability(weekStart, drivers) {
    // Fallback en capas: si 0015 (shift_pref) aún no aplicada, lee sin esa col.
    const selAvail = cols => sb.from('driver_availability').select(cols).eq('week_start_date', weekStart);
    let { data: availData, error: availErr } = await selAvail('profile_id, day_of_week, am_state, pm_state, am_reason, pm_reason, shift_pref');
    if (availErr) ({ data: availData, error: availErr } = await selAvail('profile_id, day_of_week, am_state, pm_state, am_reason, pm_reason'));
    if (availErr) throw availErr;
    const approvalsRes = await sb.from('approval_requests')
      .select('id, profile_id, day_of_week, shift, kind, state, reason, admin_note')
      .eq('week_start_date', weekStart);
    if (approvalsRes.error) throw approvalsRes.error;
    const map = toAvailMap(availData || [], drivers);
    (approvalsRes.data || []).forEach(a => {
      const day = Scheduler.DAYS[a.day_of_week];
      if (!day || !map[a.profile_id]) return;
      map[a.profile_id][day][`${a.shift}_request`] = a;
    });
    return map;
  }

  async function getMyWeeklyAvailability(profileId, weekStart) {
    const selOwn = cols => sb.from('driver_availability').select(cols)
      .eq('profile_id', profileId).eq('week_start_date', weekStart);
    let { data: availData, error: availErr } = await selOwn('day_of_week, am_state, pm_state, am_reason, pm_reason, shift_pref');
    if (availErr) ({ data: availData, error: availErr } = await selOwn('day_of_week, am_state, pm_state, am_reason, pm_reason'));
    if (availErr) throw availErr;
    const approvalsRes = await sb.from('approval_requests')
      .select('id, day_of_week, shift, kind, state, reason, admin_note')
      .eq('profile_id', profileId)
      .eq('week_start_date', weekStart);
    if (approvalsRes.error) throw approvalsRes.error;
    const own = {};
    Scheduler.DAYS.forEach(d => {
      own[d] = { am: 'available', pm: 'available', am_reason: null, pm_reason: null, shift_pref: 'any', am_request: null, pm_request: null };
    });
    (availData || []).forEach(r => {
      const day = Scheduler.DAYS[r.day_of_week];
      if (day) {
        own[day].am = r.am_state;
        own[day].pm = r.pm_state;
        own[day].am_reason = r.am_reason;
        own[day].pm_reason = r.pm_reason;
        own[day].shift_pref = r.shift_pref || 'any';
      }
    });
    (approvalsRes.data || []).forEach(a => {
      const day = Scheduler.DAYS[a.day_of_week];
      if (day) own[day][`${a.shift}_request`] = a;
    });
    return own;
  }

  async function upsertAvailabilityRow({ profileId, weekStart, day, am, pm, am_reason, pm_reason, shift_pref }) {
    const dayIdx = Scheduler.DAY_INDEX[day];
    const base = {
      profile_id: profileId,
      week_start_date: weekStart,
      day_of_week: dayIdx,
      am_state: am,
      pm_state: pm,
      am_reason: am === 'unavailable' ? am_reason : null,
      pm_reason: pm === 'unavailable' ? pm_reason : null,
      shift_pref: shift_pref || 'any',
    };
    let { error } = await sb.from('driver_availability')
      .upsert(base, { onConflict: 'profile_id,week_start_date,day_of_week' });
    if (error) {
      // Fallback si 0015 no aplicada: re-intentar sin shift_pref.
      const { shift_pref: _ignore, ...withoutPref } = base;
      ({ error } = await sb.from('driver_availability')
        .upsert(withoutPref, { onConflict: 'profile_id,week_start_date,day_of_week' }));
    }
    if (error) throw error;
  }

  async function saveDriverWeekAvailability(profileId, weekStart, ownMap) {
    const rows = Scheduler.DAYS.map((day, idx) => {
      const row = ownMap[day] || { am: 'available', pm: 'available' };
      return {
        profile_id: profileId,
        week_start_date: weekStart,
        day_of_week: idx,
        am_state: row.am || 'available',
        pm_state: row.pm || 'available',
        am_reason: row.am === 'unavailable' ? (row.am_reason || null) : null,
        pm_reason: row.pm === 'unavailable' ? (row.pm_reason || null) : null,
        shift_pref: row.shift_pref || 'any',
      };
    });
    let { error } = await sb.from('driver_availability')
      .upsert(rows, { onConflict: 'profile_id,week_start_date,day_of_week' });
    if (error) {
      // Fallback si 0015 no aplicada: re-intentar sin shift_pref.
      const rowsNoPref = rows.map(({ shift_pref, ...rest }) => rest);
      ({ error } = await sb.from('driver_availability')
        .upsert(rowsNoPref, { onConflict: 'profile_id,week_start_date,day_of_week' }));
    }
    if (error) throw error;
  }

  // -------------------- Approval requests --------------------

  async function listMyApprovalRequests(profileId, weekStart) {
    const { data, error } = await sb
      .from('approval_requests')
      .select('id, day_of_week, shift, kind, reason, state, admin_note, resolved_at')
      .eq('profile_id', profileId)
      .eq('week_start_date', weekStart)
      .order('day_of_week');
    if (error) throw error;
    return data || [];
  }

  async function listPendingApprovals(weekStart) {
    const { data, error } = await sb
      .from('approval_requests')
      .select('id, profile_id, week_start_date, day_of_week, shift, kind, reason, state, admin_note, resolved_at, created_at')
      .eq('week_start_date', weekStart)
      .order('day_of_week')
      .order('shift');
    if (error) throw error;
    return data || [];
  }

  async function resolveApproval(id, decision, adminNote) {
    const { error } = await sb
      .from('approval_requests')
      .update({
        state: decision,
        admin_note: adminNote || null,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', id);
    if (error) throw error;
  }

  async function runAutoResolve() {
    const { data, error } = await sb.rpc('auto_resolve_weekend_singletons');
    if (error) throw error;
    return data;
  }

  // -------------------- Strikes & suspensiones (Fase 2) --------------------

  // Historial de strikes de un conductor (más reciente primero).
  async function listDriverStrikes(profileId) {
    const { data, error } = await sb
      .from('driver_strikes')
      .select('id, profile_id, reason, week_start_date, created_by, voided_at, voided_by, consumed_at, created_at')
      .eq('profile_id', profileId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  }

  // Conteo de strikes ACTIVOS (no anulados, no consumidos) por conductor.
  // Devuelve Map profile_id -> count, para pintar badges en la lista de Personal.
  async function getActiveStrikeCounts() {
    const { data, error } = await sb
      .from('driver_strikes')
      .select('profile_id')
      .is('voided_at', null)
      .is('consumed_at', null);
    if (error) throw error;
    const m = new Map();
    (data || []).forEach(r => m.set(r.profile_id, (m.get(r.profile_id) || 0) + 1));
    return m;
  }

  // Registra un strike. La auto-suspensión (al 3º) la dispara el trigger en BD.
  async function addStrike({ profileId, reason, weekStart, createdBy }) {
    const row = { profile_id: profileId, reason: (reason || '').trim(), created_by: createdBy || null };
    if (weekStart) row.week_start_date = weekStart;
    const { data, error } = await sb.from('driver_strikes').insert(row).select().single();
    if (error) throw error;
    return data;
  }

  // Anula un strike (no cuenta; queda en historial).
  async function voidStrike(id, voidedBy) {
    const { error } = await sb
      .from('driver_strikes')
      .update({ voided_at: new Date().toISOString(), voided_by: voidedBy || null })
      .eq('id', id);
    if (error) throw error;
  }

  // Suspensiones VIGENTES (no levantadas) de una semana. Map profile_id -> row.
  async function getWeekSuspensions(weekStart) {
    const { data, error } = await sb
      .from('driver_suspensions')
      .select('id, profile_id, week_start_date, reason, source, lifted_at, created_at')
      .eq('week_start_date', weekStart)
      .is('lifted_at', null);
    if (error) throw error;
    const m = new Map();
    (data || []).forEach(r => m.set(r.profile_id, r));
    return m;
  }

  // ¿El conductor está suspendido esa semana? Devuelve la fila o null.
  async function getMyWeekSuspension(profileId, weekStart) {
    const { data, error } = await sb
      .from('driver_suspensions')
      .select('id, week_start_date, reason, source, lifted_at')
      .eq('profile_id', profileId)
      .eq('week_start_date', weekStart)
      .is('lifted_at', null)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  // Suspensión manual de una semana (admin).
  async function addManualSuspension({ profileId, weekStart, reason, createdBy }) {
    const { error } = await sb.from('driver_suspensions').upsert({
      profile_id: profileId, week_start_date: weekStart,
      reason: reason || null, source: 'manual', created_by: createdBy || null,
      lifted_at: null, lifted_by: null,
    }, { onConflict: 'profile_id,week_start_date' });
    if (error) throw error;
  }

  // Levanta (cancela) una suspensión de esa semana.
  async function liftSuspension(id, liftedBy) {
    const { error } = await sb
      .from('driver_suspensions')
      .update({ lifted_at: new Date().toISOString(), lifted_by: liftedBy || null })
      .eq('id', id);
    if (error) throw error;
  }

  // -------------------- Web Push (Fase 5) --------------------

  async function savePushSubscription({ profileId, endpoint, p256dh, auth, userAgent }) {
    const { error } = await sb.from('push_subscriptions').upsert({
      profile_id: profileId, endpoint, p256dh, auth, user_agent: userAgent || null,
    }, { onConflict: 'endpoint' });
    if (error) throw error;
  }

  async function deletePushSubscription(endpoint) {
    const { error } = await sb.from('push_subscriptions').delete().eq('endpoint', endpoint);
    if (error) throw error;
  }

  // Dispara notificaciones vía Edge Function (best-effort: si no está desplegada,
  // el caller ignora el error). profileIds: array de destinatarios.
  async function sendPush({ profileIds, title, body, url }) {
    const { data, error } = await sb.functions.invoke('send-push', {
      body: { profileIds, title, body, url },
    });
    if (error) throw error;
    return data;
  }

  // -------------------- Reglas / parametrización (Fase 4) --------------------

  // Todas las reglas (descansos fijos) de todos los conductores.
  async function listDriverRules() {
    const { data, error } = await sb
      .from('driver_rules')
      .select('id, profile_id, day_of_week, shift, note')
      .order('profile_id');
    if (error) throw error;
    return data || [];
  }

  // Convierte las filas a { profileId: Set('day-shift') } usando claves de día
  // ('mon'..'sun') para que calce con Scheduler.ruleBlocked.
  function rulesToMap(rows) {
    const DAYS = Scheduler.DAYS;
    const map = {};
    (rows || []).forEach(r => {
      const dayKey = DAYS[r.day_of_week];
      if (!dayKey) return;
      (map[r.profile_id] = map[r.profile_id] || new Set()).add(`${dayKey}-${r.shift}`);
    });
    return map;
  }

  async function addDriverRule({ profileId, dayOfWeek, shift, note, createdBy }) {
    const { error } = await sb.from('driver_rules').upsert({
      profile_id: profileId, day_of_week: dayOfWeek, shift, note: note || null, created_by: createdBy || null,
    }, { onConflict: 'profile_id,day_of_week,shift' });
    if (error) throw error;
  }

  async function deleteDriverRule({ profileId, dayOfWeek, shift }) {
    const { error } = await sb.from('driver_rules')
      .delete()
      .eq('profile_id', profileId)
      .eq('day_of_week', dayOfWeek)
      .eq('shift', shift);
    if (error) throw error;
  }

  // -------------------- Shift swaps (Fase 3) --------------------

  // Swaps aceptados de una semana → se aplican como overlay al mostrar el horario.
  async function listAcceptedSwaps(weekStart) {
    const { data, error } = await sb
      .from('shift_swaps')
      .select('id, requester_id, target_id, from_day, from_shift, to_day, to_shift')
      .eq('week_start_date', weekStart)
      .eq('state', 'accepted');
    if (error) throw error;
    return data || [];
  }

  // Swaps donde el conductor está involucrado (como solicitante o destinatario).
  async function listMySwaps(profileId, weekStart) {
    const { data, error } = await sb
      .from('shift_swaps')
      .select('id, requester_id, target_id, week_start_date, from_day, from_shift, to_day, to_shift, note, decided_note, state, decided_at, created_at')
      .eq('week_start_date', weekStart)
      .or(`requester_id.eq.${profileId},target_id.eq.${profileId}`)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async function createSwap({ requesterId, targetId, weekStart, fromDay, fromShift, toDay, toShift, note }) {
    const { data, error } = await sb.from('shift_swaps').insert({
      requester_id: requesterId, target_id: targetId, week_start_date: weekStart,
      from_day: fromDay, from_shift: fromShift, to_day: toDay, to_shift: toShift,
      note: note || null, state: 'pending',
    }).select().single();
    if (error) throw error;
    return data;
  }

  // B decide: 'accepted' | 'rejected'. A puede 'cancelled'.
  async function decideSwap(id, decision, decidedNote) {
    const { error } = await sb.from('shift_swaps').update({
      state: decision, decided_note: decidedNote || null, decided_at: new Date().toISOString(),
    }).eq('id', id);
    if (error) throw error;
  }

  async function getSchedule(weekStart) {
    const { data, error } = await sb
      .from('weekly_schedules')
      .select('id, week_start_date, data, published, created_by, updated_at')
      .eq('week_start_date', weekStart)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  async function saveSchedule(weekStart, data, { published = false, drivers = [] } = {}) {
    const names = {};
    drivers.forEach(d => { names[d.id] = d.name; });
    const payload = { ...data, _names: names };
    const { data: out, error } = await sb
      .from('weekly_schedules')
      .upsert({
        week_start_date: weekStart,
        data: payload,
        published,
      }, { onConflict: 'week_start_date' })
      .select()
      .single();
    if (error) throw error;
    return out;
  }

  // Horarios PUBLICADOS con week_start_date en [fromWeek, toWeek] (para Balance).
  async function listPublishedSchedules(fromWeekISO, toWeekISO) {
    const { data, error } = await sb
      .from('weekly_schedules')
      .select('week_start_date, data')
      .eq('published', true)
      .gte('week_start_date', fromWeekISO)
      .lte('week_start_date', toWeekISO)
      .order('week_start_date');
    if (error) throw error;
    return data || [];
  }

  async function deleteSchedule(weekStart) {
    const { error } = await sb
      .from('weekly_schedules')
      .delete()
      .eq('week_start_date', weekStart);
    if (error) throw error;
  }

  async function getSettings() {
    const sel = cols => sb.from('app_settings').select(cols).eq('id', 'singleton').maybeSingle();
    // Fallback en cascada: de más completo a más básico, así el código tolera
    // migraciones no aplicadas (0014 reopen_*, 0025 coord_slots/shift_hours, 0027 auto_close_hours).
    let { data, error } = await sel('morning_label, afternoon_label, morning_slots, afternoon_slots, reopen_week_start, reopen_until, coord_slots, shift_hours, auto_close_hours');
    if (error) ({ data, error } = await sel('morning_label, afternoon_label, morning_slots, afternoon_slots, reopen_week_start, reopen_until, coord_slots, shift_hours'));
    if (error) ({ data, error } = await sel('morning_label, afternoon_label, morning_slots, afternoon_slots, reopen_week_start, reopen_until'));
    if (error) ({ data, error } = await sel('morning_label, afternoon_label, morning_slots, afternoon_slots'));
    if (error) throw error;
    const base = { morning_label: '02:30 AM - 02:00 PM', afternoon_label: '02:00 PM - 01:30 AM', morning_slots: 2, afternoon_slots: 2, coord_slots: 1, shift_hours: 12, auto_close_hours: 14 };
    return {
      ...base, ...(data || {}),
      reopen_week_start: (data && data.reopen_week_start) || null,
      reopen_until: (data && data.reopen_until) || null,
      coord_slots: (data && data.coord_slots != null) ? data.coord_slots : 1,
      shift_hours: (data && data.shift_hours != null) ? data.shift_hours : 12,
      auto_close_hours: (data && data.auto_close_hours != null) ? data.auto_close_hours : 14,
    };
  }

  async function saveSettings(s) {
    const base = {
      morning_label: s.morning_label,
      afternoon_label: s.afternoon_label,
      morning_slots: s.morning_slots,
      afternoon_slots: s.afternoon_slots,
    };
    const upd = cols => sb.from('app_settings').update(cols).eq('id', 'singleton');
    // Intenta con las columnas nuevas; cae en cascada si la migración no está
    // (0027 auto_close_hours → 0025 coord_slots/shift_hours → base).
    let { error } = await upd({ ...base, coord_slots: s.coord_slots, shift_hours: s.shift_hours, auto_close_hours: s.auto_close_hours });
    if (error) ({ error } = await upd({ ...base, coord_slots: s.coord_slots, shift_hours: s.shift_hours }));
    if (error) ({ error } = await upd(base));
    if (error) throw error;
  }

  // Reapertura temporal de la disponibilidad de una semana (admin).
  // weekStart = lunes ISO; untilISO = timestamp ISO o null para cancelar.
  async function setAvailabilityReopen(weekStart, untilISO) {
    const { error } = await sb
      .from('app_settings')
      .update({
        reopen_week_start: untilISO ? weekStart : null,
        reopen_until: untilISO || null,
      })
      .eq('id', 'singleton');
    if (error) throw error;
  }

  // -------------------- Turno operativo (Etapa 1 módulo conductor) ----------
  // Inicio de turno: vehículo + inspección pre-operacional + fotos + km.
  // Tablas: shifts, inspections, inspection_photos, incidents (migration 0016)
  // + RPCs start_shift / abort_shift (migration 0022).

  // driver_profiles.id del usuario logueado (shifts.driver_id apunta ahí, no a profiles).
  async function getMyDriverProfileId(profileId) {
    const { data, error } = await sb
      .from('driver_profiles')
      .select('id')
      .eq('profile_id', profileId)
      .maybeSingle();
    if (error) throw error;
    return data ? data.id : null;
  }

  async function listVehiclesForShift() {
    const { data, error } = await sb
      .from('vehicles')
      .select('id, internal_code, license_plate, brand, model, capacity, current_km, last_maintenance_km, maintenance_interval_km, status, soat_expires_at, tecnomec_expires_at')
      .is('deleted_at', null)
      .order('internal_code');
    if (error) throw error;
    return data || [];
  }

  // Alta de vehículo (admin, parametrizable desde Ajustes). RLS: p_vehicles_admin_mutate.
  async function createVehicle(v) {
    const { data, error } = await sb.from('vehicles').insert(v).select('id').single();
    if (error) throw error;
    return data.id;
  }

  // Baja lógica (soft delete): conserva el historial de turnos/inspecciones.
  async function softDeleteVehicle(id) {
    const { error } = await sb.from('vehicles').update({ deleted_at: new Date().toISOString() }).eq('id', id);
    if (error) throw error;
  }

  // Turno abierto (no cerrado) del conductor, con datos del vehículo embebidos.
  async function getMyOpenShift(driverId) {
    const { data, error } = await sb
      .from('shifts')
      .select('id, status, vehicle_id, start_at, opening_km, vehicles(internal_code, license_plate, brand, model)')
      .eq('driver_id', driverId)
      .neq('status', 'closed')
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw error;
    return (data && data[0]) || null;
  }

  // Crea el shift en 'inspection_in_progress' (o reutiliza uno huérfano de un
  // intento anterior interrumpido, para no dejar filas basura).
  async function createShiftDraft({ driverId, organizationId, vehicleId, openingKm, reuseId }) {
    if (reuseId) {
      const { data, error } = await sb
        .from('shifts')
        .update({ vehicle_id: vehicleId, opening_km: openingKm, status: 'inspection_in_progress' })
        .eq('id', reuseId)
        .select('id')
        .single();
      if (!error && data) return data.id;
      // si falla (p.ej. lo cerró un admin), cae a crear uno nuevo
    }
    const { data, error } = await sb
      .from('shifts')
      .insert({
        driver_id: driverId,
        organization_id: organizationId,
        vehicle_id: vehicleId,
        opening_km: openingKm,
        status: 'inspection_in_progress',
      })
      .select('id')
      .single();
    if (error) throw error;
    return data.id;
  }

  // Devuelve el id de la inspección 'initial' de un turno si ya existe (null si no).
  // Clave para la idempotencia del inicio de turno: si un intento anterior quedó
  // a medias (red caída, vehículo recién ocupado, etc.) el turno se reutiliza y
  // su inspección ya existe; reusamos su id en vez de crear otra y chocar contra
  // inspections_one_kind_per_shift (UNIQUE shift_id+kind).
  async function getExistingInitialInspectionId(shiftId) {
    if (!shiftId) return null;
    const { data, error } = await sb
      .from('inspections')
      .select('id')
      .eq('shift_id', shiftId)
      .eq('kind', 'initial')
      .limit(1);
    if (error) return null; // ante la duda, que el flujo genere uno nuevo
    return (data && data[0]) ? data[0].id : null;
  }

  // row debe incluir: id (uuid generado/reusado en cliente, para que el path de
  // las fotos exista antes del insert), organization_id, shift_id, vehicle_id,
  // driver_id, kind, odometer_km, checklist, has_damage, notes.
  // Idempotente vía INSERT + captura del duplicado (NO upsert): si este turno ya
  // tiene su inspección inicial (reintento tras un fallo parcial), el INSERT choca
  // con inspections_one_kind_per_shift; eso no es un error real → devolvemos la
  // existente. Se usa insert+catch en vez de upsert porque el upsert dispara la
  // policy UPDATE de RLS, que para el conductor no aplica y rebotaría el reintento.
  async function createInspection(row) {
    let { data, error } = await sb.from('inspections').insert(row).select('id').single();
    // Si la migración 0028 (is_apt/signed_name) no está aplicada, reintenta sin esos campos.
    if (error && /is_apt|signed_name|column|schema cache/i.test(error.message || '')) {
      const { is_apt, signed_name, ...legacy } = row;
      ({ data, error } = await sb.from('inspections').insert(legacy).select('id').single());
    }
    // Reintento idempotente: la inicial ya existe → recuperamos su id sin fallar.
    if (error && /duplicate key|unique|23505|one_kind_per_shift/i.test(error.message || '')) {
      const { data: ex } = await sb.from('inspections')
        .select('id').eq('shift_id', row.shift_id).eq('kind', row.kind).limit(1);
      if (ex && ex[0]) return ex[0].id;
    }
    if (error) throw error;
    return data.id;
  }

  async function uploadInspectionPhoto(path, blob) {
    const { error } = await sb.storage
      .from('inspections')
      .upload(path, blob, { contentType: 'image/jpeg', upsert: true });
    if (error) throw error;
    return path;
  }

  // Idempotente: no reinserta fotos que ya existen (reintento tras fallo parcial).
  // - ángulos fijos: índice único parcial (inspection_id, photo_type) → se omite
  //   si ya hay una de ese tipo (aunque cambie el path) para no violar la unicidad.
  // - damage/extra/admin: pueden ser varias → se deduplican por storage_path.
  async function addInspectionPhotos(rows) {
    if (!rows || !rows.length) return;
    const FIXED = ['front', 'left', 'right', 'rear', 'dashboard'];
    const inspId = rows[0].inspection_id;
    const { data: existing } = await sb
      .from('inspection_photos')
      .select('photo_type,storage_path')
      .eq('inspection_id', inspId);
    const havePath = new Set((existing || []).map(r => r.storage_path));
    const haveFixed = new Set((existing || []).filter(r => FIXED.includes(r.photo_type)).map(r => r.photo_type));
    const fresh = rows.filter(r =>
      !havePath.has(r.storage_path) && !(FIXED.includes(r.photo_type) && haveFixed.has(r.photo_type))
    );
    if (!fresh.length) return;
    const { error } = await sb.from('inspection_photos').insert(fresh);
    if (error) throw error;
  }

  async function addIncident({ organizationId, reporterId, shiftId, vehicleId, category, severity, description }) {
    const { data, error } = await sb.from('incidents').insert({
      organization_id: organizationId,
      reporter_id: reporterId,
      shift_id: shiftId || null,
      vehicle_id: vehicleId || null,
      category,
      severity,
      description,
    }).select('id').single();
    if (error) throw error;
    return data.id;
  }

  // SECURITY DEFINER: valida dueño + inspección + vehículo libre; marca in_use.
  async function startShift(shiftId) {
    const { data, error } = await sb.rpc('start_shift', { p_shift_id: shiftId });
    if (error) throw error;
    return data;
  }

  // SECURITY DEFINER: novedad grave → cierra el shift sin activar y deja el
  // vehículo en 'maintenance' para revisión del admin.
  async function abortShift(shiftId, reason) {
    const { data, error } = await sb.rpc('abort_shift', { p_shift_id: shiftId, p_reason: reason || null });
    if (error) throw error;
    return data;
  }

  // Turnos en curso (no cerrados) para el panel admin "Turnos activos".
  // Incluye las etapas previas a 'active' por si quedó algo a medias.
  async function listActiveShifts() {
    const { data, error } = await sb
      .from('shifts')
      .select('id, status, start_at, opening_km, vehicle_id, ' +
              'vehicles(internal_code, license_plate, brand, model, status), ' +
              'driver_profiles(profiles(id, full_name, email))')
      .neq('status', 'closed')
      .order('start_at', { ascending: true });
    if (error) throw error;
    return data || [];
  }

  // SECURITY DEFINER (solo admin): cierra un turno colgado y libera el vehículo
  // (in_use → available). Para olvidos del conductor; el cierre normal llega en Etapa 2.
  async function forceCloseShift(shiftId, reason) {
    const { data, error } = await sb.rpc('force_close_shift', { p_shift_id: shiftId, p_reason: reason || null });
    if (error) throw error;
    return data;
  }

  // SECURITY DEFINER (solo admin): regresa un vehículo a servicio
  // (maintenance/blocked → available) y reinicia el contador de mantto. Para
  // liberar carros que quedaron bloqueados tras un NO APTO o por el trigger de
  // mantenimiento, ya que el panel de vehículos no tenía cómo desbloquearlos.
  async function returnVehicleToService(vehicleId, reason) {
    const { data, error } = await sb.rpc('return_vehicle_to_service', { p_vehicle_id: vehicleId, p_reason: reason || null });
    if (error) throw error;
    return data;
  }

  // ====================================================================
  // Inspecciones — revisión/aprobación (admin) + checklist configurable
  // ====================================================================

  // Cola de revisión: solo inspecciones INICIALES con novedad (has_damage).
  // Cola admin de inspecciones. Antes filtraba has_damage=true (solo novedades) y
  // por eso las inspecciones limpias —auto-aprobadas por el trigger 0024— no
  // aparecían en Admin→Inspecciones. Ahora trae TODAS las 'initial'; los filtros
  // de la UI (Pendientes/Aprobadas/Rechazadas/Todas) hacen el resto. Las que
  // requieren acción siguen siendo las 'pending' (solo las que tienen novedad).
  async function listInspectionsForReview(status) {
    let q = sb.from('inspections')
      .select('id,kind,has_damage,notes,odometer_km,review_status,reviewed_at,review_notes,performed_at,shift_id,vehicle_id,driver_id,' +
              'vehicles(internal_code,license_plate,brand,model,status,current_km,last_maintenance_km,maintenance_interval_km),' +
              'driver_profiles(profiles(id,full_name,email))')
      .eq('kind', 'initial')
      .order('performed_at', { ascending: false })
      .limit(300);
    if (status) q = q.eq('review_status', status);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }

  // Todas las inspecciones de un vehículo (para el filtro "Autos" del admin).
  async function listInspectionsByVehicle(vehicleId) {
    const { data, error } = await sb.from('inspections')
      .select('id,kind,has_damage,notes,odometer_km,review_status,reviewed_at,review_notes,performed_at,shift_id,vehicle_id,driver_id,checklist,' +
              'vehicles(internal_code,license_plate,brand,model,status),' +
              'driver_profiles(profiles(id,full_name,email))')
      .eq('vehicle_id', vehicleId)
      .order('performed_at', { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async function getInspectionDetail(id) {
    const cols = extra =>
      `id,kind,has_damage,checklist,notes,odometer_km,review_status,reviewed_by,reviewed_at,review_notes,performed_at,shift_id,vehicle_id,driver_id${extra},` +
      'vehicles(internal_code,license_plate,brand,model,status,current_km,last_maintenance_km,maintenance_interval_km),' +
      'driver_profiles(profiles(id,full_name,email)),' +
      'inspection_photos(photo_type,storage_path,size_bytes)';
    // Cascada: con is_apt/signed_name (0028) → sin ellos (legado).
    let { data, error } = await sb.from('inspections').select(cols(',is_apt,signed_name')).eq('id', id).single();
    if (error) ({ data, error } = await sb.from('inspections').select(cols('')).eq('id', id).single());
    if (error) throw error;
    return data;
  }

  // Las fotos viven en un bucket PRIVADO → URLs firmadas (temporales) para mostrarlas.
  async function signedInspectionPhotoUrls(paths, expiresIn) {
    if (!paths || !paths.length) return {};
    const { data, error } = await sb.storage.from('inspections').createSignedUrls(paths, expiresIn || 3600);
    if (error) throw error;
    const map = {};
    (data || []).forEach(r => { if (r.signedUrl && !r.error) map[r.path] = r.signedUrl; });
    return map;
  }

  // Aprobar/rechazar vía RPC SECURITY DEFINER (valida admin; al rechazar abre incident).
  async function reviewInspection(inspectionId, status, notes) {
    const { data, error } = await sb.rpc('review_inspection',
      { p_inspection_id: inspectionId, p_status: status, p_notes: notes || null });
    if (error) throw error;
    return data;
  }

  // ----- Checklist configurable (admin) -----
  async function listChecklistItems(activeOnly) {
    // Cascada: con category (0028) → sin category (legado), tolera migración no aplicada.
    const sel = cols => {
      let q = sb.from('inspection_checklist_items').select(cols).order('sort_order');
      if (activeOnly) q = q.eq('is_active', true);
      return q;
    };
    let { data, error } = await sel('id,label,hint,category,sort_order,is_active');
    if (error) ({ data, error } = await sel('id,label,hint,sort_order,is_active'));
    if (error) throw error;
    return data || [];
  }

  async function createChecklistItem({ organizationId, label, hint, category, sortOrder }) {
    const base = { organization_id: organizationId, label, hint: hint || null, sort_order: sortOrder || 0 };
    const ins = row => sb.from('inspection_checklist_items').insert(row).select('id,label,hint,category,sort_order,is_active').single();
    let { data, error } = await ins({ ...base, category: category || null });
    if (error) ({ data, error } = await sb.from('inspection_checklist_items').insert(base).select('id,label,hint,sort_order,is_active').single());
    if (error) throw error;
    return data;
  }

  async function updateChecklistItem(id, fields) {
    let { error } = await sb.from('inspection_checklist_items').update(fields).eq('id', id);
    // Si la columna category (0028) no está, reintenta sin ella.
    if (error && /category|column|schema cache/i.test(error.message || '') && 'category' in fields) {
      const { category, ...rest } = fields;
      if (Object.keys(rest).length) ({ error } = await sb.from('inspection_checklist_items').update(rest).eq('id', id));
      else error = null;
    }
    if (error) throw error;
  }

  async function deleteChecklistItem(id) {
    const { error } = await sb.from('inspection_checklist_items').delete().eq('id', id);
    if (error) throw error;
  }

  // Reescribe sort_order = posición (1-based). Pocos ítems → updates individuales.
  async function reorderChecklistItems(idsInOrder) {
    for (let i = 0; i < idsInOrder.length; i++) {
      const { error } = await sb.from('inspection_checklist_items')
        .update({ sort_order: i + 1 }).eq('id', idsInOrder[i]);
      if (error) throw error;
    }
  }

  window.Api = {
    signIn, signOut, getSession, getCurrentProfile,
    listDrivers, listAdmins,
    listAllDriversForAdmin, setProfileActive, softDeleteProfile, setAdminCoordinator, setDriverPriority, setDriverCanCoordinate,
    createDriver,
    listSubmittedDriverIds,
    getWeeklyAvailability, getMyWeeklyAvailability,
    upsertAvailabilityRow, saveDriverWeekAvailability,
    getSchedule, saveSchedule, deleteSchedule, listPublishedSchedules,
    getSettings, saveSettings, setAvailabilityReopen,
    listMyApprovalRequests, listPendingApprovals, resolveApproval, runAutoResolve,
    listDriverStrikes, getActiveStrikeCounts, addStrike, voidStrike,
    getWeekSuspensions, getMyWeekSuspension, addManualSuspension, liftSuspension,
    listAcceptedSwaps, listMySwaps, createSwap, decideSwap,
    listDriverRules, rulesToMap, addDriverRule, deleteDriverRule,
    savePushSubscription, deletePushSubscription, sendPush,
    getMyDriverProfileId, listVehiclesForShift, createVehicle, softDeleteVehicle, returnVehicleToService, getMyOpenShift,
    createShiftDraft, createInspection, getExistingInitialInspectionId, uploadInspectionPhoto, addInspectionPhotos,
    addIncident, startShift, abortShift, listActiveShifts, forceCloseShift,
    listInspectionsForReview, listInspectionsByVehicle, getInspectionDetail, signedInspectionPhotoUrls, reviewInspection,
    listChecklistItems, createChecklistItem, updateChecklistItem, deleteChecklistItem, reorderChecklistItems,
  };
})();
