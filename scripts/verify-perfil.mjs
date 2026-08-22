// Verificación E2E de Fases B (perfil), C (strikes), D (recompensas) contra dev.
// Throwaway. Uso: cd scripts; set -a; source ../.env.dev; set +a; node verify-perfil.mjs
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';

const SB_URL = process.env.SUPABASE_URL, SR = process.env.SUPABASE_SERVICE_ROLE_KEY, ANON = process.env.SUPABASE_ANON_KEY;
const admin = createClient(SB_URL, SR, { auth: { persistSession: false } });
const out = [];
const ok = (n, c, d = '') => { out.push(!!c); console.log(`${c ? '✅ PASS' : '❌ FAIL'}  ${n}${d ? '  — ' + d : ''}`); };
const nextMonday = () => { const d = new Date(); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow + 7); return d.toISOString().slice(0, 10); };

console.log(`\n=== VERIFICACIÓN PERFIL / STRIKES / RECOMPENSAS (${new URL(SB_URL).host.split('.')[0]}) ===\n`);
const stamp = Date.now();
let uid, driverId, vehId, org, shiftId, redId;

try {
  org = (await admin.from('profiles').select('organization_id').not('organization_id', 'is', null).limit(1).single()).data.organization_id;
  const email = `vperfil+${stamp}@rendio.test`, password = 'VerifyTest!2026';
  uid = (await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: 'VERIFY PERFIL' } })).data.user.id;
  // Fase B: admin setea cédula + base
  await admin.from('profiles').insert({ id: uid, organization_id: org, role: 'driver', full_name: 'VERIFY PERFIL', email, is_active: true, phone: '3115550199', document_id: '1020345678', home_base: 'BOG · Bogotá' });
  await admin.from('driver_profiles').insert({ profile_id: uid, license_number: 'C2-123', license_expires_at: '2027-01-01' });
  driverId = (await admin.from('driver_profiles').select('id').eq('profile_id', uid).single()).data.id;
  vehId = (await admin.from('vehicles').insert({ organization_id: org, internal_code: `VPF-${stamp}`, license_plate: `P${String(stamp).slice(-6)}`, capacity: 4, current_km: 0, last_maintenance_km: 0, status: 'available' }).select('id').single()).data.id;

  const drv = createClient(SB_URL, ANON, { auth: { persistSession: false } });
  await drv.auth.signInWithPassword({ email, password });

  // ---- Fase B: perfil completo ----
  const prof = (await drv.rpc ? null : null); // noop
  const { data: full, error: pe } = await drv.from('profiles').select('full_name, phone, document_id, home_base, avatar_url').eq('id', uid).single();
  ok('B: el conductor lee su perfil con cédula y base', !pe && full?.document_id === '1020345678' && full?.home_base === 'BOG · Bogotá', pe?.message);
  // avatar self-update (RLS)
  const av = await drv.from('profiles').update({ avatar_url: 'https://x/test.jpg' }).eq('id', uid);
  ok('B: el conductor puede actualizar su avatar (RLS self)', !av.error, av.error?.message);

  // ---- Fase D: km + recompensas ----
  // turno cerrado con 2500 km
  await admin.from('shifts').insert({ driver_id: driverId, organization_id: org, vehicle_id: vehId, status: 'closed', opening_km: 0, closing_km: 2500, start_at: new Date(stamp - 6 * 3600 * 1000).toISOString(), end_at: new Date(stamp).toISOString() });
  const closed = (await drv.from('shifts').select('opening_km,closing_km').eq('driver_id', driverId).eq('status', 'closed')).data || [];
  const kmTotal = closed.reduce((s, x) => s + Math.max(0, (x.closing_km || 0) - (x.opening_km || 0)), 0);
  ok('D: km acumulado del conductor = 2500', kmTotal === 2500, `km=${kmTotal}`);
  const rewards = (await drv.from('rewards').select('id,title,km_threshold').eq('active', true).order('km_threshold')).data || [];
  ok('D: catálogo de recompensas visible (sembrado)', rewards.length >= 1, `rewards=${rewards.length}`);
  const unlocked = rewards.find(r => r.km_threshold <= kmTotal);
  const locked = rewards.find(r => r.km_threshold > kmTotal);
  ok('D: hay una recompensa desbloqueada por km', !!unlocked, unlocked ? `${unlocked.title} (${unlocked.km_threshold})` : 'ninguna');
  // candado: redimir SIN km suficientes → NOT_ENOUGH_KM
  if (locked) {
    const { error: lockErr } = await drv.rpc('redeem_reward', { p_reward_id: locked.id });
    ok('D: redimir sin km suficientes es RECHAZADO (NOT_ENOUGH_KM)', !!lockErr && /NOT_ENOUGH_KM/.test(lockErr.message || ''), lockErr?.message || 'no rechazó');
  }
  // redención válida (RPC valida km en servidor)
  const { data: rd, error: rdErr } = await drv.rpc('redeem_reward', { p_reward_id: unlocked.id });
  redId = rd?.redemption_id;
  ok('D: el conductor redime una desbloqueada (RPC valida km)', !rdErr && rd?.ok && !!redId, rdErr?.message);
  // no permite duplicado
  const { error: dupErr } = await drv.rpc('redeem_reward', { p_reward_id: unlocked.id });
  ok('D: no permite redimir dos veces (ALREADY_REQUESTED)', !!dupErr && /ALREADY_REQUESTED/.test(dupErr.message || ''), dupErr?.message || 'permitió duplicado');
  // admin la ve y la resuelve
  const seen = (await admin.from('reward_redemptions').select('id,status').eq('id', redId).single()).data;
  ok('D: el admin ve la solicitud (pending)', seen?.status === 'pending', seen?.status);
  await admin.from('reward_redemptions').update({ status: 'delivered', resolved_at: new Date().toISOString() }).eq('id', redId);
  ok('D: el admin la marca entregada', (await admin.from('reward_redemptions').select('status').eq('id', redId).single()).data?.status === 'delivered');

  // ---- Fase C: strikes + auto-suspensión a 3 ----
  for (let i = 0; i < 3; i++) await admin.from('driver_strikes').insert({ profile_id: uid, reason: `Strike de prueba ${i + 1}` });
  const { data: strikes, error: serr } = await drv.from('driver_strikes').select('id,voided_at,consumed_at').eq('profile_id', uid);
  ok('C: el conductor lee sus strikes (RLS)', !serr && (strikes || []).length >= 3, serr ? serr.message : `leídos=${(strikes || []).length}`);
  const susp = (await drv.from('driver_suspensions').select('id,week_start_date,source').eq('profile_id', uid)).data || [];
  ok('C: a los 3 strikes se auto-suspende (trigger crea la suspensión)', susp.length >= 1, `susp=${susp.length}${susp[0] ? ' semana ' + susp[0].week_start_date : ''}`);

} catch (e) {
  console.log('\n❌ ERROR:', e.message); out.push(false);
} finally {
  console.log('\n--- limpiando ---');
  try { if (redId) await admin.from('reward_redemptions').delete().eq('id', redId); } catch (e) {}
  try { if (uid) { await admin.from('driver_strikes').delete().eq('profile_id', uid); await admin.from('driver_suspensions').delete().eq('profile_id', uid); } } catch (e) {}
  try { if (driverId) await admin.from('shifts').delete().eq('driver_id', driverId); } catch (e) {}
  try { if (vehId) { await admin.from('maintenance').delete().eq('vehicle_id', vehId); await admin.from('vehicles').delete().eq('id', vehId); } } catch (e) {}
  try { if (uid) { await admin.from('driver_profiles').delete().eq('profile_id', uid); await admin.from('profiles').delete().eq('id', uid); await admin.auth.admin.deleteUser(uid); } } catch (e) { console.log('  (usuario sin borrar:', e.message, ')'); }
  const pass = out.filter(Boolean).length, total = out.length;
  console.log(`\n=== RESULTADO PERFIL/STRIKES/RECOMPENSAS: ${pass}/${total} PASS ${pass === total ? '🎉' : '⚠️'} ===\n`);
}
