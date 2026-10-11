// Purga de fotos de punta a punta contra el stack LOCAL de Supabase:
// Storage de verdad (archivos subidos y borrados por la API), PostgREST con la
// llave de servicio, las funciones de 0096 y la lógica de la Edge Function
// (purga.ts) con el cliente real de supabase-js. Y antes, el respaldo
// (_respaldo-fotos.mjs) bajando lo que se va a borrar.
//
//   cd rendio-backend/scripts && node _e2e-0096-purga-local.mjs
//   node _e2e-0096-purga-local.mjs --con-edge
//
// Con --con-edge la purga de verdad va por la CADENA COMPLETA: levanta un
// contenedor temporal con la imagen de edge-runtime del stack (Deno de verdad)
// sirviendo supabase/functions/purge-old-photos/index.ts, carga los dos
// secretos en el Vault LOCAL, llama public.run_photo_purge() (lo mismo que
// hace el cron) y pg_net le pega a la función, que borra con la API de
// Storage. Al final borra el contenedor y los dos secretos.
//
// A DIFERENCIA de _verify-0096, esto NO corre en una transacción (la API de
// Storage y PostgREST no ven una transacción abierta): crea una organización de
// prueba con sus filas y archivos y los BORRA al final, también si algo falla.
// Antes de purgar de verdad comprueba que TODOS los candidatos de la base local
// sean de esta prueba; si hay de alguien más, no purga (la purga es global).
// Se niega a correr fuera de 127.0.0.1.
import { readdirSync, readFileSync, rmSync, statSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { localClient, fixtures, user } from './_local-fixtures.mjs';
import { purgarFotos } from '../supabase/functions/purge-old-photos/purga.ts';

const API = 'http://127.0.0.1:54321';
const SECRET = process.env.LOCAL_JWT_SECRET || 'super-secret-jwt-token-with-at-least-32-characters-long';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (p) => { const h = b64({ alg: 'HS256', typ: 'JWT' }), q = b64(p); return `${h}.${q}.${crypto.createHmac('sha256', SECRET).update(`${h}.${q}`).digest('base64url')}`; };
const now = Math.floor(Date.now() / 1000);
const SVC = sign({ role: 'service_role', iss: 'supabase-demo', iat: now, exp: now + 3600 });
const sb = createClient(API, SVC, { auth: { persistSession: false, autoRefreshToken: false } });
const CON_EDGE = process.argv.includes('--con-edge');
const EDGE = { nombre: 'purga-fn-0096-e2e', puerto: 54398, red: 'supabase_network_rendio-backend',
  imagen: 'public.ecr.aws/supabase/edge-runtime:v1.70.0', kong: 'http://supabase_kong_rendio-backend:8000' };
const FUNCS = new URL('../supabase/functions', import.meta.url).pathname;
const docker = (...a) => execFileSync('docker', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

let ok = 0, fail = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (d != null ? ' → ' + d : '')); } };

const c = await localClient();
const one = async (s, p) => (await c.query(s, p)).rows[0];
const B = 'inspections';
const ids = { org: null, users: [], subidos: [], runs: [], secretos: [], contenedor: false };
const tmp = mkdtempSync(join(tmpdir(), 'respaldo-0096-'));

async function subir(path, kb, { dias = 0 } = {}) {
  const buf = crypto.randomBytes(kb * 1024);
  const { error } = await sb.storage.from(B).upload(path, buf, { contentType: 'image/jpeg', upsert: true });
  if (error) throw new Error('upload ' + path + ': ' + error.message);
  ids.subidos.push(path);
  if (dias) await c.query(`UPDATE storage.objects SET created_at = now() - make_interval(days => $3) WHERE bucket_id = $1 AND name = $2`, [B, path, dias]);
  return buf;
}
const existe = async (path) => !!(await one(`SELECT 1 AS x FROM storage.objects WHERE bucket_id = $1 AND name = $2`, [B, path]));
const enSerie = async (lista, fn) => { const out = []; for (const x of lista) out.push(await fn(x)); return out; };
const descarga = async (path) => { const { data, error } = await sb.storage.from(B).download(path); return error ? null : Buffer.from(await data.arrayBuffer()); };

try {
  const fx = await fixtures(c);                      // sin BEGIN: queda escrito y se borra al final
  ids.org = fx.org; ids.users.push(fx.auxUser, fx.vecinoUser, fx.drvUser);
  const jefe = await user(c, fx.org, 'admin', 'Jefe e2e 0096'); ids.users.push(jefe);

  let n = 0;
  async function inspeccion({ dias = 90, damage = false } = {}) {
    n++;
    const shift = (await one(`INSERT INTO public.shifts (organization_id, driver_id, vehicle_id, status, start_at, end_at)
      VALUES ($1, $2, $3, 'closed', now() - make_interval(days => $4) - interval '1 hour', now() - make_interval(days => $4) + interval '9 hours') RETURNING id`,
      [fx.org, fx.driver, fx.vehicle, dias])).id;
    const id = (await one(`INSERT INTO public.inspections (organization_id, shift_id, vehicle_id, driver_id, kind, odometer_km, checklist, has_damage, performed_at)
      VALUES ($1, $2, $3, $4, 'initial', 5000 + $5, $6, $7, now() - make_interval(days => $8)) RETURNING id`,
      [fx.org, shift, fx.vehicle, fx.driver, n, JSON.stringify({ severity: damage ? 'grave' : null, items: [{ id: 'a', result: damage ? 'issue' : 'ok' }] }), damage, dias])).id;
    if (damage) await c.query(`UPDATE public.inspections SET review_status = 'approved' WHERE id = $1`, [id]);
    return { id, shift, dir: `${fx.org}/${fx.vehicle}/2026-07-01/${id}` };
  }
  async function foto(insp, tipo, kb, dias) {
    const path = `${insp.dir}/${tipo}.jpg`;
    const buf = await subir(path, kb, { dias });
    const id = (await one(`INSERT INTO public.inspection_photos (inspection_id, organization_id, photo_type, storage_path, size_bytes)
      VALUES ($1, $2, $3, $4, $5) RETURNING id`, [insp.id, fx.org, tipo, path, buf.length])).id;
    return { id, path, buf };
  }

  // ── El escenario ──────────────────────────────────────────────────────────
  const vieja = await inspeccion();
  const v1 = await foto(vieja, 'front', 12, 90);
  const v2 = await foto(vieja, 'dashboard', 9, 90);
  const v3 = await foto(vieja, 'spare_tire', 7, 90);
  const golpe = await inspeccion({ damage: true });
  const g1 = await foto(golpe, 'front', 8, 90);
  const g2 = await foto(golpe, 'damage', 8, 90);
  const reciente = await inspeccion({ dias: 5 });
  const r1 = await foto(reciente, 'front', 6, 5);
  const recibo = `${fx.org}/${fx.vehicle}/2026-07-01/close-${vieja.shift}/receipt-1.jpg`;
  await subir(recibo, 10, { dias: 90 });
  await c.query(`INSERT INTO public.fuel_receipts (organization_id, shift_id, vehicle_id, driver_id, amount_cop, storage_path) VALUES ($1, $2, $3, $4, 90000, $5)`,
    [fx.org, vieja.shift, fx.vehicle, fx.driver, recibo]);
  const huerfVieja = `${fx.org}/${fx.vehicle}/2026-07-01/sin-fila/front.jpg`;
  const hvBuf = await subir(huerfVieja, 5, { dias: 6 });
  const huerfNueva = `${fx.org}/${fx.vehicle}/2026-07-01/sin-fila/rear.jpg`;
  await subir(huerfNueva, 5, { dias: 1 });
  const seVan = [v1.path, v2.path, v3.path, huerfVieja];
  const seQuedan = [g1.path, g2.path, r1.path, recibo, huerfNueva];
  const bytesEsperados = v1.buf.length + v2.buf.length + v3.buf.length + hvBuf.length;

  console.log('\n1. La lista que ve la llave de servicio por PostgREST');
  const { data: lista, error: eLista } = await sb.rpc('photo_purge_candidates', { p_limit: 1000, p_offset: 0 });
  t('photo_purge_candidates responde por la API', !eLista && Array.isArray(lista), eLista && eLista.message);
  const deLaPrueba = (lista || []).filter((x) => x.path.startsWith(fx.org + '/'));
  t('trae exactamente lo que se debe ir', deLaPrueba.map((x) => x.path).sort().join() === [...seVan].sort().join(), JSON.stringify(deLaPrueba.map((x) => x.path)));
  const ajenos = (lista || []).filter((x) => !x.path.startsWith(fx.org + '/'));

  console.log('\n2. El respaldo (_respaldo-fotos.mjs) contra el stack local');
  const out = execFileSync(process.execPath, [new URL('./_respaldo-fotos.mjs', import.meta.url).pathname, `--salida=${tmp}`], {
    env: { ...process.env, SUPABASE_URL: API, SUPABASE_SERVICE_ROLE_KEY: SVC }, encoding: 'utf8',
  });
  const linea = out.split('\n').find((l) => /La purga borraría/.test(l)) || '';
  t('dice cuántos archivos y cuántos MB', /La purga borraría \d+ archivos \(\d+\.\d MB\)/.test(linea), linea);
  const bajado = (p) => { const f = join(tmp, B, p); return existsSync(f) ? readFileSync(f) : null; };
  t('bajó cada archivo que se va, idéntico byte a byte', [v1, v2, v3].every((f) => { const b = bajado(f.path); return b && b.equals(f.buf); }) && (bajado(huerfVieja) || Buffer.alloc(0)).equals(hvBuf));
  t('NO bajó lo que se queda', seQuedan.every((p) => !bajado(p)));
  const man = JSON.parse(readFileSync(join(tmp, '_manifiesto.json'), 'utf8'));
  t('deja un manifiesto con motivo y photo_id', man.lista.some((x) => x.path === v1.path && x.motivo === 'rutina_vencida' && x.photo_id === v1.id)
    && man.lista.some((x) => x.path === huerfVieja && x.motivo === 'huerfana'));
  const out2 = execFileSync(process.execPath, [new URL('./_respaldo-fotos.mjs', import.meta.url).pathname, `--salida=${tmp}`], {
    env: { ...process.env, SUPABASE_URL: API, SUPABASE_SERVICE_ROLE_KEY: SVC }, encoding: 'utf8',
  });
  t('correrlo otra vez no vuelve a bajar nada (reanudable)', /0 bajados · \d+ ya estaban · 0 fallidos/.test(out2), out2.split('\n').slice(-3).join(' | '));
  let abort = '';
  try {
    execFileSync(process.execPath, [new URL('./_respaldo-fotos.mjs', import.meta.url).pathname, '--solo-contar'], {
      env: { ...process.env, SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'x' }, encoding: 'utf8', stdio: 'pipe' });
  } catch (e) { abort = String(e.stderr || ''); }
  t('contra un proyecto remoto sin --proyecto se niega (sin conectarse)', /ABORT/.test(abort) && /--proyecto=abcdefghijklmnop/.test(abort), abort);
  t('todo lo que se va sigue en Storage (el respaldo solo lee)', (await enSerie(seVan, existe)).every(Boolean));

  console.log('\n3. purga.ts en modo prueba, con supabase-js de verdad');
  const prueba = await purgarFotos(sb, { dryRun: true });
  t('cuenta sin borrar', prueba.archivos >= 4 && (await enSerie(seVan, existe)).every(Boolean), JSON.stringify(prueba));
  if (!ajenos.length) t('y los bytes cuadran con lo subido', prueba.bytes === bytesEsperados, `${prueba.bytes} vs ${bytesEsperados}`);

  if (ajenos.length) {
    console.log(`\n  ⚠ La base local tiene ${ajenos.length} candidatos que no son de esta prueba: NO se purga de verdad (borraría lo de otro).`);
    fail++;
  } else {
    let runId = null;
    if (!CON_EDGE) {
      console.log('\n4. La purga de verdad (purga.ts con supabase-js)');
      runId = crypto.randomUUID(); ids.runs.push(runId);
      const res = await purgarFotos(sb, { runId });
      t('borró 4 archivos (3 de rutina + 1 huérfana), sin errores', res.archivos === 4 && res.rutina === 3 && res.huerfanas === 1 && !res.errores.length, JSON.stringify(res));
      t('y reporta los bytes', res.bytes === bytesEsperados, `${res.bytes} vs ${bytesEsperados}`);
    } else {
      console.log('\n4. La purga de verdad por la cadena del cron: run_photo_purge → pg_net → index.ts (Deno) → Storage');
      const yaHay = Number((await one(`SELECT count(*) n FROM vault.secrets WHERE name IN ('purge_photos_url','service_role_key')`)).n);
      if (yaHay) throw new Error('El Vault local ya tiene purge_photos_url/service_role_key: no los piso. Bórralos o corre sin --con-edge.');
      docker('rm', '-f', EDGE.nombre);
      docker('run', '-d', '--name', EDGE.nombre, '--network', EDGE.red, '-p', `${EDGE.puerto}:9000`,
        '-v', `${FUNCS}:/fns:ro`, '-e', `SUPABASE_URL=${EDGE.kong}`, '-e', `SUPABASE_SERVICE_ROLE_KEY=${SVC}`,
        EDGE.imagen, 'start', '--main-service', '/fns/purge-old-photos', '--port', '9000');
      ids.contenedor = true;
      const fn = `http://127.0.0.1:${EDGE.puerto}/`;
      let vivo = null;
      for (let k = 0; k < 40 && !vivo; k++) {
        await espera(500);
        try { const r = await fetch(fn, { method: 'POST', body: '{}' }); vivo = r.status; } catch { /* arrancando */ }
      }
      t('la función arranca en Deno y sin la llave responde 401', vivo === 401, vivo);
      const r0 = await fetch(fn, { method: 'POST', headers: { Authorization: 'Bearer ' + SVC, 'Content-Type': 'application/json' }, body: JSON.stringify({ dry_run: true }) });
      const j0 = await r0.json();
      t('con la llave y dry_run: 200 y cuenta lo mismo que purga.ts directo, sin borrar', r0.status === 200 && j0.dry_run === true && j0.archivos === prueba.archivos && j0.bytes === prueba.bytes
        && (await enSerie(seVan, existe)).every(Boolean), JSON.stringify(j0));
      const r1 = await fetch(fn + '?dry_run=1', { method: 'POST', headers: { Authorization: 'Bearer ' + SVC } });
      t('?dry_run=1 en la URL también es prueba', r1.status === 200 && (await r1.json()).dry_run === true);
      // Los dos secretos, como los carga _set-vault-secrets.mjs (la base le habla
      // al contenedor por la red de docker del stack).
      for (const [nombre, valor] of [['purge_photos_url', `http://${EDGE.nombre}:9000/`], ['service_role_key', SVC]]) {
        const sid = (await one(`SELECT vault.create_secret($1, $2, 'e2e 0096 (temporal)') AS id`, [valor, nombre])).id;
        ids.secretos.push(sid);
      }
      const disp = (await one(`SELECT public.run_photo_purge() AS t`)).t;
      t('run_photo_purge() dispara', /^disparado \(pg_net #\d+\)$/.test(disp), disp);
      const reqId = Number((disp.match(/#(\d+)/) || [])[1]);
      let resp = null;
      for (let k = 0; k < 60 && !resp; k++) {
        await espera(500);
        resp = await one(`SELECT status_code, content::text AS body, error_msg FROM net._http_response WHERE id = $1`, [reqId]);
      }
      let body = {};
      try { body = JSON.parse(resp && resp.body || '{}'); } catch { /* */ }
      t('pg_net recibió 200 de la función', resp && resp.status_code === 200, resp && (resp.error_msg || resp.status_code + ' ' + resp.body));
      t('la función borró 4 archivos (3 de rutina + 1 huérfana) y reporta los bytes', body.archivos === 4 && body.rutina === 3 && body.huerfanas === 1 && body.bytes === bytesEsperados && !(body.errores || []).length, JSON.stringify(body));
      const aud = await one(`SELECT entity_id FROM public.audit_events WHERE entity_type = 'photo_purge_run' AND (payload->>'archivos')::int = 4 ORDER BY created_at DESC LIMIT 1`);
      if (aud) { runId = aud.entity_id; ids.runs.push(runId); }
    }
    t('los archivos ya no están en Storage (ni la fila, ni la descarga)', !(await enSerie(seVan, existe)).some(Boolean) && (await descarga(v1.path)) === null);
    const sellos = (await c.query(`SELECT id, purged_at IS NOT NULL AS p FROM public.inspection_photos WHERE id = ANY($1::uuid[])`, [[v1.id, v2.id, v3.id, g1.id, g2.id, r1.id]])).rows;
    const s = Object.fromEntries(sellos.map((x) => [x.id, x.p]));
    t('las 3 fotos de rutina quedaron con purged_at (y las filas siguen)', s[v1.id] && s[v2.id] && s[v3.id] && sellos.length === 6);
    t('golpe, reciente y su inspección intactos', !s[g1.id] && !s[g2.id] && !s[r1.id]);
    t('lo que se queda sigue en Storage y se puede bajar', (await enSerie(seQuedan, existe)).every(Boolean) && !!(await descarga(g2.path)));
    const aud = runId && await one(`SELECT event_type, entity_type, payload FROM public.audit_events WHERE entity_id = $1`, [runId]);
    t('dejó una línea en la bitácora con el resumen', aud && aud.event_type === 'photos_purged' && aud.payload.archivos === 4, JSON.stringify(aud));
    const run2 = crypto.randomUUID(); ids.runs.push(run2);
    const otra = await purgarFotos(sb, { runId: run2 });
    t('una segunda corrida no encuentra nada', otra.archivos === 0 && otra.sin_archivo === 0 && !otra.errores.length, JSON.stringify(otra));
  }
} finally {
  // Limpieza: archivos por la API de Storage (como la purga), filas por SQL.
  try {
    const quedan = (await c.query(`SELECT name FROM storage.objects WHERE bucket_id = $1 AND name LIKE $2`, [B, (ids.org || 'x') + '/%'])).rows.map((r) => r.name);
    if (quedan.length) await sb.storage.from(B).remove(quedan);
    if (ids.org) {
      if (ids.runs.length) await c.query(`DELETE FROM public.audit_events WHERE entity_type = 'photo_purge_run' AND entity_id = ANY($1::uuid[])`, [ids.runs]);
      await c.query(`DELETE FROM public.inspection_photos WHERE organization_id = $1`, [ids.org]);
      await c.query(`DELETE FROM public.fuel_receipts WHERE organization_id = $1`, [ids.org]);
      await c.query(`DELETE FROM public.incidents WHERE organization_id = $1`, [ids.org]);
      await c.query(`DELETE FROM public.inspections WHERE organization_id = $1`, [ids.org]);
      await c.query(`DELETE FROM public.shifts WHERE organization_id = $1`, [ids.org]);
      await c.query(`DELETE FROM public.auxiliar_profiles WHERE profile_id = ANY($1::uuid[])`, [ids.users]);
      await c.query(`DELETE FROM public.driver_profiles WHERE profile_id = ANY($1::uuid[])`, [ids.users]);
      await c.query(`DELETE FROM public.profiles WHERE id = ANY($1::uuid[])`, [ids.users]);
      await c.query(`DELETE FROM auth.users WHERE id = ANY($1::uuid[])`, [ids.users]);
      await c.query(`DELETE FROM public.vehicles WHERE organization_id = $1`, [ids.org]);
      await c.query(`DELETE FROM public.residences WHERE organization_id = $1`, [ids.org]);
      await c.query(`DELETE FROM public.airports WHERE organization_id = $1`, [ids.org]);
      await c.query(`DELETE FROM public.organizations WHERE id = $1`, [ids.org]);
    }
    const resto = Number((await one(`SELECT count(*) n FROM storage.objects WHERE bucket_id = $1 AND name LIKE $2`, [B, (ids.org || 'x') + '/%'])).n);
    console.log(`\nLimpieza: ${resto === 0 ? 'sin rastro en Storage' : resto + ' archivos quedaron en Storage'}; filas borradas.`);
  } catch (e) {
    console.log('\n⚠ La limpieza falló: ' + e.message + ' (organización ' + ids.org + ')');
  }
  if (ids.secretos.length) {
    try { await c.query(`DELETE FROM vault.secrets WHERE id = ANY($1::uuid[])`, [ids.secretos]); console.log('Secretos temporales del Vault local: borrados.'); }
    catch (e) { console.log('⚠ No pude borrar los secretos temporales del Vault local: ' + e.message); }
  }
  if (ids.contenedor) { try { docker('rm', '-f', EDGE.nombre); console.log('Contenedor de la función: borrado.'); } catch { /* */ } }
  rmSync(tmp, { recursive: true, force: true });
  await c.end();
}
console.log(`\n${ok} ✓ · ${fail} ✗`);
console.log(CON_EDGE
  ? 'NO cubre: pg_cron disparando solo a las 3:15 (se llamó run_photo_purge a mano), la puerta JWT de la plataforma\n'
    + '(verify_jwt) ni el Storage de producción (S3): local es disco.'
  : 'NO cubre: index.ts en Deno ni la cadena pg_net → función (córrelo con --con-edge), pg_cron disparando a las 3:15,\n'
    + 'ni el Storage de producción (S3): local es disco.');
process.exit(fail ? 1 : 0);
