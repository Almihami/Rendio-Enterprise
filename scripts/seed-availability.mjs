#!/usr/bin/env node
// Siembra disponibilidad "available" (AM y PM, los 7 días) para TODOS los
// conductores, como si hubieran llenado su disponibilidad. Útil para probar el
// generador de horario en DEV sin esperar a que cada conductor llene.
//
// Uso (desde rendio-backend/):
//   set -a; source ../.env.local.dev; set +a
//   node scripts/seed-availability.mjs                 # semana actual + próxima
//   node scripts/seed-availability.mjs 2026-06-08      # una semana específica (lunes ISO)
//   node scripts/seed-availability.mjs 2026-06-08 2026-06-15
//
// Requiere SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en el entorno.
// GUARD: aborta si la URL no es la de rendio-DEV (no toca main).
// Sin dependencias: usa fetch + PostgREST (upsert).

const DEV_REF = 'lxlphbafhtphulanhzlp'; // rendio-DEV — guard anti-main
const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL || !KEY) {
  console.error('✗ Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY. Corré:  set -a; source ../.env.local.dev; set +a');
  process.exit(1);
}
if (!URL.includes(DEV_REF)) {
  console.error(`✗ ABORTADO: SUPABASE_URL no es rendio-DEV (esperaba que contuviera "${DEV_REF}"). No se toca otro ambiente.`);
  console.error(`  URL actual: ${URL.replace(/https?:\/\//, '').split('.')[0]}…`);
  process.exit(1);
}

// Lunes (ISO) de la semana que contiene `d`.
function startOfWeekISO(d) {
  const x = new Date(d);
  const day = x.getDay();                 // 0=Dom
  const diff = x.getDate() - day + (day === 0 ? -6 : 1);
  x.setDate(diff); x.setHours(0, 0, 0, 0);
  return x.toISOString().slice(0, 10);
}
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// Semanas objetivo: argv si las pasan, si no la actual + la próxima.
const argWeeks = process.argv.slice(2).filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s)).map(startOfWeekISO);
const thisMon = startOfWeekISO(new Date());
const weeks = argWeeks.length ? [...new Set(argWeeks)] : [thisMon, addDays(thisMon, 7)];

const headers = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  'Content-Type': 'application/json',
};

async function getDrivers() {
  const res = await fetch(`${URL}/rest/v1/profiles?select=id,full_name&role=eq.driver&deleted_at=is.null`, { headers });
  if (!res.ok) throw new Error(`GET profiles ${res.status}: ${await res.text()}`);
  return res.json();
}

async function upsert(rows, withPref = true) {
  const body = withPref ? rows : rows.map(({ shift_pref, ...r }) => r);
  const res = await fetch(`${URL}/rest/v1/driver_availability?on_conflict=profile_id,week_start_date,day_of_week`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    // Fallback si la columna shift_pref no existe en este ambiente (0015 no aplicada).
    if (withPref && /shift_pref/.test(txt)) return upsert(rows, false);
    throw new Error(`upsert ${res.status}: ${txt}`);
  }
}

(async () => {
  console.log(`→ DEV (${DEV_REF}). Semanas: ${weeks.join(', ')}`);
  const drivers = await getDrivers();
  if (!drivers.length) { console.error('✗ No hay conductores (role=driver) en dev.'); process.exit(1); }
  console.log(`→ ${drivers.length} conductores: ${drivers.map(d => d.full_name).join(', ')}`);

  const rows = [];
  for (const wk of weeks) {
    for (const d of drivers) {
      for (let dow = 0; dow < 7; dow++) {
        rows.push({
          profile_id: d.id,
          week_start_date: wk,
          day_of_week: dow,
          am_state: 'available',
          pm_state: 'available',
          am_reason: null,
          pm_reason: null,
          shift_pref: 'any',
        });
      }
    }
  }

  // Por lotes para no mandar un body gigante.
  const BATCH = 200;
  for (let i = 0; i < rows.length; i += BATCH) {
    await upsert(rows.slice(i, i + BATCH));
    console.log(`  ✓ ${Math.min(i + BATCH, rows.length)}/${rows.length} filas`);
  }

  console.log(`\n✓ Listo: ${drivers.length} conductores × ${weeks.length} semana(s) × 7 días = ${rows.length} filas "available" en dev.`);
  console.log('  Abrí Horario en esas semanas y dale Generar.');
})().catch(e => { console.error('✗ Error:', e.message); process.exit(1); });
