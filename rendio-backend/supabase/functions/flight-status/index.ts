// flight-status — consulta el estado de los vuelos de LLEGADA de las reservas
// (0099; Flightradar24 desde 0118).
//
// La llama pg_cron cada 15 min vía public.poll_flight_status() (pg_net, con la
// URL y la llave del Vault). Hace:
//   1. ¿Está encendida? Sin el token del proveedor (y sin modo prueba) o con
//      app_settings.flight_api_enabled = false responde {disabled:true, motivo}
//      y NO hace nada más: ni consulta, ni guarda, ni avisa.
//   2. public.flight_status_targets() → qué vuelos tocan ahora y qué preguntar de
//      cada uno (la base lleva el calendario: summary antes del despegue y al
//      llegar la ETA, live en el aire; ver 0118).
//   3. Le pregunta al proveedor. Con Flightradar24 (./fr24.mjs): hasta 15 números
//      por petición, un mismo número una sola vez aunque lo tengan dos
//      organizaciones, nunca más de 10 peticiones por minuto, y si un vuelo ya no
//      está en vivo lo confirma con un summary en la misma corrida.
//   4. public.flight_status_record(rows) guarda; public.flight_delay_alerts()
//      encola los avisos (la bandeja la drena dispatch-notifications).
//
// UN SOLO PROVEEDOR: los términos de FR24 prohíben mezclar o rellenar sus datos
// con los de otro. Si FR24 no trae un vuelo, queda «unknown»; no hay respaldo.
//
// Toda la lectura de las respuestas vive en ./fr24.mjs (y ./aerodatabox.mjs),
// JS puro que se prueba con node (scripts/_test-vuelos-fr24.mjs,
// scripts/_test-vuelos-parser.mjs, scripts/_verify-0118.mjs).
//
// POR QUÉ LA LLAVE DE SERVICIO: escribe en flight_statuses (sin políticas de
// escritura: nadie desde el cliente) y llama funciones que solo tiene
// service_role. Por lo mismo, solo entra quien traiga esa llave (el cron).
//
// Secretos de la función:
//   FLIGHT_PROVIDER          'fr24' (por defecto) | 'aerodatabox' (apagado desde 0118).
//   FR24_API_TOKEN           el token de la FR24 API (Authorization: Bearer). Lo pone la dueña.
//   FR24_SANDBOX=1           usa el sandbox de FR24 (datos FIJOS, token de sandbox):
//                            sirve para probar token, headers y forma; no trae los vuelos de MDE.
//   FR24_MIN_GAP_MS          pausa entre peticiones a FR24 (por defecto 6500 ms).
//   FLIGHT_STATUS_MOCK=1     modo prueba: no llama a nadie. Con fr24, un vuelo falso por
//                            reserva que avanza con el reloj (despega 25 min tarde);
//                            se guarda con source 'mock' y el chip dice «· prueba».
//   AERODATABOX_API_KEY / AERODATABOX_MIN_GAP_MS  solo con FLIGHT_PROVIDER=aerodatabox.
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY las inyecta Supabase.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import * as fr24 from "./fr24.mjs";
import * as adb from "./aerodatabox.mjs";
import fr24Summary from "./fixtures/fr24-summary-light.json" with { type: "json" };
import fr24Live from "./fixtures/fr24-live-full.json" with { type: "json" };
import llegadaFixture from "./fixtures/aerodatabox-llegada.json" with { type: "json" };
import salidaFixture from "./fixtures/aerodatabox-salida.json" with { type: "json" };

type Target = {
  organization_id: string;
  flight_code: string;
  flight_date: string;
  direction: "airport_to_home" | "home_to_airport";
  ref_at: string;
  reservations: number;
  last_fetched_at: string | null;
  last_status: string | null;
  mode: "summary" | "live";
  provider_ref: string | null;
  departed_at: string | null;
  estimated_at: string | null;
};
type Fetched = { http: number; body: unknown; error?: string };
type Corrida = {
  rows: unknown[];
  llamadas: number;
  creditos: number | null;
  errores: Array<Record<string, unknown>>;
  abortado: string | null;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const log = (level: string, msg: string, ctx: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, msg, ctx }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string, headers: Record<string, string>, timeoutMs: number): Promise<Fetched> {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    const text = await r.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch (_) { body = null; }
    return { http: r.status, body };
  } catch (e) {
    return { http: 0, body: null, error: String((e as Error).message || e) };
  }
}

// ── Flightradar24 ─────────────────────────────────────────────────────────────
async function corridaFr24(lista: Target[], o: { mock: boolean; token: string; sandbox: boolean; aliases: unknown }): Promise<Corrida> {
  const now = Date.now();
  const doFetch = o.mock
    ? fr24.mockFetch(lista, { now, fixtures: { summary: fr24Summary, live: fr24Live }, aliases: o.aliases })
    : (req: unknown) => {
        const rq = fr24.buildRequest(req, { token: o.token, sandbox: o.sandbox });
        return getJson(rq.url, rq.headers, 15000);
      };
  // Con FR24 de verdad, una pausa entre peticiones (ver MIN_GAP_MS); el modo prueba no la necesita.
  const gap = o.mock ? 0 : Math.max(0, Number(Deno.env.get("FR24_MIN_GAP_MS") || fr24.MIN_GAP_MS));
  return await fr24.run(lista, { fetch: doFetch, now, aliases: o.aliases, minGapMs: gap, source: o.mock ? "mock" : "flightradar24" });
}

// ── AeroDataBox (apagado desde 0118; se conserva solo por si hubiera que volver) ─
async function corridaAerodatabox(lista: Target[], o: { mock: boolean; apiKey: string; gapMs: number }): Promise<Corrida> {
  const cache = new Map<string, Fetched>();
  const rows: unknown[] = [];
  const errores: Array<Record<string, unknown>> = [];
  let llamadas = 0;
  let abortado: string | null = null;

  async function consultar(code: string, day: string, t: Target): Promise<Fetched> {
    const key = `${adb.normalizeCode(code)}|${day}`;
    const hit = cache.get(key);
    if (hit) return hit;
    let res: Fetched;
    if (o.mock) {
      res = { http: 200, body: adb.mockBody(t, t.direction === "airport_to_home" ? llegadaFixture : salidaFixture) };
    } else {
      if (llamadas > 0 && o.gapMs) await sleep(o.gapMs);
      const rq = adb.buildRequest(code, day, { apiKey: o.apiKey });
      llamadas++;
      res = await getJson(rq.url, rq.headers, 10000);
    }
    cache.set(key, res);
    return res;
  }

  for (const t of lista) {
    if (abortado) break;
    let parsed: ReturnType<typeof adb.parseFlightStatus> | null = null;
    let http: number | null = null;
    for (const day of adb.queryDates(t)) {
      const res = await consultar(t.flight_code, day, t);
      const kind = adb.classifyHttp(res.http);
      http = res.http;
      if (kind === "auth") { abortado = `El proveedor rechazó la llave o la suscripción (HTTP ${res.http})`; parsed = null; break; }
      if (kind === "rate") { abortado = "Límite del plan o demasiadas consultas por segundo (HTTP 429)"; parsed = null; break; }
      if (kind === "retry") {
        // No se guarda nada: la próxima vuelta del cron lo vuelve a intentar.
        errores.push({ vuelo: t.flight_code, dia: day, http: res.http, error: res.error || null });
        parsed = null;
        break;
      }
      parsed = adb.parseFlightStatus(kind === "empty" ? [] : res.body, t);
      if (parsed.found) break;
    }
    if (parsed) rows.push(adb.toRecord(t, parsed, o.mock ? "mock" : "aerodatabox", http));
  }
  return { rows, llamadas, creditos: null, errores, abortado };
}

Deno.serve(async (req: Request) => {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return json({ error: "Faltan SUPABASE_URL / SERVICE_ROLE_KEY" }, 500);

  const auth = req.headers.get("Authorization") || "";
  if (auth !== `Bearer ${serviceKey}`) return json({ error: "No autorizado" }, 401);

  const proveedor = (Deno.env.get("FLIGHT_PROVIDER") || "fr24").trim().toLowerCase();
  const mock = Deno.env.get("FLIGHT_STATUS_MOCK") === "1";
  const token = Deno.env.get("FR24_API_TOKEN") || "";
  const sandbox = Deno.env.get("FR24_SANDBOX") === "1";
  const apiKey = Deno.env.get("AERODATABOX_API_KEY") || "";
  const gapMs = Math.max(0, Number(Deno.env.get("AERODATABOX_MIN_GAP_MS") || 600));

  if (proveedor !== "fr24" && proveedor !== "aerodatabox") {
    return json({ disabled: true, motivo: `FLIGHT_PROVIDER = '${proveedor}': se espera 'fr24' (o 'aerodatabox')` });
  }
  if (!mock && proveedor === "fr24" && !token) {
    return json({ disabled: true, motivo: "Falta el secreto FR24_API_TOKEN en la Edge Function flight-status" });
  }
  if (!mock && proveedor === "aerodatabox" && !apiKey) {
    return json({ disabled: true, motivo: "Falta el secreto AERODATABOX_API_KEY en la Edge Function flight-status" });
  }

  const db = createClient(url, serviceKey, { auth: { persistSession: false } });

  const { data: cfg, error: errCfg } = await db
    .from("app_settings").select("flight_api_enabled, flight_code_aliases").eq("id", "singleton").maybeSingle();
  if (errCfg) {
    return json({ disabled: true, motivo: `No se pudo leer app_settings (¿falta la migración 0118?): ${errCfg.message}` });
  }
  if (!cfg || cfg.flight_api_enabled !== true) {
    return json({ disabled: true, motivo: "app_settings.flight_api_enabled = false" });
  }

  let limit = 45;
  try {
    const b = await req.json();
    if (b && Number.isInteger(b.limit)) limit = Math.min(Math.max(b.limit, 1), 60);
  } catch (_) { /* el cron manda {trigger:'cron'}; sin cuerpo también vale */ }

  const { data: targets, error: errT } = await db.rpc("flight_status_targets", { p_limit: limit });
  if (errT) return json({ error: `flight_status_targets: ${errT.message}` }, 500);
  const lista = (targets || []) as Target[];

  const c: Corrida = proveedor === "fr24"
    ? await corridaFr24(lista, { mock, token, sandbox, aliases: cfg.flight_code_aliases || {} })
    : await corridaAerodatabox(lista, { mock, apiKey, gapMs });

  let guardados = 0;
  if (c.rows.length) {
    const { data: n, error: errR } = await db.rpc("flight_status_record", { p_rows: c.rows });
    if (errR) {
      log("error", "flight_status_record falló", { error: errR.message, filas: c.rows.length });
      return json({ error: `flight_status_record: ${errR.message}`, llamadas: c.llamadas }, 500);
    }
    guardados = Number(n) || 0;
  }

  const { data: avisos, error: errA } = await db.rpc("flight_delay_alerts");
  if (errA) log("error", "flight_delay_alerts falló", { error: errA.message });

  const salida = {
    proveedor, mock, sandbox: proveedor === "fr24" ? sandbox : undefined,
    consultados: lista.length, llamadas: c.llamadas, creditos: c.creditos, guardados,
    avisos: Number(avisos) || 0, errores: c.errores, abortado: c.abortado,
  };
  log(c.abortado ? "warn" : "info", "estado de vuelos", salida);
  return json(salida);
});
