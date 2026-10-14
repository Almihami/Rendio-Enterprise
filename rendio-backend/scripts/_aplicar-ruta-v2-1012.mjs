// Migraciones de la ruta del conductor v2 y los ajustes del 12-oct-2026 (0102–0105) y
// personal de tierra del 13-oct (0106) contra DEV. --solo=0106 aplica solo esa.
//
//   cd rendio-backend/scripts && set -a && source ../.env.dev && set +a && node _aplicar-ruta-v2-1012.mjs --estado
//   cd rendio-backend/scripts && set -a && source ../.env.dev && set +a && node _aplicar-ruta-v2-1012.mjs --seco
//   cd rendio-backend/scripts && set -a && source ../.env.dev && set +a && node _aplicar-ruta-v2-1012.mjs --aplicar
//
// --estado: solo lee. Dice si dev ya tiene 0101 (requisito) y cuáles de 0102–0105.
// --seco (por defecto): corre TODAS en una sola transacción y la DESHACE. Dev
//   queda igual; sirve para saber que aplican limpias sobre el esquema real.
// --aplicar: aplica cada archivo tal cual (cada uno trae su BEGIN/COMMIT), en
//   orden, y se detiene en la primera que falle. Las que ya pasaron quedan.
//
// Solo acepta el proyecto de dev (lxlphbafhtphulanhzlp). Producción NO: eso se
// decide aparte, con su propio OK. Requiere 0096–0101 ya aplicadas
// (_aplicar-arranque-1011.mjs).
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
const SOLO = (process.argv.find(a => a.startsWith('--solo=')) || '').slice(7).split(',').filter(Boolean);
const DIR = join(dirname(fileURLToPath(import.meta.url)), '../supabase/migrations');
const ARCHIVOS = [
  '0102_deshacer_en_aeropuerto.sql',
  '0103_privado_tarifa_y_cobro.sql',
  '0104_olvide_contrasena.sql',
  '0105_inspeccion_al_cerrar.sql',
  '0106_personal_de_tierra.sql',
].filter(f => !SOLO.length || SOLO.some(n => f.startsWith(n)));

const c = new pg.Client({ host: 'aws-1-us-east-1.pooler.supabase.com', port: 5432, user: 'postgres.' + ref,
  password: process.env.SUPABASE_DB_PASSWORD, database: 'postgres', ssl: { rejectUnauthorized: false } });
await c.connect();
c.on('notice', (n) => console.log('    NOTICE: ' + n.message));

if (estado) {
  const one = async (sql) => (await c.query(sql)).rows[0];
  const fn = async (name) => (await one(`SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = '${name}'`)).n > 0;
  const col = async (t, cn) => (await one(`SELECT count(*)::int n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${t}' AND column_name = '${cn}'`)).n > 0;
  const tab = async (t) => (await one(`SELECT to_regclass('public.${t}') IS NOT NULL ok`)).ok;
  console.log('\n== ESTADO de dev (solo lectura) ==');
  console.log('  requisito 0097 driver_mark_airport_arrival:', await fn('driver_mark_airport_arrival'));
  console.log('  requisito 0098 set_my_phone:', await fn('set_my_phone'));
  console.log('  requisito 0101 (trigger de asignado al publicar):', (await one(`SELECT count(*)::int n FROM pg_trigger WHERE tgname ILIKE '%asignad%' OR tgname ILIKE '%assigned%'`)).n > 0);
  console.log('  0102 driver_airport_undo:', await fn('driver_airport_undo'));
  console.log('  0103 billing_extra_charges.kind:', await col('billing_extra_charges', 'kind'));
  console.log('  0104 password_reset_requests:', await tab('password_reset_requests'));
  console.log('  0105 app_settings.fast_start_deadline:', await col('app_settings', 'fast_start_deadline'));
  console.log('  0106 auxiliar_profiles.ground_staff:', await col('auxiliar_profiles', 'ground_staff'));
  const s = await one(`SELECT aux_private_price_cop FROM public.app_settings WHERE id = 'singleton'`).catch(() => null);
  console.log('  tarifa del privado hoy:', s ? s.aux_private_price_cop : '(sin fila)');
  await c.end();
  process.exit(0);
}

console.log(aplicar ? '\n== APLICANDO en dev ==' : '\n== EN SECO contra dev (todo se deshace al final) ==');
let ok = 0;
try {
  if (!aplicar) await c.query('BEGIN');
  for (const f of ARCHIVOS) {
    let sql = readFileSync(join(DIR, f), 'utf8');
    // En seco se quitan el BEGIN; y el COMMIT; propios del archivo (la 0104 los
    // trae en minúscula: si quedara su commit; cerraría la transacción de la
    // prueba y la «prueba» aplicaría de verdad).
    if (!aplicar) sql = sql.replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
    if (!aplicar && /^\s*(BEGIN|COMMIT|END)\s*;/mi.test(sql.replace(/\$[a-z_]*\$[\s\S]*?\$[a-z_]*\$/gi, ''))) throw new Error(f + ': quedó un BEGIN/COMMIT fuera de una función; en seco no se puede garantizar el ROLLBACK');
    if (!aplicar) await c.query('SAVEPOINT paso');
    try {
      await c.query(sql);
      ok++; console.log('  ✓ ' + f);
    } catch (e) {
      console.log('  ✗ ' + f + ' → ' + e.message + (e.position ? ' (posición ' + e.position + ')' : ''));
      if (!aplicar) await c.query('ROLLBACK TO SAVEPOINT paso');
      throw e;
    }
  }
} catch (_) {
  /* ya se informó */
} finally {
  if (!aplicar) { await c.query('ROLLBACK'); console.log('  ROLLBACK: dev quedó exactamente igual.'); }
  await c.end();
}
console.log(`\n${ok}/${ARCHIVOS.length} ${aplicar ? 'aplicadas' : 'aplican limpias'}`);
process.exit(ok === ARCHIVOS.length ? 0 : 1);
