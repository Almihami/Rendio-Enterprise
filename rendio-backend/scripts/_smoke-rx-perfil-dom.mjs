// P7 · PERFIL del rediseño del auxiliar (27-sep-2026) — prueba jsdom.
//
// Carga la app real (index.html + api.js + api-aux.js + aux-rx-ui.js +
// aux-shell.js + aux-residencias.js + aux-privado.js + aux-presentacion.js +
// aux-rx-perfil.js + auxiliar.js) y monta los escenarios de
// fixtures/aux-escenarios.js (P9): ninguna llamada sale a la red (window.sb es
// una trampa que anota cualquier uso).
//
// Comprueba la aceptación de P7 (plan final §3.10):
//   · teléfono y «Auxiliar · Avianca · desde mar 2026» con Auxiliar.header (H);
//   · «Cambiar mi contraseña» solo si existe openCambiarMiClave;
//   · Apariencia cambia data-ax-night, SIN repintar la pestaña (patch + segSet:
//     el indicador es el mismo nodo, así su transición de .35 s corre);
//   · #ax-pwa-bar presente — en la hoja «Notificaciones y app», porque la base
//     no puede llevar ids de §2.4 (regla #10; el shell lo vigila);
//   · Pagos, Puntos e Invitar dicen «Todavía no disponible» (Puntos e Invitar sin flecha);
//   · escribir el punto de encuentro no cambia Auxiliar.state.form, y guardarlo
//     llama a ApiAux.saveMyPrefs({meetingPoint});
//   · Nivel preferido → hoja → saveMyPrefs({preferredLevel});
//   · Mi residencia (#27): pila 'residence' con estado propio → buscar → hoja →
//     Api.saveMyResidence; el pedido (state.form) no se toca; la segunda unidad
//     es de solo lectura;
//   · cifras: getMyStats (done, % a tiempo con n ≥ 5), «—» y «aún sin datos»;
//     cuadrícula de 2 con Puntos apagado; entrada escalonada .rx-in --d 1·2·3;
//   · sin textos prohibidos; con la bandera APAGADA, el Perfil de siempre.
//
// LO QUE NO CUBRE: jsdom no hace layout ni corre animaciones (no prueba que el
// indicador se deslice de verdad, ni rxRise, ni el conteo visible de RxCount,
// ni cómo se ve en 390 px claro/nocturno), no hay push real (auxSetupPwa no
// encuentra service worker: la barra queda oculta), ni el selector de P5
// (AuxResidencias.pickerHTML) si aún no existe: se prueba el selector propio.
//
//   cd rendio-backend && node scripts/_smoke-rx-perfil-dom.mjs
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const APP = new URL('../../rendio-turnos/', import.meta.url).pathname;
const read = (f) => readFileSync(APP + f, 'utf8');
const FIX = readFileSync(new URL('./fixtures/aux-escenarios.js', import.meta.url), 'utf8');
let ok = 0, bad = 0;
// Un rechazo sin atender de OTRO módulo (p. ej. aux-residencias.js a medio
// escribir por su paquete) no debe tumbar la prueba entera: se anota y se
// muestra al final como ⚠, con su pila, para que se vea de dónde vino.
const rechazos = [];
process.on('unhandledRejection', (e) => { rechazos.push((e && e.stack ? e.stack.split('\n').slice(0, 2).join(' · ') : String(e))); });
const t =(n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d != null && d !== '' ? ' → ' + d : '')); } };
const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));
const PROHIBIDOS = ['Carlos Mejía', 'Laura', 'AV9525', 'Juliana', 'Plan B', '24/7', 'en línea', 'Último cupo', 'Siempre hay cupo',
  'kit', 'Preparado', 'Esta noche te avisamos', '38 auxiliares', '$ XX', 'XX.XXX'];
// «Laura» es el nombre del escenario (Laura Gómez Ruiz): se revisa el HTML sin el nombre real del perfil.
const prohibidos = (html, sin = []) => {
  let h = html; sin.forEach(s => { h = h.split(s).join(''); });
  const txt = h.replace(/<[^>]+>/g, ' ');
  return PROHIBIDOS.filter(p => txt.includes(p)).concat(/\$\s?\d/.test(txt) ? ['$cifra'] : []);
};

async function boot(rx) {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const errors = [];
  w.console.error = (...a) => { errors.push(a.map(x => (x && x.message) || String(x)).join(' ')); };
  w.addEventListener('error', (e) => errors.push(e.message));
  w.RENDIO_CONFIG = {}; w.toast = () => {}; w.L = undefined;
  w.escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const red = [];
  const trampa = new Proxy(function () {}, {
    get: (_, k) => { if (k === 'then') return undefined; red.push(String(k)); return trampa; },
    apply: () => { red.push('()'); return trampa; },
  });
  w.sb = trampa;
  w.state = { settings: {} };
  w.localStorage.setItem('rendio.aux.rx', rx ? '1' : '0');
  w.localStorage.setItem('rendio.aux.onboarded', '1');
  for (const f of ['api.js', 'api-aux.js', 'aux-rx-ui.js', 'aux-shell.js', 'aux-residencias.js', 'aux-privado.js', 'aux-presentacion.js',
    'aux-rx-perfil.js', 'auxiliar.js']) {
    try { w.eval(read(f)); } catch (e) { errors.push(f + ': ' + e.message); }
  }
  try { w.AuxPresentacion && w.AuxPresentacion.markOnboarded && w.AuxPresentacion.markOnboarded(); } catch (_) { /* */ }
  w.eval(FIX);
  const E = w.AuxEscenarios, A = w.Auxiliar, AS = w.AuxShell;
  const d = E.montar('historial');
  red.length = 0;
  await A.init(d.profile).catch((e) => errors.push('init: ' + e.message));
  await wait(40);
  const ui = () => w.document.getElementById('auxiliar-ui');
  const q = (s) => ui().querySelector(s);
  const qa = (s) => [...ui().querySelectorAll(s)];
  const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  const type = (el, v) => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
  return { w, E, A, AS, errors, red, ui, q, qa, click, type };
}

const meEl = (b) => b.q('.rx-tabview[data-scr="me"]');
const row = (b, k) => b.q(`.rx-tabview[data-scr="me"] [data-me="${k}"]`);
const sub = (el) => (el && el.querySelector('.rx-row-tx > span') ? el.querySelector('.rx-row-tx > span').textContent : null);
const llamadas = (b, fn) => b.E.llamadas.filter(x => x.fn === fn);

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Bandera ENCENDIDA: la pestaña Perfil ──');
{
  const b = await boot(true);
  const { w, E, A, AS } = b;
  t('el shell está encendido y registra «me» y «residence»', AS.on() && AS.registered('me') && AS.registered('residence'));
  E.montar('historial');
  AS.setTab('perfil');
  await wait(60);
  const me = meEl(b);
  t('Perfil pinta la pestaña «me» (no el «todavía no disponible» del shell)', !!me && !!me.querySelector('.rx-me-hero') && !/Todavía no disponible<\/b><span>Esta pantalla/.test(me.innerHTML));
  t('estructura del diseño: rx-body me · hero .rx-in · 3 rx-group .rx-in con --d 1·2·3',
    !!me.querySelector('.rx-scr > .rx-body.me') && me.querySelector('.rx-me-hero').classList.contains('rx-in')
    && [...me.querySelectorAll('.rx-group.rx-in')].map(g => g.style.getPropertyValue('--d')).join(',') === '1,2,3');
  t('rótulos: Tus viajes · Beneficios · Ayuda y ajustes', [...me.querySelectorAll('.rx-lbl')].map(x => x.textContent).join('|') === 'Tus viajes|Beneficios|Ayuda y ajustes');
  t('nombre del perfil en el hero', me.querySelector('.rx-me-hero h1').textContent === 'Laura Gómez Ruiz');
  t('«Auxiliar · Avianca · desde mar 2026» sale de H (Auxiliar.header)', row(b, 'line').textContent === 'Auxiliar · Avianca · desde mar 2026', row(b, 'line').textContent);
  t('avatar xl con las iniciales', me.querySelector('.rx-me-hero .rx-av.xl').textContent === 'LR');
  t('teléfono del perfil: 300 123 4567', sub(row(b, 'row-phone')) === '300 123 4567', sub(row(b, 'row-phone')));
  t('Mi residencia: H.residence + unidad', sub(row(b, 'row-res')) === 'El Olivar · Torre 2 · 504', sub(row(b, 'row-res')));
  t('Mi residencia abre la pila (data-rx="open-residence")', row(b, 'row-res').getAttribute('data-rx') === 'open-residence');
  t('Nivel preferido sin elegir (H.preferredLevel null) → «Sin elegir»', sub(row(b, 'row-level')) === 'Sin elegir');
  t('Punto de encuentro vacío → opcional', /^Opcional/.test(sub(row(b, 'row-meet'))));
  t('Pagos y mensualidad: «Todavía no disponible» y lleva a la pestaña', sub(row(b, 'row-pay')) === 'Todavía no disponible' && row(b, 'row-pay').getAttribute('data-rx') === 'rx-tab' && row(b, 'row-pay').getAttribute('data-tab') === 'pagos');
  const pts = row(b, 'row-points'), inv = row(b, 'row-invite');
  t('Puntos e Invitar: «Todavía no disponible», sin flecha y sin acción',
    sub(pts) === 'Todavía no disponible' && sub(inv) === 'Todavía no disponible'
    && !pts.querySelector('use[href="#rx-ChevronRight"]') && !inv.querySelector('use[href="#rx-ChevronRight"]')
    && !pts.hasAttribute('data-rx') && !inv.hasAttribute('data-rx') && pts.tagName === 'DIV' && pts.classList.contains('static'));
  t('Rendio Select → open-select desde «me», sin «kit»', row(b, 'row-select').getAttribute('data-rx') === 'open-select' && row(b, 'row-select').getAttribute('data-from') === 'me' && !/kit/i.test(row(b, 'row-select').textContent));
  t('Coordinación sin nombre ni 24/7: «Escríbele a la operación» sin horario cargado', sub(row(b, 'row-coord')) === 'Escríbele a la operación' && row(b, 'row-coord').getAttribute('data-rx') === 'open-coord');
  t('la pestaña NO lleva #ax-pwa-bar (regla #10: la base no trae ids de §2.4)', !me.querySelector('#ax-pwa-bar'));
  t('fila «Notificaciones y app» (data-rx="me-pwa")', row(b, 'row-pwa') && row(b, 'row-pwa').getAttribute('data-rx') === 'me-pwa' && /Notificaciones y app/.test(row(b, 'row-pwa').textContent));
  b.click(row(b, 'row-pwa'));
  await wait(40);
  const pwaSh = b.q('.rx-sheet');
  t('#ax-pwa-bar presente (en la hoja del shell), con enable-push e install',
    !!pwaSh && !!pwaSh.querySelector('#ax-pwa-bar [data-ax="enable-push"]') && !!pwaSh.querySelector('#ax-pwa-bar [data-ax="install"]') && b.qa('#ax-pwa-bar').length === 1);
  t('sin push ni instalación posibles (jsdom): la barra queda oculta y la hoja lo dice', pwaSh && pwaSh.querySelector('#ax-pwa-bar').classList.contains('hidden') && !pwaSh.querySelector('[data-me-pwa-none]').hidden
    && /navegador no deja activar/.test(pwaSh.querySelector('[data-me-pwa-none]').textContent));
  t('la fila dice el estado sin inventar: «No disponibles en este navegador»', sub(row(b, 'row-pwa')) === 'No disponibles en este navegador', sub(row(b, 'row-pwa')));
  b.click(pwaSh.querySelector('[data-rx="sheet-close"]'));
  await wait(260);
  t('«Listo» cierra la hoja (.out a 220 ms) y #ax-pwa-bar se va con ella', !b.q('.rx-sheet-bg') && !b.q('#ax-pwa-bar'));
  t('Ver la bienvenida (onb-again), Algo no va bien (support), Cerrar sesión (logout)',
    !!me.querySelector('[data-ax="onb-again"]') && !!me.querySelector('[data-ax="support"]') && !!me.querySelector('[data-ax="logout"]'));
  t('sin openCambiarMiClave NO hay «Cambiar mi contraseña»', !me.querySelector('[data-ax="change-pw"]'));
  t('orden de «Ayuda y ajustes»: Coordinación · Apariencia · pwa · bienvenida · soporte · salir',
    [...me.querySelectorAll('.rx-group')][2].textContent.replace(/\s+/g, ' ').match(/Coordinación.*Apariencia.*Notificaciones y app.*Ver la bienvenida.*Algo no va bien.*Cerrar sesión/) != null);

  // Cifras
  await wait(900);
  const cel = (k) => me.querySelector(`[data-me="${k}"]`);
  t('cifras: cuadrícula de 2 (Puntos apagado)', me.querySelector('.rx-me-stats').classList.contains('two') && me.querySelectorAll('.rx-me-stats > div').length === 2);
  const s0 = E.datos('historial').stats;
  t(`historial: viajes = getMyStats().done (${s0.done}) y % a tiempo (${s0.onTimePct}%, n=${s0.onTimeN})`,
    cel('st-done').querySelector('b').textContent === String(s0.done)
    && cel('st-ontime').querySelector('b').textContent === (s0.onTimePct == null ? '—' : Math.round(s0.onTimePct) + '%'),
    cel('st-done').outerHTML + ' ' + cel('st-ontime').outerHTML);
  w.ApiAux.getMyStats = async () => ({ done: 3, onTimePct: null, onTimeN: 2, on_time_pct: null, on_time_n: 2 });
  AS.setTab('inicio'); await wait(20);
  AS.setTab('perfil'); await wait(900);
  t('menos de 5 salidas medidas (onTimePct null): «—» + «aún sin datos», y 3 viajes',
    meEl(b).querySelector('[data-me="st-ontime"] b').textContent === '—' && /aún sin datos/.test(meEl(b).querySelector('[data-me="st-ontime"]').textContent)
    && meEl(b).querySelector('[data-me="st-done"] b').textContent === '3');

  // Stats con datos: se recargan al entrar y cuentan hasta el número (RxCount).
  w.ApiAux.getMyStats = async () => ({ done: 48, onTimePct: 98, onTimeN: 30, on_time_pct: 98, on_time_n: 30 });
  AS.setTab('inicio'); await wait(20);
  AS.setTab('perfil'); await wait(950);
  const me2 = meEl(b);
  t('con datos: 48 viajes y 98% a tiempo (tras el conteo)', me2.querySelector('[data-me="st-done"] b').textContent === '48' && me2.querySelector('[data-me="st-ontime"] b').textContent === '98%',
    me2.querySelector('.rx-me-stats').textContent);
  w.ApiAux.getMyStats = async () => null;
  AS.setTab('inicio'); await wait(20);
  AS.setTab('perfil'); await wait(60);
  t('getMyStats null → «—» y «aún sin datos» en las dos', [...meEl(b).querySelectorAll('.rx-me-stats b')].every(x => x.textContent === '—') && meEl(b).querySelectorAll('.rx-me-nodata').length === 2);

  // Contraseña
  w.openCambiarMiClave = () => { w.__pw = (w.__pw || 0) + 1; };
  AS.setTab('inicio'); await wait(20);
  AS.setTab('perfil'); await wait(40);
  const pw = meEl(b).querySelector('[data-ax="change-pw"]');
  t('con openCambiarMiClave aparece «Cambiar mi contraseña»', !!pw && /Cambiar mi contraseña/.test(pw.textContent));
  if (pw) { b.click(pw); await wait(10); }
  t('tocarla llama a openCambiarMiClave (data-ax="change-pw" de siempre)', w.__pw === 1);

  // Apariencia
  console.log('\n── Apariencia ──');
  const tab0 = meEl(b);
  const seg0 = tab0.querySelector('[data-me="theme-seg"]');
  const ind0 = seg0.querySelector('.rx-seg-ind');
  b.click(seg0.querySelector('[data-v="night"]'));
  await wait(20);
  t('Nocturno → #auxiliar-ui data-ax-night="on"', b.ui().getAttribute('data-ax-night') === 'on');
  t('sin repintar: misma pestaña, mismo segmentado, mismo indicador (su transición corre)',
    meEl(b) === tab0 && tab0.querySelector('[data-me="theme-seg"]') === seg0 && seg0.querySelector('.rx-seg-ind') === ind0 && ind0.style.transform === 'translateX(200%)', ind0.style.transform);
  t('el botón «Nocturno» queda .on y el subtítulo dice «Nocturno»', seg0.querySelector('[data-v="night"]').className === 'on' && tab0.querySelector('[data-me="theme-sub"]').textContent === 'Nocturno');
  t('la pestaña no se marcó .rx-noanim (no hubo repintado)', !tab0.querySelector('.rx-scrhost').classList.contains('rx-noanim'));
  b.click(seg0.querySelector('[data-v="light"]'));
  await wait(20);
  t('Claro → data-ax-night="off", indicador en 100 %', b.ui().getAttribute('data-ax-night') === 'off' && ind0.style.transform === 'translateX(100%)' && tab0.querySelector('[data-me="theme-sub"]').textContent === 'Claro');
  b.click(seg0.querySelector('[data-v="auto"]'));
  await wait(20);
  t('Automático → «Nocturno de 7:00 p. m. a 6:00 a. m.» y la preferencia guardada', tab0.querySelector('[data-me="theme-sub"]').textContent === 'Nocturno de 7:00 p. m. a 6:00 a. m.' && w.AuxPresentacion.themePref() === 'auto');

  // Punto de encuentro
  console.log('\n── Punto de encuentro (data-rx-field, estado propio) ──');
  A.state.form = { type: 'sal', notes: 'nota del pedido', flightNum: '9412' };
  const form0 = JSON.stringify(A.state.form);
  E.llamadas.length = 0;
  b.click(row(b, 'row-meet'));
  await wait(20);
  const inp = b.q('.rx-sheet [data-rx-field="meetingPoint"]');
  t('la hoja abre con un campo data-rx-field (no data-field)', !!inp && !b.q('.rx-sheet [data-field]'));
  b.type(inp, 'portería 2');
  await wait(10);
  t('escribir NO cambia Auxiliar.state.form', JSON.stringify(A.state.form) === form0, JSON.stringify(A.state.form));
  b.click(b.q('.rx-sheet [data-rx="me-meet-save"]'));
  await wait(40);
  const pm = llamadas(b, 'ApiAux.saveMyPrefs');
  t('Guardar llama a ApiAux.saveMyPrefs({meetingPoint:"portería 2"}) y nada más', pm.length === 1 && JSON.stringify(pm[0].args[0]) === '{"meetingPoint":"portería 2"}', JSON.stringify(pm));
  t('H.meetingPoint se actualiza y la fila lo muestra sin repintar', A.header.meetingPoint === 'portería 2' && sub(row(b, 'row-meet')) === 'portería 2' && meEl(b) === tab0);
  t('el pedido sigue intacto después de guardar', JSON.stringify(A.state.form) === form0);
  await wait(260);
  t('la hoja se cierra (.out a 220 ms)', !b.q('.rx-sheet-bg'));

  // Nivel preferido
  console.log('\n── Nivel preferido ──');
  E.llamadas.length = 0;
  b.click(row(b, 'row-level'));
  await wait(20);
  const lv = b.q('.rx-sheet [data-rx="pref-level"][data-v="shared"]');
  t('la hoja trae las tarjetas de nivel (RxLevelCard o AuxPrivado.levelsHTML) con «Nivel preferido»', !!lv && /Nivel preferido/.test(b.q('.rx-sheet h3').textContent));
  const sheetTxt = b.q('.rx-sheet').textContent;
  t('las tarjetas no traen precio, cupos ni kit', prohibidos(b.q('.rx-sheet').innerHTML).length === 0 && !/\$\s?\d/.test(sheetTxt), prohibidos(b.q('.rx-sheet').innerHTML).join(','));
  const priv = b.q('.rx-sheet .rx-lv.vip');
  t('en primicia (privado apagado) Privado no se puede elegir', !priv || priv.disabled || priv.classList.contains('off') || (priv.getAttribute('aria-disabled') === 'true' && priv.getAttribute('data-rx') !== 'pref-level'));
  if (priv) { b.click(priv); await wait(30); }
  t('tocar Privado en primicia no guarda nada', llamadas(b, 'ApiAux.saveMyPrefs').length === 0);
  if (lv) b.click(lv);
  await wait(40);
  const pl = llamadas(b, 'ApiAux.saveMyPrefs');
  t('tocar Compartido → saveMyPrefs({preferredLevel:"shared"})', pl.length === 1 && pl[0].args[0].preferredLevel === 'shared', JSON.stringify(pl));
  t('toast «Ahora pides en Compartido» y la fila dice Compartido', /Ahora pides en Compartido/.test((b.q('.rx-toast') || {}).textContent || '') && sub(row(b, 'row-level')) === 'Compartido');
  t('el pedido sigue intacto', JSON.stringify(A.state.form) === form0);
  await wait(260);
  // Sin las tarjetas de P6 (AuxPrivado.levelsHTML): las de respaldo, mismo marcado RxLevelCard.
  const lvP6 = w.AuxPrivado && w.AuxPrivado.levelsHTML;
  if (lvP6) delete w.AuxPrivado.levelsHTML;
  E.llamadas.length = 0;
  b.click(row(b, 'row-level'));
  await wait(20);
  const cards = b.qa('.rx-sheet .rx-lv');
  t('respaldo sin P6: 3 tarjetas .rx-lv.rx-in con --d 0·1·2, Compartido elegida', cards.length === 3 && cards.map(c => c.style.getPropertyValue('--d')).join(',') === '0,1,2' && cards[0].classList.contains('on'));
  t('respaldo: Directo apagado «Pronto», Privado apagado en primicia, sin cifras', cards[1] && cards[1].disabled && /Pronto/.test(cards[1].textContent) && cards[2].disabled && prohibidos(b.q('.rx-sheet').innerHTML).length === 0);
  const pv = b.q('.rx-sheet [data-rx="pref-level"][data-v="private"]');
  t('respaldo: Privado no tiene acción en primicia', !pv);
  b.click(b.q('.rx-sheet-bg')); await wait(260);
  if (lvP6) w.AuxPrivado.levelsHTML = lvP6;
  t('tocar el fondo cierra la hoja sin guardar', !b.q('.rx-sheet-bg') && llamadas(b, 'ApiAux.saveMyPrefs').length === 0);

  // Mi residencia: con la pantalla de P5 (si ya existe) y con la propia (P5 ausente).
  const AR = w.AuxResidencias;
  const p5 = AR && typeof AR.pickerScreenHTML === 'function' ? AR.pickerScreenHTML : null;
  const modos = p5 ? ['P5', 'propio'] : ['propio'];
  if (!p5) console.log('  · AuxResidencias.pickerScreenHTML no existe todavía: solo se prueba el selector propio');
  for (const modo of modos) {
    console.log(`\n── Mi residencia (pila «residence», estado propio) · selector ${modo} ──`);
    if (modo === 'propio' && p5) delete AR.pickerScreenHTML;
    E.montar('historial');
    A.state.form = JSON.parse(form0);
    AS.setTab('perfil'); await wait(40);
    E.llamadas.length = 0;
    b.click(row(b, 'row-res'));
    await wait(80);
    const layer = b.q('.rx-layer[data-scr="residence"]');
    t(`[${modo}] abre la capa «residence» con la cabecera «Mi residencia»`, !!layer && /Mi residencia/.test(layer.querySelector('.rx-head').textContent));
    t(`[${modo}] muestra el conjunto actual`, !!layer && /El Olivar/.test(layer.textContent));
    const rq = layer && layer.querySelector('input[data-rx-field]');
    t(`[${modo}] buscador con data-rx-field (no data-field ni #axr-q)`, !!rq && !layer.querySelector('[data-field], #axr-q'));
    if (rq) { b.type(rq, 'cere'); await wait(10); }
    const pick = layer && layer.querySelector('[data-id="esc-res-cerezos"]');
    t(`[${modo}] buscar «cere» muestra Los Cerezos, sin tocar el pedido`, !!pick && JSON.stringify(A.state.form) === form0);
    t(`[${modo}] el campo no se recrea en cada tecla (no pierde el foco)`, !rq || layer.querySelector('input[data-rx-field]') === rq);
    if (pick) b.click(pick);
    await wait(30);
    t(`[${modo}] elegir no toca el pedido (los res-* del pedido no corren aquí)`, JSON.stringify(A.state.form) === form0);
    const save = modo === 'P5'
      ? b.q('.rx-layer[data-scr="residence"] [data-rx="res-p-save"]')
      : b.q('.rx-sheet [data-rx="me-res-save"]');
    t(`[${modo}] queda listo para guardar (${modo === 'P5' ? 'pie «Guardar»' : 'hoja de confirmación'}) y lo dice honesto: el apartamento no cambia aquí`,
      !!save && !save.disabled && /Coordinación/.test((modo === 'P5' ? b.q('.rx-layer[data-scr="residence"]') : b.q('.rx-sheet')).textContent));
    if (save) b.click(save);
    await wait(60);
    const sr = llamadas(b, 'Api.saveMyResidence');
    t(`[${modo}] Guardar → Api.saveMyResidence("esc-res-cerezos")`, sr.length === 1 && sr[0].args[0] === 'esc-res-cerezos', JSON.stringify(sr));
    t(`[${modo}] H.residence pasa a Los Cerezos`, A.header.residenceId === 'esc-res-cerezos' && A.header.residence && A.header.residence.name === 'Los Cerezos');
    await wait(320);
    t(`[${modo}] vuelve a Perfil y la fila dice «Los Cerezos · Torre 2 · 504»`, !b.q('.rx-layer[data-scr="residence"]:not(.out)') && sub(row(b, 'row-res')) === 'Los Cerezos · Torre 2 · 504', sub(row(b, 'row-res')));
    t(`[${modo}] el pedido sigue intacto al final`, JSON.stringify(A.state.form) === form0);

    // Dos unidades: la segunda es de solo lectura
    E.montar('dos-unidades');
    AS.setTab('perfil'); await wait(30);
    b.click(row(b, 'row-res'));
    await wait(80);
    const l2 = b.q('.rx-layer[data-scr="residence"]');
    t(`[${modo}] dos unidades: la segunda se ve y dice «para cambiarla, escríbele a Coordinación»`, !!l2 && /Quintas de Llanogrande/.test(l2.textContent) && /Casa 14/.test(l2.textContent) && /para cambiarla, escríbele a Coordinación/i.test(l2.textContent));
    t(`[${modo}] la segunda unidad no tiene acción (solo lectura)`, !!l2 && ![...l2.querySelectorAll('[data-id="esc-res-llano"]')].some(r => r.hasAttribute('data-rx') || r.hasAttribute('data-ax')));
    AS.popAll(); await wait(30);
    if (modo === 'propio' && p5) AR.pickerScreenHTML = p5;
  }

  // Teléfono vacío y H nulo
  console.log('\n── Sin dato ──');
  E.montar('historial');
  A.state.profile.phone = '';
  A.header = null;
  AS.setTab('inicio'); await wait(20);
  AS.setTab('perfil'); await wait(40);
  t('sin teléfono: «Sin teléfono registrado»', sub(row(b, 'row-phone')) === 'Sin teléfono registrado');
  t('sin H: la línea queda «Auxiliar» (se omite lo vacío)', row(b, 'line').textContent === 'Auxiliar');
  t('sin H: Mi residencia lo dice, sin inventar', sub(row(b, 'row-res')) === 'No pudimos cargarla');

  // Horario de Coordinación cargado (ApiAux.getOpsContact)
  E.montar('coordinacion-con-mensajes');
  AS.setTab('inicio'); await wait(20);
  AS.setTab('perfil'); await wait(60);
  t('con horario en Ajustes/ops, Coordinación lo muestra', sub(row(b, 'row-coord')) === 'Todos los días · 3:00 a. m. a 11:00 p. m.', sub(row(b, 'row-coord')));

  // Pagos y Puntos encendidos (contratos de AJUSTES §8; aquí, falsos)
  console.log('\n── Pagos y Puntos encendidos (contrato AJUSTES §8) ──');
  w.AuxPagos = { summary: () => ({ status: 'vencido', amountCOP: 150000, dueISO: '2026-09-25', label: 'Vencido' }), paused: () => false };
  w.AuxPuntos = { enabled: () => true, summary: () => ({ balance: 120, nextRewardPts: 180, nextRewardName: 'un colega gratis' }), cancelBonus: () => null };
  AS.setTab('inicio'); await wait(20);
  AS.setTab('perfil'); await wait(900);
  t('Pagos lee AuxPagos.summary(): «$150.000 · vencido» en rojo', sub(row(b, 'row-pay')) === '$150.000 · vencido' && !!row(b, 'row-pay').querySelector('.rx-row-ic.t-err'), sub(row(b, 'row-pay')));
  t('con Puntos: tercera cifra (.pts) y cuadrícula de 3', !meEl(b).querySelector('.rx-me-stats').classList.contains('two') && meEl(b).querySelector('[data-me="st-pts"] b.pts').textContent === '120');
  t('con Puntos: filas con acción y sin «Pronto»', row(b, 'row-points').getAttribute('data-rx') === 'me-push' && row(b, 'row-points').getAttribute('data-to') === 'points'
    && row(b, 'row-invite').getAttribute('data-to') === 'invite' && !meEl(b).querySelector('.rx-me-soon') && sub(row(b, 'row-points')) === '120 pts · te faltan 60 para un colega gratis', sub(row(b, 'row-points')));
  w.AuxPagos.summary = () => null;
  w.AuxPuntos.enabled = () => false;
  AS.setTab('inicio'); await wait(20);
  AS.setTab('perfil'); await wait(40);
  t('apagados otra vez: «Todavía no disponible» y 2 cifras', sub(row(b, 'row-pay')) === 'Todavía no disponible' && sub(row(b, 'row-points')) === 'Todavía no disponible' && meEl(b).querySelector('.rx-me-stats').classList.contains('two'));

  // Textos prohibidos
  const html = meEl(b).innerHTML;
  t('Perfil sin textos prohibidos ni cifras de privado/Directo', prohibidos(html, ['Laura Gómez Ruiz']).length === 0, prohibidos(html, ['Laura Gómez Ruiz']).join(','));
  t('pestaña Perfil sin ningún id de §2.4',
    AS.FIXED_IDS.concat(['ax-meet', 'ax-phase']).every(id => !meEl(b).querySelector('#' + id)));

  t('sin errores de consola (tampoco el aviso de ids reservados del shell)', b.errors.length === 0, b.errors.slice(0, 4).join(' | '));
  t('sin red (window.sb nunca se usó)', b.red.length === 0, b.red.slice(0, 6).join('.'));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Bandera APAGADA: el Perfil de siempre ──');
{
  const b = await boot(false);
  const { E, A, AS } = b;
  t('el shell está apagado', !AS.on());
  E.montar('historial');
  A.goTab('perfil');
  await wait(30);
  t('pinta el Perfil de siempre (sin rx-me-hero) con su #ax-pwa-bar', !b.q('.rx-me-hero') && !!b.q('#ax-pwa-bar') && /Cerrar sesión/.test(b.ui().textContent));
  const otros = b.errors.filter(e => !/ids reservados/.test(e));
  t('sin errores de consola', otros.length === 0, otros.slice(0, 4).join(' | '));
}

if (rechazos.length) {
  console.log(`\n  ⚠ ${rechazos.length} rechazo(s) sin atender de otros módulos (no son de aux-rx-perfil.js si la pila no lo nombra):`);
  [...new Set(rechazos)].slice(0, 4).forEach(r => console.log('    ' + r));
  const mios = rechazos.filter(r => /aux-rx-perfil|AuxRxPerfil/.test(r));
  t('ningún rechazo sin atender viene de aux-rx-perfil.js', mios.length === 0, mios[0]);
}
console.log(`\n${ok} ✓ · ${bad} ✗`);
console.log('NO cubre: layout ni animación real (jsdom), el deslizamiento real del indicador, el conteo visible,');
console.log('          390 px claro/nocturno, push real, ni el selector de P5 si todavía no existe.');
process.exit(bad ? 1 : 0);
