// INSPECCIÓN DIFERIDA «AL CERRAR EL TURNO» (0105) — jsdom.
//
// La dueña (12-oct-2026): «Que puedan hacer la inspección al finalizar el turno
// en la noche». Carga index.html + driver-disponibilidad.js + shift-flow.js con
// un Api de PRUEBA (nada sale a la red) y maneja todo por los MISMOS botones que
// toca el conductor; Ajustes con admin-personal.js; api.js contra un sb falso.
//
// Comprueba:
//   1 · api.js: la columna nueva en el escalón de arriba de getSettings; sin la
//       migración queda ausente (sin consulta de más); si la cascada bajó por OTRA
//       columna, el plazo se pide aparte; saveSettings la manda sola, y solo si
//       viene.
//   2 · Ajustes: el desplegable «Plazo de la inspección»; con «Al cerrar el turno»
//       los minutos se apagan (y conservan su número); sin 0105 se apaga y lo
//       dice; «desde 0» ya no se guarda como 12; «hasta 0» = medianoche (24); la
//       franja que cruza la medianoche se guarda tal cual.
//   3 · Inicio rápido: la franja que cruza la medianoche saca el botón (y la que
//       no contiene la hora no); los textos de «al cerrar» (sin cuenta del plazo);
//       manda lo que responde el servidor, no Ajustes.
//   4 · Tarjeta del turno: «la haces al cerrar el turno» sin cuenta regresiva y
//       con «Hacer inspección ahora»; la regla sale del turno (window.sb), no de
//       Ajustes; base sin 0105 → minutos; sin señal → lo que dice Ajustes.
//   5 · «Cerrar turno»: primero la MISMA inspección (sin el paso del km), al
//       guardarla «Seguir con el cierre» y el cierre normal; si ya estaba hecha,
//       directo al cierre; en minutos, el cierre de siempre.
//   6 · Recarga a mitad de camino: el avance de ESA inspección vuelve (solo las
//       fotos que el borrador declara); uno de otro turno se bota; y el inicio
//       normal bota un borrador de completar que quedó colgado.
//
// LO QUE NO CUBRE: layout (jsdom no lo hace: que la nota de la tarjeta se lea en
// un iPhone, que el desplegable de Ajustes no se descuadre), la base real (eso es
// _verify-0105.mjs), PostgREST, el service worker ni un IndexedDB de verdad (aquí
// un sustituto mínimo en memoria).
//
//   cd rendio-backend && node scripts/_smoke-inspeccion-al-cerrar-dom.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null && d !== '' ? ' → ' + d : '')); } };
const esperar = (ms = 60) => new Promise(r => setTimeout(r, ms));
const limpio = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const LAS_FIJAS = ['front', 'rear', 'left', 'right', 'dashboard', 'glovebox',
                   'property_card', 'door_left', 'door_right', 'road_kit', 'spare_tire'];
const HORA = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: 'America/Bogota' }).format(new Date())) % 24;

// ───────────────────────────────────────────────────────────────────────────
console.log('\n1 · api.js: getSettings / saveSettings');
{
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = dom.window;
  const FALTAN = new Set();
  const FILA = { morning_label: 'AM', afternoon_label: 'PM', morning_slots: 2, afternoon_slots: 2, photo_retention_days: 60,
    aux_private_enabled: false, fast_start_deadline: 'shift_close' };
  const selects = [], updates = [];
  w.RENDIO_CONFIG = { SUPABASE_URL: 'http://x', SUPABASE_ANON_KEY: 'k' };
  w.sb = {
    auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) },
    from: () => ({
      select(cols) {
        selects.push(cols);
        const pedidas = cols.split(',').map(c => c.trim()).filter(Boolean);
        const falta = pedidas.find(c => FALTAN.has(c));
        const resp = falta ? { data: null, error: { message: `column app_settings.${falta} does not exist` } }
          : { data: Object.fromEntries(pedidas.filter(c => c in FILA).map(c => [c, FILA[c]])), error: null };
        return { eq: () => ({ maybeSingle: async () => resp }) };
      },
      update(cols) {
        updates.push(cols);
        const falta = Object.keys(cols).find(c => FALTAN.has(c));
        return { eq: async () => (falta ? { error: { message: `Could not find the '${falta}' column` } } : { error: null }) };
      },
    }),
  };
  w.eval(read('api.js'));
  let s = await w.Api.getSettings();
  t('con 0105: llega fast_start_deadline', s.fast_start_deadline === 'shift_close', s.fast_start_deadline);
  t('…en la PRIMERA consulta (una sola ida a la base)', selects.length === 1 && /fast_start_deadline/.test(selects[0]), selects.length);
  FALTAN.add('fast_start_deadline'); selects.length = 0;
  s = await w.Api.getSettings();
  t('sin 0105: queda AUSENTE (no un «minutes» inventado)', !('fast_start_deadline' in s));
  t('…bajando un escalón y sin consulta aparte (ya se sabe que no está)', selects.length === 2, selects.length);
  t('…y lo de 0096 sigue llegando', s.photo_retention_days === 60, s.photo_retention_days);
  FALTAN.clear(); FALTAN.add('photo_retention_days'); selects.length = 0;
  s = await w.Api.getSettings();
  t('0105 sí pero 0096 no (aplicadas en desorden): el plazo llega igual, pedido aparte', s.fast_start_deadline === 'shift_close' && selects[selects.length - 1] === 'fast_start_deadline', JSON.stringify(selects.slice(-1)));
  FALTAN.clear(); updates.length = 0;
  await w.Api.saveSettings({ morning_label: 'AM', afternoon_label: 'PM', morning_slots: 2, afternoon_slots: 2, fast_start_deadline: 'shift_close' });
  t('guardar con el plazo: la cascada y DESPUÉS el plazo solo', updates.length === 2 && !('fast_start_deadline' in updates[0]) && JSON.stringify(updates[1]) === '{"fast_start_deadline":"shift_close"}', JSON.stringify(updates.map(u => Object.keys(u).length)));
  updates.length = 0;
  await w.Api.saveSettings({ morning_label: 'AM', afternoon_label: 'PM', morning_slots: 2, afternoon_slots: 2 });
  t('si la pantalla no lo manda (base sin 0105), no se escribe', updates.length === 1 && !('fast_start_deadline' in updates[0]), JSON.stringify(updates.length));
  FALTAN.add('fast_start_deadline'); updates.length = 0;
  let err = null;
  try { await w.Api.saveSettings({ morning_label: 'AM', afternoon_label: 'PM', morning_slots: 2, afternoon_slots: 2, fast_start_deadline: 'minutes' }); } catch (e) { err = e; }
  t('si lo manda y la columna no existe, el error sale (no se traga en silencio)', !!err, String(err && err.message));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n2 · Ajustes › Inicio rápido');
{
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const { window } = dom;
  const doc = window.document;
  window.$ = (s) => doc.querySelector(s);
  window.$$ = (s) => doc.querySelectorAll(s);
  window.toast = () => {}; window.alert = () => {}; window.confirm = () => true;
  let guardado = null;
  window.Api = { saveSettings: async (n) => { guardado = JSON.parse(JSON.stringify(n)); } };
  window.Scheduler = { DAYS: [], monthLabelES: () => '', monthStartISO: () => '' };
  window.eval(`var state = { settings: {}, profile: { id: 'yo', role: 'admin' }, drivers: [], admins: [], activeTab: 'settings' };`);
  window.eval(read('admin-personal.js'));
  const BASE = { _loaded: true, morning_label: 'AM', afternoon_label: 'PM', morning_slots: 2, afternoon_slots: 2,
    coord_slots: 1, shift_hours: 12, auto_close_hours: 14, reservation_idle_minutes: 60, strike_limit: 3, fast_start_enabled: true,
    fast_start_from_hour: 12, fast_start_to_hour: 16, inspection_grace_minutes: 90, photo_retention_days: 60 };
  const pintar = (extra) => { window.eval('state').settings = { ...BASE, ...extra }; window.renderSettings(); };
  const sel = () => window.$('#setting-fast-start-deadline');
  const min = () => window.$('#setting-inspection-grace');
  const cambiar = (el, v) => { el.value = v; el.dispatchEvent(new window.Event('change', { bubbles: true })); };

  const sec = sel() && sel().closest('details.set-sec');
  t('el desplegable existe, en la sección «Inicio rápido (inspección diferida)»', !!sel() && sec && /Inicio rápido/.test(sec.querySelector('summary').textContent));
  t('con sus dos opciones: «En minutos» y «Al cerrar el turno»', sel() && [...sel().options].map(o => `${o.value}:${o.textContent}`).join('|') === 'minutes:En minutos|shift_close:Al cerrar el turno',
    sel() && [...sel().options].map(o => o.value).join(','));
  const ayuda = limpio(sec);
  t('la ayuda explica la franja que cruza la medianoche', /cruza la medianoche/.test(ayuda) && /14 a 2/.test(ayuda) && /0 a 24/.test(ayuda), ayuda.slice(0, 200));
  t('…y que «hasta» no entra', /ya no entra/.test(ayuda));

  pintar({ fast_start_deadline: 'shift_close' });
  t('se pinta «Al cerrar el turno» desde los ajustes', sel().value === 'shift_close' && !sel().disabled);
  t('…y los minutos se apagan, con su número intacto', min().disabled === true && min().value === '90');
  t('…la pastilla de la sección plegada lo dice', /Al cerrar el turno/.test(sec.querySelector('.set-sec-val').textContent), sec.querySelector('.set-sec-val').textContent);
  cambiar(sel(), 'minutes');
  t('al pasar a «En minutos», los minutos se encienden', min().disabled === false);
  cambiar(sel(), 'shift_close');
  t('…y al volver se apagan otra vez', min().disabled === true);
  guardado = null;
  await window.onSaveSettings();
  t('guardar manda fast_start_deadline = shift_close', guardado && guardado.fast_start_deadline === 'shift_close', JSON.stringify(guardado && guardado.fast_start_deadline));
  t('…y los minutos siguen viajando (90), por si vuelve a minutos', guardado && guardado.inspection_grace_minutes === 90);

  pintar({ fast_start_deadline: 'minutes' });
  window.$('#setting-fast-start-from').value = '0'; window.$('#setting-fast-start-to').value = '6';
  guardado = null; await window.onSaveSettings();
  t('«desde 0» se guarda como 0 (antes el `|| 12` lo volvía 12)', guardado && guardado.fast_start_from_hour === 0 && guardado.fast_start_to_hour === 6, JSON.stringify(guardado && [guardado.fast_start_from_hour, guardado.fast_start_to_hour]));
  window.$('#setting-fast-start-from').value = '14'; window.$('#setting-fast-start-to').value = '2';
  guardado = null; await window.onSaveSettings();
  t('la franja 14 a 2 se guarda tal cual', guardado && guardado.fast_start_from_hour === 14 && guardado.fast_start_to_hour === 2);
  window.$('#setting-fast-start-from').value = '20'; window.$('#setting-fast-start-to').value = '0';
  guardado = null; await window.onSaveSettings();
  t('«hasta 0» es la medianoche: se guarda 24', guardado && guardado.fast_start_to_hour === 24, guardado && guardado.fast_start_to_hour);
  window.$('#setting-fast-start-from').value = ''; window.$('#setting-fast-start-to').value = '';
  guardado = null; await window.onSaveSettings();
  t('vacíos vuelven a los defaults (12 y 16)', guardado && guardado.fast_start_from_hour === 12 && guardado.fast_start_to_hour === 16);

  pintar({});   // fila leída, sin la columna
  t('sin 0105: el desplegable se apaga', sel().disabled === true && sel().value === 'minutes');
  t('…y lo dice', /0105/.test(window.$('#setting-fast-start-deadline-hint').textContent));
  t('…los minutos quedan encendidos (es lo único que hay)', min().disabled === false);
  guardado = null; await window.onSaveSettings();
  t('…y guardar NO manda la llave', guardado && !('fast_start_deadline' in guardado), JSON.stringify(guardado && Object.keys(guardado).filter(k => /fast/.test(k))));
}

// ───────────────────────────────────────────────────────────────────────────
// El asistente del conductor, con un Api de prueba.
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

const VEHICULOS = [
  { id: 'v1', internal_code: 'P-01', license_plate: 'RDO481', brand: 'Hyundai', model: 'Accent', capacity: 4, status: 'available', current_km: 1000, last_maintenance_km: 900, maintenance_interval_km: 7000 },
];
const MOTIVOS = [{ id: 'r1', label: 'La estación estaba cerrada', requires_text: false, sort_order: 10 }];
// Un turno activo que arrancó con inicio rápido. alCerrar: undefined = el turno
// no trae la columna (como getMyOpenShift de verdad) y la regla sale de window.sb.
const turno = (extra = {}) => ({
  id: 's9', status: 'active', vehicle_id: 'v1', opening_km: 1000,
  start_at: new Date(Date.now() - 10 * 3600e3).toISOString(),
  inspection_due_at: new Date(Date.now() + 4 * 3600e3).toISOString(),
  vehicles: { internal_code: 'P-01', license_plate: 'RDO481', brand: 'Hyundai', model: 'Accent' },
  ...extra,
});

// sbModo: 'al-cerrar' | 'minutos' | 'sin-columna' | 'sin-red' | null (sin window.sb)
async function montar({ settings = {}, openShift = null, sbModo = null, inspeccionYa = null, borrador = null, fotosBorrador = {}, rapidoResp = null } = {}) {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const { window } = dom;
  window.indexedDB = idbEnMemoria({ meta: borrador ? { actual: borrador } : {}, fotos: fotosBorrador });
  window.RENDIO_CONFIG = {}; window.toast = () => {};
  window.confirm = () => true;
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
  const orden = [];
  const llamadas = { inspeccion: null, limpioPlazo: 0, arranco: false, cierre: null, sbLecturas: 0 };
  let abierto = openShift ? { ...openShift } : null;
  if (sbModo) {
    window.sb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => {
              llamadas.sbLecturas++;
              if (sbModo === 'sin-red') throw new TypeError('Failed to fetch');
              if (sbModo === 'sin-columna') return { data: null, error: { code: '42703', message: 'column shifts.inspection_at_close does not exist' } };
              return { data: { inspection_at_close: sbModo === 'al-cerrar' }, error: null };
            },
          }),
        }),
      }),
    };
  }
  window.Api = {
    getMyDriverProfileId: async () => 'd1',
    listChecklistItems: async () => [{ id: 'c1', label: 'Luces funcionando', category: 'Exterior' }],
    listChecklistItemsForTiers: async () => [],
    pendingInspectionTiers: async () => [],
    getSettings: async () => settings,
    listNoFuelReasons: async () => MOTIVOS,
    getMyOpenShift: async () => (abierto ? { ...abierto } : null),
    getMyLastClosedShift: async () => null,
    listVehiclesForShift: async () => VEHICULOS.map(v => ({ ...v })),
    getVehicleStatus: async () => 'available',
    reserveVehicleForShift: async () => ({ shift_id: 's1' }),
    createShiftDraft: async () => 's1',
    getExistingInitialInspectionId: async () => inspeccionYa,
    createInspection: async (fila) => { orden.push('inspeccion'); llamadas.inspeccion = fila; return 'i1'; },
    startShift: async () => { llamadas.arranco = true; return { ok: true }; },
    startShiftDeferred: async () => { llamadas.arranco = true; return rapidoResp || { inspection_due_at: new Date(Date.now() + 5400e3).toISOString() }; },
    abortShift: async () => {},
    clearInspectionDue: async () => { orden.push('limpia'); llamadas.limpioPlazo++; if (abierto) abierto.inspection_due_at = null; },
    markInspectionTiersDone: async () => {},
    addIncident: async () => {},
    addInspectionPhotos: async () => {},
    uploadInspectionPhoto: async (p) => p,
    uploadShiftFile: async () => true, addFuelReceipts: async () => true,
    closeShift: async (id, payload) => { orden.push('cierre'); llamadas.cierre = { id, ...payload }; abierto = null; return { km_driven: 200 }; },
    driverVehicleDocuments: async () => [],
  };
  window.state = { settings: {} };
  for (const f of ['driver-disponibilidad.js', 'shift-flow.js']) window.eval(read(f));
  await window.ShiftFlow.init({ id: 'p1', full_name: 'Carlos Mejía', organization_id: 'o1', role: 'driver' });
  await esperar(80);
  const doc = window.document;
  const wiz = () => doc.getElementById('shift-wizard');
  const card = () => doc.getElementById('driver-shift-container');
  const q = (s) => wiz().querySelector(s);
  const pulsar = (id) => { const el = doc.getElementById(id); if (!el) throw new Error(`no encontré #${id}. Pantalla: ${limpio(wiz()).slice(0, 160)}`); el.click(); };
  const foto = async (slot) => {
    q(`[data-slot="${slot}"]`).click();
    const input = doc.getElementById('sf-photo-input');
    const file = new window.File(['x'.repeat(1024)], slot + '.jpg', { type: 'image/jpeg' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
    await esperar(20);
  };
  const toastTxt = () => limpio(doc.getElementById('toast'));
  return { window, doc, wiz, card, q, pulsar, foto, toastTxt, llamadas, orden, idb: window.indexedDB };
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n3 · Inicio rápido: la franja y los textos');
{
  const cruza = HORA >= 2 ? { from: HORA, to: 1 } : { from: 23, to: HORA + 1 };
  const A = await montar({ settings: { fast_start_enabled: true, fast_start_from_hour: cruza.from, fast_start_to_hour: cruza.to, inspection_grace_minutes: 90 } });
  A.pulsar('sf-open-btn'); await esperar(200);
  A.q('[data-vehicle="v1"]').click(); await esperar(40);
  t(`franja que cruza la medianoche (${cruza.from} a ${cruza.to}, en Colombia son las ${HORA}): sale el botón`, !!A.doc.getElementById('sf-fast'));
  const fuera = { from: (HORA + 1) % 24, to: ((HORA + 2) % 24) || 24 };
  const B = await montar({ settings: { fast_start_enabled: true, fast_start_from_hour: fuera.from, fast_start_to_hour: fuera.to } });
  B.pulsar('sf-open-btn'); await esperar(200);
  t(`franja que no contiene la hora (${fuera.from} a ${fuera.to}): no sale`, !B.doc.getElementById('sf-fast'));
  const C = await montar({ settings: { fast_start_enabled: true, fast_start_from_hour: 12, fast_start_to_hour: 12 } });
  C.pulsar('sf-open-btn'); await esperar(200);
  t('desde = hasta sigue siendo vacía (como antes)', !C.doc.getElementById('sf-fast'));

  const AL = { fast_start_enabled: true, fast_start_from_hour: 0, fast_start_to_hour: 24, inspection_grace_minutes: 90, fast_start_deadline: 'shift_close' };
  const R = await montar({ settings: AL, rapidoResp: { inspection_due_at: new Date(Date.now() + 14 * 3600e3).toISOString(), inspection_at_close: true } });
  R.pulsar('sf-open-btn'); await esperar(200);
  R.q('[data-vehicle="v1"]').click(); await esperar(40);
  t('paso 1: «haz la inspección al cerrar el turno»', /haz la inspección al cerrar el turno/.test(limpio(R.wiz())), limpio(R.wiz()).slice(-160));
  R.pulsar('sf-fast'); await esperar(100);
  const kmTxt = limpio(R.wiz());
  t('pantalla del km: «la inspección la haces al cerrar el turno»', /la inspección la haces al cerrar el turno\./.test(kmTxt), kmTxt.slice(0, 160));
  t('…sin la cuenta del plazo («Tendrás 1h 30m»)', !/Tendrás/.test(kmTxt) && !/1h 30m/.test(kmTxt));
  t('…con el recordatorio de lo que va a pasar al cerrar', /cuando toques «Cerrar turno», la app te la pide primero/.test(limpio(R.q('#fk-plazo'))), limpio(R.q('#fk-plazo')));
  const km = R.doc.getElementById('fk-km'); km.value = '1050'; km.dispatchEvent(new R.window.Event('input', { bubbles: true }));
  R.pulsar('fk-confirm'); await esperar(200);
  const fin = limpio(R.wiz());
  t('al arrancar: «¡En ruta! Inspección al cerrar», sin hora límite', /Inspección al cerrar/.test(fin) && !/Tienes hasta las/.test(fin), fin.slice(0, 200));

  const M = await montar({ settings: { ...AL, fast_start_deadline: 'minutes' } });
  M.pulsar('sf-open-btn'); await esperar(200);
  M.q('[data-vehicle="v1"]').click(); await esperar(40);
  M.pulsar('sf-fast'); await esperar(100);
  t('en minutos, la pantalla del km sigue igual («Tendrás 1h 30m»)', /Tendrás 1h 30m para hacer la inspección/.test(limpio(M.wiz())));
  const km2 = M.doc.getElementById('fk-km'); km2.value = '1050'; km2.dispatchEvent(new M.window.Event('input', { bubbles: true }));
  M.pulsar('fk-confirm'); await esperar(200);
  t('…y el final dice la hora límite, como siempre', /Tienes hasta las/.test(limpio(M.wiz())), limpio(M.wiz()).slice(0, 160));

  // Ajustes decía «al cerrar», pero el servidor (sin 0105) arrancó en minutos.
  const S = await montar({ settings: AL });
  S.pulsar('sf-open-btn'); await esperar(200);
  S.q('[data-vehicle="v1"]').click(); await esperar(40);
  S.pulsar('sf-fast'); await esperar(100);
  const km3 = S.doc.getElementById('fk-km'); km3.value = '1050'; km3.dispatchEvent(new S.window.Event('input', { bubbles: true }));
  S.pulsar('fk-confirm'); await esperar(200);
  t('si el servidor responde sin inspection_at_close, manda él: el final es el de minutos', /Tienes hasta las/.test(limpio(S.wiz())), limpio(S.wiz()).slice(0, 160));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n4 · La tarjeta del turno');
{
  const A = await montar({ openShift: turno(), sbModo: 'al-cerrar' });
  const nota = limpio(A.card());
  t('«Inspección pendiente: la haces al cerrar el turno»', /Inspección pendiente: la haces al cerrar el turno/.test(nota), nota.slice(0, 200));
  t('…sin cuenta regresiva ni «se vence»', !A.doc.getElementById('sf-insp-left') && !/faltan|vencida|antes de que se venza/.test(nota));
  t('…con «Hacer inspección ahora» todavía', !!A.doc.getElementById('sf-do-insp'));
  t('…la regla la leyó del turno (una consulta a shifts)', A.llamadas.sbLecturas === 1, A.llamadas.sbLecturas);

  const B = await montar({ openShift: turno(), sbModo: 'minutos', settings: { fast_start_deadline: 'shift_close' } });
  t('turno que arrancó en minutos, aunque Ajustes diga «al cerrar»: cuenta regresiva de siempre', !!B.doc.getElementById('sf-insp-left') && /antes de que se venza/.test(limpio(B.card())), limpio(B.card()).slice(0, 160));
  const C = await montar({ openShift: turno(), sbModo: 'sin-columna', settings: { fast_start_deadline: 'shift_close' } });
  t('base sin 0105 (la columna no existe): minutos', !!C.doc.getElementById('sf-insp-left'));
  const D = await montar({ openShift: turno(), sbModo: 'sin-red', settings: { fast_start_deadline: 'shift_close' } });
  t('sin señal para preguntar: lo que dice Ajustes hoy («al cerrar»)', /la haces al cerrar el turno/.test(limpio(D.card())));
  const E = await montar({ openShift: turno({ inspection_at_close: true }), sbModo: 'minutos' });
  t('si el turno ya trae la columna, no se pregunta aparte', E.llamadas.sbLecturas === 0 && /la haces al cerrar el turno/.test(limpio(E.card())), E.llamadas.sbLecturas);
  const F = await montar({ openShift: turno({ inspection_due_at: null }), sbModo: 'al-cerrar' });
  t('sin inspección pendiente: ni nota ni consulta', F.llamadas.sbLecturas === 0 && !F.doc.getElementById('sf-do-insp'));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n5 · «Cerrar turno» con la inspección pendiente');
{
  const A = await montar({ openShift: turno(), sbModo: 'al-cerrar' });
  A.pulsar('sf-close-btn'); await esperar(150);
  t('NO va al cierre: abre la inspección (checklist)', !!A.doc.getElementById('sf-all-ok') && !/¿Ya pudo tanquear/.test(limpio(A.wiz())), limpio(A.wiz()).slice(0, 120));
  t('…y dice «Antes de cerrar el turno», no «Inicio de turno»', /Antes de cerrar el turno · Paso 2/.test(limpio(A.wiz())) && !/Inicio de turno/.test(limpio(A.wiz())), limpio(A.wiz()).slice(0, 120));
  A.pulsar('sf-all-ok'); await esperar(40);
  A.pulsar('sf-next'); await esperar(80);
  t('paso de fotos: las mismas 11', LAS_FIJAS.every(s => A.q(`[data-slot="${s}"]`)));
  for (const s of LAS_FIJAS) await A.foto(s);
  A.pulsar('sf-next'); await esperar(80);
  t('del paso de fotos salta el del km (va directo a novedades)', !A.doc.getElementById('sf-km') && /Paso 5/.test(limpio(A.wiz())), limpio(A.wiz()).slice(0, 120));
  A.pulsar('sf-back'); await esperar(60);
  t('…y «atrás» desde novedades vuelve a las fotos, no al km', !!A.q('[data-slot="front"]') && !A.doc.getElementById('sf-km'));
  A.pulsar('sf-next'); await esperar(80);
  A.pulsar('sf-next'); await esperar(80);
  const conf = limpio(A.wiz());
  t('confirmación: «Confirma la inspección» y «Después sigue el cierre»', /Confirma la inspección/.test(conf) && /Después sigue el cierre/.test(conf), conf.slice(0, 200));
  t('…con «Guardar y seguir al cierre»', /Guardar y seguir al cierre/.test(limpio(A.doc.getElementById('sf-confirm'))));
  const firma = A.doc.getElementById('sf-sign'); firma.checked = true; firma.dispatchEvent(new A.window.Event('change', { bubbles: true }));
  await esperar(20);
  A.pulsar('sf-confirm'); await esperar(400);
  const ins = A.llamadas.inspeccion || {};
  t('guardó la inspección INICIAL del turno, con el km de apertura', ins.kind === 'initial' && ins.shift_id === 's9' && ins.odometer_km === 1000, JSON.stringify({ k: ins.kind, s: ins.shift_id, km: ins.odometer_km }));
  t('…con la constancia de que se hizo al cerrar', /hecha al cerrar el turno/.test(ins.notes || ''), JSON.stringify(ins.notes));
  t('…limpió la marca y no arrancó otro turno', A.llamadas.limpioPlazo === 1 && A.llamadas.arranco === false);
  t('…todavía NO cerró el turno', A.llamadas.cierre === null);
  const fin = limpio(A.wiz());
  t('pantalla final: «Ahora sigue el cierre del turno» + «Seguir con el cierre»', /Ahora sigue el cierre del turno/.test(fin) && !!A.q('#sf-close-next') && !A.q('#sf-route-btn'), fin.slice(0, 200));
  A.pulsar('sf-close-next'); await esperar(150);
  t('«Seguir con el cierre» abre el cierre normal (¿Ya pudo tanquear?)', /¿Ya pudo tanquear\?/.test(limpio(A.wiz())), limpio(A.wiz()).slice(0, 120));
  const $w = (s) => A.wiz().querySelector(s);
  $w('#cl-km').value = '1200'; $w('#cl-km').dispatchEvent(new A.window.Event('input', { bubbles: true }));
  $w('#cl-fuel-no').click(); await esperar(40);
  A.wiz().querySelector('[data-nofuel="r1"]').click(); await esperar(40);
  const at = A.doc.getElementById('cl-attest'); at.checked = true; at.dispatchEvent(new A.window.Event('change', { bubbles: true }));
  await esperar(30);
  A.pulsar('cl-confirm'); await esperar(300);
  t('cierra el turno con su km', A.llamadas.cierre && A.llamadas.cierre.id === 's9' && A.llamadas.cierre.closingKm === 1200, JSON.stringify(A.llamadas.cierre && A.llamadas.cierre.closingKm));
  t('…y en ese orden: inspección → limpiar la marca → cierre', A.orden.join(' → ') === 'inspeccion → limpia → cierre', A.orden.join(' → '));
  t('…termina en «Turno cerrado»', /Turno cerrado/.test(limpio(A.wiz())));
  A.pulsar('cl-done-btn'); await esperar(100);
  t('…y al volver, la tarjeta ofrece iniciar turno', !!A.doc.getElementById('sf-open-btn'));
}
{
  const B = await montar({ openShift: turno(), sbModo: 'al-cerrar', inspeccionYa: 'i-vieja' });
  B.pulsar('sf-close-btn'); await esperar(150);
  t('si la inspección ya estaba guardada (solo faltó limpiar la marca): directo al cierre', /¿Ya pudo tanquear\?/.test(limpio(B.wiz())) && B.llamadas.limpioPlazo === 1 && !B.llamadas.inspeccion, limpio(B.wiz()).slice(0, 100));

  const M = await montar({ openShift: turno(), sbModo: 'minutos' });
  M.pulsar('sf-close-btn'); await esperar(150);
  t('en minutos, «Cerrar turno» va al cierre de siempre (sin pedir la inspección)', /¿Ya pudo tanquear\?/.test(limpio(M.wiz())) && !M.llamadas.inspeccion && M.llamadas.limpioPlazo === 0);

  const X = await montar({ openShift: turno(), sbModo: 'al-cerrar' });
  X.pulsar('sf-do-insp'); await esperar(150);
  t('«Hacer inspección ahora» con plazo «al cerrar»: la de siempre, sin hablar del cierre', /Inicio de turno · Paso 2/.test(limpio(X.wiz())) && !/Antes de cerrar/.test(limpio(X.wiz())));
  X.pulsar('sf-exit'); await esperar(80);
  t('salir la deja pendiente en la tarjeta', /la haces al cerrar el turno/.test(limpio(X.card())));
  X.pulsar('sf-close-btn'); await esperar(150);
  t('…y «Cerrar turno» después sí la pide «antes de cerrar»', /Antes de cerrar el turno/.test(limpio(X.wiz())));
  X.pulsar('sf-exit'); await esperar(80);
  X.pulsar('sf-do-insp'); await esperar(150);
  t('…y si sale y vuelve por «Hacer inspección ahora», ya no arrastra lo del cierre', /Inicio de turno · Paso 2/.test(limpio(X.wiz())));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n6 · Recarga a mitad de camino');
{
  const BORRADOR = {
    cuando: Date.now() - 300e3, driverId: 'd1', shiftId: 's9', vehicleId: 'v1', completing: true,
    step: 2, checklist: { c1: 'ok' }, km: '1000', note: '', severity: null, isApt: true, slots: ['front'], extras: 0,
  };
  const blob = () => new (new JSDOM('').window.Blob)(['jpeg'], { type: 'image/jpeg' });
  const A = await montar({ openShift: turno(), sbModo: 'al-cerrar', borrador: BORRADOR, fotosBorrador: { front: blob(), rear: blob() } });
  A.pulsar('sf-close-btn'); await esperar(200);
  t('vuelve el avance de ESA inspección (el aviso de «Recuperamos tu avance: 1 foto»)', /Recuperamos tu avance: 1 foto/.test(A.toastTxt()), A.toastTxt());
  const marcado = A.wiz().querySelector('[data-check="c1"][data-val="ok"]');
  t('…el checklist sigue marcado', marcado && marcado.className.includes('bg-brand'));
  A.pulsar('sf-next'); await esperar(80);
  const tiene = (s) => !!A.q(`[data-slot="${s}"] img`);
  t('…la foto que el borrador declara vuelve; la que no declara, no', tiene('front') && !tiene('rear'));

  const OTRO = { ...BORRADOR, shiftId: 's-viejo' };
  const B = await montar({ openShift: turno(), sbModo: 'al-cerrar', borrador: OTRO, fotosBorrador: { front: blob() } });
  B.pulsar('sf-close-btn'); await esperar(200);
  t('un borrador de OTRO turno no se restaura', !/Recuperamos/.test(B.toastTxt()) && !B.wiz().querySelector('[data-check="c1"].bg-brand'));
  t('…y se bota (fotos incluidas)', B.idb._stores.get('fotos').size === 0, B.idb._stores.get('fotos').size);

  const C = await montar({ borrador: BORRADOR, fotosBorrador: { front: blob() } });
  C.pulsar('sf-open-btn'); await esperar(250);
  t('inicio normal con un borrador de «completar» colgado: no lo restaura y lo bota', !/Recuperamos/.test(C.toastTxt()) && C.idb._stores.get('fotos').size === 0, C.idb._stores.get('fotos').size);
}

console.log(`\n${ok} ok · ${bad} fallos`);
console.log('NO cubre: layout (la nota de la tarjeta en un iPhone, el desplegable en Ajustes), la base real');
console.log('(_verify-0105.mjs), PostgREST, el service worker ni un IndexedDB de verdad.');
process.exit(bad ? 1 : 0);
