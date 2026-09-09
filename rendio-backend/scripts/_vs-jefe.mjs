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
if (!MIO || !SUYO) { console.error('uso: node _vs-jefe.mjs <plan.json> <plan-jefe.txt> [--corto] [--grupos] [--madrugada]'); process.exit(1); }
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
// alias.json va del formulario hacia él; acá se busca al revés (de su nombre al
// del formulario), así que hace falta el mapa en las dos direcciones. Sin la
// inversa, "Juanita" empataba a la vez con "Juan Martínez" y "Juan Bedoya" y el
// desempate —que existe por las cuatro Lauras— la dejaba sin emparejar.
const ALIAS_INV = Object.fromEntries(Object.entries(ALIAS).map(([k, v]) => [norm(v), k]));

// Él escribe apodos y a veces SOLO EL APELLIDO ("González", "Rubiano") o el
// nombre con inicial ("Karol M"). Se puntúa por palabras y se exige unicidad: si
// dos personas empatan no se elige ninguna, porque hay cuatro Lauras, tres Saras
// y tres Karoles y adivinar es peor que no medir.
function emparejar(nSuyo) {
  const t = ALIAS[nSuyo] ? norm(ALIAS[nSuyo]) : (ALIAS_INV[nSuyo] ? norm(ALIAS_INV[nSuyo]) : nSuyo);
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

// ── ¿ARMAMOS LAS MISMAS VUELTAS? ────────────────────────────────────────────
// El error en minutos no dice si pensamos igual: se le puede acertar la hora a
// cada persona y aun así repartirlas en otras vueltas. Esto compara los GRUPOS
// —quiénes van juntos—, que es la decisión suya. Nació el 7-sep-2026: el error
// era 10,0 min (lo de siempre) y sin embargo él partió en dos las vueltas donde
// nosotros fusionábamos, y separó a los del hotel de los del aeropuerto.
if (process.argv.includes('--grupos')) {
  const mapa = new Map(filas.filter((f) => f.clave).map((f) => [f.n, f.clave]));
  const misLanes = plan.vueltas.filter((v) => v.tipo === 'sal')
    // OJO: se mide desde la PRIMERA RECOGIDA, no desde que arranca el carro —
    // el vacío hasta la primera casa no lo ve él y falsearía la comparación
    // (la vuelta de Wilson salía "57 min" cuando 21 son de camino vacío).
    .map((v) => ({ hora: v.paradas[0]?.eta || v.sale, llega: v.llega, prim: v.paradas[0]?.eta, set: new Set(v.paradas.flatMap((p) => p.personas.map((q) => norm(q.n)))) }));
  const igual = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
  let ok = 0, tot = 0;
  console.log('\n¿LAS MISMAS VUELTAS? (quiénes van juntos, no a qué hora)');
  for (const v of leerPlan(DIR, SUYO)) {
    if (v.deadline == null) continue;
    const suyos = [];
    for (const p of v.paradas) {
      if (p.vuelo || p.hotel || p.aero) continue;
      for (const q of p.quien.split(/\s*,\s*|\s+y\s+/i)) if (norm(q)) suyos.push(norm(q));
    }
    if (!suyos.length) continue;
    tot++;
    const hora = hm(v.paradas[0].t), nota = v.hotel ? ' (hotel)' : '';
    const nombres = suyos.join(' + ');
    const claves = suyos.map((n) => mapa.get(n)).filter(Boolean);
    if (claves.length !== suyos.length) { console.log(`  ? ${hora} ${nombres}${nota}  — no los emparejé a todos`); continue; }
    const suyoSet = new Set(claves);
    const m = misLanes.find((l) => igual(suyoSet, l.set));
    // En las que armamos igual, lo único que puede diferir es el reloj: cuánto
    // creemos que dura ese mismo recorrido. Es donde se ve si madrugamos por
    // fusionar de más o simplemente por contar el viaje más largo.
    if (m) {
      ok++;
      const suD = v.deadline - v.paradas[0].t;
      const miD = m.llega != null && m.prim != null ? min(m.llega) - min(m.prim) : null;
      const cmp = miD == null ? '' : `  ·  dura él ${suD} / yo ${miD}${miD > suD ? ` (+${miD - suD})` : ''}`;
      console.log(`  = ${hora} ${nombres}${nota}${cmp}`);
      continue;
    }
    const parcial = misLanes.filter((l) => [...suyoSet].some((n) => l.set.has(n)));
    console.log(`  \u2260 ${hora} ${nombres}${nota}  \u2192  yo: ${parcial.map((x) => `${x.hora} [${[...x.set].join(' + ')}]`).join(' \u00b7 ') || '(a nadie)'}`);
  }
  console.log(`\nvueltas suyas armadas igual: ${ok}/${tot}  (yo armé ${misLanes.length} de salida)`);
}

// ── ¿QUIÉN MADRUGA MÁS? ─────────────────────────────────────────────────────
// La pregunta que ella hace una y otra vez, y la que él hizo el 23-ago. No es
// la diferencia de horas (eso ya está arriba): es cuánto antes de SU PROPIA
// presentación le timbran a cada quien, con él y con nosotros, sobre la misma
// presentación del formulario. Un sesgo positivo aquí = madrugamos más.
if (process.argv.includes('--madrugada')) {
  const con = filas.filter((f) => f.mio && f.mio.pres);
  const el = [], yo = [];
  const dur = [];
  console.log('\nMADRUGADA: minutos antes de SU PROPIA presentación');
  console.log(`${'persona'.padEnd(22)} ${'pres.'.padStart(5)} ${'él'.padStart(4)} ${'yo'.padStart(4)} ${'dif'.padStart(5)}`);
  console.log('─'.repeat(46));
  for (const f of con.sort((a, b) => a.t - b.t)) {
    const pres = min(f.mio.pres);
    const a = ((pres - f.t) + 1440) % 1440, b = ((pres - f.mio.t) + 1440) % 1440;
    if (a > 240 || b > 240) continue;               // cruces de medianoche raros
    el.push(a); yo.push(b); dur.push({ n: f.crudo, a, b });
    const d = b - a;
    console.log(`${f.crudo.slice(0, 21).padEnd(22)} ${f.mio.pres.padStart(5)} ${String(a).padStart(4)} ${String(b).padStart(4)} ${((d > 0 ? '+' : '') + d).padStart(5)}${f.mio.sinCarro ? '  (sin carro)' : ''}${b > 60 ? '  ✗ pasa de 60' : ''}`);
  }
  const prom = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
  const med = (a) => { const o = [...a].sort((x, y) => x - y); return o.length ? o[Math.floor(o.length / 2)] : NaN; };
  console.log(`\nél: promedio ${prom(el).toFixed(1)} · mediana ${med(el)} · máximo ${Math.max(...el)} · pasan de 60: ${el.filter((x) => x > 60).length}`);
  console.log(`yo: promedio ${prom(yo).toFixed(1)} · mediana ${med(yo)} · máximo ${Math.max(...yo)} · pasan de 60: ${yo.filter((x) => x > 60).length}`);
  console.log(`sesgo (yo − él): ${(prom(yo) - prom(el) > 0 ? '+' : '')}${(prom(yo) - prom(el)).toFixed(1)} min  ·  madrugo más que él en ${dur.filter((d) => d.b > d.a).length} de ${dur.length}`);
}
