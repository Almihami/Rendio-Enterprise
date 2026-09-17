// EL BALANCE POR HORAS REALES, DESPUÉS DEL MERGE main→dev (3-sep-2026).
//
// Por qué existe: ese módulo se hizo de urgencia directo sobre main el 25-jul y
// vivió un mes sin bajar a dev. Al fusionarlo, el riesgo no era que no
// compilara, sino que pidiera columnas que la base de dev no tuviera, o que
// core.js lo enganchara al botón viejo del CSV. Esto lo comprueba con los
// TURNOS REALES de dev, no con datos inventados.
//
// REQUIERE jsdom:  cd rendio-backend && npm install --no-save jsdom
//   node scripts/_smoke-balance-dom.mjs <shifts-dev.json>
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const SHIFTS = JSON.parse(readFileSync(process.argv[2], 'utf8'));

const dom = new JSDOM(readFileSync(APP + 'index.html', 'utf8'),
  { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom; global.window = window; global.document = window.document;
window.RENDIO_CONFIG = {}; window.toast = () => {};

let ok = 0, bad = 0;
const t = (n, c, d = '') => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d ? ' → ' + d : '')); } };

let pedido = null;
window.Api = {
  listShiftsForBalance: async (from, to) => { pedido = { from, to }; return SHIFTS; },
  listPublishedSchedules: async () => [],
  listAllDriversForAdmin: async () => [],
};
window.state = { settings: {}, currentWeek: '2026-08-24' }; global.state = window.state;
window.$ = (s) => window.document.querySelector(s);
window.escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
window.colorOfId = () => '#888';
window.initialsOf = (n) => String(n || '?').slice(0, 2).toUpperCase();

for (const f of ['admin-balance.js']) window.eval(readFileSync(APP + f, 'utf8'));

// ── 1 · la pantalla existe y es la nueva, no la del CSV ──
console.log('\n── el botón que quedó ──');
t('existe el botón de Excel (balance-xlsx)', !!window.$('#balance-xlsx'));
t('ya NO existe el botón viejo de CSV (balance-csv)', !window.$('#balance-csv'));
t('core.js engancha el de Excel', /balance-xlsx.*onDownloadBalanceXlsx/s.test(readFileSync(APP + 'core.js', 'utf8')));
t('core.js ya no engancha el de CSV', !/onDownloadBalanceCsv/.test(readFileSync(APP + 'core.js', 'utf8')));

// ── 2 · genera el informe con los turnos REALES de dev ──
console.log('\n── el informe, con los turnos reales de dev ──');
window.$('#balance-from').value = '2026-06-01';
window.$('#balance-to').value = '2026-09-30';
await window.onGenerateBalance();

const tabla = window.$('#balance-table').textContent.replace(/\s+/g, ' ');
const resumen = window.$('#balance-summary').textContent.replace(/\s+/g, ' ');
t('pidió el rango con huso de Bogotá (-05:00)', /T00:00:00-05:00$/.test(pedido?.from || ''), pedido?.from);
t('el «hasta» es exclusivo: pide el día siguiente', /2026-10-01/.test(pedido?.to || ''), pedido?.to);
t('no se quedó en «Calculando…»', !/Calculando/.test(tabla), tabla.slice(0, 90));
t('no salió el cartel de error', !/^Error/.test(tabla), tabla.slice(0, 90));
t('pintó la tabla de horas reales', /Horas reales por persona/.test(tabla), tabla.slice(0, 90));
t('dice que las horas son inicio→cierre', /horas = inicio→cierre/.test(tabla));

// ── 3 · los números cuadran con los datos ──
console.log('\n── los números ──');
const cerrados = SHIFTS.filter(s => s.status === 'closed').length;
const enCurso = SHIFTS.filter(s => !s.end_at).length;
const personas = new Set(SHIFTS.map(s => s.driver_profiles?.profiles?.full_name || s.driver_id)).size;
t(`cuenta los ${SHIFTS.length} turnos del rango`, new RegExp(`${SHIFTS.length} turnos`).test(tabla), tabla.slice(0, 140));
t(`el resumen habla de ${personas} persona(s)`, new RegExp(`${personas}\\s*Personas`).test(resumen), resumen);
t('el resumen trae las horas reales', /Horas reales trabajadas/.test(resumen), resumen);
const horas = Number((resumen.match(/([\d.]+)\s*h\s*Horas reales/) || [])[1]);
t('las horas totales son un número > 0', horas > 0, String(horas));
t('las horas son plausibles (< 24 h × turnos)', horas > 0 && horas < 24 * SHIFTS.length, String(horas));
t(`marca ${enCurso} turno(s) en curso`, tabla.includes('En curso'), '');

console.log(`\n${ok}/${ok + bad} pasaron${bad ? ` · ${bad} FALLARON` : ''}`);
process.exit(bad ? 1 : 0);
