// ADMIN › Reservas: filtro «Todas · Salidas · Llegadas» + etiqueta en cada fila
// (25-oct-2026) — prueba jsdom.
//
// Los jefes se enredaban con las salidas y las llegadas mezcladas en la misma
// lista por hora. Carga index.html + api.js + admin-reservas.js con un `sb`
// FALSO y comprueba:
//   · arranca en «Todas» y muestra las dos (28-oct: «Todas» = las que siguen en
//     pie; la cancelada solo sale en «Canceladas», Camilo);
//   · «Salidas» deja solo casa → JMC y «Llegadas» solo JMC → casa (incluida la
//     de tierra y la de reserva en hotel, que también son salida o llegada);
//   · los números se cruzan con el estado y el día (cada fila de filtros cuenta
//     con lo elegido en las otras dos) y el total de la cabecera cuadra;
//   · cada fila lleva su etiqueta «Salida» (↑) o «Llegada» (↓), también las
//     canceladas;
//   · el filtro de salida/llegada se queda puesto al cambiar de día o de estado
//     y al refrescar.
//
// LO QUE NO CUBRE: jsdom no hace layout ni carga styles.css de verdad: cómo se
// ven los colores, si la etiqueta cabe bajo la hora y cómo se desliza la fila de
// filtros en el celular hay que mirarlo en el navegador / el dispositivo. Sin
// base real (RLS) ni push.
//
//   cd rendio-backend && node scripts/_smoke-reservas-dir-dom.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null && d !== '' ? ' → ' + d : '')); } };
const wait = (ms = 20) => new Promise(r => setTimeout(r, ms));
const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
// «Ahora» de la prueba: 11-oct-2026, 06:00 Bogotá.
const FAKE_NOW = Date.parse('2026-10-11T11:00:00Z');

// ── datos de PRUEBA ─────────────────────────────────────────────────────────
const resv = (id, dir, whenUtc, o = {}) => ({
  id, direction: dir, pickup_address: 'El Olivar', required_arrival_at: whenUtc,
  status_h2a: dir === 'home_to_airport' ? (o.st || 'requested') : null,
  status_a2h: dir === 'airport_to_home' ? (o.st || 'requested') : null,
  notes: o.ground || o.hotel ? '' : 'Vuelo AV9563. ', cancelled_at: o.cancel ? '2026-10-10T12:00:00Z' : null,
  created_at: '2026-10-01T12:00:00Z', rating: null, rating_tags: null, rated_at: null,
  is_overnight: false, is_firm: true, cancellation_reason: null, ready_confirmed_at: null,
  ground_ops: !!o.ground, reserve_place: o.hotel || null,
  auxiliar_profiles: { profiles: { id: 'p-' + id, full_name: 'Tripulante ' + id, phone: '' } },
});
// 11-oct (hoy): 3 salidas (1 cancelada, 1 con conductor) y 3 llegadas (1 de tierra).
// 12-oct (mañana): 1 salida de reserva en hotel y 1 llegada con conductor.
const RES = [
  resv('s1', 'home_to_airport', '2026-10-11T13:00:00Z'),
  resv('s2', 'home_to_airport', '2026-10-11T15:00:00Z', { st: 'assigned' }),
  resv('s3', 'home_to_airport', '2026-10-11T17:00:00Z', { cancel: true }),
  resv('l1', 'airport_to_home', '2026-10-11T14:00:00Z'),
  resv('l2', 'airport_to_home', '2026-10-11T16:00:00Z', { ground: true }),
  resv('l3', 'airport_to_home', '2026-10-11T18:00:00Z'),
  resv('s4', 'home_to_airport', '2026-10-12T13:00:00Z', { hotel: 'rio_verde' }),
  resv('l4', 'airport_to_home', '2026-10-12T14:00:00Z', { st: 'assigned' }),
];

function fakeSb(DB) {
  const cl = (x) => JSON.parse(JSON.stringify(x));
  const val = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? Date.parse(v) : v);
  function from(name) {
    const ops = [];
    let one = null;
    const b = {
      select() { return b; },
      eq(c, v) { ops.push(['eq', c, v]); return b; },
      gte(c, v) { ops.push(['gte', c, v]); return b; },
      lte(c, v) { ops.push(['lte', c, v]); return b; },
      in(c, v) { ops.push(['in', c, v]); return b; },
      order() { return b; },
      maybeSingle() { one = true; return b; },
      then(res, rej) {
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

async function boot() {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const errors = [];
  w.console.error = (...a) => { errors.push(a.map(x => (x && x.message) || String(x)).join(' ')); };
  w.console.warn = () => {};
  w.addEventListener('error', (e) => errors.push(e.message));
  w.eval(`Date.now = () => ${FAKE_NOW};`);
  w.RENDIO_CONFIG = {};
  w.sb = fakeSb({ res: RES });
  try { w.eval(read('api.js')); } catch (e) { errors.push('api.js: ' + e.message); }
  w.toast = () => {}; w.notify = async () => {}; w.jcOpen = () => {};
  const STUBS = `
    var state = { profile: { id: 'jefe', role: 'admin', organization_id: 'org-1' }, settings: { aux_min_lead_hours: 6 } };
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
  return { w, errors, q, qa, ids, n, click };
}

const b = await boot();
await b.w.renderReservas(); await wait(40);

console.log('\n── El filtro existe y arranca en «Todas» ──');
{
  const bar = b.q('#rv-ui .rv-dirbar');
  t('hay una fila «Filtrar por salidas o llegadas» con 3 botones', bar && b.qa('#rv-ui [data-rv-dir]').length === 3);
  t('es la PRIMERA fila de filtros', bar && bar.parentElement.firstElementChild === bar);
  t('los botones dicen Todas · Salidas · Llegadas', b.qa('#rv-ui [data-rv-dir]').map(x => txt(x).replace(/\s*\d+$/, '')).join(' · ') === 'Todas · Salidas · Llegadas',
    b.qa('#rv-ui [data-rv-dir]').map(txt).join(' | '));
  t('arranca en «Todas» (encendido)', b.q('[data-rv-dir="all"]').classList.contains('on') && !b.q('[data-rv-dir="sal"]').classList.contains('on'));
  t('se ven las 7 en pie (la cancelada no: está en Canceladas)', b.ids() === 'l1,l2,l3,l4,s1,s2,s4', b.ids());
  t('números: Todas 7 · Salidas 3 · Llegadas 4', b.n('[data-rv-dir="all"]') === 7 && b.n('[data-rv-dir="sal"]') === 3 && b.n('[data-rv-dir="lle"]') === 4,
    [b.n('[data-rv-dir="all"]'), b.n('[data-rv-dir="sal"]'), b.n('[data-rv-dir="lle"]')].join('/'));
  t('cabecera: 7', txt(b.q('#rv-count')) === '7');
  t('sin errores al cargar', b.errors.length === 0, b.errors.join(' | '));
}

console.log('\n── La etiqueta en cada fila ──');
{
  const tag = (id) => b.q(`[data-rv-row="${id}"] .rv-when .rv-dirtag`);
  t('salida: «Salida» naranja con flecha ↑', tag('s1') && tag('s1').classList.contains('sal') && txt(tag('s1')) === 'Salida' && tag('s1').querySelector('use').getAttribute('href') === '#i-up');
  t('llegada: «Llegada» verde con flecha ↓', tag('l1') && tag('l1').classList.contains('lle') && txt(tag('l1')) === 'Llegada' && tag('l1').querySelector('use').getAttribute('href') === '#i-down');
  t('la de tierra es llegada', tag('l2') && txt(tag('l2')) === 'Llegada');
  t('la de reserva en hotel es salida', tag('s4') && txt(tag('s4')) === 'Salida');
  t('las 7 filas tienen etiqueta', b.qa('#rv-list .rv-dirtag').length === 7);
  t('la etiqueta coincide con el trayecto de la línea gris', b.qa('#rv-list [data-rv-row]').every(r => {
    const s = txt(r.querySelector('.rv-sub')), e = txt(r.querySelector('.rv-dirtag'));
    return e === 'Llegada' ? /→ casa/.test(s) : /^casa →/.test(s);
  }));
}

console.log('\n── Salidas / Llegadas filtran ──');
{
  await b.click('[data-rv-dir="sal"]');
  t('«Salidas»: solo s1, s2 y s4 (s3 está cancelada)', b.ids() === 's1,s2,s4', b.ids());
  t('«Salidas» queda encendido y «Todas» apagado', b.q('[data-rv-dir="sal"]').classList.contains('on') && !b.q('[data-rv-dir="all"]').classList.contains('on'));
  t('cabecera: 3', txt(b.q('#rv-count')) === '3');
  t('todas las filas dicen «Salida»', b.qa('#rv-list .rv-dirtag').every(e => txt(e) === 'Salida'));
  await b.click('[data-rv-dir="lle"]');
  t('«Llegadas»: solo l1–l4', b.ids() === 'l1,l2,l3,l4', b.ids());
  t('todas las filas dicen «Llegada»', b.qa('#rv-list .rv-dirtag').every(e => txt(e) === 'Llegada'));
  await b.click('[data-rv-dir="all"]');
  t('«Todas» vuelve a las 7', b.ids() === 'l1,l2,l3,l4,s1,s2,s4', b.ids());
}

console.log('\n── Los números se cruzan con estado y día ──');
{
  // Estado «Sin rutear» (pending): s1, l1, l2, l3, s4.
  await b.click('[data-rv-f="pending"]');
  t('Sin rutear + Todas: Salidas 2 · Llegadas 3', b.n('[data-rv-dir="sal"]') === 2 && b.n('[data-rv-dir="lle"]') === 3 && b.n('[data-rv-dir="all"]') === 5,
    [b.n('[data-rv-dir="all"]'), b.n('[data-rv-dir="sal"]'), b.n('[data-rv-dir="lle"]')].join('/'));
  await b.click('[data-rv-dir="sal"]');
  t('Sin rutear + Salidas: s1, s4', b.ids() === 's1,s4', b.ids());
  t('con Salidas puesto, el estado cuenta solo salidas (Todas 3 · Sin rutear 2 · Canceladas 1)',
    b.n('[data-rv-f="all"]') === 3 && b.n('[data-rv-f="pending"]') === 2 && b.n('[data-rv-f="cancelled"]') === 1,
    [b.n('[data-rv-f="all"]'), b.n('[data-rv-f="pending"]'), b.n('[data-rv-f="cancelled"]')].join('/'));
  const dias = b.qa('#rv-days [data-rv-day]');
  const dia = (d) => b.n(`#rv-days [data-rv-day="${d}"]`);
  t('con Salidas + Sin rutear, los días cuentan eso: todos 2 · hoy 1 · mañana 1', dias.length === 3 && b.n('#rv-days [data-rv-day="all"]') === 2 && dia('2026-10-11') === 1 && dia('2026-10-12') === 1,
    dias.map(txt).join(' | '));
  await b.click('#rv-days [data-rv-day="2026-10-11"]');
  t('Hoy + Salidas + Sin rutear: solo s1', b.ids() === 's1', b.ids());
  t('el filtro de salidas sigue puesto al cambiar de día', b.q('[data-rv-dir="sal"]').classList.contains('on'));
  t('con Hoy + Sin rutear, salidas/llegadas cuentan Todas 4 · Salidas 1 · Llegadas 3',
    b.n('[data-rv-dir="all"]') === 4 && b.n('[data-rv-dir="sal"]') === 1 && b.n('[data-rv-dir="lle"]') === 3,
    [b.n('[data-rv-dir="all"]'), b.n('[data-rv-dir="sal"]'), b.n('[data-rv-dir="lle"]')].join('/'));
  await b.click('[data-rv-f="cancelled"]');
  t('Hoy + Salidas + Canceladas: s3', b.ids() === 's3', b.ids());
  t('la cancelada también lleva su etiqueta «Salida»', txt(b.q('[data-rv-row="s3"] .rv-when .rv-dirtag')) === 'Salida');
  t('el filtro de salidas sigue puesto al cambiar de estado', b.q('[data-rv-dir="sal"]').classList.contains('on'));
  await b.click('[data-rv-dir="lle"]');
  t('Hoy + Llegadas + Canceladas: vacío con su mensaje', b.ids() === '' && /Sin reservas/.test(txt(b.q('#rv-list'))));
  t('y el número de Llegadas dice 0 (apagado)', b.n('[data-rv-dir="lle"]') === 0 && b.q('[data-rv-dir="lle"] .n').classList.contains('zero'));
}

console.log('\n── Refrescar no borra lo elegido ──');
{
  await b.click('[data-rv-f="all"]');
  await b.click('#rv-days [data-rv-day="all"]');
  await b.click('[data-rv-dir="lle"]');
  await b.click('#rv-refresh'); await wait(60);
  t('después de Refrescar sigue en Llegadas', b.q('[data-rv-dir="lle"]').classList.contains('on') && b.ids() === 'l1,l2,l3,l4', b.ids());
  t('sin errores en todo el recorrido', b.errors.length === 0, b.errors.join(' | '));
}

console.log(`\n${ok} ✓ · ${bad} ✗`);
process.exit(bad ? 1 : 0);
