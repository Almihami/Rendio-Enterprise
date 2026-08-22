import { createClient } from '@supabase/supabase-js';
if(!(process.env.SUPABASE_URL||'').includes('lxlphbafhtphulanhzlp')){process.exit(2);}
const a = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {auth:{persistSession:false}});
console.log('vehículos=' + JSON.stringify((await a.from('vehicles').select('id,license_plate,capacity').limit(5)).data));
console.log('driver_profiles=' + ((await a.from('driver_profiles').select('id',{count:'exact',head:true})).count));
console.log('conductores(profiles role=driver)=' + JSON.stringify((await a.from('profiles').select('id,full_name,email').eq('role','driver').limit(6)).data?.map(d=>d.email)));
