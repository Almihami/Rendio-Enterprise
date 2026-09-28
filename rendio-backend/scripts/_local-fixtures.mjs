// Datos de prueba para la base LOCAL (supabase start). La base local nace vacía,
// así que cada verificación arma sus propias filas DENTRO de una transacción que
// se deshace: no queda nada, y no depende de lo que haya en dev.
//
//   import { localClient, fixtures } from './_local-fixtures.mjs';
//   const c = await localClient(); await c.query('BEGIN');
//   const fx = await fixtures(c);   // org, aeropuerto, conjunto, tripulante, conductor, carro
//   ...
//   await c.query('ROLLBACK');
//
// Nunca apunta a dev ni a producción: la cadena de conexión es la del stack local
// y se niega a correr si alguien le pasa otra.
import pg from 'pg';

export const LOCAL_DB = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

export async function localClient() {
  const url = process.env.LOCAL_DB_URL || LOCAL_DB;
  if (!/@(127\.0\.0\.1|localhost):54322\//.test(url)) throw new Error('ABORT: _local-fixtures solo trabaja contra la base local');
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
}

async function one(c, sql, params) { return (await c.query(sql, params)).rows[0]; }

// Crea un usuario de auth + su profile con el rol pedido.
export async function user(c, org, role, name) {
  const email = `${role}.${Math.abs(hash(name))}@prueba.local`;
  const u = await one(c, `INSERT INTO auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $1, '{}', '{}', now(), now())
    RETURNING id`, [email]);
  await c.query(`INSERT INTO public.profiles (id, organization_id, role, full_name, email)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (id) DO UPDATE SET organization_id = EXCLUDED.organization_id, role = EXCLUDED.role, full_name = EXCLUDED.full_name`,
    [u.id, org, role, name, email]);
  return u.id;
}

function hash(s) { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) | 0; return h; }

export async function fixtures(c, opts = {}) {
  const org = (await one(c, `INSERT INTO public.organizations (name, slug) VALUES ('Prueba local', 'prueba-local-' || substr(md5(random()::text), 1, 6)) RETURNING id`)).id;
  const airport = (await one(c, `INSERT INTO public.airports (organization_id, iata_code, name, latitude, longitude)
    VALUES ($1, 'MDE', 'José María Córdova', 6.1645, -75.4231) RETURNING id`, [org])).id;
  // Dos conjuntos reales del Oriente (dentro de la caja del CHECK de 0055).
  const olivar = (await one(c, `INSERT INTO public.residences (organization_id, name, latitude, longitude, sector)
    VALUES ($1, 'El Olivar', 6.1523, -75.3781, 'Rionegro') RETURNING id`, [org])).id;
  const llano = (await one(c, `INSERT INTO public.residences (organization_id, name, latitude, longitude, sector)
    VALUES ($1, 'Quintas de Llanogrande', 6.1175, -75.4152, 'Llanogrande') RETURNING id`, [org])).id;

  const auxUser = await user(c, org, 'auxiliar', opts.auxName || 'Laura Gómez');
  const aux = (await one(c, `INSERT INTO public.auxiliar_profiles (profile_id, residence_id) VALUES ($1, $2) RETURNING id`, [auxUser, olivar])).id;
  const vecinoUser = await user(c, org, 'auxiliar', 'Vecina de El Olivar');
  const vecino = (await one(c, `INSERT INTO public.auxiliar_profiles (profile_id, residence_id) VALUES ($1, $2) RETURNING id`, [vecinoUser, olivar])).id;

  const drvUser = await user(c, org, 'driver', 'Carlos Mejía');
  const driver = (await one(c, `INSERT INTO public.driver_profiles (profile_id) VALUES ($1) RETURNING id`, [drvUser])).id;
  const vehicle = (await one(c, `INSERT INTO public.vehicles (organization_id, internal_code, license_plate)
    VALUES ($1, 'P-01', 'RDO481') RETURNING id`, [org])).id;

  return { org, airport, olivar, llano, auxUser, aux, vecinoUser, vecino, drvUser, driver, vehicle };
}

// Actuar como un usuario (para probar RLS y RPC): claims del JWT + rol authenticated.
export async function asUser(c, userId, role) {
  await c.query(`SELECT set_config('request.jwt.claims', $1, true)`,
    [JSON.stringify({ sub: userId, role: 'authenticated', user_role: role })]);
  await c.query(`SET LOCAL ROLE authenticated`);
}
export async function asAdminDb(c) { await c.query(`RESET ROLE`); }
