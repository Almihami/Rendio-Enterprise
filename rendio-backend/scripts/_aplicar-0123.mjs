// 0123 · Cuentas de cobro por adelantado (el 21 se abre la del próximo corte).
//
//   LOCAL:  node scripts/_aplicar-0123.mjs --local [--aplicar]
//   DEV:    cd rendio-backend && set -a && source .env.dev && set +a && node scripts/_aplicar-0123.mjs [--aplicar]
//   PRODUCCIÓN (con su OK, después del respaldo):
//           cd rendio-backend && set -a && source .env.main && set +a && node scripts/_aplicar-0123.mjs --produccion [--aplicar]
//
// Todo en UNA transacción: se aplica 0123, se comprueba y solo con --aplicar (y
// todo bien) se confirma. La migración no cambia datos (solo agrega dos columnas
// con su valor por defecto y reemplaza funciones): la huella de las cuentas de
// cobro, los avisos y la cola de notificaciones tiene que quedar idéntica.
// Después, en un SAVEPOINT que SIEMPRE se deshace, se corre el reloj (lo que
// hará la próxima corrida de las 7 a. m.) para contar cuántas cuentas abriría por
// adelantado, y que ninguna quede pausada ni mande una notificación antes de su
// corte; y la lista del jefe y la cuenta de un tripulante, como los ve la app.
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
const one = async (s, v) => (await q(s, v))[0];
console.log(aplicar ? `\n== APLICANDO 0123 en ${amb} ==` : `\n== 0123 EN SECO contra ${amb} (se deshace) ==`);

// Huella de lo que la migración NO debe tocar (sin las columnas nuevas).
const huella = async () => one(`SELECT
    (SELECT count(*) FROM public.billing_statements)::int st,
    (SELECT md5(coalesce(string_agg((to_jsonb(s) - 'opened_early')::text, ',' ORDER BY id), '')) FROM public.billing_statements s) st_f,
    (SELECT count(*) FROM public.billing_alerts)::int al,
    (SELECT md5(coalesce(string_agg(to_jsonb(a)::text, ',' ORDER BY id), '')) FROM public.billing_alerts a) al_f,
    (SELECT count(*) FROM public.notification_outbox)::int ob,
    (SELECT md5(coalesce(string_agg((to_jsonb(b) - 'early_open_day')::text, ',' ORDER BY organization_id), '')) FROM public.billing_settings b) cfg_f`);
const fallas = [];
const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''}`); if (!ok) fallas.push(n); };

try {
  const antes = await huella();
  await c.query('BEGIN');
  await c.query(readFileSync(new URL('../supabase/migrations/0123_cobro_por_adelantado.sql', import.meta.url), 'utf8')
    .replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, ''));

  const o = await one(`SELECT
      (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='billing_settings' AND column_name='early_open_day')::int c1,
      (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='billing_statements' AND column_name='opened_early')::int c2,
      (SELECT count(*) FROM public.billing_settings)::int orgs,
      (SELECT count(*) FROM public.billing_settings WHERE early_open_day = 21)::int con21,
      (SELECT count(*) FROM public.billing_statements WHERE opened_early)::int early,
      to_regprocedure('public.billing_open_target(uuid,date)') IS NOT NULL f1,
      to_regprocedure('public.billing_open_early(uuid,date,date)') IS NOT NULL f2,
      has_function_privilege('authenticated', 'public.billing_open_target(uuid,date)', 'EXECUTE') t_auth,
      has_function_privilege('anon', 'public.billing_open_early(uuid,date,date)', 'EXECUTE') e_anon,
      has_function_privilege('authenticated', 'public.billing_open_early(uuid,date,date)', 'EXECUTE') e_auth,
      has_function_privilege('authenticated', 'public.admin_billing_open_statements(uuid[],boolean,boolean)', 'EXECUTE') open_auth,
      has_function_privilege('authenticated', 'public.admin_billing_list()', 'EXECUTE') list_auth,
      has_function_privilege('authenticated', 'public.aux_billing_my_account()', 'EXECUTE') me_auth,
      has_function_privilege('anon', 'public.admin_billing_list()', 'EXECUTE') list_anon`);
  t('las dos columnas quedaron', o.c1 === 1 && o.c2 === 1);
  t(`el día de apertura quedó en 21 en las ${o.orgs} organizaciones con ajustes`, o.con21 === o.orgs, o);
  t('ninguna cuenta existente quedó marcada «por adelantado»', o.early === 0, o.early);
  t('las dos funciones nuevas existen y la app no las puede llamar', o.f1 && o.f2 && !o.t_auth && !o.e_anon && !o.e_auth, o);
  t('los permisos de siempre siguen (jefe y tripulante sí; anónimo no)', o.open_auth && o.list_auth && o.me_auth && !o.list_anon, o);
  const durante = await huella();
  t(`cuentas (${antes.st}), avisos (${antes.al}), cola (${antes.ob}) y ajustes: idénticos`, JSON.stringify(antes) === JSON.stringify(durante), { antes, durante });

  // ── Lo que hará el reloj (se deshace) ──
  await c.query('SAVEPOINT reloj');
  const hoy = (await one(`SELECT public.billing_today()::text d`)).d;
  const ob0 = (await one(`SELECT count(*)::int n FROM public.notification_outbox`)).n;
  const r = (await one(`SELECT public.billing_run_daily() AS r`)).r;
  const e = await one(`SELECT count(*)::int n,
      count(*) FILTER (WHERE public.billing_statement_blocked(s, $1::date))::int pausadas,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.billing_alerts a WHERE a.statement_id = s.id))::int con_aviso,
      min(period_start)::text desde, max(period_start)::text hasta,
      count(*) FILTER (WHERE period_start <= $1::date)::int ya_empezadas
    FROM public.billing_statements s WHERE s.opened_early`, [hoy]);
  const ob1 = (await one(`SELECT count(*)::int n FROM public.notification_outbox`)).n;
  const nuevasNoEarly = (await one(`SELECT count(*)::int n FROM public.billing_statements WHERE NOT opened_early AND created_at >= now() - interval '1 minute'`)).n;
  console.log(`  · el reloj de hoy (${hoy}) abriría ${e.n} por adelantado (${e.desde || '—'} … ${e.hasta || '—'}); corrida: ${JSON.stringify(r)}`);
  t('ninguna de las anticipadas queda pausada ni con avisos', e.pausadas === 0 && e.con_aviso === 0, e);
  t('ninguna anticipada es de un período que ya empezó', e.ya_empezadas === 0, e);
  t('el reloj no encoló notificaciones por las anticipadas', ob1 - ob0 === 0, { antes: ob0, despues: ob1 });
  t('el reloj no abrió cuentas normales nuevas (eso ya lo hizo la corrida de hoy)', nuevasNoEarly === 0, nuevasNoEarly);

  // La lista del jefe y la cuenta de un tripulante, con las anticipadas puestas.
  // Un jefe de la organización que tiene cuentas de cobro.
  const jefe = await one(`SELECT p.id FROM public.profiles p WHERE p.role = 'admin' AND p.deleted_at IS NULL
                           AND p.organization_id IN (SELECT pr.organization_id FROM public.auxiliar_billing b
                                                      JOIN public.auxiliar_profiles ap ON ap.id = b.auxiliar_profile_id
                                                      JOIN public.profiles pr ON pr.id = ap.profile_id)
                         ORDER BY p.created_at LIMIT 1`);
  if (jefe) {
    await q(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: jefe.id, role: 'authenticated', user_role: 'admin' })]);
    await c.query('SET LOCAL ROLE authenticated');
    const L = (await one(`SELECT public.admin_billing_list() AS r`)).r || [];
    await c.query('RESET ROLE');
    const conCuenta = L.filter((x) => x.account);
    const conCampos = conCuenta.filter((x) => 'openCut' in x.account && 'openEarly' in x.account && 'openReason' in x.account);
    const verAnt = L.filter((x) => x.current && String(x.current.periodStart) > hoy).length;
    t(`lista del jefe: ${L.length} filas, las ${conCuenta.length} con cuenta traen openCut/openEarly/openReason`, conCuenta.length > 0 && conCampos.length === conCuenta.length);
    t(`lista del jefe: ${verAnt} muestran la anticipada como su cuenta actual`, verAnt <= e.n, verAnt);
  } else t('hay un jefe para leer la lista', false, 'sin jefe');
  const trip = await one(`SELECT ap.profile_id pid FROM public.billing_statements s JOIN public.auxiliar_profiles ap ON ap.id = s.auxiliar_profile_id
                           WHERE s.opened_early LIMIT 1`);
  if (trip) {
    await q(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: trip.pid, role: 'authenticated', user_role: 'auxiliar' })]);
    await c.query('SET LOCAL ROLE authenticated');
    const me = (await one(`SELECT public.aux_billing_my_account() AS r`)).r;
    await c.query('RESET ROLE');
    t('un tripulante con anticipada la ve en su cuenta (pendiente, sin pausa)', me && me.current && me.current.base === 'pendiente' && me.paused === false,
      me && me.current ? { ps: me.current.periodStart, base: me.current.base } : me);
  }
  await c.query('ROLLBACK TO SAVEPOINT reloj');
  await q(`SELECT set_config('request.jwt.claims', '', true)`);

  const despues = await huella();
  t('después de deshacer la simulación, todo idéntico a antes', JSON.stringify(antes) === JSON.stringify(despues));

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
