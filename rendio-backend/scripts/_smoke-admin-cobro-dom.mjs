// P12b · ADMIN › Cuentas de cobro (Facturario 0090) — prueba jsdom.
//
// Carga index.html + api-cobro.js + admin-cobro.js, reemplaza las funciones del
// jefe de window.ApiCobro por unas de PRUEBA (nada sale a la red: window.sb es una
// trampa que anota cualquier uso) y pinta #cobro-ui con window.renderCobro().
//
// Comprueba (AJUSTES §5):
//   · lista con estado (por revisar, pausado, en mora, pendiente, al día, sin
//     cuenta, sin cuenta de cobro abierta), filtros con conteo y buscador;
//   · el reloj diario: «todavía no ha corrido» si nunca corrió (no es «todo al día»);
//   · comprobantes por revisar con la imagen del enlace firmado (o el PDF),
//     aprobar, y rechazar SOLO con un motivo de la lista fija;
//   · editar / crear la cuenta del tripulante (monto, corte, plazos que pisan los de
//     la organización), marcar pagado, ajustar (descuento), abrir cuenta de cobro,
//     historial;
//   · métodos de pago (agregar, desactivar, borrar) y valores por defecto;
//   · enlace profundo #/cobro?aux=<id> solo para el jefe;
//   · sin montos ni cuentas inventadas; sin ApiCobro o con error, lo dice.
//
// LO QUE NO CUBRE: layout (jsdom no lo hace: la ficha apilada del celular se mira
// en el teléfono), la base real (RLS, reloj diario, push), el bucket privado real
// ni la navegación completa del admin (core.setTab se simula).
//
//   cd rendio-backend && node scripts/_smoke-admin-cobro-dom.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null && d !== '' ? ' → ' + d : '')); } };
const wait = (ms = 20) => new Promise(r => setTimeout(r, ms));
const HOY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const addD = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const MC = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];
const fd = (iso) => { const [, m, d] = iso.split('-').map(Number); return d + ' de ' + MC[m - 1]; };

// ── datos de PRUEBA con la forma de admin_billing_list / proofs / detail ──────
function st(o = {}) {
  const dia = o.dia ?? 3, due = 5, grace = 3;
  const start = addD(HOY, -dia);
  const paid = !!o.paid, blocked = !!o.blocked;
  const base = paid ? 'pagado' : blocked ? 'bloqueado' : dia > due ? 'vencido' : dia === due ? 'venceHoy' : dia >= due - 2 ? 'porVencer' : 'pendiente';
  return {
    id: o.id, periodStart: start, periodEnd: addD(start, 30), nextCut: addD(start, 31), amountCOP: 170000, discountCOP: o.disc || 0, discountNote: o.discNote || null,
    amountDueCOP: 170000 - (o.disc || 0), dueDays: due, noticeDays: 2, graceDays: grace, dueDate: addD(start, due), blockDate: addD(start, due + grace + 1),
    today: HOY, base, comp: paid ? 'approved' : (o.comp || 'none'), paid, paidOn: paid ? HOY : null, paidVia: paid ? 'proof' : null, paidViaLabel: paid ? 'Nequi' : null,
    review: o.comp === 'review', rejected: o.comp === 'rejected' ? 'El monto no coincide' : null, blocked, blockedOn: blocked ? addD(start, due + grace + 1) : null,
  };
}
const cuenta = (o = {}) => ({ reference: o.ref, active: o.active !== false, amountCOP: o.amount === undefined ? 170000 : o.amount, amountNextCOP: null,
  effectiveAmountCOP: o.eff === undefined ? 170000 : o.eff, cutDay: 12, dueDays: null, noticeDays: null, graceDays: null,
  effectiveDueDays: 5, effectiveNoticeDays: 2, effectiveGraceDays: 3, startsOn: addD(HOY, -40), paused: !!o.paused, nextCut: addD(HOY, 9) });
const LISTA = () => [
  { auxiliarProfileId: 'a-rev', profileId: 'p1', name: 'Ana Prueba', email: 'ana@prueba.test', phone: '3000000001', isActive: true,
    account: cuenta({ ref: 'AUX-0101' }), current: st({ id: 's-rev', dia: 3, comp: 'review' }),
    proofInReview: { id: 'pf-1', statementId: 's-rev', path: 'org/p1/s-rev/a.jpg', contentType: 'image/jpeg', viaLabel: 'Nequi', declaredAmountCOP: 170000, submittedOn: HOY } },
  { auxiliarProfileId: 'a-blk', profileId: 'p2', name: 'Beto Prueba', email: 'beto@prueba.test', phone: null, isActive: true,
    account: cuenta({ ref: 'AUX-0102', paused: true }), current: st({ id: 's-blk', dia: 12, blocked: true }), proofInReview: null },
  { auxiliarProfileId: 'a-mora', profileId: 'p3', name: 'Caro Prueba', email: 'caro@prueba.test', phone: '3000000003', isActive: true,
    account: cuenta({ ref: 'AUX-0103' }), current: st({ id: 's-mora', dia: 7 }), proofInReview: null },
  { auxiliarProfileId: 'a-pend', profileId: 'p4', name: 'Dani Prueba', email: 'dani@prueba.test', phone: null, isActive: true,
    account: cuenta({ ref: 'AUX-0104' }), current: st({ id: 's-pend', dia: 1 }), proofInReview: null },
  { auxiliarProfileId: 'a-ok', profileId: 'p5', name: 'Eli Prueba', email: 'eli@prueba.test', phone: null, isActive: true,
    account: cuenta({ ref: 'AUX-0105' }), current: st({ id: 's-ok', dia: 4, paid: true }), proofInReview: null },
  { auxiliarProfileId: 'a-sin', profileId: 'p6', name: 'Fer Prueba', email: 'fer@prueba.test', phone: null, isActive: true,
    account: null, current: null, proofInReview: null },
  { auxiliarProfileId: 'a-corte', profileId: 'p7', name: 'Gabi Prueba', email: 'gabi@prueba.test', phone: null, isActive: true,
    account: cuenta({ ref: 'AUX-0107' }), current: null, proofInReview: null },
];
const PROOFS = () => [
  { id: 'pf-1', statementId: 's-rev', auxiliarProfileId: 'a-rev', name: 'Ana Prueba', reference: 'AUX-0101', path: 'org/p1/s-rev/a.jpg', contentType: 'image/jpeg',
    viaLabel: 'Nequi', declaredAmountCOP: 170000, status: 'review', submittedOn: HOY, statement: st({ id: 's-rev', dia: 3, comp: 'review' }) },
  { id: 'pf-2', statementId: 's-blk', auxiliarProfileId: 'a-blk', name: 'Beto Prueba', reference: 'AUX-0102', path: 'org/p2/s-blk/b.pdf', contentType: 'application/pdf',
    viaLabel: 'Otro banco', declaredAmountCOP: 150500, status: 'review', submittedOn: HOY, statement: st({ id: 's-blk', dia: 12, blocked: true }) },
];

async function boot(o = {}) {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' + (o.hash || '') });
  const w = dom.window;
  const errors = [], toasts = [], calls = [];
  w.console.error = (...a) => { errors.push(a.map(x => (x && x.message) || String(x)).join(' ')); };
  w.addEventListener('error', (e) => errors.push(e.message));
  w.RENDIO_CONFIG = {};
  w.toast = (m) => toasts.push(m);
  w.confirm = () => true;
  const red = [];
  const trampa = new Proxy(function () {}, {
    get: (_, k) => { if (k === 'then') return undefined; red.push(String(k)); return trampa; },
    apply: () => { red.push('()'); return trampa; },
  });
  w.sb = trampa;
  w.eval('var state = { profile: ' + JSON.stringify(o.profile || { id: 'jefe', role: 'admin' }) + ', activeTab: "consola" };');
  w.eval('function setTab(n) { state.activeTab = n; (window.__tabs = window.__tabs || []).push(n); if (n === "cobro" && window.renderCobro) window.renderCobro(); }');
  if (!o.sinApi) { try { w.eval(read('api-cobro.js')); } catch (e) { errors.push('api-cobro.js: ' + e.message); } }
  const C = w.ApiCobro;
  const D = { list: LISTA(), proofs: PROOFS(), lastRun: null, methods: [
    { id: 'm-1', kind: 'bank', label: 'Bancolombia', accountType: 'Ahorros', number: '111-222333-44', holderName: null, holderNit: null, position: 0, active: true }],
    settings: { exists: true, defaultAmountCOP: null, dueDays: 5, noticeDays: 2, graceDays: 3, holderName: null, holderNit: null } };
  const cl = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
  const rec = (fn, ret) => async (...a) => { calls.push([fn, ...cl(a)]); if (ret instanceof Error) throw ret; return typeof ret === 'function' ? ret(...a) : cl(ret); };
  if (C) {
    C.adminList = async () => { calls.push(['adminList']); if (D.listErr) throw new Error('0090 no está'); return cl(D.list); };
    C.adminProofs = async (s) => { calls.push(['adminProofs', s]); return cl(D.proofs); };
    C.adminLastRun = async () => cl(D.lastRun);
    C.proofUrl = async (p) => { calls.push(['proofUrl', p]); return 'https://almacen.prueba/firmado/' + p; };
    C.adminApprove = rec('adminApprove', { id: 's-rev' });
    C.adminReject = rec('adminReject', { id: 's-blk' });
    C.adminSaveAccount = rec('adminSaveAccount', {});
    C.adminMarkPaid = rec('adminMarkPaid', {});
    C.adminAdjust = rec('adminAdjust', {});
    C.adminOpenStatement = rec('adminOpenStatement', {});
    C.adminDetail = async (aux) => { calls.push(['adminDetail', aux]); return { statements: [st({ id: 's-ok', dia: 4, paid: true }), { ...st({ id: 's-old', dia: 34, paid: true }), disc: 0 }], proofs: [{ id: 'pf-0', statementId: 's-ok', status: 'approved' }], payments: [] }; };
    C.adminMethods = async () => cl(D.methods);
    C.adminSaveMethod = rec('adminSaveMethod', {});
    C.adminSetMethodActive = rec('adminSetMethodActive', undefined);
    C.adminDeleteMethod = rec('adminDeleteMethod', undefined);
    C.adminSettings = async () => cl(D.settings);
    C.adminSaveSettings = rec('adminSaveSettings', {});
  }
  try { w.eval(read('admin-cobro.js')); } catch (e) { errors.push('admin-cobro.js: ' + e.message); }
  const sec = w.document.querySelector('section[data-panel="cobro"]');
  if (sec) sec.classList.remove('hidden');
  const R = () => w.document.getElementById('cobro-ui');
  const q = (s) => R().querySelector(s);
  const qa = (s) => [...R().querySelectorAll(s)];
  const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  const type = (el, v) => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
  const row = (aux) => q(`.cb-row[data-aux="${aux}"]`);
  return { w, D, calls, toasts, errors, red, R, q, qa, click, type, row };
}
const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
const PROHIBIDOS = ['$150.000', 'Rendio S.A.S.', '901.555.019-2', '123-456789-01', '300 555 0192', 'AUX-0231', 'Laura', 'Carlos Mejía', 'Juliana'];

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Lista, reloj y filtros ──');
{
  const b = await boot();
  const { w } = b;
  t('exporta renderCobro y stopCobroTimer (la consola muestra la entrada)', typeof w.renderCobro === 'function' && typeof w.stopCobroTimer === 'function');
  w.renderCobro(); await wait(30);
  t('encabezado «Cuentas de cobro» con el conteo (7)', txt(b.q('.sh-phead h1')) === 'Cuentas de cobro 7');
  t('el reloj nunca corrió → lo dice (no es «todo al día»)', /El reloj diario todavía no ha corrido/.test(b.q('.cb-note.warn').textContent));
  const tagOf = (a) => txt(b.row(a).querySelector('.cb-st .cb-tag'));
  t('estados: Por revisar · Pausado · En mora · Pendiente · Al día · Sin cuenta · Sin cuenta de cobro abierta',
    ['a-rev', 'a-blk', 'a-mora', 'a-pend', 'a-ok', 'a-sin', 'a-corte'].map(tagOf).join('|') === 'Por revisar|Pausado|En mora|Pendiente|Al día|Sin cuenta|Sin cuenta de cobro abierta',
    ['a-rev', 'a-blk', 'a-mora', 'a-pend', 'a-ok', 'a-sin', 'a-corte'].map(tagOf).join('|'));
  const amt = (a) => { const e = b.row(a).querySelector('.cb-amt'); return txt(e.querySelector('b')) + ' | ' + txt(e.querySelector('span')); };
  t('monto de la base y la fecha real («Vence el …», «Pagó el …», «Sin mensualidad»)',
    amt('a-mora') === '$170.000 | Vence el ' + fd(st({ dia: 7 }).dueDate) && /^\$170\.000 \| Pagó el /.test(amt('a-ok')) && amt('a-sin') === '— | Sin mensualidad',
    ['a-mora', 'a-ok', 'a-sin'].map(amt).join(' // '));
  t('referencia AUX-#### de la base', /AUX-0103/.test(b.row('a-mora').querySelector('.cb-who').textContent));
  t('acciones según el estado: sin cuenta → «Crear cuenta»; pagado → sin «Marcar pagado»; sin corte → «Abrir cuenta de cobro»',
    txt(b.row('a-sin').querySelector('[data-m="edit"]')) === 'Crear cuenta' && !b.row('a-ok').querySelector('[data-m="paid"]') && !!b.row('a-corte').querySelector('[data-cb="open-st"]')
    && !!b.row('a-mora').querySelector('[data-m="paid"]') && !!b.row('a-mora').querySelector('[data-m="adjust"]'));
  const counts = b.qa('.cb-filters button').map(x => txt(x)).join('|');
  t('filtros con conteo', counts === 'Todos 7|Por revisar 1|Pausados 1|En mora 1|Pendientes 1|Al día 1|Sin cuenta 2', counts);
  b.click(b.q('.cb-filters [data-v="pausados"]')); await wait(10);
  t('filtro Pausados → solo Beto', b.qa('.cb-row').map(r => r.getAttribute('data-aux')).join(',') === 'a-blk');
  b.click(b.q('.cb-filters [data-v="todos"]')); await wait(10);
  b.type(b.q('#cb-search'), 'caro');
  t('buscador por nombre', b.qa('.cb-row').map(r => r.getAttribute('data-aux')).join(',') === 'a-mora');
  b.type(b.q('#cb-search'), 'aux-0105');
  t('…y por referencia', b.qa('.cb-row').map(r => r.getAttribute('data-aux')).join(',') === 'a-ok');
  b.type(b.q('#cb-search'), '');
  b.D.lastRun = { runOn: HOY, ranAt: HOY + 'T12:00:00Z', opened: 2, alerts: 5, paused: 1 };
  b.click(b.q('[data-cb="reload"]')); await wait(30);
  t('con el reloj al día: una línea con lo que hizo', /Reloj diario: corrió el .* · 2 cuentas abiertas, 5 avisos, 1 pausa/.test(txt(b.q('.cb-clock'))) && !b.q('.cb-note.warn'));
  b.D.lastRun = { runOn: addD(HOY, -4), opened: 0, alerts: 0, paused: 0 };
  b.click(b.q('[data-cb="reload"]')); await wait(30);
  t('reloj atrasado: «no corre desde el …»', /El reloj diario no corre desde el/.test(txt(b.q('.cb-note.warn'))));
  const all = b.R().innerHTML;
  t('sin textos inventados del diseño', PROHIBIDOS.every(p => !all.includes(p)), PROHIBIDOS.filter(p => all.includes(p)).join(','));
  w.stopCobroTimer();
  t('sin errores de consola', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
  t('sin red (window.sb nunca se usó)', b.red.length === 0, b.red.slice(0, 5).join('.'));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Comprobantes por revisar ──');
{
  const b = await boot();
  const { w } = b;
  w.renderCobro(); await wait(40);
  const cards = b.qa('.cb-proof');
  t('dos comprobantes por revisar, con el conteo', cards.length === 2 && /Comprobantes por revisar 2/.test(txt(b.q('.cb-sec h2'))));
  t('la imagen sale del enlace FIRMADO del bucket privado', cards[0].querySelector('.cb-proof-img img') && cards[0].querySelector('.cb-proof-img img').getAttribute('src') === 'https://almacen.prueba/firmado/org/p1/s-rev/a.jpg'
    && b.calls.some(c => c[0] === 'proofUrl' && c[1] === 'org/p1/s-rev/a.jpg'));
  t('un PDF se abre como enlace', !!cards[1].querySelector('.cb-proof-img a') && /Abrir el PDF/.test(cards[1].querySelector('.cb-proof-img').textContent));
  t('datos: nombre, referencia, cuenta del mes, lo que dice que pagó, por dónde', /Ana Prueba/.test(cards[0].textContent) && /AUX-0101/.test(cards[0].textContent) && /Cuenta del mes\s*\$170\.000/.test(cards[0].textContent) && /Pagó por\s*Nequi/.test(cards[0].textContent));
  t('si declaró otro monto, se marca (.bad)', !!cards[1].querySelector('.cb-kvs b.bad') && txt(cards[1].querySelector('.cb-kvs b.bad')) === '$150.500' && !cards[0].querySelector('.cb-kvs b.bad'));
  t('pausado: avisa que al aprobar se reactivan sus reservas', /al aprobar se reactivan/.test(cards[1].textContent));
  b.click(cards[0].querySelector('[data-cb="approve"]')); await wait(30);
  t('Aprobar → adminApprove(id), aviso y se recarga', b.calls.some(c => c[0] === 'adminApprove' && c[1] === 'pf-1') && b.toasts.includes('Ana Prueba quedó al día') && b.calls.filter(c => c[0] === 'adminList').length >= 2);
  const c2 = () => b.q('.cb-proof[data-proof="pf-2"]');
  b.click(c2().querySelector('[data-cb="reject"]')); await wait(10);
  const reasons = [...c2().querySelectorAll('.cb-reasons input[type=radio]')].map(x => x.value);
  t('Rechazar abre SOLO los 4 motivos de la lista (CB_REASONS)', reasons.join('|') === 'No se lee el comprobante|El monto no coincide|No es a la cuenta de Rendio|La fecha es anterior al cobro', reasons.join('|'));
  t('sin motivo, «Rechazar» está deshabilitado', c2().querySelector('[data-cb="reject-go"]').disabled);
  const r2 = c2().querySelectorAll('.cb-reasons input[type=radio]')[1];
  r2.checked = true; r2.dispatchEvent(new w.Event('change', { bubbles: true })); await wait(5);
  t('elegir un motivo lo habilita', !c2().querySelector('[data-cb="reject-go"]').disabled);
  b.click(c2().querySelector('[data-cb="reject-go"]')); await wait(30);
  t('adminReject(id, motivo de la lista)', b.calls.some(c => c[0] === 'adminReject' && c[1] === 'pf-2' && c[2] === 'El monto no coincide') && b.toasts.includes('Comprobante rechazado'));
  b.D.proofs = [];
  b.click(b.q('[data-cb="reload"]')); await wait(30);
  t('sin nada por revisar: «Nada por revisar.»', /Nada por revisar/.test(b.q('.cb-sec').textContent));
  w.stopCobroTimer();
  t('sin errores de consola', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Editar cuenta, marcar pagado, ajustar, abrir, historial ──');
{
  const b = await boot();
  const { w } = b;
  w.renderCobro(); await wait(30);
  b.click(b.row('a-mora').querySelector('[data-m="edit"]')); await wait(20);
  const f = (k) => b.row('a-mora').querySelector(`[data-cbf="${k}"]`);
  t('Editar cuenta: el formulario trae los valores de la base (170000, corte 12, plazos vacíos = los de la organización)',
    f('amountCOP').value === '170000' && f('cutDay').value === '12' && f('dueDays').value === '' && /De la organización: 5/.test(f('dueDays').getAttribute('placeholder')));
  b.type(f('amountCOP'), '175.000'); b.type(f('graceDays'), '4');
  b.click(b.row('a-mora').querySelector('[data-cb="save-acc"]')); await wait(30);
  const sa = b.calls.find(c => c[0] === 'adminSaveAccount');
  t('Guardar → adminSaveAccount(aux, {amountCOP:175000, cutDay:12, graceDays:4, dueDays:null, active:true…})',
    sa && sa[1] === 'a-mora' && sa[2].amountCOP === 175000 && sa[2].cutDay === 12 && sa[2].graceDays === 4 && sa[2].dueDays === null && sa[2].active === true, JSON.stringify(sa));
  t('se cierra el editor y aparece «Cuenta guardada»', !b.q('.cb-row.open') && b.toasts.includes('Cuenta guardada'));
  // Crear cuenta sin monto ni valor por defecto
  b.click(b.row('a-sin').querySelector('[data-m="edit"]')); await wait(30);
  b.click(b.row('a-sin').querySelector('[data-cb="save-acc"]')); await wait(20);
  t('crear sin monto y sin monto por defecto: no se guarda y lo dice', !b.calls.some(c => c[0] === 'adminSaveAccount' && c[1] === 'a-sin') && /Falta la mensualidad/.test(b.toasts.at(-1)));
  b.type(b.row('a-sin').querySelector('[data-cbf="amountCOP"]'), '160000');
  b.type(b.row('a-sin').querySelector('[data-cbf="cutDay"]'), '40');
  b.click(b.row('a-sin').querySelector('[data-cb="save-acc"]')); await wait(20);
  t('día de corte fuera de 1-31: lo dice', /1 a 31/.test(b.toasts.at(-1)));
  b.type(b.row('a-sin').querySelector('[data-cbf="cutDay"]'), '');
  b.click(b.row('a-sin').querySelector('[data-cb="save-acc"]')); await wait(30);
  const sa2 = b.calls.filter(c => c[0] === 'adminSaveAccount').at(-1);
  t('crear con monto → adminSaveAccount(a-sin, {amountCOP:160000, cutDay:null})', sa2 && sa2[1] === 'a-sin' && sa2[2].amountCOP === 160000 && sa2[2].cutDay === null);
  // Marcar pagado
  b.click(b.row('a-blk').querySelector('[data-m="paid"]')); await wait(20);
  const pf = (k) => b.row('a-blk').querySelector(`[data-cbf="${k}"]`);
  t('Marcar pagado: monto de la cuenta y hoy por defecto; avisa que se reactivan sus reservas', pf('amountCOP').value === '170000' && pf('paidOn').value === HOY && /sus reservas se reactivan/.test(b.row('a-blk').textContent));
  b.type(pf('viaLabel'), 'Efectivo'); b.type(pf('note'), 'Lo trajo a la oficina');
  b.click(b.row('a-blk').querySelector('[data-cb="save-paid"]')); await wait(30);
  const mp = b.calls.find(c => c[0] === 'adminMarkPaid');
  t('adminMarkPaid(statementId, {viaLabel, amountCOP, paidOn, note})', mp && mp[1] === 's-blk' && mp[2].viaLabel === 'Efectivo' && mp[2].amountCOP === 170000 && mp[2].paidOn === HOY && mp[2].note === 'Lo trajo a la oficina', JSON.stringify(mp));
  // Ajustar
  b.click(b.row('a-pend').querySelector('[data-m="adjust"]')); await wait(20);
  const af = (k) => b.row('a-pend').querySelector(`[data-cbf="${k}"]`);
  b.type(af('discountCOP'), '200000');
  b.click(b.row('a-pend').querySelector('[data-cb="save-adjust"]')); await wait(20);
  t('descuento mayor que el monto: no se guarda y lo dice', !b.calls.some(c => c[0] === 'adminAdjust') && /no puede ser mayor/.test(b.toasts.at(-1)));
  b.type(af('discountCOP'), '17000'); b.type(af('discountNote'), 'Canje de puntos');
  b.click(b.row('a-pend').querySelector('[data-cb="save-adjust"]')); await wait(30);
  const aj = b.calls.find(c => c[0] === 'adminAdjust');
  t('Ajustar → adminAdjust(statementId, {amountCOP, discountCOP, discountNote})', aj && aj[1] === 's-pend' && aj[2].amountCOP === 170000 && aj[2].discountCOP === 17000 && aj[2].discountNote === 'Canje de puntos', JSON.stringify(aj));
  // Abrir cuenta de cobro
  b.click(b.row('a-corte').querySelector('[data-cb="open-st"]')); await wait(30);
  t('Abrir cuenta de cobro → adminOpenStatement(aux)', b.calls.some(c => c[0] === 'adminOpenStatement' && c[1] === 'a-corte'));
  // Historial
  b.click(b.row('a-ok').querySelector('[data-m="hist"]')); await wait(30);
  const rows = [...b.row('a-ok').querySelectorAll('.cb-hist tbody tr')];
  t('Historial → adminDetail(aux) en tabla: mes, monto, estado, pago, comprobantes', b.calls.some(c => c[0] === 'adminDetail' && c[1] === 'a-ok') && rows.length === 2 && /Al día/.test(rows[0].textContent) && /Aprobado/.test(rows[0].textContent));
  // Error del servidor: se muestra su texto.
  w.ApiCobro.adminOpenStatement = async () => { throw new Error('Falta el monto de la mensualidad'); };
  b.click(b.row('a-corte').querySelector('[data-cb="open-st"]')); await wait(30);
  t('un error del servidor se muestra tal cual (en español)', b.toasts.at(-1) === 'Falta el monto de la mensualidad');
  w.stopCobroTimer();
  t('sin errores de consola', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Métodos de pago y valores por defecto ──');
{
  const b = await boot();
  const { w } = b;
  w.renderCobro(); await wait(30);
  b.click(b.q('[data-cb="panel"][data-v="methods"]')); await wait(30);
  t('Métodos de pago: la lista de la base', b.qa('.cb-method').length === 1 && /Bancolombia · Ahorros/.test(txt(b.q('.cb-method'))) && /111-222333-44/.test(txt(b.q('.cb-method'))));
  b.click(b.q('[data-cb="m-new"]')); await wait(10);
  const mf = (k) => b.q(`[data-cbm="${k}"]`);
  b.type(mf('label'), 'Nequi');
  b.click(b.q('[data-cb="m-save"]')); await wait(20);
  t('sin número: no se guarda', !b.calls.some(c => c[0] === 'adminSaveMethod') && /Falta el nombre o el número/.test(b.toasts.at(-1)));
  const sel = mf('kind'); sel.value = 'nequi'; sel.dispatchEvent(new w.Event('change', { bubbles: true }));
  b.type(mf('number'), '310 000 0000');
  b.click(b.q('[data-cb="m-save"]')); await wait(30);
  const sm = b.calls.find(c => c[0] === 'adminSaveMethod');
  t('Guardar método → adminSaveMethod({kind:nequi, label, number})', sm && sm[1].kind === 'nequi' && sm[1].label === 'Nequi' && sm[1].number === '310 000 0000' && !sm[1].id, JSON.stringify(sm));
  b.click(b.q('[data-cb="m-toggle"]')); await wait(30);
  t('Desactivar → adminSetMethodActive(id, false)', b.calls.some(c => c[0] === 'adminSetMethodActive' && c[1] === 'm-1' && c[2] === false));
  b.click(b.q('[data-cb="m-del"]')); await wait(30);
  t('Borrar (con confirmación) → adminDeleteMethod(id)', b.calls.some(c => c[0] === 'adminDeleteMethod' && c[1] === 'm-1'));
  b.D.methods = [];
  b.click(b.q('[data-cb="panel"][data-v="methods"]')); await wait(5);
  b.click(b.q('[data-cb="panel"][data-v="methods"]')); await wait(30);
  t('sin métodos: dice que el tripulante no tiene a dónde transferir', /No hay métodos de pago/.test(b.q('.cb-panel').textContent));
  b.click(b.q('[data-cb="panel"][data-v="settings"]')); await wait(30);
  const sf = (k) => b.q(`[data-cbs="${k}"]`);
  t('Valores por defecto: la mensualidad nace vacía; plazos 5/2/3', sf('defaultAmountCOP').value === '' && sf('dueDays').value === '5' && sf('noticeDays').value === '2' && sf('graceDays').value === '3');
  b.type(sf('defaultAmountCOP'), '165000'); b.type(sf('holderName'), 'Operación de Prueba S.A.S.'); b.type(sf('holderNit'), '900.111.222-3');
  b.click(b.q('[data-cb="s-save"]')); await wait(30);
  const ss = b.calls.find(c => c[0] === 'adminSaveSettings');
  t('Guardar → adminSaveSettings({defaultAmountCOP:165000, dueDays:5, …, holderName, holderNit})', ss && ss[1].defaultAmountCOP === 165000 && ss[1].dueDays === 5 && ss[1].holderName === 'Operación de Prueba S.A.S.' && ss[1].holderNit === '900.111.222-3', JSON.stringify(ss));
  w.stopCobroTimer();
  t('sin errores de consola', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Enlace profundo, errores y sin facturario ──');
{
  const b = await boot();
  const { w } = b;
  w.location.hash = '#/cobro?aux=a-blk';
  await wait(60);
  t('#/cobro?aux=<id> (jefe) → setTab("cobro") y abre esa fila', (w.__tabs || []).includes('cobro') && b.q('.cb-row.open') && b.q('.cb-row.open').getAttribute('data-aux') === 'a-blk');
  t('el hash se consume', !/cobro/.test(w.location.hash));
  w.stopCobroTimer();
  const b2 = await boot({ profile: { id: 'x', role: 'auxiliar' } });
  b2.w.location.hash = '#/cobro?aux=a-blk';
  await wait(40);
  t('un tripulante con ese hash no abre el panel del jefe', !(b2.w.__tabs || []).includes('cobro'));
  const b3 = await boot();
  b3.D.listErr = true;
  b3.w.renderCobro(); await wait(30);
  t('si la lista falla: «No pudimos cargar las cuentas de cobro» + Reintentar', /No pudimos cargar las cuentas de cobro/.test(b3.R().textContent) && !!b3.q('.cb-empty [data-cb="reload"]'));
  b3.D.listErr = false;
  b3.click(b3.q('.cb-empty [data-cb="reload"]')); await wait(30);
  t('Reintentar la trae', b3.qa('.cb-row').length === 7);
  b3.w.stopCobroTimer();
  const b4 = await boot({ sinApi: true });
  b4.w.renderCobro(); await wait(20);
  t('sin ApiCobro: «El facturario no está disponible en esta versión»', /El facturario no está disponible/.test(b4.R().textContent));
  b4.w.stopCobroTimer();
  t('sin errores de consola', [b, b2, b3, b4].every(x => x.errors.length === 0), [b, b2, b3, b4].map(x => x.errors.join(' | ')).join(' || '));
  t('sin red (window.sb nunca se usó)', [b, b2, b3, b4].every(x => x.red.length === 0));
}

console.log(`\n${ok} ✓ · ${bad} ✗`);
console.log('NO cubre: layout (la ficha apilada del celular se mira en el teléfono), la base real (RLS, reloj diario,');
console.log('          push), el bucket privado real ni la navegación completa del admin (core.setTab se simula).');
process.exit(bad ? 1 : 0);
