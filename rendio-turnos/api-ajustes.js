// api-ajustes.js — Ajuste manual de horas (0120, 25-oct-2026): lo que el
// Balance, la Revisión y «Mis horas» leen y escriben de shift_hour_adjustments.
// Cuelga de window.Api como api-jefe.js (va después de api.js en index.html).
//
// Contrato:
//   Api.listHourAdjustments(desdeYmd, hastaYmd)
//       → ajustes (VIGENTES Y ANULADOS) cuyo día de turno cae en [desde, hasta],
//         con la persona, quién lo hizo y quién lo anuló. RLS: p_sha_select_admin.
//         null = la base todavía no tiene 0120 (la función no existe para nadie);
//         cualquier otro fallo LANZA: un Balance sin los ajustes es una cifra
//         equivocada, y antes que una cifra equivocada, ninguna.
//   Api.listMyHourAdjustments(driverId, desdeYmd, hastaYmd)
//       → los VIGENTES del conductor (su «Mis horas»). RLS: p_sha_select_own.
//         null sin 0120; lanza en cualquier otro fallo.
//   Api.adjustShiftHours({ profileId, shiftId, workDate, startAt, endAt, note })
//       → { ok, id, replaced } — RPC adjust_shift_hours. shiftId null = turno
//         que no quedó en la app. Los errores llegan en español, sin el código.
//   Api.voidHourAdjustment(id, note) → { ok, id } — RPC void_shift_hour_adjustment.
(function () {
  'use strict';
  const sb = () => window.sb;

  const SEL = 'id, driver_id, shift_id, work_date, start_at, end_at, note, ' +
    'orig_start_at, orig_end_at, orig_kind, created_at, created_by, voided_at, voided_by, void_note, ' +
    'driver_profiles(profile_id, profiles(full_name, email)), ' +
    'creador:profiles!shift_hour_adjustments_created_by_fkey(full_name), ' +
    'anulador:profiles!shift_hour_adjustments_voided_by_fkey(full_name)';

  // PostgREST dice PGRST205 (o 42P01 desde Postgres) cuando la tabla no existe:
  // es el único caso en que «no hay ajustes» es verdad sin haberlos leído.
  const sinTabla = e => !!e && (e.code === 'PGRST205' || e.code === '42P01'
    || (/shift_hour_adjustments/.test(e.message || '') && /(could not find|does not exist)/i.test(e.message || '')));

  async function listHourAdjustments(desdeYmd, hastaYmd) {
    const { data, error } = await sb().from('shift_hour_adjustments').select(SEL)
      .gte('work_date', desdeYmd).lte('work_date', hastaYmd)
      .order('work_date', { ascending: true }).order('created_at', { ascending: true });
    if (error) { if (sinTabla(error)) return null; throw error; }
    return data || [];
  }

  async function listMyHourAdjustments(driverId, desdeYmd, hastaYmd) {
    if (!driverId) return [];
    const { data, error } = await sb().from('shift_hour_adjustments')
      .select('id, driver_id, shift_id, work_date, start_at, end_at, note, orig_kind, created_at, voided_at')
      .eq('driver_id', driverId).is('voided_at', null)
      .gte('work_date', desdeYmd).lte('work_date', hastaYmd);
    if (error) { if (sinTabla(error)) return null; throw error; }
    return data || [];
  }

  // «CRUCE: esas horas se cruzan con…» → «Esas horas se cruzan con…».
  function limpio(e) {
    const m = String((e && e.message) || e || 'No se pudo guardar.').replace(/^[A-Z_]+:\s*/, '');
    return new Error(m.charAt(0).toUpperCase() + m.slice(1));
  }

  async function adjustShiftHours({ profileId, shiftId, workDate, startAt, endAt, note }) {
    const { data, error } = await sb().rpc('adjust_shift_hours', {
      p_profile_id: profileId, p_shift_id: shiftId || null, p_work_date: workDate,
      p_start_at: startAt, p_end_at: endAt, p_note: note,
    });
    if (error) throw limpio(error);
    return data;
  }

  async function voidHourAdjustment(id, note) {
    const { data, error } = await sb().rpc('void_shift_hour_adjustment', { p_id: id, p_note: note });
    if (error) throw limpio(error);
    return data;
  }

  Object.assign(window.Api, { listHourAdjustments, listMyHourAdjustments, adjustShiftHours, voidHourAdjustment });
})();
