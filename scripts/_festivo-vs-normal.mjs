// ¿Cuánto se aparta un plan de FESTIVO de la tabla de DÍA NORMAL que dictó?
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data: resid } = await sb.from('residences').select('name, zona_jefe');
const { data: tabla } = await sb.from('route_zone_times').select('*');

const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
const zonaDe = (lugar) => {
  const t = norm(lugar);
  const m = resid.find(r => norm(r.name) === t) || resid.find(r => norm(r.name).includes(t) || t.includes(norm(r.name)))
         || resid.find(r => t.split(' ').filter(p=>p.length>3).some(p => norm(r.name).includes(p)));
  return m ? m.zona_jefe : undefined;
};
const banda = (t) => { const h = Math.floor(t/60)%24; return h<2?0:h<6?2:h<9?6:h<12?9:h<19?12:19; };
const esperado = (zona, t, pax) => {
  const r = tabla.find(x => x.zone === zona && x.band_from === banda(t));
  if (!r) return null;
  return pax <= 1 ? r.min_minutes : pax === 2 ? Math.round((r.min_minutes + r.max_minutes)/2) : r.max_minutes;
};

const HORA = /^(\d{1,2})[:.](\d{2})\s*(.*)$/;
const DEADLINE = /^(?:deben?\s+)?est[aá][rse]\s*(\d{1,2})[:.;](\d{2})/i;
const VUELO = /^(av|ja|jec|p5?|j6)\s*\d{2,5}$/i;
const min = (h,m) => h*60+m, hm = (t) => `${String(Math.floor(t/60)%24).padStart(2,'0')}:${String(t%60).padStart(2,'0')}`;
const personas = (q) => q.split(/\s*,\s*|\s+y\s+/i).map(s=>s.trim()).filter(Boolean).length;

const bloques = []; let cur = { p: [] };
for (const raw of readFileSync(new URL(`./planes-jefe/${process.argv[2]}`, import.meta.url).pathname,'utf8').split('\n')) {
  const l = raw.trim();
  if (!l) { if (cur.p.length) bloques.push(cur); cur = { p: [] }; continue; }
  const d = l.match(DEADLINE); if (d) { cur.dl = min(+d[1],+d[2]); continue; }
  const h = l.match(HORA); if (!h) continue;
  const par = h[3].match(/\(([^)]*)\)/); const lugar = par ? par[1].trim() : '';
  cur.p.push({ t: min(+h[1],+h[2]), lugar, pax: personas(h[3].replace(/\([^)]*\)/,'')), vuelo: VUELO.test(lugar.replace(/\s/g,'')) });
}
if (cur.p.length) bloques.push(cur);

console.log(`\n${'vuelta'.padEnd(24)} ${'zona'.padEnd(19)} pax  él  normal  ratio`);
console.log('─'.repeat(74));
const ratios = [];
for (const b of bloques) {
  if (b.dl == null || b.p.some(p => p.vuelo)) continue;
  const ini = Math.min(...b.p.map(p=>p.t)), pax = b.p.reduce((a,p)=>a+p.pax,0);
  const primera = b.p.find(p => p.t === ini);
  const z = zonaDe(primera.lugar);
  const real = b.dl - ini;
  const esp = z ? esperado(z, b.dl, pax) : null;
  const r = esp ? real/esp : null;
  if (r) ratios.push(r);
  console.log(`${(hm(ini)+' '+primera.lugar).padEnd(24)} ${(z||'— sin zona').padEnd(19)} ${String(pax).padStart(2)}  ${String(real).padStart(3)}  ${String(esp??'?').padStart(5)}  ${r?r.toFixed(2):'  —'}`);
}
ratios.sort((a,b)=>a-b);
const med = ratios[Math.floor(ratios.length/2)];
console.log('─'.repeat(74));
console.log(`\n${ratios.length} vueltas medibles · ratio festivo/normal: mín ${ratios[0].toFixed(2)} · mediana ${med.toFixed(2)} · máx ${ratios.at(-1).toFixed(2)} · media ${(ratios.reduce((a,b)=>a+b,0)/ratios.length).toFixed(2)}`);
console.log(`Ninguna vuelta llegó al tiempo de día normal.` );
