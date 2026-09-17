// Prueba directa de rtDurProg contra los ejemplos que dio Julián.
import { readFileSync } from 'node:fs';
const RUTAS_JS = new URL('../../rendio-turnos/admin-rutas.js', import.meta.url).pathname;
const CONSOLA_JS = new URL('../../rendio-turnos/admin-consola.js', import.meta.url).pathname;
const SRC = readFileSync(RUTAS_JS, 'utf8');
const iFin = SRC.indexOf('return { lanes, order, unassigned };');
const solverSrc = SRC.slice(0, SRC.indexOf('\n  }', iFin) + 4);
const CSRC = readFileSync(CONSOLA_JS, 'utf8');
const helpersSrc = CSRC.slice(0, CSRC.indexOf('  // ---------------- CONSOLA'));
const fabrica = new Function('state', 'Api', 'window', 'toast', '$', 'fetch', `
  ${helpersSrc}
  ${solverSrc}
  return { rt, rtCfg, rtDurProg, rtFranja, rtPorGente, rtZonaDe, rtToMin };
`);
const S = fabrica({ settings: { route_airport_buffer_min: 10 } }, {}, {}, () => {}, () => null, globalThis.fetch);
S.rtCfg();
S.rt.ZONAS = {
  'Porvenir': [
    { band_from: 0, band_to: 2, min_minutes: 40, max_minutes: 40 },
    { band_from: 2, band_to: 6, min_minutes: 30, max_minutes: 40 },
    { band_from: 6, band_to: 9, min_minutes: 40, max_minutes: 50 },
    { band_from: 9, band_to: 12, min_minutes: 40, max_minutes: 40 },
    { band_from: 12, band_to: 19, min_minutes: 40, max_minutes: 50 },
    { band_from: 19, band_to: 24, min_minutes: 40, max_minutes: 40 },
  ],
  'Marinilla': [
    { band_from: 12, band_to: 19, min_minutes: 60, max_minutes: 70 },
    { band_from: 2, band_to: 6, min_minutes: 60, max_minutes: 60 },
  ],
};
S.rt.TRAMOS = [
  { band_from: 0, band_to: 2, min_minutes: 20, max_minutes: 20 },
  { band_from: 2, band_to: 6, min_minutes: 15, max_minutes: 15 },
  { band_from: 6, band_to: 9, min_minutes: 35, max_minutes: 35 },
  { band_from: 9, band_to: 12, min_minutes: 20, max_minutes: 25 },
  { band_from: 12, band_to: 19, min_minutes: 25, max_minutes: 30 },
  { band_from: 19, band_to: 24, min_minutes: 20, max_minutes: 20 },
];
S.rt.aux = {
  melina: { n: 'Melina', zonaJefe: 'Porvenir', pax: 1, dl: '15:55', type: 'sal' },
  otro1:  { n: 'Otro 1', zonaJefe: 'Porvenir', pax: 1, dl: '15:55', type: 'sal' },
  otro2:  { n: 'Otro 2', zonaJefe: 'Porvenir', pax: 1, dl: '15:55', type: 'sal' },
  lejos:  { n: 'Lejos',  zonaJefe: 'Marinilla', pax: 1, dl: '15:55', type: 'sal' },
  sinz:   { n: 'Sin zona', zonaJefe: null,     pax: 1, dl: '15:55', type: 'sal' },
};
const dl = S.rtToMin('15:55');
const P = (t) => String(t).padStart(3);

console.log('EL EJEMPLO DE JULIÁN — Melina sola, presentación 15:55, franja 12-19');
console.log('  la operación mide (OSRM×0.8) ~22 min; la tabla de Porvenir dice 40 (mínimo, va sola)');
const durMelina = S.rtDurProg(['melina'], dl, 22, 0);
console.log(`  → se programa con ${P(durMelina)} min  ⇒ recogerla a las ${S.rt && ''}${hm(dl - 10 - durMelina)}  (él dijo 15:05)`);

console.log('\nMISMA ZONA, MÁS GENTE (el rango se mueve solo)');
for (const [ids, etiqueta] of [[['melina'], '1 persona → mínimo'], [['melina','otro1'], '2 personas → punto medio'], [['melina','otro1','otro2'], '3 personas → máximo']])
  console.log(`  ${etiqueta.padEnd(26)} ${P(S.rtDurProg(ids, dl, 22, 8))} min`);

console.log('\nVUELTA MIXTA: manda la zona MÁS LENTA');
console.log(`  Porvenir + Marinilla        ${P(S.rtDurProg(['melina','lejos'], dl, 22, 8))} min  (Marinilla, no Porvenir)`);

console.log('\nSI ALGUNA PARADA NO TIENE ZONA, la tabla NO se aplica');
console.log(`  Porvenir + sin clasificar   ${P(S.rtDurProg(['melina','sinz'], dl, 22, 8))} min  (= lo medido, como antes)`);

console.log('\nEL PISO DEL TRAMO FINAL (desde la última persona recogida)');
console.log('  recorrido largo hasta la última casa (50) + tramo final 12-19 (25 solo)');
console.log(`  → ${P(S.rtDurProg(['melina'], dl, 55, 50))} min  (50+25=75 manda sobre el total de zona 40 y sobre lo medido 55)`);

console.log('\nFRANJA 6-9 A.M., la más pesada para él');
const dlAm = S.rtToMin('07:30');
console.log(`  Porvenir sola a las 7:30     ${P(S.rtDurProg(['melina'], dlAm, 22, 0))} min  (tabla 40; el tramo final de esa franja es 35)`);

console.log('\nDOMINGO/FESTIVO — "no sacarlos tan temprano"');
S.rt.esDiaLento = true; S.rt.HOLIDAY_SHIFT = 15;
console.log(`  Melina sola, festivo, -15    ${P(S.rtDurProg(['melina'], dl, 22, 0))} min  ⇒ recogerla ${hm(dl - 10 - S.rtDurProg(['melina'], dl, 22, 0))}`);
S.rt.HOLIDAY_SHIFT = 0; S.rt.esDiaLento = false;

function hm(m) { return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; }
