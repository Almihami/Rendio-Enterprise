// api-cobro.js — Facturario: la cuenta de cobro mensual del tripulante (0090).
// Paquete P12a (rediseño del auxiliar, 27-sep-2026 · AJUSTES §5 y §8).
//
// Todo lo que habla con Supabase para Pagos pasa por aquí. Expone
// window.ApiCobro con dos mitades:
//   · tripulante: mi cuenta, historial, métodos de pago, avisos, preferencias y
//     subir el comprobante al bucket PRIVADO `payment-proofs`;
//   · jefe: listar cuentas, editar la cuenta de un tripulante, métodos y
//     configuración de la organización, revisar / aprobar / rechazar con motivo,
//     marcar pagado, corregir o descontar una cuenta de cobro.
//
// Las reglas (corte → aviso → vence → vencido → último día → pausa) viven en la
// BASE (0090, igual que cbSimulate de cobro-engine.jsx). Aquí no se calcula
// ningún estado: solo se lee y se da forma. `toSim()` entrega la cuenta con la
// forma exacta de cbSimulate para que las pantallas porten el diseño tal cual.
//
// Sin monto cargado por el jefe, myAccount() devuelve null: la pantalla dice
// «Todavía no tienes mensualidad registrada». Nunca un monto inventado.
//
// IIFE; solo exporta window.ApiCobro. `window.sb` se lee en cada llamada (no al
// cargar), así el archivo se puede evaluar antes de que exista el cliente.
(function () {
  'use strict';

  const BUCKET = 'payment-proofs';
  const PAUSE_CODE = 'RB402';
  // El texto fijo de la base (guard_billing_pause, 0090). Si cambia allá, cambia aquí.
  const PAUSE_MESSAGE = 'Tus reservas están pausadas por un cobro pendiente. Tus viajes ya confirmados siguen en pie.';
  // CB_REASONS del diseño (cobro-engine.jsx), tal cual. La base los valida.
  const REASONS = Object.freeze(['No se lee el comprobante', 'El monto no coincide',
    'No es a la cuenta de Rendio', 'La fecha es anterior al cobro']);
  // Los avisos que «Requieren acción» en Cb2Notifs.
  const ACTION_KEYS = Object.freeze(['vencido', 'ultimoDia', 'bloqueado', 'rechazado', 'venceHoy']);

  const client = () => {
    const c = window.sb;
    if (!c) throw new Error('Sin conexión con el servidor');
    return c;
  };
  const rpc = async (fn, args) => {
    const { data, error } = await client().rpc(fn, args || {});
    if (error) throw error;
    return data;
  };

  let _last = null;          // última respuesta de myAccount (o null)
  let _lastAt = 0;

  // ==========================================================================
  // Formato (idéntico a cobro-engine.jsx: cbMoney, cbFmt, cbPl)
  // ==========================================================================
  const MES_CORTO = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];
  const MES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
    'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const DIA = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
  // 'AAAA-MM-DD' → partes, sin pasar por la zona horaria del teléfono.
  const parts = (iso) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    return m ? { y: +m[1], mo: +m[2], d: +m[3] } : null;
  };
  function money(n) {
    if (n == null || !isFinite(n)) return '';
    return '$' + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }
  function fmtDay(iso) {                       // «19 de oct»
    const p = parts(iso); if (!p) return '';
    return p.d + ' de ' + MES_CORTO[p.mo - 1];
  }
  function fmtDayLong(iso) {                   // «lun, 19 de oct»
    const p = parts(iso); if (!p) return '';
    const wd = new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay();
    return DIA[wd] + ', ' + fmtDay(iso);
  }
  function monthName(iso, cap) {               // «octubre» / «Octubre»
    const p = parts(iso); if (!p) return '';
    const s = MES[p.mo - 1];
    return cap ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }
  function monthLabel(iso) {                   // «Octubre 2026»
    const p = parts(iso); if (!p) return '';
    return monthName(iso, true) + ' ' + p.y;
  }
  const pl = (n, s, p) => n + ' ' + (n === 1 ? s : p);

  // ==========================================================================
  // Estado para las pantallas
  // ==========================================================================

  // El estado que usa el contrato AuxPagos.summary(): la precedencia de cbBanner
  // (en revisión → rechazado sin pausa → estado base).
  function statusOf(cur) {
    if (!cur) return null;
    if (cur.comp === 'review') return 'review';
    if (cur.comp === 'rejected' && !cur.blocked && !cur.paid) return 'rejected';
    return cur.base;
  }

  // La cuenta con la forma de cbSimulate (sim) y CB_CFG (cfg). Los días son
  // índices relativos al corte (día 0), como en el diseño; las fechas reales van
  // aparte en `dates` para no tener que reconstruirlas.
  //   alerts (opcional): filas de alerts() para llenar sim.aux.
  function toSim(account, alerts) {
    const cur = account && account.current;
    if (!cur) return null;
    const i = cur.idx || {};
    const periodStart = cur.periodStart;
    const aux = (alerts || [])
      .filter(a => a.statementId === cur.id || a.statement_id === cur.id)
      .map(a => ({
        key: a.key,
        day: a.dayIndex != null ? a.dayIndex : a.day_index,
        ...(a.payload || {}),
        id: a.id,
        title: a.title, body: a.body, tone: a.tone, createdAt: a.createdAt || a.created_at,
      }))
      .sort((x, y) => (x.day - y.day) || String(x.createdAt || '').localeCompare(String(y.createdAt || '')));
    const sim = {
      paid: !!cur.paid,
      paidDay: cur.paid ? i.paidDay : null,
      review: !!cur.review,
      reviewDay: i.reviewDay != null ? i.reviewDay : null,
      rejected: cur.rejected || null,
      blocked: !!cur.blocked,
      blockedSince: i.blockedSince != null ? i.blockedSince : null,
      today: i.today,
      due: i.due,
      blockDay: i.blockDay,
      base: cur.base,
      comp: cur.comp,
      adminStatus: cur.adminStatus,
      aux,
      adm: [],
      daysToDue: cur.daysToDue,
      daysToBlock: cur.daysToBlock,
    };
    const cfg = {
      plazo: cur.dueDays,
      aviso: cur.noticeDays,
      gracia: cur.graceDays,
      monto: cur.amountDueCOP,
      montoNext: account.amountNextCOP || null,
    };
    const dates = {
      periodStart, periodEnd: cur.periodEnd, nextCut: cur.nextCut,
      due: cur.dueDate, notice: cur.noticeDate, lastGrace: cur.lastGraceDate, block: cur.blockDate,
      paid: cur.paidOn, review: cur.reviewOn, today: cur.today,
      // cbFmt(d) del diseño = fecha del día d contado desde el corte.
      at: (d) => addDays(periodStart, d),
    };
    return { sim, cfg, dates, reference: account.reference, statementId: cur.id };
  }

  function addDays(iso, n) {
    const p = parts(iso); if (!p || n == null) return null;
    const t = new Date(Date.UTC(p.y, p.mo - 1, p.d + n));
    return t.toISOString().slice(0, 10);
  }

  // ¿Este error es la pausa por cobro? (lo lanza la base al insertar una reserva)
  function isPausedError(e) {
    if (!e) return false;
    if (e.code === PAUSE_CODE) return true;
    if (e.hint === 'billing_paused') return true;
    return typeof e.message === 'string' && e.message.indexOf('Tus reservas están pausadas por un cobro pendiente') === 0;
  }

  // ==========================================================================
  // Tripulante
  // ==========================================================================

  // Mi cuenta de cobro o null («Todavía no tienes mensualidad registrada»).
  // Forma: ver aux_billing_my_account (0090). `current` es la cuenta de cobro
  // que manda: la más vieja sin pagar o, si todo está al día, la última.
  async function myAccount() {
    const data = await rpc('aux_billing_my_account');
    _last = data || null;
    _lastAt = Date.now();
    return _last;
  }
  // Lo último que se leyó, sin ir a la red (null si no hay cuenta o no se ha leído).
  const last = () => _last;
  const lastAt = () => _lastAt;
  // ¿Tiene mensualidad? (para «Incluido en tu mensualidad»). Sin leer aún → false.
  const hasAccount = () => !!_last;

  async function history() {
    const data = await rpc('aux_billing_history');
    return Array.isArray(data) ? data : [];
  }

  // Métodos de pago de mi organización (solo los activos; RLS).
  async function methods() {
    const { data, error } = await client().from('billing_payment_methods')
      .select('id, kind, label, account_type, account_number, holder_name, holder_nit, position')
      .eq('active', true)
      .order('position', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw error;
    return (data || []).map(m => ({
      id: m.id, kind: m.kind, label: m.label, accountType: m.account_type || null,
      number: m.account_number, holderName: m.holder_name || null, holderNit: m.holder_nit || null,
    }));
  }

  const alertRow = a => ({
    id: a.id, statementId: a.statement_id, proofId: a.proof_id || null, key: a.key,
    day: a.day, dayIndex: a.day_index, title: a.title, body: a.body, tone: a.tone,
    payload: a.payload || {}, pushed: !!a.pushed, createdAt: a.created_at,
    action: ACTION_KEYS.indexOf(a.key) >= 0,
  });

  // Mis avisos de cobro (el «Centro»), el más nuevo primero.
  async function alerts(opts) {
    const lim = (opts && opts.limit) || 60;
    const { data, error } = await client().from('billing_alerts')
      .select('id, statement_id, proof_id, key, day, day_index, title, body, tone, payload, pushed, created_at')
      .eq('audience', 'aux')
      .order('created_at', { ascending: false })
      .limit(lim);
    if (error) throw error;
    return (data || []).map(alertRow);
  }

  async function markAlertsSeen() { await rpc('aux_billing_mark_seen'); if (_last) _last.unread = 0; }

  // Preferencias de Cb2Me. Los avisos de mora y de pausa siempre llegan (la base).
  async function setPrefs(p) {
    const r = await rpc('aux_billing_set_prefs', {
      p_push: p && p.push != null ? !!p.push : null,
      p_reminder: p && p.reminder != null ? !!p.reminder : null,
    });
    if (_last && r) _last.prefs = r;
    return r;
  }

  const EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'image/heic': 'heic', 'image/heif': 'heif', 'application/pdf': 'pdf' };
  const MAX_BYTES = 10 * 1024 * 1024;

  // Sube el comprobante y lo manda a revisión.
  //   file: File/Blob (de <input type=file accept="image/*,application/pdf" capture>)
  //   o: { statementId, viaLabel ('Bancolombia' | 'Nequi' | 'Otro banco' | …), methodId?, declaredAmountCOP? }
  // Devuelve { proofId, statement }. El archivo va a
  //   payment-proofs/{org}/{mi profile id}/{statementId}/{marca}.{ext}
  // OJO: si la subida sale bien y el registro falla, el archivo queda huérfano
  // en el bucket (el cliente no puede borrar ahí, a propósito); reintentar sube
  // otro archivo con otra marca.
  async function uploadProof(file, o) {
    o = o || {};
    if (!file) throw new Error('Falta la foto del comprobante');
    if (!o.statementId) throw new Error('Falta la cuenta de cobro');
    if (!o.viaLabel) throw new Error('Falta desde dónde pagaste');
    const type = String(file.type || '').toLowerCase();
    const ext = EXT[type] || (/\.([a-z0-9]{2,5})$/i.exec(file.name || '') || [])[1];
    if (!EXT[type] && !/^(jpe?g|png|webp|heic|heif|pdf)$/i.test(ext || '')) {
      throw new Error('El comprobante tiene que ser una foto (JPG, PNG) o un PDF');
    }
    if (file.size != null && file.size > MAX_BYTES) throw new Error('El archivo pesa más de 10 MB');
    const acc = _last && _last.organizationId ? _last : await myAccount();
    if (!acc) throw new Error('Todavía no tienes mensualidad registrada');
    const { data: s } = await client().auth.getSession();
    const uid = s && s.session && s.session.user && s.session.user.id;
    if (!uid) throw new Error('Tu sesión se cerró: vuelve a entrar');
    const stamp = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const path = [acc.organizationId, uid, o.statementId, stamp + '.' + String(ext || 'jpg').toLowerCase()].join('/');
    // Algunos teléfonos entregan el HEIC o el PDF sin tipo: se deduce de la extensión
    // (el bucket solo acepta imágenes y PDF).
    const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
      heic: 'image/heic', heif: 'image/heif', pdf: 'application/pdf' };
    const ctype = type || MIME[String(ext || '').toLowerCase()] || 'image/jpeg';
    const up = await client().storage.from(BUCKET)
      .upload(path, file, { contentType: ctype, upsert: false });
    if (up && up.error) throw up.error;
    const r = await rpc('aux_billing_submit_proof', {
      p_statement_id: o.statementId,
      p_storage_path: path,
      p_via_label: o.viaLabel,
      p_method_id: o.methodId || null,
      p_content_type: ctype,
      p_size_bytes: file.size != null ? Math.round(file.size) : null,
      p_declared_amount_cop: o.declaredAmountCOP != null ? Math.round(o.declaredAmountCOP) : null,
    });
    if (_last && r && r.statement && _last.current && _last.current.id === r.statement.id) {
      _last.current = r.statement;
    }
    return r;
  }

  // Enlace temporal para ver un comprobante (el tripulante el suyo, el jefe los de su org).
  async function proofUrl(path, seconds) {
    const { data, error } = await client().storage.from(BUCKET).createSignedUrl(path, seconds || 600);
    if (error) throw error;
    return data && data.signedUrl;
  }

  async function reasons() {
    try { const r = await rpc('billing_reject_reasons'); return Array.isArray(r) && r.length ? r : REASONS.slice(); }
    catch (_) { return REASONS.slice(); }
  }

  // ==========================================================================
  // Jefe
  // ==========================================================================
  let _org = null;
  async function myOrg() {
    if (_org) return _org;
    _org = await rpc('current_user_org');
    return _org;
  }

  // Todos los tripulantes de la org, con o sin cuenta. Primero los que tienen
  // comprobante por revisar, luego pausados, en mora, pendientes, al día y sin cuenta.
  async function adminList() { const d = await rpc('admin_billing_list'); return Array.isArray(d) ? d : []; }
  async function adminDetail(auxId) { return rpc('admin_billing_detail', { p_aux: auxId }); }

  // Guardado completo del formulario. Plazos null = los de la organización.
  // Cambiar monto o plazos NO toca cuentas de cobro ya abiertas (usar adminAdjust).
  async function adminSaveAccount(auxId, f) {
    f = f || {};
    const n = v => (v === '' || v == null ? null : Math.round(Number(v)));
    return rpc('admin_billing_save_account', {
      p_aux: auxId,
      p_amount_cop: n(f.amountCOP),
      p_cut_day: n(f.cutDay),
      p_due_days: n(f.dueDays),
      p_notice_days: n(f.noticeDays),
      p_grace_days: n(f.graceDays),
      p_active: f.active !== false,
      p_amount_next_cop: n(f.amountNextCOP),
      p_starts_on: f.startsOn || null,
    });
  }
  async function adminOpenStatement(auxId, periodStart) {
    return rpc('admin_billing_open_statement', { p_aux: auxId, p_period_start: periodStart || null });
  }
  // Corregir el monto o descontar (p. ej. el canje «3 días de mensualidad» de Puntos).
  async function adminAdjust(statementId, f) {
    f = f || {};
    return rpc('admin_billing_adjust_statement', {
      p_statement_id: statementId,
      p_amount_cop: f.amountCOP != null ? Math.round(f.amountCOP) : null,
      p_discount_cop: f.discountCOP != null ? Math.round(f.discountCOP) : null,
      p_discount_note: f.discountNote != null ? String(f.discountNote) : null,
    });
  }
  async function adminProofs(status) {
    const d = await rpc('admin_billing_proofs', { p_status: status === undefined ? 'review' : status });
    return Array.isArray(d) ? d : [];
  }
  async function adminApprove(proofId) {
    return rpc('admin_billing_review_proof', { p_proof_id: proofId, p_approve: true, p_reason: null });
  }
  // El motivo es obligatorio y tiene que ser uno de REASONS.
  async function adminReject(proofId, reason) {
    if (REASONS.indexOf(reason) < 0) throw new Error('Elige el motivo del rechazo');
    return rpc('admin_billing_review_proof', { p_proof_id: proofId, p_approve: false, p_reason: reason });
  }
  async function adminMarkPaid(statementId, f) {
    f = f || {};
    return rpc('admin_billing_mark_paid', {
      p_statement_id: statementId,
      p_via_label: f.viaLabel || null,
      p_amount_cop: f.amountCOP != null ? Math.round(f.amountCOP) : null,
      p_paid_on: f.paidOn || null,
      p_note: f.note || null,
    });
  }

  // Configuración de la organización (plazos por defecto, titular y NIT).
  async function adminSettings() {
    const { data, error } = await client().from('billing_settings')
      .select('organization_id, default_amount_cop, due_days, notice_days, grace_days, holder_name, holder_nit, updated_at')
      .maybeSingle();
    if (error) throw error;
    if (!data) return { exists: false, defaultAmountCOP: null, dueDays: 5, noticeDays: 2, graceDays: 3, holderName: null, holderNit: null };
    return {
      exists: true, defaultAmountCOP: data.default_amount_cop, dueDays: data.due_days, noticeDays: data.notice_days,
      graceDays: data.grace_days, holderName: data.holder_name, holderNit: data.holder_nit, updatedAt: data.updated_at,
    };
  }
  async function adminSaveSettings(f) {
    f = f || {};
    const org = await myOrg();
    const n = v => (v === '' || v == null ? null : Math.round(Number(v)));
    const row = {
      organization_id: org,
      default_amount_cop: n(f.defaultAmountCOP),
      due_days: n(f.dueDays) != null ? n(f.dueDays) : 5,
      notice_days: n(f.noticeDays) != null ? n(f.noticeDays) : 2,
      grace_days: n(f.graceDays) != null ? n(f.graceDays) : 3,
      holder_name: f.holderName || null,
      holder_nit: f.holderNit || null,
    };
    const { data, error } = await client().from('billing_settings')
      .upsert(row, { onConflict: 'organization_id' }).select().single();
    if (error) throw error;
    return data;
  }

  async function adminMethods() {
    const { data, error } = await client().from('billing_payment_methods')
      .select('id, kind, label, account_type, account_number, holder_name, holder_nit, position, active')
      .order('position', { ascending: true }).order('created_at', { ascending: true });
    if (error) throw error;
    return (data || []).map(m => ({
      id: m.id, kind: m.kind, label: m.label, accountType: m.account_type || null, number: m.account_number,
      holderName: m.holder_name || null, holderNit: m.holder_nit || null, position: m.position, active: m.active,
    }));
  }
  async function adminSaveMethod(m) {
    m = m || {};
    const row = {
      kind: m.kind || 'bank', label: m.label, account_type: m.accountType || null, account_number: m.number,
      holder_name: m.holderName || null, holder_nit: m.holderNit || null,
      position: m.position != null ? m.position : 0, active: m.active !== false,
    };
    let q;
    if (m.id) q = client().from('billing_payment_methods').update(row).eq('id', m.id);
    else q = client().from('billing_payment_methods').insert({ ...row, organization_id: await myOrg() });
    const { data, error } = await q.select().single();
    if (error) throw error;
    return data;
  }
  async function adminSetMethodActive(id, active) {
    const { error } = await client().from('billing_payment_methods').update({ active: !!active }).eq('id', id);
    if (error) throw error;
  }
  async function adminDeleteMethod(id) {
    const { error } = await client().from('billing_payment_methods').delete().eq('id', id);
    if (error) throw error;
  }

  // Avisos del jefe (Centro): comprobantes por revisar, mora y bloqueos.
  async function adminAlerts(opts) {
    const lim = (opts && opts.limit) || 60;
    const { data, error } = await client().from('billing_alerts')
      .select('id, auxiliar_profile_id, statement_id, proof_id, key, day, day_index, title, body, tone, payload, pushed, created_at')
      .eq('audience', 'admin')
      .order('created_at', { ascending: false })
      .limit(lim);
    if (error) throw error;
    return (data || []).map(a => ({ ...alertRow(a), auxiliarProfileId: a.auxiliar_profile_id }));
  }

  // ¿Cuándo corrió el reloj diario por última vez? null = nunca (decirlo, no esconderlo).
  async function adminLastRun() {
    const { data, error } = await client().from('billing_job_runs')
      .select('run_on, ran_at, opened, alerts, paused').order('run_on', { ascending: false }).limit(1);
    if (error) throw error;
    const r = data && data[0];
    return r ? { runOn: r.run_on, ranAt: r.ran_at, opened: r.opened, alerts: r.alerts, paused: r.paused } : null;
  }

  window.ApiCobro = {
    // constantes
    BUCKET, PAUSE_CODE, PAUSE_MESSAGE, REASONS, ACTION_KEYS,
    // formato (cbMoney / cbFmt / cbPl)
    money, fmtDay, fmtDayLong, monthName, monthLabel, pl, addDays,
    // estado
    statusOf, toSim, isPausedError,
    // tripulante
    myAccount, last, lastAt, hasAccount, history, methods, alerts, markAlertsSeen, setPrefs,
    uploadProof, proofUrl, reasons,
    // jefe
    adminList, adminDetail, adminSaveAccount, adminOpenStatement, adminAdjust,
    adminProofs, adminApprove, adminReject, adminMarkPaid,
    adminSettings, adminSaveSettings, adminMethods, adminSaveMethod, adminSetMethodActive, adminDeleteMethod,
    adminAlerts, adminLastRun,
  };
})();
