// BALANCE EN HORAS Y MINUTOS (11-oct-2026) — prueba jsdom.
//
// El jefe de operación pidió «cambiar las horas de decimales a horas y minutos»
// en toda la app. Esto carga la app real (index.html + scheduler.js +
// admin-balance.js, y para la Revisión admin-revision.js) con turnos de PRUEBA
// y un Api falso (nada sale a la red), y comprueba:
//   · BalanceCore.hm / hmHtml / hmCorto / diaExcel con los bordes (0, < 1 h,
//     hora exacta, negativos, basura) y la frontera del corte (enRango, delCorte:
//     un turno es del día en que ARRANCÓ, en hora de Bogotá);
//   · la pantalla del Balance: «48 h 53 min», el promedio al minuto, cada
//     persona, los auto-cerrados «1 · 23 h», el pie; ni un decimal de horas;
//   · el EXCEL (ExcelJS real del vendor, se vuelve a abrir el .xlsx): las celdas
//     de horas son NÚMEROS (minutos/1440) con formato [h]:mm en las 3 hojas y en
//     las filas de TOTAL; la suma de las celdas da EXACTAMENTE el total en las
//     tres hojas (Hoja 1 = Hoja 2 pagables = Hoja 3 = pantalla); los textos dicen
//     «Ana Prueba — 12:30 h»; y el aviso «¡DESCUADRE!» sigue saltando (en
//     minutos) si un total no cuadra;
//   · la Revisión del corte: la cifra grande y las frases en horas y minutos;
//   · Turnos activos y Eventualidades: «12 h 30 min», «hace 2 h 30 min».
//
// Con un archivo de turnos REALES (exportados de dev) se corre además la
// pantalla con ellos y se miran los mismos invariantes (sin decimales, totales):
//   node scripts/_smoke-balance-dom.mjs [shifts-dev.json]
//
// LO QUE NO CUBRE: layout (jsdom no lo hace: que «582 h 24 min» quepa en la
// tarjeta y en la columna de 230 px se mira en el navegador), cómo pinta Excel o
// LibreOffice el formato [h]:mm (aquí se lee el archivo, no se abre en Excel), la
// base real ni el service worker.
//
//   cd rendio-backend && node scripts/_smoke-balance-dom.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
const REALES = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], 'utf8')) : null;
let ok = 0, bad = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null && d !== '' ? ' → ' + d : '')); } };
const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));
const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
// Un decimal de horas pintado: «12.5 h», «582,3 h», «12.5h».
const DECIMAL_H = /\d+[.,]\d+\s*h\b/;

// ── turnos de PRUEBA (corte 25-sep → 9-oct-2026, se paga el 10-oct) ──────────
const dp = (pid, name) => ({ profile_id: pid, profiles: { full_name: name, email: pid + '@prueba.test' } });
const ANA = dp('p-ana', 'Ana Prueba'), BETO = dp('p-beto', 'Beto Prueba');
let n = 0;
const turno = (who, ini, fin, okm, ckm, o = {}) => ({
  id: 's-' + (++n), status: fin ? 'closed' : 'active', start_at: new Date(ini).toISOString(), end_at: fin ? new Date(fin).toISOString() : null,
  opening_km: okm, closing_km: ckm, driver_id: 'd-' + who.profile_id, driver_profiles: who,
  vehicle_id: 'v-1', vehicles: { internal_code: 'R01', license_plate: 'HNV760' }, fueled: null, notes: o.notes || null,
  created_at: new Date(ini).toISOString(), updated_at: fin ? new Date(fin).toISOString() : new Date(ini).toISOString(),
});
const SHIFTS = [
  turno(ANA, '2026-09-26T05:00:00-05:00', '2026-09-26T17:30:00-05:00', 1000, 1250),          // 12 h 30 min
  turno(ANA, '2026-09-27T14:10:00-05:00', '2026-09-28T02:03:00-05:00', 1250, 1400),          // 11 h 53 min (cruza la medianoche)
  turno(ANA, '2026-09-29T05:00:00-05:00', '2026-09-30T04:00:00-05:00', 1400, null,           // auto-cerrado 23 h
    { notes: 'CIERRE AUTOMÁTICO: turno activo más de 23h sin cerrar.' }),
  turno(ANA, '2026-09-30T05:00:00-05:00', '2026-09-30T05:20:00-05:00', null, null),          // arranque falso
  turno(BETO, '2026-10-01T01:30:00-05:00', '2026-10-01T13:45:00-05:00', 2000, 2200),         // 12 h 15 min (jornada PM)
  turno(BETO, '2026-10-02T05:00:00-05:00', '2026-10-02T05:45:00-05:00', 2200, 2210),         // 45 min
  turno(BETO, '2026-10-08T05:00:00-05:00', null, 2300, null),                                 // en curso
  turno(BETO, '2026-10-09T23:50:00-05:00', '2026-10-10T11:20:00-05:00', 2400, 2600),         // 11 h 30 min, último día
];
const MIN_ANA = 750 + 713, MIN_BETO = 735 + 45 + 690, MIN_TOTAL = MIN_ANA + MIN_BETO, MIN_AUTO = 1380;
const SCHEDS = [{ week_start_date: '2026-09-21', data: { _names: { 'p-ana': 'Ana Prueba', 'p-beto': 'Beto Prueba' }, sat: { morning: ['p-ana'], afternoon: [] } } }];

async function boot(o = {}) {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const errors = [], toasts = [];
  w.console.error = (...a) => errors.push(a.map(x => (x && x.message) || String(x)).join(' '));
  w.addEventListener('error', (e) => errors.push(e.message));
  if (o.excel) { try { w.eval(read('vendor/exceljs-4.4.0.min.js')); } catch (e) { errors.push('ExcelJS: ' + e.message); } }
  w.URL.createObjectURL = () => 'blob:prueba';
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () { (w.__descargas = w.__descargas || []).push(this.download); };
  // El Excel sale como Blob: se atrapa el buffer para volver a abrirlo.
  w.Blob = class { constructor(parts, opts) { (w.__blobs = w.__blobs || []).push({ parts, opts }); } };
  w.RENDIO_CONFIG = {};
  w.eval(`
    var $ = (s) => document.querySelector(s);
    var $$ = (s) => document.querySelectorAll(s);
    var escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    var colorOfId = () => '#888';
    var initialsOf = (n) => String(n || '?').slice(0, 2).toUpperCase();
    var state = { settings: { auto_close_hours: 23 }, currentWeek: '2026-09-21',
      drivers: [{ id: 'p-ana', name: 'Ana Prueba' }, { id: 'p-beto', name: 'Beto Prueba' }], admins: [] };
  `);
  w.toast = (m) => toasts.push(m);
  w.eval('var toast = window.toast;');
  const pedidos = [];
  w.Api = {
    listShiftsForBalance: async (from, to) => { pedidos.push({ from, to }); return JSON.parse(JSON.stringify(o.shifts || SHIFTS)); },
    listPublishedSchedules: async () => JSON.parse(JSON.stringify(SCHEDS)),
    listAllDriversForAdmin: async () => [],
    listShiftsForReview: async () => JSON.parse(JSON.stringify(o.shifts || SHIFTS)),
    listInspectionsForShifts: async () => [],
    listFuelReceiptsForShifts: async () => [],
    getSettings: async () => ({ auto_close_hours: 23 }),
  };
  for (const f of ['scheduler.js', 'admin-balance.js', 'admin-revision.js', 'admin-turnos-activos.js', 'admin-eventualidades.js']) {
    try { w.eval(read(f)); } catch (e) { errors.push(f + ': ' + e.message); }
  }
  return { w, errors, toasts, pedidos, q: (s) => w.document.querySelector(s) };
}

// ══════════════════════════════════════════════════════════════════
console.log('\n── BalanceCore: horas y minutos ──');
{
  const b = await boot();
  const BC = b.w.BalanceCore;
  t('BalanceCore expone hm, hmHtml, hmCorto, diaExcel, HM_FMT, limitesDe, enRango, delCorte',
    ['hm', 'hmHtml', 'hmCorto', 'diaExcel', 'limitesDe', 'enRango', 'diaDeArranque', 'delCorte'].every(k => typeof BC[k] === 'function') && BC.HM_FMT === '[h]:mm');
  const casos = [[0, '0 h'], [45, '45 min'], [60, '1 h'], [61, '1 h 1 min'], [5790, '96 h 30 min'], [777, '12 h 57 min'],
    [-5, '0 h'], [null, '0 h'], ['basura', '0 h'], [59.6, '1 h'], [1440 * 3 + 1, '72 h 1 min']];
  casos.forEach(([m, e]) => t(`hm(${JSON.stringify(m)}) = «${e}»`, BC.hm(m) === e, BC.hm(m)));
  t('hmHtml(5790) = 96<s> h</s> 30<s> min</s>', BC.hmHtml(5790) === '96<s> h</s> 30<s> min</s>', BC.hmHtml(5790));
  t('hmHtml(45) / hmHtml(0)', BC.hmHtml(45) === '45<s> min</s>' && BC.hmHtml(0) === '0<s> h</s>');
  t('hmCorto(750) = 12:30 · hmCorto(45) = 0:45 · hmCorto(6000) = 100:00', BC.hmCorto(750) === '12:30' && BC.hmCorto(45) === '0:45' && BC.hmCorto(6000) === '100:00');
  t('diaExcel(1440) = 1 · diaExcel(720) = 0.5 · negativos → 0', BC.diaExcel(1440) === 1 && BC.diaExcel(720) === 0.5 && BC.diaExcel(-30) === 0);
  const lim = BC.limitesDe('2026-09-25', '2026-10-09');
  t('limitesDe: [25-sep 00:00 -05:00, 10-oct 00:00 -05:00)', lim.desde === '2026-09-25T00:00:00-05:00' && lim.hasta === '2026-10-10T00:00:00-05:00', JSON.stringify(lim));
  const en = (iso) => BC.enRango({ start_at: new Date(iso).toISOString() }, '2026-09-25', '2026-10-09');
  t('enRango: 9-oct 23:59 Bogotá SÍ (aunque en UTC ya sea 10-oct)', en('2026-10-09T23:59:00-05:00'));
  t('enRango: 10-oct 00:00 Bogotá NO', !en('2026-10-10T00:00:00-05:00'));
  t('enRango: 25-sep 00:00 SÍ · 24-sep 23:59:59 NO', en('2026-09-25T00:00:00-05:00') && !en('2026-09-24T23:59:59-05:00'));
  const dc = BC.delCorte(SHIFTS, BC.corteDe('2026-10-01'));
  t('delCorte(25-sep→9-oct): 8 turnos, pagables = 48 h 53 min, 1 auto, 1 en curso, 1 falso',
    dc.turnos.length === 8 && dc.pagablesMin === MIN_TOTAL && dc.ok === 5 && dc.auto === 1 && dc.curso === 1 && dc.falso === 1, JSON.stringify({ ...dc, turnos: dc.turnos.length }));
  t('delCorte del corte siguiente (10→24 oct): ninguno (el del 9-oct 23:50 es del 9)', BC.delCorte(SHIFTS, BC.corteDe('2026-10-15')).turnos.length === 0);
  t('sin errores al cargar', b.errors.length === 0, b.errors.join(' | '));
}

// ══════════════════════════════════════════════════════════════════
console.log('\n── Pantalla del Balance ──');
const B = await boot({ excel: true });
{
  const { w, q } = B;
  q('#balance-from').value = '2026-09-25';
  q('#balance-to').value = '2026-10-09';
  await w.onGenerateBalance();
  const resumen = txt(q('#balance-summary')), tabla = txt(q('#balance-table'));
  t('pidió el rango con huso de Bogotá: [25-sep 00:00, 10-oct 00:00) -05:00', B.pedidos[0] && B.pedidos[0].from === '2026-09-25T00:00:00-05:00' && B.pedidos[0].to === '2026-10-10T00:00:00-05:00', JSON.stringify(B.pedidos[0]));
  t('tarjeta: «48 h 53 min» Horas reales trabajadas', /48 h 53 min\s*Horas reales trabajadas/.test(resumen), resumen);
  t('tarjeta: promedio por persona al minuto «24 h 27 min»', /24 h 27 min\s*Promedio por persona/.test(resumen), resumen);
  t('la cifra grande lleva las unidades en <s> (mismo estilo)', /48<s> h<\/s> 53<s> min<\/s>/.test(q('#balance-summary .bal-scard.accent .n').innerHTML), q('#balance-summary .bal-scard.accent .n').innerHTML);
  const filas = [...q('#balance-table tbody').querySelectorAll('tr')].map(tr => [...tr.children].map(td => txt(td)));
  t('Beto primero (más minutos) con «24 h 30 min»', filas[0] && /Beto Prueba/.test(filas[0][0]) && filas[0][2] === '24 h 30 min', JSON.stringify(filas[0]));
  t('Ana con «24 h 23 min» y auto-cerrados «1 · 23 h»', filas[1] && filas[1][2] === '24 h 23 min' && filas[1][3] === '1 · 23 h', JSON.stringify(filas[1]));
  const pie = [...q('#balance-table tfoot tr').children].map(td => txt(td));
  t('pie: «48 h 53 min» y auto «1 · 23 h»', pie[2] === '48 h 53 min' && pie[3] === '1 · 23 h', JSON.stringify(pie));
  t('ni un decimal de horas en pantalla', !DECIMAL_H.test(resumen + ' ' + tabla), (resumen + tabla).match(DECIMAL_H));
  t('el informe quedó congelado con los minutos del motor', w.state.balanceData && w.state.balanceData.totalMin === MIN_TOTAL && w.state.balanceData.totalAutoMin === MIN_AUTO);
}

console.log('\n── Excel (ExcelJS real, se vuelve a abrir) ──');
let ultimoXlsx = null;
async function bajarExcel() {
  B.w.__blobs = [];
  await B.w.onDownloadBalanceXlsx();
  const blob = (B.w.__blobs || [])[0];
  if (!blob) return null;
  ultimoXlsx = Buffer.from(blob.parts[0]);
  const wb = new B.w.ExcelJS.Workbook();
  await wb.xlsx.load(blob.parts[0]);
  return wb;
}
// Al volver a abrir el archivo, ExcelJS convierte en fecha todo número que tenga
// un formato de hora ([h]:mm incluido). Para leer la duración se pasa de vuelta
// a número de serie de Excel (días desde 30-dic-1899) — y aparte se mira el XML
// crudo para confirmar que en el archivo lo que va es un NÚMERO.
const serie = (v) => (typeof v === 'number' ? v
  : Object.prototype.toString.call(v) === '[object Date]' ? (v.getTime() - Date.UTC(1899, 11, 30)) / 86400000 : NaN);
// Lector mínimo de .xlsx (es un zip): devuelve el texto de una entrada.
function entradaZip(buf, nombre) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) return null;
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < total; i++) {
    const metodo = buf.readUInt16LE(p + 10), comp = buf.readUInt32LE(p + 20);
    const ln = buf.readUInt16LE(p + 28), lx = buf.readUInt16LE(p + 30), lc = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const nom = buf.toString('utf8', p + 46, p + 46 + ln);
    if (nom === nombre) {
      const ini = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const datos = buf.subarray(ini, ini + comp);
      return (metodo === 8 ? inflateRawSync(datos) : datos).toString('utf8');
    }
    p += 46 + ln + lx + lc;
  }
  return null;
}
// La celda tal como quedó en el XML de la hoja: { t, s, v } (t vacío = número).
function celdaXml(buf, hoja, ref) {
  const xml = entradaZip(buf, `xl/worksheets/sheet${hoja}.xml`) || '';
  const m = new RegExp(`<c r="${ref}"([^>]*)>(?:<f>[^<]*</f>)?<v>([^<]*)</v>`).exec(xml);
  if (!m) return null;
  const t = (/\st="([^"]+)"/.exec(m[1]) || [])[1] || '';
  const s = (/\ss="([^"]+)"/.exec(m[1]) || [])[1] || '';
  return { t, s, v: m[2] };
}
// ¿El estilo s de la celda usa el formato [h]:mm? (styles.xml: numFmts + cellXfs)
function estiloEsHm(buf, s) {
  const xml = entradaZip(buf, 'xl/styles.xml') || '';
  const fmts = {};
  (xml.match(/<numFmt [^>]*>/g) || []).forEach(n => { const id = (/numFmtId="(\d+)"/.exec(n) || [])[1]; const code = (/formatCode="([^"]*)"/.exec(n) || [])[1]; fmts[id] = code; });
  const xfs = ((/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml) || [])[1] || '').match(/<xf [^>]*>/g) || [];
  const xf = xfs[Number(s)];
  const id = xf && (/numFmtId="(\d+)"/.exec(xf) || [])[1];
  return !!id && fmts[id] === '[h]:mm';
}
const filasDe = (ws) => { const out = []; ws.eachRow((row, i) => out.push({ i, row })); return out; };
const fila = (ws, re) => filasDe(ws).find(r => re.test(String(r.row.getCell(1).value || '')));
const cerca = (a, b) => Math.abs(a - b) < 1e-9;
{
  const { w } = B;
  t('ExcelJS cargó en jsdom', !!w.ExcelJS && typeof w.ExcelJS.Workbook === 'function');
  const wb = await bajarExcel();
  t('el .xlsx se descargó con el nombre del corte', (w.__descargas || []).includes('balance_detallado_2026-09-25_a_2026-10-09_PROVISIONAL.xlsx'), JSON.stringify(w.__descargas));
  t('se vuelve a abrir y trae las 3 hojas', !!wb && wb.worksheets.map(s => s.name).join('|') === 'Publicado vs Trabajado|Detalle turnos reales|Resumen por persona', wb && wb.worksheets.map(s => s.name).join('|'));
  if (wb) {
    const H1 = wb.getWorksheet('Publicado vs Trabajado'), H2 = wb.getWorksheet('Detalle turnos reales'), H3 = wb.getWorksheet('Resumen por persona');
    // Hoja 1: celdas día+jornada en la columna E.
    const t1 = fila(H1, /^TOTAL · /);
    const dias = filasDe(H1).filter(r => r.i >= 4 && t1 && r.i < t1.i);
    t('Hoja 1: 15 días × 2 jornadas = 30 filas', dias.length === 30, dias.length);
    const e = dias.map(r => r.row.getCell(5));
    t('Hoja 1: «Horas verif.» llevan formato [h]:mm', e.every(c => c.numFmt === '[h]:mm' && Number.isFinite(serie(c.value))), JSON.stringify(e.slice(0, 3).map(c => [c.value, c.numFmt])));
    const crudo = celdaXml(ultimoXlsx, 1, 'E' + t1.i);
    t('Hoja 1: en el ARCHIVO la celda del TOTAL es un número (sin t="s"/"str"/"d") con estilo [h]:mm', crudo && crudo.t === '' && cerca(Number(crudo.v) * 1440, MIN_TOTAL) && estiloEsHm(ultimoXlsx, crudo.s), JSON.stringify(crudo));
    const crudoDia = celdaXml(ultimoXlsx, 1, 'E' + dias[2].i);
    t('Hoja 1: …y la de un día también (12:30 = 0,520833…)', crudoDia && crudoDia.t === '' && cerca(Number(crudoDia.v) * 1440, 750) && estiloEsHm(ultimoXlsx, crudoDia.s), JSON.stringify(crudoDia));
    const suma1 = e.reduce((a, c) => a + serie(c.value), 0);
    t('Hoja 1: sumar la columna da EXACTAMENTE 48:53 (2933 min)', cerca(suma1 * 1440, MIN_TOTAL), suma1 * 1440);
    t('Hoja 1: TOTAL = 2933/1440 con [h]:mm y «cuadra»', t1 && cerca(serie(t1.row.getCell(5).value) * 1440, MIN_TOTAL) && t1.row.getCell(5).numFmt === '[h]:mm' && /cuadra con la Hoja 2/.test(String(t1.row.getCell(4).value)),
      t1 && JSON.stringify([t1.row.getCell(4).value, t1.row.getCell(5).value]));
    const sab = dias.find(r => /^Sáb 26-sep/.test(r.row.getCell(1).value) && r.row.getCell(2).value === 'AM');
    t('Hoja 1: texto «Ana Prueba — 12:30 h» (no «12.5h»)', sab && sab.row.getCell(4).value === 'Ana Prueba — 12:30 h' && sab.row.getCell(3).value === 'Ana Prueba', sab && JSON.stringify([sab.row.getCell(3).value, sab.row.getCell(4).value]));
    const mar = dias.find(r => /^Mar 29-sep/.test(r.row.getCell(1).value) && r.row.getCell(2).value === 'AM');
    t('Hoja 1: el auto-cerrado «Ana Prueba — 23:00 h (auto, NO pagable)» y la celda en 0:00', mar && mar.row.getCell(4).value === 'Ana Prueba — 23:00 h (auto, NO pagable)' && serie(mar.row.getCell(5).value) === 0, mar && JSON.stringify([mar.row.getCell(4).value, mar.row.getCell(5).value]));
    const jue = dias.find(r => /^Jue 1-oct/.test(r.row.getCell(1).value) && r.row.getCell(2).value === 'PM');
    t('Hoja 1: el de la 1:30 a. m. va a la jornada PM del MISMO día: «Beto Prueba — 12:15 h»', jue && jue.row.getCell(4).value === 'Beto Prueba — 12:15 h' && cerca(serie(jue.row.getCell(5).value) * 1440, 735), jue && JSON.stringify([jue.row.getCell(4).value, jue.row.getCell(5).value]));
    const vie = dias.find(r => /^Vie 2-oct/.test(r.row.getCell(1).value) && r.row.getCell(2).value === 'AM');
    t('Hoja 1: el de 45 min «Beto Prueba — 0:45 h»', vie && vie.row.getCell(4).value === 'Beto Prueba — 0:45 h', vie && vie.row.getCell(4).value);
    const exc = filasDe(H1).find(r => /Arranque falso/.test(String(r.row.getCell(7).value || '')));
    t('Hoja 1 · Excluidos: el arranque falso con 0 en [h]:mm', exc && serie(exc.row.getCell(6).value) === 0 && exc.row.getCell(6).numFmt === '[h]:mm', exc && JSON.stringify([exc.row.getCell(6).value, exc.row.getCell(6).numFmt]));
    // Hoja 2: un turno por fila.
    const det = filasDe(H2).filter(r => r.i >= 4 && !/^TOTAL/.test(String(r.row.getCell(1).value || '')));
    t('Hoja 2: 8 turnos', det.length === 8, det.length);
    t('Hoja 2: pagables y NO pagables con formato [h]:mm', det.every(r => r.row.getCell(6).numFmt === '[h]:mm' && Number.isFinite(serie(r.row.getCell(6).value)) && r.row.getCell(7).numFmt === '[h]:mm' && Number.isFinite(serie(r.row.getCell(7).value))));
    const pag = det.reduce((a, r) => a + serie(r.row.getCell(6).value), 0), nopag = det.reduce((a, r) => a + serie(r.row.getCell(7).value), 0);
    const t2 = fila(H2, /^TOTAL · /);
    const crudo2 = t2 && celdaXml(ultimoXlsx, 2, 'F' + t2.i);
    t('Hoja 2: en el archivo el TOTAL pagable es un número con [h]:mm', crudo2 && crudo2.t === '' && cerca(Number(crudo2.v) * 1440, MIN_TOTAL) && estiloEsHm(ultimoXlsx, crudo2.s), JSON.stringify(crudo2));
    t('Hoja 2: suma de pagables = TOTAL = 48:53 (= Hoja 1)', cerca(pag * 1440, MIN_TOTAL) && t2 && cerca(serie(t2.row.getCell(6).value) * 1440, MIN_TOTAL) && t2.row.getCell(6).numFmt === '[h]:mm', JSON.stringify([pag * 1440, t2 && serie(t2.row.getCell(6).value) * 1440]));
    t('Hoja 2: suma de NO pagables = TOTAL = 23:00 (solo el auto)', cerca(nopag * 1440, MIN_AUTO) && t2 && cerca(serie(t2.row.getCell(7).value) * 1440, MIN_AUTO), nopag * 1440);
    t('Hoja 2: el TOTAL dice que cuadra', t2 && /Cuadra con la Hoja 1, la Hoja 3 y la pantalla/.test(String(t2.row.getCell(8).value)), t2 && t2.row.getCell(8).value);
    // Hoja 3: una fila por persona.
    const per = filasDe(H3).filter(r => r.i >= 4 && r.row.getCell(1).value !== 'Total');
    const beto = per.find(r => r.row.getCell(1).value === 'Beto Prueba'), ana = per.find(r => r.row.getCell(1).value === 'Ana Prueba');
    t('Hoja 3: Beto 24:30 y Ana 24:23 ([h]:mm)', beto && ana && cerca(serie(beto.row.getCell(3).value) * 1440, MIN_BETO) && cerca(serie(ana.row.getCell(3).value) * 1440, MIN_ANA) && ana.row.getCell(3).numFmt === '[h]:mm',
      JSON.stringify([beto && serie(beto.row.getCell(3).value) * 1440, ana && serie(ana.row.getCell(3).value) * 1440]));
    t('Hoja 3: horas auto de Ana 23:00 en [h]:mm', ana && cerca(serie(ana.row.getCell(5).value) * 1440, MIN_AUTO) && ana.row.getCell(5).numFmt === '[h]:mm');
    const t3 = fila(H3, /^Total$/);
    const crudo3 = t3 && celdaXml(ultimoXlsx, 3, 'C' + t3.i);
    t('Hoja 3: en el archivo el Total es un número con [h]:mm (48:53 pasa de 24 h sin volver a cero)', crudo3 && crudo3.t === '' && cerca(Number(crudo3.v) * 1440, MIN_TOTAL) && estiloEsHm(ultimoXlsx, crudo3.s), JSON.stringify(crudo3));
    t('Hoja 3: Total = suma de las personas = 48:53 = Hoja 1 = Hoja 2', t3 && cerca(serie(t3.row.getCell(3).value) * 1440, MIN_TOTAL) && cerca(per.reduce((a, r) => a + serie(r.row.getCell(3).value), 0) * 1440, MIN_TOTAL) && t3.row.getCell(3).numFmt === '[h]:mm');
    t('Hoja 3: Total auto 23:00 en [h]:mm', t3 && cerca(serie(t3.row.getCell(5).value) * 1440, MIN_AUTO) && t3.row.getCell(5).numFmt === '[h]:mm');
    t('Hoja 3: «Valor a pagar» sigue siendo fórmula SUM en pesos', t3 && t3.row.getCell(8).value && /SUM\(H4:H5\)/.test(t3.row.getCell(8).value.formula));
    const todo = JSON.stringify(wb.worksheets.map(s => { const a = []; s.eachRow(r => a.push(r.values)); return a; }));
    t('ni un decimal de horas en el Excel («12.5h»)', !/\d+\.\d+ ?h\b/.test(todo), todo.match(/\d+\.\d+ ?h\b/));
    t('sin «¡DESCUADRE!» cuando todo cuadra', !/DESCUADRE/.test(todo));
  }
  // El chequeo sigue vivo: si un total no cuadra (aquí se le suman 7 minutos al
  // congelado), la Hoja 1 y la Hoja 2 lo gritan, y en horas y minutos.
  w.state.balanceData.totalMin += 7;
  const wb2 = await bajarExcel();
  w.state.balanceData.totalMin -= 7;
  if (wb2) {
    const t1 = fila(wb2.getWorksheet('Publicado vs Trabajado'), /^TOTAL · /), t2 = fila(wb2.getWorksheet('Detalle turnos reales'), /^TOTAL · /);
    t('descuadre de 7 min: Hoja 1 dice «¡DESCUADRE! la Hoja 3 dice 49 h»', t1 && /¡DESCUADRE! la Hoja 3 dice 49 h —/.test(String(t1.row.getCell(4).value)), t1 && t1.row.getCell(4).value);
    t('descuadre de 7 min: Hoja 2 también', t2 && /¡DESCUADRE! la Hoja 3 dice 49 h —/.test(String(t2.row.getCell(8).value)), t2 && t2.row.getCell(8).value);
  } else t('se pudo volver a bajar el Excel', false);
  t('sin errores de consola', B.errors.length === 0, B.errors.slice(0, 3).join(' | '));
}

// ══════════════════════════════════════════════════════════════════
console.log('\n── Revisión del corte ──');
{
  const { w, q } = B;
  await w.renderRevision();
  await wait(20);
  const ui = q('#revision-ui');
  const cifra = [...ui.querySelectorAll('div')].find(d => /^Horas pagables acumuladas del corte$/.test(txt(d)));
  const grande = cifra && cifra.nextElementSibling;
  t('la cifra grande: «48 h 53 min» (misma que el Balance)', grande && txt(grande) === '48 h 53 min', grande && txt(grande));
  t('…con las unidades pequeñas (<s>)', grande && grande.querySelectorAll('s').length === 2);
  const todo = txt(ui);
  t('el auto-cerrado dice «o sea 23 h»', /o sea 23 h\./.test(todo), (todo.match(/o sea [^.]*\./) || [])[0]);
  t('el turno corto dice «Turno de 45 min»', /Turno de 45 min/.test(todo));
  t('el turno abierto dice cuánto lleva en h y min (no «19.4 h»)', /Beto Prueba lleva \d+ h( \d+ min)? abierto/.test(todo), (todo.match(/Beto Prueba lleva [^.]*abierto/) || [])[0]);
  t('ni un decimal de horas en la Revisión', !DECIMAL_H.test(todo), todo.match(DECIMAL_H));
}

console.log('\n── Turnos activos y Eventualidades ──');
{
  const { w } = B;
  const hace = (min) => new Date(Date.now() - min * 60000).toISOString();
  t('Turnos activos: 12,5 h → «12 h 30 min»', w.fmtShiftAgo({ start_at: hace(750) }) === '12 h 30 min', w.fmtShiftAgo({ start_at: hace(750) }));
  t('Turnos activos: 30 min → «30 min» · 3 h → «3 h» · 50 h → «2 días»', w.fmtShiftAgo({ start_at: hace(30) }) === '30 min' && w.fmtShiftAgo({ start_at: hace(180) }) === '3 h' && w.fmtShiftAgo({ start_at: hace(3000) }) === '2 días');
  t('Eventualidades: «hace 2 h 30 min» (no «hace 2.5 h»)', w.evtAgo(hace(150)) === 'hace 2 h 30 min', w.evtAgo(hace(150)));
  t('Eventualidades: «hace 12 h» · «hace 3 días»', w.evtAgo(hace(720)) === 'hace 12 h' && w.evtAgo(hace(72 * 60)) === 'hace 3 días', w.evtAgo(hace(720)));
}

if (REALES) {
  console.log('\n── Con los turnos REALES del archivo ──');
  const R = await boot({ shifts: REALES });
  R.q('#balance-from').value = '2026-06-01';
  R.q('#balance-to').value = '2026-12-31';
  await R.w.onGenerateBalance();
  const tabla = txt(R.q('#balance-table')), resumen = txt(R.q('#balance-summary'));
  t('pintó la tabla de horas reales', /Horas reales por persona/.test(tabla), tabla.slice(0, 120));
  t('ni un decimal de horas', !DECIMAL_H.test(tabla + resumen), (tabla + resumen).match(DECIMAL_H));
  const bd = R.w.state.balanceData;
  t('el total del resumen es el del motor', bd && resumen.includes(R.w.BalanceCore.hm(bd.totalMin)), bd && R.w.BalanceCore.hm(bd.totalMin));
}

console.log(`\n${ok}/${ok + bad} pasaron${bad ? ` · ${bad} FALLARON` : ''}`);
console.log('NO cubre: layout (que las cifras quepan), cómo pinta Excel el [h]:mm al abrirlo, la base real.');
process.exit(bad ? 1 : 0);
