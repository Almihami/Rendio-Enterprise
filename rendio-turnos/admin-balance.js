// admin-balance.js — Admin: balance de turnos (informe + CSV).
// Extraído de app.js (split mecánico 2026-07-10, sin cambios de lógica).
// Comparte scope global con los demás módulos; el orden de carga está en index.html.
  // ====================================================================
  // Balance de turnos (informe para los jefes)
  // ====================================================================

  function monthRangeDefault() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return {
      from: `${d.getFullYear()}-${p(d.getMonth() + 1)}-01`,
      to: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    };
  }

  function renderBalance() {
    const f = $('#balance-from'), t = $('#balance-to');
    if (f && !f.value) { const r = monthRangeDefault(); f.value = r.from; t.value = r.to; }
    onGenerateBalance();
  }

  function balanceThisMonth() {
    const r = monthRangeDefault();
    $('#balance-from').value = r.from;
    $('#balance-to').value = r.to;
    onGenerateBalance();
  }

  // ── Balance por HORAS REALES trabajadas ────────────────────────────────────
  // La nómina se paga por lo trabajado, no por lo planeado. Este informe lee los
  // turnos reales (tabla shifts: inicio→cierre) en vez del horario publicado ×12.
  //
  // Clasificación de cada turno por sus propias columnas (sin joins extra):
  //   • ok    (completo)     → tiene km de apertura y de cierre: el conductor lo
  //                            abrió y lo cerró. Horas pagables = cierre − inicio.
  //   • auto  (auto-cerrado) → apertura sí, km de cierre NO, pero tiene end_at: lo
  //                            cerró el sistema (cron/forzado) porque el conductor
  //                            no cerró. Sus horas quedan topeadas → se muestran
  //                            aparte para revisión, NO entran al pagable.
  //   • falso (arranque)     → sin km de apertura: reserva/inspección que nunca
  //                            avanzó ("RESERVA EXPIRADA"). No hubo trabajo → 0 h.
  //   • curso (en curso)     → sin end_at: turno aún abierto → no cuenta aún.
  function classifyShift(s) {
    if (s.opening_km == null) return 'falso';
    if (!s.end_at) return 'curso';
    if (s.closing_km == null) return 'auto';
    return 'ok';
  }
  function shiftHours(s) {
    if (!s.start_at || !s.end_at) return 0;
    return Math.max(0, (new Date(s.end_at).getTime() - new Date(s.start_at).getTime()) / 3600000);
  }
  // 'YYYY-MM-DD' → día siguiente en 'YYYY-MM-DD' (para incluir el día "Hasta" completo).
  function dayAfterISO(ymd) {
    const [y, m, d] = ymd.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d) + 86400000), p = n => String(n).padStart(2, '0');
    return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
  }

  // Agrupa los turnos del rango por persona (profile_id) y suma horas reales.
  function aggregateRealHours(shifts) {
    const agg = {};
    shifts.forEach(s => {
      const dp = s.driver_profiles || {};
      const pid = dp.profile_id || `sinperfil:${s.driver_id}`;
      const name = (dp.profiles && dp.profiles.full_name) || '(desconocido)';
      const email = (dp.profiles && dp.profiles.email) || '';
      const a = agg[pid] || (agg[pid] = { id: pid, name, email, ok: 0, okH: 0, auto: 0, autoH: 0, falso: 0, curso: 0 });
      switch (classifyShift(s)) {
        case 'ok':    a.ok++;    a.okH += shiftHours(s); break;
        case 'auto':  a.auto++;  a.autoH += shiftHours(s); break;
        case 'falso': a.falso++; break;
        default:      a.curso++;
      }
    });
    const adminIds = new Set((state.admins || []).map(a => a.id));
    const driverIds = new Set((state.drivers || []).map(d => d.id));
    const r1 = n => Math.round(n * 10) / 10;
    const list = Object.values(agg).map(a => ({
      ...a, okH: r1(a.okH), autoH: r1(a.autoH),
      role: adminIds.has(a.id) ? 'Admin' : (driverIds.has(a.id) ? 'Conductor' : '—'),
    })).sort((x, y) => y.okH - x.okH || y.ok - x.ok || x.name.localeCompare(y.name));
    return { list, count: shifts.length };
  }

  async function onGenerateBalance() {
    const fromV = $('#balance-from').value, toV = $('#balance-to').value;
    const box = $('#balance-table'), sum = $('#balance-summary');
    if (!fromV || !toV) { sum.innerHTML = ''; box.innerHTML = '<div class="bal-empty"><h3>Elige el rango</h3><p>Selecciona Desde y Hasta para generar el informe.</p></div>'; return; }
    sum.innerHTML = ''; box.innerHTML = '<div class="bal-empty"><p>Calculando…</p></div>';
    let shifts;
    try { shifts = await Api.listShiftsForBalance(`${fromV}T00:00:00-05:00`, `${dayAfterISO(toV)}T00:00:00-05:00`); }
    catch (e) { box.innerHTML = `<div class="bal-empty"><h3>Error</h3><p>${escapeHtml(e.message)}</p></div>`; return; }
    const agg = aggregateRealHours(shifts);
    state.balanceData = { ...agg, fromV, toV };
    if (!agg.list.length) {
      box.innerHTML = '<div class="bal-empty"><h3>Sin datos</h3><p>No hay turnos en ese rango.</p></div>';
      return;
    }
    const r = agg.list;
    const r1 = n => Math.round(n * 10) / 10;
    const totOk = r.reduce((a, x) => a + x.ok, 0);
    const totOkH = r1(r.reduce((a, x) => a + x.okH, 0));
    const totAuto = r.reduce((a, x) => a + x.auto, 0);
    const totAutoH = r1(r.reduce((a, x) => a + x.autoH, 0));
    const totFalso = r.reduce((a, x) => a + x.falso, 0);
    const totCurso = r.reduce((a, x) => a + x.curso, 0);
    const maxH = Math.max(...r.map(x => x.okH), 1);
    const avg = r.length ? Math.round(totOkH / r.length) : 0;
    sum.innerHTML = `
      <div class="bal-scard accent"><div class="n">${totOkH}<s> h</s></div><div class="l">Horas reales trabajadas</div></div>
      <div class="bal-scard"><div class="n">${totOk}</div><div class="l">Turnos completos</div></div>
      <div class="bal-scard"><div class="n">${r.length}</div><div class="l">Personas</div></div>
      <div class="bal-scard"><div class="n">${avg}<s> h</s></div><div class="l">Promedio por persona</div></div>`;
    const warn = (txt, title) => `<span class="bal-pill z" title="${escapeHtml(title)}" style="background:#fde68a;color:#7c2d12">${txt}</span>`;
    const zero = '<span class="bal-pill z">0</span>';
    box.innerHTML = `
      <div class="bal-report">
        <div class="bal-rhead"><svg class="icon"><use href="#i-doc"/></svg><h2>Horas reales por persona</h2><span class="period">${escapeHtml(fromV)} → ${escapeHtml(toV)} · ${agg.count} turnos · horas = inicio→cierre</span></div>
        <table class="bal-bt">
          <thead><tr><th>Persona</th><th class="num">Turnos</th><th class="num" style="width:230px">Horas reales</th><th class="num">Auto-cerrados</th><th class="num">Arranques falsos</th><th class="num">En curso</th></tr></thead>
          <tbody>${r.map(p => `<tr>
            <td><div class="person"><span class="bal-avt" style="background:${colorOfId(p.id)}">${escapeHtml(initialsOf(p.name))}</span><div><b>${escapeHtml(p.name)}</b><span>${escapeHtml(p.email || p.role)}</span></div></div></td>
            <td class="num"><b>${p.ok}</b></td>
            <td class="num"><div class="bal-hrs"><span class="bar"><i style="width:${Math.round(p.okH / maxH * 100)}%"></i></span><b>${p.okH} h</b></div></td>
            <td class="num">${p.auto ? warn(`${p.auto} · ${p.autoH}h`, 'Los cerró el sistema, no el conductor — horas sin verificar, revisar antes de pagar') : zero}</td>
            <td class="num">${p.falso ? warn(p.falso, 'Reserva/inspección sin avanzar — no hubo trabajo (0 h)') : zero}</td>
            <td class="num">${p.curso ? `<span class="bal-pill z" style="background:#dbeafe;color:#1e3a8a">${p.curso}</span>` : zero}</td>
          </tr>`).join('')}</tbody>
          <tfoot><tr>
            <td>Total · ${r.length} personas</td>
            <td class="num">${totOk}</td>
            <td class="num">${totOkH} h</td>
            <td class="num">${totAuto}${totAutoH ? ' · ' + totAutoH + 'h' : ''}</td>
            <td class="num">${totFalso}</td>
            <td class="num">${totCurso}</td>
          </tr></tfoot>
        </table>
        <p style="margin:12px 4px 0;font-size:12.5px;color:var(--ink2);line-height:1.55">
          <b>Horas reales</b> = suma de (cierre − inicio) de los turnos que el conductor abrió y cerró.
          <b>Auto-cerrados</b>: los cerró el sistema porque el conductor no cerró; sus horas están topeadas → revisar antes de pagar.
          <b>Arranques falsos</b>: reserva/inspección que no avanzó, no hubo trabajo. <b>En curso</b>: turnos aún abiertos.
        </p>
      </div>`;
  }

  function onDownloadBalanceCsv() {
    const bd = state.balanceData;
    if (!bd || !bd.list.length) { toast('Genera primero un informe con datos.'); return; }
    const esc = v => { v = String(v); return /[";\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const tot = k => bd.list.reduce((a, x) => a + x[k], 0);
    const r1 = n => Math.round(n * 10) / 10;
    const lines = [
      `Balance por horas reales trabajadas;${bd.fromV} a ${bd.toV};${bd.count} turnos en el rango`,
      ['Nombre', 'Email', 'Rol', 'Turnos completos', 'Horas reales', 'Turnos auto-cerrados', 'Horas auto-cerradas (sin verificar)', 'Arranques falsos', 'En curso'].join(';'),
      ...bd.list.map(r => [r.name, r.email, r.role, r.ok, r.okH, r.auto, r.autoH, r.falso, r.curso].map(esc).join(';')),
      ['Total', '', '', tot('ok'), r1(tot('okH')), tot('auto'), r1(tot('autoH')), tot('falso'), tot('curso')].map(esc).join(';'),
    ];
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `balance_horas_reales_${bd.fromV}_a_${bd.toV}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // Descarga el horario de la semana en Excel respetando el formato de
  // "TURNOS CONDUCTORES.xlsx": hoja única "TURNOS SEMANALES", título mergeado,
  // filas Mañana (2 cupos), Tarde (2 cupos), Coordinación AM/PM,
  // Suspensión temporal (suspendidos esa semana) y Descanso (todos los que
  // descansan ese día, una fila por persona).
  async function onDownloadScheduleXlsx() {
    if (!state.schedule) { toast('Genera o guarda el horario primero.'); return; }
    if (typeof ExcelJS === 'undefined') {
      alert('No se pudo cargar la librería de Excel. Revisa tu conexión y reintenta.');
      return;
    }
    const week = Scheduler.weekDates(state.currentWeek);
    const labelOf = id => {
      if (!id) return '';
      const w = state.drivers.find(d => d.id === id) || state.admins.find(a => a.id === id);
      return (w ? w.name : '').toUpperCase();
    };

    // Suspendidos esa semana = conductores con is_active=false (a futuro
    // podríamos cruzar con una columna de "suspendido por semana", pero hoy
    // is_active es global).
    let suspendedNames = [];
    try {
      const all = await Api.listAllDriversForAdmin();
      suspendedNames = all.filter(d => !d.active).map(d => d.name.toUpperCase());
    } catch (e) { /* si falla, fila queda vacía */ }

    // Por día, lista de conductores que descansan. Se obtiene del schedule.rest
    // de cada día (excluyendo admins).
    const driverIdSet = new Set(state.drivers.map(d => d.id));
    const restByDay = week.map(d => {
      const ids = state.schedule[d.key]?.rest || [];
      return ids.filter(id => driverIdSet.has(id)).map(labelOf);
    });
    const maxRest = Math.max(1, ...restByDay.map(r => r.length));

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('TURNOS SEMANALES', {
      views: [{ showGridLines: false }],
    });

    // Anchos de columna similares al formato original.
    ws.columns = [
      { width: 2.8 },   // A: margen
      { width: 29 },    // B: label
      { width: 4.2 },   // C: sub-label (AM/PM en coord)
      { width: 26 },    // D: LUN
      { width: 26 },    // E: MAR
      { width: 26 },    // F: MIÉ
      { width: 26 },    // G: JUE
      { width: 26 },    // H: VIE
      { width: 26 },    // I: SÁB
      { width: 26 },    // J: DOM
    ];

    // Helpers de estilo.
    const border = { style: 'thin', color: { argb: 'FFBFBFBF' } };
    const allBorders = { top: border, bottom: border, left: border, right: border };
    const titleFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F1F1F' } };
    const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4791F' } };
    const morningFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEAF6' } };
    const afternoonFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFBE5D6' } };
    const coordFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2EFDA' } };
    const suspFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE699' } };
    const restFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
    const centerWrap = { horizontal: 'center', vertical: 'middle', wrapText: true };

    // Título: HORARIO SEMANAL (B2:J2)
    ws.mergeCells('B2:J2');
    const t = ws.getCell('B2');
    t.value = 'HORARIO SEMANAL';
    t.font = { name: 'Arial', size: 18, bold: true, color: { argb: 'FFFFFFFF' } };
    t.fill = titleFill;
    t.alignment = centerWrap;
    ws.getRow(2).height = 32;

    // Encabezado: FRANJA DE SERVICIO + días (fila 4)
    ws.mergeCells('B4:C4');
    const head = ws.getCell('B4');
    head.value = 'FRANJA DE SERVICIO';
    head.font = { name: 'Arial', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
    head.fill = headerFill;
    head.alignment = centerWrap;
    head.border = allBorders;
    const dayCols = ['D', 'E', 'F', 'G', 'H', 'I', 'J'];
    week.forEach((d, i) => {
      const cell = ws.getCell(`${dayCols[i]}4`);
      cell.value = `${d.label} ${d.dayNum}`;
      cell.font = { name: 'Arial', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = headerFill;
      cell.alignment = centerWrap;
      cell.border = allBorders;
    });
    ws.getRow(4).height = 22;

    // Filas MAÑANA (cupos), TARDE (cupos)
    const morningSlots = state.settings.morning_slots;
    const afternoonSlots = state.settings.afternoon_slots;
    let row = 5;
    // MAÑANA
    const morningStart = row;
    for (let i = 0; i < morningSlots; i++, row++) {
      week.forEach((d, idx) => {
        const cell = ws.getCell(`${dayCols[idx]}${row}`);
        cell.value = labelOf(state.schedule[d.key]?.morning?.[i]);
        cell.font = { name: 'Arial', size: 11 };
        cell.fill = morningFill;
        cell.alignment = centerWrap;
        cell.border = allBorders;
      });
      ws.getRow(row).height = 26;
    }
    const morningEnd = row - 1;
    ws.mergeCells(`B${morningStart}:C${morningEnd}`);
    const mLabel = ws.getCell(`B${morningStart}`);
    mLabel.value = `MAÑANA (${state.settings.morning_label})`;
    mLabel.font = { name: 'Arial', size: 12, bold: true };
    mLabel.fill = morningFill;
    mLabel.alignment = centerWrap;
    mLabel.border = allBorders;

    // TARDE
    const afternoonStart = row;
    for (let i = 0; i < afternoonSlots; i++, row++) {
      week.forEach((d, idx) => {
        const cell = ws.getCell(`${dayCols[idx]}${row}`);
        cell.value = labelOf(state.schedule[d.key]?.afternoon?.[i]);
        cell.font = { name: 'Arial', size: 11 };
        cell.fill = afternoonFill;
        cell.alignment = centerWrap;
        cell.border = allBorders;
      });
      ws.getRow(row).height = 26;
    }
    const afternoonEnd = row - 1;
    ws.mergeCells(`B${afternoonStart}:C${afternoonEnd}`);
    const aLabel = ws.getCell(`B${afternoonStart}`);
    aLabel.value = `TARDE (${state.settings.afternoon_label})`;
    aLabel.font = { name: 'Arial', size: 12, bold: true };
    aLabel.fill = afternoonFill;
    aLabel.alignment = centerWrap;
    aLabel.border = allBorders;

    // COORDINACIÓN (AM + PM): 2 filas, label en B mergeado, subcat AM/PM en C
    const coordAmRow = row;
    const coordPmRow = row + 1;
    ws.mergeCells(`B${coordAmRow}:B${coordPmRow}`);
    const cLabel = ws.getCell(`B${coordAmRow}`);
    cLabel.value = 'COORDINACIÓN';
    cLabel.font = { name: 'Arial', size: 12, bold: true };
    cLabel.fill = coordFill;
    cLabel.alignment = centerWrap;
    cLabel.border = allBorders;
    ['AM', 'PM'].forEach((sub, idx) => {
      const r = coordAmRow + idx;
      const subCell = ws.getCell(`C${r}`);
      subCell.value = sub;
      subCell.font = { name: 'Arial', size: 11, bold: true };
      subCell.fill = coordFill;
      subCell.alignment = centerWrap;
      subCell.border = allBorders;
      const kind = idx === 0 ? 'coord_am' : 'coord_pm';
      week.forEach((d, di) => {
        const cell = ws.getCell(`${dayCols[di]}${r}`);
        cell.value = labelOf(state.schedule[d.key]?.[kind]?.[0]);
        cell.font = { name: 'Arial', size: 11 };
        cell.fill = coordFill;
        cell.alignment = centerWrap;
        cell.border = allBorders;
      });
      ws.getRow(r).height = 24;
    });
    row = coordPmRow + 1;

    // Fila vacía pequeña (separador, como en el original).
    ws.getRow(row).height = 6; row++;

    // SUSPENSIÓN TEMPORAL: una fila con los nombres separados por coma.
    const suspRow = row;
    ws.mergeCells(`B${suspRow}:C${suspRow}`);
    const sLabel = ws.getCell(`B${suspRow}`);
    sLabel.value = 'SUSPENSIÓN TEMPORAL';
    sLabel.font = { name: 'Arial', size: 12, bold: true };
    sLabel.fill = suspFill;
    sLabel.alignment = centerWrap;
    sLabel.border = allBorders;
    // Una sola celda mergeada para mostrar todos los nombres.
    ws.mergeCells(`D${suspRow}:J${suspRow}`);
    const sCell = ws.getCell(`D${suspRow}`);
    sCell.value = suspendedNames.length ? suspendedNames.join(', ') : '—';
    sCell.font = { name: 'Arial', size: 11 };
    sCell.fill = suspFill;
    sCell.alignment = centerWrap;
    sCell.border = allBorders;
    ws.getRow(suspRow).height = 28;
    row++;

    // Fila vacía pequeña (separador).
    ws.getRow(row).height = 6; row++;

    // DESCANSO: una fila por persona; label en B mergeado verticalmente.
    const restStart = row;
    for (let i = 0; i < maxRest; i++, row++) {
      week.forEach((d, idx) => {
        const cell = ws.getCell(`${dayCols[idx]}${row}`);
        cell.value = restByDay[idx][i] || '';
        cell.font = { name: 'Arial', size: 11 };
        cell.fill = restFill;
        cell.alignment = centerWrap;
        cell.border = allBorders;
      });
      ws.getRow(row).height = 22;
    }
    const restEnd = row - 1;
    ws.mergeCells(`B${restStart}:C${restEnd}`);
    const rLabel = ws.getCell(`B${restStart}`);
    rLabel.value = 'DESCANSO';
    rLabel.font = { name: 'Arial', size: 12, bold: true };
    rLabel.fill = restFill;
    rLabel.alignment = centerWrap;
    rLabel.border = allBorders;

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `horario_${state.currentWeek}.xlsx`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

