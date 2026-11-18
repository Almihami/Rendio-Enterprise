// Prueba LOCAL de 0177 en un Postgres en memoria (PGlite): no toca dev ni prod.
// Monta un esquema mínimo con las tablas que la migración lee, corre la
// migración (dos veces: es idempotente), revisa la lista por turno y la purga, y
// al final corre el down.
// Uso: node _verify-0177-pglite.mjs <carpeta con node_modules/@electric-sql/pglite>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const mods = process.argv[2];
const { PGlite } = await import(join(mods, 'node_modules/@electric-sql/pglite/dist/index.js'));
const here = new URL('../', import.meta.url).pathname;
const UP = readFileSync(join(here, 'supabase/migrations/0177_chats_con_conductores.sql'), 'utf8');
const DOWN = readFileSync(join(here, 'down_migrations/0177_chats_con_conductores.down.sql'), 'utf8');
const m0144 = readFileSync(join(here, 'supabase/migrations/0144_avisos_por_turno_y_freno.sql'), 'utf8');
const turnoDe = m0144.slice(m0144.indexOf('CREATE OR REPLACE FUNCTION public.turno_de'), m0144.indexOf('$$;', m0144.indexOf('CREATE OR REPLACE FUNCTION public.turno_de')) + 3);

const db = new PGlite();
let ok = 0, mal = 0;
const check = (c, t) => { c ? ok++ : mal++; console.log((c ? '  ✓ ' : '  ✗ ') + t); };

await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated;
  CREATE SCHEMA auth; CREATE SCHEMA cron;
  CREATE TABLE cron.job (jobname text PRIMARY KEY, schedule text, command text);
  CREATE FUNCTION cron.schedule(n text, s text, c text) RETURNS bigint LANGUAGE sql AS $$
    INSERT INTO cron.job VALUES (n, s, c) ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command; SELECT 1::bigint $$;
  CREATE FUNCTION cron.unschedule(n text) RETURNS boolean LANGUAGE sql AS $$ DELETE FROM cron.job WHERE jobname = n; SELECT true $$;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('t.uid', true), '')::uuid $$;
  CREATE FUNCTION public.current_user_org() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('t.org', true), '')::uuid $$;
  CREATE FUNCTION public.current_user_role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('t.role', true), '') $$;
  CREATE TABLE public.app_settings (id text PRIMARY KEY, route_night_cutoff_min int);
  INSERT INTO public.app_settings VALUES ('singleton', 120);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, full_name text, phone text, organization_id uuid);
  CREATE TABLE public.residences (id uuid PRIMARY KEY, name text);
  CREATE TABLE public.auxiliar_profiles (id uuid PRIMARY KEY, profile_id uuid, residence_id uuid);
  CREATE TABLE public.driver_profiles (id uuid PRIMARY KEY, profile_id uuid);
  CREATE TABLE public.reservations (id uuid PRIMARY KEY, auxiliar_profile_id uuid, direction text, calculated_pickup_at timestamptz,
    required_arrival_at timestamptz, flight_code text, cancelled_at timestamptz, residence_id uuid);
  CREATE TABLE public.route_assignments (id uuid PRIMARY KEY, driver_profile_id uuid, planned_start_at timestamptz, status text);
  CREATE TABLE public.route_stops (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), route_assignment_id uuid, reservation_id uuid, estimated_arrival_at timestamptz);
  CREATE TABLE public.reservation_messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reservation_id uuid, sender_profile_id uuid,
    sender_role text, body text, read_by uuid[] DEFAULT '{}', created_at timestamptz DEFAULT now());
`);
await db.exec(turnoDe);

// ── datos ─────────────────────────────────────────────────────────────────
const U = (n) => '00000000-0000-0000-0000-' + String(n).padStart(12, '0');
const ORG = U(900), OTRA = U(901), JEFE = U(1);
const hoy = (await db.query(`SELECT (now() AT TIME ZONE 'America/Bogota')::date AS d`)).rows[0].d;
const bog = (dias, hm) => `((((now() AT TIME ZONE 'America/Bogota')::date + ${dias}) + time '${hm}') AT TIME ZONE 'America/Bogota')`;
await db.exec(`
  INSERT INTO public.residences VALUES ('${U(500)}', 'Llanogrande');
  INSERT INTO public.profiles VALUES
    ('${JEFE}', 'Camilo Martínez', '', '${ORG}'),
    ('${U(10)}', 'Juan Andrés Pérez', '3001', '${ORG}'), ('${U(11)}', 'Miguel Ángel Ruiz', '3002', '${ORG}'),
    ('${U(20)}', 'Laura Gómez', '3101', '${ORG}'), ('${U(21)}', 'Yerly Ríos', '3102', '${ORG}'), ('${U(22)}', 'Paula Díaz', '3103', '${ORG}'),
    ('${U(23)}', 'Ana Otra', '3104', '${OTRA}'), ('${U(24)}', 'Sara Vieja', '3105', '${ORG}'), ('${U(25)}', 'Eva Sin Carro', '3106', '${ORG}');
  INSERT INTO public.driver_profiles VALUES ('${U(110)}', '${U(10)}'), ('${U(111)}', '${U(11)}');
  INSERT INTO public.auxiliar_profiles VALUES ('${U(120)}', '${U(20)}', '${U(500)}'), ('${U(121)}', '${U(21)}', null), ('${U(122)}', '${U(22)}', null),
    ('${U(123)}', '${U(23)}', null), ('${U(124)}', '${U(24)}', null), ('${U(125)}', '${U(25)}', null);
  -- R1 Laura salida 05:10 hoy, vuelta de Juan → turno AM de hoy, conductor Juan
  INSERT INTO public.reservations VALUES ('${U(201)}', '${U(120)}', 'h2a', ${bog(0, '05:10')}, null, 'AV9301', null, null);
  INSERT INTO public.route_assignments VALUES ('${U(301)}', '${U(110)}', ${bog(0, '04:50')}, 'completed');
  INSERT INTO public.route_stops (route_assignment_id, reservation_id, estimated_arrival_at) VALUES ('${U(301)}', '${U(201)}', ${bog(0, '05:10')});
  INSERT INTO public.reservation_messages (reservation_id, sender_profile_id, sender_role, body, created_at, read_by) VALUES
    ('${U(201)}', '${U(10)}', 'driver', 'Voy llegando', ${bog(0, '05:02')}, '{}'),
    ('${U(201)}', '${U(20)}', 'auxiliar', 'Ya bajo', ${bog(0, '05:04')}, '{}');
  -- R2 Yerly llegada que sale 00:30 de hoy (madrugada) → turno PM de AYER; vuelta de Miguel, pero escribió Juan → Juan
  INSERT INTO public.reservations VALUES ('${U(202)}', '${U(121)}', 'a2h', null, ${bog(0, '00:10')}, 'LA4026', null, null);
  INSERT INTO public.route_assignments VALUES ('${U(302)}', '${U(111)}', ${bog(0, '00:30')}, 'completed');
  INSERT INTO public.route_stops (route_assignment_id, reservation_id, estimated_arrival_at) VALUES ('${U(302)}', '${U(202)}', null);
  INSERT INTO public.reservation_messages (reservation_id, sender_profile_id, sender_role, body, created_at, read_by) VALUES
    ('${U(202)}', '${U(21)}', 'auxiliar', 'Estoy en la banda 3', ${bog(0, '00:20')}, ARRAY['${JEFE}']::uuid[]),
    ('${U(202)}', '${U(10)}', 'driver', 'Te veo afuera', ${bog(0, '00:25')}, '{}'),
    ('${U(202)}', '${JEFE}', 'admin', 'Juan, ella va contigo', ${bog(0, '00:26')}, '{}');
  -- R3 Paula: solo escribió ella, vuelta de Miguel 15:00 → Miguel, turno PM de hoy
  INSERT INTO public.reservations VALUES ('${U(203)}', '${U(122)}', 'h2a', ${bog(0, '15:00')}, null, null, null, null);
  INSERT INTO public.route_assignments VALUES ('${U(303)}', '${U(111)}', ${bog(0, '14:40')}, 'planned'), ('${U(304)}', '${U(110)}', ${bog(0, '14:50')}, 'cancelled');
  INSERT INTO public.route_stops (route_assignment_id, reservation_id, estimated_arrival_at) VALUES ('${U(303)}', '${U(203)}', ${bog(0, '15:00')}), ('${U(304)}', '${U(203)}', ${bog(0, '15:05')});
  INSERT INTO public.reservation_messages (reservation_id, sender_profile_id, sender_role, body, created_at) VALUES
    ('${U(203)}', '${U(22)}', 'auxiliar', '¿A qué hora pasan?', ${bog(0, '13:00')});
  -- R4 de otra organización → no sale
  INSERT INTO public.reservations VALUES ('${U(204)}', '${U(123)}', 'h2a', ${bog(0, '06:00')}, null, null, null, null);
  INSERT INTO public.reservation_messages (reservation_id, sender_profile_id, sender_role, body, created_at) VALUES ('${U(204)}', '${U(23)}', 'auxiliar', 'hola', ${bog(0, '05:00')});
  -- R5 Sara: último mensaje hace 10 días → no sale en 7, sí en 14
  INSERT INTO public.reservations VALUES ('${U(205)}', '${U(124)}', 'h2a', ${bog(-10, '07:00')}, null, null, null, null);
  INSERT INTO public.reservation_messages (reservation_id, sender_profile_id, sender_role, body, created_at) VALUES ('${U(205)}', '${U(24)}', 'auxiliar', 'viejo', ${bog(-10, '06:00')});
  -- R6 Eva: sin vuelta y sin conductor
  INSERT INTO public.reservations VALUES ('${U(206)}', '${U(125)}', 'h2a', ${bog(1, '09:00')}, null, null, null, null);
  INSERT INTO public.reservation_messages (reservation_id, sender_profile_id, sender_role, body, created_at) VALUES ('${U(206)}', '${U(25)}', 'auxiliar', 'sin carro aún', now() - interval '5 minutes');
  -- R7 y R8 para la purga: R7 todo hace 40-45 días; R8 empezó hace 45 días y siguió hace 2
  INSERT INTO public.reservations VALUES ('${U(207)}', '${U(124)}', 'h2a', now() - interval '45 days', null, null, null, null), ('${U(208)}', '${U(124)}', 'h2a', now() - interval '45 days', null, null, null, null);
  INSERT INTO public.reservation_messages (reservation_id, sender_profile_id, sender_role, body, created_at) VALUES
    ('${U(207)}', '${U(24)}', 'auxiliar', 'a', now() - interval '45 days'), ('${U(207)}', '${U(10)}', 'driver', 'b', now() - interval '40 days'),
    ('${U(208)}', '${U(24)}', 'auxiliar', 'c', now() - interval '45 days'), ('${U(208)}', '${U(10)}', 'driver', 'd', now() - interval '2 days');
`);

// ── migración (dos veces) ─────────────────────────────────────────────────
await db.exec(UP); await db.exec(UP);
check(true, 'la migración corre y se puede correr dos veces');
check((await db.query(`SELECT reservation_chat_keep_days AS d FROM public.app_settings`)).rows[0].d === 30, 'reservation_chat_keep_days = 30 por defecto');
let rechazo = false; try { await db.exec(`UPDATE public.app_settings SET reservation_chat_keep_days = 0`); } catch (_) { rechazo = true; }
check(rechazo, 'no deja guardar 0 días');
const job = (await db.query(`SELECT schedule, command FROM cron.job WHERE jobname = 'purge-reservation-chat'`)).rows[0];
check(job && job.schedule === '40 8 * * *' && /purge_reservation_messages/.test(job.command), 'la purga queda programada a las 3:40 a. m. de Bogotá');

// ── lista ─────────────────────────────────────────────────────────────────
const como = async (uid, role, dias) => {
  await db.exec(`SELECT set_config('t.uid', '${uid}', false), set_config('t.org', '${ORG}', false), set_config('t.role', '${role}', false)`);
  const r = await db.query(`SELECT public.admin_chats_conductores(${dias == null ? '' : dias}) AS j`);
  return r.rows[0].j;
};
check((await como(U(10), 'driver')) === null, 'un conductor no puede pedir la lista');
const L = await como(JEFE, 'admin');
const de = (rid) => L.find((x) => x.reservation_id === rid);
check(Array.isArray(L) && L.length === 5 && !!de(U(208)), 'el jefe ve 5 chats de su organización en 7 días, incluido el que siguió hace 2 días (' + (L && L.length) + ')');
const r1 = de(U(201)), r2 = de(U(202)), r3 = de(U(203)), r6 = de(U(206));
const ayer = (await db.query(`SELECT ((now() AT TIME ZONE 'America/Bogota')::date - 1) AS d`)).rows[0].d;
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
check(r1 && r1.turno === 'am' && iso(r1.dia) === iso(hoy) && r1.conductor === 'Juan Andrés Pérez', 'Laura 5:10 → turno AM de hoy con Juan');
check(r1 && r1.tripulante === 'Laura Gómez' && r1.residence === 'Llanogrande' && r1.mensajes === 2 && r1.last_body === 'Ya bajo', 'Laura: nombre, conjunto, 2 mensajes y el último');
check(r2 && r2.turno === 'pm' && iso(r2.dia) === iso(ayer), 'Yerly 00:30 (madrugada) → turno PM de AYER');
check(r2 && r2.conductor === 'Juan Andrés Pérez', 'Yerly: la vuelta era de Miguel pero escribió Juan → dice Juan');
check(r2 && r2.mensajes === 3 && r2.del_conductor === 1 && r2.last_role === 'admin', 'Yerly: 3 mensajes, 1 del conductor, el último de la oficina');
check(r3 && r3.conductor === 'Miguel Ángel Ruiz' && r3.turno === 'pm', 'Paula: solo escribió ella → el conductor de su vuelta (Miguel), no el de la cancelada');
check(r6 && r6.conductor == null, 'Eva: sin vuelta → sin conductor');
check(!de(U(204)), 'el chat de otra organización no sale');
check(!de(U(205)), 'lo de hace 10 días no sale en la vista de 7');
check(!!(await como(JEFE, 'admin', 14)).find((x) => x.reservation_id === U(205)), 'sí sale si se piden 14 días');

// ── purga ─────────────────────────────────────────────────────────────────
const n = (await db.query(`SELECT public.purge_reservation_messages() AS n`)).rows[0].n;
const quedan = async (rid) => Number((await db.query(`SELECT count(*) AS c FROM public.reservation_messages WHERE reservation_id = '${rid}'`)).rows[0].c);
check(n === 2 && (await quedan(U(207))) === 0, 'borra completo el chat cuyo último mensaje tiene más de 30 días (' + n + ' mensajes)');
check((await quedan(U(208))) === 2, 'NO parte un chat que siguió hace 2 días: quedan sus 2 mensajes');
check((await quedan(U(205))) === 1, 'lo de hace 10 días se queda (plazo 30)');
await db.exec(`UPDATE public.app_settings SET reservation_chat_keep_days = 7`);
await db.query(`SELECT public.purge_reservation_messages()`);
check((await quedan(U(205))) === 0 && (await quedan(U(201))) === 2, 'con el plazo en 7 días se va lo de hace 10 y se queda lo de hoy');

// ── down ──────────────────────────────────────────────────────────────────
await db.exec(DOWN);
const fn = (await db.query(`SELECT count(*) AS c FROM pg_proc WHERE proname IN ('admin_chats_conductores', 'purge_reservation_messages')`)).rows[0].c;
const col = (await db.query(`SELECT count(*) AS c FROM information_schema.columns WHERE table_name = 'app_settings' AND column_name = 'reservation_chat_keep_days'`)).rows[0].c;
const cj = (await db.query(`SELECT count(*) AS c FROM cron.job WHERE jobname = 'purge-reservation-chat'`)).rows[0].c;
check(Number(fn) === 0 && Number(col) === 0 && Number(cj) === 0, 'el down quita funciones, columna y tarea');
await db.exec(UP);
check(true, 'y se puede volver a aplicar después del down');
console.log(`\n${ok} bien, ${mal} mal`);
process.exit(mal ? 1 : 0);
