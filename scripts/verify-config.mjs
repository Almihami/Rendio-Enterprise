// Verifica Lote 1/2: intervalo de mantto editable + strike_limit configurable.
// Throwaway. Uso: cd scripts; set -a; source ../.env.dev; set +a; node verify-config.mjs
import { createClient } from '@supabase/supabase-js';
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const out = []; const ok = (n, c, d = '') => { out.push(!!c); console.log(`${c ? '✅ PASS' : '❌ FAIL'}  ${n}${d ? '  — ' + d : ''}`); };
const nextMonday = () => { const d = new Date(); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow + 7); return d.toISOString().slice(0, 10); };

console.log('\n=== VERIFICACIÓN CONFIG (intervalo mantto + strike_limit) ===\n');
const stamp = Date.now();
let uid, vehId, org, prevLimit;
try {
  org = (await admin.from('profiles').select('organization_id').not('organization_id', 'is', null).limit(1).single()).data.organization_id;

  // --- strike_limit configurable: bajamos a 2 y validamos que suspenda con 2 ---
  prevLimit = (await admin.from('app_settings').select('strike_limit').eq('id', 'singleton').single()).data?.strike_limit;
  await admin.from('app_settings').update({ strike_limit: 2 }).eq('id', 'singleton');
  ok('strike_limit guardable en app_settings', (await admin.from('app_settings').select('strike_limit').eq('id', 'singleton').single()).data?.strike_limit === 2);

  uid = (await admin.auth.admin.createUser({ email: `vcfg+${stamp}@rendio.test`, password: 'VerifyTest!2026', email_confirm: true })).data.user.id;
  await admin.from('profiles').insert({ id: uid, organization_id: org, role: 'driver', full_name: 'VERIFY CFG', email: `vcfg+${stamp}@rendio.test`, is_active: true });
  await admin.from('driver_profiles').insert({ profile_id: uid });
  for (let i = 0; i < 2; i++) await admin.from('driver_strikes').insert({ profile_id: uid, reason: `cfg ${i + 1}` });
  const susp = (await admin.from('driver_suspensions').select('id').eq('profile_id', uid)).data || [];
  ok('Trigger usa strike_limit configurable (2 strikes → suspende)', susp.length >= 1, `susp=${susp.length}`);

  // --- intervalo de mantto editable por vehículo ---
  vehId = (await admin.from('vehicles').insert({ organization_id: org, internal_code: `VCFG-${stamp}`, license_plate: `G${String(stamp).slice(-6)}`, capacity: 4, current_km: 1000, last_maintenance_km: 1000, maintenance_interval_km: 7000, status: 'available' }).select('id').single()).data.id;
  await admin.from('vehicles').update({ maintenance_interval_km: 3500, current_km: 2000, last_maintenance_km: 1500 }).eq('id', vehId);
  const v = (await admin.from('vehicles').select('maintenance_interval_km,current_km,last_maintenance_km').eq('id', vehId).single()).data;
  ok('Intervalo de mantto editable (updateVehicle)', v.maintenance_interval_km === 3500 && v.current_km === 2000, JSON.stringify(v));

} catch (e) { console.log('\n❌ ERROR:', e.message); out.push(false); }
finally {
  console.log('\n--- limpiando ---');
  try { if (prevLimit != null) await admin.from('app_settings').update({ strike_limit: prevLimit }).eq('id', 'singleton'); } catch (e) {}
  try { if (uid) { await admin.from('driver_strikes').delete().eq('profile_id', uid); await admin.from('driver_suspensions').delete().eq('profile_id', uid); await admin.from('driver_profiles').delete().eq('profile_id', uid); await admin.from('profiles').delete().eq('id', uid); await admin.auth.admin.deleteUser(uid); } } catch (e) {}
  try { if (vehId) await admin.from('vehicles').delete().eq('id', vehId); } catch (e) {}
  const pass = out.filter(Boolean).length, total = out.length;
  console.log(`\n=== RESULTADO CONFIG: ${pass}/${total} PASS ${pass === total ? '🎉' : '⚠️'} · strike_limit restaurado a ${prevLimit} ===\n`);
}
