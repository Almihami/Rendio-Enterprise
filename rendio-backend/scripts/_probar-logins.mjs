import { createClient } from '@supabase/supabase-js';

if (!(process.env.SUPABASE_URL || '').includes('lxlphbafhtphulanhzlp')) {
  console.error('ABORTA: no es la BD de dev');
  process.exit(2);
}
const PASS = 'DemoRendio2026!';
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data: profs } = await admin
  .from('profiles')
  .select('id, email, full_name, role, is_active')
  .like('email', '%@rendio.demo')
  .order('role');

console.log('=== CUENTAS DEMO en dev ===');
profs.forEach((p) =>
  console.log(`  [${p.role}] ${p.email}  ${p.full_name}  activo=${p.is_active}`)
);

// Probar el login de verdad (anon key), no solo que exista el perfil.
const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
const probar = ['demo-admin@rendio.demo', 'demo-conductor@rendio.demo', 'laura.gomez@rendio.demo'];
console.log('\n=== PRUEBA DE LOGIN REAL (anon key) ===');
for (const email of probar) {
  const { data, error } = await anon.auth.signInWithPassword({ email, password: PASS });
  console.log(`  ${email} → ${error ? 'FALLA: ' + error.message : 'OK (uid ' + data.user.id.slice(0, 8) + ')'}`);
  if (!error) await anon.auth.signOut();
}
