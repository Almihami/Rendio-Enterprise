// QUIÉN SALE EN SUS PLANES Y NO EN EL FORMULARIO.
// El 23-ago programó a seis personas que nosotros no: cinco no venían en el
// formulario (Margy, Alfonso, Yalimar, Josselin, Daniela Villa). No son gente
// nueva: salen en sus planes casi todos los días. Si son habituales, la ausencia
// en el formulario es el dato raro, y hay que avisarla.
import { readFileSync, readdirSync } from 'node:fs';
import { leerPlan, norm } from './planes-jefe/lib-plan.mjs';
const DIR = new URL('./planes-jefe/', import.meta.url).pathname;
const planes = readdirSync(DIR).filter((f) => /^plan-2026-08-\d\d-/.test(f)).sort();
const veces = new Map();
for (const f of planes) {
  const vistos = new Set();
  for (const v of leerPlan(DIR, f)) for (const p of v.paradas)
    for (const q of (p.quien || '').split(/\s*,\s*|\s+y\s+/i)) { const n = norm(q); if (n) vistos.add(n); }
  for (const n of vistos) veces.set(n, (veces.get(n) || 0) + 1);
}
const form = JSON.parse(readFileSync(process.argv[2], 'utf8')).filter((r) => r.fecha === process.argv[3]);
const enForm = form.map((r) => norm(r.nombre).split(' ').filter((x) => x.length >= 3));
const estaEnForm = (n) => { const pal = n.split(' ').filter((x) => x.length >= 3);
  return enForm.some((f) => pal.some((w) => f.some((y) => y === w || (y.length >= 4 && w.length >= 4 && (y.startsWith(w) || w.startsWith(y)))))); };
console.log(`sus planes: ${planes.length}\n`);
console.log('habitual (sale en 3+ de sus planes) y HOY NO está en el formulario:');
for (const [n, c] of [...veces].sort((a, b) => b[1] - a[1])) if (c >= 3 && !estaEnForm(n)) console.log(`  ${String(c).padStart(2)}/${planes.length}  ${n}`);
