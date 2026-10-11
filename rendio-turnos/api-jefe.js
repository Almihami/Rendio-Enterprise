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

  // Se cuelga del window.Api de api.js (no lo reemplaza: Object.assign).
  Object.assign(window.Api, {
    getShiftTimes, profileNames, listMyShiftsForHours, normalizarCelular, setMyPhone,
  });
})();
