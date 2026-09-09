#!/usr/bin/env node
// Reset de DATOS DE PRUEBA de rendio-turnos (arranque limpio).
// Borra TODAS las filas de:
//   - approval_requests   (solicitudes)
//   - driver_availability (marcas de disponibilidad de los conductores)
//   - weekly_schedules    (horarios generados/publicados)
//
// NO toca: app_settings (cupos/labels), profiles, auth.users, organizations.
// Nada de usuarios ni configuración se pierde — solo la data operativa de prueba.
//
// Uso:
//   cd rendio-backend
//   set -a; source ../.env.local.dev; set +a
//   node scripts/reset-turnos-data.mjs           # DRY-RUN: solo muestra conteos
//   node scripts/reset-turnos-data.mjs --apply   # BORRA de verdad
//
// Requiere SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY exportados.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en el entorno.');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');
const TABLES = ['approval_requests', 'driver_availability', 'weekly_schedules'];

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function countRows(table) {
  const { count, error } = await supabase
    .from(table)
    .select('*', { count: 'exact', head: true });
  if (error) throw new Error(`count ${table} falló: ${error.message}`);
  return count ?? 0;
}

(async () => {
  try {
    console.log(`Proyecto: ${SUPABASE_URL}`);
    console.log(APPLY ? '⚠️  MODO --apply: SE VA A BORRAR\n' : 'DRY-RUN (no borra nada; usa --apply para borrar)\n');

    const before = {};
    for (const t of TABLES) before[t] = await countRows(t);
    console.log('Filas actuales:');
    TABLES.forEach(t => console.log(`  ${t}: ${before[t]}`));

    if (!APPLY) {
      const total = TABLES.reduce((s, t) => s + before[t], 0);
      console.log(`\nDRY-RUN: se borrarían ${total} filas en total. Re-ejecuta con --apply para hacerlo.`);
      console.log('NO se tocan: app_settings, profiles, auth.users, organizations.');
      return;
    }

    console.log('\nBorrando…');
    for (const t of TABLES) {
      // Filtro que matchea todas las filas (todo id uuid es NOT NULL).
      const { error } = await supabase.from(t).delete().not('id', 'is', null);
      if (error) throw new Error(`delete ${t} falló: ${error.message}`);
      const left = await countRows(t);
      console.log(`  ${t}: ${before[t]} → ${left} ${left === 0 ? '✓' : '⚠ quedaron filas'}`);
    }

    console.log('\nListo. Datos de prueba limpiados. Usuarios y configuración (app_settings) intactos.');
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
})();
