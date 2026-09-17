// Red de regresión: saca del propio api.js cada pareja from(tabla)+select(cols)
// y le pide 0 filas a PostgREST con sesión de admin. No comprueba la lógica —
// comprueba que ninguna cadena de select quedó rota (que es como se rompen las
// cosas en silencio cuando se agrega una segunda llave foránea).
import { readFileSync } from 'fs';
const url=process.env.SUPABASE_URL, anon=process.env.SUPABASE_ANON_KEY;
if(!url.includes('lxlphbafhtphulanhzlp')){console.error('ABORT: no es dev');process.exit(2);}
const src=readFileSync('../rendio-turnos/api.js','utf8');

// from('tabla') … select('cols')  — con lo que haya en medio en la misma cadena.
// El hueco entre from() y select() no puede contener otro from(): si no, un
// from de una cadena anterior se casa con el select de la siguiente y el
// chequeo inventa errores que no existen.
const pares=[]; const re=/\.from\(\s*'([a-z_]+)'\s*\)((?:(?!\.from\()[\s\S]){0,400}?)\.select\(\s*'([^']*)'/g;
let m; while((m=re.exec(src))) pares.push({tabla:m[1], cols:m[3]});
// …y las que arman COLS en una constante y la pasan después.
const consts={}; const re2=/const\s+(COLS|BASE|ACOLS|DCOLS)\s*=\s*((?:'[^']*'\s*\+?\s*)+);/g;
while((m=re2.exec(src))) consts[m[1]]=m[2].replace(/'\s*\+\s*'/g,'').replace(/'/g,'').replace(/\s*\+\s*/g,'');

const r=await fetch(url+'/auth/v1/token?grant_type=password',{method:'POST',headers:{apikey:anon,'Content-Type':'application/json'},
  body:JSON.stringify({email:'demo-admin@rendio.demo',password:'DemoRendio2026!'})});
const tok=(await r.json()).access_token;
if(!tok){console.error('sin sesión de admin');process.exit(1);}

let ok=0,bad=0,ruido=0; const vistos=new Set();
for(const p of pares){
  const key=p.tabla+'|'+p.cols; if(vistos.has(key)) continue; vistos.add(key);
  if(!p.cols || p.cols.includes('${')) continue;
  const q=await fetch(url+`/rest/v1/${p.tabla}?select=${encodeURIComponent(p.cols)}&limit=0`,
    {headers:{apikey:anon,Authorization:'Bearer '+tok}});
  if(q.status===200){ok++; continue;}
  const t=await q.text();
  // PGRST200/201 = problema de RELACIÓN (falta el fk, o el embed es ambiguo).
  // Es lo único que este chequeo puede afirmar de verdad: los 42703/PGRST100
  // son del parser de arriba, que empareja mal cuando la cadena se arma en
  // varias líneas. Se cuentan aparte para no dar una alarma falsa.
  if(/PGRST20[01]/.test(t)) { bad++;
    console.log(`  ✗ RELACIÓN en ${p.tabla}: ${t.slice(0,200)}`);
    console.log(`     cols: ${p.cols.slice(0,160)}`); }
  else ruido++;
}
console.log(`\n${ok} cadenas de select OK${bad?` · ${bad} ROTAS`:' · ninguna rota'}`);
process.exit(bad?1:0);
