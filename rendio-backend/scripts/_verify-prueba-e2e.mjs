import { createClient } from '@supabase/supabase-js';
const URL=process.env.SUPABASE_URL, ANON=process.env.SUPABASE_ANON_KEY;
const svc = createClient(URL, process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{autoRefreshToken:false,persistSession:false}});
let pass=0, fail=0;
const ok=(n,c,x)=>{c?pass++:fail++; console.log((c?'PASS  ':'FALLA ')+n+(x&&!c?' :: '+x:''));};
const DIA='2026-07-27';

// 1. Login REAL de la profa como auxiliar (con la anon key, como la app)
const app = createClient(URL, ANON, {auth:{autoRefreshToken:false,persistSession:false}});
const { data: sess, error: le } = await app.auth.signInWithPassword({
  email:'auxiliar.prueba@rendio.demo', password:'DemoRendio2026!' });
ok('La profa puede entrar con el usuario de prueba', !le && !!sess?.session, le?.message);

// 2. Su perfil llega como auxiliar (es lo que decide qué pantalla ve)
const { data: prof } = await app.from('profiles').select('id, role, full_name, email').eq('id', sess.user.id).single();
ok('Su rol es auxiliar (verá la app de auxiliar)', prof?.role==='auxiliar', JSON.stringify(prof));

// 3. Puede leer SUS reservas (arranca sin ninguna, a propósito)
const { data: mias, error: me } = await app.from('reservations').select('id').eq('auxiliar_profile_id',
  (await app.from('auxiliar_profiles').select('id').eq('profile_id', sess.user.id).single()).data.id);
ok('Puede consultar sus reservas (RLS ok)', !me, me?.message);
ok('Arranca sin viajes (los crea ella en la prueba)', (mias||[]).length===0, 'tiene '+(mias||[]).length);

// 4. Puede CREAR una reserva (es lo primero que hará)
const { data: apRow } = await app.from('auxiliar_profiles').select('id').eq('profile_id', sess.user.id).single();
const { data: nueva, error: ce } = await app.from('reservations').insert({
  auxiliar_profile_id: apRow.id, direction:'home_to_airport', status_h2a:'requested',
  pickup_address:'Cra 51 #49-06, Centro, Rionegro', pickup_latitude:6.1529, pickup_longitude:-75.3752,
  required_arrival_at:`${DIA}T05:10:00-05:00`, notes:'PRUEBA DE VERIFICACION — se borra', is_overnight:false, is_firm:true,
}).select('id').single();
ok('Puede crear su traslado desde la app (RLS ok)', !ce, ce?.message);
if (nueva) { await svc.from('reservations').delete().eq('id', nueva.id); console.log('       (reserva de verificación borrada)'); }
await app.auth.signOut();

// 5. Lo que verá el ADMIN en Asignación ese día
const { data: reservas } = await svc.from('reservations')
  .select('id, pickup_address, required_arrival_at, auxiliar_profiles(profiles(full_name))')
  .is('cancelled_at', null).gte('required_arrival_at', `${DIA}T00:00:00-05:00`).lte('required_arrival_at', `${DIA}T23:59:59-05:00`);
ok('El admin verá 3 traslados listos para rutear', (reservas||[]).length===3, 'hay '+(reservas||[]).length);
console.log('       →', (reservas||[]).map(r=>r.auxiliar_profiles.profiles.full_name).join(' · '));

// 6. No hay reservas de otros días que ensucien el tablero
const hoy = new Date().toLocaleDateString('en-CA',{timeZone:'America/Bogota'});
const { data: otras } = await svc.from('reservations').select('required_arrival_at')
  .is('cancelled_at', null).gte('required_arrival_at', `${hoy}T00:00:00-05:00`).lt('required_arrival_at', `${DIA}T00:00:00-05:00`);
ok('No hay reservas viejas que se cuelen antes de ese día', (otras||[]).length===0, 'hay '+(otras||[]).length);

// 7. El horario publicado deja asignar a Tester ese día
const { data: sch } = await svc.from('weekly_schedules').select('data, published').eq('week_start_date', DIA).single();
ok('El horario de esa semana está PUBLICADO', sch?.published===true);
const { data: tester } = await svc.from('profiles').select('id, full_name').eq('email','tester@rendio.co').single();
const lunes = sch.data.mon || {};
ok('Tester está en turno AM ese lunes', (lunes.morning||[]).includes(tester.id));
ok('Tester está en turno PM ese lunes', (lunes.afternoon||[]).includes(tester.id));
ok('El horario trae los nombres (los usa el tablero)', !!sch.data._names?.[tester.id]);

// 8. Hay vehículos: sin flota el tablero no deja armar rutas
const { data: veh } = await svc.from('vehicles').select('id, internal_code, status');
ok('Hay vehículos para asignar', (veh||[]).length>0, 'hay '+(veh||[]).length);

// 9. Tester tiene driver_profile (lo exige route_assignments)
const { data: dp } = await svc.from('driver_profiles').select('id').eq('profile_id', tester.id).maybeSingle();
ok('Tester tiene driver_profile (se le puede asignar la ruta)', !!dp);

// 10. Los 4 auxiliares quedaron bien
const { data: cuatro } = await svc.from('profiles').select('full_name, email, role')
  .in('email',['auxiliar.prueba@rendio.demo','prueba.valeria@rendio.demo','prueba.mateo@rendio.demo','prueba.camila@rendio.demo']);
ok('Los 4 auxiliares existen con rol auxiliar', (cuatro||[]).length===4 && cuatro.every(c=>c.role==='auxiliar'), JSON.stringify(cuatro));

console.log(`\n${pass} PASS · ${fail} FALLA`);
process.exit(fail?1:0);
