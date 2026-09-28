// PRUEBA EN SECO de 0081 (usuarios) contra dev: aplica la migración dentro de
// UNA transacción, se hace pasar por conductor / jefe / tripulante reales de dev
// (SET ROLE authenticated + claims del JWT, igual que PostgREST) y al final hace
// ROLLBACK. No deja rastro: ni la migración, ni contraseñas, ni correos.
//   cd rendio-backend/scripts && set -a; source ../.env.dev; set +a; node _seco-0081-usuarios.mjs
import pg from 'pg'; import { readFileSync } from 'fs';
const DEV_REF = 'lxlphbafhtphulanhzlp';
const ref = process.env.SUPABASE_PROJECT_REF || '', url = process.env.SUPABASE_URL || '';
if (!url.includes(DEV_REF) || ref !== DEV_REF) { console.error('ABORT: no es dev'); process.exit(2); }
const mig = readFileSync(new URL('../supabase/migrations/0081_usuarios_admin.sql', import.meta.url), 'utf8')
  .replace(/^\s*BEGIN\s*;\s*$/mi, '').replace(/^\s*COMMIT\s*;\s*$/mi, '');
const c = new pg.Client({ host: 'aws-1-us-east-1.pooler.supabase.com', port: 5432, user: 'postgres.' + ref, password: process.env.SUPABASE_DB_PASSWORD, database: 'postgres', ssl: { rejectUnauthorized: false } });
await c.connect();

let pass = 0, fail = 0;
const ok = (cond, m) => { console.log(`  ${cond ? '✓' : '✗'} ${m}`); cond ? pass++ : fail++; };
const one = async (sql, p) => (await c.query(sql, p)).rows[0];

// Corre `sql` como el usuario `uid` (con su sesión) y dice si pasó o qué error dio.
async function como(uid, sql, params) {
  await c.query('savepoint s');
  try {
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
    await c.query('set local role authenticated');
    const r = await c.query(sql, params);
    await c.query('reset role');
    await c.query('release savepoint s');
    return { ok: true, rows: r.rows };
  } catch (e) {
    await c.query('rollback to savepoint s');
    await c.query('reset role');
    return { ok: false, err: e.message };
  }
}
const debePasar = async (m, uid, sql, p) => { const r = await como(uid, sql, p); ok(r.ok, `${m}${r.ok ? '' : ' → ' + r.err}`); return r; };
const debeFallar = async (m, uid, sql, p) => { const r = await como(uid, sql, p); ok(!r.ok, `${m} → ${r.ok ? 'PASÓ (no debía)' : r.err}`); return r; };

try {
  await c.query('begin');
  await c.query(mig);
  console.log('✓ la migración corre sin errores\n');

  const A = await one(`select p.id, p.full_name from profiles p join auth.users u on u.id = p.id
                        where p.role = 'admin' and p.deleted_at is null and p.is_active is not false order by p.created_at limit 1`);
  const A2 = await one(`select p.id from profiles p where p.role = 'admin' and p.deleted_at is null and p.id <> $1 limit 1`, [A.id]);
  const D = await one(`select p.id, p.full_name, p.email from profiles p join auth.users u on u.id = p.id
                        join driver_profiles dp on dp.profile_id = p.id
                        where p.role = 'driver' and p.deleted_at is null and p.is_active is not false order by p.created_at limit 1`);
  const X = await one(`select p.id, ap.id as ap_id from profiles p join auxiliar_profiles ap on ap.profile_id = p.id
                        where p.role = 'auxiliar' and p.deleted_at is null
                          and exists (select 1 from reservations r where r.auxiliar_profile_id = ap.id) limit 1`);
  console.log(`Jefe ${A.full_name} · conductor ${D.full_name} · tripulante ${X ? 'con reservas' : 'NINGUNO con reservas'}\n`);

  console.log('── Lo que cada quien puede tocar de su propio perfil ──');
  await debeFallar('conductor se pone rol admin', D.id, `update profiles set role = 'admin' where id = $1`, [D.id]);
  await debeFallar('conductor se cambia su propio estado', D.id, `update profiles set is_active = not is_active where id = $1`, [D.id]);
  await debeFallar('conductor se cambia el nombre', D.id, `update profiles set full_name = 'Otro Nombre Cualquiera' where id = $1`, [D.id]);
  await debePasar('conductor cambia su teléfono', D.id, `update profiles set phone = '3001234567' where id = $1`, [D.id]);
  await debePasar('conductor cambia su foto', D.id, `update profiles set avatar_url = 'https://x/y.jpg' where id = $1`, [D.id]);
  if (X) await debeFallar('tripulante se pone rol admin', X.id, `update profiles set role = 'admin' where id = $1`, [X.id]);
  await debePasar('jefe suspende a un conductor como hoy (front viejo)', A.id, `update profiles set is_active = false where id = $1`, [D.id]);
  await debePasar('jefe lo reactiva como hoy (front viejo)', A.id, `update profiles set is_active = true where id = $1`, [D.id]);
  await debePasar('jefe cambia prioridad/líder como hoy', A.id, `update profiles set can_coordinate = can_coordinate where id = $1`, [D.id]);
  await debeFallar('jefe cambia un rol directo (sin la función)', A.id, `update profiles set role = 'admin' where id = $1`, [D.id]);
  await debeFallar('jefe se suspende a sí mismo', A.id, `update profiles set is_active = false where id = $1`, [A.id]);

  console.log('\n── Funciones del jefe ──');
  await debePasar('editar datos del conductor', A.id,
    `select admin_update_profile($1, $2::jsonb)`, [D.id, JSON.stringify({ full_name: 'Prueba Seca Uno', phone: '300 123 4567', license_number: 'LIC-1', eps_expires_at: '2027-01-31' })]);
  const d1 = await one(`select p.full_name, p.phone, dp.license_number, dp.eps_expires_at::text from profiles p join driver_profiles dp on dp.profile_id = p.id where p.id = $1`, [D.id]);
  ok(d1.full_name === 'Prueba Seca Uno' && d1.phone === '3001234567' && d1.license_number === 'LIC-1' && d1.eps_expires_at === '2027-01-31', `quedó guardado: ${JSON.stringify(d1)}`);
  await debeFallar('editar un campo no permitido', A.id, `select admin_update_profile($1, '{"role":"admin"}'::jsonb)`, [D.id]);
  await debeFallar('un conductor usa la función del jefe', D.id, `select admin_update_profile($1, '{"full_name":"Hackeo Del Sistema"}'::jsonb)`, [D.id]);

  await debePasar('cambiar el correo', A.id, `select admin_set_email($1, 'prueba.seca.0081@rendio.invalid')`, [D.id]);
  const e1 = await one(`select u.email as auth_email, p.email as perfil, (select identity_data->>'email' from auth.identities i where i.user_id = u.id and provider = 'email' limit 1) as ident
                          from auth.users u join profiles p on p.id = u.id where u.id = $1`, [D.id]);
  ok(e1.auth_email === 'prueba.seca.0081@rendio.invalid' && e1.perfil === e1.auth_email, `correo en auth, identidad y perfil: ${JSON.stringify(e1)}`);
  await debeFallar('poner un correo que usa otra cuenta viva', A.id, `select admin_set_email($1, (select email from profiles where id = $2))`, [D.id, A.id]);

  await debeFallar('contraseña corta', A.id, `select admin_set_password($1, 'abc123', true)`, [D.id]);
  await debeFallar('contraseña sin números', A.id, `select admin_set_password($1, 'soloLetrasLargas', true)`, [D.id]);
  await debePasar('poner contraseña temporal', A.id, `select admin_set_password($1, 'Temporal2026x', true)`, [D.id]);
  const p1 = await one(`select (u.encrypted_password = extensions.crypt('Temporal2026x', u.encrypted_password)) as coincide, p.must_change_password as debe
                          from auth.users u join profiles p on p.id = u.id where u.id = $1`, [D.id]);
  ok(p1.coincide && p1.debe, `la contraseña entra y queda marcada como temporal: ${JSON.stringify(p1)}`);
  await debeFallar('jefe se resetea su propia contraseña por aquí', A.id, `select admin_set_password($1, 'Temporal2026x', true)`, [A.id]);

  console.log('\n── Cambiar mi contraseña ──');
  await debeFallar('con la actual equivocada', D.id, `select change_my_password('NoEsLaMia123', 'NuevaClave2026')`);
  await debePasar('con la actual correcta', D.id, `select change_my_password('Temporal2026x', 'NuevaClave2026')`);
  const p2 = await one(`select (u.encrypted_password = extensions.crypt('NuevaClave2026', u.encrypted_password)) as coincide, p.must_change_password as debe
                          from auth.users u join profiles p on p.id = u.id where u.id = $1`, [D.id]);
  ok(p2.coincide && !p2.debe, `la nueva entra y ya no es temporal: ${JSON.stringify(p2)}`);

  console.log('\n── Suspender / eliminar / restaurar ──');
  await debePasar('suspender con motivo', A.id, `select admin_set_status($1, 'suspended', 'Prueba en seco')`, [D.id]);
  const s1 = await one(`select p.is_active, p.suspended_reason, u.banned_until from profiles p join auth.users u on u.id = p.id where p.id = $1`, [D.id]);
  ok(s1.is_active === false && s1.suspended_reason === 'Prueba en seco' && !s1.banned_until, `suspendido entra pero no opera: ${JSON.stringify(s1)}`);
  const turno = await como(D.id, `insert into shifts (organization_id, driver_id, vehicle_id)
                                  select p.organization_id, dp.id, (select id from vehicles limit 1) from profiles p join driver_profiles dp on dp.profile_id = p.id where p.id = $1`, [D.id]);
  ok(!turno.ok && /suspendida/.test(turno.err), `suspendido no arranca turno → ${turno.ok ? 'PASÓ' : turno.err}`);
  await debePasar('eliminar', A.id, `select admin_set_status($1, 'deleted', null)`, [D.id]);
  const s2 = await one(`select p.deleted_at is not null as borrado, u.banned_until > now() + interval '50 years' as bloqueado,
                               (select count(*) from auth.sessions s where s.user_id = u.id)::int as sesiones
                          from profiles p join auth.users u on u.id = p.id where p.id = $1`, [D.id]);
  ok(s2.borrado && s2.bloqueado && s2.sesiones === 0, `eliminado no entra y sin sesiones: ${JSON.stringify(s2)}`);
  await debePasar('restaurar', A.id, `select admin_set_status($1, 'active', null)`, [D.id]);
  const s3 = await one(`select p.is_active, p.deleted_at, u.banned_until from profiles p join auth.users u on u.id = p.id where p.id = $1`, [D.id]);
  ok(s3.is_active && !s3.deleted_at && !s3.banned_until, `restaurado: ${JSON.stringify(s3)}`);
  await debeFallar('jefe cambia su propio estado', A.id, `select admin_set_status($1, 'deleted', null)`, [A.id]);
  await debeFallar('suspender a un jefe', A.id, `select admin_set_status($1, 'suspended', null)`, [A2 ? A2.id : A.id]);
  if (X) {
    await debeFallar('eliminar a un tripulante', A.id, `select admin_set_status($1, 'deleted', null)`, [X.id]);
    await debePasar('suspender a un tripulante', A.id, `select admin_set_status($1, 'suspended', 'Pago pendiente')`, [X.id]);
    const res = await como(X.id, `insert into reservations select (jsonb_populate_record(null::reservations, to_jsonb(r) || jsonb_build_object('id', gen_random_uuid()))).*
                                    from reservations r where r.auxiliar_profile_id = $1 limit 1`, [X.ap_id]);
    ok(!res.ok && /suspendida/.test(res.err), `tripulante suspendido no pide traslado → ${res.ok ? 'PASÓ' : res.err}`);
  }

  console.log('\n── Rol ──');
  await debePasar('promover conductor a jefe', A.id, `select admin_set_role($1, 'admin')`, [D.id]);
  ok((await one(`select role::text from profiles where id = $1`, [D.id])).role === 'admin', 'ahora es admin');
  await debePasar('devolverlo a conductor', A.id, `select admin_set_role($1, 'driver')`, [D.id]);
  if (X) await debeFallar('cambiarle el rol a un tripulante', A.id, `select admin_set_role($1, 'admin')`, [X.id]);

  console.log('\n── Arreglos de la revisión ──');
  // Un jefe no cambia directo el estado de OTRO jefe (solo por admin_set_status).
  if (A2) await debeFallar('jefe desactiva a otro jefe directo', A.id, `update profiles set is_active = false where id = $1`, [A2.id]);
  // Borrado duro de perfiles: ya no hay política que lo permita (0 filas).
  const del = await como(A.id, `delete from profiles where id = $1 returning id`, [D.id]);
  ok(del.ok && del.rows.length === 0, `jefe no puede borrar filas de perfiles → ${del.ok ? del.rows.length + ' filas' : del.err}`);
  // Jefe inactivo o eliminado: sin rol al instante.
  if (A2) {
    await c.query(`update profiles set is_active = false where id = $1`, [A2.id]);
    const r = await como(A2.id, `select current_user_role() as r`);
    ok(r.ok && r.rows[0].r === null, `jefe inactivo ya no es jefe → rol ${r.ok ? r.rows[0].r : r.err}`);
    await debeFallar('jefe inactivo usa una función de jefe', A2.id, `select admin_update_profile($1, '{"phone":"3000000000"}'::jsonb)`, [D.id]);
    await c.query(`update profiles set is_active = true where id = $1`, [A2.id]);
  }
  const rD = await como(D.id, `select current_user_role() as r`);
  // Conductor suspendido conserva su rol (entra y ve sus cosas).
  await debePasar('suspender otra vez al conductor', A.id, `select admin_set_status($1, 'suspended', 'prueba')`, [D.id]);
  const rS = await como(D.id, `select current_user_role() as r`);
  ok(rS.ok && rS.rows[0].r === 'driver', `conductor suspendido conserva rol driver → ${rS.ok ? rS.rows[0].r : rS.err}`);
  await debeFallar('promover a jefe a un suspendido', A.id, `select admin_set_role($1, 'admin')`, [D.id]);
  // Suspendido con el carro ya reservado (borrador): no lo arranca.
  const dp = await one(`select dp.id from driver_profiles dp where dp.profile_id = $1`, [D.id]);
  const veh = await one(`select id from vehicles limit 1`);
  await c.query(`alter table shifts disable trigger user`);
  const sh = await one(`insert into shifts (organization_id, driver_id, vehicle_id, status) select organization_id, $1, $2, 'vehicle_selected' from profiles where id = $3 returning id`, [dp.id, veh.id, D.id]);
  await c.query(`alter table shifts enable trigger user`);
  await debeFallar('suspendido arranca el turno que ya tenía reservado', D.id, `update shifts set status = 'active' where id = $1`, [sh.id]);
  await debePasar('reactivar al conductor', A.id, `select admin_set_status($1, 'active', null)`, [D.id]);
  ok(rD.ok && rD.rows[0].r === 'driver', 'conductor activo: rol driver');

  const aud = await one(`select count(*)::int as n from audit_events where actor_profile_id = $1 and created_at > now() - interval '5 minutes'`, [A.id]);
  ok(aud.n >= 8, `bitácora: ${aud.n} eventos del jefe`);
} catch (e) {
  console.error('✗ ERROR:', e.message); fail++;
} finally {
  await c.query('rollback').catch(() => {});
  await c.end();
  console.log(`\n${pass} ✓ · ${fail} ✗ — ROLLBACK: en dev no quedó nada`);
  process.exit(fail ? 1 : 0);
}
