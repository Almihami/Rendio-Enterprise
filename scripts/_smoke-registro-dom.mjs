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
  signUpAuxiliar: async()=>({}), verifySignupOtp: async(e,t)=>{ if(t!=='12345678') throw new Error('Token has expired or is invalid'); return {}; },
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

console.log('\n── paso 2 · el código ──');
click('[data-rg="crear"]'); await wait();
t('pasa a verificar el correo', /Verifica tu correo/.test(txt()), txt().slice(0,90));
t('pinta 8 casillas (OTP_LENGTH)', ui().querySelectorAll('.rg-otp-box').length===8);
t('dice a qué correo lo mandó', /ana\.restrepo@gmail\.com/.test(txt()));
t('el reenvío arranca en cuenta regresiva', /Reenviar en 0:/.test(txt()));
// código equivocado
const boxes = () => ui().querySelectorAll('.rg-otp-box');
const teclear = async (code) => { for(let i=0;i<code.length;i++){ const b=boxes()[i]; b.value=code[i]; b.dispatchEvent(new window.Event('input',{bubbles:true})); } await wait(); };
await teclear('11111111');
t('código equivocado → lo dice y no avanza', /no coincide o ya venció/.test(txt()), txt().slice(0,140));
t('y no dice "ya venció" a secas (Supabase no los distingue)', !/^.*Ese código ya venció\./.test(txt()));
await teclear('12345678'); await wait(); await new Promise(r=>setTimeout(r,700));
t('código bueno → pasa al paso 3', /Ya casi/.test(txt()), txt().slice(0,90));

console.log('\n── paso 3 · aerolínea, conjunto y unidades ──');
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

console.log('\n── paso 4 · bienvenida ──');
click('.ax-cta-bar .ax-btn-primary'); await wait(); await wait();
t('llega a la bienvenida', /Bienvenido/.test(txt()), txt().slice(0,90));
t('saluda por el primer nombre', /Bienvenido, Ana/.test(txt()));
t('explica lo de la hora de llegada', /hora de llegada|estar en el aeropuerto/i.test(txt()));

console.log('\n── retomar un registro a medias ──');
await R.resume({ email:'otra@gmail.com', user_metadata:{ full_name:'Sofía Marcela Ossa Bedoya', phone:'3123334455' } });
await wait();
t('retoma directo en el paso 3', /Ya casi/.test(txt()));
t('conserva el nombre que ya había dado', window.AuxRegistro.state.f.name==='Sofía Marcela Ossa Bedoya');

console.log(`\n${ok}/${ok+bad} pasaron${bad?' · '+bad+' FALLARON':''}`);
process.exit(bad?1:0);
