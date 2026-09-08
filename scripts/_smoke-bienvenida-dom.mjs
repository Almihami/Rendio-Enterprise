// LA BIENVENIDA DEL TRIPULANTE: a quién se le muestra y cuántas veces.
//
// Nace de un caso real (7-sep-2026, producción): la profa creó un tripulante
// NUEVO y no le salió la bienvenida. La marca de «ya la vio» estaba en una sola
// llave del navegador, así que el primero que entrara dejaba el aparato marcado
// para todos los que vinieran después — que es justo el caso al que va dirigida
// la pantalla.
//
// REQUIERE jsdom (no está en el repo, es solo para probar):
//   cd rendio-backend && npm install --no-save jsdom
//   node scripts/_smoke-bienvenida-dom.mjs
//
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';

const APP = '../rendio-turnos/';
const dom = new JSDOM(readFileSync(APP + 'index.html', 'utf8'),
  { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
global.window = window; global.document = window.document;
window.RENDIO_CONFIG = { OTP_LENGTH: 8 }; window.toast = () => {}; window.L = undefined;

let ok = 0, bad = 0;
const t = (n, c, d = '') => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d ? ' → ' + d : '')); } };

window.Api = {
  listMyReservations: async () => [],      // cuenta nueva: sin viajes, pero CON sesión
  listResidences: async () => [],
  getMyAuxiliarPlace: async () => null,
  getSettings: async () => ({ aux_wait_minutes: 5, aux_min_lead_hours: 6, _loaded: true }),
};
window.state = { settings: {} }; global.state = window.state;
for (const f of ['aux-residencias.js', 'aux-privado.js', 'aux-presentacion.js', 'auxiliar.js'])
  window.eval(readFileSync(APP + f, 'utf8'));

const ui = () => window.document.getElementById('auxiliar-ui');
const txt = () => ui().textContent.replace(/\s+/g, ' ');
const entrar = async (perfil) => { await window.Auxiliar.init(perfil); await new Promise(r => setTimeout(r, 60)); };
const ANA = { id: 'perfil-ana', full_name: 'Ana Lucía Restrepo Vélez', role: 'auxiliar' };
const NUEVO = { id: 'perfil-recien-creado', full_name: 'Juan David Ocampo', role: 'auxiliar' };

console.log('\n── el primer ingreso ──');
window.localStorage.clear();
await entrar(ANA);
t('a quien entra por primera vez se le muestra', window.Auxiliar.state.view === 'onboarding',
  'vista: ' + window.Auxiliar.state.view);
t('con la primera escena, no con un icono suelto', !!ui().querySelector('.axo-ruta'));
t('y el avión que recorre la ruta', !!ui().querySelector('.axo-ruta .ax-plane'));

console.log('\n── se recorre y se termina ──');
ui().querySelector('[data-ax="onb-next"]').click();
t('la segunda escena es el pin', !!ui().querySelector('.axo-punto'));
ui().querySelector('[data-ax="onb-next"]').click();
t('la tercera es el carro', !!ui().querySelector('.axo-cond'));
ui().querySelector('[data-ax="onb-go"][data-i="0"]').click();
t('tocar un punto devuelve a esa pantalla', !!ui().querySelector('.axo-ruta'));
window.Auxiliar.state.onbStep = 3; window.Auxiliar.rerender();
t('al final se pide el permiso, con el motivo delante', /Te avisamos/.test(txt()) && /Cuando te asignen conductor/.test(txt()));
ui().querySelector('[data-ax="onb-later"]').click();
await new Promise(r => setTimeout(r, 40));
t('«Ahora no» entra a la app igual', window.Auxiliar.state.view === 'home');

console.log('\n── no se repite a quien ya la vio ──');
await entrar(ANA);
t('la misma persona no la vuelve a ver', window.Auxiliar.state.view === 'home');

console.log('\n── PERO a una cuenta nueva SÍ, en el mismo navegador ──');
await entrar(NUEVO);
t('el tripulante recién creado la ve', window.Auxiliar.state.view === 'onboarding',
  'vista: ' + window.Auxiliar.state.view);

console.log('\n── y se puede volver a ver desde Perfil ──');
window.Auxiliar.state.view = 'home';
window.AuxPresentacion.markOnboarded();
await entrar(NUEVO);
t('ya no sale sola', window.Auxiliar.state.view === 'home');
window.Auxiliar.state.view = 'perfil'; window.Auxiliar.rerender();
t('Perfil ofrece verla otra vez', !!ui().querySelector('[data-ax="onb-again"]'), txt().slice(0, 200));
ui().querySelector('[data-ax="onb-again"]').click();
t('y se abre', window.Auxiliar.state.view === 'onboarding' && !!ui().querySelector('.axo-ruta'));

console.log('\n── la marca vieja del navegador ya no manda ──');
// Era UNA sola llave para todo el aparato. Como las tres pantallas se rehicieron
// enteras el 7-sep, quien vio las de antes no ha visto estas: se le muestran una
// vez. Lo que NO puede pasar es que esa marca deje sin bienvenida a una cuenta
// nueva, que fue el caso real.
window.localStorage.clear();
window.localStorage.setItem('rendio.aux.onboarded', '1');
await entrar(ANA);
t('quien vio la bienvenida vieja ve la nueva una vez', window.Auxiliar.state.view === 'onboarding');
window.AuxPresentacion.markOnboarded();
t('y al marcarla se limpia la llave del navegador entero',
  window.localStorage.getItem('rendio.aux.onboarded') === null);
await entrar(ANA);
t('a esa persona ya no le sale otra vez', window.Auxiliar.state.view === 'home');
await entrar(NUEVO);
t('y a la cuenta nueva le sale igual', window.Auxiliar.state.view === 'onboarding');

console.log(`\n${ok}/${ok + bad} pasaron${bad ? ' · ' + bad + ' FALLARON' : ''}`);
console.log('NO cubierto: el movimiento. jsdom no anima ni dibuja — que el avión trace la');
console.log('línea y que todo quede centrado solo se ve en un navegador de verdad.');
process.exit(bad ? 1 : 0);
