#!/usr/bin/env node
// Seed idempotente de driver_rules (descansos fijos / parametrización).
//
// Por qué existe: la migración 0020 sembraba estas reglas con un JOIN por email
// contra profiles, pero en los proyectos nuevos las migraciones corrieron ANTES
// de crear los usuarios, así que el seed no insertó nada (driver_rules quedó
// vacía y todos los conductores salían "Disponible" en verde). Este script
// re-aplica las mismas reglas una vez que los perfiles ya existen.
//
// Uso:
//   node scripts/seed-driver-rules.mjs .env.dev
//   node scripts/seed-driver-rules.mjs .env.main
//
// Idempotente: usa upsert sobre la unique (profile_id, day_of_week, shift).
// day_of_week: 0=lun, 1=mar, 2=mié, 3=jue, 4=vie, 5=sáb, 6=dom.

import { readFileSync } from 'node:fs';

// Fuente de verdad: mismas filas que el seed de migration 0020.
const RULES = [
  { email: 'juan.mery@rendio.co',     day: 1, shift: 'pm', note: 'Martes solo madruga (AM)' },
  { email: 'juan.mery@rendio.co',     day: 2, shift: 'am', note: 'Descansa miércoles' },
  { email: 'juan.mery@rendio.co',     day: 2, shift: 'pm', note: 'Descansa miércoles' },
  { email: 'juan.mery@rendio.co',     day: 3, shift: 'pm', note: 'Jueves descansa PM' },
  { email: 'andres.cardona@rendio.co', day: 4, shift: 'am', note: 'Solo lun-jue' },
  { email: 'andres.cardona@rendio.co', day: 4, shift: 'pm', note: 'Solo lun-jue' },
  { email: 'andres.cardona@rendio.co', day: 5, shift: 'am', note: 'Solo lun-jue' },
  { email: 'andres.cardona@rendio.co', day: 5, shift: 'pm', note: 'Solo lun-jue' },
  { email: 'andres.cardona@rendio.co', day: 6, shift: 'am', note: 'Solo lun-jue' },
  { email: 'andres.cardona@rendio.co', day: 6, shift: 'pm', note: 'Solo lun-jue' },
];

function loadEnv(file) {
  const t = readFileSync(file, 'utf8');
  const g = (k) => {
    const m = t.match(new RegExp('^' + k + '=(.*)$', 'm'));
    return m ? m[1].replace(/^"|"$/g, '').trim() : null;
  };
  const url = g('SUPABASE_URL');
  const key = g('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error(`Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en ${file}`);
  return { url, key };
}

async function api(url, key, path, init = {}) {
  const r = await fetch(url + '/rest/v1/' + path, {
    ...init,
    headers: { apikey: key, Authorization: 'Bearer ' + key, ...(init.headers || {}) },
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status} ${body}`);
  return body ? JSON.parse(body) : null;
}

async function main() {
  const envFile = process.argv[2];
  if (!envFile) {
    console.error('Uso: node scripts/seed-driver-rules.mjs <.env.dev|.env.main>');
    process.exit(1);
  }
  const { url, key } = loadEnv(envFile);

  // Resolver profile_id por email (una vez por email único).
  const emails = [...new Set(RULES.map((r) => r.email))];
  const idByEmail = {};
  for (const email of emails) {
    const rows = await api(url, key, `profiles?select=id,email&email=eq.${encodeURIComponent(email)}`);
    if (!rows.length) {
      console.error(`  ⚠ No existe perfil para ${email} — se omiten sus reglas.`);
      continue;
    }
    idByEmail[email] = rows[0].id;
  }

  const payload = RULES
    .filter((r) => idByEmail[r.email])
    .map((r) => ({ profile_id: idByEmail[r.email], day_of_week: r.day, shift: r.shift, note: r.note }));

  if (!payload.length) {
    console.log('No hay filas para insertar (faltan perfiles).');
    return;
  }

  // Upsert idempotente sobre la unique constraint.
  await api(url, key, 'driver_rules?on_conflict=profile_id,day_of_week,shift', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(payload),
  });

  const total = await api(url, key, 'driver_rules?select=profile_id');
  console.log(`✓ ${envFile}: upsert de ${payload.length} reglas OK. Total en driver_rules ahora: ${total.length}.`);
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
