// admin-flota.js — Turnos › Revisión › Flota: los carros. Alta, baja, edición,
// regreso a servicio y el registro del cambio de aceite.
// Salió de admin-personal.js (mudanza 2026-09-12, sin cambios de lógica): la pantalla
// se partió en tres en septiembre y el código se quedó en un solo archivo; los
// vehículos no tienen nada que ver con el personal más allá de haber nacido vecinos.
// Comparte scope global con los demás módulos; el orden de carga está en index.html.
//
// Dos vecinos que se quedaron donde estaban, a propósito:
//   · los helpers set* (admin-personal.js) — los usan los tres módulos de Ajustes.
//   · setOilBadge (admin-turnos-activos.js) — pinta el "!" de la pestaña, no la lista.
// Se siguen llamando igual desde acá: el scope es uno solo para todos estos archivos.
//
// Y uno que sí se vino aunque lo lea alguien de afuera: VEH_STATUS_ES. Lo consulta
// también admin-inspecciones.js, pero es el diccionario de estados de la FLOTA y su
// casa es esta; allá se lee dentro de una función, o sea a mano alzada en tiempo de
// ejecución, cuando este archivo ya se leyó hace rato.
  // Turnos › Revisión › Flota — los carros. Una sola consulta, la de la lista.
  function renderFlota() {
    renderVehiclesSettings();
  }

  // --- Vehículos (admin) — alta/baja/edición de la flota, en Turnos › Revisión › Flota ---
  const VEH_STATUS_ES = { available: 'Disponible', in_use: 'En uso', reserved: 'Reservado', maintenance: 'En revisión', blocked: 'Cambio de aceite' };
  let vehiclesEditId = null;       // si está editando un vehículo existente
  let vehiclesCache = [];          // para poblar el form al editar

  async function renderVehiclesSettings() {
    const box = $('#vehicles-list');
    if (!box) return;
    box.innerHTML = '<p class="set-hint">Cargando…</p>';
    let vehs = [];
    try { vehs = await Api.listVehiclesForShift(); }
    catch (e) { console.error(e); box.innerHTML = '<p class="set-hint">No se pudieron cargar los vehículos.</p>'; return; }
    vehiclesCache = vehs;
    setOilBadge(vehs);   // refresca el "!" de Ajustes con la lista ya cargada
    if (!vehs.length) { box.innerHTML = '<p class="set-hint">Aún no hay vehículos. Agrega el primero abajo.</p>'; return; }
    box.innerHTML = vehs.map(v => {
      const overridden = !!v.oil_override_at;               // conductor lo desbloqueó
      const oilPending = v.status === 'blocked' || overridden; // aceite vencido (con o sin override)
      // Botón "Cambio de aceite hecho": para carros bloqueados por aceite Y para
      // los que el conductor desbloqueó (siguen disponibles pero con aceite pendiente).
      const oilBtn = oilPending
        ? `<button class="set-btn dark" data-veh-oilchange="${v.id}" title="Registrar cambio de aceite">Cambio de aceite hecho</button>`
        : '';
      // 'maintenance' (NO APTO) se regresa a servicio por la vía normal.
      const restoreBtn = (v.status === 'maintenance')
        ? `<button class="set-btn dark" data-veh-restore="${v.id}" title="Regresar a servicio">Regresar a servicio</button>`
        : '';
      const oilAlert = oilPending
        ? `<span style="display:block;margin-top:3px;color:#dc2626;font-weight:800;font-size:11px">🛢️ Cambio de aceite pendiente${overridden ? ' · desbloqueado por conductor' : ''}</span>`
        : '';
      const intv = v.maintenance_interval_km ? ` · aceite c/${(v.maintenance_interval_km).toLocaleString('es-CO')} km` : '';
      return `<div class="veh-row" data-veh="${v.id}">
      <div class="veh-info"><b>${escapeHtml(v.internal_code || v.license_plate || 'Auto')}</b><span>${escapeHtml(v.license_plate || '')} · ${escapeHtml([v.brand, v.model].filter(Boolean).join(' ') || '—')} · ${v.capacity} pas · ${(v.current_km || 0).toLocaleString('es-CO')} km${intv}</span>${oilAlert}</div>
      <span class="veh-stat st-${v.status}">${VEH_STATUS_ES[v.status] || escapeHtml(v.status || '')}</span>
      ${oilBtn}${restoreBtn}
      <button class="set-btn ghost" data-veh-edit="${v.id}" title="Editar" style="height:34px">Editar</button>
      <button class="veh-del" data-veh-del="${v.id}" title="Eliminar vehículo"><svg class="icon" style="width:15px;height:15px"><use href="#i-trash"/></svg></button>
    </div>`;
    }).join('');
  }

  function onEditVehicle(id) {
    const v = vehiclesCache.find(x => x.id === id); if (!v) return;
    vehiclesEditId = id;
    const set = (f, val) => { const el = $('#new-veh-' + f); if (el) el.value = val != null ? val : ''; };
    set('code', v.internal_code); set('plate', v.license_plate); set('brand', v.brand); set('model', v.model);
    set('capacity', v.capacity || 4); set('km', v.current_km || 0);
    set('interval', v.maintenance_interval_km || 7000); set('lastmaint', v.last_maintenance_km != null ? v.last_maintenance_km : '');
    set('soat', v.soat_expires_at || ''); set('tecno', v.tecnomec_expires_at || '');
    const btn = $('#new-veh-create-btn'); if (btn) btn.innerHTML = '<svg class="icon"><use href="#i-check"/></svg>Guardar cambios';
    const st = $('#new-veh-state'); if (st) st.textContent = `Editando ${v.internal_code || v.license_plate || ''}…`;
    $('#new-veh-code')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function resetVehicleForm() {
    vehiclesEditId = null;
    ['code', 'plate', 'brand', 'model', 'soat', 'tecno', 'lastmaint'].forEach(f => { const el = $('#new-veh-' + f); if (el) el.value = ''; });
    if ($('#new-veh-capacity')) $('#new-veh-capacity').value = '4';
    if ($('#new-veh-km')) $('#new-veh-km').value = '0';
    if ($('#new-veh-interval')) $('#new-veh-interval').value = '7000';
    const btn = $('#new-veh-create-btn'); if (btn) btn.innerHTML = '<svg class="icon"><use href="#i-plus"/></svg>Agregar vehículo';
    const st = $('#new-veh-state'); if (st) st.textContent = '';
  }

  async function onCreateVehicle() {
    const code = ($('#new-veh-code') && $('#new-veh-code').value || '').trim();
    const plate = ($('#new-veh-plate') && $('#new-veh-plate').value || '').trim();
    if (!code || !plate) { toast('Código interno y placa son obligatorios.'); return; }
    const km = Math.max(0, parseInt($('#new-veh-km').value, 10) || 0);
    const interval = Math.max(500, parseInt($('#new-veh-interval') && $('#new-veh-interval').value, 10) || 7000);
    const lastRaw = ($('#new-veh-lastmaint') && $('#new-veh-lastmaint').value) || '';
    // Baseline de mantto: si lo dejan vacío, usa el km actual (evita bug 4).
    const lastMaint = (lastRaw !== '' && !isNaN(parseInt(lastRaw, 10))) ? Math.max(0, parseInt(lastRaw, 10)) : km;
    const veh = {
      organization_id: state.profile.organization_id,
      internal_code: code,
      license_plate: plate.toUpperCase(),
      brand: ($('#new-veh-brand').value || '').trim() || null,
      model: ($('#new-veh-model').value || '').trim() || null,
      capacity: Math.min(4, Math.max(1, parseInt($('#new-veh-capacity').value, 10) || 4)),
      current_km: km,
      last_maintenance_km: lastMaint,
      maintenance_interval_km: interval,
      soat_expires_at: $('#new-veh-soat').value || null,
      tecnomec_expires_at: $('#new-veh-tecno').value || null,
    };
    const btn = $('#new-veh-create-btn'); const st = $('#new-veh-state');
    const editing = !!vehiclesEditId;
    btn.disabled = true; if (st) st.textContent = editing ? 'Guardando…' : 'Creando…';
    try {
      if (editing) {
        const { organization_id, ...patch } = veh;   // no se cambia la organización
        await Api.updateVehicle(vehiclesEditId, patch);
        toast('Vehículo actualizado.');
      } else {
        await Api.createVehicle(veh);
        toast('Vehículo agregado.');
      }
      resetVehicleForm();
      renderVehiclesSettings();
    } catch (e) {
      console.error(e);
      if (st) st.textContent = '';
      const msg = /unique|duplicate/i.test(e.message || '') ? 'Ya existe un vehículo con ese código o placa.' : (e.message || 'error');
      alert((editing ? 'No se pudo actualizar: ' : 'No se pudo agregar: ') + msg);
    } finally { btn.disabled = false; }
  }

  async function onDeleteVehicle(id) {
    const v = (await safeVehicles()).find(x => x.id === id);
    if (v && v.status === 'in_use' && !confirm('Este vehículo está EN USO en un turno activo. ¿Eliminarlo igual? Mejor espera a que el turno cierre.')) return;
    if (!confirm('¿Eliminar este vehículo? Dejará de aparecer para los conductores. El historial de turnos e inspecciones se conserva.')) return;
    try { await Api.softDeleteVehicle(id); toast('Vehículo eliminado.'); renderVehiclesSettings(); }
    catch (e) { console.error(e); alert('No se pudo eliminar: ' + (e.message || 'error')); }
  }

  // 'maintenance' (p. ej. NO APTO): regresar a servicio sin tocar el contador.
  // El caso 'blocked'/override por aceite va por onRegisterOilChange (0041).
  async function onRestoreVehicle(id) {
    const v = (await safeVehicles()).find(x => x.id === id);
    const label = v ? (v.internal_code || v.license_plate || 'este vehículo') : 'este vehículo';
    if (!confirm(`¿Regresar ${label} a servicio? Quedará Disponible para los conductores.`)) return;
    try {
      await Api.returnVehicleToService(id, 'Regreso a servicio desde Flota');
      toast('Vehículo disponible.');
      renderVehiclesSettings();
    } catch (e) {
      console.error(e);
      const msg = /VEHICLE_HAS_ACTIVE_SHIFT/.test(e.message || '')
        ? 'Hay un turno en curso con ese vehículo. Ciérralo primero en Turnos activos.'
        : (e.message || 'error');
      alert('No se pudo regresar a servicio: ' + msg);
    }
  }
  // Admin registra el cambio de aceite (0041): reinicia el contador, limpia el
  // override del conductor y regresa a servicio si estaba bloqueado.
  async function onRegisterOilChange(id) {
    const v = (await safeVehicles()).find(x => x.id === id);
    const label = v ? (v.internal_code || v.license_plate || 'este vehículo') : 'este vehículo';
    const wasOverride = v && v.oil_override_at;
    const msg = wasOverride
      ? `¿Registrar el cambio de aceite de ${label}? Un conductor lo desbloqueó y sigue pendiente. Se reinicia el contador de km.`
      : `¿Registrar el cambio de aceite de ${label}? Quedará Disponible y se reinicia el contador de km.`;
    if (!confirm(msg)) return;
    try {
      await Api.registerOilChange(id, 'Cambio de aceite registrado desde Flota');
      toast('Cambio de aceite registrado.');
      renderVehiclesSettings();
    } catch (e) {
      console.error(e);
      alert('No se pudo registrar el cambio de aceite: ' + (e.message || 'error'));
    }
  }

  async function safeVehicles() { try { return await Api.listVehiclesForShift(); } catch (e) { return []; } }
