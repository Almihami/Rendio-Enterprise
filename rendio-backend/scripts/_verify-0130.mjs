// Verificación de 0130 (corte de pedidos de las 7:40 p. m. y aviso del Excel)
// contra la base LOCAL (127.0.0.1:54322). Aplica lo que falte y 0130 dentro de una
// transacción que se deshace: no queda nada. Nunca apunta a dev ni a producción.
//
//   cd rendio-backend/scripts && node _verify-0130.mjs
//
// Qué prueba (fechas fijas: lun 2-nov-2026 se cierra el dom 1-nov 7:40 p. m.):
//   1. El corte por defecto es 7:40 p. m. (1180) y está en Ajustes (app_settings).
//   2. crew_request_deadline: una salida del lunes 6:00 → dom 7:40 p. m.; la
//      madrugada del martes (0:30) es del lunes → también dom 7:40 p. m.; a las
//      2:00 del martes ya es del martes → lun 7:40 p. m. Cambiar el corte a las
//      8:00 p. m. lo mueve.
//   3. excel_cutoff_alerts: antes del corte no avisa; a las 7:45 p. m. le llega UNA
//      vez a los jefes de la organización «📋 El Excel de mañana está listo · lun 2
//      nov · 2 pedidos hasta las 7:40 p. m. …» con enlace #/rutas?excel=2026-11-02.
//      No cuenta lo pedido después del corte (Late), lo cancelado ni lo del martes;
//      no se repite; 2 h después del corte ya no avisa; una organización sin
//      pedidos no recibe nada; el jefe de otra organización tampoco.
//   4. La app no puede llamar el aviso; sí el cálculo del corte. El reloj quedó
//      programado si hay pg_cron. El down lo quita todo.
//
// NO cubre: la pantalla (Reservas › Late y el Excel: _smoke-reservas-late-dom.mjs,
// _smoke-ruta-julian-dom.mjs), la push de verdad ni dev/producción.
import fs from 'node:fs';
import { localClient, fixtures, user } from './_local-fixtures.mjs';

let ok = 0, fail = 0;
const check = (n, cond, det) => {
  if (cond) { ok++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + (typeof det === 'string' ? det : JSON.stringify(det)) : ''}`); }
};
const c = await localClient();
const q = async (s, p) => (await c.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
const strip = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const existe = async (sql) => (await one(`SELECT (${sql}) IS NOT NULL AS ok`)).ok;
const iso = (s) => new Date(s).toISOString();

await c.query('BEGIN');
try {
  if (!(await existe(`to_regprocedure('public.ops_alert_recipients_of(uuid)')`))) await c.query(strip('../supabase/migrations/0117_avisos_desde_el_servidor.sql'));
  await c.query(strip('../supabase/migrations/0130_corte_de_pedidos.sql'));
  await c.query(strip('../supabase/migrations/0130_corte_de_pedidos.sql'));
  check('0130 se aplica (y se puede volver a correr)', true);
  await q(`INSERT INTO public.app_settings (id) VALUES ('singleton') ON CONFLICT (id) DO NOTHING`);
  await q(`UPDATE public.app_settings SET route_night_cutoff_min = 120, crew_request_cutoff_min = DEFAULT WHERE id = 'singleton'`);

  // ── 1 y 2. El corte ───────────────────────────────────────────────────────
  console.log('\n1. El corte y el día operativo');
  check('por defecto: 7:40 p. m. (1180 min)', (await one(`SELECT crew_request_cutoff_min v FROM public.app_settings WHERE id = 'singleton'`)).v === 1180);
  const dl = async (when) => iso((await one(`SELECT public.crew_request_deadline($1::timestamptz) d`, [when])).d);
  check('salida del lun 2-nov 6:00 → corte dom 1-nov 7:40 p. m.', await dl('2026-11-02T06:00:00-05:00') === iso('2026-11-01T19:40:00-05:00'), await dl('2026-11-02T06:00:00-05:00'));
  check('llegada del lun 2-nov 23:30 → el mismo corte', await dl('2026-11-02T23:30:00-05:00') === iso('2026-11-01T19:40:00-05:00'));
  check('madrugada del mar 3-nov 0:30 (turno PM del lunes) → corte dom 1-nov 7:40 p. m.', await dl('2026-11-03T00:30:00-05:00') === iso('2026-11-01T19:40:00-05:00'), await dl('2026-11-03T00:30:00-05:00'));
  check('mar 3-nov 2:00 ya es del martes → corte lun 2-nov 7:40 p. m.', await dl('2026-11-03T02:00:00-05:00') === iso('2026-11-02T19:40:00-05:00'), await dl('2026-11-03T02:00:00-05:00'));
  await q(`UPDATE public.app_settings SET crew_request_cutoff_min = 1200 WHERE id = 'singleton'`);
  check('con el corte a las 8:00 p. m. en Ajustes, se mueve', await dl('2026-11-02T06:00:00-05:00') === iso('2026-11-01T20:00:00-05:00'));
  await q(`UPDATE public.app_settings SET crew_request_cutoff_min = 1180 WHERE id = 'singleton'`);
  const e0 = await (async () => { await c.query('SAVEPOINT s'); try { await q(`UPDATE public.app_settings SET crew_request_cutoff_min = 1500 WHERE id = 'singleton'`); await c.query('RELEASE SAVEPOINT s'); return null; } catch (e) { await c.query('ROLLBACK TO SAVEPOINT s'); return e; } })();
  check('un corte fuera del día (1500) no se acepta', e0 && /crew_request_cutoff_range/.test(e0.message), e0 && e0.message);

  // ── 3. El aviso del Excel ─────────────────────────────────────────────────
  console.log('\n2. El aviso del Excel');
  const fx = await fixtures(c);
  const jefe = await user(c, fx.org, 'admin', 'Camilo prueba 0130');
  const otraOrg = (await one(`INSERT INTO public.organizations (name, slug) VALUES ('Otra 0130', 'otra-0130-' || substr(md5(random()::text), 1, 6)) RETURNING id`)).id;
  const jefeOtro = await user(c, otraOrg, 'admin', 'Jefe de otra org 0130');
  const res = async (aux, dir, when, creada, cancelada = false) => (await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, ${dir === 'sal' ? 'status_h2a' : 'status_a2h'}, required_arrival_at, pickup_address, pickup_latitude, pickup_longitude, residence_id, created_at, cancelled_at)
      VALUES ($1, $2, $3, $4::timestamptz, 'El Olivar, Rionegro', 6.1523, -75.3781, $5, $6::timestamptz, $7) RETURNING id`,
    [aux, dir === 'sal' ? 'home_to_airport' : 'airport_to_home', dir === 'sal' ? 'requested' : 'scheduled', when, fx.olivar, creada, cancelada ? creada : null])).id;
  await res(fx.aux, 'sal', '2026-11-02T06:00:00-05:00', '2026-11-01T10:00:00-05:00');          // a tiempo
  await res(fx.vecino, 'lle', '2026-11-03T00:30:00-05:00', '2026-11-01T19:39:00-05:00');       // madrugada, a tiempo
  await res(fx.aux, 'lle', '2026-11-02T15:00:00-05:00', '2026-11-01T19:41:00-05:00');          // Late
  await res(fx.vecino, 'sal', '2026-11-02T09:00:00-05:00', '2026-11-01T09:00:00-05:00', true); // cancelada
  await res(fx.aux, 'sal', '2026-11-03T08:00:00-05:00', '2026-11-01T09:00:00-05:00');          // del martes
  const avisos = async (prof) => q(`SELECT title, body, url FROM public.notification_outbox WHERE profile_id = $1 AND dedupe_key LIKE 'excel:%' ORDER BY created_at`, [prof]);
  const correr = async (hora) => (await one(`SELECT public.excel_cutoff_alerts($1::timestamptz) n`, [hora])).n;
  check('dom 7:30 p. m. (antes del corte): no avisa', (await correr('2026-11-01T19:30:00-05:00')) === 0 && (await avisos(jefe)).length === 0);
  await correr('2026-11-01T19:45:00-05:00');
  const a1 = await avisos(jefe);
  check('dom 7:45 p. m.: UN aviso al jefe', a1.length === 1, a1);
  check('«📋 El Excel de mañana está listo»', a1[0] && a1[0].title === '📋 El Excel de mañana está listo', a1[0] && a1[0].title);
  check('«lun 2 nov · 2 pedidos hasta las 7:40 p. m. Toca para descargarlo.» (sin el Late, la cancelada ni el martes)', a1[0] && a1[0].body === 'lun 2 nov · 2 pedidos hasta las 7:40 p. m. Toca para descargarlo.', a1[0] && a1[0].body);
  check('el enlace abre Asignación en ese día con el Excel', a1[0] && a1[0].url === '/#/rutas?excel=2026-11-02', a1[0] && a1[0].url);
  await correr('2026-11-01T19:50:00-05:00');
  check('cinco minutos después no se repite', (await avisos(jefe)).length === 1);
  check('al jefe de otra organización (sin pedidos) no le llega', (await avisos(jefeOtro)).length === 0);
  await q(`DELETE FROM public.notification_outbox WHERE dedupe_key LIKE 'excel:%'`);
  check('pasadas 2 h del corte (9:45 p. m.) ya no avisa', (await correr('2026-11-01T21:45:00-05:00')) === 0 && (await avisos(jefe)).length === 0);
  check('a las 9:40 p. m. (justo 2 h) todavía sí (por si el reloj estuvo caído)', (await correr('2026-11-01T21:40:00-05:00')) >= 1 && (await avisos(jefe)).length === 1);

  // ── 4. Permisos, reloj y down ─────────────────────────────────────────────
  console.log('\n3. Permisos, reloj y reversa');
  const p = await one(`SELECT has_function_privilege('authenticated', 'public.excel_cutoff_alerts(timestamptz)', 'EXECUTE') a, has_function_privilege('authenticated', 'public.crew_request_deadline(timestamptz)', 'EXECUTE') b`);
  check('la app no puede disparar el aviso; sí calcular el corte', !p.a && p.b, p);
  const cron = await one(`SELECT to_regclass('cron.job') IS NOT NULL AS hay`);
  if (cron.hay) check('el reloj «excel-cutoff-alerts» quedó cada 5 min', !!(await one(`SELECT 1 AS x FROM cron.job WHERE jobname = 'excel-cutoff-alerts' AND schedule = '*/5 * * * *'`)));
  else console.log('  · (sin pg_cron en esta base: el reloj no se prueba)');
  await c.query(strip('../down_migrations/0130_corte_de_pedidos.down.sql'));
  const d = await one(`SELECT to_regprocedure('public.excel_cutoff_alerts(timestamptz)') a, to_regprocedure('public.crew_request_deadline(timestamptz)') b,
      (SELECT count(*)::int FROM information_schema.columns WHERE table_name = 'app_settings' AND column_name = 'crew_request_cutoff_min') col`);
  check('el down quita funciones y columna', d.a === null && d.b === null && d.col === 0, d);
} catch (e) {
  fail++; console.log('  ✗ ERROR', e.message, e.where || '');
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok} ✓ · ${fail} ✗`);
process.exit(fail ? 1 : 0);
