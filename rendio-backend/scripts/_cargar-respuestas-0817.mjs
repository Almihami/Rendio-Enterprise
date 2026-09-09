// Carga las respuestas de Julián del 17-ago-2026. Idempotente.
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Cerezos NO va: en la lista dijo Fontibón y en la pregunta 19 dijo Porvenir.
const ZONAS = {
  'Boral Apartamentos':          'Porvenir',
  'Bosques del Norte':           'Fontibón',
  'Olivar Apartamentos':         'Fontibón',
  'Origen del Lago':             'Porvenir',
  'Río Vivo':                    'Fontibón',
  'Senderos de San Sebastián':   'Fontibón',
  'Forest Apartamentos':         'Porvenir',
  'Guayacán':                    'Porvenir',
  'Llanito':                     'Porvenir',
  'Solare Apartamentos':         'Porvenir',
};
for (const [name, zona] of Object.entries(ZONAS)) {
  const { error, count } = await sb.from('residences').update({ zona_jefe: zona }, { count: 'exact' }).eq('name', name);
  console.log(error ? `✗ ${name}: ${error.message}` : `✓ ${name.padEnd(28)} → ${zona}  (${count} fila)`);
}

// Conjunto nuevo: Medieval, con el pin que dio.
const { data: ej } = await sb.from('residences').select('organization_id').limit(1);
const org = ej[0].organization_id;
const { data: ya } = await sb.from('residences').select('id').eq('name', 'Medieval').maybeSingle();
if (ya) console.log('\n· Medieval ya existía');
else {
  const { error } = await sb.from('residences').insert({
    organization_id: org, name: 'Medieval',
    latitude: 6.126518292714549, longitude: -75.38605942364163,
    is_active: true,
    access_note: 'Pin dado por Julián el 17-ago-2026. Zona del jefe: sin confirmar.',
  });
  console.log(error ? `\n✗ Medieval: ${error.message}` : '\n✓ Medieval creado con su pin (zona SIN confirmar)');
}

const { data: fin } = await sb.from('residences').select('name, zona_jefe').order('name');
const con = fin.filter(r => r.zona_jefe);
console.log(`\nRESULTADO: ${fin.length} conjuntos · con zona ${con.length} · sin zona ${fin.length - con.length}`);
const porZona = {};
for (const r of con) (porZona[r.zona_jefe] ||= []).push(r.name);
for (const [z, ns] of Object.entries(porZona).sort()) console.log(`  ${z} (${ns.length}): ${ns.join(' · ')}`);
