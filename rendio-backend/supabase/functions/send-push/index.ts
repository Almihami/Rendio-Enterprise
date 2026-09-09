// =============================================================================
// Edge Function: send-push
//
// Envía notificaciones Web Push a un conjunto de conductores/usuarios.
//
// Body:
//   { profileIds: string[], title: string, body: string, url?: string }
//
// Auth:
//   Authorization: Bearer <JWT de cualquier usuario autenticado>.
//   Solo se valida que el caller esté autenticado; el ENVÍO usa SERVICE_ROLE
//   para leer las suscripciones (bypass RLS).
//
// Requiere los secrets (supabase secrets set ...):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:tu@correo)
//
// Respuesta: 200 { sent, failed }
// =============================================================================

// @ts-ignore — Deno specifier resuelto en runtime Edge.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
// @ts-ignore — web-push para Deno.
import webpush from "https://esm.sh/web-push@3.6.7";

// @ts-ignore — globals Deno.* en runtime Edge.
declare const Deno: { env: { get(k: string): string | undefined }; serve: (h: (r: Request) => Response | Promise<Response>) => void };

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const vapidPublic = Deno.env.get("VAPID_PUBLIC_KEY");
  const vapidPrivate = Deno.env.get("VAPID_PRIVATE_KEY");
  const vapidSubject = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@rendio.co";
  if (!url || !serviceKey || !anonKey) return json({ error: "Function misconfigured: missing Supabase env" }, 500);
  if (!vapidPublic || !vapidPrivate) return json({ error: "Function misconfigured: missing VAPID keys" }, 500);

  // 1) Validar que el caller esté autenticado.
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Missing bearer token" }, 401);
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser(authHeader.slice(7));
  if (userErr || !userData?.user) return json({ error: "Invalid auth" }, 401);

  // 2) Body
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const profileIds = Array.isArray(body.profileIds) ? (body.profileIds as string[]).filter(Boolean) : [];
  const title = String(body.title ?? "Rendio Turnos").slice(0, 120);
  const text = String(body.body ?? "").slice(0, 300);
  const clickUrl = String(body.url ?? "/");
  if (!profileIds.length) return json({ sent: 0, failed: 0 });

  // 3) Cargar suscripciones (service role, bypass RLS).
  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: subs, error: subErr } = await admin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .in("profile_id", profileIds);
  if (subErr) return json({ error: `Error leyendo suscripciones: ${subErr.message}` }, 500);
  if (!subs || !subs.length) return json({ sent: 0, failed: 0 });

  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
  const payload = JSON.stringify({ title, body: text, url: clickUrl });

  let sent = 0, failed = 0;
  const stale: string[] = [];
  await Promise.all(subs.map(async (s: { id: string; endpoint: string; p256dh: string; auth: string }) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
      );
      sent++;
    } catch (e: unknown) {
      failed++;
      // 404/410 → suscripción expirada: la marcamos para borrar.
      const code = (e as { statusCode?: number })?.statusCode;
      if (code === 404 || code === 410) stale.push(s.id);
    }
  }));

  // 4) Limpiar suscripciones muertas.
  if (stale.length) {
    await admin.from("push_subscriptions").delete().in("id", stale);
  }

  return json({ sent, failed });
});
