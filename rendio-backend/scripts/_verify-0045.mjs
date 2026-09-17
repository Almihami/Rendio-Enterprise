// Verifica en la BD de dev que la 0045 quedó aplicada de verdad.
import pg from 'pg';
const DEV_REF = 'lxlphbafhtphulanhzlp';
const ref = process.env.SUPABASE_PROJECT_REF || '';
if (!(process.env.SUPABASE_URL || '').includes(DEV_REF) || ref !== DEV_REF) {
  console.error('ABORT: no es dev');
  process.exit(2);
}
const c = new pg.Client({
  host: 'aws-1-us-east-1.pooler.supabase.com',
  port: 5432,
  user: 'postgres.' + ref,
  password: process.env.SUPABASE_DB_PASSWORD,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
});
await c.connect();
const q = async (label, sql) => {
  const r = await c.query(sql);
  console.log(`\n— ${label}`);
  r.rows.forEach((row) => console.log('   ', JSON.stringify(row)));
  return r.rows;
};

await q('driver_locations.source existe?', `
  SELECT column_name, data_type, column_default, is_nullable
  FROM information_schema.columns
  WHERE table_name='driver_locations' AND column_name='source'`);

await q('route_stops.actual_dropoff_at existe?', `
  SELECT column_name, data_type FROM information_schema.columns
  WHERE table_name='route_stops' AND column_name='actual_dropoff_at'`);

await q('CHECK de route_stops.status acepta delivered?', `
  SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
  WHERE conname='route_stops_status_valid'`);

await q('CHECK de driver_locations.source', `
  SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
  WHERE conname='driver_locations_source_valid'`);

await q('la función quedó con el ancla?', `
  SELECT (prosrc LIKE '%anchor%') AS tiene_ancla,
         (prosrc LIKE '%actual_dropoff_at%') AS tiene_dropoff
  FROM pg_proc WHERE proname='driver_set_reservation_status'`);

await c.end();
