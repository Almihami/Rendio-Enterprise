// ADMIN › Reservas: «Late» al lado de «En pie» (0130, lista de los jefes del
// 26-oct-2026) — prueba jsdom.
//
// «En reservas crear un apartado al lado derecho de En pie, que diga Late, es
// decir, quienes llenen después de las 7:40 el sistema los colocará allí.»
// Carga index.html + api.js DE VERDAD + admin-reservas.js con un `sb` FALSO y
// comprueba:
//   · el corte (Api.crewRequestDeadline / isLateRequest / hm12): el día operativo
//     empieza a las 2:00, la madrugada es del día anterior, el corte es la víspera
//     a las 7:40 p. m. y se puede mover en Ajustes;
//   · el botón «Late» va justo después de «En pie» y cuenta solo lo vivo pedido
//     después del corte (no lo cancelado);
//   · la fila dice «Late · pidió 7:41 p. m. del dom»; «⏱ Pedido tarde» (poca
//     antelación) sale solo si no es Late;
//   · con otro corte en Ajustes (8:00 p. m.) cambia; sin la columna (base sin
//     0130) se usa 7:40 p. m.
//
// LO QUE NO CUBRE: jsdom no hace layout (si «Late» cabe en la fila de filtros del
// celular hay que mirarlo en el dispositivo). Sin base real (_verify-0130.mjs) ni
// push.
//
//   cd rendio-backend && node scripts/_smoke-reservas-late-dom.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null && d !== '' ? ' → ' + d : '')); } };
const wait = (ms = 20) => new Promise(r => setTimeout(r, ms));
const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
// «Ahora» de la prueba: domingo 1-nov-2026, 11:30 p. m. Bogotá.
const FAKE_NOW = Date.parse('2026-11-01T23:30:00-05:00');
const B = (s) => new Date(s + '-05:00').toISOString();

const resv = (id, dir, when, creada, o = {}) => ({
  id, direction: dir, pickup_address: 'El Olivar', required_arrival_at: B(when),
  status_h2a: dir === 'home_to_airport' ? 'requested' : null,
  status_a2h: dir === 'airport_to_home' ? 'requested' : null,
  notes: 'Vuelo AV9563. ', cancelled_at: o.cancel ? B(creada) : null,
  created_at: B(creada), rating: null, rating_tags: null, rated_at: null,
  is_overnight: false, is_firm: true, cancellation_reason: null, ready_confirmed_at: null,
  ground_ops: false, reserve_place: null,
  auxiliar_profiles: { profiles: { id: 'p-' + id, full_name: 'Tripulante ' + id, phone: '' } },
});
// El lunes 2-nov se cierra el domingo 1-nov a las 7:40 p. m.
const RES = [
  resv('a1', 'home_to_airport', '2026-11-02T06:00:00', '2026-11-01T10:00:00'),               // a tiempo
  resv('a2', 'airport_to_home', '2026-11-02T15:00:00', '2026-11-01T19:41:00'),               // Late (un minuto)
  resv('a3', 'airport_to_home', '2026-11-03T00:30:00', '2026-11-01T21:05:00'),               // madrugada del martes = lunes → Late
  resv('a4', 'home_to_airport', '2026-11-03T08:00:00', '2026-11-01T21:05:00'),               // del martes: su corte es el lunes → a tiempo
  resv('a5', 'home_to_airport', '2026-11-02T09:00:00', '2026-11-01T19:50:00', { cancel: true }), // Late pero cancelada
  resv('a6', 'home_to_airport', '2026-11-02T05:00:00', '2026-11-01T23:10:00'),               // Late y con poca antelación
  resv('a7', 'home_to_airport', '2026-11-02T06:30:00', '2026-11-01T19:00:00'),               // a tiempo, pero <12 h → «Pedido tarde»
];

function fakeSb(DB) {
  const cl = (x) => JSON.parse(JSON.stringify(x));
  const val = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? Date.parse(v) : v);
  function from(name) {
    const ops = []; let one = null; let cols = '';
    const b = {
      select(c) { cols = c || ''; return b; },
      eq(c, v) { ops.push(['eq', c, v]); return b; },
      gte(c, v) { ops.push(['gte', c, v]); return b; },
      lte(c, v) { ops.push(['lte', c, v]); return b; },
      in(c, v) { ops.push(['in', c, v]); return b; },
      order() { return b; },
      maybeSingle() { one = true; return b; },
      then(res, rej) {
        if (name === 'app_settings') {
          if (DB.sinCorte && /crew_request_cutoff_min/.test(cols)) return Promise.resolve({ data: null, error: { code: '42703', message: 'column app_settings.crew_request_cutoff_min does not exist' } }).then(res, rej);
          return Promise.resolve({ data: cl(DB.settings), error: null }).then(res, rej);
        }
        const src = name === 'reservations' ? DB.res : null;
        if (!src) return Promise.resolve({ data: null, error: { message: `relation "public.${name}" does not exist` } }).then(res, rej);
        let rows = src.slice();
        for (const [op, c, v] of ops) {
          if (op === 'eq') rows = rows.filter(r => r[c] === v);
          else if (op === 'in') rows = rows.filter(r => v.includes(r[c]));
          else if (op === 'gte') rows = rows.filter(r => val(r[c]) >= val(v));
          else if (op === 'lte') rows = rows.filter(r => val(r[c]) <= val(v));
        }
        return Promise.resolve({ data: one ? (rows[0] ? cl(rows[0]) : null) : cl(rows), error: null }).then(res, rej);
      },
    };
    return b;
  }
  return { from, rpc: async () => ({ data: null, error: { message: 'rpc' } }), auth: { getSession: async () => ({ data: { session: null } }) } };
}

async function boot(DB) {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const errors = [];
  w.console.error = (...a) => { errors.push(a.map(x => (x && x.message) || String(x)).join(' ')); };
  w.console.warn = () => {};
  w.addEventListener('error', (e) => errors.push(e.message));
  w.eval(`Date.now = () => ${FAKE_NOW};`);
  w.RENDIO_CONFIG = {};
  w.sb = fakeSb(DB);
  try { w.eval(read('api.js')); } catch (e) { errors.push('api.js: ' + e.message); }
  w.toast = () => {}; w.notify = async () => {}; w.jcOpen = () => {};
  const STUBS = `
    var state = { profile: { id: 'jefe', role: 'admin', organization_id: 'org-1' }, settings: { aux_min_lead_hours: 12 } };
    const $ = (s) => document.querySelector(s);
    const $$ = (s) => document.querySelectorAll(s);
    function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  `;
  try { w.eval(STUBS + '\n' + read('admin-reservas.js')); } catch (e) { errors.push('admin-reservas.js: ' + e.message); }
  const q = (s) => w.document.querySelector(s);
  const qa = (s) => [...w.document.querySelectorAll(s)];
  const ids = () => qa('#rv-list [data-rv-row]').map(r => r.dataset.rvRow).sort().join(',');
  const n = (sel) => { const b = q(sel); return b ? Number(txt(b.querySelector('.n'))) : null; };
  const click = async (sel) => { const b = q(sel); if (!b) throw new Error('no está ' + sel); b.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await wait(); };
  const row = (id) => q(`[data-rv-row="${id}"]`);
  await w.renderReservas(); await wait(40);
  return { w, errors, q, qa, ids, n, click, row };
}

const DB = { res: RES, settings: { id: 'singleton', crew_request_cutoff_min: 1180, route_night_cutoff_min: 120 } };
const b = await boot(DB);
const A = b.w.Api;

console.log('\n── El corte (api.js) ──');
{
  const cfg = { corte: 1180, noche: 120 };
  const dl = (s) => new Date(A.crewRequestDeadline(B(s), cfg)).toISOString();
  t('lun 2-nov 6:00 → corte dom 1-nov 7:40 p. m.', dl('2026-11-02T06:00:00') === B('2026-11-01T19:40:00'), dl('2026-11-02T06:00:00'));
  t('mar 3-nov 0:30 (madrugada, del lunes) → el mismo corte', dl('2026-11-03T00:30:00') === B('2026-11-01T19:40:00'), dl('2026-11-03T00:30:00'));
  t('mar 3-nov 2:00 ya es del martes → corte lun 2-nov 7:40 p. m.', dl('2026-11-03T02:00:00') === B('2026-11-02T19:40:00'));
  t('isLateRequest: un minuto después es Late; uno antes no; sin fecha de pedido, no se sabe', A.isLateRequest(B('2026-11-02T15:00:00'), B('2026-11-01T19:41:00'), cfg) === true && A.isLateRequest(B('2026-11-02T15:00:00'), B('2026-11-01T19:39:00'), cfg) === false && A.isLateRequest(B('2026-11-02T15:00:00'), null, cfg) === null);
  t('hm12: 7:40 p. m. · 12:00 a. m. · 12:00 p. m.', A.hm12(1180) === '7:40 p. m.' && A.hm12(0) === '12:00 a. m.' && A.hm12(720) === '12:00 p. m.', [A.hm12(1180), A.hm12(0), A.hm12(720)].join(' / '));
  const c0 = await A.getRequestCutoff();
  t('getRequestCutoff lee Ajustes (7:40 p. m. y la madrugada hasta las 2:00)', c0.corte === 1180 && c0.noche === 120 && c0.enBase === true, JSON.stringify(c0));
}

console.log('\n── El botón «Late» ──');
{
  const enPie = b.q('[data-rv-f="active"]'), late = b.q('[data-rv-f="late"]');
  t('existe y va justo a la derecha de «En pie»', late && enPie.nextElementSibling === late && /^Late/.test(txt(late)), late && txt(late));
  t('cuenta 3: los vivos pedidos después del corte (no la cancelada)', b.n('[data-rv-f="late"]') === 3, String(b.n('[data-rv-f="late"]')));
  await b.click('[data-rv-f="late"]');
  t('al tocarlo: solo a2, a3 y a6', b.ids() === 'a2,a3,a6', b.ids());
  t('queda encendido', b.q('[data-rv-f="late"]').classList.contains('on') && !b.q('[data-rv-f="active"]').classList.contains('on'));
  t('se cruza con salidas/llegadas: en Late, Salidas 1 · Llegadas 2', b.n('[data-rv-dir="sal"]') === 1 && b.n('[data-rv-dir="lle"]') === 2);
  await b.click('[data-rv-f="all"]');
}

console.log('\n── La etiqueta de la fila ──');
{
  const chip = (id) => { const r = b.row(id); return r ? [...r.querySelectorAll('.rv-tag')].map(txt).join(' | ') : ''; };
  t('a2: «Late · pidió 7:41 p. m. del dom»', /Late · pidió 7:41 p\. m\. del dom/.test(chip('a2')), chip('a2'));
  t('…y el título explica el corte de las 7:40 p. m.', /después del corte de las 7:40 p\. m\./i.test(b.row('a2').querySelector('.rv-tag.late').getAttribute('title') || ''));
  t('la madrugada del martes (a3) también es Late (es del lunes)', /Late · pidió 9:05 p\. m\. del dom/.test(chip('a3')), chip('a3'));
  t('lo del martes pedido el domingo (a4) no es Late', !/Late/.test(chip('a4')), chip('a4'));
  t('Late con poca antelación (a6): sale Late y NO «Pedido tarde»', /Late/.test(chip('a6')) && !/Pedido tarde/.test(chip('a6')), chip('a6'));
  t('a tiempo pero con poca antelación (a7): «⏱ Pedido tarde», sin Late', /Pedido tarde/.test(chip('a7')) && !/Late/.test(chip('a7')), chip('a7'));
  t('a tiempo y con antelación (a1): ninguna de las dos', !/Late|Pedido tarde/.test(chip('a1')), chip('a1'));
  t('sin errores', b.errors.length === 0, b.errors.join(' | '));
}

console.log('\n── Otro corte en Ajustes, o sin 0130 ──');
{
  const b2 = await boot({ res: RES, settings: { id: 'singleton', crew_request_cutoff_min: 1200, route_night_cutoff_min: 120 } });
  t('con el corte a las 8:00 p. m.: a2 (7:41) ya no es Late → Late cuenta 2', b2.n('[data-rv-f="late"]') === 2 && !/Late/.test(txt(b2.row('a2'))), String(b2.n('[data-rv-f="late"]')));
  const b3 = await boot({ res: RES, sinCorte: true, settings: { id: 'singleton', route_night_cutoff_min: 120 } });
  const c3 = await b3.w.Api.getRequestCutoff();
  t('base sin 0130: se usa 7:40 p. m. y Late cuenta 3 igual', c3.corte === 1180 && c3.enBase === false && b3.n('[data-rv-f="late"]') === 3, JSON.stringify(c3));
  t('sin errores', b2.errors.length === 0 && b3.errors.length === 0, [...b2.errors, ...b3.errors].join(' | '));
}

console.log(`\n${ok}/${ok + bad} pasaron${bad ? ' · ' + bad + ' FALLARON' : ''}`);
console.log('NO cubierto: el layout real (si «Late» cabe en la fila de filtros del celular), la base real (_verify-0130.mjs) ni el push.');
process.exit(bad ? 1 : 0);
