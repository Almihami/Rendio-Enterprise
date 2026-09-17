// Comprueba que la consulta del Balance (que venía de main) corre contra la
// base de DEV. Solo lectura.
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data, error } = await sb.from('shifts')
  .select('id, status, start_at, end_at, opening_km, closing_km, driver_id, driver_profiles(profile_id, profiles(full_name, email))')
  .gte('start_at', '2026-06-01T00:00:00Z').lt('start_at', '2026-10-01T00:00:00Z')
  .order('start_at', { ascending: true });
if (error) { console.log('✗ LA CONSULTA FALLA EN DEV:'); console.log(JSON.stringify(error, null, 2)); process.exit(1); }
console.log('✓ la consulta del Balance corre en dev · filas:', data.length);
if (data.length) {
  const r = data[0];
  console.log('  columnas    :', Object.keys(r).join(', '));
  console.log('  join perfil :', r.driver_profiles?.profiles?.full_name ?? '(sin nombre)');
  const est = {}; data.forEach(x => est[x.status] = (est[x.status]||0)+1);
  console.log('  estados     :', JSON.stringify(est));
  const cerrados = data.filter(x => x.end_at).length;
  console.log('  con cierre  :', cerrados, 'de', data.length);
} else console.log('  (0 turnos en el rango: la consulta es válida, pero no hay datos que pintar)');
