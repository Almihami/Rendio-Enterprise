// El registro tal como quedó: sin verificación de correo, exactamente las
// llamadas que hace el navegador (llave anónima, nada de service_role).
const url=process.env.SUPABASE_URL, anon=process.env.SUPABASE_ANON_KEY, srv=process.env.SUPABASE_SERVICE_ROLE_KEY;
if(!url.includes('lxlphbafhtphulanhzlp')){console.error('ABORT: no es dev');process.exit(2);}
let ok=0,bad=0; const t=(n,c,d='')=>{if(c){ok++;console.log('  ✓ '+n)}else{bad++;console.log('  ✗ '+n+(d?' → '+d:''))}};
const H=(k,tok)=>({apikey:k,Authorization:'Bearer '+(tok||k),'Content-Type':'application/json'});
const email='tcp.puerta.'+Date.now()+'@rendio.co';

console.log('\n── 1. signUp, tal cual lo llama la app ──');
const r=await fetch(url+'/auth/v1/signup',{method:'POST',headers:{apikey:anon,'Content-Type':'application/json'},
  body:JSON.stringify({email,password:'MiClave2026',data:{full_name:'Ana Lucía Restrepo Vélez',phone:'3105557788',pending_role:'auxiliar'}})});
const j=await r.json();
t('el registro ya NO falla por el tope de correos', r.status===200, r.status+' '+(j.msg||j.error_description||''));
t('y devuelve sesión de una (sin código)', !!j.access_token, JSON.stringify(j).slice(0,140));
const tok=j.access_token, uid=j.user?.id;
t('el usuario queda con el correo confirmado', !!j.user?.email_confirmed_at, String(j.user?.email_confirmed_at));
t('conserva nombre y teléfono para el paso 2', j.user?.user_metadata?.full_name==='Ana Lucía Restrepo Vélez' && j.user?.user_metadata?.phone==='3105557788');

console.log('\n── 2. el paso del perfil ──');
const cat=await(await fetch(url+'/rest/v1/rpc/signup_catalogs',{method:'POST',headers:H(anon,tok),body:'{}'})).json();
t('ve las 4 aerolíneas', cat.airlines?.length===4, JSON.stringify(cat.airlines||cat).slice(0,140));
t('ve los conjuntos', (cat.residences?.length||0)>30, 'n='+cat.residences?.length);
const r1=cat.residences[0], r2=cat.residences[9];
const alta=await(await fetch(url+'/rest/v1/rpc/register_auxiliar',{method:'POST',headers:H(anon,tok),
  body:JSON.stringify({p_full_name:'Ana Lucía Restrepo Vélez',p_phone:'3105557788',
    p_airline_id:cat.airlines.find(a=>a.name==='LATAM').id,
    p_residence_id:r1.id,p_residence_unit:'Torre 1 · 501',
    p_residence_id_2:r2.id,p_residence_unit_2:'Casa 8'})})).json();
t('el alta pasa (la migración no exige el código)', alta.ok===true, JSON.stringify(alta).slice(0,160));

console.log('\n── 3. ya es un auxiliar normal ──');
const prof=await(await fetch(url+'/rest/v1/profiles?select=role,full_name,phone&id=eq.'+uid,{headers:H(anon,tok)})).json();
t('tiene perfil de auxiliar', prof[0]?.role==='auxiliar', JSON.stringify(prof).slice(0,120));
const ap=await(await fetch(url+'/rest/v1/auxiliar_profiles?select=id,joined_at,residence_unit,residence_unit_2&profile_id=eq.'+uid,{headers:H(anon,tok)})).json();
t('con fecha de ingreso de hoy', ap[0]?.joined_at===new Date().toLocaleDateString('en-CA',{timeZone:'America/Bogota'}), ap[0]?.joined_at);
t('y sus dos unidades', ap[0]?.residence_unit==='Torre 1 · 501' && ap[0]?.residence_unit_2==='Casa 8');

console.log('\n── 4. cierra la app y vuelve a entrar con su contraseña ──');
const li=await(await fetch(url+'/auth/v1/token?grant_type=password',{method:'POST',headers:{apikey:anon,'Content-Type':'application/json'},
  body:JSON.stringify({email,password:'MiClave2026'})})).json();
t('entra con correo y contraseña', !!li.access_token, JSON.stringify(li).slice(0,140));

console.log('\n── 5. el mismo correo no se puede registrar dos veces ──');
const dup=await fetch(url+'/auth/v1/signup',{method:'POST',headers:{apikey:anon,'Content-Type':'application/json'},
  body:JSON.stringify({email,password:'OtraClave2026'})});
const dj=await dup.json();
const yaExiste = dup.status!==200 || (Array.isArray(dj.user?.identities) && dj.user.identities.length===0) || (dj.identities && dj.identities.length===0);
t('lo detecta (la app lo traduce a «ya tiene cuenta»)', yaExiste, dup.status+' '+JSON.stringify(dj).slice(0,140));

console.log('\n── limpieza ──');
await fetch(url+'/auth/v1/admin/users/'+uid,{method:'DELETE',headers:H(srv)});
const gone=await(await fetch(url+'/rest/v1/profiles?select=id&id=eq.'+uid,{headers:H(srv)})).json();
t('usuario de prueba borrado', Array.isArray(gone)&&gone.length===0);
console.log(`\n${ok}/${ok+bad} pasaron${bad?' · '+bad+' FALLARON':''}`);
process.exit(bad?1:0);
