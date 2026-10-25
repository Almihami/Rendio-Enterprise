// admin-ajuste-horas.js — Balance › «Ajustar horas» (0120, 25-oct-2026).
//
// Pedido de la profa: a los jefes les reportan eventualidades (el celular se
// apagó y el sistema cerró el turno, la app no dejó iniciar, cerró tarde) y
// tienen que poder corregir las horas a mano: el DÍA, DE QUÉ HORA A QUÉ HORA y
// una OBSERVACIÓN, para que quede el rastro.
//
// Este archivo pinta la ventana y la lista «Ajustes manuales» del Balance. NO
// suma horas: eso lo hace BalanceCore.conAjustes (admin-balance.js), que es la
// misma función que usan el Excel, la Revisión y «Mis horas» del conductor.
// Lo que se guarda va por Api.adjustShiftHours / Api.voidHourAdjustment
// (api-ajustes.js → RPC de 0120, que vuelve a validar todo en la base).
//
// Va dentro de una IIFE: solo salen a window ahAbrir, ahAnular, ahListaHtml y
// ahBotonOtraHtml, que es lo que llama admin-balance.js.
(function () {
  'use strict';

  const MON = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const WD = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
  const p2 = n => String(n).padStart(2, '0');
  // Bogotá es UTC-5 sin horario de verano: se corre el instante y se leen los
  // campos UTC (el mismo truco de admin-balance.js).
  const bog = x => new Date(new Date(x).getTime() - 5 * 3600000);
  const ymdDe = x => { const b = bog(x); return `${b.getUTCFullYear()}-${p2(b.getUTCMonth() + 1)}-${p2(b.getUTCDate())}`; };
  const hhmm = x => { const b = bog(x); return `${p2(b.getUTCHours())}:${p2(b.getUTCMinutes())}`; };
  const hoy = () => ymdDe(Date.now());
  const msDe = ymd => { const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const diaSig = ymd => { const d = new Date(msDe(ymd) + 86400000); return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`; };
  const diaTxt = ymd => { const d = new Date(msDe(ymd)); return `${WD[d.getUTCDay()]} ${d.getUTCDate()}-${MON[d.getUTCMonth()]}`; };
  const cuandoTxt = x => { if (!x) return ''; const b = bog(x); return `${b.getUTCDate()}-${MON[b.getUTCMonth()]} ${p2(b.getUTCHours())}:${p2(b.getUTCMinutes())}`; };
  // «05:00 → 17:30», o «14:00 → jue 16-oct 01:30» si cierra otro día.
  const tramo = (ini, fin) => {
    if (!ini) return '—';
    if (!fin) return `${hhmm(ini)} → sin cierre`;
    return `${hhmm(ini)} → ${ymdDe(fin) !== ymdDe(ini) ? diaTxt(ymdDe(fin)) + ' ' : ''}${hhmm(fin)}`;
  };
  const BC = () => window.BalanceCore || null;
  const minEntre = (ini, fin) => (ini && fin) ? Math.max(0, Math.round((new Date(fin) - new Date(ini)) / 60000)) : 0;
  const hmTxt = min => (BC() ? BC().hm(min) : `${min} min`);
  const nombreDe = a => (a && a.driver_profiles && a.driver_profiles.profiles && a.driver_profiles.profiles.full_name) || '(sin nombre)';
  const pidDe = x => (x && x.driver_profiles && x.driver_profiles.profile_id) || null;

  const CLASE = {
    ok: 'Completo',
    auto: 'Auto-cerrado: lo cerró el sistema, hoy no se paga',
    falso: 'Arranque falso: hoy cuenta 0 h',
    curso: 'Sigue abierto',
  };
  const QUE_CORRIGE = {
    ok: 'Corrige un turno completo',
    auto: 'Corrige un turno auto-cerrado (no se pagaba)',
    falso: 'Corrige un arranque falso (no se pagaba)',
    curso: 'Corrige un turno',
  };

  // Lo que se pagaba ANTES del ajuste: solo un turno completo pagaba.
  const minAntes = a => (a.shift_id && a.orig_kind === 'ok') ? minEntre(a.orig_start_at, a.orig_end_at) : 0;

  // ════════════════════════════════════════════════════════════════════
  // Lista «Ajustes manuales» (debajo de la tabla del Balance)
  // ════════════════════════════════════════════════════════════════════
  function ahBotonOtraHtml() {
    return '<button type="button" class="bal-adj" data-ah="otra">＋ Ajustar horas de alguien que no aparece</button>';
  }

  function ahFilaHtml(a) {
    const anulado = !!a.voided_at;
    const min = minEntre(a.start_at, a.end_at);
    const antes = minAntes(a);
    const origen = a.shift_id
      ? `${QUE_CORRIGE[a.orig_kind] || 'Corrige un turno'} · la app tenía ${escapeHtml(tramo(a.orig_start_at, a.orig_end_at))}${a.orig_kind === 'ok' ? ` (${escapeHtml(hmTxt(antes))})` : ''}`
      : 'Turno que no quedó registrado en la app · suma aparte';
    const dif = min - antes;
    const difTxt = `${dif >= 0 ? '+' : '−'}${hmTxt(Math.abs(dif))}`;
    return `<div class="bal-aj${anulado ? ' anulado' : ''}" data-ah-id="${escapeAttr(a.id)}">
      <div class="bal-aj-main">
        <div class="bal-aj-t"><b>${escapeHtml(nombreDe(a))}</b> · ${escapeHtml(diaTxt(a.work_date))}</div>
        <div class="bal-aj-h">${escapeHtml(tramo(a.start_at, a.end_at))} · ${escapeHtml(hmTxt(min))}${anulado ? '' : ` <span class="bal-aj-dif">${escapeHtml(difTxt)} a pagar</span>`}</div>
        <div class="bal-aj-o">${origen}</div>
        <div class="bal-aj-n">${escapeHtml(a.note || '')}</div>
        <div class="bal-aj-q">Por ${escapeHtml((a.creador && a.creador.full_name) || 'un jefe')} · ${escapeHtml(cuandoTxt(a.created_at))}</div>
        ${anulado ? `<div class="bal-aj-x">Anulado por ${escapeHtml((a.anulador && a.anulador.full_name) || 'un jefe')} · ${escapeHtml(cuandoTxt(a.voided_at))} · ${escapeHtml(a.void_note || '')}</div>` : ''}
      </div>
      ${anulado ? '' : `<button type="button" class="bal-adj" data-ah="anular" data-id="${escapeAttr(a.id)}">Anular</button>`}
    </div>`;
  }

  function ahListaHtml(bd) {
    const aj = ((bd && bd.ajustes) || []).slice()
      .sort((x, y) => String(x.work_date).localeCompare(String(y.work_date)) || new Date(x.created_at) - new Date(y.created_at));
    const vig = aj.filter(a => !a.voided_at).length, anu = aj.length - vig;
    return `<div class="bal-report bal-ajustes">
      <div class="bal-rhead"><svg class="icon"><use href="#i-doc"/></svg><h2>Ajustes manuales</h2><span class="period">${vig} vigente${vig === 1 ? '' : 's'}${anu ? ` · ${anu} anulado${anu === 1 ? '' : 's'}` : ''}</span></div>
      ${aj.length ? aj.map(ahFilaHtml).join('')
        : '<div class="bal-aj-vacio">Todavía no hay ajustes en este rango. Para corregir las horas de alguien, toca «Ajustar horas» en su fila.</div>'}
      <div class="bal-aj-pie">${ahBotonOtraHtml()}</div>
    </div>`;
  }

  // ════════════════════════════════════════════════════════════════════
  // La ventana «Ajustar horas»
  // ════════════════════════════════════════════════════════════════════
  // Conductores y jefes (los jefes también manejan), sin repetir, por nombre.
  function personas() {
    const out = new Map();
    (state.drivers || []).forEach(d => { if (d && d.id) out.set(d.id, d.name || ''); });
    (state.admins || []).forEach(a => { if (a && a.id && !out.has(a.id)) out.set(a.id, a.name || ''); });
    ((state.balanceData && state.balanceData.list) || []).forEach(p => {
      if (p && p.id && !String(p.id).startsWith('sinperfil:') && !out.has(p.id)) out.set(p.id, p.name || '');
    });
    return [...out].map(([id, name]) => ({ id, name })).sort((x, y) => x.name.localeCompare(y.name, 'es'));
  }

  // El día que se abre de entrada: el último turno auto-cerrado sin ajuste de
  // esa persona en el informe (es el caso de todos los días); si no hay, el
  // último día del informe, sin pasar de hoy.
  function diaSugerido(pid) {
    const bd = state.balanceData || {};
    const bc = BC();
    const ya = new Set((bd.ajustes || []).filter(a => !a.voided_at && a.shift_id).map(a => a.shift_id));
    const auto = (bd.shiftsCrudos || [])
      .filter(s => pidDe(s) === pid && !ya.has(s.id) && bc && bc.clasificar(s) === 'auto')
      .sort((x, y) => new Date(y.start_at) - new Date(x.start_at));
    if (auto.length) return ymdDe(auto[0].start_at);
    const h = hoy();
    return bd.toV && bd.toV < h ? bd.toV : h;
  }

  async function ahAbrir(opts) {
    opts = opts || {};
    if (typeof usrModal !== 'function' || !window.Api || typeof Api.adjustShiftHours !== 'function') {
      alert('No se pudo abrir el ajuste de horas. Recarga la página.');
      return;
    }
    const fija = !!opts.pid;
    const lista = fija ? [] : personas();
    const body = `
      ${fija ? '' : `<div class="set-field"><label>Persona</label><div class="set-selwrap"><select class="set-sel" data-f="pid">
          <option value="">— Elige la persona —</option>
          ${lista.map(p => `<option value="${escapeAttr(p.id)}">${escapeHtml(p.name)}</option>`).join('')}
        </select></div></div>`}
      <div class="set-field"${fija ? '' : ' style="margin-top:14px"'}><label>Día del turno</label>
        <input class="set-input mono" type="date" data-f="dia" max="${hoy()}">
      </div>
      <p class="set-hint">El día en que <b>arrancó</b> el turno, aunque haya cerrado pasada la medianoche.</p>
      <div class="set-field" style="margin-top:14px"><label>¿Qué turno corriges?</label>
        <div class="ah-opts" data-f="opts"><p class="set-hint">Elige ${fija ? 'el día' : 'la persona y el día'}.</p></div>
      </div>
      <div class="set-grid2 ah-horas" style="margin-top:14px">
        <div class="set-field"><label>Desde</label><input class="set-input mono" type="time" data-f="desde"></div>
        <div class="set-field"><label>Hasta</label><input class="set-input mono" type="time" data-f="hasta"></div>
      </div>
      <p class="ah-dur" data-f="dur"></p>
      <div class="set-field" style="margin-top:14px"><label>Observación</label>
        <textarea class="set-input ah-nota" data-f="nota" rows="3" maxlength="500" placeholder="Qué pasó y quién lo reportó. Ej.: se le apagó el celular a media jornada y el sistema cerró el turno; el jefe de turno confirma que cerró a las 5:40 p. m."></textarea>
      </div>
      <p class="set-hint">Queda guardada con tu nombre y la hora, y el conductor la ve en «Mis horas». No se borra: si te equivocas, se anula y queda el rastro.</p>`;
    const ov = usrModal('ah-modal', 'Ajustar horas', fija ? escapeHtml(opts.name || '') : 'Turno a corregir o que no quedó en la app', body,
      '<button class="wk-btn wk-coord-off" data-usr="cancel">Cancelar</button><button class="wk-btn wk-coord-on" data-usr="save">Guardar ajuste</button>');
    const $f = k => ov.querySelector(`[data-f="${k}"]`);
    const selPid = $f('pid'), inDia = $f('dia'), boxOpts = $f('opts'), inDesde = $f('desde'), inHasta = $f('hasta'), pDur = $f('dur'), inNota = $f('nota');
    const pidActual = () => (fija ? opts.pid : (selPid && selPid.value) || '');
    const nombreActual = () => (fija ? (opts.name || '') : ((lista.find(p => p.id === pidActual()) || {}).name || ''));

    let turnosDia = [], ajDia = [], elegido = null, seq = 0;

    function pintarDuracion() {
      const d = inDesde.value, h = inHasta.value;
      if (!d || !h) { pDur.textContent = ''; return; }
      if (d === h) { pDur.textContent = 'Desde y hasta son la misma hora.'; return; }
      const [h1, m1] = d.split(':').map(Number), [h2, m2] = h.split(':').map(Number);
      let min = (h2 * 60 + m2) - (h1 * 60 + m1);
      const otroDia = min <= 0;
      if (otroDia) min += 1440;
      pDur.textContent = `${hmTxt(min)}${otroDia && inDia.value ? ` · termina el ${diaTxt(diaSig(inDia.value))}` : ''}`;
    }

    function elegir(valor) {
      elegido = valor;
      boxOpts.querySelectorAll('.ah-opt').forEach(el => el.classList.toggle('on', el.dataset.v === valor));
      const r = boxOpts.querySelector(`input[value="${CSS.escape(valor)}"]`);
      if (r) r.checked = true;
      // Horas de entrada: las del ajuste vigente si ya lo tiene; las del turno si
      // está completo; si lo cerró el sistema, solo el inicio — ese cierre es la
      // hora del cron, no la de verdad, y no se puede dejar puesto de adivinanza.
      const t = turnosDia.find(x => x.id === valor);
      const a = t && ajDia.find(x => x.shift_id === t.id);
      const clase = t && BC() ? BC().clasificar(t) : null;
      if (a) { inDesde.value = hhmm(a.start_at); inHasta.value = hhmm(a.end_at); }
      else if (t && clase === 'ok') { inDesde.value = hhmm(t.start_at); inHasta.value = t.end_at ? hhmm(t.end_at) : ''; }
      else if (t) { inDesde.value = hhmm(t.start_at); inHasta.value = ''; }
      else { inDesde.value = ''; inHasta.value = ''; }
      pintarDuracion();
      usrShowErr(ov, '');
    }

    function opcionHtml(v, titulo, sub, apagada) {
      return `<label class="ah-opt${apagada ? ' off' : ''}" data-v="${escapeAttr(v)}">
        <input type="radio" name="ah-turno" value="${escapeAttr(v)}"${apagada ? ' disabled' : ''}>
        <span class="ah-opt-tx"><b>${titulo}</b><span>${sub}</span></span>
      </label>`;
    }

    async function cargarDia() {
      const pid = pidActual(), dia = inDia.value;
      turnosDia = []; ajDia = []; elegido = null;
      if (!pid || !dia) { boxOpts.innerHTML = `<p class="set-hint">Elige ${fija ? 'el día' : 'la persona y el día'}.</p>`; return; }
      const mio = ++seq;
      boxOpts.innerHTML = '<p class="set-hint">Buscando sus turnos de ese día…</p>';
      let sh, aj;
      try {
        [sh, aj] = await Promise.all([
          Api.listShiftsForBalance(`${dia}T00:00:00-05:00`, `${diaSig(dia)}T00:00:00-05:00`),
          Api.listHourAdjustments(dia, dia),
        ]);
      } catch (e) {
        if (mio !== seq) return;
        boxOpts.innerHTML = '<p class="set-hint" style="color:#b91c1c">No se pudieron leer los turnos de ese día. Cambia la fecha o vuelve a intentar.</p>';
        console.error(e);
        return;
      }
      if (mio !== seq) return; // cambiaron el día o la persona mientras tanto
      turnosDia = (sh || []).filter(s => pidDe(s) === pid);
      ajDia = (aj || []).filter(a => !a.voided_at && pidDe(a) === pid);
      const bc = BC();
      const opciones = turnosDia.map(t => {
        const clase = bc ? bc.clasificar(t) : 'ok';
        const a = ajDia.find(x => x.shift_id === t.id);
        let sub = escapeHtml(CLASE[clase] || '');
        if (clase === 'ok') sub += ` · ${escapeHtml(hmTxt(minEntre(t.start_at, t.end_at)))}`;
        if (a) sub += ` · <b>ya ajustado a ${escapeHtml(tramo(a.start_at, a.end_at))}</b>: si guardas, este ajuste reemplaza al anterior`;
        if (clase === 'curso') sub = 'Sigue abierto: ciérralo en Turnos activos y vuelve.';
        return opcionHtml(t.id, `Turno de ${escapeHtml(tramo(t.start_at, t.end_at))}`, sub, clase === 'curso');
      });
      const sueltos = ajDia.filter(a => !a.shift_id);
      opciones.push(opcionHtml('nuevo', 'Un turno que no quedó en la app',
        sueltos.length
          ? `Suma aparte. Ojo: ese día ya tiene ${sueltos.length === 1 ? 'uno agregado a mano' : sueltos.length + ' agregados a mano'} (${sueltos.map(a => escapeHtml(tramo(a.start_at, a.end_at))).join(', ')}).`
          : 'Suma aparte. Para cuando trabajó y la app no tiene ningún turno suyo ese día.', false));
      boxOpts.innerHTML = (turnosDia.length ? '' : '<p class="set-hint" style="margin:0 0 4px">No tiene turnos en la app ese día.</p>') + opciones.join('');
      boxOpts.querySelectorAll('input[name="ah-turno"]').forEach(r => r.addEventListener('change', () => elegir(r.value)));
      // Se marca de entrada el que más probablemente se viene a corregir.
      const sinAjuste = t => !ajDia.some(a => a.shift_id === t.id);
      const pref = turnosDia.find(t => bc && bc.clasificar(t) === 'auto' && sinAjuste(t))
        || turnosDia.find(t => bc && bc.clasificar(t) === 'falso' && sinAjuste(t))
        || turnosDia.find(t => bc && bc.clasificar(t) !== 'curso');
      elegir(pref ? pref.id : 'nuevo');
    }

    if (fija) { inDia.value = diaSugerido(opts.pid); cargarDia(); }
    selPid && selPid.addEventListener('change', () => { if (!inDia.value && selPid.value) inDia.value = diaSugerido(selPid.value); cargarDia(); });
    inDia.addEventListener('change', cargarDia);
    inDesde.addEventListener('input', pintarDuracion);
    inHasta.addEventListener('input', pintarDuracion);

    ov.querySelector('[data-usr="save"]').addEventListener('click', async ev => {
      const btn = ev.currentTarget;
      const pid = pidActual(), dia = inDia.value, desde = inDesde.value, hasta = inHasta.value;
      const nota = (inNota.value || '').trim();
      if (!pid) return usrShowErr(ov, 'Elige la persona.');
      if (!dia) return usrShowErr(ov, 'Elige el día del turno.');
      if (dia > hoy()) return usrShowErr(ov, 'Ese día todavía no ha pasado.');
      if (!elegido) return usrShowErr(ov, 'Elige qué turno corriges (o «Un turno que no quedó en la app»).');
      if (!desde || !hasta) return usrShowErr(ov, 'Escribe de qué hora a qué hora trabajó.');
      if (desde === hasta) return usrShowErr(ov, 'Desde y hasta no pueden ser la misma hora.');
      if (nota.length < 10) return usrShowErr(ov, 'Escribe la observación: qué pasó y quién lo reportó (mínimo 10 letras).');
      const startAt = `${dia}T${desde}:00-05:00`;
      const endAt = `${hasta <= desde ? diaSig(dia) : dia}T${hasta}:00-05:00`;
      if (new Date(endAt).getTime() > Date.now()) return usrShowErr(ov, 'Esa hora todavía no ha pasado: el ajuste se hace cuando el turno ya terminó.');
      const min = minEntre(startAt, endAt);
      btn.disabled = true; btn.textContent = 'Guardando…';
      try {
        await Api.adjustShiftHours({ profileId: pid, shiftId: elegido === 'nuevo' ? null : elegido, workDate: dia, startAt, endAt, note: nota });
      } catch (e) {
        btn.disabled = false; btn.textContent = 'Guardar ajuste';
        usrShowErr(ov, e.message || 'No se pudo guardar el ajuste.');
        return;
      }
      ov.remove();
      const bd = state.balanceData;
      const fuera = bd && (dia < bd.fromV || dia > bd.toV);
      const c = fuera && BC() ? BC().corteDe(dia) : null;
      toast(`Ajuste guardado: ${nombreActual()} · ${diaTxt(dia)} · ${hmTxt(min)}${c ? ` — queda en el corte ${c.label}` : ''}`);
      if (typeof onGenerateBalance === 'function') onGenerateBalance();
    });
  }

  // ════════════════════════════════════════════════════════════════════
  // Anular
  // ════════════════════════════════════════════════════════════════════
  function ahAnular(id) {
    const a = ((state.balanceData && state.balanceData.ajustes) || []).find(x => x.id === id);
    if (!a || typeof usrModal !== 'function') return;
    const body = `
      <p style="font-size:13.5px;color:var(--ink2);line-height:1.45">${escapeHtml(diaTxt(a.work_date))} · <b style="font-family:var(--mono)">${escapeHtml(tramo(a.start_at, a.end_at))}</b> · ${escapeHtml(hmTxt(minEntre(a.start_at, a.end_at)))}</p>
      <div class="usr-reason" style="white-space:pre-wrap">${escapeHtml(a.note || '')}</div>
      <p class="set-hint" style="margin-top:10px">${a.shift_id
        ? 'Al anularlo, el turno vuelve a contar como lo tiene la app.'
        : 'Al anularlo, esas horas dejan de sumar.'} El ajuste no se borra: queda en la lista como anulado, con tu nombre y el motivo.</p>
      <div class="set-field" style="margin-top:14px"><label>Motivo</label>
        <input class="set-input" data-f="motivo" type="text" maxlength="200" placeholder="Ej.: me equivoqué de día">
      </div>`;
    const ov = usrModal('ah-anular-modal', 'Anular ajuste', escapeHtml(nombreDe(a)), body,
      '<button class="wk-btn wk-coord-off" data-usr="cancel">Cancelar</button><button class="wk-btn wk-coord-on" data-usr="save">Anular</button>');
    ov.querySelector('[data-usr="save"]').addEventListener('click', async ev => {
      const btn = ev.currentTarget;
      const motivo = (ov.querySelector('[data-f="motivo"]').value || '').trim();
      if (motivo.length < 5) return usrShowErr(ov, 'Escribe por qué lo anulas.');
      btn.disabled = true; btn.textContent = 'Anulando…';
      try { await Api.voidHourAdjustment(id, motivo); }
      catch (e) { btn.disabled = false; btn.textContent = 'Anular'; usrShowErr(ov, e.message || 'No se pudo anular.'); return; }
      ov.remove();
      toast('Ajuste anulado.');
      if (typeof onGenerateBalance === 'function') onGenerateBalance();
    });
  }

  // Un solo escucha para los botones del Balance: la tabla se vuelve a pintar
  // con cada informe y los botones nacen y mueren con ella.
  document.addEventListener('click', ev => {
    const b = ev.target && ev.target.closest && ev.target.closest('#balance-table [data-ah]');
    if (!b) return;
    if (b.dataset.ah === 'ajustar') ahAbrir({ pid: b.dataset.pid, name: b.dataset.name });
    else if (b.dataset.ah === 'otra') ahAbrir({});
    else if (b.dataset.ah === 'anular') ahAnular(b.dataset.id);
  });

  Object.assign(window, { ahAbrir, ahAnular, ahListaHtml, ahBotonOtraHtml });
})();
