// La piel «Rendio Select» del traslado privado (15-sep-2026): el paso «¿Cómo
// quieres viajar?» con las dos tarjetas (LevelCard), la portada (VipIntro) con
// «Pedir en privado», la franja del resumen y el botón de latón.
// Lo de siempre: jsdom NO hace layout ni pinta colores. Esto prueba que el HTML
// trae las piezas, que el precio es el REAL de Ajustes, que las acciones mueven
// el estado y que ningún texto prohibido se coló (básico, XX.XXX, el kit de
// consumibles, códigos, «te avisamos apenas»). Cómo se VE se mira en el
// teléfono.
// REQUIERE jsdom (no está en el repo, es solo para probar):
//   cd rendio-backend && node scripts/_smoke-select-dom.mjs
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

const RES=[{id:'r1',name:'Olivar Apartamentos',sector:'Norte',latitude:6.15,longitude:-75.37}];
const UNA={residenceId:'r1',residence:RES[0],unit:'Torre 3 · 302',residenceId2:null,residence2:null,unit2:'',homeAddress:'',homeLat:null,homeLng:null};
let busy=false, cupoPedido=0;
const creadas=[];
window.Api={ listMyReservations:async()=>[], listResidences:async()=>RES,
  getMyAuxiliarPlace:async()=>UNA, saveMyResidence:async()=>true,
  createReservation:async(f)=>{creadas.push(JSON.parse(JSON.stringify(f)));return 'r'+creadas.length;},
  getSettings:async()=>window.state.settings,
  privateBusyAt:async()=>{cupoPedido++;return busy;} };
window.state={settings:{aux_private_enabled:true,aux_private_vehicle_id:'v1',aux_private_price_cop:150000,aux_min_lead_hours:6,aux_wait_minutes:5}};
global.state=window.state;
for(const f of ['aux-residencias.js','aux-privado.js','aux-presentacion.js','auxiliar.js']) window.eval(readFileSync(APP+f,'utf8'));

const ui=()=>window.document.getElementById('auxiliar-ui');
const html=()=>ui().innerHTML;
const txt=()=>ui().textContent.replace(/\s+/g,' ');
const q=(s)=>ui().querySelector(s);
const click=(s)=>{const e=q(s); if(!e) throw new Error('no existe: '+s); e.click();};
const set=(k,v)=>{const i=q(`[data-field="${k}"]`); if(!i) throw new Error('no existe campo '+k); i.value=v; i.dispatchEvent(new window.Event('input',{bubbles:true}));};
const wait=(ms=40)=>new Promise(r=>setTimeout(r,ms));
const A=()=>window.Auxiliar.state;
const P=()=>window.AuxPrivado;
async function nuevo(){ A().view='home'; A().source='live'; window.Auxiliar.rerender(); await wait(); click('[data-ax="new"]'); await wait(60); }
// Del inicio al paso del nivel: tipo → vuelo → (una unidad: sin 'donde') → nivel.
async function hastaNivel(){ await nuevo(); click('[data-ax="type"][data-type="sal"]'); click('[data-ax="next"]'); await wait();
  set('date','2026-12-20'); set('time','05:10'); click('[data-ax="next"]'); await wait(60); }

// Lo que NO puede aparecer en ninguna pantalla del módulo (brief + profa).
const PROHIBIDO=[/b[áa]sico/i,/XX\.XXX/,/\bagua\b/i,/pantuflas/i,/coj[íi]n/i,/te avisamos apenas/i,/c[óo]digo/i];
const limpio=(nombre,h)=>{ const malo=PROHIBIDO.find(re=>re.test(h)); t(nombre+' · sin textos prohibidos', !malo, malo && ('apareció '+malo)); };
// Lo que TODAS las conservas del módulo tienen que seguir exportando.
t('AuxPrivado conserva su API', ['enabled','price','money','stepHTML','introHTML','statusHTML','chipHTML','askCupo','resetCupo','cupo','INCLUYE','sumHTML'].every(k=>k in P()));
t('money formatea el precio real', P().money(150000)==='$ 150.000', P().money(150000));

await window.Auxiliar.init({id:'p1',full_name:'Ana Lucía Restrepo Vélez',role:'auxiliar'}); await wait(80);

console.log('\n── el paso «¿Cómo quieres viajar?» · las dos tarjetas ──');
await hastaNivel();
t('se cae en el paso del nivel', window.Auxiliar.stepKind()==='nivel' && /Cómo quieres viajar/.test(txt()), txt().slice(0,80));
t('se preguntó el cupo y está libre', cupoPedido===1 && P().cupo()==='libre', 'cupo='+P().cupo());
const sh=q('.axp-lvl.sh'), vip=q('.axp-lvl.vip');
t('hay una tarjeta compartida y una privada', !!sh && !!vip);
t('la compartida arranca elegida (.on) y sin castigo', sh.classList.contains('on') && !vip.classList.contains('on') && /Compartido/.test(sh.textContent) && /Incluido/.test(sh.textContent) && /Sin costo para ti/.test(sh.textContent));
t('la compartida trae su lista con chulos', sh.querySelectorAll('.axp-lvl-inc use[href="#i-check"]').length===2 && /Ruta agrupada por sector/.test(sh.textContent) && /Paradas en el camino/.test(sh.textContent));
t('el check redondo solo en la elegida', !!sh.querySelector('.axp-lvl-chk') && !vip.querySelector('.axp-lvl-chk'));
t('la privada lleva el eyebrow «Rendio Select»', vip.querySelector('.axp-eyebrow')?.textContent.trim()==='Rendio Select');
t('y se llama «Privado», con su tagline', vip.querySelector('.axp-lvl-name')?.textContent==='Privado' && /La camioneta es solo tuya/.test(vip.textContent));
t('con el precio REAL formateado', vip.querySelector('.axp-lvl-price')?.textContent==='$ 150.000' && /por trayecto/.test(vip.textContent), vip.querySelector('.axp-lvl-price')?.textContent);
t('los 4 pilares de INCLUYE en la tarjeta', P().INCLUYE.every(x=>vip.textContent.includes(x.t)) && vip.querySelectorAll('.axp-lvl-inc use[href="#i-check"]').length===P().INCLUYE.length);
t('el pie dice que la camioneta está disponible', vip.querySelector('.axp-lvl-avail')?.textContent==='Disponible a esa hora');
t('y trae «Ver qué incluye» como span dentro del botón', vip.querySelector('span.axp-lvl-more[data-ax="lvl-info"]') && /Ver qué incluye/.test(vip.querySelector('.axp-lvl-more').textContent));
t('el botón suelto .axp-more ya no existe', !q('.axp-more'));
t('la tarjeta privada no trae <div> (HTML válido dentro de <button>)', vip.querySelectorAll('div').length===0);
t('debajo de las tarjetas, la nota honesta', /Coordinación confirma cada privado\. Si no se puede, sales en compartido y no se cobra nada\./.test(txt()));
t('en compartido no sale la nota de aprobación', !q('.axp-note'));
t('el CTA sigue siendo «Continuar», sin latón', /Continuar/.test(q('[data-ax="next"]').textContent) && !q('[data-ax="next"]').classList.contains('ax-btn-brass'));
const htmlPasoSh=html();
limpio('paso (compartido elegido)', htmlPasoSh);

console.log('\n── elegir el privado ──');
click('.axp-lvl.vip'); await wait();
t('queda elegido en el pedido', A().form.level==='private');
t('la tarjeta privada pasa a .on con su check', q('.axp-lvl.vip').classList.contains('on') && !!q('.axp-lvl.vip .axp-lvl-chk') && !q('.axp-lvl.sh').classList.contains('on'));
t('aparece la nota «Lo tiene que aprobar coordinación», intacta', /Lo tiene que aprobar coordinación/.test(txt()) && /La respuesta la vas a ver aquí mismo/.test(txt()));
limpio('paso (privado elegido)', html());
click('[data-ax="next"]'); await wait();
t('en revisar: el resumen dice Privado con el precio', window.Auxiliar.stepKind()==='revisar' && /Privado · \$ 150\.000/.test(txt()));
const franja=q('.ax-sum + .axp-sum-vip') || q('.axp-sum-vip');
t('la franja Select va justo debajo de la tarjeta resumen', !!q('.ax-sum + .axp-sum-vip'));
t('con eyebrow, línea serif y el precio real', franja && franja.querySelector('.axp-eyebrow')?.textContent.trim()==='Rendio Select' && /La camioneta, solo para ti/.test(franja.textContent) && /\$ 150\.000 por trayecto · lo confirma coordinación · no se cobra en la app/.test(franja.textContent.replace(/\s+/g,' ')), franja?.textContent);
const cta=q('[data-ax="next"]');
t('el CTA dice «Solicitar traslado privado» en latón', cta.textContent.trim()==='Solicitar traslado privado' && cta.classList.contains('ax-btn-brass') && cta.classList.contains('ax-btn-primary'));
limpio('revisar (privado)', html());
click('[data-ax="back"]'); await wait();
t('atrás vuelve al nivel con el privado aún marcado', window.Auxiliar.stepKind()==='nivel' && q('.axp-lvl.vip').classList.contains('on'));
click('.axp-lvl.sh'); await wait();
t('volver a compartido quita el latón y la franja', A().form.level==='shared' && (click('[data-ax="next"]'), true) && !q('.axp-sum-vip') && !q('[data-ax="next"]').classList.contains('ax-btn-brass') && q('[data-ax="next"]').textContent.trim()==='Confirmar traslado');
click('[data-ax="back"]'); await wait();

console.log('\n── la portada «Qué incluye» ──');
click('[data-ax="lvl-info"]'); await wait();
t('abre la vista privado sin cambiar el nivel', A().view==='privado' && A().form.level==='shared');
t('trae el wordmark «Select» y los eyebrows', q('.axp-wordmark')?.textContent==='Select' && [...ui().querySelectorAll('.axp-eyebrow')].map(e=>e.textContent.trim()).join('|')==='Traslado privado|Rendio');
t('el titular serif y el párrafo', /Llega antes\.\s*Llega descansado\./.test(q('.axp-hero h1')?.textContent) && /la camioneta reservada a tu nombre, directo al aeropuerto, sin paradas en el camino/.test(txt()));
const pil=[...ui().querySelectorAll('.axp-pillar')];
t('los 4 pilares de INCLUYE con numeral romano', pil.length===P().INCLUYE.length && pil.map(p=>p.querySelector('.axp-pillar-n').textContent).join(',')==='I,II,III,IV' && P().INCLUYE.every((x,i)=>pil[i].textContent.includes(x.t) && pil[i].textContent.includes(x.d)));
t('separados por reglas', ui().querySelectorAll('.axp-rule-ln').length===P().INCLUYE.length-1);
t('la disponibilidad dicha de frente: «Una sola camioneta»', /Una sola camioneta/.test(txt()) && /No siempre está disponible: depende de la hora que necesites/.test(txt()) && !!q('.axp-avail use[href="#i-clock"]'));
t('el compartido sigue igual', /Tu viaje compartido sigue igual: mismo servicio, mismos conductores, sin costo\./.test(txt()));
t('el pie trae la tarifa REAL en la fila «Tarifa»', q('.axp-fare span')?.textContent==='Tarifa' && q('.axp-fare b')?.textContent==='$ 150.000' && /por trayecto · no se cobra en la app/.test(txt()));
const elegir=q('[data-ax="lvl-choose"]');
t('el botón de latón «Pedir en privado», habilitado', elegir && elegir.textContent.trim()==='Pedir en privado' && !elegir.hasAttribute('disabled'));
t('y un «Volver» fantasma + el botón redondo de atrás, ambos lvl-close', q('.axp-btn.ghost[data-ax="lvl-close"]')?.textContent.trim()==='Volver' && !!q('.axp-back[data-ax="lvl-close"] use[href="#i-back"]'));
t('el cuerpo reutiliza .ax-body (desplaza) y la cabecera va en tinta', !!q('.ax-body.axp-intro') && !!q('.axp-ink .axp-hero'));
limpio('portada', html());
click('[data-ax="lvl-choose"]'); await wait();
t('«Pedir en privado» deja level=private y vuelve al formulario', A().form.level==='private' && A().view==='form' && window.Auxiliar.stepKind()==='nivel');
t('con la privada marcada y la nota de aprobación', q('.axp-lvl.vip').classList.contains('on') && !!q('.axp-note'));
t('no volvió a preguntar el cupo (misma hora)', cupoPedido===1, 'cupo pedido '+cupoPedido+' veces');
click('[data-ax="lvl-info"]'); await wait();
click('.axp-btn.ghost[data-ax="lvl-close"]'); await wait();
t('«Volver» cierra la portada sin tocar el nivel', A().view==='form' && A().form.level==='private');

console.log('\n── con la camioneta comprometida a esa hora ──');
busy=true; P().resetCupo();
await P().askCupo('2026-12-20T05:10'); await wait();
t('el cupo queda ocupado', P().cupo()==='ocupada');
const vipOff=q('.axp-lvl.vip');
t('la tarjeta privada queda .off con aria-disabled (NO disabled: mataría «Ver qué incluye»)', vipOff.classList.contains('off') && vipOff.getAttribute('aria-disabled')==='true' && !vipOff.hasAttribute('disabled'));
A().form.level='shared'; vipOff.click(); await wait();
t('tocar la tarjeta comprometida no elige el privado', A().form.level==='shared' && A().view==='form');
click('.axp-lvl.vip [data-ax="lvl-info"]'); await wait();
t('pero «Ver qué incluye» sigue abriendo la portada', A().view==='privado');
A().view='form'; window.Auxiliar.rerender(); await wait();
t('y su pie dice «Comprometida a esa hora»', vipOff.querySelector('.axp-lvl-avail')?.textContent==='Comprometida a esa hora');
t('la compartida sigue disponible', !q('.axp-lvl.sh').hasAttribute('disabled'));
limpio('paso (ocupada)', html());
A().view='privado'; window.Auxiliar.rerender(); await wait();
const elegirOff=q('[data-ax="lvl-choose"]');
t('en la portada el botón queda disabled y lo dice', elegirOff.hasAttribute('disabled') && elegirOff.textContent.trim()==='Comprometida a esa hora');
A().form.level='shared';
elegirOff.click(); await wait();
t('tocarlo no elige el privado', A().form.level==='shared' && A().view==='privado');
limpio('portada (ocupada)', html());
click('.axp-back'); await wait();
t('atrás desde la portada vuelve al paso', A().view==='form' && window.Auxiliar.stepKind()==='nivel');

console.log('\n── sin respuesta del servidor ──');
busy=false; P().resetCupo(); window.Api.privateBusyAt=async()=>{throw new Error('caído');};
await P().askCupo('2026-12-20T05:10'); await wait();
t('el pie dice «Sin confirmar la hora» y se deja pedir', q('.axp-lvl.vip .axp-lvl-avail')?.textContent==='Sin confirmar la hora' && !q('.axp-lvl.vip').hasAttribute('disabled') && /No pudimos confirmar/.test(txt()));
limpio('paso (sin confirmar)', html());

console.log('\n── sin privado en Ajustes ──');
window.state.settings={aux_min_lead_hours:6,aux_wait_minutes:5};
t('el paso no existe y la franja tampoco', P().stepHTML({level:'private'})===null && P().sumHTML({level:'private'})==='');

console.log(`\n${ok}/${ok+bad} pasaron${bad?' · '+bad+' FALLARON':''}`);
console.log('NO cubierto: colores, degradados, la serif y el layout de las tarjetas y la portada (jsdom no pinta) — se mira en el teléfono, de día y de noche.');
process.exit(bad?1:0);
