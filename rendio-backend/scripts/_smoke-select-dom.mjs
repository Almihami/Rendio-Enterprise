// La piel «Rendio Select» del traslado privado (15-sep-2026): el paso «¿Cómo
// quieres viajar?» con las dos tarjetas (LevelCard), la portada (VipIntro) con
// «Pedir en privado», la franja del resumen y el botón de latón.
// Lo de siempre: jsdom NO hace layout ni pinta colores. Esto prueba que el HTML
// trae las piezas, que el precio es el REAL de Ajustes, que las acciones mueven
// el estado y que ningún texto prohibido se coló (básico, XX.XXX, el kit de
// consumibles, códigos, «te avisamos apenas»). Cómo se VE se mira en el
// teléfono.
// Segunda parte (27-sep-2026, P6): la MISMA pantalla con la bandera del
// rediseño ENCENDIDA (rendio.aux.rx='1'): RxLevelCard (.rx-lv, .rx-lv.vip,
// Directo .off «Pronto», .rx-lv.vip.primicia), RxSelect (.rx-sel) con lvl-* y
// rx-pop, select-pref / pref-level contra ApiAux.saveMyPrefs, syncLevels.
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
// 17-sep-2026: la CIFRA tampoco. El número de Ajustes nunca fue una tarifa
// acordada, y en la pantalla del tripulante se lee como precio pactado.
const PROHIBIDO=[/b[áa]sico/i,/XX\.XXX/,/\bagua\b/i,/pantuflas/i,/coj[íi]n/i,/te avisamos apenas/i,/c[óo]digo/i,/\$\s*150/,/150\.000/];
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
t('dice que tiene costo, SIN cifra', vip.querySelector('.axp-lvl-price')?.textContent==='Con costo' && /Coordinación te confirma la tarifa/.test(vip.textContent), vip.querySelector('.axp-lvl-price')?.textContent);
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
t('en revisar: el resumen dice Privado con costo, sin cifra', window.Auxiliar.stepKind()==='revisar' && /ServicioPrivado · con costo/.test(txt()) && !/150/.test(txt()), txt().slice(0,240));
const franja=q('.ax-sum + .axp-sum-vip') || q('.axp-sum-vip');
t('la franja Select va justo debajo de la tarjeta resumen', !!q('.ax-sum + .axp-sum-vip'));
t('con eyebrow, línea serif y quién confirma, sin cifra', franja && franja.querySelector('.axp-eyebrow')?.textContent.trim()==='Rendio Select' && /La camioneta, solo para ti/.test(franja.textContent) && /Coordinación confirma la camioneta y la tarifa · no se cobra en la app/.test(franja.textContent.replace(/\s+/g,' ')), franja?.textContent);
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
t('el pie dice que tiene costo y quién lo confirma, sin cifra ni fila «Tarifa»', !q('.axp-fare') && /Tiene costo\. Coordinación te confirma la tarifa antes de aprobarlo, y no se cobra en la app\./.test(txt()));
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

console.log('\n── sin privado en Ajustes: PRIMICIA (17-sep) ──');
// Antes el paso entero desaparecía. Ahora la tarjeta se ve apagada, se puede
// entrar a leer de qué se trata, y no se puede pedir. Es lo que ve producción.
window.state.settings={aux_min_lead_hours:6,aux_wait_minutes:5};
t('es primicia y el paso SIGUE existiendo', P().primicia()===true && typeof P().stepHTML({level:'shared'})==='string');
const prevHTML=P().stepHTML({level:'private'});
t('la tarjeta privada va apagada y no se puede elegir', /axp-lvl vip[^"]*primicia/.test(prevHTML) && /aria-disabled="true"/.test(prevHTML) && !/data-ax="lvl" data-v="private"/.test(prevHTML));
t('dice «Pronto» en vez de precio y que todavía no se puede pedir', /Pronto/.test(prevHTML) && /Todavía no se puede pedir/.test(prevHTML));
t('pero se puede entrar a ver de qué se trata', /data-ax="lvl-info"/.test(prevHTML));
t('y aunque el form dijera privado, la tarjeta elegida es la compartida', /axp-lvl sh on/.test(prevHTML));
const prevIntro=P().introHTML({type:'sal'});
t('la portada se lee entera, con el botón apagado y «Muy pronto»', /Select/.test(prevIntro) && /Muy pronto/.test(prevIntro) && /data-ax="lvl-choose" disabled/.test(prevIntro));
t('y no promete aviso ni cifra', !/te avisamos/i.test(prevIntro) && !/150/.test(prevIntro));
t('la franja del resumen sigue sin salir', P().sumHTML({level:'private'})==='');
limpio('primicia · paso', prevHTML); limpio('primicia · portada', prevIntro);

// ═══════════════════════════════════════════════════════════════════════════
// BANDERA ENCENDIDA (rediseño 27-sep-2026 · P6): RxLevelCard + RxSelect
// ═══════════════════════════════════════════════════════════════════════════
// Una app NUEVA en otro jsdom con rendio.aux.rx='1' (aux-rx-ui + aux-shell). El
// pedido de P5 todavía puede no estar: se registra un 'book' mínimo que pinta
// lo que P5 pinta en el paso (AuxPrivado.levelsHTML / sumHTML), para probar el
// contrato de P6 con los manejadores REALES de auxiliar.js (lvl, lvl-info,
// lvl-close, lvl-choose, toggle) y del shell (open-select, rx-pop, hojas).
console.log('\n══ BANDERA ENCENDIDA · RxLevelCard y RxSelect (P6) ══');
const PROHIBIDO_RX=[/\$\s?\d/,/XX\.XXX/,/[ÚU]ltimo cupo/i,/Siempre hay cupo/i,/\bkit\b/i,/Preparado/i,/cupos en tu franja/i,/Plan B/,/24\/7/,/Carlos Mej/,/Juliana/,/AV9525/,/b[áa]sico/i,/pantuflas/i,/te avisamos apenas/i];
const limpioRx=(nombre,h)=>{ const malo=PROHIBIDO_RX.find(re=>re.test(h)); t(nombre+' · sin textos prohibidos', !malo, malo && ('apareció '+malo)); };
async function bootRx(settings){
  const d=new JSDOM(readFileSync(APP+'index.html','utf8'),{runScripts:'outside-only',pretendToBeVisual:true,url:'http://localhost/'});
  const w=d.window; const errs=[]; w.console.error=(...a)=>errs.push(a.map(String).join(' '));
  w.RENDIO_CONFIG={OTP_LENGTH:8}; w.toast=()=>{}; w.L=undefined;
  w.escapeHtml=(s)=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  w.localStorage.setItem('rendio.aux.rx','1'); w.localStorage.setItem('rendio.aux.onboarded.p1','1');
  const io={busy:false,cupos:0,prefs:[],prefOk:true,header:{airlineName:'Avianca',joinedAt:'2026-03-14',preferredLevel:null,meetingPoint:''}};
  w.Api={ listMyReservations:async()=>[], listResidences:async()=>RES, getMyAuxiliarPlace:async()=>UNA, saveMyResidence:async()=>true,
    createReservation:async()=>'r1', getSettings:async()=>w.state.settings, getMyAuxHeader:async()=>io.header,
    privateBusyAt:async()=>{io.cupos++;return io.busy;}, notesUser:(n)=>String(n||'') };
  w.ApiAux={ listMyTrips:async()=>null, saveMyPrefs:async(p)=>{io.prefs.push(p); if(io.prefOk instanceof Error) throw io.prefOk; return io.prefOk;} };
  w.state={settings:settings}; 
  for(const f of ['aux-rx-ui.js','aux-shell.js','aux-residencias.js','aux-privado.js','aux-presentacion.js','auxiliar.js']) w.eval(readFileSync(APP+f,'utf8'));
  const A=w.Auxiliar, AS=w.AuxShell, P=w.AuxPrivado;
  // El 'book' mínimo (lo que P5 pone en el paso del nivel y en revisar).
  AS.register('book',{ render:()=>{ const k=A.stepKind(); const f=A.state.form;
    const body=k==='nivel'?P.levelsHTML(f,{mode:'book'}):k==='revisar'?P.sumHTML(f):`<i class="fk-step">${k}</i>`;
    return `<div class="rx-scr"><div class="rx-body"><div class="rx-step fwd">${body}</div></div></div>`; } });
  await A.init({id:'p1',full_name:'Ana Lucía Restrepo Vélez',role:'auxiliar',is_active:true}); await wait(60);
  const ui=()=>w.document.getElementById('auxiliar-ui');
  return {w,A,AS,P,io,errs,ui,q:(s)=>ui().querySelector(s),qa:(s)=>[...ui().querySelectorAll(s)]};
}
const ON={aux_private_enabled:true,aux_private_vehicle_id:'v1',aux_private_price_cop:150000,aux_min_lead_hours:6,aux_wait_minutes:5};
{
  const R=await bootRx({...ON});
  const {w,A,AS,P,io,q,qa}=R;
  t('la bandera está encendida y el shell pinta (#auxiliar-ui.rx-phone)', AS.on() && R.ui().classList.contains('rx-phone'));
  t('Select quedó registrado por aux-privado.js', AS.registered('select'));
  t('AuxPrivado expone el contrato nuevo', ['levelsHTML','syncLevels','selectHTML','teaserHTML'].every(k=>typeof P[k]==='function'));
  t('INCLUYE[2] = «En silencio si quieres · Lo pides al hacer el pedido y tu conductor lo ve en su ruta»',
    P.INCLUYE[2].t==='En silencio si quieres' && P.INCLUYE[2].d==='Lo pides al hacer el pedido y tu conductor lo ve en su ruta.', JSON.stringify(P.INCLUYE[2]));

  console.log('\n── el paso del nivel: tres RxLevelCard ──');
  q('[data-ax="new"]').click(); await wait(40);
  Object.assign(A.state.form,{type:'sal',date:'2026-12-20',time:'05:10'});
  A.goStep('nivel'); A.rerender(); await wait(40);
  t('el pedido va en .rx-layer[data-scr=book] y está en el nivel', !!q('.rx-layer[data-scr="book"]') && A.stepKind()==='nivel');
  t('se preguntó el cupo (una vez) y está libre', io.cupos===1 && P.cupo()==='libre');
  const cards=qa('[data-scr="book"] .rx-lvls > .rx-lv');
  t('tres tarjetas .rx-lv.rx-in con --d 0,1,2 (entrada escalonada del diseño)', cards.length===3 && cards.every(c=>c.classList.contains('rx-in')) && cards.map(c=>c.style.getPropertyValue('--d')).join()==='0,1,2', cards.map(c=>c.getAttribute('style')).join('|'));
  const [csh,cdi,cvip]=cards;
  t('marcado de RxLevelCard: ic t-tono · tx(h b+em, t, inc, f) · radio <i>', cards.every(c=>c.querySelector(':scope > .rx-lv-ic') && c.querySelector(':scope > .rx-lv-tx > .rx-lv-h > b') && c.querySelector('.rx-lv-h > em') && c.querySelector(':scope > .rx-lv-tx > .rx-lv-t') && c.querySelector(':scope > .rx-lv-tx > .rx-lv-inc') && c.querySelector(':scope > .rx-radio > i')) && csh.querySelector('.rx-lv-ic').classList.contains('t-a2h') && cdi.querySelector('.rx-lv-ic').classList.contains('t-h2a') && cvip.querySelector('.rx-lv-ic').classList.contains('t-plus'));
  t('íconos del sprite rx (Users, ArrowRight, Sparkle) y chulos Check 13', /#rx-Users/.test(csh.innerHTML) && /#rx-ArrowRight/.test(cdi.innerHTML) && /#rx-Sparkle/.test(cvip.innerHTML) && csh.querySelectorAll('.rx-lv-inc use[href="#rx-Check"]').length===2);
  t('Compartido: «Incluido», elegido (.on), data-ax=lvl, SIN píldora de cupo (D5)', csh.querySelector('.rx-lv-h b').textContent==='Compartido' && csh.querySelector('em').textContent==='Incluido' && csh.classList.contains('on') && csh.dataset.ax==='lvl' && csh.dataset.v==='shared' && !csh.querySelector('.rx-cupo'));
  t('Directo: clase off, SIN lvl ni acción, «Pronto», aria-disabled', cdi.classList.contains('off') && !cdi.hasAttribute('data-ax') && !cdi.hasAttribute('data-rx') && cdi.querySelector('em').textContent==='Pronto' && cdi.getAttribute('aria-disabled')==='true');
  t('Privado · Select: vip, «Con costo» + «Coordinación te confirma la tarifa», sin cifra', cvip.classList.contains('vip') && cvip.querySelector('.rx-lv-h b').textContent==='Privado · Select' && cvip.querySelector('em').textContent==='Con costo' && cvip.querySelector('.rx-lv-pn').textContent==='Coordinación te confirma la tarifa' && !/\d{3}/.test(cvip.textContent));
  t('los pilares de INCLUYE en la tarjeta (sin kit)', P.INCLUYE.every(x=>cvip.textContent.includes(x.t)) && !/kit/i.test(cvip.textContent));
  t('su píldora dice lo que se sabe: «Disponible a esa hora» (verde, sin low)', cvip.querySelector('.rx-cupo').textContent==='Disponible a esa hora' && !cvip.querySelector('.rx-cupo').classList.contains('low'));
  t('«Ver qué incluye» es span.rx-lv-more con data-ax=lvl-info', cvip.querySelector('.rx-lv-f > span.rx-lv-more[data-ax="lvl-info"]')?.textContent==='Ver qué incluye');
  t('dentro de los <button> no hay <div>', cards.every(c=>c.querySelectorAll('div').length===0));
  t('debajo, sin interruptor de silencio ni nota del compartido (esa la pone P5: sharedNoteText)', !q('[data-key="quietRide"]') && !/Compartido va con/.test(q('.rx-lvls-x').textContent) && P.sharedNoteText()==='Compartido va con tu tripulación y no tiene costo.');
  t('cada tarjeta y bloque lleva data-rx-key (el parche por key de P5)', cards.map(c=>c.getAttribute('data-rx-key')).join()==='lv:shared,lv:direct,lv:private');
  limpioRx('nivel (compartido)', q('[data-scr="book"]').innerHTML);

  console.log('\n── elegir ──');
  cdi.click(); await wait(20);
  t('tocar Directo no hace nada', A.state.form.level==='shared');
  q('.rx-lv.vip').click(); await wait(30);
  t('tocar Privado lo elige (lvl de auxiliar.js)', A.state.form.level==='private' && A.state.form.levelAuto===false);
  t('la tarjeta privada queda .on y la compartida no', q('.rx-lv.vip').classList.contains('on') && !q('.rx-lv[data-v="shared"]').classList.contains('on'));
  const tg=q('[data-scr="book"] .rx-lv-quiet [data-ax="toggle"][data-key="quietRide"]');
  t('aparece «Prefiero silencio» (D4) con el interruptor rx-tg', !!tg && tg.classList.contains('rx-tg') && /Prefiero silencio/.test(q('.rx-lv-quiet').textContent) && /Tu conductor lo ve en su ruta/.test(q('.rx-lv-quiet').textContent));
  t('…en una rx-card .rx-in --d 3 con key «quiet» y la fila rx-set tg:quietRide', q('.rx-lv-quiet').classList.contains('rx-in') && q('.rx-lv-quiet').style.getPropertyValue('--d')==='3' && q('.rx-lv-quiet').dataset.rxKey==='quiet' && !!q('.rx-lv-quiet > .rx-set[data-rx-key="tg:quietRide"]'));
  t('y la nota «Lo tiene que aprobar coordinación»', /Lo tiene que aprobar coordinación\./.test(q('.rx-lvls-x').textContent));
  tg.click(); await wait(20);
  t('el interruptor escribe form.quietRide (toggle del pedido)', A.state.form.quietRide===true && q('[data-key="quietRide"]').classList.contains('on'));
  limpioRx('nivel (privado)', q('[data-scr="book"]').innerHTML);
  A.goStep('revisar'); A.rerender(); await wait(20);
  const sum=q('.rx-sel-sum');
  t('revisar: franja Select rx, sin cifra, con el silencio pedido', !!sum && /Rendio Select/.test(sum.textContent) && /Coordinación confirma la camioneta y la tarifa · no se cobra en la app/.test(sum.textContent) && /Pediste silencio/.test(sum.textContent) && !/\d/.test(sum.textContent));
  A.goStep('nivel'); A.rerender(); await wait(20);
  q('.rx-lv[data-v="shared"]').click(); await wait(20);
  t('volver a Compartido apaga el silencio', A.state.form.level==='shared' && A.state.form.quietRide===false && !q('[data-key="quietRide"]'));

  console.log('\n── syncLevels: elegir sin recrear las tarjetas (transición del radio) ──');
  const antes=qa('[data-scr="book"] .rx-lvls > .rx-lv'); const radio=antes[2].querySelector('.rx-radio i');
  A.state.form.level='private';
  const okSync=P.syncLevels(q('[data-scr="book"]'),A.state.form);
  const despues=qa('[data-scr="book"] .rx-lvls > .rx-lv');
  t('devuelve true y deja los MISMOS nodos (tarjetas y <i> del radio)', okSync && despues.every((c,i)=>c===antes[i]) && despues[2].querySelector('.rx-radio i')===radio);
  t('…con las clases y aria al día', despues[2].classList.contains('on') && despues[2].getAttribute('aria-pressed')==='true' && !despues[0].classList.contains('on') && despues[0].getAttribute('aria-pressed')==='false');
  t('…y el interruptor del silencio aparece, montado y animando (.rx-anim, como un hijo nuevo en React)', !!q('[data-scr="book"] [data-key="quietRide"]') && q('.rx-lv-quiet').classList.contains('rx-anim'));
  const tg2=q('[data-key="quietRide"]'); A.state.form.quietRide=true; P.syncLevels(q('[data-scr="book"]'),A.state.form);
  t('cambiar solo el silencio mueve el MISMO interruptor', q('[data-key="quietRide"]')===tg2 && tg2.classList.contains('on'));
  t('sin el paso pintado devuelve false (se repinta como siempre)', P.syncLevels(w.document.createElement('div'),A.state.form)===false);
  A.state.form.level='shared'; A.state.form.quietRide=false; A.rerender(); await wait(20);

  console.log('\n── Select desde el pedido (lvl-info → lvl-close / lvl-choose) ──');
  q('.rx-lv.vip [data-ax="lvl-info"]').click(); await wait(30);
  const sel=q('.rx-layer[data-scr="select"]');
  t('«Ver qué incluye» apila Select sobre el pedido sin cambiar el nivel', A.state.view==='privado' && !!sel && A.state.form.level==='shared' && !!q('.rx-layer[data-scr="book"]'));
  t('pantalla oscura (data-top-dark) con el marcado de RxSelect', q('.rx-app')?.getAttribute('data-top-dark')==='1' && !!sel.querySelector('.rx-scr.rx-sel > .rx-sel-top > .rx-ib.glass.dk') && !!sel.querySelector('.rx-body.sel > .rx-sel-hero > .rx-sel-e') && sel.querySelector('.rx-sel-hero h1')?.textContent==='Select');
  t('párrafo honesto de la salida', /directo al aeropuerto, sin paradas en el camino/.test(sel.querySelector('.rx-sel-hero p').textContent));
  const pil=[...sel.querySelectorAll('.rx-sel-pil > div')];
  t('pilares desde INCLUYE con romanos y .rx-in --d 0..3', pil.length===P.INCLUYE.length && pil.map(p=>p.querySelector('em').textContent).join()==='I,II,III,IV' && pil.every((p,i)=>p.classList.contains('rx-in') && p.style.getPropertyValue('--d')===String(i) && p.querySelector('b').textContent===P.INCLUYE[i].t && p.querySelector('span').textContent===P.INCLUYE[i].d));
  t('SIN kit a bordo; en su lugar «Cómo funciona» (.rx-in --d 4)', !sel.querySelector('.rx-sel-kit') && sel.querySelector('.rx-sel-how.rx-in')?.style.getPropertyValue('--d')==='4' && /Tiene costo\. Coordinación te confirma la tarifa/.test(sel.textContent));
  t('la nota del compartido', sel.querySelector('.rx-sel-note')?.textContent==='Tu viaje compartido sigue igual. Select es una opción, no un reemplazo.');
  t('pie: disponibilidad + «Pedir en privado» (rx-btn brass, lvl-choose)', sel.querySelector('.rx-foot.sel > .rx-cupo')?.textContent==='Disponible a esa hora' && sel.querySelector('.rx-foot.sel > .rx-btn.brass[data-ax="lvl-choose"]')?.textContent==='Pedir en privado');
  t('cerrar desde el pedido es lvl-close (no rx-pop)', sel.querySelector('.rx-sel-top [data-ax="lvl-close"]') && !sel.querySelector('.rx-sel-top [data-rx="rx-pop"]'));
  limpioRx('Select (pedido)', sel.innerHTML);
  sel.querySelector('[data-ax="lvl-close"]').click(); await wait(30);
  t('lvl-close vuelve al pedido (Select sale con .out) sin tocar el nivel', A.state.view==='form' && sel.classList.contains('out') && A.state.form.level==='shared');
  await wait(300);
  q('.rx-lv.vip [data-ax="lvl-info"]').click(); await wait(30);
  q('.rx-layer[data-scr="select"] [data-ax="lvl-choose"]').click(); await wait(30);
  t('«Pedir en privado» elige el privado y vuelve al paso', A.state.form.level==='private' && A.state.view==='form' && A.stepKind()==='nivel' && q('.rx-lv.vip').classList.contains('on'));
  t('sin volver a preguntar el cupo (misma hora)', io.cupos===1, 'veces '+io.cupos);
  await wait(300);

  console.log('\n── camioneta comprometida ──');
  io.busy=true; P.resetCupo(); await P.askCupo('2026-12-20T05:10'); await wait(30);
  A.state.form.level='shared'; A.rerender(); await wait(20);
  const off=q('.rx-lv.vip');
  t('la privada queda .off + aria-disabled (nunca disabled) y la píldora «Comprometida a esa hora» low', off.classList.contains('off') && off.getAttribute('aria-disabled')==='true' && !off.hasAttribute('disabled') && off.querySelector('.rx-cupo').textContent==='Comprometida a esa hora' && off.querySelector('.rx-cupo').classList.contains('low'));
  off.click(); await wait(20);
  t('tocarla no la elige', A.state.form.level==='shared');
  off.querySelector('[data-ax="lvl-info"]').click(); await wait(30);
  const selOff=q('.rx-layer[data-scr="select"]:not(.out)');
  t('pero «Ver qué incluye» abre Select, con el botón apagado y dicho', A.state.view==='privado' && selOff && selOff.querySelector('[data-ax="lvl-choose"]').hasAttribute('disabled') && selOff.querySelector('[data-ax="lvl-choose"]').textContent==='Comprometida a esa hora');
  selOff.querySelector('[data-ax="lvl-choose"]').click(); await wait(20);
  t('y tocarlo no elige nada', A.state.form.level==='shared' && A.state.view==='privado');
  selOff.querySelector('[data-ax="lvl-close"]').click(); await wait(300);
  io.busy=false; P.resetCupo(); w.Api.privateBusyAt=async()=>{throw new Error('caído');}; await P.askCupo('2026-12-20T05:10'); await wait(30);
  t('sin respuesta: «Sin confirmar la hora» (low) y la nota de que no se pudo confirmar', q('.rx-lv.vip .rx-cupo')?.textContent==='Sin confirmar la hora' && q('.rx-lv.vip .rx-cupo').classList.contains('low') && /No pudimos confirmar/.test(q('.rx-lvls-x').textContent));

  console.log('\n── Select desde Inicio (open-select → rx-pop / select-pref) ──');
  AS.popAll(); A.state.view='home'; A.rerender(); await wait(30);
  const hook=w.document.createElement('button'); hook.setAttribute('data-rx','open-select'); hook.setAttribute('data-from','home'); q('.rx-tabview').appendChild(hook);
  hook.click(); await wait(30);
  const sh=q('.rx-layer[data-scr="select"]');
  t('open-select empuja Select con from=home', !!sh && AS.current().id==='select' && sh.querySelector('.rx-sel')?.dataset.from==='home');
  t('cerrar es rx-pop (no lvl-close)', !!sh.querySelector('.rx-sel-top [data-rx="rx-pop"]') && !sh.querySelector('[data-ax="lvl-close"]'));
  t('párrafo sin viaje: «directo a tu destino»', /directo a tu destino/.test(sh.querySelector('.rx-sel-hero p').textContent));
  const quiero=sh.querySelector('.rx-foot.sel [data-rx="select-pref"]');
  t('pie: «Quiero mi próximo traslado en Select» (brass) + «Sujeto a disponibilidad»', quiero?.textContent==='Quiero mi próximo traslado en Select' && quiero.classList.contains('brass') && !quiero.disabled && sh.querySelector('.rx-foot.sel .rx-cupo').textContent==='Sujeto a disponibilidad');
  limpioRx('Select (inicio)', sh.innerHTML);
  quiero.click(); await wait(40);
  t('guarda preferredLevel=private con ApiAux.saveMyPrefs', io.prefs.length===1 && io.prefs[0].preferredLevel==='private' && Object.keys(io.prefs[0]).join()==='preferredLevel');
  t('actualiza el header, hace pop y avisa', A.header.preferredLevel==='private' && sh.classList.contains('out') && /Tu próximo pedido arranca en Privado/.test(q('.rx-toast')?.textContent||''));
  await wait(300);
  hook.click(); await wait(30);
  const sh2=q('.rx-layer[data-scr="select"]:not(.out)');
  t('con Select ya preferido, el botón queda apagado y lo dice', sh2.querySelector('[data-rx="select-pref"]').disabled && sh2.querySelector('.rx-foot.sel .rx-cupo').textContent==='Select ya es tu nivel preferido');
  sh2.querySelector('[data-rx="rx-pop"]').click(); await wait(300);
  t('rx-pop cierra Select', AS.current().id!=='select');
  A.header.preferredLevel=null; io.prefOk=null;
  hook.click(); await wait(30);
  const sh3=q('.rx-layer[data-scr="select"]:not(.out)');
  sh3.querySelector('[data-rx="select-pref"]').click(); await wait(40);
  t('si no se pudo guardar: se queda, reactiva el botón y lo dice', AS.current().id==='select' && !sh3.querySelector('[data-rx="select-pref"]').disabled && A.header.preferredLevel===null && /No pudimos guardar/.test(q('.rx-toast')?.textContent||''));
  AS.popAll(); await wait(30); io.prefOk=true;

  console.log('\n── hoja «Nivel preferido» (mode pref → pref-level) ──');
  const pref=P.levelsHTML(null,{mode:'pref'});
  t('mode pref: tarjetas con data-rx=pref-level, sin lvl ni «Ver qué incluye»', /data-rx="pref-level" data-v="shared"/.test(pref) && /data-rx="pref-level" data-v="private"/.test(pref) && !/data-ax="lvl"/.test(pref) && !/rx-lv-more/.test(pref) && !/rx-lvls-x/.test(pref));
  AS.sheet(`<div class="rx-sh"><h3>Nivel preferido</h3>${pref}</div>`);
  const pv=q('.rx-sheet .rx-lv[data-v="private"]');
  pv.click(); await wait(40);
  t('tocar Privado guarda preferredLevel=private y cierra la hoja', io.prefs.at(-1).preferredLevel==='private' && A.header.preferredLevel==='private' && (q('.rx-sheet-bg')?.classList.contains('out') || !q('.rx-sheet')));
  t('con el toast del diseño «Ahora pides en Privado»', /Ahora pides en Privado/.test(q('.rx-toast')?.textContent||''));
  await wait(260);
  const pref2=P.levelsHTML(null,{mode:'pref'});
  t('la hoja siguiente abre con Privado marcado', /rx-lv rx-in vip on/.test(pref2));

  console.log('\n── teaser, estado y etiqueta ──');
  const tz=P.teaserHTML();
  t('teaser: rx-select-teaser rx-in --d 4 con open-select, sin kit', /class="rx-select-teaser rx-in" style="--d:4" data-rx="open-select" data-from="home"/.test(tz) && !/kit/i.test(tz));
  const stw=P.statusHTML({level:'private',privateStatus:'requested',quiet:true});
  t('statusHTML rx: .rx-sel-st.wait con el silencio', /rx-sel-st wait/.test(stw) && /Pediste silencio/.test(stw));
  t('statusHTML rechazado con el motivo, escapado', /rx-sel-st no/.test(P.statusHTML({level:'private',privateStatus:'rejected',privateReason:'<b>x</b>'})) && /&lt;b&gt;x/.test(P.statusHTML({level:'private',privateStatus:'rejected',privateReason:'<b>x</b>'})));
  t('chipHTML rx: .rx-sel-chip', /rx-sel-chip ok/.test(P.chipHTML({level:'private',privateStatus:'approved'})) && P.chipHTML({level:'shared'})==='');
  t('stepHTML/introHTML con la bandera = el marcado nuevo', /rx-lvls/.test(P.stepHTML({level:'shared'})) && /rx-sel/.test(P.introHTML({type:'lle'})) && /directo a tu casa/.test(P.introHTML({type:'lle'})));
  t('sin errores en consola', R.errs.length===0, R.errs.join(' | '));
}
{
  console.log('\n── bandera encendida · PRIMICIA (sin privado en Ajustes) ──');
  const R=await bootRx({aux_min_lead_hours:6,aux_wait_minutes:5});
  const {A,AS,P,io,q}=R;
  q('[data-ax="new"]').click(); await wait(40);
  Object.assign(A.state.form,{type:'lle',date:'2026-12-20',time:'23:10'});
  A.goStep('nivel'); A.rerender(); await wait(30);
  const v=q('.rx-lv.vip');
  t('primicia: .rx-lv.vip.primicia, sin data-ax=lvl, «Pronto», aria-disabled', v.classList.contains('primicia') && v.dataset.ax!=='lvl' && v.querySelector('em').textContent==='Pronto' && v.getAttribute('aria-disabled')==='true' && v.querySelector('.rx-cupo.off')?.textContent==='Todavía no se puede pedir');
  t('no se preguntó el cupo', io.cupos===0);
  v.querySelector('.rx-radio').click(); await wait(30);
  t('primicia no elegible: tocarla abre Select y el nivel sigue en compartido', A.state.form.level==='shared' && A.state.view==='privado');
  const sel=q('.rx-layer[data-scr="select"]');
  t('Select en primicia: botón apagado «Muy pronto» y el bloque «Muy pronto»', sel.querySelector('[data-ax="lvl-choose"]').disabled && sel.querySelector('[data-ax="lvl-choose"]').textContent==='Muy pronto' && /Todavía no se puede pedir: estamos terminando de montarlo/.test(sel.textContent) && /directo a tu casa/.test(sel.textContent));
  limpioRx('Select (primicia)', sel.innerHTML);
  sel.querySelector('[data-ax="lvl-close"]').click(); await wait(300);
  t('la nota de primicia en el paso', /El privado todavía no está disponible/.test(q('.rx-lvls-x').textContent));
  AS.popAll(); A.state.view='home'; A.rerender(); await wait(30);
  AS.push('select',{from:'me'}); await wait(30);
  const s2=q('.rx-layer[data-scr="select"]');
  t('desde Perfil en primicia: «Quiero mi próximo traslado en Select» APAGADO', s2.querySelector('[data-rx="select-pref"]').disabled && s2.querySelector('.rx-foot.sel .rx-cupo.off'));
  s2.querySelector('[data-rx="select-pref"]').removeAttribute('disabled'); s2.querySelector('[data-rx="select-pref"]').click(); await wait(30);
  t('y aunque se forzara el toque, no guarda nada (solo con enabled())', io.prefs.length===0);
  const pref=P.levelsHTML(null,{mode:'pref'});
  t('hoja de preferencia en primicia: Privado sin pref-level', !/data-rx="pref-level" data-v="private"/.test(pref) && /data-rx="pref-level" data-v="shared"/.test(pref));
  limpioRx('nivel (primicia)', P.levelsHTML({level:'private'},{mode:'book'}));
  t('sin errores en consola', R.errs.length===0, R.errs.join(' | '));
}

console.log(`\n${ok}/${ok+bad} pasaron${bad?' · '+bad+' FALLARON':''}`);
console.log('NO cubierto: colores, degradados, la serif y el layout de las tarjetas y la portada (jsdom no pinta) — se mira en el teléfono, de día y de noche.');
console.log('NO cubierto (bandera encendida): que .rx-in / .rx-sel-hero corran de verdad, la transición del radio y del borde, el deslizamiento de la capa (jsdom no anima);');
console.log('el pedido de P5 aquí es un «book» mínimo: la integración con aux-rx-pedir.js la prueba P5.');
process.exit(bad?1:0);
