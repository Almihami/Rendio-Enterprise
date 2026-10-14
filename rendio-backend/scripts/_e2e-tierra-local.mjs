#!/usr/bin/env node
// _e2e-tierra-local.mjs — Personal de tierra (0106, 13-oct-2026) de punta a punta,
// con la app real (Playwright contra :5180) y la base LOCAL:
//   1. alguien se registra eligiendo «Trabajo en el aeropuerto» → en la base queda
//      ground_staff = true y sin aerolínea;
//   2. su primer pedido arranca con «Trabajo en tierra» encendido;
//   3. su Perfil dice «Personal de tierra»;
//   4. el jefe lo ve en Tripulantes con el filtro «Personal de tierra».
// Al final borra la cuenta que creó. Independiente de la hora.
//
//   cd rendio-backend/scripts && node _e2e-tierra-local.mjs
//
// NUNCA toca dev ni producción (_local-fixtures.mjs solo conecta a 127.0.0.1:54322).
import { readFileSync, mkdirSync } from 'node:fs';
import { localClient } from './_local-fixtures.mjs';

const PW = process.env.E2E_PLAYWRIGHT || '/Users/harold/Documents/Rendio-Drivers/.e2e-tools/node_modules/playwright/index.mjs';
const { chromium, devices } = await import(PW);
const APP = process.env.E2E_BASE || 'http://localhost:5180';
const OUT = '/Users/harold/Documents/Rendio-Drivers/.e2e-tools/run/tierra';
mkdirSync(OUT, { recursive: true });
const PASS = (readFileSync(new URL('./_seed-e2e-local.mjs', import.meta.url), 'utf8').match(/E2E_PASSWORD\s*=\s*'([^']+)'/) || [])[1];
const PASS_NUEVA = (readFileSync(new URL('./_e2e-flujo-completo.mjs', import.meta.url), 'utf8').match(/PASS_NUEVA\s*=\s*'([^']+)'/) || [])[1];
const pg = await localClient();
const one = async (s, p) => (await pg.query(s, p)).rows[0];
let ok = 0, fail = 0;
const check = (n, c, d) => { if (c) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d != null ? ' → ' + d : ''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errores = [];
const vigilar = (p, quien) => {
  p.on('pageerror', (e) => errores.push(`${quien}: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errores.push(`${quien}: ${m.text().slice(0, 200)}`); });
};

const email = `tierra.${Date.now().toString(36)}@rendio.test`;
const browser = await chromium.launch();
try {
  // 1) Registro como personal de tierra.
  console.log('\n1) Registro eligiendo «Trabajo en el aeropuerto»');
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'es-CO', timezoneId: 'America/Bogota' });
  const p = await ctx.newPage(); vigilar(p, 'tripulante');
  await p.goto(APP + '/');
  await p.waitForSelector('#login-signup', { state: 'visible', timeout: 20000 });
  await p.click('#login-signup');
  await p.waitForSelector('[data-rg-field=name]', { state: 'visible', timeout: 10000 });
  await p.fill('[data-rg-field=name]', 'Valentina Ospina Gallego');
  await p.fill('[data-rg-field=email]', email);
  await p.fill('[data-rg-field=phone]', '3105550277');
  await p.fill('[data-rg-field=pass]', PASS_NUEVA);
  await p.fill('[data-rg-field=pass2]', PASS_NUEVA);
  await sleep(300);
  await p.click('[data-rg=crear]:not([disabled])', { timeout: 8000 });
  await p.waitForSelector('[data-rg=airline]', { state: 'visible', timeout: 20000 });
  const etiqueta = await p.evaluate(() => [...document.querySelectorAll('#auxiliar-ui .rx-lbl, #auxiliar-ui .ax-sec')].map((e) => e.textContent.trim()));
  check('el paso dice «Dónde trabajas»', etiqueta.includes('Dónde trabajas'), etiqueta.join(' | '));
  const ultima = await p.evaluate(() => { const l = [...document.querySelectorAll('[data-rg=airline]')]; const u = l[l.length - 1]; return u ? { id: u.dataset.id, txt: u.innerText.replace(/\s+/g, ' ') } : null; });
  check('la última opción es «Trabajo en el aeropuerto» (JMC)', ultima && ultima.id === '__tierra__' && /Trabajo en el aeropuerto/.test(ultima.txt) && /JMC/.test(ultima.txt), JSON.stringify(ultima));
  await p.click('[data-rg=airline][data-id="__tierra__"]');
  await p.fill('[data-rg-q="1"]', 'Olivar');
  await p.click('[data-rg=res-pick]', { timeout: 8000 });
  await p.fill('[data-rg-field=unit]', 'Torre 2 · 302').catch(() => {});
  await p.screenshot({ path: `${OUT}/01-registro-tierra.png` });
  await p.click('[data-rg=registrar]');
  await p.waitForFunction(() => /Te damos la bienvenida/.test(document.body.innerText), null, { timeout: 20000 });
  await p.screenshot({ path: `${OUT}/02-bienvenida.png` });
  const fila = await one(`SELECT ap.ground_staff, ap.airline_id, r.name conjunto FROM public.profiles pr JOIN public.auxiliar_profiles ap ON ap.profile_id = pr.id
                            LEFT JOIN public.residences r ON r.id = ap.residence_id WHERE pr.email = $1`, [email]);
  check('en la base: ground_staff = true, sin aerolínea, con su conjunto', fila && fila.ground_staff === true && fila.airline_id === null && /Olivar/.test(fila.conjunto || ''), JSON.stringify(fila));
  check('la bienvenida no avisa que algo no se guardó', !/No pudimos guardar/.test(await p.evaluate(() => document.body.innerText)));

  // 2) Su primer pedido arranca en tierra.
  console.log('\n2) El primer pedido');
  await p.click('[data-rg=entrar]', { timeout: 8000 }).catch(() => {});
  const fin = Date.now() + 9000;
  while (Date.now() < fin) {
    const b = await p.$('[data-ax=onb-skip]:visible, [data-ax=onb-later]:visible');
    if (b) { await b.click().catch(() => {}); await sleep(700); continue; }
    if (await p.$('[data-ax=new]:visible')) break;
    await sleep(300);
  }
  await p.waitForFunction(() => window.Auxiliar && window.Auxiliar.header && 'groundStaff' in window.Auxiliar.header, null, { timeout: 15000 }).catch(() => {});
  check('Auxiliar.header trae groundStaff = true', await p.evaluate(() => !!(window.Auxiliar && window.Auxiliar.header && window.Auxiliar.header.groundStaff === true)));
  await p.click('[data-ax=new]', { timeout: 8000 });
  await sleep(1200);
  const form = await p.evaluate(() => (window.Auxiliar && window.Auxiliar.state && window.Auxiliar.state.form) || null);
  check('el pedido nuevo arranca con «Trabajo en tierra» encendido', !!form && form.groundOps === true, JSON.stringify(form && { groundOps: form.groundOps }));
  await p.screenshot({ path: `${OUT}/03-pedido.png` });

  // 3) Perfil.
  console.log('\n3) Perfil');
  await p.goto(APP + '/');
  await p.waitForSelector('[data-rx=rx-tab][data-tab=perfil]', { state: 'visible', timeout: 20000 });
  await p.click('[data-rx=rx-tab][data-tab=perfil]');
  await p.waitForSelector('[data-me=row-work]', { state: 'visible', timeout: 10000 });
  await sleep(600);
  const perfil = await p.evaluate(() => ({
    linea: (document.querySelector('[data-me=line]') || {}).textContent || '',
    fila: ((document.querySelector('[data-me=row-work] .rx-row-tx > span') || {}).textContent) || '',
  }));
  check('el Perfil dice «Personal de tierra» arriba y en «Dónde trabajas»', /^Personal de tierra/.test(perfil.linea) && perfil.fila === 'Personal de tierra · no vuelo', JSON.stringify(perfil));
  await p.screenshot({ path: `${OUT}/04-perfil.png` });
  await p.click('[data-me=row-work]');
  await p.waitForSelector('.rx-sheet [data-rx="me-work-pick"][data-id="__tierra__"]', { state: 'visible', timeout: 10000 });
  await sleep(500);
  const hoja = await p.evaluate(() => [...document.querySelectorAll('.rx-sheet [data-rx="me-work-pick"]')].map((b) => ({ id: b.dataset.id, on: b.classList.contains('on') })));
  check('la hoja lista las aerolíneas reales y tierra elegida', hoja.length >= 2 && hoja[hoja.length - 1].id === '__tierra__' && hoja[hoja.length - 1].on && hoja.filter((x) => x.on).length === 1, JSON.stringify(hoja));
  await p.screenshot({ path: `${OUT}/05-hoja-donde-trabajas.png` });
  await ctx.close();

  // 4) El jefe lo ve en Tripulantes.
  console.log('\n4) Tripulantes (jefe)');
  const cj = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'es-CO', timezoneId: 'America/Bogota' });
  const j = await cj.newPage(); vigilar(j, 'jefe');
  await j.goto(APP + '/');
  await j.fill('#login-email', 'jefe.local@rendio.test'); await j.fill('#login-password', PASS); await j.click('#login-submit');
  await j.waitForFunction(() => document.getElementById('screen-login')?.classList.contains('hidden'), null, { timeout: 25000 });
  await j.evaluate(() => { const b = document.querySelector('#adm-wstabs button[data-ws="rutas"]'); if (b) b.click(); });
  await sleep(500);
  await j.evaluate(() => window.setTab && setTab('tripulantes'));
  await j.waitForSelector('#tp-air-filter:not([disabled])', { timeout: 20000 });
  const opciones = await j.evaluate(() => [...document.querySelectorAll('#tp-air-filter option')].map((o) => o.textContent));
  check('el filtro trae «Personal de tierra»', opciones.some((o) => /^Personal de tierra \(\d+\)$/.test(o)), opciones.join(' | '));
  await j.selectOption('#tp-air-filter', '__tierra');
  await sleep(400);
  const filas = await j.evaluate(() => [...document.querySelectorAll('#tripulantes-ui .tp-row')].map((r) => r.innerText.replace(/\s+/g, ' ')));
  check('con el filtro sale Valentina, marcada «Personal de tierra»', filas.some((f) => /Valentina Ospina Gallego/.test(f) && /Personal de tierra/i.test(f)) && filas.every((f) => /Personal de tierra/i.test(f)), filas.join(' || ').slice(0, 300));
  await j.screenshot({ path: `${OUT}/06-jefe-tripulantes.png` });
  await cj.close();

  check('sin errores de JavaScript en ninguna pantalla', errores.length === 0, errores.slice(0, 5).join(' | '));
} catch (e) { fail++; console.error('ERROR', e.message); }
finally {
  await browser.close();
  await pg.query(`DELETE FROM auth.users WHERE email = $1`, [email]).catch((e) => console.log('  (limpieza: ' + e.message + ')'));
  await pg.end();
}
console.log(`\n${ok} bien · ${fail} mal · capturas en ${OUT}`);
process.exit(fail ? 1 : 0);
