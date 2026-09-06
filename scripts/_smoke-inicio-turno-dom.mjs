// EL INICIO DE TURNO SOBREVIVE A QUE SE CAIGA UNA FOTO.
//
// Regresión del caso REAL del 6-sep-2026 (Juan Esteban, producción): terminó el
// asistente completo, subieron 7 de las 8 fotos y el teléfono se murió antes de
// la octava. Con el orden viejo —fotos primero, turno al final— no quedó NI
// inspección NI turno: 12 minutos de trabajo perdidos, el carro retenido por un
// borrador fantasma, y una hora después release_stale_reservations lo cerró en
// silencio. Él se enteró solo, a las 10 de la mañana.
//
// Esta prueba maneja el asistente por los MISMOS botones que toca el conductor y
// comprueba que, con la foto 8 fallando igual que ese día, el turno sí arranca.
//
// LO QUE ESTO NO CUBRE: jsdom no hace layout ni corre un iPhone. Que el aviso de
// "una foto no subió" se lea bien en pantalla pequeña, y sobre todo que Safari no
// mate la página, SOLO se comprueba en un teléfono real.
//
// REQUIERE jsdom:  cd rendio-backend && npm install --no-save jsdom
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;

let ok = 0, bad = 0;
const t = (n, c, d = '') => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d ? ' → ' + d : '')); } };
const esperar = (ms = 60) => new Promise(r => setTimeout(r, ms));

const CHECK = [
  { id: 'c1', label: 'Luces funcionando', category: 'Exterior' },
  { id: 'c2', label: 'Llantas en buen estado', category: 'Llantas' },
];
const VEHICULO = { id: 'v1', internal_code: 'HYU376', license_plate: 'HYU376', brand: 'Hyundai', model: 'Accent', status: 'available', current_km: 238000 };
const LAS_8 = ['front', 'rear', 'left', 'right', 'dashboard', 'glovebox', 'door_left', 'door_right'];

// fallaHasta: cuántas veces seguidas debe fallar la subida de door_right.
// Infinity = se cayó de verdad (el caso de Juan Esteban).
async function correr({ fallaHasta }) {
  const dom = new JSDOM(readFileSync(APP + 'index.html', 'utf8'),
    { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const { window } = dom;
  global.window = window; global.document = window.document;
  window.RENDIO_CONFIG = {}; window.toast = () => {};
  // Los fallos de foto son a propósito: la app los registra con console.error y
  // ensuciarían la salida de la prueba.
  window.console = { ...console, error: () => {} };
  window.URL.createObjectURL = () => 'blob:x'; window.URL.revokeObjectURL = () => {};

  // Shims mínimos para que compressPhoto (Image + canvas) corra en jsdom.
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

  // El Api espía: registra el ORDEN de las llamadas.
  const orden = [];
  const intentosPorFoto = {};
  const subidas = [];
  let filasFoto = [];
  window.Api = {
    getMyDriverProfileId: async () => 'd1',
    listChecklistItems: async () => CHECK,
    listChecklistItemsForTiers: async () => [],
    pendingInspectionTiers: async () => [],
    getSettings: async () => ({}),
    listNoFuelReasons: async () => [],
    getMyOpenShift: async () => null,
    // Copia fresca: el asistente marca el vehículo como 'reserved' al elegirlo, y
    // si devolviéramos el mismo objeto el segundo escenario lo vería ya ocupado.
    listVehiclesForShift: async () => [{ ...VEHICULO }],
    getVehicleStatus: async () => 'available',
    reserveVehicleForShift: async () => { orden.push('reservar'); return { shift_id: 's1' }; },
    createShiftDraft: async () => { orden.push('borrador'); return 's1'; },
    getExistingInitialInspectionId: async () => null,
    createInspection: async () => { orden.push('inspección'); return 'i1'; },
    startShift: async () => { orden.push('ARRANCAR TURNO'); return { ok: true }; },
    abortShift: async () => { orden.push('abortar'); },
    clearInspectionDue: async () => {},
    markInspectionTiersDone: async () => {},
    addIncident: async () => { orden.push('novedad'); },
    addInspectionPhotos: async (rows) => { orden.push('filas-fotos'); filasFoto = rows; },
    uploadInspectionPhoto: async (path) => {
      const slot = path.split('/').pop().replace('.jpg', '');
      intentosPorFoto[slot] = (intentosPorFoto[slot] || 0) + 1;
      if (slot === 'door_right' && intentosPorFoto[slot] <= fallaHasta) {
        throw new Error('Failed to fetch');
      }
      orden.push('foto:' + slot);
      subidas.push(slot);
      return path;
    },
  };
  window.state = { settings: {} }; global.state = window.state;

  for (const f of ['driver-disponibilidad.js', 'shift-flow.js']) window.eval(readFileSync(APP + f, 'utf8'));
  await window.ShiftFlow.init({ id: 'p1', full_name: 'Juan Esteban', organization_id: 'o1', role: 'driver' });
  await esperar(120);

  const doc = window.document;
  const wiz = () => doc.getElementById('shift-wizard');
  const q = (s) => wiz().querySelector(s);
  const txt = () => wiz().textContent.replace(/\s+/g, ' ');
  // Si un paso no aparece, decir DÓNDE se quedó en vez de reventar con "null".
  const pulsar = (sel) => {
    const el = sel.startsWith('[') ? q(sel) : doc.getElementById(sel);
    if (!el) throw new Error(`no encontré "${sel}". El asistente está en: ${txt().slice(0, 160)}`);
    el.click();
  };

  // — abrir el asistente —
  pulsar('sf-open-btn'); await esperar(200);
  // — paso 1: vehículo —
  pulsar('[data-vehicle="v1"]'); await esperar(100);
  pulsar('sf-next'); await esperar(200);
  // — paso 2: checklist —
  pulsar('sf-all-ok'); await esperar(100);
  pulsar('sf-next'); await esperar(150);
  // — paso 3: las 8 fotos, una por una, como el conductor —
  for (const slot of LAS_8) {
    q(`[data-slot="${slot}"]`).click();
    const input = doc.getElementById('sf-photo-input');
    const file = new window.File(['x'], slot + '.jpg', { type: 'image/jpeg' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
    await esperar(40);
  }
  const capturadas = LAS_8.length;
  pulsar('sf-next'); await esperar(150);
  // — paso 4: kilometraje —
  const km = doc.getElementById('sf-km');
  km.value = '238645'; km.dispatchEvent(new window.Event('input', { bubbles: true }));
  await esperar(80);
  pulsar('sf-next'); await esperar(150);
  // — paso 5: novedades (ninguna) —
  pulsar('sf-next'); await esperar(150);
  // — paso 6: firmar y confirmar —
  const firma = doc.getElementById('sf-sign');
  firma.checked = true; firma.dispatchEvent(new window.Event('change', { bubbles: true }));
  await esperar(80);
  pulsar('sf-confirm');
  // Los reintentos esperan 0,8s y 1,6s: hay que dejarlos correr enteros.
  await esperar(4000);

  return { orden, subidas, filasFoto, texto: txt(), capturadas, intentosPorFoto };
}

// ══════════════════════════════════════════════════════════════════
console.log('\n══ ESCENARIO A · la foto 8 se cae de verdad (el caso del 6-sep) ══');
const A = await correr({ fallaHasta: Infinity });

t('el conductor sí logró capturar las 8 fotos', A.capturadas === 8, String(A.capturadas));
t('EL TURNO ARRANCÓ pese a la foto perdida', A.orden.includes('ARRANCAR TURNO'));
t('la inspección quedó registrada', A.orden.includes('inspección'));

const iInsp = A.orden.indexOf('inspección');
const iArr = A.orden.indexOf('ARRANCAR TURNO');
const iFoto1 = A.orden.findIndex(x => x.startsWith('foto:'));
// Ojo con el orden: exigir que el evento EXISTA además de ir primero. Con el
// código viejo indexOf devuelve -1 y "-1 < 7" pasaba en falso.
t('la inspección se registra ANTES de subir fotos', iInsp >= 0 && iInsp < iFoto1, A.orden.join(' → '));
t('el turno arranca ANTES de subir fotos', iArr >= 0 && iArr < iFoto1, A.orden.join(' → '));

t('subió las 7 que sí pudo', A.subidas.length === 7, A.subidas.join(','));
t('la que falló fue door_right', !A.subidas.includes('door_right'));
t('reintentó la foto 3 veces antes de rendirse', A.intentosPorFoto.door_right === 3, String(A.intentosPorFoto.door_right));
t('registró en la BD las 7 que sí subieron', A.filasFoto.length === 7, String(A.filasFoto.length));
t('le dice al conductor que está en ruta', /Listo, en ruta/.test(A.texto), A.texto.slice(0, 120));
t('y le avisa honestamente que faltó una foto', /una foto no subió/.test(A.texto), A.texto.slice(0, 200));
t('le dice CUÁL faltó', /Puerta pasajero/.test(A.texto));
t('NO le dice que no se pudo completar', !/No se pudo completar/.test(A.texto));

console.log('\n══ ESCENARIO B · bache de señal: falla 2 veces y a la tercera entra ══');
const B = await correr({ fallaHasta: 2 });
t('el reintento salvó la foto', B.subidas.includes('door_right'), B.subidas.join(','));
t('subieron las 8', B.subidas.length === 8, String(B.subidas.length));
t('se registraron las 8 en la BD', B.filasFoto.length === 8, String(B.filasFoto.length));
t('el turno arrancó', B.orden.includes('ARRANCAR TURNO'));
t('NO le muestra ningún aviso de foto perdida', !/no subió/.test(B.texto));

console.log(`\n${ok}/${ok + bad} pasaron${bad ? ` · ${bad} FALLARON` : ''}`);
process.exit(bad ? 1 : 0);
