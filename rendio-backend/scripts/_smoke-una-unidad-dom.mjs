// Regresión del caso NORMAL: el tripulante con UNA sola unidad. Es el de los
// 102 perfiles que ya existen, y el que el selector de dos unidades no puede
// haber cambiado.
// 15-sep-2026: con UNA unidad el paso «Dónde te recogemos» YA NO EXISTE — el
// punto del registro se pone solo y del vuelo se pasa derecho al resumen. Lo
// que antes se comprobaba en el paso 3 (punto puesto, unidad arrastrada, «lo
// pusimos nosotros») se comprueba ahora en el resumen y en el «Cambiar».
// REQUIERE jsdom (no está en el repo, es solo para probar):
//   cd rendio-backend && npm install --no-save jsdom
//
// REDISEÑO (P5, 27-sep-2026): mientras exista el interruptor corre en los DOS
// modos. RX=0 (o sin variable) = el pedido de siempre; RX=1 = el pedido nuevo
// (.rx-book: .rx-review, .rx-list, deslizador). Mismo contrato res-*.
//   RX=0 node scripts/_smoke-una-unidad-dom.mjs
//   RX=1 node scripts/_smoke-una-unidad-dom.mjs
//
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
const APP='../rendio-turnos/';
const dom=new JSDOM(readFileSync(APP+'index.html','utf8'),{runScripts:'outside-only',pretendToBeVisual:true,url:'http://localhost/'});
const {window}=dom; global.window=window; global.document=window.document;
window.RENDIO_CONFIG={OTP_LENGTH:8}; window.toast=()=>{}; window.L=undefined;
// escapeHtml es global de admin-disponibilidad.js (no se carga aquí).
window.escapeHtml=(s)=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
let ok=0,bad=0; const t=(n,c,d='')=>{if(c){ok++;console.log('  ✓ '+n)}else{bad++;console.log('  ✗ '+n+(d?' → '+d:''))}};
const RES=[{id:'r1',name:'Olivar Apartamentos',sector:'Norte',latitude:6.15,longitude:-75.37},
           {id:'r2',name:'Solare',sector:'Llanogrande',latitude:6.11,longitude:-75.42}];
const creadas=[];
window.Api={ listMyReservations:async()=>[], listResidences:async()=>RES,
  // Una sola unidad: sin residenceId2, como los perfiles de hoy.
  getMyAuxiliarPlace:async()=>({residenceId:'r1',residence:RES[0],unit:'Torre 3 · 302',
    residenceId2:null,residence2:null,unit2:'',homeAddress:'',homeLat:null,homeLng:null}),
  saveMyResidence:async()=>true, createReservation:async(f)=>{creadas.push(JSON.parse(JSON.stringify(f)));return 'r'+creadas.length;},
  getSettings:async()=>({}) };
window.state={settings:{aux_min_lead_hours:6,aux_wait_minutes:5}}; global.state=window.state;
const RX=process.env.RX==='1';
console.log('Modo: '+(RX?'RX=1 (rediseño encendido)':'RX=0 (el pedido de siempre)'));
window.localStorage.setItem('rendio.aux.rx',RX?'1':'0');
// Los mismos archivos en los dos modos (la app real los carga todos); solo cambia la bandera.
const PANTALLAS=['aux-rx-inicio.js','aux-rx-viajes.js','aux-rx-avisos.js','aux-rx-viaje.js','aux-rx-pedir.js','aux-rx-perfil.js','aux-rx-pagos.js','aux-rx-puntos.js','aux-rx-coord.js','aux-rx-vuelo.js'];
for(const f of ['aux-rx-ui.js','aux-shell.js','api-aux.js','aux-residencias.js','aux-privado.js','aux-celebracion.js','aux-presentacion.js',...PANTALLAS,'auxiliar.js']) window.eval(readFileSync(APP+f,'utf8'));
const ui=()=>window.document.getElementById('auxiliar-ui');
// Con el rediseño el pedido vive en su capa (data-scr="book"); la pestaña de atrás no cuenta.
const scope=()=>(RX&&ui().querySelector('[data-scr="book"]:not(.out)'))||ui();
const txt=()=>scope().textContent.replace(/\s+/g,' ');
const T_REVISAR=RX?/Revisa tu traslado/:/Revisa y confirma/;
// Paso 1: con el rediseño avanza solo a los 260 ms; sin él, «Continuar».
async function tipo(tp){ click(`[data-ax="type"][data-type="${tp}"]`); if(RX) await wait(320); else click('[data-ax="next"]'); }
// El confirmar del último paso: el deslizador (toque sin arrastre + 380 ms) o el botón.
const confirmBloqueado=()=>RX?ui().querySelector('[data-scr="book"] .rx-slide').classList.contains('off'):ui().querySelector('[data-ax="next"]').hasAttribute('disabled');
async function confirmar(){ if(RX){ click('[data-scr="book"] .rx-slide-k'); await wait(460); } else { click('[data-ax="next"]'); await wait(120); } }
// La fila del punto en el resumen.
const filaPunto=()=>RX?(ui().querySelector('[data-scr="book"] .rx-rv-row[data-ax="donde-cambiar"]')?.textContent||''):txt();
const click=(s)=>{const e=ui().querySelector(s); if(!e) throw new Error('no existe: '+s); e.click();};
const set=(k,v)=>{const i=ui().querySelector(`[data-field="${k}"]`); i.value=v; i.dispatchEvent(new window.Event('input',{bubbles:true}));};
const wait=(ms=40)=>new Promise(r=>setTimeout(r,ms));
const A=()=>window.Auxiliar.state;

await window.Auxiliar.init({id:'p1',full_name:'Julián Andrés López Mesa',role:'auxiliar'}); await wait(80);
window.Auxiliar.state.view='form'; window.Auxiliar.state.step=1; window.Auxiliar.state.form={isReserva:true};
window.AuxResidencias.newTrip(); window.AuxResidencias.load(); await wait(80);
window.Auxiliar.rerender();
await tipo('sal');
// En una SALIDA no hay campo de vuelo desde el 25-ago (solo interesa el de
// llegada). Pedirlo aquí es lo que tenía esta prueba rota.
set('date','2026-12-20'); set('time','05:10');
click('[data-ax="next"]'); await wait();
console.log('\n── con UNA unidad no hay paso del punto ──');
// El paso del PUNTO es el que desaparece; el del nivel está siempre (desde el
// 17-sep, apagado como primicia cuando el privado no se puede pedir).
t('tras el vuelo NO se pide el punto: se cae en el nivel', window.Auxiliar.stepKind()==='nivel' && !window.Auxiliar.kinds().includes('donde'), txt().slice(0,160));
t('son 4 pasos: tipo, vuelo, nivel, revisar', JSON.stringify(window.Auxiliar.kinds())==='["tipo","vuelo","nivel","revisar"]' && /3\/4/.test(txt()),
  JSON.stringify(window.Auxiliar.kinds()));
click('[data-ax="next"]'); await wait();   // el paso del nivel (primicia desde el 17-sep)
t('y de ahí a revisar', T_REVISAR.test(txt()), txt().slice(0,160));
t('NO pregunta de cuál unidad sale', !/De cuál sales/.test(txt()));
t('ni pide la dirección', !/Dónde te recogemos/.test(txt()));
// 7-sep-2026: «si solo tiene una dirección asociada, que se autocomplete».
t('el punto llegó puesto solo', A().form.residenceId==='r1' && A().form.placeAuto===true);
t('y el resumen lo muestra'+(RX?' (fila «Recogida»)':' verificado'), RX ? /Recogida.*Olivar Apartamentos/.test(filaPunto()) : (/Te recogemos enOlivar Apartamentos/.test(txt()) && /UbicaciónVerificada/.test(txt())), filaPunto().slice(0,240));
t('arrastra el apartamento del perfil', A().form.residenceUnit==='Torre 3 · 302');
t('el resumen lleva la unidad', RX ? /Torre 3 · 302/.test(filaPunto()) : /UnidadTorre 3 · 302/.test(txt()), filaPunto().slice(0,240));
t('ofrece «Cambiar» al lado del punto', !!ui().querySelector(RX?'[data-scr="book"] .rx-review .rx-rv-row[data-ax="donde-cambiar"]':'.ax-sum-row [data-ax="donde-cambiar"]'));
t('el botón de confirmar queda habilitado sin tocar nada', !confirmBloqueado());
await confirmar();
t('crea UNA sola reserva (no marcó regreso)', creadas.length===1, 'creadas='+creadas.length);
t('con conjunto y apartamento', creadas[0]?.residenceId==='r1' && creadas[0]?.residenceUnit==='Torre 3 · 302');

console.log('\n── cambiar el punto que se puso solo (desde el resumen) ──');
window.Auxiliar.state.view='form';
window.Auxiliar.state.form={isReserva:true,type:'sal',date:'2026-12-21',time:'06:00'};
window.AuxResidencias.newTrip();
window.Auxiliar.state.step=window.Auxiliar.kinds().indexOf('revisar')+1; window.Auxiliar.rerender(); await wait();
t('arranca en revisar con el punto puesto', T_REVISAR.test(txt()) && A().form.residenceId==='r1');
click('[data-ax="donde-cambiar"]'); await wait();
t('«Cambiar» abre el paso del punto', /Dónde te recogemos/.test(txt()), txt().slice(0,160));
t('el paso del punto ahora EXISTE en la lista', window.Auxiliar.kinds().includes('donde') && window.Auxiliar.stepKind()==='donde',
  JSON.stringify(window.Auxiliar.kinds()));
t('con su atajo «Tu punto» arriba', /Tu punto/.test(txt()) && !!ui().querySelector('[data-ax="res-pick"][data-id="r1"]'));
t('y NO se lo vuelve a poner solo', !A().form.residenceId, 'quedó: '+A().form.residenceId);
t('el botón queda bloqueado hasta elegir', ui().querySelector('[data-ax="next"]').hasAttribute('disabled'));
// Buscador primero (15-sep): sin texto no hay lista; el atajo es lo único.
t('la lista NO sale llena: solo el buscador y el atajo', ui().querySelectorAll('[data-ax="res-pick"]').length===1 && !!ui().querySelector('#axr-q'),
  String(ui().querySelectorAll('[data-ax="res-pick"]').length));
t('con la ayuda de qué escribir', /Escribe el nombre de tu conjunto/.test(txt()));
t('y «Mi punto no está en la lista» visible desde el inicio', !!ui().querySelector('[data-ax="res-manual"]'));
const q=ui().querySelector('#axr-q'); q.value='sol'; q.dispatchEvent(new window.Event('input',{bubbles:true}));
t('al escribir aparece la coincidencia', !!ui().querySelector('.axr-list [data-ax="res-pick"][data-id="r2"]') && !ui().querySelector('.axr-list [data-id="r1"]'));
t('y el buscador no se remontó (sigue con el texto)', ui().querySelector('#axr-q').value==='sol');

console.log('\n── elegir un conjunto que NO es el suyo ──');
click('.axr-list [data-ax="res-pick"][data-id="r2"]'); await wait();
t('queda elegido Solare', A().form.residenceId==='r2' && /Solare/.test(txt()));
t('no le pega el apartamento de su otro conjunto', !A().form.residenceUnit, 'quedó: '+A().form.residenceUnit);
t('sigue en el paso del punto (con «Cambiar» propio)', window.Auxiliar.stepKind()==='donde' && !!ui().querySelector('[data-ax="res-change"]'));
click('[data-ax="next"]'); await wait();
click('[data-ax="next"]'); await wait();   // el paso del nivel (primicia desde el 17-sep)

t('Continuar lleva al resumen con el punto nuevo', T_REVISAR.test(txt()) && (RX ? /Solare/.test(filaPunto()) : /Te recogemos enSolare/.test(txt())), txt().slice(0,240));
t('ahora son 5 pasos (el del punto se quedó)', /5\/5/.test(txt()) && window.Auxiliar.kinds().includes('donde'), txt().slice(0,40));
click('[data-ax="back"]'); await wait();
t('volver atrás cae en el nivel', window.Auxiliar.stepKind()==='nivel');
click('[data-ax="back"]'); await wait();
t('y otra vez, en el paso del punto, no en el vuelo', window.Auxiliar.stepKind()==='donde' && /Dónde te recogemos/.test(txt()) && A().form.residenceId==='r2');

console.log('\n── la fecha llega puesta en mañana ──');
// Se entra por el botón de verdad («Pedir traslado»), que es donde se arma el
// formulario: si se monta el estado a mano, la fecha por defecto no se prueba.
window.Auxiliar.state.view='home'; window.Auxiliar.state.source='live'; window.Auxiliar.rerender(); await wait();
// Con el rediseño el botón es el + de Inicio (.rx-fab, P3); si Inicio aún no está, la misma entrada (newTrip).
if(RX && !ui().querySelector('.rx-fab[data-ax="new"], [data-ax="new"]')){ console.log('  · (Inicio del rediseño sin «+»: se entra por Auxiliar.newTrip)'); window.Auxiliar.newTrip(); }
else click(RX && ui().querySelector('.rx-fab[data-ax="new"]') ? '.rx-fab[data-ax="new"]' : '[data-ax="new"]');
await wait();
const manana=new Date(Date.now()+86400000).toLocaleDateString('en-CA',{timeZone:'America/Bogota'});
t('el pedido nuevo arranca con la fecha de mañana', window.Auxiliar.state.form.date===manana,
  'quedó: '+window.Auxiliar.state.form.date+' · esperada: '+manana);
t('y sin el «Cambiar» del pedido anterior', !window.Auxiliar.state.form.dondeForced && !window.Auxiliar.kinds().includes('donde'));
await tipo('sal'); await wait();
t('el campo de fecha la muestra', ui().querySelector('[data-field="date"]').value===manana);
t('y el atajo «Mañana» está encendido', !!ui().querySelector(RX?'[data-scr="book"] .rx-chips button.on[data-iso="'+manana+'"]':'.ax-daychip.on'));
t('se puede cambiar a hoy con un toque', (()=>{ const hoy=new Date().toLocaleDateString('en-CA',{timeZone:'America/Bogota'});
  click(`[data-ax="date"][data-iso="${hoy}"]`); return window.Auxiliar.state.form.date===hoy; })());

console.log(`\n${ok}/${ok+bad} pasaron${bad?' · '+bad+' FALLARON':''}`);
console.log('NO cubierto: el layout (jsdom no lo hace) — el «Cambiar» al lado del valor y la fila del resumen se miran en el teléfono.');
process.exit(bad?1:0);
