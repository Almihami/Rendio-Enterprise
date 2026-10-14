// Verificación de 0096: retención de fotos de inspección.
//
//   · photo_purge_candidates: la rutina vieja de una inspección aprobada sin
//     fallas SÍ; golpe, adicional, del jefe, tanqueo, rechazada, pendiente, con
//     fallas (las tres formas), gravedad media, NO APTA, con novedad, reciente y
//     ya purgada NO; huérfanas de más de 3 días sí y de menos no, con las
//     carpetas protegidas (inspección con golpe, cierre con novedad, recibos);
//     el número de días sale de Ajustes; orden y paginado.
//   · mark_photos_purged: marca solo lo que YA no está en Storage.
//   · run_photo_purge: sin secretos lo dice; con secretos y sin candidatos no
//     dispara; con candidatos encola el POST.
//   · purge_cron_history, los dos relojes y los permisos (solo service_role).
//
// Base LOCAL (127.0.0.1:54322), todo dentro de una transacción que se deshace.
//   cd rendio-backend/scripts && node _verify-0096.mjs
//   node _verify-0096.mjs --despues-del-down     (comprueba que el down limpió)
import { localClient, fixtures, user } from './_local-fixtures.mjs';

const c = await localClient();
const q = async (s, p) => (await c.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
let ok = 0, fail = 0;
const check = (n, cond, det) => { if (cond) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${det != null ? ' → ' + det : ''}`); } };
async function intenta(sql, params) {
  await c.query('SAVEPOINT sp');
  try { const r = await c.query(sql, params); await c.query('RELEASE SAVEPOINT sp'); return { rows: r.rows }; }
  catch (e) { await c.query('ROLLBACK TO SAVEPOINT sp'); return { err: e.message }; }
}
const comoDb = async () => { await c.query('RESET ROLE'); await c.query(`SELECT set_config('request.jwt.claims', '', true)`); };
const como = async (uid, role = 'authenticated') => {
  await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role })]);
  await c.query(`SET LOCAL ROLE ${role}`);
};

// ─────────────────────────────────────────────────────────────────────────────
if (process.argv.includes('--despues-del-down')) {
  console.log('\nDespués del down: no queda nada de 0096');
  const fns = await q(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public' AND p.proname IN
                        ('photo_purge_candidates','mark_photos_purged','run_photo_purge','purge_cron_history','_photo_purge_guard','_checklist_has_issue')`);
  check('las seis funciones se fueron', fns.length === 0, fns.map(f => f.proname).join(','));
  const cols = await q(`SELECT table_name, column_name FROM information_schema.columns
                         WHERE table_schema = 'public' AND ((table_name = 'app_settings' AND column_name = 'photo_retention_days')
                            OR (table_name = 'inspection_photos' AND column_name = 'purged_at'))`);
  check('las dos columnas se fueron', cols.length === 0, JSON.stringify(cols));
  const jobs = await q(`SELECT jobname FROM cron.job WHERE jobname IN ('purge-old-photos','purge-cron-history')`);
  check('los dos relojes se fueron', jobs.length === 0, jobs.map(j => j.jobname).join(','));
  const otros = await q(`SELECT jobname FROM cron.job WHERE jobname IN ('drain-notification-outbox','purge-driver-locations')`);
  check('…y los relojes de las otras migraciones siguen', otros.length === 2, otros.map(j => j.jobname).join(','));
  await c.end();
  console.log(`\n${ok} ✓ · ${fail} ✗`);
  process.exit(fail ? 1 : 0);
}

await c.query('BEGIN');
try {
  const fx = await fixtures(c);
  const jefe = await user(c, fx.org, 'admin', 'Jefe de prueba 0096');
  const B = 'inspections';

  // Un turno + su inspección inicial. El trigger de 0024 fija review_status al
  // insertar (sin golpe = aprobada; con golpe = pendiente); el estado que se
  // quiera probar se pone después, como lo haría la RPC del jefe.
  let n = 0;
  async function inspeccion({ dias = 90, damage = false, status = null, checklist = null, apt = true } = {}) {
    n++;
    const shift = (await one(`INSERT INTO public.shifts (organization_id, driver_id, vehicle_id, status, start_at, end_at)
      VALUES ($1, $2, $3, 'closed', now() - make_interval(days => $4) - interval '1 hour', now() - make_interval(days => $4) + interval '10 hours') RETURNING id`,
      [fx.org, fx.driver, fx.vehicle, dias])).id;
    const id = (await one(`INSERT INTO public.inspections (organization_id, shift_id, vehicle_id, driver_id, kind, odometer_km, checklist, has_damage, is_apt, performed_at)
      VALUES ($1, $2, $3, $4, 'initial', 1000 + $5, $6, $7, $8, now() - make_interval(days => $9)) RETURNING id`,
      [fx.org, shift, fx.vehicle, fx.driver, n,
       JSON.stringify(checklist || { severity: null, items: [{ id: 'a', result: 'ok' }, { id: 'b', result: 'ok' }] }),
       damage, apt, dias])).id;
    if (status) await q(`UPDATE public.inspections SET review_status = $2 WHERE id = $1`, [id, status]);
    return { id, shift, dir: `${fx.org}/${fx.vehicle}/2026-07-01/${id}` };
  }
  // Un archivo en Storage (la fila; el disco no se toca en esta prueba).
  async function objeto(name, { dias = 90, bytes = 110000, bucket = B } = {}) {
    await q(`INSERT INTO storage.objects (bucket_id, name, owner, metadata, created_at, updated_at)
      VALUES ($1, $2, NULL, jsonb_build_object('size', $3::int, 'mimetype', 'image/jpeg'), now() - make_interval(days => $4), now() - make_interval(days => $4))`,
      [bucket, name, bytes, dias]);
  }
  async function foto(insp, tipo, { archivo = true, purgada = false, dias = 90 } = {}) {
    const path = `${insp.dir}/${tipo}${tipo === 'extra' || tipo === 'admin' || tipo === 'damage' ? '-1' : ''}.jpg`;
    const id = (await one(`INSERT INTO public.inspection_photos (inspection_id, organization_id, photo_type, storage_path, size_bytes, purged_at)
      VALUES ($1, $2, $3, $4, 110000, $5) RETURNING id`, [insp.id, fx.org, tipo, path, purgada ? new Date().toISOString() : null])).id;
    if (archivo) await objeto(path, { dias });
    return { id, path };
  }
  const candidatos = async (lim = 1000, off = 0) => q(`SELECT * FROM public.photo_purge_candidates($1, $2)`, [lim, off]);
  // Solo lo de esta prueba (la base local la comparten otras verificaciones).
  const mios = (rows) => rows.filter(r => String(r.path).startsWith(fx.org + '/'));
  const tiene = (rows, path) => rows.some(r => r.path === path);

  console.log('\n1. Columnas y Ajustes');
  const haySingleton = Number((await one(`SELECT count(*) n FROM public.app_settings WHERE id = 'singleton'`)).n);
  if (!haySingleton) await q(`INSERT INTO public.app_settings (id) VALUES ('singleton')`);
  const d = await one(`SELECT photo_retention_days AS d FROM public.app_settings WHERE id = 'singleton'`);
  check('app_settings.photo_retention_days existe y arranca en 60', Number(d.d) === 60, d.d);
  let r = await intenta(`UPDATE public.app_settings SET photo_retention_days = 29 WHERE id = 'singleton'`);
  check('menos de 30 días se rechaza', !!r.err, r.err);
  r = await intenta(`UPDATE public.app_settings SET photo_retention_days = 366 WHERE id = 'singleton'`);
  check('más de 365 días se rechaza', !!r.err, r.err);
  const col = await one(`SELECT data_type, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='inspection_photos' AND column_name='purged_at'`);
  check('inspection_photos.purged_at (timestamptz, puede ser nulo)', col && /timestamp with time zone/.test(col.data_type) && col.is_nullable === 'YES', JSON.stringify(col));

  console.log('\n2. Rutina: qué entra y qué no');
  const buena = await inspeccion();
  const fFront = await foto(buena, 'front');
  const fRear = await foto(buena, 'rear', { archivo: false });     // la fila sin archivo
  const fTarj = await foto(buena, 'property_card');
  const fExtra = await foto(buena, 'extra');
  const fAdmin = await foto(buena, 'admin');
  const fYa = await foto(buena, 'glovebox', { purgada: true });

  const golpe = await inspeccion({ damage: true, status: 'approved', checklist: { severity: 'leve', items: [{ id: 'a', result: 'issue' }] } });
  const gFront = await foto(golpe, 'front'); const gDamage = await foto(golpe, 'damage');
  const rech = await inspeccion({ status: 'rejected' }); const rFront = await foto(rech, 'front');
  const pend = await inspeccion({ status: 'pending' }); const pFront = await foto(pend, 'front');
  const falla = await inspeccion({ checklist: { severity: null, items: [{ id: 'a', result: 'ok' }, { id: 'b', result: 'issue' }] } });
  const faFront = await foto(falla, 'front');
  const media = await inspeccion({ checklist: { severity: 'media', items: [] } }); const mFront = await foto(media, 'front');
  const vieja = await inspeccion({ checklist: { a: 'ok', b: 'issue' } }); const vFront = await foto(vieja, 'front');
  const noApta = await inspeccion({ apt: false }); const naFront = await foto(noApta, 'front');
  const conNov = await inspeccion(); const nFront = await foto(conNov, 'front');
  await q(`INSERT INTO public.incidents (organization_id, reporter_id, shift_id, vehicle_id, category, severity, description)
           VALUES ($1, $2, $3, $4, 'other', 'low', 'Aviso de km de prueba')`, [fx.org, fx.drvUser, conNov.shift, fx.vehicle]);
  const reciente = await inspeccion({ dias: 10 }); const reFront = await foto(reciente, 'front', { dias: 10 });
  // La misma foto también es evidencia de una eventualidad.
  const ev = await inspeccion(); const evFront = await foto(ev, 'front');
  await q(`INSERT INTO public.incidents (organization_id, reporter_id, vehicle_id, category, severity, description, photo_paths)
           VALUES ($1, $2, $3, 'vehicle_problem', 'medium', 'Evidencia de prueba', $4)`, [fx.org, fx.drvUser, fx.vehicle, JSON.stringify([evFront.path])]);
  // Comprobante de tanqueo viejo (fila + archivo).
  const recibo = `${fx.org}/${fx.vehicle}/2026-07-01/close-${buena.shift}/receipt-1.jpg`;
  await objeto(recibo, { bytes: 240000 });
  await q(`INSERT INTO public.fuel_receipts (organization_id, shift_id, vehicle_id, driver_id, amount_cop, storage_path)
           VALUES ($1, $2, $3, $4, 120000, $5)`, [fx.org, buena.shift, fx.vehicle, fx.driver, recibo]);

  let cand = mios(await candidatos());
  check('la rutina vieja aprobada sin fallas SÍ (frontal)', tiene(cand, fFront.path), JSON.stringify(cand.map(x => x.path)));
  check('…y la tarjeta de propiedad (todo tipo fijo, también el que se agregue después)', tiene(cand, fTarj.path));
  const cf = cand.find(x => x.path === fFront.path) || {};
  check('…con motivo rutina_vencida, su photo_id, bucket inspections, bytes y en Storage',
    cf.motivo === 'rutina_vencida' && cf.photo_id === fFront.id && cf.bucket === B && Number(cf.bytes) === 110000 && cf.in_storage === true, JSON.stringify(cf));
  const cr = cand.find(x => x.path === fRear.path) || {};
  check('la fila cuyo archivo ya no está sale con in_storage=false y bytes nulo (solo hay que marcarla)',
    cr.in_storage === false && cr.bytes === null && cr.photo_id === fRear.id, JSON.stringify(cr));
  check('NUNCA la adicional del conductor', !tiene(cand, fExtra.path));
  check('NUNCA la que subió el jefe', !tiene(cand, fAdmin.path));
  check('la ya purgada no vuelve a salir', !tiene(cand, fYa.path));
  check('NUNCA la foto del golpe', !tiene(cand, gDamage.path));
  check('…ni la rutina de una inspección con golpe (aunque el jefe la aprobó)', !tiene(cand, gFront.path));
  check('NUNCA de una inspección rechazada', !tiene(cand, rFront.path));
  check('NUNCA de una pendiente', !tiene(cand, pFront.path));
  check('NUNCA con un ítem en issue (aunque has_damage diga false)', !tiene(cand, faFront.path));
  check('NUNCA con gravedad media', !tiene(cand, mFront.path));
  check('NUNCA con el checklist viejo (mapa) que tiene un issue', !tiene(cand, vFront.path));
  check('NUNCA de una inspección NO APTA', !tiene(cand, naFront.path));
  check('NUNCA si el turno tiene una novedad (cualquiera)', !tiene(cand, nFront.path));
  check('NUNCA si la foto es evidencia de una eventualidad (photo_paths)', !tiene(cand, evFront.path));
  check('NUNCA la reciente (10 días)', !tiene(cand, reFront.path));
  check('NUNCA un comprobante de tanqueo', !tiene(cand, recibo));

  console.log('\n3. Los días salen de Ajustes');
  await q(`UPDATE public.app_settings SET photo_retention_days = 120 WHERE id = 'singleton'`);
  cand = mios(await candidatos());
  check('con 120 días, la de hace 90 ya no sale', !tiene(cand, fFront.path), cand.length);
  await q(`UPDATE public.app_settings SET photo_retention_days = 30 WHERE id = 'singleton'`);
  cand = mios(await candidatos());
  check('con 30 días, la de hace 10 sigue protegida', !tiene(cand, reFront.path));
  const masDe30 = await inspeccion({ dias: 31 }); const m31 = await foto(masDe30, 'front', { dias: 31 });
  cand = mios(await candidatos());
  check('…y la de hace 31 entra', tiene(cand, m31.path));
  await q(`UPDATE public.app_settings SET photo_retention_days = 60 WHERE id = 'singleton'`);
  cand = mios(await candidatos());
  check('de vuelta a 60: la de 31 sale de la lista', !tiene(cand, m31.path));

  console.log('\n4. Huérfanas');
  const otraCarpeta = `${fx.org}/${fx.vehicle}/2026-07-01/00000000-0000-4000-8000-${String(Date.now()).slice(-12)}`;
  const h5 = `${otraCarpeta}/front.jpg`;            await objeto(h5, { dias: 5 });
  const h1 = `${otraCarpeta}/rear.jpg`;             await objeto(h1, { dias: 1 });
  const hGolpe = `${golpe.dir}/left.jpg`;           await objeto(hGolpe, { dias: 5 });   // subió pero no se registró
  const hBuena = `${buena.dir}/right.jpg`;          await objeto(hBuena, { dias: 5 });
  const hRec = `${fx.org}/${fx.vehicle}/2026-07-01/close-${buena.shift}/receipt-2.jpg`; await objeto(hRec, { dias: 5 });
  const hMedNov = `${fx.org}/${fx.vehicle}/2026-07-01/close-${conNov.shift}/media-1.jpg`; await objeto(hMedNov, { dias: 5 });
  const hMed = `${fx.org}/${fx.vehicle}/2026-07-01/close-${buena.shift}/media-1.jpg`;   await objeto(hMed, { dias: 5 });
  const hEv = `${fx.org}/${fx.vehicle}/2026-07-01/evento/foto-1.jpg`; await objeto(hEv, { dias: 5 });
  await q(`INSERT INTO public.incidents (organization_id, reporter_id, vehicle_id, category, severity, description, photo_paths)
           VALUES ($1, $2, $3, 'traffic', 'low', 'Otra evidencia', $4)`, [fx.org, fx.drvUser, fx.vehicle, JSON.stringify([hEv])]);
  const hOtroBucket = `${fx.org}/avatar-viejo.jpg`; await objeto(hOtroBucket, { dias: 50, bucket: 'profiles' });

  cand = mios(await candidatos());
  const ch5 = cand.find(x => x.path === h5) || {};
  check('huérfana de 5 días SÍ, con motivo huerfana y sin photo_id', ch5.motivo === 'huerfana' && ch5.photo_id === null && ch5.in_storage === true, JSON.stringify(ch5));
  check('huérfana de 1 día NO (puede ser una subida en curso)', !tiene(cand, h1));
  check('huérfana en la carpeta de una inspección con golpe NO', !tiene(cand, hGolpe));
  check('huérfana en la carpeta de una inspección que sí se purga SÍ', tiene(cand, hBuena));
  check('un recibo huérfano NO (sigue siendo un comprobante)', !tiene(cand, hRec));
  check('evidencia huérfana del cierre de un turno con novedad NO', !tiene(cand, hMedNov));
  check('evidencia huérfana del cierre de un turno sin novedad SÍ', tiene(cand, hMed));
  check('un archivo que referencia una eventualidad no es huérfano', !tiene(cand, hEv));
  check('otro bucket no se toca', !(await candidatos()).some(x => x.path === hOtroBucket));

  console.log('\n5. Orden y lotes');
  const todos = await candidatos();
  const primeraHuerf = todos.findIndex(x => x.motivo === 'huerfana');
  const ultimaRutina = todos.map(x => x.motivo).lastIndexOf('rutina_vencida');
  check('la rutina va antes que las huérfanas', primeraHuerf === -1 || ultimaRutina < primeraHuerf, `${ultimaRutina} / ${primeraHuerf}`);
  const p1 = await candidatos(2, 0), p2 = await candidatos(2, 2);
  check('el lote respeta el límite', p1.length === Math.min(2, todos.length), p1.length);
  check('el desplazamiento trae los siguientes, sin repetir', p2.every(x => !p1.some(y => y.path === x.path)) && (todos[2] ? p2[0].path === todos[2].path : true));

  console.log('\n6. mark_photos_purged');
  let m = await one(`SELECT public.mark_photos_purged($1::uuid[]) AS n`, [[fFront.id, fRear.id, gDamage.id]]);
  check('marca la que ya no tiene archivo; NO marca las que siguen en Storage', Number(m.n) === 1, m.n);
  let est = await q(`SELECT id, purged_at IS NOT NULL AS p FROM public.inspection_photos WHERE id = ANY($1::uuid[])`, [[fFront.id, fRear.id, gDamage.id]]);
  const pm = Object.fromEntries(est.map(x => [x.id, x.p]));
  check('…la trasera quedó purgada', pm[fRear.id] === true);
  check('…la frontal (archivo vivo) y la del golpe no', pm[fFront.id] === false && pm[gDamage.id] === false, JSON.stringify(pm));
  // Simula lo que hace la API de Storage al borrar (solo dentro de esta transacción).
  await q(`SELECT set_config('storage.allow_delete_query', 'true', true)`);
  await q(`DELETE FROM storage.objects WHERE bucket_id = $1 AND name = $2`, [B, fFront.path]);
  await q(`SELECT set_config('storage.allow_delete_query', 'false', true)`);
  m = await one(`SELECT public.mark_photos_purged($1::uuid[]) AS n`, [[fFront.id, fFront.id]]);
  check('borrado el archivo, la frontal sí se marca (una vez)', Number(m.n) === 1, m.n);
  m = await one(`SELECT public.mark_photos_purged($1::uuid[]) AS n`, [[fFront.id]]);
  check('marcarla otra vez no cuenta', Number(m.n) === 0, m.n);
  m = await one(`SELECT public.mark_photos_purged(NULL) AS n`);
  check('con NULL no hace nada', Number(m.n) === 0);
  cand = mios(await candidatos());
  check('las marcadas ya no son candidatas', !tiene(cand, fFront.path) && !tiene(cand, fRear.path));
  const sigue = await one(`SELECT count(*) n FROM public.inspection_photos WHERE id = $1`, [fFront.id]);
  check('la fila se conserva (el detalle dice «eliminada por antigüedad»)', Number(sigue.n) === 1);

  console.log('\n7. run_photo_purge');
  const sinSecretos = (await one(`SELECT public.run_photo_purge() AS t`)).t;
  const yaHabia = Number((await one(`SELECT count(*) n FROM vault.secrets WHERE name IN ('purge_photos_url','service_role_key')`)).n);
  if (yaHabia === 0) {
    check('sin secretos en Vault lo dice y no borra nada', /faltan secretos/.test(sinSecretos) && /purge_photos_url/.test(sinSecretos) && /service_role_key/.test(sinSecretos), sinSecretos);
    await q(`SELECT vault.create_secret('http://127.0.0.1:9/purge-old-photos', 'purge_photos_url', 'prueba 0096')`);
    const soloUno = (await one(`SELECT public.run_photo_purge() AS t`)).t;
    check('con un solo secreto dice cuál falta', /service_role_key/.test(soloUno) && !/purge_photos_url/.test(soloUno), soloUno);
    await q(`SELECT vault.create_secret('llave-de-prueba', 'service_role_key', 'prueba 0096')`);
    const antes = Number((await one(`SELECT count(*) n FROM net.http_request_queue`)).n);
    const disp = (await one(`SELECT public.run_photo_purge() AS t`)).t;
    const despues = Number((await one(`SELECT count(*) n FROM net.http_request_queue`)).n);
    check('con secretos y candidatos, dispara (encola el POST)', /^disparado/.test(disp) && despues === antes + 1, `${disp} · cola ${antes}→${despues}`);
    const req = await one(`SELECT url, method, headers FROM net.http_request_queue ORDER BY id DESC LIMIT 1`);
    check('…a la URL de Vault, con la llave como Bearer', req && req.url === 'http://127.0.0.1:9/purge-old-photos' && req.method === 'POST'
      && JSON.stringify(req.headers).includes('Bearer llave-de-prueba'), JSON.stringify(req));
  } else {
    console.log('  (la base local ya tiene secretos de purga en Vault: se salta la parte de «faltan secretos»)');
  }

  console.log('\n8. Permisos');
  for (const [nombre, sql] of [
    ['photo_purge_candidates', `SELECT * FROM public.photo_purge_candidates(5, 0)`],
    ['mark_photos_purged', `SELECT public.mark_photos_purged(ARRAY[$1]::uuid[])`],
    ['run_photo_purge', `SELECT public.run_photo_purge()`],
    ['purge_cron_history', `SELECT public.purge_cron_history(7)`],
  ]) {
    const params = nombre === 'mark_photos_purged' ? [fTarj.id] : undefined;
    await como(jefe);
    const a = await intenta(sql, params);
    await comoDb();
    await como(fx.drvUser);
    const b = await intenta(sql, params);
    await comoDb();
    await c.query('SAVEPOINT anon');
    let anonErr = null;
    try { await c.query(`SET LOCAL ROLE anon`); await c.query(sql, params); } catch (e) { anonErr = e.message; }
    await c.query('ROLLBACK TO SAVEPOINT anon');
    await comoDb();
    check(`${nombre}: ni el jefe, ni un conductor, ni anon`, /permission denied/i.test(a.err || '') && /permission denied/i.test(b.err || '') && /permission denied/i.test(anonErr || ''),
      `${a.err} | ${b.err} | ${anonErr}`);
  }
  await como(null, 'service_role');
  const svc = await intenta(`SELECT count(*) n FROM public.photo_purge_candidates(1000, 0)`);
  await comoDb();
  check('service_role sí la llama', !svc.err, svc.err);
  // El cinturón: aunque la llame alguien con permiso, un JWT que no es de servicio no pasa.
  await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: jefe, role: 'authenticated' })]);
  const cint = await intenta(`SELECT count(*) FROM public.photo_purge_candidates(1, 0)`);
  await comoDb();
  check('con claims de usuario normal la función se niega (SOLO_SERVICIO)', /SOLO_SERVICIO/.test(cint.err || ''), cint.err);
  const tFruta = await one(`SELECT tableoid FROM public.inspection_photos WHERE id = $1`, [fTarj.id]);
  check('(la tarjeta sigue sin marcar: nadie sin permiso la tocó)', !!tFruta && !(await one(`SELECT purged_at FROM public.inspection_photos WHERE id = $1`, [fTarj.id])).purged_at);
  const secdef = await q(`SELECT p.proname, p.prosecdef, array_to_string(p.proconfig, ';') cfg FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                           WHERE n.nspname = 'public' AND p.proname IN ('photo_purge_candidates','mark_photos_purged','run_photo_purge','purge_cron_history')`);
  check('las cuatro son SECURITY DEFINER con search_path fijo', secdef.length === 4 && secdef.every(x => x.prosecdef && /search_path=public/.test(x.cfg || '')), JSON.stringify(secdef));

  console.log('\n9. Historial de pg_cron');
  const jid = (await one(`SELECT jobid FROM cron.job WHERE jobname = 'purge-old-photos'`)).jobid;
  // runid a mano: la secuencia de pg_cron no es de postgres (y la fila se deshace igual).
  const base = Number((await one(`SELECT coalesce(max(runid), 0) + 1000000 AS b FROM cron.job_run_details`)).b);
  await q(`INSERT INTO cron.job_run_details (jobid, runid, command, status, start_time, end_time)
           VALUES ($1, $2, 'prueba vieja', 'succeeded', now() - interval '9 days', now() - interval '9 days'),
                  ($1, $2 + 1, 'prueba sin fin', 'running', now() - interval '20 days', NULL),
                  ($1, $2 + 2, 'prueba nueva', 'succeeded', now() - interval '2 days', now() - interval '2 days')`, [jid, base]);
  const borradas = Number((await one(`SELECT public.purge_cron_history(7) AS n`)).n);
  const quedan = await q(`SELECT command FROM cron.job_run_details WHERE command LIKE 'prueba %'`);
  check('borra las corridas de más de 7 días (también la que nunca terminó)', borradas >= 2 && !quedan.some(x => x.command !== 'prueba nueva'), `${borradas} · ${quedan.map(x => x.command)}`);
  check('…y deja las recientes', quedan.some(x => x.command === 'prueba nueva'));

  console.log('\n10. Los relojes');
  const jobs = Object.fromEntries((await q(`SELECT jobname, schedule, command, active FROM cron.job WHERE jobname IN ('purge-old-photos','purge-cron-history')`)).map(j => [j.jobname, j]));
  const jp = jobs['purge-old-photos'], jh = jobs['purge-cron-history'];
  check('purge-old-photos: 08:15 UTC (3:15 a. m. Bogotá) todos los días', jp && jp.schedule === '15 8 * * *' && /run_photo_purge\(\)/.test(jp.command) && jp.active, JSON.stringify(jp));
  check('purge-cron-history: semanal (domingo)', jh && jh.schedule === '45 8 * * 0' && /purge_cron_history/.test(jh.command) && jh.active, JSON.stringify(jh));
} finally {
  await c.query('ROLLBACK');
  await c.end();
}
console.log(`\n${ok} ✓ · ${fail} ✗`);
console.log('NO cubre: el borrado real de archivos (lo hace la Edge Function con la API de Storage;');
console.log('lo prueba _e2e-0096-purga-local.mjs), pg_cron corriendo de verdad ni la llamada HTTP de pg_net.');
process.exit(fail ? 1 : 0);
