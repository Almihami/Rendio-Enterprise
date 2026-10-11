// La lógica de purge-old-photos (supabase/functions/purge-old-photos/purga.ts)
// con un cliente FALSO: una base y un Storage de mentira en memoria que se
// comportan como los de verdad (los candidatos los calcula «la base» en cada
// llamada; lo borrado desaparece; mark_photos_purged solo marca si el archivo ya
// no está). Sin red, sin Supabase, sin deno.
//
//   cd rendio-backend/scripts && node _smoke-purga-fotos.mjs
//
// Node 22.6+ corre el .ts directamente (borra las anotaciones de tipo).
import { purgarFotos } from '../supabase/functions/purge-old-photos/purga.ts';

let ok = 0, fail = 0;
const t = (n, c, d) => { if (c) { ok++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (d != null ? ' → ' + d : '')); } };

// ── El mundo de mentira ────────────────────────────────────────────────────
function mundo({ rutina = [], huerfanas = [], noBorra = [], removeFalla = null, marcarFalla = false, candidatosFalla = false, repite = false } = {}) {
  const storage = new Map();            // 'bucket/path' -> bytes
  const fotos = new Map();              // id -> { path, purged }
  for (const r of rutina) {
    fotos.set(r.id, { path: r.path, purged: false });
    if (r.archivo !== false) storage.set('inspections/' + r.path, r.bytes ?? 100000);
  }
  for (const h of huerfanas) storage.set('inspections/' + h.path, h.bytes ?? 50000);
  const llamadas = { candidatos: [], remove: [], marcar: [], audit: [] };

  function candidatosAhora() {
    const out = [];
    for (const r of rutina) {
      const f = fotos.get(r.id);
      if (f.purged) continue;
      const hay = storage.has('inspections/' + r.path);
      out.push({ bucket: 'inspections', path: r.path, motivo: 'rutina_vencida', photo_id: r.id,
                 bytes: hay ? String(storage.get('inspections/' + r.path)) : null, in_storage: hay });
    }
    for (const h of huerfanas) {
      if (!storage.has('inspections/' + h.path)) continue;
      out.push({ bucket: 'inspections', path: h.path, motivo: 'huerfana', photo_id: null, bytes: storage.get('inspections/' + h.path), in_storage: true });
    }
    return out;
  }

  const db = {
    async rpc(fn, args) {
      if (fn === 'photo_purge_candidates') {
        llamadas.candidatos.push(args);
        if (candidatosFalla) return { data: null, error: { message: 'permission denied for function photo_purge_candidates' } };
        const todo = candidatosAhora();
        const off = repite ? 0 : (args.p_offset || 0);
        return { data: todo.slice(off, off + args.p_limit), error: null };
      }
      if (fn === 'mark_photos_purged') {
        llamadas.marcar.push([...args.p_ids]);
        if (marcarFalla) return { data: null, error: { message: 'timeout' } };
        let n = 0;
        for (const id of new Set(args.p_ids)) {
          const f = fotos.get(id);
          if (f && !f.purged && !storage.has('inspections/' + f.path)) { f.purged = true; n++; }
        }
        return { data: n, error: null };
      }
      return { data: null, error: { message: 'rpc desconocida ' + fn } };
    },
    storage: {
      from(bucket) {
        return {
          async remove(paths) {
            llamadas.remove.push({ bucket, paths: [...paths] });
            if (removeFalla && removeFalla(paths)) return { data: null, error: { message: 'Storage caído' } };
            const borrados = [];
            for (const p of paths) {
              if (noBorra.includes(p)) continue;
              if (storage.delete(bucket + '/' + p)) borrados.push({ name: p, bucket_id: bucket });
            }
            return { data: borrados, error: null };
          },
        };
      },
    },
    from(tabla) {
      return { async insert(fila) { llamadas.audit.push({ tabla, fila }); return { error: null }; } };
    },
  };
  return { db, storage, fotos, llamadas };
}

const R = (i, extra = {}) => ({ id: 'foto-' + i, path: `org/veh/2026-07-01/insp-${Math.ceil(i / 3)}/f${i}.jpg`, bytes: 100000 + i, ...extra });
const H = (i) => ({ path: `org/veh/2026-07-01/perdida/h${i}.jpg`, bytes: 50000 });

// ── 1. Modo prueba ─────────────────────────────────────────────────────────
console.log('\n1. dry_run: cuenta y no toca nada');
{
  const m = mundo({ rutina: [R(1), R(2), R(3, { archivo: false }), R(4)], huerfanas: [H(1)] });
  const res = await purgarFotos(m.db, { dryRun: true, lote: 2 });
  t('cuenta los archivos que se irían (3 de rutina con archivo + 1 huérfana)', res.archivos === 4, res.archivos);
  t('suma los bytes', res.bytes === 100001 + 100002 + 100004 + 50000, res.bytes);
  t('separa rutina y huérfanas', res.rutina === 3 && res.huerfanas === 1, `${res.rutina}/${res.huerfanas}`);
  t('la fila sin archivo va aparte (solo habría que marcarla)', res.sin_archivo === 1, res.sin_archivo);
  t('recorre en lotes con desplazamiento (lote 2 → 3 consultas)', m.llamadas.candidatos.map(x => x.p_offset).join(',') === '0,2,4', JSON.stringify(m.llamadas.candidatos));
  t('NO llama a remove()', m.llamadas.remove.length === 0);
  t('NO marca nada', m.llamadas.marcar.length === 0);
  t('NO escribe bitácora', m.llamadas.audit.length === 0);
  t('Storage queda igual (los 4 archivos siguen)', m.storage.size === 4 && [...m.fotos.values()].every(f => !f.purged), m.storage.size);
  t('dice que es prueba y da los MB', res.dry_run === true && res.mb === Math.round(res.bytes / 1048576 * 10) / 10);
}

// ── 2. La purga de verdad ──────────────────────────────────────────────────
console.log('\n2. La purga de verdad');
{
  const fotosR = [1, 2, 3, 4, 5, 6, 7].map(i => R(i, i === 6 ? { archivo: false } : {}));
  const m = mundo({ rutina: fotosR, huerfanas: [H(1), H(2)] });
  const res = await purgarFotos(m.db, { lote: 3, porBorrado: 2, runId: 'run-123' });
  t('borra todo lo que la base dio (6 de rutina + 2 huérfanas)', res.archivos === 8 && m.storage.size === 0, `${res.archivos} · quedan ${m.storage.size}`);
  t('marca las 7 fotos (también la que ya no tenía archivo)', [...m.fotos.values()].every(f => f.purged) && res.fotos_marcadas === 7, res.fotos_marcadas);
  t('bytes = lo que de verdad se borró', res.bytes === [1, 2, 3, 4, 5, 7].reduce((a, i) => a + 100000 + i, 0) + 100000, res.bytes);
  t('borra con la API de Storage, en trozos de máximo 2', m.llamadas.remove.length > 0 && m.llamadas.remove.every(x => x.paths.length <= 2 && x.bucket === 'inspections'), JSON.stringify(m.llamadas.remove.map(x => x.paths.length)));
  t('a mark_photos_purged solo van ids de fotos (nunca de huérfanas)', m.llamadas.marcar.flat().every(id => /^foto-/.test(id)));
  t('sin fallas, la siguiente consulta arranca otra vez en 0 (lo borrado desaparece)', m.llamadas.candidatos.every(x => x.p_offset === 0), JSON.stringify(m.llamadas.candidatos));
  t('escribe UNA fila de bitácora con el resumen', m.llamadas.audit.length === 1 && m.llamadas.audit[0].tabla === 'audit_events'
    && m.llamadas.audit[0].fila.event_type === 'photos_purged' && m.llamadas.audit[0].fila.entity_id === 'run-123'
    && m.llamadas.audit[0].fila.payload.archivos === 8, JSON.stringify(m.llamadas.audit));
  t('sin errores', res.errores.length === 0 && res.fallidos === 0, JSON.stringify(res.errores));
}

// ── 3. Lo que no se pudo borrar ────────────────────────────────────────────
console.log('\n3. Un archivo que Storage no borra');
{
  const fotosR = [1, 2, 3, 4, 5].map(i => R(i));
  const m = mundo({ rutina: fotosR, noBorra: [fotosR[0].path] });
  const res = await purgarFotos(m.db, { lote: 2, runId: 'r' });
  t('los demás sí se borran', res.archivos === 4 && m.storage.size === 1, `${res.archivos} · quedan ${m.storage.size}`);
  t('el que no se borró NO se marca', m.fotos.get('foto-1').purged === false);
  t('se cuenta como fallido', res.fallidos === 1, res.fallidos);
  t('y la consulta siguiente se lo salta (desplazamiento 1), sin quedarse en un bucle', m.llamadas.candidatos.some(x => x.p_offset === 1) && m.llamadas.candidatos.length <= 5, JSON.stringify(m.llamadas.candidatos));
}

console.log('\n4. Storage caído en un lote');
{
  const fotosR = [1, 2, 3, 4].map(i => R(i));
  const m = mundo({ rutina: fotosR, removeFalla: (paths) => paths.includes(fotosR[0].path) });
  const res = await purgarFotos(m.db, { lote: 10, porBorrado: 2, runId: 'r' });
  t('el error queda escrito', res.errores.some(e => /Storage caído/.test(e)), JSON.stringify(res.errores));
  t('lo del trozo que falló no se marca; lo del otro sí', !m.fotos.get('foto-1').purged && !m.fotos.get('foto-2').purged && m.fotos.get('foto-3').purged && m.fotos.get('foto-4').purged);
  t('la bitácora registra la corrida con el error', m.llamadas.audit.length === 1 && m.llamadas.audit[0].fila.payload.errores.length === 1);
}

console.log('\n5. La base no deja pedir candidatos');
{
  const m = mundo({ rutina: [R(1)], candidatosFalla: true });
  const res = await purgarFotos(m.db, { runId: 'r' });
  t('para, sin borrar nada, y lo dice', res.archivos === 0 && m.llamadas.remove.length === 0 && /candidatos: permission denied/.test(res.errores[0] || ''), JSON.stringify(res.errores));
}

console.log('\n6. No se pudo marcar');
{
  const m = mundo({ rutina: [R(1), R(2)], marcarFalla: true });
  const res = await purgarFotos(m.db, { lote: 10, runId: 'r' });
  t('el archivo se borró igual (cuenta como borrado)', res.archivos === 2 && m.storage.size === 0);
  t('el error queda escrito y las filas siguen sin sello (salen mañana como in_storage=false)', /marcar purgadas: timeout/.test(res.errores.join()) && res.fotos_marcadas === 0);
}

console.log('\n7. Tope de lotes por corrida');
{
  const m = mundo({ rutina: Array.from({ length: 10 }, (_, i) => R(i + 1)) });
  const res = await purgarFotos(m.db, { lote: 2, maxLotes: 3, runId: 'r' });
  t('borra solo 3 lotes (6 archivos)', res.archivos === 6 && res.lotes === 3, `${res.archivos} · ${res.lotes}`);
  t('y avisa que quedan más para la noche siguiente', res.quedan_mas === true);
}

console.log('\n8. Una base que devuelve siempre lo mismo (defensa contra bucles)');
{
  const m = mundo({ rutina: [R(1), R(2), R(3)], repite: true });
  const res = await purgarFotos(m.db, { dryRun: true, lote: 2, maxLotes: 50 });
  t('en prueba no se queda dando vueltas', m.llamadas.candidatos.length === 2 && res.archivos === 2, `${m.llamadas.candidatos.length} consultas`);
}

console.log('\n9. Nada que purgar');
{
  const m = mundo({});
  const res = await purgarFotos(m.db, { runId: 'r' });
  t('cero archivos, cero bytes, sin bitácora', res.archivos === 0 && res.bytes === 0 && m.llamadas.audit.length === 0 && res.lotes === 0);
}

console.log('\n10. Parámetros fuera de rango');
{
  const m = mundo({ rutina: [R(1)] });
  await purgarFotos(m.db, { dryRun: true, lote: 50000 });
  t('el lote se limita a 1000', m.llamadas.candidatos[0].p_limit === 1000, m.llamadas.candidatos[0].p_limit);
}

console.log(`\n${ok} ✓ · ${fail} ✗`);
console.log('NO cubre: index.ts (Deno.serve, la llave de servicio, el cuerpo JSON) ni la API de Storage real —');
console.log('eso lo prueba _e2e-0096-purga-local.mjs contra el stack local—, ni pg_cron/pg_net.');
process.exit(fail ? 1 : 0);
