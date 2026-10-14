// driver-horas.js — Conductor: «Mis horas» en su perfil (pedido del jefe de
// operación, 11-oct-2026). Comparte el ámbito global: todo lleva prefijo dh.
//
// El conductor ve el corte EN CURSO y el ANTERIOR (cortes de pago fijos: del 25
// al 9 se paga el 10; del 10 al 24 se paga el 25) con EXACTAMENTE la cifra que se
// le va a pagar. Por eso este archivo no cuenta horas: los cortes salen de
// BalanceCore.corteEnCurso/corteAnterior, qué turno es de qué corte de
// BalanceCore.delCorte (un turno pertenece al día en que ARRANCÓ) y los minutos
// pagables de BalanceCore.minutosPagables — las mismas funciones del Balance y
// del Excel del jefe. Auto-cerrados (los cerró el sistema) y en curso suman 0,
// igual que allá, y aquí se dice cuáles son y por qué.
//
// Sin BalanceCore (admin-balance.js no cargó) o sin Api.listMyShiftsForHours
// (api-jefe.js), la tarjeta NO sale: antes que una cifra calculada por otra
// cabeza, ninguna.

  const DH_MON = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const dhP2 = n => String(n).padStart(2, '0');
  const dhBC = () => (window.BalanceCore && typeof BalanceCore.delCorte === 'function' ? BalanceCore : null);
  // Bogotá es UTC-5 y no tiene horario de verano: se corre el instante y se leen
  // los campos UTC (mismo truco que admin-balance.js).
  const dhBog = iso => new Date(new Date(iso).getTime() - 5 * 3600000);
  function dhDia(iso) { const b = dhBog(iso); return `${b.getUTCDate()} ${DH_MON[b.getUTCMonth()]}`; }
  function dhHora(iso) {
    const b = dhBog(iso);
    const h = b.getUTCHours();
    return `${h % 12 === 0 ? 12 : h % 12}:${dhP2(b.getUTCMinutes())} ${h < 12 ? 'a. m.' : 'p. m.'}`;
  }
  const dhFechaCorta = ymd => { const [, m, d] = String(ymd).split('-').map(Number); return `${d} ${DH_MON[m - 1]}`; };

  // Una línea por turno: «30 sep · 2:30 a. m. → 3:27 p. m. · 12 h 57 min · +297 km».
  // Si cierra otro día, el fin lleva su fecha («→ 1 oct 4:10 a. m.»).
  // Devuelve { texto, partes, cuenta, marca, clase }: `marca` es el porqué de los
  // que no cuentan, para pintarlo aparte en otro tono; `partes` es lo mismo que
  // texto antes de unirlo con « · » (dhPartesHtml no las deja partir en dos).
  function dhTurnoLinea(sh) {
    const BC = dhBC();
    const clase = BC ? BC.clasificar(sh) : 'ok';
    const partes = [];
    if (sh.start_at) partes.push(dhDia(sh.start_at));
    let tramo = sh.start_at ? dhHora(sh.start_at) : '';
    if (sh.end_at) {
      const otroDia = sh.start_at && dhDia(sh.end_at) !== dhDia(sh.start_at);
      tramo += ` → ${otroDia ? dhDia(sh.end_at) + ' ' : ''}${dhHora(sh.end_at)}`;
    } else tramo += ' → en curso';
    if (tramo) partes.push(tramo);
    let marca = null;
    if (clase === 'ok') {
      if (BC) partes.push(BC.hm(BC.minutosDe(sh)));
      if (sh.closing_km != null && sh.opening_km != null) {
        const km = Math.max(0, Number(sh.closing_km) - Number(sh.opening_km));
        partes.push(`+${km.toLocaleString('es-CO')} km`);
      }
    } else if (clase === 'auto') marca = 'No cuenta: lo cerró el sistema';
    else if (clase === 'curso') marca = 'Cuenta cuando lo cierres';
    else marca = 'No cuenta: el turno no arrancó';
    return { texto: partes.join(' · '), partes, cuenta: clase === 'ok', marca, clase };
  }

  // Lee los turnos de los dos cortes en UNA consulta (desde el inicio del
  // anterior hasta el fin del en curso) y los reparte con BalanceCore.delCorte.
  // null = no se puede decir (falta el motor o la API); lanza si la base falla.
  async function dhCargarHoras(driverId) {
    const BC = dhBC();
    if (!BC || !driverId || !window.Api || typeof Api.listMyShiftsForHours !== 'function') return null;
    const cur = BC.corteEnCurso(), prev = BC.corteAnterior();
    const lim = { desde: BC.limitesDe(prev.from, prev.to).desde, hasta: BC.limitesDe(cur.from, cur.to).hasta };
    const turnos = await Api.listMyShiftsForHours(driverId, lim.desde, lim.hasta);
    return { cur: BC.delCorte(turnos, cur), prev: BC.delCorte(turnos, prev) };
  }

  const dhTurnosTxt = n => `${n} turno${n === 1 ? '' : 's'}`;
  const dhCuentanTxt = n => `${dhTurnosTxt(n)} que ${n === 1 ? 'cuenta' : 'cuentan'}`;
  // Cada parte de la línea en una sola pieza: en un teléfono de 360 px «12 h 57
  // min» no puede quedar con el «min» solo en el renglón de abajo.
  function dhPartesHtml(partes) {
    return (partes || []).map(p => `<span style="white-space:nowrap">${escapeHtml(p)}</span>`).join(' · ');
  }
  // Lo que no cuenta, dicho en una línea (o nada).
  function dhAvisos(r) {
    const out = [];
    if (r.auto) out.push(`${dhTurnosTxt(r.auto)} no ${r.auto === 1 ? 'cuenta' : 'cuentan'}: ${r.auto === 1 ? 'lo' : 'los'} cerró el sistema`);
    if (r.curso) out.push(r.curso === 1 ? 'Tienes un turno abierto: cuenta cuando lo cierres' : `Tienes ${r.curso} turnos abiertos: cuentan cuando los cierres`);
    return out;
  }

  // Tarjeta del perfil. `h`: lo de dhCargarHoras, o { error: true }.
  function dhTarjetaHtml(h) {
    if (!h) return '';
    const BC = dhBC();
    if (h.error || !BC) {
      return `<div class="rc-sechd">Mis horas</div>
        <div class="rc-note warn rc-in d2"><span class="rc-note-ic">${avIcon('alert', 17)}</span>
          <span>No pudimos cargar tus horas ahora. Vuelve a abrir el perfil en un momento.</span></div>`;
    }
    const c = h.cur, p = h.prev;
    const avisos = dhAvisos(c);
    return `<div class="rc-sechd">Mis horas</div>
      <button id="pf-horas-btn" class="rc-card rc-in d2" type="button" data-dh="tarjeta">
        <span style="display:flex;align-items:center;justify-content:space-between;gap:10px">
          <span style="font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:var(--r-text-3)">Corte en curso · ${escapeHtml(c.corte.label)}</span>
          <span style="color:var(--r-text-3);display:flex">${avIcon('chevronRight', 16)}</span>
        </span>
        <span data-dh="cur" style="display:block;font-size:28px;font-weight:700;letter-spacing:-.6px;margin-top:6px;font-variant-numeric:tabular-nums">${escapeHtml(BC.hm(c.pagablesMin))}</span>
        <span style="display:block;font-size:12.5px;color:var(--r-text-2);margin-top:3px">Se paga el ${escapeHtml(dhFechaCorta(c.corte.pagaEl))} · ${dhCuentanTxt(c.ok)}</span>
        ${avisos.map(a => `<span data-dh="aviso" style="display:block;font-size:12.5px;color:var(--r-warn);font-weight:600;margin-top:4px">${escapeHtml(a)}</span>`).join('')}
        <span style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;border-top:1px solid var(--r-border);margin-top:12px;padding-top:11px">
          <span style="font-size:13px;color:var(--r-text-2)">Corte anterior · ${escapeHtml(p.corte.label)}<span style="display:block;font-size:11.5px;color:var(--r-text-3);margin-top:1px">Pago del ${escapeHtml(dhFechaCorta(p.corte.pagaEl))}</span></span>
          <b data-dh="prev" style="font-size:15px;font-weight:650;font-variant-numeric:tabular-nums;white-space:nowrap">${escapeHtml(BC.hm(p.pagablesMin))}</b>
        </span>
      </button>`;
  }

  // Una fila del historial (vista «Mis horas» y «Mi kilometraje»).
  function dhFilaHtml(sh, ultimo) {
    const l = dhTurnoLinea(sh);
    const v = sh.vehicles ? (sh.vehicles.internal_code || sh.vehicles.license_plate || '') : '';
    const tono = l.clase === 'auto' ? 'var(--r-warn)' : 'var(--r-text-3)';
    return `<div class="rc-listrow" data-dh="turno" data-clase="${l.clase}"${ultimo ? ' style="border-bottom:0"' : ''}>
      <span class="ic"${l.clase === 'auto' ? ` style="color:${tono}"` : ''}>${avIcon(l.cuenta ? 'clock' : 'alert', 18)}</span>
      <span style="flex:1;min-width:0">
        <span data-dh="linea" style="display:block;font-size:14px;font-weight:500;line-height:1.35${l.cuenta ? '' : ';color:var(--r-text-2)'}">${dhPartesHtml(l.partes)}</span>
        ${(l.marca || v) ? `<span style="display:block;font-size:12px;margin-top:2px;color:${tono}${l.marca ? ';font-weight:600' : ''}">${escapeHtml([l.marca, v].filter(Boolean).join(' · '))}</span>` : ''}
      </span>
    </div>`;
  }

  // Vista «Mis horas»: los dos cortes con cada turno. Los arranques falsos
  // (reserva o inspección que nunca abrió turno) no se listan: no fueron turnos.
  function dhVistaHtml(h) {
    const BC = dhBC();
    const back = '<button id="pf-back" class="flex items-center gap-1 text-sm font-bold text-slate-600 py-2 mb-1" type="button">‹ Volver al perfil</button>';
    if (!h || h.error || !BC) {
      return `${back}<h2 class="text-[22px] font-extrabold text-ink leading-tight mb-3">Mis horas</h2>
        <div class="rc-note warn"><span class="rc-note-ic">${avIcon('alert', 17)}</span><span>No pudimos cargar tus horas ahora. Vuelve a intentarlo en un momento.</span></div>`;
    }
    const bloque = (r, titulo, pago) => {
      const lista = r.turnos.filter(t => BC.clasificar(t) !== 'falso')
        .slice().sort((a, b) => new Date(b.start_at) - new Date(a.start_at));
      const avisos = dhAvisos(r);
      return `<div class="rc-sechd">${escapeHtml(titulo)} · ${escapeHtml(r.corte.label)}</div>
        <div class="rc-card" data-dh="corte">
          <span data-dh="total" style="display:block;font-size:26px;font-weight:700;letter-spacing:-.5px;font-variant-numeric:tabular-nums">${escapeHtml(BC.hm(r.pagablesMin))}</span>
          <span style="display:block;font-size:12.5px;color:var(--r-text-2);margin-top:3px">${escapeHtml(pago)} · ${dhCuentanTxt(r.ok)}</span>
          ${avisos.map(a => `<span style="display:block;font-size:12.5px;color:var(--r-warn);font-weight:600;margin-top:4px">${escapeHtml(a)}</span>`).join('')}
        </div>
        <div class="rc-card tight" style="margin-top:8px">
          ${lista.length ? lista.map((t, i) => dhFilaHtml(t, i === lista.length - 1)).join('')
            : '<div style="padding:14px 2px;font-size:13px;color:var(--r-text-3)">Sin turnos en este corte.</div>'}
        </div>`;
    };
    return `${back}
      <h2 class="text-[22px] font-extrabold text-ink leading-tight mb-3">Mis horas</h2>
      <div class="rc-note ok"><span class="rc-note-ic">${avIcon('clock', 17)}</span>
        <span>Se paga lo que trabajas: desde que <b>inicias</b> el turno hasta que lo <b>cierras</b> en la app. Cada turno cuenta en el día en que arrancó. Si no lo cierras, el sistema lo cierra solo y esas horas <b>no cuentan</b>.</span></div>
      ${bloque(h.cur, 'Corte en curso', `Se paga el ${dhFechaCorta(h.cur.corte.pagaEl)}`)}
      ${bloque(h.prev, 'Corte anterior', `Pago del ${dhFechaCorta(h.prev.corte.pagaEl)}`)}
      <div style="height:24px"></div>`;
  }
