// Carga los 17 sectores de cobro con su mensualidad (la lista de la profa,
// 13-oct-2026) en «Tarifas por sector». Sin dibujo y sin valor por viaje: el
// dibujo lo hace el admin en el mapa y el valor por viaje todavía no está
// definido.
//
//   cd rendio-backend/scripts && set -a && source ../.env.dev && set +a && node _cargar-tarifas-1013.mjs           (en seco)
//   cd rendio-backend/scripts && set -a && source ../.env.dev && set +a && node _cargar-tarifas-1013.mjs --aplicar
//
// Si el sector ya existe (p. ej. se creó Barro Blanco probando), solo se le pone
// la mensualidad: el dibujo y el valor por viaje se quedan como estén.
//
// Mientras un sector no esté dibujado nadie cae en él, así que cargar las
// tarifas no le cambia el cobro a nadie: se comprueba antes y después.
//
// Solo dev (lxlphbafhtphulanhzlp). En producción hace falta 0109 antes, y su
// propio OK: ahí se corre con --produccion (y el .env.main).
import pg from 'pg';

const DEV_REF = 'lxlphbafhtphulanhzlp', MAIN_REF = 'wvuurnfdrrdondrbbkhd';
const ref = process.env.SUPABASE_PROJECT_REF || '';
const prod = process.argv.includes('--produccion');
const esperado = prod ? MAIN_REF : DEV_REF;
if (ref !== esperado || !(process.env.SUPABASE_URL || '').includes(esperado)) {
  console.error(`ABORT: se esperaba ${prod ? 'PRODUCCIÓN' : 'dev'} (${esperado}) y se cargó: ${ref || '(nada)'}`);
  process.exit(2);
}
const aplicar = process.argv.includes('--aplicar');

const TARIFAS = [
  ['Somer', 480000],
  ['UCO', 490000],
  ['Porvenir', 470000],
  ['Fontibón', 490000],
  ['Colegios', 490000],
  ['Alto Bonito', 480000],
  ['Campo Santander INTER', 400000],
  ['Barro Blanco', 450000],
  ['Cuatro Esquinas', 500000],
  ['Marinilla Sector 1', 760000],
  ['Marinilla Sector 2', 860000],
  ['Vía Marinilla', 650000],
  ['San Antonio', 490000],
  ['Carmen de Viboral', 800000],
  ['Llanogrande Sector 1', 550000],
  ['Llanogrande Sector 2', 520000],
  ['Llanogrande Sector 3', 450000],
];

const c = new pg.Client({ host: 'aws-1-us-east-1.pooler.supabase.com', port: 5432, user: 'postgres.' + ref,
  password: process.env.SUPABASE_DB_PASSWORD, database: 'postgres', ssl: { rejectUnauthorized: false } });
await c.connect();
const q = async (s, p) => (await c.query(s, p)).rows;

const orgs = await q(`SELECT o.id, o.name FROM public.organizations o
  WHERE EXISTS (SELECT 1 FROM public.profiles p WHERE p.organization_id = o.id AND p.role = 'admin' AND p.deleted_at IS NULL)`);
if (orgs.length !== 1) { console.error('ABORT: se esperaba UNA organización con admin; hay ' + orgs.length); await c.end(); process.exit(2); }
const org = orgs[0];
const cobro = async () => JSON.stringify(await q(`
  SELECT ap.id, rt.sector_name, rt.monthly FROM public.auxiliar_profiles ap
    JOIN public.profiles pr ON pr.id = ap.profile_id AND pr.organization_id = $1
    LEFT JOIN LATERAL public.billing_rate_of(ap.id) rt ON true ORDER BY ap.id`, [org.id]));

console.log(`\n${aplicar ? 'APLICANDO' : 'EN SECO (se deshace)'} en ${prod ? 'PRODUCCIÓN' : 'dev'} · ${org.name}`);
let bien = false;
try {
  const antes = await cobro();
  await c.query('BEGIN');
  for (const [sector, mensual] of TARIFAS) {
    const r = (await q(`
      INSERT INTO public.billing_sector_rates (organization_id, sector, monthly_cop)
      VALUES ($1, $2, $3)
      ON CONFLICT (organization_id, (lower(btrim(sector))))
      DO UPDATE SET monthly_cop = EXCLUDED.monthly_cop
      RETURNING sector, monthly_cop, per_trip_cop, polygon IS NOT NULL AS dibujado, (xmax = 0) AS nuevo`, [org.id, sector, mensual]))[0];
    console.log(`  ${r.nuevo ? '+' : '~'} ${r.sector.padEnd(24)} $${String(r.monthly_cop).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}${r.dibujado ? ' · ya dibujado' : ''}`);
  }
  const despues = await cobro();
  const n = (await q(`SELECT count(*)::int n FROM public.billing_sector_rates WHERE organization_id = $1`, [org.id]))[0].n;
  bien = antes === despues;
  console.log(`  ${bien ? '✓' : '✗'} el sector y la mensualidad de cada tripulante quedaron iguales (los sectores sin dibujo no tienen a nadie)`);
  console.log(`  tarifas en la organización: ${n}`);
  await c.query(aplicar && bien ? 'COMMIT' : 'ROLLBACK');
  console.log(aplicar && bien ? '  COMMIT' : '  ROLLBACK: quedó exactamente igual.');
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error('  ✗ ' + e.message);
} finally { await c.end(); }
process.exit(bien ? 0 : 1);
