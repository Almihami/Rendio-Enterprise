// Ajustes › «Días que se guardan las fotos de inspección» (0096), en jsdom.
//
//   1. api.js: la columna nueva va en el escalón de ARRIBA de la cascada de
//      getSettings/saveSettings; sin la migración se cae al escalón de antes sin
//      perder nada más (el teléfono de Coordinación, los carros de Julián…).
//   2. La pantalla: el campo está en la tarjeta del turno, con su rango y las
//      excepciones escritas; se pinta desde state.settings; guarda el número
//      dentro de 30–365; bajar el número pregunta (borra esa noche); sin la
//      migración el campo se apaga y no se manda.
//
//   cd rendio-backend/scripts && node _smoke-retencion-fotos-dom.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d = '') => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d !== '' ? ' → ' + d : '')); } };

// ───────────────────────────────────────────────────────────────────────────
console.log('\n1 · api.js: la cascada');
{
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = dom.window;
  const FALTAN = new Set();
  const FILA = { morning_label: 'AM', afternoon_label: 'PM', morning_slots: 2, afternoon_slots: 2, coord_slots: 1,
    shift_hours: 12, ops_contact_phone: '3001234567', route_cars_count: 3, photo_retention_days: 90,
    aux_private_enabled: false };   // (sin él, getSettings hace una consulta de rescate aparte: otro tema)
  const selects = [], updates = [];
  w.RENDIO_CONFIG = { SUPABASE_URL: 'http://x', SUPABASE_ANON_KEY: 'k' };
  w.sb = {
    auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) },
    from: () => ({
      select(cols) {
        selects.push(cols);
        const pedidas = cols.split(',').map((c) => c.trim()).filter(Boolean);
        const falta = pedidas.find((c) => FALTAN.has(c));
        const resp = falta ? { data: null, error: { message: `column app_settings.${falta} does not exist` } }
          : { data: Object.fromEntries(pedidas.filter((c) => c in FILA).map((c) => [c, FILA[c]])), error: null };
        return { eq: () => ({ maybeSingle: async () => resp }) };
      },
      update(cols) {
        updates.push(cols);
        const falta = Object.keys(cols).find((c) => FALTAN.has(c));
        return { eq: async () => (falta ? { error: { message: `Could not find the '${falta}' column` } } : { error: null }) };
      },
    }),
  };
  w.eval(read('api.js'));
  let s = await w.Api.getSettings();
  t('con 0096: llega photo_retention_days', s.photo_retention_days === 90, s.photo_retention_days);
  t('…en la PRIMERA consulta (una sola ida a la base)', selects.length === 1 && /photo_retention_days/.test(selects[0]), selects.length);
  FALTAN.add('photo_retention_days'); selects.length = 0;
  s = await w.Api.getSettings();
  t('sin 0096: la columna queda AUSENTE (no un 60 inventado)', !('photo_retention_days' in s));
  t('…y no se pierde nada más: teléfono de Coordinación y carros de Julián siguen', s.ops_contact_phone === '3001234567' && s.route_cars_count === 3,
    JSON.stringify({ tel: s.ops_contact_phone, carros: s.route_cars_count }));
  t('…bajando un solo escalón', selects.length === 2, selects.length);

  FALTAN.clear(); updates.length = 0;
  await w.Api.saveSettings({ morning_label: 'AM', afternoon_label: 'PM', morning_slots: 2, afternoon_slots: 2, route_cars_count: 3, photo_retention_days: 45 });
  t('guardar con 0096: un solo UPDATE y lleva los días', updates.length === 1 && updates[0].photo_retention_days === 45 && updates[0].route_cars_count === 3, JSON.stringify(updates.map((u) => u.photo_retention_days)));
  FALTAN.add('photo_retention_days'); updates.length = 0;
  await w.Api.saveSettings({ morning_label: 'AM', afternoon_label: 'PM', morning_slots: 2, afternoon_slots: 2, route_cars_count: 3, photo_retention_days: 45 });
  t('sin 0096: reintenta sin la columna y guarda lo demás', updates.length === 2 && !('photo_retention_days' in updates[1]) && updates[1].route_cars_count === 3, JSON.stringify(updates.map((u) => Object.keys(u).length)));
  FALTAN.clear(); updates.length = 0;
  await w.Api.saveSettings({ morning_label: 'AM', afternoon_label: 'PM', morning_slots: 2, afternoon_slots: 2, route_cars_count: 3 });
  t('si la pantalla no manda el número, no se escribe (ni null ni 60)', updates.length === 1 && !('photo_retention_days' in updates[0]), JSON.stringify(updates[0]));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n2 · La pantalla de Ajustes');
const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
const doc = window.document;
window.$ = (s) => doc.querySelector(s);
window.$$ = (s) => doc.querySelectorAll(s);
window.toast = () => {};
let avisos = [], preguntas = [], responder = true;
window.alert = (m) => avisos.push(m);
window.confirm = (m) => { preguntas.push(m); return responder; };
let guardado = null;
window.Api = { saveSettings: async (n) => { guardado = JSON.parse(JSON.stringify(n)); } };
window.Scheduler = { DAYS: [], monthLabelES: () => '', monthStartISO: () => '' };
window.eval(`var state = { settings: {}, profile: { id: 'yo', role: 'admin' }, drivers: [], admins: [], activeTab: 'settings' };`);
window.eval(read('admin-personal.js'));

const inp = () => window.$('#setting-photo-retention');
const BASE = { _loaded: true, morning_label: '02:30 AM - 02:00 PM', afternoon_label: '02:00 PM - 01:30 AM', morning_slots: 2, afternoon_slots: 2,
  coord_slots: 1, shift_hours: 12, auto_close_hours: 14, reservation_idle_minutes: 60, strike_limit: 3, fast_start_enabled: true,
  fast_start_from_hour: 12, fast_start_to_hour: 16, inspection_grace_minutes: 90 };
const pintar = (extra) => { window.eval('state').settings = { ...BASE, ...extra }; window.renderSettings(); };

const card = window.$('.set-card[data-bloque="turno"]');
t('el campo existe y vive en la tarjeta del turno (lo guarda el mismo botón)', !!inp() && card && card.contains(inp()));
t('con su rango: mínimo 30, máximo 365', inp().min === '30' && inp().max === '365', `${inp().min}–${inp().max}`);
const sec = inp().closest('details.set-sec');
t('en su propia sección plegable «Fotos de inspección»', sec && /Fotos de inspección/.test(sec.querySelector('summary').textContent));
const label = inp().closest('.set-field').querySelector('label').textContent;
t('la etiqueta dice lo que es', /Días que se guardan las fotos de inspección/.test(label), label);
const reglas = (window.$('#setting-photo-retention-rules') || {}).textContent || '';
t('explica las excepciones (golpe, comprobantes, pendiente/rechazada, fallas, novedad, NO APTA)',
  /golpe/.test(reglas) && /comprobantes de tanqueo/.test(reglas) && /pendiente/.test(reglas) && /rechazada/.test(reglas)
  && /falla/.test(reglas) && /novedad/.test(reglas) && /NO APTA/.test(reglas), reglas);

pintar({ photo_retention_days: 90 });
t('se pinta desde los ajustes (90)', inp().value === '90' && !inp().disabled, inp().value);
t('la pastilla de la sección plegada muestra el número', /90/.test(sec.querySelector('.set-sec-val').textContent), sec.querySelector('.set-sec-val').textContent);
t('el pie cuenta el campo nuevo entre los que manda el botón', /Manda los 14 campos/.test(card.querySelector('.set-savenote').textContent), card.querySelector('.set-savenote').textContent);

inp().value = '120'; guardado = null; preguntas = [];
await window.onSaveSettings();
t('subirlo guarda sin preguntar', guardado && guardado.photo_retention_days === 120 && preguntas.length === 0, JSON.stringify(guardado && guardado.photo_retention_days));
t('…y no pisa lo demás del turno', guardado && guardado.strike_limit === 3 && guardado.morning_slots === 2);

pintar({ photo_retention_days: 120 });
inp().value = '500'; guardado = null;
await window.onSaveSettings();
t('más de 365 se guarda como 365', guardado && guardado.photo_retention_days === 365 && inp().value === '365', guardado && guardado.photo_retention_days);

pintar({ photo_retention_days: 90 });
inp().value = '10'; guardado = null; preguntas = []; responder = false;
await window.onSaveSettings();
t('bajarlo PREGUNTA (borra esa misma noche) y diciendo a cuánto', preguntas.length === 1 && /de 90 a 30/.test(preguntas[0]) && /no se deshace/.test(preguntas[0]), preguntas[0]);
t('si dice que no, no se guarda nada', guardado === null);
responder = true; preguntas = []; guardado = null;
inp().value = '10';
await window.onSaveSettings();
t('si dice que sí: menos de 30 se guarda como 30', guardado && guardado.photo_retention_days === 30, guardado && guardado.photo_retention_days);

inp().value = 'abc'; guardado = null;
pintar({ photo_retention_days: 60 });
inp().value = '';
await window.onSaveSettings();
t('vacío vuelve al default (60), sin preguntar porque no baja', guardado && guardado.photo_retention_days === 60, guardado && guardado.photo_retention_days);

console.log('\n3 · Sin la migración 0096 en esta base');
pintar({});                                  // fila leída, pero sin la columna
t('el campo se apaga', inp().disabled === true);
t('y lo dice (no muestra un número que no se guarda en ningún lado)', /0096/.test(window.$('#setting-photo-retention-hint').textContent), window.$('#setting-photo-retention-hint').textContent);
guardado = null;
await window.onSaveSettings();
t('guardar lo demás funciona y NO manda los días', guardado && !('photo_retention_days' in guardado) && guardado.strike_limit === 3, JSON.stringify(guardado && Object.keys(guardado)));
window.eval('state').settings = { ...BASE, _loaded: false };
window.renderSettings();
t('si la fila ni siquiera se pudo leer, no se apaga a ciegas (default 60)', inp().disabled === false && inp().value === '60');

console.log(`\n${ok} ✓ · ${bad} ✗`);
console.log('NO cubre: el diseño en pantalla (jsdom no hace layout) ni que la base acepte el número (eso es el CHECK de');
console.log('0096, probado en _verify-0096.mjs).');
process.exit(bad ? 1 : 0);
