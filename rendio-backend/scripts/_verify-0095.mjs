// Verificación de 0095: documentos del carro (espejo con vehicles, RPC del jefe,
// RLS, el reloj diario de avisos a los jefes y lo que ve el CONDUCTOR por
// driver_vehicle_documents: solo los 5 de la vía, sin número/entidad/nota, los
// estados con sus bordes, «No aplica», y quién NO la puede llamar).
//
// Base LOCAL (127.0.0.1:54322), todo dentro de una transacción que se deshace.
//   cd rendio-backend/scripts && node _verify-0095.mjs
import { localClient, fixtures, user } from './_local-fixtures.mjs';

const c = await localClient();
const q = async (s, p) => (await c.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
let ok = 0, fail = 0;
const check = (n, cond, det) => { if (cond) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + det : ''}`); } };
const como = async (uid) => { await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]); await c.query('SET LOCAL ROLE authenticated'); };
const comoDb = async () => { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', '', true)`); };
async function intenta(sql, params) {
  await c.query('SAVEPOINT sp');
  try { const r = await c.query(sql, params); await c.query('RELEASE SAVEPOINT sp'); return { rows: r.rows }; }
  catch (e) { await c.query('ROLLBACK TO SAVEPOINT sp'); return { err: e.message }; }
}

await c.query('BEGIN');
try {
  const fx = await fixtures(c);
  const jefe = await user(c, fx.org, 'admin', 'Jefe de prueba');
  fx.vehStatus = (await one(`SELECT status::text AS s FROM public.vehicles WHERE id = $1`, [fx.vehicle])).s;
  const hoy = (await one(`SELECT public.vehicle_docs_today() d`)).d;
  const mas = async (n) => (await one(`SELECT ($1::date + $2::int) d`, [hoy, n])).d;
  const doc = async (kind) => one(`SELECT * FROM public.vehicle_documents WHERE vehicle_id = $1 AND kind = $2`, [fx.vehicle, kind]);
  const correr = async (dia) => (await one(`SELECT public.vehicle_docs_run_daily($1::date) v`, [dia])).v;
  const avisosJefe = async () => Number((await one(`SELECT count(*) n FROM public.notification_outbox WHERE profile_id = $1 AND url LIKE '/#/repuestos?veh=%'`, [jefe])).n);

  console.log('\n1. Espejo con vehicles');
  await q(`UPDATE public.vehicles SET soat_expires_at = $2 WHERE id = $1`, [fx.vehicle, await mas(100)]);
  let d = await doc('soat');
  check('poner el SOAT en vehicles (Flota) crea el documento', d && String(d.expires_on) === String(await mas(100)), d && d.expires_on);
  await como(jefe);
  let r = await intenta(`SELECT public.save_vehicle_document($1, 'seguro', $2, 'POL-1', 'Sura', NULL, false) v`, [fx.vehicle, await mas(200)]);
  await comoDb();
  check('el jefe guarda el seguro por la RPC', !r.err, r.err);
  const v = await one(`SELECT insurance_expires_at FROM public.vehicles WHERE id = $1`, [fx.vehicle]);
  check('…y queda en vehicles.insurance_expires_at', String(v.insurance_expires_at) === String(await mas(200)), v.insurance_expires_at);
  await como(jefe);
  r = await intenta(`SELECT public.save_vehicle_document($1, 'soat', $2, NULL, NULL, NULL, false) v`, [fx.vehicle, await mas(120)]);
  await comoDb();
  const v2 = await one(`SELECT soat_expires_at FROM public.vehicles WHERE id = $1`, [fx.vehicle]);
  check('cambiar el SOAT en Repuestos lo cambia en Flota', !r.err && String(v2.soat_expires_at) === String(await mas(120)), r.err || v2.soat_expires_at);

  console.log('\n2. Permisos');
  await como(fx.drvUser);
  r = await intenta(`SELECT public.save_vehicle_document($1, 'impuesto', $2, NULL, NULL, NULL, false) v`, [fx.vehicle, await mas(10)]);
  const leer = await intenta(`SELECT count(*) n FROM public.vehicle_documents`);
  await comoDb();
  check('un conductor NO guarda documentos', !!r.err, JSON.stringify(r.rows));
  check('un conductor no ve documentos', leer.err || Number(leer.rows[0].n) === 0, JSON.stringify(leer));
  await como(jefe);
  r = await intenta(`SELECT public.save_vehicle_document($1, 'inventado', $2, NULL, NULL, NULL, false) v`, [fx.vehicle, await mas(10)]);
  await comoDb();
  check('un tipo que no existe se rechaza', !!r.err);

  console.log('\n3. Reloj diario');
  await como(jefe);
  await q(`SELECT public.save_vehicle_document($1, 'impuesto', $2, NULL, NULL, NULL, false)`, [fx.vehicle, await mas(30)]);
  await q(`SELECT public.save_vehicle_document($1, 'extintor', $2, NULL, NULL, NULL, true)`, [fx.vehicle, await mas(2)]);
  await comoDb();
  await correr(hoy);
  check('impuesto a 30 días: 1 aviso al jefe', (await avisosJefe()) === 1, await avisosJefe());
  await correr(hoy);
  check('correrlo otra vez el mismo día no repite', (await avisosJefe()) === 1, await avisosJefe());
  await correr(await mas(1));
  check('al día siguiente (29 días) no repite la misma etapa', (await avisosJefe()) === 1, await avisosJefe());
  await correr(await mas(15));
  check('a 15 días: aviso nuevo', (await avisosJefe()) === 2, await avisosJefe());
  await correr(await mas(30));
  check('el día que vence: aviso «hoy»', (await avisosJefe()) === 3, await avisosJefe());
  await correr(await mas(33));
  await correr(await mas(35));
  check('vencido: un aviso por semana (días 33 y 35 = misma semana)', (await avisosJefe()) === 4, await avisosJefe());
  await correr(await mas(38));
  check('…y otro a la semana siguiente', (await avisosJefe()) === 5, await avisosJefe());
  const na = Number((await one(`SELECT count(*) n FROM public.vehicle_document_alerts WHERE kind = 'extintor'`)).n);
  check('«No aplica» nunca avisa', na === 0, na);
  const txt = await one(`SELECT title, body FROM public.notification_outbox WHERE profile_id = $1 AND title LIKE 'Vencido:%' LIMIT 1`, [jefe]);
  check('el aviso de vencido dice que no se bloquea el carro', txt && /no se bloquea/.test(txt.body), txt && txt.body);
  const antes = fx.vehStatus;
  const bloqueo = await one(`SELECT status::text AS status, deleted_at FROM public.vehicles WHERE id = $1`, [fx.vehicle]);
  check('el carro no cambia de estado (no se bloquea)', bloqueo.deleted_at === null && bloqueo.status === antes, JSON.stringify(bloqueo));

  console.log('\n4. Lo que ve el conductor (driver_vehicle_documents)');
  // Hoy fijo (solo una sesión postgres puede fijarlo): los bordes no dependen
  // del reloj, y se prueba que la RPC usa el MISMO «hoy» de Bogotá que el reloj.
  const HOY4 = '2026-10-15';
  await q(`SELECT set_config('rendio.docs_today', $1, true)`, [HOY4]);
  const dia = async (n) => (await one(`SELECT to_char($1::date + $2::int, 'YYYY-MM-DD') d`, [HOY4, n])).d;
  const vA = (await one(`INSERT INTO public.vehicles (organization_id, internal_code, license_plate) VALUES ($1, 'P-02', 'RDO482') RETURNING id`, [fx.org])).id;
  const vB = (await one(`INSERT INTO public.vehicles (organization_id, internal_code, license_plate) VALUES ($1, 'P-03', 'RDO483') RETURNING id`, [fx.org])).id;
  const vC = (await one(`INSERT INTO public.vehicles (organization_id, internal_code, license_plate) VALUES ($1, 'P-04', 'RDO484') RETURNING id`, [fx.org])).id;
  await como(jefe);
  const guarda = (veh, kind, fecha, num, ent, nota, na) => q(`SELECT public.save_vehicle_document($1, $2, $3::date, $4, $5, $6, $7)`, [veh, kind, fecha, num, ent, nota, na]);
  await guarda(vA, 'soat',              await dia(-1),  'SOAT-77', 'Previsora', 'nota del soat', false);
  await guarda(vA, 'tecnomecanica',     await dia(0),   null, null, null, false);
  await guarda(vA, 'seguro',            await dia(30),  'POL-9', 'Sura', 'nota secreta del jefe', false);
  await guarda(vA, 'polizas_rc',        await dia(31),  null, null, null, false);
  await guarda(vA, 'extintor',          await dia(-10), null, null, null, true);    // «No aplica» con fecha vieja
  await guarda(vA, 'impuesto',          await dia(-5),  null, null, null, false);   // vencido, pero no es de la vía
  await guarda(vA, 'tarjeta_propiedad', null,           'TP-123456', null, null, false);
  await guarda(vB, 'soat',              null,           null, null, null, false);   // fila sin fecha = sin dato
  await guarda(vC, 'soat',              await dia(-3),  null, null, null, false);
  await comoDb();
  await q(`UPDATE public.vehicles SET deleted_at = now() WHERE id = $1`, [vC]);

  const SQL_DOCS = `SELECT vehicle_id, kind, label, to_char(expires_on, 'YYYY-MM-DD') AS exp, days_left, status, not_applicable
                      FROM public.driver_vehicle_documents($1::uuid[])`;
  await como(fx.drvUser);
  r = await intenta(`SELECT * FROM public.driver_vehicle_documents(NULL)`);
  const todas = await intenta(SQL_DOCS, [null]);
  const soloB = await intenta(SQL_DOCS, [[vB]]);
  await comoDb();
  check('el conductor de la organización puede llamarla', !r.err && !todas.err, r.err || todas.err);
  const filas = (todas.rows || []);
  const deA = filas.filter(x => x.vehicle_id === vA);
  const byKind = Object.fromEntries(deA.map(x => [x.kind, x]));
  check('devuelve exactamente las 7 columnas prometidas (sin número, entidad ni nota)',
    r.rows && r.rows[0] && Object.keys(r.rows[0]).sort().join(',') === 'days_left,expires_on,kind,label,not_applicable,status,vehicle_id',
    r.rows && r.rows[0] && Object.keys(r.rows[0]).join(','));
  const crudo = JSON.stringify(r.rows || []);
  check('ni el número, ni la aseguradora, ni la nota salen por ningún lado',
    !/SOAT-77|POL-9|Sura|Previsora|nota del soat|nota secreta|TP-123456/.test(crudo), crudo.slice(0, 200));
  check('solo los 5 de la vía, en orden (sin impuesto ni tarjeta de propiedad)',
    deA.map(x => x.kind).join(',') === 'soat,tecnomecanica,seguro,polizas_rc,extintor', deA.map(x => x.kind).join(','));
  check('vencido ayer → «vencido», faltan −1', byKind.soat && byKind.soat.status === 'vencido' && byKind.soat.days_left === -1 && byKind.soat.exp === await dia(-1), JSON.stringify(byKind.soat));
  check('vence hoy → «hoy», faltan 0', byKind.tecnomecanica && byKind.tecnomecanica.status === 'hoy' && byKind.tecnomecanica.days_left === 0, JSON.stringify(byKind.tecnomecanica));
  check('faltan 30 (borde de la ventana) → «por_vencer»', byKind.seguro && byKind.seguro.status === 'por_vencer' && byKind.seguro.days_left === 30, JSON.stringify(byKind.seguro));
  check('faltan 31 (fuera de la ventana de 30) → «al_dia»', byKind.polizas_rc && byKind.polizas_rc.status === 'al_dia' && byKind.polizas_rc.days_left === 31, JSON.stringify(byKind.polizas_rc));
  check('«No aplica» → no_aplica, sin fecha ni días, aunque tenga una fecha vieja guardada',
    byKind.extintor && byKind.extintor.status === 'no_aplica' && byKind.extintor.not_applicable === true && byKind.extintor.exp === null && byKind.extintor.days_left === null,
    JSON.stringify(byKind.extintor));
  check('la etiqueta es la de la base', byKind.polizas_rc && byKind.polizas_rc.label === 'Pólizas RCC/RCE', byKind.polizas_rc && byKind.polizas_rc.label);
  const deB = filas.filter(x => x.vehicle_id === vB);
  check('carro sin documentos: 5 filas «sin_dato» (fila sin fecha y sin fila, igual)',
    deB.length === 5 && deB.every(x => x.status === 'sin_dato' && x.exp === null && x.days_left === null && x.not_applicable === false),
    JSON.stringify(deB));
  check('el carro borrado no sale', !filas.some(x => x.vehicle_id === vC));
  check('pedir un carro devuelve solo ese', !soloB.err && soloB.rows.length === 5 && soloB.rows.every(x => x.vehicle_id === vB), soloB.err || soloB.rows.length);

  // La ventana es la del aviso a los jefes: si sube a 45, a 31 días ya es «por vencer».
  const haySingleton = Number((await one(`SELECT count(*) n FROM public.app_settings WHERE id = 'singleton'`)).n);
  if (!haySingleton) await q(`INSERT INTO public.app_settings (id) VALUES ('singleton')`);
  await q(`UPDATE public.app_settings SET vehicle_doc_alert_days = 45 WHERE id = 'singleton'`);
  await como(fx.drvUser);
  const con45 = await intenta(SQL_DOCS, [[vA]]);
  await comoDb();
  const rc45 = (con45.rows || []).find(x => x.kind === 'polizas_rc');
  check('con ventana de 45, faltan 31 → «por_vencer»', rc45 && rc45.status === 'por_vencer', con45.err || JSON.stringify(rc45));

  // Otro «hoy»: el estado se mueve con la fecha de la base, no con el reloj del teléfono.
  await q(`SELECT set_config('rendio.docs_today', $1, true)`, [await dia(1)]);
  await como(fx.drvUser);
  const manana = await intenta(SQL_DOCS, [[vA]]);
  await comoDb();
  const tecM = (manana.rows || []).find(x => x.kind === 'tecnomecanica');
  check('al día siguiente, lo que vencía hoy ya sale «vencido» (−1)', tecM && tecM.status === 'vencido' && tecM.days_left === -1, manana.err || JSON.stringify(tecM));
  await q(`SELECT set_config('rendio.docs_today', $1, true)`, [HOY4]);

  console.log('\n5. Quién NO la puede llamar');
  const orgB = (await one(`INSERT INTO public.organizations (name, slug) VALUES ('Otra empresa', 'otra-' || substr(md5(random()::text), 1, 6)) RETURNING id`)).id;
  const drvB = await user(c, orgB, 'driver', 'Conductor de otra empresa');
  await q(`INSERT INTO public.driver_profiles (profile_id) VALUES ($1)`, [drvB]);
  const vZ = (await one(`INSERT INTO public.vehicles (organization_id, internal_code, license_plate) VALUES ($1, 'Z-01', 'ZZZ901') RETURNING id`, [orgB])).id;
  await como(drvB);
  const ajenoTodo = await intenta(SQL_DOCS, [null]);
  const ajenoPide = await intenta(SQL_DOCS, [[vA, fx.vehicle]]);
  await comoDb();
  check('un conductor de OTRA organización no ve ningún carro de esta', !ajenoTodo.err && !ajenoTodo.rows.some(x => x.vehicle_id === vA || x.vehicle_id === vB || x.vehicle_id === fx.vehicle),
    ajenoTodo.err || JSON.stringify(ajenoTodo.rows.map(x => x.vehicle_id)));
  check('…solo los suyos', !ajenoTodo.err && ajenoTodo.rows.length === 5 && ajenoTodo.rows.every(x => x.vehicle_id === vZ), ajenoTodo.err || ajenoTodo.rows.length);
  check('…y si pide los de esta por id, no le sale nada', !ajenoPide.err && ajenoPide.rows.length === 0, ajenoPide.err || ajenoPide.rows.length);

  await como(fx.auxUser);
  const trip = await intenta(SQL_DOCS, [null]);
  await comoDb();
  check('un tripulante no puede llamarla', !!trip.err && /NOT_A_DRIVER/.test(trip.err), trip.err || JSON.stringify(trip.rows));

  await como(jefe);
  const jefeLlama = await intenta(SQL_DOCS, [null]);
  await comoDb();
  check('el jefe tampoco (él tiene la tabla en Repuestos)', !!jefeLlama.err && /NOT_A_DRIVER/.test(jefeLlama.err), jefeLlama.err || JSON.stringify(jefeLlama.rows));

  const inactivo = await user(c, fx.org, 'driver', 'Conductor inactivo');
  await q(`UPDATE public.profiles SET is_active = false WHERE id = $1`, [inactivo]);
  await como(inactivo);
  const inact = await intenta(SQL_DOCS, [null]);
  await comoDb();
  check('un conductor inactivo no', !!inact.err && /NOT_A_DRIVER/.test(inact.err), inact.err || JSON.stringify(inact.rows));

  await c.query('SAVEPOINT anon');
  let anonErr = null;
  try {
    await c.query(`SELECT set_config('request.jwt.claims', '', true)`);
    await c.query('SET LOCAL ROLE anon');
    await c.query(`SELECT * FROM public.driver_vehicle_documents(NULL)`);
  } catch (e) { anonErr = e.message; }
  await c.query('ROLLBACK TO SAVEPOINT anon');
  await comoDb();
  check('anon no (sin permiso de ejecutar)', !!anonErr && /permission denied/i.test(anonErr), anonErr);

  const priv = await one(`SELECT has_function_privilege('anon', 'public.driver_vehicle_documents(uuid[])', 'EXECUTE') AS anon,
                                 has_function_privilege('authenticated', 'public.driver_vehicle_documents(uuid[])', 'EXECUTE') AS auth,
                                 p.prosecdef, array_to_string(p.proconfig, ';') AS cfg
                            FROM pg_proc p WHERE p.oid = 'public.driver_vehicle_documents(uuid[])'::regprocedure`);
  check('permisos: authenticated sí, anon no; SECURITY DEFINER con search_path',
    priv.anon === false && priv.auth === true && priv.prosecdef === true && /search_path=public, pg_temp/.test(priv.cfg || ''), JSON.stringify(priv));
  await como(fx.drvUser);
  const sigueCerrada = await intenta(`SELECT count(*) n FROM public.vehicle_documents`);
  await comoDb();
  check('la tabla sigue cerrada para el conductor (la RPC no abre RLS)', sigueCerrada.err || Number(sigueCerrada.rows[0].n) === 0, JSON.stringify(sigueCerrada));
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok} ✓ · ${fail} ✗`);
console.log('NO cubre: pg_cron corriendo de verdad, la push real (drain + VAPID), PostgREST/supabase-js');
console.log('(se llama por SQL con el rol y los claims puestos a mano) ni pantallas.');
process.exit(fail ? 1 : 0);
