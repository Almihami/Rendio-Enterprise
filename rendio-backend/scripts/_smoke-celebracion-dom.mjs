// La celebración al confirmar el traslado (15-sep-2026, punto 6 de la profa):
//   · aux-celebracion.js existe y arma la escena (avión, estela, pista, sello)
//   · en la salida la casa va a la izquierda y el avión-destino a la derecha;
//     en la llegada al revés
//   · tras confirmar de verdad (Api.createReservation falso) la pantalla
//     «¡Traslado confirmado!» trae la escena; el privado dice «Solicitud
//     enviada», va en el panel Select y NO promete aviso
//   · prime()/afterRender() no explotan sin AudioContext; con uno falso suenan
//     dos notas y no se repiten para el mismo traslado
//   · index.html, sw.js y el CSS quedaron registrados
// Lo de siempre: jsdom NO hace layout ni anima. Que el avión de verdad siga la
// curva y que la estela no se despegue de él se mira en el teléfono.
// REQUIERE jsdom (no está en el repo, es solo para probar):
//   cd rendio-backend && node scripts/_smoke-celebracion-dom.mjs
//
// REDISEÑO (P5, 27-sep-2026): mientras exista el interruptor corre en los DOS
// modos. RX=1 confirma con el deslizador (.rx-slide, toque sin arrastre = el
// clic de respaldo del diseño), espía que AuxCelebracion.prime() se llame
// DENTRO del clic y mira la escena en «booked» (.rx-booked .axc).
//   RX=0 node scripts/_smoke-celebracion-dom.mjs
//   RX=1 node scripts/_smoke-celebracion-dom.mjs
//
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
const APP='../rendio-turnos/';
const dom=new JSDOM(readFileSync(APP+'index.html','utf8'),{runScripts:'outside-only',pretendToBeVisual:true,url:'http://localhost/'});
const {window}=dom; global.window=window; global.document=window.document;
window.RENDIO_CONFIG={OTP_LENGTH:8}; window.toast=()=>{}; window.L=undefined;
window.escapeHtml=(s)=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
let ok=0,bad=0; const t=(n,c,d='')=>{if(c){ok++;console.log('  ✓ '+n)}else{bad++;console.log('  ✗ '+n+(d?' → '+d:''))}};

const RES=[{id:'r1',name:'Olivar Apartamentos',sector:'Norte',latitude:6.15,longitude:-75.37}];
const UNA={residenceId:'r1',residence:RES[0],unit:'Torre 3 · 302',residenceId2:null,residence2:null,unit2:'',homeAddress:'',homeLat:null,homeLng:null};
const creadas=[];
window.Api={ listMyReservations:async()=>[], listResidences:async()=>RES,
  getMyAuxiliarPlace:async()=>UNA, saveMyResidence:async()=>true,
  createReservation:async(f)=>{creadas.push(JSON.parse(JSON.stringify(f)));return 'r'+creadas.length;},
  getSettings:async()=>window.state.settings, privateBusyAt:async()=>false };
const SIN_PRIVADO={aux_min_lead_hours:6,aux_wait_minutes:5};
const CON_PRIVADO={...SIN_PRIVADO,aux_private_enabled:true,aux_private_vehicle_id:'v1',aux_private_price_cop:150000};
window.state={settings:{...SIN_PRIVADO}}; global.state=window.state;
const RX=process.env.RX==='1';
console.log('Modo: '+(RX?'RX=1 (rediseño encendido)':'RX=0 (el pedido de siempre)'));
window.localStorage.setItem('rendio.aux.rx',RX?'1':'0');
// Los mismos archivos en los dos modos (la app real los carga todos); solo cambia la bandera.
const PANTALLAS=['aux-rx-inicio.js','aux-rx-viajes.js','aux-rx-avisos.js','aux-rx-viaje.js','aux-rx-pedir.js','aux-rx-perfil.js','aux-rx-pagos.js','aux-rx-puntos.js','aux-rx-coord.js','aux-rx-vuelo.js'];
for(const f of ['aux-rx-ui.js','aux-shell.js','api-aux.js','aux-residencias.js','aux-privado.js','aux-celebracion.js','aux-presentacion.js',...PANTALLAS,'auxiliar.js']) window.eval(readFileSync(APP+f,'utf8'));

const ui=()=>window.document.getElementById('auxiliar-ui');
// Con el rediseño el pedido y el «traslado pedido» viven en su capa; la pestaña de atrás no cuenta.
const scope=()=>(RX&&(ui().querySelector('[data-scr="book"]:not(.out)')||ui().querySelector('[data-scr="booked"]:not(.out)')))||ui();
const txt=()=>scope().textContent.replace(/\s+/g,' ');
const click=(s)=>{const e=scope().querySelector(s)||ui().querySelector(s); if(!e) throw new Error('no existe: '+s); e.click();};
const T_REVISAR=RX?/Revisa tu traslado/:/Revisa y confirma/;
async function tipo(tp){ click(`[data-ax="type"][data-type="${tp}"]`); if(RX) await wait(320); else click('[data-ax="next"]'); }
// Espía de prime(): ¿se llamó DENTRO del clic de confirmar (sincrónico)?
let enGesto=false; const primes=[];
// Confirmar: con el rediseño, el deslizador (toque sin arrastre + 380 ms); sin él, el botón.
async function confirmar(){
  const sel=RX?'.rx-slide-k':'[data-ax="next"]';
  enGesto=true; try{ click(sel); } finally { enGesto=false; }
  await wait(RX?460:120);
}
// La pantalla de «confirmado»: título, texto y botón según el modo.
const H1=()=>scope().querySelector(RX?'.rx-booked h1.rx-c-h':'h1.ax-big');
const LEAD=()=>scope().querySelector(RX?'.rx-booked .rx-c-p':'.ax-lead');
const set=(k,v)=>{const i=ui().querySelector(`[data-field="${k}"]`); if(!i) throw new Error('no existe campo '+k); i.value=v; i.dispatchEvent(new window.Event('input',{bubbles:true}));};
const wait=(ms=40)=>new Promise(r=>setTimeout(r,ms));
const A=()=>window.Auxiliar.state;
async function nuevo(){ A().view='home'; A().source='live'; window.Auxiliar.rerender(); await wait();
  if(RX && !ui().querySelector('[data-ax="new"]')) window.Auxiliar.newTrip(); else click('[data-ax="new"]');
  await wait(60); }
const parse=(html)=>{const d=window.document.createElement('div'); d.innerHTML=html; return d;};

console.log('\n── el módulo ──');
const C=window.AuxCelebracion;
{ const real=C.prime; C.prime=function(){ primes.push(enGesto); return real.apply(this,arguments); }; }
t('window.AuxCelebracion existe con sceneHTML/afterRender/prime', !!C && typeof C.sceneHTML==='function' && typeof C.afterRender==='function' && typeof C.prime==='function');
t('jsdom no trae AudioContext (la prueba de abajo vale)', typeof window.AudioContext==='undefined' && typeof window.matchMedia==='undefined');

console.log('\n── la escena de la salida ──');
const sal=parse(C.sceneHTML({type:'sal'}));
const svg=sal.querySelector('svg.axc-scene');
t('devuelve un svg.axc-scene con viewBox 0 0 280 150', !!svg && svg.getAttribute('viewBox')==='0 0 280 150');
t('con avión viajero, estela, pista y sello', !!svg.querySelector('.axc-plane') && !!svg.querySelector('.axc-route') && !!svg.querySelector('.axc-track') && !!svg.querySelector('.axc-ok'));
t('la estela y la pista son la MISMA curva', svg.querySelector('.axc-route').getAttribute('d')==='M44 104C110 100 160 80 236 46' && svg.querySelector('.axc-track').getAttribute('d')===svg.querySelector('.axc-route').getAttribute('d'));
t('la casa a la izquierda y el avión-destino a la derecha', svg.querySelector('.axc-from[data-side="left"]')?.dataset.what==='home' && svg.querySelector('.axc-to[data-side="right"]')?.dataset.what==='plane');
t('glifos sin texto (ningún <text>)', !svg.querySelector('text'));
t('el sello lleva un chulo (path) sobre un círculo', !!svg.querySelector('.axc-ok circle') && !!svg.querySelector('.axc-ok .axc-tick'));
t('compartido: el contenedor NO lleva la piel vip', sal.querySelector('.axc') && !sal.querySelector('.axc').classList.contains('vip'));

console.log('\n── la escena de la llegada ──');
const lle=parse(C.sceneHTML({type:'lle'}));
t('el avión-destino queda a la izquierda y la casa a la derecha', lle.querySelector('.axc-from[data-side="left"]')?.dataset.what==='plane' && lle.querySelector('.axc-to[data-side="right"]')?.dataset.what==='home');
t('la curva no cambia: el viajero siempre va de izquierda a derecha', lle.querySelector('.axc-route').getAttribute('d')==='M44 104C110 100 160 80 236 46');
t('sceneHTML(privado) envuelve en .axc.vip', parse(C.sceneHTML({type:'sal',level:'private'})).querySelector('.axc.vip')!==null);
t('sceneHTML sin traslado no explota', (()=>{try{return !!parse(C.sceneHTML(null)).querySelector('svg.axc-scene');}catch(e){return false;}})());

console.log('\n── sonido: sin AudioContext no pasa nada ──');
t('prime() no lanza sin AudioContext', (()=>{try{C.prime();return true;}catch(e){return false;}})());
t('afterRender() no lanza sin AudioContext ni matchMedia', (()=>{try{C.afterRender({id:'x0',type:'sal'});return true;}catch(e){return false;}})());
t('afterRender(null) tampoco', (()=>{try{C.afterRender(null);return true;}catch(e){return false;}})());

console.log('\n── sonido: con un AudioContext falso suenan dos notas, una sola vez por traslado ──');
const started=[]; let resumed=0;
class FakeAC {
  constructor(){ this.state='suspended'; this.currentTime=0; this.destination={}; }
  resume(){ resumed++; this.state='running'; return Promise.resolve(); }
  createGain(){ return { gain:{ setValueAtTime(){}, exponentialRampToValueAtTime(){} }, connect(){} }; }
  createOscillator(){ const o={ type:'', frequency:{value:0}, connect(){}, start(){ started.push(o.frequency.value); }, stop(){} }; return o; }
}
window.AudioContext=FakeAC;
// El reloj de jsdom es real: se acorta el setTimeout para no esperar 1,5 s.
const realTimeout=window.setTimeout; let programados=0;
window.setTimeout=(fn,ms,...r)=>{ if(ms===1500){ programados++; return realTimeout(fn,5,...r); } return realTimeout(fn,ms,...r); };
C.prime();
t('prime() crea el contexto y lo reanuda (iOS lo pide dentro del gesto)', resumed===1);
// afterRender busca la escena en el DOM antes de sonar: se planta una.
A().view='home'; window.Auxiliar.rerender();
ui().insertAdjacentHTML('beforeend', C.sceneHTML({type:'sal'}));
C.afterRender({id:'t-son-1',type:'sal'}); await wait(30);
t('suenan dos notas de seno (659,25 → 880 Hz)', started.length===2 && started[0]===659.25 && started[1]===880, JSON.stringify(started));
C.afterRender({id:'t-son-1',type:'sal'}); await wait(30);
t('repintar el mismo traslado NO vuelve a sonar', started.length===2 && programados===1);
C.afterRender({id:'t-son-2',type:'sal'}); await wait(30);
t('otro traslado sí suena', started.length===4);
ui().querySelector('.axc')?.remove();
C.afterRender({id:'t-son-3',type:'sal'}); await wait(30);
t('si ya se fue de la pantalla (sin escena en el DOM) no suena', started.length===4);
window.matchMedia=()=>({matches:true});
const antes=programados;
C.afterRender({id:'t-son-4',type:'sal'}); await wait(30);
t('con prefers-reduced-motion no se programa nada', started.length===4 && programados===antes);
delete window.matchMedia;
window.setTimeout=realTimeout;

console.log('\n── flujo completo: confirmar un traslado compartido ──');
await window.Auxiliar.init({id:'p1',full_name:'Ana Lucía Restrepo Vélez',role:'auxiliar'}); await wait(80);
await nuevo();
await tipo('sal'); await wait();
set('date','2026-12-20'); set('time','05:10'); click('[data-ax="next"]'); await wait();
click('[data-ax="next"]'); await wait();   // el paso del nivel (primicia desde el 17-sep)
t('se llega a revisar (4/4, una unidad)', T_REVISAR.test(txt()) && /4\/4/.test(txt()), txt().slice(0,80));
creadas.length=0; started.length=0; primes.length=0;
if (RX) t('el último paso confirma con el deslizador (.rx-slide) y no con un botón', !!scope().querySelector('.ax-cta-bar .rx-slide .rx-slide-k') && !scope().querySelector('[data-ax="next"]'));
await confirmar();
t('prime() se llamó UNA vez y DENTRO del clic (sincrónico)', primes.length===1 && primes[0]===true, JSON.stringify(primes));
t('se creó la reserva y la vista es confirm', creadas.length===1 && A().view==='confirm');
t('la pantalla trae la escena del avión y ya no el círculo con chulo', !!scope().querySelector('.axc-scene') && !scope().querySelector(RX?'.rx-check':'.ax-success'));
if (RX) t('la escena va en la pantalla completa «booked» (.rx-booked .axc)', !!ui().querySelector('.rx-full[data-scr="booked"] .rx-booked .axc'));
t(RX?'título «¡Traslado pedido!» con entrada animada':'título «¡Traslado confirmado!» con entrada animada', H1()?.textContent===(RX?'¡Traslado pedido!':'¡Traslado confirmado!') && H1().classList.contains('axc-in'), H1()?.textContent);
t('el lead NO promete aviso ni notificación', !/avis|notific/i.test(LEAD().textContent));
t('compartido: sin piel vip, casa a la izquierda', !scope().querySelector('.axc.vip') && scope().querySelector('.axc-from')?.dataset.what==='home');
if (RX) t('en lugar de la línea de tiempo, el pase del viaje (si Inicio lo da)', !(window.AuxRxInicio && typeof window.AuxRxInicio.passHTML==='function') || !!scope().querySelector('.rx-booked-pass'));
else t('la línea de tiempo se conserva', !!ui().querySelector('.ax-timeline') && /Traslado solicitado/.test(txt()));
t(RX?'el botón «Listo» (data-ax="home")':'el botón «Ver mis viajes» sigue', !!scope().querySelector('[data-ax="home"]'));
t('el clic de confirmar desbloqueó el audio (prime dentro del gesto)', resumed>=1);

console.log('\n── flujo completo: pedir un privado ──');
window.state.settings={...CON_PRIVADO};
await nuevo();
await tipo('sal'); await wait();
set('date','2026-12-20'); set('time','05:10'); click('[data-ax="next"]'); await wait(60);
t('se cae en el nivel', window.Auxiliar.stepKind()==='nivel');
click('[data-ax="lvl"][data-v="private"]'); await wait();
t('quedó el privado elegido', A().form.level==='private');
click('[data-ax="next"]'); await wait();
t('en revisar (4/4)', /4\/4/.test(txt()));
creadas.length=0; primes.length=0;
await confirmar();
t('prime() dentro del clic también en el privado', primes.length===1 && primes[0]===true);
t('se creó la reserva privada', creadas.length===1 && creadas[0].level==='private' && A().view==='confirm');
t('la escena va en el panel .axc.vip', !!scope().querySelector('.axc.vip .axc-scene'));
t('título «Solicitud enviada» (no «confirmado»: lo aprueba coordinación)', H1()?.textContent==='Solicitud enviada' && !/confirmado/i.test(H1().textContent));
t('el lead es honesto: la respuesta vive en el traslado y NO promete aviso', /la respuesta la verás en tu traslado/.test(LEAD().textContent) && !/avis|notific/i.test(LEAD().textContent));
if (!RX) t('la línea de tiempo también se conserva en el privado', !!ui().querySelector('.ax-timeline'));
window.state.settings={...SIN_PRIVADO};

console.log('\n── llegada: la escena se voltea ──');
await nuevo();
await tipo('lle'); await wait();
set('flightNum','AV-9412'); set('date','2026-12-20'); set('time','21:10'); click('[data-ax="next"]'); await wait();
click('[data-ax="next"]'); await wait();   // el paso del nivel (primicia desde el 17-sep)

creadas.length=0;
await confirmar();
t('confirmada una llegada: avión a la izquierda, casa a la derecha', A().view==='confirm' && scope().querySelector('.axc-from')?.dataset.what==='plane' && scope().querySelector('.axc-to')?.dataset.what==='home');

console.log('\n── registro: index.html, sw.js y el CSS ──');
const idx=readFileSync(APP+'index.html','utf8'), sw=readFileSync(APP+'sw.js','utf8'), css=readFileSync(APP+'rc-auxiliar.css','utf8');
t('index.html carga aux-celebracion.js antes de auxiliar.js', idx.indexOf('<script src="aux-celebracion.js">')>0 && idx.indexOf('<script src="aux-celebracion.js">')<idx.indexOf('<script src="auxiliar.js">'));
t('y justo después de aux-privado.js', idx.indexOf('<script src="aux-privado.js">')<idx.indexOf('<script src="aux-celebracion.js">'));
t('sw.js lo lista en APP_SHELL', /'\/aux-celebracion\.js',/.test(sw));
// El número exacto no se clava: cada rama que se fusiona lo sube otra vez y la
// prueba se caía por eso. Lo que importa es que subió de la v154 que había
// cuando el módulo nació, para que el service worker sirva el archivo nuevo.
const swv = (sw.match(/CACHE_VERSION = 'rendio-turnos-v(\d+)'/) || [])[1];
t('el CACHE_VERSION subió (>= v155)', Number(swv) >= 155, 'es v' + swv);
t('el CSS de la escena está bajo el ancla', css.indexOf('/* ANCLA-CELEBRACION */')>0 && css.indexOf('.axc-scene')>css.indexOf('/* ANCLA-CELEBRACION */'));
t('el largo de la curva (201.8) está en la dasharray y en el keyframe', /stroke-dasharray: 201\.8;/.test(css) && /from \{ stroke-dashoffset: 201\.8; \}/.test(css));
t('avión pegado a la curva con offset-path (misma curva del módulo)', /offset-path: path\("M44 104C110 100 160 80 236 46"\)/.test(css));
t('estela y avión con la MISMA duración/espera/curva de tiempo', (css.match(/1\.35s \.25s cubic-bezier\(\.4,\.1,\.3,1\) both/g)||[]).length>=3);
t('prefers-reduced-motion apaga la escena', /prefers-reduced-motion: reduce\) \{\s*#auxiliar-ui \.axc \*/.test(css));
t('la piel vip usa la paleta fija del Select', /\.axc\.vip \{[^}]*#221D18/.test(css) && /\.axc\.vip[^}]*#C7A971|--axc-brass: #C7A971/.test(css));
// Solo las reglas DE LA ESCENA (.axc). Antes se miraba desde el ancla hasta el
// final del archivo, y cuando otro módulo agregó sus reglas debajo (Tripulantes,
// 0081) sus colores fijos tumbaban esta prueba sin que la escena cambiara.
t('fuera del bloque vip, la escena va en tokens --a-*', (()=>{ const blk=css.slice(css.indexOf('/* ANCLA-CELEBRACION */')); const reglas=(blk.match(/[^{}]+\{[^{}]*\}/g)||[]).filter(r=>{ const sel=r.slice(0,r.indexOf('{')); return /\.axc/.test(sel) && !/\.axc\.vip/.test(sel); }); const hex=(reglas.join('\n').match(/#[0-9A-Fa-f]{3,6}\b/g)||[]).filter(h=>h!=='#fff'&&h!=='#auxiliar'); return reglas.length>5 && hex.length===0; })());

console.log(`\n${ok}/${ok+bad} pasaron${bad?' · '+bad+' FALLARON':''}`);
console.log('NO cubierto: la animación en sí (jsdom no anima ni hace layout), el sonido real y la vibración — se mira y se oye en el teléfono, con y sin «reducir movimiento».');
process.exit(bad?1:0);
