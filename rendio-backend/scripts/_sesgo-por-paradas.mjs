// ¿POR QUÉ MADRUGO? Diferencia con signo (yo − él) según cuántas paradas tiene
// MI vuelta. La sospecha: una vuelta de una sola parada no recibe el colchón de
// la tabla de zona (`ids.length > 1`), así que su duración sale ~25 min más
// larga y el carro arranca antes.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { norm } from './planes-jefe/lib-plan.mjs';
const dias = [
  ['/tmp/f8.json', '2026-08-19', 'plan-2026-08-19-correccion-jefe.txt'],
  ['/tmp/f9.json', '2026-08-20', 'plan-2026-08-20-correccion-jefe.txt'],
  ['/tmp/f10.json', '2026-08-21', 'plan-2026-08-21-correccion-jefe.txt'],
  ['/tmp/f11.json', '2026-08-22', 'plan-2026-08-22-oficial-jefe.txt'],
  ['/tmp/form12fix.json', '2026-08-23', 'plan-2026-08-23-correccion-jefe.txt'],
];
const porParadas = new Map(), porDia = new Map();
for (const [form, dia, plan] of dias) {
  execFileSync('node', ['scripts/plan-desde-formulario.mjs', form, dia, '--carros=3', '--hueco=20', '--plan-jefe=todos', '--json=/tmp/ps.json'], { stdio: 'ignore' });
  const p = JSON.parse(readFileSync('/tmp/ps.json', 'utf8'));
  // cuántas paradas tiene MI vuelta, por persona
  const nPar = new Map();
  for (const v of p.vueltas) if (v.tipo === 'sal') for (const par of v.paradas) for (const per of par.personas) nPar.set(norm(per.n), v.paradas.length);
  const out = execFileSync('node', ['scripts/_vs-jefe.mjs', '/tmp/ps.json', plan], { encoding: 'utf8' });
  for (const ln of out.split('\n')) {
    const m = ln.match(/^(.{1,24}?)\s+(\d\d):(\d\d)\s+(\d\d):(\d\d)\s+([+-]?\d+)\s/);
    if (!m) continue;
    const dif = Number(m[6]);
    const quien = norm(m[1]);
    let n = nPar.get(quien);
    if (n == null) for (const [k, v] of nPar) if (k.startsWith(quien) || quien.startsWith(k)) { n = v; break; }
    if (n == null) continue;
    const k = n === 1 ? 'una parada' : n === 2 ? 'dos paradas' : 'tres o más';
    (porParadas.get(k) || porParadas.set(k, []).get(k)).push(dif);
    (porDia.get(dia) || porDia.set(dia, []).get(dia)).push(dif);
  }
}
const prom = (a) => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1);
console.log('paradas de MI vuelta      n    yo − él');
for (const k of ['una parada', 'dos paradas', 'tres o más']) {
  const a = porParadas.get(k) || [];
  if (!a.length) continue;
  const p = Number(prom(a));
  console.log(`${k.padEnd(20)} ${String(a.length).padStart(5)}   ${p > 0 ? '+' : ''}${p} min   ${p < 0 ? '◀'.repeat(Math.min(24, Math.round(-p))) : '▶'.repeat(Math.min(24, Math.round(p)))}`);
}
console.log('\npor día                   n    yo − él');
for (const [d, a] of porDia) {
  const p = Number(prom(a));
  console.log(`${d.padEnd(20)} ${String(a.length).padStart(5)}   ${p > 0 ? '+' : ''}${p} min   ${p < 0 ? '◀'.repeat(Math.min(24, Math.round(-p))) : '▶'.repeat(Math.min(24, Math.round(p)))}`);
}
