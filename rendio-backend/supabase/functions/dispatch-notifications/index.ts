// dispatch-notifications — drena la bandeja de salida de avisos.
//
// POR QUÉ EXISTE ESTA FUNCIÓN Y NO SE LLAMA A `send-push` DIRECTO:
// `send-push` exige un JWT de USUARIO (hace `auth.getUser`) porque la manda la
// app de alguien que está con sesión abierta. El cron no es un usuario: la llave
// de servicio le devolvería 401. Y no se le puede meter un bypass a `send-push`
// sin arriesgar los tres flujos que ya dependen de ella (chat del traslado,
// publicación del plan, cancelaciones).
//
// POR QUÉ ESTA FUNCIÓN JALA EN VEZ DE QUE LA BASE EMPUJE:
// pg_net es fire-and-forget: encola la petición, la respuesta cae en
// `net._http_response` y nadie la lee. Si la base intentara mandar el push ella
// misma, un fallo sería INVISIBLE — daríamos por hecho que el aviso salió, el
// teléfono no sonaría, y en los logs no habría ni un error. Aquí el cron solo
// dispara; quien lee la bandeja, envía y ESCRIBE EL RESULTADO es esta función,
// que sí sabe cómo le fue. Lo que no salió queda con `last_error`.
//
// Secretos que necesita (los mismos de send-push): VAPID_PUBLIC_KEY,
// VAPID_PRIVATE_KEY, VAPID_SUBJECT, y SUPABASE_SERVICE_ROLE_KEY (la inyecta
// Supabase sola).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import webpush from "https://esm.sh/web-push@3.6.7";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const LOTE = 50;       // por corrida; el cron pasa cada minuto
const MAX_INTENTOS = 5; // después de esto se deja de intentar y se ve en ops_alert_health()

Deno.serve(async (req: Request) => {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const vapidPublic = Deno.env.get("VAPID_PUBLIC_KEY");
  const vapidPrivate = Deno.env.get("VAPID_PRIVATE_KEY");
  const vapidSubject = Deno.env.get("VAPID_SUBJECT") || "mailto:soporte@rendio.co";

  if (!url || !serviceKey) return json({ error: "Faltan SUPABASE_URL / SERVICE_ROLE_KEY" }, 500);
  if (!vapidPublic || !vapidPrivate) return json({ error: "Faltan las llaves VAPID" }, 500);

  // Solo entra quien traiga la llave de servicio: es a quien le confiamos la
  // bandeja. La llama el cron de Postgres vía pg_net.
  const auth = req.headers.get("Authorization") || "";
  if (auth !== `Bearer ${serviceKey}`) {
    return json({ error: "No autorizado" }, 401);
  }

  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
  const db = createClient(url, serviceKey, { auth: { persistSession: false } });

  // 1) Lo que está pendiente y todavía vale la pena intentar.
  const { data: pend, error: errPend } = await db
    .from("notification_outbox")
    .select("id, profile_id, title, body, url, attempts")
    .is("sent_at", null)
    .lte("send_after", new Date().toISOString())
    .lt("attempts", MAX_INTENTOS)
    .order("created_at", { ascending: true })
    .limit(LOTE);

  if (errPend) return json({ error: errPend.message }, 500);
  if (!pend || !pend.length) return json({ enviados: 0, fallidos: 0, pendientes: 0 });

  // 2) Las suscripciones de todos los destinatarios, de una sola consulta.
  const ids = [...new Set(pend.map((p) => p.profile_id))];
  const { data: subs } = await db
    .from("push_subscriptions")
    .select("id, profile_id, endpoint, p256dh, auth")
    .in("profile_id", ids);

  const porPerfil = new Map<string, typeof subs>();
  for (const s of subs || []) {
    if (!porPerfil.has(s.profile_id)) porPerfil.set(s.profile_id, []);
    porPerfil.get(s.profile_id)!.push(s);
  }

  let enviados = 0, fallidos = 0;

  for (const fila of pend) {
    const destinos = porPerfil.get(fila.profile_id) || [];

    // Sin suscripción no hay nada que reintentar: esa persona no ha activado las
    // notificaciones en ningún dispositivo. Se marca y se dice, en vez de dejar
    // la fila girando para siempre.
    if (!destinos.length) {
      await db.from("notification_outbox").update({
        attempts: MAX_INTENTOS,
        last_error: "sin dispositivo: no ha activado notificaciones",
      }).eq("id", fila.id);
      fallidos++;
      continue;
    }

    const payload = JSON.stringify({ title: fila.title, body: fila.body, url: fila.url || "/" });
    let algunaSalio = false;
    let ultimoError = "";

    for (const s of destinos) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
        );
        algunaSalio = true;
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        ultimoError = `${status || ""} ${(e as Error).message || ""}`.trim();
        // Suscripción muerta: se limpia, como ya hace send-push.
        if (status === 404 || status === 410) {
          await db.from("push_subscriptions").delete().eq("id", s.id);
        }
      }
    }

    if (algunaSalio) {
      await db.from("notification_outbox").update({
        sent_at: new Date().toISOString(),
        attempts: (fila.attempts || 0) + 1,
        last_error: null,
      }).eq("id", fila.id);
      enviados++;
    } else {
      await db.from("notification_outbox").update({
        attempts: (fila.attempts || 0) + 1,
        last_error: ultimoError.slice(0, 300),
      }).eq("id", fila.id);
      fallidos++;
    }
  }

  const { count } = await db
    .from("notification_outbox")
    .select("id", { count: "exact", head: true })
    .is("sent_at", null);

  console.log(JSON.stringify({ level: "info", msg: "outbox drenada", ctx: { enviados, fallidos, pendientes: count } }));
  return json({ enviados, fallidos, pendientes: count ?? 0 });
});
