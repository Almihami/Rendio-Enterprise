import { createClient } from '@supabase/supabase-js';
const svc = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
if (!process.env.SUPABASE_URL.includes('lxlphbafhtphulanhzlp')) { console.error('ABORT: no es dev'); process.exit(2); }
const HOY = new Date().toLocaleDateString('en-CA',{timeZone:'America/Bogota'});
const HORA = process.env.HORA_PRUEBA || '21:00';

console.log('=== Prueba 2: dos recogidas (El Porvenir + Jardines de Llanogrande) ===\n');

// 1) BORRAR lo de la prueba anterior. Primero las rutas (route_stops referencia
//    reservations con ON DELETE RESTRICT), después las reservas.
const CORREOS = ['auxiliar.prueba@rendio.demo','prueba.valeria@rendio.demo','prueba.mateo@rendio.demo','prueba.camila@rendio.demo'];
const { data: perfiles } = await svc.from('profiles').select('id, full_name, email').in('email', CORREOS);
const { data: aps } = await svc.from('auxiliar_profiles').select('id, profile_id').in('profile_id', perfiles.map(p=>p.id));
const apPorEmail = {}; perfiles.forEach(p => { apPorEmail[p.email] = aps.find(a=>a.profile_id===p.id); });

const { data: viejas } = await svc.from('reservations').select('id').in('auxiliar_profile_id', aps.map(a=>a.id));
const ids = (viejas||[]).map(r=>r.id);
if (ids.length) {
  const { data: stops } = await svc.from('route_stops').select('route_assignment_id').in('reservation_id', ids);
  const ras = [...new Set((stops||[]).map(s=>s.route_assignment_id))];
  if (ras.length) {
    await svc.from('route_stops').delete().in('route_assignment_id', ras);
    await svc.from('route_assignments').delete().in('id', ras);
    console.log(`  − ${ras.length} ruta(s) publicada(s) de la prueba anterior, borradas`);
  }
  await svc.from('reservations').delete().in('id', ids);
  console.log(`  − ${ids.length} reserva(s) de prueba, borradas`);
} else console.log('  (no había reservas previas)');

// 2) Valeria se muda a Jardines de Llanogrande (la otra recogida).
//    Coords de Llanogrande verificadas con Nominatim (6.1265, -75.4175).
const LLANO = { dir:'Jardines de Llanogrande, vía Llanogrande, Rionegro', lat:6.1265, lng:-75.4175 };
const PORVENIR = { dir:'Calle 47 #59-33, B. El Porvenir, Rionegro', lat:6.1468, lng:-75.3849 };
await svc.from('auxiliar_profiles')
  .update({ home_address:LLANO.dir, home_latitude:LLANO.lat, home_longitude:LLANO.lng })
  .eq('id', apPorEmail['prueba.valeria@rendio.demo'].id);
console.log(`\n  ✓ Valeria Ochoa ahora vive en ${LLANO.dir}`);

// 3) Las DOS recogidas del día, mismo vuelo para que caigan en el mismo carro.
const nueva = async (email, sitio, nombre) => {
  const { error } = await svc.from('reservations').insert({
    auxiliar_profile_id: apPorEmail[email].id, flight_id:null, direction:'home_to_airport',
    status_h2a:'requested', status_a2h:null,
    pickup_address: sitio.dir, pickup_latitude: sitio.lat, pickup_longitude: sitio.lng,
    required_arrival_at: `${HOY}T${HORA}:00-05:00`,
    notes:'Vuelo AV-9412. Prueba 2 — dos recogidas.', is_overnight:false, is_firm:true,
  });
  if (error) throw new Error(`${email}: ${error.message}`);
  console.log(`  + ${nombre.padEnd(15)} ${HORA} · ${sitio.dir}`);
};
console.log('\nRecogidas de hoy:');
await nueva('auxiliar.prueba@rendio.demo', PORVENIR, 'Auxiliar Prueba');
await nueva('prueba.valeria@rendio.demo',  LLANO,    'Valeria Ochoa');

// 4) Distancias, para saber qué esperar en el mapa
const d=(a,b)=>{const R=6371,r=Math.PI/180,dLa=(b[0]-a[0])*r,dLo=(b[1]-a[1])*r;
  const s=Math.sin(dLa/2)**2+Math.cos(a[0]*r)*Math.cos(b[0]*r)*Math.sin(dLo/2)**2;return 2*R*Math.asin(Math.sqrt(s));};
const MDE=[6.1715,-75.4270];
console.log('\nEn línea recta:');
console.log(`  El Porvenir → Llanogrande: ${d([PORVENIR.lat,PORVENIR.lng],[LLANO.lat,LLANO.lng]).toFixed(1)} km`);
console.log(`  Llanogrande → MDE:         ${d([LLANO.lat,LLANO.lng],MDE).toFixed(1)} km`);
console.log(`\nDía: ${HOY} · presentación ${HORA} · recogida estimada ~${String(Number(HORA.slice(0,2))-1).padStart(2,'0')}:${HORA.slice(3)}`);
