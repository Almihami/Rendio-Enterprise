// Usuarios de dev con los que probar. Solo lectura; las contraseñas están
// hasheadas en Supabase y no se pueden leer desde acá.
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: au } = await sb.auth.admin.listUsers({ perPage: 500 });
const visto = new Map((au?.users || []).map(u => [u.id, u]));
for (const rol of ['auxiliar', 'driver']) {
  const { data } = await sb.from('profiles')
    .select('id, full_name, email, role, is_active')
    .eq('role', rol).eq('is_active', true).is('deleted_at', null).order('full_name');
  const demo = (data || []).filter(p => /demo|prueba|tester/i.test(p.email + p.full_name));
  console.log(`\n── ${rol} · ${data?.length || 0} activos, ${demo.length} de prueba ──`);
  for (const p of demo.slice(0, 4)) {
    const u = visto.get(p.id);
    console.log(`  ${p.email}  (${p.full_name}) · último ingreso: ${u?.last_sign_in_at?.slice(0,10) || 'nunca'}`);
  }
}
