// P12b · PAGOS del tripulante (rediseño del auxiliar, 27-sep-2026) — prueba jsdom.
//
// Carga la app real (index.html + api.js + api-aux.js + api-cobro.js + aux-rx-ui.js +
// aux-shell.js + las pantallas de Inicio, Avisos, Perfil y Pagos + auxiliar.js),
// monta los escenarios de fixtures/aux-escenarios.js (P9) y, encima, una
// mensualidad de PRUEBA por escenario (ApiCobro falso: nada sale a la red).
//
// Comprueba (AJUSTES §5 y §8, plan final §3.10, ANIMACIONES §5):
//   · sin mensualidad → «Todavía no tienes mensualidad registrada», sin franja ni
//     punto; AuxPagos.summary() null y paused() false;
//   · Cb2Pay con el marcado del diseño: hero .cb2-in --d:0 (mes real, chip, monto,
//     «Fecha límite»), anillo (tono, cifra, dashoffset), línea de tiempo (Corte ·
//     Aviso · Vence · Pausa con fechas reales), «Cómo pagar» con los métodos de la
//     base, referencia AUX-…, titular/NIT o «no está cargado», botón flotante;
//   · Este mes/Historial RECREA .cb2-body (key={view}) y el botón flotante se va;
//     Bancolombia/Nequi RECREA .cb2-acc (key={how}); historial plegable;
//   · copiar → toast .cb2-toast (mismo texto = mismo nodo; 1500 ms);
//   · franja de Inicio (RxCobroStrip) por 'home.strip' con cbBanner; punto de la
//     pestaña; summary() con la precedencia de cbBanner; paused();
//   · subir comprobante: 3 pasos (via → foto real por <input type=file accept capture>
//     con flash de 260 ms → confirmar), body recreado por paso, «Enviando…» mientras
//     dura la subida, Comprobante enviado, «Listo» → Pagos en revisión;
//   · cambio de datos con Pagos arriba: el anillo se actualiza EN SU LUGAR y la cifra
//     se recrea solo si cambia su key;
//   · la fiesta (Cb2Party) cuando una cuenta vista sin pagar aparece pagada;
//   · avisos de cobro en Notificaciones (segmento «Pagos»);
//   · sin textos prohibidos ni montos inventados; con la bandera APAGADA, nada.
//
// LO QUE NO CUBRE: jsdom no hace layout ni corre animaciones (no prueba que el
// anillo gire o se llene de verdad, el cb2In, el flash, el confeti ni cómo se ve
// en 390 px claro/nocturno); la cámara real del teléfono (se simula el archivo
// elegido), el portapapeles real, la subida real al bucket ni la base (RLS,
// reloj diario, push).
//
//   cd rendio-backend && node scripts/_smoke-rx-pagos-dom.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
const FIX = readFileSync(new URL('./fixtures/aux-escenarios.js', import.meta.url), 'utf8');
let ok = 0, bad = 0;
const rechazos = [];
process.on('unhandledRejection', (e) => { rechazos.push((e && e.stack ? e.stack.split('\n').slice(0, 2).join(' · ') : String(e))); });
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null && d !== '' ? ' → ' + d : '')); } };
const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));
const PROHIBIDOS = ['Carlos Mejía', 'Laura', 'AV9525', 'Juliana', 'Plan B', '24/7', 'en línea', 'Último cupo', 'Siempre hay cupo',
  'kit', 'Preparado', 'Esta noche te avisamos', '38 auxiliares', '$150.000', '123-456789-01', '300 555 0192', 'Rendio S.A.S.', '901.555.019-2', 'AUX-0231'];
const prohibidos = (html, sin = []) => {
  let h = html; sin.forEach(s => { h = h.split(s).join(''); });
  const txt = h.replace(/<[^>]+>/g, ' ');
  return PROHIBIDOS.filter(p => txt.includes(p));
};

// ── Fechas (Bogotá) y una mensualidad de PRUEBA con la forma de 0090 ─────────
const HOY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const addD = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const MC = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];
const MES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const fd = (iso) => { const [, m, d] = iso.split('-').map(Number); return d + ' de ' + MC[m - 1]; };
const ml = (iso) => { const [y, m] = iso.split('-').map(Number); return MES[m - 1] + ' ' + y; };
const MONTO = 185000, MONTO_TXT = '$185.000';
const METODOS = [
  { id: 'mt-1', kind: 'bank', label: 'Bancolombia', accountType: 'Ahorros', number: '111-222333-44', holderName: null, holderNit: null },
  { id: 'mt-2', kind: 'nequi', label: 'Nequi', accountType: null, number: '310 000 0000', holderName: null, holderNit: null },
];
// dia = índice de HOY relativo al corte (día 0).
function cuenta(o = {}) {
  const dia = o.dia ?? 3, due = o.due ?? 5, notice = o.notice ?? 2, grace = o.grace ?? 3;
  const hoy = o.hoy || HOY;                 // «hoy» de la base (para simular el día siguiente)
  const start = o.start || addD(hoy, -dia);
  const dueDate = addD(start, due), blockDate = addD(start, due + grace + 1);
  const paid = !!o.paid, blocked = !!o.blocked;
  const base = paid ? 'pagado' : blocked ? 'bloqueado' : dia > due ? 'vencido' : dia === due ? 'venceHoy' : (notice > 0 && dia >= due - notice) ? 'porVencer' : 'pendiente';
  const comp = paid ? 'approved' : (o.comp || 'none');
  const conProof = comp !== 'none' && !o.manual;
  const cur = {
    id: o.id || 'st-1', periodStart: start, periodEnd: addD(start, 30), nextCut: addD(start, 31),
    amountCOP: MONTO, discountCOP: 0, discountNote: null, amountDueCOP: MONTO,
    dueDays: due, noticeDays: notice, graceDays: grace, dueDate, noticeDate: notice > 0 ? addD(dueDate, -notice) : null,
    lastGraceDate: addD(blockDate, -1), blockDate, today: hoy, base, comp, adminStatus: comp === 'review' ? 'review' : base,
    paid, paidOn: paid ? hoy : null, paidVia: paid ? (o.manual ? 'manual' : 'proof') : null, paidViaLabel: paid ? 'Bancolombia' : null,
    wasBlocked: !!o.wasBlocked, review: comp === 'review', reviewOn: conProof ? hoy : null,
    rejected: comp === 'rejected' ? (o.reason || 'El monto no coincide') : null, blocked, blockedOn: blocked ? blockDate : null,
    daysToDue: due - dia, daysToBlock: due + grace + 1 - dia,
    lastProof: conProof ? { id: 'pf-1', status: comp === 'approved' ? 'approved' : comp, viaLabel: 'Bancolombia', submittedOn: hoy, path: 'x/y.jpg', contentType: 'image/jpeg' } : null,
    idx: { today: dia, due, notice: notice > 0 ? due - notice : null, blockDay: due + grace + 1, paidDay: paid ? dia : null, reviewDay: conProof ? dia : null, blockedSince: blocked ? due + grace + 1 : null },
  };
  return {
    auxiliarProfileId: 'aux-1', organizationId: 'org-1', organizationName: 'Operación de prueba', reference: 'AUX-0042',
    amountCOP: MONTO, amountNextCOP: o.next ?? null, cutDay: 1, dueDays: due, noticeDays: notice, graceDays: grace,
    holderName: o.sinTitular ? null : 'Transportes de Prueba S.A.S.', holderNit: o.sinTitular ? null : '900.000.001-1',
    nextCut: addD(start, 31), startsOn: start, paused: blocked, openCount: paid ? 0 : 1, unread: 0,
    prefs: { push: true, reminder: true }, today: hoy, current: o.sinCorte ? null : cur,
  };
}
const HIST = () => [
  { ...cuenta({ dia: 3, id: 'st-1' }).current },
  { ...cuenta({ dia: 33, paid: true, id: 'st-0' }).current, paidOn: addD(HOY, -25), daysLate: 0, approverLabel: 'Admin · Operación de prueba', paidViaLabel: 'Nequi' },
  { ...cuenta({ dia: 63, paid: true, id: 'st-9' }).current, paidOn: addD(HOY, -50), daysLate: 3, approverLabel: 'Admin · Operación de prueba', paidViaLabel: 'Bancolombia' },
];

async function boot(rx) {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const errors = [];
  w.console.error = (...a) => { errors.push(a.map(x => (x && x.message) || String(x)).join(' ')); };
  w.addEventListener('error', (e) => errors.push(e.message));
  w.RENDIO_CONFIG = {}; w.toast = () => {}; w.L = undefined;
  w.escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const red = [];
  const trampa = new Proxy(function () {}, {
    get: (_, k) => { if (k === 'then') return undefined; red.push(String(k)); return trampa; },
    apply: () => { red.push('()'); return trampa; },
  });
  w.sb = trampa;
  w.state = { settings: {} };
  w.localStorage.setItem('rendio.aux.rx', rx ? '1' : '0');
  w.localStorage.setItem('rendio.aux.onboarded', '1');
  const copiado = [];
  Object.defineProperty(w.navigator, 'clipboard', { configurable: true, value: { writeText: async (s) => { copiado.push(s); } } });
  w.URL.createObjectURL = () => 'blob:prueba';
  w.URL.revokeObjectURL = () => {};
  for (const f of ['api.js', 'api-aux.js', 'api-cobro.js', 'aux-rx-ui.js', 'aux-shell.js', 'aux-residencias.js', 'aux-privado.js', 'aux-presentacion.js',
    'aux-rx-inicio.js', 'aux-rx-viajes.js', 'aux-rx-avisos.js', 'aux-rx-perfil.js', 'aux-rx-pagos.js', 'auxiliar.js']) {
    try { w.eval(read(f)); } catch (e) { errors.push(f + ': ' + e.message); }
  }
  try { w.AuxPresentacion && w.AuxPresentacion.markOnboarded && w.AuxPresentacion.markOnboarded(); } catch (_) { /* */ }
  const PG = w.AuxPagos ? { summary: w.AuxPagos.summary, paused: w.AuxPagos.paused } : null;
  w.eval(FIX);
  const E = w.AuxEscenarios, A = w.Auxiliar, AS = w.AuxShell;
  const d = E.montar('historial');
  red.length = 0;
  await A.init(d.profile).catch((e) => errors.push('init: ' + e.message));
  await wait(40);
  const ui = () => w.document.getElementById('auxiliar-ui');
  const q = (s) => ui().querySelector(s);
  const qa = (s) => [...ui().querySelectorAll(s)];
  const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  const cobro = { calls: [], acc: null, methods: METODOS, alerts: [], hist: [], up: null };
  // Monta un escenario y, encima, la mensualidad de prueba (ApiCobro falso).
  const montar = async (nombre, o = {}) => {
    E.montar(nombre);
    if (PG) { w.AuxPagos.summary = PG.summary; w.AuxPagos.paused = PG.paused; }
    Object.assign(cobro, { acc: null, methods: METODOS, alerts: [], hist: [], up: null }, o);
    const C = w.ApiCobro;
    const cl = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
    C.myAccount = async () => { cobro.calls.push('myAccount'); if (cobro.acc instanceof Error) throw cobro.acc; return cl(cobro.acc); };
    C.methods = async () => cl(cobro.methods);
    C.alerts = async () => cl(cobro.alerts);
    C.history = async () => cl(cobro.hist);
    C.uploadProof = (file, opts) => { cobro.calls.push(['uploadProof', file && file.name, opts]); return cobro.up ? cobro.up(file, opts) : Promise.resolve(null); };
    await w.AuxPagos.refresh({ force: true });
    await wait(20);
  };
  return { w, E, A, AS, errors, red, ui, q, qa, click, cobro, montar, copiado };
}
const payEl = (b) => b.q('.rx-tabview[data-scr="pay"]');
const upEl = (b) => b.q('[data-scr="upload"]');
const dotOf = (b) => { const i = b.q('.rx-tabs button[data-tab="pagos"] .rx-dot'); return i ? i.className : null; };
const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Sin mensualidad (cobro-en-blanco) ──');
{
  const b = await boot(true);
  const { w, AS } = b;
  t('AuxPagos existe con el contrato (summary, paused) y registra «pay» y «upload»',
    typeof w.AuxPagos.summary === 'function' && typeof w.AuxPagos.paused === 'function' && AS.registered('pay') && AS.registered('upload'));
  await b.montar('cobro-en-blanco', { acc: null });
  AS.setTab('pagos'); await wait(40);
  const p = payEl(b);
  t('la pestaña Pagos es la de P12b (cb2-scr + «Pagos»)', !!p && !!p.querySelector('.cb2-scr .cb2-hd-t.big') && txt(p.querySelector('.cb2-hd-t')) === 'Pagos');
  t('«Todavía no tienes mensualidad registrada» (nunca un monto inventado)', /Todavía no tienes mensualidad registrada/.test(p.textContent) && !/\$\s?\d/.test(p.textContent));
  t('sin segmentado ni botón flotante', !p.querySelector('.cb2-seg') && !p.querySelector('.cb2-fab'));
  t('summary() null y paused() false', w.AuxPagos.summary() === null && w.AuxPagos.paused() === false);
  t('sin punto en la pestaña Pagos', dotOf(b) === null);
  AS.setTab('inicio'); await wait(40);
  t('Inicio sin franja de cobro', !b.q('.rx-tabview[data-scr="home"] .rx-strip[data-tab="pagos"]'));
  t('Notificaciones sin segmento «Pagos»', !(w.AuxRxAvisos.list() || []).some(x => x.kind === 'pay'));
  // Mensualidad registrada pero sin cuenta de cobro abierta todavía.
  await b.montar('cobro-en-blanco', { acc: cuenta({ sinCorte: true }) });
  AS.setTab('pagos'); await wait(40);
  t('cuenta sin corte abierto: «Tu mensualidad: $185.000» y cuándo llega la primera', /Tu mensualidad: \$185\.000/.test(payEl(b).textContent) && /Tu primera cuenta de cobro llega el/.test(payEl(b).textContent));
  t('…y summary() sigue en null (no hay estado que contar)', w.AuxPagos.summary() === null);
  // Error de red: honesto y con Reintentar.
  await b.montar('cobro-en-blanco', { acc: new Error('sin red') });
  w.AuxPagos._state().acc = undefined;
  AS.setTab('inicio'); await wait(20); AS.setTab('pagos'); await wait(60);
  t('error al leer: «No pudimos cargar tu cuenta de cobro» + Reintentar', /No pudimos cargar tu cuenta de cobro/.test(payEl(b).textContent) && !!payEl(b).querySelector('[data-rx="pg-retry"]'));
  b.cobro.acc = cuenta({ dia: 1 });
  const n0 = b.cobro.calls.filter(x => x === 'myAccount').length;
  b.click(payEl(b).querySelector('[data-rx="pg-retry"]')); await wait(60);
  t('Reintentar vuelve a pedir la cuenta y, al llegar, la pantalla se monta nueva con sus entradas',
    b.cobro.calls.filter(x => x === 'myAccount').length === n0 + 1 && !!payEl(b).querySelector('.cb2-hero.cb2-in') && !payEl(b).querySelector('.rx-scrhost').classList.contains('rx-noanim'));
  t('sin errores de consola', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
  t('sin red (window.sb nunca se usó)', b.red.length === 0, b.red.slice(0, 6).join('.'));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Por vencer: Cb2Pay, franja, punto y summary ──');
{
  const b = await boot(true);
  const { w, AS } = b;
  const acc = cuenta({ dia: 4 });          // plazo 5, aviso 2 → porVencer, 1 día para pagar
  await b.montar('historial', { acc, hist: HIST() });
  const s = w.AuxPagos.summary();
  t('summary(): status porVencer, monto, fechas y rótulo', s && s.status === 'porVencer' && s.amountCOP === MONTO && s.dueISO === acc.current.dueDate && s.blockISO === acc.current.blockDate && s.label === 'Por vencer', JSON.stringify(s));
  t('paused() false', w.AuxPagos.paused() === false);
  // Sin que nadie lo pida: una cuenta vieja (> 60 s) se vuelve a pedir en el próximo render.
  const n0 = b.cobro.calls.filter(x => x === 'myAccount').length;
  AS.render(); await wait(30);
  t('cuenta fresca: un render NO la vuelve a pedir', b.cobro.calls.filter(x => x === 'myAccount').length === n0);
  w.AuxPagos._state().at = Date.now() - 61000;
  AS.render(); await wait(30);
  t('cuenta de hace más de 60 s: el render (summary del punto) la pide por detrás', b.cobro.calls.filter(x => x === 'myAccount').length === n0 + 1);
  AS.setTab('perfil'); await wait(40);
  const rowPay = b.q('.rx-tabview[data-scr="me"] [data-me="row-pay"]');
  t('Perfil › «Pagos y mensualidad» lee summary(): «$185.000 · por vencer»', rowPay && txt(rowPay.querySelector('.rx-row-tx > span')) === MONTO_TXT + ' · por vencer', rowPay && txt(rowPay.querySelector('.rx-row-tx > span')));
  AS.setTab('inicio'); await wait(40);
  const strip = b.q('.rx-tabview[data-scr="home"] .rx-body.home > .rx-strip[data-tab="pagos"]');
  t('franja de Inicio (RxCobroStrip): rx-strip t-warn, «Tu cobro vence en 1 día», monto · toca para pagar',
    !!strip && strip.className === 'rx-strip t-warn' && txt(strip.querySelector('b')) === 'Tu cobro vence en 1 día' && txt(strip.querySelector('span > span')) === MONTO_TXT + ' · toca para pagar', strip && strip.outerHTML.slice(0, 200));
  t('la franja lleva a Pagos (data-rx="rx-tab" data-tab="pagos") y va primero en el cuerpo', strip && strip.getAttribute('data-rx') === 'rx-tab' && strip.parentNode.firstElementChild === strip);
  t('punto de la pestaña Pagos: warn', dotOf(b) === 'rx-dot warn', dotOf(b));
  b.click(strip); await wait(60);
  const p = payEl(b);
  t('tocar la franja abre la pestaña Pagos', !!p && AS.current().id === 'pay');
  const hero = p.querySelector('.cb2-body > .cb2-hero.cb2-in');
  t('hero .cb2-in --d:0: mes real + chip «Por vencer» (cb-chip t-hotel)', hero && hero.style.getPropertyValue('--d') === '0' && hero.querySelector('.cb2-hero-m').textContent.startsWith(ml(acc.current.periodStart))
    && hero.querySelector('.cb-chip').className === 'cb-chip t-hotel' && txt(hero.querySelector('.cb-chip')) === 'Por vencer');
  t('monto de la base y «Fecha límite» real', txt(hero.querySelector('.cb2-hero-a')) === MONTO_TXT && txt(hero.querySelector('.cb2-hero-d')) === 'Fecha límite ' + fd(acc.current.dueDate), txt(hero.querySelector('.cb2-hero-d')));
  const ring = hero.querySelector('.cb2-ring');
  const C = 2 * Math.PI * 46;
  t('anillo t-warn con «1» y «día para pagar»; dashoffset = C·(1 − 1/5)', ring.className === 'cb2-ring t-warn' && txt(ring.querySelector('b')) === '1' && txt(ring.querySelector('.cb2-ring-c span')) === 'día para pagar'
    && Math.abs(parseFloat(ring.querySelector('circle.fg').style.strokeDashoffset) - C * 0.8) < 0.01 && Math.abs(parseFloat(ring.querySelector('circle.fg').style.strokeDasharray) - C) < 0.01, ring.outerHTML.slice(0, 300));
  const nodes = [...p.querySelectorAll('.cb2-tl .cb2-tl-n')];
  t('línea de tiempo: Corte · Aviso · Vence · Pausa con fechas reales', nodes.map(n => n.querySelector('b').textContent).join('|') === 'Corte|Aviso|Vence|Pausa'
    && nodes.map(n => n.querySelector('span').textContent).join('|') === [acc.current.periodStart, acc.current.noticeDate, acc.current.dueDate, acc.current.blockDate].map(fd).join('|'));
  t('posiciones d/blockDay: 0 %, 33.3 %, 55.5 %, 100 %; «Hoy» en 4/9', nodes.map(n => Math.round(parseFloat(n.style.left))).join(',') === '0,33,56,100' && Math.round(parseFloat(p.querySelector('.cb2-tl-now').style.left)) === 44);
  t('pasados: Corte y Aviso (.past); Pausa lleva .end', nodes.map(n => n.classList.contains('past') ? 1 : 0).join('') === '1100' && nodes[3].classList.contains('end'));
  const lbls = [...p.querySelectorAll('.cb2-body > .cb2-lbl')];
  t('sin comprobante: no hay «Tu comprobante»; «Cómo pagar» con --d:3', lbls.map(l => l.textContent).join('|') === 'Cómo pagar' && lbls[0].style.getPropertyValue('--d') === '3');
  const how = p.querySelector('[data-pg="how"].cb2-card');
  t('Cómo pagar: segmentado de los 2 métodos de la base; cuenta del primero', !!how.querySelector('.cb2-seg.in') && [...how.querySelectorAll('.cb2-seg.in button')].map(x => x.textContent).join('|') === 'Bancolombia|Nequi'
    && txt(how.querySelector('.cb2-acc > span')) === 'Bancolombia · Ahorros' && txt(how.querySelector('.cb2-acc > b')) === '111-222333-44');
  t('referencia real (AUX-0042) y titular + NIT de la base', txt(how.querySelector('.cb2-ref b')) === 'AUX-0042' && txt(how.querySelector('.cb2-set-f')) === 'A nombre de Transportes de Prueba S.A.S. · NIT 900.000.001-1');
  t('botón flotante «Ya pagué · subir comprobante» y el espacio de 76 px', txt(p.querySelector('.cb2-fab .r-btn.r-btn-primary')) === 'Ya pagué · subir comprobante' && p.querySelector('.cb2-body > div:last-child').style.height === '76px');

  console.log('   · Este mes / Historial (key={view})');
  const body0 = p.querySelector('.cb2-scr > .cb2-body');
  b.click(p.querySelector('.cb2-seg [data-v="hist"]')); await wait(20);
  const body1 = p.querySelector('.cb2-scr > .cb2-body');
  t('Historial: el cuerpo se RECREA (otro nodo, .rx-anim) y el segmentado marca .on', body1 !== body0 && body1.classList.contains('rx-anim') && p.querySelector('.cb2-seg [data-v="hist"]').className === 'on' && p.querySelector('.cb2-seg [data-v="mes"]').className === '');
  t('sin botón flotante en Historial', !p.querySelector('.cb2-fab'));
  const hs = [...body1.querySelectorAll('.cb2-hist.cb2-in')];
  t('historial de la base: 3 cuentas, --d 0·1·2', hs.length === 3 && hs.map(h => h.style.getPropertyValue('--d')).join(',') === '0,1,2');
  t('la pagada: ✓, «Pagado el …», monto y detalle Medio · Puntualidad · Aprobó', hs[1].querySelector('.cb2-row-ic.ok') && /Pagado el /.test(hs[1].textContent) && txt(hs[1].querySelector('em')) === MONTO_TXT
    && [...hs[1].querySelectorAll('.cb2-hist-x span')].map(x => x.textContent).join('|') === 'Medio|Puntualidad|Aprobó' && txt(hs[1].querySelector('.cb2-hist-x b')) === 'Nequi'
    && /Admin · Operación de prueba/.test(hs[1].textContent));
  t('tarde: «3 días tarde» con .late', hs[2].querySelector('.cb2-hist-x b.late') && txt(hs[2].querySelector('.cb2-hist-x b.late')) === '3 días tarde');
  t('la sin pagar no dice «Pagado»: «Sin pagar · vence el …»', /Sin pagar · vence el /.test(hs[0].textContent) && !hs[0].querySelector('.cb2-row-ic.ok'));
  b.click(hs[1]); await wait(10);
  t('tocar una cuenta la abre (.open) y solo esa', hs[1].classList.contains('open') && !hs[0].classList.contains('open'));
  b.click(hs[1]); await wait(10);
  t('tocarla otra vez la cierra', !hs[1].classList.contains('open'));
  b.click(p.querySelector('.cb2-seg [data-v="mes"]')); await wait(20);
  const body2 = p.querySelector('.cb2-scr > .cb2-body');
  t('Este mes: cuerpo recreado otra vez y vuelve el botón flotante', body2 !== body1 && body2.classList.contains('rx-anim') && !!p.querySelector('.cb2-fab'));

  console.log('   · Bancolombia / Nequi (key={how}) y copiar');
  const acc0 = p.querySelector('.cb2-acc');
  b.click(p.querySelector('.cb2-seg.in button[data-i="1"]')); await wait(10);
  const acc1 = p.querySelector('.cb2-acc');
  t('Nequi: .cb2-acc se RECREA (.rx-anim) con la cuenta de Nequi', acc1 !== acc0 && acc1.classList.contains('rx-anim') && txt(acc1.querySelector('span')) === 'Nequi' && txt(acc1.querySelector('b')) === '310 000 0000');
  t('el segmentado interno marca Nequi', p.querySelector('.cb2-seg.in button[data-i="1"]').className === 'on' && p.querySelector('.cb2-seg.in button[data-i="0"]').className === '');
  b.click(acc1.querySelector('button[data-rx="pg-copy"]')); await wait(10);
  const t1 = p.querySelector('.cb2-scr > .cb2-toast');
  t('Copiar → portapapeles con el número y toast «Número copiado»', b.copiado.at(-1) === '310 000 0000' && txt(t1) === 'Número copiado');
  b.click(acc1.querySelector('button[data-rx="pg-copy"]')); await wait(10);
  t('mismo texto → el MISMO nodo del toast (key={toast})', p.querySelector('.cb2-scr > .cb2-toast') === t1);
  b.click(p.querySelector('.cb2-ref button')); await wait(10);
  const t2 = p.querySelector('.cb2-scr > .cb2-toast');
  t('Referencia → «Referencia copiada», nodo nuevo, uno solo', b.copiado.at(-1) === 'AUX-0042' && txt(t2) === 'Referencia copiada' && t2 !== t1 && p.querySelectorAll('.cb2-toast').length === 1);
  await wait(1560);
  t('el toast se va a los 1500 ms', !p.querySelector('.cb2-toast'));

  console.log('   · datos que cambian con Pagos arriba (patch en su lugar)');
  const ring0 = p.querySelector('.cb2-ring'), b0 = ring0.querySelector('b'), fg0 = ring0.querySelector('circle.fg');
  const hero0 = p.querySelector('.cb2-hero');
  b.cobro.acc = cuenta({ dia: 5, start: acc.current.periodStart, hoy: addD(HOY, 1) });   // el día siguiente: vence hoy
  await w.AuxPagos.refresh({ force: true }); await wait(20);
  const ring1 = p.querySelector('.cb2-ring');
  t('mismo anillo y mismo círculo (su transición de .9 s corre); clase t-warn', ring1 === ring0 && ring1.querySelector('circle.fg') === fg0 && ring1.className === 'cb2-ring t-warn');
  t('la cifra cambia de key («1» → «Hoy»): <b> se RECREA con .rx-anim', ring1.querySelector('b') !== b0 && ring1.querySelector('b').classList.contains('rx-anim') && txt(ring1.querySelector('b')) === 'Hoy' && txt(ring1.querySelector('.cb2-ring-c span')) === 'vence');
  t('dashoffset nuevo (C·0.96) y chip «Vence hoy»', Math.abs(parseFloat(fg0.style.strokeDashoffset) - C * 0.96) < 0.01 && txt(p.querySelector('.cb-chip')) === 'Vence hoy');
  t('pestaña sin repintar (el hero es el mismo nodo)', p.querySelector('.cb2-hero') === hero0);
  AS.setTab('inicio'); await wait(30);
  t('franja «Hoy vence tu cobro» (t-warn)', txt(b.q('.rx-strip[data-tab="pagos"] b')) === 'Hoy vence tu cobro');

  const html = payEl(b) ? payEl(b).innerHTML : '';
  AS.setTab('pagos'); await wait(40);
  const all = payEl(b).innerHTML + b.q('.rx-tabview[data-scr="pay"]').outerHTML + html;
  t('Pagos sin textos prohibidos ni cifras del diseño', prohibidos(all).length === 0, prohibidos(all).join(','));
  t('sin errores de consola', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
  t('sin red (window.sb nunca se usó)', b.red.length === 0, b.red.slice(0, 6).join('.'));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Subir comprobante (Cb2Upload) ──');
{
  const b = await boot(true);
  const { w, AS } = b;
  await b.montar('historial', { acc: cuenta({ dia: 2 }) });
  AS.setTab('pagos'); await wait(40);
  b.click(payEl(b).querySelector('.cb2-fab .r-btn')); await wait(40);
  let u = upEl(b);
  t('el botón flotante abre «upload» como capa modal', !!u && u.classList.contains('rx-layer') && u.classList.contains('modal') && AS.current().id === 'upload');
  t('cabecera: atrás, «Paso 1 de 3», «Subir comprobante», X; stepper 1/3', txt(u.querySelector('.cb2-hd-e')) === 'Paso 1 de 3' && txt(u.querySelector('.cb2-hd-t')) === 'Subir comprobante'
    && u.querySelectorAll('.cb2-hd .cb2-back').length === 2 && [...u.querySelectorAll('.r-stepper .seg')].map(s => s.classList.contains('done') ? 1 : 0).join('') === '100');
  const opts = [...u.querySelectorAll('.cb2-opt.cb2-in')];
  t('«¿Desde dónde pagaste?»: métodos de la base + Otro banco, --d 1·2·3', txt(u.querySelector('.cb2-q')) === '¿Desde dónde pagaste?' && opts.map(o => o.querySelector('b').textContent).join('|') === 'Bancolombia|Nequi|Otro banco'
    && opts.map(o => o.style.getPropertyValue('--d')).join(',') === '1,2,3');
  t('Continuar deshabilitado sin elegir', u.querySelector('.r-bottom .r-btn').disabled);
  b.click(opts[1]); await wait(10);
  t('elegir Nequi: .on (el radio anima por su transición) y Continuar se habilita', opts[1].classList.contains('on') && !opts[0].classList.contains('on') && !u.querySelector('.r-bottom .r-btn').disabled);
  const body0 = u.querySelector('.cb2-scr > .cb2-body');
  b.click(u.querySelector('.r-bottom .r-btn')); await wait(10);
  const body1 = u.querySelector('.cb2-scr > .cb2-body');
  t('paso 2: el cuerpo se RECREA (key={step}), «Paso 2 de 3», stepper 2/3', body1 !== body0 && body1.classList.contains('rx-anim') && txt(u.querySelector('.cb2-hd-e')) === 'Paso 2 de 3'
    && [...u.querySelectorAll('.r-stepper .seg')].map(s => s.classList.contains('done') ? 1 : 0).join('') === '110');
  t('«Toma la foto del comprobante», recuadro .cb2-cam .cb2-in --d:2 con 4 esquinas y obturador', txt(u.querySelector('.cb2-q')) === 'Toma la foto del comprobante' && u.querySelector('.cb2-cam').style.getPropertyValue('--d') === '2'
    && u.querySelectorAll('.cb2-cam .c').length === 4 && !!u.querySelector('.cb2-shutter-row .cb2-shutter') && txt(u.querySelector('.cb2-shutter-row .cb2-link')) === 'Galería');
  const cam = u.querySelector('input[data-pg-file="cam"]'), gal = u.querySelector('input[data-pg-file="gal"]');
  t('cámara y galería REALES: <input type=file accept="image/*,application/pdf"> (la cámara con capture)',
    cam && cam.type === 'file' && cam.getAttribute('accept') === 'image/*,application/pdf' && cam.hasAttribute('capture') && gal && gal.getAttribute('accept') === 'image/*,application/pdf' && !gal.hasAttribute('capture'));
  let abrio = null;
  cam.click = () => { abrio = 'cam'; }; gal.click = () => { abrio = 'gal'; };
  b.click(u.querySelector('.cb2-shutter')); await wait(5);
  t('el obturador abre la cámara del teléfono', abrio === 'cam');
  b.click(u.querySelector('.cb2-shutter-row .cb2-link')); await wait(5);
  t('«Galería» abre el selector de archivos', abrio === 'gal');
  t('Continuar deshabilitado sin foto', u.querySelector('.r-bottom .r-btn').disabled);
  const file = new w.File(['x'], 'pago-prueba.jpg', { type: 'image/jpeg' });
  Object.defineProperty(cam, 'files', { configurable: true, value: [file] });
  cam.dispatchEvent(new w.Event('change', { bubbles: true }));
  await wait(5);
  t('al elegir la foto: flash (.cb2-flash) sobre el recuadro', !!u.querySelector('.cb2-cam > .cb2-flash') && !u.querySelector('.cb2-cam-shot'));
  await wait(280);
  t('a los 260 ms: .cb2-cam.has con la foto (.cb2-cam-shot, img y nombre real) y sin flash', u.querySelector('.cb2-cam').classList.contains('has') && !!u.querySelector('.cb2-cam-shot img.rx-pg-img')
    && txt(u.querySelector('.cb2-cam-shot span')) === 'pago-prueba.jpg' && !u.querySelector('.cb2-flash'));
  t('«Tomar otra» en lugar del obturador; Continuar habilitado', txt(u.querySelector('.cb2-cam + .cb2-link')) === 'Tomar otra' && !u.querySelector('.cb2-shutter') && !u.querySelector('.r-bottom .r-btn').disabled);
  b.click(u.querySelector('.cb2-cam + .cb2-link')); await wait(5);
  t('«Tomar otra» vuelve al recuadro vacío', !u.querySelector('.cb2-cam').classList.contains('has') && u.querySelectorAll('.cb2-cam .c').length === 4 && u.querySelector('.r-bottom .r-btn').disabled);
  Object.defineProperty(cam, 'files', { configurable: true, value: [new w.File(['x'], 'nota.txt', { type: 'text/plain' })] });
  cam.dispatchEvent(new w.Event('change', { bubbles: true })); await wait(300);
  t('un archivo que no es foto ni PDF se rechaza (toast) y no se toma', !u.querySelector('.cb2-cam').classList.contains('has') && /foto \(JPG, PNG\) o un PDF/.test(b.q('.rx-toast') ? b.q('.rx-toast').textContent : ''));
  Object.defineProperty(gal, 'files', { configurable: true, value: [file] });
  gal.dispatchEvent(new w.Event('change', { bubbles: true })); await wait(300);
  t('desde la galería también', u.querySelector('.cb2-cam').classList.contains('has'));
  b.click(u.querySelector('.cb2-hd .cb2-back')); await wait(10);
  t('atrás: paso 1 (cuerpo recreado) con Nequi todavía elegido', txt(u.querySelector('.cb2-hd-e')) === 'Paso 1 de 3' && u.querySelector('.cb2-opt.on b').textContent === 'Nequi');
  b.click(u.querySelector('.r-bottom .r-btn')); await wait(10);
  t('adelante otra vez: la foto sigue ahí', u.querySelector('.cb2-cam').classList.contains('has'));
  b.click(u.querySelector('.r-bottom .r-btn')); await wait(10);
  t('paso 3 «Confirma los datos»: miniatura, Monto, Pagaste por, Mes', txt(u.querySelector('.cb2-q')) === 'Confirma los datos' && !!u.querySelector('.cb2-sum .cb-thumb img')
    && [...u.querySelectorAll('.cb2-kv')].map(k => txt(k)).join('|') === ['Monto' + MONTO_TXT, 'Pagaste porNequi', 'Mes' + ml(cuenta({ dia: 2 }).current.periodStart)].map(x => x.replace(/\s+/g, ' ')).join('|'),
    [...u.querySelectorAll('.cb2-kv')].map(k => txt(k)).join('|'));
  t('aviso del monto distinto → Coordinación (sin nombre)', /avísale a Coordinación/.test(u.querySelector('.cb2-hint').textContent));
  let soltar;
  b.cobro.up = () => new Promise(r => { soltar = r; });
  b.click(u.querySelector('.r-bottom .r-btn')); await wait(10);
  const sendBtn = u.querySelector('.r-bottom .r-btn');
  t('«Enviando…» con el spinner mientras dura la subida (deshabilitado, .cb2-sending)', sendBtn.disabled && sendBtn.classList.contains('cb2-sending') && !!sendBtn.querySelector('.cb2-spin') && /Enviando…/.test(sendBtn.textContent));
  const call = b.cobro.calls.find(x => Array.isArray(x) && x[0] === 'uploadProof');
  t('uploadProof(file, {statementId, viaLabel, methodId, declaredAmountCOP})', call && call[1] === 'pago-prueba.jpg' && call[2].statementId === 'st-1' && call[2].viaLabel === 'Nequi' && call[2].methodId === 'mt-2' && call[2].declaredAmountCOP === MONTO, JSON.stringify(call));
  const enRev = cuenta({ dia: 2, comp: 'review' });
  b.cobro.acc = enRev;
  soltar({ proofId: 'pf-9', statement: enRev.current });
  await wait(40);
  u = upEl(b);
  t('enviado: «Comprobante enviado» con el visto .cb2-check.info y la tarjeta', !!u.querySelector('.cb2-scr.cb2-done .cb2-check.info svg circle') && txt(u.querySelector('.cb2-done h2')) === 'Comprobante enviado'
    && /Te avisamos (por push|aquí) apenas lo revisemos/.test(u.querySelector('.cb2-done p').textContent) && txt(u.querySelector('.cb2-done-card b')) === MONTO_TXT + ' · Nequi');
  b.click(u.querySelector('[data-rx="pg-up-done"]')); await wait(60);
  const p = payEl(b);
  t('«Listo» cierra la capa y deja Pagos arriba', !upEl(b) && AS.current().id === 'pay');
  t('Pagos en revisión: chip «En revisión», anillo spin t-info, sin botón flotante', txt(p.querySelector('.cb-chip')) === 'En revisión' && p.querySelector('.cb2-ring').className === 'cb2-ring t-info spin' && !p.querySelector('.cb2-fab'));
  const trk = [...p.querySelectorAll('.cb2-trk-s')];
  t('«Tu comprobante»: Enviado ✓ · En revisión (now) · Aprobado (wait)', trk.map(s => s.className.replace('cb2-trk-s ', '')).join(',') === 'done,now,wait' && /El admin lo está revisando/.test(trk[1].textContent));
  t('la sección nueva entra animada (se recrea con .rx-anim tras el repintado)', [...p.querySelectorAll('[data-pg="trk"]')].every(x => x.classList.contains('rx-anim')));
  t('summary(): review; sin franja ni punto', w.AuxPagos.summary().status === 'review' && dotOf(b) === null);
  // Error de subida
  AS.setTab('inicio'); await wait(10);
  await b.montar('historial', { acc: cuenta({ dia: 2 }) });
  AS.setTab('pagos'); await wait(30);
  b.click(payEl(b).querySelector('.cb2-fab .r-btn')); await wait(30);
  u = upEl(b);
  t('al volver a abrir, empieza en el paso 1 y sin elegir', txt(u.querySelector('.cb2-hd-e')) === 'Paso 1 de 3' && !u.querySelector('.cb2-opt.on'));
  b.click(u.querySelector('.cb2-opt')); b.click(u.querySelector('.r-bottom .r-btn')); await wait(10);
  const cam2 = u.querySelector('input[data-pg-file="cam"]');
  Object.defineProperty(cam2, 'files', { configurable: true, value: [file] });
  cam2.dispatchEvent(new w.Event('change', { bubbles: true })); await wait(300);
  b.click(u.querySelector('.r-bottom .r-btn')); await wait(10);
  b.cobro.up = () => Promise.reject(new Error('Ya hay un comprobante en revisión'));
  b.click(u.querySelector('.r-bottom .r-btn')); await wait(30);
  t('si la subida falla: se queda en el paso 3, el botón vuelve y el mensaje del servidor sale en un toast',
    txt(u.querySelector('.cb2-q')) === 'Confirma los datos' && !u.querySelector('.r-bottom .r-btn').disabled && /Ya hay un comprobante en revisión/.test(b.q('.rx-toast').textContent));
  b.click(u.querySelector('.cb2-hd [data-rx="pg-up-close"]')); await wait(300);
  t('la X cierra la capa (pop)', !upEl(b) && AS.current().id === 'pay');
  t('sin errores de consola', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
  t('sin red (window.sb nunca se usó)', b.red.length === 0, b.red.slice(0, 6).join('.'));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Pausado, rechazado, pagado a mano y la fiesta ──');
{
  const b = await boot(true);
  const { w, AS } = b;
  const blk = cuenta({ dia: 10, blocked: true, id: 'st-b' });
  await b.montar('historial', { acc: blk });
  t('pausado: summary bloqueado + paused() true', w.AuxPagos.summary().status === 'bloqueado' && w.AuxPagos.paused() === true);
  AS.setTab('inicio'); await wait(30);
  const st = b.q('.rx-strip[data-tab="pagos"]');
  t('franja t-block «Tus reservas están pausadas» · toca para reactivar', st && st.className === 'rx-strip t-block' && txt(st.querySelector('b')) === 'Tus reservas están pausadas' && /toca para reactivar/.test(st.textContent));
  t('punto err en la pestaña', dotOf(b) === 'rx-dot err');
  AS.setTab('pagos'); await wait(30);
  let p = payEl(b);
  t('anillo t-block «Pausado» con candado y chip «Bloqueado»', p.querySelector('.cb2-ring').className === 'cb2-ring t-block' && txt(p.querySelector('.cb2-ring-c span')) === 'Pausado' && !!p.querySelector('.cb2-ring-c b use[href="#rx-Lock"]') && txt(p.querySelector('.cb-chip')) === 'Bloqueado');
  t('barra de la línea de tiempo .late', p.querySelector('.cb2-tl-bar span').className === 'late');
  // Rechazado (sin pausa)
  await b.montar('historial', { acc: cuenta({ dia: 3, comp: 'rejected', reason: 'No se lee el comprobante', id: 'st-r' }) });
  AS.setTab('inicio'); await wait(20);
  t('rechazado: franja t-error «Tu comprobante fue rechazado»; summary rejected', txt(b.q('.rx-strip[data-tab="pagos"] b')) === 'Tu comprobante fue rechazado' && w.AuxPagos.summary().status === 'rejected' && dotOf(b) === 'rx-dot err');
  AS.setTab('pagos'); await wait(30);
  p = payEl(b);
  const trk = [...p.querySelectorAll('.cb2-trk-s')];
  t('tracker: Enviado ✓ · En revisión «Rechazado» (bad, X) · Aprobado con el motivo', trk.map(s => s.className.replace('cb2-trk-s ', '')).join(',') === 'done,bad,bad' && !!trk[1].querySelector('use[href="#rx-X"]') && /No se lee el comprobante/.test(trk[2].textContent));
  t('«Subir otro comprobante» en la tarjeta y en el botón flotante', !!p.querySelector('.cb2-inline-cta[data-rx="pg-upload"]') && txt(p.querySelector('.cb2-fab .r-btn')) === 'Subir otro comprobante' && txt(p.querySelector('.cb-chip')) === 'Rechazado');
  // Pagado a mano: sin comprobante que seguir.
  await b.montar('historial', { acc: cuenta({ dia: 8, paid: true, manual: true, id: 'st-m' }) });
  AS.setTab('inicio'); await wait(20); AS.setTab('pagos'); await wait(30);
  p = payEl(b);
  t('pagado a mano: «Al día», anillo t-ok, «Pagado el …», sin «Tu comprobante» ni «Cómo pagar» ni botón', p.querySelector('.cb2-ring').className === 'cb2-ring t-ok' && txt(p.querySelector('.cb2-ring-c span')) === 'Al día'
    && /Pagado el /.test(txt(p.querySelector('.cb2-hero-d'))) && !p.querySelector('.cb2-trk') && !p.querySelector('[data-pg="how"]') && !p.querySelector('.cb2-fab') && !p.querySelector('.cb2-tl-now'));
  t('summary pagado con rótulo «<Mes> al día»; sin franja', w.AuxPagos.summary().status === 'pagado' && / al día$/.test(w.AuxPagos.summary().label) && !b.q('.rx-strip[data-tab="pagos"]'));

  console.log('   · la fiesta (Cb2Party)');
  await b.montar('historial', { acc: cuenta({ dia: 12, blocked: true, id: 'st-7' }) });
  AS.setTab('pagos'); await wait(30);
  t('sin fiesta mientras está sin pagar', !b.q('.rx-app > .cb2-party'));
  b.cobro.acc = cuenta({ dia: 12, paid: true, wasBlocked: true, id: 'st-7' });
  await w.AuxPagos.refresh({ force: true }); await wait(20);
  const party = b.q('.rx-app > .cb2-party');
  const mes = MES[Number(cuenta({ dia: 12 }).current.periodStart.split('-')[1]) - 1];
  t('la cuenta que se vio sin pagar aparece pagada → fiesta en .rx-app', !!party);
  t('confeti del cobro: 22 piezas, retraso (i%7)·70 ms, --r y --c del diseño', party && party.querySelectorAll('.cb2-confetti > i').length === 22
    && party.querySelectorAll('.cb2-confetti > i')[8].style.animationDelay === '70ms' && party.querySelectorAll('.cb2-confetti > i')[3].style.getPropertyValue('--c') === '#3B82F6');
  t('«¡<Mes> al día!», visto .cb2-check.ok y «Tus reservas ya están activas otra vez.»', party && txt(party.querySelector('h2')) === '¡' + mes + ' al día!' && !!party.querySelector('.cb2-party-c .cb2-check.ok')
    && /Tus reservas ya están activas otra vez\./.test(party.querySelector('p').textContent) && /^Gracias, Laura\./.test(party.querySelector('p').textContent));
  t('«Próximo cobro · …» real y botón «Reservar un viaje»', party && /^Próximo cobro · \d+ de /.test(txt(party.querySelector('.cb2-party-n'))) && txt(party.querySelector('.r-btn')) === 'Reservar un viaje');
  b.click(party.querySelector('.cb2-party-c h2')); await wait(10);
  t('tocar la tarjeta no la cierra (stopPropagation del diseño)', !!b.q('.rx-app > .cb2-party'));
  b.click(party.querySelector('.r-btn')); await wait(40);
  t('el botón la cierra y lleva a Inicio', !b.q('.rx-app > .cb2-party') && AS.current().id === 'home');
  await w.AuxPagos.refresh({ force: true }); await wait(20);
  t('no se repite', !b.q('.rx-app > .cb2-party'));
  t('sin textos prohibidos en la fiesta (el nombre es el del perfil real)', prohibidos(party.outerHTML, ['Laura Gómez Ruiz', 'Gracias, Laura.']).length === 0);
  t('sin errores de consola', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Honestidad y avisos ──');
{
  const b = await boot(true);
  const { w, AS } = b;
  await b.montar('historial', { acc: cuenta({ dia: 1, sinTitular: true, next: 199000 }), methods: [] });
  AS.setTab('pagos'); await wait(30);
  const p = payEl(b);
  const how = p.querySelector('[data-pg="how"].cb2-card');
  t('sin métodos cargados: lo dice (no inventa cuenta) y muestra la referencia real', /todavía no cargó las cuentas para pagar/.test(how.textContent) && !how.querySelector('.cb2-acc') && txt(how.querySelector('.cb2-ref b')) === 'AUX-0042');
  t('pendiente (día 1): chip «Pendiente», anillo t-accent «4 días para pagar»', txt(p.querySelector('.cb-chip')) === 'Pendiente' && p.querySelector('.cb2-ring').className === 'cb2-ring t-accent' && txt(p.querySelector('.cb2-ring-c b')) === '4');
  t('mensualidad nueva: «Desde <mes> tu mensualidad será $199.000.» (.cb2-hint --d:1)', /Desde \w+ tu mensualidad será \$199\.000\./.test(txt(p.querySelector('.cb2-hint[data-pg="next"]'))) && p.querySelector('.cb2-hint[data-pg="next"]').style.getPropertyValue('--d') === '1');
  AS.setTab('inicio'); await wait(20);
  t('pendiente sin rechazo: sin franja en Inicio (RxCobroStrip devuelve null)', !b.q('.rx-strip[data-tab="pagos"]'));
  await b.montar('historial', { acc: cuenta({ dia: 1, sinTitular: true }), methods: [METODOS[0]] });
  AS.setTab('pagos'); await wait(30);
  const how2 = payEl(b).querySelector('[data-pg="how"].cb2-card');
  t('un solo método: sin segmentado; sin titular: «El titular de la cuenta todavía no está cargado.»', !how2.querySelector('.cb2-seg') && txt(how2.querySelector('.cb2-set-f')) === 'El titular de la cuenta todavía no está cargado.');
  // Avisos
  const acc = cuenta({ dia: 6 });
  await b.montar('historial', { acc, alerts: [
    { id: 'al-2', statementId: 'st-1', key: 'vencido', day: HOY, dayIndex: 6, title: 'Tu cobro está vencido', body: 'Tienes hasta el …', tone: 'error', payload: {}, createdAt: '2' },
    { id: 'al-1', statementId: 'st-1', key: 'generado', day: acc.current.periodStart, dayIndex: 0, title: 'Tu cuenta de cobro está lista', body: MONTO_TXT, tone: 'neutral', payload: {}, createdAt: '1' },
    { id: 'al-0', statementId: 'otra', key: 'aprobado', day: HOY, dayIndex: 0, title: 'De otra cuenta', body: '', tone: 'ok', payload: {}, createdAt: '0' },
  ] });
  const pay = (w.AuxRxAvisos.list() || []).filter(x => x.kind === 'pay');
  t('avisos de cobro en Notificaciones: los de la cuenta vigente, el más nuevo primero', pay.map(x => x.title).join('|') === 'Tu cobro está vencido|Tu cuenta de cobro está lista', pay.map(x => x.title).join('|'));
  t('ícono de CB_ALERTS y «Hoy» / fecha', pay[0].icon === 'AlertTriangle' && pay[0].when === 'Hoy' && pay[1].icon === 'FileText' && pay[1].when === fd(acc.current.periodStart));
  AS.setTab('inicio'); await wait(20);
  b.click(b.q('[data-rx="open-notifs"]')); await wait(40);
  t('la pantalla de Notificaciones muestra el segmento «Pagos»', [...b.qa('[data-scr="notifs"] .rx-seg button')].some(x => x.textContent === 'Pagos'));
  AS.closeSheet(); AS.popAll(); await wait(20);
  const vencido = b.q('.rx-tabview[data-scr="home"] .rx-strip[data-tab="pagos"]');
  t('vencido (día 6, gracia 3): franja t-error «Tu cobro está vencido» con el monto', vencido && vencido.className === 'rx-strip t-error' && txt(vencido.querySelector('b')) === 'Tu cobro está vencido' && /\$185\.000 · toca para pagar/.test(vencido.textContent));
  t('sin errores de consola', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Bandera APAGADA ──');
{
  const b = await boot(false);
  const { w, A, AS } = b;
  t('el shell está apagado', !AS.on());
  b.E.montar('historial');
  const calls = [];
  w.ApiCobro.myAccount = async () => { calls.push(1); return cuenta(); };
  A.goTab('inicio'); await wait(40);
  await wait(40);
  t('sin pedidos a ApiCobro con la bandera apagada', calls.length === 0);
  t('AuxPagos existe (contrato) y con la bandera apagada contesta sin datos', !!w.AuxPagos && w.AuxPagos.paused() === false);
  t('no hay pestaña «pay» del rediseño en pantalla', !b.q('.rx-tabview[data-scr="pay"]') && !b.q('.rx-app'));
  const otros = b.errors.filter(e => !/ids reservados/.test(e));
  t('sin errores de consola', otros.length === 0, otros.slice(0, 4).join(' | '));
}

if (rechazos.length) {
  console.log(`\n  ⚠ ${rechazos.length} rechazo(s) sin atender:`);
  [...new Set(rechazos)].slice(0, 4).forEach(r => console.log('    ' + r));
  const mios = rechazos.filter(r => /aux-rx-pagos|AuxPagos/.test(r));
  t('ningún rechazo sin atender viene de aux-rx-pagos.js', mios.length === 0, mios[0]);
}
console.log(`\n${ok} ✓ · ${bad} ✗`);
console.log('NO cubre: layout ni animación real (jsdom): el giro y el llenado del anillo, cb2In, el flash, el confeti,');
console.log('          390 px claro/nocturno; la cámara real (se simula el archivo elegido), el portapapeles real,');
console.log('          la subida real al bucket, la base (RLS, reloj diario) ni el push real.');
process.exit(bad ? 1 : 0);
