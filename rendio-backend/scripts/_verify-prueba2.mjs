import { createClient } from '@supabase/supabase-js';
const svc = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
let pass=0,fail=0; const ok=(n,c,x)=>{c?pass++:fail++;console.log((c?'PASS  ':'FALLA ')+n+(x&&!c?' :: '+x:''));};
const HOY=new Date().toLocaleDateString('en-CA',{timeZone:'America/Bogota'});
const bog=i=>new Date(i).toLocaleDateString('en-CA',{timeZone:'America/Bogota'});

const floor=new Date(Date.now()-12*3600*1000).toISOString();
const { data: rows } = await svc.from('reservations')
  .select('id, required_arrival_at, pickup_address, pickup_latitude, pickup_longitude, auxiliar_profiles(profiles(full_name))')
  .is('cancelled_at',null).gte('required_arrival_at',floor).order('required_arrival_at');
const up=rows.filter(r=>bog(r.required_arrival_at)>=HOY);
ok('Quedaron exactamente 2 recogidas', up.length===2, 'hay '+up.length);
ok('Las 2 son de HOY', up.every(r=>bog(r.required_arrival_at)===HOY));
up.forEach(r=>console.log(`       → ${r.auxiliar_profiles.profiles.full_name}: ${r.pickup_address}`));
ok('Una en El Porvenir', up.some(r=>/Porvenir/i.test(r.pickup_address)));
ok('Otra en Jardines de Llanogrande', up.some(r=>/Llanogrande/i.test(r.pickup_address)));
ok('Las 2 tienen coordenadas', up.every(r=>r.pickup_latitude!=null && r.pickup_longitude!=null));

// No quedaron rutas viejas colgadas
// Lo que importa no es que no haya NINGUNA ruta, sino que no haya de hoy en
// adelante: tanto Operación como la ruta del conductor filtran por día >= hoy.
const { data: ra } = await svc.from('route_assignments').select('id, status, planned_start_at')
  .in('status',['planned','in_progress']);
const futuras = (ra||[]).filter(r => r.planned_start_at && bog(r.planned_start_at) >= HOY);
ok('No hay rutas de hoy/futuras colgadas (empieza en limpio)', futuras.length===0, 'quedan '+futuras.length);
console.log(`       (hay ${(ra||[]).length} rutas viejas del 17-jul, todas pasadas: no se ven en ninguna pantalla)`);

// Tester sigue disponible hoy
const DIAS=['mon','tue','wed','thu','fri','sat','sun'];
const lunes=(()=>{const d=new Date(HOY+'T12:00:00-05:00');const wd=d.getDay();d.setDate(d.getDate()-wd+(wd===0?-6:1));return d.toLocaleDateString('en-CA');})();
const { data: sch } = await svc.from('weekly_schedules').select('data, published').eq('week_start_date',lunes).single();
const { data: t } = await svc.from('profiles').select('id').eq('email','tester@rendio.co').single();
const cel=sch.data[DIAS[(new Date(HOY+'T12:00:00-05:00').getDay()+6)%7]];
ok('Tester sigue en turno hoy (AM y PM)', (cel.morning||[]).includes(t.id) && (cel.afternoon||[]).includes(t.id));

// La ruta por carretera de verdad existe (lo que verá el auxiliar en su mapa)
const P=up.find(r=>/Porvenir/i.test(r.pickup_address)), L=up.find(r=>/Llanogrande/i.test(r.pickup_address));
const url=`https://router.project-osrm.org/route/v1/driving/${P.pickup_longitude},${P.pickup_latitude};${L.pickup_longitude},${L.pickup_latitude};-75.4270,6.1715?overview=full&geometries=geojson`;
const j = await (await fetch(url)).json();
const r0 = j.routes && j.routes[0];
ok('OSRM devuelve la ruta real de las 2 paradas al aeropuerto', !!r0 && r0.geometry.coordinates.length>20,
   r0?('puntos: '+r0.geometry.coordinates.length):'sin ruta');
if (r0) console.log(`       → ${(r0.distance/1000).toFixed(1)} km por carretera · ${Math.round(r0.duration/60)} min · ${r0.geometry.coordinates.length} vértices`);
console.log(`\n${pass} PASS · ${fail} FALLA`);
process.exit(fail?1:0);
