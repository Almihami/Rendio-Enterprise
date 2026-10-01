// P5 · Pedir y punto (rediseño del auxiliar, 27-sep-2026) — prueba jsdom.
//
// Carga la app real (index.html + auxiliar.js + aux-shell.js + aux-rx-pedir.js +
// aux-residencias.js + aux-privado.js + aux-celebracion.js + api.js de verdad con
// un Supabase FALSO que anota lo que se inserta) con la bandera ENCENDIDA y
// comprueba la aceptación de P5 (plan final §3.8):
//   · una unidad = 4 pasos, dos unidades = 5 (rayas del encabezado y «s/N»);
//   · el paso 1 son dos .rx-type (sin Hotel) y avanza solo a los 260 ms;
//   · cambiar de paso RECREA .rx-step (fwd/bwd); repintar el mismo paso NO
//     (el interruptor es el mismo nodo: su transición corre);
//   · el toque sin arrastre del deslizador llama a AuxCelebracion.prime()
//     DENTRO del clic (espía) y a los 380 ms a createReservation, con bags y
//     con quiet_ride solo en privado (payload real de api.js);
//   · arrastrar pasado el 82 % confirma; un arrastre corto NO (ni con su clic);
//   · escribir la nota no rompe el deslizador (mismo nodo, sin innerHTML);
//   · regreso del mismo día = 2 reservas; pernocta y reserva en firme viajan;
//   · fecha pasada deshabilita el deslizador (y el clic no envía);
//   · la política está antes de confirmar; .axc en «booked»;
//   · «Cambiar» lleva al paso correcto (vuelo, punto, nivel);
//   · el número de vuelo (llegada) cumple el contrato fl-* y parte «AV-9412»;
//   · el interruptor «Trabajo en tierra» (0092) está arriba del paso del vuelo
//     (lo demás del trabajo en tierra: _smoke-tierra-dom.mjs);
//   · camino manual con el aspecto rx (#ax-map, #ax-pin-row, refreshPinRow);
//   · AuxResidencias.pickerHTML({mode:'perfil'}) NO toca auxState.form y guarda
//     con saveMyResidence;
//   · ningún texto prohibido (cifras, nombres de muestra, «Plan B», «24/7»…);
//   · con la bandera apagada, el pedido de siempre (sin .rx-book).
//   · vacaciones (30-sep, «se le cobra la diferencia»): en «Revisa tu traslado»,
//     antes de la política, el aviso rx-note «Este viaje no estaba en tus
//     vacaciones: se suma $V a tu cuenta» que da AuxPagos.vacExtraFor(día, n)
//     (n = 2 con el regreso del mismo día); sin dato, no sale; no bloquea el
//     deslizador; tras pedir, AuxPagos.refresh({force}); y lo mismo en el pedido
//     de siempre (bandera apagada). El cálculo real de vacExtraFor lo prueba
//     _smoke-rx-pagos-dom.mjs; la base, _verify-0094.mjs.
//     (revisión 1-oct) Con la bandera apagada y el AuxPagos de verdad: el aviso
//     sale desde el PRIMER pedido (antes nadie pedía la cuenta y salía recién
//     después de la primera reserva): se pide al entrar a «Revisa y confirma» y
//     se pinta en #ax-vacextra al llegar; sin vacaciones, la caja queda oculta.
//     Ese aviso lo arma AuxPagos (axVacExtraHTML / axVacExtraEnsure): auxiliar.js
//     comparte el ámbito global y no declara nombres nuevos para él.
//
// LO QUE NO CUBRE: jsdom no hace layout ni corre animaciones (no prueba que el
// paso se deslice, que el deslizador se vea en su sitio o que las rayas crezcan;
// eso lo mira el verificador visual contra el diseño), no hay gesto táctil real
// (los pointer* se simulan con MouseEvent y offsetWidth es 0, así que el máximo
// del deslizador cae en el respaldo del diseño, 260 px), no hay audio real (el
// espía solo cuenta el prime), ni Leaflet real (fixtures/fake-leaflet.js), ni el
// servidor (Supabase falso: no se prueban la RLS, los CHECK ni los triggers).
//
//   cd rendio-backend && node scripts/_smoke-rx-pedir-dom.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const FIX = new URL('./fixtures/', import.meta.url).pathname;
const read = f => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d = '') => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d ? ' → ' + d : '')); } };
const wait = (ms = 40) => new Promise(r => setTimeout(r, ms));
const bogDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
const FUTURO = bogDay(Date.now() + 20 * 86400000);
const AYER = bogDay(Date.now() - 86400000);

const RES = [{ id: 'r1', name: 'Olivar Apartamentos', sector: 'Norte', latitude: 6.15, longitude: -75.37 },
  { id: 'r2', name: 'Solare', sector: 'Llanogrande', latitude: 6.11, longitude: -75.42 },
  { id: 'r3', name: 'Cámbulo', sector: 'Norte', latitude: 6.16, longitude: -75.36 }];
const UNA = { residenceId: 'r1', residence: RES[0], unit: 'Torre 3 · 302', residenceId2: null, residence2: null, unit2: '', homeAddress: '', homeLat: null, homeLng: null };
const DOS = { ...UNA, residenceId2: 'r2', residence2: RES[1], unit2: 'Casa 8' };
const SIN_PRIVADO = { aux_min_lead_hours: 6, aux_wait_minutes: 5 };
const CON_PRIVADO = { ...SIN_PRIVADO, aux_private_enabled: true, aux_private_vehicle_id: 'v1', aux_private_price_cop: 150000 };
const PROHIBIDO = [/Carlos Mejía/, /\bLaura\b/, /AV9525/, /Juliana/, /Plan B/, /24\/7/, /en línea/i, /Último cupo/i, /Siempre hay cupo/i,
  /\bkit\b/i, /Preparado/, /Esta noche te avisamos/i, /38 auxiliares/, /\$\s?\d/, /150[.,]000/];

async function boot({ rx = true, settings = SIN_PRIVADO, place = UNA, catalogo = RES } = {}) {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const errors = [];
  w.console.error = (...a) => { errors.push(a.map(String).join(' ')); };
  w.RENDIO_CONFIG = {}; w.toast = () => {};
  w.escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  w.eval(readFileSync(FIX + 'fake-sw.js', 'utf8'));
  w.eval(readFileSync(FIX + 'fake-leaflet.js', 'utf8'));
  w.localStorage.setItem('rendio.aux.rx', rx ? '1' : '0');
  w.localStorage.setItem('rendio.aux.onboarded.p1', '1');
  // Supabase falso: solo lo que usa createReservation (y que las RPC no existan).
  const inserts = [];
  const qb = (table) => {
    const q = {
      _ins: null,
      select() { return q; }, eq() { return q; }, order() { return q; }, in() { return q; }, is() { return q; },
      gte() { return q; }, lte() { return q; }, limit() { return q; }, update() { return q; },
      insert(row) { q._ins = row; return q; },
      maybeSingle: async () => (table === 'auxiliar_profiles' ? { data: { id: 'ap1' }, error: null } : { data: null, error: null }),
      single: async () => { if (q._ins) { inserts.push(JSON.parse(JSON.stringify(q._ins))); return { data: { id: 'res' + inserts.length }, error: null }; } return { data: null, error: null }; },
      then(a, b) { return Promise.resolve({ data: [], error: null }).then(a, b); },
    };
    return q;
  };
  w.sb = {
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }), getSession: async () => ({ data: { session: null } }) },
    from: qb, rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'no existe' } }),
  };
  w.state = { settings: { ...settings } };
  const data = { place, catalogo, saved: [], header: { preferredLevel: null, residenceId: place && place.residenceId, residence: place && place.residence, unit: place && place.unit, residenceId2: place && place.residenceId2, residence2: place && place.residence2, unit2: place && place.unit2 } };
  w.eval(read('api.js'));
  const REAL = w.Api;
  w.Api = {
    createReservation: REAL.createReservation,
    notesUser: REAL.notesUser,
    listMyReservations: async () => [],
    listResidences: async () => data.catalogo,
    getMyAuxiliarPlace: async () => data.place,
    saveMyResidence: async (id) => { data.saved.push(id); return true; },
    getSettings: async () => w.state.settings,
    privateBusyAt: async () => false,
    getMyAuxHeader: async () => data.header,
    listAirlines: async () => null,
    getMyAirlineIata: async () => '',
  };
  // Los mismos archivos que la app (index.html), en su orden; solo cambia la bandera.
  const PANTALLAS = ['aux-rx-inicio.js', 'aux-rx-viajes.js', 'aux-rx-avisos.js', 'aux-rx-viaje.js', 'aux-rx-pedir.js', 'aux-rx-perfil.js',
    'aux-rx-pagos.js', 'aux-rx-puntos.js', 'aux-rx-coord.js', 'aux-rx-vuelo.js'];
  const files = ['aux-rx-ui.js', 'aux-shell.js', 'api-aux.js', 'aux-residencias.js', 'aux-privado.js', 'aux-celebracion.js', 'aux-presentacion.js', ...PANTALLAS, 'auxiliar.js'];
  for (const f of files) w.eval(read(f));
  // El pase del viaje lo pinta P3 (AuxRxInicio.passHTML); si aún no está, un doble.
  if (!(w.AuxRxInicio && typeof w.AuxRxInicio.passHTML === 'function')) {
    w.AuxRxInicio = { passHTML: (tr) => `<button type="button" class="rx-pass" data-test-pass="${tr.id}"></button>` };
  }
  // Espía del audio: ¿se llamó DENTRO del gesto (sincrónico con el clic)?
  const spy = { n: 0, inGesture: [] };
  let gesture = false;
  const realPrime = w.AuxCelebracion.prime;
  w.AuxCelebracion.prime = function () { spy.n++; spy.inGesture.push(gesture); try { return realPrime.apply(this, arguments); } catch (_) { return undefined; } };
  const ui = () => w.document.getElementById('auxiliar-ui');
  const $ = (s) => ui().querySelector(s);
  const click = (s) => { const e = typeof s === 'string' ? $(s) : s; if (!e) throw new Error('no existe: ' + s); gesture = true; try { e.click(); } finally { gesture = false; } };
  const set = (k, v) => { const i = $(`[data-scr="book"]:not(.out) [data-field="${k}"]`) || $(`[data-field="${k}"]`); if (!i) throw new Error('no existe campo ' + k); i.value = v; i.dispatchEvent(new w.Event('input', { bubbles: true })); return i; };
  const ptr = (el, type, x) => { gesture = true; try { el.dispatchEvent(new w.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x })); } finally { gesture = false; } };
  const A = () => w.Auxiliar.state;
  await w.Auxiliar.init({ id: 'p1', full_name: 'Ana Lucía Restrepo Vélez', role: 'auxiliar' });
  await wait(80);
  return { w, dom, ui, $, click, set, ptr, A, inserts, data, spy, errors };
}

const book = (E) => E.$('[data-scr="book"]:not(.out) .rx-book');
const txt = (E) => (book(E) ? book(E).textContent.replace(/\s+/g, ' ') : '');
const kinds = (E) => JSON.stringify(E.w.Auxiliar.kinds());
const stepN = (E) => E.$('[data-scr="book"]:not(.out) .rx-step-n')?.textContent;
const rayas = (E) => E.ui().querySelectorAll('[data-scr="book"]:not(.out) .rx-book-steps i').length;
const cont = (E) => E.$('[data-scr="book"]:not(.out) .ax-cta-bar [data-ax="next"]');
const slide = (E) => E.$('[data-scr="book"]:not(.out) .ax-cta-bar .rx-slide');
function prohibidos(E, donde) {
  const h = E.ui().innerHTML;
  const hit = PROHIBIDO.filter(r => r.test(h)).map(String);
  t('sin textos prohibidos · ' + donde, hit.length === 0, hit.join(', '));
}
async function nuevo(E) {
  E.A().view = 'home'; E.A().tab = 'inicio'; E.w.Auxiliar.rerender(); await wait();
  E.w.Auxiliar.newTrip(); await wait(60);
}
async function aRevisar(E, { type = 'sal', time = '05:10' } = {}) {
  await nuevo(E);
  E.click(`[data-ax="type"][data-type="${type}"]`); await wait(320);
  if (type === 'lle') E.set('flightNum', '9412');
  E.set('date', FUTURO); E.set('time', time);
  while (E.w.Auxiliar.stepKind() !== 'revisar') {
    const c = cont(E); if (!c || c.disabled) throw new Error('trancado en ' + E.w.Auxiliar.stepKind());
    E.click(c); await wait();
  }
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── una unidad: 4 pasos · el paso 1 ──');
let E = await boot();
await nuevo(E);
t('el pedido se pinta en la capa modal data-scr="book"', !!E.$('.rx-layer.modal[data-scr="book"]:not(.out) .rx-book'));
t('4 pasos: tipo, vuelo, nivel, revisar', kinds(E) === '["tipo","vuelo","nivel","revisar"]', kinds(E));
t('4 rayas y «1/4»', rayas(E) === 4 && stepN(E) === '1/4', rayas(E) + ' · ' + stepN(E));
t('las rayas: la 1 «now», el resto vacías', E.$('[data-scr="book"]:not(.out) .rx-book-steps i.now') === E.$('[data-scr="book"]:not(.out) .rx-book-steps i') && !E.$('[data-scr="book"]:not(.out) .rx-book-steps i.done'));
t('la X es rx.pop() del diseño (data-rx="rx-pop")', !!E.$('[data-scr="book"]:not(.out) .rx-book-h .rx-ib[data-rx="rx-pop"]'));
t('dos .rx-type (salida t-h2a, llegada t-a2h) y sin Hotel', !!E.$('.rx-type.t-h2a[data-type="sal"]') && !!E.$('.rx-type.t-a2h[data-type="lle"]') && E.ui().querySelectorAll('.rx-type').length === 2 && !/Hotel/.test(txt(E)));
t('con --d escalonado (0, 1)', E.$('.rx-type.t-h2a').getAttribute('style') === '--d:0' && E.$('.rx-type.t-a2h').getAttribute('style') === '--d:1');
t('la pista de la pernocta queda como rx-note', /pernocta/.test(E.$('[data-scr="book"]:not(.out) .rx-step .rx-note')?.textContent || ''));
t('sin «Continuar» en el paso 1 (avanza solo, como el diseño)', !cont(E));
const head0 = E.$('[data-scr="book"]:not(.out) .rx-book-h'), step0 = E.$('[data-scr="book"]:not(.out) .rx-step');
E.click('[data-ax="type"][data-type="sal"]'); await wait(60);
t('tocar el tipo lo marca YA (.on) sin cambiar de paso', E.$('.rx-type.t-h2a').classList.contains('on') && E.w.Auxiliar.stepKind() === 'tipo');
t('…y el paso NO se recreó (misma key)', E.$('[data-scr="book"]:not(.out) .rx-step') === step0);
await wait(260);
t('a los 260 ms avanza solo al vuelo', E.w.Auxiliar.stepKind() === 'vuelo' && stepN(E) === '2/4', stepN(E));
const step1 = E.$('[data-scr="book"]:not(.out) .rx-step');
t('el paso nuevo es OTRO nodo, con .fwd y .rx-anim', step1 !== step0 && step1.classList.contains('fwd') && step1.classList.contains('rx-anim'));
t('el encabezado es el MISMO nodo (sus rayas animan con transición)', E.$('[data-scr="book"]:not(.out) .rx-book-h') === head0);
t('raya 1 done, raya 2 now; la X pasa a atrás', E.ui().querySelectorAll('[data-scr="book"]:not(.out) .rx-book-steps i.done').length === 1 && E.ui().querySelectorAll('[data-scr="book"]:not(.out) .rx-book-steps i')[1].classList.contains('now') && !!E.$('[data-scr="book"]:not(.out) .rx-book-h .rx-ib[data-ax="back"]'));
prohibidos(E, 'paso 1 y 2');

console.log('\n── la X vuelve a la pestaña de la que se vino ──');
E.A().view = 'viajes'; E.A().tab = 'viajes'; E.w.Auxiliar.rerender(); await wait();
E.w.Auxiliar.newTrip(); await wait(60);
E.click('[data-ax="type"][data-type="lle"]'); await wait(30);
E.click('[data-scr="book"]:not(.out) .rx-book-h [data-rx="rx-pop"]'); await wait(320);
t('X en el paso 1 (con un tipo recién tocado): cierra y vuelve a Viajes, sin avanzar', E.A().view === 'viajes' && !E.$('[data-scr="book"]:not(.out)') && JSON.stringify(E.A().form) === '{}');
await nuevo(E);
E.click('[data-ax="type"][data-type="sal"]'); await wait(320);

console.log('\n── paso del vuelo ──');
t('título «¿Cuándo es tu vuelo?» (salida)', /Cuándo es tu vuelo/.test(txt(E)));
const chips = [...E.ui().querySelectorAll('[data-scr="book"]:not(.out) .rx-chips button[data-ax="date"]')];
t('chips: Hoy, Mañana y dos días con nombre', chips.length === 4 && chips[0].textContent === 'Hoy' && chips[1].textContent === 'Mañana' && /^(dom|lun|mar|mié|jue|vie|sáb) \d+$/.test(chips[2].textContent), chips.map(c => c.textContent).join('|'));
t('«Otro día» con input type=date data-field="date"', !!E.$('[data-scr="book"]:not(.out) .rx-chips .rx-pd-otro input[type="date"][data-field="date"]'));
t('la fecha arranca en Mañana (chip encendido)', chips[1].classList.contains('on'));
t('en la salida NO se pide número de vuelo', !E.$('[data-field="flightNum"]'));
// Trabajo en tierra (0092): el detalle está en _smoke-tierra-dom.mjs; aquí solo
// que el interruptor está arriba del paso y arranca apagado sin viajes.
t('interruptor «Trabajo en tierra» arriba del paso, apagado', E.$('[data-scr="book"]:not(.out) .rx-step > .rx-card[data-rx-key="ground"] [data-ax="toggle"][data-key="groundOps"]:not(.on)') != null && E.A().form.groundOps === false);
t('Continuar deshabilitado sin hora', cont(E) && cont(E).disabled && cont(E).getAttribute('aria-disabled') === 'true');
t('sin hora no hay tarjeta rx-calc', !E.$('[data-scr="book"]:not(.out) .rx-calc'));
const chipsNode = E.$('[data-scr="book"]:not(.out) .rx-chips');
E.click(chips[2]); await wait();
t('tocar un chip lo enciende en el MISMO contenedor (transición, no re-montaje)', E.$('[data-scr="book"]:not(.out) .rx-chips') === chipsNode && E.ui().querySelectorAll('[data-scr="book"]:not(.out) .rx-chips button')[2].classList.contains('on'));
const otroIn = E.set('date', FUTURO);
t('el calendario enciende «Otro día» con la fecha (sin repintar)', E.$('[data-scr="book"]:not(.out) .rx-pd-otro').classList.contains('on') && E.$('[data-scr="book"]:not(.out) .rx-chips') === chipsNode && E.$('[data-scr="book"]:not(.out) .rx-pd-otro input') === otroIn);
const nextBtn = cont(E);
E.set('time', '05:10');
const calc = E.$('[data-scr="book"]:not(.out) .rx-calc');
t('con hora: rx-calc «Estar en MDE» + 05:10 + la recogida se confirma con la ruta', !!calc && /Estar en MDE/.test(calc.textContent) && calc.querySelector('.rx-calc-t').textContent === '05:10' && /confirmamos cuando armemos tu ruta/.test(calc.textContent));
t('Continuar se habilita sin rehacer el botón (#17)', cont(E) === nextBtn && !nextBtn.disabled);
E.set('time', '05:40');
const calc2 = E.$('[data-scr="book"]:not(.out) .rx-calc');
t('otra hora = rx-calc RECREADO (key) con rx-anim', calc2 !== calc && calc2.classList.contains('rx-anim') && calc2.querySelector('.rx-calc-t').textContent === '05:40');
t('#ax-time-hints existe', !!E.$('[data-scr="book"]:not(.out) #ax-time-hints'));
t('tarjeta de opciones: regreso, pernocta y reserva en firme', !!E.$('.rx-card [data-ax="toggle"][data-key="sameDayBack"]') && !!E.$('.rx-card [data-ax="toggle"][data-key="isPernocta"]') && !!E.$('.rx-card [data-ax="toggle"][data-key="isReserva"]'));
t('la reserva en firme arranca encendida', E.$('[data-key="isReserva"]').classList.contains('on'));
const tg = E.$('[data-key="isPernocta"]'), timeIn = E.$('[data-field="time"]');
E.click(tg); await wait();
t('el interruptor cambia en el MISMO nodo (su transición corre)', E.$('[data-key="isPernocta"]') === tg && tg.classList.contains('on') && tg.getAttribute('aria-pressed') === 'true' && E.A().form.isPernocta === true);
t('…y el campo de la hora no se rehízo ni perdió el valor', E.$('[data-field="time"]') === timeIn && timeIn.value === '05:40');
E.click('[data-key="sameDayBack"]'); await wait();
t('regreso del mismo día: aparecen la hora y el vuelo del regreso', !!E.$('[data-field="backTime"]') && !!E.$('[data-field="backFlightNum"]') && !!E.$('#ax-fl-chip-backFlight'));
t('Continuar se apaga hasta llenar el regreso', cont(E).disabled);
E.set('backTime', '19:40'); E.set('backFlightNum', '9413');
t('con el regreso lleno, Continuar se habilita', !cont(E).disabled);
E.set('date', AYER);
t('fecha pasada: aviso «ya pasaron» y Continuar bloqueado', /ya pasaron/.test(E.$('#ax-time-hints').textContent) && cont(E).disabled);
E.set('date', FUTURO);
t('fecha buena: el aviso se va', !/ya pasaron/.test(E.$('#ax-time-hints').textContent) && !cont(E).disabled);
E.click(cont(E)); await wait();
t('Continuar → nivel (3/4), paso nuevo .fwd', E.w.Auxiliar.stepKind() === 'nivel' && stepN(E) === '3/4' && E.$('[data-scr="book"]:not(.out) .rx-step').classList.contains('fwd'));
t('el nivel arranca en compartido', E.A().form.level === 'shared');
t('el paso del nivel trae las tarjetas del módulo del privado', !!E.$('[data-scr="book"]:not(.out) [data-ax="lvl"], [data-scr="book"]:not(.out) [data-ax="lvl-info"]'));
prohibidos(E, 'nivel (primicia)');
E.click('[data-scr="book"]:not(.out) .rx-book-h [data-ax="back"]'); await wait();
t('atrás vuelve al vuelo con .bwd y los datos intactos', E.w.Auxiliar.stepKind() === 'vuelo' && E.$('[data-scr="book"]:not(.out) .rx-step').classList.contains('bwd') && E.$('[data-field="time"]').value === '05:40' && E.$('[data-field="backTime"]').value === '19:40');
E.click(cont(E)); await wait(); E.click(cont(E)); await wait();

console.log('\n── revisar ──');
t('revisar 4/4 con «Revisa tu traslado»', E.w.Auxiliar.stepKind() === 'revisar' && stepN(E) === '4/4' && /Revisa tu traslado/.test(txt(E)));
const rv = E.$('[data-scr="book"]:not(.out) .rx-review');
t('.rx-review con rx-rv-time: día, hora, «estar en MDE» y la recogida por confirmar', !!rv && /05:40/.test(rv.querySelector('.rx-rv-time').textContent) && /estar en MDE/.test(rv.querySelector('.rx-rv-time').textContent) && /La recogida te la confirmamos/.test(rv.querySelector('.rx-rv-time').textContent));
t('fila Vuelo → goto-step vuelo', !!rv.querySelector('.rx-rv-row[data-rx="goto-step"][data-step="vuelo"]'));
t('fila Recogida → donde-cambiar (con el conjunto)', /Olivar Apartamentos/.test(rv.querySelector('.rx-rv-row[data-ax="donde-cambiar"]')?.textContent || ''));
t('fila Nivel → goto-step nivel, «Compartido · Incluido»', /Compartido · Incluido/.test(rv.querySelector('.rx-rv-row[data-step="nivel"]')?.textContent || ''));
t('filas de regreso y pernocta', /Regreso/.test(rv.textContent) && /19:40/.test(rv.textContent) && /Pernocta/.test(rv.textContent));
t('la política está (espera N minutos de Ajustes, cancelar, acompañado)', /El carro espera 5 minutos/.test(txt(E)) && /Puedes cancelar/.test(txt(E)) && /acompañado/.test(txt(E)));
t('maletas: stepper en 0 y nota data-field="notes"', E.$('[data-scr="book"]:not(.out) .rx-step-ctl b')?.textContent === '0' && !!E.$('[data-scr="book"]:not(.out) [data-field="notes"]'));
t('el pie lleva ax-cta-bar y el deslizador (no «Continuar»)', !!slide(E) && !cont(E));
const sl = slide(E), knob = sl.querySelector('.rx-slide-k');
E.click('[data-rx="bags-inc"]'); await wait(); E.click('[data-rx="bags-inc"]'); await wait();
const bagsB = E.$('[data-scr="book"]:not(.out) .rx-step-ctl b');
t('bags-inc ×2 → form.bags 2 y el número se RECREÓ (rxPop)', E.A().form.bags === 2 && bagsB.textContent === '2' && bagsB.classList.contains('rx-anim'));
E.click('[data-rx="bags-dec"]'); E.click('[data-rx="bags-inc"]'); await wait();
const notes = E.$('[data-field="notes"]'); notes.focus();
E.set('notes', 'Timbre 302');
t('escribir la nota no rompe el deslizador (mismo nodo, mismo botón)', slide(E) === sl && sl.querySelector('.rx-slide-k') === knob && E.$('[data-field="notes"]') === notes && E.w.document.activeElement === notes);
E.A().form.date = AYER; E.w.Auxiliar.rerender(); await wait();
t('fecha pasada deshabilita el deslizador (.off, aria, botón disabled)', slide(E).classList.contains('off') && slide(E).getAttribute('aria-disabled') === 'true' && slide(E).querySelector('.rx-slide-k').disabled);
const n0 = E.spy.n, i0 = E.inserts.length;
E.click(slide(E).querySelector('.rx-slide-k')); await wait(450);
t('…y tocarlo no envía nada', E.spy.n === n0 && E.inserts.length === i0);
E.A().form.date = FUTURO; E.w.Auxiliar.rerender(); await wait();
t('fecha buena: vuelve a estar habilitado, mismo nodo', slide(E) === sl && !sl.classList.contains('off') && !knob.disabled);

console.log('\n── «Cambiar» lleva al paso correcto ──');
E.click('.rx-rv-row[data-step="vuelo"]'); await wait();
t('Vuelo → paso del vuelo (.bwd)', E.w.Auxiliar.stepKind() === 'vuelo' && E.$('[data-scr="book"]:not(.out) .rx-step').classList.contains('bwd'));
E.click(cont(E)); await wait(); E.click(cont(E)); await wait();
E.click('.rx-rv-row[data-step="nivel"]'); await wait();
t('Nivel → paso del nivel (pasa por la entrada al paso: nivel elegido)', E.w.Auxiliar.stepKind() === 'nivel' && !!E.A().form.level);
E.click(cont(E)); await wait();
E.click('.rx-rv-row[data-ax="donde-cambiar"]'); await wait();
t('Recogida → paso del punto, ahora 5 pasos (3/5)', E.w.Auxiliar.stepKind() === 'donde' && stepN(E) === '3/5' && rayas(E) === 5, stepN(E));
t('el punto: «Tu punto», buscador #axr-q y camino manual, con aspecto rx', !!E.$('[data-scr="book"]:not(.out) .rx-opt[data-ax="res-pick"][data-id="r1"]') && !!E.$('[data-scr="book"]:not(.out) .rx-input.search #axr-q') && !!E.$('[data-scr="book"]:not(.out) .rx-opt.dashed[data-ax="res-manual"]'));
t('Continuar bloqueado hasta elegir', cont(E).disabled);
const q = E.$('#axr-q'); q.value = 'sol'; q.dispatchEvent(new E.w.Event('input', { bubbles: true })); await wait();
const row = E.$('[data-scr="book"]:not(.out) .axr-list .rx-opt[data-id="r2"]');
t('el buscador filtra en la lista (.rx-opt) sin rehacer el campo', !!row && E.$('#axr-q') === q);
q.value = 'sola'; q.dispatchEvent(new E.w.Event('input', { bubbles: true })); await wait();
t('otra tecla: la fila que sigue es el MISMO nodo (no vuelve a entrar)', E.$('[data-scr="book"]:not(.out) .axr-list .rx-opt[data-id="r2"]') === row);
t('mientras escribe, «Tu punto» se esconde (no se quita)', E.$('[data-scr="book"]:not(.out) [data-rx-key="saved"]').hidden === true && /Busca tu conjunto/.test(E.$('[data-scr="book"]:not(.out) [data-rx-key="search-lbl"]').textContent));
q.focus(); E.w.Auxiliar.rerender(); await wait();
t('un repintado a media búsqueda NO rehace el buscador (mismo nodo, foco y texto)', E.$('#axr-q') === q && E.w.document.activeElement === q && q.value === 'sola' && E.$('[data-scr="book"]:not(.out) .axr-list .rx-opt[data-id="r2"]') === row);
E.click('[data-scr="book"]:not(.out) .rx-opt[data-ax="res-pick"][data-id="r2"]'); await wait();
t('elegir un conjunto muestra el punto verificado con su mapa', E.A().form.residenceId === 'r2' && !!E.$('[data-scr="book"]:not(.out) #axr-map') && /Ubicación verificada/.test(txt(E)) && !cont(E).disabled);
E.click(cont(E)); await wait(); E.click(cont(E)); await wait();
t('de vuelta en revisar (5/5)', E.w.Auxiliar.stepKind() === 'revisar' && stepN(E) === '5/5');
prohibidos(E, 'revisar');

console.log('\n── deslizar: toque sin arrastre → prime() en el gesto → createReservation ──');
E.inserts.length = 0; E.spy.n = 0; E.spy.inGesture.length = 0;
E.A().form.isReserva = false; E.w.Auxiliar.rerender(); await wait();
E.click(slide(E).querySelector('.rx-slide-k'));
t('prime() se llamó una vez y DENTRO del clic (sincrónico)', E.spy.n === 1 && E.spy.inGesture[0] === true, JSON.stringify(E.spy));
t('todavía no se envió nada (espera 380 ms)', E.inserts.length === 0);
t('el deslizador queda en ok con el chulo', slide(E).classList.contains('ok') && !!slide(E).querySelector('.rx-slide-k use[href="#rx-Check"]'));
await wait(200);
t('a los 200 ms aún nada', E.inserts.length === 0);
await wait(300);
t('a los ~380 ms: 2 reservas (ida y regreso del mismo día)', E.inserts.length === 2, E.inserts.length);
const ida = E.inserts[0] || {}, vuelta = E.inserts[1] || {};
t('la ida: salida, con bags 2 y sin quiet_ride (compartido)', ida.direction === 'home_to_airport' && ida.bags === 2 && !('quiet_ride' in ida) && !('service_level' in ida), JSON.stringify(ida));
t('pernocta y reserva en firme viajan (is_overnight true, is_firm false)', ida.is_overnight === true && ida.is_firm === false);
t('la nota viaja', /Timbre 302/.test(ida.notes || ''));
t('el regreso: llegada 19:40, sin pernocta', vuelta.direction === 'airport_to_home' && /T19:40/.test(vuelta.required_arrival_at || '') && vuelta.is_overnight === false);
t('el prime no se repitió en el envío', E.spy.n === 1);
await wait(60);
console.log('\n── traslado pedido (booked) ──');
const bk = E.$('.rx-full[data-scr="booked"] .rx-booked');
t('pantalla completa «booked» con la escena .axc', !!bk && !!bk.querySelector('.axc'));
t('«¡Traslado pedido!» + texto honesto (sin hora de recogida inventada)', /¡Traslado pedido!/.test(bk?.textContent || '') && /Cuando le asignen conductor/.test(bk?.textContent || '') && !/Te recogemos .* a las/.test(bk?.textContent || ''));
t('el pase del viaje (AuxRxInicio.passHTML) y «Listo» (data-ax="home")', !!bk?.querySelector('.rx-booked-pass .rx-pass') && !!bk?.querySelector('.rx-foot [data-ax="home"]'));
prohibidos(E, 'booked');
E.click('.rx-booked [data-ax="home"]'); await wait(300);
t('«Listo» vuelve a inicio', E.A().view === 'home' && !E.$('[data-scr="booked"]'));

console.log('\n── arrastre: pasado el 82 % confirma; corto no ──');
await aRevisar(E);
E.inserts.length = 0; E.spy.n = 0;
let k = slide(E).querySelector('.rx-slide-k');
E.ptr(k, 'pointerdown', 10); E.ptr(k, 'pointermove', 110); E.ptr(k, 'pointerup', 110); E.click(k);
await wait(450);
t('arrastre corto (100 px de 260) + su clic: NO confirma y vuelve a 0', E.inserts.length === 0 && E.spy.n === 0 && /translateX\(0px\)/.test(k.getAttribute('style')));
E.ptr(k, 'pointerdown', 10); E.ptr(k, 'pointermove', 150);
t('durante el arrastre: sin transición y el botón sigue al dedo', /transition: none/.test(k.getAttribute('style')) && /translateX\(140px\)/.test(k.getAttribute('style')));
E.ptr(k, 'pointermove', 250); E.ptr(k, 'pointerup', 250);
t('soltar pasado el 82 %: prime() en el mismo pointerup', E.spy.n === 1 && E.spy.inGesture[0] === true);
E.click(k);
await wait(450);
t('…y una sola reserva (el clic de después no duplica)', E.inserts.length === 1);
await wait(60);

console.log('\n── privado: quiet_ride solo en privado ──');
E.w.state.settings = { ...CON_PRIVADO };
await nuevo(E);
E.click('[data-ax="type"][data-type="sal"]'); await wait(320);
E.set('date', FUTURO); E.set('time', '05:10'); E.click(cont(E)); await wait(60);
const lvlPriv = E.$('[data-scr="book"]:not(.out) [data-ax="lvl"][data-v="private"]');
t('la tarjeta privada se puede elegir', !!lvlPriv);
if (lvlPriv) { E.click(lvlPriv); await wait(); }
t('con privado: «Prefiero silencio» (toggle quietRide)', !!E.$('[data-scr="book"]:not(.out) [data-ax="toggle"][data-key="quietRide"]'));
E.click('[data-scr="book"]:not(.out) [data-ax="toggle"][data-key="quietRide"]'); await wait();
E.click(cont(E)); await wait();
t('fila Nivel «Privado · Con costo» sin cifra', /Privado · Con costo/.test(txt(E)) && !/\$\s?\d/.test(txt(E)));
t('el deslizador dice «Desliza para solicitar»', /Desliza para solicitar/.test(slide(E).textContent));
prohibidos(E, 'revisar privado');
E.inserts.length = 0;
E.click(slide(E).querySelector('.rx-slide-k')); await wait(460);
t('payload privado: service_level private + quiet_ride true', E.inserts[0]?.service_level === 'private' && E.inserts[0]?.quiet_ride === true, JSON.stringify(E.inserts[0]));
await wait(60);
t('booked del privado: «Solicitud enviada»', /Solicitud enviada/.test(E.$('.rx-booked')?.textContent || ''));
// compartido con quietRide colgado del form: no viaja
await aRevisar(E);
E.A().form.quietRide = true;
E.inserts.length = 0;
E.click(slide(E).querySelector('.rx-slide-k')); await wait(460);
t('compartido: sin quiet_ride aunque el form lo tuviera', E.inserts.length === 1 && !('quiet_ride' in E.inserts[0]) && !('service_level' in E.inserts[0]), JSON.stringify(E.inserts[0]));
E.w.state.settings = { ...SIN_PRIVADO };
await wait(60);

console.log('\n── llegada: número de vuelo (contrato fl-*) ──');
await nuevo(E);
E.click('[data-ax="type"][data-type="lle"]'); await wait(320);
t('título «¿Cuál es tu vuelo?» y campo flightNum + chip', /Cuál es tu vuelo/.test(txt(E)) && !!E.$('[data-field="flightNum"]') && !!E.$('#ax-fl-chip-flight') && !!E.$('[data-ax="fl-pick"][data-k="flight"]'));
E.set('date', FUTURO); E.set('time', '22:40');
t('sin número, Continuar bloqueado', cont(E).disabled);
const fl = E.set('flightNum', 'AV-9412');
t('pegar «AV-9412» parte sigla y dígitos', fl.value === '9412' && E.$('#ax-fl-chip-flight').textContent === 'AV' && E.A().form.flight === 'AV9412');
t('y habilita Continuar', !cont(E).disabled);
t('rx-calc de la llegada: «Aterrizas» 22:40', /Aterrizas/.test(E.$('.rx-calc')?.textContent || '') && E.$('.rx-calc .rx-calc-t')?.textContent === '22:40');
E.click('[data-ax="fl-pick"][data-k="flight"]'); await wait();
t('el chip abre las aerolíneas como .rx-fl (fl-set) + «Otra» (fl-other)', E.ui().querySelectorAll('[data-scr="book"]:not(.out) .rx-fl[data-ax="fl-set"]').length >= 4 && !!E.$('[data-scr="book"]:not(.out) .rx-fl[data-ax="fl-other"]'));
E.click('[data-scr="book"]:not(.out) .rx-fl[data-ax="fl-set"][data-iata="LA"]'); await wait();
t('elegir LATAM cambia la sigla del vuelo', E.A().form.flight === 'LA9412' && !E.$('[data-scr="book"]:not(.out) .rx-fl[data-ax="fl-set"]'));
t('sin tarjeta de regreso en la llegada', !E.$('[data-key="sameDayBack"]'));
E.click(cont(E)); await wait(); E.click(cont(E)); await wait();
t('revisar de la llegada: «aterrizas», fila Destino', /aterrizas/.test(E.$('.rx-rv-time').textContent) && /Destino/.test(E.$('.rx-review').textContent) && /LA9412/.test(E.$('.rx-review').textContent));

console.log('\n── camino manual (catálogo no cargó) ──');
E.data.catalogo = null; E.w.AuxResidencias.retry(); await wait(60);
await nuevo(E);
t('sin catálogo: 5 pasos (vuelve el del punto)', kinds(E) === '["tipo","vuelo","donde","nivel","revisar"]', kinds(E));
E.click('[data-ax="type"][data-type="sal"]'); await wait(320);
E.set('date', FUTURO); E.set('time', '05:10'); E.click(cont(E)); await wait();
t('lo dice (rx-note bad) y ofrece reintentar', /No pudimos cargar tus puntos/.test(txt(E)) && !!E.$('[data-scr="book"]:not(.out) [data-ax="res-retry"]') && !!E.$('[data-scr="book"]:not(.out) .rx-note.bad'));
t('dirección a mano con #ax-map y #ax-pin-row', !!E.$('[data-scr="book"]:not(.out) [data-field="address"]') && !!E.$('[data-scr="book"]:not(.out) #ax-map') && !!E.$('[data-scr="book"]:not(.out) #ax-pin-row'));
E.A().form.address = 'Cra 51 #49-06'; E.A().form.lat = 6.15; E.A().form.lng = -75.37;
E.w.AuxRxPedir.refreshPinRow(E.A().form);
t('refreshPinRow: fila visible y botón «Confirmar ubicación»', !E.$('#ax-pin-row').classList.contains('hidden') && !!E.$('[data-scr="book"]:not(.out) [data-ax="pin-confirm"]'));
E.click('[data-scr="book"]:not(.out) [data-ax="pin-confirm"]'); await wait();
t('confirmar: fila ok y Continuar habilitado', E.$('#ax-pin-row').classList.contains('ok') && !E.$('[data-scr="book"]:not(.out) [data-ax="pin-confirm"]') && !cont(E).disabled);
E.data.catalogo = RES; E.w.AuxResidencias.retry(); await wait(60);

console.log('\n── Mi residencia desde Perfil: pickerHTML({mode:"perfil"}) ──');
await nuevo(E);
E.click('[data-ax="type"][data-type="sal"]'); await wait(320);
E.set('date', FUTURO);
const antes = JSON.stringify(E.A().form);
const html = E.w.AuxResidencias.pickerHTML({ mode: 'perfil' });
t('pickerHTML devuelve el selector (rx-opt con data-rx, sin res-* ni data-field)', /data-rx="res-p-pick"/.test(html) && !/data-ax="res-/.test(html) && !/data-field=/.test(html) && !/id="axr-q"/.test(html));
t('pickerHTML no tocó auxState.form', JSON.stringify(E.A().form) === antes);
E.A().view = 'perfil'; E.A().tab = 'perfil'; E.w.Auxiliar.rerender(); await wait();
E.w.AuxShell.push('residence', {}); await wait(60);
t('la pila «residence» muestra el selector con la residencia actual', !!E.$('[data-scr="residence"] .rx-opt.on[data-id="r1"]'));
const pq = E.$('[data-scr="residence"] [data-rx-field="res-q"]');
pq.value = 'cám'; pq.dispatchEvent(new E.w.Event('input', { bubbles: true })); await wait();
t('el buscador del Perfil filtra su propia lista', !!E.$('[data-scr="residence"] [data-rx-res-list] [data-id="r3"]'));
E.click('[data-scr="residence"] [data-rx-res-list] [data-id="r3"]'); await wait(40);
t('elegir no escribe en el pedido', JSON.stringify(E.A().form) === antes);
const save = E.$('[data-scr="residence"] [data-rx="res-p-save"]');
t('«Guardar» habilitado y avisa que el apartamento no cambia aquí', !!save && !save.disabled && /apartamento/.test(E.$('[data-scr="residence"]').textContent));
E.click(save); await wait(350);
t('guarda con saveMyResidence y actualiza la cabecera', E.data.saved[0] === 'r3' && E.w.Auxiliar.header.residenceId === 'r3');
t('…y el pedido sigue sin tocarse', JSON.stringify(E.A().form) === antes);

console.log('\n── dos unidades: 5 pasos ──');
let E2 = await boot({ place: DOS });
await nuevo(E2);
t('5 pasos: tipo, vuelo, donde, nivel, revisar', kinds(E2) === '["tipo","vuelo","donde","nivel","revisar"]' && rayas(E2) === 5 && stepN(E2) === '1/5', kinds(E2));
E2.click('[data-ax="type"][data-type="sal"]'); await wait(320);
E2.set('date', FUTURO); E2.set('time', '05:10'); E2.click(cont(E2)); await wait();
t('«¿De cuál sales?» con dos rx-opt (res-unit) y «Hoy salgo de otro lado»', /De cuál sales/.test(txt(E2)) && E2.ui().querySelectorAll('[data-scr="book"]:not(.out) .rx-opt[data-ax="res-unit"]').length === 2 && !!E2.$('[data-scr="book"]:not(.out) [data-ax="res-otro"]'));
const u2 = E2.$('[data-scr="book"]:not(.out) .rx-opt[data-ax="res-unit"][data-n="2"]');
E2.click(u2); await wait();
t('elegir la unidad 2: se marca en el MISMO nodo (radio con transición)', E2.$('[data-scr="book"]:not(.out) .rx-opt[data-ax="res-unit"][data-n="2"]') === u2 && u2.classList.contains('on') && E2.A().form.residenceId === 'r2' && E2.A().form.residenceUnit === 'Casa 8');
t('con su mapa y Continuar habilitado', !!E2.$('[data-scr="book"]:not(.out) #axr-map') && !cont(E2).disabled);
E2.click(cont(E2)); await wait(); E2.click(cont(E2)); await wait();
t('revisar 5/5 con la unidad en la recogida', stepN(E2) === '5/5' && /Casa 8/.test(E2.$('.rx-review').textContent));
t('sin errores de consola (bandera encendida)', E.errors.length === 0 && E2.errors.length === 0, E.errors.concat(E2.errors).slice(0, 3).join(' | '));

console.log('\n── vacaciones: un viaje de más se avisa antes de confirmar (30-sep) ──');
{
  const E3 = await boot();
  const vx = [];
  const pg = E3.w.AuxPagos;
  t('AuxPagos expone vacExtraFor', !!pg && typeof pg.vacExtraFor === 'function');
  // Doble: lo que diga la base (el cálculo real se prueba en _smoke-rx-pagos-dom.mjs).
  let resp = { trips: 1, of: 1, perTripCOP: 25000, amountCOP: 25000, live: true, text: 'Este viaje no estaba en tus vacaciones: se suma $25.000 a tu cuenta.' };
  pg.vacExtraFor = (day, n) => { vx.push([day, n]); return resp; };
  const refrescos = [];
  pg.refresh = (o) => { refrescos.push(o); return Promise.resolve(); };
  await aRevisar(E3);
  const nota = () => E3.$('[data-scr="book"]:not(.out) [data-rx-key="vacextra"]');
  t('revisar: el aviso rx-note (warn) con el texto que da AuxPagos', !!nota() && nota().classList.contains('rx-note') && nota().classList.contains('warn')
    && nota().textContent.replace(/\s+/g, ' ').trim() === 'Este viaje no estaba en tus vacaciones: se suma $25.000 a tu cuenta.', nota() && nota().outerHTML);
  t('…va justo antes de «Antes de confirmar» (la política)', !!nota() && !!nota().nextElementSibling && nota().nextElementSibling.matches('.rx-pd-pol'));
  t('…se pidió con el día del viaje y 1 viaje', vx.some(([d, n]) => d === FUTURO && n === 1), JSON.stringify(vx));
  t('…no bloquea: el deslizador sigue habilitado', !!slide(E3) && !slide(E3).classList.contains('off'));
  vx.length = 0;
  E3.A().form.sameDayBack = true; E3.A().form.backTime = '19:40'; E3.w.Auxiliar.rerender(); await wait();
  t('con el regreso del mismo día se pide por 2 viajes', vx.some(([d, n]) => d === FUTURO && n === 2), JSON.stringify(vx));
  resp = null; E3.w.Auxiliar.rerender(); await wait();
  t('si AuxPagos no tiene nada que avisar (null), no sale', !nota());
  resp = { trips: 2, of: 2, amountCOP: 50000, live: false, text: 'Estos 2 viajes no estaban en tus vacaciones: se suman $50.000 a tu próximo cobro.' };
  E3.w.Auxiliar.rerender(); await wait();
  t('…y si vuelve a haber, aparece en su lugar (con el texto nuevo)', !!nota() && /se suman \$50\.000 a tu próximo cobro/.test(nota().textContent));
  E3.click(slide(E3).querySelector('.rx-slide-k')); await wait(500);
  t('pedir con el aviso puesto sí envía (2 reservas) y luego refresca Pagos (AuxPagos.refresh({force:true}))', E3.inserts.length === 2 && refrescos.some(o => o && o.force === true), JSON.stringify([E3.inserts.length, refrescos]));
  t('sin errores de consola (vacaciones)', E3.errors.length === 0, E3.errors.slice(0, 3).join(' | '));
}

console.log('\n── bandera APAGADA: el pedido de siempre ──');
const E0 = await boot({ rx: false });
E0.A().view = 'home'; E0.w.Auxiliar.rerender(); await wait();
E0.click('[data-ax="new"]'); await wait(60);
t('sin .rx-book ni capas: el formulario heredado (.ax-form-head, .ax-opt)', !E0.$('.rx-book') && !!E0.$('.ax-form-head') && !!E0.$('.ax-opt.h2a'));
E0.click('[data-ax="type"][data-type="sal"]'); E0.click('[data-ax="next"]'); await wait();
t('los campos son los de siempre (.ax-input), no los rx', !!E0.$('input.ax-input[data-field="time"]') && !E0.$('.rx-input'));
{
  // El resumen del pedido de siempre también avisa el viaje de más (30-sep).
  const pg0 = E0.w.AuxPagos;
  pg0.vacExtraFor = (day, n) => (day === FUTURO && n === 1 ? { trips: 1, amountCOP: 25000, live: true, text: 'Este viaje no estaba en tus vacaciones: se suma $25.000 a tu cuenta.' } : null);
  Object.assign(E0.A().form, { type: 'sal', date: FUTURO, time: '05:10', address: 'Cra 1 # 2-3', locConfirmed: true, sameDayBack: false });
  E0.A().step = E0.w.Auxiliar.kinds().length; E0.w.Auxiliar.rerender(); await wait();
  const h0 = E0.$('[data-ax-vacextra]');
  t('bandera apagada: el resumen trae el aviso (ax-hint) antes de la política', !!h0 && h0.classList.contains('ax-hint') && /Este viaje no estaba en tus vacaciones: se suma \$25\.000 a tu cuenta\./.test(h0.textContent), h0 && h0.outerHTML);
  pg0.vacExtraFor = () => null; E0.w.Auxiliar.rerender(); await wait();
  t('…sin nada que avisar, no sale', !E0.$('[data-ax-vacextra]'));
  // Revisión 1-oct: auxiliar.js comparte el ámbito global; el aviso vive en
  // AuxPagos y auxiliar.js no declara nombres nuevos para él.
  t('sin globals nuevos: auxVacExtraInner/HTML/Ensure no existen y AuxPagos expone axVacExtraHTML y axVacExtraEnsure',
    ['auxVacExtraInner', 'auxVacExtraHTML', 'auxVacExtraEnsure'].every(k => typeof E0.w[k] === 'undefined')
    && typeof pg0.axVacExtraHTML === 'function' && typeof pg0.axVacExtraEnsure === 'function',
    ['auxVacExtraInner', 'auxVacExtraHTML', 'auxVacExtraEnsure'].map(k => k + ':' + typeof E0.w[k]).join(' '));
}
t('sin errores de consola (bandera apagada)', E0.errors.length === 0, E0.errors.slice(0, 3).join(' | '));

console.log('\n── bandera APAGADA: el aviso de vacaciones sale desde el PRIMER pedido (revisión 1-oct) ──');
{
  // Antes, sin el shell nuevo nadie pedía la cuenta de cobro: el aviso salía
  // recién después de la primera reserva de la sesión. Aquí con el AuxPagos de
  // verdad (vacExtraFor real) y una ApiCobro falsa que tarda en contestar.
  const E4 = await boot({ rx: false });
  const dia = (n) => bogDay(Date.parse(FUTURO + 'T12:00:00-05:00') + n * 86400000);
  let llamadas = 0;
  let conVac = true;
  const cuenta = () => ({
    today: bogDay(Date.now()), amountCOP: 170000, perTripCOP: 20000, sector: 'Norte', current: null,
    vacations: {
      current: { periodStart: dia(-10), periodEnd: dia(10), statementId: 'st1', statementLive: true, canChange: true, tripsBooked: 3,
        // Como la base: sin vacaciones (activas ni la foto) freeTrips viene NULL.
        freeTrips: conVac ? 0 : null, extraPerTripCOP: conVac ? 20000 : null,
        vacation: conVac ? { trips: 3, perTripCOP: 20000, totalCOP: 60000, startsOn: dia(-5), endsOn: dia(5) } : null },
      next: null },
    extrasPending: { trips: 0, amountCOP: 0, items: [] },
  });
  E4.w.ApiCobro = {
    myAccount: () => { llamadas++; return new Promise(r => setTimeout(() => r(cuenta()), 30)); },
    methods: async () => [], alerts: async () => [], history: async () => [],
  };
  E4.A().view = 'home'; E4.w.Auxiliar.rerender(); await wait();
  E4.click('[data-ax="new"]'); await wait(60);
  Object.assign(E4.A().form, { type: 'sal', date: FUTURO, time: '05:10', address: 'Cra 1 # 2-3', locConfirmed: true, sameDayBack: false });
  E4.A().step = E4.w.Auxiliar.kinds().length; E4.w.Auxiliar.rerender();
  const caja = () => E4.$('#ax-vacextra');
  t('al entrar a «Revisa y confirma» se pide la cuenta (aún sin ella: la caja del aviso está, oculta y vacía)', llamadas === 1 && !!caja() && caja().hidden === true && !E4.$('[data-ax-vacextra]'), JSON.stringify([llamadas, caja() && caja().outerHTML]));
  await wait(90);
  const h4 = E4.$('[data-ax-vacextra]');
  t('…al llegar la cuenta, el aviso aparece EN SU LUGAR sin haber pedido nada antes', !!h4 && caja().hidden === false && h4.classList.contains('ax-hint')
    && h4.textContent.replace(/\s+/g, ' ').trim() === 'Este viaje no estaba en tus vacaciones: se suma $20.000 a tu cuenta.', caja() && caja().outerHTML);
  t('…y va justo antes de la política («Antes de confirmar»)', !!caja() && !!caja().nextElementSibling && /Antes de confirmar/.test(caja().nextElementSibling.textContent || ''));
  E4.w.Auxiliar.rerender(); await wait(20);
  t('repintar el resumen: el aviso sale de una vez y la cuenta fresca no se vuelve a pedir', !!E4.$('[data-ax-vacextra]') && caja().hidden === false && llamadas === 1, llamadas);
  conVac = false; await E4.w.AuxPagos.refresh({ force: true }); E4.w.Auxiliar.rerender(); await wait(60);
  t('sin vacaciones en ese cobro: la caja queda oculta y sin aviso (nada inventado)', !!caja() && caja().hidden === true && !E4.$('[data-ax-vacextra]'));
  t('sin errores de consola (aviso del primer pedido)', E4.errors.length === 0, E4.errors.slice(0, 3).join(' | '));
}

console.log(`\n${ok}/${ok + bad} pasaron${bad ? ' · ' + bad + ' FALLARON' : ''}`);
console.log('NO cubierto: layout y animación real (jsdom), gesto táctil real, audio real, Leaflet real, servidor (RLS/CHECK/triggers).');
process.exit(bad ? 1 : 0);
