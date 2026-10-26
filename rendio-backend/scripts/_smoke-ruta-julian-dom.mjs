// LA RUTA DE JULIÁN (0125, 25-oct-2026) — prueba jsdom de admin-ruta-julian.js
// sobre Rutas del día de verdad (index.html + admin-consola.js + admin-rutas.js +
// admin-rutas-v2.js + admin-ruta-julian.js en UNA evaluación, como
// _smoke-rutas-v2-dom) con el día de prueba de fixtures/rutas-v2-dia.js y un Api
// FALSO para lo de 0125.
//
// Comprueba:
//   A) el lector con los planes REALES del jefe (scripts/planes-jefe/*.txt): todas
//      las líneas entran, ningún «Deben estar» queda suelto, la madrugada va al día
//      siguiente, los dedazos del grupo, «Juanita y Pacho» = dos personas y el
//      «Deben estar» que queda antes de la última recogida (16-ago) no se usa;
//   B) emparejar: apodo aprendido, nombre + «Deben estar», vuelo, lo dudoso no se
//      elige solo;
//   C) la hoja: pegar (y el borrador guardado), leer, lo emparejado, lo que no se
//      encontró, quién pidió y no está, repetidos que bloquean, elegir a mano (se
//      aprende) y lo que le llega a Api.adminManualRoutePublish;
//   D) el día SOLO con la ruta de Julián: vueltas libres / tomadas / en curso, el
//      tablero bloqueado (Publicar, Re-optimizar, rtSavePlan), «Volver a pegar»
//      y «Quitar la ruta»;
//   D2) el día MEZCLADO (26-oct-2026: tablero + unas vueltas pegadas): se ve el
//      tablero entero y cada vuelta pegada DENTRO de la lista, en su hora, con
//      su etiqueta, los nombres completos y sus botones (arriba solo la barra);
//      Publicar y Re-optimizar encendidos sin meter en el tablero a la gente de
//      lo pegado; buscar, «Volver a pegar», el Excel y «Quitar la ruta»;
//   D3) la lista mezclada: lo terminado abajo, la madrugada siguiente al final,
//      la llegada del hotel, choques del conductor con una vuelta pegada y quién
//      queda «en turno, sin vueltas»;
//   D4) «Cambiar hora» (0145): la hoja, correr las demás, lo que no deja y lo
//      que le llega a Api.adminManualRouteSetTimes;
//   A2) «(Aero r)», «(Hotel)», «(Río Verde)»: de JMC o del hotel a la casa;
//   E) el Excel del día (ExcelJS de verdad, vendor/): columnas del Formulario y
//      la madrugada siguiente;
//   F) la madrugada que Julián pegó con el día anterior no se vuelve a rutear.
//
// LO QUE NO CUBRE: la base (eso es _verify-0125.mjs, contra la base local), el
// layout (jsdom no lo hace: ancho de la hoja, el select en un teléfono), la
// descarga real del archivo en el navegador, los avisos push reales y la app del
// conductor (driver-rutas.js tiene su propia sección en _smoke-rx-admin-coord-dom).
//
//   cd rendio-backend && node scripts/_smoke-ruta-julian-dom.mjs
process.env.TZ = 'America/Bogota';
import { JSDOM } from 'jsdom';
import { readFileSync, readdirSync } from 'node:fs';
import ExcelJS from 'exceljs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const FIX = new URL('./fixtures/', import.meta.url).pathname;
const PLANES = new URL('./planes-jefe/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null && d !== '' ? ' → ' + d : '')); } };
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
const hm = (m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;

const DAY = '2026-10-12';
const SIG = '2026-10-13';

async function boot({ antes, publicado = true } = {}) {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const errors = [], toasts = [], confirms = [];
  w.console.error = (...a) => { errors.push(a.map((x) => (x && x.message) || String(x)).join(' ')); };
  w.addEventListener('error', (e) => errors.push(e.message));
  w.RENDIO_CONFIG = {};
  w.state = { settings: { route_traffic_factor: 1 }, profile: { id: 'jefe', role: 'admin' } };
  w.toast = (m) => toasts.push(m);
  w.confirm = (m) => { confirms.push(m); return w.__confirma !== false; };
  w.escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  w.$ = (s) => w.document.querySelector(s); w.$$ = (s) => w.document.querySelectorAll(s);
  w.fetch = async () => { throw new Error('sin red'); };
  w.eval(readFileSync(FIX + 'fake-leaflet.js', 'utf8'));
  w.eval(readFileSync(FIX + 'rutas-v2-dia.js', 'utf8'));
  w.RV2Fixture.instalarFetch(w);
  w.Api = {};
  const log = w.RV2Fixture.instalar(w.Api, { publicado });
  // Cada tripulante con su perfil (auxId): lo que trae listRoutePlanning con 0125.
  const plan0 = w.Api.listRoutePlanning;
  w.Api.listRoutePlanning = async (tipo, day) => {
    const r = await plan0(tipo, day);
    if (r) Object.keys(r.aux).forEach((k) => { r.aux[k].auxId = 'aux-' + k; });
    return r;
  };
  log.julian = { publicar: [], quitar: [], apodos: 0 };
  w.Api.listCrewAliases = async () => { log.julian.apodos++; return [{ alias: 'la flaca', auxId: 'aux-rH' }]; };
  if (antes) antes(w, log);
  try {
    w.eval(read('admin-consola.js') + '\n' + read('admin-rutas.js') + '\n' + read('admin-rutas-v2.js') + '\n' + read('admin-ruta-julian.js') +
      '\n;window.__T = { rt, renderRoutes, rtLoad, rtSavePlan };');
  } catch (e) { errors.push('eval: ' + e.message); }
  w.document.querySelector('section[data-panel="routes"]').classList.remove('hidden');
  const q = (s) => w.document.querySelector(s);
  const qa = (s) => [...w.document.querySelectorAll(s)];
  const click = (el) => { if (!el) throw new Error('no existe el elemento'); el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })); };
  const type = (el, v) => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
  const pick = (el, v) => { el.value = v; el.dispatchEvent(new w.Event('change', { bubbles: true })); };
  await w.__T.renderRoutes();
  await wait(40);
  return { w, log, errors, toasts, confirms, q, qa, click, type, pick, J: () => w.RendioRutaJulian, V2: () => w.RendioRutasV2, T: () => w.__T, toastV2: () => txt(q('#rv2-toast')) };
}

// Una instancia sola para lo que no necesita pantalla.
const base = await boot();
const J = base.J();

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── A · El lector con los planes reales del jefe ──');
{
  const L = J._leer(readFileSync(PLANES + 'plan-2026-08-16-jefe.txt', 'utf8'), '2026-08-16');
  const lineas = L.bloques.flatMap((b) => b.lineas);
  t('16-ago: 33 vueltas y 58 líneas, ninguna sin entender', L.bloques.length === 33 && lineas.length === 58 && L.raras.length === 0, JSON.stringify([L.bloques.length, lineas.length, L.raras]));
  const b0 = L.bloques[0];
  t('«Deben estar 3:20 Van a hotel»: la hora va al bloque y «Van a hotel» queda de nota', b0.deadline && b0.deadline.min === 200 && b0.deadline.dia === '2026-08-16' && b0.notas.join() === 'Van a hotel', JSON.stringify(b0.deadline) + ' ' + b0.notas);
  const juanita = L.bloques[1].lineas.find((l) => /Juanita/.test(l.quien));
  t('«Juanita y Pacho (OlivaR)» son dos personas en la misma parada', juanita && juanita.personas.join('|') === 'Juanita|Pacho' && juanita.lugar === 'OlivaR', JSON.stringify(juanita));
  const margy = lineas.find((l) => l.quien === 'margy');
  t('«5:25 margy (Av145)» es una llegada: vuelo AV145', margy && margy.vuelo === 'AV145', JSON.stringify(margy));
  const luz = lineas.find((l) => l.lugar === 'P57433');
  t('«(P57433)» es el vuelo P57433 (Arajet), no «P» + 57433', luz && luz.vuelo === 'P57433', luz && luz.vuelo);
  const b10 = L.bloques[10];
  t('«Deben estar 10:20 van a hotel» con recogidas 10:40–10:55: se marca como dedazo, NO pasa al día siguiente', b10.deadline.mala === true && b10.deadline.dia === '2026-08-16', JSON.stringify(b10.deadline));
  t('…y es la única vuelta del 16-ago con ese problema', L.bloques.filter((b) => b.deadline && b.deadline.mala).length === 1);

  let total = 0, raras = 0, sueltos = [];
  for (const f of readdirSync(PLANES).filter((x) => /^plan-.*\.txt$/.test(x))) {
    const dia = (f.match(/\d{4}-\d{2}-\d{2}/) || ['2026-08-01'])[0];
    const X = J._leer(readFileSync(PLANES + f, 'utf8'), dia);
    total += X.bloques.reduce((a, b) => a + b.lineas.length, 0);
    raras += X.raras.length;
    // Un «Deben estar», «Estar», «Dstad 12:40»… que quedó como nota = no se leyó.
    X.bloques.forEach((b) => b.notas.forEach((n) => { if (/\d{1,2}\s*[:.;,/]\s*\d{2}/.test(n)) sueltos.push(f + ': ' + n); }));
  }
  t(`los ${readdirSync(PLANES).filter((x) => /^plan-.*\.txt$/.test(x)).length} planes guardados: ${total} líneas, ninguna sin entender`, raras === 0 && total > 1000, String(raras));
  t('ningún «Deben estar» (ni sus dedazos: «Deben 15:30», «Dstad 12:40», «Eestar 20:40», «Estás 4:50») queda suelto', sueltos.length === 0, sueltos.slice(0, 4).join(' · '));

  const M = J._leer('23:30 Ana (Olivar)\n23:40 Beto (Cerezos)\nDeben estar 0:10\n\n23:45 Caro (AV9268)\n\n0:20 Dani (Viverdi)\n0:25 Eli y Fer (Solare)\nDeben estar 0:50', DAY);
  t('madrugada: «Deben estar 0:10» de unas recogidas de las 23:30 es del día siguiente (no un dedazo)', M.bloques[0].deadline.dia === SIG && !M.bloques[0].deadline.mala, JSON.stringify(M.bloques[0].deadline));
  t('madrugada: «0:20 Dani» después de las 23:45 es del día siguiente, y su «Deben estar 0:50» también', M.bloques[2].lineas.every((l) => l.dia === SIG) && M.bloques[2].deadline.dia === SIG && !M.bloques[2].deadline.mala);
  t('las de las 23:30 siguen en su día', M.bloques[0].lineas.every((l) => l.dia === DAY));
  const P = J._leer('0:30 Gina (Mota)\nDeben estar 1:00\n\n4:10 Hugo (Olivar)', DAY);
  t('un plan que ARRANCA de madrugada (sin tarde antes) se queda en su día', P.bloques[0].lineas[0].dia === DAY);
  const D = J._leer('18;35 Ana (Olivar)\n10/55 Beto (Origen)\n13.45 Caro (Av9717\nEstar hotel y aero 11:20\n\n‎12:40 pacho y León (Av 9717)', DAY);
  const dl = D.bloques[0].lineas;
  t('dedazos: «18;35», «10/55», «13.45» y el paréntesis sin cerrar «(Av9717»', dl.map((l) => hm(l.min)).join() === '18:35,10:55,13:45' && dl[2].quien === 'Caro' && dl[2].vuelo === 'AV9717', JSON.stringify(dl.map((l) => [hm(l.min), l.quien, l.lugar])));
  t('«Estar hotel y aero 11:20»: hora 11:20 y la nota «hotel y aero»', D.bloques[0].deadline.min === 680 && D.bloques[0].notas.join() === 'hotel y aero', JSON.stringify([D.bloques[0].deadline, D.bloques[0].notas]));
  t('la marca invisible de WhatsApp (U+200E) y «Av 9717» con espacio', D.bloques[1].lineas[0].personas.join('|') === 'pacho|León' && D.bloques[1].lineas[0].vuelo === 'AV9717', JSON.stringify(D.bloques[1].lineas[0]));
  const R = J._leer('Buenas noches, ruta de mañana:\n3:10 (Mota)\n3:15 Karol L (Viverdi)', DAY);
  t('una hora sin nombre no se inventa: queda en «No entendí»; el saludo queda de nota', R.raras.length === 1 && R.bloques[0].lineas.length === 1 && R.bloques[0].notas[0].startsWith('Buenas'), JSON.stringify(R));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── B · Emparejar ──');
{
  const C = [
    { rid: 'r1', auxId: 'a1', n: 'Laura Gómez Ríos', type: 'sal', dia: DAY, dl: '05:00', zona: 'Olivar', sector: 'Llanogrande' },
    { rid: 'r2', auxId: 'a2', n: 'Laura Idárraga', type: 'sal', dia: DAY, dl: '05:00', zona: 'Río Vivo', sector: 'Llanogrande' },
    { rid: 'r3', auxId: 'a3', n: 'Karol Londoño', type: 'lle', dia: DAY, dl: '15:00', vuelo: 'AV9412', zona: 'Cerezos' },
    { rid: 'r4', auxId: 'a4', n: 'Karol Puentes', type: 'lle', dia: DAY, dl: '15:00', vuelo: 'JA5415', zona: 'Mota' },
    { rid: 'r5', auxId: 'a5', n: 'Andrés Cano', type: 'sal', dia: DAY, dl: '09:00', zona: 'Forest' },
  ];
  const P = (key, nombre, o) => Object.assign({ key, nombre, min: 0, dia: DAY, vuelo: null, deadline: null, lugar: '' }, o);
  const r = J._emparejar([
    P('a', 'Laura', { min: 250, deadline: 280 }),
    P('b', 'Lau idarraga', { min: 255, deadline: 280, lugar: 'Río vivo' }),
    P('c', 'Karol', { min: 880, vuelo: 'AV9412' }),
    P('d', 'cano', { min: 490, deadline: 520 }),
    P('e', 'Pepe', { min: 600 }),
  ], C, { cano: 'a5' });
  t('apodo aprendido («cano» → Andrés Cano): se elige solo', r.d.auto && r.d.rid === 'r5');
  t('«Lau idarraga (Río vivo)»: Laura Idárraga, sola', r.b.auto && r.b.rid === 'r2', JSON.stringify(r.b));
  t('«Laura» a secas con dos Lauras: la que queda (la otra ya se usó)', r.a.rid === 'r1', JSON.stringify(r.a));
  t('«Karol (AV9412)»: el vuelo decide entre las dos Karol', r.c.auto && r.c.rid === 'r3', JSON.stringify(r.c));
  t('«Pepe»: nadie (no pidió por la app)', !r.e.rid && r.e.opciones.length === 0);
  const r2 = J._emparejar([P('x', 'Laura', { min: 250, deadline: 280 })], C, {});
  t('«Laura» sola con dos Lauras del mismo turno: NO se elige sola, quedan las dos de opción', !r2.x.auto && r2.x.opciones.includes('r1') && r2.x.opciones.includes('r2'), JSON.stringify(r2.x));
  const r3 = J._emparejar([P('y', 'Karol', { min: 880, deadline: 920 })], C, {});
  t('una salida nunca se empareja con una llegada sin vuelo de por medio (Karol sale, las dos Karol llegan): queda en revisar', !r3.y.auto, JSON.stringify(r3.y));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── C · La hoja: pegar, revisar y publicar ──');
const TEXTO = [
  '3:50 Laura G (Olivar)', '4:00 Andres (Río vivo)', 'Deben estar 4:40', '',
  '5:30 José (Cerezos)', '5:40 Cami (Ébano)', 'Deben estar 6:10', '',
  '7:10 La flaca (Piedemonte)', 'Deben estar 7:40 Va a hotel', '',
  '8:20 Pepe (Mota)', 'Deben estar 8:50', '',
  '10:30 Felipe (Altos del lago)', 'Deben estar 11:20', '',
  '14:40 Natalia y Kevin (AV9412)', '',
  '16:10 Tomás y Sara (Av 9420)',
].join('\n');
let publicado = null;
const C = await boot({
  antes(w, log) {
    // Lo que contesta la base (0125) y, después, el día con la ruta pegada.
    w.Api.adminManualRoutePublish = async (day, blocks, aliases) => {
      log.julian.publicar.push({ day, blocks: JSON.parse(JSON.stringify(blocks)), aliases: JSON.parse(JSON.stringify(aliases)) });
      publicado = blocks;
      return { created: blocks.length, kept: 0, removed: 0, skipped: 0, notified: blocks.reduce((a, b) => a + b.stops.length, 0), drivers: 3, vueltas: blocks.length, from_board: 2 };
    };
    w.Api.adminManualRouteClear = async (day) => { log.julian.quitar.push(day); publicado = null; return 6; };
    const nombre = (rid) => { const c = w.RV2Fixture.crew().aux['r' + rid.slice(4)]; return c ? c.n : 'Tripulante'; };
    const pub0 = w.Api.getPublishedPlan;
    w.Api.getPublishedPlan = async (day, o) => {
      const r = await pub0(day, o);
      if (!publicado || day !== DAY) return r;
      const pool = publicado.map((b, i) => {
        const stops = b.stops.map((s, j) => ({ stopId: `ps-${i}-${j}`, rid: s.reservation_id, order: j + 1, status: 'pending', etaAt: s.at, name: nombre(s.reservation_id) }));
        return { id: 'pool-' + i, type: b.type, status: 'planned', startAt: b.stops[0].at, pool: true, manualDay: DAY, deadlineAt: b.deadline_at, nota: b.note || '',
          vehicleId: null, planCar: null, carro: 'Carro', placa: null, cap: 4, driverProfileId: null, conductor: 'Sin conductor', pendientes: stops, atendidas: [] };
      });
      // Una ya tomada, otra en curso (ya recogió a la primera).
      Object.assign(pool[1], { driverProfileId: 'd1', conductor: 'Jorge Pérez', placa: 'HYU376', vehicleId: 'veh-9' });
      Object.assign(pool[0], { driverProfileId: 'd2', conductor: 'Luis Arango', status: 'in_progress' });
      pool[0].atendidas = [Object.assign(pool[0].pendientes.shift(), { status: 'picked_up' })];
      // Día SOLO de Julián. Queda una vuelta del tablero (V-01 04:45, José y Camila)
      // con gente que ahora va en lo pegado: el tablero no tiene a nadie más, así
      // que el día sigue siendo de Julián, con la nota «Además hay 1 vuelta…». El día
      // MEZCLADO (tablero con gente propia + lo pegado) es la sección D2.
      return { day, vueltas: r.vueltas.slice(1, 2).concat(pool), publicado: true };
    };
  },
});
{
  const { w, q, qa, click, type, pick, log, J: JJ } = C;
  t('Rutas del día tiene «Ruta de Julián» y el Excel del día, antes del WhatsApp', q('#rv2-julian') && q('#rv2-xlsx') && q('#rv2-julian').nextElementSibling === q('#rv2-wa'));
  click(q('#rv2-julian')); await wait();
  const sh = q('#rv2-sheet');
  t('abre la hoja del día: «Ruta de Julián · lun 12 oct» con el cuadro para pegar', sh && /Ruta de Julián · lun 12 oct/.test(txt(sh)) && q('#rj-ta'), txt(sh) && txt(sh).slice(0, 90));
  t('«Publicar y avisar» empieza apagado', q('#rv2-sheet [data-rj="publicar"]').disabled === true);
  type(q('#rj-ta'), TEXTO);
  t('lo pegado se guarda de borrador (por día) mientras se escribe', w.localStorage.getItem('rendio.rutaJulian.' + DAY) === TEXTO);
  click(q('#rv2-sheet [data-rj="leer"]')); await wait(40);
  const st = JJ()._st;
  const fila = (nombre) => qa('#rj-prev .rj-p').find((p) => txt(p.querySelector('.rj-w')).startsWith(nombre));
  const quien = (nombre) => { const f = fila(nombre); return f ? f.querySelector('select').value : null; };
  t('leyó 7 vueltas y pidió los apodos aprendidos', qa('#rj-prev .rj-b').length === 7 && log.julian.apodos === 1, String(qa('#rj-prev .rj-b').length));
  t('«Laura G (Olivar)» → Laura Gómez · «Andres» → Andrés Ruiz (por el nombre y el «Deben estar»)', quien('Laura G') === 'res-A' && quien('Andres') === 'res-B' && fila('Laura G').dataset.st === 'ok');
  t('«José» → José Ñáñez (sin tildes) · «Cami (Ébano)» → Camila Ortiz', quien('José') === 'res-C' && quien('Cami') === 'res-D');
  t('«La flaca»: el apodo aprendido → Daniela Cano', quien('La flaca') === 'res-H' && fila('La flaca').dataset.st === 'ok');
  t('«Felipe» → Felipe Vélez · «Natalia (AV9412)» → Natalia Duque · «Tomás y Sara (Av 9420)» → los dos', quien('Felipe') === 'res-M' && quien('Natalia') === 'res-F' && quien('Tomás') === 'res-K' && quien('Sara') === 'res-L');
  t('«Kevin (AV9412)»: Kevin Uribe llega en otro vuelo (AV9414) → no se elige solo, pero sale de primera opción',
    quien('Kevin') === '' && fila('Kevin').dataset.st === 'sin' && fila('Kevin').querySelector('optgroup[label="Más probables"] option').value === 'res-O' && /elige quién es \(hay parecidos\)/.test(txt(fila('Kevin'))), fila('Kevin') && fila('Kevin').innerHTML.slice(0, 200));
  // 0133 (lista de los jefes, 26-oct): quien no se parece a nadie y trae lugar VA sin cuenta.
  t('0133: «Pepe (Mota)»: no pidió y no se parece a nadie → «Va sin cuenta» por defecto (en la ruta, sin aviso)', quien('Pepe') === '__guest' && fila('Pepe').dataset.st === 'guest' && /Sin cuenta: va en la ruta/.test(txt(fila('Pepe'))) && /No le llegan avisos/.test(txt(fila('Pepe'))), fila('Pepe') && txt(fila('Pepe')));
  t('…y se puede elegir «No pidió por la app» (no va)', [...fila('Pepe').querySelectorAll('option')].some((o) => o.value === '' && /No pidió por la app/.test(o.textContent)));
  const sum = () => txt(q('#rj-prev .rj-sum'));
  t('el resumen: 7 vueltas · 9 emparejados · 1 sin cuenta (Pepe) · 1 sin pedido (Kevin, por revisar)', /7 vueltas · 9 emparejados/.test(sum()) && /1 sin cuenta: van en la ruta, sin aviso/.test(sum()) && /1 sin pedido en la app \(no van\)/.test(sum()), sum());
  t('…y quién pidió por la app y NO está en la ruta (Valentina, Sergio, Paula, Mateo, Juliana, Manuela, Kevin)',
    ['Valentina (sale 06:00)', 'Sergio (sale 07:40)', 'Paula', 'Mateo', 'Juliana', 'Manuela (sale 09:10)', 'Kevin (llega 15:05)'].every((x) => sum().includes(x)), sum());
  const pub = () => q('#rv2-sheet [data-rj="publicar"]');
  t('«Publicar y avisar a 9 · 1 sin cuenta», encendido', !pub().disabled && txt(pub()) === 'Publicar y avisar a 9 · 1 sin cuenta', txt(pub()));
  t('la vuelta con «Deben estar … Va a hotel» muestra la nota', /Deben estar 7:40/.test(txt(qa('#rj-prev .rj-b')[2])) && /Va a hotel/.test(txt(qa('#rj-prev .rj-b')[2])));

  pick(fila('Pepe').querySelector('select'), 'res-A'); await wait();
  t('elegir a Laura también para Pepe: «Está dos veces» en los dos y Publicar se apaga', /Está dos veces/.test(txt(fila('Pepe'))) && /Está dos veces/.test(txt(fila('Laura G'))) && pub().disabled && /1 repetidos|2 repetidos/.test(sum()), sum());
  pick(fila('Pepe').querySelector('select'), ''); await wait();
  pick(fila('Andres').querySelector('select'), 'res-O'); await wait();
  t('elegir una LLEGADA (Kevin) en una vuelta de salidas: lo advierte («va en otra vuelta»)', /Es una llegada: va en otra vuelta/.test(txt(fila('Andres'))));
  pick(fila('Andres').querySelector('select'), 'res-B'); await wait();
  t('…y al volver a Andrés se quita', !/otra vuelta/.test(txt(fila('Andres'))));
  pick(fila('Kevin').querySelector('select'), 'res-O'); await wait();
  t('Kevin elegido a mano: «Elegido a mano: se aprende» y «Publicar y avisar a 10»', /se aprende/.test(txt(fila('Kevin'))) && !pub().disabled && txt(pub()) === 'Publicar y avisar a 10', txt(pub()));
  t('…y ya no sale en «no están en tu ruta»', !/Kevin \(llega/.test(sum()));

  C.confirms.length = 0;
  w.__confirma = false;
  click(pub()); await wait(30);
  t('Cancelar la confirmación no publica nada', log.julian.publicar.length === 0 && C.confirms.length === 1);
  w.__confirma = true;
  const seguidos = []; C.w.renderVuelos = { seguirDesdeTexto: async (texto, dia) => { seguidos.push([texto, dia]); return 2; } };   // Vuelos (admin-vuelos.js), lista de los jefes 26-oct
  click(pub()); await wait(80);
  t('la confirmación dice el día, cuántas vueltas y cuántos tripulantes', /12 oct\? 6 vueltas, 10 tripulantes/.test(C.confirms[1] || ''), C.confirms[1]);
  const call = log.julian.publicar[0];
  t('publica UNA vez, para el día de la pantalla', log.julian.publicar.length === 1 && call.day === DAY);
  const B = call ? call.blocks : [];
  t('6 vueltas (la de Pepe no va: nadie que avisar), 10 paradas', B.length === 6 && B.reduce((a, b) => a + b.stops.length, 0) === 10, JSON.stringify(B.map((b) => b.stops.length)));
  t('la primera: salida, Laura 3:50 y Andrés 4:00 con hora de Colombia, «Deben estar» 4:40',
    B[0] && B[0].type === 'sal' && B[0].stops[0].reservation_id === 'res-A' && B[0].stops[0].at === `${DAY}T03:50:00-05:00` && B[0].stops[1].at === `${DAY}T04:00:00-05:00` && B[0].deadline_at === `${DAY}T04:40:00-05:00` && B[0].flight === null, JSON.stringify(B[0]));
  t('«Va a hotel» viaja como nota de su vuelta', B[2] && B[2].note === 'Va a hotel' && B[2].stops[0].reservation_id === 'res-H');
  const lle = B.find((b) => b.flight === 'AV9412');
  t('la llegada AV9412: tipo llegada, Natalia y Kevin a las 14:40, sin «Deben estar»', lle && lle.type === 'lle' && lle.stops.map((s) => s.reservation_id).join() === 'res-F,res-O' && lle.deadline_at === null, JSON.stringify(lle));
  t('la llegada «Av 9420» va como AV9420', B.some((b) => b.flight === 'AV9420' && b.stops.length === 2));
  t('aprende solo lo elegido a mano: «kevin» → el perfil de Kevin', call && JSON.stringify(call.aliases) === JSON.stringify([{ alias: 'kevin', auxiliar_profile_id: 'aux-rO' }]), call && JSON.stringify(call.aliases));
  t('la hoja se cierra y el aviso dice cuántas vueltas y a cuántos se avisó', !q('#rv2-sheet.is-open') && /Ruta publicada: 6 vueltas · avisados 10/.test(C.toastV2() || ''), C.toastV2());
  t('26-oct: las llegadas del mismo texto pasan solas a Vuelos (el día de la ruta)', seguidos.length === 1 && seguidos[0][1] === DAY && /AV9412/i.test(seguidos[0][0]), JSON.stringify(seguidos.map((x) => x[1])));
  t('…y el aviso lo dice («· 2 vuelos a Vuelos»)', /· 2 vuelos a Vuelos\./.test(C.toastV2() || ''), C.toastV2());
  delete C.w.renderVuelos;
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── D · El día con la ruta de Julián ──');
{
  const { w, q, qa, click, log, T } = C;
  const dia = q('#rv2-list .rj-dia');
  t('Rutas del día muestra la ruta de Julián en lugar del tablero', dia && /Ruta de Julián · lun 12 oct/.test(txt(dia)) && !qa('#rv2-list .rv2-row').length, txt(q('#rv2-list')) && txt(q('#rv2-list')).slice(0, 120));
  t('«6 vueltas · 4 sin tomar»', /6 vueltas · 4 sin tomar/.test(txt(dia)), txt(q('.rj-dia-h')));
  const vs = qa('.rj-dia .rj-v');
  t('en orden de hora, cada una con su estado: en curso, tomada y libres', vs.length === 6 && vs[0].dataset.st === 'curso' && vs[1].dataset.st === 'tomada' && vs.slice(2).every((v) => v.dataset.st === 'libre'), JSON.stringify(vs.map((v) => v.dataset.st)));
  t('«En curso · Luis Arango» · «Tomada por Jorge Pérez · HYU376» · «Disponible»', /En curso · Luis Arango/.test(txt(vs[0])) && /Tomada por Jorge Pérez · HYU376/.test(txt(vs[1])) && /Disponible/.test(txt(vs[2])));
  t('cada vuelta con su gente por nombre, el «Deben estar» y la nota', /Laura, Andrés/.test(txt(vs[0])) && /Deben estar 4:40/.test(txt(vs[0])) && /Va a hotel/.test(txt(vs[2])), txt(vs[0]) + ' | ' + txt(vs[2]));
  t('la llegada dice «Llegada» y su hora (14:40)', /^14:40\s*Llegada/.test(txt(vs[4])), txt(vs[4]));
  t('avisa que además queda 1 vuelta del tablero ese día (sin nadie propio: no hay tablero que mostrar)', /Además hay 1 vuelta del tablero/.test(txt(dia)) && !dia.classList.contains('is-mixto'), txt(dia) && txt(dia).slice(0, 160));
  t('la frase de arriba lo explica', /Este día va con la ruta de Julián/.test(txt(q('#rv2-say'))));
  t('Publicar y Re-optimizar quedan apagados («Ruta de Julián publicada»)', q('#rv2-publish').disabled && q('#rv2-reopt').disabled && txt(q('#rv2-publishLabel')) === 'Ruta de Julián publicada', txt(q('#rv2-publishLabel')));
  const antes = log.saved.length;
  const r = await T().rtSavePlan();
  t('y el tablero no puede publicar encima (rtSavePlan se niega)', r && r.ok === false && log.saved.length === antes, JSON.stringify(r));
  t('el día queda marcado (rt.manualDia)', T().rt.manualDia === true);

  click(q('[data-rj-dia="pegar"]')); await wait(40);
  t('«Volver a pegar» abre la hoja con lo que se pegó', q('#rj-ta') && q('#rj-ta').value.startsWith('3:50 Laura G'));
  C.V2()._sheet.close(); await wait();

  // 0126 · Delegar una vuelta pegada (la hace alguien de afuera) y devolverla.
  const deleg = new Set(), llamadas = [];
  w.Api.setRouteDelegated = async (id, on) => { llamadas.push([id, on]); if (on) deleg.add(id); else deleg.delete(id); return { id, delegated: on, notified: 2 }; };
  const pub1 = w.Api.getPublishedPlan;
  w.Api.getPublishedPlan = async (...a) => { const r = await pub1(...a); (r.vueltas || []).forEach((v) => { if (deleg.has(v.id)) Object.assign(v, { delegated: true, driverProfileId: null, conductor: 'Sin conductor', placa: null }); }); return r; };
  const btnDe = (v) => v && v.querySelector('[data-rj-deleg]');
  let vs0 = qa('.rj-dia .rj-v');
  t('0126: la libre y la tomada tienen «Delegar»; la que va en curso no', !btnDe(vs0[0]) && /Delegar/.test(txt(btnDe(vs0[1]))) && /Delegar/.test(txt(btnDe(vs0[2]))), vs0.map((v) => txt(btnDe(v)) || '—').join(' | '));
  C.confirms.length = 0; w.__confirma = true;
  click(btnDe(vs0[1])); await wait(80);
  t('0126: pregunta antes y avisa que Jorge la había tomado', /¿Delegar la vuelta de las \d{1,2}:\d\d/.test(C.confirms[0] || '') && /Jorge Pérez la había tomado: se le avisa que ya no la hace/.test(C.confirms[0] || '') && /Tu servicio fue delegado, te contactaremos por WhatsApp/.test(C.confirms[0] || ''), C.confirms[0]);
  t('0126: la delega en la base (esa vuelta, sí)', JSON.stringify(llamadas) === JSON.stringify([['pool-1', true]]), JSON.stringify(llamadas));
  t('0126: el aviso dice a cuántos avisó', /Vuelta de las \d{1,2}:\d\d delegada · avisamos a 2 tripulantes/.test(C.toastV2() || ''), C.toastV2());
  vs0 = qa('.rj-dia .rj-v');
  t('0126: el día se recarga: «Delegada · la hace alguien de afuera» y el botón «Devolver»', vs0[1] && vs0[1].dataset.st === 'delegada' && /Delegada · la hace alguien de afuera/.test(txt(vs0[1])) && /Devolver/.test(txt(btnDe(vs0[1]))), vs0[1] && txt(vs0[1]));
  t('0126: el encabezado la cuenta aparte («6 vueltas · 4 sin tomar · 1 delegada»)', /6 vueltas · 4 sin tomar · 1 delegada/.test(txt(q('.rj-dia-h'))), txt(q('.rj-dia-h')));
  C.confirms.length = 0;
  w.__confirma = false;
  click(btnDe(vs0[1])); await wait(40);
  t('0126: si no confirma, no se devuelve', llamadas.length === 1 && /¿Devolver la vuelta/.test(C.confirms[0] || ''));
  w.__confirma = true;
  click(btnDe(qa('.rj-dia .rj-v')[1])); await wait(80);
  t('0126: «Devolver» la quita de delegada y vuelve a la lista', JSON.stringify(llamadas[1]) === JSON.stringify(['pool-1', false]) && qa('.rj-dia .rj-v')[1].dataset.st !== 'delegada' && /devuelta: ya la pueden tomar/.test(C.toastV2() || ''), JSON.stringify(llamadas) + ' · ' + C.toastV2());
  w.Api.setRouteDelegated = async () => { throw new Error('Para delegar falta la actualización 0126 de la base.'); };
  click(btnDe(qa('.rj-dia .rj-v')[2])); await wait(60);
  t('0126: sin la base al día lo dice (y el botón vuelve a servir)', /No se pudo: Para delegar falta la actualización 0126/.test(C.toastV2() || '') && !btnDe(qa('.rj-dia .rj-v')[2]).disabled, C.toastV2());
  // 0131 · Delegar A ALGUIEN (libreta o a mano) desde la ruta de Julián.
  const dlg = [], quien = {};
  w.Api.listDelegateContacts = async () => [{ id: 'c1', name: 'Uber de Camilo', phone: '311 222 3344' }];
  w.Api.delegateRoute = async (id, n, ph) => { dlg.push([id, n, ph]); quien[id] = { n, ph }; return { id, delegated: true, name: n, phone: ph, notified: 2 }; };
  w.Api.getPublishedPlan = async (...a) => { const r = await pub1(...a); (r.vueltas || []).forEach((v) => { if (quien[v.id]) Object.assign(v, { delegated: true, driverProfileId: null, conductor: 'Sin conductor', placa: null, delegateName: quien[v.id].n, delegatePhone: quien[v.id].ph }); }); return r; };
  await C.V2().cargarDia(DAY); await wait(80);
  let vsD = qa('.rj-dia .rj-v');
  const idD = btnDe(vsD[3]).getAttribute('data-rj-deleg');
  C.confirms.length = 0;
  click(btnDe(vsD[3])); await wait(40);
  t('0131: «Delegar» abre «Delegar a…» (ya no la pregunta de antes) con la libreta', C.confirms.length === 0 && txt(q('#rv2-shTitle')) === 'Delegar a…' && /Uber de Camilo/.test(txt(q('#rv2-dlg'))) && /Delegar y avisar/.test(txt(q('#rv2-dlg-ok'))), txt(q('#rv2-shTitle')));
  click(q('#rv2-dlg [data-dpick="0"]')); await wait(5);
  click(q('#rv2-dlg-ok')); await wait(120);
  t('0131: delega esa vuelta a «Uber de Camilo · 311 222 3344»', dlg.length === 1 && dlg[0][0] === idD && dlg[0][1] === 'Uber de Camilo' && dlg[0][2] === '311 222 3344', JSON.stringify(dlg));
  t('0131: el aviso dice a quién y a cuántos avisó', /delegada a Uber de Camilo · avisamos a 2 tripulantes/.test(C.toastV2() || ''), C.toastV2());
  vsD = qa('.rj-dia .rj-v');
  const laD = vsD.find((v) => v.querySelector(`[data-rj-deleg="${idD}"]`));
  t('0131: el día se recarga: «Delegada · Uber de Camilo · 311 222 3344» con «Cambiar a quién» y «Devolver»', laD && laD.dataset.st === 'delegada' && /Delegada · Uber de Camilo · 311 222 3344/.test(txt(laD)) && /Cambiar a quién/.test(txt(laD)) && /Devolver/.test(txt(laD)), laD && txt(laD));
  w.Api.getPublishedPlan = pub1;
  delete w.Api.delegateRoute; delete w.Api.listDelegateContacts;
  await C.V2().cargarDia(DAY); await wait(80);

  w.Api.getPublishedPlan = pub1;

  // 0129 · El jefe le da una vuelta pegada a un conductor (sin que la tome desde
  // su app), o se la quita y vuelve a la lista. Aplica al momento.
  const asign = [], dueno = {};
  const nombreDe = (pid) => ((T().rt.drivers || []).find((d) => d.id === pid) || {}).n || 'Conductor';
  w.Api.setVueltaDriver = async (id, pid) => { asign.push([id, pid]); dueno[id] = pid; return { id, notified: 2, status: 'planned' }; };
  w.Api.getPublishedPlan = async (...a) => { const r = await pub1(...a); (r.vueltas || []).forEach((v) => { if (v.id in dueno) Object.assign(v, { driverProfileId: dueno[v.id], conductor: dueno[v.id] ? nombreDe(dueno[v.id]) : 'Sin conductor', delegated: false }); }); return r; };
  await C.V2().cargarDia(DAY); await wait(80);
  const drvBtn = (v) => v && v.querySelector('[data-rj-drv]');
  let vs1 = qa('.rj-dia .rj-v');
  t('0129: «Asignar conductor» en la libre, «Cambiar conductor» en la tomada, nada en la que va en curso', !drvBtn(vs1[0]) && /Cambiar conductor/.test(txt(drvBtn(vs1[1]))) && /Asignar conductor/.test(txt(drvBtn(vs1[2]))), vs1.map((v) => txt(drvBtn(v)) || '—').join(' | '));
  const idLibre = drvBtn(vs1[2]).getAttribute('data-rj-drv');
  click(drvBtn(vs1[2])); await wait(10);
  let pick = q('.rj-dia .rj-pick');
  const sel = pick && pick.querySelector('select');
  const opt = sel && [...sel.options].find((o) => o.value && o.value !== '__none');
  t('0129: sale la lista de conductores ahí mismo, con «Asignar» apagado; una libre no ofrece «Sin conductor»', !!opt && pick.querySelector('[data-rj-drv-ok]').disabled && ![...sel.options].some((o) => o.value === '__none'), pick && txt(pick));
  sel.value = opt.value; sel.dispatchEvent(new w.Event('change'));
  t('0129: al elegir, «Asignar» se enciende', !pick.querySelector('[data-rj-drv-ok]').disabled);
  click(pick.querySelector('[data-rj-drv-ok]')); await wait(100);
  t('0129: la asigna en la base (esa vuelta, ese conductor)', asign.length === 1 && asign[0][0] === idLibre && asign[0][1] === opt.value, JSON.stringify(asign));
  t('0129: el aviso dice quién la hace y a cuántos avisó', new RegExp(opt.text + ' hace la vuelta de las \\d{1,2}:\\d\\d · avisamos a 2 tripulantes').test(C.toastV2() || ''), C.toastV2());
  vs1 = qa('.rj-dia .rj-v');
  const laV = vs1.find((v) => drvBtn(v) && drvBtn(v).getAttribute('data-rj-drv') === idLibre);
  t('0129: el día se recarga y esa vuelta sale «Tomada por …» con «Cambiar conductor»', laV && laV.dataset.st === 'tomada' && new RegExp('Tomada por ' + opt.text).test(txt(laV)) && /Cambiar conductor/.test(txt(drvBtn(laV))), laV && txt(laV));
  click(drvBtn(laV)); await wait(10);
  pick = q('.rj-dia .rj-pick');
  const sel2 = pick.querySelector('select');
  t('0129: a la tomada no se le ofrece el mismo conductor, y sí «Sin conductor»', ![...sel2.options].some((o) => o.value === opt.value) && [...sel2.options].some((o) => o.value === '__none'));
  sel2.value = '__none'; sel2.dispatchEvent(new w.Event('change'));
  click(pick.querySelector('[data-rj-drv-ok]')); await wait(100);
  t('0129: «Sin conductor» manda null y dice que vuelve a la lista', asign.length === 2 && asign[1][1] === null && /quedó sin conductor: vuelve a la lista para que la tomen/.test(C.toastV2() || ''), JSON.stringify(asign) + ' · ' + C.toastV2());
  click(drvBtn(qa('.rj-dia .rj-v')[3])); await wait(10);
  click(q('.rj-dia [data-rj-drv-x]')); await wait(60);
  t('0129: «Cancelar» cierra la lista sin llamar a la base', !q('.rj-dia .rj-pick') && asign.length === 2);
  w.Api.setVueltaDriver = async () => { throw new Error('Esa vuelta ya arrancó: cámbiala en el tablero y publica'); };
  click(drvBtn(qa('.rj-dia .rj-v')[3])); await wait(10);
  pick = q('.rj-dia .rj-pick');
  const sel3 = pick.querySelector('select'); sel3.value = [...sel3.options].find((o) => o.value && o.value !== '__none').value; sel3.dispatchEvent(new w.Event('change'));
  click(pick.querySelector('[data-rj-drv-ok]')); await wait(60);
  t('0129: si la base no deja, lo dice y se puede reintentar', /No se pudo: Esa vuelta ya arrancó/.test(C.toastV2() || '') && !q('.rj-dia [data-rj-drv-ok]').disabled, C.toastV2());
  delete w.Api.setVueltaDriver;
  w.Api.getPublishedPlan = pub1;
  await C.V2().cargarDia(DAY); await wait(80);

  C.confirms.length = 0; w.__confirma = true;
  click(q('[data-rj-dia="quitar"]')); await wait(80);
  t('«Quitar la ruta» pregunta (avisa que también se van las tomadas)', /también las ya tomadas/.test(C.confirms[0] || ''), C.confirms[0]);
  t('…y la quita en la base para ese día', JSON.stringify(log.julian.quitar) === JSON.stringify([DAY]));
  t('el día vuelve al tablero (las vueltas del tablero, Publicar de nuevo disponible)', !q('#rv2-list .rj-dia') && qa('#rv2-list .rv2-row').length > 0 && T().rt.manualDia === false && !q('#rv2-reopt').disabled, String(qa('#rv2-list .rv2-row').length));
  t('sin errores de script', C.errors.length === 0, C.errors.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
// Producción, 26-oct-2026, 13:53: Christian pegó una ruta de Julián de 2 vueltas
// (14:00 delegada a «Felix Covault (Placa LLU676)», 14:15 con conductor) en un día
// con 45 vueltas del tablero, y la pantalla mostró SOLO las 2 pegadas: sin lista,
// mapa, conductores ni avisos, y Publicar/Re-optimizar apagados.
console.log('\n── D2 · Día mezclado: tablero + unas vueltas pegadas ──');
{
  let pegadas = true;
  const M = await boot({
    antes(w, log) {
      w.eval(read('vendor/exceljs-4.4.0.min.js'));
      w.URL.createObjectURL = () => 'blob:prueba';
      w.URL.revokeObjectURL = () => {};
      w.HTMLAnchorElement.prototype.click = function () { (w.__descargas = w.__descargas || []).push(this.download); };
      w.Api.adminManualRouteClear = async (day) => { log.julian.quitar.push(day); pegadas = false; return 2; };
      w.Api.setRouteDelegated = async (id, on) => { (log.julian.deleg = log.julian.deleg || []).push([id, on]); return { id, delegated: on, notified: 2 }; };
      w.Api.delegateRoute = async () => ({ delegated: true, notified: 0 });
      w.Api.setVueltaDriver = async () => ({ notified: 0 });
      w.Api.adminManualRouteSetTimes = async (id, a) => { (log.julian.horas = log.julian.horas || []).push([id, a]); return { notified: 2 }; };   // 0145
      const pub0 = w.Api.getPublishedPlan;
      w.Api.getPublishedPlan = async (day, o) => {
        const r = await pub0(day, o);
        if (day !== DAY) return r;
        // Lo pegado sacó a Mateo y Juliana de su vuelta del tablero (V-03 07:40), que
        // quedó vacía y se fue (admin_manual_route_publish). Las otras 8 siguen,
        // también después de «Quitar la ruta».
        const tablero = r.vueltas.filter((v) => v.id !== 'ra-8');
        if (!pegadas) return { ...r, vueltas: tablero };
        const p = (rid, name, j, at) => ({ stopId: 'pm-' + rid, rid, order: j + 1, status: 'pending', etaAt: `${DAY}T${at}:00-05:00`, name });
        const pool = [
          // Delegada a alguien de afuera (el tercer carro), como la de las 14:00.
          { id: 'pool-m1', type: 'sal', status: 'planned', startAt: `${DAY}T08:10:00-05:00`, pool: true, manualDay: DAY, deadlineAt: `${DAY}T08:50:00-05:00`, nota: '',
            vehicleId: null, planCar: null, carro: 'Carro', placa: null, cap: 4, driverProfileId: null, conductor: 'Sin conductor',
            delegated: true, delegateName: 'Felix Covault (Placa LLU676)', delegatePhone: '',
            pendientes: [p('res-I', 'Mateo Zapata', 0, '08:10'), p('res-J', 'Juliana Ossa', 1, '08:15')], atendidas: [] },
          // Tomada por un conductor de la app. Paula ADEMÁS va en una vuelta del
          // tablero que ya arrancó (V-03 07:00, ya la recogieron): ahí va de verdad.
          { id: 'pool-m2', type: 'sal', status: 'planned', startAt: `${DAY}T08:30:00-05:00`, pool: true, manualDay: DAY, deadlineAt: `${DAY}T09:00:00-05:00`, nota: '',
            vehicleId: null, planCar: null, carro: 'Carro', placa: null, cap: 4, driverProfileId: 'd5', conductor: 'Rubén Díaz', delegated: false,
            pendientes: [p('res-N', 'Manuela Franco', 0, '08:30'), p('res-P', 'Paula Henao', 1, '08:35')], atendidas: [] },
        ];
        return { day, vueltas: tablero.concat(pool), publicado: true };
      };
    },
  });
  const { w, q, qa, click, type, log, T } = M;
  const rt = () => T().rt;
  const enAux = (rid) => Object.values(rt().aux).some((a) => a.reservationId === rid);
  const bloque = () => q('#rv2-list .rj-dia');
  const tablero = () => qa('#rv2-list .rv2-row[data-id]');
  const pegada = (id) => q(`#rv2-list .rv2-row--julian[data-julian="${id}"]`);
  const filas = () => qa('#rv2-list .rv2-row');
  t('se ve el TABLERO: las 7 vueltas que no han terminado, en la lista', tablero().length === 7, String(tablero().length));
  // Audios de los jefes, 26-oct 4:22 p. m.: «que lo meta en el listado normal completo y lo organice por horas».
  t('las 2 vueltas pegadas van DENTRO de la lista (ya no en un recuadro aparte)', pegada('pool-m1') && pegada('pool-m2') && !q('#rv2-list .rj-dia .rj-v') && filas().length === 9, String(filas().length));
  const ix = (el) => filas().indexOf(el);
  const deTab = (id) => tablero().find((r) => r.dataset.id === id);
  t('…en su hora: la de las 8:10 («Deben estar 8:50») después de V-03 7:00 y antes de V-02 10:00; la de las 8:30 detrás',
    ix(deTab('V-03·V1')) < ix(pegada('pool-m1')) && ix(pegada('pool-m1')) < ix(pegada('pool-m2')) && ix(pegada('pool-m2')) < ix(deTab('V-02·V3')), filas().map((r) => r.dataset.id || r.dataset.julian).join(' '));
  t('…bajo el encabezado de su hora («08:00 – 09:00»)', /^08:00 – 09:00/.test(txt(pegada('pool-m1').closest('.rv2-gwrap').querySelector('.rv2-hour'))), txt(pegada('pool-m1').closest('.rv2-gwrap').querySelector('.rv2-hour')));
  t('cada una con la etiqueta «Ruta de Julián», su tipo y su hora (08:10 → 08:50)', /Salida/.test(txt(pegada('pool-m1').querySelector('.rv2-pill'))) && txt(pegada('pool-m1').querySelector('.rj-tag')) === 'Ruta de Julián' && /^08:10 → 08:50/.test(txt(pegada('pool-m1').querySelector('.when b'))), txt(pegada('pool-m1')));
  t('…con los NOMBRES COMPLETOS y su conjunto (los jefes no sabían si «Paula» era Paula Londoño)', /Mateo Zapata/.test(txt(pegada('pool-m1'))) && /Juliana Ossa/.test(txt(pegada('pool-m1'))) && /Cámbulo/.test(txt(pegada('pool-m1'))) && /Manuela Franco/.test(txt(pegada('pool-m2'))), txt(pegada('pool-m1')));
  t('arriba queda solo la barra: «Ruta de Julián · lun 12 oct», «2 vueltas pegadas · todas tomadas · 1 delegada» y que van en la lista',
    bloque() && bloque().classList.contains('rj-barra') && q('#rv2-list').firstElementChild === bloque() && /Ruta de Julián · lun 12 oct/.test(txt(bloque())) && /2 vueltas pegadas · todas tomadas · 1 delegada/.test(txt(q('.rj-dia-h'))) && /Van en la lista, en su hora/.test(txt(bloque())) && !/Van aparte/.test(txt(bloque())), txt(bloque()));
  const vM1 = pegada('pool-m1'), vM2 = pegada('pool-m2');
  t('la delegada: «Delegada · Felix Covault (Placa LLU676)» con «Cambiar a quién», «Devolver» y «Cambiar hora»', vM1.dataset.st === 'delegada' && /Delegada · Felix Covault \(Placa LLU676\)/.test(txt(vM1)) && /Cambiar a quién/.test(txt(vM1)) && /Devolver/.test(txt(vM1)) && /Cambiar hora/.test(txt(vM1)), txt(vM1));
  t('la tomada: «Tomada por Rubén Díaz» con «Cambiar conductor», «Delegar» y «Cambiar hora»', vM2.dataset.st === 'tomada' && /Tomada por Rubén Díaz/.test(txt(vM2)) && /Cambiar conductor/.test(txt(vM2)) && /Delegar/.test(txt(vM2)) && /Cambiar hora/.test(txt(vM2)), txt(vM2));
  t('arriba están los botones del día pegado: Volver a pegar, Excel del día, Quitar la ruta', q('.rj-barra [data-rj-dia="pegar"]') && q('.rj-barra [data-rj-dia="excel"]') && q('.rj-barra [data-rj-dia="quitar"][data-mixto="1"]'));
  t('Avisos y Conductores se ven', !q('#rv2-summary').hidden && /Avisos/.test(txt(q('#rv2-avisos'))) && /Conductores/.test(txt(q('#rv2-drivers'))), txt(q('#rv2-avisos')) && txt(q('#rv2-avisos')).slice(0, 80));
  t('el detalle de una vuelta del tablero con su mapa', !q('#rv2-mapwrap').hidden && /V-0\d · Vuelta \d/.test(txt(q('#rv2-dhead'))), txt(q('#rv2-dhead')));
  const dhead0 = txt(q('#rv2-dhead')), sel0 = M.V2()._ui.sel;
  click(vM2.querySelector('.people')); await wait(20);
  t('tocar una vuelta pegada no abre el detalle (no es del tablero): queda la que estaba', M.V2()._ui.sel === sel0 && txt(q('#rv2-dhead')) === dhead0, M.V2()._ui.sel);
  t('las pegadas no son filas del tablero: sin data-id, sin «role=button» y sin gente para arrastrar', !vM1.hasAttribute('data-id') && !vM1.hasAttribute('role') && !vM1.querySelector('[draggable="true"], [data-drag]'));
  t('la frase de arriba es la del tablero y cuenta lo pegado aparte', !/Este día va con la ruta de Julián/.test(txt(q('#rv2-say'))) && /además 2 vueltas de la ruta de Julián/.test(txt(q('#rv2-say'))), txt(q('#rv2-say')));
  t('Publicar y Re-optimizar quedan ENCENDIDOS (el día no queda marcado como solo de Julián)', !q('#rv2-publish').disabled && !q('#rv2-reopt').disabled && rt().manualDia === false && txt(q('#rv2-publishLabel')) !== 'Ruta de Julián publicada', txt(q('#rv2-publishLabel')));
  t('Mateo, Juliana y Manuela (van en lo pegado) NO están en el tablero ni «sin carro»', !enAux('res-I') && !enAux('res-J') && !enAux('res-N') && !(rt().pool || []).some((k) => ['rI', 'rJ', 'rN'].includes(k)));
  t('…ni en Avisos (Kevin, que no va en nada, sí)', !/Manuela Franco/.test(txt(q('#rv2-avisos'))) && /Kevin Uribe no tiene carro/.test(txt(q('#rv2-avisos'))), txt(q('#rv2-avisos')));
  t('…pero se guardan aparte (para volver a pegar y para el Excel)', ['rI', 'rJ', 'rN'].every((k) => rt().rv2AuxPegadas && rt().rv2AuxPegadas[k]) && !rt().rv2AuxPegadas.rP, JSON.stringify(Object.keys(rt().rv2AuxPegadas || {})));
  t('Paula, que ya va en una vuelta del tablero que arrancó, se queda en esa vuelta', enAux('res-P') && Object.values(rt().order).some((ids) => ids.includes('rP')));

  // Publicar el tablero: el aviso de la hoja y lo que le llega a saveRoutePlan.
  click(q('#rv2-publish')); await wait(20);
  t('la hoja de Publicar dice que la ruta de Julián no se toca', /La ruta de Julián de este día \(2 vueltas pegadas\) no se toca/.test(txt(q('#rv2-sheet [data-k="julian"]'))), txt(q('#rv2-sheet')) && txt(q('#rv2-sheet')).slice(0, 200));
  const antesP = log.saved.length;
  if (q('#rv2-forceOpen')) click(q('#rv2-forceOpen'));
  ['#rv2-forceRisk', '#rv2-forceUnr'].forEach((s) => { const x = q(s); if (x) { x.checked = true; x.dispatchEvent(new w.Event('change', { bubbles: true })); } });
  click(q('#rv2-doForce') && !q('#rv2-doForce').hidden ? q('#rv2-doForce') : q('#rv2-doPublish')); await wait(120);
  const lanesP = (log.saved[antesP] || {}).lanes || [];
  const ridsP = lanesP.flatMap((l) => l.stops || []);
  t('publica el tablero (una vez) sin la gente de lo pegado', log.saved.length === antesP + 1 && lanesP.length > 0 && !['res-I', 'res-J', 'res-N'].some((x) => ridsP.includes(x)), JSON.stringify(ridsP));
  t('…con Paula en su vuelta en curso (ahí la deja saveRoutePlan)', ridsP.includes('res-P'));
  t('…y las vueltas pegadas siguen en la lista', bloque() && pegada('pool-m1') && pegada('pool-m2') && tablero().length > 0);

  // Re-optimizar arma el tablero sin meter a nadie de lo pegado.
  M.confirms.length = 0; w.__confirma = true;
  click(q('#rv2-reopt')); await wait(400);
  const ruteados = Object.values(rt().order).flat();
  t('Re-optimizar arma el día sin la gente de lo pegado', ruteados.length > 0 && !['rI', 'rJ', 'rN'].some((k) => ruteados.includes(k)) && !M.toasts.some((x) => /ruta de Julián/.test(x)), JSON.stringify(ruteados));
  t('…y las vueltas pegadas siguen en la lista', !!pegada('pool-m1') && tablero().length > 0);

  // Buscar: también encuentra a quien va en lo pegado.
  type(q('#rv2-q'), 'manuela'); await wait(200);
  t('buscar «manuela»: sale su vuelta pegada, en la lista (no «Sin resultados»)', qa('#rv2-list .rv2-row--julian').length === 1 && /Manuela/.test(txt(pegada('pool-m2'))) && !/Sin resultados/.test(txt(q('#rv2-list'))), txt(q('#rv2-list')) && txt(q('#rv2-list')).slice(0, 120));
  t('…resaltada como en el tablero, y buscando no sale la barra', pegada('pool-m2').querySelector('mark') && !bloque());
  type(q('#rv2-q'), 'laura'); await wait(200);
  t('buscar «laura» (va en el tablero): no sale ninguna pegada', !qa('#rv2-list .rv2-row--julian').length && tablero().length >= 1);
  type(q('#rv2-q'), 'felix'); await wait(200);
  t('buscar «felix» (a quién se delegó): sale la delegada', qa('#rv2-list .rv2-row--julian').length === 1 && pegada('pool-m1'));
  type(q('#rv2-q'), 'zzz'); await wait(200);
  t('buscar algo que no está: «Sin resultados»', /Sin resultados para «zzz»/.test(txt(q('#rv2-list'))));
  type(q('#rv2-q'), ''); await wait(200);

  // Volver a pegar y el Excel: la gente de lo pegado sigue siendo del día.
  click(q('.rj-barra [data-rj-dia="pegar"]')); await wait(20);
  type(q('#rj-ta'), '8:30 Manuela (Mangle)\nDeben estar 9:00');
  click(q('#rv2-sheet [data-rj="leer"]')); await wait(60);
  const filaMa = qa('#rj-prev .rj-p').find((p) => /Manuela/.test(txt(p.querySelector('.rj-w'))));
  t('«Volver a pegar»: Manuela (ya en lo pegado) se encuentra en los pedidos del día', filaMa && filaMa.querySelector('select').value === 'res-N', filaMa && txt(filaMa));
  M.V2()._sheet.close(); await wait();
  const xl = await M.J().excel();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(xl.buf));
  const nombres = [];
  wb.getWorksheet('RESPUESTAS').eachRow((row, i) => { if (i > 1) nombres.push(String(row.values[1] || '')); });
  t('el Excel del día trae a todos (16), también a Mateo, Juliana y Manuela', nombres.length === 16 && ['Mateo Zapata', 'Juliana Ossa', 'Manuela Franco'].every((n) => nombres.includes(n)), String(nombres.length));

  // Los botones de cada vuelta pegada funcionan igual dentro de la lista.
  M.confirms.length = 0;
  click(pegada('pool-m1').querySelector('[data-rj-deleg][data-on="0"]')); await wait(100);
  t('«Devolver» desde la lista: pregunta y la devuelve en la base', /¿Devolver la vuelta/.test(M.confirms[0] || '') && JSON.stringify(log.julian.deleg) === JSON.stringify([['pool-m1', false]]), JSON.stringify(log.julian.deleg));

  // «Quitar la ruta» en el día mezclado: su gente vuelve al tablero sin carro.
  M.confirms.length = 0;
  click(q('.rj-barra [data-rj-dia="quitar"]')); await wait(150);
  t('«Quitar la ruta» explica que esos tripulantes quedan sin carro en el tablero', /quedan sin carro en el tablero/.test(M.confirms[0] || '') && /Las vueltas del tablero no cambian/.test(M.confirms[0] || ''), M.confirms[0]);
  t('…la quita en la base y el día queda solo con el tablero', JSON.stringify(log.julian.quitar) === JSON.stringify([DAY]) && !bloque() && !qa('#rv2-list .rv2-row--julian').length && tablero().length > 0, JSON.stringify(log.julian.quitar));
  t('…y Mateo, Juliana y Manuela salen «sin carro» en Avisos', enAux('res-I') && enAux('res-J') && enAux('res-N') && /Manuela Franco no tiene carro/.test(txt(q('#rv2-avisos'))) && /Mateo Zapata no tiene carro/.test(txt(q('#rv2-avisos'))), txt(q('#rv2-avisos')) && txt(q('#rv2-avisos')).slice(0, 200));
  t('sin errores de script', M.errors.length === 0, M.errors.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
// Audio de los jefes, 26-oct 4:26 p. m.: «si uno coloca aero que sepa que es desde
// el JMC, aero r que es desde el JMC, Río Verde que es desde el hotel Río Verde…
// lo detectó como si fuese desde la casa y puso la ruta invertida».
console.log('\n── A2 · «(Aero r)», «(Hotel)», «(Río Verde)»: de JMC o del hotel a la casa ──');
{
  const L = J._leer('16:20 Andrea Núñez y Lesmes (aero r)\n\n18:00 Lina (Río Verde)\n18:05 Pacho (Av9563)\n\n19:00 Kris (Aero)\nDeben estar 19:30', DAY);
  const l0 = L.bloques[0].lineas[0];
  t('«16:20 Andrea Núñez y Lesmes (aero r)»: las recogen en JMC (dos personas, sin vuelo)', l0.desde === 'aero' && !l0.vuelo && l0.personas.join('|') === 'Andrea Núñez|Lesmes', JSON.stringify(l0));
  t('«(Río Verde)» junto a un vuelo en el mismo bloque: hotel Río Verde + AV9563', L.bloques[1].lineas[0].desde === 'rio_verde' && L.bloques[1].lineas[1].vuelo === 'AV9563');
  t('con «Deben estar» el bloque es una salida (el paréntesis es solo dónde lo recoge)', L.bloques[2].deadline && L.bloques[2].deadline.min === 1170 && L.bloques[2].lineas[0].desde === 'aero');
  const variantes = { 'Aero R': 'aero', AeroR: 'aero', 'aero-r': 'aero', JMC: 'aero', Aeropuerto: 'aero', Hotel: 'hotel', 'Hotel R': 'hotel', 'Hotel Movich': 'movich', 'Hotel Rioverde R': 'rio_verde', 'rio verde': 'rio_verde', 'Río Verde reserva': 'rio_verde', Av9563: null, Mota: null, 'Hotel Sandiego': null };
  const malas = Object.entries(variantes).filter(([k, v]) => (J._leer(`10:00 X (${k})`, DAY).bloques[0].lineas[0].desde || null) !== v);
  t(`las formas que escribe Julián (${Object.keys(variantes).length}): «Aero R», «AeroR», «JMC», «Hotel R», «Hotel Rioverde R»…; un conjunto o un vuelo no`, malas.length === 0, JSON.stringify(malas));
  // Medido sobre los planes reales del jefe (26-oct): 75 líneas así, todas en bloques de llegadas.
  let n = 0, conDl = 0, conCasa = 0;
  for (const f of readdirSync(PLANES).filter((x) => /^plan-.*\.txt$/.test(x))) {
    J._leer(readFileSync(PLANES + f, 'utf8'), '2026-08-10').bloques.forEach((b) => {
      const ds = b.lineas.filter((l) => l.desde); if (!ds.length) return;
      n += ds.length;
      if (b.deadline) conDl++; else if (b.lineas.some((l) => !l.desde && !l.vuelo)) conCasa++;
    });
  }
  t(`en los planes reales: ${n} líneas «(Aero)», «(Hotel)»…, NINGUNA en un bloque con «Deben estar» ni junto a una recogida en casa`, n >= 70 && conDl === 0 && conCasa === 0, JSON.stringify({ n, conDl, conCasa }));

  const C2 = [
    { rid: 'q1', auxId: 'qa1', n: 'Andrea Núñez', type: 'sal', dia: DAY, dl: '17:00', zona: 'Sendai' },
    { rid: 'q2', auxId: 'qa1', n: 'Andrea Núñez', type: 'lle', dia: DAY, dl: '16:20', reserva: 'aero', tierra: true },
    { rid: 'q3', auxId: 'qa3', n: 'Ana Lesmes', type: 'lle', dia: DAY, dl: '16:15', reserva: 'rio_verde', hotel: true, tierra: true },
    { rid: 'q4', auxId: 'qa4', n: 'Paula Londoño', type: 'sal', dia: DAY, dl: '17:20' },
  ];
  const P = (key, nombre, o) => Object.assign({ key, nombre, min: 980, dia: DAY, vuelo: null, deadline: null, lugar: '' }, o);
  const r = J._emparejar([P('a', 'Andrea Núñez', { desde: 'aero', lugar: 'aero r' }), P('b', 'Lesmes', { desde: 'hotel', lugar: 'Hotel R' }), P('c', 'Paula', { desde: 'aero', lugar: 'aero r' })], C2, {});
  t('«Andrea Núñez (aero r)» con salida Y regreso ese día: el REGRESO (de reserva en JMC), sola', r.a.auto && r.a.rid === 'q2', JSON.stringify(r.a));
  t('«Lesmes (Hotel R)»: su regreso de reserva en el hotel', r.b.auto && r.b.rid === 'q3', JSON.stringify(r.b));
  t('«Paula (aero r)» que solo pidió salida: NO se elige sola, su salida queda de opción', !r.c.auto && r.c.opciones.includes('q4'), JSON.stringify(r.c));

  let pub = null;
  const H = await boot({
    publicado: false,
    antes(w) {
      const plan1 = w.Api.listRoutePlanning;
      w.Api.listRoutePlanning = async (tipo, day) => {
        const x = await plan1(tipo, day);
        if (x && (day || DAY) === DAY) {
          const b = { zona: 'Sendai', sector: 'Rionegro', lat: 6.02, lng: -75.4, pax: 1, tel: '', notas: '', vuelo: '', hotel: false, tierra: false, reserva: null };
          x.aux.rQ = Object.assign({}, b, { n: 'Andrea Núñez', type: 'lle', dl: '16:20', reservationId: 'res-Q', auxId: 'aux-andrea', reserva: 'aero', tierra: true });
          x.aux.rR = Object.assign({}, b, { n: 'Andrea Núñez', type: 'sal', dl: '17:00', reservationId: 'res-R', auxId: 'aux-andrea' });
        }
        return x;
      };
      w.Api.adminManualRoutePublish = async (day, blocks) => { pub = JSON.parse(JSON.stringify(blocks)); return { created: blocks.length, kept: 0, removed: 0, skipped: 0, notified: 1, drivers: 1, vueltas: blocks.length }; };
    },
  });
  H.click(H.q('#rv2-julian')); await wait();
  H.type(H.q('#rj-ta'), '16:20 Andrea Núñez (aero r)\n\n17:00 Paula (aero r)');
  H.click(H.q('#rv2-sheet [data-rj="leer"]')); await wait(60);
  const bs = H.qa('#rj-prev .rj-b');
  t('la hoja: «Llegada · 16:20 · Recoge en JMC y los lleva a la casa» (antes decía «Salida»)', /^Llegada · 16:20/.test(txt(bs[0].querySelector('.rj-bh'))) && /Recoge en JMC y los lleva a la casa/.test(txt(bs[0])), txt(bs[0]));
  t('…y elige el regreso de Andrea (res-Q), no su salida', bs[0].querySelector('select').value === 'res-Q', bs[0].querySelector('select').value);
  t('«Paula (aero r)», que solo pidió salida: «Revisa: pidió una salida, no el regreso desde JMC»', /Revisa: pidió una salida, no el regreso desde JMC/.test(txt(bs[1])) && bs[1].querySelector('select').value === '', txt(bs[1]));
  H.pick(bs[1].querySelector('select'), 'res-P'); await wait();
  t('…y si el jefe la elige igual, lo advierte en palabras', /Pidió una salida \(de la casa a JMC\), no el regreso desde JMC/.test(txt(H.qa('#rj-prev .rj-b')[1])), txt(H.qa('#rj-prev .rj-b')[1]));
  H.pick(H.qa('#rj-prev .rj-b')[1].querySelector('select'), ''); await wait();
  H.w.__confirma = true;
  H.click(H.q('#rv2-sheet [data-rj="publicar"]')); await wait(80);
  t('publica la vuelta de Andrea como LLEGADA (de JMC a la casa)', pub && pub.length === 1 && pub[0].type === 'lle' && pub[0].stops[0].reservation_id === 'res-Q' && pub[0].deadline_at === null, JSON.stringify(pub));
  t('sin errores de script', H.errors.length === 0, H.errors.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── D3 · La lista mezclada: terminadas, madrugada, hotel, choques ──');
const PX = await boot({
  antes(w, log) {
    w.Api.adminManualRouteSetTimes = async (id, a) => {
      (log.julian.horas = log.julian.horas || []).push([id, JSON.parse(JSON.stringify(a))]);
      if (w.__horaFalla) throw new Error(w.__horaFalla);
      return w.__horaR || { notified: 1, driver_notified: true };
    };
    w.Api.setVueltaDriver = async () => ({ notified: 0 });
    w.Api.reservePlace = (k) => ({ rio_verde: { key: 'rio_verde', name: 'Hotel Río Verde', short: 'Río Verde', hotel: true }, aero: { key: 'aero', name: 'Aeropuerto JMC', short: 'Aeropuerto', hotel: false } })[k] || null;
    const plan1 = w.Api.listRoutePlanning;
    w.Api.listRoutePlanning = async (tipo, day) => {
      const x = await plan1(tipo, day);
      if (x && x.aux.rO) Object.assign(x.aux.rO, { reserva: 'rio_verde', hotel: true, tierra: true, vuelo: '' });   // Kevin, de reserva en el Río Verde
      if (x) x.drivers = x.drivers.concat([{ id: 'd6', n: 'Lennin Vanegas', c: '#7C5CD6', tel: '' }]);
      return x;
    };
    const sh0 = w.Api.listDriversOnShift;
    w.Api.listDriversOnShift = async (...a) => { const x = await sh0(...a); x.pm = x.pm.concat([{ id: 'd6', n: 'Lennin Vanegas' }]); return x; };
    const pub0 = w.Api.getPublishedPlan;
    w.Api.getPublishedPlan = async (day, o) => {
      const r = await pub0(day, o);
      if (day !== DAY) return r;
      const st = (rid, name, j, at, extra) => Object.assign({ stopId: 'px-' + (rid || name), rid, order: j + 1, status: 'pending', etaAt: at ? `${at}:00-05:00` : null, name, lat: 6.02, lng: -75.40 }, extra || {});
      const base = { pool: true, manualDay: DAY, nota: '', vehicleId: null, planCar: null, carro: 'Carro', placa: null, cap: 4, delegated: false, atendidas: [] };
      let pool = [
        // Jorge la tomó y se le cruza con su V-01 del tablero (recoge a las 5:35, llega 6:39).
        Object.assign({}, base, { id: 'pool-x1', type: 'sal', status: 'planned', startAt: `${DAY}T05:40:00-05:00`, deadlineAt: `${DAY}T06:20:00-05:00`, driverProfileId: 'd1', conductor: 'Jorge Pérez',
          pendientes: [st('res-N', 'Manuela Franco', 0, `${DAY}T05:40`), st(null, 'Primo de Manuela', 1, `${DAY}T05:45`, { guest: true })] }),
        // Terminada: va abajo, con las terminadas.
        Object.assign({}, base, { id: 'pool-x2', type: 'sal', status: 'completed', startAt: `${DAY}T03:30:00-05:00`, deadlineAt: `${DAY}T04:10:00-05:00`, driverProfileId: 'd2', conductor: 'Luis Arango',
          fin: { estado: 'ok', motivos: [], faltan: 0, at: '04:05' }, pendientes: [], atendidas: [st(null, 'Tío de Laura', 0, `${DAY}T03:30`, { guest: true, status: 'dropped_off' })] }),
        // La madrugada siguiente que Julián pegó con este día.
        Object.assign({}, base, { id: 'pool-x3', type: 'sal', status: 'planned', startAt: `${SIG}T00:20:00-05:00`, deadlineAt: `${SIG}T00:50:00-05:00`, driverProfileId: null, conductor: 'Sin conductor',
          pendientes: [st(null, 'Pepe', 0, `${SIG}T00:20`, { guest: true })] }),
        // Kevin, de reserva en el Hotel Río Verde: la llegada sale del hotel. Nadie la ha tomado.
        Object.assign({}, base, { id: 'pool-x4', type: 'lle', status: 'planned', startAt: `${DAY}T15:40:00-05:00`, deadlineAt: null, driverProfileId: null, conductor: 'Sin conductor',
          pendientes: [st('res-O', 'Kevin Uribe', 0, null)] }),
        // Lennin (en el horario de la tarde, sin vueltas del tablero) tomó dos que se cruzan.
        Object.assign({}, base, { id: 'pool-x5', type: 'sal', status: 'planned', startAt: `${DAY}T13:00:00-05:00`, deadlineAt: `${DAY}T13:40:00-05:00`, driverProfileId: 'd6', conductor: 'Lennin Vanegas',
          pendientes: [st(null, 'Pepa', 0, `${DAY}T13:00`, { guest: true })] }),
        Object.assign({}, base, { id: 'pool-x6', type: 'sal', status: 'planned', startAt: `${DAY}T13:20:00-05:00`, deadlineAt: `${DAY}T13:55:00-05:00`, driverProfileId: 'd6', conductor: 'Lennin Vanegas',
          pendientes: [st(null, 'Pepita', 0, `${DAY}T13:20`, { guest: true })] }),
      ];
      if (w.__sinLennin) pool = pool.filter((v) => v.driverProfileId !== 'd6');
      return { day, vueltas: r.vueltas.concat(pool), publicado: true };
    };
  },
});
{
  const { w, q, qa, click, log, T } = PX;
  const pegada = (id) => q(`#rv2-list .rv2-row--julian[data-julian="${id}"]`);
  const filas = () => qa('#rv2-list .rv2-row').filter((r) => !r.closest('.rv2-hechas'));
  const hora = (el) => el && txt(el.closest('.rv2-gwrap').querySelector('.rv2-hour'));
  // El orden del tablero desde los pendientes del 26-oct: la PRIMERA hora que se lee.
  t('la de Jorge (recoge 5:40) va en «05:00 – 06:00», detrás de V-01 (recoge 5:35): en el orden de la primera hora, como el tablero', /^05:00 – 06:00 · 2 vueltas/.test(hora(pegada('pool-x1'))) && pegada('pool-x1').previousElementSibling && pegada('pool-x1').previousElementSibling.dataset.id === 'V-01·V2', hora(pegada('pool-x1')));
  t('la terminada (3:30) no está en la lista: abajo, con la del tablero («✓ 2 vueltas terminadas»)', !pegada('pool-x2') && /✓ 2 vueltas terminadas/.test(txt(q('.rv2-hechas'))), txt(q('.rv2-hechas')));
  click(q('[data-act="hechas"]')); await wait(20);
  t('…y al abrirlas sale en verde, «Terminada 04:05» (como en el tablero), sin botones', pegada('pool-x2') && pegada('pool-x2').closest('.rv2-hechas') && pegada('pool-x2').dataset.fin === 'ok' && /Terminada 04:05/.test(txt(pegada('pool-x2').querySelector('.when'))) && !pegada('pool-x2').querySelector('button'), pegada('pool-x2') && txt(pegada('pool-x2')));
  click(q('[data-act="hechas"]')); await wait(20);
  const ult = filas()[filas().length - 1];
  t('la madrugada siguiente (0:20 del 13) va al final: «00:00 – 01:00 · después de medianoche»', ult && ult.dataset.julian === 'pool-x3' && /^00:00 – 01:00 · después de medianoche · 1 vuelta/.test(hora(ult)), hora(ult));
  t('…con «Pepe (sin cuenta)»', /Pepe \(sin cuenta\)/.test(txt(pegada('pool-x3'))));
  const x4 = pegada('pool-x4');
  t('la llegada de Kevin (de reserva en el Río Verde): «Llegada», «Sale del Hotel Río Verde → casas», «Disponible · nadie la ha tomado»',
    x4 && /Llegada/.test(txt(x4.querySelector('.rv2-pill'))) && /Sale del Hotel Río Verde → casas/.test(txt(x4)) && /Disponible · nadie la ha tomado/.test(txt(x4)) && x4.dataset.st === 'libre', x4 && txt(x4));
  t('…con «Cambiar hora», «Asignar conductor» y «Delegar»', /Cambiar hora/.test(txt(x4)) && /Asignar conductor/.test(txt(x4)) && /Delegar/.test(txt(x4)));
  t('Manuela y Kevin (van en lo pegado) no salen «sin carro»', !/Manuela Franco no tiene carro|Kevin Uribe no tiene carro/.test(txt(q('#rv2-avisos'))), txt(q('#rv2-avisos')));
  const avs = qa('#rv2-avisos li[data-k="drv"]');
  const jorge = avs.find((li) => /Jorge Pérez/.test(txt(li)));
  t('Avisos: «Jorge Pérez tiene dos vueltas a la vez · V-01 de las 05:35 (hasta las 06:39) y la de Julián de las 05:40»', jorge && /Jorge Pérez tiene dos vueltas a la vez/.test(txt(jorge)) && /V-01 de las 05:35 \(hasta las 06:39\) y la de Julián de las 05:40/.test(txt(jorge)) && avs.filter((li) => /Jorge/.test(txt(li))).length === 1, avs.map((li) => txt(li)).join(' | '));
  t('…y «Cambiar» abre la del TABLERO (V-01 · vuelta 2), que es la que se puede mover', jorge && jorge.querySelector('[data-act="assign"]') && jorge.querySelector('[data-act="assign"]').dataset.id === 'V-01·V2', jorge && jorge.innerHTML);
  const len = avs.find((li) => /Lennin Vanegas/.test(txt(li)));
  t('dos pegadas que se cruzan: «Lennin Vanegas tiene dos vueltas a la vez · la de Julián de las 13:00 (hasta las 13:40) y la de Julián de las 13:20»', len && /la de Julián de las 13:00 \(hasta las 13:40\) y la de Julián de las 13:20/.test(txt(len)), len && txt(len));
  t('…con «Ver», que lleva a la vuelta pegada en la lista', len && len.querySelector('[data-act="verjulian"]') && len.querySelector('[data-act="verjulian"]').dataset.ra === 'pool-x6');
  click(len.querySelector('[data-act="verjulian"]')); await wait(20);
  t('…y la marca un momento', pegada('pool-x6').classList.contains('is-flash'));
  const libres = () => txt(q('#rv2-drivers [data-k="libres"]')) || '';
  t('Lennin, que solo tiene vueltas pegadas, NO sale «en turno, sin vueltas»', !/Lennin/.test(libres()), libres());
  w.__sinLennin = true; await PX.V2().cargarDia(DAY); await wait(120);
  t('…(sin ellas sí sale: la prueba ve la diferencia)', /También en turno, sin vueltas: .*Lennin Vanegas/.test(libres()), libres());
  w.__sinLennin = false; await PX.V2().cargarDia(DAY); await wait(120);
  const v4 = PX.V2().pegadas().find((v) => v.id === 'pool-x4');
  t('el día SOLO de Julián (diaHTML) también trae «Cambiar hora»', v4 && /data-rj-hora="pool-x4"/.test(PX.J().diaHTML([v4], DAY, 0)));
  t('sin errores de script', PX.errors.length === 0, PX.errors.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
// Audio de los jefes, 26-oct 4:22 p. m.: «…o tener la opción de que uno seleccione
// una ruta como tal y le deje cambiar las horas».
console.log('\n── D4 · «Cambiar hora» (0145) ──');
{
  const { w, q, qa, click, log } = PX;
  const pegada = (id) => q(`#rv2-list .rv2-row--julian[data-julian="${id}"]`);
  const ins = () => qa('#rv2-sheet .rj-h-in');
  const poner = (el, v) => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
  log.julian.horas = [];
  click(pegada('pool-x1').querySelector('[data-rj-hora]')); await wait(20);
  t('abre «Cambiar hora · salida de las 5:40» con una hora por recogida y el «Deben estar»', /Cambiar hora · salida de las 5:40/.test(txt(q('#rv2-shTitle'))) && ins().map((x) => x.value).join() === '05:40,05:45,06:20', ins().map((x) => x.value).join() + ' · ' + txt(q('#rv2-shTitle')));
  t('…con los nombres («Primo de Manuela (sin cuenta)»)', /Manuela Franco/.test(txt(q('#rv2-sheet'))) && /Primo de Manuela \(sin cuenta\)/.test(txt(q('#rv2-sheet'))));
  poner(ins()[0], '05:50');
  t('mover la primera a 5:50 corre la otra y el «Deben estar» igual (5:55 · 6:30)', ins().map((x) => x.value).join() === '05:50,05:55,06:30', ins().map((x) => x.value).join());
  poner(ins()[2], '06:40'); poner(ins()[0], '06:00');
  t('lo que se tocó a mano ya no se corre: 6:00 · 6:05 · «Deben estar» 6:40 (puesto a mano)', ins().map((x) => x.value).join() === '06:00,06:05,06:40', ins().map((x) => x.value).join());
  poner(ins()[2], '05:50');
  click(q('#rv2-sheet [data-rj="hora-ok"]')); await wait(40);
  t('«Deben estar» antes de la última recogida: lo dice y no llama a la base', /«Deben estar» \(5:50\) queda antes de la última recogida \(6:05\)/.test(txt(q('#rj-h-msg'))) && log.julian.horas.length === 0, txt(q('#rj-h-msg')));
  poner(ins()[2], '06:40');
  const antes = log.publicados.length;
  click(q('#rv2-sheet [data-rj="hora-ok"]')); await wait(150);
  const h1 = log.julian.horas[0];
  t('guarda ESA vuelta: cada parada con su hora de Colombia y el «Deben estar»', h1 && h1[0] === 'pool-x1' && JSON.stringify(h1[1]) === JSON.stringify({ stops: [{ stop_id: 'px-res-N', at: `${DAY}T06:00:00-05:00` }, { stop_id: 'px-Primo de Manuela', at: `${DAY}T06:05:00-05:00` }], deadline: `${DAY}T06:40:00-05:00` }), JSON.stringify(h1));
  t('el aviso: «Salida de las 5:40 ahora a las 6:00 · avisamos a 1 tripulante y al conductor.»', PX.toastV2() === 'Salida de las 5:40 ahora a las 6:00 · avisamos a 1 tripulante y al conductor.', PX.toastV2());
  t('…la hoja se cierra y el día se vuelve a leer', q('#rv2-sheet').hidden && log.publicados.length > antes);
  click(pegada('pool-x4').querySelector('[data-rj-hora]')); await wait(20);
  t('la llegada (Kevin): una sola hora, cuando sale el carro (15:40)', ins().length === 1 && ins()[0].value === '15:40' && /Kevin Uribe/.test(txt(q('#rv2-sheet'))) && /llegada de las 15:40/.test(txt(q('#rv2-shTitle'))), ins().map((x) => x.value).join());
  poner(ins()[0], '16:00');
  click(q('#rv2-sheet [data-rj="hora-ok"]')); await wait(150);
  t('…guarda { start } con la hora nueva', JSON.stringify(log.julian.horas[1]) === JSON.stringify(['pool-x4', { start: `${DAY}T16:00:00-05:00` }]), JSON.stringify(log.julian.horas[1]));
  click(pegada('pool-x3').querySelector('[data-rj-hora]')); await wait(20);
  poner(ins()[0], '23:55');
  click(q('#rv2-sheet [data-rj="hora-ok"]')); await wait(150);
  t('pasada la medianoche: 0:20 del 13 → «23:55» es del 12, y el «Deben estar» corre a 0:25 del 13', JSON.stringify(log.julian.horas[2]) === JSON.stringify(['pool-x3', { stops: [{ stop_id: 'px-Pepe', at: `${DAY}T23:55:00-05:00` }], deadline: `${SIG}T00:25:00-05:00` }]), JSON.stringify(log.julian.horas[2]));
  w.__horaFalla = 'Para cambiar la hora de una vuelta falta la actualización 0145 de la base. Mientras tanto, usa «Volver a pegar».';
  click(pegada('pool-x1').querySelector('[data-rj-hora]')); await wait(20);
  poner(ins()[0], '06:10');
  click(q('#rv2-sheet [data-rj="hora-ok"]')); await wait(80);
  t('si la base no la tiene (sin 0137), lo dice en la hoja y se puede reintentar', /No se pudo: Para cambiar la hora de una vuelta falta la actualización 0145/.test(txt(q('#rj-h-msg'))) && !q('#rv2-sheet [data-rj="hora-ok"]').disabled && !q('#rv2-sheet').hidden, txt(q('#rj-h-msg')));
  w.__horaFalla = null; w.__horaR = { unchanged: true, notified: 0 };
  click(q('#rv2-sheet [data-rj="hora-ok"]')); await wait(150);
  t('si no cambió nada: «No cambió ninguna hora.»', PX.toastV2() === 'No cambió ninguna hora.', PX.toastV2());
  w.__horaR = null;
  delete w.Api.adminManualRouteSetTimes;
  await PX.V2().cargarDia(DAY); await wait(120);
  t('sin la función en la app (versión vieja de api.js) no sale el botón', !q('#rv2-list [data-rj-hora]'));
  t('sin errores de script', PX.errors.length === 0, PX.errors.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── 0133 · Publicar con un pasajero sin cuenta (Pepe · Kriss) ──');
{
  const G = await boot({
    antes(w, log) {
      w.Api.adminManualRoutePublish = async (day, blocks, aliases) => {
        log.julian.publicar.push({ day, blocks: JSON.parse(JSON.stringify(blocks)), aliases });
        return { created: blocks.length, kept: 0, removed: 0, skipped: 0, notified: 0, drivers: 3, vueltas: blocks.length };
      };
      w.Api.listResidencesAdmin = async () => [{ id: 'res-mota', name: 'Mota', is_active: true }, { id: 'res-campus', name: 'Campus Reservado', is_active: true }];
    },
  });
  const { w, q, qa, click, type, pick, log } = G;
  click(q('#rv2-julian')); await wait();
  type(q('#rj-ta'), TEXTO + '\n\n8:50 Kriss (Campus reservado)');
  click(q('#rv2-sheet [data-rj="leer"]')); await wait(60);
  const fila = (nombre) => qa('#rj-prev .rj-p').find((p) => txt(p.querySelector('.rj-w')).startsWith(nombre));
  t('Kriss (Campus reservado): «Va sin cuenta» y lo ubica en el conjunto «Campus Reservado»', fila('Kriss') && fila('Kriss').dataset.st === 'guest' && /Sin cuenta: va en la ruta · Campus Reservado/.test(txt(fila('Kriss'))), fila('Kriss') && txt(fila('Kriss')));
  pick(fila('Kevin').querySelector('select'), 'res-O'); await wait();
  const pub = q('#rv2-sheet [data-rj="publicar"]');
  t('el botón cuenta a los sin cuenta aparte («· 2 sin cuenta»)', /Publicar y avisar a 10 · 2 sin cuenta/.test(txt(pub)), txt(pub));
  G.confirms.length = 0; w.__confirma = true;
  click(pub); await wait(80);
  t('la confirmación separa tripulantes y sin cuenta (a ellos no les llega nada)', /10 tripulantes y 2 sin cuenta/.test(G.confirms[0] || '') && /A los sin cuenta no les llega nada/.test(G.confirms[0] || ''), G.confirms[0]);
  const B = (log.julian.publicar[0] || {}).blocks || [];
  const g = B.flatMap((b) => b.stops.filter((x) => x.guest).map((x) => [b.type, x]));
  t('van 8 vueltas: Pepe y Kriss como paradas sin cuenta', B.length === 8 && g.length === 2, JSON.stringify(B.map((b) => b.stops.length)));
  const pepe = g.find((x) => x[1].guest.name === 'Pepe'), kriss = g.find((x) => x[1].guest.name === 'Kriss');
  t('Pepe: salida, en Mota (el conjunto), a las 8:20, sin reserva', pepe && pepe[0] === 'sal' && pepe[1].guest.place === 'Mota' && pepe[1].guest.residence_id === 'res-mota' && pepe[1].at === `${DAY}T08:20:00-05:00` && !('reservation_id' in pepe[1]), JSON.stringify(pepe));
  t('Kriss: el lugar como lo escribió Julián y el conjunto del catálogo', kriss && kriss[1].guest.place === 'Campus reservado' && kriss[1].guest.residence_id === 'res-campus', JSON.stringify(kriss));
  t('sin errores de script', G.errors.length === 0, G.errors.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── E · El Excel del día ──');
{
  const E = await boot({
    antes(w) {
      w.eval(read('vendor/exceljs-4.4.0.min.js'));
      w.URL.createObjectURL = () => 'blob:prueba';
      w.URL.revokeObjectURL = () => {};
      w.HTMLAnchorElement.prototype.click = function () { (w.__descargas = w.__descargas || []).push(this.download); };
      // La madrugada siguiente: una a las 00:30 (va) y otra a las 05:00 (no).
      const plan = w.Api.listRoutePlanning;
      w.Api.listRoutePlanning = async (tipo, day) => {
        if (day === SIG) return { day: SIG, aux: {
          m1: { reservationId: 'res-m1', auxId: 'aux-m1', n: 'Mónica Madrugada', type: 'sal', dl: '00:30', zona: 'Mota', sector: 'Rionegro', tel: '3009990001' },
          m2: { reservationId: 'res-m2', auxId: 'aux-m2', n: 'Otro Día', type: 'sal', dl: '05:00', zona: 'Mota', sector: 'Rionegro', tel: '' } }, cars: [], drivers: [] };
        return plan(tipo, day);
      };
    },
  });
  const r = await E.J().excel();
  t('descarga «PROGRAMACIÓN RENDIO 2026-10-12.xlsx»', r && (E.w.__descargas || [])[0] === `PROGRAMACIÓN RENDIO ${DAY}.xlsx`, JSON.stringify(E.w.__descargas));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(r.buf));
  const ws = wb.getWorksheet('RESPUESTAS');
  const cab = ws.getRow(1).values.slice(1);
  t('hoja RESPUESTAS con las columnas del Formulario (+ conjunto, sector y teléfono)', JSON.stringify(cab) === JSON.stringify(['NOMBRE Y APELLIDO', 'FECHA', 'HORA DE PRESENTACIÓN', 'HORA DE LLEGADA', 'VUELO DE LLEGADA', '¿ES UNA RESERVA?', '¿ES UNA PERNOCTA?', 'CONJUNTO', 'SECTOR', 'TELÉFONO']), JSON.stringify(cab));
  const filas = [];
  ws.eachRow((row, i) => { if (i > 1) filas.push(row.values.slice(1).map((v) => (v == null ? '' : String(v)))); });
  t('17 filas: los 16 del día + la madrugada de las 00:30 (la de las 05:00 del día siguiente no)', filas.length === 17 && filas.some((f) => f[0] === 'Mónica Madrugada') && !filas.some((f) => f[0] === 'Otro Día'), String(filas.length));
  const laura = filas.find((f) => f[0] === 'Laura Gómez');
  t('una salida: presentación 05:00, sin llegada, con conjunto, sector y teléfono', laura && laura.join('|') === 'Laura Gómez|12/10/2026|05:00|||NO|NO|Olivar Apartamentos|Llanogrande|3001110001', laura && laura.join('|'));
  const nat = filas.find((f) => f[0] === 'Natalia Duque');
  t('una llegada: hora de llegada 15:00 y vuelo AV9412', nat && nat[2] === '' && nat[3] === '15:00' && nat[4] === 'AV9412', nat && nat.join('|'));
  t('la madrugada va con SU fecha (13/10) y de última', filas.at(-1)[0] === 'Mónica Madrugada' && filas.at(-1)[1] === '13/10/2026', filas.at(-1).join('|'));
  t('en orden de hora', filas[0][2] === '05:00' && filas.findIndex((f) => f[0] === 'Natalia Duque') > filas.findIndex((f) => f[0] === 'Felipe Vélez'));
  t('el aviso dice cuántas filas (hasta el corte de las 7:40 p. m.)', /Excel del lun 12 oct: 17 filas \(17 pedidos hasta las 7:40 p\. m\.\)\.$/.test(E.toastV2() || ''), E.toastV2());
  t('sin Late, no hay hoja LATE', !wb.getWorksheet('LATE'));

  // 0130 (lista de los jefes, 26-oct): lo pedido después del corte (la víspera,
  // 7:40 p. m.) no va en RESPUESTAS: va en la hoja LATE con la hora del pedido.
  // Se usan las funciones de verdad de api.js (el corte) con un sb que no responde.
  const H = (() => { const d = new JSDOM('<!doctype html>', { runScripts: 'outside-only', url: 'http://localhost/' }); d.window.RENDIO_CONFIG = {}; d.window.sb = { from: () => ({}), auth: {} }; d.window.eval(read('api.js')); return d.window.Api; })();
  E.w.Api.getRequestCutoff = async () => ({ corte: 1180, noche: 120, enBase: true });
  E.w.Api.isLateRequest = H.isLateRequest; E.w.Api.crewRequestDeadline = H.crewRequestDeadline; E.w.Api.hm12 = H.hm12;
  const plan2 = E.w.Api.listRoutePlanning;
  E.w.Api.listRoutePlanning = async (tipo, day) => {
    const r = await plan2(tipo, day);
    if (r && r.aux) Object.values(r.aux).forEach((a) => {
      if (a.n === 'Mónica Madrugada') Object.assign(a, { at: '2026-10-13T00:30:00-05:00', createdAt: '2026-10-11T21:05:00-05:00' });   // del lunes 12: corte dom 11 7:40 p. m.
      if (a.n === 'Laura Gómez') Object.assign(a, { at: '2026-10-12T05:00:00-05:00', createdAt: '2026-10-11T19:39:00-05:00' });        // a tiempo
    });
    return r;
  };
  E.T().rt.day = null;   // que el Excel vuelva a leer el día con las fechas de pedido
  const r2 = await E.J().excel();
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(Buffer.from(r2.buf));
  const f2 = [];
  wb2.getWorksheet('RESPUESTAS').eachRow((row, i) => { if (i > 1) f2.push(row.values.slice(1).map((v) => (v == null ? '' : String(v)))); });
  t('0130: RESPUESTAS sin la Late (16 filas; Laura, pedida 7:39 p. m., sí va)', f2.length === 16 && !f2.some((f) => f[0] === 'Mónica Madrugada') && f2.some((f) => f[0] === 'Laura Gómez'), String(f2.length));
  const wl = wb2.getWorksheet('LATE');
  const fl = [];
  if (wl) wl.eachRow((row, i) => { if (i > 1) fl.push(row.values.slice(1).map((v) => (v == null ? '' : String(v)))); });
  const cabL = wl ? wl.getRow(1).values.slice(1) : [];
  t('0130: hoja LATE con las mismas columnas + «PIDIÓ»', wl && cabL.length === 11 && cabL[0] === 'NOMBRE Y APELLIDO' && cabL[10] === 'PIDIÓ', JSON.stringify(cabL));
  t('0130: en LATE va Mónica (madrugada, pidió el dom 11 a las 9:05 p. m.)', fl.length === 1 && fl[0][0] === 'Mónica Madrugada' && /9:05/.test(fl[0][10]) && /p\. m\./.test(fl[0][10]), JSON.stringify(fl));
  t('0130: el aviso cuenta las dos cosas', /16 filas \(16 pedidos hasta las 7:40 p\. m\.\) · 1 Late en su hoja\./.test(E.toastV2() || ''), E.toastV2());
  // El aviso de las 7:40 p. m. abre #/rutas?excel=día → ofrecer(día).
  const nDesc = (E.w.__descargas || []).length;
  await E.J().ofrecer(DAY); await wait(40);
  t('0130: el aviso abre la hoja «Excel del lun 12 oct» y lo descarga solo', /Excel del lun 12 oct/.test(txt(E.q('#rv2-shTitle'))) && E.w.__descargas.length === nDesc + 1, txt(E.q('#rv2-shTitle')) + ' · ' + E.w.__descargas.length);
  t('0130: la hoja explica el corte y dice qué salió', /hasta las 7:40 p\. m\. de la víspera/.test(txt(E.q('#rv2-sheet'))) && /Listo: 16 filas · 1 Late en su hoja/.test(txt(E.q('#rj-xl-msg'))), txt(E.q('#rj-xl-msg')));
  E.click(E.q('#rv2-sheet [data-rj="xl"]')); await wait(60);
  t('0130: «Descargar» lo baja otra vez', E.w.__descargas.length === nDesc + 2);
  t('0130: un día mal escrito no hace nada', (await E.J().ofrecer('mañana')) === null);
  t('sin errores de script', E.errors.length === 0, E.errors.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── F · La madrugada que Julián pegó el día anterior ──');
{
  const F = await boot({
    antes(w) {
      const pub0 = w.Api.getPublishedPlan;
      w.Api.getPublishedPlan = async (day, o) => {
        const r = await pub0(day, o);
        if (day !== DAY) return r;
        return { ...r, vueltas: r.vueltas.concat([{ id: 'pool-ant', type: 'sal', status: 'planned', startAt: `${DAY}T00:40:00-05:00`, pool: true, manualDay: '2026-10-11',
          vehicleId: null, carro: 'Carro', placa: null, cap: 4, driverProfileId: null, conductor: 'Sin conductor',
          pendientes: [{ stopId: 'pa', rid: 'res-N', order: 1, status: 'pending', name: 'Manuela Franco' }], atendidas: [] }]) };
      };
    },
  });
  const { T, q, qa } = F;
  t('el día sigue con el tablero (esa vuelta es de la ruta del 11)', !q('#rv2-list .rj-dia') && T().rt.manualDia === false && qa('#rv2-list .rv2-row').length > 0);
  t('Manuela (ya va en la vuelta de Julián del 11) sale del tablero del 12: no se rutea dos veces', !Object.values(T().rt.aux).some((a) => a.reservationId === 'res-N') && Object.keys(T().rt.aux).length === 15, String(Object.keys(T().rt.aux).length));
  t('sin errores de script', F.errors.length === 0, F.errors.join(' | '));
}

t('sin errores de script (instancia base)', base.errors.length === 0, base.errors.join(' | '));
console.log(`\n${ok}/${ok + bad} pasaron${bad ? ` · ${bad} FALLARON` : ''}`);
console.log('NO cubierto: la base (_verify-0125.mjs), el layout real (ancho de la hoja, el select en un teléfono), la descarga real del archivo, los push reales y la app del conductor (driver-rutas.js: _smoke-rx-admin-coord-dom).');
process.exit(bad ? 1 : 0);
