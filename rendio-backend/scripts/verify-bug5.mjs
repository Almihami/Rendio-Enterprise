// Verificación E2E del bug 5 (reserva dura) contra dev. Throwaway (no commitear).
// 2 conductores + 1 vehículo desechables; login real; prueba reserva, bloqueo del
// segundo, re-entrada, auto-sanado de reserva vieja, release por cron, force_close
// libera reserved, y start_shift reserved→in_use. Limpia todo al final.
// Uso: cd scripts; set -a; source ../.env.dev; set +a; node verify-bug5.mjs
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';

const SB_URL = process.env.SUPABASE_URL, SR = process.env.SUPABASE_SERVICE_ROLE_KEY, ANON = process.env.SUPABASE_ANON_KEY;
const admin = createClient(SB_URL, SR, { auth: { persistSession: false } });
const out = [];
const ok = (n, c, d = '') => { out.push(!!c); console.log(`${c ? '✅ PASS' : '❌ FAIL'}  ${n}${d ? '  — ' + d : ''}`); };
const vstatus = async () => (await admin.from('vehicles').select('status').eq('id', vehId).single()).data?.status;
const sstatus = async (id) => (await admin.from('shifts').select('status').eq('id', id).single()).data?.status;

console.log(`\n=== VERIFICACIÓN BUG 5 — reserva dura (${new URL(SB_URL).host.split('.')[0]}) ===\n`);
const stamp = Date.now();
let uidA, uidB, drvAId, drvBId, vehId;

async function mkDriver(tag) {
  const email = `verify5${tag}+${stamp}@rendio.test`, password = 'VerifyTest!2026';
  const { data: cu, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: `VERIFY ${tag}` } });
  if (error) throw new Error('createUser ' + tag + ': ' + error.message);
  const uid = cu.user.id;
  await admin.from('profiles').insert({ id: uid, organization_id: org, role: 'driver', full_name: `VERIFY ${tag}`, email, is_active: true });
  await admin.from('driver_profiles').insert({ profile_id: uid });
  const { data: dp } = await admin.from('driver_profiles').select('id').eq('profile_id', uid).single();
  const cli = createClient(SB_URL, ANON, { auth: { persistSession: false } });
  const { error: se } = await cli.auth.signInWithPassword({ email, password });
  if (se) throw new Error('login ' + tag + ': ' + se.message);
  return { uid, driverId: dp.id, cli };
}

let org, A, B;
try {
  const { data: anyProf } = await admin.from('profiles').select('organization_id').not('organization_id', 'is', null).limit(1).single();
  org = anyProf.organization_id;
  A = await mkDriver('A'); uidA = A.uid; drvAId = A.driverId;
  B = await mkDriver('B'); uidB = B.uid; drvBId = B.driverId;
  const { data: veh } = await admin.from('vehicles').insert({ organization_id: org, internal_code: `VRF5-${stamp}`, license_plate: `V5${String(stamp).slice(-6)}`, capacity: 4, current_km: 1000, last_maintenance_km: 1000, status: 'available' }).select('id').single();
  vehId = veh.id;
  ok('Setup: 2 conductores + vehículo disponibles', !!(drvAId && drvBId && vehId));

  // T1 — reserva dura: A reserva, B no puede
  const { data: rA, error: eA } = await A.cli.rpc('reserve_vehicle_for_shift', { p_vehicle_id: vehId, p_opening_km: null });
  ok('T1: A reserva el vehículo', !eA && rA?.ok, eA?.message);
  ok('T1: vehículo queda reserved', (await vstatus()) === 'reserved');
  const { error: eB } = await B.cli.rpc('reserve_vehicle_for_shift', { p_vehicle_id: vehId });
  ok('T1: B NO puede reservar (lo tiene A)', !!eB && /RESERVED_BY_ANOTHER|IN_USE/i.test(eB.message || ''), eB?.message || 'no rechazó');

  // T2 — A re-entra a su propia reserva
  const { data: rA2, error: eA2 } = await A.cli.rpc('reserve_vehicle_for_shift', { p_vehicle_id: vehId });
  ok('T2: A re-entra a su reserva (mismo shift)', !eA2 && rA2?.shift_id === rA?.shift_id, eA2?.message || `${rA2?.shift_id}==${rA?.shift_id}`);

  // T3 — auto-sanado: la reserva de A se vuelve vieja → B la toma
  await admin.from('shifts').update({ start_at: new Date(stamp - 2 * 3600 * 1000).toISOString() }).eq('id', rA.shift_id);
  const { data: rB, error: eB2 } = await B.cli.rpc('reserve_vehicle_for_shift', { p_vehicle_id: vehId });
  ok('T3: B reserva tras auto-sanar la reserva VIEJA de A', !eB2 && rB?.ok, eB2?.message);
  ok('T3: la reserva vieja de A quedó cerrada', (await sstatus(rA.shift_id)) === 'closed');
  ok('T3: el vehículo ahora está reservado (por B)', (await vstatus()) === 'reserved');

  // T4 — release_stale_reservations() (cron): cierra la reserva vieja y libera
  await admin.from('shifts').update({ start_at: new Date(stamp - 3 * 3600 * 1000).toISOString() }).eq('id', rB.shift_id);
  const { data: n } = await admin.rpc('release_stale_reservations');
  ok('T4: release_stale_reservations liberó ≥1', (n || 0) >= 1, `liberadas=${n}`);
  ok('T4: vehículo vuelve a available', (await vstatus()) === 'available');

  // T5 — force_close libera un vehículo reserved
  const { data: rA3 } = await A.cli.rpc('reserve_vehicle_for_shift', { p_vehicle_id: vehId });
  ok('T5: A reserva de nuevo', (await vstatus()) === 'reserved');
  await admin.rpc('force_close_shift', { p_shift_id: rA3.shift_id, p_reason: 'verify' });
  ok('T5: force_close libera el vehículo reserved', (await vstatus()) === 'available');

  // T6 — start_shift: reserved → in_use (flujo real con inspección)
  const { data: rA4 } = await A.cli.rpc('reserve_vehicle_for_shift', { p_vehicle_id: vehId });
  await A.cli.from('shifts').update({ opening_km: 30000 }).eq('id', rA4.shift_id);
  await A.cli.from('inspections').insert({ id: randomUUID(), organization_id: org, shift_id: rA4.shift_id, vehicle_id: vehId, driver_id: drvAId, kind: 'initial', odometer_km: 30000, has_damage: false, checklist: { items: [] } });
  const { error: ssErr } = await A.cli.rpc('start_shift', { p_shift_id: rA4.shift_id });
  ok('T6: start_shift activa el turno', !ssErr, ssErr?.message);
  ok('T6: vehículo pasa reserved → in_use', (await vstatus()) === 'in_use');

} catch (e) {
  console.log('\n❌ ERROR:', e.message); out.push(false);
} finally {
  console.log('\n--- limpiando ---');
  try { await admin.from('shifts').delete().in('driver_id', [drvAId, drvBId].filter(Boolean)); } catch (e) {}
  try { if (vehId) { await admin.from('maintenance').delete().eq('vehicle_id', vehId); await admin.from('vehicles').delete().eq('id', vehId); } } catch (e) {}
  for (const uid of [uidA, uidB].filter(Boolean)) {
    try { await admin.from('driver_profiles').delete().eq('profile_id', uid); await admin.from('profiles').delete().eq('id', uid); await admin.auth.admin.deleteUser(uid); } catch (e) { console.log('  (usuario sin borrar:', e.message, ')'); }
  }
  const pass = out.filter(Boolean).length, total = out.length;
  console.log(`\n=== RESULTADO BUG 5: ${pass}/${total} PASS ${pass === total ? '🎉' : '⚠️'} ===\n`);
}
