// One-off: regresa un vehículo a servicio vía RPC. Throwaway (no commitear).
// Uso: set -a; source ../.env.main; set +a; node unblock-vehicle.mjs HNV760
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const code = process.argv[2];
if (!code) { console.error('falta el internal_code/placa'); process.exit(1); }

const { data: vehs, error: e0 } = await sb.from('vehicles')
  .select('id,internal_code,license_plate,status,current_km,last_maintenance_km')
  .or(`internal_code.eq.${code},license_plate.eq.${code}`);
if (e0) { console.error('lookup error:', e0.message); process.exit(1); }
if (!vehs.length) { console.error('no encontrado:', code); process.exit(1); }
const v = vehs[0];
console.log('ANTES:', JSON.stringify(v));

const { data, error } = await sb.rpc('return_vehicle_to_service', { p_vehicle_id: v.id, p_reason: 'Limpieza bug 4: baseline de mantto mal seteado (last_maintenance_km=0)' });
console.log('RPC resp:', error ? ('ERROR ' + error.message) : JSON.stringify(data));

const { data: after } = await sb.from('vehicles')
  .select('id,internal_code,status,current_km,last_maintenance_km')
  .eq('id', v.id).single();
console.log('DESPUÉS:', JSON.stringify(after));
