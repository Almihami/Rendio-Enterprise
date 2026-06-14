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

  const CHECKLIST_ITEMS = [
    { id: 'tires',         label: 'Llantas (4 + repuesto)',          detail: 'Presión y estado visual' },
    { id: 'lights_front',  label: 'Luces delanteras',                detail: 'Altas, bajas, exploradoras' },
    { id: 'lights_back',   label: 'Luces traseras y stops' },
    { id: 'turn_signals',  label: 'Direccionales' },
    { id: 'brakes',        label: 'Frenos',                          detail: 'Pedal firme, sin ruidos' },
    { id: 'horn_belts',    label: 'Pito y cinturones' },
    { id: 'oil',           label: 'Nivel de aceite' },
    { id: 'coolant',       label: 'Refrigerante' },
    { id: 'wipers',        label: 'Limpiaparabrisas y agua' },
    { id: 'mirrors',       label: 'Espejos y vidrios' },
    { id: 'docs',          label: 'SOAT, técnico-mecánica, tarjeta' },
    { id: 'road_kit',      label: 'Kit carretera + extintor' },
  ];

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
    checklist: {},        // itemId -> 'ok' | 'issue'
    photos: {},           // slotId -> { blob, url, size }
    km: '',
    severity: null,       // 'leve' | 'media' | 'grave'
    note: '',
    saving: false,
    done: null,           // 'started' | 'aborted'
    _slot: null,          // slot pendiente de captura
  };

  function sfToast(msg) {
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(sfToast._t);
    sfToast._t = setTimeout(() => t.classList.add('hidden'), 3000);
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
      const v = open.vehicles || {};
      const since = new Date(open.start_at).toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Bogota' });
      box.innerHTML = `<div class="rounded-2xl p-5 h-[200px] flex flex-col bg-gradient-to-br from-emerald-400 to-emerald-600 text-white shadow-card">
        <div class="flex items-start justify-between">
          <div class="w-12 h-12 rounded-2xl bg-white/20 flex items-center justify-center text-2xl">🟢</div>
          <span class="text-[10px] font-bold uppercase tracking-[0.18em] text-white/75 mt-1">En curso</span>
        </div>
        <div class="mt-auto">
          <p class="text-xl font-extrabold leading-tight">Turno activo · ${esc(v.internal_code || v.license_plate || 'vehículo')}</p>
          <p class="text-xs text-white/85 mt-1">${esc([v.brand, v.model].filter(Boolean).join(' '))} · desde las ${since} · salida ${fmtKm(open.opening_km)} km</p>
        </div>
        <p class="text-[11px] text-white/70 mt-3">El cierre de turno (inspección final) llega en la siguiente etapa.</p>
      </div>`;
      return;
    }

    sf.reuseShiftId = open ? open.id : null;
    box.innerHTML = `<button id="sf-open-btn" class="sheen tap w-full text-left rounded-2xl p-5 h-[200px] flex flex-col bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-brand">
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
    sf.vehicleId = null;
    sf.checklist = {};
    Object.values(sf.photos).forEach(p => p && p.url && URL.revokeObjectURL(p.url));
    sf.photos = {};
    sf.km = '';
    sf.severity = null;
    sf.note = '';
    sf.saving = false;
    sf.done = null;

    const wiz = $('#shift-wizard');
    wiz.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
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
  }

  function tryExit() {
    const hasProgress = sf.vehicleId || Object.keys(sf.checklist).length || Object.keys(sf.photos).length;
    if (sf.done || !hasProgress || confirm('¿Salir del inicio de turno? Se pierde el avance de la inspección.')) {
      closeWizard();
      renderCard();
    }
  }

  function goBack() {
    if (sf.step === 0) { tryExit(); return; }
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
    return CHECKLIST_ITEMS.filter(i => sf.checklist[i.id] === 'issue');
  }

  function maintenanceInfo(v) {
    const interval = v.maintenance_interval_km || 7000;
    const driven = (v.current_km || 0) - (v.last_maintenance_km || 0);
    const remaining = interval - driven;
    if (remaining <= 0)  return { tone: 'rose',  label: 'Mantenimiento vencido' };
    if (remaining <= 500) return { tone: 'amber', label: `Mantto en ${fmtKm(remaining)} km` };
    return null;
  }

  function soatInfo(v) {
    if (!v.soat_expires_at) return null;
    const days = Math.floor((new Date(v.soat_expires_at + 'T00:00:00') - new Date()) / 86400000);
    if (days < 0)   return { tone: 'rose',  label: 'SOAT vencido' };
    if (days <= 30) return { tone: 'amber', label: `SOAT vence en ${days} d.` };
    return null;
  }

  const STATUS_ES = { available: null, in_use: 'En uso', maintenance: 'En mantenimiento', blocked: 'Bloqueado' };

  // ---------- Paso 1: vehículo ----------

  function renderVehicle(wiz) {
    const chip = (tone, label) => {
      const cls = tone === 'rose' ? 'bg-rose-100 text-rose-700'
        : tone === 'amber' ? 'bg-amber-100 text-amber-700'
        : 'bg-emerald-100 text-emerald-700';
      return `<span class="text-[11px] font-bold px-2 py-0.5 rounded-full ${cls}">${esc(label)}</span>`;
    };
    const rows = sf.vehicles
      .slice()
      .sort((a, b) => (a.status === 'available' ? 0 : 1) - (b.status === 'available' ? 0 : 1))
      .map(v => {
        const disabled = v.status !== 'available';
        const isSel = sf.vehicleId === v.id;
        const chips = [];
        if (STATUS_ES[v.status]) chips.push(chip('rose', STATUS_ES[v.status]));
        const mi = maintenanceInfo(v); if (mi) chips.push(chip(mi.tone, mi.label));
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

    wiz.innerHTML = shellHtml(
      `Inicio de turno · Paso 1 de ${TOTAL_STEPS}`,
      'Selecciona tu vehículo',
      'Elige el vehículo con el que vas a operar hoy.',
      `<div class="space-y-2.5">${rows}</div>`,
      `<button id="sf-next" class="w-full bg-brand text-white text-base font-bold py-3.5 rounded-xl hover:bg-brand-600 active:scale-[0.99] transition shadow-brand disabled:opacity-40 disabled:pointer-events-none" ${sf.vehicleId ? '' : 'disabled'}>
        Continuar a inspección →
      </button>`
    );
    bindChrome();
    wiz.querySelectorAll('[data-vehicle]').forEach(btn => {
      btn.addEventListener('click', () => { sf.vehicleId = btn.dataset.vehicle; render(); });
    });
    $('#sf-next').addEventListener('click', goNext);
  }

  // ---------- Paso 2: checklist ----------

  function renderChecklist(wiz) {
    const completed = CHECKLIST_ITEMS.filter(i => sf.checklist[i.id]).length;
    const issues = issueItems().length;
    const allDone = completed === CHECKLIST_ITEMS.length;

    const rows = CHECKLIST_ITEMS.map(item => {
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
    }).join('');

    wiz.innerHTML = shellHtml(
      `Inicio de turno · Paso 2 de ${TOTAL_STEPS}`,
      'Inspección pre-operacional',
      'Revisa cada punto. Marca ✓ si está bien o ⚠ si hay novedad.',
      `<div class="flex items-center justify-between mb-2">
        <p class="text-xs text-slate-500">${completed} de ${CHECKLIST_ITEMS.length} revisados${issues ? ` · <span class="text-amber-600 font-semibold">${issues} con novedad</span>` : ''}</p>
        <button id="sf-all-ok" class="text-xs font-bold text-brand-600">Marcar todos OK</button>
      </div>
      <div class="space-y-2">${rows}</div>`,
      `<button id="sf-next" class="w-full bg-brand text-white text-base font-bold py-3.5 rounded-xl hover:bg-brand-600 active:scale-[0.99] transition shadow-brand disabled:opacity-40 disabled:pointer-events-none" ${allDone ? '' : 'disabled'}>
        ${allDone ? 'Continuar a fotos →' : `Falta marcar ${CHECKLIST_ITEMS.length - completed}`}
      </button>`
    );
    bindChrome();
    $('#sf-all-ok').addEventListener('click', () => {
      CHECKLIST_ITEMS.forEach(i => { if (!sf.checklist[i.id]) sf.checklist[i.id] = 'ok'; });
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
    const taken = Object.keys(sf.photos).length;
    const allTaken = PHOTO_SLOTS.every(s => sf.photos[s.id]);

    const cells = PHOTO_SLOTS.map((s, i) => {
      const p = sf.photos[s.id];
      return `<button data-slot="${s.id}" class="text-left bg-white border-2 ${p ? 'border-brand' : 'border-slate-200'} rounded-2xl overflow-hidden active:scale-[0.99] transition">
        <div class="aspect-[4/3] relative bg-slate-100 flex items-center justify-center">
          ${p
            ? `<img src="${p.url}" alt="${esc(s.label)}" class="absolute inset-0 w-full h-full object-cover" />
               <span class="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-brand text-white text-xs flex items-center justify-center font-bold">✓</span>`
            : `<span class="text-2xl text-slate-300">📷</span>
               <span class="absolute top-1.5 right-1.5 text-[10px] font-bold bg-slate-50 border border-slate-200 rounded-full px-2 py-0.5 text-slate-500">${i + 1}/5</span>`}
        </div>
        <div class="px-3 py-2">
          <p class="text-sm font-semibold text-ink">${esc(s.label)}</p>
          <p class="text-[11px] text-slate-400">${p ? 'Capturada · toca para repetir' : esc(s.detail)}</p>
        </div>
      </button>`;
    }).join('');

    wiz.innerHTML = shellHtml(
      `Inicio de turno · Paso 3 de ${TOTAL_STEPS}`,
      'Fotos del vehículo',
      '5 ángulos. Toca cada uno para capturar con la cámara.',
      `<div class="grid grid-cols-2 gap-2.5">${cells}</div>
       <input id="sf-photo-input" type="file" accept="image/*" capture="environment" class="hidden" />
       <p id="sf-photo-state" class="text-xs text-slate-400 mt-3"></p>`,
      `<button id="sf-next" class="w-full bg-brand text-white text-base font-bold py-3.5 rounded-xl hover:bg-brand-600 active:scale-[0.99] transition shadow-brand disabled:opacity-40 disabled:pointer-events-none" ${allTaken ? '' : 'disabled'}>
        ${allTaken ? 'Continuar a kilometraje →' : `Faltan ${PHOTO_SLOTS.length - taken} foto${PHOTO_SLOTS.length - taken === 1 ? '' : 's'}`}
      </button>`
    );
    bindChrome();
    const input = $('#sf-photo-input');
    wiz.querySelectorAll('[data-slot]').forEach(btn => {
      btn.addEventListener('click', () => { sf._slot = btn.dataset.slot; input.click(); });
    });
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.value = '';
      if (!file || !sf._slot) return;
      const stateEl = $('#sf-photo-state');
      if (stateEl) stateEl.textContent = 'Procesando foto…';
      try {
        const blob = await compressPhoto(file);
        const prev = sf.photos[sf._slot];
        if (prev && prev.url) URL.revokeObjectURL(prev.url);
        sf.photos[sf._slot] = { blob, url: URL.createObjectURL(blob), size: blob.size };
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
    const blocked = sf.severity === 'grave';
    const sevLabel = { leve: 'Leve — operación normal', media: 'Media — con seguimiento', grave: 'Grave — bloquea operación' }[sf.severity] || '';

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
          <p class="text-xs text-slate-500">Gravedad: <strong class="${blocked ? 'text-rose-600' : sf.severity === 'media' ? 'text-amber-600' : 'text-emerald-600'}">${esc(sevLabel)}</strong></p>
        </div>` : '';

    wiz.innerHTML = shellHtml(
      `Inicio de turno · Paso 6 de ${TOTAL_STEPS}`,
      'Confirma e inicia',
      blocked ? 'Hay una novedad grave: el turno no se inicia.' : 'Revisa el resumen y arranca el turno.',
      `<div class="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-card">
        ${row('🚗', 'Vehículo', `${esc(v.internal_code || v.license_plate)} · ${esc([v.brand, v.model].filter(Boolean).join(' '))}`, 'ok')}
        ${row('✓', 'Inspección', issues.length ? `${CHECKLIST_ITEMS.length - issues.length} OK · ${issues.length} con novedad` : `${CHECKLIST_ITEMS.length} de ${CHECKLIST_ITEMS.length} OK`, issues.length ? 'warn' : 'ok')}
        ${row('📷', 'Fotos', `${Object.keys(sf.photos).length} de ${PHOTO_SLOTS.length} capturadas`, 'ok')}
        ${row('🛞', 'Kilometraje inicial', `${fmtKm(sf.km)} km`, 'ok')}
        ${issuesBlock}
      </div>
      <div class="mt-3 p-3 rounded-xl bg-slate-100 text-xs text-slate-500 flex gap-2 items-start">
        <span>🔒</span>
        <span>Al confirmar registramos la inspección con tu usuario y la hora exacta. Necesitas señal para enviar las fotos.</span>
      </div>
      <p id="sf-save-state" class="text-sm text-slate-500 mt-3 text-center"></p>`,
      blocked
        ? `<button id="sf-confirm" class="w-full bg-rose-600 text-white text-base font-bold py-3.5 rounded-xl hover:bg-rose-700 active:scale-[0.99] transition disabled:opacity-40 disabled:pointer-events-none">Registrar novedad y suspender</button>`
        : `<button id="sf-confirm" class="w-full bg-brand text-white text-base font-bold py-3.5 rounded-xl hover:bg-brand-600 active:scale-[0.99] transition shadow-brand disabled:opacity-40 disabled:pointer-events-none">⚡ Iniciar turno</button>`
    );
    bindChrome();
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
    const blocked = sf.severity === 'grave';
    const org = sf.profile.organization_id;
    const openingKm = Number(sf.km);

    try {
      setState('Creando el turno…');
      const shiftId = await Api.createShiftDraft({
        driverId: sf.driverId,
        organizationId: org,
        vehicleId: v.id,
        openingKm,
        reuseId: sf.reuseShiftId,
      });
      sf.reuseShiftId = shiftId; // si algo falla más adelante, el retry lo reutiliza

      const inspectionId = (crypto.randomUUID && crypto.randomUUID()) ||
        'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
          const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
      const today = new Date().toISOString().slice(0, 10);

      const slots = PHOTO_SLOTS.filter(s => sf.photos[s.id]);
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

      setState('Registrando inspección…');
      await Api.createInspection({
        id: inspectionId,
        organization_id: org,
        shift_id: shiftId,
        vehicle_id: v.id,
        driver_id: sf.driverId,
        kind: 'initial',
        odometer_km: openingKm,
        checklist: sf.checklist,
        has_damage: issues.length > 0,
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

      if (blocked) {
        setState('Suspendiendo turno…');
        await Api.abortShift(shiftId, `${issues.map(i => i.label).join(', ')} — ${sf.note || 'sin detalle'}`);
        sf.done = 'aborted';
      } else {
        setState('Iniciando turno…');
        await Api.startShift(shiftId);
        sf.done = 'started';
      }
      sf.reuseShiftId = null;
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
    const aborted = sf.done === 'aborted';
    const v = selectedVehicle();
    wiz.innerHTML = `<div class="max-w-lg mx-auto min-h-screen flex flex-col items-center justify-center text-center px-8 bg-slate-50">
      <div class="w-20 h-20 rounded-full ${aborted ? 'bg-rose-100 text-rose-600' : 'bg-brand-50 text-brand-600'} text-4xl flex items-center justify-center mb-5">
        ${aborted ? '⚠' : '✓'}
      </div>
      <h1 class="text-2xl font-extrabold text-ink">${aborted ? 'Turno suspendido' : '¡Listo, en ruta!'}</h1>
      <p class="text-[15px] text-slate-500 mt-2 leading-relaxed max-w-xs">
        ${aborted
          ? 'La novedad quedó registrada y el vehículo pasó a revisión. El admin te indicará cómo proceder.'
          : `Turno activo con el ${esc(v ? (v.internal_code || v.license_plate) : 'vehículo')} desde ${fmtKm(sf.km)} km. Maneja con calma.`}
      </p>
      <button id="sf-done-btn" class="mt-8 px-6 py-3 rounded-xl ${aborted ? 'bg-ink text-white' : 'bg-brand text-white shadow-brand'} font-bold active:scale-[0.98] transition">
        Volver al inicio
      </button>
    </div>`;
    $('#sf-done-btn').addEventListener('click', () => {
      Object.values(sf.photos).forEach(p => p && p.url && URL.revokeObjectURL(p.url));
      sf.photos = {};
      closeWizard();
      renderCard();
    });
  }

  window.ShiftFlow = { init, refresh: renderCard };
})();
