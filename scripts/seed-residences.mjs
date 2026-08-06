#!/usr/bin/env node
// Seed del CATÁLOGO DE RESIDENCIAS (migración 0055).
//
// Los 39 conjuntos donde vive la tripulación, con la coordenada de la portería
// confirmada a mano por la operación (pines de Google Maps de Julian + la profa,
// recolectados el 5-ago-2026). NO salen de un geocodificador: OpenStreetMap solo
// conoce 4 de los 39, y en el peor caso se equivocó por 2.106 m.
//
// Uso:
//   node scripts/seed-residences.mjs .env.dev
//   node scripts/seed-residences.mjs .env.main
//
// Idempotente: upsert por (organization_id, name). Correrlo dos veces no duplica
// ni pisa nada más. NO borra residencias que no estén en la lista.
//
// La fuente de verdad legible está en Proyect/docs/catalogo-residencias.json
// (mismo dato + los 79 nombres de tripulantes + minutos a MDE).

import { readFileSync } from 'node:fs';

// nombre, lat, lng, sector (etiqueta de tablero — NO criterio de ruteo)
const RESIDENCES = [
  // — Racimo NORTE (29 pax) —
  ['Olivar Apartamentos',        6.163382, -75.374674, 'Norte'],
  ['Río Vivo',                   6.164181, -75.379851, 'Norte'],
  ['Edificio Los Cerezos',       6.164324, -75.374294, 'Norte'],
  ['Arándanos de Fontibón',      6.167218, -75.377081, 'Norte'],
  ['Urb. Manzanillos',           6.166200, -75.376548, 'Norte'],
  ['Piedemonte Apartamentos',    6.162841, -75.373898, 'Norte'],
  ['Bosques del Norte',          6.161028, -75.375861, 'Norte'],
  ['Campo Santander',            6.158218, -75.372499, 'Norte'],
  ['Senderos de San Sebastián',  6.161463, -75.371935, 'Norte'],
  // — Racimo SUR-OESTE (36 pax) —
  ['Solare Apartamentos',        6.152670, -75.389227, 'Sur-oeste'],
  ['Edificio Cámbulo',           6.153218, -75.396239, 'Sur-oeste'],
  ['Boral Apartamentos',         6.154649, -75.386709, 'Sur-oeste'],
  ['Forest Apartamentos',        6.149900, -75.397164, 'Sur-oeste'],
  ['Guayacán',                   6.153389, -75.397333, 'Sur-oeste'],
  ['Viverdi Apartamentos',       6.147920, -75.397307, 'Sur-oeste'],
  ['Origen del Lago',            6.154129, -75.389241, 'Sur-oeste'],
  ['Madero del Lago',            6.157451, -75.388881, 'Sur-oeste'],
  ['Edificio Las Margaritas',    6.150573, -75.390730, 'Sur-oeste'],
  ['Edificio Eucalipto',         6.153651, -75.396320, 'Sur-oeste'],
  ['Alto Vallejo / Loma Linda',  6.153176, -75.402009, 'Sur-oeste'],
  ['Linda Granja',               6.152000, -75.394111, 'Sur-oeste'],
  ['Llanito',                    6.148111, -75.395472, 'Sur-oeste'],
  ['Casa azul Llanito',          6.151111, -75.395889, 'Sur-oeste'],
  ['Tejo',                       6.149389, -75.391861, 'Sur-oeste'],
  ['Campus Reservado',           6.148482, -75.397905, 'Sur-oeste'],
  ['Séptima',                    6.148139, -75.385500, 'Sur-oeste'],
  ['Quintas Blancas',            6.149722, -75.382417, 'Sur-oeste'],
  ['Quintas Amarillas',          6.151028, -75.380806, 'Sur-oeste'],
  // — Sur disperso —
  ['Edificio Sendai',            6.140138, -75.377608, 'Sur'],
  ['Ébano Apartamentos',         6.129368, -75.378543, 'Sur'],
  ['Club Verde Terra',           6.137082, -75.371337, 'Sur'],
  ['Torres del Campo',           6.140480, -75.372380, 'Sur'],
  // — Oriente: los caros. Nunca mezclar con Rionegro (medido: +50 min) —
  ['Urb. Bosque Robledal',       6.159095, -75.359778, 'Oriente'],
  ['Condominio Planté',          6.169238, -75.349558, 'Oriente'],
  ['Marinilla centro',           6.175528, -75.334667, 'Oriente'],
  ['Marinilla vereda',           6.161111, -75.322722, 'Oriente'],
  // — Llanogrande / Rosal —
  ['Portón del Rosal',           6.147250, -75.365083, 'Rosal'],
  ['Llanogrande',                6.128139, -75.417556, 'Llanogrande'],
  ['Rincones de Llanogrande',    6.118198, -75.402665, 'Llanogrande'],
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
    console.error('Uso: node scripts/seed-residences.mjs <.env.dev|.env.main>');
    process.exit(1);
  }
  const { url, key } = loadEnv(envFile);

  const orgs = await api(url, key, 'organizations?select=id&limit=1');
  if (!orgs || !orgs.length) throw new Error('No hay organización en este proyecto.');
  const orgId = orgs[0].id;

  const rows = RESIDENCES.map(([name, latitude, longitude, sector]) => ({
    organization_id: orgId, name, latitude, longitude, sector, is_active: true,
  }));

  await api(url, key, 'residences?on_conflict=organization_id,name', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });

  const all = await api(url, key, `residences?select=name,sector,latitude,longitude&organization_id=eq.${orgId}&order=sector,name`);
  console.log(`✓ ${envFile}: catálogo sembrado. Residencias en la org: ${all.length}`);
  let sec = null;
  for (const r of all) {
    if (r.sector !== sec) { sec = r.sector; console.log(`\n  [${sec}]`); }
    console.log(`   ${r.name.padEnd(28)} ${r.latitude.toFixed(6)}, ${r.longitude.toFixed(6)}`);
  }
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
