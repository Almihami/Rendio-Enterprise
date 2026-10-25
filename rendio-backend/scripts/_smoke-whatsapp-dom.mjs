// ADMIN › Asignación › «Copiar plan para WhatsApp» (admin-whatsapp.js) — prueba jsdom.
//
// Carga index.html + los ayudantes de tiempo de admin-consola.js + admin-rutas.js
// ENTERO + admin-whatsapp.js en un solo eval (las declaraciones de nivel superior
// de un eval no salen de él, así que van juntos, como en el navegador comparten
// el ámbito global). Arma a mano un estado `rt` de tablero con una matriz de
// tiempos fija —para que cada hora se pueda sacar con lápiz— y comprueba:
//
//   · el texto, LÍNEA POR LÍNEA, contra lo que dice FORMATO.md: encabezado,
//     horas sin cero a la izquierda (0:43, 2:55), recogida al múltiplo de 5
//     HACIA ABAJO, como el tablero (3:22 → 3:20, 4:08 → 4:05, 10:23 → 10:20;
//     el sin carro 12:36 → 12:35), «Deben/Debe estar» =
//     presentación − colchón hacia abajo, una vuelta por bloque en orden de
//     reloj aunque sean de carros distintos, la misma portería en una línea
//     («Sofía Ñañez y José Pérez»), llegadas por vuelo con dos del mismo vuelo
//     escrito de dos formas (AV9563 y 9563), siglas (av43 → AV43, 5133 → JA5133),
//     el de reserva sin vuelo «(Aero R)», el de tierra «(Aero)», los sin rutear
//     DENTRO del itinerario con «(QUIZÁS NO HAYA CARRO)» y su hora de recogida
//     estimada, tildes y eñes, vuelta vacía que no se imprime;
//   · lo mismo con «[carro]» (--carros) y con festivo (corrimiento 0 y 15);
//   · que RendioWhatsApp.plan() pasado a plan-a-whatsapp.mjs (el generador del
//     backend) da EXACTAMENTE el mismo texto, con y sin --carros, y con un plan
//     armado a mano para las siglas raras (J6, 043, 7xxx, No aplica);
//   · día vacío, día sin vehículos y plan sin armar: texto '' y el modal lo dice;
//   · el modal: el botón de la barra, textarea de solo lectura, lista corta de
//     sin rutear («y N más»), aviso de «Hotel», Copiar (clipboard y respaldo
//     execCommand, y el fallo), «Abrir WhatsApp» con el texto codificado,
//     casilla de carros, Escape/fondo cierran y devuelven el foco, reabrir lee
//     el tablero de nuevo, nombres con HTML escapados;
//   · index.html y el APP_SHELL de sw.js cargan el .js y el .css.
//
// LO QUE NO CUBRE: layout y estilo (jsdom no carga admin-whatsapp.css ni hace
// layout: cómo se ve la hoja en el celular, el tamaño del ícono, el teclado de
// iOS al copiar con el respaldo), el portapapeles real del navegador (permisos,
// contexto seguro), que WhatsApp acepte un enlace wa.me tan largo en Android/iOS
// y lo abra en la app, el solver (aquí la matriz es fija y las vueltas se arman a
// mano; lo que se prueba es la LECTURA de lo que el tablero ya calculó) ni la v2
// de la pantalla.
//
//   cd rendio-backend && node scripts/_smoke-whatsapp-dom.mjs
import { JSDOM } from 'jsdom';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const GENERADOR = new URL('./plan-a-whatsapp.mjs', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null && d !== '' ? ' → ' + d : '')); } };
const wait = (ms = 10) => new Promise(r => setTimeout(r, ms));

// Compara línea por línea y dice la primera que difiere.
function lineas(nombre, real, esperado) {
  const a = String(real).split('\n'), b = String(esperado).split('\n');
  const i = a.findIndex((l, k) => l !== b[k]);
  const dif = i >= 0 ? i : (a.length !== b.length ? Math.min(a.length, b.length) : -1);
  t(nombre, dif < 0, dif < 0 ? '' : `línea ${dif + 1}: ${JSON.stringify(a[dif])} ≠ esperado ${JSON.stringify(b[dif])}`);
}

// El generador del backend sobre un plan en JSON.
const TMP = mkdtempSync(join(tmpdir(), 'rwa-'));
function backend(plan, ...flags) {
  const f = join(TMP, 'plan.json');
  writeFileSync(f, JSON.stringify(plan));
  const r = spawnSync(process.execPath, [GENERADOR, f, ...flags], { encoding: 'utf8' });
  if (r.status !== 0) return 'ERROR: ' + r.stderr;
  return r.stdout.replace(/\s+$/, '');
}

// ── el tablero ──────────────────────────────────────────────────────────────
async function boot() {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://localhost/' });
  const w = dom.window;
  const errors = [];
  w.console.error = (...a) => { errors.push(a.map(x => (x && x.message) || String(x)).join(' ')); };
  w.addEventListener('error', (e) => errors.push(e.message));
  const CONSOLA = read('admin-consola.js');
  const helpers = CONSOLA.slice(0, CONSOLA.indexOf('  // ---------------- CONSOLA'));
  const STUBS = `
    var state = { settings: {} };
    const Api = window.__ApiStub = {};
    const $ = (s) => document.querySelector(s);
    const $$ = (s) => document.querySelectorAll(s);
    function toast() {}
  `;
  try {
    w.eval(STUBS + '\n' + helpers + '\n' + read('admin-rutas.js') + '\n' + read('admin-whatsapp.js')
      + '\n;window.__rt = rt; window.__rtCfg = rtCfg;');
  } catch (e) { errors.push('eval: ' + e.message); }
  // La pantalla de Asignación visible, como cuando el admin está en ella.
  w.document.querySelector('section[data-panel="routes"]')?.classList.remove('hidden');
  const q = (s) => w.document.querySelector(s);
  const qa = (s) => [...w.document.querySelectorAll(s)];
  const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  const key = (el, k) => el.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  return { w, errors, q, qa, click, key, RW: w.RendioWhatsApp, rt: w.__rt, rtCfg: w.__rtCfg };
}

// Una reserva del tablero, con los campos que llena Api.listRoutePlanning.
const A = (n, zona, resId, dl, type, o = {}) => ({
  n, zona, resId, dl, type, pax: 1, lat: null, lng: null, dir: zona,
  vuelo: o.vuelo || '', hotel: !!o.hotel, tierra: !!o.tierra, notas: '', tel: '', reservationId: 'res-' + n,
});

// El día de prueba. Matriz FIJA (rt.mHasTraffic = true → rtLegMin devuelve el
// valor tal cual), así cada hora sale con lápiz:
//   F (R02, llegada)  aterriza 00:43
//   A (R01, salida)   02:55 María · +4 servicio +23 → 03:22 Cámbulo (Sofía y José) · pres. 03:50
//   B (R02, salida)   03:55 Pau · +4 +9 → 04:08 Ana Lucía · pres. 04:40
//   D (R01, llegada)  AV9563 09:10 (Jessica «AV9563» + Erika «9563») · JA5133 09:14
//   C (R01, salida)   sale de MDE 10:05 · +18 → 10:23 Laura · pres. 10:55
//   E (R02, llegada)  16:00 Karol (reserva, hotel) · 16:00 Kris (tierra)
//   R02·V4 vacía · sin rutear: Juanita (salida 13:10; 4 + 20 al aeropuerto → recogida 12:36, se escribe 12:35) y Jolene (llegada 15:40)
function cargarDia(rt, rtCfg) {
  rtCfg();
  rt.source = 'live'; rt.day = '2026-10-09'; rt.emptyReason = 'reservas';
  rt.cars = [{ id: 'R01', capacity: 4, avail0: '01:30' }, { id: 'R02', capacity: 4, avail0: '01:30' }];
  rt.aux = {
    f1: A('Andrés Muñoz', 'Edificio Los Cerezos', 'res-cer', '00:43', 'lle', { vuelo: 'av43' }),
    a1: A('María Camila Vélez', 'Marinilla centro', 'res-mar', '03:50', 'sal'),
    a2: A('Sofía  Ñañez', 'Edificio Cámbulo', 'res-cam', '04:00', 'sal'),
    a3: A('José Pérez', 'Edificio Cámbulo', 'res-cam', '04:00', 'sal'),
    b1: A('Pau Londoño', 'Edificio Los Cerezos', 'res-cer', '04:40', 'sal', { hotel: true }),
    b2: A('Ana Lucía Ramírez', 'Condominio Planté', 'res-pla', '04:45', 'sal'),
    d1: A('Jessica Gómez', 'Olivar Apartamentos', 'res-oli', '09:10', 'lle', { vuelo: 'AV9563' }),
    d2: A('Erika Ríos', 'Olivar Apartamentos', 'res-oli', '09:10', 'lle', { vuelo: '9563' }),
    d3: A('Danna León', 'Río Vivo', 'res-rio', '09:14', 'lle', { vuelo: '5133' }),
    c1: A('Laura Fernández', 'Guayacán', 'res-gua', '10:55', 'sal'),
    e1: A('Karol Londoño', 'Edificio Los Cerezos', 'res-cer', '16:00', 'lle', { vuelo: 'Reserva', hotel: true }),
    e2: A('Kris Toro', 'Viverdi Apartamentos', 'res-viv', '16:00', 'lle', { tierra: true }),
    x1: A('Juanita Ortiz', 'Olivar Apartamentos', 'res-oli', '13:10', 'sal'),
    x2: A('Jolene Capron', 'Olivar Apartamentos', 'res-oli', '15:40', 'lle', { vuelo: 'P57661' }),
  };
  // Desordenadas a propósito: el mensaje va en orden de reloj, no de carro.
  rt.lanes = [
    { id: 'R01·V2', car: 'R01', vuelta: 2, type: 'lle', start: '09:35', origin: 'airport', landing: '09:14' },
    { id: 'R02·V3', car: 'R02', vuelta: 3, type: 'lle', start: '16:05', origin: 'airport', landing: '16:00' },
    { id: 'R01·V1', car: 'R01', vuelta: 1, type: 'sal', start: '02:55', origin: null },
    { id: 'R02·V4', car: 'R02', vuelta: 4, type: 'sal', start: '18:00', origin: null },
    { id: 'R01·V3', car: 'R01', vuelta: 3, type: 'sal', start: '10:05', origin: 'airport' },
    { id: 'R02·V1', car: 'R02', vuelta: 1, type: 'lle', start: '01:05', origin: 'airport', landing: '00:43' },
    { id: 'R02·V2', car: 'R02', vuelta: 2, type: 'sal', start: '03:55', origin: null },
  ];
  rt.order = {
    'R02·V1': ['f1'], 'R01·V1': ['a1', 'a2', 'a3'], 'R02·V2': ['b1', 'b2'], 'R01·V2': ['d1', 'd2', 'd3'],
    'R01·V3': ['c1'], 'R02·V3': ['e1', 'e2'], 'R02·V4': [],
  };
  rt.pool = ['x1', 'x2'];
  rt.optimized = true;
  rt.mHasTraffic = true;
  rt.M = {
    airport: { f1: 22, d1: 20, c1: 18, e1: 25 },
    a1: { a2: 23 }, a2: { airport: 20 }, b1: { b2: 9 }, b2: { airport: 15 },
    c1: { airport: 18 }, d1: { d3: 10 }, e1: { e2: 7 }, x1: { airport: 20 }, f1: {}, d3: {}, e2: {},
  };
  rt.diaLentoNombre = null; rt.esDiaLento = false; rt.HOLIDAY_SHIFT = 0;
}

// La madrugada (antes de las 2:00) va rotulada como cierre del turno PM del
// día anterior, y luego el día (20-oct-2026): la 0:43 ya no parece la primera
// vuelta del viernes.
const ESPERADO = [
  'Programación 2026-10-09 · 14 traslados (7 salidas + 7 llegadas) · 2 carros',
  '',
  '— Madrugada: cierre del turno PM del jueves —',
  '',
  '0:43 Andrés Muñoz (AV43)',
  '',
  '— Viernes desde las 2:00 —',
  '',
  '2:55 María Camila Vélez (Marinilla centro)',
  '3:20 Sofía Ñañez y José Pérez (Edificio Cámbulo)',
  'Deben estar 3:40',
  '',
  '3:55 Pau Londoño (Edificio Los Cerezos)',
  '4:05 Ana Lucía Ramírez (Condominio Planté)',
  'Deben estar 4:30',
  '',
  '9:10 Jessica Gómez y Erika Ríos (AV9563)',
  '9:14 Danna León (JA5133)',
  '',
  '10:20 Laura Fernández (Guayacán)',
  'Debe estar 10:45',
  '',
  '12:35 Juanita Ortiz (Olivar Apartamentos) (QUIZÁS NO HAYA CARRO)',
  '',
  '15:40 Jolene Capron (Olivar Apartamentos) (QUIZÁS NO HAYA CARRO)',
  '',
  '16:00 Karol Londoño (Aero R)',
  '16:00 Kris Toro (Aero)',
  '',
  '(2 marcados "quizás no haya carro" — con 2 carros no alcanzan)',
].join('\n');

const ESPERADO_CARROS = ESPERADO
  .replace('\n0:43 ', '\n[R02] 0:43 ')
  .replace('\n2:55 ', '\n[R01] 2:55 ')
  .replace('\n3:55 ', '\n[R02] 3:55 ')
  .replace('\n9:10 ', '\n[R01] 9:10 ')
  .replace('\n10:20 ', '\n[R01] 10:20 ')
  .replace('\n16:00 Karol', '\n[R02] 16:00 Karol');

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── El texto del día, contra FORMATO.md ──');
const B = await boot();
{
  const { RW, rt, rtCfg } = B;
  t('window.RendioWhatsApp expone texto/abrir/cerrar/plan/formatear',
    RW && ['texto', 'abrir', 'cerrar', 'plan', 'formatear'].every(k => typeof RW[k] === 'function'));
  cargarDia(rt, rtCfg);
  const txt = RW.texto();
  lineas('el día entero, línea por línea', txt, ESPERADO);
  t('ninguna hora con cero a la izquierda', !/(^|\s)0\d:\d\d/m.test(txt), txt.match(/(^|\s)0\d:\d\d/m)?.[0]);
  t('la vuelta vacía (R02·V4) no deja bloque', !txt.includes('18:00'));
  t('no escribe «Va a hotel» (en el tablero «hotel» es la pernocta)', !/hotel/i.test(txt.replace('Aero R', '')));
  lineas('con [carro] en la primera línea de cada vuelta', RW.texto({ carros: true }), ESPERADO_CARROS);

  const plan = RW.plan();
  t('plan(): 6 vueltas con paradas, ordenadas por salida', plan && plan.vueltas.length === 6
    && plan.vueltas.map(v => v.sale).join(',') === '01:05,02:55,03:55,09:35,10:05,16:05', plan && plan.vueltas.map(v => v.sale).join(','));
  t('plan(): la portería de Cámbulo es UNA parada con dos personas',
    plan.vueltas[1].paradas.length === 2 && plan.vueltas[1].paradas[1].personas.map(p => p.n).join('|') === 'Sofía  Ñañez|José Pérez');
  t('plan(): la presentación de la vuelta es la más apretada (03:50) y la hora de cada parada la de rtCarCompute',
    plan.vueltas[1].presentacion === '03:50' && plan.vueltas[1].paradas.map(p => p.eta).join(',') === '02:55,03:22');
  t('plan(): las llegadas no llevan presentación', plan.vueltas[0].presentacion === null && plan.vueltas[3].presentacion === null);
  t('plan(): sin rutear con su hora de recogida estimada (salida) y sin ella (llegada)',
    plan.sinRutear.length === 2 && plan.sinRutear[0].eta === '12:36' && plan.sinRutear[1].eta === null, JSON.stringify(plan.sinRutear));

  console.log('\n── El mismo plan por el generador del backend (plan-a-whatsapp.mjs) ──');
  lineas('backend == admin-whatsapp.js', backend(plan), txt);
  lineas('backend --carros == texto({ carros: true })', backend(plan, '--carros'), RW.texto({ carros: true }));

  console.log('\n── Festivo ──');
  rt.diaLentoNombre = 'Día de la Raza'; rt.esDiaLento = true; rt.HOLIDAY_SHIFT = 0;
  const f0 = RW.texto().split('\n');
  t('corrimiento 0 → «programado como día normal»', f0[1] === 'Día de la Raza — programado como día normal (falta definir cuánto más tarde sacarlos)' && f0[2] === '', f0[1]);
  lineas('festivo: backend == admin-whatsapp.js', backend(RW.plan()), RW.texto());
  rt.HOLIDAY_SHIFT = 15;
  t('corrimiento 15 → «se recoge 15 min más tarde»', RW.texto().split('\n')[1] === 'Día de la Raza — se recoge 15 min más tarde de lo normal');
  rt.diaLentoNombre = null; rt.esDiaLento = false; rt.HOLIDAY_SHIFT = 0;

  console.log('\n── formatear(plan) con siglas raras y bordes ──');
  const raro = {
    dia: '2026-10-10', traslados: 6, salidas: 1, llegadas: 5, carros: [{ id: 'R01' }],
    ajustes: { colchonAeropuerto: 10 },
    vueltas: [
      { carro: 'R01', tipo: 'lle', sale: '13:20', presentacion: null, paradas: [{ zona: 'Olivar', eta: '13:40', personas: [
        { n: 'Juan Martínez', dl: '13:01', vuelo: 'J65116' }, { n: 'Daniela', dl: '13:01', vuelo: '043' },
        { n: 'Gloria', dl: '13:01', vuelo: '31' }, { n: 'Melina', dl: '13:05', vuelo: '7433' }] }] },
      { carro: 'R01', tipo: 'lle', sale: '15:00', presentacion: null, paradas: [{ zona: 'Cerezos', eta: '15:20', personas: [
        { n: 'María Camila', dl: '14:50', vuelo: 'No aplica', hotel: true }] }] },
      { carro: 'R01', tipo: 'sal', sale: '17:10', presentacion: '18:00', paradas: [{ zona: 'Terra', eta: '17:12', personas: [{ n: 'Pau londo', dl: '18:00' }] }] },
    ],
    sinRutear: [],
  };
  const tr = RW.formatear(raro);
  t('J65116 → JA5116 · 043 → AV43 · 31 → AV31 · 7433 → P57433, cada vuelo en su línea',
    tr.includes('13:01 Juan Martínez (JA5116)') && tr.includes('13:01 Daniela (AV43)') && tr.includes('13:01 Gloria (AV31)') && tr.includes('13:05 Melina (P57433)'), tr);
  t('«No aplica» con hotel → (Aero R)', tr.includes('14:50 María Camila (Aero R)'));
  t('un solo pasajero → «Debe estar», sin línea de «quizás no haya carro»', tr.includes('17:10 Pau londo (Terra)\nDebe estar 17:50') && !tr.includes('quizás'));
  lineas('siglas raras: backend == admin-whatsapp.js', backend(raro), tr);
  // De RESERVA (0121): el dato real del lugar manda sobre todo lo demás.
  {
    // El Api del tablero en esta prueba es el stub `const Api = {}` (ver STUBS).
    const LUG = { rio_verde: { name: 'Hotel Río Verde', hotel: true }, movich: { name: 'Hotel Movich', hotel: true }, aero: { name: 'Aeropuerto JMC', hotel: false } };
    B.w.__ApiStub.reservePlace = (k) => LUG[k] || null;
    const res = RW.formatear({
      dia: '2026-10-25', traslados: 5, salidas: 3, llegadas: 2, carros: [{ id: 'R01' }], ajustes: { colchonAeropuerto: 10 },
      vueltas: [
        { carro: 'R01', tipo: 'lle', sale: '18:30', presentacion: null, paradas: [{ zona: 'Olivar', eta: '18:50', personas: [
          { n: 'Karol L', dl: '18:30', vuelo: '', reserva: 'movich', hotel: true }, { n: 'Lesmes', dl: '18:30', vuelo: '', reserva: 'aero' }] }] },
        { carro: 'R01', tipo: 'sal', sale: '10:40', presentacion: '11:30', paradas: [{ zona: 'Terra', eta: '10:42', personas: [{ n: 'Dayana', dl: '11:30', reserva: 'movich', hotel: true }] }] },
        { carro: 'R01', tipo: 'sal', sale: '15:00', presentacion: '16:00', paradas: [{ zona: 'Cerezos', eta: '15:05', personas: [{ n: 'Ana', dl: '16:00', vuelo: 'AV9412' }, { n: 'Laura V', dl: '16:00', reserva: 'rio_verde', hotel: true }] }] },
      ],
      sinRutear: [],
    });
    t('reserva: la llegada desde el hotel dice «(Hotel Movich)»', res.includes('18:30 Karol L (Hotel Movich)'), res);
    t('reserva en el aeropuerto: «(Aero R)»', res.includes('18:30 Lesmes (Aero R)'), res);
    t('salida de todos al hotel: «Debe estar 11:20 (Hotel Movich)»', res.includes('Debe estar 11:20 (Hotel Movich)'), res);
    t('salida mezclada: «Deben estar 15:50 y Hotel Río Verde»', res.includes('Deben estar 15:50 y Hotel Río Verde'), res);
    delete B.w.__ApiStub.reservePlace;
  }
  // Borde que el backend imprime mal ("-1:55"): aquí envuelve en 24 h.
  const borde = RW.formatear({ dia: '2026-10-10', traslados: 1, salidas: 1, llegadas: 0, carros: [{ id: 'R01' }], ajustes: { colchonAeropuerto: 10 },
    vueltas: [{ carro: 'R01', tipo: 'sal', sale: '23:30', presentacion: '00:05', paradas: [{ zona: 'Mota', eta: '23:33', personas: [{ n: 'Isa', dl: '00:05' }] }] }], sinRutear: [] });
  t('presentación 00:05 → «Debe estar 23:55» (no "-1:55")', borde.includes('Debe estar 23:55'), borde);
  t('formatear(null) → \'\'', RW.formatear(null) === '');
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── El botón y el modal ──');
{
  const { w, q, qa, click, key, RW } = B;
  const btn = q('#rt-waBtn');
  t('el botón está en la barra de Asignación, antes de «Optimizar»',
    btn && btn.closest('#routes-ui .sub') && btn.nextElementSibling && btn.nextElementSibling.id === 'rt-optBtn');
  t('tooltip «Copiar plan para WhatsApp» y ícono SVG en línea', btn?.getAttribute('title') === 'Copiar plan para WhatsApp'
    && btn.getAttribute('aria-label') === 'Copiar plan para WhatsApp' && btn.querySelector('svg path'));
  btn.focus();
  click(btn);
  const ovl = q('#rwa-ovl');
  t('al tocarlo abre el modal', ovl && ovl.classList.contains('show') && ovl.parentElement === w.document.body);
  t('es un diálogo modal con título', q('#rwa-ovl [role="dialog"]')?.getAttribute('aria-modal') === 'true' && q('#rwa-titulo')?.textContent === 'Plan para WhatsApp');
  const ta = q('#rwa-ta');
  t('textarea de solo lectura con el texto exacto', ta && ta.readOnly && ta.value === RW.texto());
  t('subtítulo con la fecha y las vueltas', /viernes.*9 de octubre/i.test(q('#rwa-sub').textContent) && /6 vueltas/.test(q('#rwa-sub').textContent), q('#rwa-sub').textContent);
  const sr = q('#rwa-sinRutear');
  t('aviso de sin rutear: cuántos y quiénes, en orden de hora', sr && /2 sin carro/.test(sr.textContent)
    && qa('#rwa-sinRutear li').map(li => li.textContent).join(' | ') === '12:35Juanita Ortiz (Olivar Apartamentos) · salida | 15:40Jolene Capron (Olivar Apartamentos) · llegada',
    qa('#rwa-sinRutear li').map(li => li.textContent).join(' | '));
  const ho = q('#rwa-hotel');
  t('aviso de «Hotel» con Pau y Karol (0121: ya es la reserva en hotel, no la pernocta)', ho && ho.textContent.includes('Pau Londoño, Karol Londoño') && /De reserva en hotel/.test(ho.textContent));
  const wa = q('#rwa-wa');
  const pref = 'https://wa.me/?text=';
  t('«Abrir WhatsApp» = wa.me con el texto codificado, en otra pestaña', wa.getAttribute('href').startsWith(pref)
    && decodeURIComponent(wa.getAttribute('href').slice(pref.length)) === RW.texto() && wa.target === '_blank' && /noopener/.test(wa.rel));
  t('el foco va a «Copiar»', w.document.activeElement === q('#rwa-copiar'));

  // Copiar con navigator.clipboard
  let copiado = null;
  Object.defineProperty(w.navigator, 'clipboard', { configurable: true, value: { writeText: async (s) => { copiado = s; } } });
  click(q('#rwa-copiar')); await wait();
  t('Copiar → navigator.clipboard con el texto y aviso «Copiado»', copiado === RW.texto() && q('#rwa-ok').textContent === 'Copiado' && !q('#rwa-ok').classList.contains('err'));
  // Respaldo: sin clipboard → selección + execCommand
  Object.defineProperty(w.navigator, 'clipboard', { configurable: true, value: undefined });
  let cmd = null, selLen = 0;
  w.document.execCommand = (c) => { cmd = c; selLen = q('#rwa-ta').selectionEnd - q('#rwa-ta').selectionStart; return true; };
  q('#rwa-ok').textContent = '';
  click(q('#rwa-copiar')); await wait();
  t('sin clipboard: selecciona todo y execCommand("copy") → «Copiado»', cmd === 'copy' && selLen === RW.texto().length && q('#rwa-ok').textContent === 'Copiado', `${cmd} ${selLen}`);
  t('el textarea vuelve a quedar de solo lectura', q('#rwa-ta').readOnly === true);
  // Clipboard que rechaza (sin permiso) y execCommand que no copia
  Object.defineProperty(w.navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('NotAllowedError'); } } });
  w.document.execCommand = () => false;
  click(q('#rwa-copiar')); await wait();
  t('si no se puede copiar lo dice (y deja el texto seleccionado)', /No se pudo copiar/.test(q('#rwa-ok').textContent) && q('#rwa-ok').classList.contains('err'));

  // Casilla «Marcar el carro»
  const chk = q('#rwa-carros');
  chk.checked = true; chk.dispatchEvent(new w.Event('change', { bubbles: true }));
  t('la casilla de carros cambia el texto y el enlace', q('#rwa-ta').value === RW.texto({ carros: true })
    && decodeURIComponent(q('#rwa-wa').getAttribute('href').slice(pref.length)).includes('[R01] 2:55'));
  chk.checked = false; chk.dispatchEvent(new w.Event('change', { bubbles: true }));

  key(q('#rwa-ta'), 'Escape');
  t('Escape cierra y devuelve el foco al botón', !ovl.classList.contains('show') && w.document.activeElement === btn);

  // Reabrir lee el tablero OTRA VEZ: Jolene entra a la vuelta de las 16:00.
  B.rt.pool = ['x1']; B.rt.order['R02·V3'] = ['x2', 'e1', 'e2'];
  B.rt.M.airport.x2 = 20; B.rt.M.x2 = { e1: 5 };
  click(btn);
  t('al reabrir, el texto y la lista se rehacen con el tablero nuevo', /1 sin carro/.test(q('#rwa-sinRutear').textContent)
    && q('#rwa-ta').value.includes('15:40 Jolene Capron (P57661)\n16:00 Karol Londoño (Aero R)')
    && q('#rwa-ta').value.includes('(1 marcados "quizás no haya carro"'), q('#rwa-ta').value);
  click(ovl);
  t('tocar el fondo cierra', !ovl.classList.contains('show'));
  click(btn);
  click(q('#rwa-ovl [data-rwa-cerrar]'));
  t('la X cierra', !ovl.classList.contains('show'));
  RW.abrir(); RW.cerrar();
  t('RendioWhatsApp.abrir()/cerrar() sin el botón (lo que usará la v2)', !ovl.classList.contains('show') && qa('#rwa-ovl').length === 1);
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Lista corta y nombres con HTML ──');
{
  const { q, qa, RW, rt } = B;
  const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'];
  ids.forEach((id, i) => { rt.aux[id] = A(i === 0 ? '<img src=x onerror="window.__xss=1">' : 'Persona ' + (i + 1), 'Mota', 'res-mot', `1${i}:00`, 'sal'); rt.M[id] = { airport: 15 }; });
  rt.pool = ['x1', ...ids];
  RW.abrir();
  const li = qa('#rwa-sinRutear li');
  t('9 sin carro → 6 en la lista + «y 3 más»', /9 sin carro/.test(q('#rwa-sinRutear').textContent) && li.length === 7 && li[6].textContent === 'y 3 más', li.length);
  t('un nombre con HTML se muestra como texto, no se ejecuta', !q('#rwa-ovl img') && B.w.__xss === undefined && q('#rwa-sinRutear').textContent.includes('<img'));
  t('… y en el texto va tal cual lo escribió', q('#rwa-ta').value.includes('<img src=x onerror="window.__xss=1"> (Mota) (QUIZÁS NO HAYA CARRO)'));
  RW.cerrar();
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Día vacío, sin carros, plan sin armar ──');
{
  const { q, click, RW, rt, rtCfg } = B;
  const vacio = () => ({ txt: q('#rwa-vacio')?.textContent || '', ta: q('#rwa-ta'), copiar: q('#rwa-copiar').disabled,
    wa: q('#rwa-wa').getAttribute('aria-disabled') === 'true' && !q('#rwa-wa').hasAttribute('href'), chk: q('#rwa-chkWrap').hidden });

  rtCfg(); rt.source = 'empty'; rt.day = null; rt.emptyReason = 'reservas'; rt.aux = {}; rt.cars = []; rt.lanes = []; rt.order = {}; rt.pool = [];
  t('día vacío → texto() === \'\' y plan() === null', RW.texto() === '' && RW.plan() === null);
  click(q('#rt-waBtn'));
  let v = vacio();
  t('día vacío: el modal dice que no hay traslados, sin textarea, Copiar y WhatsApp apagados',
    /No hay plan para copiar/.test(v.txt) && /No hay traslados/.test(v.txt) && !v.ta && v.copiar && v.wa && v.chk, JSON.stringify(v));
  t('día vacío: el foco va a cerrar', B.w.document.activeElement === q('#rwa-ovl .rwa-x'));
  RW.cerrar();

  rt.emptyReason = 'vehiculos';
  RW.abrir(); v = vacio();
  t('sin vehículos: lo dice', /No hay vehículos/.test(v.txt), v.txt);
  RW.cerrar();

  // Hay reservas pero nadie va en un carro (no se ha pulsado Optimizar).
  rt.source = 'live'; rt.day = '2026-10-09'; rt.emptyReason = 'reservas';
  rt.cars = [{ id: 'R01', capacity: 4 }];
  rt.aux = { x1: A('Juanita Ortiz', 'Olivar Apartamentos', 'res-oli', '13:10', 'sal'), x2: A('Jolene Capron', 'Olivar Apartamentos', 'res-oli', '15:40', 'lle') };
  rt.lanes = [{ id: 'R01·V1', car: 'R01', vuelta: 1, start: '01:30', origin: null }]; rt.order = { 'R01·V1': [] }; rt.pool = ['x1', 'x2'];
  t('plan sin armar → texto() === \'\' (no los marca a todos «quizás no haya carro»)', RW.texto() === '');
  RW.abrir(); v = vacio();
  t('plan sin armar: el modal dice que falta Optimizar', /Hay 2 traslados pero todavía no van en ningún carro/.test(v.txt) && /Optimizar/.test(v.txt) && !v.ta, v.txt);
  RW.cerrar();

  // Armado a mano (sin Optimizar): la vuelta no trae `type` y es una salida.
  rt.order['R01·V1'] = ['x1']; rt.pool = ['x2']; rt.M = { x1: { airport: 20 }, x2: {} }; rt.mHasTraffic = true; rt.lanes[0].start = '12:40';
  const man = RW.texto();
  t('armado a mano: la vuelta sin `type` sale como salida, y el resto como sin carro',
    man.includes('12:40 Juanita Ortiz (Olivar Apartamentos)\nDebe estar 13:00') && man.includes('15:40 Jolene Capron (Olivar Apartamentos) (QUIZÁS NO HAYA CARRO)'), man);
  // Alguien que no está ni en una vuelta ni en el pool no desaparece.
  rt.pool = [];
  t('quien no está en ningún carro sale aunque el pool lo haya perdido', RW.texto().includes('Jolene Capron (Olivar Apartamentos) (QUIZÁS NO HAYA CARRO)'));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Carga en la app ──');
{
  const html = read('index.html'), sw = read('sw.js');
  t('index.html carga admin-whatsapp.js y admin-whatsapp.css', /<script src="admin-whatsapp\.js"><\/script>/.test(html) && /href="admin-whatsapp\.css"/.test(html));
  t('admin-whatsapp.js va después de admin-rutas.js', html.indexOf('src="admin-whatsapp.js"') > html.indexOf('src="admin-rutas.js"'));
  t('el APP_SHELL de sw.js trae los dos', sw.includes("'/admin-whatsapp.js'") && sw.includes("'/admin-whatsapp.css'"));
  t('sin errores en consola', B.errors.length === 0, B.errors.join(' | '));
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${ok} bien · ${bad} mal`);
process.exit(bad ? 1 : 0);
