// e2e de las consultas del FRONT (0075): las cadenas de select con embeds son
// donde se rompen las cosas en silencio, así que se prueban tal cual las manda
// api.js, con sesiones reales y RLS puesta.
const url=process.env.SUPABASE_URL, anon=process.env.SUPABASE_ANON_KEY, srv=process.env.SUPABASE_SERVICE_ROLE_KEY;
if(!url.includes('lxlphbafhtphulanhzlp')){console.error('ABORT: no es dev');process.exit(2);}
let ok=0,bad=0; const t=(n,c,d='')=>{if(c){ok++;console.log('  ✓ '+n)}else{bad++;console.log('  ✗ '+n+(d?' → '+d:''))}};
const H=(k,tok)=>({apikey:k,Authorization:'Bearer '+(tok||k),'Content-Type':'application/json'});
const get=(path,tok)=>fetch(url+'/rest/v1/'+path,{headers:H(anon,tok)});
const login=async(email,password)=>{
  const r=await fetch(url+'/auth/v1/token?grant_type=password',{method:'POST',headers:{apikey:anon,'Content-Type':'application/json'},body:JSON.stringify({email,password})});
  const j=await r.json(); return j.access_token;
};

console.log('\n── prepara un tripulante con dos unidades ──');
const email='front.'+Date.now()+'@rendio.co';
const g=await(await fetch(url+'/auth/v1/admin/generate_link',{method:'POST',headers:H(srv),
  body:JSON.stringify({type:'signup',email,password:'PruebaRendio2026!',data:{full_name:'Sofía Marcela Ossa Bedoya',pending_role:'auxiliar'}})})).json();
const v=await(await fetch(url+'/auth/v1/verify',{method:'POST',headers:{apikey:anon,'Content-Type':'application/json'},
  body:JSON.stringify({type:'signup',email,token:g.email_otp})})).json();
const tok=v.access_token, uid=v.user.id;
const cat=await(await fetch(url+'/rest/v1/rpc/signup_catalogs',{method:'POST',headers:H(anon,tok),body:'{}'})).json();
const r1=cat.residences[0], r2=cat.residences[7];
const alta=await(await fetch(url+'/rest/v1/rpc/register_auxiliar',{method:'POST',headers:H(anon,tok),
  body:JSON.stringify({p_full_name:'Sofía Marcela Ossa Bedoya',p_phone:'3123334455',
    p_airline_id:cat.airlines.find(a=>a.name==='Wingo').id,
    p_residence_id:r1.id,p_residence_unit:'Torre 1 · 501',
    p_residence_id_2:r2.id,p_residence_unit_2:'Casa 8'})})).json();
t('alta con dos unidades', alta.ok===true, JSON.stringify(alta).slice(0,120));

console.log('\n── Api.getMyAuxiliarPlace (auxiliar) ──');
const BASE='id, residence_id, home_address, home_latitude, home_longitude, residences!auxiliar_profiles_residence_id_fkey(id, name, sector, latitude, longitude)';
const sel=BASE+', residence_unit, residence_unit_2, residence_id_2, residencia2:residences!auxiliar_profiles_residence_id_2_fkey(id, name, sector, latitude, longitude)';
const pr=await get('auxiliar_profiles?select='+encodeURIComponent(sel)+'&profile_id=eq.'+uid,tok);
const pj=await pr.json();
t('el select con los dos embeds compila', pr.status===200, JSON.stringify(pj).slice(0,200));
const P=Array.isArray(pj)?pj[0]:null;
t('trae la unidad 1 con su conjunto', P?.residences?.name===r1.name && P?.residence_unit==='Torre 1 · 501');
t('trae la unidad 2 con su conjunto', P?.residencia2?.name===r2.name && P?.residence_unit_2==='Casa 8', JSON.stringify(P?.residencia2));
t('la unidad 2 trae coordenada (la necesita el mapa)', P?.residencia2?.latitude!=null);

console.log('\n── Api.createReservation con apartamento ──');
const apId=P.id;
const mk=async(resId,unit)=>{const r=await fetch(url+'/rest/v1/reservations',{method:'POST',headers:{...H(anon,tok),Prefer:'return=representation'},
  body:JSON.stringify({auxiliar_profile_id:apId,direction:'home_to_airport',status_h2a:'requested',
    required_arrival_at:new Date(Date.now()+2*86400000).toISOString(),residence_id:resId,...(unit?{residence_unit:unit}:{})})});
  const j=await r.json(); return Array.isArray(j)?j[0]:j;};
const res1=await mk(r2.id,'Casa 8');
t('la reserva guarda el apartamento elegido', res1?.residence_unit==='Casa 8', JSON.stringify(res1).slice(0,150));
t('y el pickup salió del conjunto de la unidad 2', res1?.pickup_address?.startsWith(r2.name), res1?.pickup_address);

console.log('\n── Api.listMyReservations (cadena nueva) ──');
const COLS='id, direction, pickup_address, pickup_latitude, pickup_longitude, required_arrival_at, status_h2a, status_a2h, notes, cancelled_at, rating, flights(flight_number)';
const lr=await get('reservations?select='+encodeURIComponent(COLS+', is_overnight, is_firm, ready_confirmed_at, cancellation_reason, residence_id, residence_unit, service_level, private_status, price_cop, private_reject_reason')+'&auxiliar_profile_id=eq.'+apId,tok);
const lj=await lr.json();
t('el select de mis viajes compila', lr.status===200, JSON.stringify(lj).slice(0,160));
t('y devuelve el apartamento', lj?.[0]?.residence_unit==='Casa 8');

console.log('\n── Api.listAuxiliares (admin) ──');
const atok=await login('demo-admin@rendio.demo','DemoRendio2026!');
t('el admin de dev sigue entrando', !!atok);
const ACOLS='id, profile_id, joined_at, airline_id, residence_unit, residence_unit_2, home_address, residence_id, residence_id_2, airlines(id, name), residences!auxiliar_profiles_residence_id_fkey(id, name, sector), res2:residences!auxiliar_profiles_residence_id_2_fkey(id, name, sector), profiles(id, full_name, email, phone, is_active, created_at)';
const ar=await get('auxiliar_profiles?select='+encodeURIComponent(ACOLS),atok);
const aj=await ar.json();
t('el padrón del admin compila', ar.status===200, JSON.stringify(aj).slice(0,220));
const mio=Array.isArray(aj)?aj.find(x=>x.profile_id===uid):null;
t('el admin ve al tripulante nuevo', !!mio);
t('con su aerolínea', mio?.airlines?.name==='Wingo');
t('con sus dos unidades', mio?.residences?.name===r1.name && mio?.res2?.name===r2.name);
t('con su teléfono', mio?.profiles?.phone==='3123334455');
t('y su fecha de ingreso', !!mio?.joined_at);

console.log('\n── el admin corrige la antigüedad ──');
const up=await fetch(url+'/rest/v1/auxiliar_profiles?id=eq.'+apId,{method:'PATCH',headers:{...H(anon,atok),Prefer:'return=representation'},body:JSON.stringify({joined_at:'2025-02-10'})});
const uj=await up.json();
t('el admin SÍ puede cambiar joined_at', uj?.[0]?.joined_at==='2025-02-10', JSON.stringify(uj).slice(0,140));

console.log('\n── Api.listAirlines / createAirline (admin) ──');
const al=await get('airlines?select=id,name,iata_code,sort_order,is_active&order=sort_order',atok);
const alj=await al.json();
t('el admin lista las aerolíneas', al.status===200 && alj.length>=4, JSON.stringify(alj).slice(0,160));
const org=(await(await get('profiles?select=organization_id&limit=1',atok)).json())[0]?.organization_id;
const ca=await fetch(url+'/rest/v1/airlines',{method:'POST',headers:{...H(anon,atok),Prefer:'return=representation'},
  body:JSON.stringify({organization_id:org,name:'Copa Airlines PRUEBA',iata_code:'CM',sort_order:100})});
const caj=await ca.json();
t('el admin puede agregar una aerolínea', ca.status===201, JSON.stringify(caj).slice(0,140));
const nuevaId=caj?.[0]?.id;

console.log('\n── el conductor ve el apartamento ──');
const DCOLS='id, direction, planned_start_at, status, route_stops(stop_order, reservation_id, reservations(pickup_address, pickup_latitude, pickup_longitude, required_arrival_at, notes, residence_unit, auxiliar_profiles(profiles(id, full_name, phone)), flights(flight_number)))';
const dtok=await login('demo-conductor@rendio.demo','DemoRendio2026!');
const dr=await get('route_assignments?select='+encodeURIComponent(DCOLS),dtok);
t('el select de la ruta del conductor compila', dr.status===200, (await dr.text()).slice(0,180));

console.log('\n── limpieza ──');
if(res1?.id) await fetch(url+'/rest/v1/reservations?id=eq.'+res1.id,{method:'DELETE',headers:H(srv)});
if(nuevaId) await fetch(url+'/rest/v1/airlines?id=eq.'+nuevaId,{method:'DELETE',headers:H(srv)});
await fetch(url+'/auth/v1/admin/users/'+uid,{method:'DELETE',headers:H(srv)});
const gone=await(await get('profiles?select=id&id=eq.'+uid,undefined)).json();
t('tripulante de prueba borrado', Array.isArray(gone)&&gone.length===0);

console.log(`\n${ok}/${ok+bad} pasaron${bad?' · '+bad+' FALLARON':''}`);
process.exit(bad?1:0);
