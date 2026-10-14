// Busca nombres declarados DOS VECES donde de verdad se pisan (o revientan).
//
// POR QUÉ EXISTE: los módulos de rendio-turnos son <script> clásicos. Los que
// van envueltos en un IIFE tienen su propio ámbito y pueden repetir nombres sin
// problema; los que NO —core.js, auxiliar.js, horario.js…— declaran en el
// ámbito GLOBAL, y ahí dos `function foo()` no dan error: gana la última que se
// cargue y la otra desaparece en silencio. El 25-ago eso dejó toda la pantalla
// de viajes del auxiliar mostrando «[object Object]», porque una función nueva
// se llamó igual que la que pintaba las tarjetas.
//
// Comprobaciones:
//   1. funciones repetidas DENTRO de un mismo archivo (el caso del 25-ago) — siempre.
//   2. nombres globales repetidos ENTRE archivos no-IIFE: function, const, let,
//      class y var. Con function+function gana la última EN SILENCIO; si uno de
//      los dos es const/let/class, el navegador lanza SyntaxError al cargar el
//      segundo archivo y ese archivo NO CORRE ENTERO (rediseño 27-sep-2026, #21).
//   3. `window.X =` asignado en dos archivos distintos (los módulos nuevos
//      exportan por window: dos que exportan el mismo nombre se pisan).
//
// IIFE reconocidas: `(function`, `;(function`, `(() =>`, `(async`, `!function`.
//
//   cd rendio-backend && node scripts/_nombres-repetidos.mjs
import { readFileSync, readdirSync } from 'fs';
// Opcional: otra carpeta como argumento (para probar el propio detector).
const dir = process.argv[2] ? process.argv[2].replace(/\/?$/, '/') : new URL('../../rendio-turnos/', import.meta.url).pathname;
const files = readdirSync(dir).filter(f => f.endsWith('.js') && f !== 'sw.js').sort();

// Primera línea con código (sin comentarios de línea ni de bloque).
function primeraLinea(src) {
  const sinBloques = src.replace(/\/\*[\s\S]*?\*\//g, '');
  return sinBloques.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('//')) || '';
}
function enIIFE(src) {
  const l = primeraLinea(src);
  return /^;?\s*\(\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/.test(l)
    || /^!\s*function\b/.test(l);
}

// window.X = … que NO sea window.X.y = … ni comparación. Se ignoran las
// asignaciones a null/undefined/false (limpiar un global no lo declara).
const reWin = /(?:^|[^.\w$])window\.([A-Za-z_$][\w$]*)\s*=(?![=>])\s*([^;\n]*)/g;

const globales = new Map();   // nombre → [archivo, línea, tipo]
const ventanas = new Map();   // nombre → [archivo, línea]
let choques = 0, nIIFE = 0;
const lineaDe = (src, idx) => src.slice(0, idx).split('\n').length;

for (const f of files) {
  const src = readFileSync(dir + f, 'utf8');
  const privado = enIIFE(src);
  if (privado) nIIFE++;

  // 1 · funciones repetidas en el mismo archivo
  const reFn = /^ {0,2}(?:async )?function ([A-Za-z_$][\w$]*)\s*\(/gm;
  const enEste = new Map();
  let m;
  while ((m = reFn.exec(src))) {
    const n = m[1], linea = lineaDe(src, m.index);
    if (enEste.has(n)) {
      console.log(`  ✗ ${f}: ${n}() declarada dos veces (líneas ${enEste.get(n)} y ${linea}) — la segunda pisa a la primera`);
      choques++;
    } else enEste.set(n, linea);
  }

  // 2 · nombres globales entre archivos (solo los que no van en IIFE)
  if (!privado) {
    const reDecl = /^ {0,2}(?:(?:async )?function\s+([A-Za-z_$][\w$]*)\s*\(|(const|let|var|class)\s+([A-Za-z_$][\w$]*))/gm;
    const vistosAqui = new Set();
    while ((m = reDecl.exec(src))) {
      const n = m[1] || m[3], tipo = m[1] ? 'function' : m[2], linea = lineaDe(src, m.index);
      if (vistosAqui.has(n)) continue;   // el mismo archivo ya lo cubre (1) o el parser
      vistosAqui.add(n);
      if (globales.has(n)) {
        const [otro, ol, otipo] = globales.get(n);
        if (otro !== f) {
          const revienta = otipo !== 'function' || tipo !== 'function';
          console.log(`  ✗ ${n} es global en ${otro}:${ol} (${otipo}) y en ${f}:${linea} (${tipo})`
            + (revienta ? ' — SyntaxError: el segundo archivo NO carga' : ' — gana el último en silencio'));
          choques++;
        }
      } else globales.set(n, [f, linea, tipo]);
    }
  }

  // 3 · window.X = en dos archivos
  const yaEnEste = new Set();
  while ((m = reWin.exec(src))) {
    const n = m[1], valor = m[2].trim();
    if (/^(null|undefined|false)\b/.test(valor)) continue;
    if (yaEnEste.has(n)) continue;
    yaEnEste.add(n);
    const linea = lineaDe(src, m.index);
    if (ventanas.has(n)) {
      const [otro, ol] = ventanas.get(n);
      console.log(`  ✗ window.${n} se asigna en ${otro}:${ol} y en ${f}:${linea} — el que carga después pisa al otro`);
      choques++;
    } else ventanas.set(n, [f, linea]);
  }
}

console.log(`\n${files.length} archivos (${nIIFE} con ámbito propio, ${files.length - nIIFE} en el global) · ${globales.size} nombres globales · ${ventanas.size} window.X · ${choques || 'ningún'} choque${choques === 1 ? '' : 's'}`);
process.exit(choques ? 1 : 0);
