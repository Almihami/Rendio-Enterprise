// admin-repuestos.js — Admin: Repuestos (mantenimiento preventivo por pieza).
// Diseño UX "Rendio Admin - Repuestos"; datos reales de la migración 0073.
// Comparte scope global; el orden de carga está en index.html.
//
// Cómo funciona el kilometraje, que es lo que hace que esto se sostenga solo:
// el conductor reporta el odómetro en la inspección de inicio de turno y eso
// sube vehicles.current_km. El jefe llena UNA vez el km del último cambio de
// cada repuesto (vista "Cargar kilometrajes") y de ahí en adelante los 25
// semáforos se recalculan turno a turno sin que nadie vuelva a digitar nada.
//
// Regla de producto: NINGÚN repuesto bloquea el carro. Todo es aviso.

  // ---------------- estado del módulo ----------------
  let ptStatus = [];      // v_vehicle_part_status (vehículo × repuesto)
  let ptCatalog = [];     // part_catalog
  let ptLife = [];        // v_part_real_life
  let ptHist = [];        // maintenance con part_id
  let ptTiers = [];       // inspection_tiers
  let ptVehicles = [];    // vehicles
  let ptFilter = 'red';
  let ptCurVeh = null;    // vehículo abierto en el detalle
  let ptDrawer = null;    // { vehicleId, partCode }

  const PT_SYS = {
    motor: 'Motor', frenos: 'Frenos', llantas: 'Llantas',
    susp: 'Suspensión y dirección', trans: 'Transmisión',
  };
  const PT_COL = { red: 'var(--red)', amber: 'var(--amber)', green: 'var(--green)', nodata: 'var(--line2)' };
  const PT_LBL = { red: 'Vencido', amber: 'Por vencer', green: 'Al día', nodata: 'Sin dato' };
  const PT_ICON = { red: 'i-warn', amber: 'i-clock', green: 'i-check', nodata: 'i-info' };

  const ptFmt = (n) => (n == null ? '—' : Math.round(n).toLocaleString('es-CO'));
  const ptMoney = (n) => '$' + Math.round(n || 0).toLocaleString('es-CO');
  const ptEsc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const ptNum = (v) => { const n = parseInt(String(v == null ? '' : v).replace(/\D/g, ''), 10); return isNaN(n) ? null : n; };
  const ptDate = (d) => {
    if (!d) return '—';
    const dt = new Date(d);
    return dt.toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' });
  };

  // Cuánto le queda a la pieza, dicho como lo diría una persona.
  function ptRestTxt(s) {
    if (s.light === 'nodata') return 'sin dato de último cambio';
    if (s.months_since != null && s.interval_months && s.months_since >= s.interval_months) {
      return s.months_since + ' meses — pasó el plazo';
    }
    if (s.km_until <= 0) return 'pasado por ' + ptFmt(-s.km_until) + ' km';
    return 'quedan ' + ptFmt(s.km_until) + ' km';
  }
  // Fracción de vida consumida, con techo para que la barra no se desborde.
  const ptPct = (s) => (s.light === 'nodata' || !s.interval_km ? 0 : Math.min(1.35, (s.km_since || 0) / s.interval_km));

  // ====================================================================
  // Carga de datos
  // ====================================================================

  async function renderParts() {
    const root = $('#parts-ui');
    if (!root) return;
    try {
      const [status, catalog, life, hist, tiers, vehicles] = await Promise.all([
        API.listPartStatus(), API.listPartCatalog(), API.listPartRealLife(),
        API.listPartHistory(), API.listInspectionTiers(), API.listVehiclesForShift(),
      ]);
      ptStatus = status; ptCatalog = catalog; ptLife = life;
      ptHist = hist; ptTiers = tiers; ptVehicles = vehicles;
    } catch (e) {
      $('#pt-list').innerHTML = `<div class="empty"><h3>No se pudo cargar</h3><p>${ptEsc(e.message || e)}</p></div>`;
      return;
    }
    ptRenderAll();
    ptShowView('estado');
  }

  function ptRenderAll() {
    ptRenderPending();
    ptRenderKpis();
    ptRenderVcards();
    ptRenderQueue();
    ptRenderHistory('#pt-hist', null);
  }

  async function ptReload() {
    const [status, life, hist] = await Promise.all([
      API.listPartStatus(), API.listPartRealLife(), API.listPartHistory(),
    ]);
    ptStatus = status; ptLife = life; ptHist = hist;
    ptCatalog = await API.listPartCatalog();
    ptVehicles = await API.listVehiclesForShift();
    ptRenderAll();
    if (ptCurVeh) renderPartsVehicle(ptCurVeh);
  }

  const ptByVeh = (vid) => ptStatus.filter((s) => s.vehicle_id === vid);
  const ptCounts = (vid) => {
    const o = { red: 0, amber: 0, green: 0, nodata: 0 };
    ptByVeh(vid).forEach((s) => { o[s.light]++; });
    return o;
  };

  // ====================================================================
  // Bandeja: lo que reportó el conductor y espera confirmación
  // ====================================================================

  function ptRenderPending() {
    const box = $('#pt-pending');
    if (!box) return;
    const pend = ptHist.filter((h) => h.status === 'pending');
    if (!pend.length) { box.innerHTML = ''; return; }
    box.innerHTML = `
      <div class="rule1" style="border-left-color:var(--blue);margin:0">
        <span class="ri" style="background:var(--blue-soft);color:var(--blue)"><svg class="icon"><use href="#i-inbox"/></svg></span>
        <div class="rt"><b>${pend.length} cambio${pend.length === 1 ? '' : 's'} reportado${pend.length === 1 ? '' : 's'} por un conductor.</b>
          No mueve${pend.length === 1 ? '' : 'n'} el semáforo hasta que lo confirmes.</div>
      </div>
      ${pend.map((h) => `
        <div class="qrow nodata" style="grid-template-columns:74px 1.5fr 1fr auto">
          <div class="qv"><span class="tag">${ptEsc(h.vehicles?.internal_code || '—')}</span>
            <span class="om">${ptFmt(h.km_at_event)} km</span></div>
          <div class="qp"><b>${ptEsc(h.part_catalog?.name || h.maintenance_type)}</b>
            <div class="sys">Reportado el ${ptDate(h.performed_at)}${h.shop ? ' · ' + ptEsc(h.shop) : ''}${h.notes ? ' · ' + ptEsc(h.notes) : ''}</div></div>
          <div class="qm"><div class="lbl"><span>${h.cost_cop ? ptMoney(h.cost_cop) : 'Sin costo registrado'}</span></div></div>
          <div class="qa">
            <button class="rbtn" data-pt-rej="${h.id}">Rechazar</button>
            <button class="rbtn pri" data-pt-conf="${h.id}"><svg><use href="#i-check"/></svg>Confirmar</button>
          </div>
        </div>`).join('')}`;
  }

  // ====================================================================
  // KPIs + tarjetas de flota
  // ====================================================================

  function ptRenderKpis() {
    const red = ptStatus.filter((s) => s.light === 'red');
    const amber = ptStatus.filter((s) => s.light === 'amber');
    const green = ptStatus.filter((s) => s.light === 'green');
    const nodata = ptStatus.filter((s) => s.light === 'nodata');
    const critRed = red.filter((s) => s.is_critical).length;

    // Gasto de los últimos 60 días, con lo que de verdad se registró.
    const since = Date.now() - 60 * 864e5;
    const recent = ptHist.filter((h) => h.status === 'confirmed' && new Date(h.performed_at).getTime() >= since);
    const gasto = recent.reduce((a, h) => a + Number(h.cost_cop || 0), 0);

    $('#pt-kpis').innerHTML = `
      <div class="kpi bad"><div class="kl"><i style="background:var(--red)"></i>Vencidos</div>
        <span class="kv">${red.length}</span>
        <div class="kf">${critRed} crítico${critRed === 1 ? '' : 's'} · el semáforo avisa, no bloquea</div></div>
      <div class="kpi warn"><div class="kl"><i style="background:var(--amber)"></i>Por vencer</div>
        <span class="kv">${amber.length}</span>
        <div class="kf">Último 15% de vida útil</div></div>
      <div class="kpi good"><div class="kl"><i style="background:var(--green)"></i>Al día</div>
        <span class="kv">${green.length}</span>
        <div class="kf">De ${ptStatus.length} controles${nodata.length ? ' · ' + nodata.length + ' sin dato' : ''}</div></div>
      <div class="kpi"><div class="kl">Gasto últimos 2 meses</div>
        <span class="kv">${gasto ? ptMoney(gasto) : '—'}</span>
        <div class="kf">${recent.length} cambio${recent.length === 1 ? '' : 's'} registrado${recent.length === 1 ? '' : 's'}</div></div>`;

    $('#pt-count').textContent = red.length + ' vencidos';
    ['red', 'amber', 'nodata'].forEach((k) => {
      const el = $(`#pt-filter .n[data-c="${k}"]`);
      if (el) el.textContent = ptStatus.filter((s) => s.light === k).length;
    });
    const alertEl = $('#pt-filter .n[data-c="alert"]');
    if (alertEl) alertEl.textContent = red.length + amber.length;
  }

  function ptRenderVcards() {
    const byV = {};
    ptStatus.forEach((s) => { (byV[s.vehicle_id] = byV[s.vehicle_id] || []).push(s); });
    const ids = Object.keys(byV);
    if (!ids.length) {
      $('#pt-vcards').innerHTML = `<div class="empty"><h3>Sin vehículos</h3><p>Agrega la flota en Ajustes para controlar sus repuestos.</p></div>`;
      return;
    }
    $('#pt-vcards').innerHTML = ids.map((vid) => {
      const rows = byV[vid];
      const v = rows[0];
      const c = ptCounts(vid);
      // Lo más próximo al límite entre lo que sí tiene dato.
      const next = rows.filter((s) => s.light === 'red' || s.light === 'amber')
        .sort((a, b) => (a.km_until || 0) - (b.km_until || 0))[0];
      const pend = c.nodata;
      const nx = next
        ? `<b>${ptEsc(next.part_name)}</b> — ${ptRestTxt(next)}`
        : (pend === rows.length ? 'Falta cargar el kilometraje de sus repuestos.' : 'Sin nada cerca del límite.');
      return `<button class="vcard" data-pt-veh="${vid}">
        <div class="vh"><span class="plate">${ptEsc(v.internal_code || '—')}</span>
          <span class="vn">${ptEsc(ptVehLabel(vid))}</span>
          <span style="font-family:var(--mono);font-size:11px;color:var(--ink3)">${ptEsc(v.license_plate || '')}</span></div>
        <div class="odo"><b>${ptFmt(v.current_km)}</b><s>km</s></div>
        <div class="src"><svg class="icon" style="width:12px;height:12px"><use href="#i-clock"/></svg>Odómetro de la última inspección de inicio</div>
        <div class="dots">
          <span class="dot"><i style="background:var(--red)"></i>${c.red} vencido${c.red === 1 ? '' : 's'}</span>
          <span class="dot"><i style="background:var(--amber)"></i>${c.amber} por vencer</span>
          <span class="dot"><i style="background:var(--green)"></i>${c.green} al día</span>
          ${c.nodata ? `<span class="dot"><i style="background:var(--line2)"></i>${c.nodata} sin dato</span>` : ''}
        </div>
        <div class="next">Lo más próximo: ${nx}</div>
        <div class="go">Ver los ${rows.length} repuestos<svg class="icon" style="width:13px;height:13px"><use href="#i-go"/></svg></div>
      </button>`;
    }).join('');
  }

  function ptVehLabel(vid) {
    const v = ptVehicles.find((x) => x.id === vid);
    if (!v) return '—';
    return [v.brand, v.model].filter(Boolean).join(' ') || v.internal_code || v.license_plate;
  }

  // ====================================================================
  // Cola: qué hay que cambiar
  // ====================================================================

  function ptRenderQueue() {
    let list;
    if (ptFilter === 'alert') list = ptStatus.filter((s) => s.light === 'red' || s.light === 'amber');
    else list = ptStatus.filter((s) => s.light === ptFilter);

    const order = { red: 0, amber: 1, nodata: 2, green: 3 };
    list.sort((a, b) => (order[a.light] - order[b.light]) || ((a.km_until || 0) - (b.km_until || 0)));

    if (!list.length) {
      $('#pt-list').innerHTML = `<div class="empty">
        <h3>Nada pendiente aquí</h3>
        <p>${ptFilter === 'nodata'
          ? 'Todos los repuestos tienen su kilometraje cargado.'
          : 'Ningún repuesto en este estado.'}</p></div>`;
      return;
    }
    $('#pt-list').innerHTML = list.map((s) => `
      <div class="qrow ${s.light}">
        <div class="qv"><span class="tag">${ptEsc(s.internal_code || '—')}</span>
          <span class="om">${ptFmt(s.current_km)} km</span></div>
        <div class="qp"><b>${ptEsc(s.part_name)}${s.is_critical ? '<span class="crit">Crítico</span>' : ''}</b>
          <div class="sys">${PT_SYS[s.system] || s.system} · intervalo ${ptFmt(s.interval_km)} km${s.interval_months ? ' o ' + s.interval_months + ' meses' : ''}${s.has_override ? ' (propio de este carro)' : ''}${s.last_change_km != null ? ' · último cambio a los ' + ptFmt(s.last_change_km) + ' km' : ''}</div></div>
        <div class="qm">
          ${s.light === 'nodata'
            ? `<div class="lbl"><span style="color:var(--ink3);font-weight:600">El jefe aún no cargó desde cuándo contar.</span></div>`
            : `<div class="lbl"><span>${ptFmt(s.km_since)} km de ${ptFmt(s.interval_km)}</span>
                 <span class="r" style="color:${PT_COL[s.light]}">${Math.round(ptPct(s) * 100)}%</span></div>
               <div class="pbar"><i style="width:${Math.min(100, ptPct(s) * 100)}%;background:${PT_COL[s.light]}"></i></div>
               <div class="lbl"><span style="color:var(--ink3);font-weight:600">${ptRestTxt(s)}</span></div>`}
        </div>
        <div class="qa">
          <span class="st ${s.light}"><svg><use href="#${PT_ICON[s.light]}"/></svg>${PT_LBL[s.light]}</span>
          ${s.light === 'nodata'
            ? `<button class="rbtn" data-pt-carga="${s.vehicle_id}"><svg><use href="#i-edit"/></svg>Cargar km</button>`
            : `<button class="rbtn pri" data-pt-reg="${s.vehicle_id}|${s.part_code}"><svg><use href="#i-wrench"/></svg>Registrar cambio</button>`}
        </div>
      </div>`).join('');
  }

  function ptRenderHistory(target, vid) {
    const list = ptHist.filter((h) => h.status === 'confirmed' && (!vid || h.vehicle_id === vid));
    const box = $(target);
    if (!box) return;
    if (!list.length) {
      box.innerHTML = `<div style="font-size:13px;color:var(--ink3);padding:10px 4px">
        Sin cambios registrados todavía. Cada cambio que registres aquí alimenta la vida real de la pieza.</div>`;
      return;
    }
    box.innerHTML = list.map((h) => {
      const intv = h.part_catalog?.interval_km;
      let dur = '';
      if (h.duration_km != null && intv) {
        const d = h.duration_km - intv;
        const cls = d < -intv * 0.08 ? 'dn' : d > intv * 0.08 ? 'up' : 'eq';
        dur = `duró ${ptFmt(h.duration_km)} km <span class="delta ${cls}">${d > 0 ? '+' : ''}${ptFmt(d)}</span>`;
      } else {
        dur = `<span class="delta eq">primer registro</span>`;
      }
      return `<div class="hrow">
        <span class="d">${ptDate(h.performed_at)}</span>
        <span class="pn">${ptEsc(h.part_catalog?.name || h.maintenance_type)}
          <span style="color:var(--ink3);font-weight:600">· ${ptEsc(h.vehicles?.internal_code || '')}</span></span>
        <span class="num">${h.cost_cop ? ptMoney(h.cost_cop) : '—'}</span>
        <span class="dur">${dur}</span>
        <span class="tl">${ptEsc(h.shop || 'Sin taller registrado')}</span>
      </div>`;
    }).join('');
  }

  // ====================================================================
  // Detalle del vehículo
  // ====================================================================

  function renderPartsVehicle(vid) {
    ptCurVeh = vid;
    const rows = ptByVeh(vid);
    if (!rows.length) return;
    const v = rows[0];
    const c = ptCounts(vid);
    const gasto = ptHist.filter((h) => h.vehicle_id === vid && h.status === 'confirmed')
      .reduce((a, h) => a + Number(h.cost_cop || 0), 0);
    const nCambios = ptHist.filter((h) => h.vehicle_id === vid && h.status === 'confirmed').length;

    const groups = {};
    rows.forEach((s) => { (groups[s.system] = groups[s.system] || []).push(s); });

    // Próximo nivel preventivo: el múltiplo de km más cercano por delante.
    const nt = ptNextTier(v.current_km);

    $('#pt-v-veh').innerHTML = `
      <button class="back" data-pt-back><svg class="icon"><use href="#i-back"/></svg>Volver a la flota</button>
      <div class="card">
        <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
          <span class="plate" style="font-size:12px;padding:5px 10px">${ptEsc(v.internal_code || '—')}</span>
          <div style="flex:1;min-width:180px">
            <h2>${ptEsc(ptVehLabel(vid))}</h2>
            <div style="font-size:12.5px;color:var(--ink2);margin-top:4px">
              <span style="font-family:var(--mono)">${ptEsc(v.license_plate || '')}</span>
              · Odómetro leído en la inspección de inicio de turno</div>
          </div>
          <div style="text-align:right">
            <div style="font-family:var(--mono);font-size:26px;font-weight:700;letter-spacing:-.03em">${ptFmt(v.current_km)} km</div>
            <div style="font-size:11px;color:var(--ink3);font-weight:600">Odómetro</div>
          </div>
          <button class="rbtn" data-pt-odo="${vid}"><svg><use href="#i-gauge"/></svg>Corregir</button>
          <button class="rbtn pri" data-pt-carga="${vid}"><svg><use href="#i-edit"/></svg>Cargar kilometrajes</button>
        </div>
      </div>
      <div class="cols">
        <div>
          <div class="card">
            <h2><svg class="icon"><use href="#i-wrench"/></svg>Repuestos del vehículo</h2>
            <p class="csub" style="font-size:12.5px;color:var(--ink2);margin:4px 0 14px">Intervalo propio de la empresa · kilómetros restantes hasta el cambio.</p>
            ${Object.keys(PT_SYS).filter((k) => groups[k]).map((k) => `
              <div class="psys"><h3>${PT_SYS[k]}</h3><span class="rule"></span></div>
              ${groups[k].map((s) => `<div class="prow">
                <span class="pn"><span>${ptEsc(s.part_name)}</span>${s.is_critical ? '<span class="crit">Crít</span>' : ''}</span>
                <span class="pi">${ptFmt(s.interval_km)} km</span>
                <span class="pb">${s.light === 'nodata' ? '' :
                  `<div class="pbar"><i style="width:${Math.min(100, ptPct(s) * 100)}%;background:${PT_COL[s.light]}"></i></div>`}</span>
                <span class="pr" style="color:${s.light === 'green' ? 'var(--ink2)' : PT_COL[s.light]}">${ptRestTxt(s)}</span>
                <span class="pa"><button class="mini" data-pt-reg="${vid}|${s.part_code}" title="Registrar cambio">
                  <svg class="icon" style="width:14px;height:14px"><use href="#i-wrench"/></svg></button></span>
              </div>`).join('')}`).join('')}
          </div>
          <div class="card" style="margin-bottom:0">
            <h2><svg class="icon"><use href="#i-hist"/></svg>Historial del vehículo</h2>
            <p class="csub" style="font-size:12.5px;color:var(--ink2);margin:4px 0 14px">Lo que ya se cambió y cuánto duró de verdad en nuestra operación.</p>
            <div id="pt-vhist"></div>
          </div>
        </div>
        <div>
          <div class="card">
            <h2><svg class="icon"><use href="#i-shield"/></svg>Próxima inspección preventiva</h2>
            ${nt ? `<p class="csub" style="font-size:12.5px;color:var(--ink2);margin:4px 0 14px">
              Toca a los <b style="font-family:var(--mono)">${ptFmt(nt.at)} km</b> — en ${ptFmt(nt.at - v.current_km)} km.</p>
              <div class="tier" style="box-shadow:none;border-color:var(--line2)">
                <div class="th"><b>${ptFmt(nt.every_km)}</b><s>km · ${ptEsc(nt.title)}</s></div>
                <ul>${nt.items.map((i) => `<li>${ptEsc(i)}</li>`).join('')}</ul>
                <div class="who">Estos ítems se suman solos al checklist de la inspección de inicio del turno en que el carro cruce ese kilometraje.</div>
              </div>`
              : `<p class="csub" style="font-size:12.5px;color:var(--ink2);margin-top:4px">Sin niveles configurados.</p>`}
          </div>
          <div class="card">
            <h2><svg class="icon"><use href="#i-info"/></svg>Resumen</h2>
            <div style="margin-top:6px">
              <div class="kv"><span class="k">Repuestos vencidos</span><span class="v" style="font-family:var(--mono);color:${c.red ? 'var(--red)' : 'var(--ink)'}">${c.red}</span></div>
              <div class="kv"><span class="k">Por vencer</span><span class="v" style="font-family:var(--mono)">${c.amber}</span></div>
              <div class="kv"><span class="k">Sin dato cargado</span><span class="v" style="font-family:var(--mono)">${c.nodata}</span></div>
              <div class="kv"><span class="k">Cambios registrados</span><span class="v" style="font-family:var(--mono)">${nCambios}</span></div>
              <div class="kv"><span class="k">Gasto acumulado</span><span class="v" style="font-family:var(--mono)">${gasto ? ptMoney(gasto) : '—'}</span></div>
            </div>
          </div>
          <div class="card" style="margin-bottom:0">
            <div class="note"><svg><use href="#i-info"/></svg><span><b>De dónde sale el kilometraje:</b> del campo “kilometraje de salida” que el conductor reporta en la inspección de inicio de turno. Si no coincide con el tablero del carro, corrígelo aquí y queda el registro.</span></div>
          </div>
        </div>
      </div>`;
    ptRenderHistory('#pt-vhist', vid);
    ptShowView('veh');
  }

  // Ítems del checklist de cada nivel, para mostrarlos en el detalle.
  const PT_TIER_ITEMS = {
    5000: ['Pastillas y discos a la vista', 'Llantas: labrado y presión', 'Suspensión y dirección', 'Fugas de aceite y refrigerante'],
    10000: ['Espesor de pastillas y bandas', 'Juego de rótulas y terminales', 'Bujes y tijeras', 'Estado de amortiguadores'],
    20000: ['Suspensión en detalle', 'Soportes del motor', 'Estado de caja y transmisión'],
    40000: ['Frenos completos', 'Cambio de líquidos que apliquen', 'Tren delantero completo'],
  };

  function ptNextTier(odo) {
    if (!ptTiers.length || odo == null) return null;
    let best = null;
    ptTiers.forEach((t) => {
      const at = Math.ceil((odo + 1) / t.every_km) * t.every_km;
      // A igual kilometraje manda el nivel más alto: incluye a los anteriores.
      if (!best || at < best.at || (at === best.at && t.every_km > best.every_km)) {
        best = { at, every_km: t.every_km, title: t.title, items: PT_TIER_ITEMS[t.every_km] || [] };
      }
    });
    return best;
  }

  // ====================================================================
  // Vida real
  // ====================================================================

  function renderPartsVida() {
    const byCode = {};
    ptLife.forEach((r) => { byCode[r.part_code] = r; });
    const rows = ptCatalog.filter((p) => byCode[p.code]).map((p) => ({ p, r: byCode[p.code] }));
    const fat = rows.filter((x) => x.r.is_reliable).sort((a, b) => b.r.n - a.r.n);
    const thin = rows.filter((x) => !x.r.is_reliable);

    $('#pt-v-vida').innerHTML = `
      <div class="phead">
        <div>
          <h1>Vida real de los repuestos</h1>
          <p>Cuánto dura cada pieza <b>en nuestra operación</b>, medido con los cambios ya registrados. Este dato vale más que el intervalo genérico del fabricante: con él se planean las compras y se negocia con el proveedor.</p>
        </div>
        <div class="seg" id="pt-tabs2">
          <button data-v="estado"><svg class="icon" style="width:13px;height:13px"><use href="#i-gauge"/></svg>Estado</button>
          <button data-v="vida" class="on"><svg class="icon" style="width:13px;height:13px"><use href="#i-chart"/></svg>Vida real</button>
          <button data-v="plan"><svg class="icon" style="width:13px;height:13px"><use href="#i-list"/></svg>Intervalos y plan</button>
        </div>
      </div>
      <div class="rule1" style="border-left-color:var(--blue)">
        <span class="ri" style="background:var(--blue-soft);color:var(--blue)"><svg class="icon"><use href="#i-chart"/></svg></span>
        <div class="rt"><b>Se necesitan 3 cambios de la misma pieza</b> para que el promedio cuente. Debajo de eso se muestra como dato insuficiente y el intervalo no se sugiere ajustar.</div>
      </div>
      ${fat.length ? `<div class="vgrid">${fat.map(ptVidaCard).join('')}</div>` : `
        <div class="empty">
          <h3>Todavía no hay vida real que mostrar</h3>
          <p>Esta pantalla se llena sola con los cambios que vayas registrando. Necesita 3 cambios de una misma pieza para calcular un promedio que signifique algo — con la operación andando, eso toma unos meses.</p>
        </div>`}
      <div class="sech"><h2>Aún sin datos suficientes</h2><span class="rule"></span><span class="hint">Menos de 3 cambios registrados</span></div>
      <div class="card" style="margin-bottom:0">
        ${thin.length ? thin.map((x) => `<div class="hrow" style="grid-template-columns:1fr 90px 1fr">
            <span class="pn">${ptEsc(x.p.name)}</span>
            <span class="num">n=${x.r.n}</span>
            <span class="tl">Primer dato: ${ptFmt(x.r.avg_km)} km · falta${3 - x.r.n === 1 ? '' : 'n'} ${3 - x.r.n} cambio${3 - x.r.n === 1 ? '' : 's'} para promediar</span>
          </div>`).join('')
          : `<div style="font-size:13px;color:var(--ink3);padding:10px 4px">Sin cambios registrados todavía.</div>`}
      </div>`;
    ptShowView('vida');
  }

  function ptVidaCard(x) {
    const d = x.r.avg_km - x.p.interval_km;
    const pc = d / x.p.interval_km;
    const m = Math.max(x.p.interval_km, x.r.avg_km, 1);
    const cls = pc < -0.05 ? 'dn' : pc > 0.08 ? 'up' : 'eq';
    const msg = pc < -0.05
      ? `Nos está durando <b>${ptFmt(-d)} km menos</b> que nuestro intervalo. Acortarlo evita que la pieza llegue al límite en ruta.`
      : pc > 0.08
        ? `Nos rinde <b>${ptFmt(d)} km más</b>. Se puede estirar el intervalo sin arriesgar y bajar el gasto.`
        : `El intervalo está bien calibrado con la realidad de la operación.`;
    // Sugerencia con 5% de margen bajo el promedio medido, redondeada a 500.
    const sug = pc > 0
      ? Math.ceil(x.r.avg_km * 0.95 / 500) * 500
      : Math.floor(x.r.avg_km * 0.95 / 500) * 500;
    const canAdj = Math.abs(sug - x.p.interval_km) >= 500 && Math.abs(pc) > 0.05;
    return `<div class="vr">
      <div class="vrh"><b>${ptEsc(x.p.name)}</b>${x.p.is_critical ? '<span class="crit">Crítico</span>' : ''}<span class="n">n=${x.r.n}</span></div>
      <div class="cmp">
        <div class="row"><span>Nuestro intervalo</span>
          <span class="track"><i style="width:${x.p.interval_km / m * 100}%;background:var(--ink3)"></i></span>
          <span class="num">${ptFmt(x.p.interval_km)}</span></div>
        <div class="row"><span>Vida real medida</span>
          <span class="track"><i style="width:${x.r.avg_km / m * 100}%;background:${pc < -0.05 ? 'var(--red)' : pc > 0.08 ? 'var(--green)' : 'var(--blue)'}"></i></span>
          <span class="num">${ptFmt(x.r.avg_km)}</span></div>
        <div class="row"><span>Carro particular</span>
          <span style="font-size:11.5px;color:var(--ink3);font-weight:600">${ptEsc(x.p.reference_particular || '—')}</span>
          <span class="num delta ${cls}">${d > 0 ? '+' : ''}${ptFmt(d)}</span></div>
      </div>
      <div class="vrf"><span class="msg">${msg}</span>
        ${canAdj
          ? `<button class="rbtn pri" data-pt-adj="${x.p.code}|${sug}">Ajustar a ${ptFmt(sug)} km</button>`
          : `<span class="st green"><svg><use href="#i-check"/></svg>Calibrado</span>`}</div>
    </div>`;
  }

  // ====================================================================
  // Intervalos y plan de inspección
  // ====================================================================

  function renderPartsPlan() {
    const byCode = {};
    ptLife.forEach((r) => { byCode[r.part_code] = r; });

    let tbl = `<thead><tr><th>Repuesto</th><th>Carro particular</th><th>Nuestro intervalo</th><th>Vida real medida</th><th>Diferencia</th><th></th></tr></thead><tbody>`;
    Object.keys(PT_SYS).forEach((k) => {
      const parts = ptCatalog.filter((p) => p.system === k);
      if (!parts.length) return;
      tbl += `<tr class="sysrow"><td colspan="6">${PT_SYS[k]}</td></tr>`;
      parts.forEach((p) => {
        const r = byCode[p.code];
        const d = r ? r.avg_km - p.interval_km : null;
        tbl += `<tr>
          <td class="nm">${ptEsc(p.name)}${p.is_critical ? ' <span class="crit">Crít</span>' : ''}${p.note ? `<div style="font-size:11px;color:var(--ink3);font-weight:600">${ptEsc(p.note)}</div>` : ''}</td>
          <td class="num dim">${ptEsc(p.reference_particular || '—')}</td>
          <td class="num emp">${ptFmt(p.interval_km)} km${p.interval_months ? `<div style="font-size:10.5px;color:var(--ink3)">o ${p.interval_months} meses</div>` : ''}</td>
          <td class="num ${r ? '' : 'dim'}">${r ? ptFmt(r.avg_km) + ' km' : '—'}${r ? `<div style="font-size:10.5px;color:var(--ink3)">n=${r.n}</div>` : ''}</td>
          <td>${r && r.is_reliable
            ? `<span class="delta ${d < -p.interval_km * 0.05 ? 'dn' : d > p.interval_km * 0.08 ? 'up' : 'eq'}">${d > 0 ? '+' : ''}${ptFmt(d)}</span>`
            : '<span class="delta eq">sin dato</span>'}</td>
          <td style="text-align:right"><button class="mini" data-pt-editint="${p.code}" title="Cambiar intervalo">
            <svg class="icon" style="width:14px;height:14px"><use href="#i-edit"/></svg></button></td></tr>`;
      });
    });
    tbl += '</tbody>';

    $('#pt-v-plan').innerHTML = `
      <div class="phead">
        <div>
          <h1>Intervalos y plan de inspección</h1>
          <p>Nuestros intervalos son <b>más cortos que los de un carro particular</b>: estos carros ruedan todo el día y mueven tripulaciones con hora de presentación. Adelantar un cambio cuesta menos que una avería en ruta.</p>
        </div>
        <div class="seg" id="pt-tabs3">
          <button data-v="estado"><svg class="icon" style="width:13px;height:13px"><use href="#i-gauge"/></svg>Estado</button>
          <button data-v="vida"><svg class="icon" style="width:13px;height:13px"><use href="#i-chart"/></svg>Vida real</button>
          <button data-v="plan" class="on"><svg class="icon" style="width:13px;height:13px"><use href="#i-list"/></svg>Intervalos y plan</button>
        </div>
      </div>
      <div class="sech" style="margin-top:0"><h2>Plan de inspección preventiva</h2><span class="rule"></span><span class="hint">Cada nivel incluye los anteriores</span></div>
      <div class="tiers">${ptTiers.map((t) => {
        const items = PT_TIER_ITEMS[t.every_km] || [];
        // A qué carro le toca primero este nivel.
        const due = ptVehicles.map((v) => ({ v, at: Math.ceil(((v.current_km || 0) + 1) / t.every_km) * t.every_km }))
          .sort((a, b) => (a.at - (a.v.current_km || 0)) - (b.at - (b.v.current_km || 0)))[0];
        return `<div class="tier">
          <div class="th"><b>${ptFmt(t.every_km)}</b><s>km</s></div>
          <div style="font-size:12.5px;font-weight:800;letter-spacing:-.01em;margin-top:-4px">${ptEsc(t.title)}</div>
          <ul>${items.map((i) => `<li>${ptEsc(i)}</li>`).join('')}</ul>
          ${due ? `<div class="who">Próximo: <b>${ptEsc(due.v.internal_code)}</b> en ${ptFmt(due.at - (due.v.current_km || 0))} km</div>` : ''}
        </div>`;
      }).join('')}</div>
      <div class="sech"><h2>Tabla de intervalos</h2><span class="rule"></span><span class="hint">Editable · aplica a toda la flota</span></div>
      <div class="card" style="margin-bottom:0">
        <p style="font-size:12.5px;color:var(--ink2);margin:0 0 14px;line-height:1.5">La columna <b>Nuestro intervalo</b> es la que manda el semáforo. La de <b>vida real</b> viene de los cambios registrados y es la que debería ir corrigiendo la nuestra. Un carro puede tener su propia excepción desde el detalle del vehículo.</p>
        <div class="tblwrap"><table class="tbl">${tbl}</table></div>
      </div>`;
    ptShowView('plan');
  }

  // ====================================================================
  // Carga inicial: el jefe llena los km una sola vez
  // ====================================================================

  function renderPartsBaseline(vid) {
    const rows = ptByVeh(vid);
    if (!rows.length) return;
    const v = rows[0];
    $('#pt-v-carga').innerHTML = `
      <button class="back" data-pt-back-veh="${vid}"><svg class="icon"><use href="#i-back"/></svg>Volver al vehículo</button>
      <div class="card">
        <h2><svg class="icon"><use href="#i-edit"/></svg>Cargar kilometrajes · ${ptEsc(v.internal_code)} ${ptEsc(ptVehLabel(vid))}</h2>
        <p style="font-size:12.5px;color:var(--ink2);margin:6px 0 0;line-height:1.5">
          Esto se llena <b>una sola vez</b>. Escribe a cuántos kilómetros se cambió por última vez cada pieza; de ahí en adelante el sistema cuenta solo con el odómetro que reporta el conductor en cada turno.</p>
        <div class="note" style="margin-top:12px"><svg><use href="#i-info"/></svg><span>
          <b>Lo que no sepas, déjalo vacío.</b> Queda como “sin dato”: no calcula ni alerta, y aparece en la lista pidiendo el dato. Es preferible a inventar una cifra, porque un número falso pinta la pieza en verde cuando puede estar al límite.
          El odómetro actual del carro es <b style="font-family:var(--mono)">${ptFmt(v.current_km)} km</b>, así que ningún cambio pudo hacerse por encima de esa cifra.</span></div>
      </div>
      <div class="card">
        ${Object.keys(PT_SYS).map((k) => {
          const parts = rows.filter((s) => s.system === k);
          if (!parts.length) return '';
          return `<div class="psys"><h3>${PT_SYS[k]}</h3><span class="rule"></span></div>
            ${parts.map((s) => `<div class="brow">
              <span class="bn">${ptEsc(s.part_name)}${s.is_critical ? '<span class="crit">Crít</span>' : ''}
                <span class="bi">c/${ptFmt(s.interval_km)} km</span></span>
              <input data-pt-bk="${s.part_code}" inputmode="numeric" placeholder="km del cambio"
                value="${s.last_change_km != null ? ptFmt(s.last_change_km) : ''}">
              <input data-pt-bd="${s.part_code}" type="date" title="Fecha del último cambio"
                value="${s.last_change_at || ''}">
              <span class="bs">${s.interval_months
                ? 'Vence también a los ' + s.interval_months + ' meses — la fecha es obligatoria'
                : 'Fecha opcional'}</span>
            </div>`).join('')}`;
        }).join('')}
      </div>
      <div style="display:flex;gap:9px;justify-content:flex-end;padding-bottom:24px">
        <button class="btn ghost" data-pt-back-veh="${vid}">Cancelar</button>
        <button class="btn" data-pt-save-baseline="${vid}"><svg class="icon"><use href="#i-save"/></svg>Guardar kilometrajes</button>
      </div>`;
    ptShowView('carga');
  }

  async function ptSaveBaseline(vid) {
    const entries = [];
    let faltaFecha = null;
    $$('#pt-v-carga [data-pt-bk]').forEach((inp) => {
      const code = inp.dataset.ptBk;
      const km = ptNum(inp.value);
      const dEl = $(`#pt-v-carga [data-pt-bd="${code}"]`);
      const date = dEl && dEl.value ? dEl.value : null;
      const st = ptStatus.find((s) => s.vehicle_id === vid && s.part_code === code);
      // Las piezas que vencen por tiempo no sirven sin la fecha.
      if (km != null && st && st.interval_months && !date) faltaFecha = st.part_name;
      entries.push({ part_code: code, last_change_km: km, last_change_at: date });
    });
    if (faltaFecha) {
      toast(`${faltaFecha} vence también por tiempo: falta la fecha del último cambio.`);
      return;
    }
    try {
      const r = await API.setVehiclePartBaseline(vid, entries);
      const cargados = entries.filter((e) => e.last_change_km != null).length;
      await ptReload();
      renderPartsVehicle(vid);
      toast(`Kilometrajes guardados · ${cargados} de ${r.parts} repuestos con dato.`);
    } catch (e) {
      toast(ptErr(e));
    }
  }

  // Los errores de la BD vienen con prefijo técnico; se traducen a algo legible.
  function ptErr(e) {
    const m = String(e?.message || e);
    if (m.includes('KM_GT_ODOMETER')) {
      return 'Hay un kilometraje mayor al odómetro del carro. ' + m.split('KM_GT_ODOMETER:')[1].trim();
    }
    if (m.includes('KM_LT_PREVIOUS')) return 'El kilómetro del cambio es menor al del cambio anterior.';
    if (m.includes('NOT_ADMIN')) return 'Solo el administrador puede hacer este cambio.';
    if (m.includes('KM_REQUIRED')) return 'Falta el kilometraje.';
    return m;
  }

  // ====================================================================
  // Cajón: registrar cambio
  // ====================================================================

  function ptOpenDrawer(vid, partCode) {
    const vehs = ptVehicles.filter((v) => ptStatus.some((s) => s.vehicle_id === v.id));
    const vehId = vid || (vehs[0] && vehs[0].id);
    ptDrawer = { vehicleId: vehId, partCode: partCode || (ptCatalog[0] && ptCatalog[0].code) };
    const v = ptVehicles.find((x) => x.id === vehId);

    $('#parts-drawer-root').innerHTML = `
      <div class="scrim show" data-pt-close></div>
      <aside class="drawer show">
        <div class="dh"><svg class="icon" style="width:18px;height:18px;color:var(--ink3)"><use href="#i-wrench"/></svg>
          <b>Registrar cambio</b>
          <button class="mini" data-pt-close><svg class="icon"><use href="#i-x"/></svg></button></div>
        <div class="db">
          <div class="fld"><label>Vehículo</label><select id="pt-f-veh">
            ${vehs.map((x) => `<option value="${x.id}" ${x.id === vehId ? 'selected' : ''}>${ptEsc(x.internal_code)} · ${ptEsc([x.brand, x.model].filter(Boolean).join(' '))}</option>`).join('')}
          </select></div>
          <div class="fld"><label>Repuesto</label><select id="pt-f-part">
            ${Object.keys(PT_SYS).map((k) => {
              const ps = ptCatalog.filter((p) => p.system === k);
              if (!ps.length) return '';
              return `<optgroup label="${PT_SYS[k]}">${ps.map((p) => `<option value="${p.code}" ${p.code === ptDrawer.partCode ? 'selected' : ''}>${ptEsc(p.name)}</option>`).join('')}</optgroup>`;
            }).join('')}
          </select></div>
          <div class="frow">
            <div class="fld"><label>Km al cambio</label><input class="mono" id="pt-f-km" inputmode="numeric" value="${ptFmt(v?.current_km)}"></div>
            <div class="fld"><label>Fecha</label><input class="mono" id="pt-f-date" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>
          </div>
          <div class="calc" id="pt-f-calc"></div>
          <div class="frow">
            <div class="fld"><label>Costo (COP)</label><input class="mono" id="pt-f-cost" inputmode="numeric" placeholder="0"></div>
            <div class="fld"><label>Taller / proveedor</label><input id="pt-f-shop" placeholder="Taller Central"></div>
          </div>
          <div class="fld"><label>Nota</label><textarea id="pt-f-note" placeholder="Ej: se cambió antes del intervalo porque venía sonando en frío."></textarea></div>
          <div class="note"><svg><use href="#i-info"/></svg><span>Al guardar, el semáforo de este repuesto vuelve a cero y la duración real entra al promedio de la flota.</span></div>
        </div>
        <div class="df"><button class="btn ghost" data-pt-close>Cancelar</button>
          <button class="btn" id="pt-f-save">Guardar cambio</button></div>
      </aside>`;
    ptCalc();
  }

  function ptCloseDrawer() { ptDrawer = null; $('#parts-drawer-root').innerHTML = ''; }

  // Muestra cuánto duró de verdad la pieza que sale, antes de guardar.
  function ptCalc() {
    if (!ptDrawer) return;
    const vid = $('#pt-f-veh')?.value;
    const code = $('#pt-f-part')?.value;
    const st = ptStatus.find((s) => s.vehicle_id === vid && s.part_code === code);
    const box = $('#pt-f-calc');
    if (!st || !box) return;
    const km = ptNum($('#pt-f-km')?.value) ?? st.current_km;
    const save = $('#pt-f-save');

    if (st.last_change_km == null) {
      box.innerHTML = `<div class="ct2">Duración real de la pieza que sale</div>
        <div class="big"><b style="color:var(--ink3)">—</b></div>
        <div class="msg">Este carro no tiene cargado el km del último cambio de esta pieza, así que <b>no se puede medir cuánto duró</b>. El registro queda igual y de aquí en adelante sí se mide.</div>`;
      if (save) save.disabled = false;
      return;
    }
    const dur = km - st.last_change_km;
    const d = dur - st.interval_km;
    const pc = d / st.interval_km;
    const col = dur <= 0 ? 'var(--red)' : pc < -0.12 ? 'var(--red)' : pc > 0.05 ? 'var(--green)' : 'var(--ink)';
    const msg = dur <= 0
      ? `El kilómetro debe ser mayor al del último cambio (${ptFmt(st.last_change_km)} km).`
      : pc < -0.12
        ? `Duró <b>${ptFmt(-d)} km menos</b> que el intervalo. Si vuelve a pasar, hay que acortarlo o revisar la calidad del repuesto.`
        : pc > 0.05
          ? `Duró <b>${ptFmt(d)} km más</b> que el intervalo — buen indicio para estirarlo.`
          : `Dentro de lo esperado para el intervalo de ${ptFmt(st.interval_km)} km.`;
    box.innerHTML = `<div class="ct2">Duración real de la pieza que sale</div>
      <div class="big"><b style="color:${col}">${dur > 0 ? ptFmt(dur) : '—'}</b>
        <span style="font-size:12px;font-weight:700;color:var(--ink3)">km · último cambio a los ${ptFmt(st.last_change_km)} km</span></div>
      <div class="msg">${msg}</div>`;
    if (save) save.disabled = dur <= 0;
  }

  async function ptSaveChange() {
    const vid = $('#pt-f-veh').value;
    const code = $('#pt-f-part').value;
    const km = ptNum($('#pt-f-km').value);
    if (km == null) { toast('Falta el kilometraje del cambio.'); return; }
    try {
      const r = await API.registerPartChange({
        vehicleId: vid, partCode: code, km,
        date: $('#pt-f-date').value || null,
        cost: ptNum($('#pt-f-cost').value),
        shop: $('#pt-f-shop').value || null,
        notes: $('#pt-f-note').value || null,
      });
      ptCloseDrawer();
      await ptReload();
      toast(r.duration_km
        ? `${r.part_name} al día · duró ${ptFmt(r.duration_km)} km`
        : `${r.part_name} al día · primer registro, desde aquí se mide la duración`);
    } catch (e) {
      toast(ptErr(e));
    }
  }

  // ====================================================================
  // Navegación entre vistas
  // ====================================================================

  function ptShowView(v) {
    ['estado', 'veh', 'vida', 'plan', 'carga'].forEach((k) => {
      $('#pt-v-' + k)?.classList.toggle('on', k === v);
    });
    if (v !== 'veh' && v !== 'carga') ptCurVeh = null;
    const stage = $('#parts-ui')?.closest('section') || document.scrollingElement;
    if (stage && stage.scrollTo) stage.scrollTo(0, 0);
    window.scrollTo(0, 0);
  }

  function ptSetTab(v) {
    if (v === 'estado') { ptRenderAll(); ptShowView('estado'); }
    else if (v === 'vida') renderPartsVida();
    else if (v === 'plan') renderPartsPlan();
  }

  // ====================================================================
  // Eventos (delegados: las vistas se repintan enteras)
  // ====================================================================

  document.addEventListener('click', async (e) => {
    if (!e.target.closest('#parts-ui')) return;

    const tab = e.target.closest('[data-v]');
    if (tab && tab.closest('.seg')) { ptSetTab(tab.dataset.v); return; }

    const vc = e.target.closest('[data-pt-veh]');
    if (vc) { renderPartsVehicle(vc.dataset.ptVeh); return; }

    if (e.target.closest('[data-pt-back]')) { ptRenderAll(); ptShowView('estado'); return; }

    const bv = e.target.closest('[data-pt-back-veh]');
    if (bv) { renderPartsVehicle(bv.dataset.ptBackVeh); return; }

    const carga = e.target.closest('[data-pt-carga]');
    if (carga) { renderPartsBaseline(carga.dataset.ptCarga); return; }

    const sb = e.target.closest('[data-pt-save-baseline]');
    if (sb) { await ptSaveBaseline(sb.dataset.ptSaveBaseline); return; }

    const reg = e.target.closest('[data-pt-reg]');
    if (reg) { const [vid, code] = reg.dataset.ptReg.split('|'); ptOpenDrawer(vid, code); return; }

    if (e.target.closest('#pt-open-reg')) { ptOpenDrawer(ptCurVeh, null); return; }
    if (e.target.closest('[data-pt-close]')) { ptCloseDrawer(); return; }
    if (e.target.closest('#pt-f-save')) { await ptSaveChange(); return; }

    const qb = e.target.closest('#pt-filter button');
    if (qb) {
      ptFilter = qb.dataset.f;
      $$('#pt-filter button').forEach((b) => b.classList.toggle('on', b === qb));
      ptRenderQueue();
      return;
    }

    // Confirmar / rechazar lo que reportó un conductor.
    const conf = e.target.closest('[data-pt-conf]');
    if (conf) {
      try { await API.confirmPartChange(conf.dataset.ptConf, true); await ptReload(); toast('Cambio confirmado · el semáforo vuelve a cero.'); }
      catch (err) { toast(ptErr(err)); }
      return;
    }
    const rej = e.target.closest('[data-pt-rej]');
    if (rej) {
      if (!confirm('¿Rechazar este reporte? No moverá el semáforo.')) return;
      try { await API.confirmPartChange(rej.dataset.ptRej, false); await ptReload(); toast('Reporte rechazado.'); }
      catch (err) { toast(ptErr(err)); }
      return;
    }

    // Ajustar el intervalo con lo que dice la vida real. Nunca se aplica solo.
    const adj = e.target.closest('[data-pt-adj]');
    if (adj) {
      const [code, km] = adj.dataset.ptAdj.split('|');
      const p = ptCatalog.find((x) => x.code === code);
      if (!confirm(`Cambiar el intervalo de ${p.name} de ${ptFmt(p.interval_km)} km a ${ptFmt(+km)} km para toda la flota?`)) return;
      try { await API.setPartInterval(code, +km, null); await ptReload(); renderPartsVida(); toast(`Intervalo de ${p.name.toLowerCase()} ajustado a ${ptFmt(+km)} km con datos propios.`); }
      catch (err) { toast(ptErr(err)); }
      return;
    }

    const ei = e.target.closest('[data-pt-editint]');
    if (ei) {
      const p = ptCatalog.find((x) => x.code === ei.dataset.ptEditint);
      const val = prompt(`Nuevo intervalo para ${p.name} (km), aplica a toda la flota:`, p.interval_km);
      const n = ptNum(val);
      if (!n || n < 500) return;
      try { await API.setPartInterval(p.code, n, null); await ptReload(); renderPartsPlan(); toast(`${p.name}: intervalo ${ptFmt(n)} km.`); }
      catch (err) { toast(ptErr(err)); }
      return;
    }

    const odo = e.target.closest('[data-pt-odo]');
    if (odo) {
      const vid = odo.dataset.ptOdo;
      const cur = ptByVeh(vid)[0]?.current_km;
      const val = prompt(`Odómetro real del carro (km). El actual salió de la inspección de inicio de turno:`, cur);
      const n = ptNum(val);
      if (!n) return;
      const reason = prompt('¿Por qué se corrige? Queda en el registro:', 'Corrección de digitación') || null;
      try { await API.correctVehicleOdometer(vid, n, reason); await ptReload(); renderPartsVehicle(vid); toast(`Odómetro corregido a ${ptFmt(n)} km.`); }
      catch (err) { toast(ptErr(err)); }
    }
  });

  // El cálculo de duración se refresca mientras se escribe.
  document.addEventListener('input', (e) => {
    if (e.target.closest('#pt-f-km')) ptCalc();
  });
  document.addEventListener('change', (e) => {
    if (!e.target.closest('#parts-drawer-root')) return;
    if (e.target.id === 'pt-f-veh') {
      const v = ptVehicles.find((x) => x.id === e.target.value);
      if (v) $('#pt-f-km').value = ptFmt(v.current_km);
    }
    if (e.target.id === 'pt-f-veh' || e.target.id === 'pt-f-part') ptCalc();
  });
