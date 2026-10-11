// Respaldo de lo que la purga de fotos (0096) BORRARÍA, antes de que la borre.
//
// Se corre UNA VEZ por ambiente, ANTES de la primera purga de verdad: después de
// aplicar 0096 y ANTES de cargar 'purge_photos_url' en Vault (sin ese secreto el
// cron nocturno no dispara nada, así que la lista no cambia mientras se baja).
//
// Pide la misma lista que usa la Edge Function (photo_purge_candidates) y baja
// cada archivo a una carpeta local, con la misma ruta que tiene en el bucket.
// Es reanudable: si se corta, se vuelve a correr y salta lo que ya bajó con el
// mismo tamaño. Deja un _manifiesto.json con qué es cada archivo y por qué se
// iba a borrar. Solo LEE: no borra nada ni en Storage ni en la base.
//
//   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=… \
//     node scripts/_respaldo-fotos.mjs --proyecto=<ref> [--salida=DIR] [--solo-contar]
//
// --proyecto es obligatorio contra un proyecto remoto (tiene que coincidir con
// el de la URL): es para que nadie baje las fotos de producción por accidente.
// Contra el stack local (127.0.0.1) no hace falta.
import { createClient } from '@supabase/supabase-js';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const URL_ = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!URL_ || !KEY) {
  console.error('Faltan SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY (la llave de servicio del proyecto).');
  process.exit(1);
}
let host;
try { host = new URL(URL_).hostname; } catch { console.error('SUPABASE_URL no es una URL válida.'); process.exit(1); }
const local = /^(127\.0\.0\.1|localhost)$/.test(host);
const ref = local ? 'local' : host.split('.')[0];
if (!local && args.proyecto !== ref) {
  console.error(`ABORT: la URL apunta al proyecto «${ref}». Para confirmar que es ese, agrega --proyecto=${ref}`);
  process.exit(2);
}

const hoy = new Date().toISOString().slice(0, 10);
const salida = resolve(typeof args.salida === 'string' ? args.salida : `respaldo-fotos-${ref}-${hoy}`);
const soloContar = !!args['solo-contar'];
const sb = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const fmtMB = (b) => (b / 1048576).toFixed(1) + ' MB';

// 1. La lista completa. Nada cambia mientras se recorre (el respaldo no borra).
console.log(`Proyecto: ${ref} (${host})`);
const lista = [];
for (let off = 0; ; off += 1000) {
  const { data, error } = await sb.rpc('photo_purge_candidates', { p_limit: 1000, p_offset: off });
  if (error) {
    console.error('No pude pedir la lista: ' + error.message);
    if (/photo_purge_candidates/.test(error.message)) console.error('¿Está aplicada la migración 0096 en este proyecto?');
    process.exit(1);
  }
  lista.push(...(data || []));
  if (!data || data.length < 1000) break;
}
const conArchivo = lista.filter((c) => c.in_storage);
const total = conArchivo.reduce((a, c) => a + (Number(c.bytes) || 0), 0);
const porMotivo = {};
for (const c of conArchivo) porMotivo[c.motivo] = (porMotivo[c.motivo] || 0) + 1;
console.log(`La purga borraría ${conArchivo.length} archivos (${fmtMB(total)}): `
  + Object.entries(porMotivo).map(([k, v]) => `${v} ${k}`).join(', ')
  + (lista.length - conArchivo.length ? ` · ${lista.length - conArchivo.length} filas que ya no tienen archivo (no hay nada que bajar)` : ''));
if (soloContar) process.exit(0);

// 2. Bajar, de a 4 a la vez, con 3 intentos por archivo.
mkdirSync(salida, { recursive: true });
let bajados = 0, saltados = 0, bytes = 0;
const fallidos = [];
async function bajar(c) {
  const destino = join(salida, c.bucket, c.path);
  try {
    if (statSync(destino).size === Number(c.bytes)) { saltados++; bytes += Number(c.bytes) || 0; return; }
  } catch { /* no está: se baja */ }
  for (let intento = 1; intento <= 3; intento++) {
    const { data, error } = await sb.storage.from(c.bucket).download(c.path);
    if (!error && data) {
      const buf = Buffer.from(await data.arrayBuffer());
      mkdirSync(dirname(destino), { recursive: true });
      writeFileSync(destino, buf);
      bajados++; bytes += buf.length;
      return;
    }
    if (intento === 3) fallidos.push({ path: c.path, error: (error && error.message) || 'sin datos' });
    else await new Promise((r) => setTimeout(r, 500 * intento));
  }
}
let i = 0;
const trabajadores = Array.from({ length: 4 }, async () => {
  while (i < conArchivo.length) {
    const c = conArchivo[i++];
    await bajar(c);
    const hechos = bajados + saltados + fallidos.length;
    if (hechos % 100 === 0) console.log(`  … ${hechos}/${conArchivo.length}`);
  }
});
await Promise.all(trabajadores);

writeFileSync(join(salida, '_manifiesto.json'), JSON.stringify({
  proyecto: ref, host, fecha: new Date().toISOString(),
  archivos: conArchivo.length, bytes: total, por_motivo: porMotivo,
  fallidos,
  lista: lista.map((c) => ({ bucket: c.bucket, path: c.path, motivo: c.motivo, photo_id: c.photo_id, bytes: c.bytes == null ? null : Number(c.bytes), in_storage: c.in_storage })),
}, null, 2));

console.log(`\nRespaldo en ${salida}`);
console.log(`  ${bajados} bajados · ${saltados} ya estaban · ${fallidos.length} fallidos · ${fmtMB(bytes)} en disco`);
if (fallidos.length) {
  console.log('  Fallaron (vuelve a correrlo para reintentar solo estos):');
  fallidos.slice(0, 20).forEach((f) => console.log(`    ${f.path}: ${f.error}`));
  process.exit(1);
}
