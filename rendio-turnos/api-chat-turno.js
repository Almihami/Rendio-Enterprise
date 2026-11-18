// api-chat-turno.js — la API del chat del turno (migración 0173, 17-nov-2026).
// Un chat grupal entre los jefes y los conductores que están en turno.
//
//   window.ApiChatTurno = { resumen, leer, enviar, marcarLeido, historial }
//
// REGLA DE LA CASA: nunca datos falsos. Si la base todavía no tiene 0173 (o no hay
// sesión), `resumen()` y `leer()` lo dicen con { falta: true } y la pantalla no
// muestra el chat. Un error de red es { error: 'texto' }: la pantalla ofrece
// reintentar. `enviar()` LANZA con el texto del servidor (ya viene en español).
//
// El aviso (push) sale de aquí al enviar, como en los otros chats (Api.sendPush):
// la base devuelve a quién. Que falle el push no pierde el mensaje.
(function () {
  'use strict';

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

  // RPC con sesión. Devuelve { data } | { falta: true } | { error }.
  async function rpc(fn, args) {
    const sb = cli(); if (!sb) return { falta: true };
    if (!(await uid())) return { falta: true };
    let res;
    try { res = await sb.rpc(fn, args || {}); }
    catch (e) { return { error: e }; }
    if (res.error) return falta(res.error) ? { falta: true } : { error: res.error };
    return { data: res.data };
  }
  const txt = (e, d) => String((e && e.message) || d || 'No se pudo completar');
  const num = (x) => { const n = Number(x); return isFinite(n) ? n : 0; };

  const mapMsg = (m) => ({
    id: m.id, body: String(m.body || ''), at: m.at || null,
    senderId: m.sender_id || null, sender: m.sender || '', role: m.role === 'admin' ? 'admin' : 'driver',
    mine: m.mine === true, readAny: m.read_any === true, readDrivers: num(m.read_drivers),
    readIds: Array.isArray(m.read_ids) ? m.read_ids.filter(Boolean) : [],
    readNames: Array.isArray(m.read_names) ? m.read_names.filter(Boolean) : [],
  });
  const mapGente = (a) => (Array.isArray(a) ? a : []).map((p) => ({ id: p.id, name: p.name || '' })).filter((p) => p.id);

  // ¿Entro al chat de ahora? ¿Cuántos sin leer? ¿Cuál fue el último mensaje?
  async function resumen() {
    const r = await rpc('shift_chat_unread');
    if (r.falta) return { falta: true };
    if (r.error) { console.warn('[ApiChatTurno.resumen]', txt(r.error)); return { error: txt(r.error) }; }
    const d = r.data || {};
    const l = d.last || null;
    return {
      member: d.member === true, n: num(d.n), day: d.day || null, band: d.band || null,
      last: l ? { body: String(l.body || ''), at: l.at || null, sender: l.sender || '', role: l.role === 'admin' ? 'admin' : 'driver', mine: l.mine === true } : null,
    };
  }

  // El chat del turno de ahora; con (day, band), un turno anterior (solo jefes).
  async function leer(day, band) {
    const r = await rpc('shift_chat_list', day ? { p_day: day, p_band: band || null } : {});
    if (r.falta) return { falta: true };
    if (r.error) { console.warn('[ApiChatTurno.leer]', txt(r.error)); return { error: txt(r.error) }; }
    const d = r.data || {};
    if (d.ok !== true) return { ok: false, reason: d.reason || 'sin_acceso', day: d.day || null, band: d.band || null };
    return {
      ok: true, day: d.day, band: d.band, current: d.current === true, canWrite: d.can_write === true,
      since: d.since || null, me: d.me || null, role: d.role === 'admin' ? 'admin' : 'driver',
      drivers: mapGente(d.drivers), admins: mapGente(d.admins),
      messages: (Array.isArray(d.messages) ? d.messages : []).map(mapMsg),
    };
  }

  // Envía y avisa a los demás del chat.
  async function enviar(body) {
    const texto = String(body || '').trim();
    const r = await rpc('shift_chat_send', { p_body: texto });
    if (r.falta) throw new Error('El chat del turno todavía no está disponible');
    if (r.error) { const e = new Error(txt(r.error, 'No se pudo enviar')); if (r.error.code) e.code = r.error.code; throw e; }
    const d = r.data || {};
    const aJefes = Array.isArray(d.to_admins) ? d.to_admins.filter(Boolean) : [];
    const aCond = Array.isArray(d.to_drivers) ? d.to_drivers.filter(Boolean) : [];
    let avisados = null;
    if ((aJefes.length || aCond.length) && window.Api && typeof Api.sendPush === 'function') {
      const title = '💬 ' + (d.sender || 'Chat del turno') + (d.role === 'admin' ? ' · jefe' : '');
      const cuerpo = texto.slice(0, 140);
      const manda = (ids, url) => (ids.length ? Api.sendPush({ profileIds: ids, title, body: cuerpo, url }).then((p) => (p && typeof p.sent === 'number' ? p.sent : 0), () => 0) : Promise.resolve(0));
      try {
        const [a, b] = await Promise.all([manda(aJefes, '/#/operacion?chatturno=1'), manda(aCond, '/#/chat-turno')]);
        avisados = a + b;
      } catch (_) { avisados = 0; }
    }
    return { id: d.id || null, at: d.at || null, day: d.day || null, band: d.band || null, sender: d.sender || '', role: d.role === 'admin' ? 'admin' : 'driver', avisados };
  }

  // Marca leído lo del turno de ahora. Best-effort: devuelve cuántos (o null).
  async function marcarLeido() {
    const r = await rpc('shift_chat_mark_read');
    if (r.falta || r.error) return null;
    return num(r.data);
  }

  // Turnos anteriores con mensajes (solo jefes), el más reciente primero.
  async function historial() {
    const r = await rpc('shift_chat_history', { p_limit: 40 });
    if (r.falta) return null;
    if (r.error) { console.warn('[ApiChatTurno.historial]', txt(r.error)); return null; }
    return (Array.isArray(r.data) ? r.data : []).map((h) => ({ day: h.day, band: h.band, n: num(h.n), firstAt: h.first_at || null, lastAt: h.last_at || null }));
  }

  window.ApiChatTurno = { resumen, leer, enviar, marcarLeido, historial };
})();
