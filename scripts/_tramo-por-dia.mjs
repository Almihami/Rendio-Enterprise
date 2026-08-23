// Tramo final (última recogida → "deben estar") por día de la semana y por
// número de paradas, sobre TODAS sus correcciones.
import { readdirSync } from 'node:fs';
import { leerPlan } from './planes-jefe/lib-plan.mjs';
const DIR = new URL('./planes-jefe/', import.meta.url).pathname;

const DIAS = ['dom','lun','mar','mié','jue','vie','sáb'];
const files = readdirSync(DIR).filter(f => /^plan-2026-08-\d\d-/.test(f)).sort();
const filas = [];
for (const f of files) {
  const fecha = f.match(/(2026-08-\d\d)/)[1];
  const dow = DIAS[new Date(fecha + 'T12:00:00Z').getUTCDay()];
  for (const v of leerPlan(DIR, f)) {
    if (!v.deadline) continue;
    if (v.tipo !== 'salida') continue;
    const paradas = v.paradas.filter(p => !p.vuelo && !p.aero && !p.hotel && p.t != null);
    if (!paradas.length) continue;
    const ult = Math.max(...paradas.map(p => p.t));
    const tramo = v.deadline - ult;
    if (tramo < 0 || tramo > 90) continue;
    filas.push({ fecha, dow, n: paradas.length, tramo });
  }
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const prom = (a) => a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : '—';
console.log('día              n=1 (una parada)        n>1 (varias)');
for (const f of [...new Set(filas.map(x => x.fecha))]) {
  const g = filas.filter(x => x.fecha === f);
  const a = g.filter(x => x.n === 1).map(x => x.tramo), b = g.filter(x => x.n > 1).map(x => x.tramo);
  console.log(`${f} ${g[0].dow}   ${String(prom(a)).padStart(5)} min (med ${med(a) ?? '—'}, ${a.length})      ${String(prom(b)).padStart(5)} min (med ${med(b) ?? '—'}, ${b.length})`);
}
const finde = filas.filter(x => x.dow === 'sáb' || x.dow === 'dom');
const entre = filas.filter(x => x.dow !== 'sáb' && x.dow !== 'dom');
console.log(`\nentre semana: ${prom(entre.map(x => x.tramo))} min (n=${entre.length})   ·   fin de semana: ${prom(finde.map(x => x.tramo))} min (n=${finde.length})`);
for (const k of [1, 2]) {
  const e = entre.filter(x => k === 1 ? x.n === 1 : x.n > 1).map(x => x.tramo);
  const w = finde.filter(x => k === 1 ? x.n === 1 : x.n > 1).map(x => x.tramo);
  console.log(`  ${k === 1 ? 'una parada ' : 'varias     '} entre semana ${prom(e)} (n=${e.length}) · finde ${prom(w)} (n=${w.length})`);
}
