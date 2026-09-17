// ¿De qué depende el tramo final que él usa? Se separa por CUÁNTAS paradas tiene
// la vuelta, sobre sus dos correcciones a planes nuestros.
import { readFileSync } from 'node:fs';
const DEAD=/^(?:deben?\s+)?est[aá][rse]\s*(\d{1,2})[:.;](\d{2})/i, HORA=/^(\d{1,2})[:.;](\d{2})\s*(.*)$/;
const VUELO=/^(av|ja|jec|p5?|j6|je)\s*\d{2,5}$/i, min=(h,m)=>h*60+m;
const filas=[];
for (const f of ['plan-2026-08-18-correccion-jefe.txt','plan-2026-08-19-correccion-jefe.txt']) {
  const bl=[]; let cur={p:[]};
  for (const raw of readFileSync(new URL('./planes-jefe/'+f, import.meta.url).pathname,'utf8').split('\n')) {
    const l=raw.trim();
    if(!l){ if(cur.p.length) bl.push(cur); cur={p:[]}; continue; }
    const d=l.match(DEAD); if(d){ cur.dl=min(+d[1],+d[2]); continue; }
    const h=l.match(HORA); if(!h) continue;
    const par=h[3].match(/\(([^)]*)\)/); const lugar=par?par[1].trim():'';
    cur.p.push({t:min(+h[1],+h[2]),lugar,vuelo:VUELO.test(lugar.replace(/\s/g,''))||/hotel|aero/i.test(lugar)});
  }
  if(cur.p.length) bl.push(cur);
  for (const b of bl) {
    if (b.dl==null || b.p.some(p=>p.vuelo)) continue;
    const ult=Math.max(...b.p.map(p=>p.t)), ini=Math.min(...b.p.map(p=>p.t));
    filas.push({ dia:f.slice(5,15), paradas:b.p.length, tramo:b.dl-ult, total:b.dl-ini });
  }
}
const m=(a)=>a.length?(a.reduce((x,y)=>x+y,0)/a.length).toFixed(0):'—';
console.log(`\nSUS ${filas.length} vueltas de salida en las dos correcciones\n`);
console.log('paradas   n   tramo final (última→aeropuerto)   total (primera→aeropuerto)');
console.log('─'.repeat(74));
for (const k of [1,2,3,4]) {
  const g=filas.filter(f=>f.paradas===k);
  if(!g.length) continue;
  console.log(`   ${k}    ${String(g.length).padStart(2)}          ${String(m(g.map(f=>f.tramo))).padStart(3)} min                    ${String(m(g.map(f=>f.total))).padStart(3)} min`);
}
const uno=filas.filter(f=>f.paradas===1), varias=filas.filter(f=>f.paradas>1);
console.log('─'.repeat(74));
console.log(`\n  UNA sola parada  (${uno.length} vueltas): tramo ${m(uno.map(f=>f.tramo))} min · valores ${uno.map(f=>f.tramo).sort((a,b)=>a-b).join(', ')}`);
console.log(`  VARIAS paradas   (${varias.length} vueltas): tramo ${m(varias.map(f=>f.tramo))} min · valores ${varias.map(f=>f.tramo).sort((a,b)=>a-b).join(', ')}`);
