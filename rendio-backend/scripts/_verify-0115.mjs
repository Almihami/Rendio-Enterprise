// Verificación de 0115 (abrir varias cuentas de cobro, «plazo desde hoy» y el
// comprobante que sube el jefe) contra la base LOCAL (127.0.0.1:54322).
//
//   cd rendio-backend/scripts && node _verify-0115.mjs
//
// La migración se aplica DENTRO de una transacción que se deshace al final: en la
// base local no queda ni 0115 ni ningún dato. Nunca apunta a dev ni a producción
// (_local-fixtures se niega).
//
// Plazos como los de producción hoy: 3 días para pagar, aviso 1 día antes, 2 de
// gracia. Hoy = 22-oct-2026.
//
// Qué prueba:
//   1. Abrir varias, con la fecha de su corte: corte 21 → vence el 24 (al día);
//      corte 1 → vencida y PAUSADA de una vez (lo que le pasó hoy a uno en producción).
//   2. Abrir varias «desde hoy»: misma cuenta del corte (1-oct) pero vence el 25-oct,
//      sin pausa; el aviso «está lista» dice la fecha nueva y sale con push.
//   3. A quién NO se le abre, con el motivo: sin cuenta, apagada, sin valor, ya la
//      tiene, de otra organización (y nada de eso tumba a los demás).
//   4. El reloj después: no abre una segunda cuenta del mismo corte (no se cobra
//      dos veces), y pausa en la fecha NUEVA con su aviso de pausa.
//   5. «Avisar» apagado: el aviso queda en la app, sin push.
//   6. «Plazo desde hoy» sobre la pausada: se despausa, vence en 3 días, los avisos
//      de vencido/pausa se borran y el «está lista» sale de nuevo con push.
//   7. Marcar pagado con comprobante del jefe: el archivo queda como comprobante
//      aprobado, enviado el día del pago; la cuenta al día; el tripulante lo ve
//      (lastProof aprobado → «Tu comprobante» en su app); el pago apunta al comprobante.
//   8. Errores: ruta de otra cuenta, archivo que no existe, ya pagada, fecha futura,
//      comprobante del tripulante en revisión, alguien que no es jefe.
//   9. El bucket: el jefe sube a carpetas de SU organización y no a otra; el
//      tripulante sigue sin poder subir a la carpeta de otro.
//
// NO cubre: la pantalla (eso es _smoke-admin-cobro-dom.mjs), la subida real al
// Storage (aquí la fila de storage.objects se crea a mano), la push de verdad,
// pg_cron real, ni la base de producción.
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
async function runJob() { await asDb(); return (await one(`SELECT public.billing_run_daily() AS r`)).r; }
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d == null ? null : String(d).slice(0, 10));
const stmts = async (aux) => q(`SELECT *, period_start::text ps, due_date::text due, block_date::text blk FROM public.billing_statements
                                 WHERE auxiliar_profile_id = $1 ORDER BY period_start`, [aux]);
const alertas = async (stId) => q(`SELECT key, pushed, body, day::text AS dia FROM public.billing_alerts WHERE statement_id = $1 ORDER BY created_at`, [stId]);
const outbox = async (prof, like) => q(`SELECT title, body FROM public.notification_outbox WHERE profile_id = $1 AND title ILIKE $2`, [prof, like]);

await c.query('BEGIN');
try {
  const sql = fs.readFileSync(new URL('../supabase/migrations/0115_cobro_abrir_varias_y_comprobante_del_jefe.sql', import.meta.url), 'utf8')
    .replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
  await c.query(sql);
  await c.query(sql);                                  // idempotente: correrla dos veces no falla
  check('0115 se aplica (y se puede volver a correr)', true);

  const fx = await fixtures(c);
  const jefe = await user(c, fx.org, 'admin', 'Jefa de prueba 0115');
  await setToday('2026-10-22');
  await q(`INSERT INTO public.billing_settings (organization_id, due_days, notice_days, grace_days)
           VALUES ($1, 3, 1, 2) ON CONFLICT (organization_id) DO UPDATE SET due_days = 3, notice_days = 1, grace_days = 2`, [fx.org]);

  // Tripulantes: los de El Olivar (Rionegro, con tarifa) y uno de Llanogrande (sin tarifa).
  const nuevo = async (name, res) => {
    const u = await user(c, fx.org, 'auxiliar', name);
    const a = (await one(`INSERT INTO public.auxiliar_profiles (profile_id, residence_id) VALUES ($1, $2) RETURNING id`, [u, res])).id;
    return { u, a };
  };
  const A = { u: fx.auxUser, a: fx.aux };                                   // corte 21, desde 21-oct
  const B = { u: fx.vecinoUser, a: fx.vecino };                             // corte 1, cobra desde 1-nov (como los 60 de producción)
  const C = await nuevo('Cata corte 1 desde hoy', fx.olivar);               // corte 1, desde 1-nov, abierta «desde hoy»
  const D = await nuevo('Dani sin cuenta', fx.olivar);
  const E = await nuevo('Eli sin valor', fx.llano);
  const F = await nuevo('Fer cuenta apagada', fx.olivar);
  const G = await nuevo('Gabi ya la tiene', fx.olivar);
  const H = await nuevo('Hugo corte 1 desde octubre', fx.olivar);           // corte 1, cobra desde 1-oct (el reloj SÍ lo abriría)
  const I = await nuevo('Isa sin avisar', fx.olivar);
  const org2 = (await one(`INSERT INTO public.organizations (name, slug) VALUES ('Otra org', 'otra-' || substr(md5(random()::text), 1, 6)) RETURNING id`)).id;
  const otroU = await user(c, org2, 'auxiliar', 'De otra organización');
  const OTRO = (await one(`INSERT INTO public.auxiliar_profiles (profile_id, residence_id) VALUES ($1, $2) RETURNING id`, [otroU, fx.olivar])).id;

  await asUser(c, jefe, 'admin');
  await q(`SELECT public.admin_billing_save_sector_rate('Rionegro', 470000, 20000)`);
  const cuenta = (aux, cut, starts, active = true) => q(
    `SELECT public.admin_billing_save_account($1, NULL, $2::smallint, NULL, NULL, NULL, $3, NULL, $4::date)`, [aux, cut, active, starts]);
  await cuenta(A.a, 21, '2026-10-21');
  await cuenta(B.a, 1, '2026-11-01');
  await cuenta(C.a, 1, '2026-11-01');
  await cuenta(E.a, 1, '2026-10-01');
  await cuenta(F.a, 21, '2026-10-21', false);
  await cuenta(G.a, 21, '2026-10-21');
  await cuenta(H.a, 1, '2026-10-01');
  await cuenta(I.a, 21, '2026-10-21');
  await q(`SELECT public.admin_billing_open_statement($1)`, [G.a]);

  // ── 1 + 3. Con la fecha de su corte ─────────────────────────────────────
  console.log('\n1. Abrir varias con la fecha de su corte (y a quién no)');
  const r1 = (await one(`SELECT public.admin_billing_open_statements($1::uuid[], false, true) AS r`,
    [[A.a, B.a, D.a, E.a, F.a, G.a, OTRO, A.a]])).r;
  await asDb();                                        // leer avisos y cola como la base (RLS aparte)
  const opened1 = Object.fromEntries(r1.opened.map(x => [x.auxiliarProfileId, x]));
  const skip1 = Object.fromEntries(r1.skipped.map(x => [x.auxiliarProfileId, x.reason]));
  check('abre 2 (A y B) aunque A venga repetido', r1.opened.length === 2 && opened1[A.a] && opened1[B.a], r1.opened);
  check('A (corte 21): período 21-oct, vence 24-oct, al día', opened1[A.a] && iso(opened1[A.a].periodStart) === '2026-10-21'
    && iso(opened1[A.a].dueDate) === '2026-10-24' && opened1[A.a].blocked === false, opened1[A.a]);
  check('B (corte 1): vencida y PAUSADA de una vez (vencía el 4-oct)', opened1[B.a] && iso(opened1[B.a].dueDate) === '2026-10-04'
    && opened1[B.a].blocked === true, opened1[B.a]);
  check('sin cuenta → «No tiene cuenta»', /No tiene cuenta/.test(skip1[D.a] || ''), skip1[D.a]);
  check('sin valor → «Sin valor»', /Sin valor/.test(skip1[E.a] || ''), skip1[E.a]);
  check('cuenta apagada → «Su cuenta está apagada»', /apagada/.test(skip1[F.a] || ''), skip1[F.a]);
  check('ya la tiene → «Ya tiene abierta la del 21 de oct»', /Ya tiene abierta la del 21 de oct/.test(skip1[G.a] || ''), skip1[G.a]);
  check('de otra organización → no se abre', /otra|organización/.test(skip1[OTRO] || ''), skip1[OTRO]);
  check('E (sin valor) no quedó con cuenta de cobro', (await stmts(E.a)).length === 0);
  const [sA] = await stmts(A.a);
  const alA = await alertas(sA.id);
  check('A: el aviso «está lista» sale con push y fecha de hoy (se abrió un día tarde)',
    alA.some(x => x.key === 'generado' && x.pushed && x.dia === '2026-10-22' && /24 de oct/.test(x.body)), alA);
  check('A: la push quedó en la cola', (await outbox(A.u, 'Tu cuenta de cobro de octubre%')).length === 1);
  const [sB] = await stmts(B.a);
  check('B: quedó pausada (reservas nuevas frenadas)', (await one(`SELECT public.billing_is_paused($1) p`, [B.a])).p === true);

  // ── 2. «Desde hoy» ───────────────────────────────────────────────────────
  console.log('\n2. Abrir «desde hoy»');
  await asUser(c, jefe, 'admin');
  const r2 = (await one(`SELECT public.admin_billing_open_statements($1::uuid[], true, true) AS r`, [[C.a, H.a]])).r;
  await asDb();
  check('abre C y H', r2.opened.length === 2, r2);
  for (const [n, X] of [['C', C], ['H', H]]) {
    const ss = await stmts(X.a);
    check(`${n}: UNA cuenta, del corte (1-oct), vence 25-oct, pausa 28-oct, sin pausa hoy`,
      ss.length === 1 && ss[0].ps === '2026-10-01' && ss[0].due === '2026-10-25' && ss[0].blk === '2026-10-28' && !ss[0].blocked_at, ss.map(s => [s.ps, s.due, s.blk]));
    const al = await alertas(ss[0].id);
    check(`${n}: un solo «está lista», con push y la fecha nueva (25 de oct)`,
      al.filter(x => x.key === 'generado').length === 1 && al.some(x => x.key === 'generado' && x.pushed && /25 de oct/.test(x.body)), al);
    check(`${n}: sin avisos de vencido ni de pausa`, !al.some(x => ['vencido', 'bloqueado', 'admBloqueado', 'admMora'].includes(x.key)), al);
  }

  // ── 5. Sin avisar ────────────────────────────────────────────────────────
  console.log('\n5. «Avisar» apagado');
  await (async () => {
    await asUser(c, jefe, 'admin');
    const r = (await one(`SELECT public.admin_billing_open_statements($1::uuid[], false, false) AS r`, [[I.a]])).r;
    await asDb();
    const [sI] = await stmts(I.a);
    const al = await alertas(sI.id);
    check('abre la cuenta', r.opened.length === 1);
    check('el aviso queda en la app pero sin push', al.some(x => x.key === 'generado' && !x.pushed), al);
    check('nada en la cola de push', (await outbox(I.u, 'Tu cuenta de cobro%')).length === 0);
  })();

  // ── 4. El reloj después ──────────────────────────────────────────────────
  console.log('\n4. El reloj después del abrir masivo');
  await runJob();
  await setToday('2026-10-23'); await runJob();
  check('C y H siguen con UNA sola cuenta de cobro (no se cobra dos veces)',
    (await stmts(C.a)).length === 1 && (await stmts(H.a)).length === 1);
  check('A sigue con una sola', (await stmts(A.a)).length === 1);
  await setToday('2026-10-28'); await runJob();
  const [sH28] = await stmts(H.a);
  check('H: el 28-oct (pausa nueva) queda pausada', !!sH28.blocked_at && (await one(`SELECT public.billing_is_paused($1) p`, [H.a])).p === true);
  check('H: le sale el aviso de pausa (se había borrado, vuelve a correr)', (await alertas(sH28.id)).some(x => x.key === 'bloqueado'));
  await setToday('2026-10-22');

  // ── 6. «Plazo desde hoy» sobre la pausada ───────────────────────────────
  console.log('\n6. «Plazo desde hoy» sobre B (pausada)');
  await asUser(c, jefe, 'admin');
  const j6 = (await one(`SELECT public.admin_billing_restart_terms($1) AS r`, [sB.id])).r;
  await asDb();
  const [sB2] = await stmts(B.a);
  check('B: vence 25-oct, sin pausa', sB2.due === '2026-10-25' && !sB2.blocked_at && j6.blocked === false, [sB2.due, sB2.blocked_at, j6.blocked]);
  await asDb();
  check('B: puede volver a reservar', (await one(`SELECT public.billing_is_paused($1) p`, [B.a])).p === false);
  const alB = await alertas(sB.id);
  check('B: se borraron los avisos de pausa y el «está lista» salió de nuevo con push',
    !alB.some(x => ['bloqueado', 'admBloqueado', 'vencido'].includes(x.key)) && alB.some(x => x.key === 'generado' && x.pushed && /25 de oct/.test(x.body)), alB);
  // (la primera push de B, al abrirla, decía el 4 de oct; esta trae la fecha nueva)
  check('B: la push «está lista» con la fecha nueva quedó en la cola',
    (await outbox(B.u, 'Tu cuenta de cobro de octubre%')).filter(x => /25 de oct/.test(x.body)).length === 1);
  await asUser(c, B.u, 'auxiliar');
  check('el tripulante no puede darse plazo', !!(await debeFallar(`SELECT public.admin_billing_restart_terms($1)`, [sB.id])));
  check('el tripulante no puede abrir cuentas en masa', !!(await debeFallar(`SELECT public.admin_billing_open_statements($1::uuid[])`, [[B.a]])));

  // ── 9. El bucket ─────────────────────────────────────────────────────────
  console.log('\n9. El bucket payment-proofs');
  const pathA = `${fx.org}/${A.u}/${sA.id}/jefe-1.jpg`;
  await asUser(c, jefe, 'admin');
  check('el jefe sube a la carpeta de un tripulante de su organización',
    !(await debeFallar(`INSERT INTO storage.objects (bucket_id, name) VALUES ('payment-proofs', $1)`, [pathA])));
  check('el jefe NO sube a otra organización',
    !!(await debeFallar(`INSERT INTO storage.objects (bucket_id, name) VALUES ('payment-proofs', $1)`, [`${org2}/${otroU}/x/y.jpg`])));
  await asUser(c, B.u, 'auxiliar');
  check('el tripulante sigue sin poder subir a la carpeta de otro',
    !!(await debeFallar(`INSERT INTO storage.objects (bucket_id, name) VALUES ('payment-proofs', $1)`, [`${fx.org}/${A.u}/${sA.id}/b.jpg`])));

  // ── 8. Errores del marcar pagado con comprobante ────────────────────────
  console.log('\n8. Errores');
  await asUser(c, jefe, 'admin');
  const mpp = `SELECT public.admin_billing_mark_paid_with_proof($1, $2, 'image/jpeg', 1234, 'Bancolombia', 470000, $3::date, NULL)`;
  const e1 = await debeFallar(mpp, [sB.id, pathA, '2026-10-21']);
  check('ruta de OTRA cuenta → «no corresponde»', e1 && /no corresponde/.test(e1.message), e1 && e1.message);
  const e2 = await debeFallar(mpp, [sA.id, `${fx.org}/${A.u}/${sA.id}/no-existe.jpg`, '2026-10-21']);
  check('archivo que no existe → «vuelve a subirlo»', e2 && /vuelve a subirlo/.test(e2.message), e2 && e2.message);
  const e3 = await debeFallar(mpp, [sA.id, pathA, '2026-10-30']);
  check('fecha futura → error', e3 && /futura/.test(e3.message), e3 && e3.message);
  // B sube su comprobante (en revisión) y el jefe intenta adjuntar otro.
  await asDb();
  const pathB = `${fx.org}/${B.u}/${sB.id}/aux-1.jpg`;
  await q(`INSERT INTO storage.objects (bucket_id, name) VALUES ('payment-proofs', $1)`, [pathB]);
  await asUser(c, B.u, 'auxiliar');
  await q(`SELECT public.aux_billing_submit_proof($1, $2, 'Nequi')`, [sB.id, pathB]);
  await asDb();
  const pathB2 = `${fx.org}/${B.u}/${sB.id}/jefe-2.jpg`;
  await q(`INSERT INTO storage.objects (bucket_id, name) VALUES ('payment-proofs', $1)`, [pathB2]);
  await asUser(c, jefe, 'admin');
  const e4 = await debeFallar(mpp, [sB.id, pathB2, '2026-10-21']);
  check('con un comprobante del tripulante en revisión → «apruébalo»', e4 && /apru[eé]balo/.test(e4.message), e4 && e4.message);
  await asUser(c, A.u, 'auxiliar');
  check('el tripulante no puede marcarse pagado', !!(await debeFallar(mpp, [sA.id, pathA, '2026-10-21'])));

  // ── 7. Marcar pagado con comprobante ─────────────────────────────────────
  console.log('\n7. Marcar pagado con el comprobante del jefe');
  await asUser(c, jefe, 'admin');
  const j7 = (await one(mpp.replace('SELECT public', 'SELECT public') + ' AS r', [sA.id, pathA, '2026-10-21'])).r;
  check('la cuenta queda pagada (a mano), el 21-oct', j7.paid === true && j7.paidVia === 'manual' && iso(j7.paidOn) === '2026-10-21', [j7.paid, j7.paidVia, j7.paidOn]);
  check('el comprobante quedó aprobado y enviado el día del pago', j7.lastProof && j7.lastProof.status === 'approved'
    && iso(j7.lastProof.submittedOn) === '2026-10-21' && j7.lastProof.path === pathA, j7.lastProof);
  await asDb();
  const bp = await one(`SELECT * FROM public.billing_proofs WHERE statement_id = $1`, [sA.id]);
  check('la fila del comprobante: aprobada por la jefa, medio «Bancolombia», $470.000',
    bp && bp.status === 'approved' && bp.reviewed_by === jefe && bp.via_label === 'Bancolombia' && bp.declared_amount_cop === 470000, bp);
  const pay = await one(`SELECT * FROM public.billing_payments WHERE statement_id = $1`, [sA.id]);
  check('el pago apunta al comprobante', pay && pay.proof_id === bp.id && pay.source === 'manual', pay);
  check('al tripulante le llega «Pago confirmado»', (await alertas(sA.id)).some(x => x.key === 'aprobado'));
  await asUser(c, A.u, 'auxiliar');
  const mine = (await one(`SELECT public.aux_billing_my_account() AS r`)).r;
  const cur = mine && mine.current;
  // La tarjeta «Tu comprobante» de su app sale con: comp ≠ none y (comp ≠ approved o hay lastProof).
  check('en su app: al día y con «Tu comprobante» (enviado → revisado → aprobado)',
    cur && cur.paid === true && cur.comp === 'approved' && cur.lastProof && cur.lastProof.status === 'approved', cur && [cur.paid, cur.comp, cur.lastProof]);
  check('el tripulante puede ver el archivo que subió la jefa (su carpeta)',
    (await q(`SELECT 1 FROM storage.objects WHERE bucket_id = 'payment-proofs' AND name = $1`, [pathA])).length === 1);
  await asUser(c, jefe, 'admin');
  const e5 = await debeFallar(mpp, [sA.id, pathA, '2026-10-21']);
  check('ya pagada → error', e5 && /ya está pagada/.test(e5.message), e5 && e5.message);
  const e6 = await debeFallar(`SELECT public.admin_billing_restart_terms($1)`, [sA.id]);
  check('«plazo desde hoy» en una pagada → error', e6 && /ya está pagada/.test(e6.message), e6 && e6.message);

  // ── 10. api-cobro.js (con un servidor falso: lo que sube y lo que manda) ──
  console.log('\n10. api-cobro.js');
  {
    const vm = await import('node:vm');
    const calls = [];
    const fakeSb = {
      rpc: async (fn, args) => { calls.push(['rpc', fn, args]); return { data: fn === 'current_user_org' ? 'ORG-1' : { ok: true }, error: null }; },
      auth: { getSession: async () => ({ data: { session: { user: { id: 'JEFA-1' } } } }) },
      storage: { from: (b) => ({ upload: async (p, f, o) => { calls.push(['upload', b, p, o]); return { data: { path: p }, error: null }; } }) },
    };
    const ctx = { window: { sb: fakeSb }, console, Date, Math, JSON, Promise, Error, String, Number, Object, Array, isFinite, RegExp };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(new URL('../../rendio-turnos/api-cobro.js', import.meta.url), 'utf8'), ctx, { filename: 'api-cobro.js' });
    const A = ctx.window.ApiCobro;
    check('exporta adminMarkPaidWithProof, adminOpenMany y adminRestartTerms',
      ['adminMarkPaidWithProof', 'adminOpenMany', 'adminRestartTerms'].every(k => typeof A[k] === 'function'));
    await A.adminMarkPaidWithProof('ST-9', 'PROF-TRIP', { type: 'image/png', size: 2048, name: 'pago.png' },
      { viaLabel: 'Bancolombia', amountCOP: 470000, paidOn: '2026-10-21', note: null });
    const up = calls.find(x => x[0] === 'upload');
    const rp = calls.find(x => x[0] === 'rpc' && x[1] === 'admin_billing_mark_paid_with_proof');
    check('sube a payment-proofs/{org}/{profile del TRIPULANTE}/{cuenta}/admin-….png sin reemplazar',
      up && up[1] === 'payment-proofs' && /^ORG-1\/PROF-TRIP\/ST-9\/admin-[a-z0-9-]+\.png$/.test(up[2]) && up[3].upsert === false && up[3].contentType === 'image/png', up);
    check('…y registra con la misma ruta, tipo, tamaño, medio, monto y fecha',
      rp && rp[2].p_storage_path === up[2] && rp[2].p_content_type === 'image/png' && rp[2].p_size_bytes === 2048 && rp[2].p_via_label === 'Bancolombia'
      && rp[2].p_amount_cop === 470000 && rp[2].p_paid_on === '2026-10-21', rp && rp[2]);
    calls.length = 0;
    await A.adminMarkPaidWithProof('ST-9', 'PROF-TRIP', null, { viaLabel: 'Efectivo' });
    check('sin archivo = el «marcar pagado» de siempre (sin subir nada)', !calls.some(x => x[0] === 'upload')
      && calls.some(x => x[1] === 'admin_billing_mark_paid' && x[2].p_via_label === 'Efectivo'));
    let err = null; calls.length = 0;
    try { await A.adminMarkPaidWithProof('ST-9', 'PROF-TRIP', { type: 'text/plain', size: 10, name: 'a.txt' }, {}); } catch (x) { err = x; }
    check('un archivo que no es foto ni PDF no se sube', err && /foto/.test(err.message) && calls.length === 0);
    calls.length = 0;
    await A.adminOpenMany(['A1', '', 'A2'], { fromToday: true, notify: false });
    const om = calls.find(x => x[1] === 'admin_billing_open_statements');
    check('adminOpenMany manda los ids (sin vacíos), desde hoy y avisar', om && JSON.stringify(om[2]) === JSON.stringify({ p_auxes: ['A1', 'A2'], p_from_today: true, p_notify: false }), om && om[2]);
    err = null; try { await A.adminOpenMany([]); } catch (x) { err = x; }
    check('adminOpenMany sin nadie no llama a la base', err && /al menos un tripulante/.test(err.message));
    await A.adminRestartTerms('ST-5');
    check('adminRestartTerms(cuenta)', calls.some(x => x[1] === 'admin_billing_restart_terms' && x[2].p_statement_id === 'ST-5'));
  }
} catch (e) {
  fail++;
  console.error('  ✗ ERROR:', e.message);
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok} bien · ${fail} mal`);
process.exit(fail ? 1 : 0);
