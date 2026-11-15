// 0164 · El aviso del apoyo, bien escrito (sin «p. m..»).
//   cd rendio-backend && set -a && source <.env.dev|.env.main> && set +a && node --experimental-strip-types scripts/_aplicar-0164.mjs [--produccion] [--aplicar]
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const DEV = 'lxlphbafhtphulanhzlp', PROD = 'wvuurnfdrrdondrbbkhd';
const prod = process.argv.includes('--produccion'), aplicar = process.argv.includes('--aplicar');
const esperado = prod ? PROD : DEV;
if ((process.env.SUPABASE_PROJECT_REF || '') !== esperado || !(process.env.SUPABASE_URL || '').includes(esperado)) { console.error('ABORT: ambiente equivocado'); process.exit(2); }
const Motor = createRequire(import.meta.url)(new URL('../../rendio-turnos/despacho-llegadas.js', import.meta.url).pathname);
const { armarEstado } = await import(new URL('../supabase/functions/despacho-llegadas/estado.ts', import.meta.url).pathname);
const c = new pg.Client({ host: prod ? 'aws-1-us-west-2.pooler.supabase.com' : 'aws-1-us-east-1.pooler.supabase.com', port: 5432, database: 'postgres', user: 'postgres.' + esperado, password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false }, statement_timeout: 60000 });
await c.connect();
const q = async (s, v) => (await c.query(s, v)).rows, one = async (s, v) => (await q(s, v))[0];
const fallas = []; const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + JSON.stringify(d) : ''}`); if (!ok) fallas.push(n); };
const sql = readFileSync(new URL('../supabase/migrations/0164_apoyo_texto.sql', import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const como = async (uid) => { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]); await c.query('SET LOCAL ROLE authenticated'); };
const comoDb = async () => { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', '', true)`); };
console.log(`\n== 0164 ${aplicar ? 'APLICANDO' : 'EN SECO'} en ${prod ? 'PRODUCCIÓN' : 'dev'} ==`);
await c.query('BEGIN');
try {
  await c.query(`SET LOCAL lock_timeout = '5s'`);
  t('está 0163 (apoyo_avisar)', !!(await one(`SELECT 1 x FROM pg_proc WHERE proname = 'apoyo_avisar'`)));
  if (fallas.length) throw new Error('falta 0163');
  await c.query(sql);
  const g = await one(`SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('anon', p.oid, 'EXECUTE') n, has_function_privilege('service_role', p.oid, 'EXECUTE') s FROM pg_proc p WHERE p.proname = 'apoyo_avisar'`);
  t('apoyo_avisar sigue siendo solo del servidor', g && g.a === false && g.n === false && g.s === true, g);
  if (!prod) {
    await c.query('SAVEPOINT prueba');
    const B = await one(`SELECT dp.id, dp.profile_id FROM public.profiles p JOIN public.driver_profiles dp ON dp.profile_id = p.id WHERE p.email = 'demo-conductor@rendio.demo'`);
    const antes = new Set((await q(`SELECT id FROM public.notification_outbox WHERE profile_id = $1`, [B.profile_id])).map((o) => o.id));
    for (const [dia, banda, tiene] of [[0, 'am', true], [1, 'pm', true], [0, 'pm', false], [5, 'am', true]])
      await c.query(`SELECT public.apoyo_avisar($1, (now() AT TIME ZONE 'America/Bogota')::date + $2::int, $3, $4)`, [B.id, dia, banda, tiene]);
    const bz = (await q(`SELECT id, title, body FROM public.notification_outbox WHERE profile_id = $1`, [B.profile_id])).filter((o) => !antes.has(o.id));
    t('hoy en la mañana: «Hoy, de 2:00 a. m. a 2:00 p. m. Si los carros…»', bz.some((o) => /^Hoy, de 2:00 a\. m\. a 2:00 p\. m\. Si los carros fijos/.test(o.body)), bz.map((o) => o.body));
    t('mañana en la tarde: «Mañana, de 2:00 p. m. a 2:00 a. m. Si…»', bz.some((o) => /^Mañana, de 2:00 p\. m\. a 2:00 a\. m\. Si los/.test(o.body)), bz.map((o) => o.body));
    t('otro día: «El DD/MM, de…»', bz.some((o) => /^El \d\d\/\d\d, de 2:00 a\. m\./.test(o.body)), bz.map((o) => o.body));
    t('al quitarlo: «Coordinación cambió el apoyo de hoy en la tarde.»', bz.some((o) => /^Ya no tienes/.test(o.title) && o.body === 'Coordinación cambió el apoyo de hoy en la tarde.'), bz);
    t('ningún aviso con dos puntos seguidos', bz.length === 4 && bz.every((o) => !/\.\./.test(o.body)), bz.map((o) => o.body));
    await c.query('ROLLBACK TO SAVEPOINT prueba');
  }
  if (fallas.length) throw new Error(fallas.length + ' comprobaciones fallaron');
  if (aplicar) { await c.query('COMMIT'); console.log('\n✔ 0164 APLICADA.'); } else { await c.query('ROLLBACK'); console.log('\n✔ En seco: todo bien. No se cambió nada.'); }
} catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error(`\n✗ ${e.message}\n  Se deshizo todo.`); process.exitCode = 1; } finally { await c.end(); }
