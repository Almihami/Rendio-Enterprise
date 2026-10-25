// 0120 · Ajuste manual de horas desde el Balance.
//
//   DEV (en seco / de verdad):
//     cd rendio-backend && set -a && source .env.dev && set +a && node scripts/_aplicar-0120.mjs
//     cd rendio-backend && set -a && source .env.dev && set +a && node scripts/_aplicar-0120.mjs --aplicar
//   PRODUCCIÓN (solo con su OK, después del respaldo):
//     cd rendio-backend && set -a && source .env.main && set +a && node scripts/_aplicar-0120.mjs --produccion
//     cd rendio-backend && set -a && source .env.main && set +a && node scripts/_aplicar-0120.mjs --produccion --aplicar
//
// Todo va en UNA transacción: se aplica 0120, se comprueba y, solo si todo está
// bien y se pidió --aplicar, se confirma. En seco se deshace. La prueba de las
// funciones (un jefe de verdad ajusta y anula un turno de verdad, con su sesión
// simulada) va en un SAVEPOINT que SIEMPRE se deshace: no queda ningún ajuste.
//
// Comprueba: la tabla con RLS y sus dos políticas; nadie la escribe directo;
// anon no llama las funciones y una sesión sí; el jefe ajusta y anula; el
// conductor ve su ajuste y otro conductor no; y que shifts quedó idéntico.
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
console.log(aplicar ? `\n== APLICANDO 0120 en ${amb} ==` : `\n== 0120 EN SECO contra ${amb} (se deshace) ==`);

// La huella de shifts: 0120 no debe mover ni una fila.
const huella = async () => (await q(`SELECT count(*)::int n, md5(string_agg(to_jsonb(s)::text, ',' ORDER BY id)) firma FROM public.shifts s`))[0];
const fallas = [];
const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d ? ' → ' + d : ''}`); if (!ok) fallas.push(n); };
const como = async (uid) => {
  await q(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
  await c.query('SET LOCAL ROLE authenticated');
};
try {
  const antes = await huella();
  const yaEstaba = (await q(`SELECT to_regclass('public.shift_hour_adjustments') IS NOT NULL x`))[0].x;
  await c.query('BEGIN');
  await c.query(readFileSync(new URL('../supabase/migrations/0120_ajuste_manual_de_horas.sql', import.meta.url), 'utf8')
    .replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, ''));
  console.log(yaEstaba ? '  · la tabla YA estaba (se corre igual: es idempotente)' : '  · la tabla es nueva');

  const SIG = 'public.adjust_shift_hours(uuid, uuid, date, timestamptz, timestamptz, text)';
  const SIGV = 'public.void_shift_hour_adjustment(uuid, text)';
  const o = (await q(`SELECT
      (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.shift_hour_adjustments'::regclass) rls,
      (SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public' AND tablename = 'shift_hour_adjustments') pol,
      has_table_privilege('authenticated', 'public.shift_hour_adjustments', 'INSERT') ins,
      has_table_privilege('authenticated', 'public.shift_hour_adjustments', 'UPDATE') upd,
      has_table_privilege('authenticated', 'public.shift_hour_adjustments', 'DELETE') del,
      has_table_privilege('authenticated', 'public.shift_hour_adjustments', 'SELECT') sel,
      has_function_privilege('anon', '${SIG}', 'EXECUTE') anon_a,
      has_function_privilege('anon', '${SIGV}', 'EXECUTE') anon_v,
      has_function_privilege('authenticated', '${SIG}', 'EXECUTE') auth_a,
      has_function_privilege('authenticated', '${SIGV}', 'EXECUTE') auth_v,
      (SELECT count(*)::int FROM pg_constraint WHERE conname IN ('shift_hour_adjustments_created_by_fkey', 'shift_hour_adjustments_voided_by_fkey')) fks`))[0];
  t('la tabla tiene RLS y sus dos políticas de lectura', o.rls && o.pol === 2, `rls=${o.rls} políticas=${o.pol}`);
  t('una sesión la puede leer pero NO escribir directo', o.sel && !o.ins && !o.upd && !o.del);
  t('anon no llama las funciones; una sesión sí', !o.anon_a && !o.anon_v && o.auth_a && o.auth_v);
  t('las dos llaves a profiles que usa la app (creador / anulador)', o.fks === 2, o.fks);

  // Un jefe de verdad corrige un turno cerrado de verdad — y se deshace.
  const [cand] = await q(`SELECT s.id, s.start_at, s.end_at, s.driver_id, dp.profile_id drv, a.id jefe,
        (s.start_at AT TIME ZONE 'America/Bogota')::date::text dia
      FROM public.shifts s
      JOIN public.driver_profiles dp ON dp.id = s.driver_id
      JOIN public.profiles a ON a.organization_id = s.organization_id AND a.role = 'admin' AND a.deleted_at IS NULL
     WHERE s.end_at IS NOT NULL AND s.opening_km IS NOT NULL AND s.end_at - s.start_at BETWEEN interval '1 hour' AND interval '20 hours'
       AND s.end_at < now() - interval '1 hour'
       AND NOT EXISTS (SELECT 1 FROM public.shifts o WHERE o.driver_id = s.driver_id AND o.id <> s.id AND o.opening_km IS NOT NULL
                        AND tstzrange(o.start_at, coalesce(o.end_at, now())) && tstzrange(s.start_at, s.end_at))
     ORDER BY s.start_at DESC LIMIT 1`);
  const [otroDrv] = cand ? await q(`SELECT dp.profile_id FROM public.driver_profiles dp JOIN public.profiles p ON p.id = dp.profile_id
     WHERE dp.id <> $1 AND p.deleted_at IS NULL LIMIT 1`, [cand.driver_id]) : [];
  if (cand) {
    await c.query('SAVEPOINT prueba');
    const nuevoFin = new Date(new Date(cand.start_at).getTime() + 3600e3).toISOString(); // 1 h exacta
    await como(cand.jefe);
    const r = (await q(`SELECT public.adjust_shift_hours($1, $2, $3, $4, $5, $6) r`,
      [cand.drv, cand.id, cand.dia, new Date(cand.start_at).toISOString(), nuevoFin, 'Prueba del aplicador de 0120 (se deshace)']))[0].r;
    const ve = (await q(`SELECT count(*)::int n FROM public.shift_hour_adjustments WHERE id = $1`, [r.id]))[0].n;
    let cruce = null;
    await c.query('SAVEPOINT cruce');
    try {
      await q(`SELECT public.adjust_shift_hours($1, NULL, $2, $3, $4, $5)`,
        [cand.drv, cand.dia, new Date(cand.start_at).toISOString(), nuevoFin, 'Esto se cruza con el ajuste de arriba']);
      cruce = 'pasó';
    } catch (e) { cruce = e.message; }
    await c.query('ROLLBACK TO SAVEPOINT cruce');
    const v = (await q(`SELECT public.void_shift_hour_adjustment($1, 'Prueba del aplicador') r`, [r.id]))[0].r;
    await c.query('RESET ROLE');
    await como(cand.drv);
    const veDrv = (await q(`SELECT count(*)::int n FROM public.shift_hour_adjustments WHERE id = $1`, [r.id]))[0].n;
    let noAdmin = null;
    await c.query('SAVEPOINT noadmin');
    try { await q(`SELECT public.adjust_shift_hours($1, $2, $3, $4, $5, $6)`, [cand.drv, cand.id, cand.dia, new Date(cand.start_at).toISOString(), nuevoFin, 'El conductor no puede hacer esto']); noAdmin = 'pasó'; }
    catch (e) { noAdmin = e.message; }
    await c.query('ROLLBACK TO SAVEPOINT noadmin');
    await c.query('RESET ROLE');
    let veOtro = null;
    if (otroDrv) { await como(otroDrv.profile_id); veOtro = (await q(`SELECT count(*)::int n FROM public.shift_hour_adjustments WHERE id = $1`, [r.id]))[0].n; await c.query('RESET ROLE'); }
    const fila = (await q(`SELECT orig_kind, voided_at IS NOT NULL anulado, created_by FROM public.shift_hour_adjustments WHERE id = $1`, [r.id]))[0];
    const aud = (await q(`SELECT count(*)::int n FROM public.audit_events WHERE entity_type = 'shift_hour_adjustment' AND entity_id = $1`, [r.id]))[0].n;
    t('un jefe ajusta un turno cerrado y lo ve', r && r.ok && ve === 1);
    t('guarda quién y cómo estaba el turno', fila && fila.created_by === cand.jefe && ['ok', 'auto'].includes(fila.orig_kind), JSON.stringify(fila));
    t('la base frena un cruce con esas mismas horas', /CRUCE/.test(cruce || ''), cruce);
    t('el jefe lo anula y la fila queda, anulada', v && v.ok && fila && fila.anulado);
    t('el ajuste y la anulación quedan en la bitácora', aud === 2, aud);
    t('el conductor ve su ajuste', veDrv === 1, veDrv);
    t('el conductor NO puede ajustar', /NOT_ADMIN/.test(noAdmin || ''), noAdmin);
    if (otroDrv) t('otro conductor no lo ve', veOtro === 0, veOtro);
    await c.query('ROLLBACK TO SAVEPOINT prueba');
    const quedan = (await q(`SELECT count(*)::int n FROM public.shift_hour_adjustments WHERE note LIKE 'Prueba del aplicador%'`))[0].n;
    t('la prueba se deshizo: no queda ningún ajuste de prueba', quedan === 0, quedan);
  } else {
    t('hay un turno cerrado con jefe para probar', false, 'no hay');
  }

  const despues = await huella();
  t(`shifts quedó idéntico (${antes.n} turnos)`, JSON.stringify(antes) === JSON.stringify(despues));

  const fin = aplicar && !fallas.length ? 'COMMIT' : 'ROLLBACK';
  await c.query(fin);
  if (fin === 'COMMIT') await c.query(`NOTIFY pgrst, 'reload schema'`);
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
