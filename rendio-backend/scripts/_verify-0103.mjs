// Verificación de 0103 (el privado: tarifa de $50.000, se cobra en la cuenta de
// cobro, «Directo» fuera de la vitrina) contra la base LOCAL (127.0.0.1:54322),
// con 0069, 0090, 0091, 0094 y 0103 aplicadas.
//
//   cd rendio-backend/scripts && node _verify-0103.mjs
//
// Todo corre dentro de UNA transacción que se deshace (cada escenario en su
// SAVEPOINT): no queda nada en la base. Nunca apunta a dev ni a producción
// (_local-fixtures se niega).
//
// Qué prueba:
//   0. Estructura: columnas kind / reservation_id / trip_on, una fila por reserva,
//      triggers, permisos (todo lo nuevo es interno).
//   1. Tarifa: default 50000; el UPDATE de la migración (leído del archivo) pasa
//      150000 → 50000 y NO toca una tarifa puesta a mano.
//   2. Pedir (la base pone $50.000) → aprobar: la línea nace con el precio
//      CONGELADO (aunque la tarifa haya cambiado), en el mes del viaje, dentro de
//      la cuenta viva; el total, la cuenta del tripulante (extras con kind y la
//      etiqueta), el detalle y la lista del jefe.
//   3. Aprobar dos veces / sincronizar dos veces → una sola línea, mismo monto.
//   4. Cancelar → la línea sale y el monto vuelve; descancelar → vuelve (misma
//      fila). Rechazar → sale; volver a aprobar → vuelve.
//   5. El balance del mes: privateCOP / privateCount aparte de los viajes extra.
//   6. Vacaciones: el privado aprobado NO cuenta como viaje (no se cobra dos
//      veces); rechazado sale en compartido y sí cuenta.
//   7. Viaje de un mes que no ha abierto → pendiente → el reloj lo mete en SU cuenta.
//   8. Cuenta PAGADA: un privado nuevo del mes queda para la siguiente (cargo
//      tardío); cancelar uno que ya estaba en la cuenta pagada NO la cambia.
//   9. Cuenta VENCIDA sin pagar: un privado nuevo va a la siguiente; cancelar uno
//      que estaba adentro SÍ baja lo que debe.
//  10. Comprobante EN REVISIÓN: nada se mueve; al rechazarlo, sale el cancelado y
//      entra el que esperaba.
//  11. Privado aprobado ANTES de 0103 (sin línea): un cambio cualquiera no lo cobra.
//  12. Un jefe crea un privado sin precio: al aprobar se congela la tarifa vigente.
//  13. Borrar la reserva: la línea sale.
//  14. RLS: el tripulante no lee billing_extra_charges directo.
//  15. Directo: apagado y no se puede encender.
//
// NO cubre: la push, pg_cron real, las pantallas (eso lo prueban los
// _smoke-*-dom), ni dos sesiones a la vez.
import fs from 'node:fs';
import { localClient, fixtures, user, asUser } from './_local-fixtures.mjs';

let ok = 0, fail = 0;
const check = (n, cond, det) => {
  if (cond) { ok++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + (typeof det === 'string' ? det : JSON.stringify(det)) : ''}`); }
};

const c = await localClient();
const q = async (s, p) => (await c.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
async function debeFallar(sql, params) {
  await c.query('SAVEPOINT sp_f');
  try { await c.query(sql, params); await c.query('RELEASE SAVEPOINT sp_f'); return null; }
  catch (e) { await c.query('ROLLBACK TO SAVEPOINT sp_f'); return e; }
}
async function asDb() {
  await c.query(`RESET ROLE`);
  await c.query(`SELECT set_config('request.jwt.claims', '', true)`);
}
const BASE = '2026-10-14';                       // corte día 14: período 14-oct → 13-nov, vence 19-oct, pausa 23-oct
const NEXT = '2026-11-14';
async function setToday(iso) { await c.query(`SELECT set_config('rendio.billing_today', $1, true)`, [iso]); }
async function runJob() { await asDb(); return (await one(`SELECT public.billing_run_daily() AS r`)).r; }
const stmt = async (aux, ps) => one(`SELECT * FROM public.billing_statements WHERE auxiliar_profile_id = $1 AND period_start = $2`, [aux, ps]);
const lineas = (res) => q(`SELECT *, trip_on::text AS trip_on_t, source_period_start::text AS ps_t FROM public.billing_extra_charges
                            WHERE kind = 'private' AND reservation_id = $1`, [res]);
const linea = async (res) => (await lineas(res))[0];

await c.query('BEGIN');
try {
  const fx = await fixtures(c);                 // fx.aux en El Olivar (sector Rionegro)
  const jefe = await user(c, fx.org, 'admin', 'Jefa de prueba 0103');
  await setToday('2026-10-15');

  // La camioneta y el privado encendido (dentro de la transacción).
  await q(`UPDATE public.app_settings SET aux_private_enabled = true, aux_private_vehicle_id = $1, aux_private_price_cop = 50000 WHERE id = 'singleton'`, [fx.vehicle]);
  // Cuenta de cobro: mensualidad del sector (Rionegro $170.000, $20.000 por viaje), corte 14.
  await asUser(c, jefe, 'admin');
  await q(`SELECT public.admin_billing_save_sector_rate('Rionegro', 170000, 20000)`);
  await q(`SELECT public.admin_billing_save_account($1, NULL, 14::smallint, 5::smallint, 2::smallint, 3::smallint, true, NULL, $2::date)`, [fx.aux, BASE]);
  await runJob();
  let st = await stmt(fx.aux, BASE);

  // Helpers del privado
  const pedir = async (d) => {                  // como el tripulante: la base pone estado y precio
    await asUser(c, fx.auxUser, 'auxiliar');
    const id = (await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_h2a, required_arrival_at, residence_id, service_level)
      VALUES ($1, 'home_to_airport', 'requested', ($2::timestamp AT TIME ZONE 'America/Bogota'), $3, 'private') RETURNING id`, [fx.aux, d, fx.olivar])).id;
    await asDb();
    return id;
  };
  const compartido = async (d) => (await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_h2a, required_arrival_at, residence_id)
      VALUES ($1, 'home_to_airport', 'requested', ($2::timestamp AT TIME ZONE 'America/Bogota'), $3) RETURNING id`, [fx.aux, d, fx.olivar])).id;
  const decidir = async (id, si, motivo) => {
    await asUser(c, jefe, 'admin');
    const r = (await one(`SELECT public.admin_decide_private($1, $2, $3) r`, [id, si, motivo || null])).r;
    await asDb();
    return r;
  };
  const cancelar = (id) => q(`UPDATE public.reservations SET cancelled_at = now(), status_h2a = 'cancelled' WHERE id = $1`, [id]);
  const descancelar = (id) => q(`UPDATE public.reservations SET cancelled_at = NULL, status_h2a = 'requested' WHERE id = $1`, [id]);
  const miCuenta = async () => { await asUser(c, fx.auxUser, 'auxiliar'); const a = (await one(`SELECT public.aux_billing_my_account() a`)).a; await asDb(); return a; };
  const subirComprobante = async (stId, nombre) => {
    const p = `${fx.org}/${fx.auxUser}/${stId}/${nombre}`;
    await asUser(c, fx.auxUser, 'auxiliar');
    await q(`INSERT INTO storage.objects (bucket_id, name) VALUES ('payment-proofs', $1)`, [p]);
    const x = (await one(`SELECT public.aux_billing_submit_proof($1, $2, 'Nequi', NULL, 'image/jpeg', 2048, NULL) r`, [stId, p])).r;
    await asDb();
    return x.proofId;
  };

  // =========================================================================
  console.log('\n0. Estructura');
  // =========================================================================
  const cols = await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'billing_extra_charges'
                         AND column_name IN ('kind', 'reservation_id', 'trip_on') ORDER BY 1`);
  check('billing_extra_charges tiene kind, reservation_id y trip_on', cols.map(x => x.column_name).join() === 'kind,reservation_id,trip_on', cols);
  const ix = await one(`SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_billing_extra_charges_reservation'`);
  check('una fila por reserva (índice único de kind = private)', ix && /UNIQUE/.test(ix.indexdef) && /reservation_id/.test(ix.indexdef), ix);
  const ixp = await one(`SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_billing_extra_charges_pending'`);
  check('el «uno pendiente por período» de 0094 quedó solo para vacaciones (dos privados del mismo mes no chocan)', ixp && /kind = 'vacation'/.test(ixp.indexdef), ixp);
  const trg = await q(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('tr_reservations_billing_private_ins', 'tr_reservations_billing_private_upd',
                        'tr_reservations_billing_private_del', 'tr_reservations_private_price_fill', 'tr_billing_statements_private_resync') ORDER BY 1`);
  check('los 5 triggers de 0103 existen', trg.length === 5, trg);
  const vacTrg = await q(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.reservations'::regclass AND tgname LIKE 'tr_reservations_billing_vac_%' ORDER BY 1`);
  check('los de vacaciones de 0094 siguen siendo los mismos tres', vacTrg.map(x => x.tgname).join(',') === 'tr_reservations_billing_vac_del,tr_reservations_billing_vac_ins,tr_reservations_billing_vac_upd', vacTrg);
  const internas = ['public.billing_private_sync(uuid,date,boolean)', 'public.billing_private_apply(uuid,uuid,date)', 'public.billing_private_unplace(uuid,date)',
    'public.billing_private_target(uuid,date,date)', 'public.billing_private_label(date,integer)', 'public.billing_statement_kind_cop(uuid,text)',
    'public.billing_statement_kind_json(uuid,text)', 'public.billing_reservation_private_sync()', 'public.billing_reservation_private_delete()',
    'public.billing_statement_private_resync()', 'public.reservations_private_price_fill()', 'public.billing_trips_booked(uuid,date,date)',
    'public.billing_extras_pending_json(uuid)', 'public.billing_open_statement(uuid,date,date)', 'public.billing_vacation_sync(uuid,date,date,boolean)'];
  const pv = await q(`SELECT f, has_function_privilege('authenticated', f, 'EXECUTE') a, has_function_privilege('anon', f, 'EXECUTE') b FROM unnest($1::text[]) f`, [internas]);
  check('las internas NO las ejecuta authenticated ni anon', pv.length === internas.length && pv.every(p => !p.a && !p.b), pv.filter(p => p.a || p.b));
  const bal = await one(`SELECT has_function_privilege('authenticated', 'public.admin_billing_balance(date)', 'EXECUTE') a,
                                has_function_privilege('anon', 'public.admin_billing_balance(date)', 'EXECUTE') b`);
  check('admin_billing_balance: authenticated sí, anon no (como en 0094)', bal.a && !bal.b, bal);

  // =========================================================================
  console.log('\n1. Tarifa: $50.000');
  // =========================================================================
  const def = await one(`SELECT column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'app_settings' AND column_name = 'aux_private_price_cop'`);
  check('el default de aux_private_price_cop es 50000', def && def.column_default === '50000', def);
  const sql = fs.readFileSync(new URL('../supabase/migrations/0103_privado_tarifa_y_cobro.sql', import.meta.url), 'utf8');
  const upd = (sql.match(/UPDATE public\.app_settings SET aux_private_price_cop = 50000 WHERE aux_private_price_cop = 150000;/) || [])[0];
  check('la migración trae el UPDATE que solo toca el valor provisional (150000)', !!upd);
  await c.query('SAVEPOINT esc');
  await q(`UPDATE public.app_settings SET aux_private_price_cop = 150000 WHERE id = 'singleton'`);
  await q(upd);
  check('con el 150000 provisional → queda en 50000', (await one(`SELECT aux_private_price_cop p FROM public.app_settings WHERE id = 'singleton'`)).p === 50000);
  await q(`UPDATE public.app_settings SET aux_private_price_cop = 120000 WHERE id = 'singleton'`);
  await q(upd);
  check('con una tarifa puesta a mano ($120.000) → NO se toca', (await one(`SELECT aux_private_price_cop p FROM public.app_settings WHERE id = 'singleton'`)).p === 120000);
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // =========================================================================
  console.log('\n2. Pedir y aprobar: la línea entra en la cuenta del mes del viaje');
  // =========================================================================
  check('(punto de partida) la cuenta de octubre está abierta en $170.000', st && st.amount_cop === 170000, st && st.amount_cop);
  const p1 = await pedir('2026-10-24 08:00');
  let r = await one(`SELECT price_cop, private_status FROM public.reservations WHERE id = $1`, [p1]);
  check('pedir: la base pone «requested» y el precio vigente ($50.000)', r.private_status === 'requested' && r.price_cop === 50000, r);
  check('pedido (sin decidir): todavía no hay línea de cobro', (await lineas(p1)).length === 0);
  // La tarifa cambia después de pedir: lo pedido no se reescribe.
  await q(`UPDATE public.app_settings SET aux_private_price_cop = 70000 WHERE id = 'singleton'`);
  await decidir(p1, true);
  let x = await linea(p1);
  st = await stmt(fx.aux, BASE);
  check('aprobar → nace UNA línea kind private, 1 × $50.000 (el precio CONGELADO, no los $70.000 de hoy)',
    x && x.trips === 1 && x.per_trip_cop === 50000 && x.amount_cop === 50000 && !x.cancelled_at, x);
  check('…del mes del viaje: trip_on 24-oct, período del 14-oct, dentro de la cuenta viva de octubre',
    x && x.trip_on_t === '2026-10-24' && x.applied_statement_id === st.id && x.ps_t === BASE, x && { t: x.trip_on_t, a: x.applied_statement_id, s: x.ps_t });
  check('la cuenta pasa a $170.000 + $50.000 = $220.000', st.amount_cop === 220000, st.amount_cop);
  let acc = await miCuenta();
  let ex = (acc.current.extras || []).find(e => e.kind === 'private');
  check('mi cuenta: el total a pagar incluye el privado ($220.000)', acc.current.amountDueCOP === 220000 && acc.current.extrasCOP === 50000 && acc.current.baseAmountCOP === 170000, acc.current);
  check('…y trae la línea «Traslado privado · 24 de oct · $50.000» con su reserva y su día', ex && ex.label === 'Traslado privado · 24 de oct · $50.000'
    && ex.reservationId === p1 && ex.tripOn === '2026-10-24' && ex.amountCOP === 50000 && ex.pending === false, ex);
  check('…lo pendiente sigue vacío (y los viajes extra de vacaciones en 0)', acc.extrasPending.amountCOP === 0 && acc.extrasPending.private.count === 0 && acc.extrasPending.totalCOP === 0, acc.extrasPending);
  await asUser(c, jefe, 'admin');
  const det = (await one(`SELECT public.admin_billing_detail($1) d`, [fx.aux])).d;
  const lista = (await one(`SELECT public.admin_billing_list() l`)).l;
  await asDb();
  const fila = lista.find(f => f.auxiliarProfileId === fx.aux);
  check('el jefe: el detalle trae la línea (extraCharges, kind private)', det.extraCharges.some(e => e.kind === 'private' && e.label === 'Traslado privado · 24 de oct · $50.000'), det.extraCharges);
  check('…y la lista, su cuenta de octubre con la misma línea y $220.000', fila.current.amountDueCOP === 220000 && fila.current.extras.some(e => e.kind === 'private'), fila.current && fila.current.extras);
  await q(`UPDATE public.app_settings SET aux_private_price_cop = 50000 WHERE id = 'singleton'`);

  // =========================================================================
  console.log('\n3. Idempotente');
  // =========================================================================
  await decidir(p1, true);
  check('aprobar OTRA vez: sigue una sola línea y la cuenta en $220.000', (await lineas(p1)).length === 1 && (await stmt(fx.aux, BASE)).amount_cop === 220000);
  await q(`SELECT public.billing_private_sync($1, NULL, true)`, [p1]);
  await q(`SELECT public.billing_private_sync($1, NULL, true)`, [p1]);
  check('sincronizar dos veces a mano: una sola línea, mismo monto', (await lineas(p1)).length === 1 && (await stmt(fx.aux, BASE)).amount_cop === 220000);

  // =========================================================================
  console.log('\n4. Cancelar y rechazar: la línea sale sola');
  // =========================================================================
  const x0 = await linea(p1);
  await cancelar(p1);
  x = await linea(p1);
  check('cancelar → la línea queda anulada y la cuenta vuelve a $170.000', x.cancelled_at && (await stmt(fx.aux, BASE)).amount_cop === 170000, { c: x.cancelled_at, amt: (await stmt(fx.aux, BASE)).amount_cop });
  acc = await miCuenta();
  check('…y el tripulante ya no la ve en su cuenta', !(acc.current.extras || []).some(e => e.kind === 'private') && acc.current.amountDueCOP === 170000, acc.current.extras);
  await descancelar(p1);
  x = await linea(p1);
  check('descancelar → vuelve, en la MISMA fila (una por reserva), y la cuenta a $220.000', x.id === x0.id && !x.cancelled_at && (await lineas(p1)).length === 1
    && (await stmt(fx.aux, BASE)).amount_cop === 220000);
  await decidir(p1, false, 'La camioneta tuvo un daño');
  x = await linea(p1);
  check('rechazar (después de aprobado) → sale: $170.000', x.cancelled_at && (await stmt(fx.aux, BASE)).amount_cop === 170000);
  await decidir(p1, true);
  check('volver a aprobar → vuelve: $220.000, una sola fila', !(await linea(p1)).cancelled_at && (await lineas(p1)).length === 1 && (await stmt(fx.aux, BASE)).amount_cop === 220000);

  // =========================================================================
  console.log('\n5. El balance del mes');
  // =========================================================================
  await asUser(c, jefe, 'admin');
  let b = (await one(`SELECT public.admin_billing_balance('2026-10-01') b`)).b;
  await asDb();
  let row = b.rows.find(x2 => x2.auxiliarProfileId === fx.aux);
  check('la fila: privateCOP $50.000, 1 privado, monto $220.000, y NO cuenta como «viajes extra de un cobro anterior»',
    row.privateCOP === 50000 && row.privateCount === 1 && row.amountCOP === 220000 && row.extrasIncludedCOP === 0 && row.privateIncluded[0].kind === 'private', row);
  check('los totales: privateCOP $50.000 · 1 privado · 1 cuenta', b.totals.privateCOP === 50000 && b.totals.privateCount === 1 && b.totals.privateStatements === 1
    && b.totals.extrasIncludedCOP === 0 && b.totals.billedGrossCOP >= 220000, b.totals);

  // =========================================================================
  console.log('\n6. Vacaciones: el privado no se cobra dos veces');
  // =========================================================================
  await c.query('SAVEPOINT esc');
  await compartido('2026-10-20 08:00'); await compartido('2026-10-27 08:00');
  let booked = (await one(`SELECT public.billing_trips_booked($1, $2, '2026-11-13') n`, [fx.aux, BASE])).n;
  check('viajes de vacaciones del cobro: 2 (los compartidos; el privado aprobado no cuenta)', booked === 2, booked);
  await asUser(c, fx.auxUser, 'auxiliar');
  await q(`SELECT public.aux_billing_set_vacation('current', '2026-10-20', '2026-11-05', 1)`);
  await asDb();
  st = await stmt(fx.aux, BASE);
  check('vacaciones de 1 viaje con 2 reservados: 2 × $20.000 + el privado $50.000 = $90.000', st.amount_cop === 90000 && st.vacation_trips === 2, [st.amount_cop, st.vacation_trips]);
  await decidir(p1, false, 'No alcanzó la camioneta');
  st = await stmt(fx.aux, BASE);
  booked = (await one(`SELECT public.billing_trips_booked($1, $2, '2026-11-13') n`, [fx.aux, BASE])).n;
  check('rechazado: sale en compartido y SÍ cuenta (3 viajes) → 3 × $20.000 = $60.000, sin privado', booked === 3 && st.amount_cop === 60000, [booked, st.amount_cop]);
  await decidir(p1, true);
  st = await stmt(fx.aux, BASE);
  check('aprobado otra vez: 2 × $20.000 + $50.000 = $90.000', st.amount_cop === 90000 && st.vacation_trips === 2, [st.amount_cop, st.vacation_trips]);
  await asUser(c, fx.auxUser, 'auxiliar');
  await q(`SELECT public.aux_billing_cancel_vacation('current')`);
  await asDb();
  check('cancelar las vacaciones: vuelve la mensualidad y el privado se queda ($220.000)', (await stmt(fx.aux, BASE)).amount_cop === 220000, (await stmt(fx.aux, BASE)).amount_cop);
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // =========================================================================
  console.log('\n7. Un viaje de un mes que no ha abierto');
  // =========================================================================
  await c.query('SAVEPOINT esc');
  const pNov = await pedir('2026-11-20 08:00');
  await decidir(pNov, true);
  x = await linea(pNov);
  check('privado del 20-nov aprobado hoy (15-oct): queda PENDIENTE para su mes (período del 14-nov)', x && !x.applied_at && !x.cancelled_at
    && x.ps_t === NEXT && x.trip_on_t === '2026-11-20', x && { a: x.applied_at, s: x.ps_t });
  check('…la cuenta de octubre no cambia ($220.000)', (await stmt(fx.aux, BASE)).amount_cop === 220000);
  acc = await miCuenta();
  check('el tripulante lo ve como pendiente: extrasPending.private 1 × $50.000 con su etiqueta (vacaciones en 0)',
    acc.extrasPending.private.count === 1 && acc.extrasPending.private.amountCOP === 50000 && acc.extrasPending.private.items[0].label === 'Traslado privado · 20 de nov · $50.000'
    && acc.extrasPending.amountCOP === 0 && acc.extrasPending.totalCOP === 50000, acc.extrasPending);
  await setToday(NEXT);
  await runJob();
  let stN = await stmt(fx.aux, NEXT);
  x = await linea(pNov);
  check('el reloj abre noviembre con la mensualidad + el privado de noviembre ($220.000), la línea adentro', stN && stN.amount_cop === 220000 && x.applied_statement_id === stN.id, stN && stN.amount_cop);
  await setToday('2026-10-15');
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // =========================================================================
  console.log('\n8. Cuenta PAGADA: no se cambia en silencio');
  // =========================================================================
  await c.query('SAVEPOINT esc');
  st = await stmt(fx.aux, BASE);
  await asUser(c, jefe, 'admin');
  await q(`SELECT public.admin_billing_mark_paid($1, 'Efectivo', NULL, NULL, NULL)`, [st.id]);
  await asDb();
  const p28 = await pedir('2026-10-28 08:00');
  await decidir(p28, true);
  x = await linea(p28);
  st = await stmt(fx.aux, BASE);
  check('octubre pagada + privado del 28-oct aprobado: la cuenta pagada NO cambia ($220.000) y la línea queda pendiente', st.paid_at && st.amount_cop === 220000 && x && !x.applied_at, [st.amount_cop, x && x.applied_at]);
  await cancelar(p1);
  x = await linea(p1);
  check('cancelar el del 24-oct (ya cobrado en la cuenta pagada): la línea se queda y la cuenta no cambia (sin devolución automática)',
    !x.cancelled_at && x.applied_statement_id === st.id && (await stmt(fx.aux, BASE)).amount_cop === 220000, x);
  check('…y ese viaje sigue sin contar para vacaciones (se cobró como privado)', (await one(`SELECT public.billing_trips_booked($1, $2, '2026-11-13') n`, [fx.aux, BASE])).n === 0);
  await setToday(NEXT);
  await runJob();
  stN = await stmt(fx.aux, NEXT);
  check('noviembre abre con la mensualidad + el privado tardío del 28-oct ($220.000), y no el del 24 otra vez', stN && stN.amount_cop === 220000
    && (await linea(p28)).applied_statement_id === stN.id, stN && stN.amount_cop);
  await setToday('2026-10-15');
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // =========================================================================
  console.log('\n9. Cuenta VENCIDA sin pagar');
  // =========================================================================
  await c.query('SAVEPOINT esc');
  await setToday('2026-10-21');                 // vence el 19, pausa el 23
  const p30 = await pedir('2026-10-30 08:00');
  await decidir(p30, true);
  check('vencida: el privado nuevo del 30-oct NO sube lo vencido ($220.000) y queda para el próximo cobro', (await stmt(fx.aux, BASE)).amount_cop === 220000 && !(await linea(p30)).applied_at);
  await cancelar(p1);
  check('cancelar el del 24-oct que estaba adentro: SÍ baja lo que debe ($170.000)', (await linea(p1)).cancelled_at && (await stmt(fx.aux, BASE)).amount_cop === 170000, (await stmt(fx.aux, BASE)).amount_cop);
  await setToday('2026-10-15');
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // =========================================================================
  console.log('\n10. Comprobante en revisión');
  // =========================================================================
  await c.query('SAVEPOINT esc');
  st = await stmt(fx.aux, BASE);
  const proof = await subirComprobante(st.id, 'priv.jpg');
  await cancelar(p1);
  const p26 = await pedir('2026-10-26 08:00');
  await decidir(p26, true);
  st = await stmt(fx.aux, BASE);
  check('en revisión: cancelar uno y aprobar otro NO mueve la cuenta ($220.000)', st.proof_state === 'review' && st.amount_cop === 220000
    && !(await linea(p1)).cancelled_at && !(await linea(p26)).applied_at, [st.proof_state, st.amount_cop]);
  await asUser(c, jefe, 'admin');
  await q(`SELECT public.admin_billing_review_proof($1, false, 'El monto no coincide')`, [proof]);
  await asDb();
  st = await stmt(fx.aux, BASE);
  check('al RECHAZAR el comprobante: sale el cancelado (24) y entra el que esperaba (26): $220.000 con la línea del 26',
    st.amount_cop === 220000 && (await linea(p1)).cancelled_at && (await linea(p26)).applied_statement_id === st.id, { amt: st.amount_cop });
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // =========================================================================
  console.log('\n11. Aprobado antes de 0103');
  // =========================================================================
  await c.query('SAVEPOINT esc');
  const pViejo = await pedir('2026-10-29 08:00');
  await decidir(pViejo, true);
  await q(`DELETE FROM public.billing_extra_charges WHERE reservation_id = $1`, [pViejo]);   // como si se hubiera aprobado antes de 0103
  await q(`UPDATE public.billing_statements SET amount_cop = amount_cop - 50000 WHERE id = $1`, [(await stmt(fx.aux, BASE)).id]);
  await q(`UPDATE public.reservations SET required_arrival_at = ('2026-10-29 10:00'::timestamp AT TIME ZONE 'America/Bogota') WHERE id = $1`, [pViejo]);
  check('un cambio de hora en un privado aprobado SIN línea no lo cobra', (await lineas(pViejo)).length === 0 && (await stmt(fx.aux, BASE)).amount_cop === 220000);
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // =========================================================================
  console.log('\n12. Privado creado por un jefe sin precio');
  // =========================================================================
  await c.query('SAVEPOINT esc');
  await q(`UPDATE public.app_settings SET aux_private_price_cop = 60000 WHERE id = 'singleton'`);
  const pJefe = (await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_h2a, required_arrival_at, residence_id, service_level, private_status)
      VALUES ($1, 'home_to_airport', 'requested', ('2026-11-02 08:00'::timestamp AT TIME ZONE 'America/Bogota'), $2, 'private', 'requested') RETURNING id`, [fx.aux, fx.olivar])).id;
  check('(punto de partida) sin precio', (await one(`SELECT price_cop FROM public.reservations WHERE id = $1`, [pJefe])).price_cop === null);
  await decidir(pJefe, true);
  check('al aprobar se congela la tarifa vigente ($60.000) y la línea la usa', (await one(`SELECT price_cop FROM public.reservations WHERE id = $1`, [pJefe])).price_cop === 60000
    && (await linea(pJefe)).per_trip_cop === 60000 && (await stmt(fx.aux, BASE)).amount_cop === 280000, (await linea(pJefe)));
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // =========================================================================
  console.log('\n13. Borrar la reserva');
  // =========================================================================
  await c.query('SAVEPOINT esc');
  const xid = (await linea(p1)).id;
  await q(`DELETE FROM public.reservations WHERE id = $1`, [p1]);
  const xd = await one(`SELECT * FROM public.billing_extra_charges WHERE id = $1`, [xid]);
  check('borrar la reserva: la línea sale (anulada, sin reserva) y la cuenta vuelve a $170.000', xd.cancelled_at && xd.reservation_id === null && (await stmt(fx.aux, BASE)).amount_cop === 170000, xd);
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // =========================================================================
  console.log('\n14. RLS');
  // =========================================================================
  await asUser(c, fx.auxUser, 'auxiliar');
  const vis = await q(`SELECT id FROM public.billing_extra_charges`);
  await asDb();
  check('el tripulante no lee billing_extra_charges directo (solo por su RPC)', vis.length === 0, vis.length);
  await asUser(c, fx.vecinoUser, 'auxiliar');
  const acc2 = (await one(`SELECT public.aux_billing_my_account() a`)).a;
  await asDb();
  check('la vecina no ve nada del privado de otra (no tiene cuenta)', acc2 === null, acc2);

  // =========================================================================
  console.log('\n15. Directo fuera');
  // =========================================================================
  const dir = await one(`SELECT enabled FROM public.aux_points_rewards WHERE kind = 'direct_trip'`);
  check('el canje «Un traslado Directo» quedó apagado (la fila se conserva)', dir && dir.enabled === false, dir);
  await asUser(c, jefe, 'admin');
  const eDir = await debeFallar(`UPDATE public.aux_points_rewards SET enabled = true WHERE kind = 'direct_trip'`);
  await asDb();
  check('…y ni la jefa lo puede encender', eDir && /aux_points_rewards_no_direct/.test(eDir.message), eDir && eDir.message);
} catch (e) {
  fail++;
  console.error('ERROR inesperado:', e);
} finally {
  await c.query('ROLLBACK');
  await c.end();
}

console.log(`\n${ok} ✓ · ${fail} ✗`);
console.log('NO cubre: la push, pg_cron corriendo de verdad, las pantallas (los _smoke-*-dom) ni dos sesiones a la vez.');
process.exit(fail ? 1 : 0);
