// admin-reservas.js — Admin: Reservas del día (tabla operativa de traslados).
// Módulo nuevo 2026-07-25. Cierra tres huecos del flujo de rutas:
//   1. El admin NO tenía dónde ver las reservas una por una (solo el tablero de
//      Asignación, que las agrupa en vueltas). El módulo estaba como "próximamente".
//   2. Nadie podía cancelar un traslado: si a un auxiliar le corrían el vuelo,
//      la reserva se quedaba viva y el carro iba igual. Ahora hay botón (RPC
//      admin_cancel_reservation de 0050, que además la saca de la ruta activa).
//   3. Las calificaciones se guardaban (0048) y NO las veía nadie. Aquí salen.
// Comparte scope global con los demás módulos; el orden de carga está en index.html.

  const rvState = { items: [], filter: 'all', day: 'all', cancelId: null, loading: false, focusChatId: null };

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

  function rvFiltered() {
    let items = rvState.items;
    if (rvState.day !== 'all') items = items.filter(r => rvBogDay(r.when) === rvState.day);
    if (rvState.filter === 'active') items = items.filter(r => !['cancelled', 'done', 'noshow'].includes(r.status));
    else if (rvState.filter === 'pending') items = items.filter(r => r.status === 'pending');
    else if (rvState.filter === 'cancelled') items = items.filter(r => r.status === 'cancelled');
    else if (rvState.filter === 'rated') items = items.filter(r => r.rating > 0);
    return items;
  }

  function renderReservasList() {
    const list = $('#rv-list'); if (!list) return;
    const items = rvFiltered();
    // Chips de día (los días que realmente tienen reservas).
    const days = [...new Set(rvState.items.map(r => rvBogDay(r.when)))].sort();
    const dayBar = $('#rv-days');
    if (dayBar) {
      dayBar.innerHTML = [`<button class="rv-chip ${rvState.day === 'all' ? 'on' : ''}" data-rv-day="all">Todos</button>`]
        .concat(days.map(d => `<button class="rv-chip ${rvState.day === d ? 'on' : ''}" data-rv-day="${d}">${rvDateES(d + 'T12:00:00')}</button>`))
        .join('');
    }
    const counts = {
      all: rvState.items.length,
      active: rvState.items.filter(r => !['cancelled', 'done', 'noshow'].includes(r.status)).length,
      pending: rvState.items.filter(r => r.status === 'pending').length,
      cancelled: rvState.items.filter(r => r.status === 'cancelled').length,
      rated: rvState.items.filter(r => r.rating > 0).length,
    };
    $$('#rv-ui [data-rv-f]').forEach(b => {
      b.classList.toggle('on', b.dataset.rvF === rvState.filter);
      const n = b.querySelector('i'); if (n) n.textContent = counts[b.dataset.rvF] != null ? counts[b.dataset.rvF] : '';
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
    const dir = r.type === 'lle' ? 'MDE → casa' : 'casa → MDE';
    const chips = [];
    if (r.isPernocta) chips.push('<span class="rv-tag pern">🌙 Pernocta</span>');
    if (r.isReserva === false) chips.push('<span class="rv-tag tent">Tentativa</span>');
    if (rvIsLate(r)) chips.push('<span class="rv-tag late">⏱ Pedido tarde</span>');
    if (r.readyAt) chips.push('<span class="rv-tag ready">✓ Confirmó recogida</span>');
    if (r.rating) chips.push(`<span class="rv-tag star">★ ${r.rating}${(r.ratingTags || []).length ? ' · ' + escapeHtml(r.ratingTags.join(', ')) : ''}</span>`);
    const cancelling = rvState.cancelId === r.id;
    return `<div class="rv-row ${r.status === 'cancelled' ? 'off' : ''}" data-rv-row="${r.id}">
      <div class="rv-when">
        <b>${escapeHtml(r.time)}</b>
        <span>${escapeHtml(rvDateES(r.when))}</span>
      </div>
      <div class="rv-main">
        <div class="rv-top">
          <b>${escapeHtml(r.name)}</b>
          <span class="rv-st ${st.cls}">${st.label}</span>
        </div>
        <div class="rv-sub">${escapeHtml(dir)} · ${escapeHtml(r.address || 'sin dirección')}${r.flight ? ' · ✈ ' + escapeHtml(r.flight) : ''}</div>
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
      if (r.profileId) {
        notify([r.profileId], 'Traslado cancelado',
          reason ? `Tu traslado del ${rvDateES(r.when)} fue cancelado: ${reason}` : `Tu traslado del ${rvDateES(r.when)} fue cancelado por coordinación.`, '/');
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
