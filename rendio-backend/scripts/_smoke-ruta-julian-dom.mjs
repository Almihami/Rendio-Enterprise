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
//   D) el día con la ruta de Julián: vueltas libres / tomadas / en curso, el
//      tablero bloqueado (Publicar, Re-optimizar, rtSavePlan), «Volver a pegar»
//      y «Quitar la ruta»;
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
      // El tablero tenía esas personas: 0125 las sacó; quedan 2 vueltas suyas.
      return { day, vueltas: r.vueltas.slice(0, 2).concat(pool), publicado: true };
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
  t('«Pepe (Mota)»: no pidió por la app → «Revisa: no la encontré» y la opción «no se avisa»', quien('Pepe') === '' && /no la encontré/.test(txt(fila('Pepe'))) && /No pidió por la app \(no se avisa\)/.test(txt(fila('Pepe').querySelector('option'))));
  const sum = () => txt(q('#rj-prev .rj-sum'));
  t('el resumen: 7 vueltas · 9 emparejados · 2 sin pedido', /7 vueltas · 9 emparejados/.test(sum()) && /2 sin pedido en la app/.test(sum()), sum());
  t('…y quién pidió por la app y NO está en la ruta (Valentina, Sergio, Paula, Mateo, Juliana, Manuela, Kevin)',
    ['Valentina (sale 06:00)', 'Sergio (sale 07:40)', 'Paula', 'Mateo', 'Juliana', 'Manuela (sale 09:10)', 'Kevin (llega 15:05)'].every((x) => sum().includes(x)), sum());
  const pub = () => q('#rv2-sheet [data-rj="publicar"]');
  t('«Publicar y avisar a 9», encendido', !pub().disabled && txt(pub()) === 'Publicar y avisar a 9', txt(pub()));
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
  t('avisa que además quedan 2 vueltas del tablero ese día', /Además hay 2 vueltas del tablero/.test(txt(dia)));
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
