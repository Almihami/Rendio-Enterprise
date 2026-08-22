// SOLO LECTURA. Aprende de un plan del jefe: (1) empareja ida/vuelta de cada
// persona, (2) estima cuántos carros simultáneos exige el plan.
import { readFileSync } from 'node:fs';
const DIR = new URL('./planes-jefe/', import.meta.url).pathname;
const txt = readFileSync(`${DIR}/${process.argv[2]}`, 'utf8');

const HORA = /^(\d{1,2})[:.](\d{2})\s*(.*)$/;
const DEADLINE = /^(?:deben?\s+)?est[aá][rse]\s*(\d{1,2})[:.;](\d{2})/i;
const VUELO = /^(av|ja|jec|p5?|j6)\s*\d{2,5}$/i;
const min = (h, m) => h * 60 + m;
const hm = (t) => `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();

// personas: "Leon y margy" -> 2 ; "Melisa, Wilson y YERLY" -> 3
const personas = (q) => q.split(/\s*,\s*|\s+y\s+/i).map((s) => s.trim()).filter(Boolean);

const bloques = [];
let cur = { paradas: [], txt: [] };
for (const raw of txt.split('\n')) {
  const l = raw.trim();
  if (!l) { if (cur.paradas.length) bloques.push(cur); cur = { paradas: [], txt: [] }; continue; }
  cur.txt.push(l);
  const d = l.match(DEADLINE);
  if (d) { cur.deadline = min(+d[1], +d[2]); cur.hotel = /hotel/i.test(l); continue; }
  if (/^va[n]?\s+a\s+hotel/i.test(l)) { cur.soloHotel = true; continue; }
  const h = l.match(HORA);
  if (h) {
    const par = h[3].match(/\(([^)]*)\)/);
    const lugar = par ? par[1].trim() : '';
    const quien = h[3].replace(/\([^)]*\)/, '').trim();
    cur.paradas.push({ t: min(+h[1], +h[2]), quien, lugar, esVuelo: VUELO.test(lugar.replace(/\s/g, '')) });
  }
}
if (cur.paradas.length) bloques.push(cur);

// ── 1. ida y vuelta por persona ─────────────────────────────────────────────
const gente = new Map();
for (const b of bloques) for (const p of b.paradas) {
  const tipo = p.esVuelo ? 'llegada' : /^hotel$/i.test(p.lugar) ? 'delHotel' : 'salida';
  for (const q of personas(p.quien)) {
    const k = norm(q);
    if (!k) continue;
    if (!gente.has(k)) gente.set(k, { nombre: q, salidas: [], llegadas: [], delHotel: [] });
    const g = gente.get(k);
    (tipo === 'llegada' ? g.llegadas : tipo === 'delHotel' ? g.delHotel : g.salidas)
      .push({ t: p.t, lugar: p.lugar, hotel: b.hotel || b.soloHotel });
  }
}
console.log(`\n═══ IDA Y VUELTA · ${gente.size} personas distintas ═══\n`);
const soloSale = [], soloLlega = [], ambos = [];
for (const g of gente.values()) {
  if (g.salidas.length && g.llegadas.length) ambos.push(g);
  else if (g.salidas.length) soloSale.push(g);
  else if (g.llegadas.length) soloLlega.push(g);
}
console.log(`va y vuelve el mismo día: ${ambos.length}`);
for (const g of ambos) console.log(`   ${g.nombre.padEnd(26)} sale ${g.salidas.map((s)=>hm(s.t)+' ('+s.lugar+')').join(' ')}  →  vuelve ${g.llegadas.map((l)=>hm(l.t)+' '+l.lugar).join(' ')}`);
console.log(`\nSALE y no vuelve: ${soloSale.length}`);
for (const g of soloSale) console.log(`   ${g.nombre.padEnd(26)} ${g.salidas.map((s)=>hm(s.t)+' ('+s.lugar+')'+(s.hotel?' [hotel]':'')).join(' ')}`);
console.log(`\nVUELVE sin haber salido: ${soloLlega.length}`);
for (const g of soloLlega) console.log(`   ${g.nombre.padEnd(26)} ${g.llegadas.map((l)=>hm(l.t)+' '+l.lugar).join(' ')}`);

// ── 2. carros simultáneos ───────────────────────────────────────────────────
// Salida:  ocupa de la 1a recogida al deadline.
// Llegada: del aterrizaje a +20 desembarque +25 de viaje a casa.
const DESEMB = 20, VIAJE = 25;
const tramos = bloques.map((b) => {
  const ini = Math.min(...b.paradas.map((p) => p.t));
  const esLleg = b.paradas.every((p) => p.esVuelo);
  const fin = esLleg ? Math.max(...b.paradas.map((p) => p.t)) + DESEMB + VIAJE
            : b.deadline != null ? b.deadline : ini + VIAJE;
  return { ini, fin, esLleg, pax: b.paradas.reduce((a, p) => a + personas(p.quien).length, 0), et: b.txt[0] };
}).sort((a, b) => a.ini - b.ini);

console.log(`\n═══ CARROS SIMULTÁNEOS (llegada = vuelo +${DESEMB} desemb. +${VIAJE} viaje) ═══\n`);
let pico = 0, cuando = [];
for (const t of tramos) {
  const solapan = tramos.filter((o) => o.ini < t.fin && o.fin > t.ini);
  if (solapan.length > pico) { pico = solapan.length; cuando = solapan; }
}
console.log(`PICO: ${pico} carros a la vez`);
for (const s of cuando) console.log(`   ${hm(s.ini)}–${hm(s.fin)}  ${s.esLleg ? 'llegada' : 'salida '} ${s.pax}pax  · ${s.et}`);
const conc = tramos.map((t) => tramos.filter((o) => o.ini < t.fin && o.fin > t.ini).length);
console.log(`\nbloques totales: ${tramos.length} · solapamiento: ${Math.min(...conc)}–${pico} · media ${(conc.reduce((a,b)=>a+b,0)/conc.length).toFixed(1)}`);
const conflictos = tramos.filter((t) => tramos.filter((o) => o.ini < t.fin && o.fin > t.ini).length > 2);
console.log(`bloques que NO caben en 2 carros: ${conflictos.length}`);
