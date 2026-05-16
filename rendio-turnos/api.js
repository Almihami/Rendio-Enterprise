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
    const { data, error } = await sb
      .from('profiles')
      .select('id, full_name, email, role, is_active')
      .eq('role', 'driver')
      .is('deleted_at', null)
      .order('full_name');
    if (error) throw error;
    return (data || []).filter(p => p.is_active !== false).map(p => ({ id: p.id, name: p.full_name, email: p.email }));
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
    const { data, error } = await sb
      .from('profiles')
      .select('id, full_name, email, role, is_active')
      .eq('role', 'driver')
      .is('deleted_at', null)
      .order('full_name');
    if (error) throw error;
    return (data || []).map(p => ({
      id: p.id, name: p.full_name, email: p.email,
      active: p.is_active !== false,
    }));
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
        map[d.id][day] = { am: 'available', pm: 'available', am_reason: null, pm_reason: null };
      });
    });
    rows.forEach(r => {
      const day = Scheduler.DAYS[r.day_of_week];
      if (!day) return;
      map[r.profile_id] = map[r.profile_id] || {};
      map[r.profile_id][day] = {
        am: r.am_state, pm: r.pm_state,
        am_reason: r.am_reason || null, pm_reason: r.pm_reason || null,
      };
    });
    return map;
  }

  async function getWeeklyAvailability(weekStart, drivers) {
    const [availRes, approvalsRes] = await Promise.all([
      sb.from('driver_availability')
        .select('profile_id, day_of_week, am_state, pm_state, am_reason, pm_reason')
        .eq('week_start_date', weekStart),
      sb.from('approval_requests')
        .select('id, profile_id, day_of_week, shift, kind, state, reason, admin_note')
        .eq('week_start_date', weekStart),
    ]);
    if (availRes.error) throw availRes.error;
    if (approvalsRes.error) throw approvalsRes.error;
    const map = toAvailMap(availRes.data || [], drivers);
    (approvalsRes.data || []).forEach(a => {
      const day = Scheduler.DAYS[a.day_of_week];
      if (!day || !map[a.profile_id]) return;
      map[a.profile_id][day][`${a.shift}_request`] = a;
    });
    return map;
  }

  async function getMyWeeklyAvailability(profileId, weekStart) {
    const [availRes, approvalsRes] = await Promise.all([
      sb.from('driver_availability')
        .select('day_of_week, am_state, pm_state, am_reason, pm_reason')
        .eq('profile_id', profileId)
        .eq('week_start_date', weekStart),
      sb.from('approval_requests')
        .select('id, day_of_week, shift, kind, state, reason, admin_note')
        .eq('profile_id', profileId)
        .eq('week_start_date', weekStart),
    ]);
    if (availRes.error) throw availRes.error;
    if (approvalsRes.error) throw approvalsRes.error;
    const own = {};
    Scheduler.DAYS.forEach(d => {
      own[d] = { am: 'available', pm: 'available', am_reason: null, pm_reason: null, am_request: null, pm_request: null };
    });
    (availRes.data || []).forEach(r => {
      const day = Scheduler.DAYS[r.day_of_week];
      if (day) {
        own[day].am = r.am_state;
        own[day].pm = r.pm_state;
        own[day].am_reason = r.am_reason;
        own[day].pm_reason = r.pm_reason;
      }
    });
    (approvalsRes.data || []).forEach(a => {
      const day = Scheduler.DAYS[a.day_of_week];
      if (day) own[day][`${a.shift}_request`] = a;
    });
    return own;
  }

  async function upsertAvailabilityRow({ profileId, weekStart, day, am, pm, am_reason, pm_reason }) {
    const dayIdx = Scheduler.DAY_INDEX[day];
    const { error } = await sb
      .from('driver_availability')
      .upsert({
        profile_id: profileId,
        week_start_date: weekStart,
        day_of_week: dayIdx,
        am_state: am,
        pm_state: pm,
        am_reason: am === 'unavailable' ? am_reason : null,
        pm_reason: pm === 'unavailable' ? pm_reason : null,
      }, { onConflict: 'profile_id,week_start_date,day_of_week' });
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
      };
    });
    const { error } = await sb
      .from('driver_availability')
      .upsert(rows, { onConflict: 'profile_id,week_start_date,day_of_week' });
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

  async function deleteSchedule(weekStart) {
    const { error } = await sb
      .from('weekly_schedules')
      .delete()
      .eq('week_start_date', weekStart);
    if (error) throw error;
  }

  async function getSettings() {
    const { data, error } = await sb
      .from('app_settings')
      .select('morning_label, afternoon_label, morning_slots, afternoon_slots')
      .eq('id', 'singleton')
      .maybeSingle();
    if (error) throw error;
    return data || { morning_label: '02:30 AM - 02:00 PM', afternoon_label: '02:00 PM - 01:30 AM', morning_slots: 2, afternoon_slots: 2 };
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

  window.Api = {
    signIn, signOut, getSession, getCurrentProfile,
    listDrivers, listAdmins,
    listAllDriversForAdmin, setProfileActive, softDeleteProfile, setAdminCoordinator,
    getWeeklyAvailability, getMyWeeklyAvailability,
    upsertAvailabilityRow, saveDriverWeekAvailability,
    getSchedule, saveSchedule, deleteSchedule,
    getSettings, saveSettings,
    listMyApprovalRequests, listPendingApprovals, resolveApproval, runAutoResolve,
  };
})();
