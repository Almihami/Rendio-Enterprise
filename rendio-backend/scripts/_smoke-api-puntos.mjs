// Prueba de rendio-turnos/api-puntos.js (window.ApiPuntos) contra la base LOCAL.
//
// Carga el archivo REAL en jsdom con un `window.sb` de prueba que traduce cada
// sb.rpc(...) y sb.from(...) a SQL sobre 127.0.0.1:54322, actuando como el
// usuario de la sesión (claims + ROLE authenticated). Así se prueba de verdad:
// nombres de RPC y de parámetros, columnas, RLS y el mapeo a camelCase.
// Todo dentro de BEGIN … ROLLBACK: no queda nada.
//
//   cd rendio-backend/scripts && node _smoke-api-puntos.mjs
//
// NO cubre: supabase-js real (PostgREST, su forma exacta de errores y de
// timestamps), la red, ni ninguna pantalla (eso es P13b).
import fs from 'node:fs';
import pg from 'pg';
import { JSDOM } from 'jsdom';
import { localClient, fixtures, user, asUser, asAdminDb } from './_local-fixtures.mjs';

pg.types.setTypeParser(1184, v => v);   // timestamptz como texto, igual que PostgREST
const SRC = new URL('../../rendio-turnos/api-puntos.js', import.meta.url);

const c = await localClient();
const q = async (s, p) => (await c.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
let ok = 0, fail = 0;
const t = (n, cond, det) => { if (cond) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + det : ''}`); } };
const throwsLike = async (fn, re) => { try { await fn(); return 'no lanzó'; } catch (e) { return re.test(e.message) ? true : e.message; } };

// ---------------------------------------------------------------------------
// sb de prueba sobre pg. who = { uid, role } o null (sin sesión).
// ---------------------------------------------------------------------------
const retset = new Map();
async function isSetFn(fn) {
  if (!retset.has(fn)) {
    const r = await one(`SELECT bool_or(proretset) AS s FROM pg_proc WHERE proname = $1 AND pronamespace = 'public'::regnamespace`, [fn]);
    retset.set(fn, r ? r.s : null);
  }
  return retset.get(fn);
}
async function run(who, sql, params) {
  await c.query('SAVEPOINT api');
  try {
    if (who) await asUser(c, who.uid, who.role);
    const r = await c.query(sql, params);
    if (who) await asAdminDb(c);
    await c.query('RELEASE SAVEPOINT api');
    return { rows: r.rows, error: null };
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT api');
    await asAdminDb(c);
    return { rows: null, error: { code: e.code, message: e.message } };
  }
}
function fakeSb(getWho, overrides = {}) {
  return {
    auth: { async getSession() { const w = getWho(); return { data: { session: w ? { user: { id: w.uid } } : null } }; } },
    async rpc(fn, args) {
      if (overrides.rpc) { const o = overrides.rpc(fn, args); if (o) return o; }
      const set = await isSetFn(fn);
      if (set == null) return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${fn}` } };
      const keys = Object.keys(args || {});
      const call = `public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`;
      const r = await run(getWho(), set ? `SELECT * FROM ${call}` : `SELECT ${call} AS r`, keys.map(k => args[k]));
      if (r.error) return { data: null, error: r.error };
      return { data: set ? r.rows : r.rows[0].r, error: null };
    },
    from(table) {
      const st = { table, cols: '*', where: [], order: null, limit: null, head: false, count: false, update: null, single: false };
      const b = {
        select(cols, opts) { st.cols = cols || '*'; if (opts && opts.head) st.head = true; if (opts && opts.count) st.count = true; return b; },
        eq(col, v) { st.where.push([col, v]); return b; },
        order(col, o) { st.order = `${col} ${o && o.ascending === false ? 'DESC' : 'ASC'}`; return b; },
        limit(n) { st.limit = n; return b; },
        update(row) { st.update = row; return b; },
        maybeSingle() { st.single = true; return b; },
        then(res, rej) { return exec().then(res, rej); },
      };
      async function exec() {
        const params = [];
        const w = st.where.length ? ' WHERE ' + st.where.map(([k, v]) => { params.push(v); return `${k} = $${params.length}`; }).join(' AND ') : '';
        let sql;
        if (st.update) {
          const sets = Object.keys(st.update).map(k => { params.push(st.update[k]); return `${k} = $${params.length}`; }).join(', ');
          sql = `UPDATE public.${table} SET ${sets}${w} RETURNING ${st.cols}`;
        } else if (st.head && st.count) {
          sql = `SELECT count(*)::int AS n FROM public.${table}${w}`;
        } else {
          sql = `SELECT ${st.cols} FROM public.${table}${w}${st.order ? ' ORDER BY ' + st.order : ''}${st.limit ? ' LIMIT ' + st.limit : ''}`;
        }
        const r = await run(getWho(), sql, params);
        if (r.error) return { data: null, error: r.error, count: null };
        if (st.head && st.count) return { data: null, error: null, count: r.rows[0].n };
        return { data: st.single ? (r.rows[0] || null) : r.rows, error: null };
      }
      return b;
    },
  };
}

function load(getWho, overrides) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://rendio.test/?ref=laura-olv', runScripts: 'outside-only' });
  dom.window.sb = fakeSb(getWho, overrides);
  dom.window.eval(fs.readFileSync(SRC, 'utf8'));
  return dom.window;
}

await c.query('BEGIN');
try {
  const fx = await fixtures(c);
  const jefeUid = await user(c, fx.org, 'admin', 'Jefa de prueba API');
  const LAURA = { uid: fx.auxUser, role: 'auxiliar' }, VECINA = { uid: fx.vecinoUser, role: 'auxiliar' }, JEFE = { uid: jefeUid, role: 'admin' };
  const dianaUid = await user(c, fx.org, 'auxiliar', 'Diana Restrepo Mejía');
  const dianaAux = (await one(`INSERT INTO public.auxiliar_profiles (profile_id, residence_id) VALUES ($1, $2) RETURNING id`, [dianaUid, fx.llano])).id;
  const DIANA = { uid: dianaUid, role: 'auxiliar' };
  await q(`UPDATE public.app_settings SET aux_points_enabled = false, aux_points_goal_target = NULL, aux_points_goal_text = NULL WHERE id = 'singleton'`);

  let who = null;
  const w = load(() => who);
  const P = w.ApiPuntos;

  console.log('\n── contrato ──');
  const want = ['settings', 'summary', 'movements', 'rewards', 'redeem', 'myRedemptions', 'myCode', 'myReferrals', 'claimReferral', 'goal',
    'normalizeCode', 'nextReward', 'cancelEarns', 'movementTitle', 'inviteLink', 'inviteText', 'refFromUrl',
    'adminSettings', 'adminSaveSettings', 'adminSaveReward', 'adminRedemptions', 'adminPendingCount', 'adminDecide', 'adminAdjust', 'adminBalances'];
  t('window.ApiPuntos expone las 25 funciones', P && want.every(k => typeof P[k] === 'function'), want.filter(k => !P || typeof P[k] !== 'function').join(','));
  const globales = Object.keys(w).filter(k => /^(Api|api)/.test(k));
  t('solo agrega ApiPuntos al window (IIFE)', JSON.stringify(globales) === '["ApiPuntos"]', globales.join(','));

  console.log('\n── sin sesión / sin 0091: null, nunca datos inventados ──');
  t('summary() sin sesión → null', await P.summary() === null);
  t('settings() sin sesión → null', await P.settings() === null);
  t('myCode() sin sesión → null', await P.myCode() === null);
  t('movements() sin sesión → null', await P.movements() === null);
  t('redeem() sin sesión → lanza «sesión»', await throwsLike(() => P.redeem('colega'), /sesión/) === true);
  const sinRpc = load(() => LAURA, { rpc: () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.aux_points_my_summary' } }) }).ApiPuntos;
  t('base sin 0091 (PGRST202) → summary() null', await sinRpc.summary() === null);
  t('base sin 0091 → goal() null y myReferrals() null', await sinRpc.goal() === null && await sinRpc.myReferrals() === null);
  t('base sin 0091 → redeem() lanza «no está disponible»', await throwsLike(() => sinRpc.redeem('colega'), /no está disponible/) === true);
  const roto = load(() => LAURA, { rpc: () => ({ data: null, error: { code: '500', message: 'Fallo de red' } }) }).ApiPuntos;
  t('un error de verdad (no de «falta») se lanza, no se esconde', await throwsLike(() => roto.summary(), /Fallo de red/) === true);

  console.log('\n── apagado ──');
  who = LAURA;
  let s = await P.settings();
  t('settings(): enabled=false y valores 40/80/20/2/5', s && s.enabled === false && s.invite === 40 && s.neighbor === 80 && s.cancel === 20 && s.cancelLeadHours === 2 && s.rate === 5, JSON.stringify(s));
  let sm = await P.summary();
  t('summary(): enabled=false, saldo 0', sm && sm.enabled === false && sm.balance === 0 && sm.values.cancel === 20, JSON.stringify(sm));
  t('myCode() apagado → null', await P.myCode() === null);
  who = DIANA;
  t('claimReferral apagado → lanza «no está activo»', await throwsLike(() => P.claimReferral('LAURA-OLV'), /no está activo/) === true);
  t('claimReferral vacío → lanza sin ir a la base', await throwsLike(() => P.claimReferral('   '), /Escribe el código/) === true);

  console.log('\n── el jefe enciende ──');
  who = LAURA;
  t('un tripulante no cambia ajustes («solo el jefe»)', await throwsLike(() => P.adminSaveSettings({ enabled: true }), /solo el jefe/) === true);
  who = JEFE;
  t('validación local: puntos negativos', await throwsLike(() => P.adminSaveSettings({ invite: -1 }), /0 a 5000/) === true);
  t('validación local: anticipación 0 h', await throwsLike(() => P.adminSaveSettings({ cancelLeadHours: 0 }), /1 a 48/) === true);
  s = await P.adminSaveSettings({ enabled: true, invite: 40, neighbor: 80 });
  t('adminSaveSettings({enabled:true}) → encendido', s && s.enabled === true && s.invite === 40, JSON.stringify(s));

  console.log('\n── código, invitación y acreditación por la base ──');
  who = LAURA;
  const code = await P.myCode();
  t('myCode() → LAURA-OLV', code === 'LAURA-OLV', code);
  who = DIANA;
  const cl = await P.claimReferral(' laúra-olv ');
  t('claimReferral(« laúra-olv ») → ok (normaliza tildes, espacios y mayúsculas)', cl && cl.ok === true, JSON.stringify(cl));
  t('reclamar otra vez → lanza el texto de la base', await throwsLike(() => P.claimReferral('LAURA-OLV'), /Ya registraste/) === true);
  // Diana hace su primer viaje y el conductor lo entrega (camino real).
  const res = (await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_h2a, required_arrival_at)
      VALUES ($1, 'home_to_airport', 'requested', now() + interval '1 day') RETURNING id`, [dianaAux])).id;
  const ra = (await one(`INSERT INTO public.route_assignments (driver_profile_id, vehicle_id, direction, status, planned_start_at)
      VALUES ($1, $2, 'home_to_airport', 'planned', now() + interval '20 hours') RETURNING id`, [fx.driver, fx.vehicle])).id;
  await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at) VALUES ($1, $2, 1, now() + interval '21 hours')`, [ra, res]);
  await asUser(c, fx.drvUser, 'driver'); await q(`SELECT public.driver_set_reservation_status($1, 'delivered')`, [res]); await asAdminDb(c);

  who = LAURA;
  sm = await P.summary();
  t('summary(): Laura 40 pts, 1 invitado hecho', sm.enabled && sm.balance === 40 && sm.invitedCount === 1 && sm.invitedDone === 1, JSON.stringify(sm));
  let mv = await P.movements();
  t('movements(): «Tu colega hizo su primer viaje» · «Diana R.» · +40', mv.length === 1 && mv[0].title === 'Tu colega hizo su primer viaje' && mv[0].sub === 'Diana R.' && mv[0].points === 40 && typeof mv[0].at === 'string', JSON.stringify(mv));
  const refs = await P.myReferrals();
  t('myReferrals(): [{name:"Diana R.", initials:"DR", status:"ok", points:40}]', refs.length === 1 && refs[0].name === 'Diana R.' && refs[0].initials === 'DR' && refs[0].status === 'ok' && refs[0].points === 40 && refs[0].neighbor === false, JSON.stringify(refs));
  t('…sin id, correo ni teléfono', refs[0] && !Object.keys(refs[0]).some(k => /id|mail|phone/i.test(k)), Object.keys(refs[0] || {}).join(','));
  who = VECINA;
  t('la vecina: saldo 0 y ningún movimiento (RLS)', (await P.summary()).balance === 0 && (await P.movements()).length === 0);
  t('la vecina no ve los invitados de Laura', (await P.myReferrals()).length === 0);

  console.log('\n── vitrina y canje ──');
  who = LAURA;
  const rw = await P.rewards();
  t('rewards(): 4 en orden, Directo «Pronto»', rw.map(r => r.id).join() === 'colega,directo,mensual,privado' && rw[1].soon === true && rw[2].kind === 'billing_days' && rw[2].amount === 3, JSON.stringify(rw.map(r => [r.id, r.cost, r.soon])));
  const nx = P.nextReward(40, rw);
  t('nextReward(40) → colega, faltan 140 (salta Directo «Pronto»)', nx && nx.id === 'colega' && nx.missing === 140, JSON.stringify(nx));
  t('nextReward(500) → privado (Directo no cuenta)', P.nextReward(500, rw)?.id === 'privado');
  t('nextReward(9999) → null (ya alcanza todo)', P.nextReward(9999, rw) === null);
  t('redeem sin saldo → «Te faltan 140 pts»', await throwsLike(() => P.redeem('colega'), /Te faltan 140 pts/) === true);
  t('redeem Directo → «pronto»', await throwsLike(() => P.redeem('directo'), /pronto/) === true);
  who = JEFE;
  const adj = await P.adminAdjust(fx.aux, 200, 'Bono de bienvenida');
  t('adminAdjust(+200) → 240', adj.ok && adj.balance === 240, JSON.stringify(adj));
  t('adminAdjust sin nota → lanza', await throwsLike(() => P.adminAdjust(fx.aux, 5, ''), /por qué/) === true);
  who = LAURA;
  const rd = await P.redeem('colega', 'para mi compañera');
  t('redeem(colega) → ok, saldo 60', rd.ok && rd.balance === 60 && typeof rd.redemptionId === 'string', JSON.stringify(rd));
  let mr = await P.myRedemptions();
  t('myRedemptions(): pendiente con título y costo', mr.length === 1 && mr[0].status === 'pending' && mr[0].title === 'Traer a un colega gratis' && mr[0].cost === 180 && mr[0].note === 'para mi compañera', JSON.stringify(mr));
  mv = await P.movements();
  t('el canje aparece en movimientos («Canjeaste «…»», −180, sin repetir abajo)', mv[0].kind === 'redeem' && mv[0].points === -180 && /^Canjeaste «Traer a un colega gratis»$/.test(mv[0].title) && mv[0].sub === '', JSON.stringify(mv[0]));

  console.log('\n── el jefe cumple / rechaza ──');
  who = JEFE;
  t('adminPendingCount() → 1', await P.adminPendingCount() === 1);
  let ar = await P.adminRedemptions();
  t('adminRedemptions(): Laura Gómez · colega · guest_seat · saldo 60', ar.length === 1 && ar[0].name === 'Laura Gómez' && ar[0].kind === 'guest_seat' && ar[0].balance === 60 && ar[0].residence === 'El Olivar', JSON.stringify(ar));
  t('rechazar sin motivo → lanza', await throwsLike(() => P.adminDecide(ar[0].id, 'reject', ''), /motivo/) === true);
  const dc = await P.adminDecide(ar[0].id, 'reject', 'Ese día no hay cupo');
  t('adminDecide(reject) → devuelve los puntos (240)', dc.ok && dc.status === 'rejected' && dc.balance === 240, JSON.stringify(dc));
  t('adminRedemptions() ya sin pendientes', (await P.adminRedemptions()).length === 0);
  t('adminRedemptions("all") → el rechazado con su motivo', (await P.adminRedemptions('all'))[0]?.decisionNote === 'Ese día no hay cupo');
  who = LAURA;
  mv = await P.movements();
  t('Laura ve «Te devolvimos un canje» con el motivo', mv[0].title === 'Te devolvimos un canje' && /no hay cupo/.test(mv[0].sub) && mv[0].points === 180, JSON.stringify(mv[0]));
  t('un tripulante no decide canjes', await throwsLike(() => P.adminDecide(ar[0].id, 'fulfill'), /Solo el jefe/) === true);
  who = JEFE;
  const bal = await P.adminBalances();
  const fl = bal.find(b => b.auxId === fx.aux);
  t('adminBalances(): Laura 240 · código LAURA-OLV · 1 invitado', fl && fl.balance === 240 && fl.code === 'LAURA-OLV' && fl.invited === 1 && fl.invitedDone === 1, JSON.stringify(fl));
  const rs = await P.adminSaveReward('colega', { cost: 200 });
  t('adminSaveReward(colega, 200) → guardado', rs && rs.cost === 200, JSON.stringify(rs));
  t('adminSaveReward con costo 0 → lanza (validación)', await throwsLike(() => P.adminSaveReward('colega', { cost: 0 }), /1 a 100000/) === true);
  who = LAURA;
  t('un tripulante no cambia la vitrina', await throwsLike(() => P.adminSaveReward('colega', { cost: 1 }), /solo el jefe/) === true);

  console.log('\n── meta anónima del conjunto ──');
  t('goal() sin meta del jefe → null', await P.goal() === null);
  who = JEFE;
  t('meta: texto de 161 → lanza', await throwsLike(() => P.adminSaveSettings({ goalText: 'x'.repeat(161) }), /160/) === true);
  await P.adminSaveSettings({ goalTarget: 10, goalText: '  Entre más vecinos, más fácil armar tu ruta  ' });
  who = LAURA;
  const g = await P.goal();
  t('goal(): El Olivar · N de 10 · pct · texto del jefe (recortado)', g && g.residenceName === 'El Olivar' && g.target === 10 && g.count >= 2 && g.pct === Math.round(g.count * 10) && g.text === 'Entre más vecinos, más fácil armar tu ruta', JSON.stringify(g));
  who = JEFE;
  s = await P.adminSaveSettings({ goalTarget: '', goalText: '' });
  t('borrar la meta (""→null)', s.goalTarget === null && s.goalText === '', JSON.stringify(s));

  console.log('\n── ayudas puras ──');
  t('normalizeCode(" laúra-olv ") → LAURA-OLV', P.normalizeCode(' laúra-olv ') === 'LAURA-OLV');
  const now = Date.parse('2026-10-01T12:00:00Z');
  const cfgOn = { enabled: true, cancel: 20, cancelLeadHours: 2 };
  const tp = (h, st = 'assigned') => ({ status: st, pickupAt: new Date(now + h * 3600e3).toISOString() });
  t('cancelEarns: recogida en 3 h → 20', P.cancelEarns(tp(3), cfgOn, now) === 20);
  t('cancelEarns: justo 2 h → 20 (≥)', P.cancelEarns(tp(2), cfgOn, now) === 20);
  t('cancelEarns: en 1 h → null', P.cancelEarns(tp(1), cfgOn, now) === null);
  t('cancelEarns: sin hora publicada → null', P.cancelEarns({ status: 'pending', pickupAt: null }, cfgOn, now) === null);
  t('cancelEarns: en camino → null', P.cancelEarns(tp(5, 'onway'), cfgOn, now) === null);
  t('cancelEarns: programa apagado → null', P.cancelEarns(tp(5), { ...cfgOn, enabled: false }, now) === null);
  t('cancelEarns acepta la forma de summary() (values)', P.cancelEarns(tp(5), { enabled: true, values: { cancel: 20, cancelLeadHours: 2 } }, now) === 20);
  t('inviteLink → origen + ?ref=CODIGO', P.inviteLink('laura-olv') === 'https://rendio.test/?ref=LAURA-OLV', P.inviteLink('laura-olv'));
  t('inviteText lleva el código y el enlace', /LAURA-OLV/.test(P.inviteText('LAURA-OLV')) && /\?ref=LAURA-OLV/.test(P.inviteText('LAURA-OLV')));
  t('refFromUrl() lee ?ref= de la página', P.refFromUrl() === 'LAURA-OLV', P.refFromUrl());
  t('refFromUrl sin ref → ""', P.refFromUrl('https://rendio.test/') === '');
  t('movementTitle cubre los 7 tipos', ['referral', 'referral_neighbor', 'cancel_early', 'rate', 'redeem', 'redeem_refund', 'adjust'].every(k => P.movementTitle(k, 'x') !== 'Movimiento'));

  console.log('\n── textos prohibidos (fuente de api-puntos.js y de 0091) ──');
  const texto = fs.readFileSync(SRC, 'utf8') + fs.readFileSync(new URL('../supabase/migrations/0091_rendio_points.sql', import.meta.url), 'utf8');
  const prohibidos = [/\$\s?\d/, /150\.000/, /Carlos Mejía/, /AV9525/, /Juliana/, /Plan B/, /24\/7/, /en línea/i, /Último cupo/, /Siempre hay cupo/, /\bkit\b/i, /Preparado/];
  const hallados = prohibidos.filter(re => re.test(texto)).map(String);
  t('ningún texto prohibido', hallados.length === 0, hallados.join(' '));
} catch (e) {
  fail++; console.log('  ✗ EXCEPCIÓN: ' + (e.stack || e.message));
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok} ✓ · ${fail} ✗`);
process.exit(fail ? 1 : 0);
