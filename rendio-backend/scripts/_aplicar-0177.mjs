// 0177 · Chats de tripulantes con conductores, por turno (Coordinación) + borrado a los 30 días.
//   cd rendio-backend && set -a && source <.env.dev|.env.main> && set +a && node scripts/_aplicar-0177.mjs [--produccion] [--aplicar]
// Sin --aplicar: EN SECO (ROLLBACK). La purga se ENSAYA dentro de un savepoint que siempre se deshace:
// este script no borra ningún mensaje. El borrado de verdad lo hace pg_cron a las 3:40 a. m. de Bogotá.
import pg from 'pg';
import { readFileSync } from 'node:fs';
const DEV = 'lxlphbafhtphulanhzlp', PROD = 'wvuurnfdrrdondrbbkhd';
const prod = process.argv.includes('--produccion'), aplicar = process.argv.includes('--aplicar');
const esperado = prod ? PROD : DEV;
if ((process.env.SUPABASE_PROJECT_REF || '') !== esperado || !(process.env.SUPABASE_URL || '').includes(esperado)) { console.error('ABORT: ambiente equivocado'); process.exit(2); }
const c = new pg.Client({ host: prod ? 'aws-1-us-west-2.pooler.supabase.com' : 'aws-1-us-east-1.pooler.supabase.com', port: 5432, database: 'postgres', user: 'postgres.' + esperado, password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false } });
await c.connect();
const q = async (s, v) => (await c.query(s, v)).rows, one = async (s, v) => (await q(s, v))[0];
const fallas = []; const t = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && d !== '' ? ' → ' + JSON.stringify(d).slice(0, 400) : ''}`); if (!ok) fallas.push(n); };
const sql = readFileSync(new URL('../supabase/migrations/0177_chats_con_conductores.sql', import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const hay = async (n) => !!(await one(`SELECT 1 x FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = $1`, [n]));
const como = async (id) => { await c.query(`SELECT set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true), set_config('request.jwt.claim.role', 'authenticated', true)`, [JSON.stringify({ sub: id, role: 'authenticated' }), id]); };
const dia = (d) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);

console.log(`\n== 0177 ${aplicar ? 'APLICANDO' : 'EN SECO'} en ${prod ? 'PRODUCCIÓN' : 'dev'} ==`);
await c.query('BEGIN');
try {
  await c.query(`SET LOCAL lock_timeout = '5s'`);
  for (const f of ['turno_de', 'current_user_org', 'current_user_role']) t('la base tiene ' + f, await hay(f));
  t('la base tiene pg_cron', !!(await one(`SELECT 1 x FROM pg_extension WHERE extname = 'pg_cron'`)));
  if (fallas.length) throw new Error('la base no está como se esperaba');
  const total = (await one(`SELECT count(*)::int n, count(DISTINCT reservation_id)::int r, min(created_at) desde FROM public.reservation_messages`));
  console.log(`  · hoy hay ${total.n} mensajes en ${total.r} chats de traslado (el más viejo del ${total.desde ? dia(total.desde) : '—'})`);
  const vaAborrar = await one(`SELECT count(*)::int n, count(DISTINCT reservation_id)::int r FROM public.reservation_messages
     WHERE reservation_id IN (SELECT reservation_id FROM public.reservation_messages GROUP BY 1 HAVING max(created_at) < now() - interval '30 days')`);
  console.log(`  · la primera purga (3:40 a. m.) borraría ${vaAborrar.n} mensajes de ${vaAborrar.r} chats con su último mensaje de hace más de 30 días`);

  await c.query(sql);
  for (const f of ['admin_chats_conductores', 'purge_reservation_messages']) t('quedó ' + f, await hay(f));
  t('los días de guardado quedan en 30', (await one(`SELECT reservation_chat_keep_days d FROM public.app_settings WHERE id = 'singleton'`))?.d === 30);
  const job = await one(`SELECT schedule, command FROM cron.job WHERE jobname = 'purge-reservation-chat'`);
  t('la purga quedó programada a las 3:40 a. m. de Bogotá (08:40 UTC)', job && job.schedule === '40 8 * * *' && /purge_reservation_messages/.test(job.command), job);
  t('la purga NO la puede llamar una persona', !(await one(`SELECT has_function_privilege('authenticated', 'public.purge_reservation_messages()', 'EXECUTE') x`)).x);

  await c.query('SAVEPOINT prueba');
  const jefe = await one(`SELECT p.id, p.organization_id org FROM public.profiles p
     WHERE p.role = 'admin' AND p.deleted_at IS NULL AND p.is_active IS DISTINCT FROM false
     ORDER BY (SELECT count(*) FROM public.profiles a WHERE a.organization_id = p.organization_id AND a.role = 'auxiliar') DESC, p.created_at LIMIT 1`);
  if (!jefe) throw new Error('no hay un jefe para probar');
  await como(jefe.id);
  const L = (await one(`SELECT public.admin_chats_conductores(7) j`)).j;
  const esperados = (await one(`SELECT count(*)::int n FROM (SELECT rm.reservation_id FROM public.reservation_messages rm
       JOIN public.reservations r ON r.id = rm.reservation_id JOIN public.auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
       JOIN public.profiles pa ON pa.id = ap.profile_id AND pa.organization_id = $1
       GROUP BY 1 HAVING max(rm.created_at) > now() - interval '7 days') x`, [jefe.org])).n;
  t(`JEFE: la lista de 7 días trae los ${esperados} chats de su organización`, Array.isArray(L) && L.length === Math.min(esperados, 400), Array.isArray(L) ? L.length : L);
  t('JEFE: cada renglón tiene turno, día y tripulante', Array.isArray(L) && L.every((x) => (x.turno === 'am' || x.turno === 'pm') && x.dia && x.tripulante && x.reservation_id), L && L.find((x) => !(x.turno && x.dia && x.tripulante)));
  if (Array.isArray(L) && L.length) {
    const porTurno = {}; L.forEach((x) => { const k = dia(x.dia) + ' ' + x.turno; porTurno[k] = (porTurno[k] || 0) + 1; });
    console.log('  · por turno: ' + Object.entries(porTurno).sort().reverse().map(([k, n]) => `${k}=${n}`).join(' · '));
    console.log(`  · con conductor: ${L.filter((x) => x.conductor).length} de ${L.length}`);
    const conMsjConductor = L.filter((x) => x.del_conductor > 0);
    t('JEFE: si el conductor escribió, el renglón dice qué conductor', conMsjConductor.every((x) => !!x.conductor), conMsjConductor.find((x) => !x.conductor));
  }
  t('JEFE: con 14 días trae lo mismo o más', ((await one(`SELECT public.admin_chats_conductores(14) j`)).j || []).length >= (L || []).length);
  const drv = await one(`SELECT id FROM public.profiles WHERE role = 'driver' AND deleted_at IS NULL LIMIT 1`);
  if (drv) { await como(drv.id); t('CONDUCTOR: no puede pedir la lista', (await one(`SELECT public.admin_chats_conductores(7) j`)).j === null); }
  const aux = await one(`SELECT id FROM public.profiles WHERE role = 'auxiliar' AND deleted_at IS NULL LIMIT 1`);
  if (aux) { await como(aux.id); t('TRIPULANTE: no puede pedir la lista', (await one(`SELECT public.admin_chats_conductores(7) j`)).j === null); }

  // Ensayo de la purga (se deshace).
  await c.query('SAVEPOINT purga');
  const n = (await one(`SELECT public.purge_reservation_messages() n`)).n;
  t(`la purga borraría exactamente lo previsto (${vaAborrar.n} mensajes)`, n === vaAborrar.n, n);
  const partido = await one(`SELECT count(*)::int n FROM (SELECT reservation_id FROM public.reservation_messages GROUP BY 1 HAVING min(created_at) < now() - interval '30 days') x`);
  console.log(`  · después de la purga quedan ${partido.n} chats que empezaron hace más de 30 días pero siguen vivos (no se parten)`);
  await c.query('ROLLBACK TO SAVEPOINT purga');
  t('el ensayo de la purga no borró nada', (await one(`SELECT count(*)::int n FROM public.reservation_messages`)).n === total.n);

  await c.query('ROLLBACK TO SAVEPOINT prueba');
  if (fallas.length) throw new Error('fallaron ' + fallas.length);
  if (aplicar) { await c.query('COMMIT'); console.log('\n✓ 0177 APLICADA en ' + (prod ? 'PRODUCCIÓN' : 'dev')); } else { await c.query('ROLLBACK'); console.log('\nEN SECO: no se guardó nada'); }
} catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('\n✗ NO se aplicó:', e.message); process.exitCode = 1; }
await c.end();
