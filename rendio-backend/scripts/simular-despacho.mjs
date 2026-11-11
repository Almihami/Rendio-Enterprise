// SIMULADOR DEL DÍA: ruta fija vs llegadas en StandBy (10-nov-2026).
//
// Repite un día real con las horas REALES de los vuelos y compara:
//   A) RUTA FIJA: la noche anterior se le da carro a todo (salidas y llegadas),
//      con la hora programada. Es lo que hace hoy el WhatsApp.
//   B) STANDBY: la noche anterior solo se fijan las salidas. Cada llegada se
//      reparte durante el día con rendio-turnos/despacho-llegadas.js, usando lo
//      que FlightRadar sabía EN ESE MINUTO (eta_log), no la hora real.
// Mismo modelo de tiempos para las dos. No toca ninguna base: todo entra por
// archivos (reservas, vuelos, foto de ajustes).
//
//   node --import <fetch-cache> scripts/simular-despacho.mjs --dia=2026-10-28 \
//     --res=res.json --ajustes=snap.json [--vuelos=vuelos.json | --desvios=vuelos.json --semilla=1] \
//     [--v2='{"route_solver_v2":1,...}'] [--cfg='{"juntar":6}'] [--json=salida.json] [--detalle]
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const arg = (k, d = null) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const DIA = arg('dia'), DETALLE = process.argv.includes('--detalle');
if (!DIA || !arg('res') || !arg('ajustes')) { console.error('Faltan --dia, --res o --ajustes'); process.exit(1); }
const RT_DIR = new URL('../../rendio-turnos/', import.meta.url).pathname;
const Despacho = createRequire(import.meta.url)(RT_DIR + 'despacho-llegadas.js');

// ── El optimizador, tal cual está en la app ─────────────────────────────────
const SRC = readFileSync(RT_DIR + 'admin-rutas.js', 'utf8');
const marca = 'return { lanes, order, unassigned, apoyo };';
const iFin = SRC.indexOf(marca);
if (iFin < 0) { console.error('No encontré el final de rtSolveDay (¿cambió el optimizador?)'); process.exit(1); }
const solverSrc = SRC.slice(0, SRC.indexOf('\n  }', iFin) + 4);
const CSRC = readFileSync(RT_DIR + 'admin-consola.js', 'utf8');
const helpersSrc = CSRC.slice(0, CSRC.indexOf('  // ---------------- CONSOLA'));
const fabrica = new Function('state', 'Api', 'window', 'toast', '$', 'fetch', `
  ${helpersSrc}
  ${solverSrc}
  return { rt, rtSolveDay, rtCarCompute, rtBuildMatrix, rtToMin, rtToHM, rtCfg, rtLegMin, rtDeplaneOf, rtStopKey, rtHomesPlan };
`);
const snap = JSON.parse(readFileSync(arg('ajustes'), 'utf8'));
const st = Object.assign({}, (snap.app_settings || [])[0] || {}, JSON.parse(arg('v2', '{}')));
const S = fabrica({ settings: st }, {}, {}, () => {}, () => null, globalThis.fetch);
S.rtCfg();
const rt = S.rt, M = S.rtToMin;
const HM = (m) => { m = Math.round(m); return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(((m % 60) + 60) % 60).padStart(2, '0'); };

// ── Reservas del día → tablero (igual que Api.listRoutePlanning) ────────────
const D0 = Date.parse(DIA + 'T00:00:00-05:00');
const minDe = (iso) => Math.round((Date.parse(iso) - D0) / 60000);       // minutos desde la medianoche del día (puede pasar de 1440)
const RESERVE = { rio_verde: true, movich: true, aero: false };
const rows = JSON.parse(readFileSync(arg('res'), 'utf8')).filter((r) => !r.cancelled_at);
const aux = {};
rows.forEach((r) => {
  const key = 'r' + String(r.id).replace(/-/g, '').slice(0, 12);
  const reserva = r.reserve_place && r.reserve_place in RESERVE ? r.reserve_place : null;
  const tierra = r.ground_ops === true || !!reserva;
  const m = minDe(r.required_arrival_at);
  aux[key] = {
    n: r.auxiliar_profiles?.profiles?.full_name || r._form || 'Tripulante',
    zona: r.residences?.name || (r.pickup_address || '—').split(',').pop().trim(),
    resId: r.residence_id || null, lat: r.pickup_latitude, lng: r.pickup_longitude,
    dl: `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`, pax: 1,
    type: r.direction === 'airport_to_home' ? 'lle' : 'sal', reservationId: r.id,
    vuelo: tierra ? '' : String(r.flight_code || r.flights?.flight_number || (r.notes || '').match(/Vuelo\s+([A-Za-z]{0,3}\s?\d+)/)?.[1] || '').replace(/\s/g, '').toUpperCase(),
    tierra, reserva, hotel: !!(reserva && RESERVE[reserva]), sector: '', zonaJefe: null, dir: r.pickup_address || '', notas: '',
  };
});
rt.aux = aux; rt.day = DIA;
const nCarros = Math.max(1, Number(st.route_cars_count) || 2);
const nuevosCarros = () => Array.from({ length: nCarros }, (_, i) => ({ id: 'Carro ' + (i + 1), avail0: '00:00', capacity: rt.CAP, vehicleId: null }));
rt.cars = nuevosCarros();
rt.esDiaLento = new Date(DIA + 'T12:00:00').getDay() === 0 || (snap.holidays || []).some((h) => h.day === DIA);
let fuente = await S.rtBuildMatrix();
if (fuente === 'haversine') { console.error('⚠ sin OSRM: tiempos en línea recta'); if (!process.argv.includes('--igual-corre')) process.exit(3); }

const ids = Object.keys(aux), llegadas = ids.filter((id) => aux[id].type === 'lle'), salidas = ids.filter((id) => aux[id].type === 'sal');
const dlDe = (id) => M(aux[id].dl);
const desemb = (id) => S.rtDeplaneOf([id], dlDe(id));
const leg = (a, b, hora) => { rt._hora = hora; return a === b ? 0 : S.rtLegMin(a, b); };

// ── Hora real de cada llegada y lo que se SABÍA en cada minuto ──────────────
// real[id]   = minuto en que la persona está afuera (aterrizó + desembarque).
// sabia(id,t) = lo mismo, pero con lo que FlightRadar decía en el minuto t.
const real = {}, etas = {};
if (arg('vuelos')) {
  const vs = JSON.parse(readFileSync(arg('vuelos'), 'utf8'));
  llegadas.forEach((id) => {
    const a = aux[id], prog = dlDe(id);
    const cand = a.vuelo ? vs.filter((v) => String(v.flight_code).toUpperCase() === a.vuelo && v.actual_at && Math.abs(minDe(v.actual_at) - prog) < 360) : [];
    cand.sort((x, y) => Math.abs(minDe(x.actual_at) - prog) - Math.abs(minDe(y.actual_at) - prog));
    const v = cand[0];
    if (!v) { real[id] = prog + desemb(id); etas[id] = []; return; }          // sin dato: se cumple lo programado
    real[id] = minDe(v.actual_at) + desemb(id);
    etas[id] = (v.eta_log || []).map((e) => ({ at: minDe(e.at), eta: minDe(e.eta) })).sort((x, y) => x.at - y.at);
    etas[id].push({ at: minDe(v.actual_at), eta: minDe(v.actual_at) });
  });
} else {
  // Días sin vuelos guardados: se les pone un desvío sacado de los vuelos reales
  // (--desvios), con semilla para que sea repetible. FlightRadar «sabe» la hora
  // desde 60 min antes (en los datos reales la traía 60–90 min antes, ±1 min).
  const vs = arg('desvios') ? JSON.parse(readFileSync(arg('desvios'), 'utf8')) : [];
  const pool = vs.filter((v) => v.actual_at && v.sched_at).map((v) => Math.round((Date.parse(v.actual_at) - Date.parse(v.sched_at)) / 60000)).filter((d) => Math.abs(d) < 180);
  let seed = Number(arg('semilla', 1)) || 1;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const porVuelo = {};
  llegadas.slice().sort().forEach((id) => {
    const a = aux[id], prog = dlDe(id);
    if (!a.vuelo || !pool.length) { real[id] = prog + desemb(id); etas[id] = []; return; }
    const k = a.vuelo + '|' + a.dl;
    if (porVuelo[k] == null) porVuelo[k] = pool[Math.floor(rnd() * pool.length)];
    const at = prog + porVuelo[k];
    real[id] = at + desemb(id);
    etas[id] = [{ at: at - 60, eta: at }];
  });
}
const sabia = (id, t) => {
  let e = dlDe(id);
  for (const x of etas[id] || []) { if (x.at <= t) e = x.eta; else break; }
  return e + desemb(id);
};

// ── A) RUTA FIJA ────────────────────────────────────────────────────────────
function planFijo() {
  rt.cars = nuevosCarros();
  const r = S.rtSolveDay({ apoyo: false });
  rt.lanes = r.lanes; rt.order = r.order;
  const esperas = [], tardes = [];
  let viajesLle = 0, paxLle = 0;
  rt.cars.forEach((car) => {
    const cc = r.lanes.filter((l) => l.car === car.id).sort((a, b) => M(a.start) - M(b.start));
    let libre = 0, pos = null;
    cc.forEach((l) => {
      const c = S.rtCarCompute(l.id), ord = r.order[l.id];
      if (l.type === 'sal') {
        const ini = Math.max(M(l.start), libre), llega = ini + (c.arrival - M(l.start));
        ord.forEach((id) => { if (llega > dlDe(id) - 5) tardes.push({ id, min: Math.round(llega - dlDe(id)) }); });
        libre = llega + rt.TURNAROUND; pos = 'airport';
      } else {
        const listo = libre + (pos && pos !== 'airport' ? leg(pos, 'airport', libre) : 0);
        // El conductor está en JMC desde que puede; arranca cuando salió el último.
        const sale = Math.max(listo, Math.max(...ord.map((id) => real[id])));
        ord.forEach((id) => esperas.push({ id, min: Math.round(sale - real[id]), carro: car.id }));
        viajesLle++; paxLle += ord.length;
        const dur = c.arrival - Math.max(M(l.start), c.hardDL);
        libre = sale + dur + 2; pos = ord[ord.length - 1];
      }
    });
  });
  const sinCarro = r.unassigned.slice();
  return { esperas, tardes, sinCarro, viajesLle, paxLle, vueltasSal: r.lanes.filter((l) => l.type === 'sal').length };
}

// ── B) STANDBY ──────────────────────────────────────────────────────────────
function planStandby(cfg) {
  // La noche anterior se arma el día COMPLETO (así las salidas quedan repartidas
  // dejando sitio para las llegadas que se esperan), pero solo las salidas quedan
  // fijas: las llegadas se sueltan y entran en espera. `--solo-salidas` prueba la
  // otra forma (planear sin mirar las llegadas), que deja los carros copados.
  rt.cars = nuevosCarros();
  const r = process.argv.includes('--solo-salidas') ? S.rtSolveDay({ solo: new Set(salidas), apoyo: false }) : S.rtSolveDay({ apoyo: false });
  rt.lanes = r.lanes; rt.order = r.order;
  r.unassigned = r.unassigned.filter((id) => aux[id].type === 'sal');
  // Cada salida fija: primera casa, a qué hora hay que estar ahí, cuánto dura desde ahí.
  const TOL = Math.max(0, rt.AIRPORT_BUFFER - 5);       // una salida puede gastar colchón hasta llegar 5 min antes
  const carros = rt.cars.map((car) => ({
    id: car.id, cupo: rt.CAP, libre: 0, pos: null, ocupadoHasta: 0,
    cola: r.lanes.filter((l) => l.car === car.id && l.type === 'sal').sort((a, b) => M(a.start) - M(b.start)).map((l) => {
      const c = S.rtCarCompute(l.id);
      return { id: l.id, ord: r.order[l.id], primera: r.order[l.id][0], etaPrimera: c.stops[0].eta, llega: c.arrival, ini: M(l.start), origin: l.origin, holgura: Math.max(0, c.holg) + TOL };
    }),
  }));
  if (process.argv.includes('--apoyo')) carros.push({ id: 'Apoyo', cupo: rt.CAP, libre: 0, pos: null, cola: [], apoyo: true });
  const esperas = [], tardes = [], avisos = [], viajes = [];
  const pend = new Set(llegadas);
  const tMax = Math.max(1560, ...llegadas.map((id) => real[id] + 180));
  for (let t = 0; t <= tMax; t++) {
    // 1) salidas fijas: arrancan a su hora (o cuando el carro quede libre)
    carros.forEach((c) => {
      const s = c.cola[0];
      if (!s || c.libre > t) return;
      const ida = c.pos && c.pos !== 'airport' ? leg(c.pos, s.primera, t) : (s.origin === 'airport' ? leg('airport', s.primera, t) : 0);
      const debeSalir = s.etaPrimera - ida;
      if (t < debeSalir) return;
      const enPrimera = t + ida, llega = enPrimera + (s.llega - s.etaPrimera);
      s.ord.forEach((id) => { if (llega > dlDe(id) - 5) tardes.push({ id, min: Math.round(llega - dlDe(id)) }); });
      c.cola.shift(); c.libre = llega + rt.TURNAROUND; c.pos = 'airport';
    });
    // 2) despacho de llegadas con lo que se sabe en este minuto
    if (!pend.size) continue;
    const estado = {
      ahora: t, cfg,
      leg: (a, b) => leg(a, b, t),
      carros: carros.map((c) => {
        const s = c.cola[0];
        const listoEn = c.pos === 'airport' || !c.pos ? c.libre : Math.max(c.libre, 0) + leg(c.pos, 'airport', Math.max(c.libre, t));
        return { id: c.id, cupo: c.cupo, apoyo: !!c.apoyo, listoEn, salida: s ? { primera: s.primera, etaPrimera: s.etaPrimera, holgura: s.holgura } : null };
      }),
      llegadas: [...pend].map((id) => ({ id, sale: sabia(id, t), pax: 1, puerta: S.rtStopKey(id) })),
    };
    const d = Despacho.decidir(estado);
    d.avisos.forEach((a) => { if (!avisos.some((x) => x.id === a.id && x.tipo === a.tipo)) avisos.push({ ...a, at: t }); });
    d.asignar.forEach((a) => {
      const c = carros.find((x) => x.id === a.carro);
      const enJMC = c.pos === 'airport' || !c.pos ? Math.max(c.libre, t) : Math.max(c.libre, t) + leg(c.pos, 'airport', t);
      const sale = Math.max(enJMC, Math.max(...a.ids.map((id) => real[id])));     // con la hora REAL, no la estimada
      const plan = Despacho.ruta(a.ids.map((id) => ({ id, puerta: S.rtStopKey(id) })), (x, y) => leg(x, y, sale), rt.SERVICE_MIN);
      a.ids.forEach((id) => { esperas.push({ id, min: Math.round(sale - real[id]), carro: c.id, decididoAntes: Math.round(real[id] - t) }); pend.delete(id); });
      viajes.push({ carro: c.id, sale, fin: sale + plan.dur, ids: a.ids });
      c.libre = sale + plan.dur; c.pos = plan.ultima;
    });
  }
  return { esperas, tardes, sinCarro: r.unassigned.slice().concat([...pend]), avisos, viajesLle: viajes.length, paxLle: viajes.reduce((s, v) => s + v.ids.length, 0), vueltasSal: r.lanes.filter((l) => l.type === 'sal').length, viajes };
}

// ── Resultado ───────────────────────────────────────────────────────────────
const resumen = (x) => {
  const e = x.esperas.map((y) => y.min).sort((a, b) => a - b);
  const prom = e.length ? Math.round(e.reduce((s, y) => s + y, 0) / e.length) : 0;
  return {
    llegadas: e.length, esperaProm: prom, esperaMediana: e.length ? e[Math.floor(e.length / 2)] : 0, esperaMax: e.length ? e[e.length - 1] : 0,
    mas15: e.filter((y) => y > 15).length, mas30: e.filter((y) => y > 30).length,
    sinCarro: x.sinCarro.length, sinCarroLle: x.sinCarro.filter((id) => aux[id].type === 'lle').length,
    bien: e.filter((y) => y <= 15).length, total: llegadas.length,
    salidasTarde: x.tardes.length, viajesLle: x.viajesLle, paxPorViaje: x.viajesLle ? +(x.paxLle / x.viajesLle).toFixed(2) : 0,
  };
};
const cfg = JSON.parse(arg('cfg', '{}'));
const A = planFijo(), B = planStandby(cfg);
const ra = resumen(A), rb = resumen(B);
const desv = llegadas.filter((id) => (etas[id] || []).length).map((id) => real[id] - desemb(id) - dlDe(id));
console.log(`\n${DIA} · ${ids.length} traslados (${salidas.length} salidas, ${llegadas.length} llegadas) · ${nCarros} carros · vuelos con hora real: ${desv.length} (adelantados ≥10: ${desv.filter((d) => d <= -10).length}, atrasados ≥10: ${desv.filter((d) => d >= 10).length})`);
const fila = (n, r) => console.log(`  ${n.padEnd(11)} espera prom ${String(r.esperaProm).padStart(2)} · mediana ${String(r.esperaMediana).padStart(2)} · máx ${String(r.esperaMax).padStart(3)} · >15 min: ${String(r.mas15).padStart(2)} · >30: ${String(r.mas30).padStart(2)} · BIEN (≤15′) ${r.bien}/${r.total} · sin carro ${r.sinCarro} (llegadas ${r.sinCarroLle}) · salidas tarde ${r.salidasTarde} · viajes de llegada ${r.viajesLle} (${r.paxPorViaje} pers.)`);
fila('RUTA FIJA', ra); fila('STANDBY', rb);
const ap = (B.viajes || []).filter((v) => v.carro === 'Apoyo');
if (ap.length) console.log(`  APOYO: ${ap.length} viajes · ${ap.map((v) => HM(v.sale) + '–' + HM(v.fin) + ' (' + v.ids.length + ')').join(' · ')}`);
if (B.avisos.length && !process.argv.includes('--apoyo')) console.log(`  avisos de apoyo en StandBy: ${B.avisos.map((a) => `${HM(a.sale)} ${aux[a.id].n.split(' ')[0]} (${a.tipo === 'sin_carro' ? 'sin carro' : 'espera ' + Math.round(a.espera) + '′'})`).join(' · ')}`);
if (DETALLE) {
  const ea = Object.fromEntries(A.esperas.map((e) => [e.id, e])), eb = Object.fromEntries(B.esperas.map((e) => [e.id, e]));
  llegadas.slice().sort((x, y) => real[x] - real[y]).forEach((id) => console.log(`    ${HM(dlDe(id))} prog → afuera ${HM(real[id])}  ${aux[id].n.slice(0, 26).padEnd(26)} fija ${ea[id] ? String(ea[id].min).padStart(3) + '′ ' + ea[id].carro : ' sin carro'}  ·  standby ${eb[id] ? String(eb[id].min).padStart(3) + '′ ' + eb[id].carro : ' sin carro'}`));
}
if (arg('json')) writeFileSync(arg('json'), JSON.stringify({ dia: DIA, fija: ra, standby: rb, avisos: B.avisos.map((a) => ({ ...a, n: aux[a.id].n })) }));
