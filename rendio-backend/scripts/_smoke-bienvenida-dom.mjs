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
// REDISEÑO (P11, 27-sep-2026): mientras exista el interruptor corre en los DOS
// modos. RX=0 (o sin variable) = la bienvenida de siempre (.axo); RX=1 = la del
// diseño (RxWelcome + RxNotif): .rx-ob · .rx-wel-top · .rx-wel-art (con las
// escenas .axo-* adentro) · .rx-wel-tx · .rx-dots · .rx-foot, y el permiso con
// .rx-bell-big y un aviso REAL en .rx-demo-push. Los mismos data-ax onb-*.
// Además: re-montaje por key (la lámina y el texto se recrean, los puntos no;
// la fase recrea el .rx-ob), deslizar con pointerdown/pointerup, y la pantalla
// «Algo no va bien» (support) con «Escribir a Coordinación».
//   RX=0 node scripts/_smoke-bienvenida-dom.mjs
//   RX=1 node scripts/_smoke-bienvenida-dom.mjs
//
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';

const APP = '../rendio-turnos/';
const RX = process.env.RX === '1';
console.log('Modo: ' + (RX ? 'RX=1 (rediseño encendido)' : 'RX=0 (la bienvenida de siempre)'));
const dom = new JSDOM(readFileSync(APP + 'index.html', 'utf8'),
  { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
global.window = window; global.document = window.document;
window.RENDIO_CONFIG = { OTP_LENGTH: 8 }; window.toast = () => {}; window.L = undefined;
window.escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const errores = [];
window.console.error = (...a) => { errores.push(a.map(x => (x && x.message) || String(x)).join(' ')); };

let ok = 0, bad = 0;
const t = (n, c, d = '') => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d ? ' → ' + d : '')); } };

window.Api = {
  listMyReservations: async () => [],      // cuenta nueva: sin viajes, pero CON sesión
  listResidences: async () => [],
  getMyAuxiliarPlace: async () => null,
  getSettings: async () => ({ aux_wait_minutes: 5, aux_min_lead_hours: 6, _loaded: true }),
};
window.state = { settings: {} }; global.state = window.state;
window.localStorage.setItem('rendio.aux.rx', RX ? '1' : '0');
const PANTALLAS = ['aux-rx-inicio.js', 'aux-rx-viajes.js', 'aux-rx-avisos.js', 'aux-rx-viaje.js', 'aux-rx-pedir.js', 'aux-rx-perfil.js',
  'aux-rx-pagos.js', 'aux-rx-puntos.js', 'aux-rx-coord.js', 'aux-rx-vuelo.js'];
const ARCHIVOS = RX
  ? ['aux-rx-ui.js', 'aux-shell.js', 'api-aux.js', 'aux-residencias.js', 'aux-privado.js', 'aux-presentacion.js', ...PANTALLAS, 'auxiliar.js']
  : ['aux-residencias.js', 'aux-privado.js', 'aux-presentacion.js', 'auxiliar.js'];
for (const f of ARCHIVOS) window.eval(readFileSync(APP + f, 'utf8'));

const ui = () => window.document.getElementById('auxiliar-ui');
const q = (s) => ui().querySelector(s);
const qa = (s) => [...ui().querySelectorAll(s)];
const txt = () => ui().textContent.replace(/\s+/g, ' ');
const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));
const entrar = async (perfil) => { await window.Auxiliar.init(perfil); await new Promise(r => setTimeout(r, 60)); };
const ANA = { id: 'perfil-ana', full_name: 'Ana Lucía Restrepo Vélez', role: 'auxiliar' };
const NUEVO = { id: 'perfil-recien-creado', full_name: 'Juan David Ocampo', role: 'auxiliar' };
// Lo que las láminas del diseño traían y en la app sería inventado (plan §1.6).
const PROHIBIDOS = ['AV9525', 'Carlos', 'RDO-481', '24/7', 'Juliana', 'Laura', '38 auxiliares', 'en línea', 'Plan B',
  'Esta noche te avisamos', 'Moví tu recogida', 'MDE → MIA', 'Llega en 8 min', 'código de 6 dígitos'];
const prohibidos = () => PROHIBIDOS.filter(p => txt().includes(p));
const ptr = (el, type, x) => el.dispatchEvent(new window.PointerEvent(type, { bubbles: true, clientX: x, clientY: 300, pointerId: 1 }));

console.log('\n── el primer ingreso ──');
window.localStorage.clear();
window.localStorage.setItem('rendio.aux.rx', RX ? '1' : '0');
await entrar(ANA);
t('a quien entra por primera vez se le muestra', window.Auxiliar.state.view === 'onboarding',
  'vista: ' + window.Auxiliar.state.view);
t('con la primera escena, no con un icono suelto', !!q('.axo-ruta'));
t('y el avión que recorre la ruta', !!q('.axo-ruta .ax-plane'));

let ob0 = null, dots0 = null, full0 = null;
if (RX) {
  console.log('\n── (rx) RxWelcome ──');
  full0 = q('.rx-full[data-scr="onboarding"]');
  ob0 = q('.rx-ob[data-ob="welcome"]');
  t('pantalla completa del shell, sin pestañas', !!full0 && q('.rx-base').classList.contains('rx-nobase'));
  t('.rx-ob > .rx-scr.rx-wel con .rx-wel-top, .rx-wel-art, .rx-wel-tx, .rx-dots y .rx-foot',
    !!ob0 && !!q('.rx-wel > .rx-wel-top') && !!q('.rx-wel > .rx-wel-art') && !!q('.rx-wel > .rx-wel-tx') && !!q('.rx-wel > .rx-dots') && !!q('.rx-wel > .rx-foot'));
  t('la escena .axo va DENTRO de la lámina del diseño (.rx-wel-art .rx-art)', !!q('.rx-wel-art .rx-art .axo-ruta'));
  t('los textos son los de siempre', /Pide tu traslado, no lo coordines/.test(q('.rx-wel-tx').textContent));
  t('«Saltar» es un .rx-link con data-ax="onb-skip"', !!q('.rx-wel-top .rx-link[data-ax="onb-skip"]'));
  dots0 = qa('.rx-dots button');
  t('tres puntos, el primero .on, con data-ax="onb-go"', dots0.length === 3 && dots0[0].className === 'on' && dots0.every(b => b.dataset.ax === 'onb-go'));
  t('«Siguiente» es .rx-btn.pri en .rx-foot (data-ax="onb-next")', /Siguiente/.test(q('.rx-foot .rx-btn.pri[data-ax="onb-next"]')?.textContent || ''));
  t('no hay «Ya tengo cuenta»: la bienvenida sale después de entrar', !/Ya tengo cuenta/.test(txt()));
  t('sin datos inventados de las láminas del diseño', prohibidos().length === 0, prohibidos().join(', '));
}

console.log('\n── se recorre y se termina ──');
const art0 = RX ? q('.rx-wel-art') : null, tx0 = RX ? q('.rx-wel-tx') : null;
q('[data-ax="onb-next"]').click();
t('la segunda escena es el pin', !!q('.axo-punto'));
if (RX) {
  t('(rx) key={i}: la lámina es un nodo NUEVO con .rx-anim (su rxFade corre)', q('.rx-wel-art') !== art0 && q('.rx-wel-art').classList.contains('rx-anim') && q('.rx-wel-art').getAttribute('data-rx-key') === '1');
  t('(rx) key={"t"+i}: el texto también se recrea', q('.rx-wel-tx') !== tx0 && q('.rx-wel-tx').classList.contains('rx-anim') && /Ya sabemos dónde queda tu portería/.test(q('.rx-wel-tx').textContent));
  t('(rx) los puntos son los MISMOS nodos y solo cambia .on (transición .35 s)', qa('.rx-dots button').every((b, k) => b === dots0[k]) && dots0[1].className === 'on' && !dots0[0].className);
  t('(rx) la fase no cambió: el .rx-ob y la capa son los mismos', q('.rx-ob') === ob0 && q('.rx-full') === full0);
}
q('[data-ax="onb-next"]').click();
t('la tercera es el carro', !!q('.axo-cond'));
if (RX) t('(rx) en la última lámina el botón dice «Entendido»', /Entendido/.test(q('[data-ax="onb-next"]').textContent));
q('[data-ax="onb-go"][data-i="0"]').click();
t('tocar un punto devuelve a esa pantalla', !!q('.axo-ruta'));

if (RX) {
  console.log('\n── (rx) deslizar (pointerdown / pointerup, 40 px) ──');
  const wel = () => q('.rx-wel');
  ptr(wel(), 'pointerdown', 300); ptr(wel(), 'pointerup', 200);
  t('deslizar a la izquierda pasa a la siguiente', window.Auxiliar.state.onbStep === 1 && !!q('.axo-punto'));
  ptr(wel(), 'pointerdown', 300); ptr(wel(), 'pointerup', 280);
  t('menos de 40 px no cuenta', window.Auxiliar.state.onbStep === 1);
  ptr(wel(), 'pointerdown', 300); ptr(wel(), 'pointerup', 200);
  ptr(wel(), 'pointerdown', 300); ptr(wel(), 'pointerup', 200);
  t('en la última lámina deslizar no se pasa al permiso (go() recorta a 0…2)', window.Auxiliar.state.onbStep === 2 && !!q('.axo-cond'));
  ptr(wel(), 'pointerdown', 100); ptr(wel(), 'pointerup', 260);
  t('a la derecha vuelve', window.Auxiliar.state.onbStep === 1);
  window.Auxiliar.back();
  t('el atrás del teléfono también vuelve (y recrea la lámina)', window.Auxiliar.state.onbStep === 0 && !!q('.axo-ruta') && q('.rx-wel-art').classList.contains('rx-anim'));
}

const obW = RX ? q('.rx-ob') : null;
window.Auxiliar.state.onbStep = 3; window.Auxiliar.rerender();
t('al final se pide el permiso, con el motivo delante', /Te avisamos/.test(txt()) && /Cuando te asignen conductor/.test(txt()));
if (RX) {
  console.log('\n── (rx) RxNotif ──');
  const obN = q('.rx-ob[data-ob="notif"]');
  t('key={rx.phase}: el .rx-ob es NUEVO y anima (.rx-anim)', !!obN && obN !== obW && obN.classList.contains('rx-anim'));
  t('.rx-scr.rx-center con .rx-bell-big (campana + dos anillos), .rx-c-h y .rx-c-p',
    !!q('.rx-center .rx-bell-big svg') && qa('.rx-bell-big i').length === 2 && !!q('.rx-center h1.rx-c-h') && !!q('.rx-center p.rx-c-p'));
  const demo = q('.rx-demo-push');
  t('el ejemplo es un aviso REAL de la app (el de «Conductor asignado»), sin nombres', !!demo && !!demo.querySelector('.rx-push-ic svg')
    && /Conductor asignado/.test(demo.textContent) && /Ya tienes conductor para tu traslado/.test(demo.textContent));
  t('«Activar notificaciones» y «Ahora no» en .rx-foot.abs (onb-allow / onb-later)',
    /Activar notificaciones/.test(q('.rx-foot.abs .rx-btn.pri[data-ax="onb-allow"]')?.textContent || '') && !!q('.rx-foot.abs .rx-btn.ghost[data-ax="onb-later"]'));
  t('sin datos inventados', prohibidos().length === 0, prohibidos().join(', '));
  window.Auxiliar.back();
  t('atrás desde el permiso vuelve a las láminas (el .rx-ob se recrea otra vez)', q('.rx-ob[data-ob="welcome"]') && q('.rx-ob').classList.contains('rx-anim') && window.Auxiliar.state.onbStep === 2);
  window.Auxiliar.state.onbStep = 3; window.Auxiliar.rerender();
}
q('[data-ax="onb-later"]').click();
await new Promise(r => setTimeout(r, 40));
t('«Ahora no» entra a la app igual', window.Auxiliar.state.view === 'home');
if (RX) t('(rx) y la bienvenida se va: vuelven la base y las pestañas', !q('.rx-full[data-scr="onboarding"]') && !q('.rx-base').classList.contains('rx-nobase'));

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
await wait();
t('Perfil ofrece verla otra vez', !!q('[data-ax="onb-again"]'), txt().slice(0, 200));
q('[data-ax="onb-again"]').click();
await wait();
t('y se abre', window.Auxiliar.state.view === 'onboarding' && !!q('.axo-ruta'));
if (RX) t('(rx) con el aspecto del diseño', !!q('.rx-full[data-scr="onboarding"] .rx-wel .rx-wel-art .axo-ruta'));

console.log('\n── «Algo no va bien» (support) ──');
window.Auxiliar.state.view = 'support'; window.Auxiliar.rerender();
await wait();
t('se pinta con sus dos caminos', /No me llegan los avisos/.test(txt()) && !!q('[data-ax="sup-push"]'));
if (RX) {
  t('(rx) es una capa del shell (data-scr="support") con RxHead y «Volver» (rx-pop)', !!q('.rx-layer[data-scr="support"] .rx-head [data-rx="rx-pop"]'));
  t('(rx) filas del diseño (.rx-group .rx-row)', !!q('[data-scr="support"] .rx-group .rx-row[data-ax="sup-push"]'));
  t('(rx) «Escribir a Coordinación» abre Coordinación (data-rx="open-coord")', /Escribir a Coordinación/.test(q('[data-scr="support"] [data-rx="open-coord"]')?.textContent || ''));
  t('(rx) sin nombres ni «24/7» (D11)', prohibidos().length === 0, prohibidos().join(', '));
  t('(rx) sin «la cuenta la creó la operación» (ya no es cierto: hay registro propio)', !/creó la operación/.test(txt()));
  q('[data-scr="support"] [data-rx="rx-pop"]').click();
  await wait();
  t('(rx) «Volver» lleva a Perfil', window.Auxiliar.state.view === 'perfil');
} else {
  t('sin el rediseño sigue siendo la pantalla de siempre', !!q('[data-ax="sup-close"]'));
}

console.log('\n── la marca vieja del navegador ya no manda ──');
// Era UNA sola llave para todo el aparato. Como las tres pantallas se rehicieron
// enteras el 7-sep, quien vio las de antes no ha visto estas: se le muestran una
// vez. Lo que NO puede pasar es que esa marca deje sin bienvenida a una cuenta
// nueva, que fue el caso real.
window.localStorage.clear();
window.localStorage.setItem('rendio.aux.rx', RX ? '1' : '0');
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
t('sin errores en consola', errores.length === 0, errores.slice(0, 3).join(' | '));

console.log(`\n${ok}/${ok + bad} pasaron${bad ? ' · ' + bad + ' FALLARON' : ''}`);
console.log('NO cubierto: el movimiento. jsdom no anima ni dibuja — que el avión trace la');
console.log('línea, que la lámina entre con rxFade, que los puntos se estiren y que todo');
console.log('quede centrado solo se ve en un navegador de verdad. Tampoco el permiso real');
console.log('del navegador (enablePush) ni el gesto de deslizar con el dedo en un teléfono.');
process.exit(bad ? 1 : 0);
