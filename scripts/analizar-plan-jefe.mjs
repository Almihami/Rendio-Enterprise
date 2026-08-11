// SOLO LECTURA — aprende del plan manual del jefe.
//
// Compara, vuelta por vuelta, lo que el jefe hace a mano contra lo que dicen
// las coordenadas reales (catálogo 0055) y OSRM (carretera real, sin tráfico):
//   · tramo final: última recogida → "debe estar" vs OSRM(última parada → MDE)
//   · paso entre paradas: lo que él deja vs OSRM(parada → parada)
// Y lista los conjuntos que menciona y NO están en el catálogo.
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const MDE = { lat: 6.1715, lon: -75.4270 };
// Los planes crudos, tal como los escribe el jefe en WhatsApp. Son la fuente de
// verdad contra la que se calibra: no reformatearlos.
const DIR = new URL('./planes-jefe/', import.meta.url).pathname;

// ── catálogo ────────────────────────────────────────────────────────────────
const { data: resid, error } = await sb.from('residences').select('*');
if (error) { console.log('ERROR residences:', error.message); process.exit(1); }
const K = Object.keys(resid[0]);
const nameK = K.find((c) => /^name$|nombre/.test(c)) || K.find((c) => /name/.test(c));
const latK = K.find((c) => /lat/.test(c));
const lonK = K.find((c) => /lon|lng/.test(c));
console.log('catálogo residences:', resid.length, 'conjuntos · columnas:', K.join(','));

const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const CAT = resid.map((r) => ({ nombre: r[nameK], n: norm(r[nameK]), lat: r[latK], lon: r[lonK] }));

function buscar(txt) {
  const t = norm(txt);
  if (!t) return null;
  let m = CAT.find((c) => c.n === t);
  if (m) return m;
  m = CAT.find((c) => c.n.includes(t) || t.includes(c.n));
  if (m) return m;
  const pal = t.split(' ').filter((p) => p.length > 3);
  m = CAT.find((c) => pal.some((p) => c.n.includes(p)));
  return m || null;
}

// ── parser de los planes ────────────────────────────────────────────────────
const HORA = /^(\d{1,2})[:.](\d{2})\s*(.*)$/;
const DEADLINE = /^(?:deben?\s+estar|estar)\s*(\d{1,2})[:.](\d{2})/i;
const min = (h, m) => h * 60 + m;
const hm = (t) => `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;

function parsePlan(txt) {
  const vueltas = [];
  let cur = { paradas: [], notas: [] };
  for (const raw of txt.split('\n')) {
    const l = raw.trim();
    if (!l) { if (cur.paradas.length || cur.notas.length) { vueltas.push(cur); cur = { paradas: [], notas: [] }; } continue; }
    const d = l.match(DEADLINE);
    if (d) { cur.deadline = min(+d[1], +d[2]); cur.hotel = /hotel/i.test(l); continue; }
    const h = l.match(HORA);
    if (h) {
      const resto = h[3];
      const par = resto.match(/\(([^)]*)\)/);
      const lugar = par ? par[1].trim() : '';
      const quien = resto.replace(/\([^)]*\)/, '').trim();
      const vuelo = /^(av|ja|jec|p5|p)\s*\d/i.test(lugar) ? lugar : null;
      cur.paradas.push({ t: min(+h[1], +h[2]), quien, lugar, vuelo, personas: (quien.match(/\sy\s|,/g) || []).length + 1 });
    } else cur.notas.push(l);
  }
  if (cur.paradas.length || cur.notas.length) vueltas.push(cur);
  return vueltas;
}

// ── OSRM ────────────────────────────────────────────────────────────────────
async function osrmMin(a, b) {
  const url = `https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false`;
  try {
    const j = await (await fetch(url)).json();
    if (j.code !== 'Ok') return null;
    return j.routes[0].duration / 60;
  } catch { return null; }
}

// ── análisis ────────────────────────────────────────────────────────────────
const faltantes = new Map();
for (const [etiqueta, archivo] of [['SALIDAS 14 VUELTAS', 'plan-salidas-14vueltas.txt'], ['DOMINGO', 'plan-domingo.txt']]) {
  const vueltas = parsePlan(readFileSync(`${DIR}/${archivo}`, 'utf8'));
  console.log(`\n\n══════════ ${etiqueta} — ${vueltas.length} bloques ══════════`);
  let salidas = 0, llegadas = 0, hotel = 0, personas = 0;

  for (const v of vueltas) {
    for (const p of v.paradas) personas += p.personas;
    const esLlegada = v.paradas.some((p) => p.vuelo);
    if (esLlegada) { llegadas += v.paradas.length; }
    if (/hotel/i.test(v.notas.join(' ')) || v.hotel || v.paradas.some((p) => /hotel/i.test(p.lugar))) hotel++;

    if (v.deadline == null) {
      const et = esLlegada ? 'LLEGADA (por vuelo)' : v.paradas.some((p) => /hotel|aero/i.test(p.lugar)) ? 'HOTEL/AERO' : 'SIN DEADLINE';
      console.log(`\n  [${et}] ${v.paradas.map((p) => `${hm(p.t)} ${p.quien} (${p.lugar})`).join(' · ')}${v.notas.length ? ' — ' + v.notas.join(' ') : ''}`);
      continue;
    }
    salidas += v.paradas.length;

    const ult = v.paradas[v.paradas.length - 1];
    const tramoJefe = v.deadline - ult.t;
    const casa = buscar(ult.lugar);
    if (!casa) faltantes.set(ult.lugar, (faltantes.get(ult.lugar) || 0) + 1);
    const osrmFinal = casa && casa.lat ? await osrmMin(casa, MDE) : null;

    const pax = v.paradas.reduce((s, p) => s + p.personas, 0);
    console.log(`\n  ▸ deben estar ${hm(v.deadline)} · ${v.paradas.length} paradas · ${pax} pax`);
    for (let i = 0; i < v.paradas.length; i++) {
      const p = v.paradas[i];
      const c = buscar(p.lugar);
      if (!c) faltantes.set(p.lugar, (faltantes.get(p.lugar) || 0) + 1);
      let extra = '';
      if (i > 0) {
        const ant = buscar(v.paradas[i - 1].lugar);
        const paso = p.t - v.paradas[i - 1].t;
        const real = ant && c && ant.lat && c.lat ? await osrmMin(ant, c) : null;
        extra = ` | paso jefe ${paso}m vs OSRM ${real == null ? '?' : real.toFixed(1) + 'm'}`;
      }
      console.log(`      ${hm(p.t)} ${p.quien.padEnd(24)} ${(p.lugar || '').padEnd(22)} ${c ? '✓ ' + c.nombre.slice(0, 22) : '✗ NO EN CATÁLOGO'}${extra}`);
    }
    console.log(`      → tramo final (${ult.lugar} → MDE): jefe ${tramoJefe} min | OSRM ${osrmFinal == null ? '?' : osrmFinal.toFixed(1) + ' min'} | holgura ${osrmFinal == null ? '?' : (tramoJefe - osrmFinal).toFixed(1) + ' min'}`);
  }
  console.log(`\n  RESUMEN ${etiqueta}: ${personas} personas · ${salidas} paradas de salida · ${llegadas} paradas de llegada · ${hotel} bloques con hotel`);
}

console.log('\n\n══════════ LUGARES QUE NO ESTÁN EN EL CATÁLOGO ══════════');
for (const [l, n] of [...faltantes.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${l} (×${n})`);

console.log('\n══════════ CATÁLOGO ACTUAL ══════════');
console.log(CAT.map((c) => c.nombre).sort().join(' · '));

const { data: st } = await sb.from('app_settings').select('*').eq('id', 'singleton').maybeSingle();
if (st) {
  console.log('\n══════════ PARÁMETROS ACTUALES DEL SOLVER (dev) ══════════');
  for (const [k, v] of Object.entries(st)) if (/^route_/.test(k)) console.log(`  ${k} = ${v}`);
}
