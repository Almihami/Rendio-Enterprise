// 0119 · La bienvenida del tripulante se marca en la cuenta.
//
//   DEV (en seco / de verdad):
//     cd rendio-backend && set -a && source .env.dev && set +a && node scripts/_aplicar-0119.mjs
//     cd rendio-backend && set -a && source .env.dev && set +a && node scripts/_aplicar-0119.mjs --aplicar
//   PRODUCCIÓN (solo con su OK, después del respaldo):
//     cd rendio-backend && set -a && source .env.main && set +a && node scripts/_aplicar-0119.mjs --produccion
//     cd rendio-backend && set -a && source .env.main && set +a && node scripts/_aplicar-0119.mjs --produccion --aplicar
//
// Todo va en UNA transacción: se aplica 0119, se comprueba y, solo si todo está
// bien y se pidió --aplicar, se confirma. En seco se deshace. La prueba de la
// función (un tripulante que la llama con su sesión) va en un SAVEPOINT que
// siempre se deshace: no deja a nadie marcado de más.
//
// Comprueba: la columna y la función quedaron; anon no la puede llamar; quien la
// llama SOLO cambia su welcome_seen_at (ni otra columna suya ni otra persona);
// llamarla dos veces no mueve la fecha; el candado de perfiles (0081) sigue
// frenando que el usuario escriba la columna directo; y que fuera de
// welcome_seen_at/updated_at no cambió ninguna fila de profiles.
import pg from 'pg';
import { readFileSync } from 'node:fs';

const DEV = 'lxlphbafhtphulanhzlp', PROD = 'wvuurnfdrrdondrbbkhd';
const ref = process.env.SUPABASE_PROJECT_REF || '';
const prod = process.argv.includes('--produccion');
const esperado = prod ? PROD : DEV;
if (ref !== esperado || !(process.env.SUPABASE_URL || '').includes(esperado)) {
  console.error(`ABORT: se esperaba ${prod ? 'PRODUCCIÓN' : 'dev'} (${esperado}) y se cargó ${ref || '(nada)'}.`
    + (prod ? '' : ' Para producción: --produccion con .env.main.'));
  process.exit(2);
}
const aplicar = process.argv.includes('--aplicar');
const c = new pg.Client({ host: prod ? 'aws-1-us-west-2.pooler.supabase.com' : 'aws-1-us-east-1.pooler.supabase.com',
  port: 5432, user: 'postgres.' + ref, password: process.env.SUPABASE_DB_PASSWORD, database: 'postgres',
  ssl: { rejectUnauthorized: false }, statement_timeout: 120000 });
await c.connect();
const q = async (s, v) => (await c.query(s, v)).rows;
const amb = prod ? 'PRODUCCIÓN' : 'dev';
console.log(aplicar ? `\n== APLICANDO 0119 en ${amb} ==` : `\n== 0119 EN SECO contra ${amb} (se deshace) ==`);

// La huella de profiles sin las dos columnas que 0119 sí puede mover.
const huella = async () => (await q(`SELECT count(*)::int n,
    md5(string_agg((to_jsonb(p) - 'welcome_seen_at' - 'updated_at')::text, ',' ORDER BY id)) firma
  FROM public.profiles p`))[0];

const fallas = [];
const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d ? ' → ' + d : ''}`); if (!ok) fallas.push(n); };
try {
  const antes = await huella();
  const yaEstaba = (await q(`SELECT count(*)::int n FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'welcome_seen_at'`))[0].n === 1;
  await c.query('BEGIN');
  await c.query(readFileSync(new URL('../supabase/migrations/0119_bienvenida_por_cuenta.sql', import.meta.url), 'utf8')
    .replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, ''));

  const o = (await q(`SELECT
      to_regprocedure('public.mark_my_welcome_seen()') IS NOT NULL f,
      has_function_privilege('anon', 'public.mark_my_welcome_seen()', 'EXECUTE') anon_x,
      has_function_privilege('authenticated', 'public.mark_my_welcome_seen()', 'EXECUTE') auth_x,
      (SELECT count(*) FROM public.profiles WHERE role = 'auxiliar' AND deleted_at IS NULL)::int aux,
      (SELECT count(*) FROM public.profiles WHERE role = 'auxiliar' AND deleted_at IS NULL AND welcome_seen_at IS NOT NULL)::int marcados,
      (SELECT count(*) FROM public.profiles WHERE role <> 'auxiliar' AND welcome_seen_at IS NOT NULL)::int otros_roles`))[0];
  console.log(yaEstaba ? '  · la columna YA estaba (se corre igual: es idempotente)' : '  · la columna es nueva');
  t('la función mark_my_welcome_seen() quedó', o.f);
  t('anon no la puede llamar; una sesión sí', !o.anon_x && o.auth_x);
  t('conductores y jefes no se tocaron', o.otros_roles === 0, o.otros_roles + ' marcados');
  console.log(`  · tripulantes: ${o.aux}, marcados como «ya la vieron» (entraron alguna vez): ${o.marcados}, sin marcar: ${o.aux - o.marcados}`);

  // Un tripulante de verdad llama la función con SU sesión (simulada) — y se deshace.
  const [p] = await q(`SELECT id FROM public.profiles WHERE role = 'auxiliar' AND deleted_at IS NULL ORDER BY created_at LIMIT 1`);
  const [otro] = await q(`SELECT id FROM public.profiles WHERE role = 'auxiliar' AND deleted_at IS NULL AND id <> $1 ORDER BY created_at LIMIT 1`, [p ? p.id : null]);
  if (p && otro) {
    await c.query('SAVEPOINT prueba');
    await q(`UPDATE public.profiles SET welcome_seen_at = NULL WHERE id IN ($1, $2)`, [p.id, otro.id]);
    const fila = async (id) => (await q(`SELECT to_jsonb(x) - 'welcome_seen_at' - 'updated_at' resto, welcome_seen_at w FROM public.profiles x WHERE id = $1`, [id]))[0];
    const p0 = await fila(p.id), o0 = await fila(otro.id);
    await q(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: p.id, role: 'authenticated' })]);
    await c.query('SET LOCAL ROLE authenticated');
    const r1 = (await q(`SELECT public.mark_my_welcome_seen() w`))[0].w;
    const r2 = (await q(`SELECT public.mark_my_welcome_seen() w`))[0].w;
    let directo = null;
    await c.query('SAVEPOINT directo');
    try {
      // Una fecha DISTINTA: now() es la misma en toda la transacción, así que
      // escribir now() no cambiaba nada y el candado lo dejaba pasar.
      const r = await c.query(`UPDATE public.profiles SET welcome_seen_at = '2000-01-01' WHERE id = $1`, [p.id]);
      directo = r.rowCount ? 'pasó' : 'la RLS no le deja ver la fila (0 filas)';
    }
    catch (e) { directo = e.message; }
    await c.query('ROLLBACK TO SAVEPOINT directo');
    await c.query('RESET ROLE');
    const p1 = await fila(p.id), o1 = await fila(otro.id);
    t('el tripulante queda marcado al llamarla', !!r1 && !!p1.w);
    t('llamarla otra vez no mueve la fecha', r2 && new Date(r2).getTime() === new Date(r1).getTime());
    t('no cambia ninguna otra columna suya', JSON.stringify(p0.resto) === JSON.stringify(p1.resto));
    t('no toca a otra persona', !o1.w && JSON.stringify(o0.resto) === JSON.stringify(o1.resto));
    t('escribir la columna directo sigue frenado (candado de 0081 / RLS)', directo !== 'pasó', directo);
    console.log('    · ' + directo);
    await c.query('ROLLBACK TO SAVEPOINT prueba');
  } else {
    t('hay dos tripulantes para probar la función', false, 'no hay');
  }

  const despues = await huella();
  t(`fuera de la marca, profiles quedó idéntico (${antes.n} perfiles)`, JSON.stringify(antes) === JSON.stringify(despues));

  const fin = aplicar && !fallas.length ? 'COMMIT' : 'ROLLBACK';
  await c.query(fin);
  console.log(fallas.length
    ? `\n✗ ${fallas.length} comprobación(es) fallaron: ${fin}.`
    : `\n✓ Todo bien. ${fin === 'COMMIT' ? 'APLICADA en ' + amb + '.' : 'En seco: se deshizo (usa --aplicar).'}`);
} catch (e) {
  try { await c.query('ROLLBACK'); } catch (_) { /* */ }
  console.error('\n✗ Error, se deshizo todo:', e.message);
  fallas.push('error');
} finally {
  await c.end();
}
process.exit(fallas.length ? 1 : 0);
