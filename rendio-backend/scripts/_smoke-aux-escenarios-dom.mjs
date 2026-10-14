// Prueba del arnés fixtures/aux-escenarios.js (P9) sobre la app de verdad
// (index.html + api.js + api-aux.js + auxiliar.js) en jsdom, con la bandera del
// rediseño APAGADA (UI de hoy): lo que se prueba es el ARNÉS, no las pantallas.
//
//   cd rendio-backend/scripts && node _smoke-aux-escenarios-dom.mjs
//
// Comprueba:
//   · cada escenario monta y pinta sin excepción, y sin tocar la red (window.sb
//     es una trampa que anota cualquier uso);
//   · cada viaje T tiene EXACTAMENTE las claves de ApiAux.mapTrip (la forma que
//     devolverá la base), y date/time/requiredAt son coherentes en Bogotá;
//   · las reglas que los escenarios deben ejercitar (sin plan ⇒ sin hora ni
//     código; D14 ⇒ pos solo en estado activo; 20:30 no cae al día siguiente;
//     pagos y puntos en blanco);
//   · las escrituras quedan anotadas y restaurar() deja todo como estaba;
//   · los datos no traen los textos prohibidos del diseño.
// NO cubre: layout, animación, Leaflet real (window.L no existe aquí), push.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
const FIX = readFileSync(new URL('./fixtures/aux-escenarios.js', import.meta.url), 'utf8');
let ok = 0, fail = 0;
const t = (n, cond, det) => { if (cond) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + det : ''}`); } };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
const errores = [];
window.addEventListener('error', (e) => errores.push(e.message));
window.RENDIO_CONFIG = {}; window.toast = () => {}; window.L = undefined;
window.escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Trampa: cualquier uso del cliente de Supabase es una llamada a la red.
const red = [];
const trampa = new Proxy(function () {}, {
  get: (_, k) => { if (k === 'then') return undefined; red.push(String(k)); return trampa; },
  apply: () => { red.push('()'); return trampa; },
});
window.sb = trampa;
window.state = { settings: {} };
for (const f of ['api.js', 'api-aux.js', 'aux-residencias.js', 'aux-privado.js', 'aux-presentacion.js', 'auxiliar.js']) window.eval(read(f));
red.length = 0;   // cargar api.js lee window.sb una vez: no cuenta
window.localStorage.setItem('rendio.aux.onboarded', '1');
if (window.AuxPresentacion && window.AuxPresentacion.markOnboarded) window.AuxPresentacion.markOnboarded();

// Las claves reales de un viaje T (las que arma ApiAux.mapTrip con una fila de la RPC).
const CLAVES = Object.keys(window.ApiAux.mapTrip({ id: 'x', direction: 'home_to_airport', raw_status: 'requested' })).sort().join();
const realListMy = window.Api.listMyReservations, realTrack = window.Api.trackReservation, realMyTrips = window.ApiAux.listMyTrips;

window.eval(FIX);
const E = window.AuxEscenarios;
const A = window.Auxiliar;
const ui = () => window.document.getElementById('auxiliar-ui');
await A.init({ id: 'p1', full_name: 'Arranque', role: 'auxiliar' }).catch(() => {});
await wait(30);

console.log('\n── El arnés ──');
const lista = E.list();
const PEDIDOS = ['vacio', 'error-carga', 'pendiente-sin-plan', 'pendiente-vencido', 'asignado-publicado', 'asignado-sin-hora', 'en-camino', 'llego',
  'a-bordo-salida', 'a-bordo-llegada', 'entregado-sin-calificar', 'cancelado', 'historial', 'privado-solicitado', 'privado-aprobado',
  'privado-rechazado', 'primicia', 'suspendido', 'traslado-noche', 'cobro-en-blanco', 'puntos-en-blanco'];
t(`los ${PEDIDOS.length} escenarios del plan (§7.2 + cobro y puntos en blanco) existen`, PEDIDOS.every(n => lista.includes(n)), PEDIDOS.filter(n => !lista.includes(n)).join(','));
t('cada uno tiene su línea de info', lista.every(n => typeof E.info(n) === 'string' && E.info(n).length > 5));
let e = null; try { E.montar('no-existe'); } catch (x) { e = x.message; }
t('un nombre desconocido explica cuáles hay', e && /Hay: vacio/.test(e), e);

console.log('\n── Cada escenario monta, pinta y no sale a la red ──');
const hoyBog = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
for (const n of lista) {
  red.length = 0; errores.length = 0;
  let d = null, ex = null;
  try { d = E.montar(n); await wait(5); if (d.principal) { E.montar(n, { abrir: true }); await wait(40); A.stopTrack(); } }
  catch (x) { ex = x.message; }
  const claves = (d ? d.trips : []).map(x => Object.keys(x).sort().join());
  const malas = claves.filter(k => k !== CLAVES);
  const coherentes = (d ? d.trips : []).every(x => x.requiredAt === new Date(`${x.date}T${x.time}:00-05:00`).toISOString());
  t(`${n}: monta y pinta${d && d.principal ? ' (y abre el viaje)' : ''}, forma T exacta, sin red`,
    !ex && errores.length === 0 && ui().innerHTML.length > 50 && malas.length === 0 && coherentes && red.length === 0,
    ex || errores[0] || (malas.length ? 'claves distintas' : '') || (!coherentes ? 'date/time ≠ requiredAt' : '') || (red.length ? 'RED: ' + red.slice(0, 6).join('.') : ''));
}

console.log('\n── Lo que los escenarios deben ejercitar ──');
let d = E.datos('pendiente-sin-plan');
t('sin plan: pickupAt null, meetCode vacío, sin conductor', d.trips[0].pickupAt === null && d.trips[0].meetCode === '' && d.trips[0].driver === null && d.trips[0].published === false);
d = E.datos('asignado-publicado');
t('publicado: recogida 03:48, código de 4 dígitos, conductor y carro con color', /T08:48:00/.test(d.trips[0].pickupAt) && /^\d{4}$/.test(d.trips[0].meetCode) && d.trips[0].driver.first && d.trips[0].vehicle.color, d.trips[0].pickupAt);
t('publicado: ★ oculta (6 calificaciones < 10)', d.trips[0].driver.rating === null && d.trips[0].driver.ratingN === 6);
d = E.datos('asignado-sin-hora');
t('asignado sin hora: published pero pickupAt null', d.trips[0].published === true && d.trips[0].pickupAt === null);
for (const [n, conPos] of [['asignado-publicado', false], ['en-camino', true], ['llego', true], ['a-bordo-salida', true], ['a-bordo-llegada', true]]) {
  const x = E.datos(n); const i = x.track[x.principal];
  t(`D14 en ${n}: pos ${conPos ? 'presente' : 'NULL'}`, conPos ? !!(i && i.pos) : (i && i.pos === null));
}
d = E.datos('llego');
t('llegó: stop_status arrived con arrived_at', d.track[d.principal].stop_status === 'arrived' && !!d.track[d.principal].arrived_at);
d = E.datos('pendiente-vencido');
t('vencido: la hora ya pasó (hace ~8 h)', Date.parse(d.trips[0].requiredAt) < Date.now() - 7 * 3600e3);
d = E.datos('traslado-noche');
const man = new Date(Date.now() + 86400e3).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
t('noche: 20:30 con la fecha de mañana en Bogotá', d.trips[0].time === '20:30' && d.trips[0].date === man, `${d.trips[0].date} vs ${man} (hoy ${hoyBog})`);
d = E.datos('suspendido');
t('suspendido: is_active false con motivo, y su viaje sigue', d.profile.is_active === false && d.profile.suspended_reason && d.trips.length === 1);
d = E.datos('primicia');
t('primicia: privado apagado (como producción)', d.settings.aux_private_enabled === false);
d = E.datos('privado-aprobado');
t('privado aprobado: silencio, camioneta y ★ con 37', d.trips[0].quiet === true && d.trips[0].vehicle.plate === 'KTQ220' && d.trips[0].driver.rating === 4.8);
d = E.datos('dos-unidades');
t('dos unidades: header con residence2', !!d.header.residence2 && d.header.unit2 === 'Casa 14');
d = E.datos('historial');
t('historial: done ★5/★4/sin calificar, cancelado, no-show, vencido y uno próximo',
  ['done', 'cancelled', 'noshow', 'pending'].every(s => d.trips.some(x => x.status === s)) && d.trips.filter(x => x.status === 'done' && !x.rated).length === 1);

console.log('\n── Montado: lecturas del escenario, escrituras anotadas ──');
E.montar('en-camino');
t('Auxiliar.state tiene los viajes y el perfil del escenario', A.state.trips.length === 1 && A.state.trips[0].status === 'onway' && A.state.profile.full_name === 'Laura Gómez Ruiz');
t('Auxiliar.header del escenario', A.header && A.header.airlineName === 'Avianca' && A.header.residence.name === 'El Olivar');
t('state.settings del escenario', window.state.settings.aux_wait_minutes === 5 && window.state.settings.ops_contact_phone === '');
const i1 = await window.Api.trackReservation(A.state.trips[0].id);
t('Api.trackReservation devuelve I del escenario', i1 && i1.raw_status === 'en_route' && i1.pos && i1.meet_code === A.state.trips[0].meetCode);
const t1 = await window.ApiAux.listMyTrips();
t('ApiAux.listMyTrips devuelve copias NUEVAS (no los mismos objetos del estado)', t1.length === 1 && t1[0] !== A.state.trips[0] && t1[0].id === A.state.trips[0].id);
t('Api.listMyReservations = mismos viajes', (await window.Api.listMyReservations())[0].id === t1[0].id);
t('getOpsContact en blanco (sin teléfono ni horario inventados)', JSON.stringify(await window.ApiAux.getOpsContact()) === '{"phone":"","hours":""}');
await window.Api.createReservation({ type: 'sal' });
await window.ApiAux.crewSend('hola', { reservationId: 'x' });
await window.ApiAux.changeFlight('x', { flight: 'AV1', date: '2026-10-01', time: '05:00' });
t('escrituras anotadas en AuxEscenarios.llamadas, sin red', E.llamadas.map(c => c.fn).join() === 'Api.createReservation,ApiAux.crewSend,ApiAux.changeFlight' && red.length === 0, E.llamadas.map(c => c.fn).join());
E.montar('error-carga');
t('error-carga: source error y las dos fuentes devuelven null', A.state.source === 'error' && (await window.ApiAux.listMyTrips()) === null && (await window.Api.listMyReservations()) === null);
E.montar('coordinacion-con-mensajes');
t('coordinación: 1 sin leer; marcar leído lo deja en 0', (await window.ApiAux.crewUnread()) === 1 && (await window.ApiAux.crewMarkRead()) === 1 && (await window.ApiAux.crewUnread()) === 0);

console.log('\n── Pagos y puntos en blanco ──');
window.AuxPagos = { summary: () => ({ status: 'vencido', amountCOP: 1 }), paused: () => true };
window.AuxPuntos = { enabled: () => true, summary: () => ({ balance: 999 }), cancelBonus: () => ({ pts: 20 }) };
window.ApiCobro = { getMyAccount: async () => ({ amount: 1 }) };
E.montar('vacio');
t('AuxPagos.summary() → null y paused() → false', window.AuxPagos.summary() === null && window.AuxPagos.paused() === false);
t('AuxPuntos apagado: enabled false, summary null, sin bono', window.AuxPuntos.enabled() === false && window.AuxPuntos.summary() === null && window.AuxPuntos.cancelBonus() === null);
t('cada función de ApiCobro → null', (await window.ApiCobro.getMyAccount()) === null);
E.montar('puntos-en-blanco');
t('puntos-en-blanco: encendido y en cero', window.AuxPuntos.enabled() === true && window.AuxPuntos.summary().balance === 0 && window.state.settings.aux_points_enabled === true);

console.log('\n── restaurar() ──');
E.montar('asignado-publicado', { noche: true });
t('noche:true pone el nocturno', window.AuxPresentacion.themePref() === 'night' || ui().getAttribute('data-ax-night') === 'on', window.AuxPresentacion.themePref());
E.montar('asignado-publicado', { noche: false });
t('noche:false vuelve a «auto»', window.AuxPresentacion.themePref() === 'auto');
E.restaurar();
t('Api y ApiAux vuelven a sus funciones originales', window.Api.listMyReservations === realListMy && window.Api.trackReservation === realTrack && window.ApiAux.listMyTrips === realMyTrips);
t('AuxPagos / AuxPuntos / ApiCobro vuelven a lo que había', window.AuxPagos.summary().status === 'vencido' && window.AuxPuntos.summary().balance === 999 && typeof window.ApiCobro.getMyAccount === 'function');
t('llamadas se vacía', E.llamadas.length === 0);
red.length = 0;
try { await window.Api.getSettings(); } catch (_) {}
t('control: la trampa de red SÍ detecta una llamada real (la prueba «sin red» no es vacía)', red.length > 0, red.length);

console.log('\n── Los datos no traen textos prohibidos ──');
const todo = lista.map(n => { const x = E.datos(n); delete x.settings; return JSON.stringify(x); }).join('\n');
for (const [nom, re] of [['Carlos Mejía', /Carlos Mej[ií]a/], ['AV9525', /AV9525/], ['Juliana', /Juliana/], ['Plan B', /Plan B/], ['24/7', /24\/7/],
  ['en línea', /en l[ií]nea/i], ['Último cupo', /[ÚU]ltimo cupo/], ['Siempre hay cupo', /Siempre hay cupo/], ['kit', /\bkit\b/i], ['Preparado', /Preparado/], ['$ cifra', /\$\s?\d/]]) {
  t(`sin «${nom}»`, !re.test(todo));
}

console.log(`\n${ok} ✓ · ${fail} ✗`);
console.log('NO cubre: layout, animación, Leaflet real, push real; las pantallas nuevas se prueban en sus propios _smoke-rx-*.');
process.exit(fail ? 1 : 0);
