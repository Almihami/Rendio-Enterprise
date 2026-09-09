// COPIA EL CATÁLOGO DE RESIDENCIAS DE DEV A PRODUCCIÓN, tal cual está en dev
// (nombre, coordenada, sector, nota de acceso, activa). Upsert por (org, nombre):
// correrlo dos veces no duplica; NO borra lo que main tenga de más.
//
//   node scripts/_copiar-residencias-dev-a-main.mjs            → ensayo: solo muestra
//   node scripts/_copiar-residencias-dev-a-main.mjs --aplicar  → escribe en main y verifica
import { readFileSync } from 'fs';

const APLICAR = process.argv.includes('--aplicar');
function env(file) {
  const t = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  const g = k => (t.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1]?.replace(/^"|"$/g, '').trim();
  return { url: g('SUPABASE_URL'), key: g('SUPABASE_SERVICE_ROLE_KEY'), ref: g('SUPABASE_PROJECT_REF') };
}
const DEV = env('.env.dev'), MAIN = env('.env.main');
if (DEV.ref !== 'lxlphbafhtphulanhzlp' || MAIN.ref !== 'wvuurnfdrrdondrbbkhd') { console.error('ABORT: refs inesperados', DEV.ref, MAIN.ref); process.exit(2); }

async function api({ url, key }, path, init = {}) {
  const r = await fetch(url + '/rest/v1/' + path, { ...init, headers: { apikey: key, Authorization: 'Bearer ' + key, ...(init.headers || {}) } });
  const body = await r.text();
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status} ${body}`);
  return body ? JSON.parse(body) : null;
}
const COLS = 'name,latitude,longitude,sector,access_note,is_active';
const src = await api(DEV, `residences?select=${COLS}&order=sector,name`);
const [org] = await api(MAIN, 'organizations?select=id,name&limit=1');
const antes = await api(MAIN, `residences?select=${COLS}&organization_id=eq.${org.id}`);
console.log(`dev: ${src.length} residencias → main org "${org.name}" (${antes.length} residencias ya en main)\n`);
const rows = src.map(r => ({ ...r, organization_id: org.id }));
for (const r of rows) console.log(`  ${(r.sector ?? '(sin sector)').padEnd(11)} ${r.name.padEnd(30)} ${r.latitude.toFixed(6)}, ${r.longitude.toFixed(6)}${r.access_note ? '  nota: ' + r.access_note : ''}`);

if (!APLICAR) { console.log('\n↩  Ensayo: no se escribió nada en main. Correr con --aplicar.'); process.exit(0); }

await api(MAIN, 'residences?on_conflict=organization_id,name', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
  body: JSON.stringify(rows),
});
const despues = await api(MAIN, `residences?select=${COLS}&organization_id=eq.${org.id}&order=name`);
const byName = Object.fromEntries(despues.map(r => [r.name, r]));
let ok = 0, mal = [];
for (const r of src) {
  const m = byName[r.name];
  if (m && m.latitude === r.latitude && m.longitude === r.longitude && (m.sector ?? null) === (r.sector ?? null) && (m.access_note ?? null) === (r.access_note ?? null) && m.is_active === r.is_active) ok++;
  else mal.push(r.name);
}
console.log(`\n✅ main tiene ahora ${despues.length} residencias · ${ok}/${src.length} idénticas a dev` + (mal.length ? ` · DIFIEREN: ${mal.join(', ')}` : ''));
process.exit(mal.length ? 1 : 0);
