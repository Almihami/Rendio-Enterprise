// Verificación de 0131 (delegar con nombre y teléfono + la libreta) contra la base
// LOCAL (127.0.0.1:54322). Aplica lo que falte (0117, 0124–0126, 0129) y 0131
// dentro de una transacción que se deshace: no queda nada. Nunca apunta a dev ni
// a producción.
//
//   cd rendio-backend/scripts && node _verify-0131.mjs
//
// Qué prueba:
//   1. auxiliar_my_trips: solo cambian las líneas de 0131 (la huella cambia) y el
//      down la devuelve EXACTAMENTE a la de 0126.
//   2. Delegar una vuelta con Juan a «Carlos Uber · 300 123 4567»: sin conductor ni
//      carro, con nombre y teléfono; las reservas a «pedida» con su hora; a cada
//      tripulante «Te recogerá Carlos Uber 🤝 · Tu recogida de las 4:30 la hace
//      Carlos Uber. Su número de contacto es 300 123 4567.»; a Juan «Ya no haces
//      una vuelta»; queda en la libreta. En «mis viajes»: delegated + delegate
//      {name, phone}, sin conductor ni driver_pending.
//   3. Lo mismo otra vez no cambia ni avisa; otra persona sí; el mismo teléfono
//      con otro nombre actualiza la libreta (no la duplica).
//   4. Devolverla (0126) o ponerle conductor (0129) borra a quién se delegó.
//   5. Una delegada sin nombre (0126) sigue sin «delegate» (Te contactaremos…).
//   6. Reglas: nombre y teléfono obligatorios, no si ya arrancó, solo jefes, otra
//      organización no la ve; la libreta solo la ven los jefes de la organización.
//   7. El down deja todo como en 0126.
//
// NO cubre: las pantallas (_smoke-delegar-dom.mjs), la push de verdad, dev/producción.
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
const asDb = async () => { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', '', true)`); };
const strip = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8').replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
const existe = async (sql) => (await one(`SELECT (${sql}) IS NOT NULL AS ok`)).ok;
const huella = async () => (await one(`SELECT md5(p.prosrc) h FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'auxiliar_my_trips'`)).h;

await c.query('BEGIN');
try {
  if (!(await existe(`to_regprocedure('public.ops_alert_recipients_of(uuid)')`))) await c.query(strip('../supabase/migrations/0117_avisos_desde_el_servidor.sql'));
  if (!(await existe(`(SELECT 1 FROM information_schema.columns WHERE table_name = 'route_assignments' AND column_name = 'plan_car')`))) await c.query(strip('../supabase/migrations/0124_carro_del_turno.sql'));
  if (!(await existe(`to_regprocedure('public.hm_bog(timestamptz)')`))) await c.query(strip('../supabase/migrations/0125_ruta_de_julian.sql'));
  if (!(await existe(`to_regprocedure('public.admin_route_set_delegated(uuid,boolean)')`))) await c.query(strip('../supabase/migrations/0126_vuelta_delegada.sql'));
  if (!(await existe(`to_regprocedure('public.admin_route_set_driver(uuid,uuid)')`))) await c.query(strip('../supabase/migrations/0129_conductor_de_una_vuelta.sql'));
  const h0126 = await huella();
  const hDel = async () => (await one(`SELECT md5(p.prosrc) h FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'admin_route_set_delegated'`)).h;
  const hDel0126 = await hDel();
  await c.query(strip('../supabase/migrations/0131_delegado_con_nombre.sql'));
  await c.query(strip('../supabase/migrations/0131_delegado_con_nombre.sql'));
  check('0131 se aplica encima de 0126 (y se puede volver a correr)', true);
  const h0131 = await huella();
  check('auxiliar_my_trips cambia (la copia con «delegate»)', h0126 && h0131 && h0126 !== h0131);

  const fx = await fixtures(c);
  const jefe = await user(c, fx.org, 'admin', 'Camilo prueba 0131');
  const drv = async (name) => { const u = await user(c, fx.org, 'driver', name); return { u, dp: (await one(`INSERT INTO public.driver_profiles (profile_id) VALUES ($1) RETURNING id`, [u])).id }; };
  const JUAN = await drv('Juan Andres prueba 0131');
  const trip = async (name) => { const u = await user(c, fx.org, 'auxiliar', name); return { u, a: (await one(`INSERT INTO public.auxiliar_profiles (profile_id, residence_id) VALUES ($1, $2) RETURNING id`, [u, fx.olivar])).id }; };
  const LUZ = await trip('Luz Bomba prueba'), SARA = await trip('Sara Villegas prueba'), MAR = await trip('Margy Ruiz prueba');
  const man = (await one(`SELECT ((now() AT TIME ZONE 'America/Bogota')::date + 1)::text d`)).d;
  const at = (hm) => `${man}T${hm}:00-05:00`;
  const res = async (X, whenIso) => (await one(`INSERT INTO public.reservations (auxiliar_profile_id, direction, status_h2a, required_arrival_at, pickup_address, pickup_latitude, pickup_longitude, residence_id)
      VALUES ($1, 'home_to_airport', 'requested', $2::timestamptz, 'El Olivar, Rionegro', 6.1523, -75.3781, $3) RETURNING id`, [X.a, whenIso, fx.olivar])).id;
  const vuelta = async (o) => {
    const ra = (await one(`INSERT INTO public.route_assignments (driver_profile_id, direction, status, planned_start_at, delegated_at)
        VALUES ($1, 'home_to_airport', 'planned', $2::timestamptz, $3) RETURNING id`, [o.d || null, o.t, o.deleg ? new Date().toISOString() : null])).id;
    for (let i = 0; i < o.stops.length; i++) await q(`INSERT INTO public.route_stops (route_assignment_id, reservation_id, stop_order, estimated_arrival_at) VALUES ($1, $2, $3, $4::timestamptz)`, [ra, o.stops[i][0], i + 1, o.stops[i][1]]);
    await q(`SELECT public.route_sync_assigned($1)`, [ra]);
    for (const s of o.stops) await q(`SELECT public.sync_calculated_pickup($1)`, [s[0]]);
    return ra;
  };
  const fila = async (ra) => { await asDb(); return one(`SELECT driver_profile_id d, vehicle_id v, delegated_at dg, delegate_name dn, delegate_phone dph, status FROM public.route_assignments WHERE id = $1`, [ra]); };
  const reserva = async (id) => { await asDb(); return one(`SELECT status_h2a::text h2a, calculated_pickup_at FROM public.reservations WHERE id = $1`, [id]); };
  const avisos = async (prof, like) => { await asDb(); return q(`SELECT title, body FROM public.notification_outbox WHERE profile_id = $1 AND (title ILIKE $2 OR body ILIKE $2) ORDER BY created_at`, [prof, like]); };
  const delegar = async (ra, n, p, quien = jefe, rol = 'admin') => { await asUser(c, quien, rol); try { return (await one(`SELECT public.admin_route_delegate($1, $2, $3) r`, [ra, n, p])).r; } finally { await asDb(); } };
  const mis = async (X, rid) => { await asUser(c, X.u, 'auxiliar'); const j = (await one(`SELECT public.auxiliar_my_trips(30) j`)).j; await asDb(); return (j || []).find((x) => x.id === rid); };
  const libreta = async (quien = jefe, rol = 'admin') => { await asUser(c, quien, rol); try { return await q(`SELECT name, phone FROM public.delegate_contacts WHERE deleted_at IS NULL ORDER BY name`); } finally { await asDb(); } };

  // ── 2. Delegar a alguien ──────────────────────────────────────────────────
  console.log('\n2. Delegar una vuelta a alguien de afuera');
  const rLuz = await res(LUZ, at('06:00')), rSara = await res(SARA, at('06:00'));
  const raA = await vuelta({ d: JUAN.dp, t: at('04:20'), stops: [[rLuz, at('04:30')], [rSara, at('04:40')]] });
  check('arranca con Juan y las reservas «asignadas»', (await fila(raA)).d === JUAN.dp && (await reserva(rLuz)).h2a === 'assigned');
  const d1 = await delegar(raA, '  Carlos   Uber ', '300 123 4567');
  const f1 = await fila(raA);
  check('queda delegada a «Carlos Uber · 300 123 4567», sin conductor ni carro', !!f1.dg && f1.d === null && f1.v === null && f1.dn === 'Carlos Uber' && f1.dph === '300 123 4567' && f1.status === 'planned', f1);
  check('responde a quién avisó (2) y que le quitó la vuelta a Juan', d1.notified === 2 && d1.driver_removed === true && d1.name === 'Carlos Uber', d1);
  const rl = await reserva(rLuz);
  check('las reservas vuelven a «pedida» con su hora (4:30)', rl.h2a === 'requested' && Date.parse(rl.calculated_pickup_at) === Date.parse(at('04:30')), rl);
  const aL = await avisos(LUZ.u, 'Te recogerá%');
  check('a Luz: «Te recogerá Carlos Uber 🤝 · Tu recogida de las 4:30 la hace Carlos Uber. Su número de contacto es 300 123 4567.»', aL.length === 1 && aL[0].title === 'Te recogerá Carlos Uber 🤝' && aL[0].body === 'Tu recogida de las 4:30 la hace Carlos Uber. Su número de contacto es 300 123 4567.', aL);
  check('a Juan: «Ya no haces una vuelta»', (await avisos(JUAN.u, 'Ya no haces%')).length === 1);
  const lb = await libreta();
  check('queda en la libreta', lb.length === 1 && lb[0].name === 'Carlos Uber' && lb[0].phone === '300 123 4567', lb);
  const m1 = await mis(LUZ, rLuz);
  check('en «mis viajes» de Luz: delegada, con delegate {Carlos Uber, 300 123 4567}, sin conductor ni driver_pending', m1 && m1.delegated === true && m1.delegate && m1.delegate.name === 'Carlos Uber' && m1.delegate.phone === '300 123 4567' && m1.driver === null && m1.driver_pending === false, m1 && { d: m1.delegated, dl: m1.delegate, drv: m1.driver, p: m1.driver_pending });

  // ── 3. Otra vez, otra persona, el mismo teléfono ──────────────────────────
  console.log('\n3. Repetir, cambiar de persona y la libreta');
  const d2 = await delegar(raA, 'Carlos Uber', '3001234567');
  check('lo mismo otra vez (el teléfono sin espacios es el mismo): no cambia ni avisa', d2.unchanged === true && (await avisos(LUZ.u, 'Te recogerá%')).length === 1, d2);
  await delegar(raA, 'Pedro Gómez', '310 999 8877');
  const aL2 = await avisos(LUZ.u, 'Te recogerá%');
  check('otra persona: le avisa otra vez con Pedro', aL2.length === 2 && /Pedro Gómez/.test(aL2[1].title) && /310 999 8877/.test(aL2[1].body), aL2.map((x) => x.title));
  check('la vuelta dice Pedro', (await fila(raA)).dn === 'Pedro Gómez');
  await delegar(raA, 'Carlos Arango', '300-123-4567');
  const lb2 = await libreta();
  check('el mismo teléfono con otro nombre actualiza la libreta (2 personas, no 3)', lb2.length === 2 && lb2.some((x) => x.name === 'Carlos Arango') && !lb2.some((x) => x.name === 'Carlos Uber'), lb2);

  // ── 4. Devolverla o ponerle conductor ─────────────────────────────────────
  console.log('\n4. Dejar de delegarla borra a quién');
  await asUser(c, jefe, 'admin'); await q(`SELECT public.admin_route_set_delegated($1, false)`, [raA]); await asDb();
  const f4 = await fila(raA);
  check('«Devolver» (0126): ya no es delegada y no queda nombre ni teléfono', f4.dg === null && f4.dn === null && f4.dph === null, f4);
  check('en «mis viajes» ya no sale delegate', !(await mis(LUZ, rLuz)).delegate);
  await delegar(raA, 'Carlos Arango', '300 123 4567');
  await asUser(c, jefe, 'admin'); await q(`SELECT public.admin_route_set_driver($1, $2)`, [raA, JUAN.dp]); await asDb();
  const f5 = await fila(raA);
  check('ponerle conductor (0129) también lo borra', f5.d === JUAN.dp && f5.dg === null && f5.dn === null, f5);

  // ── 5. Delegada sin nombre (0126) ─────────────────────────────────────────
  console.log('\n5. Delegada sin nombre, como antes');
  const rMar = await res(MAR, at('10:00'));
  const raB = await vuelta({ t: at('08:20'), deleg: true, stops: [[rMar, at('08:30')]] });
  const mB = await mis(MAR, rMar);
  check('sale delegada SIN delegate (el tripulante ve «Te contactaremos por WhatsApp»)', mB && mB.delegated === true && mB.delegate == null, mB && [mB.delegated, mB.delegate]);
  const dB = await delegar(raB, 'Uber de Camilo', '3112223344');
  check('a una delegada sin nombre se le puede poner a quién después', dB.was_delegated === true && (await fila(raB)).dn === 'Uber de Camilo', dB);

  // ── 6. Reglas y permisos ──────────────────────────────────────────────────
  console.log('\n6. Reglas y permisos');
  await asUser(c, jefe, 'admin');
  const e1 = await debeFallar(`SELECT public.admin_route_delegate($1, '  ', '3001234567')`, [raB]);
  const e2 = await debeFallar(`SELECT public.admin_route_delegate($1, 'Carlos', '123')`, [raB]);
  await asDb();
  check('sin nombre: «Escribe el nombre de quien hace la vuelta»', e1 && /Escribe el nombre/.test(e1.message), e1 && e1.message);
  check('teléfono corto: «Escribe un teléfono de contacto válido»', e2 && /teléfono de contacto válido/.test(e2.message), e2 && e2.message);
  await q(`UPDATE public.route_stops SET status = 'arrived' WHERE route_assignment_id = $1`, [raB]);
  await asUser(c, jefe, 'admin');
  const e3 = await debeFallar(`SELECT public.admin_route_delegate($1, 'Carlos', '3001234567')`, [raB]);
  await asDb();
  check('la que ya arrancó no se delega', e3 && /ya arrancó/.test(e3.message), e3 && e3.message);
  for (const [quien, rol] of [[JUAN.u, 'driver'], [LUZ.u, 'auxiliar']]) {
    await asUser(c, quien, rol);
    const e = await debeFallar(`SELECT public.admin_route_delegate($1, 'X Y', '3001234567')`, [raA]);
    await asDb();
    check(`un ${rol === 'driver' ? 'conductor' : 'tripulante'} no puede delegar`, e && /Solo un jefe/.test(e.message), e && e.message);
  }
  const otraOrg = (await one(`INSERT INTO public.organizations (name, slug) VALUES ('Otra 0131', 'otra-0131-' || substr(md5(random()::text), 1, 6)) RETURNING id`)).id;
  const jefeAjeno = await user(c, otraOrg, 'admin', 'Jefe ajeno 0131');
  await asUser(c, jefeAjeno, 'admin');
  const e4 = await debeFallar(`SELECT public.admin_route_delegate($1, 'X Y', '3001234567')`, [raA]);
  await asDb();
  check('el jefe de otra organización no ve la vuelta del tablero (organization_id NULL)', e4 && /Esa vuelta no existe/.test(e4.message), e4 && e4.message);
  await asUser(c, jefeAjeno, 'admin');
  const e5 = await debeFallar(`SELECT public.admin_route_set_delegated($1, true)`, [raA]);
  await asDb();
  check('…ni la puede delegar con la de 0126 (la guarda arreglada en 0131)', e5 && /Esa vuelta no existe/.test(e5.message) && (await fila(raA)).dg === null, e5 && e5.message);
  check('la libreta: el jefe de otra organización no ve nada', (await libreta(jefeAjeno)).length === 0);
  check('la libreta: un conductor no ve nada', (await libreta(JUAN.u, 'driver')).length === 0);
  check('la libreta: el jefe ve las suyas', (await libreta()).length >= 2);

  // ── 7. Down ───────────────────────────────────────────────────────────────
  console.log('\n7. Reversa');
  await c.query(strip('../down_migrations/0131_delegado_con_nombre.down.sql'));
  check('el down devuelve auxiliar_my_trips EXACTAMENTE a la de 0126', (await huella()) === h0126);
  check('…y admin_route_set_delegated también', (await hDel()) === hDel0126);
  const d = await one(`SELECT to_regprocedure('public.admin_route_delegate(uuid,text,text)') f, to_regclass('public.delegate_contacts') t,
      (SELECT count(*)::int FROM information_schema.columns WHERE table_name = 'route_assignments' AND column_name IN ('delegate_name', 'delegate_phone')) cols`);
  check('…y quita la RPC, la libreta y las columnas', d.f === null && d.t === null && d.cols === 0, d);
  const mF = await mis(MAR, rMar);
  check('«mis viajes» sigue funcionando después del down', Array.isArray([mF]) && mF && mF.delegated === true);
} catch (e) {
  fail++; console.log('  ✗ ERROR', e.message, e.where || '');
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok} ✓ · ${fail} ✗`);
process.exit(fail ? 1 : 0);
