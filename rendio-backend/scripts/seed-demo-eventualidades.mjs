// Escenario para MOSTRARLE A LOS JEFES lo que quedó hecho (bloques C y D).
//
// Siembra en DEV, en un solo paso, el momento exacto que hay que enseñar:
//   · Un plan del día YA PUBLICADO: 2 carros, 4 tripulantes, con conductor.
//   · Una reserva que llega DESPUÉS de que el plan salió → la base la detecta
//     sola y abre la eventualidad "Reserva tardía".
//
// Con eso se pueden demostrar las dos cosas nuevas sin esperar a que pase algo
// de verdad: el chat de 3 puntas (el jefe le escribe al tripulante) y el
// "¿Dónde la acomodo?" (el tablero propone sobre el plan publicado).
//
// Idempotente: correrlo dos veces no duplica nada. Solo DEV.
//
//   cd rendio-backend
//   set -a; source .env.dev; set +a
//   node scripts/seed-demo-eventualidades.mjs            # sembrar
//   node scripts/seed-demo-eventualidades.mjs --limpiar  # borrar todo lo sembrado
import { createClient } from '@supabase/supabase-js';

const DEV_REF = 'lxlphbafhtphulanhzlp';
if (!(process.env.SUPABASE_URL || '').includes(DEV_REF)) { console.error('ABORT: no es dev'); process.exit(2); }
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const LIMPIAR = process.argv.includes('--limpiar');
const MARCA = 'DEMO-JEFES';   // va en pickup_address; por ahí se borra después

// Mañana en hora de Colombia: el plan se publica hoy y se opera mañana, que es
// como pasa de verdad.
const hoy = new Date();
const DAY = new Date(hoy.getTime() + 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
const at = (t) => `${DAY}T${t}:00-05:00`;

// Coordenadas REALES de Rionegro (ver [project-pruebas-vivo-dev]): una coord que
// no corresponde al sector produce rutas absurdas.
const GENTE = [
  { n: 'El Porvenir · portería 1',   lat: 6.1455, lng: -75.3845, pres: '05:00' },
  { n: 'El Porvenir · portería 2',   lat: 6.1461, lng: -75.3838, pres: '05:00' },
  { n: 'Centro · Cra 50',            lat: 6.1537, lng: -75.3738, pres: '05:00' },
  { n: 'Llanogrande · km 3',         lat: 6.1290, lng: -75.4130, pres: '05:00' },
];
// La que llega tarde: mismo día, ya con el plan afuera, y en un sector distinto
// para que "¿dónde la acomodo?" tenga que pensar.
const TARDIA = { n: 'San Antonio de Pereira', lat: 6.1723, lng: -75.3573, pres: '05:00' };

async function limpiar() {
  const { data: res } = await db.from('reservations').select('id').like('pickup_address', `%${MARCA}%`);
  const ids = (res || []).map(r => r.id);
  if (ids.length) {
    await db.from('incidents').delete().in('reservation_id', ids);
    const { data: st } = await db.from('route_stops').select('route_assignment_id').in('reservation_id', ids);
    const ras = [...new Set((st || []).map(s => s.route_assignment_id))];
    await db.from('route_stops').delete().in('reservation_id', ids);
    if (ras.length) await db.from('route_assignments').delete().in('id', ras);
    await db.from('reservations').delete().in('id', ids);
  }
  await db.from('notification_outbox').delete().is('sent_at', null).like('title', '%tripulante%');
  console.log(`Limpio: se borraron ${ids.length} reservas de la demostración y todo lo que colgaba de ellas.`);
}

await limpiar();                       // idempotencia: siempre parte de cero
if (LIMPIAR) process.exit(0);

// ---------------------------------------------------------------- 1. LA GENTE
const { data: auxs } = await db.from('auxiliar_profiles')
  .select('id, profiles(full_name)').limit(GENTE.length + 1);
if (!auxs || auxs.length < GENTE.length + 1) {
  console.error(`Faltan tripulantes en dev (hay ${auxs?.length || 0}, se necesitan ${GENTE.length + 1}).`);
  process.exit(1);
}

const crearReserva = async (aux, p) => {
  const { data, error } = await db.from('reservations').insert({
    auxiliar_profile_id: aux.id,
    direction: 'home_to_airport',
    status_h2a: 'requested',
    pickup_address: `${p.n} · ${MARCA}`,
    pickup_latitude: p.lat, pickup_longitude: p.lng,
    // OJO: en una SALIDA esto es la hora de presentación en MDE, no la de
    // recogida. La recogida la calcula el tablero hacia atrás.
    required_arrival_at: at(p.pres),
  }).select('id').single();
  if (error) { console.error(error.message); process.exit(1); }
  return data.id;
};

const reservas = [];
for (let i = 0; i < GENTE.length; i++) reservas.push(await crearReserva(auxs[i], GENTE[i]));

// ------------------------------------------------------- 2. EL PLAN PUBLICADO
const { data: vehs } = await db.from('vehicles').select('id, internal_code').limit(2);
const { data: drvs } = await db.from('driver_profiles').select('id, profiles(full_name)').limit(2);
if (!vehs?.length || !drvs?.length) { console.error('Faltan vehículos o conductores en dev.'); process.exit(1); }

// Dos carros, dos y dos. Salida 03:40 para llegar con holgura a las 05:00.
const reparto = [
  { veh: vehs[0], drv: drvs[0], stops: reservas.slice(0, 2), start: '03:40' },
  { veh: vehs[1] || vehs[0], drv: drvs[1] || drvs[0], stops: reservas.slice(2), start: '03:40' },
];

for (const r of reparto) {
  const { data: ra, error } = await db.from('route_assignments').insert({
    driver_profile_id: r.drv.id, vehicle_id: r.veh.id,
    direction: 'home_to_airport',
    status: 'planned',                 // publicado = con conductor asignado
    planned_start_at: at(r.start),
  }).select('id').single();
  if (error) { console.error(error.message); process.exit(1); }
  await db.from('route_stops').insert(r.stops.map((rid, i) => ({
    route_assignment_id: ra.id, reservation_id: rid, stop_order: i + 1, status: 'pending',
  })));
}

// --------------------------------------------- 3. LA QUE LLEGA TARDE, SIN CARRO
const tardia = await crearReserva(auxs[GENTE.length], TARDIA);

// El detector corre solo cada 5 min; acá se dispara de una para no esperar.
const { data: n } = await db.rpc('detect_late_bookings');

console.log(`
Listo. Escenario sembrado en DEV para el día ${DAY}.

  Plan publicado    ${reparto.length} carros · ${reservas.length} tripulantes · salen 03:40 · presentación 05:00
                    ${reparto.map(r => `${r.veh.internal_code} → ${r.drv.profiles?.full_name || 'conductor'}`).join('  |  ')}

  Llegó tarde       ${TARDIA.n} — SIN carro
                    eventualidades nuevas que abrió el detector: ${n}

Para borrar todo esto cuando termines:
  node scripts/seed-demo-eventualidades.mjs --limpiar
`);
