#!/usr/bin/env node
// Limpieza puntual rendio-turnos:
//  - Coordinación solo para Julian y Christian (is_coordinator=false al resto).
//  - Borrado suave de los placeholders "Admin Uno" / "Admin Dos".
//
// Uso:
//   set -a; source ../.env.local.dev; set +a
//   node scripts/fix-admin-coordinators.mjs
//
// Requiere SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const KEEP_COORD_EMAILS = ['julian.lopez@rendio.co', 'christian.martinez@rendio.co'];
const PLACEHOLDER_RE = /^Admin (Uno|Dos)$/;

(async () => {
  const { data: admins, error } = await sb
    .from('profiles')
    .select('id, full_name, email, role, is_coordinator')
    .eq('role', 'admin')
    .is('deleted_at', null);
  if (error) { console.error('Error leyendo admins:', error.message); process.exit(1); }

  for (const a of admins) {
    const email = (a.email || '').toLowerCase();
    if (PLACEHOLDER_RE.test(a.full_name || '')) {
      const { error: e } = await sb.from('profiles')
        .update({ deleted_at: new Date().toISOString(), is_active: false })
        .eq('id', a.id);
      if (e) throw new Error(`soft-delete ${a.full_name}: ${e.message}`);
      console.log(`🗑  borrado suave: ${a.full_name}`);
    } else if (KEEP_COORD_EMAILS.includes(email)) {
      console.log(`✓  coordina (sin cambios): ${a.full_name}`);
    } else {
      const { error: e } = await sb.from('profiles')
        .update({ is_coordinator: false })
        .eq('id', a.id);
      if (e) throw new Error(`is_coordinator=false ${a.full_name}: ${e.message}`);
      console.log(`✕  ya no coordina: ${a.full_name}`);
    }
  }
  console.log('\nListo.');
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
