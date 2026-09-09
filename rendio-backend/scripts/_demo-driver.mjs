import { createClient } from '@supabase/supabase-js';
if(!(process.env.SUPABASE_URL||'').includes('lxlphbafhtphulanhzlp')){process.exit(2);}
const a = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {auth:{persistSession:false}});
const email='demo-conductor@rendio.demo', password='DemoRendio2026!';
let { data: prev } = await a.from('profiles').select('id').eq('email', email).maybeSingle();
if (prev) { await a.from('driver_profiles').delete().eq('profile_id', prev.id); await a.from('profiles').delete().eq('id', prev.id); try{await a.auth.admin.deleteUser(prev.id);}catch(e){} }
const { data: cu, error } = await a.auth.admin.createUser({ email, password, email_confirm:true, user_metadata:{full_name:'DEMO Conductor'} });
if(error){console.error(error.message);process.exit(1);}
const { data: org1 } = await a.from('profiles').select('organization_id').not('organization_id','is',null).limit(1).single();
await a.from('profiles').insert({ id: cu.user.id, organization_id: org1.organization_id, role:'driver', full_name:'DEMO Conductor', email, is_active:true });
await a.from('driver_profiles').insert({ profile_id: cu.user.id });
const { data: dp } = await a.from('driver_profiles').select('id').eq('profile_id', cu.user.id).single();
console.log('PROFILE_ID=' + cu.user.id);
console.log('DRIVER_PROFILE_ID=' + dp.id);
console.log('login: ' + email + ' / ' + password);
