# CLAUDE.md — rendio-backend

> Supabase backend del MVP Rendio Enterprises. Migrations SQL versionadas, Edge Functions en Deno, seeds y scripts. Lee primero el `CLAUDE.md` raíz del proyecto.

---

## Propósito del repo

Contiene todo lo que vive del lado del servidor:

- **`supabase/migrations/`** — schema SQL versionado, secuencial, idempotente.
- **`supabase/functions/`** — Edge Functions Deno (`compute_route`, `geocode_address`, `invite_user`, etc.).
- **`supabase/seed.sql`** — datos demo para desarrollo (no para producción).
- **`scripts/`** — utilidades locales (`reset_dev.sh`, `generate_types.sh`, `apply_migrations.sh`).
- **`tests/`** — pruebas SQL con `pg_prove` para políticas RLS críticas.
- **`docs/`** — diagramas ERD (Mermaid + DBML), notas de arquitectura específicas del backend.

---

## Stack y versiones

| Pieza | Versión / Notas |
|---|---|
| PostgreSQL | 15 (managed por Supabase) |
| Supabase CLI | latest (npm `-g supabase` o `brew install supabase/tap/supabase`) |
| Deno | 1.40+ (Edge Functions) |
| pg_prove | para tests RLS (`brew install perl-pgtap` + `cpan TAP::Parser::SourceHandler::pgTAP`) |
| sqlfluff | linting SQL (`pip install sqlfluff`) |

---

## Comandos

> Antes de correr cualquier comando que toque Supabase, exporta variables del `.env.local.dev` raíz del proyecto:
> ```bash
> set -a; source ../.env.local.dev; set +a
> ```

### Setup inicial (una sola vez)

```bash
supabase login                       # usa SUPABASE_ACCESS_TOKEN
supabase link --project-ref $SUPABASE_PROJECT_REF
```

### Desarrollo local

```bash
supabase start                       # levanta Postgres + Auth + Storage local
supabase status                      # ver puertos y URLs locales
supabase stop                        # apaga el stack local
```

El stack local corre en Docker: PostgreSQL en `localhost:54322`, Studio en `localhost:54323`, API en `localhost:54321`.

### Migrations

```bash
# Crear nueva migration vacía (genera NNNN_descripcion.sql)
supabase migration new <descripcion>

# Aplicar migrations al proyecto LINKEADO (rendio-dev)
supabase db push

# Aplicar al stack local (reset desde cero)
supabase db reset

# Ver diff entre local y remoto
supabase db diff --schema public
```

### Edge Functions

```bash
# Crear función nueva
supabase functions new <name>

# Ejecutar local (con .env)
supabase functions serve <name> --env-file ./supabase/functions/.env

# Deploy
supabase functions deploy <name> --project-ref $SUPABASE_PROJECT_REF

# Logs en producción
supabase functions logs <name>
```

### Generación de tipos

```bash
# Tipos TypeScript para rendio-admin-web
supabase gen types typescript --linked > ../rendio-admin-web/src/types/supabase.ts

# Tipos Dart para rendio-mobile (vía supabase_codegen externo, pendiente de configurar)
```

### Tests RLS

```bash
# Asume stack local corriendo
psql "$SUPABASE_DB_URL_LOCAL" -f tests/rls_auxiliar_isolation.sql
pg_prove -h localhost -p 54322 -U postgres -d postgres tests/*.sql
```

### Seed local

```bash
psql "$SUPABASE_DB_URL_LOCAL" -f supabase/seed.sql
```

---

## Convenciones SQL

- **Naming:** tablas en plural `snake_case` inglés (`reservations`, `route_assignments`). Columnas `snake_case`. Tipos enum en `snake_case`.
- **Migrations:** archivo `NNNN_descripcion.sql` numerado secuencial (`0001_initial_schema.sql`). Idempotentes: `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`. **Los archivos `.down.sql` viven en `rendio-backend/down_migrations/`, NO en `supabase/migrations/`** — Supabase CLI procesa cualquier `.sql` que encuentre en `supabase/migrations/` y trataría el `.down` como una migration más. La carpeta `down_migrations/` espeja el nombre de la migration up (mismo prefijo NNNN).
- **Toda tabla nueva requiere:**
  - `id uuid PK DEFAULT gen_random_uuid()`
  - `created_at timestamptz NOT NULL DEFAULT now()`
  - `updated_at timestamptz NOT NULL DEFAULT now()` con trigger `tr_set_updated_at`
  - RLS activado: `ALTER TABLE … ENABLE ROW LEVEL SECURITY;` ANTES de cualquier policy.
  - Soft delete cuando aplique: `deleted_at timestamptz NULL` + vista que filtre.
- **Funciones:** preferir `language sql` cuando sea posible. Solo usar `plpgsql` si hay control de flujo.
- **`SECURITY DEFINER` solo en funciones documentadas en Arquitectura §7.3** (`mark_passenger_on_board`, `recompute_route`, `confirm_disembarkation`, etc.) y siempre con validación explícita del actor (`auth.uid()`, `auth.user_role()`).
- **RLS prohibida deshabilitar** en cualquier tabla productiva. Acceso elevado vía función `SECURITY DEFINER`.
- **Helpers JWT:** usar `auth.user_role()`, `auth.user_org()`, `auth.auxiliar_id()`, `auth.driver_id()` (definidos en `0004_rls_policies.sql`). No re-leer `profiles` en cada policy.

## Edge Functions (Deno) — convenciones

- TypeScript estricto. `deno.json` con `compilerOptions.strict = true`.
- Imports vía `https://deno.land/x/...` o `npm:` specifier. Versionar siempre.
- Cliente Supabase con `createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)` solo cuando se requiere bypass RLS (documentar la razón en comentario al inicio de la función).
- Validar JWT del caller antes de ejecutar lógica privilegiada (`auth.getUser(jwt)`).
- Logs estructurados con `console.log(JSON.stringify({ level, msg, ctx }))` — NUNCA `console.log` libre.

---

## Reglas inviolables específicas del backend

(Las generales viven en `CLAUDE.md` raíz §8.)

1. **NO** desactivar RLS de tablas productivas, ni siquiera "temporalmente" para debugging.
2. **NO** usar `service_role` desde clientes (web/móvil). Solo Edge Functions y scripts.
3. **NO** commitear `supabase/.env`, `.env.local.*`, ni dumps que contengan datos reales (`pg_dump`).
4. **NO** correr `supabase db reset` contra el proyecto remoto. Solo contra el stack local. (En remoto, `supabase db push` es aditivo.)
5. **NO** modificar migrations ya aplicadas a `rendio-dev`. Si hay error, crear una nueva migration que corrija.
6. **NO** introducir extensiones Postgres pesadas sin validar disponibilidad en Supabase managed.

---

## Mapeo con Arquitectura

| Sección Arquitectura | Cubierto por |
|---|---|
| §5.3 Enums | `migrations/0001_initial_schema.sql` (E1.04) |
| §5.4 Tablas core (org/airport/profiles) | `0001_initial_schema.sql` (E1.04) |
| §5.4 Tablas de rol (auxiliar/driver/vehicles) | `0002_role_profiles.sql` (E1.05) |
| §5.4 Operativas (flights/reservations/route_*) | `0003_operations.sql` (E1.06) |
| §7 RLS policies + helpers | `0004_rls_policies.sql` (E1.07) |
| §7.3 Funciones SECURITY DEFINER + audit | `0005_security_definer_audit.sql` (E1.08) |
| §9 Storage bucket `inspections` | `0006_storage_inspections.sql` o vía Dashboard (E1.09) |
| §6.3 Custom claims (role en JWT) | `0007_auth_hook_custom_claims.sql` + Dashboard config (E1.02) |

---

## Próxima tarea cuando se cree este repo

Tras completar E1.10 (crear repo en GitHub) y E1.04 (Migration 0001):

1. `supabase init` desde la raíz de este repo.
2. Verificar `supabase/config.toml` apunta al proyecto correcto.
3. Crear `supabase/migrations/0001_initial_schema.sql` con enums + tablas core (ver Arquitectura §5.3-5.4).
4. `supabase db push` contra `rendio-dev` y verificar en Studio.
