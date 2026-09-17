// =============================================================================
// Edge Function: create-driver
//
// Crea un conductor nuevo (auth.users + profiles + driver_profiles) en una
// sola operación, validando que el caller sea admin activo.
//
// Body:
//   {
//     email: string,
//     password: string,
//     full_name: string,
//     phone?: string,
//     priority?: number,
//     can_coordinate?: boolean,
//     license_number?: string,
//     license_expires_at?: string,
//     eps_provider?: string,
//     eps_expires_at?: string,
//     arl_provider?: string,
//     arl_expires_at?: string
//   }
//
// Auth:
//   Authorization: Bearer <admin JWT>
//
// Respuesta:
//   201 { id, email, full_name, priority, can_coordinate, license_number, license_expires_at, eps_provider, eps_expires_at, arl_provider, arl_expires_at }
//   400/401/403/409/500 { error }
//
// Usa SERVICE_ROLE_KEY internamente (no expuesta al cliente) para crear el
// auth user y bypass RLS al insertar el profile. Hace rollback del auth user
// si el insert del profile falla.
// =============================================================================

// @ts-ignore — Deno specifier resolve en runtime de Supabase Edge.
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

function nullableString(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function nullableDate(value: unknown): string | null {
  const text = nullableString(value);
  if (!text) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "__INVALID_DATE__";
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

  // 1) JWT del caller
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Missing bearer token" }, 401);
  const jwt = authHeader.slice("Bearer ".length);

  // 2) Identificar el user del caller con el anon client (respetando JWT)
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser(jwt);
  if (userErr || !userData?.user) return json({ error: "Invalid auth" }, 401);

  // 3) Confirmar que el caller es admin activo
  const { data: prof, error: profErr } = await userClient
    .from("profiles")
    .select("role, organization_id, is_active, deleted_at")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (profErr) return json({ error: `Error leyendo perfil: ${profErr.message}` }, 500);
  if (!prof) return json({ error: "Caller profile not found" }, 403);
  if (prof.role !== "admin" || prof.is_active === false || prof.deleted_at) {
    return json({ error: "Only active admins can create drivers" }, 403);
  }

  // 4) Body
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const fullName = String(body.full_name ?? "").trim();
  const phone = nullableString(body.phone);
  const priority = Math.min(4, Math.max(1, parseInt(String(body.priority ?? "1"), 10) || 1));
  const canCoordinate = body.can_coordinate === true;
  const licenseNumber = nullableString(body.license_number);
  const licenseExpiresAt = nullableDate(body.license_expires_at);
  const epsProvider = nullableString(body.eps_provider);
  const epsExpiresAt = nullableDate(body.eps_expires_at);
  const arlProvider = nullableString(body.arl_provider);
  const arlExpiresAt = nullableDate(body.arl_expires_at);

  if (!email || !password || !fullName) {
    return json({ error: "email, password y full_name son obligatorios" }, 400);
  }
  if (password.length < 8) return json({ error: "La contraseña debe tener al menos 8 caracteres" }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Email inválido" }, 400);
  if (phone && !/^\+?\d{7,15}$/.test(phone)) return json({ error: "Teléfono inválido" }, 400);
  if ([licenseExpiresAt, epsExpiresAt, arlExpiresAt].includes("__INVALID_DATE__")) {
    return json({ error: "Fechas legales inválidas. Usa formato YYYY-MM-DD" }, 400);
  }

  // 5) Admin client con SERVICE_ROLE (bypass RLS para auth admin + insert profile)
  const adminClient = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 5a) Verificar email único
  const { data: existing } = await adminClient
    .from("profiles")
    .select("id")
    .eq("email", email)
    .maybeSingle();
  if (existing) return json({ error: "Ya existe un usuario con ese email" }, 409);

  // 5b) Crear auth user
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

  // 5c) Insertar profile (con fallback por columnas opcionales 0011/0012/0013)
  const fullPayload: Record<string, unknown> = {
    id: newUserId,
    organization_id: prof.organization_id,
    role: "driver",
    full_name: fullName,
    email,
    phone,
    is_active: true,
    priority,
    can_coordinate: canCoordinate,
  };
  let pErr: { message: string } | null = null;
  let usedPayload = fullPayload;
  ({ error: pErr } = await adminClient.from("profiles").insert(fullPayload));
  if (pErr) {
    // Fallback: sin can_coordinate (si 0013 no aplicada)
    const { can_coordinate, ...noCoord } = fullPayload;
    usedPayload = noCoord;
    ({ error: pErr } = await adminClient.from("profiles").insert(noCoord));
    if (pErr) {
      // Fallback: sin priority (si 0012 no aplicada)
      const { priority: _p, ...noPrio } = noCoord;
      usedPayload = noPrio;
      ({ error: pErr } = await adminClient.from("profiles").insert(noPrio));
    }
  }
  if (pErr) {
    // Rollback auth
    await adminClient.auth.admin.deleteUser(newUserId);
    return json({ error: `Error creando perfil: ${pErr.message}` }, 500);
  }

  // 5d) Insertar driver_profile.
  const { error: dErr } = await adminClient.from("driver_profiles").insert({
    profile_id: newUserId,
    license_number: licenseNumber,
    license_expires_at: licenseExpiresAt,
    eps_provider: epsProvider,
    eps_expires_at: epsExpiresAt,
    arl_provider: arlProvider,
    arl_expires_at: arlExpiresAt,
  });
  if (dErr) {
    await adminClient.from("profiles").delete().eq("id", newUserId);
    await adminClient.auth.admin.deleteUser(newUserId);
    return json({ error: `Error creando driver_profile: ${dErr.message}` }, 500);
  }

  return json({
    id: newUserId,
    email,
    full_name: fullName,
    priority: "priority" in usedPayload ? priority : 1,
    can_coordinate: "can_coordinate" in usedPayload ? canCoordinate : false,
    license_number: licenseNumber,
    license_expires_at: licenseExpiresAt,
    eps_provider: epsProvider,
    eps_expires_at: epsExpiresAt,
    arl_provider: arlProvider,
    arl_expires_at: arlExpiresAt,
  }, 201);
});
