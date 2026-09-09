import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const REAL = new Set([
  'juanandrescdn@gmail.com', 'andresarias51842@gmail.com', 'jeffcardona54@gmail.com',
  'danielgmr203851@gmail.com', 'francojuanjose152001@gmail.com', 'sebastiangoci@gmail.com',
  'roldanvalencia090224@gmail.com', 'juanjogc789@gmail.com',
]);

const { data, error } = await sb.from('profiles')
  .select('full_name, email, is_active, created_at')
  .eq('role', 'driver').is('deleted_at', null).order('created_at');
if (error) { console.error('ERROR:', error.message); process.exit(1); }

let real = 0, ph = 0;
console.log(`CONDUCTORES activos (no borrados): ${data.length}\n`);
for (const d of data) {
  const isReal = REAL.has((d.email || '').toLowerCase());
  if (isReal) real++; else ph++;
  console.log(`  [${isReal ? 'REAL       ' : 'PLACEHOLDER'}] ${d.full_name}  <${d.email}>`);
}
console.log(`\nReales: ${real} · Placeholder: ${ph}`);
