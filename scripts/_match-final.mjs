// Comparación justa: mi plan vs el suyo, separando vueltas de UNA parada de las
// de varias, que es la distinción que resultó importar.
import { readFileSync } from 'node:fs';
const DEAD=/^(?:deben?\s+)?est[aá][rse]\s*(\d{1,2})[:.;](\d{2})/i, HORA=/^(\d{1,2})[:.;](\d{2})\s*(.*)$/;
const VUELO=/^(av|ja|jec|p5?|j6|je)\s*\d{2,5}$/i, min=(h,m)=>h*60+m;
function sal(txt) {
  const bl=[]; let cur={p:[]};
  for (const raw of txt.split('\n')) {
    const l=raw.trim();
    if (!l || /^Programación|^\(\d+ marcados|^VUELO /.test(l)) { if(cur.p.length) bl.push(cur); cur={p:[]}; continue; }
    const d=l.match(DEAD); if(d){ cur.dl=min(+d[1],+d[2]); continue; }
    const h=l.match(HORA); if(!h) continue;
    const par=h[3].match(/\(([^)]*)\)/); const lugar=par?par[1].trim():'';
    if (/QUIZ/i.test(h[3])) continue;
    cur.p.push({t:min(+h[1],+h[2]),lugar,vuelo:VUELO.test(lugar.replace(/\s/g,''))||/hotel|aero/i.test(lugar)});
  }
  if(cur.p.length) bl.push(cur);
  return bl.filter(b=>b.dl!=null && b.p.length && !b.p.some(p=>p.vuelo))
           .map(b=>({ ini:Math.min(...b.p.map(p=>p.t)), n:b.p.length, tramo:b.dl-Math.max(...b.p.map(p=>p.t)) }));
}
const m=(a)=>a.length?(a.reduce((x,y)=>x+y,0)/a.length).toFixed(0):'—';
for (const [mio, suyo, dia] of [['/tmp/mio18b.txt','plan-2026-08-18-correccion-jefe.txt','18-ago'],
                                 ['/tmp/mio19b.txt','plan-2026-08-19-correccion-jefe.txt','19-ago']]) {
  const A = sal(readFileSync(mio,'utf8'));
  const B = sal(readFileSync(new URL('./planes-jefe/'+suyo, import.meta.url).pathname,'utf8'));
  console.log(`\n${dia}   ${'caso'.padEnd(16)} ${'mío'.padStart(5)} ${'jefe'.padStart(6)}   dif`);
  console.log('─'.repeat(48));
  for (const [et, f] of [['una parada', (x)=>x.n===1], ['varias paradas', (x)=>x.n>1]]) {
    const a=A.filter(f).map(x=>x.tramo), b=B.filter(f).map(x=>x.tramo);
    const d=(m(a)-m(b));
    console.log(`        ${et.padEnd(16)} ${String(m(a)).padStart(5)} ${String(m(b)).padStart(6)}   ${d>0?'+':''}${d} min`);
  }
}
