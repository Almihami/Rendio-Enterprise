// _excel-pruebas.mjs — Arma el Excel de evidencia de las pruebas (UNA hoja).
//
// Entrada: uno o más JSON con filas { id, rol, requerimiento, implementacion,
// pasos, esperado, obtenido, estado, captura, nota } y la carpeta donde están
// las capturas. Cada captura se achica (sips de macOS) y se incrusta en la fila.
//
//   node scripts/_excel-pruebas.mjs <salida.xlsx> <carpeta-capturas> <a.json> [b.json …]
import ExcelJS from 'exceljs';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename } from 'node:path';

const [OUT, SHOTS, ...JSONS] = process.argv.slice(2);
if (!OUT || !SHOTS || !JSONS.length) { console.error('uso: _excel-pruebas.mjs <salida.xlsx> <carpeta-capturas> <a.json> …'); process.exit(2); }
const rows = JSONS.flatMap(f => JSON.parse(readFileSync(f, 'utf8')));
const ORDEN = { Tripulante: 1, Conductor: 2, Admin: 3, Sistema: 4 };
rows.sort((a, b) => (ORDEN[a.rol] || 9) - (ORDEN[b.rol] || 9));

const THUMBS = join(SHOTS, '_mini'); mkdirSync(THUMBS, { recursive: true });
function mini(file) {
  if (!file) return null;
  const src = join(SHOTS, file);
  if (!existsSync(src)) return null;
  const dst = join(THUMBS, basename(file).replace(/\.png$/i, '') + '.jpg');
  if (!existsSync(dst)) execFileSync('sips', ['-Z', '520', '-s', 'format', 'jpeg', '-s', 'formatOptions', '72', src, '--out', dst], { stdio: 'ignore' });
  return dst;
}
// Tamaño de la miniatura para que quepa en la celda conservando la proporción.
function dims(file) {
  const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { encoding: 'utf8' });
  const w = Number((out.match(/pixelWidth: (\d+)/) || [])[1]) || 520;
  const h = Number((out.match(/pixelHeight: (\d+)/) || [])[1]) || 520;
  const maxW = 300, maxH = 300, k = Math.min(maxW / w, maxH / h);
  return { width: Math.round(w * k), height: Math.round(h * k) };
}

const wb = new ExcelJS.Workbook();
wb.creator = 'Rendio · pruebas de punta a punta';
const ws = wb.addWorksheet('Pruebas', { views: [{ state: 'frozen', ySplit: 6 }] });
const COLS = [
  ['N°', 6], ['Rol', 12], ['Requerimiento', 34], ['Implementación', 40], ['Pasos de la prueba', 40],
  ['Resultado esperado', 32], ['Resultado obtenido', 44], ['Estado', 11], ['Evidencia', 44],
];
ws.columns = COLS.map(([, w]) => ({ width: w }));
const INK = 'FF1E1C19', ORANGE = 'FFE2551A';
const ok = rows.filter(r => r.estado === 'OK').length;
const otros = ['FALLA', 'PARCIAL', 'NO PROBADO'].map(e => `${rows.filter(r => r.estado === e).length} ${e.toLowerCase()}`).join(' · ');
ws.mergeCells('A1:I1'); ws.getCell('A1').value = 'Rendio · Pruebas de punta a punta (admin, tripulante y conductor)';
ws.getCell('A1').font = { name: 'Arial', size: 16, bold: true, color: { argb: INK } };
ws.mergeCells('A2:I2'); ws.getCell('A2').value = `Corrida: ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })} (hora Bogotá) · Ambiente: copia LOCAL de la app con base de datos local (cuentas de prueba) · Mismo código que queda en dev`;
ws.mergeCells('A3:I3'); ws.getCell('A3').value = `Resultado: ${ok} de ${rows.length} OK · ${otros}`;
ws.getCell('A3').font = { name: 'Arial', size: 12, bold: true, color: { argb: ORANGE } };
ws.mergeCells('A4:I4'); ws.getCell('A4').value = 'Lo que una prueba automática NO cubre: que el aviso suene en un teléfono real (aquí se verifica el aviso que sale del servidor), el GPS real de la calle y cómo se ve en cada modelo de celular. Eso se mira en el teléfono.';
[2, 4].forEach(r => { ws.getCell('A' + r).font = { name: 'Arial', size: 10, color: { argb: 'FF5F5B55' } }; ws.getCell('A' + r).alignment = { wrapText: true, vertical: 'top' }; });
ws.getRow(4).height = 30;
const head = ws.getRow(6);
COLS.forEach(([t], i) => {
  const c = head.getCell(i + 1); c.value = t;
  c.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
  c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: INK } };
  c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
});
head.height = 28;
const BORDE = { top: { style: 'thin', color: { argb: 'FFE7E5DF' } }, bottom: { style: 'thin', color: { argb: 'FFE7E5DF' } }, left: { style: 'thin', color: { argb: 'FFE7E5DF' } }, right: { style: 'thin', color: { argb: 'FFE7E5DF' } } };
const COLOR = { OK: 'FFD8F3E8', FALLA: 'FFFBE0DD', PARCIAL: 'FFFBEFD5', 'NO PROBADO': 'FFEDEDEA' };
let r = 7;
rows.forEach((x, i) => {
  const row = ws.getRow(r);
  const vals = [i + 1, x.rol, x.requerimiento, x.implementacion, x.pasos, x.esperado, x.obtenido + (x.nota ? `\n\nNo cubre: ${x.nota}` : ''), x.estado, x.captura ? '' : '(sin captura: verificación en la base de datos)'];
  vals.forEach((v, k) => {
    const c = row.getCell(k + 1); c.value = v == null ? '' : v;
    c.font = { name: 'Arial', size: 9.5, bold: k === 7 };
    c.alignment = { vertical: 'top', wrapText: true, horizontal: k === 0 || k === 7 ? 'center' : 'left' };
    c.border = BORDE;
  });
  row.getCell(8).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR[x.estado] || 'FFFFFFFF' } };
  const img = mini(x.captura);
  if (img) {
    const d = dims(img);
    const id = wb.addImage({ filename: img, extension: 'jpeg' });
    ws.addImage(id, { tl: { col: 8.05, row: r - 1 + 0.05 }, ext: d });
    row.height = Math.max(60, d.height * 0.78 + 8);
  } else {
    row.height = 90;
  }
  r++;
});
ws.autoFilter = { from: 'A6', to: 'I6' };
await wb.xlsx.writeFile(OUT);
console.log(`Excel: ${OUT} · ${rows.length} pruebas · ${ok} OK`);
