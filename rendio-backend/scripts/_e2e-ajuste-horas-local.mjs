#!/usr/bin/env node
// _e2e-ajuste-horas-local.mjs — «Ajustar horas» en el Balance (0120,
// 25-oct-2026) con la app real (Playwright) y la base LOCAL:
//   1. el jefe genera el corte 10 → 24 oct y ve el botón en cada persona;
//   2. corrige el turno auto-cerrado de Carlos (la ventana abre en ese día, con
//      ese turno marcado y solo el inicio puesto) → sus horas suben 11 h 30;
//   3. un cruce con otro turno lo frena la base, con el mensaje en español;
//   4. agrega a Pedro (sin turnos) un turno que no quedó en la app;
//   5. el Excel trae la Hoja 4 y las Hojas 1–3 siguen cuadrando con la pantalla;
//   6. anula el de Pedro (queda en la lista como anulado) y la Revisión da la
//      misma cifra que el Balance;
//   7. Carlos, con su sesión, ve las horas ajustadas y la observación en «Mis horas».
//
//   (con node _seed-0120-local.mjs, el servidor ajuste-horas-local en :5200 y supabase start)
//   cd rendio-backend/scripts && node _e2e-ajuste-horas-local.mjs
//
// NUNCA toca dev ni producción.
import { readFileSync, mkdirSync } from 'node:fs';
import { localClient } from './_local-fixtures.mjs';

const PW = process.env.E2E_PLAYWRIGHT || '/Users/harold/Documents/Rendio-Drivers/.e2e-tools/node_modules/playwright/index.mjs';
const { chromium } = await import(PW);
const ExcelJS = (await import('exceljs')).default;
const APP = process.env.E2E_BASE || 'http://localhost:5200';
const OUT = '/Users/harold/Documents/Rendio-Drivers/.e2e-tools/run/ajuste-horas';
mkdirSync(OUT, { recursive: true });
const PASS = (readFileSync(new URL('./_seed-e2e-local.mjs', import.meta.url), 'utf8').match(/E2E_PASSWORD\s*=\s*'([^']+)'/) || [])[1];
const pg = await localClient();
const one = async (s, p) => (await pg.query(s, p)).rows[0];
let ok = 0, fail = 0;
const check = (n, c, d) => { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d != null ? ' → ' + d : ''}`); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const errores = [];
const vigilar = (p, quien) => {
  p.on('pageerror', e => errores.push(`${quien}: ${e.message}`));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|favicon/.test(m.text())) errores.push(`${quien}: ${m.text().slice(0, 200)}`); });
};
const nSeed = (await one(`SELECT count(*)::int n FROM public.shifts WHERE notes = 'PRUEBA-0120'`)).n;
if (nSeed !== 6) { console.error('Primero: node _seed-0120-local.mjs'); process.exit(2); }
const carlos = await one(`SELECT dp.id did FROM public.profiles p JOIN public.driver_profiles dp ON dp.profile_id = p.id WHERE p.email = 'carlos.local@rendio.test'`);

const entrar = async (p, email) => {
  await p.goto(APP + '/');
  await p.waitForSelector('#login-email', { state: 'visible', timeout: 20000 });
  await p.fill('#login-email', email); await p.fill('#login-password', PASS); await p.click('#login-submit');
  await p.waitForFunction(() => document.getElementById('screen-login')?.classList.contains('hidden'), null, { timeout: 25000 });
  await sleep(1500);
};
// Minutos de una persona en la tabla (lee el informe congelado, no el texto).
const minDe = (p, nombre) => p.evaluate(n => { const x = (state.balanceData?.list || []).find(r => r.name === n); return x ? x.okMin : null; }, nombre);
const generar = async p => {
  await p.evaluate(() => { document.getElementById('balance-from').value = '2026-10-10'; document.getElementById('balance-to').value = '2026-10-24'; });
  await p.evaluate(() => { window.__bdAntes = state.balanceData; });
  await p.click('#balance-generate');
  await p.waitForFunction(() => state.balanceData && state.balanceData !== window.__bdAntes && state.balanceData.fromV === '2026-10-10', null, { timeout: 15000 });
  await sleep(400);
};
const esperarRegenerado = async p => {
  await p.waitForFunction(() => state.balanceData && state.balanceData !== window.__bdAntes, null, { timeout: 15000 });
  await sleep(500);
};

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1320, height: 900 }, locale: 'es-CO', timezoneId: 'America/Bogota', acceptDownloads: true });
  const p = await ctx.newPage(); vigilar(p, 'jefe');
  console.log('\n1) El jefe abre el Balance del corte 10 → 24 oct');
  await entrar(p, 'jefe.local@rendio.test');
  await p.evaluate(() => setTab('balance'));
  await sleep(800);
  await generar(p);
  const botones = await p.locator('#balance-table [data-ah="ajustar"]').count();
  const filas = await p.evaluate(() => state.balanceData.list.filter(r => !String(r.id).startsWith('sinperfil:')).length);
  check(`un botón «Ajustar horas» por persona (${botones})`, botones > 0 && botones === filas, `${botones} vs ${filas}`);
  check('la lista «Ajustes manuales» sale vacía', /Todavía no hay ajustes/.test(await p.locator('#balance-table .bal-ajustes').innerText()));
  const carlosAntes = await minDe(p, 'Carlos Mejía');
  const totalAntes = await p.evaluate(() => state.balanceData.totalMin);
  await p.screenshot({ path: `${OUT}/01-balance.png`, fullPage: true });

  console.log('\n2) Corrige el auto-cerrado de Carlos');
  await p.click('#balance-table [data-ah="ajustar"][data-name="Carlos Mejía"]');
  await p.waitForSelector('#ah-modal .ah-opt', { timeout: 10000 });
  await sleep(300);
  // Abre en el ÚLTIMO auto-cerrado sin ajuste de esa persona en el informe (la
  // base local puede traer otros turnos de pruebas viejas: se calcula de ahí).
  const ultimoAuto = (await one(`SELECT max((start_at AT TIME ZONE 'America/Bogota')::date)::text d FROM public.shifts
    WHERE driver_id = $1 AND opening_km IS NOT NULL AND end_at IS NOT NULL AND closing_km IS NULL
      AND start_at >= '2026-10-10T00:00:00-05:00' AND start_at < '2026-10-25T00:00:00-05:00'`, [carlos.did])).d;
  check(`abre en el día de su último auto-cerrado (${ultimoAuto})`, (await p.inputValue('#ah-modal [data-f="dia"]')) === ultimoAuto);
  if (ultimoAuto !== '2026-10-15') {
    await p.fill('#ah-modal [data-f="dia"]', '2026-10-15'); await p.dispatchEvent('#ah-modal [data-f="dia"]', 'change');
    await p.waitForFunction(() => /Turno de 14:00/.test(document.querySelector('#ah-modal [data-f="opts"]')?.innerText || ''), null, { timeout: 10000 });
  }
  const marcado = await p.evaluate(() => document.querySelector('#ah-modal .ah-opt.on')?.innerText || '');
  check('viene marcado el turno auto-cerrado', /Auto-cerrado/.test(marcado), marcado);
  check('trae el inicio (14:00) y deja el cierre vacío', (await p.inputValue('#ah-modal [data-f="desde"]')) === '14:00' && (await p.inputValue('#ah-modal [data-f="hasta"]')) === '');
  await p.fill('#ah-modal [data-f="hasta"]', '01:30');
  const dur = await p.locator('#ah-modal [data-f="dur"]').innerText();
  check('dice cuánto queda y que termina al otro día', /11 h 30 min/.test(dur) && /termina el vie 16-oct/.test(dur), dur);
  await p.click('#ah-modal [data-usr="save"]');
  check('sin observación no guarda', /observación/i.test(await p.locator('#ah-modal [data-usr="err"]').innerText()));
  await p.fill('#ah-modal [data-f="nota"]', 'Se le apagó el celular a media jornada; el jefe de turno confirma que cerró a la 1:30 a. m.');
  await p.screenshot({ path: `${OUT}/02-ventana.png` });
  await p.evaluate(() => { window.__bdAntes = state.balanceData; });
  await p.click('#ah-modal [data-usr="save"]');
  await esperarRegenerado(p);
  check('la ventana se cierra', (await p.locator('#ah-modal').count()) === 0);
  const carlosDespues = await minDe(p, 'Carlos Mejía');
  check('Carlos sube exactamente 11 h 30 min', carlosDespues - carlosAntes === 690, `${carlosAntes} → ${carlosDespues}`);
  check('el total sube lo mismo', (await p.evaluate(() => state.balanceData.totalMin)) - totalAntes === 690);
  const filaCarlos = await p.locator('#balance-table tr', { hasText: 'Carlos Mejía' }).innerText();
  check('su fila lleva la marca ✎ 1', /✎ 1/.test(filaCarlos), filaCarlos.replace(/\s+/g, ' '));
  const lista = await p.locator('#balance-table .bal-ajustes').innerText();
  check('la lista muestra el ajuste: horas, origen, observación y quién', /14:00 → vie 16-oct 01:30/.test(lista) && /auto-cerrado/.test(lista) && /apagó el celular/.test(lista) && /Por Julián Prueba/.test(lista), lista.replace(/\s+/g, ' ').slice(0, 300));
  const turno = await one(`SELECT end_at, closing_km FROM public.shifts WHERE notes = 'PRUEBA-0120' AND driver_id = $1 AND start_at = '2026-10-15T14:00:00-05:00'`, [carlos.did]);
  check('el turno de la base sigue como estaba (13:00, sin km de cierre)', new Date(turno.end_at).toISOString() === new Date('2026-10-16T13:00:00-05:00').toISOString() && turno.closing_km == null);

  console.log('\n3) Un cruce lo frena la base');
  await p.click('#balance-table [data-ah="ajustar"][data-name="Carlos Mejía"]');
  await p.waitForSelector('#ah-modal .ah-opt', { timeout: 10000 });
  await p.fill('#ah-modal [data-f="dia"]', '2026-10-14'); await p.dispatchEvent('#ah-modal [data-f="dia"]', 'change');
  await p.waitForFunction(() => /Turno de 05:00/.test(document.querySelector('#ah-modal [data-f="opts"]')?.innerText || ''), null, { timeout: 10000 });
  await p.check('#ah-modal input[value="nuevo"]');
  await p.fill('#ah-modal [data-f="desde"]', '06:00'); await p.fill('#ah-modal [data-f="hasta"]', '08:00');
  await p.fill('#ah-modal [data-f="nota"]', 'Prueba de cruce con el turno de la mañana');
  await p.click('#ah-modal [data-usr="save"]');
  await p.waitForFunction(() => !document.querySelector('#ah-modal [data-usr="err"]')?.classList.contains('hidden'), null, { timeout: 10000 });
  const err = await p.locator('#ah-modal [data-usr="err"]').innerText();
  check('mensaje en español, sin código', /^Esas horas se cruzan con el turno del 14-10/.test(err), err);
  await p.screenshot({ path: `${OUT}/03-cruce.png` });
  await p.click('#ah-modal [data-usr="cancel"]');

  console.log('\n4) Pedro trabajó y no quedó en la app');
  await p.click('#balance-table [data-ah="otra"]');
  await p.waitForSelector('#ah-modal [data-f="pid"]');
  await p.selectOption('#ah-modal [data-f="pid"]', { label: 'Pedro Gil' });
  await p.fill('#ah-modal [data-f="dia"]', '2026-10-19'); await p.dispatchEvent('#ah-modal [data-f="dia"]', 'change');
  await p.waitForFunction(() => /No tiene turnos en la app ese día/.test(document.querySelector('#ah-modal [data-f="opts"]')?.innerText || ''), null, { timeout: 10000 });
  check('sin turnos ese día, viene marcado «Un turno que no quedó en la app»', /no quedó en la app/.test(await p.evaluate(() => document.querySelector('#ah-modal .ah-opt.on')?.innerText || '')));
  await p.fill('#ah-modal [data-f="desde"]', '05:00'); await p.fill('#ah-modal [data-f="hasta"]', '09:15');
  await p.fill('#ah-modal [data-f="nota"]', 'Cubrió la madrugada con el carro de Julián; no pudo iniciar en la app.');
  await p.evaluate(() => { window.__bdAntes = state.balanceData; });
  await p.click('#ah-modal [data-usr="save"]');
  await esperarRegenerado(p);
  check('Pedro aparece en la tabla con 4 h 15 min', (await minDe(p, 'Pedro Gil')) === 255, await minDe(p, 'Pedro Gil'));
  await p.screenshot({ path: `${OUT}/04-con-ajustes.png`, fullPage: true });

  console.log('\n5) El Excel');
  const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 15000 }), p.click('#balance-xlsx')]);
  const ruta = `${OUT}/balance.xlsx`; await dl.saveAs(ruta);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(ruta);
  const nombres = wb.worksheets.map(w => w.name);
  check('trae 4 hojas, la última «Ajustes manuales»', nombres.length === 4 && nombres[3] === 'Ajustes manuales', nombres.join(' | '));
  const totalMin = await p.evaluate(() => state.balanceData.totalMin);
  // exceljs devuelve las celdas [h]:mm como fecha desde el 30-dic-1899 (así
  // guarda Excel las duraciones); las fórmulas, como { result }.
  const aMin = v => {
    if (v && typeof v === 'object' && 'result' in v) v = v.result;
    if (v instanceof Date) return Math.round((v.getTime() - Date.UTC(1899, 11, 30)) / 60000);
    return Math.round(Number(v) * 1440);
  };
  const h3 = wb.getWorksheet('Resumen por persona');
  let totH3 = null; h3.eachRow(r => { if (r.getCell(1).value === 'Total') totH3 = aMin(r.getCell(3).value); });
  check('Hoja 3: el total = pantalla (con los ajustes)', totH3 === totalMin, `${totH3} vs ${totalMin}`);
  const h2 = wb.getWorksheet('Detalle turnos reales');
  let cuadra2 = false, motivo = '';
  h2.eachRow(r => { const v = String(r.getCell(8).value || ''); if (/Ajustado a mano/.test(v) && /Carlos/.test(String(r.getCell(3).value || ''))) motivo = v; if (/^TOTAL/.test(String(r.getCell(1).value || '')) && /Cuadra con la Hoja 1/.test(v)) cuadra2 = true; });
  check('Hoja 2: el turno dice quién, cuándo, la observación y cómo lo tenía la app', /Julián Prueba/.test(motivo) && /apagó el celular/.test(motivo) && /auto-cerrado/.test(motivo), motivo);
  check('Hoja 2 cuadra con las demás', cuadra2);
  const h1 = wb.getWorksheet('Publicado vs Trabajado');
  let cuadra1 = false; h1.eachRow(r => { if (/^TOTAL/.test(String(r.getCell(1).value || '')) && /cuadra con la Hoja 2/.test(String(r.getCell(4).value || ''))) cuadra1 = true; });
  check('Hoja 1 cuadra con las demás', cuadra1);
  const h4 = wb.getWorksheet('Ajustes manuales');
  const filas4 = []; h4.eachRow((r, i) => { if (i > 3) filas4.push(r.values.slice(1).map(v => (v && typeof v === 'object' && 'result' in v) ? v.result : v)); });
  check('Hoja 4: los 2 ajustes + el total', filas4.length === 3 && /2 vigentes/.test(String(filas4[2][0])), JSON.stringify(filas4.map(f => f[0])));
  check('Hoja 4: el de Carlos con 0 h antes y 11:30 ajustadas', aMin(filas4[0][5]) === 0 && aMin(filas4[0][6]) === 690, JSON.stringify(filas4[0]));

  console.log('\n6) Anula el de Pedro y mira la Revisión');
  const idPedro = await p.evaluate(() => state.balanceData.ajustes.find(a => a.driver_profiles?.profiles?.full_name === 'Pedro Gil').id);
  await p.click(`#balance-table [data-ah="anular"][data-id="${idPedro}"]`);
  await p.waitForSelector('#ah-anular-modal');
  await p.click('#ah-anular-modal [data-usr="save"]');
  check('sin motivo no anula', /por qué/.test(await p.locator('#ah-anular-modal [data-usr="err"]').innerText()));
  await p.fill('#ah-anular-modal [data-f="motivo"]', 'Me equivoqué de persona');
  await p.evaluate(() => { window.__bdAntes = state.balanceData; });
  await p.click('#ah-anular-modal [data-usr="save"]');
  await esperarRegenerado(p);
  check('Pedro sale de la tabla', (await minDe(p, 'Pedro Gil')) === null);
  const lista2 = await p.locator('#balance-table .bal-ajustes').innerText();
  check('…pero el ajuste sigue en la lista, anulado, con quién y por qué', /Anulado por Julián Prueba/.test(lista2) && /Me equivoqué de persona/.test(lista2) && /1 vigente · 1 anulado/.test(lista2), lista2.replace(/\s+/g, ' ').slice(0, 300));
  const fila = await one(`SELECT voided_at IS NOT NULL anulado FROM public.shift_hour_adjustments WHERE id = $1`, [idPedro]);
  check('en la base: la fila está, marcada como anulada', fila && fila.anulado);
  await p.screenshot({ path: `${OUT}/05-anulado.png`, fullPage: true });
  const balTotal = await p.evaluate(() => state.balanceData.totalMin);
  await p.evaluate(() => { revState.cual = 'anterior'; setTab('revision'); });
  await p.waitForFunction(() => revState.selloISO && !revState.cargando && revState.corte && revState.corte.from === '2026-10-10', null, { timeout: 20000 });
  const rev = await p.evaluate(() => {
    const ef = BalanceCore.conAjustes(revState.shifts, revState.ajustes);
    return { min: BalanceCore.minutosPagables(ef), txt: document.getElementById('revision-ui').innerText };
  });
  check('la Revisión da la misma cifra que el Balance', rev.min === balTotal, `${rev.min} vs ${balTotal}`);
  check('…y dice que incluye 1 ajuste manual', /Incluye 1 ajuste manual/.test(rev.txt));
  await ctx.close();

  console.log('\n7) Carlos ve su ajuste en «Mis horas»');
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'es-CO', timezoneId: 'America/Bogota' });
  const q = await ctx2.newPage(); vigilar(q, 'carlos');
  await entrar(q, 'carlos.local@rendio.test');
  const mis = await q.evaluate(async did => {
    const h = await dhCargarHoras(did);
    if (!h || h.error) return null;
    return { prev: h.prev.pagablesMin, html: dhVistaHtml(h).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') };
  }, carlos.did);
  check('su corte anterior suma lo mismo que su fila del Balance', mis && mis.prev === carlosDespues, mis && `${mis.prev} vs ${carlosDespues}`);
  check('el turno dice «Ajustado por el jefe» con la observación', mis && /Ajustado por el jefe: Se le apagó el celular/.test(mis.html), mis && mis.html.slice(0, 200));
  await ctx2.close();
} finally {
  await browser.close();
  await pg.end();
}
const malos = errores.filter(e => !/net::ERR|push|VAPID|service worker|ServiceWorker/i.test(e));
check('sin errores de JavaScript en la consola', malos.length === 0, malos.join(' | '));
console.log(`\n${ok} bien · ${fail} mal · capturas en ${OUT}`);
process.exit(fail ? 1 : 0);
