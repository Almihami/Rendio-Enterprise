// Migraciones de las zonas dibujadas (13-oct-2026) contra DEV:
//   0108 · zonas de TIEMPOS dibujadas (route_zones) + excepciones a mano
//   0109 · sectores de COBRO dibujados (billing_sector_rates.polygon)
//
//   cd rendio-backend/scripts && set -a && source ../.env.dev && set +a && node _aplicar-zonas-1013.mjs --estado
//   cd rendio-backend/scripts && set -a && source ../.env.dev && set +a && node _aplicar-zonas-1013.mjs --seco
//   cd rendio-backend/scripts && set -a && source ../.env.dev && set +a && node _aplicar-zonas-1013.mjs --aplicar
//
// --estado: solo lee. --seco (por defecto): corre las dos en una transacción y la
// DESHACE. --aplicar: aplica cada archivo tal cual (cada uno trae su BEGIN/COMMIT).
// Después de aplicar (o en seco) comprueba lo que no puede cambiar: las zonas a
// mano que ya había y el sector de cobro de cada tripulante.
//
// Solo acepta el proyecto de dev (lxlphbafhtphulanhzlp). Producción NO: eso se
// decide aparte, con su propio OK. Requiere 0107 ya aplicada.
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEV_REF = 'lxlphbafhtphulanhzlp';
const ref = process.env.SUPABASE_PROJECT_REF || '';
if (ref !== DEV_REF || !(process.env.SUPABASE_URL || '').includes(DEV_REF)) {
  console.error('ABORT: este script solo trabaja contra dev (' + DEV_REF + '). Cargó: ' + (ref || '(nada)'));
  process.exit(2);
}
const aplicar = process.argv.includes('--aplicar');
const estado = process.argv.includes('--estado');
const DIR = join(dirname(fileURLToPath(import.meta.url)), '../supabase/migrations');
const ARCHIVOS = ['0108_zonas_dibujadas.sql', '0109_sectores_cobro_dibujados.sql'];

const c = new pg.Client({ host: 'aws-1-us-east-1.pooler.supabase.com', port: 5432, user: 'postgres.' + ref,
  password: process.env.SUPABASE_DB_PASSWORD, database: 'postgres', ssl: { rejectUnauthorized: false } });
await c.connect();
c.on('notice', (n) => console.log('    NOTICE: ' + n.message));
const one = async (sql, p) => (await c.query(sql, p)).rows[0];

// Lo que no puede cambiar al aplicar: las zonas puestas a mano y, sin dibujos
// todavía, el sector de cobro de cada tripulante (el de 0094: a mano → rótulo).
async function foto() {
  const zonas = (await c.query(`SELECT name, zona_jefe FROM public.residences WHERE zona_jefe IS NOT NULL ORDER BY name`)).rows;
  const sect = (await c.query(`
    SELECT ap.id, rt.sector_name s FROM public.auxiliar_profiles ap
      LEFT JOIN LATERAL public.billing_rate_of(ap.id) rt ON true ORDER BY ap.id`)).rows;
  return { zonas: JSON.stringify(zonas), sect: JSON.stringify(sect), nZonas: zonas.length, nSect: sect.length };
}

if (estado) {
  console.log('\n== ESTADO de dev (solo lectura) ==');
  console.log('  requisito 0107 app_settings.route_night_cutoff_min:',
    (await one(`SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='public' AND table_name='app_settings' AND column_name='route_night_cutoff_min'`)).n > 0);
  console.log('  0108 route_zones:', (await one(`SELECT to_regclass('public.route_zones') IS NOT NULL ok`)).ok);
  console.log('  0109 billing_sector_rates.polygon:',
    (await one(`SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='public' AND table_name='billing_sector_rates' AND column_name='polygon'`)).n > 0);
  const f = await foto();
  console.log(`  conjuntos con zona a mano: ${f.nZonas} · tripulantes: ${f.nSect}`);
  console.log('  tarifas por sector cargadas:', (await one(`SELECT count(*)::int n FROM public.billing_sector_rates`)).n);
  await c.end();
  process.exit(0);
}

console.log(aplicar ? '\n== APLICANDO en dev ==' : '\n== EN SECO contra dev (todo se deshace al final) ==');
let ok = 0, igual = false;
try {
  const antes = await foto();
  if (!aplicar) await c.query('BEGIN');
  for (const f of ARCHIVOS) {
    let sql = readFileSync(join(DIR, f), 'utf8');
    if (!aplicar) sql = sql.replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
    if (!aplicar && /^\s*(BEGIN|COMMIT|END)\s*;/mi.test(sql.replace(/\$[a-z_]*\$[\s\S]*?\$[a-z_]*\$/gi, ''))) throw new Error(f + ': quedó un BEGIN/COMMIT fuera de una función; en seco no se puede garantizar el ROLLBACK');
    try {
      await c.query(sql);
      ok++; console.log('  ✓ ' + f);
    } catch (e) {
      console.log('  ✗ ' + f + ' → ' + e.message + (e.position ? ' (posición ' + e.position + ')' : ''));
      throw e;
    }
  }
  const despues = await foto();
  igual = antes.zonas === despues.zonas && antes.sect === despues.sect;
  console.log(`  ${igual ? '✓' : '✗'} las ${despues.nZonas} zonas a mano y el sector de cobro de los ${despues.nSect} tripulantes quedaron iguales`);
  const z = (await c.query(`SELECT name FROM public.route_zones ORDER BY sort_order, name`)).rows.map(r => r.name);
  console.log('  zonas de tiempos:', z.join(' · '));
} catch (_) {
  /* ya se informó */
} finally {
  if (!aplicar) { await c.query('ROLLBACK'); console.log('  ROLLBACK: dev quedó exactamente igual.'); }
  await c.end();
}
console.log(`\n${ok}/${ARCHIVOS.length} ${aplicar ? 'aplicadas' : 'aplican limpias'}`);
process.exit(ok === ARCHIVOS.length && igual ? 0 : 1);
