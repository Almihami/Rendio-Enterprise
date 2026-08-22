// Verificación E2E del cierre de turno (Fase A) contra dev. Throwaway.
// Crea conductor+vehículo, abre turno real, prueba close_shift (validaciones,
// inspección final, liberación de vehículo, idempotencia, recibos, novedad).
// Uso: cd scripts; set -a; source ../.env.dev; set +a; node verify-close.mjs
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';

const SB_URL = process.env.SUPABASE_URL, SR = process.env.SUPABASE_SERVICE_ROLE_KEY, ANON = process.env.SUPABASE_ANON_KEY;
const admin = createClient(SB_URL, SR, { auth: { persistSession: false } });
const out = [];
const ok = (n, c, d = '') => { out.push(!!c); console.log(`${c ? '✅ PASS' : '❌ FAIL'}  ${n}${d ? '  — ' + d : ''}`); };
const vstatus = async () => (await admin.from('vehicles').select('status').eq('id', vehId).single()).data?.status;

console.log(`\n=== VERIFICACIÓN CIERRE DE TURNO (${new URL(SB_URL).host.split('.')[0]}) ===\n`);
const stamp = Date.now();
let uid, driverId, vehId, shiftId, org;

try {
  const { data: anyProf } = await admin.from('profiles').select('organization_id').not('organization_id', 'is', null).limit(1).single();
  org = anyProf.organization_id;
  const email = `vclose+${stamp}@rendio.test`, password = 'VerifyTest!2026';
  const { data: cu, error: ce } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: 'VERIFY CLOSE' } });
  if (ce) throw new Error('createUser: ' + ce.message);
  uid = cu.user.id;
  await admin.from('profiles').insert({ id: uid, organization_id: org, role: 'driver', full_name: 'VERIFY CLOSE', email, is_active: true });
  await admin.from('driver_profiles').insert({ profile_id: uid });
  driverId = (await admin.from('driver_profiles').select('id').eq('profile_id', uid).single()).data.id;
  vehId = (await admin.from('vehicles').insert({ organization_id: org, internal_code: `VCL-${stamp}`, license_plate: `C${String(stamp).slice(-6)}`, capacity: 4, current_km: 10000, last_maintenance_km: 10000, status: 'available' }).select('id').single()).data.id;

  const drv = createClient(SB_URL, ANON, { auth: { persistSession: false } });
  await drv.auth.signInWithPassword({ email, password });

  // Abrir turno: reservar → opening_km → inspección inicial → start_shift
  const r = await drv.rpc('reserve_vehicle_for_shift', { p_vehicle_id: vehId, p_opening_km: 10000 });
  shiftId = r.data.shift_id;
  await drv.from('shifts').update({ opening_km: 10000 }).eq('id', shiftId);
  await drv.from('inspections').insert({ id: randomUUID(), organization_id: org, shift_id: shiftId, vehicle_id: vehId, driver_id: driverId, kind: 'initial', odometer_km: 10000, has_damage: false, checklist: { items: [] } });
  const ss = await drv.rpc('start_shift', { p_shift_id: shiftId });
  ok('Setup: turno activo', !ss.error && (await vstatus()) === 'in_use', ss.error?.message);

  // Validación: km final < apertura → error
  const bad = await drv.rpc('close_shift', { p_shift_id: shiftId, p_closing_km: 9000, p_has_novedad: false, p_novedad_text: null, p_severity: 'low', p_media_paths: [] });
  ok('Cierre: rechaza km final < apertura', !!bad.error && /CLOSING_KM_LT_OPENING/.test(bad.error.message || ''), bad.error?.message || 'no rechazó');

  // Recibo de tanqueo (insert como conductor, RLS)
  const recPath = `${org}/${vehId}/test/close-${shiftId}/receipt-1.jpg`;
  const recIns = await drv.from('fuel_receipts').insert({ organization_id: org, shift_id: shiftId, vehicle_id: vehId, driver_id: driverId, amount_cop: 45000, storage_path: recPath });
  ok('Recibos: el conductor inserta su comprobante (RLS)', !recIns.error, recIns.error?.message);

  // Cierre válido con novedad
  const cl = await drv.rpc('close_shift', { p_shift_id: shiftId, p_closing_km: 10280, p_has_novedad: true, p_novedad_text: 'Ruido en el freno al final del turno', p_severity: 'media', p_media_paths: [`${org}/${vehId}/test/close-${shiftId}/media-1.jpg`] });
  ok('Cierre: close_shift OK', !cl.error && cl.data?.ok, cl.error?.message);
  ok('Cierre: km recorridos correcto (280)', cl.data?.km_driven === 280, `km_driven=${cl.data?.km_driven}`);
  ok('Cierre: turno quedó closed', (await admin.from('shifts').select('status,closing_km').eq('id', shiftId).single()).data?.status === 'closed');
  ok('Cierre: vehículo liberado (available)', (await vstatus()) === 'available');
  const fin = (await admin.from('inspections').select('kind,odometer_km,has_damage').eq('shift_id', shiftId).eq('kind', 'final').limit(1)).data?.[0];
  ok('Cierre: inspección FINAL creada (odómetro=10280)', !!fin && fin.odometer_km === 10280, `final=${JSON.stringify(fin)}`);
  const inc = (await admin.from('incidents').select('id,description,photo_paths').eq('shift_id', shiftId)).data || [];
  ok('Cierre: novedad creó incident con evidencia', inc.length === 1 && (inc[0].photo_paths || []).length === 1, `incidents=${inc.length}`);

  // Idempotencia: re-cerrar → noop
  const re = await drv.rpc('close_shift', { p_shift_id: shiftId, p_closing_km: 10280 });
  ok('Cierre: re-cierre es idempotente (noop)', !re.error && re.data?.noop === true, re.error?.message || JSON.stringify(re.data));

  // Admin ve los recibos del turno
  const recs = (await admin.from('fuel_receipts').select('amount_cop').eq('shift_id', shiftId)).data || [];
  ok('Admin: comprobante de tanqueo visible', recs.length === 1 && Number(recs[0].amount_cop) === 45000, `recibos=${recs.length}`);

} catch (e) {
  console.log('\n❌ ERROR:', e.message); out.push(false);
} finally {
  console.log('\n--- limpiando ---');
  try { if (shiftId) { await admin.from('fuel_receipts').delete().eq('shift_id', shiftId); await admin.from('incidents').delete().eq('shift_id', shiftId); } } catch (e) {}
  try { if (driverId) await admin.from('shifts').delete().eq('driver_id', driverId); } catch (e) {}
  try { if (vehId) { await admin.from('maintenance').delete().eq('vehicle_id', vehId); await admin.from('vehicles').delete().eq('id', vehId); } } catch (e) {}
  try { if (uid) { await admin.from('driver_profiles').delete().eq('profile_id', uid); await admin.from('profiles').delete().eq('id', uid); await admin.auth.admin.deleteUser(uid); } } catch (e) { console.log('  (usuario sin borrar:', e.message, ')'); }
  const pass = out.filter(Boolean).length, total = out.length;
  console.log(`\n=== RESULTADO CIERRE: ${pass}/${total} PASS ${pass === total ? '🎉' : '⚠️'} ===\n`);
}
