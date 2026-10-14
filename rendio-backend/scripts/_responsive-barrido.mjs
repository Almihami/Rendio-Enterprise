#!/usr/bin/env node
// _responsive-barrido.mjs — Barrido responsive de TODA la app en la base LOCAL.
//
// Entra con cada rol (jefe, conductor, tripulante) y sin sesión (login y registro),
// recorre cada pantalla a varios tamaños de teléfono, tableta y escritorio, y busca
// de forma automática lo que se rompe:
//   · la página se desplaza de lado (document.scrollWidth > ancho de la ventana);
//   · elementos que se salen de la pantalla (y no están dentro de algo que los
//     recorta o los desplaza a propósito: carruseles, tablas con scroll, cajones);
//   · texto cortado sin puntos suspensivos (scrollWidth > clientWidth con overflow
//     hidden y sin text-overflow: ellipsis);
//   · errores de JavaScript en la pantalla.
// Saca una captura por pantalla y tamaño, y escribe un informe.
//
//   node _responsive-barrido.mjs [--roles=jefe,conductor,tripulante,anon] [--anchos=320,360,390,414,768,1024,1440]
//
// Salida: .e2e-tools/run/responsive/<rol>/<ancho>/<pantalla>.png, hallazgos.json e
// index.html. NUNCA toca dev ni producción (la app de :5180 apunta a la base local).
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const PW = process.env.E2E_PLAYWRIGHT || '/Users/harold/Documents/Rendio-Drivers/.e2e-tools/node_modules/playwright/index.mjs';
const { chromium } = await import(PW);
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const ROLES = arg('roles', 'anon,conductor,tripulante,jefe').split(',');
const ANCHOS = arg('anchos', '320,360,390,414,768,1024,1440').split(',').map(Number);
const ALTO = { 320: 568, 360: 740, 390: 844, 414: 896, 768: 1024, 1024: 768, 1280: 800, 1440: 900 };
const APP = process.env.E2E_BASE || 'http://localhost:5180';
const OUT = process.env.RESP_OUT || '/Users/harold/Documents/Rendio-Drivers/.e2e-tools/run/responsive';
const PASS = (readFileSync(join(AQUI, '_seed-e2e-local.mjs'), 'utf8').match(/E2E_PASSWORD\s*=\s*'([^']+)'/) || [])[1];
const CUENTA = { jefe: 'jefe.local@rendio.test', conductor: 'carlos.local@rendio.test', tripulante: 'tripu1.local@rendio.test' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HALLAZGOS = [];

// Revisión dentro de la página. Devuelve lo que se rompe en ESTE estado.
function revisar() {
  const W = window.innerWidth, H = window.innerHeight;
  const de = document.documentElement;
  const docOver = Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0) - W;
  const visible = (e) => {
    const cs = getComputedStyle(e);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const sel = (e) => {
    const id = e.id ? '#' + e.id : '';
    const cls = (typeof e.className === 'string' ? e.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 3).map((c) => '.' + c).join('');
    const txt = (e.innerText || e.value || e.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return `${e.tagName.toLowerCase()}${id}${cls}${txt ? ` «${txt}»` : ''}`;
  };
  // Ancestro que recorta (overflow ≠ visible) más cercano, y si está fuera de pantalla a
  // propósito (cajón cerrado, carrusel, capa que salió).
  const recorte = (e) => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) { const cs = getComputedStyle(p); if (cs.overflowX !== 'visible' || cs.clipPath !== 'none') return p; } return null; };
  const escondido = (e) => { if (e.closest('.behind')) return true; const dt = e.closest('details:not([open])'); if (dt && !e.closest('summary')) return true; for (let p = e; p && p !== document.body; p = p.parentElement) { const r = p.getBoundingClientRect(); if (r.left >= W - 1 || r.right <= 1) return true; const cs = getComputedStyle(p); if (cs.position === 'fixed' && (r.left < -W / 2 || r.left > W / 2 + 1) && r.width <= W) return true; } return false; };
  const fuera = [], panel = [], cortado = [], texto = [];
  const todos = [...document.querySelectorAll('body *')].filter((e) => !e.closest('.leaflet-container, svg, [aria-hidden="true"], .sr-only, template, script, style, .rx-confetti'));
  for (const e of todos) {
    if (!visible(e)) continue;
    const r = e.getBoundingClientRect();
    if (r.bottom <= 0 || r.top >= H * 4) continue;
    const cs = getComputedStyle(e);
    const rec = recorte(e);
    // 1) Se sale de la pantalla sin nada que lo recorte → la página se corre de lado.
    if ((r.right > W + 2 || r.left < -2) && !rec && !escondido(e) && !fuera.some((f) => f.el.contains(e))) fuera.push({ el: e, d: Math.round(Math.max(r.right - W, -r.left)) });
    // 2) Un panel GRANDE que se desplaza de lado (no una fila de chips ni una tabla chica).
    if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && e.scrollWidth > e.clientWidth + 4 && e.clientHeight >= H * 0.45 && e.clientWidth >= W * 0.6 && !escondido(e)) panel.push({ el: e, d: e.scrollWidth - e.clientWidth });
    // 3) Un control (botón, campo, enlace) cortado por el contenedor que lo recorta.
    if (rec && /^(BUTTON|INPUT|SELECT|TEXTAREA|A|LABEL)$/.test(e.tagName) && !escondido(e)) {
      const pr = rec.getBoundingClientRect(), pcs = getComputedStyle(rec);
      const sx = pcs.overflowX === 'auto' || pcs.overflowX === 'scroll';
      if (!sx && pr.width > 40 && (r.right > pr.right + 4 || r.left < pr.left - 4) && pr.right > 0 && pr.left < W) cortado.push({ el: e, d: Math.round(Math.max(r.right - pr.right, pr.left - r.left)) });
    }
    // 4) Texto cortado sin «…».
    const hoja = e.children.length === 0 || [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (hoja && e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 2 && (cs.overflowX === 'hidden' || cs.overflowX === 'clip')
        && cs.textOverflow !== 'ellipsis' && (e.innerText || '').trim().length > 2 && r.right > 0 && r.left < W && !escondido(e)) texto.push({ el: e, d: e.scrollWidth - e.clientWidth });
  }
  return {
    W, docOver,
    fuera: fuera.slice(0, 8).map((f) => `${sel(f.el)} (+${f.d}px)`),
    panel: panel.slice(0, 5).map((f) => `${sel(f.el)} (se corre ${f.d}px de lado)`),
    cortado: [...cortado.slice(0, 8).map((f) => `control ${sel(f.el)} (${f.d}px fuera de su caja)`), ...texto.slice(0, 8).map((c) => `texto ${sel(c.el)} (${c.d}px escondidos)`)],
  };
}

const browser = await chromium.launch();
async function pagina(ancho, rol) {
  const ctx = await browser.newContext({
    viewport: { width: ancho, height: ALTO[ancho] || 900 }, deviceScaleFactor: ancho < 768 ? 2 : 1,
    isMobile: ancho < 768, hasTouch: ancho < 1024, locale: 'es-CO', timezoneId: 'America/Bogota',
    permissions: ['geolocation'], geolocation: { latitude: 6.1555, longitude: -75.3737 },
  });
  const p = await ctx.newPage();
  p.setDefaultTimeout(15000);
  p.__err = [];
  p.on('pageerror', (e) => p.__err.push(String(e.message || e).slice(0, 200)));
  p.on('dialog', (d) => d.accept().catch(() => {}));
  await p.goto(APP);
  if (rol !== 'anon') {
    await p.waitForSelector('#login-email', { state: 'visible', timeout: 20000 });
    await p.fill('#login-email', CUENTA[rol]);
    await p.fill('#login-password', PASS);
    await p.click('#login-submit');
    await p.waitForFunction(() => document.getElementById('screen-login')?.classList.contains('hidden'), null, { timeout: 25000 });
    await sleep(2500);
  }
  return { ctx, p };
}
async function mirar(p, rol, ancho, pantalla) {
  await sleep(900);
  const r = await p.evaluate(revisar).catch((e) => ({ error: e.message }));
  const dir = join(OUT, rol, String(ancho)); mkdirSync(dir, { recursive: true });
  const archivo = `${pantalla.replace(/[^a-z0-9-]+/gi, '_')}.png`;
  await p.screenshot({ path: join(dir, archivo) }).catch(() => {});
  const err = p.__err.splice(0);
  const malo = r.error || r.docOver > 1 || r.fuera.length || r.panel.length || r.cortado.length || err.length;
  HALLAZGOS.push({ rol, ancho, pantalla, ...r, errores: err, captura: `${rol}/${ancho}/${archivo}`, malo: !!malo });
  console.log(`${malo ? '✗' : '✓'} ${rol.padEnd(10)} ${String(ancho).padStart(4)} ${pantalla}${r.docOver > 1 ? ` · scroll lateral +${r.docOver}px` : ''}${r.fuera?.length ? ` · ${r.fuera.length} fuera` : ''}${r.panel?.length ? ` · panel de lado` : ''}${r.cortado?.length ? ` · ${r.cortado.length} cortados` : ''}${err.length ? ` · ${err.length} errores JS` : ''}`);
}

// ── Sin sesión: login y registro ─────────────────────────────────────────────
async function anon(ancho) {
  const { ctx, p } = await pagina(ancho, 'anon');
  await p.waitForSelector('#login-email', { state: 'visible', timeout: 20000 });
  await mirar(p, 'anon', ancho, 'login');
  const prob = await p.$('text=¿Problemas para entrar?'); if (prob) { await prob.click(); await mirar(p, 'anon', ancho, 'login-problemas'); await p.keyboard.press('Escape'); await p.goto(APP); await p.waitForSelector('#login-email'); }
  const reg = await p.$('#login-signup'); if (reg) { await reg.click(); await sleep(1500); await mirar(p, 'anon', ancho, 'registro-paso1'); }
  await ctx.close();
}
// ── Conductor ─────────────────────────────────────────────────────────────────
async function conductor(ancho) {
  const { ctx, p } = await pagina(ancho, 'conductor');
  // Si pide el celular (driver-celular.js), se mira y se sigue.
  if (await p.$('#drv-tel-modal:not(.hidden) [data-drv-tel=input]')) await mirar(p, 'conductor', ancho, 'pide-celular');
  for (const t of ['home', 'avail', 'schedule', 'requests', 'perfil']) {
    await p.evaluate((x) => window.setDriverTab && setDriverTab(x), t).catch(() => {});
    await mirar(p, 'conductor', ancho, 'tab-' + t);
  }
  await p.evaluate(() => window.setDriverTab && setDriverTab('home'));
  // Inicio de turno: primer paso del asistente.
  const ini = await p.$('#sf-open-btn');
  if (ini) { await ini.click().catch(() => {}); await sleep(1500); await mirar(p, 'conductor', ancho, 'inicio-turno-paso1'); await p.goto(APP); await sleep(3000); }
  // Ruta del día (v2).
  if (await p.$('[data-vuelta]')) {
    await p.click('[data-vuelta]'); await p.waitForSelector('#driver-ruta-ui .rt-scr', { timeout: 15000 }).catch(() => {});
    await mirar(p, 'conductor', ancho, 'ruta-mi-dia');
    if (await p.$('#driver-ruta-ui .rt-hero .rt-crew')) {
      await p.click('#driver-ruta-ui .rt-hero .rt-crew'); await sleep(900);
      await mirar(p, 'conductor', ancho, 'ruta-detalle');
      await p.click('#driver-ruta-ui #rt-layers .rx-layer:last-child .rt-mapcard').catch(() => {}); await sleep(2500);
      await mirar(p, 'conductor', ancho, 'ruta-mapa-grande');
      await p.click('#driver-ruta-ui #rt-sheet-host .rx-sheet-bg', { position: { x: 10, y: 10 } }).catch(() => {}); await sleep(500);
      await p.click('#driver-ruta-ui #rt-layers .rx-layer:last-child .rx-foot .rx-btn').catch(() => {}); await sleep(1800);
      await mirar(p, 'conductor', ancho, 'ruta-ejecucion');
      await p.click('#driver-ruta-ui #rt-layers .rx-layer:last-child .rt-foot [data-rt=report]').catch(() => {}); await sleep(700);
      await mirar(p, 'conductor', ancho, 'ruta-reportar');
      await p.click('#driver-ruta-ui #rt-sheet-host .rx-sheet-bg', { position: { x: 10, y: 10 } }).catch(() => {}); await sleep(500);
      await p.click('#driver-ruta-ui #rt-layers .rx-layer:last-child [data-rt=chat]').catch(() => {}); await sleep(900);
      await mirar(p, 'conductor', ancho, 'ruta-chat');
    }
  }
  await ctx.close();
}
// ── Tripulante ────────────────────────────────────────────────────────────────
async function tripulante(ancho) {
  const { ctx, p } = await pagina(ancho, 'tripulante');
  // Presentación del primer ingreso.
  for (let i = 0; i < 8; i++) { const b = await p.$('[data-ax=onb-skip]:visible, [data-ax=onb-later]:visible'); if (!b) break; if (i === 0) await mirar(p, 'tripulante', ancho, 'presentacion'); await b.click().catch(() => {}); await sleep(700); }
  const tabs = await p.$$eval('[data-rx=rx-tab][data-tab]', (els) => els.map((e) => e.dataset.tab)).catch(() => []);
  for (const t of tabs) {
    await p.click(`[data-rx=rx-tab][data-tab="${t}"]`).catch(() => {}); await sleep(1000);
    await mirar(p, 'tripulante', ancho, 'tab-' + t);
  }
  // Pedir un traslado: primer paso.
  if (tabs.length) await p.click(`[data-rx=rx-tab][data-tab="${tabs[0]}"]`).catch(() => {});
  const pedir = await p.$('[data-ax=new]:visible, [data-rx=pedir]:visible');
  if (pedir) { await pedir.click().catch(() => {}); await sleep(1200); await mirar(p, 'tripulante', ancho, 'pedir-paso1'); await p.goto(APP); await sleep(3000); }
  // Un viaje abierto.
  await p.click('[data-rx=rx-tab][data-tab=viajes]').catch(() => {}); await sleep(900);
  const viaje = await p.$('[data-ax=trip]:visible');
  if (viaje) { await viaje.click().catch(() => {}); await sleep(1800); await mirar(p, 'tripulante', ancho, 'viaje'); }
  await ctx.close();
}
// ── Jefe (admin) ──────────────────────────────────────────────────────────────
async function jefe(ancho) {
  const { ctx, p } = await pagina(ancho, 'jefe');
  await mirar(p, 'jefe', ancho, 'entrada');
  const ws = await p.$$eval('#adm-wstabs button[data-ws]', (els) => els.map((e) => e.dataset.ws)).catch(() => []);
  const vistos = new Set();
  for (const w of (ws.length ? ws : [null])) {
    if (w) await p.evaluate((x) => { const b = document.querySelector(`#adm-wstabs button[data-ws="${x}"]`); if (b) b.click(); }, w); await sleep(500);
    const mods = await p.$$eval('#adm-snav .nav-i[data-mod]:not([disabled])', (els) => els.map((e) => e.dataset.mod)).catch(() => []);
    for (const m of mods) {
      if (vistos.has(m)) continue; vistos.add(m);
      await p.evaluate((x) => window.setTab && setTab(x), m).catch(() => {});
      await sleep(1600);
      await mirar(p, 'jefe', ancho, `${w || 'admin'}-${m}`);
    }
  }
  await ctx.close();
}

const FN = { anon, conductor, tripulante, jefe };
for (const rol of ROLES) for (const a of ANCHOS) {
  try { await FN[rol](a); } catch (e) { console.log(`✗ ${rol} ${a}: ${e.message.split('\n')[0]}`); HALLAZGOS.push({ rol, ancho: a, pantalla: '(recorrido)', error: e.message.split('\n')[0], malo: true }); }
}
await browser.close();
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'hallazgos.json'), JSON.stringify(HALLAZGOS, null, 2));
const malos = HALLAZGOS.filter((h) => h.malo);
writeFileSync(join(OUT, 'index.html'), `<!doctype html><meta charset=utf-8><title>Responsive</title><style>body{font:13px system-ui;margin:16px}tr.m{background:#fee}td{vertical-align:top;padding:4px 8px;border-bottom:1px solid #ddd}img{width:160px}</style>
<h1>Barrido responsive · ${HALLAZGOS.length} pantallas · ${malos.length} con hallazgos</h1><table>${HALLAZGOS.map((h) => `<tr class="${h.malo ? 'm' : ''}"><td>${h.rol}</td><td>${h.ancho}</td><td>${h.pantalla}</td><td>${h.docOver > 1 ? `scroll lateral +${h.docOver}px<br>` : ''}${(h.fuera || []).map((x) => 'fuera: ' + x.replace(/</g, '&lt;')).join('<br>')}${(h.panel || []).map((x) => '<br>panel: ' + x.replace(/</g, '&lt;')).join('')}${(h.cortado || []).map((x) => '<br>cortado: ' + x.replace(/</g, '&lt;')).join('')}${(h.errores || []).map((x) => '<br>JS: ' + x.replace(/</g, '&lt;')).join('')}${h.error ? 'ERROR ' + h.error : ''}</td><td>${h.captura ? `<a href="${h.captura}"><img src="${h.captura}"></a>` : ''}</td></tr>`).join('')}</table>`);
console.log(`\n${HALLAZGOS.length} pantallas · ${malos.length} con hallazgos · ${OUT}/index.html`);
