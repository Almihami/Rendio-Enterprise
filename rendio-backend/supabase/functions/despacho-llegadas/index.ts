// Edge Function: despacho-llegadas (0158)
//
// La llama pg_cron cada 2 min (public.despachar_llegadas). Lee la foto del
// despacho (despacho_estado), decide con el MISMO motor que se midió en el
// simulador (motor.js = copia exacta de rendio-turnos/despacho-llegadas.js;
// scripts/_test-despacho.mjs revisa que sigan iguales) y manda a la base lo
// decidido (despacho_asignar / despacho_avisar).
//
// Usa la llave de servicio porque corre sin usuario: quien la llama es el cron,
// y las tres funciones de la base son solo de servidor. Por eso lo primero es
// comprobar que el que llama trae esa misma llave.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import "./motor.js";
import { armarEstado, type Foto } from "./estado.ts";

// deno-lint-ignore no-explicit-any
const Motor = (globalThis as any).RendioDespacho;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const log = (level: string, msg: string, ctx: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, msg, ctx }));

Deno.serve(async (req: Request) => {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return json({ error: "Faltan SUPABASE_URL / SERVICE_ROLE_KEY" }, 500);
  const auth = req.headers.get("Authorization") || "";
  if (auth !== `Bearer ${serviceKey}`) return json({ error: "No autorizado" }, 401);

  // «en seco»: decide y devuelve lo que haría, sin asignar ni avisar.
  let enSeco = false;
  try { const b = await req.json(); enSeco = b && b.dry_run === true; } catch (_) { /* sin cuerpo */ }

  const db = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data, error } = await db.rpc("despacho_estado");
  if (error) { log("error", "despacho_estado", { error: error.message }); return json({ error: error.message }, 500); }
  const fotos: Foto[] = Array.isArray(data) ? data : [];
  const resumen: Record<string, unknown>[] = [];

  for (const foto of fotos) {
    const { estado, aISO } = armarEstado(foto);
    const d = Motor.decidir(estado);
    let asignadas = 0, avisos = 0;
    const errores: string[] = [];
    if (!enSeco) {
      for (const a of d.asignar) {
        const sale = estado.llegadas.find((l: { id: string }) => l.id === a.ids[0])?.sale;
        const r = await db.rpc("despacho_asignar", {
          p_ra: a.ids[0], p_dp: a.carro, p_recoge: aISO(a.recoge), p_sale: sale != null ? aISO(sale) : null, p_espera: Math.round(a.espera),
        });
        if (r.error) errores.push(r.error.message); else if (r.data === true) asignadas++;
      }
      for (const v of d.avisos) {
        const r = await db.rpc("despacho_avisar", { p_ra: v.id, p_tipo: v.tipo, p_sale: aISO(v.sale), p_espera: v.espera != null ? Math.round(v.espera) : null });
        if (r.error) errores.push(r.error.message); else if (Number(r.data) > 0) avisos++;
      }
    }
    const fila = {
      org: foto.org, en_espera: foto.llegadas.length, conductores: foto.carros.length,
      decididas: d.asignar.length, asignadas, avisos, errores,
      ...(enSeco ? { asignar: d.asignar, avisar: d.avisos } : {}),
    };
    resumen.push(fila);
    log(errores.length ? "error" : "info", "despacho", fila);
  }
  return json({ ok: true, en_seco: enSeco, orgs: resumen });
});
