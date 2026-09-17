// ¿CUÁNTO DEL ERROR ES POLÍTICA SUYA Y NO MODELO NUESTRO?
// Para cada vuelta de salida suya: su "deben estar" contra la presentación más
// apretada del grupo (la que trae el formulario). Nuestro solver usa siempre
// presentación − route_airport_buffer_min (10). Él, no.
import { readFileSync } from 'node:fs';
import { leerPlan, norm } from './planes-jefe/lib-plan.mjs';
const DIR = new URL('./planes-jefe/', import.meta.url).pathname;
const pares = [
  ['/tmp/f8.json', '2026-08-19', 'plan-2026-08-19-correccion-jefe.txt'],
  ['/tmp/f9.json', '2026-08-20', 'plan-2026-08-20-correccion-jefe.txt'],
  ['/tmp/f10.json', '2026-08-21', 'plan-2026-08-21-correccion-jefe.txt'],
  ['/tmp/f11.json', '2026-08-22', 'plan-2026-08-22-oficial-jefe.txt'],
  ['/tmp/form12fix.json', '2026-08-23', 'plan-2026-08-23-correccion-jefe.txt'],
];
const t = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const todos = [];
for (const [formPath, dia, plan] of pares) {
  const form = JSON.parse(readFileSync(formPath, 'utf8')).filter((r) => r.fecha === dia && r.presentacion);
  const pres = form.map((r) => ({ n: norm(r.nombre), pal: norm(r.nombre).split(' ').filter((x) => x.length >= 3), min: t(r.presentacion) }));
  const buscarPres = (quien) => {
    const pal = norm(quien).split(' ').filter((x) => x.length >= 3);
    if (!pal.length) return null;
    const c = pres.filter((p) => pal.some((w) => p.pal.some((y) => y === w || (y.length >= 4 && w.length >= 4 && (y.startsWith(w) || w.startsWith(y))))));
    return c.length === 1 ? c[0].min : null;   // ambiguo → no se cuenta
  };
  const dif = [];
  for (const v of leerPlan(DIR, plan)) {
    if (v.tipo !== 'salida' || v.deadline == null) continue;
    const ps = v.paradas.flatMap((p) => (p.quien || '').split(/\s*,\s*|\s+y\s+/i)).map(buscarPres).filter((x) => x != null);
    if (!ps.length) continue;
    dif.push(Math.min(...ps) - v.deadline);     // + = él entrega antes de la presentación
  }
  todos.push(...dif);
  const s = [...dif].sort((a, b) => a - b);
  console.log(`${dia}  n=${dif.length}  colchón suyo: mín ${s[0]} · mediana ${s[Math.floor(s.length / 2)]} · máx ${s[s.length - 1]} · promedio ${(dif.reduce((a, b) => a + b, 0) / dif.length).toFixed(1)}`);
}
const s = [...todos].sort((a, b) => a - b);
console.log(`\nTODOS (n=${s.length}): promedio ${(todos.reduce((a, b) => a + b, 0) / s.length).toFixed(1)} · mediana ${s[Math.floor(s.length / 2)]} · rango ${s[0]}..${s[s.length - 1]}`);
const hist = {};
for (const d of todos) { const k = Math.round(d / 5) * 5; hist[k] = (hist[k] || 0) + 1; }
console.log('reparto (min antes de la presentación):');
for (const k of Object.keys(hist).map(Number).sort((a, b) => a - b)) console.log(`  ${String(k).padStart(4)}  ${'█'.repeat(hist[k])} ${hist[k]}`);
const nuestro = 10;
console.log(`\nsi usáramos su mediana en vez de ${nuestro}: el sesgo bajaría ${Math.abs(s[Math.floor(s.length / 2)] - nuestro)} min`);
