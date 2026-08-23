// ¿MADRUGO PAREJO O SOLO EN LA MADRUGADA?
// Diferencia CON SIGNO (yo − él) de la hora de recogida, por franja horaria,
// sobre los cinco días con formulario. Negativo = lo recojo antes que él.
import { execFileSync } from 'node:child_process';
const dias = [
  ['/tmp/f8.json', '2026-08-19', 'plan-2026-08-19-correccion-jefe.txt'],
  ['/tmp/f9.json', '2026-08-20', 'plan-2026-08-20-correccion-jefe.txt'],
  ['/tmp/f10.json', '2026-08-21', 'plan-2026-08-21-correccion-jefe.txt'],
  ['/tmp/f11.json', '2026-08-22', 'plan-2026-08-22-oficial-jefe.txt'],
  ['/tmp/form12fix.json', '2026-08-23', 'plan-2026-08-23-correccion-jefe.txt'],
];
const FRANJAS = [[0, 6, '00-06 madrugada'], [6, 9, '06-09 mañana'], [9, 12, '09-12'], [12, 19, '12-19 tarde'], [19, 24, '19-24 noche']];
const acc = new Map(FRANJAS.map((f) => [f[2], []]));
for (const [form, dia, plan] of dias) {
  execFileSync('node', ['scripts/plan-desde-formulario.mjs', form, dia, '--carros=3', '--hueco=20', '--plan-jefe=todos', '--json=/tmp/ps.json'], { stdio: 'ignore' });
  const out = execFileSync('node', ['scripts/_vs-jefe.mjs', '/tmp/ps.json', plan], { encoding: 'utf8' });
  for (const ln of out.split('\n')) {
    const m = ln.match(/^(.{1,24}?)\s+(\d\d):(\d\d)\s+(\d\d):(\d\d)\s+([+-]?\d+)\s/);
    if (!m) continue;
    const h = Number(m[2]), dif = Number(m[6]);
    const f = FRANJAS.find((x) => h >= x[0] && h < x[1]);
    if (f) acc.get(f[2]).push(dif);
  }
}
const prom = (a) => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1);
console.log('franja (por la hora a la que ÉL recoge)   n    yo − él');
for (const [, , nom] of FRANJAS) {
  const a = acc.get(nom);
  if (!a.length) continue;
  const p = Number(prom(a));
  console.log(`${nom.padEnd(20)} ${String(a.length).padStart(5)}   ${p > 0 ? '+' : ''}${p} min  ${p < 0 ? '◀'.repeat(Math.min(20, Math.round(-p))) + ' madrugo' : '▶'.repeat(Math.min(20, Math.round(p))) + ' voy tarde'}`);
}
const todo = [...acc.values()].flat();
console.log(`\nTODOS  n=${todo.length}  sesgo ${prom(todo)} min`);
