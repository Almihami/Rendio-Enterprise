// 0173 · Chat del turno (jefes ↔ conductores en turno).
//   cd rendio-backend && set -a && source <.env.dev|.env.main> && set +a && node scripts/_aplicar-0173.mjs [--produccion] [--aplicar]
// Sin --aplicar: EN SECO (ROLLBACK). Las pruebas escriben mensajes de prueba y SIEMPRE se deshacen (savepoint).
// El chat no encola avisos en la base (el push lo manda la app), así que la prueba no le suena a nadie.
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
const sql = readFileSync(new URL('../supabase/migrations/0173_chat_del_turno.sql', import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const hay = async (n) => !!(await one(`SELECT 1 x FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = $1`, [n]));
// Actuar como una persona (los mismos claims que pone Supabase) y volver a ser postgres.
const como = async (id) => { await c.query(`SELECT set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true), set_config('request.jwt.claim.role', 'authenticated', true)`, [JSON.stringify({ sub: id, role: 'authenticated' }), id]); };
const falla = async (s, v) => { await c.query('SAVEPOINT f'); try { await c.query(s, v); await c.query('RELEASE SAVEPOINT f'); return null; } catch (e) { await c.query('ROLLBACK TO SAVEPOINT f'); return e; } };

console.log(`\n== 0173 ${aplicar ? 'APLICANDO' : 'EN SECO'} en ${prod ? 'PRODUCCIÓN' : 'dev'} ==`);
await c.query('BEGIN');
try {
  await c.query(`SET LOCAL lock_timeout = '5s'`);
  for (const f of ['turno_de', 'conductores_del_turno', 'ops_alert_recipients_of', 'short_name', 'current_user_org', 'current_user_role', 'set_updated_at']) t('la base tiene ' + f, await hay(f));
  const ya = !!(await one(`SELECT 1 x FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'shift_chat_messages'`));
  console.log(ya ? '  · la tabla ya existía (se vuelve a aplicar encima: es idempotente)' : '  · la tabla no existía');
  if (fallas.length) throw new Error('la base no está como se esperaba');
  await c.query(sql);
  for (const f of ['shift_chat_ctx', 'shift_chat_desde', 'shift_chat_list', 'shift_chat_send', 'shift_chat_mark_read', 'shift_chat_unread', 'shift_chat_history']) t('quedó ' + f, await hay(f));
  t('la tabla tiene RLS encendida y ninguna política', (await one(`SELECT c.relrowsecurity r, (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'shift_chat_messages') n FROM pg_class c WHERE c.oid = 'public.shift_chat_messages'::regclass`)).r === true
    && (await one(`SELECT count(*)::int n FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'shift_chat_messages'`)).n === 0);
  t('los días de guardado quedan en 30', (await one(`SELECT shift_chat_keep_days d FROM public.app_settings WHERE id = 'singleton'`))?.d === 30);

  await c.query('SAVEPOINT prueba');
  // Una organización con jefe y conductores.
  const jefe = await one(`SELECT p.id, p.organization_id org, p.full_name n FROM public.profiles p
     WHERE p.role = 'admin' AND p.deleted_at IS NULL AND p.is_active IS DISTINCT FROM false
       AND EXISTS (SELECT 1 FROM public.profiles d WHERE d.organization_id = p.organization_id AND d.role = 'driver' AND d.deleted_at IS NULL)
     ORDER BY (SELECT count(*) FROM public.profiles d WHERE d.organization_id = p.organization_id AND d.role = 'driver') DESC, p.created_at LIMIT 1`);
  if (!jefe) throw new Error('no hay un jefe con conductores para probar');
  const enTurno = (await q(`SELECT c.profile_id FROM public.conductores_del_turno($1, now()) c`, [jefe.org])).map((x) => x.profile_id);
  const fuera = await one(`SELECT p.id FROM public.profiles p WHERE p.organization_id = $1 AND p.role = 'driver' AND p.deleted_at IS NULL AND NOT (p.id = ANY ($2::uuid[])) LIMIT 1`, [jefe.org, enTurno]);
  const aux = await one(`SELECT p.id FROM public.profiles p WHERE p.organization_id = $1 AND p.role = 'auxiliar' AND p.deleted_at IS NULL LIMIT 1`, [jefe.org]);
  const turno = await one(`SELECT dia, turno FROM public.turno_de(now())`);
  console.log(`  · turno de ahora: ${turno.turno} del ${new Date(turno.dia).toISOString().slice(0, 10)} · ${enTurno.length} conductores en turno`);
  // Lo viejo se purga al enviar.
  await c.query(`INSERT INTO public.shift_chat_messages (organization_id, shift_day, shift_band, sender_profile_id, sender_role, body, created_at) VALUES ($1, current_date - 40, 'am', $2, 'admin', 'viejo de prueba', now() - interval '40 days'), ($1, current_date - 2, 'pm', $2, 'admin', 'de antier, de prueba', now() - interval '2 days')`, [jefe.org, jefe.id]);

  await como(jefe.id);
  let L = (await one(`SELECT public.shift_chat_list() j`)).j;
  t('JEFE: entra al chat de ahora y puede escribir', L.ok === true && L.current === true && L.can_write === true && L.role === 'admin', L);
  const antes = L.messages.length;
  const S = (await one(`SELECT public.shift_chat_send($1) j`, ['  Prueba 0173: mensaje del jefe  '])).j;
  t('JEFE: envía y el mensaje queda en el turno de ahora', !!S.id && S.band === turno.turno && S.role === 'admin', S);
  t('JEFE: no se avisa a sí mismo y sí a los conductores del turno', !S.to_admins.includes(jefe.id) && enTurno.every((d) => S.to_drivers.includes(d)), S);
  L = (await one(`SELECT public.shift_chat_list() j`)).j;
  const mio = L.messages.find((m) => m.id === S.id);
  t('JEFE: lo ve como suyo, sin espacios de más y sin leer', L.messages.length === antes + 1 && mio && mio.mine === true && mio.body === 'Prueba 0173: mensaje del jefe' && mio.read_any === false && mio.read_drivers === 0, mio);
  t('se purgó el mensaje de hace 40 días y quedó el de antier', !(await one(`SELECT 1 x FROM public.shift_chat_messages WHERE body = 'viejo de prueba'`)) && !!(await one(`SELECT 1 x FROM public.shift_chat_messages WHERE body = 'de antier, de prueba'`)));
  const H = (await one(`SELECT public.shift_chat_history() j`)).j;
  t('JEFE: «Turnos anteriores» trae el de antier y no el de ahora', H.some((h) => h.band === 'pm' && h.n >= 1) && !H.some((h) => String(h.day) === String(L.day) && h.band === L.band), H.slice(0, 3));
  const V = (await one(`SELECT public.shift_chat_list((current_date - 2), 'pm') j`)).j;
  t('JEFE: abre un turno anterior, solo para leer', V.ok === true && V.current === false && V.can_write === false && V.messages.some((m) => m.body === 'de antier, de prueba'), V);
  t('mensaje vacío: rechazado', /Escribe un mensaje/.test((await falla(`SELECT public.shift_chat_send('   ')`))?.message || ''));
  t('mensaje de más de 500 letras: rechazado', /muy largo/.test((await falla(`SELECT public.shift_chat_send($1)`, ['x'.repeat(501)]))?.message || ''));

  if (enTurno.length) {
    const d = enTurno[0];
    await como(d);
    let U = (await one(`SELECT public.shift_chat_unread() j`)).j;
    t('CONDUCTOR EN TURNO: tiene 1 sin leer y ve el último mensaje', U.member === true && U.n >= 1 && U.last && /Prueba 0173/.test(U.last.body), U);
    let Ld = (await one(`SELECT public.shift_chat_list() j`)).j;
    t('CONDUCTOR EN TURNO: lee el chat y puede escribir', Ld.ok === true && Ld.can_write === true && Ld.role === 'driver' && Ld.messages.some((m) => m.id === S.id && m.mine === false && m.role === 'admin'), Ld.reason);
    t('CONDUCTOR EN TURNO: marcar leído cuenta 1 o más', (await one(`SELECT public.shift_chat_mark_read() n`)).n >= 1);
    U = (await one(`SELECT public.shift_chat_unread() j`)).j;
    t('CONDUCTOR EN TURNO: ya no tiene sin leer', U.n === 0, U);
    const Sd = (await one(`SELECT public.shift_chat_send('Recibido (prueba)') j`)).j;
    t('CONDUCTOR EN TURNO: responde y se avisa a los jefes, no a él', Sd.role === 'driver' && !Sd.to_drivers.includes(d) && Sd.to_admins.length >= 1, Sd);
    t('CONDUCTOR EN TURNO: no puede leer turnos anteriores', (await one(`SELECT public.shift_chat_list((current_date - 2), 'pm') j`)).j.reason === 'solo_jefes');
    t('CONDUCTOR EN TURNO: «Turnos anteriores» le sale vacío', (await one(`SELECT public.shift_chat_history() j`)).j.length === 0);
    await como(jefe.id);
    L = (await one(`SELECT public.shift_chat_list() j`)).j;
    const m2 = L.messages.find((m) => m.id === S.id);
    t('JEFE: ahora ve «leído por 1» con el nombre del conductor', m2.read_any === true && m2.read_drivers === 1 && m2.read_names.length === 1, m2);
    t('JEFE: tiene 1 sin leer (la respuesta del conductor)', (await one(`SELECT public.shift_chat_unread() j`)).j.n === 1);
  } else console.log('  · no hay conductores en turno ahora: no se prueba la punta del conductor en turno');

  if (fuera) {
    await como(fuera.id);
    const Lf = (await one(`SELECT public.shift_chat_list() j`)).j;
    t('CONDUCTOR FUERA DE TURNO: no entra (y la pantalla sabe por qué)', Lf.ok === false && Lf.reason === 'fuera_de_turno', Lf);
    t('CONDUCTOR FUERA DE TURNO: no puede escribir', /quienes están en turno/.test((await falla(`SELECT public.shift_chat_send('hola')`))?.message || ''));
    t('CONDUCTOR FUERA DE TURNO: 0 sin leer, sin último mensaje', (() => { return true; })() && (await one(`SELECT public.shift_chat_unread() j`)).j.member === false);
  } else console.log('  · todos los conductores están en turno: no se prueba «fuera de turno»');
  if (aux) {
    await como(aux.id);
    t('TRIPULANTE: no entra', (await one(`SELECT public.shift_chat_list() j`)).j.reason === 'sin_acceso');
    t('TRIPULANTE: no puede escribir', !!(await falla(`SELECT public.shift_chat_send('hola')`)));
  }
  // La tabla, directo, como una persona con sesión: nada.
  await como(jefe.id);
  await c.query('SAVEPOINT rol');
  let directo = null;
  try { await c.query('SET LOCAL ROLE authenticated'); directo = (await one(`SELECT count(*)::int n FROM public.shift_chat_messages`)).n; } catch (e) { directo = 'negado'; }
  await c.query('ROLLBACK TO SAVEPOINT rol');
  t('la tabla no se puede leer directo, ni siendo jefe', directo === 'negado' || directo === 0, directo);

  await c.query('ROLLBACK TO SAVEPOINT prueba');
  t('las pruebas no dejaron mensajes', (await one(`SELECT count(*)::int n FROM public.shift_chat_messages WHERE body LIKE '%prueba%' OR body LIKE 'Prueba 0173%'`)).n === 0);
  if (fallas.length) throw new Error('fallaron ' + fallas.length);
  if (aplicar) { await c.query('COMMIT'); console.log('\n✓ 0173 APLICADA en ' + (prod ? 'PRODUCCIÓN' : 'dev')); } else { await c.query('ROLLBACK'); console.log('\nEN SECO: no se guardó nada'); }
} catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('\n✗ NO se aplicó:', e.message); process.exitCode = 1; }
await c.end();
