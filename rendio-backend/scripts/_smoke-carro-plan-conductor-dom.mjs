// Inicio de turno del conductor: el carro del plan sale primero con «Según el
// plan» (0132, lista de los jefes del 26-oct-2026) — prueba jsdom.
//
// Carga index.html + driver-disponibilidad.js + shift-flow.js DE VERDAD con un Api
// doble y comprueba en el paso 1 («Selecciona tu vehículo»):
//   · con plan (PRW443): sale primero y lleva «Según el plan»; los demás siguen;
//   · si el del plan está en uso, no se adelanta (ni se puede elegir);
//   · sin plan (o sin la función): el orden y las etiquetas de siempre;
//   · el conductor puede elegir otro (manda la inspección; el aviso a los jefes
//     lo hace la base: _verify-0132.mjs).
//
// NO cubre: el layout real en el teléfono ni la base (_verify-0132.mjs).
//
//   cd rendio-backend && node scripts/_smoke-carro-plan-conductor-dom.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
let ok = 0, bad = 0;
const t = (n, c, d = '') => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d ? ' → ' + d : '')); } };
const esperar = (ms = 60) => new Promise(r => setTimeout(r, ms));
const V = (id, code, status = 'available') => ({ id, internal_code: code, license_plate: code, brand: 'Hyundai', model: 'H1', capacity: 4, status, current_km: 100000 });

async function correr({ plan, flota, conFuncion = true }) {
  const dom = new JSDOM(readFileSync(APP + 'index.html', 'utf8'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const { window } = dom;
  global.window = window; global.document = window.document;
  window.RENDIO_CONFIG = {}; window.toast = () => {};
  const errores = [];
  window.console = { ...console, error: (...a) => errores.push(a.join(' ')) };
  const pedidos = [];
  window.Api = {
    getMyDriverProfileId: async () => 'd1',
    listChecklistItems: async () => [], listChecklistItemsForTiers: async () => [], pendingInspectionTiers: async () => [],
    getSettings: async () => ({}), listNoFuelReasons: async () => [], getMyOpenShift: async () => null,
    listVehiclesForShift: async () => flota.map((v) => ({ ...v })), getVehicleStatus: async () => 'available',
  };
  if (conFuncion) window.Api.myPlanVehicleToday = async (pid) => { pedidos.push(pid); return plan; };
  window.state = { settings: {} }; global.state = window.state;
  for (const f of ['driver-disponibilidad.js', 'shift-flow.js']) window.eval(readFileSync(APP + f, 'utf8'));
  await window.ShiftFlow.init({ id: 'p1', full_name: 'Juan Esteban', organization_id: 'o1', role: 'driver' });
  await esperar(120);
  window.document.getElementById('sf-open-btn').click(); await esperar(250);
  const wiz = window.document.getElementById('shift-wizard');
  const cards = [...wiz.querySelectorAll('[data-vehicle]')];
  return { ids: cards.map((b) => b.dataset.vehicle), txt: (id) => (wiz.querySelector(`[data-vehicle="${id}"]`) || { textContent: '' }).textContent.replace(/\s+/g, ' '),
    disabled: (id) => !!(wiz.querySelector(`[data-vehicle="${id}"]`) || {}).disabled, pedidos, errores, wiz, window };
}

console.log('\n── Con carro del plan ──');
{
  const r = await correr({ plan: 'v3', flota: [V('v1', 'HYU376'), V('v2', 'ZZZ999'), V('v3', 'PRW443')] });
  t('se pide el carro del plan del conductor (con su perfil)', r.pedidos.join() === 'p1', r.pedidos.join());
  t('PRW443 (el del plan) sale primero', r.ids[0] === 'v3', r.ids.join());
  t('…con «Según el plan»', /Según el plan/.test(r.txt('v3')), r.txt('v3'));
  t('los demás siguen, sin la etiqueta', r.ids.length === 3 && !/Según el plan/.test(r.txt('v1')) && !/Según el plan/.test(r.txt('v2')));
  r.wiz.querySelector('[data-vehicle="v1"]').click(); await esperar(80);
  t('puede elegir otro (manda la inspección)', !!r.wiz.querySelector('[data-vehicle="v1"].border-brand') && !r.window.document.getElementById('sf-next').disabled);
}
{
  const r = await correr({ plan: 'v3', flota: [V('v1', 'HYU376'), V('v3', 'PRW443', 'in_use')] });
  t('si el del plan está en uso: no se adelanta y no se puede elegir', r.ids[0] === 'v1' && r.disabled('v3') && /Según el plan/.test(r.txt('v3')), r.ids.join());
}
console.log('\n── Sin plan ──');
{
  const r = await correr({ plan: null, flota: [V('v1', 'HYU376'), V('v2', 'ZZZ999')] });
  t('sin plan: el orden de siempre y sin etiqueta', r.ids.join() === 'v1,v2' && !/Según el plan/.test(r.wiz.textContent));
  const r2 = await correr({ plan: 'v2', flota: [V('v1', 'HYU376'), V('v2', 'ZZZ999')], conFuncion: false });
  t('sin la función (app vieja de api.js): igual que antes', r2.ids.join() === 'v1,v2' && !/Según el plan/.test(r2.wiz.textContent));
  t('sin errores', r.errores.length === 0 && r2.errores.length === 0, [...r.errores, ...r2.errores].join(' | '));
}
console.log(`\n${ok}/${ok + bad} pasaron${bad ? ` · ${bad} FALLARON` : ''}`);
console.log('NO cubierto: el layout real en el teléfono ni la base (_verify-0132.mjs).');
process.exit(bad ? 1 : 0);
