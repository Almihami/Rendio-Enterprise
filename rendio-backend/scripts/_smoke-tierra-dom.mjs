// T8 · Trabajo en tierra (sin vuelo), 29-sep-2026 — prueba jsdom + solver.
//
// «No todos trabajan con vuelo, solo trabajan por tierra»: el personal de
// operaciones del aeropuerto va a MDE igual que la tripulación, pero sin vuelo.
// Respuestas de la profa: manda la hora de LLEGADA AL DESTINO, lo piden desde la
// misma app y pagan igual. Esta prueba comprueba:
//
//   A) EL PEDIDO (app real: index.html + auxiliar.js + aux-rx-pedir.js + api.js
//      de verdad con un Supabase FALSO que anota lo que se inserta):
//      · el interruptor «Trabajo en tierra (sin vuelo)» arriba del paso del vuelo;
//      · apagado = lo de siempre (en la llegada el vuelo es obligatorio);
//      · llegada en tierra: sin número de vuelo, la hora se llama «Hora en que
//        sales del aeropuerto», el CTA se habilita solo con fecha y hora, y el
//        resumen dice «En tierra» y «sales de MDE»;
//      · el envío manda ground_ops=true y NINGÚN vuelo (ni uno escrito antes de
//        encender el interruptor); apagado no manda la columna;
//      · salida en tierra: misma hora de siempre, sin pernocta, y el regreso del
//        mismo día pide solo la hora de salir del aeropuerto (2 reservas en tierra);
//      · el interruptor arranca como el ÚLTIMO pedido (y «Repetir» lo repite);
//      · sin 0092 (PostgREST no conoce ground_ops) la reserva igual se crea;
//      · la pantalla de siempre (bandera apagada) también trae el interruptor.
//   B) LAS LECTURAS de api.js: groundOps en Mis viajes y en Reservas del admin,
//      `tierra` y sin vuelo en el tablero, «Tierra» en Operación en vivo.
//   C) EL SOLVER (admin-rutas.js real, recortado como plan-del-dia.mjs): en una
//      llegada en tierra NO se suma desembarque (ni por aerolínea ni de
//      respaldo); en una mezcla manda el que sale último; la salida en tierra se
//      rutea igual que siempre. CON LA FUSIÓN DE PRODUCCIÓN (ventana 20, margen
//      15): el de tierra no se pega a un vuelo que sale después que él (misma
//      portería incluida), sí a uno que ya está afuera a su hora; la vuelta dice
//      «aterriza» a la hora del vuelo; al partir por cupo cada pedazo lleva su
//      hora; el semáforo muestra la espera del de tierra; y 150 días al azar
//      (nadie de tierra espera más de 5 min con el carro libre).
//   D) EL ADMIN: «Tierra» en la tarjeta del tablero, en la parada y en Reservas.
//
// LO QUE NO CUBRE: jsdom no hace layout ni corre animaciones (no prueba cómo se
// ve la tarjeta del interruptor ni que la transición del toggle se vea); no hay
// base real (Supabase falso: no se prueban la migración 0092, la RLS ni que
// PostgREST devuelva de verdad ese error cuando falta la columna); el solver
// corre con distancias en línea recta (sin OSRM ni TomTom), así que solo se
// comparan horas de recogida en el aeropuerto, no recorridos; y la tarjeta del
// viaje del tripulante (aux-rx-viaje / aux-rx-inicio, del frente «tarjeta») no
// se mira aquí.
//
//   cd rendio-backend && node scripts/_smoke-tierra-dom.mjs
process.env.TZ = 'America/Bogota';
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

const RES = [{ id: 'r1', name: 'Olivar Apartamentos', sector: 'Norte', latitude: 6.15, longitude: -75.37 }];
const UNA = { residenceId: 'r1', residence: RES[0], unit: 'Torre 3 · 302', residenceId2: null, residence2: null, unit2: '', homeAddress: '', homeLat: null, homeLng: null };
const SETTINGS = { aux_min_lead_hours: 6, aux_wait_minutes: 5 };

// ═════════════════════════════════════════════════════════════════════════════
// A) El pedido
// ═════════════════════════════════════════════════════════════════════════════
async function boot({ rx = true, failGround = false } = {}) {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const errors = [], warns = [];
  w.console.error = (...a) => { errors.push(a.map(String).join(' ')); };
  w.console.warn = (...a) => { warns.push(a.map(String).join(' ')); };
  w.RENDIO_CONFIG = {}; w.toast = () => {};
  w.escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  w.eval(readFileSync(FIX + 'fake-sw.js', 'utf8'));
  w.eval(readFileSync(FIX + 'fake-leaflet.js', 'utf8'));
  w.localStorage.setItem('rendio.aux.rx', rx ? '1' : '0');
  w.localStorage.setItem('rendio.aux.onboarded.p1', '1');
  // Supabase falso: anota lo que se inserta. failGround = una base SIN 0092
  // (PostgREST responde PGRST204 nombrando la columna que no conoce).
  const inserts = [], intentos = [];
  const qb = (table) => {
    const q = {
      _ins: null,
      select() { return q; }, eq() { return q; }, order() { return q; }, in() { return q; }, is() { return q; },
      gte() { return q; }, lte() { return q; }, limit() { return q; }, update() { return q; },
      insert(row) { q._ins = row; return q; },
      maybeSingle: async () => (table === 'auxiliar_profiles' ? { data: { id: 'ap1' }, error: null } : { data: null, error: null }),
      single: async () => {
        if (!q._ins) return { data: null, error: null };
        const row = JSON.parse(JSON.stringify(q._ins));
        intentos.push(row);
        if (failGround && 'ground_ops' in row) {
          return { data: null, error: { code: 'PGRST204', message: "Could not find the 'ground_ops' column of 'reservations' in the schema cache" } };
        }
        inserts.push(row);
        return { data: { id: 'res' + inserts.length }, error: null };
      },
      then(a, b) { return Promise.resolve({ data: [], error: null }).then(a, b); },
    };
    return q;
  };
  w.sb = {
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }), getSession: async () => ({ data: { session: null } }) },
    from: qb, rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'no existe' } }),
  };
  w.state = { settings: { ...SETTINGS } };
  const header = { preferredLevel: null, residenceId: 'r1', residence: RES[0], unit: UNA.unit, residenceId2: null, residence2: null, unit2: '' };
  w.eval(read('api.js'));
  const REAL = w.Api;
  w.Api = {
    createReservation: REAL.createReservation,
    notesUser: REAL.notesUser,
    listMyReservations: async () => [],
    listResidences: async () => RES,
    getMyAuxiliarPlace: async () => UNA,
    saveMyResidence: async () => true,
    getSettings: async () => w.state.settings,
    privateBusyAt: async () => false,
    getMyAuxHeader: async () => header,
    listAirlines: async () => null,
    getMyAirlineIata: async () => 'AV',
  };
  const PANTALLAS = ['aux-rx-inicio.js', 'aux-rx-viajes.js', 'aux-rx-avisos.js', 'aux-rx-viaje.js', 'aux-rx-pedir.js', 'aux-rx-perfil.js',
    'aux-rx-pagos.js', 'aux-rx-puntos.js', 'aux-rx-coord.js', 'aux-rx-vuelo.js'];
  const files = ['aux-rx-ui.js', 'aux-shell.js', 'api-aux.js', 'aux-residencias.js', 'aux-privado.js', 'aux-celebracion.js', 'aux-presentacion.js', ...PANTALLAS, 'auxiliar.js'];
  for (const f of files) w.eval(read(f));
  if (!(w.AuxRxInicio && typeof w.AuxRxInicio.passHTML === 'function')) {
    w.AuxRxInicio = { passHTML: (tr) => `<button type="button" class="rx-pass" data-test-pass="${tr.id}"></button>` };
  }
  const ui = () => w.document.getElementById('auxiliar-ui');
  const $ = (s) => ui().querySelector(s);
  const click = (s) => { const e = typeof s === 'string' ? $(s) : s; if (!e) throw new Error('no existe: ' + s); e.click(); };
  const set = (k, v) => { const i = $(`[data-scr="book"]:not(.out) [data-field="${k}"]`) || $(`[data-field="${k}"]`); if (!i) throw new Error('no existe campo ' + k); i.value = v; i.dispatchEvent(new w.Event('input', { bubbles: true })); return i; };
  const A = () => w.Auxiliar.state;
  await w.Auxiliar.init({ id: 'p1', full_name: 'Tripulante de prueba', role: 'auxiliar' });
  await wait(80);
  return { w, ui, $, click, set, A, inserts, intentos, errors, warns };
}

const bk = '[data-scr="book"]:not(.out)';
const txt = (E) => { const b = E.$(bk + ' .rx-book'); return b ? b.textContent.replace(/\s+/g, ' ') : ''; };
const cont = (E) => E.$(bk + ' .ax-cta-bar [data-ax="next"]');
const slide = (E) => E.$(bk + ' .ax-cta-bar .rx-slide');
const tierraTg = (E) => E.$(bk + ' [data-ax="toggle"][data-key="groundOps"]');
async function nuevo(E) {
  E.A().view = 'home'; E.A().tab = 'inicio'; E.w.Auxiliar.rerender(); await wait();
  E.w.Auxiliar.newTrip(); await wait(60);
}
async function tipo(E, type) { E.click(`[data-ax="type"][data-type="${type}"]`); await wait(320); }
async function hastaRevisar(E) {
  while (E.w.Auxiliar.stepKind() !== 'revisar') {
    const c = cont(E); if (!c || c.disabled) throw new Error('trancado en ' + E.w.Auxiliar.stepKind());
    E.click(c); await wait();
  }
}
async function enviar(E) { E.click(slide(E).querySelector('.rx-slide-k')); await wait(480); }

console.log('\n── A1 · el interruptor y lo de siempre (apagado) ──');
let E = await boot();
await nuevo(E);
t('sin viajes: el pedido arranca con «en tierra» apagado', E.A().form.groundOps === false, JSON.stringify(E.A().form));
await tipo(E, 'lle');
t('paso del vuelo: interruptor «Trabajo en tierra (sin vuelo)»', !!tierraTg(E) && /Trabajo en tierra \(sin vuelo\)/.test(txt(E)));
const primero = E.$(bk + ' .rx-step > :not(h1)');
t('…ARRIBA del paso (primera pieza, en su rx-card con entrada rx-in)', !!primero && primero.getAttribute('data-rx-key') === 'ground' && primero.classList.contains('rx-card') && primero.classList.contains('rx-in') && primero.contains(tierraTg(E)));
t('…y apagado', !tierraTg(E).classList.contains('on') && tierraTg(E).getAttribute('aria-pressed') === 'false');
t('apagado: la llegada pide número de vuelo y «Hora de aterrizaje»', !!E.$('[data-field="flightNum"]') && /Hora de aterrizaje/.test(txt(E)) && /Cuál es tu vuelo/.test(txt(E)));
E.set('date', FUTURO); E.set('time', '17:00');
t('apagado: sin número de vuelo, Continuar bloqueado (como siempre)', cont(E).disabled);
E.set('flightNum', '9412');
t('apagado: con el número, Continuar habilitado', !cont(E).disabled && E.A().form.flight === 'AV9412');
t('apagado: rx-calc «Aterrizas»', /Aterrizas/.test(E.$(bk + ' .rx-calc')?.textContent || ''));

console.log('\n── A2 · llegada en tierra ──');
const tg0 = tierraTg(E), timeIn0 = E.$('[data-field="time"]');
E.click(tg0); await wait();
t('encender: el MISMO nodo del interruptor (su transición corre) y form.groundOps', tierraTg(E) === tg0 && tg0.classList.contains('on') && tg0.getAttribute('aria-pressed') === 'true' && E.A().form.groundOps === true);
t('sin campo de número de vuelo ni chip de aerolínea', !E.$('[data-field="flightNum"]') && !E.$('#ax-fl-chip-flight'));
t('la hora se llama «Hora en que sales del aeropuerto»', /Hora en que sales del aeropuerto/.test(txt(E)) && !/Hora de aterrizaje/.test(txt(E)));
t('el título ya no pregunta por un vuelo («¿A qué hora sales?»)', /A qué hora sales/.test(txt(E)) && !/Cuál es tu vuelo/.test(txt(E)));
t('la nota dice que no se suma desembarque', /no le sumamos tiempo de desembarque/.test(txt(E)));
t('rx-calc «Sales de MDE» con la hora puesta', /Sales de MDE/.test(E.$(bk + ' .rx-calc')?.textContent || '') && E.$(bk + ' .rx-calc .rx-calc-t')?.textContent === '17:00');
t('la hora escrita no se perdió', E.$('[data-field="time"]').value === '17:00' && E.A().form.time === '17:00');
t('sin pernocta (noche entre vuelos) en tierra', !E.$('[data-key="isPernocta"]') && !!E.$('[data-key="isReserva"]'));
t('Continuar habilitado solo con fecha y hora (sin vuelo)', !cont(E).disabled);
E.set('time', '');
t('sin hora, bloqueado', cont(E).disabled);
E.set('time', '17:00');
t('hint «ok» sin avión: no dice «al bajar del avión»', E.w.Auxiliar.timeHint()?.level === 'ok' && !/avión/.test(E.w.Auxiliar.timeHint()?.text || ''), JSON.stringify(E.w.Auxiliar.timeHint()));
await hastaRevisar(E);
const rv = E.$(bk + ' .rx-review');
t('resumen: fila «Trabajo · En tierra · sales 17:00» (sin fila Vuelo)', /Trabajo/.test(rv.textContent) && /En tierra/.test(rv.textContent) && /sales 17:00/.test(rv.textContent) && !/AV9412/.test(rv.textContent) && !/Vuelo/.test(rv.textContent), rv.textContent.replace(/\s+/g, ' '));
t('la hora grande dice «sales de MDE»', /sales de MDE/.test(rv.querySelector('.rx-rv-time').textContent) && !/aterrizas/.test(rv.querySelector('.rx-rv-time').textContent));
t('la fila lleva el ícono Briefcase y vuelve al paso', !!rv.querySelector('.rx-rv-row[data-step="vuelo"] use[href="#rx-Briefcase"]'));
E.inserts.length = 0;
await enviar(E);
const lle = E.inserts[0] || {};
t('una reserva, llegada, con ground_ops=true', E.inserts.length === 1 && lle.direction === 'airport_to_home' && lle.ground_ops === true, JSON.stringify(lle));
t('SIN vuelo: ni «Vuelo AV9412» en las notas (quedó escrito antes de encender) ni flight_id', !/vuelo/i.test(lle.notes || '') && lle.flight_id === null);
t('la hora que viaja es la que dio (sale 17:00, sin desembarque)', /T17:00:00-05:00$/.test(lle.required_arrival_at || ''), lle.required_arrival_at);
t('el viaje en memoria queda marcado en tierra y sin vuelo', E.A().trips[0]?.groundOps === true && !E.A().trips[0]?.flight);

console.log('\n── A3 · el interruptor arranca como el último pedido ──');
await nuevo(E);
t('después de un pedido en tierra, el siguiente arranca ENCENDIDO', E.A().form.groundOps === true);
await tipo(E, 'sal');
t('…y se ve encendido en el paso del vuelo', tierraTg(E)?.classList.contains('on'));
E.A().trips.unshift({ id: 'viejo', type: 'sal', date: FUTURO, time: '05:00', status: 'done', groundOps: false, createdAt: new Date(Date.now() - 86400000 * 30).toISOString() });
await nuevo(E);
t('un viaje más VIEJO sin tierra no cambia nada (manda el más reciente)', E.A().form.groundOps === true);
E.A().trips.unshift({ id: 'nuevo', type: 'sal', date: FUTURO, time: '05:00', status: 'pending', groundOps: false, createdAt: new Date(Date.now() + 1000).toISOString() });
await nuevo(E);
t('si el último pedido fue con vuelo, arranca apagado', E.A().form.groundOps === false);
t('no se guardó nada de esto en el teléfono', !Object.keys(E.w.localStorage).some(k => /tierra|ground/i.test(k)));
// «Repetir el de siempre»: el tipo, el punto… y si es en tierra.
E.A().trips.length = 0;
E.A().trips.push({ id: 'hecho', type: 'lle', date: FUTURO, time: '17:00', status: 'done', groundOps: true, residenceId: 'r1', address: 'Olivar', createdAt: new Date().toISOString() });
E.A().view = 'home'; E.A().tab = 'inicio'; E.w.Auxiliar.rerender(); await wait();
const rep = E.$('[data-ax="repeat"]');
if (rep) { E.click(rep); await wait(60); }
t('«Repetir» un traslado en tierra arranca en tierra', !!rep && E.A().form.groundOps === true && E.A().form.type === 'lle', rep ? JSON.stringify(E.A().form) : 'sin botón repetir');

console.log('\n── A4 · salida en tierra (y el regreso del mismo día) ──');
E.A().trips.length = 0;
await nuevo(E);
await tipo(E, 'sal');
E.click(tierraTg(E)); await wait();
t('salida en tierra: la hora sigue siendo «estar en el aeropuerto»', /Hora en que quieres estar en el aeropuerto/.test(txt(E)) && !E.$('[data-field="flightNum"]'));
t('título «¿Cuándo vas al aeropuerto?» y nota sin «presentación»', /Cuándo vas al aeropuerto/.test(txt(E)) && !/presentación/.test(txt(E)));
t('sin pernocta; regreso del mismo día sí', !E.$('[data-key="isPernocta"]') && !!E.$('[data-key="sameDayBack"]'));
E.set('date', FUTURO); E.set('time', '05:10');
E.click('[data-key="sameDayBack"]'); await wait();
t('el regreso pide SOLO la hora de salir del aeropuerto (sin vuelo)', !!E.$('[data-field="backTime"]') && !E.$('[data-field="backFlightNum"]') && /Hora en que sales del aeropuerto/.test(E.$('[data-rx-key="backTime"]')?.textContent || ''));
t('Continuar bloqueado hasta poner esa hora', cont(E).disabled);
E.set('backTime', '14:30');
t('con la hora del regreso, Continuar habilitado (no pide vuelo)', !cont(E).disabled);
await hastaRevisar(E);
t('resumen: «En tierra · estar en MDE 05:10» y regreso «Sales de MDE 14:30»', /En tierra · estar en MDE 05:10/.test(txt(E)) && /Sales de MDE 14:30/.test(txt(E)) && !/Pernocta/.test(txt(E)), txt(E));
E.inserts.length = 0;
await enviar(E);
const ida = E.inserts[0] || {}, vuelta = E.inserts[1] || {};
t('2 reservas, las dos en tierra', E.inserts.length === 2 && ida.ground_ops === true && vuelta.ground_ops === true, E.inserts.length + ' · ' + JSON.stringify(E.inserts.map(x => x.ground_ops)));
t('la ida: salida 05:10, sin vuelo y sin pernocta', ida.direction === 'home_to_airport' && /T05:10/.test(ida.required_arrival_at || '') && !/vuelo/i.test(ida.notes || '') && ida.is_overnight === false);
t('el regreso: llegada 14:30 sin vuelo en las notas', vuelta.direction === 'airport_to_home' && /T14:30/.test(vuelta.required_arrival_at || '') && !/vuelo/i.test(vuelta.notes || '') && /Regreso del mismo día/.test(vuelta.notes || ''));

console.log('\n── A5 · apagado no manda la columna · pernocta colgada no viaja en tierra ──');
E.A().trips.length = 0;
await nuevo(E);
await tipo(E, 'sal');
E.set('date', FUTURO); E.set('time', '05:10');
E.click('[data-key="isPernocta"]'); await wait();
await hastaRevisar(E);
E.inserts.length = 0;
await enviar(E);
t('salida con vuelo: el payload NO lleva ground_ops (lo de siempre)', E.inserts.length === 1 && !('ground_ops' in E.inserts[0]) && E.inserts[0].is_overnight === true, JSON.stringify(E.inserts[0]));
E.A().trips.length = 0;
await nuevo(E);
await tipo(E, 'sal');
E.set('date', FUTURO); E.set('time', '05:10');
E.click('[data-key="isPernocta"]'); await wait();
E.click(tierraTg(E)); await wait();
await hastaRevisar(E);
E.inserts.length = 0;
await enviar(E);
t('pernocta marcada y DESPUÉS en tierra: no viaja (is_overnight false)', E.inserts.length === 1 && E.inserts[0].ground_ops === true && E.inserts[0].is_overnight === false, JSON.stringify(E.inserts[0]));
t('sin errores de consola (bandera encendida)', E.errors.length === 0, E.errors.slice(0, 3).join(' | '));

console.log('\n── A6 · base sin 0092: la reserva igual se crea ──');
const EF = await boot({ failGround: true });
await nuevo(EF);
await tipo(EF, 'lle');
EF.click(tierraTg(EF)); await wait();
EF.set('date', FUTURO); EF.set('time', '17:00');
await hastaRevisar(EF);
await enviar(EF);
t('primer intento con ground_ops (PGRST204) → reintento del MISMO escalón sin la columna', EF.intentos.length === 2 && EF.intentos[0].ground_ops === true && !('ground_ops' in EF.intentos[1]) && JSON.stringify(Object.keys(EF.intentos[1]).sort()) === JSON.stringify(Object.keys(EF.intentos[0]).filter(k => k !== 'ground_ops').sort()), JSON.stringify(EF.intentos.map(x => Object.keys(x).length)));
t('la reserva quedó (y el tripulante ve «booked»)', EF.inserts.length === 1 && !!EF.$('.rx-booked'));
t('se avisa en consola lo que se perdió (no en silencio)', EF.warns.some(x => /ground_ops/.test(x)), EF.warns.join(' | '));

console.log('\n── A7 · la pantalla de siempre (bandera apagada) ──');
const E0 = await boot({ rx: false });
E0.A().view = 'home'; E0.w.Auxiliar.rerender(); await wait();
E0.click('[data-ax="new"]'); await wait(60);
E0.click('[data-ax="type"][data-type="lle"]'); E0.click('[data-ax="next"]'); await wait();
t('heredado: interruptor de tierra (ax-toggle) y número de vuelo', !!E0.$('.ax-toggle[data-key="groundOps"]') && !!E0.$('[data-field="flightNum"]'));
E0.click('.ax-toggle[data-key="groundOps"]'); await wait();
t('heredado: al encenderlo se va el vuelo y la hora es la de salir del aeropuerto', !E0.$('[data-field="flightNum"]') && /Hora en que sales del aeropuerto/.test(E0.ui().textContent) && !E0.$('.ax-toggle[data-key="isPernocta"]'));
t('sin errores de consola (bandera apagada)', E0.errors.length === 0, E0.errors.slice(0, 3).join(' | '));

// ═════════════════════════════════════════════════════════════════════════════
// B) Lecturas de api.js (Supabase falso que sirve filas)
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── B · api.js lee ground_ops ──');
{
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = dom.window;
  const hoy = bogDay(Date.now() + 86400000);
  const ROWS = [
    { id: 'aaaaaaaa-1', direction: 'airport_to_home', pickup_address: 'Olivar, Rionegro', pickup_latitude: 6.15, pickup_longitude: -75.37,
      required_arrival_at: hoy + 'T17:00:00-05:00', status_h2a: null, status_a2h: 'scheduled', notes: 'Vuelo AV9412. timbre', created_at: new Date().toISOString(),
      ground_ops: true, is_overnight: false, is_firm: true, auxiliar_profiles: { profiles: { id: 'p1', full_name: 'Tripulante Uno', phone: '' } }, flights: null },
    { id: 'bbbbbbbb-2', direction: 'airport_to_home', pickup_address: 'Solare, Rionegro', pickup_latitude: 6.11, pickup_longitude: -75.42,
      required_arrival_at: hoy + 'T17:00:00-05:00', status_h2a: null, status_a2h: 'scheduled', notes: 'Vuelo JA5116. ', created_at: new Date().toISOString(),
      ground_ops: false, is_overnight: false, is_firm: true, auxiliar_profiles: { profiles: { id: 'p2', full_name: 'Tripulante Dos', phone: '' } }, flights: null },
  ];
  const cols = [];
  const qb = (table) => {
    let c = '';
    const q = {
      select(x) { c = x || ''; cols.push(table + ': ' + c); return q; },
      eq() { return q; }, order() { return q; }, in() { return q; }, is() { return q; }, gte() { return q; }, lte() { return q; }, limit() { return q; },
      maybeSingle: async () => (table === 'auxiliar_profiles' ? { data: { id: 'ap1' }, error: null } : { data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      then(a, b) {
        let r = { data: [], error: null };
        if (table === 'reservations') r = { data: ROWS, error: null };
        if (table === 'vehicles') r = { data: [{ id: 'v1', internal_code: 'V-01', license_plate: 'ABC123', capacity: 4, status: 'active' }], error: null };
        if (table === 'route_assignments') r = { data: [{ id: 'ra1', direction: 'airport_to_home', planned_start_at: hoy + 'T17:00:00-05:00', status: 'planned', driver_profile_id: null, vehicle_id: 'v1',
          vehicles: { license_plate: 'ABC123' }, route_stops: [{ stop_order: 1, status: 'pending', reservation_id: 'aaaaaaaa-1', reservations: ROWS[0] }] }], error: null };
        return Promise.resolve(r).then(a, b);
      },
    };
    return q;
  };
  w.sb = { auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) }, from: qb, rpc: async () => ({ data: null, error: { code: 'PGRST202' } }) };
  w.state = { settings: {} };
  w.eval(read('api.js'));
  const Api = w.Api;
  const mine = await Api.listMyReservations();
  t('Mis viajes (respaldo): groundOps true y createdAt en el de tierra', mine && mine[0].groundOps === true && !!mine[0].createdAt && mine[1].groundOps === false);
  t('…pidió ground_ops en el escalón de arriba', cols.some(x => /^reservations: .*ground_ops/.test(x)));
  const adm = await Api.listReservationsAdmin(1, 7);
  t('Reservas del admin: groundOps y SIN vuelo (aunque las notas traigan uno)', adm && adm[0].groundOps === true && adm[0].flight === '' && adm[1].flight === 'JA5116', adm && JSON.stringify(adm.map(x => [x.groundOps, x.flight])));
  const plan = await Api.listRoutePlanning('all');
  const auxs = plan ? Object.values(plan.aux) : [];
  const ta = auxs.find(a => a.reservationId === 'aaaaaaaa-1'), va = auxs.find(a => a.reservationId === 'bbbbbbbb-2');
  t('Tablero: tierra true y vuelo vacío; el de vuelo intacto', !!ta && ta.tierra === true && ta.vuelo === '' && !!va && va.tierra === false && va.vuelo === 'JA5116', JSON.stringify([ta && [ta.tierra, ta.vuelo], va && [va.tierra, va.vuelo]]));
  const op = await Api.listLiveOperation();
  t('Operación en vivo: el vuelo de un carro en tierra se dice «Tierra»', op && op.cars[0] && op.cars[0].flight === 'Tierra', op && JSON.stringify(op.cars.map(c => c.flight)));
}

// ═════════════════════════════════════════════════════════════════════════════
// C) El solver real (recortado como plan-del-dia.mjs)
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── C · solver: sin desembarque en tierra ──');
const SRC = read('admin-rutas.js');
const iFin = SRC.indexOf('return { lanes, order, unassigned };');
const solverSrc = SRC.slice(0, SRC.indexOf('\n  }', iFin) + 4);
const CSRC = read('admin-consola.js');
const helpersSrc = CSRC.slice(0, CSRC.indexOf('  // ---------------- CONSOLA'));
function solver(settings) {
  const fab = new Function('state', 'Api', 'window', 'toast', '$', 'fetch', `
    ${helpersSrc}
    ${solverSrc}
    return { rt, rtCfg, rtSolveDay, rtCarCompute, rtDeplaneOf, rtToMin, rtToHM };
  `);
  const S = fab({ settings }, {}, {}, () => {}, () => null, async () => { throw new Error('sin red'); });
  S.rtCfg();
  return S;
}
const AJ = { route_deplane_min: 20, route_deplane_av_nac_min: 15, route_deplane_av_int_min: 20, route_deplane_js_nac_min: 25, route_deplane_js_int_min: 30, route_deplane_wingo_min: 20 };
const persona = (o) => ({ n: 'P', zona: 'Z', resId: o.res || null, dir: '', lat: 6.15, lng: -75.37, pax: 1, vuelo: '', tierra: false, hotel: false, ...o });
{
  const S = solver(AJ);
  S.rt.aux = {
    av: persona({ type: 'lle', dl: '17:00', vuelo: 'AV9412' }),
    js: persona({ type: 'lle', dl: '16:40', vuelo: 'JA5116' }),
    sin: persona({ type: 'lle', dl: '17:00', vuelo: '' }),
    ti: persona({ type: 'lle', dl: '17:00', tierra: true }),
    ti2: persona({ type: 'lle', dl: '16:50', tierra: true }),
    tiv: persona({ type: 'lle', dl: '17:00', tierra: true, vuelo: 'AV9412' }),   // un vuelo colgado no cuenta
  };
  const m = S.rtToMin;
  t('con vuelo: lo de siempre (AV nacional 15, sin vuelo = respaldo 20)', S.rtDeplaneOf(['av']) === 15 && S.rtDeplaneOf(['sin']) === 20 && S.rtDeplaneOf(['av'], m('17:00')) === 15);
  t('en tierra: 0 minutos, con o sin hora de la vuelta', S.rtDeplaneOf(['ti']) === 0 && S.rtDeplaneOf(['ti'], m('17:00')) === 0 && S.rtDeplaneOf(['ti', 'ti2'], m('17:00')) === 0);
  t('en tierra aunque traiga un vuelo escrito: 0 (no se le suma el de AV)', S.rtDeplaneOf(['tiv'], m('17:00')) === 0);
  t('en tierra NO cae al respaldo de 20 (el caso «sin vuelo» de siempre)', S.rtDeplaneOf(['ti'], m('17:00')) !== S.rt.DEPLANE);
  t('mezcla, mismo minuto: manda el de vuelo (17:00 + 15)', S.rtDeplaneOf(['av', 'ti'], m('17:00')) === 15);
  t('mezcla: vuelo 16:40 JetSmart (sale 17:05) + tierra 17:00 → 5 sobre la vuelta de las 17:00', S.rtDeplaneOf(['js', 'ti'], m('17:00')) === 5);
  t('mezcla: el de vuelo sale antes que el de tierra → manda el de tierra (0)', (() => { S.rt.aux.js2 = persona({ type: 'lle', dl: '16:30', vuelo: 'AV9412' }); return S.rtDeplaneOf(['js2', 'ti'], m('17:00')) === 0; })());
}
{
  // Día armado de verdad (líneas rectas, un carro libre desde temprano).
  const armar = (aux) => {
    const S = solver({ ...AJ, route_merge_window_min: 0 });
    S.rt.aux = aux;
    S.rt.cars = [{ id: 'V-01', avail0: '01:30', capacity: 4 }, { id: 'V-02', avail0: '01:30', capacity: 4 }];
    const r = S.rtSolveDay(); S.rt.lanes = r.lanes; S.rt.order = r.order;
    return { S, ...r };
  };
  const A1 = armar({ ti: persona({ type: 'lle', dl: '17:00', tierra: true }) });
  const l1 = A1.lanes[0];
  t('llegada en tierra: el carro recoge a la hora dada (17:00), sin desembarque', !!l1 && l1.type === 'lle' && l1.start === '17:00' && l1.landing === '17:00', JSON.stringify(l1));
  const c1 = l1 ? A1.S.rtCarCompute(l1.id) : {};
  t('…el semáforo no la cuenta esperando y la vuelta dice «tierra»', c1.wait === 0 && c1.status === 'ontime' && c1.tierra === true && c1.hardDL === A1.S.rtToMin('17:00'));
  const A2 = armar({ av: persona({ type: 'lle', dl: '17:00', vuelo: 'AV9412' }) });
  t('la misma llegada con vuelo AV: recoge 17:15 (lo de siempre)', A2.lanes[0]?.start === '17:15', JSON.stringify(A2.lanes[0]));
  const A3 = armar({ sin: persona({ type: 'lle', dl: '17:00' }) });
  t('y sin vuelo (sin tierra): 17:20 con el respaldo — el caso que en tierra ya no aplica', A3.lanes[0]?.start === '17:20', JSON.stringify(A3.lanes[0]));
  const A4 = armar({ av: persona({ type: 'lle', dl: '17:00', vuelo: 'AV9412', res: 'x1' }), ti: persona({ type: 'lle', dl: '17:00', tierra: true, res: 'x2' }) });
  const conTi = A4.lanes.find(l => A4.order[l.id].includes('ti')), conAv = A4.lanes.find(l => A4.order[l.id].includes('av'));
  t('sin ventana de fusión, tierra y vuelo a la misma hora NO se pegan por coincidencia', !!conTi && !!conAv && conTi !== conAv && conTi.start === '17:00' && conAv.start === '17:15', JSON.stringify(A4.lanes));
  const Ssal = armar({ s: persona({ type: 'sal', dl: '05:10', lat: 6.16, lng: -75.36 }) });
  const Stie = armar({ s: persona({ type: 'sal', dl: '05:10', lat: 6.16, lng: -75.36, tierra: true }) });
  const cs = Ssal.S.rtCarCompute(Ssal.lanes[0].id), ct = Stie.S.rtCarCompute(Stie.lanes[0].id);
  t('salida en tierra: misma vuelta que la de siempre (salida, llegada y holgura)', Ssal.lanes[0].start === Stie.lanes[0].start && cs.arrival === ct.arrival && cs.holg === ct.holg, `${Ssal.lanes[0].start}/${Stie.lanes[0].start}`);
}
{
  // CON LA FUSIÓN DE PRODUCCIÓN: route_merge_window_min = 20 (0074) y margen 15.
  // La revisión del 29-sep lo cazó: con la ventana abierta, la fusión comparaba
  // la hora cruda —salir del terminal (tierra) contra aterrizar (vuelo)— y el de
  // tierra quedaba esperando el desembarque ajeno 15-40 min con el tablero en
  // «A tiempo». Ahora se compara cuándo SALE cada uno.
  const AJW = { ...AJ, route_merge_window_min: 20, route_margin_tight_min: 15 };
  const armarW = (aux, carros = 2) => {
    const S = solver(AJW);
    S.rt.aux = aux;
    S.rt.cars = Array.from({ length: carros }, (_, i) => ({ id: 'V-0' + (i + 1), avail0: '01:30', capacity: 4 }));
    const r = S.rtSolveDay(); S.rt.lanes = r.lanes; S.rt.order = r.order;
    return { S, ...r, de: (id) => r.lanes.find(l => r.order[l.id].includes(id)) };
  };
  const arriba5 = (m) => Math.ceil(m / 5) * 5;
  const B1 = armarW({ ti: persona({ type: 'lle', dl: '17:00', tierra: true, res: 'x' }), js: persona({ type: 'lle', dl: '17:00', vuelo: 'JA5816', res: 'x' }) });
  t('W=20, misma portería: tierra 17:00 NO espera al JetSmart internacional de las 17:00 (sale 17:30)', B1.de('ti') !== B1.de('js') && B1.de('ti')?.start === '17:00' && B1.de('js')?.start === '17:30', JSON.stringify(B1.lanes));
  const B2 = armarW({ ti: persona({ type: 'lle', dl: '16:50', tierra: true, res: 'x' }), js: persona({ type: 'lle', dl: '17:05', vuelo: 'JA5116', res: 'x' }) });
  t('W=20, misma portería: tierra 16:50 no se pega al JA5116 de las 17:05 → recoge 16:50', B2.de('ti') !== B2.de('js') && B2.de('ti')?.start === '16:50', JSON.stringify(B2.lanes));
  const B3 = armarW({ ti: persona({ type: 'lle', dl: '17:00', tierra: true, res: 'x' }), av: persona({ type: 'lle', dl: '17:00', vuelo: 'AV9412', res: 'y' }) });
  t('W=20, otra portería: tierra 17:00 + AV9412 17:00 van aparte (17:00 y 17:15)', B3.de('ti') !== B3.de('av') && B3.de('ti')?.start === '17:00' && B3.de('av')?.start === '17:15', JSON.stringify(B3.lanes));
  const B4 = armarW({ av: persona({ type: 'lle', dl: '16:45', vuelo: 'AV9412', res: 'y' }), ti: persona({ type: 'lle', dl: '17:00', tierra: true, res: 'x' }) });
  const l4 = B4.de('ti'), c4 = l4 ? B4.S.rtCarCompute(l4.id) : {};
  t('W=20: el de vuelo que YA salió a la hora del de tierra (AV 16:45 + 15) sí va con él, a las 17:00', !!l4 && l4 === B4.de('av') && l4.start === '17:00' && c4.wait === 0 && c4.status === 'ontime', JSON.stringify(B4.lanes));
  t('…y la vuelta dice «aterriza» a la hora del VUELO (16:45), no a la del de tierra', l4?.landing === '16:45' && c4.tierra === false && c4.hardDL === B4.S.rtToMin('17:00'));
  const B5 = armarW({ a: persona({ type: 'lle', dl: '17:00', vuelo: 'AV9412', res: 'y' }), b: persona({ type: 'lle', dl: '17:10', vuelo: 'AV9413', res: 'x' }) });
  t('W=20, solo vuelos: la fusión de siempre sin tocar (AV 17:00 + AV 17:10 → una vuelta, 17:25)', B5.lanes.length === 1 && B5.lanes[0].start === '17:25' && B5.lanes[0].landing === '17:10', JSON.stringify(B5.lanes));
  const B6 = armarW({ a: persona({ type: 'lle', dl: '17:00', tierra: true, res: 'x' }), b: persona({ type: 'lle', dl: '17:05', tierra: true, res: 'x' }), c: persona({ type: 'lle', dl: '17:10', tierra: true, res: 'x' }) });
  t('W=20, solo tierra: se juntan si nadie espera más de 5 (17:00+17:05) y el de 17:10 va aparte', B6.de('a') === B6.de('b') && B6.de('c') !== B6.de('a') && B6.de('a')?.start === '17:05' && B6.de('c')?.start === '17:10', JSON.stringify(B6.lanes));
  // Oleada que la misma portería junta y el cupo parte: cada pedazo con su hora.
  const B7 = armarW({
    a: persona({ type: 'lle', dl: '16:45', vuelo: 'AV9412', res: 'x' }), b: persona({ type: 'lle', dl: '16:45', vuelo: 'AV9412', res: 'x' }),
    c: persona({ type: 'lle', dl: '16:45', vuelo: 'AV9412', res: 'x' }), d: persona({ type: 'lle', dl: '17:00', tierra: true, res: 'x' }),
    e: persona({ type: 'lle', dl: '17:00', tierra: true, res: 'x' }) });
  const l7 = B7.de('e'), c7 = l7 ? B7.S.rtCarCompute(l7.id) : {};
  t('partida por cupo: el pedazo que queda solo de tierra recoge a SU hora y dice «sale del terminal»', B7.lanes.length === 2 && !!l7 && l7.start === '17:00' && l7.landing === '17:00' && c7.tierra === true && B7.de('a')?.start === '17:00', JSON.stringify(B7.lanes));
  // El tablero dice la espera del de tierra aunque el carro no llegue tarde: el
  // jefe lo arrastró (16:30) a una vuelta de vuelo que recoge a las 17:15.
  const S8 = solver(AJW);
  S8.rt.aux = { av: persona({ type: 'lle', dl: '17:00', vuelo: 'AV9412' }), ti: persona({ type: 'lle', dl: '16:30', tierra: true }) };
  S8.rt.lanes = [{ id: 'V-01·V1', car: 'V-01', vuelta: 1, type: 'lle', start: '17:15', origin: 'airport', landing: '17:00' }];
  S8.rt.order = { 'V-01·V1': ['av', 'ti'] };
  const c8 = S8.rtCarCompute('V-01·V1');
  t('arrastrado por el jefe: el semáforo muestra la espera del de tierra (45 min, «Espera larga»)', c8.wait === 45 && c8.status === 'late', JSON.stringify([c8.wait, c8.status]));
  S8.rt.order = { 'V-01·V1': ['av'] };
  const c8b = S8.rtCarCompute('V-01·V1');
  t('…y sin él, la misma vuelta de vuelo sigue «A tiempo» (lo de siempre)', c8b.wait === 0 && c8.status !== c8b.status && c8b.status === 'ontime');
  // Días al azar con la ventana abierta: a ningún trabajador en tierra lo recoge
  // su vuelta más de 5 min después de su hora cuando el carro estaba libre, y
  // cuando lo recoge tarde el semáforo lo dice.
  let seed = 29, casos = 0, peor = 0, ocultos = 0;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const VUELOS = ['AV9412', 'JA5116', 'JA5816', 'P57433', 'AV033', ''];
  for (let d = 0; d < 150; d++) {
    const aux = {};
    const n = 3 + Math.floor(rnd() * 10);
    for (let i = 0; i < n; i++) {
      const h = 14 + Math.floor(rnd() * 5), m = Math.floor(rnd() * 12) * 5;
      aux['p' + i] = persona({ type: 'lle', dl: String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0'), res: ['r1', 'r2', 'r3', null][Math.floor(rnd() * 4)],
        lat: 6.12 + rnd() * 0.06, lng: -75.42 + rnd() * 0.08, tierra: rnd() < 0.4, vuelo: VUELOS[Math.floor(rnd() * VUELOS.length)] });
    }
    const R = armarW(aux, 3);
    R.lanes.forEach(l => {
      const c = R.S.rtCarCompute(l.id);
      R.order[l.id].filter(id => aux[id].tierra).forEach(id => {
        casos++;
        const espera = R.S.rtToMin(l.start) - R.S.rtToMin(aux[id].dl);
        if (c.wait < espera) ocultos++;                                   // el tablero la escondería
        if (R.S.rtToMin(l.start) === arriba5(c.hardDL)) peor = Math.max(peor, espera);   // carro libre a tiempo
      });
    });
  }
  t(`al azar (150 días, ${casos} en tierra): con carro libre, ninguno espera más de 5 min (peor ${peor})`, casos > 50 && peor <= 5);
  t('…y ninguna espera de un trabajador en tierra queda escondida en el semáforo', ocultos === 0, String(ocultos));
}

// ═════════════════════════════════════════════════════════════════════════════
// D) El admin: tablero y Reservas
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── D · el admin dice «Tierra» ──');
{
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const errores = [];
  w.addEventListener('error', (e) => errores.push(e.message));
  w.RENDIO_CONFIG = {}; w.toast = () => {};
  w.escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  w.$ = (s) => w.document.querySelector(s); w.$$ = (s) => w.document.querySelectorAll(s);
  w.state = { settings: { ...AJ } };
  // Tablero: admin-consola (helpers) + admin-rutas en UNA evaluación, para
  // poder tocar `rt` (es const del archivo) y pintar la tarjeta y la parada.
  w.eval(read('admin-consola.js') + '\n' + read('admin-rutas.js') + '\n;window.__T = { rt, rtCfg, rtAuxCard, rtStopHTML };');
  const T = w.__T; T.rtCfg();
  T.rt.aux = { ti: persona({ n: 'Ana Tierra', type: 'lle', dl: '17:00', tierra: true }), av: persona({ n: 'Beto Vuelo', type: 'lle', dl: '17:00', vuelo: 'AV9412' }) };
  const card = T.rtAuxCard('ti'), cardAv = T.rtAuxCard('av');
  t('tarjeta del tablero: chip «Tierra» (a-flight) y el title lo dice', /<span class="a-flight">Tierra<\/span>/.test(card) && /Trabajo en tierra \(sin vuelo\)/.test(card));
  t('…la de vuelo sigue con su número', /<span class="a-flight">AV9412<\/span>/.test(cardAv) && !/Tierra/.test(cardAv));
  const stop = T.rtStopHTML('V-01·V1', { id: 'ti', eta: T.rt && 1030 }, 0);
  t('parada del tablero: «· tierra» en su línea', /· tierra/.test(stop));
  // Reservas.
  w.eval(read('admin-reservas.js') + '\n;window.__R = { rvRow };');
  const row = w.__R.rvRow({ id: 'x', type: 'lle', name: 'Ana Tierra', address: 'Olivar', when: FUTURO + 'T17:00:00-05:00', time: '17:00', status: 'pending', groundOps: true, flight: 'AV9412' });
  t('Reservas: chip «Tierra» y sin «✈» aunque llegara un vuelo', /<span class="rv-tag"[^>]*>Tierra<\/span>/.test(row) && !/✈/.test(row));
  const rowAv = w.__R.rvRow({ id: 'y', type: 'lle', name: 'Beto Vuelo', address: 'Solare', when: FUTURO + 'T17:00:00-05:00', time: '17:00', status: 'pending', groundOps: false, flight: 'AV9412' });
  t('…la de vuelo sigue con «✈ AV9412» y sin chip', /✈ AV9412/.test(rowAv) && !/>Tierra</.test(rowAv));
  t('sin errores de script en el admin', errores.length === 0, errores.join(' | '));
}

console.log(`\n${ok}/${ok + bad} pasaron${bad ? ' · ' + bad + ' FALLARON' : ''}`);
console.log('NO cubierto: layout y animación real (jsdom), la base real (0092, RLS, el error real de PostgREST sin la columna), OSRM/TomTom (el solver corre en línea recta), la tarjeta del viaje del tripulante (frente «tarjeta»).');
process.exit(bad ? 1 : 0);
