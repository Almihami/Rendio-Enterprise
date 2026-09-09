#!/usr/bin/env node
// SOLO LECTURA — pone a prueba las reglas del jefe contra TODOS sus mensajes.
//
// analizar-plan-jefe.mjs muestra un mensaje vuelta por vuelta (sirve para leerlo).
// Esto es lo contrario: junta todos los mensajes y saca la estadística de cada
// regla, para responder "¿esta regla se sostiene o me la inventé con 3 casos?".
//
// Mide, sobre las vueltas de SALIDA (las de llegada no llevan deadline):
//   1. tramo final = "deben estar" − última recogida   → la regla del +20
//   2. espera del primero = "deben estar" − primera    → el techo de 50/60
//   3. pax por vuelta                                  → el cupo de 4
//   4. paso entre paradas vs OSRM                      → si pensamos igual
//   5. velocidad implícita: su tramo final vs OSRM     → el 28 vs 40 km/h
//
// Uso:
//   set -a; source .env.dev; set +a
//   node scripts/reglas-jefe.mjs                    # todos los planes de la carpeta
//   node scripts/reglas-jefe.mjs plan-agosto-a.txt  # solo algunos
import { createClient } from '@supabase/supabase-js';
import { readdirSync } from 'node:fs';
import { catalogo, leerPlan, osrmMin, guardarCache, hm } from './planes-jefe/lib-plan.mjs';

const DIR = new URL('./planes-jefe/', import.meta.url).pathname;
const MDE = { lat: 6.170795, lon: -75.427887 };  // pin corregido en la migración 0059

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: resid, error } = await sb.from('residences').select('*');
if (error) { console.log('ERROR residences:', error.message); process.exit(1); }
const { CAT, buscar } = catalogo(resid);

const pedidos = process.argv.slice(2).filter((a) => a.endsWith('.txt'));
const archivos = pedidos.length ? pedidos : readdirSync(DIR).filter((f) => f.startsWith('plan-') && f.endsWith('.txt')).sort();

const num = (a) => ({
  n: a.length,
  min: Math.min(...a), max: Math.max(...a),
  med: a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)],
  prom: a.reduce((s, x) => s + x, 0) / a.length,
});
const dist = (a) => {
  const c = new Map();
  for (const x of a) c.set(x, (c.get(x) || 0) + 1);
  return [...c.entries()].sort((p, q) => p[0] - q[0]).map(([v, n]) => `${v}:${n}`).join(' · ');
};

// ── recolección ─────────────────────────────────────────────────────────────
const salidas = [], faltan = new Map(), ambiguos = new Map();
let bloques = 0, personas = 0, llegadas = 0, hoteles = 0;

const anota = (mapa, k, quien) => {
  if (!mapa.has(k)) mapa.set(k, new Set());
  mapa.get(k).add(quien);
};

for (const archivo of archivos) {
  const vueltas = leerPlan(DIR, archivo);
  for (const v of vueltas) {
    bloques++; personas += v.pax;
    if (v.esLlegada) llegadas++;
    if (v.hotel) hoteles++;
    for (const p of v.paradas) {
      if (p.vuelo || p.hotel || p.aero || !p.lugar) continue;
      const c = buscar(p.lugar);
      if (!c) anota(faltan, p.lugar, `${p.quien} (${archivo})`);
      else if (c.ambiguo) anota(ambiguos, `${p.lugar} → ${c.ambiguo.join(' / ')}`, p.quien);
    }
    if (v.tipo !== 'salida' || !v.paradas.length) continue;

    const ult = v.paradas[v.paradas.length - 1];
    const pri = v.paradas[0];
    const casa = buscar(ult.lugar);
    salidas.push({
      archivo, v,
      tramoFinal: v.deadline - ult.t,
      espera: v.deadline - pri.t,
      deadline: v.deadline,
      lugarUlt: ult.lugar,
      casa: casa && !casa.ambiguo ? casa : null,
      paradas: v.paradas.length,
      pax: v.pax,
    });
  }
}

// ── 1. la regla del +20 ─────────────────────────────────────────────────────
console.log(`\n══════════ ${archivos.length} mensajes · ${bloques} bloques · ${personas} personas · ${salidas.length} vueltas de salida ══════════`);

const tf = salidas.map((s) => s.tramoFinal);
const e1 = num(tf);
console.log(`\n1. TRAMO FINAL (última recogida → "deben estar")`);
console.log(`   n=${e1.n} · mín ${e1.min} · mediana ${e1.med} · promedio ${e1.prom.toFixed(1)} · máx ${e1.max} min`);
console.log(`   reparto → ${dist(tf)}`);
const bajo20 = salidas.filter((s) => s.tramoFinal < 20);
console.log(`   POR DEBAJO DE 20: ${bajo20.length}/${e1.n} (${(100 * bajo20.length / e1.n).toFixed(0)}%)`);
for (const s of bajo20) {
  console.log(`     ✗ ${s.archivo} · estar ${hm(s.deadline)} · ${s.tramoFinal} min desde ${s.lugarUlt} — ${s.v.paradas.map((p) => p.quien).join(', ')}`);
}

// ── 2. el techo de espera ───────────────────────────────────────────────────
const franja = (t) => {
  const h = Math.floor(t / 60) % 24;
  return (h >= 6 && h < 9) || (h >= 12 && h < 18) ? 'pico (6-9 / 12-18) → techo 60' : 'valle → techo 50';
};
console.log(`\n2. ESPERA DEL PRIMERO ("deben estar" − primera recogida)`);
const porFranja = new Map();
for (const s of salidas) {
  const f = franja(s.deadline);
  if (!porFranja.has(f)) porFranja.set(f, []);
  porFranja.get(f).push(s);
}
for (const [f, ss] of porFranja) {
  const a = ss.map((s) => s.espera), st = num(a);
  const techo = f.includes('60') ? 60 : 50;
  const rotos = ss.filter((s) => s.espera > techo);
  console.log(`   ${f}: n=${st.n} · máx ${st.max} · mediana ${st.med} min · pasan del techo: ${rotos.length}`);
  for (const s of rotos) console.log(`     ✗ ${s.archivo} · estar ${hm(s.deadline)} · esperó ${s.espera} min — ${s.v.paradas[0].quien}`);
}

// ── 3. el cupo ──────────────────────────────────────────────────────────────
const pax = salidas.map((s) => s.pax);
console.log(`\n3. CUPO`);
console.log(`   personas por vuelta → ${dist(pax)} · máx ${Math.max(...pax)}`);
console.log(`   paradas por vuelta  → ${dist(salidas.map((s) => s.paradas))}`);
const sobreCupo = salidas.filter((s) => s.pax > 4);
console.log(`   vueltas con más de 4 personas: ${sobreCupo.length}`);
for (const s of sobreCupo) console.log(`     ✗ ${s.archivo} · estar ${hm(s.deadline)} · ${s.pax} pax`);

// ── 4. múltiplos de 5 ───────────────────────────────────────────────────────
const horas = salidas.flatMap((s) => s.v.paradas.map((p) => p.t)).concat(salidas.map((s) => s.deadline));
const noMult5 = horas.filter((t) => t % 5 !== 0);
console.log(`\n4. HORAS EN MÚLTIPLOS DE 5: ${horas.length - noMult5.length}/${horas.length} (${(100 * (horas.length - noMult5.length) / horas.length).toFixed(0)}%)`);
if (noMult5.length) console.log(`   fuera de la regla: ${noMult5.map(hm).join(' · ')}`);

// ── 4b. entre paradas vs tramo final ────────────────────────────────────────
// La pregunta que decide si el arreglo es un factor global de tráfico o no:
// ¿el jefe discrepa de OSRM en TODA la vuelta, o solo en el viaje a MDE?
console.log(`\n4b. PASO ENTRE PARADAS (casa → casa), su hora contra OSRM`);
const pasos = [];
for (const s of salidas) {
  for (let i = 1; i < s.v.paradas.length; i++) {
    const a = buscar(s.v.paradas[i - 1].lugar), b = buscar(s.v.paradas[i].lugar);
    if (!a || !b || a.ambiguo || b.ambiguo) continue;
    const o = await osrmMin(a, b);
    if (o == null) continue;
    pasos.push({ jefe: s.v.paradas[i].t - s.v.paradas[i - 1].t, osrm: o });
  }
}
guardarCache();
if (pasos.length) {
  const sj = pasos.reduce((s, x) => s + x.jefe, 0), so = pasos.reduce((s, x) => s + x.osrm, 0);
  const difs = pasos.map((x) => x.jefe - x.osrm);
  const d = num(difs);
  console.log(`   n=${pasos.length} · jefe ${(sj / pasos.length).toFixed(1)} min · OSRM ${(so / pasos.length).toFixed(1)} min · factor ${(sj / so).toFixed(2)}`);
  console.log(`   diferencia (jefe − OSRM): mediana ${d.med.toFixed(1)} · promedio ${d.prom.toFixed(1)} min`);
  console.log(`   dentro de ±3 min: ${difs.filter((x) => Math.abs(x) <= 3).length}/${difs.length}`);
  console.log(`   → ojo: acá el jefe incluye el tiempo de subir a la gente, así que le SOBRA sobre OSRM.`);
}

// ── 5. la velocidad ─────────────────────────────────────────────────────────
console.log(`\n5. VELOCIDAD IMPLÍCITA — su tramo final contra OSRM`);
console.log(`   (solo vueltas de UNA parada: ahí el tramo final es viaje puro, sin servicio)`);
const unaParada = salidas.filter((s) => s.paradas === 1 && s.casa);
const filas = [];
for (const s of unaParada) {
  const o = await osrmMin(s.casa, MDE);
  if (o != null) filas.push({ lugar: s.casa.nombre, jefe: s.tramoFinal, osrm: o, ratio: s.tramoFinal / o });
}
guardarCache();
for (const f of filas.sort((a, b) => a.ratio - b.ratio)) {
  console.log(`   ${f.lugar.padEnd(26)} jefe ${String(f.jefe).padStart(3)} min · OSRM ${f.osrm.toFixed(1).padStart(5)} min · jefe/OSRM ${f.ratio.toFixed(2)}`);
}
if (filas.length) {
  const sj = filas.reduce((s, f) => s + f.jefe, 0), so = filas.reduce((s, f) => s + f.osrm, 0);
  console.log(`   ───`);
  console.log(`   TOTAL: jefe ${sj} min vs OSRM ${so.toFixed(1)} min → factor ${(sj / so).toFixed(3)}`);
  console.log(`   (route_traffic_factor equivalente para que OSRM diga lo que él hace: ${(sj / so).toFixed(2)})`);
}

// ── 5b. ¿el forfait depende de la hora? ─────────────────────────────────────
// Hipótesis: a las 3 a.m. la vía está sola y el mismo conjunto le cuesta menos.
// Si es cierto, un forfait plano es el modelo equivocado.
console.log(`\n5b. TRAMO FINAL POR HORA DEL DÍA (vueltas de una parada, para no mezclar servicio)`);
const franjaH = (t) => {
  const h = Math.floor(t / 60) % 24;
  return h < 6 ? '00-06 madrugada' : h < 12 ? '06-12 mañana' : h < 18 ? '12-18 tarde' : '18-24 noche';
};
const porHora = new Map();
for (const s of unaParada) {
  const o = await osrmMin(s.casa, MDE);
  if (o == null) continue;
  const f = franjaH(s.deadline);
  if (!porHora.has(f)) porHora.set(f, []);
  porHora.get(f).push({ jefe: s.tramoFinal, osrm: o });
}
for (const [f, a] of [...porHora.entries()].sort()) {
  const sj = a.reduce((s, x) => s + x.jefe, 0), so = a.reduce((s, x) => s + x.osrm, 0);
  console.log(`   ${f}: n=${a.length} · jefe ${(sj / a.length).toFixed(1)} min · OSRM ${(so / a.length).toFixed(1)} min · factor ${(sj / so).toFixed(2)}`);
}

// ── 6. lo que no está en el catálogo ────────────────────────────────────────
console.log(`\n6. LUGARES QUE NO ESTÁN EN EL CATÁLOGO (${CAT.length} conjuntos hoy)`);
if (!faltan.size) console.log('   ninguno');
for (const [l, quienes] of [...faltan.entries()].sort((a, b) => b[1].size - a[1].size)) {
  console.log(`   ✗ "${l}" → ${[...quienes].join(' · ')}`);
}
if (ambiguos.size) {
  console.log(`\n   AMBIGUOS (dos conjuntos empatan; hay que preguntar cuál es):`);
  for (const [l, quienes] of ambiguos) console.log(`   ? ${l} → ${[...quienes].join(' · ')}`);
}
