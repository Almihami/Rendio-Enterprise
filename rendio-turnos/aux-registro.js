// aux-registro.js — El TCP se crea su propia cuenta.
//
// POR QUÉ EXISTE ESTE ARCHIVO
// Hasta hoy un tripulante solo existía si alguien del equipo le creaba la cuenta
// a mano. El jefe lo pidió al revés: «que el registro tome todos los datos […] y
// que solo sea una vez, que eso ya les quede guardado, que se les cree un perfil
// […] y que ellos entren ya, solamente le hundan a la aplicación».
//
// EL RECORRIDO (los cuatro pasos que ve el tripulante)
//   1. datos   — nombre completo, correo, teléfono, contraseña.
//   2. perfil  — aerolínea, conjunto, apartamento y —si aplica— su segunda
//                unidad. Ya corre CON sesión, contra signup_catalogs().
//   3. listo   — bienvenida y entrada a la app.
//
// FALTA UN PASO Y NO ES UN OLVIDO
// Entre 1 y 2 iba la verificación del correo con un código de dígitos. Se sacó
// el 2026-08-25: el correo que Supabase presta para pruebas admite unos 2
// mensajes por hora y con eso no se puede abrir el registro a nadie. El paso
// está terminado y probado, guardado en
// correo-registro/PENDIENTE-verificacion-correo.js, con las instrucciones para
// volver a ponerlo el día que el proyecto tenga plan pago.
//
// LO QUE ESO IMPLICA HOY: el correo NO se comprueba. Cualquiera puede
// registrarse con la dirección que quiera, incluida la de otra persona. Es una
// decisión tomada a sabiendas para poder avanzar, no un descuido.
//
// DÓNDE SE PINTA
// Dentro de #auxiliar-ui, el mismo contenedor del rol auxiliar. No es pereza:
// todo el CSS del rol está scopeado ahí, y el registro es la puerta de entrada
// de esa misma app — tiene que verse exactamente igual, incluido el modo
// nocturno (alguien se registra a las 11 p.m. la noche antes de su primer vuelo).
// Al terminar, este módulo le entrega el contenedor a Auxiliar.init() sin que la
// pantalla parpadee.
//
// LO QUE NO HACE, A PROPÓSITO
//  · No verifica el correo: ver arriba.
//  · No decide la fecha de ingreso ni la organización: eso lo hace
//    register_auxiliar() en el servidor (0076). Desde el teléfono no se puede
//    pactar la antigüedad de uno mismo.
//  · No guarda la contraseña en ningún lado nuestro. La sesión de Supabase ya
//    queda persistida en el navegador, que es lo que el jefe pide cuando dice
//    «que solo le hundan a la aplicación y entren».

(function () {
  'use strict';

  const st = {
    view: 'datos',
    f: {
      name: '', email: '', phone: '', pass: '',
      airlineId: null,
      resId: null, unit: '',
      hasSecond: false, resId2: null, unit2: '',
      manual: false, address: '', lat: null, lng: null, locConfirmed: false,
    },
    touched: {},        // qué campos ya perdieron el foco (para no pintar rojo mientras escribe)
    showPass: false,
    cat: null, q: '', q2: '',
    picking: 1,         // qué unidad se está eligiendo en la hoja del buscador (1 o 2)
    busy: false, err: '',
    map: null, marker: null, geoReq: 0, geoTimer: null,
    profile: null,
  };

  const root = () => document.getElementById('auxiliar-ui');
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const say = (m) => { if (typeof toast === 'function') toast(m); };

  // ---------------------------------------------------------------------------
  // Validaciones
  //
  // La del nombre es la regla textual del jefe: «al menos el primer nombre y los
  // dos apellidos». Tres palabras. La misma comprobación vive en
  // register_auxiliar() (0076), porque esta pantalla se puede saltar y la base
  // de datos no.
  // ---------------------------------------------------------------------------
  const cleanName = (s) => (s || '').replace(/\s+/g, ' ').trim();
  function nameError(v) {
    const n = cleanName(v);
    if (!n) return 'Escribe tu nombre completo.';
    if (!/^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ' .-]+$/.test(n)) return 'Solo letras: sin números ni símbolos.';
    const w = n.split(' ');
    if (w.length < 3) return 'Faltan apellidos: al menos tu primer nombre y los dos apellidos.';
    if (w.some(x => x.length < 2)) return 'Alguna palabra quedó en una sola letra. Escríbelo completo.';
    return null;
  }
  function emailError(v) {
    const e = (v || '').trim();
    if (!e) return 'Escribe tu correo.';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(e)) return 'Ese correo no está completo.';
    // Los dominios de prueba los rechaza el propio Supabase con un mensaje en
    // inglés; se dice antes y en español.
    if (/@(rendio\.demo|example\.com|test\.com)$/i.test(e)) return 'Usa tu correo personal de verdad: ahí te llega el código.';
    return null;
  }
  function phoneError(v) {
    const d = (v || '').replace(/\D/g, '');
    if (!d) return 'Escribe tu celular.';
    if (d.length < 7) return 'Ese número está incompleto.';
    if (d.length > 15) return 'Ese número tiene de más.';
    return null;
  }
  function passError(v) {
    if (!v) return 'Elige una contraseña.';
    if (v.length < 8) return 'Mínimo 8 caracteres.';
    return null;
  }
  const datosErrors = () => ({
    name: nameError(st.f.name), email: emailError(st.f.email),
    phone: phoneError(st.f.phone), pass: passError(st.f.pass),
  });
  const datosOk = () => Object.values(datosErrors()).every(e => !e);

  // El paso 3 está listo cuando hay aerolínea y un punto de recogida. Si marcó
  // que tiene segunda unidad, la segunda también tiene que estar completa: media
  // segunda unidad es peor que ninguna (el día que la elija, el carro no sabe
  // a dónde ir).
  function perfilReady() {
    const f = st.f;
    if (!f.airlineId) return false;
    const uno = f.manual ? !!(f.address && f.locConfirmed) : !!f.resId;
    if (!uno) return false;
    if (f.hasSecond && !f.resId2) return false;
    return true;
  }

  // ---------------------------------------------------------------------------
  // Arranque
  // ---------------------------------------------------------------------------
  function start() {
    reset();
    show();
    render();
  }

  // Alguien que verificó su correo y cerró la app antes de terminar el paso 3.
  // Tiene sesión y no tiene perfil: en vez de echarlo con «tu cuenta no tiene
  // perfil asociado» (que es lo que hacía core.js), se le retoma donde iba.
  async function resume(user) {
    reset();
    st.f.name = cleanName(user?.user_metadata?.full_name || '');
    st.f.phone = user?.user_metadata?.phone || '';
    st.f.email = user?.email || '';
    st.view = 'perfil';
    show();
    render();
    loadCat();
  }

  function reset() {
    destroyMap();
    st.view = 'datos';
    st.f = { name: '', email: '', phone: '', pass: '', airlineId: null,
      resId: null, unit: '', hasSecond: false, resId2: null, unit2: '',
      manual: false, address: '', lat: null, lng: null, locConfirmed: false };
    st.touched = {}; st.showPass = false;
    st.cat = null; st.q = ''; st.q2 = ''; st.picking = 1;
    st.busy = false; st.err = ''; st.profile = null;
  }

  function show() {
    document.getElementById('screen-splash')?.classList.add('hidden');
    document.getElementById('screen-login')?.classList.add('hidden');
    document.getElementById('app-shell')?.classList.add('hidden');
    document.getElementById('auxiliar-root')?.classList.remove('hidden');
    // Modo nocturno desde el primer pintado, igual que el rol auxiliar: si se
    // aplicara después, la primera pantalla da un fogonazo blanco de noche.
    if (window.AuxPresentacion) { AuxPresentacion.applyTheme(); AuxPresentacion.watchTheme(); }
    bindOnce();
  }

  // ---------------------------------------------------------------------------
  // Pintado
  // ---------------------------------------------------------------------------
  function render() {
    const el = root(); if (!el) return;
    el.innerHTML =
      st.view === 'datos' ? datosHTML()
      : st.view === 'perfil' ? perfilHTML()
      : listoHTML();
    afterRender();
  }

  // Sol / luna.
  //
  // El rol auxiliar se pone oscuro solo entre las 7 p.m. y las 6 a.m. (regla del
  // diseñador: quien sale a las 3 a.m. no debería recibir un fogonazo blanco).
  // El selector de las tres opciones vive en la pestaña de perfil… que durante
  // el registro todavía no existe: quien se registra de noche no tenía forma de
  // cambiarlo. Este botón es esa forma.
  //
  // Solo dos estados y no los tres: en un botón de encabezado, «automático» no
  // se puede dibujar sin explicarlo. Tocarlo fija la preferencia; el modo
  // automático se recupera desde el perfil una vez dentro de la app.
  function esNoche() {
    return window.AuxPresentacion ? AuxPresentacion.isNight() : false;
  }
  // Se pinta el icono de a DÓNDE va, no de dónde está: es lo que hace que se
  // entienda sin tocarlo.
  function themeBtnHTML() {
    if (!window.AuxPresentacion) return '';
    const noche = esNoche();
    return `<button class="ax-icbtn rg-tema" data-rg="tema"
      aria-label="${noche ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}"
      title="${noche ? 'Modo claro' : 'Modo oscuro'}">
      <svg class="icon"><use href="#${noche ? 'i-sun' : 'i-moon'}"/></svg>
    </button>`;
  }

  // Dos pasos: los datos y el perfil. Serán tres el día que vuelva la
  // verificación del correo (correo-registro/PENDIENTE-verificacion-correo.js).
  const nPasos = () => 2;

  function head(step, backAction) {
    const n = nPasos();
    // En la PRIMERA pantalla no se pinta el avance, y no es un olvido: cuántos
    // pasos hay lo decide Supabase al registrar (¿pide código o no?), y todavía
    // no ha contestado. Anunciar «1/3» y saltar a «2/2» es peor que no decir
    // nada — el avance aparece cuando ya se sabe de verdad.
    const avance = step > 1;
    const dots = [];
    for (let i = 1; i <= n; i++) dots.push(`<span class="ax-dot ${i <= step ? 'on' : ''}"></span>`);
    return `
      <div class="ax-form-head">
        ${backAction
          ? `<button class="ax-icbtn" data-rg="${backAction}" aria-label="Atrás"><svg class="icon"><use href="#i-back"/></svg></button>`
          : `<span style="width:38px"></span>`}
        <div class="ax-steps">${avance ? dots.join('') : ''}</div>
        <div class="rg-head-r">${themeBtnHTML()}${avance ? `<span class="ax-step-n">${step}/${n}</span>` : ''}</div>
      </div>`;
  }

  // La bienvenida no tiene pasos ni botón de atrás, pero sí tiene que poder
  // cambiar el tema: es la pantalla donde más gente se va a quedar mirando.
  function headSolo() {
    return `<div class="ax-form-head rg-head-solo">
      <span></span><div class="rg-head-r">${themeBtnHTML()}</div>
    </div>`;
  }

  // Campo con error en rojo.
  //
  // El error APARECE solo cuando el campo ya se tocó — ver «Escribe tu nombre
  // completo» en rojo antes de haber escrito una letra es regañar a alguien por
  // algo que no ha hecho todavía. Pero una vez visible, DESAPARECE en la misma
  // tecla en que se corrige, sin esperar a que salga del campo: si no, alguien
  // termina de escribir sus dos apellidos y sigue viendo «faltan apellidos».
  //
  // Por eso el contenedor del error se pinta SIEMPRE (vacío cuando no hay) y lo
  // rellena errHTML() desde onField: repintar la pantalla entera en cada tecla
  // remontaría el input y le movería el cursor al final.
  function errHTML(key, err) {
    return (err && st.touched[key])
      ? `<svg class="icon"><use href="#i-warn"/></svg>${esc(err)}` : '';
  }
  function field(label, key, type, ph, err, attrs) {
    const bad = err && st.touched[key];
    return `
      <label class="ax-label">${label}
        <input class="ax-input${bad ? ' bad' : ''}" data-rg-field="${key}" type="${type || 'text'}"
               value="${esc(st.f[key])}" placeholder="${esc(ph || '')}" ${attrs || ''} />
      </label>
      <div class="rg-err${bad ? '' : ' vacio'}" data-rg-err="${key}">${errHTML(key, err)}</div>`;
  }

  function datosHTML() {
    const e = datosErrors();
    return `
      ${head(1, 'salir')}
      <div class="ax-body">
        <h1 class="ax-form-title">Crea tu cuenta</h1>
        <p class="ax-lead">Es una sola vez. Después entras y solo pides tu traslado.</p>
        ${field('Nombre completo', 'name', 'text', 'Ana Lucía Restrepo Vélez', e.name,
          'autocomplete="name" autocapitalize="words"')}
        <div class="rg-tip">Primer nombre y los dos apellidos.</div>
        ${field('Correo personal', 'email', 'email', 'tucorreo@gmail.com', e.email,
          'autocomplete="email" inputmode="email" autocapitalize="none" spellcheck="false"')}
        <div class="rg-tip">Ahí te llega el código para confirmar.</div>
        ${field('Celular', 'phone', 'tel', '300 123 4567', e.phone,
          'autocomplete="tel" inputmode="tel"')}
        <div class="rg-tip">Para que el conductor te ubique el día del viaje.</div>
        <label class="ax-label">Contraseña
          <span class="rg-pw">
            <input class="ax-input${e.pass && st.touched.pass ? ' bad' : ''}" data-rg-field="pass"
                   type="${st.showPass ? 'text' : 'password'}" value="${esc(st.f.pass)}"
                   placeholder="Mínimo 8 caracteres" autocomplete="new-password" />
            <button type="button" class="rg-pw-eye" data-rg="ver-pass">${st.showPass ? 'Ocultar' : 'Ver'}</button>
          </span>
        </label>
        <div class="rg-err${e.pass && st.touched.pass ? '' : ' vacio'}" data-rg-err="pass">${errHTML('pass', e.pass)}</div>
        ${st.err ? `<div class="ax-hint bad"><svg class="icon"><use href="#i-warn"/></svg>${esc(st.err)}</div>` : ''}
        <div class="ax-spacer rg-spacer2"></div>
      </div>
      <div class="ax-cta-bar rg-cta">
        <button class="ax-btn ax-btn-primary" data-rg="crear" ${(!datosOk() || st.busy) ? 'disabled' : ''}>
          ${st.busy ? 'Enviando el código…' : 'Continuar'}
        </button>
        <button class="ax-btn ax-btn-ghost" data-rg="salir">Ya tengo cuenta</button>
      </div>`;
  }

  // ---------- paso 3 ----------
  function airlineHTML() {
    const list = st.cat?.airlines || [];
    if (!list.length) return `<div class="axr-load"><span class="axr-spin"></span>Cargando aerolíneas…</div>`;
    return list.map(a => {
      const sel = st.f.airlineId === a.id;
      return `<button class="ax-opt${sel ? ' sel' : ''}" data-rg="airline" data-id="${esc(a.id)}">
        <span class="ax-opt-ic"><svg class="icon"><use href="#i-plane"/></svg></span>
        <div><b>${esc(a.name)}</b></div>
        <span class="ax-radio">${sel ? '<svg class="icon"><use href="#i-check"/></svg>' : ''}</span>
      </button>`;
    }).join('');
  }

  const resById = (id) => (st.cat?.residences || []).find(r => r.id === id) || null;

  // El buscador de conjuntos, reutilizado para la unidad 1 y la 2. `n` dice cuál.
  function pickerHTML(n) {
    const q = n === 1 ? st.q : st.q2;
    const list = q
      ? (st.cat?.residences || []).filter(r => norm(r.name + ' ' + (r.sector || '')).includes(norm(q)))
      : (st.cat?.residences || []);
    const rows = list.length
      ? list.slice(0, 60).map(r => `
          <button class="axr-row" data-rg="res-pick" data-n="${n}" data-id="${esc(r.id)}">
            <span class="axr-row-txt"><b>${esc(r.name)}</b>${r.sector ? `<span>${esc(r.sector)}</span>` : ''}</span>
            <svg class="icon axr-chev"><use href="#i-chev"/></svg>
          </button>`).join('')
      : `<div class="axr-none"><b>No encontramos «${esc(q)}»</b>
           <span>Puede que tu conjunto no esté todavía. Más abajo puedes escribir la dirección.</span></div>`;
    return `
      <div class="axr-search">
        <svg class="icon"><use href="#i-search"/></svg>
        <input data-rg-q="${n}" type="text" value="${esc(q)}" placeholder="Busca tu conjunto o sector" autocomplete="off" />
      </div>
      <div class="axr-list" data-rg-list="${n}">${rows}</div>`;
  }

  function pickedHTML(n) {
    const r = resById(n === 1 ? st.f.resId : st.f.resId2);
    if (!r) return '';
    const unitKey = n === 1 ? 'unit' : 'unit2';
    return `
      <div class="rg-picked">
        <div class="rg-picked-txt">
          <b>${esc(r.name)}</b>${r.sector ? `<span>${esc(r.sector)}</span>` : ''}
        </div>
        <button class="ax-link" data-rg="res-change" data-n="${n}">Cambiar</button>
      </div>
      <label class="ax-label">Apartamento o unidad
        <input class="ax-input" data-rg-field="${unitKey}" type="text" value="${esc(st.f[unitKey])}"
               placeholder="Torre 3 · Apto 302" autocapitalize="words" />
      </label>
      <div class="rg-tip">El carro para en la portería; esto es para que el conductor sepa a quién timbra.</div>`;
  }

  function manualHTML() {
    const f = st.f;
    return `
      <button class="axr-back-cat" data-rg="volver-lista"><svg class="icon"><use href="#i-back"/></svg>Volver a la lista de conjuntos</button>
      <label class="ax-label">Dirección
        <input class="ax-input" data-rg-field="address" type="text" value="${esc(f.address)}"
               placeholder="Cra 51 #49-06, Rionegro" />
      </label>
      <div class="ax-geo-hint">Escríbela y después mueve el pin al punto exacto donde para el carro.</div>
      <div id="rg-map" class="ax-map ${f.address ? '' : 'hidden'}"></div>
      <div id="rg-pin-row" class="ax-pin-row ${f.locConfirmed ? 'ok' : ''} ${f.address ? '' : 'hidden'}">
        ${f.locConfirmed
          ? `<svg class="icon"><use href="#i-check"/></svg><span>Ubicación confirmada</span><button class="ax-link" data-rg="pin-edit">Ajustar</button>`
          : `<svg class="icon"><use href="#i-pin"/></svg><span>Mueve el pin al punto exacto y confirma.</span>`}
      </div>
      ${!f.locConfirmed && f.address
        ? `<button class="ax-btn ax-btn-ghost" data-rg="pin-confirm"><svg class="icon"><use href="#i-check"/></svg>Confirmar ubicación</button>`
        : ''}
      <label class="ax-label">Apartamento o unidad
        <input class="ax-input" data-rg-field="unit" type="text" value="${esc(f.unit)}"
               placeholder="Torre 3 · Apto 302" autocapitalize="words" />
      </label>`;
  }

  function perfilHTML() {
    const f = st.f;
    const cargando = !st.cat;
    return `
      ${head(2, null)}
      <div class="ax-body">
        <h1 class="ax-form-title">Ya casi</h1>
        <p class="ax-lead">Esto queda guardado: no vas a tener que escribirlo otra vez.</p>

        <div class="ax-sec">Tu aerolínea</div>
        ${airlineHTML()}

        <div class="ax-sec">Dónde te recogemos</div>
        ${cargando
          ? `<div class="axr-load"><span class="axr-spin"></span>Cargando los puntos de recogida…</div>`
          : f.manual ? manualHTML()
          : f.resId ? pickedHTML(1)
          : `<p class="rg-tip">Ya tenemos ubicadas las porterías de Rionegro. Elige la tuya.</p>
             ${pickerHTML(1)}
             <button class="axr-manual" data-rg="manual">
               <span class="axr-manual-ic"><svg class="icon"><use href="#i-plus"/></svg></span>
               <span class="axr-manual-txt"><b>Mi conjunto no está en la lista</b>
                 <span>Escribe la dirección y ubica el pin</span></span>
             </button>`}

        ${(!cargando && (f.resId || (f.manual && f.locConfirmed))) ? `
          <div class="ax-sec">¿Te quedas en otro sitio a veces?</div>
          ${toggle('Tengo una segunda unidad', 'hasSecond', f.hasSecond,
            'El otro apartamento donde a veces duermes. Cada vez que pidas un traslado eliges de cuál sales.')}
          ${f.hasSecond
            ? (f.resId2 ? pickedHTML(2) : pickerHTML(2))
            : ''}` : ''}

        ${st.err ? `<div class="ax-hint bad"><svg class="icon"><use href="#i-warn"/></svg>${esc(st.err)}</div>` : ''}
        <div class="ax-spacer"></div>
      </div>
      <div class="ax-cta-bar rg-cta">
        <button class="ax-btn ax-btn-primary" data-rg="registrar" ${(!perfilReady() || st.busy) ? 'disabled' : ''}>
          ${st.busy ? 'Creando tu cuenta…' : 'Crear mi cuenta'}
        </button>
      </div>`;
  }

  function toggle(label, key, on, hint) {
    return `
      <div class="ax-toggles">
        <button class="ax-toggle${on ? ' on' : ''}" data-rg="toggle" data-key="${key}">
          <div><b>${esc(label)}</b>${hint ? `<span>${esc(hint)}</span>` : ''}</div>
          <span class="ax-switch"><span class="ax-knob"></span></span>
        </button>
      </div>`;
  }

  function listoHTML() {
    const nombre = (st.profile?.full_name || st.f.name).split(' ')[0];
    return `
      ${headSolo()}
      <div class="ax-body rg-listo">
        <div class="rg-listo-ic"><svg class="icon"><use href="#i-check"/></svg></div>
        <h1 class="ax-form-title">Bienvenido, ${esc(nombre)}</h1>
        <p class="ax-lead">Tu cuenta quedó lista. De aquí en adelante solo abres la app y pides tu traslado —
          tus datos ya están guardados.</p>
        <div class="axp">
          <div class="axp-row"><svg class="icon"><use href="#i-plane"/></svg>
            <div><b>Pide con tu hora de llegada</b>
            <span>Nos dices a qué hora quieres estar en el aeropuerto y nosotros calculamos a qué hora pasa el carro.</span></div></div>
          <div class="axp-row"><svg class="icon"><use href="#i-pin"/></svg>
            <div><b>Tu punto ya está guardado</b>
            <span>No vas a tener que volver a escribir tu dirección.</span></div></div>
          <div class="axp-row"><svg class="icon"><use href="#i-clock"/></svg>
            <div><b>Estás con Rendio desde hoy</b>
            <span>Si ya llevabas tiempo con nosotros, el equipo ajusta tu fecha de ingreso.</span></div></div>
        </div>
        <div class="ax-spacer"></div>
      </div>
      <div class="ax-cta-bar rg-cta">
        <button class="ax-btn ax-btn-primary" data-rg="entrar">Entrar a la app</button>
      </div>`;
  }

  // ---------------------------------------------------------------------------
  // Después de pintar: foco del código y mapa del camino manual
  // ---------------------------------------------------------------------------
  function afterRender() {
    if (st.view === 'perfil' && st.f.manual && st.f.address && st.f.lat != null) {
      mountMap(st.f.lat, st.f.lng);
    } else if (!(st.view === 'perfil' && st.f.manual)) {
      destroyMap();
    }
  }

  function mountMap(lat, lng) {
    const el = document.getElementById('rg-map');
    if (!el || typeof L === 'undefined') return;
    el.classList.remove('hidden');
    destroyMap();
    const map = st.map = L.map(el, { zoomControl: true, attributionControl: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
    map.setView([lat, lng], 16);
    const mk = st.marker = L.marker([lat, lng], { draggable: true }).addTo(map);
    mk.on('dragend', () => {
      const p = mk.getLatLng();
      st.f.lat = p.lat; st.f.lng = p.lng; st.f.locConfirmed = false;
      refreshPinRow();
    });
    setTimeout(() => { try { map.invalidateSize(); } catch (_) {} }, 60);
  }
  function destroyMap() {
    if (!st.map) return;
    try { st.map.remove(); } catch (_) {}
    st.map = null; st.marker = null;
  }
  // Repintado liviano de la fila del pin: si se repintara la pantalla entera se
  // remonta el mapa y el pin salta al centro cada vez que lo mueven.
  function refreshPinRow() {
    const row = document.getElementById('rg-pin-row'); if (!row) return;
    row.className = 'ax-pin-row ' + (st.f.locConfirmed ? 'ok' : '');
    row.innerHTML = st.f.locConfirmed
      ? `<svg class="icon"><use href="#i-check"/></svg><span>Ubicación confirmada</span><button class="ax-link" data-rg="pin-edit">Ajustar</button>`
      : `<svg class="icon"><use href="#i-pin"/></svg><span>Mueve el pin al punto exacto y confirma.</span>`;
    let btn = root()?.querySelector('[data-rg="pin-confirm"]');
    if (!st.f.locConfirmed && !btn) {
      const b = document.createElement('button');
      b.className = 'ax-btn ax-btn-ghost'; b.setAttribute('data-rg', 'pin-confirm');
      b.innerHTML = '<svg class="icon"><use href="#i-check"/></svg>Confirmar ubicación';
      row.after(b);
    } else if (st.f.locConfirmed && btn) { btn.remove(); }
    const cta = root()?.querySelector('.ax-cta-bar .ax-btn-primary');
    if (cta) cta.disabled = !perfilReady() || st.busy;
  }

  async function geocode(q) {
    const my = ++st.geoReq;
    try {
      const u = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=co&q='
        + encodeURIComponent(q + ', Rionegro, Antioquia');
      const r = await (await fetch(u, { headers: { 'Accept-Language': 'es' } })).json();
      if (my !== st.geoReq) return;
      if (r && r[0]) { st.f.lat = parseFloat(r[0].lat); st.f.lng = parseFloat(r[0].lon); }
      else {
        st.f.lat = 6.1537; st.f.lng = -75.3738;   // centro de Rionegro
        say('No ubicamos la dirección exacta — mueve el pin al punto correcto.');
      }
      st.f.locConfirmed = false;
      mountMap(st.f.lat, st.f.lng);
      refreshPinRow();
    } catch (_) { /* silencioso: puede reintentar escribiendo */ }
  }

  // ---------------------------------------------------------------------------
  // Eventos
  // ---------------------------------------------------------------------------
  let bound = false;
  function bindOnce() {
    if (bound) return; bound = true;
    const el = root(); if (!el) return;

    el.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-rg]');
      if (!b || b.disabled) return;
      onAction(b.dataset.rg, b);
    });

    el.addEventListener('input', (ev) => {
      const t = ev.target;
      if (t.dataset.rgField) return onField(t.dataset.rgField, t.value);
      if (t.dataset.rgQ) return onQuery(parseInt(t.dataset.rgQ, 10), t.value);
    });

    // El rojo aparece al SALIR del campo, no mientras se escribe.
    el.addEventListener('focusout', (ev) => {
      const k = ev.target.dataset?.rgField;
      if (!k || st.touched[k]) return;
      if (['name', 'email', 'phone', 'pass'].indexOf(k) < 0) return;
      st.touched[k] = true;
      if (st.view === 'datos') render();
    }, true);

    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && ev.target.dataset?.rgField && st.view === 'datos' && datosOk()) {
        ev.preventDefault(); onAction('crear');
      }
    });
  }

  function onField(key, val) {
    st.f[key] = val;
    if (key === 'address') {
      // No se geocodifica en cada tecla: se espera a que deje de escribir.
      clearTimeout(st.geoTimer);
      const v = val.trim();
      if (v.length < 5) return;
      st.geoTimer = setTimeout(() => geocode(v), 700);
      return;
    }
    // Los campos del paso 1 gobiernan el CTA; se actualiza sin repintar (repintar
    // en cada tecla pierde el foco y el cursor).
    if (st.view === 'datos') {
      const cta = root()?.querySelector('[data-rg="crear"]');
      if (cta) cta.disabled = !datosOk() || st.busy;
      if (st.touched[key]) {
        const err = datosErrors()[key];
        const inp = root()?.querySelector(`[data-rg-field="${key}"]`);
        if (inp) inp.classList.toggle('bad', !!err);
        const box = root()?.querySelector(`[data-rg-err="${key}"]`);
        if (box) { box.innerHTML = errHTML(key, err); box.classList.toggle('vacio', !err); }
      }
    }
    if (st.view === 'perfil') {
      const cta = root()?.querySelector('.ax-cta-bar .ax-btn-primary');
      if (cta) cta.disabled = !perfilReady() || st.busy;
    }
  }

  // El buscador repinta SOLO la lista, para no remontar el input y perder el foco.
  function onQuery(n, v) {
    if (n === 1) st.q = v; else st.q2 = v;
    const cont = root()?.querySelector(`[data-rg-list="${n}"]`);
    if (!cont) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = pickerHTML(n);
    const fresh = tmp.querySelector(`[data-rg-list="${n}"]`);
    if (fresh) cont.innerHTML = fresh.innerHTML;
  }

  async function onAction(a, el) {
    if (a === 'salir') return leave();
    if (a === 'ver-pass') { st.showPass = !st.showPass; return render(); }
    if (a === 'tema') {
      if (!window.AuxPresentacion) return;
      // setThemePref ya repinta el contenedor (aplica data-ax-night); render()
      // es para que el icono pase a mostrar el camino contrario.
      AuxPresentacion.setThemePref(esNoche() ? 'light' : 'night');
      return render();
    }
    if (a === 'crear') return crear();
    if (a === 'airline') { st.f.airlineId = el.dataset.id; return render(); }
    if (a === 'res-pick') {
      const n = parseInt(el.dataset.n, 10);
      if (n === 1) { st.f.resId = el.dataset.id; st.q = ''; }
      else { st.f.resId2 = el.dataset.id; st.q2 = ''; }
      return render();
    }
    if (a === 'res-change') {
      const n = parseInt(el.dataset.n, 10);
      if (n === 1) { st.f.resId = null; st.f.unit = ''; }
      else { st.f.resId2 = null; st.f.unit2 = ''; }
      return render();
    }
    if (a === 'manual') {
      st.f.manual = true; st.f.resId = null;
      st.f.address = ''; st.f.lat = null; st.f.lng = null; st.f.locConfirmed = false;
      return render();
    }
    if (a === 'volver-lista') {
      st.f.manual = false; st.f.address = ''; st.f.lat = null; st.f.lng = null; st.f.locConfirmed = false;
      destroyMap();
      return render();
    }
    if (a === 'pin-confirm') { st.f.locConfirmed = true; refreshPinRow(); return render(); }
    if (a === 'pin-edit') { st.f.locConfirmed = false; return refreshPinRow(); }
    if (a === 'toggle') {
      const k = el.dataset.key;
      st.f[k] = !st.f[k];
      if (k === 'hasSecond' && !st.f.hasSecond) { st.f.resId2 = null; st.f.unit2 = ''; }
      return render();
    }
    if (a === 'registrar') return registrar();
    if (a === 'entrar') return entrar();
  }

  // Sale del registro y vuelve al login. Si había quedado una sesión a medias
  // (correo verificado, perfil sin crear) se cierra: dejarla puesta haría que la
  // próxima apertura entrara en un limbo sin perfil.
  async function leave() {
    destroyMap();
    try { if (await Api.getSession()) await Api.signOut(); } catch (_) {}
    document.getElementById('auxiliar-root')?.classList.add('hidden');
    const el = root(); if (el) el.innerHTML = '';
    document.getElementById('screen-login')?.classList.remove('hidden');
    reset();
  }

  // ---------------------------------------------------------------------------
  // Los tres pasos que hablan con el servidor
  // ---------------------------------------------------------------------------
  async function crear() {
    if (st.busy || !datosOk()) return;
    st.busy = true; st.err = ''; render();
    try {
      const data = await Api.signUpAuxiliar({
        email: st.f.email.trim(), password: st.f.pass,
        fullName: cleanName(st.f.name), phone: st.f.phone.trim(),
      });
      // Con «Confirm email» APAGADO en Supabase (que es como está el proyecto),
      // signUp devuelve la sesión de una y se puede seguir derecho al perfil.
      //
      // Si algún día alguien vuelve a encender esa opción en el panel sin
      // devolver el paso del código, signUp deja al usuario creado pero SIN
      // sesión, y desde acá no hay forma de continuar. No se le puede dejar el
      // botón girando: se le dice qué pasó y a quién avisarle. Es un callejón
      // de configuración, no del tripulante.
      if (!data || !data.session) {
        throw new Error(
          'Tu cuenta quedó creada, pero falta un paso de confirmación que ahora '
          + 'mismo no está disponible. Avísale al coordinador para que la activen.');
      }
      st.view = 'perfil';
      loadCat();
    } catch (e) {
      st.err = mensajeSignup(e);
    } finally { st.busy = false; render(); }
  }

  // Supabase contesta en inglés y con mensajes que no le dicen nada a un
  // tripulante a las 11 de la noche. Se traducen los tres que de verdad pasan.
  function mensajeSignup(e) {
    const m = (e?.message || '').toLowerCase();
    // OJO con este texto: mientras el proyecto use el correo prestado de
    // Supabase el tope es de ~2 mensajes POR HORA, no por minuto. Decir «espera
    // un minuto» manda a la gente a reintentar en balde y a creer que la app
    // está rota. Cuando haya SMTP propio (ver correo-registro/) este caso
    // prácticamente deja de ocurrir.
    if (m.includes('rate limit') || m.includes('too many'))
      return 'Ahora mismo no podemos enviar más correos. No es tu cuenta: es un tope nuestro. Intenta de nuevo en un rato, o avísale al coordinador.';
    if (m.includes('already registered') || m.includes('already been registered'))
      return 'Ese correo ya tiene cuenta. Vuelve e inicia sesión.';
    if (m.includes('invalid') && m.includes('email'))
      return 'Ese correo no lo acepta el sistema. Revisa que esté bien escrito.';
    if (m.includes('password'))
      return 'La contraseña no cumple: usa mínimo 8 caracteres.';
    return e?.message || 'No pudimos crear la cuenta. Intenta de nuevo.';
  }

  async function loadCat() {
    if (st.cat) return;
    try {
      st.cat = await Api.signupCatalogs();
    } catch (e) {
      st.cat = { airlines: [], residences: [] };
      st.err = 'No pudimos cargar la lista de aerolíneas y conjuntos. Revisa tu señal y vuelve a entrar.';
    }
    if (st.view === 'perfil') render();
  }

  async function registrar() {
    if (st.busy || !perfilReady()) return;
    st.busy = true; st.err = ''; render();
    try {
      await Api.registerAuxiliar({
        fullName: cleanName(st.f.name),
        phone: st.f.phone.trim(),
        airlineId: st.f.airlineId,
        residenceId: st.f.manual ? null : st.f.resId,
        unit: st.f.unit.trim() || null,
        residenceId2: st.f.hasSecond ? st.f.resId2 : null,
        unit2: st.f.hasSecond ? (st.f.unit2.trim() || null) : null,
        address: st.f.manual ? st.f.address.trim() : null,
        lat: st.f.manual ? st.f.lat : null,
        lng: st.f.manual ? st.f.lng : null,
      });
      st.profile = await Api.getCurrentProfile();
      st.view = 'listo';
    } catch (e) {
      st.err = e?.message || 'No pudimos crear tu cuenta. Intenta de nuevo.';
    } finally { st.busy = false; render(); }
  }

  // Entra a la app sin recargar: el rol auxiliar toma el mismo contenedor.
  async function entrar() {
    const p = st.profile || await Api.getCurrentProfile();
    destroyMap();
    if (st.resendTimer) { clearInterval(st.resendTimer); st.resendTimer = null; }
    if (typeof window.enterAppAs === 'function') return window.enterAppAs(p);
    location.reload();
  }

  window.AuxRegistro = { start, resume, state: st };
})();
