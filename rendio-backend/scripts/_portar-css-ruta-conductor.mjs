// Porta el CSS de la RUTA DEL CONDUCTOR v2 (entrega del diseñador, 12-oct-2026) a la PWA.
//
//   node _portar-css-ruta-conductor.mjs            → escribe los dos archivos
//   node _portar-css-ruta-conductor.mjs --check    → NO escribe: falla si lo que hay en disco
//                                                   no es exactamente lo que generaría
//   node _portar-css-ruta-conductor.mjs [--check] [carpeta-fuente] [carpeta-rendio-turnos]
//
// Derivado de _portar-css-rediseno-aux.mjs (mismo lector, mismas verificaciones).
// Por defecto lee Visual/entrega-ruta-conductor-2026-10-12/entrega-ruta-conductor y escribe:
//   · rendio-turnos/rt-conductor.css      — ENTERO generado (nunca a mano).
//   · rendio-turnos/rt-conductor-app.css  — SOLO el tramo entre las marcas
//       /* BEGIN noanim (generado) */ … /* END noanim (generado) */
//     (el resto de ese archivo es a mano: zonas seguras, Leaflet, preflight).
//
// La ruta v2 se monta SOBRE el sistema visual del auxiliar (tokens.css + rx*.css, que el
// diseñador manda sin cambios) más su rt.css. Todo se copia TAL CUAL y solo cambia el
// alcance, para que nada se filtre al resto del conductor, al auxiliar ni al admin:
//
//   :root                    → #driver-ruta-ui.rx-phone
//   [data-ax-night="on"] X   → #driver-ruta-ui.rx-phone[data-ax-night="on"] X
//   .rx-phone X              → #driver-ruta-ui.rx-phone X
//   cualquier otro selector  → #driver-ruta-ui.rx-phone <selector>
//   @keyframes               → sin tocar (rx*/rt*: los rx* son idénticos a los del auxiliar)
//
// QUÉ SE DEJA AFUERA:
//   · tokens.css: solo los bloques de variables (claro y [data-ax-night]).
//   · rx*.css: .rx-wrap, .rx-notch, .rx-sb*, el panel .rx-demo*, todo [data-theme="dark"].
//   · rt.css: .rt-wrap (marco), .rt-feed* y .rt-notes* (paneles de la demo).
//   · De .rx-phone{…}: width, height, border-radius, box-shadow, flex-shrink (marco).
// Si el diseñador manda otra versión: volver a correr el script, nunca editar la salida.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const pos = args.filter(a => !a.startsWith('--'));
const SRC = pos[0] || join(here, '../../../Visual/entrega-ruta-conductor-2026-10-12/entrega-ruta-conductor');
const APP = pos[1] || join(here, '../../rendio-turnos');
const OUT = join(APP, 'rt-conductor.css');
const OUT_APP = join(APP, 'rt-conductor-app.css');

// Mismo orden de carga que el HTML del diseñador (el orden decide la cascada),
// sin admin-tokens.css.
const ALL_DESIGN_FILES = ['tokens.css', 'rx.css', 'rx2.css', 'rx3.css', 'rt.css'];
const FILES = ALL_DESIGN_FILES;
const ROOT = '#driver-ruta-ui.rx-phone';
const FRAME_PROPS = ['width', 'height', 'border-radius', 'box-shadow', 'flex-shrink'];

// Movimiento que se descarta A PROPÓSITO (reglas que la app no usa). Cualquier otro
// animation/transition en una regla descartada hace fallar el script.
const EXPECTED_DROPPED_MOTION = [
  'tokens.css|.r-stepper .seg|transition: background .25s ease',                     // piezas .r-* del cobro: la ruta no las usa
  'tokens.css|.r-btn|transition: transform .12s ease, background .15s ease, opacity .15s ease',
  'tokens.css|.r-icon-btn|transition: background .15s',
  'tokens.css|.r-row|transition: border-color .15s, background .15s',
  'rx2.css|.rx-demo-push|animation:rxRise .5s .6s both',                              // panel de demo
  'rt.css|.rt-feed div|animation:rxRise .35s ease',                                   // panel «Avisos que salen» de la demo
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
  if (file === 'tokens.css') {
    if (s === ':root' || s === '[data-ax-night="on"]') return true;
    return 'tokens.css: no es bloque de variables';
  }
  if (s === ':root' || s === 'html' || s === 'body' || s === '*') return 'global';
  if (/^\.rx-(wrap|notch)\b/.test(s)) return 'marco del teléfono falso';
  if (/^\.rx-sb(\b|-)/.test(s)) return 'barra de estado falsa';
  if (/^\.rx-demo(\b|-)/.test(s)) return 'panel de demo';
  if (/^\.rt-wrap\b/.test(s)) return 'marco de la demo de la ruta';
  if (/^\.rt-(feed|notes)(\b|-)/.test(s)) return 'panel de demo de la ruta';
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

const outParts = [];
for (const f of FILES) {
  const css = stripComments(readFileSync(join(SRC, f), 'utf8'));
  outParts.push(`/* ===== ${f} ===== */`);
  outParts.push(...portBlocks(blocks(css), f));
}

const header = `/* rt-conductor.css — GENERADO por rendio-backend/scripts/_portar-css-ruta-conductor.mjs.
   NO EDITAR A MANO: es el CSS de la ruta del conductor v2 (entrega del diseñador del
   12-oct-2026: tokens.css + rx.css + rx2.css + rx3.css + rt.css) copiado regla por
   regla, con el alcance acotado a ${ROOT}. Las animaciones (keyframes, duraciones,
   curvas, retrasos) son las del diseñador, idénticas. Sin el marco del teléfono falso,
   sin los paneles de la demo y sin el dark genérico. Los ajustes propios de la app
   (zonas seguras, Leaflet, preflight, .rx-noanim, reduced-motion) van en
   rt-conductor-app.css, cargado después. */\n`;
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
gen.push(`/* Generado por _portar-css-ruta-conductor.mjs — no editar este tramo a mano.

   CONTRATO (para driver-rutas.js):
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
  console.log(`  el diseño trae ${all.length} declaraciones de movimiento en total`);
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
if (b < 0 || e < 0 || e < b) fail.push(`rt-conductor-app.css no tiene las marcas ${BEGIN} … ${END}`);
const newApp = b >= 0 && e > b ? appCss.slice(0, b) + genBlock + appCss.slice(e + END.length) : appCss;

if (fail.length) { console.error('✗ ' + fail.join('\n✗ ')); process.exit(1); }

const kfCount = [...kfSrc.values()].reduce((n, v) => n + v.length, 0);
if (CHECK) {
  const cur = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  const drift = [];
  if (cur !== out) drift.push('rt-conductor.css no es lo que genera el script (¿editado a mano o fuente nueva?)');
  if (appCss !== newApp) drift.push('el tramo generado de rt-conductor-app.css no es lo que genera el script');
  if (drift.length) { console.error('✗ ' + drift.join('\n✗ ')); process.exit(1); }
  console.log('✓ --check: rt-conductor.css y el tramo de rt-conductor-app.css coinciden con la fuente');
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
