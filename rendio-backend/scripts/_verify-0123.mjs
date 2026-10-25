// Verificación de 0123 (cuentas de cobro por adelantado: el 21 se abre la del
// próximo corte de todos; el plazo y los avisos cuentan desde su corte) contra la
// base LOCAL (127.0.0.1:54322).
//
//   cd rendio-backend/scripts && node _verify-0123.mjs
//
// La migración se aplica DENTRO de una transacción que se deshace al final: en la
// base local no queda ni 0123 ni ningún dato. Nunca apunta a dev ni a producción
// (_local-fixtures se niega). Plazos como los de producción: 3 días para pagar,
// aviso 1 día antes, 2 de gracia.
//
// Qué prueba (el calendario va del 20-oct al 21-nov de 2026):
//   1. 20-oct: el reloj no abre nada por adelantado todavía; el botón dice por qué
//      («Cobra desde el 1 de nov: se abre sola el 21 de oct»).
//   2. 21-oct: corte 21 → la del 21, como siempre (con su «está lista»). Corte 1 →
//      la del 1-nov POR ADELANTADO: vence el 4-nov, pausa el 7-nov, sin aviso ni
//      push, sin pausa. A quien debe octubre se le abre igual, y su cuenta actual
//      sigue siendo octubre (la más vieja sin pagar).
//   3. El tripulante la ve (cuenta actual + historial) y el jefe también (lista).
//   4. 25-oct: el reloj otra vez no abre una segunda; ningún aviso de fecha.
//   5. «Abrir varias» a mano el 25-oct (el caso del audio): corte 1 que cobra desde
//      1-nov → la de NOVIEMBRE por adelantado, sin «vencida» ni pausa ni push aunque
//      se pida avisar. Corte 21 que ya tiene la suya → no abre la de noviembre.
//      Corte 1 que debe octubre y no tiene ninguna → octubre, como antes.
//   6. Antes del 21 a mano: no abre (y ya NO abre octubre a quien cobra desde
//      noviembre: ese era el error del audio).
//   7. El jefe la marca pagada (pagó por adelantado): queda al día; el 1-nov no le
//      llega «está lista».
//   8. Vacaciones del próximo cobro sobre la cuenta anticipada: se recalcula.
//   9. Comprobante del tripulante sobre la anticipada (en revisión el 1-nov: sin
//      «está lista»).
//  10. 1-nov: a las que se abrieron antes y siguen sin pagar les sale «Tu cuenta de
//      cobro de noviembre está lista», con push, UNA vez; el reloj no abre otra.
//  11. 3-nov aviso, 5-nov vencido, 7-nov pausa: cuentan desde el corte.
//  12. 21-nov: corte 21 → la del 21-nov; corte 1 → la del 1-dic por adelantado.
//  13. Día de apertura apagado (NULL): nadie por adelantado. Permisos: las dos
//      funciones nuevas no se pueden llamar desde la app.
//
// NO cubre: la pantalla (eso es _smoke-admin-cobro-dom / _smoke-rx-pagos-dom), la
// subida real al Storage, la push de verdad, pg_cron real ni las bases de dev/prod.
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
async function setToday(iso) { await c.query(`SELECT set_config('rendio.billing_today', $1, true)`, [iso]); }
async function runJob(day) { await setToday(day); await asDb(); return (await one(`SELECT public.billing_run_daily() AS r`)).r; }
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d == null ? null : String(d).slice(0, 10));
const stmts = async (aux) => {
  await asDb();
  return q(`SELECT *, period_start::text ps, due_date::text due, block_date::text blk FROM public.billing_statements
             WHERE auxiliar_profile_id = $1 ORDER BY period_start`, [aux]);
};
const alertas = async (stId) => { await asDb(); return q(`SELECT key, pushed, body, day::text AS dia FROM public.billing_alerts WHERE statement_id = $1 ORDER BY created_at`, [stId]); };
const outbox = async (prof, like) => { await asDb(); return q(`SELECT title, body FROM public.notification_outbox WHERE profile_id = $1 AND title ILIKE $2`, [prof, like]); };
const paused = async (aux) => { await asDb(); return (await one(`SELECT public.billing_is_paused($1) p`, [aux])).p; };

await c.query('BEGIN');
try {
  const sql = fs.readFileSync(new URL('../supabase/migrations/0123_cobro_por_adelantado.sql', import.meta.url), 'utf8')
    .replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
  await c.query(sql);
  await c.query(sql);                                  // idempotente: correrla dos veces no falla
  check('0123 se aplica (y se puede volver a correr)', true);

  const fx = await fixtures(c);
  const jefe = await user(c, fx.org, 'admin', 'Jefa de prueba 0123');
  await setToday('2026-10-20');
  await q(`INSERT INTO public.billing_settings (organization_id, due_days, notice_days, grace_days)
           VALUES ($1, 3, 1, 2) ON CONFLICT (organization_id) DO UPDATE SET due_days = 3, notice_days = 1, grace_days = 2`, [fx.org]);
  check('el día de apertura arranca en 21', (await one(`SELECT early_open_day d FROM public.billing_settings WHERE organization_id = $1`, [fx.org])).d === 21);

  const nuevo = async (name) => {
    const u = await user(c, fx.org, 'auxiliar', name);
    const a = (await one(`INSERT INTO public.auxiliar_profiles (profile_id, residence_id) VALUES ($1, $2) RETURNING id`, [u, fx.olivar])).id;
    return { u, a };
  };
  const A = { u: fx.auxUser, a: fx.aux };                      // corte 21, desde 21-oct
  const B = { u: fx.vecinoUser, a: fx.vecino };                // corte 1, cobra desde 1-nov (como los de producción)
  const H = await nuevo('Hugo debe octubre 0123');             // corte 1, desde 1-oct, octubre abierto sin pagar
  const P = await nuevo('Pili octubre pagado 0123');           // corte 1, desde 1-oct, octubre pagado
  const V = await nuevo('Vale vacaciones 0123');               // corte 1, desde 1-nov: marca vacaciones de noviembre
  const R = await nuevo('Rosa comprobante 0123');              // corte 1, desde 1-nov: sube comprobante antes del corte

  await asUser(c, jefe, 'admin');
  await q(`SELECT public.admin_billing_save_sector_rate('Rionegro', 470000, 20000)`);
  const cuenta = (aux, cut, starts, active = true) => q(
    `SELECT public.admin_billing_save_account($1, NULL, $2::smallint, NULL, NULL, NULL, $3, NULL, $4::date)`, [aux, cut, active, starts]);
  await cuenta(A.a, 21, '2026-10-21');
  await cuenta(B.a, 1, '2026-11-01');
  await cuenta(H.a, 1, '2026-10-01');
  await cuenta(P.a, 1, '2026-10-01');
  await cuenta(V.a, 1, '2026-11-01');
  await cuenta(R.a, 1, '2026-11-01');
  // Octubre de H y P (abiertos el 1-oct, como el reloj); P lo pagó.
  await asDb();
  await setToday('2026-10-01');
  await q(`SELECT public.billing_open_statement($1, '2026-10-01', '2026-10-01')`, [H.a]);
  await q(`SELECT public.billing_open_statement($1, '2026-10-01', '2026-10-01')`, [P.a]);
  const [oP] = await stmts(P.a);
  await setToday('2026-10-02');
  await asUser(c, jefe, 'admin');
  await q(`SELECT public.admin_billing_mark_paid($1, 'Transferencia', NULL, '2026-10-02'::date, NULL)`, [oP.id]);

  const lista = async () => { await asUser(c, jefe, 'admin'); const r = (await one(`SELECT public.admin_billing_list() AS r`)).r; await asDb(); return Object.fromEntries(r.map(x => [x.auxiliarProfileId, x])); };
  const miCuenta = async (X) => { await asUser(c, X.u, 'auxiliar'); const r = (await one(`SELECT public.aux_billing_my_account() AS r`)).r; await asDb(); return r; };
  const miHist = async (X) => { await asUser(c, X.u, 'auxiliar'); const r = (await one(`SELECT public.aux_billing_history() AS r`)).r; await asDb(); return r; };

  // ── 1. El 20-oct ─────────────────────────────────────────────────────────
  console.log('\n1. 20-oct: todavía no');
  await runJob('2026-10-20');
  check('B (corte 1, desde 1-nov): sin ninguna cuenta', (await stmts(B.a)).length === 0);
  check('H: sigue solo con octubre', (await stmts(H.a)).length === 1);
  let L = await lista();
  check('el botón de B dice por qué no: «Cobra desde el 1 de nov: se abre sola el 21 de oct»',
    L[B.a].account.openCut == null && L[B.a].account.openReason === 'Cobra desde el 1 de nov: se abre sola el 21 de oct', L[B.a].account);
  check('A (corte 21, desde 21-oct): tampoco hay que abrir todavía', L[A.a].account.openCut == null, L[A.a].account);

  // ── 2. El 21-oct ─────────────────────────────────────────────────────────
  console.log('\n2. 21-oct: el reloj abre la del próximo corte');
  const j21 = await runJob('2026-10-21');
  const [sA] = await stmts(A.a);
  check('A (corte 21): la del 21-oct, vence 24-oct, como siempre', sA && sA.ps === '2026-10-21' && sA.due === '2026-10-24' && !sA.opened_early, sA && [sA.ps, sA.due, sA.opened_early]);
  check('A: su «está lista» sale con push el 21', (await alertas(sA.id)).some(x => x.key === 'generado' && x.pushed));
  const sbs = await stmts(B.a);
  const sB = sbs[0];
  check('B (corte 1): UNA cuenta, la del 1-nov, por adelantado', sbs.length === 1 && sB.ps === '2026-11-01' && sB.opened_early === true, sbs.map(s => [s.ps, s.opened_early]));
  check('B: vence el 4-nov y se pausaría el 7-nov (cuentan desde su corte)', sB.due === '2026-11-04' && sB.blk === '2026-11-07', [sB.due, sB.blk]);
  check('B: el período es del 1 al 30 de nov y cobra la mensualidad del sector', iso(sB.period_end) === '2026-11-30' && sB.amount_cop === 470000, [iso(sB.period_end), sB.amount_cop]);
  check('B: ningún aviso todavía (el «está lista» sale el 1-nov)', (await alertas(sB.id)).length === 0, await alertas(sB.id));
  check('B: ninguna push de cobro', (await outbox(B.u, '%cobro%')).length === 0);
  check('B: sin pausa, estado «pendiente»', !(await paused(B.a)) && sB.status === 'pendiente', sB.status);
  const sH = await stmts(H.a);
  check('H (debe octubre): también se le abre noviembre por adelantado', sH.length === 2 && sH[1].ps === '2026-11-01' && sH[1].opened_early, sH.map(s => s.ps));
  const sP = await stmts(P.a);
  check('P (octubre pagado): noviembre por adelantado', sP.length === 2 && sP[1].ps === '2026-11-01' && sP[1].opened_early && !sP[1].paid_at, sP.map(s => s.ps));
  check('el reloj cuenta las que abrió', j21.opened >= 6, j21);

  // ── 3. Quién la ve ───────────────────────────────────────────────────────
  console.log('\n3. El tripulante y el jefe la ven');
  await setToday('2026-10-23');
  const mB = await miCuenta(B);
  check('B ve la de noviembre como su cuenta actual (pendiente, 12 días para pagar)', mB && mB.current && iso(mB.current.periodStart) === '2026-11-01'
    && mB.current.base === 'pendiente' && mB.current.daysToDue === 12 && mB.paused === false, mB && mB.current && [mB.current.periodStart, mB.current.base, mB.current.daysToDue]);
  check('B: en su historial también', (await miHist(B)).some(x => iso(x.periodStart) === '2026-11-01'));
  const mH = await miCuenta(H);
  check('H ve primero octubre (la más vieja sin pagar es la que manda)', mH && iso(mH.current.periodStart) === '2026-10-01', mH && mH.current.periodStart);
  const mP = await miCuenta(P);
  check('P (octubre pagado) ve noviembre', mP && iso(mP.current.periodStart) === '2026-11-01' && !mP.current.paid, mP && mP.current.periodStart);
  L = await lista();
  check('jefe: B con la de noviembre como actual', iso(L[B.a].current.periodStart) === '2026-11-01', L[B.a].current && L[B.a].current.periodStart);
  check('jefe: el botón de B ya no tiene nada que abrir («Ya tiene abierta la del 1 de nov»)', L[B.a].account.openCut == null && L[B.a].account.openReason === 'Ya tiene abierta la del 1 de nov', L[B.a].account);
  check('jefe: el día de apertura viene en la lista (21)', L[B.a].account.earlyOpenDay === 21);

  // ── 4. El 25-oct ─────────────────────────────────────────────────────────
  console.log('\n4. 25-oct: el reloj no repite ni avisa');
  await runJob('2026-10-25');
  check('B: sigue con UNA cuenta', (await stmts(B.a)).length === 1);
  check('B: sigue sin avisos', (await alertas(sB.id)).length === 0);

  // ── 5. «Abrir varias» a mano el 25-oct (el caso del audio) ───────────────
  console.log('\n5. Abrir a mano el 25-oct');
  const M1 = await nuevo('Mara cobra desde nov 0123');           // la cuenta se creó tarde: el reloj del 21 no la vio
  const M3 = await nuevo('Mati corte 21 ya la tiene 0123');
  const M4 = await nuevo('Moni debe octubre sin cuenta 0123');
  await asUser(c, jefe, 'admin');
  await cuenta(M1.a, 1, '2026-11-01');
  await cuenta(M3.a, 21, '2026-10-21');
  await cuenta(M4.a, 1, '2026-10-01');
  await asDb();
  await q(`SELECT public.billing_open_statement($1, '2026-10-21', '2026-10-21')`, [M3.a]);
  await setToday('2026-10-25');
  L = await lista();
  check('antes de abrir, el botón de M1 dice «la del 1 de nov, por adelantado»', iso(L[M1.a].account.openCut) === '2026-11-01' && L[M1.a].account.openEarly === true, L[M1.a].account);
  check('el de M4 (debe octubre) dice octubre, sin «por adelantado»', iso(L[M4.a].account.openCut) === '2026-10-01' && L[M4.a].account.openEarly === false, L[M4.a].account);
  await asUser(c, jefe, 'admin');
  const r5 = (await one(`SELECT public.admin_billing_open_statements($1::uuid[], false, true) AS r`, [[M1.a, M3.a, M4.a]])).r;
  await asDb();
  const op5 = Object.fromEntries(r5.opened.map(x => [x.auxiliarProfileId, x]));
  const sk5 = Object.fromEntries(r5.skipped.map(x => [x.auxiliarProfileId, x.reason]));
  check('M1 (corte 1, desde 1-nov): se abre NOVIEMBRE, por adelantado, sin vencer ni pausar', op5[M1.a] && iso(op5[M1.a].periodStart) === '2026-11-01'
    && op5[M1.a].early === true && op5[M1.a].blocked === false && iso(op5[M1.a].dueDate) === '2026-11-04', op5[M1.a]);
  const [sM1] = await stmts(M1.a);
  check('M1: aunque se pidió avisar, ni aviso ni push (salen el 1-nov)', (await alertas(sM1.id)).length === 0 && (await outbox(M1.u, '%cobro%')).length === 0);
  check('M3 (corte 21, ya tiene la del 21): no se le abre la de noviembre', !op5[M3.a] && sk5[M3.a] === 'Ya tiene abierta la del 21 de oct', sk5[M3.a]);
  check('M4 (debe octubre, sin ninguna): octubre, como antes (vencida y pausada)', op5[M4.a] && iso(op5[M4.a].periodStart) === '2026-10-01'
    && op5[M4.a].early === false && op5[M4.a].blocked === true, op5[M4.a]);

  // ── 6. Antes del 21, a mano ──────────────────────────────────────────────
  console.log('\n6. A mano antes del 21: no abre, y ya no abre octubre a quien cobra desde noviembre');
  const M5 = await nuevo('Meli antes del 21 0123');
  await asUser(c, jefe, 'admin');
  await cuenta(M5.a, 1, '2026-11-01');
  await setToday('2026-10-10');
  await asUser(c, jefe, 'admin');
  const r6 = (await one(`SELECT public.admin_billing_open_statements($1::uuid[], false, true) AS r`, [[M5.a]])).r;
  check('M5 el 10-oct: no se abre nada', r6.opened.length === 0 && /Cobra desde el 1 de nov: se abre sola el 21 de oct/.test(r6.skipped[0].reason), r6);
  check('…y no quedó ninguna cuenta (antes abría octubre vencida)', (await stmts(M5.a)).length === 0);

  // ── 7. Pagó por adelantado ───────────────────────────────────────────────
  console.log('\n7. El jefe la marca pagada antes del corte');
  await setToday('2026-10-26');
  await asUser(c, jefe, 'admin');
  await q(`SELECT public.admin_billing_mark_paid($1, 'Transferencia', NULL, '2026-10-26'::date, NULL)`, [sB.id]);
  const [sB2] = await stmts(B.a);
  check('B: noviembre al día, pagado el 26-oct', !!sB2.paid_at && iso(sB2.paid_on) === '2026-10-26' && sB2.status === 'pagado', [sB2.paid_on, sB2.status]);
  check('B: le llega «Pago confirmado»', (await alertas(sB.id)).some(x => x.key === 'aprobado'));
  const mB2 = await miCuenta(B);
  check('B ve noviembre pagado', mB2 && iso(mB2.current.periodStart) === '2026-11-01' && mB2.current.paid === true);

  // ── 8. Vacaciones del próximo cobro ──────────────────────────────────────
  console.log('\n8. Vacaciones sobre la cuenta anticipada');
  const [sV0] = await stmts(V.a);
  await asUser(c, V.u, 'auxiliar');
  await q(`SELECT public.aux_billing_set_vacation('next', '2026-11-05'::date, '2026-11-20'::date, 4)`);
  const [sV] = await stmts(V.a);
  check('V: misma cuenta, recalculada a 4 × $20.000', sV.id === sV0.id && sV.amount_cop === 80000 && sV.vacation_trips === 4, [sV.amount_cop, sV.vacation_trips]);

  // ── 9. Comprobante del tripulante antes del corte ────────────────────────
  console.log('\n9. Comprobante del tripulante sobre la anticipada');
  const [sR] = await stmts(R.a);
  const pathR = `${fx.org}/${R.u}/${sR.id}/aux-1.jpg`;
  await q(`INSERT INTO storage.objects (bucket_id, name) VALUES ('payment-proofs', $1)`, [pathR]);
  await asUser(c, R.u, 'auxiliar');
  await q(`SELECT public.aux_billing_submit_proof($1, $2, 'Nequi')`, [sR.id, pathR]);
  const [sR2] = await stmts(R.a);
  check('R: comprobante en revisión', sR2.proof_state === 'review');

  // ── 10. El 1-nov ─────────────────────────────────────────────────────────
  console.log('\n10. 1-nov: el «está lista» de las que se abrieron antes');
  await runJob('2026-11-01');
  const genH = (await alertas(sH[1].id)).filter(x => x.key === 'generado');
  check('H: «está lista» de noviembre, con push, una vez', genH.length === 1 && genH[0].pushed && genH[0].dia === '2026-11-01' && /4 de nov/.test(genH[0].body), genH);
  check('H: la push quedó en la cola', (await outbox(H.u, 'Tu cuenta de cobro de noviembre%')).length === 1);
  check('P: también', (await outbox(P.u, 'Tu cuenta de cobro de noviembre%')).length === 1);
  check('M1 (abierta a mano por adelantado): también', (await outbox(M1.u, 'Tu cuenta de cobro de noviembre%')).length === 1);
  check('B (ya pagó): NO le llega', (await outbox(B.u, 'Tu cuenta de cobro de noviembre%')).length === 0 && !(await alertas(sB.id)).some(x => x.key === 'generado'));
  check('R (comprobante en revisión): NO le llega', (await outbox(R.u, 'Tu cuenta de cobro de noviembre%')).length === 0);
  check('nadie quedó con una segunda cuenta de noviembre', (await stmts(B.a)).length === 1 && (await stmts(P.a)).length === 2 && (await stmts(H.a)).length === 2);
  await runJob('2026-11-01');
  check('correr el reloj dos veces el mismo día no repite el aviso', (await outbox(H.u, 'Tu cuenta de cobro de noviembre%')).length === 1);

  // ── 11. Plazo, aviso y pausa desde el corte ──────────────────────────────
  console.log('\n11. Los avisos cuentan desde el corte');
  await runJob('2026-11-02');
  await runJob('2026-11-03');
  const nP = sP[1].id;
  check('P: el 3-nov, «vence en 1 día»', (await alertas(nP)).some(x => x.key === 'recordatorio' && x.dia === '2026-11-03'));
  await runJob('2026-11-04'); await runJob('2026-11-05'); await runJob('2026-11-06');
  check('P: el 5-nov, vencido', (await alertas(nP)).some(x => x.key === 'vencido' && x.dia === '2026-11-05'));
  check('P: el 6-nov todavía sin pausa', !(await paused(P.a)));
  await runJob('2026-11-07');
  check('P: el 7-nov, pausada', await paused(P.a));

  // ── 12. El 21-nov ────────────────────────────────────────────────────────
  console.log('\n12. 21-nov: el ciclo sigue');
  await runJob('2026-11-21');
  const sA2 = await stmts(A.a);
  check('A (corte 21): la del 21-nov, normal', sA2.length === 2 && sA2[1].ps === '2026-11-21' && !sA2[1].opened_early, sA2.map(s => [s.ps, s.opened_early]));
  const sB3 = await stmts(B.a);
  check('B (corte 1): la del 1-dic, por adelantado', sB3.length === 2 && sB3[1].ps === '2026-12-01' && sB3[1].opened_early, sB3.map(s => [s.ps, s.opened_early]));

  // ── 13. Apagado y permisos ───────────────────────────────────────────────
  console.log('\n13. Día de apertura apagado y permisos');
  await q(`UPDATE public.billing_settings SET early_open_day = NULL WHERE organization_id = $1`, [fx.org]);
  const Z = await nuevo('Zoe apagado 0123');
  await asUser(c, jefe, 'admin');
  await cuenta(Z.a, 1, '2026-12-01');
  await runJob('2026-11-22');
  check('apagado: a Z no se le abre diciembre por adelantado', (await stmts(Z.a)).length === 0);
  L = await lista();
  check('apagado: el botón de Z dice «Cobra desde el 1 de dic» (sin «se abre sola»)', L[Z.a].account.openCut == null && L[Z.a].account.openReason === 'Cobra desde el 1 de dic', L[Z.a].account);
  await asDb();
  const eBad = await debeFallar(`UPDATE public.billing_settings SET early_open_day = 29 WHERE organization_id = $1`, [fx.org]);
  check('el día de apertura va de 1 a 28', !!eBad);
  await asUser(c, jefe, 'admin');
  const e1 = await debeFallar(`SELECT public.billing_open_target($1, '2026-11-22')`, [B.a]);
  const e2 = await debeFallar(`SELECT public.billing_open_early($1, '2027-01-01', '2026-11-22')`, [B.a]);
  check('billing_open_target y billing_open_early no se llaman desde la app', e1 && /permission|permiso/i.test(e1.message) && e2 && /permission|permiso/i.test(e2.message), [e1 && e1.message, e2 && e2.message]);
  await asDb();
  const e3 = await debeFallar(`SELECT public.billing_open_early($1, '2026-11-01', '2026-11-22')`, [B.a]);
  check('billing_open_early se niega a abrir un corte que ya pasó', e3 && /próximo corte/.test(e3.message), e3 && e3.message);
} catch (e) {
  fail++;
  console.error('  ✗ ERROR:', e.message, e.where || '');
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok} bien · ${fail} mal`);
console.log('NO cubre: la pantalla, la subida real al Storage, la push de verdad, pg_cron real ni las bases de dev/prod.');
process.exit(fail ? 1 : 0);
