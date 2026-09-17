// Verifica en dev que 0047 quedó bien y si hay datos para rastrear en vivo.
import pg from 'pg';
const DEV_REF = 'lxlphbafhtphulanhzlp';
const ref = process.env.SUPABASE_PROJECT_REF || '';
if (!(process.env.SUPABASE_URL || '').includes(DEV_REF) || ref !== DEV_REF) {
  console.error('ABORT: no es dev'); process.exit(2);
}
const c = new pg.Client({
  host: 'aws-1-us-east-1.pooler.supabase.com', port: 5432,
  user: 'postgres.' + ref, password: process.env.SUPABASE_DB_PASSWORD,
  database: 'postgres', ssl: { rejectUnauthorized: false },
});
await c.connect();
const q = async (label, sql) => {
  const r = await c.query(sql);
  console.log(`\n— ${label}`);
  if (!r.rows.length) console.log('    (0 filas)');
  r.rows.forEach((row) => console.log('   ', JSON.stringify(row)));
  return r.rows;
};

await q('¿existe la función y es SECURITY DEFINER?', `
  SELECT proname, prosecdef AS security_definer,
         pg_get_function_identity_arguments(oid) AS args
  FROM pg_proc WHERE proname = 'auxiliar_track_reservation'`);

await q('¿grant a authenticated?', `
  SELECT grantee, privilege_type FROM information_schema.routine_privileges
  WHERE routine_name = 'auxiliar_track_reservation'`);

await q('¿valida ownership (current_auxiliar_id) y usa driver_locations?', `
  SELECT (prosrc LIKE '%current_auxiliar_id%') AS valida_dueno,
         (prosrc LIKE '%driver_locations%')   AS lee_posicion,
         (prosrc LIKE '%route_stops%')        AS enlaza_ruta
  FROM pg_proc WHERE proname = 'auxiliar_track_reservation'`);

// --- Panorama de datos: ¿hay algo rastreable AHORA en dev? ---
await q('reservas en ruta ACTIVA (con conductor)', `
  SELECT ra.status, count(*) AS reservas, count(DISTINCT ra.driver_profile_id) AS conductores
  FROM route_stops rs
  JOIN route_assignments ra ON ra.id = rs.route_assignment_id
  WHERE ra.status IN ('planned','in_progress')
  GROUP BY ra.status`);

const cand = await q('candidata para probar (reserva de un auxiliar en ruta activa)', `
  SELECT r.id AS reservation_id, ap.id AS auxiliar_profile_id,
         apr.full_name AS auxiliar, dpr.full_name AS conductor,
         COALESCE(v.license_plate, v.internal_code) AS placa,
         rs.status AS stop_status,
         COALESCE(r.status_h2a::text, r.status_a2h::text) AS raw_status
  FROM reservations r
  JOIN auxiliar_profiles ap ON ap.id = r.auxiliar_profile_id
  JOIN profiles apr         ON apr.id = ap.profile_id
  JOIN route_stops rs       ON rs.reservation_id = r.id
  JOIN route_assignments ra ON ra.id = rs.route_assignment_id
  LEFT JOIN driver_profiles dp ON dp.id = ra.driver_profile_id
  LEFT JOIN profiles dpr       ON dpr.id = dp.profile_id
  LEFT JOIN vehicles v         ON v.id = ra.vehicle_id
  WHERE ra.status IN ('planned','in_progress') AND r.cancelled_at IS NULL
  LIMIT 3`);

await q('posiciones recientes por conductor (driver_locations)', `
  SELECT dp.id AS driver_profile_id, pr.full_name AS conductor,
         count(*) AS pings, max(dl.recorded_at) AS ultimo
  FROM driver_locations dl
  JOIN driver_profiles dp ON dp.id = dl.driver_profile_id
  JOIN profiles pr        ON pr.id = dp.profile_id
  GROUP BY dp.id, pr.full_name
  ORDER BY ultimo DESC NULLS LAST
  LIMIT 5`);

// Simula el corazón del RPC para la candidata (corriendo como postgres, así que
// replicamos la lógica del ownership a mano para ver la salida esperada).
if (cand.length) {
  const rid = cand[0].reservation_id;
  await q(`salida esperada del RPC para la reserva ${rid}`, `
    WITH ra_pick AS (
      SELECT ra.id, ra.driver_profile_id
      FROM route_stops rs
      JOIN route_assignments ra ON ra.id = rs.route_assignment_id
      WHERE rs.reservation_id = '${rid}' AND ra.status IN ('planned','in_progress')
      ORDER BY ra.planned_start_at DESC NULLS LAST LIMIT 1)
    SELECT (SELECT full_name FROM profiles p JOIN driver_profiles d ON d.profile_id=p.id
            WHERE d.id = (SELECT driver_profile_id FROM ra_pick)) AS conductor,
           (SELECT jsonb_build_object('lat',dl.latitude,'lng',dl.longitude,'source',dl.source,'at',dl.recorded_at)
            FROM driver_locations dl WHERE dl.driver_profile_id = (SELECT driver_profile_id FROM ra_pick)
            ORDER BY dl.recorded_at DESC LIMIT 1) AS pos`);
}

await c.end();
