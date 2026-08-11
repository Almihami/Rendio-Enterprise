#!/usr/bin/env node
// PLAN DEL DÍA — corre el optimizador REAL de la app, fuera del navegador.
//
// PARA QUÉ. Para poder enseñarle el plan al jefe (y compararlo contra el que él
// arma a mano) sin tener que abrir la PWA, optimizar y transcribir la pantalla.
// La primera vez que se hizo esto (5-ago) el arnés se armó al vuelo y se perdió;
// esta es la versión guardada.
//
// LO IMPORTANTE: NO reimplementa nada. Lee admin-rutas.js, corta el archivo justo
// donde termina rtSolveDay() y evalúa ESE código. Si el solver cambia, esto
// cambia con él — que es todo el punto: el papel tiene que decir lo mismo que la
// pantalla. Lo único que se stubea es lo del navegador (state, Api, window, $).
//
// Los datos salen de la BD igual que en la app (mismas columnas que
// Api.listRoutePlanning), y los tiempos de OSRM con el factor de tráfico de
// Ajustes — no de TomTom: para un día que aún no llega, el tráfico en vivo no
// aplica (y TomTom cobra por celda).
//
// Uso:
//   node scripts/plan-del-dia.mjs .env.dev 2026-08-07
//   node scripts/plan-del-dia.mjs .env.dev 2026-08-07 --carros=3
//   node scripts/plan-del-dia.mjs .env.dev 2026-08-07 --json=/tmp/plan.json
//
// OJO con --carros: la app hoy solo mira los 2 primeros vehículos de la flota
// (Api.listRoutePlanning hace slice(0,2)). Aquí se puede pedir la flota completa
// para ver qué pasaría con 3, que es lo que la operación usa de verdad.

import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'node:fs';

const RUTAS_JS = '/Users/harold/Documents/Rendio-Drivers/Proyect/rendio-turnos/admin-rutas.js';
// rtToMin/rtToHM/rtIni/rtEsc viven en admin-consola.js (scope global compartido,
// se carga antes). Se toman de allá, no se copian: si cambian, cambian aquí.
const CONSOLA_JS = '/Users/harold/Documents/Rendio-Drivers/Proyect/rendio-turnos/admin-consola.js';

const envFile = process.argv[2] || '.env.dev';
const DIA = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const NCARROS = Number((process.argv.find((a) => a.startsWith('--carros=')) || '').split('=')[1] || 0);
// Carros que NO existen en la flota, para responder "¿y si tuviéramos uno más?".
const EXTRA = Number((process.argv.find((a) => a.startsWith('--extra=')) || '').split('=')[1] || 0);
// Hora desde la que los carros están disponibles (la app la fija en 01:30).
const DESDE = (process.argv.find((a) => a.startsWith('--desde=')) || '').split('=')[1] || '01:30';
const JSONOUT = (process.argv.find((a) => a.startsWith('--json=')) || '').split('=')[1] || null;
// Factor de tráfico SOLO para este ensayo, sin tocar Ajustes. Sirve para probar
// qué pasaría si el modelo creyera que se anda más rápido de lo que dice OSRM
// (OSRM asume ~29 km/h en Rionegro; el plan manual del jefe implica ~40 en el
// corredor norte→MDE). No escribe nada en la BD.
const TRAFICO = Number((process.argv.find((a) => a.startsWith('--trafico=')) || '').split('=')[1] || 0);
// Colchón en el aeropuerto, también solo para el ensayo. El jefe deja ~20 min de
// margen sobre la hora de presentación; el solver deja 10.
const COLCHON = Number((process.argv.find((a) => a.startsWith('--colchon=')) || '').split('=')[1] || 0);
// Colchón de arranque del carro, mismo espíritu: el jefe no se lo toma.
const SALIDA = process.argv.find((a) => a.startsWith('--salida=')) ? Number(process.argv.find((a) => a.startsWith('--salida=')).split('=')[1]) : null;
if (!DIA) { console.error('Falta el día: node scripts/plan-del-dia.mjs .env.dev YYYY-MM-DD'); process.exit(1); }

const env = Object.fromEntries(
  readFileSync(new URL(`../${envFile}`, import.meta.url), 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// ── 1) El solver, tal cual está en la app ───────────────────────────────────
const SRC = readFileSync(RUTAS_JS, 'utf8');
const marca = 'return { lanes, order, unassigned };';
const iFin = SRC.indexOf(marca);
if (iFin < 0) { console.error('No encontré el final de rtSolveDay en admin-rutas.js — ¿cambió el solver?'); process.exit(1); }
const solverSrc = SRC.slice(0, SRC.indexOf('\n  }', iFin) + 4);

// Helpers de tiempo del scope compartido: se corta admin-consola.js justo donde
// terminan (antes de CN_DATA, que ya es UI).
const CSRC = readFileSync(CONSOLA_JS, 'utf8');
const helpersSrc = CSRC.slice(0, CSRC.indexOf('  // ---------------- CONSOLA'));

// Stubs de navegador. `window` va vacío a propósito: así rtBuildMatrix salta
// TomTom (que necesita la Edge Function) y usa OSRM.
const fabrica = new Function('state', 'Api', 'window', 'toast', '$', 'fetch', `
  ${helpersSrc}
  ${solverSrc}
  return { rt, rtSolveDay, rtCarCompute, rtBuildMatrix, rtToMin, rtToHM, rtStopKey, rtCfg, RT_AIRPORT, RT_DEPOT };
`);

// ── 2) Datos: las mismas columnas que Api.listRoutePlanning ─────────────────
const bogDay = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
const hhmm = (iso) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit' });

const { data: rows, error } = await admin.from('reservations')
  .select('id, direction, pickup_address, pickup_latitude, pickup_longitude, required_arrival_at, notes, is_overnight, is_firm, residence_id, residences(name), auxiliar_profiles(profiles(full_name, phone)), flights(flight_number)')
  .is('cancelled_at', null)
  .order('required_arrival_at', { ascending: true });
if (error) { console.error('reservations:', error.message); process.exit(1); }

const delDia = rows.filter((r) => bogDay(r.required_arrival_at) === DIA);
if (!delDia.length) { console.error(`No hay reservas para ${DIA}. Días con datos: ${[...new Set(rows.map((r) => bogDay(r.required_arrival_at)))].sort().join(', ')}`); process.exit(1); }

const { data: vs } = await admin.from('vehicles')
  .select('id, internal_code, license_plate, capacity, status').is('deleted_at', null).order('internal_code');
const flota = (vs || []).filter((v) => v.status !== 'inactive');
const usados = NCARROS ? flota.slice(0, NCARROS) : flota.slice(0, 2);   // 2 = lo que hace la app hoy

const { data: st } = await admin.from('app_settings').select('*').eq('id', 'singleton').maybeSingle();
if (TRAFICO) st.route_traffic_factor = TRAFICO;      // solo en memoria, ver --trafico
if (COLCHON) st.route_airport_buffer_min = COLCHON; // solo en memoria, ver --colchon
if (SALIDA !== null) st.route_depart_cushion_min = SALIDA; // solo en memoria, ver --salida

// ── 3) Montar el estado del tablero y optimizar ─────────────────────────────
const S = fabrica({ settings: st || {} }, {}, {}, () => {}, () => null, globalThis.fetch);
S.rtCfg();

const aux = {};
delDia.forEach((r) => {
  const key = 'r' + String(r.id).slice(0, 8);
  aux[key] = {
    n: r.auxiliar_profiles?.profiles?.full_name || 'Auxiliar',
    zona: r.residences?.name || (r.pickup_address || '—').split(',').pop().trim(),
    resId: r.residence_id || null,
    dir: r.pickup_address || '',
    lat: r.pickup_latitude, lng: r.pickup_longitude,
    dl: hhmm(r.required_arrival_at),
    pax: 1,
    type: r.direction === 'airport_to_home' ? 'lle' : 'sal',
    reservationId: r.id,
    // El número de vuelo entra por el formulario y hoy vive en las notas
    // ("Vuelo 8437."). Viene como lo escribió el tripulante: unos con sigla
    // (AV9717, JA5116) y otros solo los dígitos.
    vuelo: r.flights?.flight_number || (r.notes || '').match(/Vuelo\s+([A-Za-z]{0,3}\s?\d+)/)?.[1]?.replace(/\s/g, '') || '',
    notas: r.notes || '',
    hotel: !!r.is_overnight,
    firme: !!r.is_firm,
  };
});
S.rt.aux = aux;
S.rt.day = DIA;
S.rt.cars = usados.map((v, i) => ({ id: v.internal_code || v.license_plate || ('Carro ' + (i + 1)), avail0: DESDE, capacity: v.capacity || 4, vehicleId: v.id }));
for (let i = 0; i < EXTRA; i++) S.rt.cars.push({ id: `EXTRA-${i + 1}`, avail0: DESDE, capacity: S.rt.CAP, vehicleId: null });

// OSRM es un servicio público y a veces no contesta. Cuando falla, el solver
// cae a distancia en LÍNEA RECTA y el plan sale optimista: en el 7-ago la
// diferencia fue de 5 traslados sin carro contra 10. Un plan así no se puede
// enseñar como si fuera real, así que se reintenta y, si igual no hay, se grita.
let fuente = await S.rtBuildMatrix();
for (let i = 0; i < 3 && fuente === 'haversine'; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  fuente = await S.rtBuildMatrix();
}
if (fuente === 'haversine') {
  console.error('\n⚠  SIN OSRM — los tiempos son en línea recta, NO por carretera.');
  console.error('   Este plan sale optimista y no sirve para enseñar. Vuelve a correrlo.\n');
  if (!process.argv.includes('--igual-corre')) process.exit(3);
}

const { lanes, order, unassigned } = S.rtSolveDay();
S.rt.lanes = lanes; S.rt.order = order;

// ── 4) Salida ───────────────────────────────────────────────────────────────
const vueltas = lanes.map((l) => {
  const c = S.rtCarCompute(l.id);
  const paradas = [];
  c.stops.forEach((s) => {
    const a = aux[s.id];
    const ult = paradas[paradas.length - 1];
    const k = S.rtStopKey(s.id);
    if (ult && ult.key === k) { ult.personas.push({ n: a.n, dl: a.dl, vuelo: a.vuelo, hotel: a.hotel, firme: a.firme }); return; }
    paradas.push({ key: k, zona: a.zona, eta: S.rtToHM(s.eta), personas: [{ n: a.n, dl: a.dl, vuelo: a.vuelo, hotel: a.hotel, firme: a.firme }] });
  });
  return {
    id: l.id, carro: l.car, vuelta: l.vuelta, tipo: l.type,
    sale: l.start,
    origen: l.origin === 'airport' ? 'MDE' : (l.origin ? (aux[l.origin]?.zona || 'casa') : 'base'),
    aterriza: l.landing || null,
    llega: c.arrival != null ? S.rtToHM(c.arrival) : null,
    presentacion: l.type === 'sal' && c.hardDL != null ? S.rtToHM(c.hardDL) : null,
    holgura: c.holg, espera: c.wait || 0, estado: c.status, pax: c.pax,
    paradas,
  };
}).sort((a, b) => S.rtToMin(a.sale) - S.rtToMin(b.sale));

const sinRutear = unassigned.map((id) => ({ n: aux[id].n, zona: aux[id].zona, dl: aux[id].dl, tipo: aux[id].type }));

const salida = {
  dia: DIA, fuenteTiempos: fuente,
  ajustes: {
    hueco: S.rt.MERGE_WINDOW, servicio: S.rt.SERVICE_MIN, colchonAeropuerto: S.rt.AIRPORT_BUFFER,
    trafico: S.rt.TRAFFIC_FACTOR, turnaround: S.rt.TURNAROUND, desembarque: S.rt.DEPLANE,
    colchonSalida: S.rt.CUSHION, cupo: S.rt.CAP,
  },
  carros: S.rt.cars.map((c) => ({ id: c.id, cupo: c.capacity })),
  traslados: delDia.length,
  salidas: delDia.filter((r) => r.direction !== 'airport_to_home').length,
  llegadas: delDia.filter((r) => r.direction === 'airport_to_home').length,
  vueltas, sinRutear,
};

if (JSONOUT) { writeFileSync(JSONOUT, JSON.stringify(salida, null, 2)); console.log(`JSON → ${JSONOUT}\n`); }

// ── Formato del jefe ────────────────────────────────────────────────────────
// Como Julián escribe su programación a mano: una línea por recogida
// "3:15 Paulina (Boral)" y al cerrar la vuelta "Debe estar 3:40". Las llegadas
// las anota con la hora en que aterriza el vuelo y el número de vuelo.
if (process.argv.includes('--formato=jefe')) {
  // Como Julián escribe la programación: UNA sola lista en orden de reloj, con
  // salidas y llegadas mezcladas. Cada bloque es una vuelta.
  //   · salida  → una línea por portería y al cierre "Debe/Deben estar HH:MM"
  //   · llegada → una línea por vuelo, con la hora en que aterriza y el código
  //     entre paréntesis; sin hora de presentación, porque no la tiene.
  const hm = (t) => t.replace(/^0/, '');
  const pilas = {};
  Object.values(aux).forEach((a) => { const p = a.n.split(' ')[0]; pilas[p] = (pilas[p] || new Set()).add(a.n); });
  const corto = (n) => { const p = n.split(' '); return pilas[p[0]].size > 1 ? `${p[0]} ${(p[1] || '')[0]}.` : p[0]; };
  const lista = (xs) => xs.length > 1 ? xs.slice(0, -1).join(', ') + ' y ' + xs[xs.length - 1] : xs[0];
  const lugar = (z) => z.replace(/^(Edificio|Urb\.|Condominio|Club|Casa azul|Conjunto)\s+/i, '')
    .replace(/\s+(Apartamentos|Apartamento)$/i, '').replace(/\s*\/.*$/, '').trim();
  // El mismo vuelo escrito de dos formas ("8437" y "Av8437") es UN vuelo; gana
  // la versión con sigla, que es la que dice la aerolínea.
  const codVuelo = (xs) => {
    const m = new Map();
    xs.filter(Boolean).forEach((v) => { const k = v.toUpperCase().replace(/^[A-Z]+/, ''); const a = m.get(k); if (!a || /^[A-Z]/i.test(v)) m.set(k, v.toUpperCase()); });
    return [...m.values()];
  };

  // Cada bloque se ordena por la hora de su PRIMERA línea, que es como queda la
  // hoja: la salida por la primera recogida, la llegada por el aterrizaje.
  const bloques = vueltas.map((v) => {
    if (v.tipo === 'sal') {
      const lineas = v.paradas.map((p) => `${hm(p.eta)} ${lista(p.personas.map((x) => corto(x.n)))} (${lugar(p.zona)})`);
      const pax = v.paradas.reduce((n, p) => n + p.personas.length, 0);
      lineas.push(`${pax > 1 ? 'Deben' : 'Debe'} estar ${hm(v.presentacion)}`);
      return { orden: S.rtToMin(v.paradas[0].eta), lineas };
    }
    // Llegada: se agrupa por VUELO —a él le importa de qué avión baja la gente,
    // no en qué orden la dejan— y la hora es la de ESE vuelo, no la de la vuelta:
    // un carro puede recoger dos aterrizajes seguidos y son dos líneas.
    // La pernocta va aparte aunque comparta vuelo: el destino es otro.
    const porVuelo = new Map();
    v.paradas.forEach((p) => p.personas.forEach((x) => {
      const k = ((x.vuelo || '').toUpperCase().replace(/^[A-Z]+/, '') || 'sin') + (x.hotel ? '|hotel' : '');
      if (!porVuelo.has(k)) porVuelo.set(k, { nombres: [], vuelos: [], hotel: x.hotel, hora: x.dl });
      const g = porVuelo.get(k); g.nombres.push(corto(x.n)); g.vuelos.push(x.vuelo);
      if (x.dl < g.hora) g.hora = x.dl;
    }));
    const grupos = [...porVuelo.values()].sort((a, b) => a.hora.localeCompare(b.hora));
    const lineas = grupos.map((g) => {
      const cod = codVuelo(g.vuelos);
      return `${hm(g.hora)} ${lista(g.nombres)} (${cod[0] || 'Aero'})${g.hotel ? ' — hotel' : ''}`;
    });
    return { orden: S.rtToMin(grupos[0].hora), lineas };
  }).sort((a, b) => a.orden - b.orden);

  console.log(`──────── PROGRAMACIÓN ${DIA} ────────`);
  console.log(`${S.rt.cars.length} carros, ${S.rt.CAP} puestos cada uno · tiempos por carretera (${fuente})\n`);
  bloques.forEach((b) => console.log(b.lineas.join('\n') + '\n'));
  if (sinRutear.length) {
    console.log(`SIN CARRO (${sinRutear.length})\n`);
    sinRutear.forEach((x) => console.log(`${hm(x.dl)} ${corto(x.n)} (${lugar(x.zona)}) — ${x.tipo === 'sal' ? 'debe estar' : 'aterriza'}`));
  }
  process.exit(0);
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`\nPLAN DEL ${DIA} · ${delDia.length} traslados (${salida.salidas} salidas + ${salida.llegadas} llegadas) · ${S.rt.cars.length} carros de ${S.rt.CAP} puestos`);
console.log(`tiempos: ${fuente} · hueco ${S.rt.MERGE_WINDOW}′ · servicio ${S.rt.SERVICE_MIN}′ · colchón MDE ${S.rt.AIRPORT_BUFFER}′ · tráfico ×${S.rt.TRAFFIC_FACTOR}\n`);
for (const v of vueltas) {
  const cab = v.tipo === 'sal'
    ? `${pad(v.sale, 6)} ${pad(v.carro + '·V' + v.vuelta, 12)} SALIDA  → MDE ${v.llega}  (presentación ${v.presentacion}, holgura ${v.holgura}′)`
    : `${pad(v.sale, 6)} ${pad(v.carro + '·V' + v.vuelta, 12)} LLEGADA  aterriza ${v.aterriza}${v.espera ? ` (espera ${v.espera}′)` : ''}  termina ${v.llega}`;
  console.log(`${cab}${v.estado === 'late' ? '  ⚠ TARDE' : ''}`);
  v.paradas.forEach((p, i) => console.log(`        ${i + 1}. ${pad(p.eta, 6)} ${pad(p.zona, 26)} ${p.personas.map((x) => x.n + (x.hotel ? ' [hotel]' : '')).join(' · ')}`));
}
if (sinRutear.length) {
  console.log(`\nSIN RUTEAR (${sinRutear.length}):`);
  sinRutear.forEach((x) => console.log(`   ${x.dl}  ${x.tipo === 'sal' ? 'salida ' : 'llegada'}  ${pad(x.n, 24)} ${x.zona}`));
}
console.log(`\nvueltas: ${vueltas.length} · tarde: ${vueltas.filter((v) => v.estado === 'late').length} · sin rutear: ${sinRutear.length}`);
