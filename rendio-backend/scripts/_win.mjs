import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
await sb.from('app_settings').update({ route_merge_window_min: Number(process.argv[2]) }).eq('id','singleton');
const { data } = await sb.from('app_settings').select('route_merge_window_min').limit(1);
console.log('ventana =', data[0].route_merge_window_min, 'min');
