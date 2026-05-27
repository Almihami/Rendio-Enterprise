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
    const v = Math.min(3, Math.max(1, parseInt(value, 10) || 1));
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
    // Fallback: si la migración 0014 (reopen_*) no está, lee sin esas columnas.
    let { data, error } = await sel('morning_label, afternoon_label, morning_slots, afternoon_slots, reopen_week_start, reopen_until');
    if (error) ({ data, error } = await sel('morning_label, afternoon_label, morning_slots, afternoon_slots'));
    if (error) throw error;
    const base = { morning_label: '02:30 AM - 02:00 PM', afternoon_label: '02:00 PM - 01:30 AM', morning_slots: 2, afternoon_slots: 2 };
    return {
      ...base, ...(data || {}),
      reopen_week_start: (data && data.reopen_week_start) || null,
      reopen_until: (data && data.reopen_until) || null,
    };
  }

  async function saveSettings(s) {
    const { error } = await sb
      .from('app_settings')
      .update({
        morning_label: s.morning_label,
        afternoon_label: s.afternoon_label,
        morning_slots: s.morning_slots,
        afternoon_slots: s.afternoon_slots,
      })
      .eq('id', 'singleton');
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
  };
})();
