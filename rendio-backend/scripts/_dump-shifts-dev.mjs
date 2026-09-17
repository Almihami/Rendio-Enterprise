// Saca los turnos reales de dev a un JSON, para probar el Balance con datos de
// verdad en vez de inventados. Solo lectura.
import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'node:fs';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data, error } = await sb.from('shifts')
  .select('id, status, start_at, end_at, opening_km, closing_km, driver_id, driver_profiles(profile_id, profiles(full_name, email))')
  .order('start_at', { ascending: true });
if (error) { console.error(error); process.exit(1); }
writeFileSync(process.argv[2], JSON.stringify(data, null, 2));
console.log(`${data.length} turnos → ${process.argv[2]}`);
