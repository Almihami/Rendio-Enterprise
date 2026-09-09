// Volcado de las dos tablas de Julián (zona×franja y tramo final) + ajustes de rutas en dev.
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: z } = await sb.from('route_zone_times').select('*');
const { data: l } = await sb.from('route_leg_times').select('*');
const fmt = (rows) => rows.sort((a, b) => (a.zone || '').localeCompare(b.zone || '') || a.band_from - b.band_from)
  .map((r) => `${(r.zone || 'tramo').padEnd(20)} ${String(r.band_from).padStart(2)}-${String(r.band_to).padStart(2)}  ${r.min_minutes}-${r.max_minutes}${r.asumida ? '  (asumida)' : ''}`).join('\n');
console.log('ZONA × FRANJA (del primero al aeropuerto):\n' + fmt(z || []));
console.log('\nTRAMO FINAL (desde la última recogida):\n' + fmt(l || []));
const { data: s } = await sb.from('app_settings').select('*').eq('id', 'singleton').maybeSingle();
console.log('\n' + Object.entries(s || {}).filter(([k]) => /^route_/.test(k)).map(([k, v]) => k + '=' + v).join('\n'));
