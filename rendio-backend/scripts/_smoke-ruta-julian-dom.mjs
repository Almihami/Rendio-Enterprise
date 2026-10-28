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
//      aprende) y «Pasar al tablero» (27-oct-2026): cada bloque es una vuelta del
//      tablero con las horas del jefe, y Publicar las manda como siempre;
//   P) meterPegado: carros que no se cruzan, un carro más si no caben, Deshacer y
//      la madrugada siguiente que entra al abrir su día;
//   (D–D4 siguen probando las vueltas pegadas VIEJAS, pool de 0125, que siguen en la base.)
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
  t('«Pasar al tablero» empieza apagado', q('#rv2-sheet [data-rj="publicar"]').disabled === true && txt(q('#rv2-sheet [data-rj="publicar"]')) === 'Pasar al tablero');
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
    quien('Kevin') === '' && fila('Kevin').dataset.st === 'falta' && fila('Kevin').querySelector('optgroup[label="Más probables"] option').value === 'res-O' && /Hay pedidos parecidos: elige quién es/.test(txt(fila('Kevin'))), fila('Kevin') && fila('Kevin').innerHTML.slice(0, 200));
  // 0133 (lista de los jefes, 26-oct): quien no se parece a nadie y trae lugar VA sin cuenta.
  t('0133: «Pepe (Mota)»: no pidió y no se parece a nadie → «Va sin cuenta» por defecto (en la ruta, sin aviso)', quien('Pepe') === '__guest' && fila('Pepe').dataset.st === 'guest' && /Sin la app: va en la ruta/.test(txt(fila('Pepe'))) && /No le llegan avisos/.test(txt(fila('Pepe'))), fila('Pepe') && txt(fila('Pepe')));
  {
    const ops = [...fila('Pepe').querySelectorAll('select > option')].map((o) => [o.value, txt(o)]);
    t('27-oct (2ª): arriba de la lista, «Va en la ruta (tiene la app y le llega aviso)» y «Va, pero no tiene la app (no le llegan avisos)»',
      ops[0] && ops[0][0] === '__app' && ops[0][1] === 'Va en la ruta (tiene la app y le llega aviso)' && ops[1] && ops[1][0] === '__guest' && ops[1][1] === 'Va, pero no tiene la app (no le llegan avisos)', JSON.stringify(ops.slice(0, 3)));
    t('…y «No va en esta ruta» ya no existe (al actualizar, quien la elegía no subía)', !qa('#rj-prev option').some((o) => o.value === '__nova' || /No va/.test(o.textContent)));
  }
  t('27-oct: quien no está elegido arranca en «— Elige quién es —» (no en «no va» callado)', fila('Kevin').querySelector('select option[value=""]') && /Elige quién es/.test(fila('Kevin').querySelector('select option[value=""]').textContent) && !fila('Pepe').querySelector('select option[value=""]'));
  const sum = () => txt(q('#rj-prev .rj-sum'));
  t('el resumen: 7 vueltas · 9 emparejados · 1 sin cuenta (Pepe) · 1 sin elegir (Kevin)', /7 vueltas · 9 emparejados/.test(sum()) && /1 sin la app: van en la ruta, sin aviso/.test(sum()) && /1 sin elegir: elige quién es \(o «Va, pero no tiene la app»\) antes de pasar al tablero/.test(sum()), sum());
  t('…y quién pidió por la app y NO está en la ruta (Valentina, Sergio, Paula, Mateo, Juliana, Manuela, Kevin)',
    ['Valentina (sale 06:00)', 'Sergio (sale 07:40)', 'Paula', 'Mateo', 'Juliana', 'Manuela (sale 09:10)', 'Kevin (llega 15:05)'].every((x) => sum().includes(x)), sum());
  const pub = () => q('#rv2-sheet [data-rj="publicar"]');
  t('27-oct: con alguien sin elegir NO deja pasar al tablero: «Falta elegir 1»', pub().disabled && txt(pub()) === 'Falta elegir 1', txt(pub()));
  t('la vuelta con «Deben estar … Va a hotel» muestra la nota', /Deben estar 7:40/.test(txt(qa('#rj-prev .rj-b')[2])) && /Va a hotel/.test(txt(qa('#rj-prev .rj-b')[2])));

  pick(fila('Pepe').querySelector('select'), 'res-A'); await wait();
  t('elegir a Laura también para Pepe: «Está dos veces» en los dos y Publicar se apaga', /Está dos veces/.test(txt(fila('Pepe'))) && /Está dos veces/.test(txt(fila('Laura G'))) && pub().disabled && /1 repetidos|2 repetidos/.test(sum()), sum());
  pick(fila('Pepe').querySelector('select'), '__app'); await wait();
  t('27-oct (2ª): «Va en la ruta (tiene la app)» para Pepe, que no pidió: no inventa a nadie, lo dice y pide elegir', fila('Pepe').dataset.st === 'falta' && quien('Pepe') === '' && /No encontré a «Pepe» ni en los pedidos del día ni entre los tripulantes con cuenta/.test(txt(fila('Pepe'))) && /Va, pero no tiene la app/.test(txt(fila('Pepe'))), txt(fila('Pepe')));
  pick(fila('Pepe').querySelector('select'), '__guest'); await wait();
  t('…y de vuelta a «Va, pero no tiene la app»: va en la ruta, sin aviso', fila('Pepe').dataset.st === 'guest' && /1 sin la app/.test(sum()), sum());
  pick(fila('Andres').querySelector('select'), 'res-O'); await wait();
  t('elegir una LLEGADA (Kevin) en una vuelta de salidas: lo advierte («va en otra vuelta»)', /Es una llegada: va en otra vuelta/.test(txt(fila('Andres'))));
  pick(fila('Andres').querySelector('select'), 'res-B'); await wait();
  t('…y al volver a Andrés se quita', !/otra vuelta/.test(txt(fila('Andres'))));
  pick(fila('Kevin').querySelector('select'), '__app'); await wait();
  t('27-oct (2ª): «Va en la ruta (tiene la app)» para Kevin: toma su pedido (el único Kevin del día)', quien('Kevin') === 'res-O', quien('Kevin'));
  t('Kevin elegido a mano: «Elegido a mano: se aprende» y «Pasar al tablero · 10 y 1 sin cuenta»', /se aprende/.test(txt(fila('Kevin'))) && !pub().disabled && txt(pub()) === 'Pasar al tablero · 10 y 1 sin cuenta', txt(pub()));
  const modo = () => (q('#rj-prev input[name="rj-modo"]:checked') || {}).value;
  t('27-oct (2ª): el texto trae a la mayoría de lo que sigue por mover → «Rearmar el día con esta ruta», ya marcado', modo() === 'rearmar' && /Rearmar el día con esta ruta/.test(txt(q('#rj-prev .rj-modo'))) && /Solo cambiar estas vueltas/.test(txt(q('#rj-prev .rj-modo'))), modo());
  t('…y dice cuántos que pidieron por la app quedan sin carro (Valentina, Sergio, Mateo, Juliana, Manuela)', /5 pedidos que no están en el texto quedan sin carro \(en Avisos\)/.test(txt(q('#rj-prev .rj-modo'))), txt(q('#rj-prev .rj-modo')));
  t('…y ya no sale en «no están en tu ruta»', !/Kevin \(llega/.test(sum()));

  // 27-oct-2026: PEGAR = LLENAR EL TABLERO. Nada de otra clase de vuelta: cada
  // bloque entra como una vuelta del tablero, con las horas del jefe, y se
  // publica con la hoja de siempre.
  // Lo que antes iba a admin_manual_route_publish (para D), sin el sin cuenta (Pepe), como cuando «no iba».
  const bloquesViejos = JJ()._bloques().map((b) => Object.assign({}, b, { stops: b.stops.filter((x) => x.reservation_id) })).filter((b) => b.stops.length);
  const aprendidos = []; w.Api.saveCrewAliases = async (a) => { aprendidos.push(JSON.parse(JSON.stringify(a))); return a.length; };
  const seguidos = []; C.w.renderVuelos = { seguirDesdeTexto: async (texto, dia) => { seguidos.push([texto, dia]); return 2; } };   // Vuelos (admin-vuelos.js), lista de los jefes 26-oct
  C.confirms.length = 0;
  const savedAntes = log.saved.length;
  click(pub()); await wait(80);
  const R = C.T().rt;
  const laneCon = (k) => R.lanes.find((l) => (R.order[l.id] || []).includes(k));
  t('no pregunta nada ni publica: no llama a admin_manual_route_publish ni a saveRoutePlan', C.confirms.length === 0 && log.julian.publicar.length === 0 && log.saved.length === savedAntes, `${C.confirms.length}/${log.julian.publicar.length}/${log.saved.length - savedAntes}`);
  const lA = laneCon('rA');
  t('Laura y Andrés ya van en una vuelta que arrancó: se quedan ahí (no se tocan)', lA && R.rv2Fijas[lA.id] && R.order[lA.id].join() === 'rA,rB' && lA.start === '03:45', lA && JSON.stringify([lA.id, lA.start]));
  const lC = laneCon('rC');
  t('José y Cami van en UNA vuelta del tablero, en su orden, saliendo a las 5:30 (la hora del jefe)', lC && R.order[lC.id].join() === 'rC,rD' && lC.type === 'sal' && lC.start === '05:30' && R.cars.some((c) => c.id === lC.car), lC && JSON.stringify([lC.id, lC.start, R.order[lC.id]]));
  const rC = lC && C.V2().dia().byId[lC.id];
  t('…con la tarjeta de siempre: recoge a cada uno a su hora (5:30 y 5:40)', rC && rC.stops.map((s) => s.time).join() === '330,340' && rC.type === 'salida', rC && JSON.stringify(rC.stops));
  t('…y es una vuelta como cualquiera: tiene fila en la lista, con su carro', !!q(`#rv2-list [data-id="${lC && lC.id}"]`) && !q('#rv2-list .rj-v'), q('#rv2-list') && txt(q('#rv2-list')).slice(0, 160));
  const lle = laneCon('rF');
  t('la llegada AV9412: Natalia y Kevin juntos, aterrizan 14:40, salen de JMC después del desembarque', lle && lle.type === 'lle' && [...R.order[lle.id]].sort().join() === 'rF,rO' && lle.landing === '14:40' && lle.start > '14:40', lle && JSON.stringify([lle.start, lle.landing]));
  const kPepe = Object.keys(R.aux).find((k) => R.aux[k].guest && R.aux[k].n === 'Pepe');
  t('27-oct (2ª): Pepe («no tiene la app») entra al tablero en su vuelta de las 8:20, sin pedido', kPepe && laneCon(kPepe) && laneCon(kPepe).start === '08:20' && R.aux[kPepe].reservationId === null, kPepe);
  t('José y Camila salieron de su vuelta vieja del tablero (la de las 04:45 ya no existe)', !R.lanes.some((l) => l.start === '04:45' && (R.order[l.id] || []).length), JSON.stringify(R.lanes.map((l) => l.start)));
  t('27-oct (2ª): rearmar: quien pidió y NO está en el texto sale de su vuelta y queda sin carro (Valentina, Sergio, Mateo, Juliana)', ['rE', 'rG', 'rI', 'rJ'].every((k) => !laneCon(k) && R.pool.includes(k)), JSON.stringify(R.pool));
  t('…sin repetidos: nadie queda en dos vueltas', Object.keys(R.aux).every((k) => R.lanes.filter((l) => (R.order[l.id] || []).includes(k)).length <= 1));
  t('…la vuelta que sigue igual (Tomás y Sara, AV9420) se queda en su carro (V-03) con su conductor', (() => { const l = laneCon('rK'); return l && laneCon('rL') === l && l.car === 'V-03' && l.raId === 'ra-9'; })(), JSON.stringify(laneCon('rK')));
  t('…y la de Felipe también, con la hora del texto (10:30)', laneCon('rM') && laneCon('rM').raId === 'ra-6' && laneCon('rM').start === '10:30', JSON.stringify(laneCon('rM')));
  const choque = R.cars.map((c) => R.lanes.filter((l) => l.car === c.id && (R.order[l.id] || []).length).sort((x, y) => x.vuelta - y.vuelta))
    .some((ls) => ls.some((l, i) => i > 0 && (C.V2().dia().byId[l.id] || {}).retraso > 0));
  t('ningún carro queda con dos vueltas que se cruzan', !choque);
  t('se abre la hoja de Publicar de siempre (la que avisa)', /Publicar/.test(txt(q('#rv2-shTitle')) || '') && !!q('#rv2-doPublish'), txt(q('#rv2-shTitle')));
  t('el aviso dice cuántas vueltas quedaron, quién se quedó en su vuelta en curso y que nadie ha recibido aviso', /6 vueltas quedaron en el tablero/.test(C.toastV2() || '') && /3 siguen iguales, con su conductor/.test(C.toastV2() || '') && /quedaron sin carro \(no están en tu ruta\): Valentina Ríos, Sergio Molina, Mateo Zapata, Juliana Ossa/.test(C.toastV2() || '') && /Laura Gómez, Andrés Ruiz ya van en una vuelta en curso y se quedan ahí/.test(C.toastV2() || '') && /Nadie ha recibido aviso: revisa y dale Publicar/.test(C.toastV2() || ''), C.toastV2());
  t('aprende solo lo elegido a mano (0149): «kevin» → el perfil de Kevin', JSON.stringify(aprendidos) === JSON.stringify([[{ alias: 'kevin', auxiliar_profile_id: 'aux-rO' }]]), JSON.stringify(aprendidos));
  t('26-oct: las llegadas del mismo texto pasan solas a Vuelos (el día de la ruta)', seguidos.length === 1 && seguidos[0][1] === DAY && /AV9412/i.test(seguidos[0][0]), JSON.stringify(seguidos.map((x) => x[1])));
  t('…y el aviso lo dice («· 2 vuelos a Vuelos»)', /2 vuelos a Vuelos/.test(C.toastV2() || ''), C.toastV2());
  C.V2()._sheet.close(); await wait();
  // Publicar: lo de siempre, con las horas del jefe y el sin cuenta en su lugar.
  const r = await C.T().rtSavePlan();
  const S = log.saved[log.saved.length - 1];
  const sC = S && S.lanes.find((l) => l.stops.includes('res-C'));
  t('Publicar manda las horas del jefe: José 5:30, Cami 5:40, la vuelta arranca 5:30', r && r.ok && sC && sC.etas['res-C'] === 330 && sC.etas['res-D'] === 340 && sC.startAt === `${DAY}T05:30:00-05:00`, sC && JSON.stringify([sC.startAt, sC.etas]));
  C.V2().render();
  t('…y el tablero queda publicado (sin «con cambios»)', /Publicado/.test(txt(q('#rv2-pubChip')) || '') && !/con cambios/.test(txt(q('#rv2-pubChip')) || ''), txt(q('#rv2-pubChip')));
  // D y lo que sigue prueban las vueltas pegadas VIEJAS (pool, 0125), que siguen en
  // la base: se simula que el día quedó publicado así.
  publicado = bloquesViejos;
  await C.V2().cargarDia(DAY); await wait(40);
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
  // 27-oct (Camilo, foto de las 12:39 a. m.): «2:50 Leslie» y «3:00 Henry» en una salida
  // SIN «Deben estar»; Leslie pidió salida 03:30 y llegada 11:35 → «Revisa: hay parecidos».
  {
    const C3 = [
      { rid: 'l1', auxId: 'la', n: 'Leslie Acosta Arango', type: 'sal', dia: DAY, dl: '03:30', zona: 'Ébano' },
      { rid: 'l2', auxId: 'la', n: 'Leslie Acosta Arango', type: 'lle', dia: DAY, dl: '11:35', vuelo: 'AV9123' },
      { rid: 'h1', auxId: 'ha', n: 'Henry Gómez', type: 'sal', dia: DAY, dl: '03:40' },
      { rid: 'h2', auxId: 'ha', n: 'Henry Gómez', type: 'lle', dia: DAY, dl: '15:10', vuelo: 'AV9001' },
    ];
    const r3 = J._emparejar([P('x', 'Leslie', { min: 170 }), P('y', 'Henry', { min: 180 })], C3, {});
    t('27-oct: «2:50 Leslie» sin «Deben estar» → su SALIDA (03:30), sola; no su llegada de las 11:35', r3.x.auto && r3.x.rid === 'l1', JSON.stringify(r3.x));
    t('…y «3:00 Henry» → su salida (03:40)', r3.y.auto && r3.y.rid === 'h1', JSON.stringify(r3.y));
    const r4 = J._emparejar([P('z', 'Leslie', { min: 695, vuelo: 'AV9123' })], C3, {});
    t('…con vuelo en el paréntesis sigue siendo la LLEGADA', r4.z.auto && r4.z.rid === 'l2', JSON.stringify(r4.z));
  }

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
  t('«Paula (aero r)», que solo pidió salida: «Pidió una salida, no el regreso desde JMC: elige quién es»', /Pidió una salida, no el regreso desde JMC: elige quién es/.test(txt(bs[1])) && bs[1].querySelector('select').value === '', txt(bs[1]));
  H.pick(bs[1].querySelector('select'), 'res-P'); await wait();
  t('…y si el jefe la elige igual, lo advierte en palabras', /Pidió una salida \(de la casa a JMC\), no el regreso desde JMC/.test(txt(H.qa('#rj-prev .rj-b')[1])), txt(H.qa('#rj-prev .rj-b')[1]));
  H.pick(H.qa('#rj-prev .rj-b')[1].querySelector('select'), '__guest'); await wait();
  H.w.__confirma = true;
  H.click(H.q('#rv2-sheet [data-rj="publicar"]')); await wait(80);
  {
    const R = H.T().rt;
    const l = R.lanes.find((x) => (R.order[x.id] || []).includes('rQ'));
    const a = R.aux.rQ || {};
    // De reserva en JMC (tierra): su hora es la de recogerla, sin desembarque (el +20 de 0125 ya no aplica).
    t('la vuelta de Andrea entra al tablero como LLEGADA (de JMC a la casa), a las 16:20', !pub && l && l.type === 'lle' && l.landing === '16:20' && (a.tierra ? l.start === '16:20' : l.start > '16:20'), l && JSON.stringify([l.type, l.landing, l.start, a.tierra]));
  }
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
console.log('\n── 0133 · Un pasajero sin cuenta en el tablero (Pepe · Kriss) ──');
{
  let extra = null;   // la vuelta publicada con Kriss, para releer el día
  const G = await boot({
    antes(w, log) {
      w.Api.adminManualRoutePublish = async (day, blocks, aliases) => { log.julian.publicar.push({ day, blocks, aliases }); return { vueltas: 0 }; };
      w.Api.listResidencesAdmin = async () => [{ id: 'res-mota', name: 'Mota', is_active: true, latitude: 6.16, longitude: -75.37, zona_jefe: 'Rionegro' },
        { id: 'res-campus', name: 'Campus Reservado', is_active: true, latitude: 6.12, longitude: -75.42, zona_jefe: 'Llanogrande' }];
      const pub0 = w.Api.getPublishedPlan;
      w.Api.getPublishedPlan = async (day, o) => { const r = await pub0(day, o); if (extra && day === DAY) r.vueltas = r.vueltas.concat([extra]); return r; };
    },
  });
  const { w, q, qa, click, type, pick, log } = G;
  click(q('#rv2-julian')); await wait();
  type(q('#rj-ta'), TEXTO + '\n\n8:50 Kriss (Campus reservado)\nDeben estar 9:10');
  click(q('#rv2-sheet [data-rj="leer"]')); await wait(60);
  const fila = (nombre) => qa('#rj-prev .rj-p').find((p) => txt(p.querySelector('.rj-w')).startsWith(nombre));
  t('Kriss (Campus reservado): «Va sin cuenta» y lo ubica en el conjunto «Campus Reservado»', fila('Kriss') && fila('Kriss').dataset.st === 'guest' && /Sin la app: va en la ruta · Campus Reservado/.test(txt(fila('Kriss'))), fila('Kriss') && txt(fila('Kriss')));
  pick(fila('Kevin').querySelector('select'), 'res-O'); await wait();
  const pub = q('#rv2-sheet [data-rj="publicar"]');
  t('el botón cuenta a los sin cuenta aparte («y 2 sin cuenta»)', txt(pub) === 'Pasar al tablero · 10 y 2 sin cuenta', txt(pub));
  click(pub); await wait(80);
  const R = G.T().rt;
  const laneCon = (k) => R.lanes.find((l) => (R.order[l.id] || []).includes(k));
  const kOf = (n) => Object.keys(R.aux).find((k) => R.aux[k].guest && R.aux[k].n === n);
  const kP = kOf('Pepe'), kK = kOf('Kriss');
  t('Pepe y Kriss entran al tablero como paradas sin cuenta (sin reserva)', kP && kK && R.aux[kP].reservationId === null && R.aux[kK].reservationId === null && laneCon(kP) && laneCon(kK), JSON.stringify([kP, kK]));
  t('Pepe: salida a las 8:20 desde Mota (con el punto del conjunto); Kriss: 8:50, «Deben estar» 9:10', laneCon(kP).start === '08:20' && R.aux[kP].resId === 'res-mota' && R.aux[kP].lat === 6.16 && laneCon(kK).start === '08:50' && R.aux[kK].dl === '09:10', JSON.stringify([laneCon(kP).start, R.aux[kP], laneCon(kK).start, R.aux[kK].dl]));
  const fK = q(`#rv2-list [data-id="${laneCon(kK).id}"]`);
  t('la vuelta de Kriss tiene su fila en la lista como cualquiera', !!fK && /Kriss/.test(txt(fK)), fK && txt(fK));
  t('no llama a admin_manual_route_publish', log.julian.publicar.length === 0);
  const r = await G.T().rtSavePlan();
  const S = log.saved[log.saved.length - 1];
  const sK = S && S.lanes.find((l) => (l.paradas || []).some((p) => p.guest && p.guest.name === 'Kriss'));
  const pK = sK && sK.paradas.find((p) => p.guest);
  t('Publicar manda a Kriss en «paradas»: nombre, lugar como lo escribió Julián, conjunto, punto y su hora', r && r.ok && pK && pK.guest.place === 'Campus reservado' && pK.guest.residence_id === 'res-campus' && pK.guest.lat === 6.12 && pK.eta === 530 && sK.stops.length === 0, JSON.stringify(sK));
  // Releer el día: la vuelta publicada con Kriss vuelve al tablero con ella adentro.
  extra = { id: 'ra-kriss', type: 'sal', status: 'planned', startAt: `${DAY}T08:50:00-05:00`, pool: false, manualDay: null, deadlineAt: null, nota: '',
    vehicleId: null, planCar: sK.planCar, carro: sK.planCar, placa: null, cap: 4, driverProfileId: null, conductor: 'Sin conductor', delegated: false, autoCreated: false,
    pendientes: [{ stopId: 'stopkris-0000', rid: null, guest: true, name: 'Kriss', order: 1, status: 'pending', etaAt: `${DAY}T08:50:00-05:00`,
      lat: 6.12, lng: -75.42, resId: 'res-campus', address: 'Campus reservado', guestPhone: null, pax: 1 }], atendidas: [] };
  await G.V2().cargarDia(DAY); await wait(40);
  const kK2 = Object.keys(R.aux).find((k) => R.aux[k].guest && R.aux[k].n === 'Kriss');
  const lK2 = kK2 && G.T().rt.lanes.find((l) => (G.T().rt.order[l.id] || []).includes(kK2));
  t('al releer el día, Kriss vuelve en su vuelta del tablero (8:50), con su parada de la base', kK2 === 'gstopkris' && lK2 && lK2.start === '08:50' && G.T().rt.aux[kK2].guest.stopId === 'stopkris-0000', JSON.stringify([kK2, lK2 && lK2.start]));
  const rK2 = lK2 && G.V2().dia().byId[lK2.id];
  t('…y su hora es la publicada (8:50), no la del modelo', rK2 && rK2.stops[0].time === 530, rK2 && JSON.stringify(rK2.stops));
  // 27-oct (Camilo): «Sara dice AV9358» debajo del nombre en la app del conductor. En
  // una llegada el paréntesis es el vuelo: el sin cuenta va SIN dirección, no con el vuelo.
  {
    const S2 = G.J()._st;
    const antes = { lectura: S2.lectura, elegido: S2.elegido };
    S2.lectura = G.J()._leer('19:55 Zoe (av9358)\n\n20:10 Ana (Aero r)\n\n6:00 Lia (Mota)\nDeben estar 6:40', DAY);
    S2.elegido = { '0.0.0': '__guest', '1.0.0': '__guest', '2.0.0': '__guest' };
    const bs = G.J()._bloques();
    const g = (i) => bs[i] && bs[i].stops[0] && bs[i].stops[0].guest;
    t('27-oct: sin cuenta en una llegada «(av9358)»: el vuelo NO queda de dirección (lugar vacío) y va de llegada', g(0) && g(0).place === null && g(0).vuelo === 'AV9358' && bs[0].type === 'lle', JSON.stringify(bs[0]));
    t('…«(Aero r)» tampoco es su casa', g(1) && g(1).place === null, JSON.stringify(bs[1]));
    t('…y en una salida el paréntesis SÍ es la casa («Mota»)', g(2) && g(2).place === 'Mota' && bs[2].type === 'sal', JSON.stringify(bs[2]));
    S2.lectura = antes.lectura; S2.elegido = antes.elegido;
  }
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
  // 26-oct: la fila de títulos trae filtros (A1 hasta la última fila y columna).
  t('RESPUESTAS trae filtros en los títulos, sobre las 10 columnas y las 17 filas', String(ws.autoFilter) === 'A1:J18', String(ws.autoFilter));
  const xmlR = await (await import('jszip')).default.loadAsync(Buffer.from(r.buf)).then((z) => z.file('xl/worksheets/sheet1.xml').async('string'));
  t('…y en el archivo de verdad (<autoFilter ref="A1:J18"/>)', /<autoFilter ref="A1:J18"\s*\/>/.test(xmlR), (xmlR.match(/<autoFilter[^>]*>/) || ['(no hay)'])[0]);

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
  t('26-oct: las dos hojas traen filtros (RESPUESTAS A1:J17, LATE A1:K2)', String(wb2.getWorksheet('RESPUESTAS').autoFilter) === 'A1:J17' && wl && String(wl.autoFilter) === 'A1:K2', String(wb2.getWorksheet('RESPUESTAS').autoFilter) + ' · ' + String(wl && wl.autoFilter));
  t('0130: en LATE va Mónica (madrugada, pidió el dom 11 a las 9:05 p. m.)', fl.length === 1 && fl[0][0] === 'Mónica Madrugada' && /9:05/.test(fl[0][10]) && /p\. m\./.test(fl[0][10]), JSON.stringify(fl));
  t('0130: el aviso cuenta las dos cosas', /16 filas \(16 pedidos hasta las 7:40 p\. m\.\) · 1 Late en su hoja\./.test(E.toastV2() || ''), E.toastV2());
  // El aviso de las 7:40 p. m. abre #/rutas?excel=día → ofrecer(día).
  const nDesc = (E.w.__descargas || []).length;
  await E.J().ofrecer(DAY); await wait(40);
  t('0130: el aviso abre la hoja «Excel del lun 12 oct» y lo descarga solo', /Excel del lun 12 oct/.test(txt(E.q('#rv2-shTitle'))) && E.w.__descargas.length === nDesc + 1, txt(E.q('#rv2-shTitle')) + ' · ' + E.w.__descargas.length);
  t('0130: la hoja explica el corte y dice qué salió', /hasta las 7:40 p\. m\. de la víspera/.test(txt(E.q('#rv2-sheet'))) && /Listo: lun 12 oct · 16 filas · 1 Late en su hoja/.test(txt(E.q('#rj-xl-msg'))), txt(E.q('#rj-xl-msg')));
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

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── P · Pegar = llenar el tablero (27-oct-2026): carros, madrugada, deshacer ──');
{
  const P = await boot();
  const { q, qa, click, V2, T } = P;
  const R = () => T().rt;
  const laneCon = (k) => R().lanes.find((l) => (R().order[l.id] || []).includes(k));
  const nCars0 = R().cars.length;
  // Dos salidas que se cruzan (9:00 y 9:05) no pueden ir en el mismo carro.
  let r = V2().meterPegado([{ type: 'sal', stops: [{ rid: 'res-E', min: 540 }] }, { type: 'sal', stops: [{ rid: 'res-M', min: 545 }] }]);
  t('dos vueltas que se cruzan van en carros distintos', r && r.vueltas === 2 && laneCon('rE') && laneCon('rM') && laneCon('rE').car !== laneCon('rM').car, JSON.stringify(r));
  t('…cada una a la hora del jefe (9:00 y 9:05), y su carro sin choques', laneCon('rE').start === '09:00' && laneCon('rM').start === '09:05' && !R().cars.some((c) => R().lanes.filter((l) => l.car === c.id && (R().order[l.id] || []).length).some((l) => (V2().dia().byId[l.id] || {}).retraso > 0)));
  t('…y su conductor lo pone el turno del carro, como siempre (autoLlenar)', [laneCon('rE'), laneCon('rM')].every((l) => { const rr = V2().dia().byId[l.id]; return rr && (rr.driverId || rr.status === 'nodriver'); }));
  // «Deshacer» (el aviso que muestra la hoja de la ruta): el tablero vuelve a como estaba.
  V2().toast('pegado', true);
  click(q('#rv2-toast [data-act="undo"]')); await wait();
  t('«Deshacer» devuelve a cada uno a su vuelta de antes (Valentina 04:35, Felipe 10:00)', laneCon('rE') && laneCon('rE').start === '04:35' && laneCon('rM') && laneCon('rM').start === '10:00' && R().cars.length === nCars0,
    JSON.stringify([laneCon('rE') && laneCon('rE').start, laneCon('rM') && laneCon('rM').start]));
  // Cuatro a la misma hora: con 3 carros, el cuarto agrega un carro (sus planes piden uno más en el pico).
  r = V2().meterPegado(['res-E', 'res-M', 'res-G', 'res-H'].map((rid) => ({ type: 'sal', stops: [{ rid, min: 720 }] })));
  t('cuatro vueltas a las 12:00 con 3 carros: se agrega un carro y lo dice', r && r.vueltas === 4 && r.nuevosCarros.length === 1 && R().cars.length === nCars0 + 1, JSON.stringify(r && r.nuevosCarros));
  t('…y las cuatro quedan en carros distintos', new Set(['rE', 'rM', 'rG', 'rH'].map((k) => laneCon(k).car)).size === 4);
  // La madrugada siguiente: queda guardada y entra cuando se abre ese día.
  V2().guardarPegado(DAY, [{ type: 'sal', stops: [{ rid: 'res-K', min: 600 }] }]);
  t('lo guardado para un día espera (_pegadoPendiente)', (V2()._pegadoPendiente[DAY] || []).length === 1);
  await V2().cargarDia(DAY); await wait(60);
  t('…y entra solo al abrir ese día, con su hora', laneCon('rK') && laneCon('rK').start === '10:00' && !V2()._pegadoPendiente[DAY], laneCon('rK') && laneCon('rK').start);
  t('…y el aviso lo dice', /Entró la madrugada que pegaste/.test(P.toastV2() || ''), P.toastV2());
  // La hoja: un texto que termina después de medianoche manda esa vuelta al día siguiente.
  click(q('#rv2-julian')); await wait();
  P.type(q('#rj-ta'), '10:30 Felipe (Altos del lago)\nDeben estar 11:20\n\n23:40 Tomás (Mota)\n\n0:20 Sara (Mota)\nDeben estar 0:50');
  click(q('#rv2-sheet [data-rj="leer"]')); await wait(60);
  const PT = P.J()._paraTablero();
  t('la hoja parte lo pegado: lo del día al tablero, lo de después de medianoche al día siguiente', PT.hoy.length >= 1 && PT.sig.length === 1 && PT.sig[0].stops[0].min === 20 && PT.sig[0].deadline === 50, JSON.stringify(PT.sig));
  t('sin errores de script', P.errors.length === 0, P.errors.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── R · Volver a pegar (27-oct-2026, 2ª): rearma el día, sin repetidos, con los pedidos de la base ──');
{
  const R0 = await boot({
    antes(w) {
      const plan2 = w.Api.listRoutePlanning;
      w.Api.listRoutePlanning = async (tipo, day) => {
        const x = await plan2(tipo, day);
        // Leslie pidió DESPUÉS de abrir el día: la lectura del tablero no la trae.
        if (x && (day || DAY) === DAY && w.__leslie) x.aux.rZ = Object.assign({}, x.aux.rI, { n: 'Leslie Mora Ríos', dl: '09:40', reservationId: 'res-Z', auxId: 'aux-rZ', zona: 'Cerezos', sector: 'Rionegro', lat: 6.021 });
        return x;
      };
    },
  });
  const { w, q, qa, click, type, pick, T, V2, log } = R0;
  const R = () => T().rt;
  const laneCon = (k) => R().lanes.find((l) => (R().order[l.id] || []).includes(k)) || null;
  const fila = (nombre) => qa('#rj-prev .rj-p').find((p) => txt(p.querySelector('.rj-w')).startsWith(nombre));
  const pub = () => q('#rv2-sheet [data-rj="publicar"]');
  const pegar = async (texto) => { click(q('#rv2-julian')); await wait(); type(q('#rj-ta'), texto); click(q('#rv2-sheet [data-rj="leer"]')); await wait(60); };
  const unaVez = () => Object.keys(R().aux).every((k) => R().lanes.filter((l) => (R().order[l.id] || []).includes(k)).length <= 1);
  const PRIMERA = ['5:30 José (Cerezos)', '5:40 Cami (Ébano)', 'Deben estar 6:10', '', '5:20 Valentina (Solare)', 'Deben estar 5:50', '',
    '7:10 La flaca (Piedemonte)', '7:20 Sergio (Hotel Sandiego)', 'Deben estar 7:40', '', '8:20 Pepe (Mota)', 'Deben estar 8:50', '',
    '8:40 Mateo (Cámbulo)', '8:45 Juliana (Aurora)', 'Deben estar 9:00', '', '10:30 Felipe (Altos del lago)', 'Deben estar 11:20', '',
    '14:40 Natalia (AV9412)', '', '15:05 Kevin (AV9414)', '', '16:10 Tomás y Sara (Av 9420)'].join('\n');
  await pegar(PRIMERA);
  t('la primera ruta del día: todos emparejados (y Pepe sin la app)', !pub().disabled && txt(pub()) === 'Pasar al tablero · 12 y 1 sin cuenta', txt(pub()) + ' · ' + txt(q('#rj-prev .rj-sum')));
  click(pub()); await wait(80);
  R0.V2()._sheet.close(); await wait();
  await T().rtSavePlan();
  const lMJ = laneCon('rI'), lKL = laneCon('rK'), lM = laneCon('rM');
  t('publicada: cada uno en una sola vuelta', unaVez() && lMJ && laneCon('rJ') === lMJ);

  // LA ACTUALIZACIÓN: Cami pasa con Valentina, Sergio ya no va, Pepe se escribe
  // distinto y Leslie (que pidió después de abrir el día) entra.
  w.__leslie = true;
  const SEGUNDA = ['5:30 José (Cerezos)', 'Deben estar 6:10', '', '5:20 Valentina (Solare)', '5:35 Cami (Ébano)', 'Deben estar 5:50', '',
    '7:10 La flaca (Piedemonte)', 'Deben estar 7:40', '', '8:25 Pepe M (Mota)', 'Deben estar 8:50', '',
    '8:40 Mateo (Cámbulo)', '8:45 Juliana (Aurora)', 'Deben estar 9:00', '', '9:10 Lesli (Cerezos)', 'Deben estar 9:40', '',
    '10:30 Felipe (Altos del lago)', 'Deben estar 11:20', '', '14:40 Natalia (AV9412)', '', '15:05 Kevin (AV9414)', '', '16:10 Tomás y Sara (Av 9420)'].join('\n');
  await pegar(SEGUNDA);
  t('«Lesli (Cerezos)»: la encuentra en la base aunque pidió después de abrir el día (Leslie Mora Ríos)', fila('Lesli') && fila('Lesli').querySelector('select').value === 'res-Z' && fila('Lesli').dataset.st === 'ok', fila('Lesli') && txt(fila('Lesli')));
  t('…y marca «Rearmar el día» (el texto es el día entero)', (q('#rj-prev input[name="rj-modo"]:checked') || {}).value === 'rearmar');
  click(pub()); await wait(80);
  const guests = Object.keys(R().aux).filter((k) => R().aux[k].guest);
  t('sin repetidos: cada uno en UNA vuelta', unaVez(), JSON.stringify(R().lanes.map((l) => [l.id, R().order[l.id]])));
  t('Pepe («Pepe M» en la actualización) es el MISMO sin cuenta: uno solo, a las 8:25', guests.length === 1 && laneCon(guests[0]) && laneCon(guests[0]).start === '08:25', JSON.stringify(guests.map((k) => R().aux[k].n)));
  t('Cami quedó con Valentina, y José solo', laneCon('rD') === laneCon('rE') && laneCon('rC') !== laneCon('rD') && R().order[laneCon('rC').id].join() === 'rC');
  t('Sergio (ya no está en el texto) quedó sin carro, en Avisos', !laneCon('rG') && R().pool.includes('rG'), JSON.stringify(R().pool));
  const kZ = Object.keys(R().aux).find((k) => R().aux[k].reservationId === 'res-Z');
  t('Leslie entró al tablero con su pedido, a las 9:10', kZ && laneCon(kZ) && laneCon(kZ).start === '09:10' && R().aux[kZ].n === 'Leslie Mora Ríos', kZ);
  t('las vueltas que no cambiaron son las MISMAS (Mateo y Juliana, Tomás y Sara, Felipe): mismo carro y vuelta', [['rI', lMJ], ['rK', lKL], ['rM', lM]].every(([k, l]) => laneCon(k) && l && laneCon(k).id === l.id && laneCon(k).car === l.car), JSON.stringify([laneCon('rI') && laneCon('rI').id, lMJ && lMJ.id]));
  t('el aviso: quién quedó sin carro', /quedó sin carro \(no está en tu ruta\): Sergio Molina/.test(R0.toastV2() || ''), R0.toastV2());
  R0.V2()._sheet.close(); await wait();
  const antes = log.saved.length;
  await T().rtSavePlan();
  const S = log.saved[log.saved.length - 1];
  const rids = S ? S.lanes.flatMap((l) => l.stops) : [];
  t('Publicar manda a cada reserva UNA vez (sin duplicados) y a Leslie', log.saved.length === antes + 1 && rids.length === new Set(rids).size && rids.includes('res-Z') && !rids.includes('res-G'), JSON.stringify(rids));
  // «Deshacer» la actualización: vuelve todo, también Sergio, Pepe y sin Leslie.
  await pegar(SEGUNDA.replace('8:25 Pepe M', '8:30 Pepe M').replace('5:30 José', '5:25 José'));
  click(pub()); await wait(80);
  R0.V2()._sheet.close(); await wait();
  R0.V2().toast('pegado', true); click(q('#rv2-toast [data-act="undo"]')); await wait();
  const g2 = Object.keys(R().aux).filter((k) => R().aux[k].guest);
  t('«Deshacer» devuelve el tablero de antes de pegar (José 5:30, Pepe 8:25, un solo sin cuenta)', laneCon('rC') && laneCon('rC').start === '05:30' && g2.length === 1 && laneCon(g2[0]).start === '08:25' && unaVez(), JSON.stringify([laneCon('rC') && laneCon('rC').start, g2]));

  // SOLO UNAS VUELTAS: lo demás queda como está.
  await pegar('9:00 Sergio (Hotel Sandiego)\nDeben estar 9:30');
  t('un texto con una sola vuelta marca «Solo cambiar estas vueltas»', (q('#rj-prev input[name="rj-modo"]:checked') || {}).value === 'parte');
  const nLanes = R().lanes.filter((l) => (R().order[l.id] || []).length).length;
  click(pub()); await wait(80);
  t('…y solo agrega esa: Sergio a las 9:00 y el resto del tablero igual (José solo, Leslie 9:10)', laneCon('rG') && laneCon('rG').start === '09:00' && R().order[laneCon('rC').id].join() === 'rC' && laneCon(kZ) && R().lanes.filter((l) => (R().order[l.id] || []).length).length === nLanes + 1,
    JSON.stringify(laneCon('rG')));
  R0.V2()._sheet.close(); await wait();
  // Elegir «Rearmar» a mano en ese mismo texto: todos los demás quedarían sin carro.
  await pegar('9:00 Sergio (Hotel Sandiego)\nDeben estar 9:30');
  pick(q('#rj-prev input[name="rj-modo"][value="rearmar"]'), 'rearmar');
  const rr = q('#rj-prev input[name="rj-modo"][value="rearmar"]'); rr.checked = true; rr.dispatchEvent(new w.Event('change', { bubbles: true })); await wait();
  t('…el jefe puede elegir «Rearmar» y la hoja dice cuántos quedarían sin carro', (q('#rj-prev input[name="rj-modo"]:checked') || {}).value === 'rearmar' && /pedidos que no están en el texto quedan sin carro/.test(txt(q('#rj-prev .rj-modo'))), txt(q('#rj-prev .rj-modo')));
  R0.V2()._sheet.close(); await wait();
  t('sin errores de script', R0.errors.length === 0, R0.errors.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── R3 · Rearmar no toca lo que pasó sin marcar ni la delegada (como Re-optimizar) ──');
{
  const Q = await boot();
  const R = () => Q.T().rt;
  const laneCon = (k) => R().lanes.find((l) => (R().order[l.id] || []).includes(k)) || null;
  const lE = laneCon('rE'), lHG = laneCon('rH');
  R().rv2Fin[lE.id] = { estado: 'sinmarcar' };   // Valentina 04:35: pasó y el conductor no la marcó
  lHG.deleg = true; lHG.delegName = 'Uber de Camilo';   // Daniela y Sergio: delegada
  Q.V2().render();
  t('lo que pasó sin marcar no cuenta como «por mover»', !Q.V2().pendientesDelTablero().includes('res-E'));
  const r = Q.V2().meterPegado([{ type: 'sal', stops: [{ rid: 'res-E', min: 300 }] }, { type: 'sal', stops: [{ rid: 'res-M', min: 630 }] }], { rearmar: true });
  t('Valentina (vuelta pasada sin marcar) se queda en su vuelta aunque venga en el texto', laneCon('rE') && laneCon('rE').id === lE.id && r.enCurso.includes('Valentina Ríos'), JSON.stringify(r));
  t('la delegada (Daniela y Sergio), que no está en el texto, se queda como estaba', laneCon('rH') && laneCon('rH').id === lHG.id && laneCon('rG') === laneCon('rH') && laneCon('rH').deleg === true);
  t('…y lo demás sin arrancar sí se rearma (José y Camila quedan sin carro)', !laneCon('rC') && R().pool.includes('rC') && R().pool.includes('rD'));
  t('sin errores de script', Q.errors.length === 0, Q.errors.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── R2 · El apodo aprendido ya no decide solo (salida o llegada) ──');
{
  const C2 = [
    { rid: 's', auxId: 'a1', n: 'Maria Camila Cano Florez', type: 'sal', dia: DAY, dl: '09:20', zona: 'Ruta 39' },
    { rid: 'l', auxId: 'a1', n: 'Maria Camila Cano Florez', type: 'lle', dia: DAY, dl: '20:20', vuelo: 'AV9340', zona: 'Ruta 39' },
  ];
  const P2 = (key, o) => Object.assign({ key, nombre: 'cano', dia: DAY, vuelo: null, deadline: null, lugar: '' }, o);
  const r = J._emparejar([P2('x', { min: 1220, vuelo: 'AV9340' })], C2, { cano: 'a1' });
  t('«cano (AV9340)» sola en la actualización (sin la línea de la mañana): su LLEGADA, no su salida', r.x.auto && r.x.rid === 'l', JSON.stringify(r.x));
  const r2 = J._emparejar([P2('y', { min: 520, deadline: 560 })], C2, { cano: 'a1' });
  t('«cano» con «Deben estar»: su SALIDA', r2.y.auto && r2.y.rid === 's', JSON.stringify(r2.y));
  // Un apodo SIN aprender: «La flaca (Piedemonte)» a la hora de Daniela, que vive en Piedemonte.
  const C3 = [{ rid: 'dan', auxId: 'a9', n: 'Daniela Cano', type: 'sal', dia: DAY, dl: '07:40', zona: 'Piedemonte', sector: 'Rionegro' },
    { rid: 'otra', auxId: 'a8', n: 'Sofía Mesa', type: 'sal', dia: DAY, dl: '15:00', zona: 'Piedemonte', sector: 'Rionegro' }];
  const r3 = J._emparejar([P2('z', { nombre: 'La flaca', min: 430, deadline: 460, lugar: 'Piedemonte' })], C3, {});
  t('apodo sin aprender «La flaca (Piedemonte)»: Daniela (su conjunto y su hora) sale de opción, pero NO se elige sola', !r3.z.auto && r3.z.opciones.join() === 'dan', JSON.stringify(r3.z));
  const r4 = J._emparejar([P2('z', { nombre: 'Pepe', min: 430, deadline: 460, lugar: 'Mota' })], C3, {});
  t('…y sin conjunto que cuadre (Mota), nadie (va sin la app)', r4.z.opciones.length === 0, JSON.stringify(r4.z));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── S · «Pasar a una vuelta sola» (27-oct-2026, 2ª) ──');
{
  const S0 = await boot();
  const { q, qa, click, T, V2 } = S0;
  const R = () => T().rt;
  const laneCon = (k) => R().lanes.find((l) => (R().order[l.id] || []).includes(k)) || null;
  const l0 = laneCon('rJ');
  const t0 = V2().dia().byId[l0.id].stops.find((s) => s.crewId === 'rJ').time;
  const chip = q(`#rv2-list [data-act="move"][data-crew="rJ"]`);
  click(chip); await wait();
  const btn = q('#routes-v2 [data-act="sola"][data-crew="rJ"]');
  t('«Mover a Juliana a…» ofrece «Pasar a una vuelta sola»', !!btn && /Pasar a una vuelta sola/.test(txt(btn)) && /Después le pones el conductor/.test(txt(btn)), btn && txt(btn));
  click(btn); await wait();
  const l1 = laneCon('rJ');
  const r1 = l1 && V2().dia().byId[l1.id];
  t('Juliana queda sola en una vuelta NUEVA, a la hora a la que la recogían', l1 && l1 !== l0 && R().order[l1.id].join() === 'rJ' && r1 && r1.stops[0].time === t0, JSON.stringify([l1 && l1.id, r1 && r1.stops, t0]));
  t('…Mateo sigue en la suya, sin ella', R().order[l0.id].join() === 'rI');
  t('…en un carro donde no se cruza con nada', !R().cars.some((c) => R().lanes.filter((l) => l.car === c.id && (R().order[l.id] || []).length).some((l) => (V2().dia().byId[l.id] || {}).retraso > 0)));
  t('…y la vuelta queda abierta con «Cambiar» para el conductor', /Pasar|Cambiar/.test(txt(q('#routes-v2 .rv2-detail')) || '') && !!q('#routes-v2 [data-act="assign"]'), txt(q('#routes-v2 .rv2-detail')) && txt(q('#routes-v2 .rv2-detail')).slice(0, 120));
  t('…y el aviso lo dice', /Juliana Ossa pasó a una vuelta sola en/.test(S0.toastV2() || ''), S0.toastV2());
  click(q('#rv2-toast [data-act="undo"]')); await wait();
  t('«Deshacer»: Juliana vuelve con Mateo', laneCon('rJ') === laneCon('rI') && laneCon('rJ').id === l0.id);
  // Desde Avisos (sin carro): Manuela.
  click(q('#routes-v2 [data-act="route"][data-crew="rN"]')); await wait();
  const b2 = q('#rv2-sheet [data-act="sola"][data-crew="rN"]');
  t('«Ubicar a Manuela» (sin carro) también ofrece «En una vuelta sola»', !!b2, txt(q('#rv2-sheet')) && txt(q('#rv2-sheet')).slice(0, 200));
  click(b2); await wait();
  const lN = laneCon('rN');
  t('…y queda sola, con hora antes de su presentación (9:10)', lN && R().order[lN.id].join() === 'rN' && !R().pool.includes('rN') && (V2().dia().byId[lN.id] || {}).arrival <= 9 * 60 + 10, lN && JSON.stringify([lN.start, (V2().dia().byId[lN.id] || {}).arrival]));
  // Una vuelta de UNA persona no ofrece «sola» (ya lo está).
  click(q(`#rv2-list [data-act="move"][data-crew="rM"]`)); await wait();
  t('quien ya va sola no ve «Pasar a una vuelta sola»', !q('#routes-v2 [data-act="sola"][data-crew="rM"]'));
  t('sin errores de script', S0.errors.length === 0, S0.errors.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── T · «Conductor asignado» trae la hora (los tripulantes: «ya se podía ver en la app la hora de recogida») ──');
{
  const T0 = await boot({ publicado: false });
  const { w, T, log } = T0;
  w.Api.auxiliarUserIdsForReservations = async (rids) => rids.map((x) => 'u-' + x);
  w.Api.reservePlace = () => null;
  const R = T().rt;
  // Un plan con conductor: José y Camila salen a las 5:30 (horas del jefe) y Natalia llega.
  T0.V2().meterPegado([{ type: 'sal', stops: [{ rid: 'res-C', min: 330 }, { rid: 'res-D', min: 340 }] }, { type: 'lle', stops: [{ rid: 'res-F', min: 880 }] }]);
  T0.V2().render();
  await T().rtSavePlan();
  const bodies = log.push.filter((p) => /Conductor asignado/.test(p.title)).map((p) => [p.body, p.profileIds.join()]);
  t('a José le llega «Te recogemos … a las 5:30» y a Camila «… a las 5:40»', bodies.some(([b, ids]) => /Te recogemos el lunes 12 a las 5:30\./.test(b) && ids === 'u-res-C') && bodies.some(([b, ids]) => /a las 5:40\./.test(b) && ids === 'u-res-D'), JSON.stringify(bodies));
  t('…y a Natalia (llega en vuelo) «Cuando aterrices te esperamos en JMC (sale … hacia las …)»', bodies.some(([b, ids]) => /Cuando aterrices te esperamos en JMC \(sale el lunes 12 hacia las 15:\d\d\)/.test(b) && ids === 'u-res-F'), JSON.stringify(bodies));
  t('sin errores de script', T0.errors.length === 0, T0.errors.join(' | '));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── U · 28-oct (Camilo): «el que se debe pegar es de la base de datos de tripulantes» ──');
{
  const creados = [], extra = {}, aprendidos = [];
  const U0 = await boot({ antes: (w) => {
    w.Api.listAuxiliares = async () => [
      { id: 'aux-isa', name: 'Isabella Páez Gómez', active: true, deleted: false, res1: { name: 'Marinilla Real', sector: 'Marinilla' }, phone: '3000000001' },
      { id: 'aux-va1', name: 'Valeria Ríos Arango', active: true, deleted: false, res1: { name: 'Solare', sector: 'Marinilla' } },
      { id: 'aux-va2', name: 'Valeria Soto', active: true, deleted: false, res1: null },
      { id: 'aux-bor', name: 'Isabella Borrada Páez', active: true, deleted: true },
      { id: 'aux-rA', name: 'Laura Gómez', active: true, deleted: false },
    ];
    w.Api.saveCrewAliases = async (xs) => { aprendidos.push(...xs); };
    // El pedido a su nombre: queda en los pedidos del día (como la base de verdad).
    w.Api.adminCreateReservation = async (f) => {
      creados.push(JSON.parse(JSON.stringify(f)));
      const n = creados.length, k = 'rX' + n;
      const nombre = { 'aux-isa': 'Isabella Páez Gómez', 'aux-va1': 'Valeria Ríos Arango' }[f.auxId] || 'Otra';
      const hm = new Date(f.whenIso).toLocaleTimeString('en-GB', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      extra[k] = { n: nombre, zona: 'Marinilla Real', sector: 'Marinilla', resId: null, zonaJefe: null, dir: 'Marinilla', lat: 6.03 + n / 1000, lng: -75.41,
        dl: hm, pax: 1, type: f.type, reservationId: 'res-X' + n, tel: '', vuelo: '', tierra: false, notas: '', hotel: false, auxId: f.auxId };
      return 'res-X' + n;
    };
    const plan = w.Api.listRoutePlanning;
    w.Api.listRoutePlanning = async (tipo, day) => { const r = await plan(tipo, day); if (r && (day || DAY) === DAY) Object.assign(r.aux, JSON.parse(JSON.stringify(extra))); return r; };
  } });
  const { q, qa, click, type, pick, T, J: JJ } = U0;
  click(q('#rv2-julian')); await wait();
  type(q('#rj-ta'), '11:20 Isabella Páez Gómez ) (Marinilla (Isabella y Valeria)\nDeben estar 12:10\n\n8:20 Valeria (Mota)\nDeben estar 9:00\n\n4:10 Laura G (Olivar)\nDeben estar 5:00');
  click(q('#rv2-sheet [data-rj="leer"]')); await wait(60);
  const fila = (nombre) => qa('#rj-prev .rj-p').find((p) => txt(p.querySelector('.rj-w')).startsWith(nombre));
  const quien = (nombre) => { const f = fila(nombre); return f ? f.querySelector('select').value : null; };
  const pub = () => q('#rv2-sheet [data-rj="publicar"]');
  t('Isabella (no pidió ese día) se encuentra por su CUENTA y se elige sola', quien('Isabella') === 'aux:aux-isa' && fila('Isabella').dataset.st === 'crear', fila('Isabella') && txt(fila('Isabella')));
  t('…y dice qué va a pasar: «Tiene la app y no pidió este día: … se le crea el pedido (salida 12:10)»', /Tiene la app y no pidió este día: al pasar al tablero se le crea el pedido \(salida 12:10\) y lo ve en su app/.test(txt(fila('Isabella'))), txt(fila('Isabella')));
  t('…su lista trae el grupo «Tienen cuenta y no pidieron este día» (sin la borrada)', [...fila('Isabella').querySelectorAll('optgroup')].some((g) => /Tienen cuenta y no pidieron/.test(g.label))
    && ![...fila('Isabella').querySelectorAll('option')].some((o) => o.value === 'aux:aux-bor'), [...fila('Isabella').querySelectorAll('optgroup')].map((g) => g.label).join(' | '));
  t('«Valeria (Mota)» con dos Valerias: NO se elige sola ni queda «sin la app»; las dos salen de opción', quien('Valeria') === '' && fila('Valeria').dataset.st === 'falta'
    && ['aux:aux-va1', 'aux:aux-va2'].every((v) => [...fila('Valeria').querySelectorAll('option')].some((o) => o.value === v)), fila('Valeria') && txt(fila('Valeria')).slice(0, 200));
  t('Laura (sí pidió su salida) sigue con su pedido, no con su cuenta', quien('Laura G') === 'res-A');
  t('«Falta elegir 1» (Valeria)', pub().disabled && txt(pub()) === 'Falta elegir 1', txt(pub()));
  pick(fila('Valeria').querySelector('select'), '__app'); await wait();
  t('«Va en la ruta (tiene la app)» para Valeria: la que más se parece por el nombre, con su cuenta', /^aux:aux-va/.test(JJ()._st.elegido[Object.keys(JJ()._st.elegido).find((k) => k.startsWith('1.'))] || ''), JSON.stringify(JJ()._st.elegido));
  pick(fila('Valeria').querySelector('select'), 'aux:aux-va1'); await wait();
  t('…elegida a mano: «se le crea el pedido» y el botón cuenta 3', fila('Valeria').dataset.st === 'crear' && !pub().disabled && /Pasar al tablero · 3/.test(txt(pub())) && /2 tienen cuenta y no pidieron: se les crea el pedido/.test(txt(q('#rj-prev .rj-sum'))), txt(pub()) + ' · ' + txt(q('#rj-prev .rj-sum')));
  click(pub()); await wait(150);
  const de = (aux) => creados.find((f) => f.auxId === aux) || {};
  t('al pasar al tablero se crean los 2 pedidos a su nombre, SIN que el sistema los acomode (acomodar: false)', creados.length === 2 && creados.every((f) => f.acomodar === false && f.type === 'sal'), JSON.stringify(creados));
  t('…salida = la hora de «Deben estar» (12:10 y 9:00), la presentación en JMC', de('aux-isa').whenIso === DAY + 'T12:10:00-05:00' && de('aux-va1').whenIso === DAY + 'T09:00:00-05:00', JSON.stringify(creados.map((f) => f.whenIso)));
  const R = T().rt;
  const laneCon = (rid) => { const k = Object.keys(R.aux).find((x) => R.aux[x].reservationId === rid); return k && R.lanes.find((l) => (R.order[l.id] || []).includes(k)); };
  t('…y entran al tablero como cualquiera, con su pedido nuevo (Isabella a las 11:20)', !!laneCon('res-X1') && !!laneCon('res-X2') && laneCon('res-X1').start === '11:20', JSON.stringify([laneCon('res-X1') && laneCon('res-X1').start, laneCon('res-X2') && laneCon('res-X2').start]));
  t('…sin pasajeros sin cuenta (nadie quedó como «no tiene la app»)', !Object.values(R.aux).some((a) => a.guest));
  t('el apodo elegido a mano («valeria» → Valeria Ríos) se aprende', aprendidos.some((a) => a.alias === 'valeria' && a.auxiliar_profile_id === 'aux-va1'), JSON.stringify(aprendidos));
  t('sin errores de script', U0.errors.length === 0, U0.errors.join(' | '));
}
{
  // Si la base dice que no (ya tiene una salida a esa hora), la hoja se queda abierta y lo dice.
  const U1 = await boot({ antes: (w) => {
    w.Api.listAuxiliares = async () => [{ id: 'aux-isa', name: 'Isabella Páez Gómez', active: true, deleted: false, res1: null }];
    w.Api.adminCreateReservation = async () => { throw new Error('Ya tiene una salida a esa hora (menos de 3 h): revísala en Reservas'); };
  } });
  const { q, qa, click, type } = U1;
  click(q('#rv2-julian')); await wait();
  type(q('#rj-ta'), '11:20 Isabella Paez (Marinilla)\nDeben estar 12:10');
  click(q('#rv2-sheet [data-rj="leer"]')); await wait(60);
  click(q('#rv2-sheet [data-rj="publicar"]')); await wait(120);
  const f = qa('#rj-prev .rj-p')[0];
  t('si no se puede crear su pedido, NO pasa al tablero: la hoja sigue abierta y dice por qué', !!f && /No se pudo crear su pedido: Ya tiene una salida a esa hora/.test(txt(f)) && !q('#rv2-sheet').hidden, f && txt(f));
  t('sin errores de script', U1.errors.length === 0, U1.errors.join(' | '));
}

t('sin errores de script (instancia base)', base.errors.length === 0, base.errors.join(' | '));
console.log(`\n${ok}/${ok + bad} pasaron${bad ? ` · ${bad} FALLARON` : ''}`);
console.log('NO cubierto: la base (_verify-0125.mjs), el layout real (ancho de la hoja, el select en un teléfono), la descarga real del archivo, los push reales y la app del conductor (driver-rutas.js: _smoke-rx-admin-coord-dom).');
process.exit(bad ? 1 : 0);
