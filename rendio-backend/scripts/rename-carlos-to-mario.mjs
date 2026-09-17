#!/usr/bin/env node
// Cambio puntual de correo: carlos.roldan@rendio.co → mario.roldan@rendio.co
// (Carlos Mario Roldan Valencia usa "Mario"). NO toca la contraseña ni
// ningún otro usuario. Carlos NO es conductor con regla hardcode, así que
// el cambio no afecta ninguna lógica (todo va por profile_id).
//
// Uso:
//   cd rendio-backend
//   set -a; source ../.env.local.dev; set +a
//   node scripts/rename-carlos-to-mario.mjs          # DRY-RUN (no cambia nada)
//   node scripts/rename-carlos-to-mario.mjs --apply   # aplica
//
// Idempotente y seguro:
//  - Si ya está migrado (ya es mario.roldan) → no hace nada.
//  - Si el correo nuevo lo ocupa un placeholder soft-deleted/huérfano → lo
//    aparca (deprecated.<id>@rendio.invalid), no lo borra.
//  - Si lo ocupa un PERFIL ACTIVO distinto → ABORTA sin tocar nada.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en el entorno.');
  process.exit(1);
}

const OLD = 'carlos.roldan@rendio.co';
const NEW = 'mario.roldan@rendio.co';
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
    console.log(APPLY ? '⚠️  MODO --apply\n' : 'DRY-RUN (no cambia nada; usa --apply para aplicar)\n');

    const users = await listAllAuthUsers();
    const byEmail = new Map(users.map(u => [u.email?.toLowerCase(), u]));
    const oldU = byEmail.get(OLD);
    const newU = byEmail.get(NEW);

    if (!oldU && newU) {
      console.log(`✓ Ya estaba migrado: ${NEW} (id=${newU.id}). Nada que hacer.`);
      return;
    }
    if (!oldU) {
      console.log(`✗ No existe en Auth ${OLD} (ni ${NEW}). Reviso manualmente.`);
      process.exit(1);
    }

    let park = null;
    if (newU && newU.id !== oldU.id) {
      const { data: p } = await supabase
        .from('profiles').select('id, full_name, deleted_at').eq('id', newU.id).maybeSingle();
      const parkable = !p || !!p.deleted_at;
      if (!parkable) {
        console.error(`COLISIÓN REAL: ${NEW} lo tiene un PERFIL ACTIVO (${p.full_name}, id=${newU.id}). Abortado.`);
        process.exit(1);
      }
      park = { id: newU.id, to: `deprecated.${newU.id.split('-')[0]}@rendio.invalid`,
               who: p ? `${p.full_name} (borrado)` : 'huérfano sin perfil' };
    }

    console.log(`Cambio: ${OLD}  →  ${NEW}  (Carlos Mario Roldan Valencia, id=${oldU.id})`);
    if (park) console.log(`Aparcar placeholder en ${NEW}: → ${park.to}  [${park.who}]`);
    console.log('La contraseña NO se toca.');

    if (!APPLY) { console.log('\nDRY-RUN: re-ejecuta con --apply para hacerlo.'); return; }

    if (park) {
      const { error } = await supabase.auth.admin.updateUserById(park.id, { email: park.to, email_confirm: true });
      if (error) throw new Error(`aparcar placeholder falló: ${error.message}`);
      console.log(`  ⤷ placeholder aparcado → ${park.to}`);
    }
    const { error: aErr } = await supabase.auth.admin.updateUserById(oldU.id, { email: NEW, email_confirm: true });
    if (aErr) throw new Error(`auth update falló: ${aErr.message}`);
    const { error: pErr } = await supabase.from('profiles').update({ email: NEW }).eq('id', oldU.id);
    if (pErr) throw new Error(`profiles update falló: ${pErr.message}`);

    console.log(`\n✓ Listo: ahora entra con ${NEW} (misma contraseña de antes).`);
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
})();
