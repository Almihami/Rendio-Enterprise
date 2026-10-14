// Porta el CSS del rediseño del auxiliar (entrega del diseñador, 27-sep-2026) a la PWA.
//
//   node _portar-css-rediseno-aux.mjs            → escribe los dos archivos
//   node _portar-css-rediseno-aux.mjs --check    → NO escribe: falla si lo que hay en disco
//                                                  no es exactamente lo que generaría
//   node _portar-css-rediseno-aux.mjs [--check] [carpeta-fuente] [carpeta-rendio-turnos]
//
// Por defecto lee Visual/entrega-auxiliar-2026-09-27/entrega-rendio-auxiliar/fuente y escribe:
//   · rendio-turnos/rx-auxiliar.css  — ENTERO generado (nunca a mano).
//   · rendio-turnos/rx-aux-app.css   — SOLO el tramo entre las marcas
//       /* BEGIN noanim (generado) */ … /* END noanim (generado) */
//     (el resto de ese archivo es a mano, dueño P1).
//
// POR QUÉ UN SCRIPT Y NO A MANO: la profa pidió seguir las animaciones «con total
// lineamiento». Reescribir 100 KB de CSS a mano es garantía de que alguna duración,
// curva o retraso se desvíe. El script copia cada regla TAL CUAL y lo único que
// cambia es el alcance, para que nada se filtre al conductor ni al admin:
//
//   :root                    → #auxiliar-ui.rx-phone       (los tokens viven en la raíz del auxiliar)
//   [data-ax-night="on"] X   → #auxiliar-ui.rx-phone[data-ax-night="on"] X
//   .rx-phone X              → #auxiliar-ui.rx-phone X
//   cualquier otro selector  → #auxiliar-ui.rx-phone <selector>
//   @keyframes               → sin tocar (nombres rx*/cb2*/cbUp: no chocan con los de la app)
//
// Todos los selectores ganan la MISMA especificidad (+1 id, +1 clase), así que el orden
// de la cascada entre reglas del diseñador queda exactamente como en su prototipo.
//
// QUÉ SE DEJA AFUERA (plan final §1.1/§1.3 + AJUSTES §2b/§3, 27-sep):
//   · admin-tokens.css entero: sus --a-* pisan el nocturno del auxiliar heredado.
//   · tokens.css: solo pasan los bloques de variables (claro y [data-ax-night]) y las
//     .r-btn*, .r-stepper, .r-bottom, .r-card, .r-chip que usa el cobro. Afuera
//     [data-theme="dark"], *{}, svg.lucide, .r-screen, .r-header*, .r-body, .r-icon-btn, .r-row.
//   · points-tokens.css: variables + .pts-bar/.pts-mark; afuera su [data-theme="dark"].
//   · cobro-aux2.css: todo menos el marco del prototipo (.cb-phone…).
//   · rx*.css: afuera .rx-wrap, .rx-notch, .rx-sb*, el panel .rx-demo/.rx-demo-* (se
//     conserva .rx-demo-push, que es la notificación de ejemplo) y todo [data-theme="dark"].
//   · De .rx-phone{…} se quitan solo las propiedades del MARCO del teléfono falso:
//     width, height, border-radius, box-shadow, flex-shrink.
//
// VERIFICACIÓN (si falla, no escribe nada y sale con 1):
//   · TODOS los keyframes de los 7 archivos del diseño salen, con el mismo texto.
//   · TODAS las declaraciones animation*/transition* de las reglas portadas salen
//     idénticas y en el mismo orden; las de reglas descartadas tienen que estar en la
//     lista conocida (EXPECTED_DROPPED_MOTION) — si el diseñador agrega movimiento en
//     algo que se descarta, el script lo dice en vez de perderlo callado.
//   · Ningún selector de salida empieza sin #auxiliar-ui.rx-phone; no hay :root,
//     [data-theme ni *{ sueltos; no se define ninguna --a-*.
//
// TRAMO GENERADO de rx-aux-app.css (plan final §1.3.4, AJUSTES §3):
//   1. .rx-noanim: repintar la misma pantalla no repite las animaciones de UNA sola vez
//      (entradas). Cubre TODO el subárbol del nodo con .rx-noanim (y el nodo mismo),
//      pero NO las infinitas (el punto «En vivo», el typing, el brillo del pase).
//   2. Salidas (.out) restauradas bajo .rx-noanim: una capa repintada que después se
//      cierra igual sale con su animación de salida, y sus hijos no re-animan su entrada.
//   3. @media (prefers-reduced-motion: reduce): la única adición permitida (ANIMACIONES).
//      Sin esa preferencia del sistema, todo se ve idéntico al diseño.
// Si el diseñador manda otra versión: volver a correr el script, nunca editar la salida.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const pos = args.filter(a => !a.startsWith('--'));
const SRC = pos[0] || join(here, '../../../Visual/entrega-auxiliar-2026-09-27/entrega-rendio-auxiliar/fuente');
const APP = pos[1] || join(here, '../../rendio-turnos');
const OUT = join(APP, 'rx-auxiliar.css');
const OUT_APP = join(APP, 'rx-aux-app.css');

// Mismo orden de carga que el HTML del diseñador (el orden decide la cascada),
// sin admin-tokens.css.
const ALL_DESIGN_FILES = ['tokens.css', 'points-tokens.css', 'admin-tokens.css', 'cobro-aux2.css', 'rx.css', 'rx2.css', 'rx3.css'];
const FILES = ALL_DESIGN_FILES.filter(f => f !== 'admin-tokens.css');
const ROOT = '#auxiliar-ui.rx-phone';
const FRAME_PROPS = ['width', 'height', 'border-radius', 'box-shadow', 'flex-shrink'];

// Movimiento que se descarta A PROPÓSITO (reglas que la app no usa). Cualquier otro
// animation/transition en una regla descartada hace fallar el script.
const EXPECTED_DROPPED_MOTION = [
  'tokens.css|.r-icon-btn|transition: background .15s',                               // solo cobro-aux.jsx v1 (no se porta)
  'tokens.css|.r-row|transition: border-color .15s, background .15s',                 // ídem
  'admin-tokens.css|.a-aux-card|transition: border-color .12s, transform .12s, box-shadow .12s', // consola del jefe del prototipo
];

// ---- Lector de CSS mínimo: comentarios, cadenas y llaves anidadas ----
function stripComments(css) {
  let out = '', i = 0, q = null;
  while (i < css.length) {
    const c = css[i];
    if (q) { out += c; if (c === '\\') { out += css[i + 1] || ''; i += 2; continue; } if (c === q) q = null; i++; continue; }
    if (c === '"' || c === "'") { q = c; out += c; i++; continue; }
    if (c === '/' && css[i + 1] === '*') { const j = css.indexOf('*/', i + 2); i = j < 0 ? css.length : j + 2; continue; }
    out += c; i++;
  }
  return out;
}
function blocks(css) {
  // Devuelve [{ prelude, body }] del nivel superior; body sin las llaves externas.
  const res = []; let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) { if (css.slice(i).trim()) throw new Error('Texto suelto al final: ' + css.slice(i, i + 80)); break; }
    const prelude = css.slice(i, open).trim();
    let depth = 1, k = open + 1, q = null;
    while (k < css.length && depth) {
      const c = css[k];
      if (q) { if (c === '\\') { k += 2; continue; } if (c === q) q = null; }
      else if (c === '"' || c === "'") q = c;
      else if (c === '{') depth++;
      else if (c === '}') depth--;
      k++;
    }
    if (depth) throw new Error('Llave sin cerrar después de: ' + prelude.slice(0, 80));
    res.push({ prelude, body: css.slice(open + 1, k - 1) });
    i = k;
  }
  return res;
}
function splitTop(str, sep) {
  // Parte por `sep` fuera de (), [] y cadenas.
  const out = []; let depth = 0, cur = '', q = null;
  for (const c of str) {
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (c === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}
const splitSelectors = sel => splitTop(sel, ',').map(s => s.trim()).filter(Boolean);
const decls = body => splitTop(body, ';').map(d => d.trim()).filter(Boolean);
const normSel = s => s.replace(/\s+/g, ' ').trim();
const normDecl = d => d.replace(/\s+/g, ' ').trim();
const isMotion = d => /^(animation|transition)/.test(d);

function scopeSelector(s) {
  s = normSel(s);
  if (s === ':root' || s === 'html' || s === 'body') return ROOT;
  if (s.startsWith(':root')) return ROOT + s.slice(5);
  if (s.startsWith('[data-ax-night')) return ROOT + s;
  if (s.startsWith('.rx-phone')) return ROOT + s.slice('.rx-phone'.length);
  return ROOT + ' ' + s;
}

// ¿Se porta este selector? true, o el motivo por el que se descarta.
function keepSelector(file, s) {
  s = normSel(s);
  if (/\[data-theme/.test(s)) return '[data-theme] (dark genérico de escritorio)';
  if (file === 'tokens.css' || file === 'points-tokens.css') {
    if (s === ':root' || s === '[data-ax-night="on"]') return true;
    if (file === 'tokens.css' && /^\.r-(btn|stepper|bottom|card|chip)\b/.test(s)) return true;
    if (file === 'points-tokens.css' && /^\.pts-(bar|mark)\b/.test(s)) return true;
    return 'no es bloque de variables ni pieza que use el cobro';
  }
  if (s === ':root' || s === 'html' || s === 'body' || s === '*') return 'global';
  if (/^\.cb-phone\b/.test(s)) return 'marco del prototipo del cobro';
  if (/^\.rx-(wrap|notch)\b/.test(s)) return 'marco del teléfono falso';
  if (/^\.rx-sb(\b|-)/.test(s)) return 'barra de estado falsa';
  if (/^\.rx-demo(\b|-)/.test(s) && !/^\.rx-demo-push\b/.test(s)) return 'panel de demo';
  return true;
}

// ---- Port ----
const kfSrc = new Map();          // nombre → [texto normalizado] de TODOS los archivos del diseño
const motionKept = [];            // declaraciones animation/transition de reglas portadas, en orden
const motionDropped = [];         // 'archivo|selector|declaración' de reglas descartadas
const animRules = [];             // reglas portadas con animation*: {sels:[orig], decls:[...]}
const dropLog = new Map();        // motivo → n

function recordKeyframes(prelude, body) {
  const name = prelude.split(/\s+/)[1];
  if (!kfSrc.has(name)) kfSrc.set(name, []);
  kfSrc.get(name).push(body.replace(/\s+/g, ' ').trim());
  return name;
}

function portBlocks(list, file) {
  const parts = [];
  for (const { prelude, body } of list) {
    if (/^@(-webkit-)?keyframes\b/.test(prelude)) {
      recordKeyframes(prelude, body);
      parts.push(`${prelude}{${body.trim()}}`);
    } else if (/^@(media|supports|container)\b/.test(prelude)) {
      const inner = portBlocks(blocks(body), file);
      if (inner.length) parts.push(`${prelude}{\n${inner.join('\n')}\n}`);
    } else if (/^@(font-face|import|charset|page)\b/.test(prelude)) {
      parts.push(`${prelude}{${body.trim()}}`);
    } else if (prelude.startsWith('@')) {
      throw new Error(`${file}: regla @ no prevista: ${prelude}`);
    } else {
      const all = splitSelectors(prelude);
      const kept = all.filter(s => keepSelector(file, s) === true);
      let ds = decls(body);
      if (!kept.length) {
        const why = keepSelector(file, all[0]);
        dropLog.set(why, (dropLog.get(why) || 0) + 1);
        for (const d of ds) if (isMotion(d)) motionDropped.push(`${file}|${all.map(normSel).join(',')}|${normDecl(d)}`);
        continue;
      }
      for (const s of all) if (keepSelector(file, s) !== true) { const why = keepSelector(file, s); dropLog.set(why, (dropLog.get(why) || 0) + 1); }
      // Marco del teléfono falso: solo en la regla .rx-phone{…} exacta.
      if (kept.length === 1 && normSel(kept[0]) === '.rx-phone') {
        const before = ds.length;
        ds = ds.filter(d => !FRAME_PROPS.includes(d.split(':')[0].trim().toLowerCase()));
        if (before - ds.length) dropLog.set('propiedades del marco en .rx-phone', (dropLog.get('propiedades del marco en .rx-phone') || 0) + (before - ds.length));
      }
      const motion = ds.filter(isMotion);
      motionKept.push(...motion.map(normDecl));
      if (motion.some(d => /^animation/.test(d))) animRules.push({ sels: kept.map(normSel), decls: motion.map(normDecl) });
      parts.push(`${kept.map(scopeSelector).join(',')}{${ds.join(';')}}`);
    }
  }
  return parts;
}

// Keyframes de admin-tokens.css también cuentan para «todos los keyframes salen».
{
  const css = stripComments(readFileSync(join(SRC, 'admin-tokens.css'), 'utf8'));
  (function scanDropped(list) {
    for (const { prelude, body } of list) {
      if (/^@(-webkit-)?keyframes\b/.test(prelude)) throw new Error('admin-tokens.css trae keyframes: hay que portarlos aparte (' + prelude + ')');
      else if (/^@(media|supports|container)\b/.test(prelude)) scanDropped(blocks(body));
      else if (!prelude.startsWith('@')) for (const d of decls(body)) if (isMotion(d)) motionDropped.push(`admin-tokens.css|${splitSelectors(prelude).map(normSel).join(',')}|${normDecl(d)}`);
    }
  })(blocks(css));
  dropLog.set('admin-tokens.css entero (sus --a-* pisan el nocturno heredado)', 1);
}

const outParts = [];
for (const f of FILES) {
  const css = stripComments(readFileSync(join(SRC, f), 'utf8'));
  outParts.push(`/* ===== ${f} ===== */`);
  outParts.push(...portBlocks(blocks(css), f));
}

const header = `/* rx-auxiliar.css — GENERADO por rendio-backend/scripts/_portar-css-rediseno-aux.mjs.
   NO EDITAR A MANO: es el CSS del rediseño del auxiliar (entrega del diseñador del
   27-sep-2026) copiado regla por regla, con el alcance acotado a ${ROOT}.
   Las animaciones (keyframes, duraciones, curvas, retrasos) son las del diseñador,
   idénticas. Sin admin-tokens.css, sin el marco del teléfono falso, sin el panel de
   demo y sin el dark genérico. Los ajustes propios de la app (puente --a-*, zonas
   seguras, .rx-noanim, reduced-motion) van en rx-aux-app.css, cargado después. */\n`;
const out = header + outParts.join('\n') + '\n';

// ---- Tramo generado de rx-aux-app.css ----
const animValue = r => r.decls.filter(d => /^animation\s*:/.test(d)).map(d => d.replace(/^animation\s*:\s*/, '')).join(',');
const animNames = r => {
  const names = [];
  for (const d of r.decls) {
    const m = d.match(/^animation(-name)?\s*:\s*(.*)$/);
    if (!m) continue;
    for (const part of splitTop(m[2], ',')) {
      const tok = part.trim().split(/\s+/).find(t => kfSrc.has(t));
      if (tok) names.push(tok);
    }
  }
  return names;
};
const isInfinite = r => /\binfinite\b/.test(animValue(r)) || r.decls.some(d => /^animation-iteration-count\s*:\s*infinite/.test(d));
const setsAnimation = r => r.decls.some(d => /^animation(-name)?\s*:/.test(d));
const isExit = s => /\.out\b/.test(s);

// Compuestos de un selector: [[texto, combinador-siguiente], …]
function compounds(sel) {
  const parts = []; let cur = '', depth = 0, q = null;
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i];
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (depth === 0 && (c === ' ' || c === '>' || c === '+' || c === '~')) {
      let comb = '';
      while (i < sel.length && /[\s>+~]/.test(sel[i])) { comb += sel[i]; i++; }
      i--;
      parts.push([cur, comb.trim() ? comb.trim() : ' ']);
      cur = '';
      continue;
    }
    cur += c;
  }
  parts.push([cur, '']);
  return parts;
}
function withClassAt(sel, idx, cls) {
  const cs = compounds(sel);
  return cs.map(([t, comb], i) => {
    if (i === idx) { const k = t.indexOf('::'); t = k < 0 ? t + cls : t.slice(0, k) + cls + t.slice(k); }
    return t + (comb === ' ' ? ' ' : comb ? comb : '');
  }).join('');
}
// Todas las formas de «este selector bajo un nodo con la clase cls»: el nodo es un
// ancestro de todo el selector, o es cualquiera de sus compuestos.
function classVariants(sel, cls) {
  if (sel.startsWith('.rx-phone') || sel.startsWith('[data-ax-night') || sel.startsWith(':root'))
    throw new Error('regla con animación colgada de la raíz, no prevista: ' + sel);
  const v = [`${ROOT} ${cls} ${sel}`];
  const n = compounds(sel).length;
  for (let i = 0; i < n; i++) v.push(`${ROOT} ${withClassAt(sel, i, cls)}`);
  return v;
}
const noanimVariants = sel => classVariants(sel, '.rx-noanim');
const animVariants = sel => classVariants(sel, '.rx-anim');

const oneShot = animRules.filter(r => setsAnimation(r) && !isInfinite(r));
const entryRules = [], exitRules = [];
for (const r of oneShot) {
  const entry = r.sels.filter(s => !isExit(s)), exit = r.sels.filter(isExit);
  if (entry.length) entryRules.push({ ...r, sels: entry });
  if (exit.length) exitRules.push({ ...r, sels: exit });
}
// Reduced-motion: qué se conserva (indicadores funcionales, sin desplazamiento).
const KEEP_REDUCED = new Set(['rxSpin', 'cb2Spin', 'rxPulseR', 'cb2Pulse', 'cb2PulseB', 'rxBlink']);
const HIDE_AT_END = new Set(['rxToast', 'cb2Toast']);   // terminan invisibles: con 1 ms no se verían
const KEEP_DELAY = new Set(['rxLift']);                  // el banner se levanta solo a los 3,6 s

// Qué hace reduced-motion con cada regla (null = se deja igual).
function reducedDecl(r) {
  const names = animNames(r);
  if (isInfinite(r)) return names.length && names.every(n => KEEP_REDUCED.has(n)) ? null : 'animation:none';
  if (names.some(n => HIDE_AT_END.has(n))) return 'animation:none';
  return 'animation-duration:1ms' + (names.some(n => KEEP_DELAY.has(n)) ? '' : ';animation-delay:0s');
}
const nSel = rules => rules.reduce((n, r) => n + r.sels.length, 0);

const gen = [];
gen.push(`/* Generado por _portar-css-rediseno-aux.mjs — no editar este tramo a mano.

   CONTRATO (para AuxShell y las pantallas):
   · .rx-noanim en un nodo (la capa, la pestaña, la hoja) = «esto es un repintado sin
     cambio»: dentro de TODO su subárbol, y en el nodo mismo, no corren las animaciones
     de una sola vez del diseño (${nSel(entryRules)} selectores). Las infinitas siguen (punto «En vivo»,
     typing, brillo del pase). La clase se deja puesta hasta que el nodo se reemplace:
     quitarla haría arrancar las animaciones en ese momento.
   · .rx-anim en un nodo = «este nodo SÍ anima aunque esté dentro de un .rx-noanim».
     Es el re-montaje por key del diseño (hora grande del viaje, maletas, código de
     encuentro, cifra del anillo, globo de la campana, paso del pedido…) y los
     disparos por estado (.shake, .kick, .on de las estrellas, .ok del código).
     AuxRxUI.remount(el) recrea el nodo y le pone .rx-anim.
   · Las salidas (.out) corren siempre, con o sin .rx-noanim. */`);
gen.push(`/* 1) .rx-noanim: se apagan las entradas. */`);
for (const r of entryRules) gen.push(`${r.sels.flatMap(noanimVariants).join(',\n')}{animation:none}`);
gen.push(`/* 2) .rx-anim: vuelven las entradas del diseño, copiadas tal cual. Mismo peso que (1),
      escritas después: ganan. */`);
for (const r of entryRules) gen.push(`${r.sels.flatMap(animVariants).join(',\n')}{${r.decls.join(';')}}`);
gen.push(`/* 3) Las salidas (.out) vuelven a correr aunque la capa se haya repintado con .rx-noanim.
      Mismas declaraciones que el diseño, copiadas tal cual. */`);
for (const r of exitRules) gen.push(`${r.sels.flatMap(noanimVariants).join(',\n')}{${r.decls.join(';')}}`);
const red = [];
for (const r of animRules) {
  if (!setsAnimation(r)) continue;
  const d = reducedDecl(r);
  if (d) red.push(`${r.sels.map(scopeSelector).join(',')}{${d}}`);
}
for (const r of entryRules) { const d = reducedDecl(r); if (d) red.push(`${r.sels.flatMap(animVariants).join(',')}{${d}}`); }
for (const r of exitRules) { const d = reducedDecl(r); if (d) red.push(`${r.sels.flatMap(noanimVariants).join(',')}{${d}}`); }
gen.push(`/* 4) prefers-reduced-motion (única adición permitida por ANIMACIONES): las entradas y
      salidas saltan a su estado final (1 ms), los toasts no se animan (terminarían
      invisibles), las infinitas decorativas se apagan y quedan los indicadores
      funcionales (${[...KEEP_REDUCED].join(', ')}). Sin esa preferencia del sistema no
      cambia nada. */
@media (prefers-reduced-motion: reduce){
${red.join('\n')}
}`);
const BEGIN = '/* BEGIN noanim (generado) */', END = '/* END noanim (generado) */';
const genBlock = `${BEGIN}\n${gen.join('\n')}\n${END}`;

// ---- Verificación ----
const fail = [];
const kfOut = new Map(), motionOut = [], selsOut = [];
(function scan(list) {
  for (const { prelude, body } of list) {
    if (/^@(-webkit-)?keyframes\b/.test(prelude)) {
      const name = prelude.split(/\s+/)[1];
      if (!kfOut.has(name)) kfOut.set(name, []);
      kfOut.get(name).push(body.replace(/\s+/g, ' ').trim());
    } else if (/^@(media|supports|container)\b/.test(prelude)) scan(blocks(body));
    else if (!prelude.startsWith('@')) {
      selsOut.push(...splitSelectors(prelude));
      for (const d of decls(body)) {
        if (isMotion(d)) motionOut.push(normDecl(d));
        if (/^--a-/.test(d)) fail.push('se define una --a-* en la salida: ' + prelude.slice(0, 60));
      }
    }
  }
})(blocks(stripComments(out)));

for (const [n, v] of kfSrc) if (JSON.stringify(v) !== JSON.stringify(kfOut.get(n))) fail.push('keyframes distinto o perdido: ' + n);
for (const n of kfOut.keys()) if (!kfSrc.has(n)) fail.push('keyframes de más: ' + n);
if (JSON.stringify(motionKept) !== JSON.stringify(motionOut)) fail.push(`animation/transition: ${motionKept.length} en las reglas portadas, ${motionOut.length} en la salida o en otro orden`);
// Chequeo independiente del filtro: TODO el movimiento de los 7 archivos del diseño,
// menos la lista conocida de descartes, tiene que ser exactamente el de la salida.
{
  const all = [];
  for (const f of ALL_DESIGN_FILES) (function scanRaw(list) {
    for (const { prelude, body } of list) {
      if (/^@(-webkit-)?keyframes\b/.test(prelude)) continue;
      if (/^@(media|supports|container)\b/.test(prelude)) { scanRaw(blocks(body)); continue; }
      if (!prelude.startsWith('@')) for (const d of decls(body)) if (isMotion(d)) all.push(normDecl(d));
    }
  })(blocks(stripComments(readFileSync(join(SRC, f), 'utf8'))));
  const bag = new Map(); for (const d of all) bag.set(d, (bag.get(d) || 0) + 1);
  for (const m of EXPECTED_DROPPED_MOTION) { const d = m.split('|').pop(); bag.set(d, (bag.get(d) || 0) - 1); }
  for (const d of motionOut) bag.set(d, (bag.get(d) || 0) - 1);
  for (const [d, n] of bag) if (n !== 0) fail.push(`movimiento del diseño ${n > 0 ? 'perdido' : 'de más'} (${Math.abs(n)}×): ${d}`);
  // ANIMACIONES-2026-09-27.md: 97 filas de animación (dos de ellas, .rx-in y .cb2-in,
  // traen además animation-delay) + 57 de transición = 156 declaraciones.
  if (all.length !== 156) console.warn(`  (aviso) el diseño trae ${all.length} declaraciones de movimiento; la entrega del 27-sep traía 156: ¿fuente nueva? revisar ANIMACIONES`);
}
for (const m of motionDropped) if (!EXPECTED_DROPPED_MOTION.includes(m)) fail.push('se descartaría movimiento no previsto: ' + m);
for (const m of EXPECTED_DROPPED_MOTION) if (!motionDropped.includes(m)) fail.push('EXPECTED_DROPPED_MOTION desactualizado (ya no existe): ' + m);
for (const s of selsOut) {
  if (!s.startsWith(ROOT)) fail.push('selector sin alcance: ' + s);
  if (/:root|\[data-theme/.test(s)) fail.push('selector prohibido: ' + s);
  if (/^\*|,\s*\*\s*$/.test(s)) fail.push('* suelto: ' + s);
}
// El tramo generado: cada selector con alcance y las salidas copiadas tal cual.
(function scanGen(list) {
  for (const { prelude, body } of list) {
    if (/^@media/.test(prelude)) { scanGen(blocks(body)); continue; }
    for (const s of splitSelectors(prelude)) if (!s.startsWith(ROOT)) fail.push('tramo generado: selector sin alcance: ' + s);
  }
})(blocks(stripComments(genBlock)));
for (const r of [...exitRules, ...entryRules]) for (const d of r.decls) if (!genBlock.includes(d)) fail.push('declaración no copiada tal cual al tramo generado: ' + d);

// rx-aux-app.css: el tramo va entre las marcas del archivo a mano.
if (!existsSync(OUT_APP)) fail.push('falta ' + OUT_APP);
const appCss = existsSync(OUT_APP) ? readFileSync(OUT_APP, 'utf8') : '';
const b = appCss.indexOf(BEGIN), e = appCss.indexOf(END);
if (b < 0 || e < 0 || e < b) fail.push(`rx-aux-app.css no tiene las marcas ${BEGIN} … ${END}`);
const newApp = b >= 0 && e > b ? appCss.slice(0, b) + genBlock + appCss.slice(e + END.length) : appCss;

if (fail.length) { console.error('✗ ' + fail.join('\n✗ ')); process.exit(1); }

const kfCount = [...kfSrc.values()].reduce((n, v) => n + v.length, 0);
if (CHECK) {
  const cur = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  const drift = [];
  if (cur !== out) drift.push('rx-auxiliar.css no es lo que genera el script (¿editado a mano o fuente nueva?)');
  if (appCss !== newApp) drift.push('el tramo generado de rx-aux-app.css no es lo que genera el script');
  if (drift.length) { console.error('✗ ' + drift.join('\n✗ ')); process.exit(1); }
  console.log('✓ --check: rx-auxiliar.css y el tramo de rx-aux-app.css coinciden con la fuente');
} else {
  writeFileSync(OUT, out);
  writeFileSync(OUT_APP, newApp);
  console.log(`✓ ${OUT}`);
  console.log(`✓ ${OUT_APP} (tramo generado)`);
}
console.log(`  ${kfSrc.size} nombres de keyframes (${kfCount} definiciones) idénticos · ${motionKept.length} declaraciones animation/transition idénticas y en el mismo orden`);
console.log(`  descartado a propósito: ${motionDropped.length} declaraciones de movimiento (lista conocida) · ${[...dropLog].map(([k, v]) => `${k}: ${v}`).join(' · ')}`);
console.log(`  .rx-noanim/.rx-anim: ${nSel(entryRules)} selectores de una vez · ${nSel(exitRules)} salidas restauradas · reduced-motion: ${red.length} reglas`);
console.log(`  ${(out.length / 1024).toFixed(1)} KB`);
