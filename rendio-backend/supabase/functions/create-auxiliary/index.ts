// =============================================================================
// Edge Function: create-auxiliary
//
// Crea un auxiliar nuevo (auth.users + profiles + auxiliar_profiles) en una
// sola operación, validando que el caller sea admin activo de la organización.
//
// Body:
//   {
//     email: string,
//     password: string,
//     full_name: string,
//     phone?: string,
//     home_address: string,
//     home_latitude: number,
//     home_longitude: number,
//     employee_code?: string,
//     notes?: string
//   }
//
// Auth:
//   Authorization: Bearer <admin JWT>
//
// Respuesta:
//   201 { id, email, full_name, home_address, home_latitude, home_longitude }
//   400/401/403/409/500 { error }
//
// Sigue el patrón de create-driver: SERVICE_ROLE_KEY interno, rollback de
// auth.users si falla la inserción de profile o auxiliar_profile.
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
  if (!url || !serviceKey || !anonKey) {
    return json({ error: "Function misconfigured: missing env vars" }, 500);
  }

  // 1) JWT del caller.
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Missing bearer token" }, 401);
  const jwt = authHeader.slice("Bearer ".length);

  // 2) Identificar al caller.
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser(jwt);
  if (userErr || !userData?.user) return json({ error: "Invalid auth" }, 401);

  // 3) Confirmar admin activo.
  const { data: prof, error: profErr } = await userClient
    .from("profiles")
    .select("role, organization_id, is_active, deleted_at")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (profErr) return json({ error: `Error leyendo perfil: ${profErr.message}` }, 500);
  if (!prof) return json({ error: "Caller profile not found" }, 403);
  if (prof.role !== "admin" || prof.is_active === false || prof.deleted_at) {
    return json({ error: "Only active admins can create auxiliaries" }, 403);
  }

  // 4) Body.
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const fullName = String(body.full_name ?? "").trim();
  const phone = body.phone ? String(body.phone).trim() : null;
  const homeAddress = String(body.home_address ?? "").trim();
  const homeLat = Number(body.home_latitude);
  const homeLon = Number(body.home_longitude);
  const employeeCode = body.employee_code ? String(body.employee_code).trim() : null;
  const notes = body.notes ? String(body.notes).trim() : null;

  if (!email || !password || !fullName) {
    return json({ error: "email, password y full_name son obligatorios" }, 400);
  }
  if (password.length < 8) return json({ error: "La contraseña debe tener al menos 8 caracteres" }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Email inválido" }, 400);
  if (!homeAddress || homeAddress.length < 5) {
    return json({ error: "home_address es obligatorio (mínimo 5 caracteres)" }, 400);
  }
  if (!Number.isFinite(homeLat) || homeLat < -90 || homeLat > 90) {
    return json({ error: "home_latitude inválido" }, 400);
  }
  if (!Number.isFinite(homeLon) || homeLon < -180 || homeLon > 180) {
    return json({ error: "home_longitude inválido" }, 400);
  }

  // 5) Admin client.
  const adminClient = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 5a) Verificar email único.
  const { data: existing } = await adminClient
    .from("profiles")
    .select("id")
    .eq("email", email)
    .maybeSingle();
  if (existing) return json({ error: "Ya existe un usuario con ese email" }, 409);

  // 5b) Crear auth user.
  const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (createErr || !created?.user) {
    return json({ error: `Error creando usuario: ${createErr?.message ?? "desconocido"}` }, 500);
  }
  const newUserId = created.user.id;

  // 5c) Insertar profile.
  const profilePayload: Record<string, unknown> = {
    id: newUserId,
    organization_id: prof.organization_id,
    role: "auxiliar",
    full_name: fullName,
    email,
    phone,
    is_active: true,
  };
  const { error: pErr } = await adminClient.from("profiles").insert(profilePayload);
  if (pErr) {
    await adminClient.auth.admin.deleteUser(newUserId);
    return json({ error: `Error creando perfil: ${pErr.message}` }, 500);
  }

  // 5d) Insertar auxiliar_profile.
  const { error: aErr } = await adminClient.from("auxiliar_profiles").insert({
    profile_id: newUserId,
    home_address: homeAddress,
    home_latitude: homeLat,
    home_longitude: homeLon,
    employee_code: employeeCode,
    notes,
  });
  if (aErr) {
    // Rollback: borramos profile y auth user.
    await adminClient.from("profiles").delete().eq("id", newUserId);
    await adminClient.auth.admin.deleteUser(newUserId);
    return json({ error: `Error creando auxiliar_profile: ${aErr.message}` }, 500);
  }

  return json(
    {
      id: newUserId,
      email,
      full_name: fullName,
      home_address: homeAddress,
      home_latitude: homeLat,
      home_longitude: homeLon,
    },
    201,
  );
});
