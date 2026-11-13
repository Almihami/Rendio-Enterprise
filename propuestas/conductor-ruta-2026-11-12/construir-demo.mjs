// Arma demo.html (un solo archivo, abre en cualquier navegador) a partir de las
// dos demos del lienzo: lienzo/Main.dc.html (Opción A) y lienzo/RutaCompleta.dc.html
// (Opción B). No cambia el diseño: copia la plantilla y la lógica tal cual y les
// pone un intérprete mínimo de la sintaxis del lienzo ({{ }}, sc-if, sc-for, onClick).
//
//   node construir-demo.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
function partes(archivo) {
  const src = readFileSync(join(AQUI, 'lienzo', archivo), 'utf8');
  const plantilla = /<x-dc>([\s\S]*?)<\/x-dc>/.exec(src)[1].replace(/<helmet>[\s\S]*?<\/helmet>/, '').trim();
  const logica = /<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/.exec(src)[1].trim();
  return { plantilla, logica };
}
const A = partes('Main.dc.html');
const B = partes('RutaCompleta.dc.html');

const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rendio · Ruta del conductor: dos propuestas</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#EFEFEB;--tx:#18181B;--tx2:#52525B;--card:#FFFFFF;--bd:#DCDCD6;--ac:#B4461A}
@media (prefers-color-scheme:dark){:root{--bg:#121211;--tx:#F4F4F5;--tx2:#A1A1AA;--card:#1C1C1B;--bd:#2E2E2B;--ac:#FF8A4C}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Inter",system-ui,sans-serif}
header{max-width:1000px;margin:0 auto;padding:28px 16px 8px}
h1{margin:0 0 6px;font-size:24px;letter-spacing:-.5px}
header p{margin:0;color:var(--tx2);max-width:70ch}
main{max-width:1000px;margin:0 auto;padding:16px;display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:28px;justify-items:center}
section{display:flex;flex-direction:column;gap:12px;align-items:center;width:100%}
.cab{width:100%;max-width:390px}
.cab h2{margin:0;font-size:18px;letter-spacing:-.3px}
.cab p{margin:4px 0 0;color:var(--tx2);font-size:14px}
.marco{width:390px;height:844px;border-radius:40px;overflow:hidden;box-shadow:0 30px 60px -30px rgba(0,0,0,.45),0 0 0 1px var(--bd);background:#F8F8F6;transform-origin:top center;position:relative}
.caja{height:844px}
.barra{display:flex;gap:8px;align-items:center;width:100%;max-width:390px}
.barra button{height:40px;padding:0 14px;border-radius:10px;border:1px solid var(--bd);background:var(--card);color:var(--tx);font:inherit;font-weight:600;cursor:pointer}
.barra span{color:var(--tx2);font-size:13px}
footer{max-width:1000px;margin:0 auto;padding:8px 16px 40px;color:var(--tx2);font-size:13.5px}
@media (max-width:430px){.marco{transform:scale(.86)}.caja{height:730px}}
</style>
</head>
<body>
<header>
<h1>Ruta del conductor: dos propuestas</h1>
<p>Demos navegables con datos de ejemplo. Toca los botones naranjas para avanzar por un traslado de salida completo. Ningún botón cambia lo que hoy hace la app: solo cambia cómo se presenta.</p>
</header>
<main>
<section>
<div class="cab"><h2>Opción A · Por bloques de traslado</h2><p>El día es la lista de traslados; el bloque en curso se abre ahí mismo.</p></div>
<div class="caja"><div class="marco" id="demo-a"></div></div>
<div class="barra"><button type="button" data-reiniciar="a">Reiniciar</button><span>Paso <b id="paso-a">0</b> de 6</span></div>
</section>
<section>
<div class="cab"><h2>Opción B · Ruta completa, un paso a la vez</h2><p>Modo enfocado: mapa arriba, una instrucción y un botón grande.</p></div>
<div class="caja"><div class="marco" id="demo-b"></div></div>
<div class="barra"><button type="button" data-reiniciar="b">Reiniciar</button><span>Paso <b id="paso-b">0</b> de 6</span></div>
</section>
</main>
<footer>Propuesta del 12-nov-2026. Fuentes en <code>lienzo/</code>; este archivo lo genera <code>construir-demo.mjs</code>.</footer>

<template id="tpl-a">
${A.plantilla}
</template>
<template id="tpl-b">
${B.plantilla}
</template>

<script>
// ── Intérprete mínimo de la sintaxis del lienzo ─────────────────────────────
class DCLogic {}
function buscar(ambito, ruta) {
  ruta = ruta.trim();
  if (ruta === 'true') return true;
  if (ruta === 'false') return false;
  if (/^-?\\d+(\\.\\d+)?$/.test(ruta)) return Number(ruta);
  const p = ruta.split('.');
  let a = ambito;
  while (a && !(p[0] in a.vars)) a = a.padre;
  if (!a) return undefined;
  let v = a.vars[p[0]];
  for (let i = 1; i < p.length && v != null; i++) v = v[p[i]];
  return v;
}
const HUECO = /\\{\\{\\s*([^}]+?)\\s*\\}\\}/g;
const texto = (s, ambito) => s.replace(HUECO, (_, r) => { const v = buscar(ambito, r); return v == null ? '' : String(v); });
const entero = (s) => { const m = /^\\s*\\{\\{\\s*([^}]+?)\\s*\\}\\}\\s*$/.exec(s || ''); return m ? m[1] : null; };
function armar(nodo, ambito, destino) {
  if (nodo.nodeType === 3) { destino.appendChild(document.createTextNode(texto(nodo.nodeValue, ambito))); return; }
  if (nodo.nodeType !== 1) return;
  const tag = nodo.localName;
  if (tag === 'sc-if') {
    const r = entero(nodo.getAttribute('value'));
    if (r != null && buscar(ambito, r)) nodo.childNodes.forEach((h) => armar(h, ambito, destino));
    return;
  }
  if (tag === 'sc-for') {
    const lista = buscar(ambito, entero(nodo.getAttribute('list')) || '') || [];
    const como = nodo.getAttribute('as') || 'item';
    lista.forEach((it, i) => { const sub = { vars: { [como]: it, $index: i }, padre: ambito }; nodo.childNodes.forEach((h) => armar(h, sub, destino)); });
    return;
  }
  const el = document.createElementNS(nodo.namespaceURI, tag);
  for (const a of nodo.attributes) {
    if (a.name.startsWith('hint-')) continue;
    if (/^on[a-z]+$/i.test(a.name)) {
      const r = entero(a.value); const fn = r && buscar(ambito, r);
      if (typeof fn === 'function') el.addEventListener(a.name.slice(2).toLowerCase(), fn);
      continue;
    }
    el.setAttribute(a.name, texto(a.value, ambito));
  }
  nodo.childNodes.forEach((h) => armar(h, ambito, el));
  destino.appendChild(el);
}
function montar(cajaId, tplId, Clase, pasoInicial, alPintar) {
  const caja = document.getElementById(cajaId);
  const inst = new Clase();
  inst.props = { paso: pasoInicial };
  inst.state = undefined;
  const pintar = () => {
    const vals = inst.renderVals();
    caja.textContent = '';
    document.getElementById(tplId).content.childNodes.forEach((h) => armar(h, { vars: vals, padre: null }, caja));
    alPintar(inst.state && inst.state.paso != null ? inst.state.paso : pasoInicial);
  };
  inst.setState = (p) => { inst.state = Object.assign({}, inst.state, p); pintar(); };
  pintar();
  return inst;
}

// ── Lógica de cada demo, copiada tal cual del lienzo ───────────────────────
const OpcionA = (function () {
${A.logica}
return Component;
})();
const OpcionB = (function () {
${B.logica}
return Component;
})();

const q = new URLSearchParams(location.search);
const demos = {
  a: montar('demo-a', 'tpl-a', OpcionA, Number(q.get('a')) || 0, (p) => { document.getElementById('paso-a').textContent = p; }),
  b: montar('demo-b', 'tpl-b', OpcionB, Number(q.get('b')) || 0, (p) => { document.getElementById('paso-b').textContent = p; }),
};
document.querySelectorAll('[data-reiniciar]').forEach((b) => b.addEventListener('click', () => demos[b.dataset.reiniciar].setState({ paso: 0, mini: false })));
</script>
</body>
</html>
`;
writeFileSync(join(AQUI, 'demo.html'), html);
console.log('demo.html', (html.length / 1024).toFixed(0), 'KB');
