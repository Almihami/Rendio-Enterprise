import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

if (!(process.env.SUPABASE_URL || '').includes('lxlphbafhtphulanhzlp')) {
  console.error('ABORTA: no es la BD de dev');
  process.exit(2);
}

const seed = JSON.parse(readFileSync(new URL('./seed-turnos-users.json', import.meta.url)));
const PASS = seed.default_password;

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Los dos con vueltas AM el viernes.
const objetivo = ['0776dcab-be80-40d9-afd6-e26218e8101e', '8e6cb653-416b-4763-b703-c2e19c440ed2'];
const { data: profs } = await admin
  .from('profiles')
  .select('id, email, full_name')
  .in('id', objetivo);

const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});

console.log('=== ¿La contraseña por defecto del seed sirve en dev? ===');
for (const p of profs) {
  const { data, error } = await anon.auth.signInWithPassword({ email: p.email, password: PASS });
  console.log(`  ${p.full_name}  <${p.email}>  →  ${error ? 'FALLA: ' + error.message : 'OK'}`);
  if (!error) await anon.auth.signOut();
}
