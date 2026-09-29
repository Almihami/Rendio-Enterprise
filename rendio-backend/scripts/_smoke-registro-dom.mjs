// Prueba de pintado del registro (0075) sobre un DOM de verdad (jsdom).
// No reemplaza mirarlo en un teléfono, pero atrapa lo que de otro modo se
// descubre en producción: una función que no existe, una plantilla rota, un
// paso que no avanza. Se recorren las pantallas y se hace clic donde haría
// clic el tripulante.
// REQUIERE jsdom (no está en el repo, es solo para probar):
//   cd rendio-backend && npm install --no-save jsdom
//
// REDISEÑO (P11, 27-sep-2026): mientras exista el interruptor corre en los DOS
// modos. RX=0 (o sin variable) = el registro de siempre (.ax-*); RX=1 = el
// registro con el aspecto del diseño (RxRegister / RxReady): .rx-foot
// .rx-btn.pri, .rx-opt, .rx-empty, rx-step fwd|bwd, «Punto de encuentro
// (opcional)» guardado con ApiAux.saveMyPrefs DESPUÉS de registerAuxiliar, el
// paso «¿Cómo prefieres viajar?» solo si AuxPrivado.enabled(), el código de
// invitación solo con Puntos, y AuxShell.skin(true). Los mismos data-rg*.
// Además, en los dos modos, el ingreso (#screen-login) con login-rx.css.
//   RX=0 node scripts/_smoke-registro-dom.mjs
//   RX=1 node scripts/_smoke-registro-dom.mjs
//
// LO QUE NO CUBRE: jsdom no hace layout ni corre animaciones (no prueba que la
// barra se estire, que el paso entre deslizando, el confeti, ni cómo se ve de
// noche: solo que la clase y el atributo están). No hay Leaflet (el camino
// manual con el pin no se recorre aquí) ni red real (Api de mentiras).
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';

const APP = '../rendio-turnos/';
const read = (f) => readFileSync(APP + f, 'utf8');
const HTML = read('index.html');
const RX = process.env.RX === '1';
console.log('Modo: ' + (RX ? 'RX=1 (rediseño encendido)' : 'RX=0 (el registro de siempre)'));

let ok = 0, bad = 0;
const t = (n, c, d = '') => { if (c) { ok++; console.log('  ✓ ' + n); } else { bad++; console.log('  ✗ ' + n + (d ? ' → ' + d : '')); } };
const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));

// Api de mentiras: acá se prueba el PINTADO, no la red (la red ya la probaron
// _e2e-0075-registro y _e2e-0075-front contra dev de verdad).
const CAT = { airlines: [{ id: 'a1', name: 'Avianca' }, { id: 'a2', name: 'JetSMART' }, { id: 'a3', name: 'Wingo' }, { id: 'a4', name: 'LATAM' }],
  residences: [{ id: 'r1', name: 'Olivar Apartamentos', sector: 'Norte' }, { id: 'r2', name: 'Solare', sector: 'Llanogrande' }, { id: 'r3', name: 'Cámbulo', sector: 'Norte' }] };
const SIN_PRIVADO = { aux_min_lead_hours: 6, aux_wait_minutes: 5 };
const CON_PRIVADO = { ...SIN_PRIVADO, aux_private_enabled: true, aux_private_vehicle_id: 'v1', aux_private_price_cop: 150000 };
// Lo que nunca puede salir en la pantalla del tripulante (plan §1.6, AJUSTES §7, brief P11).
const PROHIBIDOS = ['38 auxiliares', 'código de 6 dígitos', 'Sin contraseñas', 'Carlos Mejía', 'Laura', 'AV9525', 'Juliana',
  'Plan B', '24/7', 'en línea', 'Último cupo', 'Siempre hay cupo', 'Preparado', 'Esta noche te avisamos', '@avianca.com'];
const prohibidos = (txt) => PROHIBIDOS.filter(p => txt.includes(p)).concat(/\$\s?\d/.test(txt) ? ['$cifra'] : []);

function boot(o = {}) {
  const rx = o.rx == null ? RX : o.rx;
  const dom = new JSDOM(o.html || HTML, { runScripts: 'outside-only', pretendToBeVisual: true, url: o.url || 'http://localhost/' });
  const w = dom.window;
  const errors = [];
  w.console.error = (...a) => { errors.push(a.map(x => (x && x.message) || String(x)).join(' ')); };
  w.RENDIO_CONFIG = { OTP_LENGTH: 8 };
  w.toast = () => {};
  w.L = undefined;
  w.state = { settings: {} };
  const calls = [];
  w.Api = {
    getSession: async () => null, signOut: async () => {}, getCurrentProfile: async () => ({ id: 'p1', full_name: 'Ana Lucía Restrepo Vélez', role: 'auxiliar' }),
    signUpAuxiliar: async () => { calls.push('signUp'); return { session: { access_token: 'x' }, user: {} }; },
    signupCatalogs: async () => CAT,
    registerAuxiliar: async (f) => { calls.push('register'); w.__reg = f; return { ok: true }; },
    getSettings: async () => { calls.push('getSettings'); return { ...(o.settings || SIN_PRIVADO) }; },
  };
  w.ApiAux = {
    saveMyPrefs: async (p) => {
      calls.push('saveMyPrefs'); w.__prefs = p;
      if (o.prefsFail) throw new Error('boom');
      return true;
    },
  };
  if (o.puntos) {
    w.AuxPuntos = { enabled: () => true, summary: () => null, cancelBonus: () => null };
    w.ApiPuntos = {
      refFromUrl: () => 'MARIA-OLV',
      claimReferral: async (c) => { calls.push('claim:' + c); if (o.claimFail) throw new Error('Código no válido'); return { ok: true }; },
    };
  }
  w.localStorage.setItem('rendio.aux.rx', rx ? '1' : '0');
  if (o.night) w.localStorage.setItem('rendio.aux.night', 'night');
  const files = rx ? ['aux-rx-ui.js', 'aux-shell.js', 'aux-registro.js', 'aux-privado.js'] : ['aux-registro.js'];
  if (o.presentacion) files.push('aux-presentacion.js');
  for (const f of files) { try { w.eval(read(f)); } catch (e) { errors.push(f + ': ' + e.message); } }
  const ui = () => w.document.getElementById('auxiliar-ui');
  const txt = () => ui().textContent.replace(/\s+/g, ' ');
  const q = (s) => ui().querySelector(s);
  const qa = (s) => [...ui().querySelectorAll(s)];
  const click = (s) => { const e = typeof s === 'string' ? q(s) : s; if (!e) throw new Error('no existe: ' + s); e.click(); };
  const set = (key, val) => {
    const i = q(`[data-rg-field="${key}"]`); if (!i) throw new Error('no existe campo ' + key);
    i.value = val; i.dispatchEvent(new w.Event('input', { bubbles: true }));
    i.dispatchEvent(new w.FocusEvent('focusout', { bubbles: true }));
  };
  const type = (sel, val) => { const i = q(sel); if (!i) throw new Error('no existe ' + sel); i.value = val; i.dispatchEvent(new w.Event('input', { bubbles: true })); };
  return { w, dom, ui, txt, q, qa, click, set, type, calls, errors, R: w.AuxRegistro };
}

// Selectores que cambian de un aspecto al otro (el contrato data-rg* es el mismo).
const CTA = RX ? '.rx-foot .rx-btn.pri' : '.ax-cta-bar .ax-btn-primary';
const AIR_ON = RX ? '.rx-opt.on[data-rg="airline"]' : '.ax-opt.sel';
const NONE = RX ? '[data-rg-list="1"] .rx-empty' : '[data-rg-list="1"] .axr-none';

// Llena el paso 1 y pasa al perfil.
async function hastaPerfil(E) {
  E.R.start();
  E.set('name', 'Ana Lucía Restrepo Vélez'); E.set('email', 'ana.restrepo@gmail.com');
  E.set('phone', '3105557788'); E.set('pass', 'Lluvia7Marzo42'); E.set('pass2', 'Lluvia7Marzo42');
  E.click('[data-rg="crear"]'); await wait(); await wait();
}
// Aerolínea + conjunto + apartamento.
function llenarPerfil(E) {
  E.click('[data-rg="airline"][data-id="a3"]');
  E.type('[data-rg-q="1"]', 'solare');
  E.click('[data-rg="res-pick"][data-id="r2"]');
  E.set('unit', 'Torre 1 · 501');
}

{
  const E = boot();
  const { ui, txt, q, qa, click, set, R, w } = E;

  console.log('\n── paso 1 · datos ──');
  R.start();
  t('pinta la pantalla de crear cuenta', /Crea tu cuenta/.test(txt()));
  t('el botón arranca deshabilitado', q('[data-rg="crear"]').disabled);
  set('name', 'Ana Restrepo');
  t('nombre de 2 palabras → error en rojo', /Faltan apellidos/.test(txt()), txt().slice(0, 120));
  t('y el campo queda marcado', !!q('[data-rg-field="name"].bad'));
  if (RX) t('(rx) y también su caja .rx-input', !!q('.rx-input.bad [data-rg-field="name"]'));
  set('name', 'Ana Lucía Restrepo Vélez');
  t('con nombre y dos apellidos, el error se va', !/Faltan apellidos/.test(txt()));
  if (RX) t('(rx) y la caja deja de estar en rojo', !q('.rx-input.bad [data-rg-field="name"]'));
  set('email', 'ana@rendio.demo');
  t('rechaza el dominio de prueba', /correo personal de verdad/.test(txt()));
  t('sin prometer un código que ya no se manda', !/código/i.test(txt()), txt().slice(0, 300));
  set('email', 'ana.restrepo@gmail.com');
  set('phone', '300');
  t('teléfono corto → error', /incompleto/.test(txt()));
  set('phone', '3105557788');
  set('pass', '1234');
  // Desde el 11-sep la contraseña son 10 con letra y número, y se repite.
  t('contraseña corta → error', /son 10 como mínimo/.test(txt()), txt().slice(0, 200));
  set('pass', 'Lluvia7Marzo42');
  t('sin repetirla, el botón sigue apagado', q('[data-rg="crear"]').disabled);
  set('pass2', 'Lluvia7Marzo42');
  t('con todo bien, el botón se habilita', !q('[data-rg="crear"]').disabled);
  t('«Coinciden» en verde', /Coinciden/.test(txt()));
  click('[data-rg="ver-pass"]');
  t('el ojo muestra la contraseña', q('[data-rg-field="pass"]').type === 'text');

  let ob1 = null, prog1 = null, body1 = null;
  if (RX) {
    console.log('\n── (rx) el aspecto del diseño en el paso 1 ──');
    t('AuxShell.skin(true): #auxiliar-ui lleva rx-phone', ui().classList.contains('rx-phone'));
    ob1 = q('.rx-ob[data-rg-phase="register"]');
    t('RxRegister: .rx-ob > .rx-scr con RxHead, .rx-prog, .rx-body.rx-step.fwd y .rx-foot',
      !!ob1 && !!q('.rx-scr .rx-head') && !!q('.rx-prog i') && !!q('.rx-body.rx-step.fwd[data-rg-view="datos"]') && !!q('.rx-foot .rx-btn.pri[data-rg="crear"]'));
    t('los campos son .rx-field con su .rx-input', qa('.rx-field .rx-input [data-rg-field]').length === 5);
    t('en el paso 1 no se anuncia «N de M» (todavía no se sabe si hay paso de nivel)', !q('.rx-step-n'));
    t('atrás (RxHead) y «Ya tengo cuenta» vuelven al login (data-rg="salir")', !!q('.rx-head [data-rg="salir"]') && !!q('.rx-foot .rx-btn.ghost[data-rg="salir"]'));
    prog1 = q('.rx-prog i'); body1 = q('.rx-body');
    t('la barra va con lo que se sabe (1 de 2)', prog1.style.width === '50%', prog1.style.width);
    // Escribir no repinta: el MISMO input sigue ahí (no se pierde el foco ni el cursor).
    const inp = q('[data-rg-field="name"]');
    set('name', 'Ana Lucía Restrepo Vélez');
    t('escribir no rehace el campo', q('[data-rg-field="name"]') === inp);
  }

  console.log('\n── del paso 1 al perfil, sin código de por medio ──');
  // La verificación por correo se sacó el 25-ago (correo-registro/
  // PENDIENTE-verificacion-correo.js). signUp devuelve sesión y se sigue derecho.
  click('[data-rg="crear"]'); await wait(); await wait();
  t('pasa derecho al perfil', /Ya casi/.test(txt()), txt().slice(0, 90));
  t('no pinta ninguna casilla de código', qa('.rg-otp-box').length === 0 && qa('.rx-otp').length === 0);
  t('el registro es de 2 pasos', RX ? /2 de 2/.test(txt()) : /2\/2/.test(txt()), txt().slice(0, 60));
  if (RX) {
    t('(rx) key={step}: el cuerpo es un nodo NUEVO con rx-step fwd', q('.rx-body') !== body1 && q('.rx-body').classList.contains('fwd') && q('.rx-body').getAttribute('data-rg-view') === 'perfil');
    t('(rx) la fase no cambió: el .rx-ob es el mismo (sin rxFade de nuevo)', q('.rx-ob') === ob1);
    t('(rx) la barra es la MISMA y se estira (su transición de .5 s corre)', q('.rx-prog i') === prog1 && prog1.style.width === '100%', prog1.style.width);
    t('(rx) sin privado encendido, el botón dice «Crear mi cuenta»', /Crear mi cuenta/.test(q(CTA).textContent) && q(CTA).getAttribute('data-rg') === 'registrar');
  }

  console.log('\n── paso 2 · aerolínea, conjunto y unidades ──');
  await wait();
  t('lista las 4 aerolíneas', qa('[data-rg="airline"]').length === 4);
  if (RX) t('(rx) como .rx-opt con la sigla de color y el radio', qa('.rx-opt[data-rg="airline"] .rx-opt-ic.rg-sigla').length === 4 && qa('.rx-opt[data-rg="airline"] .rx-radio i').length === 4);
  // Buscador primero (15-sep): sin texto NO se pinta la lista; se escribe y se elige.
  t('sin texto no lista conjuntos: buscador primero', qa('[data-rg="res-pick"]').length === 0, String(qa('[data-rg="res-pick"]').length));
  t('la lista existe pero vacía (para llenarla sin repintar)', !!q('[data-rg-list="1"]') && q('[data-rg-list="1"]').innerHTML === '');
  t('dice qué escribir', /Escribe el nombre de tu conjunto o el sector/.test(txt()) && /Escribe el nombre de la tuya y elígela/.test(txt()));
  t('y «Mi conjunto no está en la lista» se ve desde el inicio', !!q('[data-rg="manual"]'));
  t('el botón sigue deshabilitado sin elegir', q(CTA).disabled);
  const air = q('[data-rg="airline"][data-id="a3"]');
  click(air);
  t('marca la aerolínea elegida', !!q(AIR_ON));
  if (RX) t('(rx) en su sitio: el MISMO botón toma .on (la transición del radio corre)', q('[data-rg="airline"][data-id="a3"]') === air && air.classList.contains('on') && /Tu aerolínea/.test(air.textContent));
  // buscador
  E.type('[data-rg-q="1"]', 'o');
  const olivar = q('[data-rg="res-pick"][data-id="r1"]');
  E.type('[data-rg-q="1"]', 'oli');
  if (RX) t('(rx) la fila que sigue en el resultado es el MISMO nodo (por key, como React)', q('[data-rg="res-pick"][data-id="r1"]') === olivar && qa('[data-rg="res-pick"]').length === 1);
  E.type('[data-rg-q="1"]', 'solare');
  t('el buscador filtra', qa('[data-rg="res-pick"]').length === 1, String(qa('[data-rg="res-pick"]').length));
  if (RX) t('(rx) cada resultado es un .rx-opt.rx-in con su --d', !!q('.rx-opt.rx-in[data-rg="res-pick"][data-id="r2"]'));
  t('y al escribir la ayuda se esconde', q('[data-rg-hint="1"]').hidden === true);
  E.type('[data-rg-q="1"]', 'zzz');
  t('sin coincidencias lo dice dentro de la lista', /No encontramos «zzz»/.test(txt()) && !!q(NONE));
  E.type('[data-rg-q="1"]', 'solare');
  t('antes de elegir no hay punto de encuentro', !q('[data-rg-field="meetingPoint"]'));
  click('[data-rg="res-pick"][data-id="r2"]');
  t('muestra el conjunto elegido', /Solare/.test(txt()));
  t('y pide el apartamento', !!q('[data-rg-field="unit"]'));
  if (RX) {
    t('(rx) el elegido como .rx-opt.on con «Cambiar»', !!q('.rx-opt.on.rg-picked-rx [data-rg="res-change"]'));
    t('(rx) aparece «Punto de encuentro (opcional)» (rx-gates rx-in), texto libre', !!q('.rx-gates.rx-in [data-rg-field="meetingPoint"]') && /Punto de encuentro \(opcional\)/.test(txt()));
    t('(rx) sin chips de porterías inventadas', !q('.rx-gates .rx-chips'));
  } else {
    t('el registro de siempre no pide punto de encuentro', !q('[data-rg-field="meetingPoint"]'));
  }
  set('unit', 'Torre 1 · 501');
  t('ahora sí se puede crear la cuenta', !q(CTA).disabled);
  if (RX) set('meetingPoint', 'Portería 2, junto al parqueadero');
  t('ofrece la segunda unidad', /segunda unidad/i.test(txt()));
  const tg = q('[data-rg="toggle"][data-key="hasSecond"]');
  click(tg);
  if (RX) t('(rx) el MISMO interruptor .rx-tg se enciende (toggleSet)', q('[data-rg="toggle"][data-key="hasSecond"]') === tg && tg.classList.contains('on') && tg.getAttribute('aria-pressed') === 'true');
  t('al encenderla, se bloquea hasta completarla', q(CTA).disabled);
  t('la segunda unidad también arranca con el buscador vacío', qa('[data-rg="res-pick"][data-n="2"]').length === 0);
  E.type('[data-rg-q="2"]', 'oli');
  t('y se llena al escribir', qa('[data-rg="res-pick"][data-n="2"]').length === 1);
  click('[data-rg="res-pick"][data-n="2"][data-id="r1"]');
  set('unit2', 'Casa 8');
  t('con la segunda completa, se desbloquea', !q(CTA).disabled);
  t('se ven las dos unidades', /Solare/.test(txt()) && /Olivar/.test(txt()));
  click('[data-rg="toggle"][data-key="hasSecond"]');   // apagar la segunda
  t('apagar la segunda la limpia', !w.AuxRegistro.state.f.resId2);
  if (RX) t('(rx) y lo escrito en el punto de encuentro sigue ahí', q('[data-rg-field="meetingPoint"]').value === 'Portería 2, junto al parqueadero');
  if (RX) t('(rx) sin textos prohibidos en el perfil', prohibidos(txt()).length === 0, prohibidos(txt()).join(', '));

  console.log('\n── paso 3 · bienvenida ──');
  const obAntes = q('.rx-ob');
  E.calls.length = 0;
  click(CTA); await wait(); await wait();
  t('llega a la bienvenida', RX ? /Te damos la bienvenida/.test(txt()) : /Bienvenido/.test(txt()), txt().slice(0, 90));
  t('saluda por el primer nombre', RX ? /bienvenida, Ana/.test(txt()) : /Bienvenido, Ana/.test(txt()));
  if (RX) {
    t('(rx) primero registerAuxiliar y DESPUÉS saveMyPrefs', E.calls.join(',') === 'register,saveMyPrefs', E.calls.join(','));
    t('(rx) meetingPoint guardado (sin nivel: no hay paso de privado)', JSON.stringify(w.__prefs) === JSON.stringify({ meetingPoint: 'Portería 2, junto al parqueadero' }), JSON.stringify(w.__prefs));
    t('(rx) registerAuxiliar recibe los MISMOS datos de siempre', w.__reg.airlineId === 'a3' && w.__reg.residenceId === 'r2' && w.__reg.unit === 'Torre 1 · 501' && w.__reg.residenceId2 === null && !('meetingPoint' in w.__reg));
    t('(rx) RxReady: .rx-ob NUEVO (key=fase) con .rx-center.rx-ready, confeti y el visto', q('.rx-ob') !== obAntes && !!q('.rx-ob[data-rg-phase="listo"] .rx-scr.rx-center.rx-ready') && !!q('.rx-ready .rx-confetti i') && !!q('.rx-ready .rx-check'));
    t('(rx) dice dónde lo recogen, con el punto que quedó guardado', /Te recogemos en Solare · Portería 2, junto al parqueadero/.test(txt()), txt());
    t('(rx) «Entrar a la app» en .rx-foot.abs (data-rg="entrar")', !!q('.rx-foot.abs .rx-btn.pri[data-rg="entrar"]'));
    t('(rx) sin textos prohibidos', prohibidos(txt()).length === 0, prohibidos(txt()).join(', '));
  } else {
    t('explica lo de la hora de llegada', /hora de llegada|estar en el aeropuerto/i.test(txt()));
    t('el registro de siempre no llama a saveMyPrefs', !E.calls.includes('saveMyPrefs'), E.calls.join(','));
  }

  console.log('\n── el botón de sol/luna ──');
  // AuxPresentacion no está cargado en esta prueba: el botón no debe aparecer ni
  // reventar. Se carga y se vuelve a pintar para probarlo de verdad.
  R.start();
  t('sin el módulo de tema, no pinta el botón (y no revienta)', !q('[data-rg="tema"]'));
  w.eval(read('aux-presentacion.js'));
  R.start();
  t('con el módulo, aparece el botón', !!q('[data-rg="tema"]'));
  const modo = () => ui().getAttribute('data-ax-night');
  const icono = () => q('[data-rg="tema"] use')?.getAttribute('href');
  const SOL = RX ? '#rx-Sun' : '#i-sun', LUNA = RX ? '#rx-Moon' : '#i-moon';
  const antes = modo();
  click('[data-rg="tema"]');
  t('al tocarlo cambia el modo', modo() !== antes, antes + ' → ' + modo());
  t('y el icono pasa a mostrar el camino contrario',
    (modo() === 'on' && icono() === SOL) || (modo() === 'off' && icono() === LUNA), modo() + ' / ' + icono());
  t('la preferencia queda guardada', ['light', 'night'].includes(w.localStorage.getItem('rendio.aux.night')),
    String(w.localStorage.getItem('rendio.aux.night')));
  click('[data-rg="tema"]');
  t('vuelve al otro modo', modo() === antes, modo());
  t('sigue estando en el paso 1', /Crea tu cuenta/.test(txt()));

  console.log('\n── si alguien enciende «Confirm email» sin devolver el paso ──');
  // signUp deja el usuario creado pero SIN sesión: desde el navegador no hay
  // forma de seguir. No puede quedarse el botón girando en silencio.
  w.Api.signUpAuxiliar = async () => ({ session: null, user: {} });
  w.localStorage.removeItem('rendio.aux.night');
  R.start();
  set('name', 'Ana Lucía Restrepo Vélez'); set('email', 'ana.restrepo@gmail.com');
  set('phone', '3105557788'); set('pass', 'Lluvia7Marzo42'); set('pass2', 'Lluvia7Marzo42');
  click('[data-rg="crear"]'); await wait(); await wait();
  t('lo dice en vez de dejarlo trancado', /falta un paso de confirmación/.test(txt()), txt().slice(0, 220));
  t('y se queda en la pantalla de datos', /Crea tu cuenta/.test(txt()));
  t('el botón vuelve a estar activo para reintentar', !q('[data-rg="crear"]').disabled);
  if (RX) t('(rx) el error va en una nota del diseño, sin rehacer el paso', !!q('.rx-note.rg-bad') && q('[data-rg-view="datos"]').classList.contains('rx-step'));
  w.Api.signUpAuxiliar = async () => ({ session: { access_token: 'x' }, user: {} });

  console.log('\n── retomar un registro a medias ──');
  await R.resume({ email: 'otra@gmail.com', user_metadata: { full_name: 'Sofía Marcela Ossa Bedoya', phone: '3123334455' } });
  await wait();
  t('retoma directo en el paso del perfil', /Ya casi/.test(txt()));
  t('conserva el nombre que ya había dado', w.AuxRegistro.state.f.name === 'Sofía Marcela Ossa Bedoya');
  if (RX) t('(rx) sin botón de atrás en el perfil (la cuenta ya existe)', !q('.rx-head .rx-ib[aria-label="Volver"]'));

  console.log('\n── salir vuelve al login ──');
  R.start();
  click('[data-rg="salir"]'); await wait();
  t('el login se ve y el registro se va', !w.document.getElementById('screen-login').classList.contains('hidden') && ui().innerHTML === '');
  if (RX) t('(rx) y la piel rx-phone se quita (el login no la lleva)', !ui().classList.contains('rx-phone'));
  t('sin errores en consola', E.errors.length === 0, E.errors.join(' | '));
}

if (RX) {
  console.log('\n── (rx) con el privado encendido: el paso «¿Cómo prefieres viajar?» ──');
  const E = boot({ settings: CON_PRIVADO });
  const { q, qa, txt, click, w } = E;
  await hastaPerfil(E); await wait();
  t('los ajustes se leen con sesión (después de signUp)', E.calls.indexOf('getSettings') > E.calls.indexOf('signUp'), E.calls.join(','));
  t('el perfil ya dice «2 de 3»', /2 de 3/.test(txt()), txt().slice(0, 80));
  t('y la barra llega directo a 2/3 (los ajustes se leen antes de pasar: no se encoge)', q('.rx-prog i').style.width === '66.667%', q('.rx-prog i').style.width);
  llenarPerfil(E);
  E.set('meetingPoint', 'Portería 2');
  const cta = q(CTA);
  t('el botón del perfil solo avanza: «Continuar» (data-rg="a-nivel")', /Continuar/.test(cta.textContent) && cta.getAttribute('data-rg') === 'a-nivel' && !cta.disabled);
  const body2 = q('.rx-body'), prog = q('.rx-prog i');
  click(cta); await wait();
  t('el paso 3 entra con rx-step fwd (nodo nuevo)', q('.rx-body') !== body2 && q('.rx-body.rx-step.fwd[data-rg-view="nivel"]') && /Cómo prefieres viajar/.test(txt()));
  t('«3 de 3» y la barra al 100 %', /3 de 3/.test(txt()) && q('.rx-prog i') === prog && prog.style.width === '100%', prog.style.width);
  const cards = qa('.rx-lv[data-rg="level"]');
  t('las tarjetas son RxLevelCard de P6 (.rx-lv.rx-in) con acciones del registro', cards.length >= 2 && !!q('.rx-lv.vip[data-rg="level"][data-v="private"]') && !q('[data-rx="pref-level"]'));
  t('Compartido elegido por defecto', q('.rx-lv[data-v="shared"]').classList.contains('on'));
  t('sin cifra del privado', prohibidos(txt()).length === 0, prohibidos(txt()).join(', '));
  const vip = q('.rx-lv.vip[data-rg="level"]');
  click(vip);
  t('elegir Privado: la MISMA tarjeta toma .on', q('.rx-lv.vip[data-rg="level"]') === vip && vip.classList.contains('on') && !q('.rx-lv[data-v="shared"]').classList.contains('on'));
  click('.rx-head [data-rg="atras"]'); await wait();
  t('atrás vuelve al perfil con rx-step bwd', q('.rx-body.rx-step.bwd[data-rg-view="perfil"]') && /2 de 3/.test(txt()));
  t('y el perfil conserva lo elegido', /Solare/.test(txt()) && q('[data-rg-field="meetingPoint"]').value === 'Portería 2');
  click(CTA); await wait();
  t('adelante otra vez: la elección sigue', q('.rx-lv.vip').classList.contains('on'));
  E.calls.length = 0;
  click(CTA); await wait(); await wait();
  t('«Crear mi cuenta» registra y DESPUÉS guarda las preferencias', E.calls.join(',') === 'register,saveMyPrefs', E.calls.join(','));
  t('saveMyPrefs recibe el nivel y el punto de encuentro', JSON.stringify(w.__prefs) === JSON.stringify({ meetingPoint: 'Portería 2', preferredLevel: 'private' }), JSON.stringify(w.__prefs));
  t('y termina en RxReady', !!q('.rx-ready'));
}

if (RX) {
  console.log('\n── (rx) si saveMyPrefs falla, la cuenta igual quedó ──');
  const E = boot({ prefsFail: true });
  await hastaPerfil(E); await wait();
  llenarPerfil(E);
  E.set('meetingPoint', 'Portería 2');
  E.click(CTA); await wait(); await wait();
  t('llega a «listo»', !!E.q('.rx-ready'));
  t('y lo dice sin inventar que quedó guardado', /No pudimos guardar tu punto de encuentro/.test(E.txt()) && !/Portería 2/.test(E.txt()), E.txt());
  const E2 = boot();
  await hastaPerfil(E2); await wait();
  llenarPerfil(E2);
  E2.calls.length = 0;
  E2.click(CTA); await wait(); await wait();
  t('sin punto ni nivel, no hay nada que guardar (ni una llamada de más)', E2.calls.join(',') === 'register', E2.calls.join(','));
}

if (RX) {
  console.log('\n── (rx) código de invitación (Rendio Points, solo si está encendido) ──');
  {
    const E = boot();
    await hastaPerfil(E); await wait();
    llenarPerfil(E);
    t('con Puntos apagado (o sin módulo) no se pide el código', !E.q('[data-rg-field="refCode"]') && !/Te invitó/.test(E.txt()));
  }
  {
    const E = boot({ puntos: true, claimFail: true });
    await hastaPerfil(E); await wait();
    llenarPerfil(E);
    const f = E.q('[data-rg-field="refCode"]');
    t('con Puntos encendido aparece «¿Te invitó alguien? Código»', !!f && /Te invitó alguien\? Código/.test(E.txt()));
    t('y viene lleno con el ?ref= del enlace', f && f.value === 'MARIA-OLV', f && f.value);
    E.calls.length = 0;
    E.click(CTA); await wait(); await wait();
    t('se reclama DESPUÉS de registrarse', E.calls[0] === 'register' && E.calls.includes('claim:MARIA-OLV'), E.calls.join(','));
    t('y un error del código no frena el registro', !!E.q('.rx-ready'));
  }
}

if (RX) {
  console.log('\n── (rx) de noche el registro sale oscuro ──');
  const E = boot({ night: true, presentacion: true });
  E.R.start();
  t('#auxiliar-ui.rx-phone con data-ax-night="on" (los --r-* nocturnos)', E.ui().classList.contains('rx-phone') && E.ui().getAttribute('data-ax-night') === 'on');
  const css = read('rx-aux-onboard.css');
  const hex = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  t('rx-aux-onboard.css no trae colores fijos (todo sale de --r-*/--rx-*, que tienen versión nocturna)', hex.length === 0, hex.join(','));
  const anim = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/\b(animation|transition)\s*:/g) || [];
  t('ni animaciones ni transiciones propias (todas son las del diseño)', anim.length === 0, anim.join(','));
  t('sol en la cabecera (el camino de vuelta a claro)', E.q('.rx-head [data-rg="tema"] use')?.getAttribute('href') === '#rx-Sun');
}

console.log('\n── el ingreso (#screen-login) con login-rx.css — lo ven todos los roles ──');
{
  const E = boot();
  const d = E.w.document;
  const sec = d.getElementById('screen-login');
  t('#screen-login.rx-login', sec.classList.contains('rx-login'));
  t('título «Entra con tu correo» dentro de .rx-ob-h.rx-in con el sobre', sec.querySelector('.rx-ob-h.rx-in h1')?.textContent === 'Entra con tu correo' && !!sec.querySelector('.rx-ob-h .rx-ob-ic'));
  const ids = ['login-form', 'login-email', 'login-password', 'login-submit', 'login-error', 'login-signup'];
  t('los MISMOS ids que usa core.js, uno de cada uno', ids.every(id => d.querySelectorAll('#' + id).length === 1), ids.filter(id => d.querySelectorAll('#' + id).length !== 1).join(','));
  t('los campos siguen dentro del formulario, cada uno en su .rx-field .rx-input',
    ['login-email', 'login-password'].every(id => d.getElementById(id).closest('#login-form') && d.getElementById(id).closest('.rx-field.rx-in .rx-input')));
  t('entrada escalonada --d 1 y 2 (como RxLogin)', [...sec.querySelectorAll('.rx-field.rx-in')].map(l => l.style.getPropertyValue('--d')).join() === '1,2');
  t('#login-submit sigue siendo el submit del formulario, como .rx-btn.pri', d.getElementById('login-submit').type === 'submit' && d.getElementById('login-submit').closest('#login-form') && d.getElementById('login-submit').classList.contains('pri'));
  let enviado = 0;
  d.getElementById('login-form').addEventListener('submit', (e) => { e.preventDefault(); enviado++; });
  d.getElementById('login-email').value = 'ana.restrepo@gmail.com';
  d.getElementById('login-password').value = 'Lluvia7Marzo42';
  d.getElementById('login-submit').click();
  t('tocar «Entrar» dispara el submit que escucha core.js', enviado === 1);
  t('sin código de 6 dígitos, sin chips de dominio, sin «Sin contraseñas»', prohibidos(sec.textContent).length === 0 && !sec.querySelector('.rx-chips, .rx-otp'), prohibidos(sec.textContent).join(','));
  const help = sec.querySelector('.rxl-help');
  t('«¿Problemas para entrar?» como .rx-btn.ghost (no envía el formulario)', !!help && help.type === 'button' && /Problemas para entrar/.test(help.textContent));
  help.click();
  const bg = sec.querySelector('.rx-sheet-bg');
  t('abre la hoja (RxSheet) con «Escríbele a tu coordinador de tripulación»', !!bg && !!bg.querySelector('.rx-sheet .rx-grab') && /Escríbele a tu coordinador de tripulación/.test(bg.textContent));
  t('y no promete un canal que no existe antes de entrar', !/Escribir a soporte/.test(bg.textContent) && enviado === 1);
  bg.click();
  t('tocar el fondo la cierra con .out', bg.classList.contains('out') && bg.isConnected);
  await wait(240);
  t('y se desmonta a los 220 ms', !bg.isConnected);
  t('«Crear mi cuenta» (#login-signup) como .rx-btn.sec', d.getElementById('login-signup').classList.contains('sec'));
}
{
  const sin = HTML.replace(/\s*<link rel="stylesheet" href="login-rx\.css"\s*\/?>/, '');
  const E = boot({ html: sin });
  const sec = E.w.document.getElementById('screen-login');
  t('quitar el <link> de login-rx.css revierte el ingreso (no se toca el DOM)', sin !== HTML && !sec.classList.contains('rx-login') && sec.querySelector('h1').textContent.trim() === 'Iniciar sesión' && !sec.querySelector('.rx-input'));
}

console.log(`\n${ok}/${ok + bad} pasaron${bad ? ' · ' + bad + ' FALLARON' : ''}`);
console.log('NO cubierto: layout, animaciones reales, cómo se ve de noche (solo la clase y el atributo), Leaflet y red.');
process.exit(bad ? 1 : 0);
