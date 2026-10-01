// CONDUCTOR › documentos del carro al iniciar turno y en su perfil (0095) — jsdom.
//
// La dueña (30-sep-2026), a «¿el conductor también debe ver los vencidos al
// iniciar turno? Hoy solo ve el SOAT»: «y los más relevantes». Antes había dicho
// que vencido = SOLO alerta, nunca bloqueo.
//
// Carga index.html + driver-disponibilidad.js (avIcon) + shift-flow.js con un
// Api de PRUEBA (nada sale a la red), y maneja el asistente por los MISMOS
// botones que toca el conductor. Para el perfil carga scheduler.js +
// driver-perfil.js con los ayudantes de core.js reemplazados por unos mínimos.
// Para la capa de datos, api.js corre contra un `window.sb` falso.
//
// Comprueba:
//   · paso 1: chips de los documentos de la vía vencidos / por vencer / que
//     vencen hoy, con la misma pieza y los mismos tonos del chip del SOAT; sin
//     dato, al día y «No aplica» no se pintan; el SOAT no sale dos veces;
//   · paso 6: la nota «Este carro tiene … vencidos. Puedes salir igual; avísale
//     al jefe.», que NO bloquea (el turno arranca); no sale con NO APTO, ni si
//     nada está vencido (lo que vence hoy todavía vale);
//   · inicio rápido: la misma nota; y la gramática (vencido/vencida/vencidas/
//     vencidos, «a, b y c»);
//   · la constancia en las notas de la inspección («Documentos del carro
//     vencidos según la app: …»), para que la inspección no diga «todo OK» sin
//     que quede escrito; sin datos de la base, ninguna;
//   · la RPC falla, no existe en api.js, o se demora: el asistente sigue como
//     antes (chip del SOAT de vehicles) y, si llega tarde, los chips se ponen
//     sin repintar la pantalla (el carro elegido sigue elegido) y la nota entra
//     en su hueco en el inicio rápido y en el paso 6 (el km tecleado y la firma
//     se quedan);
//   · completar una inspección diferida (openCompletion): sin nota ni hueco
//     («puedes salir igual» no aplica a un turno en ruta), pero con constancia;
//   · un borrador restaurado (IndexedDB en memoria, mínimo, aquí mismo): la
//     espera corta no lo rompe, el carro sigue preelegido y los chips salen,
//     también si llegan tarde;
//   · perfil: los relevantes del carro del turno con su estado; «No aplica» y
//     sin dato no salen; sin turno no hay documentos del carro; la RPC caída deja
//     lo de antes y los documentos personales siguen;
//   · api.js: nombre de la RPC y parámetro.
//
// LO QUE NO CUBRE: layout (jsdom no lo hace: que la fila de chips no se desborde
// con 5 chips en una tarjeta, o que la nota se lea en un teléfono, se mira en el
// navegador), la base real (eso es _verify-0095.mjs), PostgREST, el service
// worker ni un IndexedDB de verdad (el de aquí es un sustituto mínimo en memoria:
// put/get/clear/openCursor; las fotos restauradas, la cuota y el modo privado
// los cubre _smoke-inicio-turno-dom.mjs, que necesita fake-indexeddb).
//
//   cd rendio-backend && node scripts/_smoke-docs-conductor-dom.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null && d !== '' ? ' → ' + d : '')); } };
const esperar = (ms = 60) => new Promise(r => setTimeout(r, ms));
const limpio = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
// La nota es [ícono][texto] en dos spans: se lee el texto.
const notaTxt = (el) => (el && el.lastElementChild ? limpio(el.lastElementChild) : '');
const HOY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const addD = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };

const LAS_FIJAS = ['front', 'rear', 'left', 'right', 'dashboard', 'glovebox',
                   'property_card', 'door_left', 'door_right', 'road_kit', 'spare_tire'];

// Una fila como la devuelve driver_vehicle_documents.
const fila = (vehicle_id, kind, status, days) => ({
  vehicle_id, kind, label: kind,
  expires_on: (status === 'sin_dato' || status === 'no_aplica') ? null : addD(HOY, days),
  days_left: (status === 'sin_dato' || status === 'no_aplica') ? null : days,
  status, not_applicable: status === 'no_aplica',
});

// v1 tiene el SOAT vencido TAMBIÉN en vehicles: con la RPC no puede salir dos veces.
const VEHICULOS = [
  { id: 'v1', internal_code: 'P-01', license_plate: 'RDO481', brand: 'Hyundai', model: 'Accent', capacity: 4, status: 'available', current_km: 1000, last_maintenance_km: 900, maintenance_interval_km: 7000, soat_expires_at: addD(HOY, -1) },
  { id: 'v2', internal_code: 'P-02', license_plate: 'RDO482', brand: 'Kia', model: 'Picanto', capacity: 4, status: 'available', current_km: 2000, last_maintenance_km: 1900, maintenance_interval_km: 7000, soat_expires_at: null },
  { id: 'v3', internal_code: 'P-03', license_plate: 'RDO483', brand: 'Kia', model: 'Rio', capacity: 4, status: 'available', current_km: 3000, last_maintenance_km: 2900, maintenance_interval_km: 7000, soat_expires_at: null },
  { id: 'v4', internal_code: 'P-04', license_plate: 'RDO484', brand: 'Renault', model: 'Logan', capacity: 4, status: 'available', current_km: 4000, last_maintenance_km: 3900, maintenance_interval_km: 7000, soat_expires_at: null },
  { id: 'v5', internal_code: 'P-05', license_plate: 'RDO485', brand: 'Chevrolet', model: 'Onix', capacity: 4, status: 'available', current_km: 5000, last_maintenance_km: 4900, maintenance_interval_km: 7000, soat_expires_at: null },
];
const DOCS = [
  fila('v1', 'soat', 'vencido', -1), fila('v1', 'tecnomecanica', 'vencido', -20), fila('v1', 'seguro', 'por_vencer', 12),
  fila('v1', 'polizas_rc', 'sin_dato'), fila('v1', 'extintor', 'no_aplica'),
  fila('v2', 'soat', 'al_dia', 200), fila('v2', 'tecnomecanica', 'al_dia', 90), fila('v2', 'seguro', 'sin_dato'),
  fila('v2', 'polizas_rc', 'hoy', 0), fila('v2', 'extintor', 'vencido', -3),
  fila('v3', 'soat', 'al_dia', 100), fila('v3', 'tecnomecanica', 'vencido', -2), fila('v3', 'seguro', 'al_dia', 100),
  fila('v3', 'polizas_rc', 'vencido', -9), fila('v3', 'extintor', 'por_vencer', 1),
  fila('v4', 'soat', 'vencido', -4), fila('v4', 'tecnomecanica', 'al_dia', 60), fila('v4', 'seguro', 'vencido', -1),
  fila('v4', 'polizas_rc', 'al_dia', 50), fila('v4', 'extintor', 'vencido', -30),
  // v5: nada vencido; lo que vence hoy todavía vale hoy → sin nota.
  fila('v5', 'soat', 'hoy', 0), fila('v5', 'tecnomecanica', 'por_vencer', 30), fila('v5', 'seguro', 'al_dia', 31),
  fila('v5', 'polizas_rc', 'sin_dato'), fila('v5', 'extintor', 'no_aplica'),
];

// Volcado del markup REAL para mirarlo con el CSS de verdad (jsdom no hace layout):
//   DUMP_DIR=/ruta node scripts/_smoke-docs-conductor-dom.mjs
// deja paso1.html, paso6.html, rapido.html, rapido-tarde.html, paso6-tarde.html
// y perfil.html con el <head> del index.
// Abrirlos servidos desde rendio-turnos/ (o con <base href> a ese servidor).
const DUMPS = {};
function volcar(nombre, html, envoltura) { if (process.env.DUMP_DIR) DUMPS[nombre] = { html, envoltura }; }

// IndexedDB mínimo en memoria: lo justo de lo que usa el borrador del asistente
// (open + onupgradeneeded, transaction/objectStore, put/get/clear, openCursor).
// Asíncrono como el de verdad (cada petición resuelve en otro turno).
function idbEnMemoria(semilla = {}) {
  const stores = new Map();
  for (const [n, kv] of Object.entries(semilla)) stores.set(n, new Map(Object.entries(kv)));
  const luego = (fn) => setTimeout(fn, 0);
  const db = {
    onclose: null,
    objectStoreNames: { contains: (n) => stores.has(n) },
    createObjectStore: (n) => { if (!stores.has(n)) stores.set(n, new Map()); },
    transaction(nombre) {
      const m = stores.get(nombre);
      const tx = { oncomplete: null, onerror: null, error: null };
      const pedir = (fn) => {
        const req = { result: undefined, onsuccess: null, onerror: null };
        luego(() => { req.result = fn(); req.onsuccess && req.onsuccess(); luego(() => tx.oncomplete && tx.oncomplete()); });
        return req;
      };
      tx.objectStore = () => ({
        put: (v, k) => pedir(() => { m.set(k, v); return k; }),
        get: (k) => pedir(() => m.get(k)),
        clear: () => pedir(() => { m.clear(); }),
        openCursor: () => {
          const filas = [...m.entries()]; let i = 0;
          const req = { result: null, onsuccess: null, onerror: null };
          const paso = () => luego(() => {
            const f = filas[i];
            req.result = f ? { key: f[0], value: f[1], continue: () => { i++; paso(); } } : null;
            req.onsuccess && req.onsuccess();
          });
          paso();
          return req;
        },
      });
      return tx;
    },
  };
  return {
    open() {
      const req = { result: db, onsuccess: null, onupgradeneeded: null, onerror: null };
      luego(() => { req.onupgradeneeded && req.onupgradeneeded(); req.onsuccess && req.onsuccess(); });
      return req;
    },
    _stores: stores,
  };
}

// modo: 'ok' | 'falla' | 'sin-funcion' | 'lento'
// openShift: lo que devuelve getMyOpenShift (un turno activo con inspección
// pendiente = el camino de openCompletion). borrador: meta del avance guardado
// en el teléfono (se siembra en el IndexedDB en memoria).
async function montarAsistente({ modo = 'ok', settings = {}, lentoMs = 2600, openShift = null, borrador = null } = {}) {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const { window } = dom;
  // Sin borrador, sin IndexedDB: cada montaje arranca limpio. Con borrador, uno
  // en memoria con ese avance ya guardado.
  window.indexedDB = borrador ? idbEnMemoria({ meta: { actual: borrador }, fotos: {} }) : undefined;
  window.RENDIO_CONFIG = {}; window.toast = () => {};
  window.console = { ...console, error: () => {} };
  window.URL.createObjectURL = () => 'blob:x'; window.URL.revokeObjectURL = () => {};
  window.Image = class {
    constructor() { this.naturalWidth = 3024; this.naturalHeight = 4032; }
    set src(_) { setTimeout(() => this.onload && this.onload(), 0); }
    get src() { return 'blob:x'; }
  };
  const crearReal = window.document.createElement.bind(window.document);
  window.document.createElement = (tag) => {
    const el = crearReal(tag);
    if (String(tag).toLowerCase() === 'canvas') {
      el.getContext = () => ({ drawImage: () => {} });
      el.toBlob = (cb) => cb(new window.Blob(['jpeg'], { type: 'image/jpeg' }));
    }
    return el;
  };
  const llamadas = { docs: 0, arranco: false, reservas: 0, inspeccion: null, limpioPlazo: false };
  window.Api = {
    getMyDriverProfileId: async () => 'd1',
    listChecklistItems: async () => [{ id: 'c1', label: 'Luces funcionando', category: 'Exterior' }],
    listChecklistItemsForTiers: async () => [],
    pendingInspectionTiers: async () => [],
    getSettings: async () => settings,
    listNoFuelReasons: async () => [],
    getMyOpenShift: async () => (openShift ? { ...openShift } : null),
    getMyLastClosedShift: async () => null,
    listVehiclesForShift: async () => VEHICULOS.map(v => ({ ...v })),
    getVehicleStatus: async () => 'available',
    reserveVehicleForShift: async () => { llamadas.reservas++; return { shift_id: 's1' }; },
    createShiftDraft: async () => 's1',
    getExistingInitialInspectionId: async () => null,
    createInspection: async (fila) => { llamadas.inspeccion = fila; return 'i1'; },
    startShift: async () => { llamadas.arranco = true; return { ok: true }; },
    startShiftDeferred: async () => { llamadas.arranco = true; return { inspection_due_at: new Date(Date.now() + 5400000).toISOString() }; },
    abortShift: async () => {},
    clearInspectionDue: async () => { llamadas.limpioPlazo = true; },
    markInspectionTiersDone: async () => {},
    addIncident: async () => {},
    addInspectionPhotos: async () => {},
    uploadInspectionPhoto: async (p) => p,
  };
  if (modo !== 'sin-funcion') {
    window.Api.driverVehicleDocuments = async (ids) => {
      llamadas.docs++; llamadas.docsIds = ids;
      if (modo === 'falla') throw new Error('Could not find the function public.driver_vehicle_documents');
      if (modo === 'lento') await esperar(lentoMs);
      return DOCS.map(d => ({ ...d }));
    };
  }
  window.state = { settings: {} };
  for (const f of ['driver-disponibilidad.js', 'shift-flow.js']) window.eval(read(f));
  await window.ShiftFlow.init({ id: 'p1', full_name: 'Carlos Mejía', organization_id: 'o1', role: 'driver' });
  await esperar(60);

  const doc = window.document;
  const wiz = () => doc.getElementById('shift-wizard');
  const q = (s) => wiz().querySelector(s);
  const pulsar = (sel) => {
    const el = sel.startsWith('[') ? q(sel) : doc.getElementById(sel);
    if (!el) throw new Error(`no encontré "${sel}". El asistente está en: ${limpio(wiz()).slice(0, 160)}`);
    el.click();
  };
  const chipsDe = (vid) => [...(q(`[data-vehicle="${vid}"]`) || { querySelectorAll: () => [] }).querySelectorAll('span.rounded-full')]
    .map(s => ({ txt: limpio(s), rose: s.className.includes('bg-rose-100'), amber: s.className.includes('bg-amber-100') }));
  const abrir = async (msEspera = 120) => { pulsar('sf-open-btn'); await esperar(msEspera); };

  // Del checklist (paso 2) hasta el paso 6 (firmado), por los botones. km: lo que
  // se teclea en el paso 4 (null = deja el que ya tiene, p. ej. el de apertura).
  async function desdeChecklist({ km = '1050' } = {}) {
    pulsar('sf-all-ok'); await esperar(40);
    pulsar('sf-next'); await esperar(80);
    for (const slot of LAS_FIJAS) {
      q(`[data-slot="${slot}"]`).click();
      const input = doc.getElementById('sf-photo-input');
      const file = new window.File(['x'.repeat(1024)], slot + '.jpg', { type: 'image/jpeg' });
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new window.Event('change', { bubbles: true }));
      await esperar(15);
    }
    pulsar('sf-next'); await esperar(80);
    if (km != null) {
      const kmEl = doc.getElementById('sf-km');
      kmEl.value = km; kmEl.dispatchEvent(new window.Event('input', { bubbles: true }));
      await esperar(30);
    }
    pulsar('sf-next'); await esperar(80);
    pulsar('sf-next'); await esperar(80);
    const firma = doc.getElementById('sf-sign');
    firma.checked = true; firma.dispatchEvent(new window.Event('change', { bubbles: true }));
    await esperar(30);
  }
  // De la elección del carro hasta el paso 6 (firmado).
  async function hastaConfirmar(vid) {
    pulsar(`[data-vehicle="${vid}"]`); await esperar(40);
    pulsar('sf-next'); await esperar(120);
    await desdeChecklist();
  }
  const toastTxt = () => limpio(doc.getElementById('toast'));
  return { window, doc, wiz, q, pulsar, chipsDe, abrir, hastaConfirmar, desdeChecklist, toastTxt, llamadas };
}

// ══════════════════════════════════════════════════════════════════
console.log('\n══ A · la RPC responde: chips en el paso 1 ══');
let A = await montarAsistente({ modo: 'ok' });
await A.abrir();
t('pidió los documentos una vez, de todos los carros (sin lista)', A.llamadas.docs === 1 && A.llamadas.docsIds == null, `${A.llamadas.docs} · ${JSON.stringify(A.llamadas.docsIds)}`);
volcar('paso1', A.wiz().innerHTML, 'wiz');
let c1 = A.chipsDe('v1');
t('P-01: «SOAT vencido» en rojo', c1.some(c => c.txt === 'SOAT vencido' && c.rose), JSON.stringify(c1));
t('P-01: «Tecnomecánica vencida» en rojo', c1.some(c => c.txt === 'Tecnomecánica vencida' && c.rose), JSON.stringify(c1));
t('P-01: «Seguro vence en 12 d.» en ámbar', c1.some(c => c.txt === 'Seguro vence en 12 d.' && c.amber), JSON.stringify(c1));
t('P-01: el SOAT sale UNA vez (no se suma el de vehicles)', c1.filter(c => /SOAT/.test(c.txt)).length === 1, JSON.stringify(c1));
t('P-01: sin dato (pólizas) y «No aplica» (extintor) no se pintan', !c1.some(c => /Pólizas|Extintor|aplica|dato/i.test(c.txt)), JSON.stringify(c1));
const c2 = A.chipsDe('v2');
t('P-02: «Pólizas RC vencen hoy» en ámbar', c2.some(c => c.txt === 'Pólizas RC vencen hoy' && c.amber), JSON.stringify(c2));
t('P-02: «Extintor vencido» en rojo', c2.some(c => c.txt === 'Extintor vencido' && c.rose), JSON.stringify(c2));
t('P-02: lo que está al día no se pinta', !c2.some(c => /SOAT|Tecnomec|Seguro/.test(c.txt)), JSON.stringify(c2));
const c3 = A.chipsDe('v3');
t('P-03: «Pólizas RC vencidas» y «Extintor vence en 1 d.»', c3.some(c => c.txt === 'Pólizas RC vencidas' && c.rose) && c3.some(c => c.txt === 'Extintor vence en 1 d.' && c.amber), JSON.stringify(c3));
t('todos los carros siguen elegibles (vencido no deshabilita la tarjeta)', ['v1', 'v2', 'v3', 'v4', 'v5'].every(id => !A.q(`[data-vehicle="${id}"]`).disabled));

console.log('\n══ A · paso 6: la nota, que no bloquea ══');
await A.hastaConfirmar('v1');
volcar('paso6', A.wiz().innerHTML, 'wiz');
const nota = A.q('#sf-docs-nota');
t('sale la nota antes de iniciar', !!nota, A.wiz().textContent.slice(0, 120));
t('dice exactamente lo que está vencido', notaTxt(nota) === 'Este carro tiene el SOAT y la tecnomecánica vencidos. Puedes salir igual; avísale al jefe.', notaTxt(nota));
t('no menciona lo que solo está por vencer (el seguro)', !/seguro/i.test(notaTxt(nota)));
t('el ícono va aparte del texto', nota && limpio(nota.firstElementChild) === '📄');
t('con la firma, el botón de iniciar queda habilitado', A.doc.getElementById('sf-confirm') && !A.doc.getElementById('sf-confirm').disabled);
A.pulsar('[data-apt="no"]'); await esperar(40);
t('con NO APTO la nota desaparece (ese turno no sale)', !A.q('#sf-docs-nota'));
A.pulsar('[data-apt="yes"]'); await esperar(40);
t('vuelve con APTO', !!A.q('#sf-docs-nota'));
const firma2 = A.doc.getElementById('sf-sign');
if (firma2 && !firma2.checked) { firma2.checked = true; firma2.dispatchEvent(new A.window.Event('change', { bubbles: true })); await esperar(20); }
A.pulsar('sf-confirm'); await esperar(400);
t('EL TURNO ARRANCA con documentos vencidos (es aviso, no muro)', A.llamadas.arranco === true);
const notasA = (A.llamadas.inspeccion && A.llamadas.inspeccion.notes) || '';
t('la inspección guardada deja la constancia de lo vencido', notasA.split('\n').includes('Documentos del carro vencidos según la app: SOAT y tecnomecánica. Es solo un aviso; no bloquea el carro.'), JSON.stringify(notasA));
t('…sin lo que solo está por vencer', !/seguro/i.test(notasA), JSON.stringify(notasA));

console.log('\n══ B · otro carro: solo lo vencido entra a la nota ══');
let B = await montarAsistente({ modo: 'ok' });
await B.abrir();
await B.hastaConfirmar('v2');
t('P-02: «el extintor vencido» (lo que vence hoy no entra)', notaTxt(B.q('#sf-docs-nota')) === 'Este carro tiene el extintor vencido. Puedes salir igual; avísale al jefe.', notaTxt(B.q('#sf-docs-nota')));
B.pulsar('sf-confirm'); await esperar(400);
t('P-02: constancia «…: extintor.»', ((B.llamadas.inspeccion && B.llamadas.inspeccion.notes) || '') === 'Documentos del carro vencidos según la app: extintor. Es solo un aviso; no bloquea el carro.', JSON.stringify(B.llamadas.inspeccion && B.llamadas.inspeccion.notes));
const B5 = await montarAsistente({ modo: 'ok' });
await B5.abrir();
await B5.hastaConfirmar('v5');
t('P-05 (nada vencido): ni nota ni hueco con contenido', !B5.q('#sf-docs-nota') && !!B5.q('#sf-docs-slot') && B5.q('#sf-docs-slot').innerHTML === '');
B5.pulsar('sf-confirm'); await esperar(400);
t('P-05: arranca y la inspección no lleva constancia (notas vacías)', B5.llamadas.arranco === true && B5.llamadas.inspeccion && B5.llamadas.inspeccion.notes == null, JSON.stringify(B5.llamadas.inspeccion && B5.llamadas.inspeccion.notes));

console.log('\n══ C · inicio rápido: la misma nota, y la gramática ══');
const RAPIDO = { fast_start_enabled: true, fast_start_from_hour: 0, fast_start_to_hour: 24, inspection_grace_minutes: 90 };
async function notaRapida(vid) {
  const R = await montarAsistente({ modo: 'ok', settings: RAPIDO });
  await R.abrir();
  R.pulsar(`[data-vehicle="${vid}"]`); await esperar(30);
  R.pulsar('sf-fast'); await esperar(80);
  const n = R.q('#sf-docs-nota');
  const km = R.doc.getElementById('fk-km');
  if (km) { km.value = '1050'; km.dispatchEvent(new R.window.Event('input', { bubbles: true })); await esperar(20); }
  return { R, txt: notaTxt(n), habilitado: !!R.doc.getElementById('fk-confirm') && !R.doc.getElementById('fk-confirm').disabled };
}
let r1 = await notaRapida('v1');
volcar('rapido', r1.R.wiz().innerHTML, 'wiz');
t('inicio rápido de P-01: la nota sale también ahí', r1.txt === 'Este carro tiene el SOAT y la tecnomecánica vencidos. Puedes salir igual; avísale al jefe.', r1.txt);
t('…y el botón de iniciar sigue habilitado', r1.habilitado);
r1.R.doc.getElementById('fk-confirm').click(); await esperar(200);
t('…y el turno rápido arranca', r1.R.llamadas.arranco === true);
const r3 = await notaRapida('v3');
t('dos femeninas: «la tecnomecánica y las pólizas RC vencidas»', r3.txt === 'Este carro tiene la tecnomecánica y las pólizas RC vencidas. Puedes salir igual; avísale al jefe.', r3.txt);
const r4 = await notaRapida('v4');
t('tres: «el SOAT, el seguro y el extintor vencidos»', r4.txt === 'Este carro tiene el SOAT, el seguro y el extintor vencidos. Puedes salir igual; avísale al jefe.', r4.txt);
const r5 = await notaRapida('v5');
t('nada vencido (vence hoy, por vencer, sin dato, No aplica): sin nota', r5.txt === '', r5.txt);

console.log('\n══ D · la RPC falla (0095 sin aplicar): como antes ══');
const D = await montarAsistente({ modo: 'falla' });
await D.abrir();
const d1 = D.chipsDe('v1');
t('P-01 sigue mostrando «SOAT vencido» (de vehicles)', d1.some(c => c.txt === 'SOAT vencido' && c.rose), JSON.stringify(d1));
t('y nada más de documentos (no se inventa)', !d1.some(c => /Tecnomec|Seguro|Pólizas|Extintor/.test(c.txt)), JSON.stringify(d1));
t('P-02 (sin SOAT en vehicles): sin chips de documentos', !D.chipsDe('v2').some(c => /SOAT|Tecnomec|Seguro|Pólizas|Extintor/.test(c.txt)), JSON.stringify(D.chipsDe('v2')));
await D.hastaConfirmar('v1');
t('sin datos de la base no hay nota', !D.q('#sf-docs-nota'));
D.pulsar('sf-confirm'); await esperar(400);
t('y el turno arranca normal', D.llamadas.arranco === true);
t('sin datos de la base, ninguna constancia en la inspección', !/Documentos del carro/.test((D.llamadas.inspeccion && D.llamadas.inspeccion.notes) || ''), JSON.stringify(D.llamadas.inspeccion && D.llamadas.inspeccion.notes));

console.log('\n══ E · api.js viejo (sin la función): como antes ══');
const E = await montarAsistente({ modo: 'sin-funcion' });
await E.abrir();
t('no revienta y P-01 muestra el SOAT de vehicles', E.chipsDe('v1').some(c => c.txt === 'SOAT vencido'), JSON.stringify(E.chipsDe('v1')));

console.log('\n══ F · la RPC se demora: no frena ni repinta ══');
const F = await montarAsistente({ modo: 'lento', lentoMs: 2600 });
const t0 = Date.now();
F.pulsar('sf-open-btn');
await esperar(1700);   // pasó la espera corta (1,5 s) y la respuesta no ha llegado
const pintado = !!F.q('[data-vehicle="v1"]');
t('a los 1,7 s el paso 1 ya está pintado aunque los documentos no hayan llegado', pintado, limpio(F.wiz()).slice(0, 80));
t('mientras tanto, el SOAT de vehicles (como antes)', F.chipsDe('v1').some(c => c.txt === 'SOAT vencido') && !F.chipsDe('v1').some(c => /Tecnomec/.test(c.txt)), JSON.stringify(F.chipsDe('v1')));
F.pulsar('[data-vehicle="v2"]'); await esperar(30);
const tarjeta = F.q('[data-vehicle="v2"]');
await esperar(1300);   // llegan los documentos
t('cuando llegan, los chips aparecen solos', F.chipsDe('v1').some(c => c.txt === 'Tecnomecánica vencida') && F.chipsDe('v2').some(c => c.txt === 'Extintor vencido'), JSON.stringify(F.chipsDe('v2')));
t('sin repintar la pantalla (la misma tarjeta sigue en su lugar)', tarjeta.isConnected && F.q('[data-vehicle="v2"]') === tarjeta);
t('y el carro elegido sigue elegido', tarjeta.className.includes('border-brand') && !F.doc.getElementById('sf-next').disabled);
t('el SOAT sigue saliendo una sola vez tras el cambio', F.chipsDe('v1').filter(c => /SOAT/.test(c.txt)).length === 1, JSON.stringify(F.chipsDe('v1')));
console.log(`  (prueba F: ${Date.now() - t0} ms)`);

console.log('\n══ F2 · inicio rápido y los documentos llegan tarde: la nota entra igual ══');
{
  const R = await montarAsistente({ modo: 'lento', lentoMs: 2600, settings: RAPIDO });
  R.pulsar('sf-open-btn');
  await esperar(1650);   // pintado sin documentos
  R.pulsar('[data-vehicle="v1"]'); await esperar(30);
  R.pulsar('sf-fast'); await esperar(80);
  const kmEl = R.doc.getElementById('fk-km');
  kmEl.value = '1050'; kmEl.dispatchEvent(new R.window.Event('input', { bubbles: true })); await esperar(20);
  t('en el inicio rápido, antes de que lleguen: sin nota y el hueco oculto', !R.q('#sf-docs-nota') && R.q('#fk-docs-slot') && R.q('#fk-docs-slot').hidden === true);
  await esperar(1100);   // llegan los documentos (2,6 s)
  const n = R.q('#sf-docs-nota');
  t('cuando llegan, la nota aparece en el inicio rápido', notaTxt(n) === 'Este carro tiene el SOAT y la tecnomecánica vencidos. Puedes salir igual; avísale al jefe.', notaTxt(n));
  t('…el hueco ya no está oculto', R.q('#fk-docs-slot') && R.q('#fk-docs-slot').hidden === false);
  volcar('rapido-tarde', R.wiz().innerHTML, 'wiz');
  t('…sin repintar: el mismo campo, con el km tecleado', R.doc.getElementById('fk-km') === kmEl && kmEl.value === '1.050', kmEl.value);
  t('…y el botón de iniciar sigue habilitado', !R.doc.getElementById('fk-confirm').disabled);
  R.doc.getElementById('fk-confirm').click(); await esperar(200);
  t('…y el turno rápido arranca', R.llamadas.arranco === true);

  const R5 = await montarAsistente({ modo: 'lento', lentoMs: 2600, settings: RAPIDO });
  R5.pulsar('sf-open-btn');
  await esperar(1650);
  R5.pulsar('[data-vehicle="v5"]'); await esperar(30);
  R5.pulsar('sf-fast'); await esperar(1200);
  t('P-05 (nada vencido) en el inicio rápido: llegan y el hueco sigue oculto y vacío', R5.llamadas.docs === 1 && !R5.q('#sf-docs-nota') && R5.q('#fk-docs-slot').hidden === true && R5.q('#fk-docs-slot').innerHTML === '');
}

console.log('\n══ F3 · paso 6 y los documentos llegan tarde: la nota entra sin tocar la firma ══');
{
  const S = await montarAsistente({ modo: 'lento', lentoMs: 4200 });
  S.pulsar('sf-open-btn');
  await esperar(1650);
  await S.hastaConfirmar('v1');
  t('en el paso 6 antes de que lleguen: hueco vacío, sin nota', !!S.q('#sf-docs-slot') && !S.q('#sf-docs-nota'));
  const btn = S.doc.getElementById('sf-confirm');
  const firma = S.doc.getElementById('sf-sign');
  await esperar(Math.max(0, 4200 - 1650 - 1100) + 600);
  const n = S.q('#sf-docs-slot #sf-docs-nota');
  t('cuando llegan, la nota entra en el hueco del paso 6', notaTxt(n) === 'Este carro tiene el SOAT y la tecnomecánica vencidos. Puedes salir igual; avísale al jefe.', notaTxt(n));
  t('…con su margen (.mt-3), como cuando sale de una', n && n.parentElement && n.parentElement.className === 'mt-3');
  volcar('paso6-tarde', S.wiz().innerHTML, 'wiz');
  t('…sin repintar: la firma sigue marcada y el botón habilitado', S.doc.getElementById('sf-sign') === firma && firma.checked && S.doc.getElementById('sf-confirm') === btn && !btn.disabled);
  btn.click(); await esperar(400);
  t('…el turno arranca y la constancia queda en la inspección', S.llamadas.arranco === true && ((S.llamadas.inspeccion && S.llamadas.inspeccion.notes) || '').includes('SOAT y tecnomecánica'), JSON.stringify(S.llamadas.inspeccion && S.llamadas.inspeccion.notes));
}

console.log('\n══ I · completar una inspección diferida: sin nota, con constancia ══');
{
  const TURNO = {
    id: 's9', status: 'active', vehicle_id: 'v1', opening_km: 1000,
    start_at: new Date(Date.now() - 3600e3).toISOString(),
    inspection_due_at: new Date(Date.now() + 1800e3).toISOString(),
    vehicles: { internal_code: 'P-01', license_plate: 'RDO481', brand: 'Hyundai', model: 'Accent' },
  };
  const C = await montarAsistente({ modo: 'ok', openShift: TURNO });
  const boton = C.doc.getElementById('sf-do-insp');
  t('la tarjeta ofrece «Hacer inspección ahora»', !!boton);
  boton.click(); await esperar(120);
  t('pidió los documentos SOLO de ese carro', C.llamadas.docs === 1 && JSON.stringify(C.llamadas.docsIds) === '["v1"]', JSON.stringify(C.llamadas.docsIds));
  await C.desdeChecklist({ km: null });
  t('paso 6 de la inspección diferida: sin la nota «Puedes salir igual»', !C.q('#sf-docs-nota') && !/Puedes salir igual/.test(limpio(C.wiz())));
  t('…ni su hueco (no le entra tarde)', !C.q('#sf-docs-slot'));
  t('…y el botón es «Guardar inspección»', /Guardar inspección/.test(limpio(C.doc.getElementById('sf-confirm'))));
  C.pulsar('sf-confirm'); await esperar(400);
  t('guardó la inspección sin arrancar otro turno', !!C.llamadas.inspeccion && C.llamadas.limpioPlazo === true && C.llamadas.arranco === false);
  t('…con la constancia de lo vencido en sus notas', ((C.llamadas.inspeccion && C.llamadas.inspeccion.notes) || '').split('\n').includes('Documentos del carro vencidos según la app: SOAT y tecnomecánica. Es solo un aviso; no bloquea el carro.'), JSON.stringify(C.llamadas.inspeccion && C.llamadas.inspeccion.notes));

  const CF = await montarAsistente({ modo: 'falla', openShift: TURNO });
  CF.doc.getElementById('sf-do-insp').click(); await esperar(120);
  await CF.desdeChecklist({ km: null });
  CF.pulsar('sf-confirm'); await esperar(400);
  t('RPC caída al completar: guarda igual y sin constancia', !!CF.llamadas.inspeccion && !/Documentos del carro/.test(CF.llamadas.inspeccion.notes || ''), JSON.stringify(CF.llamadas.inspeccion && CF.llamadas.inspeccion.notes));
}

console.log('\n══ J · borrador restaurado + la espera corta ══');
{
  const BORRADOR = {
    cuando: Date.now() - 600e3, driverId: 'd1', shiftId: null, vehicleId: 'v1', completing: false,
    step: 3, checklist: { c1: 'ok' }, km: '1050', note: '', severity: null, isApt: true, slots: [], extras: 0,
  };
  const J = await montarAsistente({ modo: 'ok', borrador: BORRADOR });
  await J.abrir(200);
  t('recupera el avance (el aviso de «Recuperamos tu avance»)', /Recuperamos tu avance/.test(J.toastTxt()), J.toastTxt());
  const tj = J.q('[data-vehicle="v1"]');
  t('vuelve al paso 1 con P-01 preelegido', tj && tj.className.includes('border-brand') && !J.doc.getElementById('sf-next').disabled);
  t('y con sus chips de documentos desde la primera pintada', J.chipsDe('v1').some(c => c.txt === 'Tecnomecánica vencida'), JSON.stringify(J.chipsDe('v1')));
  J.pulsar('sf-next'); await esperar(150);
  t('al seguir, vuelve a reservar el carro', J.llamadas.reservas === 1);
  await J.desdeChecklist();
  t('en el paso 6 sale la nota', notaTxt(J.q('#sf-docs-nota')) === 'Este carro tiene el SOAT y la tecnomecánica vencidos. Puedes salir igual; avísale al jefe.', notaTxt(J.q('#sf-docs-nota')));
  J.pulsar('sf-confirm'); await esperar(400);
  t('y el turno arranca', J.llamadas.arranco === true);

  const JL = await montarAsistente({ modo: 'lento', lentoMs: 2600, borrador: BORRADOR });
  JL.pulsar('sf-open-btn');
  await esperar(1700);
  const tl = JL.q('[data-vehicle="v1"]');
  t('borrador + RPC lenta: a los 1,7 s pintado con P-01 preelegido', tl && tl.className.includes('border-brand'), limpio(JL.wiz()).slice(0, 80));
  t('…mientras tanto, el SOAT de vehicles', JL.chipsDe('v1').some(c => c.txt === 'SOAT vencido') && !JL.chipsDe('v1').some(c => /Tecnomec/.test(c.txt)), JSON.stringify(JL.chipsDe('v1')));
  await esperar(1100);
  t('…llegan y los chips aparecen en la misma tarjeta, que sigue elegida', JL.q('[data-vehicle="v1"]') === tl && tl.className.includes('border-brand') && JL.chipsDe('v1').some(c => c.txt === 'Tecnomecánica vencida'), JSON.stringify(JL.chipsDe('v1')));
}

// ══════════════════════════════════════════════════════════════════
console.log('\n══ G · perfil del conductor ══');
async function montarPerfil({ modo = 'ok', turno = true, vehSoat = null } = {}) {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const { window } = dom;
  window.console = { ...console, error: () => {} };
  window.scrollTo = () => {};   // jsdom no lo implementa
  window.eval(read('scheduler.js'));
  window.eval(read('driver-disponibilidad.js'));
  // Lo mínimo de core.js / horario.js / driver-tabs.js que usa el perfil.
  window.eval(`
    var $ = (s) => document.querySelector(s);
    var escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    var initialsOf = (n) => String(n || '').split(' ').map(x => x[0] || '').join('').slice(0, 2).toUpperCase();
    var strikeLimit = () => 3;
    var strikePeriod = () => Scheduler.monthStartISO();
    var rcTheme = () => 'light'; var rcSetTheme = () => {};
    var toast = () => {}; var onLogout = () => {}; var openCambiarMiClave = () => {};
  `);
  const pedidos = [];
  window.Api = {
    getMyDriverProfileId: async () => 'd1',
    getMyFullProfile: async () => ({ id: 'p1', full_name: 'Carlos Mejía', driver: { license_expires_at: addD(HOY, 400) } }),
    listDriverStrikes: async () => [],
    listMyClosedShifts: async () => [],
    listRewards: async () => [],
    listMyRedemptions: async () => [],
    // Igual que el api.js real: el carro embebido NO trae soat/tecnomec.
    getMyOpenShift: async () => turno ? { id: 's1', status: 'active', vehicle_id: 'v1', vehicles: { internal_code: 'P-01', license_plate: 'RDO481', brand: 'Hyundai', model: 'Accent', ...(vehSoat ? { soat_expires_at: vehSoat } : {}) } } : null,
    getMyWeekSuspension: async () => null,
  };
  if (modo !== 'sin-funcion') {
    window.Api.driverVehicleDocuments = async (ids) => {
      pedidos.push(ids);
      if (modo === 'falla') throw new Error('rpc caída');
      return DOCS.map(d => ({ ...d })).concat([{ vehicle_id: 'v1', kind: 'impuesto', label: 'Impuesto vehicular', expires_on: addD(HOY, -5), days_left: -5, status: 'vencido', not_applicable: false }]);
    };
  }
  window.eval('var state = { profile: { id: "p1", full_name: "Carlos Mejía" }, driverId: "d1" };');
  window.eval(read('driver-perfil.js'));
  await window.eval('renderDriverProfile()');
  await esperar(30);
  const box = window.document.getElementById('driver-profile-container');
  const filas = [...box.querySelectorAll('.rc-listrow')].map(r => ({
    lbl: limpio(r.querySelector('.lbl')), val: limpio(r.querySelector('.val')),
    color: (r.querySelector('.val') && r.querySelector('.val').getAttribute('style')) || '',
  }));
  return { box, filas, pedidos };
}
const P = await montarPerfil({ modo: 'ok' });
volcar('perfil', P.box.innerHTML, 'perfil');
const fl = (p, l) => p.filas.find(f => f.lbl === l);
t('documentos personales siguen (licencia)', !!fl(P, 'Licencia de conducción'), JSON.stringify(P.filas.map(f => f.lbl)));
t('SOAT del vehículo: «Vencido» en rojo', fl(P, 'SOAT del vehículo') && fl(P, 'SOAT del vehículo').val === 'Vencido' && /--r-error/.test(fl(P, 'SOAT del vehículo').color), JSON.stringify(fl(P, 'SOAT del vehículo')));
t('Tecnomecánica: «Vencido» en rojo', fl(P, 'Tecnomecánica') && fl(P, 'Tecnomecánica').val === 'Vencido' && /--r-error/.test(fl(P, 'Tecnomecánica').color), JSON.stringify(fl(P, 'Tecnomecánica')));
t('Seguro todo riesgo: «Vence …» en ámbar (por vencer)', fl(P, 'Seguro todo riesgo') && /^Vence /.test(fl(P, 'Seguro todo riesgo').val) && /--r-warn/.test(fl(P, 'Seguro todo riesgo').color), JSON.stringify(fl(P, 'Seguro todo riesgo')));
t('sin dato (pólizas) y «No aplica» (extintor) no salen', !fl(P, 'Pólizas RCC/RCE') && !fl(P, 'Recarga del extintor'), JSON.stringify(P.filas.map(f => f.lbl)));
t('el impuesto no sale aunque llegara (no es de la vía)', !P.filas.some(f => /Impuesto/i.test(f.lbl)));
t('solo los del carro del turno (P-02 vence hoy sus pólizas y no aparece)', !P.filas.some(f => f.val === 'Vence hoy'), JSON.stringify(P.filas));

const P2 = await montarPerfil({ modo: 'ok', turno: false });
t('sin turno activo: ningún documento del carro', !P2.filas.some(f => /SOAT|Tecnomec|Seguro|Pólizas|extintor/i.test(f.lbl)), JSON.stringify(P2.filas.map(f => f.lbl)));

const P3 = await montarPerfil({ modo: 'falla' });
t('RPC caída: el perfil carga y los personales siguen', !!fl(P3, 'Licencia de conducción') && !/No se pudo cargar/.test(limpio(P3.box)), limpio(P3.box).slice(0, 120));
t('…y del carro, lo de antes: nada si vehicles no trae la fecha', !P3.filas.some(f => /SOAT|Tecnomec/.test(f.lbl)), JSON.stringify(P3.filas.map(f => f.lbl)));
const P4 = await montarPerfil({ modo: 'falla', vehSoat: addD(HOY, -2) });
t('…o el SOAT de vehicles si viniera (respaldo intacto)', fl(P4, 'SOAT del vehículo') && fl(P4, 'SOAT del vehículo').val === 'Vencido', JSON.stringify(P4.filas));
const P5 = await montarPerfil({ modo: 'sin-funcion' });
t('api.js viejo: el perfil carga igual', !!fl(P5, 'Licencia de conducción'));

// Un día de la base con hoy: el perfil usa el estado de la base y no lo recalcula.
const Pdia = await (async () => {
  const saved = DOCS.slice();
  DOCS.length = 0;
  DOCS.push(fila('v1', 'soat', 'hoy', 0), fila('v1', 'tecnomecanica', 'al_dia', 45));
  const r = await montarPerfil({ modo: 'ok' });
  DOCS.length = 0; DOCS.push(...saved);
  return r;
})();
t('vence hoy: «Vence hoy» en ámbar', fl(Pdia, 'SOAT del vehículo') && fl(Pdia, 'SOAT del vehículo').val === 'Vence hoy' && /--r-warn/.test(fl(Pdia, 'SOAT del vehículo').color), JSON.stringify(fl(Pdia, 'SOAT del vehículo')));
t('al día (45 d.) sin color de alerta', fl(Pdia, 'Tecnomecánica') && /^Vence /.test(fl(Pdia, 'Tecnomecánica').val) && !/--r-(warn|error)/.test(fl(Pdia, 'Tecnomecánica').color), JSON.stringify(fl(Pdia, 'Tecnomecánica')));

// ══════════════════════════════════════════════════════════════════
console.log('\n══ H · api.js: la RPC y su parámetro ══');
{
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const { window } = dom;
  const rpcs = [];
  window.sb = { rpc: async (name, params) => { rpcs.push({ name, params }); return { data: [{ vehicle_id: 'v1' }], error: null }; } };
  // api.js toma el cliente de window.sb: se le da el falso.
  window.eval(read('api.js'));
  const api = window.Api;
  t('window.Api.driverVehicleDocuments existe', api && typeof api.driverVehicleDocuments === 'function');
  if (api && typeof api.driverVehicleDocuments === 'function') {
    try {
      const sbReal = rpcs;
      await api.driverVehicleDocuments(null);
      await api.driverVehicleDocuments([]);
      await api.driverVehicleDocuments(['v1', 'v2']);
      t('llama a driver_vehicle_documents', sbReal.length === 3 && sbReal.every(x => x.name === 'driver_vehicle_documents'), JSON.stringify(sbReal));
      t('null o [] → p_vehicle_ids null (todos los de su organización)', sbReal[0] && sbReal[0].params.p_vehicle_ids === null && sbReal[1].params.p_vehicle_ids === null, JSON.stringify(sbReal.slice(0, 2)));
      t('con ids → los pasa tal cual', sbReal[2] && JSON.stringify(sbReal[2].params.p_vehicle_ids) === '["v1","v2"]', JSON.stringify(sbReal[2]));
    } catch (e) {
      t('api.js corre contra el sb falso', false, e.message);
    }
  }
}

if (process.env.DUMP_DIR) {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(process.env.DUMP_DIR, { recursive: true });
  const indexHtml = read('index.html');
  let head = indexHtml.match(/<head[\s\S]*?<\/head>/i)[0];
  if (process.env.DUMP_BASE) head = head.replace(/<head([^>]*)>/i, `<head$1><base href="${process.env.DUMP_BASE}">`);
  const WIZ_CLASS = (indexHtml.match(/id="shift-wizard" class="([^"]*)"/) || [, ''])[1].replace('hidden', '').trim();
  for (const [nombre, { html, envoltura }] of Object.entries(DUMPS)) {
    const cuerpo = envoltura === 'wiz'
      ? `<div id="shift-wizard" class="${WIZ_CLASS}">${html}</div>`
      : `<section class="driver-panel rc" style="max-width:420px;margin:0 auto;padding:16px"><div id="driver-profile-container">${html}</div></section>`;
    writeFileSync(`${process.env.DUMP_DIR}/${nombre}.html`, `<!doctype html><html lang="es">${head}<body class="bg-slate-50">${cuerpo}</body></html>`);
  }
  console.log(`\nVolcado: ${Object.keys(DUMPS).join(', ')} en ${process.env.DUMP_DIR}`);
}

console.log(`\n${ok} ok · ${bad} fallos`);
console.log('NO cubre: layout (5 chips en una tarjeta, la nota en un teléfono), la base real');
console.log('(_verify-0095.mjs), PostgREST, el service worker ni un IndexedDB de verdad (aquí es un');
console.log('sustituto mínimo; el borrador con fotos lo cubre _smoke-inicio-turno-dom.mjs).');
process.exit(bad ? 1 : 0);
