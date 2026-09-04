// Lista los admins ACTIVOS de dev, para saber con cuál entrar a probar.
// Solo lectura: no toca contraseñas ni las puede ver (Supabase las guarda con hash).
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data, error } = await sb.from('profiles')
  .select('id, full_name, email, role, is_active')
  .eq('role', 'admin').is('deleted_at', null).order('full_name');
if (error) { console.error(error); process.exit(1); }
const { data: au } = await sb.auth.admin.listUsers({ perPage: 200 });
const visto = new Map((au?.users || []).map(u => [u.id, u]));
console.log(`${data.length} admins en dev\n`);
for (const p of data) {
  const u = visto.get(p.id);
  console.log(`  ${p.is_active ? '●' : '○'} ${p.email}`);
  console.log(`      ${p.full_name} · último ingreso: ${u?.last_sign_in_at ? u.last_sign_in_at.slice(0,10) : 'nunca'}`);
}
