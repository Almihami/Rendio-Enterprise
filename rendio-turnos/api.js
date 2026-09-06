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

  // ==========================================================================
  // Registro del tripulante (0075 + 0076)
  //
  // Las tres llamadas del alta, en el orden en que ocurren. Viven acá y no en
  // aux-registro.js por la regla de la casa: todo lo que habla con Supabase pasa
  // por api.js.
  //
  // Eran cuatro: en medio iba la verificación del correo con un código. Se sacó
  // el 2026-08-25 porque el correo prestado de Supabase admite ~2 mensajes por
  // hora. Está guardada, entera y probada, en
  // correo-registro/PENDIENTE-verificacion-correo.js.
  // ==========================================================================

  // 1. Crea el usuario y devuelve la sesión — el proyecto tiene «Confirm email»
  //    apagado. El nombre y el teléfono viajan como metadata para poder retomar
  //    el registro si cierra la app antes de terminar (Registro.resume).
  async function signUpAuxiliar({ email, password, fullName, phone }) {
    const { data, error } = await sb.auth.signUp({
      email, password,
      options: { data: { full_name: fullName, phone, pending_role: 'auxiliar' } },
    });
    if (error) throw error;
    // Supabase, con la protección contra enumeración de correos activada,
    // responde 200 y un usuario "vacío" cuando el correo YA existe y está
    // confirmado. No es un éxito: es la forma educada de no confirmar que esa
    // persona tiene cuenta. Se detecta por identities vacío.
    if (data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      throw new Error('User already registered');
    }
    return data;
  }

  // 2. Lo único que puede leer quien ya tiene sesión pero todavía no tiene
  //    perfil. Los conjuntos vienen SIN coordenadas, a propósito (ver 0076).
  async function signupCatalogs() {
    const { data, error } = await sb.rpc('signup_catalogs');
    if (error) throw error;
    return { airlines: data?.airlines || [], residences: data?.residences || [] };
  }

  // 3. El alta. El correo NO se manda: lo lee el servidor de auth.users.
  async function registerAuxiliar(f) {
    const { data, error } = await sb.rpc('register_auxiliar', {
      p_full_name: f.fullName,
      p_phone: f.phone,
      p_airline_id: f.airlineId || null,
      p_residence_id: f.residenceId || null,
      p_residence_unit: f.unit || null,
      p_residence_id_2: f.residenceId2 || null,
      p_residence_unit_2: f.unit2 || null,
      p_home_address: f.address || null,
      p_home_latitude: f.lat != null ? f.lat : null,
      p_home_longitude: f.lng != null ? f.lng : null,
    });
    if (error) throw error;
    return data;
  }

  // ==========================================================================
  // Tripulantes, del lado del admin (0075)
  // ==========================================================================

  // El padrón de tripulantes. p_auxiliar_profiles_select_admin ya deja al admin
  // verlos todos; acá solo se juntan con su perfil, su aerolínea y sus dos
  // unidades para poder pintar una tabla.
  async function listAuxiliares() {
    const COLS = 'id, profile_id, joined_at, airline_id, residence_unit, residence_unit_2, '
      + 'home_address, residence_id, residence_id_2, '
      + 'airlines(id, name), '
      + 'residences!auxiliar_profiles_residence_id_fkey(id, name, sector), '
      + 'res2:residences!auxiliar_profiles_residence_id_2_fkey(id, name, sector), '
      + 'profiles(id, full_name, email, phone, is_active, created_at)';
    let { data, error } = await sb.from('auxiliar_profiles').select(COLS);
    // Si 0075 no estuviera aplicada, se cae a lo que había antes: sin aerolínea
    // ni antigüedad ni segunda unidad, pero con el padrón visible.
    if (error) ({ data, error } = await sb.from('auxiliar_profiles')
      .select('id, profile_id, residence_unit, home_address, residence_id, residences!auxiliar_profiles_residence_id_fkey(id, name, sector), profiles(id, full_name, email, phone, is_active, created_at)'));
    if (error) throw error;
    return (data || [])
      .filter(a => a.profiles && !a.profiles.deleted_at)
      .map(a => ({
        id: a.id, profileId: a.profile_id,
        name: a.profiles?.full_name || '—',
        email: a.profiles?.email || '',
        phone: a.profiles?.phone || '',
        active: a.profiles?.is_active !== false,
        createdAt: a.profiles?.created_at || null,
        joinedAt: a.joined_at || null,
        airlineId: a.airline_id || null,
        airline: a.airlines?.name || '',
        res1: a.residences ? { name: a.residences.name, sector: a.residences.sector } : null,
        unit1: a.residence_unit || '',
        res2: a.res2 ? { name: a.res2.name, sector: a.res2.sector } : null,
        unit2: a.residence_unit_2 || '',
        homeAddress: a.home_address || '',
      }))
      .sort((x, y) => x.name.localeCompare(y.name, 'es'));
  }

  // La corrección de antigüedad de los que ya llevaban tiempo con Rendio. El
  // trigger guard_auxiliar_joined_at() solo la deja pasar si quien llama es
  // admin: acá no hay que comprobar nada, la base lo hace.
  async function setAuxiliarJoinedAt(auxProfileId, isoDate) {
    const { error } = await sb.from('auxiliar_profiles')
      .update({ joined_at: isoDate || null }).eq('id', auxProfileId);
    if (error) throw error;
    return true;
  }

  // --- Catálogo de aerolíneas (lo administra el jefe, sin desplegar código) ---
  async function listAirlines(includeInactive) {
    let q = sb.from('airlines').select('id, name, iata_code, sort_order, is_active')
      .order('sort_order').order('name');
    if (!includeInactive) q = q.eq('is_active', true);
    const { data, error } = await q;
    if (error) return [];
    return data || [];
  }
  async function createAirline({ name, code }) {
    // `state` es un const de core.js (no vive en window): se lee con guarda,
    // igual que en auxiliar.js, para no reventar si el módulo aún no cargó.
    let org = (typeof state !== 'undefined' && state.profile) ? state.profile.organization_id : null;
    if (!org) org = (await getCurrentProfile())?.organization_id;
    if (!org) throw new Error('No pudimos determinar la organización');
    const { error } = await sb.from('airlines').insert({
      organization_id: org, name: (name || '').trim(),
      iata_code: (code || '').trim() || null, sort_order: 100,
    });
    if (error) throw error;
    return true;
  }
  async function setAirlineActive(id, active) {
    const { error } = await sb.from('airlines').update({ is_active: !!active }).eq('id', id);
    if (error) throw error;
    return true;
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
  async function createDriver({ email, password, full_name, phone, priority = 1, can_coordinate = false }) {
    const { data, error } = await sb.functions.invoke('create-driver', {
      // La Edge Function ya aceptaba `phone` (y lo valida) desde siempre; era el
      // formulario el que nunca lo mandaba, y por eso profiles.phone quedó vacío.
      body: { email, password, full_name, phone: phone || null, priority, can_coordinate },
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
    const sel = (cols) => sb.from('profiles').select(cols)
      .eq('role', 'admin').is('deleted_at', null).order('full_name');
    // Cascada: 0063 (receives_ops_alerts) y 0011 (is_coordinator) pueden no
    // estar aplicadas todavía.
    let { data, error } = await sel('id, full_name, email, role, is_active, is_coordinator, receives_ops_alerts');
    if (error) ({ data, error } = await sel('id, full_name, email, role, is_active, is_coordinator'));
    if (error) ({ data, error } = await sel('id, full_name, email, role, is_active'));
    if (error) throw error;
    return (data || [])
      .filter(p => p.is_active !== false)
      .map(p => ({ ...p, is_coordinator: p.is_coordinator !== false, receives_ops_alerts: p.receives_ops_alerts === true }));
  }

  // Quién recibe los avisos de eventualidades en el celular. Si nadie queda
  // marcado, `opsAlertProfileIds` avisa a todos los admins: la operación no se
  // puede quedar muda por un olvido.
  async function setOpsAlerts(profileId, on) {
    const { error } = await sb.from('profiles')
      .update({ receives_ops_alerts: !!on }).eq('id', profileId);
    if (error) throw error;
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

  // Semilla de la semana. Desde el rediseño 2026-08-16 una jornada sin fila en
  // driver_availability es 'unset' (Sin marcar), NO 'available': el conductor que
  // no marcó no entra a la programación y la consolidada lo muestra en gris.
  function toAvailMap(rows, drivers) {
    const map = {};
    drivers.forEach(d => {
      map[d.id] = {};
      Scheduler.DAYS.forEach(day => {
        map[d.id][day] = { am: 'unset', pm: 'unset', am_reason: null, pm_reason: null, shift_pref: 'any' };
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
      own[d] = { am: 'unset', pm: 'unset', am_reason: null, pm_reason: null, shift_pref: 'any', am_request: null, pm_request: null };
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
      const row = ownMap[day] || { am: 'unset', pm: 'unset' };
      return {
        profile_id: profileId,
        week_start_date: weekStart,
        day_of_week: idx,
        am_state: row.am || 'unset',
        pm_state: row.pm || 'unset',
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

  // Quién trabaja por franja el día `day` (YYYY-MM-DD) según el horario PUBLICADO de
  // esa semana. Para rutas: solo se le puede asignar una vuelta a quien está en turno
  // a esa hora. Devuelve { am:[{id,n}], pm:[{id,n}], coordAm, coordPm } o null si no
  // hay horario publicado (el que llama decide el fallback, p.ej. mostrar todos).
  async function listDriversOnShift(day) {
    if (!day) return null;
    const weekStart = (window.Scheduler && Scheduler.startOfWeekISO)
      ? Scheduler.startOfWeekISO(day)
      : (() => { const d = new Date(day + 'T00:00:00'); const wd = d.getDay(); d.setDate(d.getDate() - wd + (wd === 0 ? -6 : 1)); d.setHours(0, 0, 0, 0); return d.toISOString().slice(0, 10); })();
    let sch = null;
    try { sch = await getSchedule(weekStart); } catch (e) { return null; }
    if (!sch || !sch.published || !sch.data) return null;
    const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    const wd = new Date(day + 'T00:00:00').getDay();
    const cell = sch.data[DAYS[(wd + 6) % 7]] || {};
    const names = sch.data._names || {};
    const toDrv = (ids) => [...new Set((ids || []).filter(Boolean))].map(id => ({ id, n: names[id] || 'Conductor' }));
    return { am: toDrv(cell.morning), pm: toDrv(cell.afternoon), coordAm: toDrv(cell.coord_am), coordPm: toDrv(cell.coord_pm) };
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
    // Los parámetros de ruteo NO se estaban seleccionando: el tablero leía
    // state.settings.route_* y siempre le daba undefined, así que caía a los
    // valores fijos del código y "configurable desde Ajustes" era mentira.
    const ROUTE_COLS = ', route_service_min, route_airport_buffer_min, route_traffic_factor, route_turnaround_min, route_deplane_min, route_depart_cushion_min, route_merge_window_min, route_default_capacity, route_airport_leg_min, route_margin_tight_min';
    // 0058: desembarque por aerolínea. Escalón propio de la cascada — si la
    // migración no está, se cae a ROUTE_COLS y el modelo usa route_deplane_min.
    const DEPLANE_COLS = ', route_deplane_av_nac_min, route_deplane_av_int_min, route_deplane_js_nac_min, route_deplane_js_int_min, route_deplane_wingo_min';
    // 0060: factor propio del tramo a/desde MDE. Escalón propio también — sin la
    // migración se cae al escalón de arriba y AIRPORT_FACTOR queda en 1, que es
    // exactamente el comportamiento anterior.
    const AIRPORT_COLS = ', route_airport_factor';
    // 0061: techo de espera del primero recogido. Escalón propio, mismo motivo.
    const WAIT_COLS = ', route_max_wait_min, route_max_wait_peak_min';
    // 0062: corrimiento de domingos y festivos ("no sacarlos tan temprano").
    const HOLIDAY_COLS = ', route_holiday_shift_min';
    // 0069/0070: traslado privado (tarifa, cuál vehículo es la camioneta, el
    // interruptor y la ventana que aparta la camioneta).
    const PRIV_COLS = ', aux_private_price_cop, aux_private_vehicle_id, aux_private_enabled, aux_private_block_min';
    // 0071: colchón que trae adentro su tabla de zona y que no es tiempo de
    // manejo. Escalón propio: sin la migración queda ausente y el solver usa la
    // tabla completa, o sea el comportamiento anterior.
    const CUSHION_COLS = ', route_zone_cushion_min';
    // 0074: cómo despacha Julián — cuántos carros planea el tablero, el rescate
    // ("adelantar antes de dejar sin carro") con su tope de madrugada, y llenar
    // un carro antes de sacar el siguiente. Escalón propio: sin la migración el
    // solver usa sus defaults y el tablero sigue planeando 2 carros.
    const JULIAN_COLS = ', route_cars_count, route_rescue_early, route_rescue_max_early_min, route_car_priority'
      + ', route_sweep_tol_min, route_sweep_slack_pct, route_max_early_min';
    const BASE_COLS = 'morning_label, afternoon_label, morning_slots, afternoon_slots, reopen_week_start, reopen_until, coord_slots, shift_hours, auto_close_hours, reservation_idle_minutes, strike_limit, fast_start_enabled, fast_start_from_hour, fast_start_to_hour, inspection_grace_minutes, aux_wait_minutes, aux_min_lead_hours';
    const CONFIRMADO = BASE_COLS + ROUTE_COLS + DEPLANE_COLS + AIRPORT_COLS + WAIT_COLS + HOLIDAY_COLS;
    let { data, error } = await sel(CONFIRMADO + PRIV_COLS + CUSHION_COLS + JULIAN_COLS);
    if (error) ({ data, error } = await sel(CONFIRMADO + PRIV_COLS + CUSHION_COLS));
    if (error) ({ data, error } = await sel(CONFIRMADO + PRIV_COLS));
    if (error) ({ data, error } = await sel(CONFIRMADO + CUSHION_COLS));
    if (error) ({ data, error } = await sel(BASE_COLS + ROUTE_COLS + DEPLANE_COLS + AIRPORT_COLS + WAIT_COLS + HOLIDAY_COLS));
    if (error) ({ data, error } = await sel(BASE_COLS + ROUTE_COLS + DEPLANE_COLS + AIRPORT_COLS + WAIT_COLS));
    if (error) ({ data, error } = await sel(BASE_COLS + ROUTE_COLS + DEPLANE_COLS + AIRPORT_COLS));
    if (error) ({ data, error } = await sel(BASE_COLS + ROUTE_COLS + DEPLANE_COLS));
    if (error) ({ data, error } = await sel(BASE_COLS + ROUTE_COLS));
    if (error) ({ data, error } = await sel(BASE_COLS));
    if (error) ({ data, error } = await sel('morning_label, afternoon_label, morning_slots, afternoon_slots, reopen_week_start, reopen_until, coord_slots, shift_hours, auto_close_hours, reservation_idle_minutes, strike_limit, fast_start_enabled, fast_start_from_hour, fast_start_to_hour, inspection_grace_minutes'));
    if (error) ({ data, error } = await sel('morning_label, afternoon_label, morning_slots, afternoon_slots, reopen_week_start, reopen_until, coord_slots, shift_hours, auto_close_hours, reservation_idle_minutes, strike_limit'));
    if (error) ({ data, error } = await sel('morning_label, afternoon_label, morning_slots, afternoon_slots, reopen_week_start, reopen_until, coord_slots, shift_hours, auto_close_hours'));
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
      reservation_idle_minutes: (data && data.reservation_idle_minutes != null) ? data.reservation_idle_minutes : 60,
      strike_limit: (data && data.strike_limit != null) ? data.strike_limit : 3,
      fast_start_enabled: (data && data.fast_start_enabled != null) ? data.fast_start_enabled : true,
      fast_start_from_hour: (data && data.fast_start_from_hour != null) ? data.fast_start_from_hour : 12,
      fast_start_to_hour: (data && data.fast_start_to_hour != null) ? data.fast_start_to_hour : 16,
      inspection_grace_minutes: (data && data.inspection_grace_minutes != null) ? data.inspection_grace_minutes : 90,
      aux_wait_minutes: (data && data.aux_wait_minutes != null) ? data.aux_wait_minutes : 5,
      aux_min_lead_hours: (data && data.aux_min_lead_hours != null) ? data.aux_min_lead_hours : 6,
      // El privado arranca APAGADO: sin camioneta elegida ni tarifa confirmada,
      // el auxiliar no debe ver una opción que la operación no puede prestar.
      aux_private_enabled: (data && data.aux_private_enabled != null) ? data.aux_private_enabled : false,
      aux_private_price_cop: (data && data.aux_private_price_cop != null) ? data.aux_private_price_cop : null,
      aux_private_vehicle_id: (data && data.aux_private_vehicle_id) || null,
      // Cuánto queda apartada la camioneta alrededor de un privado. De aquí
      // sale el cupo: NO es route_turnaround_min, que vale 8 y es otra cosa (0070).
      aux_private_block_min: (data && data.aux_private_block_min != null) ? data.aux_private_block_min : 90,
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
    // (0050 aux_wait/aux_lead → 0037 reservation_idle/strike_limit → 0027 auto_close_hours → 0025 coord/shift → base).
    const full = { ...base, coord_slots: s.coord_slots, shift_hours: s.shift_hours, auto_close_hours: s.auto_close_hours, reservation_idle_minutes: s.reservation_idle_minutes, strike_limit: s.strike_limit, fast_start_enabled: s.fast_start_enabled, fast_start_from_hour: s.fast_start_from_hour, fast_start_to_hour: s.fast_start_to_hour, inspection_grace_minutes: s.inspection_grace_minutes };
    const conAux = { ...full, aux_wait_minutes: s.aux_wait_minutes, aux_min_lead_hours: s.aux_min_lead_hours };
    // 0056: parámetros del optimizador. Un escalón más de la cascada.
    const conRuta = { ...conAux,
      route_merge_window_min: s.route_merge_window_min, route_service_min: s.route_service_min,
      route_traffic_factor: s.route_traffic_factor, route_airport_buffer_min: s.route_airport_buffer_min };
    // 0058: desembarque por aerolínea.
    const conDeplane = { ...conRuta,
      route_deplane_av_nac_min: s.route_deplane_av_nac_min, route_deplane_av_int_min: s.route_deplane_av_int_min,
      route_deplane_js_nac_min: s.route_deplane_js_nac_min, route_deplane_js_int_min: s.route_deplane_js_int_min,
      route_deplane_wingo_min: s.route_deplane_wingo_min };
    // 0060: factor del tramo al aeropuerto. 0061: techo de espera.
    const conAero = { ...conDeplane, route_airport_factor: s.route_airport_factor };
    const conTecho = { ...conAero, route_max_wait_min: s.route_max_wait_min, route_max_wait_peak_min: s.route_max_wait_peak_min };
    // 0062: corrimiento de domingos y festivos.
    const conFestivo = { ...conTecho, route_holiday_shift_min: s.route_holiday_shift_min };
    // 0069/0070: traslado privado. 0071: colchón de la tabla de zona. Cada uno
    // baja un escalón si su migración no está, para no perder lo demás.
    const conPrivado = { ...conFestivo,
      aux_private_price_cop: s.aux_private_price_cop,
      aux_private_vehicle_id: s.aux_private_vehicle_id,
      aux_private_enabled: s.aux_private_enabled,
      aux_private_block_min: s.aux_private_block_min };
    // 0074: cómo despacha Julián. Escalón propio arriba de todo, mismo criterio
    // que los anteriores: si la migración no está, se pierde solo esto.
    const conJulian = { ...conPrivado, route_zone_cushion_min: s.route_zone_cushion_min,
      route_cars_count: s.route_cars_count,
      route_rescue_early: s.route_rescue_early,
      route_rescue_max_early_min: s.route_rescue_max_early_min,
      route_car_priority: s.route_car_priority,
      route_sweep_tol_min: s.route_sweep_tol_min,
      route_max_early_min: s.route_max_early_min };
    let { error } = await upd(conJulian);
    if (error) ({ error } = await upd({ ...conPrivado, route_zone_cushion_min: s.route_zone_cushion_min }));
    if (error) ({ error } = await upd(conPrivado));
    if (error) ({ error } = await upd({ ...conFestivo, route_zone_cushion_min: s.route_zone_cushion_min }));
    if (error) ({ error } = await upd(conFestivo));
    if (error) ({ error } = await upd(conTecho));
    if (error) ({ error } = await upd(conAero));
    if (error) ({ error } = await upd(conDeplane));
    if (error) ({ error } = await upd(conRuta));
    if (error) ({ error } = await upd(conAux));
    if (error) ({ error } = await upd(full));
    if (error) ({ error } = await upd({ ...base, coord_slots: s.coord_slots, shift_hours: s.shift_hours, auto_close_hours: s.auto_close_hours, reservation_idle_minutes: s.reservation_idle_minutes, strike_limit: s.strike_limit }));
    if (error) ({ error } = await upd({ ...base, coord_slots: s.coord_slots, shift_hours: s.shift_hours, auto_close_hours: s.auto_close_hours }));
    if (error) ({ error } = await upd({ ...base, coord_slots: s.coord_slots, shift_hours: s.shift_hours }));
    if (error) ({ error } = await upd(base));
    if (error) throw error;
  }

  // Actualiza un vehículo (admin). RLS: p_vehicles_admin_mutate.
  async function updateVehicle(id, patch) {
    const { error } = await sb.from('vehicles').update(patch).eq('id', id);
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
      .select('id, internal_code, license_plate, brand, model, capacity, current_km, last_maintenance_km, maintenance_interval_km, status, soat_expires_at, tecnomec_expires_at, oil_override_at, oil_override_by')
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
      .select('id, status, vehicle_id, start_at, opening_km, inspection_due_at, vehicles(internal_code, license_plate, brand, model)')
      .eq('driver_id', driverId)
      .neq('status', 'closed')
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw error;
    return (data && data[0]) || null;
  }

  // SECURITY DEFINER (conductor): reserva dura del vehículo al entrar a la
  // inspección. Crea/reusa el draft del conductor y marca el vehículo 'reserved'
  // para que otro no lo tome. Lanza VEHICLE_RESERVED_BY_ANOTHER / VEHICLE_IN_USE /
  // VEHICLE_NOT_OPERABLE / ALREADY_ON_SHIFT según el caso. Devuelve { shift_id }.
  async function reserveVehicleForShift(vehicleId, openingKm) {
    const { data, error } = await sb.rpc('reserve_vehicle_for_shift',
      { p_vehicle_id: vehicleId, p_opening_km: (openingKm != null ? openingKm : null) });
    if (error) throw error;
    return data;
  }

  // Crea el shift en 'inspection_in_progress' (o reutiliza uno huérfano de un
  // intento anterior interrumpido, para no dejar filas basura).
  async function createShiftDraft({ driverId, organizationId, vehicleId, openingKm, reuseId }) {
    if (reuseId) {
      const { data, error } = await sb
        .from('shifts')
        .update({ vehicle_id: vehicleId, opening_km: openingKm, status: 'inspection_in_progress' })
        .eq('id', reuseId)
        // NUNCA revivir un turno cerrado. Si lo cerró un admin —o el barrido de
        // reservas abandonadas—, la fila ya tiene end_at y su nota de cierre:
        // devolverla a 'inspection_in_progress' dejaría un turno cerrado y en
        // curso a la vez, y ese turno zombi contaría mal en el Balance. Sin
        // coincidencia, cae abajo y se crea uno nuevo, que es lo correcto.
        .neq('status', 'closed')
        .select('id')
        .single();
      if (!error && data) return data.id;
      // si falla (lo cerraron, o ya no existe), cae a crear uno nuevo
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

  // Estado actual de un vehículo (para saber si quedó en "cambio de aceite" al cerrar).
  async function getVehicleStatus(id) {
    const { data, error } = await sb.from('vehicles').select('status').eq('id', id).limit(1);
    if (error) return null;
    return (data && data[0]) ? data[0].status : null;
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

  // ---- Cierre de turno (Etapa 2) ----

  // Subida genérica al bucket privado 'inspections' (fotos de cierre, video de
  // novedad, comprobantes de tanqueo). contentType según el blob.
  async function uploadShiftFile(path, blob, contentType) {
    const { error } = await sb.storage
      .from('inspections')
      .upload(path, blob, { contentType: contentType || blob.type || 'application/octet-stream', upsert: true });
    if (error) throw error;
    return path;
  }

  // Inserta comprobantes de tanqueo de forma idempotente (no duplica en reintento).
  async function addFuelReceipts(rows) {
    if (!rows || !rows.length) return;
    const shiftId = rows[0].shift_id;
    const { data: existing } = await sb.from('fuel_receipts').select('storage_path').eq('shift_id', shiftId);
    const have = new Set((existing || []).map(r => r.storage_path));
    const fresh = rows.filter(r => !have.has(r.storage_path));
    if (!fresh.length) return;
    const { error } = await sb.from('fuel_receipts').insert(fresh);
    if (error) throw error;
  }

  // SECURITY DEFINER: cierra el turno (inspección final + libera vehículo + novedad).
  //
  // LA CASCADA NO ES ADORNO. Desde 0077 el RPC recibe tres parámetros más (el
  // tanqueo). Si este código llega a un ambiente donde esa migración todavía no
  // está aplicada, la llamada con nueve argumentos falla y EL CONDUCTOR NO PUEDE
  // CERRAR SU TURNO — se queda con el carro tomado y el siguiente no puede
  // arrancar. Por eso se reintenta con la firma vieja de seis, igual que hace
  // saveSettings. Se pierde el dato del tanqueo, no el cierre.
  async function closeShift(shiftId, { closingKm, hasNovedad, novedadText, severity, mediaPaths, fueled, noFuelReasonId, noFuelReason } = {}) {
    const base = {
      p_shift_id: shiftId,
      p_closing_km: closingKm,
      p_has_novedad: !!hasNovedad,
      p_novedad_text: novedadText || null,
      p_severity: severity || 'low',
      p_media_paths: mediaPaths || [],
    };
    let { data, error } = await sb.rpc('close_shift', {
      ...base,
      p_fueled: fueled == null ? null : !!fueled,
      p_no_fuel_reason_id: noFuelReasonId || null,
      p_no_fuel_reason: noFuelReason || null,
    });
    // PGRST202 / 42883 = no existe una función con esa firma → base sin 0077.
    if (error && /PGRST202|42883|Could not find the function|does not exist/i.test(error.code + ' ' + error.message)) {
      ({ data, error } = await sb.rpc('close_shift', base));
    }
    if (error) throw error;
    return data;
  }

  // Catálogo de motivos de "no pude tanquear" (0077). Lo edita el admin; el
  // conductor solo lo lee. Devuelve [] si la migración no está: el cierre
  // entonces se comporta como antes en vez de tirar.
  async function listNoFuelReasons() {
    try {
      const { data, error } = await sb.from('no_fuel_reasons')
        .select('id, label, requires_text, sort_order')
        .eq('is_active', true)
        .order('sort_order', { ascending: true });
      if (error) return [];
      return data || [];
    } catch (e) { return []; }
  }

  // Admin: cómo quedó el tanqueo de un turno. Va aparte de los comprobantes
  // porque un turno sin recibos puede tener motivo, y uno viejo no tiene ni lo
  // uno ni lo otro (fueled = null, "no se preguntó").
  async function getShiftFuelStatus(shiftId) {
    try {
      const { data, error } = await sb.from('shifts')
        .select('fueled, no_fuel_reason')
        .eq('id', shiftId)
        .maybeSingle();
      if (error) return null;
      return data || null;
    } catch (e) { return null; }
  }

  // Admin: todas las inspecciones de un turno (inicial + final) para la tarjeta.
  async function listInspectionsByShift(shiftId) {
    const { data, error } = await sb.from('inspections')
      .select('id,kind,has_damage,checklist,notes,odometer_km,review_status,performed_at,' +
              'inspection_photos(photo_type,storage_path,size_bytes)')
      .eq('shift_id', shiftId)
      .order('kind', { ascending: true });
    if (error) throw error;
    return data || [];
  }

  // Comprobantes de tanqueo de un turno (conductor: los suyos; admin: de su org).
  async function listFuelReceiptsForShift(shiftId) {
    const { data, error } = await sb.from('fuel_receipts')
      .select('id, amount_cop, storage_path, created_at')
      .eq('shift_id', shiftId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data || [];
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

  // Novedades/incidents para el admin: cola con estado + evidencia. `status`:
  // 'open' | 'in_progress' | 'resolved' | 'all' (o nada = todas). `scope`:
  // 'flota' (novedades del vehículo) | 'operacion' (eventualidades de traslado).
  //
  // El scope NO es opcional en la práctica: sin él, la cola de Inspecciones
  // empezaría a mostrar trancones y fallas de ruta. Va como último escalón de la
  // cascada por si la 0063 aún no está aplicada — ahí el comportamiento vuelve a
  // ser el de antes (todo junto), que es lo que había.
  async function listIncidents(status, scope) {
    const base = 'id,shift_id,vehicle_id,reporter_id,category,severity,status,description,' +
      'photo_paths,resolution_notes,resolved_at,created_at,' +
      'vehicles(internal_code,license_plate,brand,model)';
    const run = (sel, useScope) => {
      let q = sb.from('incidents').select(sel).order('created_at', { ascending: false }).limit(300);
      if (status && status !== 'all') q = q.eq('status', status);
      if (useScope && scope) q = q.eq('scope', scope);
      return q;
    };
    let { data, error } = await run(base + ',reporter:profiles!reporter_id(id,full_name)', true);
    if (error) ({ data, error } = await run(base, true));
    if (error) ({ data, error } = await run(base, false));
    if (error) throw error;
    return data || [];
  }

  // Conteo rápido de novedades ABIERTAS (para el badge de la pestaña).
  async function countOpenIncidents(scope) {
    const run = (useScope) => {
      let q = sb.from('incidents').select('id', { count: 'exact', head: true }).eq('status', 'open');
      if (useScope && scope) q = q.eq('scope', scope);
      return q;
    };
    let { count, error } = await run(true);
    if (error) ({ count, error } = await run(false));
    if (error) throw error;
    return count || 0;
  }

  // ---- Eventualidades de operación (0062/0063) ----

  // Reporta una eventualidad durante un traslado. Pasa por el RPC, que valida que
  // quien reporta esté vinculado a la reserva y deriva turno, vehículo, ruta y
  // parada: el cliente no elige nada de eso.
  async function reportIncident({ category, description, severity, reservationId, details, latitude, longitude, photoPaths }) {
    const { data, error } = await sb.rpc('report_incident', {
      p_category: category,
      p_description: description,
      p_severity: severity || 'medium',
      p_reservation_id: reservationId || null,
      p_details: details || {},
      p_latitude: latitude != null ? latitude : null,
      p_longitude: longitude != null ? longitude : null,
      p_photo_paths: photoPaths || [],
    });
    if (error) throw error;
    return data;
  }

  // La bandeja del jefe. Trae el contexto que hace falta para decidir sin salir
  // de la pantalla: quién reportó, de qué traslado es, dónde pasó y con qué carro.
  async function listEventualidades(status) {
    const base = 'id,category,severity,status,description,details,source,scope,' +
      'latitude,longitude,occurred_at,created_at,acknowledged_at,resolved_at,' +
      'resolution_notes,photo_paths,reservation_id,route_assignment_id,vehicle_id,' +
      'vehicles(internal_code,license_plate,brand,model)';
    const aux = ',reservations(pickup_address,required_arrival_at,direction,' +
      'auxiliar_profiles(profiles(id,full_name,phone)))';
    const rep = ',reporter:profiles!reporter_id(id,full_name,role)';
    const run = (sel) => {
      let q = sb.from('incidents').select(sel)
        .eq('scope', 'operacion')
        .order('created_at', { ascending: false }).limit(200);
      if (status && status !== 'all') q = q.eq('status', status);
      return q;
    };
    let { data, error } = await run(base + aux + rep);
    if (error) ({ data, error } = await run(base + rep));
    if (error) ({ data, error } = await run(base));
    if (error) throw error;
    return data || [];
  }

  // Salud del canal de avisos (0066). Si el despacho se cae, "no llegó ninguna
  // alerta" y "no pasó nada" se ven exactamente igual — y el jefe se entera el
  // día que algo grave no le sonó. Esto lo hace visible.
  async function opsAlertHealth() {
    const { data, error } = await sb.rpc('ops_alert_health');
    if (error) return null; // 0066 sin aplicar: la pantalla simplemente no lo muestra
    return data;
  }

  async function countOpenEventualidades() {
    const { count, error } = await sb.from('incidents')
      .select('id', { count: 'exact', head: true })
      .eq('scope', 'operacion').eq('status', 'open');
    if (error) return 0; // 0063 sin aplicar: la bandeja simplemente no tiene nada
    return count || 0;
  }

  // "La vi". Distinto de atenderla: sirve para saber que el aviso de madrugada
  // llegó a un ser humano. No se pisa el acuse original si ya estaba.
  async function acknowledgeIncident(id) {
    const session = await getSession();
    const me = session && session.user ? session.user.id : null;
    const { error } = await sb.from('incidents')
      .update({ acknowledged_at: new Date().toISOString(), acknowledged_by: me })
      .eq('id', id).is('acknowledged_at', null);
    if (error) throw error;
  }

  // A quién se le avisa una eventualidad. Los marcados en Personal; y si NADIE
  // está marcado, a todos los admins activos: una operación sin nadie marcado no
  // puede quedarse muda — ese es justo el problema que vinimos a resolver.
  async function opsAlertProfileIds() {
    const activos = (rows) => (rows || []).filter(p => p.is_active !== false).map(p => p.id);
    try {
      const { data, error } = await sb.from('profiles')
        .select('id,is_active').eq('role', 'admin')
        .eq('receives_ops_alerts', true).is('deleted_at', null);
      if (!error) {
        const ids = activos(data);
        if (ids.length) return ids;
      }
    } catch (_) { /* 0063 sin aplicar: cae al listado completo */ }
    const { data } = await sb.from('profiles')
      .select('id,is_active').eq('role', 'admin').is('deleted_at', null);
    return activos(data);
  }

  // Cambia el estado de una novedad. Al resolver sella resolved_at + notas; al reabrir los limpia.
  async function updateIncidentStatus(id, status, resolutionNotes) {
    const patch = { status };
    if (status === 'resolved') {
      patch.resolved_at = new Date().toISOString();
      if (resolutionNotes != null) patch.resolution_notes = resolutionNotes;
    } else {
      patch.resolved_at = null;
    }
    const { error } = await sb.from('incidents').update(patch).eq('id', id);
    if (error) throw error;
  }

  // SECURITY DEFINER: valida dueño + inspección + vehículo libre; marca in_use.
  async function startShift(shiftId) {
    const { data, error } = await sb.rpc('start_shift', { p_shift_id: shiftId });
    if (error) throw error;
    return data;
  }

  // SECURITY DEFINER: inicia el turno SIN inspección (diferida), con plazo. Valida
  // la ventana horaria con la hora del servidor.
  async function startShiftDeferred(shiftId, openingKm) {
    const { data, error } = await sb.rpc('start_shift_deferred', { p_shift_id: shiftId, p_opening_km: openingKm });
    if (error) throw error;
    return data;
  }

  // Limpia el plazo de inspección de un turno (al completar la inspección diferida).
  async function clearInspectionDue(shiftId) {
    const { error } = await sb.from('shifts').update({ inspection_due_at: null }).eq('id', shiftId);
    if (error) throw error;
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

  // El conductor desbloquea un carro detenido por cambio de aceite, bajo su
  // responsabilidad (0041). No reinicia el contador; devuelve admin_ids para el
  // push de aviso a los administradores.
  async function driverOverrideOilBlock(vehicleId) {
    const { data, error } = await sb.rpc('driver_override_oil_block', { p_vehicle_id: vehicleId });
    if (error) throw error;
    return data;
  }

  // El admin registra el cambio de aceite: reinicia el contador, limpia el
  // override del conductor y regresa a servicio si estaba bloqueado (0041).
  async function registerOilChange(vehicleId, reason) {
    const { data, error } = await sb.rpc('register_oil_change', { p_vehicle_id: vehicleId, p_reason: reason || null });
    if (error) throw error;
    return data;
  }

  // ====================================================================
  // Repuestos — mantenimiento preventivo por pieza (0073)
  // ====================================================================
  // El odómetro no se pide aquí: entra solo con la inspección de inicio de
  // turno y sube vehicles.current_km. El jefe carga UNA vez el km del último
  // cambio de cada repuesto y el semáforo se recalcula turno a turno.

  // Semáforo por vehículo × repuesto. light: nodata | green | amber | red.
  async function listPartStatus() {
    const { data, error } = await sb
      .from('v_vehicle_part_status')
      .select('*')
      .order('internal_code')
      .order('sort_order');
    if (error) throw error;
    return data || [];
  }

  async function listPartCatalog() {
    const { data, error } = await sb
      .from('part_catalog')
      .select('id, code, name, system, interval_km, interval_months, reference_particular, is_critical, note, sort_order, is_active')
      .eq('is_active', true)
      .order('sort_order');
    if (error) throw error;
    return data || [];
  }

  // Duración real medida en nuestra operación. is_reliable = 3+ cambios.
  async function listPartRealLife() {
    const { data, error } = await sb.from('v_part_real_life').select('*');
    if (error) throw error;
    return data || [];
  }

  // Historial de cambios. Trae el repuesto para poder comparar contra el intervalo.
  async function listPartHistory(vehicleId, status) {
    let q = sb.from('maintenance')
      .select('id, vehicle_id, part_id, maintenance_type, km_at_event, duration_km, cost_cop, shop, notes, performed_at, status, reported_by, part_catalog(code, name, interval_km), vehicles(internal_code)')
      .not('part_id', 'is', null)
      .order('performed_at', { ascending: false })
      .limit(200);
    if (vehicleId) q = q.eq('vehicle_id', vehicleId);
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }

  // Carga inicial del jefe: km y fecha del último cambio de cada repuesto.
  // Lo que no sepa va sin last_change_km y queda como "sin dato" a propósito.
  async function setVehiclePartBaseline(vehicleId, entries) {
    const { data, error } = await sb.rpc('set_vehicle_part_baseline', {
      p_vehicle_id: vehicleId, p_entries: entries,
    });
    if (error) throw error;
    return data;
  }

  // Admin = queda confirmado y reinicia el semáforo. Conductor = queda pendiente.
  async function registerPartChange(o) {
    const { data, error } = await sb.rpc('register_part_change', {
      p_vehicle_id: o.vehicleId, p_part_code: o.partCode, p_km: o.km,
      p_date: o.date || null, p_cost: o.cost != null ? o.cost : null,
      p_shop: o.shop || null, p_notes: o.notes || null,
    });
    if (error) throw error;
    return data;
  }

  async function confirmPartChange(maintenanceId, accept) {
    const { data, error } = await sb.rpc('confirm_part_change', {
      p_maintenance_id: maintenanceId, p_accept: accept !== false,
    });
    if (error) throw error;
    return data;
  }

  async function correctVehicleOdometer(vehicleId, km, reason) {
    const { data, error } = await sb.rpc('correct_vehicle_odometer', {
      p_vehicle_id: vehicleId, p_km: km, p_reason: reason || null,
    });
    if (error) throw error;
    return data;
  }

  // vehicleId null = cambia el intervalo para toda la flota; con id = excepción
  // para ese carro (Logan, Spark y Picanto no comparten correa ni caja).
  async function setPartInterval(partCode, intervalKm, vehicleId) {
    const { data, error } = await sb.rpc('set_part_interval', {
      p_part_code: partCode, p_interval_km: intervalKm, p_vehicle_id: vehicleId || null,
    });
    if (error) throw error;
    return data;
  }

  async function listInspectionTiers() {
    const { data, error } = await sb
      .from('inspection_tiers').select('every_km, title').eq('is_active', true).order('every_km');
    if (error) throw error;
    return data || [];
  }

  // Niveles preventivos que el carro ya cruzó y todavía no se le han hecho.
  async function pendingInspectionTiers(vehicleId) {
    const { data, error } = await sb.rpc('pending_inspection_tiers', { p_vehicle_id: vehicleId });
    if (error) throw error;
    return data || [];
  }

  async function markInspectionTiersDone(vehicleId, km) {
    const { data, error } = await sb.rpc('mark_inspection_tiers_done', { p_vehicle_id: vehicleId, p_km: km });
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
  async function listChecklistItems(activeOnly, includeTiers) {
    // Cascada: con category (0028) → sin category (legado), tolera migración no aplicada.
    // Desde 0073 hay ítems que solo aplican a un nivel preventivo (5k/10k/20k/40k):
    // no son del checklist de todos los días, así que se excluyen salvo que se
    // pidan explícitamente (Ajustes, para poder configurarlos).
    const sel = (cols, tierFilter) => {
      let q = sb.from('inspection_checklist_items').select(cols).order('sort_order');
      if (activeOnly) q = q.eq('is_active', true);
      if (tierFilter) q = q.is('tier_every_km', null);
      return q;
    };
    const tf = !includeTiers;
    let { data, error } = await sel('id,label,hint,category,sort_order,is_active', tf);
    if (error) ({ data, error } = await sel('id,label,hint,sort_order,is_active', tf));
    if (error) ({ data, error } = await sel('id,label,hint,sort_order,is_active', false));
    if (error) throw error;
    return data || [];
  }

  // Ítems extra de los niveles preventivos que el carro ya cruzó (0073). Se
  // suman al checklist del día solo en el turno en que toca la revisión.
  async function listChecklistItemsForTiers(tierKms) {
    if (!tierKms || !tierKms.length) return [];
    const { data, error } = await sb
      .from('inspection_checklist_items')
      .select('id,label,hint,category,sort_order,is_active,tier_every_km')
      .eq('is_active', true)
      .in('tier_every_km', tierKms)
      .order('sort_order');
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

  // ====================================================================
  // Perfil del conductor (Fase B)
  // ====================================================================
  async function getMyFullProfile() {
    const session = await getSession();
    if (!session) return null;
    const { data: p, error } = await sb.from('profiles')
      .select('id, full_name, email, role, organization_id, is_active, phone, avatar_url, document_id, home_base')
      .eq('id', session.user.id).single();
    if (error) throw error;
    let dp = null;
    try {
      const r = await sb.from('driver_profiles')
        .select('id, license_number, license_expires_at, eps_provider, arl_provider')
        .eq('profile_id', session.user.id).limit(1);
      dp = (r.data && r.data[0]) || null;
    } catch (e) { /* sin driver_profile */ }
    return Object.assign({}, p, { driver: dp });
  }

  // Sube el avatar al bucket público 'profiles' (nombre = {uid}.jpg) y guarda la URL.
  async function uploadMyAvatar(blob) {
    const session = await getSession();
    if (!session) throw new Error('NO_SESSION');
    const path = `${session.user.id}.jpg`;
    const { error } = await sb.storage.from('profiles').upload(path, blob, { contentType: 'image/jpeg', upsert: true });
    if (error) throw error;
    const { data } = sb.storage.from('profiles').getPublicUrl(path);
    const url = (data.publicUrl || '') + '?t=' + Date.now(); // cache-bust
    const { error: e2 } = await sb.from('profiles').update({ avatar_url: url }).eq('id', session.user.id);
    if (e2) throw e2;
    return url;
  }

  // ====================================================================
  // Recompensas por km (Fase D)
  // ====================================================================
  async function listRewards() {
    const { data, error } = await sb.from('rewards')
      .select('id, tier, km_threshold, title, description, active, sort_order')
      .eq('active', true).order('km_threshold', { ascending: true });
    if (error) throw error;
    return data || [];
  }

  // Turnos cerrados del conductor (para "Mi kilometraje" + total acumulado).
  async function listMyClosedShifts(driverId) {
    const { data, error } = await sb.from('shifts')
      .select('id, start_at, end_at, opening_km, closing_km, vehicles(internal_code, license_plate)')
      .eq('driver_id', driverId).eq('status', 'closed')
      .not('closing_km', 'is', null)
      .order('end_at', { ascending: false }).limit(90);
    if (error) throw error;
    return data || [];
  }

  // Redención validada en servidor (km, recompensa activa, sin duplicado).
  async function redeemReward(rewardId) {
    const { data, error } = await sb.rpc('redeem_reward', { p_reward_id: rewardId });
    if (error) throw error;
    return data;
  }

  async function listMyRedemptions(driverId) {
    const { data, error } = await sb.from('reward_redemptions')
      .select('id, reward_id, status, requested_at, resolved_at')
      .eq('driver_id', driverId).order('requested_at', { ascending: false });
    if (error) throw error;
    return data || [];
  }

  // ----- Admin: recompensas -----
  async function createReward(row) {
    const { data, error } = await sb.from('rewards').insert(row).select('id').single();
    if (error) throw error;
    return data.id;
  }
  async function updateReward(id, patch) {
    const { error } = await sb.from('rewards').update(patch).eq('id', id);
    if (error) throw error;
  }
  async function deleteReward(id) {
    const { error } = await sb.from('rewards').delete().eq('id', id);
    if (error) throw error;
  }
  async function listAllRewards() {
    const { data, error } = await sb.from('rewards')
      .select('id, tier, km_threshold, title, description, active, sort_order')
      .order('km_threshold', { ascending: true });
    if (error) throw error;
    return data || [];
  }
  async function listRedemptionsAdmin(status) {
    let q = sb.from('reward_redemptions')
      .select('id, status, km_at_request, requested_at, resolved_at, notes, reward_id, ' +
              'rewards(title, tier, km_threshold), driver_profiles(profiles(id, full_name))')
      .order('requested_at', { ascending: false });
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }
  async function resolveRedemption(id, status, notes) {
    const session = await getSession();
    const patch = (status === 'pending')
      ? { status, notes: notes || null, resolved_at: null, resolved_by: null } // deshacer
      : { status, notes: notes || null, resolved_at: new Date().toISOString(), resolved_by: session ? session.user.id : null };
    const { error } = await sb.from('reward_redemptions').update(patch).eq('id', id);
    if (error) throw error;
  }
  // Admin: turnos cerrados de toda la org (para km acumulado por conductor).
  // Incluye driver_profiles.profile_id para poder agrupar por persona (la lista de
  // Personal usa profile_id; los turnos usan driver_id = driver_profiles.id).
  async function listClosedShiftsAdmin() {
    const { data, error } = await sb.from('shifts')
      .select('driver_id, opening_km, closing_km, driver_profiles(profile_id, profiles(full_name))')
      .eq('status', 'closed').not('closing_km', 'is', null);
    if (error) throw error;
    return data || [];
  }

  // ════════════════════════════════════════════════════════════════════
  // RUTAS DE AUXILIARES — planeación (tablero de Asignación)
  // ════════════════════════════════════════════════════════════════════
  const RT_PALETTE = ['#3B82F6', '#0EA5A0', '#8B5CF6', '#2563A8', '#16936A', '#7C5CD6', '#D98A12', '#0EA5E9', '#E2551A', '#DB4B7A', '#5B8A2B'];
  function rtHHMM(iso) { try { const d = new Date(iso); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); } catch (_) { return '05:00'; } }

  // Arma el tablero del día a partir de reservas reales. Devuelve
  // {aux, colors, cars, drivers, plan} o NULL si no hay reservas/vehículos
  // (entonces la UI muestra datos de ejemplo). El cálculo fino de tramos y
  // orden óptimo (OSRM/VROOM) es el siguiente paso: aquí 'tramo' es un estimado.
  // Lee las reservas del PRÓXIMO día operativo (todas las direcciones) con
  // coordenadas, en el formato que consume el motor de rutas (admin-rutas).
  // Devuelve null → el tablero queda vacío y dice qué falta (ya no hay demo).
  // ── Tablas de tiempos de Julián (0062) ────────────────────────────────────
  // Devuelve null si la migración no está: el tablero entonces programa como
  // siempre (modelo calculado con OSRM). Nunca tira — que falte la tabla no
  // puede tumbar el tablero.
  async function getRouteTables(day) {
    const out = { zonas: {}, tramos: [], esFestivo: false, esDomingo: false, sinConfirmar: [] };
    try {
      const [z, l] = await Promise.all([
        sb.from('route_zone_times').select('zone, band_from, band_to, min_minutes, max_minutes, asumida'),
        sb.from('route_leg_times').select('band_from, band_to, min_minutes, max_minutes, asumida'),
      ]);
      if (z.error || l.error) return null;
      (z.data || []).forEach(r => { (out.zonas[r.zone] = out.zonas[r.zone] || []).push(r); });
      Object.values(out.zonas).forEach(a => a.sort((x, y) => x.band_from - y.band_from));
      out.tramos = (l.data || []).sort((x, y) => x.band_from - y.band_from);
    } catch (e) { return null; }
    // Domingo se saca de la fecha; festivo, de la tabla (en Colombia se corren
    // al lunes, así que no hay regla de fecha fija que valga).
    if (day) {
      // 'YYYY-MM-DD' + T12:00 para que el huso no corra el día.
      out.esDomingo = new Date(day + 'T12:00:00').getDay() === 0;
      try {
        const { data } = await sb.from('holidays').select('day, name').eq('day', day).maybeSingle();
        if (data) { out.esFestivo = true; out.festivo = data.name; }
      } catch (e) { /* sin tabla de festivos → solo domingos */ }
    }
    // Conjuntos que Julián todavía no ha clasificado: se listan para poder
    // preguntarle, y mientras tanto se programan con el modelo calculado.
    try {
      const { data } = await sb.from('residences').select('name').is('zona_jefe', null).eq('is_active', true).order('name');
      out.sinConfirmar = (data || []).map(r => r.name);
    } catch (e) { /* sin la columna → nada que reportar */ }
    return out;
  }

  // Guarda la tabla editada desde Ajustes. Cada fila trae su llave natural
  // (zona + franja), así que va por update, no por delete+insert: si a alguien
  // se le cae la conexión a la mitad no se queda la operación sin tabla.
  async function saveRouteTables(zonas, tramos) {
    for (const r of zonas || []) {
      const { error } = await sb.from('route_zone_times')
        .update({ min_minutes: r.min_minutes, max_minutes: r.max_minutes, asumida: false })
        .eq('zone', r.zone).eq('band_from', r.band_from);
      if (error) throw error;
    }
    for (const r of tramos || []) {
      const { error } = await sb.from('route_leg_times')
        .update({ min_minutes: r.min_minutes, max_minutes: r.max_minutes, asumida: false })
        .eq('band_from', r.band_from);
      if (error) throw error;
    }
  }

  // Catálogo de residencias con su zona, para la pantalla donde se clasifican.
  async function listResidencesZones() {
    const { data, error } = await sb.from('residences')
      .select('id, name, sector, zona_jefe').eq('is_active', true).order('name');
    if (error) throw error;
    return data || [];
  }

  // Admin: TODOS los turnos cuyo start_at cae en [fromISO, toISO). Trae los campos
  // para calcular horas reales trabajadas (inicio→cierre) y clasificar el turno:
  // completo, auto-cerrado (por el cron, sin km de cierre), arranque falso
  // (sin km de apertura) o en curso (sin cierre). Lo usa el Balance real.
  async function listShiftsForBalance(fromISO, toISO) {
    const { data, error } = await sb.from('shifts')
      .select('id, status, start_at, end_at, opening_km, closing_km, driver_id, ' +
              'driver_profiles(profile_id, profiles(full_name, email))')
      .gte('start_at', fromISO).lt('start_at', toISO)
      .order('start_at', { ascending: true });
    if (error) throw error;
    return data || [];
  }

  async function saveResidenceZone(id, zona) {
    const { error } = await sb.from('residences').update({ zona_jefe: zona || null }).eq('id', id);
    if (error) throw error;
  }

  async function listRoutePlanning(tripType) {
    // Día en hora de COLOMBIA (no UTC): un viaje de las 21:10 Col NO debe rodar
    // al día siguiente (21:10 Col = 02:10 UTC). Agrupamos por America/Bogota.
    const bogDay = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    let rows = null;
    try {
      // Ventana amplia en UTC (ayer→) para no perder madrugadas de Colombia;
      // el filtro fino por día operativo se hace abajo en hora local.
      const floor = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
      // El tablero mostraba solo nombre y zona: para decidir un cambio de ruta el
      // admin tenía que abrir Reservas en otra pestaña. Se traen también vuelo,
      // teléfono, notas y pernocta. Defensivo igual que listMyReservations: si
      // 0050 no está aplicada, se reintenta sin las columnas nuevas.
      const COLS = 'id, direction, pickup_address, pickup_latitude, pickup_longitude, required_arrival_at, status_h2a, status_a2h, notes, auxiliar_profiles(profiles(full_name, phone)), flights(flight_number)';
      const q = cols => sb.from('reservations').select(cols)
        .is('cancelled_at', null)
        .gte('required_arrival_at', floor)
        .order('required_arrival_at', { ascending: true });
      // La residencia (0055) es lo que permite tratar una portería como UNA
      // parada: dos tripulantes del mismo conjunto son un solo frenazo. Va en
      // su propio reintento porque main todavía no tiene la 0055.
      // 0062: la zona de Julián viaja pegada a la residencia. Escalón propio de
      // la cascada: sin la migración se cae al select de al lado y el tablero
      // programa con el modelo calculado, como antes.
      let res = await q(COLS + ', is_overnight, is_firm, residence_id, residences(name, zona_jefe)');
      if (res.error) res = await q(COLS + ', is_overnight, is_firm, residence_id, residences(name)');
      if (res.error) res = await q(COLS + ', is_overnight, is_firm');
      if (res.error) res = await q(COLS);
      if (res.error) throw res.error;
      rows = res.data;
    } catch (e) { return null; } // RLS / tabla ausente → demo
    if (!rows || !rows.length) return null;

    // Día operativo más próximo (en hora de Colombia) con reservas.
    const todayBog = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    const upcoming = rows.filter(r => bogDay(r.required_arrival_at) >= todayBog);
    if (!upcoming.length) return null;
    const day0 = bogDay(upcoming[0].required_arrival_at);
    rows = upcoming.filter(r => bogDay(r.required_arrival_at) === day0);

    const aux = {}, colors = {};
    rows.forEach((r, i) => {
      const key = 'r' + String(r.id).slice(0, 8);
      const type = r.direction === 'airport_to_home' ? 'lle' : 'sal';
      const parts = (r.pickup_address || '').split(',');
      aux[key] = {
        n: r.auxiliar_profiles?.profiles?.full_name || 'Auxiliar',
        // La zona sale del catálogo cuando existe. Partir la dirección por comas
        // era adivinar: si el auxiliar escribía "…, El Porvenir, Rionegro" la
        // zona de todos quedaba "Rionegro" y el agrupamiento no servía de nada.
        zona: r.residences?.name
          || (parts.length > 1 ? parts[parts.length - 1] : parts[0] || '—').trim(),
        // Llave de PARADA: dos reservas de la misma residencia son una portería.
        resId: r.residence_id || null,
        // Zona de la tabla de tiempos de Julián (0062). null = todavía no la
        // confirmó para ese conjunto → esa parada se programa como antes.
        zonaJefe: r.residences?.zona_jefe || null,
        dir: r.pickup_address || '',
        lat: r.pickup_latitude, lng: r.pickup_longitude,
        dl: rtHHMM(r.required_arrival_at),
        pax: 1, type, reservationId: r.id,
        // Contexto para decidir sin salir del tablero.
        tel: r.auxiliar_profiles?.profiles?.phone || '',
        // El número de vuelo decide cuánto tarda el desembarque (0058), así que
        // ya no vale reconocer solo los "AV1234": el formulario deja escribir
        // JA5116, P57433 o los dígitos pelados, y todos cuentan.
        vuelo: r.flights?.flight_number
          || (r.notes || '').match(/vuelo\s*:?\s*([A-Za-z]{0,3}\s?-?\d{2,5})/i)?.[1]?.replace(/[\s-]/g, '').toUpperCase()
          || '',
        notas: r.notes || '',
        // 'hotel' es el flag que el tablero ya sabía pintar (chip "Hotel"), pero
        // nadie se lo llenaba: la pernocta se preguntaba y se perdía.
        hotel: !!r.is_overnight,
      };
      colors[key] = RT_PALETTE[i % RT_PALETTE.length];
    });

    // Carros: SOLO vehículos reales de la flota. Antes, si no había vehículos,
    // se inventaban un RD-01 y un RD-02 — y el admin podía armar y publicar un
    // plan contra carros que no existen (saveRoutePlan los descarta sin
    // vehicleId, así que el plan se perdía en silencio). Sin vehículos se
    // devuelve `noVehicles` y el tablero lo dice.
    let cars = [];
    try {
      const vs = await listVehiclesForShift();
      // CUÁNTOS CARROS PLANEA EL TABLERO. Estaba clavado en 2 y por eso el
      // tercer vehículo de la flota no existía para el planeador. Medido en las
      // correcciones de Julián del 20 y 21 de agosto, **sus propios planes
      // necesitan 3 carros simultáneos** (pico 11:35 y 16:00): los 2 de los
      // trabajadores más el suyo o un Uber. Con 2 el plan deja 6-9 traslados
      // marcados "quizás no haya carro" que en la realidad sí se hacen.
      // Se configura en Ajustes; si la columna no existe todavía se comporta
      // como siempre (2).
      const nCarros = Math.max(1, Number((await getSettings())?.route_cars_count) || 2);
      cars = (vs || []).slice(0, nCarros).map((v, i) => ({ id: v.internal_code || v.license_plate || ('Carro ' + (i + 1)), avail0: '01:30', driver: null, capacity: v.capacity || 4, vehicleId: v.id }));
    } catch (_) {}
    if (!cars.length) return { aux: {}, colors: {}, cars: [], drivers: [], plan: {}, source: 'empty', day: day0, noVehicles: true };
    let drivers = [];
    try {
      const ds = await listDrivers();
      drivers = (ds || []).map((d, i) => ({ id: d.id, n: d.full_name || d.name || 'Conductor', turno: 'Mañana', c: RT_PALETTE[i % RT_PALETTE.length] }));
    } catch (_) {}
    return { aux, colors, cars, drivers, plan: {}, source: 'live', day: day0 };
  }

  // ---- Auxiliar (pasajero) ----
  let _myAuxId = null;
  async function getMyAuxiliarProfileId() {
    if (_myAuxId) return _myAuxId;
    const { data: u } = await sb.auth.getUser();
    const uid = u?.user?.id; if (!uid) return null;
    const { data, error } = await sb.from('auxiliar_profiles').select('id').eq('profile_id', uid).maybeSingle();
    if (error || !data) return null;
    _myAuxId = data.id; return _myAuxId;
  }
  // Mapea el estado de la reserva (enum BD) al estado simple de la UI del auxiliar.
  function _auxTripStatus(r) {
    const s = r.status_h2a || r.status_a2h;
    // Cancelado y no-show son finales y visibles: antes caían al 'pending' del
    // final y el auxiliar veía "Sin rutear" en un viaje que ya no existía.
    if (r.cancelled_at || s === 'cancelled') return 'cancelled';
    if (s === 'no_show') return 'noshow';
    if (['assigned', 'driver_assigned', 'ready'].includes(s)) return 'assigned';
    if (['en_route', 'at_pickup'].includes(s)) return 'onway';
    if (['on_board', 'picked_up', 'en_route_home'].includes(s)) return 'onboard';
    if (s === 'delivered') return 'done';
    return 'pending';
  }
  // Las reservas del auxiliar. Trae también las CANCELADAS (su historial es
  // suyo: si canceló ayer tiene derecho a verlo) — antes se filtraban y el
  // viaje simplemente desaparecía de la pantalla sin explicación.
  // Defensivo: si 0050 no está aplicada, cae al SELECT sin columnas nuevas.
  async function listMyReservations() {
    const apId = await getMyAuxiliarProfileId(); if (!apId) return null;
    const COLS = 'id, direction, pickup_address, pickup_latitude, pickup_longitude, required_arrival_at, status_h2a, status_a2h, notes, cancelled_at, rating, flights(flight_number)';
    const q = cols => sb.from('reservations').select(cols)
      .eq('auxiliar_profile_id', apId).order('required_arrival_at', { ascending: true });
    // residence_id se pide en el escalón de más columnas (0055): lo usa
    // "Repetir el de siempre" para volver al mismo conjunto sin preguntar.
    // 0069: el nivel de servicio y el estado de la solicitud de privado.
    // 0075: residence_unit, para que «Repetir el de siempre» vuelva al mismo
    // apartamento y no solo al mismo conjunto.
    let { data, error } = await q(COLS + ', is_overnight, is_firm, ready_confirmed_at, cancellation_reason, residence_id, residence_unit, service_level, private_status, price_cop, private_reject_reason');
    if (error) ({ data, error } = await q(COLS + ', is_overnight, is_firm, ready_confirmed_at, cancellation_reason, residence_id, service_level, private_status, price_cop, private_reject_reason'));
    if (error) ({ data, error } = await q(COLS + ', is_overnight, is_firm, ready_confirmed_at, cancellation_reason, residence_id'));
    if (error) ({ data, error } = await q(COLS + ', is_overnight, is_firm, ready_confirmed_at, cancellation_reason'));
    if (error) ({ data, error } = await q(COLS));
    if (error) return null;
    return (data || []).map(r => ({
      id: r.id, type: r.direction === 'airport_to_home' ? 'lle' : 'sal',
      residenceId: r.residence_id || null,
      residenceUnit: r.residence_unit || null,
      level: r.service_level || 'shared',
      privateStatus: r.private_status || null,
      price: r.price_cop != null ? r.price_cop : null,
      privateReason: r.private_reject_reason || '',
      flight: r.flights?.flight_number || (r.notes && r.notes.match(/AV-?\d+/) ? r.notes.match(/AV-?\d+/)[0] : ''),
      date: r.required_arrival_at.slice(0, 10), time: rtHHMM(r.required_arrival_at),
      address: r.pickup_address, lat: r.pickup_latitude, lng: r.pickup_longitude,
      notes: r.notes || '', status: _auxTripStatus(r), driver: null,
      cancelledAt: r.cancelled_at || null, cancelReason: r.cancellation_reason || '',
      isPernocta: !!r.is_overnight, isReserva: r.is_firm !== false,
      readyAt: r.ready_confirmed_at || null,
      rated: r.rating != null, rating: r.rating || 0,
    }));
  }
  // ---- Catálogo de residencias para el auxiliar (0055) ----
  //
  // La 0055 se escribió para esto y llevaba desde julio sin usarse en la app del
  // pasajero: "El auxiliar ELIGE su conjunto de una lista; no escribe". Hasta hoy
  // seguía escribiendo texto libre que geocodificábamos con Nominatim, que de los
  // 41 conjuntos donde vive la tripulación conoce 4.
  //
  // Lee con la política de organización (p_residences_select_org), no hace falta
  // RPC. Solo lo que el auxiliar necesita para elegir: nombre, sector y la coord
  // verificada para pintarle el mapa. `access_note` viene en el SELECT pero hoy
  // está vacía en las 41 filas: quien la muestre debe hacerlo solo si trae texto.
  let _residencesCache = null;
  async function listResidences() {
    if (_residencesCache) return _residencesCache;
    const { data, error } = await sb.from('residences')
      .select('id, name, sector, access_note, latitude, longitude')
      .eq('is_active', true).order('name');
    if (error) return null;
    _residencesCache = data || [];
    return _residencesCache;
  }

  // El punto guardado del auxiliar. 64 de los 102 perfiles ya traen residence_id
  // (lo llenó la operación al sembrar el catálogo), así que para la mayoría el
  // paso 3 se resuelve de un toque desde el primer día.
  // Devuelve null si no hay sesión de auxiliar; {} si la hay pero está vacío.
  async function getMyAuxiliarPlace() {
    const { data: u } = await sb.auth.getUser();
    const uid = u?.user?.id; if (!uid) return null;
    // El embed va con el NOMBRE de la llave foránea, no como `residences(...)`:
    // desde 0075 hay DOS caminos de auxiliar_profiles a residences y PostgREST
    // responde PGRST201 («ambiguous embedding») si no se le dice cuál. El
    // nombre existe desde 0055, así que sirve también en el escalón de abajo.
    const BASE = 'id, residence_id, home_address, home_latitude, home_longitude, residences!auxiliar_profiles_residence_id_fkey(id, name, sector, latitude, longitude)';
    // La segunda unidad (0075) va en su propio escalón: si la columna no
    // existiera, el auxiliar sigue trabajando con una sola como siempre.
    const q = (cols) => sb.from('auxiliar_profiles').select(cols).eq('profile_id', uid).maybeSingle();
    let { data, error } = await q(BASE + ', residence_unit, residence_unit_2, residence_id_2, residencia2:residences!auxiliar_profiles_residence_id_2_fkey(id, name, sector, latitude, longitude)');
    if (error) ({ data, error } = await q(BASE + ', residence_unit'));
    if (error) ({ data, error } = await q(BASE));
    if (error || !data) return null;
    return {
      residenceId: data.residence_id || null,
      residence: data.residences || null,
      unit: data.residence_unit || '',
      residenceId2: data.residence_id_2 || null,
      residence2: data.residencia2 || null,
      unit2: data.residence_unit_2 || '',
      homeAddress: data.home_address || '',
      homeLat: data.home_latitude, homeLng: data.home_longitude,
    };
  }

  // Guarda el conjunto elegido como SU punto (p_auxiliar_profiles_update_own).
  // No es cosmético: la próxima reserva arranca con el punto ya puesto, y el
  // trigger fill_reservation_pickup() lo usa como respaldo si alguna vez llega
  // una reserva sin residencia.
  async function saveMyResidence(residenceId) {
    const { data: u } = await sb.auth.getUser();
    const uid = u?.user?.id; if (!uid) throw new Error('Sin sesión');
    const { error } = await sb.from('auxiliar_profiles')
      .update({ residence_id: residenceId || null }).eq('profile_id', uid);
    if (error) throw error;
    return true;
  }

  // Crea una reserva del auxiliar autenticado (RLS: solo la suya).
  // Pernocta y "reserva en firme" se preguntaban en el formulario y se botaban:
  // desde 0050 tienen columna y llegan al admin.
  //
  // Con residencia elegida NO mandamos coordenadas: las pone el trigger
  // fill_reservation_pickup() desde el catálogo. Mandarlas desde el cliente
  // sería dejar que el teléfono decida dónde queda una portería que la
  // operación ya midió a mano.
  async function createReservation(f) {
    const apId = await getMyAuxiliarProfileId(); if (!apId) throw new Error('Sin perfil de auxiliar');
    const isLle = f.type === 'lle';
    const notes = (f.flight ? 'Vuelo ' + f.flight + '. ' : '') + (f.notes || '');
    const payload = {
      auxiliar_profile_id: apId, flight_id: null,
      direction: isLle ? 'airport_to_home' : 'home_to_airport',
      status_h2a: isLle ? null : 'requested', status_a2h: isLle ? 'scheduled' : null,
      pickup_address: f.address, pickup_latitude: f.lat, pickup_longitude: f.lng,
      required_arrival_at: f.date + 'T' + f.time + ':00-05:00', notes: notes.trim() || null,
    };
    const extra = { is_overnight: !!f.isPernocta, is_firm: f.isReserva !== false };
    // La residencia va en su propio escalón de degradación: si la columna no
    // existiera (0055 sin aplicar) se reintenta sin ella y la reserva igual se
    // crea con el texto y el pin, que es el camino de excepción de siempre.
    // 0075: con dos unidades el apartamento cambia por pedido, así que viaja en
    // la reserva. Si no viene, el trigger lo hereda del perfil (el de la unidad
    // que corresponda al conjunto, no el de la otra).
    const withRes = f.residenceId
      ? { residence_id: f.residenceId, ...(f.residenceUnit ? { residence_unit: f.residenceUnit } : {}) }
      : {};
    // 0069. Solo se manda el NIVEL: el estado 'requested' y el precio los pone el
    // servidor en guard_private_insert(), para que no se pueda pactar una tarifa
    // ni auto-aprobarse desde el teléfono.
    const withLvl = f.level === 'private' ? { service_level: 'private' } : {};
    let { data, error } = await sb.from('reservations').insert({ ...payload, ...extra, ...withRes, ...withLvl }).select('id').single();
    if (error && f.level === 'private') ({ data, error } = await sb.from('reservations').insert({ ...payload, ...extra, ...withRes }).select('id').single());
    if (error && f.residenceId && f.residenceUnit) ({ data, error } = await sb.from('reservations').insert({ ...payload, ...extra, residence_id: f.residenceId }).select('id').single());
    if (error && f.residenceId) ({ data, error } = await sb.from('reservations').insert({ ...payload, ...extra }).select('id').single());
    if (error) ({ data, error } = await sb.from('reservations').insert(payload).select('id').single());
    if (error) throw error;
    return data.id;
  }

  // ---- Traslado privado (0069) ----
  //
  // El cupo NO es un parámetro: es un hecho. Hay una camioneta, luego hay como
  // máximo un privado a la vez. Se pregunta al servidor porque el auxiliar no
  // puede leer las reservas de los demás para averiguarlo por su cuenta.
  async function privateBusyAt(whenISO, excludeId) {
    const { data, error } = await sb.rpc('private_vehicle_busy_at', {
      p_when: whenISO, p_exclude: excludeId || null,
    });
    if (error) throw error;
    return data === true;
  }

  // El jefe aprueba o rechaza. El precio y el vehículo los pone el servidor: acá
  // no se mandan para que no haya forma de pactar una tarifa desde el cliente.
  async function decidePrivate(reservationId, approve, reason) {
    const { data, error } = await sb.rpc('admin_decide_private', {
      p_reservation_id: reservationId, p_approve: !!approve, p_reason: reason || null,
    });
    if (error) throw error;
    return data || { ok: true };
  }

  // Cola de privados para el jefe. Los pendientes primero: son los que exigen
  // una decisión suya, y mientras no la tome el auxiliar está esperando.
  async function listPrivateRequests() {
    const COLS = 'id, direction, pickup_address, required_arrival_at, notes, cancelled_at, '
      + 'service_level, private_status, price_cop, private_reject_reason, private_decided_at, '
      + 'auxiliar_profiles(profiles(id, full_name, phone)), vehicles:private_vehicle_id(license_plate, brand, model)';
    const { data, error } = await sb.from('reservations').select(COLS)
      .eq('service_level', 'private')
      .order('required_arrival_at', { ascending: true });
    if (error) return null;
    return (data || []).map(r => ({
      id: r.id,
      type: r.direction === 'airport_to_home' ? 'lle' : 'sal',
      addr: r.pickup_address || '',
      whenISO: r.required_arrival_at,
      date: (r.required_arrival_at || '').slice(0, 10),
      time: rtHHMM(r.required_arrival_at),
      notes: r.notes || '',
      status: r.private_status,
      price: r.price_cop,
      reason: r.private_reject_reason || '',
      decidedAt: r.private_decided_at || null,
      cancelled: !!r.cancelled_at,
      who: r.auxiliar_profiles?.profiles?.full_name || 'Auxiliar',
      whoId: r.auxiliar_profiles?.profiles?.id || null,
      phone: r.auxiliar_profiles?.profiles?.phone || '',
      plate: r.vehicles?.license_plate || null,
      vehicle: r.vehicles ? [r.vehicles.brand, r.vehicles.model].filter(Boolean).join(' ') : null,
    }));
  }

  // Flota para el desplegable de Ajustes: cuál vehículo es la camioneta.
  async function listVehiclesBasic() {
    const { data, error } = await sb.from('vehicles')
      .select('id, license_plate, brand, model, capacity, status')
      .is('deleted_at', null).order('license_plate');
    if (error) return null;
    return (data || []).map(v => ({
      id: v.id, plate: v.license_plate,
      label: [v.brand, v.model].filter(Boolean).join(' ') || v.license_plate,
      capacity: v.capacity, status: v.status,
    }));
  }

  // El auxiliar cancela SU traslado (RPC de 0050). Devuelve el profile_id del
  // conductor afectado (o null) para que el frontend le avise por push.
  async function cancelMyReservation(reservationId, reason) {
    const { data, error } = await sb.rpc('auxiliar_cancel_reservation', {
      p_reservation_id: reservationId, p_reason: reason || null,
    });
    if (error) throw error;
    return data || { ok: true };
  }
  // Un admin cancela el traslado de un auxiliar (vuelo caído, cambio de plan).
  async function adminCancelReservation(reservationId, reason) {
    const { data, error } = await sb.rpc('admin_cancel_reservation', {
      p_reservation_id: reservationId, p_reason: reason || null,
    });
    if (error) throw error;
    return data || { ok: true };
  }
  // "Confirmar mi recogida": antes solo cambiaba una variable en memoria.
  async function confirmReservationReady(reservationId) {
    const { error } = await sb.rpc('auxiliar_confirm_ready', { p_reservation_id: reservationId });
    if (error) throw error;
    return true;
  }

  // Tabla de reservas del admin (módulo Reservas). Ventana de días alrededor de
  // hoy en hora de Colombia. Incluye canceladas: el admin necesita ver qué se
  // cayó, no solo lo que sigue en pie.
  async function listReservationsAdmin(daysBack, daysFwd) {
    const back = daysBack == null ? 1 : daysBack, fwd = daysFwd == null ? 7 : daysFwd;
    const from = new Date(Date.now() - back * 86400000).toISOString();
    const to = new Date(Date.now() + fwd * 86400000).toISOString();
    const COLS = 'id, direction, pickup_address, required_arrival_at, status_h2a, status_a2h, notes, cancelled_at, created_at, rating, rating_tags, rated_at, auxiliar_profiles(profiles(id, full_name, phone))';
    const q = cols => sb.from('reservations').select(cols)
      .gte('required_arrival_at', from).lte('required_arrival_at', to)
      .order('required_arrival_at', { ascending: true });
    let { data, error } = await q(COLS + ', is_overnight, is_firm, cancellation_reason, ready_confirmed_at');
    if (error) ({ data, error } = await q(COLS));
    if (error) return null;
    return (data || []).map(r => ({
      id: r.id, type: r.direction === 'airport_to_home' ? 'lle' : 'sal',
      name: r.auxiliar_profiles?.profiles?.full_name || 'Auxiliar',
      profileId: r.auxiliar_profiles?.profiles?.id || null,
      phone: r.auxiliar_profiles?.profiles?.phone || '',
      address: r.pickup_address || '', when: r.required_arrival_at,
      date: r.required_arrival_at.slice(0, 10), time: rtHHMM(r.required_arrival_at),
      flight: (r.notes && r.notes.match(/AV-?\d+/)) ? r.notes.match(/AV-?\d+/)[0] : '',
      notes: r.notes || '', raw: r.status_h2a || r.status_a2h || '',
      status: _auxTripStatus(r), cancelledAt: r.cancelled_at || null,
      cancelReason: r.cancellation_reason || '', createdAt: r.created_at,
      isPernocta: !!r.is_overnight, isReserva: r.is_firm !== false,
      readyAt: r.ready_confirmed_at || null,
      rating: r.rating || 0, ratingTags: r.rating_tags || [], ratedAt: r.rated_at || null,
    }));
  }

  // Rastreo EN VIVO de UNA reserva para su dueño (auxiliar). Vía RPC SECURITY
  // DEFINER (0047): valida ownership y devuelve la última posición conocida del
  // conductor (gps/ancla), su identidad y el avance real. Devuelve:
  //   null                              → no es suya / sin sesión / RPC ausente
  //   { assigned:false, raw_status,… }  → aún sin ruta activa (no hay conductor)
  //   { assigned:true, driver, plate, pos:{lat,lng,source,at}|null, stop_status,…}
  async function trackReservation(reservationId) {
    if (!reservationId) return null;
    const { data, error } = await sb.rpc('auxiliar_track_reservation', { p_reservation_id: reservationId });
    if (error) return null;
    return data || null;
  }

  // El auxiliar dueño califica su reserva (1-5 + etiquetas). RPC de 0048.
  async function rateReservation(reservationId, rating, tags) {
    if (!reservationId || !rating) return false;
    const { error } = await sb.rpc('auxiliar_rate_reservation', {
      p_reservation_id: reservationId, p_rating: rating, p_tags: (tags && tags.length) ? tags : null,
    });
    if (error) throw error;
    return true;
  }

  // Tiempos de viaje CON tráfico para una hora futura (Edge Function TOMTOM_API_KEY
  // → TomTom). La llave vive en el servidor: si viajara en la PWA, cualquiera la
  // leería del código y gastaría la cuota.
  // Devuelve null si no está configurada o falla: el asignador cae a OSRM solo.
  // mode: 'live' (lo que está pasando AHORA, incluye accidentes) | 'historical'
  // (cómo suele estar esa vía a esa hora). El histórico sirve para planear
  // mañana; el vivo es el único que ve un choque de hace diez minutos.
  async function trafficMatrix(points, departAt, mode) {
    if (!points || points.length < 2) return null;
    try {
      // El nombre de la función es raro a propósito: al desplegarla se le puso
      // el del secret y en Supabase el slug no se puede renombrar (habría que
      // borrarla y recrearla). NO guarda una llave: calcula la matriz con
      // tráfico. Ver el encabezado de supabase/functions/TOMTOM_API_KEY.
      const live = mode === 'live';
      const { data, error } = await sb.functions.invoke('TOMTOM_API_KEY', {
        // El tráfico en vivo va siempre contra "ahora": pedirlo para una hora
        // futura no tiene sentido y TomTom lo rechaza.
        body: live
          ? { points, departAt: 'now', traffic: 'live' }
          : { points, departAt: departAt || undefined },
      });
      if (error) return null;
      return (data && Array.isArray(data.durations)) ? data : null;
    } catch (_) { return null; }
  }

  // -------------------- Riesgo de la ruta (0053) --------------------
  // Lo llena el vigilante que corre en la base cada 5 minutos comparando dónde
  // está de verdad el conductor contra la hora comprometida. La RLS ya limita:
  // el auxiliar solo ve el de su traslado, el admin ve todos.

  // Demora detectada en MI traslado (null si va bien). Devuelve null también si
  // 0053 no está aplicada: sin dato no se inventa una demora.
  async function getReservationRisk(reservationId) {
    if (!reservationId) return null;
    const { data, error } = await sb.from('route_stop_risks')
      .select('minutes_late, distance_km, detected_at')
      .eq('reservation_id', reservationId)
      .is('resolved_at', null)
      .order('detected_at', { ascending: false })
      .limit(1);
    if (error || !data || !data.length) return null;
    return data[0];
  }

  // Todas las demoras abiertas, para el tablero de operación del admin.
  async function listOpenRouteRisks() {
    const { data, error } = await sb.from('route_stop_risks')
      .select('minutes_late, distance_km, detected_at, reservation_id, ' +
              'reservations(pickup_address, auxiliar_profiles(profiles(full_name)))')
      .is('resolved_at', null)
      .order('minutes_late', { ascending: false });
    if (error) return [];
    return (data || []).map(r => ({
      minutesLate: r.minutes_late, km: r.distance_km, at: r.detected_at,
      reservationId: r.reservation_id,
      aux: r.reservations?.auxiliar_profiles?.profiles?.full_name || 'Auxiliar',
      addr: r.reservations?.pickup_address || '',
    }));
  }

  // -------------------- Chat del traslado (0052 + 0067) --------------------
  // Hilo del traslado, atado a UNA reserva. Desde 0067 tiene TRES puntas:
  // el tripulante, su conductor y el jefe. El botón de llamar se queda: el chat
  // es para lo que conviene que quede escrito ("portería 3, torre B"), la
  // llamada para cuando no hay datos o hay afán.

  // Mensajes del hilo, del más viejo al más nuevo. Devuelve [] si la tabla aún
  // no existe (0052 sin aplicar) para no tumbar la pantalla del viaje.
  // read_by (0067) puede no venir: si la migración no está, se cae a read_at.
  async function listReservationMessages(reservationId) {
    if (!reservationId) return [];
    const base = 'id, sender_profile_id, sender_role, body, read_at, created_at';
    let { data, error } = await sb.from('reservation_messages')
      .select(base + ', read_by')
      .eq('reservation_id', reservationId)
      .order('created_at', { ascending: true });
    if (error) {
      ({ data, error } = await sb.from('reservation_messages')
        .select(base)
        .eq('reservation_id', reservationId)
        .order('created_at', { ascending: true }));
    }
    if (error) return [];
    return data || [];
  }

  // Envía y avisa a quien corresponda. El RPC deduce el rol y devuelve los
  // destinatarios: el que escribe no tiene por qué conocer el profile_id del
  // otro. Desde 0067 pueden ser VARIOS (el jefe le escribe al tripulante y al
  // conductor; el tripulante sin carro asignado le escribe a los jefes).
  // El push es best-effort — que falle la notificación no puede perder el mensaje.
  async function sendReservationMessage(reservationId, body, opts) {
    const { data, error } = await sb.rpc('send_reservation_message', {
      p_reservation_id: reservationId, p_body: body,
    });
    if (error) throw error;
    let to = (data && data.recipient_profile_ids) || null;
    if (!Array.isArray(to)) to = (data && data.recipient_profile_id) ? [data.recipient_profile_id] : [];
    to = to.filter(Boolean);
    // Se devuelve si el aviso llegó o no: el que escribe merece saber que el
    // otro NO tiene notificaciones activadas y que el mensaje se va a quedar ahí
    // hasta que abra la app. Decir "enviado" a secas sería engañarlo.
    let notified = null;
    if (to.length) {
      // Cuando el destinatario cambia, el título tiene que cambiar con él. Un
      // tripulante escribe pensando en su conductor, pero si su traslado no tiene
      // carro el aviso les cae a los JEFES: mandarles "Mensaje de tu pasajero"
      // les diría que son el conductor de alguien. Se avisa además de dónde
      // aterrizar, porque el jefe lee esto desde la bandeja, no desde un viaje.
      const titulo = data && data.to_admins
        ? 'Un tripulante escribió y no tiene carro asignado'
        : ((opts && opts.title) || 'Mensaje de tu traslado');
      try {
        const r = await sendPush({
          profileIds: to,
          title: titulo,
          body: String(body).slice(0, 120),
          url: (data && data.to_admins)
            ? '/#/reservas?chat=' + reservationId
            : ((opts && opts.url) || '/'),
        });
        notified = (r && typeof r.sent === 'number') ? r.sent > 0 : null;
      } catch (_) { notified = false; }
    }
    return Object.assign({}, data, { notified, recipients: to });
  }

  // Sin leer por reserva, para el badge del conductor (que lleva varias paradas
  // a la vez). fromRoles = quién escribió, uno o varios: para el conductor son
  // el tripulante Y el jefe. La RLS ya limita a sus propias reservas; el .in()
  // es solo para no traer más.
  //
  // Con tres puntas en el hilo, "sin leer" es por LECTOR: un mensaje del jefe al
  // tripulante y al conductor lo puede haber abierto uno y no el otro. Por eso se
  // filtra contra read_by y no contra read_at, que solo marca al primero.
  async function countUnreadMessages(reservationIds, fromRoles) {
    const ids = (reservationIds || []).filter(Boolean);
    if (!ids.length) return {};
    const roles = Array.isArray(fromRoles) ? fromRoles : [fromRoles];
    const session = await getSession();
    const me = session && session.user ? session.user.id : null;
    const base = 'reservation_id, read_at';
    let { data, error } = await sb.from('reservation_messages')
      .select(base + ', read_by').in('reservation_id', ids).in('sender_role', roles);
    if (error) {
      ({ data, error } = await sb.from('reservation_messages')
        .select(base).in('reservation_id', ids).in('sender_role', roles).is('read_at', null));
    }
    if (error) return {};
    const out = {};
    (data || []).forEach(m => {
      if (!chatUnreadFor(m, me)) return;
      out[m.reservation_id] = (out[m.reservation_id] || 0) + 1;
    });
    return out;
  }

  // ¿Este mensaje está sin leer PARA MÍ? Se expone porque las pantallas del
  // tripulante y del conductor cuentan lo mismo sobre la lista que ya tienen.
  function chatUnreadFor(msg, meId) {
    if (!msg) return false;
    if (Array.isArray(msg.read_by)) return !meId || !msg.read_by.includes(meId);
    return !msg.read_at; // 0067 sin aplicar: un solo interruptor, como antes
  }

  async function markReservationMessagesRead(reservationId) {
    if (!reservationId) return 0;
    const { data, error } = await sb.rpc('mark_reservation_messages_read', { p_reservation_id: reservationId });
    if (error) return 0;
    return data || 0;
  }

  // Crea la cabecera de una ruta (borrador → con conductor). Defensivo: si las
  // columnas de 0040 (driver/vehicle nullable, estado 'draft') no existen aún,
  // el error se propaga y la UI lo ignora. Las route_stops (que requieren
  // reservation_id por parada) se persistirán en la siguiente iteración.
  async function saveRouteAssignment(car, orderIds, driverId) {
    const payload = {
      vehicle_id: car && car.vehicleId ? car.vehicleId : null,
      driver_profile_id: driverId || null,
      direction: 'home_to_airport',
      status: driverId ? 'planned' : 'draft',
    };
    const { data, error } = await sb.from('route_assignments').insert(payload).select('id').single();
    if (error) throw error;
    return data ? data.id : null;
  }

  // Resuelve reservationIds → profile_id de sus auxiliares (para notificar por
  // push al publicar el plan). Admin RLS: lee reservations de su org + el
  // auxiliar_profiles anidado (p_auxiliar_profiles_select_admin).
  async function auxiliarUserIdsForReservations(ids) {
    if (!ids || !ids.length) return [];
    const { data, error } = await sb.from('reservations')
      .select('auxiliar_profiles(profile_id)').in('id', ids);
    if (error) return [];
    return [...new Set((data || []).map(r => r.auxiliar_profiles?.profile_id).filter(Boolean))];
  }

  // ---- Persistir el plan del día (admin) y leerlo (conductor) ----
  const _bogDay = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });

  // Guarda TODAS las vueltas del día como route_assignments + route_stops.
  // lanes: [{ vehicleId, driverProfileId(=profile id|null), type('sal'|'lle'), startAt(ISO), stops:[reservationId] }]
  //
  // Republicar es idempotente: borra el plan del día y lo vuelve a insertar.
  // PERO nunca toca una ruta YA EMPEZADA (status 'in_progress') ni una
  // completada — antes las borraba a todas y un conductor que ya iba en camino
  // se quedaba sin ruta a mitad de operación, con IDs nuevos. Las rutas en
  // curso se respetan y sus reservas se excluyen del re-planteo.
  //
  // Devuelve además `notify`: solo los auxiliares cuya asignación CAMBIÓ
  // (entraron a una ruta con conductor por primera vez, o les cambió el
  // conductor). Así republicar no vuelve a notificar a todo el mundo.
  async function saveRoutePlan(day, lanes) {
    const d0 = day + 'T00:00:00-05:00', d1 = day + 'T23:59:59-05:00';
    // profile id → driver_profile id (route_assignments referencia driver_profiles).
    const profIds = [...new Set(lanes.map(l => l.driverProfileId).filter(Boolean))];
    const dpMap = {}, dpBack = {};
    if (profIds.length) {
      const { data } = await sb.from('driver_profiles').select('id, profile_id').in('profile_id', profIds);
      (data || []).forEach(r => { dpMap[r.profile_id] = r.id; dpBack[r.id] = r.profile_id; });
    }

    // Foto del plan ANTES de tocarlo: qué reserva estaba con qué conductor, y
    // cuáles NO se pueden mover.
    //
    // Antes se bloqueaba la ruta ENTERA en cuanto arrancaba, así que una parada
    // que el conductor todavía no había atendido quedaba clavada en un carro que
    // quizá ya no iba a alcanzar. Justo la contingencia que hay que poder
    // resolver de madrugada: pasarle esa recogida a otro carro mejor ubicado.
    //
    // Ahora el candado es POR PARADA: fija solo si ya se atendió (llegó, recogió
    // o no se presentó) o si su ruta terminó. Lo pendiente de una ruta en curso
    // se puede reasignar.
    const prev = {}, locked = new Set();
    const movableInProgress = [];   // route_stops.id pendientes de rutas ya arrancadas
    {
      const { data } = await sb.from('route_assignments')
        .select('id, status, driver_profile_id, driver_profiles(profile_id), route_stops(id, reservation_id, status)')
        .gte('planned_start_at', d0).lte('planned_start_at', d1);
      (data || []).forEach(ra => {
        const pid = ra.driver_profiles?.profile_id || null;
        (ra.route_stops || []).forEach(s => {
          prev[s.reservation_id] = pid;
          const atendida = s.status && s.status !== 'pending';
          if (ra.status === 'completed' || atendida) locked.add(s.reservation_id);
          else if (ra.status === 'in_progress') movableInProgress.push({ id: s.id, rid: s.reservation_id });
        });
      });
    }

    // De las rutas EN CURSO solo se toca lo que de verdad CAMBIA de conductor.
    // Una parada pendiente que sigue con el mismo conductor se deja donde está:
    // borrarla y recrearla partiría su vuelta en dos y le desordenaría la
    // pantalla al conductor sin ninguna razón.
    const nuevoDe = {};
    lanes.forEach(l => (l.stops || []).forEach(rid => { nuevoDe[rid] = l.driverProfileId || null; }));
    const aMover = [];
    movableInProgress.forEach(s => {
      const destino = nuevoDe[s.rid];
      if (destino !== undefined && destino !== prev[s.rid]) aMover.push(s.id);
      else locked.add(s.rid);   // se queda en su ruta: que no se duplique abajo
    });

    // Borra lo que aún no arranca (draft/planned) entero…
    await sb.from('route_assignments').delete()
      .in('status', ['draft', 'planned'])
      .gte('planned_start_at', d0).lte('planned_start_at', d1);
    // …y de las rutas en curso, solo las paradas que cambian de carro. La ruta
    // sigue viva con lo que el conductor ya hizo: borrarla completa perdería el
    // avance real del viaje.
    if (aMover.length) {
      await sb.from('route_stops').delete().in('id', aMover);
    }

    let saved = 0, skipped = 0, kept = 0;
    const notify = [];
    for (const lane of lanes) {
      if (!lane.vehicleId || !lane.stops || !lane.stops.length) { skipped++; continue; }
      // Las paradas ya en curso no se re-planean: siguen donde están.
      const stopIds = lane.stops.filter(rid => !locked.has(rid));
      kept += lane.stops.length - stopIds.length;
      if (!stopIds.length) { skipped++; continue; }
      const dpid = lane.driverProfileId ? dpMap[lane.driverProfileId] : null;
      const { data: ra, error } = await sb.from('route_assignments').insert({
        driver_profile_id: dpid, vehicle_id: lane.vehicleId,
        direction: lane.type === 'lle' ? 'airport_to_home' : 'home_to_airport',
        status: dpid ? 'planned' : 'draft', planned_start_at: lane.startAt,
      }).select('id').single();
      if (error) { skipped++; continue; }
      // La ETA por parada viaja desde el tablero (lane.etas: minutos desde
      // medianoche). Sin ella, `route_stops.estimated_arrival_at` quedaba NULL
      // siempre y el vigilante de 0053 caía a `required_arrival_at`, que en una
      // salida es la hora de presentación EN EL AEROPUERTO: juzgaba la recogida
      // en la casa contra una hora una o dos horas más tarde, y por eso solo
      // avisaba cuando ya no había nada que hacer.
      const etaIso = (min) => {
        if (min == null || !isFinite(min)) return null;
        return new Date(new Date(day + 'T00:00:00-05:00').getTime() + min * 60000).toISOString();
      };
      const stops = stopIds.map((rid, i) => ({
        route_assignment_id: ra.id, reservation_id: rid, stop_order: i + 1,
        estimated_arrival_at: etaIso(lane.etas ? lane.etas[rid] : null),
      }));
      let r2 = await sb.from('route_stops').insert(stops);
      // Si la columna no estuviera disponible, se guarda el plan igual: perder la
      // ETA degrada el vigilante, pero no publicar la ruta deja al conductor sin nada.
      if (r2.error) {
        r2 = await sb.from('route_stops').insert(
          stops.map(({ estimated_arrival_at, ...s }) => s));
      }
      if (r2.error) { skipped++; continue; }
      // Novedad real para el auxiliar: pasó de sin conductor a con conductor, o se lo cambiaron.
      if (dpid) stopIds.forEach(rid => {
        if (prev[rid] !== lane.driverProfileId) notify.push({ reservationId: rid, changed: !!prev[rid] });
      });
      saved++;
    }
    return { saved, skipped, kept, notify };
  }

  // El conductor lee SU ruta del día (route_assignments asignadas a él) → vueltas.
  async function listMyVueltasForDriver(profileId) {
    const dpid = await getMyDriverProfileId(profileId); if (!dpid) return null;
    let { data, error } = await sb.from('route_assignments')
      .select('id, direction, planned_start_at, status, route_stops(stop_order, reservation_id, reservations(pickup_address, pickup_latitude, pickup_longitude, required_arrival_at, notes, residence_unit, auxiliar_profiles(profiles(id, full_name, phone)), flights(flight_number)))')
      .eq('driver_profile_id', dpid)
      .order('planned_start_at', { ascending: true });
    // 0075 puede no estar aplicada: sin el apartamento la ruta se pinta igual.
    if (error) ({ data, error } = await sb.from('route_assignments')
      .select('id, direction, planned_start_at, status, route_stops(stop_order, reservation_id, reservations(pickup_address, pickup_latitude, pickup_longitude, required_arrival_at, notes, auxiliar_profiles(profiles(id, full_name, phone)), flights(flight_number)))')
      .eq('driver_profile_id', dpid)
      .order('planned_start_at', { ascending: true }));
    if (error) return null;
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    const MDE = { name: 'Aeropuerto MDE', addr: 'Terminal de pasajeros · José María Córdova', lat: 6.1715, lng: -75.4270 };
    // Día operativo MÁS PRÓXIMO con ruta (hoy si la hay; si no, la siguiente).
    const active = (data || []).filter(ra => ra.planned_start_at && ra.status !== 'completed' && _bogDay(ra.planned_start_at) >= today);
    if (!active.length) return [];
    const day0 = _bogDay(active[0].planned_start_at); // vienen ordenadas por planned_start_at
    const rows = active.filter(ra => _bogDay(ra.planned_start_at) === day0);
    return rows.map((ra, i) => {
      const type = ra.direction === 'airport_to_home' ? 'lle' : 'sal';
      const stops = (ra.route_stops || []).slice().sort((a, b) => a.stop_order - b.stop_order).map(s => {
        const r = s.reservations || {};
        return { name: r.auxiliar_profiles?.profiles?.full_name || 'Auxiliar', addr: r.pickup_address || '',
          unit: r.residence_unit || '',
          lat: r.pickup_latitude, lng: r.pickup_longitude, flight: r.flights?.flight_number || '',
          dl: rtHHMM(r.required_arrival_at), kind: type === 'lle' ? 'dropoff' : 'pickup',
          phone: r.auxiliar_profiles?.profiles?.phone || '', notes: r.notes || '',
          reservationId: s.reservation_id, auxProfileId: r.auxiliar_profiles?.profiles?.id || null };
      });
      const air = { name: MDE.name, addr: MDE.addr, lat: MDE.lat, lng: MDE.lng, kind: 'airport' };
      const legs = type === 'lle' ? [air, ...stops] : [...stops, air]; // llegada: sale de MDE; salida: termina en MDE
      return { id: 'V' + (i + 1), type, start: rtHHMM(ra.planned_start_at), done: ra.status === 'completed', legs, assignmentId: ra.id, day: day0 };
    });
  }

  // El conductor marca el avance de una parada (recogí / entregué / no-show / etc.).
  // Escribe el estado en reservations vía RPC SECURITY DEFINER que valida que quien
  // llama sea el conductor asignado a esa ruta. status ∈ enums reservation_status_*.
  // Desde 0045 la misma RPC llena route_stops y deja el ancla de posición.
  async function driverSetStopStatus(reservationId, status) {
    if (!reservationId || !status) return;
    const { error } = await sb.rpc('driver_set_reservation_status', { p_reservation_id: reservationId, p_status: status });
    if (error) throw error;
  }

  // ---------------------------------------------------------------------------
  // OPERACIÓN EN VIVO
  // ---------------------------------------------------------------------------

  // El conductor reporta su GPS. Best-effort: si falla, se traga el error — el
  // ancla por evento (0045) es la red de seguridad, no queremos romper la ruta
  // del conductor porque un ping no entró.
  async function sendDriverLocation(driverProfileId, lat, lng, opts) {
    if (!driverProfileId || !isFinite(lat) || !isFinite(lng)) return;
    const o = opts || {};
    const row = { driver_profile_id: driverProfileId, latitude: lat, longitude: lng, source: 'gps' };
    if (o.routeAssignmentId) row.route_assignment_id = o.routeAssignmentId;
    if (isFinite(o.heading)) row.heading = o.heading;
    if (isFinite(o.speedKmh)) row.speed_kmh = o.speedKmh;
    const { error } = await sb.from('driver_locations').insert(row);
    if (error) throw error;
  }

  // Etiqueta legible del avance de un carro, según el estado de sus paradas.
  function _opStatusLabel(stops, type) {
    const pend = stops.filter(s => s.status === 'pending');
    const arrived = stops.some(s => s.status === 'arrived');
    const onboard = stops.filter(s => s.status === 'picked_up').length;
    if (!pend.length && !arrived && !onboard) return type === 'lle' ? 'Entregó a todos' : 'Completó';
    if (arrived) return 'Recogiendo';
    if (onboard && !pend.length) return type === 'lle' ? 'A bordo · llevando' : 'A bordo · llegando';
    if (onboard) return 'En ruta · con pasajeros';
    return 'En ruta';
  }

  // Operación en vivo para el admin: las vueltas activas del día operativo más
  // próximo, con la última posición conocida de cada conductor.
  //
  // La posición sale de driver_locations, que mezcla dos fuentes (0045):
  //   source='gps'    → ping del dispositivo (continuo, poco fiable)
  //   source='anchor' → evento de estado del conductor (discreto, pero cierto)
  // Gana la más reciente por recorded_at; el admin muestra la frescura para no
  // creerle ciegamente a un punto viejo.
  async function listLiveOperation() {
    const { data, error } = await sb
      .from('route_assignments')
      .select('id, direction, planned_start_at, status, driver_profile_id, vehicle_id, vehicles(license_plate, internal_code, capacity), driver_profiles(profiles(full_name, phone)), route_stops(stop_order, status, reservation_id, actual_arrival_at, actual_pickup_at, actual_dropoff_at, reservations(pickup_address, pickup_latitude, pickup_longitude, required_arrival_at, auxiliar_profiles(profiles(full_name)), flights(flight_number)))')
      .in('status', ['planned', 'in_progress'])
      .order('planned_start_at');
    if (error) throw error;

    const today = _bogDay(new Date().toISOString());
    const active = (data || []).filter(ra => ra.planned_start_at && _bogDay(ra.planned_start_at) >= today);
    if (!active.length) return { source: 'empty', day: null, cars: [], feed: [] };
    const day0 = _bogDay(active[0].planned_start_at);
    const rows = active.filter(ra => _bogDay(ra.planned_start_at) === day0);

    // Última posición por conductor (una sola consulta para todos).
    const driverIds = [...new Set(rows.map(r => r.driver_profile_id).filter(Boolean))];
    const posOf = {};
    if (driverIds.length) {
      const { data: locs } = await sb
        .from('driver_locations')
        .select('driver_profile_id, latitude, longitude, source, recorded_at, route_assignment_id')
        .in('driver_profile_id', driverIds)
        .order('recorded_at', { ascending: false })
        .limit(400);
      // Vienen ordenadas desc: la primera de cada conductor es la más reciente.
      (locs || []).forEach(l => { if (!posOf[l.driver_profile_id]) posOf[l.driver_profile_id] = l; });
    }

    const nameOf = (s) => s.reservations?.auxiliar_profiles?.profiles?.full_name || 'Auxiliar';
    const shortName = (n) => { const p = n.split(/\s+/); return p[0] + (p[1] ? ' ' + p[1][0] + '.' : ''); };
    const stopsOf = (ra) => (ra.route_stops || []).slice().sort((a, b) => a.stop_order - b.stop_order);
    const raDone = (ra) => !stopsOf(ra).some(s => s.status === 'pending' || s.status === 'arrived' || s.status === 'picked_up');

    // Feed real: los eventos que YA ocurrieron, con su hora real. Sale de todas
    // las vueltas del día, no solo de la que el carro tiene ahora.
    const feed = [];
    rows.forEach(ra => {
      const plate = ra.vehicles?.license_plate || ra.vehicles?.internal_code || 'Carro';
      stopsOf(ra).forEach(s => {
        const who = shortName(nameOf(s));
        if (s.actual_pickup_at) feed.push({ at: s.actual_pickup_at, k: 'ok', h: `<b>${plate}</b> recogió a ${who}.` });
        if (s.actual_dropoff_at) feed.push({ at: s.actual_dropoff_at, k: 'ok', h: `<b>${plate}</b> entregó a ${who}.` });
        if (s.status === 'no_show' && s.actual_arrival_at) feed.push({ at: s.actual_arrival_at, k: 'bad', h: `<b>${plate}</b> reportó que ${who} no se presentó.` });
      });
    });

    // La pantalla monitorea CARROS, no vueltas: un carro hace varias vueltas al
    // día y cambia de conductor en el relevo AM→PM. Cada tarjeta muestra la
    // vuelta que el carro tiene ENTRE MANOS (la primera sin terminar), y el
    // conductor de esa vuelta — que es quien lo lleva ahora.
    const byVeh = new Map();
    rows.forEach(ra => {
      const k = ra.vehicle_id || ra.id;
      if (!byVeh.has(k)) byVeh.set(k, []);
      byVeh.get(k).push(ra);
    });

    const cars = [...byVeh.values()].map((ras, i) => {
      const activa = ras.find(ra => !raDone(ra)) || ras[ras.length - 1];
      const type = activa.direction === 'airport_to_home' ? 'lle' : 'sal';
      const stops = stopsOf(activa);
      const v = activa.vehicles || {};

      const nextStop = stops.find(s => s.status === 'pending' || s.status === 'arrived');
      const onboard = stops.filter(s => s.status === 'picked_up').length;
      // El carro terminó el día solo si TODAS sus vueltas están cerradas.
      const done = ras.every(raDone);

      // Presentación = el pasajero pendiente con la hora límite más temprana.
      const pend = stops.filter(s => s.status !== 'delivered' && s.status !== 'no_show');
      const presAt = pend.map(s => s.reservations?.required_arrival_at).filter(Boolean).sort()[0] || null;
      const flight = (nextStop || stops[0])?.reservations?.flights?.flight_number || '—';

      const loc = posOf[activa.driver_profile_id];

      return {
        id: v.license_plate || v.internal_code || ('RD-' + String(i + 1).padStart(2, '0')),
        assignmentId: activa.id,
        vueltasHoy: ras.length,
        driver: activa.driver_profiles?.profiles?.full_name || 'Sin conductor',
        driverPhone: activa.driver_profiles?.profiles?.phone || '',
        driverProfileId: activa.driver_profile_id,
        type,
        cap: v.capacity || 4,
        pax: onboard,
        paxTotal: stops.length,
        flight,
        pres: presAt ? rtHHMM(presAt) : '—',
        presAt,
        next: nextStop ? `${shortName(nameOf(nextStop))} · ${(nextStop.reservations?.pickup_address || '').split(',')[0]}` : (type === 'lle' ? 'Entregas pendientes' : 'Aeropuerto MDE'),
        nextPos: nextStop && nextStop.reservations?.pickup_latitude
          ? [nextStop.reservations.pickup_latitude, nextStop.reservations.pickup_longitude]
          : null,
        // La reserva de la próxima parada: es la que hay que reacomodar cuando
        // este carro no alcanza (bloque D). Sin esto, "Reasignar" no sabe QUÉ mover.
        nextReservationId: nextStop ? (nextStop.reservation_id || null) : null,
        status: done ? 'Disponible' : _opStatusLabel(stops, type),
        done,
        pos: loc ? [loc.latitude, loc.longitude] : null,
        posSource: loc ? loc.source : null,
        posAt: loc ? loc.recorded_at : null,
      };
    });

    feed.sort((a, b) => (a.at < b.at ? 1 : -1));
    return {
      source: 'live',
      day: day0,
      cars,
      feed: feed.slice(0, 12).map(e => ({ k: e.k, t: rtHHMM(e.at), h: e.h })),
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // RELEER EL PLAN PUBLICADO (bloque D)
  //
  // Esto NO existía. `rtLoad()` resetea el tablero en cada carga y
  // `listRoutePlanning` devuelve siempre `plan: {}`, así que la app sabía
  // ESCRIBIR un plan y nunca volver a leerlo. Para responder "¿dónde acomodo
  // esta reserva que llegó tarde?" hay que partir del plan que de verdad está
  // corriendo —con lo que ya se atendió y lo que falta— y no replanear el día
  // desde cero: a las 4 de la mañana eso propondría un día que ya pasó a medias.
  //
  // Devuelve las vueltas VIVAS del día con sus paradas pendientes, el cupo del
  // carro, los deadlines de cada pasajero y la última posición del conductor.
  // ════════════════════════════════════════════════════════════════════
  async function getPublishedPlan(day) {
    const d0 = day + 'T00:00:00-05:00', d1 = day + 'T23:59:59-05:00';
    const { data, error } = await sb.from('route_assignments')
      .select('id, direction, status, planned_start_at, driver_profile_id, vehicle_id, ' +
        'vehicles(license_plate, internal_code, capacity), ' +
        'driver_profiles(profile_id, profiles(full_name)), ' +
        'route_stops(id, stop_order, status, estimated_arrival_at, reservation_id, ' +
        'reservations(pickup_address, pickup_latitude, pickup_longitude, required_arrival_at, ' +
        'residence_id, cancelled_at, auxiliar_profiles(profiles(full_name))))')
      .in('status', ['planned', 'in_progress'])
      .gte('planned_start_at', d0).lte('planned_start_at', d1)
      .order('planned_start_at');
    if (error) throw error;

    const raws = data || [];
    // Última posición conocida de cada conductor: si la vuelta ya arrancó, el
    // punto de partida real es donde está el carro, no de donde salió.
    const drvIds = [...new Set(raws.map(r => r.driver_profile_id).filter(Boolean))];
    const posOf = {};
    if (drvIds.length) {
      const { data: locs } = await sb.from('driver_locations')
        .select('driver_profile_id, latitude, longitude, recorded_at')
        .in('driver_profile_id', drvIds)
        .order('recorded_at', { ascending: false }).limit(400);
      (locs || []).forEach(l => { if (!posOf[l.driver_profile_id]) posOf[l.driver_profile_id] = l; });
    }

    const vueltas = raws.map(ra => {
      const stops = (ra.route_stops || []).slice().sort((a, b) => a.stop_order - b.stop_order);
      // "Atendida" = ya no se puede mover. Es el mismo candado POR PARADA de
      // saveRoutePlan: lo pendiente de una ruta en curso sí se puede reacomodar.
      const atendida = (s) => s.status && s.status !== 'pending';
      const viva = (s) => s.reservations && !s.reservations.cancelled_at;
      const map = (s) => ({
        stopId: s.id, rid: s.reservation_id, order: s.stop_order, status: s.status || 'pending',
        lat: s.reservations?.pickup_latitude ?? null,
        lng: s.reservations?.pickup_longitude ?? null,
        resId: s.reservations?.residence_id || null,
        address: s.reservations?.pickup_address || '',
        name: s.reservations?.auxiliar_profiles?.profiles?.full_name || 'Tripulante',
        pax: 1,   // una reserva = una persona (no hay pax_count en el schema)
        dueAt: s.reservations?.required_arrival_at || null,
        etaAt: s.estimated_arrival_at || null,
      });
      const vivos = stops.filter(viva);
      const pend = vivos.filter(s => !atendida(s)).map(map);
      const hechas = vivos.filter(atendida).map(map);
      const pos = posOf[ra.driver_profile_id];
      return {
        id: ra.id,
        type: ra.direction === 'airport_to_home' ? 'lle' : 'sal',
        status: ra.status,
        startAt: ra.planned_start_at,
        vehicleId: ra.vehicle_id,
        carro: ra.vehicles?.internal_code || ra.vehicles?.license_plate || 'Carro',
        cap: ra.vehicles?.capacity || 4,
        driverProfileId: ra.driver_profiles?.profile_id || null,
        conductor: ra.driver_profiles?.profiles?.full_name || 'Sin conductor',
        pendientes: pend,
        atendidas: hechas,
        // Cuántos van ya montados: cuentan para el cupo aunque no se puedan mover.
        paxABordo: hechas.filter(s => s.status === 'picked_up').reduce((n, s) => n + s.pax, 0),
        paxPendiente: pend.reduce((n, s) => n + s.pax, 0),
        pos: pos ? { lat: pos.latitude, lng: pos.longitude, at: pos.recorded_at } : null,
      };
    });

    return { day, vueltas, publicado: vueltas.some(v => v.driverProfileId) };
  }

  // Los datos de UNA reserva, para preguntar dónde cabe. Se pide aparte porque
  // la reserva tardía justamente NO está en el plan.
  async function getReservationForFit(reservationId) {
    const { data, error } = await sb.from('reservations')
      .select('id, direction, pickup_address, pickup_latitude, pickup_longitude, ' +
        'required_arrival_at, residence_id, cancelled_at, ' +
        'auxiliar_profiles(profiles(full_name))')
      .eq('id', reservationId).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
      rid: data.id,
      type: data.direction === 'airport_to_home' ? 'lle' : 'sal',
      lat: data.pickup_latitude, lng: data.pickup_longitude,
      resId: data.residence_id || null,
      address: data.pickup_address || '',
      name: data.auxiliar_profiles?.profiles?.full_name || 'Tripulante',
      pax: 1,   // una reserva = una persona (no hay pax_count en el schema)
      dueAt: data.required_arrival_at || null,
      cancelled: !!data.cancelled_at,
    };
  }

  window.Api = {
    signIn, signOut, getSession, getCurrentProfile,
    listDrivers, listAdmins, setOpsAlerts,
    listAllDriversForAdmin, setProfileActive, softDeleteProfile, setAdminCoordinator, setDriverPriority, setDriverCanCoordinate,
    createDriver,
    listSubmittedDriverIds,
    getWeeklyAvailability, getMyWeeklyAvailability,
    upsertAvailabilityRow, saveDriverWeekAvailability,
    getSchedule, saveSchedule, deleteSchedule, listPublishedSchedules, listDriversOnShift,
    getSettings, saveSettings, setAvailabilityReopen,
    listMyApprovalRequests, listPendingApprovals, resolveApproval, runAutoResolve,
    listDriverStrikes, getActiveStrikeCounts, addStrike, voidStrike,
    getWeekSuspensions, getMyWeekSuspension, addManualSuspension, liftSuspension,
    listAcceptedSwaps, listMySwaps, createSwap, decideSwap,
    listDriverRules, rulesToMap, addDriverRule, deleteDriverRule,
    savePushSubscription, deletePushSubscription, sendPush,
    getMyDriverProfileId, listVehiclesForShift, createVehicle, updateVehicle, softDeleteVehicle, returnVehicleToService, driverOverrideOilBlock, registerOilChange, getMyOpenShift,
    reserveVehicleForShift, createShiftDraft, createInspection, getExistingInitialInspectionId, uploadInspectionPhoto, addInspectionPhotos,
    addIncident, listIncidents, countOpenIncidents, updateIncidentStatus,
    reportIncident, listEventualidades, countOpenEventualidades, acknowledgeIncident, opsAlertProfileIds, opsAlertHealth,
    startShift, startShiftDeferred, clearInspectionDue, abortShift, closeShift, uploadShiftFile, addFuelReceipts, listFuelReceiptsForShift, listInspectionsByShift, getVehicleStatus, listActiveShifts, forceCloseShift,
    listNoFuelReasons, getShiftFuelStatus,
    listInspectionsForReview, listInspectionsByVehicle, getInspectionDetail, signedInspectionPhotoUrls, reviewInspection,
    listChecklistItems, listChecklistItemsForTiers, createChecklistItem, updateChecklistItem, deleteChecklistItem, reorderChecklistItems,
    getMyFullProfile, uploadMyAvatar,
    listRewards, listAllRewards, listMyClosedShifts, redeemReward, listMyRedemptions,
    createReward, updateReward, deleteReward, listRedemptionsAdmin, resolveRedemption, listClosedShiftsAdmin,
    listRoutePlanning, saveRouteAssignment, getRouteTables, saveRouteTables, listResidencesZones, saveResidenceZone,
    signUpAuxiliar, signupCatalogs, registerAuxiliar,
    listAuxiliares, setAuxiliarJoinedAt, listAirlines, createAirline, setAirlineActive,
    getMyAuxiliarProfileId, listMyReservations, createReservation, trackReservation, rateReservation,
    listResidences, getMyAuxiliarPlace, saveMyResidence,
    privateBusyAt, decidePrivate, listPrivateRequests, listVehiclesBasic,
    cancelMyReservation, adminCancelReservation, confirmReservationReady, listReservationsAdmin,
    saveRoutePlan, listMyVueltasForDriver, driverSetStopStatus, auxiliarUserIdsForReservations,
    sendDriverLocation, listLiveOperation,
    listReservationMessages, sendReservationMessage, markReservationMessagesRead, countUnreadMessages,
    chatUnreadFor,
    getPublishedPlan, getReservationForFit,
    trafficMatrix, getReservationRisk, listOpenRouteRisks,
    listPartStatus, listPartCatalog, listPartRealLife, listPartHistory,
    setVehiclePartBaseline, registerPartChange, confirmPartChange,
    correctVehicleOdometer, setPartInterval,
    listInspectionTiers, pendingInspectionTiers, markInspectionTiersDone,
    listShiftsForBalance,
  };
})();
