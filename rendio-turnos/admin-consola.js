// admin-consola.js — Admin: Consola (hub por capas) + sidebar de navegación del admin.
// Porteado de feat/rutas-consola (2026-07-10) a la estructura modular; lógica intacta.
// Comparte scope global; el orden de carga está en index.html.
  // ════════════════════════════════════════════════════════════════════
  // RUTAS DE AUXILIARES — Consola (hub por capas) + Asignación (planeación)
  // Visual portada de los previews del UX. Datos: solo reales (sin fallback demo).
  // ════════════════════════════════════════════════════════════════════

  const rtIni = (n) => { const p = (n || '').trim().split(/\s+/); return ((p[0] || '')[0] + ((p[1] || p[0] || '')[0] || '')).toUpperCase(); };
  const rtToMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const rtToHM = (m) => { m = Math.round(m); const h = Math.floor(m / 60) % 24; const mm = ((m % 60) + 60) % 60; return String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0'); };

  // ---------------- CONSOLA (hub por capas) ----------------
  const CN_DATA = {
    turnos: {
      label: 'Turnos', tag: 'turnos',
      sub: 'Gestión de jornadas de los conductores: planear la semana, atender solicitudes y revisar el equipo.',
      groups: [
        { id: 'plan', name: 'Planeación', icon: 'g-plan', desc: 'Armar la semana', items: [
          { id: 'horario', name: 'Horario', icon: 'm-horario', desc: 'Tablero de turnos: arma la semana arrastrando conductores a las franjas.', tab: 'schedule' },
          { id: 'disp', name: 'Disponibilidad', icon: 'm-disp', desc: 'Grilla AM/PM: quién puede trabajar y quién pidió descanso.', tab: 'availability' },
        ] },
        { id: 'review', name: 'Revisión', icon: 'g-review', desc: 'Bandejas que piden tu acción', items: [
          { id: 'solic', name: 'Solicitudes', icon: 'm-solic', desc: 'Aprobar o rechazar descansos pedidos, por franja.', tab: 'approvals' },
          { id: 'insp', name: 'Inspecciones', icon: 'm-insp', desc: 'Revisar inspecciones de inicio de turno con novedad.', tab: 'inspections' },
          { id: 'shifts', name: 'Turnos activos', icon: 'm-insp', desc: 'Turnos en curso; forzar cierre si quedó colgado.', tab: 'shifts' },
        ] },
        { id: 'team', name: 'Equipo', icon: 'g-team', desc: 'Personas y motivación', items: [
          { id: 'personal', name: 'Personal', icon: 'm-personal', desc: 'Conductores y admins: estado, strikes, coordinación.', tab: 'workers' },
          { id: 'recomp', name: 'Recompensas', icon: 'm-recomp', desc: 'Premios por kilometraje y solicitudes de redención.', tab: 'rewards' },
        ] },
        { id: 'data', name: 'Análisis', icon: 'g-data', desc: 'Reportes', items: [
          { id: 'balance', name: 'Balance', icon: 'm-balance', desc: 'Informe de turnos por persona, horas y CSV.', tab: 'balance' },
        ] },
        { id: 'cfg', name: 'Configuración', icon: 'g-cfg', desc: 'Parámetros', items: [
          { id: 'ajustes', name: 'Ajustes', icon: 'm-ajustes', desc: 'Cupos, antigüedad, descansos fijos y alta de conductor.', tab: 'settings' },
        ] },
      ]
    },
    rutas: {
      label: 'Rutas', tag: 'rutas',
      sub: 'Transporte de auxiliares entre casa y el aeropuerto MDE: planear rutas óptimas y monitorear que nunca lleguen tarde.',
      groups: [
        { id: 'plan', name: 'Planeación', icon: 'g-plan', desc: 'Armar las rutas del día', items: [
          { id: 'asign', name: 'Asignación', icon: 'm-asign', desc: 'Optimizar reservas en rutas para 2–3 carros, con semáforo de holgura vs. deadline.', star: true, tab: 'routes' },
          { id: 'reservas', name: 'Reservas', icon: 'm-reservas', desc: 'Tabla de traslados: detalle, pernocta, calificaciones y cancelar si se cae un vuelo.', tab: 'reservas' },
          { id: 'vuelos', name: 'Vuelos', icon: 'm-vuelos', desc: 'Agenda de vuelos: el origen del dato de toda la planeación.', soon: 'build' },
        ] },
        { id: 'ops', name: 'Operación', icon: 'g-ops', desc: 'Monitoreo en vivo', items: [
          { id: 'oper', name: 'Operación', icon: 'm-oper', desc: 'Carros en el mapa en tiempo real y alerta de atraso antes de que ocurra.', star: true, tab: 'oper' },
          { id: 'flota', name: 'Flota', icon: 'm-flota', desc: 'Vehículos disponibles, capacidad y mantenimiento.', soon: 'build' },
        ] },
        { id: 'team', name: 'Equipo', icon: 'g-team', desc: 'Personas', items: [
          { id: 'personas', name: 'Personas', icon: 'm-personas', desc: 'Auxiliares y sus datos de recogida.', soon: 'build' },
        ] },
        { id: 'data', name: 'Análisis', icon: 'g-data', desc: 'Reportes', items: [
          { id: 'metricas', name: 'Métricas', icon: 'm-metricas', desc: 'Rutas a tiempo, km y ocupación de carros.', soon: 'build' },
        ] },
      ]
    }
  };
  let cnWs = 'turnos';
  let cnBound = false;
  let sideBound = false;

  // Los badges del sidebar reusan los IDs que esperan las funciones de refresco
  // existentes (refreshPendingBadge/refreshInspectionsBadge/refreshShiftsBadge),
  // así no hay que duplicar lógica de conteo.
  const SIDEBAR_BADGE_IDS = { approvals: 'pending-badge', inspections: 'inspections-badge', shifts: 'shifts-badge', settings: 'oil-badge' };

  // Busca el módulo (y su espacio) por su tab. Devuelve {ws, group, item} o null.
  function findModuleByTab(tab) {
    for (const ws of Object.keys(CN_DATA)) {
      for (const g of CN_DATA[ws].groups) {
        const item = g.items.find(it => it.tab === tab);
        if (item) return { ws, group: g, item };
      }
    }
    return null;
  }

  // Pinta la navegación por grupos del sidebar para el espacio activo (cnWs).
  function renderAdminSidebar() {
    const snav = $('#adm-snav');
    if (!snav) return;
    const d = CN_DATA[cnWs];
    $$('#adm-wstabs button').forEach(b => b.classList.toggle('on', b.dataset.ws === cnWs));
    snav.innerHTML = d.groups.map(g => `
      <div class="grp">
        <div class="grp-h"><svg class="gi"><use href="#${g.icon}"/></svg><span class="gtext">${g.name}</span></div>
        ${g.items.map(it => {
          if (it.soon) {
            return `<button class="nav-i dim" data-tip="${it.name}" disabled>
              <svg class="ni-ic"><use href="#${it.icon}"/></svg>
              <span class="ni-tx">${it.name}</span><span class="soon">Pronto</span>
            </button>`;
          }
          const bid = SIDEBAR_BADGE_IDS[it.tab];
          // El badge de Ajustes es una alerta "!" (aceite pendiente), no un contador.
          const badge = bid ? `<span class="badge hidden" id="${bid}">${bid === 'oil-badge' ? '!' : '0'}</span>` : '';
          return `<button class="nav-i" data-mod="${it.tab}" data-tip="${it.name}">
            <svg class="ni-ic"><use href="#${it.icon}"/></svg>
            <span class="ni-tx">${it.name}</span>${badge}
          </button>`;
        }).join('')}
      </div>`).join('');
    markSidebarActive();
    refreshSidebarBadges();
  }

  // Marca el módulo activo en el sidebar.
  function markSidebarActive() {
    $$('#adm-snav .nav-i').forEach(n => n.classList.toggle('active', n.dataset.mod === state.activeTab));
  }

  // Repuebla los badges (las funciones existentes ya saben de dónde sacar el dato).
  function refreshSidebarBadges() {
    try { refreshPendingBadge(); } catch (e) {}
    try { refreshInspectionsBadge(); } catch (e) {}
    try { refreshShiftsBadge(); } catch (e) {}
    try { refreshOilBadge(); } catch (e) {}
  }

  // Actualiza el breadcrumb (Espacio / Módulo) de la barra superior.
  function updateBreadcrumb(tab) {
    const wsEl = $('#adm-cb-ws'), tEl = $('#adm-cb-title');
    if (!wsEl || !tEl) return;
    if (tab === 'consola') { wsEl.textContent = CN_DATA[cnWs].label; tEl.textContent = 'Consola'; return; }
    const found = findModuleByTab(tab);
    if (found) { wsEl.textContent = CN_DATA[found.ws].label; tEl.textContent = found.item.name; }
  }

  // Listeners del sidebar (una sola vez).
  function bindAdminSidebar() {
    if (sideBound) return;
    const side = $('#admin-side');
    if (!side) return;
    sideBound = true;
    side.addEventListener('click', (e) => {
      const ws = e.target.closest('#adm-wstabs button');
      if (ws) { if (ws.dataset.ws !== cnWs) { cnWs = ws.dataset.ws; renderAdminSidebar(); setTab('consola'); } return; }
      const home = e.target.closest('[data-cnmod]');
      if (home) { setTab('consola'); closeAdminDrawer(); return; }
      const ni = e.target.closest('.nav-i[data-mod]');
      if (ni) { setTab(ni.dataset.mod); closeAdminDrawer(); return; }
    });
    $('#adm-collapse')?.addEventListener('click', () => $('#app-shell').classList.toggle('collapsed'));
    $('#adm-logout')?.addEventListener('click', onLogout);
    $('#adm-logout-top')?.addEventListener('click', onLogout);
    $('#adm-mobmenu')?.addEventListener('click', () => openAdminDrawer());
    $('#admin-side-scrim')?.addEventListener('click', () => closeAdminDrawer());
  }
  function openAdminDrawer() { $('#app-shell')?.classList.add('side-open'); $('#admin-side-scrim')?.classList.remove('hidden'); }
  function closeAdminDrawer() { $('#app-shell')?.classList.remove('side-open'); $('#admin-side-scrim')?.classList.add('hidden'); }

  function renderConsola() {
    const d = CN_DATA[cnWs];
    let total = 0;
    d.groups.forEach(g => g.items.forEach(() => total++));
    $('#cn-title').innerHTML = `${d.label} <span class="wtag ${d.tag}">${total} módulos</span>`;
    $('#cn-sub').textContent = d.sub;
    $$('#cn-wsw button').forEach(b => b.classList.toggle('on', b.dataset.ws === cnWs));
    $('#cn-groups').innerHTML = d.groups.map(g => `
      <div class="gsec">
        <div class="gsec-h"><svg class="gi"><use href="#${g.icon}"/></svg><h2>${g.name}</h2><span class="gcount">${g.items.length}</span><span class="rule"></span><span class="gdesc">${g.desc}</span></div>
        <div class="cards">
          ${g.items.map(it => {
            if (it.soon) {
              return `<div class="mcard soon">
                <div class="mc-top"><span class="mc-ic"><svg class="icon"><use href="#${it.icon}"/></svg></span><span class="mc-name">${it.name}</span></div>
                <div class="mc-desc">${it.desc}</div>
                <div class="mc-foot soonf"><span class="tagsoon">Por construir</span></div>
              </div>`;
            }
            return `<button class="mcard" data-cnmod="${it.tab}">
              <div class="mc-top"><span class="mc-ic"><svg class="icon"><use href="#${it.icon}"/></svg></span><span class="mc-name">${it.name}</span>${it.star ? '<span class="star" title="Pieza central"><svg class="icon" style="width:16px;height:16px"><use href="#m-asign"/></svg></span>' : ''}</div>
              <div class="mc-desc">${it.desc}</div>
              <div class="mc-foot go">Abrir<svg class="icon"><use href="#i-go"/></svg></div>
            </button>`;
          }).join('')}
        </div>
      </div>`).join('');
    bindConsolaOnce();
  }

  function bindConsolaOnce() {
    if (cnBound) return;
    const root = $('#consola-ui');
    if (!root) return;
    cnBound = true;
    root.addEventListener('click', (e) => {
      const ws = e.target.closest('#cn-wsw button');
      if (ws) { cnWs = ws.dataset.ws; renderConsola(); return; }
      const mod = e.target.closest('[data-cnmod]');
      if (mod) { setTab(mod.dataset.cnmod); return; }
    });
  }

