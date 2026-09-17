#!/usr/bin/env node
// Seed de la FLOTA real de vehículos.
// Inserta (o actualiza, idempotente) los carros de la organización por placa.
//
// Uso:
//   node scripts/seed-vehicles.mjs .env.dev
//   node scripts/seed-vehicles.mjs .env.main
//
// Idempotente: upsert por (organization_id, license_plate). Correrlo dos veces
// no duplica. No borra vehículos existentes que no estén en la lista.

import { readFileSync } from 'node:fs';

// Flota real de producción (Main). internal_code = placa para garantizar unicidad.
const VEHICLES = [
  { license_plate: 'HNV760', internal_code: 'HNV760', brand: 'Chevrolet', model: 'Sail', year: 2014, capacity: 4 },
  { license_plate: 'HYU376', internal_code: 'HYU376', brand: 'Chevrolet', model: 'Sail', year: 2018, capacity: 4 },
  { license_plate: 'LFO714', internal_code: 'LFO714', brand: 'Hyundai',   model: 'Kona', year: 2025, capacity: 4 },
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
    console.error('Uso: node scripts/seed-vehicles.mjs <.env.dev|.env.main>');
    process.exit(1);
  }
  const { url, key } = loadEnv(envFile);

  // Organización (asumimos una sola en este despliegue).
  const orgs = await api(url, key, 'organizations?select=id&limit=1');
  if (!orgs || !orgs.length) throw new Error('No hay organización en este proyecto.');
  const orgId = orgs[0].id;

  const rows = VEHICLES.map((v) => ({ organization_id: orgId, status: 'available', ...v }));

  // Upsert por (organization_id, license_plate): inserta o actualiza, sin duplicar.
  await api(url, key, 'vehicles?on_conflict=organization_id,license_plate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });

  const all = await api(url, key, `vehicles?select=license_plate,brand,model,year,status&organization_id=eq.${orgId}&deleted_at=is.null`);
  console.log(`✓ ${envFile}: flota sembrada. Vehículos en la org: ${all.length}`);
  for (const v of all) console.log(`   ${v.license_plate} — ${v.brand} ${v.model} ${v.year} [${v.status}]`);
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
