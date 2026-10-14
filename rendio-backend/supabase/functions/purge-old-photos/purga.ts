// purga.ts — la lógica de purge-old-photos, sin nada de Deno.
//
// Vive aparte de index.ts para poder probarla con node (scripts/_smoke-purga-fotos.mjs
// con un cliente falso, y _e2e-0096-purga-local.mjs contra el Storage local): en
// este repo no hay deno instalado. Solo usa sintaxis de TypeScript que se puede
// borrar (anotaciones de tipo), así node la corre tal cual.
//
// QUÉ HACE, en lotes:
//   1. Pide candidatos a la base (photo_purge_candidates, 0096). La base decide
//      QUÉ se puede borrar; aquí no hay ni una regla de negocio.
//   2. Los borra con la API de Storage (storage.from(bucket).remove(paths)).
//      NUNCA con DELETE en storage.objects: eso borra la fila y deja el archivo
//      en el disco de Storage, o sea que el espacio no se libera.
//   3. Marca purged_at en las fotos de inspección que se borraron
//      (mark_photos_purged, que además solo marca si el archivo ya no está).
//   4. Devuelve cuántos archivos y cuántos bytes. Con dryRun solo cuenta.

export type Candidato = {
  bucket: string;
  path: string;
  motivo: string;            // 'rutina_vencida' | 'huerfana'
  photo_id: string | null;   // fila de inspection_photos (null en las huérfanas)
  bytes: number | string | null;
  in_storage: boolean;       // false = la fila apunta a un archivo que ya no existe
};

type Resp = { data: any; error: any };
export type Cliente = {
  rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<Resp>;
  storage: { from: (bucket: string) => { remove: (paths: string[]) => PromiseLike<Resp> } };
  from: (tabla: string) => { insert: (fila: Record<string, unknown>) => PromiseLike<Resp> };
};

export type Opciones = {
  dryRun?: boolean;
  lote?: number;        // candidatos por llamada a la base
  maxLotes?: number;    // tope por corrida (lo que falte sale la noche siguiente)
  porBorrado?: number;  // paths por llamada a remove()
  runId?: string;       // para la bitácora
  log?: (nivel: string, msg: string, ctx?: Record<string, unknown>) => void;
};

export type Resultado = {
  dry_run: boolean;
  archivos: number;      // borrados (o que se borrarían)
  bytes: number;
  mb: number;
  rutina: number;
  huerfanas: number;
  fotos_marcadas: number;
  sin_archivo: number;   // filas que solo había que marcar: su archivo ya no estaba
  fallidos: number;
  lotes: number;
  quedan_mas: boolean;   // se llegó al tope de lotes con candidatos todavía
  errores: string[];
};

const clave = (c: Candidato) => c.bucket + '/' + c.path;
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const msg = (e: any) => String((e && (e.message || e.error || e.msg)) || e || 'error');

export async function purgarFotos(db: Cliente, opciones: Opciones = {}): Promise<Resultado> {
  const dryRun = opciones.dryRun === true;
  const lote = Math.max(1, Math.min(1000, Math.floor(opciones.lote || 200)));
  const maxLotes = Math.max(1, Math.floor(opciones.maxLotes || 25));
  const porBorrado = Math.max(1, Math.min(1000, Math.floor(opciones.porBorrado || 100)));
  const log = opciones.log || (() => {});

  const res: Resultado = {
    dry_run: dryRun, archivos: 0, bytes: 0, mb: 0, rutina: 0, huerfanas: 0,
    fotos_marcadas: 0, sin_archivo: 0, fallidos: 0, lotes: 0, quedan_mas: false, errores: [],
  };
  const vistos = new Set<string>();
  // Desplazamiento de la siguiente consulta. En prueba nada cambia entre
  // llamadas, así que se avanza por lotes. En la purga de verdad lo borrado
  // desaparece de la lista y lo que falló queda ADELANTE (la lista sigue el
  // mismo orden), así que basta con saltarse lo que va fallando.
  let offset = 0;

  for (let i = 0; i < maxLotes; i++) {
    const { data, error } = await db.rpc('photo_purge_candidates', { p_limit: lote, p_offset: offset });
    if (error) { res.errores.push('candidatos: ' + msg(error)); break; }
    const filas: Candidato[] = Array.isArray(data) ? data : [];
    const nuevos = filas.filter((c) => c && c.path && !vistos.has(clave(c)));
    if (!nuevos.length) break;           // nada nuevo: o se acabó o la base repite lo mismo
    nuevos.forEach((c) => vistos.add(clave(c)));
    res.lotes++;

    if (dryRun) {
      for (const c of nuevos) {
        if (!c.in_storage) { res.sin_archivo++; continue; }
        res.archivos++; res.bytes += num(c.bytes);
        if (c.motivo === 'huerfana') res.huerfanas++; else res.rutina++;
      }
      offset += filas.length;
    } else {
      // 2. Borrar con la API de Storage, por bucket y en trozos.
      const borrados = new Set<string>();
      const porBucket = new Map<string, Candidato[]>();
      for (const c of nuevos) {
        if (!c.in_storage) continue;
        if (!porBucket.has(c.bucket)) porBucket.set(c.bucket, []);
        porBucket.get(c.bucket)!.push(c);
      }
      for (const [bucket, items] of porBucket) {
        for (let j = 0; j < items.length; j += porBorrado) {
          const paths = items.slice(j, j + porBorrado).map((c) => c.path);
          const { data: del, error: e } = await db.storage.from(bucket).remove(paths);
          if (e) { res.errores.push(`remove ${bucket} (${paths.length}): ${msg(e)}`); continue; }
          // remove() devuelve los objetos que SÍ borró. Lo que no venga ahí no se
          // da por borrado (la noche siguiente, si ya no está, se marca).
          const nombres = new Set((Array.isArray(del) ? del : []).map((o: any) => o && o.name));
          for (const p of paths) if (nombres.has(p)) borrados.add(bucket + '/' + p);
        }
      }

      // 3. Lo que hay que marcar en inspection_photos.
      const marcar: string[] = [];
      let fallidosLote = 0;
      for (const c of nuevos) {
        if (!c.in_storage) {
          if (c.photo_id) marcar.push(c.photo_id);
          res.sin_archivo++;
        } else if (borrados.has(clave(c))) {
          res.archivos++; res.bytes += num(c.bytes);
          if (c.motivo === 'huerfana') res.huerfanas++; else res.rutina++;
          if (c.photo_id) marcar.push(c.photo_id);
        } else {
          fallidosLote++;
        }
      }
      if (marcar.length) {
        const { data: n, error: e } = await db.rpc('mark_photos_purged', { p_ids: marcar });
        if (e) {
          // El archivo ya se fue y la fila quedó sin sello: sigue saliendo como
          // candidata (in_storage=false) y se marca en la próxima corrida.
          res.errores.push('marcar purgadas: ' + msg(e));
          fallidosLote += marcar.length;
        } else {
          res.fotos_marcadas += num(n);
        }
      }
      res.fallidos += fallidosLote;
      offset += fallidosLote;
    }

    if (filas.length < lote) break;      // era el último lote
    if (i === maxLotes - 1) res.quedan_mas = true;
  }

  res.mb = Math.round((res.bytes / (1024 * 1024)) * 10) / 10;
  log('info', dryRun ? 'purga de fotos (prueba)' : 'purga de fotos', { ...res, errores: res.errores.length });

  // 4. Bitácora: solo cuando se borró algo de verdad o algo falló.
  if (!dryRun && (res.archivos || res.sin_archivo || res.errores.length) && opciones.runId) {
    try {
      const { error } = await db.from('audit_events').insert({
        actor_profile_id: null,
        event_type: 'photos_purged',
        entity_type: 'photo_purge_run',
        entity_id: opciones.runId,
        payload: { ...res, errores: res.errores.slice(0, 20) },
      });
      if (error) log('warn', 'no se pudo escribir la bitácora', { error: msg(error) });
    } catch (e) {
      log('warn', 'no se pudo escribir la bitácora', { error: msg(e) });
    }
  }
  return res;
}
