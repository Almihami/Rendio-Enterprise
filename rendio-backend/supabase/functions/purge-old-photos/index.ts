// purge-old-photos — borra las fotos de inspección que ya no hay que guardar (0096).
//
// La llama el cron nocturno (public.run_photo_purge, 3:15 a. m. Bogotá) con
// pg_net y la llave de servicio que vive en Vault. Por qué usa la llave de
// servicio: tiene que borrar archivos de Storage de cualquier conductor y
// escribir purged_at, y nada de eso lo puede hacer un usuario. Por eso SOLO
// entra quien trae esa llave (mismo control que dispatch-notifications).
//
// Qué se borra lo decide la BASE (photo_purge_candidates): aquí no hay reglas.
// Cómo se borra: con la API de Storage, nunca con DELETE en storage.objects
// (eso deja el archivo en el disco y el espacio no se libera).
//
// Cuerpo opcional (JSON):
//   { "dry_run": true }   solo cuenta: cuántos archivos y cuántos MB se irían.
//   { "lote": 200 }       candidatos por consulta (1–1000).
// También ?dry_run=1 en la URL.
//
// Secretos: SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY (los inyecta Supabase).
// En Vault (para el cron): purge_photos_url y service_role_key.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { purgarFotos } from "./purga.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const log = (level: string, msg: string, ctx?: Record<string, unknown>) =>
  console.log(JSON.stringify({ level, msg, ctx: ctx || {} }));

Deno.serve(async (req: Request) => {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return json({ error: "Faltan SUPABASE_URL / SERVICE_ROLE_KEY" }, 500);

  const auth = req.headers.get("Authorization") || "";
  if (auth !== `Bearer ${serviceKey}`) return json({ error: "No autorizado" }, 401);

  let body: Record<string, unknown> = {};
  if (req.method === "POST") {
    try { body = (await req.json()) || {}; } catch (_) { body = {}; }
  }
  const q = new URL(req.url).searchParams;
  const dryRun = body.dry_run === true || q.get("dry_run") === "1" || q.get("dry_run") === "true";
  const lote = Number(body.lote) || 200;

  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const res = await purgarFotos(db, { dryRun, lote, runId: crypto.randomUUID(), log });
    return json(res, res.errores.length && !res.archivos && !res.sin_archivo ? 500 : 200);
  } catch (e) {
    log("error", "purga de fotos falló", { error: String((e as Error)?.message || e) });
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
