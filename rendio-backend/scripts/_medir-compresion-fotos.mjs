// ¿Cuánto pesa cada foto después de comprimirla en el teléfono? (0096)
//
// Corre la MISMA función del inicio de turno (ShiftFlow._compressPhoto de
// rendio-turnos/shift-flow.js) dentro de Chrome sin ventana, sobre dos imágenes
// de prueba de 12 MP (4000×3000) que se generan aquí mismo y se guardan como
// JPEG de cámara (calidad 0.92, varios MB):
//   · «carro»  — una escena con cielo, asfalto, un carro, mucho detalle chico y
//                ruido de sensor, para parecerse al recorrido de inspección.
//   · «recibo» — papel blanco con renglones de texto, como un comprobante.
// y compara los dos perfiles nuevos contra el de antes (1280 px, calidad 0.8).
//
// jsdom no sirve para esto (no codifica JPEG): hace falta un navegador. Usa el
// Chrome instalado (CHROME=/ruta para otro), sin ventana.
//   cd rendio-backend/scripts && node _medir-compresion-fotos.mjs
//
// OJO con el número: una imagen generada NO es una foto real. El ruido y el
// detalle de una foto de verdad dependen de la luz y del teléfono; tomar esto
// como orden de magnitud (±50 %) y confirmarlo con fotos reales de producción
// (inspection_photos.size_bytes después de desplegar).
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME = process.env.CHROME || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find((p) => existsSync(p));
if (!CHROME) { console.error('No encontré Chrome. Pásalo con CHROME=/ruta/al/binario'); process.exit(2); }

const SF = pathToFileURL(new URL('../../rendio-turnos/shift-flow.js', import.meta.url).pathname).href;
const dir = mkdtempSync(join(tmpdir(), 'medir-fotos-'));
const html = join(dir, 'medir.html');
writeFileSync(html, `<!doctype html><meta charset="utf-8"><body>
<script src="${SF}"></script>
<script>
window.__medir = (async () => {
  try {
    const W = 4000, H = 3000;
    let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    function lienzo() { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; }
    function ruido(g, amp, y0) {
      const id = g.getImageData(0, 0, W, H), d = id.data;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4, a = amp * (y >= y0 ? 1.6 : 1);
        const n = (rnd() - 0.5) * a;
        d[i] += n; d[i + 1] += n * 0.95; d[i + 2] += n * 0.9;
      }
      g.putImageData(id, 0, 0);
    }
    function carro() {
      const c = lienzo(), g = c.getContext('2d');
      let gr = g.createLinearGradient(0, 0, 0, H * 0.45); gr.addColorStop(0, '#6f9bd1'); gr.addColorStop(1, '#dbe6ef');
      g.fillStyle = gr; g.fillRect(0, 0, W, H * 0.45);
      for (let k = 0; k < 900; k++) {            // árboles, edificios, follaje al fondo
        g.fillStyle = 'hsl(' + (90 + rnd() * 60) + ',' + (20 + rnd() * 40) + '%,' + (20 + rnd() * 35) + '%)';
        g.beginPath(); g.ellipse(rnd() * W, H * (0.3 + rnd() * 0.15), 20 + rnd() * 90, 20 + rnd() * 70, 0, 0, 7); g.fill();
      }
      gr = g.createLinearGradient(0, H * 0.45, 0, H); gr.addColorStop(0, '#6d6f72'); gr.addColorStop(1, '#3f4144');
      g.fillStyle = gr; g.fillRect(0, H * 0.45, W, H * 0.55);
      for (let k = 0; k < 14000; k++) {          // grava, manchas y líneas del parqueadero
        const v = 40 + rnd() * 120; g.fillStyle = 'rgb(' + v + ',' + v + ',' + (v + 4) + ')';
        g.fillRect(rnd() * W, H * 0.45 + rnd() * H * 0.55, 2 + rnd() * 14, 2 + rnd() * 9);
      }
      g.fillStyle = '#e8e8e2'; for (let k = 0; k < 6; k++) g.fillRect(k * 700 + 120, H * 0.9, 380, 26);
      // El carro: carrocería con brillo, vidrios, llantas, placa.
      gr = g.createLinearGradient(0, H * 0.38, 0, H * 0.8); gr.addColorStop(0, '#d9dde3'); gr.addColorStop(0.45, '#8c949e'); gr.addColorStop(1, '#4b525b');
      g.fillStyle = gr; g.beginPath(); g.roundRect(W * 0.14, H * 0.42, W * 0.72, H * 0.33, 120); g.fill();
      g.fillStyle = '#26303a'; g.beginPath(); g.roundRect(W * 0.26, H * 0.3, W * 0.48, H * 0.16, 80); g.fill();
      gr = g.createLinearGradient(W * 0.26, 0, W * 0.74, 0); gr.addColorStop(0, 'rgba(255,255,255,.05)'); gr.addColorStop(0.5, 'rgba(255,255,255,.35)'); gr.addColorStop(1, 'rgba(255,255,255,.05)');
      g.fillStyle = gr; g.fillRect(W * 0.27, H * 0.31, W * 0.46, H * 0.14);
      g.fillStyle = '#111'; [0.27, 0.73].forEach((x) => { g.beginPath(); g.arc(W * x, H * 0.76, 230, 0, 7); g.fill(); });
      g.fillStyle = '#9aa0a6'; [0.27, 0.73].forEach((x) => { g.beginPath(); g.arc(W * x, H * 0.76, 120, 0, 7); g.fill(); });
      g.fillStyle = '#f2d230'; g.fillRect(W * 0.44, H * 0.62, W * 0.12, H * 0.06);
      g.fillStyle = '#111'; g.font = 'bold 150px sans-serif'; g.fillText('RDO 481', W * 0.445, H * 0.675);
      ruido(g, 26, H * 0.45);
      return c;
    }
    function recibo() {
      const c = lienzo(), g = c.getContext('2d');
      g.fillStyle = '#8a7a66'; g.fillRect(0, 0, W, H);                       // la mesa
      g.save(); g.translate(W / 2, H / 2); g.rotate(-0.04);
      g.fillStyle = '#f7f5ef'; g.fillRect(-1300, -1450, 2600, 2900);
      g.fillStyle = '#1d1d1d';
      const lineas = ['ESTACION DE SERVICIO TERPEL', 'NIT 830.095.213-0', 'RIONEGRO - ANTIOQUIA', 'FACTURA POS 004581',
        'FECHA 2026-10-11  05:42', 'ISLA 3   MANGUERA 2', 'PRODUCTO: CORRIENTE', 'GALONES      8,412', 'PRECIO/GAL  15.890',
        'TOTAL     $ 133.667', 'PLACA RDO481', 'FORMA DE PAGO: EFECTIVO', 'GRACIAS POR SU COMPRA'];
      lineas.forEach((t, k) => { g.font = (k === 9 ? 'bold 140px' : '96px') + ' monospace'; g.fillText(t, -1200, -1250 + k * 205); });
      g.restore();
      ruido(g, 16, H);
      return c;
    }
    const comoCamara = (c) => new Promise((res) => c.toBlob((b) => res(new File([b], 'IMG_0001.jpg', { type: 'image/jpeg' })), 'image/jpeg', 0.92));
    const lado = (b) => new Promise((res) => { const i = new Image(); i.onload = () => res(Math.max(i.naturalWidth, i.naturalHeight)); i.src = URL.createObjectURL(b); });
    const F = window.ShiftFlow;
    if (!F || typeof F._compressPhoto !== 'function') throw new Error('shift-flow.js no expone _compressPhoto');
    const perfiles = { antes: { maxDim: 1280, quality: 0.8 }, rutina: F.FOTO_RUTINA, legible: F.FOTO_LEGIBLE,
      q50: { maxDim: 1280, quality: 0.5 }, q55: { maxDim: 1280, quality: 0.55 } };
    const res = { perfiles };
    for (const [nombre, fab] of [['carro', carro], ['recibo', recibo]]) {
      const original = await comoCamara(fab());
      res[nombre] = { original_kb: Math.round(original.size / 1024) };
      for (const [p, cfg] of Object.entries(perfiles)) {
        const b = await F._compressPhoto(original, cfg);
        res[nombre][p] = { kb: Math.round(b.size / 1024), lado: await lado(b), tipo: b.type };
      }
    }
    return { ok: true, res };
  } catch (e) { return { ok: false, error: String(e && e.stack || e) }; }
})();
</script>`);

// Chrome sin ventana, manejado por el protocolo de DevTools: se abre la página,
// se espera la promesa window.__medir y se lee el resultado. (Con --dump-dom no
// sirve: no espera a que termine la codificación de los JPEG.)
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--allow-file-access-from-files', '--remote-debugging-port=0', `--user-data-dir=${join(dir, 'perfil')}`,
  pathToFileURL(html).href], { stdio: 'ignore' });
let salida;
try {
  let puerto = null;
  for (let k = 0; k < 100 && !puerto; k++) {
    await new Promise((r) => setTimeout(r, 200));
    try { puerto = readFileSync(join(dir, 'perfil', 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); } catch { /* arrancando */ }
  }
  if (!puerto) throw new Error('Chrome no abrió el puerto de DevTools');
  let pagina = null;
  for (let k = 0; k < 50 && !pagina; k++) {
    const lista = await (await fetch(`http://127.0.0.1:${puerto}/json/list`)).json();
    pagina = lista.find((x) => x.type === 'page' && /medir\.html/.test(x.url));
    if (!pagina) await new Promise((r) => setTimeout(r, 200));
  }
  if (!pagina) throw new Error('No encontré la pestaña de la medición');
  const ws = new WebSocket(pagina.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const pedir = (expression) => new Promise((res) => {
    const id = Math.floor(Math.random() * 1e9);
    ws.addEventListener('message', function oir(ev) {
      const msg = JSON.parse(ev.data);
      if (msg.id === id) { ws.removeEventListener('message', oir); res(msg); }
    });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  let resp = null;
  for (let k = 0; k < 50; k++) {                 // que la página haya creado la promesa
    resp = await pedir('window.__medir ? window.__medir : null');
    if (resp.result && resp.result.result && resp.result.result.value) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  ws.close();
  salida = resp && resp.result && resp.result.result && resp.result.result.value;
} finally {
  chrome.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 300));
  rmSync(dir, { recursive: true, force: true });
}
if (!salida || !salida.ok) { console.error('La medición falló: ' + JSON.stringify(salida)); process.exit(1); }
const r = salida.res;

let ok = 0, fail = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (d != null ? ' → ' + d : '')); } };
console.log('\nImagen de prueba 12 MP (4000×3000) guardada como JPEG de cámara:');
console.log('                 original   antes (1280/0.8)   rutina (1280/0.6)   legible (1600/0.7)');
for (const k of ['carro', 'recibo']) {
  const x = r[k];
  console.log(`  ${k.padEnd(8)}   ${String(x.original_kb).padStart(6)} KB   ${String(x.antes.kb).padStart(8)} KB ${String(x.antes.lado).padStart(6)} px`
    + `   ${String(x.rutina.kb).padStart(8)} KB ${String(x.rutina.lado).padStart(6)} px   ${String(x.legible.kb).padStart(8)} KB ${String(x.legible.lado).padStart(6)} px`);
}
console.log('');
t('la foto de prueba pesa como una de cámara (> 2 MB)', r.carro.original_kb > 2048, r.carro.original_kb + ' KB');
t('rutina: lado mayor 1280 px, JPEG', r.carro.rutina.lado === 1280 && r.carro.rutina.tipo === 'image/jpeg', JSON.stringify(r.carro.rutina));
t('rutina: entre 60 y 160 KB con la imagen generada', r.carro.rutina.kb >= 60 && r.carro.rutina.kb <= 160, r.carro.rutina.kb + ' KB');
t('rutina pesa bastante menos que antes (≤ 70 %)', r.carro.rutina.kb <= r.carro.antes.kb * 0.7, `${r.carro.rutina.kb} vs ${r.carro.antes.kb} KB`);
t('legible (comprobante): lado mayor 1600 px', r.recibo.legible.lado === 1600, r.recibo.legible.lado);
t('legible tiene más resolución que antes para leer el valor (1600 > 1280)', r.recibo.legible.lado > r.recibo.antes.lado);
t('un comprobante legible no pasa de 400 KB (el bucket acepta hasta 5 MB)', r.recibo.legible.kb <= 400, r.recibo.legible.kb + ' KB');
// Calibración con producción: allá la foto promedio pesa ~280 KB con el perfil
// de antes. La imagen generada pesa menos (tiene menos detalle que una real),
// así que lo que vale es la PROPORCIÓN nuevo/antes, aplicada a esos 280 KB.
const REAL_ANTES_KB = 280;
const prop = (k) => r.carro[k].kb / r.carro.antes.kb;
console.log(`\nEstimado con fotos reales (promedio de producción ${REAL_ANTES_KB} KB a 1280/0.8):`);
for (const [k, txt] of [['rutina', `rutina ${r.perfiles.rutina.maxDim}/${r.perfiles.rutina.quality}`], ['q55', '1280/0.55 (referencia)'], ['q50', '1280/0.5 (referencia)']]) {
  console.log(`  ${txt.padEnd(24)} × ${prop(k).toFixed(2)} ≈ ${Math.round(REAL_ANTES_KB * prop(k))} KB por foto`);
}
const realRutina = Math.round(REAL_ANTES_KB * prop('rutina'));
console.log(`\nPor inicio de turno (11 fotos, estimado real): ~${11 * REAL_ANTES_KB} KB antes → ~${11 * realRutina} KB ahora`
  + ` (−${Math.round((1 - prop('rutina')) * 100)} %).`);
console.log(`\n${ok} ✓ · ${fail} ✗`);
console.log('NO cubre: fotos reales de teléfono (esto es una imagen generada; ver el OJO arriba), Safari/iOS');
console.log('(su codificador JPEG da otros tamaños) ni si un humano puede leer el comprobante.');
process.exit(fail ? 1 : 0);
