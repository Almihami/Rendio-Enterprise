// Verificación de 0094 (tarifas por sector, vacaciones y balance) contra la base
// LOCAL (127.0.0.1:54322), con 0090 y 0094 aplicadas.
//
//   cd rendio-backend/scripts && node _verify-0094.mjs
//
// Todo corre dentro de UNA transacción que se deshace (cada escenario en su
// SAVEPOINT): no queda nada en la base. Nunca apunta a dev ni a producción
// (_local-fixtures se niega).
//
// 30-sep-2026: corre contra la base local (Docker). Antes de correrlo con una
// 0094 cambiada, reaplicarla: su down y luego el up (ver el pie de la migración).
//
// Qué prueba:
//   0. Estructura: tablas nuevas con RLS, sector en auxiliar_billing, monto 0
//      permitido, avisos sin cuenta de cobro, permisos de las funciones.
//   1. Sector y tarifa: el de la residencia; el puesto a mano gana; la escritura
//      canónica; mensualidad efectiva propia → sector (sin por defecto); el reloj abre
//      el cobro con la del sector; la lista del jefe lo dice.
//   2. Vacaciones de ESTE cobro: recalcula la cuenta abierta, «cambiar» guarda el
//      monto de antes, cancelar lo devuelve, aviso al jefe (y push), fechas fuera
//      del cobro, viajes fuera de rango, sin valor por viaje, 0 viajes = saldado
//      SOLO en $0 (pago automático, sin quien aprobó, sin «Pago confirmado») que
//      el tripulante no puede tocar y el jefe reabre, en revisión no deja, el
//      descuento no pasa del monto.
//   2b. Vencido y pausado: el tripulante no se quita la pausa con vacaciones; el
//      jefe sí puede. Viajes ya hechos: no se declaran menos. Pagada por una
//      persona + el jefe cancela: la cuenta no se toca y conserva su foto.
//      Valor propio vs sector (crewOwn y «que paguen la del sector»). Ajustar a $0.
//   3. Vacaciones del SIGUIENTE cobro: sin cuenta todavía (aviso con statement_id
//      NULL) y el reloj la abre con viajes × valor (o saldada sola si son 0).
//   4. Balance del mes: totales, modalidad, viajes declarados vs reservados
//      (reservas no canceladas del período) y la marca de «reservó más».
//   5. RLS: el tripulante no lee tarifas ni vacaciones de otros; no escribe
//      directo; el jefe de otra organización no puede nada.
//   6. SE COBRA LA DIFERENCIA (30-sep): reservar de más con la cuenta viva
//      (sube; como tripulante, por el trigger), cancelar (baja, nunca bajo lo
//      declarado), descancelar, cambiar la fecha, el ajuste a mano del jefe se
//      respeta; 0 declarados + reserva (se reabre y vuelve a $0); pagada +
//      reserva de más (cargo pendiente, la cuenta no cambia) → cancelar después
//      del cierre (el cargo baja) → el reloj abre la siguiente con la línea
//      extra → no se cobra dos veces; la siguiente también de vacaciones; en
//      revisión y vencida (pendiente); el aviso «Se sumó…» con dedupe y push;
//      RLS de billing_extra_charges; el balance con declarados · reservados ·
//      cobrados · extra cobrado · extra pendiente · incluido.
//      (revisión 1-oct) 6G: marcar o cambiar vacaciones con el monto igual o más
//      bajo NO avisa «Se sumó…» (antes salía cada vez, con push); cambiarlas no
//      reinicia el dedupe. 6H: el mismo viaje que fue a la cuenta viva y después,
//      ya pagada, queda como cargo pendiente SÍ se avisa («Entra en tu próximo
//      cobro»), una sola vez.
//      (segunda revisión 1-oct) 6A: cancelar por la RPC de la app
//      (auxiliar_cancel_reservation, 0050) y reservar OTRO viaje que deja el
//      mismo monto (no repite el aviso). 6E: al RECHAZAR el comprobante la
//      cuenta se recalcula en ese momento (cancelar en revisión → baja al
//      rechazar; reservar en revisión → entra a esa cuenta, no al próximo
//      cobro). 6I: el descuento del jefe se recorta si el cobro baja y vuelve
//      completo si sube. 6J: un viaje cancelado o movido DESPUÉS de que su cargo
//      entró en la cuenta siguiente baja esa línea si la cuenta sigue viva (sin
//      pagar; también al rechazar su comprobante); pagada, se queda. 6K: el día
//      de corte no se cambia con vacaciones marcadas; sin ellas sí, y las
//      reservas de un período ya cobrado siguen yendo a su cuenta (por fechas).
//   7. SIN MENSUALIDAD POR DEFECTO: aunque la organización tenga una cargada, ya
//      no se usa; sin valor propio ni del sector no se abre cuenta (el reloj, la
//      apertura a mano), la lista dice noValue y el balance withoutValue.
//      7b: con solo «desde el próximo corte» no es «sin valor». 7c: la TRANSICIÓN
//      (los bloques 1.0 y 3b de la migración, leídos del archivo): la primera vez,
//      quien se cobraba con la mensualidad por defecto la recibe como valor
//      propio; quien paga la del sector no; volver a correrla no la repite.
//
// Necesita el paquete `pg` (npm i pg en rendio-backend; hoy no está instalado).
//
// NO cubre: la push real, pg_cron corriendo de verdad, ni pantallas; ni el cambio
// de vuelo de la app (0089, depende de la hora real), ni concurrencia.
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
const BASE = '2026-10-14';                       // corte día 14
const NEXT = '2026-11-14';
async function setToday(iso) { await c.query(`SELECT set_config('rendio.billing_today', $1, true)`, [iso]); }
async function runJob() { await asDb(); return (await one(`SELECT public.billing_run_daily() AS r`)).r; }
const stmt = async (aux, ps) => one(`SELECT * FROM public.billing_statements WHERE auxiliar_profile_id = $1 AND period_start = $2`, [aux, ps]);

await c.query('BEGIN');
try {
  const fx = await fixtures(c);                 // fx.aux vive en El Olivar (sector Rionegro); llano = Llanogrande
  const jefe = await user(c, fx.org, 'admin', 'Jefa de prueba 0094');
  const fx2 = { org: (await one(`INSERT INTO public.organizations (name, slug) VALUES ('Otra org 0094', 'otra-0094-' || substr(md5(random()::text), 1, 6)) RETURNING id`)).id };
  const jefe2 = await user(c, fx2.org, 'admin', 'Jefe de otra org 0094');
  await setToday(BASE);

  // =========================================================================
  console.log('\n0. Estructura');
  // =========================================================================
  const rls = await q(`SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace
                        AND relname IN ('billing_sector_rates', 'auxiliar_billing_vacations', 'billing_extra_charges')`);
  check('las 3 tablas nuevas existen con RLS (tarifas, vacaciones, cargos extra)', rls.length === 3 && rls.every(r => r.relrowsecurity), rls);
  const vt = await one(`SELECT 1 AS x FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'billing_statements' AND column_name = 'vacation_trips'`);
  check('billing_statements.vacation_trips existe (los viajes que cobra una cuenta de vacaciones)', !!vt);
  const trg = await q(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.reservations'::regclass AND tgname LIKE 'tr_reservations_billing_vac_%' ORDER BY 1`);
  check('el trigger de reservations (alta, cambio, borrado) existe', trg.map(x => x.tgname).join(',') === 'tr_reservations_billing_vac_del,tr_reservations_billing_vac_ins,tr_reservations_billing_vac_upd', trg);
  const trg2 = await q(`SELECT tgname, tgrelid::regclass::text t FROM pg_trigger WHERE tgname IN ('tr_billing_statements_vac_resync', 'tr_auxiliar_billing_cut_day_vac') ORDER BY 1`);
  check('(revisión 1-oct) los triggers del recálculo al salir de revisión y del candado del día de corte existen', trg2.length === 2
    && trg2[0].t === 'auxiliar_billing' && trg2[1].t === 'billing_statements', trg2);
  const dr = await one(`SELECT 1 AS x FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'billing_statements' AND column_name = 'discount_requested_cop'`);
  check('(revisión 1-oct) billing_statements.discount_requested_cop existe (el descuento que puso el jefe)', !!dr);
  const rateCols = (await q(`SELECT pg_get_function_arguments('public.billing_rate_of(uuid)'::regprocedure) r`))[0].r;
  check('billing_rate_of ya no trae la mensualidad por defecto de la organización', !/org_default/.test(rateCols) && /monthly_origin/.test(rateCols), rateCols);
  const col = await one(`SELECT 1 AS x FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'auxiliar_billing' AND column_name = 'sector'`);
  check('auxiliar_billing.sector existe', !!col);
  const cols2 = await q(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'
                          AND ((table_name = 'billing_statements' AND column_name = 'vacation_id') OR (table_name = 'billing_payments' AND column_name = 'automatic'))`);
  check('billing_statements.vacation_id (la foto) y billing_payments.automatic existen', cols2.length === 2, cols2);
  const nn = await one(`SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'billing_alerts' AND column_name = 'statement_id'`);
  check('billing_alerts.statement_id acepta NULL (avisos de vacaciones sin cuenta de cobro)', nn && nn.is_nullable === 'YES', nn);
  const internas = ['public.billing_rate_of(uuid)', 'public.billing_trips_booked(uuid,date,date)', 'public.billing_trips_taken(uuid,date,date,date)',
    'public.billing_statement_auto_zero(uuid)', 'public.billing_vacation_set(uuid,text,date,date,integer,text)',
    'public.billing_vacation_cancel(uuid,text,text)', 'public.billing_vacation_reprice(uuid,integer,uuid,date,integer)',
    'public.billing_vacation_settle_zero(uuid,date)', 'public.billing_vacation_unsettle(uuid,date)',
    'public.billing_emit_vacation(public.auxiliar_billing_vacations,text)', 'public.billing_vac_period_json(uuid,date,date)',
    'public.billing_vacation_sync(uuid,date,date,boolean)', 'public.billing_reservation_vac_sync()',
    'public.billing_emit_vac_extra(public.auxiliar_billing_vacations,public.billing_statements,integer,integer,boolean)',
    'public.billing_statement_live(public.billing_statements,date)', 'public.billing_statement_extras_cop(uuid)',
    'public.billing_statement_extras_json(uuid)', 'public.billing_period_extras(uuid,date)', 'public.billing_extras_pending_json(uuid)',
    'public.billing_statement_vac_resync()', 'public.guard_billing_cut_day_vacations()'];
  const pv = await q(`SELECT f, has_function_privilege('authenticated', f, 'EXECUTE') a, has_function_privilege('anon', f, 'EXECUTE') b FROM unnest($1::text[]) f`, [internas]);
  check('las internas NO las ejecuta authenticated ni anon', pv.length === internas.length && pv.every(p => !p.a && !p.b), pv.filter(p => p.a || p.b));
  const app = ['public.aux_billing_set_vacation(text,date,date,integer)', 'public.aux_billing_cancel_vacation(text)', 'public.admin_billing_balance(date)',
    'public.admin_billing_sector_rates()', 'public.admin_billing_save_sector_rate(text,integer,integer)', 'public.admin_billing_set_sector(uuid,text)',
    'public.admin_billing_set_vacation(uuid,text,date,date,integer)', 'public.admin_billing_cancel_vacation(uuid,text)',
    'public.admin_billing_use_sector_rate(text)', 'public.admin_billing_adjust_statement(uuid,integer,integer,text)'];
  const pa = await q(`SELECT f, has_function_privilege('authenticated', f, 'EXECUTE') a, has_function_privilege('anon', f, 'EXECUTE') b FROM unnest($1::text[]) f`, [app]);
  check('las RPC de la app: authenticated sí, anon no', pa.length === app.length && pa.every(p => p.a && !p.b), pa.filter(p => !p.a || p.b));

  // =========================================================================
  console.log('\n1. Sector y tarifa');
  // =========================================================================
  await asUser(c, jefe, 'admin');
  const rr = (await one(`SELECT public.admin_billing_save_sector_rate('rionegro ', 170000, 20000) r`)).r;
  check('guardar «rionegro » toma la escritura de la residencia: «Rionegro»', rr.sector === 'Rionegro' && rr.monthlyCOP === 170000 && rr.perTripCOP === 20000, rr);
  const rr2 = (await one(`SELECT public.admin_billing_save_sector_rate('RIONEGRO', 175000, 20000) r`)).r;
  check('otra escritura del mismo sector ACTUALIZA (no duplica)', rr2.monthlyCOP === 175000 && (await one(`SELECT count(*)::int n FROM public.billing_sector_rates WHERE organization_id = $1`, [fx.org])).n === 1);
  await q(`SELECT public.admin_billing_save_sector_rate('Rionegro', 170000, 20000)`);
  let e = await debeFallar(`SELECT public.admin_billing_save_sector_rate('Rionegro', 0, 20000)`);
  check('valor 0: error claro', e && /de \$1 a \$10\.000\.000/.test(e.message), e && e.message);
  // Cuenta sin valor propio → la del sector.
  await q(`SELECT public.admin_billing_save_account($1, NULL, 14::smallint, 5::smallint, 2::smallint, 3::smallint, true, NULL, $2::date)`, [fx.aux, BASE]);
  await asDb();
  const rt = await one(`SELECT * FROM public.billing_rate_of($1)`, [fx.aux]);
  check('billing_rate_of: sector de la residencia (Rionegro), mensualidad efectiva la del sector', rt.sector_name === 'Rionegro' && rt.sector_origin === 'residence'
    && rt.monthly === 170000 && rt.monthly_origin === 'sector' && rt.sector_per_trip === 20000, rt);
  await runJob();
  let st = await stmt(fx.aux, BASE);
  check('el reloj abre el cobro con la mensualidad del SECTOR ($170.000)', st && st.amount_cop === 170000, st && st.amount_cop);
  await asUser(c, jefe, 'admin');
  let lista = (await one(`SELECT public.admin_billing_list() l`)).l;
  let fila = lista.find(x => x.auxiliarProfileId === fx.aux);
  check('la lista del jefe: sector, de dónde sale, tarifa y monto efectivo', fila.sector === 'Rionegro' && fila.sectorSource === 'residence' && fila.residenceName === 'El Olivar'
    && fila.account.effectiveAmountCOP === 170000 && fila.account.amountSource === 'sector' && fila.sectorRate.perTripCOP === 20000, fila && { s: fila.sector, a: fila.account });
  check('…y las vacaciones de este cobro y del siguiente', fila.vacation && fila.vacation.current.periodStart === BASE && fila.vacation.next.periodStart === NEXT && fila.vacation.current.canChange === true, fila.vacation);
  const ss = (await one(`SELECT public.admin_billing_set_sector($1, 'llanogrande') r`, [fx.aux])).r;
  check('sector a mano: gana sobre la residencia y toma la escritura canónica (Llanogrande)', ss.sector === 'Llanogrande' && ss.sectorSource === 'manual', ss);
  check('…sin tarifa en Llanogrande y sin valor por defecto: sin mensualidad (nunca inventada)', ss.effectiveAmountCOP === null, ss.effectiveAmountCOP);
  st = await stmt(fx.aux, BASE);
  check('cambiar el sector NO toca la cuenta de cobro ya abierta', st.amount_cop === 170000);
  await q(`SELECT public.admin_billing_set_sector($1, NULL)`, [fx.aux]);
  const tr = (await one(`SELECT public.admin_billing_sector_rates() r`)).r;
  const rio = tr.sectors.find(x => x.sector === 'Rionegro');
  check('«Tarifas por sector»: Rionegro y Llanogrande (de las residencias), con tripulantes', !!rio && rio.crew === 2 && rio.perTripCOP === 20000 && tr.sectors.some(x => x.sector === 'Llanogrande'), tr);
  await asDb();

  // Reservas del tripulante en el período (2 vivas + 1 cancelada).
  for (const [d, canc] of [['2026-10-16 08:00', false], ['2026-10-25 17:30', false], ['2026-10-26 09:00', true]]) {
    await q(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_h2a, required_arrival_at, residence_id, cancelled_at)
             VALUES ($1, 'home_to_airport', $3, ($2::timestamp AT TIME ZONE 'America/Bogota'), $4, $5)`,
      [fx.aux, d, canc ? 'cancelled' : 'requested', fx.olivar, canc ? new Date() : null]);
  }
  const booked = (await one(`SELECT public.billing_trips_booked($1, $2, $3) n`, [fx.aux, BASE, '2026-11-13'])).n;
  check('viajes reservados en el cobro: 2 (la cancelada no cuenta)', booked === 2, booked);

  // =========================================================================
  console.log('\n2. Vacaciones de este cobro');
  // =========================================================================
  await c.query('SAVEPOINT esc');
  await asUser(c, fx.auxUser, 'auxiliar');
  let acc = (await one(`SELECT public.aux_billing_my_account() a`)).a;
  check('mi cuenta: sector, valor por viaje y vacaciones (este cobro / el siguiente) con los viajes reservados',
    acc.sector === 'Rionegro' && acc.perTripCOP === 20000 && acc.amountCOP === 170000 && acc.amountSource === 'sector'
    && acc.vacations.current.periodStart === BASE && acc.vacations.current.tripsBooked === 2 && acc.vacations.next.periodStart === NEXT && acc.vacations.current.vacation === null, acc && acc.vacations);
  let r = (await one(`SELECT public.aux_billing_set_vacation('current', '2026-10-20', '2026-11-05', 3) r`)).r;
  await asDb();
  st = await stmt(fx.aux, BASE);
  check('marcar 3 viajes → la cuenta abierta pasa a 3 × $20.000 = $60.000', st.amount_cop === 60000 && r.vacation.totalCOP === 60000 && r.statement.modality === 'vacaciones', { amt: st.amount_cop, r });
  let v = await one(`SELECT * FROM public.auxiliar_billing_vacations WHERE auxiliar_profile_id = $1 AND status = 'active'`, [fx.aux]);
  check('la fila guarda la foto de la tarifa, el sector y el monto de antes ($170.000)', v.per_trip_cop === 20000 && v.sector === 'Rionegro' && v.monthly_before_cop === 170000 && v.set_by === 'aux', v);
  const al = await one(`SELECT * FROM public.billing_alerts WHERE key = 'admVacaciones' AND auxiliar_profile_id = $1`, [fx.aux]);
  check('aviso al jefe «X marcó vacaciones: 3 viajes × $20.000 = $60.000»', al && al.audience === 'admin' && /marcó vacaciones: 3 viajes × \$20\.000 = \$60\.000/.test(al.body), al && al.body);
  const ob = await one(`SELECT count(*)::int n FROM public.notification_outbox o WHERE o.dedupe_key LIKE 'bill:' || $1::text || ':%'`, [al.id]);
  check('…con su push encolada (notification_outbox)', ob.n >= 1, ob);
  await asUser(c, fx.auxUser, 'auxiliar');
  r = (await one(`SELECT public.aux_billing_set_vacation('current', '2026-10-20', '2026-11-05', 1) r`)).r;
  await asDb();
  st = await stmt(fx.aux, BASE);
  const vs = await q(`SELECT status, monthly_before_cop FROM public.auxiliar_billing_vacations WHERE auxiliar_profile_id = $1 ORDER BY (status = 'active')`, [fx.aux]);  // misma transacción: created_at empata
  check('cambiar a 1 viaje con 2 reservados: se cobran los 2 ($40.000: se cobra la diferencia), la anterior cancelada y la nueva conserva el monto de antes',
    st.amount_cop === 40000 && st.vacation_trips === 2 && vs.length === 2 && vs[0].status === 'cancelled' && vs[1].status === 'active' && vs[1].monthly_before_cop === 170000, { amt: st.amount_cop, vt: st.vacation_trips, vs });
  const alAdm = await one(`SELECT body FROM public.billing_alerts WHERE key = 'admVacaciones' AND auxiliar_profile_id = $1 AND payload->>'trips' = '1'`, [fx.aux]);
  check('…y el aviso al jefe lo dice: «Tiene 2 viajes reservados: se cobran los 2.»', alAdm && /1 viaje × \$20\.000 = \$20\.000.*Tiene 2 viajes reservados: se cobran los 2\./.test(alAdm.body), alAdm);
  // Balance: reservó 2, declaró 1 → «tiene extra» (1 viaje, ya cobrado en esta cuenta).
  await asUser(c, jefe, 'admin');
  let bal = (await one(`SELECT public.admin_billing_balance('2026-10-01') b`)).b;
  let fb = bal.rows.find(x => x.auxiliarProfileId === fx.aux);
  check('balance: vacaciones, 1 declarado · 2 reservados · 2 cobrados · extra cobrado $20.000 → tiene extra', fb && fb.modality === 'vacaciones' && fb.tripsDeclared === 1 && fb.tripsBooked === 2
    && fb.tripsBilled === 2 && fb.extraBilledCOP === 20000 && fb.extraPendingCOP === 0 && fb.extraTrips === 1 && fb.extraCOP === 20000 && fb.overBooked === true, fb);
  check('balance: totales con la cuenta de vacaciones (y el extra)', bal.totals.statements >= 1 && bal.totals.vacationsCount === 1 && bal.totals.vacationsNetCOP === 40000 && bal.totals.overBookedCount === 1
    && bal.totals.extraBilledCOP === 20000 && bal.totals.extraPendingCOP === 0, bal.totals);
  check('balance: por sector (Rionegro) y el mes', bal.month === '2026-10-01' && bal.monthEnd === '2026-10-31' && bal.bySector.some(s => s.sector === 'Rionegro' && s.vacationsCount === 1), bal.bySector);
  await asUser(c, fx.auxUser, 'auxiliar');
  e = await debeFallar(`SELECT public.aux_billing_set_vacation('current', '2026-12-01', '2026-12-05', 2)`);
  check('fechas fuera del cobro: error claro', e && /no caen en ese cobro/.test(e.message), e && e.message);
  e = await debeFallar(`SELECT public.aux_billing_set_vacation('current', '2026-10-25', '2026-10-20', 2)`);
  check('fechas al revés: error claro', e && /no puede ser antes de la salida/.test(e.message), e && e.message);
  e = await debeFallar(`SELECT public.aux_billing_set_vacation('current', '2026-10-20', '2026-10-25', 201)`);
  check('201 viajes: error claro', e && /de 0 a 200/.test(e.message), e && e.message);
  e = await debeFallar(`SELECT public.aux_billing_set_vacation('ayer', '2026-10-20', '2026-10-25', 2)`);
  check('período inválido: error claro', e && /este o el siguiente/.test(e.message), e && e.message);
  r = (await one(`SELECT public.aux_billing_cancel_vacation('current') r`)).r;
  await asDb();
  st = await stmt(fx.aux, BASE);
  check('cancelar → vuelve el monto de antes ($170.000) y aviso al jefe', st.amount_cop === 170000 && r.statementTouched === true
    && !!(await one(`SELECT 1 x FROM public.billing_alerts WHERE key = 'admVacCancel' AND auxiliar_profile_id = $1`, [fx.aux])), { amt: st.amount_cop, r });
  await c.query('ROLLBACK TO SAVEPOINT esc');

  await c.query('SAVEPOINT esc');
  await asUser(c, jefe, 'admin');
  await q(`SELECT public.admin_billing_save_sector_rate('Rionegro', 170000, NULL)`);
  await asUser(c, fx.auxUser, 'auxiliar');
  e = await debeFallar(`SELECT public.aux_billing_set_vacation('current', '2026-10-20', '2026-10-25', 2)`);
  check('sin valor por viaje: «Tu sector todavía no tiene valor por viaje; escríbele a Coordinación»', e && e.message === 'Tu sector todavía no tiene valor por viaje; escríbele a Coordinación', e && e.message);
  await asUser(c, jefe, 'admin');
  e = await debeFallar(`SELECT public.admin_billing_set_vacation($1, 'current', '2026-10-20', '2026-10-25', 2)`, [fx.aux]);
  check('…y al jefe le dice dónde cargarlo', e && /no tiene valor por viaje: cárgalo en «Tarifas por sector»/.test(e.message), e && e.message);
  await c.query('ROLLBACK TO SAVEPOINT esc');

  await c.query('SAVEPOINT esc');
  // Sin reservas vivas (con reservas, 0 declarados igual cobra las reservadas: sección 6).
  await q(`UPDATE public.reservations SET cancelled_at = now(), status_h2a = 'cancelled' WHERE auxiliar_profile_id = $1 AND cancelled_at IS NULL`, [fx.aux]);
  await asUser(c, fx.auxUser, 'auxiliar');
  r = (await one(`SELECT public.aux_billing_set_vacation('current', '2026-10-15', '2026-11-13', 0) r`)).r;
  await asDb();
  st = await stmt(fx.aux, BASE);
  let py = await one(`SELECT * FROM public.billing_payments WHERE statement_id = $1`, [st.id]);
  check('0 viajes: cobro de $0 SALDADO solo con pago AUTOMÁTICO «Vacaciones sin viajes»', st.amount_cop === 0 && st.paid_at !== null && py && py.amount_cop === 0
    && py.automatic === true && py.via_label === 'Vacaciones sin viajes' && st.vacation_id !== null, { st: [st.amount_cop, st.paid_at, st.vacation_id], py });
  check('…sin nadie como quien aprobó (paid_by y recorded_by NULL: nunca el propio tripulante)', st.paid_by === null && py.recorded_by === null, { paid_by: st.paid_by, rec: py.recorded_by });
  check('…y sin push de «Pago confirmado» (el aviso fue el de las vacaciones)', !(await one(`SELECT 1 x FROM public.billing_alerts WHERE statement_id = $1 AND key = 'aprobado'`, [st.id])));
  await asUser(c, fx.auxUser, 'auxiliar');
  acc = (await one(`SELECT public.aux_billing_my_account() a`)).a;
  check('mi cuenta: why «zero» (no la puede tocar) y el jefe sí (adminCanChange)', acc.vacations.current.why === 'zero' && acc.vacations.current.canChange === false
    && acc.vacations.current.adminCanChange === true && acc.vacations.current.statementZero === true && acc.current.paidAutomatic === true, acc.vacations.current);
  e = await debeFallar(`SELECT public.aux_billing_cancel_vacation('current')`);
  check('saldada sola: el tripulante NO puede cancelar', e && /quedó en \$0 por tus vacaciones sin viajes/.test(e.message), e && e.message);
  e = await debeFallar(`SELECT public.aux_billing_set_vacation('current', '2026-10-15', '2026-11-13', 2)`);
  check('…ni volver a marcar', e && /quedó en \$0 por tus vacaciones sin viajes/.test(e.message), e && e.message);
  await asUser(c, jefe, 'admin');
  r = (await one(`SELECT public.admin_billing_set_vacation($1, 'current', '2026-10-15', '2026-11-13', 2) r`, [fx.aux])).r;
  await asDb();
  st = await stmt(fx.aux, BASE);
  py = await one(`SELECT * FROM public.billing_payments WHERE statement_id = $1`, [st.id]);
  check('el jefe la REABRE con 2 viajes: $40.000 sin pagar y sin el pago automático', r.reopened === true && st.paid_at === null && st.amount_cop === 40000 && !py && st.status !== 'pagado', { r: r.reopened, st: [st.paid_at, st.amount_cop, st.status], py });
  check('…al tripulante le llega «Coordinación marcó tus vacaciones … 2 viajes × $20.000 = $40.000»', !!(await one(`SELECT 1 x FROM public.billing_alerts WHERE key = 'vacaciones' AND audience = 'aux' AND auxiliar_profile_id = $1 AND body LIKE '%2 viajes × $20.000 = $40.000%'`, [fx.aux])));
  await asUser(c, jefe, 'admin');
  await q(`SELECT public.admin_billing_set_vacation($1, 'current', '2026-10-15', '2026-11-13', 0)`, [fx.aux]);
  r = (await one(`SELECT public.admin_billing_cancel_vacation($1, 'current') r`, [fx.aux])).r;
  await asDb();
  st = await stmt(fx.aux, BASE);
  check('el jefe cancela la saldada sola: se reabre con la mensualidad de antes ($170.000) y vuelve a «mensual»', r.statementTouched === true && r.reopened === true
    && st.paid_at === null && st.amount_cop === 170000 && st.vacation_id === null, { r: [r.statementTouched, r.reopened], st: [st.paid_at, st.amount_cop, st.vacation_id] });
  const vc = await one(`SELECT body FROM public.billing_alerts WHERE key = 'vacCancel' AND audience = 'aux' AND auxiliar_profile_id = $1 ORDER BY created_at DESC LIMIT 1`, [fx.aux]);
  check('…y al tripulante: «Tu cobro de octubre vuelve a la mensualidad»', vc && /vuelve a la mensualidad/.test(vc.body), vc);
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // 2b. Vencido y pausado: nadie se quita la pausa con unas vacaciones.
  await c.query('SAVEPOINT esc');
  await setToday('2026-10-20');                  // vencía el 19
  await asUser(c, fx.auxUser, 'auxiliar');
  e = await debeFallar(`SELECT public.aux_billing_set_vacation('current', '2026-10-20', '2026-11-05', 1)`);
  check('vencido: el tripulante NO marca vacaciones en ese cobro', e && /ya venció/.test(e.message), e && e.message);
  acc = (await one(`SELECT public.aux_billing_my_account() a`)).a;
  check('…su cuenta lo dice (why overdue) y el jefe sí puede (adminCanChange)', acc.vacations.current.why === 'overdue' && acc.vacations.current.adminCanChange === true && acc.vacations.current.statementOverdue === true, acc.vacations.current);
  r = (await one(`SELECT public.aux_billing_set_vacation('next', '2026-11-20', '2026-11-25', 2) r`)).r;
  check('…el SIGUIENTE cobro sí lo puede marcar', r.vacation && r.vacation.periodStart === NEXT, r);
  await setToday('2026-10-23');                  // 14 + 5 + 3 + 1: se pausa
  await runJob();
  await asUser(c, fx.auxUser, 'auxiliar');
  e = await debeFallar(`SELECT public.aux_billing_set_vacation('current', '2026-10-23', '2026-11-13', 0)`);
  await asDb();
  check('pausado: marcar 0 viajes NO salda ni despausa', e && /ya venció/.test(e.message) && (await one(`SELECT public.billing_is_paused($1) p`, [fx.aux])).p === true, e && e.message);
  await asUser(c, jefe, 'admin');
  await q(`SELECT public.admin_billing_set_vacation($1, 'current', '2026-10-23', '2026-11-13', 0)`, [fx.aux]);
  await asDb();
  st = await stmt(fx.aux, BASE);
  check('el jefe marca 0 con 2 reservados: se cobran los 2 ($40.000: se cobra la diferencia) y sigue pausado (no pagó)', st.amount_cop === 40000 && st.vacation_trips === 2 && st.paid_at === null
    && (await one(`SELECT public.billing_is_paused($1) p`, [fx.aux])).p === true, st);
  await q(`UPDATE public.reservations SET cancelled_at = now(), status_h2a = 'cancelled' WHERE auxiliar_profile_id = $1 AND cancelled_at IS NULL`, [fx.aux]);
  await asUser(c, jefe, 'admin');
  await q(`SELECT public.admin_billing_set_vacation($1, 'current', '2026-10-23', '2026-11-13', 0)`, [fx.aux]);
  await asDb();
  st = await stmt(fx.aux, BASE);
  check('sin reservas, el jefe sí puede (su decisión): saldada sola en $0 y se despausa', st.amount_cop === 0 && st.paid_at !== null && (await one(`SELECT public.billing_is_paused($1) p`, [fx.aux])).p === false, st);
  await setToday(BASE);
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // 2b. Viajes ya hechos: no se declaran menos.
  await c.query('SAVEPOINT esc');
  await setToday('2026-10-17');                  // ya pasó la reserva del 16 (vence el 19: no está vencido)
  await asUser(c, fx.auxUser, 'auxiliar');
  acc = (await one(`SELECT public.aux_billing_my_account() a`)).a;
  check('mi cuenta: 1 viaje ya hecho en este cobro (tripsTaken; el de hoy no cuenta)', acc.vacations.current.tripsTaken === 1 && acc.vacations.current.tripsBooked === 2, acc.vacations.current);
  e = await debeFallar(`SELECT public.aux_billing_set_vacation('current', '2026-10-17', '2026-11-05', 0)`);
  check('0 viajes con 1 ya hecho: «Ya hiciste 1 viaje en este cobro: no puedes declarar menos»', e && e.message === 'Ya hiciste 1 viaje en este cobro: no puedes declarar menos', e && e.message);
  r = (await one(`SELECT public.aux_billing_set_vacation('current', '2026-10-17', '2026-11-05', 1) r`)).r;
  check('…1 sí; con 2 reservados se cobran los 2: $40.000', r.statement && r.statement.amountCOP === 40000 && r.statement.vacationTrips === 2, r.statement);
  await asUser(c, jefe, 'admin');
  r = (await one(`SELECT public.admin_billing_set_vacation($1, 'current', '2026-10-17', '2026-11-05', 0) r`, [fx.aux])).r;
  check('…el jefe sí puede declarar 0 (su decisión), pero los 2 reservados se cobran ($40.000, sin pagar)', r.statement && r.statement.amountCOP === 40000 && r.statement.paid === false, r.statement);
  await setToday(BASE);
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // 2b. Pagada por una persona y el jefe cancela: la cuenta no se toca y conserva su foto.
  await c.query('SAVEPOINT esc');
  await asUser(c, fx.auxUser, 'auxiliar');
  await q(`SELECT public.aux_billing_set_vacation('current', '2026-10-20', '2026-11-05', 3)`);
  await asDb();
  st = await stmt(fx.aux, BASE);
  await asUser(c, jefe, 'admin');
  await q(`SELECT public.admin_billing_mark_paid($1, 'Efectivo', NULL, NULL, NULL)`, [st.id]);
  r = (await one(`SELECT public.admin_billing_cancel_vacation($1, 'current') r`, [fx.aux])).r;
  await asDb();
  st = await stmt(fx.aux, BASE);
  check('el jefe cancela con la cuenta YA PAGADA: no se toca ($60.000) y conserva la foto (vacation_id)', r.statementTouched === false && st.paid_at !== null && st.amount_cop === 60000 && st.vacation_id !== null, { r: r.statementTouched, st: [st.amount_cop, st.vacation_id] });
  check('…la cuenta sigue diciendo «vacaciones» (la foto, aunque estén canceladas)', r.statement && r.statement.modality === 'vacaciones' && r.statement.vacation.status === 'cancelled', r.statement);
  const vk = await one(`SELECT body FROM public.billing_alerts WHERE key = 'vacCancel' AND audience = 'aux' AND auxiliar_profile_id = $1`, [fx.aux]);
  check('…y el aviso NO dice «vuelve a la mensualidad»: «ya estaba pagado: no cambia»', vk && /ya estaba pagado: no cambia/.test(vk.body) && !/vuelve a la mensualidad/.test(vk.body), vk);
  await asUser(c, jefe, 'admin');
  bal = (await one(`SELECT public.admin_billing_balance('2026-10-01') b`)).b;
  fb = bal.rows.find(x => x.auxiliarProfileId === fx.aux);
  check('…en el balance sigue «vacaciones» (3 declarados), con la nota de canceladas', fb && fb.modality === 'vacaciones' && fb.tripsDeclared === 3 && fb.vacationStatus === 'cancelled', fb);
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // 2b. Valor propio vs sector.
  await c.query('SAVEPOINT esc');
  await asUser(c, jefe, 'admin');
  await q(`SELECT public.admin_billing_save_account($1, 160000, 14::smallint, 5::smallint, 2::smallint, 3::smallint, true, NULL, $2::date)`, [fx.aux, BASE]);
  let tr2 = (await one(`SELECT public.admin_billing_sector_rates() r`)).r;
  check('«Tarifas por sector»: Rionegro dice 1 con valor propio (crewOwn)', tr2.sectors.find(x => x.sector === 'Rionegro').crewOwn === 1, tr2.sectors.find(x => x.sector === 'Rionegro'));
  e = await debeFallar(`SELECT public.admin_billing_use_sector_rate('Llanogrande')`);
  check('«que paguen la del sector» en un sector SIN mensualidad: no (quedarían sin monto)', e && /no tiene mensualidad/.test(e.message), e && e.message);
  r = (await one(`SELECT public.admin_billing_use_sector_rate('rionegro') r`)).r;
  await asDb();
  const rt2 = await one(`SELECT * FROM public.billing_rate_of($1)`, [fx.aux]);
  check('…en Rionegro: 1 cuenta sin valor propio, ahora paga la del sector ($170.000)', r.cleared === 1 && rt2.own_amount === null && rt2.monthly === 170000 && rt2.monthly_origin === 'sector', { r, rt2 });
  check('…y la cuenta de cobro ya abierta no cambia', (await stmt(fx.aux, BASE)).amount_cop === 170000);
  await asUser(c, jefe, 'admin');
  st = await stmt(fx.aux, BASE);
  e = await debeFallar(`SELECT public.admin_billing_adjust_statement($1, 0, NULL, NULL)`, [st.id]);
  check('ajustar una cuenta a $0: no (una cuenta de $0 abierta pausaría por nada)', e && /mayor que cero/.test(e.message), e && e.message);
  await c.query('ROLLBACK TO SAVEPOINT esc');

  await c.query('SAVEPOINT esc');
  await asUser(c, jefe, 'admin');
  st = await stmt(fx.aux, BASE);
  await q(`SELECT public.admin_billing_adjust_statement($1, NULL, 50000, 'Canje de puntos')`, [st.id]);
  await asUser(c, fx.auxUser, 'auxiliar');
  await q(`SELECT public.aux_billing_set_vacation('current', '2026-10-20', '2026-10-25', 1)`);
  await asDb();
  st = await stmt(fx.aux, BASE);
  const pyd = await one(`SELECT * FROM public.billing_payments WHERE statement_id = $1`, [st.id]);
  check('descuento ($50.000) mayor que el cobro nuevo (2 reservados = $40.000): queda en $40.000 y se salda solo en $0', st.amount_cop === 40000 && st.discount_cop === 40000 && st.paid_at !== null
    && pyd && pyd.automatic === true && pyd.via_label === 'Vacaciones cubiertas por el descuento', { st, pyd });
  await c.query('ROLLBACK TO SAVEPOINT esc');

  await c.query('SAVEPOINT esc');
  st = await stmt(fx.aux, BASE);
  const path = `${fx.org}/${fx.auxUser}/${st.id}/prueba.jpg`;
  await asUser(c, fx.auxUser, 'auxiliar');
  await q(`INSERT INTO storage.objects (bucket_id, name) VALUES ('payment-proofs', $1)`, [path]);
  await q(`SELECT public.aux_billing_submit_proof($1, $2, 'Nequi', NULL, 'image/jpeg', 2048, NULL)`, [st.id, path]);
  e = await debeFallar(`SELECT public.aux_billing_set_vacation('current', '2026-10-20', '2026-10-25', 2)`);
  check('con comprobante en revisión: el tripulante no puede marcar', e && /comprobante en revisión/.test(e.message), e && e.message);
  acc = (await one(`SELECT public.aux_billing_my_account() a`)).a;
  check('…y su cuenta lo dice (canChange false, why review)', acc.vacations.current.canChange === false && acc.vacations.current.why === 'review', acc.vacations.current);
  await asUser(c, jefe, 'admin');
  e = await debeFallar(`SELECT public.admin_billing_set_vacation($1, 'current', '2026-10-20', '2026-10-25', 2)`, [fx.aux]);
  check('…el jefe tampoco (primero aprobar o rechazar)', e && /apruébalo o recházalo primero/.test(e.message), e && e.message);
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // =========================================================================
  console.log('\n3. Vacaciones del siguiente cobro');
  // =========================================================================
  await c.query('SAVEPOINT esc');
  await asUser(c, fx.auxUser, 'auxiliar');
  r = (await one(`SELECT public.aux_billing_set_vacation('next', '2026-11-20', '2026-11-30', 3) r`)).r;
  await asDb();
  check('marcar el siguiente: sin cuenta de cobro todavía', r.statement === null && r.vacation.periodStart === NEXT && r.vacation.totalCOP === 60000, r);
  const al2 = await one(`SELECT * FROM public.billing_alerts WHERE key = 'admVacaciones' AND auxiliar_profile_id = $1`, [fx.aux]);
  check('…el aviso al jefe queda con statement_id NULL', al2 && al2.statement_id === null, al2);
  check('la cuenta de este cobro no cambia', (await stmt(fx.aux, BASE)).amount_cop === 170000);
  await setToday(NEXT);
  await runJob();
  const stN = await stmt(fx.aux, NEXT);
  check('el reloj abre el cobro de noviembre con 3 × $20.000 = $60.000', stN && stN.amount_cop === 60000, stN && stN.amount_cop);
  const sj = (await one(`SELECT public.billing_statement_json(s, $2::date) j FROM public.billing_statements s WHERE s.id = $1`, [stN.id, NEXT])).j;
  check('…y la cuenta de cobro dice su modalidad (vacaciones) con los viajes', sj.modality === 'vacaciones' && sj.vacation.trips === 3, sj.vacation);
  await setToday(BASE);
  await c.query('ROLLBACK TO SAVEPOINT esc');

  await c.query('SAVEPOINT esc');
  await asUser(c, fx.auxUser, 'auxiliar');
  await q(`SELECT public.aux_billing_set_vacation('next', '2026-11-14', '2026-12-13', 0)`);
  await setToday(NEXT);
  await runJob();
  const stZ = await stmt(fx.aux, NEXT);
  const pyZ = stZ && await one(`SELECT * FROM public.billing_payments WHERE statement_id = $1`, [stZ.id]);
  check('siguiente con 0 viajes: el reloj la abre saldada sola en $0 (automático, sin «lista» ni «Pago confirmado»)', stZ && stZ.amount_cop === 0 && stZ.paid_at !== null && stZ.paid_by === null
    && pyZ && pyZ.automatic === true && !(await one(`SELECT 1 x FROM public.billing_alerts WHERE statement_id = $1 AND key IN ('generado', 'aprobado')`, [stZ.id])), { stZ, pyZ });
  await setToday(BASE);
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // =========================================================================
  console.log('\n4. RLS');
  // =========================================================================
  await c.query('SAVEPOINT esc');
  await asUser(c, jefe, 'admin');
  await q(`SELECT public.admin_billing_save_account($1, 160000, 14::smallint, NULL, NULL, NULL, true, NULL, $2::date)`, [fx.vecino, BASE]);
  await q(`SELECT public.admin_billing_set_vacation($1, 'next', '2026-11-20', '2026-11-25', 2)`, [fx.vecino]);
  await asUser(c, fx.auxUser, 'auxiliar');
  const vr = await q(`SELECT sector FROM public.billing_sector_rates`);
  check('el tripulante NO lee la tabla de tarifas', vr.length === 0, vr);
  const vv = await q(`SELECT auxiliar_profile_id FROM public.auxiliar_billing_vacations`);
  check('el tripulante NO ve las vacaciones de otro', vv.every(x => x.auxiliar_profile_id === fx.aux), vv);
  e = await debeFallar(`INSERT INTO public.auxiliar_billing_vacations (organization_id, auxiliar_profile_id, period_start, starts_on, ends_on, trips, per_trip_cop)
                        VALUES ($1, $2, $3, $3, $3, 1, 1)`, [fx.org, fx.aux, NEXT]);
  check('el tripulante NO escribe vacaciones directo', e !== null);
  e = await debeFallar(`SELECT public.admin_billing_balance(NULL)`);
  check('el tripulante NO ve el balance', e && e.code === '42501', e && e.message);
  e = await debeFallar(`SELECT public.admin_billing_set_vacation($1, 'next', '2026-11-20', '2026-11-25', 2)`, [fx.vecino]);
  check('el tripulante NO marca vacaciones de otro', e && e.code === '42501', e && e.message);
  await asUser(c, jefe2, 'admin');
  e = await debeFallar(`SELECT public.admin_billing_set_vacation($1, 'next', '2026-11-20', '2026-11-25', 2)`, [fx.aux]);
  check('el jefe de OTRA organización no marca vacaciones', e && e.code === '42501', e && e.message);
  const t2 = await q(`SELECT id FROM public.billing_sector_rates`);
  check('el jefe de otra organización no ve estas tarifas', t2.length === 0, t2);
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // =========================================================================
  console.log('\n6. Se cobra la diferencia');
  // =========================================================================
  // Reservas de prueba (en hora de Bogotá). Como tripulante: el camino real
  // (RLS + el trigger del facturario, SECURITY DEFINER).
  const reservaComo = async (who, d) => {
    if (who) await asUser(c, who, 'auxiliar'); else await asDb();
    const id = (await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_h2a, required_arrival_at, residence_id)
      VALUES ($1, 'home_to_airport', 'requested', ($2::timestamp AT TIME ZONE 'America/Bogota'), $3) RETURNING id`, [fx.aux, d, fx.olivar])).id;
    await asDb();
    return id;
  };
  const cancelar = (id) => q(`UPDATE public.reservations SET cancelled_at = now(), status_h2a = 'cancelled' WHERE id = $1`, [id]);
  const descancelar = (id) => q(`UPDATE public.reservations SET cancelled_at = NULL, status_h2a = 'requested' WHERE id = $1`, [id]);
  const pendiente = (aux) => one(`SELECT * FROM public.billing_extra_charges WHERE auxiliar_profile_id = $1 AND applied_at IS NULL AND cancelled_at IS NULL`, [aux]);
  const cargos = (aux) => q(`SELECT * FROM public.billing_extra_charges WHERE auxiliar_profile_id = $1 ORDER BY source_period_start, trips`, [aux]);
  const avisosX = (aux) => q(`SELECT * FROM public.billing_alerts WHERE key = 'vacExtra' AND auxiliar_profile_id = $1 ORDER BY (payload->>'tripsBooked')::int`, [aux]);
  const r1025 = (await one(`SELECT id FROM public.reservations WHERE auxiliar_profile_id = $1 AND cancelled_at IS NULL
                             AND (required_arrival_at AT TIME ZONE 'America/Bogota')::date = '2026-10-25'`, [fx.aux])).id;

  // 6A. Cuenta VIVA: sube, baja (nunca bajo lo declarado), descancelar, cambio de fecha, ajuste a mano.
  await c.query('SAVEPOINT esc');
  await asUser(c, fx.auxUser, 'auxiliar');
  await q(`SELECT public.aux_billing_set_vacation('current', '2026-10-20', '2026-11-05', 3)`);
  await asDb();
  st = await stmt(fx.aux, BASE);
  check('viva: 3 declarados con 2 reservados → $60.000 (vacation_trips 3)', st.amount_cop === 60000 && st.vacation_trips === 3, [st.amount_cop, st.vacation_trips]);
  const a3 = await reservaComo(fx.auxUser, '2026-10-28 08:00');
  st = await stmt(fx.aux, BASE);
  check('…reserva (como tripulante) la 3ª: está dentro de lo declarado, no cambia ($60.000) ni avisa', st.amount_cop === 60000 && (await avisosX(fx.aux)).length === 0, st.amount_cop);
  const a4 = await reservaComo(fx.auxUser, '2026-10-30 08:00');
  st = await stmt(fx.aux, BASE);
  let ax = await avisosX(fx.aux);
  check('…la 4ª (de más): la cuenta SUBE a 4 × $20.000 = $80.000', st.amount_cop === 80000 && st.vacation_trips === 4 && st.paid_at === null, [st.amount_cop, st.vacation_trips]);
  check('…aviso «Se sumó $20.000 a tu cuenta: reservaste 4 viajes y declaraste 3. Va en tu cobro de octubre.»', ax.length === 1 && ax[0].audience === 'aux'
    && ax[0].body === 'Se sumó $20.000 a tu cuenta: reservaste 4 viajes y declaraste 3. Va en tu cobro de octubre.' && ax[0].title === 'Viajes de más en tus vacaciones', ax.map(x => x.body));
  const obx = await one(`SELECT count(*)::int n FROM public.notification_outbox o WHERE o.dedupe_key LIKE 'bill:' || $1::text || ':%'`, [ax[0] && ax[0].id]);
  check('…con su push encolada', obx.n === 1, obx);
  const a5 = await reservaComo(null, '2026-11-02 08:00');
  st = await stmt(fx.aux, BASE);
  check('…la 5ª: $100.000 y otro aviso (reservaste 5)', st.amount_cop === 100000 && (await avisosX(fx.aux)).length === 2, st.amount_cop);
  await asUser(c, fx.auxUser, 'auxiliar');
  acc = (await one(`SELECT public.aux_billing_my_account() a`)).a;
  await asDb();
  const vc0 = acc.vacations.current;
  check('mi cuenta: declarados 3 · reservados 5 · cobrados 5 · extra 2 ($40.000, en este cobro) · viva · nada pendiente', vc0.vacation.trips === 3 && vc0.tripsBooked === 5 && vc0.tripsBilled === 5
    && vc0.extraTrips === 2 && vc0.extraBilledCOP === 40000 && vc0.extraPendingCOP === 0 && vc0.freeTrips === 0 && vc0.statementLive === true
    && acc.current.amountCOP === 100000 && acc.extrasPending.amountCOP === 0, vc0);
  await cancelar(a5);
  st = await stmt(fx.aux, BASE);
  check('cancelar la 5ª: BAJA a $80.000 sin aviso nuevo', st.amount_cop === 80000 && (await avisosX(fx.aux)).length === 2, st.amount_cop);
  await descancelar(a5);
  st = await stmt(fx.aux, BASE);
  check('descancelarla: vuelve a $100.000 y NO repite el aviso (dedupe)', st.amount_cop === 100000 && (await avisosX(fx.aux)).length === 2, st.amount_cop);
  // (revisión 1-oct) Cancelar por la RPC de la app (0050) y reservar OTRO viaje
  // que deja el mismo monto: el dedupe es por «reservaste N» (ya se le dijo).
  await asUser(c, fx.auxUser, 'auxiliar');
  await q(`SELECT public.auxiliar_cancel_reservation($1, 'prueba')`, [a5]);
  await asDb();
  st = await stmt(fx.aux, BASE);
  check('cancelar la 5ª por la RPC de la app (auxiliar_cancel_reservation, 0050): BAJA a $80.000', st.amount_cop === 80000 && st.vacation_trips === 4, [st.amount_cop, st.vacation_trips]);
  const a6 = await reservaComo(fx.auxUser, '2026-11-03 08:00');
  st = await stmt(fx.aux, BASE);
  check('…reservar OTRO viaje (vuelve a 5 reservados, $100.000): no repite «Se sumó…» (ya se le dijo «reservaste 5»)', st.amount_cop === 100000 && (await avisosX(fx.aux)).length === 2, st.amount_cop);
  await cancelar(a6);
  await descancelar(a5);
  await cancelar(a5); await cancelar(a4); await cancelar(a3);
  st = await stmt(fx.aux, BASE);
  check('cancelar las 3: vuelve a $60.000 (nunca bajo lo declarado)', st.amount_cop === 60000 && st.vacation_trips === 3, [st.amount_cop, st.vacation_trips]);
  await q(`UPDATE public.reservations SET required_arrival_at = ('2026-11-20 08:00'::timestamp AT TIME ZONE 'America/Bogota') WHERE id = $1`, [r1025]);
  await asUser(c, fx.auxUser, 'auxiliar');
  acc = (await one(`SELECT public.aux_billing_my_account() a`)).a;
  await asDb();
  check('cambiar la fecha de una reserva al otro cobro: aquí quedan 1 reservado, $60.000, y puede reservar 2 más sin que se sume nada (freeTrips)', acc.vacations.current.tripsBooked === 1
    && acc.vacations.current.freeTrips === 2 && (await stmt(fx.aux, BASE)).amount_cop === 60000, acc.vacations.current);
  await asUser(c, jefe, 'admin');
  await q(`SELECT public.admin_billing_adjust_statement($1, 50000, NULL, NULL)`, [st.id]);
  await asDb();
  for (const d of ['2026-10-26 08:00', '2026-10-27 08:00', '2026-10-29 08:00']) await reservaComo(null, d);
  st = await stmt(fx.aux, BASE);
  check('el ajuste a mano del jefe ($50.000) se respeta: 4 reservados (1 de más) → $50.000 + $20.000 = $70.000', st.amount_cop === 70000 && st.vacation_trips === 4, [st.amount_cop, st.vacation_trips]);
  check('con la cuenta viva no queda ningún cargo pendiente', (await cargos(fx.aux)).length === 0);
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // 6B. 0 declarados + reserva: se reabre; cancelarla la vuelve a saldar sola.
  await c.query('SAVEPOINT esc');
  await q(`UPDATE public.reservations SET cancelled_at = now(), status_h2a = 'cancelled' WHERE auxiliar_profile_id = $1 AND cancelled_at IS NULL`, [fx.aux]);
  await asUser(c, fx.auxUser, 'auxiliar');
  await q(`SELECT public.aux_billing_set_vacation('current', '2026-10-15', '2026-11-13', 0)`);
  await asDb();
  st = await stmt(fx.aux, BASE);
  check('0 declarados sin reservas: saldada sola en $0', st.amount_cop === 0 && st.paid_at !== null);
  const z1 = await reservaComo(fx.auxUser, '2026-10-28 08:00');
  st = await stmt(fx.aux, BASE);
  py = await one(`SELECT * FROM public.billing_payments WHERE statement_id = $1`, [st.id]);
  check('…reserva 1: se REABRE con $20.000, sin pagar y sin el pago automático', st.paid_at === null && st.amount_cop === 20000 && st.vacation_trips === 1 && !py && st.status !== 'pagado', { st: [st.paid_at, st.amount_cop, st.status], py });
  ax = await avisosX(fx.aux);
  check('…aviso «Se sumó $20.000 a tu cuenta: reservaste 1 viaje y declaraste 0.»', ax.length === 1 && /^Se sumó \$20\.000 a tu cuenta: reservaste 1 viaje y declaraste 0\./.test(ax[0].body), ax.map(x => x.body));
  await cancelar(z1);
  st = await stmt(fx.aux, BASE);
  py = await one(`SELECT * FROM public.billing_payments WHERE statement_id = $1`, [st.id]);
  check('…cancelarla: vuelve a $0 y se salda sola otra vez', st.amount_cop === 0 && st.paid_at !== null && py && py.automatic === true, { st: [st.amount_cop, st.paid_at], py });
  await setToday('2026-10-20');                  // ya venció: la saldada sola no se reabre
  await reservaComo(null, '2026-10-29 08:00');
  st = await stmt(fx.aux, BASE);
  const pz = await pendiente(fx.aux);
  check('…pasada la fecha límite, reservar NO la reabre: queda cargo pendiente de 1 viaje ($20.000)', st.paid_at !== null && st.amount_cop === 0 && pz && pz.trips === 1 && pz.amount_cop === 20000, { st: [st.paid_at, st.amount_cop], pz });
  await setToday(BASE);
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // 6C. Pagada + reserva de más: cargo pendiente → cancelar después del cierre → el reloj abre la siguiente con la línea extra.
  await c.query('SAVEPOINT esc');
  await asUser(c, fx.auxUser, 'auxiliar');
  await q(`SELECT public.aux_billing_set_vacation('current', '2026-10-20', '2026-11-05', 3)`);
  await asDb();
  st = await stmt(fx.aux, BASE);
  await asUser(c, jefe, 'admin');
  await q(`SELECT public.admin_billing_mark_paid($1, 'Efectivo', NULL, NULL, NULL)`, [st.id]);
  await asDb();
  await reservaComo(fx.auxUser, '2026-10-28 08:00');
  check('pagada: la 3ª reserva está dentro de lo declarado (sin cargo)', !(await pendiente(fx.aux)));
  await reservaComo(fx.auxUser, '2026-10-30 08:00');
  st = await stmt(fx.aux, BASE);
  let pc = await pendiente(fx.aux);
  check('pagada + la 4ª (de más): la cuenta NO cambia ($60.000, pagada) y queda cargo pendiente de 1 × $20.000', st.amount_cop === 60000 && st.paid_at !== null
    && pc && pc.trips === 1 && pc.per_trip_cop === 20000 && pc.amount_cop === 20000 && pc.source_period_start.toISOString().slice(0, 10) === BASE, { st: [st.amount_cop, st.paid_at], pc });
  ax = await avisosX(fx.aux);
  check('…aviso «Se sumó $20.000 a tu cuenta: reservaste 4 viajes y declaraste 3. Entra en tu próximo cobro.»', ax.length === 1
    && ax[0].body === 'Se sumó $20.000 a tu cuenta: reservaste 4 viajes y declaraste 3. Entra en tu próximo cobro.', ax.map(x => x.body));
  const c5 = await reservaComo(null, '2026-11-02 08:00');
  pc = await pendiente(fx.aux);
  check('…la 5ª: el MISMO cargo sube a 2 viajes ($40.000), con su aviso', pc.trips === 2 && pc.amount_cop === 40000 && (await cargos(fx.aux)).length === 1 && (await avisosX(fx.aux)).length === 2, pc);
  await asUser(c, fx.auxUser, 'auxiliar');
  acc = (await one(`SELECT public.aux_billing_my_account() a`)).a;
  const vxs = await q(`SELECT count(*)::int n FROM public.billing_extra_charges`);
  e = await debeFallar(`INSERT INTO public.billing_extra_charges (organization_id, auxiliar_profile_id, source_period_start, trips, per_trip_cop) VALUES ($1, $2, $3, 1, 1)`, [fx.org, fx.aux, NEXT]);
  await asDb();
  check('mi cuenta: extra pendiente para el próximo cobro $40.000 (2 viajes); declarados 3 · reservados 5 · cobrados 3; no viva', acc.extrasPending.amountCOP === 40000 && acc.extrasPending.trips === 2
    && acc.extrasPending.items.length === 1 && acc.vacations.current.tripsBilled === 3 && acc.vacations.current.extraPendingCOP === 40000
    && acc.vacations.current.statementLive === false && acc.vacations.current.freeTrips === 0, { p: acc.extrasPending, v: acc.vacations.current });
  check('RLS: el tripulante NO lee billing_extra_charges directo (solo por su RPC) ni escribe', vxs[0].n === 0 && e !== null, { vxs, e: e && e.message });
  await asUser(c, jefe, 'admin');
  const jx = await q(`SELECT id FROM public.billing_extra_charges`);
  lista = (await one(`SELECT public.admin_billing_list() l`)).l;
  fila = lista.find(x => x.auxiliarProfileId === fx.aux);
  await asUser(c, jefe2, 'admin');
  const jx2 = await q(`SELECT id FROM public.billing_extra_charges`);
  await asDb();
  check('RLS: el jefe de la organización lo lee; el de otra, no', jx.length === 1 && jx2.length === 0, { jx, jx2 });
  check('la lista del jefe: extrasPending $40.000', fila.extrasPending && fila.extrasPending.amountCOP === 40000 && fila.account.noValue === false, fila.extrasPending);
  await setToday('2026-11-13');                  // último día del período (ya cerrado: pagado)
  await cancelar(c5);
  pc = await pendiente(fx.aux);
  check('cancelar después del cierre (antes de la apertura): el cargo BAJA a 1 viaje ($20.000)', pc && pc.trips === 1 && pc.amount_cop === 20000, pc);
  await setToday(NEXT);
  await runJob();
  let stN2 = await stmt(fx.aux, NEXT);
  const ap = (await cargos(fx.aux))[0];
  let sjN = (await one(`SELECT public.billing_statement_json(s, $2::date) j FROM public.billing_statements s WHERE s.id = $1`, [stN2.id, NEXT])).j;
  check('el reloj abre noviembre con la mensualidad + la línea extra: $170.000 + $20.000 = $190.000', stN2.amount_cop === 190000 && sjN.extrasCOP === 20000 && sjN.baseAmountCOP === 170000
    && sjN.extras.length === 1 && sjN.extras[0].label === 'Viajes extra de vacaciones de octubre: 1 × $20.000 = $20.000', { amt: stN2.amount_cop, ex: sjN.extras });
  check('…el cargo queda aplicado a esa cuenta (una sola vez)', ap.applied_statement_id === stN2.id && ap.applied_at !== null && !(await pendiente(fx.aux)));
  await runJob();
  check('correr el reloj otra vez no lo cobra de nuevo', (await stmt(fx.aux, NEXT)).amount_cop === 190000 && (await cargos(fx.aux)).filter(x => !x.cancelled_at).length === 1);
  await descancelar(c5);                        // octubre vuelve a 5 reservados
  pc = await pendiente(fx.aux);
  check('nunca dos veces el mismo viaje: con 5 en octubre (3 en su cuenta + 1 aplicado) queda pendiente SOLO 1 más', pc && pc.trips === 1
    && (await stmt(fx.aux, NEXT)).amount_cop === 190000, pc);
  await cancelar(c5);
  check('…y si lo cancela, ese pendiente se cancela (el aplicado no se toca)', !(await pendiente(fx.aux)) && (await cargos(fx.aux)).filter(x => x.applied_at).length === 1);
  await asUser(c, jefe, 'admin');
  let balO = (await one(`SELECT public.admin_billing_balance('2026-10-01') b`)).b;
  let balN = (await one(`SELECT public.admin_billing_balance('2026-11-01') b`)).b;
  const det = (await one(`SELECT public.admin_billing_detail($1) d`, [fx.aux])).d;
  await asDb();
  const fo = balO.rows.find(x => x.auxiliarProfileId === fx.aux);
  const fn = balN.rows.find(x => x.auxiliarProfileId === fx.aux);
  check('balance de octubre: declarados 3 · reservados 4 · cobrados 4 · extra cobrado $20.000 · pendiente $0 → tiene extra', fo.tripsDeclared === 3 && fo.tripsBooked === 4 && fo.tripsBilled === 4
    && fo.extraBilledCOP === 20000 && fo.extraPendingCOP === 0 && fo.overBooked === true && fo.extrasIncludedCOP === 0 && balO.totals.extraBilledCOP === 20000, fo);
  check('balance de noviembre: la cuenta trae $20.000 de viajes extra de octubre (incluidos en el monto)', fn.extrasIncludedCOP === 20000 && fn.amountCOP === 190000
    && fn.extrasIncluded.length === 1 && balN.totals.extrasIncludedCOP === 20000 && balN.totals.extrasIncludedCount === 1, fn);
  check('detalle del jefe: los cargos extra (el aplicado)', det.extraCharges.length === 1 && det.extraCharges[0].pending === false && det.extraCharges[0].appliedStatementId === stN2.id, det.extraCharges);
  await setToday(BASE);
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // 6D. La siguiente también es de vacaciones: el cargo se suma igual.
  await c.query('SAVEPOINT esc');
  await asUser(c, fx.auxUser, 'auxiliar');
  await q(`SELECT public.aux_billing_set_vacation('current', '2026-10-20', '2026-11-05', 3)`);
  await q(`SELECT public.aux_billing_set_vacation('next', '2026-11-20', '2026-11-25', 2)`);
  await asDb();
  st = await stmt(fx.aux, BASE);
  await asUser(c, jefe, 'admin');
  await q(`SELECT public.admin_billing_mark_paid($1, 'Efectivo', NULL, NULL, NULL)`, [st.id]);
  await asDb();
  await reservaComo(null, '2026-10-28 08:00'); await reservaComo(null, '2026-10-30 08:00');
  check('pagada + 4 reservados con 3 declarados: 1 pendiente', (await pendiente(fx.aux)).trips === 1);
  await setToday(NEXT);
  await runJob();
  let stN3 = await stmt(fx.aux, NEXT);
  let sjN3 = (await one(`SELECT public.billing_statement_json(s, $2::date) j FROM public.billing_statements s WHERE s.id = $1`, [stN3.id, NEXT])).j;
  check('noviembre (también vacaciones, 2 × $20.000) + el extra de octubre ($20.000) = $60.000', stN3.amount_cop === 60000 && sjN3.modality === 'vacaciones' && stN3.vacation_trips === 2
    && sjN3.extrasCOP === 20000 && sjN3.baseAmountCOP === 40000, { amt: stN3.amount_cop, sj: [sjN3.modality, sjN3.extrasCOP] });
  for (const d of ['2026-11-20 08:00', '2026-11-21 08:00', '2026-11-22 08:00']) await reservaComo(fx.auxUser, d);
  stN3 = await stmt(fx.aux, NEXT);
  check('…3 reservados en noviembre (1 de más): sube a $80.000 y el extra de octubre sigue adentro', stN3.amount_cop === 80000 && stN3.vacation_trips === 3
    && (await one(`SELECT public.billing_statement_extras_cop($1) n`, [stN3.id])).n === 20000, [stN3.amount_cop, stN3.vacation_trips]);
  await asUser(c, fx.auxUser, 'auxiliar');
  r = (await one(`SELECT public.aux_billing_cancel_vacation('current') r`)).r;
  await asDb();
  stN3 = await stmt(fx.aux, NEXT);
  check('…cancelar las de noviembre: vuelve la mensualidad ($170.000) + el extra de octubre = $190.000', stN3.amount_cop === 190000 && stN3.vacation_id === null && stN3.vacation_trips === null, [stN3.amount_cop, stN3.vacation_id]);
  await setToday(BASE);
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // 6E. En revisión y vencida: la cuenta no se toca (cargo pendiente); al rechazar, vuelve a estar viva.
  await c.query('SAVEPOINT esc');
  await asUser(c, fx.auxUser, 'auxiliar');
  await q(`SELECT public.aux_billing_set_vacation('current', '2026-10-20', '2026-11-05', 3)`);
  await asDb();
  st = await stmt(fx.aux, BASE);
  const pathR = `${fx.org}/${fx.auxUser}/${st.id}/rev.jpg`;
  await asUser(c, fx.auxUser, 'auxiliar');
  await q(`INSERT INTO storage.objects (bucket_id, name) VALUES ('payment-proofs', $1)`, [pathR]);
  const prf = (await one(`SELECT public.aux_billing_submit_proof($1, $2, 'Nequi', NULL, 'image/jpeg', 2048, NULL) r`, [st.id, pathR])).r;
  await asDb();
  await reservaComo(null, '2026-10-28 08:00'); await reservaComo(null, '2026-10-30 08:00');
  st = await stmt(fx.aux, BASE);
  check('en revisión + 1 de más: la cuenta NO cambia ($60.000) y queda pendiente 1 viaje', st.amount_cop === 60000 && st.proof_state === 'review' && (await pendiente(fx.aux)).trips === 1, [st.amount_cop, st.proof_state]);
  await asUser(c, jefe, 'admin');
  const rj = (await one(`SELECT public.admin_billing_review_proof($1, false, 'El monto no coincide') r`, [prf.proofId])).r;
  await asDb();
  st = await stmt(fx.aux, BASE);
  check('(revisión 1-oct) al RECHAZAR se recalcula en ese momento: 4 × $20.000 = $80.000, el pendiente queda adentro (sin esperar otra reserva)', st.amount_cop === 80000
    && st.vacation_trips === 4 && st.proof_state === 'rejected' && !(await pendiente(fx.aux)) && rj.amountCOP === 80000, { amt: st.amount_cop, vt: st.vacation_trips, rj: rj.amountCOP });
  await reservaComo(null, '2026-11-02 08:00');
  st = await stmt(fx.aux, BASE);
  check('…rechazado (otra vez viva): la siguiente reserva la recalcula con TODO (5 × $20.000 = $100.000) y no queda pendiente', st.amount_cop === 100000 && !(await pendiente(fx.aux)), st.amount_cop);
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // (revisión 1-oct) El caso del revisor: cobra 4 (de 3 declarados), en revisión
  // cancela el 4º; al rechazar NO puede seguir cobrando los 4.
  const subirComprobante = async (stId, nombre) => {
    const p = `${fx.org}/${fx.auxUser}/${stId}/${nombre}`;
    await asUser(c, fx.auxUser, 'auxiliar');
    await q(`INSERT INTO storage.objects (bucket_id, name) VALUES ('payment-proofs', $1)`, [p]);
    const x = (await one(`SELECT public.aux_billing_submit_proof($1, $2, 'Nequi', NULL, 'image/jpeg', 2048, NULL) r`, [stId, p])).r;
    await asDb();
    return x.proofId;
  };
  const rechazar = async (proofId) => { await asUser(c, jefe, 'admin'); await q(`SELECT public.admin_billing_review_proof($1, false, 'El monto no coincide')`, [proofId]); await asDb(); };
  await c.query('SAVEPOINT esc');
  await asUser(c, fx.auxUser, 'auxiliar');
  await q(`SELECT public.aux_billing_set_vacation('current', '2026-10-20', '2026-11-05', 3)`);
  await asDb();
  await reservaComo(null, '2026-10-28 08:00');
  const e4 = await reservaComo(null, '2026-10-30 08:00');
  st = await stmt(fx.aux, BASE);
  check('3 declarados, 4 reservados: $80.000', st.amount_cop === 80000, st.amount_cop);
  let pr1 = await subirComprobante(st.id, 'c1.jpg');
  await cancelar(e4);
  st = await stmt(fx.aux, BASE);
  check('…sube comprobante y cancela el 4º: la cuenta en revisión no se mueve ($80.000) y no queda cargo', st.amount_cop === 80000 && st.proof_state === 'review' && !(await pendiente(fx.aux)), st.amount_cop);
  await rechazar(pr1);
  st = await stmt(fx.aux, BASE);
  check('…al rechazar: vuelve a 3 × $20.000 = $60.000 (no paga un viaje cancelado)', st.amount_cop === 60000 && st.vacation_trips === 3 && st.paid_at === null, [st.amount_cop, st.vacation_trips]);
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // (revisión 1-oct) Al revés: 1 declarado, en revisión reserva el 2º (cargo
  // pendiente); al rechazar entra a ESTA cuenta (no al próximo cobro).
  await c.query('SAVEPOINT esc');
  await cancelar(r1025);                         // queda 1 reservado (el 16)
  await asUser(c, fx.auxUser, 'auxiliar');
  await q(`SELECT public.aux_billing_set_vacation('current', '2026-10-20', '2026-11-05', 1)`);
  await asDb();
  st = await stmt(fx.aux, BASE);
  pr1 = await subirComprobante(st.id, 'c2.jpg');
  await reservaComo(null, '2026-10-28 08:00');
  check('1 declarado, en revisión reserva el 2º: la cuenta no cambia ($20.000) y queda pendiente 1 ($20.000)', (await stmt(fx.aux, BASE)).amount_cop === 20000 && (await pendiente(fx.aux)).trips === 1);
  await rechazar(pr1);
  st = await stmt(fx.aux, BASE);
  await asUser(c, fx.auxUser, 'auxiliar');
  acc = (await one(`SELECT public.aux_billing_my_account() a`)).a;
  await asDb();
  ax = await avisosX(fx.aux);
  check('…al rechazar: ESTA cuenta pasa a $40.000, el pendiente se cancela (nada para el próximo cobro) y su cuenta lo dice (viva, cobrados 2)', st.amount_cop === 40000
    && !(await pendiente(fx.aux)) && acc.extrasPending.amountCOP === 0 && acc.vacations.current.statementLive === true && acc.vacations.current.tripsBilled === 2,
    { amt: st.amount_cop, p: acc.extrasPending, v: acc.vacations.current });
  check('…y el aviso dice a dónde fue ahora: «…Va en tu cobro de octubre.» (el de «Entra en tu próximo cobro» ya había salido)', ax.length === 2
    && ax.some(x => /Entra en tu próximo cobro\.$/.test(x.body)) && ax.some(x => /Va en tu cobro de octubre\.$/.test(x.body)), ax.map(x => x.body));
  await c.query('ROLLBACK TO SAVEPOINT esc');

  await c.query('SAVEPOINT esc');
  await asUser(c, fx.auxUser, 'auxiliar');
  await q(`SELECT public.aux_billing_set_vacation('current', '2026-10-20', '2026-11-05', 3)`);
  await asDb();
  await setToday('2026-10-20');                  // vencida (vencía el 19)
  await reservaComo(null, '2026-10-28 08:00'); await reservaComo(null, '2026-10-30 08:00');
  st = await stmt(fx.aux, BASE);
  check('vencida + 1 de más: la cuenta NO cambia ($60.000) y queda pendiente 1 viaje para el próximo cobro', st.amount_cop === 60000 && st.paid_at === null && (await pendiente(fx.aux)).trips === 1, st.amount_cop);
  await setToday(BASE);
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // 6F. El jefe cancela las vacaciones con la cuenta ya pagada: la foto manda y lo de más se sigue cobrando.
  await c.query('SAVEPOINT esc');
  await asUser(c, fx.auxUser, 'auxiliar');
  await q(`SELECT public.aux_billing_set_vacation('current', '2026-10-20', '2026-11-05', 3)`);
  await asDb();
  st = await stmt(fx.aux, BASE);
  await asUser(c, jefe, 'admin');
  await q(`SELECT public.admin_billing_mark_paid($1, 'Efectivo', NULL, NULL, NULL)`, [st.id]);
  await q(`SELECT public.admin_billing_cancel_vacation($1, 'current')`, [fx.aux]);
  await asDb();
  await reservaComo(null, '2026-10-28 08:00'); await reservaComo(null, '2026-10-30 08:00');
  check('pagada con la foto de 3 viajes y vacaciones canceladas: 4 reservados → 1 pendiente igual', (await pendiente(fx.aux)) && (await pendiente(fx.aux)).trips === 1);
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // 6G. (revisión 1-oct) Marcar o cambiar vacaciones NO avisa «Se sumó…» si lo
  //     cobrado no sube: cambiarlas crea una fila nueva y antes el aviso salía
  //     cada vez (con push), aunque la cuenta bajara.
  const outboxDe = async (aux) => (await one(`SELECT count(*)::int n FROM public.notification_outbox o
      WHERE o.dedupe_key IN (SELECT 'bill:' || a.id::text || ':' || o.profile_id::text FROM public.billing_alerts a
                              WHERE a.key = 'vacExtra' AND a.auxiliar_profile_id = $1)`, [aux])).n;
  await c.query('SAVEPOINT esc');
  await reservaComo(null, '2026-10-28 08:00');  // 3 reservados en octubre (la mensualidad: $170.000)
  await asUser(c, fx.auxUser, 'auxiliar');
  await q(`SELECT public.aux_billing_set_vacation('current', '2026-10-20', '2026-11-05', 1)`);
  await asDb();
  st = await stmt(fx.aux, BASE);
  check('marcar 1 viaje con 3 reservados: la cuenta BAJA de $170.000 a $60.000 (se cobran los 3) y NO sale «Se sumó…»', st.amount_cop === 60000 && st.vacation_trips === 3
    && (await avisosX(fx.aux)).length === 0, [st.amount_cop, (await avisosX(fx.aux)).map(x => x.body)]);
  await asUser(c, fx.auxUser, 'auxiliar');
  await q(`SELECT public.aux_billing_set_vacation('current', '2026-10-20', '2026-11-05', 2)`);
  await q(`SELECT public.aux_billing_set_vacation('current', '2026-10-20', '2026-11-06', 2)`);
  await asDb();
  st = await stmt(fx.aux, BASE);
  check('…cambiar a 2 viajes y después solo la fecha de regreso: el monto sigue en $60.000 y NINGÚN aviso', st.amount_cop === 60000 && (await avisosX(fx.aux)).length === 0
    && (await outboxDe(fx.aux)) === 0, [st.amount_cop, (await avisosX(fx.aux)).map(x => x.body)]);
  const g4 = await reservaComo(fx.auxUser, '2026-10-30 08:00');
  st = await stmt(fx.aux, BASE);
  ax = await avisosX(fx.aux);
  check('…la 4ª reserva SÍ sube lo cobrado ($80.000): UN aviso «Se sumó $20.000 a tu cuenta: reservaste 4 viajes y declaraste 2. Va en tu cobro de octubre.» con su push',
    st.amount_cop === 80000 && ax.length === 1 && ax[0].body === 'Se sumó $20.000 a tu cuenta: reservaste 4 viajes y declaraste 2. Va en tu cobro de octubre.'
    && (await outboxDe(fx.aux)) === 1, [st.amount_cop, ax.map(x => x.body)]);
  check('…la clave del aviso es tripulante + período + reservados + cuenta (sin el id de las vacaciones)',
    ax[0] && ax[0].dedupe_key === `vacx:${fx.aux}:${BASE}:4:${st.id}`, ax[0] && ax[0].dedupe_key);
  await asUser(c, fx.auxUser, 'auxiliar');
  await q(`SELECT public.aux_billing_set_vacation('current', '2026-10-20', '2026-11-06', 3)`);
  await asDb();
  await cancelar(g4); await descancelar(g4);
  st = await stmt(fx.aux, BASE);
  check('…cambiar otra vez las vacaciones (3) y cancelar/descancelar la 4ª: $80.000 y sigue UN solo aviso (cambiarlas no reinicia el dedupe)',
    st.amount_cop === 80000 && (await avisosX(fx.aux)).length === 1 && (await outboxDe(fx.aux)) === 1, [st.amount_cop, (await avisosX(fx.aux)).map(x => x.body)]);
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // 6H. (revisión 1-oct) El mismo viaje primero fue a la cuenta viva y después,
  //     ya pagada, queda como cargo pendiente: ese cargo SÍ se avisa (y dice
  //     «Entra en tu próximo cobro», no «Va en tu cobro de octubre»).
  await c.query('SAVEPOINT esc');
  await asUser(c, fx.auxUser, 'auxiliar');
  await q(`SELECT public.aux_billing_set_vacation('current', '2026-10-20', '2026-11-05', 3)`);
  await asDb();
  await reservaComo(fx.auxUser, '2026-10-28 08:00');
  const h4 = await reservaComo(fx.auxUser, '2026-10-30 08:00');
  st = await stmt(fx.aux, BASE);
  check('viva: la 4ª sube a $80.000 con su aviso «…Va en tu cobro de octubre.»', st.amount_cop === 80000 && (await avisosX(fx.aux)).length === 1
    && /Va en tu cobro de octubre\.$/.test((await avisosX(fx.aux))[0].body), st.amount_cop);
  await cancelar(h4);
  st = await stmt(fx.aux, BASE);
  await asUser(c, jefe, 'admin');
  await q(`SELECT public.admin_billing_mark_paid($1, 'Efectivo', NULL, NULL, NULL)`, [st.id]);
  await asDb();
  check('…la cancela, vuelve a $60.000 y paga $60.000', st.amount_cop === 60000 && (await stmt(fx.aux, BASE)).paid_at !== null, st.amount_cop);
  await descancelar(h4);
  pc = await pendiente(fx.aux);
  ax = await avisosX(fx.aux);
  const axp = ax.filter(x => x.payload && x.payload.live === false);
  check('…la vuelve a reservar ya pagada: cargo pendiente 1 × $20.000 y un SEGUNDO aviso «Se sumó $20.000 a tu cuenta: reservaste 4 viajes y declaraste 3. Entra en tu próximo cobro.»',
    pc && pc.trips === 1 && pc.amount_cop === 20000 && ax.length === 2 && axp.length === 1
    && axp[0].body === 'Se sumó $20.000 a tu cuenta: reservaste 4 viajes y declaraste 3. Entra en tu próximo cobro.'
    && axp[0].dedupe_key === `vacx:${fx.aux}:${BASE}:4:pend` && (await outboxDe(fx.aux)) === 2, { pc, ax: ax.map(x => [x.body, x.dedupe_key]) });
  await cancelar(h4); await descancelar(h4);
  pc = await pendiente(fx.aux);
  check('…cancelar y volver a reservar con el cargo pendiente: el cargo vuelve (1 viaje) y NO repite el aviso', pc && pc.trips === 1 && (await avisosX(fx.aux)).length === 2
    && (await outboxDe(fx.aux)) === 2, { pc, n: (await avisosX(fx.aux)).length });
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // 6I. (revisión 1-oct) El descuento del jefe no se pierde cuando el cobro de
  //     vacaciones baja de él y después vuelve a subir.
  const sjOf = async (id, d) => (await one(`SELECT public.billing_statement_json(s, $2::date) j FROM public.billing_statements s WHERE s.id = $1`, [id, d || BASE])).j;
  await c.query('SAVEPOINT esc');
  await q(`UPDATE public.reservations SET cancelled_at = now(), status_h2a = 'cancelled' WHERE auxiliar_profile_id = $1 AND cancelled_at IS NULL`, [fx.aux]);
  st = await stmt(fx.aux, BASE);
  await asUser(c, jefe, 'admin');
  await q(`SELECT public.admin_billing_adjust_statement($1, NULL, 30000, 'Canje de Rendio Points')`, [st.id]);
  await asUser(c, fx.auxUser, 'auxiliar');
  await q(`SELECT public.aux_billing_set_vacation('current', '2026-10-20', '2026-11-05', 1)`);
  await asDb();
  st = await stmt(fx.aux, BASE);
  let sjD = await sjOf(st.id);
  check('descuento $30.000 y declara 1 viaje ($20.000): se aplica $20.000, queda saldada sola en $0 y el descuento puesto se guarda ($30.000)', st.amount_cop === 20000
    && st.discount_cop === 20000 && st.paid_at !== null && sjD.discountRequestedCOP === 30000 && sjD.discountCOP === 20000, { st: [st.amount_cop, st.discount_cop, st.paid_at], r: sjD.discountRequestedCOP });
  await reservaComo(fx.auxUser, '2026-10-28 08:00');
  await reservaComo(fx.auxUser, '2026-10-30 08:00');
  st = await stmt(fx.aux, BASE);
  check('…reserva 2 viajes: se reabre en $40.000 con el descuento COMPLETO de $30.000 → paga $10.000 (antes $20.000: perdía parte del canje)', st.amount_cop === 40000
    && st.discount_cop === 30000 && st.paid_at === null && st.discount_note === 'Canje de Rendio Points', [st.amount_cop, st.discount_cop, st.paid_at]);
  await asUser(c, fx.auxUser, 'auxiliar');
  await q(`SELECT public.aux_billing_cancel_vacation('current')`);
  await asDb();
  st = await stmt(fx.aux, BASE);
  check('…cancela las vacaciones: vuelve la mensualidad ($170.000) con el descuento de $30.000', st.amount_cop === 170000 && st.discount_cop === 30000, [st.amount_cop, st.discount_cop]);
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // 6J. (revisión 1-oct) Un viaje que se cancela DESPUÉS de que su cargo entró en
  //     la cuenta siguiente: si esa cuenta sigue viva, la línea baja.
  //     Octubre pagado con 2 declarados; el 13-nov a las 6 p. m. un viaje de más.
  const prepOctPagado = async () => {
    await asUser(c, fx.auxUser, 'auxiliar');
    await q(`SELECT public.aux_billing_set_vacation('current', '2026-10-20', '2026-11-05', 2)`);
    await asDb();
    const s0 = await stmt(fx.aux, BASE);
    await asUser(c, jefe, 'admin');
    await q(`SELECT public.admin_billing_mark_paid($1, 'Efectivo', NULL, NULL, NULL)`, [s0.id]);
    await asDb();
    const id = await reservaComo(fx.auxUser, '2026-11-13 18:00');
    await setToday(NEXT);
    await runJob();
    return id;
  };
  await c.query('SAVEPOINT esc');
  let t13 = await prepOctPagado();
  let stN4 = await stmt(fx.aux, NEXT);
  check('octubre pagado (2 declarados) + el viaje del 13-nov: el reloj abre noviembre en $170.000 + $20.000 = $190.000', stN4.amount_cop === 190000, stN4.amount_cop);
  await cancelar(t13);                           // el 14-nov a las 9: vuelo cancelado
  stN4 = await stmt(fx.aux, NEXT);
  let xs = await cargos(fx.aux);
  let sjN4 = await sjOf(stN4.id, NEXT);
  check('…lo cancelan con noviembre todavía viva (sin pagar): noviembre BAJA a $170.000 y la línea extra sale', stN4.amount_cop === 170000 && sjN4.extrasCOP === 0
    && sjN4.extras.length === 0 && stN4.paid_at === null, { amt: stN4.amount_cop, ex: sjN4.extras });
  check('…el cargo queda anulado con la huella de a qué cuenta había entrado (aplicado y cancelado), y no queda pendiente', xs.length === 1 && xs[0].cancelled_at !== null
    && xs[0].applied_statement_id === stN4.id && !(await pendiente(fx.aux)), xs);
  await asUser(c, jefe, 'admin');
  balN = (await one(`SELECT public.admin_billing_balance('2026-11-01') b`)).b;
  balO = (await one(`SELECT public.admin_billing_balance('2026-10-01') b`)).b;
  await asDb();
  check('…en el balance: noviembre ya no trae extra y octubre queda sin extra (2 declarados · 2 reservados · 2 cobrados)', balN.totals.extrasIncludedCOP === 0
    && balO.rows.find(x => x.auxiliarProfileId === fx.aux).extraCOP === 0 && balO.rows.find(x => x.auxiliarProfileId === fx.aux).tripsBilled === 2,
    { n: balN.totals.extrasIncludedCOP, o: balO.rows.find(x => x.auxiliarProfileId === fx.aux) });
  await descancelar(t13);
  stN4 = await stmt(fx.aux, NEXT);
  pc = await pendiente(fx.aux);
  check('…si lo vuelven a reservar: queda como cargo pendiente para el próximo cobro (noviembre no cambia: $170.000) y no repite el aviso', stN4.amount_cop === 170000
    && pc && pc.trips === 1 && (await avisosX(fx.aux)).length === 1, { amt: stN4.amount_cop, pc, n: (await avisosX(fx.aux)).length });
  await setToday(BASE);
  await c.query('ROLLBACK TO SAVEPOINT esc');

  await c.query('SAVEPOINT esc');
  t13 = await prepOctPagado();
  await q(`UPDATE public.reservations SET required_arrival_at = ('2026-11-20 08:00'::timestamp AT TIME ZONE 'America/Bogota') WHERE id = $1`, [t13]);
  stN4 = await stmt(fx.aux, NEXT);
  check('cambiar la fecha de ese viaje a noviembre (14-nov): la línea extra sale y noviembre queda en su mensualidad ($170.000)', stN4.amount_cop === 170000
    && (await one(`SELECT public.billing_statement_extras_cop($1) n`, [stN4.id])).n === 0 && !(await pendiente(fx.aux)), stN4.amount_cop);
  await setToday(BASE);
  await c.query('ROLLBACK TO SAVEPOINT esc');

  await c.query('SAVEPOINT esc');
  t13 = await prepOctPagado();
  stN4 = await stmt(fx.aux, NEXT);
  await asUser(c, jefe, 'admin');
  await q(`SELECT public.admin_billing_mark_paid($1, 'Efectivo', NULL, NULL, NULL)`, [stN4.id]);
  await asDb();
  await cancelar(t13);
  stN4 = await stmt(fx.aux, NEXT);
  xs = await cargos(fx.aux);
  check('con noviembre YA PAGADA ($190.000): cancelar el viaje no la toca y el cargo aplicado se queda (no hay saldo a favor)', stN4.amount_cop === 190000
    && xs.length === 1 && xs[0].cancelled_at === null && xs[0].applied_statement_id === stN4.id, { amt: stN4.amount_cop, xs });
  await setToday(BASE);
  await c.query('ROLLBACK TO SAVEPOINT esc');

  await c.query('SAVEPOINT esc');
  t13 = await prepOctPagado();
  stN4 = await stmt(fx.aux, NEXT);
  const prN = await subirComprobante(stN4.id, 'nov.jpg');
  await cancelar(t13);
  stN4 = await stmt(fx.aux, NEXT);
  check('con noviembre EN REVISIÓN: cancelar el viaje no la toca ($190.000)', stN4.amount_cop === 190000 && stN4.proof_state === 'review', stN4.amount_cop);
  await rechazar(prN);
  stN4 = await stmt(fx.aux, NEXT);
  check('…al rechazar el comprobante de noviembre: vuelve viva y la línea extra sale ($170.000)', stN4.amount_cop === 170000
    && (await one(`SELECT public.billing_statement_extras_cop($1) n`, [stN4.id])).n === 0, stN4.amount_cop);
  await setToday(BASE);
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // 6K. (revisión 1-oct) El día de corte. Con vacaciones marcadas en este cobro o
  //     el siguiente no se cambia; sin vacaciones activas sí, y las reservas de un
  //     período ya cobrado siguen yendo a SU cuenta (por las fechas, no por el corte).
  await c.query('SAVEPOINT esc');
  await asUser(c, fx.auxUser, 'auxiliar');
  await q(`SELECT public.aux_billing_set_vacation('current', '2026-10-20', '2026-11-05', 3)`);
  await asUser(c, jefe, 'admin');
  e = await debeFallar(`SELECT public.admin_billing_save_account($1, NULL, 20::smallint, 5::smallint, 2::smallint, 3::smallint, true, NULL, NULL)`, [fx.aux]);
  check('con vacaciones en este cobro, cambiar el día de corte (14 → 20): «Tiene vacaciones marcadas en el cobro de octubre: cancélalas antes de cambiar el día de corte…»',
    e && e.message === 'Tiene vacaciones marcadas en el cobro de octubre: cancélalas antes de cambiar el día de corte (y márcalas otra vez después)', e && e.message);
  await q(`SELECT public.admin_billing_save_account($1, 165000, 14::smallint, 5::smallint, 2::smallint, 3::smallint, true, NULL, NULL)`, [fx.aux]);
  check('…guardar la cuenta SIN cambiar el corte sí se puede', (await one(`SELECT amount_cop FROM public.auxiliar_billing WHERE auxiliar_profile_id = $1`, [fx.aux])).amount_cop === 165000);
  st = await stmt(fx.aux, BASE);
  await q(`SELECT public.admin_billing_mark_paid($1, 'Efectivo', NULL, NULL, NULL)`, [st.id]);
  await q(`SELECT public.admin_billing_cancel_vacation($1, 'current')`, [fx.aux]);   // pagada: la foto se queda
  await q(`SELECT public.admin_billing_save_account($1, 165000, 20::smallint, 5::smallint, 2::smallint, 3::smallint, true, NULL, NULL)`, [fx.aux]);
  await asDb();
  check('…canceladas (con la cuenta ya pagada), el corte sí cambia a 20', (await one(`SELECT cut_day FROM public.auxiliar_billing WHERE auxiliar_profile_id = $1`, [fx.aux])).cut_day === 20);
  await reservaComo(fx.auxUser, '2026-10-28 08:00');
  await reservaComo(fx.auxUser, '2026-10-30 08:00');
  pc = await pendiente(fx.aux);
  check('…reservas del 28 y 30-oct (4 reservados, foto de 3): van a la cuenta de octubre (14-oct a 13-nov) aunque el corte de hoy diga 20 → cargo pendiente 1',
    pc && pc.trips === 1 && pc.source_period_start.toISOString().slice(0, 10) === BASE, pc);
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // =========================================================================
  console.log('\n7. Sin mensualidad por defecto: sin valor, sin cuenta');
  // =========================================================================
  await c.query('SAVEPOINT esc');
  await q(`INSERT INTO public.billing_settings (organization_id, default_amount_cop) VALUES ($1, 150000)
           ON CONFLICT (organization_id) DO UPDATE SET default_amount_cop = 150000`, [fx.org]);
  await asUser(c, jefe, 'admin');
  await q(`SELECT public.admin_billing_save_account($1, NULL, 14::smallint, NULL, NULL, NULL, true, NULL, $2::date)`, [fx.vecino, BASE]);
  await q(`SELECT public.admin_billing_set_sector($1, 'Llanogrande')`, [fx.vecino]);
  await asDb();
  const rtv = await one(`SELECT * FROM public.billing_rate_of($1)`, [fx.vecino]);
  check('con $150.000 por defecto en la organización, sin valor propio ni del sector: SIN mensualidad (el por defecto ya no se usa)', rtv.monthly === null && rtv.monthly_origin === null, rtv);
  await runJob();
  check('…el reloj NO le abre cuenta de cobro', !(await stmt(fx.vecino, BASE)));
  await asUser(c, jefe, 'admin');
  e = await debeFallar(`SELECT public.admin_billing_open_statement($1)`, [fx.vecino]);
  check('…ni a mano: «Falta el valor: cárgale su valor propio en la cuenta o la mensualidad de su sector en «Tarifas por sector»»', e && e.message === 'Falta el valor: cárgale su valor propio en la cuenta o la mensualidad de su sector en «Tarifas por sector»', e && e.message);
  lista = (await one(`SELECT public.admin_billing_list() l`)).l;
  const fv = lista.find(x => x.auxiliarProfileId === fx.vecino);
  const fa = lista.find(x => x.auxiliarProfileId === fx.aux);
  check('la lista del jefe: noValue (sin valor) y sin monto efectivo; ya no trae defaultAmountCOP', fv.account.noValue === true && fv.account.effectiveAmountCOP === null && !('defaultAmountCOP' in fv.account)
    && fa.account.noValue === false, fv.account);
  bal = (await one(`SELECT public.admin_billing_balance('2026-10-01') b`)).b;
  check('el balance: «1 tripulante sin valor cargado» (withoutValue) y en «sin cuenta de cobro» con el monto vacío', bal.withoutValue === 1
    && bal.withoutStatement.some(x => x.auxiliarProfileId === fx.vecino && x.effectiveAmountCOP === null), { wv: bal.withoutValue, ws: bal.withoutStatement });
  await asUser(c, fx.vecinoUser, 'auxiliar');
  const accv = (await one(`SELECT public.aux_billing_my_account() a`)).a;
  check('el tripulante sin valor: «Todavía no tienes mensualidad registrada» (null)', accv === null, accv);
  await asUser(c, jefe, 'admin');
  await q(`SELECT public.admin_billing_save_account($1, 165000, 14::smallint, NULL, NULL, NULL, true, NULL, $2::date)`, [fx.vecino, BASE]);
  const sv = (await one(`SELECT public.admin_billing_open_statement($1) s`, [fx.vecino])).s;
  check('con su valor propio ($165.000) sí se abre (y por ese valor, no el por defecto)', sv && sv.amountCOP === 165000, sv && sv.amountCOP);
  await asDb();
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // 7b. (revisión 1-oct) Solo «desde el próximo corte» (amount_next_cop, sin
  //     valor de hoy): NO es «sin valor»; el reloj abre con ese.
  await c.query('SAVEPOINT esc');
  await asUser(c, jefe, 'admin');
  await q(`SELECT public.admin_billing_save_account($1, NULL, 14::smallint, NULL, NULL, NULL, true, 160000, $2::date)`, [fx.vecino, BASE]);
  await q(`SELECT public.admin_billing_set_sector($1, 'Llanogrande')`, [fx.vecino]);
  lista = (await one(`SELECT public.admin_billing_list() l`)).l;
  bal = (await one(`SELECT public.admin_billing_balance('2026-10-01') b`)).b;
  await asUser(c, fx.vecinoUser, 'auxiliar');
  const accn = (await one(`SELECT public.aux_billing_my_account() a`)).a;
  await asDb();
  const fvn = lista.find(x => x.auxiliarProfileId === fx.vecino);
  const wsn = bal.withoutStatement.find(x => x.auxiliarProfileId === fx.vecino);
  check('solo con valor desde el próximo corte ($160.000): la lista NO dice «Sin valor», el balance no lo cuenta y el tripulante ve su mensualidad registrada',
    fvn.account.noValue === false && bal.withoutValue === 0 && wsn && wsn.noValue === false && accn && accn.amountNextCOP === 160000,
    { nv: fvn.account.noValue, wv: bal.withoutValue, ws: wsn, acc: accn && accn.amountNextCOP });
  await runJob();
  const stv = await stmt(fx.vecino, BASE);
  check('…y el reloj le abre la cuenta con ese valor ($160.000)', stv && stv.amount_cop === 160000, stv && stv.amount_cop);
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // 7c. (revisión 1-oct) TRANSICIÓN: el código de la migración (bloques 1.0 y
  //     3b, leídos del archivo tal cual) le pone la mensualidad por defecto como
  //     valor propio a quien se cobraba con ella, solo la primera vez.
  const { readFileSync } = await import('node:fs');
  const mig = readFileSync(new URL('../supabase/migrations/0094_tarifas_sector_vacaciones.sql', import.meta.url), 'utf8');
  const bloque = (desde) => { const i = mig.indexOf(desde); const j = mig.indexOf('$do$;', i); return i < 0 || j < 0 ? null : mig.slice(mig.indexOf('DO $do$', i), j + 5); };
  const b10 = bloque('-- 1.0 ¿Primera vez que se aplica 0094?');
  const b3b = bloque('-- 3b. TRANSICIÓN de la mensualidad por defecto');
  check('la migración trae los bloques de la transición (1.0 y 3b)', !!b10 && !!b3b && /default_amount_cop/.test(b3b));
  await c.query('SAVEPOINT esc');
  await q(`INSERT INTO public.billing_settings (organization_id, default_amount_cop) VALUES ($1, 150000)
           ON CONFLICT (organization_id) DO UPDATE SET default_amount_cop = 150000`, [fx.org]);
  await asUser(c, jefe, 'admin');
  await q(`SELECT public.admin_billing_save_account($1, NULL, 14::smallint, NULL, NULL, NULL, true, NULL, $2::date)`, [fx.vecino, BASE]);
  await q(`SELECT public.admin_billing_set_sector($1, 'Llanogrande')`, [fx.vecino]);   // Llanogrande sin mensualidad
  await q(`SELECT public.admin_billing_save_account($1, NULL, 14::smallint, 5::smallint, 2::smallint, 3::smallint, true, NULL, $2::date)`, [fx.aux, BASE]);   // Rionegro: $170.000
  await asDb();
  await c.query(b10);
  const marca = await one(`SELECT to_regclass('pg_temp._mig0094_primera') IS NOT NULL AS m`);
  await c.query(b3b);
  const sinMarca = await one(`SELECT amount_cop FROM public.auxiliar_billing WHERE auxiliar_profile_id = $1`, [fx.vecino]);
  check('volver a correr la migración (ya tiene la columna sector) NO repite la transición: sigue sin valor', marca.m === false && sinMarca.amount_cop === null, { marca, sinMarca });
  await c.query(`CREATE TEMP TABLE _mig0094_primera (x int) ON COMMIT DROP`);   // como la primera vez
  await c.query(b3b);
  const tv = await one(`SELECT amount_cop FROM public.auxiliar_billing WHERE auxiliar_profile_id = $1`, [fx.vecino]);
  const ta = await one(`SELECT amount_cop FROM public.auxiliar_billing WHERE auxiliar_profile_id = $1`, [fx.aux]);
  check('la primera vez: quien se cobraba con la mensualidad por defecto la recibe como valor propio ($150.000)', tv.amount_cop === 150000, tv);
  check('…quien paga la mensualidad de su sector NO la recibe (sigue con la del sector)', ta.amount_cop === null
    && (await one(`SELECT monthly, monthly_origin FROM public.billing_rate_of($1)`, [fx.aux])).monthly_origin === 'sector', ta);
  await runJob();
  check('…y el reloj le abre la cuenta por ese valor: nadie se queda sin cobro en silencio', (await stmt(fx.vecino, BASE)).amount_cop === 150000);
  await c.query(`DROP TABLE IF EXISTS pg_temp._mig0094_primera`);
  await c.query('ROLLBACK TO SAVEPOINT esc');
} catch (e) {
  fail++;
  console.log(`  ✗ la verificación se cayó: ${e.message}`);
} finally {
  await c.query('ROLLBACK').catch(() => {});
  await c.end();
}

console.log(`\n${ok} ✓ · ${fail} ✗`);
console.log('NO cubre: la push real (drain + VAPID), pg_cron corriendo de verdad a las 7:00, ni pantallas; tampoco el cambio de vuelo');
console.log('          de la app (0089: depende de la hora real) ni dos sesiones a la vez (reloj de las 7:00 + una reserva).');
console.log('          Cancelar por la RPC de la app (0050) sí; el resto, INSERT/UPDATE directos, que disparan el mismo trigger.');
process.exit(fail ? 1 : 0);
