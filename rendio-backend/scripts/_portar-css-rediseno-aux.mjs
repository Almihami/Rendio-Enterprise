// Porta el CSS del rediseño del auxiliar (entrega del diseñador, 27-sep-2026) a la PWA.
//
//   node _portar-css-rediseno-aux.mjs [carpeta-fuente] [archivo-salida]
//
// Por defecto lee Visual/entrega-auxiliar-2026-09-27/entrega-rendio-auxiliar/fuente
// y escribe rendio-turnos/rx-auxiliar.css.
//
// POR QUÉ UN SCRIPT Y NO A MANO: la profa pidió seguir las animaciones «con total
// lineamiento». Reescribir 107 KB de CSS a mano es garantía de que alguna duración,
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
// Al final se verifica que keyframes, animation* y transition* salgan idénticos.
// Si el diseñador manda otra versión: volver a correr el script, nunca editar la salida.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = process.argv[2] || join(here, '../../../Visual/entrega-auxiliar-2026-09-27/entrega-rendio-auxiliar/fuente');
const OUT = process.argv[3] || join(here, '../../rendio-turnos/rx-auxiliar.css');
// Mismo orden de carga que el HTML del diseñador (el orden decide la cascada).
const FILES = ['tokens.css', 'points-tokens.css', 'admin-tokens.css', 'cobro-aux2.css', 'rx.css', 'rx2.css', 'rx3.css'];
const ROOT = '#auxiliar-ui.rx-phone';

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
function splitSelectors(sel) {
  const out = []; let depth = 0, cur = '', q = null;
  for (const c of sel) {
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function scopeSelector(s) {
  s = s.replace(/\s+/g, ' ').trim();
  if (s === ':root' || s === 'html' || s === 'body') return ROOT;
  if (s.startsWith(':root')) return ROOT + s.slice(5);
  if (s.startsWith('[data-ax-night')) return ROOT + s;
  if (s.startsWith('.rx-phone')) return ROOT + s.slice('.rx-phone'.length);
  return ROOT + ' ' + s;
}

// ---- Port ----
const kfSrc = new Map(), motionSrc = [];
const outParts = [];
function portBlocks(list, file, depth) {
  const parts = [];
  for (const { prelude, body } of list) {
    if (/^@(-webkit-)?keyframes\b/.test(prelude)) {
      const name = prelude.split(/\s+/)[1];
      const norm = body.replace(/\s+/g, ' ').trim();
      if (!kfSrc.has(name)) kfSrc.set(name, []);
      kfSrc.get(name).push(norm);
      parts.push(`${prelude}{${body.trim()}}`);
    } else if (/^@(media|supports|container)\b/.test(prelude)) {
      parts.push(`${prelude}{\n${portBlocks(blocks(body), file, depth + 1).join('\n')}\n}`);
    } else if (/^@(font-face|import|charset|page)\b/.test(prelude)) {
      parts.push(`${prelude}{${body.trim()}}`);
    } else if (prelude.startsWith('@')) {
      throw new Error(`${file}: regla @ no prevista: ${prelude}`);
    } else {
      const sels = splitSelectors(prelude).map(scopeSelector);
      for (const d of body.split(';')) {
        const t = d.trim();
        if (/^(animation|transition)/.test(t)) motionSrc.push(t.replace(/\s+/g, ' '));
      }
      parts.push(`${sels.join(',')}{${body.trim()}}`);
    }
  }
  return parts;
}
for (const f of FILES) {
  const css = stripComments(readFileSync(join(SRC, f), 'utf8'));
  outParts.push(`/* ===== ${f} ===== */`);
  outParts.push(...portBlocks(blocks(css), f, 0));
}

const header = `/* rx-auxiliar.css — GENERADO por rendio-backend/scripts/_portar-css-rediseno-aux.mjs.
   NO EDITAR A MANO: es el CSS del rediseño del auxiliar (entrega del diseñador del
   27-sep-2026) copiado regla por regla, con el alcance acotado a ${ROOT}.
   Las animaciones (keyframes, duraciones, curvas, retrasos) son las del diseñador,
   idénticas. Los ajustes propios de la app (raíz a pantalla completa, zonas seguras
   del teléfono) van en OTRO archivo que se carga después de este. */\n`;
const out = header + outParts.join('\n') + '\n';

// ---- Verificación: el movimiento sale idéntico ----
const kfOut = new Map(), motionOut = [];
(function scan(list) {
  for (const { prelude, body } of list) {
    if (/^@(-webkit-)?keyframes\b/.test(prelude)) {
      const name = prelude.split(/\s+/)[1];
      if (!kfOut.has(name)) kfOut.set(name, []);
      kfOut.get(name).push(body.replace(/\s+/g, ' ').trim());
    } else if (/^@(media|supports|container)\b/.test(prelude)) scan(blocks(body));
    else if (!prelude.startsWith('@')) for (const d of body.split(';')) { const t = d.trim(); if (/^(animation|transition)/.test(t)) motionOut.push(t.replace(/\s+/g, ' ')); }
  }
})(blocks(stripComments(out)));

const fail = [];
for (const [n, v] of kfSrc) if (JSON.stringify(v) !== JSON.stringify(kfOut.get(n))) fail.push('keyframes distinto: ' + n);
for (const n of kfOut.keys()) if (!kfSrc.has(n)) fail.push('keyframes de más: ' + n);
if (JSON.stringify(motionSrc) !== JSON.stringify(motionOut)) fail.push(`animation/transition: ${motionSrc.length} en la fuente, ${motionOut.length} en la salida o en otro orden`);
if (fail.length) { console.error('✗ ' + fail.join('\n✗ ')); process.exit(1); }

writeFileSync(OUT, out);
console.log(`✓ ${OUT}`);
console.log(`  ${kfSrc.size} keyframes idénticos · ${motionSrc.length} declaraciones animation/transition idénticas y en el mismo orden`);
console.log(`  ${(out.length / 1024).toFixed(1)} KB`);
