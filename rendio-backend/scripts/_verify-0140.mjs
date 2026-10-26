// Verificación de 0140 (entrega de turno) contra la base LOCAL. Pone la base al día
// hasta 0136 y aplica 0140 en una transacción que se deshace.
//
//   cd rendio-backend/scripts && node _verify-0140.mjs
//
// El día de mañana (D), dos carros:
//   Carro 1: Carlos en la mañana → Daniel en la tarde → Carlos en la mañana de D+1.
//   Carro 2: Miguel mañana y tarde (sigue con el carro); D+1 sin Carro 2.
// Qué prueba:
//   1. admin_handovers(D): Carlos → Daniel a las 2:00 p. m.; Miguel «sigue»; Daniel
//      → Carlos a las 2:00 a. m. de D+1; Miguel (tarde) sin definir. Solo jefe.
//   2. admin_set_handover: a un texto («En casa de Julián»), a un jefe, y de vuelta a
//      automático; no a alguien de otra organización; no a nadie.
//   3. driver_my_handovers: a Carlos le sale desde las 12:00 (entrega a Daniel, con
//      su teléfono); a Daniel también (recibe); antes de las 12 y después de las 5 no.
//   4. driver_handover_delivered: «Entregado» marca la hora, avisa a Daniel, se puede
//      deshacer; Daniel no puede marcar la de Carlos; con 8 h de anticipación, no.
//      Cuando Daniel inicia turno queda «recibido».
//   5. handover_alerts: 🔑 a Carlos a las 12:05 (una vez); ⚠️ a los jefes a las
//      2:20 p. m. si nadie marcó; «Hoy dejas el carro: En casa de Julián» a Miguel.
//   6. El reloj queda agendado y el down quita todo.
import { localClient, fixtures, user, asUser } from './_local-fixtures.mjs';
import { cadenaHasta0136, migracion, reversa } from './_local-cadena-0136.mjs';

let ok = 0, fail = 0;
const check = (n, cond, det) => {
  if (cond) { ok++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + (typeof det === 'string' ? det : JSON.stringify(det)) : ''}`); }
};
const c = await localClient();
const q = async (s, p) => (await c.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
const asDb = async () => { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', '', true)`); };
const intento = async (u, role, sql, params) => {
  await asUser(c, u, role);
  await c.query('SAVEPOINT sp_i');
  try { const r = await one(sql, params); await c.query('RELEASE SAVEPOINT sp_i'); return { ok: r }; }
  catch (e) { await c.query('ROLLBACK TO SAVEPOINT sp_i'); return { err: e }; }
  finally { await asDb(); }
};

await c.query('BEGIN');
try {
  await cadenaHasta0136(c);
  await c.query(migracion('0140_entrega_de_turno'));
  await c.query(migracion('0140_entrega_de_turno'));
  check('0140 se aplica encima de 0136 (y se puede volver a correr)', true);

  const fx = await fixtures(c);
  const jefe = await user(c, fx.org, 'admin', 'Camilo prueba 0140');
  const jefe2 = await user(c, fx.org, 'admin', 'Christian prueba 0140');
  await q(`UPDATE public.profiles SET receives_ops_alerts = true WHERE id = $1`, [jefe]);
  const otraOrg = (await one(`INSERT INTO public.organizations (name, slug) VALUES ('Otra 0140', 'otra-0140-' || substr(md5(random()::text), 1, 6)) RETURNING id`)).id;
  const ajeno = await user(c, otraOrg, 'driver', 'Conductor de otra org 0140');
  const conductor = async (name, phone) => {
    const u = await user(c, fx.org, 'driver', name);
    if (phone) await q(`UPDATE public.profiles SET phone = $2 WHERE id = $1`, [u, phone]);
    return { u, d: (await one(`INSERT INTO public.driver_profiles (profile_id) VALUES ($1) RETURNING id`, [u])).id };
  };
  const CARLOS = { u: fx.drvUser, d: fx.driver };
  const MIGUEL = await conductor('Miguel Peña prueba', null);
  const DANIEL = await conductor('Daniel Restrepo prueba', '3105550000');
  const D = (await one(`SELECT ((now() AT TIME ZONE 'America/Bogota')::date + 1)::text d`)).d;
  const D1 = (await one(`SELECT ($1::date + 1)::text d`, [D])).d;
  const at = (dia, hm) => `${dia}T${hm}:00-05:00`;
  const vuelta = async (drv, carro, dia, hm) => (await one(`INSERT INTO public.route_assignments (driver_profile_id, direction, status, planned_start_at, plan_car)
      VALUES ($1, 'home_to_airport', 'planned', $2::timestamptz, $3) RETURNING id`, [drv.d, at(dia, hm), carro])).id;
  await vuelta(CARLOS, 'Carro 1', D, '05:00'); await vuelta(CARLOS, 'Carro 1', D, '09:00');
  await vuelta(MIGUEL, 'Carro 2', D, '06:00');
  await vuelta(DANIEL, 'Carro 1', D, '15:00'); await vuelta(DANIEL, 'Carro 1', D1, '00:40');   // la madrugada es de la tarde de D
  await vuelta(MIGUEL, 'Carro 2', D, '16:00');
  await vuelta(CARLOS, 'Carro 1', D1, '05:00');
  const lista = async (u = jefe) => (await intento(u, 'admin', `SELECT public.admin_handovers($1::date) j`, [D])).ok?.j || [];
  const fila = (l, band, from) => l.find((x) => x.band === band && x.from.id === from);
  const iso = (s) => new Date(s).toISOString();

  // ── 1. Lo automático ────────────────────────────────────────────────────────
  console.log('\n1. admin_handovers (automático)');
  let l = await lista();
  const a1 = fila(l, 'am', CARLOS.u);
  check('Carlos (mañana, Carro 1) → Daniel a las 2:00 p. m.', a1 && a1.to && a1.to.id === DANIEL.u && iso(a1.due_at) === iso(at(D, '14:00')) && a1.car === 'Carro 1' && !a1.manual && !a1.sigue, a1);
  check('con el teléfono de Daniel', a1 && a1.to.phone === '3105550000', a1 && a1.to);
  const a2 = fila(l, 'am', MIGUEL.u);
  check('Miguel (Carro 2) sigue con el carro en la tarde', a2 && a2.sigue === true, a2);
  const p1 = fila(l, 'pm', DANIEL.u);
  check('Daniel (tarde) → Carlos a las 2:00 a. m. del día siguiente', p1 && p1.to && p1.to.id === CARLOS.u && iso(p1.due_at) === iso(at(D1, '02:00')), p1);
  const p2 = fila(l, 'pm', MIGUEL.u);
  check('Miguel (tarde): el día siguiente no tiene Carro 2 → sin definir', p2 && p2.to === null && !p2.sigue, p2);
  check('Carlos no tiene entrega de la tarde (no maneja en la tarde de D)', !fila(l, 'pm', CARLOS.u));
  check('un conductor no ve la lista del jefe', !!(await intento(CARLOS.u, 'driver', `SELECT public.admin_handovers($1::date) j`, [D])).err);

  // ── 2. El jefe corrige ──────────────────────────────────────────────────────
  console.log('\n2. admin_set_handover');
  const set = (from, band, to, text, auto) => intento(jefe, 'admin', `SELECT public.admin_set_handover($1::date, $2, $3, $4, $5, $6) j`, [D, band, from, to, text, !!auto]);
  const s1 = await set(MIGUEL.u, 'pm', null, 'En casa de Julián');
  check('Miguel (tarde) deja el carro «En casa de Julián»', s1.ok && s1.ok.j.to_text === 'En casa de Julián' && s1.ok.j.manual === true, s1.err ? s1.err.message : s1.ok);
  const s2 = await set(CARLOS.u, 'am', jefe2, null);
  check('Carlos (mañana) → a un jefe (Christian)', s2.ok && s2.ok.j.to.id === jefe2 && s2.ok.j.manual === true, s2.err ? s2.err.message : s2.ok);
  const s3 = await set(CARLOS.u, 'am', null, null, true);
  check('«Automático» vuelve a Daniel', s3.ok && s3.ok.j.to.id === DANIEL.u && s3.ok.j.manual === false, s3.err ? s3.err.message : s3.ok);
  check('a alguien de otra organización: no', !!(await set(CARLOS.u, 'am', ajeno, null)).err);
  check('sin nadie y sin texto: no', !!(await set(CARLOS.u, 'am', null, '  ')).err);
  check('para alguien que no es conductor: no', !!(await set(fx.auxUser, 'am', DANIEL.u, null)).err);
  l = await lista();
  check('la lista ya trae lo de Miguel', fila(l, 'pm', MIGUEL.u).to_text === 'En casa de Julián');

  // ── 3. La tarjeta del conductor ─────────────────────────────────────────────
  console.log('\n3. driver_my_handovers');
  const mias = async (u, hm, dia = D) => (await intento(u, 'driver', `SELECT public.driver_my_handovers($1::timestamptz) j`, [at(dia, hm)])).ok?.j || [];
  check('Carlos a las 11:50: todavía nada', (await mias(CARLOS.u, '11:50')).length === 0);
  const c1 = await mias(CARLOS.u, '12:05');
  check('Carlos a las 12:05: «entrega» a Daniel (con su teléfono)', c1.length === 1 && c1[0].role === 'entrega' && c1[0].to.id === DANIEL.u && c1[0].to.phone === '3105550000' && iso(c1[0].show_from) === iso(at(D, '12:00')), c1);
  const d1 = await mias(DANIEL.u, '12:05');
  check('Daniel a las 12:05: «recibe» de Carlos', d1.length === 1 && d1[0].role === 'recibe' && d1[0].from.id === CARLOS.u, d1);
  check('Miguel a las 12:05: nada (sigue con el carro)', (await mias(MIGUEL.u, '12:05')).length === 0);
  check('Carlos a las 17:10 (3 h después): ya no sale', (await mias(CARLOS.u, '17:10')).length === 0);
  const m1 = await mias(MIGUEL.u, '00:10', D1);
  check('Miguel a las 00:10 de D+1: «deja el carro: En casa de Julián»', m1.length === 1 && m1[0].role === 'entrega' && m1[0].to === null && m1[0].to_text === 'En casa de Julián', m1);

  // ── 4. «Entregado» ──────────────────────────────────────────────────────────
  console.log('\n4. driver_handover_delivered');
  const marcar = (u, band, undo, hm) => intento(u, 'driver', `SELECT public.driver_handover_delivered($1::date, $2, $3, $4::timestamptz) j`, [D, band, !!undo, at(D, hm)]);
  check('con 8 h de anticipación: no', /Todavía no es hora/.test(((await marcar(CARLOS.u, 'am', false, '05:30')).err || {}).message || ''));
  check('Daniel no puede marcar la de Carlos', /No tienes entrega/.test(((await marcar(DANIEL.u, 'am', false, '13:50')).err || {}).message || ''));
  const e1 = await marcar(CARLOS.u, 'am', false, '13:50');
  check('Carlos marca «Entregado»', e1.ok && !!e1.ok.j.delivered_at, e1.err && e1.err.message);
  const ok1 = await q(`SELECT profile_id, title FROM public.notification_outbox WHERE dedupe_key LIKE 'entrega-ok:%' AND profile_id = $1`, [DANIEL.u]);
  check('a Daniel le llega «🔑 Carlos Mejía te entregó el carro»', ok1.length === 1 && ok1[0].title === '🔑 Carlos Mejía te entregó el carro', ok1);
  const c2 = await mias(CARLOS.u, '13:55');
  check('la tarjeta de Carlos sigue (con la marca) un rato', c2.length === 1 && !!c2[0].delivered_at, c2);
  const e2 = await marcar(CARLOS.u, 'am', true, '13:56');
  check('«Deshacer» la quita', e2.ok && e2.ok.j.delivered_at === null, e2.err && e2.err.message);
  await marcar(CARLOS.u, 'am', false, '13:57');
  // Daniel inicia turno a las 13:58 → recibido.
  await q(`INSERT INTO public.shifts (organization_id, driver_id, vehicle_id, status, start_at) VALUES ($1, $2, $3, 'active', $4::timestamptz)`, [fx.org, DANIEL.d, fx.vehicle, at(D, '13:58')]);
  l = await lista();
  check('al iniciar turno Daniel, queda «recibido» (13:58)', iso(fila(l, 'am', CARLOS.u).received_at) === iso(at(D, '13:58')), fila(l, 'am', CARLOS.u));

  // ── 5. Los avisos ───────────────────────────────────────────────────────────
  console.log('\n5. handover_alerts');
  await q(`DELETE FROM public.shift_handovers WHERE from_profile = $1 AND band = 'am'`, [CARLOS.u]);   // sin marca otra vez
  const alertas = (dia, hm) => q(`SELECT public.handover_alerts($1::timestamptz)`, [at(dia, hm)]);
  const de = (pref, u) => q(`SELECT title, body, url FROM public.notification_outbox WHERE dedupe_key LIKE $1 AND profile_id = $2`, [pref + ':%', u]);
  await alertas(D, '11:55');
  check('a las 11:55: nada todavía', (await de('entrega', CARLOS.u)).length === 0);
  await alertas(D, '12:05');
  const k1 = await de('entrega', CARLOS.u);
  check('a las 12:05 a Carlos: «🔑 Hoy entregas el carro a Daniel Restrepo»', k1.length === 1 && k1[0].title === '🔑 Hoy entregas el carro a Daniel Restrepo' && k1[0].body.startsWith('A las 2:00 p. m. · Carro 1.'), k1);
  await alertas(D, '12:30');
  check('no se repite', (await de('entrega', CARLOS.u)).length === 1);
  check('a Miguel (sigue) no le llega nada', (await de('entrega', MIGUEL.u)).length === 0);
  await alertas(D, '14:10');
  check('a las 2:10 p. m. sin marca: a los jefes todavía no (15 min)', (await de('entrega-tarde', jefe)).length === 0);
  await alertas(D, '14:20');
  const t1 = await de('entrega-tarde', jefe);
  check('a las 2:20 p. m.: al jefe marcado «⚠️ Carlos Mejía no ha marcado la entrega del carro»', t1.length === 1 && t1[0].title === '⚠️ Carlos Mejía no ha marcado la entrega del carro' && t1[0].url === '/#/operacion', t1);
  check('… y solo al marcado en Personal (Christian no)', (await de('entrega-tarde', jefe2)).length === 0);
  // Sin destinatario: a los jefes no les llega nada (no había a quién entregar).
  await q(`UPDATE public.shift_handovers SET manual = false, to_text = NULL WHERE from_profile = $1 AND band = 'pm'`, [MIGUEL.u]);
  await alertas(D1, '02:20');
  check('sin destinatario: a los jefes no les llega «no ha marcado» (no había a quién)', (await q(`SELECT 1 FROM public.notification_outbox WHERE dedupe_key LIKE $1`, ['entrega-tarde:%:pm:' + MIGUEL.u + ':%'])).length === 0);
  await q(`UPDATE public.shift_handovers SET manual = true, to_text = 'En casa de Julián' WHERE from_profile = $1 AND band = 'pm'`, [MIGUEL.u]);
  await alertas(D1, '00:05');
  const mi = await de('entrega', MIGUEL.u);
  check('a Miguel a las 00:05: «🔑 Hoy dejas el carro: En casa de Julián»', mi.length === 1 && mi[0].title === '🔑 Hoy dejas el carro: En casa de Julián', mi);

  // ── 6. Reloj y down ─────────────────────────────────────────────────────────
  console.log('\n6. Reloj y down');
  const j = await one(`SELECT schedule FROM cron.job WHERE jobname = 'handover-alerts'`).catch(() => null);
  check('handover-alerts cada 5 min', j && j.schedule === '*/5 * * * *', j);
  await c.query(reversa('0140_entrega_de_turno'));
  const d = await one(`SELECT to_regclass('public.shift_handovers') t, to_regprocedure('public.admin_handovers(date)') f, to_regtype('public.handover_row') ty,
      (SELECT count(*) FROM cron.job WHERE jobname = 'handover-alerts')::int jobs,
      (SELECT count(*) FROM information_schema.columns WHERE table_name = 'app_settings' AND column_name LIKE 'handover_%')::int cols`);
  check('el down quita tabla, funciones, tipo, reloj y ajustes', !d.t && !d.f && !d.ty && d.jobs === 0 && d.cols === 0, d);
} catch (e) {
  fail++; console.log('  ✗ ERROR', e.message, e.where || '');
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok} ✓ · ${fail} ✗`);
process.exit(fail ? 1 : 0);
