// Prueba 0047 EXTREMO A EXTREMO vía PostgREST con login real de auxiliar:
//   (a) el dueño de la reserva recibe conductor + posición
//   (b) OTRO auxiliar recibe null (ownership / RLS)
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';

const DEV_REF = 'lxlphbafhtphulanhzlp';
const ref = process.env.SUPABASE_PROJECT_REF || '';
if (!(process.env.SUPABASE_URL || '').includes(DEV_REF) || ref !== DEV_REF) {
  console.error('ABORT: no es dev'); process.exit(2);
}
const PW = process.env.AUX_TEST_PW || 'DemoRendio2026!';

const c = new pg.Client({
  host: 'aws-1-us-east-1.pooler.supabase.com', port: 5432,
  user: 'postgres.' + ref, password: process.env.SUPABASE_DB_PASSWORD,
  database: 'postgres', ssl: { rejectUnauthorized: false },
});
await c.connect();

// Dueño: una reserva en ruta activa. Y un auxiliar DISTINTO para el caso negativo.
const owner = (await c.query(`
  SELECT r.id AS reservation_id, u.email
  FROM reservations r
  JOIN route_stops rs ON rs.reservation_id = r.id
  JOIN route_assignments ra ON ra.id = rs.route_assignment_id
  JOIN auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
  JOIN auth.users u ON u.id = ap.profile_id
  WHERE ra.status IN ('planned','in_progress') AND r.cancelled_at IS NULL
  ORDER BY ra.planned_start_at DESC NULLS LAST LIMIT 1`)).rows[0];

const other = (await c.query(`
  SELECT u.email FROM auth.users u
  JOIN auxiliar_profiles ap ON ap.profile_id = u.id
  JOIN reservations r ON r.auxiliar_profile_id = ap.id
  WHERE u.email <> $1 LIMIT 1`, [owner.email])).rows[0];
await c.end();

console.log('Dueño   :', owner.email, '· reserva', owner.reservation_id);
console.log('Otro aux:', other?.email || '(no hay)');

const mk = () => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } });

async function callAs(email, label) {
  const sb = mk();
  const { error: le } = await sb.auth.signInWithPassword({ email, password: PW });
  if (le) { console.log(`\n[${label}] login FALLÓ: ${le.message}`); return; }
  const { data, error } = await sb.rpc('auxiliar_track_reservation', { p_reservation_id: owner.reservation_id });
  console.log(`\n[${label}] ${email}`);
  if (error) { console.log('   RPC error:', error.message); return; }
  console.log('   →', JSON.stringify(data));
  await sb.auth.signOut();
}

await callAs(owner.email, 'DUEÑO (espera datos)');
if (other?.email) await callAs(other.email, 'OTRO (espera null)');
