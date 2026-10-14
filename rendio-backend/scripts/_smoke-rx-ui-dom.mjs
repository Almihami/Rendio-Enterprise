// P1 · Sistema visual del rediseño del auxiliar (27-sep-2026): prueba de humo.
//
//   cd rendio-backend/scripts && node _smoke-rx-ui-dom.mjs
//
// Qué prueba:
//   1. _portar-css-rediseno-aux.mjs --check en verde: rx-auxiliar.css y el tramo
//      generado de rx-aux-app.css son EXACTAMENTE lo que sale de la fuente.
//   2. Las tablas de ANIMACIONES-2026-09-27.md, fila por fila: cada keyframe con el
//      mismo texto y cada declaración animation/transition en la regla portada con
//      el mismo selector (menos los 3 descartes a propósito, con su motivo).
//   3. Alcance: ningún selector de rx-auxiliar.css ni de rx-aux-app.css sin
//      #auxiliar-ui.rx-phone; sin :root, [data-theme ni --a-* definidas en el
//      portado; en index.html NINGÚN selector de los dos toca algo sin rx-phone
//      (conductor, admin, auxiliar viejo intactos).
//   4. El sprite: todos los nombres de RXI ∪ ICON leídos de las fuentes, con los
//      trazos idénticos, y cada ícono que usan rx-*.jsx y cobro-aux2*.jsx existe.
//   5. Las primitivas de AuxRxUI: misma estructura/clases/estilos que el JSX, días y
//      horas en Bogotá, contadores 800/700 ms con 1−(1−k)³, hoja que sale en 220 ms,
//      re-montaje que recrea el nodo con .rx-anim.
//
// Lo que NO cubre (jsdom no hace layout ni corre animaciones):
//   · cómo se VE: desbordes a 390 px, sombras, el nocturno con piezas heredadas,
//     la negrita de los títulos; eso se mira en el navegador y en el teléfono.
//   · que las animaciones CORRAN (solo que las reglas salgan idénticas).
//   · la validez de los selectores con :where(:not(…)) en el motor real: jsdom no
//     los evalúa; se miró aparte en el navegador (conteo de cssRules).
//   · Leaflet real (lfIcon solo arma las opciones del L.divIcon), push real.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const APP = join(here, '../../rendio-turnos/');
const VIS = join(here, '../../../Visual/entrega-auxiliar-2026-09-27/');
const SRC = join(VIS, 'entrega-rendio-auxiliar/fuente/');
const read = p => readFileSync(p, 'utf8');
const ROOT = '#auxiliar-ui.rx-phone';

let ok = 0, bad = 0;
const t = (n, c, d = '') => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d ? ' → ' + d : '')); } };

// ── lector de CSS (el mismo criterio que el script) ─────────────────────────────
const strip = css => css.replace(/\/\*[\s\S]*?\*\//g, '');
function blocks(css) {
  const res = []; let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i); if (open < 0) break;
    const prelude = css.slice(i, open).trim();
    let depth = 1, k = open + 1;
    while (k < css.length && depth) { if (css[k] === '{') depth++; else if (css[k] === '}') depth--; k++; }
    res.push({ prelude, body: css.slice(open + 1, k - 1) }); i = k;
  }
  return res;
}
function splitTop(s, sep) {
  const out = []; let d = 0, cur = '';
  for (const c of s) { if (c === '(' || c === '[') d++; if (c === ')' || c === ']') d--; if (c === sep && !d) { out.push(cur); cur = ''; } else cur += c; }
  out.push(cur); return out.map(x => x.trim()).filter(Boolean);
}
const nd = d => d.replace(/\s+/g, ' ').replace(/^([\w-]+)\s*:\s*/, '$1:').trim();
function rules(css) {
  const out = [], kf = new Map();
  (function walk(list, media) {
    for (const { prelude, body } of list) {
      if (/^@(-webkit-)?keyframes/.test(prelude)) { const n = prelude.split(/\s+/)[1]; if (!kf.has(n)) kf.set(n, []); kf.get(n).push(body.replace(/\s+/g, ' ').trim()); }
      else if (/^@media/.test(prelude)) walk(blocks(body), prelude);
      else if (!prelude.startsWith('@')) out.push({ sels: splitTop(prelude, ','), decls: splitTop(body, ';').map(nd), media });
    }
  })(blocks(strip(css)), null);
  return { rules: out, kf };
}
function scope(s) {
  s = s.replace(/\s+/g, ' ').trim();
  if (s === ':root') return ROOT;
  if (s.startsWith('[data-ax-night')) return ROOT + s;
  if (s.startsWith('.rx-phone')) return ROOT + s.slice(9);
  return ROOT + ' ' + s;
}

// ── 1. el script ───────────────────────────────────────────────────────────────
console.log('\n── 1. _portar-css-rediseno-aux.mjs --check ──');
let checkOut = '';
try { checkOut = execFileSync(process.execPath, [join(here, '_portar-css-rediseno-aux.mjs'), '--check'], { encoding: 'utf8' }); t('--check en verde (sin deriva, verificación interna OK)', true); }
catch (e) { t('--check en verde', false, (e.stdout || '') + (e.stderr || '')); }
t('reporta 52 nombres de keyframes idénticos', /52 nombres de keyframes/.test(checkOut), checkOut.split('\n')[1]);
t('reporta 153 declaraciones de movimiento idénticas', /153 declaraciones animation\/transition idénticas/.test(checkOut));

const port = read(APP + 'rx-auxiliar.css'), appCss = read(APP + 'rx-aux-app.css');
const P = rules(port), A = rules(appCss);

// ── 2. las tablas de ANIMACIONES ───────────────────────────────────────────────
console.log('\n── 2. ANIMACIONES-2026-09-27.md fila por fila ──');
const md = read(VIS + 'ANIMACIONES-2026-09-27.md');
const sec = (a, b) => md.slice(md.indexOf(a), b ? md.indexOf(b) : undefined);
const cells = line => line.split(/(?<!\\)\|/).slice(1, -1).map(c => c.trim().replace(/^`|`$/g, '').replace(/\\\|/g, '|'));
const kfRows = sec('## 1. Keyframes', '## 2.').split('\n').filter(l => /^\| `/.test(l)).map(cells);
const kfNames = new Set(kfRows.map(r => r[0]));
t('la tabla 1 trae 52 nombres', kfNames.size === 52, kfNames.size);
let kfBad = [];
for (const [name, file, def] of kfRows) {
  const want = def.replace(/\s+/g, ' ').trim();
  const got = (P.kf.get(name) || []).map(x => x.replace(/\s+/g, ''));
  if (!got.includes(want.replace(/\s+/g, ''))) kfBad.push(`${name} (${file})`);
}
t('cada keyframe de la tabla 1 está en rx-auxiliar.css con el mismo texto', !kfBad.length, kfBad.join(', '));
t('y no hay keyframes de más', [...P.kf.keys()].every(n => kfNames.has(n)), [...P.kf.keys()].filter(n => !kfNames.has(n)).join(','));
t('cb2Ring (definido 2 veces) sale 2 veces y en el orden del diseño', (P.kf.get('cb2Ring') || []).length === 2);

const DROPPED = { 'admin-tokens.css|.a-aux-card': 'admin-tokens.css no se porta (sus --a-* pisan el nocturno)', 'tokens.css|.r-icon-btn': 'solo cobro-aux.jsx v1', 'tokens.css|.r-row': 'solo cobro-aux.jsx v1' };
const motionRows = [...sec('## 2. Dónde se usa', '## 3.').split('\n'), ...sec('## 3. Transiciones', '## 4.').split('\n')].filter(l => /^\| [\w-]+\.css \|/.test(l)).map(cells);
t('las tablas 2 y 3 traen 97 + 57 filas', motionRows.length === 154, motionRows.length);
const miss = [], dropped = [];
for (const [file, sel, decl] of motionRows) {
  if (DROPPED[`${file}|${sel}`]) { dropped.push(sel); continue; }
  const want = splitTop(sel, ',').map(scope).sort().join(',');
  const ds = splitTop(decl, ';').map(nd);
  const hit = P.rules.some(r => !r.media && r.sels.map(s => s.replace(/\s+/g, ' ')).sort().join(',') === want && ds.every(d => r.decls.includes(d)));
  if (!hit) miss.push(`${file} ${sel} {${decl}}`);
}
t('cada fila de animación/transición está portada con su selector y su valor exactos', !miss.length, miss.slice(0, 5).join(' | '));
t('solo 3 filas se descartan, las previstas', dropped.length === 3, dropped.join(','));

// ── 3. alcance ─────────────────────────────────────────────────────────────────
console.log('\n── 3. Alcance: nada fuera de #auxiliar-ui.rx-phone ──');
const SCOPED = /^(#auxiliar-ui\.rx-phone|:where\(#auxiliar-ui\)\.rx-phone|:where\(#auxiliar-ui\.rx-phone[ .)])/;
const allSels = f => f.rules.flatMap(r => r.sels);
const unscoped = [...allSels(P), ...allSels(A)].filter(s => !SCOPED.test(s));
t('ningún selector de rx-auxiliar.css ni de rx-aux-app.css sin #auxiliar-ui.rx-phone', !unscoped.length, unscoped.slice(0, 5).join(' | '));
t('rx-auxiliar.css sin :root ni [data-theme', !/:root|\[data-theme/.test(strip(port)));
t('rx-auxiliar.css no define ninguna --a-* (admin-tokens fuera)', !P.rules.some(r => r.decls.some(d => /^--a-/.test(d))));
t('sin el marco del teléfono falso (.rx-wrap/.rx-notch/.rx-sb/.rx-demo panel)', !/\.rx-(wrap|notch|sb)\b|\.rx-demo(?!-push)\b|\.cb-phone/.test(strip(port)));
t('.rx-demo-push (la notificación de ejemplo) sí está', /\.rx-demo-push\{/.test(port));
const rootRule = P.rules.find(r => r.sels.length === 1 && r.sels[0] === ROOT && r.decls.some(d => d.startsWith('overflow')));
t('.rx-phone sin width/height/border-radius/box-shadow/flex-shrink', rootRule && !rootRule.decls.some(d => /^(width|height|border-radius|box-shadow|flex-shrink):/.test(d)), rootRule && rootRule.decls.join(';'));
t('cobro-aux2.css portado (Pagos entra al alcance)', /#auxiliar-ui\.rx-phone \.cb2-status\{/.test(port) && /#auxiliar-ui\.rx-phone \.cb2-confetti i\{/.test(port));
t('.r-btn*, .r-stepper, .r-bottom, .r-card, .r-chip del cobro, y nada más de tokens', ['.r-btn{', '.r-btn-primary{', '.r-stepper .seg{', '.r-bottom{', '.r-card{', '.r-chip{'].every(x => port.includes(ROOT + ' ' + x)) && !/\.r-(screen|header|body|icon-btn|row)\b/.test(port));
t('nocturno del diseño en #auxiliar-ui.rx-phone[data-ax-night="on"]', port.includes(ROOT + '[data-ax-night="on"]{--r-bg:'));
t('puente --a-* por referencia en rx-aux-app.css', /#auxiliar-ui\.rx-phone\{\s*--a-bg:var\(--r-bg\)/.test(appCss) && /--a-err-soft:var\(--r-error-soft\)/.test(appCss));
t('zonas seguras con env(safe-area-inset-*)', /--rx-top:env\(safe-area-inset-top,0px\)/.test(appCss) && /\.rx-tabs\{ height:calc\(64px \+ var\(--rx-bot\)\)/.test(appCss));
t('reduced-motion presente (la única adición permitida)', /@media \(prefers-reduced-motion: reduce\)/.test(appCss));
const gen = appCss.slice(appCss.indexOf('/* BEGIN noanim'), appCss.indexOf('/* END noanim'));
const infSels = new Set(P.rules.filter(r => r.decls.some(d => /^animation:.*\binfinite\b/.test(d))).flatMap(r => r.sels.map(x => x.slice(ROOT.length + 1))));
const noanimRules = A.rules.filter(r => !r.media && r.decls.join(';') === 'animation:none' && r.sels.some(x => x.includes('.rx-noanim')));
const killsInf = noanimRules.flatMap(r => r.sels).filter(x => [...infSels].some(i => x === `${ROOT} .rx-noanim ${i}`));
t(`.rx-noanim no apaga ninguna de las ${infSels.size} infinitas (punto «En vivo», typing, brillo del pase)`, infSels.size > 20 && !killsInf.length && ['.rx-live-tag i', '.rx-bub.typing i', '.rx-pass::after'].every(i => infSels.has(i)), killsInf.join(' | '));
t('.rx-noanim apaga las de una vez (.rx-tabview, .rx-in, .rx-trip-big, .rx-meet-c b)', ['.rx-noanim .rx-tabview,', '.rx-noanim .rx-in,', '.rx-noanim .rx-trip-big,', '.rx-noanim .rx-meet-c b,'].every(x => gen.includes(ROOT + ' ' + x)));
t('las salidas (.out) se restauran con el valor del diseño', gen.includes(`${ROOT} .rx-noanim .rx-layer.out,\n${ROOT} .rx-layer.out.rx-noanim{animation:rxOut .27s ease forwards}`));
t('.rx-anim devuelve la entrada copiada tal cual (ej. .rx-step-ctl b)', gen.includes(`${ROOT} .rx-step-ctl b.rx-anim{animation:rxPop .25s ease}`));

// En index.html (sin rx-phone), ningún selector toca nada.
const pageDom = new JSDOM(read(APP + 'index.html'));
const pdoc = pageDom.window.document;
let hits = [], unparsable = [];
for (const s of [...allSels(P), ...allSels(A)]) {
  try { if (pdoc.querySelectorAll(s).length) hits.push(s); } catch (e) { unparsable.push(s); }
}
t('en index.html sin rx-phone: 0 elementos tocados por el CSS nuevo', !hits.length, hits.slice(0, 3).join(' | '));
console.log(`    (${unparsable.length} selectores que jsdom no sabe evaluar —los :where(:not(…)) de la base del documento—; se revisan en el navegador)`);
pdoc.getElementById('auxiliar-ui').classList.add('rx-phone');
t('con rx-phone el mismo árbol vacío sigue sin tocar al conductor/admin', allSels(P).every(s => { try { return [...pdoc.querySelectorAll(s)].every(el => el.closest('#auxiliar-ui')); } catch (e) { return true; } }));

// ── 4 y 5. aux-rx-ui.js en jsdom ─────────────────────────────────────────────────
console.log('\n── 4. Sprite de íconos ──');
const dom = new JSDOM('<!doctype html><html><body><div id="auxiliar-ui"></div></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom; const document = window.document;
let rafQ = [], fakeNow = 0;
window.performance.now = () => fakeNow;
window.requestAnimationFrame = f => { rafQ.push(f); return rafQ.length; };
window.cancelAnimationFrame = id => { rafQ[id - 1] = null; };
const tick = ms => { fakeNow = ms; const q = rafQ; rafQ = []; q.forEach(f => f && f(ms)); };
let reducedPref = false;
window.matchMedia = q => ({ matches: /reduce/.test(q) ? reducedPref : false, addEventListener() {}, removeEventListener() {} });
const before = new Set(Object.keys(window));
const uiSrc = read(APP + 'aux-rx-ui.js');
window.eval(uiSrc);
const added = Object.keys(window).filter(k => !before.has(k));
t('el archivo solo define window.AuxRxUI', added.length === 1 && added[0] === 'AuxRxUI', added.join(','));
const U = window.AuxRxUI;
const CONTRACT = ['ic', 'logo', 'esc', 'initials', 'hm', 'dayLabel', 'btn', 'head', 'seg', 'toggle', 'row', 'av', 'check', 'confetti', 'stepCtl', 'sheet', 'countUp'];
t('contrato completo (plan §5 P1)', CONTRACT.every(k => typeof U[k] === 'function'), CONTRACT.filter(k => typeof U[k] !== 'function').join(','));

// Íconos leídos de las fuentes (sin lista fija).
const norm = s => s.replace(/\s*\/>/g, '/>').replace(/>\s+</g, '><').trim().replace(/<(\w+)([^>]*?)\/>/g, '<$1$2></$1>');
const icons = read(SRC + 'icons.jsx'), core = read(SRC + 'rx-core.jsx');
const ICON = {}; for (const m of icons.matchAll(/^\s*(\w+):\s*\(p\)\s*=>\s*<_Icon \{\.\.\.p\}>([\s\S]*?)<\/_Icon>,?\s*$/gm)) ICON[m[1]] = norm(m[2]);
const rxBlock = core.slice(core.indexOf('const RXI = {'), core.indexOf('};', core.indexOf('const RXI = {')));
const RXI = {}; for (const m of rxBlock.matchAll(/^\s*(\w+):\s*(<>([\s\S]*?)<\/>|(<[a-z]+[^>]*\/>))\s*,?\s*$/gm)) RXI[m[1]] = norm(m[3] !== undefined ? m[3] : m[4]);
const SRCICONS = { ...ICON, ...RXI };
t(`fuentes leídas: ICON ${Object.keys(ICON).length} + RXI ${Object.keys(RXI).length} = ${Object.keys(SRCICONS).length} nombres (X repetido)`, Object.keys(ICON).length === 40 && Object.keys(RXI).length === 17 && Object.keys(SRCICONS).length === 56);
const sprite = document.getElementById('rx-sprite');
t('sprite #rx-sprite inyectado una vez, oculto', sprite && document.querySelectorAll('#rx-sprite').length === 1 && /display:\s*none/.test(sprite.getAttribute('style') || ''));
const symBad = [];
for (const [n, inner] of Object.entries(SRCICONS)) {
  const s = sprite && sprite.querySelector(`symbol[id="rx-${n}"]`);
  if (!s || s.getAttribute('viewBox') !== '0 0 24 24' || norm(s.innerHTML) !== inner) symBad.push(n);
}
t('cada símbolo existe con viewBox 0 0 24 24 y los trazos IDÉNTICOS a la fuente', !symBad.length, symBad.join(','));
t('el sprite no trae símbolos de más', sprite && sprite.querySelectorAll('symbol').length === 56);
t('ningún trazo trae fill propio (las estrellas se rellenan desde el svg)', sprite && !sprite.innerHTML.includes('fill='));
const usedSrc = ['rx-app.jsx', 'rx-book.jsx', 'rx-core.jsx', 'rx-home.jsx', 'rx-me.jsx', 'rx-onboard.jsx', 'rx-trip.jsx', 'cobro-aux2-shell.jsx', 'cobro-aux2-pay.jsx'].map(f => read(SRC + f)).join('\n');
const used = new Set();
for (const re of [/\bn="(\w+)"/g, /\bicon="(\w+)"/g, /\bicon: '(\w+)'/g, /\bic: '(\w+)'/g, /I2\('(\w+)'/g, /\[\s*'\w+',\s*'[^']+',\s*'([A-Z]\w+)'\s*\]/g]) for (const m of usedSrc.matchAll(re)) used.add(m[1]);
const missingUsed = [...used].filter(n => !SRCICONS[n]);
t(`cada ícono usado en rx-*.jsx y cobro-aux2*.jsx (${used.size}) tiene símbolo`, used.size > 30 && [...used].every(n => U.ICONS.includes(n)), [...used].filter(n => !U.ICONS.includes(n)).join(',') + (missingUsed.length ? ' (no están ni en el diseño: ' + missingUsed + ')' : ''));
const icHtml = U.ic('Plane', 22, 'extra', 'color:red');
t('ic() → <svg class="rx-ic lucide …"> con <use href="#rx-Plane">, atributos del diseño', /^<svg class="rx-ic lucide extra" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/.test(icHtml) && icHtml.includes('<use href="#rx-Plane"></use>') && icHtml.includes('style="color:red"'));
t('ic() con nombre desconocido → vacío (como el diseño: null)', U.ic('NoExiste') === '');
t('ic() por defecto 20 px', /width="20" height="20"/.test(U.ic('Home')));

console.log('\n── 5. Primitivas ──');
const frag = h => { const d = document.createElement('div'); d.innerHTML = h; return d.firstElementChild; };
let el = frag(U.btn('Pedir <ya>', { icon: 'Plus', attrs: { 'data-ax': 'new' } }));
t('btn: rx-btn pri, ícono 19 px primero, texto escapado, acción', el.className === 'rx-btn pri' && el.firstElementChild.getAttribute('width') === '19' && el.textContent === 'Pedir <ya>' && el.getAttribute('data-ax') === 'new');
el = frag(U.btn('X', { kind: 'ghost', disabled: true }));
t('btn: tipo y disabled', el.className === 'rx-btn ghost' && el.disabled);
el = frag(U.head({ title: 'Tus viajes', eyebrow: 'Hoy' }));
t('head: rx-head › rx-head-row › [rx-ib Volver data-rx=rx-pop][rx-head-c span+b][rx-head-r]', el.className === 'rx-head' && el.querySelector('.rx-head-row > button.rx-ib[data-rx="rx-pop"][aria-label="Volver"] svg use[href="#rx-ChevronLeft"]') && el.querySelector('.rx-head-c span').textContent === 'Hoy' && el.querySelector('.rx-head-c b').textContent === 'Tus viajes' && el.querySelector('.rx-head-r'));
el = frag(U.head({ title: 'Perfil', large: true, sub: 'Sub', back: false }));
t('head large: sin rx-head-c, con rx-head-lg h1 + p, sin volver', el.className === 'rx-head lg' && !el.querySelector('.rx-head-c') && el.querySelector('.rx-head-lg h1').textContent === 'Perfil' && el.querySelector('.rx-head-lg p') && !el.querySelector('.rx-ib'));
el = frag(U.head({ title: 'T', back: { 'data-ax': 'home' } }));
t('head: el volver puede llevar otra acción', el.querySelector('.rx-ib[data-ax="home"]') && !el.querySelector('[data-rx="rx-pop"]'));
el = frag(U.seg('past', [['next', 'Próximos'], ['past', 'Historial']], { name: 'viajes' }));
t('seg: --n, indicador en translateX(100%), .on en la elegida, acciones', el.getAttribute('style') === '--n:2' && el.querySelector('.rx-seg-ind').style.transform === 'translateX(100%)' && el.querySelector('button.on').getAttribute('data-v') === 'past' && el.querySelector('button[data-rx="seg"][data-seg="viajes"][data-v="next"]'));
document.body.appendChild(el);
const indNode = el.querySelector('.rx-seg-ind');
t('segSet mueve el indicador SIN recrearlo (para que corra su transición de .35 s)', U.segSet(el, 'next') && el.querySelector('.rx-seg-ind') === indNode && indNode.style.transform === 'translateX(0%)' && el.querySelector('button.on').getAttribute('data-v') === 'next');
el = frag(U.toggle(true, { 'data-ax': 'toggle', 'data-k': 'quietRide' }));
t('toggle: rx-tg on, aria-pressed, <i>', el.className === 'rx-tg on' && el.getAttribute('aria-pressed') === 'true' && el.querySelector('i') && el.getAttribute('data-k') === 'quietRide');
U.toggleSet(el, false);
t('toggleSet apaga sin repintar', el.className === 'rx-tg' && el.getAttribute('aria-pressed') === 'false');
el = frag(U.row({ icon: 'Home', tone: 'a2h', title: 'Mi residencia', sub: 'Olivar', attrs: { 'data-rx': 'open-residence' } }));
t('row: rx-row › rx-row-ic.t-a2h + rx-row-tx(b+span) + chevron 18 en --r-text-3', el.tagName === 'BUTTON' && el.querySelector('.rx-row-ic.t-a2h svg') && el.querySelector('.rx-row-tx b').textContent === 'Mi residencia' && el.querySelector('.rx-row-tx span').textContent === 'Olivar' && /ChevronRight/.test(el.lastElementChild.innerHTML) && /--r-text-3/.test(el.lastElementChild.getAttribute('style')));
el = frag(U.row({ title: 'Sin chevron', chevron: false, tag: 'div', cls: 'static' }));
t('row estático (div.rx-row.static) sin chevron ni ícono', el.tagName === 'DIV' && el.className === 'rx-row static' && !el.querySelector('svg'));
el = frag(U.row({ icon: 'X', title: 'Sin tono' }));
t('row sin tono → t-n (como el diseño)', !!el.querySelector('.rx-row-ic.t-n'));
t('av: rx-av md con iniciales', frag(U.av('LG')).outerHTML === '<span class="rx-av md">LG</span>');
el = frag(U.av('CM', 'lg', null, { src: 'https://x/y.jpg?a=1&b=2' }));
t('av con foto: .has-img, img sin alt, las iniciales quedan debajo', el.className === 'rx-av lg has-img' && el.querySelector('img').getAttribute('src') === 'https://x/y.jpg?a=1&b=2' && el.textContent === 'CM');
t('check: igual a RxCheck', U.check() === '<div class="rx-check t-ok" style="width:92px;height:92px"><svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="24"></circle><polyline points="15 27 23 35 38 18"></polyline></svg></div>');
el = frag(U.confetti());
const cf = el.querySelectorAll('i');
t('confetti: 26 piezas, pieza 1 = left 37% · 60ms · --r 53deg · --c #10B981 (RxConfetti)', el.className === 'rx-confetti' && cf.length === 26 && cf[1].getAttribute('style') === 'left:37%;animation-delay:60ms;--r:53deg;--c:#10B981' && cf[8].getAttribute('style').includes('animation-delay:0ms'));
el = frag(U.confetti(22, ['#F26522', '#10B981', '#F59E0B', '#3B82F6'], { cls: 'cb2-confetti', mod: 7, step: 70 }));
t('confetti del cobro: 22 piezas, (i % 7) × 70 ms, 4 colores (Cb2Party)', el.className === 'cb2-confetti' && el.children.length === 22 && el.children[6].getAttribute('style').includes('animation-delay:420ms') && el.children[7].getAttribute('style').includes('animation-delay:0ms') && el.children[4].getAttribute('style').endsWith('--c:#F26522'));
el = frag(U.stepCtl(1));
t('stepCtl: − b + con data-rx bags-dec/bags-inc e íconos 16 px', el.className === 'rx-step-ctl' && el.querySelector('button[data-rx="bags-dec"] use[href="#rx-Minus"]') && el.querySelector('b').textContent === '1' && el.querySelector('button[data-rx="bags-inc"] svg[width="16"]'));
document.body.appendChild(el);
const oldB = el.querySelector('b');
U.stepCtlSet(el.querySelector('button'), 2);
t('stepCtlSet RECREA el número (key={f.bags}) y le pone .rx-anim', el.querySelector('b') !== oldB && el.querySelector('b').textContent === '2' && el.querySelector('b').className === 'rx-anim');
const big = frag('<div class="rx-trip-big"><b>04:10</b></div>'); document.body.appendChild(big);
const nb = U.remount(big, '<b>Llegó</b>');
t('remount: nodo nuevo en el mismo lugar, con .rx-anim y el contenido nuevo', nb !== big && !big.parentNode && nb.className === 'rx-trip-big rx-anim' && nb.textContent === 'Llegó' && nb.parentNode === document.body);

// Hoja: tocar adentro no cierra; tocar el fondo → .out y fuera a los 220 ms.
const host = document.createElement('div'); document.body.appendChild(host);
let closed = 0;
const sh = U.sheetOpen(host, '<div class="rx-sh"><h3>Hola</h3></div>', { tall: true, onClose: () => closed++ });
t('sheet: rx-sheet-bg › rx-sheet.tall › rx-grab + contenido', host.querySelector('.rx-sheet-bg > .rx-sheet.tall > .rx-grab + .rx-sh h3'));
host.querySelector('.rx-sh').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
t('tocar DENTRO de la hoja no la cierra', !sh.el.classList.contains('out'));
sh.el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
t('tocar el fondo: .out de inmediato', sh.el.classList.contains('out') && !!sh.el.parentNode);
await new Promise(r => setTimeout(r, 150));
t('a los 150 ms sigue (la animación de salida dura 220 ms)', !!sh.el.parentNode && closed === 0);
await new Promise(r => setTimeout(r, 120));
t('a los 270 ms ya no está y avisó (onClose)', !sh.el.parentNode && closed === 1);
t('sheetClose dos veces no duplica', U.sheetClose(sh.el) === false);

// Contadores.
const c1 = document.createElement('b');
fakeNow = 1000; U.countUp(c1, 48);
t('countUp (RxCount): arranca en 0', c1.textContent === '0');
tick(1400); t('a 400 de 800 ms: 48·(1−0,5³) = 42', c1.textContent === '42', c1.textContent);
tick(1800); t('a 800 ms: 48', c1.textContent === '48');
t('y no pide más cuadros', rafQ.length === 0);
const c2 = document.createElement('b');
const money = n => '$' + Math.round(n);
U.countUp(c2, 100, { ms: 700, from: 'prev', fmt: money });
t('useCountUp: la primera vez pone el valor sin animar', c2.textContent === '$100' && rafQ.length === 0);
fakeNow = 5000; U.countUp(c2, 200, { ms: 700, from: 'prev', fmt: money });
tick(5350); t('después anima desde el anterior: a 350 de 700 ms → 100 + 100·0,875 = 188', c2.textContent === '$188', c2.textContent);
U.countUp(c2, 300, { ms: 700, from: 'prev', fmt: money });
t('interrumpido a mitad: el siguiente sale del último valor al que LLEGÓ (100), como useCountUp', c2.textContent === '$100', c2.textContent);
tick(99999);
reducedPref = true;
const c3 = document.createElement('b'); U.countUp(c3, 77);
t('con prefers-reduced-motion el contador pone el valor final de una', c3.textContent === '77' && rafQ.length === 0);
reducedPref = false;

// Días y horas en Bogotá.
const NOW = new Date('2026-10-13T15:00:00Z'); // mar 13-oct-2026, 10:00 en Bogotá
t('dayLabel hoy → «Hoy · mar 13 oct»', U.dayLabel('2026-10-13', NOW) === 'Hoy · mar 13 oct', U.dayLabel('2026-10-13', NOW));
t('dayLabel mañana → «Mañana · mié 14 oct»', U.dayLabel('2026-10-14', NOW) === 'Mañana · mié 14 oct', U.dayLabel('2026-10-14', NOW));
t('dayLabel otro día → «Jue 15 oct»', U.dayLabel('2026-10-15', NOW) === 'Jue 15 oct', U.dayLabel('2026-10-15', NOW));
t('traslado a las 20:30 de Bogotá (01:30Z del día siguiente) cae HOY, no mañana', U.dayLabel('2026-10-14T01:30:00Z', NOW) === 'Hoy · mar 13 oct' && U.hm('2026-10-14T01:30:00Z') === '20:30');
t('a las 22:00 de Bogotá (03:00Z) «hoy» sigue siendo el 13', U.dayLabel('2026-10-13', new Date('2026-10-14T03:00:00Z')) === 'Hoy · mar 13 oct');
t('hm: «4:05» → «04:05», medianoche → «00:00», sin dato → vacío', U.hm('4:05') === '04:05' && U.hm('2026-10-15T05:00:00Z') === '00:00' && U.hm(null) === '' && U.hm('basura') === '');
t('dayLabel sin dato → vacío (nada inventado)', U.dayLabel(null) === '' && U.dayLabel('') === '');
t('cruce de año: 31-dic → «Mañana · vie 1 ene»', U.dayLabel('2027-01-01', new Date('2026-12-31T17:00:00Z')) === 'Mañana · vie 1 ene');
// Sin Intl (desfase fijo UTC−5) da lo mismo.
const dom2 = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
dom2.window.eval('Intl = undefined;');
dom2.window.eval(uiSrc);
const U2 = dom2.window.AuxRxUI;
t('sin Intl (desfase fijo UTC−5) da lo mismo', U2.hm('2026-10-14T01:30:00Z') === '20:30' && U2.dayLabel('2026-10-14T01:30:00Z', NOW) === 'Hoy · mar 13 oct');

t('initials: «Laura Gómez» → LG, «ana» → A, vacío → A', U.initials('Laura Gómez') === 'LG' && U.initials('ana') === 'A' && U.initials('') === 'A' && U.initials('  María  del Pilar Ruiz ') === 'MR');
t('esc escapa & < > " \'', U.esc(`<a href="x" onclick='y'>&`) === '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;');
el = frag(U.logo({ height: 34, tone: 'light', tagline: true }));
t('logo: RendioLogo con los números de React (px sin redondear) y tono claro', el.style.gap === (34 * 0.4) + 'px' && el.querySelector('span > span').style.width === (34 * 0.22) + 'px' && /Rendio/.test(el.textContent) && /Crew Route/.test(el.textContent) && el.querySelector('span > span + span').style.color.replace(/\s/g, '') === 'rgb(255,255,255)');
const lf = U.lfIcon('car');
t('lfIcon: opciones de L.divIcon con className rx-lf-*, centrado', lf.className === 'rx-lf-car' && lf.iconSize[0] === 38 && lf.iconAnchor[0] === 19 && /car-halo/.test(lf.html) && U.lfIcon('pin').className === 'rx-lf-pin' && U.lfIcon('apt').className === 'rx-lf-apt' && U.lfIcon('x') === null);
t('las clases rx-lf-* tienen estilos (con halo rxHalo 2 s / 1,6 s del diseño)', /\.rx-lf-pin \.pin-halo\{[^}]*animation:rxHalo 2s ease-out infinite/.test(appCss) && /\.rx-lf-car \.car-halo\{[^}]*animation:rxHalo 1\.6s ease-out infinite/.test(appCss));

// Nada inventado en el archivo.
const FORBIDDEN = [/\$\s?\d/, /150\.000/, /Carlos Mejía/, /AV9525/, /Juliana/, /Plan B/, /24\/7/, /en línea/i, /Último cupo/, /Siempre hay cupo/, /\bkit\b/i, /Preparado/, /Laura/];
const codeOnly = uiSrc.replace(/^\s*\/\/.*$/gm, '');
t('aux-rx-ui.js no trae textos prohibidos ni datos del prototipo', !FORBIDDEN.some(re => re.test(codeOnly)), FORBIDDEN.filter(re => re.test(codeOnly)).join(' '));

// _nombres-repetidos en cero.
console.log('\n── nombres globales ──');
try { const o = execFileSync(process.execPath, [join(here, '_nombres-repetidos.mjs')], { encoding: 'utf8' }); t('_nombres-repetidos en 0', !/✗|repetid[oa]s?:\s*[1-9]/.test(o) , o.trim().split('\n').slice(-2).join(' ')); }
catch (e) { t('_nombres-repetidos en 0', false, (e.stdout || '') + (e.stderr || '')); }

console.log(`\n${ok} ✓  ${bad} ✗`);
process.exit(bad ? 1 : 0);
