// 0133 · Pasajeros sin cuenta en la ruta de Julián (Kriss). Va ENCIMA de 0125.
//
//   LOCAL:  node scripts/_aplicar-0133.mjs --local [--aplicar]
//   DEV:    cd rendio-backend && set -a && source .env.dev && set +a && node scripts/_aplicar-0133.mjs [--aplicar]
//   PRODUCCIÓN (con su OK, después del respaldo en una carpeta NUEVA):
//           cd rendio-backend && set -a && source .env.main && set +a && node scripts/_aplicar-0133.mjs --produccion [--aplicar]
//   REVERSA: … --reversa [--aplicar]   (corre down_migrations/0133_pasajero_sin_cuenta.down.sql)
//
// Todo en UNA transacción; solo con --aplicar (y todo bien) se confirma.
//
// ANTES comprueba que la función que 0133 reemplaza (admin_manual_route_publish)
// es EXACTAMENTE la de 0125: se aplica el bloque de 0125 en un punto de guardado,
// se mide su huella y se deshace. Si alguien la cambió después, no aplica.
//
// Después comprueba que aplicar no mueve nada (paradas, reservas, vueltas y avisos
// idénticos; las columnas nuevas arrancan vacías) y que lo que ve cada tripulante
// en «mis viajes» es EXACTAMENTE lo de antes. OJO: la reversa BORRA las paradas de
// pasajeros sin cuenta que existan (y la vuelta que quede vacía).
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
const que = reversa ? 'la REVERSA de 0133' : '0133';
console.log(aplicar ? `\n== APLICANDO ${que} en ${amb} ==` : `\n== ${que} EN SECO contra ${amb} (se deshace) ==`);
const fallas = [];
const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); if (!ok) fallas.push(n); };
const strip = (f) => readFileSync(new URL(f, import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const FUNCS = ['admin_manual_route_publish'];
const huellas = async () => Object.fromEntries((await q(`SELECT p.proname, md5(p.prosrc) h FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = ANY ($1)`, [FUNCS])).map((r) => [r.proname, r.h]));
// El bloque de 0125 de esa función (para medir su huella).
const src0126 = readFileSync(new URL('../supabase/migrations/0125_ruta_de_julian.sql', import.meta.url), 'utf8');
const bloque = (firma) => { const i = src0126.indexOf(firma); const j = src0126.indexOf('$$;', src0126.indexOf('AS $$', i)) + 3; return i >= 0 ? src0126.slice(i, j) : null; };
const B0126 = [bloque('CREATE OR REPLACE FUNCTION public.admin_manual_route_publish(p_day date, p_blocks jsonb, p_aliases jsonb DEFAULT')];
const huellaDatos = async () => one(`SELECT
    (SELECT md5(coalesce(string_agg((to_jsonb(s) - 'guest_name' - 'guest_place' - 'guest_phone' - 'guest_residence_id' - 'guest_lat' - 'guest_lng')::text, ',' ORDER BY id), '')) FROM public.route_stops s) paradas,
    (SELECT md5(coalesce(string_agg(to_jsonb(r)::text, ',' ORDER BY id), '')) FROM public.reservations r) reservas,
    (SELECT md5(coalesce(string_agg(to_jsonb(a)::text, ',' ORDER BY id), '')) FROM public.route_assignments a) vueltas,
    (SELECT count(*)::int FROM public.notification_outbox) avisos`);
// Lo que ve un tripulante (sin la llave nueva).
const comoAux = async (uid) => {
  await q(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated', user_role: 'auxiliar' })]);
  await c.query('SET LOCAL ROLE authenticated');
  try { return (await one(`SELECT public.auxiliar_my_trips(30) j`)).j; }
  finally { await c.query('RESET ROLE'); await q(`SELECT set_config('request.jwt.claims', '', true)`); }
};
const sinDelegate = (x) => JSON.stringify(x);

try {
  await c.query('BEGIN');
  if (!reversa) {
    t('0125 aplicada (la ruta de Julián)', !!(await one(`SELECT 1 x FROM information_schema.columns WHERE table_schema='public' AND table_name='route_assignments' AND column_name='manual_day'`)) && B0126.every(Boolean));
    if (fallas.length) throw new Error('falta 0125');
    const hDb = await huellas();
    await c.query('SAVEPOINT h0126');
    for (const b of B0126) await c.query(b);
    const h0126 = await huellas();
    await c.query('ROLLBACK TO SAVEPOINT h0126');
    const ya = !!(await one(`SELECT 1 AS x FROM information_schema.columns WHERE table_schema='public' AND table_name='route_stops' AND column_name='guest_name'`));
    if (ya) console.log('  · 0133 ya estaba: se vuelve a correr (idempotente)');
    else t('admin_manual_route_publish es EXACTAMENTE la de 0125 (nadie la cambió después)', FUNCS.every((f) => hDb[f] && hDb[f] === h0126[f]), { hDb, h0126 });
    if (fallas.length) throw new Error('la función no es la de 0125: volver a copiarla antes de aplicar');
  }
  const auxs = (await q(`SELECT pr.id FROM public.auxiliar_profiles ap JOIN public.profiles pr ON pr.id = ap.profile_id
      WHERE EXISTS (SELECT 1 FROM public.reservations r WHERE r.auxiliar_profile_id = ap.id AND r.required_arrival_at > now() - interval '3 days') LIMIT 5`)).map((r) => r.id);
  const antes = {};
  for (const u of auxs) antes[u] = await comoAux(u);
  const d0 = await huellaDatos();
  await c.query(strip(reversa ? '../down_migrations/0133_pasajero_sin_cuenta.down.sql' : '../supabase/migrations/0133_pasajero_sin_cuenta.sql'));
  if (!reversa) {
    const d1 = await huellaDatos();
    t('aplicar no mueve paradas, reservas, vueltas ni avisos', JSON.stringify(d0) === JSON.stringify(d1), { d0, d1 });
    let iguales = true;
    for (const u of auxs) { const despues = await comoAux(u); if (sinDelegate(despues) !== sinDelegate(antes[u])) iguales = false; }
    t(`lo que ven ${auxs.length} tripulantes es EXACTAMENTE lo de antes`, iguales);
    const ok = await one(`SELECT to_regprocedure('public.driver_set_guest_stop_status(uuid,text)') IS NOT NULL f,
        (SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='route_stops' AND column_name='reservation_id') nul,
        EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'route_stops_reserva_o_sin_cuenta') chk`);
    t('la RPC del conductor, la parada sin reserva y su CHECK quedaron', ok.f && ok.nul === 'YES' && ok.chk, ok);
  } else {
    const hR = await huellas();
    await c.query('SAVEPOINT h0126');
    for (const b of B0126) await c.query(b);
    const h0126 = await huellas();
    await c.query('ROLLBACK TO SAVEPOINT h0126');
    t('la reversa deja admin_manual_route_publish EXACTAMENTE como en 0125', FUNCS.every((f) => hR[f] === h0126[f]), { hR, h0126 });
    t('y quita la RPC y vuelve a exigir la reserva', !(await one(`SELECT to_regprocedure('public.driver_set_guest_stop_status(uuid,text)') IS NOT NULL OR (SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='route_stops' AND column_name='reservation_id') = 'YES' AS x`)).x);
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
