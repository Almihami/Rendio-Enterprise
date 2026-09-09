import { createClient } from '@supabase/supabase-js';
if(!(process.env.SUPABASE_URL||'').includes('lxlphbafhtphulanhzlp')){console.error('no dev');process.exit(2);}
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });
const email='demo-admin@rendio.demo', password='DemoRendio2026!';
const { data: prev } = await admin.from('profiles').select('id').eq('email', email).maybeSingle();
if (prev) { await admin.from('profiles').delete().eq('id', prev.id); try{await admin.auth.admin.deleteUser(prev.id);}catch(e){} }
const { data: cu, error } = await admin.auth.admin.createUser({ email, password, email_confirm:true });
if(error){console.error(error.message);process.exit(1);}
const { data: org1 } = await admin.from('profiles').select('organization_id').not('organization_id','is',null).limit(1).single();
await admin.from('profiles').insert({ id: cu.user.id, organization_id: org1.organization_id, role:'admin', full_name:'DEMO Admin', email, is_active:true });
console.log('admin demo:', email, password);
