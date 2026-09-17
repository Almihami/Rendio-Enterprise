#!/usr/bin/env node
// SOLO LECTURA. No cambia ni borra nada.
// Reporta, para cada correo NUEVO objetivo, si ya está ocupado en Auth y por
// quién (placeholder soft-deleted vs perfil real activo). También muestra qué
// correos viejos siguen presentes (lo que falta migrar).
//
// Uso:
//   cd rendio-backend
//   set -a; source ../.env.local.dev; set +a
//   node scripts/check-turnos-email-conflicts.mjs

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

const PAIRS = [
  { old: 'juanandrescdn@gmail.com',        nuevo: 'juan.mery@rendio.co' },
  { old: 'andresarias51842@gmail.com',     nuevo: 'andres.cardona@rendio.co' },
  { old: 'jeffcardona54@gmail.com',        nuevo: 'jefferson.cardona@rendio.co' },
  { old: 'danielgmr203851@gmail.com',      nuevo: 'daniel.alvarez@rendio.co' },
  { old: 'francojuanjose152001@gmail.com', nuevo: 'juan.franco@rendio.co' },
  { old: 'sebastiangoci@gmail.com',        nuevo: 'sebastian.gomez@rendio.co' },
  { old: 'roldanvalencia090224@gmail.com', nuevo: 'carlos.roldan@rendio.co' },
  { old: 'juanjogc789@gmail.com',          nuevo: 'juan.cardona@rendio.co' },
];

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
    const authUsers = await listAllAuthUsers();
    const byEmail = new Map(authUsers.map(u => [u.email?.toLowerCase(), u]));

    // Trae perfiles (incluye borrados) para clasificar al ocupante.
    const ids = authUsers.map(u => u.id);
    const profById = new Map();
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, role, email, deleted_at')
        .in('id', chunk);
      if (error) throw new Error(`profiles select falló: ${error.message}`);
      (data || []).forEach(p => profById.set(p.id, p));
    }

    const classify = (au) => {
      if (!au) return 'LIBRE';
      const p = profById.get(au.id);
      if (!p) return 'AUTH SIN PERFIL (huérfano)';
      if (p.deleted_at) return `PLACEHOLDER BORRADO (${p.full_name}, ${p.role})`;
      return `PERFIL ACTIVO (${p.full_name}, ${p.role})`;
    };

    console.log('=== ¿El correo NUEVO ya está ocupado? ===');
    for (const { old, nuevo } of PAIRS) {
      const occ = byEmail.get(nuevo.toLowerCase());
      const oldU = byEmail.get(old.toLowerCase());
      const estado = !oldU && occ ? 'YA MIGRADO' : (oldU ? 'PENDIENTE (old existe)' : 'OLD no existe');
      console.log(`\n${nuevo}`);
      console.log(`  ocupado por : ${classify(occ)}${occ ? ' · id=' + occ.id : ''}`);
      console.log(`  old (${old}): ${oldU ? 'existe · id=' + oldU.id : 'no existe'} → ${estado}`);
    }

    console.log('\n=== Placeholders @rendio.co soft-deleted en Auth (posibles estorbos) ===');
    authUsers
      .filter(u => (u.email || '').endsWith('@rendio.co'))
      .forEach(u => {
        const p = profById.get(u.id);
        if (p && p.deleted_at) console.log(`  ${u.email}  ·  ${p.full_name} (${p.role})  ·  id=${u.id}`);
      });
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
})();
