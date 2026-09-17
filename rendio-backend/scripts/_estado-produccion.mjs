// RADIOGRAFÍA DE PRODUCCIÓN — SOLO LECTURA.
// Va por la API de administración (el pooler de prod está en otra región).
// Rechaza cualquier consulta que no empiece por SELECT o WITH: acá no se escribe.
const ref = process.env.SUPABASE_PROJECT_REF || '';
const tok = process.env.SUPABASE_ACCESS_TOKEN || '';
if (ref !== 'wvuurnfdrrdondrbbkhd') { console.error('ABORT: esto no es producción'); process.exit(2); }

async function sel(sql) {
  if (!/^\s*(select|with)\b/i.test(sql)) throw new Error('BLOQUEADO: solo SELECT — ' + sql.slice(0, 40));
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql, read_only: true }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

console.log('══════ DATOS VIVOS EN PRODUCCIÓN ══════');
const tablas = ['profiles','driver_profiles','shifts','inspections','vehicles','weekly_schedules','fuel_receipts','incidents','approval_requests','driver_strikes'];
const existentes = await sel(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`);
const hay = new Set(existentes.map(r => r.table_name));
for (const t of tablas) {
  if (!hay.has(t)) { console.log(`  ${t.padEnd(20)}   (no existe)`); continue; }
  const r = await sel(`SELECT count(*)::int n FROM public.${t}`);
  console.log(`  ${t.padEnd(20)} ${String(r[0].n).padStart(6)} filas`);
}
console.log(`\n  tablas en public: ${hay.size}`);

console.log('\n══════ ¿QUÉ TIENE Y QUÉ LE FALTA? ══════');
const sondas = [
  ['0034 cierre de turno',         `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='close_shift'`],
  ['0036 recompensas',             `SELECT 1 FROM information_schema.tables WHERE table_name='rewards'`],
  ['0039 inicio diferido',         `SELECT 1 FROM information_schema.columns WHERE table_name='shifts' AND column_name='inspection_due_at'`],
  ['0040 rutas (reservations)',    `SELECT 1 FROM information_schema.tables WHERE table_name='reservations'`],
  ['0045 GPS en vivo',             `SELECT 1 FROM information_schema.tables WHERE table_name='driver_locations'`],
  ['0052 chat del traslado',       `SELECT 1 FROM information_schema.tables WHERE table_name='reservation_messages'`],
  ['0055 catálogo residencias',    `SELECT 1 FROM information_schema.tables WHERE table_name='residences'`],
  ['0062 tabla de tiempos',        `SELECT 1 FROM information_schema.tables WHERE table_name='route_zone_times'`],
  ['0064/65 disponibilidad unset', `SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE e.enumlabel='unset'`],
  ['0069 traslado privado',        `SELECT 1 FROM information_schema.columns WHERE table_name='reservations' AND column_name='service_level'`],
  ['0073 repuestos',               `SELECT 1 FROM information_schema.tables WHERE table_name='vehicle_parts'`],
  ['0075/76 registro tripulante',  `SELECT 1 FROM information_schema.routines WHERE routine_schema='public' AND routine_name LIKE '%auxiliar%'`],
  ['0077 tanqueo condicional',     `SELECT 1 FROM information_schema.columns WHERE table_name='shifts' AND column_name='fueled'`],
];
const falta = [];
for (const [nombre, sql] of sondas) {
  try { const r = await sel(sql); const ok = r.length > 0; console.log(`  ${ok ? '✓ SÍ ' : '✗ NO '} ${nombre}`); if (!ok) falta.push(nombre); }
  catch (e) { console.log(`  ? ERR ${nombre} — ${e.message.slice(0, 70)}`); }
}

console.log('\n══════ REGISTRO DE MIGRACIONES ══════');
try {
  const r = await sel(`SELECT version FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 8`);
  console.log('  últimas:', r.map(x => x.version).join(', ') || '(vacío)');
} catch (e) { console.log('  sin tabla de migraciones —', e.message.slice(0, 90)); }

console.log('\n══════ EXTENSIONES ══════');
const ext = await sel(`SELECT extname FROM pg_extension ORDER BY extname`);
console.log('  ' + ext.map(e => e.extname).join(', '));

console.log(`\n══════ RESUMEN ══════\n  le faltan ${falta.length} de ${sondas.length} bloques probados`);
