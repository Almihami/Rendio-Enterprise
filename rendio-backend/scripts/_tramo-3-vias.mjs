// El tramo final (última recogida → aeropuerto) medido de tres formas:
//   lo que él PONE en el plan · lo que dice su TABLA · lo que da OSRM×factor.
// Es el test más limpio: un solo trayecto, sin ambigüedad de multi-parada.
import { createClient } from '@supabase/supabase-js';
import { readFileSync, readdirSync } from 'node:fs';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data: resid } = await sb.from('residences').select('name, latitude, longitude');
const { data: leg }   = await sb.from('route_leg_times').select('*');
const { data: st }    = await sb.from('app_settings').select('route_airport_factor').limit(1);
const FACTOR = Number(st[0].route_airport_factor) || 1;
const MDE = { lat: 6.1715, lon: -75.4270 };
const DIR = new URL('./planes-jefe/', import.meta.url).pathname;
const cache = JSON.parse(readFileSync(`${DIR}/.osrm-cache.json`, 'utf8').trim() || '{}');

const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
const buscar = (t0) => { const t = norm(t0);
  return resid.find(r => norm(r.name) === t) || resid.find(r => norm(r.name).includes(t) || t.includes(norm(r.name)))
      || resid.find(r => t.split(' ').filter(p=>p.length>3).some(p => norm(r.name).includes(p))); };
async function osrm(a) {
  const k = `${a.latitude},${a.longitude}`;
  if (cache[k] != null) return cache[k];
  const u = `https://router.project-osrm.org/route/v1/driving/${a.longitude},${a.latitude};${MDE.lon},${MDE.lat}?overview=false`;
  try { const r = await (await fetch(u)).json(); const m = r.routes?.[0]?.duration / 60;
        if (m) { cache[k] = m; await new Promise(s => setTimeout(s, 1100)); return m; } } catch {}
  return null;
}
const banda = (t) => { const h = Math.floor(t/60)%24; return h<2?0:h<6?2:h<9?6:h<12?9:h<19?12:19; };
const HORA = /^(\d{1,2})[:.](\d{2})\s*(.*)$/, DEAD = /^(?:deben?\s+)?est[aá][rse]\s*(\d{1,2})[:.;](\d{2})/i;
const VUELO = /^(av|ja|jec|p5?|j6|je)\s*\d{2,5}$/i;
const min = (h,m)=>h*60+m;
const pax = (q) => q.split(/\s*,\s*|\s+y\s+/i).filter(s=>s.trim()).length;

const filas = [];
for (const f of readdirSync(DIR).filter(f => f.startsWith('plan-') && f.endsWith('.txt'))) {
  const bl = []; let cur = { p: [] };
  for (const raw of readFileSync(`${DIR}/${f}`,'utf8').split('\n')) {
    const l = raw.trim();
    if (!l) { if (cur.p.length) bl.push(cur); cur = { p: [] }; continue; }
    const d = l.match(DEAD); if (d) { cur.dl = min(+d[1],+d[2]); continue; }
    const h = l.match(HORA); if (!h) continue;
    const par = h[3].match(/\(([^)]*)\)/); const lugar = par ? par[1].trim() : '';
    cur.p.push({ t: min(+h[1],+h[2]), lugar, n: pax(h[3].replace(/\([^)]*\)/,'')), vuelo: VUELO.test(lugar.replace(/\s/g,'')) });
  }
  if (cur.p.length) bl.push(cur);
  for (const b of bl) {
    if (b.dl == null || b.p.some(p => p.vuelo)) continue;
    const ult = b.p.reduce((a,p) => p.t > a.t ? p : a);
    const r = buscar(ult.lugar); if (!r?.latitude) continue;
    const o = await osrm(r);   if (!o) continue;
    const lt = leg.find(x => x.band_from === banda(b.dl));
    const n = b.p.reduce((a,p)=>a+p.n,0);
    const tabla = !lt ? null : n <= 1 ? lt.min_minutes : n === 2 ? Math.round((lt.min_minutes+lt.max_minutes)/2) : lt.max_minutes;
    filas.push({ plan: f.replace(/^plan-|\.txt$/g,''), lugar: ult.lugar, el: b.dl - ult.t, tabla, osrm: o * FACTOR });
  }
}
console.log(`\nfactor aeropuerto = ${FACTOR}\n`);
console.log(`${'plan'.padEnd(17)} ${'última parada'.padEnd(16)}  él  tabla  OSRM×f   err.tabla  err.OSRM`);
console.log('─'.repeat(80));
let eT = [], eO = [];
for (const f of filas) {
  const dT = f.tabla != null ? f.tabla - f.el : null, dO = f.osrm - f.el;
  if (dT != null) eT.push(dT); eO.push(dO);
  console.log(`${f.plan.padEnd(17)} ${f.lugar.slice(0,16).padEnd(16)} ${String(f.el).padStart(3)} ${String(f.tabla??'?').padStart(6)} ${f.osrm.toFixed(1).padStart(7)}   ${(dT!=null?(dT>0?'+':'')+dT:'  ?').padStart(8)}  ${(dO>0?'+':'')+dO.toFixed(1).padStart(7)}`);
}
const media = (a) => a.reduce((x,y)=>x+y,0)/a.length;
const absmed = (a) => media(a.map(Math.abs));
console.log('─'.repeat(80));
console.log(`\n${filas.length} tramos finales de ${new Set(filas.map(f=>f.plan)).size} planes suyos\n`);
console.log(`  SU TABLA   se desvía  ${media(eT) > 0 ? '+' : ''}${media(eT).toFixed(1)} min en promedio (error absoluto medio ${absmed(eT).toFixed(1)})`);
console.log(`  OSRM×${FACTOR}  se desvía  ${media(eO) > 0 ? '+' : ''}${media(eO).toFixed(1)} min en promedio (error absoluto medio ${absmed(eO).toFixed(1)})`);
console.log(`\n  tramos donde la tabla se pasa por 10+ min: ${eT.filter(d=>d>=10).length} de ${eT.length}`);
console.log(`  tramos donde OSRM×${FACTOR} se pasa por 10+ min: ${eO.filter(d=>d>=10).length} de ${eO.length}`);
