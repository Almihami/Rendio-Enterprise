#!/usr/bin/env node
// Verifica QUÉ usuarios siguen con la contraseña compartida (seed.default_password).
// NO muestra contraseñas (no se puede: están hasheadas). Solo prueba el login
// con la clave por defecto e informa el estado de cada uno.
//
// Uso:
//   cd rendio-backend
//   set -a; source ../.env.local.dev; set +a
//   node scripts/check-turnos-passwords.mjs
//
// Requiere SUPABASE_URL y SUPABASE_ANON_KEY (NO usa la service role).
// Solo lectura: inicia y cierra sesión, no persiste nada, no cambia datos.

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !ANON_KEY) {
  console.error('Faltan SUPABASE_URL o SUPABASE_ANON_KEY en el entorno.');
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const seed = JSON.parse(readFileSync(join(__dirname, 'seed-turnos-users.json'), 'utf-8'));
const PASSWORD = seed.default_password; // "Rendio2026"

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log(`Probando login con la clave compartida ("${PASSWORD}") — NO se muestran contraseñas.\n`);
  let conDefault = 0, cambiada = 0, errores = 0;

  for (const u of seed.users) {
    // Cliente anónimo nuevo por usuario, sin persistir sesión.
    const sb = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error } = await sb.auth.signInWithPassword({
      email: u.email,
      password: PASSWORD,
    });

    if (!error && data?.user) {
      console.log(`  ✅ ${u.email}  → sigue con la clave compartida`);
      conDefault++;
      await sb.auth.signOut();
    } else {
      const msg = (error?.message || '').toLowerCase();
      if (msg.includes('invalid login credentials')) {
        console.log(`  🔁 ${u.email}  → ya NO es la compartida (la cambió o no coincide)`);
        cambiada++;
      } else {
        console.log(`  ⚠  ${u.email}  → ${error?.message || 'error desconocido'}`);
        errores++;
      }
    }
    await sleep(400); // evita rate-limit de Auth
  }

  console.log(`\nResumen: ${conDefault} con clave compartida · ${cambiada} la cambiaron · ${errores} con error`);
  console.log('Recuerda: no se puede VER una contraseña; si alguien la olvidó, se RESETEA con scripts/reset-turnos-passwords.mjs (todos) o por usuario desde el dashboard.');
})();
