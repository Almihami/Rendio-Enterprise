// 0122 · Vuelos pegados: seguir con Flightradar24 los vuelos del plan del jefe.
//
//   cd rendio-backend/scripts && node _verify-0122.mjs                 (base LOCAL)
//   set -a; source ../.env.dev; set +a; node _verify-0122.mjs --dev    (base de DEV)
//
// Todo dentro de una transacción que se deshace: aplica 0118 si falta y 0122,
// arma sus propias filas y comprueba
//   1. la tabla y su RLS: la jefa pega un vuelo (código normalizado, día de
//      Bogotá, organización y autor solos); el mismo vuelo el mismo día es una
//      fila; tripulante, conductor y jefe de otra organización no ven ni pegan;
//   2. el calendario: un vuelo pegado entra 2 h antes como cualquier reserva; si
//      también hay reserva es UN vuelo con la hora más temprana; bandera apagada,
//      nada;
//   3. los avisos: un vuelo solo pegado avisa a los jefes (enlace a Vuelos) y a
//      ningún conductor; uno sin reserva ni pegado, a nadie; el de reserva sigue
//      avisándole a su conductor;
//   4. la purga borra los pegados de más de 28 días;
//   5. el lector (fr24.mjs, modo prueba) sobre un vuelo pegado: lo guarda y avisa.
//
// NO CUBRE: la pantalla (eso es _smoke-vuelos-admin.mjs y el navegador), FR24
// de verdad, el push.
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { localClient, fixtures, user, asUser, asAdminDb } from './_local-fixtures.mjs';
import * as fr from '../supabase/functions/flight-status/fr24.mjs';

const DEV = process.argv.includes('--dev');
async function conectar() {
  if (!DEV) return localClient();
  const DEV_REF = 'lxlphbafhtphulanhzlp';
  const ref = process.env.SUPABASE_PROJECT_REF || '';
  if (!(process.env.SUPABASE_URL || '').includes(DEV_REF) || ref !== DEV_REF) { console.error('ABORT: no es dev'); process.exit(2); }
  const cli = new pg.Client({ host: 'aws-1-us-east-1.pooler.supabase.com', port: 5432,
    user: 'postgres.' + ref, password: process.env.SUPABASE_DB_PASSWORD, database: 'postgres', ssl: { rejectUnauthorized: false } });
  await cli.connect();
  return cli;
}

const c = await conectar();
c.on('notice', () => {});
const q = async (s, p) => (await c.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
let ok = 0, fail = 0;
const check = (n, cond, det) => { if (cond) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + (typeof det === 'string' ? det : JSON.stringify(det)) : ''}`); } };
const leer = (f) => readFileSync(new URL('../supabase/' + f, import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const FX = new URL('../supabase/functions/flight-status/fixtures/', import.meta.url).pathname;
const fixturesFr24 = { summary: JSON.parse(readFileSync(FX + 'fr24-summary-light.json', 'utf8')), live: JSON.parse(readFileSync(FX + 'fr24-live-full.json', 'utf8')) };
const como = async (quien, rol, sql, params) => {
  await c.query('SAVEPOINT s');
  try { await asUser(c, quien, rol); const r = await q(sql, params); await asAdminDb(c); await c.query('RELEASE SAVEPOINT s'); return [r, null]; }
  catch (e) { await c.query('ROLLBACK TO SAVEPOINT s'); await asAdminDb(c); return [null, e.message]; }
};
const hhmm = (d) => new Date(d).toLocaleTimeString('en-GB', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false });
const MIN = 60000;

console.log(`0122 contra la base ${DEV ? 'de DEV' : 'LOCAL'} (todo se deshace al final)`);
await c.query('BEGIN');
try {
  const con0118 = (await one(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name = 'app_settings' AND column_name = 'flight_code_aliases'`)).n === 1;
  if (!con0118) await c.query(leer('migrations/0118_vuelos_flightradar24.sql'));
  await c.query(leer('migrations/0122_vuelos_pegados.sql'));
  await q(`INSERT INTO public.app_settings (id) VALUES ('singleton') ON CONFLICT (id) DO NOTHING`);
  await q(`UPDATE public.app_settings SET flight_api_enabled = true, flight_code_aliases = '{}'::jsonb, route_deplane_min = 19,
             route_deplane_av_nac_min = 15, route_deplane_av_int_min = 20, route_deplane_js_nac_min = 25,
             route_deplane_js_int_min = 30, route_deplane_wingo_min = 22 WHERE id = 'singleton'`);
  const fx = await fixtures(c);
  const jefa = await user(c, fx.org, 'admin', 'Jefa Pegados 0122');
  await q(`UPDATE public.profiles SET receives_ops_alerts = true WHERE id = $1`, [jefa]);
  const org2 = (await one(`INSERT INTO public.organizations (name, slug) VALUES ('Otra 0122', 'otra-0122-' || substr(md5(random()::text), 1, 6)) RETURNING id`)).id;
  const jefeOtra = await user(c, org2, 'admin', 'Jefe Otra Org 0122');
  const T0 = new Date((await one(`SELECT now() t`)).t).getTime();
  const iso = (ms) => new Date(ms).toISOString();
  const at = (min) => T0 + min * MIN;
  const targets = async (pNow) => q(`SELECT * FROM public.flight_status_targets($1::timestamptz, 200) WHERE organization_id = $2 ORDER BY flight_code`, [iso(pNow ?? T0), fx.org]);
  const codes = (rows) => rows.map(r => r.flight_code);

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n1. La tabla y quién la usa');
  let [r, e] = await como(jefa, 'admin', `INSERT INTO public.flight_watches (flight_code, sched_at, label) VALUES ('av 9384', $1, '  Lina  ') RETURNING *`, [iso(at(110))]);
  const w1 = r && r[0];
  check('la jefa pega un vuelo: código normalizado, su organización y su nombre como autora', !e && w1 && w1.flight_code === 'AV9384' && w1.organization_id === fx.org && w1.created_by === jefa && w1.label === 'Lina', e || w1);
  const diaW = (await one(`SELECT ($1::timestamptz AT TIME ZONE 'America/Bogota')::date::text d`, [iso(at(110))])).d;
  check('…y el día es el de Bogotá de la hora prevista', w1 && (await one(`SELECT $1::date::text d`, [w1.flight_date])).d === diaW, w1 && w1.flight_date);
  [r, e] = await como(jefa, 'admin', `INSERT INTO public.flight_watches (flight_code, sched_at, label) VALUES ('AV9384', $1, 'Lina') ON CONFLICT (organization_id, flight_code, flight_date) DO UPDATE SET label = EXCLUDED.label, sched_at = EXCLUDED.sched_at RETURNING id`, [iso(at(105))]);
  check('pegarlo otra vez el mismo día actualiza la misma fila', !e && r && r[0].id === w1.id, e || r);
  [r, e] = await como(jefa, 'admin', `INSERT INTO public.flight_watches (flight_code, sched_at) VALUES ('¿¿??', $1)`, [iso(at(60))]);
  check('un código con basura se rechaza', !!e);
  [r, e] = await como(fx.auxUser, 'auxiliar', `SELECT count(*)::int n FROM public.flight_watches`);
  check('la tripulante no ve los pegados', !e && r[0].n === 0, e || r);
  [r, e] = await como(fx.auxUser, 'auxiliar', `INSERT INTO public.flight_watches (organization_id, flight_code, sched_at) VALUES ($1, 'AV1', now())`, [fx.org]);
  check('…ni puede pegar', !!e);
  [r, e] = await como(fx.drvUser, 'driver', `SELECT count(*)::int n FROM public.flight_watches`);
  check('el conductor tampoco los ve', !e && r[0].n === 0, e || r);
  [r, e] = await como(jefeOtra, 'admin', `SELECT count(*)::int n FROM public.flight_watches WHERE organization_id = $1`, [fx.org]);
  check('el jefe de otra organización no ve los de esta', !e && r[0].n === 0, e || r);
  [r, e] = await como(jefeOtra, 'admin', `INSERT INTO public.flight_watches (organization_id, flight_code, sched_at) VALUES ($1, 'AV2', now())`, [fx.org]);
  check('…ni puede pegar en ella', !!e);
  [r, e] = await como(jefa, 'admin', `DELETE FROM public.flight_watches WHERE flight_code = 'AV9384' RETURNING id`);
  check('la jefa puede quitar un vuelo pegado', !e && r.length === 1, e || r);

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n2. El calendario');
  const pegar = async (code, min, label) => (await como(jefa, 'admin', `INSERT INTO public.flight_watches (flight_code, sched_at, label) VALUES ($1, $2, $3) RETURNING *`, [code, iso(at(min)), label || null]))[0][0];
  const W1 = await pegar('AV9384', 110, 'Lina');
  await pegar('P57617', 130, 'Fabiana');
  let T = await targets();
  check('pegado a 1 h 50: entra al calendario (summary), sin reservas', codes(T).includes('AV9384') && T.find(x => x.flight_code === 'AV9384').reservations === 0 && T.find(x => x.flight_code === 'AV9384').mode === 'summary', T);
  check('pegado a 2 h 10: todavía no', !codes(T).includes('P57617'), codes(T));
  const R = (await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_a2h, required_arrival_at, residence_id, notes)
      VALUES ($1, 'airport_to_home', 'scheduled', $2, $3, 'Vuelo AV9384.') RETURNING id, required_arrival_at`, [fx.aux, iso(at(100)), fx.olivar]));
  T = await targets();
  const tA = T.filter(x => x.flight_code === 'AV9384');
  check('pegado + reserva del mismo vuelo: UNO, con 1 reserva y la hora más temprana', tA.length === 1 && tA[0].reservations === 1 && new Date(tA[0].ref_at).getTime() === new Date(R.required_arrival_at).getTime(), tA);
  await q(`UPDATE public.app_settings SET flight_api_enabled = false WHERE id = 'singleton'`);
  check('bandera apagada: nada', (await targets()).length === 0);
  await q(`UPDATE public.app_settings SET flight_api_enabled = true WHERE id = 'singleton'`);

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n3. Avisos');
  const ra = (await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at) VALUES ($1, $2, 'airport_to_home', 'planned', $3) RETURNING id`, [fx.driver, fx.vehicle, iso(at(90))])).id;
  await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order) VALUES ($1, $2, 1)`, [ra, R.id]);
  const W2 = await pegar('P57278', 60, 'Andrea Núñez');
  const rec = async (rows) => q(`SELECT public.flight_status_record($1::jsonb)`, [JSON.stringify(rows)]);
  const fila = (code, d, o) => Object.assign({ organization_id: fx.org, flight_code: code, flight_date: d, direction: 'airport_to_home', source: 'flightradar24', raw: {} }, o);
  const dia = async (ms) => (await one(`SELECT ($1::timestamptz AT TIME ZONE 'America/Bogota')::date::text d`, [iso(ms)])).d;
  const est = at(60 + 30);
  await rec([fila('P57278', await dia(at(60)), { status: 'in_air', sched_at: iso(at(60)), departed_at: iso(at(-20)), estimated_at: iso(est), delay_min: 30 }),
             fila('AV9384', await dia(at(100)), { status: 'in_air', sched_at: iso(at(100)), departed_at: iso(at(40)), estimated_at: iso(at(125)), delay_min: 25 }),
             fila('AV5555', await dia(at(80)), { status: 'in_air', sched_at: iso(at(80)), estimated_at: iso(at(120)), delay_min: 40 })]);
  await one(`SELECT public.flight_delay_alerts() n`);
  const bandeja = async (code) => q(`SELECT o.profile_id, o.title, o.body, o.url FROM public.notification_outbox o JOIN public.flight_statuses f ON o.dedupe_key LIKE 'flt:' || f.id::text || ':%'
      WHERE f.organization_id = $1 AND f.flight_code = $2 ORDER BY o.profile_id`, [fx.org, code]);
  let ob = await bandeja('P57278');
  const esperado = `Vuelo P57278 aterriza ${hhmm(est)} (30 min tarde). Recogida sugerida ${hhmm(est + 22 * MIN)}`;
  check('vuelo solo pegado, 30 min tarde: aviso a la jefa con «' + esperado + '»', ob.length === 1 && ob[0].profile_id === jefa && ob[0].body === esperado, ob);
  check('…con enlace a la pantalla Vuelos (#/vuelos), y a ningún conductor', ob.length === 1 && ob[0].url === '/#/vuelos', ob);
  ob = await bandeja('AV9384');
  check('vuelo con reserva (y pegado): a la jefa (#/vuelos) y al conductor de la ruta (/)', ob.length === 2 && ob.find(x => x.profile_id === jefa)?.url === '/#/vuelos' && ob.find(x => x.profile_id === fx.drvUser)?.url === '/', ob);
  ob = await bandeja('AV5555');
  check('vuelo sin reserva ni pegado: no avisa a nadie', ob.length === 0, ob);
  const jefeOtroOb = (await q(`SELECT count(*)::int n FROM public.notification_outbox WHERE profile_id = $1`, [jefeOtra]))[0].n;
  check('el jefe de la otra organización no recibe nada', jefeOtroOb === 0, jefeOtroOb);

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n4. Purga');
  await q(`ALTER TABLE public.flight_watches DISABLE TRIGGER tr_flight_watches_fill`);
  const viejo = (await one(`INSERT INTO public.flight_watches (organization_id, flight_code, flight_date, sched_at, label) VALUES ($1, 'AV7007', (now() AT TIME ZONE 'America/Bogota')::date - 35, now() - interval '35 days', 'Alguien') RETURNING id`, [fx.org])).id;
  await q(`ALTER TABLE public.flight_watches ENABLE TRIGGER tr_flight_watches_fill`);
  const txt = (await one(`SELECT public.purge_flight_statuses() t`)).t;
  const quedan = (await q(`SELECT id FROM public.flight_watches WHERE id = ANY($1::uuid[])`, [[viejo, W1.id, W2.id]])).map(x => x.id);
  check('borra el pegado de hace 35 días y deja los de hoy', !quedan.includes(viejo) && quedan.includes(W1.id) && quedan.includes(W2.id), quedan);
  check('lo dice: «' + txt + '»', /vuelos pegados borrados [1-9]/.test(txt), txt);
  const trg = await one(`SELECT tgenabled FROM pg_trigger WHERE tgname = 'tr_flight_watches_fill'`);
  check('el disparador quedó encendido', trg && trg.tgenabled === 'O');

  // ───────────────────────────────────────────────────────────────────────
  console.log('\n5. El lector sobre un vuelo pegado (modo prueba)');
  await q(`DELETE FROM public.flight_statuses WHERE organization_id = $1`, [fx.org]);
  await q(`DELETE FROM public.notification_outbox WHERE profile_id = ANY($1::uuid[])`, [[jefa, fx.drvUser]]);
  const W3 = await pegar('JA5987', 30, 'Paula Londoño');
  const now = at(10);   // el modo prueba despega 35 min antes de la hora (25 tarde)
  let tg = (await targets(now)).filter(x => x.flight_code === 'JA5987');
  let out = await fr.run(tg, { fetch: fr.mockFetch(tg, { now, fixtures: fixturesFr24 }), now });
  await rec(out.rows);
  let fs = await one(`SELECT * FROM public.flight_statuses WHERE organization_id = $1 AND flight_code = 'JA5987'`, [fx.org]);
  check('primera vuelta: lo guarda en el aire, con despegue', fs && fs.status === 'in_air' && fs.departed_at, fs && [fs.status, fs.departed_at]);
  const now2 = at(25);
  tg = (await targets(now2)).filter(x => x.flight_code === 'JA5987');
  out = await fr.run(tg, { fetch: fr.mockFetch(tg, { now: now2, fixtures: fixturesFr24 }), now: now2 });
  await rec(out.rows);
  await one(`SELECT public.flight_delay_alerts($1::timestamptz) n`, [iso(now2)]);
  fs = await one(`SELECT * FROM public.flight_statuses WHERE organization_id = $1 AND flight_code = 'JA5987'`, [fx.org]);
  ob = await bandeja('JA5987');
  check('segunda vuelta: ETA 25 min tarde y aviso a la jefa', fs && fs.delay_min === 25 && ob.length === 1 && ob[0].profile_id === jefa && /\(25 min tarde\)/.test(ob[0].body), fs && [fs.delay_min, ob]);
  void W3;
} catch (err) {
  fail++; console.log('  ✗ excepción:', err.message);
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok} ✓ · ${fail} ✗`);
process.exit(fail ? 1 : 0);
