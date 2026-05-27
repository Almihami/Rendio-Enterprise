// =============================================================================
// Edge Function: geocode-address
//
// Resuelve una dirección a coordenadas usando Nominatim (OpenStreetMap).
// Aplica caché en la tabla geocode_cache para respetar el rate limit
// 1 req/seg de Nominatim y evitar re-geocodificar la misma dirección.
//
// Tarea contractual: E3.01 (adelantada para soportar E2.05).
//
// Body:
//   { address: string, force_refresh?: boolean }
//
// Auth:
//   Authorization: Bearer <user JWT>  — cualquier usuario autenticado.
//
// Respuesta:
//   200 { lat: number | null, lon: number | null, display_name?: string, cached: boolean }
//   400/401/500 { error }
//
// Cache TTL: 30 días desde fetched_at (después se vuelve a consultar a Nominatim).
// =============================================================================

// @ts-ignore — Deno specifier resolve en runtime de Supabase Edge.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// @ts-ignore — globals Deno.* en runtime Edge.
declare const Deno: {
  env: { get(k: string): string | undefined };
  serve: (h: (r: Request) => Response | Promise<Response>) => void;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const CACHE_TTL_DAYS = 30;
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const NOMINATIM_USER_AGENT = "rendio-admin/1.0 (contacto: haroldp.dev@gmail.com)";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normalizeAddress(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, " ").trim();
}

async function md5Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  // @ts-ignore — crypto.subtle disponible en Deno
  const buf = await crypto.subtle.digest("MD5", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface NominatimResult {
  lat: string;
  lon: string;
  display_name: string;
}

async function fetchNominatim(address: string): Promise<{
  lat: number | null;
  lon: number | null;
  display_name: string | null;
}> {
  const params = new URLSearchParams({
    q: address,
    format: "json",
    limit: "1",
    "accept-language": "es",
    countrycodes: "co",
  });
  const res = await fetch(`${NOMINATIM_URL}?${params.toString()}`, {
    headers: { "User-Agent": NOMINATIM_USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(`Nominatim ${res.status}`);
  }
  const body = (await res.json()) as NominatimResult[];
  const first = body[0];
  if (!first) return { lat: null, lon: null, display_name: null };
  return {
    lat: Number.parseFloat(first.lat),
    lon: Number.parseFloat(first.lon),
    display_name: first.display_name ?? null,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !serviceKey || !anonKey) {
    return json({ error: "Function misconfigured: missing env vars" }, 500);
  }

  // 1) Validar JWT del caller (cualquier usuario autenticado puede geocodificar).
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Missing bearer token" }, 401);

  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser(
    authHeader.slice("Bearer ".length),
  );
  if (userErr || !userData?.user) return json({ error: "Invalid auth" }, 401);

  // 2) Body.
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const rawAddress = String(body.address ?? "").trim();
  const forceRefresh = body.force_refresh === true;
  if (rawAddress.length < 4) return json({ error: "address muy corto" }, 400);

  const normalized = normalizeAddress(rawAddress);
  const hash = await md5Hex(normalized);

  // 3) Cliente service_role para la tabla geocode_cache (no expuesta a clientes).
  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 4) Lookup en cache.
  if (!forceRefresh) {
    const { data: cached } = await admin
      .from("geocode_cache")
      .select("lat, lon, display_name, fetched_at")
      .eq("address_hash", hash)
      .maybeSingle();

    if (cached) {
      const ageDays =
        (Date.now() - new Date(cached.fetched_at as string).getTime()) / 86_400_000;
      if (ageDays < CACHE_TTL_DAYS) {
        return json({
          lat: cached.lat,
          lon: cached.lon,
          display_name: cached.display_name,
          cached: true,
        });
      }
    }
  }

  // 5) Llamada a Nominatim + upsert en cache.
  let result: { lat: number | null; lon: number | null; display_name: string | null };
  try {
    result = await fetchNominatim(rawAddress);
  } catch (err) {
    return json(
      { error: `Nominatim error: ${err instanceof Error ? err.message : String(err)}` },
      502,
    );
  }

  const { error: upsertErr } = await admin.from("geocode_cache").upsert(
    {
      address_hash: hash,
      address_raw: rawAddress,
      lat: result.lat,
      lon: result.lon,
      display_name: result.display_name,
      fetched_at: new Date().toISOString(),
    },
    { onConflict: "address_hash" },
  );
  if (upsertErr) {
    // No bloqueamos por error de cache; devolvemos lo de Nominatim.
    console.error(JSON.stringify({ level: "warn", msg: "cache upsert failed", err: upsertErr.message }));
  }

  return json({
    lat: result.lat,
    lon: result.lon,
    display_name: result.display_name,
    cached: false,
  });
});
