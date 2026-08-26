// Regresión del caso NORMAL: el tripulante con UNA sola unidad. Es el de los
// 102 perfiles que ya existen, y el que el selector de dos unidades no puede
// haber cambiado.
// REQUIERE jsdom (no está en el repo, es solo para probar):
//   cd rendio-backend && npm install --no-save jsdom
//
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
const APP='../rendio-turnos/';
const dom=new JSDOM(readFileSync(APP+'index.html','utf8'),{runScripts:'outside-only',pretendToBeVisual:true,url:'http://localhost/'});
const {window}=dom; global.window=window; global.document=window.document;
window.RENDIO_CONFIG={OTP_LENGTH:8}; window.toast=()=>{}; window.L=undefined;
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
for(const f of ['aux-residencias.js','aux-privado.js','aux-presentacion.js','auxiliar.js']) window.eval(readFileSync(APP+f,'utf8'));
const ui=()=>window.document.getElementById('auxiliar-ui');
const txt=()=>ui().textContent.replace(/\s+/g,' ');
const click=(s)=>{const e=ui().querySelector(s); if(!e) throw new Error('no existe: '+s); e.click();};
const set=(k,v)=>{const i=ui().querySelector(`[data-field="${k}"]`); i.value=v; i.dispatchEvent(new window.Event('input',{bubbles:true}));};
const wait=(ms=40)=>new Promise(r=>setTimeout(r,ms));

await window.Auxiliar.init({id:'p1',full_name:'Julián Andrés López Mesa',role:'auxiliar'}); await wait(80);
window.Auxiliar.state.view='form'; window.Auxiliar.state.step=1; window.Auxiliar.state.form={isReserva:true};
window.AuxResidencias.newTrip(); window.AuxResidencias.load(); await wait(80);
window.Auxiliar.rerender();
click('[data-ax="type"][data-type="sal"]'); click('[data-ax="next"]');
set('flight','AV-9412'); set('date','2026-12-20'); set('time','05:10');
click('[data-ax="next"]'); await wait();
console.log('\n── paso 3 con UNA unidad ──');
t('NO pregunta de cuál unidad sale', !/De cuál sales/.test(txt()), txt().slice(0,160));
t('ofrece su punto guardado como atajo', /Tu punto/.test(txt()));
t('y el catálogo completo debajo', ui().querySelectorAll('[data-ax="res-pick"]').length>=2);
click('[data-ax="res-pick"][data-id="r1"]'); await wait();
t('al elegir su conjunto, lo confirma', /Ubicación verificada/.test(txt()));
t('arrastra el apartamento del perfil', window.Auxiliar.state.form.residenceUnit==='Torre 3 · 302');
click('[data-ax="next"]'); await wait();
t('el resumen lleva la unidad', /UnidadTorre 3 · 302/.test(txt()), txt().slice(0,240));
click('[data-ax="next"]'); await wait(120);
t('crea UNA sola reserva (no marcó regreso)', creadas.length===1, 'creadas='+creadas.length);
t('con conjunto y apartamento', creadas[0]?.residenceId==='r1' && creadas[0]?.residenceUnit==='Torre 3 · 302');

console.log('\n── elegir un conjunto que NO es el suyo ──');
window.Auxiliar.state.view='form'; window.Auxiliar.state.step=3;
window.Auxiliar.state.form={isReserva:true,type:'sal',flight:'AV-1',date:'2026-12-21',time:'06:00'};
window.AuxResidencias.newTrip(); window.Auxiliar.rerender(); await wait();
click('[data-ax="res-pick"][data-id="r2"]'); await wait();
t('no le pega el apartamento de su otro conjunto', !window.Auxiliar.state.form.residenceUnit,
  'quedó: '+window.Auxiliar.state.form.residenceUnit);

console.log(`\n${ok}/${ok+bad} pasaron${bad?' · '+bad+' FALLARON':''}`);
process.exit(bad?1:0);
