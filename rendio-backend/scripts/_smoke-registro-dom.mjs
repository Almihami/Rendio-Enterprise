// Prueba de pintado del registro (0075) sobre un DOM de verdad (jsdom).
// No reemplaza mirarlo en un teléfono, pero atrapa lo que de otro modo se
// descubre en producción: una función que no existe, una plantilla rota, un
// paso que no avanza. Se recorren las cuatro pantallas y se hace clic donde
// haría clic el tripulante.
// REQUIERE jsdom (no está en el repo, es solo para probar):
//   cd rendio-backend && npm install --no-save jsdom
//
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';

const APP='../rendio-turnos/';
const html = readFileSync(APP+'index.html','utf8');
const dom = new JSDOM(html, { runScripts:'outside-only', pretendToBeVisual:true, url:'http://localhost/' });
const { window } = dom;
global.window = window; global.document = window.document;
window.RENDIO_CONFIG = { OTP_LENGTH: 8 };
window.toast = () => {};
// Api de mentiras: acá se prueba el PINTADO, no la red (la red ya la probaron
// _e2e-0075-registro y _e2e-0075-front contra dev de verdad).
const CAT = { airlines:[{id:'a1',name:'Avianca'},{id:'a2',name:'JetSMART'},{id:'a3',name:'Wingo'},{id:'a4',name:'LATAM'}],
  residences:[{id:'r1',name:'Olivar Apartamentos',sector:'Norte'},{id:'r2',name:'Solare',sector:'Llanogrande'},{id:'r3',name:'Cámbulo',sector:'Norte'}] };
window.Api = {
  getSession: async()=>null, signOut: async()=>{}, getCurrentProfile: async()=>({id:'p1',full_name:'Ana Lucía Restrepo Vélez',role:'auxiliar'}),
  signUpAuxiliar: async()=>({ session:{access_token:'x'}, user:{} }), verifySignupOtp: async(e,t)=>{ if(t!=='12345678') throw new Error('Token has expired or is invalid'); return {}; },
  resendSignupOtp: async()=>true, signupCatalogs: async()=>CAT, registerAuxiliar: async()=>({ok:true}),
};
const src = readFileSync(APP+'aux-registro.js','utf8');
window.eval(src);

let ok=0,bad=0; const t=(n,c,d='')=>{ if(c){ok++;console.log('  ✓ '+n)} else {bad++;console.log('  ✗ '+n+(d?' → '+d:''))} };
const R = window.AuxRegistro;
const ui = () => window.document.getElementById('auxiliar-ui');
const txt = () => ui().textContent.replace(/\s+/g,' ');
const click = (sel) => { const e = ui().querySelector(sel); if(!e) throw new Error('no existe: '+sel); e.click(); };
const set = (key,val) => { const i = ui().querySelector(`[data-rg-field="${key}"]`); if(!i) throw new Error('no existe campo '+key);
  i.value = val; i.dispatchEvent(new window.Event('input',{bubbles:true}));
  i.dispatchEvent(new window.FocusEvent('focusout',{bubbles:true})); };
const wait = () => new Promise(r=>setTimeout(r,30));

console.log('\n── paso 1 · datos ──');
R.start();
t('pinta la pantalla de crear cuenta', /Crea tu cuenta/.test(txt()));
t('el botón arranca deshabilitado', ui().querySelector('[data-rg="crear"]').disabled);
set('name','Ana Restrepo');
t('nombre de 2 palabras → error en rojo', /Faltan apellidos/.test(txt()), txt().slice(0,120));
t('y el campo queda marcado', !!ui().querySelector('[data-rg-field="name"].bad'));
set('name','Ana Lucía Restrepo Vélez');
t('con nombre y dos apellidos, el error se va', !/Faltan apellidos/.test(txt()));
set('email','ana@rendio.demo');
t('rechaza el dominio de prueba', /correo personal de verdad/.test(txt()));
set('email','ana.restrepo@gmail.com');
set('phone','300');
t('teléfono corto → error', /incompleto/.test(txt()));
set('phone','3105557788');
set('pass','1234');
t('contraseña corta → error', /Mínimo 8/.test(txt()));
set('pass','MiClave2026');
t('con todo bien, el botón se habilita', !ui().querySelector('[data-rg="crear"]').disabled);
click('[data-rg="ver-pass"]');
t('el ojo muestra la contraseña', ui().querySelector('[data-rg-field="pass"]').type==='text');

console.log('\n── del paso 1 al perfil, sin código de por medio ──');
// La verificación por correo se sacó el 25-ago (correo-registro/
// PENDIENTE-verificacion-correo.js). signUp devuelve sesión y se sigue derecho.
click('[data-rg="crear"]'); await wait(); await wait();
t('pasa derecho al perfil', /Ya casi/.test(txt()), txt().slice(0,90));
t('no pinta ninguna casilla de código', ui().querySelectorAll('.rg-otp-box').length===0);
t('el registro es de 2 pasos', /2\/2/.test(txt()), txt().slice(0,60));

console.log('\n── paso 2 · aerolínea, conjunto y unidades ──');
await wait();
t('lista las 4 aerolíneas', ui().querySelectorAll('[data-rg="airline"]').length===4);
t('lista los conjuntos', ui().querySelectorAll('[data-rg="res-pick"]').length===3);
t('el botón sigue deshabilitado sin elegir', ui().querySelector('.ax-cta-bar .ax-btn-primary').disabled);
click('[data-rg="airline"][data-id="a3"]');
t('marca la aerolínea elegida', !!ui().querySelector('.ax-opt.sel'));
// buscador
const q = ui().querySelector('[data-rg-q="1"]'); q.value='solare'; q.dispatchEvent(new window.Event('input',{bubbles:true}));
t('el buscador filtra', ui().querySelectorAll('[data-rg="res-pick"]').length===1, String(ui().querySelectorAll('[data-rg="res-pick"]').length));
click('[data-rg="res-pick"][data-id="r2"]');
t('muestra el conjunto elegido', /Solare/.test(txt()));
t('y pide el apartamento', !!ui().querySelector('[data-rg-field="unit"]'));
set('unit','Torre 1 · 501');
t('ahora sí se puede crear la cuenta', !ui().querySelector('.ax-cta-bar .ax-btn-primary').disabled);
t('ofrece la segunda unidad', /segunda unidad/i.test(txt()));
click('[data-rg="toggle"][data-key="hasSecond"]');
t('al encenderla, se bloquea hasta completarla', ui().querySelector('.ax-cta-bar .ax-btn-primary').disabled);
click('[data-rg="res-pick"][data-n="2"][data-id="r1"]');
set('unit2','Casa 8');
t('con la segunda completa, se desbloquea', !ui().querySelector('.ax-cta-bar .ax-btn-primary').disabled);
t('se ven las dos unidades', /Solare/.test(txt()) && /Olivar/.test(txt()));
// camino manual
click('[data-rg="toggle"][data-key="hasSecond"]');   // apagar la segunda
t('apagar la segunda la limpia', !window.AuxRegistro.state.f.resId2);

console.log('\n── paso 3 · bienvenida ──');
click('.ax-cta-bar .ax-btn-primary'); await wait(); await wait();
t('llega a la bienvenida', /Bienvenido/.test(txt()), txt().slice(0,90));
t('saluda por el primer nombre', /Bienvenido, Ana/.test(txt()));
t('explica lo de la hora de llegada', /hora de llegada|estar en el aeropuerto/i.test(txt()));

console.log('\n── el botón de sol/luna ──');
// AuxPresentacion no está cargado en esta prueba: el botón no debe aparecer ni
// reventar. Se carga y se vuelve a pintar para probarlo de verdad.
t('sin el módulo de tema, no pinta el botón (y no revienta)', !ui().querySelector('[data-rg="tema"]'));
window.eval(readFileSync(APP+'aux-presentacion.js','utf8'));
R.start();
t('con el módulo, aparece el botón', !!ui().querySelector('[data-rg="tema"]'));
const modo = () => ui().getAttribute('data-ax-night');
const icono = () => ui().querySelector('[data-rg="tema"] use')?.getAttribute('href');
const antes = modo();
click('[data-rg="tema"]');
t('al tocarlo cambia el modo', modo() !== antes, antes+' → '+modo());
t('y el icono pasa a mostrar el camino contrario',
  (modo()==='on' && icono()==='#i-sun') || (modo()==='off' && icono()==='#i-moon'), modo()+' / '+icono());
t('la preferencia queda guardada', ['light','night'].includes(window.localStorage.getItem('rendio.aux.night')),
  String(window.localStorage.getItem('rendio.aux.night')));
click('[data-rg="tema"]');
t('vuelve al otro modo', modo()===antes, modo());
t('sigue estando en el paso 1', /Crea tu cuenta/.test(txt()));

console.log('\n── si alguien enciende «Confirm email» sin devolver el paso ──');
// signUp deja el usuario creado pero SIN sesión: desde el navegador no hay
// forma de seguir. No puede quedarse el botón girando en silencio.
window.Api.signUpAuxiliar = async () => ({ session: null, user: {} });
window.localStorage.removeItem('rendio.aux.night');
R.start();
set('name','Ana Lucía Restrepo Vélez'); set('email','ana.restrepo@gmail.com');
set('phone','3105557788'); set('pass','MiClave2026');
click('[data-rg="crear"]'); await wait(); await wait();
t('lo dice en vez de dejarlo trancado', /falta un paso de confirmación/.test(txt()), txt().slice(0,220));
t('y se queda en la pantalla de datos', /Crea tu cuenta/.test(txt()));
t('el botón vuelve a estar activo para reintentar', !ui().querySelector('[data-rg="crear"]').disabled);
window.Api.signUpAuxiliar = async () => ({ session: { access_token: 'x' }, user: {} });

console.log('\n── retomar un registro a medias ──');
await R.resume({ email:'otra@gmail.com', user_metadata:{ full_name:'Sofía Marcela Ossa Bedoya', phone:'3123334455' } });
await wait();
t('retoma directo en el paso del perfil', /Ya casi/.test(txt()));
t('conserva el nombre que ya había dado', window.AuxRegistro.state.f.name==='Sofía Marcela Ossa Bedoya');

console.log(`\n${ok}/${ok+bad} pasaron${bad?' · '+bad+' FALLARON':''}`);
process.exit(bad?1:0);
