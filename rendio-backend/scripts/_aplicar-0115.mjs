// 0115 · Cuentas de cobro: abrir varias, «plazo desde hoy» y el comprobante del
// jefe, contra DEV.
//
//   cd rendio-backend/scripts && set -a && source ../.env.dev && set +a && node _aplicar-0115.mjs            (en seco)
//   cd rendio-backend/scripts && set -a && source ../.env.dev && set +a && node _aplicar-0115.mjs --aplicar
//
// 0115 solo crea funciones y una política del bucket: no cambia datos. Dentro de
// la transacción comprueba que todo quedó y que no se movió ninguna cuenta de
// cobro ni ningún comprobante. En seco deshace todo. Solo dev; producción se
// decide aparte, con su OK.
import pg from 'pg';
import { readFileSync } from 'node:fs';

const DEV_REF = 'lxlphbafhtphulanhzlp';
const ref = process.env.SUPABASE_PROJECT_REF || '';
if (ref !== DEV_REF || !(process.env.SUPABASE_URL || '').includes(DEV_REF)) {
  console.error('ABORT: este script solo trabaja contra dev (' + DEV_REF + '). Cargó: ' + (ref || '(nada)'));
  process.exit(2);
}
const aplicar = process.argv.includes('--aplicar');
const c = new pg.Client({ host: 'aws-1-us-east-1.pooler.supabase.com', port: 5432, user: 'postgres.' + ref,
  password: process.env.SUPABASE_DB_PASSWORD, database: 'postgres', ssl: { rejectUnauthorized: false } });
await c.connect();
const q = async (s) => (await c.query(s)).rows;
console.log(aplicar ? '\n== APLICANDO 0115 en dev ==' : '\n== 0115 EN SECO contra dev (se deshace) ==');
const foto = async () => (await q(`SELECT
    (SELECT count(*) FROM public.billing_statements)::int st,
    (SELECT count(*) FROM public.billing_statements WHERE paid_at IS NOT NULL)::int pagadas,
    (SELECT count(*) FROM public.billing_proofs)::int proofs,
    (SELECT count(*) FROM public.billing_alerts)::int alerts,
    (SELECT md5(string_agg(id::text || due_days || coalesce(blocked_at::text, ''), ',' ORDER BY id)) FROM public.billing_statements) firma`))[0];
let bien = false;
try {
  const antes = await foto();
  await c.query('BEGIN');
  await c.query(readFileSync(new URL('../supabase/migrations/0115_cobro_abrir_varias_y_comprobante_del_jefe.sql', import.meta.url), 'utf8')
    .replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, ''));
  const fns = (await q(`SELECT
      to_regprocedure('public.billing_restart_terms(uuid,date,boolean)') IS NOT NULL a,
      to_regprocedure('public.admin_billing_restart_terms(uuid)') IS NOT NULL b,
      to_regprocedure('public.admin_billing_open_statements(uuid[],boolean,boolean)') IS NOT NULL c,
      to_regprocedure('public.admin_billing_mark_paid_with_proof(uuid,text,text,integer,text,integer,date,text)') IS NOT NULL d,
      EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'p_payment_proofs_insert_admin') pol,
      has_function_privilege('anon', 'public.admin_billing_open_statements(uuid[],boolean,boolean)', 'EXECUTE') anon_open,
      has_function_privilege('authenticated', 'public.billing_restart_terms(uuid,date,boolean)', 'EXECUTE') auth_interna`))[0];
  const despues = await foto();
  const igual = JSON.stringify(antes) === JSON.stringify(despues);
  const ok1 = fns.a && fns.b && fns.c && fns.d, ok2 = fns.pol, ok3 = !fns.anon_open && !fns.auth_interna;
  bien = ok1 && ok2 && ok3 && igual;
  console.log(`  ${ok1 ? '✓' : '✗'} las 4 funciones quedaron`);
  console.log(`  ${ok2 ? '✓' : '✗'} la política «el jefe sube comprobantes de su organización» quedó`);
  console.log(`  ${ok3 ? '✓' : '✗'} permisos: anon no las llama; la interna no la llama nadie desde la app`);
  console.log(`  ${igual ? '✓' : '✗'} no se movió ninguna cuenta de cobro, comprobante ni aviso (${antes.st} cuentas, ${antes.pagadas} pagadas, ${antes.proofs} comprobantes, ${antes.alerts} avisos)`);
  await c.query(aplicar && bien ? 'COMMIT' : 'ROLLBACK');
  console.log(aplicar && bien ? '  COMMIT' : '  ROLLBACK: dev quedó exactamente igual.');
} catch (e) {
  try { await c.query('ROLLBACK'); } catch (_) { /* */ }
  console.error('  ✗ ERROR:', e.message, '\n  ROLLBACK: dev quedó exactamente igual.');
} finally {
  await c.end();
}
process.exit(bien ? 0 : 1);
