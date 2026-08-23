import { createClient } from '@supabase/supabase-js';
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data } = await s.from('app_settings').select('*').eq('id', 'singleton').single();
for (const k of Object.keys(data).filter(k => k.startsWith('route_')).sort())
  console.log(k, '=', typeof data[k] === 'object' ? JSON.stringify(data[k]) : data[k]);
