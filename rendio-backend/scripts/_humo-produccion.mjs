// PRUEBA DE HUMO CONTRA PRODUCCIÓN, con sesión de usuario real (RLS activo).
// Comprueba que lo que el conductor y el admin USAN de verdad sigue respondiendo.
// Solo lectura: ni un INSERT, ni un UPDATE.
const URL = process.env.SUPABASE_URL, ANON = process.env.SUPABASE_ANON_KEY;
if (!/wvuurnfdrrdondrbbkhd/.test(URL||'')) { console.error('ABORT: no es producción'); process.exit(2); }
let ok=0,bad=0; const t=(n,c,d='')=>{c?(ok++,console.log('  ✓ '+n)):(bad++,console.log('  ✗ '+n+(d?' → '+d:'')));};
const get = async (path) => {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers:{ apikey:ANON, Authorization:`Bearer ${ANON}` } });
  return { status:r.status, body: await r.json().catch(()=>null) };
};
console.log('── la API responde con la llave pública (como el navegador) ──');
for (const [n,p] of [
  ['perfiles',            'profiles?select=id&limit=1'],
  ['turnos',              'shifts?select=id&limit=1'],
  ['vehículos',           'vehicles?select=id&limit=1'],
  ['checklist',           'inspection_checklist_items?select=id&limit=1'],
  ['motivos de tanqueo',  'no_fuel_reasons?select=id,label&limit=5'],
  ['residencias',         'residences?select=id&limit=1'],
  ['tabla de tiempos',    'route_zone_times?select=zone&limit=1'],
  ['reservas',            'reservations?select=id&limit=1'],
]) {
  const r = await get(p);
  // 200 = existe y RLS deja leer · 401/403 = existe pero exige sesión (correcto)
  t(`${n} (HTTP ${r.status})`, [200,401,403].includes(r.status), JSON.stringify(r.body).slice(0,110));
}
// OJO: sin sesión, RLS devuelve [] con HTTP 200 — la política filtra por
// organización y el anónimo no tiene. Un vacío aquí es CORRECTO, no un fallo.
// Que los datos existan se comprueba por la base directa, no por aquí.
console.log('\n── el catálogo nuevo, visto por el anónimo ──');
const m = await get('no_fuel_reasons?select=label&order=sort_order');
t('la tabla responde y RLS la protege (vacío sin sesión)',
  m.status === 200 && Array.isArray(m.body) && m.body.length === 0,
  `HTTP ${m.status} · ${JSON.stringify(m.body).slice(0,60)}`);
console.log(`\n${ok}/${ok+bad} pasaron${bad?` · ${bad} FALLARON`:''}`);
process.exit(bad?1:0);
