// ADMIN › Reservas: sin «En pie» ni «Calificadas», con «Cambios» y su campana roja
// (28-oct-2026, Camilo) — prueba jsdom.
//
// «Quítame de ahí En pie y Calificadas: si están en Salidas o Llegadas es porque aún
// están en pie, si no estarán canceladas… y en vez de En pie, CAMBIOS, para ver
// cuando actualicen algo y que se ponga rojo el icono si yo no he entrado ahí».
//
// Carga index.html + api.js + admin-cambios.js + admin-reservas.js con un `sb` FALSO
// (las reservas y admin_cambios_tripulantes de 0153) y comprueba:
//   · la fila de estado es Todas · Cambios · Late · Sin rutear · Canceladas;
//   · «Todas» (y Salidas/Llegadas) no trae las canceladas;
//   · «Cambios» trae solo lo que cambió el MISMO tripulante (no Coordinación, no un
//     pedido nuevo), también la cancelada por él, lo último arriba, con qué cambió;
//   · la campana está roja (con punto) mientras haya cambios que no ha visto, de
//     traslados que no han pasado; al entrar se apaga, lo de antes queda «Nuevo», y
//     un cambio que llega después la vuelve a prender (al refrescar);
//   · sin 0153 en la base, «Cambios» no aparece y nada se rompe.
//
// NO CUBRE: cómo se ve (jsdom no hace layout: la campana roja y el punto se miran en
// las capturas), la base real (RLS, la ventana de 3 días) ni la relectura cada 90 s.
//
//   cd rendio-backend && node scripts/_smoke-reservas-cambios-dom.mjs
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

const resv = (id, dir, whenUtc, o = {}) => ({
  id, direction: dir, pickup_address: 'El Olivar', required_arrival_at: whenUtc,
  status_h2a: dir === 'home_to_airport' ? (o.st || 'requested') : null,
  status_a2h: dir === 'airport_to_home' ? (o.st || 'requested') : null,
  notes: 'Vuelo AV9563. ', cancelled_at: o.cancel ? '2026-10-10T12:00:00Z' : null,
  created_at: '2026-10-01T12:00:00Z', rating: o.rating || null, rating_tags: null, rated_at: null,
  is_overnight: false, is_firm: true, cancellation_reason: null, ready_confirmed_at: null, ground_ops: false, reserve_place: null,
  auxiliar_profiles: { profiles: { id: 'p-' + id, full_name: 'Tripulante ' + id, phone: '' } },
});
const RES = [
  resv('p1', 'home_to_airport', '2026-10-10T13:00:00Z'),            // ayer (ya pasó)
  resv('s1', 'home_to_airport', '2026-10-11T13:00:00Z'),
  resv('s2', 'home_to_airport', '2026-10-11T15:00:00Z'),
  resv('s3', 'home_to_airport', '2026-10-11T17:00:00Z', { cancel: true }),
  resv('l1', 'airport_to_home', '2026-10-11T14:00:00Z', { rating: 5 }),
  resv('l3', 'airport_to_home', '2026-10-11T18:00:00Z'),
  resv('l4', 'airport_to_home', '2026-10-12T14:00:00Z'),
];
const cam = (id, rid, kind, at, by_owner, before, after, dir) => ({ id, rid, kind, at, by_owner, before, after, dir: dir || 'sal', name: 'Tripulante ' + rid, tarde: true, cancelled: kind === 'cancelado', vuelta: null });
const CAMBIOS = [
  cam('c1', 's1', 'hora', '2026-10-10T22:00:00Z', true, { when: '2026-10-11T12:00:00Z' }, { when: '2026-10-11T13:00:00Z' }),
  cam('c2', 'l1', 'vuelo', '2026-10-11T10:30:00Z', true, { vuelo: 'AV9563', when: '2026-10-11T13:30:00Z' }, { vuelo: 'AV9570', when: '2026-10-11T14:00:00Z' }, 'lle'),
  cam('c3', 's3', 'cancelado', '2026-10-10T12:00:00Z', true, { when: '2026-10-11T17:00:00Z' }, null),
  cam('c4', 's2', 'hora', '2026-10-10T20:00:00Z', false, { when: '2026-10-11T14:00:00Z' }, { when: '2026-10-11T15:00:00Z' }),   // Coordinación: no sale
  cam('c5', 'l3', 'nuevo', '2026-10-10T23:00:00Z', true, null, { when: '2026-10-11T18:00:00Z' }, 'lle'),                         // pedido nuevo: no sale
  cam('c6', 'l4', 'lugar', '2026-10-11T10:50:00Z', true, { lugar: null }, { lugar: 'rio_verde' }, 'lle'),
  cam('c7', 'p1', 'hora', '2026-10-10T09:00:00Z', true, { when: '2026-10-10T12:30:00Z' }, { when: '2026-10-10T13:00:00Z' }),   // de un traslado que ya pasó
];

function fakeSb(DB) {
  const cl = (x) => JSON.parse(JSON.stringify(x));
  const val = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? Date.parse(v) : v);
  function from(name) {
    const ops = [];
    let one = null;
    const b = {
      select() { return b; },
      eq(c, v) { ops.push(['eq', c, v]); return b; }, gte(c, v) { ops.push(['gte', c, v]); return b; },
      lte(c, v) { ops.push(['lte', c, v]); return b; }, in(c, v) { ops.push(['in', c, v]); return b; },
      order() { return b; }, maybeSingle() { one = true; return b; },
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
  const rpcLog = [];
  return {
    rpcLog, from,
    rpc: async (fn, args) => {
      if (fn !== 'admin_cambios_tripulantes') return { data: null, error: { message: 'rpc' } };
      rpcLog.push(args);
      if (DB.sin0153) return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.admin_cambios_tripulantes' } };
      // La ventana es por la hora del traslado (como 0153); nunca más de 3 días.
      if (Date.parse(args.p_hasta) - Date.parse(args.p_desde) > 3 * 86400000) return { data: null, error: { message: 'Ventana inválida (máximo 3 días)' } };
      const enVentana = (c) => { const r = DB.res.find((x) => x.id === c.rid); const w = Date.parse(r.required_arrival_at); return w >= Date.parse(args.p_desde) && w <= Date.parse(args.p_hasta); };
      return { data: cl(DB.cambios.filter(enVentana)), error: null };
    },
    auth: { getSession: async () => ({ data: { session: null } }) },
  };
}

async function boot(DB) {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const errors = [];
  w.console.error = (...a) => { errors.push(a.map(x => (x && x.message) || String(x)).join(' ')); };
  w.console.warn = (...a) => { errors.push('warn: ' + a.map(String).join(' ')); };
  w.addEventListener('error', (e) => errors.push(e.message));
  w.eval(`Date.now = () => window.__ahora || ${FAKE_NOW};`);
  w.RENDIO_CONFIG = {};
  w.sb = fakeSb(DB);
  try { w.eval(read('api.js')); } catch (e) { errors.push('api.js: ' + e.message); }
  w.toast = () => {}; w.notify = async () => {}; w.jcOpen = () => {};
  try { w.eval(read('admin-cambios.js')); } catch (e) { errors.push('admin-cambios.js: ' + e.message); }
  const STUBS = `
    var state = { profile: { id: 'jefe', role: 'admin', organization_id: 'org-1' }, settings: { aux_min_lead_hours: 6 } };
    const $ = (s) => document.querySelector(s);
    const $$ = (s) => document.querySelectorAll(s);
    function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  `;
  try { w.eval(STUBS + '\n' + read('admin-reservas.js')); } catch (e) { errors.push('admin-reservas.js: ' + e.message); }
  const q = (s) => w.document.querySelector(s);
  const qa = (s) => [...w.document.querySelectorAll(s)];
  const orden = () => qa('#rv-list [data-rv-row]').map(r => r.dataset.rvRow).join(',');
  const ids = () => qa('#rv-list [data-rv-row]').map(r => r.dataset.rvRow).sort().join(',');
  const n = (sel) => { const b = q(sel); return b ? Number(txt(b.querySelector('.n'))) : null; };
  const click = async (sel) => { const b = q(sel); if (!b) throw new Error('no está ' + sel); b.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await wait(40); };
  return { w, errors, q, qa, ids, orden, n, click };
}

const DB = { res: RES, cambios: CAMBIOS.slice() };
const b = await boot(DB);
await b.w.renderReservas(); await wait(60);
const campana = () => b.q('#rv-fcambios');
const roja = () => campana().classList.contains('is-new') && !campana().querySelector('.rv-dot').hidden;

console.log('\n── La fila de estado ──');
{
  const labels = b.qa('#rv-ui [data-rv-f]').filter((x) => !x.hidden).map((x) => txt(x).replace(/\s*\d+$/, ''));
  t('Todas · Cambios · Late · Sin rutear · Canceladas', labels.join(' · ') === 'Todas · Cambios · Late · Sin rutear · Canceladas', labels.join(' · '));
  t('ya no hay «En pie» ni «Calificadas»', !b.q('[data-rv-f="active"]') && !b.q('[data-rv-f="rated"]') && !/En pie|Calificadas/.test(txt(b.q('#rv-ui .rv-tools'))));
  t('«Todas» no trae la cancelada (s3): está en Canceladas', b.ids() === 'l1,l3,l4,p1,s1,s2', b.ids());
  t('Salidas cuenta 3 (p1, s1, s2) y Llegadas 3', b.n('[data-rv-dir="sal"]') === 3 && b.n('[data-rv-dir="lle"]') === 3, [b.n('[data-rv-dir="sal"]'), b.n('[data-rv-dir="lle"]')].join('/'));
  t('la calificación de l1 sigue en su fila (★ 5), solo se fue el filtro', /★ 5/.test(txt(b.q('[data-rv-row="l1"]'))));
  t('la ventana de cambios se pidió en tramos de 3 días o menos que cubren la semana', DB.res && b.w.sb.rpcLog.length >= 3 && b.w.sb.rpcLog.every((a) => Date.parse(a.p_hasta) - Date.parse(a.p_desde) <= 3 * 86400000), JSON.stringify(b.w.sb.rpcLog));
}

console.log('\n── La campana ──');
{
  t('«Cambios» aparece (la base tiene 0153)', !campana().hidden);
  t('nunca entró: la campana está roja, con su punto', roja());
  t('…cuenta 4 nuevos (s1, l1, s3, l4: no el de ayer, que ya pasó)', /^4 cambios nuevos/.test(campana().title), campana().title);
  t('el número del filtro: 5 traslados con cambios (con el de ayer)', b.n('[data-rv-f="cambios"]') === 5, String(b.n('[data-rv-f="cambios"]')));
}

console.log('\n── Entrar a «Cambios» ──');
{
  await b.click('[data-rv-f="cambios"]');
  t('solo lo que cambió el tripulante: s2 (lo cambió Coordinación) y l3 (pedido nuevo) no salen', b.ids() === 'l1,l4,p1,s1,s3', b.ids());
  t('lo último que cambió va arriba: l4, l1, s1, s3, p1', b.orden() === 'l4,l1,s1,s3,p1', b.orden());
  t('la cancelada por el tripulante sí sale (cancelar es un cambio)', !!b.q('[data-rv-row="s3"]') && /Canceló su salida/.test(txt(b.q('[data-rv-row="s3"] .rv-cambios'))), txt(b.q('[data-rv-row="s3"] .rv-cambios')));
  t('cada fila dice qué cambió: «Cambió la hora de su salida: 7:00 → 8:00»', /Cambió la hora de su salida: 7:00 → 8:00/.test(txt(b.q('[data-rv-row="s1"] .rv-cambios'))), txt(b.q('[data-rv-row="s1"] .rv-cambios')));
  t('…y el vuelo de l1: «AV9563 → AV9570»', /Cambió su vuelo: AV9563 → AV9570/.test(txt(b.q('[data-rv-row="l1"] .rv-cambios'))), txt(b.q('[data-rv-row="l1"] .rv-cambios')));
  t('lo que no había visto sale «Nuevo»', b.qa('#rv-list .rv-cambios li.is-new').length === 5 && /Nuevo/.test(txt(b.q('[data-rv-row="l4"] .rv-cambios'))));
  t('al entrar, la campana se apaga', !roja());
  await b.click('[data-rv-f="all"]');
  t('volver a «Todas»: sin la lista de cambios en las filas y la campana sigue apagada', !b.q('#rv-list .rv-cambios') && !roja());
}

console.log('\n── Un cambio nuevo después ──');
{
  b.w.__ahora = FAKE_NOW + 10 * 60000;
  DB.cambios.push(cam('c8', 's2', 'hora', new Date(FAKE_NOW + 5 * 60000).toISOString(), true, { when: '2026-10-11T15:00:00Z' }, { when: '2026-10-11T15:30:00Z' }));
  await b.click('#rv-refresh'); await wait(60);
  t('al refrescar, la campana vuelve a ponerse roja: 1 cambio nuevo', roja() && /^1 cambio nuevo/.test(campana().title), campana().title);
  await b.click('[data-rv-f="cambios"]');
  t('…en «Cambios» s2 va arriba y es el único «Nuevo»', b.orden().startsWith('s2,') && b.qa('#rv-list .rv-cambios li.is-new').length === 1, b.orden());
  t('…y la campana se apaga otra vez', !roja());
  await b.click('[data-rv-dir="lle"]');
  t('Cambios + Llegadas: l4, l1', b.orden() === 'l4,l1', b.orden());
  t('sin errores en todo el recorrido', b.errors.length === 0, b.errors.join(' | '));
}

console.log('\n── Sin 0153 en la base ──');
{
  const c = await boot({ res: RES, cambios: [], sin0153: true });
  await c.w.renderReservas(); await wait(60);
  t('«Cambios» no aparece', c.q('#rv-fcambios').hidden);
  t('la lista se ve igual (Todas, sin la cancelada)', c.ids() === 'l1,l3,l4,p1,s1,s2', c.ids());
  t('sin errores', c.errors.length === 0, c.errors.join(' | '));
}

console.log(`\n${ok} ✓ · ${bad} ✗`);
process.exit(bad ? 1 : 0);
