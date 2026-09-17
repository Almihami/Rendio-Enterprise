// El pedido del tripulante después de las sugerencias de la profa (15-sep-2026):
//   · «Dónde te recogemos» SOLO si hay dos unidades (o hay algo que decidir)
//   · la pernocta y la reserva en firme con el vuelo, las notas en el resumen
//   · el paso 1 dice «Casa → Aeropuerto» con iconos
//   · buscador primero en el catálogo
// Lo de siempre: jsdom NO hace layout. Esto prueba que los pasos existen, que
// el estado va a donde debe y que el payload llega; cómo se VE se mira en el
// teléfono.
// REQUIERE jsdom (no está en el repo, es solo para probar):
//   cd rendio-backend && node scripts/_smoke-flujo-0915-dom.mjs
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
           {id:'r2',name:'Solare',sector:'Llanogrande',latitude:6.11,longitude:-75.42},
           {id:'r3',name:'Cámbulo',sector:'Norte',latitude:6.16,longitude:-75.36}];
const UNA={residenceId:'r1',residence:RES[0],unit:'Torre 3 · 302',residenceId2:null,residence2:null,unit2:'',homeAddress:'',homeLat:null,homeLng:null};
const DOS={...UNA,residenceId2:'r2',residence2:RES[1],unit2:'Casa 8'};
let place=UNA, catalogo=RES;
const creadas=[];
window.Api={ listMyReservations:async()=>[], listResidences:async()=>catalogo,
  getMyAuxiliarPlace:async()=>place, saveMyResidence:async()=>true,
  createReservation:async(f)=>{creadas.push(JSON.parse(JSON.stringify(f)));return 'r'+creadas.length;},
  getSettings:async()=>window.state.settings, privateBusyAt:async()=>false };
const SIN_PRIVADO={aux_min_lead_hours:6,aux_wait_minutes:5};
const CON_PRIVADO={...SIN_PRIVADO,aux_private_enabled:true,aux_private_vehicle_id:'v1',aux_private_price_cop:150000};
window.state={settings:{...SIN_PRIVADO}}; global.state=window.state;
for(const f of ['aux-residencias.js','aux-privado.js','aux-presentacion.js','auxiliar.js']) window.eval(readFileSync(APP+f,'utf8'));

const ui=()=>window.document.getElementById('auxiliar-ui');
const txt=()=>ui().textContent.replace(/\s+/g,' ');
const click=(s)=>{const e=ui().querySelector(s); if(!e) throw new Error('no existe: '+s); e.click();};
const set=(k,v)=>{const i=ui().querySelector(`[data-field="${k}"]`); if(!i) throw new Error('no existe campo '+k); i.value=v; i.dispatchEvent(new window.Event('input',{bubbles:true}));};
const wait=(ms=40)=>new Promise(r=>setTimeout(r,ms));
const A=()=>window.Auxiliar.state;
const kinds=()=>JSON.stringify(window.Auxiliar.kinds());
const next=()=>ui().querySelector('[data-ax="next"]');
// Cambia de perfil (una/dos unidades) o de catálogo y recarga el módulo.
async function recargar(p, cat=RES){ place=p; catalogo=cat; window.AuxResidencias.retry(); await wait(80); }
// Arranca un pedido por el botón de verdad («Pedir traslado»).
async function nuevo(){ A().view='home'; A().source='live'; window.Auxiliar.rerender(); await wait(); click('[data-ax="new"]'); await wait(60); }

await window.Auxiliar.init({id:'p1',full_name:'Ana Lucía Restrepo Vélez',role:'auxiliar'}); await wait(80);

console.log('\n── paso 1 · la ruta con iconos ──');
await nuevo();
const sal=ui().querySelector('.ax-opt.h2a'), lle=ui().querySelector('.ax-opt.a2h');
t('la salida dice Casa → Aeropuerto', sal && sal.querySelector('b span.ax-route') && sal.querySelector('b').textContent.replace(/\s+/g,'')==='CasaAeropuerto', sal?.querySelector('b')?.textContent);
t('con la flecha en svg', !!sal.querySelector('span.ax-route svg.ax-route-arw use[href="#i-arrow"]'));
t('casa y avión como iconos, en ese orden', [...sal.querySelectorAll('span.ax-route use')].map(u=>u.getAttribute('href')).join(',')==='#i-home,#i-arrow,#i-plane');
t('el tile de la salida pinta a dónde va (avión)', !!sal.querySelector('.ax-opt-ic use[href="#i-plane"]'));
t('la llegada dice Aeropuerto → Casa', lle.querySelector('b').textContent.replace(/\s+/g,'')==='AeropuertoCasa');
t('y su tile pinta la casa', !!lle.querySelector('.ax-opt-ic use[href="#i-home"]'));
t('los subtítulos siguen igual', /Voy al aeropuerto a operar un vuelo/.test(txt()) && /Vengo aterrizando de un vuelo/.test(txt()));
t('la pista de la pernocta ya no manda al «paso de dirección»', !/paso de dirección/.test(txt()) && /pernocta/.test(txt()));

console.log('\n── los pasos, por nombre: una unidad ──');
// Desde el 17-sep el paso del nivel está SIEMPRE: si el privado no se puede
// pedir todavía, se muestra apagado como primicia (que es justo lo que ve
// producción hoy). Lo que cambia es si la tarjeta se puede elegir o no.
t('con una unidad: 4 pasos (el nivel siempre está)', kinds()==='["tipo","vuelo","nivel","revisar"]', kinds());
t('y sin privado en Ajustes, es primicia', window.AuxPrivado.primicia()===true);
window.state.settings={...CON_PRIVADO};
t('con privado: los mismos 4 pasos, ya no es primicia', kinds()==='["tipo","vuelo","nivel","revisar"]' && window.AuxPrivado.primicia()===false, kinds());
window.state.settings={...SIN_PRIVADO};

console.log('\n── los pasos, por nombre: dos unidades ──');
await recargar(DOS); await nuevo();
t('con dos unidades: 5 pasos, con «donde» y con el nivel', kinds()==='["tipo","vuelo","donde","nivel","revisar"]', kinds());
window.state.settings={...CON_PRIVADO};
t('con privado, los mismos 5', kinds()==='["tipo","vuelo","donde","nivel","revisar"]', kinds());
window.state.settings={...SIN_PRIVADO};

console.log('\n── con una unidad se salta el paso del punto ──');
await recargar(UNA); await nuevo();
click('[data-ax="type"][data-type="sal"]'); click('[data-ax="next"]'); await wait();
t('paso 2 = datos del vuelo', /Datos del vuelo/.test(txt()) && /2\/4/.test(txt()), txt().slice(0,80));
set('date','2026-12-20'); set('time','05:10');
click('[data-ax="next"]'); await wait();
// Del vuelo se pasa al nivel (3/4) y de ahí a revisar: el paso del PUNTO es el
// que desapareció, que es lo que esta prueba vigila.
t('del vuelo se pasa al nivel, sin el paso del punto (3/4)', window.Auxiliar.stepKind()==='nivel' && /3\/4/.test(txt()) && !kinds().includes('donde'), txt().slice(0,80));
t('y la tarjeta privada va de primicia: apagada y con «Pronto»', !!ui().querySelector('.axp-lvl.vip.primicia') && /Pronto/.test(txt()) && /Todavía no se puede pedir/.test(txt()));
t('tocarla NO la elige: abre la portada', ui().querySelector('.axp-lvl.vip').getAttribute('data-ax')==='lvl-info');
click('[data-ax="next"]'); await wait();
t('y de ahí a revisar (4/4)', /Revisa y confirma/.test(txt()) && /4\/4/.test(txt()), txt().slice(0,80));
t('con el punto del registro puesto', A().form.residenceId==='r1' && /Te recogemos enOlivar Apartamentos/.test(txt()));
t('el nivel quedó en compartido', A().form.level==='shared');
t('y el resumen encabeza con la ruta', !!ui().querySelector('.ax-sum-head span.ax-route'));

console.log('\n── «Cambiar» desde el resumen y el paso que se queda ──');
click('[data-ax="donde-cambiar"]'); await wait();
t('abre el paso del punto', window.Auxiliar.stepKind()==='donde' && /Dónde te recogemos/.test(txt()));
t('ahora son 5 pasos', kinds()==='["tipo","vuelo","donde","nivel","revisar"]' && /3\/5/.test(txt()), kinds());
t('el punto se vació y no se vuelve a poner solo', !A().form.residenceId && A().form.dondeForced===true);
t('Continuar bloqueado hasta elegir', next().hasAttribute('disabled'));
click('[data-ax="back"]'); await wait();
t('atrás cae en el vuelo', window.Auxiliar.stepKind()==='vuelo' && /Datos del vuelo/.test(txt()));
click('[data-ax="next"]'); await wait();
t('adelante vuelve al paso del punto (persiste)', window.Auxiliar.stepKind()==='donde' && /Dónde te recogemos/.test(txt()));
click('[data-ax="res-pick"][data-id="r1"]'); await wait();   // el atajo «Tu punto»
t('elegir el atajo lo deja puesto', A().form.residenceId==='r1' && !next().hasAttribute('disabled'));
click('[data-ax="next"]'); await wait();
t('pasa por el nivel (4/5)', window.Auxiliar.stepKind()==='nivel' && /4\/5/.test(txt()), txt().slice(0,60));
click('[data-ax="next"]'); await wait();
t('y se llega a revisar como 5/5', /Revisa y confirma/.test(txt()) && /5\/5/.test(txt()));

console.log('\n── «Repetir el de siempre» con una unidad ──');
A().trips=[{id:'h1',type:'sal',flight:'',date:'2026-09-01',time:'05:10',address:'Olivar Apartamentos, Norte',lat:6.15,lng:-75.37,
  residenceId:'r1',residenceUnit:'Torre 3 · 302',level:'shared',isPernocta:false,isReserva:true,notes:'Portería norte',status:'done',driver:null,rated:true}];
A().view='home'; window.Auxiliar.rerender(); await wait();
t('el inicio ofrece repetir', !!ui().querySelector('[data-ax="repeat"]'));
click('[data-ax="repeat"]'); await wait();
t('arranca en el paso 2 con el tipo puesto', window.Auxiliar.stepKind()==='vuelo' && A().form.type==='sal');
t('y sin el paso del punto (el conjunto ya viene)', kinds()==='["tipo","vuelo","nivel","revisar"]' && !A().form.dondeForced, kinds());
set('date','2026-12-22'); set('time','04:50'); click('[data-ax="next"]'); await wait();
click('[data-ax="next"]'); await wait();   // el paso del nivel (primicia)
t('llega a revisar con el conjunto y las notas de la vez anterior', /Revisa y confirma/.test(txt()) && A().form.residenceId==='r1' && ui().querySelector('[data-field="notes"]').value==='Portería norte');

console.log('\n── «Repetir el de siempre» con dos unidades ──');
await recargar(DOS);
A().trips=[{id:'h2',type:'sal',flight:'',date:'2026-09-01',time:'05:10',address:'Solare, Llanogrande',lat:6.11,lng:-75.42,
  residenceId:'r2',residenceUnit:'Casa 8',level:'shared',isPernocta:false,isReserva:true,notes:'',status:'done',driver:null,rated:true}];
A().view='home'; window.Auxiliar.rerender(); await wait();
click('[data-ax="repeat"]'); await wait();
t('con dos unidades el paso del punto sí está', kinds()==='["tipo","vuelo","donde","nivel","revisar"]', kinds());
set('date','2026-12-22'); set('time','04:50'); click('[data-ax="next"]'); await wait();
t('pregunta de cuál sale', /De cuál sales/.test(txt()));
t('con la unidad de la vez anterior ya marcada', !!ui().querySelector('.ax-opt.sel[data-ax="res-unit"][data-n="2"]') && A().form.residenceId==='r2');
t('y se puede seguir sin tocar nada', !next().hasAttribute('disabled'));

console.log('\n── tipo «llegada» (aeropuerto → casa) ──');
await nuevo();
click('[data-ax="type"][data-type="lle"]'); click('[data-ax="next"]'); await wait();
t('pide el número de vuelo', !!ui().querySelector('[data-field="flightNum"]'));
set('flightNum','AV-9412'); set('date','2026-12-20'); set('time','22:40');
click('[data-ax="next"]'); await wait();
t('el paso del punto dice «Dónde te dejamos»', /Dónde te dejamos/.test(txt()));
click('[data-ax="res-unit"][data-n="1"]'); click('[data-ax="next"]'); await wait();
click('[data-ax="next"]'); await wait();   // el paso del nivel (primicia)
t('el resumen dice «Te dejamos en» y la ruta Aeropuerto → Casa', /Te dejamos enOlivar/.test(txt()) && ui().querySelector('.ax-sum-head').textContent.replace(/\s+/g,'')==='AeropuertoCasa');
t('y «Aterriza» con la hora', /Aterriza22:40/.test(txt()));

console.log('\n── camino manual cuando el catálogo no cargó ──');
await recargar(UNA, null); await nuevo();
t('sin catálogo, el paso del punto vuelve a existir', kinds()==='["tipo","vuelo","donde","nivel","revisar"]', kinds());
click('[data-ax="type"][data-type="sal"]'); click('[data-ax="next"]'); await wait();
set('date','2026-12-20'); set('time','05:10'); click('[data-ax="next"]'); await wait();
t('lo dice y ofrece reintentar', /No pudimos cargar tus puntos/.test(txt()) && !!ui().querySelector('[data-ax="res-retry"]'));
t('pide la dirección a mano', !!ui().querySelector('[data-field="address"]'));
t('y aquí ya no hay toggles ni notas', !ui().querySelector('[data-ax="toggle"]') && !ui().querySelector('[data-field="notes"]'));
t('el resumen no ofrecería «Cambiar» sin catálogo', !window.AuxResidencias.hasCatalog());
catalogo=RES; click('[data-ax="res-retry"]'); await wait(100);
t('al reintentar con éxito (una unidad) el paso del punto desaparece y se cae en el nivel', window.Auxiliar.stepKind()==='nivel' && A().form.residenceId==='r1' && !kinds().includes('donde'), txt().slice(0,80));

console.log('\n── «Cambiar» desde el resumen cuando el pedido venía del camino manual ──');
await recargar(UNA, RES);
await nuevo();
click('[data-ax="type"][data-type="sal"]'); click('[data-ax="next"]'); await wait();
set('date','2026-12-20'); set('time','05:10'); click('[data-ax="next"]'); await wait();
click('[data-ax="next"]'); await wait();   // el paso del nivel (primicia) → revisar
click('[data-ax="donde-cambiar"]'); await wait();
click('[data-ax="res-manual"]'); await wait();
t('el camino manual pide la dirección', !!ui().querySelector('[data-field="address"]') && A().form.manualAddr===true);
A().form.address='Cra 51 #49-06'; A().form.lat=6.15; A().form.lng=-75.37; A().form.locConfirmed=true; window.Auxiliar.rerender(); await wait();
click('[data-ax="next"]'); await wait();
click('[data-ax="next"]'); await wait();   // el paso del nivel (primicia)
t('el resumen dice «Dirección» y ofrece «Cambiar»', /Dirección/.test(txt()) && !!ui().querySelector('[data-ax="donde-cambiar"]'));
click('[data-ax="donde-cambiar"]'); await wait();
t('«Cambiar» abre el CATÁLOGO, no otra vez la dirección en blanco', window.Auxiliar.stepKind()==='donde' && !!ui().querySelector('#axr-q') && !ui().querySelector('[data-field="address"]') && A().form.manualAddr===false, txt().slice(0,120));
t('y sigue ofreciendo «Mi punto no está en la lista»', !!ui().querySelector('[data-ax="res-manual"]'));

console.log('\n── pernocta y reserva en el vuelo, notas en el resumen → payload ──');
await nuevo();
click('[data-ax="type"][data-type="sal"]'); click('[data-ax="next"]'); await wait();
t('el paso 2 trae «Sobre el viaje» con los dos toggles', /Sobre el viaje/.test(txt()) && !!ui().querySelector('[data-ax="toggle"][data-key="isPernocta"]') && !!ui().querySelector('[data-ax="toggle"][data-key="isReserva"]'));
t('la reserva en firme arranca encendida', ui().querySelector('[data-ax="toggle"][data-key="isReserva"]').classList.contains('on'));
set('date','2026-12-20'); set('time','05:10');
click('[data-ax="toggle"][data-key="isPernocta"]'); await wait();
click('[data-ax="toggle"][data-key="isReserva"]'); await wait();
t('quedan marcados en el form', A().form.isPernocta===true && A().form.isReserva===false);
t('y la hora no se perdió al repintar', ui().querySelector('[data-field="time"]').value==='05:10');
click('[data-ax="next"]'); await wait();
t('del vuelo se pasa al nivel', window.Auxiliar.stepKind()==='nivel');
click('[data-ax="next"]'); await wait();
t('en revisar están las notas y NO los toggles', !!ui().querySelector('[data-field="notes"]') && !ui().querySelector('[data-ax="toggle"]'));
t('las notas van entre el resumen y «Antes de confirmar»', (()=>{ const h=ui().innerHTML; return h.indexOf('class="ax-sum"')<h.indexOf('data-field="notes"') && h.indexOf('data-field="notes"')<h.indexOf('Antes de confirmar'); })());
t('el resumen refleja pernocta y reserva tentativa', /PernoctaSí \(hotel\)/.test(txt()) && /ReservaTentativa/.test(txt()));
const ta=ui().querySelector('[data-field="notes"]'); ta.focus();
set('notes','Timbre 302');
t('escribir la nota no repinta el paso (mismo nodo, sigue con foco)', ui().querySelector('[data-field="notes"]')===ta && window.document.activeElement===ta);
creadas.length=0;
click('[data-ax="next"]'); await wait(120);
t('se creó la reserva', creadas.length===1);
t('los tres llegan al payload de createReservation', creadas[0]?.isPernocta===true && creadas[0]?.isReserva===false && creadas[0]?.notes==='Timbre 302', JSON.stringify(creadas[0]));

console.log('\n── con privado encendido: el paso del nivel entra en su sitio ──');
window.state.settings={...CON_PRIVADO};
let cupoPedido=0; window.Api.privateBusyAt=async()=>{cupoPedido++;return false;};
await nuevo();
click('[data-ax="type"][data-type="sal"]'); click('[data-ax="next"]'); await wait();
set('date','2026-12-20'); set('time','05:10'); click('[data-ax="next"]'); await wait(60);
t('con una unidad y privado: del vuelo se cae en el nivel (3/4)', window.Auxiliar.stepKind()==='nivel' && /3\/4/.test(txt()) && /Cómo quieres viajar/.test(txt()), txt().slice(0,80));
t('el nivel arranca en compartido y se preguntó el cupo', A().form.level==='shared' && cupoPedido===1, 'cupo pedido '+cupoPedido+' veces');
click('[data-ax="next"]'); await wait();
t('y de ahí a revisar (4/4) con el servicio en el resumen', /4\/4/.test(txt()) && /ServicioCompartido · incluido/.test(txt()));
window.state.settings={...SIN_PRIVADO};

console.log(`\n${ok}/${ok+bad} pasaron${bad?' · '+bad+' FALLARON':''}`);
console.log('NO cubierto: el layout (la fila del resumen con «Cambiar», la ruta con iconos en la tarjeta) — se mira en el teléfono.');
process.exit(bad?1:0);
