// T6 · ADMIN › Inspecciones: filtros por fecha (un día o rango), conductor y carro — prueba jsdom.
//
// Carga index.html + api.js + admin-inspecciones.js con un `sb` FALSO que imita a
// PostgREST (eq/gte/lt/in/is/order/limit/single sobre datos de prueba, y anota
// cada consulta). Nada sale a la red. Se usa el api.js DE VERDAD para comprobar
// que los filtros llegan a la consulta y no se aplican solo sobre lo ya cargado.
//
// Comprueba:
//   · la barra: modo «Un día / Rango», buscador de conductor, select de carros
//     (los dados de baja en su propio grupo), «Limpiar» y el contador «N inspecciones»;
//   · un día, con la hora de Bogotá (una inspección de las 11:30 p. m. es de ese
//     día aunque en UTC ya sea el siguiente) y los límites que van al servidor;
//   · un día VIEJO, que no está entre las 300 más recientes: sale igual (servidor);
//   · rango, y rango al revés (los campos quedan como se escribieron; se ordena al consultar);
//   · el tecleo de Chrome: `change` en cada dígito del año (0002 → 0020 → 0202 → 2026)
//     no voltea el rango, no pisa el campo que se escribe, no consulta años sin
//     sentido; el campo con foco no se reescribe ni se le tocan min/max; al salir
//     con un año a medio teclear vuelve a la fecha que se aplica;
//   · conductor sin tildes ni mayúsculas, por palabras; «ningún conductor coincide»;
//   · carro, también uno DADO DE BAJA (va aparte en el select); los tres
//     combinados y con las pestañas de estado;
//   · el encabezado y el badge siguen contando la cola entera;
//   · «Limpiar»; una sola consulta al escribir rápido (pausa);
//   · abrir el detalle y volver: los filtros, la lista y el scroll de #app-main siguen;
//     aprobar desde el detalle con filtros puestos;
//   · «Autos» usa el carro de la barra y le aplica fecha y conductor.
//
// LO QUE NO CUBRE: layout (jsdom no lo hace: cómo se acomoda la barra en el
// celular, el selector de fecha nativo de iOS/Android), el campo de fecha de
// Chrome de verdad (aquí se imita su secuencia de `change`; que tocar min/max le
// borre lo escrito a medias es del Chromium real y aquí solo se comprueba que no
// se tocan), la base real (RLS, que
// PostgREST acepte de verdad estos filtros en producción, tiempos de respuesta),
// admin-inspecciones.css (jsdom no carga las hojas) ni core.setTab completo.
//
//   cd rendio-backend && node scripts/_smoke-inspecciones-filtros-dom.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null && d !== '' ? ' → ' + d : '')); } };
const wait = (ms = 20) => new Promise(r => setTimeout(r, ms));
const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);

// ── datos de PRUEBA ─────────────────────────────────────────────────────────
const VEH = [
  { id: 'v-1', internal_code: 'R01', license_plate: 'HNV760', brand: 'Renault', model: 'Logan', status: 'available', deleted_at: null },
  { id: 'v-2', internal_code: 'R02', license_plate: 'JKL123', brand: 'Kia', model: 'Picanto', status: 'available', deleted_at: null },
  { id: 'v-3', internal_code: 'R03', license_plate: 'OLD999', brand: 'Chevrolet', model: 'Spark', status: 'available', deleted_at: '2026-08-01T00:00:00Z' },
];
const DRV = [
  { id: 'dp-1', profile: 'p-1', name: 'Julián Pérez' },
  { id: 'dp-2', profile: 'p-2', name: 'Ana María Gómez' },
  { id: 'dp-3', profile: 'p-3', name: 'José Ñáñez' },
  { id: 'dp-4', profile: 'p-4', name: 'Carlos Ruiz' },
];
const vehEmb = (id) => { const v = VEH.find(x => x.id === id); return { internal_code: v.internal_code, license_plate: v.license_plate, brand: v.brand, model: v.model, status: v.status }; };
const drvEmb = (id) => { const d = DRV.find(x => x.id === id); return { profiles: { id: d.profile, full_name: d.name, email: d.profile + '@prueba.test' } }; };
let nId = 0;
const insp = (bog, vid, did, o = {}) => ({
  id: o.id || 'i-' + (++nId), kind: o.kind || 'initial', has_damage: !!o.dmg, notes: null, odometer_km: 1000 + nId,
  review_status: o.st || (o.dmg ? 'pending' : 'approved'), reviewed_at: null, review_notes: null,
  performed_at: new Date(bog + '-05:00').toISOString(), shift_id: null, vehicle_id: vid, driver_id: did,
  checklist: { items: [], severity: 'media' }, vehicles: vehEmb(vid), driver_profiles: drvEmb(did), inspection_photos: [],
});
const addD = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
function dataset() {
  nId = 0;
  const rows = [];
  // Relleno: 3 inspecciones iniciales por día del 10-jun al 28-sep-2026 (333 filas).
  for (let d = '2026-06-10', k = 0; d <= '2026-09-28'; d = addD(d, 1), k++) {
    rows.push(insp(d + 'T05:10:00', 'v-1', 'dp-1', { dmg: k % 10 === 0 }));
    rows.push(insp(d + 'T14:00:00', 'v-2', 'dp-2', { st: k % 17 === 0 ? 'rejected' : undefined }));
    rows.push(insp(d + 'T18:30:00', 'v-1', 'dp-4'));
  }
  // La de las 11:30 p. m. de Bogotá: en UTC ya es el 11-sep.
  rows.push(insp('2026-09-10T23:30:00', 'v-2', 'dp-3', { id: 'i-noche', dmg: true }));
  // Una vieja (12-jun) que queda FUERA de las 300 más recientes.
  rows.push(insp('2026-06-12T09:00:00', 'v-1', 'dp-3', { id: 'i-vieja' }));
  // Una del carro que se dio de baja (R03): la cola la sigue mostrando.
  rows.push(insp('2026-07-20T08:00:00', 'v-3', 'dp-4', { id: 'i-baja' }));
  // Una de CIERRE (kind final): solo la ve «Autos».
  rows.push(insp('2026-09-10T22:00:00', 'v-2', 'dp-2', { id: 'i-final', kind: 'final' }));
  return rows;
}

// ── sb falso: imita a PostgREST sobre los datos de arriba ───────────────────
function fakeSb(DB, log) {
  const cl = (x) => JSON.parse(JSON.stringify(x));
  const tabla = (name) => {
    if (name === 'inspections') return DB.insp;
    if (name === 'vehicles') return VEH;
    if (name === 'driver_profiles') return DRV.map(d => ({ id: d.id, profile_id: d.profile, profiles: { full_name: d.name } }));
    if (name === 'incidents') return [];
    return null;
  };
  const val = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? Date.parse(v) : v);
  function from(name) {
    const q = { table: name, ops: [] };
    log.push(q);
    let one = null;
    const b = {
      select(cols, opts) { q.ops.push(['select', cols, opts || null]); return b; },
      eq(c, v) { q.ops.push(['eq', c, v]); return b; },
      gte(c, v) { q.ops.push(['gte', c, v]); return b; },
      lt(c, v) { q.ops.push(['lt', c, v]); return b; },
      in(c, v) { q.ops.push(['in', c, v]); return b; },
      is(c, v) { q.ops.push(['is', c, v]); return b; },
      order(c, o) { q.ops.push(['order', c, o || {}]); return b; },
      limit(n) { q.ops.push(['limit', n]); return b; },
      single() { one = 'single'; return b; },
      maybeSingle() { one = 'maybe'; return b; },
      then(res, rej) {
        const src = tabla(name);
        if (!src) return Promise.resolve({ data: null, error: { message: 'tabla desconocida: ' + name } }).then(res, rej);
        let rows = src.slice();
        let lim = null;
        for (const [op, c, v] of q.ops) {
          if (op === 'eq') rows = rows.filter(r => r[c] === v);
          else if (op === 'gte') rows = rows.filter(r => val(r[c]) >= val(v));
          else if (op === 'lt') rows = rows.filter(r => val(r[c]) < val(v));
          else if (op === 'in') rows = rows.filter(r => v.includes(r[c]));
          else if (op === 'is') rows = rows.filter(r => (r[c] ?? null) === v);
          else if (op === 'order') { const asc = v.ascending !== false; rows.sort((a, z) => (val(a[c]) > val(z[c]) ? 1 : val(a[c]) < val(z[c]) ? -1 : 0) * (asc ? 1 : -1)); }
          else if (op === 'limit') lim = c;
        }
        if (lim != null) rows = rows.slice(0, lim);
        const sel = q.ops.find(o => o[0] === 'select');
        if (sel && sel[2] && sel[2].head) return Promise.resolve({ count: rows.length, error: null }).then(res, rej);
        const data = one ? (rows[0] ? cl(rows[0]) : null) : cl(rows);
        if (one === 'single' && !data) return Promise.resolve({ data: null, error: { message: 'no rows' } }).then(res, rej);
        return Promise.resolve({ data, error: null }).then(res, rej);
      },
    };
    return b;
  }
  return {
    from,
    rpc: async (fn, args) => {
      log.push({ rpc: fn, args });
      if (fn === 'review_inspection') { const r = DB.insp.find(x => x.id === args.p_inspection_id); if (r) { r.review_status = args.p_status; r.review_notes = args.p_notes; } return { data: null, error: null }; }
      return { data: null, error: { message: 'rpc desconocida' } };
    },
    storage: { from: () => ({ createSignedUrls: async () => ({ data: [], error: null }) }) },
    auth: { getSession: async () => ({ data: { session: null } }) },
  };
}

async function boot() {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const errors = [], toasts = [], log = [];
  w.console.error = (...a) => { errors.push(a.map(x => (x && x.message) || String(x)).join(' ')); };
  w.addEventListener('error', (e) => errors.push(e.message));
  // En la app, styles.css le da scroll propio a #app-main (.admin-shell): es el que se mueve.
  const css = w.document.createElement('style'); css.textContent = '#app-main{overflow-y:auto}';
  w.document.head.appendChild(css);
  w.RENDIO_CONFIG = {};
  const DB = { insp: dataset() };
  w.sb = fakeSb(DB, log);
  w.eval(read('api.js'));
  const A = w.Api;
  A.countOpenIncidents = async () => 0;
  w.toast = (m) => toasts.push(m);
  w.notify = async () => {};
  w.confirm = () => true;
  // Un solo eval: las declaraciones de nivel superior (const $, const inspState…)
  // de un eval no salen de él, así que los ayudantes de core.js y el módulo van
  // juntos, y al final se expone inspState para poder mirarlo desde la prueba.
  const STUBS = `
    var state = { profile: { id: 'jefe', role: 'admin', organization_id: 'org-1' }, drivers: [] };
    const $ = (s) => document.querySelector(s);
    const $$ = (s) => document.querySelectorAll(s);
    function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
    function colorOfId() { return '#888'; }
    function initialsOf(n) { return String(n || '?').slice(0, 2).toUpperCase(); }
    const VEH_STATUS_ES = { available: 'Disponible' };
  `;
  try { w.eval(STUBS + '\n' + read('admin-inspecciones.js') + '\n;window.__inspState = inspState;'); } catch (e) { errors.push('admin-inspecciones.js: ' + e.message); }
  w.document.querySelector('section[data-panel="inspections"]').classList.remove('hidden');
  const q = (s) => w.document.querySelector(s);
  const qa = (s) => [...w.document.querySelectorAll(s)];
  const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  const change = (el, v) => { el.value = v; el.dispatchEvent(new w.Event('change', { bubbles: true })); };
  const type = (el, v) => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
  const cards = () => qa('#insp-list .icard');
  const ids = () => cards().map(c => (c.querySelector('[data-insp-open]') || {}).getAttribute?.('data-insp-open'));
  const tab = async (f) => { click(q(`#insp-filter [data-f="${f}"]`)); await wait(30); };
  const inspQ = () => log.filter(x => x.table === 'inspections' && x.ops.some(o => o[0] === 'eq' && o[1] === 'kind'));
  const ops = (qq, op, col) => qq.ops.filter(o => o[0] === op && o[1] === col).map(o => o[2]);
  const S = () => w.__inspState;
  return { w, DB, log, errors, toasts, q, qa, click, change, type, cards, ids, tab, inspQ, ops, S };
}
const contador = (b) => txt(b.q('#insp-fct'));

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── La barra y la cola sin filtros ──');
{
  const b = await boot();
  const { w } = b;
  t('carga sin errores', b.errors.length === 0, b.errors.join(' | '));
  t('no crea nombres globales nuevos: todo cuelga de inspState.filtros', typeof w.__inspState.filtros.coincide === 'function' && typeof w.inspFiltros === 'undefined' && typeof w.aplicar === 'undefined');
  await w.renderInspections(); await wait(30);
  const bar = b.q('#insp-flt');
  t('la barra existe, entre las pestañas de estado y la lista', !!bar && bar.previousElementSibling === b.q('#insp-filter') && bar.nextElementSibling === b.q('#insp-autos-bar'));
  t('Fecha con «Un día / Rango», Conductor, Carro, contador y Limpiar',
    b.qa('#insp-fmodo button').map(x => txt(x)).join('|') === 'Un día|Rango' && !!b.q('[data-if="dia"]') && !!b.q('#insp-fq') && !!b.q('#insp-fcarro') && !!b.q('#insp-fct') && !!b.q('#insp-flimpiar'));
  t('por defecto: sin fecha (todas), modo «Un día», Limpiar deshabilitado',
    b.q('[data-if="dia"]').value === '' && b.q('#insp-fmodo [data-fm="dia"]').classList.contains('on') && b.q('[data-if="desde"]').classList.contains('hidden') && b.q('#insp-flimpiar').disabled);
  const opts = b.qa('#insp-fcarro option').map(o => txt(o));
  const grp = b.q('#insp-fcarro optgroup');
  t('select de carros: la flota de la org y, aparte, «Dados de baja» con R03',
    opts.join('|') === 'Todos los carros|R01 · HNV760|R02 · JKL123|R03 · OLD999' && !!grp && grp.label === 'Dados de baja' && [...grp.querySelectorAll('option')].map(o => o.value).join() === 'v-3',
    opts.join('|') + ' · ' + (grp && grp.label));
  t('la flota viene de listInspectionVehicles (sin filtrar deleted_at)', b.log.some(x => x.table === 'vehicles' && !x.ops.some(o => o[0] === 'is' && o[1] === 'deleted_at')));
  const q1 = b.inspQ()[0];
  t('la cola sin filtros: una consulta con tope 300 y sin filtros de fecha/carro/conductor',
    b.inspQ().length === 1 && q1.ops.some(o => o[0] === 'limit' && o[1] === 300)
    && !q1.ops.some(o => ['gte', 'lt', 'in'].includes(o[0])) && !b.ops(q1, 'eq', 'vehicle_id').length);
  const pend = w.__inspState.items.filter(i => i.review_status === 'pending').length;
  t('Pendientes por defecto: lista = pendientes de la cola', b.cards().length === pend, b.cards().length + ' vs ' + pend);
  t('contador «N inspecciones · entre las 300 más recientes» (la cola llegó al tope)', contador(b) === `${pend} inspecciones · entre las 300 más recientes`, contador(b));
  t('encabezado = pendientes de la cola', txt(b.q('#insp-count')) === String(pend));
  await b.tab('all');
  t('«Todas» sin filtros: 300 (la vieja del 12-jun no está)', b.cards().length === 300 && !b.ids().includes('i-vieja'));
  t('sin errores de consola', b.errors.length === 0, b.errors.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Un día (hora de Bogotá) ──');
{
  const b = await boot();
  const { w } = b;
  await w.renderInspections(); await wait(30);
  const pendGlobal = txt(b.q('#insp-count'));
  await b.tab('all');
  b.change(b.q('[data-if="dia"]'), '2026-09-10');
  t('mientras llega: «Buscando…»', contador(b) === 'Buscando…', contador(b));
  await wait(40);
  const last = b.inspQ().at(-1);
  t('al servidor: desde 10-sep 00:00 -05:00 y hasta 11-sep 00:00 -05:00 (exclusivo)',
    b.ops(last, 'gte', 'performed_at')[0] === '2026-09-10T00:00:00-05:00' && b.ops(last, 'lt', 'performed_at')[0] === '2026-09-11T00:00:00-05:00',
    JSON.stringify(last.ops.filter(o => ['gte', 'lt'].includes(o[0]))));
  t('10-sep: las 3 del día + la de las 11:30 p. m. (en UTC ya era 11-sep)', b.cards().length === 4 && b.ids().includes('i-noche'), b.ids().join(','));
  t('contador «4 inspecciones», sin nota de tope', contador(b) === '4 inspecciones', contador(b));
  t('la de cierre (kind final) NO sale en la cola', !b.ids().includes('i-final'));
  t('las pestañas cuentan lo filtrado', txt(b.q('#insp-filter [data-c="all"]')) === '4' && txt(b.q('#insp-filter [data-c="pending"]')) === '1', txt(b.q('#insp-filter')));
  t('…pero el encabezado sigue con los pendientes de la cola entera', txt(b.q('#insp-count')) === pendGlobal, txt(b.q('#insp-count')) + ' vs ' + pendGlobal);
  t('Limpiar se habilita', !b.q('#insp-flimpiar').disabled);
  b.change(b.q('[data-if="dia"]'), '2026-09-11'); await wait(40);
  t('11-sep: las 3 de ese día, sin la de la noche anterior', b.cards().length === 3 && !b.ids().includes('i-noche'), b.ids().join(','));
  b.change(b.q('[data-if="dia"]'), '2026-06-12'); await wait(40);
  t('un día VIEJO (12-jun, fuera de las 300 más recientes) sale igual: el filtro va al servidor',
    b.cards().length === 4 && b.ids().includes('i-vieja') && !w.__inspState.items.some(i => i.id === 'i-vieja'), b.ids().join(','));
  t('sin errores de consola', b.errors.length === 0, b.errors.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Rango ──');
{
  const b = await boot();
  const { w } = b;
  await w.renderInspections(); await wait(30);
  await b.tab('all');
  b.change(b.q('[data-if="dia"]'), '2026-09-01'); await wait(40);
  b.click(b.q('#insp-fmodo [data-fm="rango"]')); await wait(40);
  t('pasar a «Rango» con un día puesto: queda «del día al día»',
    b.q('[data-if="desde"]').value === '2026-09-01' && b.q('[data-if="hasta"]').value === '2026-09-01' && b.q('[data-if="dia"]').classList.contains('hidden') && !b.q('[data-if="hasta"]').classList.contains('hidden') && b.cards().length === 3,
    b.q('[data-if="desde"]').value + '..' + b.q('[data-if="hasta"]').value + ' · ' + b.cards().length);
  b.change(b.q('[data-if="hasta"]'), '2026-09-05'); await wait(40);
  const last = b.inspQ().at(-1);
  t('del 1 al 5 de sep: 15 (3 por día); hasta = 6-sep exclusivo', b.cards().length === 15 && b.ops(last, 'lt', 'performed_at')[0] === '2026-09-06T00:00:00-05:00', b.cards().length + ' ' + b.ops(last, 'lt', 'performed_at')[0]);
  t('contador «15 inspecciones»', contador(b) === '15 inspecciones', contador(b));
  b.change(b.q('[data-if="desde"]'), '2026-09-09'); await wait(40);
  const lr = b.inspQ().at(-1);
  t('rango al revés (9 → 5): los campos quedan como los escribió (no se voltean)',
    b.q('[data-if="desde"]').value === '2026-09-09' && b.q('[data-if="hasta"]').value === '2026-09-05'
    && w.__inspState.filtros.st.desde === '2026-09-09' && w.__inspState.filtros.st.hasta === '2026-09-05',
    b.q('[data-if="desde"]').value + '..' + b.q('[data-if="hasta"]').value);
  t('…y se consulta ordenado: del 5 al 9 (hasta = 10-sep exclusivo), 15 inspecciones',
    b.ops(lr, 'gte', 'performed_at')[0] === '2026-09-05T00:00:00-05:00' && b.ops(lr, 'lt', 'performed_at')[0] === '2026-09-10T00:00:00-05:00' && b.cards().length === 15 && contador(b) === '15 inspecciones',
    JSON.stringify(lr.ops.filter(o => ['gte', 'lt'].includes(o[0]))) + ' · ' + b.cards().length);
  b.change(b.q('[data-if="desde"]'), '2026-09-05'); await wait(40);
  b.change(b.q('[data-if="hasta"]'), ''); await wait(40);
  const l2 = b.inspQ().at(-1);
  t('solo «desde»: sin límite de arriba', b.ops(l2, 'gte', 'performed_at')[0] === '2026-09-05T00:00:00-05:00' && !b.ops(l2, 'lt', 'performed_at').length && b.cards().length === 24 * 3 + 1, b.cards().length);
  b.change(b.q('[data-if="hasta"]'), '2026-09-09'); await wait(40);
  b.click(b.q('#insp-fmodo [data-fm="dia"]')); await wait(40);
  t('de «Rango» a «Un día»: vuelve al día que ya tenía (1-sep)', b.q('[data-if="dia"]').value === '2026-09-01' && b.cards().length === 3, b.q('[data-if="dia"]').value + ' · ' + b.cards().length);
  t('sin errores de consola', b.errors.length === 0, b.errors.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Conductor (sin tildes ni mayúsculas) y carro ──');
{
  const b = await boot();
  const { w } = b;
  await w.renderInspections(); await wait(30);
  await b.tab('all');
  const antes = b.inspQ().length;
  b.type(b.q('#insp-fq'), 'j'); b.type(b.q('#insp-fq'), 'jo'); b.type(b.q('#insp-fq'), 'jose');
  await wait(120);
  t('mientras escribe no consulta (pausa de 300 ms)', b.inspQ().length === antes);
  b.type(b.q('#insp-fq'), 'JOSE ñañez'); await wait(380);
  const last = b.inspQ().at(-1);
  t('una sola consulta al terminar de escribir', b.inspQ().length === antes + 1, String(b.inspQ().length - antes));
  t('«JOSE ñañez» → José Ñáñez: al servidor va su driver_profiles.id', JSON.stringify(b.ops(last, 'in', 'driver_id')[0]) === '["dp-3"]', JSON.stringify(b.ops(last, 'in', 'driver_id')));
  t('…y salen sus 2 (la de la noche y la VIEJA del 12-jun)', b.ids().sort().join(',') === 'i-noche,i-vieja', b.ids().join(','));
  b.type(b.q('#insp-fq'), 'julian'); await wait(380);
  t('«julian» → las 111 de Julián Pérez', b.cards().length === 111 && contador(b) === '111 inspecciones', b.cards().length + ' · ' + contador(b));
  b.type(b.q('#insp-fq'), 'ana gomez'); await wait(380);
  t('por palabras: «ana gomez» → Ana María Gómez (111 iniciales)', b.cards().length === 111);
  const antesZ = b.inspQ().length;
  b.type(b.q('#insp-fq'), 'zzz'); await wait(380);
  t('nadie se llama así: no consulta inspecciones y lo dice', b.inspQ().length === antesZ && /Ningún conductor coincide con «zzz»/.test(txt(b.q('#insp-list'))) && contador(b) === '0 inspecciones', txt(b.q('#insp-list')));
  t('la lista de conductores se pidió UNA vez', b.log.filter(x => x.table === 'driver_profiles').length === 1);
  b.type(b.q('#insp-fq'), ''); await wait(380);
  b.change(b.q('#insp-fcarro'), 'v-2'); await wait(40);
  const lc = b.inspQ().at(-1);
  t('carro R02: al servidor eq(vehicle_id, v-2)', b.ops(lc, 'eq', 'vehicle_id')[0] === 'v-2');
  t('carro R02: 111 de Ana + la de la noche = 112', b.cards().length === 112 && b.cards().every(c => /R02/.test(c.querySelector('.veh').textContent)), String(b.cards().length));
  b.change(b.q('#insp-fcarro'), 'v-3'); await wait(40);
  t('carro DADO DE BAJA (R03): al servidor eq(vehicle_id, v-3) y sale su inspección de julio',
    b.ops(b.inspQ().at(-1), 'eq', 'vehicle_id')[0] === 'v-3' && b.ids().join(',') === 'i-baja' && contador(b) === '1 inspección', b.ids().join(',') + ' · ' + contador(b));
  t('sin errores de consola', b.errors.length === 0, b.errors.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Combinados, pestañas de estado y Limpiar ──');
{
  const b = await boot();
  const { w } = b;
  await w.renderInspections(); await wait(30);
  await b.tab('all');
  b.click(b.q('#insp-fmodo [data-fm="rango"]'));
  b.change(b.q('[data-if="desde"]'), '2026-09-01');
  b.change(b.q('[data-if="hasta"]'), '2026-09-15');
  b.change(b.q('#insp-fcarro'), 'v-2');
  b.type(b.q('#insp-fq'), 'Ana'); await wait(400);
  const last = b.inspQ().at(-1);
  t('los tres a la vez van en UNA consulta', b.ops(last, 'gte', 'performed_at').length === 1 && b.ops(last, 'lt', 'performed_at').length === 1 && b.ops(last, 'eq', 'vehicle_id')[0] === 'v-2' && JSON.stringify(b.ops(last, 'in', 'driver_id')[0]) === '["dp-2"]');
  t('1–15 sep + Ana + R02 → 15', b.cards().length === 15 && contador(b) === '15 inspecciones', b.cards().length + ' · ' + contador(b));
  const rej = w.__inspState.fItems.filter(i => i.review_status === 'rejected').length;
  await b.tab('rejected');
  t('con la pestaña «Rechazadas»: solo las rechazadas de lo filtrado', b.cards().length === rej && txt(b.q('#insp-filter [data-c="rejected"]')) === String(rej), b.cards().length + ' vs ' + rej);
  await b.tab('pending');
  t('«Pendientes» vacía con filtros: lo dice y apunta a «Todas»', b.cards().length === 0 && /Nada con estos filtros/.test(txt(b.q('#insp-list'))) && /Hay 15 en otras pestañas/.test(txt(b.q('#insp-list'))), txt(b.q('#insp-list')));
  await b.tab('all');
  b.change(b.q('#insp-fcarro'), 'v-1'); await wait(40);
  t('Ana + R01 (nunca lo maneja): vacío con filtros', b.cards().length === 0 && /Nada con estos filtros/.test(txt(b.q('#insp-list'))));
  b.click(b.q('#insp-flimpiar')); await wait(40);
  const st = JSON.stringify(w.__inspState.filtros.st);
  t('Limpiar: campos vacíos, sin fItems, el modo se queda en «Rango»',
    b.q('[data-if="desde"]').value === '' && b.q('[data-if="hasta"]').value === '' && b.q('#insp-fq').value === '' && b.q('#insp-fcarro').value === ''
    && w.__inspState.fItems === null && st === JSON.stringify({ modo: 'rango', dia: '', desde: '', hasta: '', q: '', vehicleId: '' }), st);
  t('…vuelve la cola entera (300) y Limpiar queda deshabilitado', b.cards().length === 300 && b.q('#insp-flimpiar').disabled);
  b.change(b.q('[data-if="desde"]'), '2026-09-09');
  b.change(b.q('[data-if="hasta"]'), '2026-09-05'); await wait(40);
  b.click(b.q('#insp-fmodo [data-fm="dia"]')); await wait(40);
  t('de «Rango» (al revés, 9 → 5) a «Un día» sin día puesto: toma el primer día, el 5', b.q('[data-if="dia"]').value === '2026-09-05' && b.cards().length === 3, b.q('[data-if="dia"]').value + ' · ' + b.cards().length);
  t('sin errores de consola', b.errors.length === 0, b.errors.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
// Chrome de escritorio dispara `change` en CADA dígito del año: al teclear
// 15092026 en un campo de fecha el valor pasa por 0002-09-15, 0020-09-15,
// 0202-09-15 y por fin 2026-09-15. Antes, con «Desde» puesto, el primer
// intermedio quedaba menor que «Desde»: se volteaba el par y se reescribían los
// dos campos mientras el admin escribía (rango «desde el año 2, sin tope»).
console.log('\n── Tecleo de Chrome: un change por dígito del año ──');
{
  const b = await boot();
  const { w } = b;
  await w.renderInspections(); await wait(30);
  await b.tab('all');
  const F = () => w.__inspState.filtros;
  const desde = b.q('[data-if="desde"]'), hasta = b.q('[data-if="hasta"]'), dia = b.q('[data-if="dia"]');
  const SEQ = ['0002-09-15', '0020-09-15', '0202-09-15'];
  b.click(b.q('#insp-fmodo [data-fm="rango"]'));
  b.change(desde, '2026-09-01'); await wait(40);
  // Mira si al campo con foco se le toca algún atributo (en Chrome, min/max lo redibujan).
  const tocados = []; const mo = new w.MutationObserver(r => tocados.push(...r)); mo.observe(hasta, { attributes: true });
  hasta.focus();
  const nQ = b.inspQ().length;
  let sano = true, detalle = '';
  for (const v of SEQ) {
    b.change(hasta, v); await wait(15);
    const okPaso = F().st.desde === '2026-09-01' && F().st.hasta === '' && desde.value === '2026-09-01' && hasta.value === v;
    if (!okPaso) { sano = false; detalle = `${v}: st=${JSON.stringify(F().st)} desde=${desde.value} hasta=${hasta.value}`; }
  }
  t('«Hasta» 0002 → 0020 → 0202 con «Desde» = 1-sep: Desde NO cambia, nada se voltea, el campo que escribe no se toca', sano, detalle);
  t('…y esos años sin sentido no consultan', b.inspQ().length === nQ, String(b.inspQ().length - nQ));
  b.change(hasta, '2026-09-15'); await wait(40);
  const last = b.inspQ().at(-1);
  t('al llegar a 2026-09-15: una sola consulta, del 1 al 15 de sep',
    b.inspQ().length === nQ + 1 && b.ops(last, 'gte', 'performed_at')[0] === '2026-09-01T00:00:00-05:00' && b.ops(last, 'lt', 'performed_at')[0] === '2026-09-16T00:00:00-05:00',
    (b.inspQ().length - nQ) + ' · ' + JSON.stringify(last.ops.filter(o => ['gte', 'lt'].includes(o[0]))));
  t('…y trae las 46 (15 días × 3 + la de la noche), no las 300 «desde el año 2»', b.cards().length === 46 && contador(b) === '46 inspecciones', b.cards().length + ' · ' + contador(b));
  t('estado final: desde 1-sep, hasta 15-sep, en los campos y en st',
    JSON.stringify(F().st) === JSON.stringify({ modo: 'rango', dia: '', desde: '2026-09-01', hasta: '2026-09-15', q: '', vehicleId: '' }) && desde.value === '2026-09-01' && hasta.value === '2026-09-15',
    JSON.stringify(F().st));
  tocados.push(...mo.takeRecords());
  t('al campo con foco no se le tocó ningún atributo (ni min ni max) mientras escribía', tocados.length === 0, tocados.map(r => r.attributeName).join(','));
  mo.disconnect();
  hasta.blur(); await wait(10);
  t('al salir de «Hasta» con fecha buena se queda como está', hasta.value === '2026-09-15' && desde.value === '2026-09-01' && hasta.min === '2026-09-01' && desde.max === '2026-09-15');

  // Lo mismo en «Desde» con «Hasta» ya puesto (el orden al revés).
  desde.focus();
  const nQ2 = b.inspQ().length;
  for (const v of ['0002-09-03', '0020-09-03', '0202-09-03']) { b.change(desde, v); await wait(15); }
  t('«Desde» a medio teclear con «Hasta» puesto: Hasta no cambia y no consulta', F().st.hasta === '2026-09-15' && hasta.value === '2026-09-15' && F().st.desde === '2026-09-01' && b.inspQ().length === nQ2);
  // Sale del campo con el año a medias: vuelve a lo que se aplica.
  desde.blur(); await wait(10);
  t('sale de «Desde» con 0202-09-03 a medias: vuelve a 1-sep (lo que se ve = lo que se aplica)', desde.value === '2026-09-01' && b.cards().length === 46, desde.value + ' · ' + b.cards().length);
  desde.focus();
  for (const v of ['0002-09-03', '0020-09-03', '0202-09-03', '2026-09-03']) { b.change(desde, v); await wait(15); }
  await wait(30);
  t('«Desde» 2026-09-03 completo: 3 al 15 de sep, una consulta', F().st.desde === '2026-09-03' && b.inspQ().length === nQ2 + 1 && b.cards().length === 40, (b.inspQ().length - nQ2) + ' · ' + b.cards().length);
  desde.blur();

  // «Un día»: una sola consulta al teclear la fecha (antes eran 4: años 2, 20, 202 y 2026).
  b.click(b.q('#insp-fmodo [data-fm="dia"]')); await wait(40);
  b.click(b.q('#insp-flimpiar')); await wait(40);
  dia.focus();
  const nQ3 = b.inspQ().length;
  for (const v of ['0002-09-10', '0020-09-10', '0202-09-10', '2026-09-10']) { b.change(dia, v); await wait(15); }
  await wait(30);
  t('«Un día» tecleado dígito a dígito: UNA consulta (la de 2026-09-10)', b.inspQ().length === nQ3 + 1 && b.ops(b.inspQ().at(-1), 'gte', 'performed_at')[0] === '2026-09-10T00:00:00-05:00' && b.cards().length === 4, (b.inspQ().length - nQ3) + ' · ' + b.cards().length);

  // Borrar un segmento en Chrome deja el valor vacío: eso SÍ quita la fecha.
  b.change(dia, ''); await wait(40);
  t('vaciar el campo quita la fecha (vuelve la cola entera)', F().st.dia === '' && b.cards().length === 300 && w.__inspState.fItems === null, b.cards().length);
  // Mientras escribe el año, la pausa del buscador (u otra respuesta que llega)
  // repinta la barra: el campo con foco no se reescribe.
  dia.blur();
  b.type(b.q('#insp-fq'), 'ana');
  dia.focus();
  b.change(dia, '0020-09-10');
  await wait(400);
  t('la pausa del buscador repinta la barra y NO le borra el año a medias al campo con foco', dia.value === '0020-09-10' && F().st.dia === '' && F().st.q === 'ana', dia.value + ' · ' + JSON.stringify(F().st));
  b.change(dia, '0202-09-10'); b.change(dia, '2026-09-10'); await wait(40);
  t('…y al completar el año se aplica con el conductor: Ana el 10-sep', F().st.dia === '2026-09-10' && b.ids().length === 1 && /Ana/.test(txt(b.cards()[0].querySelector('.who b'))), b.ids().join(','));
  // Limpiar con el foco en una fecha: la borra igual (lo pidió el admin).
  b.click(b.q('#insp-flimpiar')); await wait(40);
  t('Limpiar con el foco en la fecha: la borra igual', dia.value === '' && b.q('#insp-fq').value === '' && JSON.stringify(F().st) === JSON.stringify({ modo: 'dia', dia: '', desde: '', hasta: '', q: '', vehicleId: '' }), dia.value);
  t('valores que no son fecha (mes 13, año 0000) tampoco consultan', (() => { const n = b.inspQ().length; b.change(dia, '2026-13-01'); b.change(dia, '0000-09-10'); return b.inspQ().length === n && F().st.dia === ''; })());
  dia.blur();
  t('sin errores de consola', b.errors.length === 0, b.errors.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Ir al detalle y volver: filtros y scroll siguen ──');
{
  const b = await boot();
  const { w } = b;
  await w.renderInspections(); await wait(30);
  await b.tab('all');
  b.click(b.q('#insp-fmodo [data-fm="rango"]'));
  b.change(b.q('[data-if="desde"]'), '2026-09-01');
  b.change(b.q('[data-if="hasta"]'), '2026-09-15');
  b.change(b.q('#insp-fcarro'), 'v-2'); await wait(40);
  const antesIds = b.ids().join(',');
  const main = b.q('#app-main');
  main.scrollTop = 480;
  const nQ = b.inspQ().length;
  const destino = b.cards()[5].querySelector('[data-insp-open]');
  b.click(destino); await wait(40);
  t('se abre el detalle', b.q('#insp-v-detalle').classList.contains('on') && !b.q('#insp-v-cola').classList.contains('on') && /Volver a la cola/.test(txt(b.q('#insp-v-detalle'))));
  t('al abrir el detalle se sube (el detalle arranca arriba)', main.scrollTop === 0, String(main.scrollTop));
  b.click(b.q('#insp-v-detalle [data-insp-back]')); await wait(40);
  t('de vuelta en la cola', b.q('#insp-v-cola').classList.contains('on'));
  t('los filtros siguen (modo, fechas, carro)', b.q('#insp-fmodo [data-fm="rango"]').classList.contains('on') && b.q('[data-if="desde"]').value === '2026-09-01' && b.q('[data-if="hasta"]').value === '2026-09-15' && b.q('#insp-fcarro').value === 'v-2');
  t('la lista es la misma, sin volver a pedirla', b.ids().join(',') === antesIds && b.inspQ().length === nQ, (b.inspQ().length - nQ) + ' consultas');
  t('y el scroll de #app-main vuelve al mismo lugar (480)', main.scrollTop === 480, String(main.scrollTop));
  t('la pestaña «Todas» sigue marcada', b.q('#insp-filter [data-f="all"]').classList.contains('on'));
  // Aprobar desde el detalle con filtros puestos.
  b.change(b.q('#insp-fcarro'), ''); b.click(b.q('#insp-fmodo [data-fm="dia"]'));
  b.change(b.q('[data-if="dia"]'), '2026-09-10'); await wait(40);
  await b.tab('pending');
  const pendAntes = Number(txt(b.q('#insp-count')));
  t('10-sep en «Pendientes»: solo la de la noche', b.ids().join(',') === 'i-noche', b.ids().join(','));
  main.scrollTop = 120;
  b.click(b.q('[data-insp-open="i-noche"]')); await wait(40);
  b.click(b.q('#insp-approve-btn')); await wait(40);
  t('aprobada desde el detalle: vuelve a la cola filtrada', b.q('#insp-v-cola').classList.contains('on') && b.toasts.includes('Inspección aprobada.') && b.q('[data-if="dia"]').value === '2026-09-10');
  t('ya no está en «Pendientes» y lo dice apuntando a «Todas»', b.cards().length === 0 && /Hay 4 en otras pestañas/.test(txt(b.q('#insp-list'))), txt(b.q('#insp-list')));
  t('el encabezado (cola entera) baja en 1', Number(txt(b.q('#insp-count'))) === pendAntes - 1, txt(b.q('#insp-count')) + ' vs ' + pendAntes);
  t('la copia filtrada y la de la cola quedaron aprobadas', w.__inspState.fItems.find(i => i.id === 'i-noche').review_status === 'approved' && w.__inspState.items.find(i => i.id === 'i-noche').review_status === 'approved');
  t('scroll de vuelta a donde estaba (120)', main.scrollTop === 120, String(main.scrollTop));
  // Salir de la pestaña y volver a entrar: los filtros siguen y se vuelve a pedir.
  const nQ2 = b.inspQ().length;
  await w.renderInspections(); await wait(40);
  t('al volver a entrar a la pestaña: filtros intactos y se vuelve a pedir lo filtrado', b.q('[data-if="dia"]').value === '2026-09-10' && b.inspQ().length === nQ2 + 2 && contador(b) === '0 inspecciones', (b.inspQ().length - nQ2) + ' · ' + contador(b));
  t('sin errores de consola', b.errors.length === 0, b.errors.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── «Autos» con la barra de filtros ──');
{
  const b = await boot();
  const { w } = b;
  await w.renderInspections(); await wait(30);
  await b.tab('autos');
  t('«Autos» sin carro: pide elegirlo en «Carro» y no repite el select viejo', /Elige un carro/.test(txt(b.q('#insp-list'))) && !b.q('#insp-auto-sel') && b.q('#insp-autos-bar').classList.contains('hidden'));
  b.change(b.q('#insp-fcarro'), 'v-2'); await wait(40);
  const byV = b.log.filter(x => x.table === 'inspections' && x.ops.some(o => o[0] === 'eq' && o[1] === 'vehicle_id' && o[2] === 'v-2') && !x.ops.some(o => o[0] === 'eq' && o[1] === 'kind'));
  t('elige R02 en la barra → trae TODO el carro (una consulta, sin tope de 300)', byV.length === 1 && !byV[0].ops.some(o => o[0] === 'limit'), String(byV.length));
  t('R02 en «Autos»: 111 iniciales de Ana + la de la noche + la de cierre = 113', b.cards().length === 113 && contador(b) === '113 inspecciones', b.cards().length + ' · ' + contador(b));
  b.change(b.q('[data-if="dia"]'), '2026-09-10'); await wait(40);
  t('+ día 10-sep: la de Ana, la de la noche y la de CIERRE (solo «Autos» la trae)', b.cards().length === 3 && b.ids().includes('i-final') && b.ids().includes('i-noche') && b.cards().every(c => /Ana|Jos/.test(txt(c.querySelector('.who b')))), b.ids().join(','));
  t('cambiar la fecha no vuelve a pedir el carro', b.log.filter(x => x.table === 'inspections' && !x.ops.some(o => o[0] === 'eq' && o[1] === 'kind') && x.ops.some(o => o[0] === 'eq' && o[1] === 'vehicle_id')).length === 1);
  b.type(b.q('#insp-fq'), 'jose'); await wait(380);
  t('+ «jose»: solo la de la noche', b.ids().join(',') === 'i-noche', b.ids().join(','));
  await b.tab('all');
  t('de «Autos» a «Todas»: el carro y la fecha siguen aplicados (misma barra)', b.ids().join(',') === 'i-noche' && b.q('#insp-fcarro').value === 'v-2');
  t('sin errores de consola', b.errors.length === 0, b.errors.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── api.js: listInspectionsForReview con filtros ──');
{
  const b = await boot();
  const { w } = b;
  const r0 = await w.Api.listInspectionsForReview(null, { driverIds: [] });
  t('driverIds vacío → [] sin consultar', Array.isArray(r0) && r0.length === 0 && b.inspQ().length === 0);
  await w.Api.listInspectionsForReview('pending');
  const q = b.inspQ().at(-1);
  t('sin filtros sigue igual que antes (kind initial, orden, tope 300, estado)', q.ops.some(o => o[0] === 'limit' && o[1] === 300) && b.ops(q, 'eq', 'review_status')[0] === 'pending' && !q.ops.some(o => ['gte', 'lt', 'in'].includes(o[0])));
  const drivers = await w.Api.listInspectionDrivers();
  t('listInspectionDrivers: driver_profiles.id + nombre, todos', drivers.length === 4 && drivers[2].id === 'dp-3' && drivers[2].name === 'José Ñáñez');
  t('sin errores de consola', b.errors.length === 0, b.errors.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Si el servidor falla ──');
{
  const b = await boot();
  const { w } = b;
  await w.renderInspections(); await wait(30);
  const real = w.Api.listInspectionsForReview;
  w.Api.listInspectionsForReview = async () => { throw new Error('caída de prueba'); };
  b.change(b.q('[data-if="dia"]'), '2026-09-10'); await wait(40);
  t('con filtros y el servidor caído: lo dice (no muestra lo provisional como si fuera todo)', /No se pudieron cargar las inspecciones con estos filtros/.test(txt(b.q('#insp-list'))) && contador(b) === '', txt(b.q('#insp-list')));
  w.Api.listInspectionsForReview = real;
  await b.tab('all');
  b.change(b.q('[data-if="dia"]'), '2026-09-11'); await wait(40);
  t('se recupera al cambiar el filtro', b.cards().length === 3 && contador(b) === '3 inspecciones', b.cards().length + ' · ' + contador(b));
  t('el error quedó en consola (una vez)', b.errors.filter(e => /caída de prueba/.test(e)).length === 1, b.errors.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Respuestas que llegan tarde ──');
{
  const b = await boot();
  const { w } = b;
  await w.renderInspections(); await wait(30);
  await b.tab('all');
  b.change(b.q('[data-if="dia"]'), '2026-09-10'); await wait(40);
  const real = w.Api.listInspectionsForReview;
  // La del 11-sep tarda 150 ms; mientras, el admin vuelve al 10-sep.
  w.Api.listInspectionsForReview = async (s, f) => { const r = await real(s, f); if (f && f.desde === '2026-09-11T00:00:00-05:00') await wait(150); return r; };
  b.change(b.q('[data-if="dia"]'), '2026-09-11'); await wait(10);
  b.change(b.q('[data-if="dia"]'), '2026-09-10'); await wait(220);
  t('volver al filtro anterior mientras otra búsqueda iba en camino: no se queda en «Buscando…»', contador(b) === '4 inspecciones', contador(b));
  t('…y la respuesta atrasada (11-sep) NO pisa la lista', b.cards().length === 4 && b.ids().includes('i-noche'), b.ids().join(','));
  w.Api.listInspectionsForReview = async (s, f) => { const r = await real(s, f); if (f && f.desde === '2026-09-01T00:00:00-05:00') await wait(150); return r; };
  b.change(b.q('[data-if="dia"]'), '2026-09-01'); await wait(10);
  b.change(b.q('[data-if="dia"]'), '2026-09-02'); await wait(220);
  t('dos búsquedas seguidas: gana la última aunque la primera llegue después', b.cards().length === 3 && b.cards().every(c => /2 de sept/.test(txt(c.querySelector('.when')))), b.cards().map(c => txt(c.querySelector('.when'))).join(' | '));
  w.Api.listInspectionsForReview = real;
  t('sin errores de consola', b.errors.length === 0, b.errors.join(' | '));
}

console.log(`\n${ok} ✓ · ${bad} ✗`);
console.log('NO cubre: layout (jsdom no lo hace: cómo se acomoda la barra en el celular, el selector de fecha nativo),');
console.log('          el campo de fecha real de Chrome (aquí se imita su secuencia de change por dígito del año),');
console.log('          admin-inspecciones.css (no se carga), la base real (RLS, que PostgREST acepte estos filtros, tiempos).');
process.exit(bad ? 1 : 0);
