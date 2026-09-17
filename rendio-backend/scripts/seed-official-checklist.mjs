#!/usr/bin/env node
// Seed del CHECKLIST DIARIO OFICIAL de vehículo (27 ítems, 6 secciones).
// Reemplaza los ítems de checklist de la organización por los oficiales que
// entregaron los jefes. Requiere migración 0028 (columna category).
//
// Uso:
//   node scripts/seed-official-checklist.mjs .env.dev
//   node scripts/seed-official-checklist.mjs .env.main
//
// Idempotente: borra los ítems existentes de la org e inserta los 27 oficiales.
// (Las inspecciones históricas guardan su propio snapshot del checklist en
// inspections.checklist jsonb, así que borrar ítems no afecta el historial.)

import { readFileSync } from 'node:fs';

// Fuente de verdad: el documento oficial. Orden = sort_order (1..27).
const SECTIONS = [
  ['Exterior', [
    ['No presenta golpes o daños nuevos', 'Si hay golpe, adjunta una foto del daño.'],
    ['Vidrios y espejos en buen estado', null],
    ['Luces delanteras funcionando', null],
    ['Luces traseras funcionando', null],
    ['Direccionales funcionando', null],
    ['Luces de freno funcionando', null],
    ['Placa visible y en buen estado', null],
  ]],
  ['Llantas', [
    ['Llanta de repuesto disponible', null],
    ['Llantas sin cortes, deformaciones o desgaste excesivo', null],
  ]],
  ['Niveles y motor', [
    ['Nivel de aceite correcto', null],
    ['Nivel de refrigerante correcto', null],
    ['Nivel de líquido de frenos correcto', null],
    ['Sin fugas visibles debajo del vehículo', null],
    ['Batería en buen estado visiblemente', null],
  ]],
  ['Seguridad', [
    ['Extintor vigente y accesible', null],
    ['Kit de carretera visiblemente completo', null],
    ['Cinturones de seguridad funcionando', null],
    ['Pito funcionando', null],
  ]],
  ['Operación', [
    ['Frenos responden correctamente', null],
    ['Dirección sin anomalías', null],
    ['Aire acondicionado funcionando', null],
    ['Tablero sin alertas encendidas', null],
    ['Combustible suficiente para la jornada', null],
  ]],
  ['Documentación', [
    ['SOAT vigente', null],
    ['Revisión técnico-mecánica vigente', null],
    ['Tarjeta de propiedad disponible', null],
    ['Documentos requeridos por la empresa disponibles', null],
  ]],
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
    console.error('Uso: node scripts/seed-official-checklist.mjs <.env.dev|.env.main>');
    process.exit(1);
  }
  const { url, key } = loadEnv(envFile);

  // Organización (asumimos una sola en este despliegue).
  const orgs = await api(url, key, 'organizations?select=id&limit=1');
  if (!orgs || !orgs.length) throw new Error('No hay organización en este proyecto.');
  const orgId = orgs[0].id;

  // Construir las 27 filas con su sección y orden.
  const rows = [];
  let order = 1;
  for (const [category, items] of SECTIONS) {
    for (const [label, hint] of items) {
      rows.push({ organization_id: orgId, label, hint, category, sort_order: order++, is_active: true });
    }
  }

  // Reemplazo idempotente: borrar los existentes de la org, insertar los oficiales.
  await api(url, key, `inspection_checklist_items?organization_id=eq.${orgId}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' },
  });
  await api(url, key, 'inspection_checklist_items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(rows),
  });

  const total = await api(url, key, `inspection_checklist_items?select=id&organization_id=eq.${orgId}`);
  console.log(`✓ ${envFile}: checklist oficial sembrado. Ítems en la org ahora: ${total.length} (esperado 27).`);
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
