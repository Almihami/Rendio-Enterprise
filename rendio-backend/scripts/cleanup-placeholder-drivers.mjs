#!/usr/bin/env node
// Borrado suave de los conductores placeholder del seed viejo (@rendio.co).
// Solo toca esos 6 correos exactos y role=driver. Idempotente.
//
// Uso:
//   set -a; source ../.env.local.dev; set +a
//   node scripts/cleanup-placeholder-drivers.mjs

import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const PLACEHOLDERS = [
  'jefferson@rendio.co',
  'andres.cardona@rendio.co',
  'daniel@rendio.co',
  'sebas.gomez@rendio.co',
  'juan.andres@rendio.co',
  'juanjose.franco@rendio.co',
];

const { data, error } = await sb.from('profiles')
  .select('id, full_name, email')
  .eq('role', 'driver')
  .is('deleted_at', null)
  .in('email', PLACEHOLDERS);
if (error) { console.error('ERROR leyendo:', error.message); process.exit(1); }

if (!data.length) { console.log('Nada que borrar (ya estaban borrados).'); process.exit(0); }

for (const d of data) {
  const { error: e } = await sb.from('profiles')
    .update({ deleted_at: new Date().toISOString(), is_active: false })
    .eq('id', d.id);
  if (e) { console.error(`Error borrando ${d.email}:`, e.message); process.exit(1); }
  console.log(`🗑  borrado suave: ${d.full_name}  <${d.email}>`);
}
console.log(`\nListo. ${data.length} placeholder(s) borrado(s).`);
