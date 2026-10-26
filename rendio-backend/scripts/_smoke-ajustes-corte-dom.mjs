// Ajustes › Calibración › Traslados de auxiliares: «Corte de pedidos (hora)»
// (0130, lista de los jefes del 26-oct-2026) — prueba jsdom.
//
// Carga index.html + api.js DE VERDAD + admin-personal.js + admin-calibracion.js
// con un `sb` FALSO y comprueba:
//   · el campo lee el corte de la base (7:40 p. m. → «19:40») y la pastilla de la
//     sección lo muestra;
//   · al guardar con 8:15 p. m. manda crew_request_cutoff_min = 1215 aparte (como
//     el corte de la madrugada de 0107), sin tocar lo demás;
//   · sin 0130 en la base el campo se apaga, lo explica y guardar no lo manda.
//
// NO cubre: el selector de hora real del teléfono (type="time"), ni la base real
// (_verify-0130.mjs).
//
//   cd rendio-backend && node scripts/_smoke-ajustes-corte-dom.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null && d !== '' ? ' → ' + d : '')); } };
const wait = (ms = 20) => new Promise(r => setTimeout(r, ms));
const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);

function fakeSb(DB) {
  const updates = [];
  return {
    updates,
    from(name) {
      let cols = ''; let upd = null;
      const b = {
        select(c) { cols = c || ''; return b; }, eq() { return b; }, in() { return b; }, is() { return b; }, order() { return b; }, limit() { return b; },
        gte() { return b; }, lte() { return b; }, neq() { return b; },
        maybeSingle() { return b; }, single() { return b; },
        update(u) { upd = u; return b; },
        then(res, rej) {
          if (name === 'app_settings' && upd) {
            if (DB.sinCorte && 'crew_request_cutoff_min' in upd) return Promise.resolve({ data: null, error: { code: '42703', message: 'no existe crew_request_cutoff_min' } }).then(res, rej);
            updates.push(upd); return Promise.resolve({ data: null, error: null }).then(res, rej);
          }
          if (name === 'app_settings') {
            if (DB.sinCorte && /crew_request_cutoff_min/.test(cols)) return Promise.resolve({ data: null, error: { code: '42703', message: 'no existe' } }).then(res, rej);
            return Promise.resolve({ data: { id: 'singleton', crew_request_cutoff_min: DB.corte, route_night_cutoff_min: 120 }, error: null }).then(res, rej);
          }
          return Promise.resolve({ data: [], error: null }).then(res, rej);
        },
      };
      return b;
    },
    rpc: async () => ({ data: null, error: null }),
    auth: { getSession: async () => ({ data: { session: null } }), getUser: async () => ({ data: { user: null } }) },
  };
}

async function boot(DB) {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const errors = [];
  w.addEventListener('error', (e) => errors.push(e.message));
  w.console.error = (...a) => errors.push(a.map(x => (x && x.message) || String(x)).join(' '));
  w.console.warn = () => {};
  w.RENDIO_CONFIG = {};
  w.sb = fakeSb(DB);
  w.eval(read('api.js'));
  w.toast = () => {}; w.alert = (m) => errors.push('ALERT ' + m);
  const STUBS = `
    var state = { profile: { id: 'jefe', role: 'admin' }, settings: { aux_wait_minutes: 5, aux_min_lead_hours: 6, route_cars_count: 2 } };
    const $ = (s) => document.querySelector(s);
    const $$ = (s) => document.querySelectorAll(s);
    function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
    function zonasRecargar() {}   // vive en otro módulo (las zonas); aquí no se prueba
  `;
  try { w.eval(STUBS + '\n' + read('admin-personal.js') + '\n' + read('admin-calibracion.js') + '\n;window.__C = { renderCalibracion, onSaveCalibracion };'); } catch (e) { errors.push('eval: ' + e.message); }
  return { w, errors, q: (s) => w.document.querySelector(s) };
}

console.log('\n── Con 0130 ──');
{
  const DB = { corte: 1180 };
  const b = await boot(DB);
  try { b.w.__C.renderCalibracion(); } catch (e) { b.errors.push('render: ' + e.message); }
  await wait(60);
  const f = b.q('#setting-aux-cutoff');
  t('el campo existe junto a «Anticipación mínima»', f && f.closest('.set-field').previousElementSibling.querySelector('#setting-aux-lead'));
  t('lee 7:40 p. m. de la base («19:40») y queda encendido', f && f.value === '19:40' && !f.disabled, f && [f.value, f.disabled].join(' / '));
  t('la nota de «falta 0130» está escondida', b.q('#setting-aux-cutoff-off').hidden);
  const sec = f.closest('.set-sec');
  t('la sección lo cuenta en su pastilla', sec && /19:40/.test(txt(sec.querySelector('.set-sec-val'))), sec && txt(sec.querySelector('.set-sec-val')));
  f.value = '20:15';
  await b.w.__C.onSaveCalibracion(); await wait(30);
  const u = b.w.sb.updates;
  t('guardar con 8:15 p. m. manda crew_request_cutoff_min = 1215, aparte', u.some(x => Object.keys(x).length === 1 && x.crew_request_cutoff_min === 1215), JSON.stringify(u.map(x => Object.keys(x).length === 1 ? x : '…')));
  t('el resto de Calibración se guarda igual', u.some(x => x.aux_min_lead_hours === 6 && x.aux_wait_minutes === 5));
  t('sin errores', b.errors.length === 0, b.errors.join(' | '));
}

console.log('\n── Sin 0130 en la base ──');
{
  const b = await boot({ sinCorte: true });
  try { b.w.__C.renderCalibracion(); } catch (e) { b.errors.push('render: ' + e.message); }
  await wait(60);
  const f = b.q('#setting-aux-cutoff');
  t('el campo se apaga con 7:40 p. m. y explica que falta 0130', f.disabled && f.value === '19:40' && !b.q('#setting-aux-cutoff-off').hidden && /Falta la actualización 0130/.test(txt(b.q('#setting-aux-cutoff-off'))));
  await b.w.__C.onSaveCalibracion(); await wait(30);
  t('guardar NO lo manda (y no falla)', !b.w.sb.updates.some(x => 'crew_request_cutoff_min' in x) && b.w.sb.updates.length > 0 && !b.errors.some(e => /ALERT/.test(e)), JSON.stringify(b.errors));
}

console.log(`\n${ok}/${ok + bad} pasaron${bad ? ' · ' + bad + ' FALLARON' : ''}`);
console.log('NO cubierto: el selector de hora real del teléfono ni la base real (_verify-0130.mjs).');
process.exit(bad ? 1 : 0);
