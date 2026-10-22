// Siembra en la base LOCAL una organización aparte para MIRAR la pantalla de
// Cuentas de cobro con lo de 0115 (abrir varias, plazo desde hoy, comprobante del
// jefe), con los mismos casos que se vieron en producción el 22-oct-2026.
//
//   cd rendio-backend && eval "$(supabase status -o env | grep -E '^(API_URL|SERVICE_ROLE_KEY)=')" \
//     && node scripts/_seed-cobro-0115-local.mjs
//
// Aplica 0115 a la base local (solo funciones y una política: no cambia datos de
// nadie) y crea la org «Prueba cobro 0115» con su jefa y 10 tripulantes FICTICIOS.
// Se puede correr otra vez: borra la org de la corrida anterior y la vuelve a crear.
// Nunca apunta a dev ni a producción (_local-fixtures se niega).
//
// La jefa de prueba entra con JEFA_EMAIL / JEFA_CLAVE (solo existen en la base local).
import fs from 'node:fs';
import { localClient } from './_local-fixtures.mjs';

export const JEFA_EMAIL = 'jefa.cobro0115@prueba.local';
export const JEFA_CLAVE = 'Cobro0115-local!';
const API = process.env.API_URL || 'http://127.0.0.1:54321';
const SRK = process.env.SERVICE_ROLE_KEY;
if (!/^http:\/\/(127\.0\.0\.1|localhost):54321$/.test(API)) { console.error('ABORT: solo la base local'); process.exit(2); }
if (!SRK) { console.error('Falta SERVICE_ROLE_KEY (supabase status -o env)'); process.exit(2); }

const c = await localClient();
const q = async (s, p) => (await c.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];

// 1. 0115 en la base local (funciones + política; idempotente).
await c.query(fs.readFileSync(new URL('../supabase/migrations/0115_cobro_abrir_varias_y_comprobante_del_jefe.sql', import.meta.url), 'utf8'));
console.log('✓ 0115 aplicada a la base local');

// 2. La org de la corrida anterior, fuera (en cascada).
const vieja = await q(`SELECT id FROM public.organizations WHERE name = 'Prueba cobro 0115'`);
for (const o of vieja) {
  await q(`DELETE FROM auth.users WHERE id IN (SELECT id FROM public.profiles WHERE organization_id = $1)`, [o.id]);
  await q(`DELETE FROM public.organizations WHERE id = $1`, [o.id]);
}
await q(`DELETE FROM auth.users WHERE email = $1`, [JEFA_EMAIL]);

const org = (await one(`INSERT INTO public.organizations (name, slug) VALUES ('Prueba cobro 0115', 'prueba-cobro-0115-' || substr(md5(random()::text), 1, 6)) RETURNING id`)).id;
await q(`INSERT INTO public.airports (organization_id, iata_code, name, latitude, longitude) VALUES ($1, 'MDE', 'José María Córdova', 6.1645, -75.4231)`, [org]);
const olivar = (await one(`INSERT INTO public.residences (organization_id, name, latitude, longitude, sector) VALUES ($1, 'El Olivar', 6.1523, -75.3781, 'Rionegro') RETURNING id`, [org])).id;
const llano = (await one(`INSERT INTO public.residences (organization_id, name, latitude, longitude, sector) VALUES ($1, 'Quintas de Llanogrande', 6.1175, -75.4152, 'Llanogrande') RETURNING id`, [org])).id;
await q(`INSERT INTO public.billing_settings (organization_id, due_days, notice_days, grace_days, holder_name) VALUES ($1, 3, 1, 2, 'Rendio (prueba)')
         ON CONFLICT (organization_id) DO UPDATE SET due_days = 3, notice_days = 1, grace_days = 2`, [org]);
await q(`INSERT INTO public.billing_payment_methods (organization_id, kind, label, account_type, account_number) VALUES ($1, 'bank', 'Bancolombia', 'Ahorros', '000-000000-00')`, [org]);

// 3. La jefa (con clave, por la API de auth local) y su profile.
const r = await fetch(API + '/auth/v1/admin/users', {
  method: 'POST', headers: { apikey: SRK, Authorization: 'Bearer ' + SRK, 'content-type': 'application/json' },
  body: JSON.stringify({ email: JEFA_EMAIL, password: JEFA_CLAVE, email_confirm: true }),
});
const ju = await r.json();
if (!r.ok || !ju.id) { console.error('No se pudo crear la jefa:', JSON.stringify(ju)); process.exit(1); }
await q(`INSERT INTO public.profiles (id, organization_id, role, full_name, email) VALUES ($1, $2, 'admin', 'Jefa de prueba (cobro)', $3)
         ON CONFLICT (id) DO UPDATE SET organization_id = EXCLUDED.organization_id, role = 'admin', full_name = EXCLUDED.full_name, deleted_at = NULL`, [ju.id, org, JEFA_EMAIL]);
const jefa = ju.id;

// 4. Tripulantes ficticios.
async function trip(name, res) {
  const email = 'trip.' + name.toLowerCase().normalize('NFD').replace(/[^a-z]/g, '') + '@prueba.local';
  const u = (await one(`INSERT INTO auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $1, '{}', '{}', now(), now()) RETURNING id`, [email])).id;
  await q(`INSERT INTO public.profiles (id, organization_id, role, full_name, email) VALUES ($1, $2, 'auxiliar', $3, $4)
           ON CONFLICT (id) DO UPDATE SET organization_id = EXCLUDED.organization_id, role = 'auxiliar', full_name = EXCLUDED.full_name`, [u, org, name, email]);
  return (await one(`INSERT INTO public.auxiliar_profiles (profile_id, residence_id) VALUES ($1, $2) RETURNING id`, [u, res])).id;
}
const asJefa = async () => {
  await c.query(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: jefa, role: 'authenticated', user_role: 'admin' })]);
};
await asJefa();
await q(`SELECT public.admin_billing_save_sector_rate('Rionegro', 470000, 20000)`);
const cuenta = (aux, cut, starts) => q(`SELECT public.admin_billing_save_account($1, NULL, $2::smallint, NULL, NULL, NULL, true, NULL, $3::date)`, [aux, cut, starts]);
const hoy = (await one(`SELECT public.billing_today()::text d`)).d;
const mes = hoy.slice(0, 7);
const d = (n) => mes + '-' + String(n).padStart(2, '0');
const nextMes = (await one(`SELECT to_char(date_trunc('month', $1::date) + interval '1 month', 'YYYY-MM') m`, [hoy])).m;

// Corte 21 que el reloj no abrió (3), corte 1 «cobra desde el próximo mes» (3),
// una abierta tarde y pausada, una abierta para marcar pagada con comprobante,
// una sin valor y una sin cuenta.
for (const n of ['Valentina Arango', 'Mateo Cardona', 'Isabela Restrepo']) await cuenta(await trip(n, olivar), 21, d(21));
for (const n of ['Samuel Ochoa', 'Mariana Zapata', 'Tomás Giraldo']) await cuenta(await trip(n, olivar), 1, nextMes + '-01');
const pausada = await trip('Sara Henao', olivar);
await cuenta(pausada, 1, nextMes + '-01');
await q(`SELECT public.admin_billing_open_statement($1)`, [pausada]);          // como pasó en producción: queda pausada
const abierta = await trip('Daniela Montoya', olivar);
// Daniela también entra (para mirar en su app lo que deja «Marcar pagado» con comprobante).
const dani = (await one(`SELECT profile_id FROM public.auxiliar_profiles WHERE id = $1`, [abierta])).profile_id;
// (la API de auth no lee un usuario con estas columnas en NULL: «Database error loading user»)
await q(`UPDATE auth.users SET confirmation_token = '', recovery_token = '', email_change_token_new = '', email_change = '',
           phone_change = '', phone_change_token = '', email_change_token_current = '', reauthentication_token = '' WHERE id = $1`, [dani]);
await fetch(API + '/auth/v1/admin/users/' + dani, {
  method: 'PUT', headers: { apikey: SRK, Authorization: 'Bearer ' + SRK, 'content-type': 'application/json' },
  body: JSON.stringify({ password: JEFA_CLAVE, email_confirm: true }),
});
await cuenta(abierta, 21, d(21));
await q(`SELECT public.admin_billing_open_statement($1)`, [abierta]);
await cuenta(await trip('Juan Pablo Vélez', llano), 1, d(1));                  // Llanogrande sin tarifa: sin valor
await trip('Luisa Fernanda Ríos', olivar);                                     // sin cuenta
await c.query(`SELECT set_config('request.jwt.claims', '', false)`);

const st = await q(`SELECT pr.full_name, s.period_start::text ps, s.due_date::text due, s.blocked_at IS NOT NULL pausada
                      FROM public.billing_statements s JOIN public.auxiliar_profiles ap ON ap.id = s.auxiliar_profile_id
                      JOIN public.profiles pr ON pr.id = ap.profile_id WHERE s.organization_id = $1`, [org]);
console.log('✓ org «Prueba cobro 0115» con 10 tripulantes; cuentas de cobro abiertas:', st);
await c.end();
