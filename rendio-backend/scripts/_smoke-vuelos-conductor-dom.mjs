// El vuelo en la app del CONDUCTOR (26-oct-2026) — prueba jsdom.
//
// Pedido de la profa: «que los conductores puedan ver el estado de los vuelos como
// nuestro módulo de vuelos; cuando le den clic a la tarjeta, un apartado de ver
// avión». Dos pasos:
//   1) El estado en la tarjeta: hasta hoy solo salía el código («AV9306») porque
//      driver-rutas.js llamaba RendioVuelos.describir y vuelos-ui.js no lo exportaba.
//   2) «Ver avión»: una hoja con cómo va, a qué hora llega, quiénes vienen y un
//      mapita con la posición ESTIMADA (el mismo cálculo de Rutas › Vuelos, que pasó
//      de admin-vuelos.js a vuelos-ui.js para compartirlo).
//
// Comprueba, con los archivos de verdad (vuelos-ui.js, api-vuelos.js,
// aux-rx-ui.js, driver-rutas.js) y un Leaflet falso:
//   A) vuelos-ui.js exporta describir y la posición compartida.
//   B) api-vuelos.js pide origen, despegue y la última posición (raw->vuelo) y, sin
//      0118, vuelve a las columnas de antes.
//   C) Mi día, Detalle y la hoja «Ver avión»; que use el día de la HORA PEDIDA (el
//      mismo vuelo de ayer no se cuela); llegada sin datos todavía; salida (no se
//      sigue); seguimiento apagado (no sale nada).
//
// LO QUE NO CUBRE: el layout y el mapa de verdad (jsdom no dibuja: se miró con
// Chromium a 360 y 390 px, de día y de noche), la RLS real de flight_statuses para
// un conductor (la política 0099 lo deja leer; no se probó contra la base), y el
// teléfono del conductor.
//
//   cd rendio-backend && node scripts/_smoke-vuelos-conductor-dom.mjs
process.env.TZ = 'America/Bogota';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const FIX = new URL('./fixtures/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null && d !== '' ? ' → ' + d : '')); } };
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const tx = (e) => (e ? e.textContent.replace(/\s+/g, ' ').trim() : '');
// Como se lee en pantalla: un espacio entre elementos (textContent los pega).
const leer = (el) => { if (!el) return ''; const p = []; const walk = (n) => { n.childNodes.forEach((c) => { if (c.nodeType === 3) p.push(c.textContent); else { walk(c); p.push(' '); } }); }; walk(el); return p.join('').replace(/\s+/g, ' ').trim(); };

const MIN = 60000, NOW = Date.now();
const iso = (m) => new Date(NOW + m * MIN).toISOString();
const dia = (m) => new Date(NOW + m * MIN).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
const hm = (m) => new Date(NOW + m * MIN).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false });

// Filas como las guarda la base (flight_statuses, snake_case). El mismo AV9306 de
// AYER, ya aterrizado, no debe pintarse en la vuelta de hoy.
const fila = (o) => Object.assign({ flight_code: 'AV9306', flight_date: dia(40), direction: 'airport_to_home', sched_at: iso(40), estimated_at: iso(48), actual_at: null,
  status: 'in_air', delay_min: 8, terminal: null, gate: null, source: 'aerodatabox', fetched_at: iso(-4), departed_at: iso(-22), origin_icao: 'SKBO',
  vuelo: { lat: 5.6, lon: -74.95, alt: 31000, gspeed: 430, track: 300, timestamp: iso(-6), type: 'A320' } }, o);
const AYER = fila({ flight_date: dia(40 - 1440), status: 'landed', actual_at: iso(40 - 1440), delay_min: 0 });

const leg = (o) => Object.assign({ kind: 'dropoff', lat: 6.15, lng: -75.37, addr: 'Olivar', unit: '', flight: '', dl: '', phone: '', notes: '', bags: null, quiet: false,
  meetCode: '12', meetingPoint: '', level: 'shared', privateStatus: null, stopStatus: 'pending', pickup: '', eta: '' }, o);
const APT = { kind: 'airport', name: 'Aeropuerto JMC', addr: 'Terminal', lat: 6.1715, lng: -75.427 };
const VUELTAS = () => [
  { id: 'V1', type: 'lle', start: hm(50), startAt: iso(50), done: false, assignmentId: 'A1', day: dia(50), opDay: dia(50), legs: [APT,
    leg({ name: 'Laura Prueba Gómez', reservationId: 'R1', auxProfileId: 'P1', flight: 'AV9306', reqDay: dia(40), reqAt: iso(40) }),
    leg({ name: 'Andrés Prueba Ruiz', reservationId: 'R2', auxProfileId: 'P2', flight: 'av 9306', reqDay: dia(40), reqAt: iso(40) })] },
  { id: 'V2', type: 'lle', start: hm(200), startAt: iso(200), done: false, assignmentId: 'A2', day: dia(200), opDay: dia(50), legs: [APT,
    leg({ name: 'Sara Prueba Toro', reservationId: 'R3', auxProfileId: 'P3', flight: 'LA4021', reqDay: dia(190), reqAt: iso(190) })] },
  { id: 'V3', type: 'sal', start: hm(260), startAt: iso(260), done: false, assignmentId: 'A3', day: dia(260), opDay: dia(50), legs: [
    leg({ kind: 'pickup', name: 'Eva Prueba Sol', reservationId: 'R4', auxProfileId: 'P4', flight: 'AV1234', reqDay: dia(300), reqAt: iso(300), dl: hm(300) }), APT] },
];

function boot({ flags = true, filas = [fila(), AYER], sin0118 = false } = {}) {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const errores = [], pedidos = [];
  w.addEventListener('error', (e) => errores.push(e.message));
  w.console.error = (...x) => errores.push(x.map((y) => (y && y.message) || String(y)).join(' '));
  w.RENDIO_CONFIG = {}; w.toast = () => {};
  w.Element.prototype.scrollIntoView = function () {};
  w.confirm = () => true;
  w.fetch = async () => { throw new Error('sin red'); };
  w.eval(readFileSync(FIX + 'fake-leaflet.js', 'utf8'));
  // Doble de supabase-js para flight_statuses: registra qué columnas se pidieron.
  w.sb = { from(tabla) {
    const q = { tabla, cols: '' };
    const ch = { select(c) { q.cols = c; pedidos.push(c); return ch; }, in() { return ch; }, eq() { return ch; }, maybeSingle() { return ch; },
      then(ok2, ko) {
        const r = tabla !== 'flight_statuses' ? { data: null, error: { message: 'no' } }
          : (sin0118 && /departed_at/.test(q.cols)) ? { data: null, error: { code: '42703', message: 'column flight_statuses.departed_at does not exist' } }
            : { data: JSON.parse(JSON.stringify(filas)).map((f) => { if (!/vuelo/.test(q.cols)) { delete f.vuelo; delete f.departed_at; delete f.origin_icao; } return f; }), error: null };
        return Promise.resolve(r).then(ok2, ko);
      } };
    return ch;
  } };
  w.state = { settings: { aux_wait_minutes: 5, flight_api_enabled: flags }, profile: { role: 'driver' } };
  w.Api = {
    listMyVueltasForDriver: async () => VUELTAS(), driverOpenRoutes: async () => [],
    getMyDriverProfileId: async () => 'DP1', countUnreadMessages: async () => ({}), sendDriverLocation: async () => {}, driverSetStopStatus: async () => {},
  };
  for (const f of ['api-vuelos.js', 'vuelos-ui.js', 'aux-rx-ui.js', 'driver-rutas.js']) {
    try { w.eval(read(f)); } catch (e) { errores.push(f + ': ' + e.message); }
  }
  const root = () => w.document.getElementById('driver-ruta-root');
  const q = (s) => root().querySelector(s), qa = (s) => [...root().querySelectorAll(s)];
  const click = async (el, ms = 80) => { if (el) el.click(); await wait(ms); return !!el; };
  return { w, errores, pedidos, root, q, qa, click };
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── A · vuelos-ui.js: lo que comparten el jefe y el conductor ──');
{
  const { w, errores } = boot();
  const RV = w.RendioVuelos;
  t('exporta describir (antes no: el chip del conductor nunca pintaba)', typeof RV.describir === 'function');
  t('exporta la posición, los aeropuertos y las aerolíneas', ['posicion', 'aeropuerto', 'aerolinea', 'enCamino'].every((k) => typeof RV[k] === 'function') && RV.JMC && RV.JMC.code === 'SKRG');
  const p = RV.posicion({ status: 'in_air', originIcao: 'SKBO', departedAt: iso(-30), estimatedAt: iso(30), live: null }, NOW);
  t('en el aire a medio camino: entre Bogotá y JMC, estimada', p && p.en === 'aire' && !p.real && Math.abs(p.frac - 0.5) < 0.02 && p.lat > 4.7 && p.lat < 6.17, JSON.stringify(p));
  const pr = RV.posicion({ status: 'in_air', originIcao: 'SKBO', departedAt: iso(-30), estimatedAt: iso(30), live: { lat: 5.9, lon: -75.0, timestamp: iso(-5) } }, NOW);
  t('con una posición de FR24 de hace 5 min arranca desde ahí («real»)', pr && pr.real === true);
  t('aterrizado: en JMC; en tierra: en su aeropuerto; origen desconocido: fuera del mapa',
    RV.posicion({ status: 'landed', actualAt: iso(-3) }, NOW).en === 'jmc' && RV.posicion({ status: 'scheduled', originIcao: 'SKCL' }, NOW).en === 'tierra'
      && RV.posicion({ status: 'in_air', originIcao: 'ZZZZ', departedAt: iso(-30), estimatedAt: iso(30) }, NOW) === null);
  t('sin errores', errores.length === 0, errores.join(' | '));
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── B · api-vuelos.js: origen, despegue y la última posición ──');
{
  const { w, pedidos } = boot();
  const rows = await w.Api.listFlightStatuses([dia(40)]);
  const r = rows.find((x) => x.day === dia(40));
  t('pide departed_at, origin_icao y solo raw->vuelo (no todo raw)', /departed_at, origin_icao, vuelo:raw->vuelo/.test(pedidos[0] || ''), pedidos[0]);
  t('…y lo entrega: originIcao, departedAt y live {lat, lon, alt, gspeed, timestamp, type}', r && r.originIcao === 'SKBO' && r.departedAt && r.live && r.live.lat === 5.6 && r.live.alt === 31000 && r.live.type === 'A320', JSON.stringify(r));
  const b = boot({ sin0118: true });
  const rows2 = await b.w.Api.listFlightStatuses([dia(40)]);
  t('sin 0118 (columna que no existe): vuelve a las columnas de antes y no se rompe', rows2.length === 2 && rows2[0].live === null && b.pedidos.length === 2 && !/departed_at/.test(b.pedidos[1]), JSON.stringify(b.pedidos));
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── C · La ruta del conductor: el vuelo en la tarjeta y «Ver avión» ──');
{
  const { w, errores, q, qa, click } = boot();
  await w.DriverRutas.open({ id: 'pD', full_name: 'Jorge Prueba', role: 'driver' }); await wait(120);
  const hero = q('.rt-hero .rt-hero-fl');
  t('Mi día: la tarjeta grande dice cómo viene el vuelo y ofrece «Ver avión»', hero && /AV9306 · En el aire/.test(tx(hero)) && new RegExp(`Llega ${hm(48)} · 8 min tarde`).test(tx(hero)) && /Ver avión/.test(tx(hero)), tx(hero));
  t('usa el vuelo del día de la hora pedida, no el mismo AV9306 de ayer (ya aterrizado)', hero && !/Aterrizó/.test(tx(hero)));
  const v2 = qa('.rt-vc').find((x) => x.dataset.v === 'V2');
  t('en «Más tarde», una llegada sin datos todavía dice «recoge en JMC» (nada inventado)', v2 && /1 auxiliares · recoge en JMC/.test(tx(v2)), tx(v2));

  await click(q('.rt-hero [data-rt="detail"]'), 150);
  const det = () => qa('#rt-layers .rt-scr').pop();
  const card = det() && det().querySelector('.rt-flcard');
  t('Detalle: la tarjeta del vuelo con «desde Bogotá», cómo va y «Ver avión»', card && /AV9306 · desde Bogotá/.test(tx(card)) && /En el aire/.test(tx(card)) && /Ver avión/.test(tx(card)), tx(card));
  t('…y no repite el vuelo como pastilla en el resumen', det() && !/AV9306/.test(tx(det().querySelector('.rt-sum'))));
  t('la parada del aeropuerto muestra el estado (antes solo el código)', det() && /AV9306 8 min tarde/.test(tx(det().querySelector('.rt-stops'))), det() && tx(det().querySelector('.rt-stops')).slice(0, 120));

  const L = w.L;
  await click(card, 150);
  const sh = () => w.document.querySelector('#rt-sheet-host .rt-fl');
  t('tocar la tarjeta abre la hoja «Ver avión»', !!sh());
  t('…con el vuelo, la aerolínea y de dónde viene', /AV9306 · Avianca/.test(tx(sh())) && /Bogotá \(BOG\) → JMC/.test(tx(sh())), tx(sh()).slice(0, 120));
  t('…cómo va y a qué hora llega', /En el aire/.test(tx(sh())) && new RegExp(`Llega ${hm(48)} · 8 min tarde`).test(tx(sh())));
  t('…despegó, llega (estimado), hora prevista', new RegExp(`Despegó ${hm(-22)}`).test(leer(sh())) && new RegExp(`Llega \\(estimado\\) ${hm(48)}`).test(leer(sh())) && new RegExp(`Hora prevista ${hm(40)}`).test(leer(sh())), leer(sh()));
  t('…quiénes vienen en ese vuelo y dónde se recogen', /Vienen en este vuelo Laura Prueba Gómez, Andrés Prueba Ruiz/.test(leer(sh())) && new RegExp(`Los recoges ${hm(50)} · Salida de pasajeros`).test(leer(sh())), leer(sh()));
  t('…el último dato en vivo en metros y km/h', /9\.449 m · 796 km\/h · A320/.test(tx(sh())), tx(sh()));
  t('…y dice que la posición sale de FR24 y no va en línea recta', /Última posición de Flightradar24/.test(tx(sh())) && /no va en línea recta/.test(tx(sh())));
  const planes = L.__markers('rt-fl-plane');
  t('el mapa pone el avión (y JMC y BOG), con la línea hasta JMC', planes.length === 1 && L.__markers('rt-fl-pill').length === 2 && L.__log.lines.some((l) => !l._onRemoveCalled), String(planes.length));
  const mapaFl = L.__liveMaps().find((m) => m.getContainer() && m.getContainer().closest('.rt-fl'));
  t('el mapa se dibuja en canvas (preferCanvas: el svg de Leaflet lo aplastaba el CSS del diseño)', mapaFl && mapaFl.options.preferCanvas === true);

  // Cerrar la hoja: se quita el mapa (y su reloj).
  const bg = w.document.querySelector('#rt-sheet-host [data-rx-sheet-bg]');
  if (bg) bg.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await wait(300);
  t('al cerrar la hoja se quita su mapa', !sh() && mapaFl && mapaFl._removed === true);

  // V2: llegada que todavía no se sigue.
  await click(det().querySelector('[data-rt="pop"]'), 120);
  await click(qa('.rt-vc').find((x) => x.dataset.v === 'V2'), 150);
  const c2 = det() && det().querySelector('.rt-flcard');
  t('llegada sin datos: «Todavía no se sigue · desde las HH:MM» (2 h antes de la hora pedida)', c2 && /Todavía no se sigue/.test(tx(c2)) && new RegExp(`desde las ${hm(190 - 120)}`).test(tx(c2)), tx(c2));
  await click(c2, 150);
  t('…su hoja no pinta mapa (no se sabe de dónde viene)', sh() && !sh().querySelector('.rt-fl-map') && /LA4021 · LATAM/.test(tx(sh())));
  const bg2 = w.document.querySelector('#rt-sheet-host [data-rx-sheet-bg]'); if (bg2) bg2.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await wait(300);

  // V3: salida — FR24 solo sigue llegadas.
  await click(det().querySelector('[data-rt="pop"]'), 120);
  await click(qa('.rt-vc').find((x) => x.dataset.v === 'V3'), 150);
  t('salida: sin «Ver avión»; el código sigue en el resumen', det() && !det().querySelector('.rt-flcard') && /AV1234/.test(tx(det().querySelector('.rt-sum'))));
  w.DriverRutas.close();
  t('sin errores de script', errores.length === 0, errores.join(' | '));
}
{
  // Cuando el vuelo aterriza, la tarjeta lo dice.
  const { w, errores, q } = boot({ filas: [fila({ status: 'landed', actual_at: iso(-2), delay_min: 6, vuelo: null })] });
  await w.DriverRutas.open({ id: 'pD', full_name: 'Jorge Prueba', role: 'driver' }); await wait(120);
  t('aterrizado: «AV9306 · Aterrizó HH:MM» y «Llegó 6 min tarde»', /AV9306 · Aterrizó/.test(tx(q('.rt-hero-fl'))) && new RegExp(`Aterrizó ${hm(-2)}`).test(tx(q('.rt-hero-fl'))) && /Llegó 6 min tarde/.test(tx(q('.rt-hero-fl'))), tx(q('.rt-hero-fl')));
  w.DriverRutas.close();
  t('sin errores de script', errores.length === 0, errores.join(' | '));
}
{
  // Con el seguimiento apagado no sale nada nuevo (la hoja diría siempre lo mismo).
  const { w, errores, q, qa, click } = boot({ flags: false });
  await w.DriverRutas.open({ id: 'pD', full_name: 'Jorge Prueba', role: 'driver' }); await wait(120);
  t('seguimiento apagado: sin «Ver avión» en Mi día', !q('.rt-hero-fl'));
  await click(q('.rt-hero [data-rt="detail"]'), 150);
  const d = qa('#rt-layers .rt-scr').pop();
  t('…ni en el Detalle; el código del vuelo sigue como antes', d && !d.querySelector('.rt-flcard') && /AV9306/.test(tx(d.querySelector('.rt-sum'))));
  w.DriverRutas.close();
  t('sin errores de script', errores.length === 0, errores.join(' | '));
}

console.log(`\n${ok}/${ok + bad} pasaron`);
console.log('NO cubierto: el layout y el mapa de verdad (mirado con Chromium a 360/390, día y noche), la RLS real de flight_statuses para un conductor, el teléfono.');
process.exit(bad ? 1 : 0);
