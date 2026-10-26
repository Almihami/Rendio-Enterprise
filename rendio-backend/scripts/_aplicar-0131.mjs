// 0131 · Delegar con nombre y teléfono + la libreta. Va ENCIMA de 0126 (y de 0129).
//
//   LOCAL:  node scripts/_aplicar-0131.mjs --local [--aplicar]
//   DEV:    cd rendio-backend && set -a && source .env.dev && set +a && node scripts/_aplicar-0131.mjs [--aplicar]
//   PRODUCCIÓN (con su OK, después del respaldo en una carpeta NUEVA):
//           cd rendio-backend && set -a && source .env.main && set +a && node scripts/_aplicar-0131.mjs --produccion [--aplicar]
//   REVERSA: … --reversa [--aplicar]   (corre down_migrations/0131_delegado_con_nombre.down.sql)
//
// Todo en UNA transacción; solo con --aplicar (y todo bien) se confirma.
//
// ANTES comprueba que las dos funciones que 0131 reemplaza (auxiliar_my_trips y
// admin_route_set_delegated) son EXACTAMENTE las de 0126: se aplican los bloques
// de 0126 en un punto de guardado, se mide su huella y se deshace. Si alguien las
// cambió después de 0126, no aplica (habría que volver a copiarlas).
//
// Después comprueba que aplicar no mueve nada (paradas, reservas, vueltas y avisos
// idénticos) y que lo que ve cada tripulante en «mis viajes» es lo mismo de antes
// más «delegate» (null mientras nadie delegue con nombre).
import pg from 'pg';
import { readFileSync } from 'node:fs';

const DEV = 'lxlphbafhtphulanhzlp', PROD = 'wvuurnfdrrdondrbbkhd';
const local = process.argv.includes('--local');
const prod = process.argv.includes('--produccion');
const aplicar = process.argv.includes('--aplicar');
const reversa = process.argv.includes('--reversa');
let c, amb;
if (local) {
  c = new pg.Client({ connectionString: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' });
  amb = 'LOCAL';
} else {
  const ref = process.env.SUPABASE_PROJECT_REF || '';
  const esperado = prod ? PROD : DEV;
  if (ref !== esperado || !(process.env.SUPABASE_URL || '').includes(esperado)) {
    console.error(`ABORT: se esperaba ${prod ? 'PRODUCCIÓN' : 'dev'} (${esperado}) y se cargó ${ref || '(nada)'}.`);
    process.exit(2);
  }
  c = new pg.Client({ host: prod ? 'aws-1-us-west-2.pooler.supabase.com' : 'aws-1-us-east-1.pooler.supabase.com',
    port: 5432, user: 'postgres.' + ref, password: process.env.SUPABASE_DB_PASSWORD, database: 'postgres',
    ssl: { rejectUnauthorized: false }, statement_timeout: 120000 });
  amb = prod ? 'PRODUCCIÓN' : 'dev';
}
await c.connect();
const q = async (s, v) => (await c.query(s, v)).rows;
const one = async (s, v) => (await q(s, v))[0];
const que = reversa ? 'la REVERSA de 0131' : '0131';
console.log(aplicar ? `\n== APLICANDO ${que} en ${amb} ==` : `\n== ${que} EN SECO contra ${amb} (se deshace) ==`);
const fallas = [];
const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); if (!ok) fallas.push(n); };
const strip = (f) => readFileSync(new URL(f, import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const FUNCS = ['auxiliar_my_trips', 'admin_route_set_delegated'];
const huellas = async () => Object.fromEntries((await q(`SELECT p.proname, md5(p.prosrc) h FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = ANY ($1)`, [FUNCS])).map((r) => [r.proname, r.h]));
// Los bloques de 0126 de esas dos funciones (para medir su huella).
const src0126 = readFileSync(new URL('../supabase/migrations/0126_vuelta_delegada.sql', import.meta.url), 'utf8');
const bloque = (firma) => { const i = src0126.indexOf(firma); const j = src0126.indexOf('$$;', src0126.indexOf('AS $$', i)) + 3; return i >= 0 ? src0126.slice(i, j) : null; };
const B0126 = [bloque('CREATE OR REPLACE FUNCTION public.auxiliar_my_trips(p_days_back int DEFAULT 60)'), bloque('CREATE OR REPLACE FUNCTION public.admin_route_set_delegated(p_route uuid, p_on boolean)')];
const huellaDatos = async () => one(`SELECT
    (SELECT md5(coalesce(string_agg(to_jsonb(s)::text, ',' ORDER BY id), '')) FROM public.route_stops s) paradas,
    (SELECT md5(coalesce(string_agg(to_jsonb(r)::text, ',' ORDER BY id), '')) FROM public.reservations r) reservas,
    (SELECT md5(coalesce(string_agg((to_jsonb(a) - 'delegate_name' - 'delegate_phone')::text, ',' ORDER BY id), '')) FROM public.route_assignments a) vueltas,
    (SELECT count(*)::int FROM public.notification_outbox) avisos`);
// Lo que ve un tripulante (sin la llave nueva).
const comoAux = async (uid) => {
  await q(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated', user_role: 'auxiliar' })]);
  await c.query('SET LOCAL ROLE authenticated');
  try { return (await one(`SELECT public.auxiliar_my_trips(30) j`)).j; }
  finally { await c.query('RESET ROLE'); await q(`SELECT set_config('request.jwt.claims', '', true)`); }
};
const sinDelegate = (x) => JSON.stringify(x, (k, v) => (k === 'delegate' ? undefined : v));

try {
  await c.query('BEGIN');
  if (!reversa) {
    t('0126 aplicada (delegated_at y las dos funciones)', !!(await one(`SELECT 1 x FROM information_schema.columns WHERE table_schema='public' AND table_name='route_assignments' AND column_name='delegated_at'`)) && B0126.every(Boolean));
    if (fallas.length) throw new Error('falta 0126');
    const hDb = await huellas();
    await c.query('SAVEPOINT h0126');
    for (const b of B0126) await c.query(b);
    const h0126 = await huellas();
    await c.query('ROLLBACK TO SAVEPOINT h0126');
    const ya = !!(await one(`SELECT to_regclass('public.delegate_contacts') IS NOT NULL AS x`)).x;
    if (ya) console.log('  · 0131 ya estaba: se vuelve a correr (idempotente)');
    else t('las dos funciones son EXACTAMENTE las de 0126 (nadie las cambió después)', FUNCS.every((f) => hDb[f] && hDb[f] === h0126[f]), { hDb, h0126 });
    if (fallas.length) throw new Error('las funciones no son las de 0126: volver a copiarlas antes de aplicar');
  }
  const auxs = (await q(`SELECT pr.id FROM public.auxiliar_profiles ap JOIN public.profiles pr ON pr.id = ap.profile_id
      WHERE EXISTS (SELECT 1 FROM public.reservations r WHERE r.auxiliar_profile_id = ap.id AND r.required_arrival_at > now() - interval '3 days') LIMIT 5`)).map((r) => r.id);
  const antes = {};
  for (const u of auxs) antes[u] = await comoAux(u);
  const d0 = await huellaDatos();
  await c.query(strip(reversa ? '../down_migrations/0131_delegado_con_nombre.down.sql' : '../supabase/migrations/0131_delegado_con_nombre.sql'));
  if (!reversa) {
    const d1 = await huellaDatos();
    t('aplicar no mueve paradas, reservas, vueltas ni avisos', JSON.stringify(d0) === JSON.stringify(d1), { d0, d1 });
    let iguales = true;
    for (const u of auxs) { const despues = await comoAux(u); if (sinDelegate(despues) !== sinDelegate(antes[u])) iguales = false; }
    t(`lo que ven ${auxs.length} tripulantes es lo mismo de antes más «delegate»`, iguales);
    const ok = await one(`SELECT to_regclass('public.delegate_contacts') IS NOT NULL t,
        to_regprocedure('public.admin_route_delegate(uuid,text,text)') IS NOT NULL f,
        (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.delegate_contacts'::regclass) rls`);
    t('la libreta (con RLS) y la RPC quedaron', ok.t && ok.f && ok.rls, ok);
  } else {
    const hR = await huellas();
    await c.query('SAVEPOINT h0126');
    for (const b of B0126) await c.query(b);
    const h0126 = await huellas();
    await c.query('ROLLBACK TO SAVEPOINT h0126');
    t('la reversa deja las dos funciones EXACTAMENTE como en 0126', FUNCS.every((f) => hR[f] === h0126[f]), { hR, h0126 });
    t('y quita la libreta y la RPC', !(await one(`SELECT to_regclass('public.delegate_contacts') IS NOT NULL OR to_regprocedure('public.admin_route_delegate(uuid,text,text)') IS NOT NULL AS x`)).x);
  }
  if (fallas.length) throw new Error('verificación con fallas');
  if (aplicar) { await c.query('COMMIT'); console.log(`\n✓ ${que} APLICADA en ${amb}`); }
  else { await c.query('ROLLBACK'); console.log(`\n✓ en seco OK (nada quedó en ${amb}); para aplicar: --aplicar`); }
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error(`\n✗ NO se aplicó: ${e.message}${fallas.length ? ' · ' + fallas.join(' | ') : ''}`);
  process.exitCode = 1;
} finally {
  await c.end();
}
