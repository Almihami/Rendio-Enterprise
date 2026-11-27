// EL ANUNCIO DE UNA SOLA VEZ (popup de Navidad, 0180): a quién le sale y cuántas veces.
//
// Harold, 26-nov-2026: «solo sale una vez por usuario, o sea lo abren hoy y ya
// mañana no les sale y no pueden volverlo a ver».
//
// Arranca la app del tripulante entera (rediseño encendido) en jsdom y entra a
// Inicio como lo hace una persona. Comprueba la REGLA; el aspecto (telón, nieve,
// tamaños) NO lo ve jsdom: eso se mira en el navegador.
//
//   cd rendio-backend/scripts && node _smoke-anuncio-navidad-dom.mjs
//
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';

const APP = '../../rendio-turnos/';
const dom = new JSDOM(readFileSync(new URL(APP + 'index.html', import.meta.url), 'utf8'),
  { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
global.window = window; global.document = window.document;
window.RENDIO_CONFIG = { OTP_LENGTH: 8 }; window.toast = () => {}; window.L = undefined;
window.escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const errores = [];
window.console.error = (...a) => { errores.push(a.map(x => (x && x.message) || String(x)).join(' ')); };
window.console.warn = () => {};

let ok = 0, bad = 0;
const t = (n, c, d = '') => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d ? ' → ' + d : '')); } };

// Las ilustraciones: jsdom no baja imágenes, así que se decide aquí si «cargan».
let imagenesCargan = true;
window.Image = class { set src(_v) { setTimeout(() => { const f = imagenesCargan ? this.onload : this.onerror; if (f) f(); }, 5); } };

const subidas = [];            // llamadas a la cuenta
let cuentaFalla = false;
window.Api = {
  listMyReservations: async () => [],
  listResidences: async () => [],
  getMyAuxiliarPlace: async () => null,
  getSettings: async () => ({ aux_wait_minutes: 5, aux_min_lead_hours: 6, _loaded: true }),
  markWelcomeSeen: async () => new Date().toISOString(),
  markAnnouncementSeen: async (k) => {
    subidas.push(k);
    if (cuentaFalla) throw new Error('sin señal');
    return { [k]: new Date().toISOString() };
  },
};
window.state = { settings: {} }; global.state = window.state;
window.localStorage.setItem('rendio.aux.rx', '1');
const PANTALLAS = ['aux-rx-inicio.js', 'aux-rx-viajes.js', 'aux-rx-avisos.js', 'aux-rx-viaje.js', 'aux-rx-pedir.js', 'aux-rx-perfil.js',
  'aux-rx-pagos.js', 'aux-rx-puntos.js', 'aux-rx-coord.js', 'aux-rx-vuelo.js'];
for (const f of ['aux-rx-ui.js', 'aux-shell.js', 'api-aux.js', 'aux-residencias.js', 'aux-privado.js', 'aux-presentacion.js', 'aux-anuncio.js', ...PANTALLAS, 'auxiliar.js']) {
  window.eval(readFileSync(new URL(APP + f, import.meta.url), 'utf8'));
}

const AN = window.AuxAnuncio;
const K = AN._.ANUNCIO.key;
const ui = () => window.document.getElementById('auxiliar-ui');
const popup = () => ui().querySelector('.rx-sheet.rx-nv');
const hoja = () => ui().querySelector('.rx-sheet-bg');
const txt = (el) => (el ? el.textContent : '').replace(/\s+/g, ' ').trim();
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const VISTA = { welcome_seen_at: '2026-10-01T00:00:00Z' };       // ya pasó la bienvenida
const perfil = (id, mas) => Object.assign({ id, full_name: 'Laura Ejemplo', role: 'auxiliar', announcements_seen: {} }, VISTA, mas || {});
const entrar = async (p) => { await window.Auxiliar.init(p); await wait(60); };
const esperarAnuncio = () => wait(1150);                          // 0,9 s + carga + margen
const cerrarTodo = async () => { const sh = window.AuxShell; if (hoja()) { sh.closeSheet(); await wait(300); } };
const llaveTel = (id) => AN._.LS + K + '.' + id;

console.log('\n1 · La primera vez que entra a Inicio');
await entrar(perfil('perfil-laura'));
t('entra a Inicio (rediseño encendido, sin bienvenida)', !!ui().querySelector('.rx-tabview[data-scr="home"]') && !ui().querySelector('.rx-ob'));
t('no aparece de inmediato: la app primero', !popup());
await esperarAnuncio();
t('a los 0,9 s aparece el popup', !!popup());
const p1 = popup();
t('es una tarjeta centrada sobre el velo (no una hoja de abajo)', !!p1 && p1.parentNode.classList.contains('rx-nv-bg') && p1.getAttribute('role') === 'dialog');
const texto = txt(p1);
t('dice «Esta Navidad Rendio te premia»', /Esta Navidad\s*Rendio\s*te premia/.test(texto), texto);
t('dice «Próximamente» y el botón «Estaré pendiente»', texto.includes('Próximamente') && txt(p1.querySelector('button.rx-nv-ok')) === 'Estaré pendiente');
t('tiene las dos fichas «? ?», el telón y la cenefa', p1.querySelectorAll('.rx-nv-f b').length === 2 && [...p1.querySelectorAll('.rx-nv-f b')].every(b => b.textContent === '?')
  && !!p1.querySelector('img.rx-nv-telon') && !!p1.querySelector('img.rx-nv-cenefa'));
t('no cuenta nada del sorteo todavía (ni números ni premio)', !/14|77|00|sorteo|mensualidad|enero|código/i.test(texto), texto);
t('tiene X para cerrar con su nombre', !!p1.querySelector('button.rx-nv-x[aria-label="Cerrar"]'));
t('queda marcado en la CUENTA al aparecer (una llamada, con la clave)', subidas.length === 1 && subidas[0] === K, JSON.stringify(subidas));
t('y en el teléfono', !!window.localStorage.getItem(llaveTel('perfil-laura')));
await wait(30);
t('el perfil en memoria ya lo trae visto', !!(window.Auxiliar.state.profile.announcements_seen || {})[K]);

console.log('\n2 · Cerrarlo');
p1.querySelector('button.rx-nv-ok').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(320);
t('«Estaré pendiente» lo cierra', !popup() && !hoja());

console.log('\n3 · Volver a entrar: ya no sale');
await entrar(perfil('perfil-laura', { announcements_seen: { [K]: '2026-11-26T20:00:00Z' } }));
await esperarAnuncio();
t('la misma cuenta entra otra vez y no le sale', !popup());
t('ni vuelve a llamar a la cuenta', subidas.length === 1, JSON.stringify(subidas));

console.log('\n4 · Otro teléfono (sin la marca local) con la cuenta ya marcada');
window.localStorage.removeItem(llaveTel('perfil-laura'));
await entrar(perfil('perfil-laura', { announcements_seen: { [K]: '2026-11-26T20:00:00Z' } }));
await esperarAnuncio();
t('no le sale: manda la cuenta, no el teléfono', !popup());

console.log('\n5 · La marca quedó solo en el teléfono (no hubo señal al marcar)');
window.localStorage.setItem(llaveTel('perfil-sinsenal'), '2026-11-26T20:00:00Z');
const antes5 = subidas.length;
await entrar(perfil('perfil-sinsenal'));
await esperarAnuncio();
t('no le sale otra vez en ese teléfono', !popup());
t('y la marca se sube a la cuenta', subidas.length === antes5 + 1 && subidas[subidas.length - 1] === K);

console.log('\n6 · Otra persona en el mismo teléfono');
await entrar(perfil('perfil-otra'));
await esperarAnuncio();
t('a ella sí le sale (la marca es por cuenta)', !!popup());
// cerrar con la X
popup().querySelector('button.rx-nv-x').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(320);
t('la X lo cierra', !popup());

console.log('\n7 · Sin señal al marcar: no se le repite en ese teléfono');
cuentaFalla = true;
await entrar(perfil('perfil-caida'));
await esperarAnuncio();
t('le sale aunque la cuenta no responda', !!popup());
t('queda marcado en el teléfono', !!window.localStorage.getItem(llaveTel('perfil-caida')));
await cerrarTodo();
cuentaFalla = false;
const antes7 = subidas.length;
await entrar(perfil('perfil-caida'));
await esperarAnuncio();
t('al volver a entrar no sale, y reintenta guardar en la cuenta', !popup() && subidas.length === antes7 + 1);

console.log('\n8 · Cuándo NO debe salir');
const noSale = async (nombre, antes, despues) => {
  const id = 'perfil-no-' + Math.random().toString(36).slice(2, 8);
  const n0 = subidas.length;
  const deshacer = await antes(id);
  await esperarAnuncio();
  t(nombre, !popup() && subidas.length === n0 && !window.localStorage.getItem(llaveTel(id)),
    `popup=${!!popup()} subidas=${subidas.length - n0} tel=${!!window.localStorage.getItem(llaveTel(id))}`);
  await cerrarTodo();
  if (typeof deshacer === 'function') deshacer();
  if (despues) await despues();
};
await noSale('con un viaje en curso', async (id) => {
  const A = window.Auxiliar, RI = window.AuxRxInicio;
  await entrar(perfil(id, { announcements_seen: { [K]: 'x' } }));     // entra sin que el reloj arranque
  A.state.profile.announcements_seen = {};
  const up = A.upcoming, live = RI.isLive;
  A.upcoming = () => [{ id: 'v1', status: 'onway' }]; RI.isLive = () => true;
  AN.alEntrar();
  return () => { A.upcoming = up; RI.isLive = live; };
});
await noSale('con otra hoja abierta encima', async (id) => {
  await entrar(perfil(id, { announcements_seen: { [K]: 'x' } }));
  window.Auxiliar.state.profile.announcements_seen = {};
  window.AuxShell.sheet('<div class="otra">Otra hoja</div>');
  AN.alEntrar();
});
await noSale('fuera de las fechas', async (id) => {
  const a = AN._.ANUNCIO; const d = a.desde, h = a.hasta;
  a.desde = '2020-01-01'; a.hasta = '2020-01-02';
  await entrar(perfil(id));
  return () => { a.desde = d; a.hasta = h; };
});
await noSale('apagado', async (id) => {
  const a = AN._.ANUNCIO; a.activo = false;
  await entrar(perfil(id));
  return () => { a.activo = true; };
});
await noSale('si las ilustraciones no cargan (y no se marca: sale otro día)', async (id) => {
  imagenesCargan = false; AN._.olvidarCarga();        // como un teléfono que nunca las bajó
  await entrar(perfil(id));
  return () => { imagenesCargan = true; AN._.olvidarCarga(); };
});
await noSale('a quien debe cambiar su contraseña', async (id) => { await entrar(perfil(id, { must_change_password: true })); });
await noSale('fuera de Inicio (en otra pestaña)', async (id) => {
  await entrar(perfil(id, { announcements_seen: { [K]: 'x' } }));
  window.Auxiliar.state.profile.announcements_seen = {};
  window.AuxShell.setTab('viajes'); await wait(60);
  AN.alEntrar();
  return () => { window.AuxShell.setTab('inicio'); };
});

console.log('\n8b · Lo que lo frenaba se quita: sale en la siguiente ocasión');
{
  // Caso real visto en el navegador: Inicio avisa mientras otra cosa todavía está
  // encima (la bienvenida yéndose). El aviso llega con una hoja abierta y la hoja
  // se cierra antes de que suene el reloj: debe salir.
  await entrar(perfil('perfil-frenado', { announcements_seen: { [K]: 'x' } }));
  window.Auxiliar.state.profile.announcements_seen = {};
  window.AuxShell.sheet('<div class="otra">Otra hoja</div>');
  AN.alEntrar();
  await wait(150);
  window.AuxShell.closeSheet();
  await esperarAnuncio();
  t('avisó con algo encima, eso se cerró a tiempo: sale', !!popup());
  await cerrarTodo();
  // Y si el reloj sonó con el freno todavía puesto, sale con el siguiente aviso.
  await entrar(perfil('perfil-frenado-2', { announcements_seen: { [K]: 'x' } }));
  window.Auxiliar.state.profile.announcements_seen = {};
  window.AuxShell.sheet('<div class="otra">Otra hoja</div>');
  AN.alEntrar();
  await esperarAnuncio();
  t('con la hoja todavía abierta no sale', !popup());
  await cerrarTodo();
  AN.alEntrar();                                   // el siguiente repaso de Inicio
  await esperarAnuncio();
  t('y sale con el siguiente aviso de Inicio', !!popup());
  await cerrarTodo();
}

console.log('\n9 · Una base sin 0180 (el perfil llega sin la columna)');
const sinCol = perfil('perfil-sin-0180'); delete sinCol.announcements_seen;
await entrar(sinCol);
await esperarAnuncio();
t('le sale igual', !!popup());
await cerrarTodo();
await entrar(Object.assign(perfil('perfil-sin-0180'), { announcements_seen: undefined }));
await esperarAnuncio();
t('y no se repite: aguanta con la marca del teléfono', !popup());

console.log('\n10 · Otra hoja reemplaza al anuncio');
await entrar(perfil('perfil-reemplazo'));
await esperarAnuncio();
const p10 = popup();
window.AuxShell.sheet('<div class="otra">Otra hoja</div>');
await wait(30);
t('la hoja recupera su forma normal (sin las clases del anuncio)', !!p10 && !p10.classList.contains('rx-nv') && !p10.parentNode.classList.contains('rx-nv-bg') && !!p10.querySelector('.otra'));
await cerrarTodo();

t('sin errores de consola', errores.length === 0, errores.slice(0, 3).join(' | '));
console.log(`\n${bad ? '✗' : '✓'} ${ok} bien, ${bad} mal`);
process.exit(bad ? 1 : 0);
