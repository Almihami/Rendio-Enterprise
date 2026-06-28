// shift-flow.js — Inicio de turno (Etapa 1 módulo conductor)
// Wizard de 6 pasos fiel al diseño de /Visual (Conductor.html):
//   1. Selección de vehículo   4. Kilometraje inicial
//   2. Checklist pre-operacional  5. Novedades / observaciones
//   3. Fotos (5 ángulos)       6. Confirmar e iniciar
//
// Persistencia (al confirmar, en orden):
//   fotos → bucket 'inspections' · shift → shifts · inspección → inspections
//   → inspection_photos · novedades → incidents · RPC start_shift/abort_shift.
//
// Integración: app.js llama ShiftFlow.init(profile) al entrar como conductor.
(function () {
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtKm = (n) => Number(n || 0).toLocaleString('es-CO');

  // Checklist diario OFICIAL (27 ítems, 6 secciones). Es el respaldo si la BD no
  // responde; normalmente se cargan desde inspection_checklist_items (0024+0028).
  const CHECKLIST_FALLBACK = [
    { id: 'ext_golpes',   category: 'Exterior',        label: 'No presenta golpes o daños nuevos', detail: 'Si hay golpe, adjunta una foto del daño.' },
    { id: 'ext_vidrios',  category: 'Exterior',        label: 'Vidrios y espejos en buen estado' },
    { id: 'ext_luz_del',  category: 'Exterior',        label: 'Luces delanteras funcionando' },
    { id: 'ext_luz_tra',  category: 'Exterior',        label: 'Luces traseras funcionando' },
    { id: 'ext_direcc',   category: 'Exterior',        label: 'Direccionales funcionando' },
    { id: 'ext_freno',    category: 'Exterior',        label: 'Luces de freno funcionando' },
    { id: 'ext_placa',    category: 'Exterior',        label: 'Placa visible y en buen estado' },
    { id: 'lla_repuesto', category: 'Llantas',         label: 'Llanta de repuesto disponible' },
    { id: 'lla_estado',   category: 'Llantas',         label: 'Llantas sin cortes, deformaciones o desgaste excesivo' },
    { id: 'niv_aceite',   category: 'Niveles y motor', label: 'Nivel de aceite correcto' },
    { id: 'niv_refrig',   category: 'Niveles y motor', label: 'Nivel de refrigerante correcto' },
    { id: 'niv_frenos',   category: 'Niveles y motor', label: 'Nivel de líquido de frenos correcto' },
    { id: 'niv_fugas',    category: 'Niveles y motor', label: 'Sin fugas visibles debajo del vehículo' },
    { id: 'niv_bateria',  category: 'Niveles y motor', label: 'Batería en buen estado visiblemente' },
    { id: 'seg_extintor', category: 'Seguridad',       label: 'Extintor vigente y accesible' },
    { id: 'seg_kit',      category: 'Seguridad',       label: 'Kit de carretera visiblemente completo' },
    { id: 'seg_cintur',   category: 'Seguridad',       label: 'Cinturones de seguridad funcionando' },
    { id: 'seg_pito',     category: 'Seguridad',       label: 'Pito funcionando' },
    { id: 'ope_frenos',   category: 'Operación',       label: 'Frenos responden correctamente' },
    { id: 'ope_direcc',   category: 'Operación',       label: 'Dirección sin anomalías' },
    { id: 'ope_aire',     category: 'Operación',       label: 'Aire acondicionado funcionando' },
    { id: 'ope_tablero',  category: 'Operación',       label: 'Tablero sin alertas encendidas' },
    { id: 'ope_combust',  category: 'Operación',       label: 'Combustible suficiente para la jornada' },
    { id: 'doc_soat',     category: 'Documentación',   label: 'SOAT vigente' },
    { id: 'doc_tecno',    category: 'Documentación',   label: 'Revisión técnico-mecánica vigente' },
    { id: 'doc_tarjeta',  category: 'Documentación',   label: 'Tarjeta de propiedad disponible' },
    { id: 'doc_empresa',  category: 'Documentación',   label: 'Documentos requeridos por la empresa disponibles' },
  ];

  // Checklist activo: se carga desde la BD en init() (Api.listChecklistItems, 0024);
  // fallback a los fijos si la migración no está o la organización no tiene ítems.
  let ckItems = CHECKLIST_FALLBACK;

  // photo_type del enum inspection_photo_type (0016): front|left|right|rear|dashboard
  const PHOTO_SLOTS = [
    { id: 'front',     label: 'Frontal',            detail: 'Placa visible, parachoques completo' },
    { id: 'rear',      label: 'Trasera',            detail: 'Placa, stops, baúl' },
    { id: 'left',      label: 'Lateral izquierdo',  detail: 'Lado del conductor, retrovisor' },
    { id: 'right',     label: 'Lateral derecho',    detail: 'Lado del pasajero, retrovisor' },
    { id: 'dashboard', label: 'Interior / tablero', detail: 'Asientos, tablero y odómetro visibles' },
  ];

  const TOTAL_STEPS = 6;

  const sf = {
    profile: null,
    driverId: null,       // driver_profiles.id
    step: 0,
    vehicles: [],
    vehicleId: null,
    reuseShiftId: null,   // shift huérfano de un intento interrumpido
    myReservedVehicleId: null, // vehículo que este conductor ya tiene reservado (draft abierto)
    checklist: {},        // itemId -> 'ok' | 'issue'
    photos: {},           // slotId -> { blob, url, size }
    extraPhotos: [],      // fotos adicionales libres: [{ blob, url, size }]
    km: '',
    severity: null,       // 'leve' | 'media' | 'grave'
    note: '',
    isApt: true,          // estado oficial: APTO (true) / NO APTO (false)
    signed: false,        // firma digital: el conductor confirmó veracidad
    saving: false,
    done: null,           // 'started' | 'aborted'
    _slot: null,          // slot pendiente de captura
    activeShift: null,    // turno activo (para timer + cierre)
    _timer: null,         // intervalo del cronómetro en vivo
    close: null,          // estado del flujo de cierre (ver newCloseState)
    settings: null,       // ajustes (ventana/plazo de inicio diferido)
    completing: false,    // completando la inspección diferida de un turno activo
  };

  function newCloseState() {
    return { km: '', novedad: false, novedadText: '', severity: 'media', media: [], receipts: [], attest: false, saving: false, done: null };
  }

  function sfToast(msg) {
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(sfToast._t);
    sfToast._t = setTimeout(() => t.classList.add('hidden'), 3000);
  }

  // ---------- cronómetro del turno activo ----------
  function fmtElapsed(startAt) {
    const ms = Date.now() - new Date(startAt).getTime();
    if (!(ms >= 0)) return '0h 00m';
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return `${h}h ${String(m).padStart(2, '0')}m`;
  }
  function fmtInspLeft(due) {
    const ms = new Date(due).getTime() - Date.now();
    if (!(ms > 0)) return '· vencida';
    const m = Math.ceil(ms / 60000);
    return m >= 60 ? `· faltan ${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `· faltan ${m} min`;
  }
  function startElapsedTimer(startAt) {
    stopElapsedTimer();
    sf._timer = setInterval(() => {
      const el = $('#sf-elapsed');
      if (!el) { stopElapsedTimer(); return; }
      el.textContent = fmtElapsed(startAt);
      const il = $('#sf-insp-left');
      if (il && sf.activeShift && sf.activeShift.inspection_due_at) il.textContent = fmtInspLeft(sf.activeShift.inspection_due_at);
    }, 30000);
  }
  function stopElapsedTimer() {
    if (sf._timer) { clearInterval(sf._timer); sf._timer = null; }
  }

  // ====================================================================
  // Card en el home del conductor
  // ====================================================================

  async function init(profile) {
    sf.profile = profile;
    try {
      sf.driverId = await Api.getMyDriverProfileId(profile.id);
    } catch (e) {
      console.error(e);
      sf.driverId = null;
    }
    // Checklist configurable (0024): los ítems los define el admin. Fallback a los fijos.
    try {
      const items = await Api.listChecklistItems(true);
      if (items && items.length) ckItems = items.map(it => ({ id: it.id, label: it.label, detail: it.hint || '', category: it.category || 'General' }));
    } catch (e) { /* sin 0024 o sin ítems: queda CHECKLIST_FALLBACK */ }
    // Ajustes (ventana/plazo del inicio diferido). Si falla, el botón no aparece.
    try { sf.settings = await Api.getSettings(); } catch (e) { sf.settings = null; }
    await renderCard();
  }

  async function renderCard() {
    const box = $('#driver-shift-container');
    if (!box) return;

    if (!sf.driverId) {
      box.innerHTML = `<div class="bg-white border border-slate-200 rounded-2xl p-4 shadow-card text-sm text-slate-500">
        🚗 El inicio de turno estará disponible cuando tu admin complete tu perfil de conductor.
      </div>`;
      return;
    }
    if (sf.profile.is_active === false) {
      box.innerHTML = '';
      return; // suspendido: el banner general ya lo explica
    }

    let open = null;
    try { open = await Api.getMyOpenShift(sf.driverId); }
    catch (e) { console.error(e); }

    if (open && (open.status === 'active' || open.status === 'closing')) {
      sf.activeShift = open;
      const v = open.vehicles || {};
      const since = new Date(open.start_at).toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Bogota' });
      box.innerHTML = `<div class="rounded-2xl p-5 flex flex-col bg-gradient-to-br from-emerald-500 to-emerald-600 text-white shadow-card overflow-hidden">
        <div class="flex items-start justify-between">
          <div class="w-12 h-12 rounded-2xl bg-white/20 flex items-center justify-center text-2xl">🚐</div>
          <span class="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-white/90 mt-1">
            <span class="sf-livedot w-1.5 h-1.5 rounded-full bg-white inline-block"></span> En curso
          </span>
        </div>
        <div class="mt-4">
          <p class="text-xl font-extrabold leading-tight">Turno en curso · ${esc(v.internal_code || v.license_plate || 'vehículo')}</p>
          <p class="text-xs text-white/85 mt-1">${esc([v.brand, v.model].filter(Boolean).join(' '))} · inició ${since} · salida ${fmtKm(open.opening_km)} km</p>
        </div>
        <div class="mt-3 flex items-center gap-2 text-sm font-bold tabular-nums">
          <svg class="w-4 h-4 text-white/80" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"></circle><path stroke-linecap="round" d="M12 7v5l3 2"></path></svg>
          <span id="sf-elapsed">${fmtElapsed(open.start_at)}</span>
          <span class="text-white/60 font-medium">trabajado</span>
        </div>
        ${open.inspection_due_at ? `<div class="mt-3 rounded-xl bg-white/15 border border-white/30 p-3">
          <p class="text-[13px] font-extrabold flex items-center gap-1.5">⏳ Inspección pendiente <span id="sf-insp-left" class="font-extrabold">${fmtInspLeft(open.inspection_due_at)}</span></p>
          <p class="text-[11px] text-white/85 mt-0.5">Hazla antes de que se venza o será un strike.</p>
          <button id="sf-do-insp" class="tap w-full mt-2 bg-white text-emerald-700 text-sm font-extrabold py-2.5 rounded-lg active:scale-[.98]">Hacer inspección ahora</button>
        </div>` : ''}
        <div class="mt-4 pt-4 border-t border-white/20">
          <button id="sf-close-btn" class="tap w-full bg-white text-emerald-700 text-base font-extrabold py-3.5 rounded-xl shadow-sm active:scale-[.98]">Cerrar turno</button>
          <p class="text-[11px] text-white/80 text-center mt-2">Kilometraje final, novedades y comprobantes de tanqueo.</p>
        </div>
      </div>`;
      startElapsedTimer(open.start_at);
      $('#sf-close-btn').addEventListener('click', () => openClose(open));
      $('#sf-do-insp')?.addEventListener('click', () => openCompletion(open));
      return;
    }
    stopElapsedTimer();

    sf.reuseShiftId = open ? open.id : null;
    sf.myReservedVehicleId = open ? open.vehicle_id : null; // vehículo ya reservado en el draft
    box.innerHTML = `<button id="sf-open-btn" class="pc-in d1 sheen tap w-full text-left rounded-2xl p-5 h-[200px] flex flex-col bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-brand">
      <div class="flex items-start justify-between">
        <div class="w-12 h-12 rounded-2xl bg-white/20 flex items-center justify-center text-2xl"><span class="bob inline-block">🚗</span></div>
        <span class="text-[10px] font-bold uppercase tracking-[0.18em] text-white/75 mt-1">${open ? 'Sin terminar' : 'Ahora'}</span>
      </div>
      <div class="mt-auto">
        <p class="text-xl font-extrabold leading-tight">${open ? 'Continuar inicio de turno' : 'Iniciar turno'}</p>
        <p class="text-xs text-white/85 mt-1">${open ? 'Retomas el registro con el mismo turno, sin perder el avance.' : 'Turno único · inspección, fotos y kilometraje · ~5 min'}</p>
      </div>
      <div class="mt-3 flex items-center gap-1 text-sm font-bold">${open ? 'Continuar' : 'Empezar'}
        <svg class="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"></path></svg>
      </div>
    </button>`;
    $('#sf-open-btn').addEventListener('click', openWizard);
  }

  // ====================================================================
  // Wizard
  // ====================================================================

  async function openWizard() {
    sf.step = 0;
    sf.completing = false;   // inicio normal (no es completar una inspección diferida)
    // Si el conductor retoma un draft, preselecciona el vehículo que ya reservó.
    sf.vehicleId = sf.myReservedVehicleId || null;
    sf.checklist = {};
    Object.values(sf.photos).forEach(p => p && p.url && URL.revokeObjectURL(p.url));
    sf.photos = {};
    sf.extraPhotos.forEach(p => p && p.url && URL.revokeObjectURL(p.url));
    sf.extraPhotos = [];
    sf.km = '';
    sf.severity = null;
    sf.note = '';
    sf.isApt = true;
    sf.signed = false;
    sf.saving = false;
    sf.done = null;

    const wiz = $('#shift-wizard');
    wiz.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    // El wizard es pantalla completa: oculta la barra inferior del conductor (si está)
    // para que no tape el botón Continuar. Se restaura al cerrar.
    const nav = document.getElementById('driver-nav');
    sf._navWasShown = !!(nav && nav.classList.contains('show'));
    if (sf._navWasShown) nav.classList.remove('show');
    document.getElementById('driver-save-bar')?.classList.add('hidden');
    wiz.innerHTML = `<div class="min-h-screen flex items-center justify-center text-sm text-slate-500">Cargando vehículos…</div>`;
    try {
      sf.vehicles = await Api.listVehiclesForShift();
    } catch (e) {
      console.error(e);
      closeWizard();
      sfToast('No pudimos cargar los vehículos: ' + (e.message || 'error'));
      return;
    }
    if (!sf.vehicles.length) {
      closeWizard();
      sfToast('No hay vehículos registrados todavía. Habla con tu admin.');
      return;
    }
    render();
  }

  function closeWizard() {
    $('#shift-wizard').classList.add('hidden');
    document.body.style.overflow = '';
    // Restaura la barra inferior si estaba visible antes de abrir el wizard.
    if (sf._navWasShown) document.getElementById('driver-nav')?.classList.add('show');
    sf._navWasShown = false;
  }

  function tryExit() {
    const hasProgress = sf.vehicleId || Object.keys(sf.checklist).length || Object.keys(sf.photos).length;
    if (sf.done || !hasProgress || confirm('¿Salir del inicio de turno? Se pierde el avance de la inspección.')) {
      closeWizard();
      renderCard();
    }
  }

  function goBack() {
    if (sf.step === 0 || (sf.completing && sf.step === 1)) { tryExit(); return; }
    sf.step -= 1;
    render();
  }

  function goNext() {
    sf.step += 1;
    render();
  }

  // ---------- chrome compartido ----------

  function headerHtml(eyebrow, title, subtitle) {
    return `<div class="px-5 pt-4 pb-2" style="padding-top:calc(16px + env(safe-area-inset-top));">
      <div class="flex items-center justify-between mb-3">
        <button id="sf-back" class="w-9 h-9 rounded-full bg-white border border-slate-200 flex items-center justify-center text-slate-600 active:scale-95 transition" aria-label="Atrás">
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/></svg>
        </button>
        <button id="sf-exit" class="w-9 h-9 rounded-full bg-white border border-slate-200 flex items-center justify-center text-slate-600 active:scale-95 transition" aria-label="Salir">✕</button>
      </div>
      <p class="text-[11px] font-bold uppercase tracking-wider text-brand-600">${esc(eyebrow)}</p>
      <h1 class="text-2xl font-extrabold text-ink leading-tight mt-1">${esc(title)}</h1>
      ${subtitle ? `<p class="text-sm text-slate-500 mt-1">${esc(subtitle)}</p>` : ''}
      <div class="sf-stepper mt-3">
        ${Array.from({ length: TOTAL_STEPS }).map((_, i) =>
          `<div class="sf-seg ${i < sf.step ? 'done' : i === sf.step ? 'active' : ''}"></div>`).join('')}
      </div>
    </div>`;
  }

  function shellHtml(eyebrow, title, subtitle, bodyHtml, bottomHtml) {
    return `<div class="max-w-lg mx-auto min-h-screen flex flex-col bg-slate-50">
      ${headerHtml(eyebrow, title, subtitle)}
      <div class="flex-1 px-5 py-3 pb-32">${bodyHtml}</div>
      <div class="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 px-5 py-3 z-10"
           style="padding-bottom:calc(12px + env(safe-area-inset-bottom));">
        <div class="max-w-lg mx-auto">${bottomHtml}</div>
      </div>
    </div>`;
  }

  function bindChrome() {
    $('#sf-back')?.addEventListener('click', goBack);
    $('#sf-exit')?.addEventListener('click', tryExit);
  }

  function render() {
    const wiz = $('#shift-wizard');
    if (sf.done) { renderDone(wiz); return; }
    switch (sf.step) {
      case 0: renderVehicle(wiz); break;
      case 1: renderChecklist(wiz); break;
      case 2: renderPhotos(wiz); break;
      case 3: renderKm(wiz); break;
      case 4: renderIssues(wiz); break;
      case 5: renderConfirm(wiz); break;
    }
    wiz.scrollTop = 0;
  }

  // ---------- helpers de dominio ----------

  function selectedVehicle() {
    return sf.vehicles.find(v => v.id === sf.vehicleId) || null;
  }

  function issueItems() {
    return ckItems.filter(i => sf.checklist[i.id] === 'issue');
  }

  // ¿El conductor marcó un golpe/daño? (ítem cuyo texto menciona golpe o daño,
  // marcado con novedad). El oficial pide adjuntar foto del golpe.
  function hasGolpe() {
    return ckItems.some(i => /golpe|dañ/i.test(i.label) && sf.checklist[i.id] === 'issue');
  }

  // Slot de foto del golpe (photo_type 'damage', enum ampliado en 0028). Opcional,
  // solo aparece si hay golpe marcado.
  const DAMAGE_SLOT = { id: 'damage', label: 'Foto del golpe / daño', detail: 'Acerca la cámara al daño reportado' };
  function activePhotoSlots() {
    return hasGolpe() ? [...PHOTO_SLOTS, DAMAGE_SLOT] : PHOTO_SLOTS;
  }

  // Ítems del checklist agrupados por sección, conservando el orden de ckItems.
  function checklistBySection() {
    const groups = [];
    const byCat = new Map();
    for (const it of ckItems) {
      const cat = it.category || 'General';
      if (!byCat.has(cat)) { byCat.set(cat, []); groups.push({ category: cat, items: byCat.get(cat) }); }
      byCat.get(cat).push(it);
    }
    return groups;
  }

  function maintenanceInfo(v) {
    const interval = v.maintenance_interval_km || 7000;
    const driven = (v.current_km || 0) - (v.last_maintenance_km || 0);
    const remaining = interval - driven;
    if (remaining <= 0)  return { tone: 'rose',  label: 'Cambio de aceite vencido' };
    if (remaining <= 500) return { tone: 'amber', label: `Cambio de aceite en ${fmtKm(remaining)} km` };
    return null;
  }

  function soatInfo(v) {
    if (!v.soat_expires_at) return null;
    const days = Math.floor((new Date(v.soat_expires_at + 'T00:00:00') - new Date()) / 86400000);
    if (days < 0)   return { tone: 'rose',  label: 'SOAT vencido' };
    if (days <= 30) return { tone: 'amber', label: `SOAT vence en ${days} d.` };
    return null;
  }

  const STATUS_ES = { available: null, in_use: 'En uso', reserved: 'Reservado', maintenance: 'En revisión', blocked: 'Cambio de aceite' };

  // ---------- Paso 1: vehículo ----------

  function renderVehicle(wiz) {
    const chip = (tone, label) => {
      const cls = tone === 'rose' ? 'bg-rose-100 text-rose-700'
        : tone === 'amber' ? 'bg-amber-100 text-amber-700'
        : 'bg-emerald-100 text-emerald-700';
      return `<span class="text-[11px] font-bold px-2 py-0.5 rounded-full ${cls}">${esc(label)}</span>`;
    };
    const rank = v => (v.status === 'available' || v.id === sf.myReservedVehicleId) ? 0 : 1;
    const rows = sf.vehicles
      .slice()
      .sort((a, b) => rank(a) - rank(b))
      .map(v => {
        const isMine = v.id === sf.myReservedVehicleId;       // mi propia reserva: seleccionable
        const disabled = v.status !== 'available' && !isMine;
        const isSel = sf.vehicleId === v.id;
        const chips = [];
        if (isMine) chips.push(chip('emerald', 'Tu reserva'));
        else if (STATUS_ES[v.status]) chips.push(chip('rose', STATUS_ES[v.status]));
        // El chip de estado ya dice "Cambio de aceite" si está bloqueado; evita duplicar.
        const mi = (v.status === 'blocked') ? null : maintenanceInfo(v); if (mi) chips.push(chip(mi.tone, mi.label));
        const si = soatInfo(v); if (si) chips.push(chip(si.tone, si.label));
        return `<button data-vehicle="${v.id}" ${disabled ? 'disabled' : ''}
          class="w-full text-left bg-white border-2 ${isSel ? 'border-brand' : 'border-slate-200'} rounded-2xl p-4 flex gap-3 items-start transition ${disabled ? 'opacity-50' : 'active:scale-[0.99]'}">
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="font-bold text-base text-ink">${esc(v.internal_code || v.license_plate)}</span>
              ${chips.join('')}
            </div>
            <p class="text-sm text-slate-600 mt-0.5">${esc([v.brand, v.model].filter(Boolean).join(' ') || 'Vehículo')} · ${v.capacity} pasajeros</p>
            <p class="text-xs text-slate-400 mt-1">Placa ${esc(v.license_plate)} · ${fmtKm(v.current_km)} km</p>
          </div>
          <div class="w-6 h-6 rounded-full border-2 ${isSel ? 'bg-brand border-brand text-white' : 'border-slate-300 text-transparent'} flex items-center justify-center shrink-0 mt-1 text-sm">✓</div>
        </button>`;
      }).join('');

    const anyAvail = sf.vehicles.some(v => v.status === 'available' || v.id === sf.myReservedVehicleId);
    const noAvailNote = (sf.vehicles.length && !anyAvail)
      ? `<div class="rounded-xl bg-amber-50 border border-amber-300 px-3.5 py-2.5 text-[12px] text-amber-800 mb-2.5">No hay vehículos disponibles ahora (en cambio de aceite, en revisión o en uso). Avísale a tu administrador.</div>`
      : '';
    wiz.innerHTML = shellHtml(
      `Inicio de turno · Paso 1 de ${TOTAL_STEPS}`,
      'Selecciona tu vehículo',
      'Elige el vehículo con el que vas a operar hoy.',
      `${noAvailNote}<div class="space-y-2.5">${rows}</div>`,
      `<button id="sf-next" class="w-full bg-brand text-white text-base font-bold py-3.5 rounded-xl hover:bg-brand-600 active:scale-[0.99] transition shadow-brand disabled:opacity-40 disabled:pointer-events-none" ${sf.vehicleId ? '' : 'disabled'}>
        Continuar a inspección →
      </button>${fastStartEligible() ? `
      <button id="sf-fast" class="w-full mt-2 bg-white border-2 border-brand text-brand-700 text-sm font-bold py-3 rounded-xl active:scale-[0.99] transition disabled:opacity-40 disabled:pointer-events-none" ${sf.vehicleId ? '' : 'disabled'}>⚡ Iniciar ahora · inspección después</button>
      <p class="text-[11px] text-slate-400 text-center mt-1.5">Cambio de turno apurado: arranca ya y haz la inspección dentro del plazo.</p>` : ''}`
    );
    bindChrome();
    wiz.querySelectorAll('[data-vehicle]').forEach(btn => {
      btn.addEventListener('click', () => { sf.vehicleId = btn.dataset.vehicle; render(); });
    });
    $('#sf-next').addEventListener('click', reserveAndAdvance);
    $('#sf-fast')?.addEventListener('click', onFastStart);
  }

  // Reserva dura: al avanzar a la inspección, reserva el vehículo para que otro
  // conductor no lo tome mientras inspeccionas. Si alguien lo tomó primero,
  // avisa y refresca la lista para elegir otro.
  async function reserveAndAdvance() {
    const v = selectedVehicle();
    if (!v) return;
    const btn = $('#sf-next');
    const prev = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Reservando vehículo…'; }
    try {
      const res = await Api.reserveVehicleForShift(v.id);
      sf.reuseShiftId = (res && res.shift_id) || sf.reuseShiftId;
      const prevReserved = sf.myReservedVehicleId;
      sf.myReservedVehicleId = v.id;
      // Reflejar el cambio en la lista en caché (sin otra llamada de red).
      sf.vehicles.forEach(x => {
        if (x.id === v.id) x.status = 'reserved';
        else if (x.id === prevReserved && x.status === 'reserved') x.status = 'available';
      });
      goNext();
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = prev; }
      const msg = (e && e.message) || '';
      if (/RESERVED_BY_ANOTHER|IN_USE_BY_ANOTHER|VEHICLE_IN_USE/.test(msg)) {
        sfToast('Otro conductor acaba de tomar ese vehículo. Elige otro.');
      } else if (/NOT_OPERABLE/.test(msg)) {
        sfToast('Ese vehículo quedó fuera de servicio. Elige otro.');
      } else if (/ALREADY_ON_SHIFT/.test(msg)) {
        sfToast('Ya tienes un turno activo.');
      } else if (/Failed to fetch|NetworkError/.test(msg)) {
        sfToast('Sin conexión. Verifica tu señal e inténtalo de nuevo.');
        return;
      } else {
        sfToast('No se pudo reservar el vehículo: ' + msg);
      }
      // En conflicto: deselecciona y refresca la lista para ver el estado real.
      sf.vehicleId = null;
      try { sf.vehicles = await Api.listVehiclesForShift(); } catch (_) { /* */ }
      render();
    }
  }

  // ---------- Paso 2: checklist ----------

  function renderChecklist(wiz) {
    const completed = ckItems.filter(i => sf.checklist[i.id]).length;
    const issues = issueItems().length;
    const allDone = completed === ckItems.length;

    const itemRow = (item) => {
      const v = sf.checklist[item.id];
      return `<div class="flex items-stretch border ${v === 'issue' ? 'bg-amber-50 border-amber-400' : 'bg-white border-slate-200'} rounded-2xl overflow-hidden">
        <div class="flex-1 px-4 py-3 min-w-0">
          <p class="text-[15px] font-medium text-ink leading-snug">${esc(item.label)}</p>
          ${item.detail ? `<p class="text-xs text-slate-400">${esc(item.detail)}</p>` : ''}
        </div>
        <button data-check="${item.id}" data-val="ok" aria-label="${esc(item.label)} en orden"
          class="w-12 border-l border-slate-200 flex items-center justify-center text-lg ${v === 'ok' ? 'bg-brand text-white' : 'text-slate-300'}">✓</button>
        <button data-check="${item.id}" data-val="issue" aria-label="${esc(item.label)} con novedad"
          class="w-12 border-l border-slate-200 flex items-center justify-center text-lg ${v === 'issue' ? 'bg-amber-500 text-white' : 'text-slate-300'}">⚠</button>
      </div>`;
    };
    const rows = checklistBySection().map(g => `
      <div class="mt-4 first:mt-0">
        <p class="text-[11px] font-bold uppercase tracking-wider text-brand-600 mb-1.5 px-1">${esc(g.category)}</p>
        <div class="space-y-2">${g.items.map(itemRow).join('')}</div>
      </div>`).join('');

    wiz.innerHTML = shellHtml(
      `Inicio de turno · Paso 2 de ${TOTAL_STEPS}`,
      'Inspección pre-operacional',
      'Revisa cada punto por sección. Marca ✓ si está bien o ⚠ si hay novedad.',
      `<div class="flex items-center justify-between mb-1">
        <p class="text-xs text-slate-500">${completed} de ${ckItems.length} revisados${issues ? ` · <span class="text-amber-600 font-semibold">${issues} con novedad</span>` : ''}</p>
        <button id="sf-all-ok" class="text-xs font-bold text-brand-600">Marcar todos OK</button>
      </div>
      ${rows}`,
      `<button id="sf-next" class="w-full bg-brand text-white text-base font-bold py-3.5 rounded-xl hover:bg-brand-600 active:scale-[0.99] transition shadow-brand disabled:opacity-40 disabled:pointer-events-none" ${allDone ? '' : 'disabled'}>
        ${allDone ? 'Continuar a fotos →' : `Falta marcar ${ckItems.length - completed}`}
      </button>`
    );
    bindChrome();
    $('#sf-all-ok').addEventListener('click', () => {
      ckItems.forEach(i => { if (!sf.checklist[i.id]) sf.checklist[i.id] = 'ok'; });
      render();
    });
    wiz.querySelectorAll('[data-check]').forEach(btn => {
      btn.addEventListener('click', () => {
        const { check, val } = btn.dataset;
        sf.checklist[check] = sf.checklist[check] === val ? null : val;
        if (!sf.checklist[check]) delete sf.checklist[check];
        render();
      });
    });
    $('#sf-next').addEventListener('click', goNext);
  }

  // ---------- Paso 3: fotos ----------

  async function compressPhoto(file, maxDim = 1280, quality = 0.8) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error('No se pudo leer la imagen'));
        i.src = url;
      });
      const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
      if (!blob) throw new Error('No se pudo comprimir la foto');
      return blob;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function renderPhotos(wiz) {
    // Las 5 fijas son obligatorias; la del golpe es opcional y solo aparece si
    // se marcó un golpe en el checklist.
    const takenFixed = PHOTO_SLOTS.filter(s => sf.photos[s.id]).length;
    const allTaken = takenFixed === PHOTO_SLOTS.length;
    const showDamage = hasGolpe();

    const cell = (s, badge, optional) => {
      const p = sf.photos[s.id];
      return `<button data-slot="${s.id}" class="text-left bg-white border-2 ${p ? 'border-brand' : optional ? 'border-amber-400' : 'border-slate-200'} rounded-2xl overflow-hidden active:scale-[0.99] transition">
        <div class="aspect-[4/3] relative bg-slate-100 flex items-center justify-center">
          ${p
            ? `<img src="${p.url}" alt="${esc(s.label)}" class="absolute inset-0 w-full h-full object-cover" />
               <span class="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-brand text-white text-xs flex items-center justify-center font-bold">✓</span>`
            : `<span class="text-2xl text-slate-300">📷</span>
               <span class="absolute top-1.5 right-1.5 text-[10px] font-bold ${optional ? 'bg-amber-100 border-amber-300 text-amber-700' : 'bg-slate-50 border-slate-200 text-slate-500'} border rounded-full px-2 py-0.5">${badge}</span>`}
        </div>
        <div class="px-3 py-2">
          <p class="text-sm font-semibold text-ink">${esc(s.label)}</p>
          <p class="text-[11px] ${optional && !p ? 'text-amber-600' : 'text-slate-400'}">${p ? 'Capturada · toca para repetir' : esc(s.detail)}</p>
        </div>
      </button>`;
    };
    const cells = PHOTO_SLOTS.map((s, i) => cell(s, `${i + 1}/5`)).join('')
      + (showDamage ? cell(DAMAGE_SLOT, 'golpe', true) : '');

    // Fotos adicionales libres, a criterio del conductor.
    const extraThumbs = sf.extraPhotos.map((p, i) => `
      <div class="relative aspect-square rounded-2xl overflow-hidden border-2 border-brand">
        <img src="${p.url}" alt="Foto adicional ${i + 1}" class="w-full h-full object-cover" />
        <button data-extra-rm="${i}" aria-label="Quitar foto adicional" class="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/60 text-white text-sm flex items-center justify-center active:scale-95">✕</button>
      </div>`).join('');
    const extraSection = `
      <div class="mt-5">
        <p class="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-2">Fotos adicionales · opcional</p>
        <div class="grid grid-cols-3 gap-2">
          ${extraThumbs}
          <button data-add-extra class="aspect-square rounded-2xl border-2 border-dashed border-slate-300 flex flex-col items-center justify-center text-slate-400 active:scale-[0.99] transition">
            <span class="text-2xl leading-none">＋</span>
            <span class="text-[11px] font-semibold mt-1">Agregar foto</span>
          </button>
        </div>
        <p class="text-[11px] text-slate-400 mt-1.5">Si ves algo que valga la pena registrar, agrégalo (las que quieras).</p>
      </div>`;

    wiz.innerHTML = shellHtml(
      `Inicio de turno · Paso 3 de ${TOTAL_STEPS}`,
      'Fotos del vehículo',
      showDamage ? '5 ángulos + la foto del golpe que reportaste.' : '5 ángulos. Toca cada uno para capturar con la cámara.',
      `<div class="grid grid-cols-2 gap-2.5">${cells}</div>
       ${extraSection}
       <input id="sf-photo-input" type="file" accept="image/*" capture="environment" class="hidden" />
       <p id="sf-photo-state" class="text-xs text-slate-400 mt-3"></p>`,
      `<button id="sf-next" class="w-full bg-brand text-white text-base font-bold py-3.5 rounded-xl hover:bg-brand-600 active:scale-[0.99] transition shadow-brand disabled:opacity-40 disabled:pointer-events-none" ${allTaken ? '' : 'disabled'}>
        ${allTaken ? 'Continuar a kilometraje →' : `Faltan ${PHOTO_SLOTS.length - takenFixed} foto${PHOTO_SLOTS.length - takenFixed === 1 ? '' : 's'}`}
      </button>`
    );
    bindChrome();
    const input = $('#sf-photo-input');
    wiz.querySelectorAll('[data-slot]').forEach(btn => {
      btn.addEventListener('click', () => { sf._slot = btn.dataset.slot; input.click(); });
    });
    wiz.querySelector('[data-add-extra]')?.addEventListener('click', () => { sf._slot = '__extra__'; input.click(); });
    wiz.querySelectorAll('[data-extra-rm]').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = parseInt(btn.dataset.extraRm, 10);
        const p = sf.extraPhotos[i];
        if (p && p.url) URL.revokeObjectURL(p.url);
        sf.extraPhotos.splice(i, 1);
        render();
      });
    });
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.value = '';
      if (!file || !sf._slot) return;
      const stateEl = $('#sf-photo-state');
      if (stateEl) stateEl.textContent = 'Procesando foto…';
      try {
        const blob = await compressPhoto(file);
        if (sf._slot === '__extra__') {
          sf.extraPhotos.push({ blob, url: URL.createObjectURL(blob), size: blob.size });
        } else {
          const prev = sf.photos[sf._slot];
          if (prev && prev.url) URL.revokeObjectURL(prev.url);
          sf.photos[sf._slot] = { blob, url: URL.createObjectURL(blob), size: blob.size };
        }
        sf._slot = null;
        render();
      } catch (e) {
        console.error(e);
        if (stateEl) stateEl.textContent = '';
        sfToast('No pudimos procesar la foto. Intenta de nuevo.');
      }
    });
    $('#sf-next').addEventListener('click', goNext);
  }

  // ---------- Paso 4: kilometraje ----------

  function renderKm(wiz) {
    const v = selectedVehicle();
    const ref = v ? (v.current_km || 0) : 0;
    const hintFor = (raw) => {
      if (raw === '') return '';
      const diff = Number(raw) - ref;
      if (diff < 0)    return `<p class="text-sm text-rose-600 font-semibold mt-2">⚠ Menor a la última lectura registrada. Revisa el número.</p>`;
      if (diff >= 200) return `<p class="text-sm text-amber-600 font-semibold mt-2">⚠ +${fmtKm(diff)} km desde la última lectura. ¿Estás seguro?</p>`;
      return `<p class="text-sm text-emerald-600 font-semibold mt-2">✓ +${fmtKm(diff)} km desde la última lectura — coherente.</p>`;
    };

    wiz.innerHTML = shellHtml(
      `Inicio de turno · Paso 4 de ${TOTAL_STEPS}`,
      'Kilometraje inicial',
      'Lee el número exacto del odómetro.',
      `<div class="bg-white border border-slate-200 rounded-2xl p-5 text-center shadow-card">
        <p class="text-[11px] font-bold uppercase tracking-wider text-slate-400">Última lectura registrada</p>
        <p class="text-sm text-slate-500 mt-0.5 mb-4">${fmtKm(ref)} km · ${esc(v ? (v.internal_code || v.license_plate) : '')}</p>
        <input id="sf-km" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="7" autocomplete="off"
          value="${esc(sf.km)}" placeholder="${fmtKm(ref)}"
          class="w-full text-center text-4xl font-bold tracking-tight text-ink bg-transparent border-b-2 border-slate-200 focus:border-brand outline-none pb-2 tabular-nums" />
        <div id="sf-km-hint">${hintFor(sf.km)}</div>
      </div>`,
      `<button id="sf-next" class="w-full bg-brand text-white text-base font-bold py-3.5 rounded-xl hover:bg-brand-600 active:scale-[0.99] transition shadow-brand disabled:opacity-40 disabled:pointer-events-none" ${sf.km !== '' && Number(sf.km) - ref >= 0 ? '' : 'disabled'}>
        Continuar →
      </button>`
    );
    bindChrome();
    const kmInput = $('#sf-km');
    // El hint y el botón se actualizan en sitio (sin re-render: un re-render en
    // blur se tragaría el primer toque del botón Continuar en móvil).
    kmInput.addEventListener('input', () => {
      sf.km = kmInput.value.replace(/\D/g, '').slice(0, 7);
      if (kmInput.value !== sf.km) kmInput.value = sf.km;
      $('#sf-km-hint').innerHTML = hintFor(sf.km);
      $('#sf-next').disabled = !(sf.km !== '' && Number(sf.km) - ref >= 0);
    });
    setTimeout(() => kmInput.focus(), 60);
    $('#sf-next').addEventListener('click', goNext);
  }

  // ---------- Paso 5: novedades ----------

  function renderIssues(wiz) {
    const issues = issueItems();
    const sevOptions = [
      { id: 'leve',  label: 'Sí, es leve',          detail: 'Cosmético o sin riesgo. Operación normal.',              cls: 'emerald' },
      { id: 'media', label: 'Sí, pero con cuidado', detail: 'Se notifica al admin. Operación con seguimiento.',       cls: 'amber' },
      { id: 'grave', label: 'No, es grave',         detail: 'Bloquea la operación. El vehículo queda en revisión.',   cls: 'rose' },
    ];

    let body;
    if (issues.length) {
      const issueChips = issues.map(i =>
        `<span class="text-xs font-semibold bg-amber-100 text-amber-800 rounded-full px-2.5 py-1">${esc(i.label)}</span>`).join(' ');
      const sevBtns = sevOptions.map(o => {
        const isSel = sf.severity === o.id;
        const ring = { emerald: 'border-emerald-500', amber: 'border-amber-500', rose: 'border-rose-500' }[o.cls];
        const dot  = { emerald: 'bg-emerald-500', amber: 'bg-amber-500', rose: 'bg-rose-500' }[o.cls];
        return `<button data-sev="${o.id}" class="w-full text-left bg-white border-2 ${isSel ? ring : 'border-slate-200'} rounded-2xl p-4 flex gap-3 items-start active:scale-[0.99] transition">
          <span class="w-5 h-5 rounded-full border-2 ${isSel ? `${dot} border-transparent` : 'border-slate-300'} shrink-0 mt-0.5"></span>
          <span class="flex-1">
            <span class="block text-[15px] font-semibold text-ink">${esc(o.label)}</span>
            <span class="block text-xs text-slate-500 mt-0.5">${esc(o.detail)}</span>
          </span>
        </button>`;
      }).join('');
      const graveWarn = sf.severity === 'grave'
        ? `<div class="mt-3 p-3 rounded-xl bg-rose-50 border border-rose-200 text-sm text-rose-700">
            ⚠ Se registrará la novedad y <strong>no podrás iniciar el turno</strong> con este vehículo. Quedará en revisión para el admin.
          </div>` : '';
      body = `<div class="bg-amber-50 border border-amber-300 rounded-2xl p-4 mb-4">
          <p class="text-sm font-semibold text-amber-900 mb-2">Puntos con novedad</p>
          <div class="flex flex-wrap gap-1.5">${issueChips}</div>
        </div>
        <p class="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-2">¿Puedes operar igual?</p>
        <div class="space-y-2">${sevBtns}</div>
        ${graveWarn}
        <label class="block mt-4">
          <span class="text-xs font-semibold text-slate-600 uppercase tracking-wide">Describe la novedad</span>
          <textarea id="sf-note" rows="3" maxlength="400" placeholder="Ej: llanta delantera derecha baja de presión…"
            class="mt-1 w-full border border-slate-300 rounded-xl px-3 py-2 text-base focus:border-brand focus:ring-2 focus:ring-brand-100 outline-none resize-none bg-white">${esc(sf.note)}</textarea>
        </label>`;
    } else {
      body = `<div class="bg-white border border-slate-200 rounded-2xl p-6 text-center shadow-card">
          <div class="w-14 h-14 rounded-full bg-emerald-100 text-emerald-600 text-2xl flex items-center justify-center mx-auto mb-3">✓</div>
          <p class="text-base font-bold text-ink">Todo en orden</p>
          <p class="text-sm text-slate-500 mt-1">Marcaste todos los puntos en buen estado.</p>
        </div>
        <label class="block mt-4">
          <span class="text-xs font-semibold text-slate-600 uppercase tracking-wide">Observación opcional</span>
          <textarea id="sf-note" rows="3" maxlength="400" placeholder="Algo que quieras dejar registrado…"
            class="mt-1 w-full border border-slate-300 rounded-xl px-3 py-2 text-base focus:border-brand focus:ring-2 focus:ring-brand-100 outline-none resize-none bg-white">${esc(sf.note)}</textarea>
        </label>`;
    }

    const canContinue = !issues.length || !!sf.severity;
    wiz.innerHTML = shellHtml(
      `Inicio de turno · Paso 5 de ${TOTAL_STEPS}`,
      issues.length ? 'Reporta las novedades' : 'Observaciones',
      issues.length ? 'Clasifica la gravedad. El admin decide cómo proceder.' : 'Nada que reportar. Puedes continuar.',
      body,
      `<button id="sf-next" class="w-full bg-brand text-white text-base font-bold py-3.5 rounded-xl hover:bg-brand-600 active:scale-[0.99] transition shadow-brand disabled:opacity-40 disabled:pointer-events-none" ${canContinue ? '' : 'disabled'}>
        Continuar a confirmación →
      </button>`
    );
    bindChrome();
    wiz.querySelectorAll('[data-sev]').forEach(btn => {
      btn.addEventListener('click', () => {
        sf.note = $('#sf-note') ? $('#sf-note').value : sf.note;
        sf.severity = btn.dataset.sev;
        render();
      });
    });
    $('#sf-note')?.addEventListener('input', (e) => { sf.note = e.target.value; });
    $('#sf-next').addEventListener('click', () => {
      sf.note = $('#sf-note') ? $('#sf-note').value.trim() : sf.note;
      if (issueItems().length && !sf.note) {
        sfToast('Describe brevemente la novedad antes de continuar.');
        return;
      }
      goNext();
    });
  }

  // ---------- Paso 6: confirmación ----------

  function renderConfirm(wiz) {
    const v = selectedVehicle();
    const issues = issueItems();
    if (sf.severity === 'grave') sf.isApt = false; // novedad grave obliga NO APTO
    const apt = sf.isApt;
    const blocked = !apt;
    const sevLabel = { leve: 'Leve — operación normal', media: 'Media — con seguimiento', grave: 'Grave — bloquea operación' }[sf.severity] || '';
    const driverName = (sf.profile && sf.profile.full_name) || 'Conductor';

    const row = (icon, label, value, tone) => `<div class="flex items-center gap-3 px-4 py-3.5 border-b border-slate-100 last:border-0">
      <div class="w-9 h-9 rounded-xl bg-slate-100 flex items-center justify-center shrink-0">${icon}</div>
      <div class="flex-1 min-w-0">
        <p class="text-xs text-slate-400">${esc(label)}</p>
        <p class="text-[15px] font-semibold text-ink">${value}</p>
      </div>
      <span class="w-2 h-2 rounded-full ${tone === 'warn' ? 'bg-amber-500' : 'bg-emerald-500'} shrink-0"></span>
    </div>`;

    const issuesBlock = issues.length
      ? `<div class="px-4 py-3 border-b border-slate-100">
          <p class="text-xs text-slate-400 mb-1.5">Novedades</p>
          <div class="flex flex-wrap gap-1.5 mb-1.5">${issues.map(i => `<span class="text-xs font-semibold bg-amber-100 text-amber-800 rounded-full px-2.5 py-0.5">${esc(i.label)}</span>`).join('')}</div>
          <p class="text-xs text-slate-500">Gravedad: <strong class="${sf.severity === 'grave' ? 'text-rose-600' : sf.severity === 'media' ? 'text-amber-600' : 'text-emerald-600'}">${esc(sevLabel)}</strong></p>
        </div>` : '';

    const aptBlock = `
      <p class="text-[11px] font-bold uppercase tracking-wider text-slate-400 mt-4 mb-2">Estado del vehículo</p>
      <div class="grid grid-cols-2 gap-2">
        <button data-apt="yes" ${sf.severity === 'grave' ? 'disabled' : ''} class="rounded-2xl border-2 p-3 text-left transition ${apt ? 'border-emerald-500 bg-emerald-50' : 'border-slate-200 bg-white'} ${sf.severity === 'grave' ? 'opacity-40 pointer-events-none' : 'active:scale-[0.99]'}">
          <span class="block text-[15px] font-extrabold ${apt ? 'text-emerald-700' : 'text-ink'}">APTO</span>
          <span class="block text-[11px] text-slate-500">Para operar</span>
        </button>
        <button data-apt="no" class="rounded-2xl border-2 p-3 text-left transition active:scale-[0.99] ${!apt ? 'border-rose-500 bg-rose-50' : 'border-slate-200 bg-white'}">
          <span class="block text-[15px] font-extrabold ${!apt ? 'text-rose-700' : 'text-ink'}">NO APTO</span>
          <span class="block text-[11px] text-slate-500">No operar · suspende</span>
        </button>
      </div>
      ${sf.severity === 'grave' ? `<p class="text-[11px] text-rose-600 mt-1.5">La novedad grave obliga a marcar NO APTO.</p>` : ''}`;

    const signBlock = `
      <label class="mt-4 flex items-start gap-3 p-3.5 rounded-2xl border border-slate-200 bg-white cursor-pointer">
        <input type="checkbox" id="sf-sign" class="mt-0.5 w-5 h-5 accent-brand shrink-0" ${sf.signed ? 'checked' : ''} />
        <span class="text-sm text-slate-600">Confirmo que la información de esta inspección es veraz. <span class="block font-semibold text-ink mt-0.5">${esc(driverName)} · ${esc(new Date().toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' }))}</span></span>
      </label>`;

    wiz.innerHTML = shellHtml(
      `Inicio de turno · Paso 6 de ${TOTAL_STEPS}`,
      'Confirma e inicia',
      blocked ? 'Marcaste NO APTO: el turno no se inicia y el vehículo queda en revisión.' : 'Revisa el resumen, marca el estado y firma para arrancar.',
      `<div class="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-card">
        ${row('🚗', 'Vehículo', `${esc(v.internal_code || v.license_plate)} · ${esc([v.brand, v.model].filter(Boolean).join(' '))}`, 'ok')}
        ${row('✓', 'Inspección', issues.length ? `${ckItems.length - issues.length} OK · ${issues.length} con novedad` : `${ckItems.length} de ${ckItems.length} OK`, issues.length ? 'warn' : 'ok')}
        ${row('📷', 'Fotos', `${PHOTO_SLOTS.filter(s => sf.photos[s.id]).length} de ${PHOTO_SLOTS.length}${sf.photos.damage ? ' + golpe' : ''}${sf.extraPhotos.length ? ` + ${sf.extraPhotos.length} adicional${sf.extraPhotos.length === 1 ? '' : 'es'}` : ''} capturadas`, 'ok')}
        ${row('🛞', 'Kilometraje inicial', `${fmtKm(sf.km)} km`, 'ok')}
        ${issuesBlock}
      </div>
      ${aptBlock}
      ${signBlock}
      <div class="mt-3 p-3 rounded-xl bg-slate-100 text-xs text-slate-500 flex gap-2 items-start">
        <span>🔒</span>
        <span>Al confirmar registramos la inspección con tu usuario y la hora exacta. Necesitas señal para enviar las fotos.</span>
      </div>
      <p id="sf-save-state" class="text-sm text-slate-500 mt-3 text-center"></p>`,
      blocked
        ? `<button id="sf-confirm" class="w-full bg-rose-600 text-white text-base font-bold py-3.5 rounded-xl hover:bg-rose-700 active:scale-[0.99] transition disabled:opacity-40 disabled:pointer-events-none" ${sf.signed ? '' : 'disabled'}>${sf.completing ? 'Registrar NO APTO' : 'Registrar NO APTO y suspender'}</button>`
        : `<button id="sf-confirm" class="w-full bg-brand text-white text-base font-bold py-3.5 rounded-xl hover:bg-brand-600 active:scale-[0.99] transition shadow-brand disabled:opacity-40 disabled:pointer-events-none" ${sf.signed ? '' : 'disabled'}>${sf.completing ? '✓ Guardar inspección' : '⚡ Iniciar turno'}</button>`
    );
    bindChrome();
    wiz.querySelectorAll('[data-apt]').forEach(btn => {
      btn.addEventListener('click', () => { sf.isApt = btn.dataset.apt === 'yes'; render(); });
    });
    $('#sf-sign')?.addEventListener('change', (e) => {
      sf.signed = e.target.checked;
      const c = $('#sf-confirm'); if (c) c.disabled = !sf.signed;
    });
    $('#sf-confirm').addEventListener('click', onConfirm);
  }

  async function onConfirm() {
    if (sf.saving) return;
    sf.saving = true;
    const btn = $('#sf-confirm');
    const stateEl = $('#sf-save-state');
    const setState = (t) => { if (stateEl) stateEl.textContent = t; };
    btn.disabled = true;

    const v = selectedVehicle();
    const issues = issueItems();
    const blocked = !sf.isApt; // NO APTO → no se inicia el turno
    const org = sf.profile.organization_id;
    const openingKm = Number(sf.km);

    try {
      let shiftId;
      if (sf.completing) {
        // Turno ya activo (arrancó diferido): solo registramos la inspección.
        shiftId = sf.reuseShiftId;
      } else {
        setState('Creando el turno…');
        shiftId = await Api.createShiftDraft({
          driverId: sf.driverId,
          organizationId: org,
          vehicleId: v.id,
          openingKm,
          reuseId: sf.reuseShiftId,
        });
        sf.reuseShiftId = shiftId; // si algo falla más adelante, el retry lo reutiliza
      }

      // Idempotencia: si este turno ya tiene inspección inicial (intento previo
      // interrumpido), reusamos su id en vez de generar otro y chocar contra
      // inspections_one_kind_per_shift. Así el retry actualiza, no duplica.
      let inspectionId = null;
      try { inspectionId = await Api.getExistingInitialInspectionId(shiftId); }
      catch (e) { /* sin conexión/permiso: seguimos con uno nuevo */ }
      if (!inspectionId) {
        inspectionId = (crypto.randomUUID && crypto.randomUUID()) ||
          'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
          });
      }
      const today = new Date().toISOString().slice(0, 10);

      const slots = activePhotoSlots().filter(s => sf.photos[s.id]);
      const photoRows = [];
      for (let i = 0; i < slots.length; i++) {
        const s = slots[i];
        setState(`Subiendo fotos (${i + 1}/${slots.length})…`);
        const path = `${org}/${v.id}/${today}/${inspectionId}/${s.id}.jpg`;
        await Api.uploadInspectionPhoto(path, sf.photos[s.id].blob);
        photoRows.push({
          inspection_id: inspectionId,
          organization_id: org,
          photo_type: s.id,
          storage_path: path,
          size_bytes: sf.photos[s.id].size,
        });
      }

      // Fotos adicionales (a criterio del conductor): photo_type 'extra', path único.
      for (let i = 0; i < sf.extraPhotos.length; i++) {
        const ep = sf.extraPhotos[i];
        setState(`Subiendo foto adicional (${i + 1}/${sf.extraPhotos.length})…`);
        const path = `${org}/${v.id}/${today}/${inspectionId}/extra-${i + 1}.jpg`;
        await Api.uploadInspectionPhoto(path, ep.blob);
        photoRows.push({
          inspection_id: inspectionId,
          organization_id: org,
          photo_type: 'extra',
          storage_path: path,
          size_bytes: ep.size,
        });
      }

      setState('Registrando inspección…');
      await Api.createInspection({
        id: inspectionId,
        organization_id: org,
        shift_id: shiftId,
        vehicle_id: v.id,
        driver_id: sf.driverId,
        kind: 'initial',
        odometer_km: openingKm,
        // Snapshot del checklist para auditoría (sobrevive a cambios futuros del admin):
        checklist: {
          severity: sf.severity || null,
          items: ckItems.map(it => ({ id: it.id, label: it.label, hint: it.detail || null, category: it.category || null, result: sf.checklist[it.id] === 'issue' ? 'issue' : 'ok' })),
        },
        has_damage: issues.length > 0,
        is_apt: sf.isApt,
        signed_name: (sf.profile && sf.profile.full_name) || null,
        notes: sf.note || null,
      });
      await Api.addInspectionPhotos(photoRows);

      if (issues.length) {
        setState('Reportando novedad…');
        const sevMap = { leve: 'low', media: 'medium', grave: 'high' };
        const description = `Inspección de inicio de turno — ${issues.map(i => i.label).join(', ')}. ${sf.note || ''}`.trim();
        await Api.addIncident({
          organizationId: org,
          reporterId: sf.profile.id,
          shiftId,
          vehicleId: v.id,
          category: 'vehicle_problem',
          severity: sevMap[sf.severity] || 'low',
          description,
        });
      }

      if (sf.completing) {
        // La inspección quedó registrada; limpiamos el plazo. El turno sigue activo.
        setState('Guardando inspección…');
        try { await Api.clearInspectionDue(shiftId); } catch (e) { /* el cron igual la ve hecha */ }
        sf.done = blocked ? 'completed-noapt' : 'completed';
      } else if (blocked) {
        setState('Suspendiendo turno…');
        const reason = issues.length
          ? `NO APTO — ${issues.map(i => i.label).join(', ')} — ${sf.note || 'sin detalle'}`
          : `NO APTO — ${sf.note || 'marcado por el conductor'}`;
        await Api.abortShift(shiftId, reason);
        sf.done = 'aborted';
      } else {
        setState('Iniciando turno…');
        await Api.startShift(shiftId);
        sf.done = 'started';
      }
      sf.reuseShiftId = null;
      sf.completing = false;
      render();
    } catch (e) {
      console.error(e);
      setState('');
      btn.disabled = false;
      sf.saving = false;
      const msg = (e && e.message) || 'error desconocido';
      if (msg.includes('VEHICLE_IN_USE')) sfToast('Ese vehículo ya está en uso en otro turno. Elige otro.');
      else if (msg.includes('VEHICLE_NOT_OPERABLE')) sfToast('El vehículo quedó fuera de servicio. Elige otro.');
      else if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) sfToast('Sin conexión. Verifica tu señal y toca el botón de nuevo: el avance se conserva.');
      else sfToast('No se pudo completar: ' + msg);
    }
  }

  // ---------- pantalla final ----------

  function renderDone(wiz) {
    const d = sf.done;
    const v = selectedVehicle();
    const veh = esc(v ? (v.internal_code || v.license_plate) : 'vehículo');
    const dueTime = sf.fastDue ? new Date(sf.fastDue).toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Bogota' }) : '';
    let icon, iconCls, title, body, btnCls;
    if (d === 'aborted') {
      icon = '⚠'; iconCls = 'bg-rose-100 text-rose-600'; title = 'Turno suspendido';
      body = 'La novedad quedó registrada y el vehículo pasó a revisión. El admin te indicará cómo proceder.'; btnCls = 'bg-ink text-white';
    } else if (d === 'deferred') {
      icon = '⚡'; iconCls = 'bg-amber-100 text-amber-600'; title = '¡En ruta! Inspección pendiente';
      body = `Iniciaste con el ${veh}.${dueTime ? ` Tienes hasta las ${dueTime} para hacer la inspección` : ' Haz la inspección dentro del plazo'} — hazla desde la tarjeta del turno. Si no, será un strike.`; btnCls = 'bg-brand text-white shadow-brand';
    } else if (d === 'completed') {
      icon = '✓'; iconCls = 'bg-emerald-100 text-emerald-600'; title = 'Inspección lista';
      body = 'Tu inspección quedó registrada. Sigue tu turno con tranquilidad.'; btnCls = 'bg-brand text-white shadow-brand';
    } else if (d === 'completed-noapt') {
      icon = '⚠'; iconCls = 'bg-rose-100 text-rose-600'; title = 'Inspección registrada · NO APTO';
      body = 'Registramos el vehículo como NO APTO. El administrador queda notificado; detén la operación según te indique.'; btnCls = 'bg-ink text-white';
    } else {
      icon = '✓'; iconCls = 'bg-brand-50 text-brand-600'; title = '¡Listo, en ruta!';
      body = `Turno activo con el ${veh} desde ${fmtKm(sf.km)} km. Maneja con calma.`; btnCls = 'bg-brand text-white shadow-brand';
    }
    wiz.innerHTML = `<div class="max-w-lg mx-auto min-h-screen flex flex-col items-center justify-center text-center px-8 bg-slate-50">
      <div class="w-20 h-20 rounded-full ${iconCls} text-4xl flex items-center justify-center mb-5">${icon}</div>
      <h1 class="text-2xl font-extrabold text-ink">${title}</h1>
      <p class="text-[15px] text-slate-500 mt-2 leading-relaxed max-w-xs">${body}</p>
      <button id="sf-done-btn" class="mt-8 px-6 py-3 rounded-xl ${btnCls} font-bold active:scale-[0.98] transition">Volver al inicio</button>
    </div>`;
    $('#sf-done-btn').addEventListener('click', () => {
      Object.values(sf.photos).forEach(p => p && p.url && URL.revokeObjectURL(p.url));
      sf.photos = {};
      sf.extraPhotos.forEach(p => p && p.url && URL.revokeObjectURL(p.url));
      sf.extraPhotos = [];
      sf.completing = false;
      closeWizard();
      renderCard();
    });
  }

  // ====================================================================
  // Cierre de turno (Etapa 2)
  // ====================================================================
  function openClose(shift) {
    stopElapsedTimer();
    sf.activeShift = shift;
    sf.close = newCloseState();
    const wiz = $('#shift-wizard');
    wiz.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    const nav = document.getElementById('driver-nav');
    sf._navWasShown = !!(nav && nav.classList.contains('show'));
    if (sf._navWasShown) nav.classList.remove('show');
    document.getElementById('driver-save-bar')?.classList.add('hidden');
    renderClose();
  }

  function closeKmNum() { const d = String(sf.close.km).replace(/\D/g, ''); return d ? parseInt(d, 10) : 0; }
  function closeOpenKm() { return Number(sf.activeShift && sf.activeShift.opening_km) || 0; }
  function closeKmValid() { const n = closeKmNum(); return n > 0 && n >= closeOpenKm(); }
  // Comprobante de tanqueo OBLIGATORIO: al menos uno, y cada uno con valor > 0.
  // No se habilita "Confirmar cierre" hasta cumplirlo.
  function receiptsValid() { return sf.close.receipts.length >= 1 && sf.close.receipts.every(r => (r.amount || 0) > 0); }
  function novedadValid() { return !sf.close.novedad || sf.close.novedadText.trim().length > 0; }
  function closeAllValid() { return closeKmValid() && sf.close.attest && novedadValid() && receiptsValid(); }
  function fuelTotal() { return sf.close.receipts.reduce((s, r) => s + (r.amount || 0), 0); }

  function updateCloseConfirm() {
    const btn = $('#cl-confirm'); if (btn) btn.disabled = !closeAllValid() || sf.close.saving;
    const tot = $('#cl-fuel-total'); if (tot) tot.textContent = '$' + fuelTotal().toLocaleString('es-CO');
  }

  function onCloseKm(inp) {
    const d = inp.value.replace(/\D/g, '');
    const n = d ? parseInt(d, 10) : 0;
    inp.value = d ? n.toLocaleString('es-CO') : '';
    sf.close.km = d;
    const openKm = closeOpenKm();
    const delta = n - openKm;
    const dEl = $('#cl-km-delta'), hint = $('#cl-km-hint');
    if (!d) {
      if (dEl) { dEl.textContent = '—'; dEl.className = 'text-[12px] font-bold text-slate-400'; }
      if (hint) { hint.textContent = 'Ingresa el odómetro actual del vehículo.'; hint.className = 'text-[12px] text-slate-400 mt-2'; }
    } else if (delta < 0) {
      if (dEl) { dEl.textContent = 'Revisar'; dEl.className = 'text-[12px] font-bold text-rose-500'; }
      if (hint) { hint.textContent = `El km final no puede ser menor a ${openKm.toLocaleString('es-CO')}.`; hint.className = 'text-[12px] text-rose-500 mt-2'; }
    } else {
      if (dEl) { dEl.textContent = '+' + delta.toLocaleString('es-CO') + ' km'; dEl.className = 'text-[12px] font-bold text-emerald-600'; }
      if (hint) {
        const warn = delta > 1500 ? ' · <span class="text-amber-600 font-semibold">¿km muy alto? verifica</span>' : ' · <span class="text-brand-600 font-semibold">suma a tus recompensas 🎁</span>';
        hint.innerHTML = `+<strong>${delta.toLocaleString('es-CO')} km</strong> recorridos${warn}`;
        hint.className = 'text-[12px] text-slate-500 mt-2';
      }
    }
    updateCloseConfirm();
  }

  function setCloseNovedad(on) { sf.close.novedad = on; if (!on) { sf.close.novedadText = ''; } renderClose(); }

  async function onAddCloseMedia(input, kind) {
    const f = input.files && input.files[0]; input.value = '';
    if (!f) return;
    try {
      if (kind === 'photo') {
        const blob = await compressPhoto(f);
        sf.close.media.push({ kind: 'photo', blob, url: URL.createObjectURL(blob), size: blob.size });
      } else {
        if (f.size > 25 * 1024 * 1024) { sfToast('El video es muy pesado. Graba uno más corto.'); return; }
        sf.close.media.push({ kind: 'video', blob: f, url: URL.createObjectURL(f), size: f.size });
      }
      renderClose();
    } catch (e) { console.error(e); sfToast('No se pudo agregar la evidencia.'); }
  }
  function rmCloseMedia(i) { const m = sf.close.media[i]; if (m && m.url) URL.revokeObjectURL(m.url); sf.close.media.splice(i, 1); renderClose(); }

  async function onAddReceipt(input) {
    const f = input.files && input.files[0]; input.value = '';
    if (!f) return;
    try {
      const blob = await compressPhoto(f);
      sf.close.receipts.push({ blob, url: URL.createObjectURL(blob), amount: 0 });
      renderClose();
    } catch (e) { console.error(e); sfToast('No se pudo agregar el comprobante.'); }
  }
  function onReceiptAmount(i, inp) {
    const d = inp.value.replace(/\D/g, '');
    const n = d ? parseInt(d, 10) : 0;
    inp.value = n ? n.toLocaleString('es-CO') : '';
    if (sf.close.receipts[i]) sf.close.receipts[i].amount = n;
    updateCloseConfirm();
  }
  function rmReceipt(i) { const r = sf.close.receipts[i]; if (r && r.url) URL.revokeObjectURL(r.url); sf.close.receipts.splice(i, 1); renderClose(); }

  function renderClose() {
    if (sf.close.done) { renderCloseDone(); return; }
    const wiz = $('#shift-wizard');
    const sh = sf.activeShift || {};
    const v = sh.vehicles || {};
    const openKm = closeOpenKm();

    const mediaThumbs = sf.close.media.map((m, i) => `
      <div class="relative aspect-square rounded-xl overflow-hidden border border-slate-200">
        ${m.kind === 'photo' ? `<img src="${m.url}" class="w-full h-full object-cover">`
          : `<video src="${m.url}" class="w-full h-full object-cover" muted></video><span class="absolute inset-0 flex items-center justify-center text-white text-xl pointer-events-none">▶</span>`}
        <button data-rm-media="${i}" class="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 text-white text-[11px] leading-none flex items-center justify-center">✕</button>
      </div>`).join('');

    const receiptRows = sf.close.receipts.map((r, i) => `
      <div class="flex gap-3 items-center rounded-xl bg-white border border-slate-200 p-2.5">
        <img src="${r.url}" class="w-14 h-14 rounded-lg object-cover border border-slate-200 shrink-0">
        <div class="flex-1 min-w-0">
          <p class="text-[11px] font-bold uppercase tracking-wide text-slate-400">Valor pagado</p>
          <div class="flex items-center gap-1 mt-0.5"><span class="text-slate-400 font-bold text-sm">$</span>
            <input type="tel" inputmode="numeric" placeholder="0" data-receipt-amt="${i}" value="${r.amount ? r.amount.toLocaleString('es-CO') : ''}"
              class="w-full text-base font-extrabold text-ink bg-transparent focus:outline-none placeholder:text-slate-300 tabular-nums"></div>
        </div>
        <button data-rm-receipt="${i}" class="w-8 h-8 rounded-full bg-slate-100 text-slate-400 flex items-center justify-center shrink-0 active:scale-95">🗑</button>
      </div>`).join('');

    wiz.innerHTML = `<div class="max-w-lg mx-auto min-h-screen flex flex-col bg-slate-50">
      <div class="px-5 pt-4 pb-2" style="padding-top:calc(16px + env(safe-area-inset-top));">
        <div class="flex items-center justify-between mb-3">
          <button id="cl-back" class="w-9 h-9 rounded-full bg-white border border-slate-200 flex items-center justify-center text-slate-600 active:scale-95">✕</button>
          <span class="text-[11px] font-bold uppercase tracking-wider text-emerald-600">Cierre de turno</span>
          <span class="w-9"></span>
        </div>
        <h1 class="text-2xl font-extrabold text-ink leading-tight">Cerrar turno</h1>
        <p class="text-sm text-slate-500 mt-1">${esc(v.internal_code || v.license_plate || 'Vehículo')} · ${fmtElapsed(sh.start_at)} trabajado</p>
      </div>
      <div class="flex-1 px-5 py-3 pb-40 space-y-5">

        <section>
          <div class="flex items-center justify-between mb-2">
            <h3 class="text-[13px] font-bold uppercase tracking-wider text-slate-500">Kilometraje final</h3>
            <span id="cl-km-delta" class="text-[12px] font-bold text-slate-400">—</span>
          </div>
          <div class="rounded-2xl bg-white border border-slate-200 p-4">
            <div class="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-slate-400"><span>Inicio del turno</span><span>Ahora</span></div>
            <div class="flex items-center gap-3 mt-1.5">
              <span class="text-base text-slate-400 tabular-nums">${openKm.toLocaleString('es-CO')}</span>
              <div class="flex-1 border-t-2 border-dashed border-slate-200"></div>
              <div class="flex items-baseline gap-1">
                <input id="cl-km" type="tel" inputmode="numeric" placeholder="${(openKm + 280).toLocaleString('es-CO')}" value="${sf.close.km ? Number(sf.close.km).toLocaleString('es-CO') : ''}"
                  class="w-28 text-right text-2xl font-extrabold text-ink bg-transparent focus:outline-none placeholder:text-slate-300 tabular-nums border-b-2 border-brand-200 focus:border-brand-500">
                <span class="text-sm font-bold text-slate-400">km</span>
              </div>
            </div>
            <p id="cl-km-hint" class="text-[12px] text-slate-400 mt-2">Ingresa el odómetro actual del vehículo.</p>
          </div>
        </section>

        <section>
          <h3 class="text-[13px] font-bold uppercase tracking-wider text-slate-500 mb-2">¿Tuviste alguna novedad?</h3>
          <div class="grid grid-cols-2 gap-2">
            <button id="cl-nov-no" class="rounded-xl border-2 py-3 text-sm font-bold flex items-center justify-center gap-2 ${!sf.close.novedad ? 'border-emerald-400 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-white text-slate-500'}">✓ Sin novedades</button>
            <button id="cl-nov-si" class="rounded-xl border-2 py-3 text-sm font-bold flex items-center justify-center gap-2 ${sf.close.novedad ? 'border-brand-400 bg-brand-50 text-brand-700' : 'border-slate-200 bg-white text-slate-500'}">⚠ Reportar</button>
          </div>
          ${sf.close.novedad ? `<div class="pt-3 space-y-3">
            <textarea id="cl-nov-text" rows="3" placeholder="Describe la novedad: qué pasó, cuándo y dónde…" class="w-full rounded-xl border border-slate-200 bg-white p-3 text-sm text-ink placeholder:text-slate-400 focus:outline-none focus:border-brand-400 resize-none">${esc(sf.close.novedadText)}</textarea>
            <div>
              <p class="text-[12px] font-semibold text-slate-500 mb-2">Evidencia (foto o video corto)</p>
              <div class="grid grid-cols-4 gap-2">
                ${mediaThumbs}
                <button id="cl-add-photo" class="aspect-square rounded-xl border-2 border-dashed border-slate-300 bg-white flex flex-col items-center justify-center gap-1 text-slate-400 active:scale-95"><span class="text-lg">📷</span><span class="text-[9px] font-bold">Foto</span></button>
                <button id="cl-add-video" class="aspect-square rounded-xl border-2 border-dashed border-slate-300 bg-white flex flex-col items-center justify-center gap-1 text-slate-400 active:scale-95"><span class="text-lg">🎥</span><span class="text-[9px] font-bold">Video</span></button>
              </div>
              <input id="cl-file-photo" type="file" accept="image/*" capture="environment" class="hidden">
              <input id="cl-file-video" type="file" accept="video/*" capture="environment" class="hidden">
            </div>
          </div>` : ''}
        </section>

        <section>
          <div class="flex items-center justify-between mb-2">
            <h3 class="text-[13px] font-bold uppercase tracking-wider text-slate-500">Comprobantes de tanqueo <span class="text-rose-500">*</span></h3>
            <span id="cl-fuel-total" class="text-[12px] font-bold text-slate-400">$${fuelTotal().toLocaleString('es-CO')}</span>
          </div>
          <p class="text-[12px] ${sf.close.receipts.length ? 'text-slate-500' : 'text-rose-600 font-semibold'} mb-3 -mt-1">${sf.close.receipts.length ? 'Adjunta los recibos de gasolina pagados en el turno (foto + valor).' : 'Obligatorio: adjunta al menos un recibo de gasolina (foto + valor) para cerrar el turno.'}</p>
          <div class="space-y-2.5">${receiptRows}</div>
          <button id="cl-add-receipt" class="mt-2.5 w-full rounded-xl border-2 border-dashed border-brand-300 bg-brand-50 text-brand-700 font-bold py-3 text-sm flex items-center justify-center gap-2 active:scale-[.98]">＋ Agregar comprobante</button>
          <input id="cl-file-receipt" type="file" accept="image/*" capture="environment" class="hidden">
        </section>

        <label class="flex gap-3 items-start rounded-xl bg-white border border-slate-200 px-3.5 py-3 cursor-pointer">
          <input id="cl-attest" type="checkbox" class="mt-0.5 w-5 h-5 accent-brand-600 shrink-0" ${sf.close.attest ? 'checked' : ''}>
          <span class="text-[12.5px] text-slate-600 leading-snug">Confirmo que la información del cierre (kilometraje, novedades y comprobantes) es correcta.</span>
        </label>
      </div>
      <div class="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 px-5 py-3 z-10" style="padding-bottom:calc(12px + env(safe-area-inset-bottom));">
        <div class="max-w-lg mx-auto">
          <p id="cl-state" class="text-xs text-slate-500 text-center mb-1.5"></p>
          <button id="cl-confirm" class="w-full bg-brand text-white text-base font-extrabold py-3.5 rounded-xl shadow-brand active:scale-[0.99] transition disabled:opacity-40 disabled:pointer-events-none" disabled>Confirmar cierre de turno</button>
        </div>
      </div>
    </div>`;

    $('#cl-back').addEventListener('click', () => { stopElapsedTimer(); closeWizard(); renderCard(); });
    $('#cl-km').addEventListener('input', (e) => onCloseKm(e.target));
    $('#cl-nov-no').addEventListener('click', () => setCloseNovedad(false));
    $('#cl-nov-si').addEventListener('click', () => setCloseNovedad(true));
    $('#cl-attest').addEventListener('change', (e) => { sf.close.attest = e.target.checked; updateCloseConfirm(); });
    $('#cl-confirm').addEventListener('click', submitClose);
    const ntext = $('#cl-nov-text'); if (ntext) ntext.addEventListener('input', (e) => { sf.close.novedadText = e.target.value; updateCloseConfirm(); });
    const ap = $('#cl-add-photo'); if (ap) ap.addEventListener('click', () => $('#cl-file-photo').click());
    const av = $('#cl-add-video'); if (av) av.addEventListener('click', () => $('#cl-file-video').click());
    const fp = $('#cl-file-photo'); if (fp) fp.addEventListener('change', (e) => onAddCloseMedia(e.target, 'photo'));
    const fv = $('#cl-file-video'); if (fv) fv.addEventListener('change', (e) => onAddCloseMedia(e.target, 'video'));
    $('#cl-add-receipt').addEventListener('click', () => $('#cl-file-receipt').click());
    $('#cl-file-receipt').addEventListener('change', (e) => onAddReceipt(e.target));
    wiz.querySelectorAll('[data-rm-media]').forEach(b => b.addEventListener('click', () => rmCloseMedia(Number(b.dataset.rmMedia))));
    wiz.querySelectorAll('[data-rm-receipt]').forEach(b => b.addEventListener('click', () => rmReceipt(Number(b.dataset.rmReceipt))));
    wiz.querySelectorAll('[data-receipt-amt]').forEach(inp => inp.addEventListener('input', (e) => onReceiptAmount(Number(inp.dataset.receiptAmt), e.target)));
    updateCloseConfirm();
  }

  async function submitClose() {
    if (!closeAllValid() || sf.close.saving) return;
    sf.close.saving = true;
    const btn = $('#cl-confirm'); if (btn) btn.disabled = true;
    const setState = (t) => { const e = $('#cl-state'); if (e) e.textContent = t; };
    const sh = sf.activeShift;
    const org = sf.profile.organization_id;
    const today = new Date().toISOString().slice(0, 10);
    const closingKm = closeKmNum();
    try {
      const mediaPaths = [];
      if (sf.close.novedad) {
        for (let i = 0; i < sf.close.media.length; i++) {
          const m = sf.close.media[i];
          setState(`Subiendo evidencia (${i + 1}/${sf.close.media.length})…`);
          const ext = m.kind === 'video' ? 'mp4' : 'jpg';
          const path = `${org}/${sh.vehicle_id}/${today}/close-${sh.id}/media-${i + 1}.${ext}`;
          await Api.uploadShiftFile(path, m.blob, m.kind === 'video' ? (m.blob.type || 'video/mp4') : 'image/jpeg');
          mediaPaths.push(path);
        }
      }
      if (sf.close.receipts.length) {
        const rows = [];
        for (let i = 0; i < sf.close.receipts.length; i++) {
          const r = sf.close.receipts[i];
          setState(`Subiendo comprobante (${i + 1}/${sf.close.receipts.length})…`);
          const path = `${org}/${sh.vehicle_id}/${today}/close-${sh.id}/receipt-${i + 1}.jpg`;
          await Api.uploadShiftFile(path, r.blob, 'image/jpeg');
          rows.push({ organization_id: org, shift_id: sh.id, vehicle_id: sh.vehicle_id, driver_id: sf.driverId, amount_cop: r.amount, storage_path: path });
        }
        await Api.addFuelReceipts(rows);
      }
      setState('Cerrando turno…');
      const res = await Api.closeShift(sh.id, {
        closingKm, hasNovedad: sf.close.novedad, novedadText: sf.close.novedadText, severity: sf.close.severity, mediaPaths,
      });
      // ¿El vehículo quedó en cambio de aceite al cerrar? (para avisarle al conductor)
      let vehBlocked = false;
      try { vehBlocked = (await Api.getVehicleStatus(sh.vehicle_id)) === 'blocked'; } catch (e) { /* */ }
      sf.close.summary = {
        kmDriven: (res && res.km_driven != null) ? res.km_driven : Math.max(0, closingKm - (Number(sh.opening_km) || 0)),
        duration: fmtElapsed(sh.start_at),
        novedad: sf.close.novedad,
        receipts: sf.close.receipts.length,
        fuel: fuelTotal(),
        vehBlocked,
      };
      sf.close.done = true;
      sf.activeShift = null;
      renderClose();
    } catch (e) {
      console.error(e);
      sf.close.saving = false;
      if (btn) btn.disabled = false;
      setState('');
      const msg = (e && e.message) || 'error';
      if (/CLOSING_KM_LT_OPENING/.test(msg)) sfToast('El km final no puede ser menor al de apertura.');
      else if (/Failed to fetch|NetworkError/.test(msg)) sfToast('Sin conexión. Verifica tu señal y toca de nuevo: el avance se conserva.');
      else sfToast('No se pudo cerrar el turno: ' + msg);
    }
  }

  function renderCloseDone() {
    const wiz = $('#shift-wizard');
    const s = sf.close.summary || {};
    wiz.innerHTML = `<div class="max-w-lg mx-auto min-h-screen flex flex-col items-center justify-center text-center px-8 bg-slate-50">
      <div class="w-20 h-20 rounded-full bg-emerald-100 text-emerald-600 text-4xl flex items-center justify-center mb-5">✓</div>
      <h1 class="text-2xl font-extrabold text-ink">Turno cerrado</h1>
      <p class="text-[15px] text-slate-500 mt-2 leading-relaxed max-w-xs">${esc(s.duration || '')} en ruta. Tu reporte de cierre se envió al administrador.</p>
      ${s.vehBlocked ? `<div class="mt-5 w-full max-w-xs rounded-xl bg-amber-50 border border-amber-300 px-4 py-3 text-[13px] text-amber-800 text-left flex gap-2"><span>🛢️</span><span>El vehículo entró a <b>cambio de aceite</b>. No estará disponible para iniciar turno hasta que el administrador lo registre.</span></div>` : ''}
      <div class="mt-6 w-full max-w-xs rounded-2xl bg-white border border-slate-200 shadow-card divide-y divide-slate-100 text-left">
        <div class="flex justify-between px-4 py-3 text-sm"><span class="text-slate-500">Km recorridos</span><span class="font-bold text-emerald-600">+${(s.kmDriven || 0).toLocaleString('es-CO')} km</span></div>
        <div class="flex justify-between px-4 py-3 text-sm"><span class="text-slate-500">Duración</span><span class="font-bold text-ink">${esc(s.duration || '—')}</span></div>
        <div class="flex justify-between px-4 py-3 text-sm"><span class="text-slate-500">Novedades</span><span class="font-bold text-ink">${s.novedad ? '1 reportada' : 'Ninguna'}</span></div>
        <div class="flex justify-between px-4 py-3 text-sm"><span class="text-slate-500">Comprobantes</span><span class="font-bold text-ink">${s.receipts || 0}${s.fuel ? ' · $' + s.fuel.toLocaleString('es-CO') : ''}</span></div>
      </div>
      <button id="cl-done-btn" class="mt-8 px-6 py-3 rounded-xl bg-brand text-white shadow-brand font-bold active:scale-[0.98] transition">Volver al inicio</button>
    </div>`;
    $('#cl-done-btn').addEventListener('click', () => {
      sf.close.media.forEach(m => m && m.url && URL.revokeObjectURL(m.url));
      sf.close.receipts.forEach(r => r && r.url && URL.revokeObjectURL(r.url));
      sf.close = newCloseState();
      closeWizard();
      renderCard();
    });
  }

  // ====================================================================
  // Inicio diferido (inspección después) — ventana horaria + plazo
  // ====================================================================
  function fmtGrace(min) {
    const m = Number(min) || 90;
    return m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ' ' + (m % 60) + 'm' : ''}` : `${m} min`;
  }
  function fastStartEligible() {
    const s = sf.settings; if (!s || s.fast_start_enabled === false) return false;
    const from = s.fast_start_from_hour != null ? s.fast_start_from_hour : 12;
    const to = s.fast_start_to_hour != null ? s.fast_start_to_hour : 16;
    const h = new Date().getHours();          // hora del dispositivo (el servidor revalida)
    return h >= from && h < to;
  }

  async function onFastStart() {
    const v = selectedVehicle(); if (!v) return;
    const btn = $('#sf-fast'); if (btn) { btn.disabled = true; btn.textContent = 'Reservando…'; }
    try {
      const res = await Api.reserveVehicleForShift(v.id);
      sf.reuseShiftId = (res && res.shift_id) || sf.reuseShiftId;
      sf.myReservedVehicleId = v.id;
      renderFastKm();
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = '⚡ Iniciar ahora · inspección después'; }
      const msg = (e && e.message) || '';
      if (/RESERVED_BY_ANOTHER|IN_USE/.test(msg)) { sfToast('Otro conductor tomó ese vehículo. Elige otro.'); sf.vehicleId = null; try { sf.vehicles = await Api.listVehiclesForShift(); } catch (_) { /* */ } render(); }
      else sfToast('No se pudo iniciar: ' + msg);
    }
  }

  function renderFastKm() {
    const wiz = $('#shift-wizard'); const v = selectedVehicle() || {};
    const grace = fmtGrace(sf.settings && sf.settings.inspection_grace_minutes);
    wiz.innerHTML = `<div class="max-w-lg mx-auto min-h-screen flex flex-col bg-slate-50">
      <div class="px-5 pt-4 pb-2" style="padding-top:calc(16px + env(safe-area-inset-top));">
        <div class="flex items-center justify-between mb-3">
          <button id="fk-back" class="w-9 h-9 rounded-full bg-white border border-slate-200 flex items-center justify-center text-slate-600 active:scale-95">←</button>
          <span class="text-[11px] font-bold uppercase tracking-wider text-brand-600">Inicio rápido</span><span class="w-9"></span>
        </div>
        <h1 class="text-2xl font-extrabold text-ink leading-tight">Iniciar ahora</h1>
        <p class="text-sm text-slate-500 mt-1">${esc(v.internal_code || v.license_plate || 'Vehículo')} · la inspección la haces en ${esc(grace)}.</p>
      </div>
      <div class="flex-1 px-5 py-3 space-y-4">
        <div class="rounded-2xl bg-white border border-slate-200 p-4">
          <label class="block text-[13px] font-bold text-slate-500 mb-2">Kilometraje de salida</label>
          <div class="flex items-baseline gap-1"><input id="fk-km" type="tel" inputmode="numeric" placeholder="Ej: 128.450" class="w-full text-2xl font-extrabold text-ink bg-transparent focus:outline-none placeholder:text-slate-300 tabular-nums border-b-2 border-brand-200 focus:border-brand-500"><span class="text-sm font-bold text-slate-400">km</span></div>
        </div>
        <div class="rounded-xl bg-amber-50 border border-amber-300 px-3.5 py-2.5 text-[12.5px] text-amber-800 flex gap-2"><span>⏳</span><span>Tendrás <b>${esc(grace)}</b> para hacer la inspección. Si no la haces a tiempo, será un strike.</span></div>
      </div>
      <div class="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 px-5 py-3 z-10" style="padding-bottom:calc(12px + env(safe-area-inset-bottom));">
        <div class="max-w-lg mx-auto"><p id="fk-state" class="text-xs text-slate-500 text-center mb-1.5"></p>
        <button id="fk-confirm" class="w-full bg-brand text-white text-base font-extrabold py-3.5 rounded-xl shadow-brand active:scale-[0.99] transition disabled:opacity-40 disabled:pointer-events-none" disabled>Iniciar turno</button></div>
      </div>
    </div>`;
    const kmEl = $('#fk-km'); const cf = $('#fk-confirm');
    kmEl.addEventListener('input', () => { const d = kmEl.value.replace(/\D/g, ''); kmEl.value = d ? Number(d).toLocaleString('es-CO') : ''; sf.km = d; if (cf) cf.disabled = !(d && Number(d) > 0); });
    $('#fk-back').addEventListener('click', () => { sf.step = 0; render(); });
    cf.addEventListener('click', submitFastStart);
  }

  async function submitFastStart() {
    const km = Number(String(sf.km).replace(/\D/g, '')); if (!(km > 0) || sf.saving) return;
    sf.saving = true;
    const cf = $('#fk-confirm'); if (cf) cf.disabled = true;
    const setState = (t) => { const e = $('#fk-state'); if (e) e.textContent = t; };
    try {
      setState('Iniciando turno…');
      const res = await Api.startShiftDeferred(sf.reuseShiftId, km);
      sf.reuseShiftId = null; sf.saving = false;
      sf.fastDue = res && res.inspection_due_at;
      sf.done = 'deferred';
      render();
    } catch (e) {
      sf.saving = false; if (cf) cf.disabled = false; setState('');
      const msg = (e && e.message) || '';
      if (/NOT_ALLOWED_NOW/.test(msg)) sfToast('El inicio rápido solo está disponible en la franja configurada.');
      else if (/DISABLED/.test(msg)) sfToast('El inicio rápido no está habilitado por el admin.');
      else if (/VEHICLE_IN_USE|NOT_OPERABLE/.test(msg)) sfToast('El vehículo ya no está disponible.');
      else sfToast('No se pudo iniciar: ' + msg);
    }
  }

  // Completar la inspección de un turno que arrancó diferido (turno ya activo).
  async function openCompletion(shift) {
    stopElapsedTimer();
    sf.completing = true;
    sf.reuseShiftId = shift.id;
    sf.km = String(shift.opening_km || '');
    const vv = shift.vehicles || {};
    sf.vehicles = [{ id: shift.vehicle_id, internal_code: vv.internal_code, license_plate: vv.license_plate, brand: vv.brand, model: vv.model }];
    sf.vehicleId = shift.vehicle_id;
    sf.checklist = {}; sf.photos = {}; sf.extraPhotos = []; sf.severity = null; sf.note = ''; sf.isApt = true; sf.signed = false; sf.saving = false; sf.done = null;
    const wiz = $('#shift-wizard'); wiz.classList.remove('hidden'); document.body.style.overflow = 'hidden';
    const nav = document.getElementById('driver-nav'); sf._navWasShown = !!(nav && nav.classList.contains('show')); if (sf._navWasShown) nav.classList.remove('show');
    document.getElementById('driver-save-bar')?.classList.add('hidden');
    sf.step = 1; // arranca en el checklist (el vehículo ya está)
    render();
  }

  window.ShiftFlow = { init, refresh: renderCard };
})();
