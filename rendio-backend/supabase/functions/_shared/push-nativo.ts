// =============================================================================
// _shared/push-nativo.ts — avisos a la app de las tiendas (31-oct-2026)
//
// La app de Play Store / App Store (rendio-app/, Capacitor) no usa Web Push:
// guarda su token en push_subscriptions con un endpoint que empieza por
//   «fcm:<token>»  → Android, por Firebase Cloud Messaging (API HTTP v1)
//   «apns:<token>» → iPhone, directo a Apple (APNs, con la llave .p8)
// y p256dh/auth = 'native'. send-push y dispatch-notifications le pasan aquí
// esas filas; las de navegador siguen por web-push como siempre.
//
// Secrets (supabase secrets set ...). Si faltan, el aviso nativo no sale y se
// dice en el error; nada de lo web cambia:
//   FCM_SERVICE_ACCOUNT  JSON completo de la cuenta de servicio de Firebase
//                        (Configuración del proyecto → Cuentas de servicio).
//   APNS_KEY             contenido del archivo AuthKey_XXXX.p8 de Apple.
//   APNS_KEY_ID          el XXXX de ese archivo.
//   APNS_TEAM_ID         Team ID de la cuenta de Apple Developer.
//   APNS_TOPIC           el bundle id de la app (co.rendio.app).
// =============================================================================

// @ts-ignore — globals Deno.* en runtime Edge.
declare const Deno: { env: { get(k: string): string | undefined } };

export type AvisoNativo = { title: string; body: string; url: string };
export type Resultado = { ok: boolean; muerto: boolean; error?: string };

export const esNativo = (endpoint: string) => endpoint.startsWith("fcm:") || endpoint.startsWith("apns:");

export async function enviarNativo(endpoint: string, aviso: AvisoNativo): Promise<Resultado> {
  try {
    if (endpoint.startsWith("fcm:")) return await enviarFcm(endpoint.slice(4), aviso);
    if (endpoint.startsWith("apns:")) return await enviarApns(endpoint.slice(5), aviso);
    return { ok: false, muerto: false, error: "endpoint no nativo" };
  } catch (e) {
    return { ok: false, muerto: false, error: String((e as Error)?.message || e).slice(0, 200) };
  }
}

// ── utilidades JWT ───────────────────────────────────────────────────────────
const enc = new TextEncoder();
function b64url(bytes: Uint8Array | string): string {
  const b = typeof bytes === "string" ? enc.encode(bytes) : bytes;
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function pemADer(pem: string): ArrayBuffer {
  const limpio = pem.replace(/\\n/g, "\n").replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(limpio);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
async function firmarJwt(header: object, claims: object, key: CryptoKey, alg: AlgorithmIdentifier | EcdsaParams): Promise<string> {
  const datos = b64url(JSON.stringify(header)) + "." + b64url(JSON.stringify(claims));
  // ECDSA en WebCrypto devuelve r||s (64 bytes), que es justo lo que pide ES256.
  const firma = new Uint8Array(await crypto.subtle.sign(alg, key, enc.encode(datos)));
  return datos + "." + b64url(firma);
}

// ── Android: FCM HTTP v1 ─────────────────────────────────────────────────────
type CuentaServicio = { project_id: string; client_email: string; private_key: string };
let fcmCuenta: CuentaServicio | null = null;
let fcmToken: { valor: string; vence: number } | null = null;

function cuentaFcm(): CuentaServicio | null {
  if (fcmCuenta) return fcmCuenta;
  const raw = Deno.env.get("FCM_SERVICE_ACCOUNT");
  if (!raw) return null;
  const c = JSON.parse(raw);
  if (!c.project_id || !c.client_email || !c.private_key) throw new Error("FCM_SERVICE_ACCOUNT incompleto");
  fcmCuenta = c;
  return c;
}

async function accesoFcm(c: CuentaServicio): Promise<string> {
  const ahora = Math.floor(Date.now() / 1000);
  if (fcmToken && fcmToken.vence - 120 > ahora) return fcmToken.valor;
  const key = await crypto.subtle.importKey(
    "pkcs8", pemADer(c.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const jwt = await firmarJwt(
    { alg: "RS256", typ: "JWT" },
    {
      iss: c.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: ahora, exp: ahora + 3600,
    },
    key, { name: "RSASSA-PKCS1-v1_5" },
  );
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + jwt,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`FCM token ${r.status} ${j.error || ""}`.trim());
  fcmToken = { valor: j.access_token, vence: ahora + Number(j.expires_in || 3600) };
  return fcmToken.valor;
}

async function enviarFcm(token: string, a: AvisoNativo): Promise<Resultado> {
  const c = cuentaFcm();
  if (!c) return { ok: false, muerto: false, error: "falta FCM_SERVICE_ACCOUNT" };
  const acceso = await accesoFcm(c);
  const r = await fetch(`https://fcm.googleapis.com/v1/projects/${c.project_id}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${acceso}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        token,
        notification: { title: a.title, body: a.body },
        data: { url: a.url },
        android: {
          priority: "HIGH",
          // El canal lo crea native.js («Avisos de Rendio», importancia alta).
          notification: { channel_id: "rendio", sound: "default" },
        },
      },
    }),
  });
  if (r.ok) return { ok: true, muerto: false };
  const j = await r.json().catch(() => ({}));
  const estado = j?.error?.status || "";
  const detalle = JSON.stringify(j?.error?.details || []);
  // Token que Firebase ya no reconoce (app desinstalada, datos borrados…).
  const muerto = r.status === 404 || estado === "NOT_FOUND" || /UNREGISTERED/.test(detalle)
    || (estado === "INVALID_ARGUMENT" && /registration token/i.test(String(j?.error?.message || "")));
  return { ok: false, muerto, error: `FCM ${r.status} ${estado}`.trim() };
}

// ── iPhone: APNs con llave .p8 ───────────────────────────────────────────────
let apnsJwt: { valor: string; hecho: number } | null = null;

async function jwtApns(): Promise<string | null> {
  const p8 = Deno.env.get("APNS_KEY"), kid = Deno.env.get("APNS_KEY_ID"), team = Deno.env.get("APNS_TEAM_ID");
  if (!p8 || !kid || !team) return null;
  const ahora = Math.floor(Date.now() / 1000);
  // Apple pide renovarlo entre 20 y 60 min; se rehace a los 45.
  if (apnsJwt && ahora - apnsJwt.hecho < 45 * 60) return apnsJwt.valor;
  const key = await crypto.subtle.importKey("pkcs8", pemADer(p8), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const valor = await firmarJwt({ alg: "ES256", kid }, { iss: team, iat: ahora }, key, { name: "ECDSA", hash: "SHA-256" });
  apnsJwt = { valor, hecho: ahora };
  return valor;
}

async function postApns(host: string, token: string, jwt: string, topic: string, a: AvisoNativo) {
  const r = await fetch(`https://${host}/3/device/${token}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${jwt}`,
      "apns-topic": topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    },
    // url va suelta: la app la lee en notification.data.url.
    body: JSON.stringify({ aps: { alert: { title: a.title, body: a.body }, sound: "default" }, url: a.url }),
  });
  const j = r.ok ? {} : await r.json().catch(() => ({}));
  return { status: r.status, razon: String((j as { reason?: string }).reason || "") };
}

async function enviarApns(token: string, a: AvisoNativo): Promise<Resultado> {
  const topic = Deno.env.get("APNS_TOPIC") || "co.rendio.app";
  const jwt = await jwtApns();
  if (!jwt) return { ok: false, muerto: false, error: "faltan APNS_KEY / APNS_KEY_ID / APNS_TEAM_ID" };
  let r = await postApns("api.push.apple.com", token, jwt, topic, a);
  // Un iPhone con la app instalada desde Xcode tiene token de PRUEBAS (sandbox):
  // producción lo rechaza con BadDeviceToken. Se intenta allá antes de darlo por muerto.
  if (r.status === 400 && r.razon === "BadDeviceToken") {
    r = await postApns("api.sandbox.push.apple.com", token, jwt, topic, a);
  }
  if (r.status === 200) return { ok: true, muerto: false };
  const muerto = r.status === 410 || r.razon === "Unregistered" || r.razon === "BadDeviceToken";
  return { ok: false, muerto, error: `APNs ${r.status} ${r.razon}`.trim() };
}
