// Verifica 0048: columnas + RPC + calificar E2E como auxiliar dueño.
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
const DEV = 'lxlphbafhtphulanhzlp';
const ref = process.env.SUPABASE_PROJECT_REF || '';
if (!(process.env.SUPABASE_URL || '').includes(DEV) || ref !== DEV) { console.error('ABORT: no es dev'); process.exit(2); }
const PW = 'DemoRendio2026!';
const c = new pg.Client({ host: 'aws-1-us-east-1.pooler.supabase.com', port: 5432, user: 'postgres.' + ref, password: process.env.SUPABASE_DB_PASSWORD, database: 'postgres', ssl: { rejectUnauthorized: false } });
await c.connect();

const cols = (await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name='reservations' AND column_name IN ('rating','rating_tags','rated_at') ORDER BY 1`)).rows.map(r => r.column_name);
console.log('columnas:', cols.join(', ') || '(ninguna)');
const fn = (await c.query(`SELECT prosecdef FROM pg_proc WHERE proname='auxiliar_rate_reservation'`)).rows[0];
console.log('RPC existe · SECURITY DEFINER:', fn ? fn.prosecdef : 'NO existe');

// Una reserva de un auxiliar para calificar (con su email).
const row = (await c.query(`
  SELECT r.id, u.email FROM reservations r
  JOIN auxiliar_profiles ap ON ap.id=r.auxiliar_profile_id
  JOIN auth.users u ON u.id=ap.profile_id
  WHERE r.cancelled_at IS NULL LIMIT 1`)).rows[0];
await c.end();
console.log('probando con:', row.email, '· reserva', row.id);

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const { error: le } = await sb.auth.signInWithPassword({ email: row.email, password: PW });
if (le) { console.log('login FALLÓ:', le.message); process.exit(1); }
const { error: re } = await sb.rpc('auxiliar_rate_reservation', { p_reservation_id: row.id, p_rating: 5, p_tags: ['Puntual', 'Amable'] });
console.log('calificar →', re ? 'ERROR ' + re.message : 'OK ✓');
const { data } = await sb.from('reservations').select('rating, rating_tags, rated_at').eq('id', row.id).single();
console.log('leído de vuelta →', JSON.stringify(data));
await sb.auth.signOut();
