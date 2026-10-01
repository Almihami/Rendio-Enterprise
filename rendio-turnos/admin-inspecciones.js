// admin-inspecciones.js — Admin: inspecciones (cola con filtros de fecha/conductor/carro, detalle, checklist configurable, novedades).
// Extraído de app.js (split mecánico 2026-07-10, sin cambios de lógica).
// Comparte scope global con los demás módulos; el orden de carga está en index.html.
  // ====================================================================
  // Inspecciones (admin) — revisión/aprobación + checklist configurable
  // ====================================================================
  // items = la cola SIN filtros (las 300 más recientes): de ahí salen el conteo
  // del encabezado y el badge de la pestaña. fItems = lo que trajo el servidor con
  // los filtros de fecha/conductor/carro (null = sin filtros o sin respuesta aún).
  const inspState = { items: [], fItems: null, filter: 'pending', current: null, checklist: [], vehicles: [], autoVehicleId: null, autoItems: [], autoItemsFor: null, autoLoadingFor: null, colaY: 0, adminPhoto: null,
    novItems: [], novFilter: 'open', novCurrent: null, openIncidents: 0 };
  const INSP_SEV = {
    leve:  { cls: 'leve',  label: 'Leve',  text: 'Leve · informativo',       color: 'var(--green)' },
    media: { cls: 'media', label: 'Media', text: 'Media · con cuidado',       color: 'var(--amber)' },
    grave: { cls: 'grave', label: 'Grave', text: 'Grave · requiere atención', color: 'var(--red)' },
  };
  const INSP_ST = { pending: ['pend', 'Pendiente', 'i-warn'], approved: ['appr', 'Aprobada', 'i-check'], rejected: ['rej', 'Rechazada', 'i-x'] };
  const PHOTO_LABELS = { front: 'Frontal', rear: 'Trasera', left: 'Lat. izq.', right: 'Lat. der.', dashboard: 'Tablero', glovebox: 'Guantera', property_card: 'Tarjeta prop.', door_left: 'Puerta cond.', door_right: 'Puerta pas.', road_kit: 'Kit carretera', spare_tire: 'Llanta rep.', damage: 'Golpe/daño', extra: 'Adicional' };
  // Mismo orden que el wizard del conductor (shift-flow.js PHOTO_SLOTS): el admin
  // las revisa en el orden en que el conductor las tomó.
  const PHOTO_ORDER = ['front', 'rear', 'left', 'right', 'dashboard', 'glovebox', 'property_card', 'door_left', 'door_right', 'road_kit', 'spare_tire'];

  // ---------- Filtros de la cola: fecha (un día o rango), conductor y carro ----------
  // Pedido del jefe (29-sep-2026): «filtrar por días, por nombre y por carro», y
  // la fecha también por rango. Se combinan con las pestañas de estado.
  //
  // VAN AL SERVIDOR, no al cliente: la cola trae solo las 300 inspecciones más
  // recientes (con 2 carros y dos turnos al día son unos dos meses y medio), así
  // que filtrar lo ya cargado dejaría vacía cualquier fecha más vieja sin que lo
  // estuviera. Mientras llega la respuesta se muestra, de forma provisional, lo que
  // ya hay en memoria y cumple; el contador dice «Buscando…» hasta que llega.
  //
  // El buscador de conductor no distingue tildes ni mayúsculas: el nombre se cruza
  // aquí contra la lista de conductores y al servidor van sus ids.
  //
  // Todo vive dentro de este IIFE y se cuelga de inspState: este archivo comparte
  // el ámbito global con otros treinta y no se le suman nombres.
  inspState.filtros = (() => {
    const TOPE = 300;                 // filas por consulta de la cola (con y sin filtros)
    const st = { modo: 'dia', dia: '', desde: '', hasta: '', q: '', vehicleId: '' };
    const F = { TOPE, st, cargando: false, error: false, sinConductor: false, flotaError: false };
    const FMT_DIA = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' });
    // Solo cuenta una fecha con año de verdad (19xx o 20xx). Chrome de escritorio
    // dispara `change` en CADA tecla del año: al teclear 2026 el campo pasa por
    // 0002-…, 0020-… y 0202-… antes de llegar. Esos intermedios no son una fecha
    // que el admin quiso: se ignoran (ni consulta ni se toca lo que va escribiendo).
    const esFecha = (s) => /^(19|20)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(s || '');
    // Día de Bogotá de un instante: una inspección de las 11 p. m. es de ese día,
    // aunque en UTC ya sea el siguiente.
    const diaBog = (iso) => { try { return FMT_DIA.format(new Date(iso)); } catch (e) { return ''; } };
    const diaSig = (d) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd + 1)).toISOString().slice(0, 10); };
    const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
    const tokens = () => norm(st.q).split(' ').filter(Boolean);
    // Cada palabra escrita tiene que estar en el nombre: «juan echa» → Juan Echavarría.
    const nombreCoincide = (nombre, tk) => { const n = norm(nombre); return tk.every(t => n.includes(t)); };

    // [desde, hasta] en días de Bogotá, ambos incluidos; null = sin fecha.
    // Rango al revés (desde después de hasta): se ordena AQUÍ, no se castiga. Los
    // campos se quedan como el admin los escribió: voltearlos en cada `change` le
    // pisaba el campo mientras tecleaba (ver esFecha).
    function rango() {
      let a = st.modo === 'dia' ? st.dia : st.desde;
      let b = st.modo === 'dia' ? st.dia : st.hasta;
      if (a && b && a > b) { const t = a; a = b; b = t; }
      return (a || b) ? { desde: a || null, hasta: b || null } : null;
    }
    const activo = () => !!(rango() || tokens().length || st.vehicleId);
    F.activo = activo;
    // La misma regla que aplica el servidor, del lado del cliente: para lo
    // provisional, para «Autos» (que ya trae todo el carro) y como red.
    F.coincide = (it) => {
      const r = rango();
      if (r) {
        const d = diaBog(it.performed_at);
        if (!d || (r.desde && d < r.desde) || (r.hasta && d > r.hasta)) return false;
      }
      if (st.vehicleId && it.vehicle_id !== st.vehicleId) return false;
      const tk = tokens();
      return !tk.length || nombreCoincide(inspDriverName(it), tk);
    };
    // Sobre qué se cuenta y se lista: la cola entera o lo filtrado.
    F.base = () => {
      if (!activo()) return inspState.items;
      if (inspState.fItems && !F.cargando) return inspState.fItems.filter(F.coincide);
      return inspState.items.filter(F.coincide);
    };
    // ¿La base llegó al tope? Entonces puede haber más viejas que no se ven.
    F.topado = () => (activo() ? (inspState.fItems || []) : inspState.items).length >= TOPE;

    // ---- servidor ----
    let conductores = null;           // [{ id: driver_profiles.id, n: nombre normalizado }]
    let seq = 0, claveCargada = null, tq = null;
    const clave = () => JSON.stringify([rango(), tokens(), st.vehicleId]);
    async function idsConductor(tk) {
      if (!conductores) conductores = (await Api.listInspectionDrivers()).map(d => ({ id: d.id, n: norm(d.name) }));
      return conductores.filter(d => tk.every(t => d.n.includes(t))).map(d => d.id);
    }
    // Trae del servidor lo que cumple los filtros. `forzar` = volver a pedirlo
    // aunque los filtros no hayan cambiado (al entrar a la pestaña).
    F.cargar = async (forzar) => {
      const mio = ++seq;
      if (!activo()) { inspState.fItems = null; claveCargada = null; F.cargando = F.error = F.sinConductor = false; return; }
      const k = clave();
      // Lo que hay ya es de estos mismos filtros (p. ej. se volvió al rango de
      // antes mientras otra búsqueda iba en camino: esa ya no se pinta).
      if (!forzar && k === claveCargada && inspState.fItems && !F.error) { F.cargando = false; return; }
      // Al entrar a la pestaña también se refresca la lista de conductores (pudo
      // llegar uno nuevo desde la última vez).
      if (forzar) conductores = null;
      F.cargando = true; F.error = false;
      try {
        const r = rango(), tk = tokens();
        const p = { limite: TOPE };
        if (r && r.desde) p.desde = r.desde + 'T00:00:00-05:00';
        if (r && r.hasta) p.hasta = diaSig(r.hasta) + 'T00:00:00-05:00';   // exclusivo: el día siguiente
        if (st.vehicleId) p.vehicleId = st.vehicleId;
        let sinConductor = false;
        if (tk.length) { p.driverIds = await idsConductor(tk); sinConductor = !p.driverIds.length; }
        const rows = await Api.listInspectionsForReview(null, p);
        if (mio !== seq) return;      // llegó tarde: ya hay otra búsqueda en curso
        inspState.fItems = rows; claveCargada = k; F.sinConductor = sinConductor;
      } catch (e) {
        if (mio !== seq) return;
        console.error(e);
        inspState.fItems = null; claveCargada = null; F.error = true;
      }
      F.cargando = false;
    };
    // Tras un cambio de filtro: pinta ya lo provisional y, al llegar la respuesta,
    // lo definitivo. En «Autos» la lista es del carro entero (ya en memoria o la
    // pide renderAutosView), así que basta con repintarla una vez.
    async function aplicar() {
      F.pintarBarra();
      const p = F.cargar(false);
      renderInspList(true);
      await p;
      if (inspState.filter !== 'autos') renderInspList(true);
      else F.pintarConteos();
    }
    // Los números de las pestañas de estado: de lo filtrado si hay filtros.
    F.pintarConteos = () => {
      const c = inspCounts(F.base());
      $$('#insp-filter .n').forEach(n => { n.textContent = c[n.dataset.c] != null ? c[n.dataset.c] : 0; });
    };

    // ---- barra ----
    // Los dados de baja van aparte, al final: sus inspecciones viejas siguen en
    // la cola y también tienen que poder filtrarse por carro.
    const opcionesCarro = () => {
      const vs = inspState.vehicles || [];
      const op = (v) => `<option value="${escapeHtml(v.id)}">${escapeHtml(v.internal_code || v.license_plate || 'Carro')}${v.license_plate && v.internal_code ? ' · ' + escapeHtml(v.license_plate) : ''}</option>`;
      const baja = vs.filter(v => v.deleted_at);
      return `<option value="">Todos los carros</option>${vs.filter(v => !v.deleted_at).map(op).join('')}`
        + (baja.length ? `<optgroup label="Dados de baja">${baja.map(op).join('')}</optgroup>` : '')
        + (F.flotaError ? '<option value="" disabled>No se pudo cargar la flota</option>' : '');
    };
    // La barra se arma UNA vez debajo de las pestañas y no se vuelve a escribir:
    // así no pierde el foco ni lo tecleado, y sobrevive a ir y volver del detalle.
    F.montar = () => {
      if ($('#insp-flt')) return;
      const seg = $('#insp-filter');
      if (!seg) return;
      const bar = document.createElement('div');
      bar.className = 'iflt'; bar.id = 'insp-flt';
      bar.innerHTML = `
        <div class="f ffecha">
          <label>Fecha</label>
          <div class="fdate">
            <div class="seg" id="insp-fmodo" role="group" aria-label="Filtrar por"><button type="button" data-fm="dia" class="on">Un día</button><button type="button" data-fm="rango">Rango</button></div>
            <input class="inp" type="date" data-if="dia" aria-label="Día">
            <input class="inp hidden" type="date" data-if="desde" aria-label="Desde">
            <span class="fa hidden">a</span>
            <input class="inp hidden" type="date" data-if="hasta" aria-label="Hasta">
          </div>
        </div>
        <div class="f"><label for="insp-fq">Conductor</label><div class="isearch"><svg class="icon"><use href="#i-search"/></svg><input id="insp-fq" data-if="q" type="search" placeholder="Buscar conductor…" autocomplete="off"></div></div>
        <div class="f"><label for="insp-fcarro">Carro</label><select class="inp" id="insp-fcarro" data-if="carro">${opcionesCarro()}</select></div>
        <div class="sp"></div>
        <div class="ict" id="insp-fct" aria-live="polite"></div>
        <button type="button" class="btn ghost sm" id="insp-flimpiar"><svg class="icon"><use href="#i-x"/></svg>Limpiar</button>`;
      seg.insertAdjacentElement('afterend', bar);
      F.pintarBarra();
      F.cargarFlota();
    };
    // Las placas del select salen de la flota de la organización, con los carros
    // dados de baja aparte. Si falla, el select lo dice y se reintenta al volver a entrar.
    F.cargarFlota = () => {
      if ((inspState.vehicles || []).length) return Promise.resolve();
      return Api.listInspectionVehicles()
        .then(vs => { inspState.vehicles = vs || []; F.flotaError = false; })
        .catch(e => { console.error(e); F.flotaError = true; })
        .then(() => { const sel = $('#insp-fcarro'); if (sel) { sel.innerHTML = opcionesCarro(); sel.value = st.vehicleId; } });
    };
    // Lleva el estado a la barra sin reescribirla. El campo que tiene el foco no
    // se toca: el admin lo está escribiendo (una respuesta que llega tarde o la
    // pausa del buscador no le pueden borrar el año a medio teclear). Al salir
    // del campo, onFocusOut lo pone al día.
    // `todo` = también el campo con foco (Limpiar: el admin pidió borrarlo todo).
    F.pintarBarra = (todo) => {
      const bar = $('#insp-flt'); if (!bar) return;
      bar.querySelectorAll('#insp-fmodo [data-fm]').forEach(b => b.classList.toggle('on', b.dataset.fm === st.modo));
      const rg = st.modo === 'rango';
      bar.querySelector('[data-if="dia"]').classList.toggle('hidden', rg);
      bar.querySelectorAll('[data-if="desde"], [data-if="hasta"], .fa').forEach(el => el.classList.toggle('hidden', !rg));
      const libre = (el) => todo || el !== document.activeElement;
      ['dia', 'desde', 'hasta'].forEach(k => { const el = bar.querySelector(`[data-if="${k}"]`); if (libre(el) && el.value !== st[k]) el.value = st[k]; });
      // min/max solo guían el calendario (no le cambian el valor al campo); st
      // solo guarda fechas de verdad, así que nunca quedan en el año 2. Se ponen
      // solo si cambian y nunca en el campo con foco: en Chrome tocar min/max
      // redibuja el campo y se lleva lo que iba a medio escribir.
      const hasta = bar.querySelector('[data-if="hasta"]'), desde = bar.querySelector('[data-if="desde"]');
      if (libre(hasta) && hasta.min !== st.desde) hasta.min = st.desde;
      if (libre(desde) && desde.max !== st.hasta) desde.max = st.hasta;
      const q = bar.querySelector('#insp-fq'); if (libre(q) && q.value !== st.q) q.value = st.q;
      const sel = bar.querySelector('#insp-fcarro'); if (sel.value !== st.vehicleId) sel.value = st.vehicleId;
      bar.querySelector('#insp-flimpiar').disabled = !activo();
    };
    // «N inspecciones»; n = null → buscando; n = '' → nada que contar.
    F.contador = (n, topado) => {
      const el = $('#insp-fct'); if (!el) return;
      if (n === null) { el.textContent = 'Buscando…'; return; }
      if (n === '') { el.textContent = ''; return; }
      el.innerHTML = `<b>${n}</b> ${n === 1 ? 'inspección' : 'inspecciones'}${topado ? `<span class="tope"> · entre las ${TOPE} más recientes</span>` : ''}`;
    };
    // Vacío con filtros: dice por qué y, si lo hay, dónde está lo que busca.
    F.vacioHtml = (enOtras) => {
      const p = F.sinConductor
        ? `Ningún conductor coincide con «${escapeHtml(st.q.trim())}».`
        : enOtras
          ? `Hay ${enOtras} en otras pestañas: mira en «Todas».`
          : 'Prueba con otras fechas, otro conductor u otro carro, o dale a «Limpiar».';
      return `<div class="empty"><div class="circle"><svg class="icon"><use href="#i-search"/></svg></div><h3>Nada con estos filtros</h3><p>${p}</p></div>`;
    };
    F.limpiar = () => {
      clearTimeout(tq);
      Object.assign(st, { dia: '', desde: '', hasta: '', q: '', vehicleId: '' });   // el modo se queda
      F.pintarBarra(true);
      aplicar();
    };

    // ---- eventos (los despacha bindInspections) ----
    F.onClick = (e) => {
      const m = e.target.closest('#insp-fmodo [data-fm]');
      if (m) {
        const modo = m.dataset.fm;
        if (modo === st.modo) return true;
        // Lo que ya eligió pasa de un modo al otro: el día se vuelve «del día al
        // día» y el rango, su primer día (ya ordenado, por si quedó al revés).
        const r = rango();
        if (modo === 'rango' && st.dia && !st.desde && !st.hasta) { st.desde = st.dia; st.hasta = st.dia; }
        if (modo === 'dia' && !st.dia && r) st.dia = r.desde || r.hasta;
        st.modo = modo;
        aplicar();
        return true;
      }
      if (e.target.closest('#insp-flimpiar')) { F.limpiar(); return true; }
      return false;
    };
    F.onChange = (e) => {
      const el = e.target, k = el && el.dataset && el.dataset.if;
      if (!k || !el.closest('#insp-flt')) return false;
      if (k === 'carro') st.vehicleId = el.value || '';
      else if (k === 'dia' || k === 'desde' || k === 'hasta') {
        // Se guarda TAL CUAL lo escribió: ni se voltea el par (eso lo hace rango())
        // ni se reescribe el otro campo. Vacío = quitó la fecha. Un año a medio
        // teclear (0002-…, 0020-…, 0202-…) no es fecha: no cambia nada y el campo
        // se queda como lo tiene el admin.
        const v = el.value || '';
        if (v && !esFecha(v)) return true;
        if (st[k] === v) return true;
        st[k] = v;
      } else return false;
      aplicar();
      return true;
    };
    // Al salir de un campo de fecha, lo que se ve tiene que ser lo que se aplica:
    // si quedó un año a medio teclear (0202-09-15), vuelve a la última fecha buena
    // (o a vacío). Mientras tenía el foco no se le tocaba (pintarBarra).
    F.onFocusOut = (e) => {
      const el = e.target, k = el && el.dataset && el.dataset.if;
      if (!(k === 'dia' || k === 'desde' || k === 'hasta') || !el.closest('#insp-flt')) return false;
      if (el.value !== st[k]) el.value = st[k];
      return true;
    };
    F.onInput = (e) => {
      const el = e.target;
      if (!el || el.id !== 'insp-fq') return false;
      st.q = el.value;
      clearTimeout(tq);
      tq = setTimeout(aplicar, 300);   // no una consulta por letra
      return true;
    };
    return F;
  })();

  // En el admin lo que se desplaza es #app-main (overflow-y:auto en styles.css,
  // .admin-shell), no la página: un window.scrollTo no lo mueve. Si algún día el
  // panel deja de tener scroll propio, se cae a la página.
  function inspScroller() {
    const m = document.getElementById('app-main');
    if (m && /auto|scroll/.test(getComputedStyle(m).overflowY)) return m;
    return document.scrollingElement || document.documentElement;
  }
  function inspShowView(v, y = 0) {
    $$('#inspections-ui .view').forEach(s => s.classList.toggle('on', s.id === 'insp-v-' + v));
    inspScroller().scrollTop = y;
  }
  // Dónde iba el admin en la cola, para devolverlo ahí al volver de una
  // inspección. Solo se anota si la cola es lo que está en pantalla.
  function inspRememberCola() {
    if ($('#insp-v-cola')?.classList.contains('on')) inspState.colaY = inspScroller().scrollTop;
  }
  // Volver a la cola donde estaba. La lista nunca sale del DOM (el detalle es
  // otra vista) y lo que el admin cambió aquí —aprobar/rechazar— ya está en
  // memoria, así que se repinta desde ahí sin volver a pedirla. Pedirla de nuevo
  // la dejaba en «Cargando…» mientras llegaba, el panel se quedaba sin contenido
  // y saltaba arriba: el admin que revisaba comprobantes perdía su lugar.
  // La cola se vuelve a pedir al servidor al entrar a la pestaña.
  function inspBackToCola() {
    bindInspections();
    if (!inspState.items.length) { renderInspections(); return; }
    renderInspList(true);
    inspShowView('cola', inspState.colaY || 0);
  }
  function inspChecklistOf(insp) {
    const c = insp && insp.checklist;
    return (c && Array.isArray(c.items)) ? c.items : [];
  }
  function inspSeverityOf(insp) {
    const c = insp && insp.checklist;
    return (c && c.severity) || 'media';
  }
  function inspFallas(insp) { return inspChecklistOf(insp).filter(i => i.result === 'issue').length; }
  function inspDriverName(insp) {
    return (insp.driver_profiles && insp.driver_profiles.profiles && insp.driver_profiles.profiles.full_name) || '—';
  }
  function inspDriverProfileId(insp) {
    return insp.driver_profiles && insp.driver_profiles.profiles && insp.driver_profiles.profiles.id;
  }
  function inspWhen(insp) {
    try {
      return new Date(insp.performed_at).toLocaleString('es-CO', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/Bogota' });
    } catch (e) { return ''; }
  }
  // Sin argumento cuenta la cola entera (encabezado y badge); con una lista,
  // esa lista (las pestañas cuando hay filtros).
  function inspCounts(list) {
    const arr = list || inspState.items;
    const c = { pending: 0, approved: 0, rejected: 0, all: arr.length };
    arr.forEach(i => { if (c[i.review_status] != null) c[i.review_status]++; });
    return c;
  }

  // El badge de la pestaña suma inspecciones pendientes + novedades ABIERTAS, para
  // que una novedad reportada sí llame la atención del admin (antes era invisible).
  async function refreshInspectionsBadge() {
    const b = $('#inspections-badge'); if (!b) return;
    try {
      const pend = inspState.items.length ? inspCounts().pending : (await Api.listInspectionsForReview('pending')).length;
      // 'flota' = solo lo del vehículo. Las eventualidades de traslado tienen su
      // propia bandeja y su propio badge; si no se filtrara, este contador se
      // llenaría de trancones y fallas de ruta que no se atienden desde aquí.
      let open = 0; try { open = await Api.countOpenIncidents('flota'); inspState.openIncidents = open; } catch (e) { /* */ }
      const n = pend + open;
      b.textContent = n; b.classList.toggle('hidden', !n);
    } catch (e) { /* */ }
  }

  async function renderInspections() {
    bindInspections();
    inspShowView('cola');
    const F = inspState.filtros;
    F.montar();
    if (F.flotaError) F.cargarFlota();
    const list = $('#insp-list');
    if (list) list.innerHTML = '<p style="color:var(--ink2);font-size:13px;padding:8px">Cargando…</p>';
    try {
      // Todas las iniciales (limpias + con novedad) y, si el admin dejó filtros
      // puestos, también lo filtrado: se vuelve a pedir, pudo llegar algo nuevo.
      const [items] = await Promise.all([Api.listInspectionsForReview(null, { limite: F.TOPE }), F.cargar(true)]);
      inspState.items = items;
    } catch (e) {
      console.error(e);
      if (list) list.innerHTML = '<p style="color:var(--red);font-size:13px;padding:8px">No se pudieron cargar las inspecciones.</p>';
      return;
    }
    try { inspState.openIncidents = await Api.countOpenIncidents('flota'); } catch (e) { /* */ }
    updateNovCount();
    renderInspList();
  }

  // Refresca el contador del botón "Novedades" (novedades abiertas).
  function updateNovCount() {
    const el = $('#insp-nov-ct'); if (!el) return;
    el.textContent = inspState.openIncidents || 0;
    el.classList.toggle('hidden', !inspState.openIncidents);
  }

  // ---------- Novedades reportadas (incidents) dentro de la pestaña Inspecciones ----------
  const NOV_ST = {
    open:        { label: 'Abierta',    color: 'var(--amber)', icon: 'i-warn' },
    in_progress: { label: 'En proceso', color: '#2563A8',      icon: 'i-clock' },
    resolved:    { label: 'Resuelta',   color: 'var(--green)', icon: 'i-check' },
  };
  const NOV_SEV = {
    low:    { label: 'Leve',  color: 'var(--green)' },
    medium: { label: 'Media', color: 'var(--amber)' },
    high:   { label: 'Grave', color: 'var(--red)' },
  };
  // Las llaves son los valores REALES del enum incident_category (0001 + 0062).
  // Antes había tres —`delay`, `accident`, `fuel`— que nunca existieron en la base:
  // no rompían nada porque abajo hay un fallback al nombre crudo, pero cualquier
  // categoría de verdad se veía en inglés y en snake_case.
  const NOV_CAT = {
    vehicle_problem: 'Problema del vehículo',
    cant_leave_on_time: 'No puede salir a tiempo',
    address_change: 'Cambio de dirección',
    wrong_address: 'Dirección equivocada',
    driver_late: 'Conductor demorado',
    flight_delay: 'Vuelo retrasado',
    flight_advanced: 'Vuelo adelantado',
    terminal_change: 'Cambio de terminal',
    missed_flight: 'Perdió el vuelo',
    traffic: 'Trancón',
    aux_not_responding: 'Tripulante no responde',
    aux_not_ready: 'Tripulante no estaba listo',
    aux_emergency: 'Emergencia del tripulante',
    late_booking: 'Reserva tardía',
    needs_third_vehicle: 'Necesita un tercer vehículo',
    other: 'Otra',
  };
  const novWhen = (iso) => { try { return new Date(iso).toLocaleString('es-CO', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/Bogota' }); } catch (e) { return ''; } };
  const novMediaPaths = (it) => Array.isArray(it.photo_paths) ? it.photo_paths.filter(p => typeof p === 'string') : [];
  const novIsVideo = (p) => /\.(mp4|mov|webm|m4v)$/i.test(p);

  async function renderNovedades() {
    bindInspections();
    inspShowView('novedades');
    renderNovShell();
    const list = $('#nov-list');
    if (list) list.innerHTML = '<p style="color:var(--ink2);font-size:13px;padding:8px">Cargando…</p>';
    try {
      inspState.novItems = await Api.listIncidents(null, 'flota');
    } catch (e) {
      console.error(e);
      if (list) list.innerHTML = '<p style="color:var(--red);font-size:13px;padding:8px">No se pudieron cargar las novedades.</p>';
      return;
    }
    inspState.openIncidents = inspState.novItems.filter(i => i.status === 'open').length;
    updateNovCount();
    renderNovList();
  }

  function renderNovShell() {
    const el = $('#insp-v-novedades'); if (!el) return;
    el.innerHTML = `
      <button class="back" data-nov-back><svg class="icon"><use href="#i-back"/></svg>Volver a inspecciones</button>
      <div class="phead">
        <div><h1>Novedades reportadas</h1><p>Lo que los conductores reportan al iniciar o cerrar el turno. Ábrelas para ver el detalle, la evidencia y marcar el seguimiento.</p></div>
      </div>
      <div class="seg" id="nov-filter">
        <button data-nf="open" class="on"><svg class="icon" style="width:13px;height:13px"><use href="#i-warn"/></svg>Abiertas <span class="n" data-nc="open">0</span></button>
        <button data-nf="in_progress">En proceso <span class="n" data-nc="in_progress">0</span></button>
        <button data-nf="resolved">Resueltas <span class="n" data-nc="resolved">0</span></button>
        <button data-nf="all">Todas <span class="n" data-nc="all">0</span></button>
      </div>
      <div id="nov-list"></div>`;
  }

  function renderNovList() {
    const items = inspState.novItems || [];
    const counts = { open: 0, in_progress: 0, resolved: 0, all: items.length };
    items.forEach(i => { if (counts[i.status] != null) counts[i.status]++; });
    $$('#nov-filter .n').forEach(n => { n.textContent = counts[n.dataset.nc] != null ? counts[n.dataset.nc] : 0; });
    $$('#nov-filter button').forEach(b => b.classList.toggle('on', b.dataset.nf === inspState.novFilter));
    const shown = items.filter(it => inspState.novFilter === 'all' ? true : it.status === inspState.novFilter);
    const list = $('#nov-list'); if (!list) return;
    list.innerHTML = shown.length ? shown.map(novCardHtml).join('')
      : `<div class="empty"><div class="circle"><svg class="icon"><use href="#i-check"/></svg></div><h3>Nada por aquí</h3><p>No hay novedades en este filtro.</p></div>`;
  }

  function novCardHtml(it) {
    const sev = NOV_SEV[it.severity] || NOV_SEV.medium;
    const stm = NOV_ST[it.status] || NOV_ST.open;
    const v = it.vehicles || {};
    const veh = `${escapeHtml(v.internal_code || '—')}${v.license_plate ? ' · ' + escapeHtml(v.license_plate) : ''}`;
    const who = (it.reporter && it.reporter.full_name) || '—';
    const nMedia = novMediaPaths(it).length;
    return `<div class="icard ${it.status === 'open' && it.severity === 'high' ? 'grave' : ''}">
      <span class="avt" style="background:${colorOfId(it.id)}">${escapeHtml(initialsOf(who))}</span>
      <div class="who"><b>${escapeHtml(who)}</b>
        <div class="sub"><span class="veh">${veh}</span> <span class="when"><svg class="icon" style="width:12px;height:12px"><use href="#i-clock"/></svg>${escapeHtml(novWhen(it.created_at))}</span></div>
        <div class="novdesc">${escapeHtml(it.description || '')}</div>
      </div>
      <div class="right">
        <div class="chips">
          <span class="chip" style="color:${sev.color}"><svg><use href="#i-warn"/></svg>${sev.label}</span>
          ${nMedia ? `<span class="chip"><svg><use href="#i-cam"/></svg>${nMedia}</span>` : ''}
        </div>
        <div class="qactions"><span class="chip" style="color:${stm.color};font-weight:700"><svg><use href="#${stm.icon}"/></svg>${stm.label}</span><button class="btn dark sm" data-nov-open="${it.id}">Ver <svg class="icon" style="width:14px;height:14px"><use href="#i-chev"/></svg></button></div>
      </div>
    </div>`;
  }

  async function openNovedadDetail(id) {
    const it = (inspState.novItems || []).find(x => x.id === id);
    if (!it) return;
    inspState.novCurrent = it;
    inspShowView('novedades');
    const el = $('#insp-v-novedades');
    if (el) el.innerHTML = `<button class="back" data-nov-list><svg class="icon"><use href="#i-back"/></svg>Volver a novedades</button><div class="card"><p style="color:var(--ink2);font-size:13px">Cargando evidencia…</p></div>`;
    let urls = {};
    const paths = novMediaPaths(it);
    if (paths.length) { try { urls = await Api.signedInspectionPhotoUrls(paths); } catch (e) { console.error(e); } }
    renderNovedadDetail(it, urls);
  }

  function renderNovedadDetail(it, urls) {
    const el = $('#insp-v-novedades'); if (!el) return;
    const sev = NOV_SEV[it.severity] || NOV_SEV.medium;
    const stm = NOV_ST[it.status] || NOV_ST.open;
    const v = it.vehicles || {};
    const who = (it.reporter && it.reporter.full_name) || '—';
    const paths = novMediaPaths(it);
    const mediaHtml = paths.length ? paths.map(p => {
      const url = urls[p];
      if (!url) return `<div class="photo"><svg class="icon"><use href="#i-cam"/></svg><span class="plabel">Evidencia</span></div>`;
      if (novIsVideo(p)) return `<div class="photo" style="cursor:default"><video src="${url}" controls preload="metadata" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;background:#000"></video><span class="plabel">Video</span></div>`;
      return `<div class="photo" data-insp-photo="${url}"><img src="${url}" alt="Evidencia"><span class="plabel">Foto</span></div>`;
    }).join('') : '<p style="color:var(--ink2);font-size:13px">Sin evidencia adjunta.</p>';
    const fmtDT = (s) => { try { return new Date(s).toLocaleString('es-CO', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/Bogota' }); } catch (e) { return ''; } };
    const actions = it.status === 'resolved'
      ? `<div class="abar" style="margin-top:12px"><button class="btn ghost" data-nov-status="open"><svg class="icon"><use href="#i-back"/></svg>Reabrir novedad</button></div>`
      : `<label>Nota de resolución (opcional)</label>
         <textarea id="nov-resolve-note" placeholder="Ej: Se revisó el golpe, autorizado para operar. / Enviado a taller.">${escapeHtml(it.resolution_notes || '')}</textarea>
         <div class="abar" style="margin-top:12px">
           ${it.status === 'open' ? '<button class="btn ghost" data-nov-status="in_progress"><svg class="icon"><use href="#i-clock"/></svg>Marcar en proceso</button>' : ''}
           <button class="rbtn ok" data-nov-status="resolved"><svg><use href="#i-check"/></svg>Marcar resuelta</button>
         </div>`;
    el.innerHTML = `
      <button class="back" data-nov-list><svg class="icon"><use href="#i-back"/></svg>Volver a novedades</button>
      <div class="card">
        <div class="dhead">
          <span class="avt" style="background:${colorOfId(it.id)}">${escapeHtml(initialsOf(who))}</span>
          <div class="grow">
            <h2>${escapeHtml(who)}</h2>
            <div class="who"><div class="sub"><span class="veh">${escapeHtml(v.internal_code || '—')}${v.license_plate ? ' · ' + escapeHtml(v.license_plate) : ''}</span> ${escapeHtml([v.brand, v.model].filter(Boolean).join(' '))} · ${escapeHtml(fmtDT(it.created_at))}</div></div>
          </div>
          <span class="chip" style="color:${sev.color}"><svg><use href="#i-warn"/></svg>${sev.label}</span>
          <span class="chip" style="color:${stm.color};font-weight:700"><svg><use href="#${stm.icon}"/></svg>${stm.label}</span>
        </div>
      </div>
      <div class="card" style="margin-top:16px">
        <h2><svg class="icon"><use href="#i-info"/></svg>Novedad</h2>
        <div class="kv"><span class="k">Tipo</span><span class="v">${escapeHtml(NOV_CAT[it.category] || it.category || '—')}</span></div>
        <div style="margin-top:12px"><div class="note">${escapeHtml(it.description || '—')}</div></div>
        ${it.resolved_at ? `<div class="kv" style="margin-top:10px"><span class="k">Resuelta</span><span class="v">${escapeHtml(fmtDT(it.resolved_at))}</span></div>` : ''}
        ${(it.resolution_notes && it.status === 'resolved') ? `<div style="margin-top:10px"><div class="note"><b>Resolución:</b> ${escapeHtml(it.resolution_notes)}</div></div>` : ''}
      </div>
      <div class="card" style="margin-top:16px">
        <h2><svg class="icon"><use href="#i-cam"/></svg>Evidencia</h2>
        <p class="csub">Fotos y videos que adjuntó el conductor. Toca una foto para ampliar.</p>
        <div class="pgrid">${mediaHtml}</div>
      </div>
      <div class="card" id="nov-decision" style="margin-top:16px">
        <h2>Seguimiento</h2>
        <p class="csub">Marca el avance de esta novedad para llevar control.</p>
        ${actions}
      </div>`;
  }

  async function novChangeStatus(id, status) {
    const it = (inspState.novItems || []).find(x => x.id === id) || inspState.novCurrent;
    let notes = null;
    if (status === 'resolved') { const t = $('#nov-resolve-note'); notes = t ? t.value.trim() : null; }
    try {
      await Api.updateIncidentStatus(id, status, notes);
      if (it) {
        it.status = status;
        it.resolved_at = status === 'resolved' ? new Date().toISOString() : null;
        if (status === 'resolved' && notes != null) it.resolution_notes = notes;
      }
      inspState.openIncidents = (inspState.novItems || []).filter(x => x.status === 'open').length;
      updateNovCount();
      toast(status === 'resolved' ? 'Novedad marcada como resuelta.' : status === 'in_progress' ? 'Novedad en proceso.' : 'Novedad reabierta.');
      openNovedadDetail(id);
    } catch (e) { console.error(e); toast('No se pudo actualizar la novedad.'); }
  }

  function renderInspList(fromCache) {
    const F = inspState.filtros;
    F.montar();
    // El encabezado y el badge son de la cola entera, haya o no filtros: lo
    // pendiente de verdad no cambia porque el admin mire un solo día.
    const counts = inspCounts();
    if ($('#insp-count')) $('#insp-count').textContent = counts.pending;
    const b = $('#inspections-badge'); if (b) { const n = counts.pending + (inspState.openIncidents || 0); b.textContent = n; b.classList.toggle('hidden', !n); }
    F.pintarConteos();
    F.pintarBarra();
    const autosBar = $('#insp-autos-bar');
    if (inspState.filter === 'autos') { renderAutosView(fromCache); return; }
    if (autosBar) autosBar.classList.add('hidden');
    const base = F.base();
    const shown = base.filter(it => inspState.filter === 'all' ? true : it.review_status === inspState.filter);
    const list = $('#insp-list');
    if (F.error) {
      list.innerHTML = '<p style="color:var(--red);font-size:13px;padding:8px">No se pudieron cargar las inspecciones con estos filtros.</p>';
      F.contador('');
      return;
    }
    if (!shown.length && F.cargando) {
      list.innerHTML = '<p style="color:var(--ink2);font-size:13px;padding:8px">Buscando…</p>';
      F.contador(null);
      return;
    }
    list.innerHTML = shown.length ? shown.map(inspCardHtml).join('')
      : F.activo() ? F.vacioHtml(base.length)
        : `<div class="empty"><div class="circle"><svg class="icon"><use href="#i-check"/></svg></div><h3>Nada por aquí</h3><p>No hay inspecciones en este filtro.</p></div>`;
    F.contador(F.cargando ? null : shown.length, F.topado());
  }

  // --- Filtro "Autos": todas las inspecciones de UN carro (también las de cierre
  // de turno, y sin el tope de 300). El carro se elige en «Carro» de la barra de
  // filtros —antes tenía un select propio aquí, que habría quedado repetido— y la
  // fecha y el conductor también se le aplican.
  function renderAutosView(fromCache) {
    const bar = $('#insp-autos-bar');
    if (bar) bar.classList.add('hidden');
    inspState.autoVehicleId = inspState.filtros.st.vehicleId || null;
    // De vuelta de una inspección (o si solo cambió la fecha o el nombre): lo de
    // ese carro ya está en memoria. Si ya se está pidiendo, no se pide dos veces.
    if (fromCache && inspState.autoVehicleId && inspState.autoItemsFor === inspState.autoVehicleId) { paintAutoList(); return; }
    if (fromCache && inspState.autoVehicleId && inspState.autoLoadingFor === inspState.autoVehicleId) return;
    loadAutoList();
  }

  async function loadAutoList() {
    const list = $('#insp-list');
    if (!list) return;
    if (!inspState.autoVehicleId) {
      list.innerHTML = `<div class="empty"><div class="circle"><svg class="icon"><use href="#i-list"/></svg></div><h3>Elige un carro</h3><p>Escoge uno en «Carro», arriba, para ver todas sus inspecciones.</p></div>`;
      inspState.filtros.contador('');
      return;
    }
    list.innerHTML = '<p style="color:var(--ink2);font-size:13px;padding:8px">Cargando…</p>';
    inspState.filtros.contador(null);
    const vid = inspState.autoVehicleId;
    inspState.autoLoadingFor = vid;
    let rows;
    try { rows = await Api.listInspectionsByVehicle(vid); }
    catch (e) {
      console.error(e);
      if (inspState.autoLoadingFor === vid) inspState.autoLoadingFor = null;
      if (inspState.filter === 'autos' && inspState.autoVehicleId === vid) { list.innerHTML = '<p style="color:var(--red);font-size:13px;padding:8px">No se pudieron cargar las inspecciones.</p>'; inspState.filtros.contador(''); }
      return;
    }
    if (inspState.autoLoadingFor === vid) inspState.autoLoadingFor = null;
    // Si mientras llegaba el admin eligió otro carro o se fue de «Autos», esto ya no se pinta.
    if (inspState.autoVehicleId !== vid) return;
    inspState.autoItems = rows; inspState.autoItemsFor = vid;
    if (inspState.filter === 'autos') paintAutoList();
  }
  function paintAutoList() {
    const list = $('#insp-list');
    if (!list) return;
    const F = inspState.filtros;
    const shown = inspState.autoItems.filter(F.coincide);
    list.innerHTML = shown.length ? shown.map(inspCardHtml).join('')
      : inspState.autoItems.length ? F.vacioHtml(0)
        : `<div class="empty"><div class="circle"><svg class="icon"><use href="#i-check"/></svg></div><h3>Sin registros</h3><p>Este carro aún no tiene inspecciones.</p></div>`;
    F.contador(shown.length, false);
  }

  function inspFindItem(id) {
    return inspState.items.find(x => x.id === id) || inspState.autoItems.find(x => x.id === id) || (inspState.fItems || []).find(x => x.id === id)
      || (inspState.current && inspState.current.id === id ? inspState.current : null);
  }

  // La tira de miniaturas de la tarjeta es DECORACIÓN: iconos grises fijos, no las
  // fotos de verdad (esas se cargan solo al abrir el detalle). A propósito NO va
  // atada a PHOTO_ORDER: al pasar de 8 a 11 tipos (0079) la tira crecía 123 px y,
  // como la tercera columna de .icard mide `auto`, se comía el nombre del
  // conductor —de 189 a 66 px— en paneles angostos. El detalle sí las muestra
  // todas, con su nombre. Si algún día han de ser las fotos reales, es otro
  // trabajo: hay que pedirlas en la consulta de la lista.
  const THUMBS_DECORATIVOS = 8;
  function inspThumbsHtml() {
    return `<div class="thumbs">${Array.from({ length: THUMBS_DECORATIVOS },
      () => `<span class="thumb"><svg class="icon"><use href="#i-cam"/></svg></span>`).join('')}</div>`;
  }
  function inspCardHtml(it) {
    const sev = INSP_SEV[inspSeverityOf(it)] || INSP_SEV.media;
    const st = INSP_ST[it.review_status] || INSP_ST.pending;
    const fallas = inspFallas(it);
    const v = it.vehicles || {};
    const veh = `${escapeHtml(v.internal_code || '—')} · ${escapeHtml(v.license_plate || '')}`;
    const vehname = escapeHtml([v.brand, v.model].filter(Boolean).join(' '));
    const actions = it.review_status === 'pending'
      ? `<div class="qactions"><button class="rbtn no" data-insp-rej="${it.id}"><svg><use href="#i-x"/></svg>Rechazar</button><button class="rbtn ok" data-insp-ok="${it.id}"><svg><use href="#i-check"/></svg>Aprobar</button><button class="btn dark sm" data-insp-open="${it.id}">Revisar <svg class="icon" style="width:14px;height:14px"><use href="#i-chev"/></svg></button></div>`
      : `<div class="qactions"><span class="st ${st[0]}"><svg><use href="#${st[2]}"/></svg>${st[1]}</span><button class="btn ghost sm" data-insp-open="${it.id}">Ver</button></div>`;
    const chips = it.has_damage
      ? `<span class="chip ${sev.cls}"><svg><use href="#i-warn"/></svg>${sev.label}</span><span class="chip fallas">${fallas} ${fallas === 1 ? 'falla' : 'fallas'}</span>`
      : `<span class="chip"><svg><use href="#i-check"/></svg>Sin novedad</span>`;
    return `<div class="icard ${it.has_damage && inspSeverityOf(it) === 'grave' ? 'grave' : ''}">
      <span class="avt" style="background:${colorOfId(it.id)}">${escapeHtml(initialsOf(inspDriverName(it)))}</span>
      <div class="who"><b>${escapeHtml(inspDriverName(it))}</b><div class="sub"><span class="veh">${veh}</span> ${vehname} <span class="when"><svg class="icon" style="width:12px;height:12px"><use href="#i-clock"/></svg>${escapeHtml(inspWhen(it))}</span></div></div>
      <div class="right">
        <div class="chips">${chips}</div>
        ${inspThumbsHtml()}
        ${actions}
      </div>
    </div>`;
  }

  async function openInspectionDetail(id) {
    bindInspections();
    inspRememberCola();
    if (inspState.adminPhoto && inspState.adminPhoto.url) URL.revokeObjectURL(inspState.adminPhoto.url);
    inspState.adminPhoto = null;
    const view = $('#insp-v-detalle');
    view.innerHTML = '<p style="color:var(--ink2);font-size:13px;padding:8px">Cargando…</p>';
    inspShowView('detalle');
    let insp;
    try { insp = await Api.getInspectionDetail(id); }
    catch (e) { console.error(e); view.innerHTML = '<button class="back" data-insp-back><svg class="icon"><use href="#i-back"/></svg>Volver</button><div class="card">No se pudo cargar la inspección.</div>'; return; }
    inspState.current = insp;
    // Cierre del mismo turno (inspección final + comprobantes de tanqueo) para
    // anexarlo a esta tarjeta y dar el ciclo completo del turno al admin.
    let closeData = null;
    try {
      if (insp.shift_id) {
        const [byShift, receipts, fuel] = await Promise.all([
          Api.listInspectionsByShift(insp.shift_id).catch(() => []),
          Api.listFuelReceiptsForShift(insp.shift_id).catch(() => []),
          (Api.getShiftFuelStatus ? Api.getShiftFuelStatus(insp.shift_id) : Promise.resolve(null)).catch(() => null),
        ]);
        const final = (byShift || []).find(i => i.kind === 'final') || null;
        // `fuel` cuenta también: un turno que dice "no pude tanquear" no tiene
        // recibos, y sin esto la tarjeta de cierre no se armaría y el motivo
        // —lo único que el jefe quería ver— no se pintaría en ningún lado.
        if (final || (receipts && receipts.length) || fuel) closeData = { final, receipts: receipts || [], fuel };
      }
    } catch (e) { console.error(e); }
    const paths = (insp.inspection_photos || []).map(p => p.storage_path);
    if (closeData) (closeData.receipts || []).forEach(r => paths.push(r.storage_path));
    let urls = {};
    try { urls = await Api.signedInspectionPhotoUrls(paths); } catch (e) { console.error(e); }
    renderInspectionDetail(insp, urls, closeData);
  }

  function renderInspectionDetail(insp, urls, closeData) {
    const v = insp.vehicles || {};
    const sev = INSP_SEV[inspSeverityOf(insp)] || INSP_SEV.media;
    const st = INSP_ST[insp.review_status] || INSP_ST.pending;
    const items = inspChecklistOf(insp);
    const fallas = items.filter(i => i.result === 'issue').length;
    // Orden: los 11 fijos primero (en el orden del wizard), luego golpe y adicionales.
    const photoRank = (t) => { const i = PHOTO_ORDER.indexOf(t); return i === -1 ? 99 : i; };
    const photos = (insp.inspection_photos || []).slice().sort((a, b) => photoRank(a.photo_type) - photoRank(b.photo_type));
    const photosHtml = photos.length ? photos.map(p => {
      const url = urls[p.storage_path];
      const label = escapeHtml(PHOTO_LABELS[p.photo_type] || p.photo_type);
      const inner = url ? `<img src="${url}" alt="${label}">` : `<svg class="icon"><use href="#i-cam"/></svg>`;
      return `<div class="photo"${url ? ` data-insp-photo="${url}"` : ''}>${inner}<span class="plabel">${label}</span></div>`;
    }).join('') : '<p style="color:var(--ink2);font-size:13px">Sin fotos.</p>';
    const checklistHtml = items.length ? items.map(it => {
      const bad = it.result === 'issue';
      return `<div class="ckrow ${bad ? 'issue' : 'ok'}"><svg class="icon ci"><use href="#${bad ? 'i-warn' : 'i-check'}"/></svg><div><div class="lbl">${escapeHtml(it.label || '')}</div>${it.hint ? `<div class="hint">${escapeHtml(it.hint)}</div>` : ''}</div><span class="badge">${bad ? 'Con falla' : 'OK'}</span></div>`;
    }).join('') : '<div class="ckrow ok"><span class="lbl" style="color:var(--ink2)">Sin checklist registrado.</span></div>';
    const nextMaint = (v.last_maintenance_km != null && v.maintenance_interval_km) ? Math.max(0, (v.last_maintenance_km + v.maintenance_interval_km) - (v.current_km || 0)) : null;
    const vehLine = `${v.status === 'available' ? 'Disponible' : (VEH_STATUS_ES[v.status] || v.status || '—')}${nextMaint != null ? ` · cambio de aceite en ${nextMaint.toLocaleString('es-CO')} km` : ''}`;
    const fmtDT = (s) => { try { return new Date(s).toLocaleString('es-CO', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/Bogota' }); } catch (e) { return ''; } };
    const decision = insp.review_status === 'pending'
      ? `<div class="card" id="insp-decision">
           <h2>Resolver inspección</h2>
           <p class="csub">Deja una nota con la solución y, si hace falta, adjunta una foto. Luego aprueba o rechaza.</p>
           <label>Nota / solución (la verá el conductor)</label>
           <textarea id="insp-resolve-note" placeholder="Ej: Se revisó el golpe, autorizado para operar. / Llevar a taller antes de seguir."></textarea>
           <div class="adminphoto">
             <button class="btn ghost sm" id="insp-admin-photo-btn" type="button"><svg class="icon"><use href="#i-cam"/></svg>Adjuntar foto (opcional)</button>
             <input id="insp-admin-photo-input" type="file" accept="image/*" class="hidden">
             <div id="insp-admin-photo-preview"></div>
           </div>
           <div class="abar" style="margin-top:12px">
             <button class="rbtn no" id="insp-reject-btn"><svg><use href="#i-x"/></svg>Rechazar</button>
             <button class="rbtn ok" id="insp-approve-btn"><svg><use href="#i-check"/></svg>Aprobar</button>
           </div>
           <div class="snapnote"><svg><use href="#i-info"/></svg><span>La nota y la foto quedan guardadas en la inspección. Al <b>rechazar</b> se notifica al conductor y se abre una novedad (el rechazo exige nota).</span></div>
         </div>`
      : `<div class="card"><h2>Revisión</h2>
           <div class="kv"><span class="k">Estado</span><span class="v" style="color:${insp.review_status === 'approved' ? 'var(--green)' : 'var(--red)'}">${st[1]}</span></div>
           ${insp.reviewed_at ? `<div class="kv"><span class="k">Revisada</span><span class="v">${escapeHtml(fmtDT(insp.reviewed_at))}</span></div>` : ''}
           ${insp.review_notes ? `<div style="margin-top:10px"><div class="note"><b>Nota del admin:</b> ${escapeHtml(insp.review_notes)}</div></div>` : ''}</div>`;
    $('#insp-v-detalle').innerHTML = `
      <button class="back" data-insp-back><svg class="icon"><use href="#i-back"/></svg>Volver a la cola</button>
      <div class="card">
        <div class="dhead">
          <span class="avt" style="background:${colorOfId(insp.id)}">${escapeHtml(initialsOf(inspDriverName(insp)))}</span>
          <div class="grow">
            <h2>${escapeHtml(inspDriverName(insp))}</h2>
            <div class="who"><div class="sub"><span class="veh">${escapeHtml(v.internal_code || '—')} · ${escapeHtml(v.license_plate || '')}</span> ${escapeHtml([v.brand, v.model].filter(Boolean).join(' '))} · ${escapeHtml(inspWhen(insp))}</div></div>
          </div>
          <span class="chip ${sev.cls}"><svg><use href="#i-warn"/></svg>Novedad ${sev.label.toLowerCase()}</span>
          <span class="st ${st[0]}"><svg><use href="#${st[2]}"/></svg>${st[1]}</span>
        </div>
      </div>
      <div class="cols">
        <div class="card" style="margin-bottom:0">
          <h2><svg class="icon"><use href="#i-cam"/></svg>Fotos de la inspección</h2>
          <p class="csub">Capturadas por el conductor. Toca una para ampliar.</p>
          <div class="pgrid">${photosHtml}</div>
        </div>
        <div class="card" style="margin-bottom:0">
          <h2><svg class="icon"><use href="#i-info"/></svg>Datos</h2>
          <div style="margin-top:6px">
            <div class="kv"><span class="k">Kilometraje de salida</span><span class="v mono">${insp.odometer_km != null ? insp.odometer_km.toLocaleString('es-CO') : '—'} km</span></div>
            <div class="kv"><span class="k">Severidad reportada</span><span class="v" style="color:${sev.color}">${sev.text}</span></div>
            ${insp.is_apt != null ? `<div class="kv"><span class="k">Estado del vehículo</span><span class="v" style="color:${insp.is_apt ? 'var(--green)' : 'var(--red)'};font-weight:800">${insp.is_apt ? 'APTO PARA OPERAR' : 'NO APTO PARA OPERAR'}</span></div>` : ''}
            <div class="kv"><span class="k">Vehículo</span><span class="v">${escapeHtml(vehLine)}</span></div>
            ${insp.signed_name ? `<div class="kv"><span class="k">Firma (conductor)</span><span class="v">${escapeHtml(insp.signed_name)}</span></div>` : ''}
          </div>
          ${insp.notes ? `<div style="margin-top:13px"><div class="note"><b>Nota del conductor:</b> ${escapeHtml(insp.notes)}</div></div>` : ''}
        </div>
      </div>
      <div class="card" style="margin-top:16px">
        <h2><svg class="icon"><use href="#i-check"/></svg>Checklist <span style="color:var(--ink3);font-weight:600;font-size:13px">(${items.length} ítems · ${fallas} con falla)</span></h2>
        <p class="csub">Lo que el conductor revisó. En rojo, lo que marcó con problema.</p>
        <div class="cklist">${checklistHtml}</div>
      </div>
      ${closeCardHtml(insp, urls, closeData)}
      ${decision}`;
  }

  // Tarjeta de CIERRE de turno anexada al detalle (km final, novedad, comprobantes
  // de tanqueo con foto ampliable). Vacía mientras el turno no se haya cerrado.
  function closeCardHtml(insp, urls, closeData) {
    if (!closeData) {
      return `<div class="card" style="margin-top:16px"><h2><svg class="icon"><use href="#i-clock"/></svg>Cierre de turno</h2>
        <p class="csub">El turno aún no se ha cerrado. Aquí aparecerán el kilometraje final, las novedades y los comprobantes de tanqueo cuando el conductor cierre.</p></div>`;
    }
    const f = closeData.final;
    const receipts = closeData.receipts || [];
    const total = receipts.reduce((s, r) => s + (Number(r.amount_cop) || 0), 0);
    const driven = (f && f.odometer_km != null && insp.odometer_km != null) ? (f.odometer_km - insp.odometer_km) : null;
    const fmtDT2 = (s) => { try { return new Date(s).toLocaleString('es-CO', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/Bogota' }); } catch (e) { return ''; } };
    const kmRows = `
      <div class="kv"><span class="k">Kilometraje final</span><span class="v mono">${f && f.odometer_km != null ? f.odometer_km.toLocaleString('es-CO') : '—'} km</span></div>
      <div class="kv"><span class="k">Km recorridos</span><span class="v mono" style="color:var(--green)">${driven != null ? '+' + driven.toLocaleString('es-CO') : '—'} km</span></div>
      ${f && f.performed_at ? `<div class="kv"><span class="k">Cerrado</span><span class="v">${escapeHtml(fmtDT2(f.performed_at))}</span></div>` : ''}
      ${f && f.notes ? `<div style="margin-top:10px"><div class="note"><b>Novedad de cierre:</b> ${escapeHtml(f.notes)}</div></div>` : ''}`;
    const receiptsHtml = receipts.length ? `
      <div style="margin-top:14px">
        <div class="kv"><span class="k">Comprobantes de tanqueo</span><span class="v mono" style="font-weight:800">$${total.toLocaleString('es-CO')}</span></div>
        <div class="pgrid" style="margin-top:8px">
          ${receipts.map(r => { const u = urls[r.storage_path]; return `<div class="photo"${u ? ` data-insp-photo="${u}"` : ''}>${u ? `<img src="${u}" alt="comprobante">` : `<svg class="icon"><use href="#i-cam"/></svg>`}<span class="plabel">$${(Number(r.amount_cop) || 0).toLocaleString('es-CO')}</span></div>`; }).join('')}
        </div>
      </div>`
      // TRES CASOS, NO DOS (0077). Antes cualquier turno sin recibos decía "Sin
      // comprobantes de tanqueo", que ahora sería mentir a medias: no distingue
      // al que avisó que no pudo del que simplemente no adjuntó nada. Y saber
      // POR QUÉ no se tanqueó es justo lo que pidió el jefe.
      : (closeData.fuel && closeData.fuel.fueled === false)
        ? `<div class="note" style="margin-top:12px;background:var(--amber-50,#fffbeb);border-color:var(--amber,#f59e0b)">
             <b>No se pudo tanquear.</b> ${escapeHtml(closeData.fuel.no_fuel_reason || 'Sin motivo registrado.')}
           </div>`
        : (closeData.fuel && closeData.fuel.fueled === true)
          ? '<p class="csub" style="margin-top:10px">Dijo que sí tanqueó, pero no adjuntó comprobantes.</p>'
          : '<p class="csub" style="margin-top:10px">Sin comprobantes de tanqueo.</p>';
    return `<div class="card" style="margin-top:16px">
      <h2><svg class="icon"><use href="#i-check"/></svg>Cierre de turno</h2>
      <p class="csub">Información registrada por el conductor al cerrar el turno.</p>
      <div style="margin-top:6px">${kmRows}</div>
      ${receiptsHtml}
    </div>`;
  }

  async function inspDoReview(id, status, notes) {
    try {
      await Api.reviewInspection(id, status, notes);
      if (status === 'rejected') {
        const pid = inspState.current ? inspDriverProfileId(inspState.current) : null;
        if (pid) { try { await notify([pid], 'Inspección rechazada', notes || 'Tu inspección de inicio de turno fue rechazada.', '/'); } catch (e) {} }
      }
      // Las tres copias en memoria (cola, lo filtrado y «Autos») son objetos
      // distintos: se actualizan todas para que ninguna pestaña quede atrasada.
      [inspState.items, inspState.autoItems, inspState.fItems || []].map(arr => arr.find(x => x.id === id)).forEach(it => {
        if (it) { it.review_status = status; it.review_notes = notes || null; }
      });
      toast(status === 'approved' ? 'Inspección aprobada.' : 'Inspección rechazada.');
      // «Aprobar» desde la tarjeta: se queda donde está. Desde el detalle: vuelve
      // al lugar que se anotó al abrirlo.
      inspRememberCola();
      inspBackToCola();
    } catch (e) {
      console.error(e);
      toast('No se pudo guardar la revisión.');
    }
  }

  // Comprime una imagen a JPEG (máx 1280px) para no pasar el límite del bucket.
  async function compressImage(file, maxDim = 1280, quality = 0.8) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('No se pudo leer la imagen')); i.src = url; });
      const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', quality));
      if (!blob) throw new Error('No se pudo comprimir');
      return blob;
    } finally { URL.revokeObjectURL(url); }
  }

  async function onAdminPhotoPicked(input) {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    try {
      const blob = await compressImage(file);
      if (inspState.adminPhoto && inspState.adminPhoto.url) URL.revokeObjectURL(inspState.adminPhoto.url);
      inspState.adminPhoto = { blob, url: URL.createObjectURL(blob), size: blob.size };
      const prev = $('#insp-admin-photo-preview');
      if (prev) prev.innerHTML = `<div class="adminphoto-prev"><img src="${inspState.adminPhoto.url}" alt="Foto del admin"><button class="x" id="insp-admin-photo-rm" type="button">✕</button></div>`;
      $('#insp-admin-photo-rm')?.addEventListener('click', () => {
        if (inspState.adminPhoto && inspState.adminPhoto.url) URL.revokeObjectURL(inspState.adminPhoto.url);
        inspState.adminPhoto = null;
        if (prev) prev.innerHTML = '';
      });
    } catch (e) { console.error(e); toast('No se pudo procesar la foto.'); }
  }

  // Resolver una inspección pendiente: nota (review_notes) + foto opcional del admin.
  async function resolveInspection(status) {
    const insp = inspState.current;
    if (!insp) return;
    const note = (($('#insp-resolve-note') && $('#insp-resolve-note').value) || '').trim();
    if (status === 'rejected' && !note) { toast('Escribe el motivo del rechazo.'); return; }
    const btn = status === 'approved' ? $('#insp-approve-btn') : $('#insp-reject-btn');
    if (btn) btn.disabled = true;
    try {
      // 1) Subir la foto del admin (si adjuntó) y enlazarla a la inspección.
      if (inspState.adminPhoto) {
        const org = state.profile.organization_id;
        const today = new Date().toISOString().slice(0, 10);
        const path = `${org}/${insp.vehicle_id}/${today}/${insp.id}/admin-${Date.now()}.jpg`;
        await Api.uploadInspectionPhoto(path, inspState.adminPhoto.blob);
        await Api.addInspectionPhotos([{ inspection_id: insp.id, organization_id: org, photo_type: 'admin', storage_path: path, size_bytes: inspState.adminPhoto.size }]);
        if (inspState.adminPhoto.url) URL.revokeObjectURL(inspState.adminPhoto.url);
        inspState.adminPhoto = null;
      }
      // 2) Aprobar/rechazar con la nota (notifica al conductor si se rechaza).
      await inspDoReview(insp.id, status, note || null);
    } catch (e) {
      console.error(e);
      if (btn) btn.disabled = false;
      toast('No se pudo resolver: ' + (e.message || 'error'));
    }
  }

  async function openInspChecklist() {
    inspRememberCola();
    bindInspections();
    const view = $('#insp-v-config');
    view.innerHTML = '<p style="color:var(--ink2);font-size:13px;padding:8px">Cargando…</p>';
    inspShowView('config');
    // true al final: aquí sí se muestran los ítems de nivel preventivo (0073),
    // para que el admin pueda verlos y editarlos aunque no salgan a diario.
    try { inspState.checklist = await Api.listChecklistItems(false, true); }
    catch (e) { console.error(e); view.innerHTML = '<button class="back" data-insp-back><svg class="icon"><use href="#i-back"/></svg>Volver</button><div class="card">No se pudo cargar el checklist.</div>'; return; }
    renderInspChecklist();
  }

  const CHECKLIST_CATEGORIES = ['Exterior', 'Llantas', 'Niveles y motor', 'Seguridad', 'Operación', 'Documentación'];

  function renderInspChecklist() {
    const items = inspState.checklist;
    const itemRow = (it, i) => `<div class="crow ${it.is_active ? '' : 'off'}" data-insp-ci="${it.id}">
      <span class="grip">⠿</span>
      <div class="ctxt"><b>${escapeHtml(it.label)}</b>${it.hint ? `<span>${escapeHtml(it.hint)}</span>` : ''}</div>
      <button class="cfgbtn" title="Subir" data-insp-cmove="up"${i === 0 ? ' disabled' : ''}><svg class="icon" style="width:15px;height:15px;transform:rotate(-90deg)"><use href="#i-chev"/></svg></button>
      <button class="cfgbtn" title="Bajar" data-insp-cmove="down"${i === items.length - 1 ? ' disabled' : ''}><svg class="icon" style="width:15px;height:15px;transform:rotate(90deg)"><use href="#i-chev"/></svg></button>
      <button class="tg ${it.is_active ? 'on' : ''}" title="Activar/desactivar" data-insp-ctoggle></button>
      <button class="cfgbtn" title="Editar" data-insp-cedit><svg class="icon" style="width:15px;height:15px"><use href="#i-edit"/></svg></button>
      <button class="cfgbtn danger" title="Eliminar" data-insp-cdel><svg class="icon" style="width:15px;height:15px"><use href="#i-trash"/></svg></button>
    </div>`;
    // Agrupar por sección, conservando el orden global (índice i para reordenar).
    const order = [], byCat = new Map();
    items.forEach((it, i) => {
      const cat = it.category || 'Sin sección';
      if (!byCat.has(cat)) { byCat.set(cat, []); order.push(cat); }
      byCat.get(cat).push(itemRow(it, i));
    });
    const rows = order.map(cat =>
      `<p class="csub" style="font-weight:800;color:var(--ink);margin:14px 0 6px;text-transform:uppercase;letter-spacing:.04em;font-size:11px">${escapeHtml(cat)}</p>${byCat.get(cat).join('')}`
    ).join('');
    const catOptions = CHECKLIST_CATEGORIES.map(c => `<option value="${escapeHtml(c)}"></option>`).join('');
    $('#insp-v-config').innerHTML = `
      <button class="back" data-insp-back><svg class="icon"><use href="#i-back"/></svg>Volver a la cola</button>
      <div class="phead"><div><h1>Configurar checklist</h1><p>Define qué revisa el conductor al iniciar turno, agrupado por sección. Agrega, edita, reordena o desactiva ítems. Aplica a toda la flota.</p></div></div>
      <div class="card">
        <h2><svg class="icon"><use href="#i-list"/></svg>Ítems de la inspección</h2>
        <p class="csub">Usa las flechas para reordenar. Desactiva los que no apliquen sin perder el historial.</p>
        <div id="insp-citems">${rows || '<p style="color:var(--ink2);font-size:13px">Sin ítems. Agrega el primero abajo.</p>'}</div>
        <div class="additem">
          <div class="f"><label>Nuevo ítem</label><input id="insp-new-label" placeholder="Ej: Estado de la carrocería"></div>
          <div class="f"><label>Sección</label><input id="insp-new-cat" list="insp-cat-list" placeholder="Ej: Exterior"><datalist id="insp-cat-list">${catOptions}</datalist></div>
          <div class="f"><label>Pista / ayuda (opcional)</label><input id="insp-new-hint" placeholder="Ej: Rayones, golpes visibles"></div>
          <button class="btn sm" id="insp-add"><svg class="icon" style="width:15px;height:15px"><use href="#i-plus"/></svg>Agregar</button>
        </div>
        <div class="snapnote" style="margin-top:16px"><svg><use href="#i-info"/></svg><span><b>Auditoría:</b> cada inspección guarda una copia de los ítems tal como estaban ese día. Si cambias el checklist, las inspecciones viejas no se alteran.</span></div>
      </div>`;
  }

  function bindInspections() {
    const root = $('#inspections-ui');
    if (!root || root._inspBound) return;
    root._inspBound = true;
    root.addEventListener('click', async (e) => {
      if (inspState.filtros.onClick(e)) return;   // barra de filtros (modo de fecha, Limpiar)
      const fb = e.target.closest('#insp-filter button');
      if (fb) { inspState.filter = fb.dataset.f; $$('#insp-filter button').forEach(b => b.classList.toggle('on', b === fb)); renderInspList(); return; }
      if (e.target.closest('#insp-to-config')) { openInspChecklist(); return; }
      if (e.target.closest('#insp-to-novedades')) { renderNovedades(); return; }
      if (e.target.closest('[data-insp-back]')) { inspBackToCola(); return; }
      // --- Novedades (incidents) ---
      if (e.target.closest('[data-nov-back]')) { renderInspections(); return; }
      if (e.target.closest('[data-nov-list]')) { renderNovedades(); return; }
      const nf = e.target.closest('#nov-filter button'); if (nf) { inspState.novFilter = nf.dataset.nf; renderNovList(); return; }
      const novOpen = e.target.closest('[data-nov-open]'); if (novOpen) { openNovedadDetail(novOpen.dataset.novOpen); return; }
      const novSt = e.target.closest('[data-nov-status]'); if (novSt) { const cur = inspState.novCurrent; if (cur) novChangeStatus(cur.id, novSt.dataset.novStatus); return; }
      const open = e.target.closest('[data-insp-open]'); if (open) { openInspectionDetail(open.dataset.inspOpen); return; }
      const ok = e.target.closest('[data-insp-ok]'); if (ok) { inspState.current = inspFindItem(ok.dataset.inspOk); inspDoReview(ok.dataset.inspOk, 'approved', null); return; }
      const rej = e.target.closest('[data-insp-rej]'); if (rej) { openInspectionDetail(rej.dataset.inspRej); return; }
      if (e.target.closest('#insp-admin-photo-btn')) { $('#insp-admin-photo-input')?.click(); return; }
      if (e.target.closest('#insp-approve-btn')) { resolveInspection('approved'); return; }
      if (e.target.closest('#insp-reject-btn')) { resolveInspection('rejected'); return; }
      const ph = e.target.closest('[data-insp-photo]'); if (ph) { const img = $('#insp-lbx-img'); if (img) { img.src = ph.dataset.inspPhoto; $('#insp-lbx').classList.add('show'); } return; }
      const tg = e.target.closest('[data-insp-ctoggle]');
      if (tg) { const row = tg.closest('[data-insp-ci]'); const it = inspState.checklist.find(x => x.id === row.dataset.inspCi); if (it) { const nv = !it.is_active; try { await Api.updateChecklistItem(it.id, { is_active: nv }); it.is_active = nv; renderInspChecklist(); } catch (err) { console.error(err); toast('No se pudo actualizar.'); } } return; }
      const del = e.target.closest('[data-insp-cdel]');
      if (del) { const row = del.closest('[data-insp-ci]'); const id = row.dataset.inspCi; if (!confirm('¿Eliminar este ítem del checklist?')) return; try { await Api.deleteChecklistItem(id); inspState.checklist = inspState.checklist.filter(x => x.id !== id); renderInspChecklist(); toast('Ítem eliminado.'); } catch (err) { console.error(err); toast('No se pudo eliminar.'); } return; }
      const ed = e.target.closest('[data-insp-cedit]');
      if (ed) {
        const row = ed.closest('[data-insp-ci]');
        const it = inspState.checklist.find(x => x.id === row.dataset.inspCi);
        if (!it) return;
        // Edición completa: nombre, sección y ayuda (Cancelar en el nombre aborta).
        const nv = prompt('Nombre del ítem:', it.label);
        if (nv === null) return;
        const label = nv.trim() || it.label;
        const nc = prompt('Sección (' + CHECKLIST_CATEGORIES.join(', ') + '):', it.category || '');
        const category = nc === null ? (it.category || null) : (nc.trim() || null);
        const nh = prompt('Pista / ayuda (opcional):', it.hint || '');
        const hint = nh === null ? (it.hint || null) : (nh.trim() || null);
        const fields = {};
        if (label !== it.label) fields.label = label;
        if (category !== (it.category || null)) fields.category = category;
        if (hint !== (it.hint || null)) fields.hint = hint;
        if (!Object.keys(fields).length) return;
        try { await Api.updateChecklistItem(it.id, fields); Object.assign(it, fields); renderInspChecklist(); toast('Ítem actualizado.'); }
        catch (err) { console.error(err); toast('No se pudo editar.'); }
        return;
      }
      const mv = e.target.closest('[data-insp-cmove]');
      if (mv) { const row = mv.closest('[data-insp-ci]'); const idx = inspState.checklist.findIndex(x => x.id === row.dataset.inspCi); const j = idx + (mv.dataset.inspCmove === 'up' ? -1 : 1); if (j < 0 || j >= inspState.checklist.length) return; const arr = inspState.checklist; const tmp = arr[idx]; arr[idx] = arr[j]; arr[j] = tmp; renderInspChecklist(); try { await Api.reorderChecklistItems(arr.map(x => x.id)); } catch (err) { console.error(err); toast('No se pudo reordenar.'); } return; }
      if (e.target.closest('#insp-add')) { const label = (($('#insp-new-label') && $('#insp-new-label').value) || '').trim(); if (!label) { toast('Escribe el nombre del ítem.'); return; } const hint = (($('#insp-new-hint') && $('#insp-new-hint').value) || '').trim(); const category = (($('#insp-new-cat') && $('#insp-new-cat').value) || '').trim() || null; try { const created = await Api.createChecklistItem({ organizationId: state.profile.organization_id, label, hint, category, sortOrder: inspState.checklist.length + 1 }); inspState.checklist.push(created); renderInspChecklist(); toast('Ítem agregado.'); } catch (err) { console.error(err); toast('No se pudo agregar.'); } return; }
    });
    // Foto que adjunta el admin al resolver (input file → cambia, no click).
    root.addEventListener('change', (e) => {
      if (inspState.filtros.onChange(e)) return;  // fechas y carro de la barra de filtros
      if (e.target && e.target.id === 'insp-admin-photo-input') onAdminPhotoPicked(e.target);
    });
    // El buscador de conductor filtra mientras se escribe (con una pausa corta).
    root.addEventListener('input', (e) => { inspState.filtros.onInput(e); });
    // Al salir de una fecha a medio teclear, el campo vuelve a lo que se aplica.
    root.addEventListener('focusout', (e) => { inspState.filtros.onFocusOut(e); });
    const lbx = $('#insp-lbx');
    if (lbx) lbx.addEventListener('click', (e) => { if (e.target.id === 'insp-lbx' || e.target.id === 'insp-lbx-close') lbx.classList.remove('show'); });
  }

  async function refreshPendingBadge() {
    if (state.profile?.role !== 'admin') return;
    try {
      const ids = new Set(state.drivers.map(d => d.id));
      const pending = await Api.listPendingApprovals(state.currentWeek);
      const count = pending.filter(p => p.state === 'pending' && ids.has(p.profile_id)).length;
      const badge = $('#pending-badge');
      if (badge) {
        badge.textContent = String(count);
        badge.classList.toggle('hidden', count === 0);
      }
      updateAdminGreeting(count);
    } catch (e) { /* silent */ }
  }

