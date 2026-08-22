// ¿A QUÉ HORA RECOGERÍA ÉL A CADA PERSONA, Y A QUÉ HORA LA RECOJO YO?
//
// El medidor que faltaba. `_diff-jefe.mjs` compara el TRAMO FINAL vuelta por
// vuelta (última recogida → "deben estar"), que es la regla, pero no dice si al
// tripulante lo timbramos a la hora que él lo timbraría. Esto sí: cruza persona
// por persona mi plan (el JSON del solver) contra su corrección, y saca el error
// con signo (+ = lo recojo más tarde que él).
//
// Se usa para calibrar: se corre el mismo día con distintas perillas
// (--colchon=, --sintabla, --aero=) y gana la que baja el error absoluto medio.
//
// Uso:
//   node scripts/_vs-jefe.mjs /tmp/plan.json plan-2026-08-20-correccion-jefe.txt
//   node scripts/_vs-jefe.mjs /tmp/plan.json plan-2026-08-20-correccion-jefe.txt --corto
import { readFileSync } from 'node:fs';
import { norm, leerPlan } from './planes-jefe/lib-plan.mjs';

const MIO = process.argv[2], SUYO = process.argv[3];
if (!MIO || !SUYO) { console.error('uso: node _vs-jefe.mjs <plan.json> <plan-jefe.txt> [--corto]'); process.exit(1); }
const CORTO = process.argv.includes('--corto');
const DIR = new URL('./planes-jefe/', import.meta.url).pathname;
const hm = (t) => `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
const min = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };

// ── él ──────────────────────────────────────────────────────────────────────
// Solo SALIDAS: las vueltas con "deben estar" y sin número de vuelo. En las
// llegadas la hora es la del avión, no una decisión suya.
const suyas = [];
for (const v of leerPlan(DIR, SUYO)) {
  if (v.deadline == null) continue;
  for (const p of v.paradas) {
    if (p.vuelo || p.hotel || p.aero) continue;
    for (const q of p.quien.split(/\s*,\s*|\s+y\s+/i)) {
      if (norm(q)) suyas.push({ n: norm(q), crudo: q.trim(), t: p.t, lugar: p.lugar, dl: v.deadline, pax: v.pax });
    }
  }
}

// ── yo ──────────────────────────────────────────────────────────────────────
const plan = JSON.parse(readFileSync(MIO, 'utf8'));
const mias = new Map();
for (const v of plan.vueltas.filter((x) => x.tipo === 'sal')) {
  for (const p of v.paradas) for (const q of p.personas) {
    mias.set(norm(q.n), { t: min(p.eta), lugar: p.zona, dl: min(v.presentacion || '00:00'), sinCarro: false, pres: q.dl });
  }
}
for (const s of plan.sinRutear || []) {
  if (s.tipo !== 'sal') continue;
  mias.set(norm(s.n), { t: min(s.eta || s.dl), lugar: s.zona, dl: min(s.dl), sinCarro: true, pres: s.dl });
}

// El formulario trae el nombre completo y él escribe apodos ("Karol L", "Andrés
// Ramírez", "Lau blanco"). Se puntúa por palabras compartidas exigiendo que
// coincida el nombre de pila —aceptando prefijo— y NO se elige cuando empatan
// dos personas, que es como se cuelan las cuatro Lauras una en la casa de otra.
// Distancia de edición barata: "Josselin" (él) vs "Josselyn" (formulario).
const lev = (a, b) => {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
};
let ALIAS = {};
try { ALIAS = JSON.parse(readFileSync(DIR + 'alias.json', 'utf8')).alias || {}; } catch {}

// Él escribe apodos y a veces SOLO EL APELLIDO ("González", "Rubiano") o el
// nombre con inicial ("Karol M"). Se puntúa por palabras y se exige unicidad: si
// dos personas empatan no se elige ninguna, porque hay cuatro Lauras, tres Saras
// y tres Karoles y adivinar es peor que no medir.
function emparejar(nSuyo) {
  const t = ALIAS[nSuyo] ? norm(ALIAS[nSuyo]) : nSuyo;
  if (mias.has(t)) return { k: t, v: mias.get(t), s: 99 };
  const pal = t.split(' ');
  const largas = pal.filter((x) => x.length >= 3);
  const iniciales = pal.filter((x) => x.length <= 2);
  const cand = [];
  for (const [k, v] of mias) {
    const pk = k.split(' ');
    let s = 0;
    for (const p of largas) {
      if (pk.includes(p)) s += 3;
      else if (pk.some((x) => x.length >= 3 && (x.startsWith(p) || p.startsWith(x)))) s += 2;
      else if (pk.some((x) => x.length >= 5 && p.length >= 5 && lev(x, p) <= 1)) s += 2;
    }
    if (!s) continue;
    // "Karol M" solo puede ser una Karol cuyo apellido empiece por M.
    if (iniciales.length && !iniciales.every((i) => pk.some((x) => x.startsWith(i)))) continue;
    cand.push({ k, v, s });
  }
  if (!cand.length) return null;
  cand.sort((a, b) => b.s - a.s);
  const top = cand.filter((x) => x.s === cand[0].s);
  return top.length === 1 ? top[0] : null;
}

const filas = [];
for (const s of suyas) {
  const m = emparejar(s.n);
  filas.push({ ...s, mio: m ? m.v : null, clave: m ? m.k : null });
}

if (!CORTO) {
  console.log(`RECOGIDAS: él vs yo   (${SUYO})\n`);
  console.log(`${'persona'.padEnd(22)} ${'él'.padStart(5)} ${'yo'.padStart(6)} ${'dif'.padStart(5)}  ${'casa (él)'.padEnd(18)} casa (yo)`);
  console.log('─'.repeat(84));
  for (const f of filas.sort((a, b) => a.t - b.t)) {
    const d = f.mio ? f.mio.t - f.t : null;
    console.log(`${f.crudo.slice(0, 21).padEnd(22)} ${hm(f.t).padStart(5)} ${(f.mio ? hm(f.mio.t) : '—').padStart(6)} ${(d == null ? '—' : (d > 0 ? '+' : '') + d).padStart(5)}  ${f.lugar.slice(0, 17).padEnd(18)} ${f.mio ? f.mio.lugar.slice(0, 24) : '(no lo emparejé)'}${f.mio?.sinCarro ? '  SIN CARRO' : ''}`);
  }
  console.log('');
}

const difs = filas.filter((f) => f.mio).map((f) => f.mio.t - f.t);
const abs = difs.map(Math.abs).sort((a, b) => a - b);
const med = (a) => a.length ? a[Math.floor(a.length / 2)] : NaN;
const sinCarro = filas.filter((f) => f.mio?.sinCarro).length;
console.log(`emparejadas ${difs.length}/${filas.length}` +
  ` · error abs medio ${(abs.reduce((s, x) => s + x, 0) / (abs.length || 1)).toFixed(1)}` +
  ` · mediana ${med(abs)}` +
  ` · dentro de ±5 ${difs.filter((d) => Math.abs(d) <= 5).length}` +
  ` · se pasan de 15 ${abs.filter((d) => d > 15).length}` +
  ` · sin carro ${sinCarro}`);
