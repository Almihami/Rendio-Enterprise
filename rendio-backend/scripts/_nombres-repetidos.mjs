// Busca nombres declarados DOS VECES donde de verdad se pisan.
//
// POR QUÉ EXISTE: los módulos de rendio-turnos son <script> clásicos. Los que
// van envueltos en un IIFE tienen su propio ámbito y pueden repetir nombres sin
// problema; los que NO —core.js, auxiliar.js, horario.js…— declaran en el
// ámbito GLOBAL, y ahí dos `function foo()` no dan error: gana la última que se
// cargue y la otra desaparece en silencio. El 25-ago eso dejó toda la pantalla
// de viajes del auxiliar mostrando «[object Object]», porque una función nueva
// se llamó igual que la que pintaba las tarjetas.
//
// Dos comprobaciones:
//   1. duplicados DENTRO de un mismo archivo (el caso del 25-ago) — siempre.
//   2. duplicados ENTRE archivos — solo entre los que no van dentro de un IIFE.
import { readFileSync, readdirSync } from 'fs';
const dir='../rendio-turnos/';
const files=readdirSync(dir).filter(f=>f.endsWith('.js') && f!=='sw.js');

function enIIFE(src){
  const lineas=src.split('\n').map(l=>l.trim())
    .filter(l=>l && !l.startsWith('//') && !l.startsWith('/*') && !l.startsWith('*'));
  return /^\(function\s*\(/.test(lineas[0]||'');
}

const globales=new Map(); let choques=0;
for(const f of files){
  const src=readFileSync(dir+f,'utf8');
  const privado=enIIFE(src);
  const re=/^ {0,2}(?:async )?function ([A-Za-z_$][\w$]*)\s*\(/gm;
  let m; const enEste=new Map();
  while((m=re.exec(src))){
    const n=m[1], linea=src.slice(0,m.index).split('\n').length;
    if(enEste.has(n)){
      console.log(`  ✗ ${f}: ${n}() declarada dos veces (líneas ${enEste.get(n)} y ${linea}) — la segunda pisa a la primera`);
      choques++;
    } else enEste.set(n,linea);
    if(privado) continue;
    if(globales.has(n)){
      const [otro,ol]=globales.get(n);
      if(otro!==f){ console.log(`  ✗ ${n}() es global en ${otro}:${ol} y en ${f}:${linea}`); choques++; }
    } else globales.set(n,[f,linea]);
  }
}
const nIIFE=files.filter(f=>enIIFE(readFileSync(dir+f,'utf8'))).length;
console.log(`\n${files.length} archivos (${nIIFE} con ámbito propio, ${files.length-nIIFE} en el global) · ${globales.size} funciones globales · ${choques||'ningún'} choque${choques===1?'':'s'}`);
process.exit(choques?1:0);
