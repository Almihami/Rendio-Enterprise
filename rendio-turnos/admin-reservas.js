// admin-reservas.js — Admin: Reservas del día (tabla operativa de traslados).
// Módulo nuevo 2026-07-25. Cierra tres huecos del flujo de rutas:
//   1. El admin NO tenía dónde ver las reservas una por una (solo el tablero de
//      Asignación, que las agrupa en vueltas). El módulo estaba como "próximamente".
//   2. Nadie podía cancelar un traslado: si a un auxiliar le corrían el vuelo,
//      la reserva se quedaba viva y el carro iba igual. Ahora hay botón (RPC
//      admin_cancel_reservation de 0050, que además la saca de la ruta activa).
//   3. Las calificaciones se guardaban (0048) y NO las veía nadie. Aquí salen.
// Comparte scope global con los demás módulos; el orden de carga está en index.html.

  const rvState = { items: [], filter: 'all', day: 'all', dir: 'all', cancelId: null, loading: false, focusChatId: null };

  const RV_ST = {
    pending:  { cls: 'warn',  label: 'Sin rutear' },
    assigned: { cls: 'ok',    label: 'Con conductor' },
    onway:    { cls: 'ok',    label: 'En camino' },
    onboard:  { cls: 'ok',    label: 'A bordo' },
    done:     { cls: 'muted', label: 'Completado' },
    cancelled:{ cls: 'muted', label: 'Cancelado' },
    noshow:   { cls: 'bad',   label: 'No se presentó' },
  };

  const rvDateES = (iso) => {
    try { return new Date(iso).toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'America/Bogota' }); }
    catch (_) { return iso; }
  };
  const rvBogDay = (iso) => { try { return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }); } catch (_) { return ''; } };
  // «Mar 13 oct», como se escribe en español. Antes el CSS le ponía mayúscula a
  // CADA palabra (text-transform: capitalize) y salía «Mar, 13 De Oct.».
  // rvDateES se queda como estaba porque va DENTRO de una frase (el aviso de
  // cancelación: «Tu traslado del mar, 13 de oct. fue cancelado»).
  const rvDayShort = (iso) => {
    try {
      const d = new Date(iso);
      const part = (o) => d.toLocaleDateString('es-CO', Object.assign({ timeZone: 'America/Bogota' }, o)).replace(/\./g, '');
      const wd = part({ weekday: 'short' });
      return wd.charAt(0).toUpperCase() + wd.slice(1) + ' ' + part({ day: 'numeric' }) + ' ' + part({ month: 'short' });
    } catch (_) { return iso; }
  };
  // «lun 19» si la hora cae entre las 00:00 y el corte de la madrugada (0107).
  const rvMadrugada = (iso) => {
    try {
      const corte = (typeof rt !== 'undefined' && rt && rt.NIGHT_CUTOFF != null) ? rt.NIGHT_CUTOFF : 120;
      const [h, m] = new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).split(':').map(Number);
      if (!(h * 60 + m < corte)) return '';
      return rvDayShort(new Date(new Date(iso).getTime() - 86400000).toISOString()).split(' ').slice(0, 2).join(' ').toLowerCase();
    } catch (_) { return ''; }
  };
  // En el filtro, los días cercanos con nombre: es lo que el jefe busca primero.
  const rvDayChip = (ymd) => {
    const hoy = rvBogDay(new Date().toISOString());
    const mas = (n) => { const t = new Date(hoy + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
    if (ymd === hoy) return 'Hoy';
    if (ymd === mas(1)) return 'Mañana';
    if (ymd === mas(-1)) return 'Ayer';
    return rvDayShort(ymd + 'T12:00:00-05:00');
  };

  // ¿Se pidió con poca anticipación? Se calcula (created_at vs hora del vuelo)
  // contra el parámetro de Ajustes; no hace falta guardarlo en la BD.
  function rvIsLate(r) {
    const lead = (state.settings && state.settings.aux_min_lead_hours != null) ? state.settings.aux_min_lead_hours : 6;
    if (!lead || !r.createdAt) return false;
    return (new Date(r.when).getTime() - new Date(r.createdAt).getTime()) / 3600000 < lead;
  }
  // Solo se puede cancelar lo que aún no ha empezado.
  const rvCanCancel = (r) => ['pending', 'assigned', 'onway'].includes(r.status);

  async function renderReservas() {
    bindReservas();
    const list = $('#rv-list');
    if (list) list.innerHTML = '<p class="rv-msg">Cargando reservas…</p>';
    rvState.loading = true;
    let rows = null;
    try { rows = await Api.listReservationsAdmin(1, 7); }
    catch (e) { console.error(e); }
    rvState.loading = false;
    if (!rows) {
      if (list) list.innerHTML = '<p class="rv-msg bad">No se pudieron cargar las reservas. Revisa la conexión o los permisos.</p>';
      return;
    }
    rvState.items = rows;
    await rvLoadExtras(rows);
    await rvuLoadFlights(rows);
    renderReservasList();
    // Si llegamos desde un push (`#/reservas?chat=<id>`), se abre directo el hilo
    // que motivó el aviso. Se consume una sola vez: un refresco no lo reabre.
    if (rvState.focusChatId) {
      const rid = rvState.focusChatId;
      rvState.focusChatId = null;
      const r = rvState.items.find(x => x.id === rid);
      if (r) jcOpen(rid, r.name || 'Traslado', `${r.time} · ${r.address || 'sin dirección'}`.slice(0, 60));
      else toast('Ese traslado ya no está en la lista de la semana.');
    }
  }

  // Maletas y «Prefiero silencio» (reservations.bags / quiet_ride, 0086, rediseño
  // del auxiliar 27-sep-2026). listReservationsAdmin (api.js) no las trae, así
  // que se piden aparte, solo para los ids de la lista. Sin 0086 (o si la consulta
  // falla) quedan en null y la fila no muestra nada: no se inventa un «0 maletas».
  async function rvLoadExtras(rows) {
    (rows || []).forEach(r => { r.bags = null; r.quiet = null; });
    const ids = (rows || []).map(r => r.id).filter(Boolean);
    const cli = window.sb;
    if (!ids.length || !cli || typeof cli.from !== 'function') return;
    try {
      const { data, error } = await cli.from('reservations').select('id, bags, quiet_ride').in('id', ids);
      if (error || !Array.isArray(data)) return;
      const by = new Map(data.map(x => [x.id, x]));
      rows.forEach(r => {
        const x = by.get(r.id); if (!x) return;
        r.bags = (x.bags != null && Number.isFinite(Number(x.bags))) ? Number(x.bags) : null;
        r.quiet = x.quiet_ride === true;
      });
    } catch (_) { /* sin el dato, sin la etiqueta */ }
  }
  // Estado del vuelo (0099, vuelos-ui.js): una sola consulta para los días de la
  // lista. Con la integración apagada, sin la migración o si falla, la caché
  // queda vacía y cada fila muestra su vuelo como siempre («✈ AV9563»): nunca un
  // estado inventado.
  async function rvuLoadFlights(rows) {
    if (!window.RendioVuelos) return;
    const days = [...new Set((rows || []).filter(r => !r.groundOps && r.flight).map(r => rvBogDay(r.when)).filter(Boolean))];
    if (!days.length) return;
    try { await RendioVuelos.cargar(days); } catch (_) { /* sin estado, sin chip */ }
  }
  // El vuelo de la fila: el chip si hay estado, y si no el texto de siempre.
  function rvuFlightLabel(r) {
    if (r.groundOps || !r.flight) return '';
    const chip = window.RendioVuelos ? RendioVuelos.chip(RendioVuelos.para(r.flight, rvBogDay(r.when), r.type)) : '';
    return ' · ' + (chip || '✈ ' + escapeHtml(r.flight));
  }
  // «2 maletas», «1 maleta», «Sin maletas». null = el tripulante no lo dijo.
  const rvBagsLabel = (n) => n == null ? '' : n === 0 ? 'Sin maletas' : `${n} maleta${n === 1 ? '' : 's'}`;

  const RV_F = {
    all:       () => true,
    active:    (r) => !['cancelled', 'done', 'noshow'].includes(r.status),
    pending:   (r) => r.status === 'pending',
    cancelled: (r) => r.status === 'cancelled',
    rated:     (r) => r.rating > 0,
  };
  // Salidas y llegadas (25-oct-2026): los jefes se enredaban con las dos
  // mezcladas en la misma lista por hora. Arranca en «Todas».
  const RV_DIR = {
    all: () => true,
    sal: (r) => r.type !== 'lle',
    lle: (r) => r.type === 'lle',
  };
  const rvOfDay = (items) => rvState.day === 'all' ? items : items.filter(r => rvBogDay(r.when) === rvState.day);
  const rvOfDir = (items) => items.filter(RV_DIR[rvState.dir] || RV_DIR.all);

  function rvFiltered() {
    return rvOfDir(rvOfDay(rvState.items)).filter(RV_F[rvState.filter] || RV_F.all);
  }

  function renderReservasList() {
    const list = $('#rv-list'); if (!list) return;
    const items = rvFiltered();
    // Los números se cruzan: cada fila de filtros cuenta con lo elegido en las
    // OTRAS dos (salida/llegada, estado y día). Antes los del estado contaban
    // todos los días, y con un día puesto la lista y los números no cuadraban.
    const cuenta = (n) => `<span class="n${n ? '' : ' zero'}">${n}</span>`;
    const delEstado = rvOfDir(rvState.items).filter(RV_F[rvState.filter] || RV_F.all);
    const days = [...new Set(rvState.items.map(r => rvBogDay(r.when)))].sort();
    const dayBar = $('#rv-days');
    if (dayBar) {
      dayBar.innerHTML = [`<button class="rv-fbtn ${rvState.day === 'all' ? 'on' : ''}" data-rv-day="all">Todos los días ${cuenta(delEstado.length)}</button>`]
        .concat(days.map(d => `<button class="rv-fbtn ${rvState.day === d ? 'on' : ''}" data-rv-day="${d}" title="${escapeHtml(rvDateES(d + 'T12:00:00-05:00'))}">${escapeHtml(rvDayChip(d))} ${cuenta(delEstado.filter(r => rvBogDay(r.when) === d).length)}</button>`))
        .join('');
    }
    const delDia = rvOfDir(rvOfDay(rvState.items));
    const delDiaYEstado = rvOfDay(rvState.items).filter(RV_F[rvState.filter] || RV_F.all);
    $$('#rv-ui [data-rv-dir]').forEach(b => {
      b.classList.toggle('on', b.dataset.rvDir === rvState.dir);
      const n = b.querySelector('.n');
      if (n) { const c = delDiaYEstado.filter(RV_DIR[b.dataset.rvDir] || RV_DIR.all).length; n.textContent = c; n.classList.toggle('zero', !c); }
    });
    $$('#rv-ui [data-rv-f]').forEach(b => {
      b.classList.toggle('on', b.dataset.rvF === rvState.filter);
      const n = b.querySelector('.n');
      if (n) { const c = delDia.filter(RV_F[b.dataset.rvF] || RV_F.all).length; n.textContent = c; n.classList.toggle('zero', !c); }
    });
    if ($('#rv-count')) $('#rv-count').textContent = items.length;

    if (!items.length) {
      list.innerHTML = `<div class="rv-empty"><svg class="icon"><use href="#i-list"/></svg><h3>Sin reservas</h3><p>No hay traslados que cumplan este filtro.</p></div>`;
      return;
    }
    list.innerHTML = items.map(rvRow).join('');
  }

  function rvRow(r) {
    const st = RV_ST[r.status] || { cls: 'muted', label: r.status };
    // De reserva (0121): el hotel reemplaza a JMC en el trayecto.
    const RP = r.reservePlace && window.Api && Api.reservePlace ? Api.reservePlace(r.reservePlace) : null;
    const lugar = RP && RP.hotel ? RP.name : 'JMC';
    const dir = r.type === 'lle' ? lugar + ' → casa' : 'casa → ' + lugar;
    // Que se vea de un vistazo si es salida o llegada, también en «Todas»: los
    // mismos colores y flechas que Rutas y la app del conductor (naranja ↑ sale
    // de la casa, verde ↓ llega del aeropuerto).
    const dirTag = r.type === 'lle'
      ? '<em class="rv-dirtag lle"><svg class="icon"><use href="#i-down"/></svg>Llegada</em>'
      : '<em class="rv-dirtag sal"><svg class="icon"><use href="#i-up"/></svg>Salida</em>';
    const chips = [];
    if (RP) chips.push(`<span class="rv-tag" title="De reserva: sin vuelo">${escapeHtml(RP.hotel ? 'Reserva · ' + RP.short : 'Reserva · aeropuerto')}</span>`);
    // Trabajo en tierra (0092): operaciones del aeropuerto, sin vuelo. Se dice,
    // para que el hueco del vuelo no parezca un dato que falta.
    if (r.groundOps) chips.push('<span class="rv-tag" title="Operaciones del aeropuerto: sin vuelo">Tierra</span>');
    if (r.isPernocta) chips.push('<span class="rv-tag pern">🌙 Pernocta</span>');
    // «Tentativa» (is_firm = false) se quitó el 25-oct-2026 (0121): la pregunta
    // «¿Es una reserva en firme?» la leían como «¿Vas de reserva?» y quien iba en
    // vuelo la apagaba (16 de 55 en producción). Ya no se pregunta.
    if (rvIsLate(r)) chips.push('<span class="rv-tag late">⏱ Pedido tarde</span>');
    if (r.readyAt) chips.push('<span class="rv-tag ready">✓ Confirmó recogida</span>');
    if (r.bags != null) chips.push(`<span class="rv-tag bags">🧳 ${escapeHtml(rvBagsLabel(r.bags))}</span>`);
    if (r.quiet === true) chips.push('<span class="rv-tag quiet">Pidió silencio</span>');
    // Pasada la medianoche y antes del corte (0107): es del turno PM de la noche
    // anterior, aunque la fecha sea la del día siguiente (20-oct-2026).
    const mad = rvMadrugada(r.when);
    if (mad) chips.push(`<span class="rv-tag" title="Lo hace el turno PM de la noche anterior">☾ Madrugada · PM del ${escapeHtml(mad)}</span>`);
    if (r.rating) chips.push(`<span class="rv-tag star">★ ${r.rating}${(r.ratingTags || []).length ? ' · ' + escapeHtml(r.ratingTags.join(', ')) : ''}</span>`);
    const cancelling = rvState.cancelId === r.id;
    return `<div class="rv-row ${r.status === 'cancelled' ? 'off' : ''}" data-rv-row="${r.id}">
      <div class="rv-when">
        <b>${escapeHtml(r.time)}</b>
        <span>${escapeHtml(rvDayShort(r.when))}</span>
        ${dirTag}
      </div>
      <div class="rv-main">
        <div class="rv-top">
          <b>${escapeHtml(r.name)}</b>
          <span class="rv-st ${st.cls}">${st.label}</span>
        </div>
        <div class="rv-sub">${escapeHtml(dir)} · ${escapeHtml(r.address || 'sin dirección')}${rvuFlightLabel(r)}</div>
        ${chips.length ? `<div class="rv-tags">${chips.join('')}</div>` : ''}
        ${r.cancelledAt ? `<div class="rv-note">Cancelado${r.cancelReason ? ': ' + escapeHtml(r.cancelReason) : ''}</div>` : ''}
        ${cancelling ? `<div class="rv-cancel">
            <input class="set-input" id="rv-reason" type="text" placeholder="Motivo (opcional): vuelo cancelado, cambio de itinerario…" />
            <div class="rv-cancel-acts">
              <button class="set-btn ghost" data-rv-abort>No, dejarlo</button>
              <button class="set-btn danger" data-rv-do="${r.id}">Sí, cancelar traslado</button>
            </div>
          </div>` : ''}
      </div>
      <div class="rv-acts">
        ${r.phone ? `<a class="rv-ic" href="tel:${escapeHtml(r.phone.replace(/[^\d+]/g, ''))}" title="Llamar"><svg class="icon"><use href="#i-phone"/></svg></a>` : ''}
        ${r.status !== 'cancelled' ? `<button class="rv-ic" data-rv-chat="${r.id}" title="Escribirle"><svg class="icon"><use href="#i-chat"/></svg></button>` : ''}
        ${rvCanCancel(r) && !cancelling ? `<button class="set-btn ghost" data-rv-cancel="${r.id}">Cancelar</button>` : ''}
      </div>
    </div>`;
  }

  function bindReservas() {
    const root = $('#rv-ui');
    if (!root || root._rvBound) return;
    root._rvBound = true;
    root.addEventListener('click', async (e) => {
      if (e.target.closest('#rv-refresh')) { renderReservas(); return; }
      const f = e.target.closest('[data-rv-f]');
      if (f) { rvState.filter = f.dataset.rvF; rvState.cancelId = null; renderReservasList(); return; }
      const dr = e.target.closest('[data-rv-dir]');
      if (dr) { rvState.dir = dr.dataset.rvDir; rvState.cancelId = null; renderReservasList(); return; }
      const d = e.target.closest('[data-rv-day]');
      if (d) { rvState.day = d.dataset.rvDay; rvState.cancelId = null; renderReservasList(); return; }
      // Escribirle por el hilo del traslado (0067): le suena al tripulante y a
      // su conductor, y queda constancia. La hoja la maneja admin-chat.js.
      const ch = e.target.closest('[data-rv-chat]');
      if (ch) {
        const r = (rvState.items || []).find(x => x.id === ch.dataset.rvChat);
        jcOpen(ch.dataset.rvChat, (r && r.name) || 'Traslado',
          r ? `${r.time} · ${r.address || 'sin dirección'}`.slice(0, 60) : '');
        return;
      }
      const c = e.target.closest('[data-rv-cancel]');
      if (c) { rvState.cancelId = c.dataset.rvCancel; renderReservasList(); return; }
      if (e.target.closest('[data-rv-abort]')) { rvState.cancelId = null; renderReservasList(); return; }
      const go = e.target.closest('[data-rv-do]');
      if (go) { await rvDoCancel(go, go.dataset.rvDo); return; }
    });
  }

  // Cancela de verdad: RPC (saca la reserva de la ruta activa) + avisa por push
  // al auxiliar y, si ya había plan publicado, también a su conductor.
  async function rvDoCancel(btn, id) {
    const r = rvState.items.find(x => x.id === id); if (!r) return;
    const reason = ($('#rv-reason') && $('#rv-reason').value || '').trim();
    btn.disabled = true; btn.textContent = 'Cancelando…';
    try {
      const res = await Api.adminCancelReservation(id, reason);
      const who = (r.name || 'el auxiliar').split(' ')[0];
      // El del tripulante aterriza en ESE viaje (#/viaje?r=, rediseño del
      // auxiliar 27-sep-2026), donde ya se ve cancelado y con el motivo. El del
      // conductor sigue en '/': su app no tiene pantalla de viaje por id y lo que
      // le importa es la ruta del día, que es donde abre.
      const rvTripUrl = '/#/viaje?r=' + encodeURIComponent(id);
      if (r.profileId) {
        notify([r.profileId], 'Traslado cancelado',
          reason ? `Tu traslado del ${rvDateES(r.when)} fue cancelado: ${reason}` : `Tu traslado del ${rvDateES(r.when)} fue cancelado por coordinación.`, rvTripUrl);
      }
      if (res && res.driver_profile_id) {
        notify([res.driver_profile_id], 'Parada cancelada',
          `${who} ya no va en tu ruta. Coordinación canceló su traslado.`, '/');
      }
      r.status = 'cancelled'; r.cancelledAt = new Date().toISOString(); r.cancelReason = reason;
      rvState.cancelId = null;
      toast('Traslado cancelado y avisado.');
      renderReservasList();
    } catch (err) {
      console.error(err);
      btn.disabled = false; btn.textContent = 'Sí, cancelar traslado';
      alert('No se pudo cancelar: ' + ((err.message || '').includes('en curso')
        ? 'el viaje ya está en curso.' : (err.message || 'error')));
    }
  }
