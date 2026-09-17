#!/usr/bin/env node
// Pone la contraseña compartida (seed.default_password) a TODOS los
// conductores (role = 'driver'). NO toca a los admins.
//
// Uso:
//   cd rendio-backend
//   set -a; source ../.env.local.dev; set +a
//   node scripts/reset-turnos-driver-passwords.mjs           # DRY-RUN
//   node scripts/reset-turnos-driver-passwords.mjs --apply    # aplica
//
// Requiere SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.
// Idempotente. OJO: sobreescribe la contraseña aunque el conductor ya se
// la hubiera cambiado (es lo pedido: todos a la compartida).

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en el entorno.');
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const seed = JSON.parse(readFileSync(join(__dirname, 'seed-turnos-users.json'), 'utf-8'));
const PASSWORD = seed.default_password; // "Rendio2026*"
const DRIVERS = seed.users.filter(u => u.role === 'driver');
const APPLY = process.argv.includes('--apply');

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function listAllAuthUsers() {
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers falló: ${error.message}`);
    all.push(...data.users);
    if (data.users.length < 200) break;
  }
  return all;
}

(async () => {
  try {
    console.log(`Proyecto: ${SUPABASE_URL}`);
    console.log(`Contraseña objetivo (conductores): "${PASSWORD}"`);
    console.log(APPLY ? '⚠️  MODO --apply: SE VA A CAMBIAR\n' : 'DRY-RUN (no cambia nada; usa --apply para aplicar)\n');

    const authUsers = await listAllAuthUsers();
    const byEmail = new Map(authUsers.map(u => [u.email?.toLowerCase(), u]));

    let okCount = 0, missing = 0;
    for (const u of DRIVERS) {
      const au = byEmail.get(u.email.toLowerCase());
      if (!au) { console.log(`  ✗ no existe en Auth: ${u.email} (${u.full_name})`); missing++; continue; }
      if (!APPLY) { console.log(`  • ${u.email} (${u.full_name}) → quedaría con "${PASSWORD}"`); okCount++; continue; }
      const { error } = await supabase.auth.admin.updateUserById(au.id, { password: PASSWORD });
      if (error) throw new Error(`updateUserById(${u.email}) falló: ${error.message}`);
      console.log(`  ✓ ${u.email} (${u.full_name})`);
      okCount++;
    }

    console.log(`\n${APPLY ? 'Cambiados' : 'Se cambiarían'}: ${okCount} conductores · No encontrados: ${missing}`);
    console.log(`Admins NO tocados (siguen con su contraseña actual).`);
    if (!APPLY) console.log('Re-ejecuta con --apply para aplicar.');
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
})();
