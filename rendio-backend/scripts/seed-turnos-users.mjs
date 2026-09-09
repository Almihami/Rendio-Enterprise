#!/usr/bin/env node
// Bootstrap inicial de usuarios para el módulo rendio-turnos.
// Crea una organización (si no existe) + usuarios Auth + filas en profiles
// (+ driver_profiles para conductores).
//
// Uso:
//   set -a; source ../.env.local.dev; set +a
//   node scripts/seed-turnos-users.mjs
//
// Requiere SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY exportados.
// Lee la lista de usuarios desde ./scripts/seed-turnos-users.json
//
// Idempotente: si un usuario ya existe (mismo email), lo deja como está.

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
const seedFile = join(__dirname, 'seed-turnos-users.json');
const seed = JSON.parse(readFileSync(seedFile, 'utf-8'));

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function ensureOrganization() {
  const { data: existing } = await supabase
    .from('organizations')
    .select('id, slug, name')
    .eq('slug', seed.organization_slug)
    .maybeSingle();

  if (existing) {
    console.log(`✓ organization "${existing.slug}" ya existe (id=${existing.id})`);
    return existing.id;
  }

  const { data, error } = await supabase
    .from('organizations')
    .insert({ slug: seed.organization_slug, name: seed.organization_name, timezone: 'America/Bogota' })
    .select('id')
    .single();

  if (error) throw new Error(`No se pudo crear organization: ${error.message}`);
  console.log(`+ organization "${seed.organization_slug}" creada (id=${data.id})`);
  return data.id;
}

async function findUserByEmail(email) {
  const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (error) throw new Error(`listUsers falló: ${error.message}`);
  return data.users.find(u => u.email?.toLowerCase() === email.toLowerCase());
}

async function ensureUser(orgId, u) {
  let authUser = await findUserByEmail(u.email);

  if (!authUser) {
    const { data, error } = await supabase.auth.admin.createUser({
      email: u.email,
      password: u.password || seed.default_password,
      email_confirm: true,
      user_metadata: { full_name: u.full_name },
    });
    if (error) throw new Error(`createUser(${u.email}) falló: ${error.message}`);
    authUser = data.user;
    console.log(`+ auth user creado: ${u.email}`);
  } else {
    console.log(`✓ auth user ya existía: ${u.email}`);
  }

  const { data: prof } = await supabase
    .from('profiles')
    .select('id')
    .eq('id', authUser.id)
    .maybeSingle();

  if (!prof) {
    const { error: pErr } = await supabase.from('profiles').insert({
      id: authUser.id,
      organization_id: orgId,
      role: u.role,
      full_name: u.full_name,
      email: u.email,
    });
    if (pErr) throw new Error(`profiles insert(${u.email}) falló: ${pErr.message}`);
    console.log(`  + profile creado (${u.role})`);
  } else {
    console.log(`  ✓ profile ya existía`);
  }

  if (u.role === 'driver') {
    const { data: dp } = await supabase
      .from('driver_profiles')
      .select('id')
      .eq('profile_id', authUser.id)
      .maybeSingle();

    if (!dp) {
      const { error: dErr } = await supabase
        .from('driver_profiles')
        .insert({ profile_id: authUser.id });
      if (dErr) throw new Error(`driver_profiles insert(${u.email}) falló: ${dErr.message}`);
      console.log(`  + driver_profile creado`);
    } else {
      console.log(`  ✓ driver_profile ya existía`);
    }
  }
}

(async () => {
  try {
    console.log('Seeding rendio-turnos users…');
    const orgId = await ensureOrganization();

    for (const u of seed.users) {
      console.log(`— ${u.email}`);
      await ensureUser(orgId, u);
    }

    console.log('\nListo. Credenciales:');
    console.log(`   contraseña por defecto: ${seed.default_password}`);
    console.log(`   emails: ${seed.users.map(u => u.email).join(', ')}`);
    console.log('\nRecuerda que cualquier usuario puede cambiar su contraseña desde Supabase Auth.');
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
})();
