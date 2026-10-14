// ADMIN › Reservas: el chip de estado del vuelo (0099) — prueba jsdom.
//
// Carga index.html + api.js + api-vuelos.js + vuelos-ui.js + admin-reservas.js
// con un `sb` FALSO (reservations, flight_statuses, app_settings) y comprueba:
//   · con la integración encendida, cada reserva con estado muestra su chip junto
//     al vuelo («AV9563 · 25 min tarde · 14:35», «programado 16:20», «cancelado»),
//     con texto Y tono; el estado se busca por código + día de Bogotá + sentido
//     (una salida con el mismo número no pinta la llegada);
//   · sin estado, el vuelo sale como siempre («✈ AV1111»); trabajo en tierra, nada;
//   · una sola consulta a flight_statuses, con los días de la lista;
//   · integración APAGADA: ni un chip, y ni siquiera se consulta la tabla;
//   · la tabla no existe (0099 sin aplicar): texto de siempre, sin errores;
//   · sin vuelos-ui.js cargado, Reservas sigue funcionando;
//   · RendioVuelos.chip/texto: a tiempo, aterrizó, en vuelo, despegó, antes,
//     retrasado, desviado, «prueba» (modo mock), «sin actualizar desde», unknown
//     → nada, y el HTML va escapado.
//
// LO QUE NO CUBRE: layout ni colores reales (jsdom no carga vuelos.css ni hace
// layout: cómo se ve el chip en el celular del jefe hay que mirarlo en el
// dispositivo), la base real (RLS), la Edge Function, la pantalla del conductor
// y Asignación (todavía no pintan el chip).
//
//   cd rendio-backend && node scripts/_smoke-vuelos-chip-dom.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null && d !== '' ? ' → ' + d : '')); } };
const wait = (ms = 20) => new Promise(r => setTimeout(r, ms));
const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
// «Ahora» de la prueba: 11-oct-2026, 06:00 Bogotá (se le fija también a la ventana).
const FAKE_NOW = Date.parse('2026-10-11T11:00:00Z');
const NOW = new Date(FAKE_NOW - 5 * 60e3).toISOString();   // consultado hace 5 min

// ── datos de PRUEBA ─────────────────────────────────────────────────────────
// Todo el 11-oct-2026 en Bogotá (las horas en UTC: Bogotá = UTC-5).
const resv = (id, dir, whenUtc, notes, o = {}) => ({
  id, direction: dir, pickup_address: 'El Olivar', required_arrival_at: whenUtc,
  status_h2a: dir === 'home_to_airport' ? 'requested' : null, status_a2h: dir === 'airport_to_home' ? 'scheduled' : null,
  notes, cancelled_at: null, created_at: '2026-10-01T12:00:00Z', rating: null, rating_tags: null, rated_at: null,
  is_overnight: false, is_firm: true, cancellation_reason: null, ready_confirmed_at: null, ground_ops: !!o.ground,
  auxiliar_profiles: { profiles: { id: 'p-' + id, full_name: 'Tripulante ' + id, phone: '' } },
});
const RES = [
  resv('r1', 'airport_to_home', '2026-10-11T19:10:00Z', 'Vuelo AV9563. '),
  resv('r2', 'home_to_airport', '2026-10-11T19:50:00Z', 'Vuelo LA4025. '),
  resv('r3', 'airport_to_home', '2026-10-11T22:00:00Z', 'Vuelo JA5116. '),
  resv('r4', 'airport_to_home', '2026-10-11T23:00:00Z', 'Vuelo AV1111. '),
  resv('r5', 'airport_to_home', '2026-10-11T15:00:00Z', 'Vuelo AV2222. ', { ground: true }),
  // Mismo número que r1 pero de SALIDA: el estado de la llegada no le toca.
  resv('r6', 'home_to_airport', '2026-10-11T12:00:00Z', 'Vuelo AV9563. '),
];
const fs = (code, dir, o) => Object.assign({ flight_code: code, flight_date: '2026-10-11', direction: dir, sched_at: null, estimated_at: null, actual_at: null, status: 'scheduled', delay_min: null, terminal: null, gate: null, source: 'aerodatabox', fetched_at: NOW }, o);
const FS = [
  fs('AV9563', 'airport_to_home', { status: 'in_air', sched_at: '2026-10-11T19:10:00Z', estimated_at: '2026-10-11T19:35:00Z', delay_min: 25, gate: '12' }),
  fs('LA4025', 'home_to_airport', { status: 'scheduled', sched_at: '2026-10-11T21:20:00Z' }),
  fs('JA5116', 'airport_to_home', { status: 'cancelled', sched_at: '2026-10-11T22:00:00Z' }),
];

function fakeSb(DB, log) {
  const cl = (x) => JSON.parse(JSON.stringify(x));
  const tabla = (name) => {
    if (name === 'reservations') return DB.res;
    if (name === 'flight_statuses') return DB.fsMissing ? null : DB.fs;
    if (name === 'app_settings') return [{ id: 'singleton', flight_api_enabled: DB.enabled }];
    return null;
  };
  const val = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? Date.parse(v) : v);
  function from(name) {
    const q = { table: name, ops: [] };
    log.push(q);
    let one = null;
    const b = {
      select(cols) { q.ops.push(['select', cols]); return b; },
      eq(c, v) { q.ops.push(['eq', c, v]); return b; },
      gte(c, v) { q.ops.push(['gte', c, v]); return b; },
      lte(c, v) { q.ops.push(['lte', c, v]); return b; },
      in(c, v) { q.ops.push(['in', c, v]); return b; },
      order() { return b; },
      maybeSingle() { one = true; return b; },
      then(res, rej) {
        const src = tabla(name);
        if (!src) return Promise.resolve({ data: null, error: { message: `relation "public.${name}" does not exist` } }).then(res, rej);
        let rows = src.slice();
        for (const [op, c, v] of q.ops) {
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

async function boot({ enabled = true, fsMissing = false, sinVuelosUi = false } = {}) {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const errors = [], log = [];
  w.console.error = (...a) => { errors.push(a.map(x => (x && x.message) || String(x)).join(' ')); };
  w.console.warn = () => {};
  w.addEventListener('error', (e) => errors.push(e.message));
  // listReservationsAdmin pide de ayer a +7 días desde HOY: el «hoy» de la
  // prueba se fija al 11-oct-2026 a las 06:00 Bogotá.
  w.eval(`Date.now = () => ${FAKE_NOW};`);
  w.RENDIO_CONFIG = {};
  const DB = { res: RES, fs: FS, enabled, fsMissing };
  w.sb = fakeSb(DB, log);
  try { w.eval(read('api.js')); } catch (e) { errors.push('api.js: ' + e.message); }
  try { w.eval(read('api-vuelos.js')); } catch (e) { errors.push('api-vuelos.js: ' + e.message); }
  if (!sinVuelosUi) { try { w.eval(read('vuelos-ui.js')); } catch (e) { errors.push('vuelos-ui.js: ' + e.message); } }
  w.toast = () => {}; w.notify = async () => {}; w.jcOpen = () => {};
  const STUBS = `
    var state = { profile: { id: 'jefe', role: 'admin', organization_id: 'org-1' }, settings: { aux_min_lead_hours: 6 } };
    const $ = (s) => document.querySelector(s);
    const $$ = (s) => document.querySelectorAll(s);
    function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  `;
  try { w.eval(STUBS + '\n' + read('admin-reservas.js')); } catch (e) { errors.push('admin-reservas.js: ' + e.message); }
  const q = (s) => w.document.querySelector(s);
  const row = (id) => q(`[data-rv-row="${id}"]`);
  const sub = (id) => txt(row(id) && row(id).querySelector('.rv-sub'));
  const chipOf = (id) => row(id) && row(id).querySelector('.rvu-chip');
  return { w, DB, log, errors, q, row, sub, chipOf };
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Integración encendida ──');
{
  const b = await boot();
  await b.w.renderReservas(); await wait(40);
  t('carga y pinta sin errores', b.errors.length === 0 && !!b.row('r1'), b.errors.join(' | '));
  t('Api.listFlightStatuses / flightStatusFor / flightApiEnabled existen junto a lo de api.js',
    typeof b.w.Api.listFlightStatuses === 'function' && typeof b.w.Api.flightStatusFor === 'function' && typeof b.w.Api.flightApiEnabled === 'function' && typeof b.w.Api.listReservationsAdmin === 'function');
  const c1 = b.chipOf('r1');
  t('llegada AV9563: chip «AV9563 · 25 min tarde · 14:35» junto al vuelo', c1 && txt(c1) === '✈ AV9563 · 25 min tarde · 14:35', txt(c1));
  t('…con tono «warn» y su estado en data-rvu-status', c1 && c1.classList.contains('rvu-chip--warn') && c1.dataset.rvuStatus === 'in_air', c1 && c1.className);
  t('…dentro de la línea del vuelo, sin repetir el «✈ AV9563» viejo', /^MDE → casa · El Olivar · ✈ AV9563 · 25 min tarde · 14:35$/.test(b.sub('r1')), b.sub('r1'));
  t('…el detalle va en el title (programada, estimada, puerta, fuente)', c1 && /programada 14:10/.test(c1.title) && /estimada 14:35/.test(c1.title) && /puerta 12/.test(c1.title) && /AeroDataBox/.test(c1.title), c1 && c1.title);
  const c2 = b.chipOf('r2');
  t('salida LA4025 solo con horario: «programado 16:20», tono muted', c2 && txt(c2) === '✈ LA4025 · programado 16:20' && c2.classList.contains('rvu-chip--muted'), txt(c2));
  const c3 = b.chipOf('r3');
  t('JA5116 cancelado: «cancelado», tono bad', c3 && txt(c3) === '✈ JA5116 · cancelado' && c3.classList.contains('rvu-chip--bad'), txt(c3));
  t('sin estado (AV1111): el vuelo como siempre, sin chip', !b.chipOf('r4') && /· ✈ AV1111$/.test(b.sub('r4')), b.sub('r4'));
  t('trabajo en tierra: ni vuelo ni chip', !b.chipOf('r5') && !/✈/.test(b.sub('r5')), b.sub('r5'));
  t('salida con el MISMO número de una llegada con estado: no hereda el chip', !b.chipOf('r6') && /· ✈ AV9563$/.test(b.sub('r6')), b.sub('r6'));
  const qs = b.log.filter(x => x.table === 'flight_statuses');
  const inDays = qs[0] && qs[0].ops.find(o => o[0] === 'in' && o[1] === 'flight_date');
  t('una sola consulta a flight_statuses, por los días de la lista', qs.length === 1 && inDays && JSON.stringify(inDays[2]) === '["2026-10-11"]', JSON.stringify(qs.map(x => x.ops)));
  b.w.renderReservasList();
  t('volver a pintar la lista no vuelve a consultar (caché)', b.log.filter(x => x.table === 'flight_statuses').length === 1);
  const one = await b.w.Api.flightStatusFor('av-9563', '2026-10-11', 'lle');
  t('Api.flightStatusFor normaliza el código y filtra por sentido', one && one.code === 'AV9563' && one.delayMin === 25 && one.type === 'lle'
    && (await b.w.Api.flightStatusFor('AV9563', '2026-10-11', 'sal')) === null, JSON.stringify(one));
  t('RendioVuelos.habilitada() = true', b.w.RendioVuelos.habilitada() === true);
}

console.log('\n── Integración apagada ──');
{
  const b = await boot({ enabled: false });
  await b.w.renderReservas(); await wait(40);
  t('ni un chip, aunque la tabla tenga datos', b.errors.length === 0 && !b.q('.rvu-chip'), b.errors.join(' | '));
  t('el vuelo sale como siempre', /· ✈ AV9563$/.test(b.sub('r1')) && /· ✈ LA4025$/.test(b.sub('r2')), b.sub('r1'));
  t('y no se consulta flight_statuses', b.log.filter(x => x.table === 'flight_statuses').length === 0);
  t('RendioVuelos.habilitada() = false', b.w.RendioVuelos.habilitada() === false);
}

console.log('\n── 0099 sin aplicar (no existe la tabla) ──');
{
  const b = await boot({ fsMissing: true });
  await b.w.renderReservas(); await wait(40);
  t('sin chip, sin errores, el vuelo como siempre', b.errors.length === 0 && !b.q('.rvu-chip') && /· ✈ AV9563$/.test(b.sub('r1')), b.errors.join(' | ') || b.sub('r1'));
}

console.log('\n── Sin vuelos-ui.js ──');
{
  const b = await boot({ sinVuelosUi: true });
  await b.w.renderReservas(); await wait(40);
  t('Reservas sigue funcionando con el texto de siempre', b.errors.length === 0 && !!b.row('r1') && /· ✈ AV9563$/.test(b.sub('r1')), b.errors.join(' | '));
}

console.log('\n── RendioVuelos.chip / texto ──');
{
  const b = await boot();
  const V = b.w.RendioVuelos;
  const st = (o) => Object.assign({ code: 'AV9563', day: '2026-10-11', direction: 'airport_to_home', type: 'lle', status: 'scheduled', schedAt: '2026-10-11T19:10:00Z', estimatedAt: null, actualAt: null, delayMin: null, terminal: null, gate: null, source: 'aerodatabox', fetchedAt: NOW }, o);
  const cases = [
    ['a tiempo (estimada = programada)', st({ estimatedAt: '2026-10-11T19:12:00Z', delayMin: 2 }), 'AV9563 · a tiempo', 'ok'],
    ['aterrizó', st({ status: 'landed', actualAt: '2026-10-11T19:31:00Z', delayMin: 21 }), 'AV9563 · aterrizó 14:31', 'ok'],
    ['en vuelo a tiempo', st({ status: 'in_air', estimatedAt: '2026-10-11T19:12:00Z', delayMin: 2 }), 'AV9563 · en vuelo · 14:12', 'info'],
    ['40 min tarde → bad', st({ status: 'delayed', estimatedAt: '2026-10-11T19:50:00Z', delayMin: 40 }), 'AV9563 · 40 min tarde · 14:50', 'bad'],
    ['10 min antes', st({ estimatedAt: '2026-10-11T19:00:00Z', delayMin: -10 }), 'AV9563 · 10 min antes · 14:00', 'info'],
    ['retrasado sin moverse la hora', st({ status: 'delayed', estimatedAt: '2026-10-11T19:12:00Z', delayMin: 2 }), 'AV9563 · retrasado · 14:12', 'warn'],
    ['desviado', st({ status: 'diverted' }), 'AV9563 · desviado', 'bad'],
    ['salida que despegó', st({ code: 'LA4025', direction: 'home_to_airport', type: 'sal', status: 'in_air', actualAt: '2026-10-11T21:58:00Z', delayMin: 38 }), 'LA4025 · despegó 16:58', 'ok'],
    ['modo prueba lo dice', st({ estimatedAt: '2026-10-11T19:35:00Z', delayMin: 25, source: 'mock' }), 'AV9563 · 25 min tarde · 14:35 · prueba', 'warn'],
    ['dato viejo (4 h sin actualizar) lo dice', st({ estimatedAt: '2026-10-11T19:10:00Z', delayMin: 0, fetchedAt: new Date(FAKE_NOW - 4 * 3600e3).toISOString() }), null, 'ok'],
  ];
  for (const [n, s, want, tone] of cases) {
    const html = V.chip(s);
    const d = b.w.document.createElement('div'); d.innerHTML = html;
    const el = d.querySelector('.rvu-chip');
    const got = V.texto(s);
    const okText = want ? got === want : /^AV9563 · a tiempo · sin actualizar desde \d{2}:\d{2}$/.test(got);
    t(`${n}: «${got}»`, el && okText && el.classList.contains('rvu-chip--' + tone) && txt(el) === '✈ ' + got, `${got} · ${el && el.className}`);
  }
  t('unknown → nada', V.chip(st({ status: 'unknown' })) === '' && V.texto(st({ status: 'unknown' })) === '');
  t('null → nada', V.chip(null) === '' && V.chip(undefined) === '');
  const evil = V.chip(st({ code: 'AV<b>1', gate: '"><img src=x>' }));
  const d = b.w.document.createElement('div'); d.innerHTML = evil;
  t('el HTML va escapado (código y title)', !d.querySelector('b') && !d.querySelector('img') && d.querySelector('.rvu-chip').title.includes('"><img'), evil);
  t('para() sin cargar ese día → null', V.para('AV9563', '2026-12-01', 'lle') === null);
}

console.log(`\n${ok} ✓ · ${bad} ✗`);
process.exit(bad ? 1 : 0);
