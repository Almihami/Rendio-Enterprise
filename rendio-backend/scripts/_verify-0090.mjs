// Verificación de 0090 (Facturario) contra la base LOCAL (127.0.0.1:54322).
//
//   cd rendio-backend/scripts && node _verify-0090.mjs
//
// Todo corre dentro de UNA transacción que se deshace (cada escenario en su
// SAVEPOINT): no queda nada en la base.
//
// Qué prueba:
//   1. Estructura: tablas con RLS, bucket privado, trigger de pausa, reloj en
//      pg_cron a las 12:00 UTC (7:00 Bogotá), permisos de las funciones.
//   2. EL CALENDARIO DE cbSimulate, día a día. Se carga cbSimulate y CB_ALERTS
//      DIRECTO del diseño (cobro-engine.jsx) y cada escenario se corre en la base
//      (reloj diario + comprobante / aprobar / rechazar / marcar pagado por las
//      RPC reales, como tripulante y como jefe) y se compara cada día el estado
//      (base, comp, pausa, días a vencer y a pausar) y al final la lista de avisos
//      (clave + día + destinatario) y su TEXTO contra CB_ALERTS.
//      Escenarios: sin pagar; paga a tiempo; rechazo mantiene la fecha; en
//      revisión no pausa (y rechazo tardío pausa, aprobar reactiva); sube el día
//      de la pausa; marcar pagado estando pausado; gracia 0; gracia 1; aviso 0;
//      aviso ≥ plazo; push apagada.
//   3. La pausa frena SOLO los INSERT del propio tripulante con el texto fijo
//      (RB402); el jefe sí le crea; lo ya pedido sigue; no toca la suspensión de
//      0081 (y el suspendido ve el mensaje de la suspensión).
//   4. Avisos a notification_outbox: una vez, con clave única; venceHoy a las
//      8:00; admMora y recibido sin push; el jefe de OTRA org no recibe nada;
//      correr el reloj dos veces el mismo día no repite.
//   5. RLS con dos tripulantes y un jefe (+ un jefe de otra organización), en
//      tablas y en el bucket `payment-proofs`.
//   6. Reglas sueltas: corte fin de mes, monto siguiente, starts_on, abrir a mano
//      con fecha vieja, motivo obligatorio, doble revisión, doble comprobante.
//   7. api-cobro.js (con un cliente falso): exporta el contrato, formatea como
//      cbMoney/cbFmt, toSim() da la forma de cbSimulate con datos reales de la
//      base, isPausedError reconoce el error real, la ruta de subida.
//
// Con 0090 aplicada sale en verde. Con el down aplicado tiene que FALLAR.
//
// NO cubre: el envío real de la push (drain_notification_outbox + VAPID), la
// subida real por la API de Storage (se inserta la fila de storage.objects con
// la política del bucket), ni la ejecución real de pg_cron a las 7:00.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localClient, fixtures, user, asUser } from './_local-fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = process.env.COBRO_ENGINE ||
  '/Users/harold/Documents/Rendio-Drivers/Visual/entrega-auxiliar-2026-09-27/entrega-rendio-auxiliar/fuente/cobro-engine.jsx';
const API_COBRO = path.resolve(HERE, '../../rendio-turnos/api-cobro.js');

let ok = 0, fail = 0;
const check = (n, cond, det) => {
  if (cond) { ok++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + (typeof det === 'string' ? det : JSON.stringify(det)) : ''}`); }
};

// ---------------------------------------------------------------------------
// El motor del diseño
// ---------------------------------------------------------------------------
const E = (() => {
  const ctx = { window: {}, console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(ENGINE, 'utf8'), ctx, { filename: 'cobro-engine.jsx' });
  return ctx.window;
})();

const c = await localClient();
const q = async (s, p) => (await c.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
async function debeFallar(sql, params) {
  await c.query('SAVEPOINT sp_f');
  try { await c.query(sql, params); await c.query('RELEASE SAVEPOINT sp_f'); return null; }
  catch (e) { await c.query('ROLLBACK TO SAVEPOINT sp_f'); return e; }
}
// Como postgres y SIN sesión de nadie (auth.uid() NULL).
async function asDb() {
  await c.query(`RESET ROLE`);
  await c.query(`SELECT set_config('request.jwt.claims', '', true)`);
}

const BASE = '2026-10-14';        // = CB_BASE del diseño (14 oct 2026)
const addDays = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const dayISO = d => addDays(BASE, d);
async function setToday(iso) { await c.query(`SELECT set_config('rendio.billing_today', $1, true)`, [iso]); }
async function runJob() { await asDb(); return (await one(`SELECT public.billing_run_daily() AS r`)).r; }

await c.query('BEGIN');
try {
  const fx = await fixtures(c);                         // Laura Gómez (fx.aux) + vecina (fx.vecino)
  const jefe = await user(c, fx.org, 'admin', 'Jefa de prueba 0090');
  // Otra organización (a mano: fixtures() repite correos si se llama dos veces).
  const fx2 = { org: (await one(`INSERT INTO public.organizations (name, slug) VALUES ('Otra org 0090', 'otra-0090-' || substr(md5(random()::text), 1, 6)) RETURNING id`)).id };
  const jefe2 = await user(c, fx2.org, 'admin', 'Jefe de otra org 0090');

  // =========================================================================
  console.log('\n0. Estructura');
  // =========================================================================
  const tablas = ['billing_settings', 'billing_payment_methods', 'auxiliar_billing', 'billing_statements',
    'billing_proofs', 'billing_payments', 'billing_alerts', 'billing_job_runs'];
  const rls = await q(`SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1)`, [tablas]);
  check('las 8 tablas existen con RLS encendida', rls.length === 8 && rls.every(r => r.relrowsecurity), rls.map(r => r.relname + ':' + r.relrowsecurity).join(','));
  const bk = await one(`SELECT public FROM storage.buckets WHERE id = 'payment-proofs'`);
  check('bucket payment-proofs existe y es PRIVADO', bk && bk.public === false, bk);
  const trg = await one(`SELECT 1 AS x FROM pg_trigger WHERE tgname = 'tr_reservations_pause_by_billing' AND tgrelid = 'public.reservations'::regclass`);
  check('trigger de pausa en reservations', !!trg);
  const cron = await one(`SELECT schedule, command FROM cron.job WHERE jobname = 'billing-daily'`).catch(() => null);
  check('reloj billing-daily en pg_cron a las 12:00 UTC (7:00 Bogotá)', cron && cron.schedule === '0 12 * * *' && /billing_run_daily/.test(cron.command), cron);
  const privs = await q(`SELECT f, has_function_privilege('authenticated', f, 'EXECUTE') AS a, has_function_privilege('anon', f, 'EXECUTE') AS b FROM unnest($1::text[]) f`,
    [['public.billing_run_daily(date)', 'public.billing_emit(public.billing_statements,text,date,jsonb,uuid,boolean)',
      'public.billing_settle(uuid,text,uuid,integer,text,date,text)', 'public.billing_open_statement(uuid,date,date)']]);
  check('las funciones internas NO las ejecuta authenticated ni anon', privs.length === 4 && privs.every(p => !p.a && !p.b), privs);
  const privs2 = await q(`SELECT f, has_function_privilege('authenticated', f, 'EXECUTE') AS a, has_function_privilege('anon', f, 'EXECUTE') AS b FROM unnest($1::text[]) f`,
    [['public.aux_billing_my_account()', 'public.admin_billing_review_proof(uuid,boolean,text)', 'public.aux_billing_submit_proof(uuid,text,text,uuid,text,integer,integer)']]);
  check('las RPC de la app: authenticated sí, anon no', privs2.length === 3 && privs2.every(p => p.a && !p.b), privs2);
  const reasons = (await one(`SELECT public.billing_reject_reasons() AS r`)).r;
  check('motivos de rechazo = CB_REASONS del diseño', JSON.stringify(reasons) === JSON.stringify([...E.CB_REASONS]), reasons);

  // =========================================================================
  console.log('\n1. Formato igual al diseño (cbMoney / cbFmt)');
  // =========================================================================
  const fm = await one(`SELECT public.billing_money(150000) m, public.billing_money(1500) m2, public.billing_fmt('2026-10-19') f1,
      public.billing_fmt('2026-09-14') f2, public.billing_fmt('2026-11-01') f3`);
  check('billing_money = cbMoney', fm.m === E.cbMoney(150000) && fm.m2 === E.cbMoney(1500), fm);
  check('billing_fmt = cbFmt (incluye «sept»)', fm.f1 === E.cbFmt(5) && fm.f3 === E.cbFmt(18) && fm.f2 === '14 de sept', fm);

  // =========================================================================
  console.log('\n2. El calendario de cbSimulate, día a día');
  // =========================================================================
  const setAccount = async (cfg, extra = {}) => {
    await asUser(c, jefe, 'admin');
    const r = await one(`SELECT public.admin_billing_save_account($1, $2, $3::smallint, $4::smallint, $5::smallint, $6::smallint, true, NULL, $7::date) AS r`,
      [extra.aux || fx.aux, extra.amount || 150000, extra.cutDay || 14, cfg.plazo, cfg.aviso, cfg.gracia, extra.startsOn || BASE]);
    await asDb();
    return r.r;
  };
  const stmtOf = async (aux = fx.aux) => (await one(`SELECT * FROM public.billing_statements WHERE auxiliar_profile_id = $1 ORDER BY period_start DESC LIMIT 1`, [aux]));
  const reservaComoAux = async (who = fx.auxUser, aux = fx.aux) => {
    await asUser(c, who, 'auxiliar');
    const e = await debeFallar(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_h2a, required_arrival_at, residence_id)
      VALUES ($1, 'home_to_airport', 'requested', now() + interval '4 days', $2)`, [aux, fx.olivar]);
    await asDb();
    return e;
  };

  let apiProbe = null;   // una foto real de myAccount + avisos para probar api-cobro.js
  let pauseErr = null;   // el error real de la pausa, para isPausedError

  async function doEvent(ev, stmtId, n) {
    if (ev.type === 'upload') {
      const p = `${fx.org}/${fx.auxUser}/${stmtId}/prueba-${n}.jpg`;
      await asUser(c, fx.auxUser, 'auxiliar');
      await q(`INSERT INTO storage.objects (bucket_id, name) VALUES ('payment-proofs', $1)`, [p]);
      await q(`SELECT public.aux_billing_submit_proof($1, $2, 'Bancolombia', NULL, 'image/jpeg', 2048, NULL)`, [stmtId, p]);
    } else if (ev.type === 'approve' || ev.type === 'reject') {
      const pr = await one(`SELECT id FROM public.billing_proofs WHERE statement_id = $1 AND status = 'review'`, [stmtId]);
      await asUser(c, jefe, 'admin');
      await q(`SELECT public.admin_billing_review_proof($1, $2, $3)`, [pr.id, ev.type === 'approve', ev.reason || null]);
    } else if (ev.type === 'manual') {
      await asUser(c, jefe, 'admin');
      await q(`SELECT public.admin_billing_mark_paid($1, 'Efectivo', NULL, NULL, NULL)`, [stmtId]);
    }
    await asDb();
  }

  // Corre un escenario y lo compara con cbSimulate. Devuelve el statement.
  async function escenario(nombre, cfg, events, lastDay, opts = {}) {
    const simCfg = { plazo: cfg.plazo, aviso: cfg.aviso, gracia: cfg.gracia, monto: 150000, montoNext: null };
    await setToday(dayISO(0));
    await setAccount(cfg);
    if (opts.before) await opts.before();
    let stmt = null;
    const diffs = [];
    let n = 0;
    for (let d = 0; d <= lastDay; d++) {
      await setToday(dayISO(d));
      const hoy = events.filter(e => e.day === d);
      for (const ev of hoy.filter(e => e.early)) { await doEvent(ev, stmt.id, n++); }
      await runJob();
      stmt = stmt || await stmtOf();
      for (const ev of hoy.filter(e => !e.early)) { await doEvent(ev, stmt.id, n++); }
      if (opts.onDay) await opts.onDay(d, stmt);
      // estado como lo ve el tripulante
      await asUser(c, fx.auxUser, 'auxiliar');
      const acc = (await one(`SELECT public.aux_billing_my_account() AS a`)).a;
      if (opts.probeDay === d) {
        const al = await q(`SELECT id, statement_id, proof_id, key, day, day_index, title, body, tone, payload, pushed, created_at
            FROM public.billing_alerts WHERE audience = 'aux' ORDER BY created_at DESC`);
        apiProbe = { acc, alerts: al, sim: E.cbSimulate(d, events, simCfg), cfg: simCfg };
      }
      await asDb();
      const cur = acc && acc.current;
      const sim = E.cbSimulate(d, events, simCfg);
      const mine = cur && {
        base: cur.base, comp: cur.comp, blocked: cur.blocked, paid: cur.paid, adminStatus: cur.adminStatus,
        daysToDue: cur.daysToDue, daysToBlock: cur.daysToBlock, today: cur.idx.today, due: cur.idx.due,
        blockDay: cur.idx.blockDay, rejected: cur.paid ? null : cur.rejected,
        paidDay: cur.paid ? cur.idx.paidDay : null, reviewDay: cur.idx.reviewDay,
        blockedSince: cur.blocked ? cur.idx.blockedSince : null,
      };
      const want = {
        base: sim.base, comp: sim.comp, blocked: sim.blocked, paid: sim.paid, adminStatus: sim.adminStatus,
        daysToDue: sim.daysToDue, daysToBlock: sim.daysToBlock, today: sim.today, due: sim.due,
        blockDay: sim.blockDay, rejected: sim.paid ? null : sim.rejected,
        paidDay: sim.paid ? sim.paidDay : null, reviewDay: sim.reviewDay,
        blockedSince: sim.blocked ? sim.blockedSince : null,
      };
      if (JSON.stringify(mine) !== JSON.stringify(want)) diffs.push({ d, mine, want });
      // la pausa en la base = la pausa del diseño
      const paused = (await one(`SELECT public.billing_is_paused($1) AS p`, [fx.aux])).p;
      if (paused !== sim.blocked) diffs.push({ d, paused, simBlocked: sim.blocked });
    }
    check(`${nombre}: estado día a día = cbSimulate (días 0–${lastDay})`, diffs.length === 0, diffs.slice(0, 2));

    // Avisos: clave + día + destinatario
    const al = await q(`SELECT audience, key, day_index, title, body, payload, pushed FROM public.billing_alerts WHERE statement_id = $1`, [stmt.id]);
    const sim = E.cbSimulate(lastDay, events, simCfg);
    const fmt = (arr, aud) => arr.map(a => `${aud}:${a.day}:${a.key}`).sort();
    const got = [...fmt(al.filter(a => a.audience === 'aux').map(a => ({ day: a.day_index, key: a.key })), 'aux'),
                 ...fmt(al.filter(a => a.audience === 'admin').map(a => ({ day: a.day_index, key: a.key })), 'adm')].sort();
    const want = [...fmt(sim.aux, 'aux'), ...fmt(sim.adm, 'adm')].sort();
    check(`${nombre}: avisos (clave+día) = cbSimulate`, JSON.stringify(got) === JSON.stringify(want),
      { sobran: got.filter(x => !want.includes(x)), faltan: want.filter(x => !got.includes(x)) });

    // Texto de cada aviso = CB_ALERTS del diseño con los datos de la cuenta
    const malos = [];
    for (const a of al) {
      const simA = [...sim.aux, ...sim.adm].find(s => s.key === a.key && s.day === a.day_index) || {};
      const ctx = E.cbCtx(simCfg, { ...simA, ...(a.payload || {}) });
      const def = E.CB_ALERTS[a.key];
      let wantTitle = def.title(ctx), wantBody = def.body(ctx);
      // El diseño escribe a mano «Próximo cobro: 14 nov.»; con cbFmt real es «14 de nov».
      if (a.key === 'aprobado' && !ctx.wasBlocked) wantBody = `Octubre quedó al día. Próximo cobro: ${E.cbFmt(31)}.`;
      if (a.title !== wantTitle || a.body !== wantBody) malos.push({ key: a.key, got: [a.title, a.body], want: [wantTitle, wantBody] });
    }
    check(`${nombre}: texto de los ${al.length} avisos = CB_ALERTS`, malos.length === 0, malos.slice(0, 2));
    return stmt;
  }

  const CFG = { plazo: 5, aviso: 2, gracia: 3 };
  const R = E.CB_REASONS;

  // A · sin pagar: corte → aviso → vence → vencido → último día → pausa
  await c.query('SAVEPOINT esc');
  let reservaVieja = null;
  const stA = await escenario('A · sin pagar', CFG, [], 12, {
    onDay: async (d) => {
      if (d === 0) {
        const r = await reservaComoAux();
        check('A · día 0: el tripulante reserva normal', r === null, r && r.message);
        reservaVieja = (await one(`SELECT id FROM public.reservations WHERE auxiliar_profile_id = $1 ORDER BY created_at DESC LIMIT 1`, [fx.aux])).id;
      }
      if (d === 8) {
        const r = await reservaComoAux();
        check('A · día 8 (último día de gracia): todavía reserva', r === null, r && r.message);
      }
      if (d === 9) {
        const r = await reservaComoAux();
        check('A · día 9 (pausa): el tripulante NO puede reservar (RB402)', r && r.code === 'RB402', r && [r.code, r.message]);
        check('A · el error es el texto fijo', r && r.message === 'Tus reservas están pausadas por un cobro pendiente. Tus viajes ya confirmados siguen en pie.', r && r.message);
        pauseErr = r ? { code: r.code, message: r.message, hint: r.hint } : null;
        await asUser(c, jefe, 'admin');
        const e = await debeFallar(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_h2a, required_arrival_at, residence_id)
          VALUES ($1, 'home_to_airport', 'requested', now() + interval '5 days', $2)`, [fx.aux, fx.olivar]);
        await asDb();
        check('A · el jefe SÍ le puede crear un traslado', e === null, e && e.message);
        const v = await one(`SELECT cancelled_at FROM public.reservations WHERE id = $1`, [reservaVieja]);
        check('A · lo ya pedido sigue en pie', v && v.cancelled_at === null);
        const p = await one(`SELECT is_active FROM public.profiles WHERE id = $1`, [fx.auxUser]);
        check('A · la pausa NO toca la suspensión (is_active sigue true)', p.is_active === true);
        const ab = await one(`SELECT paused_at FROM public.auxiliar_billing WHERE auxiliar_profile_id = $1`, [fx.aux]);
        check('A · la cuenta queda marcada paused_at', ab.paused_at !== null);
        // outbox
        const ob = await q(`SELECT o.profile_id, o.url, o.dedupe_key, o.send_after, a.key
            FROM public.notification_outbox o JOIN public.billing_alerts a ON o.dedupe_key LIKE 'bill:' || a.id::text || ':%'
           WHERE a.statement_id = (SELECT id FROM public.billing_statements WHERE auxiliar_profile_id = $1)`, [fx.aux]);
        const k = ob.map(o => o.key);
        check('A · push al tripulante: generado, recordatorio, venceHoy, vencido, ultimoDia, bloqueado',
          ['generado', 'recordatorio', 'venceHoy', 'vencido', 'ultimoDia', 'bloqueado'].every(x => ob.some(o => o.key === x && o.profile_id === fx.auxUser && o.url === '/#/pagos')), k);
        check('A · admMora sin push (solo Centro)', !k.includes('admMora'));
        check('A · admBloqueado con push a la jefa de SU org (y no a la otra)',
          ob.some(o => o.key === 'admBloqueado' && o.profile_id === jefe) && !ob.some(o => o.profile_id === jefe2), ob.filter(o => o.key === 'admBloqueado'));
        const vh = await one(`SELECT (o.send_after = ('2026-10-19 08:00'::timestamp AT TIME ZONE 'America/Bogota')) AS ok, o.send_after::text s
            FROM public.notification_outbox o JOIN public.billing_alerts a ON o.dedupe_key LIKE 'bill:' || a.id::text || ':%'
           WHERE a.key = 'venceHoy' AND a.auxiliar_profile_id = $1`, [fx.aux]);
        check('A · venceHoy sale a las 8:00 a. m. de Bogotá del día del vencimiento', vh && vh.ok, vh && vh.s);
        // idempotencia
        const antes = await one(`SELECT (SELECT count(*) FROM public.billing_alerts) a, (SELECT count(*) FROM public.notification_outbox) o`);
        await runJob(); await runJob();
        const desp = await one(`SELECT (SELECT count(*) FROM public.billing_alerts) a, (SELECT count(*) FROM public.notification_outbox) o`);
        check('A · correr el reloj otra vez el mismo día no repite avisos ni push', antes.a === desp.a && antes.o === desp.o, [antes, desp]);
        const run = await one(`SELECT run_on FROM public.billing_job_runs WHERE run_on = '2026-10-23'`);
        check('A · queda la bitácora del reloj', !!run);
      }
    },
  });
  {
    const f = await one(`SELECT due_date::text d, block_date::text b, period_end::text e FROM public.billing_statements WHERE id = $1`, [stA.id]);
    check('A · fechas: vence 19 oct, pausa 23 oct, período hasta 13 nov', f.d === '2026-10-19' && f.b === '2026-10-23' && f.e === '2026-11-13', f);
  }
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // Suspensión + pausa: gana el mensaje de la suspensión (0081 intacta)
  await c.query('SAVEPOINT esc');
  await setToday(dayISO(0)); await setAccount(CFG); await runJob();
  await setToday(dayISO(9)); await runJob();
  await q(`UPDATE public.profiles SET is_active = false WHERE id = $1`, [fx.auxUser]);
  {
    const r = await reservaComoAux();
    check('suspendido y pausado: ve el mensaje de la suspensión (42501 de 0081)', r && r.code === '42501' && /suspendida/.test(r.message), r && [r.code, r.message]);
  }
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // B · paga a tiempo
  await c.query('SAVEPOINT esc');
  await escenario('B · sube el día 3 y aprueban el 4', CFG, [{ day: 3, type: 'upload' }, { day: 4, type: 'approve' }], 10);
  {
    const pay = await one(`SELECT source, amount_cop, via_label FROM public.billing_payments WHERE auxiliar_profile_id = $1`, [fx.aux]);
    check('B · queda el pago (comprobante, $150.000, Bancolombia)', pay && pay.source === 'proof' && pay.amount_cop === 150000 && pay.via_label === 'Bancolombia', pay);
    const pr = await one(`SELECT status FROM public.billing_proofs WHERE auxiliar_profile_id = $1`, [fx.aux]);
    check('B · el comprobante queda aprobado', pr.status === 'approved');
  }
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // C · rechazo mantiene la fecha
  await c.query('SAVEPOINT esc');
  await escenario('C · rechazan el 3 (la fecha no cambia)', CFG, [{ day: 2, type: 'upload' }, { day: 3, type: 'reject', reason: R[1] }], 11);
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // D · en revisión no pausa; rechazo tardío pausa; subir estando pausado no despausa; aprobar reactiva
  await c.query('SAVEPOINT esc');
  await escenario('D · revisión sobre la fecha de pausa, rechazo tardío, aprobar reactiva', CFG, [
    { day: 7, type: 'upload' }, { day: 11, type: 'reject', reason: R[0] },
    { day: 12, type: 'upload' }, { day: 13, type: 'approve' }], 15, {
    probeDay: 12,
    onDay: async (d) => {
      if (d === 10) {
        const r = await reservaComoAux();
        check('D · día 10 con comprobante en revisión: SÍ reserva (en revisión no pausa)', r === null, r && r.message);
      }
      if (d === 11) {
        const r = await reservaComoAux();
        check('D · día 11 rechazado después de la pausa: queda pausado en el acto', r && r.code === 'RB402', r && r.message);
      }
      if (d === 12) {
        const r = await reservaComoAux();
        check('D · día 12 subió otro estando pausado: sigue pausado hasta que aprueben', r && r.code === 'RB402', r && r.message);
      }
      if (d === 13) {
        const r = await reservaComoAux();
        check('D · día 13 aprobado: vuelve a reservar', r === null, r && r.message);
        const ab = await one(`SELECT paused_at FROM public.auxiliar_billing WHERE auxiliar_profile_id = $1`, [fx.aux]);
        check('D · paused_at se limpia al aprobar', ab.paused_at === null);
      }
    },
  });
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // E · sube el día de la pausa ANTES del reloj (el día lo gana el comprobante)
  await c.query('SAVEPOINT esc');
  await escenario('E · sube el día de la pausa (antes de las 7:00)', CFG, [{ day: 9, type: 'upload', early: true }], 11);
  await c.query('ROLLBACK TO SAVEPOINT esc');
  // E2 · lo mismo pero DESPUÉS del reloj: se despausa en el acto (divergencia documentada:
  //      el aviso «bloqueado» de las 7:00 ya salió y queda en el historial).
  await c.query('SAVEPOINT esc');
  await setToday(dayISO(0)); await setAccount(CFG); await runJob();
  for (let d = 1; d <= 9; d++) { await setToday(dayISO(d)); await runJob(); }
  {
    const st = await stmtOf();
    check('E2 · a las 7:00 del día 9 quedó pausado', (await one(`SELECT public.billing_is_paused($1) p`, [fx.aux])).p === true);
    await doEvent({ type: 'upload' }, st.id, 99);
    check('E2 · sube el comprobante ese mismo día: se despausa (el día lo gana el comprobante)', (await one(`SELECT public.billing_is_paused($1) p`, [fx.aux])).p === false);
    const b = await one(`SELECT count(*)::int n FROM public.billing_alerts WHERE statement_id = $1 AND key = 'bloqueado'`, [st.id]);
    check('E2 · el aviso «bloqueado» de las 7:00 queda en el historial (ya había salido)', b.n === 1);
    await setToday(dayISO(10)); await runJob();
    check('E2 · día 10, en revisión: sigue sin pausa', (await one(`SELECT public.billing_is_paused($1) p`, [fx.aux])).p === false);
  }
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // F · marcar pagado estando pausado
  await c.query('SAVEPOINT esc');
  await escenario('F · el jefe marca pagado el día 10 (estaba pausado)', CFG, [{ day: 10, type: 'manual' }], 12);
  {
    const pay = await one(`SELECT source, via_label, recorded_by FROM public.billing_payments WHERE auxiliar_profile_id = $1`, [fx.aux]);
    check('F · pago manual con quién lo registró', pay && pay.source === 'manual' && pay.via_label === 'Efectivo' && pay.recorded_by === jefe, pay);
    const r = await reservaComoAux();
    check('F · vuelve a reservar', r === null, r && r.message);
  }
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // G–J · variantes de plazos
  for (const [nom, cfg, last] of [['G · gracia 0', { plazo: 5, aviso: 2, gracia: 0 }, 8],
                                  ['H · gracia 1', { plazo: 5, aviso: 2, gracia: 1 }, 9],
                                  ['I · aviso 0', { plazo: 5, aviso: 0, gracia: 3 }, 10],
                                  ['J · aviso ≥ plazo', { plazo: 3, aviso: 3, gracia: 2 }, 8]]) {
    await c.query('SAVEPOINT esc');
    await escenario(nom, cfg, [], last);
    await c.query('ROLLBACK TO SAVEPOINT esc');
  }

  // K · push apagada: los avisos quedan en el Centro; mora y pausa llegan igual
  await c.query('SAVEPOINT esc');
  await escenario('K · push y recordatorio apagados', CFG, [], 9, {
    before: async () => {
      await asUser(c, fx.auxUser, 'auxiliar');
      const r = (await one(`SELECT public.aux_billing_set_prefs(false, false) r`)).r;
      await asDb();
      check('K · el tripulante guarda sus preferencias', r && r.push === false && r.reminder === false, r);
    },
  });
  {
    const rows = await q(`SELECT a.key, a.pushed, (SELECT count(*)::int FROM public.notification_outbox o WHERE o.dedupe_key LIKE 'bill:' || a.id::text || ':%') n
        FROM public.billing_alerts a WHERE a.auxiliar_profile_id = $1 AND a.audience = 'aux'`, [fx.aux]);
    const by = Object.fromEntries(rows.map(r => [r.key, r]));
    check('K · generado/recordatorio/venceHoy SIN push', ['generado', 'recordatorio', 'venceHoy'].every(k => by[k] && !by[k].pushed && by[k].n === 0), rows);
    check('K · vencido/ultimoDia/bloqueado CON push (siempre llegan)', ['vencido', 'ultimoDia', 'bloqueado'].every(k => by[k] && by[k].pushed && by[k].n === 1), rows);
  }
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // =========================================================================
  console.log('\n3. Reglas sueltas');
  // =========================================================================
  const cd = await one(`SELECT public.billing_cut_date(2026, 2, 31)::text a, public.billing_next_cut('2026-01-31', 31)::text b,
      public.billing_last_cut('2026-11-10', 14)::text c, public.billing_last_cut('2026-11-14', 14)::text d,
      public.billing_next_cut('2026-11-30', 31)::text e`);
  check('corte 31 en febrero = 28; después del 31 ene viene el 28 feb', cd.a === '2026-02-28' && cd.b === '2026-02-28', cd);
  check('corte vigente: antes del 14 es el del mes pasado; el 14 es el de hoy', cd.c === '2026-10-14' && cd.d === '2026-11-14', cd);

  await c.query('SAVEPOINT esc');
  {
    // monto siguiente entra al abrir el período
    await setToday(BASE);
    await asUser(c, jefe, 'admin');
    await q(`SELECT public.admin_billing_save_account($1, 150000, 14::smallint, NULL, NULL, NULL, true, 180000, $2::date)`, [fx.aux, BASE]);
    await asDb();
    await runJob();
    const st = await stmtOf();
    const ab = await one(`SELECT amount_cop, amount_next_cop FROM public.auxiliar_billing WHERE auxiliar_profile_id = $1`, [fx.aux]);
    check('monto siguiente: la cuenta de cobro nueva sale con el monto nuevo', st.amount_cop === 180000 && ab.amount_cop === 180000 && ab.amount_next_cop === null, [st.amount_cop, ab]);
    check('plazos NULL = los de la organización por defecto (5 / 2 / 3)', st.due_days === 5 && st.notice_days === 2 && st.grace_days === 3, [st.due_days, st.notice_days, st.grace_days]);
    // descuento (p. ej. canje de Puntos)
    await asUser(c, jefe, 'admin');
    const adj = (await one(`SELECT public.admin_billing_adjust_statement($1, NULL, 30000, 'Canje Rendio Points') r`, [st.id])).r;
    await asDb();
    check('descuento: el monto a pagar baja y el aviso lo usa', adj.amountDueCOP === 150000 && adj.discountNote === 'Canje Rendio Points', adj);
    // doble comprobante / motivo obligatorio / doble revisión
    await doEvent({ type: 'upload' }, st.id, 50);
    await asUser(c, fx.auxUser, 'auxiliar');
    await q(`INSERT INTO storage.objects (bucket_id, name) VALUES ('payment-proofs', $1)`, [`${fx.org}/${fx.auxUser}/${st.id}/otro.jpg`]);
    let e = await debeFallar(`SELECT public.aux_billing_submit_proof($1, $2, 'Nequi')`, [st.id, `${fx.org}/${fx.auxUser}/${st.id}/otro.jpg`]);
    check('no sube un segundo comprobante mientras hay uno en revisión', e && /en revisión/.test(e.message), e && e.message);
    e = await debeFallar(`SELECT public.aux_billing_submit_proof($1, $2, 'Nequi')`, [st.id, `${fx.org}/${fx.auxUser}/${st.id}/no-existe.jpg`]);
    check('no registra un comprobante cuyo archivo no está en el bucket', e !== null, e && e.message);
    await asUser(c, jefe, 'admin');
    const pr = await one(`SELECT id FROM public.billing_proofs WHERE statement_id = $1 AND status = 'review'`, [st.id]);
    e = await debeFallar(`SELECT public.admin_billing_review_proof($1, false, NULL)`, [pr.id]);
    check('rechazar sin motivo: no se puede', e && /motivo/.test(e.message), e && e.message);
    e = await debeFallar(`SELECT public.admin_billing_review_proof($1, false, 'Porque sí')`, [pr.id]);
    check('rechazar con un motivo fuera de la lista: no se puede', e && /motivo/.test(e.message), e && e.message);
    await q(`SELECT public.admin_billing_review_proof($1, true, NULL)`, [pr.id]);
    e = await debeFallar(`SELECT public.admin_billing_review_proof($1, false, $2)`, [pr.id, R[0]]);
    check('un comprobante ya revisado no se vuelve a revisar', e && /ya fue revisado/.test(e.message), e && e.message);
    e = await debeFallar(`SELECT public.admin_billing_mark_paid($1)`, [st.id]);
    check('una cuenta pagada no se marca pagada dos veces', e && /ya está pagada/.test(e.message), e && e.message);
    const pay = await one(`SELECT amount_cop FROM public.billing_payments WHERE statement_id = $1`, [st.id]);
    check('el pago registra el monto con descuento', pay.amount_cop === 150000, pay);
    await asDb();
  }
  await c.query('ROLLBACK TO SAVEPOINT esc');

  await c.query('SAVEPOINT esc');
  {
    // starts_on: no se cobra hacia atrás; abrir a mano con fecha vieja deja todo al día
    await setToday('2026-10-25');
    await asUser(c, jefe, 'admin');
    await q(`SELECT public.admin_billing_save_account($1, 150000, 14::smallint, NULL, NULL, NULL, true, NULL, '2026-10-20'::date)`, [fx.aux]);
    await asDb();
    await runJob();
    const n0 = await one(`SELECT count(*)::int n FROM public.billing_statements WHERE auxiliar_profile_id = $1`, [fx.aux]);
    check('alta el 20 con corte el 14: el reloj NO cobra el 14 hacia atrás', n0.n === 0, n0);
    await asUser(c, jefe, 'admin');
    const r = (await one(`SELECT public.admin_billing_open_statement($1) r`, [fx.aux])).r;
    await asDb();
    check('abrir a mano el corte vigente (14 oct) el 25: queda pausado ya (pasó el 23)', r.periodStart === '2026-10-14' && r.blocked === true && r.base === 'bloqueado', [r.periodStart, r.base]);
    const g = await one(`SELECT pushed FROM public.billing_alerts WHERE auxiliar_profile_id = $1 AND key = 'generado'`, [fx.aux]);
    check('…y el aviso «generado» de un corte viejo queda en el Centro sin push', g && g.pushed === false, g);
    // corte por defecto = día de ingreso
    await asDb();
    await q(`UPDATE public.auxiliar_profiles SET joined_at = '2026-03-09' WHERE id = $1`, [fx.vecino]);
    await asUser(c, jefe, 'admin');
    const acc = (await one(`SELECT public.admin_billing_save_account($1, 150000) r`, [fx.vecino])).r;
    await asDb();
    check('sin día de corte: toma el día en que ingresó (9)', acc.cut_day === 9, acc.cut_day);
    check('referencia AUX-#### propia', /^AUX-\d{4,}$/.test(acc.reference), acc.reference);
  }
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // =========================================================================
  console.log('\n4. RLS: dos tripulantes, un jefe (y un jefe de otra organización)');
  // =========================================================================
  await c.query('SAVEPOINT esc');
  {
    await setToday(BASE);
    await setAccount(CFG);
    await setAccount(CFG, { aux: fx.vecino });
    await runJob();
    const stL = await stmtOf(fx.aux), stV = await stmtOf(fx.vecino);
    await doEvent({ type: 'upload' }, stL.id, 70);
    const pathL = (await one(`SELECT storage_path FROM public.billing_proofs WHERE statement_id = $1`, [stL.id])).storage_path;
    await setToday(dayISO(1)); await runJob();

    // métodos y configuración
    await asUser(c, jefe, 'admin');
    await q(`INSERT INTO public.billing_settings (organization_id, holder_name, holder_nit) VALUES ($1, 'Titular de prueba', '900.000.000-1')`, [fx.org]);
    await q(`INSERT INTO public.billing_payment_methods (organization_id, kind, label, account_type, account_number, position) VALUES ($1, 'bank', 'Banco prueba', 'Ahorros', '000-1', 0)`, [fx.org]);
    await q(`INSERT INTO public.billing_payment_methods (organization_id, kind, label, account_number, position, active) VALUES ($1, 'nequi', 'Nequi', '300', 1, false)`, [fx.org]);
    let e = await debeFallar(`INSERT INTO public.billing_payment_methods (organization_id, label, account_number) VALUES ($1, 'Ajeno', '1')`, [fx2.org]);
    check('el jefe NO crea métodos de pago en otra organización', e !== null);
    await asUser(c, jefe2, 'admin');
    await q(`INSERT INTO public.billing_payment_methods (organization_id, label, account_number) VALUES ($1, 'De la otra org', '9')`, [fx2.org]);

    // Laura
    await asUser(c, fx.auxUser, 'auxiliar');
    const L = {
      ab: await q(`SELECT auxiliar_profile_id FROM public.auxiliar_billing`),
      st: await q(`SELECT auxiliar_profile_id FROM public.billing_statements`),
      pr: await q(`SELECT auxiliar_profile_id FROM public.billing_proofs`),
      al: await q(`SELECT audience, auxiliar_profile_id FROM public.billing_alerts`),
      me: await q(`SELECT label FROM public.billing_payment_methods`),
      cfg: await q(`SELECT holder_name FROM public.billing_settings`),
      obj: await q(`SELECT name FROM storage.objects WHERE bucket_id = 'payment-proofs'`),
    };
    check('tripulante: ve SOLO su cuenta', L.ab.length === 1 && L.ab[0].auxiliar_profile_id === fx.aux, L.ab);
    check('tripulante: ve SOLO sus cuentas de cobro', L.st.length === 1 && L.st[0].auxiliar_profile_id === fx.aux, L.st);
    check('tripulante: ve SOLO sus comprobantes', L.pr.length === 1 && L.pr[0].auxiliar_profile_id === fx.aux, L.pr);
    check('tripulante: ve SOLO sus avisos, y ninguno de los del jefe', L.al.length > 0 && L.al.every(a => a.audience === 'aux' && a.auxiliar_profile_id === fx.aux), L.al.length);
    check('tripulante: ve los métodos ACTIVOS de su org (no el inactivo ni los de otra org)', L.me.length === 1 && L.me[0].label === 'Banco prueba', L.me);
    check('tripulante: lee titular y NIT de su org', L.cfg.length === 1 && L.cfg[0].holder_name === 'Titular de prueba', L.cfg);
    check('tripulante: ve SOLO su archivo en el bucket', L.obj.length === 1 && L.obj[0].name === pathL, L.obj);
    e = await debeFallar(`INSERT INTO public.billing_statements (organization_id, auxiliar_profile_id, period_start, period_end, amount_cop, due_days, notice_days, grace_days)
      VALUES ($1, $2, '2026-12-14', '2027-01-13', 1, 5, 2, 3)`, [fx.org, fx.aux]);
    check('tripulante: NO crea cuentas de cobro a mano', e !== null);
    e = await debeFallar(`UPDATE public.billing_statements SET paid_at = now(), paid_on = current_date WHERE id = $1`, [stL.id]);
    check('tripulante: NO se marca pagado a mano', e !== null);
    e = await debeFallar(`UPDATE public.auxiliar_billing SET amount_cop = 1 WHERE auxiliar_profile_id = $1`, [fx.aux]);
    check('tripulante: NO cambia su monto', e !== null);
    e = await debeFallar(`INSERT INTO public.billing_payment_methods (organization_id, label, account_number) VALUES ($1, 'X', '1')`, [fx.org]);
    check('tripulante: NO crea métodos de pago', e !== null);
    e = await debeFallar(`UPDATE public.billing_settings SET holder_name = 'X'`);
    const cfgAfter = await one(`SELECT holder_name FROM public.billing_settings`);
    check('tripulante: NO cambia la configuración', e !== null || cfgAfter.holder_name === 'Titular de prueba');
    e = await debeFallar(`SELECT public.admin_billing_list()`);
    check('tripulante: NO usa las funciones del jefe', e && e.code === '42501', e && e.message);
    e = await debeFallar(`SELECT public.billing_run_daily()`);
    check('tripulante: NO corre el reloj', e !== null);
    e = await debeFallar(`INSERT INTO storage.objects (bucket_id, name) VALUES ('payment-proofs', $1)`, [`${fx.org}/${fx.vecinoUser}/${stV.id}/ajeno.jpg`]);
    check('tripulante: NO sube a la carpeta de otro', e !== null);
    e = await debeFallar(`INSERT INTO storage.objects (bucket_id, name) VALUES ('payment-proofs', $1)`, [`${fx2.org}/${fx.auxUser}/x/ajeno.jpg`]);
    check('tripulante: NO sube a otra organización', e !== null);
    const acc = (await one(`SELECT public.aux_billing_my_account() a`)).a;
    check('tripulante: mi cuenta trae referencia, monto, titular y la cuenta de cobro vigente',
      acc && /^AUX-/.test(acc.reference) && acc.amountCOP === 150000 && acc.holderNit === '900.000.000-1' && acc.current && acc.current.id === stL.id, acc && Object.keys(acc));
    check('tripulante: avisos sin leer', acc.unread > 0, acc.unread);
    await q(`SELECT public.aux_billing_mark_seen()`);
    const acc2 = (await one(`SELECT public.aux_billing_my_account() a`)).a;
    check('tripulante: marcar vistos deja 0 sin leer', acc2.unread === 0, acc2.unread);
    const hist = (await one(`SELECT public.aux_billing_history() h`)).h;
    check('tripulante: historial solo con lo suyo', hist.length === 1 && hist[0].id === stL.id, hist.length);

    // la vecina
    await asUser(c, fx.vecinoUser, 'auxiliar');
    const V = {
      st: await q(`SELECT id FROM public.billing_statements`),
      pr: await q(`SELECT id FROM public.billing_proofs`),
      obj: await q(`SELECT name FROM storage.objects WHERE bucket_id = 'payment-proofs'`),
    };
    check('la otra tripulante NO ve las cuentas de cobro de Laura', V.st.length === 1 && V.st[0].id === stV.id, V.st);
    check('la otra tripulante NO ve comprobantes ajenos', V.pr.length === 0, V.pr);
    check('la otra tripulante NO ve el archivo de Laura en el bucket', V.obj.length === 0, V.obj);
    e = await debeFallar(`SELECT public.aux_billing_submit_proof($1, $2, 'Nequi')`, [stL.id, pathL]);
    check('la otra tripulante NO registra comprobantes en la cuenta de Laura', e && e.code === '42501', e && e.message);
    const accV = (await one(`SELECT public.aux_billing_my_account() a`)).a;
    check('la otra tripulante: su propia cuenta', accV && accV.current && accV.current.id === stV.id);

    // la jefa
    await asUser(c, jefe, 'admin');
    const list = (await one(`SELECT public.admin_billing_list() l`)).l;
    const laura = list.find(x => x.auxiliarProfileId === fx.aux);
    check('jefa: lista a los tripulantes de SU org (2) y no los de otra', list.length === 2 && list.every(x => [fx.aux, fx.vecino].includes(x.auxiliarProfileId)), list.map(x => x.name));
    check('jefa: Laura primero, con el comprobante por revisar', list[0].auxiliarProfileId === fx.aux && laura.proofInReview && laura.current.adminStatus === 'review', list[0].name);
    const J = {
      st: await q(`SELECT id FROM public.billing_statements`),
      obj: await q(`SELECT name FROM storage.objects WHERE bucket_id = 'payment-proofs'`),
      al: await q(`SELECT audience FROM public.billing_alerts`),
      me: await q(`SELECT label FROM public.billing_payment_methods`),
    };
    check('jefa: ve las cuentas de cobro de su org (2)', J.st.length === 2, J.st.length);
    check('jefa: ve el archivo del comprobante', J.obj.length === 1 && J.obj[0].name === pathL, J.obj);
    check('jefa: ve solo los avisos del jefe (admRevisar)', J.al.length > 0 && J.al.every(a => a.audience === 'admin'), J.al);
    check('jefa: ve TODOS los métodos de su org (también el inactivo) y no los de otra', J.me.length === 2 && !J.me.some(m => m.label === 'De la otra org'), J.me);
    const det = (await one(`SELECT public.admin_billing_detail($1) d`, [fx.aux])).d;
    check('jefa: detalle con cuentas de cobro y comprobantes', det.statements.length === 1 && det.proofs.length === 1, det);
    const proofs = (await one(`SELECT public.admin_billing_proofs() p`)).p;
    check('jefa: cola de comprobantes por revisar (1) con el nombre', proofs.length === 1 && proofs[0].name === 'Laura Gómez', proofs);

    // el jefe de otra org
    await asUser(c, jefe2, 'admin');
    const list2 = (await one(`SELECT public.admin_billing_list() l`)).l;
    check('jefe de otra org: su lista no trae a Laura ni a la vecina', !list2.some(x => [fx.aux, fx.vecino].includes(x.auxiliarProfileId)), list2.map(x => x.name));
    const O = {
      st: await q(`SELECT id FROM public.billing_statements`),
      obj: await q(`SELECT name FROM storage.objects WHERE bucket_id = 'payment-proofs'`),
      al: await q(`SELECT id FROM public.billing_alerts`),
    };
    check('jefe de otra org: NO ve cuentas de cobro, archivos ni avisos ajenos', O.st.length === 0 && O.obj.length === 0 && O.al.length === 0, O);
    const prL = await asDb().then(() => one(`SELECT id FROM public.billing_proofs WHERE statement_id = $1`, [stL.id]));
    await asUser(c, jefe2, 'admin');
    e = await debeFallar(`SELECT public.admin_billing_review_proof($1, true)`, [prL.id]);
    check('jefe de otra org: NO aprueba comprobantes ajenos', e && e.code === '42501', e && e.message);
    e = await debeFallar(`SELECT public.admin_billing_save_account($1, 1)`, [fx.aux]);
    check('jefe de otra org: NO edita cuentas ajenas', e && e.code === '42501', e && e.message);
    e = await debeFallar(`SELECT public.admin_billing_mark_paid($1)`, [stL.id]);
    check('jefe de otra org: NO marca pagado ajeno', e && e.code === '42501', e && e.message);

    // anon
    await asDb();
    await c.query(`SET LOCAL ROLE anon`);
    e = await debeFallar(`SELECT count(*) FROM public.billing_statements`);
    check('anon: no lee nada', e !== null);
    e = await debeFallar(`SELECT public.aux_billing_my_account()`);
    check('anon: no llama las RPC', e !== null);
    await asDb();
  }
  await c.query('ROLLBACK TO SAVEPOINT esc');

  // =========================================================================
  console.log('\n5. api-cobro.js');
  // =========================================================================
  {
    const calls = [];
    const respond = { aux_billing_my_account: apiProbe && apiProbe.acc, aux_billing_submit_proof: { proofId: 'p1', statement: null } };
    const fakeSb = {
      rpc: async (fn, args) => { calls.push(['rpc', fn, args]); return { data: respond[fn] ?? null, error: null }; },
      auth: { getSession: async () => ({ data: { session: { user: { id: 'UID-1' } } } }) },
      storage: { from: (b) => ({
        upload: async (p, f, o) => { calls.push(['upload', b, p, o]); return { data: { path: p }, error: null }; },
        createSignedUrl: async (p, s) => ({ data: { signedUrl: 'https://x/' + p + '?e=' + s }, error: null }),
      }) },
      from: () => { throw new Error('no se usa en esta prueba'); },
    };
    const ctx = { window: {}, console, Date, Math, JSON, Promise, Error, String, Number, Object, Array, isFinite, RegExp };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(API_COBRO, 'utf8'), ctx, { filename: 'api-cobro.js' });
    const A = ctx.window.ApiCobro;
    const want = ['myAccount', 'history', 'methods', 'alerts', 'markAlertsSeen', 'setPrefs', 'uploadProof', 'proofUrl', 'reasons',
      'adminList', 'adminDetail', 'adminSaveAccount', 'adminOpenStatement', 'adminAdjust', 'adminProofs', 'adminApprove', 'adminReject',
      'adminMarkPaid', 'adminSettings', 'adminSaveSettings', 'adminMethods', 'adminSaveMethod', 'adminSetMethodActive', 'adminDeleteMethod',
      'adminAlerts', 'adminLastRun', 'toSim', 'statusOf', 'isPausedError', 'money', 'fmtDay', 'hasAccount', 'last'];
    const faltan = A ? want.filter(k => typeof A[k] !== 'function') : want;
    check('window.ApiCobro exporta el contrato (tripulante + jefe + utilidades)', faltan.length === 0, faltan);
    check('se evalúa sin window.sb (no lo lee al cargar)', !!A);
    if (A) {
      check('money = cbMoney y fmtDay = cbFmt', A.money(150000) === E.cbMoney(150000) && A.fmtDay('2026-10-19') === E.cbFmt(5) && A.fmtDay('2026-09-14') === '14 de sept');
      check('REASONS = CB_REASONS', JSON.stringify([...A.REASONS]) === JSON.stringify([...E.CB_REASONS]));
      ctx.window.sb = fakeSb;
      const acc = await A.myAccount();
      check('myAccount devuelve lo de la RPC y lo guarda (hasAccount)', acc && A.hasAccount() && A.last() === acc);
      if (apiProbe && apiProbe.acc) {
        const alerts = apiProbe.alerts.map(a => ({ id: a.id, statementId: a.statement_id, key: a.key, dayIndex: a.day_index, payload: a.payload, title: a.title, body: a.body, createdAt: a.created_at }));
        const t = A.toSim(apiProbe.acc, alerts);
        const s = apiProbe.sim;
        const pick = o => ({ today: o.today, due: o.due, blockDay: o.blockDay, base: o.base, comp: o.comp, blocked: o.blocked,
          paid: o.paid, daysToDue: o.daysToDue, daysToBlock: o.daysToBlock, adminStatus: o.adminStatus, rejected: o.rejected, reviewDay: o.reviewDay });
        check('toSim(datos reales de la base) = cbSimulate (escenario D, día 12)', JSON.stringify(pick(t.sim)) === JSON.stringify(pick(s)), [pick(t.sim), pick(s)]);
        const ka = t.sim.aux.map(a => a.day + ':' + a.key).sort(), kb = s.aux.map(a => a.day + ':' + a.key).sort();
        check('toSim: sim.aux (avisos) = cbSimulate.aux', JSON.stringify(ka) === JSON.stringify(kb), [ka, kb]);
        check('toSim: cfg = CB_CFG con los datos de la cuenta', t.cfg.plazo === 5 && t.cfg.aviso === 2 && t.cfg.gracia === 3 && t.cfg.monto === 150000);
        check('toSim: dates.at(d) = la fecha real de cbFmt(d)', A.fmtDay(t.dates.at(9)) === E.cbFmt(9) && t.dates.block === '2026-10-23');
        check('statusOf: pausado con comprobante en revisión → «review» (precedencia de cbBanner)', A.statusOf(apiProbe.acc.current) === 'review', A.statusOf(apiProbe.acc.current));
      } else check('hubo foto real para probar toSim', false);
      check('statusOf: rechazado sin pausa → «rejected»; pausado y rechazado → «bloqueado»',
        A.statusOf({ comp: 'rejected', blocked: false, base: 'vencido' }) === 'rejected' && A.statusOf({ comp: 'rejected', blocked: true, base: 'bloqueado' }) === 'bloqueado');
      check('isPausedError reconoce el error REAL de la base', !!pauseErr && A.isPausedError(pauseErr) && !A.isPausedError({ code: '42501', message: 'Tu cuenta está suspendida' }), pauseErr);
      calls.length = 0;
      const r = await A.uploadProof({ type: 'image/jpeg', size: 1000, name: 'x.jpg' }, { statementId: 'ST-1', viaLabel: 'Nequi' });
      const up = calls.find(x => x[0] === 'upload');
      const sub = calls.find(x => x[0] === 'rpc' && x[1] === 'aux_billing_submit_proof');
      check('uploadProof sube a payment-proofs/{org}/{uid}/{cuenta}/…jpg sin reemplazar', up && up[1] === 'payment-proofs'
        && new RegExp('^' + apiProbe.acc.organizationId + '/UID-1/ST-1/[a-z0-9-]+\\.jpg$').test(up[2]) && up[3].upsert === false, up);
      check('…y registra con la misma ruta', sub && sub[2].p_storage_path === up[2] && sub[2].p_via_label === 'Nequi' && r.proofId === 'p1', sub);
      let err = null; try { await A.uploadProof({ type: 'text/plain', size: 10, name: 'a.txt' }, { statementId: 'S', viaLabel: 'Nequi' }); } catch (x) { err = x; }
      check('uploadProof rechaza lo que no es foto ni PDF', err && /foto/.test(err.message));
      calls.length = 0; err = null;
      try { await A.adminReject('P', 'Porque sí'); } catch (x) { err = x; }
      check('adminReject exige un motivo de la lista (sin llamar al servidor)', err && calls.length === 0);
      await A.adminReject('P', E.CB_REASONS[2]);
      check('adminReject manda el motivo', calls.some(x => x[1] === 'admin_billing_review_proof' && x[2].p_reason === E.CB_REASONS[2] && x[2].p_approve === false));
    }
  }
} catch (e) {
  fail++;
  console.log(`  ✗ la verificación se cayó: ${e.message}`);
} finally {
  await c.query('ROLLBACK').catch(() => {});
  await c.end();
}

console.log(`\n${ok} ✓ · ${fail} ✗`);
console.log('NO cubre: la push real (drain + VAPID), la subida por la API de Storage, pg_cron corriendo de verdad a las 7:00, ni pantallas.');
process.exit(fail ? 1 : 0);
