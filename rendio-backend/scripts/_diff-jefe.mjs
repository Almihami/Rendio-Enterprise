// Compara MI plan contra la corrección del jefe, vuelta por vuelta.
import { readFileSync } from 'node:fs';
const HORA=/^(\d{1,2})[:.;](\d{2})\s*(.*)$/, DEAD=/^(?:deben?\s+)?est[aá][rse]\s*(\d{1,2})[:.;](\d{2})/i;
const VUELO=/^(av|ja|jec|p5?|j6|je)\s*\d{2,5}$/i;
const min=(h,m)=>h*60+m, hm=(t)=>`${String(Math.floor(t/60)%24).padStart(2,'0')}:${String(t%60).padStart(2,'0')}`;
function parse(txt) {
  const bl=[]; let cur={p:[]};
  for (const raw of txt.split('\n')) {
    const l=raw.trim();
    if (!l || /^Programación|^\(\d+ marcados/.test(l)) { if(cur.p.length) bl.push(cur); cur={p:[]}; continue; }
    const d=l.match(DEAD); if(d){ cur.dl=min(+d[1],+d[2]); continue; }
    const h=l.match(HORA); if(!h) continue;
    const par=h[3].match(/\(([^)]*)\)/); const lugar=par?par[1].trim():'';
    const sinCarro=/QUIZ/i.test(h[3]);
    cur.p.push({t:min(+h[1],+h[2]),lugar,sinCarro,vuelo:VUELO.test(lugar.replace(/\s/g,''))});
  }
  if(cur.p.length) bl.push(cur);
  return bl.filter(b=>b.p.length);
}
const A = parse(readFileSync(process.argv[2] || '/tmp/mio.txt','utf8'));
const B = parse(readFileSync(new URL('./planes-jefe/' + (process.argv[3] || 'plan-2026-08-18-correccion-jefe.txt'), import.meta.url).pathname,'utf8'));
const sal = (bl) => bl.filter(b => b.dl != null && !b.p.some(p=>p.vuelo));
console.log('EL TRAMO FINAL: de la última recogida al "deben estar"\n');
console.log(`${'vuelta (1a parada)'.padEnd(30)} ${'mío'.padStart(5)} ${'jefe'.padStart(6)}`);
console.log('─'.repeat(46));
const fr=(t)=>{const h=Math.floor(t/60)%24;return h<2?'0-2':h<6?'2-6':h<9?'6-9':h<12?'9-12':h<19?'12-19':'19-24';};
const porFranja={};
for (const b of sal(B)) {
  const ini=Math.min(...b.p.map(p=>p.t)), ult=Math.max(...b.p.map(p=>p.t));
  const tramoB=b.dl-ult;
  const a=sal(A).find(x => Math.abs(Math.min(...x.p.map(p=>p.t))-ini)<=20);
  const tramoA=a?a.dl-Math.max(...a.p.map(p=>p.t)):null;
  (porFranja[fr(b.dl)] ||= []).push([tramoA,tramoB]);
  console.log(`${(hm(ini)+' '+b.p.find(p=>p.t===ini).lugar).slice(0,29).padEnd(30)} ${String(tramoA??'—').padStart(5)} ${String(tramoB).padStart(6)}`);
}
console.log('─'.repeat(46));
console.log('\nPROMEDIO POR FRANJA (y lo que dice su tabla route_leg_times):\n');
const TABLA={'0-2':'20','2-6':'15','6-9':'35','9-12':'20-25','12-19':'25-30','19-24':'20'};
for (const [f,ps] of Object.entries(porFranja)) {
  const va=ps.filter(p=>p[0]!=null).map(p=>p[0]), vb=ps.map(p=>p[1]);
  const m=(a)=>a.length?(a.reduce((x,y)=>x+y,0)/a.length).toFixed(0):'—';
  console.log(`  ${f.padEnd(7)} mío ${String(m(va)).padStart(3)} · jefe ${String(m(vb)).padStart(3)} · su tabla ${TABLA[f]}`);
}
