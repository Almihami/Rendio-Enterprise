// Diagnóstico read-only de turnos/vehículos colgados. Throwaway (no commitear).
// Uso: set -a; source ../.env.dev; set +a; node diag-turnos.mjs
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sb = createClient(url, key, { auth: { persistSession: false } });

const host = new URL(url).host.split('.')[0];
console.log(`\n=== DIAGNÓSTICO (${host}) ===\n`);

// 0) ¿Existe el RPC nuevo? (esperamos NOT_ADMIN, que confirma que existe)
{
  const { error } = await sb.rpc('return_vehicle_to_service', {
    p_vehicle_id: '00000000-0000-0000-0000-000000000000', p_reason: 'probe',
  });
  const msg = error ? error.message : '(sin error?!)';
  const exists = !/Could not find the function|does not exist|schema cache/i.test(msg);
  console.log(`RPC return_vehicle_to_service: ${exists ? 'EXISTE ✅' : 'NO EXISTE ❌'}  (resp: ${msg})\n`);
}

// 1) Vehículos no disponibles
{
  const { data, error } = await sb.from('vehicles')
    .select('id,internal_code,license_plate,status,current_km,last_maintenance_km,maintenance_interval_km')
    .is('deleted_at', null).neq('status', 'available').order('status');
  if (error) { console.log('vehiculos error:', error.message); }
  else {
    console.log(`1) Vehículos NO disponibles: ${data.length}`);
    data.forEach(v => {
      const overdue = (v.current_km - v.last_maintenance_km) >= v.maintenance_interval_km;
      console.log(`   - [${v.status}] ${v.internal_code || v.license_plate} · ${v.current_km}km · desde mantto ${v.current_km - v.last_maintenance_km}/${v.maintenance_interval_km}${overdue ? ' (MANTTO VENCIDO)' : ''}  id=${v.id}`);
    });
    console.log('');
  }
}

// 2) Turnos sin cerrar (+ inspección inicial)
let openShifts = [];
{
  const { data, error } = await sb.from('shifts')
    .select('id,status,start_at,vehicle_id,vehicles(internal_code,status),driver_profiles(profiles(full_name))')
    .neq('status', 'closed').order('start_at');
  if (error) { console.log('shifts error:', error.message); }
  else {
    openShifts = data;
    // inspecciones iniciales de esos turnos
    const ids = data.map(s => s.id);
    let insp = [];
    if (ids.length) {
      const r = await sb.from('inspections').select('shift_id,has_damage,review_status').eq('kind', 'initial').in('shift_id', ids);
      insp = r.data || [];
    }
    const byShift = Object.fromEntries(insp.map(i => [i.shift_id, i]));
    console.log(`2) Turnos SIN cerrar: ${data.length}`);
    data.forEach(s => {
      const h = ((Date.now() - new Date(s.start_at).getTime()) / 3.6e6).toFixed(1);
      const drv = s.driver_profiles?.profiles?.full_name || '—';
      const veh = s.vehicles?.internal_code || s.vehicle_id;
      const i = byShift[s.id];
      console.log(`   - [${s.status}] ${drv} · ${veh}(${s.vehicles?.status}) · ${h}h · insp:${i ? (i.has_damage ? 'novedad/' + i.review_status : 'limpia/' + i.review_status) : 'NINGUNA'}  shift=${s.id}`);
    });
    console.log('');
  }
}

// 3) Resumen de drafts huérfanos
{
  const drafts = openShifts.filter(s => s.status === 'vehicle_selected' || s.status === 'inspection_in_progress');
  const active = openShifts.filter(s => s.status === 'active' || s.status === 'closing');
  console.log(`3) Drafts (vehicle_selected/inspection_in_progress): ${drafts.length}`);
  console.log(`   Activos/closing: ${active.length}`);
  console.log('');
}

// 4) Auditoría de mantenimiento de TODOS los vehículos (baseline)
{
  const { data, error } = await sb.from('vehicles')
    .select('internal_code,license_plate,status,current_km,last_maintenance_km,maintenance_interval_km')
    .is('deleted_at', null).order('internal_code');
  if (error) { console.log('audit error:', error.message); }
  else {
    console.log(`4) Auditoría de mantenimiento (${data.length} vehículos):`);
    data.forEach(v => {
      const since = v.current_km - v.last_maintenance_km;
      const overdue = since >= v.maintenance_interval_km;
      console.log(`   - ${v.internal_code || v.license_plate} [${v.status}] cur=${v.current_km} lastMaint=${v.last_maintenance_km} int=${v.maintenance_interval_km} → desde=${since}${overdue ? ' ⚠ VENCIDO (se bloqueará al cerrar turno)' : ' ok'}`);
    });
    console.log('');
  }
}

console.log('=== fin diagnóstico ===\n');
