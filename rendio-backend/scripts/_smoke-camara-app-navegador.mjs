// LA CÁMARA DENTRO DE LA APP (camara-app.js), EN UN CHROME DE VERDAD.
//
// Por qué existe (24-oct-2026): en Android la cámara del teléfono (input con
// capture) a veces hacía que Android cerrara Chrome; la app se reiniciaba y la
// foto se perdía (Miguel Ángel Peña, 21 y 22-oct). camara-app.js toma la foto
// con getUserMedia sin salir de la página. Esto la maneja como la usaría el
// conductor —abrir, disparar, repetir, usar, cancelar, «atrás», luz, galería— y
// también cuando falla (sin permiso, cámara ocupada), que es lo que más importa:
// en ningún caso puede quedarse sin poder tomar la foto.
//
// Corre con la cámara FALSA de Chromium (un patrón de prueba), en un contexto
// que se presenta como Android. LO QUE ESTO NO CUBRE: un teléfono real — la
// memoria de verdad (lo que causaba el problema), la luz física, el enfoque y
// el permiso de Chrome tal como se lo pregunta al conductor. Eso solo se ve en
// el teléfono.
//
//   node scripts/_smoke-camara-app-navegador.mjs          (FOTOS=/carpeta para guardar capturas)
import { createServer } from 'http';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join, extname } from 'path';
const { chromium } = await import(new URL('../../../.e2e-tools/node_modules/playwright/index.mjs', import.meta.url).href);
const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const FOTOS = process.env.FOTOS || null;
if (FOTOS && !existsSync(FOTOS)) mkdirSync(FOTOS, { recursive: true });

let ok = 0, bad = 0;
const t = (n, c, d = '') => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d ? ' → ' + d : '')); } };

// La página de prueba usa el <head> del index real (tailwind con los colores de
// marca, las fuentes): lo que se mira es la cámara como se ve en la app.
const head = readFileSync(APP + 'index.html', 'utf8').match(/<head[\s\S]*?<\/head>/i)[0];
const PRUEBA = `<!doctype html><html lang="es">${head}<body class="bg-slate-50">
<p class="p-4">Paso de fotos (simulado)</p>
<input id="respaldo" type="file" accept="image/*" capture="environment" class="hidden">
<script src="camara-app.js"></script></body></html>`;
const TIPOS = { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };
const srv = createServer((req, res) => {
  const ruta = decodeURIComponent(req.url.split('?')[0]);
  if (ruta === '/__prueba-camara.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(PRUEBA); }
  const f = join(APP, ruta);
  if (!f.startsWith(APP) || !existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TIPOS[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(0, '127.0.0.1');
await new Promise(r => srv.once('listening', r));
const BASE = `http://127.0.0.1:${srv.address().port}`;

const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36';
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1';
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });

// Antes de cargar la página: se anotan los streams que entrega getUserMedia
// (para saber si la cámara quedó apagada) y se pueden provocar fallos.
const ESPIA = () => {
  const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  window.__streams = [];
  window.__fallar = [];          // nombres de error a devolver, uno por intento
  window.__demora = 0;           // ms que "tarda" Chrome en preguntar el permiso
  navigator.mediaDevices.getUserMedia = async (c) => {
    if (window.__demora) await new Promise(r => setTimeout(r, window.__demora));
    const err = window.__fallar.shift();
    if (err) throw new DOMException('prueba', err);
    const s = await real(c); window.__streams.push(s); return s;
  };
  if (window.__conLuz !== false) {
    const caps = MediaStreamTrack.prototype.getCapabilities;
    window.__luz = [];
    MediaStreamTrack.prototype.getCapabilities = function () { const c = caps.call(this); return window.__fingirLuz ? { ...c, torch: true } : c; };
    const ac = MediaStreamTrack.prototype.applyConstraints;
    MediaStreamTrack.prototype.applyConstraints = function (c) {
      if (c && c.advanced && 'torch' in c.advanced[0]) { window.__luz.push(c.advanced[0].torch); return Promise.resolve(); }
      return ac.call(this, c);
    };
  }
};
async function nuevaPagina(ua) {
  const ctx = await browser.newContext({ userAgent: ua, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'es-CO' });
  await ctx.grantPermissions(['camera'], { origin: BASE });
  const pg = await ctx.newPage();
  const errores = []; pg.on('pageerror', e => errores.push(e.message));
  await pg.addInitScript(ESPIA);
  await pg.goto(BASE + '/__prueba-camara.html');
  await pg.evaluate(() => { window.__clicsRespaldo = 0; document.getElementById('respaldo').click = () => { window.__clicsRespaldo++; }; });
  return { pg, ctx, errores };
}
// Abre la cámara sin esperar el resultado (el conductor todavía la está usando).
const abrir = (pg, op = {}) => pg.evaluate((op) => {
  window.__r = window.CamaraApp.tomar({ titulo: 'Llanta de repuesto', detalle: 'Su compartimiento abierto: que esté y esté sujeta',
    maxDim: 1280, quality: 0.6, respaldo: document.getElementById('respaldo'), ...op });
  window.__res = undefined;
  window.__r.then(b => { window.__res = b ? { tipo: b.type, peso: b.size } : null; });
  // Medidas reales del JPEG que se entregó.
  window.__r.then(async b => { if (b) { const i = await createImageBitmap(b); window.__dim = [i.width, i.height]; } });
}, op);
const resultado = (pg) => pg.waitForFunction(() => window.__res !== undefined, null, { timeout: 8000 }).then(() => pg.evaluate(() => window.__res));
const camarasVivas = (pg) => pg.evaluate(() => window.__streams.flatMap(s => s.getTracks()).filter(t => t.readyState === 'live').length);
const enVivo = (pg) => pg.waitForSelector('[data-cam="disparar"]:not([disabled])', { timeout: 8000 });
const foto = async (pg, nombre) => { if (FOTOS) await pg.screenshot({ path: join(FOTOS, nombre + '.png') }); };

try {
  console.log('\n── iPhone: no se toca, sigue el input de siempre ──');
  {
    const { pg, ctx } = await nuevaPagina(UA_IPHONE);
    t('en iPhone la cámara de la app NO se ofrece', await pg.evaluate(() => window.CamaraApp.disponible() === false));
    await abrir(pg);
    t('…y tomar() abre directo la cámara del teléfono', await pg.evaluate(() => window.__clicsRespaldo === 1));
    t('…sin pantalla propia', await pg.evaluate(() => !document.getElementById('camara-app')));
    t('…y no entrega foto (la entrega el input)', (await resultado(pg)) === null);
    await ctx.close();
  }

  console.log('\n── Android: tomar, revisar, repetir y usar ──');
  {
    const { pg, ctx, errores } = await nuevaPagina(UA_ANDROID);
    t('en Android la cámara de la app SÍ se ofrece', await pg.evaluate(() => window.CamaraApp.disponible() === true));
    await abrir(pg);
    t('se abre encima de todo', await pg.evaluate(() => { const c = document.getElementById('camara-app'); return !!c && getComputedStyle(c).position === 'fixed' && getComputedStyle(c).zIndex === '60'; }));
    t('dice qué foto es y cómo tomarla', await pg.evaluate(() => /Llanta de repuesto/.test(document.getElementById('camara-app').innerText) && /sujeta/.test(document.getElementById('camara-app').innerText)));
    await enVivo(pg);
    t('la cámara trasera está encendida y mostrando imagen', await pg.evaluate(() => document.querySelector('[data-cam="video"]').videoWidth > 0));
    t('NO abrió la cámara del teléfono', await pg.evaluate(() => window.__clicsRespaldo === 0));
    t('«atrás» del teléfono queda para cerrar la cámara', await pg.evaluate(() => !!(history.state && history.state.camaraApp)));
    t('sin luz si el teléfono no la tiene', await pg.evaluate(() => !document.querySelector('[data-cam="linterna"]')));
    t('sin galería en las fotos de inspección', await pg.evaluate(() => !document.querySelector('[data-cam="galeria"]')));
    await foto(pg, '1-camara-en-vivo');
    await pg.click('[data-cam="disparar"]');
    await pg.waitForSelector('[data-cam="usar"]');
    t('muestra la foto para revisarla', await pg.evaluate(() => { const i = document.querySelector('[data-cam="foto"]'); return !i.classList.contains('hidden') && !!i.src; }));
    t('mientras revisa, la cámara se apaga', (await camarasVivas(pg)) === 0);
    await foto(pg, '2-revisar-foto');
    await pg.click('[data-cam="repetir"]');
    await enVivo(pg);
    t('«Repetir» vuelve a la cámara', await pg.evaluate(() => document.querySelector('[data-cam="foto"]').classList.contains('hidden')));
    await pg.click('[data-cam="disparar"]');
    await pg.click('[data-cam="usar"]');
    const r = await resultado(pg);
    t('«Usar foto» entrega un JPEG', r && r.tipo === 'image/jpeg' && r.peso > 0, JSON.stringify(r));
    await pg.waitForFunction(() => window.__dim);
    const dim = await pg.evaluate(() => window.__dim);
    t('…reducido como pide el perfil (lado mayor ≤ 1280 px)', Math.max(...dim) <= 1280 && Math.min(...dim) > 0, dim.join('×'));
    t('la pantalla de la cámara se quita', await pg.evaluate(() => !document.getElementById('camara-app')));
    t('la cámara queda apagada', (await camarasVivas(pg)) === 0);
    await pg.waitForTimeout(100);
    t('y la entrada del historial se deshace', await pg.evaluate(() => !(history.state && history.state.camaraApp)));
    t('sin errores en la página', errores.length === 0, errores.join(' | '));
    await ctx.close();
  }

  console.log('\n── Android: cancelar y «atrás» ──');
  {
    const { pg, ctx } = await nuevaPagina(UA_ANDROID);
    await abrir(pg); await enVivo(pg);
    await pg.click('[data-cam="cerrar"]');
    t('✕ cancela sin foto', (await resultado(pg)) === null);
    t('…y apaga la cámara', (await camarasVivas(pg)) === 0);
    await abrir(pg); await enVivo(pg);
    await pg.goBack();
    t('el «atrás» del teléfono cierra la cámara sin foto', (await resultado(pg)) === null);
    t('…sin salirse de la pantalla', await pg.evaluate(() => /__prueba-camara/.test(location.pathname) && !document.getElementById('camara-app')));
    t('…y la apaga', (await camarasVivas(pg)) === 0);
    // Cerrar mientras Chrome todavía pregunta el permiso: la cámara que llega
    // tarde no se puede quedar prendida.
    await pg.evaluate(() => { window.__demora = 400; });
    await abrir(pg);
    await pg.click('[data-cam="cerrar"]');
    await pg.waitForTimeout(700);
    t('si cierra antes de que llegue la cámara, la que llega tarde se apaga', (await camarasVivas(pg)) === 0);
    await ctx.close();
  }

  console.log('\n── Android: luz (de noche) y galería (comprobantes) ──');
  {
    const { pg, ctx } = await nuevaPagina(UA_ANDROID);
    await pg.evaluate(() => { window.__fingirLuz = true; });
    await abrir(pg); await enVivo(pg);
    t('si el teléfono tiene luz, aparece el botón', await pg.evaluate(() => !!document.querySelector('[data-cam="linterna"]')));
    await pg.click('[data-cam="linterna"]');
    t('…y la prende', await pg.evaluate(() => window.__luz.join() === 'true' && document.querySelector('[data-cam="linterna"]').getAttribute('aria-pressed') === 'true'));
    await foto(pg, '3-con-luz');
    await pg.click('[data-cam="cerrar"]'); await resultado(pg);
    await abrir(pg, { galeria: true, titulo: 'Recibo de gasolina', detalle: 'Que se lea el valor pagado', maxDim: 1600, quality: 0.7 });
    await enVivo(pg);
    t('con galeria: true aparece «Galería»', await pg.evaluate(() => !!document.querySelector('[data-cam="galeria"]')));
    await foto(pg, '4-recibo-con-galeria');
    await pg.click('[data-cam="galeria"]');
    t('«Galería» abre el selector del teléfono', await pg.evaluate(() => window.__clicsRespaldo === 1));
    t('…sin foto de la cámara de la app', (await resultado(pg)) === null);
    t('…y apaga la cámara', (await camarasVivas(pg)) === 0);
    await ctx.close();
  }

  console.log('\n── Android: cuando la cámara de la app falla ──');
  {
    const { pg, ctx } = await nuevaPagina(UA_ANDROID);
    await pg.evaluate(() => { window.__fallar = ['NotReadableError']; });
    await abrir(pg);
    await pg.waitForSelector('[data-cam="reintentar"]');
    t('cámara ocupada: lo dice', await pg.evaluate(() => /ocupada/.test(document.getElementById('camara-app').innerText)));
    t('…y ofrece la cámara del teléfono', await pg.evaluate(() => !!document.querySelector('[data-cam="respaldo"]')));
    await foto(pg, '5-camara-ocupada');
    await pg.click('[data-cam="reintentar"]');
    await enVivo(pg);
    t('«Intentar de nuevo» la abre cuando se libera', await pg.evaluate(() => document.querySelector('[data-cam="video"]').videoWidth > 0));
    await pg.click('[data-cam="cerrar"]'); await resultado(pg);

    await pg.evaluate(() => { window.__fallar = ['NotAllowedError']; });
    await abrir(pg);
    await pg.waitForSelector('[data-cam="respaldo"]');
    t('sin permiso: lo explica', await pg.evaluate(() => /permiso/.test(document.getElementById('camara-app').innerText)));
    await foto(pg, '6-sin-permiso');
    await pg.click('[data-cam="respaldo"]');
    t('…«Usar la cámara del teléfono» abre la de siempre', await pg.evaluate(() => window.__clicsRespaldo === 1));
    t('…y la pantalla de la cámara se quita', await pg.evaluate(() => !document.getElementById('camara-app')));
    t('…sin foto de la cámara de la app (la trae el input)', (await resultado(pg)) === null);
    await abrir(pg);
    t('la siguiente foto ya va DIRECTO a la cámara del teléfono (no repite el error 11 veces)', await pg.evaluate(() => window.__clicsRespaldo === 2 && !document.getElementById('camara-app')));
    await resultado(pg);
    await ctx.close();
  }

  console.log('\n── Android: bloquea el teléfono con la cámara abierta ──');
  {
    const { pg, ctx } = await nuevaPagina(UA_ANDROID);
    await abrir(pg); await enVivo(pg);
    const fingir = (estado) => pg.evaluate((e) => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => e }); document.dispatchEvent(new Event('visibilitychange')); }, estado);
    await fingir('hidden');
    t('al bloquear, suelta la cámara', (await camarasVivas(pg)) === 0);
    await fingir('visible');
    await enVivo(pg);
    t('al volver, la cámara se enciende sola', (await camarasVivas(pg)) === 1);
    await pg.click('[data-cam="disparar"]'); await pg.click('[data-cam="usar"]');
    t('y la foto sale normal', ((await resultado(pg)) || {}).tipo === 'image/jpeg');
    await ctx.close();
  }
} catch (e) {
  bad++; console.log('  ✗ la prueba se cayó: ' + (e && e.message));
} finally {
  await browser.close(); srv.close();
}
console.log(`\n${ok}/${ok + bad} pasaron${bad ? ` · ${bad} FALLARON` : ''}`);
if (FOTOS) console.log('Capturas en ' + FOTOS);
console.log('NO cubierto: un teléfono Android real (la memoria que hacía cerrar Chrome, la luz física, el enfoque, el permiso de verdad).');
process.exit(bad ? 1 : 0);
