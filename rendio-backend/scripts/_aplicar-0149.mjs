// 0149 · admin_crew_aliases_save: los apodos del jefe se aprenden al pasar lo
// pegado al tablero. Función NUEVA: no reemplaza ninguna.
//
//   DEV:        cd rendio-backend && set -a && source <.env.dev> && set +a && node scripts/_aplicar-0149.mjs [--aplicar]
//   PRODUCCIÓN: cd rendio-backend && set -a && source <.env.main> && set +a && node scripts/_aplicar-0149.mjs --produccion [--aplicar]
//
// Todo en UNA transacción; solo con --aplicar (y todo bien) se confirma.
// ANTES: crew_aliases existe con su llave única (organization_id, alias_norm) y
// updated_at; la función no existe (o es la misma de 0149: se vuelve a dejar igual).
// DESPUÉS: la función existe, SECURITY DEFINER, la puede llamar authenticated y no
// anon, sin sesión de jefe dice «Solo un jefe guarda apodos», y crew_aliases no cambió.
import pg from 'pg';
import { readFileSync } from 'node:fs';

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
console.log(aplicar ? `\n== APLICANDO 0149 en ${amb} ==` : `\n== 0149 EN SECO contra ${amb} (se deshace) ==`);
const fallas = [];
const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); if (!ok) fallas.push(n); };
const sql = readFileSync(new URL('../supabase/migrations/0149_apodos_al_pegar.sql', import.meta.url), 'utf8')
  .replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const huella = () => one(`SELECT count(*)::int n, md5(coalesce(string_agg(to_jsonb(a)::text, ',' ORDER BY id), '')) h FROM public.crew_aliases a`);

await c.query('BEGIN');
try {
  await c.query(`SET LOCAL lock_timeout = '5s'`);
  const tabla = await one(`SELECT
      (SELECT count(*)::int FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'crew_aliases'
        AND column_name IN ('organization_id', 'alias_norm', 'auxiliar_profile_id', 'created_by', 'updated_at')) cols,
      (SELECT count(*)::int FROM pg_index i JOIN pg_class x ON x.oid = i.indrelid
        WHERE x.oid = 'public.crew_aliases'::regclass AND i.indisunique
          AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a WHERE a.attrelid = x.oid AND a.attnum = ANY (i.indkey)) = ARRAY['alias_norm', 'organization_id']) llave`);
  t('crew_aliases tiene las 5 columnas y la llave única (organization_id, alias_norm)', tabla.cols === 5 && tabla.llave >= 1, tabla);
  for (const f of ['current_user_org', 'current_user_role']) {
    const x = await one(`SELECT count(*)::int n FROM pg_proc WHERE proname = $1 AND pronamespace = 'public'::regnamespace`, [f]);
    t(`existe public.${f}()`, x.n >= 1);
  }
  const ya = await one(`SELECT count(*)::int n FROM pg_proc WHERE proname = 'admin_crew_aliases_save' AND pronamespace = 'public'::regnamespace`);
  console.log(`  · admin_crew_aliases_save hoy: ${ya.n ? 'ya existe (se deja igual)' : 'no existe'}`);
  if (fallas.length) throw new Error('la base no tiene lo que 0149 necesita');
  const antes = await huella();
  console.log(`  · crew_aliases: ${antes.n} apodos`);

  await c.query(sql);

  const fn = await one(`SELECT p.prosecdef, pg_get_function_identity_arguments(p.oid) args,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') auth, has_function_privilege('anon', p.oid, 'EXECUTE') anon,
      obj_description(p.oid, 'pg_proc') d
    FROM pg_proc p WHERE p.proname = 'admin_crew_aliases_save' AND p.pronamespace = 'public'::regnamespace`);
  t('la función existe (p_aliases jsonb), SECURITY DEFINER', fn && fn.prosecdef && fn.args === 'p_aliases jsonb', fn);
  t('la llama authenticated, no anon', fn && fn.auth === true && fn.anon === false, fn);
  t('con el comentario de 0149', fn && /0149/.test(fn.d || ''));
  // Sin sesión de jefe: no guarda nada y lo dice.
  await c.query('SAVEPOINT prueba');
  let err = null;
  try { await c.query(`SELECT public.admin_crew_aliases_save('[{"alias":"x","auxiliar_profile_id":"00000000-0000-0000-0000-000000000000"}]'::jsonb)`); }
  catch (e) { err = e; }
  await c.query('ROLLBACK TO SAVEPOINT prueba');
  t('sin sesión de jefe: «Solo un jefe guarda apodos» (42501)', err && err.code === '42501' && /Solo un jefe/.test(err.message), err ? `${err.code} ${err.message}` : 'no dio error');
  const desp = await huella();
  t('crew_aliases no cambió', JSON.stringify(antes) === JSON.stringify(desp), { antes, desp });

  if (fallas.length) throw new Error(`${fallas.length} comprobación(es) en rojo`);
  if (!aplicar) { await c.query('ROLLBACK'); console.log('\n  EN SECO: todo en verde y DESHECHO. Para confirmarlo: --aplicar'); await c.end(); process.exit(0); }
  await c.query('COMMIT');
  console.log('  ✓ COMMIT');
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error(`\n  ✗ NO SE APLICÓ (se deshizo todo): ${e.message}`); await c.end(); process.exit(1);
}
await c.query(`NOTIFY pgrst, 'reload schema'`);
await c.end();
process.exit(0);
