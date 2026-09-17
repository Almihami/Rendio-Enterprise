// CUÁNTO MADRUGA CADA PERSONA: minutos entre su recogida y SU PROPIA
// presentación. Él contra nosotros, sobre los cinco días con formulario.
// Y de paso: cuántas vueltas arma cada uno y con cuánta gente.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { leerPlan, norm } from './planes-jefe/lib-plan.mjs';
const DIR = new URL('./planes-jefe/', import.meta.url).pathname;
const dias = [
  ['/tmp/f8.json', '2026-08-19', 'plan-2026-08-19-correccion-jefe.txt'],
  ['/tmp/f9.json', '2026-08-20', 'plan-2026-08-20-correccion-jefe.txt'],
  ['/tmp/f10.json', '2026-08-21', 'plan-2026-08-21-correccion-jefe.txt'],
  ['/tmp/f11.json', '2026-08-22', 'plan-2026-08-22-oficial-jefe.txt'],
  ['/tmp/form12fix.json', '2026-08-23', 'plan-2026-08-23-correccion-jefe.txt'],
];
const t = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const antYo = [], antEl = [];
const paxYo = [], paxEl = [];
console.log('día         vueltas suyas / mías    gente por vuelta (él / yo)');
for (const [form, dia, plan] of dias) {
  const filas = JSON.parse(readFileSync(form, 'utf8')).filter((r) => r.fecha === dia && r.presentacion);
  const pres = filas.map((r) => ({ pal: norm(r.nombre).split(' ').filter((x) => x.length >= 3), min: t(r.presentacion) }));
  const buscar = (quien) => {
    const pal = norm(quien).split(' ').filter((x) => x.length >= 3);
    const c = pres.filter((p) => pal.some((w) => p.pal.some((y) => y === w || (y.length >= 4 && w.length >= 4 && (y.startsWith(w) || w.startsWith(y))))));
    return c.length === 1 ? c[0].min : null;
  };
  // él
  let nEl = 0;
  for (const v of leerPlan(DIR, plan)) {
    if (v.tipo !== 'salida') continue;
    nEl++; paxEl.push(v.pax || 1);
    for (const p of v.paradas) for (const q of (p.quien || '').split(/\s*,\s*|\s+y\s+/i)) {
      const pr = buscar(q); if (pr != null && p.t != null && pr - p.t >= 0 && pr - p.t < 180) antEl.push(pr - p.t);
    }
  }
  // yo
  execFileSync('node', ['scripts/plan-desde-formulario.mjs', form, dia, '--carros=3', '--hueco=20', '--plan-jefe=todos', '--json=/tmp/pa.json'], { stdio: 'ignore' });
  const mio = JSON.parse(readFileSync('/tmp/pa.json', 'utf8')).vueltas.filter((v) => v.tipo === 'sal');
  for (const v of mio) { paxYo.push(v.pax); for (const p of v.paradas) for (const per of p.personas) antYo.push(t(per.dl) - t(p.eta)); }
  const pe = (a) => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1);
  console.log(`${dia}      ${String(nEl).padStart(2)} / ${String(mio.length).padStart(2)}              ${pe(paxEl.slice(-nEl))} / ${pe(mio.map((v) => v.pax))}`);
}
const est = (a, nom) => { const s = [...a].sort((x, y) => x - y);
  console.log(`${nom.padEnd(10)} n=${String(s.length).padStart(3)}  promedio ${(s.reduce((x, y) => x + y, 0) / s.length).toFixed(1)}  mediana ${s[Math.floor(s.length / 2)]}  ·  más de 45 min: ${s.filter((x) => x > 45).length} (${Math.round(100 * s.filter((x) => x > 45).length / s.length)}%)  ·  máx ${s[s.length - 1]}`); };
console.log('\nMINUTOS QUE MADRUGA CADA PERSONA (recogida → su presentación)');
est(antEl, 'él'); est(antYo, 'yo');
