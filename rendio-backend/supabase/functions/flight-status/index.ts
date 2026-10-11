// flight-status — consulta el estado de los vuelos de las reservas (0099).
//
// La llama pg_cron cada 15 min vía public.poll_flight_status() (pg_net, con la
// URL y la llave del Vault). Hace:
//   1. ¿Está encendida? Sin AERODATABOX_API_KEY (y sin modo prueba) o con
//      app_settings.flight_api_enabled = false responde {disabled:true, motivo}
//      y NO hace nada más: ni consulta, ni guarda, ni avisa.
//   2. public.flight_status_targets() → qué vuelos tocan ahora (la base decide
//      la ventana de 12 h y el mínimo de 20 min entre consultas del mismo vuelo).
//   3. Le pregunta al proveedor (AeroDataBox por RapidAPI) uno por uno, con una
//      pausa entre llamadas para no pasarse del límite por segundo del plan, y
//      sin repetir el mismo número+fecha dentro de la corrida (dos
//      organizaciones con el mismo vuelo = una sola llamada).
//   4. public.flight_status_record(rows) guarda; public.flight_delay_alerts()
//      encola los avisos (la bandeja la drena dispatch-notifications).
//
// Toda la lectura de la respuesta del proveedor vive en ./aerodatabox.mjs, que
// es JS puro y se prueba con node (scripts/_test-vuelos-parser.mjs).
//
// POR QUÉ LA LLAVE DE SERVICIO: escribe en flight_statuses (sin políticas de
// escritura: nadie desde el cliente) y llama funciones que solo tiene
// service_role. Por lo mismo, solo entra quien traiga esa llave (el cron).
//
// Secretos de la función:
//   AERODATABOX_API_KEY      la llave de RapidAPI (X-RapidAPI-Key). La pone la dueña.
//   FLIGHT_STATUS_MOCK=1     modo prueba: no llama al proveedor; usa los fixtures
//                            de ./fixtures (respuestas con la forma real) corridos
//                            a la hora de cada reserva. No necesita la llave.
//   AERODATABOX_MIN_GAP_MS   pausa entre llamadas (default 600 ms ≈ 1,6 por segundo).
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY las inyecta Supabase.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import * as adb from "./aerodatabox.mjs";
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
};
type Fetched = { http: number; body: unknown; error?: string };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const log = (level: string, msg: string, ctx: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, msg, ctx }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req: Request) => {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return json({ error: "Faltan SUPABASE_URL / SERVICE_ROLE_KEY" }, 500);

  const auth = req.headers.get("Authorization") || "";
  if (auth !== `Bearer ${serviceKey}`) return json({ error: "No autorizado" }, 401);

  const mock = Deno.env.get("FLIGHT_STATUS_MOCK") === "1";
  const apiKey = Deno.env.get("AERODATABOX_API_KEY") || "";
  const gapMs = Math.max(0, Number(Deno.env.get("AERODATABOX_MIN_GAP_MS") || 600));

  if (!mock && !apiKey) {
    return json({ disabled: true, motivo: "Falta el secreto AERODATABOX_API_KEY en la Edge Function flight-status" });
  }

  const db = createClient(url, serviceKey, { auth: { persistSession: false } });

  const { data: cfg, error: errCfg } = await db
    .from("app_settings").select("flight_api_enabled").eq("id", "singleton").maybeSingle();
  if (errCfg) {
    return json({ disabled: true, motivo: `No se pudo leer app_settings.flight_api_enabled (¿falta la migración 0099?): ${errCfg.message}` });
  }
  if (!cfg || cfg.flight_api_enabled !== true) {
    return json({ disabled: true, motivo: "app_settings.flight_api_enabled = false" });
  }

  let limit = 20;
  try {
    const b = await req.json();
    if (b && Number.isInteger(b.limit)) limit = Math.min(Math.max(b.limit, 1), 50);
  } catch (_) { /* el cron manda {trigger:'cron'}; sin cuerpo también vale */ }

  const { data: targets, error: errT } = await db.rpc("flight_status_targets", { p_limit: limit });
  if (errT) return json({ error: `flight_status_targets: ${errT.message}` }, 500);
  const lista = (targets || []) as Target[];

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
    if (mock) {
      res = { http: 200, body: adb.mockBody(t, t.direction === "airport_to_home" ? llegadaFixture : salidaFixture) };
    } else {
      if (llamadas > 0 && gapMs) await sleep(gapMs);
      const rq = adb.buildRequest(code, day, { apiKey });
      llamadas++;
      try {
        const r = await fetch(rq.url, { headers: rq.headers, signal: AbortSignal.timeout(10000) });
        const text = await r.text();
        let body: unknown = null;
        try { body = text ? JSON.parse(text) : null; } catch (_) { body = null; }
        res = { http: r.status, body };
      } catch (e) {
        res = { http: 0, body: null, error: String((e as Error).message || e) };
      }
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
    if (parsed) rows.push(adb.toRecord(t, parsed, mock ? "mock" : "aerodatabox", http));
  }

  let guardados = 0;
  if (rows.length) {
    const { data: n, error: errR } = await db.rpc("flight_status_record", { p_rows: rows });
    if (errR) {
      log("error", "flight_status_record falló", { error: errR.message, filas: rows.length });
      return json({ error: `flight_status_record: ${errR.message}`, llamadas }, 500);
    }
    guardados = Number(n) || 0;
  }

  const { data: avisos, error: errA } = await db.rpc("flight_delay_alerts");
  if (errA) log("error", "flight_delay_alerts falló", { error: errA.message });

  const salida = {
    mock, consultados: lista.length, llamadas, guardados,
    avisos: Number(avisos) || 0, errores, abortado,
  };
  log(abortado ? "warn" : "info", "estado de vuelos", salida);
  return json(salida);
});
