// Crea un CONDUCTOR de prueba para la demo en navegador (dev). Throwaway.
// Imprime credenciales. Borrar luego con delete-demo-driver.mjs.
import { createClient } from '@supabase/supabase-js';
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const email = 'demo-conductor@rendio.test';
const password = 'DemoRendio2026!';

// Borra uno previo con el mismo email si quedó.
const { data: prev } = await admin.from('profiles').select('id').eq('email', email).limit(1);
if (prev && prev[0]) {
  await admin.from('shifts').delete().in('driver_id',
    (await admin.from('driver_profiles').select('id').eq('profile_id', prev[0].id)).data?.map(r => r.id) || []);
  await admin.from('driver_profiles').delete().eq('profile_id', prev[0].id);
  await admin.from('profiles').delete().eq('id', prev[0].id);
  try { await admin.auth.admin.deleteUser(prev[0].id); } catch (e) {}
}

const { data: anyProf } = await admin.from('profiles').select('organization_id').not('organization_id', 'is', null).limit(1).single();
const org = anyProf.organization_id;

const { data: cu, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: 'DEMO Conductor' } });
if (error) { console.error('createUser:', error.message); process.exit(1); }
const uid = cu.user.id;
await admin.from('profiles').insert({ id: uid, organization_id: org, role: 'driver', full_name: 'DEMO Conductor', email, is_active: true });
await admin.from('driver_profiles').insert({ profile_id: uid });
const { data: dp } = await admin.from('driver_profiles').select('id').eq('profile_id', uid).single();

console.log('CONDUCTOR DE PRUEBA creado:');
console.log('  email   :', email);
console.log('  password:', password);
console.log('  uid     :', uid);
console.log('  driverId:', dp.id);
