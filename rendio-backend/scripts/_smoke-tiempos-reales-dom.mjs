// Calibración › «Tiempos reales de los viajes» (0116, 24-oct-2026), en jsdom.
//
//   1. Lo cableado: la tarjeta en index.html junto a la tabla de Julián, el CSS,
//      el script después de admin-calibracion.js y sw.js (v196 o más, con los dos
//      archivos en el APP_SHELL).
//   2. No consulta nada hasta que el jefe abre la tarjeta; al abrir, una sola vez.
//   3. Sin viajes: lo dice y explica qué tiene que pasar.
//   4. Con viajes: las cuatro cifras de arriba, el margen y la puerta a la vista,
//      el detalle plegado diciendo cuánto hay; «Lo real pasa su número» solo con
//      10 viajes o más (con menos: «Pocos viajes»); día normal / festivo filtra;
//      lo que el jefe abrió sigue abierto al cambiar; el período vuelve a pedir.
//   5. «Medir ahora» mide, avisa y recarga.
//   6. Reloj parado (más de 3 h): se avisa. Sin la migración: se dice.
//
// NO cubre: el layout (jsdom no pinta: eso se vio en el navegador local, en
// computador y celular) ni la base (eso es _verify-0116.mjs).
//
//   cd rendio-backend/scripts && node _smoke-tiempos-reales-dom.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
let ok = 0, bad = 0;
const t = (n, c, d = '') => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d !== '' ? ' → ' + d : '')); } };
const espera = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); };

// ── 1. Lo cableado ──────────────────────────────────────────────────────────
console.log('Cableado');
const html = read('index.html'), sw = read('sw.js');
t('la tarjeta está en Calibración, después de la tabla de Julián y antes de los parámetros',
  /data-acc="tabla"[\s\S]*?<details class="set-card set-card-acc" data-acc="reales" id="rl-card">[\s\S]*?id="rl-root"[\s\S]*?data-acc="parametros"/.test(html));
t('carga admin-tiempos-reales.css y el script va después de admin-calibracion.js',
  /href="admin-tiempos-reales\.css"/.test(html) && /<script src="admin-calibracion\.js"><\/script>\s*<script src="admin-tiempos-reales\.js"><\/script>/.test(html));
t('sw.js: v196 o más y los dos archivos en el APP_SHELL',
  Number((sw.match(/CACHE_VERSION = 'rendio-turnos-v(\d+)'/) || [])[1]) >= 196 && /'\/admin-tiempos-reales\.js'/.test(sw) && /'\/admin-tiempos-reales\.css'/.test(sw));

// ── El montaje ──────────────────────────────────────────────────────────────
const tarjeta = html.match(/<details class="set-card set-card-acc" data-acc="reales" id="rl-card">[\s\S]*?<\/details>/)[0];
const FRANJAS = [{ desde: 0, hasta: 2 }, { desde: 2, hasta: 6 }, { desde: 6, hasta: 9 }, { desde: 9, hasta: 12 }, { desde: 12, hasta: 19 }, { desde: 19, hasta: 24 }];
const hace = (min) => new Date(Date.now() - min * 60000).toISOString();
const VACIO = { dias: 120, minimo: 10, franjas: FRANJAS, ultima_medicion: hace(10), resumen: { vueltas: 0, tramos: 0, dudosos: 0 } };
const DATOS = () => ({
  dias: 120, minimo: 10, franjas: FRANJAS, ultima_medicion: hace(12),
  resumen: { desde: '2026-10-11', hasta: '2026-10-24', vueltas: 98, vueltas_ok: 87, tramos: 300, tramos_ok: 260, dudosos: 73, sin_gps: 4, ultimo_viaje: hace(60) },
  margen: [{ band: 2, n: 32, mediana: 15, peor: -3, tarde: 1, justo: 4 }, { band: 6, n: 9, mediana: 15, peor: 2, tarde: 0, justo: 2 }],
  puerta: [{ band: 2, n: 61, mediana: 2, p90: 8, tarde: 23, temprano: 0 }],
  tramo_final: [
    { band: 2, day_type: 'normal', zona: 'Todas', total: 1, n: 25, mediana: 14, p90: 20, max: 24, julian_min: 15, julian_max: 15 },
    { band: 6, day_type: 'normal', zona: 'Todas', total: 1, n: 7, mediana: 18, p90: 40, max: 41, julian_min: 35, julian_max: 35 },
    { band: 2, day_type: 'normal', zona: 'Marinilla', total: 0, n: 4, mediana: 21, p90: 22, max: 22, julian_min: 15, julian_max: 15 },
    { band: 2, day_type: 'festivo', zona: 'Todas', total: 1, n: 3, mediana: 11, p90: 19, max: 19, julian_min: 15, julian_max: 15 },
  ],
  vuelta: [{ zona: 'Fontibón', band: 2, gente: '1', day_type: 'normal', n: 12, mediana: 22, p90: 30, julian: 40 }],
  llegadas: [{ zona: 'Porvenir', band: 9, day_type: 'normal', n: 5, mediana: 23, p90: 28 }],
  conjuntos: [{ conjunto: 'Olivar (prueba)', band: 2, day_type: 'normal', n: 9, mediana: 14, p90: 15 }],
  espera: [{ conjunto: 'Olivar (prueba)', n: 14, mediana: 2, p90: 6 }],
  conductores: [{ nombre: 'Mario Prueba', total: 248, dudosos: 73 }, { nombre: 'Andrés Prueba', total: 283, dudosos: 0 }],
  dudosos: [{ kind: 'casa_aeropuerto', cuando: hace(120), minutes: 1, motivo: 'marcó a 5,4 km del punto de salida', conductor: 'Mario Prueba', res_from: 'Sendai (prueba)', res_to: null },
    { kind: 'espera', cuando: hace(121), minutes: 0, motivo: 'marcó a 5,4 km del punto de llegada', conductor: 'Mario Prueba', res_from: 'Sendai (prueba)', res_to: 'Sendai (prueba)' }],
});

function montar(respuesta) {
  const dom = new JSDOM(`<!doctype html><body><div id="calib-ui" class="set-ui">${tarjeta}</div></body>`, { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = dom.window;
  const log = { rpc: [], toasts: [] };
  let resp = respuesta;
  w.sb = { rpc: async (fn, args) => {
    log.rpc.push([fn, args]);
    if (fn === 'admin_collect_trip_legs') return { data: { vueltas: 3, tramos: 14, dudosos: 2 }, error: null };
    const r = typeof resp === 'function' ? resp() : resp;
    return r instanceof Error ? { data: null, error: { message: r.message } } : { data: r, error: null };
  } };
  w.Api = {};
  w.toast = (m) => log.toasts.push(m);
  w.eval(read('admin-tiempos-reales.js'));
  const $ = (s) => w.document.querySelector(s);
  const abrir = async () => { const d = $('#rl-card'); d.open = true; d.dispatchEvent(new w.Event('toggle')); await espera(); };
  return { w, log, $, abrir, set: (r) => { resp = r; }, txt: () => $('#rl-root').textContent.replace(/\s+/g, ' ') };
}

// ── 2. Carga perezosa ───────────────────────────────────────────────────────
console.log('Carga');
{
  const m = montar(DATOS());
  await espera();
  t('no consulta nada con la tarjeta cerrada', m.log.rpc.length === 0, JSON.stringify(m.log.rpc));
  await m.abrir();
  t('al abrir consulta una vez, 120 días y mínimo 10', m.log.rpc.length === 1 && m.log.rpc[0][0] === 'admin_learned_times' && m.log.rpc[0][1].p_days === 120 && m.log.rpc[0][1].p_min === 10, JSON.stringify(m.log.rpc));
  const d = m.$('#rl-card'); d.open = false; d.dispatchEvent(new m.w.Event('toggle')); await m.abrir();
  t('cerrar y volver a abrir no vuelve a consultar', m.log.rpc.length === 1);
  t('cuelga Api.learnedTimes y Api.collectTripLegs', typeof m.w.Api.learnedTimes === 'function' && typeof m.w.Api.collectTripLegs === 'function');
}

// ── 3. Sin viajes ───────────────────────────────────────────────────────────
console.log('Sin viajes');
{
  const m = montar(VACIO);
  await m.abrir();
  t('dice que no hay viajes y qué tiene que pasar', /Todavía no hay viajes medidos/.test(m.txt()) && /«llegué», «a bordo» y «entregado»/.test(m.txt()), m.txt().slice(0, 200));
  t('igual deja «Medir ahora» y el período', !!m.$('#rl-medir') && !!m.$('#rl-dias'));
}

// ── 4. Con viajes ───────────────────────────────────────────────────────────
console.log('Con viajes');
{
  const m = montar(DATOS);
  await m.abrir();
  const tx = m.txt();
  const kpis = [...m.$('#rl-root').querySelectorAll('.rl-kpi b')].map((b) => b.textContent);
  t('las cuatro cifras: 98 vueltas · 1 tarde · 23 tarde en la puerta · 73 dudosos', JSON.stringify(kpis) === '["98","1","23","73"]', JSON.stringify(kpis));
  t('dice que todavía no cambia cómo se planea', /todavía no cambia cómo se planea/.test(tx));
  t('margen y puerta a la vista (no plegados)', [...m.$('#rl-root').querySelectorAll('section.rl-sec h3')].map((h) => h.textContent).join('|') === '¿Llegan a tiempo al aeropuerto?|¿El plan acierta la hora en la puerta?');
  t('margen negativo en rojo (−3 min)', [...m.$('#rl-root').querySelectorAll('td.rl-bad')].some((td) => td.textContent === '-3 min'));
  const pleg = [...m.$('#rl-root').querySelectorAll('details[data-rl-sec]')];
  t('seis secciones de detalle, todas plegadas', pleg.length === 6 && pleg.every((d) => !d.open), pleg.map((d) => d.dataset.rlSec + ':' + d.open).join(','));
  t('plegadas dicen cuánto hay (32 viajes de tramo final en día normal · 73 dudosos)',
    m.$('[data-rl-sec="tramo"] .set-sec-val').textContent === '32 viajes' && m.$('[data-rl-sec="dudosos"] .set-sec-val').textContent === '73 dudosos',
    m.$('[data-rl-sec="tramo"] .set-sec-val').textContent);
  const filas = [...m.$('[data-rl-sec="tramo"]').querySelectorAll('tr')].map((tr) => tr.textContent.replace(/\s+/g, ' '));
  t('2–6 a.m. con 25 viajes y mal día 20 > 15 de Julián: «Lo real pasa su número»', filas.some((f) => /2 a\.m\. – 6 a\.m\..*15 min.*14 min.*mal día 20 min.*25.*Lo real pasa su número/.test(f)), filas.join(' / '));
  t('6–9 a.m. con 7 viajes: «Pocos viajes», no afirma nada', filas.some((f) => /6 a\.m\. – 9 a\.m\..*Pocos viajes/.test(f)) && !filas.some((f) => /6 a\.m\. – 9 a\.m\..*(Lo real pasa|Cabe)/.test(f)));
  t('vuelta: 12 viajes, mal día 30 contra 40 de su tabla → «Cabe»', /Fontibón.*Cabe/.test(m.$('[data-rl-sec="vuelta"]').textContent.replace(/\s+/g, ' ')));
  t('celda con pocos viajes queda tenue', !!m.$('[data-rl-sec="tramo"] td.rl-pocos'));
  t('dudosos: en la espera el conjunto sale una vez, no «Sendai → Sendai»', !/Sendai \(prueba\) → Sendai/.test(m.$('[data-rl-sec="dudosos"]').textContent) && /Tramo final · Sendai \(prueba\) → aeropuerto/.test(m.$('[data-rl-sec="dudosos"]').textContent.replace(/\s+/g, ' ')));
  // Abrir una, cambiar a festivo: sigue abierta y cambian los números.
  m.$('[data-rl-sec="tramo"]').open = true; m.$('[data-rl-sec="tramo"]').dispatchEvent(new m.w.Event('toggle'));
  m.$('[data-rl-dia="festivo"]').click(); await espera();
  t('«Domingo y festivo»: el tramo final pasa a 3 viajes', m.$('[data-rl-sec="tramo"] .set-sec-val').textContent === '3 viajes', m.$('[data-rl-sec="tramo"] .set-sec-val').textContent);
  t('lo que el jefe abrió sigue abierto', m.$('[data-rl-sec="tramo"]').open === true);
  t('el botón marcado es el de festivo', m.$('[data-rl-dia="festivo"]').classList.contains('on') && !m.$('[data-rl-dia="normal"]').classList.contains('on'));
  t('sin vueltas de festivo: lo dice', /Sin vueltas de salida medidas en domingos o festivos/.test(m.$('[data-rl-sec="vuelta"]').textContent));
  const sel = m.$('#rl-dias'); sel.value = '30'; sel.dispatchEvent(new m.w.Event('change')); await espera();
  t('cambiar el período vuelve a pedir con 30 días', m.log.rpc.at(-1)[0] === 'admin_learned_times' && m.log.rpc.at(-1)[1].p_days === 30, JSON.stringify(m.log.rpc.at(-1)));
  t('…y conserva el tipo de día y lo abierto', m.$('[data-rl-dia="festivo"]').classList.contains('on') && m.$('[data-rl-sec="tramo"]').open === true);

  // ── 5. Medir ahora ──
  const antes = m.log.rpc.length;
  m.$('#rl-medir').click(); await espera();
  t('«Medir ahora» llama a admin_collect_trip_legs y luego recarga', m.log.rpc[antes][0] === 'admin_collect_trip_legs' && m.log.rpc[antes + 1][0] === 'admin_learned_times', JSON.stringify(m.log.rpc.slice(antes)));
  t('avisa lo que midió', m.log.toasts.some((x) => /Medidas 3 vueltas · 14 tramos · 2 dudosos/.test(x)), JSON.stringify(m.log.toasts));
}

// ── 6. Reloj parado y sin migración ─────────────────────────────────────────
console.log('Avisos');
{
  const m = montar(Object.assign(DATOS(), { ultima_medicion: hace(5 * 60) }));
  await m.abrir();
  t('más de 3 h sin medir: avisa que el reloj no corre', /no corre desde hace 5 h/.test(m.txt()) && !!m.$('.rl-dot.bad'), m.txt().slice(0, 160));
  const m2 = montar(new Error('Could not find the function public.admin_learned_times(p_days, p_min) in the schema cache'));
  await m2.abrir();
  t('sin 0116 en la base: lo dice, no revienta', /todavía no tiene la medición de tiempos \(migración 0116\)/.test(m2.txt()), m2.txt());
}

console.log(`\n${ok} bien · ${bad} mal`);
process.exit(bad ? 1 : 0);
