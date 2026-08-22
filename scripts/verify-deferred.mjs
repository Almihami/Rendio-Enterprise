// Verificación E2E del inicio diferido (inspección después). Throwaway, dev.
// Uso: cd scripts; set -a; source ../.env.dev; set +a; node verify-deferred.mjs
import { createClient } from '@supabase/supabase-js';
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const ANON = process.env.SUPABASE_ANON_KEY, SB_URL = process.env.SUPABASE_URL;
const out = []; const ok = (n, c, d = '') => { out.push(!!c); console.log(`${c ? '✅ PASS' : '❌ FAIL'}  ${n}${d ? '  — ' + d : ''}`); };

console.log('\n=== VERIFICACIÓN INICIO DIFERIDO ===\n');
const stamp = Date.now();
let uid, driverId, vehId, org, prev;
async function mkDriverClient(tag) {
  const email = `vdef${tag}+${stamp}@rendio.test`, password = 'VerifyTest!2026';
  const u = (await admin.auth.admin.createUser({ email, password, email_confirm: true })).data.user.id;
  await admin.from('profiles').insert({ id: u, organization_id: org, role: 'driver', full_name: `VDEF ${tag}`, email, is_active: true });
  await admin.from('driver_profiles').insert({ profile_id: u });
  const did = (await admin.from('driver_profiles').select('id').eq('profile_id', u).single()).data.id;
  const cli = createClient(SB_URL, ANON, { auth: { persistSession: false } });
  await cli.auth.signInWithPassword({ email, password });
  return { uid: u, driverId: did, cli };
}
try {
  org = (await admin.from('profiles').select('organization_id').not('organization_id', 'is', null).limit(1).single()).data.organization_id;
  prev = (await admin.from('app_settings').select('fast_start_enabled,fast_start_from_hour,fast_start_to_hour,inspection_grace_minutes').eq('id', 'singleton').single()).data;

  const veh = (await admin.from('vehicles').insert({ organization_id: org, internal_code: `VDF-${stamp}`, license_plate: `D${String(stamp).slice(-6)}`, capacity: 4, current_km: 5000, last_maintenance_km: 5000, status: 'available' }).select('id').single()).data;
  vehId = veh.id;
  const A = await mkDriverClient('A'); uid = A.uid; driverId = A.driverId;

  // --- Rechazo fuera de ventana (franja 0–1, hora actual fuera) ---
  await admin.from('app_settings').update({ fast_start_enabled: true, fast_start_from_hour: 0, fast_start_to_hour: 1, inspection_grace_minutes: 90 }).eq('id', 'singleton');
  const rA = await A.cli.rpc('reserve_vehicle_for_shift', { p_vehicle_id: vehId });
  const shiftId = rA.data.shift_id;
  const outWin = await A.cli.rpc('start_shift_deferred', { p_shift_id: shiftId, p_opening_km: 5100 });
  ok('Fuera de la franja → rechazado (FAST_START_NOT_ALLOWED_NOW)', !!outWin.error && /NOT_ALLOWED_NOW/.test(outWin.error.message || ''), outWin.error?.message || 'no rechazó');

  // --- Dentro de ventana (0–24) → inicia diferido ---
  await admin.from('app_settings').update({ fast_start_from_hour: 0, fast_start_to_hour: 24 }).eq('id', 'singleton');
  const dfr = await A.cli.rpc('start_shift_deferred', { p_shift_id: shiftId, p_opening_km: 5100 });
  ok('Dentro de la franja → inicia diferido', !dfr.error && dfr.data?.ok && !!dfr.data?.inspection_due_at, dfr.error?.message);
  const sh = (await admin.from('shifts').select('status,inspection_due_at,opening_km').eq('id', shiftId).single()).data;
  ok('Turno quedó activo con plazo y sin inspección', sh.status === 'active' && !!sh.inspection_due_at, JSON.stringify(sh));
  const insp0 = (await admin.from('inspections').select('id').eq('shift_id', shiftId).eq('kind', 'initial')).data || [];
  ok('Aún no hay inspección inicial', insp0.length === 0);
  ok('Vehículo quedó in_use', (await admin.from('vehicles').select('status').eq('id', vehId).single()).data.status === 'in_use');

  // --- Vencimiento → strike automático ---
  await admin.from('shifts').update({ inspection_due_at: new Date(stamp - 60 * 60 * 1000).toISOString() }).eq('id', shiftId);
  const proc = await admin.rpc('process_pending_inspections');
  if (proc.error) {
    ok('process_pending_inspections ejecutable', false, proc.error.message + ' (revisar GRANT a service_role)');
  } else {
    const strikes = (await admin.from('driver_strikes').select('id,reason').eq('profile_id', uid)).data || [];
    ok('Vencido → strike automático creado', strikes.length >= 1, `strikes=${strikes.length}`);
    const sh2 = (await admin.from('shifts').select('inspection_due_at').eq('id', shiftId).single()).data;
    ok('Se limpió el plazo (no re-castiga)', sh2.inspection_due_at === null);
  }

} catch (e) { console.log('\n❌ ERROR:', e.message); out.push(false); }
finally {
  console.log('\n--- limpiando ---');
  try { if (prev) await admin.from('app_settings').update(prev).eq('id', 'singleton'); } catch (e) {}
  try { if (driverId) await admin.from('shifts').delete().eq('driver_id', driverId); } catch (e) {}
  try { if (uid) { await admin.from('driver_strikes').delete().eq('profile_id', uid); await admin.from('driver_suspensions').delete().eq('profile_id', uid); await admin.from('driver_profiles').delete().eq('profile_id', uid); await admin.from('profiles').delete().eq('id', uid); await admin.auth.admin.deleteUser(uid); } } catch (e) {}
  try { if (vehId) { await admin.from('maintenance').delete().eq('vehicle_id', vehId); await admin.from('vehicles').delete().eq('id', vehId); } } catch (e) {}
  const pass = out.filter(Boolean).length, total = out.length;
  console.log(`\n=== RESULTADO INICIO DIFERIDO: ${pass}/${total} PASS ${pass === total ? '🎉' : '⚠️'} ===\n`);
}
