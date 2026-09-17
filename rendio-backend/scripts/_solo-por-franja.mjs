// ¿CUÁNTO ANTES DEL "DEBEN ESTAR" RECOGE ÉL AL ÚLTIMO, DE NOCHE Y DE DÍA?
// Sobre TODOS sus planes del corpus (no una corrección): vueltas de salida,
// última recogida → "deben estar", separando una sola parada de varias y la
// franja de la hora del "deben estar". Es el número que hoy inflamos.
import { readdirSync } from 'node:fs';
import { leerPlan } from './planes-jefe/lib-plan.mjs';
const DIR = new URL('./planes-jefe/', import.meta.url).pathname;
const planes = readdirSync(DIR).filter((f) => /^plan-.*\.txt$/.test(f) && !/generado/.test(f));
const franja = (t) => { const h = Math.floor(((t % 1440) + 1440) % 1440 / 60); return h < 2 ? '00-02' : h < 6 ? '02-06' : h < 9 ? '06-09' : h < 12 ? '09-12' : h < 19 ? '12-19' : '19-24'; };
const acc = {};
let n = 0;
for (const f of planes) {
  let vs; try { vs = leerPlan(DIR, f); } catch { continue; }
  for (const v of vs) {
    if (v.deadline == null || v.tipo !== 'salida') continue;
    const paradas = v.paradas.filter((p) => !p.vuelo && !p.aero);
    if (!paradas.length) continue;
    const ultima = Math.max(...paradas.map((p) => p.t));
    const d = v.deadline - ultima;
    if (d < 0 || d > 120) continue;
    const k = `${franja(v.deadline)} ${paradas.length === 1 ? 'sola ' : 'varias'}`;
    (acc[k] ||= []).push(d); n++;
  }
}
const med = (a) => { const o = [...a].sort((x, y) => x - y); return o[Math.floor(o.length / 2)]; };
console.log(`${planes.length} planes suyos · ${n} vueltas de salida\n`);
console.log('franja  paradas   n   mediana  prom   máx   última recogida → "deben estar"');
for (const k of Object.keys(acc).sort()) {
  const a = acc[k];
  console.log(`${k}   ${String(a.length).padStart(3)}   ${String(med(a)).padStart(5)}   ${(a.reduce((s, x) => s + x, 0) / a.length).toFixed(1).padStart(5)}  ${String(Math.max(...a)).padStart(4)}   ${a.sort((x, y) => x - y).join(' ')}`);
}
