#!/usr/bin/env node
// SOLO LECTURA (no escribe nada en la BD) — mide si NUESTRO modelo de tiempos
// considera factibles las vueltas que el jefe rueda todos los días.
//
// POR QUÉ ASÍ. Comparar "nuestro agrupamiento vs el suyo" exige tener las reservas
// del día en la BD. Esto no: toma sus vueltas TAL COMO LAS ARMÓ (mismas paradas,
// mismo orden, misma hora de arranque) y le pregunta al solver real a qué hora
// llegaría a MDE. Como su plan sí rueda, **cada "tarde" es un error del modelo,
// no del jefe**. Es la prueba directa del tramo final.
//
// Usa el código real de admin-rutas.js (rtLegMin, rtCarCompute, SERVICE_MIN,
// TRAFFIC_FACTOR…), igual que plan-del-dia.mjs: no reimplementa el modelo.
//
// Uso:
//   set -a; source .env.dev; set +a
//   node scripts/comparar-con-jefe.mjs                 # ajustes tal cual están en dev
//   node scripts/comparar-con-jefe.mjs --aero=0.75     # ensayo: factor del tramo a MDE
//   node scripts/comparar-con-jefe.mjs --trafico=1.05 --aero=1.0
import { createClient } from '@supabase/supabase-js';
import { readFileSync, readdirSync } from 'node:fs';
import { catalogo, leerPlan, hm } from './planes-jefe/lib-plan.mjs';

const RUTAS_JS = new URL('../../rendio-turnos/admin-rutas.js', import.meta.url).pathname;
const CONSOLA_JS = new URL('../../rendio-turnos/admin-consola.js', import.meta.url).pathname;
const DIR = new URL('./planes-jefe/', import.meta.url).pathname;

const arg = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? Number(a.split('=')[1]) : null; };
const TRAFICO = arg('trafico'), AERO = arg('aero'), SERVICIO = arg('servicio');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: resid, error } = await sb.from('residences').select('*');
if (error) { console.error('residences:', error.message); process.exit(1); }
const { buscar } = catalogo(resid);
const { data: st } = await sb.from('app_settings').select('*').eq('id', 'singleton').maybeSingle();

const ajustes = { ...(st || {}) };
if (TRAFICO != null) ajustes.route_traffic_factor = TRAFICO;
if (AERO != null) ajustes.route_airport_factor = AERO;
if (SERVICIO != null) ajustes.route_service_min = SERVICIO;

// ── el solver real, recortado de la app ─────────────────────────────────────
const SRC = readFileSync(RUTAS_JS, 'utf8');
const marca = 'return { lanes, order, unassigned };';
const iFin = SRC.indexOf(marca);
if (iFin < 0) { console.error('No encontré el final de rtSolveDay — ¿cambió el solver?'); process.exit(1); }
const solverSrc = SRC.slice(0, SRC.indexOf('\n  }', iFin) + 4);
const CSRC = readFileSync(CONSOLA_JS, 'utf8');
const helpersSrc = CSRC.slice(0, CSRC.indexOf('  // ---------------- CONSOLA'));

const fabrica = new Function('state', 'Api', 'window', 'toast', '$', 'fetch', `
  ${helpersSrc}
  ${solverSrc}
  return { rt, rtCfg, rtCarCompute, rtBuildMatrix, rtLegMin, rtToMin, rtToHM };
`);
const S = fabrica({ settings: ajustes }, {}, {}, () => {}, () => null, globalThis.fetch);
S.rtCfg();

// ── sus vueltas → el tablero ────────────────────────────────────────────────
const archivos = process.argv.filter((a) => a.endsWith('.txt'));
const planes = archivos.length ? archivos : readdirSync(DIR).filter((f) => f.startsWith('plan-') && f.endsWith('.txt')).sort();

// OSRM /table tiene tope de puntos, así que se procesa UN mensaje a la vez y se
// acumula. La matriz se reconstruye por mensaje.
let saltadas = 0;
const faltantes = new Set();
const filas = [];
let fuente = null;

for (const archivo of planes) {
  const aux = {}, lanes = [], order = {};
  for (const [i, v] of leerPlan(DIR, archivo).entries()) {
    if (v.tipo !== 'salida' || !v.paradas.length) continue;
    const casas = v.paradas.map((p) => ({ p, c: buscar(p.lugar) }));
    // Una vuelta con una parada sin coordenada no se puede evaluar sin inventar
    // dónde queda. Se salta y se dice cuál, en vez de rellenar.
    if (casas.some((x) => !x.c || x.c.ambiguo)) {
      saltadas++;
      casas.filter((x) => !x.c || x.c.ambiguo).forEach((x) => faltantes.add(x.p.lugar));
      continue;
    }
    const laneId = `${archivo}#${i}`;
    order[laneId] = [];
    casas.forEach(({ p, c }, j) => {
      const id = `${laneId}:${j}`;
      aux[id] = { n: p.quien, zona: c.nombre, resId: c.id, lat: c.lat, lng: c.lon, dl: hm(v.deadline), pax: p.personas, type: 'sal' };
      order[laneId].push(id);
    });
    lanes.push({ id: laneId, car: archivo, vuelta: i, type: 'sal', start: hm(v.paradas[0].t), origin: null, _v: v, _archivo: archivo });
  }

  S.rt.aux = aux; S.rt.lanes = lanes; S.rt.order = order;
  let f = await S.rtBuildMatrix();
  for (let k = 0; k < 3 && f === 'haversine'; k++) {
    await new Promise((r) => setTimeout(r, 1500));
    f = await S.rtBuildMatrix();
  }
  if (f === 'haversine') { console.error(`⚠  SIN OSRM en ${archivo} — línea recta, no sirve para calibrar.`); process.exit(3); }
  fuente = f;

  for (const l of lanes) {
    const c = S.rtCarCompute(l.id);
    const ultimo = order[l.id][order[l.id].length - 1];
    filas.push({
      l, c, zonas: order[l.id].map((id) => aux[id].zona),
      deadline: c.hardDL,
      // "tarde" puro: ¿el carro pisa MDE después de la hora de presentación?
      tardePuro: c.arrival - c.hardDL,
      // "tarde" como lo juzga la app, que exige entregar con AIRPORT_BUFFER antes.
      holg: c.holg,
      tramoFinalNuestro: S.rtLegMin(ultimo, 'airport'),
      tramoFinalJefe: c.hardDL - l._v.paradas[l._v.paradas.length - 1].t,  // .t ya viene en minutos
    });
  }
}

// ── medición ────────────────────────────────────────────────────────────────
console.log(`\n══════════ ${filas.length} vueltas de salida del jefe · tiempos ${fuente} ══════════`);
console.log(`ajustes: tráfico ×${S.rt.TRAFFIC_FACTOR} · servicio ${S.rt.SERVICE_MIN} min/parada · colchón MDE ${S.rt.AIRPORT_BUFFER} min · tramo aeropuerto ×${S.rt.AIRPORT_FACTOR ?? 1}`);
if (saltadas) console.log(`(${saltadas} vueltas saltadas por paradas sin coordenada: ${[...faltantes].join(', ')})`);

const tarde = filas.filter((f) => f.tardePuro > 0);
const tardeApp = filas.filter((f) => f.holg < 0);
const pc = (n) => `${n}/${filas.length} (${(100 * n / filas.length).toFixed(0)}%)`;

console.log(`\n▸ LLEGA DESPUÉS DE LA HORA DE PRESENTACIÓN: ${pc(tarde.length)}`);
console.log(`▸ LO QUE LA APP MARCARÍA 'late' (exige ${S.rt.AIRPORT_BUFFER} min de colchón): ${pc(tardeApp.length)}`);

const exc = filas.map((f) => f.tardePuro);
const suma = exc.reduce((s, x) => s + x, 0);
console.log(`▸ desfase contra su hora: promedio ${(suma / filas.length).toFixed(1)} min · peor ${Math.max(...exc).toFixed(0)} min · mejor ${Math.min(...exc).toFixed(0)} min`);

const tf = filas.map((f) => f.tramoFinalNuestro - f.tramoFinalJefe);
console.log(`▸ tramo final (última casa → MDE): nosotros ${(filas.reduce((s, f) => s + f.tramoFinalNuestro, 0) / filas.length).toFixed(1)} min vs jefe ${(filas.reduce((s, f) => s + f.tramoFinalJefe, 0) / filas.length).toFixed(1)} min → ${(tf.reduce((s, x) => s + x, 0) / tf.length).toFixed(1)} min de más`);

if (process.argv.includes('--detalle')) {
  console.log('\n  peores 12:');
  for (const f of filas.slice().sort((a, b) => b.tardePuro - a.tardePuro).slice(0, 12)) {
    console.log(`   ${f.l._archivo.replace('plan-', '').replace('.txt', '').padEnd(16)} estar ${hm(f.deadline)} · llegamos ${S.rtToHM(Math.round(f.c.arrival))} (${f.tardePuro > 0 ? '+' : ''}${f.tardePuro.toFixed(0)}) · ${f.zonas.join(' → ')}`);
  }
}
