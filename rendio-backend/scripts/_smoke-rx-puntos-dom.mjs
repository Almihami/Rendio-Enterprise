// P13b · PUNTOS e INVITAR del rediseño del auxiliar (27-sep-2026) — prueba jsdom.
//
// Carga la app real (index.html + api.js + api-aux.js + api-puntos.js +
// aux-rx-ui.js + aux-shell.js + aux-residencias.js + aux-privado.js +
// aux-presentacion.js + aux-rx-inicio/viajes/avisos.js + aux-rx-perfil.js +
// aux-rx-puntos.js + auxiliar.js) con los escenarios de fixtures/aux-escenarios.js.
// Ninguna llamada sale a la red: window.sb es una trampa y ApiPuntos se
// reemplaza por datos de prueba (los de 0091: vitrina 180/320 «Pronto»/400/600).
//
// Comprueba:
//   · APAGADO (así nace): nada en Inicio (sigue Select), Perfil «Todavía no
//     disponible», enabled() false, summary() null, cancelBonus null, y las
//     pantallas dicen honestamente que no está disponible;
//   · ENCENDIDO: la billetera (rx-pocket --d:2) y el bono (rx-bono --d:3) en
//     Inicio con datos reales, uno solo a la vez con Select (D15), nunca con un
//     viaje en curso; si el resumen llega DESPUÉS de pintar Inicio, la billetera
//     entra con .rx-anim (se monta) y RxCount arranca desde 0;
//   · RxPoints: héroe (Tu saldo, barra hacia el canje más barato que aún no
//     alcanzas), segmentado de 3 (indicador sin repintar, lista RECREADA con
//     .rx-anim, key={tab}), vitrina de 0091 con Directo «Pronto», Ganar con los
//     valores del jefe, Movimientos del libro con estado del canje;
//   · canje: hoja rx-sh → ApiPuntos.redeem → la hoja se cierra, el saldo sale de
//     la base (RxCount desde 0 sobre el MISMO nodo), la fila se apaga en su
//     lugar y la fiesta (rx-over pts + 26 papelitos + rx-check) llega a los 240 ms;
//     un error de la base se muestra en la hoja y no hay fiesta;
//   · RxInvite: héroe honesto (sin «bono 3 de 4»), código real, Copiar
//     (portapapeles), WhatsApp (wa.me), Compartir (navigator.share o copiar),
//     «Invitaste a» SOLO con nombre + inicial, meta anónima del conjunto;
//     lo que llega de la red se concilia por key (lo que estaba no vuelve a entrar);
//   · cancelBonus = la regla del trigger (hora publicada y ≥ N h);
//   · escenario del arnés «puntos-en-blanco» (todo ApiPuntos en null): sin dato,
//     sin errores; barrido de textos prohibidos; cambio de cuenta limpia la caché;
//   · con la bandera APAGADA no se pinta nada del rediseño;
//   · admin-puntos.js (#puntos-ui): canjes (cumplir / rechazar con motivo),
//     programa (interruptor + valores + meta), vitrina, saldos (buscar, ajustar
//     con nota), sin 0091 lo dice, enlace #/puntos.
//
// LO QUE NO CUBRE: jsdom no hace layout ni corre animaciones CSS (no prueba que
// rxRise/rxGrow/rxFall/rxFadeO se VEAN, ni el deslizamiento del indicador, ni
// cómo se ve en 390 px claro/nocturno), ni el portapapeles, navigator.share o
// WhatsApp reales (son dobles de prueba), ni la base de verdad (0091 la prueba
// _verify-0091.mjs / _smoke-api-puntos.mjs), ni el push al jefe.
//
//   cd rendio-backend && node scripts/_smoke-rx-puntos-dom.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const FIX = new URL('./fixtures/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
const readFix = (f) => readFileSync(FIX + f, 'utf8');
let ok = 0, bad = 0;
const rechazos = [];
process.on('unhandledRejection', (e) => { rechazos.push((e && e.stack ? e.stack.split('\n').slice(0, 2).join(' · ') : String(e))); });
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null && d !== '' ? ' → ' + d : '')); } };
const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));
const clone = (x) => JSON.parse(JSON.stringify(x));

const PROHIBIDOS = [
  ['cifra en pesos', /\$\s?\d/], ['Carlos Mejía', /Carlos Mej[ií]a/], ['Laura', /\bLaura\b/], ['LAURA', /LAURA/], ['AV9525', /AV9525/],
  ['Juliana', /Juliana/], ['Plan B', /Plan B/], ['24/7', /24\/7/], ['en línea', /en l[ií]nea/i], ['Último cupo', /[ÚU]ltimo cupo/],
  ['Siempre hay cupo', /Siempre hay cupo/], ['kit', /\bkit\b/i], ['Preparado', /Preparado/], ['Esta noche te avisamos', /noche te avisamos/i],
  ['38 auxiliares', /38 auxiliares/], ['bono 3 de 4', /3 de 4/], ['Te falta 1 colega', /Te falta 1 colega/], ['carro fijo', /carro fijo/i],
  ['próximo traslado (canje)', /Lo verás aplicado/], ['asiento', /asiento/i], ['Diana Restrepo', /Diana Restrepo/], ['El Olivar · cuenta doble', /Vive en El Olivar/],
];
const prohibidos = (html) => {
  const txt = String(html || '').replace(/<[^>]+>/g, ' ');
  return PROHIBIDOS.filter(([, re]) => re.test(txt)).map(([n]) => n);
};

// Datos de prueba con la forma de ApiPuntos (0091).
const REWARDS = [
  { id: 'colega', title: 'Traer a un colega gratis', description: 'Un cupo en tu traslado compartido', cost: 180, kind: 'guest_seat', amount: 1, enabled: true, soon: false, sort: 1 },
  { id: 'directo', title: 'Un traslado Directo', description: 'Sin paradas, derecho a tu destino', cost: 320, kind: 'direct_trip', amount: 1, enabled: true, soon: true, sort: 2 },
  { id: 'mensual', title: '3 días de tu mensualidad', description: 'Se descuentan de tu próximo cobro', cost: 400, kind: 'billing_days', amount: 3, enabled: true, soon: false, sort: 3 },
  { id: 'privado', title: 'Un traslado Privado', description: 'Carro solo para ti · lo confirma Coordinación', cost: 600, kind: 'private_trip', amount: 1, enabled: true, soon: false, sort: 4 },
];
const hace = (h) => new Date(Date.now() - h * 3600e3).toISOString();

async function boot({ flag = true } = {}) {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const errors = [];
  w.console.error = (...a) => { errors.push(a.map(x => (x && x.stack) || (x && x.message) || String(x)).join(' ')); };
  w.addEventListener('error', (e) => errors.push('window.error: ' + e.message));
  w.RENDIO_CONFIG = {}; w.L = undefined;
  const toasts = [];
  w.toast = (m) => toasts.push(String(m));
  w.escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const red = [];
  const trampa = new Proxy(function () {}, {
    get: (_, k) => { if (k === 'then') return undefined; red.push(String(k)); return trampa; },
    apply: () => { red.push('()'); return trampa; },
  });
  w.sb = trampa;
  w.state = { settings: {} };
  w.eval(readFix('fake-sw.js'));
  w.eval(readFix('fake-leaflet.js'));
  w.localStorage.setItem('rendio.aux.rx', flag ? '1' : '0');
  w.localStorage.setItem('rendio.aux.onboarded', '1');
  for (const id of ['esc-perfil-laura', 'p1']) w.localStorage.setItem('rendio.aux.onboarded.' + id, '1');
  for (const f of ['api.js', 'api-aux.js', 'api-puntos.js', 'aux-rx-ui.js', 'aux-shell.js', 'aux-residencias.js', 'aux-privado.js', 'aux-presentacion.js',
    'aux-rx-inicio.js', 'aux-rx-viajes.js', 'aux-rx-avisos.js', 'aux-rx-perfil.js', 'aux-rx-puntos.js', 'auxiliar.js']) {
    try { w.eval(read(f)); } catch (e) { errors.push(f + ': ' + e.message); }
  }
  try { w.AuxPresentacion && w.AuxPresentacion.markOnboarded && w.AuxPresentacion.markOnboarded(); } catch (_) { /* */ }
  // Lo original de AuxPuntos y ApiPuntos (el arnés los reemplaza al montar).
  const AUXP = { enabled: w.AuxPuntos.enabled, summary: w.AuxPuntos.summary, cancelBonus: w.AuxPuntos.cancelBonus };
  const PURAS = {};
  ['normalizeCode', 'nextReward', 'cancelEarns', 'movementTitle', 'inviteLink', 'inviteText', 'refFromUrl'].forEach(k => { PURAS[k] = w.ApiPuntos[k]; });
  w.eval(readFix('aux-escenarios.js'));
  const E = w.AuxEscenarios, A = w.Auxiliar, AS = w.AuxShell;
  const d = E.montar('historial');
  await A.init(d.profile).catch((e) => errors.push('init: ' + e.message));
  await wait(40);
  red.length = 0;

  // Puntos de prueba: PD manda; las funciones leen de ahí en cada llamada.
  const PD = {
    enabled: true, balance: 200, invitedCount: 2, invitedDone: 1,
    values: { invite: 40, neighbor: 80, cancel: 20, cancelLeadHours: 2, rate: 5 },
    rewards: clone(REWARDS),
    moves: [
      { id: 'm1', points: 80, kind: 'referral_neighbor', title: 'Tu colega hizo su primer viaje', sub: 'Diana R. · vive en tu conjunto, cuenta doble', at: hace(1), reservationId: null, redemptionId: null },
      { id: 'm2', points: -180, kind: 'redeem', title: 'Canjeaste «Traer a un colega gratis»', sub: '', at: hace(30), reservationId: null, redemptionId: 'rd1' },
      { id: 'm3', points: 5, kind: 'rate', title: 'Calificaste tu viaje', sub: '', at: hace(24 * 9), reservationId: 'r1', redemptionId: null },
    ],
    reds: [{ id: 'rd1', rewardId: 'colega', title: 'Traer a un colega gratis', cost: 180, status: 'pending', note: '', requestedAt: hace(30), decidedAt: null, decisionNote: '' }],
    code: 'MARTA-OLV',
    refs: [
      { name: 'Diana R.', initials: 'DR', status: 'ok', points: 80, neighbor: true, claimedAt: hace(200), creditedAt: hace(1) },
      { name: 'Andrés C.', initials: 'AC', status: 'wait', points: null, neighbor: false, claimedAt: hace(50), creditedAt: null },
    ],
    goal: { residenceName: 'El Olivar', count: 7, target: 10, text: 'Entre más vecinos, mejor armamos la ruta de tu conjunto', pct: 70 },
    redeemErr: null, calls: [], hold: null,
  };
  const later = (v) => (PD.hold ? PD.hold.then(() => clone(v)) : Promise.resolve(clone(v)));
  function ponerPuntos() {
    const P = w.ApiPuntos;
    Object.assign(P, PURAS);
    P.summary = () => later({
      enabled: PD.enabled, balance: PD.balance, pendingCount: 1, pendingPoints: 180, earnedTotal: 265,
      invitedCount: PD.invitedCount, invitedDone: PD.invitedDone, values: PD.values,
    });
    P.settings = () => later({ enabled: PD.enabled, ...PD.values, goalTarget: 10, goalText: PD.goal.text });
    P.rewards = () => later(PD.rewards);
    P.movements = () => later(PD.moves);
    P.myRedemptions = () => later(PD.reds);
    P.myCode = () => later(PD.code);
    P.myReferrals = () => later(PD.refs);
    P.goal = () => later(PD.goal);
    P.redeem = async (id, note) => {
      PD.calls.push(['redeem', id, note]);
      if (PD.redeemErr) throw new Error(PD.redeemErr);
      const r = PD.rewards.find(x => x.id === id);
      PD.balance -= r.cost;
      return { ok: true, redemptionId: 'rd-new', balance: PD.balance };
    };
    Object.assign(w.AuxPuntos, AUXP);
  }
  const ui = () => w.document.getElementById('auxiliar-ui');
  const q = (s) => ui().querySelector(s);
  const qa = (s) => [...ui().querySelectorAll(s)];
  const click = (el) => el && el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  async function montar(n, o) {
    E.montar(n, o);
    A.state.profile.full_name = 'Marta Ríos Vélez';
    A.rerender();
    await wait(40);
  }
  return { w, E, A, AS, d, PD, errors, red, toasts, ui, q, qa, click, montar, ponerPuntos, AUXP };
}

const layer = (b, id) => b.q(`.rx-layer[data-scr="${id}"]:not(.out)`);
const homeEl = (b) => b.q('.rx-tabview[data-scr="home"]');

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Registro y contrato ──');
const b = await boot();
const { w, E, A, AS, PD } = b;
t('window.AuxPuntos: enabled/summary/cancelBonus + load', ['enabled', 'summary', 'cancelBonus', 'load'].every(k => typeof w.AuxPuntos[k] === 'function'));
t('pantallas «points» e «invite» registradas en el shell', AS.registered('points') && AS.registered('invite'));
t('enganche home.hook «points» (prioridad 20, gana a Select)', !!w.AuxShell && (() => {
  const hs = AS.hooks('home.hook', { state: A.state, shell: AS, inCourse: false });
  return Array.isArray(hs);
})());

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── APAGADO (así nace) ──');
await b.montar('historial');
b.ponerPuntos();
PD.enabled = false;
await w.AuxPuntos.load({ force: true });
await wait(40);
t('enabled() false con aux_points_enabled en false', w.AuxPuntos.enabled() === false);
t('summary() null y cancelBonus() null', w.AuxPuntos.summary() === null && w.AuxPuntos.cancelBonus({ pickupAt: new Date(Date.now() + 5 * 3600e3).toISOString(), status: 'assigned' }) === null);
AS.setTab('inicio');
await wait(60);
let h = homeEl(b);
t('Inicio: sin billetera ni bono', !h.querySelector('.rx-pocket') && !h.querySelector('.rx-bono'));
t('Inicio: el anzuelo sigue siendo Select', !!h.querySelector('.rx-select-teaser[data-rx="open-select"]'));
AS.setTab('perfil');
await wait(60);
const rowSub = (k) => { const el = b.q(`.rx-tabview[data-scr="me"] [data-me="${k}"]`); return el && el.querySelector('.rx-row-tx > span') ? el.querySelector('.rx-row-tx > span').textContent : null; };
t('Perfil: Puntos e Invitar «Todavía no disponible» (sin acción)', rowSub('row-points') === 'Todavía no disponible' && rowSub('row-invite') === 'Todavía no disponible'
  && !b.q('[data-me="row-points"]').hasAttribute('data-rx'));
AS.push('points', {});
await wait(60);
let L = layer(b, 'points');
t('push(points) apagado: dice que no está disponible, sin cifras', !!L && /Rendio Points todavía no está disponible/.test(L.textContent) && !L.querySelector('.rx-pts-hero'));
AS.popAll();
AS.push('invite', {});
await wait(60);
L = layer(b, 'invite');
t('push(invite) apagado: dice que no está disponible, sin código', !!L && /Invitar colegas todavía no está disponible/.test(L.textContent) && !L.querySelector('.rx-code'));
AS.popAll();
await wait(20);

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── ENCENDIDO: caché y contrato ──');
PD.enabled = true;
AS.setTab('inicio');
await wait(60);
t('Inicio antes de que llegue el resumen: sin billetera', !homeEl(b).querySelector('.rx-pocket'));
await w.AuxPuntos.load({ force: true });
await wait(60);
const S = w.AuxPuntos.summary();
t('enabled() true y summary() con el saldo de la base', w.AuxPuntos.enabled() === true && S && S.balance === 200);
t('nextReward salta Directo («Pronto»): 400 · «3 días de tu mensualidad»', S && S.nextRewardPts === 400 && S.nextRewardName === '3 días de tu mensualidad', JSON.stringify(S && [S.nextRewardPts, S.nextRewardName]));
const en = (h) => new Date(Date.now() + h * 3600e3).toISOString();
t('cancelBonus: hora publicada a 5 h → {pts:20}', JSON.stringify(w.AuxPuntos.cancelBonus({ pickupAt: en(5), status: 'assigned' })) === '{"pts":20}');
t('cancelBonus: a 1 h (menos de 2 h) → null', w.AuxPuntos.cancelBonus({ pickupAt: en(1), status: 'assigned' }) === null);
t('cancelBonus: sin hora publicada → null', w.AuxPuntos.cancelBonus({ pickupAt: null, status: 'pending' }) === null);

console.log('\n── ENCENDIDO: Inicio ──');
h = homeEl(b);
let pocket = h.querySelector('.rx-pocket');
t('billetera .rx-pocket.rx-in --d:2 que abre Puntos', !!pocket && pocket.classList.contains('rx-in') && pocket.style.getPropertyValue('--d') === '2' && pocket.getAttribute('data-rx') === 'pts-open');
t('la billetera APARECE en una pestaña ya pintada: entra con .rx-anim (se monta)', !!pocket && pocket.classList.contains('rx-anim'));
t('marcado del diseño: rx-pocket-ic > i · rx-pocket-tx (b + span) · chevron', !!pocket.querySelector('.rx-pocket-ic > i') && !!pocket.querySelector('.rx-pocket-tx > b') && !!pocket.querySelector('.rx-pocket-tx > span') && !!pocket.querySelector('use[href="#rx-ChevronRight"]'));
const pn = pocket.querySelector('[data-pts-n]');
t('RxCount al montar: arranca desde 0 (no pinta la cifra final de golpe)', pn && Number(pn.textContent) < 200, pn && pn.textContent);
await wait(900);
t('RxCount llega a 200 (800 ms)', pn.textContent === '200' && /200 puntos/.test(pocket.querySelector('.rx-pocket-tx b').textContent));
t('texto honesto: «Ya te alcanza para traer a un colega gratis» (con la vitrina real)', pocket.querySelector('.rx-pocket-tx > span').textContent === 'Ya te alcanza para traer a un colega gratis', pocket.querySelector('.rx-pocket-tx > span').textContent);
const bono = h.querySelector('.rx-bono');
t('bono .rx-bono.rx-in --d:3 que abre Invitar', !!bono && bono.style.getPropertyValue('--d') === '3' && bono.getAttribute('data-rx') === 'inv-open');
t('bono sin «3 de 4 / te falta 1 colega»: cuántos invitaste y cuántos viajaron', /1 de 2/.test(bono.querySelector('.rx-bono-h b').textContent) && /1 colega aún no hace su primer viaje/.test(bono.textContent));
t('puntos del bono: uno por colega (2, uno lleno), sin meta fija de 4', bono.querySelectorAll('.rx-bono-dots i').length === 2 && bono.querySelectorAll('.rx-bono-dots i.on').length === 1 && bono.querySelector('.rx-bono-dots').getAttribute('data-n') === '2');
t('uno solo a la vez con Select (D15): con Puntos encendido no sale el anzuelo de Select', !h.querySelector('.rx-select-teaser'));
// Repintado sin cambios: la billetera NO vuelve a entrar ni a contar.
const pocketAntes = pocket;
A.rerender();
await wait(40);
pocket = homeEl(b).querySelector('.rx-pocket');
t('Inicio sin cambios: patch, la MISMA billetera (no vuelve a entrar)', pocket === pocketAntes);
t('repintar Inicio sin cambios: la cifra queda en 200 (sin volver a contar)', pocket.querySelector('[data-pts-n]').textContent === '200');
// Cambia el saldo: RxCount vuelve a contar desde 0 (useEffect [to]).
PD.balance = 260;
await w.AuxPuntos.load({ force: true });
await wait(20);
pocket = homeEl(b).querySelector('.rx-pocket');
t('saldo nuevo (260): Inicio se repinta y RxCount cuenta desde 0', pocket.querySelector('[data-pts-n]').getAttribute('data-pts-n') === '260' && Number(pocket.querySelector('[data-pts-n]').textContent) < 260);
t('ese repintado no hace entrar la billetera otra vez (sin .rx-anim, bajo .rx-noanim)', pocket !== pocketAntes && !pocket.classList.contains('rx-anim') && !!pocket.closest('.rx-noanim'));
PD.balance = 200;
await w.AuxPuntos.load({ force: true });
await wait(900);
t('Inicio sin textos prohibidos', prohibidos(homeEl(b).innerHTML).length === 0, prohibidos(homeEl(b).innerHTML).join(', '));
await b.montar('en-camino');
b.ponerPuntos();
await w.AuxPuntos.load({ force: true });
await wait(60);
t('con un viaje en curso no hay billetera ni bono (D15)', !homeEl(b).querySelector('.rx-pocket') && !homeEl(b).querySelector('.rx-bono'));
await b.montar('historial');
b.ponerPuntos();
await w.AuxPuntos.load({ force: true });
await wait(60);

console.log('\n── ENCENDIDO: Perfil ──');
AS.setTab('perfil');
await wait(80);
t('Perfil: Puntos con saldo y el canje que falta (lo lee P7 de AuxPuntos.summary)', rowSub('row-points') === '200 pts · te faltan 200 para 3 días de tu mensualidad', rowSub('row-points'));
t('Perfil: la fila de Puntos abre la pantalla (me-push → points)', b.q('[data-me="row-points"]').getAttribute('data-to') === 'points');
b.click(b.q('[data-me="row-points"]'));
await wait(80);

console.log('\n── RxPoints ──');
L = layer(b, 'points');
t('la capa «points» se abre desde Perfil', !!L);
const body = () => layer(b, 'points').querySelector('.rx-scr > .rx-body');
t('cabecera «Puntos Rendio» con volver (rx-pop)', /Puntos Rendio/.test(L.querySelector('.rx-head').textContent) && !!L.querySelector('.rx-head [data-rx="rx-pop"]'));
const kids = [...body().children].map(c => c.className.split(' ')[0]);
t('hijos de rx-body como el diseño: rx-pts-hero · rx-seg · rx-list · rx-note', kids.join(',') === 'rx-pts-hero,rx-seg,rx-list,rx-note', kids.join(','));
const hero = body().querySelector('.rx-pts-hero');
t('héroe .rx-in sin --d, «Tu saldo», cifra 200', hero.classList.contains('rx-in') && !hero.style.getPropertyValue('--d') && hero.querySelector('.rx-pts-l').textContent === 'Tu saldo' && hero.querySelector('.rx-pts-n b').getAttribute('data-pts-n') === '200');
t('barra hacia el canje más barato que aún no alcanzas: 200/400 = 50%', hero.querySelector('.rx-pts-bar i').style.width === '50%', hero.querySelector('.rx-pts-bar i').style.width);
t('«Te faltan 200 pts para 3 días de tu mensualidad» (no un Directo fijo)', hero.querySelector('.rx-pts-s').textContent === 'Te faltan 200 pts para 3 días de tu mensualidad');
const seg = body().querySelector('.rx-seg');
t('segmentado de 3: Canjear · Ganar · Movimientos (--n:3)', [...seg.querySelectorAll('button')].map(x => x.textContent).join('|') === 'Canjear|Ganar|Movimientos' && seg.style.getPropertyValue('--n') === '3');
let rows = [...body().querySelectorAll('.rx-list .rx-shelf')];
t('vitrina de la base: 4 filas .rx-shelf.rx-in con --d 0..3', rows.length === 4 && rows.map(r => r.style.getPropertyValue('--d')).join(',') === '0,1,2,3');
t('colega (180) se puede: botón con RxPts 12 px (i de 6.6000000000000005px)', !rows[0].classList.contains('no') && !rows[0].querySelector('button').disabled
  && rows[0].querySelector('button .rx-pts').style.fontSize === '12px' && rows[0].querySelector('.rx-pts i').style.width === '6.6000000000000005px' && /180 pts/.test(rows[0].querySelector('button').textContent));
t('Directo sale «Pronto», apagado (el nivel no existe)', rows[1].classList.contains('no') && rows[1].querySelector('button').disabled && /Pronto/.test(rows[1].querySelector('button').textContent));
t('mensual (400) y privado (600) apagados con .no', rows[2].classList.contains('no') && rows[2].querySelector('button').disabled && rows[3].classList.contains('no') && rows[3].querySelector('button').disabled);
t('íconos del diseño: Users · ArrowRight · Wallet · Sparkle', rows.map(r => r.querySelector('.rx-row-ic.t-pts use').getAttribute('href')).join(',') === '#rx-Users,#rx-ArrowRight,#rx-Wallet,#rx-Sparkle');
t('privado sin «kit de confort»: «Carro solo para ti · lo confirma Coordinación»', /lo confirma Coordinación/.test(rows[3].textContent) && !/kit/i.test(rows[3].textContent));
t('nota «Los puntos no son plata»', /Los puntos no son plata: no se retiran ni se transfieren\./.test(body().querySelector('.rx-note').textContent));
const heroB = hero.querySelector('.rx-pts-n b');
await wait(900);
t('RxCount del héroe llega a 200', heroB.textContent === '200');
AS.render();
await wait(20);
t('AuxShell.render() con Puntos arriba: patch sin tocar nada (mismo héroe, misma cifra)', body().querySelector('.rx-pts-hero') === hero && heroB.textContent === '200');
// Algo la tapa y se va: el shell la repinta («reveal») sin volver a contar.
AS.push('notifs', {});
await wait(40);
AS.pop();
await wait(320);
t('al volver a quedar arriba (repintado): la cifra queda en 200, sin RxCount otra vez', body().querySelector('.rx-pts-n b').textContent === '200' && !!body().closest('.rx-noanim'));

// Segmentado (los nodos se vuelven a leer: el «reveal» de arriba repintó).
const segBefore = body().querySelector('.rx-seg'), listBefore = body().querySelector('.rx-list');
b.click(segBefore.querySelectorAll('button')[1]);
await wait(20);
t('Ganar: el MISMO segmentado (sin repintar), indicador a translateX(100%)', body().querySelector('.rx-seg') === segBefore && segBefore.querySelector('.rx-seg-ind').style.transform === 'translateX(100%)' && segBefore.querySelectorAll('button')[1].className === 'on');
let list = body().querySelector('.rx-list');
t('Ganar: la lista se RECREA con .rx-anim (key={tab})', list !== listBefore && list.classList.contains('rx-anim') && list.getAttribute('data-v') === 'earn');
rows = [...list.querySelectorAll('.rx-shelf')];
t('Ganar: +40 · +20 · +5 con los valores del jefe', rows.map(r => r.querySelector('em.rx-plus').textContent).join(',') === '+40,+20,+5');
t('Ganar: vecino 80 y «2 h» (sin prometer asiento)', /Si vive en tu conjunto: 80\./.test(rows[0].textContent) && /2 h o más/.test(rows[1].textContent) && !/asiento/i.test(list.textContent));
b.click(segBefore.querySelectorAll('button')[2]);
await wait(20);
list = body().querySelector('.rx-list');
rows = [...list.querySelectorAll('.rx-shelf')];
t('Movimientos: 3 filas del libro, más reciente primero', rows.length === 3 && /Tu colega hizo su primer viaje/.test(rows[0].textContent));
t('Movimientos: +80 (rx-plus) y -180 (rx-minus)', rows[0].querySelector('em').className === 'rx-plus' && rows[0].querySelector('em').textContent === '+80' && rows[1].querySelector('em').className === 'rx-minus' && rows[1].querySelector('em').textContent === '-180');
t('Movimientos: el canje dice su estado («por aplicar») y la fecha («hoy»/«ayer»/«dd mmm»)', /por aplicar/.test(rows[1].textContent) && /· (hoy|ayer)$/.test(rows[0].querySelector('.rx-row-tx span').textContent) && /(^|· )[a-záéíóú]{3} \d{1,2} [a-z]{3}$/.test(rows[2].querySelector('.rx-row-tx span').textContent), rows.map(r => r.querySelector('.rx-row-tx span').textContent).join(' | '));
b.click(segBefore.querySelectorAll('button')[0]);
await wait(20);
t('RxPoints sin textos prohibidos', prohibidos(layer(b, 'points').innerHTML).length === 0, prohibidos(layer(b, 'points').innerHTML).join(', '));

console.log('\n── Canje ──');
b.click(body().querySelector('.rx-shelf [data-rx="pts-redeem"][data-id="colega"]'));
await wait(30);
let sh = b.q('.rx-sheet .rx-sh');
t('hoja rx-sh: ícono pts, título y «Se descuentan 180 pts y te quedan 20.»', !!sh && !!sh.querySelector('.rx-sh-ic.pts') && sh.querySelector('h3').textContent === 'Traer a un colega gratis'
  && /Un cupo en tu traslado compartido\. Se descuentan 180 pts y te quedan 20\./.test(sh.querySelector('p').textContent));
t('botones: «Canjear por 180 pts» (pts) y «Ahora no» (ghost, sheet-close)', /Canjear por 180 pts/.test(sh.querySelector('.rx-btn.pts').textContent) && sh.querySelector('.rx-btn.ghost').getAttribute('data-rx') === 'sheet-close');
// Error de la base: se ve en la hoja, no hay fiesta.
PD.redeemErr = 'Te faltan 35 pts para este canje';
b.click(sh.querySelector('[data-rx="pts-redeem-go"]'));
await wait(30);
sh = b.q('.rx-sheet .rx-sh');
t('error de la base: queda en la hoja con su texto y el botón vuelve', !!sh && !sh.querySelector('.rx-pts-err').hidden && sh.querySelector('.rx-pts-err').textContent === 'Te faltan 35 pts para este canje' && !sh.querySelector('[data-rx="pts-redeem-go"]').disabled);
await wait(300);
t('error: sin fiesta', !layer(b, 'points').querySelector('.rx-over'));
PD.redeemErr = null;
const heroBefore = body().querySelector('.rx-pts-hero'), bBefore = heroBefore.querySelector('.rx-pts-n b'), row0 = body().querySelector('.rx-shelf[data-k="rw-colega"]');
b.click(sh.querySelector('[data-rx="pts-redeem-go"]'));
await wait(15);
t('ApiPuntos.redeem("colega")', PD.calls.some(c => c[0] === 'redeem' && c[1] === 'colega'));
t('la hoja se cierra (.out)', !!b.q('.rx-sheet-bg.out') || !b.q('.rx-sheet'));
t('saldo de la base (20) sobre el MISMO nodo, RxCount desde 0', body().querySelector('.rx-pts-hero') === heroBefore && heroBefore.querySelector('.rx-pts-n b') === bBefore && bBefore.getAttribute('data-pts-n') === '20' && Number(bBefore.textContent) < 20, bBefore.textContent);
t('la fila del colega se apaga EN SU LUGAR (mismo nodo, .no y disabled)', body().querySelector('.rx-shelf[data-k="rw-colega"]') === row0 && row0.classList.contains('no') && row0.querySelector('button').disabled);
t('antes de 240 ms no hay fiesta', !layer(b, 'points').querySelector('.rx-over'));
await wait(260);
const over = layer(b, 'points').querySelector('.rx-scr > .rx-over.pts');
t('fiesta a los 240 ms: .rx-over.pts dentro de .rx-scr con .rx-anim', !!over && over.classList.contains('rx-anim'));
const conf = over && [...over.querySelectorAll('.rx-confetti i')];
t('26 papelitos con los colores del diseño y demora (i % 8) * 60 ms', conf && conf.length === 26 && conf[9].style.animationDelay === '60ms' && conf[1].style.getPropertyValue('--c') === '#8A63DC' && conf[1].style.left === '37%');
t('rx-check t-pts · «¡Canjeado!» · texto honesto (Coordinación lo aplica)', !!over.querySelector('.rx-check.t-pts') && over.querySelector('h2').textContent === '¡Canjeado!'
  && /Traer a un colega gratis\. Coordinación lo aplica; el estado lo ves en Movimientos\./.test(over.querySelector('p').textContent));
b.click(over.querySelector('.rx-btn.pts'));
await wait(20);
t('«Genial» cierra la fiesta', !layer(b, 'points').querySelector('.rx-over'));
await wait(900);
t('RxCount del héroe termina en 20', bBefore.textContent === '20');
AS.popAll();
await wait(40);

console.log('\n── RxInvite ──');
PD.hold = new Promise(r => { PD.release = r; });
AS.setTab('inicio');
await wait(40);
AS.push('invite', {});
await wait(40);
L = layer(b, 'invite');
const ib = () => layer(b, 'invite').querySelector('.rx-scr > .rx-body');
t('cabecera «Invitar colegas»', !!L && /Invitar colegas/.test(L.querySelector('.rx-head').textContent));
const heroI0 = ib().querySelector('.rx-inv-hero');
t('mientras carga: código «—» y Copiar apagado (sin código inventado)', ib().querySelector('.rx-code b').textContent === '—' && ib().querySelector('[data-rx="inv-copy"]').disabled);
PD.release(); PD.hold = null;
await wait(60);
const heroI = ib().querySelector('.rx-inv-hero');
t('al llegar los datos el héroe es el MISMO nodo (no vuelve a entrar)', heroI === heroI0);
t('héroe honesto: «Ganas 40 pts por cada colega que haga su primer viaje» + cuenta doble 80', heroI.querySelector('h2').textContent === 'Ganas 40 pts por cada colega que haga su primer viaje' && /cuenta doble: 80 pts/.test(heroI.textContent));
const dotsI = heroI.querySelectorAll('.rx-bono-dots.lg i');
t('puntos grandes con --k (rxGrow escalonado) y .rx-anim al aparecer', dotsI.length === 2 && dotsI[1].style.getPropertyValue('--k') === '1' && dotsI[0].classList.contains('on') && heroI.querySelector('.rx-bono-dots.lg').classList.contains('rx-anim'));
const code = ib().querySelector('.rx-code');
t('rx-code .rx-in --d:1 con el código de la base', code.style.getPropertyValue('--d') === '1' && code.querySelector('b').textContent === 'MARTA-OLV' && !code.querySelector('button').disabled);
const share = ib().querySelector('.rx-share');
t('rx-share --d:2: WhatsApp (pri, MessageCircle) y Compartir enlace (sec, Share)', share.style.getPropertyValue('--d') === '2'
  && share.querySelector('.rx-btn.pri use').getAttribute('href') === '#rx-MessageCircle' && share.querySelector('.rx-btn.sec use').getAttribute('href') === '#rx-Share');
t('«Invitaste a» + rx-group --d:3', ib().querySelector('.rx-lbl').textContent === 'Invitaste a' && ib().querySelector('.rx-group').style.getPropertyValue('--d') === '3');
const refRows = [...ib().querySelectorAll('.rx-group .rx-row.static')];
t('solo nombre + inicial: «Diana R.» (+80, vive en tu conjunto) y «Andrés C.» (esperando)', refRows.length === 2 && refRows[0].querySelector('b').textContent === 'Diana R.' && refRows[0].querySelector('.rx-av.sm').textContent === 'DR'
  && refRows[0].querySelector('em.rx-plus').textContent === '+80' && /vive en tu conjunto/.test(refRows[0].textContent) && !!refRows[1].querySelector('.rx-wait-dot'));
const goal = ib().querySelector('.rx-goal');
t('meta anónima del conjunto --d:4: «Tu conjunto · El Olivar», texto del jefe, 70%, «7 de 10»', !!goal && goal.style.getPropertyValue('--d') === '4' && goal.querySelector('span').textContent === 'Tu conjunto · El Olivar'
  && goal.querySelector('.rx-pts-bar i').style.width === '70%' && goal.querySelector('em').textContent === '7 de 10' && goal.classList.contains('rx-anim'));
// Copiar / WhatsApp / Compartir.
const copied = [];
Object.defineProperty(w.navigator, 'clipboard', { configurable: true, value: { writeText: async (s) => { copied.push(s); } } });
const opened = [];
w.open = (u) => { opened.push(u); return {}; };
b.click(code.querySelector('button'));
await wait(20);
t('Copiar: el código al portapapeles + toast «Código copiado»', copied[0] === 'MARTA-OLV' && /Código copiado/.test(b.q('.rx-toast') ? b.q('.rx-toast').textContent : ''));
b.click(share.querySelector('[data-rx="inv-wa"]'));
await wait(20);
t('WhatsApp: abre wa.me con el texto y el código', /^https:\/\/wa\.me\/\?text=/.test(opened[0] || '') && decodeURIComponent(opened[0]).includes('MARTA-OLV'));
b.click(share.querySelector('[data-rx="inv-share"]'));
await wait(20);
t('Compartir sin navigator.share: copia el enlace ?ref=CODIGO + «Enlace copiado»', copied[1] === 'http://localhost/?ref=MARTA-OLV' && /Enlace copiado/.test(b.q('.rx-toast').textContent), copied[1]);
const shared = [];
w.navigator.share = async (o) => { shared.push(o); };
b.click(share.querySelector('[data-rx="inv-share"]'));
await wait(20);
t('Compartir con navigator.share: el texto lleva el código y el enlace', shared.length === 1 && /MARTA-OLV/.test(shared[0].text) && /\?ref=MARTA-OLV/.test(shared[0].text));
t('RxInvite sin textos prohibidos (ni «bono 3 de 4» ni «carro fijo»)', prohibidos(layer(b, 'invite').innerHTML).length === 0, prohibidos(layer(b, 'invite').innerHTML).join(', '));
AS.popAll();
await wait(40);

console.log('\n── Arnés «puntos-en-blanco» (ApiPuntos en null) ──');
await b.montar('puntos-en-blanco');
AS.push('points', {});
await wait(80);
L = layer(b, 'points');
t('saldo 0 y el canje del arnés como destino', L.querySelector('.rx-pts-n b').getAttribute('data-pts-n') === '0' && /Te faltan 180 pts para traslado gratis para un colega/.test(L.querySelector('.rx-pts-s').textContent), L.querySelector('.rx-pts-s') && L.querySelector('.rx-pts-s').textContent);
t('vitrina sin dato: lo dice (sin filas inventadas)', /La vitrina todavía no está disponible\./.test(L.querySelector('.rx-list').textContent) && !L.querySelector('.rx-list .rx-shelf'));
b.click(L.querySelectorAll('.rx-seg button')[2]);
await wait(40);
t('Movimientos sin dato: lo dice', /Tus movimientos todavía no están disponibles\./.test(layer(b, 'points').querySelector('.rx-list').textContent));
AS.popAll();
AS.push('invite', {});
await wait(80);
L = layer(b, 'invite');
t('Invitar sin código: «—», Copiar y compartir apagados y el aviso', L.querySelector('.rx-code b').textContent === '—' && L.querySelector('[data-rx="inv-copy"]').disabled
  && L.querySelector('[data-rx="inv-wa"]').disabled && /No pudimos traer tu código/.test(L.textContent));
t('sin meta: no hay tarjeta del conjunto', !L.querySelector('.rx-goal'));
AS.popAll();
await wait(30);

console.log('\n── Cambio de cuenta ──');
b.ponerPuntos();
await w.AuxPuntos.load({ force: true });
t('con la cuenta A hay resumen', !!w.AuxPuntos.summary());
PD.enabled = false;
A.state.profile = Object.assign({}, A.state.profile, { id: 'otra-cuenta' });
t('otra cuenta: la caché de la anterior no se usa (mientras carga, nada)', w.AuxPuntos.summary() === null);
await wait(40);
t('y se vuelve a pedir para la nueva', w.AuxPuntos.enabled() === false);

t('sin errores de consola en toda la corrida (tripulante)', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
t('ninguna llamada a la red (window.sb intacto)', b.red.length === 0, b.red.slice(0, 8).join(','));

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Bandera APAGADA ──');
{
  const b2 = await boot({ flag: false });
  t('sin rx-phone ni pantallas del rediseño', !b2.ui().classList.contains('rx-phone') && !b2.q('.rx-pocket') && !b2.q('[data-scr="points"]'));
  t('AuxPuntos existe y responde sin romper', typeof b2.w.AuxPuntos.enabled() === 'boolean');
  t('sin errores con la bandera apagada', b2.errors.length === 0, b2.errors.slice(0, 3).join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Admin (#puntos-ui) ──');
{
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w3 = dom.window;
  const errors = [];
  w3.console.error = (...a) => errors.push(a.map(x => (x && x.stack) || String(x)).join(' '));
  w3.addEventListener('error', (e) => errors.push(e.message));
  const toasts = [];
  w3.toast = (m) => toasts.push(m);
  const tabs = [];
  w3.setTab = (n) => tabs.push(n);
  w3.state = { profile: { role: 'admin' }, settings: {} };
  w3.sb = new Proxy(function () {}, { get: (_, k) => (k === 'then' ? undefined : w3.sb), apply: () => w3.sb });
  w3.eval(read('api-puntos.js'));
  w3.eval(read('admin-puntos.js'));
  const calls = [];
  const AD = {
    settings: { enabled: false, invite: 40, neighbor: 80, cancel: 20, cancelLeadHours: 2, rate: 5, goalTarget: null, goalText: '' },
    reds: [
      { id: 'x1', auxId: 'a1', name: 'Diana Restrepo', residence: 'El Olivar', rewardId: 'mensual', title: '3 días de tu mensualidad', kind: 'billing_days', amount: 3, cost: 400, status: 'pending', note: '', requestedAt: hace(2), decidedAt: null, decisionNote: '', balance: 20 },
      { id: 'x2', auxId: 'a2', name: 'Juan Ríos', residence: 'Llanogrande', rewardId: 'colega', title: 'Traer a un colega gratis', kind: 'guest_seat', amount: 1, cost: 180, status: 'pending', note: 'Para el vuelo del 12', requestedAt: hace(5), decidedAt: null, decisionNote: '', balance: 0 },
    ],
    balances: [
      { auxId: 'a1', name: 'Diana Restrepo', residence: 'El Olivar', balance: 20, earned: 420, invited: 3, invitedDone: 2, pending: 1, code: 'DIANA-OLV' },
      { auxId: 'a2', name: 'Juan Ríos', residence: 'Llanogrande', balance: 0, earned: 180, invited: 0, invitedDone: 0, pending: 1, code: null },
    ],
  };
  const P = w3.ApiPuntos;
  P.adminSettings = async () => clone(AD.settings);
  P.rewards = async () => clone(REWARDS);
  P.adminRedemptions = async (s) => { calls.push(['reds', s]); return clone(s === 'all' ? AD.reds : AD.reds.filter(r => r.status === 'pending')); };
  P.adminBalances = async () => clone(AD.balances);
  P.adminPendingCount = async () => AD.reds.filter(r => r.status === 'pending').length;
  P.adminDecide = async (id, action, note) => { calls.push(['decide', id, action, note]); const r = AD.reds.find(x => x.id === id); r.status = action === 'fulfill' ? 'fulfilled' : 'rejected'; r.decisionNote = note || ''; return { ok: true }; };
  P.adminSaveSettings = async (patch) => { calls.push(['saveSettings', patch]); AD.settings = Object.assign({}, AD.settings, patch); return clone(AD.settings); };
  P.adminSaveReward = async (id, patch) => { calls.push(['saveReward', id, patch]); return Object.assign({}, REWARDS.find(r => r.id === id), patch); };
  P.adminAdjust = async (aux, pts, note) => { calls.push(['adjust', aux, pts, note]); return { ok: true, balance: 20 + pts }; };
  const R = () => w3.document.getElementById('puntos-ui');
  const clk = (el) => el && el.dispatchEvent(new w3.MouseEvent('click', { bubbles: true, cancelable: true }));
  t('window.renderPuntos existe (la consola muestra la entrada)', typeof w3.renderPuntos === 'function');
  w3.renderPuntos();
  await wait(40);
  t('encabezado «Rendio Points» con 2 canjes pendientes', /Rendio Points/.test(R().querySelector('.sh-phead h1').textContent) && R().querySelector('#pt-count').textContent === '2');
  t('estado APAGADO dicho claro, con atajo para encenderlo', R().querySelector('.pt-state.off') && /Apagado/.test(R().querySelector('.pt-state').textContent) && !!R().querySelector('.pt-state [data-v="programa"]'));
  t('4 vistas: Canjes · Programa · Vitrina · Saldos', [...R().querySelectorAll('.pt-tabs button')].map(x => x.textContent.replace(/\s*\d+$/, '')).join('|') === 'Canjes|Programa|Vitrina|Saldos');
  let cards = [...R().querySelectorAll('.pt-card.red')];
  t('Canjes: 2 tarjetas pendientes con costo, fecha y saldo', cards.length === 2 && /400 pts/.test(cards[0].textContent) && /Pendiente/.test(cards[0].textContent));
  t('mensualidad: pista de aplicarlo en Cuentas de cobro', /Cuentas de cobro/.test(cards[0].textContent));
  t('nota del tripulante visible', /Para el vuelo del 12/.test(cards[1].textContent));
  clk(cards[1].querySelector('[data-pt="fulfill"]'));
  await wait(40);
  t('Marcar cumplido → adminDecide(x2, fulfill)', calls.some(c => c[0] === 'decide' && c[1] === 'x2' && c[2] === 'fulfill'));
  cards = [...R().querySelectorAll('.pt-card.red')];
  t('queda 1 pendiente (recarga la lista y el contador)', cards.length === 1 && R().querySelector('#pt-count').textContent === '1');
  clk(cards[0].querySelector('[data-pt="rej-open"]'));
  await wait(10);
  clk(R().querySelector('[data-pt="rej-go"]'));
  await wait(10);
  t('rechazar sin motivo no se manda: pide el motivo', !calls.some(c => c[0] === 'decide' && c[2] === 'reject') && /Escribe el motivo/.test(R().textContent));
  R().querySelector('[data-pt-f="rej-note"]').value = 'Ese mes ya se cobró';
  clk(R().querySelector('[data-pt="rej-go"]'));
  await wait(40);
  t('rechazar con motivo → adminDecide(x1, reject, motivo)', calls.some(c => c[0] === 'decide' && c[1] === 'x1' && c[2] === 'reject' && c[3] === 'Ese mes ya se cobró'));
  t('sin pendientes: «No hay canjes por cumplir»', /No hay canjes por cumplir/.test(R().textContent));
  clk(R().querySelector('.pt-filter [data-v="all"]'));
  await wait(40);
  t('filtro Todos → adminRedemptions("all") y muestra Cumplido/Rechazado', calls.some(c => c[0] === 'reds' && c[1] === 'all') && /Cumplido/.test(R().textContent) && /Rechazado/.test(R().textContent) && /Ese mes ya se cobró/.test(R().textContent));
  // Programa
  clk(R().querySelector('.pt-tabs [data-v="programa"]'));
  await wait(10);
  t('Programa: interruptor apagado + 5 valores + meta', !R().querySelector('[data-pt-f="enabled"]').checked && R().querySelector('[data-pt-f="invite"]').value === '40' && R().querySelector('[data-pt-f="neighbor"]').value === '80'
    && R().querySelector('[data-pt-f="cancel"]').value === '20' && R().querySelector('[data-pt-f="cancelLeadHours"]').value === '2' && R().querySelector('[data-pt-f="rate"]').value === '5' && !!R().querySelector('[data-pt-f="goalText"]'));
  t('la meta advierte no prometer carro fijo', /nada de prometer un carro fijo/.test(R().textContent));
  R().querySelector('[data-pt-f="enabled"]').checked = true;
  R().querySelector('[data-pt-f="invite"]').value = '50';
  R().querySelector('[data-pt-f="goalTarget"]').value = '12';
  clk(R().querySelector('[data-pt="save-settings"]'));
  await wait(20);
  t('meta sin texto: no guarda y lo dice', !calls.some(c => c[0] === 'saveSettings') && /Escribe el texto de la meta/.test(R().textContent));
  R().querySelector('[data-pt-f="enabled"]').checked = true;
  R().querySelector('[data-pt-f="invite"]').value = '50';
  R().querySelector('[data-pt-f="goalTarget"]').value = '12';
  R().querySelector('[data-pt-f="goalText"]').value = 'Entre más vecinos, mejor ruta';
  clk(R().querySelector('[data-pt="save-settings"]'));
  await wait(30);
  const sv = calls.find(c => c[0] === 'saveSettings');
  t('Guardar → adminSaveSettings con enabled, valores y meta', !!sv && sv[1].enabled === true && sv[1].invite === 50 && sv[1].neighbor === 80 && sv[1].cancelLeadHours === 2 && sv[1].goalTarget === 12 && sv[1].goalText === 'Entre más vecinos, mejor ruta');
  t('después de guardar: estado ENCENDIDO y «Guardado»', !!R().querySelector('.pt-state.on') && /Guardado/.test(R().textContent));
  // Vitrina
  clk(R().querySelector('.pt-tabs [data-v="vitrina"]'));
  await wait(10);
  const rw = [...R().querySelectorAll('.pt-card.rw')];
  t('Vitrina: 4 canjes, Directo con «Pronto»', rw.length === 4 && /Pronto/.test(rw[1].querySelector('.pt-tag').textContent));
  rw[0].querySelector('[data-pt-f="cost"]').value = '200';
  clk(rw[0].querySelector('[data-pt="save-reward"]'));
  await wait(20);
  t('Guardar costo → adminSaveReward(colega, {cost:200, enabled:true})', calls.some(c => c[0] === 'saveReward' && c[1] === 'colega' && c[2].cost === 200 && c[2].enabled === true));
  // Saldos
  clk(R().querySelector('.pt-tabs [data-v="saldos"]'));
  await wait(10);
  t('Saldos: 2 tripulantes con saldo, ganados, invitados y código', R().querySelectorAll('.pt-bal').length === 2 && /DIANA-OLV/.test(R().textContent) && /Invitó 2 de 3/.test(R().querySelector('.pt-bal').textContent.replace(/\s+/g, ' ')));
  const s = R().querySelector('[data-pt-f="q"]');
  s.value = 'llano'; s.dispatchEvent(new w3.Event('input', { bubbles: true }));
  await wait(10);
  t('buscar «llano» deja solo a Juan', R().querySelectorAll('.pt-bal').length === 1 && /Juan Ríos/.test(R().querySelector('.pt-bal').textContent));
  const s2 = R().querySelector('[data-pt-f="q"]'); s2.value = ''; s2.dispatchEvent(new w3.Event('input', { bubbles: true }));
  await wait(10);
  clk(R().querySelector('[data-pt="adj-open"][data-id="a1"]'));
  await wait(10);
  R().querySelector('[data-pt-f="adj-pts"]').value = '15';
  clk(R().querySelector('[data-pt="adj-go"]'));
  await wait(10);
  t('ajuste sin nota: no se manda', !calls.some(c => c[0] === 'adjust') && /Escribe por qué ajustas/.test(R().textContent));
  R().querySelector('[data-pt-f="adj-pts"]').value = '15';
  R().querySelector('[data-pt-f="adj-note"]').value = 'Faltó la calificación del 12';
  clk(R().querySelector('[data-pt="adj-go"]'));
  await wait(20);
  t('ajuste con nota → adminAdjust(a1, 15, nota) y saldo nuevo', calls.some(c => c[0] === 'adjust' && c[1] === 'a1' && c[2] === 15 && c[3] === 'Faltó la calificación del 12') && /35/.test(R().querySelector('.pt-bal .pt-bal-n').textContent));
  // Sin 0091
  P.adminSettings = async () => null; P.rewards = async () => null; P.adminRedemptions = async () => null; P.adminBalances = async () => null; P.adminPendingCount = async () => null;
  clk(R().querySelector('[data-pt="refresh"]'));
  await wait(30);
  clk(R().querySelector('.pt-tabs [data-v="canjes"]'));
  await wait(10);
  t('sin 0091: lo dice (canjes y programa), nunca cifras inventadas', /No se pudieron cargar los canjes/.test(R().textContent) && /No se pudo leer el programa/.test(R().textContent) && !R().querySelector('#pt-count'));
  // Enlace del aviso de canje.
  w3.location.hash = '#/puntos';
  w3.dispatchEvent(new w3.HashChangeEvent('hashchange'));
  await wait(10);
  t('#/puntos (aviso de canje) abre la pestaña puntos', tabs.includes('puntos'));
  t('sin errores de consola (admin)', errors.length === 0, errors.slice(0, 3).join(' | '));
}

if (rechazos.length) console.log('\n⚠ rechazos sin atender:\n  ' + rechazos.join('\n  '));
console.log(`\n${ok} ok · ${bad} fallan`);
process.exit(bad ? 1 : 0);
