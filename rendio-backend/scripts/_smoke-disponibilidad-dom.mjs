// DISPONIBILIDAD DEL CONDUCTOR — el ciclo por toque (decisión de la profa, 15-sep-2026).
//
// Lo que se comprueba, con scheduler.js + driver-disponibilidad.js + driver-tabs.js
// reales sobre el index.html de verdad:
//   · la semana nace PROPUESTA en «Puedo» (verde punteado) y eso NO es guardado
//   · cada toque rota Puedo → Prefiero no → No puedo → Puedo; el arrastre copia
//     el estado de la primera celda; tocar el día rota mañana y tarde
//   · «Confirmar mi semana» pide el motivo de los «No puedo» UNA vez y manda
//     'available' en lo propuesto; el descanso fijo queda 'unset'
//   · tocar el velo (fuera de la hoja) NO guarda ni cambia nada
//   · si el guardado falla, la pantalla no dice que se guardó
//   · en semana cerrada no se propone nada y las flechas siguen vivas
//
// Lo de siempre: jsdom NO hace layout ni aplica pointer-events. Lo de las flechas
// se comprueba por estructura (no quedan dentro de .rc-readonly); cómo se siente
// arrastrar el dedo se mira en el teléfono.
//
// REQUIERE jsdom (no está en el repo, es solo para probar):
//   cd rendio-backend && npm install --no-save jsdom
//   node scripts/_smoke-disponibilidad-dom.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const dom = new JSDOM(readFileSync(APP + 'index.html', 'utf8'),
  { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom; global.window = window; global.document = window.document;
window.RENDIO_CONFIG = {}; window.toast = () => {};

let ok = 0, bad = 0;
const t = (n, c, d = '') => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d ? ' → ' + d : '')); } };
const wait = (ms = 20) => new Promise(r => setTimeout(r, ms));

// Lo que en la app ponen core.js, horario.js, admin-disponibilidad.js y
// driver-home.js. reopenInfo/weekAvailClosed/hhmmCO son copia de horario.js.
window.eval(`
  var state = { profile: { id: 'd1', full_name: 'Demo Conductor', email: 'demo@x' },
                currentWeek: null, ownAvail: {}, settings: {} };
  var __saves = [], __nav = [], __failNext = false, __suspended = false;
  function $(s) { return document.querySelector(s); }
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function isSuspended() { return __suspended; }
  function firstNameOf(p) { return ((p && p.full_name) || '').trim().split(/\\s+/)[0]; }
  function weekLabelES(startISO) { return startISO; }
  function strikeLimit() { return 3; }
  function getGreetingPrefix() { return 'Hola'; }
  function updateDriverGreeting() {}
  function reopenInfo(weekStartISO) {
    const s = state.settings || {};
    if (s.reopen_week_start === weekStartISO && s.reopen_until) {
      const until = new Date(s.reopen_until).getTime();
      if (Date.now() < until) return { active: true, until };
    }
    return { active: false, until: 0 };
  }
  function weekAvailClosed(weekStartISO) {
    if (!Scheduler.availabilityClosed(weekStartISO)) return false;
    return !reopenInfo(weekStartISO).active;
  }
  var hhmmCO = ts => new Date(ts).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: true });
  function navigateDriverWeek(d) { __nav.push(d); }
  function setDriverTab() {}
  // Como la de verdad: vuelve a leer de la BD (aquí, lo último que se guardó) y repinta.
  async function refreshDriverView() {
    const last = __saves[__saves.length - 1];
    if (last) state.ownAvail = JSON.parse(JSON.stringify(last.map));
    renderDriverDays();
  }
  var Api = {
    saveDriverWeekAvailability: async (pid, week, map) => {
      if (__failNext) { __failNext = false; throw new Error('sin red'); }
      __saves.push({ pid, week, map: JSON.parse(JSON.stringify(map)) });
    },
  };
`);
// Un const de nivel superior dentro de window.eval NO queda global (en el navegador,
// entre <script> clásicos, sí). Para poder reiniciar avUI entre escenarios se le
// cuelga un gancho dentro del MISMO eval; el archivo de la app no se toca.
for (const f of ['scheduler.js', 'driver-disponibilidad.js', 'driver-tabs.js'])
  window.eval(readFileSync(APP + f, 'utf8') + (f === 'driver-disponibilidad.js' ? '\n;window.__avUI = avUI;' : ''));
const W = window;
const S = W.Scheduler;
const st = () => W.eval('state');
const saves = () => W.eval('__saves');

// Semanas relativas a HOY: una que seguro está abierta y otra que seguro cerró.
const lunes = S.startOfWeekISO(new Date());
const ABIERTA = S.addDays(lunes, 14), CERRADA = S.addDays(lunes, -7);
// Descanso fijo del conductor: domingo entero y sábado tarde.
S.setRules({ d1: new Set(['sun-am', 'sun-pm', 'sat-pm']) });

const $ = (s) => document.querySelector(s);
const cell = (id) => $(`[data-cell="${id}"]`);
const ds = (id) => cell(id)?.dataset.s;
const dp = (id) => cell(id)?.dataset.p;
const txt = (s) => ($(s)?.textContent || '').replace(/\s+/g, ' ').trim();
// jsdom no implementa elementFromPoint: devolvemos la celda que "está bajo el dedo".
let bajoElDedo = null;
document.elementFromPoint = () => bajoElDedo;
const ptr = (type, id) => {
  bajoElDedo = cell(id);
  (bajoElDedo || $('#av-grid')).dispatchEvent(new W.MouseEvent(type, { bubbles: true, clientX: 1, clientY: 1 }));
};
const tap = (id) => { ptr('pointerdown', id); ptr('pointerup', id); };
const velo = () => W.eval('avCloseSheet(false)');   // lo que hace core.js al tocar #av-back

function abrir(week, ownAvail = {}) {
  Object.assign(W.__avUI, { dirty: false, saved: false, sheet: null });
  W.eval('__saves.length = 0');
  st().currentWeek = week;
  st().ownAvail = JSON.parse(JSON.stringify(ownAvail));
  W.eval('renderDriverDays()');
}
const MARCABLES = S.DAYS.flatMap(d => ['am', 'pm'].map(s => `${d}-${s}`)).filter(id => !['sun-am', 'sun-pm', 'sat-pm'].includes(id));

console.log('\n── semana abierta, nada guardado: nace propuesta en «Puedo» ──');
abrir(ABIERTA);
t('la raíz ya no lleva rc-readonly', $('#driver-avail-root').className === 'rc', $('#driver-avail-root').className);
t('no queda brocha ni «Limpiar»', !$('#av-brush') && !$('#av-clear'));
t('la fila de arriba es leyenda (3, aria-hidden, sin botones)',
  document.querySelectorAll('.av-legend .av-legend-it').length === 3 && $('.av-legend').getAttribute('aria-hidden') === 'true' && !$('.av-legend button'));
t('las 11 jornadas marcables salen en «Puedo» punteado', MARCABLES.every(id => ds(id) === 'puedo' && dp(id) === '1'),
  MARCABLES.filter(id => !(ds(id) === 'puedo' && dp(id) === '1')).join(','));
t('el descanso fijo sale fijo y sin punteado', ['sun-am', 'sun-pm', 'sat-pm'].every(id => ds(id) === 'lock' && dp(id) === ''));
t('el medidor también va punteado', document.querySelectorAll('#av-meter i[data-p="1"]').length === 11);
t('la franja dice «Sin confirmar»', txt('#av-left') === 'Sin confirmar', txt('#av-left'));
t('el botón dice «Confirmar mi semana» y está activo', txt('#av-save') === 'Confirmar mi semana' && !$('#av-save').disabled, txt('#av-save'));
t('la nota avisa que el jefe no cuenta con él', /Hasta que confirmes, tu jefe no cuenta contigo/.test(txt('#av-save-note')));
t('el subtítulo explica el arranque', /arrancas disponible toda la semana/.test(txt('#driver-avail-root')));
t('la pista dice que arranca en Puedo', /Estás en «Puedo» toda la semana/.test(txt('#av-hint')));
t('la home pide confirmar', W.eval('availabilitySummaryText()').startsWith('Confirma tu semana'));
W.eval('avUpdateNavBadge(0)');
t('la pestaña lleva el «!»', txt('#driver-nav [data-dtab="avail"] .dnav-dot') === '!');
W.eval('renderDriverHomeNudge()');
t('el empujón de la home: «Tu semana todavía no está confirmada»', /Tu semana todavía no está confirmada/.test(txt('#driver-home-nudge')));
t('ver la pantalla NO guarda nada', saves().length === 0 && JSON.stringify(st().ownAvail) === '{}');

console.log('\n── un toque rota la jornada ──');
tap('mon-am');
t('1er toque: Prefiero no (ya no punteado)', ds('mon-am') === 'pref' && dp('mon-am') === '' && st().ownAvail.mon.am === 'prefer_rest');
t('la pista explica lo que acaba de pasar', /^Prefiero no\./.test(txt('#av-hint')), txt('#av-hint'));
tap('mon-am');
t('2º toque: No puedo', ds('mon-am') === 'no' && st().ownAvail.mon.am === 'unavailable');
t('pintar el rojo NO abre la hoja de motivo', !$('#av-sheet').classList.contains('open'));
tap('mon-am');
t('3er toque: vuelve a Puedo, ya elegido (sin punteado)', ds('mon-am') === 'puedo' && dp('mon-am') === '' && st().ownAvail.mon.am === 'available');
t('la vecina no se tocó', ds('mon-pm') === 'puedo' && dp('mon-pm') === '1');
t('tocar el descanso fijo no hace nada', (tap('sun-am'), ds('sun-am') === 'lock' && !st().ownAvail.sun));
t('sigue «Sin confirmar»: quedan jornadas propuestas', txt('#av-left') === 'Sin confirmar');

console.log('\n── arrastrar copia el estado de la primera celda ──');
ptr('pointerdown', 'tue-am'); ptr('pointermove', 'tue-pm'); ptr('pointermove', 'wed-am'); ptr('pointermove', 'sat-pm'); ptr('pointerup', 'wed-am');
t('las tres del trazo quedan en Prefiero no', ['tue-am', 'tue-pm', 'wed-am'].every(id => ds(id) === 'pref'));
t('el descanso fijo del trazo no cambia', ds('sat-pm') === 'lock');
t('la de al lado sigue propuesta', ds('wed-pm') === 'puedo' && dp('wed-pm') === '1');

console.log('\n── tocar el día rota mañana y tarde ──');
$('.av-day[data-day="thu"]').click();
t('jueves: las dos a Prefiero no', ds('thu-am') === 'pref' && ds('thu-pm') === 'pref');
$('.av-day[data-day="thu"]').click();
t('otra vez: las dos a No puedo', ds('thu-am') === 'no' && ds('thu-pm') === 'no');

console.log('\n── confirmar: el motivo se pide UNA vez y se guarda todo ──');
$('#av-save').click(); await wait();
t('no guarda todavía: primero el motivo', saves().length === 0);
t('abre la hoja con las dos jornadas del jueves', $('#av-sheet').classList.contains('open') && (txt('.rc-sheet-sub').match(/·/g) || []).length === 3, txt('.rc-sheet-sub'));
t('el botón dice «Pedir permiso y confirmar»', txt('#av-sheet-ok') === 'Pedir permiso y confirmar');
$('#av-chips [data-chip="Cita médica"]').click();
$('#av-sheet-ok').click(); await wait();
t('guardó una sola vez', saves().length === 1, saves().length);
const m = saves()[0]?.map || {};
t('manda los 7 días', S.DAYS.every(d => m[d]));
t('lo propuesto viaja como available', m.wed.pm === 'available' && m.fri.am === 'available' && m.sat.am === 'available');
t('lo elegido viaja como se eligió', m.mon.am === 'available' && m.tue.am === 'prefer_rest' && m.tue.pm === 'prefer_rest' && m.wed.am === 'prefer_rest');
t('el No puedo viaja con su motivo', m.thu.am === 'unavailable' && m.thu.am_reason === 'Cita médica' && m.thu.pm_reason === 'Cita médica');
t('el descanso fijo viaja unset', m.sun.am === 'unset' && m.sun.pm === 'unset' && m.sat.pm === 'unset');
t('queda «Semana confirmada»', txt('#av-left') === 'Semana confirmada', txt('#av-left'));
t('el botón queda en «Guardado»', /Guardado/.test(txt('#av-save')));
t('ya nada va punteado', !document.querySelector('.av-cell[data-p="1"]'));
t('la home ya no pide confirmar', /confirmada/.test(W.eval('availabilitySummaryText()')));
W.eval('avUpdateNavBadge(0)');
t('el «!» se va', !$('#driver-nav [data-dtab="avail"] .dnav-dot'));
tap('fri-pm');
t('cambiar algo después dice «Sin guardar», no «confirmada»', txt('#av-left') === 'Sin guardar' && txt('#av-save') === 'Guardar cambios', txt('#av-left') + ' / ' + txt('#av-save'));

console.log('\n── tocar FUERA de la hoja no guarda ni cambia nada ──');
abrir(ABIERTA);
tap('fri-am'); tap('fri-am');
$('#av-save').click(); await wait();
t('(la hoja está abierta)', $('#av-sheet').classList.contains('open'));
velo(); await wait();
t('se cierra la hoja', !$('#av-sheet').classList.contains('open'));
t('NO guarda la semana', saves().length === 0, JSON.stringify(saves()[0]?.map?.fri));
t('el No puedo sigue siendo No puedo', ds('fri-am') === 'no' && st().ownAvail.fri.am === 'unavailable', ds('fri-am'));
t('y la semana sigue sin confirmar', txt('#av-left') === 'Sin confirmar');
$('#av-save').click(); await wait();
t('volver a confirmar vuelve a pedir el motivo', $('#av-sheet').classList.contains('open') && saves().length === 0);
$('#av-sheet-pref').click(); await wait();
t('«Mejor Prefiero no» sí es una decisión: guarda con prefer_rest', saves().length === 1 && saves()[0].map.fri.am === 'prefer_rest');

console.log('\n── si el guardado falla, la pantalla no miente ──');
abrir(ABIERTA);
W.eval('__failNext = true');
const errOrig = W.console.error; W.console.error = () => {};   // avSave lo registra: es lo esperado
$('#av-save').click(); await wait();
W.console.error = errOrig;
t('no quedó nada guardado', saves().length === 0);
t('muestra el error', /No se pudo guardar: sin red/.test(txt('#av-save-note')));
t('el botón vuelve a «Confirmar mi semana» y activo', txt('#av-save') === 'Confirmar mi semana' && !$('#av-save').disabled);
t('lo propuesto sigue propuesto (la copia no tocó el estado)', MARCABLES.every(id => !st().ownAvail[id.split('-')[0]] || st().ownAvail[id.split('-')[0]][id.split('-')[1]] === 'unset'));

console.log('\n── semana ya guardada a medias (de antes del cambio) ──');
abrir(ABIERTA, { mon: { am: 'available', pm: 'unset' }, tue: { am: 'unavailable', pm: 'prefer_rest', am_reason: 'Estudio' } });
t('lo guardado se ve tal cual y sin punteado', ds('mon-am') === 'puedo' && dp('mon-am') === '' && ds('tue-am') === 'no' && ds('tue-pm') === 'pref');
t('lo que nunca se guardó sale propuesto', ds('mon-pm') === 'puedo' && dp('mon-pm') === '1');
$('#av-save').click(); await wait();
t('un No puedo que ya tenía motivo no lo vuelve a pedir', saves().length === 1 && saves()[0].map.tue.am_reason === 'Estudio');

console.log('\n── semana cerrada: nada propuesto y las flechas vivas ──');
abrir(CERRADA);
t('la raíz no está bloqueada', $('#driver-avail-root').className === 'rc');
t('las flechas quedan FUERA del bloque bloqueado', !$('#av-prev').closest('.rc-readonly') && !$('#av-next').closest('.rc-readonly'));
t('la grilla sí queda dentro', !!$('#av-grid').closest('.rc-readonly'));
t('no se propone nada: «Sin marcar» de verdad', MARCABLES.every(id => ds(id) === 'none' && dp(id) === '1'));
t('el aviso dice a dónde ir', /Toca la flecha ▸/.test(txt('#driver-avail-root')));
t('la pista no dice «Estás en Puedo» (sería mentira)', txt('#av-hint') === 'Así quedó esta semana.', txt('#av-hint'));
t('guardar está bloqueado', /Semana cerrada — no se puede guardar/.test(txt('.rc-blocked')) && !$('#av-save'));
$('#av-next').click();
t('la flecha ▸ navega', W.eval('__nav').at(-1) === 7);
await W.eval('avSave()');
t('avSave no manda nada en semana cerrada', saves().length === 0);

console.log('\n── semana cerrada pero reabierta por el jefe ──');
st().settings = { reopen_week_start: CERRADA, reopen_until: new Date(Date.now() + 3600e3).toISOString() };
abrir(CERRADA);
t('vuelve a proponer «Puedo»', MARCABLES.every(id => ds(id) === 'puedo'));
t('el aviso dice que la reabrió', /reabrió la semana/.test(txt('#driver-avail-root')));
st().settings = {};

console.log('\n── cuenta suspendida ──');
W.eval('__suspended = true');
abrir(ABIERTA);
t('no propone nada y bloquea la grilla', MARCABLES.every(id => ds(id) === 'none') && !!$('#av-grid').closest('.rc-readonly'));
t('ni dice «Estás en Puedo»', txt('#av-hint') === 'Así quedó esta semana.');
W.eval('__suspended = false');

console.log(`\n${ok}/${ok + bad} pasaron`);
console.log('NO cubierto: el arrastre con el dedo en un teléfono de verdad, la cabecera pegajosa y el\n' +
  'punteado a la vista (jsdom no hace layout ni aplica pointer-events) — se mira en el teléfono.');
process.exit(bad ? 1 : 0);
