// Pintado de lo demás que cambió el 25-ago: el pedido de traslado (hora de
// llegada al aeropuerto, regreso el mismo día, selector de unidad) y el padrón
// de tripulantes del admin.
// REQUIERE jsdom (no está en el repo, es solo para probar):
//   cd rendio-backend && npm install --no-save jsdom
//
// REDISEÑO (P5, 27-sep-2026): mientras exista el interruptor corre en los DOS
// modos. RX=0 (o sin variable) = el pedido de siempre; RX=1 = el pedido nuevo
// (.rx-book: .rx-list de unidades, .rx-review, deslizador). Mismo contrato res-*.
//   RX=0 node scripts/_smoke-unidades-dom.mjs
//   RX=1 node scripts/_smoke-unidades-dom.mjs
//
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
const APP='../rendio-turnos/';
const dom = new JSDOM(readFileSync(APP+'index.html','utf8'), { runScripts:'outside-only', pretendToBeVisual:true, url:'http://localhost/' });
const { window } = dom;
global.window=window; global.document=window.document;
window.RENDIO_CONFIG={OTP_LENGTH:8};
window.toast=()=>{};
window.L = undefined;  // sin Leaflet: el mapa se salta solo
// escapeHtml es global de admin-disponibilidad.js (no se carga aquí); el chip
// de la sigla del vuelo (11-sep) lo usa.
window.escapeHtml=(s)=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

let ok=0,bad=0; const t=(n,c,d='')=>{if(c){ok++;console.log('  ✓ '+n)}else{bad++;console.log('  ✗ '+n+(d?' → '+d:''))}};

// ── El auxiliar con DOS unidades ──
const RES=[{id:'r1',name:'Olivar Apartamentos',sector:'Norte',latitude:6.15,longitude:-75.37},
           {id:'r2',name:'Solare',sector:'Llanogrande',latitude:6.11,longitude:-75.42},
           {id:'r3',name:'Cámbulo',sector:'Norte',latitude:6.16,longitude:-75.36}];
const creadas=[];
window.Api={
  listMyReservations: async()=>[],
  listResidences: async()=>RES,
  getMyAuxiliarPlace: async()=>({ residenceId:'r1', residence:RES[0], unit:'Torre 3 · 302',
    residenceId2:'r2', residence2:RES[1], unit2:'Casa 8', homeAddress:'', homeLat:null, homeLng:null }),
  saveMyResidence: async()=>true,
  createReservation: async(f)=>{ creadas.push(JSON.parse(JSON.stringify(f))); return 'res'+creadas.length; },
  getSettings: async()=>({}),
};
window.state={ settings:{ aux_min_lead_hours:6, aux_wait_minutes:5 } };
global.state=window.state;
const RX=process.env.RX==='1';
console.log('Modo: '+(RX?'RX=1 (rediseño encendido)':'RX=0 (el pedido de siempre)'));
window.localStorage.setItem('rendio.aux.rx',RX?'1':'0');
// Los mismos archivos en los dos modos (la app real los carga todos); solo cambia la bandera.
const PANTALLAS=['aux-rx-inicio.js','aux-rx-viajes.js','aux-rx-avisos.js','aux-rx-viaje.js','aux-rx-pedir.js','aux-rx-perfil.js','aux-rx-pagos.js','aux-rx-puntos.js','aux-rx-coord.js','aux-rx-vuelo.js'];
for (const f of ['aux-rx-ui.js','aux-shell.js','api-aux.js','aux-residencias.js','aux-privado.js','aux-celebracion.js','aux-presentacion.js',...PANTALLAS,'auxiliar.js']) window.eval(readFileSync(APP+f,'utf8'));

const ui=()=>window.document.getElementById('auxiliar-ui');
// Con el rediseño el pedido vive en su capa (data-scr="book"); la pestaña de atrás no cuenta.
const scope=()=>(RX&&ui().querySelector('[data-scr="book"]:not(.out)'))||ui();
const txt=()=>scope().textContent.replace(/\s+/g,' ');
const click=(sel)=>{const e=scope().querySelector(sel); if(!e) throw new Error('no existe: '+sel); e.click();};
const set=(k,v)=>{const i=scope().querySelector(`[data-field="${k}"]`); if(!i) throw new Error('no existe campo '+k);
  i.value=v; i.dispatchEvent(new window.Event('input',{bubbles:true}));};
const wait=(ms=40)=>new Promise(r=>setTimeout(r,ms));
const next=()=>scope().querySelector('[data-ax="next"]');
async function tipo(tp){ click(`[data-ax="type"][data-type="${tp}"]`); if(RX) await wait(320); else click('[data-ax="next"]'); }
async function confirmar(){ if(RX){ click('.rx-slide-k'); await wait(460); } else { click('[data-ax="next"]'); await wait(120); } }
const filaPunto=()=>RX?(scope().querySelector('.rx-rv-row[data-ax="donde-cambiar"]')?.textContent||''):txt();

console.log('\n── el pedido: la hora que se pide ──');
await window.Auxiliar.init({id:'p1',full_name:'Ana Lucía Restrepo Vélez',role:'auxiliar'});
await wait(80);
window.Auxiliar.state.view='form'; window.Auxiliar.state.step=1; window.Auxiliar.state.form={isReserva:true};
window.AuxResidencias.newTrip(); window.AuxResidencias.load(); await wait(80);
window.Auxiliar.rerender();
await tipo('sal');
t('el paso del vuelo ya no dice «hora de presentación»', !/Hora de presentación/.test(txt()), txt().slice(0,200));
t('pide la hora de estar EN EL AEROPUERTO', /Hora en que quieres estar en el aeropuerto/.test(txt()));
t('lo aclara para que no lo confundan', /No es tu hora de presentación/.test(txt()));

console.log('\n── el pedido: el regreso el mismo día ──');
t('ofrece el regreso del mismo día', /Regreso el mismo día/.test(txt()));
set('date','2026-12-20'); set('time','05:10');   // una salida no pide vuelo (25-ago)
t('sin regreso, el botón se habilita', !next().hasAttribute('disabled'));
click('[data-ax="toggle"][data-key="sameDayBack"]'); await wait();
t('al marcarlo, pide la hora del regreso', /Hora a la que aterrizas de vuelta/.test(txt()));
t('y bloquea hasta que la den', next().hasAttribute('disabled'));
// Desde el 11-sep el vuelo es chip de sigla + dígitos: el pegado "AV-9413" se
// parte solo y se guarda "AV9413" (sin guion).
set('backTime','19:40'); set('backFlightNum','AV-9413');
t('con la hora del regreso, se desbloquea', !next().hasAttribute('disabled'));
t('el pegado del vuelo se parte en sigla + dígitos', window.Auxiliar.state.form.backFlight==='AV9413', 'quedó: '+window.Auxiliar.state.form.backFlight);

console.log('\n── el pedido: la pernocta y la reserva en firme viven con el vuelo (15-sep) ──');
t(RX?'el paso del vuelo trae la tarjeta de opciones (.rx-card)':'el paso del vuelo trae la sección «Sobre el viaje»', RX ? !!scope().querySelector('.rx-card [data-key="isPernocta"]') : /Sobre el viaje/.test(txt()));
t('con los dos toggles', !!scope().querySelector('[data-ax="toggle"][data-key="isPernocta"]') && !!scope().querySelector('[data-ax="toggle"][data-key="isReserva"]'));
click('[data-ax="toggle"][data-key="isPernocta"]'); await wait();
t('marcar la pernocta aquí queda en el pedido', window.Auxiliar.state.form.isPernocta===true);
t('y no se pierde el regreso marcado', window.Auxiliar.state.form.sameDayBack===true && scope().querySelector('[data-field="backTime"]').value==='19:40');

console.log('\n── el pedido: elegir de cuál unidad sale ──');
click('[data-ax="next"]'); await wait();
t('con dos unidades, SÍ existe el paso del punto', window.Auxiliar.stepKind()==='donde' && /3\/5/.test(txt()), JSON.stringify(window.Auxiliar.kinds()));
t('con dos unidades, pregunta de cuál sale', /De cuál sales/.test(txt()), txt().slice(0,180));
t('el paso es SOLO el selector: sin toggles ni notas', !scope().querySelector('[data-ax="toggle"]') && !scope().querySelector('[data-field="notes"]'));
t('y sin la lista del catálogo (esa sale con «otro lado»)', !scope().querySelector('#axr-q'));
t('muestra las dos con su apartamento', /Torre 3 · 302/.test(txt()) && /Casa 8/.test(txt()));
t('y deja salir de un tercer lado', /Hoy salgo de otro lado/.test(txt()));
t('el botón está bloqueado hasta elegir', next().hasAttribute('disabled'));
if (RX) t('las dos unidades son .rx-opt del diseño', scope().querySelectorAll('.rx-opt[data-ax="res-unit"]').length===2);
click('[data-ax="res-unit"][data-n="2"]'); await wait();
t('al elegir la 2, queda marcada', !!scope().querySelector(RX?'.rx-opt.on[data-ax="res-unit"][data-n="2"]':'.ax-opt.sel'));
t('y el pedido apunta al conjunto de la unidad 2', window.Auxiliar.state.form.residenceId==='r2');
t('con su apartamento', window.Auxiliar.state.form.residenceUnit==='Casa 8');
t('ya se puede seguir', !next().hasAttribute('disabled'));
t('con la confirmación compacta del punto (sin «Cambiar» propio ni «guardar»)', /Ubicación verificada/.test(txt()) && !scope().querySelector('[data-ax="res-change"]') && !scope().querySelector('[data-ax="res-save"]'));

console.log('\n── el resumen y el envío ──');
click('[data-ax="next"]'); await wait();
click('[data-ax="next"]'); await wait();   // el paso del nivel (primicia desde el 17-sep)
t(RX?'el resumen dice «estar en MDE», no «Presentación»':'el resumen dice «Estar en el aeropuerto», no «Presentación»', (RX?/estar en MDE/:/Estar en el aeropuerto/).test(txt()) && !/Presentación 05:10/.test(txt()), txt().slice(0,260));
// textContent pega <span>etiqueta</span><b>valor</b> sin espacio: se compara
// contra la cadena tal cual sale, no como se lee en pantalla.
t('el resumen muestra la unidad', RX ? /Casa 8/.test(filaPunto()) : /UnidadCasa 8/.test(txt()), txt().slice(0,300));
t('el resumen muestra el regreso', (RX?/RegresoAterriza 19:40 · AV9413/:/Regreso \(aterriza\)19:40 · AV9413/).test(txt()), txt().slice(0,300));
if (RX) t('el resumen es la .rx-review del diseño, con la fila «Recogida»', !!scope().querySelector('.rx-review .rx-rv-time') && /Recogida/.test(filaPunto()));
else t('el resumen encabeza con la ruta Casa → Aeropuerto', /CasaAeropuerto/.test(ui().querySelector('.ax-sum-head').textContent.replace(/\s+/g,'')) && !!ui().querySelector('.ax-sum-head span.ax-route'));
t('la pernocta marcada en el vuelo sale en el resumen', /PernoctaSí \(hotel\)/.test(txt()));
t('las notas se escriben en el resumen (15-sep)', !!scope().querySelector('[data-field="notes"]'));
set('notes','Timbre 302');
t('escribir la nota NO repinta el paso (el campo conserva el foco/valor)', scope().querySelector('[data-field="notes"]').value==='Timbre 302' && window.Auxiliar.state.form.notes==='Timbre 302');
await confirmar();
t('creó DOS reservas: ida y regreso', creadas.length===2, 'creadas='+creadas.length);
t('la ida va al aeropuerto a las 05:10', creadas[0]?.type==='sal' && creadas[0]?.time==='05:10');
t('el regreso es una llegada a las 19:40', creadas[1]?.type==='lle' && creadas[1]?.time==='19:40');
t('el regreso sale del mismo conjunto y apartamento', creadas[1]?.residenceId==='r2' && creadas[1]?.residenceUnit==='Casa 8');
t('el regreso lleva su propio número de vuelo', creadas[1]?.flight==='AV9413', 'quedó: '+creadas[1]?.flight);
t('la ida va como pernocta (se marcó en el paso del vuelo)', creadas[0]?.isPernocta===true);
t('las notas del resumen llegan al pedido', creadas[0]?.notes==='Timbre 302', 'quedó: '+creadas[0]?.notes);
t('el regreso NO va como pernocta', creadas[1]?.isPernocta===false);

console.log('\n── la pantalla «Mis viajes» con viajes de verdad ──');
// Se pinta el inicio con un traslado ya guardado. Esta prueba nace de un bug
// real: una función nueva se llamó igual que la que pinta las tarjetas, la
// pisó, y toda la pantalla mostraba «[object Object]». Las pruebas de antes no
// lo vieron porque ninguna llegaba a pintar una tarjeta.
window.Auxiliar.state.trips = [{
  id:'r1', type:'sal', flight:'AV-9412', date:'2026-12-20', time:'05:10',
  address:'Solare, Llanogrande', residenceId:'r2', residenceUnit:'Casa 8',
  lat:6.11, lng:-75.42, level:'shared', isPernocta:false, isReserva:true,
  notes:'', status:'pending', driver:null, rated:false,
}];
window.Auxiliar.state.source='live';
window.Auxiliar.state.view='home'; window.Auxiliar.rerender(); await wait();
t('«Mis viajes» NO muestra [object Object]', !/\[object Object\]/.test(ui().innerHTML), txt().slice(0,160));
// Con el rediseño, Inicio y Viajes son de P3/P4 (sus pruebas miran el contenido);
// aquí solo se vigila que ninguna tarjeta salga «[object Object]».
if (!RX) {
t('pinta el próximo viaje', /Próximo viaje/i.test(txt()));
t('con su vuelo', /AV-9412/.test(txt()), txt().slice(0,220));
t('y su punto de recogida', /Solare/.test(txt()));
}
// la pestaña de viajes usa la misma tarjeta
window.Auxiliar.state.view='viajes'; window.Auxiliar.rerender(); await wait();
t('la pestaña Viajes tampoco', !/\[object Object\]/.test(ui().innerHTML) && (RX || /AV-9412/.test(txt())), txt().slice(0,160));

console.log('\n── el padrón del admin ──');
// La fecha de ingreso del primero se calcula: estaba clavada en el 25-ago y la
// prueba «Desde hoy» solo pasaba ese día.
const HOY=new Date().toLocaleDateString('en-CA',{timeZone:'America/Bogota'});
window.Api.listAuxiliares=async()=>[
  {id:'a1',profileId:'p1',name:'Ana Lucía Restrepo Vélez',email:'ana@gmail.com',phone:'3105557788',active:true,
   createdAt:HOY+'T10:00:00Z',joinedAt:HOY,airline:'Wingo',
   res1:{name:'Solare',sector:'Llanogrande'},unit1:'Torre 1 · 501',res2:{name:'Olivar Apartamentos'},unit2:'Casa 8',homeAddress:''},
  {id:'a2',profileId:'p2',name:'Julián Andrés López Mesa',email:'julian@gmail.com',phone:'',active:true,
   createdAt:'2026-08-20T10:00:00Z',joinedAt:null,airline:'',res1:null,unit1:'',res2:null,unit2:'',homeAddress:'Cra 51 #49-06'},
  {id:'a3',profileId:'p3',name:'Sofía Marcela Ossa Bedoya',email:'sofia@gmail.com',phone:'3123334455',active:true,
   createdAt:'2025-01-05T10:00:00Z',joinedAt:'2025-02-10',airline:'Avianca',
   res1:{name:'Cámbulo',sector:'Norte'},unit1:'Apto 402',res2:null,unit2:'',homeAddress:''}];
window.Api.listAirlines=async()=>[{id:'x1',name:'Avianca',iata_code:'AV',is_active:true},{id:'x2',name:'Wingo',iata_code:'P5',is_active:true}];
window.Api.setAuxiliarJoinedAt=async()=>true;
window.eval(readFileSync(APP+'admin-tripulantes.js','utf8'));
window.renderTripulantes(); await wait(60);
const tui=()=>window.document.getElementById('tripulantes-ui');
const ttxt=()=>tui().textContent.replace(/\s+/g,' ');
t('lista los tres tripulantes', tui().querySelectorAll('.tp-row').length===3, String(tui().querySelectorAll('.tp-row').length));
t('avisa de quien no tiene fecha de ingreso', /1 tripulante no tiene fecha/.test(ttxt()), ttxt().slice(0,180));
t('calcula la antigüedad en palabras', /6 meses|meses/.test(ttxt()));
t('marca «Desde hoy» al que se registró hoy', /Desde hoy/.test(ttxt()));
t('muestra la segunda unidad', /2ª unidad/.test(ttxt()));
t('dice quién no tiene teléfono', /sin teléfono/.test(ttxt()));
t('dice quién no tiene aerolínea', /sin aerolínea/.test(ttxt()));
// filtro
tui().querySelector('[data-tp="filtro"][data-f="sin-fecha"]').click();
t('el filtro «sin fecha» deja uno', tui().querySelectorAll('.tp-row').length===1);
tui().querySelector('[data-tp="filtro"][data-f="dos-unidades"]').click();
t('el filtro «dos unidades» deja uno', tui().querySelectorAll('.tp-row').length===1);
tui().querySelector('[data-tp="filtro"][data-f="todos"]').click();
// búsqueda
const q=window.document.getElementById('tp-search'); q.value='cámbulo'; q.dispatchEvent(new window.Event('input',{bubbles:true}));
t('la búsqueda encuentra por conjunto (con tilde)', tui().querySelectorAll('.tp-row').length===1);
q.value=''; q.dispatchEvent(new window.Event('input',{bubbles:true}));
// editar la fecha
tui().querySelector('.tp-row [data-tp="edit"]').click();
t('abre el editor de fecha', !!window.document.getElementById('tp-date'));
window.document.getElementById('tp-date').value='2024-03-15';
tui().querySelector('[data-tp="save"]').click(); await wait(60);
t('guarda la fecha corregida', /1 año|años/.test(ttxt()), ttxt().slice(0,200));
// aerolíneas
tui().querySelector('[data-tp="air"]').click(); await wait(30);
t('abre el panel de aerolíneas', /Aerolíneas del desplegable/.test(ttxt()));
t('avisa que solo Avianca y Wingo están medidas', /solo está medido para Avianca y Wingo/.test(ttxt()));

console.log(`\n${ok}/${ok+bad} pasaron${bad?' · '+bad+' FALLARON':''}`);
process.exit(bad?1:0);
