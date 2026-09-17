// ¿El colchón de 0071 acerca el sistema a lo que Julián realmente programa?
// Replica rtDurProg sobre sus vueltas reales, con y sin el descuento.
import { createClient } from '@supabase/supabase-js';
import { readFileSync, readdirSync } from 'node:fs';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data: resid } = await sb.from('residences').select('name, zona_jefe');
const { data: zt } = await sb.from('route_zone_times').select('*');
const { data: lt } = await sb.from('route_leg_times').select('*');
const { data: st } = await sb.from('app_settings').select('route_zone_cushion_min').limit(1);
const COLCHON = Number(st[0].route_zone_cushion_min);
const DIR = new URL('./planes-jefe/', import.meta.url).pathname;
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
const zonaDe = (l) => { const t = norm(l);
  const m = resid.find(r => norm(r.name) === t) || resid.find(r => norm(r.name).includes(t) || t.includes(norm(r.name)))
         || resid.find(r => t.split(' ').filter(p=>p.length>3).some(p => norm(r.name).includes(p)));
  return m?.zona_jefe; };
const banda = (t) => { const h = Math.floor(t/60)%24; return h<2?0:h<6?2:h<9?6:h<12?9:h<19?12:19; };
const porGente = (r, n) => !r ? 0 : n <= 1 ? r.min_minutes : n >= 3 ? r.max_minutes : Math.round((r.min_minutes+r.max_minutes)/2);
const HORA=/^(\d{1,2})[:.](\d{2})\s*(.*)$/, DEAD=/^(?:deben?\s+)?est[aá][rse]\s*(\d{1,2})[:.;](\d{2})/i;
const VUELO=/^(av|ja|jec|p5?|j6|je)\s*\d{2,5}$/i, min=(h,m)=>h*60+m;
const pax=(q)=>q.split(/\s*,\s*|\s+y\s+/i).filter(s=>s.trim()).length;
const errAntes=[], errDesp=[];
for (const f of readdirSync(DIR).filter(f=>f.startsWith('plan-')&&f.endsWith('.txt'))) {
  const bl=[]; let cur={p:[]};
  for (const raw of readFileSync(`${DIR}/${f}`,'utf8').split('\n')) {
    const l=raw.trim();
    if(!l){ if(cur.p.length) bl.push(cur); cur={p:[]}; continue; }
    const d=l.match(DEAD); if(d){ cur.dl=min(+d[1],+d[2]); continue; }
    const h=l.match(HORA); if(!h) continue;
    const par=h[3].match(/\(([^)]*)\)/); const lugar=par?par[1].trim():'';
    cur.p.push({t:min(+h[1],+h[2]),lugar,n:pax(h[3].replace(/\([^)]*\)/,'')),vuelo:VUELO.test(lugar.replace(/\s/g,''))});
  }
  if(cur.p.length) bl.push(cur);
  for (const b of bl) {
    if (b.dl==null || b.p.some(p=>p.vuelo)) continue;
    const zs = b.p.map(p=>zonaDe(p.lugar));
    if (zs.some(z=>!z)) continue;                     // igual que el solver: sin zona no aplica
    const n = b.p.reduce((a,p)=>a+p.n,0);
    const zmin = Math.max(...zs.map(z => porGente(zt.find(x=>x.zone===z&&x.band_from===banda(b.dl)), n)));
    const real = b.dl - Math.min(...b.p.map(p=>p.t));
    errAntes.push(zmin - real);
    errDesp.push(Math.max(0, zmin - COLCHON) - real);
  }
}
const m=(a)=>a.reduce((x,y)=>x+y,0)/a.length, am=(a)=>m(a.map(Math.abs));
console.log(`\n${errAntes.length} vueltas suyas con todas las zonas conocidas · colchón = ${COLCHON} min\n`);
console.log(`  ANTES (tabla completa)   se pasaba ${m(errAntes)>0?'+':''}${m(errAntes).toFixed(1)} min · error absoluto ${am(errAntes).toFixed(1)}`);
console.log(`  AHORA (menos colchón)    se pasa   ${m(errDesp)>0?'+':''}${m(errDesp).toFixed(1)} min · error absoluto ${am(errDesp).toFixed(1)}`);
console.log(`\n  vueltas que se pasaban por 15+ min: ${errAntes.filter(d=>d>=15).length} → ahora ${errDesp.filter(d=>d>=15).length}`);
