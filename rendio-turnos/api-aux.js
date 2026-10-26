// api-aux.js — la API del rediseño del auxiliar (entrega del 27-sep-2026).
// Paquete P9 · Base de datos y API. Habla con las migraciones 0086–0089 (y 0093:
// orden de recogida y la marca de tierra en auxiliar_my_trips; vuelo vacío en
// una llegada de tierra en auxiliar_change_flight).
//
//   window.ApiAux = {
//     listMyTrips, getMyStats, saveMyPrefs, changeFlight,
//     crewList, crewSend, crewMarkRead, crewUnread, crewThreadsAdmin,
//     crewConversations, crewClose,          // 0113: conversaciones e historial
//     getOpsContact, setOpsContact, setVehicleColor,
//     mapTrip,            // fila de auxiliar_my_trips → viaje T (lo usan las pruebas y el arnés)
//   }
//
// REGLA DE LA CASA: nunca datos falsos. Cada función devuelve `null` cuando la
// RPC o la columna todavía no existe en la base (migración sin aplicar) o no hay
// sesión. Quien llama cae entonces a lo de siempre (Api.listMyReservations) o
// dice honestamente que no está disponible.
//   · LECTURAS (listMyTrips, getMyStats, crewList, crewUnread, crewThreadsAdmin,
//     getOpsContact): cualquier otro error también devuelve null (con un
//     console.warn): la pantalla no se cae por una consulta, lo dice.
//   · ESCRITURAS (saveMyPrefs, changeFlight, crewSend, crewMarkRead,
//     setOpsContact, setVehicleColor): un error de verdad se LANZA con el texto
//     del servidor (que ya viene en español para el usuario: «Esa hora ya pasó»,
//     «Tu traslado ya está en curso…»), para que la pantalla lo muestre.
//
// El cliente es window.sb (el mismo de api.js), leído en cada llamada: así las
// pruebas pueden cambiarlo. El push lo manda Api.sendPush (best-effort: que
// falle la notificación no pierde el mensaje).
(function () {
  'use strict';

  // Errores que significan «eso todavía no existe en esta base».
  const FALTA = new Set(['PGRST202', 'PGRST204', 'PGRST205', '42883', '42703', '42P01']);
  const falta = (e) => !!e && (FALTA.has(e.code) || /Could not find the (function|table)|schema cache/i.test(e.message || ''));

  const cli = () => (typeof window !== 'undefined' && window.sb) || null;

  async function uid() {
    const sb = cli(); if (!sb || !sb.auth) return null;
    try {
      const { data } = await sb.auth.getSession();
      return (data && data.session && data.session.user && data.session.user.id) || null;
    } catch (_) { return null; }
  }

  function lanzar(e, fallback) {
    const err = new Error((e && e.message) || fallback || 'No se pudo completar');
    if (e && e.code) err.code = e.code;
    throw err;
  }

  // RPC con sesión. Devuelve { data } | { missing: true } | { error }.
  async function rpc(fn, args) {
    const sb = cli(); if (!sb) return { missing: true };
    if (!(await uid())) return { missing: true };
    let res;
    try { res = await sb.rpc(fn, args || {}); }
    catch (e) { return { error: e }; }
    if (res.error) return falta(res.error) ? { missing: true } : { error: res.error };
    return { data: res.data };
  }

  // ── Viaje T (plan final §3.1) ─────────────────────────────────────────────
  // Mismo mapeo de estado que Api._auxTripStatus (api.js): tiene que dar
  // exactamente lo mismo, porque Auxiliar.reloadTrips fusiona las dos fuentes.
  function uiStatus(raw, cancelledAt) {
    if (cancelledAt || raw === 'cancelled') return 'cancelled';
    if (raw === 'no_show') return 'noshow';
    if (['assigned', 'driver_assigned', 'ready'].includes(raw)) return 'assigned';
    if (['en_route', 'at_pickup'].includes(raw)) return 'onway';
    if (['on_board', 'picked_up', 'en_route_home'].includes(raw)) return 'onboard';
    if (raw === 'delivered') return 'done';
    return 'pending';
  }
  // Igual que _flightFromNotes de api.js (el vuelo vive en las notas).
  function flightFromNotes(notes) {
    const m = String(notes || '').match(/vuelo\s*:?\s*([A-Za-z]{0,3})\s*-?\s*(\d{2,5})/i);
    return m ? (m[1] + m[2]).toUpperCase() : '';
  }
  function initials(name) {
    const w = String(name || '').trim().split(/\s+/).filter(Boolean);
    return ((w[0] || '')[0] || '').toUpperCase() + ((w[1] || '')[0] || '').toUpperCase();
  }
  const num = (v) => (v == null || v === '' || isNaN(Number(v))) ? null : Number(v);
  // Mi lugar en el carro (0093): «2/3». Solo con la ruta publicada y con los dos
  // números enteros y coherentes (1 ≤ pos ≤ total); si no, [null, null].
  function pickupOrder(r) {
    if (!r || r.published !== true) return [null, null];
    const p = num(r.pickup_pos), n = num(r.pickup_total);
    if (!Number.isInteger(p) || !Number.isInteger(n) || p < 1 || n < p) return [null, null];
    return [p, n];
  }

  function mapTrip(r) {
    if (!r || !r.id) return null;
    const d = r.driver || null;
    const v = r.vehicle || null;
    const plate = (v && v.plate) || '';
    const [pickupPos, pickupTotal] = pickupOrder(r);
    return {
      id: r.id,
      type: r.direction === 'airport_to_home' ? 'lle' : 'sal',
      residenceId: r.residence_id || null,
      residenceUnit: r.residence_unit || null,
      level: r.service_level || 'shared',
      privateStatus: r.private_status || null,
      price: r.price_cop != null ? r.price_cop : null,
      privateReason: r.private_reject_reason || '',
      flight: ['rio_verde', 'movich', 'aero'].includes(r.reserve_place) ? '' : (r.flight_number || flightFromNotes(r.notes)),
      // Calculados EN EL SERVIDOR en hora de Bogotá.
      date: r.date || null,
      time: r.time || null,
      requiredAt: r.required_arrival_at || null,
      address: r.pickup_address || '',
      lat: r.pickup_latitude != null ? r.pickup_latitude : null,
      lng: r.pickup_longitude != null ? r.pickup_longitude : null,
      notes: r.notes || '',
      notesUser: r.notes_user != null ? r.notes_user : '',
      // Solo con plan publicado (el servidor ya lo filtra): nunca se inventa.
      published: r.published === true,
      // 0125: publicada en la ruta de Julián y sin conductor todavía (lo toma uno).
      driverPending: r.published === true && r.driver_pending === true,
      // 0126: la vuelta la hace alguien de afuera; lo contactan por WhatsApp.
      delegated: r.published === true && r.delegated === true,
      // 0131: a quién se delegó («Te recogerá X, su número es Y»); null = sin nombre.
      delegate: r.published === true && r.delegated === true && r.delegate && r.delegate.name
        ? { name: String(r.delegate.name), phone: r.delegate.phone ? String(r.delegate.phone) : '' } : null,
      pickupAt: r.published ? (r.pickup_at || null) : null,
      meetCode: r.published ? (r.meet_code || '') : '',
      // Orden en el carro (0093), solo publicado: pickupPos de pickupTotal.
      pickupPos,
      pickupTotal,
      // «Solo por tierra» (0092/0093): operación del aeropuerto sin vuelo.
      groundOps: r.ground_ops === true,
      status: uiStatus(r.raw_status, r.cancelled_at),
      rawStatus: r.raw_status || null,
      driver: d ? {
        name: d.name || '',
        first: String(d.name || '').trim().split(/\s+/)[0] || '',
        initials: initials(d.name),
        phone: d.phone || '',
        avatarUrl: d.avatar_url || '',
        rating: num(d.rating),          // null salvo con 10 o más calificaciones
        ratingN: num(d.rating_n) || 0,
        plate,                          // lo heredado lee t.driver.plate
      } : null,
      vehicle: v ? { plate, brand: v.brand || '', model: v.model || '', color: v.color || '' } : null,
      bags: r.bags != null ? r.bags : null,
      quiet: r.quiet_ride === true,
      meetingPoint: r.meeting_point || '',
      createdAt: r.created_at || null,
      stopStatus: r.stop_status || null,
      arrivedAt: r.arrived_at || null,
      pickedAt: r.picked_at || null,
      droppedAt: r.dropped_at || null,
      cancelledAt: r.cancelled_at || null,
      cancelReason: r.cancellation_reason || '',
      isPernocta: !!r.is_overnight,
      isReserva: r.is_firm !== false,
      // 0121: de reserva en un hotel o en el aeropuerto (null = vuelo). Mismas
      // llaves que la base; una desconocida se lee como vuelo.
      reservePlace: ['rio_verde', 'movich', 'aero'].includes(r.reserve_place) ? r.reserve_place : null,
      readyAt: r.ready_confirmed_at || null,
      rated: r.rating != null,
      rating: r.rating || 0,
    };
  }

  // ── Lecturas del tripulante ───────────────────────────────────────────────
  // T[] ordenados por hora. null → no hay RPC (0087 sin aplicar) o no hay
  // sesión: el llamador cae a Api.listMyReservations.
  async function listMyTrips(opts) {
    const days = opts && opts.daysBack ? Math.max(1, Math.min(400, Math.round(opts.daysBack))) : 120;
    const r = await rpc('auxiliar_my_trips', { p_days_back: days });
    if (r.missing) return null;
    if (r.error) { console.warn('[ApiAux.listMyTrips]', r.error.message || r.error); return null; }
    if (!Array.isArray(r.data)) return null;   // la RPC devolvió NULL: no es tripulante
    return r.data.map(mapTrip).filter(Boolean);
  }

  // { done, onTimePct|null, onTimeN } (+ los mismos en snake_case).
  // onTimePct es null con menos de 5 salidas medidas: «aún sin datos».
  async function getMyStats() {
    const r = await rpc('auxiliar_my_stats');
    if (r.missing) return null;
    if (r.error) { console.warn('[ApiAux.getMyStats]', r.error.message || r.error); return null; }
    const s = r.data; if (!s) return null;
    const done = num(s.done) || 0, pct = num(s.on_time_pct), n = num(s.on_time_n) || 0;
    return { done, onTimePct: pct, onTimeN: n, on_time_pct: pct, on_time_n: n };
  }

  // Nivel preferido y punto de encuentro del PERFIL (policy update_own).
  // Solo cambia lo que se manda: saveMyPrefs({meetingPoint:''}) borra el punto.
  async function saveMyPrefs(p) {
    const me = await uid(); if (!me) return null;
    const patch = {};
    if (p && 'preferredLevel' in p) {
      const lv = p.preferredLevel;
      if (lv != null && lv !== 'private' && lv !== 'shared') throw new Error('Nivel no válido');
      patch.preferred_service_level = lv || null;
    }
    if (p && 'meetingPoint' in p) {
      const mp = String(p.meetingPoint || '').trim();
      if (mp.length > 120) throw new Error('El punto de encuentro es muy largo (máximo 120 caracteres)');
      patch.meeting_point = mp || null;
    }
    // Dónde trabaja (0106): personal de tierra o una aerolínea. Van SIEMPRE
    // juntos — la base exige «tierra ⇒ sin aerolínea» —: groundStaff true borra
    // la aerolínea; con airlineId se sale de tierra.
    if (p && p.groundStaff === true) { patch.ground_staff = true; patch.airline_id = null; }
    else if (p && p.airlineId) { patch.ground_staff = false; patch.airline_id = p.airlineId; }
    if (!Object.keys(patch).length) return true;
    const { data, error } = await cli().from('auxiliar_profiles').update(patch).eq('profile_id', me).select('id');
    if (error) { if (falta(error)) return null; lanzar(error); }
    if (!data || !data.length) throw new Error('No encontramos tu perfil de tripulante');
    return true;
  }

  // «Cambió mi vuelo». date 'YYYY-MM-DD' y time 'HH:MM' en hora de Bogotá.
  // flight '' = en una salida se conserva el que tenía; en una llegada de
  // tierra (groundOps) no hay vuelo (0093; con 0089 sola la RPC lo rechaza).
  // → { mode:'updated'|'needs_ops'|'reassigned', incidentId?, requiredAt?, unchanged?, reassign? }
  // 0134: 'reassigned' = con la ruta publicada el sistema la cambió de vuelta solo
  // (reassign.kind: 'joined' entró en otra, 'new' vuelta nueva para tomar,
  // 'unplanned' el día aún no tiene ruta).
  async function changeFlight(reservationId, f) {
    if (!reservationId) throw new Error('Falta el traslado');
    const date = f && f.date, time = f && f.time;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^\d{2}:\d{2}$/.test(time || '')) {
      throw new Error('Elige el día y la hora');
    }
    // 0121: el lugar de la reserva. Sin `reservePlace` en f no se manda (queda
    // como estaba); 'vuelo' = ahora va en un vuelo; o la llave del lugar.
    const args = {
      p_reservation_id: reservationId,
      p_flight: (f && f.flight) || '',
      p_when: `${date}T${time}:00-05:00`,   // Colombia no tiene horario de verano
    };
    if (f && f.reservePlace !== undefined) args.p_reserve_place = f.reservePlace || 'vuelo';
    const r = await rpc('auxiliar_change_flight', args);
    if (r.missing) return null;
    if (r.error) lanzar(r.error, 'No se pudo cambiar el vuelo');
    const d = r.data || {};
    return {
      mode: d.mode === 'needs_ops' ? 'needs_ops' : d.mode === 'reassigned' ? 'reassigned' : 'updated',
      reassign: d.reassign && typeof d.reassign === 'object' ? {
        kind: d.reassign.kind || 'unplanned', pickupAt: d.reassign.pickup_at || null, startAt: d.reassign.start_at || null,
        driver: d.reassign.driver_name || '', tight: d.reassign.tight === true,
      } : null,
      incidentId: d.incident_id || null,
      requiredAt: d.required_arrival_at || null,
      unchanged: d.unchanged === true,
      notified: d.notified != null ? d.notified : null,
      reservePlace: d.reserve_place !== undefined ? (d.reserve_place || null) : undefined,
    };
  }

  // ── Coordinación (0088) ───────────────────────────────────────────────────
  function mapMsg(m) {
    const res = m.reservation || null;
    return {
      id: m.id,
      role: m.sender_role === 'admin' ? 'admin' : 'auxiliar',
      mine: m.mine === true,
      body: m.body || '',
      at: m.created_at || null,
      read: m.read === true,
      readAt: m.read_at || null,
      // 0113: quién del equipo escribió (primer nombre) y en qué conversación.
      // Sin 0113 vienen vacíos y la pantalla se comporta como antes.
      senderName: m.sender_name || '',
      conversationId: m.conversation_id || null,
      conversationOpen: m.conversation_open === undefined ? null : m.conversation_open === true,
      reservation: res ? {
        id: res.id, type: res.direction === 'airport_to_home' ? 'lle' : 'sal',
        date: res.date || null, time: res.time || null,
      } : null,
    };
  }

  // El hilo, en orden de llegada. Tripulante: sin argumento (el suyo).
  // Jefe: el id del perfil de tripulante (auxiliar_profiles.id).
  // 0113: sin conversationId trae la conversación ACTUAL (tripulante: la abierta,
  // o [] = chat nuevo; jefe: la abierta o la última); con él, esa del historial.
  // El parámetro solo se manda si hace falta: sin 0113 la función no lo conoce.
  async function crewList(auxId, conversationId) {
    const args = { p_auxiliar_profile_id: auxId || null, p_limit: 100 };
    if (conversationId) args.p_conversation_id = conversationId;
    const r = await rpc('crew_list_messages', args);
    if (r.missing) return null;
    if (r.error) { console.warn('[ApiAux.crewList]', r.error.message || r.error); return null; }
    return Array.isArray(r.data) ? r.data.map(mapMsg) : null;
  }

  // «Laura Gómez»: nombre y primer apellido de quien escribe, para el título
  // del aviso a los jefes (15-oct-2026: «Mensaje de un tripulante» no decía de
  // quién). Sale del perfil de la sesión: quien escribe es este dispositivo.
  function nombreCorto() {
    try {
      const p = (typeof state !== 'undefined' && state && state.profile) || null;
      return String((p && p.full_name) || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join(' ');
    } catch (_) { return ''; }
  }

  // Envía y avisa. Tripulante: crewSend(texto, {reservationId}) → a los jefes.
  // Jefe: crewSend(texto, {auxId, reservationId}) → al tripulante.
  async function crewSend(body, opts) {
    const o = opts || {};
    const r = await rpc('crew_send_message', {
      p_body: String(body || ''),
      p_auxiliar_profile_id: o.auxId || null,
      p_reservation_id: o.reservationId || null,
    });
    if (r.missing) return null;
    if (r.error) lanzar(r.error, 'No se pudo enviar');
    const d = r.data || {};
    const to = Array.isArray(d.recipient_profile_ids) ? d.recipient_profile_ids.filter(Boolean) : [];
    let notified = null;
    if (to.length && window.Api && typeof Api.sendPush === 'function') {
      const deTripulante = d.sender_role === 'auxiliar';
      // Del jefe al tripulante: «Coordinación (Julián)» (16-oct-2026: el
      // tripulante tiene que saber qué jefe le escribe).
      const jefe = d.sender_name || nombreCorto().split(' ')[0] || '';
      try {
        const p = await Api.sendPush({
          profileIds: to,
          title: deTripulante ? (nombreCorto() ? 'Mensaje de ' + nombreCorto() : 'Mensaje de un tripulante')
            : (jefe ? 'Coordinación (' + jefe + ')' : 'Coordinación'),
          body: String(body || '').trim().slice(0, 120),
          url: deTripulante ? '/#/coordinacion?aux=' + d.auxiliar_profile_id : '/#/coordinacion',
        });
        notified = (p && typeof p.sent === 'number') ? p.sent > 0 : null;
      } catch (_) { notified = false; }
    }
    return {
      id: d.id || null, createdAt: d.created_at || null, senderRole: d.sender_role || null,
      auxId: d.auxiliar_profile_id || null, reservationId: d.reservation_id || null,
      conversationId: d.conversation_id || null, newConversation: d.new_conversation === true,
      senderName: d.sender_name || '',
      recipients: to, notified,
    };
  }

  async function crewMarkRead(auxId) {
    const r = await rpc('crew_mark_read', { p_auxiliar_profile_id: auxId || null });
    if (r.missing) return null;
    if (r.error) lanzar(r.error, 'No se pudo marcar como leído');
    return num(r.data) || 0;
  }

  // Tripulante: lo del equipo sin leer. Jefe: lo de los tripulantes sin leer.
  async function crewUnread() {
    const r = await rpc('crew_unread');
    if (r.missing) return null;
    if (r.error) { console.warn('[ApiAux.crewUnread]', r.error.message || r.error); return null; }
    return r.data == null ? null : (num(r.data) || 0);
  }

  // Bandeja del jefe: un renglón por hilo, el más reciente primero.
  async function crewThreadsAdmin() {
    const r = await rpc('crew_threads_admin');
    if (r.missing) return null;
    if (r.error) { console.warn('[ApiAux.crewThreadsAdmin]', r.error.message || r.error); return null; }
    if (!Array.isArray(r.data)) return null;
    return r.data.map(t => ({
      auxId: t.auxiliar_profile_id, profileId: t.profile_id || null,
      name: t.name || '', phone: t.phone || '', residence: t.residence || '', sector: t.sector || '',
      lastBody: t.last_body || '', lastRole: t.last_role || null, lastAt: t.last_at || null,
      lastReservationId: t.last_reservation_id || null,
      unread: num(t.unread) || 0, total: num(t.total) || 0,
      // 0113 (sin ella: null y la bandeja no dice nada de conversaciones).
      lastSenderName: t.last_sender_name || '',
      conversationId: t.conversation_id || null,
      open: t.open === undefined ? null : t.open === true,
      conversations: t.conversations == null ? null : (num(t.conversations) || 0),
    }));
  }

  // ── Conversaciones (0113) ─────────────────────────────────────────────────
  // Historial de un tripulante (el suyo, sin argumento), la más reciente primero.
  async function crewConversations(auxId) {
    const r = await rpc('crew_conversations_list', { p_auxiliar_profile_id: auxId || null });
    if (r.missing) return null;
    if (r.error) { console.warn('[ApiAux.crewConversations]', r.error.message || r.error); return null; }
    if (!Array.isArray(r.data)) return null;
    return r.data.map(c => ({
      id: c.id, openedAt: c.opened_at || null, lastAt: c.last_at || null,
      open: c.open === true, closedAt: c.closed_at || null, closeReason: c.close_reason || null,
      closedByName: c.closed_by_name || '', messages: num(c.messages) || 0, unread: num(c.unread) || 0,
      firstBody: c.first_body || '', lastBody: c.last_body || '',
    }));
  }
  // «Resuelta»: un jefe cierra la conversación. El siguiente mensaje abre otra.
  async function crewClose(conversationId) {
    const r = await rpc('crew_close_conversation', { p_conversation_id: conversationId });
    if (r.missing) return null;
    if (r.error) lanzar(r.error, 'No se pudo cerrar la conversación');
    const d = r.data || {};
    return { id: d.id || conversationId, closedAt: d.closed_at || null, alreadyClosed: d.already_closed === true,
      closedByName: d.closed_by_name || '' };
  }

  // ── Teléfono y horario de Coordinación (app_settings, 0088) ───────────────
  // {phone, hours}; '' = no está cargado y la pantalla NO lo muestra.
  async function getOpsContact() {
    if (!(await uid())) return null;
    const { data, error } = await cli().from('app_settings')
      .select('ops_contact_phone, ops_contact_hours').eq('id', 'singleton').maybeSingle();
    if (error) { if (!falta(error)) console.warn('[ApiAux.getOpsContact]', error.message || error); return null; }
    if (!data) return null;
    return { phone: String(data.ops_contact_phone || '').trim(), hours: String(data.ops_contact_hours || '').trim() };
  }

  async function setOpsContact(p) {
    if (!(await uid())) return null;
    const patch = {};
    if (p && 'phone' in p) {
      const v = String(p.phone || '').trim();
      if (v.length > 30) throw new Error('El teléfono es muy largo');
      patch.ops_contact_phone = v || null;
    }
    if (p && 'hours' in p) {
      const v = String(p.hours || '').trim();
      if (v.length > 60) throw new Error('El horario es muy largo (máximo 60 caracteres)');
      patch.ops_contact_hours = v || null;
    }
    if (!Object.keys(patch).length) return true;
    const { data, error } = await cli().from('app_settings').update(patch).eq('id', 'singleton').select('id');
    if (error) { if (falta(error)) return null; lanzar(error); }
    if (!data || !data.length) throw new Error('Solo un administrador puede cambiar el contacto de Coordinación');
    return true;
  }

  // ── Color del carro (vehicles.color, 0086) ────────────────────────────────
  async function setVehicleColor(vehicleId, color) {
    if (!vehicleId) throw new Error('Falta el vehículo');
    if (!(await uid())) return null;
    const v = String(color || '').trim();
    if (v.length > 30) throw new Error('El color es muy largo (máximo 30 caracteres)');
    const { data, error } = await cli().from('vehicles').update({ color: v || null }).eq('id', vehicleId).select('id');
    if (error) { if (falta(error)) return null; lanzar(error); }
    if (!data || !data.length) throw new Error('No se pudo guardar el color de ese vehículo');
    return true;
  }

  window.ApiAux = {
    listMyTrips, getMyStats, saveMyPrefs, changeFlight,
    crewList, crewSend, crewMarkRead, crewUnread, crewThreadsAdmin,
    crewConversations, crewClose,
    getOpsContact, setOpsContact, setVehicleColor,
    mapTrip,
  };
})();
