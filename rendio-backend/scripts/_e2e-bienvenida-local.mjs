#!/usr/bin/env node
// _e2e-bienvenida-local.mjs — La bienvenida sale UNA vez por cuenta (0119,
// 25-oct-2026), con la app real (Playwright, iPhone) y la base LOCAL:
//   1. un tripulante sin la marca entra en «Safari» y ve la bienvenida;
//   2. salta las láminas y llega al permiso, y se va SIN tocar el botón (el de
//      iPhone sale a «Agregar a inicio») → en la base ya quedó welcome_seen_at;
//   3. abre «el ícono del inicio»: otro almacenamiento, vacío. Entra con su
//      cuenta y NO le sale la bienvenida otra vez.
// Al final le devuelve a la cuenta de prueba la marca que tenía.
//
//   (con el servidor bienvenida-local en :5199 y supabase start)
//   cd rendio-backend/scripts && node _e2e-bienvenida-local.mjs
//
// NUNCA toca dev ni producción (_local-fixtures.mjs solo conecta a 127.0.0.1:54322).
import { readFileSync, mkdirSync } from 'node:fs';
import { localClient } from './_local-fixtures.mjs';

const PW = process.env.E2E_PLAYWRIGHT || '/Users/harold/Documents/Rendio-Drivers/.e2e-tools/node_modules/playwright/index.mjs';
const { chromium, devices } = await import(PW);
const APP = process.env.E2E_BASE || 'http://localhost:5199';
const OUT = '/Users/harold/Documents/Rendio-Drivers/.e2e-tools/run/bienvenida';
mkdirSync(OUT, { recursive: true });
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
const iphone = () => ({ ...devices['iPhone 13'], locale: 'es-CO', timezoneId: 'America/Bogota' });
const enBienvenida = (p) => p.evaluate(() => !!(window.Auxiliar && window.Auxiliar.state && window.Auxiliar.state.view === 'onboarding'));
const marca = async (email) => (await one(`SELECT welcome_seen_at FROM public.profiles WHERE email = $1`, [email]) || {}).welcome_seen_at || null;

// 0119 en la base local (idempotente).
await pg.query(readFileSync(new URL('../supabase/migrations/0119_bienvenida_por_cuenta.sql', import.meta.url), 'utf8'));

// Un tripulante de prueba de la base local (_seed-e2e-local.mjs). El registro
// abierto no sirve en esta base cuando quedaron varias organizaciones de otras
// pruebas («el registro abierto no sabe a cuál entrar»), así que se usa una cuenta
// existente con la marca borrada: para la bienvenida es lo mismo que una nueva.
const PASS = (readFileSync(new URL('./_seed-e2e-local.mjs', import.meta.url), 'utf8').match(/E2E_PASSWORD\s*=\s*'([^']+)'/) || [])[1];
const email = 'tripu8.local@rendio.test';
const antes = await one(`SELECT welcome_seen_at FROM public.profiles WHERE email = $1`, [email]);
if (!antes) { console.error('Falta ' + email + ' en la base local: node _seed-e2e-local.mjs'); process.exit(2); }
await pg.query(`UPDATE public.profiles SET welcome_seen_at = NULL WHERE email = $1`, [email]);
const entrar = async (pagina) => {
  await pagina.goto(APP + '/');
  await pagina.waitForSelector('#login-email', { state: 'visible', timeout: 20000 });
  await pagina.fill('#login-email', email); await pagina.fill('#login-password', PASS); await pagina.click('#login-submit');
  await pagina.waitForFunction(() => window.Auxiliar && window.Auxiliar.state && window.Auxiliar.state.source && window.Auxiliar.state.source !== 'demo', null, { timeout: 25000 }).catch(() => {});
  await sleep(2000);
};
const browser = await chromium.launch();
try {
  console.log('\n1) Entra por primera vez en «Safari» y ve la bienvenida');
  const safari = await browser.newContext(iphone());
  const p = await safari.newPage(); vigilar(p, 'safari');
  await entrar(p);
  check('sin la marca en la cuenta: le sale la bienvenida', await enBienvenida(p));
  await p.screenshot({ path: `${OUT}/01-safari-bienvenida.png` });
  check('mientras ve las láminas, la base todavía no la marca', (await marca(email)) === null);

  console.log('\n2) Salta al permiso y se va a instalar, sin tocar el botón');
  await p.click('[data-ax=onb-skip]', { timeout: 8000 });
  await sleep(1500);
  const permiso = await p.evaluate(() => document.getElementById('auxiliar-ui').innerText.replace(/\s+/g, ' '));
  check('está en la pantalla del permiso', /Siempre informado|Te avisamos/.test(permiso), permiso.slice(0, 160));
  await p.screenshot({ path: `${OUT}/02-safari-permiso.png` });
  const m = await marca(email);
  check('la base YA dice que la vio (welcome_seen_at)', !!m, String(m));
  await safari.close();

  console.log('\n3) Abre el ícono del inicio: almacenamiento vacío, entra con su cuenta');
  const icono = await browser.newContext(iphone());
  const q = await icono.newPage(); vigilar(q, 'icono');
  await q.goto(APP + '/');
  await q.waitForSelector('#login-email', { state: 'visible', timeout: 20000 });
  check('el almacenamiento está vacío (no hay marca de este teléfono)', await q.evaluate(() => Object.keys(localStorage).every((k) => !k.startsWith('rendio.aux.onboarded'))));
  await entrar(q);
  const v = await q.evaluate(() => (window.Auxiliar && window.Auxiliar.state && window.Auxiliar.state.view) || null);
  check('NO le vuelve a salir la bienvenida', v !== 'onboarding' && v != null, 'vista: ' + v);
  check('entra directo a la app (Inicio)', v === 'home', 'vista: ' + v);
  await q.screenshot({ path: `${OUT}/03-icono-inicio.png` });
  const m2 = await marca(email);
  check('la fecha de la base no se movió', m2 && m && new Date(m2).getTime() === new Date(m).getTime());
  await icono.close();

  check('sin errores de JavaScript', errores.length === 0, errores.slice(0, 5).join(' | '));
} catch (e) { fail++; console.error('ERROR', e.message); }
finally {
  await browser.close();
  // Se le devuelve la marca que tenía.
  await pg.query(`UPDATE public.profiles SET welcome_seen_at = $2 WHERE email = $1`, [email, antes.welcome_seen_at]).catch((e) => console.log('  (limpieza: ' + e.message + ')'));
  await pg.end();
}
console.log(`\n${ok} bien · ${fail} mal · capturas en ${OUT}`);
process.exit(fail ? 1 : 0);
