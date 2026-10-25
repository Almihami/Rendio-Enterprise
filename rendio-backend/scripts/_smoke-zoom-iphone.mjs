// _smoke-zoom-iphone.mjs — el arreglo del zoom del iPhone (25-oct-2026).
// Corre el <script> del <head> de index.html con distintos navegadores y mira
// qué queda en <meta name="viewport">: maximum-scale=1 SOLO en iPhone/iPad.
// Uso: node scripts/_smoke-zoom-iphone.mjs (desde rendio-backend/).
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
const html = fs.readFileSync(new URL('../../rendio-turnos/index.html', import.meta.url), 'utf8');
const head = html.slice(0, html.indexOf('</head>'));
const scripts = [...head.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const zoom = scripts.find(s => /maximum-scale/.test(s));
let ok = 0, bad = 0;
const t = (n, c, x) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (x !== undefined ? '  → ' + x : '')); } };
t('el <head> trae el script del zoom', !!zoom);
const BASE = 'width=device-width, initial-scale=1.0, viewport-fit=cover';
function correr(ua, platform, touch) {
  const dom = new JSDOM(`<!doctype html><head><meta name="viewport" content="${BASE}"></head>`, { runScripts: 'outside-only' });
  Object.defineProperty(dom.window.navigator, 'userAgent', { value: ua });
  Object.defineProperty(dom.window.navigator, 'platform', { value: platform });
  Object.defineProperty(dom.window.navigator, 'maxTouchPoints', { value: touch });
  dom.window.eval(zoom);
  return dom.window.document.querySelector('meta[name="viewport"]').content;
}
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const CRIOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1';
const IPAD_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
t('iPhone Safari: agrega maximum-scale=1', correr(IPHONE, 'iPhone', 5) === BASE + ', maximum-scale=1', correr(IPHONE, 'iPhone', 5));
t('Chrome en iPhone: también (es WebKit)', correr(CRIOS, 'iPhone', 5) === BASE + ', maximum-scale=1');
t('iPad que se presenta como Mac (con táctil): también', correr(IPAD_MAC, 'MacIntel', 5) === BASE + ', maximum-scale=1');
t('Android: NO cambia (ahí quitaría el pellizco)', correr(ANDROID, 'Linux armv8l', 5) === BASE, correr(ANDROID, 'Linux armv8l', 5));
t('Mac de escritorio sin táctil: NO cambia', correr(MAC, 'MacIntel', 0) === BASE);
t('Android que reporta plataforma MacIntel y táctil (emulador): NO cambia', correr(ANDROID, 'MacIntel', 5) === BASE, correr(ANDROID, 'MacIntel', 5));
t('Windows táctil: NO cambia', correr('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 'Win32', 10) === BASE);
{ // correrlo dos veces no lo duplica
  const dom = new JSDOM(`<!doctype html><head><meta name="viewport" content="${BASE}"></head>`, { runScripts: 'outside-only' });
  Object.defineProperty(dom.window.navigator, 'userAgent', { value: IPHONE });
  dom.window.eval(zoom); dom.window.eval(zoom);
  t('dos veces no lo repite', dom.window.document.querySelector('meta[name="viewport"]').content === BASE + ', maximum-scale=1');
}
{ // sin meta no revienta
  const dom = new JSDOM('<!doctype html><head></head>', { runScripts: 'outside-only' });
  Object.defineProperty(dom.window.navigator, 'userAgent', { value: IPHONE });
  let err = null; try { dom.window.eval(zoom); } catch (e) { err = e; }
  t('sin <meta viewport> no lanza error', !err);
}
t('el meta viewport original quedó igual en index.html', html.includes(`<meta name="viewport" content="${BASE}" />`));
const sw = fs.readFileSync(new URL('../../rendio-turnos/sw.js', import.meta.url), 'utf8');
t('sw.js en v205 o posterior', Number((sw.match(/rendio-turnos-v(\d+)/) || [])[1]) >= 205);
console.log(`\n${ok}/${ok + bad} pasaron${bad ? ' · ' + bad + ' FALLARON' : ''}`);
console.log('NO cubierto: el zoom real de Safari en un iPhone (jsdom no hace zoom ni layout); el campo de hora en iOS (el CSS va dentro de @supports (-webkit-touch-callout:none), que solo cumple iOS).');
process.exit(bad ? 1 : 0);
