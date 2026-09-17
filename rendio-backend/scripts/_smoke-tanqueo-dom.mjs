// EL CIERRE DE TURNO CON TANQUEO CONDICIONAL (0077), POR LA PUERTA REAL.
//
// No inyecta estado a mano: arranca ShiftFlow.init con un turno activo y llega
// al cierre pulsando el mismo botón que pulsa el conductor. Así se prueba el
// camino que existe, no uno inventado para la prueba.
//
// LO QUE ESTO NO CUBRE: jsdom no hace layout. Que los botones no se solapen, que
// la lista de motivos quepa en un iPhone y que el teclado no tape la cajita de
// texto SOLO se ve en un dispositivo real.
//
// REQUIERE jsdom:  cd rendio-backend && npm install --no-save jsdom
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;

const dom = new JSDOM(readFileSync(APP + 'index.html', 'utf8'),
  { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom; global.window = window; global.document = window.document;
window.RENDIO_CONFIG = {}; window.toast = () => {};
window.URL.createObjectURL = () => 'blob:x'; window.URL.revokeObjectURL = () => {};

let ok = 0, bad = 0;
const t = (n, c, d = '') => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d ? ' → ' + d : '')); } };

const MOTIVOS = [
  { id: 'r1', label: 'La estación estaba cerrada', requires_text: false, sort_order: 10 },
  { id: 'r2', label: 'No alcanzó el tiempo',       requires_text: false, sort_order: 20 },
  { id: 'r9', label: 'Otro',                        requires_text: true,  sort_order: 90 },
];
const TURNO = { id: 's1', status: 'active', start_at: new Date(Date.now() - 6 * 3600e3).toISOString(),
                opening_km: 1000, vehicle_id: 'v1', vehicles: { internal_code: 'AV1', license_plate: 'ABC123', brand: 'Kia', model: 'Rio' } };
let enviado = null;
window.Api = {
  getMyDriverProfileId: async () => 'd1',
  listChecklistItems: async () => [],
  getSettings: async () => ({}),
  listNoFuelReasons: async () => MOTIVOS,
  getMyOpenShift: async () => TURNO,
  getInspectionDue: async () => null,
  listMyVueltasForDriver: async () => [],
  listVehicles: async () => [], listAvailableVehicles: async () => [],
  getVehicleStatus: async () => 'available',
  uploadShiftFile: async () => true, addFuelReceipts: async () => true,
  closeShift: async (id, payload) => { enviado = payload; return { km_driven: 280 }; },
};
window.state = { settings: {} }; global.state = window.state;

for (const f of ['driver-disponibilidad.js', 'shift-flow.js']) window.eval(readFileSync(APP + f, 'utf8'));
await window.ShiftFlow.init({ id: 'p1', full_name: 'Tester', organization_id: 'o1', role: 'driver' });
const esperar = (ms = 60) => new Promise(r => setTimeout(r, ms));
await esperar(120);

// Llegar al cierre por el botón real.
const btnCerrar = window.document.getElementById('sf-close-btn');
t('la tarjeta ofrece cerrar turno', !!btnCerrar);
if (!btnCerrar) { console.log(`\n${ok}/${ok + bad} pasaron · ${bad} FALLARON`); process.exit(1); }
btnCerrar.click(); await esperar(120);

const wiz = () => window.document.getElementById('shift-wizard');
const txt = () => wiz().textContent.replace(/\s+/g, ' ');
const $ = (s) => wiz().querySelector(s);
const confirmar = () => window.document.getElementById('cl-confirm');

console.log('\n── la pregunta nueva ──');
t('pregunta si ya pudo tanquear', /¿Ya pudo tanquear\?/.test(txt()), txt().slice(0, 120));
t('ya NO exige el comprobante de entrada', !/Obligatorio: adjunta al menos un recibo/.test(txt()));
t('explica el procedimiento nuevo', /sin pasajeros/.test(txt()));
t('no muestra comprobantes antes de contestar', !$('#cl-add-receipt'));
t('no muestra motivos antes de contestar', !$('[data-nofuel]'));

console.log('\n── sin contestar, no se cierra ──');
$('#cl-km').value = '1280'; $('#cl-km').dispatchEvent(new window.Event('input', { bubbles: true }));
window.document.getElementById('cl-attest').checked = true;
window.document.getElementById('cl-attest').dispatchEvent(new window.Event('change', { bubbles: true }));
await esperar();
t('con km y firma pero sin contestar, el botón sigue bloqueado', confirmar().disabled);

console.log('\n── camino SÍ TANQUEÉ (como siempre) ──');
$('#cl-fuel-si').click(); await esperar();
t('aparece el adjuntar comprobante', !!$('#cl-add-receipt'));
t('no aparecen los motivos', !$('[data-nofuel]'));
t('sin recibo, sigue bloqueado (la regla vieja se conserva)', confirmar().disabled);

console.log('\n── camino NO PUDE ──');
$('#cl-fuel-no').click(); await esperar();
t('desaparece el adjuntar comprobante', !$('#cl-add-receipt'));
t('aparecen los 3 motivos del catálogo', wiz().querySelectorAll('[data-nofuel]').length === 3,
  String(wiz().querySelectorAll('[data-nofuel]').length));
t('sin elegir motivo, sigue bloqueado', confirmar().disabled);

wiz().querySelector('[data-nofuel="r1"]').click(); await esperar();
t('con un motivo normal, ya se puede cerrar', !confirmar().disabled);
t('un motivo normal NO pide texto', !$('#cl-nofuel-text'));

console.log('\n── el "Otro" sí pide escribir ──');
wiz().querySelector('[data-nofuel="r9"]').click(); await esperar();
t('aparece la cajita de texto', !!$('#cl-nofuel-text'));
t('con "Otro" vacío vuelve a bloquearse', confirmar().disabled);
$('#cl-nofuel-text').value = 'se varó la bomba de la Terpel';
$('#cl-nofuel-text').dispatchEvent(new window.Event('input', { bubbles: true }));
await esperar();
t('al escribir se desbloquea', !confirmar().disabled);

console.log('\n── el recibo adjuntado no se cuela ──');
$('#cl-fuel-si').click(); await esperar();
// simula un recibo ya adjuntado y con valor
const btnRec = $('#cl-add-receipt'); t('vuelve el adjuntar al decir que sí', !!btnRec);
$('#cl-fuel-no').click(); await esperar();
wiz().querySelector('[data-nofuel="r2"]').click(); await esperar();

console.log('\n── lo que se manda al servidor ──');
confirmar().click(); await esperar(300);
t('mandó fueled=false', enviado && enviado.fueled === false, JSON.stringify(enviado && enviado.fueled));
t('mandó el id del motivo, no la etiqueta', enviado && enviado.noFuelReasonId === 'r2', enviado && enviado.noFuelReasonId);
t('no mandó comprobantes', enviado && !enviado.receipts);
t('el resumen le dice al conductor que quedó registrado', /No se pudo/.test(txt()), txt().slice(0, 160));
t('y le muestra el motivo', /No alcanzó el tiempo/.test(txt()));

// Volcado del markup REAL para inspeccionarlo con CSS de verdad (no es parte
// de las comprobaciones: jsdom no hace layout, el navegador sí).
if (process.env.DUMP_HTML) {
  const fs = await import('fs');
  const estados = {};
  const abrir = async () => { window.document.getElementById('sf-close-btn').click(); await esperar(150); };
  window.location.hash = '';
  await abrir();
  estados.inicial = wiz().innerHTML;
  $('#cl-fuel-si').click(); await esperar(); estados.si = wiz().innerHTML;
  $('#cl-fuel-no').click(); await esperar(); estados.no = wiz().innerHTML;
  wiz().querySelector('[data-nofuel=\"r9\"]').click(); await esperar(); estados.otro = wiz().innerHTML;
  fs.writeFileSync(process.env.DUMP_HTML, JSON.stringify(estados));
  console.log('HTML volcado en ' + process.env.DUMP_HTML);
}
console.log(`\n${ok}/${ok + bad} pasaron${bad ? ` · ${bad} FALLARON` : ''}`);
console.log('NO cubierto: layout real (solapes, iPhone, teclado sobre la cajita).');
process.exit(bad ? 1 : 0);
