import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const id = '5722ef88-2eed-464e-aeba-84379e65dc16';
const { data: p } = await sb.from('profiles')
  .select('full_name, email, role, is_active, deleted_at').eq('id', id).maybeSingle();
console.log('Perfil del UUID:', p || '(no existe)');

const { data: reqs } = await sb.from('approval_requests')
  .select('profile_id, state').limit(1000);
const byProf = {};
(reqs || []).forEach(r => { byProf[r.profile_id] = (byProf[r.profile_id] || 0) + 1; });
console.log('\nSolicitudes por profile_id:');
for (const [pid, n] of Object.entries(byProf)) {
  const { data: pr } = await sb.from('profiles')
    .select('full_name, deleted_at').eq('id', pid).maybeSingle();
  const tag = pr ? (pr.deleted_at ? 'BORRADO' : 'activo') : 'NO EXISTE';
  console.log(`  ${pid}  ×${n}  → ${pr ? pr.full_name : '?'} [${tag}]`);
}
