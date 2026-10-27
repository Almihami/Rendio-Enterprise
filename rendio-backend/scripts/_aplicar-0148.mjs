// 0148 · Sin la FK de plan_vehicle_id (0132): vuelve a leerse lo publicado.
//
//   DEV:    cd rendio-backend && set -a && source .env.dev && set +a && node scripts/_aplicar-0148.mjs [--aplicar]
//   PRODUCCIÓN: ya está a mano desde el 26-oct (~1 p. m.); ahí 0148 solo deja el
//           comentario de la columna. Con su OK:
//           cd rendio-backend && set -a && source .env.main && set +a && node scripts/_aplicar-0148.mjs --produccion [--aplicar]
//
// Todo en UNA transacción; solo con --aplicar (y todo bien) se confirma.
// ANTES: entre route_assignments y vehicles solo pueden estar las dos FK conocidas
// (vehicle_id de siempre y plan_vehicle_id de 0132), o ya solo la de vehicle_id.
// DESPUÉS: queda SOLO route_assignments_vehicle_id_fkey, la columna plan_vehicle_id
// sigue ahí con sus valores, y no se movió ninguna vuelta. Con --aplicar, al final
// pide a PostgREST recargar y comprueba por la API que el embed vehicles(...) lee.
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const DEV = 'lxlphbafhtphulanhzlp', PROD = 'wvuurnfdrrdondrbbkhd';
const prod = process.argv.includes('--produccion');
const aplicar = process.argv.includes('--aplicar');
const ref = process.env.SUPABASE_PROJECT_REF || '';
const esperado = prod ? PROD : DEV;
if (ref !== esperado || !(process.env.SUPABASE_URL || '').includes(esperado)) {
  console.error(`ABORT: se esperaba ${prod ? 'PRODUCCIÓN' : 'dev'} (${esperado}) y se cargó ${ref || '(nada)'}.`); process.exit(2);
}
const c = new pg.Client({ host: prod ? 'aws-1-us-west-2.pooler.supabase.com' : 'aws-1-us-east-1.pooler.supabase.com', port: 5432,
  database: 'postgres', user: 'postgres.' + esperado, password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false }, statement_timeout: 60000 });
await c.connect();
const q = async (s, v) => (await c.query(s, v)).rows;
const one = async (s, v) => (await q(s, v))[0];
const amb = prod ? 'PRODUCCIÓN' : 'dev';
console.log(aplicar ? `\n== APLICANDO 0148 en ${amb} ==` : `\n== 0148 EN SECO contra ${amb} (se deshace) ==`);
const fallas = [];
const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); if (!ok) fallas.push(n); };
const sql = readFileSync(new URL('../supabase/migrations/0148_quitar_fk_carro_del_plan.sql', import.meta.url), 'utf8')
  .replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '').replace(/^\s*NOTIFY\s+pgrst.*$/gmi, '');
const fks = async () => (await q(`SELECT conname FROM pg_constraint WHERE conrelid = 'public.route_assignments'::regclass
    AND contype = 'f' AND confrelid = 'public.vehicles'::regclass ORDER BY 1`)).map((r) => r.conname);
const cuentas = () => one(`SELECT count(*)::int ra, count(plan_vehicle_id)::int con_plan,
    (SELECT md5(coalesce(string_agg(to_jsonb(a)::text, ',' ORDER BY id), '')) FROM public.route_assignments a) vueltas
    FROM public.route_assignments`);
const SOLO = ['route_assignments_vehicle_id_fkey'], AMBAS = ['route_assignments_plan_vehicle_id_fkey', 'route_assignments_vehicle_id_fkey'];

await c.query('BEGIN');
try {
  await c.query(`SET LOCAL lock_timeout = '5s'`);
  const f0 = await fks();
  const ya = JSON.stringify(f0) === JSON.stringify(SOLO);
  console.log(`  · FK hacia vehicles hoy: ${f0.join(', ') || '(ninguna)'}${ya ? '  (0148 ya estaba: solo se deja el comentario)' : ''}`);
  if (!ya && JSON.stringify(f0) !== JSON.stringify(AMBAS)) throw new Error('las FK hacia vehicles no son las esperadas: mirar qué hay antes de tocar');
  const antes = await cuentas();
  console.log(`  · vueltas: ${antes.ra} · con carro del plan: ${antes.con_plan}`);

  await c.query(sql);

  const f1 = await fks();
  t('queda solo route_assignments_vehicle_id_fkey', JSON.stringify(f1) === JSON.stringify(SOLO), f1);
  const col = await one(`SELECT data_type, col_description('public.route_assignments'::regclass, ordinal_position::int) d
    FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'route_assignments' AND column_name = 'plan_vehicle_id'`);
  t('la columna plan_vehicle_id sigue (uuid) con el comentario de 0148', col && col.data_type === 'uuid' && /0148/.test(col.d || ''), col);
  const desp = await cuentas();
  t('no se movió ninguna vuelta (mismas filas, mismos valores)', JSON.stringify(antes) === JSON.stringify(desp), { antes, desp });

  if (fallas.length) throw new Error(`${fallas.length} comprobación(es) en rojo`);
  if (!aplicar) { await c.query('ROLLBACK'); console.log('\n  EN SECO: todo en verde y DESHECHO. Para confirmarlo: --aplicar'); await c.end(); process.exit(0); }
  await c.query('COMMIT');
  console.log('  ✓ COMMIT');
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error(`\n  ✗ NO SE APLICÓ (se deshizo todo): ${e.message}`); await c.end(); process.exit(1);
}

// PostgREST recarga solo con el cambio de esquema; el NOTIFY lo asegura.
await c.query(`NOTIFY pgrst, 'reload schema'`);
await c.end();
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
let error;
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  ({ error } = await sb.from('route_assignments').select('id, vehicles(license_plate)').limit(1));
  if (!error) break;
}
t('la API ya embebe vehicles(...) desde route_assignments', !error, error && `${error.code} · ${error.message}`);
process.exit(fallas.length ? 1 : 0);
