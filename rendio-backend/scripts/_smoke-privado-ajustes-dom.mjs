// LOS CUATRO FALLOS SILENCIOSOS DEL TRASLADO PRIVADO (7-sep-2026).
//
// Ninguno rompía nada a la vista: los cuatro terminan igual —el tripulante no
// ve el paso «¿Cómo quieres viajar?»— y nadie se entera de por qué. Salieron de
// una revisión adversarial después de que la profa preguntara tres veces por
// qué no aparecía el VIP.
//
// REQUIERE jsdom (no está en el repo, es solo para probar):
//   cd rendio-backend && npm install --no-save jsdom
//   node scripts/_smoke-privado-ajustes-dom.mjs
//
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';

const APP = '../rendio-turnos/';
const dom = new JSDOM(readFileSync(APP + 'index.html', 'utf8'),
  { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
global.window = window; global.document = window.document;

let ok = 0, bad = 0;
const t = (n, c, d = '') => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d ? ' → ' + d : '')); } };

// ───────────────────────────────────────────────────────────────────────────
// 1 · api.js: el privado no puede depender de las columnas de rutas
// ───────────────────────────────────────────────────────────────────────────
// La consulta de ajustes pide las columnas del privado PEGADAS a ~40 de otras
// diez migraciones. Si falta una sola de esas (aquí se simula que 0062 no está
// aplicada), la cascada bajaba a un escalón sin `aux_private_*` y el privado
// salía apagado con la fila leída — indistinguible de «el jefe lo apagó».
console.log('\n── api.js · una columna de rutas ausente no puede apagar el privado ──');

const FALTANTES = new Set(['route_holiday_shift_min']);   // 0062 sin aplicar
const FILA = {
  morning_label: 'AM', afternoon_label: 'PM', morning_slots: 2, afternoon_slots: 2,
  coord_slots: 1, shift_hours: 12, auto_close_hours: 14, reservation_idle_minutes: 60,
  strike_limit: 3, fast_start_enabled: true, fast_start_from_hour: 12, fast_start_to_hour: 16,
  inspection_grace_minutes: 90, aux_wait_minutes: 5, aux_min_lead_hours: 6,
  reopen_week_start: null, reopen_until: null,
  aux_private_enabled: true, aux_private_vehicle_id: 'uuid-de-la-camioneta',
  aux_private_price_cop: 150000, aux_private_block_min: 90,
};
const consultas = [];
window.RENDIO_CONFIG = { SUPABASE_URL: 'http://x', SUPABASE_ANON_KEY: 'k' };
window.sb = {
  auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) },
  from: () => ({
    select(cols) {
      consultas.push(cols);
      const pedidas = cols.split(',').map(c => c.trim()).filter(Boolean);
      const falta = pedidas.find(c => FALTANTES.has(c));
      const resp = falta
        ? { data: null, error: { message: `column app_settings.${falta} does not exist` } }
        : { data: Object.fromEntries(pedidas.filter(c => c in FILA).map(c => [c, FILA[c]])), error: null };
      return { eq: () => ({ maybeSingle: async () => resp }) };
    },
  }),
};
window.eval(readFileSync(APP + 'api.js', 'utf8'));

const s = await window.Api.getSettings();
t('la fila se leyó', s._loaded === true);
t('el privado llega ENCENDIDO pese a la columna ausente', s.aux_private_enabled === true,
  'quedó: ' + s.aux_private_enabled);
t('con su camioneta', s.aux_private_vehicle_id === 'uuid-de-la-camioneta', 'quedó: ' + s.aux_private_vehicle_id);
t('y con su tarifa', s.aux_private_price_cop === 150000);
t('se pidieron las columnas del privado SOLAS cuando el escalón no las trajo',
  consultas.some(c => /aux_private_enabled/.test(c) && !/morning_label/.test(c)),
  'consultas: ' + consultas.length);

// Y si de verdad no están las columnas (0069/0070 sin aplicar), apagado.
FALTANTES.add('aux_private_enabled');
const s2 = await window.Api.getSettings();
t('sin las migraciones del privado, sí queda apagado', s2.aux_private_enabled === false);
FALTANTES.delete('aux_private_enabled');

// ───────────────────────────────────────────────────────────────────────────
// 2 · Ajustes del admin: las dos trampas de la camioneta
// ───────────────────────────────────────────────────────────────────────────
console.log('\n── Ajustes · guardar no puede borrar la camioneta ──');

window.$ = (sel) => window.document.querySelector(sel);
window.$$ = (sel) => window.document.querySelectorAll(sel);
let avisos = [];
window.alert = (m) => avisos.push(m);
window.toast = () => {};
let guardado = null;
window.state = { settings: {}, profile: { role: 'admin' }, drivers: [], admins: [] };
global.state = window.state;
window.Api = {
  saveSettings: async (n) => { guardado = JSON.parse(JSON.stringify(n)); },
  listVehiclesBasic: async () => FLOTA,
};
let FLOTA = null;   // null = la consulta de la flota falló
window.eval(readFileSync(APP + 'admin-personal.js', 'utf8'));

const setUI = (s) => { window.state.settings = { ...s }; };
const marcar = (v) => { window.$('#setting-priv-enabled').checked = v; };
const pintarCampos = () => {
  // Lo mínimo que onSaveSettings lee sin guardas.
  window.$('#setting-morning-label').value = 'AM';
  window.$('#setting-afternoon-label').value = 'PM';
  window.$('#setting-morning-slots').value = '2';
  window.$('#setting-afternoon-slots').value = '2';
};
pintarCampos();

// (a) La flota NO carga y el jefe guarda OTRA cosa: la camioneta se conserva.
FLOTA = null;
setUI({ aux_private_enabled: true, aux_private_vehicle_id: 'uuid-de-la-camioneta', aux_private_price_cop: 150000 });
await window.fillPrivateVehicles();
t('con la flota caída el desplegable se marca como no fiable',
  window.$('#setting-priv-vehicle').dataset.flota === 'fallo');
marcar(true);
avisos = [];
await window.onSaveSettings();
t('guardar NO borra la camioneta', guardado.aux_private_vehicle_id === 'uuid-de-la-camioneta',
  'quedó: ' + guardado.aux_private_vehicle_id);
t('y el privado sigue encendido', guardado.aux_private_enabled === true);

// (b) La flota carga y el jefe elige a mano «— Sin definir —»: eso sí vale.
FLOTA = [{ id: 'uuid-de-la-camioneta', plate: 'ABC123', label: 'Van', capacity: 7, status: 'active' },
         { id: 'otro', plate: 'DEF456', label: 'Auto', capacity: 4, status: 'active' }];
setUI({ aux_private_enabled: true, aux_private_vehicle_id: 'uuid-de-la-camioneta', aux_private_price_cop: 150000 });
await window.fillPrivateVehicles();
t('con la flota cargada el desplegable es fiable', window.$('#setting-priv-vehicle').dataset.flota === 'ok');
t('y llega con la camioneta ya seleccionada', window.$('#setting-priv-vehicle').value === 'uuid-de-la-camioneta');
window.$('#setting-priv-vehicle').value = '';   // el jefe la quita a propósito
marcar(true);
avisos = [];
await window.onSaveSettings();
t('quitarla a mano SÍ se guarda', guardado.aux_private_vehicle_id === null);

console.log('\n── Ajustes · encender sin camioneta no es encender ──');
t('no se guarda encendido sin camioneta', guardado.aux_private_enabled === false,
  'quedó: ' + guardado.aux_private_enabled);
t('y se lo dice al jefe', avisos.some(a => /camioneta/i.test(a)), 'avisos: ' + JSON.stringify(avisos));
t('la casilla queda como quedó la base', window.$('#setting-priv-enabled').checked === false);
t('lo demás sí se guardó', guardado.morning_label === 'AM' && guardado.strike_limit === 3);

// (c) El caso bueno: flota cargada, camioneta elegida, interruptor marcado.
setUI({ aux_private_enabled: false, aux_private_vehicle_id: null, aux_private_price_cop: 150000 });
await window.fillPrivateVehicles();
window.$('#setting-priv-vehicle').value = 'uuid-de-la-camioneta';
marcar(true);
avisos = [];
await window.onSaveSettings();
t('encender con camioneta elegida sí queda encendido', guardado.aux_private_enabled === true);
t('con esa camioneta', guardado.aux_private_vehicle_id === 'uuid-de-la-camioneta');
t('y sin sermones', avisos.length === 0, JSON.stringify(avisos));

// ───────────────────────────────────────────────────────────────────────────
// 3 · El tripulante vuelve a leer los ajustes
// ───────────────────────────────────────────────────────────────────────────
// core.js los lee UNA vez al entrar y nadie los refrescaba en este rol: si el
// jefe encendía el privado con la PWA abierta, no lo veía hasta reiniciarla.
console.log('\n── el rol tripulante refresca los ajustes al entrar ──');

let vecesGetSettings = 0;
window.state.settings = { aux_private_enabled: false, aux_private_vehicle_id: null, aux_private_price_cop: 150000 };
window.Api.getSettings = async () => {
  vecesGetSettings++;
  // Lo que el jefe acaba de encender, que la app vieja no tenía.
  return { aux_private_enabled: true, aux_private_vehicle_id: 'uuid-de-la-camioneta',
           aux_private_price_cop: 150000, aux_wait_minutes: 5, aux_min_lead_hours: 6, _loaded: true };
};
window.Api.listMyReservations = async () => [];
window.Api.listResidences = async () => [];
window.Api.getMyAuxiliarPlace = async () => null;
window.L = undefined;
for (const f of ['aux-residencias.js', 'aux-privado.js', 'aux-presentacion.js', 'auxiliar.js'])
  window.eval(readFileSync(APP + f, 'utf8'));

await window.Auxiliar.init({ id: 'p1', full_name: 'Ana Lucía Restrepo Vélez', role: 'auxiliar' });
await new Promise(r => setTimeout(r, 80));
t('al entrar al rol se vuelven a pedir los ajustes', vecesGetSettings >= 1, 'veces: ' + vecesGetSettings);
t('y el privado que el jefe acaba de encender YA se ve', window.AuxPrivado.enabled() === true);

console.log(`\n${ok}/${ok + bad} pasaron${bad ? ' · ' + bad + ' FALLARON' : ''}`);
console.log('NO cubierto: que el jefe entienda el aviso, y la pantalla real de Ajustes en su');
console.log('computador — esto comprueba la lógica, no el layout.');
process.exit(bad ? 1 : 0);
