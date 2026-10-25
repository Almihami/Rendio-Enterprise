// 0121 · La reserva del tripulante (Río Verde, Movich o Aero).
//
//   LOCAL:  node scripts/_aplicar-0121.mjs --local [--aplicar]
//   DEV:    cd rendio-backend && set -a && source .env.dev && set +a && node scripts/_aplicar-0121.mjs [--aplicar]
//   PRODUCCIÓN (con su OK, después del respaldo):
//           cd rendio-backend && set -a && source .env.main && set +a && node scripts/_aplicar-0121.mjs --produccion [--aplicar]
//
// Todo en UNA transacción: se aplica 0121, se comprueba y solo con --aplicar (y
// todo bien) se confirma. La prueba de la función va en un SAVEPOINT que siempre
// se deshace: crea un traslado de llegada de un tripulante real, lo cambia como
// lo haría él desde la app (vuelo → reserva en Movich → vuelo otra vez) y lo
// borra. Ningún otro traslado se mueve (huella de reservations).
import pg from 'pg';
import { readFileSync } from 'node:fs';

const DEV = 'lxlphbafhtphulanhzlp', PROD = 'wvuurnfdrrdondrbbkhd';
const local = process.argv.includes('--local');
const prod = process.argv.includes('--produccion');
const aplicar = process.argv.includes('--aplicar');
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
console.log(aplicar ? `\n== APLICANDO 0121 en ${amb} ==` : `\n== 0121 EN SECO contra ${amb} (se deshace) ==`);

const huella = async () => (await q(`SELECT count(*)::int n,
    md5(string_agg((to_jsonb(r) - 'reserve_place')::text, ',' ORDER BY id)) firma FROM public.reservations r`))[0];
const fallas = [];
const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d ? ' → ' + d : ''}`); if (!ok) fallas.push(n); };
const errDe = async (fn) => { await c.query('SAVEPOINT e'); try { await fn(); await c.query('RELEASE SAVEPOINT e'); return null; } catch (e) { await c.query('ROLLBACK TO SAVEPOINT e'); return e.message; } };

try {
  const antes = await huella();
  await c.query('BEGIN');
  await c.query(readFileSync(new URL('../supabase/migrations/0121_reserva_hotel.sql', import.meta.url), 'utf8')
    .replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, ''));

  const o = (await q(`SELECT
      (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='reservations' AND column_name='reserve_place')::int col,
      EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reservations_reserve_place_chk') chk,
      to_regprocedure('public.auxiliar_change_flight(uuid,text,timestamptz,text)') IS NOT NULL f4,
      to_regprocedure('public.auxiliar_change_flight(uuid,text,timestamptz)') IS NOT NULL f3,
      has_function_privilege('anon', 'public.auxiliar_change_flight(uuid,text,timestamptz,text)', 'EXECUTE') anon_x,
      has_function_privilege('authenticated', 'public.auxiliar_change_flight(uuid,text,timestamptz,text)', 'EXECUTE') auth_x,
      has_function_privilege('authenticated', 'public.auxiliar_my_trips(integer)', 'EXECUTE') trips_x,
      (SELECT count(*) FROM public.reservations WHERE reserve_place IS NOT NULL)::int marcadas`))[0];
  t('la columna reserve_place y su CHECK quedaron', o.col === 1 && o.chk);
  t('auxiliar_change_flight con 4 parámetros; la de 3 se fue', o.f4 && !o.f3);
  t('permisos: anon no; una sesión sí (cambio y mis viajes)', !o.anon_x && o.auth_x && o.trips_x);
  t('ningún traslado existente quedó de reserva', o.marcadas === 0, o.marcadas);
  const malo = await errDe(() => q(`UPDATE public.reservations SET reserve_place = 'hilton' WHERE id = (SELECT id FROM public.reservations LIMIT 1)`));
  t('un lugar que no existe no entra (CHECK)', !!malo && /reserve_place_chk/.test(malo), malo);

  // ── Prueba de la función con un traslado de verdad (y se deshace) ──
  await c.query('SAVEPOINT prueba');
  const auxs = await q(`SELECT ap.id ap, ap.profile_id pid FROM public.auxiliar_profiles ap JOIN public.profiles p ON p.id = ap.profile_id
                         WHERE p.deleted_at IS NULL AND p.is_active IS NOT FALSE ORDER BY p.created_at LIMIT 8`);
  let res = null, quien = null, motivo = '';
  for (const a of auxs) {
    const e = await errDe(async () => {
      res = (await q(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_a2h, pickup_address, pickup_latitude, pickup_longitude, required_arrival_at, notes)
                      VALUES ($1, 'airport_to_home', 'scheduled', 'Prueba 0121', 6.15, -75.37, date_trunc('minute', now()) + interval '3 days', 'Vuelo AV9412. Nota de prueba') RETURNING id, required_arrival_at`, [a.ap]))[0];
    });
    if (!e) { quien = a; break; }
    motivo = e;
  }
  if (!res) {
    t('se pudo crear un traslado de prueba', false, motivo);
  } else {
    await q(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: quien.pid, role: 'authenticated' })]);
    await c.query('SET LOCAL ROLE authenticated');
    const cf = (flight, when, place) => q(`SELECT public.auxiliar_change_flight($1, $2, $3::timestamptz${place === undefined ? '' : ', $4'}) j`,
      place === undefined ? [res.id, flight, when] : [res.id, flight, when, place]).then((r) => r[0].j);
    const w0 = res.required_arrival_at;
    const w1 = new Date(new Date(w0).getTime() + 3600e3).toISOString();
    const w2 = new Date(new Date(w0).getTime() + 7200e3).toISOString();
    const fila = async () => (await q(`SELECT reserve_place, notes, required_arrival_at FROM public.reservations WHERE id = $1`, [res.id]))[0];

    const viajes = (await q(`SELECT public.auxiliar_my_trips(30) j`))[0].j || [];
    const mio = viajes.find((x) => x.id === res.id);
    t('mis viajes trae reserve_place', !!mio && Object.prototype.hasOwnProperty.call(mio, 'reserve_place'), JSON.stringify(mio && Object.keys(mio).length));

    const r1 = await cf('', w0, 'movich');
    let f = await fila();
    t('vuelo → reserva en Movich, misma hora: se guarda y sin vuelo en las notas', r1.mode === 'updated' && f.reserve_place === 'movich' && !/vuelo/i.test(f.notes || '') && /Nota de prueba/.test(f.notes || ''), JSON.stringify({ r1, f }));
    const r2 = await cf('', w0, null);
    t('sin cambios (lugar NULL = como estaba): «unchanged»', r2.unchanged === true && r2.reserve_place === 'movich', JSON.stringify(r2));
    const r3 = await cf('', w1, undefined);
    f = await fila();
    t('la app vieja (3 parámetros) cambia la hora de una reserva sin pedir vuelo', r3.mode === 'updated' && f.reserve_place === 'movich' && new Date(f.required_arrival_at).getTime() === new Date(w1).getTime(), JSON.stringify(r3));
    const e4 = await errDe(() => cf('', w2, 'vuelo'));
    t('reserva → vuelo en una llegada SIN vuelo: lo pide', !!e4 && /número de vuelo/i.test(e4), e4);
    const r5 = await cf('AV1234', w2, 'vuelo');
    f = await fila();
    t('reserva → vuelo AV1234: queda sin reserva y con el vuelo en las notas', r5.mode === 'updated' && f.reserve_place === null && /^Vuelo AV1234\./.test(f.notes || ''), JSON.stringify({ r5, f }));
    const e6 = await errDe(() => cf('', w2, 'hilton'));
    t('un lugar que no existe: error claro', !!e6 && /lugar de reserva no existe/i.test(e6), e6);
    await c.query('RESET ROLE');
  }
  await c.query('ROLLBACK TO SAVEPOINT prueba');

  const despues = await huella();
  t(`los demás traslados quedaron idénticos (${antes.n})`, JSON.stringify(antes) === JSON.stringify(despues));

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
