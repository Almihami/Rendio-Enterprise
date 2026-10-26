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

async function boot({ vista = null, publicado = true, confirm = true, dias, horas } = {}) {
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
  const log = w.RV2Fixture.instalar(w.Api, { publicado, dias, horas });
  try {
    w.eval(read('admin-consola.js') + '\n' + read('admin-rutas.js') + '\n' + read('admin-rutas-v2.js') +
      '\n;window.__T = { rt, rtCarCompute, renderRoutes, rtFirmaPlan, rtLoad, rtSavePlan };');
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
console.log('\n── 25-oct · turnos abiertos: solo se piden si el día que se planea es hoy ──');
{
  const b = await boot();
  const { w, T } = b;
  const HOY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  let pedidos = 0;
  w.Api.listActiveShifts = async () => { pedidos++; return [
    { id: 's1', status: 'active', vehicles: { internal_code: null, license_plate: 'HYU376' }, driver_profiles: { profiles: { id: 'd9', full_name: 'Daniel Alvarez Torres' } } },
    { id: 's2', status: 'active', vehicles: { internal_code: 'V-07', license_plate: 'PRW443' }, driver_profiles: { profiles: { id: 'd10', full_name: 'Juan Andres Mery' } } },
    { id: 's3', status: 'active', vehicles: null, driver_profiles: null }]; };
  t('el día del fixture (no es hoy): no se piden', pedidos === 0 && T().rt.activos === null, JSON.stringify([pedidos, T().rt.activos]));
  // El mismo día de prueba, pero con la fecha de HOY.
  const orig = w.Api.listRoutePlanning;
  w.Api.listRoutePlanning = async (tipo) => { const r = await orig(tipo, undefined); return r && { ...r, day: HOY }; };
  await T().rtLoad(HOY); await wait(10);
  const act = T().rt.activos;
  t('cargando HOY: se piden y quedan con nombre y carro (placa si no hay código; sin conductor no entra)',
    pedidos === 1 && Array.isArray(act) && act.length === 2 && act[0].id === 'd9' && act[0].car === 'HYU376' && act[1].car === 'V-07' && act[1].n === 'Juan Andres Mery', JSON.stringify(act));
  w.Api.listActiveShifts = async () => { throw new Error('sin permiso'); };
  await T().rtLoad(HOY); await wait(10);
  t('si falla la lectura: sin turnos abiertos, el día carga igual', T().rt.activos === null && b.errors.length === 0, b.errors.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── 25-oct · plan publicado con horas a mano: la pantalla muestra las guardadas ──');
{
  // El plan del jefe del 26-oct se publicó con SUS horas (por WhatsApp, no con el
  // modelo). Asignación las recalculaba al abrir el día (Michell 08:35 → «08:55 ·
  // 17 min tarde») y «Publicar cambios» se las habría cambiado a todos.
  const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const laneDe = (x, k) => Object.keys(x.T().rt.order).find((l) => x.T().rt.order[l].includes('r' + k));
  const horasDe = (ru) => ru.stops.map((s) => hm(s.time)).join(',');
  // Sin horas guardadas: lo de siempre (el modelo).
  const b0 = await boot();
  const r0 = b0.rutaDe(laneDe(b0, 'H')), k0 = b0.rutaDe(laneDe(b0, 'K'));
  // El mismo plan publicado con horas a mano: H/G (ra-5) a las 04:40 y 04:55,
  // encima de la vuelta de E (04:35) del mismo carro; K/L (ra-9) salen de JMC
  // 15 min antes de lo que el modelo calcula que salen del terminal.
  const sK = k0.pickup - 15;
  const b = await boot({ horas: { 'ra-5': { start: '04:40', etas: { H: '04:40', G: '04:55' } }, 'ra-9': { start: hm(sK) } } });
  const lH = laneDe(b, 'H'), lK = laneDe(b, 'K');
  const r = b.rutaDe(lH), k = b.rutaDe(lK);
  t('salida con horas a mano: cada parada muestra la hora guardada', horasDe(r) === '04:40,04:55' && r.pickup === 280, JSON.stringify({ app: horasDe(r), modelo: horasDe(r0) }));
  t('…y no se corre aunque el carro venga de otra vuelta', r.retraso === 0 && r.depart === 280, JSON.stringify([r.retraso, r.depart]));
  t('…y la llegada a JMC sale de la última hora guardada (+ subir + tramo)', r.arrival > 295 && r.arrival < 295 + 60, r.arrival);
  t('llegada con hora a mano: sale de JMC a la hora guardada', k.pickup === sK, JSON.stringify({ app: k.pickup, guardada: sK, modelo: k0.pickup }));
  t('las horas guardadas no cuentan como cambio (la etiqueta dice lo mismo que sin ellas)', txt(b.q('#rv2-pubChip')) === txt(b0.q('#rv2-pubChip')), [txt(b.q('#rv2-pubChip')), txt(b0.q('#rv2-pubChip'))].join(' / '));
  // Volver a publicar sin tocar nada: las horas guardadas se conservan.
  await b.T().rtSavePlan({ toast() {} });
  const sv = b.log.saved[b.log.saved.length - 1];
  const lHG = sv && sv.lanes.find((l) => l.stops.join(',') === 'res-H,res-G');
  const lKL = sv && sv.lanes.find((l) => l.stops.join(',') === 'res-K,res-L');
  t('re-publicar sin tocar: salida con las mismas horas y el mismo arranque', !!lHG && lHG.etas['res-H'] === 280 && lHG.etas['res-G'] === 295 && /T04:40:00/.test(lHG.startAt), JSON.stringify(lHG));
  t('re-publicar sin tocar: la llegada con la misma salida de JMC', !!lKL && lKL.startAt.includes('T' + hm(sK) + ':00'), lKL && lKL.startAt);
  // Tocar la vuelta (sale G): vuelve al modelo. Deshacerlo: vuelve la hora guardada.
  const rt = b.T().rt;
  rt.order[lH] = ['rH'];
  const tocada = b.T().rtCarCompute(lH).stops[0];
  t('vuelta tocada: la hora vuelve a ser la del modelo', tocada.cita !== 280, JSON.stringify(tocada));
  rt.order[lH] = ['rH', 'rG'];
  t('…y si se deshace, vuelve la hora guardada', b.T().rtCarCompute(lH).stops[0].cita === 280);
  // Re-optimizar arma el día desde cero: ya no hay horas guardadas que respetar.
  t('el plan sin horas guardadas (como lo publica la app) se ve igual que antes', horasDe(b0.rutaDe(laneDe(b0, 'H'))) === horasDe(r0));
  t('sin errores de script', b.errors.length === 0 && b0.errors.length === 0, [...b.errors, ...b0.errors].join(' | '));
}

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
  // 25-oct-2026: quién más está en turno sin vueltas (la tarjeta va por carro con vueltas).
  {
    const usados = new Set();
    rt.cars.forEach((c) => ['am', 'pm'].forEach((k) => { const id = k === 'am' ? c.driverAM : c.driverPM; if (id) usados.add(id); }));
    const esperados = [...rt.shift.am, ...rt.shift.pm].filter((d) => !usados.has(d.id)).map((d) => d.n);
    const lib = q('#rv2-drivers .rv2-dfree');
    t('«También en turno, sin vueltas»: los del horario de esos turnos que no manejan ningún carro (' + (esperados.join(', ') || 'nadie') + ')',
      esperados.length ? (!!lib && leer(lib) === 'También en turno, sin vueltas: ' + esperados.join(', ') + '.') : !lib, lib ? leer(lib) : '(sin línea)');
    t('…sin «turno abierto»: el día que se mira no es hoy (no se piden los turnos abiertos)', !lib || !/turno abierto/.test(txt(lib)));
    // Si el día fuera hoy: los turnos abiertos (uno que no está en el horario, en V-02;
    // uno que ya maneja un carro del plan no sale).
    const conCarro = [...usados][0];
    rt.activos = [{ id: 'd9', n: 'Daniel Alvarez', car: 'V-02' }, { id: conCarro, n: 'Ya maneja', car: 'V-03' }];
    V2().render(); await wait(10);
    const lib2 = q('#rv2-drivers .rv2-dfree');
    t('con turnos abiertos: «Daniel Alvarez (turno abierto en V-02)», y quien ya maneja un carro del plan no sale',
      !!lib2 && /Daniel Alvarez \(turno abierto en V-02\)/.test(leer(lib2)) && !/Ya maneja/.test(leer(lib2)), lib2 && leer(lib2));
    rt.activos = null;
    // Uno más en el horario PM sin carro: sale por su nombre, sin «turno abierto».
    rt.shift.pm.push({ id: 'd8', n: 'Pedro Libre' });
    V2().render(); await wait(10);
    const lib3 = q('#rv2-drivers .rv2-dfree');
    t('uno del horario PM sin carro: «También en turno, sin vueltas: Pedro Libre.»', !!lib3 && txt(lib3) === 'También en turno, sin vueltas: Pedro Libre.', lib3 && leer(lib3));
    rt.shift.pm.pop();
    V2().render(); await wait(10);
  }
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
        gt(c, v) { qd.ops.push(['gt', c, v]); return bld; },
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
            else if (op === 'gt') rows = rows.filter((r) => val(r[c]) > val(v));
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
  // 0124: el plan va por conductor: «Carro 1…N» sin placa; la placa la pone el turno.
  t('0124: los carros del plan son «Carro 1» y «Carro 2» (Ajustes: 2), sin placa y con el cupo de la flota',
    p1.cars.map((c) => c.id).join(',') === 'Carro 1,Carro 2' && p1.cars.every((c) => c.vehicleId === null && c.capacity === 4), JSON.stringify(p1.cars));
  tablas.route_assignments[0].plan_car = 'Carro 2';
  const pp2 = await A.getPublishedPlan(MAN, { estados: ['draft', 'planned'] });
  const v1 = pp2.vueltas.find((v) => v.id === 'ra1'), v2 = pp2.vueltas.find((v) => v.id === 'ra2');
  t('0124: getPublishedPlan trae el carro del plan (planCar) y, sin placa, lo usa de nombre', v1.planCar === 'Carro 2' && v1.carro === 'Carro 2' && v1.placa === null && v2.planCar === null && v2.carro === 'Carro', JSON.stringify([v1.planCar, v1.carro, v2.carro]));
  t('0124: getPublishedPlan pide plan_car', /plan_car/.test(log.filter((x) => x.table === 'route_assignments').at(-1).ops.find((o) => o[0] === 'select')[1]));
  // 0125: la ruta de Julián del día trae su madrugada (0:20 del día siguiente),
  // y lo que Julián pegó con el día ANTERIOR viene marcado con ese día.
  const SIG = new Date(Date.parse(MAN + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
  const ANT = new Date(Date.parse(MAN + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);
  tablas.route_assignments.push(
    { id: 'ra-mad', status: 'planned', pool: true, manual_day: MAN, planned_start_at: `${SIG}T00:20:00-05:00`, direction: 'home_to_airport', deadline_at: `${SIG}T00:50:00-05:00`, manual_note: 'Va a hotel', route_stops: [] },
    { id: 'ra-ant', status: 'planned', pool: true, manual_day: ANT, planned_start_at: `${MAN}T01:10:00-05:00`, direction: 'airport_to_home', route_stops: [] },
    { id: 'ra-otro', status: 'planned', pool: true, manual_day: SIG, planned_start_at: `${SIG}T03:00:00-05:00`, direction: 'home_to_airport', route_stops: [] });
  const pp3 = await A.getPublishedPlan(MAN, { estados: ['draft', 'planned'] });
  const mad = pp3.vueltas.find((v) => v.id === 'ra-mad'), ant = pp3.vueltas.find((v) => v.id === 'ra-ant');
  t('0125: trae la madrugada que Julián pegó con este día (pool, su «Deben estar» y su nota)', mad && mad.pool === true && mad.manualDay === MAN && mad.deadlineAt && mad.nota === 'Va a hotel', JSON.stringify(mad));
  t('0125: lo del día anterior viene con su día (el tablero no lo vuelve a rutear) y lo de mañana no entra', ant && ant.manualDay === ANT && !pp3.vueltas.some((v) => v.id === 'ra-otro'), JSON.stringify(pp3.vueltas.map((v) => v.id)));
  tablas.route_assignments.splice(-3);
}

console.log('\n── 0124 · publicar sin placa (saveRoutePlan con sb falso) ──');
for (const sinColumna of [false, true]) {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = dom.window; const ins = [];
  const bld = (name) => {
    const st = { name, op: null, payload: null };
    const b2 = {
      select() { return b2; }, eq() { return b2; }, in() { return b2; }, gte() { return b2; }, lte() { return b2; }, not() { return b2; }, order() { return b2; },
      delete() { st.op = 'delete'; return b2; },
      insert(p) { st.op = 'insert'; st.payload = JSON.parse(JSON.stringify(p)); return b2; },
      single() { return b2; }, maybeSingle() { return b2; },
      then(ok2, ko) {
        let r = { data: [], error: null };
        if (st.op === 'insert') {
          ins.push([name, st.payload]);
          if (name === 'route_assignments' && sinColumna && st.payload.plan_car) r = { data: null, error: { code: '42703', message: 'column "plan_car" of relation "route_assignments" does not exist' } };
          else r = { data: name === 'route_assignments' ? { id: 'ra-' + ins.length } : null, error: null };
        } else if (name === 'driver_profiles') r = { data: [{ id: 'dp-1', profile_id: 'd1' }], error: null };
        return Promise.resolve(r).then(ok2, ko);
      },
    };
    return b2;
  };
  w.sb = { from: bld, auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } };
  w.RENDIO_CONFIG = {};
  w.eval(read('api.js'));
  const r = await w.Api.saveRoutePlan('2026-10-26', [{ vehicleId: null, planCar: 'Carro 1', driverProfileId: 'd1', type: 'lle', startAt: '2026-10-26T22:55:00-05:00', stops: ['res-1'], etas: {} }]);
  const ras = ins.filter((x) => x[0] === 'route_assignments').map((x) => x[1]);
  if (!sinColumna) {
    t('una vuelta SIN placa se publica (antes se saltaba en silencio)', r.saved === 1 && r.skipped === 0 && r.failed === 0, JSON.stringify(r));
    t('…con vehicle_id null, plan_car «Carro 1» y su conductor (la base le pone el carro del turno)', ras.length === 1 && ras[0].vehicle_id === null && ras[0].plan_car === 'Carro 1' && ras[0].driver_profile_id === 'dp-1' && ras[0].status === 'planned', JSON.stringify(ras));
    t('…y sus paradas', ins.some((x) => x[0] === 'route_stops' && Array.isArray(x[1]) && x[1][0].reservation_id === 'res-1'));
  } else {
    t('base sin 0124 (sin plan_car): reintenta sin la columna y publica igual', r.saved === 1 && r.failed === 0 && ras.length === 2 && 'plan_car' in ras[0] && !('plan_car' in ras[1]), JSON.stringify([r, ras]));
  }
}

console.log('\n── 0126 · api.js de verdad: publicar y leer la vuelta delegada ──');
for (const sin0126 of [false, true]) {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = dom.window; const ins = [], selects = [];
  const bld = (name) => {
    const st = { name, op: null, payload: null, sel: '' };
    const b2 = {
      select(x) { st.sel = String(x || ''); return b2; }, eq() { return b2; }, in() { return b2; }, gte() { return b2; }, lte() { return b2; }, gt() { return b2; }, not() { return b2; }, order() { return b2; }, limit() { return b2; },
      delete() { st.op = 'delete'; return b2; },
      insert(p) { st.op = 'insert'; st.payload = JSON.parse(JSON.stringify(p)); return b2; },
      single() { return b2; }, maybeSingle() { return b2; },
      then(ok2, ko) {
        let r = { data: [], error: null };
        const sinCol = { data: null, error: { code: '42703', message: 'column route_assignments.delegated_at does not exist' } };
        if (st.op === 'insert') {
          ins.push([name, st.payload]);
          if (name === 'route_assignments' && sin0126 && 'delegated_at' in st.payload) r = { data: null, error: { code: '42703', message: 'column "delegated_at" of relation "route_assignments" does not exist' } };
          else r = { data: name === 'route_assignments' ? { id: 'ra-' + ins.length } : null, error: null };
        } else if (name === 'route_assignments' && st.op !== 'delete') {
          selects.push(st.sel);
          if (sin0126 && /delegated_at/.test(st.sel)) r = sinCol;
          // El plan de antes: res-3 ya iba en una vuelta delegada.
          else if (/route_stops\(id, reservation_id, status\)/.test(st.sel)) r = { data: [{ id: 'old', status: 'planned', driver_profile_id: null, delegated_at: sin0126 ? undefined : '2026-10-25T23:00:00Z', driver_profiles: null, route_stops: [{ id: 'st-old', reservation_id: 'res-3', status: 'pending' }] }], error: null };
          else r = { data: [{ id: 'ra-x', direction: 'home_to_airport', status: 'planned', planned_start_at: '2026-10-26T04:15:00-05:00', driver_profile_id: null, vehicle_id: null, plan_car: 'Carro 2', pool: false, delegated_at: sin0126 ? undefined : '2026-10-25T23:00:00Z', route_stops: [] }], error: null };
        } else if (name === 'driver_profiles') r = { data: [{ id: 'dp-1', profile_id: 'd1' }], error: null };
        return Promise.resolve(r).then(ok2, ko);
      },
    };
    return b2;
  };
  w.sb = { from: bld, auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } };
  w.RENDIO_CONFIG = {};
  w.eval(read('api.js'));
  const r = await w.Api.saveRoutePlan('2026-10-26', [
    { vehicleId: 'veh-1', planCar: 'Carro 2', driverProfileId: null, delegated: true, type: 'sal', startAt: '2026-10-26T04:15:00-05:00', stops: ['res-2', 'res-3'], etas: { 'res-2': 255, 'res-3': 265 } },
    { vehicleId: null, planCar: 'Carro 1', driverProfileId: 'd1', type: 'sal', startAt: '2026-10-26T05:20:00-05:00', stops: ['res-4'], etas: {} }]);
  const ras = ins.filter((x) => x[0] === 'route_assignments').map((x) => x[1]);
  if (!sin0126) {
    const dl = ras.find((x) => x.plan_car === 'Carro 2');
    t('la delegada se publica: SIN conductor ni carro, «planned» (no borrador) y con delegated_at', r.saved === 2 && r.failed === 0 && dl && dl.driver_profile_id === null && dl.vehicle_id === null && dl.status === 'planned' && typeof dl.delegated_at === 'string', JSON.stringify([r, ras]));
    t('…con sus paradas y sus horas', ins.some((x) => x[0] === 'route_stops' && Array.isArray(x[1]) && x[1].length === 2 && x[1][0].reservation_id === 'res-2' && !!x[1][0].estimated_arrival_at));
    t('avisa solo a la recién delegada (res-2); la que ya iba delegada (res-3) no', JSON.stringify(r.notify.filter((n) => n.delegated).map((n) => n.reservationId)) === JSON.stringify(['res-2']), JSON.stringify(r.notify));
    t('la otra vuelta sale con su conductor, sin la marca', ras.find((x) => x.plan_car === 'Carro 1').driver_profile_id === 'dp-1' && !('delegated_at' in ras.find((x) => x.plan_car === 'Carro 1')));
    const pp = await w.Api.getPublishedPlan('2026-10-26', { estados: ['draft', 'planned'] });
    t('getPublishedPlan pide delegated_at y la marca la vuelta («delegated»); cuenta como publicado', /delegated_at/.test(selects.at(-1) || '') && pp.vueltas[0].delegated === true && pp.publicado === true, JSON.stringify([selects.at(-1), pp.vueltas[0] && pp.vueltas[0].delegated, pp.publicado]));
  } else {
    t('base sin 0126: la delegada NO se guarda como borrador a escondidas: falla y dice por qué', r.failed === 1 && /para delegar falta la actualización 0126/.test(r.failMsg) && ras.filter((x) => x.plan_car === 'Carro 2').length === 1, JSON.stringify([r, ras]));
    t('…la otra vuelta sí se publica, y leer el plan de antes reintenta sin la columna', r.saved === 1 && selects.some((x) => /delegated_at/.test(x)) && selects.some((x) => !/delegated_at/.test(x) && /route_stops\(id, reservation_id, status\)/.test(x)), JSON.stringify(selects));
    const pp = await w.Api.getPublishedPlan('2026-10-26', { estados: ['draft', 'planned'] });
    t('getPublishedPlan sin 0126: reintenta sin delegated_at y lee igual (nada delegado)', pp.vueltas.length === 1 && pp.vueltas[0].delegated === false, JSON.stringify(pp.vueltas));
  }
}

console.log('\n── 0124 · rearmar por carro del plan y la placa del turno ──');
{
  const b = await boot();
  const { q, T, V2, w } = b;
  const rt = T().rt;
  // El plan publicado ya no trae placa: cada vuelta vuelve a su carro del plan.
  const cel = (car, b2) => q(`#rv2-drivers [data-act="assignslot"][data-car="${car}"][data-shift="${b2}"]`);
  const id = rt.cars[0].driverPM;
  rt.activos = [{ id, n: 'x', car: 'PRW443' }];
  V2().render(); await wait(10);
  t('0124: la casilla dice en qué carro inició turno su conductor («· en PRW443»)', /· en PRW443/.test(txt(cel(rt.cars[0].id, 'pm'))), txt(cel(rt.cars[0].id, 'pm')));
  const otroCarro = rt.cars.find((c) => c.driverAM && c.driverAM !== id);
  t('0124: el que no tiene turno abierto hoy dice «· sin iniciar turno»', !!otroCarro && /· sin iniciar turno/.test(txt(cel(otroCarro.id, 'am'))), otroCarro && txt(cel(otroCarro.id, 'am')));
  rt.activos = null;
  V2().render(); await wait(10);
  t('0124: un día que no es hoy no dice nada del turno', !/sin iniciar turno|· en /.test(txt(q('#rv2-drivers'))));
  t('0124: la nota de la tarjeta explica de dónde sale la placa', /La placa sale del carro con que cada uno inicia turno/.test(txt(q('#rv2-drivers .sub'))));
  // Rearmar un plan publicado: una vuelta con su carro del plan y una vieja (antes
  // de 0124) que solo trae una placa que el tablero no tiene.
  const keys = Object.keys(rt.aux).filter((k) => rt.aux[k].reservationId);
  const [k1, k2] = keys;
  const drv0 = rt.drivers[0] && rt.drivers[0].id;
  const V = (o) => Object.assign({ type: 'lle', status: 'planned', cap: 4, driverProfileId: drv0, conductor: 'Juan', atendidas: [] }, o);
  w.Api.getPublishedPlan = async () => ({ vueltas: [
    V({ id: 'x1', startAt: `${rt.day}T22:55:00-05:00`, vehicleId: 'veh-zzz', planCar: null, carro: 'HYU376', pendientes: [{ rid: rt.aux[k1].reservationId, order: 1, status: 'pending' }] }),
    V({ id: 'x2', startAt: `${rt.day}T23:30:00-05:00`, vehicleId: null, planCar: rt.cars[2].id, carro: rt.cars[2].id, pendientes: [{ rid: rt.aux[k2].reservationId, order: 1, status: 'pending' }] }),
  ] });
  await V2().cargarDia(rt.day); await wait(30);
  const rt2 = T().rt;
  const carDe = (k) => (rt2.lanes.find((l) => (rt2.order[l.id] || []).includes(k)) || {}).car;
  t('0124: la vuelta con carro del plan vuelve a ESE carro', carDe(k2) === rt2.cars[2].id, carDe(k2));
  t('0124: la vieja con una placa que el tablero no tiene cae en un carro del plan libre (no crea uno nuevo)', carDe(k1) === rt2.cars[0].id && !rt2.cars.some((c) => c.id === 'HYU376'), JSON.stringify([carDe(k1), rt2.cars.map((c) => c.id)]));
  t('sin errores de consola (0124)', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── 26-oct · el conductor de UNA vuelta: cambiarlo no mueve el resto ──');
{
  // La profa: «intenté cambiar algo y se cambió toda la programación, solo quería
  // darle a otro conductor una ruta». La hoja del carro cambia TODAS sus vueltas
  // del turno; «Cambiar» en una vuelta ahora pone el conductor SOLO a esa.
  const b = await boot();
  const { w, q, qa, click, T, V2, sheet } = b;
  const rt = T().rt;
  const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const laneDe = (k) => Object.keys(rt.order).find((l) => rt.order[l].includes('r' + k));
  const foto = () => JSON.stringify(V2().dia().routes.map((r) => [r.id, r.driverId, r.stops.map((s) => hm(s.time)).join(','), hm(r.arrival)]));
  const LM = laneDe('M'), LE = laneDe('E'), LH = laneDe('H'), LI = laneDe('I');
  const v02 = rt.cars.find((c) => c.id === 'V-02');
  t('el día de prueba: V-02 hace E, H/G y M con Luis (AM)', v02.driverAM === 'd2' && [LE, LH, LM].every((l) => V2().dia().byId[l].driverId === 'd2'), JSON.stringify([v02.driverAM, LE, LH, LM]));
  const antes = JSON.parse(foto());
  // Abrir la vuelta de M y tocar «Cambiar».
  click(q(`#rv2-list .rv2-row[data-id="${LM}"]`)); await wait(10);
  click(q(`#routes-v2 [data-act="assign"][data-id="${LM}"]`)); await wait(10);
  const titulo = txt(q('#rv2-shTitle'));
  t('«Cambiar» en la vuelta abre «Conductor de esta vuelta», no la del carro', titulo === 'Conductor de esta vuelta' && !sheet().hidden, titulo);
  t('el subtítulo dice que solo cambia esta vuelta', /solo cambia esta vuelta: las demás y sus horas quedan igual/.test(txt(q('#rv2-sheet .rv2-sh-head p'))), txt(q('#rv2-sheet .rv2-sh-head p')));
  const opc = (id) => q(`#rv2-sheet [data-pick="${id}"]`);
  t('Luis (el de hoy) sale como «Actual» y no se puede elegir', opc('d2') && opc('d2').disabled && /Actual/.test(txt(opc('d2'))));
  t('Carlos (V-03) alcanza: dice de qué vuelta viene y a qué hora llega', opc('d3') && /Alcanza/.test(txt(opc('d3'))) && /viene de su vuelta de las \d\d:\d\d y alcanza \(llega a las \d\d:\d\d\)/.test(txt(opc('d3'))), txt(opc('d3')));
  t('el botón arranca apagado', q('#rv2-doAssign').disabled);
  t('hay un enlace para cambiar todo el turno del carro (la hoja de antes)', /Cambiar el conductor de todas las vueltas de V-02 en el turno AM/.test(txt(q('#rv2-sheet [data-act="assignslot"]'))));
  click(opc('d3')); await wait(5);
  t('al elegir, el botón dice «Asignar a esta vuelta»', !q('#rv2-doAssign').disabled && /Asignar a esta vuelta/.test(txt(q('#rv2-doAssign'))));
  click(q('#rv2-doAssign')); await wait(10);
  const despues = JSON.parse(foto());
  const lane = rt.lanes.find((l) => l.id === LM);
  t('la vuelta de M queda con Carlos (conductor propio)', V2().dia().byId[LM].driverId === 'd3' && lane.drv === 'd3' && V2().dia().byId[LM].propio, JSON.stringify(lane));
  t('el carro sigue con Luis y sus otras dos vueltas también', v02.driverAM === 'd2' && V2().dia().byId[LE].driverId === 'd2' && V2().dia().byId[LH].driverId === 'd2');
  const cambiadas = despues.filter((x, i) => JSON.stringify(x) !== JSON.stringify(antes[i]));
  t('NADA más cambió: ni conductores ni horas de las otras vueltas (solo el conductor de esa)', cambiadas.length === 1 && cambiadas[0][0] === LM && cambiadas[0][2] === antes.find((x) => x[0] === LM)[2] && cambiadas[0][3] === antes.find((x) => x[0] === LM)[3], JSON.stringify(cambiadas));
  t('el aviso lo dice en palabras', /Carlos Mejía hace la vuelta de las \d\d:\d\d de V-02 · las demás no cambian/.test(b.toastV2()), b.toastV2());
  const fila = q(`#rv2-list .rv2-row[data-id="${LM}"]`);
  t('la fila dice Carlos y «solo esta vuelta»', /Carlos Mejía/.test(txt(fila)) && /solo esta vuelta/.test(txt(fila.querySelector('.tag.own'))), txt(fila));
  t('el detalle dice «Conductor solo de esta vuelta»', /Carlos Mejía\s*Conductor solo de esta vuelta/.test(txt(q('#routes-v2 .rv2-drv'))), txt(q('#routes-v2 .rv2-drv')));
  const celda = q('#rv2-drivers [data-act="assignslot"][data-car="V-02"][data-shift="am"]');
  t('Conductores: V-02 AM sigue Luis, «2 vueltas · 1 con otro conductor»', /Luis A\./.test(txt(celda)) && /2 vueltas · 1 con otro conductor/.test(txt(celda)), txt(celda));
  t('queda como cambio sin publicar', /Publicar cambios/.test(txt(q('#routes-v2'))) || /Publicar cambios/.test(w.document.body.textContent));
  // Publicar: a la base va Carlos en ESA vuelta y Luis en las otras dos.
  b.log.saved.length = 0;
  click(q('#rv2-publish')); await wait(10);
  const go = q('#rv2-doPublish:not([hidden])');
  if (go && !go.disabled) { click(go); } else { click(q('#rv2-forceOpen')); await wait(5); const a1 = q('#rv2-forceRisk'); if (a1) { a1.checked = true; a1.dispatchEvent(new w.Event('change')); } const a2 = q('#rv2-forceUnr'); if (a2) { a2.checked = true; a2.dispatchEvent(new w.Event('change')); } click(q('#rv2-doForce')); }
  await wait(40);
  const pub = b.log.saved.at(-1);
  const pubDe = (k) => pub && pub.lanes.find((l) => l.stops.includes('res-' + k));
  t('publicar manda Carlos en la vuelta de M y Luis en E y en H/G', !!pub && pubDe('M').driverProfileId === 'd3' && pubDe('E').driverProfileId === 'd2' && pubDe('H').driverProfileId === 'd2', pub && JSON.stringify(pub.lanes.map((l) => [l.stops.join('+'), l.driverProfileId])));
  // Cambiar el conductor de TODO el carro después: la vuelta con conductor propio no se mueve.
  click(q('#rv2-drivers [data-act="assignslot"][data-car="V-02"][data-shift="am"]')); await wait(10);
  t('la hoja del carro avisa que la vuelta con conductor propio no cambia', /menos la que tiene conductor propio/.test(txt(q('#rv2-sheet .rv2-sh-head p'))), txt(q('#rv2-sheet .rv2-sh-head p')));
  click(q('#rv2-sheet [data-pick="d1"]')); await wait(5); click(q('#rv2-doAssign')); await wait(10);
  t('cambiar el carro (Jorge ↔ Luis) mueve sus vueltas, pero la de M sigue con Carlos', V2().dia().byId[LE].driverId === 'd1' && V2().dia().byId[LH].driverId === 'd1' && V2().dia().byId[LM].driverId === 'd3', JSON.stringify([LE, LH, LM].map((l) => V2().dia().byId[l].driverId)));
  click(q('#rv2-toast [data-act="undo"]')); await wait(10);
  // Volver al del carro.
  click(q(`#rv2-list .rv2-row[data-id="${LM}"]`)); await wait(10);
  click(q(`#routes-v2 [data-act="assign"][data-id="${LM}"]`)); await wait(10);
  t('con conductor propio, la hoja ofrece «Como el resto de V-02» (Luis)', /Como el resto de V-02/.test(txt(q('#rv2-sheet [data-pick="__carro"]'))) && /Luis Arango/.test(txt(q('#rv2-sheet [data-pick="__carro"]'))));
  click(q('#rv2-sheet [data-pick="__carro"]')); await wait(5); click(q('#rv2-doAssign')); await wait(10);
  t('«Como el resto» la devuelve a Luis y quita la marca', V2().dia().byId[LM].driverId === 'd2' && !V2().dia().byId[LM].propio && !('drv' in rt.lanes.find((l) => l.id === LM)));
  // Quitar el conductor solo de una vuelta.
  click(q(`#routes-v2 [data-act="assign"][data-id="${LM}"]`)); await wait(10);
  click(q('#rv2-sheet [data-pick="__none"]')); await wait(5);
  t('«Quitar el conductor de esta vuelta»: el botón dice «Quitar de esta vuelta»', /Quitar de esta vuelta/.test(txt(q('#rv2-doAssign'))));
  click(q('#rv2-doAssign')); await wait(10);
  t('la vuelta queda sin conductor y las otras de V-02 siguen con Luis', V2().dia().byId[LM].driverId === null && V2().dia().byId[LM].status === 'nodriver' && V2().dia().byId[LE].driverId === 'd2' && v02.driverAM === 'd2');
  const avs = V2()._avisos();
  t('Avisos: «La vuelta de V-02 de las … no tiene conductor» y su botón abre ESA vuelta', avs.some((a) => /La vuelta de <b>V-02<\/b> de las \d\d:\d\d no tiene conductor/.test(a.html) && a.act.includes(`data-act="assign" data-id="${LM}"`)) && !avs.some((a) => /<b>V-02<\/b> no tiene conductor/.test(a.html)), JSON.stringify(avs.map((a) => a.html)));
  // Deshacer vuelve atrás paso a paso.
  click(q('#rv2-toast [data-act="undo"]')); await wait(10);
  t('Deshacer devuelve el conductor a la vuelta', V2().dia().byId[LM].driverId === 'd2');
  // ¿Alcanza? La hoja dice si el conductor llega desde su vuelta anterior.
  // Con los tiempos del modelo: tras una salida queda en JMC + TURNAROUND y de
  // ahí va a la primera casa de la vuelta que se le quiere dar.
  const llegaDesdeJMC = (prev, r) => Math.round(prev.arrival + rt.TURNAROUND + w.eval(`rtLegMin('airport', ${JSON.stringify(r.stops[0].crewId)})`));
  click(q(`#rv2-list .rv2-row[data-id="${LI}"]`)); await wait(10);
  click(q(`#routes-v2 [data-act="assign"][data-id="${LI}"]`)); await wait(10);
  const rI = V2().dia().byId[LI], rH = V2().dia().byId[LH];
  const luis = q('#rv2-sheet [data-pick="d2"]'), lL = llegaDesdeJMC(rH, rI);
  t('Luis (sale de JMC tras H/G) sí alcanza la de I/J: lo dice con la hora a la que llega', lL - rI.stops[0].time <= 4 && /Alcanza/.test(txt(luis)) && txt(luis).includes(`y alcanza (llega a las ${hm(lL)})`), `${txt(luis)} · esperado ${hm(lL)}`);
  click(q('#rv2-sheet [data-act="sclose"]')); await wait(5);
  // Jorge termina la vuelta de C/D en JMC y la de H/G empieza lejos de ahí.
  click(q(`#rv2-list .rv2-row[data-id="${LH}"]`)); await wait(10);
  click(q(`#routes-v2 [data-act="assign"][data-id="${LH}"]`)); await wait(10);
  const rD = V2().dia().byId[laneDe('D')];
  const jH = q('#rv2-sheet [data-pick="d1"]'), lJ = llegaDesdeJMC(rD, rH), tJ = lJ - rH.stops[0].time;
  t('Jorge NO alcanza la de H/G: dice de qué vuelta viene, a qué hora llegaría y cuánto tarde',
    tJ > 4 && /No alcanza/.test(txt(jH)) && txt(jH).includes(`llegaría a las ${hm(lJ)}, ${tJ} min tarde`), `${txt(jH)} · esperado ${hm(lJ)} (${tJ})`);
  click(q('#rv2-sheet [data-act="sclose"]')); await wait(5);
  click(q(`#rv2-list .rv2-row[data-id="${LE}"]`)); await wait(10);
  click(q(`#routes-v2 [data-act="assign"][data-id="${LE}"]`)); await wait(10);
  const jorge = q('#rv2-sheet [data-pick="d1"]');
  t('Jorge, que a esa hora va en otra vuelta, sale «Ocupado» con la hora', !!jorge && /Ocupado/.test(txt(jorge)) && /tiene su vuelta de las \d\d:\d\d \(hasta las \d\d:\d\d\)/.test(txt(jorge)), txt(jorge));
  click(q('#rv2-sheet [data-act="sclose"]')); await wait(5);
  t('el día de prueba no trae avisos de conductor (sin falsas alarmas)', !V2()._avisos().some((x) => x.k === 'drv'), JSON.stringify(V2()._avisos().filter((x) => x.k === 'drv').map((x) => x.html)));
  // Elegir igual a quien no alcanza: el jefe manda, pero queda en Avisos.
  click(q(`#rv2-list .rv2-row[data-id="${LH}"] .when`)); await wait(10);
  click(q(`#routes-v2 [data-act="assign"][data-id="${LH}"]`)); await wait(10);
  click(q('#rv2-sheet [data-pick="d1"]')); await wait(5); click(q('#rv2-doAssign')); await wait(10);
  const avJ = V2()._avisos().filter((x) => x.k === 'drv');
  t('si igual se la da a Jorge: Avisos «Jorge Pérez no alcanza a llegar a la vuelta de las … de V-02» con la hora y los minutos, y «Cambiar» abre esa vuelta',
    avJ.length === 1 && /<b>Jorge Pérez<\/b> no alcanza a llegar a la vuelta de las \d\d:\d\d de V-02/.test(avJ[0].html) && avJ[0].html.includes(`llegaría a las ${hm(lJ)}, ${tJ} min tarde`) && avJ[0].act.includes(`data-id="${LH}"`), JSON.stringify(avJ));
  click(q('#rv2-toast [data-act="undo"]')); await wait(10);
  click(q(`#routes-v2 [data-act="assign"][data-id="${LH}"]`)); await wait(10);
  click(q('#rv2-sheet [data-pick="d3"]')); await wait(5); click(q('#rv2-doAssign')); await wait(10);
  const avC = V2()._avisos().filter((x) => x.k === 'drv');
  t('si se la da a Carlos (ocupado): «Carlos Mejía tiene dos vueltas a la vez» con las dos horas', avC.length === 1 && /<b>Carlos Mejía<\/b> tiene dos vueltas a la vez<small>V-02 de las \d\d:\d\d \(hasta las \d\d:\d\d\) y V-03 de las \d\d:\d\d/.test(avC[0].html), JSON.stringify(avC));
  t('…aunque la otra (la de V-03) ya va en curso, el botón abre la que se puede cambiar', V2().dia().byId[laneDe('P')].fija === 'in_progress' && avC.length === 1 && avC[0].act.includes(`data-id="${LH}"`), avC[0] && avC[0].act);
  click(q('#rv2-toast [data-act="undo"]')); await wait(10);
  t('deshacer quita el aviso', !V2()._avisos().some((x) => x.k === 'drv'));
  t('sin errores de consola (conductor de una vuelta)', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
}
{
  // El caso del lunes 26-oct: plan publicado con las horas del jefe. Luis deja a
  // H/G en JMC y la vuelta siguiente de su carro recoge lejos MUY poco después;
  // el carro «está libre» antes de esa hora (JMC + TURNAROUND), así que el
  // tablero no decía nada. Ahora sale en Avisos.
  const b = await boot({ horas: { 'ra-6': { start: '07:40', etas: { M: '07:40' } } } });
  const { T, V2 } = b;
  const rt = T().rt;
  const laneDe = (k) => Object.keys(rt.order).find((l) => rt.order[l].includes('r' + k));
  const rH = V2().dia().byId[laneDe('H')], rM = V2().dia().byId[laneDe('M')];
  const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const libre = rH.arrival + rt.TURNAROUND;
  t('la vuelta de M quedó con la hora del jefe (07:40) y el carro está libre antes (sin choque del tablero)', rM.stops[0].time === 460 && libre <= 460 && !rM.retraso, JSON.stringify([hm(rM.stops[0].time), hm(libre), rM.retraso]));
  const av = V2()._avisos().filter((x) => x.k === 'drv');
  t('Avisos: «Luis Arango no alcanza a llegar a la vuelta de las 07:40 de V-02» (termina la de las 06:55 en JMC)', av.length === 1 && /<b>Luis Arango<\/b> no alcanza a llegar a la vuelta de las 07:40 de V-02<small>Termina la de las 06:55 en JMC a las 07:23/.test(av[0].html), JSON.stringify(av.map((x) => x.html)));
  t('sin errores de consola (horas del jefe)', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
}
{
  // Un plan publicado con DOS conductores en el mismo carro y turno (la vuelta de
  // M con Carlos): al abrir el día se respeta, y re-publicar no se lo cambia.
  const b = await boot();
  const { w, T, V2 } = b;
  const vs = w.RV2Fixture.vueltas();
  const vM = vs.find((v) => v.pendientes.some((s) => s.rid === 'res-M'));
  vM.driverProfileId = 'd3'; vM.conductor = 'Carlos Mejía';
  const vH = vs.find((v) => v.pendientes.some((s) => s.rid === 'res-H'));
  vH.driverProfileId = null; vH.conductor = 'Sin conductor'; vH.status = 'draft';
  w.Api.getPublishedPlan = async () => ({ vueltas: vs, publicado: true });
  await V2().cargarDia(T().rt.day); await wait(30);
  const rt = T().rt;
  const laneDe = (k) => Object.keys(rt.order).find((l) => rt.order[l].includes('r' + k));
  const r = (k) => V2().dia().byId[laneDe(k)];
  t('al abrir el día: V-02 AM es de Luis, la vuelta de M vuelve con Carlos y la de H/G sin conductor', rt.cars.find((c) => c.id === 'V-02').driverAM === 'd2' && r('M').driverId === 'd3' && r('M').propio && r('H').driverId === null && r('H').propio && r('E').driverId === 'd2' && !r('E').propio,
    JSON.stringify(['E', 'H', 'M'].map((k) => [r(k).driverId, r(k).propio])));
  const n0 = b.confirms.length;
  await V2().cambiarDia(1); await wait(20);
  t('recién abierto no cuenta como cambio sin publicar (cambiar de día no pregunta)', b.confirms.length === n0, b.confirms.slice(n0).join(' | '));
  t('sin errores de consola (rearmar con conductor propio)', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── 0126 · Delegar UNA vuelta en el tablero (la hace alguien de afuera) ──');
{
  const b = await boot();
  const { w, q, qa, click, T, V2, log } = b;
  const rt = T().rt;
  const laneDe = (k) => Object.keys(rt.order).find((l) => rt.order[l].includes('r' + k));
  const LM = laneDe('M'), LE = laneDe('E'), LH = laneDe('H');
  w.Api.auxiliarUserIdsForReservations = async (ids) => ids.map((x) => 'perfil-' + x);
  const abrirHoja = async (L) => { click(q(`#rv2-list .rv2-row[data-id="${L}"] .when`)); await wait(10); click(q(`#routes-v2 [data-act="assign"][data-id="${L}"]`)); await wait(10); };
  await abrirHoja(LM);
  const op = q('#rv2-sheet [data-pick="__deleg"]');
  t('la hoja de la vuelta ofrece «Delegar esta vuelta» y dice qué pasa', op && /Delegar esta vuelta/.test(txt(op)) && /Ningún conductor la ve/.test(txt(op)) && /Tu servicio fue delegado, te contactaremos por WhatsApp/.test(txt(op)), op && txt(op));
  click(op); await wait(5);
  t('al elegirla, el botón dice «Delegar esta vuelta»', /Delegar esta vuelta/.test(txt(q('#rv2-doAssign'))));
  click(q('#rv2-doAssign')); await wait(10);
  const lane = rt.lanes.find((l) => l.id === LM), rM = V2().dia().byId[LM];
  t('la vuelta queda delegada: sin conductor y NO «sin conductor» (no pide uno)', lane.deleg === true && lane.drv === false && rM.delegada && rM.driverId === null && rM.status !== 'nodriver', JSON.stringify([lane.deleg, lane.drv, rM.status]));
  t('las otras de V-02 siguen con Luis', V2().dia().byId[LE].driverId === 'd2' && V2().dia().byId[LH].driverId === 'd2');
  t('el aviso de abajo lo dice', /La vuelta de las \d\d:\d\d de V-02 queda delegada · al publicar se le avisa al tripulante/.test(b.toastV2()), b.toastV2());
  const fila = q(`#rv2-list .rv2-row[data-id="${LM}"]`);
  t('la fila dice «Delegada» (no «Sin conductor»)', /Delegada/.test(txt(fila.querySelector('.drv.deleg'))) && !/Sin conductor/.test(txt(fila)), txt(fila));
  t('el detalle: «Delegada · La hace alguien de afuera…»', /Delegada\s*La hace alguien de afuera/.test(txt(q('#routes-v2 .rv2-drv'))), txt(q('#routes-v2 .rv2-drv')));
  t('Avisos: no la pide como vuelta sin conductor', !V2()._avisos().some((a) => a.k === 'nodriver' && a.act.includes(LM)), JSON.stringify(V2()._avisos().map((a) => a.k)));
  t('Conductores: V-02 AM «2 vueltas · 1 delegada»', /2 vueltas · 1 delegada/.test(txt(q('#rv2-drivers [data-act="assignslot"][data-car="V-02"][data-shift="am"]'))), txt(q('#rv2-drivers [data-act="assignslot"][data-car="V-02"][data-shift="am"]')));
  // Publicar.
  click(q('#rv2-publish')); await wait(10);
  t('la hoja de Publicar la cuenta: «1 vuelta delegada» y qué le llega al tripulante', /1 vuelta delegada/.test(txt(q('#rv2-sheet'))) && /Ningún conductor las ve/.test(txt(q('#rv2-sheet'))), txt(q('#rv2-sheet')).slice(0, 300));
  b.log.saved.length = 0; b.log.push.length = 0;
  const go = q('#rv2-doPublish:not([hidden])');
  if (go && !go.disabled) click(go); else { click(q('#rv2-forceOpen')); await wait(5); ['#rv2-forceRisk', '#rv2-forceUnr'].forEach((s) => { const x = q(s); if (x) { x.checked = true; x.dispatchEvent(new w.Event('change')); } }); click(q('#rv2-doForce')); }
  await wait(40);
  const pub = b.log.saved.at(-1), pM = pub && pub.lanes.find((l) => l.stops.includes('res-M'));
  t('publicar manda esa vuelta delegada y sin conductor; las demás con el suyo', !!pM && pM.delegated === true && pM.driverProfileId === null && pub.lanes.filter((l) => l.delegated).length === 1 && pub.lanes.find((l) => l.stops.includes('res-E')).driverProfileId === 'd2', pub && JSON.stringify(pub.lanes.map((l) => [l.stops.join('+'), l.driverProfileId, !!l.delegated])));
  const pushD = b.log.push.find((p) => /Tu servicio fue delegado/.test(p.title));
  t('a su tripulante le llega «Tu servicio fue delegado 🤝 · Te contactaremos por WhatsApp…»', pushD && JSON.stringify(pushD.profileIds) === JSON.stringify(['perfil-res-M']) && /WhatsApp/.test(pushD.body), JSON.stringify(b.log.push.map((p) => [p.title, p.profileIds])));
  t('…y NO «Conductor asignado» para esa reserva', !b.log.push.some((p) => /Conductor asignado|Te cambiamos el conductor/.test(p.title) && (p.profileIds || []).includes('perfil-res-M')));
  t('el aviso del tablero cuenta la delegada', /1 delegada/.test(b.toastV2() || '') || b.toasts.some((m) => /1 delegada/.test(m)), b.toastV2());
  // Volver a publicar sin tocar: no repite el aviso.
  b.log.push.length = 0;
  await T().rtSavePlan({ toast: () => {} }); await wait(20);
  t('re-publicar igual no le vuelve a avisar', !b.log.push.some((p) => /Tu servicio fue delegado/.test(p.title)), JSON.stringify(b.log.push.map((p) => p.title)));
  // Quitarle lo delegado: «Como el resto de V-02».
  await abrirHoja(LM);
  t('con la vuelta delegada, la hoja dice «hoy está delegada» y no repite «Delegar»', /hoy está delegada/.test(txt(q('#rv2-sheet .rv2-sh-head p'))) && !q('#rv2-sheet [data-pick="__deleg"]'), txt(q('#rv2-sheet .rv2-sh-head p')));
  click(q('#rv2-sheet [data-pick="__carro"]')); await wait(5); click(q('#rv2-doAssign')); await wait(10);
  t('«Como el resto» la devuelve a Luis y quita la marca', V2().dia().byId[LM].driverId === 'd2' && !V2().dia().byId[LM].delegada && !('deleg' in rt.lanes.find((l) => l.id === LM)));
  click(q('#rv2-toast [data-act="undo"]')); await wait(10);
  t('Deshacer la vuelve a delegada', V2().dia().byId[LM].delegada === true);
  t('sin errores de consola (delegar en el tablero)', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
}
{
  // Un plan publicado con una vuelta delegada: al abrir el día vuelve delegada.
  const b = await boot();
  const { w, T, V2 } = b;
  const vs = w.RV2Fixture.vueltas();
  const vM = vs.find((v) => v.pendientes.some((s) => s.rid === 'res-M'));
  Object.assign(vM, { driverProfileId: null, conductor: 'Sin conductor', delegated: true });
  w.Api.getPublishedPlan = async () => ({ vueltas: vs, publicado: true });
  await V2().cargarDia(T().rt.day); await wait(30);
  const rt = T().rt;
  const lM = Object.keys(rt.order).find((l) => rt.order[l].includes('rM'));
  const r = V2().dia().byId[lM];
  t('al abrir el día la vuelta de M vuelve delegada; V-02 AM sigue de Luis', r.delegada && r.driverId === null && rt.cars.find((c) => c.id === 'V-02').driverAM === 'd2', JSON.stringify([r.delegada, r.driverId]));
  const n0 = b.confirms.length;
  await V2().cambiarDia(1); await wait(20);
  t('recién abierto no cuenta como cambio sin publicar', b.confirms.length === n0, b.confirms.slice(n0).join(' | '));
  t('sin errores de consola (rearmar con delegada)', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
}

console.log(`\n${ok}/${ok + bad} pasaron${bad ? ' · ' + bad + ' FALLARON' : ''}`);
console.log('NO cubierto: layout real (puntos de quiebre, cajón, tarjetas, barra fija del celular: ver _capturas-rutas-v2.mjs y revisar en un teléfono), la base real (RLS, saveRoutePlan/getPublishedPlan en producción), TomTom/OSRM reales, el mapa Leaflet real, el push real y el módulo de WhatsApp.');
process.exit(bad ? 1 : 0);
