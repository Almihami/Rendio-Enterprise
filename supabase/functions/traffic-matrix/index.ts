// =============================================================================
// Edge Function: traffic-matrix
//
// Matriz de tiempos de viaje CON TRÁFICO entre los puntos de una planeación,
// para una hora de salida futura. Es lo que le faltaba al asignador: hoy calcula
// con OSRM (que da flujo libre, sin trancones) y lo corrige con un factor fijo
// de 1.25 — el mismo a las 4 de la mañana que a las 5 de la tarde.
//
// Con esto, planear a las 4pm la vuelta de las 5pm usa el tiempo que de verdad
// va a tomar a esa hora, y el asignador puede reordenar o adelantar la salida
// ANTES de que el carro salga.
//
// Va en el servidor y no en la PWA porque la llave de TomTom no puede viajar al
// navegador: cualquiera la leería del código y gastaría la cuota.
//
// Body:
//   { points: [{ lat, lng }], departAt?: "2026-08-01T17:00:00", traffic?: "historical"|"live" }
//
// Auth:
//   Authorization: Bearer <JWT>. Solo administradores: es la pantalla de
//   planeación la que consume esto, y cada llamada gasta cuota.
//
// Requiere el secret:
//   supabase secrets set TOMTOM_API_KEY=... --project-ref <ref>
//
// Respuesta 200:
//   { source: "tomtom", durations: [[min]], delays: [[min]], departAt }
//   'durations' ya incluye el tráfico — quien la use NO debe volver a
//   multiplicar por el factor de tráfico o lo contaría dos veces.
//   'delays' es cuánto de ese tiempo es demora por tráfico (para poder decir
//   "son 12 minutos de trancón" en vez de solo un número más grande).
// =============================================================================

// @ts-ignore — Deno specifier resuelto en runtime Edge.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

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
function log(level: string, msg: string, ctx: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level, msg, ctx }));
}

// TomTom permite 100×100 en la versión síncrona y ahí ponemos el tope: un día
// operativo real son ~80 traslados + depot + aeropuerto = 82 puntos, así que un
// límite más bajo dejaría al asignador sin tráfico justo los días cargados.
//
// OJO CON EL COSTO: TomTom no cobra por llamada sino por celda. Con más de 5
// orígenes y destinos cobra max(origins,destinations) × 5, así que 82 puntos
// son 410 transacciones POR CONSULTA. Por eso el cliente cachea la matriz
// (misma planeación + misma hora = una sola consulta), y por eso esto es solo
// para admin. Si se quita el caché, se quema la cuota en un día.
const MAX_POINTS = 100;
// Aviso en el log cuando una consulta sale cara, para poder verlo en producción.
const COSTLY_POINTS = 40;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const tomtomKey = Deno.env.get("TOMTOM_API_KEY");
  if (!url || !anonKey) return json({ error: "Function misconfigured: missing Supabase env" }, 500);
  // Sin llave la función NO inventa tiempos: responde que no hay servicio y el
  // asignador se queda con OSRM, que es su comportamiento de siempre.
  if (!tomtomKey) return json({ error: "TOMTOM_API_KEY no configurada", source: "none" }, 503);

  // 1) Caller autenticado…
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Missing bearer token" }, 401);
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser(authHeader.slice(7));
  if (userErr || !userData?.user) return json({ error: "Invalid auth" }, 401);

  // 2) …y que sea admin. Cada llamada consume cuota de pago: no puede quedar
  //    abierta a cualquier usuario con sesión.
  const { data: rol, error: rolErr } = await userClient.rpc("current_user_role");
  if (rolErr || rol !== "admin") return json({ error: "Solo administradores" }, 403);

  // 3) Body
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const raw = Array.isArray(body.points) ? body.points as Array<Record<string, unknown>> : [];
  const points = raw
    .map((p) => ({ lat: Number(p?.lat), lng: Number(p?.lng) }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (points.length < 2) return json({ error: "Se necesitan al menos 2 puntos con coordenadas" }, 400);
  if (points.length > MAX_POINTS) return json({ error: `Máximo ${MAX_POINTS} puntos por consulta` }, 400);

  const departAt = typeof body.departAt === "string" && body.departAt ? body.departAt : "any";
  // 'live' solo aplica al momento actual; para una hora futura TomTom usa el
  // histórico, que es justamente lo que sirve para planear.
  const traffic = body.traffic === "live" ? "live" : "historical";
  if (departAt === "any" && traffic === "live") return json({ error: "El tráfico en vivo necesita una hora de salida" }, 400);

  const pts = points.map((p) => ({ point: { latitude: p.lat, longitude: p.lng } }));
  const payload = {
    origins: pts,
    destinations: pts,
    options: { departAt, traffic, travelMode: "car", routeType: "fastest" },
  };

  let tt: Response;
  try {
    tt = await fetch(`https://api.tomtom.com/routing/matrix/2?key=${encodeURIComponent(tomtomKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    log("error", "TomTom inalcanzable", { err: String(e) });
    return json({ error: "No se pudo consultar el tráfico", source: "none" }, 502);
  }
  if (!tt.ok) {
    const detail = await tt.text().catch(() => "");
    // El detalle NO se devuelve al cliente: puede traer eco de la petición.
    log("error", "TomTom respondió con error", { status: tt.status, detail: detail.slice(0, 300) });
    return json({ error: `TomTom respondió ${tt.status}`, source: "none" }, tt.status === 403 ? 403 : 502);
  }

  const out = await tt.json().catch(() => null);
  const cells = out && Array.isArray(out.data) ? out.data : null;
  if (!cells) return json({ error: "Respuesta de TomTom sin datos", source: "none" }, 502);

  // Matriz cuadrada en minutos. null = TomTom no pudo con ese par (lo dejamos
  // en null a propósito: quien llama decide con qué reemplazarlo, en vez de
  // recibir un cero que parecería "está al lado").
  const n = points.length;
  const durations: (number | null)[][] = Array.from({ length: n }, () => Array(n).fill(null));
  const delays: (number | null)[][] = Array.from({ length: n }, () => Array(n).fill(null));
  for (const c of cells) {
    const i = Number(c?.originIndex), j = Number(c?.destinationIndex);
    const s = c?.routeSummary?.travelTimeInSeconds;
    if (!Number.isInteger(i) || !Number.isInteger(j) || i < 0 || j < 0 || i >= n || j >= n) continue;
    if (typeof s !== "number") continue;
    durations[i][j] = i === j ? 0 : Math.max(1, Math.round((s / 60) * 10) / 10);
    const d = c?.routeSummary?.trafficDelayInSeconds;
    delays[i][j] = typeof d === "number" ? Math.round((d / 60) * 10) / 10 : 0;
  }

  const ok = out?.statistics?.successes ?? cells.length;
  // Costo estimado según la regla de TomTom (celdas, no llamadas): con más de 5
  // orígenes y destinos cobra max × 5. Se registra para poder auditar la cuota.
  const billed = n > 5 ? n * 5 : n * n;
  log(n >= COSTLY_POINTS ? "warn" : "info", "matriz de tráfico resuelta",
    { points: n, billedTransactions: billed, departAt, traffic, successes: ok });
  return json({ source: "tomtom", durations, delays, departAt, traffic, successes: ok, billedTransactions: billed });
});
