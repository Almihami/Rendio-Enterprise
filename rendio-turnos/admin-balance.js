// admin-balance.js — Admin: balance de turnos (informe + Excel).
// Extraído de app.js (split mecánico 2026-07-10).
// Comparte scope global con los demás módulos; el orden de carga está en index.html.
//
// 2026-09-12 · MOTOR ÚNICO DE HORAS. El 10-sep se pagó la quincena 25-ago→9-sep y
// el mismo corte dio CUATRO cifras: 582,3 en pantalla, 582,3 en la Hoja 3, 582,4
// en la Hoja 1 y 607,7 sumando la columna "Horas" de la Hoja 2. Ninguna estaba
// "mal calculada": cada superficie redondeaba en un punto distinto de la cadena
// (por persona, por celda día+jornada, por turno) y la Hoja 2 mezclaba horas
// pagables con horas que NO se pagan en una sola columna, sin fila de total que
// lo desmintiera. De acá en adelante todo se acumula en MINUTOS ENTEROS y se
// redondea UNA sola vez, al pintar. window.BalanceCore es la única fuente de
// verdad del cálculo y admin-revision.js consume exactamente estas funciones:
// si dos pantallas muestran la misma cifra es porque llamaron a la misma
// función, no porque casualmente coincidan.
  // ====================================================================
  // Balance de turnos (informe para los jefes)
  // ====================================================================

  // ── Fechas en hora Bogotá (UTC-5, sin horario de verano) ───────────────────
  // Prefijo bal*/BAL_ a propósito: este archivo NO va dentro de un IIFE, así que
  // lo que se declara acá arriba vive en el scope global que comparten todos los
  // módulos. Los nombres genéricos (MON, p2, ymd) se quedan locales dentro de
  // las funciones en el resto del repo justamente por eso.
  const BAL_MON = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const BAL_WD = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  const balP2 = n => String(n).padStart(2, '0');
  // Desplaza el instante 5 h para poder leer sus campos UTC como si fueran hora
  // de Bogotá. El Date que devuelve NO es el instante real: sirve para leer y
  // formatear, nunca para volver a guardar.
  const balBog = x => new Date(new Date(x).getTime() - 5 * 3600000);
  const balYmdUTC = d => `${d.getUTCFullYear()}-${balP2(d.getUTCMonth() + 1)}-${balP2(d.getUTCDate())}`;
  // Fecha calendario normalizando desbordes: mes 13 → enero del año siguiente,
  // día 0 → último día del mes anterior. Así los cortes no necesitan casos aparte.
  const balFecha = (y, m, d) => balYmdUTC(new Date(Date.UTC(y, m - 1, d)));
  const balHoyISO = () => balYmdUTC(balBog(Date.now()));
  const balDiaMes = s => { const [, m, d] = s.split('-').map(Number); return `${d} ${BAL_MON[m - 1]}`; };
  const balDayLabel = key => { const [y, m, d] = key.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1, d)); return `${BAL_WD[dt.getUTCDay()]} ${d}-${BAL_MON[m - 1]}`; };
  const balFmtDT = s => { if (!s) return '—'; const b = balBog(s); return `${balP2(b.getUTCDate())}-${BAL_MON[b.getUTCMonth()]} ${balP2(b.getUTCHours())}:${balP2(b.getUTCMinutes())}`; };
  // 'YYYY-MM-DD' → día siguiente en 'YYYY-MM-DD' (para incluir el día "Hasta" completo).
  function dayAfterISO(ymd) {
    const [y, m, d] = ymd.split('-').map(Number);
    return balFecha(y, m, d + 1);
  }

  // ── Cortes de nómina FIJOS: 25→9 y 10→24 ──────────────────────────────────
  // Decisión del dueño, no se negocia con el calendario ni con el mes corrido:
  // el corte 10→24 se paga el 25 de ese mismo mes y el corte 25→9 se paga el 10
  // del mes en que cierra. Antes el informe arrancaba en "del 1 al hoy", que no
  // es un corte de esta nómina y obligaba a teclear las fechas a mano cada
  // quincena; teclearlas mal es otra forma de que la cifra cambie.
  function corteDe(fechaISOoDate) {
    const base = typeof fechaISOoDate === 'string'
      ? fechaISOoDate.slice(0, 10)
      : balYmdUTC(balBog(fechaISOoDate instanceof Date ? fechaISOoDate.getTime() : Date.now()));
    const [y, m, d] = base.split('-').map(Number);
    let from, to, pagaEl;
    if (d >= 25) { from = balFecha(y, m, 25); to = balFecha(y, m + 1, 9); pagaEl = balFecha(y, m + 1, 10); }
    else if (d <= 9) { from = balFecha(y, m - 1, 25); to = balFecha(y, m, 9); pagaEl = balFecha(y, m, 10); }
    else { from = balFecha(y, m, 10); to = balFecha(y, m, 24); pagaEl = balFecha(y, m, 25); }
    return { from, to, label: `${balDiaMes(from)} – ${balDiaMes(to)}`, pagaEl };
  }
  function corteEnCurso() { return corteDe(balHoyISO()); }
  function corteAnterior() {
    const [y, m, d] = corteEnCurso().from.split('-').map(Number);
    return corteDe(balFecha(y, m, d - 1)); // el día anterior al inicio del corte en curso
  }
  // ¿Lo que hay en los campos Desde/Hasta ES un corte, o es un rango libre? Solo
  // si coincide exacto se puede rotular con el corte y su fecha de pago.
  function corteDelRango(fromV, toV) {
    const c = corteDe(fromV);
    return (c.from === fromV && c.to === toV) ? c : null;
  }

  // ── Balance por HORAS REALES trabajadas ────────────────────────────────────
  // La nómina se paga por lo trabajado, no por lo planeado. Este informe lee los
  // turnos reales (tabla shifts: inicio→cierre) en vez del horario publicado ×12.
  //
  // Clasificación de cada turno por sus propias columnas (sin joins extra):
  //   • ok    (completo)     → tiene km de apertura y de cierre: el conductor lo
  //                            abrió y lo cerró. Horas pagables = cierre − inicio.
  //   • auto  (auto-cerrado) → apertura sí, km de cierre NO, pero tiene end_at: lo
  //                            cerró el sistema porque el conductor no cerró.
  //                            OJO: acá decía que sus horas "quedan topeadas" y es
  //                            FALSO. auto_close_stale_shifts (cron cada hora, con
  //                            app_settings.auto_close_hours = 23) y force_close_shift
  //                            ponen end_at = now(), o sea el instante del cron o del
  //                            clic del admin. Ese instante no tiene nada que ver con
  //                            la hora en que el conductor dejó de trabajar: puede
  //                            quedar corto o largo. Por eso NO se paga y va aparte.
  //   • falso (arranque)     → sin km de apertura: reserva/inspección que nunca
  //                            avanzó ("RESERVA EXPIRADA"). No hubo trabajo → 0 h.
  //   • curso (en curso)     → sin end_at: turno aún abierto → no cuenta aún. Es la
  //                            razón por la que un mismo corte cambia de cifra según
  //                            la hora a la que se genere: mientras haya turnos en
  //                            curso el informe va rotulado PROVISIONAL.
  function clasificar(turno) {
    if (!turno || turno.opening_km == null) return 'falso';
    if (!turno.end_at) return 'curso';
    if (turno.closing_km == null) return 'auto';
    return 'ok';
  }
  // Duración de un turno en MINUTOS ENTEROS. Es la única medida que se acumula:
  // sumar horas con decimal (o peor, horas ya redondeadas) fue lo que produjo las
  // cuatro cifras del 10-sep. El Math.max(0, …) es cinturón contra un end_at
  // anterior al start_at por edición manual: hoy eso no existe, pero si existiera
  // no puede ponerse a restarle horas a los demás turnos del mismo conductor.
  function minutosDe(turno) {
    if (!turno || !turno.start_at || !turno.end_at) return 0;
    return Math.max(0, Math.round((new Date(turno.end_at).getTime() - new Date(turno.start_at).getTime()) / 60000));
  }
  function minutosPagables(turnos) {
    return (turnos || []).reduce((a, s) => a + (clasificar(s) === 'ok' ? minutosDe(s) : 0), 0);
  }
  // Minutos → horas con 1 decimal. ESTE es el único redondeo de toda la cadena y
  // solo se llama al pintar (pantalla o celda de Excel). Va en enteros (minutos
  // entre 6 = décimas de hora) para no arrastrar el error del flotante.
  function horas(minutos) { return Math.round((minutos || 0) / 6) / 10; }

  // Sello de generación en hora Bogotá: el informe vale para el instante en que
  // se generó, no para el instante en que alguien abre el Excel.
  function balSello(generadoEn) {
    const b = balBog(generadoEn || Date.now());
    return `Generado ${balP2(b.getUTCDate())}-${BAL_MON[b.getUTCMonth()]}-${b.getUTCFullYear()} ${balP2(b.getUTCHours())}:${balP2(b.getUTCMinutes())} (hora Bogotá)`;
  }
  // Línea que encabeza las TRES hojas y la pantalla: de qué corte se habla, en
  // qué instante se congeló y con qué regla se repartieron los turnos por día.
  function balEncabezado(bd) {
    const c = corteDelRango(bd.fromV, bd.toV);
    const rango = c
      ? `Corte ${c.label} (se paga el ${balDiaMes(c.pagaEl)})`
      : `Rango libre ${bd.fromV} a ${bd.toV}`;
    const prov = bd.provisional ? ' · PROVISIONAL: hay turnos aún abiertos, las horas pueden subir' : '';
    return `${rango} · ${balSello(bd.generadoEn)} · Un turno pertenece al día en que ARRANCÓ${prov}`;
  }

  // ── Pantalla ───────────────────────────────────────────────────────────────
  function renderBalance() {
    pintarBotonesDeCorte();
    const f = $('#balance-from'), t = $('#balance-to');
    if (f && !f.value) { const c = corteEnCurso(); f.value = c.from; t.value = c.to; }
    onGenerateBalance();
  }

  function aplicarCorte(c) {
    $('#balance-from').value = c.from;
    $('#balance-to').value = c.to;
    onGenerateBalance();
  }
  function balanceCorteEnCurso() { aplicarCorte(corteEnCurso()); }
  function balanceCorteAnterior() { aplicarCorte(corteAnterior()); }
  // core.js cablea #balance-month desde que el botón se llamaba "Mes actual".
  // El alias se queda para no romper ese enlace, pero ahora carga el CORTE EN
  // CURSO, que es lo que de verdad se paga.
  function balanceThisMonth() { balanceCorteEnCurso(); }

  // Los dos botones dicen qué corte cargan y cuándo se paga, para que nadie
  // tenga que acordarse de que el 10→24 se paga el 25. "Corte anterior" es botón
  // nuevo y se cablea acá (core.js solo conoce #balance-month), con guarda para
  // no montar el listener dos veces al volver a entrar a la pestaña.
  function pintarBotonesDeCorte() {
    const cur = corteEnCurso(), prev = corteAnterior();
    const bCur = $('#balance-month'), bPrev = $('#balance-cut-prev');
    if (bCur) {
      bCur.textContent = `Corte en curso · ${cur.label}`;
      bCur.title = `Del ${cur.from} al ${cur.to} · se paga el ${balDiaMes(cur.pagaEl)}`;
    }
    if (bPrev) {
      bPrev.textContent = `Corte anterior · ${prev.label}`;
      bPrev.title = `Del ${prev.from} al ${prev.to} · se paga el ${balDiaMes(prev.pagaEl)}`;
      if (!bPrev.dataset.wired) { bPrev.dataset.wired = '1'; bPrev.addEventListener('click', balanceCorteAnterior); }
    }
  }

  // Agrupa los turnos del rango por persona (profile_id) y acumula MINUTOS.
  // okH/autoH salen de horas() y existen solo para pintar: sumar esa lista de
  // decimales es exactamente el bug que se está matando, por eso los totales se
  // sacan siempre de okMin/autoMin.
  function aggregateRealHours(shifts) {
    const agg = {};
    shifts.forEach(s => {
      const dp = s.driver_profiles || {};
      const pid = dp.profile_id || `sinperfil:${s.driver_id}`;
      const name = (dp.profiles && dp.profiles.full_name) || '(desconocido)';
      const email = (dp.profiles && dp.profiles.email) || '';
      const a = agg[pid] || (agg[pid] = { id: pid, name, email, ok: 0, okMin: 0, auto: 0, autoMin: 0, falso: 0, curso: 0 });
      switch (clasificar(s)) {
        case 'ok':    a.ok++;    a.okMin += minutosDe(s); break;
        case 'auto':  a.auto++;  a.autoMin += minutosDe(s); break;
        case 'falso': a.falso++; break;
        default:      a.curso++;
      }
    });
    const adminIds = new Set((state.admins || []).map(a => a.id));
    const driverIds = new Set((state.drivers || []).map(d => d.id));
    const list = Object.values(agg).map(a => ({
      ...a, okH: horas(a.okMin), autoH: horas(a.autoMin),
      role: adminIds.has(a.id) ? 'Admin' : (driverIds.has(a.id) ? 'Conductor' : '—'),
    })).sort((x, y) => y.okMin - x.okMin || y.ok - x.ok || x.name.localeCompare(y.name));
    return {
      list,
      count: shifts.length,
      totalMin: list.reduce((t, a) => t + a.okMin, 0),
      totalAutoMin: list.reduce((t, a) => t + a.autoMin, 0),
    };
  }

  // Genera el informe y lo CONGELA. Un informe es la foto de un instante: se leen
  // los turnos Y el horario publicado en la misma pasada y los dos quedan dentro
  // de state.balanceData con su sello. Antes la Hoja 1 volvía a pedir
  // weekly_schedules en el momento de DESCARGAR, y como esa tabla es una fila
  // jsonb mutable sin historial, dos Excel del mismo informe bajados con minutos
  // de diferencia traían Hojas 1 distintas.
  async function onGenerateBalance() {
    const fromV = $('#balance-from').value, toV = $('#balance-to').value;
    const box = $('#balance-table'), sum = $('#balance-summary');
    // Sin rango no hay informe: se bota el que estuviera congelado. Si se dejara,
    // el botón de descargar seguiría entregando el Excel del rango ANTERIOR sin
    // que la pantalla lo muestre — otra vez dos cifras del mismo corte vivas al
    // tiempo, que es justo lo que este archivo existe para impedir.
    if (!fromV || !toV) { state.balanceData = null; sum.innerHTML = ''; box.innerHTML = '<div class="bal-empty"><h3>Elige el rango</h3><p>Selecciona Desde y Hasta para generar el informe.</p></div>'; return; }
    sum.innerHTML = ''; box.innerHTML = '<div class="bal-empty"><p>Calculando…</p></div>';
    let shifts, scheds = [], schedError = '';
    try {
      const semDesde = Scheduler.startOfWeekISO(fromV), semHasta = Scheduler.startOfWeekISO(toV);
      const [sh, sc] = await Promise.all([
        Api.listShiftsForBalance(`${fromV}T00:00:00-05:00`, `${dayAfterISO(toV)}T00:00:00-05:00`),
        // Si el horario falla no se cae el informe de horas (que es el que se
        // paga): se congela vacío y se avisa. Lo que no puede volver a pasar es
        // leerlo después, en otro instante.
        Api.listPublishedSchedules(semDesde, semHasta).catch(e => { schedError = (e && e.message) || 'la consulta del horario no respondió'; return []; }),
      ]);
      shifts = sh; scheds = sc;
    } catch (e) {
      // Si no se pudieron leer los turnos, tampoco queda informe descargable: la
      // foto vieja no corresponde a lo que el jefe está viendo en pantalla.
      state.balanceData = null;
      box.innerHTML = `<div class="bal-empty"><h3>No se pudo calcular</h3><p>${escapeHtml(e.message || 'La consulta de turnos no respondió. Reintenta.')}</p></div>`;
      return;
    }
    const agg = aggregateRealHours(shifts);
    const totCurso = agg.list.reduce((a, x) => a + x.curso, 0);
    state.balanceData = {
      ...agg, fromV, toV, shifts, scheds,
      generadoEn: new Date().toISOString(),
      provisional: totCurso > 0,
    };
    if (schedError) toast('El informe quedó congelado SIN horario publicado: ' + schedError);
    if (!agg.list.length) {
      box.innerHTML = '<div class="bal-empty"><h3>Sin datos</h3><p>No hay turnos en ese rango.</p></div>';
      return;
    }
    const bd = state.balanceData;
    const r = agg.list;
    const totOk = r.reduce((a, x) => a + x.ok, 0);
    const totOkH = horas(agg.totalMin);
    const totAuto = r.reduce((a, x) => a + x.auto, 0);
    const totAutoH = horas(agg.totalAutoMin);
    const totFalso = r.reduce((a, x) => a + x.falso, 0);
    const maxMin = Math.max(...r.map(x => x.okMin), 1);
    // El promedio también sale de minutos: promediar cifras ya redondeadas es la
    // misma trampa en pequeño.
    const avg = r.length ? horas(Math.round(agg.totalMin / r.length)) : 0;
    const corte = corteDelRango(fromV, toV);
    sum.innerHTML = `
      <div class="bal-scard accent"><div class="n">${totOkH}<s> h</s></div><div class="l">Horas reales trabajadas</div></div>
      <div class="bal-scard"><div class="n">${totOk}</div><div class="l">Turnos completos</div></div>
      <div class="bal-scard"><div class="n">${r.length}</div><div class="l">Personas</div></div>
      <div class="bal-scard"><div class="n">${avg}<s> h</s></div><div class="l">Promedio por persona</div></div>`;
    const warn = (txt, title) => `<span class="bal-pill z" title="${escapeHtml(title)}" style="background:#fde68a;color:#7c2d12">${txt}</span>`;
    const zero = '<span class="bal-pill z">0</span>';
    const aviso = bd.provisional
      ? `<div style="margin:10px 4px 0;padding:9px 12px;border-radius:8px;background:#fee2e2;color:#b91c1c;font-size:13px;font-weight:700;line-height:1.5">
           PROVISIONAL · ${totCurso} turno${totCurso === 1 ? '' : 's'} sigue${totCurso === 1 ? '' : 'n'} abierto${totCurso === 1 ? '' : 's'} dentro de este rango.
           Un turno sin cierre cuenta 0 h: si generas ahora y vuelves a generar mañana, la cifra sube. No pagues con esta foto.
         </div>`
      : '';
    box.innerHTML = `
      <div class="bal-report">
        <div class="bal-rhead"><svg class="icon"><use href="#i-doc"/></svg><h2>Horas reales por persona</h2><span class="period">${escapeHtml(corte ? `Corte ${corte.label} · se paga el ${balDiaMes(corte.pagaEl)}` : `${fromV} → ${toV} (rango libre)`)} · ${agg.count} turnos</span></div>
        <p style="margin:2px 4px 0;font-size:12px;color:var(--ink2)">${escapeHtml(balSello(bd.generadoEn))} · Un turno pertenece al día en que <b>ARRANCÓ</b>, aunque cierre al día siguiente.</p>
        ${aviso}
        <table class="bal-bt">
          <thead><tr><th>Persona</th><th class="num">Turnos</th><th class="num" style="width:230px">Horas reales</th><th class="num">Auto-cerrados</th><th class="num">Arranques falsos</th><th class="num">En curso</th></tr></thead>
          <tbody>${r.map(p => `<tr>
            <td><div class="person"><span class="bal-avt" style="background:${colorOfId(p.id)}">${escapeHtml(initialsOf(p.name))}</span><div><b>${escapeHtml(p.name)}</b><span>${escapeHtml(p.email || p.role)}</span></div></div></td>
            <td class="num"><b>${p.ok}</b></td>
            <td class="num"><div class="bal-hrs"><span class="bar"><i style="width:${Math.round(p.okMin / maxMin * 100)}%"></i></span><b>${p.okH} h</b></div></td>
            <td class="num">${p.auto ? warn(`${p.auto} · ${p.autoH}h`, 'Los cerró el sistema con la hora del cron o del clic, no el conductor — esas horas no son las trabajadas y NO se pagan') : zero}</td>
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
          <b>Horas reales</b> = suma de (cierre − inicio) de los turnos que el conductor abrió y cerró. Es lo único pagable.
          <b>Auto-cerrados</b>: los cerró el sistema (cron o admin) poniendo el cierre en ese instante; esas horas no son las trabajadas y no se pagan.
          <b>Arranques falsos</b>: reserva/inspección que no avanzó, no hubo trabajo. <b>En curso</b>: turnos aún abiertos, cuentan 0 h hasta que cierren.
        </p>
      </div>`;
  }

  // Descarga el balance DETALLADO en Excel (.xlsx), 3 hojas:
  //   1) "Publicado vs Trabajado": día por día (AM/PM) — publicados vs quienes de
  //      verdad trabajaron (+ horas), no-shows, quién trabajó sin estar publicado,
  //      fila de TOTAL y sección "Excluidos del cruce" (ninguna fila desaparece).
  //   2) "Detalle turnos reales": cada turno con horas PAGABLES y NO pagables en
  //      columnas separadas, motivo y fila de TOTAL.
  //   3) "Resumen por persona": totales (= tabla en pantalla, misma función).
  // Cruza el horario publicado que quedó CONGELADO al generar con los turnos reales.
  async function onDownloadBalanceXlsx() {
    const bd = state.balanceData;
    if (!bd || !bd.list.length) { toast('Genera primero un informe con datos.'); return; }
    if (!Array.isArray(bd.scheds) || !bd.generadoEn) {
      toast('Este informe se generó con la versión anterior y no trae el horario congelado. Vuelve a generarlo antes de descargarlo.');
      return;
    }
    if (typeof ExcelJS === 'undefined') { alert('No se pudo cargar la librería de Excel. Revisa tu conexión y reintenta.'); return; }
    const DAYS = (window.Scheduler && Scheduler.DAYS) || ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    const sello = balEncabezado(bd);

    // Horario publicado CONGELADO en el informe → publicados por fecha (AM/PM + líderes).
    const mergedNames = {}, pub = {};
    (bd.scheds || []).forEach(s => {
      const data = s.data || {};
      Object.assign(mergedNames, data._names || {});
      const [wy, wm, wd] = String(s.week_start_date).slice(0, 10).split('-').map(Number);
      const monday = Date.UTC(wy, wm - 1, wd);
      DAYS.forEach((dk, i) => {
        const day = data[dk]; if (!day) return;
        const key = balYmdUTC(new Date(monday + i * 86400000));
        const e = pub[key] || (pub[key] = { AM: [], PM: [], coordAM: new Set(), coordPM: new Set() });
        (day.morning || []).forEach(id => e.AM.push(id));
        (day.afternoon || []).forEach(id => e.PM.push(id));
        (day.coord_am || []).forEach(id => e.coordAM.add(id));
        (day.coord_pm || []).forEach(id => e.coordPM.add(id));
      });
    });
    const nameById = {};
    (state.drivers || []).forEach(d => { nameById[d.id] = d.name; });
    (state.admins || []).forEach(a => { if (!nameById[a.id]) nameById[a.id] = a.name; });
    const nameOf = id => nameById[id] || mergedNames[id] || '(elim.)';

    // Turnos reales → por fecha+jornada y detalle plano.
    // El día es SIEMPRE el día en que el turno ARRANCÓ. Acá vivía el error más
    // caro: a los turnos que arrancaban entre 00:00 y 02:00 se les restaba un día
    // (para pegarlos a la cola de la tarde anterior) y tres líneas más abajo el
    // filtro de rango los expulsaba del cruce por caer fuera del corte — pero sus
    // horas seguían dentro del total. La Hoja 1 sumaba menos que la Hoja 3 y la
    // fila desaparecía sin dejar rastro. Hoy la JORNADA sigue siendo PM (quien
    // arranca a la 1 a.m. viene de la tarde), pero el día no se mueve, y lo que
    // no cruza se lista abajo en "Excluidos del cruce" con su motivo.
    const real = {}, detail = [], excluidos = [];
    (bd.shifts || []).forEach(s => {
      const dp = s.driver_profiles || {};
      const pid = dp.profile_id;
      const nm = (dp.profiles && dp.profiles.full_name) || nameOf(pid);
      const b = balBog(s.start_at), H = b.getUTCHours();
      const key = balYmdUTC(b);
      const slot = (H >= 2 && H < 14) ? 'AM' : 'PM'; // 00:00–02:00 = cola de la tarde
      const tipo = clasificar(s), min = minutosDe(s);
      const fila = { key, slot, name: nm, tipo, min, start: s.start_at, end: s.end_at };
      detail.push(fila);
      const fuera = key < bd.fromV || key > bd.toV;
      if (fuera || tipo === 'falso') {
        excluidos.push({ ...fila, motivo: fuera ? 'Arrancó fuera del rango del informe' : 'Arranque falso: sin km de apertura, no hubo trabajo (0 h)' });
        return;
      }
      const e = real[key] || (real[key] = { AM: [], PM: [] });
      e[slot].push({ pid, name: nm, tipo, min });
    });

    const wb = new ExcelJS.Workbook();
    const border = { style: 'thin', color: { argb: 'FFDDDDDD' } };
    const AB = { top: border, bottom: border, left: border, right: border };
    const HEAD = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F1F1F' } };
    const H_AM = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEAF6' } };
    const H_PM = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFBE5D6' } };
    const TOT = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
    const headCell = (c, v) => { c.value = v; c.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = HEAD; c.alignment = { vertical: 'middle', wrapText: true }; c.border = AB; };
    // Título + sello, idénticos en las tres hojas: quien abra una hoja suelta
    // tiene que poder saber de qué corte es, cuándo se congeló y con qué regla.
    const titulo = (hoja, ultCol, texto) => {
      hoja.mergeCells(`A1:${ultCol}1`);
      const t1 = hoja.getCell('A1');
      t1.value = texto;
      t1.font = { name: 'Arial', size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
      t1.fill = HEAD; t1.alignment = { vertical: 'middle' }; hoja.getRow(1).height = 26;
      hoja.mergeCells(`A2:${ultCol}2`);
      const t2 = hoja.getCell('A2');
      t2.value = sello;
      t2.font = { name: 'Arial', size: 9, bold: !!bd.provisional, color: { argb: bd.provisional ? 'FFB91C1C' : 'FF555555' } };
      t2.alignment = { vertical: 'middle', wrapText: true }; hoja.getRow(2).height = 18;
    };

    // ---- Hoja 1: Publicado vs Trabajado ----
    const ws = wb.addWorksheet('Publicado vs Trabajado', { views: [{ showGridLines: false, state: 'frozen', ySplit: 3 }] });
    ws.columns = [{ width: 14 }, { width: 8 }, { width: 34 }, { width: 42 }, { width: 12 }, { width: 26 }, { width: 26 }];
    titulo(ws, 'G', 'Publicado vs Trabajado');
    ['Día', 'Jornada', 'Publicados (● = líder)', 'Trabajaron real (horas)', 'Horas verif.', 'No se presentó', 'Trabajó sin publicar']
      .forEach((h, i) => headCell(ws.getRow(3).getCell(i + 1), h));
    ws.getRow(3).height = 28;

    let row = 4, minHoja1 = 0;
    const [fy, fm, fd] = bd.fromV.split('-').map(Number), [ty, tm, td] = bd.toV.split('-').map(Number);
    for (let ms = Date.UTC(fy, fm - 1, fd); ms <= Date.UTC(ty, tm - 1, td); ms += 86400000) {
      const key = balYmdUTC(new Date(ms));
      const P = pub[key] || { AM: [], PM: [], coordAM: new Set(), coordPM: new Set() };
      const Rr = real[key] || { AM: [], PM: [] };
      ['AM', 'PM'].forEach(slot => {
        const coordSet = slot === 'AM' ? P.coordAM : P.coordPM;
        const pubIds = slot === 'AM' ? P.AM : P.PM;
        const pubNames = pubIds.map(id => (coordSet.has(id) ? '● ' : '') + nameOf(id));
        const realArr = Rr[slot];
        const realNames = realArr.map(x => `${x.name} — ${horas(x.min)}h${x.tipo === 'auto' ? ' (auto, NO pagable)' : ''}${x.tipo === 'curso' ? ' (en curso)' : ''}`);
        // Minutos primero, horas después: la celda redondea una vez y el TOTAL de
        // abajo no suma celdas redondeadas, suma los minutos del día.
        const jmin = realArr.reduce((a, x) => a + (x.tipo === 'ok' ? x.min : 0), 0);
        minHoja1 += jmin;
        const realPids = new Set(realArr.map(x => x.pid));
        const noShow = pubIds.filter(id => !realPids.has(id)).map(id => nameOf(id));
        const extra = realArr.filter(x => !pubIds.includes(x.pid)).map(x => x.name);
        const rr = ws.getRow(row);
        const vals = [balDayLabel(key), slot, pubNames.join('\n') || '—', realNames.join('\n') || '—', horas(jmin), noShow.join('\n') || '—', extra.join('\n') || '—'];
        vals.forEach((v, i) => { const c = rr.getCell(i + 1); c.value = v; c.font = { name: 'Arial', size: 10 }; c.alignment = { vertical: 'top', wrapText: true, horizontal: (i === 1 || i === 4) ? 'center' : 'left' }; c.border = AB; });
        rr.getCell(2).fill = slot === 'AM' ? H_AM : H_PM;
        if (slot === 'AM') rr.getCell(1).font = { name: 'Arial', size: 10, bold: true };
        rr.height = Math.max(18, Math.max(pubNames.length, realNames.length, noShow.length, extra.length, 1) * 14);
        row++;
      });
    }
    // TOTAL de la Hoja 1: sale de los minutos que se acumularon celda por celda.
    // Tiene que dar EXACTAMENTE lo mismo que la Hoja 3 y que la pantalla; si un
    // día no cuadra, es que alguien volvió a sumar celdas ya redondeadas.
    const t1r = ws.getRow(row++);
    [`TOTAL · ${bd.fromV} a ${bd.toV}`, '', '', (minHoja1 === bd.totalMin ? 'Horas verificadas del rango · cuadra con la Hoja 2 (pagables), la Hoja 3 y la pantalla' : `Horas verificadas del rango · ¡DESCUADRE! la Hoja 3 dice ${horas(bd.totalMin)} h — no pagues hasta revisarlo`), horas(minHoja1), '', '']
      .forEach((v, i) => { const c = t1r.getCell(i + 1); c.value = v; c.font = { name: 'Arial', size: 10, bold: true }; c.fill = TOT; c.alignment = { vertical: 'middle', horizontal: i === 4 ? 'center' : 'left' }; c.border = AB; });
    t1r.height = 20;

    // ---- Hoja 1, sección "Excluidos del cruce" ----
    // Todo turno que no entró a ninguna celda de arriba aparece acá con su
    // motivo. Es la garantía de que la Hoja 1 no esconde filas.
    row++;
    ws.mergeCells(`A${row}:G${row}`);
    const exTi = ws.getCell(`A${row}`);
    exTi.value = 'Excluidos del cruce — no entraron a ninguna celda de arriba. Ninguna fila desaparece en silencio.';
    exTi.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    exTi.fill = HEAD; exTi.alignment = { vertical: 'middle' };
    ws.getRow(row).height = 22; row++;
    ['Día', 'Jornada', 'Conductor', 'Inicio', 'Cierre', 'Horas (NO pagables)', 'Motivo']
      .forEach((h, i) => headCell(ws.getRow(row).getCell(i + 1), h));
    ws.getRow(row).height = 22; row++;
    if (!excluidos.length) {
      const rr = ws.getRow(row);
      const c = rr.getCell(1);
      c.value = 'Ninguno: todos los turnos del rango cruzaron contra el horario publicado.';
      c.font = { name: 'Arial', size: 10, italic: true }; c.border = AB;
      ws.mergeCells(`A${row}:G${row}`); row++;
    } else {
      excluidos.sort((a, b) => new Date(a.start) - new Date(b.start));
      excluidos.forEach(x => {
        const rr = ws.getRow(row++);
        const vals = [balDayLabel(x.key), x.slot, x.name, balFmtDT(x.start), balFmtDT(x.end), x.tipo === 'falso' ? 0 : horas(x.min), x.motivo];
        vals.forEach((v, i) => { const c = rr.getCell(i + 1); c.value = v; c.font = { name: 'Arial', size: 10 }; c.alignment = { vertical: 'middle', horizontal: (i === 1 || i === 5) ? 'center' : 'left' }; c.border = AB; });
        rr.getCell(7).font = { name: 'Arial', size: 10, color: { argb: 'FFB91C1C' } };
      });
    }

    // ---- Hoja 2: Detalle turnos reales ----
    // La columna "Horas" vieja mezclaba pagables con no pagables (los 'auto') con
    // el mismo formato y sin fila de total: sumarla daba 607,7 contra los 582,4
    // reales. Ahora son dos columnas distintas, con motivo, y el TOTAL cierra la
    // discusión: la de pagables es la que se paga y cuadra con las otras hojas.
    const MOTIVO = {
      auto: 'Auto-cerrado (lo cerró el sistema, no el conductor)',
      falso: 'Arranque falso (sin km de apertura)',
      curso: 'En curso (turno aún abierto)',
    };
    const ws2 = wb.addWorksheet('Detalle turnos reales', { views: [{ showGridLines: false, state: 'frozen', ySplit: 3 }] });
    ws2.columns = [{ width: 14 }, { width: 8 }, { width: 26 }, { width: 16 }, { width: 16 }, { width: 15 }, { width: 17 }, { width: 44 }];
    titulo(ws2, 'H', 'Detalle turnos reales');
    ['Día', 'Jornada', 'Conductor', 'Inicio', 'Cierre', 'Horas pagables', 'Horas NO pagables', 'Motivo']
      .forEach((h, i) => headCell(ws2.getRow(3).getCell(i + 1), h));
    ws2.getRow(3).height = 26;
    detail.sort((a, b) => new Date(a.start) - new Date(b.start));
    let r2 = 4, minPag = 0, minNoPag = 0;
    detail.forEach(d => {
      // Solo el 'auto' tiene horas que se pueden medir y no se pagan. El 'falso'
      // no trabajó y el 'curso' todavía no cerró: escribirles un tiempo sería
      // inventar un número que alguien va a terminar sumando.
      const pag = d.tipo === 'ok' ? d.min : 0;
      const noPag = d.tipo === 'auto' ? d.min : 0;
      minPag += pag; minNoPag += noPag;
      const rr = ws2.getRow(r2++);
      const vals = [balDayLabel(d.key), d.slot, d.name, balFmtDT(d.start), balFmtDT(d.end), horas(pag), horas(noPag), MOTIVO[d.tipo] || ''];
      vals.forEach((v, i) => { const c = rr.getCell(i + 1); c.value = v; c.font = { name: 'Arial', size: 10 }; c.alignment = { vertical: 'middle', horizontal: (i === 1 || i === 5 || i === 6) ? 'center' : 'left' }; c.border = AB; });
      if (d.tipo === 'falso' || d.tipo === 'curso') rr.getCell(8).font = { name: 'Arial', size: 10, color: { argb: 'FFB91C1C' } };
      if (d.tipo === 'auto') rr.getCell(8).font = { name: 'Arial', size: 10, color: { argb: 'FF92400E' } };
    });
    const t2r = ws2.getRow(r2);
    [`TOTAL · ${detail.length} turnos`, '', '', '', '', horas(minPag), horas(minNoPag), (minPag === bd.totalMin ? 'Solo "Horas pagables" se paga; las NO pagables son turnos auto-cerrados. Cuadra con la Hoja 1, la Hoja 3 y la pantalla.' : `Solo "Horas pagables" se paga. ¡DESCUADRE! la Hoja 3 dice ${horas(bd.totalMin)} h — no pagues hasta revisarlo.`)]
      .forEach((v, i) => { const c = t2r.getCell(i + 1); c.value = v; c.font = { name: 'Arial', size: 10, bold: true }; c.fill = TOT; c.alignment = { vertical: 'middle', horizontal: (i === 5 || i === 6) ? 'center' : 'left' }; c.border = AB; });
    t2r.height = 20;

    // ---- Hoja 3: Resumen por persona (= tabla en pantalla) ----
    const ws3 = wb.addWorksheet('Resumen por persona', { views: [{ showGridLines: false, state: 'frozen', ySplit: 3 }] });
    ws3.columns = [{ width: 26 }, { width: 12 }, { width: 12 }, { width: 13 }, { width: 17 }, { width: 12 }, { width: 9 }];
    titulo(ws3, 'G', 'Resumen por persona');
    ['Conductor', 'Turnos completos', 'Horas reales', 'Turnos auto-cerrados', 'Horas auto (NO pagables)', 'Arranques falsos', 'En curso']
      .forEach((h, i) => headCell(ws3.getRow(3).getCell(i + 1), h));
    ws3.getRow(3).height = 30;
    let r3 = 4;
    bd.list.forEach(p => {
      const rr = ws3.getRow(r3++);
      [p.name, p.ok, horas(p.okMin), p.auto, horas(p.autoMin), p.falso, p.curso]
        .forEach((v, i) => { const c = rr.getCell(i + 1); c.value = v; c.font = { name: 'Arial', size: 10 }; c.alignment = { vertical: 'middle', horizontal: i === 0 ? 'left' : 'center' }; c.border = AB; });
    });
    // Los totales salen de los MINUTOS acumulados, nunca de las celdas de arriba.
    const T = k => bd.list.reduce((a, x) => a + x[k], 0);
    const trr = ws3.getRow(r3);
    ['Total', T('ok'), horas(bd.totalMin), T('auto'), horas(bd.totalAutoMin), T('falso'), T('curso')]
      .forEach((v, i) => { const c = trr.getCell(i + 1); c.value = v; c.font = { name: 'Arial', size: 10, bold: true }; c.fill = TOT; c.alignment = { vertical: 'middle', horizontal: i === 0 ? 'left' : 'center' }; c.border = AB; });

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    // El PROVISIONAL va también en el nombre del archivo: un Excel viaja por
    // correo y por WhatsApp, y afuera de la app nadie ve la advertencia de arriba.
    a.download = `balance_detallado_${bd.fromV}_a_${bd.toV}${bd.provisional ? '_PROVISIONAL' : ''}.xlsx`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // El motor de cálculo, expuesto para que admin-revision.js (y lo que venga
  // después) no vuelva a escribir su propia versión de "cuántas horas son".
  window.BalanceCore = {
    clasificar,
    minutosDe,
    minutosPagables,
    horas,
    corteDe,
    corteEnCurso,
    corteAnterior,
  };


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

