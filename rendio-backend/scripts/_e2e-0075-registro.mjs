// e2e del registro del tripulante (0075 + 0076) contra dev.
// Recorre el camino real: signup → código → catálogos → alta → pedido con unidad 2.
const url=process.env.SUPABASE_URL, anon=process.env.SUPABASE_ANON_KEY, srv=process.env.SUPABASE_SERVICE_ROLE_KEY;
if(!url.includes('lxlphbafhtphulanhzlp')){console.error('ABORT: no es dev');process.exit(2);}
let ok=0,bad=0; const t=(n,c,d='')=>{ if(c){ok++;console.log('  ✓ '+n)} else {bad++;console.log('  ✗ '+n+(d?' → '+d:''))} };
const H=(k,tok)=>({apikey:k,Authorization:'Bearer '+(tok||k),'Content-Type':'application/json'});
const rpc=(fn,body,tok)=>fetch(url+'/rest/v1/rpc/'+fn,{method:'POST',headers:H(anon,tok),body:JSON.stringify(body||{})});
const stamp=Date.now();
const email=`tcp.prueba.${stamp}@rendio.co`;

console.log('\n── 1. signUp + código de verificación ──');
const g=await(await fetch(url+'/auth/v1/admin/generate_link',{method:'POST',headers:H(srv),
  body:JSON.stringify({type:'signup',email,password:'PruebaRendio2026!',data:{full_name:'Ana Lucía Restrepo Vélez',pending_role:'auxiliar'}})})).json();
t('Supabase emite código de verificación', !!g.email_otp, JSON.stringify(g).slice(0,120));
const v=await(await fetch(url+'/auth/v1/verify',{method:'POST',headers:{apikey:anon,'Content-Type':'application/json'},
  body:JSON.stringify({type:'signup',email,token:g.email_otp})})).json();
const tok=v.access_token, uid=v.user?.id;
t('el código devuelve sesión', !!tok, v.msg||'');

console.log('\n── 2. sesión sin perfil: qué puede y qué no ──');
const resDirect=await(await fetch(url+'/rest/v1/residences?select=id,name,latitude&limit=3',{headers:H(anon,tok)})).json();
t('NO puede leer residences por RLS', Array.isArray(resDirect)&&resDirect.length===0, JSON.stringify(resDirect).slice(0,120));
const prof0=await(await fetch(url+'/rest/v1/profiles?select=id&id=eq.'+uid,{headers:H(anon,tok)})).json();
t('todavía no tiene perfil', Array.isArray(prof0)&&prof0.length===0);
const cat=await(await rpc('signup_catalogs',{},tok)).json();
t('signup_catalogs le da las 4 aerolíneas', cat.airlines?.length===4, JSON.stringify(cat.airlines||cat).slice(0,150));
t('signup_catalogs le da los conjuntos', (cat.residences?.length||0)>30, 'n='+(cat.residences?.length));
t('los conjuntos van SIN coordenadas', cat.residences?.every(r=>r.latitude===undefined&&r.longitude===undefined));

console.log('\n── 3. validaciones del alta ──');
const R=(b)=>rpc('register_auxiliar',b,tok).then(r=>r.json());
const base={p_full_name:'Ana Lucía Restrepo Vélez',p_phone:'3105557788',
  p_airline_id:cat.airlines?.find(a=>a.name==='JetSMART')?.id,
  p_residence_id:cat.residences?.[0]?.id,p_residence_unit:'Torre 3 · 302'};
let e=await R({...base,p_full_name:'Ana Restrepo'});
t('rechaza nombre incompleto (2 palabras)', /nombre completo/i.test(e.message||''), JSON.stringify(e).slice(0,110));
e=await R({...base,p_phone:'123'});
t('rechaza teléfono corto', /tel[ée]fono/i.test(e.message||''), JSON.stringify(e).slice(0,110));
e=await R({...base,p_residence_id:null});
t('rechaza sin conjunto ni pin', /recogemos/i.test(e.message||''), JSON.stringify(e).slice(0,110));
e=await R({...base,p_full_name:'Ana Lucía Restrepo <script>'});
t('rechaza caracteres raros en el nombre', /nombre completo/i.test(e.message||''), JSON.stringify(e).slice(0,110));

console.log('\n── 4. alta buena, con segunda unidad ──');
const res2=cat.residences?.[5];
const alta=await R({...base,p_residence_id_2:res2?.id,p_residence_unit_2:'Casa 12'});
t('el alta responde ok', alta.ok===true, JSON.stringify(alta).slice(0,140));
const prof=await(await fetch(url+'/rest/v1/profiles?select=id,role,full_name,email,phone,organization_id&id=eq.'+uid,{headers:H(anon,tok)})).json();
t('quedó con rol auxiliar', prof[0]?.role==='auxiliar');
t('el correo salió de auth, no del cliente', prof[0]?.email===email);
t('guardó el teléfono', prof[0]?.phone==='3105557788');
const ap=await(await fetch(url+'/rest/v1/auxiliar_profiles?select=id,joined_at,airline_id,residence_id,residence_unit,residence_id_2,residence_unit_2&profile_id=eq.'+uid,{headers:H(anon,tok)})).json();
t('estampó la fecha de ingreso de hoy', ap[0]?.joined_at===new Date().toLocaleDateString('en-CA',{timeZone:'America/Bogota'}), ap[0]?.joined_at);
t('guardó la aerolínea', !!ap[0]?.airline_id);
t('guardó la unidad 1', ap[0]?.residence_unit==='Torre 3 · 302');
t('guardó la unidad 2', ap[0]?.residence_id_2===res2?.id && ap[0]?.residence_unit_2==='Casa 12');
const dup=await R(base);
t('no deja registrarse dos veces', /ya está registrada/i.test(dup.message||''), JSON.stringify(dup).slice(0,110));

console.log('\n── 5. la fecha de ingreso no la toca el interesado ──');
const upd=await fetch(url+'/rest/v1/auxiliar_profiles?profile_id=eq.'+uid,{method:'PATCH',headers:{...H(anon,tok),Prefer:'return=representation'},body:JSON.stringify({joined_at:'2020-01-01'})});
const updj=await upd.json();
t('el tripulante NO puede cambiar joined_at', /administrador/i.test(JSON.stringify(updj)), JSON.stringify(updj).slice(0,140));
const upd2=await fetch(url+'/rest/v1/auxiliar_profiles?profile_id=eq.'+uid,{method:'PATCH',headers:{...H(anon,tok),Prefer:'return=representation'},body:JSON.stringify({residence_unit:'Torre 3 · 405'})});
t('pero SÍ puede corregir su apartamento', (await upd2.json())[0]?.residence_unit==='Torre 3 · 405');
const upd3=await fetch(url+'/rest/v1/auxiliar_profiles?profile_id=eq.'+uid,{method:'PATCH',headers:{...H(srv),Prefer:'return=representation'},body:JSON.stringify({joined_at:'2024-03-15'})});
t('el admin/servidor SÍ la corrige', (await upd3.json())[0]?.joined_at==='2024-03-15');

console.log('\n── 6. pedido desde la unidad 2 ──');
const apId=ap[0]?.id;
const mk=async(resId,unit)=>{const r=await fetch(url+'/rest/v1/reservations',{method:'POST',headers:{...H(anon,tok),Prefer:'return=representation'},
  body:JSON.stringify({auxiliar_profile_id:apId,direction:'home_to_airport',status_h2a:'requested',
    required_arrival_at:new Date(Date.now()+86400000).toISOString(),residence_id:resId,residence_unit:unit})}); return (await r.json())[0]||await r.json();};
const r1=await mk(cat.residences[0].id,null);
t('unidad 1: hereda el apto del perfil', r1.residence_unit==='Torre 3 · 405', JSON.stringify(r1).slice(0,140));
t('unidad 1: el trigger puso la coordenada', r1.pickup_latitude!=null && r1.pickup_longitude!=null);
const r2=await mk(res2.id,null);
t('unidad 2: hereda el apto de la SEGUNDA unidad, no el de la primera', r2.residence_unit==='Casa 12', 'quedó: '+r2.residence_unit);
t('unidad 2: la coordenada es la del otro conjunto', r2.pickup_latitude!==r1.pickup_latitude, r1.pickup_latitude+' vs '+r2.pickup_latitude);
const r3=await mk(cat.residences[0].id,'Apto 901 (invitado)');
t('un apto explícito en el pedido gana sobre el del perfil', r3.residence_unit==='Apto 901 (invitado)');

console.log('\n── limpieza ──');
for(const r of [r1,r2,r3]) if(r?.id) await fetch(url+'/rest/v1/reservations?id=eq.'+r.id,{method:'DELETE',headers:H(srv)});
await fetch(url+'/auth/v1/admin/users/'+uid,{method:'DELETE',headers:H(srv)});
const gone=await(await fetch(url+'/rest/v1/profiles?select=id&id=eq.'+uid,{headers:H(srv)})).json();
t('usuario de prueba borrado', Array.isArray(gone)&&gone.length===0);

console.log(`\n${ok}/${ok+bad} pasaron${bad?' · '+bad+' FALLARON':''}`);
process.exit(bad?1:0);
