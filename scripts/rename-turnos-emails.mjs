#!/usr/bin/env node
// Renombra los correos de los conductores de rendio-turnos al formato
// nombre.primerapellido@rendio.co y deja la contraseña en Rendio2026.
//
// Uso:
//   cd rendio-backend
//   set -a; source ../.env.local.dev; set +a
//   node scripts/rename-turnos-emails.mjs
//
// Requiere SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY exportados.
//
// SEGURO E IDEMPOTENTE:
//  - Mapa OLD→NEW explícito (no se adivina el apellido) → cero ambigüedad.
//  - Si un correo objetivo lo ocupa un PLACEHOLDER soft-deleted (o una cuenta
//    Auth sin perfil), lo "aparca" (le cambia el correo a
//    deprecated.<id>@rendio.invalid) — NO borra cuentas, es reversible.
//  - Si el correo objetivo lo ocupa un PERFIL ACTIVO distinto → ABORTA
//    (colisión real; no debería pasar con el mapa actual).
//  - Solo toca auth.users (email/password/email_confirm) y profiles.email.
//    Disponibilidad, solicitudes y horarios van por profile_id (uuid) → la
//    lógica/condiciones NO se ven afectadas. Las constantes hardcode
//    (scheduler.js / app.js) ya fueron actualizadas a los correos nuevos.

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
const PASSWORD = seed.default_password; // "Rendio2026"

const RENAMES = [
  { old: 'juanandrescdn@gmail.com',        nuevo: 'juan.mery@rendio.co',         nombre: 'Juan Andres Mery Franco' },
  { old: 'andresarias51842@gmail.com',     nuevo: 'andres.cardona@rendio.co',    nombre: 'Andres Felipe Cardona Arias' },
  { old: 'jeffcardona54@gmail.com',        nuevo: 'jefferson.cardona@rendio.co', nombre: 'Jefferson Cardona Arias' },
  { old: 'danielgmr203851@gmail.com',      nuevo: 'daniel.alvarez@rendio.co',    nombre: 'Daniel Alvarez Torres' },
  { old: 'francojuanjose152001@gmail.com', nuevo: 'juan.franco@rendio.co',       nombre: 'Juan Jose Franco' },
  { old: 'sebastiangoci@gmail.com',        nuevo: 'sebastian.gomez@rendio.co',   nombre: 'Sebastian Gomez Ciro' },
  { old: 'roldanvalencia090224@gmail.com', nuevo: 'carlos.roldan@rendio.co',     nombre: 'Carlos Mario Roldan Valencia' },
  { old: 'juanjogc789@gmail.com',          nuevo: 'juan.cardona@rendio.co',      nombre: 'Juan Jose Cardona' },
];

const ADMINS = seed.users.filter(u => u.role === 'admin').map(u => u.email);

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

async function fetchProfiles(ids) {
  const map = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data, error } = await supabase
      .from('profiles')
      .select('id, full_name, role, deleted_at')
      .in('id', chunk);
    if (error) throw new Error(`profiles select falló: ${error.message}`);
    (data || []).forEach(p => map.set(p.id, p));
  }
  return map;
}

(async () => {
  try {
    const authUsers = await listAllAuthUsers();
    const byEmail = new Map(authUsers.map(u => [u.email?.toLowerCase(), u]));
    const profById = await fetchProfiles(authUsers.map(u => u.id));

    // ¿El ocupante de un correo es un placeholder seguro de aparcar?
    const isParkable = (au) => {
      const p = profById.get(au.id);
      return !p || !!p.deleted_at; // sin perfil (huérfano) o soft-deleted
    };

    let renamed = 0, already = 0, parked = 0, missing = 0, pwOnly = 0;

    console.log('— Conductores: correo nuevo + contraseña —');
    for (const r of RENAMES) {
      const oldU = byEmail.get(r.old.toLowerCase());
      const newU = byEmail.get(r.nuevo.toLowerCase());

      // Caso ya migrado: el correo nuevo lo tiene el perfil real, old no existe.
      if (!oldU && newU && !isParkable(newU)) {
        const { error } = await supabase.auth.admin.updateUserById(newU.id, { password: PASSWORD });
        if (error) throw new Error(`password(${r.nombre}) falló: ${error.message}`);
        await supabase.from('profiles').update({ email: r.nuevo }).eq('id', newU.id);
        console.log(`  ✓ ya estaba: ${r.nuevo} (${r.nombre})`);
        already++;
        continue;
      }

      if (!oldU) {
        console.log(`  ✗ no existe en Auth (ni ${r.old} ni ${r.nuevo} activo) — ${r.nombre}`);
        missing++;
        continue;
      }

      // El correo nuevo está ocupado por OTRA cuenta → aparcarla o abortar.
      if (newU && newU.id !== oldU.id) {
        if (!isParkable(newU)) {
          throw new Error(
            `COLISIÓN REAL: ${r.nuevo} lo tiene un PERFIL ACTIVO (id=${newU.id}). ` +
            `Abortado sin tocar nada para ${r.nombre}. Revisar manualmente.`
          );
        }
        const aparcado = `deprecated.${newU.id.split('-')[0]}@rendio.invalid`;
        const { error: parkErr } = await supabase.auth.admin.updateUserById(newU.id, {
          email: aparcado,
          email_confirm: true,
        });
        if (parkErr) throw new Error(`aparcar placeholder(${r.nuevo}) falló: ${parkErr.message}`);
        console.log(`  ⤷ aparcado placeholder ${r.nuevo} → ${aparcado} (id=${newU.id})`);
        parked++;
      }

      // Renombrar al conductor real + password + email confirmado.
      const { error: aErr } = await supabase.auth.admin.updateUserById(oldU.id, {
        email: r.nuevo,
        password: PASSWORD,
        email_confirm: true,
      });
      if (aErr) throw new Error(`auth update(${r.nombre}) falló: ${aErr.message}`);

      const { error: pErr } = await supabase
        .from('profiles')
        .update({ email: r.nuevo })
        .eq('id', oldU.id);
      if (pErr) throw new Error(`profiles update(${r.nombre}) falló: ${pErr.message}`);

      console.log(`  ✓ ${r.old}  →  ${r.nuevo}  (${r.nombre})`);
      renamed++;
    }

    console.log('— Admins: solo re-reset de contraseña —');
    for (const email of ADMINS) {
      const au = byEmail.get(email.toLowerCase());
      if (!au) { console.log(`  ✗ no existe en Auth: ${email}`); missing++; continue; }
      const { error } = await supabase.auth.admin.updateUserById(au.id, { password: PASSWORD });
      if (error) throw new Error(`password reset(${email}) falló: ${error.message}`);
      console.log(`  ✓ ${email}`);
      pwOnly++;
    }

    console.log(`\nListo. Renombrados: ${renamed} · Ya estaban: ${already} · Placeholders aparcados: ${parked} · Solo password: ${pwOnly} · No encontrados: ${missing}`);
    console.log(`Contraseña (todos): ${PASSWORD}`);
    if (missing) console.log('⚠ Revisa los "no encontrados" antes de dar por cerrado.');
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
})();
