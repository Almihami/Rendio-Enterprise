#!/usr/bin/env node
// Resetea la contraseña de todos los usuarios de rendio-turnos a
// seed.default_password (fuente de verdad: seed-turnos-users.json).
//
// Uso:
//   set -a; source ../.env.local.dev; set +a
//   node scripts/reset-turnos-passwords.mjs
//
// Requiere SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY exportados.
// Idempotente: si el usuario no existe, lo reporta y sigue.

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
    console.log(`Reseteando contraseñas a: ${seed.default_password}`);
    const authUsers = await listAllAuthUsers();
    const byEmail = new Map(authUsers.map(u => [u.email?.toLowerCase(), u]));

    let ok = 0, missing = 0;
    for (const u of seed.users) {
      const au = byEmail.get(u.email.toLowerCase());
      if (!au) {
        console.log(`  ✗ no existe en Auth: ${u.email}`);
        missing++;
        continue;
      }
      const { error } = await supabase.auth.admin.updateUserById(au.id, {
        password: seed.default_password,
      });
      if (error) throw new Error(`updateUserById(${u.email}) falló: ${error.message}`);
      console.log(`  ✓ ${u.email}`);
      ok++;
    }

    console.log(`\nListo. Actualizados: ${ok} · No encontrados: ${missing}`);
    console.log(`Nueva contraseña (todos): ${seed.default_password}`);
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
})();
