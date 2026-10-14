// CONDUCTOR › Perfil: «Mis horas» y su celular (11-oct-2026) — prueba jsdom.
//
// Pedidos del jefe de operación:
//   · el conductor ve sus horas del corte EN CURSO y del ANTERIOR (25→9 se paga
//     el 10; 10→24 se paga el 25) con EXACTAMENTE la cifra del Balance: misma
//     regla (el turno es del día en que arrancó), auto-cerrados y en curso no
//     cuentan; en «h y min»; y su historial «30 sep · 2:30 a. m. → 3:27 p. m. ·
//     12 h 57 min · +297 km», con «No cuenta: lo cerró el sistema»;
//   · su celular: campo en el Perfil y una ventana OBLIGATORIA al entrar si
//     profiles.phone está vacío, que no se cierra sin un número válido.
//
// Carga index.html + scheduler.js + admin-balance.js (BalanceCore, el motor del
// Balance) + driver-disponibilidad.js (avIcon) + driver-horas.js + driver-perfil.js
// + driver-celular.js, con un Api de PRUEBA para el resto del perfil y el
// api-jefe.js DE VERDAD contra un `sb` falso (anota cada consulta y cada RPC).
// Nada sale a la red. Los turnos se arman relativos a los cortes de HOY
// (BalanceCore.corteEnCurso/corteAnterior), así la prueba vale cualquier día.
//
// Comprueba:
//   · la consulta: turnos del conductor desde el inicio del corte anterior hasta
//     el fin del en curso, con huso de Bogotá, todos los estados;
//   · la tarjeta: en curso «12 h 57 min», anterior «21 h», fechas de pago, el
//     aviso del turno abierto; y que el Balance del jefe, con los MISMOS turnos y
//     el mismo corte, pinta la misma cifra;
//   · la vista «Mis horas»: los dos cortes, cada turno con la línea pedida, el
//     que cruza la medianoche cuenta en el día en que arrancó, el auto-cerrado
//     «No cuenta: lo cerró el sistema», el en curso «Cuenta cuando lo cierres»,
//     los arranques falsos no se listan; volver al perfil;
//   · «Mi kilometraje» (Recompensas) con la misma línea y los km a la derecha;
//   · sin BalanceCore o sin api-jefe.js no sale la tarjeta (ni una cifra de otra
//     cabeza); si la base falla, lo dice; el resto del perfil carga igual;
//   · celular: la fila «Mi celular» («Agrégalo» / «300 123 4567»); la ventana
//     obligatoria al entrar (solo conductor, solo vacío, nunca en la vista previa
//     local): no se cierra tocando afuera ni tiene «Cancelar»; con un número
//     inválido lo dice y NO llama a la base; con uno válido llama a
//     set_my_phone({p_phone}) y se cierra; el error de la base se muestra y deja
//     reintentar; sin la RPC (base sin 0098) guarda directo en profiles.phone ya
//     normalizado; «Cerrar sesión» llama a onLogout; desde el Perfil sí se puede
//     cancelar; y core.js la engancha al entrar a la app de conductor;
//   · Api.normalizarCelular con los mismos casos que _verify-0098.mjs.
//
// LO QUE NO CUBRE: layout (jsdom no lo hace: cómo se ve la tarjeta y la ventana
// en un teléfono de 360 px, el teclado numérico de iOS/Android con
// inputmode=tel), la base real (eso es _verify-0098.mjs; RLS de shifts para el
// conductor: p_shifts_select_own de 0016), el service worker, ni core.js
// arrancando de verdad (se mira el enganche en el código).
//
//   cd rendio-backend && node scripts/_smoke-perfil-horas-dom.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null && d !== '' ? ' → ' + d : '')); } };
const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));
const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const MON = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const addD = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const diaTxt = (ymd) => { const [, m, d] = ymd.split('-').map(Number); return `${d} ${MON[m - 1]}`; };
const bog = (ymd, hhmm) => new Date(`${ymd}T${hhmm}:00-05:00`).toISOString();

// Los cortes de HOY, con el MISMO motor (se carga una vez para armar los datos).
function cortesDeHoy() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = dom.window;
  w.eval('var $ = () => null; var state = {};');
  w.eval(read('admin-balance.js'));
  return { cur: w.BalanceCore.corteEnCurso(), prev: w.BalanceCore.corteAnterior() };
}
const { cur: CUR, prev: PREV } = cortesDeHoy();
const DP = { profile_id: 'p1', profiles: { full_name: 'Carlos Mejía', email: 'carlos@prueba.test' } };
let nId = 0;
const turno = (ini, fin, okm, ckm, o = {}) => ({ id: o.id || 's-' + (++nId), status: fin ? 'closed' : 'active', start_at: ini, end_at: fin,
  opening_km: okm, closing_km: ckm, driver_id: 'd1', driver_profiles: DP, vehicles: { internal_code: 'P-01', license_plate: 'RDO481' } });
const ahora = Date.now();
const iniCurso = Math.min(ahora - 60000, Math.max(ahora - 90 * 60000, Date.parse(`${CUR.from}T00:01:00-05:00`)));
const SHIFTS = [
  turno(bog(PREV.from, '05:00'), bog(PREV.from, '17:30'), 1000, 1250, { id: 's-A' }),                    // 12 h 30 min
  turno(bog(PREV.to, '23:30'), bog(CUR.from, '08:00'), 1250, 1400, { id: 's-B' }),                       // 8 h 30 min, cruza al corte siguiente
  turno(bog(addD(PREV.from, 1), '05:00'), bog(addD(PREV.from, 2), '04:00'), 1400, null, { id: 's-C' }),  // auto-cerrado 23 h
  turno(bog(CUR.from, '02:30'), bog(CUR.from, '15:27'), 1500, 1797, { id: 's-D' }),                      // 12 h 57 min, +297 km
  turno(bog(CUR.from, '01:00'), bog(CUR.from, '01:10'), null, null, { id: 's-E' }),                      // arranque falso
  turno(new Date(iniCurso).toISOString(), null, 1800, null, { id: 's-F' }),                              // en curso
  turno(bog(addD(PREV.from, -1), '05:00'), bog(addD(PREV.from, -1), '17:00'), 900, 1000, { id: 's-G' }), // corte de antes: no se pide
];
const MIN_PREV = 750 + 510, MIN_CUR = 777;

function fakeSb(DB, log) {
  const val = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? Date.parse(v) : v);
  function from(name) {
    const q = { table: name, ops: [] };
    log.push(q);
    const b = {
      select(c) { q.ops.push(['select', c]); return b; },
      update(v) { q.ops.push(['update', v]); return b; },
      eq(c, v) { q.ops.push(['eq', c, v]); return b; },
      gte(c, v) { q.ops.push(['gte', c, v]); return b; },
      lt(c, v) { q.ops.push(['lt', c, v]); return b; },
      in(c, v) { q.ops.push(['in', c, v]); return b; },
      order(c, o) { q.ops.push(['order', c, o || {}]); return b; },
      maybeSingle() { return b; },
      then(res, rej) {
        if (DB.fallaShifts && name === 'shifts') return Promise.resolve({ data: null, error: { message: 'la red se cayó' } }).then(res, rej);
        if (name === 'profiles' && q.ops.some(o => o[0] === 'update')) { DB.updates.push(q.ops); return Promise.resolve({ data: null, error: null }).then(res, rej); }
        let rows = name === 'shifts' ? DB.shifts.slice() : [];
        for (const [op, c, v] of q.ops) {
          if (op === 'eq') rows = rows.filter(r => r[c] === v);
          else if (op === 'gte') rows = rows.filter(r => val(r[c]) >= val(v));
          else if (op === 'lt') rows = rows.filter(r => val(r[c]) < val(v));
        }
        return Promise.resolve({ data: JSON.parse(JSON.stringify(rows)), error: null }).then(res, rej);
      },
    };
    return b;
  }
  return {
    from,
    rpc: async (fn, args) => {
      log.push({ rpc: fn, args });
      if (DB.rpcModo === 'falta') return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.set_my_phone(p_phone) in the schema cache' } };
      if (DB.rpcModo === 'error') return { data: null, error: { code: '22023', message: 'El celular debe tener 10 dígitos y empezar por 3' } };
      return { data: DB.rpcDevuelve || '3001234567', error: null };
    },
    auth: { getSession: async () => ({ data: { session: { user: { id: 'p1' } } } }) },
  };
}

async function montar(o = {}) {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const errors = [], toasts = [], log = [];
  w.console.error = (...a) => { errors.push(a.map(x => (x && x.message) || String(x)).join(' ')); };
  w.addEventListener('error', (e) => { if (e.message) errors.push(e.message); });
  w.scrollTo = () => {};
  w.RENDIO_CONFIG = {};
  const DB = { shifts: JSON.parse(JSON.stringify(o.shifts || SHIFTS)), updates: [], rpcModo: o.rpcModo || 'ok', fallaShifts: !!o.fallaShifts };
  w.sb = fakeSb(DB, log);
  w.eval(read('scheduler.js'));
  w.eval(read('driver-disponibilidad.js'));
  w.eval(`
    var $ = (s) => document.querySelector(s);
    var $$ = (s) => document.querySelectorAll(s);
    var escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    var initialsOf = (n) => String(n || '').split(' ').map(x => x[0] || '').join('').slice(0, 2).toUpperCase();
    var colorOfId = () => '#888';
    var strikeLimit = () => 3;
    var strikePeriod = () => Scheduler.monthStartISO();
    var rcTheme = () => 'light'; var rcSetTheme = () => {};
    var onLogout = () => { window.__logout = (window.__logout || 0) + 1; }; var openCambiarMiClave = () => {};
    var state = ${JSON.stringify({ profile: { id: o.previewId || 'p1', role: o.role || 'driver', full_name: 'Carlos Mejía', phone: o.phone ?? '' }, driverId: 'd1', settings: {}, drivers: [{ id: 'p1', name: 'Carlos Mejía' }], admins: [] })};
  `);
  w.toast = (m) => toasts.push(m);
  w.eval('var toast = window.toast;');
  w.Api = {
    getMyDriverProfileId: async () => 'd1',
    getMyFullProfile: async () => ({ id: 'p1', full_name: 'Carlos Mejía', phone: o.phone ?? '', driver: {} }),
    listDriverStrikes: async () => [],
    listMyClosedShifts: async () => JSON.parse(JSON.stringify(SHIFTS.filter(s => s.closing_km != null).sort((a, b) => new Date(b.end_at) - new Date(a.end_at)))),
    listRewards: async () => [],
    listMyRedemptions: async () => [],
    getMyOpenShift: async () => null,
    getMyWeekSuspension: async () => null,
    listShiftsForBalance: async (desde, hasta) => JSON.parse(JSON.stringify(SHIFTS.filter(s => Date.parse(s.start_at) >= Date.parse(desde) && Date.parse(s.start_at) < Date.parse(hasta)))),
    listPublishedSchedules: async () => [],
  };
  if (!o.sinApiJefe) w.eval(read('api-jefe.js'));
  if (!o.sinBalance) w.eval(read('admin-balance.js'));
  for (const f of ['driver-horas.js', 'driver-perfil.js', 'driver-celular.js']) {
    try { w.eval(read(f)); } catch (e) { errors.push(f + ': ' + e.message); }
  }
  const q = (s) => w.document.querySelector(s);
  const qa = (s) => [...w.document.querySelectorAll(s)];
  const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  const type = (el, v) => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
  const perfil = async () => { await w.eval('renderDriverProfile()'); await wait(30); };
  return { w, DB, log, errors, toasts, q, qa, click, type, perfil, box: () => q('#driver-profile-container') };
}

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n── Cortes de hoy: en curso ${CUR.from} → ${CUR.to} (paga ${CUR.pagaEl}) · anterior ${PREV.from} → ${PREV.to} (paga ${PREV.pagaEl}) ──`);
t('los cortes son 25→9 o 10→24 y se pagan el 10 o el 25', [CUR, PREV].every(c => (/-25$/.test(c.from) && /-09$/.test(c.to) && /-10$/.test(c.pagaEl)) || (/-10$/.test(c.from) && /-24$/.test(c.to) && /-25$/.test(c.pagaEl))), JSON.stringify([CUR, PREV]));
t('el anterior termina el día antes de que arranque el en curso', addD(PREV.to, 1) === CUR.from);

console.log('\n── La tarjeta «Mis horas» ──');
{
  const b = await montar({ phone: '3001234567' });
  await b.perfil();
  const qh = b.log.find(x => x.table === 'shifts');
  const op = (k, c) => qh && qh.ops.find(o => o[0] === k && (c == null || o[1] === c));
  t('pidió los turnos del conductor (driver_id = d1)', op('eq', 'driver_id') && op('eq', 'driver_id')[2] === 'd1');
  t(`desde el inicio del corte anterior (${PREV.from} 00:00 -05:00)`, op('gte', 'start_at') && op('gte', 'start_at')[2] === `${PREV.from}T00:00:00-05:00`, JSON.stringify(op('gte', 'start_at')));
  t(`hasta el día siguiente al fin del en curso (${addD(CUR.to, 1)} 00:00 -05:00, exclusivo)`, op('lt', 'start_at') && op('lt', 'start_at')[2] === `${addD(CUR.to, 1)}T00:00:00-05:00`, JSON.stringify(op('lt', 'start_at')));
  t('todos los estados (sin filtro de status ni de closing_km) y con start/end/km', qh && !qh.ops.some(o => o[0] === 'eq' && o[1] === 'status') && !qh.ops.some(o => o[0] === 'not')
    && /start_at, end_at, opening_km, closing_km/.test(op('select')[1]), qh && JSON.stringify(qh.ops));
  const card = b.q('#pf-horas-btn');
  t('la tarjeta sale en el perfil, bajo «Mis horas»', !!card && b.qa('.rc-sechd').some(h => txt(h) === 'Mis horas'));
  t('corte en curso: «12 h 57 min»', txt(card && card.querySelector('[data-dh="cur"]')) === '12 h 57 min', txt(card && card.querySelector('[data-dh="cur"]')));
  t('corte anterior: «21 h» (12 h 30 min + 8 h 30 min; el auto-cerrado y el de antes NO)', txt(card && card.querySelector('[data-dh="prev"]')) === '21 h', txt(card && card.querySelector('[data-dh="prev"]')));
  t(`dice cuándo se paga: «Se paga el ${diaTxt(CUR.pagaEl)}» y «Pago del ${diaTxt(PREV.pagaEl)}»`, new RegExp(`Se paga el ${diaTxt(CUR.pagaEl)}`).test(txt(card)) && new RegExp(`Pago del ${diaTxt(PREV.pagaEl)}`).test(txt(card)), txt(card));
  t('rótulos con el corte: «Corte en curso · …» y «Corte anterior · …»', txt(card).includes('Corte en curso · ' + CUR.label) && txt(card).includes('Corte anterior · ' + PREV.label), txt(card));
  t('avisa del turno abierto: «Tienes un turno abierto: cuenta cuando lo cierres»', b.qa('#pf-horas-btn [data-dh="aviso"]').some(a => txt(a) === 'Tienes un turno abierto: cuenta cuando lo cierres'));
  t('ni un decimal de horas', !/\d+[.,]\d+\s*h\b/.test(txt(card)));
  t('gramática: «1 turno que cuenta» (singular)', /1 turno que cuenta(?!n)/.test(txt(card)), txt(card));

  // La MISMA cifra que el Balance del jefe, con los mismos turnos y el mismo corte.
  b.q('#balance-from').value = PREV.from; b.q('#balance-to').value = PREV.to;
  await b.w.onGenerateBalance();
  const filaJefe = [...b.q('#balance-table tbody').querySelectorAll('tr')].find(tr => /Carlos Mejía/.test(txt(tr)));
  t('el Balance del jefe para el corte anterior pinta «21 h» para Carlos (la misma cifra)', filaJefe && txt(filaJefe.children[2]) === '21 h', filaJefe && txt(filaJefe.children[2]));
  b.q('#balance-from').value = CUR.from; b.q('#balance-to').value = CUR.to;
  await b.w.onGenerateBalance();
  const filaJefe2 = [...b.q('#balance-table tbody').querySelectorAll('tr')].find(tr => /Carlos Mejía/.test(txt(tr)));
  t('…y para el corte en curso «12 h 57 min»', filaJefe2 && txt(filaJefe2.children[2]) === '12 h 57 min', filaJefe2 && txt(filaJefe2.children[2]));

  console.log('\n── La vista «Mis horas» ──');
  b.click(card); await wait(20);
  const box = b.box();
  t('abre la vista con «Mis horas» y «Volver al perfil»', /Mis horas/.test(txt(box.querySelector('h2'))) && !!b.q('#pf-back'));
  const cortes = [...box.querySelectorAll('[data-dh="corte"]')];
  t('…y en plural en el anterior: «2 turnos que cuentan»', /2 turnos que cuentan/.test(txt(cortes[1] || null)), txt(cortes[1] || null));
  t('dos cortes con sus totales: «12 h 57 min» y «21 h»', cortes.length === 2 && txt(cortes[0].querySelector('[data-dh="total"]')) === '12 h 57 min' && txt(cortes[1].querySelector('[data-dh="total"]')) === '21 h', cortes.map(c => txt(c.querySelector('[data-dh="total"]'))).join(' | '));
  const turnos = [...box.querySelectorAll('[data-dh="turno"]')];
  const lineas = turnos.map(r => ({ clase: r.getAttribute('data-clase'), linea: txt(r.querySelector('[data-dh="linea"]')), todo: txt(r) }));
  t('5 turnos listados (el arranque falso y el de antes del corte, no)', turnos.length === 5 && !lineas.some(l => l.clase === 'falso'), JSON.stringify(lineas.map(l => l.clase)));
  const D = lineas.find(l => l.clase === 'ok' && /\+297 km/.test(l.linea));
  t(`la línea pedida: «${diaTxt(CUR.from)} · 2:30 a. m. → 3:27 p. m. · 12 h 57 min · +297 km»`, D && D.linea === `${diaTxt(CUR.from)} · 2:30 a. m. → 3:27 p. m. · 12 h 57 min · +297 km`, D && D.linea);
  const Bl = lineas.find(l => /11:30 p\. m\./.test(l.linea));
  t(`el que cruza la medianoche: «${diaTxt(PREV.to)} · 11:30 p. m. → ${diaTxt(CUR.from)} 8:00 a. m. · 8 h 30 min · +150 km», en el corte ANTERIOR`,
    Bl && Bl.linea === `${diaTxt(PREV.to)} · 11:30 p. m. → ${diaTxt(CUR.from)} 8:00 a. m. · 8 h 30 min · +150 km` && cortes[1].parentNode.contains(turnos.find(r => /11:30 p\. m\./.test(txt(r)))) && [...turnos].indexOf(turnos.find(r => /11:30 p\. m\./.test(txt(r)))) >= 2, Bl && Bl.linea);
  const C = lineas.find(l => l.clase === 'auto');
  t('el auto-cerrado: «No cuenta: lo cerró el sistema», sin duración ni km', C && /No cuenta: lo cerró el sistema/.test(C.todo) && !/ h \d+ min|\d+ h ·|\+\d+ km/.test(C.linea), C && C.todo);
  const F = lineas.find(l => l.clase === 'curso');
  t('el en curso: «→ en curso» y «Cuenta cuando lo cierres»', F && /→ en curso$/.test(F.linea) && /Cuenta cuando lo cierres/.test(F.todo), F && F.todo);
  t('el carro aparece bajo cada turno (P-01)', lineas.filter(l => /P-01/.test(l.todo)).length === 5);
  t('en el corte anterior avisa «1 turno no cuenta: lo cerró el sistema»', /1 turno no cuenta: lo cerró el sistema/.test(txt(box)), txt(box).slice(0, 300));
  t('explica la regla (desde que inicias hasta que cierras; el día en que arrancó)', /desde que inicias el turno hasta que lo cierras/.test(txt(box)) && /el día en que arrancó/.test(txt(box)));
  b.click(b.q('#pf-back')); await wait(10);
  t('«Volver al perfil» regresa a la principal', !!b.q('#pf-horas-btn') && b.w.state.profileView === 'main');

  console.log('\n── «Mi kilometraje» (Recompensas) ──');
  b.click(b.q('#pf-rewards-btn')); await wait(10);
  const hist = [...b.box().querySelectorAll('.border-b.border-slate-100')].map(r => ({
    linea: txt(r.querySelector('p.text-sm')), km: txt(r.querySelector('span.text-emerald-600')), todo: txt(r) }));
  const h0 = hist.find(h => /\+297 km/.test(h.km));
  t(`el historial dice «${diaTxt(CUR.from)} · 2:30 a. m. → 3:27 p. m. · 12 h 57 min» y «+297 km» a la derecha`, h0 && h0.linea === `${diaTxt(CUR.from)} · 2:30 a. m. → 3:27 p. m. · 12 h 57 min` && h0.km === '+297 km', JSON.stringify(hist));
  t('…sin repetir los km en la línea («+297 km» una sola vez)', h0 && h0.todo.split('+297 km').length === 2, h0 && h0.todo);
  t('el que cruzó la medianoche también: «… → ' + diaTxt(CUR.from) + ' 8:00 a. m. · 8 h 30 min»', hist.some(h => h.linea === `${diaTxt(PREV.to)} · 11:30 p. m. → ${diaTxt(CUR.from)} 8:00 a. m. · 8 h 30 min`), JSON.stringify(hist.map(h => h.linea)));
  t('sin errores de consola', b.errors.length === 0, b.errors.join(' | '));
}

console.log('\n── Sin motor, sin API, la base falla ──');
{
  const b1 = await montar({ sinBalance: true, phone: '3001234567' });
  await b1.perfil();
  t('sin BalanceCore: no hay tarjeta (ni una cifra de otra cabeza) y el perfil carga', !b1.q('#pf-horas-btn') && !/Mis horas/.test(txt(b1.box())) && /Recompensas por kilómetro/.test(txt(b1.box())));
  t('…y no consultó turnos para las horas', !b1.log.some(x => x.table === 'shifts'));
  const b2 = await montar({ sinApiJefe: true, phone: '3001234567' });
  await b2.perfil();
  t('sin api-jefe.js: no hay tarjeta y el perfil carga', !b2.q('#pf-horas-btn') && /Recompensas por kilómetro/.test(txt(b2.box())));
  const b3 = await montar({ fallaShifts: true, phone: '3001234567' });
  await b3.perfil();
  t('la base falla: «No pudimos cargar tus horas ahora» y el resto del perfil sigue', /No pudimos cargar tus horas ahora/.test(txt(b3.box())) && /Recompensas por kilómetro/.test(txt(b3.box())) && !b3.q('#pf-horas-btn'));
}

console.log('\n── Celular: la fila del Perfil ──');
{
  const b = await montar({ phone: '' });
  await b.perfil();
  const fila = b.q('#pf-phone');
  t('fila «Mi celular» con «Agrégalo» cuando está vacío', !!fila && txt(fila.querySelector('.lbl')) === 'Mi celular' && txt(fila.querySelector('.val')) === 'Agrégalo');
  b.click(fila); await wait(10);
  const ov = b.q('#drv-tel-modal');
  t('tocarla abre la ventana NO obligatoria: con «Cancelar»', !!ov && !!ov.querySelector('[data-drv-tel="cancelar"]') && !ov.querySelector('[data-drv-tel="salir"]') && txt(ov.querySelector('.modal-title')) === 'Mi celular');
  b.click(ov); await wait(10);
  t('…y se cierra tocando afuera, sin guardar', !b.q('#drv-tel-modal') && !b.log.some(x => x.rpc));
  b.click(b.q('#pf-phone')); await wait(10);
  b.type(b.q('#drv-tel-input'), '320 999 8877');
  b.DB.rpcDevuelve = '3209998877';
  b.click(b.q('[data-drv-tel="guardar"]')); await wait(30);
  t('guardar llama a set_my_phone con lo escrito y cierra', b.log.some(x => x.rpc === 'set_my_phone' && x.args.p_phone === '320 999 8877') && !b.q('#drv-tel-modal'), JSON.stringify(b.log.filter(x => x.rpc)));
  t('la fila queda «320 999 8877» y state.profile.phone normalizado', txt(b.q('#pf-phone .val')) === '320 999 8877' && b.w.state.profile.phone === '3209998877', txt(b.q('#pf-phone .val')));
  t('toast «Celular guardado.»', b.toasts.includes('Celular guardado.'));
  const b2 = await montar({ phone: '3001234567' });
  await b2.perfil();
  t('con número: la fila dice «300 123 4567»', txt(b2.q('#pf-phone .val')) === '300 123 4567');
}

console.log('\n── Celular: la ventana obligatoria al entrar ──');
{
  const b = await montar({ phone: '' });
  const p = b.w.drvTelPedirSiFalta();
  await wait(10);
  const ov = b.q('#drv-tel-modal');
  t('conductor sin celular: se abre la ventana', !!ov && !!p && typeof p.then === 'function');
  t('el texto pedido: «Escribe tu celular para que los tripulantes te puedan llamar»', /Escribe tu celular para que los tripulantes te puedan llamar/.test(txt(ov)));
  t('sin «Cancelar»: solo «Cerrar sesión» y «Guardar»', !ov.querySelector('[data-drv-tel="cancelar"]') && !!ov.querySelector('[data-drv-tel="salir"]') && !!ov.querySelector('[data-drv-tel="guardar"]'));
  t('encima de todo (z-index 4000) y como diálogo modal', ov.style.zIndex === '4000' && ov.getAttribute('aria-modal') === 'true');
  t('el campo es type=tel con inputmode=tel', b.q('#drv-tel-input').type === 'tel' && b.q('#drv-tel-input').getAttribute('inputmode') === 'tel');
  b.click(ov); await wait(10);
  b.w.document.dispatchEvent(new b.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(10);
  t('tocar afuera o Escape NO la cierran', !!b.q('#drv-tel-modal'));
  const guardar = () => b.click(b.q('[data-drv-tel="guardar"]'));
  const err = () => txt(b.q('[data-drv-tel="err"]'));
  guardar(); await wait(10);
  t('vacío + Guardar: «El celular debe tener 10 dígitos y empezar por 3.» y sigue abierta', err() === 'El celular debe tener 10 dígitos y empezar por 3.' && !!b.q('#drv-tel-modal'));
  for (const malo of ['2001234567', '300 123 45', '300abc4567', '+1 3001234567']) {
    b.type(b.q('#drv-tel-input'), malo); guardar(); await wait(10);
    t(`«${malo}» no pasa y no llama a la base`, /10 dígitos/.test(err()) && !!b.q('#drv-tel-modal') && !b.log.some(x => x.rpc));
  }
  b.type(b.q('#drv-tel-input'), '3'); await wait(5);
  t('al volver a escribir se borra el error', err() === '');
  // Error de la base: se muestra y deja reintentar.
  b.DB.rpcModo = 'error';
  b.type(b.q('#drv-tel-input'), '300 123 4567'); guardar(); await wait(30);
  t('si la base lo rechaza, muestra su mensaje y sigue abierta con el botón activo', /10 dígitos y empezar por 3/.test(err()) && !!b.q('#drv-tel-modal') && !b.q('[data-drv-tel="guardar"]').disabled);
  b.DB.rpcModo = 'ok'; b.DB.rpcDevuelve = '3001234567';
  b.type(b.q('#drv-tel-input'), '+57 300 123 4567');
  b.q('#drv-tel-input').dispatchEvent(new b.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await wait(30);
  const r = b.log.filter(x => x.rpc === 'set_my_phone').pop();
  t('Enter guarda: set_my_phone({ p_phone: "+57 300 123 4567" })', r && JSON.stringify(r.args) === '{"p_phone":"+57 300 123 4567"}', r && JSON.stringify(r.args));
  t('se cierra y resuelve con el número guardado', !b.q('#drv-tel-modal') && (await p) === '3001234567' && b.w.state.profile.phone === '3001234567');
  t('solo dos llamadas a la base en todo esto (la rechazada y la buena)', b.log.filter(x => x.rpc).length === 2);

  const b2 = await montar({ phone: '' });
  b2.w.drvTelPedirSiFalta(); await wait(10);
  b2.click(b2.q('[data-drv-tel="salir"]')); await wait(10);
  t('«Cerrar sesión» llama a onLogout', b2.w.__logout === 1);

  const b3 = await montar({ phone: '', rpcModo: 'falta' });
  const p3 = b3.w.drvTelPedirSiFalta(); await wait(10);
  b3.type(b3.q('#drv-tel-input'), '310-555-1234');
  b3.click(b3.q('[data-drv-tel="guardar"]')); await wait(30);
  const up = b3.DB.updates[0];
  t('base sin 0098 (la RPC no existe): guarda directo profiles.phone = "3105551234" en la fila propia', up && JSON.stringify(up.find(o => o[0] === 'update')[1]) === '{"phone":"3105551234"}'
    && JSON.stringify(up.find(o => o[0] === 'eq')) === '["eq","id","p1"]' && !b3.q('#drv-tel-modal') && (await p3) === '3105551234', up && JSON.stringify(up));

  for (const [nom, o] of [['con celular', { phone: '3001234567' }], ['un jefe', { phone: '', role: 'admin' }], ['la vista previa local', { phone: '', previewId: 'preview-driver' }]]) {
    const bx = await montar(o);
    const px = bx.w.drvTelPedirSiFalta(); await wait(5);
    t(`no se abre para ${nom}`, px === null && !bx.q('#drv-tel-modal'));
  }
  const core = read('core.js');
  t('core.js la engancha al entrar a la app de conductor (después de setDriverTab("home"))', /setDriverTab\('home'\);[\s\S]{0,400}drvTelPedirSiFalta\(\)/.test(core) && !/role === 'admin'[\s\S]{0,200}drvTelPedirSiFalta/.test(core));
  t('index.html carga api-jefe.js, driver-horas.js y driver-celular.js, y el SW los guarda', ['api-jefe.js', 'driver-horas.js', 'driver-celular.js'].every(f => read('index.html').includes(`<script src="${f}">`) && read('sw.js').includes(`'/${f}'`)));
}

console.log('\n── Api.normalizarCelular (= set_my_phone de 0098) ──');
{
  const b = await montar({ phone: '3001234567' });
  const N = b.w.Api.normalizarCelular;
  const buenos = [['300 123 4567', '3001234567'], ['+57 300-123-4567', '3001234567'], ['(+57) 310.555.1234', '3105551234'], ['573105551234', '3105551234'], ['  3105551234  ', '3105551234']];
  const malos = ['2001234567', '300123456', '30012345678', '+1 3001234567', '300abc4567', '', '    ', null, '+57 2001234567', '0573001234567', '300 123 4567 ext 2'];
  buenos.forEach(([i, e]) => t(`«${i}» → ${e}`, N(i) === e, N(i)));
  t(`rechaza ${malos.length} casos malos (los mismos de _verify-0098)`, malos.every(m => N(m) === null), JSON.stringify(malos.filter(m => N(m) !== null)));
  let lanzo = null;
  try { await b.w.Api.setMyPhone('123'); } catch (e) { lanzo = e.message; }
  t('setMyPhone con un número malo lanza sin tocar la base', /10 dígitos/.test(lanzo || '') && !b.log.some(x => x.rpc), lanzo);
}

console.log(`\n${ok}/${ok + bad} pasaron${bad ? ` · ${bad} FALLARON` : ''}`);
console.log('NO cubre: layout en el teléfono (tarjeta, ventana, teclado numérico), la base real (_verify-0098.mjs), ni core.js arrancando de verdad.');
process.exit(bad ? 1 : 0);
