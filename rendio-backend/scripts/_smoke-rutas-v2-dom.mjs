// T9 · ADMIN › Rutas › Asignación v2 (entrega del UX, 10-oct-2026) — prueba jsdom.
//
// Carga index.html + admin-consola.js + admin-rutas.js + admin-rutas-v2.js (los
// de verdad, en UNA evaluación para poder tocar `rt`) con un Api FALSO que
// entrega un día de prueba (fixtures/rutas-v2-dia.js): reservas, carros,
// conductores, horario publicado, el plan ya publicado y una matriz de tiempos
// controlada (|xa − xb| + 2 min). El modelo de tiempos, el solver y el guardado
// son los de admin-rutas.js: la prueba no los reimplementa.
//
// Asignación SIMPLE (15-oct-2026): sin chips, filtros, barra de horas ni vista
// Carros. Comprueba:
//   A) la v2 por defecto rearma el plan publicado; los conductores publicados se
//      respetan y los huecos se llenan SOLOS con el horario publicado; una frase
//      con lo que falta; «Avisos» (sin carro, llega tarde) en palabras con un
//      botón; «Conductores» carro × turno («automático» / «elegido»); todas las
//      vueltas a la vista, por hora, con los tripulantes por nombre (arrastrables);
//      búsqueda sin tildes con <mark>;
//   B) el detalle con el mapa (Leaflet falso: JMC + paradas numeradas), paradas
//      con «Mover», la sugerencia en palabras, «Aplicar», «Deshacer» (20 pasos),
//      paradas atendidas / vuelta terminada no se mueven;
//   C) «Mover» dentro del detalle con la vista previa en el mapa, tocar el nombre
//      en la fila, arrastrar y soltar en otra vuelta, «Dejar sin carro»,
//      «Ubicar» desde Avisos, cambiar el conductor (intercambio) y el relleno
//      automático de un turno vacío;
//   D) Publicar: bloqueos, «Publicar de todos modos» con confirmación, lo que le
//      llega a Api.saveRoutePlan (con el conductor automático), re-publicar, y
//      Optimizar un día sin plan deja los conductores puestos;
//   E) cambio de día ‹ ›: lo automático no cuenta como cambio; los cambios
//      propios sí preguntan y sobreviven a salir y volver a la pestaña;
//   F) llegadas en el detalle, teclado (/, ↑↓, Enter, Esc), WhatsApp;
//   G) la vista anterior sigue en el código (RendioRutasV2.aVista('v1'));
//   H) api.js de verdad: listRoutePlanning(tipo, día) pide SOLO ese día aunque
//      hoy tenga reservas, sin día sigue siendo el próximo día con reservas;
//      getPublishedPlan acepta estados; listDrivers trae el teléfono.
//
// LO QUE NO CUBRE: layout (jsdom no lo hace: puntos de quiebre, cajón, tarjetas,
// arrastrar de verdad con el mouse, el mapa y sus teselas, barra fija del celular — eso lo miran las capturas de _capturas-rutas-v2.mjs y,
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
  const sheet = () => q('#rv2-sheet');
  const toastV2 = () => txt(q('#rv2-toast'));
  const rutaDe = (id) => V2().dia().byId[id];
  await T().renderRoutes();
  await wait(40);
  return { w, log, errors, toasts, confirms, q, qa, click, key, type, V2, T, rows, rowIds, sheet, toastV2, rutaDe };
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── A · resumen: frase, Avisos, Conductores automáticos, vueltas y búsqueda ──');
{
  const b = await boot();
  const { q, qa, type, rows, rowIds, V2, T, log } = b;
  const rt = T().rt;
  t('la v2 es la vista por defecto (#routes-v2 visible, la anterior apartada)', !q('#routes-v2').hidden && q('#routes-ui').classList.contains('rv2-fuera'));
  t('sin día pedido carga el próximo día con reservas (como siempre)', log.planning[0] === null && rt.day === '2026-10-12', JSON.stringify(log.planning));
  t('pide el plan publicado de ese día con draft/planned/in_progress/completed', log.publicados.length === 1 && log.publicados[0].day === '2026-10-12' && JSON.stringify(log.publicados[0].estados) === JSON.stringify(['draft', 'planned', 'in_progress', 'completed']), JSON.stringify(log.publicados));
  t('rearma las 9 vueltas publicadas (número de vuelta por carro)', rt.lanes.length === 9 && rt.lanes.map((l) => l.id).join(',') === 'V-01·V1,V-02·V1,V-01·V2,V-02·V2,V-03·V1,V-03·V2,V-02·V3,V-01·V3,V-03·V3', rt.lanes.map((l) => l.id).join(','));
  t('conductores: los publicados se respetan (V-01 AM Jorge, V-03 PM Diego) y el hueco se llena SOLO (V-01 PM Rubén, libre en el horario PM)',
    rt.cars[0].driverAM === 'd1' && rt.cars[2].driverPM === 'd4' && rt.cars[0].driverPM === 'd5' && rt.rv2Auto['V-01|pm'] === 'd5' && !rt.rv2Auto['V-01|am'], JSON.stringify([rt.cars.map((c) => [c.driverAM, c.driverPM]), rt.rv2Auto]));
  t('los no ruteados quedan en el pool (Manuela y Kevin)', rt.pool.slice().sort().join(',') === 'rN,rO', rt.pool.join(','));
  t('origen encadenado: la 2ª salida de V-01 sale de JMC', rt.lanes.find((l) => l.id === 'V-01·V2').origin === 'airport' && rt.lanes.find((l) => l.id === 'V-01·V1').origin === null);
  t('leer lo publicado NO le pide nada a TomTom (cobra por celda): tiempos por OSRM', log.tomtom === 0 && rt.etaSource === 'osrm', JSON.stringify([log.tomtom, rt.etaSource]));
  t('chip «Publicado · con cambios»: el conductor que puso la app todavía no lo tiene nadie', !q('#rv2-pubChip').hidden && txt(q('#rv2-pubChip')) === 'Publicado · con cambios', txt(q('#rv2-pubChip')));
  t('el día en la barra: «Lun 12 oct»', txt(q('#rv2-dayLabel')) === 'Lun 12 oct', txt(q('#rv2-dayLabel')));
  t('ya no hay chips, filtros por tipo, barra de horas ni vista Carros', !q('#rv2-chips') && !q('#rv2-type') && !q('#rv2-hist') && !q('.rv2-seg') && !q('#rv2-carros'));
  const say = leer(q('#rv2-say'));
  t('una sola frase: «Antes de publicar, revisa 3 avisos.» + «9 vueltas · 14 de 16 tripulantes con carro»', !q('#rv2-say').hidden && /^Antes de publicar, revisa 3 avisos ?\. 9 vueltas · 14 de 16 tripulantes con carro$/.test(say), say);
  t('el botón Publicar lleva el número de avisos (3)', txt(q('#rv2-pending')) === '3' && !q('#rv2-pending').hidden);
  const av = qa('#rv2-avisos .rv2-al li');
  t('Avisos: Manuela y Kevin sin carro y V-01 de las 05:35 (recoge 05:37, redondo hacia abajo) que llega 19 min tarde, en palabras', av.length === 3
    && /^Manuela Franco no tiene carro ?Salida · Presentación 09:10 · Mangle · El Porvenir/.test(leer(av[0])) && /no tiene carro/.test(leer(av[1]))
    && /^V-01 de las 05:35 llega 19 min tarde ?Llega a JMC 06:39 · presentación 06:30 · con 10 min de entrega/.test(leer(av[2])), av.map(leer).join(' | '));
  t('…cada aviso con UN botón: «Ubicar» (sin carro) y «Ver» (tarde)', av[0].querySelector('[data-act="route"][data-crew="rN"]') && txt(av[0].querySelector('button')) === 'Ubicar' && txt(av[2].querySelector('[data-act="ver"]')) === 'Ver');
  const cel = (car, b2) => q(`#rv2-drivers [data-act="assignslot"][data-car="${car}"][data-shift="${b2}"]`);
  t('Conductores: carro × turno (AM / PM) con quién maneja', qa('#rv2-drivers .hd').map(txt).join(',') === 'Turno AM,Turno PM' && qa('#rv2-drivers .car').map(txt).join(',') === 'V-01,V-02,V-03', qa('#rv2-drivers .hd').map(txt).join(','));
  t('…V-01 PM «Rubén D. · 1 vuelta · automático»; V-01 AM «Jorge P. · 1 vuelta · elegido» (la terminada ya no cuenta)', leer(cel('V-01', 'pm')) === 'Rubén D. 1 vuelta · automático' && leer(cel('V-01', 'am')) === 'Jorge P. 1 vuelta · elegido', [leer(cel('V-01', 'pm')), leer(cel('V-01', 'am'))].join(' | '));
  t('…V-02 no tiene vueltas PM: «Sin vueltas»', /Sin vueltas/.test(txt(qa('#rv2-drivers .cell.none')[0] || null)));
  const r = b.rutaDe('V-01·V2');
  t('modelo real: V-01·V2 sale 04:45, llega 06:39, margen −19 (con 10 min de entrega)', r && r.arrival === 399 && r.margin === -19 && r.status === 'risk', r && JSON.stringify([r.arrival, r.margin, r.status]));
  t('V-02·V2 es «Hotel» (pernocta) con +7 de margen (ya no se anuncia como «Ajustada»)', b.rutaDe('V-02·V2').type === 'hotel' && b.rutaDe('V-02·V2').margin === 7 && !/Ajustada/.test(txt(q('#routes-v2'))));
  t('turno por la hora de la vuelta (AM 02:30–14:00, PM después)', b.rutaDe('V-01·V2').shift === 'am' && b.rutaDe('V-01·V3').shift === 'pm');
  t('la vuelta terminada no es un aviso', b.rutaDe('V-01·V1').fija === 'completed' && b.rutaDe('V-01·V1').status === 'ok');
  const horas = qa('#rv2-list .rv2-hour strong').map((x) => txt(x).slice(0, 2));
  t('vueltas agrupadas por hora de llegada a JMC / aterrizaje: 04,05,06,07,08,11,15,16 — TODAS a la vista (9)', horas.join(',') === '04,05,06,07,08,11,15,16' && rows().length === 9, horas.join(',') + ' / ' + rows().length);
  t('encabezado con aviso: «06:00 – 07:00 · 1 vuelta · 1 con aviso»', /06:00 – 07:00 · 1 vuelta · 1 con aviso/.test(txt(qa('#rv2-list .rv2-hour').find((h) => /^06/.test(txt(h))))));
  const row = rows().find((x) => x.dataset.id === 'V-02·V2');
  t('la fila: horas, «Recoge → llega a JMC», tipo, carro, conductor y los tripulantes por nombre',
    txt(row.querySelector('.when b')) === '06:55 → 07:23' && /Recoge → llega a JMC/.test(txt(row.querySelector('.when'))) && txt(row.querySelector('.rv2-pill')) === 'Hotel'
    && txt(row.querySelector('.l1 .car')) === 'V-02' && txt(row.querySelector('.l1 .drv')) === 'Luis Arango'
    && row.querySelectorAll('.rv2-p').length === 2 && /Daniela Cano/.test(txt(row.querySelectorAll('.rv2-p')[0])) && /Sergio Molina/.test(txt(row)),
    [row.querySelector('.when b'), row.querySelector('.rv2-pill'), row.querySelector('.l1 .car'), row.querySelector('.l1 .drv')].map(txt).join(' | '));
  t('fila accesible: role=button, tabindex=0 y aria-label con carro, tipo, horas y nombres', row.getAttribute('role') === 'button' && row.getAttribute('tabindex') === '0' && /V-02, Hotel, 06:55 → 07:23, Daniela Cano, Sergio Molina/.test(row.getAttribute('aria-label')), row.getAttribute('aria-label'));
  const tarde = rows().find((x) => x.dataset.id === 'V-01·V2');
  t('la que llega tarde lo dice: «19 min tarde · presentación 06:30» (y queda marcada)', tarde.dataset.s === 'risk' && txt(tarde.querySelector('.late')) === '19 min tarde · presentación 06:30');
  const lle = rows().find((x) => x.dataset.id === 'V-01·V3');
  t('llegada: «15:00 → …» (aterriza → última entrega) y el conductor puesto solo', /^15:00 → \d\d:\d\d$/.test(txt(lle.querySelector('.when b'))) && /Aterriza → última entrega/.test(txt(lle)) && txt(lle.querySelector('.l1 .drv')) === 'Rubén Díaz');
  t('cada tripulante se puede arrastrar (draggable) o tocar para moverlo', tarde.querySelectorAll('.rv2-p[draggable="true"][data-drag][data-act="move"]').length === 2);
  t('…menos los de una vuelta terminada', [...rows().find((x) => x.dataset.id === 'V-01·V1').querySelectorAll('.rv2-p')].every((p) => p.disabled && !p.getAttribute('draggable')));
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
  t('por conductor (Rubén, puesto solo): la llegada de V-01', rowIds().join(',') === 'V-01·V3', rowIds().join(','));
  type(q('#rv2-q'), 'zzz'); await wait(160);
  t('sin coincidencias: «Sin resultados»', rows().length === 0 && /Sin resultados para «zzz»/.test(txt(q('#rv2-list'))));
  type(q('#rv2-q'), 'perez'); await wait(160);
  t('por conductor (Jorge Pérez): las 2 vueltas AM de V-01', rowIds().slice().sort().join(',') === 'V-01·V1,V-01·V2', rowIds().join(','));
  type(q('#rv2-q'), ''); await wait(160);
  t('sin errores de script', b.errors.length === 0, b.errors.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── B · detalle con mapa, sugerencia, aplicar y deshacer ──');
{
  const b = await boot();
  const { q, qa, click, V2, T, w } = b;
  t('en PC se abre sola la primera vuelta que llega tarde (V-01·V2)', V2()._ui.sel === 'V-01·V2' && /V-01 · Vuelta 2/.test(txt(q('#rv2-detail h2'))));
  t('la fila seleccionada lleva aria-current', q('.rv2-row[aria-current="true"]').dataset.id === 'V-01·V2');
  t('el detalle trae el mapa del recorrido (Leaflet): JMC + 2 paradas numeradas', !q('#rv2-mapwrap').hidden && !!q('#rv2-map') && w.L.__log.maps.length >= 1 && qa('#rv2-map .rv2-mk').length === 3 && !!q('#rv2-map .rv2-mk.jmc'), qa('#rv2-map .rv2-mk').length);
  const alerta = txt(q('#rv2-detail .rv2-alert'));
  t('alerta: «Llega tarde · llega 06:39; con 10 min de entrega no alcanza la presentación (06:30): 19 min tarde»', alerta === 'Llega tarde · llega 06:39; con 10 min de entrega no alcanza la presentación (06:30): 19 min tarde', alerta);
  const li = qa('#rv2-detail .rv2-stops li');
  t('paradas en orden de recogida: Camila 05:35, José 06:10 (horas redondas) y la llegada a JMC 06:39 (la del modelo)', li.length === 3 && /^05:35 Camila Ortiz Ébano · Marinilla · pres. 06:30/.test(leer(li[0])) && /^06:10 José Ñáñez/.test(leer(li[1])) && /^06:39 Llegada JMC Presentación 06:30 · 10 min de entrega · 19 min tarde/.test(leer(li[2])), li.map(leer).join(' | '));
  t('cada parada: llamar (tel:) y un botón «Mover» con texto', li[0].querySelector('a[href="tel:3001110004"]') && li[0].querySelector('a').getAttribute('aria-label') === 'Llamar a Camila Ortiz' && txt(li[0].querySelector('.rv2-mv')) === 'Mover');
  t('conductor con teléfono → botón de llamar; «Cambiar»', /Jorge Pérez/.test(txt(q('#rv2-detail .rv2-drv'))) && q('#rv2-detail .rv2-drv a[href="tel:3015550101"]') && /Cambiar/.test(txt(q('#rv2-detail .rv2-drv'))));
  t('ya no hay pie con «Ver mapa / Mover auxiliar / Conductor» (el mapa está a la vista)', !q('#rv2-detail .rv2-dfoot') && !q('#rv2-detail [data-act="pickmove"]'));
  const sug = txt(q('#rv2-detail .rv2-sug p'));
  t('sugerencia en palabras: mover a Camila a V-02 (04:45) y las dos llegan a tiempo', sug === 'Mover a Camila Ortiz a V-02 (la recoge a las 04:45). Así las dos vueltas llegan a tiempo.', sug);
  const firma0 = T().rtFirmaPlan();
  click(q('#rv2-detail [data-act="apply"]'));
  t('«Aplicar»: Camila pasa a V-02·V1 (orden de barrido) y José queda solo', T().rt.order['V-02·V1'].join(',') === 'rD,rE' && T().rt.order['V-01·V2'].join(',') === 'rC', JSON.stringify([T().rt.order['V-02·V1'], T().rt.order['V-01·V2']]));
  t('…con las horas reprogramadas por el modelo (V-02 sale 04:45, V-01·V2 05:30)', T().rt.lanes.find((l) => l.id === 'V-02·V1').start === '04:45' && T().rt.lanes.find((l) => l.id === 'V-01·V2').start === '05:30');
  t('…y ya nadie llega tarde (sale de Avisos)', !V2()._avisos().some((a) => a.k === 'risk') && b.rutaDe('V-01·V2').margin === 2 && b.rutaDe('V-02·V1').margin === 3 && txt(q('#rv2-pending')) === '2');
  t('aviso «Camila Ortiz quedó en V-02 · Deshacer» (role=status, aria-live)', /Camila Ortiz quedó en V-02/.test(b.toastV2()) && q('#rv2-toast [data-act="undo"]') && q('#rv2-toast').getAttribute('aria-live') === 'polite');
  t('el botón pasa a «Publicar cambios»', txt(q('#rv2-pubChip')) === 'Publicado · con cambios' && txt(q('#rv2-publishLabel')) === 'Publicar cambios');
  click(q('#rv2-toast [data-act="undo"]'));
  t('«Deshacer» devuelve el plan exacto', T().rtFirmaPlan() === firma0 && V2()._avisos().filter((a) => a.k === 'risk').length === 1);
  t('…y avisa «Cambio deshecho»', b.toastV2() === 'Cambio deshecho');
  // Deshacer hasta 20 pasos: 23 movidas de José entre V-01·V2 y V-02·V1.
  for (let i = 0; i < 23; i++) V2()._mover('rC', i % 2 ? 'V-02·V1' : 'V-01·V2', i % 2 ? 'V-01·V2' : 'V-02·V1');
  t('la pila de deshacer se queda en 20', V2()._hist.length === 20, V2()._hist.length);
  for (let i = 0; i < 25; i++) { const u = q('#rv2-toast [data-act="undo"]'); if (u) click(u); else break; }
  t('se deshacen las 20 (y no más): José queda donde estaba tras la 3ª movida', V2()._hist.length === 0 && T().rt.order['V-02·V1'].includes('rC'), JSON.stringify(T().rt.order['V-02·V1']));
  t('el último aviso ya no ofrece «Deshacer»', b.toastV2() === 'Cambio deshecho' && !q('#rv2-toast [data-act="undo"]'));
  await V2().cargarDia('2026-10-12');
  // Parada ya atendida (V-03·V1, Paula ya recogida, vuelta en curso)
  click(q('.rv2-row[data-id="V-03·V1"]'));
  const liP = q('#rv2-detail .rv2-stops li');
  t('vuelta en curso: la parada atendida no se puede mover («ya atendido»)', /en curso/.test(txt(q('#rv2-detail .rv2-dhead p'))) && liP.querySelector('.rv2-mv').disabled && /ya atendido/.test(txt(liP)) && q('.rv2-row[data-id="V-03·V1"] .rv2-p').disabled);
  click(q('.rv2-row[data-id="V-01·V1"]'));
  t('vuelta terminada: «Terminada · el conductor ya la cerró» y nadie se mueve', /Terminada/.test(txt(q('#rv2-detail .rv2-alert'))) && qa('#rv2-detail .rv2-mv').every((x) => x.disabled));
  t('sin errores de script', b.errors.length === 0, b.errors.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── C · Mover (en el detalle, con vista previa), arrastrar, Ubicar, sin carro, conductores ──');
{
  const b = await boot();
  const { q, qa, click, sheet, V2, T, type, w } = b;
  const ev = (el, name) => el.dispatchEvent(new w.Event(name, { bubbles: true, cancelable: true }));
  // Mover desde la parada (José en V-01·V2): se abre DENTRO del detalle, con el mapa a la vista
  click(q('#rv2-detail .rv2-stops [data-act="move"][data-crew="rC"]'));
  t('«Mover» abre «Mover a José Ñáñez a…» dentro del detalle (sin hoja encima del mapa)', sheet().hidden && /Mover a José Ñáñez a…/.test(txt(q('#rv2-detail .rv2-mvhead h3'))) && !q('#rv2-mapwrap').hidden && V2()._ui.moving.crew === 'rC');
  t('impacto en el origen, en palabras: «Sin José Ñáñez, V-01 sigue llegando 13 min tarde.»', /Sin José Ñáñez, V-01 sigue llegando 13 min tarde\./.test(txt(q('#rv2-detail .rv2-impact'))), txt(q('#rv2-detail .rv2-impact')));
  const opts = qa('#rv2-mvopts [data-act="moveto"]');
  t('vueltas con cupo cerca de esa hora (máx. 5), cada una dice qué pasaría', opts.length >= 1 && opts.length <= 5 && opts.every((o) => /a tiempo|llegaría \d+ min tarde|choca con su vuelta|esperarían/.test(txt(o.querySelector('.st')))), opts.map((o) => txt(o)).join(' | '));
  ev(opts[0], 'mouseover');
  t('pasar el cursor por una opción la muestra en el mapa («Vista previa: así quedaría …»)', /^Vista previa: así quedaría V-0\d \(\d\d:\d\d → \d\d:\d\d\) con José Ñáñez · /.test(txt(q('#rv2-mapNote'))) && q('#rv2-mapNote').classList.contains('is-prev') && !!q('#rv2-map .rv2-mk.new'), txt(q('#rv2-mapNote')));
  t('«Ver todas las vueltas con cupo» y «Dejar sin carro» al final', !!q('#rv2-detail [data-act="mvtodas"]') && !!q('#rv2-detail [data-act="unroute"][data-crew="rC"]'));
  click(q('#rv2-detail [data-act="mvcancel"]'));
  t('«Cancelar» vuelve a las paradas', !V2()._ui.moving && qa('#rv2-detail .rv2-stops li').length === 3);
  // Tocar el nombre en la fila abre lo mismo
  click(q('.rv2-row[data-id="V-01·V2"] .rv2-p[data-crew="rD"]'));
  t('tocar el nombre en la fila = «Mover» a esa persona', V2()._ui.sel === 'V-01·V2' && V2()._ui.moving && V2()._ui.moving.crew === 'rD' && /Mover a Camila Ortiz a…/.test(txt(q('#rv2-detail .rv2-mvhead h3'))));
  const op = q('#rv2-mvopts [data-act="moveto"][data-to="V-02·V1"]');
  t('…entre las opciones está la de la sugerencia (V-02, recoge 04:45, a tiempo)', op && /V-02 · vuelta 1 · recoge 04:45/.test(txt(op)) && txt(op.querySelector('.st')) === 'a tiempo', op && txt(op));
  click(op);
  t('tocar la opción mueve de una vez: Camila en V-02·V1', T().rt.order['V-02·V1'].includes('rD') && !V2()._ui.moving);
  t('…y el aviso dice el efecto: «Camila Ortiz quedó en V-02 · a tiempo · recoge 04:45»', /^Camila Ortiz quedó en V-02 · a tiempo · recoge 04:45/.test(b.toastV2()) && !!q('#rv2-toast [data-act="undo"]'), b.toastV2());
  click(q('#rv2-toast [data-act="undo"]'));
  // Arrastrar (PC)
  const chipC = q('.rv2-row[data-id="V-01·V2"] .rv2-p[data-drag="rC"]');
  ev(chipC, 'dragstart');
  const drop = qa('.rv2-row.is-drop').map((x) => x.dataset.id);
  t('arrastrar: se marcan solo las salidas con cupo (ni la suya, ni llegadas, ni terminadas/en curso)', q('#routes-v2').classList.contains('is-dragging') && drop.includes('V-02·V1') && !drop.includes('V-01·V2') && !drop.includes('V-01·V3') && !drop.includes('V-01·V1') && !drop.includes('V-03·V1'), drop.join(','));
  const dst = q('.rv2-row[data-id="V-02·V1"]');
  ev(dst, 'dragover');
  t('…la vuelta de destino se resalta al pasar', dst.classList.contains('is-over'));
  ev(dst, 'drop');
  t('soltar = mover: José queda en V-02·V1, con el efecto en el aviso', T().rt.order['V-02·V1'].includes('rC') && /^José Ñáñez quedó en V-02 · /.test(b.toastV2()) && !q('#routes-v2').classList.contains('is-dragging'), b.toastV2());
  click(q('#rv2-toast [data-act="undo"]'));
  t('deshacer lo devuelve', T().rt.order['V-01·V2'].includes('rC'));
  // Dejar sin carro
  click(q('.rv2-row[data-id="V-01·V2"]'));
  click(q('#rv2-detail .rv2-stops [data-act="move"][data-crew="rC"]'));
  click(q('#rv2-detail [data-act="unroute"]'));
  t('«Dejar sin carro»: va a los sin carro y aparece en Avisos', T().rt.pool.includes('rC') && !T().rt.order['V-01·V2'].includes('rC') && /José Ñáñez no tiene carro/.test(txt(q('#rv2-avisos'))) && /José Ñáñez quedó sin carro/.test(b.toastV2()));
  click(q('#rv2-toast [data-act="undo"]'));
  // Ubicar a Manuela (sin carro) desde Avisos → V-03·V2
  click(q('#rv2-avisos [data-act="route"][data-crew="rN"]'));
  t('«Ubicar» (desde Avisos): «Ubicar a Manuela Franco» con conjunto, sector y presentación', !sheet().hidden && /Ubicar a Manuela Franco/.test(txt(sheet().querySelector('h2'))) && /Mangle · El Porvenir · presentación 09:10/.test(txt(sheet().querySelector('.rv2-sh-head p'))));
  const o1 = qa('#rv2-opts .rv2-opt');
  t('una sola salida con cupo cerca de esa hora: V-03 vuelta 2, la recoge 08:10', o1.length === 1 && /V-03 · vuelta 2 · recoge 08:10/.test(txt(o1[0])), o1.map(txt).join(' | '));
  t('…en palabras: «a tiempo», mismo sector, +6 min de recorrido', txt(o1[0].querySelector('.st')) === 'a tiempo' && /mismo sector/.test(txt(o1[0])) && /\+6 min de recorrido/.test(txt(o1[0])), txt(o1[0]));
  t('la opción viene marcada (aria-checked) y el botón dice «Mover a V-03»', o1[0].getAttribute('aria-checked') === 'true' && txt(q('#rv2-doMove')) === 'Mover a V-03');
  type(q('#rv2-optq'), 'V-02'); await wait(160);
  t('buscar otro carro en la hoja: «V-02» muestra sus salidas con cupo', qa('#rv2-opts .rv2-opt').length >= 1 && qa('#rv2-opts .rv2-opt').every((x) => /V-02/.test(txt(x))) && txt(q('#rv2-optsCap')) === 'Resultados');
  type(q('#rv2-optq'), ''); await wait(160);
  click(q('#rv2-doMove'));
  t('confirmar: Manuela queda en V-03·V2 y sale de Avisos', T().rt.order['V-03·V2'].includes('rN') && !T().rt.pool.includes('rN') && V2()._avisos().filter((a) => a.k === 'unrouted').length === 1);
  t('aviso «Manuela Franco quedó en V-03 · a tiempo …» con «Deshacer»', /Manuela Franco quedó en V-03 · a tiempo/.test(b.toastV2()) && !!q('#rv2-toast [data-act="undo"]'), b.toastV2());
  click(q('#rv2-toast [data-act="undo"]'));
  t('deshacer la devuelve a «sin carro»', T().rt.pool.includes('rN') && !T().rt.order['V-03·V2'].includes('rN'));
  // Cambiar el conductor automático (V-01 PM: Rubén) por Diego, que maneja V-03 PM → se intercambian
  click(q('#rv2-drivers [data-act="assignslot"][data-car="V-01"][data-shift="pm"]'));
  t('tocar la casilla abre «Conductor para V-01» (turno PM, hoy Rubén, automático)', !sheet().hidden && /Conductor para V-01/.test(txt(sheet().querySelector('h2'))) && /Turno PM · aplica a todas sus vueltas de ese turno · hoy: Rubén Díaz \(automático\)/.test(txt(sheet().querySelector('.rv2-sh-head p'))), txt(sheet().querySelector('.rv2-sh-head p')));
  t('…con los del turno PM del horario publicado', /En turno PM según el horario publicado/.test(txt(sheet())));
  const dOpts = qa('#rv2-dopts .rv2-opt').filter((o) => !/Fuera de turno/.test(txt(o)));
  t('Diego (maneja V-03) se puede elegir: dice que se intercambian; Rubén es el actual', dOpts.length === 2 && !dOpts[0].disabled && /Maneja V-03/.test(txt(dOpts[0])) && /si lo eliges, Rubén Díaz pasa a V-03/.test(txt(dOpts[0])) && /Actual/.test(txt(dOpts[1])), dOpts.map(txt).join(' | '));
  click(dOpts[0]); click(q('#rv2-doAssign'));
  t('elegir a Diego los intercambia: V-01 PM Diego y V-03 PM Rubén', T().rt.cars[0].driverPM === 'd4' && T().rt.cars[2].driverPM === 'd5' && /Diego Salazar pasa a V-01 y Rubén Díaz a V-03 · turno PM/.test(b.toastV2()), b.toastV2());
  t('…y la casilla ya dice «elegido»', /elegido/.test(txt(q('#rv2-drivers [data-act="assignslot"][data-car="V-01"][data-shift="pm"]'))));
  click(q('#rv2-toast [data-act="undo"]'));
  t('deshacer vuelve a Rubén (automático)', T().rt.cars[0].driverPM === 'd5' && T().rt.cars[2].driverPM === 'd4' && /automático/.test(txt(q('#rv2-drivers [data-act="assignslot"][data-car="V-01"][data-shift="pm"]'))));
  // Un turno que se queda vacío se vuelve a llenar solo
  T().rt.cars[1].driverAM = null; V2().render();
  t('un turno vacío se llena solo con el libre del horario (V-02 AM → Luis)', T().rt.cars[1].driverAM === 'd2' && T().rt.rv2Auto['V-02|am'] === 'd2' && !V2()._avisos().some((a) => a.k === 'nodriver'));
  t('sin errores de script', b.errors.length === 0, b.errors.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── D · Publicar: bloqueos, de todos modos y re-publicar ──');
{
  const b = await boot();
  const { q, qa, click, sheet, V2, T, log } = b;
  click(q('#rv2-publish'));
  const checks = qa('#rv2-sheet .rv2-check');
  t('hoja «Publicar cambios» (lo publicado + el conductor puesto solo) con la lista ✓/✕', /Publicar cambios/.test(txt(sheet().querySelector('h2'))) && checks.length === 3, txt(sheet().querySelector('h2')) + ' / ' + checks.length);
  t('avisa que los conductores ya lo tienen', /los conductores ya lo tienen/.test(txt(sheet())));
  t('✕ 1 vuelta llega tarde · ✓ todos los carros con conductor · ✕ 2 tripulantes sin carro (y ya no hay «ajustadas»)', /✕\s*1 vuelta llega tarde/.test(txt(checks[0])) && /✓\s*Todos los carros con conductor/.test(txt(checks[1])) && /✕\s*2 tripulantes sin carro/.test(txt(checks[2])) && !q('#rv2-ack'), checks.map(txt).join(' | '));
  const pub = q('#rv2-doPublish');
  t('bloqueado: «Faltan 3 pendientes»', pub.disabled && txt(pub) === 'Faltan 3 pendientes', txt(pub));
  click(checks[0].querySelector('[data-act="goto"]'));
  t('«Ver» cierra la hoja y abre la vuelta que llega tarde', sheet().hidden && V2()._ui.sel === 'V-01·V2');
  click(q('#rv2-publish'));
  click(q('#rv2-forceOpen'));
  const fBtn = q('#rv2-doForce');
  t('«Publicar de todos modos…» despliega la confirmación con lo que queda pendiente', !q('#rv2-force').hidden && !fBtn.hidden && /1 vuelta que llega tarde a la presentación/.test(txt(q('#rv2-force'))) && /2 tripulantes sin carro/.test(txt(q('#rv2-force'))), txt(q('#rv2-force')));
  t('…y el botón no se activa sin confirmar', fBtn.disabled);
  const chk = (id) => { const c = q(id); c.checked = true; c.dispatchEvent(new b.w.Event('change', { bubbles: true })); };
  chk('#rv2-forceRisk');
  t('confirmar «llega tarde» NO basta: los sin carro piden su propia confirmación', fBtn.disabled);
  chk('#rv2-forceUnr');
  t('con las dos casillas se activa «Publicar de todos modos»', !fBtn.disabled);
  click(fBtn); await wait(40);
  t('publica con Api.saveRoutePlan(día, vueltas) — las 9 vueltas', log.saved.length === 1 && log.saved[0].day === '2026-10-12' && log.saved[0].lanes.length === 9, log.saved.length && log.saved[0].lanes.length);
  const l2 = log.saved[0].lanes.find((l) => l.stops.join(',') === 'res-D,res-C');
  t('cada vuelta lleva carro, conductor del turno, tipo, hora y paradas en orden', l2 && l2.vehicleId === 'veh-1' && l2.driverProfileId === 'd1' && l2.type === 'sal' && l2.startAt === '2026-10-12T04:45:00-05:00', JSON.stringify(l2));
  t('…con la hora REDONDA de cada parada (minutos; el carro llega 05:37 y 06:13)', l2 && l2.etas['res-D'] === 335 && l2.etas['res-C'] === 370, l2 && JSON.stringify(l2.etas));
  t('la llegada de V-01 va con el conductor que puso la app (Rubén)', log.saved[0].lanes.find((l) => l.type === 'lle' && l.stops[0] === 'res-F').driverProfileId === 'd5');
  t('push «Ruta asignada» a los conductores con vuelta (Rubén incluido)', log.push.some((p) => /Ruta asignada/.test(p.title) && p.profileIds.slice().sort().join(',') === 'd1,d2,d3,d4,d5'), JSON.stringify(log.push.map((p) => p.profileIds)));
  t('aviso con el mensaje real de rtSavePlan', /Plan publicado: 9 vueltas/.test(b.toastV2()), b.toastV2());
  t('queda «Publicado» (sin cambios)', txt(q('#rv2-pubChip')) === 'Publicado' && txt(q('#rv2-publishLabel')) === 'Publicado');
  // Resolver todo y publicar normal
  click(q('[data-act="apply"]'));           // Camila → V-02
  V2()._mover('rN', null, 'V-03·V2'); V2()._mover('rO', null, 'V-01·V3');
  click(q('#rv2-publish'));
  const pub2 = q('#rv2-doPublish');
  t('sin pendientes: «Publicar cambios», sin casillas que marcar', /Publicar cambios/.test(txt(sheet().querySelector('h2'))) && !q('#rv2-ack') && !pub2.disabled && txt(pub2) === 'Publicar de nuevo' && !q('#rv2-forceOpen'));
  t('…y la frase dice «Todo listo»', /^Todo listo\. Revisa lo que quieras y publica\./.test(leer(q('#rv2-say'))) && q('#rv2-say').classList.contains('is-ok') && q('#rv2-pending').hidden);
  click(pub2); await wait(40);
  t('segunda publicación con Manuela y Kevin con carro', log.saved.length === 2 && log.saved[1].lanes.some((l) => l.stops.includes('res-N')) && log.saved[1].lanes.some((l) => l.stops.includes('res-O')));
  // Sin publicar todavía
  const c = await boot({ publicado: false });
  t('día sin plan publicado: sin chip, todos sin carro, «Optimizar el día», sin tarjetas', c.q('#rv2-pubChip').hidden && c.T().rt.pool.length === 16 && /16 tripulantes sin carro/.test(txt(c.q('#rv2-list'))) && !!c.q('#rv2-list [data-act="reopt"]') && c.q('#rv2-summary').hidden);
  t('…la frase lo dice y Publicar queda deshabilitado', /16 tripulantes sin carro\. Optimiza el día para armar las vueltas\./.test(txt(c.q('#rv2-say'))) && c.q('#rv2-publish').disabled && txt(c.q('#rv2-publishLabel')) === 'Publicar plan' && txt(c.q('#rv2-reoptLabel')) === 'Optimizar');
  click(c.q('#rv2-list [data-act="reopt"]')); await wait(1300);
  t('Optimizar sí pide tráfico a TomTom (una vez)', c.log.tomtom === 1, c.log.tomtom);
  t('«Optimizar el día» corre rtOptimize de verdad (rtSolveDay) y arma vueltas', c.T().rt.lanes.some((l) => (c.T().rt.order[l.id] || []).length) && c.V2().dia().routes.length > 0, c.V2().dia().routes.length);
  t('…y los conductores quedan puestos SOLOS (ninguna vuelta sin conductor)', c.V2().dia().routes.every((r) => r.driverId) && !c.V2()._avisos().some((a) => a.k === 'nodriver') && Object.keys(c.T().rt.rv2Auto).length > 0, JSON.stringify(c.T().rt.rv2Auto));
  t('…mostró el overlay «Optimizando…» que ya existía y lo quitó', !c.q('#rt-ovl').classList.contains('show'));
  t('…aviso del optimizador en el aviso de la v2, con Deshacer', /vueltas programadas/.test(c.toastV2()) && !!c.q('#rv2-toast [data-act="undo"]') && !c.toasts.some((m) => /vueltas programadas/.test(m)), c.toastV2());
  t('Publicar se habilita y dice «Publicar plan»', !c.q('#rv2-publish').disabled && txt(c.q('#rv2-publishLabel')) === 'Publicar plan' && txt(c.q('#rv2-reoptLabel')) === 'Re-optimizar');
  click(c.q('#rv2-toast [data-act="undo"]'));
  t('deshacer el optimizar vuelve a «todos sin carro»', !c.V2().dia().routes.length && c.T().rt.pool.length === 16);
  t('sin errores de script', b.errors.length === 0 && c.errors.length === 0, b.errors.concat(c.errors).join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── E · cambio de día ──');
{
  const b = await boot();
  const { q, click, T, log, V2 } = b;
  click(q('#routes-v2 [data-act="nav"][data-dir="1"]')); await wait(60);
  t('el conductor que puso la app NO cuenta como «cambio sin publicar»: cambia de día sin preguntar', b.confirms.length === 0, b.confirms.join(' | '));
  t('› pide el día siguiente a Api.listRoutePlanning', log.planning[log.planning.length - 1] === '2026-10-13' && T().rt.day === '2026-10-13', JSON.stringify(log.planning));
  t('día sin reservas: «Mar 13 oct» y «Sin traslados para Mar 13 oct»', txt(q('#rv2-dayLabel')) === 'Mar 13 oct' && /Sin traslados para Mar 13 oct/.test(txt(q('#rv2-list'))) && q('#rv2-pubChip').hidden && q('#rv2-say').hidden);
  t('…sin rutas: Publicar y Re-optimizar deshabilitados', q('#rv2-publish').disabled && q('#rv2-reopt').disabled);
  click(q('#routes-v2 [data-act="nav"][data-dir="-1"]')); await wait(60);
  t('‹ vuelve al 12 y rearma lo publicado', T().rt.day === '2026-10-12' && V2().dia().routes.length === 9 && /^Publicado/.test(txt(q('#rv2-pubChip'))));
  const b2 = await boot({ confirm: false });
  click(b2.q('[data-act="apply"]'));
  click(b2.q('#routes-v2 [data-act="nav"][data-dir="1"]')); await wait(60);
  t('con cambios propios sin publicar pregunta antes y, si se dice que no, se queda', b2.confirms.length === 1 && /cambios sin publicar en Lun 12 oct/.test(b2.confirms[0]) && b2.T().rt.day === '2026-10-12' && b2.T().rt.order['V-02·V1'].includes('rD'));
  await b2.T().renderRoutes(); await wait(40);
  t('volver a entrar a la pestaña NO borra los cambios sin publicar', b2.T().rt.order['V-02·V1'].includes('rD') && b2.log.planning.length === 1);
  t('…y avisa de cuándo son los datos', /Tus cambios sin publicar siguen aquí · datos de las \d\d:\d\d/.test(b2.toastV2()), b2.toastV2());
  const b3 = await boot();
  await b3.T().renderRoutes(); await wait(40);
  t('volver a entrar SIN cambios propios recarga fresco (no dice «tus cambios»)', b3.log.planning.length === 2 && !/Tus cambios/.test(b3.toastV2() || ''), JSON.stringify(b3.log.planning));
  t('sin errores de script', b.errors.length === 0 && b2.errors.length === 0 && b3.errors.length === 0, b.errors.concat(b2.errors, b3.errors).join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── F · teclado, WhatsApp, llegadas en el detalle ──');
{
  const b = await boot();
  const { q, qa, click, key, V2, w } = b;
  click(q('.rv2-row[data-id="V-03·V3"]'));
  t('tocar una vuelta abre su detalle', V2()._ui.sel === 'V-03·V3' && /V-03 · Vuelta 3/.test(txt(q('#rv2-detail h2'))) && q('.rv2-row[data-id="V-03·V3"]').getAttribute('aria-current') === 'true');
  t('detalle de una llegada: recogida en JMC primero, aterrizaje', /^16:30 Recogida en JMC Aterriza 16:10/.test(leer(q('#rv2-detail .rv2-stops li'))), leer(q('#rv2-detail .rv2-stops li')));
  t('…cada hora dice qué es: «20 min para salir del aeropuerto» y «Llega a casa» en las entregas (14-oct)',
    /Aterriza 16:10 · 20 min para salir del aeropuerto/.test(leer(q('#rv2-detail .rv2-stops li'))) && qa('#rv2-detail .rv2-stops li:not(.end)').every((li) => /Llega a casa · /.test(leer(li))),
    leer(q('#rv2-detail .rv2-stops')));
  t('…y «última entrega» es la hora de la última parada, la misma de abajo',
    (txt(q('#rv2-detail .rv2-alert')).match(/última entrega (\d\d:\d\d)/) || [])[1] === leer(qa('#rv2-detail .rv2-stops li:not(.end)').pop()).slice(0, 5),
    txt(q('#rv2-detail .rv2-alert')));
  t('el mapa de una llegada sale de JMC (marcador verde) y se redibuja con la vuelta', qa('#rv2-map .rv2-mk.lle').length >= 1 && !!q('#rv2-map .rv2-mk.jmc'));
  // Teclado
  w.document.body.focus();
  key('/', w.document.body);
  t('«/» lleva al buscador', w.document.activeElement === q('#rv2-q'));
  b.type(q('#rv2-q'), 'laura'); await wait(160);
  key('Escape', q('#rv2-q'));
  t('Esc en el buscador lo limpia', q('#rv2-q').value === '' && V2()._ui.q === '');
  const first = q('.rv2-row'); click(first); first.focus();
  t('(la primera fila es la de V-01·V1)', first.dataset.id === 'V-01·V1' && V2()._ui.sel === 'V-01·V1');
  key('ArrowDown', first);
  const sel1 = V2()._ui.sel;
  t('↓ recorre las filas y actualiza el detalle', sel1 && sel1 !== 'V-01·V1' && w.document.activeElement.dataset.id === sel1, sel1);
  key('ArrowUp', w.document.activeElement);
  t('↑ vuelve', V2()._ui.sel === 'V-01·V1');
  key('Enter', w.document.activeElement);
  t('Enter en una fila la abre', V2()._ui.sel === 'V-01·V1');
  click(q('.rv2-row[data-id="V-01·V2"]'));
  click(q('#rv2-detail .rv2-stops [data-act="move"][data-crew="rC"]'));
  key('Escape', w.document.body);
  t('Esc cancela «Mover» y vuelve a las paradas', !V2()._ui.moving && !!q('#rv2-detail .rv2-stops'));
  // WhatsApp
  click(q('#rv2-wa'));
  t('WhatsApp sin el módulo: «Aún no disponible»', b.toastV2() === 'Aún no disponible');
  t('el botón es solo el logo, con tooltip y aria-label', q('#rv2-wa').getAttribute('title') === 'Copiar plan para WhatsApp' && q('#rv2-wa').getAttribute('aria-label') === 'Copiar plan para WhatsApp' && txt(q('#rv2-wa')) === '' && !!q('#rv2-wa svg path'));
  t('…a la izquierda de Re-optimizar', q('#rv2-wa').nextElementSibling === q('#rv2-reopt'));
  let abierto = 0; w.RendioWhatsApp = { abrir: () => { abierto++; } };
  click(q('#rv2-wa'));
  t('con window.RendioWhatsApp llama a abrir()', abierto === 1);
  t('sin errores de script', b.errors.length === 0, b.errors.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── G · la vista anterior sigue en el código (ya no se ofrece en pantalla) ──');
{
  const b = await boot();
  const { q, qa, click, T, w, V2 } = b;
  t('la v2 ya no muestra «Vista anterior»', !q('#routes-v2 [data-act="vista"]'));
  click(q('[data-act="apply"]'));
  await V2().aVista('v1'); await wait(40);
  t('RendioRutasV2.aVista(«v1»): se ve #routes-ui, la v2 se esconde', q('#routes-v2').hidden && !q('#routes-ui').classList.contains('rv2-fuera') && !q('#rt-vistaNueva').hidden);
  t('…y se recuerda (localStorage = v1)', w.localStorage.getItem('rendio.rutas.vista') === 'v1');
  t('muestra el MISMO plan en memoria: 3 carros y 9 vueltas, con el cambio hecho en la v2', qa('#rt-laneWrap .carcard').length === 3 && qa('#rt-laneWrap .triprow').length === 9 && T().rt.order['V-02·V1'].includes('rD'));
  t('el día en la vista anterior ya no dice «Hoy» a secas', /12 oct/.test(txt(q('#rt-dayLabel'))), txt(q('#rt-dayLabel')));
  click(q('#rt-vistaNueva')); await wait(40);
  t('«Vista nueva» vuelve a la v2 con el mismo plan', !q('#routes-v2').hidden && q('#routes-ui').classList.contains('rv2-fuera') && w.localStorage.getItem('rendio.rutas.vista') === 'v2' && V2().dia().routes.length > 0);
  t('sin errores de script', b.errors.length === 0, b.errors.join(' | '));
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
