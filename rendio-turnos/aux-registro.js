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
      name: '', email: '', phone: '', pass: '', pass2: '',
      airlineId: null,
      resId: null, unit: '',
      hasSecond: false, resId2: null, unit2: '',
      manual: false, address: '', lat: null, lng: null, locConfirmed: false,
    },
    touched: {},        // qué campos ya perdieron el foco (para no pintar rojo mientras escribe)
    // Cada campo de contraseña tiene su propio ojo: si fuera uno solo, destapar
    // la de arriba destapa también la repetición, que es justo la que la persona
    // está mirando de reojo en el bus.
    showPass: false, showPass2: false,
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

  // ---------------------------------------------------------------------------
  // La contraseña (2026-09-11)
  //
  // Hasta hoy se pedía UNA sola vez y la única regla era «mínimo 8». Con eso
  // entraba «12345678», que es literalmente la primera de cualquier lista de
  // ataque, y no había forma de cazar un dedazo: el tripulante escribía mal la
  // contraseña que acababa de inventar, la app lo dejaba pasar igual, y al día
  // siguiente no podía entrar a pedir su traslado. Recuperar cuenta, además,
  // hoy pasa por un correo que el proyecto casi no puede mandar (ver arriba).
  //
  // LA REGLA QUE SE ESCOGIÓ Y LA QUE NO
  // Dura: 10 caracteres, con letra Y número. Eso es todo lo que apaga el botón.
  // NO se exige mayúscula ni símbolo, y es a propósito: obligar a las cuatro
  // cosas a la vez produce «Rendio2026!» —cumple el reglamento y está en
  // cualquier diccionario de ataque— y encima, en el teclado de un teléfono a
  // la 1 a.m., el símbolo cuesta dos capas de teclado. Mayúscula, símbolo y
  // largo de más viven en el MEDIDOR como sugerencias: suben la barra, nunca
  // bloquean.
  //
  // Lo otro que sí bloquea es lo adivinable: seguidillas, renglones del teclado,
  // las palabras de esta misma app y los datos que la persona acaba de escribir
  // tres campos más arriba. Diez caracteres no valen nada si son su propio
  // nombre y el año.
  // ---------------------------------------------------------------------------
  const PASS_MIN = 10;
  const PASS_HOLGADA = 14;                       // de aquí para arriba ya no se sugiere alargarla
  const RX_LETRA   = /[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/;
  const RX_MAYUS   = /[A-ZÁÉÍÓÚÜÑ]/;
  const RX_MINUS   = /[a-záéíóúüñ]/;
  const RX_NUM     = /[0-9]/;
  const RX_SIMBOLO = /[^A-Za-z0-9ÁÉÍÓÚÜÑáéíóúüñ]/;
  const RX_REPE    = /(.)\1{3,}/;                // el mismo caracter cuatro veces: «aaaa1234»

  // Las palabras cantadas. Lista CORTA a propósito: un diccionario de verdad no
  // cabe en un archivo que se baja por red móvil en la portería de un conjunto,
  // y las que de verdad se van a intentar EN ESTA app son estas — el nombre del
  // negocio y el de la aerolínea en la que la persona vuela todos los días.
  const PASS_CANTADAS = [
    'rendio', 'turnos', 'tripulante', 'aeropuerto', 'rionegro', 'medellin', 'colombia',
    'avianca', 'jetsmart', 'wingo', 'latam',
    'contrasena', 'password', 'clave', 'admin', 'iloveyou', 'futbol',
  ];
  // Los renglones del teclado, en los dos sentidos (hay quien los escribe al
  // revés creyendo que eso lo salva).
  const PASS_FILAS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', 'poiuytrewq', 'lkjhgfdsa', 'mnbvcxz'];
  // Doblar los números a la letra que imitan. «R3nd10» es «rendio» para
  // cualquiera que ataque y tiene que serlo también para nosotros.
  const PASS_LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's', '!': 'i' };
  const leet = (s) => s.replace(/[0134578@$!]/g, (c) => PASS_LEET[c]);

  // Cinco caracteres seguidos subiendo o bajando. Cinco y no cuatro porque
  // «qwer» o «2345» todavía caben por casualidad dentro de algo bueno; cinco ya
  // no es casualidad. Se exige que la corrida vaya SIEMPRE en el mismo sentido:
  // si no, «ababab» (sube, baja, sube) contaría como seguidilla y el mensaje
  // diría una mentira.
  function corridaSeguida(p) {
    let largo = 1;
    for (let i = 1; i < p.length; i++) {
      const d = p.charCodeAt(i) - p.charCodeAt(i - 1);
      const dAnt = i > 1 ? p.charCodeAt(i - 1) - p.charCodeAt(i - 2) : 0;
      if ((d === 1 || d === -1) && (largo === 1 || d === dAnt)) largo++;
      else largo = (d === 1 || d === -1) ? 2 : 1;
      if (largo >= 5) return true;
    }
    return false;
  }
  function filaTeclado(p) {
    for (const fila of PASS_FILAS) {
      for (let i = 0; i + 5 <= fila.length; i++) if (p.includes(fila.slice(i, i + 5))) return true;
    }
    return false;
  }

  // Lo que la persona acabó de escribir en ESTE mismo formulario. Es la lista
  // negra que de verdad importa: el compañero que le presta el teléfono sabe su
  // nombre y su celular de memoria.
  function passDatosPropios() {
    const out = [];
    // Palabras de 4 letras para arriba. Con 3 se empieza a regañar de mentiras
    // —si se llama Ana, «Manzana72x» traería «ana» adentro— y no hay forma de
    // explicarle eso a alguien sin que crea que la app está dañada.
    cleanName(st.f.name).split(' ').forEach(w => { if (w.length >= 4) out.push(norm(w)); });
    const usuario = ((st.f.email || '').trim().toLowerCase().split('@')[0] || '');
    usuario.split(/[^a-z]+/).forEach(w => { if (w.length >= 4) out.push(w); });
    const tel = (st.f.phone || '').replace(/\D/g, '');
    if (tel.length >= 5) out.push(tel);
    if (tel.length >= 7) out.push(tel.slice(-7));   // los siete de atrás, que es lo que la gente repite
    return out;
  }

  function passAdivinable(v) {
    const plano = norm(v);            // minúsculas y sin tildes, con los dígitos intactos
    if (RX_REPE.test(plano)) return 'repetida';
    if (corridaSeguida(plano)) return 'seguidilla';
    if (filaTeclado(plano)) return 'teclado';
    // Los números se doblan a letras RECIÉN AQUÍ. Si se hiciera antes, «123456»
    // se volvería «izeasg» y la seguidilla dejaría de verse.
    const letras = leet(plano);
    if (PASS_CANTADAS.some(w => plano.includes(w) || letras.includes(w))) return 'palabra';
    if (passDatosPropios().some(w => w && (plano.includes(w) || letras.includes(w)))) return 'tuyo';
    return null;
  }

  // Una sola pasada que dice QUÉ falla. Los textos van aparte porque la misma
  // falla se dice dos veces y con distinto largo: tendido bajo el campo y
  // apretado al lado de la barra.
  function passCheck(v) {
    const p = v || '';
    if (!p) return { falla: 'vacia' };
    if (p.length < PASS_MIN) return { falla: 'corta', faltan: PASS_MIN - p.length, van: p.length };
    if (!RX_LETRA.test(p)) return { falla: 'letra' };
    if (!RX_NUM.test(p)) return { falla: 'numero' };
    const t = passAdivinable(p);
    if (t) return { falla: 'adivinable', tipo: t };
    return { falla: null };
  }

  // Ninguno de estos dice «contraseña inválida». Se dice QUÉ LE FALTA, que es lo
  // único que la persona puede hacer con la información.
  const PASS_LARGO = {
    repetida:   'Repite el mismo caracter cuatro veces seguidas. Suéltale algo distinto en el medio.',
    seguidilla: 'Trae una seguidilla (123456, abcdef). Es de lo primero que prueban: revuélvela un poco.',
    teclado:    'Eso es un renglón del teclado (qwerty, asdfgh). Se adivina igual de rápido que 123456.',
    palabra:    'Trae una palabra de aquí mismo (Rendio, tu aerolínea). Sería lo primero que alguien probaría en esta app.',
    tuyo:       'Trae tu nombre, tu correo o tu celular. Quien te conoce ya los tiene: mejor algo que no salga de tus datos.',
  };
  const PASS_CORTO = {
    repetida:   'Repite mucho un caracter.',
    seguidilla: 'Trae una seguidilla.',
    teclado:    'Es un renglón del teclado.',
    palabra:    'Trae una palabra de la app.',
    tuyo:       'Trae tus propios datos.',
  };

  function passError(v) {
    const c = passCheck(v);
    if (c.falla === 'vacia') return 'Elige una contraseña.';
    if (c.falla === 'corta') return c.faltan === 1
      ? `Te falta 1 caracter: son ${PASS_MIN} como mínimo.`
      : `Te faltan ${c.faltan} caracteres: son ${PASS_MIN} como mínimo.`;
    if (c.falla === 'letra') return 'Súmale una letra: de puros números se adivina rapidísimo.';
    if (c.falla === 'numero') return 'Súmale un número, aunque sea uno.';
    if (c.falla === 'adivinable') return PASS_LARGO[c.tipo];
    return null;
  }

  // La repetición. El VERDE de «Coinciden» sale en vivo, tecla por tecla; este
  // rojo espera a que salga del campo, como todos los demás errores de esta
  // pantalla — decirle «no son iguales» cuando lleva tres letras de la segunda
  // es regañarla por ir a la mitad.
  function pass2Error(v) {
    if (!v) return 'Escríbela otra vez para confirmar.';
    if (v !== st.f.pass) return 'Esta y la de arriba no son la misma todavía.';
    return null;
  }

  // El medidor: cuatro segmentos y, al lado, QUÉ LE FALTA en palabras. El color
  // solo no dice nada — «amarillo» no le explica a nadie qué tiene que cambiar.
  // Nivel 1 es «todavía no pasa»; de 2 para arriba ya pasa y lo que suba es
  // sugerencia (largo, mayúscula, símbolo), nunca requisito.
  const PASS_TITULOS = ['', 'Todavía no', 'Aceptable', 'Buena', 'Muy buena'];
  function passMedidor(v) {
    const p = v || '';
    const c = passCheck(p);
    const flojo = (dice) => ({ nivel: 1, titulo: PASS_TITULOS[1], dice });
    if (c.falla === 'vacia') return { nivel: 0, titulo: '', dice: `Mínimo ${PASS_MIN} caracteres, con letras y números.` };
    if (c.falla === 'corta') return flojo(`Vas en ${c.van} de ${PASS_MIN}.`);
    if (c.falla === 'letra') return flojo('Le falta una letra.');
    if (c.falla === 'numero') return flojo('Le falta un número.');
    if (c.falla === 'adivinable') return flojo(PASS_CORTO[c.tipo]);
    const falta = [];
    if (p.length < PASS_HOLGADA) falta.push('alárgala un poco');
    if (!(RX_MAYUS.test(p) && RX_MINUS.test(p))) falta.push('métele una mayúscula');
    if (!RX_SIMBOLO.test(p)) falta.push('ponle un signo (. - * !)');
    const nivel = Math.min(4, 2 + (3 - falta.length));
    return {
      nivel, titulo: PASS_TITULOS[nivel],
      dice: falta.length ? `Para subirla: ${falta.join(' · ')}.` : 'No le falta nada.',
    };
  }

  const datosErrors = () => ({
    name: nameError(st.f.name), email: emailError(st.f.email),
    phone: phoneError(st.f.phone), pass: passError(st.f.pass), pass2: pass2Error(st.f.pass2),
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
    st.f = { name: '', email: '', phone: '', pass: '', pass2: '', airlineId: null,
      resId: null, unit: '', hasSecond: false, resId2: null, unit2: '',
      manual: false, address: '', lat: null, lng: null, locConfirmed: false };
    st.touched = {}; st.showPass = false; st.showPass2 = false;
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
  function errBox(key, err) {
    const bad = err && st.touched[key];
    return `<div class="rg-err${bad ? '' : ' vacio'}" data-rg-err="${key}">${errHTML(key, err)}</div>`;
  }
  function field(label, key, type, ph, err, attrs) {
    const bad = err && st.touched[key];
    return `
      <label class="ax-label">${label}
        <input class="ax-input${bad ? ' bad' : ''}" data-rg-field="${key}" type="${type || 'text'}"
               value="${esc(st.f[key])}" placeholder="${esc(ph || '')}" ${attrs || ''} />
      </label>
      ${errBox(key, err)}`;
  }

  // Los dos campos de contraseña son el mismo molde, pero NO pasan por field():
  // llevan el botón de ver/ocultar dentro del recuadro y entre el campo y su
  // error se meten cosas (el medidor en uno, el «Coinciden» en el otro), así que
  // el renglón rojo lo pone quien llama.
  //
  // autocomplete="new-password" en los DOS: es lo que hace que el llavero del
  // teléfono ofrezca generar una y, sobre todo, que NO rellene la vieja del
  // tripulante que prestó el celular. Y autocapitalize apagado porque iOS pone
  // mayúscula a la primera letra sin avisar — y la contraseña que se guarda no
  // es la que la persona cree que escribió.
  //
  // El texto de adentro NO repite «mínimo 10»: eso lo dice el medidor dos
  // renglones más abajo, y verlo en los dos sitios se lee como si fueran dos
  // reglas distintas. Lo que sí hay que decir ahí es que es NUEVA, porque si no
  // media gente escribe la del correo.
  function passField(label, key, visible, accion, ph, err) {
    const bad = err && st.touched[key];
    return `
      <label class="ax-label">${label}
        <span class="rg-pw">
          <input class="ax-input${bad ? ' bad' : ''}" data-rg-field="${key}"
                 type="${visible ? 'text' : 'password'}" value="${esc(st.f[key])}"
                 placeholder="${esc(ph)}" autocomplete="new-password"
                 autocapitalize="none" autocorrect="off" spellcheck="false" />
          <button type="button" class="rg-pw-eye" data-rg="${accion}"
                  aria-label="${visible ? 'Ocultar la contraseña' : 'Mostrar la contraseña'}">${visible ? 'Ocultar' : 'Ver'}</button>
        </span>
      </label>`;
  }

  // Los dos pedazos que se repintan solos en cada tecla (ver refreshPass): van
  // marcados con data-* y no con id porque de este archivo ya hay JS ajeno que
  // busca por id, y porque así se pueden reemplazar de una con outerHTML.
  function medidorHTML() {
    const m = passMedidor(st.f.pass);
    let segs = '';
    for (let i = 1; i <= 4; i++) segs += `<span class="rg-meter-seg${i <= m.nivel ? ' on' : ''}"></span>`;
    return `<div class="rg-meter n${m.nivel}" data-rg-meter>
        <div class="rg-meter-bar" aria-hidden="true">${segs}</div>
        <div class="rg-meter-txt">${m.titulo ? `<b>${esc(m.titulo)}</b> ` : ''}${esc(m.dice)}</div>
      </div>`;
  }
  // El verde aparece en la misma tecla en que las dos se igualan: es la única
  // señal que llega a tiempo para evitar el dedazo.
  function coincidenHTML() {
    const ok = !!(st.f.pass && st.f.pass2 && st.f.pass === st.f.pass2);
    return `<div class="rg-match${ok ? '' : ' vacio'}" data-rg-match>${
      ok ? '<svg class="icon"><use href="#i-check"/></svg>Coinciden' : ''}</div>`;
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
        ${passField('Contraseña', 'pass', st.showPass, 'ver-pass', 'Inventa una nueva', e.pass)}
        ${errBox('pass', e.pass)}
        ${medidorHTML()}
        ${passField('Repite la contraseña', 'pass2', st.showPass2, 'ver-pass2', 'La misma de arriba', e.pass2)}
        ${coincidenHTML()}
        ${errBox('pass2', e.pass2)}
        ${st.err ? `<div class="ax-hint bad"><svg class="icon"><use href="#i-warn"/></svg>${esc(st.err)}</div>` : ''}
        <div class="ax-spacer"></div>
      </div>
      <div class="ax-cta-bar rg-cta">
        <button class="ax-btn ax-btn-primary" data-rg="crear" ${(!datosOk() || st.busy) ? 'disabled' : ''}>
          ${st.busy ? 'Enviando el código…' : 'Continuar'}
        </button>
        <button class="ax-btn ax-btn-ghost" data-rg="salir">Ya tengo cuenta</button>
      </div>`;
  }

  // ---------------------------------------------------------------------------
  // EL COLOR DE CADA AEROLÍNEA (2026-09-11) — una sola constante, a propósito
  //
  // Las cuatro opciones eran cuatro botones blancos idénticos con el mismo
  // avioncito. Quien se registra a las 11 p.m. tiene que LEER las cuatro para
  // encontrar la suya; con color la encuentra antes de leer.
  //
  // POR QUÉ NO HAY LOGOS. Son marca registrada de terceros y Rendio es un
  // proveedor de transporte, no un canal autorizado de ninguna de ellas: poner
  // el logo insinúa un acuerdo que no existe. Además habría que bajar cuatro
  // imágenes en una red móvil de portería. Degradado + la sigla IATA pesa CERO
  // y se reconoce igual de rápido.
  //
  // POR QUÉ ESTOS HEXADECIMALES (aproximaciones, no los oficiales):
  //   AV Avianca   rojo    #D91323 → #8C0A18   el rojo con el que vuelan
  //   JA JetSMART  ámbar   #F5C038 → #C98A12   OJO: su naranja real se parece
  //        peligrosamente al de Rendio (#F26522, matiz ~19°). Este se corrió a
  //        matiz ~43° —francamente amarillo— para que nadie lea «la opción
  //        naranja» como «la opción seleccionada». Y por eso mismo es la única
  //        con tinta OSCURA: sobre amarillo, el blanco no se lee.
  //   P5 Wingo     fucsia  #B02A9B → #6A1163   morado/fucsia de su marca
  //   LA LATAM     índigo  #3A34A8 → #191668   su azul corporativo
  //
  // CONTRASTE, medido contra el peor extremo del degradado de cada una
  // (WCAG, texto sobre fondo): AV 5.2:1 · JA 5.8:1 · P5 5.8:1 · LA 9.4:1 y el
  // de repuesto 6.4:1. Todas por encima de 4.5:1 en modo claro. El estado sin
  // elegir solo baja la SATURACIÓN (filter: saturate), que conserva la
  // luminancia y por tanto el contraste; de noche se baja además el brillo y el
  // peor par medido queda en 4.8:1. Si alguien cambia un hexadecimal, que
  // vuelva a medir: es la única razón por la que la tinta está en el mapa.
  //
  // LA LLAVE ES EL iata_code, y hay caso por defecto: el día que operaciones
  // agregue una quinta aerolínea desde el padrón, sale gris pizarra con su
  // sigla —o con sus iniciales si ni siquiera tiene código— y no se rompe nada.
  //
  // Se publica en window.MarcasAerolinea porque el frente del prefijo de vuelo
  // va a pintar los mismos colores, y dos mapas de color separados terminan
  // siempre con un Wingo de dos morados distintos.
  // ---------------------------------------------------------------------------
  const MARCAS_AEROLINEA = {
    AV: { c1: '#D91323', c2: '#8C0A18', tinta: '#FFFFFF' },
    JA: { c1: '#F5C038', c2: '#C98A12', tinta: '#241A05' },
    P5: { c1: '#B02A9B', c2: '#6A1163', tinta: '#FFFFFF' },
    LA: { c1: '#3A34A8', c2: '#191668', tinta: '#FFFFFF' },
  };
  const MARCA_DE_REPUESTO = { c1: '#54606E', c2: '#2E3742', tinta: '#FFFFFF' };
  // Rescate por nombre: signup_catalogs() puede no estar devolviendo iata_code
  // (la tabla airlines sí lo tiene). Sin esto, las cuatro de siempre saldrían
  // grises el día que alguien toque esa función.
  const SIGLA_POR_NOMBRE = { avianca: 'AV', jetsmart: 'JA', wingo: 'P5', latam: 'LA' };

  function siglaAerolinea(a) {
    const code = String(a?.iata_code || '').trim().toUpperCase();
    if (code) return code.slice(0, 3);
    const n = norm(a?.name || '').replace(/[^a-z]/g, '');
    for (const k in SIGLA_POR_NOMBRE) if (n.includes(k)) return SIGLA_POR_NOMBRE[k];
    // Ni código ni nombre conocido: las iniciales. Fea pero nunca vacía.
    return String(a?.name || '?').trim().split(/\s+/).map(w => w[0] || '').join('').slice(0, 2).toUpperCase() || '?';
  }
  function marcaAerolinea(a) {
    return MARCAS_AEROLINEA[siglaAerolinea(a)] || MARCA_DE_REPUESTO;
  }
  window.MarcasAerolinea = {
    mapa: MARCAS_AEROLINEA, repuesto: MARCA_DE_REPUESTO,
    sigla: siglaAerolinea, color: marcaAerolinea,
  };

  // ---------- paso 3 ----------
  //
  // Los colores viajan como variables CSS en el style= porque son dato, no
  // diseño fijo: el CSS no puede saber cuántas aerolíneas hay. Lo que se inyecta
  // sale SIEMPRE del mapa de arriba —nunca de la base—, así que ahí no entra
  // texto ajeno; lo que sí viene de la base (nombre y sigla) va escapado y en
  // nodos de texto, jamás dentro del atributo style.
  //
  // El subtítulo se pinta siempre, elegida o no, y cambia de palabras. Eso hace
  // dos cosas: dice el estado con LETRAS y no solo con un borde, y evita que la
  // tarjeta crezca al tocarla (si el texto apareciera solo al elegir, la lista
  // daría un brinco bajo el dedo).
  function airlineHTML() {
    const list = st.cat?.airlines || [];
    if (!list.length) return `<div class="axr-load"><span class="axr-spin"></span>Cargando aerolíneas…</div>`;
    return list.map(a => {
      const sel = st.f.airlineId === a.id;
      const m = marcaAerolinea(a);
      return `<button class="ax-opt rg-air${sel ? ' sel' : ''}" data-rg="airline" data-id="${esc(a.id)}"
          style="--air-1:${m.c1};--air-2:${m.c2};--air-ink:${m.tinta}" aria-pressed="${sel ? 'true' : 'false'}">
        <span class="rg-air-sigla" aria-hidden="true">${esc(siglaAerolinea(a))}</span>
        <div><b>${esc(a.name)}</b><span>${sel ? 'Tu aerolínea' : 'Toca para elegirla'}</span></div>
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
    //
    // OJO: esta lista es blanca y literal. El campo que no esté aquí NUNCA se
    // marca como tocado, y entonces su error no se pinta jamás mientras el botón
    // se queda apagado sin decir por qué. Le pasó a 'pass2' el día que se
    // agregó (2026-09-11): todo escrito, botón muerto y ni una letra roja.
    el.addEventListener('focusout', (ev) => {
      const k = ev.target.dataset?.rgField;
      if (!k || st.touched[k]) return;
      if (['name', 'email', 'phone', 'pass', 'pass2'].indexOf(k) < 0) return;
      // Tocar «Ver» no es salir del campo: es mirar lo que uno lleva escrito.
      // Sin esto, destapar la contraseña a mitad de camino pinta el rojo de
      // «te faltan 4 caracteres» justo cuando la persona está revisando.
      // (En Safari de iPhone el botón no recibe foco y relatedTarget viene
      // vacío, así que allá el rojo sigue saliendo — no hay cómo evitarlo.)
      if (ev.relatedTarget?.classList?.contains('rg-pw-eye')) return;
      st.touched[k] = true;
      if (st.view !== 'datos') return;
      // Repintado QUIRÚRGICO, jamás render(). Cuando uno sale de «Contraseña»
      // el foco YA está dentro de «Repite la contraseña», y render() rehace el
      // HTML del paso completo: se lleva por delante el campo destino junto con
      // lo que la persona acabara de teclear ahí, y encima le quita el foco. Es
      // el mismo cuidado que ya tienen onField, refreshPass, onQuery y
      // refreshPinRow — este era el único sitio que se había quedado atrás.
      const err = datosErrors()[k];
      const inp = el.querySelector(`[data-rg-field="${k}"]`);
      if (inp) inp.classList.toggle('bad', !!err);
      const box = el.querySelector(`[data-rg-err="${k}"]`);
      if (box) { box.innerHTML = errHTML(k, err); box.classList.toggle('vacio', !err); }
      refreshPass();
      const cta = el.querySelector('[data-rg="crear"]');
      if (cta) cta.disabled = !datosOk() || st.busy;
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
      // El medidor y el «Coinciden» se repintan con CUALQUIER campo, no solo con
      // los dos de contraseña: la lista negra mira el nombre, el correo y el
      // celular, así que corregir un apellido puede volver adivinable una
      // contraseña que ya estaba escrita. Es barato y no toca el input que tiene
      // el foco, solo sus clases y los dos recuadros de al lado.
      refreshPass();
    }
    if (st.view === 'perfil') {
      const cta = root()?.querySelector('.ax-cta-bar .ax-btn-primary');
      if (cta) cta.disabled = !perfilReady() || st.busy;
    }
  }

  // Repintado en vivo de la contraseña: la barra, el «Coinciden» y —si ya se
  // tocaron— los dos renglones rojos. Mismo cuidado que en onField y en
  // refreshPinRow: NO se llama a render(), porque repintar la pantalla entera
  // remonta el input, le manda el cursor al final y en el teléfono cierra el
  // teclado a media contraseña.
  function refreshPass() {
    const el = root(); if (!el || st.view !== 'datos') return;
    const e = datosErrors();
    ['pass', 'pass2'].forEach(k => {
      const bad = !!(e[k] && st.touched[k]);
      const inp = el.querySelector(`[data-rg-field="${k}"]`);
      if (inp) inp.classList.toggle('bad', bad);
      const box = el.querySelector(`[data-rg-err="${k}"]`);
      if (box) { box.innerHTML = errHTML(k, e[k]); box.classList.toggle('vacio', !bad); }
    });
    // outerHTML y no innerHTML: el nivel vive en la CLASE del contenedor
    // (.rg-meter.n3), que es lo que le da color a los segmentos.
    const med = el.querySelector('[data-rg-meter]');
    if (med) med.outerHTML = medidorHTML();
    const mat = el.querySelector('[data-rg-match]');
    if (mat) mat.outerHTML = coincidenHTML();
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
    // Ver / ocultar, uno por campo. Se cambia EN SITIO y no con render(): antes
    // repintaba la pantalla entera, y en el teléfono eso remonta el input, se
    // lleva el cursor al final y cierra el teclado — justo cuando la persona
    // quería mirar lo que llevaba escrito.
    if (a === 'ver-pass' || a === 'ver-pass2') {
      const dos = a === 'ver-pass2';
      const k = dos ? 'pass2' : 'pass';
      const on = dos ? (st.showPass2 = !st.showPass2) : (st.showPass = !st.showPass);
      const inp = root()?.querySelector(`[data-rg-field="${k}"]`);
      if (inp) inp.type = on ? 'text' : 'password';
      if (el) {
        el.textContent = on ? 'Ocultar' : 'Ver';
        el.setAttribute('aria-label', on ? 'Ocultar la contraseña' : 'Mostrar la contraseña');
      }
      return;
    }
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
    // Este ya casi no debería salir: desde 2026-09-11 la pantalla exige 10 con
    // letra y número antes de dejar tocar el botón. Queda por si Supabase sube
    // su propio mínimo en el panel y nos pasa por encima.
    if (m.includes('password'))
      return `La contraseña no le sirve al sistema: usa mínimo ${PASS_MIN} caracteres, con letras y números.`;
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
