// P10 · CONDUCTOR Y ADMIN del rediseño del auxiliar (27-sep-2026) — prueba jsdom.
//
// Carga index.html real y, en ventanas separadas, los módulos de P10 con la API
// simulada (ninguna llamada sale a la red: window.sb es un doble que anota):
//   · admin-coordinacion.js: bandeja (crewThreadsAdmin), abrir un hilo (crewList
//     + crewMarkRead), el traslado como contexto con enlace #/reservas?chat=,
//     responder (crewSend, con y sin contexto, aviso honesto si no sonó, fallo
//     que devuelve el texto), teléfono y horario (getOpsContact/setOpsContact),
//     estados honestos (sin 0088, vacía), sondeo que se frena, y el enlace
//     profundo #/coordinacion?aux= (con la app abierta y en frío; el del
//     tripulante no se toca);
//   · driver-rutas.js: chips de maletas (#rx-Briefcase), «Prefiere silencio»
//     solo en privado aprobado, punto de encuentro, «Pídele el código» en la
//     fase de llegada (y los códigos en JMC para una llegada), push de llegada
//     con «Tu código es …», URLs /#/viaje?r= en los avisos y en el chat;
//   · admin-privados.js: «Pidió silencio» y push a /#/viaje?r=;
//   · admin-reservas.js: maletas y silencio en la fila, push de cancelación del
//     tripulante a /#/viaje?r= (el del conductor sigue en '/');
//   · admin-chat.js: la respuesta del jefe lleva url /#/viaje?r=;
//   · admin-flota.js: campo Color (solo si la base tiene vehicles.color);
//   · admin-rutas.js: los dos avisos al tripulante van a /#/viajes (lectura del
//     fuente: el módulo entero necesita el tablero de rutas).
//
// LO QUE NO CUBRE: jsdom no hace layout (no prueba que bandeja e hilo quepan
// lado a lado en escritorio ni el apilado en 390 px, ni que los chips del
// conductor no se amontonen), no hay Leaflet (el mapa de ejecución no se pinta),
// ni push real (notify/sendPush son dobles), ni Supabase/RLS real (0086/0088 se
// prueban en sus _verify), ni animaciones (este paquete no agrega ninguna).
//
//   cd rendio-backend && node scripts/_smoke-rx-admin-coord-dom.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const rechazos = [];
process.on('unhandledRejection', (e) => { rechazos.push((e && e.stack ? e.stack.split('\n').slice(0, 2).join(' · ') : String(e))); });
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null && d !== '' ? ' → ' + d : '')); } };
const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));
const PROHIBIDOS = ['Carlos Mejía', 'AV9525', 'Juliana', 'Plan B', '24/7', 'en línea', 'Último cupo', 'Siempre hay cupo',
  'Esta noche te avisamos', '38 auxiliares', '4827'];
const prohibidos = (html) => { const txt = html.replace(/<[^>]+>/g, ' '); return PROHIBIDOS.filter(p => txt.includes(p)); };

function boot(url) {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: url || 'http://localhost/' });
  const w = dom.window;
  const toasts = [];
  w.RENDIO_CONFIG = {}; w.toast = (m) => toasts.push(String(m)); w.L = undefined;
  w.escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  w.$ = (s) => w.document.querySelector(s); w.$$ = (s) => w.document.querySelectorAll(s);
  w.alert = (m) => toasts.push('ALERT ' + m);
  w.Element.prototype.scrollIntoView = function () {};   // jsdom no lo trae
  w.confirm = () => true;
  const errores = [];
  w.addEventListener('error', (e) => errores.push(e.message));
  return { w, toasts, errores };
}
// Doble de supabase-js para las consultas sueltas (.from().select().in()/.is()).
function fakeSb(tablas) {
  const log = [];
  return {
    log,
    from(tabla) {
      const q = { tabla, cols: null, filtros: [] };
      const res = () => {
        const r = tablas[tabla];
        if (typeof r === 'function') return r(q);
        return r || { data: null, error: { code: '42P01', message: 'no existe' } };
      };
      const chain = {
        select(c) { q.cols = c; log.push({ tabla, cols: c }); return chain; },
        in(col, v) { q.filtros.push(['in', col, v]); return chain; },
        is(col, v) { q.filtros.push(['is', col, v]); return chain; },
        eq(col, v) { q.filtros.push(['eq', col, v]); return chain; },
        then(ok, ko) { return Promise.resolve(res()).then(ok, ko); },
      };
      return chain;
    },
  };
}

const HOY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
const hace = (min) => new Date(Date.now() - min * 60000).toISOString();

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── admin-coordinacion.js · bandeja, hilo y respuesta ──');
{
  const { w, toasts, errores } = boot();
  const THREADS = [
    { auxId: 'A1', profileId: 'P1', name: 'Marta Ríos', phone: '300 111 2233', residence: 'El Olivar', sector: 'Rionegro',
      lastBody: '¿El carro ya salió?', lastRole: 'auxiliar', lastAt: hace(3), lastReservationId: 'R1', unread: 2, total: 3 },
    { auxId: 'A2', profileId: 'P2', name: 'Diego Toro', phone: '', residence: '', sector: '',
      lastBody: 'Listo, gracias', lastRole: 'admin', lastAt: hace(60 * 30), lastReservationId: null, unread: 0, total: 4 },
  ];
  const MSGS = {
    A1: [
      { id: 'm1', role: 'auxiliar', mine: false, body: 'Buenas, una pregunta', at: hace(20), read: false, readAt: null, reservation: null },
      { id: 'm2', role: 'admin', mine: true, body: 'Dime', at: hace(15), read: true, readAt: hace(14), reservation: null },
      { id: 'm3', role: 'auxiliar', mine: false, body: '¿El carro ya salió? <img src=x onerror=alert(1)>', at: hace(3), read: false, readAt: null,
        reservation: { id: 'R1', type: 'sal', date: HOY, time: '05:30' } },
    ],
    A2: [{ id: 'n1', role: 'admin', mine: true, body: 'Listo, gracias', at: hace(60 * 30), read: false, readAt: null, reservation: null }],
  };
  const calls = [];
  let threadsResp = () => THREADS.map(x => ({ ...x }));
  let sendResp = async () => ({ id: 'new', recipients: ['P1'], notified: true });
  let contact = { phone: '', hours: '' };
  w.ApiAux = {
    crewThreadsAdmin: async () => { calls.push(['threads']); return threadsResp(); },
    crewList: async (aux) => { calls.push(['list', aux]); return (MSGS[aux] || []).map(m => ({ ...m })); },
    crewMarkRead: async (aux) => { calls.push(['read', aux]); (MSGS[aux] || []).forEach(m => { if (m.role === 'auxiliar') m.read = true; }); return 2; },
    crewSend: async (body, opts) => {
      calls.push(['send', body, opts]);
      const r = await sendResp(body, opts);
      if (r && r.id) MSGS[opts.auxId].push({ id: 'x' + MSGS[opts.auxId].length, role: 'admin', mine: true, body, at: new Date().toISOString(), read: false,
        reservation: opts.reservationId ? { id: opts.reservationId, type: 'sal', date: HOY, time: '05:30' } : null });
      return r;
    },
    getOpsContact: async () => { calls.push(['contact']); return contact ? { ...contact } : null; },
    setOpsContact: async (p) => { calls.push(['setContact', p]); contact = { ...contact, ...p }; return true; },
  };
  const tabs = [];
  w.state = { profile: { role: 'admin' }, activeTab: 'consola' };
  w.setTab = (name) => {
    tabs.push(name); w.state.activeTab = name;
    w.document.querySelectorAll('section[data-panel]').forEach(s => s.classList.toggle('hidden', s.dataset.panel !== name));
    if (name === 'coordinacion') w.renderCoordinacion(); else if (w.stopCoordTimer) w.stopCoordTimer();
  };
  w.eval(read('admin-coordinacion.js'));
  t('publica renderCoordinacion y stopCoordTimer (y nada más suelto)', typeof w.renderCoordinacion === 'function' && typeof w.stopCoordTimer === 'function' && typeof w.coordFocus === 'undefined');

  const ui = () => w.document.getElementById('coordinacion-ui');
  const txt = () => ui().textContent.replace(/\s+/g, ' ');
  w.setTab('coordinacion'); await wait(60);
  const rows = () => [...ui().querySelectorAll('.co-row')];
  t('pinta un renglón por hilo, en el orden de la base', rows().length === 2 && /Marta Ríos/.test(rows()[0].textContent) && /Diego Toro/.test(rows()[1].textContent), rows().length);
  t('el hilo con mensajes nuevos lleva globo y marca', rows()[0].classList.contains('unread') && rows()[0].querySelector('.co-badge')?.textContent === '2');
  t('el contador del encabezado suma lo sin leer', w.document.getElementById('co-count').textContent === '2');
  t('el último mensaje del jefe sale como «Coordinación: …»', /Coordinación: Listo, gracias/.test(rows()[1].textContent));
  t('residencia · sector del tripulante', /El Olivar · Rionegro/.test(rows()[0].textContent));
  t('sin hilo abierto no hay hilo pintado (celular) y dice «Elige un hilo»', !w.document.getElementById('co-grid').classList.contains('has-open') && /Elige un hilo/.test(txt()));

  // Teléfono y horario vacíos: honesto, abierto para cargarlos.
  const card = ui().querySelector('.co-contact');
  t('sin teléfono ni horario: lo dice y deja el formulario abierto', card && card.open && /Sin teléfono ni horario: el tripulante no ve ninguno/.test(card.textContent));

  // Abrir un hilo.
  rows()[0].click(); await wait(60);
  t('abrir pide ese hilo (crewList A1)', calls.some(c => c[0] === 'list' && c[1] === 'A1'));
  t('y lo marca leído para el equipo (crewMarkRead A1)', calls.some(c => c[0] === 'read' && c[1] === 'A1'));
  t('el globo se apaga y el contador baja', !rows()[0].querySelector('.co-badge') && w.document.getElementById('co-count').textContent === '0');
  t('el hilo queda abierto (has-open) con su encabezado', w.document.getElementById('co-grid').classList.contains('has-open') && /Marta Ríos/.test(w.document.getElementById('co-th-head').textContent));
  const tel = w.document.querySelector('#co-th-head a[href^="tel:"]');
  t('teléfono del tripulante como enlace tel:', tel && tel.getAttribute('href') === 'tel:3001112233', tel && tel.getAttribute('href'));
  const bubs = [...w.document.querySelectorAll('#co-msgs .co-msg')];
  // 15-oct-2026: como en cualquier chat, sin rótulo en cada burbuja; quién es
  // quién lo dice el lado (clase) y el campo de escribir es un textarea.
  t('3 burbujas: tripulante a la izquierda, Coordinación a la derecha, sin rótulo', bubs.length === 3 && bubs[0].classList.contains('their') && bubs[1].classList.contains('mine') && !bubs[1].querySelector('em') && !/TRIPULANTE|Tripulante/.test(bubs[0].textContent));
  t('el campo de escribir es un textarea que crece (Enter envía)', w.document.getElementById('co-input').tagName === 'TEXTAREA');
  t('«Leído» solo en lo del jefe que el tripulante ya leyó', /Leído/.test(bubs[1].textContent) && !/Leído/.test(bubs[0].textContent));
  t('el texto del tripulante se escapa (sin <img> vivo)', !w.document.querySelector('#co-msgs img') && /<img src=x/.test(bubs[2].textContent));
  const ctxA = bubs[2].querySelector('a.co-msg-ctx');
  t('el mensaje con traslado trae enlace a su chat #/reservas?chat=R1', ctxA && ctxA.getAttribute('href') === '#/reservas?chat=R1', ctxA && ctxA.getAttribute('href'));
  t('el contexto dice tipo, día y hora', ctxA && /Salida del .+ · 05:30/.test(ctxA.textContent), ctxA && ctxA.textContent);
  t('separador de día «Hoy»', /Hoy/.test(w.document.getElementById('co-msgs').textContent));
  const ctxBar = w.document.getElementById('co-ctx');
  t('la respuesta va con el traslado del último mensaje como contexto', ctxBar.classList.contains('on') && /Sobre: Salida del/.test(ctxBar.textContent));

  // Responder.
  const input = w.document.getElementById('co-input');
  t('el campo invita a escribirle por su nombre', /Marta/.test(input.placeholder), input.placeholder);
  input.value = '  Ya va en camino  ';
  w.document.getElementById('co-send').click(); await wait(80);
  const s1 = calls.filter(c => c[0] === 'send')[0];
  t('responder llama crewSend(texto, {auxId, reservationId})', s1 && s1[1] === 'Ya va en camino' && s1[2].auxId === 'A1' && s1[2].reservationId === 'R1', JSON.stringify(s1));
  t('y avisa que se envió', toasts.includes('Mensaje enviado.'), toasts.join(' | '));
  t('el campo queda vacío y la burbuja nueva está en el hilo', input.value === '' && /Ya va en camino/.test(w.document.getElementById('co-msgs').textContent));
  t('el nodo del campo es el mismo (no se repinta encima de lo escrito)', w.document.getElementById('co-input') === input);

  // Sin contexto.
  w.document.querySelector('#co-ctx button[data-co="ctx-off"]').click(); await wait();
  t('«Quitar» saca el contexto', !w.document.getElementById('co-ctx').classList.contains('on'));
  input.value = 'Otra cosa';
  sendResp = async () => ({ id: 'n2', recipients: ['P1'], notified: false });
  const ev = new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
  input.dispatchEvent(ev); await wait(80);
  const s2 = calls.filter(c => c[0] === 'send')[1];
  t('Enter también envía, y sin contexto no manda reserva', s2 && s2[1] === 'Otra cosa' && !s2[2].reservationId, JSON.stringify(s2));
  t('si no le sonó, lo dice (no finge «enviado» a secas)', toasts.some(x => /no tiene notificaciones activadas/.test(x)), toasts.join(' | '));

  // Fallo: devuelve el texto y quita la burbuja.
  sendResp = async () => { throw new Error('El mensaje es demasiado largo (máximo 500 caracteres)'); };
  input.value = 'Esto falla';
  w.document.getElementById('co-send').click(); await wait(80);
  t('si falla, el texto vuelve al campo y la burbuja se quita', input.value === 'Esto falla' && !/Esto falla/.test(w.document.getElementById('co-msgs').textContent));
  t('y muestra el error del servidor', toasts.some(x => /demasiado largo/.test(x)));
  sendResp = async () => null;
  w.document.getElementById('co-send').click(); await wait(80);
  t('sin 0088 (crewSend null) tampoco se pierde el texto', input.value === 'Esto falla' && toasts.some(x => /todavía no tiene Coordinación/.test(x)));
  input.value = '';

  // Teléfono y horario.
  w.document.getElementById('co-phone').value = '604 555 0101';
  w.document.getElementById('co-hours').value = 'Lun a dom · 4:00 a. m. a 10:00 p. m.';
  ui().querySelector('[data-co="contact-save"]').click(); await wait(60);
  const sc = calls.find(c => c[0] === 'setContact');
  t('guardar llama setOpsContact({phone, hours})', sc && sc[1].phone === '604 555 0101' && sc[1].hours === 'Lun a dom · 4:00 a. m. a 10:00 p. m.', JSON.stringify(sc));
  t('el resumen muestra lo guardado', /Teléfono 604 555 0101 · Horario Lun a dom/.test(ui().querySelector('.co-contact summary').textContent));
  w.ApiAux.setOpsContact = async () => { throw new Error('Solo un administrador puede cambiar el contacto de Coordinación'); };
  ui().querySelector('.co-contact').open = true;
  ui().querySelector('[data-co="contact-save"]').click(); await wait(60);
  t('si no puede guardar, dice por qué', /Solo un administrador/.test(w.document.getElementById('co-cstate').textContent));

  // Volver a la bandeja.
  ui().querySelector('[data-co="close"]').click(); await wait();
  t('«Volver» cierra el hilo', !w.document.getElementById('co-grid').classList.contains('has-open'));

  // Sondeo: se frena al salir.
  const antes = calls.filter(c => c[0] === 'threads').length;
  w.setTab('consola'); await wait(5400);
  t('al salir de la pestaña el sondeo se frena', calls.filter(c => c[0] === 'threads').length === antes);
  w.setTab('coordinacion'); await wait(5400);
  t('adentro consulta cada 5 s', calls.filter(c => c[0] === 'threads').length >= antes + 2);
  w.stopCoordTimer();

  t('sin textos prohibidos (24/7, Juliana, en línea…)', prohibidos(ui().innerHTML).length === 0, prohibidos(ui().innerHTML).join(','));
  t('sin errores de script', errores.length === 0, errores.join(' | '));

  // Estados honestos.
  threadsResp = () => null;
  ui().innerHTML = ''; w.setTab('coordinacion'); await wait(60);
  t('sin 0088 / sin red: «No se pudo cargar la bandeja» + Reintentar, sin hilos inventados', /No se pudo cargar la bandeja/.test(txt()) && !!ui().querySelector('[data-co="reload"]') && !rows().length);
  threadsResp = () => [];
  ui().querySelector('[data-co="reload"]').click(); await wait(60);
  t('bandeja vacía: lo dice', /Ningún tripulante ha escrito todavía/.test(txt()));
  w.ApiAux.getOpsContact = async () => null;
  ui().querySelector('[data-co="refresh"]').click(); await wait(60);
  t('si no se puede leer el contacto, no muestra un formulario engañoso', /No se pudo leer el teléfono y el horario/.test(txt()) && !w.document.getElementById('co-phone'));
  w.stopCoordTimer();
}

console.log('\n── admin-coordinacion.js · enlace profundo #/coordinacion?aux= ──');
{
  // Con la app abierta: el push solo cambia el hash.
  const { w } = boot();
  const calls = [];
  w.ApiAux = {
    crewThreadsAdmin: async () => [{ auxId: 'A9', name: 'Sara Gil', lastBody: 'Hola', lastRole: 'auxiliar', lastAt: hace(1), unread: 1, total: 1 }],
    crewList: async (a) => { calls.push(['list', a]); return []; }, crewMarkRead: async () => 0, getOpsContact: async () => ({ phone: '', hours: '' }),
  };
  const tabs = [];
  w.state = { profile: { role: 'admin' }, activeTab: 'consola' };
  w.setTab = (n) => { tabs.push(n); w.state.activeTab = n; w.document.querySelectorAll('section[data-panel]').forEach(s => s.classList.toggle('hidden', s.dataset.panel !== n)); if (n === 'coordinacion') w.renderCoordinacion(); else w.stopCoordTimer(); };
  w.eval(read('admin-coordinacion.js'));
  w.location.hash = '#/coordinacion?aux=A9'; await wait(80);
  t('jefe con la app abierta: abre Coordinación en el hilo del push', tabs.includes('coordinacion') && calls.some(c => c[1] === 'A9'));
  t('y consume el hash (un refresco no lo reabre)', !/coordinacion/.test(w.location.hash), w.location.hash);
  t('el hilo del push queda abierto', w.document.getElementById('co-grid').classList.contains('has-open'));
  w.stopCoordTimer();

  // El tripulante también usa #/coordinacion (aux-shell): no se toca.
  w.state.profile.role = 'auxiliar'; tabs.length = 0;
  w.location.hash = '#/coordinacion?r=R1'; await wait(80);
  t('tripulante: el hash queda para aux-shell', tabs.length === 0 && /coordinacion/.test(w.location.hash));
}
{
  // En frío: el hash ya está al cargar; core entra después y cae a la consola.
  const { w } = boot('http://localhost/#/coordinacion?aux=A5');
  const calls = [];
  w.ApiAux = {
    crewThreadsAdmin: async () => [], crewList: async (a) => { calls.push(a); return []; }, crewMarkRead: async () => 0,
    getOpsContact: async () => ({ phone: '', hours: '' }),
  };
  const tabs = [];
  w.state = { profile: null, activeTab: 'schedule' };
  w.setTab = (n) => { tabs.push(n); w.state.activeTab = n; w.document.querySelectorAll('section[data-panel]').forEach(s => s.classList.toggle('hidden', s.dataset.panel !== n)); if (n === 'coordinacion') w.renderCoordinacion(); else w.stopCoordTimer(); };
  w.eval(read('admin-coordinacion.js'));
  await wait(300);
  w.state.profile = { role: 'admin' };   // sesión lista, core todavía cargando datos
  await wait(600);
  t('en frío no se adelanta a core (sigue en la pestaña de arranque)', tabs.length === 0, tabs.join(','));
  w.setTab('consola');                    // core.enterApp: applyDeepLink → false → consola
  await wait(600);
  t('cuando core entra a la consola, abre Coordinación en el hilo', tabs.join(',') === 'consola,coordinacion' && calls.includes('A5'), tabs.join(',') + ' / ' + calls.join(','));
  t('y el hash queda limpio', !/coordinacion/.test(w.location.hash));
  w.stopCoordTimer();
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── driver-rutas.js (ruta v2) · lo que el tripulante dijo, el código, los avisos y las confirmaciones ──');
async function driverRun(conSprite) {
  const { w, toasts, errores } = boot();
  if (conSprite) w.eval(read('aux-rx-ui.js'));
  const notifs = [], stops = [], chats = [], boards = [], apt = [], aptNo = [], undos = [];
  w.notify = (ids, title, body, url) => notifs.push({ ids, title, body, url });
  // GPS de mentira: el módulo guarda el callback de watchPosition y la prueba lo llama.
  let gpsCb = null;
  Object.defineProperty(w.navigator, 'geolocation', { configurable: true, value: { watchPosition(cb) { gpsCb = cb; return 1; }, clearWatch() {} } });
  const gps = async (lat, lng) => { if (gpsCb) gpsCb({ coords: { latitude: lat, longitude: lng, heading: null, speed: null } }); await wait(30); };
  const pickup = (o) => Object.assign({ kind: 'pickup', lat: 6.15, lng: -75.37, addr: 'Cra 1 #2-3', unit: '', flight: '', dl: '05:30', phone: '300 000 0001',
    notes: '', bags: null, quiet: false, meetCode: '', meetingPoint: '', level: 'shared', privateStatus: null, stopStatus: 'pending', pickup: '04:50', eta: '' }, o);
  const V = [{ id: 'V1', type: 'sal', start: '04:40', startAt: HOY + 'T04:40:00-05:00', done: false, assignmentId: 'RA1', day: HOY, legs: [
    pickup({ name: 'Marta Ríos', reservationId: 'R1', auxProfileId: 'P1', bags: 2, quiet: true, level: 'private', privateStatus: 'approved', meetCode: '0613', meetingPoint: 'Portería 2 <b>' }),
    pickup({ name: 'Diego Toro', reservationId: 'R2', auxProfileId: 'P2', bags: 0, quiet: true, level: 'private', privateStatus: 'requested', meetCode: '77', lat: 6.152 }),
    pickup({ name: 'Ana <i>Paz</i>', reservationId: 'R3', auxProfileId: 'P3', notes: 'Timbre <b>2</b>', lat: 6.154 }),
    { kind: 'airport', name: 'Aeropuerto JMC', addr: 'Terminal', lat: 6.17, lng: -75.42 },
  ] }, { id: 'V2', type: 'lle', start: '14:00', startAt: HOY + 'T14:00:00-05:00', done: false, assignmentId: 'RA2', day: HOY, legs: [
    { kind: 'airport', name: 'Aeropuerto JMC', addr: 'Terminal', lat: 6.17, lng: -75.42 },
    Object.assign(pickup({ name: 'Luis Mora', reservationId: 'R4', auxProfileId: 'P4', meetCode: '3391', eta: '14:40' }), { kind: 'dropoff' }),
    Object.assign(pickup({ name: 'Eva Sol', reservationId: 'R5', auxProfileId: 'P5', meetCode: '', eta: '15:00', lat: 6.16 }), { kind: 'dropoff' }),
  ] }];
  w.Api = {
    listMyVueltasForDriver: async () => JSON.parse(JSON.stringify(V)),
    getMyDriverProfileId: async () => 'DP1',
    driverSetStopStatus: async (rid, st) => { stops.push([rid, st]); },
    countUnreadMessages: async () => ({}),
    listReservationMessages: async () => [],
    markReservationMessagesRead: async () => 0,
    sendReservationMessage: async (rid, body, opts) => { chats.push({ rid, body, opts }); return { notified: true, recipients: ['P1'] }; },
    sendDriverLocation: async () => {},
    // 0097: la base valida el código; la app también, para responder al instante.
    driverBoardWithCode: async (rid, code, sin) => {
      boards.push([rid, code, !!sin]);
      const real = { R1: '0613', R2: '77', R4: '3391' }[rid] || '';
      if (!sin && real && code !== real) { const e = new Error('El código no coincide'); e.hint = 'codigo_incorrecto'; throw e; }
      return { ok: true, verificado: !sin };
    },
    driverMarkAirportArrival: async (ra) => { apt.push(ra); return 2; },
    driverAirportNoShow: async (rid) => { aptNo.push(rid); },
    driverAirportUndo: async (rid) => { undos.push(rid); return 'no_show'; },
    driverNearStop: async () => true,
  };
  w.state = { settings: { aux_wait_minutes: 5 }, profile: { role: 'driver' } };
  w.eval(read('driver-rutas.js'));
  const root = () => w.document.getElementById('driver-ruta-root');
  await w.DriverRutas.open({ id: 'pD', full_name: 'Jorge Arango', role: 'driver' }); await wait(60);
  const click = async (sel, ms = 60) => { const el = root().querySelector(sel); if (el) el.click(); await wait(ms); return !!el; };
  await click('.rt-hero [data-rt="detail"][data-v="V1"]', 120);
  const stopsEls = [...root().querySelectorAll('#rt-layers .rt-stop')];
  const txt = (e) => (e ? e.textContent.replace(/\s+/g, ' ') : '');
  return { w, toasts, errores, notifs, stops, chats, boards, apt, aptNo, undos, root, click, gps, stopsEls, s1: txt(stopsEls[0]), s2: txt(stopsEls[1]), s3: txt(stopsEls[2]) };
}
{
  const D = await driverRun(true);
  const { root, click, gps, notifs, stops, chats, boards, apt, aptNo, undos, w } = D;
  const top = () => [...root().querySelectorAll('#rt-layers > .rx-layer:not(.out)')].pop();
  const sheet = () => ((top() && top().querySelector('.rt-xs')) || { textContent: '' }).textContent.replace(/\s+/g, ' ');
  const hoja = () => (root().querySelector('#rt-sheet-host .rx-sheet') || { textContent: '' }).textContent.replace(/\s+/g, ' ');
  const teclea = async (sel, val, ms = 80) => { const el = root().querySelector(sel); if (!el) return false; el.value = val; el.dispatchEvent(new w.Event('input', { bubbles: true })); await wait(ms); return true; };
  t('Mi día: título, «Tu siguiente vuelta» y la hora de V1', /Mi día/.test(root().textContent) && /Tu siguiente vuelta/.test(root().textContent) && /04:40/.test(root().textContent));
  t('Detalle: 4 paradas en orden (3 tripulantes + JMC)', D.stopsEls.length === 4, D.stopsEls.length);
  t('Detalle: maletas (2) con el ícono de la ruta (#rx-Bag, sprite presente)', /\b2\b/.test(D.s1) && !!D.stopsEls[0].querySelector('use[href="#rx-Bag"]') && !!w.document.querySelector('symbol#rx-Bag'));
  t('«Silencio» solo en el privado APROBADO', /Silencio/.test(D.s1) && !/Silencio/.test(D.s2), D.s2);
  t('0 maletas o sin dato: no se inventa un chip', !D.stopsEls[1].querySelector('use[href="#rx-Bag"]') && !D.stopsEls[2].querySelector('use[href="#rx-Bag"]'));
  t('punto de encuentro en la parada, escapado', /Portería 2 <b>/.test(D.s1) && !D.stopsEls[0].querySelector('.rt-chip b'));
  t('cada parada tiene su chat (cambio 4 de la entrega)', root().querySelectorAll('#rt-layers .rt-stop [data-rt="chat"]').length === 3);
  t('la lista de paradas NO muestra el código (es para la acera)', !/0613/.test(root().textContent));

  await click('#rt-layers .rx-foot [data-rt="start"]', 120);
  t('al iniciar: abre la Ejecución y sale en_route de Marta (la base avisa, 0097)', !!(top() && top().querySelector('.rt-exec')) && stops.some(s => s[0] === 'R1' && s[1] === 'en_route'));
  t('el teléfono del conductor NO manda avisos al tripulante', notifs.length === 0, JSON.stringify(notifs));
  t('en camino: maletas, silencio, punto de encuentro y «Recoges 04:50»', /2 maletas/.test(sheet()) && /Prefiere silencio/.test(sheet()) && /Punto de encuentro/.test(sheet()) && /Portería 2 <b>/.test(sheet()) && /Recoges 04:50/.test(sheet()), sheet().slice(0, 220));
  t('en camino todavía no pide el código', !top().querySelector('.rt-code'));

  // Cambio 2: sin GPS no se avisa «¡Llegó!» sin preguntar.
  await click('.rt-exec [data-rt="arrive"]', 120);
  t('«Llegué» sin ubicación: pide confirmar y NO avisa todavía', /No vemos tu ubicación/.test(hoja()) && !stops.some(s => s[1] === 'at_pickup'), hoja().slice(0, 160));
  await click('#rt-sheet-host [data-rt="sheet-close"]', 300);
  await gps(6.1503, -75.3702);
  await click('.rt-exec [data-rt="arrive"]', 120);
  t('con el GPS en la puerta: at_pickup sale de una (la base avisa «¡Llegó!»)', stops.some(s => s[0] === 'R1' && s[1] === 'at_pickup') && !root().querySelector('#rt-sheet-host .rx-sheet'));
  t('en el punto: 4 casillas para un código viejo de 4 dígitos', top().querySelectorAll('.rt-code .rt-boxes span').length === 4 && top().querySelector('.rt-code input').getAttribute('maxlength') === '4' && /4 dígitos/.test(sheet()));
  t('el código NO sale en la pantalla del conductor', !/0613/.test(sheet()));
  t('«a bordo» espera el código (botón deshabilitado)', top().querySelector('.rt-cta .rx-btn[data-rt="focus-code"]').disabled === true);
  t('reloj de espera visible', /Espera acordada/.test(sheet()));

  // Chat con el tripulante desde la Ejecución.
  await click('.rt-exec .rt-person [data-rt="chat"]', 120);
  await teclea('#rt-chat-in', 'Estoy afuera');
  await click('#rt-sheet-host [data-rt="send"]', 120);
  t('chat al tripulante: opts.url /#/viaje?r=R1', chats.length === 1 && chats[0].opts.url === '/#/viaje?r=R1' && chats[0].opts.title === 'Mensaje de tu conductor', JSON.stringify(chats));
  await click('#rt-sheet-host [data-rt="qr"]', 120);
  t('respuesta rápida sale igual', chats.length === 2 && chats[1].body === 'Ya llegué, estoy afuera', JSON.stringify(chats.map(c => c.body)));
  w.document.querySelector('#rt-sheet-host .rx-sheet-bg').dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await wait(300);

  await teclea('.rt-code input', '1111');
  t('código equivocado: lo dice y NO lo sube', /Ese no es el código de Marta/.test(sheet()) && boards.filter(b => b[0] === 'R1').length === 0, sheet().slice(0, 220));
  await wait(1400);
  await teclea('.rt-code input', '0613', 1300);
  t('código correcto: lo sube (la base lo valida) y pasa a Diego', boards.some(b => b[0] === 'R1' && b[1] === '0613' && !b[2]) && /Diego Toro/.test(sheet()), sheet().slice(0, 160));
  t('siguiente parada: en_route de Diego', stops.some(s => s[0] === 'R2' && s[1] === 'en_route'));
  t('Diego (privado pendiente): sin «Prefiere silencio» ni chip de maletas', !/Prefiere silencio/.test(sheet()) && !/maleta/.test(sheet()));
  await gps(6.1522, -75.3702);
  await click('.rt-exec [data-rt="arrive"]', 120);
  t('código nuevo de 2 dígitos: 2 casillas', top().querySelectorAll('.rt-code .rt-boxes span').length === 2);
  await click('.rt-exec [data-rt="nc"]', 120);
  t('«No tiene el código»: primero avisa que queda registrado, sin subirlo', boards.filter(b => b[0] === 'R2').length === 0 && /quedar registrado/.test(sheet()) && /Subir a Diego sin código/.test(sheet()));
  await click('.rt-exec [data-rt="board"]', 200);
  t('…y al confirmar lo sube sin código (queda registrado)', boards.some(b => b[0] === 'R2' && b[2] === true) && /Ana/.test(sheet()));
  t('nombre y notas escapados en la hoja', /Ana <i>Paz<\/i>/.test(sheet()) && /Timbre <b>2<\/b>/.test(sheet()) && !top().querySelector('.rt-person-tx i, .rt-info span b'), sheet().slice(0, 200));
  await gps(6.1542, -75.3702);
  await click('.rt-exec [data-rt="arrive"]', 120);
  t('sin código en la base: sin casillas, «Ana a bordo · siguiente» directo', !top().querySelector('.rt-code') && !!top().querySelector('[data-rt="board"][data-how="onboard"]'));
  // No-show tras la espera (cambio 3: pide confirmación). Se adelanta el reloj.
  const t0 = w.Date.now(); w.Date.now = () => t0 + 6 * 60000; await wait(1200);
  const nsBtn = top().querySelector('.rt-link.err[data-rt="noshow"]');
  t('vencida la espera, «No se presentó» se habilita', nsBtn && nsBtn.disabled === false && /Espera cumplida/.test(sheet()));
  await click('.rt-exec [data-rt="noshow"]', 120);
  t('«No se presentó» abre la confirmación', /¿Ana no se presentó\?/.test(hoja()) && !stops.some(s => s[0] === 'R3' && s[1] === 'no_show'), hoja().slice(0, 120));
  await click('#rt-sheet-host [data-rt="sheet-close"]', 300);
  t('«Seguir esperando»: no marca nada', !stops.some(s => s[0] === 'R3' && s[1] === 'no_show') && /Ana/.test(sheet()));
  await click('.rt-exec [data-rt="noshow"]', 120);
  await click('#rt-sheet-host [data-rt="noshow-yes"]', 200);
  t('al confirmar: no_show (la base le avisa)', stops.some(s => s[0] === 'R3' && s[1] === 'no_show'));

  // Salida en JMC: entrega a los que van a bordo, NO al que no se presentó.
  await click('.rt-exec [data-rt="arrive"]', 120);
  t('salida, en JMC: «Entregué a los 2», sin códigos', /Entregué a los 2/.test(sheet()) && !top().querySelector('.rt-code'), sheet().slice(0, 160));
  await click('.rt-exec [data-rt="finish"]', 200);
  t('entregados: Marta y Diego sí, Ana (no se presentó) NO', stops.some(s => s[0] === 'R1' && s[1] === 'delivered') && stops.some(s => s[0] === 'R2' && s[1] === 'delivered') && !stops.some(s => s[0] === 'R3' && s[1] === 'delivered'), JSON.stringify(stops));
  t('«¡Vuelta completa!» con el puente a V2 y sin «el admin ya fue notificado»', /¡Vuelta completa!/.test(top().textContent) && /Ver la vuelta V2/.test(top().textContent) && !/admin/i.test(top().textContent));

  // Llegada (V2).
  await click('.rt-exec ~ * [data-rt="nextv"], [data-rt="nextv"]', 200);
  await click('#rt-layers .rx-foot [data-rt="start"]', 200);
  t('llegada, rumbo a JMC: sin códigos todavía', !top().querySelector('.rt-code-in, .rt-cr'));
  await gps(6.15, -75.37);       // ~6 km del aeropuerto
  await click('.rt-exec [data-rt="arrive"]', 120);
  t('«Llegué al aeropuerto» lejos de JMC: pide confirmar con la distancia y NO avisa', /Todavía no estás en JMC/.test(hoja()) && /km del aeropuerto/.test(hoja()) && apt.length === 0, hoja().slice(0, 200));
  await click('#rt-sheet-host [data-rt="sheet-close"]', 300);
  await gps(6.1716, -75.4271);
  await click('.rt-exec [data-rt="arrive"]', 200);
  t('ya en JMC: avisa por la base (driver_mark_airport_arrival)', apt.join(',') === 'RA2', apt.join(','));
  t('una fila por tripulante; casillas solo para quien tiene código', top().querySelectorAll('.rt-cr').length === 2 && !!top().querySelector('.rt-cr[data-row="R4"] input[data-code]') && !top().querySelector('.rt-cr[data-row="R5"] input[data-code]') && !/3391/.test(sheet()));
  t('«Salir del aeropuerto» espera a que todos queden resueltos', top().querySelector('[data-rt="leave"]').disabled === true && /Faltan 2 por resolver/.test(sheet()));
  await teclea('.rt-cr[data-row="R4"] input[data-code]', '3391', 900);
  t('Luis con su código: ✓ A bordo', boards.some(b => b[0] === 'R4' && b[1] === '3391') && /Luis Mora\s*✓ A bordo/.test(sheet()), sheet().slice(0, 240));
  await click('[data-rt="ask"][data-ask="notarrived"][data-rid="R5"]');
  t('«No llegó» pide confirmar en la fila', /¿Marcar que Eva no llegó\?/.test(sheet()) && aptNo.length === 0);
  await click('[data-rt="ask-yes"][data-rid="R5"]', 150);
  t('…y al confirmar → driver_airport_no_show', aptNo.join(',') === 'R5' && /Eva Sol\s*No llegó/.test(sheet()), aptNo.join(',') + ' | ' + sheet().slice(0, 200));
  await click('.rt-cr[data-row="R5"] [data-rt="undo"]', 150);
  t('«Deshacer» (0102): driver_airport_undo y la fila vuelve a quedar por resolver', undos.join(',') === 'R5' && !!top().querySelector('.rt-cr:not(.done)[data-row="R5"]'));
  await click('[data-rt="ask"][data-ask="notarrived"][data-rid="R5"]');
  await click('[data-rt="ask-yes"][data-rid="R5"]', 150);
  t('ya se puede salir: «Salir del aeropuerto · 1 a bordo»', top().querySelector('[data-rt="leave"]').disabled === false && /Salir del aeropuerto · 1 a bordo/.test(sheet()));
  await click('[data-rt="leave"]', 200);
  t('va a la casa de Luis (salta la de Eva) y dice «Llega aprox. 14:40»', /Luis/.test(sheet()) && !/Eva Sol/.test(sheet()) && /Llega aprox\. 14:40/.test(sheet()), sheet().slice(0, 160));
  t('en_route_home de Luis', stops.some(s => s[0] === 'R4' && s[1] === 'en_route_home'));
  t('sin textos prohibidos en la vista del conductor', prohibidos(root().innerHTML).length === 0, prohibidos(root().innerHTML).join(','));
  t('sin errores de script', D.errores.length === 0, D.errores.join(' | '));
}
{
  const D = await driverRun(false);
  t('sin aux-rx-ui.js cargado: la ruta se pinta igual (maletas en la parada)', D.stopsEls.length === 4 && /\b2\b/.test(D.s1));
  t('y sin errores', D.errores.length === 0, D.errores.join(' | '));
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── admin-privados.js · «Pidió silencio» y push al viaje ──');
{
  const { w, toasts } = boot();
  const pushes = [];
  const ITEMS = [
    { id: 'R7', type: 'sal', addr: 'El Olivar', whenISO: new Date(Date.now() + 86400e3).toISOString(), status: 'requested', price: null, who: 'Marta Ríos', whoId: 'P1', phone: '', notes: '' },
    { id: 'R8', type: 'lle', addr: 'Llanogrande', whenISO: new Date(Date.now() + 3 * 86400e3).toISOString(), status: 'approved', price: null, who: 'Diego Toro', whoId: 'P2', phone: '', notes: '' },
  ];
  w.Api = {
    listPrivateRequests: async () => ITEMS.map(x => ({ ...x })),
    decidePrivate: async (id) => ({ requester_profile_id: id === 'R7' ? 'P1' : 'P2' }),
    sendPush: async (p) => { pushes.push(p); return { sent: 1 }; },
  };
  w.sb = fakeSb({ reservations: () => ({ data: [{ id: 'R7', quiet_ride: true }, { id: 'R8', quiet_ride: false }], error: null }) });
  w.eval(read('admin-privados.js'));
  w.renderPrivados(); await wait(60);
  const cards = [...w.document.querySelectorAll('#pv-list .pv-card')];
  t('«Pidió silencio» en quien lo pidió', cards.length === 2 && /Pidió silencio/.test(cards[0].textContent) && !/Pidió silencio/.test(cards[1].textContent));
  t('la consulta extra pide solo quiet_ride de esos ids', w.sb.log.some(l => l.tabla === 'reservations' && l.cols === 'id, quiet_ride'));
  cards[0].querySelector('[data-pv="ok"]').click(); await wait(80);
  t('aprobar: push a /#/viaje?r=R7', pushes.length === 1 && pushes[0].url === '/#/viaje?r=R7', JSON.stringify(pushes));
  // Sin 0086: la columna no existe → sin etiqueta, sin error.
  const b2 = boot();
  b2.w.Api = { listPrivateRequests: async () => ITEMS.map(x => ({ ...x })) };
  b2.w.sb = fakeSb({ reservations: () => ({ data: null, error: { code: '42703', message: 'column reservations.quiet_ride does not exist' } }) });
  b2.w.eval(read('admin-privados.js'));
  b2.w.renderPrivados(); await wait(60);
  t('sin la columna: las tarjetas salen igual y sin «Pidió silencio»', b2.w.document.querySelectorAll('#pv-list .pv-card').length === 2 && !/Pidió silencio/.test(b2.w.document.getElementById('pv-list').textContent));
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── admin-reservas.js · maletas, silencio y cancelación ──');
{
  const { w, toasts } = boot();
  const notifs = [];
  w.notify = (ids, title, body, url) => notifs.push({ ids, title, body, url });
  w.jcOpen = () => {};
  w.state = { settings: { aux_min_lead_hours: 6 } };
  const when = new Date(Date.now() + 2 * 86400e3).toISOString();
  const ROWS = [
    { id: 'R1', type: 'sal', name: 'Marta Ríos', profileId: 'P1', phone: '', address: 'El Olivar', when, date: when.slice(0, 10), time: '05:30', flight: '', status: 'assigned', createdAt: hace(60 * 48), rating: 0 },
    { id: 'R2', type: 'lle', name: 'Diego Toro', profileId: 'P2', phone: '', address: 'Llanogrande', when, date: when.slice(0, 10), time: '14:00', flight: '', status: 'pending', createdAt: hace(60 * 48), rating: 0 },
    { id: 'R3', type: 'sal', name: 'Ana Paz', profileId: 'P3', phone: '', address: 'Cimarronas', when, date: when.slice(0, 10), time: '06:10', flight: '', status: 'pending', createdAt: hace(60 * 48), rating: 0 },
  ];
  w.Api = {
    listReservationsAdmin: async () => ROWS.map(x => ({ ...x })),
    adminCancelReservation: async () => ({ driver_profile_id: 'D9' }),
  };
  w.sb = fakeSb({ reservations: () => ({ data: [{ id: 'R1', bags: 2, quiet_ride: true }, { id: 'R2', bags: 0, quiet_ride: false }, { id: 'R3', bags: null, quiet_ride: false }], error: null }) });
  w.eval(read('admin-reservas.js'));
  await w.renderReservas(); await wait(30);
  const row = (id) => w.document.querySelector(`[data-rv-row="${id}"]`).textContent.replace(/\s+/g, ' ');
  t('fila con «2 maletas» y «Pidió silencio»', /2 maletas/.test(row('R1')) && /Pidió silencio/.test(row('R1')), row('R1'));
  t('«Sin maletas» cuando dijo 0; sin silencio', /Sin maletas/.test(row('R2')) && !/silencio/.test(row('R2')));
  t('sin dato de maletas no se inventa nada', !/maleta/i.test(row('R3')));
  w.document.querySelector('[data-rv-cancel="R1"]').click(); await wait();
  w.document.getElementById('rv-reason').value = 'Vuelo cancelado';
  w.document.querySelector('[data-rv-do="R1"]').click(); await wait(60);
  const na = notifs.find(n => n.ids[0] === 'P1'), nd = notifs.find(n => n.ids[0] === 'D9');
  t('cancelación: push del tripulante a /#/viaje?r=R1', na && na.url === '/#/viaje?r=R1', JSON.stringify(notifs));
  t('el del conductor sigue abriendo su app en «/»', nd && nd.url === '/');
  // Sin 0086.
  const b2 = boot();
  b2.w.notify = () => {}; b2.w.jcOpen = () => {}; b2.w.state = { settings: {} };
  b2.w.Api = { listReservationsAdmin: async () => ROWS.map(x => ({ ...x })) };
  b2.w.sb = fakeSb({});
  b2.w.eval(read('admin-reservas.js'));
  await b2.w.renderReservas(); await wait(30);
  t('sin la columna: la lista sale igual, sin maletas ni silencio', b2.w.document.querySelectorAll('#rv-list .rv-row').length === 3 && !/maleta|silencio/i.test(b2.w.document.getElementById('rv-list').textContent));
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── admin-chat.js · la respuesta del jefe abre el viaje ──');
{
  const { w } = boot();
  const sent = [];
  w.Api = {
    listReservationMessages: async () => [],
    sendReservationMessage: async (rid, body, opts) => { sent.push({ rid, body, opts }); return { recipients: ['P1', 'D1'], notified: true }; },
  };
  w.eval(read('admin-chat.js'));
  w.jcOpen('R1', 'Marta Ríos', '05:30 · El Olivar'); await wait(30);
  w.document.getElementById('jc-input').value = 'Tu carro va en camino';
  w.document.getElementById('jc-send').click(); await wait(40);
  t('sendReservationMessage con url /#/viaje?r=R1', sent.length === 1 && sent[0].opts.url === '/#/viaje?r=R1' && sent[0].opts.title === 'Mensaje de Rendio', JSON.stringify(sent));
  w.eval('jcClose()');
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── admin-flota.js · campo Color ──');
async function flotaBoot(conColor) {
  const B = boot();
  const { w } = B;
  const calls = [];
  w.setOilBadge = () => {};
  w.state = { profile: { organization_id: 'o1' } };
  const VEHS = [{ id: 'v1', internal_code: 'C1', license_plate: 'ABC123', brand: 'Kia', model: 'Carens', capacity: 4, current_km: 1000, status: 'available' }];
  w.Api = {
    listVehiclesForShift: async () => VEHS.map(x => ({ ...x })),
    updateVehicle: async (id, patch) => { calls.push(['update', id, patch]); },
    createVehicle: async (v) => { calls.push(['create', v]); return 'v2'; },
  };
  w.ApiAux = { setVehicleColor: async (id, c) => { calls.push(['color', id, c]); return true; } };
  w.sb = fakeSb({ vehicles: () => conColor ? { data: [{ id: 'v1', color: 'Blanco' }], error: null } : { data: null, error: { code: '42703', message: 'column vehicles.color does not exist' } } });
  w.eval(read('admin-flota.js'));
  await w.eval('renderFlota()'); await wait(40);
  return Object.assign(B, { calls });
}
{
  const F = await flotaBoot(true);
  const { w, calls } = F;
  const inp = () => w.document.getElementById('new-veh-color');
  t('con vehicles.color: aparece el campo Color en el formulario', !!inp());
  t('va después de Marca/Modelo', (() => { const g = w.document.getElementById('new-veh-model').closest('.set-grid2'); return g && g.nextElementSibling && g.nextElementSibling.id === 'new-veh-color-row'; })());
  t('la lista muestra el color del carro', /Carens · Blanco/.test(w.document.getElementById('vehicles-list').textContent));
  w.document.querySelector('[data-veh-edit="v1"]') && w.eval('onEditVehicle("v1")');
  t('editar precarga el color', inp().value === 'Blanco');
  inp().value = 'Gris plata';
  await w.eval('onCreateVehicle()'); await wait(40);
  t('guardar edición: update sin color + setVehicleColor(v1, «Gris plata»)', calls.some(c => c[0] === 'update' && !('color' in c[2])) && calls.some(c => c[0] === 'color' && c[1] === 'v1' && c[2] === 'Gris plata'), JSON.stringify(calls));
  t('y avisa «Vehículo actualizado.»', F.toasts.includes('Vehículo actualizado.'));
  t('renderizar dos veces no duplica el campo', (await w.eval('renderFlota()'), await wait(40), w.document.querySelectorAll('#new-veh-color').length === 1));
  // Alta con color.
  w.document.getElementById('new-veh-code').value = 'C2'; w.document.getElementById('new-veh-plate').value = 'xyz789';
  inp().value = 'Negro';
  calls.length = 0;
  await w.eval('onCreateVehicle()'); await wait(40);
  t('alta: create + setVehicleColor(id nuevo, «Negro»)', calls.some(c => c[0] === 'create') && calls.some(c => c[0] === 'color' && c[1] === 'v2' && c[2] === 'Negro'), JSON.stringify(calls));
  t('el formulario se limpia (color incluido)', inp().value === '');
  // Alta sin color: no llama.
  w.document.getElementById('new-veh-code').value = 'C3'; w.document.getElementById('new-veh-plate').value = 'qqq111';
  calls.length = 0;
  await w.eval('onCreateVehicle()'); await wait(40);
  t('alta sin color: no toca el color', calls.some(c => c[0] === 'create') && !calls.some(c => c[0] === 'color'));
  // Falla el color: se dice cuál parte no entró.
  w.ApiAux.setVehicleColor = async () => { throw new Error('El color es muy largo (máximo 30 caracteres)'); };
  w.eval('onEditVehicle("v1")'); inp().value = 'Otro';
  await w.eval('onCreateVehicle()'); await wait(40);
  t('si el color falla, dice que el vehículo sí quedó', F.toasts.some(x => /quedó guardado, pero el color no: El color es muy largo/.test(x)), F.toasts.join(' | '));
}
{
  const F = await flotaBoot(false);
  t('sin vehicles.color (0086 sin aplicar): no hay campo ni color en la lista', !F.w.document.getElementById('new-veh-color') && !/Blanco/.test(F.w.document.getElementById('vehicles-list').textContent));
  t('y la lista sale igual', /ABC123/.test(F.w.document.getElementById('vehicles-list').textContent));
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── admin-rutas.js · avisos al tripulante a /#/viajes ──');
{
  const src = read('admin-rutas.js');
  const bloque = src.split("title: 'Conductor asignado 🚗'")[1] || '';
  t('«Conductor asignado» → /#/viajes', /url: '\/#\/viajes'/.test(bloque.split('\n').slice(0, 3).join('\n')));
  const bloque2 = src.split("title: 'Te cambiamos el conductor 🔄'")[1] || '';
  t('«Te cambiamos el conductor» → /#/viajes', /url: '\/#\/viajes'/.test(bloque2.split('\n').slice(0, 3).join('\n')));
  const bloque3 = src.split("title: 'Ruta asignada 🗺️'")[1] || '';
  t('«Ruta asignada» (al conductor) sigue en «/»', /url: '\/'/.test(bloque3.split('\n').slice(0, 4).join('\n')));
}

if (rechazos.length) console.log('\n  ⚠ rechazos sin atender:\n    ' + rechazos.join('\n    '));
console.log(`\n${ok}/${ok + bad} pasaron${bad ? ' · ' + bad + ' FALLARON' : ''}`);
console.log('NO cubierto: layout (bandeja/hilo lado a lado, 390 px, chips del conductor), Leaflet, push real, Supabase/RLS real, animaciones (no hay nuevas).');
process.exit(bad ? 1 : 0);
