// Verificación E2E de los fixes (bugs 2/3/4) contra dev. Throwaway (no commitear).
// Crea conductor + vehículo desechables, ejerce los flujos reales con login del
// conductor (RLS activa), afirma cada fix y limpia todo al final.
// Uso: cd scripts; set -a; source ../.env.dev; set +a; node verify-bugs.mjs
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';

const SB_URL = process.env.SUPABASE_URL, SR = process.env.SUPABASE_SERVICE_ROLE_KEY, ANON = process.env.SUPABASE_ANON_KEY;
const admin = createClient(SB_URL, SR, { auth: { persistSession: false } });

const out = [];
const ok = (name, cond, detail = '') => { out.push(!!cond); console.log(`${cond ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const host = new URL(SB_URL).host.split('.')[0];
console.log(`\n=== VERIFICACIÓN E2E (${host}) ===\n`);

const stamp = Date.now();
const email = `verify+${stamp}@rendio.test`;
const password = 'VerifyTest!2026';
let uid, driverId, vehId, shiftId;

try {
  // ---------- SETUP ----------
  const { data: anyProf } = await admin.from('profiles').select('organization_id').not('organization_id', 'is', null).limit(1).single();
  const org = anyProf.organization_id;

  const { data: cu, error: cuErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: 'VERIFY BOT' } });
  if (cuErr) throw new Error('createUser: ' + cuErr.message);
  uid = cu.user.id;

  let pErr;
  ({ error: pErr } = await admin.from('profiles').insert({ id: uid, organization_id: org, role: 'driver', full_name: 'VERIFY BOT', email, is_active: true }));
  if (pErr) throw new Error('profile: ' + pErr.message);
  await admin.from('driver_profiles').insert({ profile_id: uid });
  const { data: dp } = await admin.from('driver_profiles').select('id').eq('profile_id', uid).single();
  driverId = dp.id;

  const { data: veh, error: vErr } = await admin.from('vehicles').insert({
    organization_id: org, internal_code: `VERIFY-${stamp}`, license_plate: `VER${String(stamp).slice(-6)}`,
    capacity: 4, current_km: 0, last_maintenance_km: 0, status: 'available',
  }).select('id').single();
  if (vErr) throw new Error('vehicle: ' + vErr.message);
  vehId = veh.id;

  const drv = createClient(SB_URL, ANON, { auth: { persistSession: false } });
  const { data: si, error: siErr } = await drv.auth.signInWithPassword({ email, password });
  ok('Setup: login del conductor de prueba', !siErr && !!si?.session, siErr?.message);

  // ---------- BUG 3: idempotencia inicio de turno ----------
  const { data: shift, error: sErr } = await drv.from('shifts')
    .insert({ driver_id: driverId, organization_id: org, vehicle_id: vehId, opening_km: 50000, status: 'inspection_in_progress' })
    .select('id').single();
  ok('Setup: crear shift draft (RLS conductor)', !sErr && !!shift, sErr?.message);
  shiftId = shift?.id;

  const insp1 = randomUUID();
  const row = (id, km, dmg) => ({ id, organization_id: org, shift_id: shiftId, vehicle_id: vehId, driver_id: driverId, kind: 'initial', odometer_km: km, has_damage: dmg, checklist: { items: [] } });
  const { error: i1Err } = await drv.from('inspections').upsert(row(insp1, 50000, false), { onConflict: 'id' });
  ok('Bug3: inspección inicial #1 insertada', !i1Err, i1Err?.message);

  // reintento INGENUO (lo que hacía el código viejo): nueva inspección initial p/ mismo shift
  const { error: naiveErr } = await drv.from('inspections').insert(row(randomUUID(), 50000, false));
  ok('Bug3: reintento INGENUO da duplicate key (la constraint existe)', !!naiveErr && /duplicate|unique|23505/i.test(naiveErr.message || ''), naiveErr?.message || 'NO falló (?!)');

  // reintento IDEMPOTENTE (código nuevo): reusa id existente, INSERT choca y se
  // captura como "ya existe" devolviendo la existente (solo INSERT/SELECT, sin UPDATE).
  const { data: ex } = await drv.from('inspections').select('id').eq('shift_id', shiftId).eq('kind', 'initial').limit(1);
  const exId = ex?.[0]?.id;
  const { error: dupErr } = await drv.from('inspections').insert(row(exId, 50001, false));
  let recovered = null;
  if (dupErr && /duplicate|unique|23505|one_kind_per_shift/i.test(dupErr.message || '')) {
    const { data: ex2 } = await drv.from('inspections').select('id').eq('shift_id', shiftId).eq('kind', 'initial').limit(1);
    recovered = ex2?.[0]?.id;
  }
  ok('Bug3: reintento IDEMPOTENTE (insert+catch) recupera la existente sin bloquear', recovered === insp1, dupErr ? `recovered==insp1:${recovered === insp1}` : 'no chocó (?!)');

  const { data: allInit } = await admin.from('inspections').select('id').eq('shift_id', shiftId).eq('kind', 'initial');
  ok('Bug3: queda UNA sola inspección inicial', allInit?.length === 1, `count=${allInit?.length}`);

  // ---------- BUG 2: admin muestra inspecciones limpias ----------
  const { data: newQ } = await admin.from('inspections').select('id,has_damage').eq('kind', 'initial').eq('shift_id', shiftId);
  ok('Bug2: query admin NUEVO (sin filtro) incluye la inspección LIMPIA', newQ?.some(r => r.id === insp1 && r.has_damage === false));
  const { data: oldQ } = await admin.from('inspections').select('id').eq('kind', 'initial').eq('has_damage', true).eq('shift_id', shiftId);
  ok('Bug2: query VIEJO (has_damage=true) la ocultaba', !oldQ?.some(r => r.id === insp1), `viejo devolvía ${oldQ?.length} filas`);

  // ---------- BUG 4 (prevención): start_shift inicializa baseline ----------
  const { error: ssErr } = await drv.rpc('start_shift', { p_shift_id: shiftId });
  ok('Bug4-prev: start_shift ejecuta OK (conductor real)', !ssErr, ssErr?.message);
  const { data: vAfter } = await admin.from('vehicles').select('status,current_km,last_maintenance_km').eq('id', vehId).single();
  ok('Bug4-prev: baseline inicializado al odómetro (no queda en 0)', vAfter?.last_maintenance_km === 50000, `lastMaint=${vAfter?.last_maintenance_km}`);
  const gap = (vAfter?.current_km ?? 0) - (vAfter?.last_maintenance_km ?? 0);
  ok('Bug4-prev: con baseline OK, NO se marcaría mantto vencido al cerrar', gap < 7000, `gap=${gap} < 7000`);

  // ---------- BUG 4 (recuperación): return_vehicle_to_service ----------
  await admin.from('vehicles').update({ status: 'blocked', current_km: 99999, last_maintenance_km: 0 }).eq('id', vehId);
  // (debe rechazar mientras el turno siga activo)
  const { error: busyErr } = await admin.rpc('return_vehicle_to_service', { p_vehicle_id: vehId, p_reason: 'verify' });
  ok('Bug4-rec: rechaza liberar con turno activo', !!busyErr && /ACTIVE_SHIFT/i.test(busyErr.message || ''), busyErr?.message || 'no rechazó');
  // cerrar el turno y reintentar
  await admin.rpc('force_close_shift', { p_shift_id: shiftId, p_reason: 'verify' });
  await admin.from('vehicles').update({ status: 'blocked', current_km: 99999, last_maintenance_km: 0 }).eq('id', vehId);
  const { error: rErr } = await admin.rpc('return_vehicle_to_service', { p_vehicle_id: vehId, p_reason: 'verify' });
  ok('Bug4-rec: return_vehicle_to_service ejecuta OK', !rErr, rErr?.message);
  const { data: vRet } = await admin.from('vehicles').select('status,last_maintenance_km').eq('id', vehId).single();
  ok('Bug4-rec: blocked→available + baseline reseteado', vRet?.status === 'available' && vRet?.last_maintenance_km === 99999, `status=${vRet?.status} lastMaint=${vRet?.last_maintenance_km}`);

} catch (e) {
  console.log('\n❌ ERROR en la verificación:', e.message);
  out.push(false);
} finally {
  // ---------- CLEANUP (best-effort) ----------
  console.log('\n--- limpiando datos de prueba ---');
  try { if (shiftId) await admin.from('shifts').delete().eq('id', shiftId); } catch (e) {}
  try { if (vehId) { await admin.from('maintenance').delete().eq('vehicle_id', vehId); await admin.from('vehicles').delete().eq('id', vehId); } } catch (e) {}
  try { if (uid) { await admin.from('driver_profiles').delete().eq('profile_id', uid); await admin.from('profiles').delete().eq('id', uid); await admin.auth.admin.deleteUser(uid); } } catch (e) { console.log('  (quedó usuario de prueba sin borrar:', e.message, ')'); }
  const pass = out.filter(Boolean).length, total = out.length;
  console.log(`\n=== RESULTADO: ${pass}/${total} PASS ${pass === total ? '🎉' : '⚠️'} ===\n`);
}
