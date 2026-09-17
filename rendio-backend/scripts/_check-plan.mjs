import { createClient } from '@supabase/supabase-js';
if(!(process.env.SUPABASE_URL||'').includes('lxlphbafhtphulanhzlp')){process.exit(2);}
const a = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {auth:{persistSession:false}});
const { data: ra } = await a.from('route_assignments').select('id, driver_profile_id, status, planned_start_at, direction');
console.log('route_assignments=' + ra.length);
ra.forEach(r=>console.log('  ' + r.status + ' · ' + r.direction + ' · start=' + r.planned_start_at + ' · driver=' + (r.driver_profile_id?'sí':'NO')));
const { count } = await a.from('route_stops').select('id',{count:'exact',head:true});
console.log('route_stops=' + count);
