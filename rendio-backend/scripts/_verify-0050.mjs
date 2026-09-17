import pg from 'pg';
const ref = process.env.SUPABASE_PROJECT_REF;
const c = new pg.Client({ host:'aws-1-us-east-1.pooler.supabase.com', port:5432, user:'postgres.'+ref,
  password:process.env.SUPABASE_DB_PASSWORD, database:'postgres', ssl:{rejectUnauthorized:false} });
await c.connect();
let pass=0, fail=0;
const ok = (n, c2, x) => { c2?pass++:fail++; console.log((c2?'PASS  ':'FALLA ')+n+(x&&!c2?' :: '+x:'')); };
const one = async (sql, params) => (await c.query(sql, params)).rows[0];

// 1. columnas
const cols = (await c.query(`select column_name, data_type, column_default from information_schema.columns
  where table_name='reservations' and column_name in ('is_overnight','is_firm','cancelled_by','cancellation_reason')`)).rows;
ok('reservations: 4 columnas nuevas', cols.length===4, JSON.stringify(cols.map(r=>r.column_name)));
ok('is_firm default true', cols.find(r=>r.column_name==='is_firm')?.column_default?.includes('true'));
const s = (await c.query(`select column_name from information_schema.columns where table_name='app_settings'
  and column_name in ('aux_wait_minutes','aux_min_lead_hours')`)).rows;
ok('app_settings: 2 parametros nuevos', s.length===2, JSON.stringify(s));
const cfg = await one(`select aux_wait_minutes, aux_min_lead_hours from app_settings where id='singleton'`);
ok('valores por defecto 5 min / 6 h', cfg.aux_wait_minutes===5 && cfg.aux_min_lead_hours===6, JSON.stringify(cfg));

// 2. funciones nuevas + grants
const fns = (await c.query(`select p.proname, p.prosecdef from pg_proc p
  where p.proname in ('auxiliar_cancel_reservation','admin_cancel_reservation','auxiliar_confirm_ready')`)).rows;
ok('3 RPCs creadas', fns.length===3, JSON.stringify(fns.map(f=>f.proname)));
ok('las 3 son SECURITY DEFINER', fns.every(f=>f.prosecdef));
const grants = (await c.query(`select routine_name, grantee from information_schema.routine_privileges
  where routine_name in ('auxiliar_cancel_reservation','admin_cancel_reservation','auxiliar_confirm_ready')
  and grantee='authenticated'`)).rows;
ok('grant a authenticated en las 3', grants.length===3, JSON.stringify(grants));
ok('PUBLIC revocado', (await c.query(`select routine_name from information_schema.routine_privileges
  where routine_name in ('auxiliar_cancel_reservation','admin_cancel_reservation','auxiliar_confirm_ready')
  and grantee='PUBLIC'`)).rows.length===0);

// 3. la RPC de tracking devuelve los campos nuevos
const src = await one(`select prosrc from pg_proc where proname='auxiliar_track_reservation'`);
ok('track: devuelve arrived_at', src.prosrc.includes("'arrived_at'"));
ok('track: devuelve wait_minutes', src.prosrc.includes("'wait_minutes'"));
ok('track: informa cancelled', src.prosrc.includes("'cancelled'"));

// 4. comportamiento REAL (en transaccion que se revierte: no toca datos de verdad)
await c.query('BEGIN');
const r = await one(`select r.id, r.direction, r.auxiliar_profile_id, ap.profile_id
  from reservations r join auxiliar_profiles ap on ap.id=r.auxiliar_profile_id
  where r.cancelled_at is null and coalesce(r.status_h2a::text,r.status_a2h::text) not in
  ('on_board','picked_up','en_route_home','delivered','no_show') limit 1`);
if (r) {
  // simula ser ese auxiliar
  await c.query(`select set_config('request.jwt.claims', json_build_object('sub', $1::text)::text, true)`, [r.profile_id]);
  await c.query(`select set_config('role','authenticated',true)`);
  try {
    const res = await one(`select public.auxiliar_cancel_reservation($1,'prueba automatica') as out`, [r.id]);
    ok('cancelacion del auxiliar funciona', res.out && res.out.ok===true, JSON.stringify(res.out));
    const after = await one(`select cancelled_at, cancellation_reason,
      coalesce(status_h2a::text,status_a2h::text) as st from reservations where id='${r.id}'`);
    ok('queda marcada como cancelada', !!after.cancelled_at && after.st==='cancelled', JSON.stringify(after));
    ok('guarda el motivo', after.cancellation_reason==='prueba automatica');
    const stops = await one(`select count(*)::int as n from route_stops rs join route_assignments ra
      on ra.id=rs.route_assignment_id where rs.reservation_id='${r.id}' and ra.status<>'completed'`);
    ok('sale de las rutas activas', stops.n===0, 'quedan '+stops.n);
    // no se puede cancelar dos veces
    let dobleFallo=false;
    try { await c.query(`select public.auxiliar_cancel_reservation('${r.id}',null)`); } catch(e){ dobleFallo=true; }
    ok('no deja cancelar dos veces', dobleFallo);
  } catch (e) { ok('cancelacion del auxiliar funciona', false, e.message); }
} else { console.log('(sin reserva cancelable para la prueba)'); }
await c.query('ROLLBACK');

// 5. confirmar recogida (tambien en transaccion revertida)
await c.query('BEGIN');
const r2 = await one(`select r.id, ap.profile_id from reservations r join auxiliar_profiles ap on ap.id=r.auxiliar_profile_id
  where r.cancelled_at is null and r.direction='home_to_airport' limit 1`);
if (r2) {
  await c.query(`select set_config('request.jwt.claims', json_build_object('sub', $1::text)::text, true)`, [r2.profile_id]);
  try {
    await c.query(`select public.auxiliar_confirm_ready('${r2.id}')`);
    const a = await one(`select ready_confirmed_at, status_h2a::text as st from reservations where id='${r2.id}'`);
    ok('confirmar recogida persiste', !!a.ready_confirmed_at, JSON.stringify(a));
    ok('sube el estado a ready', a.st==='ready', 'estado='+a.st);
  } catch(e){ ok('confirmar recogida persiste', false, e.message); }
}
await c.query('ROLLBACK');

// 6. un auxiliar NO puede cancelar la reserva de otro
await c.query('BEGIN');
const par = await one(`select r1.id as mia, ap2.profile_id as otro from reservations r1
  join auxiliar_profiles ap1 on ap1.id=r1.auxiliar_profile_id
  join auxiliar_profiles ap2 on ap2.id<>ap1.id
  where r1.cancelled_at is null limit 1`);
if (par) {
  await c.query(`select set_config('request.jwt.claims', json_build_object('sub', $1::text)::text, true)`, [par.otro]);
  let bloqueado=false;
  try { await c.query(`select public.auxiliar_cancel_reservation('${par.mia}',null)`); } catch(e){ bloqueado=true; }
  ok('AISLAMIENTO: no puede cancelar la reserva de otro', bloqueado);
}
await c.query('ROLLBACK');

// 7. estado final intacto
const fin = await one(`select count(*)::int as n from reservations where cancelled_at is null`);
ok('los datos de dev quedaron intactos (43 reservas vivas)', fin.n===43, 'ahora hay '+fin.n);
console.log(`\n${pass} PASS · ${fail} FALLA`);
await c.end();
process.exit(fail?1:0);
