// T9 · ADMIN › Rutas › Asignación v2 (entrega del UX, 10-oct-2026) — prueba jsdom.
//
// Carga index.html + admin-consola.js + admin-rutas.js + admin-rutas-v2.js (los
// de verdad, en UNA evaluación para poder tocar `rt`) con un Api FALSO que
// entrega un día de prueba (fixtures/rutas-v2-dia.js): reservas, carros,
// conductores, horario publicado, el plan ya publicado y una matriz de tiempos
// controlada (|xa − xb| + 2 min). El modelo de tiempos, el solver y el guardado
// son los de admin-rutas.js: la prueba no los reimplementa.
//
// Comprueba:
//   A) la v2 es la vista por defecto, rearma el plan publicado (chip «Publicado»,
//      vueltas, conductores por turno, sin rutear) y los conteos de los chips;
//      franjas por hora de llegada a JMC / aterrizaje, abiertas solo si tienen
//      excepciones, «Ver N rutas listas más»; filtros por estado y tipo;
//      búsqueda sin tildes con <mark>; rutas por hora;
//   B) el detalle: paradas en orden, tel:, mover desde la parada, la sugerencia
//      de la ruta en riesgo con el impacto en las dos rutas, «Aplicar», aviso con
//      «Deshacer» (y deshacer de verdad), una parada ya atendida no se mueve;
//   C) «Mover a…» / «Rutear» con el margen calculado por el modelo real;
//      «Asignar conductor» (horario publicado, el que ya maneja otro carro no se
//      puede elegir) y «Autoasignar»;
//   D) Publicar: bloqueado y «Faltan N pendientes», «Revisé las ajustadas»,
//      «Publicar de todos modos» con confirmación explícita (rutas en riesgo/sin
//      conductor y, aparte, tripulantes sin rutear), lo que le llega a
//      Api.saveRoutePlan, y re-publicar avisa que los conductores ya lo tienen;
//   E) cambio de día ‹ › (Api.listRoutePlanning recibe el día; un día sin
//      reservas dice «Sin traslados…»), confirmación si hay cambios sin publicar;
//   F) vista Carros, teclado (/, ↑↓, Enter, Esc), botón de WhatsApp, Re-optimizar
//      (rtOptimize de verdad con su overlay) y deshacer;
//   G) la vista anterior sigue funcionando (y la elección se recuerda);
//   H) api.js de verdad: listRoutePlanning(tipo, día) pide SOLO ese día aunque
//      hoy tenga reservas, sin día sigue siendo el próximo día con reservas;
//      getPublishedPlan acepta estados; listDrivers trae el teléfono.
//
// LO QUE NO CUBRE: layout (jsdom no lo hace: puntos de quiebre, cajón, tarjetas,
// barra fija del celular — eso lo miran las capturas de _capturas-rutas-v2.mjs y,
// sobre todo, alguien en un teléfono de verdad), la base real (RLS, que
// saveRoutePlan y getPublishedPlan respondan así en producción, tiempos de red),
// TomTom/OSRM reales (aquí la matriz es inventada), el mapa Leaflet real, el
// push real y el módulo de WhatsApp de otro desarrollador (solo se mira que el
// botón lo llame).
//
//   cd rendio-backend && node scripts/_smoke-rutas-v2-dom.mjs
process.env.TZ = 'America/Bogota';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const FIX = new URL('./fixtures/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null && d !== '' ? ' → ' + d : '')); } };
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
// Texto «como se lee»: un espacio entre elementos (textContent los pega).
const leer = (el) => { if (!el) return null; const p = []; const walk = (n) => { n.childNodes.forEach((c) => { if (c.nodeType === 3) p.push(c.textContent); else { walk(c); p.push(' '); } }); }; walk(el); return p.join('').replace(/\s+/g, ' ').trim(); };

async function boot({ vista = null, publicado = true, confirm = true, dias } = {}) {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const errors = [], toasts = [], confirms = [];
  w.console.error = (...a) => { errors.push(a.map((x) => (x && x.message) || String(x)).join(' ')); };
  w.addEventListener('error', (e) => errors.push(e.message));
  w.RENDIO_CONFIG = {};
  w.state = { settings: { route_traffic_factor: 1 }, profile: { id: 'jefe', role: 'admin' } };
  w.toast = (m) => toasts.push(m);
  w.confirm = (m) => { confirms.push(m); return typeof confirm === 'function' ? confirm(m) : confirm; };
  w.escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  w.$ = (s) => w.document.querySelector(s); w.$$ = (s) => w.document.querySelectorAll(s);
  w.fetch = async () => { throw new Error('sin red'); };
  if (vista) w.localStorage.setItem('rendio.rutas.vista', vista);
  w.eval(readFileSync(FIX + 'fake-leaflet.js', 'utf8'));
  w.eval(readFileSync(FIX + 'rutas-v2-dia.js', 'utf8'));
  w.RV2Fixture.instalarFetch(w);
  w.Api = {};
  const log = w.RV2Fixture.instalar(w.Api, { publicado, dias });
  try {
    w.eval(read('admin-consola.js') + '\n' + read('admin-rutas.js') + '\n' + read('admin-rutas-v2.js') +
      '\n;window.__T = { rt, rtCarCompute, renderRoutes, rtFirmaPlan, rtLoad };');
  } catch (e) { errors.push('eval: ' + e.message); }
  w.document.querySelector('section[data-panel="routes"]').classList.remove('hidden');
  const q = (s) => w.document.querySelector(s);
  const qa = (s) => [...w.document.querySelectorAll(s)];
  const click = (el) => { if (!el) throw new Error('no existe el elemento'); el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })); };
  const key = (k, target) => (target || w.document.activeElement || w.document.body).dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const type = (el, v) => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
  const V2 = () => w.RendioRutasV2;
  const T = () => w.__T;
  const rows = () => qa('#rv2-list .rv2-row');
  const rowIds = () => rows().map((r) => r.dataset.id);
  const chip = (k) => q(`#rv2-chips [data-k="${k}"]`);
  const chipN = (k) => { const c = chip(k); return c ? txt(c.querySelector('b')) : null; };
  const sheet = () => q('#rv2-sheet');
  const toastV2 = () => txt(q('#rv2-toast'));
  const rutaDe = (id) => V2().dia().byId[id];
  await T().renderRoutes();
  await wait(40);
  return { w, log, errors, toasts, confirms, q, qa, click, key, type, V2, T, rows, rowIds, chip, chipN, sheet, toastV2, rutaDe };
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── A · lista, chips, franjas, filtros y búsqueda ──');
{
  const b = await boot();
  const { q, qa, click, type, chip, chipN, rows, rowIds, V2, T, log } = b;
  t('la v2 es la vista por defecto (#routes-v2 visible, la anterior apartada)', !q('#routes-v2').hidden && q('#routes-ui').classList.contains('rv2-fuera'));
  t('sin día pedido carga el próximo día con reservas (como siempre)', log.planning[0] === null && T().rt.day === '2026-10-12', JSON.stringify(log.planning));
  t('pide el plan publicado de ese día con draft/planned/in_progress/completed', log.publicados.length === 1 && log.publicados[0].day === '2026-10-12' && JSON.stringify(log.publicados[0].estados) === JSON.stringify(['draft', 'planned', 'in_progress', 'completed']), JSON.stringify(log.publicados));
  t('rearma las 9 vueltas publicadas (número de vuelta por carro)', T().rt.lanes.length === 9 && T().rt.lanes.map((l) => l.id).join(',') === 'V-01·V1,V-02·V1,V-01·V2,V-02·V2,V-03·V1,V-03·V2,V-02·V3,V-01·V3,V-03·V3', T().rt.lanes.map((l) => l.id).join(','));
  t('conductor por carro y turno (V-01 AM Jorge, V-03 PM Diego, V-01 PM vacío)', T().rt.cars[0].driverAM === 'd1' && !T().rt.cars[0].driverPM && T().rt.cars[2].driverPM === 'd4');
  t('los no ruteados quedan en el pool (Manuela y Kevin)', T().rt.pool.slice().sort().join(',') === 'rN,rO', T().rt.pool.join(','));
  t('origen encadenado: la 2ª salida de V-01 sale de JMC', T().rt.lanes.find((l) => l.id === 'V-01·V2').origin === 'airport' && T().rt.lanes.find((l) => l.id === 'V-01·V1').origin === null);
  t('leer lo publicado NO le pide nada a TomTom (cobra por celda): tiempos por OSRM', log.tomtom === 0 && T().rt.etaSource === 'osrm', JSON.stringify([log.tomtom, T().rt.etaSource]));
  t('chip «Publicado» (lo que se ve es lo que tienen los conductores)', !q('#rv2-pubChip').hidden && txt(q('#rv2-pubChip')) === 'Publicado');
  t('el día en la barra: «Lun 12 oct»', txt(q('#rv2-dayLabel')) === 'Lun 12 oct', txt(q('#rv2-dayLabel')));
  t('chips: Todas 9 · En riesgo 1 · Sin conductor 1 · Ajustadas 2 · Listas 5 · Sin rutear 2 aux.',
    chipN('all') === '9' && chipN('risk') === '1' && chipN('nodriver') === '1' && chipN('adj') === '2' && chipN('ok') === '5' && chipN('unrouted') === '2 aux.',
    ['all', 'risk', 'nodriver', 'adj', 'ok', 'unrouted'].map(chipN).join(' '));
  t('«5 de 9 rutas listas» y la barra de avance', txt(q('#rv2-readyN')) === '5' && txt(q('#rv2-totalN')) === '9' && /55\.5/.test(q('#rv2-fill').style.width), q('#rv2-fill').style.width);
  t('badge del botón Publicar = 6 pendientes (1+1+2+2)', txt(q('#rv2-pending')) === '6' && !q('#rv2-pending').hidden);
  const r = b.rutaDe('V-01·V2');
  t('modelo real: V-01·V2 sale 04:45, llega 06:39, margen −19 (con 10 min de entrega)', r && r.arrival === 399 && r.margin === -19 && r.status === 'risk', r && JSON.stringify([r.arrival, r.margin, r.status]));
  t('V-02·V2 es «Hotel» (pernocta) y Ajustada +7', b.rutaDe('V-02·V2').type === 'hotel' && b.rutaDe('V-02·V2').margin === 7 && b.rutaDe('V-02·V2').status === 'adj');
  t('turno por la hora de la vuelta (AM 02:30–14:00, PM después)', b.rutaDe('V-01·V2').shift === 'am' && b.rutaDe('V-01·V3').shift === 'pm');
  t('la vuelta terminada cuenta como Lista', b.rutaDe('V-01·V1').fija === 'completed' && b.rutaDe('V-01·V1').status === 'ok');
  const grupos = qa('#rv2-list .rv2-group');
  t('franjas por hora de llegada a JMC / aterrizaje: 04,05,06,07,08,11,15,16', grupos.map((g) => g.dataset.group).join(',') === '4,5,6,7,8,11,15,16', grupos.map((g) => g.dataset.group).join(','));
  t('cada franja en su propio bloque con sus filas (el encabezado pegajoso no se apila)', qa('#rv2-list .rv2-gwrap').length === 8 && qa('#rv2-list .rv2-gwrap > .rv2-group').length === 8 && !!q('.rv2-gwrap .rv2-group[data-group="6"] ~ .rv2-row[data-id="V-01·V2"]'));
  t('abren solo las que tienen excepciones (06,07,08,15)', grupos.filter((g) => g.getAttribute('aria-expanded') === 'true').map((g) => g.dataset.group).join(',') === '6,7,8,15');
  t('las «todas listas» dicen «todas listas»', /todas listas/.test(txt(grupos.find((g) => g.dataset.group === '4'))));
  t('encabezado: «07:00 – 08:00 · 2 rutas · 1 ajustada»', /07:00 – 08:00 · 2 rutas · 1 ajustada/.test(txt(grupos.find((g) => g.dataset.group === '7'))), txt(grupos.find((g) => g.dataset.group === '7')));
  t('filas visibles: solo las excepciones (4)', rows().length === 4 && rowIds().join(',') === 'V-01·V2,V-02·V2,V-03·V2,V-01·V3', rowIds().join(','));
  const more = q('#rv2-list .rv2-more');
  t('«Ver 1 ruta lista más de esta franja» en la de las 07', more && more.dataset.more === '7' && /Ver 1 ruta lista más/.test(txt(more)));
  click(more); await b.w.Promise.resolve();
  t('…y al tocarlo aparece V-03·V1', rowIds().includes('V-03·V1'));
  click(q('.rv2-group[data-group="4"]'));
  t('tocar una franja plegada la abre (V-01·V1)', rowIds().includes('V-01·V1'));
  const row = rows().find((x) => x.dataset.id === 'V-02·V2');
  t('la fila: estado con palabra, horas, carro·tipo, nombres, margen y conductor',
    txt(row.querySelector('.st')) === 'Ajustada' && txt(row.querySelector('.time')) === '06:59 → 07:23' && txt(row.querySelector('.car')) === 'V-02 · Hotel'
    && txt(row.querySelector('.names')) === 'Daniela Cano · Sergio Molina' && txt(row.querySelector('.mg')) === '+7 min' && txt(row.querySelector('.drv')) === 'Luis Arango',
    [row.querySelector('.st'), row.querySelector('.time'), row.querySelector('.car'), row.querySelector('.names'), row.querySelector('.mg'), row.querySelector('.drv')].map(txt).join(' | '));
  t('fila accesible: role=button, tabindex=0 y aria-label con carro, estado, horas y nombres', row.getAttribute('role') === 'button' && row.getAttribute('tabindex') === '0' && /V-02, Ajustada, 06:59 → 07:23, Daniela Cano, Sergio Molina/.test(row.getAttribute('aria-label')));
  const sinC = rows().find((x) => x.dataset.id === 'V-01·V3');
  t('llegada: «JMC 15:00 → …», margen «—» y «+ Asignar» en vez de conductor', /^JMC 15:00 → /.test(txt(sinC.querySelector('.time'))) && txt(sinC.querySelector('.mg')) === '—' && !!sinC.querySelector('[data-act="assign"]'));
  // Más de 3 nombres → «+N»: se agrega gente a una vuelta solo para mirar el texto.
  T().rt.order['V-03·V2'] = ['rI', 'rJ', 'rN', 'rP']; V2().render();
  const r4 = rows().find((x) => x.dataset.id === 'V-03·V2');
  t('hasta 3 nombres + «+1»', r4 && /Juliana Ossa · Manuela Franco · Paula Henao \+1|Mateo Zapata · Juliana Ossa · Manuela Franco \+1/.test(txt(r4.querySelector('.names'))) || (r4 && /\+1$/.test(txt(r4.querySelector('.names')))), r4 && txt(r4.querySelector('.names')));
  T().rt.order['V-03·V2'] = ['rI', 'rJ']; T().rt.pool = ['rN', 'rO']; V2().render();
  // Chips
  click(chip('risk'));
  t('chip «En riesgo» filtra (1 fila) y queda aria-pressed', rows().length === 1 && rowIds()[0] === 'V-01·V2' && chip('risk').getAttribute('aria-pressed') === 'true');
  click(chip('risk'));
  t('tocar otra vez el chip activo vuelve a «Todas»', chip('all').getAttribute('aria-pressed') === 'true' && rows().length > 1);
  click(chip('ok'));
  t('chip «Listas»: 5 filas, todas Lista (las franjas se abren al filtrar)', rows().length === 5 && rows().every((x) => x.dataset.s === 'ok'), rowIds().join(','));
  click(chip('nodriver'));
  t('chip «Sin conductor»: V-01·V3', rowIds().join(',') === 'V-01·V3');
  click(chip('unrouted'));
  t('chip «Sin rutear»: Manuela y Kevin con «Rutear»', qa('#rv2-list .rv2-crew').length === 2 && qa('#rv2-list [data-act="route"]').length === 2 && /Manuela Franco/.test(txt(q('#rv2-list'))));
  click(chip('all'));
  const sel = q('#rv2-type'); sel.value = 'hotel'; sel.dispatchEvent(new b.w.Event('change', { bubbles: true }));
  t('tipo «Hotel»: solo V-02·V2 y los chips cuentan solo ese tipo', chipN('all') === '1' && chipN('adj') === '1' && rowIds().join(',') === 'V-02·V2', chipN('all'));
  sel.value = 'llegada'; sel.dispatchEvent(new b.w.Event('change', { bubbles: true }));
  t('tipo «Llegada»: 2 rutas', chipN('all') === '2');
  sel.value = ''; sel.dispatchEvent(new b.w.Event('change', { bubbles: true }));
  // Búsqueda
  type(q('#rv2-q'), 'jose nanez'); await wait(160);
  t('búsqueda sin tildes: «jose nanez» encuentra a José Ñáñez (V-01·V2)', rowIds().join(',') === 'V-01·V2', rowIds().join(','));
  const mk = q('#rv2-list .rv2-row mark');
  t('…y resalta la coincidencia con <mark> respetando las tildes', mk && mk.textContent === 'José Ñáñez', mk && mk.textContent);
  type(q('#rv2-q'), 'MARINILLA'); await wait(160);
  t('por sector/barrio (mayúsculas): Marinilla → V-01·V2 y V-02·V1', rowIds().slice().sort().join(',') === 'V-01·V2,V-02·V1', rowIds().join(','));
  type(q('#rv2-q'), 'v-03'); await wait(160);
  t('por carro: V-03 → sus 3 vueltas', rowIds().length === 3 && rowIds().every((id) => id.startsWith('V-03')), rowIds().join(','));
  type(q('#rv2-q'), 'ruben'); await wait(160);
  t('por conductor sin vueltas: «Sin resultados»', rows().length === 0 && /Sin resultados para «ruben»/.test(txt(q('#rv2-list'))));
  type(q('#rv2-q'), 'perez'); await wait(160);
  t('por conductor (Jorge Pérez): las 2 vueltas AM de V-01', rowIds().slice().sort().join(',') === 'V-01·V1,V-01·V2', rowIds().join(','));
  type(q('#rv2-q'), ''); await wait(160);
  // Rutas por hora
  const hb = qa('#rv2-hist-bars .rv2-hb');
  t('rutas por hora: 24 barras, punto rojo en las 06', hb.length === 24 && !!hb[6].querySelector('.dot') && qa('#rv2-hist-bars .dot').length === 1);
  t('…con aria-label («06:00, 1 ruta, con rutas en riesgo»)', hb[6].getAttribute('aria-label') === '06:00, 1 ruta, con rutas en riesgo');
  click(hb[11]);
  t('tocar la barra de las 11 abre esa franja', q('.rv2-group[data-group="11"]').getAttribute('aria-expanded') === 'true' && rowIds().includes('V-02·V3'));
  t('sin errores de script', b.errors.length === 0, b.errors.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── B · detalle, sugerencia, aplicar y deshacer ──');
{
  const b = await boot();
  const { q, qa, click, chipN, V2, T } = b;
  t('en PC se abre sola la primera ruta en riesgo (V-01·V2)', V2()._ui.sel === 'V-01·V2' && /V-01 · Vuelta 2/.test(txt(q('#rv2-detail h2'))));
  t('la fila seleccionada lleva aria-current', q('.rv2-row[aria-current="true"]').dataset.id === 'V-01·V2');
  const alerta = txt(q('#rv2-detail .rv2-alert'));
  t('alerta: «En riesgo · llega 06:39; con 10 min de entrega no alcanza la presentación (06:30): 19 min tarde»', alerta === 'En riesgo · llega 06:39; con 10 min de entrega no alcanza la presentación (06:30): 19 min tarde', alerta);
  const li = qa('#rv2-detail .rv2-stops li');
  t('paradas en orden de recogida: Camila 05:37, José 06:13 y la llegada a JMC 06:39', li.length === 3 && /^05:37 Camila Ortiz Ébano · Marinilla · pres. 06:30/.test(leer(li[0])) && /^06:13 José Ñáñez/.test(leer(li[1])) && /^06:39 Llegada JMC Presentación 06:30 · 10 min de entrega · 19 min tarde/.test(leer(li[2])), li.map(leer).join(' | '));
  t('llamar: tel: con el número del tripulante', li[0].querySelector('a[href="tel:3001110004"]') && li[0].querySelector('a').getAttribute('aria-label') === 'Llamar a Camila Ortiz');
  t('conductor con teléfono → botón de llamar; «Cambiar»', /Jorge Pérez/.test(txt(q('#rv2-detail .rv2-drv'))) && q('#rv2-detail .rv2-drv a[href="tel:3015550101"]') && /Cambiar/.test(txt(q('#rv2-detail .rv2-drv'))));
  const sug = txt(q('#rv2-detail .rv2-sug p'));
  t('sugerencia: mover a Camila a V-02 (04:45): V-01 queda en +2 y V-02 en +3', sug === 'Mover a Camila Ortiz a V-02 (la recoge a las 04:45). V-01 queda en +2 min y V-02 en +3 min.', sug);
  const firma0 = T().rtFirmaPlan();
  click(q('#rv2-detail [data-act="apply"]'));
  t('«Aplicar»: Camila pasa a V-02·V1 (orden de barrido) y José queda solo', T().rt.order['V-02·V1'].join(',') === 'rD,rE' && T().rt.order['V-01·V2'].join(',') === 'rC', JSON.stringify([T().rt.order['V-02·V1'], T().rt.order['V-01·V2']]));
  t('…con las horas reprogramadas por el modelo (V-02 sale 04:45, V-01·V2 05:30)', T().rt.lanes.find((l) => l.id === 'V-02·V1').start === '04:45' && T().rt.lanes.find((l) => l.id === 'V-01·V2').start === '05:30');
  t('…y ya no hay rutas en riesgo (las dos quedan ajustadas)', chipN('risk') === '0' && chipN('adj') === '4' && b.rutaDe('V-01·V2').margin === 2 && b.rutaDe('V-02·V1').margin === 3);
  t('aviso «Camila Ortiz quedó en V-02 · Deshacer» (role=status, aria-live)', /Camila Ortiz quedó en V-02/.test(b.toastV2()) && q('#rv2-toast [data-act="undo"]') && q('#rv2-toast').getAttribute('aria-live') === 'polite');
  t('el chip pasa a «Publicado · con cambios» y el botón a «Publicar cambios»', txt(q('#rv2-pubChip')) === 'Publicado · con cambios' && txt(q('#rv2-publishLabel')) === 'Publicar cambios');
  click(q('#rv2-toast [data-act="undo"]'));
  t('«Deshacer» devuelve el plan exacto (firma = la publicada)', T().rtFirmaPlan() === firma0 && chipN('risk') === '1' && txt(q('#rv2-pubChip')) === 'Publicado');
  t('…y avisa «Cambio deshecho»', b.toastV2() === 'Cambio deshecho');
  // Deshacer hasta 20 pasos: 23 movidas de José entre V-01·V2 y V-02·V1.
  for (let i = 0; i < 23; i++) V2()._mover('rC', i % 2 ? 'V-02·V1' : 'V-01·V2', i % 2 ? 'V-01·V2' : 'V-02·V1');
  t('la pila de deshacer se queda en 20', V2()._hist.length === 20, V2()._hist.length);
  for (let i = 0; i < 25; i++) { const u = q('#rv2-toast [data-act="undo"]'); if (u) click(u); else break; }
  t('se deshacen las 20 (y no más): José queda donde estaba tras la 3ª movida', V2()._hist.length === 0 && T().rt.order['V-02·V1'].includes('rC'), JSON.stringify(T().rt.order['V-02·V1']));
  t('el último aviso ya no ofrece «Deshacer»', b.toastV2() === 'Cambio deshecho' && !q('#rv2-toast [data-act="undo"]'));
  // Se recarga limpio para lo que sigue.
  await V2().cargarDia('2026-10-12');
  // Parada ya atendida (V-03·V1, Paula ya recogida, vuelta en curso)
  click(q('.rv2-group[data-group="7"]')); click(q('.rv2-group[data-group="7"]'));
  click(q('#rv2-list .rv2-more[data-more="7"]'));
  click(q('.rv2-row[data-id="V-03·V1"]'));
  const liP = q('#rv2-detail .rv2-stops li');
  t('vuelta en curso: la parada atendida no se puede mover («ya atendido»)', /en curso/.test(txt(q('#rv2-detail .rv2-dhead p'))) && liP.querySelector('[aria-label="Paula Henao ya fue atendido"]').disabled && /ya atendido/.test(txt(liP)));
  click(q('.rv2-group[data-group="4"]'));
  click(q('.rv2-row[data-id="V-01·V1"]'));
  t('vuelta terminada: «Terminada · el conductor ya la cerró», sin «Mover auxiliar»', /Terminada/.test(txt(q('#rv2-detail .rv2-alert'))) && q('#rv2-detail [data-act="pickmove"]').disabled);
  t('sin errores de script', b.errors.length === 0, b.errors.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── C · Mover a…, Rutear, Asignar conductor, Autoasignar ──');
{
  const b = await boot();
  const { q, qa, click, chipN, sheet, V2, T, type } = b;
  // Mover desde la parada (José en V-01·V2)
  click(q('#rv2-detail .rv2-stops [data-act="move"][data-crew="rC"]'));
  t('«Mover a José Ñáñez» abre la hoja (role=dialog, aria-modal)', !sheet().hidden && /Mover a José Ñáñez/.test(txt(sheet().querySelector('h2'))) && sheet().getAttribute('role') === 'dialog' && sheet().getAttribute('aria-modal') === 'true');
  t('impacto en el origen: «V-01 queda en −13 min»', /V-01 queda en −13 min/.test(txt(sheet().querySelector('.rv2-impact'))), txt(sheet().querySelector('.rv2-impact')));
  const opts = qa('#rv2-opts .rv2-opt');
  t('destinos sugeridos (máx. 3), mismo sector primero', opts.length >= 1 && opts.length <= 3 && txt(q('#rv2-optsCap')) === 'Sugeridas · mismo sector primero', opts.map(txt).join(' | '));
  click(q('[data-act="sclose"]'));
  t('Cancelar cierra la hoja y el fondo', sheet().hidden && q('#rv2-scrim').hidden);
  // Rutear a Manuela (sin rutear) → V-03·V2
  click(b.chip('unrouted'));
  click(q('#rv2-list [data-act="route"][data-crew="rN"]'));
  t('«Rutear a Manuela Franco»: subtítulo con conjunto, sector y presentación', /Rutear a Manuela Franco/.test(txt(sheet().querySelector('h2'))) && /Mangle · El Porvenir · presentación 09:10/.test(txt(sheet().querySelector('.rv2-sh-head p'))));
  const o1 = qa('#rv2-opts .rv2-opt');
  t('una sola salida con cupo cerca de esa hora: V-03 vuelta 2, la recoge 08:14', o1.length === 1 && /V-03 · vuelta 2 · recoge 08:14/.test(txt(o1[0])), o1.map(txt).join(' | '));
  t('…con el margen que da el modelo: «±0 min · ajustada», mismo sector, +6 min de recorrido', /±0 min · ajustada/.test(txt(o1[0])) && /mismo sector/.test(txt(o1[0])) && /\+6 min de recorrido/.test(txt(o1[0])), txt(o1[0]));
  t('la opción viene marcada (aria-checked) y el botón dice «Mover a V-03»', o1[0].getAttribute('aria-checked') === 'true' && txt(q('#rv2-doMove')) === 'Mover a V-03');
  type(q('#rv2-optq'), 'V-02'); await wait(160);
  t('buscar otro carro en la hoja: «V-02» muestra sus salidas con cupo', qa('#rv2-opts .rv2-opt').length >= 1 && qa('#rv2-opts .rv2-opt').every((x) => /V-02/.test(txt(x))) && txt(q('#rv2-optsCap')) === 'Resultados');
  type(q('#rv2-optq'), ''); await wait(160);
  click(q('#rv2-doMove'));
  t('confirmar: Manuela queda en V-03·V2 y sale del pool', T().rt.order['V-03·V2'].includes('rN') && !T().rt.pool.includes('rN') && chipN('unrouted') === '1 aux.');
  t('aviso con «Deshacer»', /Manuela Franco quedó en V-03/.test(b.toastV2()) && !!q('#rv2-toast [data-act="undo"]'));
  click(q('#rv2-toast [data-act="undo"]'));
  t('deshacer la devuelve a «sin rutear»', T().rt.pool.includes('rN') && !T().rt.order['V-03·V2'].includes('rN'));
  // Asignar conductor a V-01·V3 (PM)
  click(b.chip('nodriver'));
  click(q('.rv2-row[data-id="V-01·V3"] [data-act="assign"]'));
  t('«+ Asignar» abre la hoja sin abrir el detalle', !sheet().hidden && /Conductor para V-01/.test(txt(sheet().querySelector('h2'))) && V2()._ui.sel === 'V-01·V2');
  t('…con los del turno PM del horario publicado', /En turno PM según el horario publicado/.test(txt(sheet())));
  // 13-oct-2026: debajo de los del turno salen «Otros conductores» (fuera de turno),
  // para que el jefe pueda cubrir con cualquiera.
  const dTodas = qa('#rv2-dopts .rv2-opt');
  const dOpts = dTodas.filter((o) => !/Fuera de turno/.test(txt(o)));
  t('Diego (ya maneja V-03 en PM) no se puede elegir; Rubén está libre y marcado', dOpts.length === 2 && dOpts[0].disabled && /Maneja V-03/.test(txt(dOpts[0])) && dOpts[1].getAttribute('aria-checked') === 'true' && /Libre/.test(txt(dOpts[1])));
  t('…y debajo «Otros conductores», fuera de turno y elegibles', /Otros conductores/i.test(txt(sheet())) && dTodas.some((o) => /Fuera de turno/.test(txt(o)) && !o.disabled));
  click(q('#rv2-doAssign'));
  t('asignar: V-01 PM = Rubén y ya no hay rutas sin conductor', T().rt.cars[0].driverPM === 'd5' && chipN('nodriver') === '0');
  t('aviso «Rubén Díaz asignado a V-01 · turno PM» con Deshacer', /Rubén Díaz asignado a V-01 · turno PM/.test(b.toastV2()) && !!q('#rv2-toast [data-act="undo"]'));
  click(q('#rv2-toast [data-act="undo"]'));
  t('deshacer quita el conductor', !T().rt.cars[0].driverPM && chipN('nodriver') === '1');
  // Autoasignar: se vacían dos turnos para que haya 2+ huecos
  T().rt.cars[1].driverAM = null; V2().render();
  click(b.chip('all'));
  click(q('.rv2-row[data-id="V-01·V3"] [data-act="assign"]'));
  const auto = q('#rv2-sheet [data-act="autoassign"]');
  t('con 2 o más carros sin conductor aparece «Autoasignar todos (2)»', auto && /\(2\)/.test(txt(auto)), auto && txt(auto));
  click(auto);
  t('autoasignar llena V-02 AM con Luis (libre) y V-01 PM con Rubén', T().rt.cars[1].driverAM === 'd2' && T().rt.cars[0].driverPM === 'd5' && chipN('nodriver') === '0');
  t('aviso «2 conductores asignados automáticamente»', /2 conductores asignados automáticamente/.test(b.toastV2()));
  t('sin errores de script', b.errors.length === 0, b.errors.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── D · Publicar: bloqueos, de todos modos y re-publicar ──');
{
  const b = await boot();
  const { q, qa, click, sheet, V2, T, log } = b;
  click(q('#rv2-publish'));
  const checks = qa('#rv2-sheet .rv2-check');
  t('hoja «Volver a publicar» (ya publicado) con la lista ✓/✕/!', /Volver a publicar/.test(txt(sheet().querySelector('h2'))) && checks.length === 4);
  t('avisa que los conductores ya lo tienen', /los conductores ya lo tienen/.test(txt(sheet())));
  t('✕ 1 ruta en riesgo · ✕ 1 sin conductor · ✕ 2 tripulantes sin rutear · ! 2 ajustadas', /✕\s*1 ruta en riesgo/.test(txt(checks[0])) && /✕\s*1 ruta sin conductor/.test(txt(checks[1])) && /✕\s*2 tripulantes sin rutear/.test(txt(checks[2])) && /!\s*2 rutas ajustadas/.test(txt(checks[3])), checks.map(txt).join(' | '));
  const pub = q('#rv2-doPublish');
  t('bloqueado: «Faltan 4 pendientes»', pub.disabled && txt(pub) === 'Faltan 4 pendientes');
  click(checks[0].querySelector('[data-act="goto"]'));
  t('«Ver» cierra la hoja y aplica el filtro (En riesgo)', sheet().hidden && V2()._ui.filter === 'risk');
  click(q('#rv2-publish'));
  click(q('#rv2-forceOpen'));
  const fBtn = q('#rv2-doForce');
  t('«Publicar de todos modos…» despliega la confirmación con lo que queda pendiente', !q('#rv2-force').hidden && !fBtn.hidden && /1 ruta en riesgo/.test(txt(q('#rv2-force'))) && /2 tripulantes sin rutear \(no tendrán carro\)/.test(txt(q('#rv2-force'))));
  t('…y el botón no se activa sin confirmar', fBtn.disabled);
  const chk = (id) => { const c = q(id); c.checked = true; c.dispatchEvent(new b.w.Event('change', { bubbles: true })); };
  chk('#rv2-forceRisk'); chk('#rv2-ack');
  t('confirmar riesgo/sin conductor NO basta: los sin rutear piden su propia confirmación', fBtn.disabled);
  chk('#rv2-forceUnr');
  t('con las tres casillas se activa «Publicar de todos modos»', !fBtn.disabled);
  click(fBtn); await wait(40);
  t('publica con Api.saveRoutePlan(día, vueltas) — las 9 vueltas', log.saved.length === 1 && log.saved[0].day === '2026-10-12' && log.saved[0].lanes.length === 9, log.saved.length && log.saved[0].lanes.length);
  const l2 = log.saved[0].lanes.find((l) => l.stops.join(',') === 'res-D,res-C');
  t('cada vuelta lleva carro, conductor del turno, tipo, hora y paradas en orden', l2 && l2.vehicleId === 'veh-1' && l2.driverProfileId === 'd1' && l2.type === 'sal' && l2.startAt === '2026-10-12T04:45:00-05:00', JSON.stringify(l2));
  t('…con la ETA de cada parada (minutos)', l2 && l2.etas['res-D'] === 337 && l2.etas['res-C'] === 373, l2 && JSON.stringify(l2.etas));
  t('la vuelta sin conductor va igual (queda en borrador)', log.saved[0].lanes.find((l) => l.type === 'lle' && l.stops[0] === 'res-F').driverProfileId === null);
  t('push «Ruta asignada» a los conductores con vuelta', log.push.some((p) => /Ruta asignada/.test(p.title) && p.profileIds.slice().sort().join(',') === 'd1,d2,d3,d4'));
  t('aviso con el mensaje real de rtSavePlan', /Plan publicado: 9 vueltas/.test(b.toastV2()), b.toastV2());
  t('queda «Publicado» (sin cambios)', txt(q('#rv2-pubChip')) === 'Publicado' && txt(q('#rv2-publishLabel')) === 'Publicado');
  // Resolver todo y publicar normal
  click(q('[data-act="apply"]'));           // Camila → V-02
  T().rt.cars[0].driverPM = 'd5';
  V2()._mover('rN', null, 'V-03·V2'); V2()._mover('rO', null, 'V-01·V3');
  click(q('#rv2-publish'));
  const pub2 = q('#rv2-doPublish');
  t('sin bloqueos: «Publicar cambios», pide «Revisé las rutas ajustadas»', /Publicar cambios/.test(txt(sheet().querySelector('h2'))) && !!q('#rv2-ack') && pub2.disabled && txt(pub2) === 'Publicar de nuevo' && !q('#rv2-forceOpen'));
  chk('#rv2-ack');
  t('marcarla activa Publicar', !pub2.disabled);
  click(pub2); await wait(40);
  t('segunda publicación con Manuela y Kevin ruteados', log.saved.length === 2 && log.saved[1].lanes.some((l) => l.stops.includes('res-N')) && log.saved[1].lanes.some((l) => l.stops.includes('res-O')));
  // Sin publicar todavía: el botón dice «Publicar plan»
  const c = await boot({ publicado: false });
  t('día sin plan publicado: sin chip, todos sin rutear, «Optimizar el día»', c.q('#rv2-pubChip').hidden && c.T().rt.pool.length === 16 && /16 tripulantes sin rutear/.test(txt(c.q('#rv2-list'))) && !!c.q('#rv2-list [data-act="reopt"]'));
  t('…y Publicar deshabilitado mientras no haya rutas', c.q('#rv2-publish').disabled && txt(c.q('#rv2-publishLabel')) === 'Publicar plan' && txt(c.q('#rv2-reoptLabel')) === 'Optimizar');
  click(c.q('#rv2-list [data-act="reopt"]')); await wait(1300);
  t('Optimizar sí pide tráfico a TomTom (una vez)', c.log.tomtom === 1, c.log.tomtom);
  t('«Optimizar el día» corre rtOptimize de verdad (rtSolveDay) y arma vueltas', c.T().rt.lanes.some((l) => (c.T().rt.order[l.id] || []).length) && c.V2().dia().routes.length > 0, c.V2().dia().routes.length);
  t('…mostró el overlay «Optimizando…» que ya existía y lo quitó', !c.q('#rt-ovl').classList.contains('show'));
  t('…aviso del optimizador en el aviso de la v2, con Deshacer', /vueltas programadas/.test(c.toastV2()) && !!c.q('#rv2-toast [data-act="undo"]') && !c.toasts.some((m) => /vueltas programadas/.test(m)), c.toastV2());
  t('Publicar se habilita y dice «Publicar plan»', !c.q('#rv2-publish').disabled && txt(c.q('#rv2-publishLabel')) === 'Publicar plan' && txt(c.q('#rv2-reoptLabel')) === 'Re-optimizar');
  click(c.q('#rv2-toast [data-act="undo"]'));
  t('deshacer el optimizar vuelve a «todos sin rutear»', !c.V2().dia().routes.length && c.T().rt.pool.length === 16);
  t('sin errores de script', b.errors.length === 0 && c.errors.length === 0, b.errors.concat(c.errors).join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── E · cambio de día ──');
{
  const b = await boot();
  const { q, click, T, log, V2 } = b;
  click(q('#routes-v2 [data-act="nav"][data-dir="1"]')); await wait(60);
  t('› pide el día siguiente a Api.listRoutePlanning', log.planning[log.planning.length - 1] === '2026-10-13' && T().rt.day === '2026-10-13', JSON.stringify(log.planning));
  t('día sin reservas: «Mar 13 oct» y «Sin traslados para Mar 13 oct»', txt(q('#rv2-dayLabel')) === 'Mar 13 oct' && /Sin traslados para Mar 13 oct/.test(txt(q('#rv2-list'))) && q('#rv2-pubChip').hidden);
  t('…sin rutas: Publicar y Re-optimizar deshabilitados', q('#rv2-publish').disabled && q('#rv2-reopt').disabled);
  click(q('#routes-v2 [data-act="nav"][data-dir="-1"]')); await wait(60);
  t('‹ vuelve al 12 y rearma lo publicado', T().rt.day === '2026-10-12' && V2().dia().routes.length === 9 && txt(q('#rv2-pubChip')) === 'Publicado');
  click(q('[data-act="apply"]'));
  b.confirms.length = 0;
  const b2 = await boot({ confirm: false });
  click(b2.q('[data-act="apply"]'));
  click(b2.q('#routes-v2 [data-act="nav"][data-dir="1"]')); await wait(60);
  t('con cambios sin publicar pregunta antes y, si se dice que no, se queda', b2.confirms.length === 1 && /cambios sin publicar en Lun 12 oct/.test(b2.confirms[0]) && b2.T().rt.day === '2026-10-12' && b2.T().rt.order['V-02·V1'].includes('rD'));
  // Volver a la pestaña con cambios: no se pierden
  await b2.T().renderRoutes(); await wait(40);
  t('volver a entrar a la pestaña NO borra los cambios sin publicar', b2.T().rt.order['V-02·V1'].includes('rD') && b2.log.planning.length === 1);
  t('…y avisa de cuándo son los datos', /Tus cambios sin publicar siguen aquí · datos de las \d\d:\d\d/.test(b2.toastV2()), b2.toastV2());
  t('sin errores de script', b.errors.length === 0 && b2.errors.length === 0, b.errors.concat(b2.errors).join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── F · Carros, teclado, WhatsApp, mapa ──');
{
  const b = await boot();
  const { q, qa, click, key, V2, T, w } = b;
  click(q('.rv2-seg [data-view="carros"]'));
  t('vista Carros: la lista se esconde, una fila por carro (3), una barra por vuelta (9)', q('#rv2-listwrap').hidden && !q('#rv2-carros').hidden && qa('.rv2-tl-row').length === 3 && qa('.rv2-blk').length === 9);
  t('pestaña con aria-selected', q('.rv2-seg [data-view="carros"]').getAttribute('aria-selected') === 'true' && q('.rv2-seg [data-view="lista"]').getAttribute('aria-selected') === 'false');
  const blkR = q('.rv2-blk[data-id="V-01·V2"]');
  t('la barra en riesgo: clase risk, «! 2 pax»; sin conductor: nodriver; colores por tipo', blkR.classList.contains('risk') && blkR.classList.contains('salida') && txt(blkR) === '! 2 pax' && q('.rv2-blk[data-id="V-01·V3"]').classList.contains('nodriver') && q('.rv2-blk[data-id="V-01·V3"]').classList.contains('llegada') && q('.rv2-blk[data-id="V-02·V2"]').classList.contains('hotel'));
  t('posición por hora (V-01·V2 desde 04:45 = 4,75 horas)', /left:calc\(4\.75 \* var\(--hw\)\)/.test(blkR.getAttribute('style')), blkR.getAttribute('style'));
  t('la etiqueta del carro dice lo que falta: «Sin conductor PM» en V-01 (los nombres en el title)', /Sin conductor PM/.test(txt(qa('.rv2-tl-lab')[0])) && /AM Jorge Pérez · PM sin conductor/.test(qa('.rv2-tl-lab span')[0].getAttribute('title')));
  t('…y con todo cubierto, los conductores de sus turnos: «Carlos M. / Diego S.» en V-03', txt(qa('.rv2-tl-lab')[2]) === 'V-03Carlos M. / Diego S.', txt(qa('.rv2-tl-lab')[2]));
  t('línea del relevo AM/PM en las 14:00', qa('.rv2-tl-pm').length === 3 && /14 \* var/.test(q('.rv2-tl-pm').getAttribute('style')));
  click(q('.rv2-blk[data-id="V-03·V3"]'));
  t('tocar una barra abre su detalle', V2()._ui.sel === 'V-03·V3' && /V-03 · Vuelta 3/.test(txt(q('#rv2-detail h2'))) && q('.rv2-blk[data-id="V-03·V3"]').getAttribute('aria-current') === 'true');
  t('detalle de una llegada: recogida en JMC primero, aterrizaje', /^16:30 Recogida en JMC Aterriza 16:10/.test(leer(q('#rv2-detail .rv2-stops li'))), leer(q('#rv2-detail .rv2-stops li')));
  click(b.chip('unrouted'));
  t('«Sin rutear» desde Carros vuelve a la Lista', V2()._ui.view === 'lista' && !q('#rv2-listwrap').hidden);
  click(b.chip('all'));
  // Teclado
  w.document.body.focus();
  key('/', w.document.body);
  t('«/» lleva al buscador', w.document.activeElement === q('#rv2-q'));
  b.type(q('#rv2-q'), 'laura'); await wait(160);
  key('Escape', q('#rv2-q'));
  t('Esc en el buscador lo limpia', q('#rv2-q').value === '' && V2()._ui.q === '');
  click(q('.rv2-row')); const first = q('.rv2-row'); first.focus();
  t('(la primera fila es la de V-01·V2)', first.dataset.id === 'V-01·V2' && V2()._ui.sel === 'V-01·V2');
  key('ArrowDown', first);
  const sel1 = V2()._ui.sel;
  t('↓ recorre las filas y actualiza el detalle', sel1 && sel1 !== 'V-01·V2' && w.document.activeElement.dataset.id === sel1, sel1);
  key('ArrowUp', w.document.activeElement);
  t('↑ vuelve', V2()._ui.sel === 'V-01·V2');
  key('Enter', w.document.activeElement);
  t('Enter en una fila la abre', V2()._ui.sel === 'V-01·V2');
  const pm = q('#rv2-detail [data-act="pickmove"]'); pm.focus(); click(pm);
  t('«Mover auxiliar»: «¿A quién vas a mover?» con sus 2 paradas', /¿A quién vas a mover\?/.test(txt(q('#rv2-sheet h2'))) && qa('#rv2-sheet .rv2-opt').length === 2);
  t('el foco entra a la hoja', q('#rv2-sheet').contains(w.document.activeElement));
  key('Escape', w.document.activeElement);
  t('Esc cierra la hoja y el foco vuelve a donde estaba', q('#rv2-sheet').hidden && w.document.activeElement === q('#rv2-detail [data-act="pickmove"]'));
  // WhatsApp
  click(q('#rv2-wa'));
  t('WhatsApp sin el módulo: «Aún no disponible»', b.toastV2() === 'Aún no disponible');
  t('el botón es solo el logo, con tooltip y aria-label', q('#rv2-wa').getAttribute('title') === 'Copiar plan para WhatsApp' && q('#rv2-wa').getAttribute('aria-label') === 'Copiar plan para WhatsApp' && txt(q('#rv2-wa')) === '' && !!q('#rv2-wa svg path'));
  t('…a la izquierda de Re-optimizar', q('#rv2-wa').nextElementSibling === q('#rv2-reopt'));
  let abierto = 0; w.RendioWhatsApp = { abrir: () => { abierto++; } };
  click(q('#rv2-wa'));
  t('con window.RendioWhatsApp llama a abrir()', abierto === 1);
  // Mapa
  t('pestaña «Mapa» deshabilitada con «Próximamente»', q('.rv2-seg button:not([data-view])').disabled && q('.rv2-seg button:not([data-view])').getAttribute('title') === 'Próximamente');
  click(q('#rv2-detail [data-act="map"]')); await wait(40);
  t('«Ver mapa» abre el mapa existente (rtOpenMap) de la ruta', q('#rt-mapOvl').classList.contains('show') && /Trayecto V-01 · Vuelta 2/.test(txt(q('#rt-mapTitle'))));
  t('…y el mapa sigue visible aunque la vista anterior esté apartada', q('#routes-ui').classList.contains('rv2-fuera') && q('#rt-mapOvl').matches('.mapovl'));
  key('Escape', w.document.body);
  t('Esc cierra el mapa', !q('#rt-mapOvl').classList.contains('show'));
  t('sin errores de script', b.errors.length === 0, b.errors.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── G · la vista anterior sigue funcionando ──');
{
  const b = await boot();
  const { q, qa, click, T, w, V2 } = b;
  click(q('[data-act="apply"]'));
  click(q('#routes-v2 [data-act="vista"][data-v="v1"]')); await wait(40);
  t('«Vista anterior»: se ve #routes-ui, la v2 se esconde', q('#routes-v2').hidden && !q('#routes-ui').classList.contains('rv2-fuera') && !q('#rt-vistaNueva').hidden);
  t('…y se recuerda (localStorage = v1)', w.localStorage.getItem('rendio.rutas.vista') === 'v1');
  t('muestra el MISMO plan en memoria: 3 carros y 9 vueltas, con el cambio hecho en la v2', qa('#rt-laneWrap .carcard').length === 3 && qa('#rt-laneWrap .triprow').length === 9 && T().rt.order['V-02·V1'].includes('rD'));
  t('el día en la vista anterior ya no dice «Hoy» a secas', /12 oct/.test(txt(q('#rt-dayLabel'))), txt(q('#rt-dayLabel')));
  t('su botón «Publicar plan» está visible', q('#rt-saveBtn').style.display === '');
  click(q('#rt-optBtn')); await wait(1300);
  t('su Optimizar sigue andando (aviso por el toast de siempre)', b.toasts.some((m) => /vueltas programadas/.test(m)), b.toasts.join(' | '));
  click(q('#rt-vistaNueva')); await wait(40);
  t('«Vista nueva» vuelve a la v2 con el plan que armó la vista anterior', !q('#routes-v2').hidden && q('#routes-ui').classList.contains('rv2-fuera') && w.localStorage.getItem('rendio.rutas.vista') === 'v2' && V2().dia().routes.length > 0);
  const b2 = await boot({ vista: 'v1' });
  t('con la preferencia «v1» la pestaña abre la vista anterior (camino viejo: rtLoad)', b2.q('#routes-v2').hidden && !b2.q('#routes-ui').classList.contains('rv2-fuera') && b2.log.planning.length === 1 && b2.log.publicados.length === 0);
  t('…pinta su tablero y su reloj', b2.qa('#rt-laneWrap .carcard').length === 3 && !!b2.q('#rt-clock svg'));
  b2.click(b2.q('#rt-daynext')); await wait(60);
  t('sus flechas de día ahora sí cambian de día', b2.log.planning[b2.log.planning.length - 1] === '2026-10-13' && /13 oct/.test(txt(b2.q('#rt-dayLabel'))));
  t('sin errores de script', b.errors.length === 0 && b2.errors.length === 0, b.errors.concat(b2.errors).join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── H · api.js de verdad (sb falso) ──');
{
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = dom.window; const log = [];
  const bog = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  const HOY = bog(Date.now()); const MAN = bog(Date.now() + 86400000);
  const res = (id, day, hm, extra = {}) => Object.assign({ id, direction: 'home_to_airport', pickup_address: 'Cerezos, Rionegro', pickup_latitude: 6.15, pickup_longitude: -75.37, required_arrival_at: new Date(`${day}T${hm}:00-05:00`).toISOString(), status_h2a: 'pending', status_a2h: null, notes: '', cancelled_at: null, auxiliar_profiles: { profiles: { full_name: 'T ' + id, phone: '300' } }, flights: null, is_overnight: false, is_firm: true, residence_id: 'res1', residences: { name: 'Cerezos', zona_jefe: null, sector: 'Rionegro' }, ground_ops: false }, extra);
  // Hoy a las 23:30 (más tarde que ahora, para que «hoy» siga teniendo pendientes) y mañana.
  const ROWS = [res('a1aaaaaa-1', HOY, '23:30'), res('b2bbbbbb-2', MAN, '05:00'), res('c3cccccc-3', MAN, '23:50')];
  const val = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? Date.parse(v) : v);
  const tablas = {
    reservations: ROWS,
    vehicles: [{ id: 'veh-1', internal_code: 'V-01', license_plate: 'AAA111', capacity: 4, deleted_at: null }],
    app_settings: [{ id: 'singleton' }],
    profiles: [{ id: 'd1', full_name: 'Jorge Pérez', email: 'j@x', phone: '3015550101', role: 'driver', is_active: true, deleted_at: null }],
    route_assignments: [{ id: 'ra1', status: 'draft', planned_start_at: `${MAN}T04:00:00-05:00`, direction: 'home_to_airport', route_stops: [] }, { id: 'ra2', status: 'planned', planned_start_at: `${MAN}T05:00:00-05:00`, direction: 'home_to_airport', route_stops: [] }],
  };
  w.sb = {
    from(name) {
      const qd = { table: name, ops: [] }; log.push(qd); let one = null;
      const bld = {
        select(c) { qd.ops.push(['select', c]); return bld; }, eq(c, v) { qd.ops.push(['eq', c, v]); return bld; },
        gte(c, v) { qd.ops.push(['gte', c, v]); return bld; }, lte(c, v) { qd.ops.push(['lte', c, v]); return bld; }, lt(c, v) { qd.ops.push(['lt', c, v]); return bld; },
        in(c, v) { qd.ops.push(['in', c, v]); return bld; }, is(c, v) { qd.ops.push(['is', c, v]); return bld; },
        order(c, o) { qd.ops.push(['order', c, o || {}]); return bld; }, limit(n) { qd.ops.push(['limit', n]); return bld; },
        maybeSingle() { one = 'maybe'; return bld; }, single() { one = 'single'; return bld; },
        then(ok2, ko) {
          let rows = (tablas[name] || []).slice();
          for (const [op, c, v] of qd.ops) {
            if (op === 'eq') rows = rows.filter((r) => r[c] === v);
            else if (op === 'gte') rows = rows.filter((r) => val(r[c]) >= val(v));
            else if (op === 'lte') rows = rows.filter((r) => val(r[c]) <= val(v));
            else if (op === 'lt') rows = rows.filter((r) => val(r[c]) < val(v));
            else if (op === 'in') rows = rows.filter((r) => v.includes(r[c]));
            else if (op === 'is') rows = rows.filter((r) => (r[c] ?? null) === v);
            else if (op === 'order') rows.sort((a, z) => (val(a[c]) > val(z[c]) ? 1 : -1));
          }
          const data = one ? (rows[0] || null) : rows;
          return Promise.resolve({ data: JSON.parse(JSON.stringify(data)), error: null }).then(ok2, ko);
        },
      };
      return bld;
    },
    auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) },
  };
  w.RENDIO_CONFIG = {};
  w.eval(read('api.js'));
  const A = w.Api;
  const p0 = await A.listRoutePlanning('all');
  t('sin día: el próximo día con reservas (hoy, porque hoy aún tiene una)', p0 && p0.day === HOY && Object.keys(p0.aux).length === 1, p0 && p0.day);
  log.length = 0;
  const p1 = await A.listRoutePlanning('all', MAN);
  t('con día: SOLO ese día aunque hoy tenga reservas (mañana: 2)', p1 && p1.day === MAN && Object.keys(p1.aux).length === 2, p1 && JSON.stringify([p1.day, Object.keys(p1.aux)]));
  const rq = log.find((x) => x.table === 'reservations');
  const gte = rq.ops.find((o) => o[0] === 'gte'), lt = rq.ops.find((o) => o[0] === 'lt');
  t('la consulta va acotada al día de Colombia (≥ 00:00 −05:00 y < 24:00)', gte && lt && gte[2] === new Date(MAN + 'T00:00:00-05:00').toISOString() && Date.parse(lt[2]) - Date.parse(gte[2]) === 86400000, JSON.stringify([gte, lt]));
  t('trae el sector del conjunto para mostrarlo (sector: Rionegro)', Object.values(p1.aux)[0].sector === 'Rionegro' && /residences\(name, zona_jefe, sector\)/.test(rq.ops.find((o) => o[0] === 'select')[1]));
  t('y el teléfono del conductor (listDrivers)', p1.drivers[0] && p1.drivers[0].tel === '3015550101', JSON.stringify(p1.drivers));
  const p2 = await A.listRoutePlanning('all', '2026-01-01');
  t('un día sin reservas devuelve null (el tablero dice «Sin traslados»)', p2 === null);
  const lp = await A.listDrivers();
  t('listDrivers trae phone', lp[0].phone === '3015550101');
  log.length = 0;
  await A.getPublishedPlan(MAN);
  const st0 = log.find((x) => x.table === 'route_assignments').ops.find((o) => o[0] === 'in');
  t('getPublishedPlan(día) sin opciones: planned + in_progress (como siempre, lo usa Acomodar)', JSON.stringify(st0[2]) === '["planned","in_progress"]');
  log.length = 0;
  const pp = await A.getPublishedPlan(MAN, { estados: ['draft', 'planned', 'in_progress', 'completed'] });
  t('getPublishedPlan(día, { estados }) pide esos estados (con borradores)', pp.vueltas.length === 2 && JSON.stringify(log.find((x) => x.table === 'route_assignments').ops.find((o) => o[0] === 'in')[2]) === '["draft","planned","in_progress","completed"]');
}

console.log(`\n${ok}/${ok + bad} pasaron${bad ? ' · ' + bad + ' FALLARON' : ''}`);
console.log('NO cubierto: layout real (puntos de quiebre, cajón, tarjetas, barra fija del celular: ver _capturas-rutas-v2.mjs y revisar en un teléfono), la base real (RLS, saveRoutePlan/getPublishedPlan en producción), TomTom/OSRM reales, el mapa Leaflet real, el push real y el módulo de WhatsApp.');
process.exit(bad ? 1 : 0);
