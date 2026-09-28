// api-puntos.js — Rendio Points: la API (paquete P13a del rediseño del auxiliar, 27-sep-2026).
//
// Todo lo que habla con la base para los puntos pasa por aquí (window.ApiPuntos).
// La base es 0091_rendio_points.sql:
//   · el programa nace APAGADO (app_settings.aux_points_enabled = false);
//   · los puntos los acredita la BASE con triggers (primer viaje ENTREGADO del
//     colega que usó tu código —×2 si vive en tu conjunto—, cancelar con la hora
//     de recogida publicada y ≥ N h de anticipación, primera calificación de un
//     viaje entregado). El teléfono NUNCA suma puntos: solo lee y pide canjes;
//   · los puntos no son plata: no se retiran ni se transfieren;
//   · RLS: cada tripulante ve SOLO su saldo y sus movimientos.
//
// Regla de la casa (feedback-no-inventar-datos): si falta la RPC/tabla (base sin
// 0091) o no hay sesión, las lecturas devuelven null — nunca un saldo inventado.
// Los errores de verdad (red, permisos) se lanzan con el texto de la base, que
// ya viene en español para mostrarlo tal cual.
//
// Contrato (lo leen P13b: aux-rx-puntos.js / admin-puntos.js, y P11 en el registro):
//   Tripulante: settings, summary, movements, rewards, redeem, myRedemptions,
//               myCode, myReferrals, claimReferral, goal
//   Ayudas puras (sin red): normalizeCode, nextReward, cancelEarns, movementTitle,
//               inviteLink, inviteText, refFromUrl
//   Jefe: adminSettings, adminSaveSettings, adminSaveReward, adminRedemptions,
//         adminPendingCount, adminDecide, adminAdjust, adminBalances
(function () {
  'use strict';

  // --------------------------------------------------------------------------
  // Utilidades internas
  // --------------------------------------------------------------------------
  const client = () => window.sb || null;

  // «Esto todavía no existe en esta base» (sin 0091): función, tabla o columna.
  function isMissing(e) {
    if (!e) return false;
    const code = String(e.code || '');
    if (/^(PGRST202|PGRST205|PGRST204|42883|42P01|42703)$/.test(code)) return true;
    return /Could not find the (function|table)|schema cache|does not exist/i.test(String(e.message || ''));
  }

  function toError(e) {
    const err = new Error((e && (e.message || e.hint || e.details)) || 'No pudimos completar la operación');
    if (e && e.code) err.code = e.code;
    return err;
  }

  async function hasSession() {
    const sb = client();
    if (!sb || !sb.auth) return false;
    try {
      const { data } = await sb.auth.getSession();
      return !!(data && data.session);
    } catch (e) { return false; }
  }

  // Lectura por RPC: null si no hay sesión o falta la función.
  async function readRpc(fn, args) {
    if (!(await hasSession())) return null;
    const { data, error } = await client().rpc(fn, args || {});
    if (error) { if (isMissing(error)) return null; throw toError(error); }
    return data;
  }

  // Acción por RPC: sin sesión o sin 0091 no se finge un éxito, se avisa.
  async function actRpc(fn, args) {
    if (!(await hasSession())) throw new Error('Tu sesión se cerró. Vuelve a entrar.');
    const { data, error } = await client().rpc(fn, args || {});
    if (error) {
      if (isMissing(error)) throw new Error('Rendio Points todavía no está disponible');
      throw toError(error);
    }
    return data;
  }

  const int = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : d; };

  // --------------------------------------------------------------------------
  // Ajustes (interruptor y valores). Los lee cualquiera con sesión (RLS de
  // app_settings: select para todos); los escribe solo el jefe.
  // --------------------------------------------------------------------------
  const SETTINGS_COLS = 'aux_points_enabled, aux_points_invite, aux_points_neighbor, aux_points_cancel, '
    + 'aux_points_cancel_lead_hours, aux_points_rate, aux_points_goal_target, aux_points_goal_text';

  function mapSettings(r) {
    if (!r) return null;
    return {
      enabled: r.aux_points_enabled === true,
      invite: int(r.aux_points_invite),
      neighbor: int(r.aux_points_neighbor),
      cancel: int(r.aux_points_cancel),
      cancelLeadHours: int(r.aux_points_cancel_lead_hours, 2),
      rate: int(r.aux_points_rate),
      goalTarget: r.aux_points_goal_target == null ? null : int(r.aux_points_goal_target),
      goalText: r.aux_points_goal_text || '',
    };
  }

  async function settings() {
    if (!(await hasSession())) return null;
    const { data, error } = await client().from('app_settings').select(SETTINGS_COLS).eq('id', 'singleton').maybeSingle();
    if (error) { if (isMissing(error)) return null; throw toError(error); }
    return mapSettings(data);
  }

  // --------------------------------------------------------------------------
  // Tripulante
  // --------------------------------------------------------------------------

  // { enabled, balance, pendingCount, pendingPoints, earnedTotal, invitedCount,
  //   invitedDone, values:{invite, neighbor, cancel, cancelLeadHours, rate} } | null
  async function summary() {
    const s = await readRpc('aux_points_my_summary');
    if (!s) return null;
    const v = s.values || {};
    return {
      enabled: s.enabled === true,
      balance: int(s.balance),
      pendingCount: int(s.pending_count),
      pendingPoints: int(s.pending_points),
      earnedTotal: int(s.earned_total),
      invitedCount: int(s.invited_count),
      invitedDone: int(s.invited_done),
      values: {
        invite: int(v.invite), neighbor: int(v.neighbor), cancel: int(v.cancel),
        cancelLeadHours: int(v.cancel_lead_hours, 2), rate: int(v.rate),
      },
    };
  }

  // Título de un movimiento (el subtítulo es la nota que escribió la base).
  function movementTitle(kind, note) {
    switch (kind) {
      case 'referral':
      case 'referral_neighbor': return 'Tu colega hizo su primer viaje';
      case 'cancel_early': return 'Avisaste que ya no viajabas';
      case 'rate': return 'Calificaste tu viaje';
      case 'redeem': return note ? `Canjeaste «${note}»` : 'Canjeaste puntos';
      case 'redeem_refund': return 'Te devolvimos un canje';
      case 'adjust': return 'Ajuste de Coordinación';
      default: return 'Movimiento';
    }
  }

  // [{ id, points, kind, title, sub, at, reservationId, redemptionId }] | null
  async function movements(opts) {
    if (!(await hasSession())) return null;
    const limit = Math.min(200, Math.max(1, int(opts && opts.limit, 50)));
    const { data, error } = await client().from('aux_points_ledger')
      .select('id, points, kind, note, created_at, reservation_id, redemption_id')
      .order('created_at', { ascending: false }).limit(limit);
    if (error) { if (isMissing(error)) return null; throw toError(error); }
    return (data || []).map(r => ({
      id: r.id,
      points: int(r.points),
      kind: r.kind,
      title: movementTitle(r.kind, r.note),
      // En un canje la nota ES el título; no se repite abajo.
      sub: r.kind === 'redeem' ? '' : (r.note || ''),
      at: r.created_at,
      reservationId: r.reservation_id || null,
      redemptionId: r.redemption_id || null,
    }));
  }

  // Vitrina: [{ id, title, description, cost, kind, amount, enabled, soon, sort }] | null
  async function rewards() {
    if (!(await hasSession())) return null;
    const { data, error } = await client().from('aux_points_rewards')
      .select('id, title, description, cost, kind, amount, enabled, soon, sort')
      .order('sort', { ascending: true });
    if (error) { if (isMissing(error)) return null; throw toError(error); }
    return (data || []).map(r => ({
      id: r.id, title: r.title, description: r.description, cost: int(r.cost), kind: r.kind,
      amount: r.amount == null ? null : int(r.amount), enabled: r.enabled === true, soon: r.soon === true, sort: int(r.sort),
    }));
  }

  // Canjear: descuenta ya y queda pendiente para que el jefe lo cumpla.
  // → { ok, redemptionId, balance }. Lanza con el texto de la base
  // («Te faltan 35 pts para este canje», «… llega pronto», suspendido, apagado).
  async function redeem(rewardId, note) {
    const r = await actRpc('aux_points_redeem', { p_reward_id: rewardId, p_note: note || null });
    return { ok: !!(r && r.ok), redemptionId: r && r.redemption_id, balance: int(r && r.balance) };
  }

  // Mis canjes: [{ id, rewardId, title, cost, status:'pending'|'fulfilled'|'rejected',
  //   note, requestedAt, decidedAt, decisionNote }] | null
  async function myRedemptions() {
    if (!(await hasSession())) return null;
    const { data, error } = await client().from('aux_points_redemptions')
      .select('id, reward_id, reward_title, cost, status, note, requested_at, decided_at, decision_note')
      .order('requested_at', { ascending: false }).limit(100);
    if (error) { if (isMissing(error)) return null; throw toError(error); }
    return (data || []).map(r => ({
      id: r.id, rewardId: r.reward_id, title: r.reward_title, cost: int(r.cost), status: r.status,
      note: r.note || '', requestedAt: r.requested_at, decidedAt: r.decided_at || null, decisionNote: r.decision_note || '',
    }));
  }

  // Mi código (tipo LAURA-OLV). Se crea la primera vez con el programa
  // encendido; apagado y sin código → null.
  async function myCode() {
    const c = await readRpc('aux_points_my_code');
    return c || null;
  }

  // «Invitaste a»: SOLO quien se registró con mi código.
  // [{ name:'Diana R.', initials:'DR', status:'ok'|'wait', points, neighbor, claimedAt, creditedAt }] | null
  async function myReferrals() {
    const rows = await readRpc('aux_points_my_referrals');
    if (!rows) return null;
    return rows.map(r => ({
      name: r.display_name, initials: r.initials || '', status: r.status === 'ok' ? 'ok' : 'wait',
      points: r.points == null ? null : int(r.points), neighbor: r.neighbor === true,
      claimedAt: r.claimed_at, creditedAt: r.credited_at || null,
    }));
  }

  // «¿Te invitó alguien?» Se llama DESPUÉS de registerAuxiliar (la firma del
  // registro no cambia). → { ok:true } o lanza («Ese código no existe…»).
  async function claimReferral(code) {
    const c = normalizeCode(code);
    if (!c) throw new Error('Escribe el código de quien te invitó');
    const r = await actRpc('aux_points_claim_referral', { p_code: c });
    return { ok: !!(r && r.ok) };
  }

  // Meta anónima del conjunto: { residenceName, count, target, text, pct } | null.
  // null = no hay tarjeta (apagado, sin meta/texto del jefe o sin conjunto).
  async function goal() {
    const g = await readRpc('aux_points_my_goal');
    if (!g) return null;
    const count = int(g.count), target = int(g.target);
    return {
      residenceName: g.residence_name, count, target, text: g.text || '',
      pct: target > 0 ? Math.min(100, Math.round((count / target) * 100)) : 0,
    };
  }

  // --------------------------------------------------------------------------
  // Ayudas puras (sin red)
  // --------------------------------------------------------------------------

  // « laura-olv » → «LAURA-OLV» (sin tildes ni espacios). Igual que la base.
  function normalizeCode(s) {
    return String(s == null ? '' : s)
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/\s+/g, '').toUpperCase();
  }

  // El canje más barato que TODAVÍA no alcanzas (sin «Pronto» ni apagados).
  // → { id, title, cost, missing } | null (null = ya alcanzas todos, o no hay vitrina).
  function nextReward(balance, list) {
    const b = int(balance);
    const opts = (list || []).filter(r => r && r.enabled && !r.soon).sort((a, z) => a.cost - z.cost);
    const n = opts.find(r => r.cost > b);
    return n ? { id: n.id, title: n.title, cost: n.cost, missing: n.cost - b } : null;
  }

  // ¿Cancelar ESTE viaje ahora suma puntos? Misma regla que el trigger de 0091:
  // programa encendido, hora de recogida PUBLICADA (t.pickupAt) y al menos
  // cancelLeadHours de anticipación. cfg = settings() o summary().
  // → número de puntos | null.
  function cancelEarns(t, cfg, nowMs) {
    if (!t || !cfg || cfg.enabled !== true) return null;
    const v = cfg.values || cfg;
    const pts = int(v.cancel), lead = int(v.cancelLeadHours, 2);
    if (pts <= 0 || !t.pickupAt) return null;
    const st = t.status;
    if (st && !['pending', 'assigned'].includes(st)) return null;
    const pk = Date.parse(t.pickupAt);
    if (!Number.isFinite(pk)) return null;
    const now = nowMs == null ? Date.now() : nowMs;
    return pk - now >= lead * 3600e3 ? pts : null;
  }

  // Enlace para invitar: la app con ?ref=CODIGO (el registro lo puede prellenar
  // con refFromUrl()).
  function inviteLink(code) {
    const c = normalizeCode(code);
    if (!c) return '';
    let origin = '';
    try { origin = window.location.origin || ''; } catch (e) { /* */ }
    return `${origin}/?ref=${encodeURIComponent(c)}`;
  }

  function inviteText(code) {
    const c = normalizeCode(code);
    if (!c) return '';
    const link = inviteLink(c);
    return `Te invito a pedir tus traslados con Rendio. Cuando te registres, escribe mi código ${c}.` + (link ? ` ${link}` : '');
  }

  // Código que vino en el enlace (?ref=), para prellenar el registro. '' si no hay.
  function refFromUrl(href) {
    try {
      const u = new URL(href || window.location.href);
      return normalizeCode(u.searchParams.get('ref') || '');
    } catch (e) { return ''; }
  }

  // --------------------------------------------------------------------------
  // Jefe
  // --------------------------------------------------------------------------
  const adminSettings = settings;

  // patch: { enabled, invite, neighbor, cancel, cancelLeadHours, rate, goalTarget, goalText }
  // (solo lo que venga). → settings actualizados.
  async function adminSaveSettings(patch) {
    if (!(await hasSession())) throw new Error('Tu sesión se cerró. Vuelve a entrar.');
    const p = patch || {}, row = {};
    const pts = (k, col) => {
      if (p[k] === undefined) return;
      const n = Number(p[k]);
      if (!Number.isInteger(n) || n < 0 || n > 5000) throw new Error('Los puntos van de 0 a 5000');
      row[col] = n;
    };
    if (p.enabled !== undefined) row.aux_points_enabled = p.enabled === true;
    pts('invite', 'aux_points_invite');
    pts('neighbor', 'aux_points_neighbor');
    pts('cancel', 'aux_points_cancel');
    pts('rate', 'aux_points_rate');
    if (p.cancelLeadHours !== undefined) {
      const h = Number(p.cancelLeadHours);
      if (!Number.isInteger(h) || h < 1 || h > 48) throw new Error('La anticipación va de 1 a 48 horas');
      row.aux_points_cancel_lead_hours = h;
    }
    if (p.goalTarget !== undefined) {
      if (p.goalTarget === null || p.goalTarget === '') row.aux_points_goal_target = null;
      else {
        const g = Number(p.goalTarget);
        if (!Number.isInteger(g) || g < 1 || g > 500) throw new Error('La meta va de 1 a 500 tripulantes');
        row.aux_points_goal_target = g;
      }
    }
    if (p.goalText !== undefined) {
      const tx = String(p.goalText || '').trim();
      if (tx.length > 160) throw new Error('El texto de la meta va hasta 160 caracteres');
      row.aux_points_goal_text = tx || null;
    }
    if (!Object.keys(row).length) return settings();
    const { data, error } = await client().from('app_settings').update(row).eq('id', 'singleton').select(SETTINGS_COLS).maybeSingle();
    if (error) { if (isMissing(error)) throw new Error('Rendio Points todavía no está disponible'); throw toError(error); }
    if (!data) throw new Error('No se guardó: solo el jefe cambia estos valores');
    return mapSettings(data);
  }

  // Vitrina: el jefe cambia costo y si está disponible (título, tipo y «Pronto»
  // los fija la base). → la fila actualizada.
  async function adminSaveReward(id, patch) {
    if (!(await hasSession())) throw new Error('Tu sesión se cerró. Vuelve a entrar.');
    const p = patch || {}, row = {};
    if (p.cost !== undefined) {
      const n = Number(p.cost);
      if (!Number.isInteger(n) || n < 1 || n > 100000) throw new Error('El costo va de 1 a 100000 pts');
      row.cost = n;
    }
    if (p.enabled !== undefined) row.enabled = p.enabled === true;
    if (!Object.keys(row).length) return null;
    const { data, error } = await client().from('aux_points_rewards').update(row).eq('id', id)
      .select('id, title, description, cost, kind, amount, enabled, soon, sort').maybeSingle();
    if (error) { if (isMissing(error)) throw new Error('Rendio Points todavía no está disponible'); throw toError(error); }
    if (!data) throw new Error('No se guardó: solo el jefe cambia la vitrina');
    return { ...data, cost: int(data.cost) };
  }

  // Canjes de su organización (por defecto los pendientes; 'all' = todos).
  // [{ id, auxId, name, residence, rewardId, title, kind, amount, cost, status,
  //    note, requestedAt, decidedAt, decisionNote, balance }] | null
  async function adminRedemptions(status) {
    const rows = await readRpc('aux_points_admin_redemptions', { p_status: status || 'pending' });
    if (!rows) return null;
    return rows.map(r => ({
      id: r.id, auxId: r.auxiliar_profile_id, name: r.full_name || '', residence: r.residence_name || '',
      rewardId: r.reward_id, title: r.reward_title, kind: r.reward_kind || null,
      amount: r.reward_amount == null ? null : int(r.reward_amount), cost: int(r.cost), status: r.status,
      note: r.note || '', requestedAt: r.requested_at, decidedAt: r.decided_at || null,
      decisionNote: r.decision_note || '', balance: int(r.balance),
    }));
  }

  // Cuántos canjes esperan al jefe (para un globo en la consola). null sin 0091.
  async function adminPendingCount() {
    if (!(await hasSession())) return null;
    const { count, error } = await client().from('aux_points_redemptions')
      .select('id', { count: 'exact', head: true }).eq('status', 'pending');
    if (error) { if (isMissing(error)) return null; throw toError(error); }
    return count == null ? null : count;
  }

  // action: 'fulfill' | 'reject' (rechazar pide motivo y devuelve los puntos).
  async function adminDecide(redemptionId, action, note) {
    const r = await actRpc('aux_points_admin_decide', { p_redemption_id: redemptionId, p_action: action, p_note: note || null });
    return { ok: !!(r && r.ok), status: r && r.status, balance: int(r && r.balance) };
  }

  // Ajuste manual con nota (el tripulante la ve). No deja el saldo en negativo.
  async function adminAdjust(auxId, points, note) {
    const r = await actRpc('aux_points_admin_adjust', { p_aux: auxId, p_points: int(points), p_note: note || '' });
    return { ok: !!(r && r.ok), balance: int(r && r.balance) };
  }

  // Saldos de la organización.
  // [{ auxId, name, residence, balance, earned, invited, invitedDone, pending, code }] | null
  async function adminBalances() {
    const rows = await readRpc('aux_points_admin_balances');
    if (!rows) return null;
    return rows.map(r => ({
      auxId: r.auxiliar_profile_id, name: r.full_name || '', residence: r.residence_name || '',
      balance: int(r.balance), earned: int(r.earned), invited: int(r.invited), invitedDone: int(r.invited_done),
      pending: int(r.pending), code: r.code || null,
    }));
  }

  window.ApiPuntos = {
    // tripulante
    settings, summary, movements, rewards, redeem, myRedemptions, myCode, myReferrals, claimReferral, goal,
    // ayudas puras
    normalizeCode, nextReward, cancelEarns, movementTitle, inviteLink, inviteText, refFromUrl,
    // jefe
    adminSettings, adminSaveSettings, adminSaveReward, adminRedemptions, adminPendingCount,
    adminDecide, adminAdjust, adminBalances,
  };
})();
