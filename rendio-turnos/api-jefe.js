// api-jefe.js — Pedidos del jefe de operación (audios del 11-oct-2026): lo que
// esas pantallas leen y escriben en la base. Va aparte de api.js para no
// engordarlo más, pero cuelga de window.Api como todo lo demás (después de
// api.js en index.html: usa window.sb).
//
// Contrato:
//   Api.getShiftTimes(shiftId)         → { id, status, start_at, end_at, opening_km,
//                                          closing_km, notes } | null
//       Las horas del turno de una inspección (detalle de Inspecciones). RLS:
//       p_shifts_select_admin (0016) deja al jefe leer los de su organización.
//   Api.profileNames(ids)              → { [profile_id]: full_name }
//       Para decir QUIÉN revisó una inspección (inspections.reviewed_by).
//   Api.listMyShiftsForHours(driverId, desdeISO, hastaISO)
//       → turnos del conductor que ARRANCARON en [desde, hasta), TODOS los
//         estados (también auto-cerrados y en curso: el perfil tiene que poder
//         decir «este no cuenta»). RLS: p_shifts_select_own (0016).
//   Api.normalizarCelular(texto)       → '3001234567' | null   (pura, sin red)
//   Api.setMyPhone(texto)              → el celular guardado, normalizado
//       RPC set_my_phone (0098). Sin 0098 en la base, guarda directo en
//       profiles.phone (0081 deja al usuario cambiar su teléfono) con la MISMA
//       validación de acá; así el front se puede desplegar antes que la
//       migración sin que la ventana del celular deje a nadie encerrado.
//
// «Olvidé mi contraseña» (0104, 12-oct-2026): no hay correo, así que el pedido
// le llega a Coordinación, que pone una temporal con admin_set_password.
//   Api.contactoParaClave(texto)       → { tipo: 'correo'|'celular', valor } | null
//       (pura, sin red) Lo que acepta el login: un correo o un celular de 10
//       dígitos que empiece por 3 (la misma regla de la base).
//   Api.requestPasswordReset(texto)    → true
//       RPC request_password_reset, SIN sesión (anon). La base responde lo
//       mismo exista o no la cuenta: aquí no se sabe ni se dice si existe.
//   Api.listPasswordResetRequests()    → [{ id, profileId, name, email, phone,
//                                            role, contact, createdAt }]
//       Los pendientes de la organización, el más nuevo primero. RLS: solo
//       jefes. Sin 0104 en la base devuelve [] (Usuarios funciona igual).
//   Api.resolvePasswordResetRequest(id, status)  → status ('done' | 'dismissed')
//       Quién y cuándo lo sella la base (trigger de 0104).
(function () {
  'use strict';
  const sb = () => window.sb;

  // «Esto todavía no existe en esta base»: función, tabla o columna.
  function faltaEnLaBase(e) {
    if (!e) return false;
    if (/^(PGRST202|PGRST205|PGRST204|42883|42P01|42703)$/.test(String(e.code || ''))) return true;
    return /Could not find the (function|table)|schema cache|does not exist/i.test(String(e.message || ''));
  }

  async function getShiftTimes(shiftId) {
    if (!shiftId) return null;
    const { data, error } = await sb().from('shifts')
      .select('id, status, start_at, end_at, opening_km, closing_km, notes')
      .eq('id', shiftId).maybeSingle();
    if (error) throw error;
    return data || null;
  }

  async function profileNames(ids) {
    const lista = [...new Set((ids || []).filter(Boolean))];
    if (!lista.length) return {};
    const { data, error } = await sb().from('profiles').select('id, full_name').in('id', lista);
    if (error) throw error;
    const out = {};
    (data || []).forEach(p => { out[p.id] = p.full_name || ''; });
    return out;
  }

  async function listMyShiftsForHours(driverId, desdeISO, hastaISO) {
    if (!driverId) return [];
    const { data, error } = await sb().from('shifts')
      .select('id, status, start_at, end_at, opening_km, closing_km, vehicles(internal_code, license_plate)')
      .eq('driver_id', driverId)
      .gte('start_at', desdeISO).lt('start_at', hastaISO)
      .order('start_at', { ascending: false });
    if (error) throw error;
    return data || [];
  }

  // Celular colombiano: 10 dígitos que empiezan por 3. Acepta espacios, guiones,
  // puntos, paréntesis y el indicativo (+57 o 57). Es la MISMA regla que
  // set_my_phone (0098); la base la vuelve a aplicar.
  function normalizarCelular(texto) {
    const raw = String(texto == null ? '' : texto).trim();
    if (!raw || /[^0-9+\s().-]/.test(raw)) return null;
    let d = raw.replace(/[\s().-]/g, '');
    if (/^\+57/.test(d)) d = d.slice(3);
    else if (/^57\d{10}$/.test(d)) d = d.slice(2);
    return /^3\d{9}$/.test(d) ? d : null;
  }

  async function setMyPhone(texto) {
    const norm = normalizarCelular(texto);
    if (!norm) throw new Error('El celular debe tener 10 dígitos y empezar por 3.');
    const { data, error } = await sb().rpc('set_my_phone', { p_phone: String(texto) });
    if (!error) return (typeof data === 'string' && data) ? data : norm;
    if (!faltaEnLaBase(error)) throw error;
    // Base sin 0098: el mismo número, directo a la fila propia.
    const { data: s } = await sb().auth.getSession();
    const uid = s && s.session && s.session.user && s.session.user.id;
    if (!uid) throw new Error('Tu sesión se cerró. Vuelve a entrar e inténtalo otra vez.');
    const r = await sb().from('profiles').update({ phone: norm }).eq('id', uid);
    if (r.error) throw r.error;
    return norm;
  }

  // ── «Olvidé mi contraseña» (0104) ──
  function contactoParaClave(texto) {
    const raw = String(texto == null ? '' : texto).trim();
    if (!raw || raw.length > 254) return null;
    if (raw.includes('@')) {
      const v = raw.toLowerCase();
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? { tipo: 'correo', valor: v } : null;
    }
    const cel = normalizarCelular(raw);
    return cel ? { tipo: 'celular', valor: cel } : null;
  }

  async function requestPasswordReset(texto) {
    const c = contactoParaClave(texto);
    if (!c) throw new Error('Escribe el correo de tu cuenta o tu celular de 10 dígitos.');
    const { error } = await sb().rpc('request_password_reset', { p_contact: c.valor });
    if (error) throw error;
    return true;
  }

  async function listPasswordResetRequests() {
    const { data, error } = await sb().from('password_reset_requests')
      .select('id, profile_id, contact, created_at, '
        + 'profiles!password_reset_requests_profile_id_fkey(id, full_name, email, phone, role)')
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) { if (faltaEnLaBase(error)) return []; throw error; }
    return (data || []).map(r => ({
      id: r.id,
      profileId: r.profile_id || null,
      name: (r.profiles && r.profiles.full_name) || '',
      email: (r.profiles && r.profiles.email) || '',
      phone: (r.profiles && r.profiles.phone) || '',
      role: (r.profiles && r.profiles.role) || '',
      contact: r.contact || '',
      createdAt: r.created_at || null,
    }));
  }

  async function resolvePasswordResetRequest(id, status) {
    if (!id) throw new Error('Falta el pedido.');
    if (!['done', 'dismissed'].includes(status)) throw new Error('Estado desconocido: ' + status);
    const { data, error } = await sb().from('password_reset_requests')
      .update({ status }).eq('id', id).select('id, status').maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('Ese pedido ya no está o no es de tu organización.');
    return data.status;
  }

  // Se cuelga del window.Api de api.js (no lo reemplaza: Object.assign).
  Object.assign(window.Api, {
    getShiftTimes, profileNames, listMyShiftsForHours, normalizarCelular, setMyPhone,
    contactoParaClave, requestPasswordReset, listPasswordResetRequests, resolvePasswordResetRequest,
  });
})();
