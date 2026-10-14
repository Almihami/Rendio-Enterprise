// Verificación de 0105: la inspección diferida «al cerrar el turno».
// Base LOCAL, en una transacción que se deshace.   cd rendio-backend/scripts && node _verify-0105.mjs
//
// Cubre: la franja que cruza la medianoche; el modo minutos idéntico a 0039; el
// modo al cerrar (sin strike con el turno abierto, strike al cerrar sin
// inspección —por el conductor, el admin o el auto-cierre—, sin strike si la
// hizo antes); que cada turno conserve la regla con que arrancó aunque el jefe
// cambie el modo; y que la base no acepte otro valor.
// NO cubre: el cron de verdad (aquí se llama process_pending_inspections a mano)
// ni PostgREST.
import { localClient, fixtures, user, asUser, asAdminDb } from './_local-fixtures.mjs';
const c = await localClient();
const q = async (s, p) => (await c.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
let ok = 0, fail = 0;
const check = (n, cond, det) => { if (cond) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + det : ''}`); } };
// Un error esperado no puede tumbar la transacción: va dentro de un savepoint.
async function falla(sql, p) {
  await c.query('SAVEPOINT sp');
  try { await c.query(sql, p); await c.query('RELEASE SAVEPOINT sp'); return null; }
  catch (e) { await c.query('ROLLBACK TO SAVEPOINT sp'); return e.message; }
}
const minDesde = (ts) => Math.round((new Date(ts).getTime() - Date.now()) / 60000);

await c.query('BEGIN');
try {
  const fx = await fixtures(c);
  const admin = await user(c, fx.org, 'admin', 'Julián Jefe');
  let n = 0;
  // Cada caso con su conductor y su carro: así un turno abierto no estorba al siguiente.
  async function conductor() {
    n++;
    const uid = await user(c, fx.org, 'driver', `Conductor ${n}`);
    const driver = (await one(`INSERT INTO public.driver_profiles (profile_id) VALUES ($1) RETURNING id`, [uid])).id;
    const vehicle = (await one(`INSERT INTO public.vehicles (organization_id, internal_code, license_plate, current_km, last_maintenance_km)
      VALUES ($1, $2, $3, 1000, 1000) RETURNING id`, [fx.org, `V-${n}`, `RDV${100 + n}`])).id;
    return { uid, driver, vehicle };
  }
  // El conductor arranca con inicio rápido (como lo hace la app: draft + RPC).
  async function arrancaRapido(d) {
    const shift = (await one(`INSERT INTO public.shifts (organization_id, driver_id, vehicle_id, status)
      VALUES ($1, $2, $3, 'vehicle_selected') RETURNING id`, [fx.org, d.driver, d.vehicle])).id;
    await asUser(c, d.uid, 'driver');
    const r = (await one(`SELECT public.start_shift_deferred($1, 1010) AS r`, [shift])).r;
    await asAdminDb(c);
    return { shift, r };
  }
  const turno = (id) => one(`SELECT status::text, inspection_due_at, inspection_at_close, notes FROM public.shifts WHERE id = $1`, [id]);
  const strikes = async (uid) => (await q(`SELECT reason FROM public.driver_strikes WHERE profile_id = $1`, [uid])).map(r => r.reason);
  const procesar = async () => (await one(`SELECT public.process_pending_inspections() AS n`)).n;
  const cierraConductor = async (d, shift) => {
    await asUser(c, d.uid, 'driver');
    await q(`SELECT public.close_shift($1::uuid, 1200)`, [shift]);
    await asAdminDb(c);
  };
  // La inspección como la guarda la app al completar: fila 'initial' + limpiar el plazo.
  const inspecciona = async (d, shift, { limpiar = true } = {}) => {
    await asUser(c, d.uid, 'driver');
    await q(`INSERT INTO public.inspections (organization_id, shift_id, vehicle_id, driver_id, kind, odometer_km, is_apt)
      VALUES ($1, $2, $3, $4, 'initial', 1010, true)`, [fx.org, shift, d.vehicle, d.driver]);
    if (limpiar) await q(`UPDATE public.shifts SET inspection_due_at = NULL WHERE id = $1`, [shift]);
    await asAdminDb(c);
  };
  const ajustes = (cols) => q(`UPDATE public.app_settings SET ${Object.keys(cols).map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = 'singleton'`, Object.values(cols));
  await ajustes({ fast_start_enabled: true, fast_start_from_hour: 0, fast_start_to_hour: 24, inspection_grace_minutes: 90, auto_close_hours: 14, fast_start_deadline: 'minutes' });

  console.log('\n── la franja (fast_start_window_open) ──');
  const fr = async (h, a, b) => (await one(`SELECT public.fast_start_window_open($1, $2, $3) AS v`, [h, a, b])).v;
  const tabla = async (a, b) => { const r = []; for (let h = 0; h < 24; h++) if (await fr(h, a, b)) r.push(h); return r.join(','); };
  check('12 a 16 = 12,13,14,15 (la regla de siempre)', await tabla(12, 16) === '12,13,14,15', await tabla(12, 16));
  check('14 a 2 cruza la medianoche: de 14 a 1', await tabla(14, 2) === '0,1,14,15,16,17,18,19,20,21,22,23', await tabla(14, 2));
  check('0 a 24 = todo el día', (await tabla(0, 24)).split(',').length === 24);
  check('20 a 24 = 20 a 23 (24 es medianoche)', await tabla(20, 24) === '20,21,22,23', await tabla(20, 24));
  check('desde = hasta (12 a 12) sigue vacía, como antes', await tabla(12, 12) === '', await tabla(12, 12));

  const h = Number((await one(`SELECT extract(hour FROM now() AT TIME ZONE 'America/Bogota')::int AS h`)).h);
  {
    const d = await conductor();
    const fuera = { from: (h + 1) % 24, to: ((h + 2) % 24) || 24 };
    await ajustes({ fast_start_from_hour: fuera.from, fast_start_to_hour: fuera.to });
    const shift = (await one(`INSERT INTO public.shifts (organization_id, driver_id, vehicle_id, status) VALUES ($1, $2, $3, 'vehicle_selected') RETURNING id`, [fx.org, d.driver, d.vehicle])).id;
    await asUser(c, d.uid, 'driver');
    const err = await falla(`SELECT public.start_shift_deferred($1, 1010)`, [shift]);
    await asAdminDb(c);
    check(`fuera de la franja (${fuera.from} a ${fuera.to}, son las ${h}) → FAST_START_NOT_ALLOWED_NOW`, /FAST_START_NOT_ALLOWED_NOW/.test(err || ''), err);
    // Una franja que cruza la medianoche y contiene la hora actual.
    const cruza = h >= 2 ? { from: h, to: 1 } : { from: 23, to: h + 1 };
    await ajustes({ fast_start_from_hour: cruza.from, fast_start_to_hour: cruza.to });
    await asUser(c, d.uid, 'driver');
    const err2 = await falla(`SELECT public.start_shift_deferred($1, 1010)`, [shift]);
    await asAdminDb(c);
    check(`franja que cruza la medianoche (${cruza.from} a ${cruza.to}) a las ${h} → arranca`, err2 === null, err2);
    await ajustes({ fast_start_from_hour: 0, fast_start_to_hour: 24 });
  }

  console.log('\n── modo minutos (0039, sin cambios) ──');
  {
    const d = await conductor();
    const { shift, r } = await arrancaRapido(d);
    check('la RPC responde inspection_at_close = false', r.inspection_at_close === false, JSON.stringify(r));
    const t0 = await turno(shift);
    check('plazo = 90 min desde ya', Math.abs(minDesde(t0.inspection_due_at) - 90) <= 1, minDesde(t0.inspection_due_at));
    check('el turno queda marcado en minutos', t0.status === 'active' && t0.inspection_at_close === false, JSON.stringify(t0));
    await procesar();
    check('con el plazo vigente: sin strike', (await strikes(d.uid)).length === 0);
    await q(`UPDATE public.shifts SET inspection_due_at = now() - interval '1 minute' WHERE id = $1`, [shift]);
    await procesar();
    const s = await strikes(d.uid);
    check('vencido con el turno ABIERTO → strike (el de siempre)', s.length === 1 && s[0] === 'No realizó la inspección del turno dentro del plazo', JSON.stringify(s));
    const t1 = await turno(shift);
    check('…limpia el plazo y deja la nota de 0039', t1.inspection_due_at === null && /INSPECCIÓN VENCIDA: strike automático\./.test(t1.notes || ''), JSON.stringify(t1));
    await procesar();
    check('…y no vuelve a castigar', (await strikes(d.uid)).length === 1);
  }
  {
    const d = await conductor();
    const { shift } = await arrancaRapido(d);
    await inspecciona(d, shift, { limpiar: false });
    await q(`UPDATE public.shifts SET inspection_due_at = now() - interval '1 minute' WHERE id = $1`, [shift]);
    await procesar();
    check('minutos: hizo la inspección (aunque el plazo no se limpió) → sin strike', (await strikes(d.uid)).length === 0);
  }
  {
    const d = await conductor();
    const { shift } = await arrancaRapido(d);
    await cierraConductor(d, shift);
    await q(`UPDATE public.shifts SET inspection_due_at = now() - interval '1 minute' WHERE id = $1`, [shift]);
    await procesar();
    check('minutos: cerrado antes del plazo y sin inspección → igual que 0039 (sin strike)', (await strikes(d.uid)).length === 0);
  }

  console.log('\n── modo al cerrar el turno ──');
  await ajustes({ fast_start_deadline: 'shift_close' });
  {
    const d = await conductor();
    const { shift, r } = await arrancaRapido(d);
    check('la RPC responde inspection_at_close = true', r.inspection_at_close === true, JSON.stringify(r));
    const t0 = await turno(shift);
    check('el turno queda marcado «al cerrar»', t0.status === 'active' && t0.inspection_at_close === true, JSON.stringify(t0));
    check('la marca de pendiente es la hora del auto-cierre (14 h)', Math.abs(minDesde(t0.inspection_due_at) - 14 * 60) <= 1, minDesde(t0.inspection_due_at));
    await procesar();
    check('abierto: sin strike', (await strikes(d.uid)).length === 0);
    // Aunque la marca ya haya pasado (el auto-cierre se atrasó): abierto, nada.
    await q(`UPDATE public.shifts SET inspection_due_at = now() - interval '1 hour' WHERE id = $1`, [shift]);
    await procesar();
    check('abierto con la marca ya pasada: TAMPOCO hay strike', (await strikes(d.uid)).length === 0);
    check('…y la inspección sigue pendiente', (await turno(shift)).inspection_due_at !== null);
    await cierraConductor(d, shift);
    check('el conductor cierra (app vieja, sin inspección): todavía sin strike hasta que corra el cron', (await strikes(d.uid)).length === 0);
    const nCron = await procesar();
    const s = await strikes(d.uid);
    check('cerrado sin inspección → strike', s.length === 1 && s[0] === 'El turno se cerró sin la inspección pendiente', JSON.stringify(s));
    check('…process_pending_inspections lo cuenta', nCron >= 1, nCron);
    const t1 = await turno(shift);
    check('…limpia la marca y deja nota', t1.inspection_due_at === null && /INSPECCIÓN NO HECHA AL CERRAR: strike automático\./.test(t1.notes || ''), JSON.stringify(t1));
    await procesar();
    check('…y no vuelve a castigar', (await strikes(d.uid)).length === 1);
  }
  {
    const d = await conductor();
    const { shift } = await arrancaRapido(d);
    await inspecciona(d, shift);
    await cierraConductor(d, shift);
    await procesar();
    check('hizo la inspección antes de cerrar → sin strike', (await strikes(d.uid)).length === 0);
    const insp = (await q(`SELECT kind::text AS k FROM public.inspections WHERE shift_id = $1`, [shift])).map(x => x.k).sort().join(',');
    check('…el turno queda con su inspección inicial y la final del cierre', insp === 'final,initial', insp);
  }
  {
    const d = await conductor();
    const { shift } = await arrancaRapido(d);
    await inspecciona(d, shift, { limpiar: false });
    await cierraConductor(d, shift);
    await procesar();
    check('la hizo pero no se alcanzó a limpiar la marca → sin strike (manda la inspección)', (await strikes(d.uid)).length === 0);
  }
  {
    const d = await conductor();
    const { shift } = await arrancaRapido(d);
    // Turno de hace 15 h que nadie cerró: lo cierra la red de seguridad (0027).
    await q(`UPDATE public.shifts SET start_at = now() - interval '15 hours' WHERE id = $1`, [shift]);
    await q(`SELECT public.auto_close_stale_shifts()`);
    const t = await turno(shift);
    check('el auto-cierre lo cierra', t.status === 'closed' && /CIERRE AUTOMÁTICO/.test(t.notes || ''), JSON.stringify(t));
    await procesar();
    const s = await strikes(d.uid);
    check('auto-cerrado sin inspección → strike (igual que el vencimiento en minutos)', s.length === 1, JSON.stringify(s));
  }
  {
    const d = await conductor();
    const { shift } = await arrancaRapido(d);
    await asUser(c, admin, 'admin');
    await q(`SELECT public.force_close_shift($1, 'prueba')`, [shift]);
    await asAdminDb(c);
    await procesar();
    check('cierre forzado por el admin sin inspección → strike (el admin lo puede anular)', (await strikes(d.uid)).length === 1);
  }

  console.log('\n── el jefe cambia el modo con gente en ruta ──');
  {
    const d = await conductor();
    const { shift } = await arrancaRapido(d);          // arrancó «al cerrar»
    await ajustes({ fast_start_deadline: 'minutes' });
    await q(`UPDATE public.shifts SET inspection_due_at = now() - interval '1 minute' WHERE id = $1`, [shift]);
    await procesar();
    check('arrancó «al cerrar» y el jefe pasó a minutos: abierto, sigue sin strike', (await strikes(d.uid)).length === 0);
    const d2 = await conductor();
    const { shift: s2 } = await arrancaRapido(d2);    // arranca en minutos
    await ajustes({ fast_start_deadline: 'shift_close' });
    await q(`UPDATE public.shifts SET inspection_due_at = now() - interval '1 minute' WHERE id = $1`, [s2]);
    await procesar();
    check('arrancó en minutos y el jefe pasó a «al cerrar»: vence igual (su regla)', (await strikes(d2.uid)).length === 1);
  }

  console.log('\n── la base solo acepta los dos modos ──');
  const err = await falla(`UPDATE public.app_settings SET fast_start_deadline = 'otro' WHERE id = 'singleton'`);
  check('fast_start_deadline = «otro» → rechazado por el CHECK', /app_settings_fast_start_deadline_check/.test(err || ''), err);
  check('un turno normal (sin inicio rápido) nace con inspection_at_close = false',
    (await one(`SELECT column_default AS d FROM information_schema.columns WHERE table_name = 'shifts' AND column_name = 'inspection_at_close'`)).d === 'false');
} catch (e) { fail++; console.error('ERROR', e); }
finally { await c.query('ROLLBACK'); await c.end(); }
console.log(`\n${ok} bien · ${fail} mal`);
process.exit(fail ? 1 : 0);
