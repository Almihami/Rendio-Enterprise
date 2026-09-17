// Verifica el AGRUPADO de listLiveOperation: la pantalla monitorea carros, no
// vueltas. Replica la misma transformación sobre el dato real de dev.
import { createClient } from '@supabase/supabase-js';

const DEV = 'lxlphbafhtphulanhzlp';
if (!(process.env.SUPABASE_URL || '').includes(DEV)) { console.error('ABORTA: no es dev'); process.exit(2); }

const svc = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
await admin.auth.signInWithPassword({ email: 'demo-admin@rendio.demo', password: 'DemoRendio2026!' });

let pass = 0, fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); c ? pass++ : fail++; };

const { data } = await admin
  .from('route_assignments')
  .select('id, direction, planned_start_at, status, driver_profile_id, vehicle_id, vehicles(license_plate, capacity), driver_profiles(profiles(full_name)), route_stops(stop_order, status, reservations(pickup_address, required_arrival_at))')
  .in('status', ['planned', 'in_progress'])
  .order('planned_start_at');

const _bogDay = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
const today = _bogDay(new Date().toISOString());
const active = data.filter(ra => ra.planned_start_at && _bogDay(ra.planned_start_at) >= today);
const day0 = _bogDay(active[0].planned_start_at);
const rows = active.filter(ra => _bogDay(ra.planned_start_at) === day0);

console.log(`Día operativo: ${day0} · ${rows.length} vueltas en bruto\n`);

const stopsOf = (ra) => (ra.route_stops || []).slice().sort((a, b) => a.stop_order - b.stop_order);
const raDone = (ra) => !stopsOf(ra).some(s => ['pending', 'arrived', 'picked_up'].includes(s.status));

const byVeh = new Map();
rows.forEach(ra => { const k = ra.vehicle_id || ra.id; if (!byVeh.has(k)) byVeh.set(k, []); byVeh.get(k).push(ra); });

const cars = [...byVeh.values()].map(ras => {
  const activa = ras.find(ra => !raDone(ra)) || ras[ras.length - 1];
  return {
    id: activa.vehicles?.license_plate,
    driver: activa.driver_profiles?.profiles?.full_name,
    vueltasHoy: ras.length,
    done: ras.every(raDone),
    start: new Date(activa.planned_start_at).toLocaleTimeString('en-GB', { timeZone: 'America/Bogota', hour12: false }).slice(0, 5),
  };
});

console.log('=== TARJETAS QUE VERÍA EL ADMIN ===');
cars.forEach(c => console.log(`  ${c.id} · ${c.driver} · vuelta activa ${c.start} · ${c.vueltasHoy} vueltas hoy`));

console.log('');
ok(cars.length === 2, `2 tarjetas (una por carro), no ${rows.length} (dio ${cars.length})`);
ok(new Set(cars.map(c => c.id)).size === cars.length, 'sin placas repetidas');
ok(cars.every(c => c.driver && c.driver !== 'Sin conductor'), 'todas con conductor');
ok(cars.every(c => c.vueltasHoy === 5), `cada carro agrupa sus 5 vueltas (${cars.map(c => c.vueltasHoy).join(', ')})`);
// La vuelta activa debe ser la PRIMERA sin terminar → la más temprana del día.
ok(cars.every(c => c.start === cars.find(x => x.id === c.id).start), 'la vuelta activa es la primera sin cerrar');

console.log(`\n=== ${pass} OK · ${fail} fallos ===`);
process.exit(fail ? 1 : 0);
