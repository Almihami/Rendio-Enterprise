// E2E del módulo Repuestos (0069) como usuario REAL (anon key + sesión),
// para validar RLS + RPCs + vistas con el mismo camino que hace el front.
import { createClient } from '@supabase/supabase-js';
const DEV='lxlphbafhtphulanhzlp';
if(!(process.env.SUPABASE_URL||'').includes(DEV)){console.error('ABORTA: no es dev');process.exit(2);}
const svc=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const admin=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_ANON_KEY,{auth:{persistSession:false}});
const {error:eL}=await admin.auth.signInWithPassword({email:'demo-admin@rendio.demo',password:'DemoRendio2026!'});
if(eL){console.error('login admin:',eL.message);process.exit(1);}
let pass=0,fail=0;
const ok=(c,m)=>{console.log(`  ${c?'✓':'✗'} ${m}`);c?pass++:fail++;};

// Limpieza: el test debe poder correrse las veces que haga falta.
await svc.from('maintenance').delete().not('part_id','is',null);
await svc.from('vehicle_part_state').delete().not('id','is',null);
await svc.from('part_catalog').update({interval_km:6500}).eq('code','aceite');
await svc.from('part_catalog').update({interval_km:27500}).eq('code','past-del');
const {data:vehs}=await svc.from('vehicles').select('id,internal_code,current_km').is('deleted_at',null).order('internal_code');
const V=vehs[0];
console.log(`\nCarro de prueba: ${V.internal_code} · odómetro ${V.current_km} km`);

// ---- 1. El admin ve el catálogo y el semáforo (RLS) ----
console.log('\n1) Lectura del admin');
const {data:cat,error:eC}=await admin.from('part_catalog').select('code,name,interval_km,is_critical').eq('is_active',true);
ok(!eC&&cat.length===25,`catálogo visible: ${cat?.length} repuestos`);
const {data:st0,error:eS}=await admin.from('v_vehicle_part_status').select('*');
ok(!eS&&st0.length>0,`semáforo visible: ${st0?.length} filas`);
ok(st0.every(s=>s.light==='nodata'),'sin carga inicial, TODO es "sin dato" (no finge estar al día)');

// ---- 2. Carga inicial del jefe ----
console.log('\n2) Carga inicial (el jefe llena los km una vez)');
const odo=V.current_km;
const entries=[
  {part_code:'aceite',    last_change_km:odo-6000, last_change_at:'2026-06-20'},  // por vencer
  {part_code:'past-del',  last_change_km:odo-28000,last_change_at:'2026-01-10'},  // vencido (crítico)
  {part_code:'llantas',   last_change_km:odo-10000,last_change_at:'2026-03-01'},  // al día
  {part_code:'liq-fre',   last_change_km:odo-1000, last_change_at:'2024-06-01'},  // vencido POR TIEMPO
  {part_code:'rotacion',  last_change_km:null},                                   // el jefe no sabe
];
const {data:bl,error:eB}=await admin.rpc('set_vehicle_part_baseline',{p_vehicle_id:V.id,p_entries:entries});
ok(!eB&&bl?.ok,`baseline guardado: ${bl?.parts} repuestos`);

const {data:st1}=await admin.from('v_vehicle_part_status').select('*').eq('vehicle_id',V.id);
const g=c=>st1.find(s=>s.part_code===c);
ok(g('past-del').light==='red',`pastillas delanteras → vencido (${g('past-del').km_since} km de ${g('past-del').interval_km})`);
ok(g('aceite').light==='amber',`aceite → por vencer (quedan ${g('aceite').km_until} km)`);
ok(g('llantas').light==='green','llantas → al día');
ok(g('liq-fre').light==='red',`líquido de frenos → vencido POR TIEMPO (${g('liq-fre').months_since} meses, límite 18)`);
ok(g('rotacion').light==='nodata','rotación → sigue sin dato porque el jefe no lo sabía');

// ---- 3. No se acepta un km imposible ----
console.log('\n3) El dato imposible se rechaza');
const {error:eBad}=await admin.rpc('set_vehicle_part_baseline',{p_vehicle_id:V.id,p_entries:[{part_code:'bujes',last_change_km:odo+50000}]});
ok(eBad&&/KM_GT_ODOMETER/.test(eBad.message),'km mayor al odómetro → rechazado');

// ---- 4. El vehículo NO se bloquea (regla nueva) ----
console.log('\n4) Ningún repuesto detiene el carro');
const {data:vAfter}=await svc.from('vehicles').select('status').eq('id',V.id).single();
ok(vAfter.status!=='blocked',`el carro sigue operable con 2 críticos vencidos (status: ${vAfter.status})`);

// ---- 5. Registrar el cambio: se mide la duración real ----
console.log('\n5) Registrar el cambio');
const {data:rc,error:eR}=await admin.rpc('register_part_change',{
  p_vehicle_id:V.id,p_part_code:'past-del',p_km:odo,p_date:'2026-08-17',
  p_cost:210000,p_shop:'Taller Central',p_notes:'Cambio por desgaste'});
ok(!eR&&rc?.ok,`cambio registrado (${rc?.status})`);
ok(rc?.duration_km===28000,`duración real medida: ${rc?.duration_km} km contra el intervalo de 27.500`);
const {data:st2}=await admin.from('v_vehicle_part_status').select('*').eq('vehicle_id',V.id).eq('part_code','past-del').single();
ok(st2.light==='green'&&st2.km_since===0,'el semáforo de esa pieza volvió a cero');

// ---- 6. El conductor reporta: queda pendiente ----
console.log('\n6) El conductor reporta un cambio');
const drv=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_ANON_KEY,{auth:{persistSession:false}});
const {error:eD}=await drv.auth.signInWithPassword({email:'demo-conductor@rendio.demo',password:'DemoRendio2026!'});
if(eD){ok(false,'login conductor: '+eD.message);}
else{
  const {data:dr,error:eDR}=await drv.rpc('register_part_change',{p_vehicle_id:V.id,p_part_code:'f-aire',p_km:odo,p_date:'2026-08-17',p_cost:74000,p_shop:'Lubricentro',p_notes:'Lo cambié hoy'});
  ok(!eDR&&dr?.status==='pending',`el conductor reporta y queda PENDIENTE (${dr?.status})`);
  const {data:stP}=await admin.from('v_vehicle_part_status').select('light').eq('vehicle_id',V.id).eq('part_code','f-aire').single();
  ok(stP.light==='nodata','el reporte del conductor NO movió el semáforo todavía');
  const {data:pend}=await admin.from('maintenance').select('id').eq('status','pending');
  const {data:cf,error:eCF}=await admin.rpc('confirm_part_change',{p_maintenance_id:pend[0].id,p_accept:true});
  ok(!eCF&&cf?.status==='confirmed','el admin lo confirma');
  const {data:stC}=await admin.from('v_vehicle_part_status').select('light,km_since').eq('vehicle_id',V.id).eq('part_code','f-aire').single();
  ok(stC.light==='green','ahora sí se movió el semáforo');
}

// ---- 7. Vida real: exige 3 cambios ----
console.log('\n7) Vida real');
const {data:rl1}=await admin.from('v_part_real_life').select('*').eq('part_code','past-del').maybeSingle();
ok(rl1&&rl1.n===1&&rl1.is_reliable===false,`pastillas con n=1 → NO confiable todavía (honesto)`);
for(const km of [odo+26000,odo+52000]){
  await admin.rpc('register_part_change',{p_vehicle_id:V.id,p_part_code:'past-del',p_km:km,p_date:'2026-08-17',p_cost:205000,p_shop:'Taller Central'});
}
const {data:rl2}=await admin.from('v_part_real_life').select('*').eq('part_code','past-del').single();
ok(rl2.n===3&&rl2.is_reliable===true,`con 3 cambios ya promedia: ${rl2.avg_km} km (n=${rl2.n})`);

// ---- 8. Intervalos: global y excepción por carro ----
console.log('\n8) Intervalos');
const {error:eI}=await admin.rpc('set_part_interval',{p_part_code:'aceite',p_interval_km:7000,p_vehicle_id:null});
const {data:cAll}=await admin.from('v_vehicle_part_status').select('interval_km').eq('part_code','aceite');
ok(!eI&&cAll.every(r=>r.interval_km===7000),'intervalo global aplicado a toda la flota');
await admin.rpc('set_part_interval',{p_part_code:'aceite',p_interval_km:5000,p_vehicle_id:V.id});
const {data:cOne}=await admin.from('v_vehicle_part_status').select('interval_km,has_override').eq('part_code','aceite').eq('vehicle_id',V.id).single();
ok(cOne.interval_km===5000&&cOne.has_override,'excepción por carro: este usa 5.000 y el resto 7.000');

// ---- 9. Corregir el odómetro ----
console.log('\n9) Corregir el odómetro');
const {data:co,error:eCo}=await admin.rpc('correct_vehicle_odometer',{p_vehicle_id:V.id,p_km:odo+100,p_reason:'Prueba'});
ok(!eCo&&co?.to===odo+100,`odómetro corregido ${co?.from} → ${co?.to}`);
const {data:aud}=await svc.from('audit_events').select('event_type').eq('event_type','vehicle_odometer_corrected').limit(1);
ok(aud.length===1,'quedó el registro en auditoría');

// ---- 10. Niveles preventivos ----
console.log('\n10) Niveles preventivos');
const {data:tiers,error:eT}=await admin.rpc('pending_inspection_tiers',{p_vehicle_id:V.id});
ok(!eT&&tiers.length>0,`niveles pendientes para este carro: ${tiers.map(t=>t.every_km).join(', ')}`);
const {data:items}=await admin.from('inspection_checklist_items').select('label').eq('tier_every_km',10000);
ok(items.length===4,`el nivel de 10.000 km aporta ${items.length} ítems al checklist del conductor`);

console.log(`\n${pass} ok · ${fail} fallos`);
process.exit(fail?1:0);
